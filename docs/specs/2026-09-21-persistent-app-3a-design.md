# smartmonkey-client Stage 3a — Persistent app + web-UI blueprint (embedded)

Design spec. Status: approved in brainstorming 2026-09-21, pending spec review.

## Context

`smartmonkey-client` is today a set of **one-shot CLI commands** (`run`, `cases`,
`check`, `view`, `drivers`): each spins up, does its work, maybe serves the
viewer, and exits. The AI runs on the owner's machine — embedded (their API key,
via `embed.mjs`'s sandboxed agent loop) or by spawning a logged-in CLI — and only
the reviewed `blueprint.json` / `cases.json` ever leaves.

The product vision is bigger: the client installs into the owner's project and
**runs as a persistent local app fronting a website**, where they manage
integrations, set their key or pick a CLI, and generate the blueprint and cases
**from the browser** — with the AI reaching tools locally. This realizes the
original north-star (the app owns the interview, with real dropdowns/checkboxes)
and sets up a later local **MCP server** so the owner's own agent can use the
same tools.

That persistent app is a product's worth of surface, so it is decomposed into
three slices, each its own spec → plan → build:

- **3a (this spec):** the persistent server + web-UI shell + **embedded blueprint
  generation with the interview in the browser** + review + keychain secrets.
- **3b:** cases generation + **integrations UI** (Jira/Figma), reusing the
  connector/conversion logic already specced in
  `docs/specs/2026-09-21-case-import-connectors-design.md`.
- **3c:** a **local MCP server** exposing the same tools to the owner's external
  agent (Claude Desktop / Cursor / `claude`).

Brainstorming decisions locked for 3a: embedded-from-the-UI is the primary path;
secrets go in the **OS keychain** with a graceful in-memory fallback; the app is
a **foreground** server (no daemon).

## Goals (3a)

- `smartmonkey` (bare) launches a persistent local web app that generates a
  blueprint end-to-end **in the browser**, including the interview.
- Reuse `embed.mjs` verbatim; the only substitution is the interview I/O
  (terminal → web).
- Persist the AI key (and later integration tokens) in the OS keychain, with a
  clear fallback when unavailable — never plaintext on disk.
- Keep the privacy spine: the AI runs locally; only the reviewed `blueprint.json`
  leaves. Leave the one-shot `run`/`serve` path untouched.

## Non-goals (deferred)

- Cases generation and integrations UI (3b); the local MCP server (3c).
- Full Windows Credential Manager storage — Windows uses the in-memory fallback
  in 3a (functionally covered).
- Multi-user / multiple concurrent runs — single local user, one active run.
- Auth on the local server beyond binding to `127.0.0.1`.
- Daemonizing / auto-start / background service.

## Global constraints (carried from the project)

- **Zero runtime dependencies** — node builtins only; network via injectable
  `fetch`; keychain via injectable `exec`.
- **Node ≥ 18, ESM.**
- **Privacy** — the AI runs on the owner's machine; only reviewed outputs leave;
  no secret is written to disk in plaintext.
- **Don't break the one-shot path** — `run`, `runEmbedded`, `runViaCli`,
  `serve`, `cmdCheck` stay as-is; the app is additive.
- **Tests are mock-based** — injected `exec`/`callModel`; a local `127.0.0.1`
  server is allowed in tests, no external network.

## Design

### 1. Lifecycle & command surface

- `smartmonkey app` → start the persistent server on `127.0.0.1:<port>`
  (`--port`, default 8899), open the browser, run until Ctrl-C.
- Bare `smartmonkey` keeps printing help (unchanged from today); `app` is added
  to the help listing.
- `run` / `cases` / `check` / `view` / `drivers` unchanged.

### 2. Server + API — `server.mjs` (zero-dep `http`)

The server serves the app UI and the `smartmonkey/` directory (so the existing
`view.html` renders `blueprint.json` for review). One local user ⇒ a single
in-memory `session` holds the active run; a second `POST /api/generate` while one
runs returns `409`.

Routes:
- `GET /` → the app UI (`assets/app.html`).
- Static passthrough: bundled assets and files under `smartmonkey/` (path-guarded
  like the current `serve()`), so `view.html`, `blueprint.json`, `cases.json` load.
