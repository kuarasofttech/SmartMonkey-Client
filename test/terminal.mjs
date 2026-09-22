/**
 * Pop-a-terminal for CLI mode: platform launcher selection, the wrapper script,
 * and the sentinel-poll completion — all with injected effects, no real windows.
 *   node test/terminal.mjs
 */
import { strict as assert } from 'node:assert';
const { terminalCommand, runScript, makePopTerminalRunCli } = await import('../terminal.mjs');

let failures = 0;
function check(name, fn) { try { fn(); console.log(`  ok  ${name}`); } catch (e) { failures++; console.error(`FAIL  ${name}: ${e.message}`); } }

check('terminalCommand: darwin opens Terminal', () => {
  assert.deepEqual(terminalCommand('darwin', '/tmp/run.sh'), { cmd: 'open', args: ['-a', 'Terminal', '/tmp/run.sh'] });
});
check('terminalCommand: linux picks the first available emulator, gnome uses --', () => {
  const has = b => b === 'gnome-terminal';
  assert.deepEqual(terminalCommand('linux', '/tmp/run.sh', has), { cmd: 'gnome-terminal', args: ['--', '/tmp/run.sh'] });
  const hasX = b => b === 'xterm';
  assert.deepEqual(terminalCommand('linux', '/tmp/run.sh', hasX), { cmd: 'xterm', args: ['-e', '/tmp/run.sh'] });
});
check('terminalCommand: linux with no emulator, and win32, are null (→ fallback)', () => {
  assert.equal(terminalCommand('linux', '/tmp/run.sh', () => false), null);
  assert.equal(terminalCommand('win32', '/tmp/run.sh', () => true), null);
});
check('runScript cds, runs the driver with the prompt file, and records the exit code', () => {
  const s = runScript({ cwd: '/my/proj', bin: 'claude', promptPath: '/tmp/p', donePath: '/tmp/done' });
  assert.match(s, /^#!\/bin\/bash/);
  assert.match(s, /cd '\/my\/proj'/);
  assert.match(s, /'claude' "\$\(cat '\/tmp\/p'\)"/);
  assert.match(s, /printf '%s' "\$code" > '\/tmp\/done'/);
});
check('runScript single-quote-escapes a nasty cwd', () => {
  const s = runScript({ cwd: "/x/it's here", bin: 'claude', promptPath: '/tmp/p', donePath: '/tmp/done' });
  assert.match(s, /cd '\/x\/it'\\''s here'/);
});

// --- the runCli itself, fully injected ------------------------------------------
function harness(overrides = {}) {
  const calls = { spawned: [], wrote: [], cleaned: [] };
  let tick = null;
  const base = {
    platform: 'darwin', has: () => true,
    spawn: (cmd, args) => { calls.spawned.push([cmd, args]); return { unref() {}, on() {} }; },
    mkdtemp: () => '/tmp/sm-cli-x',
    writeFile: (p, d) => calls.wrote.push(p),
    chmod: () => {},
    fileExists: () => calls.done === true,
    readFile: () => calls.code ?? '0',
    cleanup: p => calls.cleaned.push(p),
    setTimer: fn => { tick = fn; return 'T'; },
    clearTimer: () => { calls.cleared = true; },
  };
  const run = makePopTerminalRunCli({ ...base, ...overrides });
  return { run, calls, fire: () => tick && tick() };
}

check('launches a terminal and, when the sentinel says 0, reports done', () => {
  const h = harness();
  let done = false, err = null;
  const handle = h.run({ driver: { bin: 'claude' }, prompt: 'PROMPT', cwd: '/proj', onDone: () => done = true, onError: e => err = e });
  assert.equal(handle.launched, true);
  assert.equal(h.calls.spawned[0][0], 'open');
  h.calls.done = false; h.fire(); assert.equal(done, false, 'no sentinel yet → still waiting');
  h.calls.done = true; h.calls.code = '0'; h.fire();
  assert.equal(done, true); assert.equal(err, null);
  assert.ok(h.calls.cleaned.includes('/tmp/sm-cli-x'), 'temp dir cleaned');
});
check('a non-zero exit code reports an error', () => {
  const h = harness();
  let err = null;
  h.run({ driver: { bin: 'claude' }, prompt: 'P', cwd: '/proj', onDone: () => {}, onError: e => err = e });
  h.calls.done = true; h.calls.code = '3'; h.fire();
  assert.ok(err && /code 3/.test(err.message));
});
check('no terminal launcher → throws UNSUPPORTED (caller falls back)', () => {
  const h = harness({ platform: 'win32' });
  assert.throws(() => h.run({ driver: { bin: 'claude' }, prompt: 'P', cwd: '/proj', onDone: () => {}, onError: () => {} }), e => e.code === 'UNSUPPORTED');
});
check('cancel stops the poll and does not fire done', () => {
  const h = harness();
  let done = false;
  const handle = h.run({ driver: { bin: 'claude' }, prompt: 'P', cwd: '/proj', onDone: () => done = true, onError: () => {} });
  handle.cancel();
  h.calls.done = true; h.fire();
  assert.equal(done, false, 'cancelled → done never fires');
  assert.equal(h.calls.cleared, true);
});

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nterminal: all passed');
