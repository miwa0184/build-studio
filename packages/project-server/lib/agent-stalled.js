'use strict';

/**
 * "This agent is alive and will never make progress."
 *
 * `agent-recovery.js` answers a different question — is the PROCESS alive? — and
 * answers it correctly. Its core assumption is even documented there: *a live
 * Claude repaints its UI constantly, so a live agent's log never goes silent*.
 * That is true, and it is exactly why a permanently blocked agent is invisible:
 * it is alive, it is repainting, and the idle-stall timer never fires.
 *
 * Liveness and progress are different axes. Three real failures in one day, all
 * of which left the process healthy and nothing surfaced any of them:
 *
 *  - **Auth expiry mid-run.** Three reviewers hit `Login expired · Please run
 *    /login` and sat at the prompt for 39 minutes while the three that had
 *    already reported looked fine.
 *  - **Finished but never reported.** An agent wrote a complete review, then
 *    stopped without running its feedback POST. `workflow/feedback` appeared in
 *    its log exactly once — in the prompt, never executed. Twice in five days.
 *  - **Waiting at a prompt** with nothing recoverable behind it.
 *
 * The discriminator is what the pane ENDS with. A working agent shows a spinner
 * and an interrupt hint; a blocked one shows a bare prompt:
 *
 *     ✻ Whirlpooling… (1m 6s · ↓ 4.0k tokens)     <- working
 *     ⏵⏵ bypass permissions … · esc to interrupt
 *
 *     ❯                                            <- waiting, forever
 *     ⏵⏵ bypass permissions (shift+tab to cycle)
 *
 * Everything here is advisory. A false positive costs a glance; a false halt
 * costs a run — the same call the owner already made for human gates.
 */

/**
 * Auth and quota failures, which the agent cannot resolve and which typically
 * hit every running agent at once. Matched against pane text, so the strings
 * are what the CLI actually prints.
 */
const AUTH_PATTERNS = [
  { re: /Login expired/i, why: 'the CLI login expired', fix: 'Run `/login` in a terminal, then relaunch the step.' },
  { re: /Please run \/login/i, why: 'the CLI is asking for login', fix: 'Run `/login` in a terminal, then relaunch the step.' },
  { re: /Invalid API key/i, why: 'the API key was rejected', fix: 'Fix the credential, then relaunch the step.' },
  { re: /credit balance is too low/i, why: 'the account is out of credit', fix: 'Top up the account, then relaunch the step.' },
  { re: /(usage|rate) limit (reached|exceeded)/i, why: 'a usage limit was reached', fix: 'Wait for the limit to reset, then relaunch the step.' },
  { re: /session limit .*(reached|exceeded)/i, why: 'the session limit was reached', fix: 'Wait for the session limit to reset, then relaunch the step.' },
];

/** The CLI only prints this while it is actually working on something. */
const WORKING_MARKERS = [
  /esc to interrupt/i,
  /\besc\b to cancel/i,
];

/**
 * Is the pane sitting at an input prompt rather than working?
 *
 * Deliberately positive-evidence-based: we look for the WORKING marker and
 * treat its absence as waiting, rather than trying to enumerate every shape a
 * prompt can take. A pane we cannot read at all is not evidence of anything.
 */
function isAwaitingInput(paneText) {
  const t = String(paneText || '');
  if (!t.trim()) return false;
  return !WORKING_MARKERS.some((re) => re.test(t));
}

/**
 * Classify a RUNNING agent that the process check already called alive.
 *
 * @param {object} p
 * @param {string} p.paneText        recent pane capture
 * @param {number} p.idleMs          ms since the agent's log last changed
 * @param {boolean} p.hasFeedback    has it reported?
 * @param {boolean} [p.hasRecoverableReport]  does a transcript/commit report exist?
 * @param {number} [p.waitConfirmMs] how long a bare prompt must persist
 * @returns {{reason,title,detail,action}|null}
 */
function classifyStalledAgent({
  paneText, idleMs, hasFeedback, hasRecoverableReport = false, waitConfirmMs = 2 * 60 * 1000,
}) {
  if (hasFeedback) return null;               // it reported; nothing to see
  const text = String(paneText || '');
  if (!text.trim()) return null;              // unreadable pane proves nothing

  // 1. Auth/quota — highest confidence, and independent of timing: the message
  //    is terminal, so there is no point waiting out a confirmation window.
  for (const { re, why, fix } of AUTH_PATTERNS) {
    if (re.test(text)) {
      return {
        reason: 'auth_blocked',
        title: 'An agent is blocked on credentials',
        detail: `The CLI reported that ${why}. The agent is still running but cannot proceed, and every other agent in this step is likely blocked the same way.`,
        action: fix,
      };
    }
  }

  // Below here the signal is "sitting at a prompt", which needs to persist —
  // a pause between tool calls is not a stall.
  if (!isAwaitingInput(text)) return null;
  if (!Number.isFinite(idleMs) || idleMs < waitConfirmMs) return null;

  // 2. Finished but never reported. The strong clause is the recoverable
  //    report: the agent's own words already exist, it simply never sent them.
  if (hasRecoverableReport) {
    return {
      reason: 'finished_not_reported',
      title: 'An agent finished but never reported',
      detail: 'The agent produced a complete report and stopped without posting it, so the step will wait indefinitely. Its own output is still recoverable.',
      action: 'Use Recover on that agent to deliver its report, or relaunch the step.',
    };
  }

  // 3. Waiting, with nothing behind it. Weakest signal — say so rather than
  //    implying a diagnosis, and offer no automatic action.
  return {
    reason: 'agent_waiting',
    title: 'An agent is waiting and will not proceed',
    detail: 'The agent is alive but sitting at an input prompt with nothing to recover — it may be at a dialog, or have stopped without producing output.',
    action: 'Check the agent log, answer it in the live terminal, or relaunch the step.',
  };
}

module.exports = { classifyStalledAgent, isAwaitingInput, AUTH_PATTERNS };
