'use strict';

// F5 — operator-generated diagnostics are not an agent verdict.
//
// Force-complete pasted the agent's tmux scrollback into `agent.feedback` under
// a literal `**Approved:** yes` header, and kill-and-skip wrote the same header
// over a task nobody had done. Every downstream parser reads approval by
// regexing that string, so an operator ending a runaway agent produced positive
// review evidence out of thin air.
//
// The fix is structured provenance, not a smarter regex: whoever produced the
// text is recorded on the agent, and approval is only ever read off an agent's
// own verdict.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  PROVENANCE,
  isAgentVerdict,
  countsAsApproval,
  countsAsAcceptanceEvidence,
  syntheticFeedback,
} = require('./feedback-provenance');

test('an agent that POSTed its own approval is a real verdict', () => {
  const agent = { role: 'iOS Dev', status: 'done', feedback: '**Approved:** yes\n**Blocking:** 0' };
  assert.equal(isAgentVerdict(agent), true);
  assert.equal(countsAsApproval(agent), true);
  assert.equal(countsAsAcceptanceEvidence(agent), true);
});

test('force-completed output is diagnostic evidence, never approval', () => {
  const agent = {
    role: 'iOS Dev',
    status: 'done',
    feedbackProvenance: PROVENANCE.OPERATOR_FORCE_COMPLETE,
    feedback: syntheticFeedback(PROVENANCE.OPERATOR_FORCE_COMPLETE, 'pane scrollback here'),
  };
  assert.equal(isAgentVerdict(agent), false);
  assert.equal(countsAsApproval(agent), false);
  assert.equal(countsAsAcceptanceEvidence(agent), false);
});

test('force-completed feedback preserves the pane output but never writes an approval marker', () => {
  const body = syntheticFeedback(PROVENANCE.OPERATOR_FORCE_COMPLETE, 'BUILD SUCCEEDED\n42 tests passed');
  assert.match(body, /BUILD SUCCEEDED/);
  assert.match(body, /42 tests passed/);
  assert.doesNotMatch(body, /\*\*Approved:\*\*\s*yes/i);
  assert.match(body, /technical_override|force_completed/i);
  assert.match(body, /untrusted/i);
});

test('kill-and-skip feedback is skipped/aborted and never an approval', () => {
  const body = syntheticFeedback(PROVENANCE.OPERATOR_KILL_SKIP, '');
  assert.doesNotMatch(body, /\*\*Approved:\*\*\s*yes/i);
  assert.match(body, /skipped|aborted/i);

  const agent = { role: 'iOS Dev', status: 'done', feedbackProvenance: PROVENANCE.OPERATOR_KILL_SKIP, feedback: body };
  assert.equal(countsAsApproval(agent), false);
  assert.equal(countsAsAcceptanceEvidence(agent), false);
});

test('provenance is read from the structured field, not from the text', () => {
  // A pane that happens to echo an approval marker (the prompt contained one,
  // or a prior round's feedback scrolled by) must not become an approval.
  const agent = {
    role: 'iOS Dev',
    status: 'done',
    feedbackProvenance: PROVENANCE.OPERATOR_FORCE_COMPLETE,
    feedback: 'pane echo: **Approved:** yes\n**Blocking:** 0',
  };
  assert.equal(countsAsApproval(agent), false);
});

test('an agent with no provenance recorded is treated as its own verdict (pre-A1a runs)', () => {
  const agent = { role: 'QA', status: 'done', feedback: '**Approved:** yes' };
  assert.equal(isAgentVerdict(agent), true);
});
