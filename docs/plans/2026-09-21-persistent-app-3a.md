# Persistent App 3a Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `smartmonkey app` launches a persistent local web app that generates the blueprint end-to-end in the browser — including the interview — with secrets in the OS keychain, reusing `embed.mjs` verbatim.

**Architecture:** A zero-dep `http` server (`server.mjs`) serves a single-page UI and an API (status / ai / generate / SSE events / answer / stop). It runs the existing `embed.runAgent`, swapping the terminal `ask` for a web bridge (`webask.mjs`): the agent's `ask_user` emits an SSE `ask`, the page renders a form, the answer POSTs back and resolves it. Secrets live in the OS keychain (`secrets.mjs`) with an in-memory fallback. The one-shot `run`/`serve` path is untouched.

**Tech Stack:** Node ≥ 18, ESM, zero runtime dependencies (builtins; `child_process` for keychain, `http` for the server). Anthropic/OpenAI/Gemini via the existing `PROVIDERS`.

**Spec:** `docs/specs/2026-09-21-persistent-app-3a-design.md`

## Global Constraints

- **Zero runtime dependencies** — node builtins only; keychain via an injectable `exec`; the model call via an injectable `modelFactory`/`callModel`.
- **Node ≥ 18, ESM.**
- **Privacy** — AI runs locally; only the reviewed `blueprint.json` leaves; **never** write a secret to disk in plaintext (keychain, or in-memory fallback only).
- **Never read the keychain on a status poll** — reading `security`/`secret-tool` can prompt the user; keep the resolved key in memory for the session and derive `ready` from that + env.
- **Don't touch the one-shot path** — `cmdRun`, `runEmbedded`, `runViaCli`, `serve`, `cmdCheck`, `scaffold` stay as-is; 3a is additive.
- **Tests are mock-based** — injected `exec` and `modelFactory`; a `127.0.0.1` server in tests is fine; no external network.
- **Commits** — no signing configured; use `git -c commit.gpgsign=false commit`. End every message with:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01J8wrVY2enRpNmkBKLhYrWi
  ```

## File Structure

- `secrets.mjs` (new) — `makeSecrets({ exec?, platform? })` → `{ available(), get(name), set(name,value), delete(name) }`. Keychain via `security` (darwin) / `secret-tool` (linux); in-memory Map otherwise.
- `webask.mjs` (new) — `makeWebAsk(session, emit)` → an `ask(question, options)` promise; `answerAsk(session, id, answer)`. Pure.
- `server.mjs` (new) — `createApp({ cwd?, secrets?, modelFactory? })` → `{ server, session, listen(port) }`. Routes + SSE + single-run session; wires `embed` + `webask` + `secrets`.
- `assets/app.html` (new) — the single-page UI (setup / generate / interview / review link). Client-owned; not in the organiclaw asset sync.
- `cli.mjs` (modify) — add the `app` command; list it in help.
- `test/secrets.mjs`, `test/webask.mjs`, `test/server.mjs` (new).
- `package.json` (modify) — `test` runs all four test files.

---

### Task 1: `secrets.mjs` — keychain get/set/delete + fallback

**Files:**
- Create: `secrets.mjs`
- Create: `test/secrets.mjs`
- Modify: `package.json` (test script)

**Interfaces:**
- Produces:
  - `defaultExec(cmd, args, { input? }) → { status, stdout, stderr }` — wraps `spawnSync` (encoding utf8); `status` is `null` when the binary is missing.
  - `makeSecrets({ exec = defaultExec, platform = process.platform }) → { available(): boolean, get(name): string|null, set(name, value): boolean, delete(name): boolean }` — service name `smartmonkey`; keychain on darwin/linux (when the tool probe succeeds), else an in-memory Map.

- [ ] **Step 1: Write the failing test** — create `test/secrets.mjs`:

```js
/**
 * secrets.mjs — keychain backend (mock exec) + in-memory fallback.
 *   node test/secrets.mjs
 */
import { strict as assert } from 'node:assert';
const { makeSecrets } = await import('../secrets.mjs');

let failures = 0;
function check(name, fn) { try { fn(); console.log(`  ok  ${name}`); } catch (e) { failures++; console.error(`FAIL  ${name}: ${e.message}`); } }

