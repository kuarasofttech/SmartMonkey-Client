/**
 * The ask_user MCP bridge: JSON-RPC handling and the long-poll client. No real
 * Claude Code involved (that was proven by hand); fetch is faked.
 *   node test/ask-mcp.mjs
 */
import { strict as assert } from 'node:assert';
const { handleMessage, httpAsk, ASK_TOOL, CONNECT_TOOL } = await import('../ask-mcp.mjs');

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
await check('tools/list offers ask_user (options required), request_connections, and the read-only connector tools', async () => {
  const r = await handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, null);
  const names = r.result.tools.map(t => t.name);
  assert.deepEqual(names.slice(0, 2), ['ask_user', 'request_connections']);
  assert.ok(names.includes('linear_search_issues') && names.includes('linear_get_issue'));
  assert.ok(!names.some(n => /create|update|delete/.test(n)), 'nothing that writes');
  assert.deepEqual(ASK_TOOL.inputSchema.required, ['question', 'options']);
  assert.equal(ASK_TOOL.inputSchema.properties.options.minItems, 2);
  assert.deepEqual(CONNECT_TOOL.inputSchema.required, ['services']);
});
await check('ask_user without options bounces back so the agent retries with choices', async () => {
  let asked = false;
  const r = await handleMessage({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'ask_user', arguments: { question: 'Which build?' } } }, async () => { asked = true; return 'x'; });
  assert.equal(asked, false, 'never reaches the owner');
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /options/);
});
await check('request_connections forwards the tools and returns the outcome', async () => {
  let got = null;
  const r = await handleMessage({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'request_connections', arguments: { services: ['Jira', 'Figma'] } } },
    async q => { got = q; return 'Connected: Jira. Skipped: Figma.'; });
  assert.deepEqual(got, { kind: 'connections', services: ['Jira', 'Figma'] });
  assert.equal(r.result.content[0].text, 'Connected: Jira. Skipped: Figma.');
});
await check('tools/call asks and returns the answer as text', async () => {
  let got = null;
  const r = await handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ask_user', arguments: { question: 'Which flavour?', options: ['dev', 'prod'], multi: false } } },
    async q => { got = q; return 'dev'; });
  assert.deepEqual(got, { kind: 'ask', question: 'Which flavour?', options: ['dev', 'prod'], multi: false });
  assert.equal(r.result.content[0].text, 'dev');
});
await check('a skipped question tells the agent to use the default, not wait', async () => {
  const r = await handleMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'ask_user', arguments: { question: 'x', options: ['a', 'b'] } } }, async () => '');
  assert.match(r.result.content[0].text, /skipped/);
});
await check('if the app is unreachable the tool errors softly (the build continues)', async () => {
  const r = await handleMessage({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'ask_user', arguments: { question: 'x', options: ['a', 'b'] } } }, async () => { throw new Error('ECONNREFUSED'); });
  assert.equal(r.result.isError, true); assert.match(r.result.content[0].text, /openQuestions/);
});

await check('a connector tool call goes to the app (which holds the key) and returns its text', async () => {
  let got = null;
  const r = await handleMessage({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'linear_get_issue', arguments: { id: 'FT-12' } } },
    null, async (tool, input) => { got = { tool, input }; return '[Linear — issue FT-12…]'; });
  assert.deepEqual(got, { tool: 'linear_get_issue', input: { id: 'FT-12' } });
  assert.equal(r.result.content[0].text, '[Linear — issue FT-12…]');
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
