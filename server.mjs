/**
 * The persistent local app server (stage 3a). Serves the app UI + the
 * smartmonkey/ dir, and runs the embedded blueprint agent, streaming its output
 * and interview over SSE. Single local user ⇒ one active run. Zero-dep.
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, extname, dirname, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { suggestFor, previousAnswers } from './prefill.mjs';
import { makeWebAsk, answerAsk, makeWebConnections, setConnection, startConnections } from './webask.mjs';
import { makePopTerminalRunCli } from './terminal.mjs';
import { makeHeadlessRunCli } from './headless.mjs';
import { QUESTIONS, normalizeAnswers, servicesFor, answersBlock, runBlock, basedOnBlock } from './interview.mjs';
import { makeSecrets } from './secrets.mjs';
import * as embed from './embed.mjs';
import { DRIVERS, detectDrivers as defaultDetectDrivers } from './drivers.mjs';
import { APP_ID } from './lock.mjs';
import { makeBuildStore } from './buildstore.mjs';
import { CONNECTORS, COMING_LATER, findConnector, findTool, allTools } from './connectors/index.mjs';

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
  detectDrivers = defaultDetectDrivers, runCli = defaultRunCli, openBrowser = () => {}, askPollMs = 25_000, connectorFetch = fetch } = {}) {
  const KIT = join(resolve(cwd), 'smartmonkey');
  const INTERVIEW = join(KIT, 'interview.json');
  const builds = makeBuildStore(KIT);

  // ---- connections: the app holds the keys (OS keychain) and makes the calls; the agent never sees a key ----
  // Keys are PER PROJECT: one app's Linear workspace is never used for another project.
  const projectKey = createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 12);
  const credKey = c => `connector:${c.id}:${projectKey}`;
  const loadCreds = c => { try { const raw = c && secrets.get(credKey(c)); return raw ? JSON.parse(raw) : null; } catch { return null; } };
  const accountFor = name => { const c = findConnector(name); const cr = loadCreds(c); return cr ? (cr._account || 'connected') : null; };
  const connectionOpts = { isConnectable: name => !!findConnector(name), accountFor };
  const summarizeInput = input => JSON.stringify(input || {}).slice(0, 200);
  async function callConnector(toolName, input) {
    const t = findTool(toolName); const c = t && findConnector(t.connector);
    const creds = loadCreds(c);
    if (!creds) return `${c.label} isn't connected in SmartMonkey. Call request_connections with "${c.label}" so the owner can connect it — don't guess its contents.`;
    const text = await t.run(creds, input, { fetchImpl: connectorFetch });
    builds.recordCall(session.buildId, { tool: toolName, input: summarizeInput(input), chars: text.length, ok: !/^\w+ error:/.test(text), at: new Date().toISOString() });
    return text;
  }
  builds.recover();   // a build still marked running from a previous app session did not finish
  builds.importLegacy();   // a blueprint made before history existed shows up as the last build right away
  let port = null;   // set by listen(); used to bring the browser back after a terminal-window run
  const loadAnswers = () => { try { return JSON.parse(readFileSync(INTERVIEW, 'utf8')); } catch { return null; } };
  const saveAnswers = a => { try { mkdirSync(KIT, { recursive: true }); writeFileSync(INTERVIEW, JSON.stringify(a, null, 2)); } catch {} };
  // What the owner answered DURING a run, offered back first next time (smartmonkey/owner-answers.json).
  const OWNER_ANSWERS = join(KIT, 'owner-answers.json');
  const loadOwnerAnswers = () => { try { const j = JSON.parse(readFileSync(OWNER_ANSWERS, 'utf8')); return Array.isArray(j.answers) ? j.answers : []; } catch { return []; } };
  const recordOwnerAnswer = (question, picked) => {
    const answer = picked.join(', ');
    if (!question || !answer) return;
    const list = loadOwnerAnswers().filter(x => x.question !== question);
    list.push({ question, answer, picked, at: new Date().toISOString() });
    try { mkdirSync(KIT, { recursive: true }); writeFileSync(OWNER_ANSWERS, JSON.stringify({ answers: list.slice(-40) }, null, 2)); } catch {}
  };
  // Mid-run questions from a headless CLI arrive over HTTP from ask-mcp.mjs. The token
  // (per app instance) keeps anything else on the machine from injecting questions.
  const askToken = randomBytes(24).toString('hex');
  const agentAsks = new Map();   // id → { answer: undefined | string, waiters: [] }
  let agentAskN = 0, askChain = Promise.resolve();   // one question on screen at a time
  const releaseAgentAsks = () => { for (const e of agentAsks.values()) if (e.answer === undefined) { e.answer = ''; e.waiters.splice(0).forEach(w => w()); } };
  const make = modelFactory || ((provider, model, key) => embed.PROVIDERS[provider].make(key, model));
  const session = { status: 'idle', running: false, error: null, events: [], clients: new Set(), pendingAsk: null, pendingConnections: null, cliCancel: null, gen: 0, webask: null, buildId: null, ai: { provider: null, model: null }, key: null, mode: 'embedded', driver: null };

  const emit = (type, data) => { const ev = { type, data }; session.events.push(ev); if (session.buildId) builds.appendEvent(session.buildId, ev); for (const r of session.clients) writeSse(r, ev); };
  const isDriverReady = () => session.driver && detectDrivers().some(d => d.id === session.driver);
  const ready = () => session.mode === 'cli' ? !!isDriverReady() : !!(session.ai.provider && session.key);
  const driversPayload = () => { const detected = detectDrivers(); return DRIVERS.map(d => ({ id: d.id, label: d.label, available: detected.some(x => x.id === d.id) })); };

  const serveFile = (res, file) => {
    if (!existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    createReadStream(file).pipe(res);
  };

  const finish = () => { emit('done', { blueprint: existsSync(join(KIT, 'blueprint.json')), build: session.buildId }); builds.finish(session.buildId, 'done'); };
  const fail = e => { session.running = false; session.status = 'error'; session.error = e.message; emit('error', { message: e.message }); builds.finish(session.buildId, 'error', { error: e.message }); };

  function launchEmbedded(prompt, gen) {
    const live = () => gen === session.gen;
    const stopped = () => { const e = new Error('stopped'); e.stopped = true; return e; };
    const webconn = makeWebConnections(session, emit, connectionOpts);
    const base = embed.makeToolRunner(cwd, session.webask, webconn);
    const runTool = async (name, input) => { if (!live()) throw stopped(); emit('tool', { name, summary: input?.path || input?.query || input?.question || input?.id || input?.args?.join(' ') || '' }); return findTool(name) ? callConnector(name, input) : base(name, input); };
    const model = make(session.ai.provider, session.ai.model, session.key);
    const callModel = async (...a) => { if (!live()) throw stopped(); return model(...a); };
    const tools = [...embed.TOOLS, ...allTools().map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }))];
    embed.runAgent({ prompt, callModel, runTool, tools, onText: t => { if (live() && t && t.trim()) emit('text', t); } })
      .then(() => { if (!live()) return; session.status = 'done'; session.running = false; finish(); })
      .catch(e => { if (live()) fail(e); });
  }

  function launchCli(driver, prompt, gen) {
    const live = () => gen === session.gen;
    emit('text', `Starting ${driver.label}…`);
    let handle = null;
    handle = runCli({
      driver, prompt, cwd,
      askBridge: port ? { url: `http://127.0.0.1:${port}/api/agent-ask`, token: askToken } : null,
      onEvent: (type, data) => { if (live()) emit(type, data); },
      onDone: () => {
        if (!live()) return;
        session.cliCancel = null; session.running = false; session.status = 'done'; finish();
        // A run in its own terminal window took the user away from the browser — bring them back to the result.
        if (handle && !handle.headless && !handle.inTerminal && port) openBrowser(`http://127.0.0.1:${port}/view.html`);
      },
      onError: e => { if (!live()) return; session.cliCancel = null; fail(e); },
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
        project: { name: basename(resolve(cwd)) },
        mode: session.mode,
        driver: session.driver,
        ai: { provider: session.ai.provider, model: session.ai.model, ready: ready() },
        keychain: { available: secrets.available() },
        blueprint: { exists: existsSync(join(KIT, 'blueprint.json')) },
        run: { status: session.status, error: session.error, startedAt: session.startedAt || null },
        pendingAsk: session.pendingAsk ? { id: session.pendingAsk.id, question: session.pendingAsk.question, options: session.pendingAsk.options, multi: !!session.pendingAsk.multi, suggested: session.pendingAsk.suggested } : null,
        pendingConnections: session.pendingConnections ? { id: session.pendingConnections.id, services: session.pendingConnections.services, status: session.pendingConnections.status, connectable: session.pendingConnections.connectable, accounts: session.pendingConnections.accounts } : null,
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

    if (path === '/api/agent-ask' && method === 'POST') {
      if (req.headers['x-smartmonkey-token'] !== askToken) return sendJson(res, { error: 'forbidden' }, 403);
      if (!session.running || !session.webask) return sendJson(res, { error: 'no build is running' }, 409);
      const body = await readBody(req);
      const id = 'aa_' + (++agentAskN);
      const entry = { answer: undefined, waiters: [] };
      agentAsks.set(id, entry);
      const gen = session.gen, ask = session.webask;
      const options = Array.isArray(body.options) ? body.options.map(String).filter(Boolean).slice(0, 12) : [];
      const services = Array.isArray(body.services) ? body.services.map(String).filter(Boolean) : [];
      const connect = () => makeWebConnections(session, emit, connectionOpts)(services)
        .then(sum => String(sum).replace(/^The user finished the connect step\.\s*/, '').replace(/\s*Now build the blueprint\.$/, ''));
      askChain = askChain
        .then(() => (gen !== session.gen || entry.answer !== undefined ? ''
          : body.kind === 'connections' ? connect()
          : ask(String(body.question || ''), options, !!body.multi)))
        .then(ans => { if (entry.answer === undefined) entry.answer = ans; entry.waiters.splice(0).forEach(w => w()); });
      return sendJson(res, { id });
    }

    if (path.startsWith('/api/agent-ask/') && method === 'GET') {
      if (req.headers['x-smartmonkey-token'] !== askToken) return sendJson(res, { error: 'forbidden' }, 403);
      const entry = agentAsks.get(decodeURIComponent(path.slice('/api/agent-ask/'.length)));
      if (!entry) return sendJson(res, { error: 'unknown question' }, 404);
      if (entry.answer === undefined) await new Promise(r => { entry.waiters.push(r); setTimeout(r, askPollMs); });
      return entry.answer === undefined ? sendJson(res, { pending: true }) : sendJson(res, { answer: entry.answer });
    }

    if (path === '/api/connectors' && method === 'GET') {
      return sendJson(res, {
        connectors: CONNECTORS.map(c => { const cr = loadCreds(c); return { id: c.id, label: c.label, fields: c.fields.map(({ id, label, help, secret }) => ({ id, label, help, secret })), status: cr ? 'connected' : 'not_set_up', account: cr ? cr._account || null : null }; }),
        comingLater: COMING_LATER,
        keychain: secrets.available(),
      });
    }
    const cm = path.match(/^\/api\/connectors\/([\w-]+)$/);
    if (cm) {
      const c = CONNECTORS.find(x => x.id === cm[1]);
      if (!c) return sendJson(res, { error: 'unknown connector' }, 404);
      if (method === 'DELETE') { secrets.delete(credKey(c)); return sendJson(res, { ok: true }); }
      if (method === 'POST') {
        const body = await readBody(req);
        const fields = {}; for (const f of c.fields) fields[f.id] = String((body.fields || {})[f.id] || '').trim();
        const t = await c.test(fields, { fetchImpl: connectorFetch });   // only a key that really works is saved
        if (!t.ok) return sendJson(res, { error: t.error || 'the test call failed' }, 400);
        secrets.set(credKey(c), JSON.stringify({ ...fields, _account: t.account }));
        return sendJson(res, { ok: true, account: t.account });
      }
    }

    if (path === '/api/connector-call' && method === 'POST') {
      if (req.headers['x-smartmonkey-token'] !== askToken) return sendJson(res, { error: 'forbidden' }, 403);
      if (!session.running) return sendJson(res, { error: 'no build is running' }, 409);
      const body = await readBody(req);
      if (!findTool(body.tool)) return sendJson(res, { error: 'unknown tool' }, 404);
      return sendJson(res, { text: await callConnector(body.tool, body.input || {}) });
    }

    if (path === '/api/builds' && method === 'GET') {
      return sendJson(res, { builds: builds.list() });
    }
    const bm = path.match(/^\/api\/builds\/([^/]+)(\/current)?$/);
    if (bm) {
      const id = decodeURIComponent(bm[1]);
      try {
        if (method === 'GET' && !bm[2]) return sendJson(res, builds.get(id));
        if (method === 'POST' && bm[2]) { if (session.running) return sendJson(res, { error: 'a build is running' }, 409); builds.makeCurrent(id); return sendJson(res, { ok: true }); }
        if (method === 'DELETE' && !bm[2]) { builds.remove(id); return sendJson(res, { ok: true }); }
      } catch (e) {
        return sendJson(res, { error: e.message }, /unknown build/.test(e.message) ? 404 : 409);
      }
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
      const basedOn = typeof body.basedOn === 'string' && body.basedOn ? body.basedOn : null;
      if (basedOn && !builds.list().some(b => b.id === basedOn)) return sendJson(res, { error: 'unknown build to start from' }, 400);

      let driver = null;
      if (session.mode === 'cli') {
        driver = DRIVERS.find(x => x.id === session.driver);
        if (!driver || !detectDrivers().some(x => x.id === driver.id)) return sendJson(res, { error: 'selected CLI not available — choose a logged-in CLI' }, 400);
      } else if (!ready()) return sendJson(res, { error: 'AI not ready — set a provider + key first' }, 400);

      // Every run gets a generation number; Stop bumps it, so a stopped run's late results are ignored.
      const gen = ++session.gen;
      session.running = true; session.status = 'running'; session.error = null; session.events = []; session.startedAt = new Date().toISOString();
      session.pendingAsk = null; session.pendingConnections = null;
      // A re-run pre-selects what the owner chose last time: from the build it starts
      // from, when there is one, over the latest answers on record.
      const previous = previousAnswers(loadOwnerAnswers(), basedOn ? builds.get(basedOn).events : []);
      session.webask = makeWebAsk(session, emit, { suggest: (q, o, m) => suggestFor(q, o, m, previous) });
      agentAsks.clear();
      // Every build is kept: a clean start sets the current blueprint aside; "build on" places an older one.
      builds.prepareStart({ basedOn });
      session.buildId = builds.create({ driver: driver ? driver.id : session.ai.provider, basedOn });
      if (answers) saveAnswers(answers);

      // Tools the answers draw on are connected (or skipped) BEFORE anything is built.
      const services = answers ? servicesFor(answers) : [];
      const gate = services.length ? makeWebConnections(session, emit, connectionOpts)(services) : Promise.resolve(null);
      gate.then(summary => {
        if (gen !== session.gen) return;   // stopped while waiting at the connect panel
        const connections = summary && summary.replace(/^The user finished the connect step\.\s*/, '').replace(/\s*Now build the blueprint\.$/, '');
        // Pre-supplied answers (API callers) skip the interview; otherwise it happens during the run.
        const start = basedOn ? basedOnBlock(builds.get(basedOn).meta) : '';
        const connected = CONNECTORS.map(c => ({ c, cr: loadCreds(c) })).filter(x => x.cr).map(({ c, cr }) => ({ label: c.label, account: cr._account, tools: c.tools.map(t => t.name) }));
        const prompt = (answers ? answersBlock(answers, connections) : runBlock(previous, connected)) + start + PROMPT();
        if (driver) launchCli(driver, prompt, gen); else launchEmbedded(prompt, gen);
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
      const pa = session.pendingAsk;
      if (pa && pa.id === body.id) {
        const picked = [].concat(body.answer ?? []).map(String).filter(Boolean);
        emit('answered', { id: pa.id, question: pa.question, options: pa.options || [], multi: !!pa.multi, picked, answer: picked.join(', ') });
        recordOwnerAnswer(pa.question, picked);
      }
      return answerAsk(session, body.id, body.answer) ? sendJson(res, { ok: true }) : sendJson(res, { error: 'no matching pending question' }, 409);
    }

    if (path === '/api/connect' && method === 'POST') {
      const body = await readBody(req);   // { id, service, action: 'connect' | 'skip' }
      if (body.action === 'connect' && !accountFor(body.service)) return sendJson(res, { error: `${body.service} isn't set up yet — add it under Connections first` }, 409);
      if (!setConnection(session, body.id, body.service, body.action)) return sendJson(res, { error: 'no matching pending connection' }, 409);
      return sendJson(res, { ok: true, status: session.pendingConnections?.status || null });
    }

    if (path === '/api/connections/start' && method === 'POST') {
      const body = await readBody(req);   // { id }
      const outcome = session.pendingConnections;
      if (startConnections(session, body.id)) {
        builds.recordConnections(session.buildId, { services: outcome.services, status: outcome.status, accounts: outcome.accounts || {} });
        return sendJson(res, { ok: true });
      }
      const pc = session.pendingConnections;
      const pending = pc && pc.id === body.id ? Object.keys(pc.status).filter(k => pc.status[k] === 'pending') : null;
      return sendJson(res, { error: pending && pending.length ? 'connect or skip every tool first' : 'no matching pending connection', pending }, 409);
    }

    if (path === '/api/stop' && method === 'POST') {
      const wasRunning = session.running;
      session.gen++;   // the current run is now stale: whatever it reports later is ignored
      if (session.pendingAsk) answerAsk(session, session.pendingAsk.id, '');   // unblock a waiting question
      if (session.pendingConnections) { const p = session.pendingConnections; session.pendingConnections = null; p.resolve('The user stopped the run at the connect step.'); }
      if (session.cliCancel) { session.cliCancel(); session.cliCancel = null; }   // kill a headless run / stop watching a terminal window
      releaseAgentAsks();
      if (wasRunning) { session.running = false; session.status = 'stopped'; emit('stopped', {}); builds.finish(session.buildId, 'stopped'); }
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
    listen(wantPort) {
      return new Promise((resolve, reject) => {
        const onError = e => { server.removeListener('listening', onListening); reject(e); };
        const onListening = () => { server.removeListener('error', onError); port = server.address().port; resolve(port); };
        server.once('error', onError);
        server.listen(wantPort, '127.0.0.1', onListening);
      });
    },
  };
}
