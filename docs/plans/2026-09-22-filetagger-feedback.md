# FileTagger run — feedback roadmap (2026-09-22)

Four issues from running `smartmonkey app` on the FileTagger project. Decisions
taken with the user; sequence and status below.

## ✅ #3 — No python server (DONE, client `243d693`, organiclaw `b01c628`)
Root cause: the scaffold `README.md` told users to `python3 -m http.server` to
view the blueprint. Fixed: lead with the app (`npx smartmonkey-client app`), use
`smartmonkey view` to reopen the viewer, keep double-click+drag as the no-install
fallback, python removed. (Source of truth = organiclaw
`src/assets/blueprint-kit/README.md`, synced into the client.)

## ✅ #4 — Rename builder prompt (DONE, same commits)
`smartmonkey-blueprint.md` → `builder-prompt.md` everywhere: organiclaw source +
`/api/blueprint-prompt` + `/api/blueprint-kit` (path, download name, zip entry) +
sync manifest + client bundled asset + scaffold output + all readers
(cli.mjs, server.mjs). It's the prompt that BUILDS the blueprint, not the output.

## ✅ #1 — Connect-services flow gate (DONE, client `3413aff`, organiclaw `c3eca89`; spec `docs/specs/2026-09-22-connect-gate.md`)
Shipped: `request_connections` tool pauses after the interview → app "Connect your
tools" panel (Connect/Skip per tool) → Start enabled only when each is resolved
(server-enforced) → agent resumes. Connectors are STUBS (real OAuth = 3b).
Verified with a server-flow test + live in the browser.

### original note
Root cause: `builder-prompt.md` tells the agent to pull from
Jira/Xray/Confluence/Figma "via a connector, a token, or files", but there is NO
connector wiring — so it asks, then blueprints anyway (useless).
Target flow: interview collects all answers → app shows a **connect screen** with
buttons for the services mentioned → user connects → explicit **Start** →
blueprint. The agent PAUSES after the interview and surfaces needed connections
to the UI (extend the existing webask/ask_user SSE pause mechanism), resumes on
Start. Build with STUB connect buttons now (mark "connected"); real OAuth
(Jira/Figma/Confluence) is its own project (roadmap "3b").
Touches: builder-prompt.md (flow language), server.mjs (a connect gate + a
`request_connection`-style pause), app.html (connect screen). Needs a short spec.

## ✅ #2 — UI redesign, both surfaces, brand-aligned (DONE)
Rebranded app.html + view.html to the SmartMonkey system (Public Sans / Fraunces /
Space Mono, green #0E9F6E palette, warm paper, full light+dark). Fixed the case-ID
truncation (was inline width:90px; now field-sizing:content). view.html source of
truth is organiclaw (synced); app.html is client-owned.

### original note
Decision: redesign `app.html` (setup/build + new connect step) and `view.html`
(viewer + case editor) with the **frontend-design** skill, aligned to the
SmartMonkey brand (mascot/colors — see organiclaw `landing-smartmonkey/mascot`).
Includes the concrete bug from the screenshot: the case ID field (`.tc-id` in
view.html) is squeezed in a flex row → "TC-PERMIS…" truncated. Fix as part of the
redesign (do not patch-then-discard). Do app.html AFTER #1 so the connect step is
designed once.

## Sequence
#3, #4 (done) → #1 flow (spec → build, stub connectors) → #2 UI (frontend-design,
both surfaces). #1 before #2's app.html because the connect step lives in app.html.
