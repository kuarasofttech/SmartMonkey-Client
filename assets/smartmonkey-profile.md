# Build the SmartMonkey QA profile for this project

You are working inside a codebase. Produce **`smartmonkey/profile.json`** (create the
`smartmonkey/` folder at the repo root if it isn't there): the machine-readable answer to
everything an automated tester must know before it can drive this app on a real device.
The folder also holds `view.html`, a viewer the project owner opens to read the profile —
leave it untouched; you only write `profile.json`.

A SmartMonkey run is an AI agent holding a phone. It can read the screen and tap, but it
cannot guess which build is the dev one, how a tester gets past sign-in, how to put the
backend into a known state, or what it must never touch. Those answers usually exist in
this repo already — in `docs/`, a QA folder, onboarding notes, test files, or the code
itself. Your job is to find them, write them down in one place, and be honest about the
gaps.

## First, a short interview

Before you read any code, ASK me these questions — **one at a time, and WAIT for my answer
before the next.** Present the options as a numbered list; I reply with a number (or my own
words). Use my answers to steer everything below.

If you genuinely cannot ask me — you are running non-interactively / headless — take the
**default** marked on each, note the assumption in `findings`, and keep going. Never hang
waiting for a human. Ask them roughly in this order (skip any that a branch rules out):

1. **What should this run produce?**
   1) The profile only — SmartMonkey generates test cases later, on its side
   2) The profile AND test cases — now, on your AI
   *(default: 1)*

2. **(only if you're generating cases) Where are your existing test cases?**
   1) None — draft new ones from the app
   2) In this repo (code tests, manual checklists, or Gherkin features)
   3) In Jira / Xray
   4) In TestRail, Zephyr, or qTest
   5) Somewhere else — I'll tell you
   *(default: 1)*

3. **(only if they live in an external tool — 3/4/5 above) How should I reach it?**
   1) I'll paste an API token — or my CLI is already signed in to it
   2) Drive my browser with my logged-in session — **only offer this if you have a browser tool**
   3) I'll paste an export (CSV / JSON)
   *(default: 3 — ask me to paste it)*

4. **If there is more than one build/flavour, which should a tester use?**
   *(default: the debug/dev variant)*

5. **Which target is safe to hammer, and which must I NEVER touch?** Name the dev/staging
   backend a run may write to, and confirm production (and anything with real users, real
   money, real notifications) is off-limits. *(default: assume the dev/debug variant points at
   a safe dev backend; record "never run against production" in `prohibited`.)* Record the
   safe target on its `environments[]` entry (`mayWrite: true`) and the off-limits one in
   `prohibited[]`.

6. **Do you have any TEST SHORTCUTS I can use instead of driving the whole UI?** These let a
   test set up state and check results the fast, reliable way (the "back-door" pattern). I'll
   also look for them in the code — point me at what you know. **Dev/staging only, never
   production.** Tell me about each:
   - a **deep link or launch argument** that jumps straight to a screen — or logs in by
     passing a user — so I can skip the navigation/login dance *(I use these directly)*
   - a **dev/tester API**: reset state, seed data, create a test user, toggle a feature flag
     *(for setup)*, or read a record to verify an outcome the UI doesn't show *(for checking)*
   - a **dev/debug page or hidden menu** inside the app
   - a **dev/staging database** I may read (to verify) or write (to seed)
   For each: what it does, how to reach it (the deep link / endpoint / page / query), whether
   it's for SETUP or VERIFY, and any auth as a **reference** (`env:NAME`), never the secret.
   *(default: none — but still search the code for deep links, seed scripts, test endpoints.)*

