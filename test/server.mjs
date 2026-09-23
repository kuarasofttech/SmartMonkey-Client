/**
 * server.mjs — the persistent app end to end, over 127.0.0.1, with a mock model
 * that runs the interview then writes blueprint.json. No external network.
 *   node test/server.mjs
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

const { createApp } = await import('../server.mjs');
const { makeSecrets } = await import('../secrets.mjs');

let failures = 0;
async function check(name, fn) { try { await fn(); console.log(`  ok  ${name}`); } catch (e) { failures++; console.error(`FAIL  ${name}: ${e.message}`); } }

const req = (port, method, path, body) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  const r = http.request({ host: '127.0.0.1', port, method, path, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, res => {
    let buf = ''; res.on('data', c => buf += c); res.on('end', () => resolve({ status: res.statusCode, json: buf ? JSON.parse(buf) : null }));
  });
  r.on('error', reject); if (data) r.write(data); r.end();
});

await check('generate → ask (SSE) → answer → done writes blueprint.json; concurrent generate is 409; key never leaks', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sm-app-'));
  // mock model: turn1 asks, turn2 writes the blueprint, turn3 ends.
  let turn = 0;
  const mockModel = async () => {
    turn++;
    if (turn === 1) return { content: [{ type: 'tool_use', id: 't1', name: 'ask_user', input: { question: 'Which app?', options: ['A', 'B'] } }], stop_reason: 'tool_use' };
    if (turn === 2) return { content: [{ type: 'tool_use', id: 't2', name: 'write_file', input: { path: 'smartmonkey/blueprint.json', contents: JSON.stringify({ smartmonkeyBlueprint: 1 }) } }], stop_reason: 'tool_use' };
    return { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' };
  };
  const app = createApp({ cwd, secrets: makeSecrets({ platform: 'win32' }), modelFactory: () => mockModel });
  const port = await app.listen(0);

  let sawAsk = null, sawDone = false;
  const es = http.request({ host: '127.0.0.1', port, path: '/api/events', method: 'GET' }, res => {
    let buf = '';
    res.on('data', chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2);
        const type = (raw.match(/event: (.*)/) || [])[1];
        const data = JSON.parse((raw.match(/data: (.*)/) || [])[1] || 'null');
        if (type === 'ask') { sawAsk = data; req(port, 'POST', '/api/answer', { id: data.id, answer: 'A' }); }
        if (type === 'done') { sawDone = true; }
      }
    });
  });
  es.end();

  assert.equal((await req(port, 'POST', '/api/ai', { provider: 'anthropic', model: 'claude-sonnet-5', key: 'sk-ant-x' })).status, 200);
  const status1 = await req(port, 'GET', '/api/status');
  assert.equal(status1.json.ai.ready, true);
  assert.ok(!JSON.stringify(status1.json).includes('sk-ant-x'), 'the key is never in a response');

  assert.equal((await req(port, 'POST', '/api/generate')).status, 202);
  assert.equal((await req(port, 'POST', '/api/generate')).status, 409, 'second concurrent generate refused');

  for (let i = 0; i < 100 && !sawDone; i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(sawAsk && sawAsk.options.length === 2, 'the interview question streamed over SSE');
  assert.ok(sawDone, 'a done event arrived');
  assert.ok(existsSync(join(cwd, 'smartmonkey', 'blueprint.json')), 'blueprint.json was written');

  es.destroy(); app.server.close();
});

await check('GET /api/drivers reflects the injected detectDrivers', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sm-app-'));
  const app = createApp({ cwd, secrets: makeSecrets({ platform: 'win32' }), detectDrivers: () => [{ id: 'claude', bin: 'claude', label: 'Claude Code' }] });
  const port = await app.listen(0);

  const r = await req(port, 'GET', '/api/drivers');
  assert.equal(r.status, 200);
  const byId = Object.fromEntries(r.json.drivers.map(d => [d.id, d]));
  assert.equal(byId.claude.available, true);
  assert.equal(byId.codex.available, false);
  assert.equal(byId.cursor.available, false);
  assert.equal(byId.gemini.available, false);

  app.server.close();
});

await check('CLI mode readiness: selecting an available driver is ready, an unavailable one is not', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sm-app-'));
  const app = createApp({ cwd, secrets: makeSecrets({ platform: 'win32' }), detectDrivers: () => [{ id: 'claude', bin: 'claude', label: 'Claude Code' }] });
  const port = await app.listen(0);

  assert.equal((await req(port, 'POST', '/api/ai', { mode: 'cli', driver: 'claude' })).status, 200);
  const ready = await req(port, 'GET', '/api/status');
  assert.equal(ready.json.mode, 'cli');
  assert.equal(ready.json.driver, 'claude');
  assert.equal(ready.json.ai.ready, true);

  assert.equal((await req(port, 'POST', '/api/ai', { mode: 'cli', driver: 'codex' })).status, 200);
  const notReady = await req(port, 'GET', '/api/status');
  assert.equal(notReady.json.mode, 'cli');
  assert.equal(notReady.json.driver, 'codex');
  assert.equal(notReady.json.ai.ready, false, 'codex is not in the injected detectDrivers set');

  app.server.close();
});

await check('CLI mode generate: injected runCli writes the blueprint and streams done', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sm-app-'));
  mkdirSync(join(cwd, 'smartmonkey'), { recursive: true });
  const runCli = ({ onDone }) => { writeFileSync(join(cwd, 'smartmonkey', 'blueprint.json'), JSON.stringify({ smartmonkeyBlueprint: 1 })); onDone(); };
  const app = createApp({ cwd, secrets: makeSecrets({ platform: 'win32' }), detectDrivers: () => [{ id: 'claude', bin: 'claude', label: 'Claude Code' }], runCli });
  const port = await app.listen(0);

  let sawDone = false, doneData = null;
  const es = http.request({ host: '127.0.0.1', port, path: '/api/events', method: 'GET' }, res => {
    let buf = '';
    res.on('data', chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2);
        const type = (raw.match(/event: (.*)/) || [])[1];
        const data = JSON.parse((raw.match(/data: (.*)/) || [])[1] || 'null');
        if (type === 'done') { sawDone = true; doneData = data; }
      }
    });
  });
  es.end();

  assert.equal((await req(port, 'POST', '/api/ai', { mode: 'cli', driver: 'claude' })).status, 200);
  assert.equal((await req(port, 'POST', '/api/generate')).status, 202);

  for (let i = 0; i < 100 && !sawDone; i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(sawDone, 'a done event arrived');
  assert.equal(doneData.blueprint, true);
  assert.ok(existsSync(join(cwd, 'smartmonkey', 'blueprint.json')), 'blueprint.json was written');

  es.destroy(); app.server.close();
});

await check('CLI mode generate with an unavailable driver is refused', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sm-app-'));
  const app = createApp({ cwd, secrets: makeSecrets({ platform: 'win32' }), detectDrivers: () => [] });
  const port = await app.listen(0);

  assert.equal((await req(port, 'POST', '/api/ai', { mode: 'cli', driver: 'claude' })).status, 200);
  const r = await req(port, 'POST', '/api/generate');
  assert.equal(r.status, 400);
  assert.ok(r.json && r.json.error, 'a 400 error body is returned');
  assert.ok(/not available/.test(r.json.error), `error message names the CLI as unavailable, got: ${r.json && r.json.error}`);

  app.server.close();
});

await check('CLI mode generate with no AI configured at all (no provider, no driver) still gives the CLI-specific 400, not the generic "AI not ready" one', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sm-app-'));
  const app = createApp({ cwd, secrets: makeSecrets({ platform: 'win32' }), detectDrivers: () => [] });
  const port = await app.listen(0);

  assert.equal((await req(port, 'POST', '/api/ai', { mode: 'cli', driver: 'codex' })).status, 200);
  const r = await req(port, 'POST', '/api/generate');
  assert.equal(r.status, 400);
  assert.ok(/not available/.test(r.json.error), `expected the CLI-not-available message, got: ${r.json && r.json.error}`);
  assert.ok(!/AI not ready/.test(r.json.error), 'the generic embedded-only message must not fire for the cli branch');

  app.server.close();
});

await check('connect gate: request_connections pauses; start is refused until each tool is resolved; then the blueprint is written', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sm-app-'));
  let turn = 0;
  const mockModel = async () => {
    turn++;
    if (turn === 1) return { content: [{ type: 'tool_use', id: 'c1', name: 'request_connections', input: { services: ['Jira', 'Figma'] } }], stop_reason: 'tool_use' };
    if (turn === 2) return { content: [{ type: 'tool_use', id: 'w1', name: 'write_file', input: { path: 'smartmonkey/blueprint.json', contents: JSON.stringify({ smartmonkeyBlueprint: 1 }) } }], stop_reason: 'tool_use' };
    return { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' };
  };
  const app = createApp({ cwd, secrets: makeSecrets({ platform: 'win32' }), modelFactory: () => mockModel });
  const port = await app.listen(0);

  let conn = null, sawDone = false;
  const es = http.request({ host: '127.0.0.1', port, path: '/api/events', method: 'GET' }, res => {
    let buf = '';
    res.on('data', chunk => {
      buf += chunk; let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2);
        const type = (raw.match(/event: (.*)/) || [])[1];
        const data = JSON.parse((raw.match(/data: (.*)/) || [])[1] || 'null');
        if (type === 'connections') conn = data;
        if (type === 'done') sawDone = true;
      }
    });
  });
  es.end();

  assert.equal((await req(port, 'POST', '/api/ai', { provider: 'anthropic', model: 'claude-sonnet-5', key: 'sk-ant-x' })).status, 200);
  assert.equal((await req(port, 'POST', '/api/generate')).status, 202);

  for (let i = 0; i < 100 && !conn; i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(conn && conn.services.length === 2, 'a connections event streamed with two tools');
  assert.deepEqual(conn.services, ['Jira', 'Figma']);

  // status exposes the pending connection for a reloaded page
  const mid = await req(port, 'GET', '/api/status');
  assert.ok(mid.json.pendingConnections && mid.json.pendingConnections.id === conn.id, 'status carries pendingConnections');

  // start is refused while anything is still pending
  assert.equal((await req(port, 'POST', '/api/connections/start', { id: conn.id })).status, 409, 'refused with both pending');
  assert.equal((await req(port, 'POST', '/api/connect', { id: conn.id, service: 'Jira', action: 'connect' })).status, 409, 'no real connector → a fake connect is refused');
  assert.equal((await req(port, 'POST', '/api/connect', { id: conn.id, service: 'Jira', action: 'skip' })).status, 200);
  assert.equal((await req(port, 'POST', '/api/connections/start', { id: conn.id })).status, 409, 'refused with Figma pending');
  assert.equal((await req(port, 'POST', '/api/connect', { id: conn.id, service: 'Figma', action: 'skip' })).status, 200);

  // now it proceeds and the agent finishes
  assert.equal((await req(port, 'POST', '/api/connections/start', { id: conn.id })).status, 200);
  for (let i = 0; i < 100 && !sawDone; i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(sawDone, 'done arrived after the connect step');
  assert.ok(existsSync(join(cwd, 'smartmonkey', 'blueprint.json')), 'blueprint.json written only after Start');

  es.destroy(); app.server.close();
});


// ---- app-owned interview --------------------------------------------------------
function sse(port) {
  const events = [];
  const r = http.request({ host: '127.0.0.1', port, path: '/api/events', method: 'GET' }, res => {
    let buf = '';
    res.on('data', chunk => {
      buf += chunk; let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2);
        events.push({ type: (raw.match(/event: (.*)/) || [])[1], data: JSON.parse((raw.match(/data: (.*)/) || [])[1] || 'null') });
      }
    });
  });
  r.end();
  return { events, has: t => events.some(e => e.type === t), get: t => events.find(e => e.type === t), destroy: () => r.destroy() };
}
const waitFor = async (fn, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise(r => setTimeout(r, 20)); } return false; };

await check('GET /api/interview serves the question schema and, after a run, the saved answers', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sm-app-'));
  const mockModel = async () => ({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
  const app = createApp({ cwd, secrets: makeSecrets({ platform: 'win32' }), modelFactory: () => mockModel });
  const port = await app.listen(0);
  const before = await req(port, 'GET', '/api/interview');
  assert.ok(Array.isArray(before.json.questions) && before.json.questions.length > 5);
  assert.equal(before.json.saved, null);
  await req(port, 'POST', '/api/ai', { provider: 'anthropic', key: 'sk-ant-x' });
  assert.equal((await req(port, 'POST', '/api/generate', { answers: { build: 'devDebug' } })).status, 202);
  const after = await req(port, 'GET', '/api/interview');
  assert.equal(after.json.saved.build, 'devDebug', 'answers persisted for a re-run');
  assert.ok(existsSync(join(cwd, 'smartmonkey', 'interview.json')));
  app.server.close();
});

await check('generate with answers: the model is told the interview is done and gets the answers', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sm-app-'));
  let firstPrompt = null;
  const mockModel = async messages => { if (firstPrompt === null) firstPrompt = messages[0].content; return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }; };
  const app = createApp({ cwd, secrets: makeSecrets({ platform: 'win32' }), modelFactory: () => mockModel });
  const port = await app.listen(0);
  const s = sse(port);
  await req(port, 'POST', '/api/ai', { provider: 'anthropic', key: 'sk-ant-x' });
  await req(port, 'POST', '/api/generate', { answers: { build: 'devDebug', coverage: 'broad' } });
  assert.ok(await waitFor(() => s.has('done')), 'run finished');
  assert.match(firstPrompt, /^# The interview is ALREADY DONE/);
  assert.match(firstPrompt, /devDebug/);
  assert.match(firstPrompt, /Go broad/);
  assert.match(firstPrompt, /# Build the SmartMonkey QA blueprint/, 'the builder prompt follows the block');
  s.destroy(); app.server.close();
});

await check('answers that need a tool: the connect panel comes first and the model does not run until Start', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sm-app-'));
  let calls = 0, firstPrompt = null;
  const mockModel = async messages => { calls++; if (firstPrompt === null) firstPrompt = messages[0].content; return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }; };
  const app = createApp({ cwd, secrets: makeSecrets({ platform: 'win32' }), modelFactory: () => mockModel });
  const port = await app.listen(0);
  const s = sse(port);
  await req(port, 'POST', '/api/ai', { provider: 'anthropic', key: 'sk-ant-x' });
  await req(port, 'POST', '/api/generate', { answers: { produce: 'blueprint+cases', casesSource: 'jira', casesAccess: 'token', docs: ['figma'] } });
  assert.ok(await waitFor(() => s.has('connections')));
  const conn = s.get('connections').data;
  assert.deepEqual(conn.services, ['Jira', 'Figma']);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(calls, 0, 'nothing built before Start');
  await req(port, 'POST', '/api/connect', { id: conn.id, service: 'Jira', action: 'skip' });
  await req(port, 'POST', '/api/connect', { id: conn.id, service: 'Figma', action: 'skip' });
  assert.equal((await req(port, 'POST', '/api/connections/start', { id: conn.id })).status, 200);
  assert.ok(await waitFor(() => s.has('done')));
  assert.ok(calls > 0);
  assert.match(firstPrompt, /Connected: none\. Not connected: Jira, Figma\./);
  s.destroy(); app.server.close();
});

await check('stopping at the connect panel never starts the build', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sm-app-'));
  let calls = 0;
  const mockModel = async () => { calls++; return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }; };
  const app = createApp({ cwd, secrets: makeSecrets({ platform: 'win32' }), modelFactory: () => mockModel });
  const port = await app.listen(0);
  const s = sse(port);
  await req(port, 'POST', '/api/ai', { provider: 'anthropic', key: 'sk-ant-x' });
  await req(port, 'POST', '/api/generate', { answers: { docs: ['figma'] } });
  assert.ok(await waitFor(() => s.has('connections')));
  await req(port, 'POST', '/api/stop');
  await new Promise(r => setTimeout(r, 150));
  assert.equal(calls, 0, 'no build after a stop');
  const st = await req(port, 'GET', '/api/status');
  assert.equal(st.json.run.status, 'stopped');
  assert.equal((await req(port, 'POST', '/api/generate', { answers: {} })).status, 202, 'a new run is allowed after stopping');
  s.destroy(); app.server.close();
});

await check('CLI mode: runCli gets the answers-first prompt, and its progress events reach the browser', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sm-app-'));
  let got = null;
  const runCli = ({ prompt, onEvent, onDone }) => { got = prompt; onEvent('tool', { name: 'Read', summary: 'README.md' }); onDone(); return { launched: true, headless: true }; };
  const app = createApp({ cwd, secrets: makeSecrets({ platform: 'win32' }), detectDrivers: () => [{ id: 'claude', bin: 'claude', label: 'Claude Code' }], runCli });
  const port = await app.listen(0);
  const s = sse(port);
  await req(port, 'POST', '/api/ai', { mode: 'cli', driver: 'claude' });
  await req(port, 'POST', '/api/generate', { answers: { build: 'staging' } });
  assert.ok(await waitFor(() => s.has('done')));
  assert.match(got, /^# The interview is ALREADY DONE/);
  assert.match(got, /staging/);
  assert.ok(s.events.some(e => e.type === 'tool' && e.data.summary === 'README.md'), 'CLI progress streamed as SSE');
  s.destroy(); app.server.close();
});

// ---- mid-run questions from a headless CLI (the ask_user MCP bridge) + Stop -----------
const reqH = (port, method, path, body, headers = {}) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  const r = http.request({ host: '127.0.0.1', port, method, path, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, res => {
    let buf = ''; res.on('data', c => buf += c); res.on('end', () => resolve({ status: res.statusCode, json: buf ? JSON.parse(buf) : null }));
  });
  r.on('error', reject); if (data) r.write(data); r.end();
});
function pendingCliApp(extra = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'sm-app-'));
  const run = { bridge: null, cancelled: false, done: null };
  const runCli = ({ askBridge, onDone }) => { run.bridge = askBridge; run.done = onDone; return { launched: true, headless: true, cancel: () => { run.cancelled = true; } }; };
  const app = createApp({ cwd, secrets: makeSecrets({ platform: 'win32' }), detectDrivers: () => [{ id: 'claude', bin: 'claude', label: 'Claude Code' }], runCli, askPollMs: 150, ...extra });
  return { app, run };
}

await check('agent-ask: the CLI run gets a bridge URL+token; the endpoint rejects a bad token and 409s with no run', async () => {
  const { app, run } = pendingCliApp();
  const port = await app.listen(0);
  assert.equal((await reqH(port, 'POST', '/api/agent-ask', { question: 'x' }, { 'x-smartmonkey-token': 'nope' })).status, 403);
  await req(port, 'POST', '/api/ai', { mode: 'cli', driver: 'claude' });
  await req(port, 'POST', '/api/generate', { answers: {} });
  assert.ok(await waitFor(() => run.bridge), 'runCli got a bridge');
  assert.match(run.bridge.url, new RegExp(`^http://127\\.0\\.0\\.1:${port}/api/agent-ask$`));
  assert.ok(run.bridge.token && run.bridge.token.length >= 16);
  assert.equal((await reqH(port, 'POST', '/api/agent-ask', { question: 'x' }, { 'x-smartmonkey-token': 'nope' })).status, 403);
  run.done();
  await waitFor(async () => false, 50);
  const idle = await reqH(port, 'POST', '/api/agent-ask', { question: 'x' }, { 'x-smartmonkey-token': run.bridge.token });
  assert.equal(idle.status, 409, 'no run → no questions');
  app.server.close();
});

await check('agent-ask round trip: question shows in the page (multi), long-poll is pending, then returns the answer', async () => {
  const { app, run } = pendingCliApp();
  const port = await app.listen(0);
  const s = sse(port);
  await req(port, 'POST', '/api/ai', { mode: 'cli', driver: 'claude' });
  await req(port, 'POST', '/api/generate', { answers: {} });
  await waitFor(() => run.bridge);
  const H = { 'x-smartmonkey-token': run.bridge.token };
  const posted = await reqH(port, 'POST', '/api/agent-ask', { question: 'Which platforms ship?', options: ['Android', 'iOS'], multi: true }, H);
  assert.equal(posted.status, 200); assert.ok(posted.json.id);
  assert.ok(await waitFor(() => s.has('ask')));
  const ask = s.get('ask').data;
  assert.equal(ask.question, 'Which platforms ship?'); assert.equal(ask.multi, true);
  const early = await reqH(port, 'GET', `/api/agent-ask/${posted.json.id}`, null, H);
  assert.equal(early.json.pending, true, 'no answer yet → pending after the poll window');
  await req(port, 'POST', '/api/answer', { id: ask.id, answer: ['Android', 'iOS'] });
  const got = await reqH(port, 'GET', `/api/agent-ask/${posted.json.id}`, null, H);
  assert.deepEqual(got.json, { answer: 'Android, iOS' });
  s.destroy(); app.server.close();
});

await check('Stop during a headless run: cancels the CLI, answers a waiting question with "", reports stopped', async () => {
  const { app, run } = pendingCliApp();
  const port = await app.listen(0);
  const s = sse(port);
  await req(port, 'POST', '/api/ai', { mode: 'cli', driver: 'claude' });
  await req(port, 'POST', '/api/generate', { answers: {} });
  await waitFor(() => run.bridge);
  const H = { 'x-smartmonkey-token': run.bridge.token };
  const posted = await reqH(port, 'POST', '/api/agent-ask', { question: 'q?' }, H);
  await waitFor(() => s.has('ask'));
  const poll = reqH(port, 'GET', `/api/agent-ask/${posted.json.id}`, null, H);
  await req(port, 'POST', '/api/stop');
  assert.deepEqual((await poll).json, { answer: '' }, 'the waiting question is released');
  assert.equal(run.cancelled, true);
  assert.ok(await waitFor(() => s.has('stopped')));
  assert.equal((await req(port, 'GET', '/api/status')).json.run.status, 'stopped');
  assert.equal((await req(port, 'POST', '/api/generate', { answers: {} })).status, 202, 'can start again right away');
  s.destroy(); app.server.close();
});

await check('Stop during an embedded (API-key) run is immediate; the old run cannot report done afterwards', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sm-app-'));
  let release;
  const gate = new Promise(r => { release = r; });
  let calls = 0;
  const mockModel = async () => { calls++; if (calls === 1) await gate; return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }; };
  const app = createApp({ cwd, secrets: makeSecrets({ platform: 'win32' }), modelFactory: () => mockModel });
  const port = await app.listen(0);
  const s = sse(port);
  await req(port, 'POST', '/api/ai', { provider: 'anthropic', key: 'sk-ant-x' });
  await req(port, 'POST', '/api/generate', { answers: {} });
  await waitFor(() => calls === 1);
  await req(port, 'POST', '/api/stop');
  const st = await req(port, 'GET', '/api/status');
  assert.equal(st.json.run.status, 'stopped', 'stopped at once, not after the model call returns');
  release();
  await new Promise(r => setTimeout(r, 100));
  assert.equal(s.has('done'), false, 'the stopped run never reports done');
  assert.equal((await req(port, 'GET', '/api/status')).json.run.status, 'stopped');
  s.destroy(); app.server.close();
});

await check('the answers block now invites project-specific questions via ask_user', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sm-app-'));
  let got = null;
  const runCli = ({ prompt, onDone }) => { got = prompt; onDone(); return { launched: true, headless: true }; };
  const app = createApp({ cwd, secrets: makeSecrets({ platform: 'win32' }), detectDrivers: () => [{ id: 'claude', bin: 'claude', label: 'Claude Code' }], runCli });
  const port = await app.listen(0);
  await req(port, 'POST', '/api/ai', { mode: 'cli', driver: 'claude' });
  await req(port, 'POST', '/api/generate', { answers: {} });
  await waitFor(() => got);
  assert.match(got, /ask_user/);
  assert.match(got, /project-specific/i);
  app.server.close();
});

// ---- the interview happens DURING the run -------------------------------------------
await check('a normal build (no pre-supplied answers) gets the in-run interview block', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sm-app-'));
  let got = null;
  const runCli = ({ prompt, onDone }) => { got = prompt; onDone(); return { launched: true, headless: true }; };
  const app = createApp({ cwd, secrets: makeSecrets({ platform: 'win32' }), detectDrivers: () => [{ id: 'claude', bin: 'claude', label: 'Claude Code' }], runCli });
  const port = await app.listen(0);
  await req(port, 'POST', '/api/ai', { mode: 'cli', driver: 'claude' });
  await req(port, 'POST', '/api/generate');
  await waitFor(() => got);
  assert.match(got, /^# How the interview works here/);
  assert.match(got, /Read the repo first/);
  assert.match(got, /# Build the SmartMonkey QA blueprint/);
  app.server.close();
});

await check('mid-run request_connections shows the Connect panel and returns the outcome to the build', async () => {
  const { app, run } = pendingCliApp();
  const port = await app.listen(0);
  const s = sse(port);
  await req(port, 'POST', '/api/ai', { mode: 'cli', driver: 'claude' });
  await req(port, 'POST', '/api/generate');
  await waitFor(() => run.bridge);
  const H = { 'x-smartmonkey-token': run.bridge.token };
  const posted = await reqH(port, 'POST', '/api/agent-ask', { kind: 'connections', services: ['Jira', 'Figma'] }, H);
  assert.ok(await waitFor(() => s.has('connections')));
  const c = s.get('connections').data;
  assert.deepEqual(c.services, ['Jira', 'Figma']);
  assert.deepEqual(c.connectable, { Jira: false, Figma: false }, 'the page is told nothing is really connectable');
  await req(port, 'POST', '/api/connect', { id: c.id, service: 'Jira', action: 'skip' });
  await req(port, 'POST', '/api/connect', { id: c.id, service: 'Figma', action: 'skip' });
  await req(port, 'POST', '/api/connections/start', { id: c.id });
  const got = await reqH(port, 'GET', `/api/agent-ask/${posted.json.id}`, null, H);
  assert.equal(got.json.answer, 'Connected: none. Not connected: Jira, Figma.');
  s.destroy(); app.server.close();
});

await check('the owner\'s answers are remembered and offered first on the next run', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sm-app-'));
  const runs = [];
  const runCli = ({ prompt, askBridge, onDone }) => { runs.push({ prompt, askBridge, onDone }); return { launched: true, headless: true, cancel() {} }; };
  const app = createApp({ cwd, secrets: makeSecrets({ platform: 'win32' }), detectDrivers: () => [{ id: 'claude', bin: 'claude', label: 'Claude Code' }], runCli, askPollMs: 150 });
  const port = await app.listen(0);
  const s = sse(port);
  await req(port, 'POST', '/api/ai', { mode: 'cli', driver: 'claude' });
  await req(port, 'POST', '/api/generate');
  await waitFor(() => runs.length === 1);
  const H = { 'x-smartmonkey-token': runs[0].askBridge.token };
  const posted = await reqH(port, 'POST', '/api/agent-ask', { kind: 'ask', question: 'Which build should a tester use?', options: ['devDebug', 'prodRelease'] }, H);
  await waitFor(() => s.has('ask'));
  await req(port, 'POST', '/api/answer', { id: s.get('ask').data.id, answer: 'devDebug' });
  await reqH(port, 'GET', `/api/agent-ask/${posted.json.id}`, null, H);
  runs[0].onDone();
  await waitFor(() => s.has('done'));
  assert.ok(existsSync(join(cwd, 'smartmonkey', 'owner-answers.json')));
  await req(port, 'POST', '/api/generate');
  await waitFor(() => runs.length === 2);
  assert.match(runs[1].prompt, /Last time the owner answered/);
  assert.match(runs[1].prompt, /Which build should a tester use\? → devDebug/);
  s.destroy(); app.server.close();
});

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nserver: all passed');
