/**
 * The package: hand-added files (types, caps, safe names), and the one .zip per build —
 * checked by Python's zipfile, not by our own reader.
 *   node test/package.mjs
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
const { makePackageStore, safeName, kindOf, LIMITS } = await import('../package.mjs');
const { createApp } = await import('../server.mjs');
const { makeSecrets } = await import('../secrets.mjs');

let failures = 0;
async function check(name, fn) { try { await fn(); console.log(`  ok  ${name}`); } catch (e) { failures++; console.error(`FAIL  ${name}: ${e.message}`); } }
const kitDir = () => { const k = join(mkdtempSync(join(tmpdir(), 'sm-pkg-')), 'smartmonkey'); mkdirSync(k, { recursive: true }); return k; };
const pyList = zipFile => JSON.parse(execFileSync('python3', ['-c', 'import zipfile,sys,json\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint(json.dumps({n:z.read(n).decode("latin-1") for n in z.namelist()}))', zipFile]).toString());

await check('kinds come from the extension; everything else is refused', () => {
  assert.equal(kindOf('Spec.PDF'), 'doc'); assert.equal(kindOf('home.png'), 'screenshot');
  assert.equal(kindOf('app.apk'), null); assert.equal(kindOf('src/Main.kt'), null, 'source code is never a package file');
});

await check('names are made safe but stay readable', () => {
  assert.equal(safeName('../../etc/Ürün notları.md'), 'Ürün notları.md');
  assert.equal(safeName('a<b>:c?.png'), 'a b c.png');
  assert.equal(safeName('..hidden.txt'), 'hidden.txt');
});

await check('add / list / remove; a taken name gets "(2)"; caps are enforced', () => {
  const store = makePackageStore(kitDir());
  assert.deepEqual(store.add('notes.md', Buffer.from('# a')), { kind: 'doc', name: 'notes.md' });
  assert.deepEqual(store.add('notes.md', Buffer.from('# b')), { kind: 'doc', name: 'notes (2).md' });
  store.add('home.png', Buffer.from([1, 2, 3]));
  assert.deepEqual(store.list().map(f => `${f.kind}:${f.name}`), ['doc:notes (2).md', 'doc:notes.md', 'screenshot:home.png']);
  assert.throws(() => store.add('Main.kt', Buffer.from('x')), /only documents/);
  assert.throws(() => store.add('big.png', Buffer.alloc(LIMITS.fileBytes + 1)), /over/);
  assert.throws(() => store.add('empty.md', Buffer.alloc(0)), /empty/);
  store.remove('doc', 'notes.md');
  assert.equal(store.list().length, 2);
  assert.throws(() => store.remove('doc', '../x.md'), /no such file/);
});

await check('the zip carries manifest + blueprint + cases + the added files, and nothing else', () => {
  const kit = kitDir(); const store = makePackageStore(kit);
  const b = join(kit, 'bp.json'); writeFileSync(b, '{"smartmonkeyBlueprint":1}');
  const c = join(kit, 'cases.json'); writeFileSync(c, '[{"id":"TC-1"}]');
  store.add('Spec.md', Buffer.from('# spec')); store.add('home.png', Buffer.from([137, 80, 78, 71]));
  const zip = store.build({ blueprintPath: b, casesPath: c, project: 'FileTagger', buildId: 'b1' });
  const f = join(kit, 'p.zip'); writeFileSync(f, zip);
  const got = pyList(f);
  assert.deepEqual(Object.keys(got).sort(), ['blueprint.json', 'cases.json', 'docs/Spec.md', 'manifest.json', 'screenshots/home.png']);
  const m = JSON.parse(got['manifest.json']);
  assert.equal(m.smartmonkeyPackage, 1); assert.equal(m.cases, 'cases.json'); assert.equal(m.project, 'FileTagger');
  assert.deepEqual(m.files.map(x => [x.path, x.kind]), [['docs/Spec.md', 'doc'], ['screenshots/home.png', 'screenshot']]);
  const noCases = store.build({ blueprintPath: b, casesPath: join(kit, 'nope.json') });
  writeFileSync(f, noCases); assert.ok(!('cases.json' in pyList(f)));
  assert.throws(() => store.build({ blueprintPath: join(kit, 'none.json') }), /no blueprint/);
});

// ---- over HTTP ----
const request = (port, method, path, body, headers = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, method, path, headers }, res => {
    const parts = []; res.on('data', c => parts.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
  });
  r.on('error', reject); if (body) r.write(body); r.end();
});

await check('routes: add raw bytes, list, delete, and download a build\'s package as a zip', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sm-pkg-app-'));
  const kit = join(cwd, 'smartmonkey'); mkdirSync(kit, { recursive: true });
  writeFileSync(join(kit, 'blueprint.json'), '{"smartmonkeyBlueprint":1,"screens":[]}');
  const app = createApp({ cwd, secrets: makeSecrets({ platform: 'win32' }) });
  const port = await app.listen(0);
  const add = await request(port, 'POST', `/api/package?name=${encodeURIComponent('Ürün notları.md')}`, Buffer.from('çğü'));
  assert.equal(add.status, 200, add.body.toString());
  assert.equal(JSON.parse(add.body).file.name, 'Ürün notları.md');
  assert.equal((await request(port, 'POST', '/api/package?name=x.exe', Buffer.from('MZ'))).status, 400);
  const list = JSON.parse((await request(port, 'GET', '/api/package')).body);
  assert.equal(list.files.length, 1); assert.equal(list.totals.bytes, Buffer.byteLength('çğü'));
  assert.match(readFileSync(join(kit, '.gitignore'), 'utf8'), /^package\/$/m, 'hand-added files are git-ignored');

  const [b] = JSON.parse((await request(port, 'GET', '/api/builds')).body).builds;
  const dl = await request(port, 'GET', `/api/builds/${b.id}/package`);
  assert.equal(dl.status, 200); assert.equal(dl.headers['content-type'], 'application/zip');
  assert.match(dl.headers['content-disposition'], /attachment; filename="smartmonkey-sm-pkg-app-\w+-\d{4}-\d\d-\d\d\.zip"/);
  const f = join(cwd, 'dl.zip'); writeFileSync(f, dl.body);
  assert.ok('docs/Ürün notları.md' in pyList(f));

  assert.equal((await request(port, 'DELETE', `/api/package/doc/${encodeURIComponent('Ürün notları.md')}`)).status, 200);
  assert.equal(existsSync(join(kit, 'package', 'docs', 'Ürün notları.md')), false);
  assert.equal((await request(port, 'GET', '/api/builds/nope/package')).status, 404);
  app.server.close();
});

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\npackage: all passed');
