# Case Import & Connectors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `smartmonkey cases` — convert existing test cases (from local exports/pastes and from Confluence) into `smartmonkey/cases.json` using the owner's own AI, entirely on their machine.

**Architecture:** A `Source` seam (`connectors.mjs`) fetches/reads cases and **stages** them as normalized text under `smartmonkey/import/<source>/`. Then the existing sandboxed agent loop (`embed.mjs`) — embedded provider *or* logged-in CLI — reads `import/**` + `blueprint.json` and writes `cases.json`. Two sources ship: `fileSource` (universal) and `confluenceSource` (API token). The proven `run` path is left untouched; `cases` is added alongside it.

**Tech Stack:** Node ≥ 18, ESM, zero runtime dependencies (node builtins + an injectable `fetch`). Anthropic/OpenAI/Gemini via the existing `PROVIDERS` registry.

**Spec:** `docs/specs/2026-09-21-case-import-connectors-design.md`

## Global Constraints

- **Zero runtime dependencies** — node builtins only; network via an injectable `fetch` (default `globalThis.fetch`).
- **Node ≥ 18, ESM** — `import`, top-level `await` in tests is fine.
- **No secret written to disk** — the Atlassian token is read from flags/env and never persisted by the tool (same rule as the AI `--key`).
- **Privacy** — the customer's content stays local under `smartmonkey/import/`; only the reviewed `cases.json` is shared. Nothing copies source into outputs.
- **Don't touch the working `run`/`runEmbedded`/`runViaCli` path** — add `cases` alongside; minor duplication is acceptable to keep `run` stable.
- **Tests are mock-based** — no live token, no live model, no network. Each `test/*.mjs` self-reports and `process.exit(1)` on failure.
- **Commits** — client repo has no commit signing configured; use `git -c commit.gpgsign=false commit`. End every commit message with:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01J8wrVY2enRpNmkBKLhYrWi
  ```

## File Structure

- `connectors.mjs` (new) — the `Source` seam: `resolveConnector`, `stageText`, `IMPORT_EXTS`, `fileSource`, `extractPageId`, `confluenceSource`. One responsibility: turn a source into staged text under `smartmonkey/import/`.
- `embed.mjs` (modify) — thread an optional `system` into the three caller factories; add `CASES_SYSTEM` and `producedCases`.
- `assets/smartmonkey-cases.md` (new) — the conversion prompt (user-message instructions + the compact case schema). Client-owned; not in the organiclaw asset sync.
- `cli.mjs` (modify) — `opts()` (repeatable flags), `cmdCases()`, routing, `.gitignore` in `scaffold()`, help text.
- `test/connectors.mjs` (new) — resolveConnector, fileSource, confluenceSource, extractPageId.
- `test/embed.mjs` (modify) — system-threading + `producedCases` + `CASES_SYSTEM` presence.
- `package.json` (modify) — `test` runs both test files.
- `README.md` (modify) — document `cases`; bump the stage line.

---

### Task 1: `connectors.mjs` — module skeleton + `resolveConnector`

**Files:**
- Create: `connectors.mjs`
- Create: `test/connectors.mjs`
- Modify: `package.json` (test script)

**Interfaces:**
- Produces: `resolveConnector({ flags?, env? }) → { site, email, token, base } | { error }` where `flags` is `{ site?, email?, token? }`, `site` is normalized to a host (`acme` → `acme.atlassian.net`), and `base` is `https://<host>/wiki/rest/api`.

- [ ] **Step 1: Write the failing test** — create `test/connectors.mjs`:

```js
/**
 * Case-source connectors (stage 3) — resolveConnector, fileSource,
 * confluenceSource. All mock-based: no live token, no network.
 *   node test/connectors.mjs
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const C = await import('../connectors.mjs');

let failures = 0;
async function check(name, fn) { try { await fn(); console.log(`  ok  ${name}`); } catch (e) { failures++; console.error(`FAIL  ${name}: ${e.message}`); } }

await check('resolveConnector: flags win, env fallback, site normalized, missing-field errors', () => {
  const r = C.resolveConnector({ flags: { site: 'acme', email: 'a@b.co', token: 't' } });
  assert.equal(r.site, 'acme.atlassian.net');
  assert.equal(r.base, 'https://acme.atlassian.net/wiki/rest/api');
  assert.equal(C.resolveConnector({ flags: { site: 'acme.atlassian.net', email: 'a@b.co', token: 't' } }).site, 'acme.atlassian.net');
  assert.equal(C.resolveConnector({ env: { SMARTMONKEY_ATLASSIAN_SITE: 'x', SMARTMONKEY_ATLASSIAN_EMAIL: 'e', SMARTMONKEY_ATLASSIAN_TOKEN: 'tok' } }).site, 'x.atlassian.net');
  assert.match(C.resolveConnector({ flags: { site: 'acme' }, env: {} }).error, /email/);
  assert.match(C.resolveConnector({ env: {} }).error, /site/);
});

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nconnectors: all passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/connectors.mjs`
Expected: FAIL — `Cannot find module '../connectors.mjs'`.

