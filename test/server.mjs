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

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nserver: all passed');