- `GET /api/status` → JSON:
  ```json
  {
    "ai": { "provider": "anthropic|openai|gemini|null", "model": "…", "ready": true },
    "keychain": { "available": true },
    "blueprint": { "exists": true },
    "run": { "status": "idle|running|done|error", "error": null },
    "pendingAsk": { "id": "…", "question": "…", "options": ["…"] }
  }
  ```
  `pendingAsk` is `null` unless the agent is waiting on an interview answer.
- `POST /api/ai` — body `{ provider, model?, key? }`. Persists selection in the
  session; if `key` is present, stores it in the keychain under
  `smartmonkey:<provider>` and drops it from memory after use resolves. The key is
  **never** returned by any endpoint. `ready` becomes true when a key resolves
  (keychain or env) for the selected provider.
- `POST /api/generate` — start the embedded blueprint run (see §3). `202` on
  start, `409` if a run is active, `400` if AI isn't ready.
- `GET /api/events` — **SSE** stream for the active run. Event types:
  - `text` — a chunk of the agent's visible output.
  - `tool` — `{ name, summary }` activity line (e.g. `read_file README.md`).
  - `ask` — `{ id, question, options }` (an interview question).
  - `done` — `{ blueprint: true|false }`.
  - `error` — `{ message }`.
  On connect, the server replays the session's buffered events so a reloaded page
  catches up, then streams live.
- `POST /api/answer` — body `{ id, answer }`. Resolves the matching pending
  interview question (see §3). `409` if no/`id`-mismatched pending ask.
- `POST /api/stop` — abort the active run (best-effort; marks `run.status=idle`).

### 3. The interview-over-web bridge — `webask.mjs`

The server runs the existing agent loop:
```js
embed.runAgent({ prompt, callModel, runTool, onText })
```
where `runTool = embed.makeToolRunner(cwd, ask)` and **`ask` is the web bridge**
instead of `embed.makeAsk()` (the terminal reader).

`makeWebAsk(session, emit)` returns an `async ask(question, options)` that:
1. mints `id = 'ask_' + (n++)`,
2. sets `session.pendingAsk = { id, question, options, resolve }`,
3. calls `emit('ask', { id, question, options })` (→ SSE),
4. returns a promise that stays pending until answered.

`answerAsk(session, id, answer)`:
- if `session.pendingAsk?.id === id`: capture `resolve`, clear `session.pendingAsk`,
  `resolve(answer)`, return `true`;
- else return `false` (stale/duplicate answer ignored).

Because `pendingAsk` lives on the session and is exposed by `GET /api/status`, a
reloaded page re-renders the open question and can still answer it. `makeWebAsk`
and `answerAsk` are pure (take a `session` + an `emit` callback), so they unit-test
without HTTP.

`onText` → `emit('text', chunk)`. Tool activity → the server wraps `runTool` so
each call also does `emit('tool', { name, summary })` before delegating to
`embed`'s real runner (the sandbox is unchanged; the wrapper only observes).

### 4. Keychain secrets — `secrets.mjs`

A tiny backend over the OS keychain, service name `smartmonkey`:
- macOS: `security add-generic-password -U -s smartmonkey -a <name> -w <value>` /
  `security find-generic-password -s smartmonkey -a <name> -w` /
  `security delete-generic-password -s smartmonkey -a <name>`.
- Linux: `secret-tool store --label=smartmonkey service smartmonkey account <name>`
  (value on stdin) / `secret-tool lookup service smartmonkey account <name>` /
  `secret-tool clear service smartmonkey account <name>`.

API: `makeSecrets({ exec = defaultExec, platform = process.platform })` →
`{ available(): boolean, get(name), set(name, value), delete(name) }`.
- `available()` probes for the tool (`security` on darwin, `secret-tool` on linux)
  and returns false on win32 or when the probe fails.
- When unavailable, the backend uses an **in-memory Map** (session-lived) so the
  app still works this run; `available()` reports `false` and the UI shows "not
  persisted (keychain unavailable)". **Never** writes a plaintext file.
- `exec` is injected (default wraps `child_process.spawnSync`) so tests assert the
  exact argv without touching the real keychain.

Secret values passed on argv are unavoidable for `security`; `secret-tool` reads
the value from **stdin** (kept off argv). Values are never logged or returned by
the server.

### 5. UI — `assets/app.html` (vanilla, client-owned; not in the organiclaw sync)

