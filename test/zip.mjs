/**
 * The zip writer, checked by INDEPENDENT readers (the system unzip, Python's zipfile),
 * not by a reader we wrote — a writer that only agrees with itself proves nothing.
 *   node test/zip.mjs
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
const { makeZip, crc32 } = await import('../zip.mjs');

let failures = 0;
function check(name, fn) { try { fn(); console.log(`  ok  ${name}`); } catch (e) { failures++; console.error(`FAIL  ${name}: ${e.message}`); } }
const have = bin => { try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; } };

check('crc32 matches the standard check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xCBF43926);
});

const dir = mkdtempSync(join(tmpdir(), 'sm-zip-'));
const noise = randomBytes(20_000);                      // incompressible → stored
const entries = [
  { name: 'manifest.json', data: JSON.stringify({ smartmonkeyPackage: 1 }) },
  { name: 'blueprint.json', data: JSON.stringify({ screens: Array(200).fill({ name: 'Gallery' }) }) },   // compressible → deflated
  { name: 'docs/Ürün notları.md', data: '# Notlar\nçğıöşü' },
  { name: 'screenshots/home.png', data: noise },
];
const zip = makeZip(entries);
const file = join(dir, 'p.zip'); writeFileSync(file, zip);

check('system unzip accepts it and extracts every file byte-for-byte', () => {
  if (!have('unzip')) return console.log('      (skipped: no unzip)');
  const test = execFileSync('unzip', ['-t', file]).toString();
  assert.match(test, /No errors detected/);
  const out = join(dir, 'x'); execFileSync('unzip', ['-q', file, '-d', out]);
  assert.equal(readFileSync(join(out, 'screenshots/home.png')).compare(noise), 0);
  assert.equal(readFileSync(join(out, 'docs/Ürün notları.md'), 'utf8'), '# Notlar\nçğıöşü', 'UTF-8 names and content survive');
});

check("Python's zipfile agrees (CRC, names, compression per entry)", () => {
  if (!have('python3')) return console.log('      (skipped: no python3)');
  const py = `import zipfile,sys,json\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint(json.dumps([[i.filename,i.compress_type] for i in z.infolist()]))`;
  const info = JSON.parse(execFileSync('python3', ['-c', py, file]).toString());
  assert.deepEqual(info.map(x => x[0]), entries.map(e => e.name));
  assert.equal(info.find(x => x[0] === 'blueprint.json')[1], 8, 'compressible → deflated');
  assert.equal(info.find(x => x[0] === 'screenshots/home.png')[1], 0, 'incompressible → stored');
});

check('refuses unsafe or duplicate names', () => {
  assert.throws(() => makeZip([{ name: '../evil', data: 'x' }]), /unsafe/);
  assert.throws(() => makeZip([{ name: '/abs', data: 'x' }]), /unsafe/);
  assert.throws(() => makeZip([{ name: 'a', data: 'x' }, { name: 'a', data: 'y' }]), /duplicate/);
});

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nzip: all passed');
