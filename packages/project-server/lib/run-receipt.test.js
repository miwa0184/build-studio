'use strict';

// A1c receipt — the factory-run receipt is machine evidence that ONE admitted
// run produced ONE candidate that reached the Egress Hold with its technical
// evidence intact. It is not product acceptance and not a merge authorization.
//
// Every test here drives the real state manager, the real run guard and
// admission registry, a real git repository and the real exact-count QA gate.
// The only injected seam is the git runner, so the structural control can
// assert which git subcommands finalization is allowed to run.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const { loadConfig } = require('./config');
const { createStateManager } = require('./state');
const { createAdmissionRegistry } = require('./admission-registry');
const { createTechnicalStop, REASON_CODES } = require('./technical-stop');
const qaSuite = require('./qa-suite-run');
const { singleBundleLog } = require('./test-support/xcodebuild-log');
const { qaServerSuiteGateVerdict } = require('./api/workflow');
const receiptLib = require('./run-receipt');

const { createRunReceiptAuthority, createRunReceiptStore, RECEIPT_DIR, CODES, SCHEMA_VERSION } = receiptLib;

const RUN_ID = 'bugfix-2026-09-04T10-00-00-ab12';
const PACKET = 'docs/backlog/LS-001.md';
const EXPECTED = 56;
const ONLY_TESTING = ['StubUITests'];
const ENV_CANARY = 'RECEIPT-ENV-CANARY-7f3a9c';
const SECRET_CANARY = 'fixture-secret-canary-0000';
const CLEAN_QA = ['**Tests passed:** 56/56', '**Approved:** yes', '**Blocking:** 0', 'Executed 56 tests, with 0 failures (0 unexpected)'].join('\n');
const CLEAN_REVIEW = '## Review: Code Reviewer\n\n**Approved:** yes\n**Blocking:** 0  |  **Medium:** 1  |  **Low:** 2\n\n### Summary\nClean.';
// check-ignore and ls-files were added by the H4 repair: finalization proves
// the receipt path is ignored and untracked before it writes. Both read only.
const READ_ONLY_GIT = new Set(['rev-parse', 'merge-base', 'cat-file', 'check-ignore', 'ls-files']);

// ---------- fixture ----------

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function configYaml({ qa }) {
  const lines = [
    'name: receipt-fixture', 'port: 5199', 'docs_path: ./docs',
    'roles:', '  execution: []', '  review: []', '  standalone: []',
    'builder_strategy: role',
    `github_token: ${SECRET_CANARY}`,
    'worktree_env_files: [".env.local"]',
    'dev_commands: ["/usr/local/bin/leak-me --serve"]',
    'deployment:', '  auto_deploy: true', '  auto_tag: true', '  versioning: semver',
  ];
  if (qa !== 'none') {
    lines.push(
      'simulator:', '  destination: platform=iOS Simulator,id=STUB-DEVICE',
      '  project: Stub.xcodeproj', '  scheme: Stub', '  parallel_testing: false',
      'qa_validation:', `  only_testing: [${ONLY_TESTING.join(', ')}]`, `  expected_test_count: ${EXPECTED}`,
    );
    if (qa === 'apple') lines.push('  apple_result_authority: true', '  test_language: en');
  }
  return `${lines.join('\n')}\n`;
}

