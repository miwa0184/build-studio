'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { execFileSync } = require('child_process');

const { createWorkflowRouter } = require('./workflow');
const { createRunRouter } = require('./run');
const { createDeploymentRouter } = require('./deployment');
const { loadConfig } = require('../config');
const { createStateManager } = require('../state');
const { createGitOps } = require('../git');
const { registerTestRoot } = require('../test-support/root-aggregate');

const LOCAL_MERGE_REMOVED = 'LOCAL_MERGE_REMOVED';
const DEFAULT_BRANCH_PUSH_REMOVED = 'DEFAULT_BRANCH_PUSH_REMOVED';
const REMOTE_MUTATION_REMOVED = 'REMOTE_MUTATION_REMOVED';

test('A1c C1 — merge_to_main refuses before checkout, merge, push, tag, or branch deletion', async () => {
  const fx = makeRunFixture();
  const server = await mountWorkflow(fx);
  try {
    const before = snapshotRefs(fx);
    const response = await request(server.port, 'POST', '/api/workflow/advance', { action: 'approve' });

    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(response.body.code, LOCAL_MERGE_REMOVED);
    assert.equal(response.body.egress, 'not_installed');

    const after = snapshotRefs(fx);
    assert.deepEqual(after, before, 'the old egress changed a checkout, ref, remote ref, or tag');

    const wf = server.state.loadWorkflow();
    assert.equal(wf.currentStep, 'merge_to_main');
    assert.equal(wf.steps.merge_to_main.status, 'blocked');
    assert.equal(wf.steps.merge_to_main.code, LOCAL_MERGE_REMOVED);
    assert.equal(wf.steps.capture_learnings.status, 'pending');
    assert.equal(wf.autoAdvance, false);
    assert.equal(readBugStatus(fx.root), 'Fixing', 'candidate acceptance state changed before A1c egress');
  } finally {
    await server.close();
    fx.clean();
  }
});

test('A1c C1 — auto-advance parks at merge_to_main without invoking egress', async () => {
  const fx = makeRunFixture();
  const server = await mountWorkflow(fx);
  try {
    const before = snapshotRefs(fx);
    const enabled = await request(server.port, 'POST', '/api/workflow/auto-advance', { enabled: true });
    assert.equal(enabled.status, 200, JSON.stringify(enabled.body));

    await new Promise((resolve) => setTimeout(resolve, 1200));

    const after = snapshotRefs(fx);
    assert.deepEqual(after, before, 'the auto-advance tick reached the old egress');
    const wf = server.state.loadWorkflow();
    assert.equal(wf.currentStep, 'merge_to_main');
    assert.equal(wf.steps.merge_to_main.status, 'pending');
    assert.equal(wf.steps.capture_learnings.status, 'pending');
    assert.equal(readBugStatus(fx.root), 'Fixing');
  } finally {
    await request(server.port, 'POST', '/api/workflow/auto-advance', { enabled: false }).catch(() => {});
    await server.close();
    fx.clean();
  }
});

test('A1c C1 — bugfix auto_merge no longer jumps from approval into local egress', async () => {
  const fx = makeRunFixture({ autoMerge: true, currentStep: 'code_review' });
  const server = await mountWorkflow(fx);
  try {
    const before = snapshotRefs(fx);
    const response = await request(server.port, 'POST', '/api/workflow/advance', { action: 'approve' });

    assert.equal(response.status, 200, JSON.stringify(response.body));
    const after = snapshotRefs(fx);
    assert.deepEqual(after, before, 'bugfix auto_merge invoked the removed local egress');
    const wf = server.state.loadWorkflow();
    assert.equal(wf.steps.code_review.status, 'completed');
    assert.equal(wf.currentStep, 'merge_to_main');
    assert.equal(wf.steps.merge_to_main.status, 'pending');
    assert.equal(wf.steps.capture_learnings.status, 'pending');
    assert.equal(readBugStatus(fx.root), 'Fixing');
  } finally {
    await server.close();
    fx.clean();
  }
});

