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

check('nothing is connectable by default: "connect" is refused, the event says so', () => {
  const session = {}; const events = [];
  makeWebConnections(session, (t, d) => events.push(d))(['Linear', 'Figma']);
  const id = session.pendingConnections.id;
  assert.deepEqual(events[0].connectable, { Linear: false, Figma: false });
  assert.equal(setConnection(session, id, 'Linear', 'connect'), false, 'no real connector → no fake "Connected"');
  assert.equal(setConnection(session, id, 'Linear', 'skip'), true);
  assert.deepEqual(session.pendingConnections.status, { Linear: 'skipped', Figma: 'pending' });
});

check('a tool with a real connector can be connected; unknown service/id/action are rejected', () => {
  const session = {};
  makeWebConnections(session, () => {}, { isConnectable: s => s === 'Jira' })(['Jira', 'Figma']);
  const id = session.pendingConnections.id;
  assert.equal(setConnection(session, id, 'Jira', 'connect'), true);
  assert.equal(setConnection(session, id, 'Figma', 'connect'), false, 'Figma has no connector');
  assert.equal(setConnection(session, id, 'Figma', 'skip'), true);
  assert.equal(setConnection(session, id, 'Nope', 'skip'), false, 'unknown service rejected');
  assert.equal(setConnection(session, 'bad-id', 'Jira', 'skip'), false, 'wrong id rejected');
  assert.equal(setConnection(session, id, 'Jira', 'bogus'), false, 'unknown action rejected');
  assert.deepEqual(session.pendingConnections.status, { Jira: 'connected', Figma: 'skipped' });
});

check('start is refused until every service is resolved; the summary says "Not connected", never a fake "Connected"', async () => {
  let resolved = null;
  const session = {};
  makeWebConnections(session, () => {})(['Linear', 'Figma']).then(v => { resolved = v; });
  const id = session.pendingConnections.id;
  assert.equal(allResolved(session.pendingConnections), false);
  assert.equal(startConnections(session, id), false, 'refused while pending');
  setConnection(session, id, 'Linear', 'skip');
  assert.equal(startConnections(session, id), false, 'refused while Figma pending');
  setConnection(session, id, 'Figma', 'skip');
  assert.equal(startConnections(session, id), true);
  assert.equal(session.pendingConnections, null);
  await Promise.resolve();
  assert.match(resolved, /Connected: none\./);
  assert.match(resolved, /Not connected: Linear, Figma\./);
});

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nconnections: all passed');
