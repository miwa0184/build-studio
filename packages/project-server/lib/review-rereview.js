'use strict';

/**
 * Targeted re-review for PRD review rounds after the first.
 *
 * Round 1 should sweep the whole document — that is where the real defects are.
 * Rounds 2+ were doing the same thing again: the instruction was byte-identical
 * every round ("Read the PRD file, then analyze it"), with no diff and no
 * changed-section scoping. The only round-awareness was a rule saying *"after
 * round 2, only raise genuinely new issues"*.
 *
 * That combination is a finding generator, not a review. A round-3 reviewer
 * opens the full PRD, is told the only acceptable output is NEW material, and
 * carries a fresh lens (its role skill) to apply. Observed on a real run: a
 * reviewer reported "round-2 blocker is resolved" and then raised three new
 * findings from a surface no earlier round had touched. It did exactly what it
 * was asked to do.
 *
 * `code_review` already solved this for implementation review — rounds > 1 get
 * "verify each fix actually resolves the issue it claims to fix … do not
 * re-audit code that was already approved in round 1". PRD review never got the
 * same treatment; the asymmetry looks accidental rather than designed.
 *
 * Complements `review-wrapup.js` rather than replacing it. This narrows what a
 * re-review LOOKS at (the cause); wrap-up/closure changes what happens to
 * findings that still surface (the symptom). A run wants both: verification
 * first, and a contract for the residue.
 */

/**
 * The feedback a re-reviewing role actually needs: its OWN prior findings, plus
 * every PM fix report.
 *
 * The default history hands each reviewer all six roles' feedback from the last
 * three rounds. That is the bulk of the prompt, and it invites anchoring — Brand
 * reads Architect's blocking finding before forming its own view. For a targeted
 * re-review the question is narrower: *did the fixes close MY findings?*
 *
 * PM fix reports are always included regardless of role, because they are the
 * claim being verified.
 *
 * @param {object} wf
 * @param {string} role
 * @param {number} [maxChars] per-entry truncation
 * @returns {string} markdown block, or '' when there is nothing to show
 */
function roleHistory(wf, role, maxChars = 1200) {
  const all = (wf && wf.feedback) || [];
  const norm = (s) => String(s || '').toLowerCase().replace(/[\s_-]+/g, '');
  const wanted = norm(role);
  const mine = all.filter((f) => norm(f.role) === wanted);
  const fixes = all.filter((f) => f.step === 'pm_fix');
  if (mine.length === 0 && fixes.length === 0) return '';

  const clip = (t) => {
    const s = String(t || '');
    return s.length > maxChars ? `${s.slice(0, maxChars)}… (truncated)` : s;
  };

  let out = `\n\n## YOUR PRIOR FINDINGS AND THE FIXES CLAIMED FOR THEM\n\n`
    + `Only your own findings are listed. Other reviewers' findings are theirs to verify — `
    + `re-litigating them is how a re-review turns back into a fresh sweep.\n`;

  for (const f of mine) {
    out += `\n### Round ${f.round} — your review\n${clip(f.feedback)}\n`;
  }
  for (const f of fixes) {
    out += `\n### Round ${f.round} — PM fix report (the claim you are verifying)\n${clip(f.feedback)}\n`;
  }
  return out;
}

/**
 * The targeted re-review contract, replacing the full-sweep instruction body.
 *
 * Deliberately does NOT forbid blocking: an unfixed finding or a regression
 * introduced by a fix must still stop the run. What it forbids is treating the
 * document as unread.
 */
function buildRereviewInstruction(role, skill, prdPath, round) {
  return `You are a ${role} reviewer doing a TARGETED RE-REVIEW. Use your /${skill} skill.

PRD path: ${prdPath}

This is round ${round}. Round 1 swept the whole document; that has happened. Your job now is to
verify that the fixes claimed since your last review actually close the findings YOU raised —
not to audit the document again from a new angle.

## WHAT TO DO

1. Read each of your prior findings below and locate the corresponding change in the PRD.
2. For each one, decide: **CLOSED** (the fix resolves it), **NOT CLOSED** (the fix misses or
   only partly addresses it — say precisely what remains), or **REGRESSED** (the fix broke
   something that previously read correctly).
3. Read the sections the fixes touched. Do NOT re-read and re-assess sections that no fix
   touched and that you did not previously flag — those were reviewed in round 1 and are
   settled.

## WHAT BLOCKS

- A finding of yours that is **NOT CLOSED** — cite which round it came from.
- A **REGRESSION** introduced by a fix.
- A defect in the changed text that would cause real harm to ship.

## WHAT DOES NOT BLOCK

- Anything you notice by examining a surface no earlier round examined and no fix touched.
  If it is genuinely worth recording, put it under \`### Follow-up proposals\` — it is not a
  reason to withhold approval at this stage.
- Wording, polish or completeness preferences that you did not raise in round 1.

**If every finding of yours is CLOSED, say so and set \`Approved: yes\` with \`Blocking: 0\`.**
That is the expected outcome of a working fix round, not a rubber stamp.

## REVIEW FORMAT — MANDATORY

## Review: ${role}

**Approved:** yes | no
**Blocking:** N  |  **Medium:** N  |  **Low:** N

### Verification of prior findings
- [round N] <your finding, one line> — CLOSED | NOT CLOSED | REGRESSED — <evidence>

### Findings
[Only NOT CLOSED / REGRESSED items, and defects in changed text. If none, say so.]

### Action Items
- [ ] [assignee_role] — description`;
}

module.exports = { roleHistory, buildRereviewInstruction };
