#!/usr/bin/env node
// Fork discipline gate — two rules this FORK adds on top of upstream, both
// enforced on the pull request rather than trusted to habit.
//
// Rule 1 · every commit explains itself.
//   A conventional subject (`type(scope): …`, scope optional), a body of real
//   sentences, and no agent-session URLs. Measured 2026-09-04 against upstream:
//   0 of upstream's last 45 commits lacked a body, against 10 of this fork's
//   33 — and all ten were recent. This log is public; a bodyless `feat:` is
//   the first thing a reader sees.
//
// Rule 2 · the factory stays product-agnostic.
//   Product-specific identifiers belong in the product repo's own tracked
//   config, never in factory source or fixtures. This repo is public and the
//   product repo is not. Enforced on ADDED lines only, so it is a ratchet:
//   existing occurrences are fixed by whoever next touches that file, and no
//   new one can enter.
//
// Usage: node scripts/fork-discipline-check.mjs <baseSha> <headSha>
// No network, no dependencies.

import { execFileSync } from 'node:child_process';

const [, , baseSha, headSha] = process.argv;
if (!baseSha || !headSha) {
  console.error('usage: fork-discipline-check.mjs <baseSha> <headSha>');
  process.exit(2);
}

const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const SUBJECT_RE = /^(feat|fix|test|docs|chore|refactor|perf|build|ci|revert)(\([a-z0-9._/-]+\))?: .{6,}$/;
const MIN_BODY_WORDS = 15;
// Deliberately short and explicit. A broad regex here would fail on ordinary
// English and teach people to route around the gate instead of obeying it.
const PRODUCT_TERMS = ['SudokuDaily', 'Sudoku Daily', 'Quiet Nine', 'quietnine', 'QuietNine', 'sudoku-daily'];
const UNIT = String.fromCharCode(31);
const REC = String.fromCharCode(30);

const failures = [];

// ---- Rule 1: commit messages ------------------------------------------------
const raw = git(['log', '--no-merges', '--format=%H%x1f%s%x1f%b%x1e', baseSha + '..' + headSha]);
const commits = raw.split(REC).map(c => c.trim()).filter(Boolean).map(c => {
  const [sha, subject, body = ''] = c.split(UNIT);
  return { sha, subject, body };
});

for (const { sha, subject, body } of commits) {
  const short = sha.slice(0, 7);
  if (!SUBJECT_RE.test(subject)) {
    failures.push(short + ' subject is not `type(scope): summary` — got: ' + subject);
  }
  const prose = body
    .split('\n')
    .filter(l => !/^[A-Za-z-]+:\s/.test(l.trim()))   // drop trailers
    .join(' ')
    .trim();
  const words = prose ? prose.split(/\s+/).length : 0;
  if (words < MIN_BODY_WORDS) {
    failures.push(short + ' body is ' + words + ' words, minimum ' + MIN_BODY_WORDS +
      ' — say what was wrong and why this fixes it: ' + subject);
  }
  if (/^Claude-Session:\s*http/m.test(body)) {
    failures.push(short + ' carries a Claude-Session URL. This repository is public and the link ' +
      'tells a reader nothing — remove it.');
  }
}

// ---- Rule 2: no product identifiers on added lines --------------------------
const diff = git(['diff', '--unified=0', baseSha + '...' + headSha]);
// One violation per file+term, not per line: a fixture that names a product
// forty times is one thing to fix, and forty identical lines would bury the
// commit-message findings above it.
const seen = new Set();
let file = null;
for (const line of diff.split('\n')) {
  if (line.startsWith('+++ b/')) { file = line.slice(6); continue; }
  if (!line.startsWith('+') || line.startsWith('+++')) continue;
  if (file === 'scripts/fork-discipline-check.mjs' || file === 'CONTRIBUTING.md') continue;
  for (const term of PRODUCT_TERMS) {
    if (!line.includes(term)) continue;
    const key = file + '\u0000' + term;
    if (!seen.has(key)) {
      seen.add(key);
      failures.push(file + ': adds product identifier "' + term + '" — the factory stays ' +
        'product-agnostic; this belongs in the product repo’s own tracked config.\n      first: ' +
        line.slice(1).trim().slice(0, 120));
    }
    break;
  }
}

if (failures.length) {
  console.error('\nFork discipline: ' + failures.length + ' violation(s).\n');
  for (const f of failures) console.error('  - ' + f);
  console.error('\nRules and rationale: CONTRIBUTING.md, "Fork discipline".\n');
  process.exit(1);
}
console.log('Fork discipline: ' + commits.length + ' commit(s) checked, no violations.');
