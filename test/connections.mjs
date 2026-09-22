/**
 * The connect-gate bridge: park a connections request, connect/skip each service,
 * and start only when every service is resolved. Pure session logic, no network.
 *   node test/connections.mjs
 */
import { strict as assert } from 'node:assert';
const { makeWebConnections, setConnection, startConnections, allResolved } = await import('../webask.mjs');

let failures = 0;
function check(name, fn) { try { fn(); console.log(`  ok  ${name}`); } catch (e) { failures++; console.error(`FAIL  ${name}: ${e.message}`); } }

check('parking emits a connections event and records pending services', () => {
  const events = []; const session = {};
  const req = makeWebConnections(session, (type, data) => events.push({ type, data }));
  req(['Jira', 'Figma', 'Jira']);   // dupe collapses
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'connections');
  assert.deepEqual(session.pendingConnections.services, ['Jira', 'Figma']);
  assert.deepEqual(session.pendingConnections.status, { Jira: 'pending', Figma: 'pending' });
});

check('non-string / blank services are dropped', () => {
  const session = {};
  makeWebConnections(session, () => {})([ 'Jira', '', '  ', { label: 'Confluence' }, null ]);
  assert.deepEqual(session.pendingConnections.services, ['Jira', 'Confluence']);
});

check('connect and skip flip status; unknown service/id are rejected', () => {
  const session = {};
  makeWebConnections(session, () => {})(['Jira', 'Figma']);
  const id = session.pendingConnections.id;
  assert.equal(setConnection(session, id, 'Jira', 'connect'), true);
  assert.equal(setConnection(session, id, 'Figma', 'skip'), true);
  assert.equal(setConnection(session, id, 'Nope', 'connect'), false, 'unknown service rejected');
  assert.equal(setConnection(session, 'bad-id', 'Jira', 'connect'), false, 'wrong id rejected');
  assert.equal(setConnection(session, id, 'Jira', 'bogus'), false, 'unknown action rejected');
  assert.deepEqual(session.pendingConnections.status, { Jira: 'connected', Figma: 'skipped' });
});

check('start is refused until EVERY service is connected or skipped', async () => {
  let resolved = null;
  const session = {};
  const p = makeWebConnections(session, () => {})(['Jira', 'Figma']);
  p.then(v => { resolved = v; });
  const id = session.pendingConnections.id;
  assert.equal(allResolved(session.pendingConnections), false);
  assert.equal(startConnections(session, id), false, 'refused while Jira/Figma still pending');
  setConnection(session, id, 'Jira', 'connect');
  assert.equal(startConnections(session, id), false, 'refused while Figma still pending');
  setConnection(session, id, 'Figma', 'skip');
  assert.equal(allResolved(session.pendingConnections), true);
  assert.equal(startConnections(session, id), true, 'allowed once all resolved');
  assert.equal(session.pendingConnections, null, 'pending cleared after start');
  await Promise.resolve();
  assert.match(resolved, /Connected: Jira/);
  assert.match(resolved, /Skipped: Figma/);
});

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nconnections: all passed');