- [ ] **Step 3: Write minimal implementation** — create `connectors.mjs`:

```js
/**
 * Case-source connectors (stage 3). A Source fetches/reads existing test cases
 * and STAGES them as normalized text under smartmonkey/import/<name>/, so ONE
 * conversion path (embedded agent or logged-in CLI) can turn them into
 * cases.json. The customer's content stays local; only the reviewed cases.json
 * is ever shared. Zero dependencies (node builtins + an injectable fetch).
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join, extname, basename } from 'node:path';

const IGNORE = /(^|\/)(\.git|node_modules|build|dist|\.gradle|\.idea|smartmonkey)(\/|$)/;
export const IMPORT_EXTS = new Set(['.html', '.htm', '.csv', '.md', '.txt', '.json', '.xml']);

/** Resolve Confluence creds from flags then env; normalize the site to a host. */
export function resolveConnector({ flags = {}, env = process.env } = {}) {
  const site = flags.site || env.SMARTMONKEY_ATLASSIAN_SITE;
  const email = flags.email || env.SMARTMONKEY_ATLASSIAN_EMAIL;
  const token = flags.token || env.SMARTMONKEY_ATLASSIAN_TOKEN;
  const missing = [];
  if (!site) missing.push('site (--confluence-site / SMARTMONKEY_ATLASSIAN_SITE)');
  if (!email) missing.push('email (--confluence-email / SMARTMONKEY_ATLASSIAN_EMAIL)');
  if (!token) missing.push('token (--confluence-token / SMARTMONKEY_ATLASSIAN_TOKEN)');
  if (missing.length) return { error: `Confluence needs: ${missing.join(', ')}` };
  const host = /\./.test(site) ? site : `${site}.atlassian.net`;
  return { site: host, email, token, base: `https://${host}/wiki/rest/api` };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/connectors.mjs`
Expected: PASS — `connectors: all passed`.

- [ ] **Step 5: Wire it into `npm test`** — in `package.json`, change the `test` script:

```json
"scripts": {
  "test": "node test/embed.mjs && node test/connectors.mjs"
},
```

Run: `npm test`
Expected: both test files pass.

- [ ] **Step 6: Commit**

```bash
git add connectors.mjs test/connectors.mjs package.json
git -c commit.gpgsign=false commit -m "$(printf 'feat(connectors): resolveConnector + module skeleton\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01J8wrVY2enRpNmkBKLhYrWi')"
```

---

### Task 2: `fileSource` + `stageText`

**Files:**
- Modify: `connectors.mjs`
- Modify: `test/connectors.mjs`

**Interfaces:**
- Consumes: `IMPORT_EXTS` (Task 1).
- Produces:
  - `stageText(root, source, name, text) → absolutePath` — writes `<root>/smartmonkey/import/<source>/<name>`, creating dirs.
  - `fileSource(paths: string[]) → { name: 'files', collect({ root }) → Promise<{ files: string[], label: string }> }` — stages supported text files (a file, or a directory walked recursively, skipping `IGNORE` dirs and non-`IMPORT_EXTS` files).

- [ ] **Step 1: Write the failing test** — append to `test/connectors.mjs` before the final `if (failures)` block:

```js
await check('fileSource: stages supported text files (recursing dirs), skips binaries, throws on missing path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sm-conn-'));
  const src = join(root, 'exports'); mkdirSync(join(src, 'sub'), { recursive: true });
  writeFileSync(join(src, 'cases.csv'), 'id,title\n1,Login');
  writeFileSync(join(src, 'sub', 'more.html'), '<table><tr><td>Step</td></tr></table>');
  writeFileSync(join(src, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const s = C.fileSource([src]);
  const r = await s.collect({ root });
  assert.equal(r.files.length, 2, 'two text files staged, png skipped');
  const staged = readdirSync(join(root, 'smartmonkey', 'import', 'files'));
  assert.ok(staged.some(f => f.endsWith('.csv')) && staged.some(f => f.endsWith('.html')));
  assert.match(readFileSync(r.files.find(f => f.endsWith('.csv')), 'utf8'), /Login/);
  assert.match(r.label, /2 file/);
  await assert.rejects(C.fileSource(['/no/such/path']).collect({ root }), /not found/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/connectors.mjs`
