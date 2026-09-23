/**
 * Build history on disk: every build gets a folder; the current blueprint stays
 * at smartmonkey/blueprint.json; builds can be listed, opened, deleted and made
 * current; a clean start sets the current blueprint aside and puts it back on
 * failure; a "build on" start places an older blueprint as the starting point.
 *   node test/buildstore.mjs
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { makeBuildStore } = await import('../buildstore.mjs');

let failures = 0;
function check(name, fn) { try { fn(); console.log(`  ok  ${name}`); } catch (e) { failures++; console.error(`FAIL  ${name}: ${e.message}`); } }

let clock = Date.parse('2026-09-23T10:00:00Z');
const fresh = () => {
  const kit = join(mkdtempSync(join(tmpdir(), 'sm-bs-')), 'smartmonkey'); mkdirSync(kit, { recursive: true });
  let r = 0;
  return { kit, store: makeBuildStore(kit, { now: () => new Date(clock += 60_000), rand: () => String(++r).padStart(4, '0') }) };
};
const bp = (n) => JSON.stringify({ smartmonkeyBlueprint: 1, screens: Array(n).fill({}), flows: [{}], openQuestions: [{}, {}] });
const read = p => readFileSync(p, 'utf8');

check('a finished build snapshots the blueprint, becomes current, and counts what it found', () => {
  const { kit, store } = fresh();
  store.prepareStart({});
  const id = store.create({ driver: 'claude' });
  assert.equal(store.list()[0].status, 'running');
  store.appendEvent(id, { type: 'text', data: 'hello' });
  writeFileSync(join(kit, 'blueprint.json'), bp(3));
  store.finish(id, 'done');
  const [b] = store.list();
  assert.equal(b.status, 'done'); assert.equal(b.current, true);
  assert.deepEqual(b.counts, { screens: 3, flows: 1, openQuestions: 2 });
  assert.equal(read(join(kit, 'builds', id, 'blueprint.json')), bp(3));
  assert.deepEqual(store.get(id).events, [{ type: 'text', data: 'hello' }]);
});

check('a clean new build sets the current blueprint aside, and a failed one puts it back', () => {
  const { kit, store } = fresh();
  store.prepareStart({}); const a = store.create({}); writeFileSync(join(kit, 'blueprint.json'), bp(1)); store.finish(a, 'done');
  store.prepareStart({});
  assert.equal(existsSync(join(kit, 'blueprint.json')), false, 'the new build starts clean');
  const b = store.create({});
  store.finish(b, 'error');
  assert.equal(read(join(kit, 'blueprint.json')), bp(1), 'the current blueprint is back');
  assert.equal(store.list().find(x => x.current).id, a);
});

check('"build on" places that build\'s blueprint as the starting point and records it', () => {
  const { kit, store } = fresh();
  store.prepareStart({}); const a = store.create({}); writeFileSync(join(kit, 'blueprint.json'), bp(2)); store.finish(a, 'done');
  store.prepareStart({}); const b = store.create({}); writeFileSync(join(kit, 'blueprint.json'), bp(5)); store.finish(b, 'done');
  store.prepareStart({ basedOn: a });
  assert.equal(read(join(kit, 'blueprint.json')), bp(2), 'the older blueprint is the starting point');
  const c = store.create({ basedOn: a });
  assert.equal(store.get(c).meta.basedOn, a);
  assert.throws(() => store.prepareStart({ basedOn: 'nope' }), /unknown build/);
});

check('a pre-history blueprint is imported as a build before a clean start, so nothing is lost', () => {
  const { kit, store } = fresh();
  writeFileSync(join(kit, 'blueprint.json'), bp(4));
  store.prepareStart({});
  const [imported] = store.list();
  assert.equal(imported.imported, true); assert.equal(imported.status, 'done'); assert.equal(imported.current, true);
  assert.equal(read(join(kit, 'builds', imported.id, 'blueprint.json')), bp(4));
});

check('deleting the current build makes the previous one current; deleting the last clears it; running builds cannot be deleted', () => {
  const { kit, store } = fresh();
  store.prepareStart({}); const a = store.create({}); writeFileSync(join(kit, 'blueprint.json'), bp(1)); store.finish(a, 'done');
  store.prepareStart({}); const b = store.create({}); writeFileSync(join(kit, 'blueprint.json'), bp(2)); store.finish(b, 'done');
  store.remove(b);
  assert.equal(existsSync(join(kit, 'builds', b)), false);
  assert.equal(read(join(kit, 'blueprint.json')), bp(1), 'the previous build is current again');
  store.remove(a);
  assert.equal(existsSync(join(kit, 'blueprint.json')), false, 'no builds left → no current blueprint');
  store.prepareStart({}); const c = store.create({});
  assert.throws(() => store.remove(c), /running/);
});

check('make current restores an older build', () => {
  const { kit, store } = fresh();
  store.prepareStart({}); const a = store.create({}); writeFileSync(join(kit, 'blueprint.json'), bp(1)); store.finish(a, 'done');
  store.prepareStart({}); const b = store.create({}); writeFileSync(join(kit, 'blueprint.json'), bp(2)); store.finish(b, 'done');
  store.makeCurrent(a);
  assert.equal(read(join(kit, 'blueprint.json')), bp(1));
  assert.equal(store.list().find(x => x.current).id, a);
});

check('a build still "running" when the app starts again is marked interrupted', () => {
  const { kit, store } = fresh();
  store.prepareStart({}); const a = store.create({});
  const again = makeBuildStore(kit);
  again.recover();
  assert.equal(again.get(a).meta.status, 'interrupted');
});

check('history and owner answers are git-ignored; the blueprint is not', () => {
  const { kit, store } = fresh();
  store.ensureGitignore();
  const gi = read(join(kit, '.gitignore'));
  assert.match(gi, /^builds\/$/m); assert.match(gi, /^owner-answers\.json$/m);
  assert.doesNotMatch(gi, /blueprint\.json/);
  store.ensureGitignore();
  assert.equal(read(join(kit, '.gitignore')), gi, 'idempotent');
});

check('list is newest first; ids are path-safe', () => {
  const { store } = fresh();
  store.prepareStart({}); const a = store.create({}); store.finish(a, 'stopped');
  store.prepareStart({}); const b = store.create({}); store.finish(b, 'stopped');
  assert.deepEqual(store.list().map(x => x.id), [b, a]);
  assert.match(a, /^[\w-]+$/);
  assert.throws(() => store.get('../../etc'), /unknown build/);
});

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nbuildstore: all passed');
