'use strict';

// A1c receipt at the HTTP boundary: the real workflow router parks the run at
// the Egress Hold, the receipt router finalizes against that hold, and the
// hold keeps refusing every local or remote side effect whether or not a
// receipt exists. The receipt prepares a later reviewed egress; it never
// performs one.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { execFileSync } = require('child_process');

const { createWorkflowRouter } = require('./workflow');
const { createRunReceiptRouter } = require('./run-receipt');
const { loadConfig } = require('../config');
const { createStateManager } = require('../state');
const { createGitOps } = require('../git');
const { createAdmissionRegistry } = require('../admission-registry');
const { RECEIPT_DIR, CODES } = require('../run-receipt');
const { classifyAdmissionRoute } = require('../admission-seam');

const RUN_ID = 'bugfix-2026-09-04T11-00-00-cd34';
const PACKET = 'docs/backlog/LS-001.md';
const CLEAN_QA = '**Tests passed:** 12/12\n**Approved:** yes\n**Blocking:** 0\n12 passed';
const CLEAN_REVIEW = '**Approved:** yes\n**Blocking:** 0  |  **Medium:** 0  |  **Low:** 0';
// The production probe invokes `zsh -c ...`, but ubuntu-latest has no zsh.
// Delegate that probe to POSIX sh so the fixture tests PATH resolution rather
// than the runner's shell inventory. The shim must not report success blindly.
const ZSH_SHIM = '#!/bin/sh\nexec /bin/sh -c "$2"\n';

