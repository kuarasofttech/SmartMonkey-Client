#!/usr/bin/env node
/**
 * smartmonkey — the local client (stage 2 of project_smartmonkey_client_app).
 *
 * One tool instead of three loose files. It scaffolds the kit into your repo,
 * builds the blueprint through a PLUGGABLE DRIVER, serves the viewer/editor, and
 * checks freshness. Your source never leaves your machine — the driver runs on
 * YOUR side (your logged-in CLI, or later your API key) and only the text you
 * approve (blueprint.json / cases.json) is ever shared.
 *
 *   npx smartmonkey init            scaffold ./smartmonkey/ into this repo
 *   npx smartmonkey run             build the blueprint (auto-picks a driver)
 *   npx smartmonkey view            open the local viewer + case editor
 *   npx smartmonkey check [--watch] freshness — has the code moved?
 *   npx smartmonkey drivers         which AI CLIs are available here
 *
 * Zero dependencies (node builtins only).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, createReadStream, statSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, extname } from 'node:path';
import { DRIVERS, detectDrivers } from './drivers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Kit assets: a bundled copy next to the CLI when packaged/standalone, else the
// organiclaw repo's own src/assets during development. When bundled, EVERYTHING
// (including the blueprint prompt) lives under assets/ so the tool is fully
// self-contained; only the dev-in-monorepo path reaches back into src/.
const BUNDLED = existsSync(join(__dirname, 'assets'));
const ASSETS = BUNDLED ? join(__dirname, 'assets') : resolve(__dirname, '../src/assets/blueprint-kit');
const PROMPT_SRC = BUNDLED
  ? join(ASSETS, 'builder-prompt.md')
  : resolve(__dirname, '../src/assets/blueprint-prompt/builder-prompt.md');

const KIT_DIR = resolve(process.cwd(), 'smartmonkey');
const args = process.argv.slice(2);
const cmd = args.find(a => !a.startsWith('-')) || 'help';
const flag = name => args.includes('--' + name);
const opt = name => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : undefined; };

// ── scaffold ─────────────────────────────────────────────────────────────────
const KIT_FILES = [
  { from: PROMPT_SRC, to: 'builder-prompt.md' },
  { from: join(ASSETS, 'view.html'), to: 'view.html' },
  { from: join(ASSETS, 'smartmonkey-check.mjs'), to: 'smartmonkey-check.mjs' },
  { from: join(ASSETS, 'README.md'), to: 'README.md' },
];
function scaffold() {
  mkdirSync(KIT_DIR, { recursive: true });
  for (const f of KIT_FILES) {
    if (!existsSync(f.from)) { console.error(`missing kit asset: ${f.from}`); process.exit(2); }
    writeFileSync(join(KIT_DIR, f.to), readFileSync(f.from));   // refresh tool files; never touches blueprint.json/cases.json
  }
}
function ensureScaffold() { if (!existsSync(join(KIT_DIR, 'builder-prompt.md'))) scaffold(); }

// ── serve the viewer/editor ──────────────────────────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.md': 'text/markdown; charset=utf-8' };
function serve(port = 8899) {
  const server = createServer((req, res) => {
    let rel = decodeURIComponent((req.url || '/').split('?')[0]);
    if (rel === '/' || rel === '') rel = '/view.html';
    const file = join(KIT_DIR, rel.replace(/^\/+/, ''));
    if (!file.startsWith(KIT_DIR) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/view.html`;
    console.log(`viewer + case editor: ${url}  (Ctrl-C to stop)`);
    openBrowser(url);
  });
  return server;
}
function openBrowser(url) {
  if (process.env.SMARTMONKEY_NO_OPEN) return;   // tests / headless launches don't pop a browser
  const bin = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try { spawn(bin, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref(); } catch {}
}

// ── commands ─────────────────────────────────────────────────────────────────
function cmdDrivers() {
  const found = detectDrivers();
  console.log('AI drivers on this machine (the blueprinting runs on YOUR side):');
  for (const d of DRIVERS) console.log(`  ${found.includes(d) ? '✓' : '·'} ${d.label} (${d.bin})`);
  if (!found.length) console.log('\n  None found. Install/sign in to one (Claude Code, Codex, Cursor, Gemini),\n  or run embedded with your own key: --key <API key> (Anthropic, OpenAI, or Gemini).');
}

async function cmdRun() {
  ensureScaffold();
  const prompt = readFileSync(join(KIT_DIR, 'builder-prompt.md'), 'utf8');
  const { resolveProvider } = await import('./embed.mjs');

  // Pick the driver. Explicit --key/--provider ⇒ embedded (their API key). Else a
  // detected/forced CLI ⇒ orchestrate it. Else an env key ⇒ embedded. Else error.
  const wantEmbed = !!opt('key') || !!opt('provider');
  const found = detectDrivers();
  const forced = opt('driver');
  if (!wantEmbed && (found.length || forced)) return runViaCli(prompt, forced, found);

  const res = resolveProvider({ provider: opt('provider'), key: opt('key') });
  if (res.error) {
    console.error(`No AI available. Either sign in to a CLI (see \`smartmonkey drivers\`) and re-run,\nor pass --key <API key> (Anthropic, OpenAI, or Gemini). (${res.error})`);
    process.exit(2);
  }
  return runEmbedded(prompt, res);
}

function runViaCli(prompt, forced, found) {
  const driver = forced ? DRIVERS.find(d => d.id === forced || d.bin === forced) : found[0];
  if (!driver) { console.error(`driver "${forced}" not found on PATH.`); process.exit(2); }
  if (flag('dry-run')) {
    console.log(`would run (CLI): ${driver.bin} <the ${prompt.length}-char blueprint prompt>  (cwd: ${process.cwd()})`);
    console.log(`then serve ${join(KIT_DIR, 'view.html')}`);
    return;
  }
  console.log(`Building the blueprint with ${driver.label} in ${process.cwd()} …`);
  console.log('It interviews you, reads the repo, and writes smartmonkey/blueprint.json (+ cases.json if you asked).\n');
  const child = spawn(driver.bin, [prompt], { stdio: 'inherit', cwd: process.cwd() });
  child.on('exit', () => existsSync(join(KIT_DIR, 'blueprint.json'))
    ? (console.log('\nProfiling done. Opening the editor to review + edit before you upload…'), serve(Number(opt('port')) || 8899))
    : console.log('\nNo blueprint.json was written. Re-run, or open smartmonkey/builder-prompt.md yourself.'));
  child.on('error', e => { console.error(`could not launch ${driver.bin}: ${e.message}`); process.exit(2); });
}

async function runEmbedded(prompt, res) {
  const embed = await import('./embed.mjs');
  const P = embed.PROVIDERS[res.provider];
  const model = opt('model') || res.model;
  if (flag('dry-run')) { console.log(`would run (embedded/${res.provider}, model ${model}) the ${prompt.length}-char prompt in ${process.cwd()}, then serve.`); return; }
  const runTool = embed.makeToolRunner(process.cwd(), embed.makeAsk());
  const callModel = P.make(res.key, model);
  console.log(`Profiling with your API key (embedded, ${P.label} · ${model}). It will interview you, read the repo,\nand write smartmonkey/blueprint.json (+ cases.json). Nothing else on disk is touched.\n`);
  let r;
  try { r = await embed.runAgent({ prompt, callModel, runTool, onText: t => process.stdout.write(t.trim() ? t + '\n' : '') }); }
  catch (e) { console.error('\nrun failed: ' + e.message); process.exit(2); }
  if (embed.producedBlueprint(process.cwd())) { console.log('\nDone. Opening the editor to review + edit before you upload…'); serve(Number(opt('port')) || 8899); }
  else console.log(`\nNo blueprint.json was written (${r?.reason || 'the model stopped'}). Try again, or use --driver <cli>.`);
}

function cmdCheck() {
  const blueprint = join(KIT_DIR, 'blueprint.json');
  if (!existsSync(blueprint)) { console.error('no smartmonkey/blueprint.json yet — run `smartmonkey run` first.'); process.exit(2); }
  const pass = args.filter(a => a.startsWith('-'));
  const r = spawnSync(process.execPath, [join(ASSETS, 'smartmonkey-check.mjs'), blueprint, '--repo', process.cwd(), ...pass], { stdio: 'inherit' });
  process.exit(r.status ?? 0);
}

async function cmdApp() {
  ensureScaffold();                       // so view.html/blueprint.json render for review
  const { createApp } = await import('./server.mjs');
  const { ensureSingleInstance, writeLock, removeLock, probeApp } = await import('./lock.mjs');
  const { chooseListen } = await import('./serve-port.mjs');
  const explicit = opt('port') !== undefined;   // did the user name a port, or is 8899 the default?
  const wantPort = Number(opt('port')) || 8899;

  // Exactly one app per user: replace any instance already running (see lock.mjs).
  await ensureSingleInstance({ log: msg => console.log(msg) });

  // Pick a port without ever dead-ending on a busy one (see serve-port.mjs).
  const app = createApp({ cwd: process.cwd() });
  const tryListen = async p => { try { await app.listen(p); return true; } catch (e) { if (e.code === 'EADDRINUSE') return false; throw e; } };
  const outcome = await chooseListen({ tryListen, probe: probeApp, wantPort, explicit });

  if (outcome.action === 'error') {
    console.error(`Port ${wantPort} is in use by another program — pick another with --port N.`);
    process.exit(2);
  }
  if (outcome.action === 'openExisting') {
    const url = `http://127.0.0.1:${outcome.port}/`;
    console.log(`SmartMonkey is already running: ${url} — opening it. (Ctrl-C is in that other terminal.)`);
    openBrowser(url);
    return;   // do NOT start a second server or touch the lock
  }

  const port = outcome.port;
  writeLock({ pid: process.pid, port, cwd: process.cwd(), startedAt: new Date().toISOString() });
  const cleanup = () => removeLock();
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(0); });

  const url = `http://127.0.0.1:${port}/`;
  if (port !== wantPort) console.log(`Port ${wantPort} was busy — using ${port} instead.`);
  console.log(`SmartMonkey app: ${url}  (Ctrl-C to stop)`);
  openBrowser(url);
}

function help() {
  console.log(`smartmonkey — local client for SmartMonkey QA blueprinting (your source never leaves your machine)

  smartmonkey init             scaffold ./smartmonkey/ into this repo
  smartmonkey run              build the blueprint; opens the editor when done
                   [--driver X]  force a CLI (claude|codex|cursor|gemini)
                   [--key K]     run embedded with your API key (no CLI needed)
                   [--provider P] anthropic|openai|gemini (else inferred from the key/env)
                   [--model M] [--dry-run] [--port N]
  smartmonkey app [--port N]   run the local app (setup + build the blueprint in your browser)
  smartmonkey view [--port N]  open the local viewer + case editor
  smartmonkey check [--watch]  freshness — has the code moved since the blueprint?
                   [--strict] [--list]
  smartmonkey drivers          which AI CLIs are available here

The blueprinting runs on YOUR machine via your own logged-in CLI; only the
blueprint.json / cases.json you approve is ever shared.`);
}

switch (cmd) {
  case 'init': scaffold(); console.log(`scaffolded ${KIT_DIR}`); break;
  case 'run': cmdRun().catch(e => { console.error(e.message); process.exit(2); }); break;
  case 'app': cmdApp().catch(e => { console.error(e.message); process.exit(2); }); break;
  case 'view': ensureScaffold(); serve(Number(opt('port')) || 8899); break;
  case 'check': cmdCheck(); break;
  case 'drivers': cmdDrivers(); break;
  default: help();
}
