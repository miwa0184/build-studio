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
  parseStructuredVerdict,
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

// ---------------------------------------------------------------------------
// A1c receipt repair (H1) — one strict, structured verdict reading.
//
// The receipt used to read a verdict with free substring matches: "Not
// approved" matched /approve/, and a quoted format line "Approved: yes | no"
// could win over the marker the reviewer actually wrote. The structured reader
// below is line-anchored, ignores quoted/fenced/inline-code text, lets an
// explicit refusal win, and treats template-shaped, multiple or conflicting
// markers as ambiguous — never as approval.
// ---------------------------------------------------------------------------

test('structured verdict: a bare, anchored Approved marker with counts parses', () => {
  const v = parseStructuredVerdict('## Review: Code Reviewer\n\n**Approved:** yes\n**Blocking:** 0  |  **Medium:** 1  |  **Low:** 2\n\n### Summary\nClean.');
  assert.equal(v.approved, true);
  assert.equal(v.reason, 'approved');
  assert.deepEqual([v.blocking, v.medium, v.low], [0, 1, 2]);
  const no = parseStructuredVerdict('**Approved:** no\n**Blocking:** 1');
  assert.equal(no.approved, false);
  assert.equal(no.reason, 'refused');
  assert.equal(no.blocking, 1);
  assert.equal(parseStructuredVerdict('**Approved:** YES.\n**Blocking:** 0').approved, true, 'case and a closing period are tolerated');
});

test('structured verdict (F1): "Not approved" and every refusing Verdict vocabulary is a refusal, never approval', () => {
  for (const line of [
    '**Verdict:** Not approved — changes requested',
    '**Verdict:** not approved',
    '**Verdict:** unapproved',
    '**Verdict:** rejected',
    '**Verdict:** changes requested',
    '**Verdict:** blocked',
    '**Verdict:** approved, but changes requested before merge',
  ]) {
    const v = parseStructuredVerdict(`${line}\n**Blocking:** 0`);
    assert.equal(v.approved, false, `${line} must be a refusal`);
    assert.equal(v.reason, 'refused');
  }
  assert.equal(parseStructuredVerdict('**Verdict:** Approved\n**Blocking:** 0').approved, true);
  assert.equal(parseStructuredVerdict('**Verdict:** APPROVE').approved, true);
  const prose = parseStructuredVerdict('**Verdict:** I approve of the direction, nice work');
  assert.equal(prose.approved, null, 'free prose around the vocabulary is not a verdict');
  assert.equal(prose.reason, 'unrecognized');
});

test('structured verdict (F2): a template line "Approved: yes | no" never approves, and an explicit no beside it wins', () => {
  const template = parseStructuredVerdict('**Approved:** yes | no\n**Blocking:** N');
  assert.equal(template.approved, null);
  assert.equal(template.reason, 'template');
  for (const value of ['yes/no', 'yes or no', 'yes |', '[yes]', 'yes — pending', 'yes (see below)']) {
    const v = parseStructuredVerdict(`**Approved:** ${value}\n**Blocking:** 0`);
    assert.notEqual(v.approved, true, `"${value}" must not approve`);
  }
  const quotedThenReal = parseStructuredVerdict([
    'Format reminder:', '**Approved:** yes | no', '**Blocking:** N', '',
    '**Approved:** no', '**Blocking:** 1',
  ].join('\n'));
  assert.equal(quotedThenReal.approved, false);
  assert.equal(quotedThenReal.blocking, 1);
});

test('structured verdict: markers inside fenced blocks, blockquotes, inline code or list bullets are not markers', () => {
  assert.equal(parseStructuredVerdict('```\n**Approved:** yes\n**Blocking:** 0\n```').reason, 'no_marker');
  assert.equal(parseStructuredVerdict('> **Approved:** yes\n> **Blocking:** 0').reason, 'no_marker');
  assert.equal(parseStructuredVerdict('- `**Approved:** yes` is the format\n**Blocking:** 0').reason, 'no_marker');
  assert.equal(parseStructuredVerdict('- **Approved:** yes|no / **Blocking:** N (review format)').reason, 'no_marker');
  assert.equal(parseStructuredVerdict('Example:\n\n    **Approved:** yes\n    **Blocking:** 0').reason, 'no_marker');
  assert.equal(parseStructuredVerdict('Example:\n\n\t**Approved:** yes\n\t**Blocking:** 0').reason, 'no_marker');
  for (const indent of [' \t', '  \t', '   \t']) {
    assert.equal(parseStructuredVerdict(`Example:\n\n${indent}**Approved:** yes\n${indent}**Blocking:** 0`).reason, 'no_marker');
  }
  assert.equal(parseStructuredVerdict('```\n    ```\n**Approved:** yes\n**Blocking:** 0\n```').reason, 'no_marker');
  assert.equal(parseStructuredVerdict('Looks fine to me.').approved, null);
  // An operator's synthetic body carries a fenced pane echo; it must not parse
  // as a verdict even before provenance is consulted.
  const synthetic = syntheticFeedback(PROVENANCE.OPERATOR_FORCE_COMPLETE, '**Approved:** yes\n**Blocking:** 0');
  assert.equal(parseStructuredVerdict(synthetic).approved, null);
  // But a real marker after a quoted example is still found.
  const real = parseStructuredVerdict('> **Approved:** yes\n\n**Approved:** yes\n**Blocking:** 0');
  assert.equal(real.approved, true);
});

