/**
 * server.mjs — the persistent app end to end, over 127.0.0.1, with a mock model
 * that runs the interview then writes blueprint.json. No external network.
 *   node test/server.mjs
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
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
    let buf = ''; res.on('data', c => buf += c); res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return buf ? JSON.parse(buf) : null; } catch { return { raw: buf }; } })() }));
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
    let buf = ''; res.on('data', c => buf += c); res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return buf ? JSON.parse(buf) : null; } catch { return { raw: buf }; } })() }));
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

// ---- build history ------------------------------------------------------------------
function historyApp() {
  const cwd = mkdtempSync(join(tmpdir(), 'sm-app-'));
  const runs = [];
  const runCli = o => { runs.push(o); return { launched: true, headless: true, cancel() {} }; };
  const app = createApp({ cwd, secrets: makeSecrets({ platform: 'win32' }), detectDrivers: () => [{ id: 'claude', bin: 'claude', label: 'Claude Code' }], runCli });
  const kit = join(cwd, 'smartmonkey');
  const writeBp = n => { mkdirSync(kit, { recursive: true }); writeFileSync(join(kit, 'blueprint.json'), JSON.stringify({ smartmonkeyBlueprint: 1, screens: Array(n).fill({}) })); };
  return { cwd, kit, app, runs, writeBp };
}

await check('builds: a finished build is listed as current, and its progress replays after the fact', async () => {
  const { app, runs, writeBp } = historyApp();
  const port = await app.listen(0);
  await req(port, 'POST', '/api/ai', { mode: 'cli', driver: 'claude' });
  await req(port, 'POST', '/api/generate');
  await waitFor(() => runs.length === 1);
  runs[0].onEvent('tool', { name: 'Read', summary: 'README.md' });
  writeBp(3); runs[0].onDone();
  const list = (await req(port, 'GET', '/api/builds')).json.builds;
  assert.equal(list.length, 1); assert.equal(list[0].status, 'done'); assert.equal(list[0].current, true);
  assert.equal(list[0].counts.screens, 3);
  const one = (await req(port, 'GET', `/api/builds/${list[0].id}`)).json;
  assert.ok(one.events.some(e => e.type === 'tool' && e.data.summary === 'README.md'), 'progress was saved');
  assert.ok(one.events.some(e => e.type === 'done'), 'the ending too');
  app.server.close();
});

await check('builds: a new build starts clean; stopping it puts the current blueprint back', async () => {
  const { kit, app, runs, writeBp } = historyApp();
  const port = await app.listen(0);
  await req(port, 'POST', '/api/ai', { mode: 'cli', driver: 'claude' });
  await req(port, 'POST', '/api/generate'); await waitFor(() => runs.length === 1); writeBp(2); runs[0].onDone();
  await req(port, 'POST', '/api/generate'); await waitFor(() => runs.length === 2);
  assert.equal(existsSync(join(kit, 'blueprint.json')), false, 'clean start');
  await req(port, 'POST', '/api/stop');
  assert.equal(existsSync(join(kit, 'blueprint.json')), true, 'the current blueprint is back');
  const list = (await req(port, 'GET', '/api/builds')).json.builds;
  assert.deepEqual(list.map(b => b.status), ['stopped', 'done']);
  app.server.close();
});

await check('builds: "build on" an older build places its blueprint and tells the agent to start from it', async () => {
  const { kit, app, runs, writeBp } = historyApp();
  const port = await app.listen(0);
  await req(port, 'POST', '/api/ai', { mode: 'cli', driver: 'claude' });
  await req(port, 'POST', '/api/generate'); await waitFor(() => runs.length === 1); writeBp(4); runs[0].onDone();
  const first = (await req(port, 'GET', '/api/builds')).json.builds[0].id;
  assert.equal((await req(port, 'POST', '/api/generate', { basedOn: 'nope' })).status, 400);
  await req(port, 'POST', '/api/generate', { basedOn: first }); await waitFor(() => runs.length === 2);
  assert.match(runs[1].prompt, /starts from a previous blueprint/i);
  assert.equal(JSON.parse(readFileSync(join(kit, 'blueprint.json'), 'utf8')).screens.length, 4, 'the old blueprint is in place');
  app.server.close();
});

await check('builds: delete the current → the previous becomes current; a running build cannot be deleted; make-current works', async () => {
  const { kit, app, runs, writeBp } = historyApp();
  const port = await app.listen(0);
  await req(port, 'POST', '/api/ai', { mode: 'cli', driver: 'claude' });
  await req(port, 'POST', '/api/generate'); await waitFor(() => runs.length === 1); writeBp(1); runs[0].onDone();
  await req(port, 'POST', '/api/generate'); await waitFor(() => runs.length === 2); writeBp(2); runs[1].onDone();
  const [newer, older] = (await req(port, 'GET', '/api/builds')).json.builds;
  assert.equal((await req(port, 'POST', `/api/builds/${older.id}/current`)).status, 200);
  assert.equal(JSON.parse(readFileSync(join(kit, 'blueprint.json'), 'utf8')).screens.length, 1);
  assert.equal((await req(port, 'DELETE', `/api/builds/${older.id}`)).status, 200);
  assert.equal(JSON.parse(readFileSync(join(kit, 'blueprint.json'), 'utf8')).screens.length, 2, 'the other build is current again');
  await req(port, 'POST', '/api/generate'); await waitFor(() => runs.length === 3);
  const running = (await req(port, 'GET', '/api/builds')).json.builds[0];
  assert.equal((await req(port, 'DELETE', `/api/builds/${running.id}`)).status, 409);
  assert.equal((await req(port, 'GET', '/api/builds/..%2F..%2Fetc')).status, 404);
  app.server.close();
});

await check('builds: a blueprint made before history existed shows up as the last build as soon as the app opens', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sm-app-'));
  const kit = join(cwd, 'smartmonkey'); mkdirSync(kit, { recursive: true });
  writeFileSync(join(kit, 'blueprint.json'), JSON.stringify({ smartmonkeyBlueprint: 1, screens: [{}, {}] }));
  const app = createApp({ cwd, secrets: makeSecrets({ platform: 'win32' }) });
  const port = await app.listen(0);
  const list = (await req(port, 'GET', '/api/builds')).json.builds;
  assert.equal(list.length, 1, 'no build needed first');
  assert.equal(list[0].imported, true); assert.equal(list[0].current, true); assert.equal(list[0].counts.screens, 2);
  assert.match(readFileSync(join(kit, '.gitignore'), 'utf8'), /^builds\/$/m, 'history is git-ignored from the start');
  app.server.close();
});

// ---- connections: the local read-only middle layer --------------------------------------
function linearFetch(log = []) {
  return async (url, opts) => {
    const body = JSON.parse(opts.body); log.push({ auth: opts.headers.Authorization, body });
    if (opts.headers.Authorization !== 'lin_good') return { ok: false, status: 401, json: async () => ({ errors: [{ message: 'Authentication required, not authenticated' }] }) };
    if (/Viewer/.test(body.query)) return { ok: true, json: async () => ({ data: { viewer: { name: 'Alperen', organization: { name: 'Kuarasoft' } } } }) };
    if (/Search/.test(body.query)) return { ok: true, json: async () => ({ data: { searchIssues: { nodes: [{ identifier: 'FT-12', title: 'Tag limit paywall', state: { name: 'Todo' } }] } } }) };
    return { ok: true, json: async () => ({ data: {} }) };
  };
}

await check('connections: Linear is listed; a bad key is refused and NOT saved; a good key is tested, saved, and shown as connected', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sm-app-'));
  const app = createApp({ cwd, secrets: makeSecrets({ platform: 'win32' }), connectorFetch: linearFetch() });
  const port = await app.listen(0);
  const list0 = (await req(port, 'GET', '/api/connectors')).json;
  const lin0 = list0.connectors.find(c => c.id === 'linear');
  assert.equal(lin0.status, 'not_set_up'); assert.ok(list0.comingLater.includes('Jira'));
  const bad = await req(port, 'POST', '/api/connectors/linear', { fields: { apiKey: 'lin_bad' } });
  assert.equal(bad.status, 400); assert.match(bad.json.error, /Authentication/);
  assert.equal((await req(port, 'GET', '/api/connectors')).json.connectors[0].status, 'not_set_up', 'a failed test saves nothing');
  const good = await req(port, 'POST', '/api/connectors/linear', { fields: { apiKey: 'lin_good' } });
  assert.equal(good.status, 200); assert.equal(good.json.account, 'Alperen (Kuarasoft)');
  const lin = (await req(port, 'GET', '/api/connectors')).json.connectors[0];
  assert.equal(lin.status, 'connected'); assert.equal(lin.account, 'Alperen (Kuarasoft)');
  assert.ok(!JSON.stringify((await req(port, 'GET', '/api/connectors')).json).includes('lin_good'), 'the key is never sent back');
  assert.equal((await req(port, 'DELETE', '/api/connectors/linear')).status, 200);
  assert.equal((await req(port, 'GET', '/api/connectors')).json.connectors[0].status, 'not_set_up');
  app.server.close();
});

await check('connections: the build calls Linear through the app (token-protected), and every call is audited in the build', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sm-app-'));
  const calls = [];
  const runs = [];
  const runCli = o => { runs.push(o); return { launched: true, headless: true, cancel() {} }; };
  const app = createApp({ cwd, secrets: makeSecrets({ platform: 'win32' }), connectorFetch: linearFetch(calls), detectDrivers: () => [{ id: 'claude', bin: 'claude', label: 'Claude Code' }], runCli });
  const port = await app.listen(0);
  await req(port, 'POST', '/api/connectors/linear', { fields: { apiKey: 'lin_good' } });
  await req(port, 'POST', '/api/ai', { mode: 'cli', driver: 'claude' });
  await req(port, 'POST', '/api/generate'); await waitFor(() => runs.length === 1);
  const H = { 'x-smartmonkey-token': runs[0].askBridge.token };
  assert.equal((await reqH(port, 'POST', '/api/connector-call', { tool: 'linear_search_issues', input: { query: 'paywall' } }, { 'x-smartmonkey-token': 'nope' })).status, 403);
  assert.equal((await reqH(port, 'POST', '/api/connector-call', { tool: 'linear_delete_issue', input: {} }, H)).status, 404, 'only known read tools exist');
  const r = await reqH(port, 'POST', '/api/connector-call', { tool: 'linear_search_issues', input: { query: 'paywall' } }, H);
  assert.equal(r.status, 200); assert.match(r.json.text, /FT-12: Tag limit paywall/);
  assert.equal(calls.at(-1).auth, 'lin_good', 'the app, not the agent, holds the key');
  const b = (await req(port, 'GET', '/api/builds')).json.builds[0];
  const meta = (await req(port, 'GET', `/api/builds/${b.id}`)).json.meta;
  assert.equal(meta.connectorCalls.length, 1);
  assert.equal(meta.connectorCalls[0].tool, 'linear_search_issues');
  assert.match(meta.connectorCalls[0].input, /paywall/);
  app.server.close();
});

await check('connections: a tool that is not set up tells the build to ask for it, instead of failing silently', async () => {
  const { app, run } = pendingCliApp();
  const port = await app.listen(0);
  await req(port, 'POST', '/api/ai', { mode: 'cli', driver: 'claude' });
  await req(port, 'POST', '/api/generate'); await waitFor(() => run.bridge);
  const r = await reqH(port, 'POST', '/api/connector-call', { tool: 'linear_search_issues', input: { query: 'x' } }, { 'x-smartmonkey-token': run.bridge.token });
  assert.equal(r.status, 200); assert.match(r.json.text, /isn't connected.*request_connections/);
  app.server.close();
});

await check('connections: when the build asks for a set-up tool, the panel shows it already connected', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sm-app-'));
  const runs = [];
  const runCli = o => { runs.push(o); return { launched: true, headless: true, cancel() {} }; };
  const app = createApp({ cwd, secrets: makeSecrets({ platform: 'win32' }), connectorFetch: linearFetch(), detectDrivers: () => [{ id: 'claude', bin: 'claude', label: 'Claude Code' }], runCli, askPollMs: 150 });
  const port = await app.listen(0);
  const s = sse(port);
  await req(port, 'POST', '/api/connectors/linear', { fields: { apiKey: 'lin_good' } });
  await req(port, 'POST', '/api/ai', { mode: 'cli', driver: 'claude' });
  await req(port, 'POST', '/api/generate'); await waitFor(() => runs.length === 1);
  const H = { 'x-smartmonkey-token': runs[0].askBridge.token };
  const posted = await reqH(port, 'POST', '/api/agent-ask', { kind: 'connections', services: ['Linear', 'Jira'] }, H);
  await waitFor(() => s.has('connections'));
  const c = s.get('connections').data;
  assert.deepEqual(c.status, { Linear: 'connected', Jira: 'pending' });
  assert.deepEqual(c.connectable, { Linear: true, Jira: false });
  assert.equal(c.accounts.Linear, 'Alperen (Kuarasoft)');
  await req(port, 'POST', '/api/connect', { id: c.id, service: 'Jira', action: 'skip' });
  await req(port, 'POST', '/api/connections/start', { id: c.id });
  const got = await reqH(port, 'GET', `/api/agent-ask/${posted.json.id}`, null, H);
  assert.equal(got.json.answer, 'Connected: Linear. Not connected: Jira.');
  s.destroy(); app.server.close();
});

// ---- the blueprint home page needs: project name, per-project keys, full answers, connection outcome ----
await check('connections are per project: a key set up in one project folder is not used by another', async () => {
  const secrets = makeSecrets({ platform: 'win32' });
  const a = createApp({ cwd: mkdtempSync(join(tmpdir(), 'sm-a-')), secrets, connectorFetch: linearFetch() });
  const b = createApp({ cwd: mkdtempSync(join(tmpdir(), 'sm-b-')), secrets, connectorFetch: linearFetch() });
  const pa = await a.listen(0), pb = await b.listen(0);
  await req(pa, 'POST', '/api/connectors/linear', { fields: { apiKey: 'lin_good' } });
  assert.equal((await req(pa, 'GET', '/api/connectors')).json.connectors[0].status, 'connected');
  assert.equal((await req(pb, 'GET', '/api/connectors')).json.connectors[0].status, 'not_set_up', 'another project has its own connections');
  a.server.close(); b.server.close();
});

await check('status names the project folder', async () => {
  const cwd = join(mkdtempSync(join(tmpdir(), 'sm-')), 'FileTagger'); mkdirSync(cwd);
  const app = createApp({ cwd, secrets: makeSecrets({ platform: 'win32' }) });
  const port = await app.listen(0);
  assert.equal((await req(port, 'GET', '/api/status')).json.project.name, 'FileTagger');
  app.server.close();
});

await check('each answer is recorded with its question id, every option offered, and exactly what was picked', async () => {
  const { app, run } = pendingCliApp();
  const port = await app.listen(0);
  const s = sse(port);
  await req(port, 'POST', '/api/ai', { mode: 'cli', driver: 'claude' });
  await req(port, 'POST', '/api/generate'); await waitFor(() => run.bridge);
  const H = { 'x-smartmonkey-token': run.bridge.token };
  await reqH(port, 'POST', '/api/agent-ask', { kind: 'ask', question: 'Which platforms?', options: ['Android', 'iOS', 'Web'], multi: true }, H);
  await waitFor(() => s.has('ask'));
  const ask = s.get('ask').data;
  await req(port, 'POST', '/api/answer', { id: ask.id, answer: ['Android', 'Web'] });
  await waitFor(() => s.has('answered'));
  const a = s.get('answered').data;
  assert.equal(a.id, ask.id);
  assert.deepEqual(a.options, ['Android', 'iOS', 'Web']);
  assert.equal(a.multi, true);
  assert.deepEqual(a.picked, ['Android', 'Web']);
  assert.equal(s.events.filter(e => e.type === 'answered').length, 1, 'recorded once');
  const b = (await req(port, 'GET', '/api/builds')).json.builds[0];
  assert.ok((await req(port, 'GET', `/api/builds/${b.id}`)).json.events.some(e => e.type === 'answered' && e.data.picked.length === 2), 'kept in the build');
  s.destroy(); app.server.close();
});

await check('a blueprint remembers the outcome of its connect step', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sm-app-'));
  const runs = [];
  const runCli = o => { runs.push(o); return { launched: true, headless: true, cancel() {} }; };
  const app = createApp({ cwd, secrets: makeSecrets({ platform: 'win32' }), connectorFetch: linearFetch(), detectDrivers: () => [{ id: 'claude', bin: 'claude', label: 'Claude Code' }], runCli, askPollMs: 150 });
  const port = await app.listen(0);
  const s = sse(port);
  await req(port, 'POST', '/api/connectors/linear', { fields: { apiKey: 'lin_good' } });
  await req(port, 'POST', '/api/ai', { mode: 'cli', driver: 'claude' });
  await req(port, 'POST', '/api/generate'); await waitFor(() => runs.length === 1);
  await reqH(port, 'POST', '/api/agent-ask', { kind: 'connections', services: ['Linear', 'Jira'] }, { 'x-smartmonkey-token': runs[0].askBridge.token });
  await waitFor(() => s.has('connections'));
  const c = s.get('connections').data;
  await req(port, 'POST', '/api/connect', { id: c.id, service: 'Jira', action: 'skip' });
  await req(port, 'POST', '/api/connections/start', { id: c.id });
  const b = (await req(port, 'GET', '/api/builds')).json.builds[0];
  const meta = (await req(port, 'GET', `/api/builds/${b.id}`)).json.meta;
  assert.deepEqual(meta.connections.status, { Linear: 'connected', Jira: 'skipped' });
  assert.equal(meta.connections.accounts.Linear, 'Alperen (Kuarasoft)');
  s.destroy(); app.server.close();
});

await check('a re-run pre-selects last time\'s choice, even when the agent rewords the question and options', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sm-app-'));
  let run = 0, turn = 0;
  const ASKS = [
    { question: 'Which build should a tester use?', options: ['devDebug', 'release'] },
    { question: 'Which build variant should testers install?', options: ['release', 'devDebug (dev backend)'] },
  ];
  const mockModel = async () => {
    turn++;
    if (turn === 1) return { content: [{ type: 'tool_use', id: 't1', name: 'ask_user', input: ASKS[run - 1] }], stop_reason: 'tool_use' };
    return { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' };
  };
  const app = createApp({ cwd, secrets: makeSecrets({ platform: 'win32' }), modelFactory: () => mockModel });
  const port = await app.listen(0);
  await req(port, 'POST', '/api/ai', { provider: 'anthropic', model: 'claude-sonnet-5', key: 'sk-ant-x' });
  const oneRun = async answer => {
    run++; turn = 0;
    assert.equal((await req(port, 'POST', '/api/generate')).status, 202);
    let st;
    for (let i = 0; i < 100; i++) { st = (await req(port, 'GET', '/api/status')).json; if (st.pendingAsk) break; await new Promise(r => setTimeout(r, 20)); }
    assert.ok(st.run.startedAt, 'the status carries when the build started (the working timer)');
    await req(port, 'POST', '/api/answer', { id: st.pendingAsk.id, answer });
    for (let i = 0; i < 100; i++) { if ((await req(port, 'GET', '/api/status')).json.run.status !== 'running') break; await new Promise(r => setTimeout(r, 20)); }
    return st.pendingAsk;
  };
  const first = await oneRun('devDebug');
  assert.equal(first.suggested, undefined, 'nothing to pre-select the first time');
  const rec = JSON.parse(readFileSync(join(cwd, 'smartmonkey', 'owner-answers.json'), 'utf8')).answers;
  assert.deepEqual(rec[0].picked, ['devDebug'], 'the exact pick is recorded');
  const second = await oneRun('release');
  assert.deepEqual(second.suggested.picked, ['devDebug (dev backend)']);
  app.server.close();
});

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nserver: all passed');
