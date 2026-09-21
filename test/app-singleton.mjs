/**
 * `smartmonkey app` is a singleton: launching a second one REPLACES the first.
 * This spawns two REAL app processes and asserts the first exits and the second
 * serves on the same port. Isolated via SMARTMONKEY_LOCK (a temp file — never the
 * user's ~/.smartmonkey) and SMARTMONKEY_NO_OPEN (no browser popped).
 *   node test/app-singleton.mjs
 */
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const status = port => fetch(`http://127.0.0.1:${port}/api/status`).then(r => r.json()).catch(() => null);

async function waitUp(port, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const j = await status(port); if (j && j.app === 'smartmonkey-client') return true; await sleep(100); }
  return false;
}
async function waitExit(child, ms = 6000) {
  if (child.exitCode !== null) return true;
  return await Promise.race([new Promise(r => child.once('exit', () => r(true))), sleep(ms).then(() => child.exitCode !== null)]);
}

let failures = 0;
async function check(name, fn) { try { await fn(); console.log(`  ok  ${name}`); } catch (e) { failures++; console.error(`FAIL  ${name}: ${e.message}`); } }

await check('a second `smartmonkey app` replaces the first on the same port', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sm-single-'));
  const lock = join(mkdtempSync(join(tmpdir(), 'sm-single-lock-')), 'app.lock');
  const port = await freePort();
  const env = { ...process.env, SMARTMONKEY_LOCK: lock, SMARTMONKEY_NO_OPEN: '1' };
  const launch = () => spawn(process.execPath, [CLI, 'app', '--port', String(port)], { cwd, env, stdio: 'ignore' });

  let a, b;
  try {
    a = launch();
    assert.ok(await waitUp(port), 'first instance came up');
    await sleep(200);   // let it finish writing its lock

    b = launch();
    assert.ok(await waitExit(a), 'first instance exited when the second launched');
    assert.ok(await waitUp(port), 'second instance is serving on the same port');
    assert.equal(a.exitCode !== null, true, 'first process is gone');
  } finally {
    for (const c of [a, b]) { try { c && c.exitCode === null && c.kill('SIGKILL'); } catch {} }
  }
});

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\napp-singleton: all passed');
