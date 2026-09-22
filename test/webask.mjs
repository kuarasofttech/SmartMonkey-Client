/**
 * webask.mjs — the ask()/answer() bridge, pure (no HTTP).
 *   node test/webask.mjs
 */
import { strict as assert } from 'node:assert';
const { makeWebAsk, answerAsk } = await import('../webask.mjs');

let failures = 0;
async function check(name, fn) { try { await fn(); console.log(`  ok  ${name}`); } catch (e) { failures++; console.error(`FAIL  ${name}: ${e.message}`); } }

await check('ask sets pendingAsk + emits, right id resolves, wrong id ignored', async () => {
  const session = {};
  const emitted = [];
  const ask = makeWebAsk(session, (type, data) => emitted.push({ type, data }));
  const p = ask('Which source?', ['Jira', 'Confluence']);
  assert.ok(session.pendingAsk && session.pendingAsk.id.startsWith('ask_'));
  assert.equal(emitted[0].type, 'ask');
  assert.deepEqual(emitted[0].data.options, ['Jira', 'Confluence']);
  assert.equal(answerAsk(session, 'ask_999', 'nope'), false);          // stale/wrong id ignored
  assert.ok(session.pendingAsk, 'still pending after a wrong id');
  assert.equal(answerAsk(session, session.pendingAsk.id, 'Confluence'), true);
  assert.equal(await p, 'Confluence');
  assert.equal(session.pendingAsk, null);
});

await check('free-text ask (no options) works', async () => {
  const session = {};
  const ask = makeWebAsk(session, () => {});
  const p = ask('Build command?');
  assert.equal(session.pendingAsk.options, undefined);
  answerAsk(session, session.pendingAsk.id, './gradlew assembleDebug');
  assert.equal(await p, './gradlew assembleDebug');
});

await check('multi-choice ask: flagged on the event, and an array answer is joined', async () => {
  const session = {}; const emitted = [];
  const ask = makeWebAsk(session, (type, data) => emitted.push({ type, data }));
  const p = ask('Which platforms?', ['Android', 'iOS', 'Web'], true);
  assert.equal(emitted[0].data.multi, true);
  assert.equal(session.pendingAsk.multi, true);
  answerAsk(session, session.pendingAsk.id, ['Android', 'iOS']);
  assert.equal(await p, 'Android, iOS');
});

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nwebask: all passed');
