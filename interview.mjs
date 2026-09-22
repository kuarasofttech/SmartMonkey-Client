/**
 * The interview, owned by the APP rather than the agent. The builder prompt used
 * to ask these questions itself — fine in a chat, but in the app it meant free-text
 * questions (none clickable), a terminal the user had to sit in for CLI mode, and
 * unknowns dumped into openQuestions[]. Now the browser asks them up front with
 * real choices, and the build is told the answers before it starts.
 *
 * These mirror the "First, a short interview" section of builder-prompt.md (which
 * stays for people who paste the prompt into their own agent). One schema serves
 * the browser form (GET /api/interview) and the server (normalize → prompt block).
 */

export const QUESTIONS = [
  { id: 'produce', label: 'What should this run produce?', type: 'choice', default: 'blueprint', options: [
    { value: 'blueprint', label: 'The blueprint only', hint: 'SmartMonkey generates test cases later' },
    { value: 'blueprint+cases', label: 'The blueprint and test cases', hint: 'Now, with your AI' },
  ] },
  { id: 'casesSource', label: 'Where are your existing test cases?', type: 'choice', default: 'none', when: { produce: 'blueprint+cases' }, options: [
    { value: 'none', label: 'None yet', hint: 'Draft new ones from the app' },
    { value: 'repo', label: 'In this repo', hint: 'Code tests, checklists or Gherkin' },
    { value: 'jira', label: 'Jira / Xray' },
    { value: 'testrail', label: 'TestRail' },
    { value: 'zephyr', label: 'Zephyr' },
    { value: 'qtest', label: 'qTest' },
    { value: 'other', label: 'Somewhere else' },
  ] },
  { id: 'casesWhere', label: 'Where are they?', type: 'text', when: { casesSource: 'other' }, placeholder: 'For example a Google Sheet or a Notion page' },
  { id: 'casesAccess', label: 'How should it reach them?', type: 'choice', default: 'export', when: { casesSource: ['jira', 'testrail', 'zephyr', 'qtest', 'other'] }, options: [
    { value: 'token', label: 'Connect it', hint: 'An API token, or my CLI is already signed in' },
    { value: 'export', label: "I'll paste an export", hint: 'CSV or JSON' },
  ] },
  { id: 'build', label: 'Which build should a tester use?', type: 'text', hint: 'If there is more than one build or flavour.', placeholder: 'Default: the debug/dev variant', fallback: 'the debug/dev variant' },
  { id: 'targets', label: 'Which backend is safe to test against, and what must never be touched?', type: 'text', placeholder: 'Default: the dev backend is safe; never production', fallback: 'the dev/debug variant points at a safe dev backend; never run against production' },
  { id: 'shortcuts', label: 'Any test shortcuts?', type: 'text', long: true, hint: 'Deep links, a dev or test API, a hidden debug menu, a staging database. Dev and staging only.', placeholder: 'Default: none (the build still searches the code for them)', fallback: 'none that I know of — search the code for deep links, seed scripts and test endpoints' },
  { id: 'docs', label: 'What describes the app in depth?', type: 'multi', default: ['repo'], options: [
    { value: 'repo', label: 'Docs and screenshots in this repo' },
    { value: 'confluence', label: 'Confluence' },
    { value: 'notion', label: 'Notion' },
    { value: 'figma', label: 'Figma' },
    { value: 'jira', label: 'Jira stories' },
  ] },
  { id: 'priorities', label: 'What matters most, or breaks most?', type: 'text', placeholder: 'Default: the core happy path', fallback: 'the core happy path' },
  { id: 'coverage', label: 'How broad should testing go?', type: 'choice', default: 'smoke', options: [
    { value: 'smoke', label: 'Smoke the critical path' },
    { value: 'broad', label: 'Go broad' },
  ] },
  { id: 'cleanup', label: 'Clean up test data afterwards?', type: 'choice', default: 'leave', options: [
    { value: 'leave', label: 'Leave it' },
    { value: 'delete', label: 'Delete what tests create' },
  ] },
];