Expected: FAIL — `C.fileSource is not a function`.

- [ ] **Step 3: Write minimal implementation** — append to `connectors.mjs`:

```js
/** Write normalized text into smartmonkey/import/<source>/<name>; return the path. */
export function stageText(root, source, name, text) {
  const dir = join(resolve(root), 'smartmonkey', 'import', source);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
}

const slug = s => (String(s || 'item').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'item');

/** FileSource: stage supported text files the user points at (files or dirs). */
export function fileSource(paths) {
  return {
    name: 'files',
    async collect({ root }) {
      const staged = []; let skipped = 0;
      const consider = abs => {
        const ext = extname(abs).toLowerCase();
        if (!IMPORT_EXTS.has(ext)) { skipped++; return; }
        staged.push(stageText(root, 'files', `${slug(basename(abs, ext))}${ext}`, readFileSync(abs, 'utf8')));
      };
      const walk = dir => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (IGNORE.test('/' + e.name)) continue;
          const abs = join(dir, e.name);
          e.isDirectory() ? walk(abs) : consider(abs);
        }
      };
      for (const p of paths) {
        const abs = resolve(p);
        if (!existsSync(abs)) throw new Error(`--import path not found: ${p}`);
        statSync(abs).isDirectory() ? walk(abs) : consider(abs);
      }
      return { files: staged, label: `${staged.length} file(s)${skipped ? `, ${skipped} skipped` : ''}` };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/connectors.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add connectors.mjs test/connectors.mjs
git -c commit.gpgsign=false commit -m "$(printf 'feat(connectors): fileSource + stageText (universal import)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01J8wrVY2enRpNmkBKLhYrWi')"
```

---

### Task 3: `confluenceSource` + `extractPageId`

**Files:**
- Modify: `connectors.mjs`
- Modify: `test/connectors.mjs`

**Interfaces:**
- Consumes: `stageText`, `resolveConnector`'s output shape `{ site, email, token, base }`.
- Produces:
  - `extractPageId(target: string) → string | null` — the numeric id from a `/pages/<id>/…` URL, or `target` if it's all digits, else `null` (treat as a space key).
  - `confluenceSource(targets: string[], creds, { fetch? }) → { name: 'confluence', collect({ root }) → Promise<{ files, label }> }` — for each target: a page id/URL → one `GET /content/<id>?expand=body.storage`; otherwise a space key → `GET /content?spaceKey=…&type=page&status=current&expand=body.storage&limit=50` following `_links.next`. Each page staged as `import/confluence/<id>-<slug>.md` = `# <title>\n\n<body.storage.value>`. Basic auth `base64(email:token)`.

- [ ] **Step 1: Write the failing test** — append to `test/connectors.mjs`:

```js
await check('extractPageId: URL, bare id, or null for a space key', () => {
  assert.equal(C.extractPageId('https://acme.atlassian.net/wiki/spaces/QA/pages/123456/Login'), '123456');
  assert.equal(C.extractPageId('789'), '789');
  assert.equal(C.extractPageId('QA'), null);
});

await check('confluenceSource: Basic auth, space pagination + page-id fetch, staged content', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sm-conf-'));
  const creds = C.resolveConnector({ flags: { site: 'acme', email: 'a@b.co', token: 'tok' } });
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, auth: opts.headers.authorization });
    if (url.includes('spaceKey=QA') && !url.includes('start=')) return json({ results: [page('1', 'Login')], _links: { next: '/wiki/rest/api/content?spaceKey=QA&start=50' } });
    if (url.includes('start=50')) return json({ results: [page('2', 'Logout')], _links: {} });
    if (url.includes('/content/123')) return json(page('123', 'Checkout'));
    throw new Error('unexpected url ' + url);
  };
  const s = C.confluenceSource(['QA', 'https://acme.atlassian.net/wiki/spaces/QA/pages/123/Checkout'], creds, { fetch: fakeFetch });
  const r = await s.collect({ root });
  assert.equal(r.files.length, 3, 'two space pages + one page-id');
  assert.equal(calls[0].auth, 'Basic ' + Buffer.from('a@b.co:tok').toString('base64'));
  assert.match(readFileSync(r.files.find(f => f.includes('123-')), 'utf8'), /# Checkout/);
  function json(body) { return { ok: true, json: async () => body }; }
  function page(id, title) { return { id, title, body: { storage: { value: `<p>${title} steps</p>` } } }; }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/connectors.mjs`
