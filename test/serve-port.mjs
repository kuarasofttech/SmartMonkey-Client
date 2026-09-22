/**
 * serve-port.mjs — how `smartmonkey app` chooses a port. Pure decision logic with
 * an injected `tryListen` (does the real bind) and `probe` (is the occupant us?),
 * so no real sockets are needed here.
 *   node test/serve-port.mjs
 */
import { strict as assert } from 'node:assert';
const { chooseListen } = await import('../serve-port.mjs');

let failures = 0;
async function check(name, fn) { try { await fn(); console.log(`  ok  ${name}`); } catch (e) { failures++; console.error(`FAIL  ${name}: ${e.message}`); } }

// A tryListen backed by a set of "busy" ports.
const listener = busy => async port => !busy.has(port);
const noSleep = async () => {};

await check('free desired port → listens there', async () => {
  const r = await chooseListen({ tryListen: listener(new Set()), probe: async () => false, wantPort: 8899, explicit: false, sleep: noSleep });
  assert.deepEqual(r, { action: 'listening', port: 8899 });
});

await check('desired port busy but frees within the retry window → still gets it', async () => {
  let attempts = 0;
  const tryListen = async port => { attempts++; return attempts > 2; };   // free on the 3rd try
  const r = await chooseListen({ tryListen, probe: async () => false, wantPort: 8899, explicit: false, sleep: noSleep });
  assert.deepEqual(r, { action: 'listening', port: 8899 });
});

await check('busy with a SmartMonkey (probe true) → open the existing one, do not start a second', async () => {
  const r = await chooseListen({ tryListen: listener(new Set([8899])), probe: async p => p === 8899, wantPort: 8899, explicit: false, sleep: noSleep });
  assert.deepEqual(r, { action: 'openExisting', port: 8899 });
});

await check('DEFAULT port busy with a foreign program → falls back to the next free port', async () => {
  const r = await chooseListen({ tryListen: listener(new Set([8899, 8900])), probe: async () => false, wantPort: 8899, explicit: false, sleep: noSleep });
  assert.deepEqual(r, { action: 'listening', port: 8901 }, 'skips the two busy ports, takes 8901');
});

await check('EXPLICIT --port busy with a foreign program → error, never silently moves', async () => {
  const r = await chooseListen({ tryListen: listener(new Set([9000])), probe: async () => false, wantPort: 9000, explicit: true, sleep: noSleep });
  assert.deepEqual(r, { action: 'error', port: 9000 });
});

await check('explicit --port busy with a SmartMonkey → still opens the existing one', async () => {
  const r = await chooseListen({ tryListen: listener(new Set([9000])), probe: async () => true, wantPort: 9000, explicit: true, sleep: noSleep });
  assert.deepEqual(r, { action: 'openExisting', port: 9000 });
});

await check('everything in the scan range is busy → error', async () => {
  const busy = new Set(); for (let p = 8899; p <= 8899 + 50; p++) busy.add(p);
  const r = await chooseListen({ tryListen: listener(busy), probe: async () => false, wantPort: 8899, explicit: false, maxScan: 20, sleep: noSleep });
  assert.equal(r.action, 'error');
});

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nserve-port: all passed');