test('receipt hold — park, finalize, read, and the hold still refuses every egress with a receipt present', async (t) => {
  const fx = makeFixture(t);
  const server = await mount(fx);
  try {
    const before = snapshotRefs(fx);

    // Reaching the hold through the real handler records the held candidate.
    const park = await request(server.port, 'POST', '/api/workflow/advance', { action: 'approve' });
    assert.equal(park.status, 409, JSON.stringify(park.body));
    assert.equal(park.body.code, 'LOCAL_MERGE_REMOVED');
    const parked = server.state.loadWorkflow();
    assert.equal(parked.steps.merge_to_main.status, 'blocked');
    assert.equal(parked.steps.merge_to_main.candidateSha, fx.candidateSha, 'the hold must record the candidate sha it froze');
    assert.deepEqual(snapshotRefs(fx), before);

    const none = await request(server.port, 'GET', '/api/workflow/receipt');
    assert.equal(none.status, 404);
    assert.equal(none.body.code, CODES.NOT_FOUND);

    const finalize = await request(server.port, 'POST', '/api/workflow/receipt/finalize', { candidateSha: fx.candidateSha });
    assert.equal(finalize.status, 200, JSON.stringify(finalize.body));
    assert.equal(finalize.body.created, true);
    assert.equal(finalize.body.receipt.runId, RUN_ID);
    assert.equal(finalize.body.receipt.candidate.sha, fx.candidateSha);
    assert.equal(finalize.body.receipt.hold.code, 'LOCAL_MERGE_REMOVED');
    assert.equal(finalize.body.receipt.qa.mode, 'agent_verdict');
    assert.equal(finalize.body.receipt.mergeAuthorization, false);
    assert.equal(finalize.body.receipt.remoteEgress, 'disabled');
    const file = path.join(fx.root, '.build-studio', RECEIPT_DIR, `${RUN_ID}.json`);
    assert.ok(fs.existsSync(file));
    assert.deepEqual(snapshotRefs(fx), before, 'finalization changed a ref');

    const again = await request(server.port, 'POST', '/api/workflow/receipt/finalize', {});
    assert.equal(again.status, 200);
    assert.equal(again.body.created, false);
    assert.deepEqual(again.body.receipt, finalize.body.receipt);

    const read = await request(server.port, 'GET', '/api/workflow/receipt');
    assert.equal(read.status, 200);
    assert.deepEqual(read.body.receipt, finalize.body.receipt);
    assert.equal(read.body.verification.matchesReceipt, true);
    const byId = await request(server.port, 'GET', `/api/workflow/receipt/${RUN_ID}`);
    assert.equal(byId.status, 200);
    assert.deepEqual(byId.body.receipt, finalize.body.receipt);
    const unknown = await request(server.port, 'GET', '/api/workflow/receipt/no-such-run');
    assert.equal(unknown.status, 404);

    // With a receipt on disk the hold is unchanged: no merge, no push, no tag,
    // no branch deletion, from the operator route or from the tick.
    const held = await request(server.port, 'POST', '/api/workflow/advance', { action: 'approve' });
    assert.equal(held.status, 409, JSON.stringify(held.body));
    assert.equal(held.body.code, 'LOCAL_MERGE_REMOVED');
    assert.equal(held.body.egress, 'not_installed');
    const tick = await request(server.port, 'POST', '/api/workflow/auto-advance', { enabled: true });
    assert.equal(tick.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await request(server.port, 'POST', '/api/workflow/auto-advance', { enabled: false });
    const wf = server.state.loadWorkflow();
    assert.equal(wf.currentStep, 'merge_to_main');
    assert.equal(wf.steps.capture_learnings.status, 'pending');
    assert.deepEqual(snapshotRefs(fx), before, 'the hold reached an egress side effect');
    assert.equal(git(fx.root, ['status', '--porcelain']), '');
    assert.ok(fs.existsSync(file), 'the hold must not consume the receipt');

    // Drift after the receipt is observable and the receipt is not rewritten.
    const bytes = fs.readFileSync(file);
    fs.writeFileSync(path.join(fx.root, 'src', 'late.js'), 'late\n');
    git(fx.root, ['add', '-A']);
    git(fx.root, ['commit', '-q', '-m', 'late']);
    const drifted = await request(server.port, 'GET', '/api/workflow/receipt');
    assert.equal(drifted.status, 200);
    assert.equal(drifted.body.verification.matchesReceipt, false);
    const refinalize = await request(server.port, 'POST', '/api/workflow/receipt/finalize', {});
    assert.equal(refinalize.status, 409);
    assert.equal(refinalize.body.code, CODES.CANDIDATE_DRIFT);
    assert.ok(fs.readFileSync(file).equals(bytes));
  } finally {
    await server.close();
  }
});

test('receipt hold — advancing an already frozen hold never rebinds it to a moved candidate', async (t) => {
  const fx = makeFixture(t);
  const server = await mount(fx);
  try {
    const firstPark = await request(server.port, 'POST', '/api/workflow/advance', { action: 'approve' });
    assert.equal(firstPark.status, 409, JSON.stringify(firstPark.body));
    assert.equal(firstPark.body.code, 'LOCAL_MERGE_REMOVED');
    assert.equal(server.state.loadWorkflow().steps.merge_to_main.candidateSha, fx.candidateSha);

    fs.writeFileSync(path.join(fx.root, 'src', 'unreviewed.js'), 'unreviewed\n');
    git(fx.root, ['add', '-A']);
    git(fx.root, ['commit', '-q', '-m', 'unreviewed candidate drift']);
    const movedSha = git(fx.root, ['rev-parse', 'HEAD']);
    assert.notEqual(movedSha, fx.candidateSha, 'the test must move the candidate after the first hold');

    const secondPark = await request(server.port, 'POST', '/api/workflow/advance', { action: 'approve' });
    assert.equal(secondPark.status, 409, JSON.stringify(secondPark.body));
    assert.equal(secondPark.body.code, 'LOCAL_MERGE_REMOVED');
    const stillFrozen = server.state.loadWorkflow().steps.merge_to_main;
    assert.equal(stillFrozen.candidateSha, fx.candidateSha, 're-entering the hold must preserve the originally reviewed sha');

    const finalize = await request(server.port, 'POST', '/api/workflow/receipt/finalize', {});
    assert.equal(finalize.status, 409, JSON.stringify(finalize.body));
    assert.equal(finalize.body.code, CODES.CANDIDATE_DRIFT);
    assert.equal(fs.existsSync(path.join(fx.root, '.build-studio', RECEIPT_DIR, `${RUN_ID}.json`)), false);
  } finally {
    await server.close();
  }
});

test('receipt hold — advancing a legacy parked hold never invents its missing frozen sha', async (t) => {
  const fx = makeFixture(t);
  const server = await mount(fx);
  try {
    const legacy = server.state.loadWorkflow();
    legacy.currentStep = 'merge_to_main';
    legacy.steps.merge_to_main = {
      status: 'blocked',
      code: 'LOCAL_MERGE_REMOVED',
      egress: 'not_installed',
      error: 'PR egress is not installed',
      candidateBranch: 'fix/ls-001',
      defaultBranch: 'main',
    };
    server.state.saveWorkflow(legacy);

    fs.writeFileSync(path.join(fx.root, 'src', 'post-review.js'), 'not reviewed\n');
    git(fx.root, ['add', '-A']);
    git(fx.root, ['commit', '-q', '-m', 'move a legacy held candidate']);

    const advance = await request(server.port, 'POST', '/api/workflow/advance', { action: 'approve' });
    assert.equal(advance.status, 409, JSON.stringify(advance.body));
    assert.equal(advance.body.code, 'LOCAL_MERGE_REMOVED');
    assert.equal(
      server.state.loadWorkflow().steps.merge_to_main.candidateSha,
      null,
      'an old parked hold has no historical sha, so advance must not manufacture one',
    );

    const finalize = await request(server.port, 'POST', '/api/workflow/receipt/finalize', {});
    assert.equal(finalize.status, 409, JSON.stringify(finalize.body));
    assert.equal(finalize.body.code, CODES.HOLD_NOT_FROZEN);
    assert.equal(fs.existsSync(path.join(fx.root, '.build-studio', RECEIPT_DIR, `${RUN_ID}.json`)), false);
  } finally {
    await server.close();
  }
});

test('receipt hold — relaunch cannot erase durable frozen identity or bind a moved candidate', async (t) => {
  const fx = makeFixture(t);
  const server = await mount(fx);
  try {
    const park = await request(server.port, 'POST', '/api/workflow/advance', { action: 'approve' });
    assert.equal(park.status, 409, JSON.stringify(park.body));
    assert.equal(server.state.loadWorkflow().steps.merge_to_main.candidateSha, fx.candidateSha);

    fs.writeFileSync(path.join(fx.root, 'src', 'after-review-relaunch.js'), 'not reviewed\n');
    git(fx.root, ['add', '-A']);
    git(fx.root, ['commit', '-q', '-m', 'move candidate before relaunch']);

    const relaunch = await request(server.port, 'POST', '/api/workflow/advance', { action: 'relaunch' });
    assert.equal(relaunch.status, 409, JSON.stringify(relaunch.body));
    assert.equal(relaunch.body.code, 'LOCAL_MERGE_REMOVED');
    assert.equal(
      server.state.loadWorkflow().steps.merge_to_main.candidateSha,
      fx.candidateSha,
      'relaunch must project the durable first freeze instead of replacing it',
    );

    const finalize = await request(server.port, 'POST', '/api/workflow/receipt/finalize', {});
    assert.equal(finalize.status, 409, JSON.stringify(finalize.body));
    assert.equal(finalize.body.code, CODES.CANDIDATE_DRIFT);
  } finally {
    await server.close();
  }
});

test('receipt hold — restoring the pre-park snapshot cannot erase durable frozen identity', async (t) => {
  const fx = makeFixture(t);
  const server = await mount(fx);
  try {
    const prePark = server.state.listSnapshots().find((entry) => {
      const snap = server.state.readSnapshot(entry.file);
      return snap.currentStep === 'merge_to_main'
        && snap.steps.merge_to_main.status === 'pending';
    });
    assert.ok(prePark, 'fixture must contain the engine-created pre-park snapshot');

    const park = await request(server.port, 'POST', '/api/workflow/advance', { action: 'approve' });
    assert.equal(park.status, 409, JSON.stringify(park.body));
    assert.equal(server.state.loadWorkflow().steps.merge_to_main.candidateSha, fx.candidateSha);

    fs.writeFileSync(path.join(fx.root, 'src', 'after-review-restore.js'), 'not reviewed\n');
    git(fx.root, ['add', '-A']);
    git(fx.root, ['commit', '-q', '-m', 'move candidate before restore']);

    const restore = await request(server.port, 'POST', '/api/workflow/restore', { snapshotFile: prePark.file });
    assert.equal(restore.status, 200, JSON.stringify(restore.body));
    assert.equal(restore.body.workflow.steps.merge_to_main.status, 'blocked');
    assert.equal(restore.body.workflow.steps.merge_to_main.candidateSha, fx.candidateSha);

    const advance = await request(server.port, 'POST', '/api/workflow/advance', { action: 'approve' });
    assert.equal(advance.status, 409, JSON.stringify(advance.body));
    assert.equal(server.state.loadWorkflow().steps.merge_to_main.candidateSha, fx.candidateSha);

    const finalize = await request(server.port, 'POST', '/api/workflow/receipt/finalize', {});
    assert.equal(finalize.status, 409, JSON.stringify(finalize.body));
    assert.equal(finalize.body.code, CODES.CANDIDATE_DRIFT);
  } finally {
    await server.close();
  }
});

test('receipt hold — deleting the durable freeze fails closed instead of allowing a re-freeze', async (t) => {
  const fx = makeFixture(t);
  const server = await mount(fx);
  try {
    const park = await request(server.port, 'POST', '/api/workflow/advance', { action: 'approve' });
    assert.equal(park.status, 409, JSON.stringify(park.body));
    const authorityFile = server.state.runGuard.egressHoldFileFor(RUN_ID);
    assert.ok(fs.existsSync(authorityFile), 'parking must create durable egress authority');
    fs.unlinkSync(authorityFile);

    const loaded = server.state.loadWorkflow();
    assert.equal(loaded.guardUnverifiable.code, 'RUN_GUARD_UNREADABLE');
    const advance = await request(server.port, 'POST', '/api/workflow/advance', { action: 'approve' });
    assert.equal(advance.status, 503, JSON.stringify(advance.body));
    assert.equal(advance.body.code, 'RUN_GUARD_UNREADABLE');
  } finally {
    await server.close();
  }
});

test('receipt hold — the finalize route accepts no client authority and no unknown body', async (t) => {
  const fx = makeFixture(t);
  const server = await mount(fx);
  try {
    for (const body of [{ approved: true }, { verdict: 'ADMITTED' }, { bypass: true }, { candidateSha: fx.candidateSha, extra: 1 }, { candidateSha: 42 }]) {
      const res = await request(server.port, 'POST', '/api/workflow/receipt/finalize', body);
      assert.equal(res.status, 400, JSON.stringify({ body, res: res.body }));
      assert.equal(res.body.code, CODES.BAD_REQUEST);
    }
    assert.equal(fs.existsSync(path.join(fx.root, '.build-studio', RECEIPT_DIR)), false);
    // The central seam classifies finalization as a mutation of the admitted
    // run, so at the real server a legacy run refuses before this handler.
    const route = classifyAdmissionRoute({ method: 'POST', path: '/api/workflow/receipt/finalize' });
    assert.equal(route && route.kind, 'workflow-mutation');
    assert.equal(classifyAdmissionRoute({ method: 'GET', path: '/api/workflow/receipt' }), null);
  } finally {
    await server.close();
  }
});

test('receipt hold — a candidate that never reached the hold has no receipt and stays held', async (t) => {
  const fx = makeFixture(t, { currentStep: 'code_review' });
  const server = await mount(fx);
  try {
    const res = await request(server.port, 'POST', '/api/workflow/receipt/finalize', {});
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, CODES.NOT_AT_EGRESS_HOLD);
    assert.equal(fs.existsSync(path.join(fx.root, '.build-studio', RECEIPT_DIR)), false);
    const none = await request(server.port, 'GET', '/api/workflow/receipt');
    assert.equal(none.status, 404);
  } finally {
    await server.close();
  }
});

