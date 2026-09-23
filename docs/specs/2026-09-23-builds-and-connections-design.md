# Build history + Connections (local middle layer) — design

Two features that meet in one place (each build records what it drew on):

- **A. Stateful app / build history** — opening the app shows the last build; every
  build is kept; builds are listable, openable and deletable.
- **B. Connections** — the local app connects to the project's external tools
  (Linear first) through their APIs and exposes them to the building agent as a
  read-only MCP surface. The agent never holds a token and can never mutate.

Decided with the owner (2026-09-23): the middle layer runs in the LOCAL app, not
the SmartMonkey cloud — tokens and fetched content never leave the machine.

---

## A. Build history

### Storage
```
smartmonkey/
  blueprint.json            ← the CURRENT blueprint (unchanged path: upload, check, CLI use it)
  cases.json                ← current cases, if any
  builds/
    2026-09-23T10-41-07Z-a1b2/
      meta.json             ← id, startedAt, finishedAt, status, driver/model,
                              interview Q&A, connections (asked / connected),
                              connector calls (audit summary), counts
      events.jsonl          ← the run's progress stream (replayable)
      blueprint.json        ← snapshot of what this build produced
      cases.json            ← if produced
  .gitignore                ← ignores builds/ and owner-answers.json (see Decisions)
```
- A build folder is created when a build **starts** (status `running`), so a
  crash or restart leaves a visible `interrupted` build, never a silent gap.
- Every SSE event is appended to `events.jsonl` as it's emitted.
- On finish the server **snapshots** `smartmonkey/blueprint.json` (+ `cases.json`)
  into the build folder. The agent keeps writing the usual path — no prompt change.
- Status: `running | done | error | stopped | interrupted` (a `running` build
  found at startup whose process is gone becomes `interrupted`).

### "Current" and deleting
- Current = what `smartmonkey/blueprint.json` holds = the newest `done` build.
- Deleting a build removes its folder. Deleting the current build restores the
  next newest `done` build's snapshot to `smartmonkey/blueprint.json` (or removes
  it if none remain). A running build can't be deleted (Stop first).
- Optional "Make current" on an older build (restore its snapshot). Cheap; included.

### API
- `GET /api/builds` → `[{id, startedAt, finishedAt, status, counts, current}]`, newest first.
- `GET /api/builds/:id` → meta + events (for replay).
- `DELETE /api/builds/:id`, `POST /api/builds/:id/current`.
- Static: `/builds/:id/blueprint.json` (already served from `smartmonkey/`), so
  `view.html?src=builds/<id>/blueprint.json` opens any build.

