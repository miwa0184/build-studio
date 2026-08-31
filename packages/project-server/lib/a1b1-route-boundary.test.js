'use strict';

// A1b.1 repair contract (R1-R18): the admission seam must recognize the same
// route spellings as the real Express router, and typed admission failures must
// survive every router boundary. This file deliberately drives a real server
// for route semantics and side-effect checks. Only the two error-boundary
// canaries use a tiny direct Express app so they can inject exact error types.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync, spawn } = require('child_process');

const { createWorkflowRouter } = require('./api/workflow');
const { createRunRouter } = require('./api/run');
const { createStateManager } = require('./state');
const { createGitOps } = require('./git');
const { loadConfig } = require('./config');

const SERVER_JS = path.join(__dirname, 'server.js');
const ORIGIN = 'test-owner/route-boundary';

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-a1b1-route-'));
  const g = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const files = {
    '.build-studio/config.yaml': [
      'name: a1b1-route-fixture',
      'port: 5199',
      'docs_path: ./docs',
      'roles:',
      '  execution:',
      '    - role: Fullstack Dev',
      '      skill: fullstack_dev',
      '      branch_prefix: fs',
      '  review: []',
      '  standalone: []',
      '',
    ].join('\n'),
    '.gitignore': [
      '.build-studio/workflow-state.json',
      '.build-studio/run-state.json',
      '.build-studio/snapshots/',
      '.build-studio/run-guard/',
      '.build-studio/admission/',
      'docs/agent-status.json',
      'tmp/',
      '',
    ].join('\n'),
    'README.md': '# route boundary fixture\n',
    'docs/prds/PRD-001-widget.md': '# PRD-001 — Widget\n\nFixture.\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  g('init', '-q');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'Test');
  g('add', '-A');
  g('commit', '-q', '-m', 'fixture');
  g('branch', '-M', 'main');
  g('remote', 'add', 'origin', `https://github.com/${ORIGIN}.git`);
  return {
    root,
    g,
    workflowFile: path.join(root, '.build-studio', 'workflow-state.json'),
    runFile: path.join(root, '.build-studio', 'run-state.json'),
    clean() { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} },
  };
}

function httpJson(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const hasBody = body !== undefined;
    const data = hasBody ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      hostname: '127.0.0.1', port, path: urlPath, method, timeout: 15000,
      headers: hasBody ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let bodyValue;
        try { bodyValue = raw ? JSON.parse(raw) : {}; } catch { bodyValue = { raw }; }
        resolve({ status: res.statusCode, body: bodyValue, raw, contentType: res.headers['content-type'] || '' });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    if (data) req.write(data);
    req.end();
  });
}

