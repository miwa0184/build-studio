'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { referencedNames, resolveReferences, inlineReferencedDefinitions } = require('./agent-skills');

// A fake project tree, so the resolution rules are testable without a checkout.
const ROOT = '/proj';
const FILES = {
  [path.join(ROOT, '.claude/commands/qa.md')]: '# QA role\n\nRun the suite. Visual smoke via playwright-cli.',
  [path.join(ROOT, '.claude/commands/ios_dev.md')]: '# iOS Dev role',
  [path.join(ROOT, '.claude/skills/qa-browser-testing/SKILL.md')]: '# Browser testing\n\nplaywright-cli open <url>',
};
const fakeFs = {
  existsSync: (p) => Object.prototype.hasOwnProperty.call(FILES, p),
  readFileSync: (p) => {
    if (!Object.prototype.hasOwnProperty.call(FILES, p)) throw new Error(`ENOENT ${p}`);
    return FILES[p];
  },
};

const QA_PROMPT = 'You are QA. Use the /qa skill. Use the `qa-browser-testing` skill for any browser-based verification.';

test('it finds the command and skill names a prompt refers to', () => {
  const { commands, skills } = referencedNames(QA_PROMPT);
  assert.deepEqual(commands, ['qa']);
  assert.deepEqual(skills, ['qa-browser-testing']);
});

test('path segments are not mistaken for command references', () => {
  // The common false positive, and an expensive one: `docs/qa/QA-105.md` would
  // otherwise inline the whole QA role into a prompt that never asked for it.
  const { commands } = referencedNames(
    'Read docs/qa/QA-105.md and e2e/support/expected-dataset.js, then run npx/vitest.');
  assert.deepEqual(commands, []);
});

test('a reference resolves only when the file actually exists', () => {
  // `/code-review` is a Claude Code built-in, not a project role file — there is
  // nothing on disk to inline, and inventing one would be worse than silence.
  const refs = resolveReferences('Use the /qa skill and the /code-review skill.', { roots: [ROOT], fs: fakeFs });
  assert.deepEqual(refs.map((r) => r.name), ['qa']);
});

test('claude gets nothing appended — it loads .claude itself', () => {
  assert.equal(inlineReferencedDefinitions(QA_PROMPT, { cli: 'claude', roots: [ROOT], fs: fakeFs }), '');
});

test('codex gets the full text of everything its prompt names', () => {
  const out = inlineReferencedDefinitions(QA_PROMPT, { cli: 'codex', roots: [ROOT], fs: fakeFs });
  assert.match(out, /ROLE DEFINITIONS AND SKILLS REFERRED TO ABOVE/);
  assert.match(out, /### \/qa \(command\)/);
  assert.match(out, /Run the suite\. Visual smoke via playwright-cli\./);
  assert.match(out, /### `qa-browser-testing` \(skill\)/);
  assert.match(out, /playwright-cli open <url>/);
});

test('it forbids substituting a similar-sounding capability', () => {
  // The actual failure mode: told the skill was "absent", the agent used its own
  // in-app browser runtime instead and reported the resulting error as a defect.
  const out = inlineReferencedDefinitions(QA_PROMPT, { cli: 'codex', roots: [ROOT], fs: fakeFs });
  assert.match(out, /do not substitute a similar-sounding capability of your own/);
  assert.match(out, /This is the definitive version/);
});

test('opencode is treated like codex, not like claude', () => {
  assert.notEqual(inlineReferencedDefinitions(QA_PROMPT, { cli: 'opencode', roots: [ROOT], fs: fakeFs }), '');
});

test('nothing referenced, nothing appended', () => {
  assert.equal(inlineReferencedDefinitions('Run the tests and report.', { cli: 'codex', roots: [ROOT], fs: fakeFs }), '');
});

test('roots are tried in order, so a worktree copy wins over the project root', () => {
  const wtFile = path.join('/wt', '.claude/commands/qa.md');
  const fs2 = {
    existsSync: (p) => p === wtFile || fakeFs.existsSync(p),
    readFileSync: (p) => (p === wtFile ? '# QA role (branch-local)' : fakeFs.readFileSync(p)),
  };
  const out = inlineReferencedDefinitions(QA_PROMPT, { cli: 'codex', roots: ['/wt', ROOT], fs: fs2 });
  assert.match(out, /branch-local/);
  // …and a worktree without .claude still resolves against the project root,
  // rather than silently finding nothing.
  const out2 = inlineReferencedDefinitions(QA_PROMPT, { cli: 'codex', roots: ['/empty', ROOT], fs: fakeFs });
  assert.match(out2, /Run the suite/);
});

test('an oversized file is skipped and SAID to be skipped', () => {
  // Silent truncation would read as "this is the whole role definition".
  const big = { ...FILES };
  big[path.join(ROOT, '.claude/commands/qa.md')] = 'x'.repeat(5000);
  const fs3 = { existsSync: fakeFs.existsSync, readFileSync: (p) => big[p] ?? fakeFs.readFileSync(p) };
  const out = inlineReferencedDefinitions(QA_PROMPT, { cli: 'codex', roots: [ROOT], fs: fs3, maxBytes: 1000 });
  assert.match(out, /Not inlined \(too large for the prompt budget\): qa/);
  assert.match(out, /qa-browser-testing/); // the small one still made it
});

test('a missing or unreadable tree degrades to appending nothing', () => {
  const throwing = { existsSync: () => { throw new Error('boom'); }, readFileSync: () => { throw new Error('boom'); } };
  assert.equal(inlineReferencedDefinitions(QA_PROMPT, { cli: 'codex', roots: [ROOT], fs: throwing }), '');
});
