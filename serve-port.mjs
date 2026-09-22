/**
 * Decide which port `smartmonkey app` listens on so it never dead-ends on a busy
 * port. Rules:
 *   - Try the desired port, with a few quick retries (covers the brief window
 *     after we replace our own previous instance and the port is still freeing).
 *   - Still busy? Ask who has it (probe): if it answers as SmartMonkey, we open
 *     THAT instance instead of starting a second.
 *   - A foreign program on the DEFAULT port → fall back to the next free port
 *     (so a non-technical user never has to know about --port).
 *   - A foreign program on an EXPLICIT --port → error, because the user named
 *     that exact port and we honour it rather than silently moving.
 *
 * Pure logic: `tryListen(port)` (does the real bind, returns true on success) and
 * `probe(port)` (is the occupant our app?) are injected, so it is unit-testable.
 * Returns { action: 'listening'|'openExisting'|'error', port }.
 */
export async function chooseListen({
  tryListen,
  probe,
  wantPort,
  explicit,
  maxScan = 20,
  retries = 4,
  sleep = ms => new Promise(r => setTimeout(r, ms)),
}) {
  // 1. The desired port, with brief retries for a just-freed port.
  for (let i = 0; i <= retries; i++) {
    if (await tryListen(wantPort)) return { action: 'listening', port: wantPort };
    if (i < retries) await sleep(200);
  }
  // 2. Still busy — who holds it?
  if (await probe(wantPort)) return { action: 'openExisting', port: wantPort };
  if (explicit) return { action: 'error', port: wantPort };
  // 3. Foreign program on the default port — take the next free one.
  for (let p = wantPort + 1; p <= wantPort + maxScan; p++) {
    if (await tryListen(p)) return { action: 'listening', port: p };
  }
  return { action: 'error', port: wantPort };
}
