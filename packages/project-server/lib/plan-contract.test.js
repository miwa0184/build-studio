'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractFixPlan,
  checkFeedbackContract,
  rejectionOutcome,
  MAX_REJECTIONS,
} = require('./plan-contract');

// Stand-in for the router's tolerant parser. The real one adds repair
// behaviour; these tests exercise the extraction cascade, not JSON repair.
const parseJSON = (raw) => { try { return JSON.parse(raw); } catch { return null; } };

const PLAN = '{"tasks": [{"id": 1, "name": "Fix it", "description": "do the thing", "roles": ["iOS Dev"]}]}';

test('a fenced json plan is extracted', () => {
  const plan = extractFixPlan(`## Fix Plan\n\n\`\`\`json\n${PLAN}\n\`\`\`\n`, parseJSON);
  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.tasks[0].roles[0], 'iOS Dev');
});

test('an unclosed fence still parses — agents forget the trailing fence', () => {
  const plan = extractFixPlan(`\`\`\`json\n${PLAN}`, parseJSON);
  assert.equal(plan.tasks.length, 1);
});

test('an unfenced pretty-printed object parses (example-ios EX-107)', () => {
  const plan = extractFixPlan(`Here is the plan:\n\n{\n  "tasks": [\n    {"id": 1, "roles": ["Dev"]}\n  ]\n}`, parseJSON);
  assert.equal(plan.tasks.length, 1);
});

test('key aliases are normalised to tasks', () => {
  const plan = extractFixPlan('```json\n{"fix_plan": [{"id": 1}]}\n```', parseJSON);
  assert.equal(plan.tasks.length, 1);
});

test('a plainly-stated empty plan is accepted', () => {
  for (const fb of ['No fixes needed — 0 tasks.', 'Everything is clean, no tasks required.']) {
    const plan = extractFixPlan(fb, parseJSON);
    assert.ok(plan, `should accept: ${fb}`);
    assert.equal(plan.tasks.length, 0);
  }
});

// The incident this module exists for. The planner wrote a correct 4-task plan
// to disk, then lost it building the curl — zsh mangled a multi-line python -c
// and posted only the prose summary. The server accepted it, the agent was
// reaped, and the failure surfaced hours later as a dead approve button.
const FAZON_PROSE = `## Fix Plan

FIX PLAN (4 tasks) for round 2. Only iOS Dev is an available execution role, so the
architect action items were folded into iOS Dev tasks. NOT in the plan because no
available role owns them: pm — whether verdict paths owe a walk follow beat; brand —
EN/SV pass on the seven changed sentences. Ordering: task 1 first.`;

test('prose describing a plan is NOT a plan', () => {
  assert.equal(extractFixPlan(FAZON_PROSE, parseJSON), null);
  const check = checkFeedbackContract('fix_plan', FAZON_PROSE, parseJSON);
  assert.equal(check.ok, false);
  assert.match(check.error, /NOT recorded/);
});

test('"no available role" does not read as "no tasks"', () => {
  // The zero-task escape hatch is a substring match; prose about roles must not
  // trip it, or a real 4-task plan would be silently approved as empty.
  const plan = extractFixPlan(FAZON_PROSE, parseJSON);
  assert.equal(plan, null);
});

test('the rejection tells the agent how to post without shell mangling', () => {
  const { error } = checkFeedbackContract('fix_plan', 'prose only', parseJSON);
  assert.match(error, /--data-binary/);
  assert.match(error, /python -c/);
});

test('only fix_plan is validated — planning has a markdown fallback', () => {
  // Rejecting prose for `planning` would break working runs: its approve path
  // builds a task plan from role headers and numbered lists.
  for (const step of ['planning', 'code_review', 'qa_validation', 'team_review']) {
    assert.equal(checkFeedbackContract(step, 'prose only', parseJSON).ok, true, step);
  }
});

test('a valid plan passes the contract', () => {
  assert.equal(checkFeedbackContract('fix_plan', `\`\`\`json\n${PLAN}\n\`\`\``, parseJSON).ok, true);
});

test('early failures are rejected so the live agent can retry', () => {
  const out = rejectionOutcome(0, 'because');
  assert.equal(out.action, 'reject');
  assert.equal(out.rejections, 1);
  assert.equal(out.error, 'because');
});

test('at the cap the payload is kept and the owner is brought in', () => {
  const out = rejectionOutcome(MAX_REJECTIONS - 1, 'because');
  assert.equal(out.action, 'escalate');
  assert.equal(out.rejections, MAX_REJECTIONS);
  // The escalation must not repeat the agent-facing instructions — it is read
  // by a person deciding what to do, and it has to say the content was kept.
  assert.match(out.error, /kept as the step feedback/);
  assert.match(out.error, /scratchpad/);
});

test('rejection never loops forever', () => {
  let priors = 0;
  for (let i = 0; i < 10; i++) {
    const out = rejectionOutcome(priors, 'x');
    priors = out.rejections;
    if (out.action === 'escalate') break;
    assert.ok(i < MAX_REJECTIONS, 'must escalate within the cap');
  }
  assert.ok(priors >= MAX_REJECTIONS);
});
