'use strict';

// F2 — every server-run failure mode of the exact-count QA authority is
// pinned at the workflow boundary, not at a helper.
//
// With `qa_validation.expected_test_count` configured, the persisted server
// verdict is the only thing that can approve qa_validation. A QA agent's clean
// report, an operator's {"override": true}, and the auto-advance tick must all
// be unable to move the run past a blocked verdict. Four blocked outcomes are
// exercised here: QA_XCODEBUILD_EXIT_NONZERO, QA_SERVER_SUITE_TIMEOUT,
// QA_SERVER_SUITE_UNAVAILABLE and QA_SUITE_INCOMPLETE, plus the missing-authority
// case a crashed server leaves behind.
//
// The exit-status and unavailable cases run the real launch path (a stub
// xcodebuild on PATH, a stub CLI so the launch reaches the prompt seam, tmux
// stubbed). The timeout is produced by the real startSuiteRun against a stub
// that never finishes, then persisted exactly as the server persists it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const qaSuite = require('../qa-suite-run');
const { git, stubBinDir, withPath, mountWorkflow, waitFor } = require('../test-support/workflow-http');

const EXPECTED = 56;
const ONLY_TESTING = ['StubUITests'];
const CLEAN_APPROVAL = [
  '**Tests passed:** 56/56',
  '**Approved:** yes',
  '**Blocking:** 0',
  'Executed 56 tests, with 0 failures (0 unexpected)',
].join('\n');
/** The tick fires 500ms after auto-advance is enabled. */
const TICK_SETTLE_MS = 1500;

