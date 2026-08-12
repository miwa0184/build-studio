'use strict';

/**
 * Wrap-up mode for final_review rounds past the owner-approved review cap
 * (designed 2026-07-18 from the finance-studio FS-002 run: rounds 1–4 found
 * real implementation defects, but the reviewer's "spec-forward, fresh angle
 * each round" method is an unbounded lens generator — round 5 swept the
 * renderer line-by-line against the UX spec, round 6 swept the test suite
 * against AC test-mandate language. Every round past the cap found NEW,
 * never-recycled material, so the loop was genuinely progressing yet could
 * never converge on approval: final_review had no stopping criterion of its
 * own beyond the owner cancelling).
 *
 * The mode changes the finding CONTRACT for post-cap rounds only: regressions,
 * incomplete fixes, and critical newly-found defects may still block; fresh-
 * lens discoveries must be filed as follow-up proposals (a structured heading
 * the owner turns into backlog items) instead of blocking. Rounds at or under
 * the cap are untouched — early rounds SHOULD sweep with fresh lenses.
 *
 * Opt-out: config `final_review.wrapup_past_cap: false`.
 */

/**
 * How many rounds a step may sweep with fresh lenses before the contract
 * switches to closure.
 *
 * `final_review` keeps its original trigger — the round cap — because that flow
 * reviews an implementation and its early rounds find real defects.
 *
 * `reviewing` (PRD review) gets its own, much lower threshold. Tying it to the
 * cap made the mode unreachable in practice: with a cap of 5 it could not
 * engage until round 6, so a run generating fresh lenses from round 3 spent
 * three more full six-agent rounds before anything changed. Two sweeps is where
 * the real defects surface; past that the reviewers are exploring, not finding.
 *
 * Config: `review.fresh_lens_rounds` (default 2). Set high to disable.
 */
function freshLensRounds(config, maxRounds, step) {
  if (step === 'reviewing') {
    const n = config && config.review && config.review.fresh_lens_rounds;
    return Number.isFinite(n) ? n : 2;
  }
  return maxRounds;
}

/**
 * Is wrap-up mode active for this round?
 *
 * @param {number} round
 * @param {number} threshold  rounds allowed to sweep freely (see freshLensRounds)
 * @param {object} config
 * @param {string} [step]     which flow — selects the opt-out key
 */
function wrapupActive(round, threshold, config, step) {
  // Opt-outs are per-flow: an owner who wants unbounded PRD review should not
  // have to give up closure on final_review to get it.
  if (step === 'reviewing') {
    if (config && config.review && config.review.wrapup === false) return false;
  } else if (config && config.final_review && config.final_review.wrapup_past_cap === false) {
    return false;
  }
  if (!Number.isFinite(round) || !Number.isFinite(threshold)) return false;
  return round > threshold;
}

/** The instruction block appended to the final_review agent prompt. */
function buildWrapupBlock(round, threshold, step) {
  // The heading has to be TRUE for the flow it lands in. Telling a round-3 PRD
  // reviewer it is "past the owner-approved cap" is false, and a reviewer who
  // catches the prompt lying to it has every reason to discount the rest.
  const header = step === 'reviewing'
    ? `## CLOSURE MODE — THE FRESH-LENS ROUNDS ARE DONE (round ${round}; first ${threshold} rounds sweep freely)`
    : `## WRAP-UP MODE — THIS ROUND IS PAST THE OWNER-APPROVED REVIEW CAP (round ${round}, cap ${threshold})`;
  const preamble = step === 'reviewing'
    ? `The first ${threshold} rounds existed to sweep this document with fresh lenses, and they have run. Your job this round is CLOSURE, not fresh discovery — every previously flagged finding has been through a PM fix round. The bar for BLOCKING changes in this round:`
    : `The owner explicitly chose to continue past the round cap. Your job this round is CLOSURE, not fresh discovery — this change has already been through ${threshold}+ full review rounds and every previously flagged finding has a landed, verified fix. The bar for BLOCKING changes in this round:`;
  return `

${header}

${preamble}

**May still block (Approved: no):**
- A REGRESSION — a fix round broke something that previously worked.
- An INCOMPLETE FIX — a specific previous round's finding whose fix does not actually close it. Cite the round and finding.
- A newly discovered defect causing data loss, security exposure, or corruption that no reasonable owner would knowingly ship.

**Must NOT block — file as follow-up proposals instead:**
- Anything surfaced by sweeping a spec surface, file, or angle no previous round examined. If a finding cites neither a specific previous round's finding nor a specific fix commit, it is follow-up material BY DEFINITION.
- Missing or weak tests for behavior you verified correct by other means.
- Copy, polish, naming, or spec-letter divergences without concrete user-facing harm.

Report the follow-ups under this exact heading so the owner can file them as backlog items:

### Follow-up proposals (file as backlog items)
- [severity] <short title> — <one sentence: what + where (file:line)>

State \`**Mode:** ${step === 'reviewing' ? `closure (round ${round}, fresh-lens rounds ${threshold})` : `wrap-up (round ${round}, cap ${threshold})`}\` directly under the Approved/Blocking lines.

An **Approved: yes** carrying a rich follow-up list is the DESIGNED good outcome of a wrap-up round — it is not a rubber stamp, and nothing in that list is lost by approving: the owner files every proposal as a tracked backlog item.`;
}

module.exports = { wrapupActive, buildWrapupBlock, freshLensRounds };