7. **Point me at anything that describes the app in depth — and how to reach it.** Beyond the
   code: a spec / PRD / rules doc (Confluence, Notion, a repo doc), **Figma** designs, **Jira
   stories** and their acceptance criteria, or **screenshots** of the correct/expected states.
   I read them with your access (a connector, a token, or files in the repo), and fold the
   *behaviour* into the profile — `businessRules`, `screens`, `flows`. I keep only what a
   tester needs, described in words: **no raw documents, no PII from screenshots, no secrets.**
   *(default: just the repo's own docs/screenshots.)*

8. **How should I focus and behave?**
   - **Priorities:** what matters most, or breaks most — where should the tests concentrate?
     *(default: the core happy path.)* → `testGuidance.priorities`
   - **Coverage:** smoke the critical path, or go broad? *(default: smoke.)* →
     `testGuidance.coverage` (`smoke` | `broad`)
   - **Cleanup:** should I delete test data I create, and how? *(default: leave it.)* →
     `testGuidance.cleanup`

When I've answered, confirm my choices back in one line, then begin. These are the ONLY
questions you ask me up front; anything else you discover from the repo, and genuine unknowns
go in `openQuestions[]` **without** waiting (I answer those later in SmartMonkey).

## How to work

1. **Read before you write.** Start with any `docs/`, `README`, `CONTRIBUTING`, QA or
   testing folder, then the test files, then the code (auth, build flavours, feature
   flags, dev menus). Prefer what is written down over what you infer.
2. **NEVER send the source itself.** This file is uploaded to a third-party service, so
   the customer's code must not leave their machine. Do **not** include file paths, line
   numbers, class or package names, or pasted code or comments. Describe *behaviour* in
   your own words ("clearing app data leaves the collection behind because it lives in
   shared storage" — NOT the doc-comment verbatim, NOT the file it's in). The ONLY code
   reference in this file is the top-level `commit`. Mark each claim's `confidence` only:
   - `documented` — it is written down somewhere in the repo.
   - `inferred` — you read it out of the code.
   - `asked` — the project owner told you.
3. **Never invent.** If you cannot find how a tester logs in, do NOT describe a plausible
   login. Put the question in `openQuestions` and move on. An invented answer here fails
   at 2am on a real phone, and the report will blame the app.
4. **Never write a secret.** Passwords, API keys and tokens do not belong in this file.
   Reference them: `"credentialsRef": "env:QA_USER_7_PASSWORD"`.
5. **Ask last, and ask short.** When you have gone as far as the repo allows, list what
   only the owner can answer in `openQuestions[]` — the owner answers these later in
   SmartMonkey, not in this session. When an answer is one of a small set, give the
   choices in `options` (e.g. `["Android 11 or newer", "Android 10 or older"]`) so it can
   be picked from a dropdown rather than typed; add `"multi": true` when several can apply
   at once (the owner gets checkboxes). Otherwise leave it free-text. Do NOT wait for a
   human or guess an answer here.

## The questions to answer

**The app itself**
- What is it, in one line? Which platforms? What stack?
- Which build variants/flavours exist, and what is each one's application id
  (`com.acme.app.development`)? Give each a SHORT `id` key — one entry per build you care
  about (`fullDebug`, `playRelease`), NOT a phrase like "playDebug / amazonDebug". Put any
  description in `label`, the application id in `packageName` (the bare id, nothing else),
  and reasoning in `why`. **Mark the one a tester should use** with
  `"recommendedForTesting": true`, and say `why`. Mark the dangerous ones `false` and
  say why there too — a build that shares an application id with the real store app will
  REPLACE a real install, and we cannot tell that from the id.
- Which environment does each variant point at? `environment` is the `id` of an
  `environments[]` entry, or omit it — it is not a place to describe the environment.
  Which of those may be written to?
- Which languages does the UI run in? (An expectation is written in one of them.)

**Getting in — the highest-value section**
- What sign-in methods exist (Google, Apple, phone, email)?
- **Is there a developer/tester shortcut into the app?** A hidden tap target, a debug
  menu, a deep link, a build flag? Describe it as literal steps ("tap the app logo above
  the title, then pick a user from the slider, then tap Login"). This one field saves more
  time than everything else here, and makes runs far more reliable.
  If the shortcut is NOT a way to sign in — some apps have no sign-in at all, and the
  nearest thing is a developer-options unlock — say so in `whatItUnlocks`, and say how to
  undo it in `reversal`. We will not use it to reach a signed-in state.
- **If the app has no login at all, say that explicitly** as a finding
  (`{"topic": "signIn", "claim": "…"}`). An empty list reads as "nobody filled this in".
- Which test accounts exist, what is each one *for* ("has matches", "empty inbox",
  "premium", "brand new"), and where are their credentials kept?
- Which OS permissions are requested on first run, when, and should a tester allow or deny?
- Anything an agent genuinely cannot get through: captcha, real SMS/OTP, third-party
  consent screens.

**Getting back to a known state**
- How do you reset state? List every way separately, with its scope:
  - `client` — clearing app data (`kind` is one of: `ui-steps`, `deep-link`, `api`,
    `adb`, `tool`). What does it NOT undo? Put that in `whatItDoesNotUndo`.
    **The single most safety-critical answer in this whole file:** does clearing app data
    actually give a freshly-installed app? Set `constraints.clearProducesFreshInstall` to
    `true` / `false` / `"unknown"` explicitly. It is `false` if the app keeps data outside
    its own sandbox — a collection, database or export folder in shared storage survives
    `pm clear` AND uninstall. Such an app shows its first-run onboarding and then opens the
    previous data: it LOOKS reset, which is worse than failing, and a test that believes it
    started fresh produces a wrong verdict. **If you write in any reset's `whatItDoesNotUndo`
    that app content (a collection, database, files, a directory the OS keeps) survives,
    you MUST set `clearProducesFreshInstall` to `false` to match.** If you truly cannot
    establish where the data lives, use `"unknown"` — never guess `true`.
  - `backend` — a dev-init endpoint, a seed script, a "reset" button, an admin tool
  - `account` — resetting one user
- For each: the exact steps/endpoint/command, how long it takes, whether it is safe to run
  twice, and whether anything visible confirms it finished.
- **For each, say what it actually resets (`whatItResets`) and — more important — what it
  does NOT undo (`whatItDoesNotUndo`).** "Clearing app data does not touch a collection
  stored in shared storage" is the difference between a clean start and a test that
  silently inherits the last run's data while we believe we reset it. If a reset can
  destroy something real, put that in `danger`.
- Are there **named starting conditions** already written down ("Base Condition: backend
  initialised, logged in as User 7, permissions granted")? Copy them verbatim into
  `baseConditions` — they are the vocabulary the test runner plans around.

**What the app is made of**
- The main screens: name, how you reach one from the previous one, what it is for, and the
  controls a test would name. Flag a screen whose content is a **WebView**
  (`"webview": true`) — its content is not in the accessibility tree, so a tester reads it
  from the screenshot alone. Flag one that hands off to another app (`"external": true`),
  and put anything irreversible that lives on it in `danger`.
- The main flows end to end (sign-up, the core loop, purchase, settings).
- Business rules that decide whether a result is correct ("a match needs a mutual like",
  "coins are only spent on send"). A tester cannot judge an outcome without these.

**Test shortcuts (back doors) — high value**
- Beyond what the owner told you in the interview, SEARCH the code for non-UI ways to set up
  state or check a result, and record each in `shortcuts[]`:
  - **deep links / URL schemes / intent filters** (an `<intent-filter android:scheme>`, a
    universal link, `adb shell am start -d`) — especially any that carry a user/token so a
    test can jump to a screen or log in without the UI. `kind: "deep-link"`.
  - **launch arguments / intent extras / build flags** read at startup (a UI-less login, a
    seed toggle). `kind: "launch-arg"`.
  - **dev/test endpoints** — a reset, seed, create-user, or feature-flag route (often gated
    behind a debug build or a header). `kind: "api"`, and say if it's for `setup` or `verify`.
  - a **dev/debug page or hidden menu** (`kind: "dev-page"`), or a **dev/staging database**
    the tester could seed or read (`kind: "database"`).
- For each: `does` (what it accomplishes, in words), `use` (setup / verify / reset / login /
  navigate), `how` (the deep link, endpoint, page, or query — dev/staging, no secret), and
  `auth` as a REFERENCE (`env:NAME`) if it needs one. These are dev/staging only.

**Limits and danger**
- Which screens block screen capture (`FLAG_SECURE`)? Evidence there will be black, and we
  need to know in advance rather than discover it mid-run.
- Rate limits, known-flaky areas, anything requiring network or a VPN.
- **What must never happen?** Real payments, messages to real users, push notifications to
  production devices, deleting accounts, emails to real addresses. Be explicit and
  generous here — this becomes a hard rule the agent is given.
- What may a test freely create or modify, and what must it leave alone? How is test data
  kept apart from real data, and does anything need cleaning up afterwards?

**What already exists**
- What existing test cases are there — roughly WHERE (in words, e.g. "unit tests under the
  app module", NOT a file path), what format, and roughly how many? Manual checklists in
  markdown count, and so do Gherkin features and spreadsheets. Use `where` for the rough
  description; do not put a file path.
- Any analytics events worth asserting on.

**When a section is genuinely empty**

If you searched and there is nothing — no test accounts, no written base conditions, no
existing test cases, nothing blocking screen capture — **say so as a finding**, with the
same `source`/`confidence` as any other claim:

```json
{ "topic": "accounts", "claim": "There are no test accounts in this project: no credentials file, no env-var references, no fixtures.", "confidence": "inferred" }
```

An empty array and a checked-and-empty array look identical to us, and only one of them
means a human has to go and find out. `findings` is also the place for anything true and
useful that no field above fits ("the app works fully offline", "most of the review screen's
text comes from the user's own deck, not from the app").

## Output

Write `smartmonkey/profile.json` matching the schema below. **Stamp two provenance
fields** so the profile stays honest about its age:
- `generatedAt`: today's date.
- `commit`: the repo's current commit — run `git rev-parse HEAD` and paste the sha. (If
  the tree isn't a git repo, omit it.)

The `commit` is the ONLY code reference in the file. `smartmonkey check` runs later in the
repo, diffs the working tree against it, and flags when the code has moved so the owner can
re-profile — all locally, so no paths ever leave the machine. Then print a short summary:
what you found, what you had to infer, and the open questions. The owner answers the open
questions inside SmartMonkey after uploading — so don't wait for answers here; just make
sure each one is captured in `openQuestions[]` (with `options` when the answer is a choice).

```jsonc
{
  "smartmonkeyProfile": 1,
  "generatedAt": "2026-09-20",
  "commit": "<paste the output of: git rev-parse HEAD>",
  "project": { "name": "", "oneLiner": "", "platforms": ["android"], "stack": [], "locales": ["tr"] },
  "app": {
    "name": "",
    "variants": [
      { "id": "dev", "packageName": "com.acme.app.development", "label": "Development",
        "environment": "dev", "recommendedForTesting": true,
        "why": "installs alongside the real app; points at the dev backend",
        "confidence": "documented" }
    ]
  },
  "environments": [
    { "id": "dev", "backend": "local emulator suite", "mayWrite": true, "resettable": true,
      "confidence": "documented" }
  ],
  "access": {
    "signInMethods": ["google", "apple", "phone"],
    "devLogin": {
      "available": true, "kind": "ui-steps",
      "steps": ["On the sign-in screen, tap the app logo above the title",
                "Pick a user with the slider", "Tap Login"],
      "success": "The discover screen loads with the bottom navigation visible",
      "confidence": "documented"
    },
    "permissionsOnFirstRun": [
      { "permission": "location", "whenAsked": "immediately after first login",
        "recommended": "allow", "confidence": "documented" }
    ]
  },
  "accounts": [
    { "label": "user7", "identifier": "user7@example.com", "credentialsRef": "smartmonkey",
      "properties": ["has matches", "used by Base Condition"],
      "environment": "dev", "confidence": "documented" }
  ],
  "stateReset": [
    { "id": "backend_init", "scope": "backend", "kind": "ui-steps",
      "steps": ["Open the dev tester UI", "Tap Init dev backend"],
      "durationSeconds": 10, "idempotent": true, "feedback": "none — it is silent",
      "whatItResets": "every user, match and message in the dev project",
      "whatItDoesNotUndo": "files already uploaded to storage, and the device's own app data",
      "confidence": "documented" }
  ],
  "baseConditions": [
    { "id": "base_1", "description": "Backend initialised, logged in as User 7, permissions granted, first profile ready",
      "reset": ["backend_init"], "account": "user7",
      "given": ["notification permission granted", "location permission granted"],
      "confidence": "documented" }
  ],
  "screens": [
    { "id": "discover", "name": "Keşfet", "reachedBy": "first tab of the bottom navigation",
      "elements": ["like button", "pass button"], "confidence": "documented" }
  ],
  "flows": [],
  "businessRules": [
    { "rule": "A match requires both users to like each other", "confidence": "documented" }
  ],
  "shortcuts": [
    { "kind": "deep-link", "name": "Open a chat thread", "does": "jumps straight to a conversation",
      "use": ["navigate", "setup"], "how": "vegan://chat/{userId}", "confidence": "documented" },
    { "kind": "api", "name": "Seed a match", "does": "creates a mutual like so a chat exists",
      "use": ["setup"], "how": "POST {DEV_API}/test/seed-match {a,b}", "auth": "env:QA_DEV_API_TOKEN", "confidence": "asked" }
  ],
  "constraints": {
    "clearProducesFreshInstall": true,
    "screenshotBlocked": [],
    "blockedSignIns": ["Google consent screen cannot be completed by an agent"],
    "knownFlaky": []
  },
  "prohibited": [
    { "action": "Never send a message to a user that is not a test account", "why": "real people receive it" },
    { "action": "Never complete a real purchase", "why": "charges a card" }
  ],
  "testData": { "mayCreate": ["test users via the tester tool"], "mustNotTouch": ["pre-existing preprod users"], "isolation": "", "cleanup": "" },
  "testGuidance": { "priorities": ["matching + chat", "the paywall"], "coverage": "smoke", "cleanup": "delete any users I create via the tester tool afterwards" },
  "existingTests": [
    { "where": "manual QA checklists in the docs folder", "format": "markdown", "count": 29, "confidence": "documented" }
  ],
  "analytics": [],
  "findings": [
    { "topic": "accounts", "claim": "There are no test accounts in this project — searched docs/, CI config and fixtures.",
      "confidence": "inferred" }
  ],
  "openQuestions": [
    { "question": "Which account may we use on preprod?", "whyItMatters": "runs there write real data", "blocks": "run" },
    { "question": "Which Android version will runs target?", "whyItMatters": "decides whether clearing data really resets",
      "blocks": "run", "options": ["Android 11 or newer", "Android 10 or older"] }
  ]
  // openQuestions[].blocks is one of: "run" (a run cannot start), "coverage" (we lose
  // some cases), "nothing". stateReset[].kind is one of: ui-steps | deep-link | api |
  // adb | tool. Give screens[] and flows[] a short "id" alongside "name".
}
```

Rules the file must satisfy: every `baseConditions[].reset` names a real `stateReset[].id`
and every `baseConditions[].account` names a real `accounts[].label` (these drive the setup
steps, so they must resolve); no secret and no source path appears anywhere. Don't sweat
exact vocabulary elsewhere — we normalise ids, map close synonyms, and keep an accurate
sentence over a rejected one; an honest gap in `findings[]`/`openQuestions[]` always beats
a guess.

---

## Test cases — only if the interview said yes (question 1)

Do this section **only if I chose "profile AND test cases"** (interview question 1). If I
chose profile only, stop after the profile — SmartMonkey will generate cases later from the
app + your profile. When you do it here, it's the same privacy (nothing but the finished
cases leaves the machine) and I see and edit them before anything runs.

Use the source I chose in questions 2–3. Write **`smartmonkey/cases.json`**: a JSON array of
test cases in the shape below.

1. **You already have test cases — convert them.** They usually live OUTSIDE the code:
   Jira / Xray, TestRail, Zephyr, qTest, a Confluence page or a spreadsheet — plus any manual
   checklists or Gherkin features in the repo. Pull them from wherever they are (your own
   credentials, an MCP connector, or an export you paste in — this runs on your machine, so
   the access is yours), and translate each into one case in our shape: keep a sensible `id`
   (a Jira key like `PROJ-123` is fine), the title, and turn their steps + expected result
   into `steps[]` / `expected`.
2. **No existing cases — draft from what you found.** Use the profile you just built: one
   happy-path case per important `flow`, plus a negative case per `businessRule` that can be
   broken (wrong password, an empty required field, a limit exceeded). **Concentrate on the
   priorities I gave (`testGuidance.priorities`) and match the depth I chose
   (`testGuidance.coverage`: `smoke` = just the critical path; `broad` = wider).** Where a
   test SHORTCUT can set up state or check a result, lean on it instead of long UI navigation.
   Keep each case small — a handful of steps.

Every case:
- `requires` is a state from THIS profile's vocabulary — `fresh`, `logged_out`,
  `logged_in:<account label>`, or a `baseConditions[].id`. Omit it if the case runs from
  wherever it lands.
- Steps are what a tester DOES, in plain words. Put reusable values in `data` and reference
  them as `{{key}}`. Every `expect` (and the case's `expected`) is a checkable observation.
- A case has EITHER `steps` OR a one-line `goal` (the agent plans the steps itself).
- **Same rule as the profile: no source.** A case describes behaviour on the screen — never
  a file path, class name, or pasted code.

```json
[
  {
    "id": "TC-1",
    "title": "Login with the wrong password",
    "priority": "high",
    "requires": "logged_out",
    "data": { "email": "qa@acme.com", "password": "wrong" },
    "steps": [
      { "do": "Open the login screen" },
      { "do": "Enter {{email}} and {{password}}, then submit",
        "expect": "An inline error says the credentials are invalid" }
    ],
    "expected": "The user stays on the login screen, not signed in"
  }
]
```

Fields: `id` (letters/digits/`._-`), `title`, optional `priority` (`low|medium|high|critical`),
optional `tags[]`, optional `requires`/`leaves` (a state slug), optional `data` (string
values for `{{placeholders}}`), then `steps[]` (each `{ "do", "expect"? }`) OR a `goal`
(one sentence), and `expected`. At most 500 cases, 50 steps each.

Then print how many cases you produced and where they came from (converted from Jira,
drafted from flows, …). The project owner imports `cases.json` in SmartMonkey (Test cases →
Import JSON → choose file).