### UI (app.html)
- On open: if there's a build, the Build card shows the **latest build** — status,
  its replayed progress log, its result (Review button → that build's view).
- A **History** list under it: date, status, counts (screens / flows / open
  questions), current badge; actions Open, Make current, Delete (confirm inline —
  no browser `confirm()` dialog).

---

## B. Connections

### Shape
```
 building agent (headless Claude Code, the API-key agent, later Cursor/Codex…)
        │  MCP tools: linear_search_issues, linear_get_issue, … + ask_user, request_connections
        ▼
 SmartMonkey local app  ── holds keys (OS keychain) · read-only by construction · audit log
        │  HTTPS with the user's key
        ▼
 Linear (first) · Jira · Confluence · Notion · Figma · …
```

### Connector modules (`connectors/<tool>.mjs`)
Each exports `{ id, label, fields, test(creds), tools: [{ name, description, inputSchema, run(creds, input) }] }`.
- **Read-only by construction**: every tool is a fixed read operation we wrote
  (Linear: fixed GraphQL *queries*, no raw GraphQL from the agent, so no mutation
  can be expressed). Never a pass-through with a blocklist.
- Output is size-capped and wrapped as untrusted DATA (prompt-injection hygiene).
- **Linear first**: personal API key; tools `linear_search_issues`,
  `linear_get_issue` (with comments), `linear_list_projects`, `linear_get_project`.
- Where a tool supports read-only / scoped keys, the setup text asks for one.
- **Recent work** (owner, 2026-09-23): connections are not only for finding existing
  cases — a tracker's recent work is the best source of NEW ones. Linear adds
  `linear_completed_issues` (window, bugs-only, team — built into a filter by our code,
  values only from the agent), `linear_list_cycles`, `linear_get_cycle`. The interview
  asks where bugs/tasks/sprints are tracked (always) and whether to turn recent work
  into cases (only when writing cases). Fixed bug → regression case, finished task →
  integration case through the features it touches, tagged `from:<issue key>`.

### Credentials
OS keychain via the existing `secrets.mjs` (`connector:linear`). The UI never
shows a stored key back. "Connected" is shown only after `test()` succeeds.

### MCP exposure
- `ask-mcp.mjs` grows into the app's MCP server: `tools/list` asks the app for the
  CURRENT tool set (ask_user, request_connections + tools of connected connectors);
  `tools/call` for a connector tool → `POST /api/connector-call` (per-app token) →
  the app runs it with the stored key → text back.
- Headless Claude allowlist gains `mcp__smartmonkey__<connector tools>` (fixed
  names, so the allowlist is exact).
- The API-key (embedded) agent gets the same tools directly.
- Later: expose the same server over local HTTP for the user's own agents.

### Audit
Every connector call is appended to the build's `meta.json` (tool, input summary,
result size, time) — this is what the Sources view shows. Truth from the server,
not the model's own claim.

### UI
- **Connections card** (app.html, its own card): each supported tool with real
  status — Not set up / Connected ✓ (tested) / Error; Set up → key field → Test →
  saved; Disconnect. Unsupported tools listed honestly as "coming later".
- **Mid-run panel**: a tool that is set up connects for real with one click; one
  that has a connector but no key shows "Set up now" inline; one with no
  connector stays "Can't connect yet".
- **view.html → Sources section**: which tools this build used (from the audit),
  and which were asked for but not connected.

### Prompt
`runBlock` lists the connector tools available in this run and says: use them
to read the owner's issues/specs; cite what you used in `findings`.

---

## Phasing
1. **A — build history** (self-contained, no external deps).
2. **B1** — Connections card + Linear connector + MCP middle layer + mid-run
   integration + audit.
3. **B2** — view.html Sources + more connectors (Jira/Confluence, Notion, Figma,
   GitHub Issues) + local HTTP MCP for external agents.
4. Later — web-search fallback (app-run search, user-confirmed host, read-only GET).

## Decisions (owner, 2026-09-23)
1. **Git**: `smartmonkey/.gitignore` ignores `builds/` and `owner-answers.json`;
   `blueprint.json` stays committable.
2. **Starting builds**:
   - The app opens on the **latest build** (status, replayed log, Review).
   - **New build** starts CLEAN: the current blueprint is set aside (it's safe in
     its build folder; a pre-history blueprint is first imported as a build so
     nothing is lost). If the new build fails or is stopped, the current one is
     put back.
   - **Build on this one** (any build in History): that build's blueprint is placed
     as the starting point and the prompt says to keep what's right, fix what's
     wrong and fill gaps.
3. **The current build is editable** (view.html, when served by the app): case
   edits and answers to open questions SAVE into the build (and into
   `smartmonkey/` if it's the current one) — not download-only.
   Phase A splits: **A1** history + start modes, **A2** editing.

## Tests
- Build store: create/snapshot/list/delete/make-current/interrupted-on-restart.
- Server: events persisted and replayed; delete-current restores previous.
- Connectors: Linear tools send only fixed queries (fake fetch), creds never in
  output, size cap; test() gates "Connected".
- MCP: dynamic tools/list; connector-call token; unknown tool refused.
- Real E2E: a build that reads a real Linear workspace (owner's key).