A single page, served at `/`, talking to the API above. Sections:
- **Setup:** provider `<select>` (Anthropic/OpenAI/Gemini) + model input (defaults
  from `PROVIDERS`) + a key field → `POST /api/ai`; shows "saved to keychain ✓" or
  the fallback notice. (CLI-driver selection is shown but wiring a CLI run from the
  app is 3b-adjacent; 3a's generate path is embedded — if only a CLI is available,
  the UI says so and points at `smartmonkey run`.)
- **Generate:** a "Build blueprint" button, enabled when `ai.ready`. Click →
  `POST /api/generate`, then open an `EventSource('/api/events')`.
- **Live pane:** appends `text`/`tool` events; on an `ask` event renders a form —
  `options` → radios (single) or a `<select>`; no options → a text input; submit →
  `POST /api/answer`. On reload, `GET /api/status.pendingAsk` re-renders it.
- **Review:** on `done` with `blueprint:true`, link to `/view.html` (already
  renders `blueprint.json` for review/edit).

Styling and markup follow the existing `view.html` conventions (plain HTML/CSS/JS,
no framework).

### 6. Reuse + file structure

Reuses `embed.mjs` unchanged: `runAgent({ prompt, callModel, runTool, onText })`,
`TOOLS` (incl. `ask_user`), `makeToolRunner(cwd, ask)`, `PROVIDERS`,
`resolveProvider`, `SYSTEM`, and the `smartmonkey-blueprint.md` prompt (read from
`assets/`). The one-shot `serve()`/`run` remain.

```
server.mjs      (new) http server, routes, SSE, single-run session; wires embed + webask + secrets
webask.mjs      (new) makeWebAsk / answerAsk (pure bridge)
secrets.mjs     (new) makeSecrets: keychain get/set/delete + in-memory fallback
assets/app.html (new) the persistent app UI
cli.mjs         (mod) add the `app` command → start server (bare `smartmonkey` = help, unchanged)
test/secrets.mjs (new)
test/webask.mjs  (new)
test/server.mjs  (new) generate → ask → answer → done over 127.0.0.1 with a mock model
package.json    (mod) test script runs all test files
```

For the server to be testable, `server.mjs` exports a `createApp({ cwd, makeSecrets?, modelFactory? })`
that returns `{ server, port }` when listened; `modelFactory(provider, model, key)` defaults to
`PROVIDERS[provider].make` but a test injects a mock returning canned `{content, stop_reason}`.

### 7. Testing (mock-based)

- **`secrets.mjs`**: injected `exec` records argv. macOS path → `security … -a token -w V`
  for `set`, find/delete shapes for get/delete; linux path → `secret-tool store/lookup/clear`
  with the value on stdin, not argv. `available()` false (win32 or failing probe) →
  in-memory get/set/delete round-trips.
- **`webask.mjs`**: `makeWebAsk` sets `pendingAsk` + emits `ask`; `answerAsk` with the
  right id resolves the promise and clears `pendingAsk`; a wrong/stale id returns false
  and leaves the pending ask intact.
- **`server.mjs`**: start `createApp` on an ephemeral port with a mock `modelFactory`
  whose model emits one `ask_user` then a `write_file` of `blueprint.json`. Drive:
  `POST /api/ai` → `POST /api/generate` → read `/api/events` until an `ask` → `POST /api/answer`
  → assert a `done` event and that `smartmonkey/blueprint.json` exists in a temp cwd.
  Assert `409` on a second concurrent generate and that no endpoint returns the key.

All wired into `npm test`.

## Risks

- **SSE + single-session state** is simple by design (one local user). If two
  browser tabs open, both see the same run; the second `generate` is refused with
  `409` — acceptable for a local tool.
- **Keychain edge cases** (locked keychain prompts on macOS, no libsecret on
  headless Linux) → the fallback keeps the app working; the UI states persistence
  status. Windows persistence is deferred.
- **Key on argv** for macOS `security` is visible to local process listing
  briefly; acceptable for a single-user local tool, and `secret-tool` avoids it on
  Linux. Documented.
- **`view.html` reuse** keeps review in the existing asset; if the app later needs
  richer in-page review, that's a 3b/UI iteration, not 3a.

## Deferred (explicit)

Cases + integrations UI (3b); local MCP server (3c); Windows Credential Manager;
multi-run/multi-user; server auth; daemonization; CLI-driver generation from the
app UI (3a generate is embedded-only).
