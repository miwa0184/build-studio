'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { roleHistory, buildRereviewInstruction } = require('./review-rereview');

const WF = {
  round: 3,
  feedback: [
    { round: 1, step: 'reviewing', role: 'Brand', feedback: 'brand r1 finding' },
    { round: 1, step: 'reviewing', role: 'Architect', feedback: 'architect r1 finding' },
    { round: 1, step: 'reviewing', role: 'QA', feedback: 'qa r1 finding' },
    { round: 1, step: 'pm_fix', role: 'PM', feedback: 'pm fixed everything r1' },
    { round: 2, step: 'reviewing', role: 'Brand', feedback: 'brand r2 finding' },
    { round: 2, step: 'pm_fix', role: 'PM', feedback: 'pm fixed everything r2' },
  ],
};

test('a role sees its OWN findings, not the other reviewers', () => {
  // Feeding every reviewer all six perspectives is both the bulk of the prompt
  // and an anchoring risk — Brand reading Architect's blocker before forming
  // its own view. A targeted re-review asks a narrower question.
  const h = roleHistory(WF, 'Brand');
  assert.match(h, /brand r1 finding/);
  assert.match(h, /brand r2 finding/);
  assert.doesNotMatch(h, /architect r1 finding/);
  assert.doesNotMatch(h, /qa r1 finding/);
});

test('PM fix reports are always included — they are the claim being verified', () => {
  const h = roleHistory(WF, 'Brand');
  assert.match(h, /pm fixed everything r1/);
  assert.match(h, /pm fixed everything r2/);
  assert.match(h, /the claim you are verifying/);
});

test('role matching survives spelling variants', () => {
  const wf = { round: 2, feedback: [{ round: 1, step: 'reviewing', role: 'Code Reviewer', feedback: 'x' }] };
  assert.match(roleHistory(wf, 'code_reviewer'), /round 1/i);
  assert.match(roleHistory(wf, 'code-reviewer'), /round 1/i);
});

test('a role with no prior findings and no fixes gets nothing rather than an empty heading', () => {
  assert.equal(roleHistory({ round: 2, feedback: [] }, 'Brand'), '');
});

test('long feedback is truncated, and says so', () => {
  const wf = { round: 2, feedback: [{ round: 1, step: 'reviewing', role: 'Brand', feedback: 'x'.repeat(5000) }] };
  const h = roleHistory(wf, 'Brand', 100);
  assert.match(h, /… \(truncated\)/);
  assert.ok(h.length < 1000);
});

test('the re-review instruction narrows scope without forbidding blocking', () => {
  const i = buildRereviewInstruction('Brand', 'brand', 'docs/prds/PRD-1.md', 3);
  assert.match(i, /TARGETED RE-REVIEW/);
  // Must still be able to stop a bad fix.
  assert.match(i, /NOT CLOSED/);
  assert.match(i, /REGRESSION/);
  // …while ruling out the fresh sweep that made rounds unbounded.
  assert.match(i, /Do NOT re-read and re-assess sections that no fix\s+touched/);
  assert.match(i, /### Follow-up proposals/);
});

test('it keeps the machine-parsed verdict format the gate requires', () => {
  const i = buildRereviewInstruction('QA', 'qa_review', 'docs/prds/PRD-1.md', 2);
  assert.match(i, /\*\*Approved:\*\* yes \| no/);
  assert.match(i, /\*\*Blocking:\*\* N/);
  assert.match(i, /## Review: QA/);
});

test('an all-closed round is stated as the expected good outcome', () => {
  const i = buildRereviewInstruction('Brand', 'brand', 'p.md', 2);
  assert.match(i, /If every finding of yours is CLOSED/);
  assert.match(i, /not a rubber stamp/);
});
