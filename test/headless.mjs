/**
 * Headless CLI runs: claude -p with stream-json, confined permissions, the prompt
 * on stdin, progress parsed into app events, completion from the exit. No real
 * process is started — spawn is faked.
 *   node test/headless.mjs
 */
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
const { headlessCommand, parseClaudeLine, makeHeadlessRunCli } = await import('../headless.mjs');

let failures = 0;
async function check(name, fn) { try { await fn(); console.log(`  ok  ${name}`); } catch (e) { failures++; console.error(`FAIL  ${name}: ${e.message}`); } }

await check('claude runs print-mode, streams JSON, and may only write under smartmonkey/', () => {
  const c = headlessCommand({ id: 'claude', bin: 'claude' });
  assert.ok(c.args.includes('-p'));
  assert.equal(c.args[c.args.indexOf('--output-format') + 1], 'stream-json');
  assert.equal(c.args[c.args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.ok(c.args.includes('Edit(smartmonkey/**)'));
  assert.ok(!c.args.some(a => /^Write\(|^Bash\((?!git )/.test(a)), 'no broad write/shell grants');
});

await check('drivers without a verified headless recipe return null (→ terminal fallback)', () => {
  for (const id of ['codex', 'cursor', 'gemini']) assert.equal(headlessCommand({ id, bin: id }), null);
});

await check('parseClaudeLine: text, tool use (path made relative), result, denial, junk', () => {
  const cwd = '/repo';
  const asst = JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'text', text: 'Reading the docs' },
    { type: 'tool_use', name: 'Read', input: { file_path: '/repo/docs/qa.md' } },
    { type: 'tool_use', name: 'Grep', input: { pattern: 'deeplink' } },
  ] } });
  assert.deepEqual(parseClaudeLine(asst, cwd), [
    { type: 'text', data: 'Reading the docs' },
    { type: 'tool', data: { name: 'Read', summary: 'docs/qa.md' } },
    { type: 'tool', data: { name: 'Grep', summary: 'deeplink' } },
  ]);
  assert.deepEqual(parseClaudeLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }), cwd),
    [{ type: 'result', data: { ok: true, message: 'done' } }]);
  assert.deepEqual(parseClaudeLine(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true }), cwd),
    [{ type: 'result', data: { ok: false, message: 'error_max_turns' } }]);
  assert.deepEqual(parseClaudeLine(JSON.stringify({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash' }), cwd),
    [{ type: 'tool', data: { name: 'Bash', summary: '(not allowed)' } }]);
  assert.deepEqual(parseClaudeLine('not json', cwd), []);
});

function fakeSpawn() {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = { written: '', end(s) { this.written += s; } };
    child.killed = false; child.kill = () => { child.killed = true; };
    calls.push({ cmd, args, opts, child });
    return child;
  };
  return { spawn, calls };
}
const line = o => JSON.stringify(o) + '\n';

await check('a run writes the prompt to stdin, streams events (even split across chunks), and finishes on exit 0', () => {
  const f = fakeSpawn(); const events = []; let done = false, err = null;
  const run = makeHeadlessRunCli({ spawn: f.spawn });
  const h = run({ driver: { id: 'claude', bin: 'claude' }, prompt: 'THE PROMPT', cwd: '/repo',
    onEvent: (t, d) => events.push([t, d]), onDone: () => done = true, onError: e => err = e });
  assert.equal(h.headless, true);
  const { cmd, args, opts, child } = f.calls[0];
  assert.equal(cmd, 'claude'); assert.equal(opts.cwd, '/repo');
  assert.ok(!args.includes('THE PROMPT'), 'prompt is not on the command line');
  assert.equal(child.stdin.written, 'THE PROMPT');
  const s = line({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });
  child.stdout.emit('data', Buffer.from(s.slice(0, 10))); child.stdout.emit('data', Buffer.from(s.slice(10)));
  child.stdout.emit('data', Buffer.from(line({ type: 'result', subtype: 'success', is_error: false, result: 'ok' })));
  child.emit('close', 0);
  assert.deepEqual(events, [['text', 'hi']]);
  assert.equal(done, true); assert.equal(err, null);
});

await check('a failing run reports the result error or the last stderr line', () => {
  const f = fakeSpawn(); let err = null;
  makeHeadlessRunCli({ spawn: f.spawn })({ driver: { id: 'claude', bin: 'claude' }, prompt: 'P', cwd: '/repo',
    onEvent: () => {}, onDone: () => {}, onError: e => err = e });
  const { child } = f.calls[0];
  child.stderr.emit('data', Buffer.from('warming up\nError: not logged in\n'));
  child.emit('close', 1);
  assert.ok(err && /not logged in/.test(err.message), err && err.message);
});

await check('exit 0 but an error result still counts as an error', () => {
  const f = fakeSpawn(); let err = null, done = false;
  makeHeadlessRunCli({ spawn: f.spawn })({ driver: { id: 'claude', bin: 'claude' }, prompt: 'P', cwd: '/repo',
    onEvent: () => {}, onDone: () => done = true, onError: e => err = e });
  const { child } = f.calls[0];
  child.stdout.emit('data', Buffer.from(line({ type: 'result', subtype: 'error_max_turns', is_error: true })));
  child.emit('close', 0);
  assert.equal(done, false); assert.ok(err && /error_max_turns/.test(err.message));
});

await check('cancel kills the process and suppresses callbacks', () => {
  const f = fakeSpawn(); let fired = false;
  const h = makeHeadlessRunCli({ spawn: f.spawn })({ driver: { id: 'claude', bin: 'claude' }, prompt: 'P', cwd: '/repo',
    onEvent: () => {}, onDone: () => fired = true, onError: () => fired = true });
  h.cancel();
  f.calls[0].child.emit('close', null);
  assert.equal(f.calls[0].child.killed, true); assert.equal(fired, false);
});

await check('an unsupported driver throws UNSUPPORTED so the caller can fall back', () => {
  const f = fakeSpawn();
  assert.throws(() => makeHeadlessRunCli({ spawn: f.spawn })({ driver: { id: 'codex', bin: 'codex' }, prompt: 'P', cwd: '/r',
    onEvent: () => {}, onDone: () => {}, onError: () => {} }), e => e.code === 'UNSUPPORTED');
  assert.equal(f.calls.length, 0);
});

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nheadless: all passed');