function makeRepo(t, { qa = 'none' } = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-receipt-'));
  t.after(() => { try { fs.rmSync(parent, { recursive: true, force: true }); } catch (_) {} });
  const root = path.join(parent, 'project');
  const remote = path.join(parent, 'origin.git');
  fs.mkdirSync(root, { recursive: true });
  git(parent, ['init', '--bare', '-q', remote]);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Receipt Fixture']);
  write(path.join(root, '.gitignore'), [
    '.build-studio/admission/', '.build-studio/run-guard/', '.build-studio/run-receipt/',
    '.build-studio/workflow-state.json', '.build-studio/snapshots/', '.build-studio/local.json', 'docs/agent-status.json', 'tmp/', '',
  ].join('\n'));
  write(path.join(root, '.build-studio', 'config.yaml'), configYaml({ qa }));
  write(path.join(root, PACKET), '---\nid: LS-001\ntitle: Fixture bug\ntype: Bug\nstatus: Backlog\n---\n\nFixture.\n');
  write(path.join(root, 'src', 'base.js'), 'module.exports = "base";\n');
  if (qa !== 'none') write(path.join(root, 'Stub.xcodeproj', 'project.pbxproj'), '// stub\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'initial main']);
  git(root, ['branch', '-M', 'main']);
  git(root, ['remote', 'add', 'origin', remote]);
  git(root, ['push', '-q', '-u', 'origin', 'main']);
  const mainSha = git(root, ['rev-parse', 'main']);
  git(root, ['checkout', '-q', '-b', 'fix/ls-001']);
  write(path.join(root, 'src', 'candidate.js'), 'module.exports = "candidate";\n');
  write(path.join(root, PACKET), '---\nid: LS-001\ntitle: Fixture bug\ntype: Bug\nstatus: Fixing\n---\n\nFixture.\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'fix: candidate']);
  git(root, ['push', '-q', '-u', 'origin', 'fix/ls-001']);
  const candidateSha = git(root, ['rev-parse', 'fix/ls-001']);
  return { parent, root, remote, mainSha, candidateSha, qa };
}

function registerRoot(root, { runId = RUN_ID, admittedHead, guard, taskPacket = PACKET } = {}) {
  const statePath = path.join(root, '.build-studio');
  const registry = createAdmissionRegistry({ statePath });
  const requestDigest = crypto.createHash('sha256').update(`receipt-root:${runId}:${admittedHead}`).digest('hex');
  const lineage = {
    runId, lineageId: runId, predecessorRunId: null, successorOrdinal: 0,
    registeredAt: '2026-09-04T09:00:00.000Z', admissionRequestDigest: requestDigest,
    admittedHead, admittedRepo: 'test-owner/test-repo',
  };
  guard.register(runId, { identity: { ...lineage, rootRegistry: { runId, requestDigest } } });
  registry.admit({
    nonce: `nonce-${runId}-${requestDigest.slice(0, 8)}`, runId,
    verdict: {
      kind: 'GateVerdict', version: 1, decision: 'ADMITTED', runId, repo: lineage.admittedRepo,
      head: admittedHead, taskPacket, nonce: 'n', requestDigest, admittedAt: lineage.registeredAt,
    },
    lineage, claims: [],
  });
  return { registry, requestDigest, lineage };
}

function agent(role, extra = {}) {
  return { role, window: `w-${role}`, status: 'done', cli: 'claude', model: 'opus', modelSource: 'preset', effort: 'high', completedAt: '2026-09-04T09:30:00.000Z', ...extra };
}

function suiteLog({ failed = 0, count = EXPECTED } = {}) {
  return singleBundleLog('StubUITests', count, { failed });
}

/** Persist a server-run suite the way the workflow router does after a run. */
function exactSuiteRun(fx, { failed = 0, count = EXPECTED, expected = EXPECTED, apple = null, language = 'en' } = {}) {
  const log = suiteLog({ failed, count });
  const counts = qaSuite.parseTestCounts(log);
  const result = { status: 'completed', exitCode: failed ? 65 : 0, signal: null, durationMs: 1200, counts, failureExcerpt: '' };
  const base = {
    status: 'completed', command: 'xcodebuild test -project Stub.xcodeproj -scheme Stub',
    args: ['test'], expectedTestCount: expected, startedAt: '2026-09-04T09:10:00.000Z', finishedAt: '2026-09-04T09:20:00.000Z',
  };
  const isApple = fx.qa === 'apple';
  let artifacts = null;
  let paths = {};
  if (isApple) {
    fs.mkdirSync(path.join(fx.root, 'tmp', 'qa-artifacts'), { recursive: true });
    const artifactDir = fs.mkdtempSync(path.join(fx.root, 'tmp', 'qa-artifacts', `${RUN_ID}-r1-`));
    const logPath = path.join(artifactDir, 'xcodebuild.log');
    const resultBundlePath = path.join(artifactDir, 'result.xcresult');
    const derivedDataPath = path.join(artifactDir, 'DerivedData');
    write(logPath, `${log}\n`);
    write(path.join(resultBundlePath, 'Info.plist'), 'info');
    write(path.join(resultBundlePath, 'Data', 'payload'), 'data');
    const summary = apple || { totalTestCount: count, passedTests: count - failed, failedTests: failed, skippedTests: 0, expectedFailures: 0, result: failed ? 'Failed' : 'Passed' };
    artifacts = qaSuite.collectNativeArtifacts({
      logPath, resultBundlePath, derivedDataPath, execFileSyncImpl: () => JSON.stringify(summary),
    });
    paths = { logPath, resultBundlePath, derivedDataPath, artifactDir, testLanguage: language };
  } else {
    paths = { logPath: path.join(fx.root, 'tmp', '.logs', 'qa-suite.log') };
  }
  const full = { ...result, ...(artifacts ? { artifacts } : {}) };
  const authority = {
    ...qaSuite.evaluateSuiteAuthority(full, expected, { onlyTesting: ONLY_TESTING, appleResultAuthority: isApple }),
    onlyTesting: ONLY_TESTING, parallelTesting: false, appleResultAuthority: isApple,
    ...(isApple ? { testLanguage: language } : {}),
    command: base.command,
  };
  return { ...base, ...paths, ...full, authority };
}

function workflowAtHold(fx, { park = true, requestDigest, admittedHead, currentStep = 'merge_to_main' } = {}) {
  const wf = {
    id: RUN_ID, type: 'bugfix', input: 'LS-001', itemId: 'LS-001', prdPath: PACKET,
    admission: { runId: RUN_ID, requestDigest, admittedAt: '2026-09-04T09:00:00.000Z', admittedHead },
    currentStep, branch: 'fix/ls-001', defaultBranch: 'main', reviewBranch: 'fix/ls-001',
    round: 1, feedback: [], autoAdvance: false, sessionName: 'wf-receipt',
    createdAt: '2026-09-04T09:00:00.000Z',
    steps: {
      task_execution: { status: 'completed', agents: [] },
      qa_validation: { status: 'completed', agents: [agent('QA', { model: 'sonnet', effort: null, feedback: CLEAN_QA })] },
      code_review: { status: 'completed', agents: [agent('Code Reviewer', { cli: 'codex', model: 'codex', modelSource: 'default', feedback: CLEAN_REVIEW })] },
      merge_to_main: park ? {
        status: 'blocked', code: 'LOCAL_MERGE_REMOVED', egress: 'not_installed',
        error: 'held', candidateBranch: 'fix/ls-001', defaultBranch: 'main', candidateSha: fx.candidateSha,
      } : { status: 'pending' },
      capture_learnings: { status: 'pending', agents: [] },
    },
    taskPlan: { tasks: [{ id: 1, name: 'Fix it', roles: ['Backend Dev'] }] },
    taskExecution: { currentTaskIndex: 0, taskStates: { 0: { status: 'done', acceptanceCovered: true, fixCycles: 0, agents: [agent('Backend Dev', { feedback: '**All issues addressed:** yes\n**Committed:** abc' })] } } },
  };
  if (fx.qa !== 'none') wf.steps.qa_validation.suiteRun = exactSuiteRun(fx);
  return wf;
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

/** Full fixture: repo + registered root + workflow parked at the hold. */
function makeFixture(t, options = {}) {
  const fx = makeRepo(t, options);
  const config = loadConfig(fx.root);
  const state = createStateManager(config, () => {});
  const admittedHead = options.admittedHead || fx.mainSha;
  const { registry, requestDigest } = registerRoot(fx.root, { admittedHead, guard: state.runGuard, taskPacket: options.taskPacket || PACKET });
  const wf = workflowAtHold(fx, { park: options.park !== false, requestDigest, admittedHead, currentStep: options.currentStep });
  if (options.taskPacket) wf.prdPath = options.taskPacket;
  if (typeof options.mutate === 'function') options.mutate(wf, fx);
  persistWorkflow(state, wf, { durableHold: options.durableHold !== false });
  const gitCalls = [];
  const gitRunner = (args) => {
    gitCalls.push([...args]);
    return execFileSync('git', args, { cwd: fx.root, stdio: ['pipe', 'pipe', 'pipe'] });
  };
  const authority = createRunReceiptAuthority({ config, state, qaGate: qaServerSuiteGateVerdict, git: gitRunner });
  const receiptDir = path.join(config.statePath, RECEIPT_DIR);
  return { ...fx, config, state, registry, requestDigest, admittedHead, wf, authority, gitCalls, receiptDir, receiptFile: path.join(receiptDir, `${RUN_ID}.json`) };
}

function receiptFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
}

function refuses(fx, code, options) {
  const before = receiptFiles(fx.receiptDir);
  assert.throws(() => fx.authority.finalize(options), (error) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return true;
  });
  assert.deepEqual(receiptFiles(fx.receiptDir), before, 'a refused finalization must write no receipt');
  assert.equal(fx.authority.read(), null, 'a refused finalization must leave no readable receipt');
}

// ---------- 1. admitted identity ----------

test('receipt R1 — a run with no admitted identity cannot finalize a receipt', (t) => {
  const fx = makeRepo(t);
  const config = loadConfig(fx.root);
  const state = createStateManager(config, () => {});
  const wf = workflowAtHold(fx, { requestDigest: 'a'.repeat(64), admittedHead: fx.mainSha });
  wf.id = 'legacy-run-no-admission';
  delete wf.admission;
  state.saveWorkflow(wf);
  const authority = createRunReceiptAuthority({ config, state, qaGate: qaServerSuiteGateVerdict });
  assert.throws(() => authority.finalize(), (e) => e.code === CODES.RUN_NOT_ADMITTED);
  assert.equal(fs.existsSync(path.join(config.statePath, RECEIPT_DIR)), false);
  assert.equal(authority.read(), null);
});

test('receipt R1 — a registered run whose guard is gone or whose workflow disagrees with its admission refuses', (t) => {
  const fx = makeFixture(t);
  fs.unlinkSync(fx.state.runGuard.fileFor(RUN_ID));
  refuses(fx, CODES.RUN_UNVERIFIABLE);

  const other = makeFixture(t, {
    mutate: (wf) => { wf.admission.admittedHead = 'c'.repeat(40); },
  });
  refuses(other, CODES.WORKFLOW_MISMATCH);
});

// ---------- 2. candidate binding ----------

test('receipt R2 — candidate drift after the hold refuses and writes no receipt', (t) => {
  const fx = makeFixture(t);
  write(path.join(fx.root, 'src', 'late.js'), 'module.exports = "late";\n');
  git(fx.root, ['add', '-A']);
  git(fx.root, ['commit', '-q', '-m', 'late commit after hold']);
  refuses(fx, CODES.CANDIDATE_DRIFT);
});

test('receipt R2 — a caller-stated candidate sha that is not the branch tip refuses', (t) => {
  const fx = makeFixture(t);
  refuses(fx, CODES.CANDIDATE_DRIFT, { candidateSha: fx.mainSha });
  refuses(fx, CODES.CANDIDATE_DRIFT, { candidateSha: 'not-a-sha' });
});

test('receipt R2 — a candidate that does not descend from the admitted head refuses', (t) => {
  const fx = makeRepo(t);
  git(fx.root, ['checkout', '-q', '--orphan', 'elsewhere']);
  write(path.join(fx.root, 'elsewhere.txt'), 'x\n');
  git(fx.root, ['add', '-A']);
  git(fx.root, ['commit', '-q', '-m', 'unrelated history']);
  const unrelated = git(fx.root, ['rev-parse', 'HEAD']);
  git(fx.root, ['checkout', '-q', 'fix/ls-001']);
  const config = loadConfig(fx.root);
  const state = createStateManager(config, () => {});
  const { requestDigest } = registerRoot(fx.root, { admittedHead: unrelated, guard: state.runGuard });
  persistWorkflow(state, workflowAtHold(fx, { requestDigest, admittedHead: unrelated }));
  const authority = createRunReceiptAuthority({ config, state, qaGate: qaServerSuiteGateVerdict });
  assert.throws(() => authority.finalize(), (e) => e.code === CODES.CANDIDATE_NOT_DESCENDED);
  assert.equal(authority.read(), null);
});

test('receipt R2 — a packet that is not committed at the candidate refuses', (t) => {
  // Admitted against a packet path that only ever existed in a working tree.
  const fx = makeFixture(t, { taskPacket: 'docs/backlog/NOT-COMMITTED.md' });
  refuses(fx, CODES.PACKET_NOT_COMMITTED);
  const mismatch = makeFixture(t, { mutate: (wf) => { wf.prdPath = 'src/base.js'; } });
  refuses(mismatch, CODES.PACKET_MISMATCH);
});

// ---------- 3. terminal and coverage authority ----------

test('receipt R3 — a technically stopped run refuses', (t) => {
  const fx = makeFixture(t);
  const stop = createTechnicalStop({ reasonCode: REASON_CODES.BLOCKED_TASKS, runId: RUN_ID, step: 'task_execution', tasks: [{ index: 0, name: 'Fix it', reason: 'blocked' }], evidence: ['fixture'] });
  fx.state.recordTechnicalStop(fx.state.loadWorkflow(), stop);
  refuses(fx, CODES.RUN_STOPPED);
});

test('receipt R3 — an acceptance gap in the run aggregate refuses', (t) => {
  const fx = makeFixture(t);
  fx.state.runGuard.recordAcceptanceGaps(RUN_ID, [{ index: 0, name: 'Fix it', status: 'skipped', reason: 'operator skipped' }]);
  refuses(fx, CODES.ACCEPTANCE_GAP);
});

test('receipt R3 — a run that has not reached the Egress Hold refuses', (t) => {
  const early = makeFixture(t, { currentStep: 'code_review', mutate: (wf) => { wf.steps.code_review.status = 'running'; wf.steps.merge_to_main = { status: 'pending' }; } });
  refuses(early, CODES.NOT_AT_EGRESS_HOLD);
  const skippedReview = makeFixture(t, { mutate: (wf) => { wf.steps.code_review.status = 'skipped'; } });
  refuses(skippedReview, CODES.NOT_AT_EGRESS_HOLD);
  const wrongType = makeFixture(t, { mutate: (wf) => { wf.type = 'review'; } });
  refuses(wrongType, CODES.WORKFLOW_TYPE);
});

// ---------- 4. QA authority ----------

for (const qa of ['exact', 'apple']) {
  test(`receipt R4 (${qa}) — missing, failed, count-stale and drifted server QA authority refuse`, (t) => {
    const missing = makeFixture(t, { qa, mutate: (wf) => { delete wf.steps.qa_validation.suiteRun; } });
    refuses(missing, CODES.QA_AUTHORITY_REFUSED);
    assert.throws(() => missing.authority.finalize(), (e) => e.qaCode === 'QA_SERVER_SUITE_AUTHORITY_MISSING');

    const failed = makeFixture(t, { qa, mutate: (wf, f) => { wf.steps.qa_validation.suiteRun = exactSuiteRun(f, { failed: 1 }); } });
    assert.throws(() => failed.authority.finalize(), (e) => e.code === CODES.QA_AUTHORITY_REFUSED && e.qaCode === 'QA_TESTS_FAILED');
    assert.equal(failed.authority.read(), null);

    const stale = makeFixture(t, { qa, mutate: (wf, f) => { wf.steps.qa_validation.suiteRun = exactSuiteRun(f, { count: EXPECTED - 1, expected: EXPECTED - 1 }); } });
    assert.throws(() => stale.authority.finalize(), (e) => e.code === CODES.QA_AUTHORITY_REFUSED && e.qaCode === 'QA_SERVER_SUITE_AUTHORITY_STALE');
    assert.equal(stale.authority.read(), null);

    const drifted = makeFixture(t, { qa, mutate: (wf) => { wf.steps.qa_validation.suiteRun.authority.actualTestCount = EXPECTED + 1; } });
    assert.throws(() => drifted.authority.finalize(), (e) => e.code === CODES.QA_AUTHORITY_REFUSED && e.qaCode === 'QA_SERVER_SUITE_AUTHORITY_DRIFT');
    assert.equal(drifted.authority.read(), null);
  });
}

test('receipt R4 (apple) — language mismatch, stdout/xcresult disagreement and artifact tampering refuse', (t) => {
  const language = makeFixture(t, { qa: 'apple', mutate: (wf, f) => { wf.steps.qa_validation.suiteRun = exactSuiteRun(f, { language: 'sv' }); } });
  assert.throws(() => language.authority.finalize(), (e) => e.code === CODES.QA_AUTHORITY_REFUSED && e.qaCode === 'QA_SERVER_SUITE_LANGUAGE_STALE');

  const contradiction = makeFixture(t, { qa: 'apple', mutate: (wf, f) => {
    wf.steps.qa_validation.suiteRun = exactSuiteRun(f, { apple: { totalTestCount: EXPECTED, passedTests: EXPECTED - 1, failedTests: 1, skippedTests: 0, expectedFailures: 0, result: 'Failed' } });
  } });
  assert.throws(() => contradiction.authority.finalize(), (e) => e.code === CODES.QA_AUTHORITY_REFUSED && e.qaCode === 'QA_APPLE_STDOUT_CONTRADICTION');
  assert.equal(contradiction.authority.read(), null);

  // The persisted digests still agree with each other, but the bundle on disk
  // no longer matches them: the evidence the receipt would vouch for is gone.
  const tampered = makeFixture(t, { qa: 'apple' });
  const run = tampered.state.loadWorkflow().steps.qa_validation.suiteRun;
  fs.writeFileSync(path.join(run.resultBundlePath, 'Data', 'payload'), 'tampered');
  refuses(tampered, CODES.QA_ARTIFACT_MISMATCH);

  // The persisted authority claims a digest its own artifact record disagrees
  // with; the exact-count gate does not compare digests, the receipt must.
  const inconsistent = makeFixture(t, { qa: 'apple', mutate: (wf) => { wf.steps.qa_validation.suiteRun.authority.logSha256 = 'e'.repeat(64); } });
  refuses(inconsistent, CODES.QA_ARTIFACT_MISMATCH);

  const removed = makeFixture(t, { qa: 'apple' });
  fs.rmSync(removed.state.loadWorkflow().steps.qa_validation.suiteRun.resultBundlePath, { recursive: true, force: true });
  refuses(removed, CODES.QA_ARTIFACT_MISMATCH);
});

test('receipt R4 — without exact-count authority an operator QA override or a missing QA verdict refuses', (t) => {
  const override = makeFixture(t, { mutate: (wf) => {
    wf.steps.qa_validation.overrides = [{ at: '2026-09-04T09:15:00.000Z', step: 'qa_validation', round: 1, reason: 'operator override of strict QA gate' }];
  } });
  refuses(override, CODES.QA_OPERATOR_OVERRIDE);
  const noVerdict = makeFixture(t, { mutate: (wf) => { wf.steps.qa_validation.agents = []; } });
  refuses(noVerdict, CODES.EVIDENCE_AMBIGUOUS);
});

// ---------- 5. review evidence ----------

test('receipt R5 — unresolved blocking review evidence refuses', (t) => {
  const blocking = makeFixture(t, { mutate: (wf) => {
    wf.steps.code_review.agents[0].feedback = '**Approved:** yes\n**Blocking:** 2  |  **Medium:** 0  |  **Low:** 0';
  } });
  refuses(blocking, CODES.REVIEW_BLOCKING);
  const notApproved = makeFixture(t, { mutate: (wf) => {
    wf.steps.code_review.agents[0].feedback = '**Approved:** no\n**Blocking:** 0  |  **Medium:** 0  |  **Low:** 0';
  } });
  refuses(notApproved, CODES.REVIEW_BLOCKING);
  const operatorOnly = makeFixture(t, { mutate: (wf) => {
    wf.steps.code_review.agents[0].feedbackProvenance = 'operator_force_complete';
    wf.steps.code_review.agents[0].feedback = '**Outcome:** force_completed\n\n```\n**Approved:** yes\n**Blocking:** 0\n```';
  } });
  refuses(operatorOnly, CODES.EVIDENCE_AMBIGUOUS);
  const unparsable = makeFixture(t, { mutate: (wf) => { wf.steps.code_review.agents[0].feedback = 'Looks fine to me.'; } });
  refuses(unparsable, CODES.EVIDENCE_AMBIGUOUS);
});

// ---------- 6. effective configuration ----------

test('receipt R6 — the projection records effective supported local overrides', (t) => {
  const fx = makeFixture(t);
  // Policy such as builder_strategy is tracked in config.yaml; local.json may
  // only contribute the machine-local categories the resolver consumes.
  write(path.join(fx.root, '.build-studio', 'local.json'), JSON.stringify({
    cli: { default: 'codex' },
    agent_defaults: { effort: 'high' },
  }));
  const config = loadConfig(fx.root);
  const authority = createRunReceiptAuthority({ config, state: fx.state, qaGate: qaServerSuiteGateVerdict });
  const { receipt } = authority.finalize();
  assert.equal(receipt.config.builderStrategy, 'role');
  assert.equal(receipt.config.cli.default, 'codex');
  assert.equal(receipt.config.review.finalReviewEffort, 'high');
  assert.equal(receipt.config.schemaVersion, 1);
  assert.match(receipt.configDigest, /^[0-9a-f]{64}$/);
  const executed = Object.fromEntries(receipt.config.executedSteps.map((s) => [s.step, s]));
  assert.deepEqual(executed.task_execution.agents[0], { task: 0, role: 'Backend Dev', cli: 'claude', model: 'opus', modelSource: 'preset', effort: 'high' });
  assert.deepEqual(executed.qa_validation.agents[0], { task: null, role: 'QA', cli: 'claude', model: 'sonnet', modelSource: 'preset', effort: null });
  assert.deepEqual(executed.code_review.agents[0], { task: null, role: 'Code Reviewer', cli: 'codex', model: 'codex', modelSource: 'default', effort: 'high' });
  assert.equal(receipt.config.egress.prEgress, 'disabled');
  assert.equal(receipt.config.egress.localMerge, 'removed');
  assert.equal(receipt.config.egress.legacyAutoDeploy, true, 'the inert legacy preference is recorded as resolved, not as egress');
  assert.equal(receipt.config.qa.expectedTestCount, null);
});

test('receipt R6 — a yaml builder_strategy the resolver honours is recorded as effective', (t) => {
  const fx = makeRepo(t);
  const yaml = fs.readFileSync(path.join(fx.root, '.build-studio', 'config.yaml'), 'utf8').replace('builder_strategy: role', 'builder_strategy: goal');
  fs.writeFileSync(path.join(fx.root, '.build-studio', 'config.yaml'), yaml);
  const config = loadConfig(fx.root);
  const state = createStateManager(config, () => {});
  const { requestDigest } = registerRoot(fx.root, { admittedHead: fx.mainSha, guard: state.runGuard });
  persistWorkflow(state, workflowAtHold(fx, { requestDigest, admittedHead: fx.mainSha }));
  const authority = createRunReceiptAuthority({ config, state, qaGate: qaServerSuiteGateVerdict });
  assert.equal(authority.finalize().receipt.config.builderStrategy, 'goal');
});

// ---------- 7. no secrets, env or private paths ----------

test('receipt R7 — environment, secrets, raw config and local paths never enter the receipt', (t) => {
  process.env.BUILD_STUDIO_RECEIPT_CANARY = ENV_CANARY;
  t.after(() => { delete process.env.BUILD_STUDIO_RECEIPT_CANARY; });
  const fx = makeFixture(t, { qa: 'apple' });
  const { receipt } = fx.authority.finalize();
  const raw = fs.readFileSync(fx.receiptFile, 'utf8');
  for (const forbidden of [ENV_CANARY, SECRET_CANARY, fx.root, fx.config.statePath, fx.config.docsPath, fx.config.worktreesPath, fx.config.logsPath, '/usr/local/bin/leak-me', '.env.local', 'tmp/qa-artifacts', os.homedir()]) {
    assert.equal(raw.includes(forbidden), false, `receipt leaks ${forbidden}`);
  }
  const walk = (value, trail) => {
    if (Array.isArray(value)) return value.forEach((v, i) => walk(v, `${trail}[${i}]`));
    if (value && typeof value === 'object') {
      for (const [key, v] of Object.entries(value)) {
        assert.doesNotMatch(key, /token|secret|password|api[_-]?key|\benv\b|environ/i, `forbidden key ${trail}.${key}`);
        walk(v, `${trail}.${key}`);
      }
      return;
    }
    if (typeof value === 'string') {
      assert.equal(path.isAbsolute(value), false, `absolute path at ${trail}: ${value}`);
      assert.doesNotMatch(value, /^[A-Za-z]:\\/, `windows path at ${trail}`);
    }
  };
  walk(receipt, 'receipt');
  assert.equal(receipt.qa.artifacts.verifiedOnDisk, true);
  assert.equal('logPath' in receipt.qa, false);
  assert.equal('artifactDir' in receipt.qa, false);
  assert.equal('command' in receipt.qa, false);
  assert.deepEqual(Object.keys(receipt.config).sort(), ['builderStrategy', 'cli', 'egress', 'executedSteps', 'preset', 'qa', 'review', 'schemaVersion']);
});

// Frozen-head review, HIGH B: projection strings were cut to 200 characters
// before assertProjectionSafe ran, so two different effective values sharing a
// 200-character prefix produced one projection and one configDigest.
test('receipt R7 — two effective values that share a 200-character prefix never collapse into one projection', (t) => {
  const prefix = 'v'.repeat(200);
  const values = [`${prefix}1`, `${prefix}2`];
  assert.notEqual(values[0], values[1]);
  assert.equal(values[0].slice(0, 200), values[1].slice(0, 200));

  const outcomes = values.map((versioning) => {
    try {
      return { configDigest: receiptLib.buildConfigProjection({ deployment: { versioning } }, { steps: {} }).configDigest };
    } catch (error) {
      return { refused: error.message };
    }
  });
  assert.ok(outcomes.every((outcome) => outcome.refused),
    `an over-long effective value must refuse instead of projecting; got ${JSON.stringify(outcomes)}`);

  for (const versioning of values) {
    const fx = makeRepo(t);
    const configPath = path.join(fx.root, '.build-studio', 'config.yaml');
    fs.writeFileSync(configPath, fs.readFileSync(configPath, 'utf8').replace('  versioning: semver', `  versioning: ${versioning}`));
    const config = loadConfig(fx.root);
    assert.equal(config.deployment.versioning, versioning, 'the resolver must carry the full effective value');
    const state = createStateManager(config, () => {});
    const { requestDigest } = registerRoot(fx.root, { admittedHead: fx.mainSha, guard: state.runGuard });
    persistWorkflow(state, workflowAtHold(fx, { requestDigest, admittedHead: fx.mainSha }));
    const authority = createRunReceiptAuthority({ config, state, qaGate: qaServerSuiteGateVerdict });
    const receiptDir = path.join(config.statePath, RECEIPT_DIR);
    assert.throws(() => authority.finalize(), (error) => error.code === CODES.PROJECTION_UNSAFE);
    assert.deepEqual(receiptFiles(receiptDir), [], 'a refused projection must write no receipt');
    assert.equal(authority.read(), null);
  }
});

// ---------- 8. idempotency and concurrency ----------

test('receipt R8 — the finalized receipt is bound, digested and byte-identical on a duplicate finalization', (t) => {
  const fx = makeFixture(t, { qa: 'apple' });
  const first = fx.authority.finalize();
  assert.equal(first.created, true);
  const bytes = fs.readFileSync(fx.receiptFile);
  const r = first.receipt;
  assert.equal(r.schemaVersion, SCHEMA_VERSION);
  assert.equal(r.kind, 'FactoryRunReceipt');
  assert.equal(r.runId, RUN_ID);
  assert.equal(r.laneId, 'default');
  assert.equal(r.identity.admittedHead, fx.mainSha);
  assert.equal(r.identity.admittedRepo, 'test-owner/test-repo');
  assert.equal(r.identity.admissionRequestDigest, fx.requestDigest);
  assert.equal(r.identity.lineageId, RUN_ID);
  assert.equal(r.candidate.branch, 'fix/ls-001');
  assert.equal(r.candidate.sha, fx.candidateSha);
  assert.equal(r.candidate.heldSha, fx.candidateSha);
  assert.equal(r.candidate.descendsFromAdmittedHead, true);
  assert.equal(r.candidate.base.branch, 'main');
  assert.equal(r.candidate.base.sha, fx.mainSha);
  assert.equal(r.packet.path, PACKET);
  assert.equal(r.packet.blobOid, git(fx.root, ['rev-parse', `${fx.candidateSha}:${PACKET}`]));
  assert.equal(r.packet.contentSha256, crypto.createHash('sha256')
    .update(execFileSync('git', ['cat-file', 'blob', `${fx.candidateSha}:${PACKET}`], { cwd: fx.root })).digest('hex'));
  assert.equal(r.hold.step, 'merge_to_main');
  assert.equal(r.hold.code, 'LOCAL_MERGE_REMOVED');
  assert.equal(r.hold.egress, 'not_installed');
  assert.equal(r.qa.mode, 'server_apple_result');
  assert.equal(r.qa.code, 'QA_APPLE_RESULT_VERIFIED');
  assert.equal(r.qa.expectedTestCount, EXPECTED);
  assert.equal(r.qa.actualTestCount, EXPECTED);
  assert.equal(r.qa.testLanguage, 'en');
  assert.match(r.qa.artifacts.logSha256, /^[0-9a-f]{64}$/);
  assert.match(r.qa.artifacts.resultBundleManifestDigest, /^[0-9a-f]{64}$/);
  assert.equal(r.qa.artifacts.resultBundleFileCount, 2);
  assert.deepEqual(r.reviews.map((s) => s.step), ['qa_validation', 'code_review']);
  assert.deepEqual(r.reviews[1].agents[0], {
    role: 'Code Reviewer', provenance: 'agent', approved: true, blocking: 0, medium: 1, low: 2,
    feedbackSha256: crypto.createHash('sha256').update(CLEAN_REVIEW).digest('hex'),
  });
  assert.equal(r.productAcceptance, false);
  assert.equal(r.mergeAuthorization, false);
  assert.equal(r.remoteEgress, 'disabled');
  assert.equal(r.supersedes, null);
  assert.match(r.evidenceDigest, /^[0-9a-f]{64}$/);
  assert.match(r.receiptDigest, /^[0-9a-f]{64}$/);
  assert.equal(r.receiptDigest, receiptLib.receiptDigestOf(r));

  const second = fx.authority.finalize();
  assert.equal(second.created, false);
  assert.deepEqual(second.receipt, first.receipt);
  assert.ok(fs.readFileSync(fx.receiptFile).equals(bytes), 'a duplicate finalization must not rewrite the file');
  assert.deepEqual(fx.authority.read(), first.receipt);
  const verified = fx.authority.verify();
  assert.equal(verified.verification.matchesReceipt, true);
  assert.equal(verified.verification.candidateSha, fx.candidateSha);
});

test('receipt R8 — concurrent cross-process finalization yields exactly one receipt', async (t) => {
  const fx = makeFixture(t, { qa: 'exact' });
  const script = `
    const { loadConfig } = require(${JSON.stringify(path.join(__dirname, 'config.js'))});
    const { createStateManager } = require(${JSON.stringify(path.join(__dirname, 'state.js'))});
    const { qaServerSuiteGateVerdict } = require(${JSON.stringify(path.join(__dirname, 'api', 'workflow.js'))});
    const { createRunReceiptAuthority } = require(${JSON.stringify(path.join(__dirname, 'run-receipt.js'))});
    const root = process.argv[1];
    const config = loadConfig(root);
    const state = createStateManager(config, () => {});
    const authority = createRunReceiptAuthority({ config, state, qaGate: qaServerSuiteGateVerdict, lockTimeoutMs: 8000 });
    try {
      const out = authority.finalize();
      process.stdout.write(JSON.stringify({ created: out.created, digest: out.receipt.receiptDigest }));
    } catch (e) {
      process.stdout.write(JSON.stringify({ error: e.code || e.message }));
      process.exitCode = 3;
    }
  `;
  const runChild = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, fx.root], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', () => {
      try { resolve(JSON.parse(out)); } catch (_) { reject(new Error(`child produced no result: ${out} ${err}`)); }
    });
  });
  const results = await Promise.all([runChild(), runChild(), runChild()]);
  const errors = results.filter((r) => r.error);
  for (const e of errors) assert.equal(e.error, CODES.BUSY, `unexpected child failure ${JSON.stringify(e)}`);
  const successes = results.filter((r) => !r.error);
  assert.ok(successes.length >= 1, `no child finalized: ${JSON.stringify(results)}`);
  assert.equal(successes.filter((r) => r.created).length, 1, `exactly one child may create: ${JSON.stringify(results)}`);
  assert.equal(new Set(successes.map((r) => r.digest)).size, 1, 'every successful child must hold the same receipt');
  assert.deepEqual(receiptFiles(fx.receiptDir), [`${RUN_ID}.json`]);
  assert.equal(fx.authority.read().receiptDigest, successes[0].digest);
});

