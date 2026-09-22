/**
 * Single-instance guard for `smartmonkey app`. There is exactly one running app
 * per user: launching a second one REPLACES the first (so re-running after a code
 * update always gives you the newest code — an old process holding stale routes in
 * memory is the whole class of bug this prevents).
 *
 * A user-level lock file records the live instance ({ pid, port, cwd, startedAt }).
 * Before killing the recorded pid we CONFIRM it is actually our app answering on its
 * port — a bare pid could have been reused by something unrelated. All the moving
 * parts (liveness, kill, probe, sleep) are injectable so the logic is testable
 * without real processes or network. Zero runtime deps.
 */
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export const APP_ID = 'smartmonkey-client';

// The lock path. SMARTMONKEY_LOCK overrides it — tests set it so they never touch
// the user's real ~/.smartmonkey/app.lock.
export const lockPath = () => process.env.SMARTMONKEY_LOCK || join(homedir(), '.smartmonkey', 'app.lock');

export function readLock(path = lockPath()) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export function writeLock(info, path = lockPath()) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(info));
}

export function removeLock(path = lockPath()) {
  try { rmSync(path); } catch {}
}

// Default liveness check. `kill(pid, 0)` throws ESRCH when the process is gone;
// EPERM means it exists but we may not signal it (still "alive").
const defaultIsAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const defaultKill = (pid, sig) => { try { process.kill(pid, sig); } catch {} };
const defaultSleep = ms => new Promise(r => setTimeout(r, ms));

// Is OUR app answering on this port? Confirmed via /api/status carrying APP_ID.
// Exported so the launcher can ask "who holds this port?" with the same check.
export async function probeApp(port) {
  if (!port) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(600) });
    if (!res.ok) return false;
    const j = await res.json();
    return !!j && j.app === APP_ID;
  } catch { return false; }
}
const defaultProbe = probeApp;

/**
 * Ensure no other smartmonkey app is running. If the lock names a live process
 * that is confirmed to be ours, stop it (SIGTERM, then SIGKILL) and wait for it to
 * exit. Returns { replaced } — true when a previous instance was actually killed.
 */
export async function ensureSingleInstance({
  path = lockPath(),
  isAlive = defaultIsAlive,
  kill = defaultKill,
  probe = defaultProbe,
  sleep = defaultSleep,
  log = () => {},
} = {}) {
  const prev = readLock(path);
  if (!prev || typeof prev.pid !== 'number' || prev.pid === process.pid) return { replaced: false };
  if (!isAlive(prev.pid)) return { replaced: false };           // stale lock — nothing to do
  if (!(await probe(prev.port))) return { replaced: false };    // pid reused by something else — leave it

  const where = `pid ${prev.pid}${prev.port ? ` on :${prev.port}` : ''}${prev.cwd ? ` (${prev.cwd})` : ''}`;
  log(`Replacing the SmartMonkey app already running (${where}).`);
  kill(prev.pid, 'SIGTERM');
  for (let i = 0; i < 30 && isAlive(prev.pid); i++) await sleep(100);   // up to ~3s graceful
  if (isAlive(prev.pid)) {
    kill(prev.pid, 'SIGKILL');
    for (let i = 0; i < 20 && isAlive(prev.pid); i++) await sleep(100);
  }
  return { replaced: true };
}