test('A1c C1 — /run/merge/:branch cannot merge a worker into the default branch', async () => {
  const calls = [];
  const run = {
    id: 'legacy-run', state: 'executing',
    workers: [{ branch: 'worker/a', role: 'Dev', merged: false }],
  };
  const gitOps = {
    getCurrentBranch: () => 'main',
    getDefaultBranch: () => 'main',
    commitsAhead: () => { calls.push('commitsAhead'); return 1; },
    mergeBranch: () => calls.push('mergeBranch'),
    removeWorktree: () => calls.push('removeWorktree'),
    abortMerge: () => calls.push('abortMerge'),
  };
  const app = express();
  app.use(express.json());
  app.use('/api', createRunRouter(
    { projectRoot: '/unused', worktreesPath: '/unused', logsPath: '/unused', agent_defaults: {} },
    { loadRun: () => run, saveRun: () => calls.push('saveRun') },
    gitOps, {}, () => calls.push('broadcast'), () => ({ content: '' }),
  ));
  const server = await listen(app);
  try {
    const response = await request(server.port, 'POST', '/api/run/merge/worker%2Fa', {});
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(response.body.code, LOCAL_MERGE_REMOVED);
    assert.deepEqual(calls, []);
    assert.equal(run.workers[0].merged, false);
  } finally {
    await server.close();
  }
});

test('A1c C1 — /run/merge/:branch still integrates workers into an internal candidate branch', async () => {
  const calls = [];
  const run = {
    id: 'candidate-run', state: 'executing',
    workers: [{ branch: 'worker/a', role: 'Dev', merged: false }],
  };
  const gitOps = {
    getCurrentBranch: () => 'review/candidate',
    getDefaultBranch: () => 'main',
    commitsAhead: () => { calls.push('commitsAhead'); return 1; },
    mergeBranch: () => calls.push('mergeBranch'),
    removeWorktree: () => calls.push('removeWorktree'),
    abortMerge: () => calls.push('abortMerge'),
  };
  const app = express();
  app.use(express.json());
  app.use('/api', createRunRouter(
    { projectRoot: '/unused', worktreesPath: '/unused', logsPath: '/unused', agent_defaults: {} },
    { loadRun: () => run, saveRun: () => calls.push('saveRun') },
    gitOps, {}, () => calls.push('broadcast'), () => ({ content: '' }),
  ));
  const server = await listen(app);
  try {
    const response = await request(server.port, 'POST', '/api/run/merge/worker%2Fa', {});
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.status, 'merged');
    assert.deepEqual(calls, ['commitsAhead', 'mergeBranch', 'saveRun', 'removeWorktree', 'broadcast']);
    assert.equal(run.workers[0].merged, true);
  } finally {
    await server.close();
  }
});

test('A1c C1 — deployment push cannot publish the default branch or its tags', async () => {
  const fx = makeDeploymentFixture();
  const config = loadConfig(fx.root);
  const app = express();
  app.use(express.json());
  app.use('/api', createDeploymentRouter(config, createGitOps(config)));
  const server = await listen(app);
  try {
    const remoteMainBefore = bareRev(fx.remote, 'refs/heads/main');
    assert.equal(bareRefExists(fx.remote, 'refs/tags/v9.9.9'), false);

    const response = await request(server.port, 'POST', '/api/deployment/push', {});
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(response.body.code, DEFAULT_BRANCH_PUSH_REMOVED);
    assert.equal(response.body.egress, 'not_installed');
    assert.equal(bareRev(fx.remote, 'refs/heads/main'), remoteMainBefore);
    assert.equal(bareRefExists(fx.remote, 'refs/tags/v9.9.9'), false);
  } finally {
    await server.close();
    fx.clean();
  }
});

test('A1c C1 — deployment push cannot publish a candidate branch or tags', async () => {
  const fx = makeDeploymentFixture();
  git(fx.root, ['checkout', '-q', '-b', 'candidate/deploy']);
  write(path.join(fx.root, 'candidate-branch.txt'), 'candidate\n');
  git(fx.root, ['add', '-A']);
  git(fx.root, ['commit', '-q', '-m', 'candidate branch']);
  const config = loadConfig(fx.root);
  const app = express();
  app.use(express.json());
  app.use('/api', createDeploymentRouter(config, createGitOps(config)));
  const server = await listen(app);
  try {
    const before = snapshotDeploymentRefs(fx);
    const response = await request(server.port, 'POST', '/api/deployment/push', {});
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(response.body.code, REMOTE_MUTATION_REMOVED);
    assert.deepEqual(snapshotDeploymentRefs(fx), before);
    assert.equal(bareRefExists(fx.remote, 'refs/heads/candidate/deploy'), false);
    assert.equal(bareRefExists(fx.remote, 'refs/tags/v9.9.9'), false);
  } finally {
    await server.close();
    fx.clean();
  }
});

