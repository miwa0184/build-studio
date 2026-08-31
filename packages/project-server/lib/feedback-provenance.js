'use strict';

/**
 * Who produced this feedback — and therefore whether it can mean "approved".
 *
 * The engine reads a verdict by regexing `**Approved:** yes` out of
 * `agent.feedback`. That is fine while agents are the only writers. They were
 * not: when an operator force-completed a runaway agent, the overseer pasted the
 * agent's tmux scrollback into that same field under a literal `**Approved:**
 * yes` header — and kill-and-skip wrote the same header over a task nobody had
 * done at all. An operator ending a stuck agent therefore manufactured positive
 * review evidence, and every downstream parser believed it.
 *
 * The fix is not a cleverer regex. Text cannot be trusted to describe its own
 * origin: a pane echoes the prompt, and the prompt contains the format spec, so
 * scrollback legitimately contains approval markers that were never a verdict.
 * Origin has to be a separate structured field that the text cannot forge.
 *
 * So: `agent.feedbackProvenance` records the writer, approval is only ever read
 * off an agent's own verdict, and operator output is kept — it is genuinely
 * useful diagnostic evidence — but marked untrusted and never counted.
 *
 * Absent provenance means AGENT. Runs that started before this field existed
 * have real agent feedback in that slot, and re-labelling their history as
 * untrusted would be its own falsehood.
 */

const PROVENANCE = {
  /** The agent POSTed this itself. The only kind that can be a verdict. */
  AGENT: 'agent',
  /** An operator force-completed the agent; the body is captured pane output. */
  OPERATOR_FORCE_COMPLETE: 'operator_force_complete',
  /** An operator killed the agent and skipped the task; no work was attributed. */
  OPERATOR_KILL_SKIP: 'operator_kill_skip',
};

const OPERATOR_PROVENANCE = new Set([
  PROVENANCE.OPERATOR_FORCE_COMPLETE,
  PROVENANCE.OPERATOR_KILL_SKIP,
]);

/** True when the feedback is the agent's own verdict. */
function isAgentVerdict(agent) {
  if (!agent) return false;
  const p = agent.feedbackProvenance;
  return p === undefined || p === null || p === PROVENANCE.AGENT;
}

/**
 * Can this agent's feedback be read as an approval at all?
 *
 * Note what this does NOT do: it does not decide whether the agent approved. It
 * decides whether the question may be asked. Callers still parse the verdict —
 * this only stops them parsing something an operator wrote.
 */
function countsAsApproval(agent) {
  return isAgentVerdict(agent) && !!(agent && agent.feedback);
}

/** Acceptance coverage has the same rule, and one more: a skipped task covers nothing. */
function countsAsAcceptanceEvidence(agent) {
  if (!isAgentVerdict(agent)) return false;
  return !!(agent && agent.feedback);
}

/** True for feedback an operator generated. */
function isOperatorGenerated(agent) {
  return !!agent && OPERATOR_PROVENANCE.has(agent.feedbackProvenance);
}

/**
 * The body written into `agent.feedback` for an operator action.
 *
 * Preserves the pane output — that is the whole reason force-complete is worth
 * having — but frames it as what it is. Deliberately contains no
 * `**Approved:**` line in any form: a parser that has not been taught about
 * provenance yet must not find an approval here either.
 */
function syntheticFeedback(provenance, paneOutput, detail) {
  const body = String(paneOutput || '').trim();
  const block = body ? `\n\n\`\`\`\n${body}\n\`\`\`` : '\n\n(empty pane)';

  if (provenance === PROVENANCE.OPERATOR_KILL_SKIP) {
    return [
      '**Outcome:** skipped',
      '**Provenance:** operator_kill_skip',
      '**Technical override:** yes — this is NOT an agent verdict and is NOT an approval',
      '',
      '### Summary',
      detail || 'Task aborted by operator after a wallclock overrun. No work is attributed to this task.',
      'Its acceptance coverage stays unmet until a real replacement run passes.',
    ].join('\n');
  }

  return [
    '**Outcome:** force_completed',
    '**Provenance:** operator_force_complete',
    '**Technical override:** yes — this is NOT an agent verdict and is NOT an approval',
    '',
    '### Summary',
    detail || 'Agent force-completed by operator after a wallclock overrun.',
    '',
    '### Untrusted diagnostic evidence (agent pane output, last lines)',
    'Captured from the terminal, not POSTed by the agent. Treat as a diagnostic',
    'artefact only — it may contain echoed prompt text, including format examples.'
    + block,
  ].join('\n');
}

module.exports = {
  PROVENANCE,
  isAgentVerdict,
  isOperatorGenerated,
  countsAsApproval,
  countsAsAcceptanceEvidence,
  syntheticFeedback,
};