// A mock exec that records calls and answers the availability probe + a lookup.
function mockExec(script) {
  const calls = [];
  const exec = (cmd, args, opts = {}) => { calls.push({ cmd, args, input: opts.input }); return script(cmd, args, opts) || { status: 0, stdout: '', stderr: '' }; };
  return { exec, calls };
}

check('darwin: set/get/delete use `security` with the right argv', () => {
  const { exec, calls } = mockExec((cmd, args) => {
    if (args[0] === 'help') return { status: 0, stdout: '' };            // probe
    if (args[0] === 'find-generic-password') return { status: 0, stdout: 'SEKRET\n' };
    return { status: 0, stdout: '' };
  });
  const s = makeSecrets({ exec, platform: 'darwin' });
  assert.equal(s.available(), true);
  assert.equal(s.set('anthropic', 'SEKRET'), true);
  const setCall = calls.find(c => c.args[0] === 'add-generic-password');
  assert.deepEqual(setCall.args, ['add-generic-password', '-U', '-s', 'smartmonkey', '-a', 'anthropic', '-w', 'SEKRET']);
  assert.equal(s.get('anthropic'), 'SEKRET');
  assert.ok(calls.some(c => c.args[0] === 'find-generic-password' && c.args.includes('anthropic')));
  assert.equal(s.delete('anthropic'), true);
  assert.ok(calls.some(c => c.args[0] === 'delete-generic-password'));
});

check('linux: value goes on stdin, not argv (secret-tool)', () => {
  const { exec, calls } = mockExec((cmd, args) => {
    if (args[0] === '--version') return { status: 0, stdout: '0.20' };   // probe
    if (args[0] === 'lookup') return { status: 0, stdout: 'V' };
    return { status: 0, stdout: '' };
  });
  const s = makeSecrets({ exec, platform: 'linux' });
  assert.equal(s.available(), true);
  s.set('openai', 'topsecret');
  const store = calls.find(c => c.args[0] === 'store');
  assert.equal(store.input, 'topsecret', 'value passed via stdin');
  assert.ok(!store.args.includes('topsecret'), 'value NOT on argv');
  assert.equal(s.get('openai'), 'V');
});

check('unavailable (win32 / failing probe) → in-memory fallback round-trips', () => {
  const s = makeSecrets({ exec: () => ({ status: null, stdout: '', stderr: '' }), platform: 'win32' });
  assert.equal(s.available(), false);
  assert.equal(s.get('x'), null);
  s.set('x', 'v');
  assert.equal(s.get('x'), 'v');
  s.delete('x');
  assert.equal(s.get('x'), null);
});

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nsecrets: all passed');
```

- [ ] **Step 2: Run to verify it fails**

Run: `node test/secrets.mjs`
Expected: FAIL — `Cannot find module '../secrets.mjs'`.

- [ ] **Step 3: Implement** — create `secrets.mjs`:

```js
/**
 * Secret storage for the persistent app: the OS keychain when available
 * (macOS `security`, Linux `secret-tool`), else an in-memory fallback for this
 * process. NEVER writes a plaintext file. Service name: "smartmonkey".
 * `exec` is injectable so this is testable without touching the real keychain.
 */
import { spawnSync } from 'node:child_process';

const SERVICE = 'smartmonkey';

