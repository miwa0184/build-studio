'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { wrapupActive, buildWrapupBlock, freshLensRounds } = require('./review-wrapup');

test('inactive at or under the cap — early rounds keep the fresh-lens contract', () => {
  assert.equal(wrapupActive(1, 4, {}), false);
  assert.equal(wrapupActive(4, 4, {}), false);
});

test('active on every round past the cap', () => {
  assert.equal(wrapupActive(5, 4, {}), true);
  assert.equal(wrapupActive(7, 4, {}), true);
  assert.equal(wrapupActive(3, 2, {}), true);
});

test('config opt-out disables it; absent/partial config does not', () => {
  assert.equal(wrapupActive(7, 4, { final_review: { wrapup_past_cap: false } }), false);
  assert.equal(wrapupActive(7, 4, { final_review: {} }), true);
  assert.equal(wrapupActive(7, 4, undefined), true);
  assert.equal(wrapupActive(7, 4, { final_review: { effort: 'high' } }), true);
});

test('garbage rounds never activate', () => {
  assert.equal(wrapupActive(undefined, 4, {}), false);
  assert.equal(wrapupActive(NaN, 4, {}), false);
  assert.equal(wrapupActive(5, undefined, {}), false);
});

test('block carries the contract: what blocks, what files as follow-ups, the mode line', () => {
  const block = buildWrapupBlock(7, 4);
  assert.match(block, /WRAP-UP MODE/);
  assert.match(block, /round 7, cap 4/);
  assert.match(block, /REGRESSION/);
  assert.match(block, /INCOMPLETE FIX/);
  assert.match(block, /Must NOT block/);
  assert.match(block, /follow-up material BY DEFINITION/);
  assert.match(block, /### Follow-up proposals \(file as backlog items\)/);
  assert.match(block, /\*\*Mode:\*\* wrap-up \(round 7, cap 4\)/);
  assert.match(block, /not a rubber stamp/);
});

// ── Closure mode for the PRD `reviewing` step (2026-08-12) ──────────────────
// The mode existed only for final_review and only past the round cap, which
// made it unreachable in practice: with a cap of 5 it could not engage until
// round 6, so a review generating fresh lenses from round 3 burned three more
// six-agent rounds first.

test('reviewing gets its own low threshold; final_review keeps the cap', () => {
  assert.equal(freshLensRounds({}, 5, 'reviewing'), 2);
  assert.equal(freshLensRounds({}, 5, 'final_review'), 5);
});

test('the reviewing threshold is configurable', () => {
  assert.equal(freshLensRounds({ review: { fresh_lens_rounds: 3 } }, 5, 'reviewing'), 3);
  // Set it high to disable closure mode entirely.
  assert.equal(freshLensRounds({ review: { fresh_lens_rounds: 99 } }, 5, 'reviewing'), 99);
});

test('closure engages on round 3 by default, not round 6', () => {
  assert.equal(wrapupActive(2, 2, {}, 'reviewing'), false);
  assert.equal(wrapupActive(3, 2, {}, 'reviewing'), true);
});

test('opt-outs are per-flow — disabling one must not disable the other', () => {
  assert.equal(wrapupActive(3, 2, { review: { wrapup: false } }, 'reviewing'), false);
  assert.equal(wrapupActive(6, 5, { review: { wrapup: false } }, 'final_review'), true);
  assert.equal(wrapupActive(6, 5, { final_review: { wrapup_past_cap: false } }, 'final_review'), false);
  assert.equal(wrapupActive(3, 2, { final_review: { wrapup_past_cap: false } }, 'reviewing'), true);
});

test('the block never tells a reviewer something untrue about its round', () => {
  // A round-3 PRD reviewer is NOT "past the owner-approved cap"; a reviewer
  // that catches the prompt lying has reason to discount the rest of it.
  const rv = buildWrapupBlock(3, 2, 'reviewing');
  assert.match(rv, /CLOSURE MODE/);
  assert.doesNotMatch(rv, /past the owner-approved/i);
  assert.match(rv, /first 2 rounds sweep freely/);

  const fr = buildWrapupBlock(6, 5, 'final_review');
  assert.match(fr, /PAST THE OWNER-APPROVED REVIEW CAP/);
});

test('both variants keep the escape hatch and the follow-up heading', () => {
  for (const b of [buildWrapupBlock(3, 2, 'reviewing'), buildWrapupBlock(6, 5, 'final_review')]) {
    assert.match(b, /REGRESSION/);
    assert.match(b, /INCOMPLETE FIX/);
    assert.match(b, /data loss, security exposure, or corruption/);
    assert.match(b, /### Follow-up proposals \(file as backlog items\)/);
  }
});