test('structured verdict: only a matching CommonMark fence can close a fenced example', () => {
  const mismatchedCharacter = [
    '```',
    '~~~',
    '**Approved:** yes',
    '**Blocking:** 0',
    '```',
  ].join('\n');
  assert.equal(parseStructuredVerdict(mismatchedCharacter).reason, 'no_marker');

  const tooShort = [
    '````',
    '```',
    '**Approved:** yes',
    '**Blocking:** 0',
    '````',
  ].join('\n');
  assert.equal(parseStructuredVerdict(tooShort).reason, 'no_marker');

  const matchingLongerClose = [
    '````',
    '`````',
    '**Approved:** yes',
    '**Blocking:** 0',
  ].join('\n');
  assert.equal(parseStructuredVerdict(matchingLongerClose).approved, true);
});

test('structured verdict (F3): multiple or conflicting authoritative markers are ambiguous or refused, never approved', () => {
  const yesNo = parseStructuredVerdict('**Approved:** yes\n**Blocking:** 0\n**Approved:** no\n**Blocking:** 1');
  assert.equal(yesNo.approved, false);
  assert.equal(yesNo.reason, 'refused');
  const noYes = parseStructuredVerdict('**Approved:** no\n**Approved:** yes');
  assert.equal(noYes.approved, false);
  const yesYes = parseStructuredVerdict('**Approved:** yes\n**Blocking:** 0\n**Approved:** yes');
  assert.equal(yesYes.approved, null);
  assert.equal(yesYes.reason, 'multiple');
  const twoKinds = parseStructuredVerdict('**Approved:** yes\n**Verdict:** approved\n**Blocking:** 0');
  assert.equal(twoKinds.approved, null);
  assert.equal(twoKinds.reason, 'multiple');
  const verdictConflict = parseStructuredVerdict('**Approved:** yes\n**Verdict:** changes requested');
  assert.equal(verdictConflict.approved, false);
  const counts = parseStructuredVerdict('**Approved:** yes\n**Blocking:** 0\n**Blocking:** 2');
  assert.equal(counts.approved, null);
  assert.equal(counts.reason, 'counts_conflict');
  const sameCounts = parseStructuredVerdict('**Approved:** yes\n**Blocking:** 0\n\nSummary: **Blocking:** 0 as stated.');
  assert.equal(sameCounts.approved, true, 'a repeated identical count is not a conflict');
});

test('structured verdict (F4): a count marker must contain only one exact integer', () => {
  for (const value of [
    '0 or 1',
    '0/1',
    '0 (template)',
    '0 | maybe 2',
    '0 pending confirmation',
  ]) {
    const verdict = parseStructuredVerdict(`**Approved:** yes\n**Blocking:** ${value}`);
    assert.equal(verdict.approved, null, `ambiguous Blocking value ${JSON.stringify(value)} must not approve`);
    assert.equal(verdict.reason, 'counts_malformed');
    assert.equal(verdict.blocking, null);
  }
});

test('structured verdict: failure counts are read for QA triage but never decide approval', () => {
  const v = parseStructuredVerdict('**Tests passed:** 54/56\n**Approved:** yes\n**Blocking:** 0\nExecuted 56 tests, with 2 failures (0 unexpected)');
  assert.equal(v.approved, true);
  assert.equal(v.failing, 2);
  assert.equal(parseStructuredVerdict('**Approved:** yes\n**Blocking:** 0\n**Failures:** 3').failing, 3);
  assert.equal(parseStructuredVerdict('**Approved:** yes\n**Blocking:** 0').failing, 0);
});
