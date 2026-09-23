/**
 * Build history on disk (zero dependencies). Every build gets a folder:
 *
 *   smartmonkey/builds/<id>/meta.json    status, times, driver, basedOn, counts
 *                          /events.jsonl  the run's progress stream (replayable)
 *                          /blueprint.json, cases.json   what the build produced
 *   smartmonkey/builds/current.json      { id } — which build is "current"
 *
 * The CURRENT blueprint stays at smartmonkey/blueprint.json (+ cases.json),
 * because upload, the freshness check and the CLI all read it there. The agent
 * keeps writing that path; the store snapshots it when a build finishes.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, appendFileSync, copyFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const OUTPUTS = ['blueprint.json', 'cases.json'];
const GITIGNORE_LINES = ['builds/', 'owner-answers.json', 'package/'];   // package/: hand-added docs + screenshots (may hold personal data)
const SAFE_ID = /^[\w-]+$/;

export function makeBuildStore(kit, { now = () => new Date(), rand = () => randomBytes(2).toString('hex') } = {}) {
  const root = join(kit, 'builds');
  const dirOf = id => { if (!SAFE_ID.test(id || '') || !existsSync(join(root, id, 'meta.json'))) throw new Error(`unknown build ${id}`); return join(root, id); };
  const readJson = p => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
  const writeJson = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2));
  const metaOf = id => readJson(join(dirOf(id), 'meta.json'));
  const saveMeta = m => writeJson(join(root, m.id, 'meta.json'), m);
  const currentId = () => { const c = readJson(join(root, 'current.json')); return c && c.id && existsSync(join(root, c.id, 'meta.json')) ? c.id : null; };
  const setCurrent = id => { mkdirSync(root, { recursive: true }); writeJson(join(root, 'current.json'), { id }); };
  const ids = () => (existsSync(root) ? readdirSync(root).filter(d => SAFE_ID.test(d) && existsSync(join(root, d, 'meta.json'))) : []);

  const counts = file => {
    const b = readJson(file); if (!b) return null;
    const n = v => (Array.isArray(v) ? v.length : 0);
    return { screens: n(b.screens), flows: n(b.flows), openQuestions: n(b.openQuestions) };
  };
  // copy a build's outputs into smartmonkey/ (or clear them when id is null)
  const place = id => {
    for (const f of OUTPUTS) {
      const src = id ? join(root, id, f) : null;
      if (src && existsSync(src)) copyFileSync(src, join(kit, f));
      else rmSync(join(kit, f), { force: true });
    }
  };
  // Creation order. Start times tie within a millisecond (a fast restart, a test), and ids
  // break ties by their random suffix — so order by a counter, not by the clock.
  const nextSeq = () => ids().reduce((m, id) => Math.max(m, (readJson(join(root, id, 'meta.json')) || {}).seq || 0), 0) + 1;
  const newId = () => `${now().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z')}-${rand()}`;

  const store = {
    ensureGitignore() {
      mkdirSync(kit, { recursive: true });
      const p = join(kit, '.gitignore');
      const have = existsSync(p) ? readFileSync(p, 'utf8') : '';
      const lines = have.split('\n');
      const missing = GITIGNORE_LINES.filter(l => !lines.includes(l));
      if (!missing.length) return;
      const head = have ? (have.endsWith('\n') ? have : have + '\n') : '# SmartMonkey: build history and your recorded answers stay on this machine\n';
      writeFileSync(p, head + missing.join('\n') + '\n');
    },

    /** Builds still marked running when the app starts again did not finish. */
    recover() {
      for (const id of ids()) { const m = metaOf(id); if (m && m.status === 'running') { m.status = 'interrupted'; saveMeta(m); } }
    },

    /** A blueprint that predates history becomes a build first, so a clean start never loses it. */
    importLegacy() {
      if (currentId() || !existsSync(join(kit, 'blueprint.json'))) return null;
      store.ensureGitignore();
      const id = newId(); const dir = join(root, id); mkdirSync(dir, { recursive: true });
      for (const f of OUTPUTS) if (existsSync(join(kit, f))) copyFileSync(join(kit, f), join(dir, f));
      const at = statSync(join(kit, 'blueprint.json')).mtime.toISOString();
      saveMeta({ id, seq: nextSeq(), startedAt: at, finishedAt: at, status: 'done', imported: true, counts: counts(join(dir, 'blueprint.json')) });
      setCurrent(id);
      return id;
    },

    /**
     * Get smartmonkey/ ready for a new build. Clean: the current blueprint is set
     * aside (it's safe in its build folder). basedOn: that build's blueprint is
     * placed as the starting point.
     */
    prepareStart({ basedOn } = {}) {
      store.importLegacy();
      if (basedOn) { dirOf(basedOn); place(basedOn); }
      else place(null);
    },

    create({ driver = null, basedOn = null } = {}) {
      store.ensureGitignore();
      const seq = nextSeq(), id = newId(); mkdirSync(join(root, id), { recursive: true });
      saveMeta({ id, seq, startedAt: now().toISOString(), status: 'running', driver, basedOn });
      return id;
    },

    /** Audit one connector call into the build's meta — the Sources view reads this, not the model's claims. */
    recordCall(id, entry) {
      const m = id ? readJson(join(root, id, 'meta.json')) : null; if (!m) return;
      (m.connectorCalls = m.connectorCalls || []).push(entry); saveMeta(m);
    },

    /** Which tools this build asked for and how each ended up (connected / skipped). */
    recordConnections(id, outcome) {
      const m = id ? readJson(join(root, id, 'meta.json')) : null; if (!m) return;
      m.connections = outcome; saveMeta(m);
    },

    appendEvent(id, ev) {
      try { appendFileSync(join(root, id, 'events.jsonl'), JSON.stringify(ev) + '\n'); } catch {}
    },

    /**
     * Close a build. done + a blueprint → snapshot it and make it current.
     * Anything else → the previous current blueprint goes back in place.
     */
    finish(id, status, { error } = {}) {
      const m = metaOf(id); if (!m || m.status !== 'running') return;
      m.status = status; m.finishedAt = now().toISOString(); if (error) m.error = error;
      const produced = existsSync(join(kit, 'blueprint.json'));
      if (status === 'done' && produced) {
        for (const f of OUTPUTS) if (existsSync(join(kit, f))) copyFileSync(join(kit, f), join(root, id, f));
        m.counts = counts(join(root, id, 'blueprint.json'));
        saveMeta(m); setCurrent(id);
      } else {
        if (status === 'done') m.noBlueprint = true;
        saveMeta(m); place(currentId());
      }
    },

    list() {
      const cur = currentId();
      return ids().map(id => ({ ...metaOf(id), current: id === cur }))
        .sort((a, b) => ((b.seq || 0) - (a.seq || 0)) || (b.startedAt || '').localeCompare(a.startedAt || ''));
    },

    get(id) {
      const dir = dirOf(id);
      const raw = existsSync(join(dir, 'events.jsonl')) ? readFileSync(join(dir, 'events.jsonl'), 'utf8') : '';
      const events = raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      return { meta: { ...metaOf(id), current: id === currentId() }, events };
    },

    remove(id) {
      const m = metaOf(id);
      if (m.status === 'running') throw new Error('a running build can\'t be deleted — stop it first');
      const wasCurrent = currentId() === id;
      rmSync(join(root, id), { recursive: true, force: true });
      if (wasCurrent) {
        const next = store.list().find(b => b.status === 'done' && existsSync(join(root, b.id, 'blueprint.json')));
        if (next) { setCurrent(next.id); place(next.id); }
        else { rmSync(join(root, 'current.json'), { force: true }); place(null); }
      }
    },

    makeCurrent(id) {
      dirOf(id);
      if (!existsSync(join(root, id, 'blueprint.json'))) throw new Error('that build has no blueprint');
      setCurrent(id); place(id);
    },

    /**
     * Save edited test cases into a build (and into smartmonkey/ when it is the current
     * one, so the file you upload is the edited one).
     */
    saveCases(id, cases) {
      const m = metaOf(id); if (!m) throw new Error(`unknown build ${id}`);
      if (m.status === 'running') throw new Error('this build is still running');
      if (!Array.isArray(cases) || cases.length > 500) throw new Error('cases must be a list of at most 500');
      writeJson(join(root, id, 'cases.json'), cases);
      if (currentId() === id) writeJson(join(kit, 'cases.json'), cases);
    },

    /** The owner's answer to one of a build's open questions ('' clears it). */
    answerOpenQuestion(id, index, answer) {
      const m = metaOf(id); if (!m) throw new Error(`unknown build ${id}`);
      if (m.status === 'running') throw new Error('this build is still running');
      const file = join(root, id, 'blueprint.json');
      const b = readJson(file); if (!b) throw new Error('that build has no blueprint');
      const q = Array.isArray(b.openQuestions) ? b.openQuestions[index] : null;
      if (!q || typeof q !== 'object' || !Number.isInteger(index)) throw new Error('no such open question');
      const a = String(answer ?? '').trim().slice(0, 400);
      if (a) q.answer = a; else delete q.answer;
      writeJson(file, b);
      if (currentId() === id) writeJson(join(kit, 'blueprint.json'), b);
      m.answeredOpen = b.openQuestions.filter(x => x && x.answer).length; saveMeta(m);
      return q;
    },

    currentId,
  };
  return store;
}