function exactQaRepo({ discoverable = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exact-qa-'));
  const simulator = [
    'simulator:',
    '  destination: platform=iOS Simulator,id=STUB-DEVICE',
    ...(discoverable ? ['  project: Stub.xcodeproj', '  scheme: Stub'] : []),
    '  parallel_testing: false',
  ];
  write(path.join(root, '.build-studio', 'config.yaml'), [
    'name: exact-qa-fixture', 'port: 5199', 'docs_path: ./docs',
    'roles:',
    '  execution:',
    '    - role: iOS Dev', '      skill: ios_dev', '      branch_prefix: ios',
    '  review: []',
    '  standalone:',
    '    - role: QA', '      skill: qa', '      command: qa.md',
    ...simulator,
    'qa_validation:',
    `  only_testing: [${ONLY_TESTING.join(', ')}]`,
    `  expected_test_count: ${EXPECTED}`,
    '',
  ].join('\n'));
  write(path.join(root, '.gitignore'), '.build-studio/workflow-state.json\n.build-studio/run-guard/\n.build-studio/admission/\n.build-studio/snapshots/\ntmp/\n');
  write(path.join(root, 'docs', 'backlog', 'LS-001.md'),
    '---\nid: LS-001\ntitle: Fixture bug\ntype: Bug\nstatus: Fixing\n---\n\nFixture.\n');
  if (discoverable) write(path.join(root, 'Stub.xcodeproj', 'project.pbxproj'), '// stub\n');
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Exact QA']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'fixture']);
  git(root, ['branch', '-M', 'main']);
  git(root, ['checkout', '-q', '-b', 'fix/ls-001']);
  return root;
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function qaWorkflow(overrides = {}) {
  return {
    id: 'exact-qa-run', type: 'bugfix', input: 'LS-001', itemId: 'LS-001',
    prdPath: 'docs/backlog/LS-001.md', currentStep: 'qa_validation',
    branch: 'fix/ls-001', defaultBranch: 'main', reviewBranch: 'fix/ls-001',
    round: 1, feedback: [], autoAdvance: false, sessionName: 'wf-exact-qa',
    createdAt: new Date().toISOString(),
    steps: {
      task_execution: { status: 'completed', agents: [] },
      qa_validation: { status: 'pending', agents: [] },
      code_review: { status: 'pending', agents: [] },
      merge_to_main: { status: 'pending' },
      capture_learnings: { status: 'pending', agents: [] },
    },
    taskExecution: { currentTaskIndex: 0, taskStates: { 0: { status: 'done', agents: [] } } },
    ...overrides,
  };
}

/** A QA agent that already reported a clean verdict, with agent provenance. */
function cleanQaAgent() {
  return { role: 'QA', window: 'qa-validate', status: 'done', feedback: CLEAN_APPROVAL, completedAt: new Date().toISOString() };
}

/** The shape the server persists after a run: raw result plus its authority. */
function persistedRun(result, command = 'xcodebuild test -project Stub.xcodeproj -scheme Stub') {
  return {
    ...result,
    command,
    authority: {
      ...qaSuite.evaluateSuiteAuthority(result, EXPECTED),
      onlyTesting: ONLY_TESTING, parallelTesting: false, command,
    },
    finishedAt: new Date().toISOString(),
  };
}

function successfulLog() {
  const lines = [];
  for (let i = 1; i <= EXPECTED; i++) lines.push(`echo "Test Case '-[StubUITests.Cases test${i}]' passed (0.1 seconds)."`);
  lines.push(`echo "Executed ${EXPECTED} tests, with 0 failures (0 unexpected) in 1.0 (1.1) seconds"`);
  lines.push('echo "** TEST SUCCEEDED **"');
  return lines.join('\n');
}

function clean(root) { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} }

/**
 * Approve (plain and with operator override) must refuse with `code`; the
 * auto-advance tick must not approve; and the fix loop the tick routes into
 * must not walk the run past qa_validation on a zero-task plan either. Only a
 * fresh exact server run may replace a blocked verdict.
 */
async function assertNoBypass(server, code) {
  const plain = await server.request('POST', '/api/workflow/advance', { action: 'approve' });
  assert.equal(plain.status, 400, JSON.stringify(plain.body));
  assert.equal(plain.body.qaServerAuthority && plain.body.qaServerAuthority.code, code, JSON.stringify(plain.body));

  const override = await server.request('POST', '/api/workflow/advance', { action: 'approve', override: true, note: 'known flake' });
  assert.equal(override.status, 400, JSON.stringify(override.body));
  assert.equal(override.body.qaServerAuthority && override.body.qaServerAuthority.code, code);

  let wf = server.state.loadWorkflow();
  assert.equal(wf.currentStep, 'qa_validation');
  assert.notEqual(wf.steps.qa_validation.status, 'completed');
  assert.equal(wf.steps.qa_validation.overrides, undefined, 'no override may be recorded against a server-blocked verdict');

  // Phase 1 — the tick at qa_validation. It must not approve.
  server.advanceActions.length = 0;
  await tick(server);
  wf = server.state.loadWorkflow();
  assert.ok(server.advanceActions.length > 0, 'the tick must have fired and decided something, or this proves nothing');
  assert.ok(!server.advanceActions.includes('approve'), `the tick approved a blocked verdict: ${server.advanceActions.join(',')}`);
  assertNotPastQa(wf);

  // Phase 2 — if the tick routed into the fix loop, a zero-task plan plus the
  // QA agent's clean report is the classic shortcut back to the main line.
  // With the server verdict blocked, that shortcut must be refused, by hand
  // and by the tick.
  if (wf.currentStep === 'fix_plan') {
    await waitFor(() => (server.state.loadWorkflow().steps.fix_plan.agents || []).length > 0, { label: 'fix planner launched' });
    const planner = await server.request('POST', '/api/workflow/feedback', {
      role: 'Fix Planner', step: 'fix_plan', feedback: 'No fixes needed.\n\n```json\n{ "tasks": [] }\n```',
    });
    assert.equal(planner.status, 200, JSON.stringify(planner.body));

    const shortcut = await server.request('POST', '/api/workflow/advance', { action: 'approve' });
    assert.equal(shortcut.status, 400, JSON.stringify(shortcut.body));
    assert.equal(shortcut.body.qaServerAuthority && shortcut.body.qaServerAuthority.code, code, JSON.stringify(shortcut.body));
    const forced = await server.request('POST', '/api/workflow/advance', { action: 'approve', override: true, overrideReason: 'ship it' });
    assert.equal(forced.status, 400, JSON.stringify(forced.body));
    assertNotPastQa(server.state.loadWorkflow());

    server.advanceActions.length = 0;
    await tick(server);
    wf = server.state.loadWorkflow();
    assertNotPastQa(wf);
  }
}

function assertNotPastQa(wf) {
  assert.notEqual(wf.currentStep, 'code_review', 'the run must not reach the step after qa_validation');
  assert.equal(wf.steps.code_review.status, 'pending');
  assert.ok(['qa_validation', 'fix_plan'].includes(wf.currentStep), `unexpected step ${wf.currentStep}`);
}

async function tick(server) {
  const on = await server.request('POST', '/api/workflow/auto-advance', { enabled: true });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  await new Promise((r) => setTimeout(r, TICK_SETTLE_MS));
  await server.request('POST', '/api/workflow/auto-advance', { enabled: false });
}

async function mountRecording(root, wf) {
  const advanceActions = [];
  const server = await mountWorkflow(root, wf, { onAdvance: (body) => advanceActions.push(body.action) });
  server.advanceActions = advanceActions;
  return server;
}

test('F2 — QA_XCODEBUILD_EXIT_NONZERO: a green-looking log with exit 1 blocks approval, override and the tick', async () => {
  const root = exactQaRepo();
  const bin = stubBinDir(['claude', 'pgrep'], { xcodebuild: `#!/bin/sh\n${successfulLog()}\nexit 1\n` });
  const server = await mountRecording(root, qaWorkflow());
  try {
    await withPath(bin, async () => {
      const launch = await server.request('POST', '/api/workflow/advance', { action: 'launch' });
      assert.equal(launch.status, 200, JSON.stringify(launch.body));
      const authority = await waitFor(() => {
        const step = server.state.loadWorkflow().steps.qa_validation;
        return step.suiteRun && step.suiteRun.authority;
      }, { label: 'persisted suite authority' });
      assert.equal(authority.code, 'QA_XCODEBUILD_EXIT_NONZERO', JSON.stringify(authority));
      assert.equal(authority.blocked, true);
      assert.equal(authority.actualTestCount, EXPECTED);

      // The QA agent reports a clean verdict through the real feedback route.
      await waitFor(() => (server.state.loadWorkflow().steps.qa_validation.agents || []).length > 0, { label: 'QA agent launched' });
      const fb = await server.request('POST', '/api/workflow/feedback', { role: 'QA', step: 'qa_validation', feedback: CLEAN_APPROVAL });
      assert.equal(fb.status, 200, JSON.stringify(fb.body));

      await assertNoBypass(server, 'QA_XCODEBUILD_EXIT_NONZERO');
    });
  } finally { await server.close(); clean(root); clean(bin); }
});

test('F2 — QA_SERVER_SUITE_TIMEOUT: a suite killed on timeout blocks approval, override and the tick', async () => {
  const root = exactQaRepo();
  const bin = stubBinDir(['claude', 'pgrep'], {
    xcodebuild: `#!/bin/sh\necho "Test Case '-[StubUITests.Cases test1]' passed (0.1 seconds)."\nsleep 60\n`,
  });
  const run = qaSuite.startSuiteRun({
    cwd: root, args: ['test'], logPath: path.join(root, 'tmp', 'qa.log'), timeoutMs: 700,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  const result = await run.promise;
  assert.equal(result.status, 'timeout');
  const wf = qaWorkflow();
  wf.steps.qa_validation = { status: 'running', agents: [cleanQaAgent()], suiteRun: persistedRun(result) };
  assert.equal(wf.steps.qa_validation.suiteRun.authority.code, 'QA_SERVER_SUITE_TIMEOUT');
  const server = await mountRecording(root, wf);
  try {
    await withPath(bin, () => assertNoBypass(server, 'QA_SERVER_SUITE_TIMEOUT'));
  } finally { await server.close(); clean(root); clean(bin); }
});

test('F2 — QA_SERVER_SUITE_UNAVAILABLE: a suite the server could not run blocks approval, override and the tick', async () => {
  const root = exactQaRepo({ discoverable: false });
  const bin = stubBinDir(['claude', 'pgrep']);
  const server = await mountRecording(root, qaWorkflow());
  try {
    await withPath(bin, async () => {
      const launch = await server.request('POST', '/api/workflow/advance', { action: 'launch' });
      assert.equal(launch.status, 200, JSON.stringify(launch.body));
      const step = server.state.loadWorkflow().steps.qa_validation;
      assert.equal(step.suiteRun && step.suiteRun.status, 'unavailable', JSON.stringify(step.suiteRun));
      assert.equal(step.suiteRun.authority.code, 'QA_SERVER_SUITE_UNAVAILABLE');
      assert.ok((step.agents || []).length > 0, 'the QA agent is still launched to explain, never to decide');

      const fb = await server.request('POST', '/api/workflow/feedback', { role: 'QA', step: 'qa_validation', feedback: CLEAN_APPROVAL });
      assert.equal(fb.status, 200, JSON.stringify(fb.body));
      await assertNoBypass(server, 'QA_SERVER_SUITE_UNAVAILABLE');
    });
  } finally { await server.close(); clean(root); clean(bin); }
});

test('F2 — QA_SUITE_INCOMPLETE: a run that errored before completing blocks approval, override and the tick', async () => {
  const root = exactQaRepo();
  const bin = stubBinDir(['claude', 'pgrep']);
  const wf = qaWorkflow();
  const errored = { status: 'error', error: 'the run failed to start (spawn EAGAIN)', exitCode: null, counts: qaSuite.parseTestCounts('') };
  wf.steps.qa_validation = { status: 'running', agents: [cleanQaAgent()], suiteRun: persistedRun(errored) };
  assert.equal(wf.steps.qa_validation.suiteRun.authority.code, 'QA_SUITE_INCOMPLETE');
  const server = await mountRecording(root, wf);
  try {
    await withPath(bin, () => assertNoBypass(server, 'QA_SUITE_INCOMPLETE'));
  } finally { await server.close(); clean(root); clean(bin); }
});

test('F2 — a run still marked running with no persisted authority (server restarted mid-suite) cannot be approved', async () => {
  const root = exactQaRepo();
  const bin = stubBinDir(['claude', 'pgrep']);
  const wf = qaWorkflow();
  wf.steps.qa_validation = {
    status: 'running', agents: [cleanQaAgent()],
    suiteRun: { status: 'running', command: 'xcodebuild test', pid: 424242, serverPid: 1, startedAt: new Date().toISOString(), expectedTestCount: EXPECTED },
  };
  const server = await mountRecording(root, wf);
  try {
    await withPath(bin, () => assertNoBypass(server, 'QA_SERVER_SUITE_AUTHORITY_MISSING'));
  } finally { await server.close(); clean(root); clean(bin); }
});

test('F2 — control: a verified exact run approves normally, so the refusals above are not a blanket block', async () => {
  const root = exactQaRepo();
  const bin = stubBinDir(['claude', 'pgrep'], { xcodebuild: `#!/bin/sh\n${successfulLog()}\nexit 0\n` });
  const server = await mountRecording(root, qaWorkflow());
  try {
    await withPath(bin, async () => {
      const launch = await server.request('POST', '/api/workflow/advance', { action: 'launch' });
      assert.equal(launch.status, 200, JSON.stringify(launch.body));
      const authority = await waitFor(() => {
        const step = server.state.loadWorkflow().steps.qa_validation;
        return step.suiteRun && step.suiteRun.authority;
      }, { label: 'persisted suite authority' });
      assert.equal(authority.code, 'QA_EXACT_COUNT_VERIFIED', JSON.stringify(authority));
      await waitFor(() => (server.state.loadWorkflow().steps.qa_validation.agents || []).length > 0, { label: 'QA agent launched' });
      const fb = await server.request('POST', '/api/workflow/feedback', { role: 'QA', step: 'qa_validation', feedback: CLEAN_APPROVAL });
      assert.equal(fb.status, 200, JSON.stringify(fb.body));
      const approve = await server.request('POST', '/api/workflow/advance', { action: 'approve' });
      assert.equal(approve.status, 200, JSON.stringify(approve.body));
      assert.equal(server.state.loadWorkflow().currentStep, 'code_review');
    });
  } finally { await server.close(); clean(root); clean(bin); }
});
