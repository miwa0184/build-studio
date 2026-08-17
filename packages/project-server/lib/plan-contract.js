'use strict';

/**
 * Machine-parsed output contracts, checked while the agent is still ALIVE.
 *
 * A fix planner's feedback has to carry a JSON `tasks` array — the engine
 * launches one dev agent per entry, so prose is not a degraded version of the
 * contract, it is nothing at all. That requirement is stated in bold in the
 * planner's own instructions ("Plain text or prose-only feedback will be
 * rejected"), but until this module the rejection happened at APPROVE time,
 * which is the wrong moment by hours:
 *
 *   agent POSTs prose → server answers {"ok":true} → agent marked done, reaped
 *   → step sits "running" → owner clicks approve → 400 "No valid fix plan"
 *
 * By then the only remedy on offer is relaunching a planner that already did
 * the work correctly. The real incident (2026-08-17): the planner wrote a
 * complete 4-task plan to `plan.json`, then lost it building the curl — a
 * multi-line `python3 -c` mangled by zsh, which posted only the prose summary
 * variable. The server said ok. The plan sat on disk, intact, unread, while the
 * run stalled.
 *
 * Checking at POST time turns that into a self-correcting failure: the agent
 * sees a 400 from its own curl, still holds the plan, and retries.
 *
 * **Scoped deliberately to `fix_plan`.** The `planning` step's approve path has
 * a markdown fallback (it can build a task plan out of role headers and
 * numbered lists), so prose there is legitimately parseable and rejecting it
 * would break working runs. Reviewer steps carry a prose format whose
 * validation would be fuzzy. Only fix_plan has a contract strict enough that a
 * failure to parse is unambiguously a failure to comply.
 */

/**
 * Rejections tolerated before the engine stops arguing and escalates.
 *
 * A retry loop that never terminates is worse than the bug being fixed: an
 * agent that cannot produce the format would burn its context re-posting. At
 * the cap the payload is accepted (never discarded — it is the only copy the
 * owner may have) and the step is blocked with an explanatory error, which
 * surfaces through needs-attention immediately rather than waiting for someone
 * to click approve.
 */
const MAX_REJECTIONS = 3;

/**
 * Extract a fix plan from planner feedback.
 *
 * This is the SAME cascade the approve path applies, extracted so the two
 * cannot drift. If validation accepted something approve later rejected, this
 * module would move the stall rather than remove it — so there is exactly one
 * implementation and both callers use it.
 *
 * `parseJSON` is injected because the router's `tryParseJSON` carries repair
 * behaviour (regex task extraction, truncation at the last brace) that agents
 * genuinely depend on; duplicating it here is how the two would diverge.
 *
 * @param {string} feedback
 * @param {(raw:string)=>any} parseJSON  the router's tolerant JSON parser
 * @returns {{tasks:any[]}|null}
 */
function extractFixPlan(feedback, parseJSON) {
  const text = String(feedback || '');
  let plan = null;

  // 1. Fenced json block, closed — then unclosed (agent forgot the trailing fence).
  const fenced = text.match(/```json\s*([\s\S]*?)```/) || text.match(/```json\s*([\s\S]+)/);
  if (fenced) plan = parseJSON(fenced[1]);

  // 2. Unfenced object, anchored on {"tasks" so prose braces don't match.
  //    Whitespace allowed after { so pretty-printed output still matches.
  if (!plan) {
    const raw = text.match(/(\{\s*"tasks"[\s\S]*\})/);
    if (raw) plan = parseJSON(raw[1]);
  }

  // 3. A plainly-stated empty plan. The planner instructions permit "no fixes
  //    needed", and a planner that says so in prose is complying with the
  //    spirit of the contract even though it skipped the JSON.
  if (!plan && (/\b0\s+tasks?\b/i.test(text) || /\bno\s+tasks?\b/i.test(text))) {
    plan = { tasks: [] };
  }

  // Normalise the key aliases the approve path accepts.
  if (plan && !plan.tasks) {
    const arr = plan.fix_plan || plan.fixes || plan.items;
    if (Array.isArray(arr)) plan = { tasks: arr };
  }

  return plan && Array.isArray(plan.tasks) ? plan : null;
}

/** What the agent is told when its feedback does not satisfy the contract. */
const FIX_PLAN_REJECTION = `Your feedback was NOT recorded: it contains no parseable fix plan.

A fix plan is executed as data — the workflow launches one dev agent per task
object — so prose describing the plan cannot be used. Re-post the SAME content
with the plan as a fenced JSON block:

\`\`\`json
{"tasks": [{"id": 1, "name": "<short title>", "description": "<what to change and how to verify>", "roles": ["<execution role>"]}]}
\`\`\`

If no fixes are needed, post {"tasks": []} with a one-line prose reason.

BUILDING THE REQUEST: write the JSON to a file and post it with
  curl -s -X POST <url> -H 'Content-Type: application/json' --data-binary @<file>
Do NOT build the payload inline in a shell string or a multi-line python -c —
quoting has silently truncated real plans to their prose summary that way.`;

/**
 * Does this feedback satisfy its step's machine-parsed contract?
 *
 * Steps without a strict contract return ok — this is an allowlist, so a new
 * step is unvalidated rather than accidentally blocked.
 *
 * @param {string} step      the step the feedback is for
 * @param {string} feedback
 * @param {(raw:string)=>any} parseJSON
 * @returns {{ok:true}|{ok:false, error:string}}
 */
function checkFeedbackContract(step, feedback, parseJSON) {
  if (step !== 'fix_plan') return { ok: true };
  if (extractFixPlan(feedback, parseJSON)) return { ok: true };
  return { ok: false, error: FIX_PLAN_REJECTION };
}

/**
 * Decide what to do with feedback that failed its contract.
 *
 * Split from the check itself so the retry/escalate policy is testable without
 * an HTTP round trip.
 *
 * @param {number} priorRejections  how many times this agent has already failed
 * @returns {{action:'reject'|'escalate', rejections:number, error:string}}
 */
function rejectionOutcome(priorRejections, error) {
  const rejections = (priorRejections || 0) + 1;
  if (rejections >= MAX_REJECTIONS) {
    return {
      action: 'escalate',
      rejections,
      error: `Fix planner posted feedback ${rejections} times without a parseable JSON task array. `
        + 'The last attempt was kept as the step feedback so nothing is lost, but it cannot be approved as-is. '
        + "Check the agent's log — the plan may exist in its scratchpad and only the POST failed. "
        + 'Relaunch fix_plan, or post the plan manually as a ```json block.',
    };
  }
  return { action: 'reject', rejections, error };
}

module.exports = {
  extractFixPlan,
  checkFeedbackContract,
  rejectionOutcome,
  FIX_PLAN_REJECTION,
  MAX_REJECTIONS,
};
