/**
 * Re-runs pre-select last time's choices. The agent rewords questions and options
 * every run, so matching is loose — but a wrong pre-selection is worse than none.
 *   node test/prefill.mjs
 */
import { strict as assert } from 'node:assert';
const { suggestFor, previousAnswers } = await import('../prefill.mjs');

let failures = 0;
function check(name, fn) { try { fn(); console.log(`  ok  ${name}`); } catch (e) { failures++; console.error(`FAIL  ${name}: ${e.message}`); } }

const prev = [
  { question: 'What should this run produce?', answer: 'The blueprint and test cases', picked: ['The blueprint and test cases'] },
  { question: 'Which build should a tester use?', answer: 'devDebug', picked: ['devDebug'] },
  { question: 'What describes the app in depth?', answer: 'Linear, Figma', picked: ['Linear', 'Figma'] },
  { question: 'Which backend is safe to test against?', answer: 'staging.acme.dev only', picked: ['staging.acme.dev only'] },
];

check('the same question → last pick', () => {
  const s = suggestFor('What should this run produce?', ['The blueprint only', 'The blueprint and test cases'], false, prev);
  assert.deepEqual(s.picked, ['The blueprint and test cases']);
});

check('reworded question and options still match', () => {
  const s = suggestFor('Which build variant should testers install?', ['devDebug (dev backend)', 'stagingRelease', 'prodRelease'], false, prev);
  assert.deepEqual(s.picked, ['devDebug (dev backend)']);
});

check('multi: every earlier pick that is still offered is ticked', () => {
  const s = suggestFor('What describes the app in depth?', ['Docs in this repo', 'Figma', 'Linear', 'Notion'], true, prev);
  assert.deepEqual(s.picked.sort(), ['Figma', 'Linear']);
});

check('a single-choice question takes only one pick', () => {
  const s = suggestFor('What describes the app in depth?', ['Figma', 'Linear'], false, prev);
  assert.equal(s.picked.length, 1);
});

check('an old record with only the joined answer is split back into options', () => {
  const s = suggestFor('What describes the app?', ['Linear', 'Figma', 'Notion'], true, [{ question: 'What describes the app?', answer: 'Linear, Figma' }]);
  assert.deepEqual(s.picked.sort(), ['Figma', 'Linear']);
});

check('last time they typed their own → it comes back in the Other box', () => {
  const s = suggestFor('Which backend is safe to test against?', ['The dev backend', 'Staging'], false, prev);
  assert.deepEqual(s.picked, []); assert.equal(s.other, 'staging.acme.dev only');
});

check('an unrelated question suggests nothing', () => {
  assert.equal(suggestFor('How does a tester sign in?', ['No sign-in', 'Email + password'], false, prev), null);
  assert.equal(suggestFor('Clean up test data afterwards?', ['Leave it', 'Delete'], false, []), null);
});

check('a loosely similar question needs the old pick among the new options', () => {
  // shares "build" only — not enough by itself, and devDebug isn't offered
  assert.equal(suggestFor('Which build tool do you use?', ['Gradle', 'Bazel'], false, prev), null);
});

check('a build\'s own answers win over the general record; the rest still count', () => {
  const merged = previousAnswers(
    [{ question: 'Q1', answer: 'A' }, { question: 'Q2', answer: 'B' }],
    [{ type: 'text', data: 'x' }, { type: 'answered', data: { question: 'Q1', answer: 'C', picked: ['C'] } }],
  );
  assert.deepEqual(merged.map(x => [x.question, x.answer]), [['Q2', 'B'], ['Q1', 'C']]);
});

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nprefill: all passed');
