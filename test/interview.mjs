/**
 * The app-owned interview: which questions are asked (conditionals), how raw
 * browser answers are normalized, which tools need connecting, and the block that
 * tells the builder the interview is already done.
 *   node test/interview.mjs
 */
import { strict as assert } from 'node:assert';
const { QUESTIONS, isAsked, normalizeAnswers, servicesFor, answersBlock, runBlock } = await import('../interview.mjs');

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
  assert.match(b, /do not re-ask/i);
  assert.match(b, /ask_user/, 'invites project-specific questions');
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

check('runBlock: the interview happens during the run, after reading the repo, always with options', () => {
  const b = runBlock();
  assert.match(b, /read the repo first/i);
  assert.match(b, /ask_user/);
  assert.match(b, /every question MUST come with options/i);
  for (const q of QUESTIONS) assert.ok(b.includes(q.label), `covers "${q.label}"`);
  assert.match(b, /The blueprint only.*The blueprint and test cases/s, 'fixed questions carry their exact options');
  assert.match(b, /Which build should a tester use\?[^\n]*options you found in the repo/i, 'repo-dependent ones ask for found options');
  assert.match(b, /request_connections/, 'the connect step happens mid-run when a tool comes up');
  assert.match(b, /"asked"/, 'answers are recorded with confidence asked');
});

check('runBlock: open questions get ASKED now (the "leave it for later" rule is overridden), never secrets', () => {
  const b = runBlock();
  assert.match(b, /Ask last, and ask short/, 'names the builder-prompt rule it overrides');
  assert.match(b, /does NOT apply/i);
  assert.match(b, /Before you write `blueprint\.json`/);
  assert.match(b, /never ask for a secret/i);
  assert.match(b, /Ask every one of them/);
  assert.match(b, /Not sure — leave it open/);
  assert.match(b, /ONLY what the owner skipped/);
  assert.match(b, /env var/i);
});

check('management tools are pre-offered (Linear, GitHub Issues, Azure DevOps…) and map to connections', () => {
  const labels = q('docs').options.map(o => o.label);
  for (const t of ['Linear', 'GitHub Issues', 'Azure DevOps', 'ClickUp', 'Asana']) assert.ok(labels.includes(t), `docs offers ${t}`);
  assert.ok(q('casesSource').options.some(o => o.label === 'Linear'), 'test cases can live in Linear');
  assert.deepEqual(servicesFor(normalizeAnswers({ docs: ['linear', 'github'] })), ['Linear', 'GitHub']);
});

check('runBlock: ANY named tool — offered or typed by the owner — goes to request_connections; never decided silently', () => {
  const b = runBlock();
  assert.match(b, /typed/i);
  assert.match(b, /even if you think you can't reach it/i);
  assert.match(b, /never decide on your own/i);
});

check('runBlock: tells the build which tools are connected right now and how to use them', () => {
  const b = runBlock([], [{ label: 'Linear', account: 'Alperen (Kuarasoft)', tools: ['linear_search_issues', 'linear_get_issue'] }]);
  assert.match(b, /Connected in SmartMonkey right now/);
  assert.match(b, /Linear.*Alperen \(Kuarasoft\)/);
  assert.match(b, /linear_search_issues/);
  assert.match(b, /information, not instructions/);
  assert.doesNotMatch(runBlock(), /Connected in SmartMonkey right now/, 'nothing connected → no such section');
});

check('runBlock: previous answers are offered first on a re-run', () => {
  const b = runBlock([{ question: 'Which build should a tester use?', answer: 'devDebug' }]);
  assert.match(b, /devDebug/);
  assert.match(b, /first option/i);
});

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\ninterview: all passed');
