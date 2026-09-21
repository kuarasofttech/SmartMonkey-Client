# smartmonkey-client Stage 3 — Case import & connectors

Design spec. Status: approved in brainstorming 2026-09-21, pending spec review.

## Context

`smartmonkey-client` is the open-source local CLI (Node ≥ 18, ESM, **zero runtime
dependencies**). Today it: scaffolds the kit, **builds the blueprint** with the
owner's own AI (a logged-in CLI *or* an embedded API-key agent — Anthropic /
OpenAI / Gemini), serves a viewer + case editor, and checks freshness. The AI
runs on the owner's machine; only the `blueprint.json` / `cases.json` they
approve is ever shared.

Stage 3's job is to help owners get their **existing** test cases into
`cases.json`. Brainstorming established:

- Test cases live in fragmented places — wikis/spreadsheets (Confluence, Sheets),
  standalone platforms (TestRail, qTest), and Jira-native apps (Xray, Zephyr).
  A per-tool API connector is a long tail; plain-Jira-issues is a minority case.
- The owner's own cases are in **Confluence**.
- Auth is **API token** (paste/env), not OAuth: an OSS CLI with no backend has
  nowhere safe to hold an OAuth `client_secret`.
- Build **two sources now** behind a connector seam, defer the rest:
  - **A — Universal import**: export/paste from any tool → local AI converts.
  - **B — Confluence connector**: fetch pages directly (reuses the Atlassian token).
  - **Deferred — browser crawler** (best raw results, but a heavy browser-automation
    subsystem that fights the zero-dep model) and per-tool API connectors
    (Jira/Xray/Zephyr/TestRail).

## Goals

- A `smartmonkey cases` command that converts existing test cases into
  `smartmonkey/cases.json` and opens the editor for review.
- Two sources (universal file import + Confluence), behind a `Source` seam that
  future sources plug into without touching the conversion path.
- Reuse the existing AI selection (embedded providers **and** logged-in CLIs) and
  the sandboxed agent loop — no new AI plumbing.
- Keep the privacy spine intact: nothing but the reviewed `cases.json` leaves the
  machine; no secret is written to disk by the tool.

## Non-goals (deferred, explicit)

- Browser crawler / any browser-automation dependency.
- Jira issues, Xray, Zephyr, TestRail, qTest, Google Sheets API connectors.
- OAuth (any provider) — revisit only if SmartMonkey grows a hosted backend.
- Drafting cases from scratch with no source — that stays the blueprint prompt's
  optional case section, invoked by `run`, not `cases`.
- Server-side (SmartMonkey) case generation — a separate, already-planned path.

## Design

### 1. Command surface

```
smartmonkey cases [source…] [ai-selection] [--dry-run] [--port N]
  --import <path>            a file or folder of exported/pasted cases
                             (.html .csv .md .txt .json). Repeatable.
  --confluence <space|url…>  Confluence space key(s) and/or page URL(s). Repeatable.
  --confluence-site  <s>     e.g. "acme" or "acme.atlassian.net"  (env SMARTMONKEY_ATLASSIAN_SITE)
  --confluence-email <e>     Atlassian account email               (env SMARTMONKEY_ATLASSIAN_EMAIL)
  --confluence-token <t>     Atlassian API token                   (env SMARTMONKEY_ATLASSIAN_TOKEN)
  --key/--provider/--model   embedded AI (same as `run`)
  --driver <cli>             logged-in CLI (same as `run`)
  --dry-run                  show what it would fetch/read + which AI, run nothing
```

At least one source is required; with none, `cases` errors with guidance. The AI
selection resolves through the existing `resolveProvider` (embedded) / driver
detection, identical to `run`.

### 2. Flow

```
resolve source(s)  →  stage normalized text into smartmonkey/import/<source>/*.md
                   →  run the local AI: read import/** + blueprint.json → write cases.json
                   →  open the viewer/editor for review
```

Staging **both** sources down to local text files under `smartmonkey/import/` is
the key move: it gives **one** conversion path that serves both the embedded
agent and a logged-in CLI. The CLI can't authenticate to Confluence, but it can
read the files the tool already fetched.

### 3. The connector seam — `connectors.mjs` (new)

```js
// A Source writes normalized text items into smartmonkey/import/<name>/ and
// returns the files it wrote. `ctx` carries the repo root + a logger.
interface Source { name: string; collect(ctx): Promise<{ files: string[], label: string }> }
```

- **`FileSource`** (`--import`): resolves the path(s); stages each supported text
  file (`.html .csv .md .txt .json`) into `import/files/` (copied verbatim — the
  AI parses HTML/CSV tables from the raw text). A folder is walked recursively,
  skipping the ignore set (`.git`, `node_modules`, `build`, `dist`, …) and any
  file whose extension isn't in the supported set. Skipped files are noted (no
  PDF/office parsing — out of scope, zero-dep).
- **`ConfluenceSource`** (`--confluence`): Confluence Cloud REST v1.
  - Auth: `Authorization: Basic base64(email:token)`, `Accept: application/json`.
  - Base: `https://<site>.atlassian.net/wiki/rest/api`.
  - A **space key** → `GET /content?spaceKey=<K>&type=page&status=current&expand=body.storage&limit=50`,
    following `_links.next` for pagination.
  - A **page URL** → extract the numeric page id (`/pages/<id>/…`) → `GET /content/<id>?expand=body.storage`.
  - Writes each page to `import/confluence/<id>-<slug>.md` as `# <title>\n\n<body.storage.value>`
    (Confluence storage XHTML — the AI reads its tables fine).
  - Injectable `fetch` (default global) so it is unit-testable without a network.