Expected: FAIL — `C.extractPageId is not a function`.

- [ ] **Step 3: Write minimal implementation** — append to `connectors.mjs`:

```js
export function extractPageId(target) {
  const m = String(target).match(/\/pages\/(\d+)/);
  if (m) return m[1];
  return /^\d+$/.test(String(target)) ? String(target) : null;
}

/** ConfluenceSource: fetch pages by space key or page URL/id; stage each as md. */
export function confluenceSource(targets, creds, { fetch = globalThis.fetch } = {}) {
  const auth = 'Basic ' + Buffer.from(`${creds.email}:${creds.token}`).toString('base64');
  const headers = { authorization: auth, accept: 'application/json' };
  const get = async url => {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Confluence ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  };
  const stagePage = (root, p) =>
    stageText(root, 'confluence', `${p.id}-${slug(p.title)}.md`, `# ${p.title}\n\n${p.body?.storage?.value || ''}`);
  return {
    name: 'confluence',
    async collect({ root }) {
      const staged = [];
      for (const t of targets) {
        const id = extractPageId(t);
        if (id) {
          staged.push(stagePage(root, await get(`${creds.base}/content/${id}?expand=body.storage`)));
          continue;
        }
        let url = `${creds.base}/content?spaceKey=${encodeURIComponent(t)}&type=page&status=current&expand=body.storage&limit=50`;
        for (let guard = 0; url && guard < 100; guard++) {
          const data = await get(url);
          for (const p of data.results || []) staged.push(stagePage(root, p));
          const next = data._links?.next;
          url = next ? new URL(next, `https://${creds.site}`).href : null;
        }
      }
      return { files: staged, label: `${staged.length} Confluence page(s)` };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/connectors.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add connectors.mjs test/connectors.mjs
git -c commit.gpgsign=false commit -m "$(printf 'feat(connectors): confluenceSource (REST v1, token auth, pagination)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01J8wrVY2enRpNmkBKLhYrWi')"
```

---

### Task 4: `embed.mjs` — thread `system`, add `CASES_SYSTEM` + `producedCases`

**Files:**
- Modify: `embed.mjs`
- Modify: `test/embed.mjs`

**Interfaces:**
- Consumes: existing `SYSTEM`, `toOpenAI`, `toGemini`, `PROVIDERS`, `runAgent`.
- Produces:
  - `makeAnthropicCaller(apiKey, model?, system?=SYSTEM)`, `makeOpenAICaller(apiKey, model?, system?=SYSTEM)`, `makeGeminiCaller(apiKey, model?, system?=SYSTEM)` — a 3rd optional `system` argument used in the request (default unchanged, so `run` is unaffected). `PROVIDERS[id].make(key, model, system)` therefore accepts a system.
  - `CASES_SYSTEM: string` — the system message for conversion runs (produce `cases.json`, never copy source).
  - `producedCases(cwd) → boolean` — whether `<cwd>/smartmonkey/cases.json` exists.

- [ ] **Step 1: Write the failing test** — add to `test/embed.mjs` (import `CASES_SYSTEM`, `producedCases`, `makeAnthropicCaller` in the top `await import`, then add checks before the final `if (failures)` block):

```js
await check('provider callers thread a custom system; CASES_SYSTEM + producedCases exist', async () => {
  assert.match(CASES_SYSTEM, /cases\.json/);
  assert.match(CASES_SYSTEM, /never|source/i);
  const dir2 = mkdtempSync(join(tmpdir(), 'sm-cases-'));
  assert.equal(producedCases(dir2), false);
  mkdirSync(join(dir2, 'smartmonkey'), { recursive: true });
  writeFileSync(join(dir2, 'smartmonkey', 'cases.json'), '[]');
  assert.equal(producedCases(dir2), true);

  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => { seen.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }) }; };
  try {
    const call = makeAnthropicCaller('k', 'claude-sonnet-5', 'CUSTOM-SYS');
    await call([{ role: 'user', content: 'hi' }], []);
  } finally { globalThis.fetch = realFetch; }
  assert.equal(seen[0].system, 'CUSTOM-SYS', 'the custom system was sent, not the default');
});
```

Update the top import line of `test/embed.mjs` to include the new names:

```js
const { makeToolRunner, runAgent, toOpenAI, fromOpenAI, toGemini, fromGemini, resolveProvider, PROVIDERS, makeAnthropicCaller, CASES_SYSTEM, producedCases } = await import('../embed.mjs');
```

Also ensure `mkdirSync` is imported at the top of `test/embed.mjs` (it already imports `mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync`).

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/embed.mjs`
Expected: FAIL — `CASES_SYSTEM` is undefined / `producedCases is not a function`.

