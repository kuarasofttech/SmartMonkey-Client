/**
 * The embedded-driver agent loop + its sandboxed tools (smartmonkey-cli/embed.mjs).
 * No API call — the model is a scripted mock, so the loop and the guardrails are
 * verified without spending a key.
 *
 *   node test/smartmonkey-cli-embed.mjs
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { makeToolRunner, runAgent, toOpenAI, fromOpenAI, toGemini, fromGemini, resolveProvider, PROVIDERS } = await import('../embed.mjs');

let failures = 0;
async function check(name, fn) { try { await fn(); console.log(`  ok  ${name}`); } catch (e) { failures++; console.error(`FAIL  ${name}: ${e.message}`); } }

const dir = mkdtempSync(join(tmpdir(), 'sm-embed-'));
writeFileSync(join(dir, 'README.md'), 'hello world app\nsecond line');
mkdirSync(join(dir, 'src'), { recursive: true });
writeFileSync(join(dir, 'src', 'Login.kt'), 'fun login() { deepLink("app://home") }');
const fakeAsk = async (_q, opts) => (opts ? opts[0] : 'typed answer');
const runTool = makeToolRunner(dir, fakeAsk);

await check('read_file / list_dir / search / ask_user work', async () => {
  assert.match(await runTool('read_file', { path: 'README.md' }), /hello world/);
  assert.match(await runTool('list_dir', { path: '.' }), /README\.md/);
  assert.match(await runTool('search', { query: 'deepLink' }), /Login\.kt:1:.*deepLink/);
  assert.equal(await runTool('ask_user', { question: 'which?', options: ['A', 'B'] }), 'A');   // menu → first option
  assert.equal(await runTool('ask_user', { question: 'free?' }), 'typed answer');
});

await check('sandbox: read escaping the repo, and any write outside smartmonkey/*.json, are refused', async () => {
  await assert.rejects(runTool('read_file', { path: '../../etc/hosts' }), /escapes the repo/);
  await assert.rejects(runTool('write_file', { path: 'src/evil.kt', contents: 'x' }), /only smartmonkey/);
  await assert.rejects(runTool('write_file', { path: 'smartmonkey/notes.txt', contents: 'x' }), /only smartmonkey/);
  await assert.rejects(runTool('git', { args: ['push', 'origin'] }), /not allowed/);   // read-only subset
});

await check('the loop runs tools, feeds results back, writes profile.json, and stops', async () => {
  let turn = 0; const fedBack = [];
  const callModel = async (messages) => {
    const last = messages[messages.length - 1];
    if (last.role === 'user' && Array.isArray(last.content)) fedBack.push(last.content.map(c => c.content).join(' | '));
    turn++;
    if (turn === 1) return { content: [{ type: 'text', text: 'reading' }, { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'README.md' } }], stop_reason: 'tool_use' };
    if (turn === 2) return { content: [{ type: 'tool_use', id: 't2', name: 'write_file', input: { path: 'smartmonkey/profile.json', contents: JSON.stringify({ smartmonkeyProfile: 1, project: { name: 'x' } }) } }], stop_reason: 'tool_use' };
    return { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' };
  };
  const res = await runAgent({ prompt: 'profile this repo', callModel, runTool, maxTurns: 10 });
  assert.equal(res.done, true);
  assert.equal(res.turns, 3);
  assert.ok(existsSync(join(dir, 'smartmonkey', 'profile.json')), 'profile.json was written');
  assert.match(readFileSync(join(dir, 'smartmonkey', 'profile.json'), 'utf8'), /smartmonkeyProfile/);
  assert.ok(fedBack.some(s => /hello world/.test(s)), 'the read_file result was fed back to the model');
});

await check('a tool error becomes a tool_result, never crashes the loop', async () => {
  let turn = 0; let sawError = false;
  const callModel = async (messages) => {
    const last = messages[messages.length - 1];
    if (last.role === 'user' && Array.isArray(last.content) && /ERROR/.test(last.content[0].content)) sawError = true;
    turn++;
    if (turn === 1) return { content: [{ type: 'tool_use', id: 'e1', name: 'read_file', input: { path: 'does-not-exist' } }], stop_reason: 'tool_use' };
    return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' };
  };
  const res = await runAgent({ prompt: 'x', callModel, runTool, maxTurns: 5 });
  assert.equal(res.done, true);
  assert.ok(sawError, 'the read error came back as a tool_result, not a crash');
});

// ── other providers: the pure wire translators ───────────────────────────────
// A representative loop history: initial prompt → assistant tool_use → tool_result.
const TOOLS = [{ name: 'read_file', description: 'read', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];
const history = [
  { role: 'user', content: 'profile this repo' },
  { role: 'assistant', content: [{ type: 'text', text: 'reading' }, { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'README.md' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'hello world' }] },
];

await check('toOpenAI maps system+prompt, assistant tool_use → tool_calls, tool_result → role:tool with matching id', () => {
  const { messages, tools } = toOpenAI('SYS', history, TOOLS);
  assert.deepEqual(messages[0], { role: 'system', content: 'SYS' });
  assert.deepEqual(messages[1], { role: 'user', content: 'profile this repo' });
  const asst = messages.find(m => m.role === 'assistant');
  assert.equal(asst.tool_calls[0].id, 'call_1');
  assert.equal(asst.tool_calls[0].function.name, 'read_file');
  assert.deepEqual(JSON.parse(asst.tool_calls[0].function.arguments), { path: 'README.md' });
  const toolMsg = messages.find(m => m.role === 'tool');
  assert.equal(toolMsg.tool_call_id, 'call_1');           // pairs back to the assistant call
  assert.match(toolMsg.content, /hello world/);
  assert.equal(tools[0].type, 'function');
  assert.equal(tools[0].function.name, 'read_file');
});

await check('fromOpenAI: tool_calls → tool_use (stop tool_use); text-only → end_turn; bad JSON args tolerated', () => {
  const tu = fromOpenAI({ choices: [{ message: { content: 'ok', tool_calls: [{ id: 'x9', function: { name: 'read_file', arguments: '{"path":"a"}' } }] } }] });
  assert.equal(tu.stop_reason, 'tool_use');
  assert.deepEqual(tu.content.find(b => b.type === 'tool_use'), { type: 'tool_use', id: 'x9', name: 'read_file', input: { path: 'a' } });
  assert.equal(fromOpenAI({ choices: [{ message: { content: 'done' } }] }).stop_reason, 'end_turn');
  assert.deepEqual(fromOpenAI({ choices: [{ message: { tool_calls: [{ id: 'z', function: { name: 't', arguments: 'not json' } }] } }] }).content[0].input, {});
});

await check('toGemini: system_instruction + role user/model, functionCall part, functionResponse carries the name from the id map', () => {
  const g = toGemini('SYS', history, TOOLS);
  assert.equal(g.system_instruction.parts[0].text, 'SYS');
  assert.deepEqual(g.contents[0], { role: 'user', parts: [{ text: 'profile this repo' }] });
  const model = g.contents.find(c => c.role === 'model');
  const fc = model.parts.find(p => p.functionCall).functionCall;
  assert.equal(fc.name, 'read_file');
  assert.deepEqual(fc.args, { path: 'README.md' });
  assert.equal(fc.id, 'call_1');                          // a real (non-synthetic) id IS echoed
  const fr = g.contents.at(-1).parts[0].functionResponse;
  assert.equal(fr.name, 'read_file');                     // resolved from tool_use_id → name
  assert.match(fr.response.result, /hello world/);
  assert.equal(g.tools[0].functionDeclarations[0].name, 'read_file');
  // a MINTED (sm_gem_) id is dropped from both functionCall and functionResponse
  const synth = [{ role: 'assistant', content: [{ type: 'tool_use', id: 'sm_gem_0', name: 'read_file', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'sm_gem_0', content: 'r' }] }];
  const gs = toGemini('S', synth, TOOLS);
  assert.equal(gs.contents[0].parts[0].functionCall.id, undefined);
  assert.equal(gs.contents[1].parts[0].functionResponse.id, undefined);
});

await check('fromGemini: functionCall → tool_use (mints an id when absent, echoes a real one); text → end_turn', () => {
  const minted = fromGemini({ candidates: [{ content: { parts: [{ functionCall: { name: 'read_file', args: { path: 'a' } } }] } }] });
  assert.equal(minted.stop_reason, 'tool_use');
  assert.equal(minted.content[0].name, 'read_file');
  assert.match(minted.content[0].id, /^sm_gem_/);         // synthetic — kept out of functionResponse
  const real = fromGemini({ candidates: [{ content: { parts: [{ functionCall: { id: 'fc-real', name: 'read_file', args: {} } }] } }] });
  assert.equal(real.content[0].id, 'fc-real');
  assert.equal(fromGemini({ candidates: [{ content: { parts: [{ text: 'done' }] } }] }).stop_reason, 'end_turn');
});

await check('gemini round-trip: a real functionCall id survives back into the functionResponse (3.x strict matching)', () => {
  const resp = fromGemini({ candidates: [{ content: { parts: [{ functionCall: { id: 'fc-7', name: 'read_file', args: { path: 'a' } } }] } }] });
  const msgs = [{ role: 'user', content: 'x' }, { role: 'assistant', content: resp.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fc-7', content: 'r' }] }];
  const fr = toGemini('S', msgs, TOOLS).contents.at(-1).parts[0].functionResponse;
  assert.equal(fr.id, 'fc-7');
  assert.equal(fr.name, 'read_file');
});

await check('resolveProvider: explicit provider+env, key-shape inference, env-order fallback, and clean errors', () => {
  assert.deepEqual(resolveProvider({ provider: 'openai', key: 'sk-x' }), { provider: 'openai', key: 'sk-x', model: PROVIDERS.openai.defaultModel });
  assert.equal(resolveProvider({ key: 'sk-ant-abc' }).provider, 'anthropic');   // prefix wins even over generic sk-
  assert.equal(resolveProvider({ key: 'sk-proj-xyz' }).provider, 'openai');
  assert.equal(resolveProvider({ key: 'AIzaSyABC' }).provider, 'gemini');
  assert.equal(resolveProvider({ provider: 'gemini', env: { GOOGLE_API_KEY: 'g' } }).key, 'g');   // secondary env name
  assert.equal(resolveProvider({ env: { OPENAI_API_KEY: 'o' } }).provider, 'openai');             // env fallback
  assert.ok(resolveProvider({ provider: 'openai', env: {} }).error);            // provider named, no key
  assert.ok(resolveProvider({ provider: 'bogus', key: 'k' }).error);            // unknown provider
  assert.ok(resolveProvider({ env: {} }).error);                                // nothing at all
});

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nsmartmonkey-cli-embed: all passed');