export function defaultExec(cmd, args, { input } = {}) {
  const r = spawnSync(cmd, args, { input, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

export function makeSecrets({ exec = defaultExec, platform = process.platform } = {}) {
  const probe = platform === 'darwin' ? () => exec('security', ['help']).status === 0
    : platform === 'linux' ? () => exec('secret-tool', ['--version']).status === 0
    : () => false;
  const mode = probe() ? platform : 'memory';
  const mem = new Map();

  if (mode === 'darwin') {
    return {
      available: () => true,
      get(name) { const r = exec('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w']); return r.status === 0 ? r.stdout.replace(/\n$/, '') : null; },
      set(name, value) { return exec('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', name, '-w', value]).status === 0; },
      delete(name) { return exec('security', ['delete-generic-password', '-s', SERVICE, '-a', name]).status === 0; },
    };
  }
  if (mode === 'linux') {
    return {
      available: () => true,
      get(name) { const r = exec('secret-tool', ['lookup', 'service', SERVICE, 'account', name]); return r.status === 0 && r.stdout ? r.stdout.replace(/\n$/, '') : null; },
      set(name, value) { return exec('secret-tool', ['store', '--label=smartmonkey', 'service', SERVICE, 'account', name], { input: value }).status === 0; },
      delete(name) { return exec('secret-tool', ['clear', 'service', SERVICE, 'account', name]).status === 0; },
    };
  }
  return {
    available: () => false,
    get(name) { return mem.has(name) ? mem.get(name) : null; },
    set(name, value) { mem.set(name, value); return true; },
    delete(name) { mem.delete(name); return true; },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node test/secrets.mjs`
Expected: PASS.

- [ ] **Step 5: Wire into `npm test`** — set `package.json` `test`:

```json
"test": "node test/embed.mjs && node test/connectors.mjs && node test/secrets.mjs && node test/webask.mjs && node test/server.mjs",
```

(Some of those files don't exist yet — they arrive in later tasks. If executing 3a **before** the connectors plan, drop `test/connectors.mjs` from the line; otherwise keep it. The current on-disk `test` runs only `test/embed.mjs`, so add the ones this plan creates.)

Run: `node test/secrets.mjs` (the full `npm test` runs once all files exist, at Task 3).

- [ ] **Step 6: Commit**

```bash
git add secrets.mjs test/secrets.mjs package.json
git -c commit.gpgsign=false commit -m "$(printf 'feat(app): secrets.mjs — OS keychain with in-memory fallback\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01J8wrVY2enRpNmkBKLhYrWi')"
```

---

### Task 2: `webask.mjs` — the interview bridge

**Files:**
- Create: `webask.mjs`
- Create: `test/webask.mjs`

**Interfaces:**
- Produces:
  - `makeWebAsk(session, emit) → async ask(question, options?) : Promise<string>` — mints `id = 'ask_' + n`, sets `session.pendingAsk = { id, question, options, resolve }`, calls `emit('ask', { id, question, options })`, returns a promise pending until answered.
  - `answerAsk(session, id, answer) → boolean` — if `session.pendingAsk?.id === id`, clear it and resolve; else `false`.

- [ ] **Step 1: Write the failing test** — create `test/webask.mjs`:

```js
/**
 * webask.mjs — the ask()/answer() bridge, pure (no HTTP).
 *   node test/webask.mjs
 */
import { strict as assert } from 'node:assert';
const { makeWebAsk, answerAsk } = await import('../webask.mjs');

let failures = 0;
async function check(name, fn) { try { await fn(); console.log(`  ok  ${name}`); } catch (e) { failures++; console.error(`FAIL  ${name}: ${e.message}`); } }

await check('ask sets pendingAsk + emits, right id resolves, wrong id ignored', async () => {
  const session = {};
  const emitted = [];
  const ask = makeWebAsk(session, (type, data) => emitted.push({ type, data }));
  const p = ask('Which source?', ['Jira', 'Confluence']);
  assert.ok(session.pendingAsk && session.pendingAsk.id.startsWith('ask_'));
  assert.equal(emitted[0].type, 'ask');
  assert.deepEqual(emitted[0].data.options, ['Jira', 'Confluence']);
  assert.equal(answerAsk(session, 'ask_999', 'nope'), false);          // stale/wrong id ignored
  assert.ok(session.pendingAsk, 'still pending after a wrong id');
  assert.equal(answerAsk(session, session.pendingAsk.id, 'Confluence'), true);
  assert.equal(await p, 'Confluence');
  assert.equal(session.pendingAsk, null);
});

await check('free-text ask (no options) works', async () => {
  const session = {};
  const ask = makeWebAsk(session, () => {});
  const p = ask('Build command?');
  assert.equal(session.pendingAsk.options, undefined);
  answerAsk(session, session.pendingAsk.id, './gradlew assembleDebug');
  assert.equal(await p, './gradlew assembleDebug');
});

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nwebask: all passed');
```

- [ ] **Step 2: Run to verify it fails**

Run: `node test/webask.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `webask.mjs`:

```js
/**
 * The interview-over-web bridge. The agent's ask_user tool calls `ask`, which
 * parks a promise on the session and emits an SSE `ask` event; the browser POSTs
 * the answer to /api/answer, which calls `answerAsk` to resolve it. Because the
 * pending question lives on the session (and is exposed by /api/status), a
 * reloaded page can still see and answer it.
 */
export function makeWebAsk(session, emit) {
  let n = 0;
  return (question, options) => new Promise((resolve) => {
    const opts = Array.isArray(options) && options.length ? options : undefined;
    const id = 'ask_' + (++n);
    session.pendingAsk = { id, question: question || '', options: opts, resolve };
    emit('ask', { id, question: question || '', options: opts });
  });
}

export function answerAsk(session, id, answer) {
  const p = session.pendingAsk;
  if (!p || p.id !== id) return false;
  session.pendingAsk = null;
  p.resolve(typeof answer === 'string' ? answer : String(answer ?? ''));
  return true;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node test/webask.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add webask.mjs test/webask.mjs
git -c commit.gpgsign=false commit -m "$(printf 'feat(app): webask.mjs — SSE ask/answer interview bridge\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01J8wrVY2enRpNmkBKLhYrWi')"
```

---

### Task 3: `server.mjs` — createApp (routes, SSE, single-run session)

**Files:**
- Create: `server.mjs`
- Create: `test/server.mjs`

**Interfaces:**
- Consumes: `makeSecrets` (Task 1), `makeWebAsk`/`answerAsk` (Task 2), `embed` (`makeToolRunner`, `runAgent`, `resolveProvider`, `PROVIDERS`).
- Produces: `createApp({ cwd?, secrets?, modelFactory? }) → { server, session, listen(port) }`.
  - `modelFactory(provider, model, key) → callModel` (default `PROVIDERS[provider].make(key, model)`).
  - `listen(port) → Promise<number>` (actual port; `0` picks a free one).
  - Endpoints per the spec: `GET /`, static (`smartmonkey/` then bundled assets), `GET /api/status`, `POST /api/ai`, `POST /api/generate`, `GET /api/events` (SSE), `POST /api/answer`, `POST /api/stop`.

- [ ] **Step 1: Write the failing test** — create `test/server.mjs`:

```js
/**
 * server.mjs — the persistent app end to end, over 127.0.0.1, with a mock model
 * that runs the interview then writes blueprint.json. No external network.
 *   node test/server.mjs
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, existsSync } from 'node:fs';
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

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nserver: all passed');
```

- [ ] **Step 2: Run to verify it fails**

Run: `node test/server.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `server.mjs`:

```js
/**
 * The persistent local app server (stage 3a). Serves the app UI + the
 * smartmonkey/ dir, and runs the embedded blueprint agent, streaming its output
 * and interview over SSE. Single local user ⇒ one active run. Zero-dep.
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, readFileSync } from 'node:fs';
import { join, resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeWebAsk, answerAsk } from './webask.mjs';
import { makeSecrets } from './secrets.mjs';
import * as embed from './embed.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS = existsSync(join(__dirname, 'assets')) ? join(__dirname, 'assets') : resolve(__dirname, '../src/assets/blueprint-kit');
const PROMPT = () => readFileSync(join(ASSETS, 'smartmonkey-blueprint.md'), 'utf8');
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.md': 'text/markdown; charset=utf-8' };

const readBody = req => new Promise((res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch { res({}); } }); });
const sendJson = (res, obj, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const writeSse = (res, ev) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`);

export function createApp({ cwd = process.cwd(), secrets = makeSecrets(), modelFactory } = {}) {
  const KIT = join(resolve(cwd), 'smartmonkey');
  const make = modelFactory || ((provider, model, key) => embed.PROVIDERS[provider].make(key, model));
  const session = { status: 'idle', error: null, events: [], clients: new Set(), pendingAsk: null, ai: { provider: null, model: null }, key: null };

  const emit = (type, data) => { const ev = { type, data }; session.events.push(ev); for (const r of session.clients) writeSse(r, ev); };
  const ready = () => !!(session.ai.provider && session.key);

  const serveFile = (res, file) => {
    if (!existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    createReadStream(file).pipe(res);
  };

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method;

    if (path === '/api/status' && method === 'GET') {
      return sendJson(res, {
        ai: { provider: session.ai.provider, model: session.ai.model, ready: ready() },
        keychain: { available: secrets.available() },
        blueprint: { exists: existsSync(join(KIT, 'blueprint.json')) },
        run: { status: session.status, error: session.error },
        pendingAsk: session.pendingAsk ? { id: session.pendingAsk.id, question: session.pendingAsk.question, options: session.pendingAsk.options } : null,
      });
    }

    if (path === '/api/ai' && method === 'POST') {
      const body = await readBody(req);
      const provider = body.provider;
      if (!provider || !embed.PROVIDERS[provider]) return sendJson(res, { error: 'unknown provider' }, 400);
      session.ai.provider = provider;
      session.ai.model = body.model || embed.PROVIDERS[provider].defaultModel;
      if (body.key) { secrets.set(provider, body.key); session.key = body.key; }
      else { const loaded = secrets.get(provider); const r = embed.resolveProvider({ provider, key: loaded }); session.key = r.error ? null : r.key; }
      return sendJson(res, { ok: true, ready: ready(), keychain: { available: secrets.available() } });
    }

    if (path === '/api/generate' && method === 'POST') {
      if (session.status === 'running') return sendJson(res, { error: 'a run is already active' }, 409);
      if (!ready()) return sendJson(res, { error: 'AI not ready — set a provider + key first' }, 400);
      session.status = 'running'; session.error = null; session.events = []; session.pendingAsk = null;
      const webask = makeWebAsk(session, emit);
      const base = embed.makeToolRunner(cwd, webask);
      const runTool = async (name, input) => { emit('tool', { name, summary: input?.path || input?.query || input?.args?.join(' ') || '' }); return base(name, input); };
      const callModel = make(session.ai.provider, session.ai.model, session.key);
      embed.runAgent({ prompt: PROMPT(), callModel, runTool, onText: t => { if (t && t.trim()) emit('text', t); } })
        .then(() => { session.status = 'done'; emit('done', { blueprint: existsSync(join(KIT, 'blueprint.json')) }); })
        .catch(e => { session.status = 'error'; session.error = e.message; emit('error', { message: e.message }); });
      return sendJson(res, { ok: true }, 202);
    }

    if (path === '/api/events' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      for (const ev of session.events) writeSse(res, ev);
      session.clients.add(res);
      req.on('close', () => session.clients.delete(res));
      return;
    }

    if (path === '/api/answer' && method === 'POST') {
      const body = await readBody(req);
      return answerAsk(session, body.id, body.answer) ? sendJson(res, { ok: true }) : sendJson(res, { error: 'no matching pending question' }, 409);
    }

    if (path === '/api/stop' && method === 'POST') {
      if (session.pendingAsk) answerAsk(session, session.pendingAsk.id, '');   // unblock a waiting ask
      session.status = 'idle';
      return sendJson(res, { ok: true });
    }

    // static: '/' → app.html; else try the smartmonkey/ dir, then bundled assets
    if (method === 'GET') {
      if (path === '/' || path === '') return serveFile(res, join(ASSETS, 'app.html'));
      const rel = decodeURIComponent(path).replace(/^\/+/, '');
      const kitFile = join(KIT, rel);
      if (kitFile.startsWith(KIT) && existsSync(kitFile) && !statSync(kitFile).isDirectory()) return serveFile(res, kitFile);
      const assetFile = join(ASSETS, rel);
      if (assetFile.startsWith(ASSETS) && existsSync(assetFile) && !statSync(assetFile).isDirectory()) return serveFile(res, assetFile);
      res.writeHead(404); res.end('not found'); return;
    }

    res.writeHead(404); res.end('not found');
  }

  const server = createServer((req, res) => { handle(req, res).catch(e => { try { sendJson(res, { error: e.message }, 500); } catch {} }); });
  return { server, session, listen(port) { return new Promise(r => server.listen(port, '127.0.0.1', () => r(server.address().port))); } };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node test/server.mjs`
Expected: PASS — the interview streams over SSE, the answer resolves it, `blueprint.json` is written, the 2nd generate is `409`, and no response contains the key.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: `embed`, `secrets`, `webask`, `server` (and `connectors` if the CLI plan already landed) all green.

- [ ] **Step 6: Commit**

```bash
git add server.mjs test/server.mjs
git -c commit.gpgsign=false commit -m "$(printf 'feat(app): server.mjs — persistent app server (SSE, single run, keychain)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01J8wrVY2enRpNmkBKLhYrWi')"
```

---

### Task 4: `assets/app.html` — the UI

**Files:**
- Create: `assets/app.html`

**Interfaces:**
- Consumes: the server API (`/api/status`, `/api/ai`, `/api/generate`, `/api/events`, `/api/answer`).

- [ ] **Step 1: Create the UI** — create `assets/app.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>SmartMonkey</title>
<style>
  :root { --bg:#0f1115; --card:#171a21; --border:#2a2f3a; --text:#e6e8ec; --muted:#9aa3b2; --primary:#3ddc97; --primary-ink:#06281c; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 24px 16px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: var(--muted); margin: 0 0 20px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:16px; margin-bottom:16px; }
  label { display:block; font-size:13px; color:var(--muted); margin:10px 0 4px; }
  select, input { width:100%; padding:9px 10px; background:#0d0f14; border:1px solid var(--border); border-radius:8px; color:var(--text); }
  button { padding:9px 14px; border:0; border-radius:8px; background:var(--primary); color:var(--primary-ink); font-weight:600; cursor:pointer; }
  button[disabled] { opacity:.5; cursor:not-allowed; }
  .row { display:flex; gap:10px; align-items:flex-end; }
  .row > div { flex:1; }
  .status { font-size:12px; color:var(--muted); margin-top:8px; }
  #log { background:#0d0f14; border:1px solid var(--border); border-radius:8px; padding:12px; height:280px; overflow:auto; white-space:pre-wrap; font:13px/1.5 ui-monospace,Menlo,monospace; }
  .ask { border:1px solid var(--primary); border-radius:8px; padding:12px; margin:10px 0; }
  .ask .opts label { display:flex; align-items:center; gap:8px; color:var(--text); margin:6px 0; }
  .ask .opts input { width:auto; }
  a { color: var(--primary); }
  .hide { display:none; }
</style>
</head>
<body>
<div class="wrap">
  <h1>SmartMonkey</h1>
  <p class="sub">Blueprint your app for AI QA — locally, with your own AI. Nothing but the blueprint you approve leaves this machine.</p>

  <div class="card">
    <b>1 · Your AI</b>
    <div class="row">
      <div>
        <label>Provider</label>
        <select id="provider">
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI</option>
          <option value="gemini">Gemini</option>
        </select>
      </div>
      <div>
        <label>Model</label>
        <input id="model" placeholder="(default)" />
      </div>
    </div>
    <label>API key <span id="kc" class="status"></span></label>
    <div class="row">
      <div><input id="key" type="password" placeholder="sk-… (stored in your OS keychain)" /></div>
      <button id="saveKey">Save</button>
    </div>
    <div class="status" id="aiStatus"></div>
  </div>

  <div class="card">
    <b>2 · Build the blueprint</b>
    <p class="sub">Reads your repo, interviews you below, and writes <code>smartmonkey/blueprint.json</code>.</p>
    <button id="gen" disabled>Build blueprint</button>
    <div id="asks"></div>
    <label style="margin-top:14px">Progress</label>
    <div id="log"></div>
    <p id="doneMsg" class="status hide">Done — <a href="/view.html" target="_blank">review &amp; edit the blueprint →</a></p>
  </div>
</div>

<script>
const $ = id => document.getElementById(id);
const api = (method, path, body) => fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }).then(r => r.json().catch(() => ({})));
function logLine(t) { const el = $('log'); el.textContent += t.endsWith('\n') ? t : t + '\n'; el.scrollTop = el.scrollHeight; }

async function refresh() {
  const s = await api('GET', '/api/status');
  $('kc').textContent = s.keychain.available ? '· saved in OS keychain' : '· keychain unavailable, kept for this session only';
  $('aiStatus').textContent = s.ai.ready ? `Ready: ${s.ai.provider} · ${s.ai.model}` : 'Set a provider + key to enable Build.';
  $('gen').disabled = !s.ai.ready || s.run.status === 'running';
  if (s.blueprint.exists) $('doneMsg').classList.remove('hide');
  if (s.pendingAsk) renderAsk(s.pendingAsk);
}

$('saveKey').onclick = async () => {
  await api('POST', '/api/ai', { provider: $('provider').value, model: $('model').value || undefined, key: $('key').value || undefined });
  $('key').value = '';
  refresh();
};
$('provider').onchange = () => api('POST', '/api/ai', { provider: $('provider').value, model: $('model').value || undefined }).then(refresh);

$('gen').onclick = async () => {
  $('log').textContent = ''; $('asks').innerHTML = ''; $('doneMsg').classList.add('hide');
  await api('POST', '/api/generate');
  refresh();
};

function renderAsk(a) {
  if (document.getElementById('ask-' + a.id)) return;
  const box = document.createElement('div'); box.className = 'ask'; box.id = 'ask-' + a.id;
  const q = document.createElement('div'); q.textContent = a.question; box.appendChild(q);
  let getVal;
  if (a.options && a.options.length) {
    const opts = document.createElement('div'); opts.className = 'opts';
    a.options.forEach((o, i) => {
      const l = document.createElement('label');
      const r = document.createElement('input'); r.type = 'radio'; r.name = a.id; r.value = o; if (i === 0) r.checked = true;
      l.appendChild(r); l.appendChild(document.createTextNode(o)); opts.appendChild(l);
    });
    box.appendChild(opts);
    getVal = () => (box.querySelector('input:checked') || {}).value || a.options[0];
  } else {
    const inp = document.createElement('input'); inp.placeholder = 'Your answer'; box.appendChild(inp);
    getVal = () => inp.value;
  }
  const btn = document.createElement('button'); btn.textContent = 'Answer';
  btn.onclick = async () => { btn.disabled = true; await api('POST', '/api/answer', { id: a.id, answer: getVal() }); box.remove(); };
  box.appendChild(document.createElement('br')); box.appendChild(btn);
  $('asks').appendChild(box);
}

const es = new EventSource('/api/events');
es.addEventListener('text', e => logLine(JSON.parse(e.data)));
es.addEventListener('tool', e => { const d = JSON.parse(e.data); logLine(`· ${d.name} ${d.summary || ''}`); });
es.addEventListener('ask', e => renderAsk(JSON.parse(e.data)));
es.addEventListener('done', e => { logLine('\n✓ Done.'); refresh(); });
es.addEventListener('error', e => { try { logLine('\n✗ ' + JSON.parse(e.data).message); } catch {} });

refresh();
</script>
</body>
</html>
```

- [ ] **Step 2: Manual smoke (real browser, spends nothing without a key)**

Run: `node cli.mjs app --port 8899` (Task 5 adds the command; if doing Task 4 first, temporarily `node -e "import('./server.mjs').then(m=>m.createApp().listen(8899))"`).
Open `http://127.0.0.1:8899`. Verify: the page loads, provider/model/key fields render, "Build blueprint" is disabled until a key is saved, and the keychain status line reflects your OS. (Do not run a real build unless you want to spend a key.)

- [ ] **Step 3: Commit**

```bash
git add assets/app.html
git -c commit.gpgsign=false commit -m "$(printf 'feat(app): assets/app.html — setup + generate + in-browser interview UI\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01J8wrVY2enRpNmkBKLhYrWi')"
```

---

### Task 5: `cli.mjs` — the `app` command

**Files:**
- Modify: `cli.mjs`

**Interfaces:**
- Consumes: `server.mjs` `createApp`; existing `openBrowser`, `ensureScaffold`, `opt`.

- [ ] **Step 1: Add `cmdApp()`** — add this function in `cli.mjs` (e.g. after `cmdCheck`):

```js
async function cmdApp() {
  ensureScaffold();                       // so view.html/blueprint.json render for review
  const { createApp } = await import('./server.mjs');
  const app = createApp({ cwd: process.cwd() });
  const port = await app.listen(Number(opt('port')) || 8899);
  const url = `http://127.0.0.1:${port}/`;
  console.log(`SmartMonkey app: ${url}  (Ctrl-C to stop)`);
  openBrowser(url);
}
```

- [ ] **Step 2: Route it + list in help** — in the `switch (cmd)` block, add before `default`:

```js
  case 'app': cmdApp().catch(e => { console.error(e.message); process.exit(2); }); break;
```

In `help()`, add near the top of the command list (after the intro line):

```
  smartmonkey app [--port N]   run the local app (setup + build the blueprint in your browser)
```

- [ ] **Step 3: Verify by hand**

Run:
```bash
node cli.mjs app --port 8912 &
sleep 1
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8912/           # 200
curl -s http://127.0.0.1:8912/api/status | head -c 200; echo             # JSON with ai/keychain/blueprint/run
kill %1
node cli.mjs run --key sk-ant-x --dry-run                                 # unchanged blueprint run line
node cli.mjs                                                              # still prints help (bare unchanged)
```
Expected: `/` → 200; `/api/status` → JSON; `run --dry-run` unchanged; bare `smartmonkey` still prints help (now listing `app`).

- [ ] **Step 4: Commit**

```bash
git add cli.mjs
git -c commit.gpgsign=false commit -m "$(printf 'feat(cli): smartmonkey app — launch the persistent local app\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01J8wrVY2enRpNmkBKLhYrWi')"
```

---

### Task 6: Docs — README + stage status

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the app to the command list** — under the `npx` block:

```
npx smartmonkey-client app        # run the local app: set your AI, build the blueprint in your browser
```

- [ ] **Step 2: Add a short "The app" section** — after "The AI runs on your side":

```markdown
## The app

`smartmonkey app` starts a small local web app (in your browser, on your machine).
Pick your AI provider and paste your key once — it's stored in your OS keychain —
then click **Build blueprint**: it reads your repo and interviews you right in the
page (real dropdowns/checkboxes), and writes `smartmonkey/blueprint.json` for you
to review. Nothing but the blueprint you approve leaves your machine. The app runs
in the foreground; Ctrl-C to stop.
```

- [ ] **Step 3: Bump the Status line**

```markdown
Stage 3a of the SmartMonkey local client (a persistent local app: set your AI +
build the blueprint from the browser, with the interview in-page and secrets in
the OS keychain), on top of the CLI + embedded API-key mode across
Anthropic / OpenAI / Gemini. Dev builds read the kit assets from the organiclaw
repo; a published package bundles its own `assets/`.
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git -c commit.gpgsign=false commit -m "$(printf 'docs: document smartmonkey app (persistent local app, 3a)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01J8wrVY2enRpNmkBKLhYrWi')"
```

---

## Final verification

- [ ] `npm test` — `embed`, `secrets`, `webask`, `server` all green (plus `connectors` if that plan landed).
- [ ] `node cli.mjs app --port 8912` serves `/` (200) and `/api/status` (JSON); Ctrl-C stops it.
- [ ] Bare `node cli.mjs` still prints help (now listing `app`); `run --dry-run` unchanged.
- [ ] Optional real smoke (spends a key): `smartmonkey app`, save an Anthropic key (confirm it lands in the keychain: macOS `security find-generic-password -s smartmonkey -a anthropic -w`), click Build, answer the interview in the browser, confirm `smartmonkey/blueprint.json` appears and the review link opens.

## Notes for the executor

- **Do not modify `cmdRun`/`runEmbedded`/`runViaCli`/`serve`/`cmdCheck`/`scaffold`.** 3a is additive — only new files plus the `app` command + a help line.
- **Never read the keychain on a `/api/status` poll** — `status` derives `ready` from the in-memory `session.key` (+ what `/api/ai` resolved), so a polling UI can't trigger repeated keychain prompts.
- The `POST /api/stop` is best-effort: `runAgent` has no abort, so stop unblocks a waiting interview (answers it with `''`) and marks the session idle; an in-flight model turn may still complete in the background. Acceptable for a local single-user tool; a real cancel is a later enhancement.
- `assets/app.html` is client-owned and NOT part of the organiclaw asset sync (the server-side product has no such app).