- [ ] **Step 3: Write minimal implementation** — in `embed.mjs`:

Add the optional `system` param to each factory. Anthropic:

```js
export function makeAnthropicCaller(apiKey, model = 'claude-sonnet-5', system = SYSTEM) {
  return async (messages, tools) => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 8192, system, messages, tools }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 400)}`);
    return res.json();
  };
}
```

OpenAI — signature `(apiKey, model = 'gpt-5-mini', system = SYSTEM)` and change the body build to `const req = toOpenAI(system, messages, tools);` (was `toOpenAI(SYSTEM, …)`).

Gemini — signature `(apiKey, model = 'gemini-flash-latest', system = SYSTEM)` and `const body = toGemini(system, messages, tools);` (was `toGemini(SYSTEM, …)`).

Then add near `producedBlueprint`:

```js
export const CASES_SYSTEM = `You are SmartMonkey's case converter, running as a LOCAL tool inside the user's repository on their own machine. Existing test cases have been staged as text under smartmonkey/import/. Read every file there, and read smartmonkey/blueprint.json if it exists. Produce smartmonkey/cases.json by calling write_file — that is the only way to save your result; do not print the JSON. Never write anything except under smartmonkey/. The user's source must never appear in the output: no file paths, no pasted code — only the test behaviour, described in words. When the blueprint is present, map each case's preconditions to the blueprint's states via the case "requires" field where they clearly match; otherwise omit "requires". Follow the case schema given in the user's message exactly.`;