test('receipt hold — no active workflow answers 404 without creating anything', async (t) => {
  const fx = makeFixture(t);
  const server = await mount(fx);
  try {
    server.state.deleteWorkflow();
    const res = await request(server.port, 'POST', '/api/workflow/receipt/finalize', {});
    assert.equal(res.status, 404);
    assert.equal(res.body.code, CODES.NO_ACTIVE_RUN);
    assert.equal(fs.existsSync(path.join(fx.root, '.build-studio', RECEIPT_DIR)), false);
  } finally {
    await server.close();
  }
});

test('receipt hold — a launched agent records the effort token that reached its command line', async (t) => {
  const { stubBinDir, withPath, mountWorkflow, waitFor } = require('../test-support/workflow-http');
  const fx = makeFixture(t, { currentStep: 'qa_validation' });
  const configPath = path.join(fx.root, '.build-studio', 'config.yaml');
  fs.writeFileSync(configPath, `${fs.readFileSync(configPath, 'utf8')}agent_defaults:\n  effort: high\n`);
  fs.writeFileSync(path.join(fx.root, '.gitignore'), `${fs.readFileSync(path.join(fx.root, '.gitignore'), 'utf8')}start*.sh\nprompt-*.txt\n`);
  const bin = stubBinDir(['claude', 'pgrep'], { zsh: ZSH_SHIM });
  t.after(() => { try { fs.rmSync(bin, { recursive: true, force: true }); } catch (_) {} });
  const server = await mountWorkflow(fx.root, {
    id: 'effort-run', type: 'bugfix', input: 'LS-001', itemId: 'LS-001', prdPath: PACKET,
    currentStep: 'qa_validation', branch: 'fix/ls-001', defaultBranch: 'main', reviewBranch: 'fix/ls-001',
    round: 1, feedback: [], autoAdvance: false, sessionName: 'wf-effort', createdAt: '2026-09-04T10:00:00.000Z',
    steps: {
      task_execution: { status: 'completed', agents: [] },
      qa_validation: { status: 'pending', agents: [] },
      code_review: { status: 'pending', agents: [] },
      merge_to_main: { status: 'pending' },
      capture_learnings: { status: 'pending', agents: [] },
    },
    taskExecution: { currentTaskIndex: 0, taskStates: { 0: { status: 'done', agents: [] } } },
  });
  try {
    await withPath(bin, async () => {
      const launch = await server.request('POST', '/api/workflow/advance', { action: 'launch' });
      assert.equal(launch.status, 200, JSON.stringify(launch.body));
      const agent = await waitFor(() => (server.state.loadWorkflow().steps.qa_validation.agents || [])[0], { label: 'QA agent launched' });
      assert.equal(agent.cli, 'claude');
      assert.equal(agent.effort, 'high', 'the launched agent must record the effort that reached its command line');
    });
  } finally {
    await server.close();
  }
});

