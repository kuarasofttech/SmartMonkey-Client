/**
 * The persistent local app server (stage 3a). Serves the app UI + the
 * smartmonkey/ dir, and runs the embedded blueprint agent, streaming its output
 * and interview over SSE. Single local user ⇒ one active run. Zero-dep.
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, extname, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { makeWebAsk, answerAsk, makeWebConnections, setConnection, startConnections } from './webask.mjs';
import { makePopTerminalRunCli } from './terminal.mjs';
import { makeHeadlessRunCli } from './headless.mjs';
import { QUESTIONS, normalizeAnswers, servicesFor, answersBlock } from './interview.mjs';
import { makeSecrets } from './secrets.mjs';
import * as embed from './embed.mjs';
import { DRIVERS, detectDrivers as defaultDetectDrivers } from './drivers.mjs';
import { APP_ID } from './lock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS = existsSync(join(__dirname, 'assets')) ? join(__dirname, 'assets') : resolve(__dirname, '../src/assets/blueprint-kit');
const PROMPT = () => readFileSync(join(ASSETS, 'builder-prompt.md'), 'utf8');
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.md': 'text/markdown; charset=utf-8' };

const readBody = req => new Promise((res) => { let b = ''; req.on('data', c => { if (b.length <= 1_000_000) b += c; }); req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch { res({}); } }); });
const sendJson = (res, obj, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const writeSse = (res, ev) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`);

// Run the logged-in CLI in the terminal the app was launched from (the original
// behavior; the fallback when we can't pop a window).
function inheritRunCli({ driver, prompt, cwd, onDone, onError }) {
  const child = spawn(driver.bin, [prompt], { stdio: 'inherit', cwd });
  child.on('exit', () => onDone());
  child.on('error', e => onError(e));
  return { launched: true, inTerminal: true };
}

const headlessRunCli = makeHeadlessRunCli();
const popRunCli = makePopTerminalRunCli();

// Default: run the CLI HEADLESS with progress in the browser (the interview is
// already answered in the app, so it needs no terminal). For a driver without a
// verified headless recipe, pop a terminal window; failing that, use the terminal
// the app was launched from. SMARTMONKEY_TERMINAL=pop|inherit forces a fallback.
function defaultRunCli(opts) {
  const force = process.env.SMARTMONKEY_TERMINAL;
  const tries = force === 'inherit' ? [] : force === 'pop' ? [popRunCli] : [headlessRunCli, popRunCli];
  for (const run of tries) {
    try { return run(opts); }
    catch (e) { if (e.code !== 'UNSUPPORTED') { opts.onError(e); return { launched: false }; } }
  }
  return inheritRunCli(opts);
}

export function createApp({ cwd = process.cwd(), secrets = makeSecrets(), modelFactory,
  detectDrivers = defaultDetectDrivers, runCli = defaultRunCli, openBrowser = () => {} } = {}) {
  const KIT = join(resolve(cwd), 'smartmonkey');
  const INTERVIEW = join(KIT, 'interview.json');
  let port = null;   // set by listen(); used to bring the browser back after a terminal-window run
  const loadAnswers = () => { try { return JSON.parse(readFileSync(INTERVIEW, 'utf8')); } catch { return null; } };
  const saveAnswers = a => { try { mkdirSync(KIT, { recursive: true }); writeFileSync(INTERVIEW, JSON.stringify(a, null, 2)); } catch {} };
  const make = modelFactory || ((provider, model, key) => embed.PROVIDERS[provider].make(key, model));
  const session = { status: 'idle', running: false, error: null, events: [], clients: new Set(), pendingAsk: null, pendingConnections: null, cliCancel: null, stopRequested: false, ai: { provider: null, model: null }, key: null, mode: 'embedded', driver: null };

  const emit = (type, data) => { const ev = { type, data }; session.events.push(ev); for (const r of session.clients) writeSse(r, ev); };
  const isDriverReady = () => session.driver && detectDrivers().some(d => d.id === session.driver);
  const ready = () => session.mode === 'cli' ? !!isDriverReady() : !!(session.ai.provider && session.key);
  const driversPayload = () => { const detected = detectDrivers(); return DRIVERS.map(d => ({ id: d.id, label: d.label, available: detected.some(x => x.id === d.id) })); };

  const serveFile = (res, file) => {
    if (!existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    createReadStream(file).pipe(res);
  };

  const finish = () => emit('done', { blueprint: existsSync(join(KIT, 'blueprint.json')) });
  const fail = e => { session.running = false; session.status = 'error'; session.error = e.message; emit('error', { message: e.message }); };

  function launchEmbedded(prompt) {
    const webask = makeWebAsk(session, emit);
    const webconn = makeWebConnections(session, emit);
    const base = embed.makeToolRunner(cwd, webask, webconn);
    const runTool = async (name, input) => { emit('tool', { name, summary: input?.path || input?.query || input?.args?.join(' ') || '' }); return base(name, input); };
    const callModel = make(session.ai.provider, session.ai.model, session.key);
    embed.runAgent({ prompt, callModel, runTool, onText: t => { if (t && t.trim()) emit('text', t); } })
      .then(() => { session.status = 'done'; session.running = false; finish(); })
      .catch(fail);
  }

  function launchCli(driver, prompt) {
    emit('text', `Starting ${driver.label}…`);
    let handle = null;
    handle = runCli({
      driver, prompt, cwd,
      onEvent: (type, data) => emit(type, data),
      onDone: () => {
        session.cliCancel = null; session.running = false; session.status = 'done'; finish();
        // A run in its own terminal window took the user away from the browser — bring them back to the result.
        if (handle && !handle.headless && !handle.inTerminal && port) openBrowser(`http://127.0.0.1:${port}/view.html`);
      },
      onError: e => { session.cliCancel = null; fail(e); },
    });
    session.cliCancel = handle && handle.cancel ? handle.cancel : null;
    if (!session.running) return;   // it already finished (or failed) synchronously
    if (handle && handle.headless) emit('text', `${driver.label} is building the blueprint in the background. Progress appears below; this page updates when it's done.`);
    else if (handle && handle.inTerminal) emit('text', `Running ${driver.label} in the terminal where you started \`smartmonkey app\`.`);
    else if (handle && handle.launched) emit('text', `A terminal window opened to run ${driver.label}. This page comes back when it finishes.`);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method;

    if (path === '/api/status' && method === 'GET') {
      return sendJson(res, {
        app: APP_ID,   // lets a second `smartmonkey app` confirm this is us before replacing it
        mode: session.mode,
        driver: session.driver,
        ai: { provider: session.ai.provider, model: session.ai.model, ready: ready() },
        keychain: { available: secrets.available() },
        blueprint: { exists: existsSync(join(KIT, 'blueprint.json')) },
        run: { status: session.status, error: session.error },
        pendingAsk: session.pendingAsk ? { id: session.pendingAsk.id, question: session.pendingAsk.question, options: session.pendingAsk.options } : null,
        pendingConnections: session.pendingConnections ? { id: session.pendingConnections.id, services: session.pendingConnections.services, status: session.pendingConnections.status } : null,
      });
    }

    if (path === '/api/drivers' && method === 'GET') {
      return sendJson(res, { drivers: driversPayload() });
    }

    if (path === '/api/ai' && method === 'POST') {
      const body = await readBody(req);
      if (body.mode === 'cli') {
        session.mode = 'cli';
        session.driver = body.driver || null;
        return sendJson(res, { ok: true, mode: 'cli', driver: session.driver, ready: ready(), drivers: driversPayload() });
      }
      const provider = body.provider;
      if (!provider || !embed.PROVIDERS[provider]) return sendJson(res, { error: 'unknown provider' }, 400);
      session.mode = 'embedded';
      session.ai.provider = provider;
      session.ai.model = body.model || embed.PROVIDERS[provider].defaultModel;
      if (body.key) { secrets.set(provider, body.key); session.key = body.key; }
      else { const loaded = secrets.get(provider); const r = embed.resolveProvider({ provider, key: loaded }); session.key = r.error ? null : r.key; }
      return sendJson(res, { ok: true, ready: ready(), keychain: { available: secrets.available() } });
    }

    if (path === '/api/interview' && method === 'GET') {
      return sendJson(res, { questions: QUESTIONS, saved: loadAnswers() });
    }

    if (path === '/api/generate' && method === 'POST') {
      if (session.running) return sendJson(res, { error: 'a run is already active' }, 409);
      const body = await readBody(req);
      // With answers, the interview already happened in the browser; without them
      // (older clients, the tests' agent-driven path) the agent interviews itself.
      const answers = body.answers ? normalizeAnswers(body.answers) : null;

      let driver = null;
      if (session.mode === 'cli') {
        driver = DRIVERS.find(x => x.id === session.driver);
        if (!driver || !detectDrivers().some(x => x.id === driver.id)) return sendJson(res, { error: 'selected CLI not available — choose a logged-in CLI' }, 400);
      } else if (!ready()) return sendJson(res, { error: 'AI not ready — set a provider + key first' }, 400);

      session.running = true; session.status = 'running'; session.error = null; session.events = [];
      session.pendingAsk = null; session.pendingConnections = null; session.stopRequested = false;
      if (answers) saveAnswers(answers);

      // Tools the answers draw on are connected (or skipped) BEFORE anything is built.
      const services = answers ? servicesFor(answers) : [];
      const gate = services.length ? makeWebConnections(session, emit)(services) : Promise.resolve(null);
      gate.then(summary => {
        if (session.stopRequested) { session.running = false; return; }
        const connections = summary && summary.replace(/^The user finished the connect step\.\s*/, '').replace(/\s*Now build the blueprint\.$/, '');
        const prompt = (answers ? answersBlock(answers, connections) : '') + PROMPT();
        if (driver) launchCli(driver, prompt); else launchEmbedded(prompt);
      });
      return sendJson(res, { ok: true }, 202);
    }

    if (path === '/api/events' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      for (const ev of session.events) writeSse(res, ev);
      session.clients.add(res);
      req.on('close', () => session.clients.delete(res));
      return;
    }

    if (path === '/api/answer' && method === 'POST') {
      const body = await readBody(req);
      return answerAsk(session, body.id, body.answer) ? sendJson(res, { ok: true }) : sendJson(res, { error: 'no matching pending question' }, 409);
    }

    if (path === '/api/connect' && method === 'POST') {
      const body = await readBody(req);   // { id, service, action: 'connect' | 'skip' }
      if (!setConnection(session, body.id, body.service, body.action)) return sendJson(res, { error: 'no matching pending connection' }, 409);
      return sendJson(res, { ok: true, status: session.pendingConnections?.status || null });
    }

    if (path === '/api/connections/start' && method === 'POST') {
      const body = await readBody(req);   // { id }
      if (startConnections(session, body.id)) return sendJson(res, { ok: true });
      const pc = session.pendingConnections;
      const pending = pc && pc.id === body.id ? Object.keys(pc.status).filter(k => pc.status[k] === 'pending') : null;
      return sendJson(res, { error: pending && pending.length ? 'connect or skip every tool first' : 'no matching pending connection', pending }, 409);
    }

    if (path === '/api/stop' && method === 'POST') {
      if (session.pendingAsk) answerAsk(session, session.pendingAsk.id, '');   // unblock a waiting ask
      if (session.pendingConnections) { const p = session.pendingConnections; session.pendingConnections = null; p.resolve('The user stopped the run at the connect step.'); }
      session.stopRequested = true;   // a build still waiting at the connect panel must not start
      if (session.cliCancel) { session.cliCancel(); session.cliCancel = null; session.running = false; }   // kill a headless run / stop watching a terminal window
      session.status = 'idle';
      // best-effort: no mid-turn abort; `running` stays set until the live loop settles, so a new generate is refused until then
      return sendJson(res, { ok: true });
    }

    // static: '/' → app.html; else try the smartmonkey/ dir, then bundled assets
    if (method === 'GET') {
      if (path === '/' || path === '') return serveFile(res, join(ASSETS, 'app.html'));
      const rel = decodeURIComponent(path).replace(/^\/+/, '');
      const kitFile = join(KIT, rel);
      if ((kitFile === KIT || kitFile.startsWith(KIT + sep)) && existsSync(kitFile) && !statSync(kitFile).isDirectory()) return serveFile(res, kitFile);
      const assetFile = join(ASSETS, rel);
      if ((assetFile === ASSETS || assetFile.startsWith(ASSETS + sep)) && existsSync(assetFile) && !statSync(assetFile).isDirectory()) return serveFile(res, assetFile);
      res.writeHead(404); res.end('not found'); return;
    }

    res.writeHead(404); res.end('not found');
  }

  const server = createServer((req, res) => { handle(req, res).catch(e => { try { sendJson(res, { error: e.message }, 500); } catch {} }); });
  return {
    server, session,
    listen(port) {
      return new Promise((resolve, reject) => {
        const onError = e => { server.removeListener('listening', onListening); reject(e); };
        const onListening = () => { server.removeListener('error', onError); port = server.address().port; resolve(port); };
        server.once('error', onError);
        server.listen(port, '127.0.0.1', onListening);
      });
    },
  };
}
