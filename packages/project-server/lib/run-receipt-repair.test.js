'use strict';

// A1c receipt — repair of five independent review findings (H1–H5):
//
//   H1  the verdict parser could turn an explicit refusal into an approval
//       ("Not approved" matched /approve/; a quoted template line
//       "Approved: yes | no" could win over the actual marker);
//   H2  a pending hold, or a hold without a frozen candidateSha, was accepted
//       and finalization then bound whatever the branch tip happened to be;
//   H3  the receipt carried no resolved workflow/review sequence, so
//       `reviews: []` could mean "no gates configured" or "evidence missing";
//   H4  an already onboarded project could lack ignore protection for
//       .build-studio/run-receipt/ and commit or check out the receipt away;
//   H5  guardRevision made a benign replay conflict, while the precommit did
//       not re-verify the evidence the receipt was built from.
//
// Every test drives the real state manager, run guard, admission registry and
// a real temporary git repository. The fixture uses only init, symbolic-ref,
// add, commit, rev-parse, status, check-ignore and ls-files so it runs under a
// restricted git as well as a full one; the candidate branch is created by
// writing its ref file at the main tip and pointing HEAD at it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { loadConfig } = require('./config');
const { createStateManager } = require('./state');
const { createAdmissionRegistry } = require('./admission-registry');
const { qaServerSuiteGateVerdict, DEFAULT_BUGFIX_STEPS } = require('./api/workflow');
const receiptLib = require('./run-receipt');

const { createRunReceiptAuthority, createRunReceiptStore, RECEIPT_DIR, CODES } = receiptLib;

const RUN_ID = 'bugfix-2026-09-04T12-00-00-ef56';
const PACKET = 'docs/backlog/LS-002.md';
const CANDIDATE_BRANCH = 'fix/ls-002';
const CLEAN_QA = ['**Tests passed:** 12/12', '**Approved:** yes', '**Blocking:** 0', '12 passed'].join('\n');
const CLEAN_REVIEW = '## Review: Code Reviewer\n\n**Approved:** yes\n**Blocking:** 0  |  **Medium:** 1  |  **Low:** 2\n\n### Summary\nClean.';
const RECEIPT_IGNORE_LINE = '.build-studio/run-receipt/';
const BASE_IGNORE = [
  '.build-studio/admission/', '.build-studio/run-guard/', '.build-studio/workflow-state.json',
  '.build-studio/snapshots/', '.build-studio/local.json', 'docs/agent-status.json', 'tmp/',
];

// ---------- fixture ----------

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Receipt Repair', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Receipt Repair', GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: GIT_ENV }).trim();
}