// ---------- 9. durability ----------

test('receipt R9 — snapshot restore, a stale workflow write, a restart and a changed workflow cannot remove or regress a finalized receipt', (t) => {
  const fx = makeFixture(t, { qa: 'exact', durableHold: false });
  // Produce a pre-hold snapshot the way the state manager does: a step change.
  const pre = fx.state.loadWorkflow();
  pre.currentStep = 'code_review';
  pre.steps.code_review.status = 'running';
  pre.steps.merge_to_main = { status: 'pending' };
  fx.state.saveWorkflow(pre);
  const parked = workflowAtHold(fx, { requestDigest: fx.requestDigest, admittedHead: fx.admittedHead });
  parked.steps.qa_validation.suiteRun = fx.wf.steps.qa_validation.suiteRun;
  fx.state.recordEgressHold(parked, {
    candidateBranch: parked.steps.merge_to_main.candidateBranch,
    candidateSha: parked.steps.merge_to_main.candidateSha,
    defaultBranch: parked.steps.merge_to_main.defaultBranch,
  });
  const snapshot = fx.state.listSnapshots().find((s) => s.file.includes('step-code_review'));
  assert.ok(snapshot, 'fixture must have a pre-hold snapshot');

  const { receipt } = fx.authority.finalize();
  const bytes = fs.readFileSync(fx.receiptFile);

  // A stale whole-object write that predates the receipt.
  const stale = JSON.parse(JSON.stringify(parked));
  stale.steps.merge_to_main = { status: 'pending' };
  fx.state.saveWorkflow(stale);
  assert.ok(fs.readFileSync(fx.receiptFile).equals(bytes));

  // Snapshot restore cannot roll the workflow back before the durable hold.
  fx.state.restoreSnapshot(snapshot.file);
  assert.equal(fx.state.loadWorkflow().currentStep, 'merge_to_main');
  assert.equal(fx.state.loadWorkflow().steps.merge_to_main.candidateSha, fx.candidateSha);
  assert.ok(fs.readFileSync(fx.receiptFile).equals(bytes));
  assert.throws(() => fx.authority.finalize(), (e) => e.code === CODES.NOT_AT_EGRESS_HOLD);
  assert.ok(fs.readFileSync(fx.receiptFile).equals(bytes), 'a refused replay after restore must not rewrite the receipt');

  // A restart: fresh state manager and authority over the same directory.
  const restarted = createRunReceiptAuthority({ config: loadConfig(fx.root), state: createStateManager(fx.config, () => {}), qaGate: qaServerSuiteGateVerdict });
  assert.deepEqual(restarted.read(RUN_ID), receipt);

  // Different evidence for the same run can never rewrite the receipt.
  const changed = fx.state.loadWorkflow();
  Object.assign(changed, parked, { steps: { ...parked.steps } });
  changed.steps.code_review = { ...parked.steps.code_review, agents: [agent('Code Reviewer', { feedback: CLEAN_REVIEW, cli: 'opencode', model: 'opencode:x/y' })] };
  fx.state.saveWorkflow(changed);
  assert.throws(() => fx.authority.finalize(), (e) => e.code === CODES.CONFLICT);
  assert.ok(fs.readFileSync(fx.receiptFile).equals(bytes));

  // Tampering is detected and never repaired in place.
  const doc = JSON.parse(fs.readFileSync(fx.receiptFile, 'utf8'));
  doc.candidate.sha = 'f'.repeat(40);
  fs.writeFileSync(fx.receiptFile, JSON.stringify(doc, null, 2));
  assert.throws(() => fx.authority.read(RUN_ID), (e) => e.code === CODES.UNREADABLE);
  fx.state.saveWorkflow(parked);
  assert.throws(() => fx.authority.finalize(), (e) => e.code === CODES.UNREADABLE);
  assert.equal(JSON.parse(fs.readFileSync(fx.receiptFile, 'utf8')).candidate.sha, 'f'.repeat(40), 'the tampered file is evidence and stays');
});