export function producedCases(cwd) { return existsSync(join(resolve(cwd), 'smartmonkey', 'cases.json')); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/embed.mjs`
Expected: PASS. Then `npm test` — both files green (the existing provider-translator tests must still pass, since `toOpenAI`/`toGemini` are unchanged and the default `system` preserves behavior).

- [ ] **Step 5: Commit**

```bash
git add embed.mjs test/embed.mjs
git -c commit.gpgsign=false commit -m "$(printf 'feat(embed): CASES_SYSTEM + producedCases + optional per-call system\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01J8wrVY2enRpNmkBKLhYrWi')"
```

---

### Task 5: `assets/smartmonkey-cases.md` — the conversion prompt + a conversion-contract test

**Files:**
- Create: `assets/smartmonkey-cases.md`
- Modify: `test/embed.mjs`

**Interfaces:**
- Consumes: `runAgent`, `makeToolRunner` (existing), `producedCases` (Task 4).
- Produces: the bundled conversion prompt file. The `cases` command (Task 6) reads it from `assets/`.

- [ ] **Step 1: Write the failing test** — add to `test/embed.mjs` a mock-model conversion run proving the contract (reads `import/**` + `blueprint.json`, writes `cases.json`):

```js
await check('conversion contract: the agent reads import/ + blueprint and writes cases.json (mock model)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sm-conv-'));
  mkdirSync(join(dir, 'smartmonkey', 'import', 'files'), { recursive: true });
  writeFileSync(join(dir, 'smartmonkey', 'import', 'files', 'cases.csv'), 'id,title,steps\n1,Login,"open app; enter creds; tap Sign in"');
  writeFileSync(join(dir, 'smartmonkey', 'blueprint.json'), JSON.stringify({ smartmonkeyBlueprint: 1, states: ['logged_out'] }));
  const runTool = makeToolRunner(dir, async () => 'n/a');
  let turn = 0; const readBack = [];
  const callModel = async (messages) => {
    const last = messages[messages.length - 1];
    if (last.role === 'user' && Array.isArray(last.content)) readBack.push(last.content.map(c => c.content).join(' | '));
    turn++;
    if (turn === 1) return { content: [{ type: 'tool_use', id: 'a', name: 'list_dir', input: { path: 'smartmonkey/import/files' } }], stop_reason: 'tool_use' };
    if (turn === 2) return { content: [{ type: 'tool_use', id: 'b', name: 'read_file', input: { path: 'smartmonkey/import/files/cases.csv' } }], stop_reason: 'tool_use' };
    if (turn === 3) return { content: [{ type: 'tool_use', id: 'c', name: 'write_file', input: { path: 'smartmonkey/cases.json', contents: JSON.stringify([{ id: 'TC-1', title: 'Login', steps: [{ do: 'open app' }] }]) } }], stop_reason: 'tool_use' };
    return { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' };
  };
  const res = await runAgent({ prompt: 'convert the staged cases', callModel, runTool, maxTurns: 10 });
  assert.equal(res.done, true);
  assert.equal(producedCases(dir), true);
  assert.ok(readBack.some(s => /Login/.test(s)), 'the staged csv was read back to the model');
});
```

Add `runAgent` to the top import if not already present (it is).

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/embed.mjs`
Expected: FAIL — the write is allowed (`smartmonkey/*.json`) so this should actually PASS on the existing sandbox; if it fails it's because `producedCases`/import wiring is wrong. (If it passes immediately, that's fine — it locks the contract; proceed to write the asset.)

- [ ] **Step 3: Write the conversion prompt** — create `assets/smartmonkey-cases.md`:

```markdown
# Convert existing test cases → smartmonkey/cases.json

You are converting the customer's EXISTING test cases into SmartMonkey's
`cases.json`, on their machine. Their source code and their raw case documents
never leave the machine — only the `cases.json` they approve is shared.

## What to read

1. Every file under `smartmonkey/import/` — these are the customer's existing
   test cases, staged as text (CSV, HTML tables, Markdown, exported pages).
   Parse them as best you can: each is one or more test cases with a title and
   ordered steps, sometimes an expected result, priority, or preconditions.
2. `smartmonkey/blueprint.json` if it exists — the app's behavioural blueprint.
   Use its `states` to fill each case's `requires` (see below) when a case's
   precondition clearly matches a state; otherwise omit `requires`.

Do NOT read or reference the app's source code. Do NOT copy file paths, code, or
raw document markup into the output — only the test behaviour, in plain words.

## What to write

Call `write_file` with path `smartmonkey/cases.json` and a JSON ARRAY of cases.
That call is the only way to save your result; do not print the JSON. Each case:

- `id` (string, required) — a stable id. Reuse the source's id/key when present
  (e.g. "TC-014"); otherwise generate `TC-1`, `TC-2`, … in order.
- `title` (string, required) — a short human title.
- `steps` (array, required unless you use `goal`) — ordered `{ do, expect? }`:
  `do` is one imperative UI action in plain words; `expect` (optional) is what
  should then be observable.
- `goal` + `expected` (strings) — use INSTEAD of `steps` only when the source
  case is an outcome, not an ordered script.
- `priority` (optional) — "high" | "medium" | "low", mapped from the source.
- `tags` (optional array of strings) — carry over labels/components.
- `requires` (optional string) — a precondition state that must hold before the
  case runs, taken from the blueprint's `states` (e.g. "logged_in", "fresh")
  when the source's precondition clearly matches one. Omit when unsure.
- `data` (optional object) — named test data the steps refer to as `{{key}}`.
  NEVER put a real password, token, or secret here — reference it as `env:NAME`.

Keep one case per source case. If a source row is empty or not a test, skip it.
Preserve the source's order. When something is ambiguous, prefer the simplest
faithful reading over inventing detail.
```

> **Schema note for the implementer:** these fields mirror organiclaw's `src/testing/schema.ts`. If that schema changes, this prompt must track it (a future parity check is deferred per the spec).

- [ ] **Step 4: Run the test to confirm the contract holds**

Run: `npm test`
Expected: both files green.

- [ ] **Step 5: Commit**

```bash
git add assets/smartmonkey-cases.md test/embed.mjs
git -c commit.gpgsign=false commit -m "$(printf 'feat(cases): conversion prompt + mock-model conversion-contract test\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01J8wrVY2enRpNmkBKLhYrWi')"
```

---

### Task 6: `cli.mjs` — `cases` command, `opts()`, scaffold `.gitignore`, help

**Files:**
- Modify: `cli.mjs`

**Interfaces:**
- Consumes: `connectors.mjs` (`fileSource`, `confluenceSource`, `resolveConnector`), `embed.mjs` (`resolveProvider`, `PROVIDERS`, `makeToolRunner`, `makeAsk`, `runAgent`, `CASES_SYSTEM`, `producedCases`), and the existing `DRIVERS`, `detectDrivers`, `serve`, `ensureScaffold`, `ASSETS`, `KIT_DIR`, `opt`, `flag`, `args`.
- Produces: the `cases` command. `run` and its helpers are untouched.

- [ ] **Step 1: Add a repeatable-flag reader** — in `cli.mjs`, right after the `opt` definition (line ~40), add:

```js
// All values for a repeatable flag: `--import a --import b` → ['a','b'].
const opts = name => { const out = []; for (let i = 0; i < args.length - 1; i++) if (args[i] === '--' + name && !args[i + 1].startsWith('--')) out.push(args[i + 1]); return out; };
```

- [ ] **Step 2: Write `.gitignore` on scaffold** — in `scaffold()`, after the `for (const f of KIT_FILES)` loop, add:

```js
  const gi = join(KIT_DIR, '.gitignore');
  if (!existsSync(gi)) writeFileSync(gi, 'import/\n');   // fetched/staged case content stays local
```

- [ ] **Step 3: Add `cmdCases()`** — add this function (e.g. after `cmdCheck`):

```js
async function cmdCases() {
  const importPaths = opts('import');
  const confluenceTargets = opts('confluence');
  if (!importPaths.length && !confluenceTargets.length) {
    console.error('smartmonkey cases needs a source:\n  --import <file|dir>       an export/paste of your cases (.html .csv .md .txt .json)\n  --confluence <space|url>  a Confluence space key or page URL (repeatable)');
    process.exit(2);
  }
  ensureScaffold();
  const conn = await import('./connectors.mjs');
  const embed = await import('./embed.mjs');

  const sources = [];
  if (importPaths.length) sources.push(conn.fileSource(importPaths));
  if (confluenceTargets.length) {
    const creds = conn.resolveConnector({ flags: { site: opt('confluence-site'), email: opt('confluence-email'), token: opt('confluence-token') } });
    if (creds.error) { console.error(creds.error); process.exit(2); }
    sources.push(conn.confluenceSource(confluenceTargets, creds));
  }

  const wantEmbed = !!opt('key') || !!opt('provider');
  const found = detectDrivers();
  const forced = opt('driver');

  if (flag('dry-run')) {
    const ai = (!wantEmbed && (found.length || forced)) ? `CLI (${forced || found[0]?.id})` : 'embedded';
    console.log(`would stage ${importPaths.length} import path(s) + ${confluenceTargets.length} confluence target(s) into smartmonkey/import/,`);
    console.log(`then convert → smartmonkey/cases.json via ${ai}, then serve.`);
    return;
  }

  for (const s of sources) {
    process.stdout.write(`Collecting from ${s.name} … `);
    const r = await s.collect({ root: process.cwd() });
    console.log(r.label);
  }

  const prompt = readFileSync(join(ASSETS, 'smartmonkey-cases.md'), 'utf8');
  const openWhenDone = () => embed.producedCases(process.cwd())
    ? (console.log('\nDone. Opening the editor to review + edit before you upload…'), serve(Number(opt('port')) || 8899))
    : console.log('\nNo cases.json was written. Check smartmonkey/import/ and re-run, or try --driver <cli>.');

  if (!wantEmbed && (found.length || forced)) {
    const driver = forced ? DRIVERS.find(d => d.id === forced || d.bin === forced) : found[0];
    if (!driver) { console.error(`driver "${forced}" not found on PATH.`); process.exit(2); }
    console.log(`Converting with ${driver.label} → smartmonkey/cases.json …\n`);
    const child = spawn(driver.bin, [prompt], { stdio: 'inherit', cwd: process.cwd() });
    child.on('exit', openWhenDone);
    child.on('error', e => { console.error(`could not launch ${driver.bin}: ${e.message}`); process.exit(2); });
    return;
  }

  const res = embed.resolveProvider({ provider: opt('provider'), key: opt('key') });
  if (res.error) { console.error(`No AI available for conversion. Sign in to a CLI or pass --key. (${res.error})`); process.exit(2); }
  const model = opt('model') || res.model;
  const runTool = embed.makeToolRunner(process.cwd(), embed.makeAsk());
  const callModel = embed.PROVIDERS[res.provider].make(res.key, model, embed.CASES_SYSTEM);
  console.log(`Converting (embedded, ${embed.PROVIDERS[res.provider].label} · ${model}) → smartmonkey/cases.json …\n`);
  try { await embed.runAgent({ prompt, callModel, runTool, onText: t => process.stdout.write(t.trim() ? t + '\n' : '') }); }
  catch (e) { console.error('\nconversion failed: ' + e.message); process.exit(2); }
  openWhenDone();
}
```

- [ ] **Step 4: Route the command + update help** — in the `switch (cmd)` block add before `default`:

```js
  case 'cases': cmdCases().catch(e => { console.error(e.message); process.exit(2); }); break;
```

In `help()`, add after the `run` block:

```
  smartmonkey cases            convert existing test cases → cases.json, then opens the editor
                   --import <file|dir>        an export/paste of your cases
                   --confluence <space|url>   a Confluence space/page (repeatable)
                   [--confluence-site/-email/-token]  (or SMARTMONKEY_ATLASSIAN_* env)
                   [--driver X | --key K --provider P --model M] [--dry-run] [--port N]
```

- [ ] **Step 5: Verify routing by hand (dry-run) — the `cases` path and the untouched `run` path**

Run:
```bash
node cli.mjs cases --dry-run
node cli.mjs cases --import ./nonexistent --dry-run
node cli.mjs cases --confluence QA --confluence-site acme --confluence-email a@b.co --confluence-token t --key sk-ant-x --dry-run
node cli.mjs run --key sk-ant-x --dry-run
```
Expected:
- (1) errors: "smartmonkey cases needs a source…", exit 2.
- (2) dry-run line naming 1 import path + embedded/CLI (no stat of the path in dry-run).
- (3) dry-run line: 0 import + 1 confluence, convert via embedded.
- (4) unchanged: "would run (embedded/anthropic, model claude-sonnet-5) …" — proves `run` still works.

- [ ] **Step 6: End-to-end mock is already covered** — run the suite:

Run: `npm test`
Expected: both files green (128-equivalent local suite; no regression).

- [ ] **Step 7: Commit**

```bash
git add cli.mjs
git -c commit.gpgsign=false commit -m "$(printf 'feat(cli): smartmonkey cases command (import + confluence → cases.json)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01J8wrVY2enRpNmkBKLhYrWi')"
```

---

### Task 7: Docs — README + stage status

**Files:**
- Modify: `README.md`

**Interfaces:** none (documentation).

- [ ] **Step 1: Document `cases` in the command list** — in `README.md`, under the `npx` command block, add:

```
npx smartmonkey-client cases --import ./exported-cases.html   # convert existing cases → cases.json
npx smartmonkey-client cases --confluence QA                  # ...or pull them from a Confluence space
```

- [ ] **Step 2: Add a "Bring your existing cases" section** — after "The AI runs on your side", add:

```markdown
## Bring your existing cases

`smartmonkey cases` turns test cases you already have into `cases.json`, using the
same local AI — nothing but the reviewed `cases.json` leaves your machine.

- `--import <file|dir>` — a file or folder you exported or pasted from anywhere
  (Confluence export, TestRail/Xray CSV, a Markdown doc, a spreadsheet saved as CSV).
- `--confluence <space-or-page-url>` — pull pages straight from Confluence Cloud.
  Needs your Atlassian **site + email + API token** via `--confluence-site/-email/-token`
  or `SMARTMONKEY_ATLASSIAN_SITE/_EMAIL/_TOKEN`. The token is never written to disk.

Both stage what they read into `smartmonkey/import/` (kept local, gitignored), then
the AI converts it against your blueprint and opens the editor for review.
```

- [ ] **Step 3: Bump the Status line** — change the Status paragraph to mention stage 3:

```markdown
Stage 3 of the SmartMonkey local client (case import: universal file import +
Confluence connector, on top of the CLI + embedded API-key mode across
Anthropic / OpenAI / Gemini). Dev builds read the kit assets from the organiclaw
repo; a published package bundles its own `assets/`.
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git -c commit.gpgsign=false commit -m "$(printf 'docs: document smartmonkey cases (import + confluence)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01J8wrVY2enRpNmkBKLhYrWi')"
```

---

## Final verification

- [ ] `npm test` — both `test/embed.mjs` and `test/connectors.mjs` green.
- [ ] `node cli.mjs cases --dry-run` errors for no-source; the three dry-run forms above print the right plan.
- [ ] `node cli.mjs run --key sk-ant-x --dry-run` still prints the blueprint run line (proves `run` untouched).
- [ ] A real smoke (optional, spends a key/token): in a throwaway repo with a small `exported.csv`, `node <path>/cli.mjs cases --import ./exported.csv --key <key>` writes `smartmonkey/cases.json` and opens the editor; `smartmonkey/.gitignore` contains `import/`.

## Notes for the executor

- **Do not modify `runEmbedded` / `runViaCli` / `cmdRun`.** `cases` intentionally has its own small conversion wiring so the proven `run` path stays stable. The only shared change is the optional `system` param on the provider callers (Task 4), which defaults to the existing `SYSTEM`.
- **Confluence storage format** is XHTML in `body.storage.value`; hand it to the AI as-is (it reads tables fine). No HTML parsing dependency.
- **Schema drift** between `assets/smartmonkey-cases.md` and organiclaw's `src/testing/schema.ts` is a known, accepted risk (a parity check is deferred). Keep the field list in the prompt matching the spec's §7.
