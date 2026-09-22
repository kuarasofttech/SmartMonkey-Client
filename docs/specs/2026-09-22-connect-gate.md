# Connect-gate flow (#1) — spec

Stop the blueprint agent from asking about external tools and then blueprinting
anyway. After the interview, gate the build behind an explicit **connect step**.

## Flow
Interview (as today) → agent calls **`request_connections(services)`** with the
tools the blueprint will draw on → run PAUSES → app shows a **Connect panel** (per
service: Connect / Skip; plus a **Start blueprinting** button) → each service must
be Connected or Skipped → Start resumes the agent → blueprint written.

Platform (embedded) mode only. In logged-in-CLI mode the build runs in the
terminal, so the tool isn't offered and the agent proceeds unchanged.

## Mechanism (mirrors the ask pause)
- `embed.mjs`: new tool `request_connections`. `makeToolRunner(cwd, ask,
  requestConnections)` — 3rd arg defaults to an auto-proceed no-op (CLI/terminal).
- `webask.mjs`: `makeWebConnections(session, emit)` parks
  `session.pendingConnections = { id, services, status:{svc:'pending'|
  'connected'|'skipped'}, resolve }` and emits SSE `connections`.
  `setConnection(session, id, service, action)` flips status;
  `startConnections(session, id)` resolves ONLY when every service is connected or
  skipped (server-enforced), else returns false.
- `server.mjs`: init `pendingConnections`; wire `makeWebConnections` into the
  embedded generate path; routes `POST /api/connect {id,service,action}` and
  `POST /api/connections/start {id}` (409 until all resolved); `/api/status`
  exposes `pendingConnections` for reload recovery.
- `app.html`: `renderConnections` panel; Start disabled until all resolved.
- `builder-prompt.md` (organiclaw source): "after the interview, if the blueprint
  will draw on external tools and you have `request_connections`, call it once with
  those tools and wait before continuing."

## Stub semantics
Connect only records intent (no real OAuth). Pulling Jira/Figma DATA is the
real-connector project (3b). The win here is the gate.

## Tests
- connections logic: park → connect/skip updates status → start refused until all
  resolved, then resolves.
- server flow: mock model calls request_connections → SSE `connections` → connect
  each → start 409-then-200 → agent continues → blueprint written.