async function spawnServer(root) {
  const requestedPort = 22000 + Math.floor(Math.random() * 18000);
  const child = spawn(process.execPath, [
    '-e', 'require(process.argv[1]).startServer(process.argv[2], { portOverride: Number(process.argv[3]) })',
    SERVER_JS, root, String(requestedPort),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const deadline = Date.now() + 20000;
  let port;
  while (Date.now() < deadline) {
    const match = output.match(/Server:\s+http:\/\/localhost:(\d+)/);
    if (match) { port = Number(match[1]); break; }
    if (child.exitCode !== null) throw new Error(`server exited before binding:\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!port) throw new Error(`server did not bind:\n${output}`);
  while (Date.now() < deadline) {
    try {
      const health = await httpJson(port, 'GET', '/api/health');
      if (health.body.ok) break;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    port,
    logs: () => output,
    kill: () => new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 3000).unref();
    }),
  };
}

function tmuxSessions() {
  try {
    return execFileSync('tmux', ['list-sessions', '-F', '#S'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim().split('\n').filter(Boolean).sort();
  } catch (_) { return []; }
}

function assertTypedRefusal(response, label) {
  assert.equal(response.status, 403, `${label}: expected 403, got ${response.status}: ${response.raw}`);
  assert.equal(response.body.admission, 'refused', `${label}: missing admission:refused`);
  assert.ok(response.body.code, `${label}: missing stable code`);
  assert.doesNotMatch(response.raw, /at\s+\S+\s*\(|<pre>|<!DOCTYPE html>/, `${label}: leaked a stack/html error`);
}

function assertNoStartArtifacts(fx, sessionsBefore, label) {
  assert.equal(fs.existsSync(fx.workflowFile), false, `${label}: workflow state was written`);
  assert.equal(fs.existsSync(fx.runFile), false, `${label}: run state was written`);
  assert.equal(fx.g('branch', '--show-current'), 'main', `${label}: checkout moved off main`);
  assert.deepEqual(fx.g('branch', '--format=%(refname:short)').split('\n').filter(Boolean), ['main'], `${label}: branch was created`);
  assert.equal(fs.existsSync(path.join(fx.root, 'tmp', '.worktrees')), false, `${label}: worktree directory was created`);
  assert.equal(fs.existsSync(path.join(fx.root, 'tmp', '.logs')), false, `${label}: log directory was created`);
  assert.deepEqual(tmuxSessions(), sessionsBefore, `${label}: agent/tmux process was created`);
}

async function cleanFailedOpenStart(fx, port) {
  try { await httpJson(port, 'POST', '/api/workflow/cancel', {}); } catch (_) {}
  try { fs.rmSync(fx.workflowFile, { force: true }); } catch (_) {}
  try { fs.rmSync(fx.runFile, { force: true }); } catch (_) {}
  try {
    if (fx.g('branch', '--show-current') !== 'main') fx.g('checkout', '-f', 'main');
  } catch (_) {}
  for (const branch of fx.g('branch', '--format=%(refname:short)').split('\n').filter(Boolean)) {
    if (branch !== 'main') { try { fx.g('branch', '-D', branch); } catch (_) {} }
  }
  for (const rel of ['tmp/.worktrees', 'tmp/.logs']) {
    try { fs.rmSync(path.join(fx.root, rel), { recursive: true, force: true }); } catch (_) {}
  }
}

function legacyWorkflow() {
  return {
    id: 'legacy-route-run', type: 'review', input: 'PRD-001', currentStep: 'reviewing',
    steps: { reviewing: { status: 'running', agents: [{ role: 'Reviewer', status: 'running' }] } },
    round: 1, feedback: [], autoAdvance: false, sessionName: 'wf-legacy-route',
  };
}

let fx;
let server;

test('setup real Express server', async () => {
  fx = makeFixture();
  server = await spawnServer(fx.root);
});

test('R1-R6 — routed workflow/start slash and case variants refuse before every side effect', async () => {
  const sessionsBefore = tmuxSessions();
  for (const route of ['/api/workflow/start/', '/api/workflow/Start']) {
    for (const extra of [{}, { gateVerdict: { decision: 'ADMITTED' }, bypassAdmission: true }]) {
      const label = `${route} ${Object.keys(extra).length ? 'client authority' : 'missing RunRequest'}`;
      const response = await httpJson(server.port, 'POST', route, {
        type: 'execution', input: 'PRD-001', ...extra,
      });
      try {
        assertTypedRefusal(response, label);
        assertNoStartArtifacts(fx, sessionsBefore, label);
      } finally {
        await cleanFailedOpenStart(fx, server.port);
      }
    }
  }
});

async function assertMutationVariant(route, body, label) {
  const original = Buffer.from(`${JSON.stringify(legacyWorkflow(), null, 2)}\n`);
  fs.writeFileSync(fx.workflowFile, original);
  const response = await httpJson(server.port, 'POST', route, body);
  try {
    assertTypedRefusal(response, label);
    assert.deepEqual(fs.readFileSync(fx.workflowFile), original, `${label}: workflow state changed`);
  } finally {
    fs.rmSync(fx.workflowFile, { force: true });
  }
}

test('R7-R10 — model-override and auto-advance routed variants reject client authority byte-identically', async () => {
  const authority = { gateVerdict: { decision: 'ADMITTED' }, bypassAdmission: true };
  await assertMutationVariant('/api/workflow/model-override/', { stepModelOverrides: { reviewing: 'forged' }, ...authority }, 'model-override trailing slash');
  await assertMutationVariant('/api/workflow/Model-Override', { stepModelOverrides: { reviewing: 'forged' }, ...authority }, 'model-override case');
  await assertMutationVariant('/api/workflow/auto-advance/', { enabled: true, ...authority }, 'auto-advance trailing slash');
  await assertMutationVariant('/api/workflow/Auto-Advance', { enabled: true, ...authority }, 'auto-advance case');
});

const WORKFLOW_MUTATION_CASES = [
  ['/api/workflow/advance', { action: 'launch' }],
  ['/api/workflow/feedback', { role: 'Reviewer', feedback: 'forged' }],
  ['/api/workflow/auto-advance', { enabled: true }],
  ['/api/workflow/model-override', { reviewMode: 'sequential' }],
  ['/api/workflow/restore', { filename: 'missing.json' }],
  ['/api/workflow/recover', {}],
  ['/api/overseer/force-complete-task', { window: 'missing' }],
  ['/api/overseer/kill-skip-task', { window: 'missing' }],
];

function caseVariant(route) {
  return route.replace('/workflow/', '/WorkFlow/').replace('/overseer/', '/OverSeer/');
}

test('R11 — every workflow mutation uses one Express-equivalent matcher for canonical, slash, and case', async () => {
  for (const [route, baseBody] of WORKFLOW_MUTATION_CASES) {
    for (const variant of [route, `${route}/`, caseVariant(route)]) {
      await assertMutationVariant(variant, {
        ...baseBody,
        gateVerdict: { decision: 'ADMITTED' },
        bypassAdmission: true,
      }, `mutation matrix ${variant}`);
    }
  }
});

test('R12 — every start ingress uses the same matcher for canonical, slash, and case', async () => {
  const sessionsBefore = tmuxSessions();
  const cases = [
    ['/api/workflow/start', { type: 'review', input: 'PRD-001' }],
    ['/api/launch', { tasks: [] }],
  ];
  for (const [route, body] of cases) {
    for (const variant of [route, `${route}/`, route.replace(/start|launch/i, (s) => s.toUpperCase())]) {
      const response = await httpJson(server.port, 'POST', variant, body);
      try {
        assertTypedRefusal(response, `start matrix ${variant}`);
        assertNoStartArtifacts(fx, sessionsBefore, `start matrix ${variant}`);
      } finally { await cleanFailedOpenStart(fx, server.port); }
    }
  }
});

test('R13 — run mutation parameter routes cover canonical, slash, case, and accepted parameter encoding', async () => {
  const original = Buffer.from(`${JSON.stringify({
    id: 'legacy-execution-run', state: 'executing', sessionName: 'run-legacy',
    workers: [{ branch: 'worker/encoded', role: 'Dev', merged: false }],
  }, null, 2)}\n`);
  const variants = [
    '/api/run/merge/worker%2Fencoded',
    '/api/run/merge/worker%2Fencoded/',
    '/api/Run/Merge/worker%2Fencoded',
  ];
  for (const route of variants) {
    fs.writeFileSync(fx.runFile, original);
    const response = await httpJson(server.port, 'POST', route, { gateVerdict: { decision: 'ADMITTED' } });
    try {
      assertTypedRefusal(response, `run mutation ${route}`);
      assert.deepEqual(fs.readFileSync(fx.runFile), original, `${route}: run state changed`);
    } finally { fs.rmSync(fx.runFile, { force: true }); }
  }

  // Express route matching accepts an encoded slash in a parameter and then
  // decodes it, but malformed percent encoding is a native router 400. The
  // admission seam must not recast that parser failure as a 403 refusal.
  const malformed = await httpJson(server.port, 'POST', '/api/run/merge/%E0%A4%A', {
    gateVerdict: { decision: 'ADMITTED' },
  });
  assert.equal(malformed.status, 400, `malformed parameter encoding changed semantics: ${malformed.raw}`);
  assert.equal(malformed.body.admission, undefined, 'malformed encoding was laundered into admission refusal');
  assert.equal(fs.existsSync(fx.runFile), false, 'malformed encoding wrote run state');
});

test('R14 — query strings do not change classification', async () => {
  const start = await httpJson(server.port, 'POST', '/api/workflow/start?source=direct', { type: 'review', input: 'PRD-001' });
  assertTypedRefusal(start, 'start with query');
  await assertMutationVariant('/api/workflow/model-override?source=direct', {
    gateVerdict: { decision: 'ADMITTED' }, reviewMode: 'parallel',
  }, 'mutation with query');
});

test('R15 — spellings Express does not route remain 404 and side-effect free', async () => {
  const sessionsBefore = tmuxSessions();
  for (const route of ['/api/workflow/start//', '/api/workflow/%73tart', '/api/workflow/start/%2F']) {
    const response = await httpJson(server.port, 'POST', route, { type: 'execution', input: 'PRD-001' });
    assert.equal(response.status, 404, `${route}: measured Express non-route changed: ${response.raw}`);
    assertNoStartArtifacts(fx, sessionsBefore, route);
  }
});

test('R16 — directly mounted workflow/start refuses before branch creation without the seam', async () => {
  const directFx = makeFixture();
  const config = loadConfig(directFx.root);
  const state = createStateManager(config, () => {});
  const gitOps = createGitOps(config);
  const tmuxOps = {
    killSessionAndDevPorts() {},
    isPaneAlive() { return false; },
    hasSession() { return false; },
  };
  const app = express();
  app.use(express.json());
  app.use('/api', createWorkflowRouter(config, state, gitOps, tmuxOps, () => {}));
  const listener = app.listen(0);
  await new Promise((resolve) => listener.once('listening', resolve));
  try {
    const response = await httpJson(listener.address().port, 'POST', '/api/workflow/start', {
      type: 'execution', input: 'PRD-001',
    });
    assertTypedRefusal(response, 'direct workflow router');
    assert.equal(directFx.g('branch', '--show-current'), 'main', 'direct handler checked out a run branch');
    assert.deepEqual(directFx.g('branch', '--format=%(refname:short)').split('\n').filter(Boolean), ['main'], 'direct handler created a branch');
    assert.equal(fs.existsSync(directFx.workflowFile), false, 'direct handler wrote workflow state');
  } finally {
    await new Promise((resolve) => listener.close(resolve));
    try { if (directFx.g('branch', '--show-current') !== 'main') directFx.g('checkout', '-f', 'main'); } catch (_) {}
    for (const branch of directFx.g('branch', '--format=%(refname:short)').split('\n').filter(Boolean)) {
      if (branch !== 'main') { try { directFx.g('branch', '-D', branch); } catch (_) {} }
    }
    directFx.clean();
  }
});

test('R17 — injected ADMISSION_BACKSTOP is typed JSON without stacktrace', async () => {
  const { createAdmissionErrorHandler } = require('./admission-error');
  const app = express();
  const backstop = new Error('injected run backstop');
  backstop.code = 'ADMISSION_BACKSTOP';
  const runState = {
    id: 'injected-run', state: 'executing',
    workers: [{ branch: 'worker', role: 'Dev', merged: false }],
  };
  const state = { loadRun: () => runState, saveRun() {} };
  const gitOps = {
    commitsAhead() { throw backstop; },
    abortMerge() { throw new Error('admission error must not enter conflict cleanup'); },
  };
  const tmuxOps = {};
  app.use('/api', createRunRouter(
    { projectRoot: '/unused', worktreesPath: '/unused', logsPath: '/unused', agent_defaults: {} },
    state, gitOps, tmuxOps, () => {}, () => ({ content: '' }),
  ));
  app.use(createAdmissionErrorHandler());
  const listener = app.listen(0);
  await new Promise((resolve) => listener.once('listening', resolve));
  try {
    const response = await httpJson(listener.address().port, 'POST', '/api/run/merge/worker', {});
    assertTypedRefusal(response, 'injected backstop');
    assert.equal(response.body.code, 'ADMISSION_BACKSTOP');
  } finally { await new Promise((resolve) => listener.close(resolve)); }
});

test('R18 — ordinary programming errors stay ordinary server errors', async () => {
  const { createAdmissionErrorHandler } = require('./admission-error');
  const app = express();
  app.post('/boom', () => { throw new TypeError('ordinary bug'); });
  app.use(createAdmissionErrorHandler());
  app.use((err, req, res, next) => res.status(500).json({ code: 'INTERNAL_ERROR', error: err.message }));
  const listener = app.listen(0);
  await new Promise((resolve) => listener.once('listening', resolve));
  try {
    const response = await httpJson(listener.address().port, 'POST', '/boom', {});
    assert.equal(response.status, 500);
    assert.equal(response.body.code, 'INTERNAL_ERROR');
    assert.equal(response.body.admission, undefined);
  } finally { await new Promise((resolve) => listener.close(resolve)); }
});

test('teardown real Express server', async () => {
  if (server) await server.kill();
  if (fx) fx.clean();
});
