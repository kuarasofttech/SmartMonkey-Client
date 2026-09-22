# smartmonkey-client

Stage 3a of the SmartMonkey local client (a persistent local app: set your AI +
build the blueprint from the browser, with the interview in-page and secrets in
the OS keychain), on top of the CLI + embedded API-key mode across
Anthropic / OpenAI / Gemini. Dev builds read the kit assets from the organiclaw
repo; a published package bundles its own `assets/`.

## Install

Zero runtime deps, Node ≥ 18. Run a one-off with `npx` (nothing to install):

```
npx smartmonkey-client app
```

…or install globally for a short `smartmonkey` command:

```
npm i -g smartmonkey-client
```

```
smartmonkey app          # run the local app: set your AI, build the blueprint in your browser
smartmonkey run          # blueprint (auto-picks your logged-in AI CLI), then opens the editor
smartmonkey view         # open the local viewer + case editor
smartmonkey check --watch # has the code moved since the blueprint was built?
smartmonkey drivers      # which AI CLIs are available here
smartmonkey init         # just scaffold ./smartmonkey/
```

Want the bleeding edge (tracks `main`)? Install from GitHub instead:

```
npm i -g github:kuarasofttech/SmartMonkey-Client
```

## The AI runs on your side

`smartmonkey run` builds the blueprint with **your own AI**, on your machine, two
ways — it auto-picks whichever fits:

**A logged-in CLI you already have** — **Claude Code, OpenAI Codex, Cursor, or
Gemini**. `smartmonkey run` hands it the blueprint prompt in your repo; it reads
your code and writes `smartmonkey/blueprint.json` (and `cases.json` if you ask).

- `--driver <claude|codex|cursor|gemini>` — force one instead of auto-picking.

**Your API key (embedded, no CLI needed)** — pass `--key <API key>` and
`smartmonkey` runs a small built-in agent itself. It reads the repo through
read-only tools, interviews you in the terminal, and writes **only**
`smartmonkey/*.json` — nothing else on disk is touched. **Anthropic, OpenAI, and
Gemini** keys all work; the provider is inferred from the key's shape (or your
environment), and each has a sensible default model you can override:

| Provider | Inferred from | Env var | Default model |
| --- | --- | --- | --- |
| Anthropic | `sk-ant-…` | `ANTHROPIC_API_KEY` | `claude-sonnet-5` |
| OpenAI | `sk-…` | `OPENAI_API_KEY` | `gpt-5-mini` |
| Gemini | `AIza…` | `GEMINI_API_KEY` / `GOOGLE_API_KEY` | `gemini-flash-latest` |

- `--key <API key>` — run embedded with your own key.
- `--provider <anthropic|openai|gemini>` — force one (else inferred from the key/env).
- `--model <id>` — override the model.
- `--dry-run` — show what it would launch without running it.

Either way: we never see your code. The AI runs on your machine and only the
`blueprint.json` / `cases.json` you approve is ever shared.

## The app

`smartmonkey app` starts a small local web app (in your browser, on your machine).
Pick your AI provider and paste your key once — it's stored in your OS keychain —
then click **Build blueprint**: it reads your repo and interviews you right in the
page (real dropdowns/checkboxes), and writes `smartmonkey/blueprint.json` for you
to review. Nothing but the blueprint you approve leaves your machine. The app runs
in the foreground; Ctrl-C to stop.

## Privacy

The blueprint carries **no source**: no file paths, no line numbers, no
class/package names, no pasted code — only your app's behaviour described in
words, anchored to the build commit. Secrets are referenced (`env:NAME`), never
embedded. `smartmonkey check` diffs your working tree against that commit
locally to tell you whether the blueprint is still fresh.

## Develop

```
npm test        # runs the embedded-driver + provider-translator unit tests (no API key needed)
```

Zero runtime dependencies (Node ≥ 18 builtins only). The `assets/` directory is
the bundled blueprint kit (prompt, viewer/editor, freshness checker); it is kept
in sync from the SmartMonkey server's own copy.

## License

MIT — see [LICENSE](LICENSE).
