/**
 * lock.mjs — single-instance guard for `smartmonkey app`. Pure logic, fully
 * injected: no real processes, no real network, no touching ~/.smartmonkey.
 *   node test/lock.mjs
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { lockPath, readLock, writeLock, removeLock, ensureSingleInstance } = await import('../lock.mjs');

let failures = 0;
async function check(name, fn) { try { await fn(); console.log(`  ok  ${name}`); } catch (e) { failures++; console.error(`FAIL  ${name}: ${e.message}`); } }

const tmpLock = () => join(mkdtempSync(join(tmpdir(), 'sm-lock-')), 'app.lock');

await check('lockPath honours SMARTMONKEY_LOCK so tests never touch ~/.smartmonkey', () => {
  const prev = process.env.SMARTMONKEY_LOCK;
  process.env.SMARTMONKEY_LOCK = '/tmp/somewhere/app.lock';
  assert.equal(lockPath(), '/tmp/somewhere/app.lock');
  if (prev === undefined) delete process.env.SMARTMONKEY_LOCK; else process.env.SMARTMONKEY_LOCK = prev;
});

await check('writeLock / readLock / removeLock round-trip (creates the dir)', () => {
  const path = tmpLock();
  assert.equal(readLock(path), null, 'absent lock reads as null');
  writeLock({ pid: 4242, port: 8899, cwd: '/x' }, path);
  const got = readLock(path);
  assert.equal(got.pid, 4242);
  assert.equal(got.port, 8899);
  removeLock(path);
  assert.equal(readLock(path), null, 'removed lock reads as null');
});

await check('a corrupt lock file reads as null rather than throwing', () => {
  const path = tmpLock();
  writeLock({ pid: 1 }, path);
  writeFileSync(path, '{ not json');
  assert.equal(readLock(path), null, 'garbage in the lock file is treated as no lock');
});

await check('stale lock (recorded pid is dead) is ignored — nothing is killed or probed', async () => {
  const path = tmpLock();
  writeLock({ pid: 9999, port: 8899, cwd: '/x' }, path);
  const killed = [];
  let probed = 0;
  const res = await ensureSingleInstance({
    path,
    isAlive: () => false,          // the old pid is gone
    kill: (pid, sig) => killed.push([pid, sig]),
    probe: async () => { probed++; return true; },
    sleep: async () => {},
  });
  assert.equal(killed.length, 0, 'a dead pid is never signalled');
  assert.equal(probed, 0, 'a dead pid is never probed');
  assert.equal(res.replaced, false);
});

await check('a live instance that IS ours is replaced: SIGTERM, then bind is clear', async () => {
  const path = tmpLock();
  writeLock({ pid: 4242, port: 8899, cwd: '/x' }, path);
  const killed = [];
  let alive = true;
  const res = await ensureSingleInstance({
    path,
    isAlive: () => alive,
    kill: (pid, sig) => { killed.push([pid, sig]); if (sig === 'SIGTERM') alive = false; },  // exits on the graceful signal
    probe: async (port) => port === 8899,   // our app answers on the recorded port
    sleep: async () => {},
  });
  assert.deepEqual(killed[0], [4242, 'SIGTERM'], 'the previous instance is asked to stop gracefully');
  assert.ok(!killed.some(([, s]) => s === 'SIGKILL'), 'no SIGKILL needed once it exits on SIGTERM');
  assert.equal(res.replaced, true);
});

await check('a live instance that refuses SIGTERM is SIGKILLed', async () => {
  const path = tmpLock();
  writeLock({ pid: 4242, port: 8899, cwd: '/x' }, path);
  const killed = [];
  let alive = true;
  await ensureSingleInstance({
    path,
    isAlive: () => alive,
    kill: (pid, sig) => { killed.push([pid, sig]); if (sig === 'SIGKILL') alive = false; },  // only dies on SIGKILL
    probe: async () => true,
    sleep: async () => {},
  });
  assert.ok(killed.some(([, s]) => s === 'SIGTERM'), 'SIGTERM is tried first');
  assert.ok(killed.some(([, s]) => s === 'SIGKILL'), 'SIGKILL follows when it will not stop');
});

await check('a live pid that is NOT our app (probe says no) is left alone — guards against pid reuse', async () => {
  const path = tmpLock();
  writeLock({ pid: 4242, port: 8899, cwd: '/x' }, path);
  const killed = [];
  const res = await ensureSingleInstance({
    path,
    isAlive: () => true,
    kill: (pid, sig) => killed.push([pid, sig]),
    probe: async () => false,   // something else reused that pid; it is not smartmonkey
    sleep: async () => {},
  });
  assert.equal(killed.length, 0, 'an unrelated process is never killed');
  assert.equal(res.replaced, false);
});

await check('our own pid in the lock is never signalled', async () => {
  const path = tmpLock();
  writeLock({ pid: process.pid, port: 8899, cwd: '/x' }, path);
  const killed = [];
  await ensureSingleInstance({
    path,
    isAlive: () => true,
    kill: (pid, sig) => killed.push([pid, sig]),
    probe: async () => true,
    sleep: async () => {},
  });
  assert.equal(killed.length, 0, 'we do not kill ourselves');
});

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nlock: all passed');
