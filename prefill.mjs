/**
 * Pre-selecting last time's choices when a question comes up again on a re-run.
 *
 * The agent writes its questions fresh every run, so the same question rarely
 * comes back word for word ("Which build should a tester use?" → "Which build
 * variant should testers install?"), and its options are reworded too. So this
 * matches loosely: word overlap between the questions, helped by the previous
 * pick reappearing among the new options. When nothing matches well, it suggests
 * nothing — a wrong pre-selection is worse than none, because one click sends it.
 */

const STOP = new Set('a an the and or of to for in on at by with is are be do does should would could can will your you i we it this that which what how who when where there any all some use tester testers'.split(' '));
const words = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
  .filter(w => w && !STOP.has(w)).map(w => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));
const norm = s => words(s).join(' ');
function similar(a, b) {
  const A = new Set(words(a)), B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  let both = 0; for (const w of A) if (B.has(w)) both++;
  return both / (A.size + B.size - both);
}

/** The option a previous pick corresponds to, or null. */
function matchOption(pick, options) {
  const n = norm(pick); if (!n) return null;
  const exact = options.find(o => norm(o) === n); if (exact) return exact;
  let best = null, score = 0;
  for (const o of options) { const s = similar(pick, o); if (s > score) { best = o; score = s; } }
  if (score >= 0.6) return best;
  // the new option only ADDS words to the old pick ("devDebug" → "devDebug (dev backend)") — unambiguous if just one does
  const P = words(pick), holders = options.filter(o => { const O = new Set(words(o)); return P.every(w => O.has(w)); });
  return holders.length === 1 ? holders[0] : null;
}

/** An old record kept only the joined answer; split it back when its parts are options. */
const picksOf = p => (Array.isArray(p.picked) && p.picked.length ? p.picked : [String(p.answer || '')]);

/**
 * previous: [{ question, answer, picked? }] (newest last). Returns
 * { picked: [option labels], other?: string, from: previous question } or null.
 */
export function suggestFor(question, options, multi, previous = []) {
  const opts = Array.isArray(options) ? options.map(String) : [];
  let best = null, bestScore = 0;
  for (const p of previous) {
    if (!p || !p.question) continue;
    const qs = similar(question, p.question);
    let picks = picksOf(p);
    if (picks.length === 1 && opts.length && !matchOption(picks[0], opts) && picks[0].includes(', ')) picks = picks[0].split(', ');
    const matched = [...new Set(picks.map(x => matchOption(x, opts)).filter(Boolean))];
    // a strong question match stands alone; a weaker one needs the old pick among the new options
    const score = qs >= 0.6 ? qs + (matched.length ? 0.5 : 0) : qs >= 0.3 && matched.length ? qs + 0.5 : 0;
    if (score > bestScore || (score === bestScore && score > 0)) { best = { p, picks, matched, qs }; bestScore = score; }
  }
  if (!best) return null;
  const { p, picks, matched, qs } = best;
  if (matched.length) return { picked: multi ? matched : matched.slice(0, 1), from: p.question };
  const typed = picks.join(', ').trim();
  // nothing among the options: last time they typed their own — offer it again, only on a clear match
  return qs >= 0.75 && typed ? { picked: [], other: typed, from: p.question } : null;
}

/** answered events of a build → previous answers, merged over (and winning against) the general record. */
export function previousAnswers(general = [], buildEvents = []) {
  const byQ = new Map(general.filter(x => x && x.question).map(x => [x.question, x]));
  for (const ev of buildEvents) {
    const d = ev && ev.type === 'answered' && ev.data;
    if (d && d.question && d.answer) { byQ.delete(d.question); byQ.set(d.question, { question: d.question, answer: d.answer, picked: d.picked }); }
  }
  return [...byQ.values()];
}