test('A1c C1 — CI-fix acceptance refuses before commit, branch creation, push, or PR egress', async () => {
  for (const strategy of ['pr', 'push']) {
    const fx = makeDeploymentFixture();
    write(path.join(fx.root, 'ci-fix.txt'), `proposed only (${strategy})\n`);
    const config = loadConfig(fx.root);
    config.deployment.ci_fix_strategy = strategy;
    const app = express();
    app.use(express.json());
    app.use('/api', createDeploymentRouter(config, createGitOps(config)));
    const server = await listen(app);
    try {
      const before = snapshotDeploymentRefs(fx);
      const statusBefore = git(fx.root, ['status', '--porcelain']);
      const response = await request(server.port, 'POST', '/api/deployment/ci-fix-accept', { summary: 'must stay proposed' });
      assert.equal(response.status, 409, `${strategy}: ${JSON.stringify(response.body)}`);
      assert.equal(response.body.code, REMOTE_MUTATION_REMOVED);
      assert.equal(response.body.strategy, strategy);
      assert.deepEqual(snapshotDeploymentRefs(fx), before);
      assert.equal(git(fx.root, ['status', '--porcelain']), statusBefore);
      assert.equal(git(fx.root, ['branch', '--list', 'ci-fix-*']), '');
    } finally {
      await server.close();
      fx.clean();
    }
  }
});

function makeRunFixture({ autoMerge = false, currentStep = 'merge_to_main' } = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'a1c-egress-'));
  const root = path.join(parent, 'project');
  const remote = path.join(parent, 'origin.git');
  fs.mkdirSync(root, { recursive: true });
  git(parent, ['init', '--bare', '-q', remote]);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'A1c Canary']);

  write(path.join(root, '.gitignore'), [
    '.build-studio/admission/',
    '.build-studio/run-guard/',
    '.build-studio/workflow-state.json',
    '.build-studio/snapshots/',
    '',
  ].join('\n'));
  write(path.join(root, '.build-studio', 'config.yaml'), [
    'name: a1c-egress-fixture',
    'port: 5199',
    'docs_path: ./docs',
    'roles:',
    '  execution: []',
    '  review: []',
    '  standalone: []',
    'bugfix:',
    `  auto_merge: ${autoMerge}`,
    'deployment:',
    '  auto_deploy: true',
    '  auto_tag: true',
    '  versioning: semver',
    '',
  ].join('\n'));
  write(path.join(root, 'docs', 'backlog', 'LS-001.md'), [
    '---', 'id: LS-001', 'title: Preserve this candidate', 'type: Bug',
    'status: Backlog', '---', '', 'Candidate fixture.', '',
  ].join('\n'));
  write(path.join(root, 'docs', 'project-state.md'), [
    '# Project State', '', '<!-- BACKLOG-START -->', '',
    '- LS-001 — Preserve this candidate  [Bug · Backlog]', '', '<!-- BACKLOG-END -->', '',
  ].join('\n'));
  write(path.join(root, 'src', 'base.js'), 'module.exports = "base";\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'initial main']);
  git(root, ['branch', '-M', 'main']);
  git(root, ['remote', 'add', 'origin', remote]);
  git(root, ['push', '-q', '-u', 'origin', 'main']);
  git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

  git(root, ['checkout', '-q', '-b', 'fix/ls-001']);
  write(path.join(root, 'src', 'candidate.js'), 'module.exports = "candidate";\n');
  replace(path.join(root, 'docs', 'backlog', 'LS-001.md'), 'status: Backlog', 'status: Fixing');
  replace(path.join(root, 'docs', 'project-state.md'), '[Bug · Backlog]', '[Bug · Fixing]');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'fix: candidate must survive']);
  git(root, ['push', '-q', '-u', 'origin', 'fix/ls-001']);

  return {
    parent, root, remote, currentStep,
    clean: () => { try { fs.rmSync(parent, { recursive: true, force: true }); } catch {} },
  };
}

function makeDeploymentFixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'a1c-deploy-'));
  const root = path.join(parent, 'project');
  const remote = path.join(parent, 'origin.git');
  fs.mkdirSync(root, { recursive: true });
  git(parent, ['init', '--bare', '-q', remote]);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'A1c Canary']);
  write(path.join(root, '.build-studio', 'config.yaml'), [
    'name: a1c-deploy-fixture', 'port: 5199', 'deployment:', '  versioning: none', '',
  ].join('\n'));
  write(path.join(root, 'base.txt'), 'base\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'initial main']);
  git(root, ['branch', '-M', 'main']);
  git(root, ['remote', 'add', 'origin', remote]);
  git(root, ['push', '-q', '-u', 'origin', 'main']);
  git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  write(path.join(root, 'candidate.txt'), 'must not publish\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'candidate on main']);
  git(root, ['tag', '-a', 'v9.9.9', '-m', 'must not publish']);
  return {
    parent, root, remote,
    clean: () => { try { fs.rmSync(parent, { recursive: true, force: true }); } catch {} },
  };
}

async function mountWorkflow(fx) {
  const config = loadConfig(fx.root);
  const state = createStateManager(config, () => {});
  const app = express();
  app.use(express.json());
  app.use('/api', createWorkflowRouter(
    config, state, createGitOps(config),
    { killSessionAndDevPorts() {}, killWindowAndChildren() {}, isPaneAlive() { return false; } },
    () => {},
  ));
  registerTestRoot({ statePath: config.statePath, runId: 'a1c-egress-run', guard: state.runGuard });
  state.saveWorkflow(workflowAt(fx.currentStep));
  const server = await listen(app);
  config.port = server.port;
  return { ...server, state };
}

function workflowAt(currentStep) {
  return {
    id: 'a1c-egress-run', type: 'bugfix', input: 'LS-001', itemId: 'LS-001',
    prdPath: 'docs/backlog/LS-001.md', currentStep,
    branch: 'fix/ls-001', defaultBranch: 'main', reviewBranch: 'fix/ls-001',
    round: 1, feedback: [], autoAdvance: false, sessionName: 'wf-a1c-egress',
    steps: {
      task_execution: { status: 'completed', agents: [] },
      qa_validation: { status: 'completed', agents: [] },
      code_review: { status: currentStep === 'code_review' ? 'running' : 'completed', agents: [] },
      merge_to_main: { status: 'pending' },
      capture_learnings: { status: 'pending', agents: [] },
    },
    taskExecution: { currentTaskIndex: 0, taskStates: { 0: { status: 'done', agents: [] } } },
  };
}

function snapshotRefs(fx) {
  return {
    currentBranch: git(fx.root, ['branch', '--show-current']),
    head: git(fx.root, ['rev-parse', 'HEAD']),
    main: git(fx.root, ['rev-parse', 'main']),
    candidate: git(fx.root, ['rev-parse', 'fix/ls-001']),
    localBranches: git(fx.root, ['branch', '--format=%(refname:short)']).split('\n').filter(Boolean).sort(),
    localTags: git(fx.root, ['tag', '--list']).split('\n').filter(Boolean).sort(),
    remoteMain: bareRev(fx.remote, 'refs/heads/main'),
    remoteCandidate: bareRev(fx.remote, 'refs/heads/fix/ls-001'),
    remoteTags: bareRefs(fx.remote, 'refs/tags'),
  };
}

function readBugStatus(root) {
  const body = fs.readFileSync(path.join(root, 'docs', 'backlog', 'LS-001.md'), 'utf8');
  const match = body.match(/^status:\s*(.+)$/m);
  return match && match[1].trim();
}

function snapshotDeploymentRefs(fx) {
  return {
    head: git(fx.root, ['rev-parse', 'HEAD']),
    branch: git(fx.root, ['branch', '--show-current']),
    localBranches: git(fx.root, ['branch', '--format=%(refname:short)']).split('\n').filter(Boolean).sort(),
    localTags: bareRefs(fx.root, 'refs/tags'),
    remoteBranches: bareRefs(fx.remote, 'refs/heads'),
    remoteTags: bareRefs(fx.remote, 'refs/tags'),
  };
}

function bareRev(remote, ref) {
  return git(remote, ['rev-parse', ref]);
}

function bareRefs(remote, prefix) {
  const out = git(remote, ['for-each-ref', '--format=%(refname):%(objectname)', prefix]);
  return out ? out.split('\n').sort() : [];
}

function bareRefExists(remote, ref) {
  try { git(remote, ['show-ref', '--verify', '--quiet', ref]); return true; } catch { return false; }
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

function listen(app) {
  const listener = http.createServer(app);
  return new Promise((resolve) => {
    listener.listen(0, '127.0.0.1', () => resolve({
      port: listener.address().port,
      close: () => new Promise((done) => listener.close(done)),
    }));
  });
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