test('receipt R9 — the store refuses to overwrite and validates exact schema on read', (t) => {
  const statePath = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-receipt-store-'));
  t.after(() => { try { fs.rmSync(statePath, { recursive: true, force: true }); } catch (_) {} });
  const store = createRunReceiptStore({ statePath });
  assert.equal(store.load('nothing'), null);
  fs.mkdirSync(path.join(statePath, RECEIPT_DIR), { recursive: true });
  fs.writeFileSync(store.fileFor('broken'), '{ "schemaVersion": 1, "runId": "broken" }');
  assert.throws(() => store.load('broken'), (e) => e.code === CODES.UNREADABLE);
  fs.writeFileSync(store.fileFor('garbage'), 'not json');
  assert.throws(() => store.load('garbage'), (e) => e.code === CODES.UNREADABLE);
  assert.throws(() => store.finalize('garbage', {}), (e) => e.code === CODES.UNREADABLE);
  assert.equal(fs.readFileSync(store.fileFor('garbage'), 'utf8'), 'not json');
});

// ---------- 10 + 11. hold and structural control ----------

test('receipt R11 — finalization runs only read-only git subcommands and changes no ref', (t) => {
  const fx = makeFixture(t, { qa: 'apple' });
  const before = refsSnapshot(fx);
  fx.authority.finalize();
  fx.authority.verify();
  assert.ok(fx.gitCalls.length > 0);
  for (const args of fx.gitCalls) {
    assert.ok(READ_ONLY_GIT.has(args[0]), `finalization ran git ${args.join(' ')}`);
  }
  assert.deepEqual(refsSnapshot(fx), before);
  assert.equal(git(fx.root, ['status', '--porcelain']), '', 'finalization must not dirty the managed tree');
});

