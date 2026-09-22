/**
 * The ask_user MCP bridge: JSON-RPC handling and the long-poll client. No real
 * Claude Code involved (that was proven by hand); fetch is faked.
 *   node test/ask-mcp.mjs
 */
import { strict as assert } from 'node:assert';
const { handleMessage, httpAsk, ASK_TOOL } = await import('../ask-mcp.mjs');

let failures = 0;
async function check(name, fn) { try { await fn(); console.log(`  ok  ${name}`); } catch (e) { failures++; console.error(`FAIL  ${name}: ${e.message}`); } }

await check('initialize echoes the protocol version and offers tools', async () => {
  const r = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, null);
  assert.equal(r.id, 1); assert.equal(r.result.protocolVersion, '2025-06-18'); assert.ok(r.result.capabilities.tools);
});
await check('notifications get no reply; unknown methods get -32601', async () => {
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, null), null);
  assert.equal((await handleMessage({ jsonrpc: '2.0', id: 2, method: 'resources/list' }, null)).error.code, -32601);
});
await check('tools/list offers exactly ask_user', async () => {
  const r = await handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, null);
  assert.deepEqual(r.result.tools.map(t => t.name), ['ask_user']);
  assert.deepEqual(ASK_TOOL.inputSchema.required, ['question']);
});
await check('tools/call asks and returns the answer as text', async () => {
  let got = null;
  const r = await handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ask_user', arguments: { question: 'Which flavour?', options: ['dev', 'prod'], multi: false } } },
    async q => { got = q; return 'dev'; });
  assert.deepEqual(got, { question: 'Which flavour?', options: ['dev', 'prod'], multi: false });
  assert.equal(r.result.content[0].text, 'dev');
});
await check('a skipped question tells the agent to use the default, not wait', async () => {
  const r = await handleMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'ask_user', arguments: { question: 'x' } } }, async () => '');
  assert.match(r.result.content[0].text, /skipped/);
});
await check('if the app is unreachable the tool errors softly (the build continues)', async () => {
  const r = await handleMessage({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'ask_user', arguments: { question: 'x' } } }, async () => { throw new Error('ECONNREFUSED'); });
  assert.equal(r.result.isError, true); assert.match(r.result.content[0].text, /openQuestions/);
});

await check('httpAsk: POST gets an id, then polls until an answer arrives (with the token)', async () => {
  const seen = [];
  let polls = 0;
  const fetchImpl = async (u, o) => {
    seen.push([o.method, u, o.headers['x-smartmonkey-token']]);
    const body = o.method === 'POST' ? { id: 'aa_1' } : (++polls < 3 ? { pending: true } : { answer: 'blue' });
    return { ok: true, json: async () => body };
  };
  const ans = await httpAsk('http://x/api/agent-ask', 'tok', { fetchImpl, sleep: async () => {} })({ question: 'q', options: [], multi: false });
  assert.equal(ans, 'blue');
  assert.deepEqual(seen[0], ['POST', 'http://x/api/agent-ask', 'tok']);
  assert.equal(seen[1][1], 'http://x/api/agent-ask/aa_1');
  assert.equal(polls, 3);
});
await check('httpAsk: gives up after repeated failures instead of hanging', async () => {
  let n = 0;
  const fetchImpl = async (u, o) => { if (o.method === 'POST') return { ok: true, json: async () => ({ id: 'aa_1' }) }; n++; throw new Error('ECONNREFUSED'); };
  await assert.rejects(httpAsk('http://x/a', 't', { fetchImpl, sleep: async () => {} })({ question: 'q' }), /ECONNREFUSED/);
  assert.equal(n, 5);
});

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nask-mcp: all passed');
