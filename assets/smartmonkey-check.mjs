#!/usr/bin/env node
/**
 * smartmonkey check — has the code moved since this QA profile was built?
 *
 *   node smartmonkey-check.mjs profile.json [--repo <dir>] [--strict] [--list] [--watch]
 *
 * Self-contained (no dependencies). The profile carries no file paths — your
 * source never leaves your machine — so freshness is anchored to the build
 * commit (`profile.commit`). This runs in YOUR repo and diffs the working tree
 * against that commit:
 *
 *   fresh   → nothing changed since the profile was built
 *   moved   → the code advanced; skim the changed files and re-profile if any
 *             affect how the app is tested
 *   unknown → no build commit stamped
 *
 * Exit 0 by default (informational). Pass --strict to fail (exit 3) when the
 * code has moved — drop that into a release gate. --list prints the changed
 * files (they stay on your machine; nothing is uploaded). --watch keeps running
 * and re-checks whenever the repo changes (Ctrl-C to stop).
 */
import { readFileSync, watch } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, basename } from 'node:path';

const args = process.argv.slice(2);
const profilePath = args.find(a => !a.startsWith('--'));
if (!profilePath) {
  console.error('usage: node smartmonkey-check.mjs <profile.json> [--repo <dir>] [--strict] [--list] [--watch]');
  process.exit(2);
}
const repoIdx = args.indexOf('--repo');
const repo = repoIdx >= 0 ? args[repoIdx + 1] : dirname(resolve(profilePath));
const watching = args.includes('--watch');

/** One check. Returns the exit code it would use (0 fresh/unknown, 3 moved). */
function runOnce() {
  let profile;
  try { profile = JSON.parse(readFileSync(profilePath, 'utf8')); }
  catch (e) { console.error(`cannot read ${profilePath}: ${e.message}`); return 2; }

  const commit = typeof profile.commit === 'string' ? profile.commit.trim().split(/\s/)[0] : undefined;
  if (!commit) {
    console.log('? UNKNOWN — no build commit is stamped in the profile. Re-run the prompt to enable freshness checks.');
    return 0;
  }
  let changed;
  try {
    changed = execFileSync('git', ['-C', repo, 'diff', '--name-only', commit], { encoding: 'utf8' })
      .split('\n').map(s => s.trim()).filter(Boolean);
  } catch (e) {
    console.error(`git diff failed (is ${repo} a git repo, and is ${commit.slice(0, 12)} present?): ${String(e.message).split('\n')[0]}`);
    return 2;
  }
  if (!changed.length) {
    console.log('✓ FRESH — nothing has changed since this profile was built.');
    console.log(`  build commit: ${commit.slice(0, 12)}   files changed since: 0`);
    return 0;
  }
  console.log('⚠ MOVED — the code has changed since the profile was built. Skim the changes; re-run the prompt if any affect how the app is tested.');
  console.log(`  build commit: ${commit.slice(0, 12)}   files changed since: ${changed.length}`);
  if (args.includes('--list')) {
    console.log('  changed (local to you — not uploaded):');
    for (const f of changed.slice(0, 50)) console.log(`    - ${f}`);
    if (changed.length > 50) console.log(`    …and ${changed.length - 50} more`);
  }
  return 3;
}

if (!watching) {
  const code = runOnce();
  process.exit(args.includes('--strict') && code === 3 ? 3 : (code === 2 ? 2 : 0));
}

// --watch: check once, then re-check (debounced) on any repo change. Ignore the
// usual noise so we don't loop on our own reads or git's internals.
const IGNORE = /(^|\/)(\.git|node_modules|build|dist|\.gradle|\.idea|DerivedData|Pods)(\/|$)/;
const label = basename(resolve(profilePath));
console.log(`watching ${repo} — re-checking ${label} on change (Ctrl-C to stop)\n`);
runOnce();

let timer = null;
try {
  watch(repo, { recursive: true }, (_event, filename) => {
    if (filename && IGNORE.test(filename.replace(/\\/g, '/'))) return;
    clearTimeout(timer);
    timer = setTimeout(() => { console.log(`\n— change detected (${filename ?? '?'}) —`); runOnce(); }, 400);
  });
} catch (e) {
  // Recursive watch isn't supported on some Linux setups; fall back to a poll.
  console.error(`(recursive watch unavailable: ${e.message}; polling every 5s)`);
  setInterval(runOnce, 5000);
}