test('receipt R11 — the receipt modules invoke only read-only git subcommands and no remote, merge, tag, checkout or branch-delete path', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
  const authority = read('run-receipt.js');
  // Every git invocation in the authority is an argument-list call through
  // one runner; each call site names a read-only subcommand.
  const callSites = [...authority.matchAll(/runGit\(\[\s*'([a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(callSites.length >= 3, 'the structural control must see the git call sites');
  for (const sub of callSites) assert.ok(READ_ONLY_GIT.has(sub), `run-receipt.js invokes git ${sub}`);
  assert.equal((authority.match(/execFileSync\(/g) || []).length, 1, 'one git runner, no other process spawn');
  assert.match(authority, /execFileSync\('git', \['--no-optional-locks', \.\.\.args\]/);
  for (const source of [authority, read('authority-store.js'), read(path.join('api', 'run-receipt.js'))]) {
    for (const pattern of [/--delete/, /--no-ff/, /\bgh\b/, /pulls?\//, /execSync\(/, /\bspawn(Sync)?\(/, /\bexec\(/, /['"]origin['"]/]) {
      assert.doesNotMatch(source, pattern);
    }
  }
  for (const file of ['authority-store.js', path.join('api', 'run-receipt.js')]) {
    assert.doesNotMatch(read(file), /child_process/, `${file} must not spawn processes`);
  }
});

function refsSnapshot(fx) {
  const refs = (cwd, prefix) => {
    const out = git(cwd, ['for-each-ref', '--format=%(refname):%(objectname)', prefix]);
    return out ? out.split('\n').sort() : [];
  };
  return {
    head: git(fx.root, ['rev-parse', 'HEAD']),
    branch: git(fx.root, ['branch', '--show-current']),
    local: refs(fx.root, 'refs/heads'),
    tags: refs(fx.root, 'refs/tags'),
    remote: refs(fx.remote, 'refs/heads'),
    remoteTags: refs(fx.remote, 'refs/tags'),
  };
}