const byId = Object.fromEntries(QUESTIONS.map(x => [x.id, x]));

/** Is this question asked, given the answers so far? `when` maps an id to a value or a list of values. */
export function isAsked(q, answers) {
  if (!q.when) return true;
  return Object.entries(q.when).every(([id, want]) => {
    const have = answers[id];
    return Array.isArray(want) ? want.includes(have) : have === want;
  });
}

/** Browser answers → a clean record: defaults filled, unknown values dropped, closed branches removed. */
export function normalizeAnswers(raw = {}) {
  const out = {};
  for (const q of QUESTIONS) {
    if (!isAsked(q, out)) continue;          // evaluated against the answers already normalized above it
    const v = raw[q.id];
    if (q.type === 'choice') out[q.id] = q.options.some(o => o.value === v) ? v : q.default;
    else if (q.type === 'multi') out[q.id] = Array.isArray(v) ? [...new Set(v.filter(x => q.options.some(o => o.value === x)))] : [...q.default];
    else out[q.id] = typeof v === 'string' ? v.trim().slice(0, 2000) : '';
  }
  return out;
}

const CASE_TOOL = { jira: 'Jira', testrail: 'TestRail', zephyr: 'Zephyr', qtest: 'qTest' };
const DOC_TOOL = { confluence: 'Confluence', notion: 'Notion', figma: 'Figma', jira: 'Jira' };

/** The external tools the build will draw on — what the connect panel asks about. */
export function servicesFor(a) {
  const list = [];
  if (a.casesAccess === 'token') list.push(a.casesSource === 'other' ? (a.casesWhere || 'Your test-case tool') : CASE_TOOL[a.casesSource]);
  for (const d of a.docs || []) if (DOC_TOOL[d]) list.push(DOC_TOOL[d]);
  const seen = new Set();
  return list.filter(s => s && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()));
}

const labelOf = (q, v) => (q.options.find(o => o.value === v) || {}).label || v;

function answerLine(q, a) {
  const v = a[q.id];
  if (q.type === 'choice') { const o = q.options.find(x => x.value === v); return o ? `${o.label}${o.hint ? ` (${o.hint.charAt(0).toLowerCase()}${o.hint.slice(1)})` : ''}` : v; }
  if (q.type === 'multi') return v.length ? v.map(x => labelOf(q, x)).join(', ') : 'nothing beyond the code';
  return v || `(no answer — use the default: ${q.fallback || 'none'})`;
}

/**
 * The block prepended to builder-prompt.md so the build skips the interview. Also
 * carries the connect-step outcome and tightens when openQuestions[] may be used.
 */
export function answersBlock(a, connections) {
  const lines = QUESTIONS.filter(q => q.id in a).map(q => `- **${q.label}** ${answerLine(q, a)}`);
  return [
    '# The interview is ALREADY DONE (answered in the SmartMonkey app)',
    '',
    'The questions in "First, a short interview" below have already been answered in the SmartMonkey app. **Do not re-ask any of them.** Use these answers and go straight on:',
    '',
    ...lines,
    '',
    `**Connections:** ${connections || 'No external tools to connect — none needed.'} For a tool I skipped or couldn't connect, don't try to reach it; use what is in the repo and what I've told you here.`,
    '',
    '**The connect step is also done** — do not call `request_connections`.',
    '',
    '**Project-specific questions:** while you work, when you hit something about THIS project that the repo can\'t settle and whose answer would change the blueprint (which of two login flows testers use, whether a dev endpoint needs auth, which flavour ships…), ask me with the `ask_user` tool — one question per call, with 2–6 short `options` when the answer is one of a few (`multi: true` if several apply). I\'m answering in the app, so ask as you go; keep it to the questions that matter. If you have no `ask_user` tool, don\'t wait for me.',
    '',
    '**Open questions:** search the code, tests and docs first. Minor gaps, and anything I skip or can\'t answer, go in `openQuestions[]` — never for something a default above already covers, and never as a way to avoid looking.',
    '',
    '---',
    '',
  ].join('\n');
}