// ---------- fixture ----------

function makeFixture(t, { currentStep = 'merge_to_main' } = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-receipt-http-'));
  t.after(() => { try { fs.rmSync(parent, { recursive: true, force: true }); } catch (_) {} });
  const root = path.join(parent, 'project');
  const remote = path.join(parent, 'origin.git');
  fs.mkdirSync(root, { recursive: true });
  git(parent, ['init', '--bare', '-q', remote]);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Receipt HTTP']);
  write(path.join(root, '.gitignore'), ['.build-studio/admission/', '.build-studio/run-guard/', '.build-studio/run-receipt/', '.build-studio/workflow-state.json', '.build-studio/snapshots/', 'tmp/', 'docs/agent-status.json', ''].join('\n'));
  write(path.join(root, '.build-studio', 'config.yaml'), [
    'name: receipt-http-fixture', 'port: 5199', 'docs_path: ./docs',
    'roles:', '  execution: []', '  review: []', '  standalone: []',
    'deployment:', '  auto_deploy: true', '  auto_tag: true', '  versioning: semver', '',
  ].join('\n'));
  write(path.join(root, PACKET), '---\nid: LS-001\ntitle: Preserve this candidate\ntype: Bug\nstatus: Backlog\n---\n\nCandidate fixture.\n');
  write(path.join(root, 'docs', 'project-state.md'), '# Project State\n\n<!-- BACKLOG-START -->\n\n- LS-001 — Preserve this candidate  [Bug · Backlog]\n\n<!-- BACKLOG-END -->\n');
  write(path.join(root, 'src', 'base.js'), 'module.exports = "base";\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'initial main']);
  git(root, ['branch', '-M', 'main']);
  git(root, ['remote', 'add', 'origin', remote]);
  git(root, ['push', '-q', '-u', 'origin', 'main']);
  git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  const mainSha = git(root, ['rev-parse', 'main']);
  git(root, ['checkout', '-q', '-b', 'fix/ls-001']);
  write(path.join(root, 'src', 'candidate.js'), 'module.exports = "candidate";\n');
  replace(path.join(root, PACKET), 'status: Backlog', 'status: Fixing');
  replace(path.join(root, 'docs', 'project-state.md'), '[Bug · Backlog]', '[Bug · Fixing]');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'fix: candidate']);
  git(root, ['push', '-q', '-u', 'origin', 'fix/ls-001']);
  const candidateSha = git(root, ['rev-parse', 'fix/ls-001']);
  return { root, remote, mainSha, candidateSha, currentStep };
}

