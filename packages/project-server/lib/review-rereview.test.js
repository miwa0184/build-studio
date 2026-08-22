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

// ─── The delta has to be handed over, not just implied (fazon, 2026-08-22) ───
//
// The instruction already said "do not re-read untouched sections". Measured on
// a real review, 5 of 6 round-2 reviewers read the full 394-line PRD anyway and
// round 2 cost MORE than round 1 (+27% cache reads, +20% turns) — because
// nothing told them HOW to see what changed.

test('a known base sha becomes a runnable diff command', () => {
  const t = buildRereviewInstruction('Brand', 'brand', 'docs/prds/PRD-125.md', 2, 'abc1234');
  assert.match(t, /git diff abc1234 -- docs\/prds\/PRD-125\.md/);
  assert.match(t, /START HERE — THE DELTA, NOT THE DOCUMENT/);
});

test('without a base sha it still says how to find the delta', () => {
  // Runs launched before the sha was recorded must not lose the guidance.
  const t = buildRereviewInstruction('QA', 'qa_review', 'docs/prds/PRD-9.md', 3, null);
  assert.match(t, /START HERE — THE DELTA/);
  assert.match(t, /git log --oneline -3 -- docs\/prds\/PRD-9\.md/);
});

test('the rest of the contract survives the new section', () => {
  // The diff block is inserted mid-template; a broken literal would truncate it.
  const t = buildRereviewInstruction('UX', 'ux', 'docs/prds/PRD-1.md', 2, 'deadbee');
  for (const marker of ['## WHAT BLOCKS', '## WHAT DOES NOT BLOCK', '### Verification of prior findings', '### Action Items', 'REGRESSED']) {
    assert.ok(t.includes(marker), `missing: ${marker}`);
  }
});

test('reading the whole document is named as the thing to avoid', () => {
  const t = buildRereviewInstruction('Architect', 'architect', 'p.md', 2, 'sha');
  assert.match(t, /Re-reading the whole\s+document is exactly what this round exists to avoid/);
});
