/**
 * The app-owned interview: which questions are asked (conditionals), how raw
 * browser answers are normalized, which tools need connecting, and the block that
 * tells the builder the interview is already done.
 *   node test/interview.mjs
 */
import { strict as assert } from 'node:assert';
const { QUESTIONS, isAsked, normalizeAnswers, servicesFor, answersBlock } = await import('../interview.mjs');

let failures = 0;
function check(name, fn) { try { fn(); console.log(`  ok  ${name}`); } catch (e) { failures++; console.error(`FAIL  ${name}: ${e.message}`); } }
const q = id => QUESTIONS.find(x => x.id === id);

check('every question has an id, a label and a known type; choices have their default among the options', () => {
  const ids = new Set();
  for (const x of QUESTIONS) {
    assert.ok(x.id && !ids.has(x.id), `unique id ${x.id}`); ids.add(x.id);
    assert.ok(x.label, `${x.id} has a label`);
    assert.ok(['choice', 'multi', 'text'].includes(x.type), `${x.id} type`);
    if (x.type === 'choice') assert.ok(x.options.some(o => o.value === x.default), `${x.id} default is an option`);
    if (x.type === 'multi') assert.ok(x.default.every(v => x.options.some(o => o.value === v)), `${x.id} defaults are options`);
  }
});

check('conditionals: case questions only appear when generating cases, access only for external tools', () => {
  assert.equal(isAsked(q('casesSource'), { produce: 'blueprint' }), false);
  assert.equal(isAsked(q('casesSource'), { produce: 'blueprint+cases' }), true);
  assert.equal(isAsked(q('casesAccess'), { produce: 'blueprint+cases', casesSource: 'repo' }), false);
  assert.equal(isAsked(q('casesAccess'), { produce: 'blueprint+cases', casesSource: 'jira' }), true);
  assert.equal(isAsked(q('casesWhere'), { produce: 'blueprint+cases', casesSource: 'other' }), true);
});

check('normalize: missing answers take the defaults; unknown values fall back; texts are trimmed', () => {
  const a = normalizeAnswers({ produce: 'nonsense', build: '  debug flavour  ' });
  assert.equal(a.produce, 'blueprint', 'invalid choice → default');
  assert.equal(a.build, 'debug flavour');
  assert.equal(a.coverage, 'smoke');
  assert.deepEqual(a.docs, ['repo']);
  assert.equal('casesSource' in a, false, 'unasked conditional questions are dropped');
});

check('normalize: a conditional answer is dropped once its branch is closed', () => {
  const a = normalizeAnswers({ produce: 'blueprint', casesSource: 'jira', casesAccess: 'token' });
  assert.equal('casesSource' in a, false);
  assert.equal('casesAccess' in a, false);
});

check('normalize: multi keeps only known values and allows an explicit empty choice', () => {
  assert.deepEqual(normalizeAnswers({ docs: ['figma', 'bogus', 'figma'] }).docs, ['figma']);
  assert.deepEqual(normalizeAnswers({ docs: [] }).docs, []);
});

check('servicesFor: a case tool needs connecting only when reached by token; docs add their tools; no dupes', () => {
  const viaToken = normalizeAnswers({ produce: 'blueprint+cases', casesSource: 'jira', casesAccess: 'token', docs: ['jira', 'figma'] });
  assert.deepEqual(servicesFor(viaToken), ['Jira', 'Figma']);
  const viaExport = normalizeAnswers({ produce: 'blueprint+cases', casesSource: 'testrail', casesAccess: 'export', docs: ['repo'] });
  assert.deepEqual(servicesFor(viaExport), [], 'a pasted export needs no connection');
  const other = normalizeAnswers({ produce: 'blueprint+cases', casesSource: 'other', casesWhere: 'Google Sheets', casesAccess: 'token' });
  assert.deepEqual(servicesFor(other), ['Google Sheets']);
});

check('answersBlock: says the interview is done, carries every answer, and tightens open questions', () => {
  const a = normalizeAnswers({ produce: 'blueprint+cases', casesSource: 'jira', casesAccess: 'token', build: 'devDebug', docs: ['figma'] });
  const b = answersBlock(a, 'Connected: Jira. Skipped: Figma.');
  assert.match(b, /already (been )?answered|ALREADY DONE/i);
  assert.match(b, /do not ask/i);
  assert.match(b, /The blueprint and test cases/);
  assert.match(b, /Jira \/ Xray/);
  assert.match(b, /devDebug/);
  assert.match(b, /Connected: Jira\. Skipped: Figma\./);
  assert.match(b, /openQuestions/);
  assert.match(b, /request_connections/, 'tells the agent not to run the connect step again');
});

check('answersBlock: a blank text answer states the default instead of leaving it empty', () => {
  const b = answersBlock(normalizeAnswers({}), null);
  assert.match(b, /debug\/dev variant/);
  assert.match(b, /No external tools to connect|none needed/i);
});

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\ninterview: all passed');