function registerRoot(statePath, guard, admittedHead) {
  const registry = createAdmissionRegistry({ statePath });
  const requestDigest = crypto.createHash('sha256').update(`http-root:${RUN_ID}:${admittedHead}`).digest('hex');
  const lineage = {
    runId: RUN_ID, lineageId: RUN_ID, predecessorRunId: null, successorOrdinal: 0,
    registeredAt: '2026-09-04T10:00:00.000Z', admissionRequestDigest: requestDigest,
    admittedHead, admittedRepo: 'test-owner/test-repo',
  };
  guard.register(RUN_ID, { identity: { ...lineage, rootRegistry: { runId: RUN_ID, requestDigest } } });
  registry.admit({
    nonce: `nonce-${RUN_ID}`, runId: RUN_ID,
    verdict: { kind: 'GateVerdict', version: 1, decision: 'ADMITTED', runId: RUN_ID, repo: lineage.admittedRepo, head: admittedHead, taskPacket: PACKET, nonce: 'n', requestDigest, admittedAt: lineage.registeredAt },
    lineage, claims: [],
  });
  return requestDigest;
}

async function mount(fx) {
  const config = loadConfig(fx.root);
  const state = createStateManager(config, () => {});
  const app = express();
  app.use(express.json());
  const tmuxOps = { killSessionAndDevPorts() {}, killWindowAndChildren() {}, isPaneAlive() { return false; } };
  app.use('/api', createWorkflowRouter(config, state, createGitOps(config), tmuxOps, () => {}));
  app.use('/api', createRunReceiptRouter(config, state));
  const requestDigest = registerRoot(config.statePath, state.runGuard, fx.mainSha);
  state.saveWorkflow({
    id: RUN_ID, type: 'bugfix', input: 'LS-001', itemId: 'LS-001', prdPath: PACKET,
    admission: { runId: RUN_ID, requestDigest, admittedAt: '2026-09-04T10:00:00.000Z', admittedHead: fx.mainSha },
    currentStep: fx.currentStep, branch: 'fix/ls-001', defaultBranch: 'main', reviewBranch: 'fix/ls-001',
    round: 1, feedback: [], autoAdvance: false, sessionName: 'wf-receipt-http', createdAt: '2026-09-04T10:00:00.000Z',
    steps: {
      task_execution: { status: 'completed', agents: [] },
      qa_validation: { status: 'completed', agents: [{ role: 'QA', status: 'done', cli: 'claude', model: 'sonnet', modelSource: 'preset', feedback: CLEAN_QA }] },
      code_review: { status: fx.currentStep === 'code_review' ? 'running' : 'completed', agents: [{ role: 'Code Reviewer', status: 'done', cli: 'claude', model: 'opus', modelSource: 'preset', feedback: CLEAN_REVIEW }] },
      merge_to_main: { status: 'pending' },
      capture_learnings: { status: 'pending', agents: [] },
    },
    taskExecution: { currentTaskIndex: 0, taskStates: { 0: { status: 'done', acceptanceCovered: true, agents: [{ role: 'Backend Dev', status: 'done', cli: 'claude', model: 'opus', modelSource: 'preset', feedback: '**All issues addressed:** yes' }] } } },
  });
  const listener = http.createServer(app);
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  config.port = port;
  return {
    port, state,
    close: async () => {
      await request(port, 'POST', '/api/workflow/auto-advance', { enabled: false }).catch(() => {});
      await new Promise((done) => listener.close(done));
    },
  };
}

function snapshotRefs(fx) {
  const refs = (cwd, prefix) => {
    const out = git(cwd, ['for-each-ref', '--format=%(refname):%(objectname)', prefix]);
    return out ? out.split('\n').sort() : [];
  };
  return {
    currentBranch: git(fx.root, ['branch', '--show-current']),
    head: git(fx.root, ['rev-parse', 'HEAD']),
    local: refs(fx.root, 'refs/heads'),
    tags: refs(fx.root, 'refs/tags'),
    remote: refs(fx.remote, 'refs/heads'),
    remoteTags: refs(fx.remote, 'refs/tags'),
  };
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function replace(file, from, to) {
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(from, to));
}

function request(port, method, url, body) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: url, method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { raw }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
