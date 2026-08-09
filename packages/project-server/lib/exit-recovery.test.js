'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hasRecoverableWork, buildWorkSummary, isPlanningRole } = require('./exit-recovery');

// Modelled on the real case: a codex QA agent that wrote and committed eight
// test files, then exited without reporting.
const FACTS = {
  role: 'QA',
  cli: 'codex',
  step: 'qa_tests',
  base: 'main',
  commits: [{ sha: 'ef67cb3', subject: 'test: add PRD-053 sequential locale coverage' }],
  filesChanged: 8,
  insertions: 557,
  deletions: 1,
  dirty: [],
};

test('commits are what make an exited agent recoverable', () => {
  assert.equal(hasRecoverableWork(FACTS), true);
  assert.equal(hasRecoverableWork({ commits: [] }), false);
  assert.equal(hasRecoverableWork({}), false);
  assert.equal(hasRecoverableWork(null), false);
});

test('a planner is never git-recoverable, however many commits sit on the branch', () => {
  // The dead end this guard exists for: the branch is full of commits, none of
  // them the planner's, and a summary of them can never satisfy the fix_plan
  // approval gate — leaving the step done with no way forward.
  assert.equal(hasRecoverableWork(FACTS, 'Fix Planner'), false);
  assert.equal(hasRecoverableWork(FACTS, 'Planner'), false);
  // Everyone else is judged on the commits alone, exactly as before.
  assert.equal(hasRecoverableWork(FACTS, 'iOS Dev'), true);
  assert.equal(hasRecoverableWork(FACTS, 'Code Reviewer'), true);
  // Omitting the role keeps the original two-argument-free behaviour.
  assert.equal(hasRecoverableWork(FACTS), true);
});

test('planning roles are matched however the role is spelled', () => {
  // Must agree with the workflow API's normalizeRole, or a role that routes
  // feedback fine would slip past this guard.
  for (const r of ['Fix Planner', 'fix_planner', 'fix-planner', 'FIXPLANNER', ' Planner ']) {
    assert.equal(isPlanningRole(r), true, r);
  }
  for (const r of ['iOS Dev', 'QA', 'Planner Reviewer', '', null, undefined]) {
    assert.equal(isPlanningRole(r), false, String(r));
  }
});

test('the summary is labelled as reconstructed, not as the agent speaking', () => {
  // The whole hazard of this feature: a report filed under an agent's name that
  // reads like the agent's own conclusions. Anyone finding it later must be
  // able to tell at a glance that it is not a sign-off.
  const s = buildWorkSummary(FACTS);
  assert.match(s, /RECONSTRUCTED, not agent-authored/);
  assert.match(s, /reconstructed from the commits by Build Studio/);
  assert.match(s, /not a verdict the agent reached/);
});

test('it states what it does NOT claim', () => {
  const s = buildWorkSummary(FACTS);
  assert.match(s, /### Not asserted here/);
  assert.match(s, /No claim is made about correctness, completeness/);
  assert.match(s, /lost when the process exited during `qa_tests`/);
});

test('it reports the evidence: commits and churn', () => {
  const s = buildWorkSummary(FACTS);
  assert.match(s, /ef67cb3/);
  assert.match(s, /sequential locale coverage/);
  assert.match(s, /8 files changed, \+557, -1/);
  assert.match(s, /\*\*Working tree:\*\* clean/);
});

test('uncommitted leftovers are raised as a caveat, not buried', () => {
  // A dirty tree means the agent stopped part-way, and the commits alone do not
  // describe what it was doing — treating the step as done would be wrong.
  const s = buildWorkSummary({ ...FACTS, dirty: ['src/a.ts', 'src/b.ts'] });
  assert.match(s, /⚠ Uncommitted changes were left behind \(2\)/);
  assert.match(s, /src\/a\.ts/);
  assert.match(s, /may have stopped mid-task/);
  assert.doesNotMatch(s, /\*\*Working tree:\*\* clean/);
});

test('a long dirty list is truncated with an honest count', () => {
  const dirty = Array.from({ length: 25 }, (_, i) => `src/f${i}.ts`);
  const s = buildWorkSummary({ ...FACTS, dirty });
  assert.match(s, /left behind \(25\)/);
  assert.match(s, /…and 5 more/);
});

test('it names the CLI when known, and stays readable when not', () => {
  assert.match(buildWorkSummary(FACTS), /codex writes no resumable session or transcript/);
  const noCli = buildWorkSummary({ ...FACTS, cli: undefined });
  assert.doesNotMatch(noCli, /undefined/);
  assert.match(noCli, /its own account of the work could not be retrieved/);
});

test('multiple commits are all listed', () => {
  const s = buildWorkSummary({
    ...FACTS,
    commits: [
      { sha: 'aaa1111', subject: 'test: first' },
      { sha: 'bbb2222', subject: 'test: second' },
    ],
  });
  assert.match(s, /since `main`:\*\* 2/);
  assert.match(s, /aaa1111/);
  assert.match(s, /bbb2222/);
});

test('missing churn numbers are omitted rather than printed as undefined', () => {
  const s = buildWorkSummary({ ...FACTS, filesChanged: undefined, insertions: undefined, deletions: undefined });
  assert.doesNotMatch(s, /undefined|NaN/);
  assert.doesNotMatch(s, /\*\*Churn:\*\*/);
});
