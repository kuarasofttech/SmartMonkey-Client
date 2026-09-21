# SmartMonkey blueprint kit

This folder teaches SmartMonkey how to test your app. You run one prompt in your
own repo; it writes a `blueprint.json` describing how a tester gets in, how to
reset state, and what must never happen. **Your source code never leaves your
machine — only `blueprint.json` does.**

## What's here

| File | What it is |
|------|------------|
| `smartmonkey-blueprint.md` | The prompt. Run it with your own AI coding agent (Claude Code, Cursor, Codex, Gemini CLI — any frontier model), inside your repo. |
| `view.html` | A local viewer + case editor. Read the blueprint (what you deliver to us), and view/edit/add test cases and download `cases.json`. Nothing is uploaded. |
| `blueprint.json` | Produced by the prompt. The one file you upload to SmartMonkey. |
| `cases.json` | Produced too, IF you keep the optional last section of the prompt — your test cases, converted or drafted. Import it in SmartMonkey. |

## How to use it

1. Drop this `smartmonkey/` folder at the root of the repo you want to test, and
   commit it.
2. Open your repo in your AI coding agent and give it the contents of
   `smartmonkey-blueprint.md`. It **starts by interviewing you** — a few numbered
   questions (where your test cases live, how to reach them, whether to generate
   `cases.json` now) — then reads your code and writes `smartmonkey/blueprint.json`.
   - Say **yes** to generating cases and it also writes `smartmonkey/cases.json`
     (converting your existing tests — from the repo or Jira/TestRail/Zephyr/qTest —
     or drafting new ones). Say **no** and SmartMonkey generates cases for you later.
   - Running headless (CI)? It takes safe defaults instead of asking.
3. **See what you're delivering:** open `view.html`.
   - Easiest: run `python3 -m http.server` in this folder and open
     `http://localhost:8000/view.html` — it loads `blueprint.json` automatically.
   - Or just double-click `view.html` and drag `blueprint.json` onto it.
   Nothing is uploaded; the page reads the file in your browser only.
4. Upload `blueprint.json` to SmartMonkey. If you generated `cases.json`, import it there
   too (Test cases → Import JSON → choose file).

## Keeping it fresh

Your app changes; the blueprint can go stale. It's anchored to the commit it was
built at (the only code reference in the file), and a quick check — run in your
repo — tells you when the code has moved:

```
node smartmonkey-check.mjs blueprint.json --list
```

- **fresh** — nothing has changed since the blueprint was built.
- **moved** — the code advanced; `--list` shows the changed files (they stay on
  your machine). Re-run the prompt (step 2) if any affect how the app is tested.

It's informational by default; add `--strict` to fail a build (exit 3) when the
code has moved, and wire that into a release gate. Add `--watch` to keep it
running and re-check every time the repo changes.

## What we can and can't see

- **We receive:** `blueprint.json` — your app's builds, screens, flows, reset
  steps, business rules, and the dangers you flagged, described in plain words.
- **We never receive your source.** No file paths, no line numbers, no class or
  package names, no pasted code — the only code reference in the file is the
  commit sha. And no secret: accounts reference credentials
  (`env:QA_PASSWORD`), never the values.