function gitStatus(cwd, args) {
  try {
    execFileSync('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: GIT_ENV });
    return 0;
  } catch (error) {
    return error.status;
  }
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function configYaml() {
  return [
    'name: receipt-repair-fixture', 'port: 5199', 'docs_path: ./docs',
    'roles:', '  execution: []', '  review: []', '  standalone: []',
    'builder_strategy: role',
    'deployment:', '  auto_deploy: false', '  auto_tag: false', '',
  ].join('\n');
}

function makeRepo(t, { ignoreReceipts = true, extraIgnore = [], trackedReceipt = false } = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-receipt-repair-'));
  t.after(() => { try { fs.rmSync(parent, { recursive: true, force: true }); } catch (_) {} });
  const root = path.join(parent, 'project');
  fs.mkdirSync(root, { recursive: true });
  git(root, ['init', '-q']);
  git(root, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  write(path.join(root, '.gitignore'), [...BASE_IGNORE, ...(ignoreReceipts ? [RECEIPT_IGNORE_LINE] : []), ...extraIgnore, ''].join('\n'));
  write(path.join(root, '.build-studio', 'config.yaml'), configYaml());
  write(path.join(root, PACKET), '---\nid: LS-002\ntitle: Fixture bug\ntype: Bug\nstatus: Backlog\n---\n\nFixture.\n');
  write(path.join(root, 'src', 'base.js'), 'module.exports = "base";\n');
  if (trackedReceipt) write(path.join(root, '.build-studio', RECEIPT_DIR, 'stale-run.json'), '{}\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'initial main']);
  const mainSha = git(root, ['rev-parse', 'HEAD']);
  assert.match(mainSha, /^[0-9a-f]{40}$/);
  // Branch the candidate off main without checkout/branch: write the ref at
  // the main tip and move HEAD to it (index and tree already match).
  const refRel = git(root, ['rev-parse', '--git-path', `refs/heads/${CANDIDATE_BRANCH}`]);
  write(path.isAbsolute(refRel) ? refRel : path.join(root, refRel), `${mainSha}\n`);
  git(root, ['symbolic-ref', 'HEAD', `refs/heads/${CANDIDATE_BRANCH}`]);
  assert.equal(git(root, ['rev-parse', '--verify', `refs/heads/${CANDIDATE_BRANCH}`]), mainSha, 'fixture must branch the candidate at main');
  write(path.join(root, 'src', 'candidate.js'), 'module.exports = "candidate";\n');
  write(path.join(root, PACKET), '---\nid: LS-002\ntitle: Fixture bug\ntype: Bug\nstatus: Fixing\n---\n\nFixture.\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'fix: candidate']);
  const candidateSha = git(root, ['rev-parse', 'HEAD']);
  assert.equal(git(root, ['rev-parse', '--verify', `refs/heads/${CANDIDATE_BRANCH}`]), candidateSha);
  return { parent, root, mainSha, candidateSha };
}

function commitOnCandidate(fx, name) {
  write(path.join(fx.root, 'src', `${name}.js`), `module.exports = "${name}";\n`);
  git(fx.root, ['add', '-A']);
  git(fx.root, ['commit', '-q', '-m', `late: ${name}`]);
  return git(fx.root, ['rev-parse', 'HEAD']);
}

function registerRoot(root, { admittedHead, guard }) {
  const statePath = path.join(root, '.build-studio');
  const registry = createAdmissionRegistry({ statePath });
  const requestDigest = crypto.createHash('sha256').update(`receipt-repair:${RUN_ID}:${admittedHead}`).digest('hex');
  const lineage = {
    runId: RUN_ID, lineageId: RUN_ID, predecessorRunId: null, successorOrdinal: 0,
    registeredAt: '2026-09-04T11:00:00.000Z', admissionRequestDigest: requestDigest,
    admittedHead, admittedRepo: 'test-owner/test-repo',
  };
  guard.register(RUN_ID, { identity: { ...lineage, rootRegistry: { runId: RUN_ID, requestDigest } } });
  registry.admit({
    nonce: `nonce-${RUN_ID}`, runId: RUN_ID,
    verdict: {
      kind: 'GateVerdict', version: 1, decision: 'ADMITTED', runId: RUN_ID, repo: lineage.admittedRepo,
      head: admittedHead, taskPacket: PACKET, nonce: 'n', requestDigest, admittedAt: lineage.registeredAt,
    },
    lineage, claims: [],
  });
  return { registry, requestDigest };
}

function agent(role, extra = {}) {
  return { role, window: `w-${role}`, status: 'done', cli: 'claude', model: 'opus', modelSource: 'preset', effort: 'high', completedAt: '2026-09-04T11:30:00.000Z', ...extra };
}

function frozenHold(fx, candidateSha = fx.candidateSha) {
  return {
    status: 'blocked', code: 'LOCAL_MERGE_REMOVED', egress: 'not_installed', error: 'held',
    candidateBranch: CANDIDATE_BRANCH, defaultBranch: 'main', candidateSha,
  };
}

function workflowAtHold(fx, { requestDigest, admittedHead, hold }) {
  return {
    id: RUN_ID, type: 'bugfix', input: 'LS-002', itemId: 'LS-002', prdPath: PACKET,
    admission: { runId: RUN_ID, requestDigest, admittedAt: '2026-09-04T11:00:00.000Z', admittedHead },
    currentStep: 'merge_to_main', branch: CANDIDATE_BRANCH, defaultBranch: 'main', reviewBranch: CANDIDATE_BRANCH,
    round: 1, feedback: [], autoAdvance: false, sessionName: 'wf-receipt-repair', createdAt: '2026-09-04T11:00:00.000Z',
    steps: {
      task_execution: { status: 'completed', agents: [] },
      qa_validation: { status: 'completed', agents: [agent('QA', { model: 'sonnet', feedback: CLEAN_QA })] },
      code_review: { status: 'completed', agents: [agent('Code Reviewer', { feedback: CLEAN_REVIEW })] },
      merge_to_main: hold || frozenHold(fx),
      capture_learnings: { status: 'pending', agents: [] },
    },
    taskPlan: { tasks: [{ id: 1, name: 'Fix it', roles: ['Backend Dev'] }] },
    taskExecution: { currentTaskIndex: 0, taskStates: { 0: { status: 'done', acceptanceCovered: true, fixCycles: 0, agents: [agent('Backend Dev', { feedback: '**All issues addressed:** yes' })] } } },
  };
}

function persistWorkflow(state, wf, { durableHold = true } = {}) {
  const hold = wf.steps && wf.steps.merge_to_main;
  if (durableHold
    && wf.currentStep === 'merge_to_main'
    && hold && hold.status === 'blocked'
    && typeof hold.candidateBranch === 'string'
    && typeof hold.candidateSha === 'string' && /^[0-9a-f]{40}$/.test(hold.candidateSha)
    && typeof hold.defaultBranch === 'string') {
    state.recordEgressHold(wf, {
      candidateBranch: hold.candidateBranch,
      candidateSha: hold.candidateSha,
      defaultBranch: hold.defaultBranch,
    });
    return;
  }
  state.saveWorkflow(wf);
}

/**
 * Full fixture. `mutate(wf, fx)` edits the workflow before it is saved;
 * `configure(config)` edits the resolved config the authority runs with;
 * `store` replaces the receipt store (used to inject drift under the lease).
 */
function makeFixture(t, options = {}) {
  const fx = makeRepo(t, options);
  const config = loadConfig(fx.root);
  if (typeof options.configure === 'function') options.configure(config);
  const state = createStateManager(config, () => {});
  const admittedHead = fx.mainSha;
  const { registry, requestDigest } = registerRoot(fx.root, { admittedHead, guard: state.runGuard });
  const wf = workflowAtHold(fx, { requestDigest, admittedHead, hold: options.hold });
  if (typeof options.mutate === 'function') options.mutate(wf, fx);
  persistWorkflow(state, wf, { durableHold: options.durableHold !== false });
  const gitCalls = [];
  const gitRunner = (args) => {
    gitCalls.push([...args]);
    return execFileSync('git', args, { cwd: fx.root, stdio: ['pipe', 'pipe', 'pipe'], env: GIT_ENV });
  };
  const store = typeof options.store === 'function' ? options.store(config, state) : undefined;
  const authority = createRunReceiptAuthority({ config, state, qaGate: qaServerSuiteGateVerdict, git: gitRunner, store });
  const receiptDir = path.join(config.statePath, RECEIPT_DIR);
  return { ...fx, config, state, registry, requestDigest, admittedHead, wf, authority, gitCalls, receiptDir, receiptFile: path.join(receiptDir, `${RUN_ID}.json`) };
}

function receiptFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
}

function refuses(fx, code, options) {
  const before = receiptFiles(fx.receiptDir);
  let caught;
  assert.throws(() => fx.authority.finalize(options), (error) => {
    caught = error;
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return true;
  });
  assert.deepEqual(receiptFiles(fx.receiptDir), before, 'a refused finalization must write no receipt');
  assert.equal(fx.authority.read(), null, 'a refused finalization must leave no readable receipt');
  return caught;
}

function reviewFeedback(lines) {
  return `## Review: Code Reviewer\n\n${lines.join('\n')}\n\n### Summary\nSee above.`;
}

// ---------- F1–F3: verdict interpretation ----------

test('F1 — "Verdict: Not approved — changes requested" is never read as approved', (t) => {
  const fx = makeFixture(t, { mutate: (wf) => {
    wf.steps.code_review.agents[0].feedback = reviewFeedback(['**Verdict:** Not approved — changes requested', '**Blocking:** 0  |  **Medium:** 2  |  **Low:** 0']);
  } });
  const error = refuses(fx, CODES.REVIEW_BLOCKING);
  assert.equal(error.approved, false, 'an explicit refusal must be recorded as not approved, not as ambiguous');
  assert.equal(error.step, 'code_review');
});

test('F1 — negated and refusing Verdict vocabularies all refuse; only a bare approval passes', (t) => {
  for (const verdict of ['not approved', 'NOT APPROVED', 'unapproved', 'rejected', 'changes requested', 'blocked — see findings', 'approved with blocking changes requested']) {
    const fx = makeFixture(t, { mutate: (wf) => {
      wf.steps.code_review.agents[0].feedback = reviewFeedback([`**Verdict:** ${verdict}`, '**Blocking:** 0']);
    } });
    const error = refuses(fx, CODES.REVIEW_BLOCKING);
    assert.equal(error.approved, false, `verdict ${JSON.stringify(verdict)} must be a refusal`);
  }
  const clean = makeFixture(t, { mutate: (wf) => {
    wf.steps.code_review.agents[0].feedback = reviewFeedback(['**Verdict:** Approved', '**Blocking:** 0']);
  } });
  assert.equal(clean.authority.finalize().created, true);
  const prose = makeFixture(t, { mutate: (wf) => {
    wf.steps.code_review.agents[0].feedback = reviewFeedback(['**Verdict:** looks good, I approve of the direction', '**Blocking:** 0']);
  } });
  refuses(prose, CODES.EVIDENCE_AMBIGUOUS);
});

test('F2 — a quoted template line "Approved: yes | no" followed by the real "Approved: no" never approves', (t) => {
  const fx = makeFixture(t, { mutate: (wf) => {
    wf.steps.code_review.agents[0].feedback = [
      '## Review: Code Reviewer',
      '',
      'Format reminder from the prompt:',
      '**Approved:** yes | no',
      '**Blocking:** N  |  **Medium:** N  |  **Low:** N',
      '',
      '**Approved:** no',
      '**Blocking:** 1  |  **Medium:** 0  |  **Low:** 0',
      '',
      '### Findings',
      '- BLOCKING: the fix reintroduces the crash.',
    ].join('\n');
  } });
  const error = refuses(fx, CODES.REVIEW_BLOCKING);
  assert.equal(error.approved, false);
  assert.equal(error.blocking, 1);
});

test('F2 — template-shaped, quoted, fenced and inline-code markers alone are ambiguous, never approval', (t) => {
  const variants = {
    template: ['**Approved:** yes | no', '**Blocking:** 0'],
    slash: ['**Approved:** yes/no', '**Blocking:** 0'],
    fenced: ['```', '**Approved:** yes', '**Blocking:** 0', '```'],
    blockquote: ['> **Approved:** yes', '> **Blocking:** 0'],
    inlineCode: ['- `**Approved:** yes` is the format', '**Blocking:** 0'],
    trailingPipe: ['**Approved:** yes |', '**Blocking:** 0'],
  };
  for (const [name, lines] of Object.entries(variants)) {
    const fx = makeFixture(t, { mutate: (wf) => { wf.steps.code_review.agents[0].feedback = reviewFeedback(lines); } });
    refuses(fx, CODES.EVIDENCE_AMBIGUOUS);
    assert.equal(fx.authority.read(), null, `variant ${name} must not finalize`);
  }
});

test('F3 — conflicting or multiple authoritative verdict markers never approve', (t) => {
  const yesThenNo = makeFixture(t, { mutate: (wf) => {
    wf.steps.code_review.agents[0].feedback = reviewFeedback(['**Approved:** yes', '**Blocking:** 0', '', 'Correction after re-reading the diff:', '**Approved:** no', '**Blocking:** 1']);
  } });
  const conflict = refuses(yesThenNo, CODES.REVIEW_BLOCKING);
  assert.equal(conflict.approved, false, 'an explicit no wins over an earlier yes');

  const noThenYes = makeFixture(t, { mutate: (wf) => {
    wf.steps.code_review.agents[0].feedback = reviewFeedback(['**Approved:** no', '**Blocking:** 0', '**Approved:** yes', '**Blocking:** 0']);
  } });
  assert.equal(refuses(noThenYes, CODES.REVIEW_BLOCKING).approved, false, 'an explicit no wins over a later yes');

  const twoYes = makeFixture(t, { mutate: (wf) => {
    wf.steps.code_review.agents[0].feedback = reviewFeedback(['**Approved:** yes', '**Blocking:** 0', '**Approved:** yes', '**Blocking:** 0']);
  } });
  refuses(twoYes, CODES.EVIDENCE_AMBIGUOUS);

  const approvedPlusVerdict = makeFixture(t, { mutate: (wf) => {
    wf.steps.code_review.agents[0].feedback = reviewFeedback(['**Approved:** yes', '**Verdict:** approved', '**Blocking:** 0']);
  } });
  refuses(approvedPlusVerdict, CODES.EVIDENCE_AMBIGUOUS);

  const verdictConflict = makeFixture(t, { mutate: (wf) => {
    wf.steps.code_review.agents[0].feedback = reviewFeedback(['**Approved:** yes', '**Verdict:** changes requested', '**Blocking:** 0']);
  } });
  assert.equal(refuses(verdictConflict, CODES.REVIEW_BLOCKING).approved, false);

  const blockingDisagree = makeFixture(t, { mutate: (wf) => {
    wf.steps.code_review.agents[0].feedback = reviewFeedback(['**Approved:** yes', '**Blocking:** 0', '**Blocking:** 2']);
  } });
  refuses(blockingDisagree, CODES.EVIDENCE_AMBIGUOUS);
});

test('F3 — hedged or template-shaped blocking counts never authorize a receipt', (t) => {
  for (const value of ['0 or 1', '0/1', '0 (template)', '0 | maybe 2']) {
    const fx = makeFixture(t, { mutate: (wf) => {
      wf.steps.code_review.agents[0].feedback = reviewFeedback(['**Approved:** yes', `**Blocking:** ${value}`]);
    } });
    refuses(fx, CODES.EVIDENCE_AMBIGUOUS);
  }
});

// ---------- F4–F6: the frozen candidate ----------

test('F4 — a pending merge_to_main, or a hold without a frozen candidateSha, is refused', (t) => {
  const pending = makeFixture(t, { hold: { status: 'pending' } });
  refuses(pending, CODES.HOLD_NOT_FROZEN);
  refuses(pending, CODES.HOLD_NOT_FROZEN, { candidateSha: pending.candidateSha });

  const unfrozen = makeFixture(t, { hold: (() => { const h = frozenHold({ candidateSha: 'x' }); delete h.candidateSha; return h; })() });
  refuses(unfrozen, CODES.HOLD_NOT_FROZEN);

  const nullSha = makeFixture(t, { hold: frozenHold({ candidateSha: null }) });
  refuses(nullSha, CODES.HOLD_NOT_FROZEN);

  const badSha = makeFixture(t, { hold: frozenHold({ candidateSha: 'not-a-sha' }) });
  refuses(badSha, CODES.HOLD_NOT_FROZEN);
});

test('F4 — a valid-looking mutable hold without durable Egress Hold authority is refused', (t) => {
  const unbacked = makeFixture(t, { durableHold: false });
  assert.equal(unbacked.state.authoritativeEgressHold(RUN_ID), null, 'red fixture must have no durable freeze');
  refuses(unbacked, CODES.HOLD_NOT_FROZEN);
});

test('F5 — a blocked Egress Hold with a frozen sha that matches the candidate passes this check', (t) => {
  const fx = makeFixture(t);
  const { created, receipt } = fx.authority.finalize({ candidateSha: fx.candidateSha });
  assert.equal(created, true);
  assert.equal(receipt.hold.status, 'blocked');
  assert.equal(receipt.hold.code, 'LOCAL_MERGE_REMOVED');
  assert.equal(receipt.candidate.sha, fx.candidateSha);
  assert.equal(receipt.candidate.heldSha, fx.candidateSha);
  assert.equal(receipt.candidate.branch, CANDIDATE_BRANCH);
  assert.equal(receipt.candidate.base.sha, fx.mainSha);
  assert.equal(receipt.candidate.descendsFromAdmittedHead, true);
  assert.equal(git(fx.root, ['status', '--porcelain']), '', 'finalization must not dirty the managed tree');
});

test('F6 — a candidate that moved after the frozen sha, or a frozen sha that is not the tip, is refused', (t) => {
  const moved = makeFixture(t);
  const late = commitOnCandidate(moved, 'late');
  assert.notEqual(late, moved.candidateSha);
  refuses(moved, CODES.CANDIDATE_DRIFT);
  // Stating the new tip explicitly must not rebind the receipt to it.
  refuses(moved, CODES.CANDIDATE_DRIFT, { candidateSha: late });

  // The hold froze a different commit than the one the branch points at now:
  // the receipt binds the frozen candidate or nothing, never the current tip.
  const frozenElsewhere = makeFixture(t, { mutate: (wf, f) => { wf.steps.merge_to_main = frozenHold(f, f.mainSha); } });
  refuses(frozenElsewhere, CODES.CANDIDATE_DRIFT);
  refuses(frozenElsewhere, CODES.CANDIDATE_DRIFT, { candidateSha: frozenElsewhere.candidateSha });

  const otherBranch = makeFixture(t, { mutate: (wf) => { wf.steps.merge_to_main.candidateBranch = 'main'; } });
  refuses(otherBranch, CODES.CANDIDATE_DRIFT);
});

// ---------- F7: the resolved sequence ----------

test('F7 — the receipt carries the effectively resolved sequence and every required gate has evidence', (t) => {
  const fx = makeFixture(t);
  const { receipt } = fx.authority.finalize();
  assert.deepEqual(receipt.sequence.steps, DEFAULT_BUGFIX_STEPS);
  assert.equal(receipt.sequence.source, 'bugfix_default');
  assert.deepEqual(receipt.sequence.reviewGates, ['qa_validation', 'code_review']);
  assert.deepEqual(receipt.sequence.extraSteps, []);
  assert.deepEqual(receipt.reviews.map((r) => r.step), receipt.sequence.reviewGates);
  assert.equal(receipt.qa.mode, 'agent_verdict');
});

test('F7 — a legitimate zero-gate sequence is represented explicitly, distinct from missing evidence', (t) => {
  const zero = ['task_execution', 'merge_to_main', 'capture_learnings'];
  const fx = makeFixture(t, {
    configure: (config) => { config.workflow = { ...(config.workflow || {}), bugfix: zero }; },
    mutate: (wf) => { delete wf.steps.qa_validation; delete wf.steps.code_review; },
  });
  const { receipt } = fx.authority.finalize();
  assert.deepEqual(receipt.sequence.steps, zero);
  assert.equal(receipt.sequence.source, 'config.workflow.bugfix');
  assert.deepEqual(receipt.sequence.reviewGates, []);
  assert.deepEqual(receipt.reviews, []);
  assert.equal(receipt.qa.mode, 'not_in_sequence');
  assert.equal(receipt.qa.configured, false);
});

test('F7 — a run missing a required gate, an extra review step, or a reordered sequence fails closed', (t) => {
  const missingGate = makeFixture(t, { mutate: (wf) => { delete wf.steps.code_review; } });
  refuses(missingGate, CODES.SEQUENCE_MISMATCH);

  const emptyGate = makeFixture(t, { mutate: (wf) => { wf.steps.code_review.agents = []; } });
  refuses(emptyGate, CODES.EVIDENCE_AMBIGUOUS);

  const extraReview = makeFixture(t, { mutate: (wf) => {
    const { task_execution, qa_validation, code_review, merge_to_main, capture_learnings } = wf.steps;
    wf.steps = { task_execution, qa_validation, code_review, security_audit: { status: 'completed', agents: [agent('Security', { feedback: CLEAN_REVIEW })] }, merge_to_main, capture_learnings };
  } });
  refuses(extraReview, CODES.SEQUENCE_MISMATCH);

  const reordered = makeFixture(t, { mutate: (wf) => {
    const { task_execution, qa_validation, code_review, merge_to_main, capture_learnings } = wf.steps;
    wf.steps = { task_execution, code_review, qa_validation, merge_to_main, capture_learnings };
  } });
  refuses(reordered, CODES.SEQUENCE_MISMATCH);

  // The resolver says the run needed code_review; the run never had it and
  // its config now says otherwise. The receipt binds what governed the run
  // and what the resolver returns; a disagreement is not silently resolved.
  const driftedConfig = makeFixture(t, {
    configure: (config) => { config.workflow = { ...(config.workflow || {}), bugfix: ['task_execution', 'qa_validation', 'merge_to_main', 'capture_learnings'] }; },
  });
  refuses(driftedConfig, CODES.SEQUENCE_MISMATCH);

  // A fix loop's dynamic step is tolerated and recorded, not treated as drift.
  const withFixPlan = makeFixture(t, { mutate: (wf) => {
    const { task_execution, qa_validation, code_review, merge_to_main, capture_learnings } = wf.steps;
    wf.steps = { task_execution, qa_validation, fix_plan: { status: 'completed', agents: [] }, code_review, merge_to_main, capture_learnings };
  } });
  const { receipt } = withFixPlan.authority.finalize();
  assert.deepEqual(receipt.sequence.extraSteps, ['fix_plan']);
  assert.deepEqual(receipt.sequence.reviewGates, ['qa_validation', 'code_review']);
});

test('F7 — every review gate must precede the Egress Hold and be completed', (t) => {
  const afterHold = makeFixture(t, {
    configure: (config) => {
      config.workflow = {
        ...(config.workflow || {}),
        bugfix: ['task_execution', 'qa_validation', 'merge_to_main', 'code_review', 'capture_learnings'],
      };
    },
    mutate: (wf) => {
      const { task_execution, qa_validation, code_review, merge_to_main, capture_learnings } = wf.steps;
      code_review.status = 'pending';
      wf.steps = { task_execution, qa_validation, merge_to_main, code_review, capture_learnings };
    },
  });
  refuses(afterHold, CODES.SEQUENCE_MISMATCH);

  const direct = {
    id: RUN_ID,
    round: 1,
    steps: {
      code_review: { status: 'pending', agents: [agent('Code Reviewer', { feedback: CLEAN_REVIEW })] },
    },
  };
  assert.throws(
    () => receiptLib.collectReviewEvidence(direct, ['code_review']),
    (error) => error.code === CODES.EVIDENCE_AMBIGUOUS && error.step === 'code_review',
    'a clean-looking verdict on an incomplete gate must not become receipt evidence',
  );
});

// ---------- F8: storage in an already onboarded project ----------

test('F8 — an unprotected receipt path in an onboarded git project is secured before the receipt is written', (t) => {
  const fx = makeFixture(t, { ignoreReceipts: false });
  const rel = path.posix.join('.build-studio', RECEIPT_DIR, `${RUN_ID}.json`);
  assert.equal(gitStatus(fx.root, ['check-ignore', '-q', '--', rel]), 1, 'fixture must start with the receipt path unprotected');

  const { created } = fx.authority.finalize();
  assert.equal(created, true);
  assert.ok(fs.existsSync(fx.receiptFile));
  assert.equal(git(fx.root, ['status', '--porcelain']), '', 'the receipt must not appear as an untracked change');
  assert.equal(gitStatus(fx.root, ['check-ignore', '-q', '--', rel]), 0, 'the receipt path must be ignored after finalization');
  git(fx.root, ['add', '-A']);
  assert.equal(git(fx.root, ['status', '--porcelain']), '', 'git add -A must not stage the receipt');
  assert.equal(git(fx.root, ['ls-files', '--', path.posix.join('.build-studio', RECEIPT_DIR)]), '', 'no receipt may be tracked');
  const excludeRel = git(fx.root, ['rev-parse', '--git-path', 'info/exclude']);
  const exclude = fs.readFileSync(path.isAbsolute(excludeRel) ? excludeRel : path.join(fx.root, excludeRel), 'utf8');
  assert.ok(exclude.split('\n').includes(RECEIPT_IGNORE_LINE), 'protection is the repo-local exclude, not a product file');
  assert.equal(fs.readFileSync(path.join(fx.root, '.gitignore'), 'utf8').includes(RECEIPT_IGNORE_LINE), false, 'the product .gitignore is not rewritten');

  // Idempotent: a replay does not append the pattern again.
  assert.equal(fx.authority.finalize().created, false);
  const again = fs.readFileSync(path.isAbsolute(excludeRel) ? excludeRel : path.join(fx.root, excludeRel), 'utf8');
  assert.equal(again, exclude);
});

test('F8 — a receipt path that cannot be protected, or that is already tracked, refuses with typed recovery', (t) => {
  // Eligibility is evaluated before the local ignore migration. A run that
  // cannot produce a receipt must not mutate even Git's repo-local metadata.
  const ineligible = makeFixture(t, {
    ignoreReceipts: false,
    mutate: (wf) => { wf.steps.code_review.agents[0].feedback = reviewFeedback(['**Approved:** no', '**Blocking:** 1']); },
  });
  const ineligibleExcludeRel = git(ineligible.root, ['rev-parse', '--git-path', 'info/exclude']);
  const ineligibleExclude = path.isAbsolute(ineligibleExcludeRel) ? ineligibleExcludeRel : path.join(ineligible.root, ineligibleExcludeRel);
  const excludeBefore = fs.readFileSync(ineligibleExclude, 'utf8');
  refuses(ineligible, CODES.REVIEW_BLOCKING);
  assert.equal(fs.readFileSync(ineligibleExclude, 'utf8'), excludeBefore, 'an ineligible run must not migrate receipt storage');

  // A .gitignore negation outranks the repo-local exclude; the path cannot be
  // made safe without editing a product file, which finalization never does.
  const negated = makeFixture(t, { ignoreReceipts: false, extraIgnore: ['!.build-studio/run-receipt/', '!.build-studio/run-receipt/**'] });
  const error = refuses(negated, CODES.STORAGE_UNPROTECTED);
  assert.match(error.message, /run-receipt/);
  assert.ok(typeof error.recovery === 'string' && error.recovery.length > 0, 'the refusal must say how to recover');
  assert.equal(fs.existsSync(negated.receiptDir), false, 'nothing is created under an unprotected path');
  assert.equal(git(negated.root, ['status', '--porcelain']), '');

  const tracked = makeFixture(t, { ignoreReceipts: false, trackedReceipt: true });
  assert.notEqual(git(tracked.root, ['ls-files', '--', path.posix.join('.build-studio', RECEIPT_DIR)]), '');
  const trackedError = refuses(tracked, CODES.STORAGE_UNPROTECTED);
  assert.match(trackedError.recovery, /rm --cached/);
  assert.equal(fs.existsSync(tracked.receiptFile), false);
  assert.equal(git(tracked.root, ['status', '--porcelain']), '');
});

// ---------- F9–F10: revision and idempotency ----------

test('F9 — a replay with the same material evidence returns the byte-identical receipt despite guard revision churn', (t) => {
  const fx = makeFixture(t);
  const first = fx.authority.finalize();
  assert.equal(first.created, true);
  const bytes = fs.readFileSync(fx.receiptFile);
  const revisionBefore = fx.state.runGuard.load(RUN_ID).revision;
  assert.equal(first.receipt.guardRevision, revisionBefore);

  // Irrelevant aggregate churn: a counter bump moves the revision only.
  fx.state.runGuard.bump(RUN_ID, 'receipt_repair_probe');
  fx.state.runGuard.bump(RUN_ID, 'receipt_repair_probe');
  assert.equal(fx.state.runGuard.load(RUN_ID).revision, revisionBefore + 2);

  const second = fx.authority.finalize();
  assert.equal(second.created, false);
  assert.deepEqual(second.receipt, first.receipt);
  assert.ok(fs.readFileSync(fx.receiptFile).equals(bytes), 'the replay must not rewrite the file');
  assert.equal(second.receipt.guardRevision, revisionBefore, 'the receipt keeps the revision it was built from');
  assert.match(second.receipt.identity.guardEvidenceDigest, /^[0-9a-f]{64}$/);
  assert.equal(receiptLib.receiptDigestOf(second.receipt), second.receipt.receiptDigest);
});

test('F10 — material guard or evidence drift between build and precommit refuses and publishes nothing', (t) => {
  // The store wrapper runs `between` under the receipt lease, after the body
  // was built and before the authority re-verifies it.
  const driftingStore = (between) => (config, state) => {
    const real = createRunReceiptStore({ statePath: config.statePath });
    return {
      ...real,
      finalize: (id, body, opts = {}) => real.finalize(id, body, {
        ...opts,
        precommit: () => { between(state); if (typeof opts.precommit === 'function') opts.precommit(); },
      }),
    };
  };

  const reviewFlipped = makeFixture(t, { store: driftingStore((state) => {
    const wf = state.loadWorkflow();
    wf.steps.code_review.agents[0].feedback = reviewFeedback(['**Approved:** no', '**Blocking:** 1']);
    state.saveWorkflow(wf);
  }) });
  refuses(reviewFlipped, CODES.REVIEW_BLOCKING);

  const countsChanged = makeFixture(t, { store: driftingStore((state) => {
    const wf = state.loadWorkflow();
    wf.steps.code_review.agents[0].feedback = reviewFeedback(['**Approved:** yes', '**Blocking:** 0  |  **Medium:** 5  |  **Low:** 0']);
    state.saveWorkflow(wf);
  }) });
  const drift = refuses(countsChanged, CODES.EVIDENCE_DRIFT);
  assert.ok(Array.isArray(drift.changed) && drift.changed.includes('reviews'), `drift must name the changed section: ${JSON.stringify(drift.changed)}`);

  const gapRecorded = makeFixture(t, { store: driftingStore((state) => {
    state.runGuard.recordAcceptanceGaps(RUN_ID, [{ index: 0, name: 'Fix it', status: 'skipped', reason: 'operator skipped' }]);
  }) });
  refuses(gapRecorded, CODES.ACCEPTANCE_GAP);

  const candidateMoved = makeFixture(t, { store: driftingStore(() => { commitOnCandidate(candidateMoved, 'racing'); }) });
  refuses(candidateMoved, CODES.CANDIDATE_DRIFT);

  // Benign churn under the lease is not drift.
  const benign = makeFixture(t, { store: driftingStore((state) => { state.runGuard.bump(RUN_ID, 'receipt_repair_probe'); }) });
  const { created, receipt } = benign.authority.finalize();
  assert.equal(created, true);
  assert.equal(receipt.guardRevision, benign.state.runGuard.load(RUN_ID).revision - 1, 'the receipt records the revision it was built from');
});
