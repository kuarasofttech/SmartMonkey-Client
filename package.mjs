/**
 * The SmartMonkey package: ONE .zip with the blueprint, the cases (if any), and the
 * documents and screenshots the tester added BY HAND. Nothing is added automatically —
 * the promise is "only the blueprint and the files you add leave this machine".
 *
 * Added files live at PROJECT level (smartmonkey/package/{docs,screenshots}/), not per
 * build: a spec added once should ride along with every rebuild. The folder is
 * git-ignored — screenshots can carry personal data.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, rmSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { makeZip } from './zip.mjs';

export const TYPES = {
  doc: ['.md', '.txt', '.pdf', '.html', '.htm', '.csv', '.json'],
  screenshot: ['.png', '.jpg', '.jpeg', '.webp'],
};
export const LIMITS = { files: 40, fileBytes: 10 * 1024 * 1024, totalBytes: 50 * 1024 * 1024 };
const DIRS = { doc: 'docs', screenshot: 'screenshots' };

export const kindOf = name => Object.keys(TYPES).find(k => TYPES[k].includes(extname(String(name)).toLowerCase())) || null;

/** A name that is safe as a single path segment on every OS, keeping readable letters (ç, ü…). */
export function safeName(name) {
  const base = String(name || '').split(/[\\/]/).pop();
  const ext = extname(base).toLowerCase();
  let stem = base.slice(0, base.length - extname(base).length)
    .replace(/[\u0000-\u001f<>:"|?*]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  stem = stem.slice(0, 100) || 'file';
  return stem + ext;
}

export function makePackageStore(kit) {
  const root = join(kit, 'package');
  const dirOf = kind => join(root, DIRS[kind]);

  const list = () => {
    const out = [];
    for (const kind of Object.keys(DIRS)) {
      const d = dirOf(kind); if (!existsSync(d)) continue;
      for (const name of readdirSync(d)) {
        const p = join(d, name); const st = statSync(p);
        if (st.isFile() && kindOf(name) === kind) out.push({ kind, name, bytes: st.size, addedAt: st.mtime.toISOString() });
      }
    }
    return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  };

  return {
    list,
    totals() { const l = list(); return { files: l.length, bytes: l.reduce((s, f) => s + f.bytes, 0) }; },

    /** Add one file; returns { kind, name } (renamed "x (2).md" if the name is taken). */
    add(name, data) {
      const kind = kindOf(name);
      if (!kind) throw new Error(`${name}: only documents (${TYPES.doc.join(' ')}) and screenshots (${TYPES.screenshot.join(' ')}) can go in the package`);
      if (!Buffer.isBuffer(data) || !data.length) throw new Error(`${name} is empty`);
      if (data.length > LIMITS.fileBytes) throw new Error(`${name} is over ${LIMITS.fileBytes / 1024 / 1024} MB`);
      const t = this.totals();
      if (t.files >= LIMITS.files) throw new Error(`the package holds at most ${LIMITS.files} files`);
      if (t.bytes + data.length > LIMITS.totalBytes) throw new Error(`the package would be over ${LIMITS.totalBytes / 1024 / 1024} MB`);
      mkdirSync(dirOf(kind), { recursive: true });
      const clean = safeName(name), ext = extname(clean), stem = clean.slice(0, clean.length - ext.length);
      let final = clean;
      for (let n = 2; existsSync(join(dirOf(kind), final)); n++) final = `${stem} (${n})${ext}`;
      writeFileSync(join(dirOf(kind), final), data);
      return { kind, name: final };
    },

    remove(kind, name) {
      if (!DIRS[kind]) throw new Error('unknown kind');
      const clean = safeName(name);
      if (clean !== name) throw new Error('no such file');
      const p = join(dirOf(kind), clean);
      if (!existsSync(p)) throw new Error('no such file');
      rmSync(p);
    },

    /**
     * The zip for one build: its blueprint (required), its cases (if any), and every file
     * the tester added. The manifest says what is inside, so the server never guesses.
     */
    build({ blueprintPath, casesPath, project, buildId, now = new Date() }) {
      if (!blueprintPath || !existsSync(blueprintPath)) throw new Error('this build has no blueprint to package');
      const files = list();
      const entries = [{ name: 'blueprint.json', data: readFileSync(blueprintPath) }];
      const hasCases = casesPath && existsSync(casesPath);
      if (hasCases) entries.push({ name: 'cases.json', data: readFileSync(casesPath) });
      for (const f of files) entries.push({ name: `${DIRS[f.kind]}/${f.name}`, data: readFileSync(join(dirOf(f.kind), f.name)) });
      const manifest = {
        smartmonkeyPackage: 1, project: project || null, build: buildId || null, createdAt: now.toISOString(),
        blueprint: 'blueprint.json', ...(hasCases ? { cases: 'cases.json' } : {}),
        files: files.map(f => ({ path: `${DIRS[f.kind]}/${f.name}`, kind: f.kind, bytes: f.bytes })),
      };
      return makeZip([{ name: 'manifest.json', data: JSON.stringify(manifest, null, 2) }, ...entries], { now });
    },
  };
}