Future `JiraSource` / `TestRailSource` / `CrawlerSource` implement the same
interface; the conversion path is untouched.

### 4. Auth & config — `resolveConnector()`

A sibling to `resolveProvider`: given flags + `env`, returns
`{ site, email, token }` for Confluence (normalizing `acme` → `acme.atlassian.net`),
or `{ error }` naming the first missing field. **The token is never written to
disk** — same rule as the AI `--key`. Flags win over env.

### 5. Privacy

- `smartmonkey/import/` is intermediate and may hold sensitive case text → it
  stays local; only the reviewed `cases.json` is shared, exactly as with source
  reading.
- `init` (and the auto-scaffold) writes a `smartmonkey/.gitignore` containing
  `import/` (and the existing scaffold-output ignores), so a customer never
  commits fetched content by accident.
- No connector secret is persisted by the tool.

### 6. AI conversion — reuse `embed.mjs`

- The embedded path uses the existing `runAgent` + sandboxed tools: `read_file` /
  `list_dir` already read anywhere in the repo (so `import/**` and `blueprint.json`
  are readable), and `write_file` already permits only `smartmonkey/*.json` (so
  `cases.json` is allowed, nothing else). **No sandbox change.** The connector
  code — not the agent — writes `import/` (ordinary tool fs, outside the sandbox).
- `runConversion` uses a conversion-specific **system** message (produce
  `smartmonkey/cases.json` from the staged sources; never copy source), not the
  blueprint-framed `SYSTEM`.
- A **conversion prompt** (the user-message instructions), bundled as
  `assets/smartmonkey-cases.md` (client-owned; not in the organiclaw asset sync —
  server-side case-gen is a different path).
  It instructs the agent: read every file under `smartmonkey/import/`, read
  `smartmonkey/blueprint.json` if present, and emit `smartmonkey/cases.json` in the
  case schema — mapping each case's preconditions to the blueprint's states via
  `requires` where possible, carrying over steps/expected, and **never** copying
  source (only behavior). If no blueprint is present, convert without `requires`
  and note it.
- The logged-in-CLI path hands that same prompt text to the CLI (as `run` does
  with the blueprint prompt); the CLI reads the staged files and writes
  `cases.json`.
- After a successful write, `serve()` opens the editor (as `run` does).

### 7. Case schema & drift

`cases.json` uses the existing case shape (organiclaw `src/testing/schema.ts`):
`{ id, title, priority?, tags?, requires?, leaves?, data?, steps:[{do, expect?}]
| goal + expected }`. The conversion prompt embeds this compact shape. **Drift
risk:** if it diverges from organiclaw's schema, uploads fail server validation.
Mitigation now: keep the shape in one place in the prompt with a comment pointing
at the canonical source; a future parity check (sibling to organiclaw's
`brief-parity`) can enforce it. Noted, not built here.

### 8. File layout (client repo)

```
cli.mjs            + `cases` command, routing, --confluence*/--import flags
connectors.mjs     (new) Source seam, FileSource, ConfluenceSource, resolveConnector
embed.mjs          + a runConversion helper (loads the bundled prompt, runs the agent)
assets/
  smartmonkey-cases.md   (new) the conversion prompt (client-owned, not synced)
test/
  connectors.mjs   (new) ConfluenceSource (mock fetch), FileSource, resolveConnector
  embed.mjs        + a conversion run over a mock model (reads import/ + blueprint → cases.json)
```

## Testing (mock-based — no live token, no live AI)

- **ConfluenceSource** with an injected `fetch`: Basic-auth header = `base64(email:token)`,
  space-key pagination (follows `_links.next`), page-id extraction from a URL, and
  `body.storage.value` → staged `import/confluence/*.md` content.
- **FileSource**: a temp dir of `.html`/`.csv`/binary → only supported files staged
  into `import/files/`, binaries skipped.
- **resolveConnector**: flag/env resolution, `acme`→`acme.atlassian.net`
  normalization, missing-field errors (mirrors the `resolveProvider` test).
- **Conversion run**: the mock model asserts the agent reads `import/**` +
  `blueprint.json` and writes a schema-shaped `cases.json`.
- **Command routing**: `cases` with no source errors; `--dry-run` reports the
  planned sources + AI without fetching or calling the model.

All registered in the client repo's `npm test`.

## Risks

- **Confluence storage XHTML is verbose** — large spaces could produce a lot of
  text for the AI. Mitigation: `--confluence` takes explicit spaces/URLs (no
  whole-site crawl), and a per-run page cap with a clear message.
- **Schema drift** (see §7).
- **HTML/CSV parsing quality** rests on the AI, not a parser — acceptable, since
  the owner reviews every case in the editor before upload.

## Deferred (explicit)

Browser crawler; Jira/Xray/Zephyr/TestRail/qTest/Sheets connectors; OAuth; PDF/
office-doc import; server-side case generation; the schema parity check.
