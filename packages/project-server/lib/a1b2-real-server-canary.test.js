'use strict';

// A1b.2 real-server canaries. The actual server assembly, Express seam,
// admission registry, run guards, workflow state and feedback/advance routes
// participate. No helper-only successor is sufficient for these tests.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');

const { createTechnicalStop, REASON_CODES } = require('./technical-stop');

const SERVER_JS = path.join(__dirname, 'server.js');
const ORIGIN = 'test-owner/test-repo';
let nonceN = 0;

function makeFixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-a1b2-canary-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const cfg = {
    max_successor_runs: 2,
    max_lineage_recovery_units: 58,
    max_lineage_no_progress_repeats: 1,
    ...overrides,
  };
  const config = [
    'name: a1b2-canary',
    'port: 5199',
    'docs_path: ./docs',
    `max_successor_runs: ${cfg.max_successor_runs}`,
    `max_lineage_recovery_units: ${cfg.max_lineage_recovery_units}`,
    `max_lineage_no_progress_repeats: ${cfg.max_lineage_no_progress_repeats}`,
    'cli:',
    // Deliberately choose the least likely binary in CI. A failed CLI probe
    // still creates the real repair-agent record; the canary then plays the
    // agent's authenticated-by-run feedback POST without needing a paid model.
    '  default: opencode',
    'roles:',
    '  execution:',
    '    - role: Repair Dev',
    '      skill: fullstack_dev',
    '      branch_prefix: repair',
    '  review: []',
    '  standalone: []',
    '',
  ].join('\n');
  const files = {
    '.build-studio/config.yaml': config,
    '.gitignore': [
      '.build-studio/workflow-state.json',
      '.build-studio/run-state.json',
      '.build-studio/snapshots/',
      '.build-studio/run-guard/',
      '.build-studio/admission/',
      '.build-studio/successor-launch/',
      '.build-studio/fake-opencode-launches',
      '.build-studio/launch-barrier/',
      '.tmux/',
      'docs/agent-status.json',
      'tmp/',
      '',
    ].join('\n'),
    'test-bin/opencode': [
      '#!/bin/zsh',
      'mkdir -p .build-studio',
      'printf "launch\\n" >> .build-studio/fake-opencode-launches',
      'sleep 120',
      '',
    ].join('\n'),
    'README.md': '# canary\n',
    'docs/prds/PRD-001-widget.md': '# PRD-001 — Widget\n\nCanary packet.\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    if (rel === 'test-bin/opencode') fs.chmodSync(abs, 0o755);
  }
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  git('branch', '-M', 'main');
  git('remote', 'add', 'origin', `https://github.com/${ORIGIN}.git`);
  return {
    root,
    head: git('rev-parse', 'HEAD'),
    clean: () => {
      try {
        execFileSync('tmux', ['kill-server'], {
          stdio: 'ignore',
          env: { ...process.env, TMUX_TMPDIR: path.join(root, '.tmux') },
        });
      } catch (_) {}
      try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
    },
  };
}

function httpJson(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1', port, path: urlPath, method, timeout: 15000,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { raw }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    if (data) req.write(data);
    req.end();
  });
}

async function spawnServer(root, { crashPoint = null, strictCliPath = false } = {}) {
  const basePort = 22000 + Math.floor(Math.random() * 18000);
  const tmuxDir = path.join(root, '.tmux');
  fs.mkdirSync(tmuxDir, { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, [
    '-e', `
      const fs = require('fs');
      const path = require('path');
      const point = process.argv[4] || '';
      const workflowDeps = {};
      if (point === 'before-send') workflowDeps.beforeSuccessorAgentSend = () => process.exit(86);
      if (point === 'after-send') workflowDeps.afterSuccessorAgentSend = () => process.exit(87);
      if (point === 'barrier') workflowDeps.beforeSuccessorLaunchLock = () => {
        const dir = path.join(process.argv[2], '.build-studio', 'launch-barrier');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, String(process.pid)), 'ready');
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline && fs.readdirSync(dir).length < 2) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
        if (fs.readdirSync(dir).length < 2) throw new Error('two-server launch barrier timed out');
      };
      require(process.argv[1]).startServer(process.argv[2], {
        portOverride: Number(process.argv[3]), workflowDeps,
      });
    `,
    SERVER_JS, root, String(basePort), crashPoint || '',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PATH: strictCliPath
        ? `${path.join(root, 'test-bin')}:/usr/bin:/bin:/usr/sbin:/sbin`
        : `${path.join(root, 'test-bin')}:${process.env.PATH || ''}`,
      TMUX_TMPDIR: tmuxDir,
    },
  });
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  const deadline = Date.now() + 20000;
  let port;
  while (Date.now() < deadline) {
    const match = output.match(/Server:\s+http:\/\/localhost:(\d+)/);
    if (match) { port = Number(match[1]); break; }
    if (child.exitCode !== null) throw new Error(`server exited before binding:\n${output}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!port) throw new Error(`server did not bind:\n${output}`);
  return {
    root,
    port,
    logs: () => output,
    waitForExit: () => new Promise((resolve) => {
      if (child.exitCode !== null) return resolve(child.exitCode);
      child.once('exit', resolve);
    }),
    kill: () => new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 3000).unref();
    }),
  };
}

function runRequest(fx) {
  const now = Date.now();
  return {
    version: 1,
    repo: ORIGIN,
    head: fx.head,
    task_packet: 'docs/prds/PRD-001-widget.md',
    claims: [],
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 5 * 60 * 1000).toISOString(),
    nonce: `a1b2-canary-${process.pid}-${++nonceN}-${crypto.randomBytes(4).toString('hex')}`,
  };
}

function atomicJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

/** Seed the canary's precondition: a stop already made durable by A1a. */
function plantTechnicalStop(fx, runId, input = {}) {
  const guardDir = path.join(fx.root, '.build-studio', 'run-guard');
  const guardFile = fs.readdirSync(guardDir).map((f) => path.join(guardDir, f)).find((f) => {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')).runId === runId; } catch { return false; }
  });
  assert.ok(guardFile, `guard for ${runId}`);
  const stop = createTechnicalStop({
    reasonCode: REASON_CODES.BLOCKED_TASKS,
    runId,
    step: 'reviewing',
    tasks: [{ index: 0, name: 'canary repair', reason: 'deterministic failure' }],
    evidence: ['canary-command exit=1', 'fixture=PRD-001'],
    ...input,
  });
  const guard = JSON.parse(fs.readFileSync(guardFile, 'utf8'));
  guard.revision += 1;
  guard.technicalStop = stop;
  guard.blockingTasks = stop.tasks;
  guard.updatedAt = new Date().toISOString();
  atomicJson(guardFile, guard);

  const wfFile = path.join(fx.root, '.build-studio', 'workflow-state.json');
  const wf = JSON.parse(fs.readFileSync(wfFile, 'utf8'));
  wf.round = 5;
  wf.technicalStop = stop;
  wf.currentStep = 'technical_stop';
  wf.steps.technical_stop = { status: 'blocked', reasonCode: stop.reasonCode, stop };
  atomicJson(wfFile, wf);
  return stop;
}

async function waitFor(port, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await httpJson(port, 'GET', '/api/workflow');
    if (predicate(last.body.workflow)) return last.body.workflow;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`condition not reached; last workflow=${JSON.stringify(last && last.body && last.body.workflow)}`);
}

async function waitForJsonFile(file, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try { last = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
    if (last && predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`file condition not reached for ${file}; last=${JSON.stringify(last)}`);
}

async function waitForCondition(predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition not reached before timeout');
}

function fakeLaunchCount(root) {
  try {
    return fs.readFileSync(path.join(root, '.build-studio', 'fake-opencode-launches'), 'utf8')
      .split('\n').filter(Boolean).length;
  } catch (_) { return 0; }
}

async function startRoot(srv, fx) {
  const start = await httpJson(srv.port, 'POST', '/api/workflow/start', {
    type: 'review', input: 'PRD-001', runRequest: runRequest(fx),
  });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  return start.body.workflow;
}

async function reportRepair(srv, wf, repaired, { dirty = null } = {}) {
  if (repaired) {
    const marker = path.join(srv.root, `repair-${wf.lineage.successorOrdinal}.txt`);
    fs.writeFileSync(marker, `repair candidate for ${wf.id}\n`);
    execFileSync('git', ['add', path.basename(marker)], { cwd: srv.root });
    execFileSync('git', ['commit', '-q', '-m', `test: repair candidate ${wf.lineage.successorOrdinal}`], { cwd: srv.root });
    if (dirty === 'untracked') {
      fs.writeFileSync(path.join(srv.root, 'uncommitted-repair.txt'), 'not committed\n');
    } else if (dirty === 'staged') {
      fs.writeFileSync(path.join(srv.root, 'staged-repair.txt'), 'staged only\n');
      execFileSync('git', ['add', 'staged-repair.txt'], { cwd: srv.root });
    } else if (dirty === 'unstaged') {
      fs.appendFileSync(path.join(srv.root, 'README.md'), 'unstaged repair residue\n');
    }
  }
  const agent = wf.steps.successor_repair.agents[0];
  assert.ok(agent && agent.role, 'the real successor route materialises the technical repair assignment');
  return httpJson(srv.port, 'POST', '/api/workflow/feedback', {
    role: agent.role,
    step: 'successor_repair',
    feedback: [
      `**Repair complete:** ${repaired ? 'yes' : 'no'}`,
      '**Evidence:** canary-command exit=0',
      repaired ? 'The bounded repair was verified.' : 'The identical technical cause remains.',
    ].join('\n'),
  });
}

test('C1 — real server: root stop → one successor → repaired continuation, predecessor stays terminal', async (t) => {
  const fx = makeFixture();
  const srv = await spawnServer(fx.root);
  t.after(async () => { await srv.kill(); fx.clean(); });

  const root = await startRoot(srv, fx);
  const rootStop = plantTechnicalStop(fx, root.id);
  const raced = await Promise.all([
    httpJson(srv.port, 'POST', '/api/workflow/successor', {}),
    httpJson(srv.port, 'POST', '/api/workflow/successor', {}),
  ]);
  const created = raced.find((response) => response.status === 201);
  const refused = raced.find((response) => response !== created);
  assert.ok(created, `one concurrent request must win: ${JSON.stringify(raced)}`);
  assert.ok([200, 409].includes(refused.status), `the other request returns the same winner or a typed refusal: ${JSON.stringify(refused.body)}`);
  if (refused.status === 409) assert.ok(refused.body.code, 'the losing request is typed');
  assert.equal(created.status, 201, `successor route missing/refused: ${JSON.stringify(created.body)}\n${srv.logs()}`);
  assert.equal(created.body.successor.predecessorRunId, root.id);
  assert.equal(created.body.successor.successorOrdinal, 1);
  assert.equal(created.body.workflow.type, 'repair');
  assert.equal(created.body.workflow.currentStep, 'successor_repair');
  assert.equal(created.body.workflow.successorRepair.predecessorEvidence.fingerprint, rootStop.fingerprint);

  const feedback = await reportRepair(srv, created.body.workflow, true);
  assert.equal(feedback.status, 200, JSON.stringify(feedback.body));
  const continued = await waitFor(srv.port, (wf) => wf && wf.id === created.body.workflow.id && wf.type === 'review');
  assert.equal(continued.currentStep, 'reviewing');
  assert.equal(continued.round, 1, 'the successor does not inherit the predecessor per-run round label');
  assert.deepEqual(continued.steps.reviewing.agents, [], 'the stopped step is re-entered from clean transient state');
  assert.equal(continued.successorRepairResult.repaired, true);
  assert.notEqual(
    continued.successorRepairResult.progressSignal.baseHead,
    continued.successorRepairResult.progressSignal.currentHead,
    'continuation carries the server-measured forward git delta',
  );
  assert.equal(continued.lineage.predecessorRunId, root.id);

  const registry = JSON.parse(fs.readFileSync(path.join(fx.root, '.build-studio', 'admission', 'registry.json'), 'utf8'));
  assert.equal(registry.runs[root.id].successorRunId, continued.id);
  const rootGuardFile = fs.readdirSync(path.join(fx.root, '.build-studio', 'run-guard'))
    .map((f) => path.join(fx.root, '.build-studio', 'run-guard', f))
    .find((f) => JSON.parse(fs.readFileSync(f, 'utf8')).runId === root.id);
  assert.equal(JSON.parse(fs.readFileSync(rootGuardFile, 'utf8')).technicalStop.reasonCode, rootStop.reasonCode,
    'the predecessor did not reopen to make continuation possible');
});

test('C2 — real server: repeated identical failure reaches the exact cap; replay/restart changes nothing', async (t) => {
  const fx = makeFixture({
    max_successor_runs: 4,
    max_lineage_recovery_units: 99,
    max_lineage_no_progress_repeats: 1,
  });
  let srv = await spawnServer(fx.root);
  t.after(async () => { await srv.kill(); fx.clean(); });

  const root = await startRoot(srv, fx);
  plantTechnicalStop(fx, root.id);
  const firstResponse = await httpJson(srv.port, 'POST', '/api/workflow/successor', {});
  assert.equal(firstResponse.status, 201, JSON.stringify(firstResponse.body));
  const failed1 = await reportRepair(srv, firstResponse.body.workflow, false);
  assert.equal(failed1.status, 200, JSON.stringify(failed1.body));

  const second = await waitFor(srv.port, (wf) => wf && wf.type === 'repair'
    && wf.lineage && wf.lineage.successorOrdinal === 2);
  const failed2 = await reportRepair(srv, second, false);
  assert.equal(failed2.status, 200, JSON.stringify(failed2.body));

  const parked = await waitFor(srv.port, (wf) => wf && wf.id === second.id
    && wf.technicalStop && wf.lineageRefusal);
  assert.equal(parked.lineageRefusal.code, 'LINEAGE_NO_PROGRESS_BUDGET_EXHAUSTED');

  const registryFile = path.join(fx.root, '.build-studio', 'admission', 'registry.json');
  const before = fs.readFileSync(registryFile, 'utf8');
  const replay = await httpJson(srv.port, 'POST', '/api/workflow/successor', {});
  assert.equal(replay.status, 409, JSON.stringify(replay.body));
  assert.equal(replay.body.code, 'LINEAGE_NO_PROGRESS_BUDGET_EXHAUSTED');
  assert.equal(fs.readFileSync(registryFile, 'utf8'), before, 'over-cap replay is byte-for-byte side-effect free');

  await srv.kill();
  srv = await spawnServer(fx.root);
  const afterRestart = await httpJson(srv.port, 'POST', '/api/workflow/successor', {});
  assert.equal(afterRestart.status, 409, JSON.stringify(afterRestart.body));
  assert.equal(afterRestart.body.code, 'LINEAGE_NO_PROGRESS_BUDGET_EXHAUSTED');
  assert.equal(fs.readFileSync(registryFile, 'utf8'), before, 'restart cannot renew the cap');
});

test('C3 — real server: a free-form success assertion without a forward git delta is not progress', async (t) => {
  const fx = makeFixture({ max_successor_runs: 1, max_lineage_recovery_units: 99 });
  const srv = await spawnServer(fx.root);
  t.after(async () => { await srv.kill(); fx.clean(); });

  const root = await startRoot(srv, fx);
  plantTechnicalStop(fx, root.id);
  const created = await httpJson(srv.port, 'POST', '/api/workflow/successor', {});
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const agent = created.body.workflow.steps.successor_repair.agents[0];
  const asserted = await httpJson(srv.port, 'POST', '/api/workflow/feedback', {
    role: agent.role,
    step: 'successor_repair',
    feedback: '**Repair complete:** yes\n**Evidence:** trust the report',
  });
  assert.equal(asserted.status, 200, JSON.stringify(asserted.body));
  const parked = await waitFor(srv.port, (wf) => wf && wf.id === created.body.workflow.id
    && wf.technicalStop && wf.lineageRefusal);
  assert.equal(parked.technicalStop.reasonCode, REASON_CODES.SUCCESSOR_REPAIR_FAILED);
  assert.match(parked.technicalStop.evidence.join('\n'), /deterministic_progress_signal=absent/);
  assert.equal(parked.lineageRefusal.code, 'LINEAGE_SUCCESSOR_BUDGET_EXHAUSTED');
});

for (const dirty of ['staged', 'unstaged', 'untracked']) {
  test(`C3b — real server: a forward commit with ${dirty} residue is not a recovery signal`, async (t) => {
    const fx = makeFixture({ max_successor_runs: 1, max_lineage_recovery_units: 99 });
    const srv = await spawnServer(fx.root);
    t.after(async () => { await srv.kill(); fx.clean(); });

    const root = await startRoot(srv, fx);
    plantTechnicalStop(fx, root.id);
    const created = await httpJson(srv.port, 'POST', '/api/workflow/successor', {});
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const reported = await reportRepair(srv, created.body.workflow, true, { dirty });
    assert.equal(reported.status, 200, JSON.stringify(reported.body));
    const parked = await waitFor(srv.port, (wf) => wf && wf.id === created.body.workflow.id
      && wf.technicalStop && wf.lineageRefusal);
    assert.equal(parked.technicalStop.reasonCode, REASON_CODES.SUCCESSOR_REPAIR_FAILED);
    assert.match(parked.technicalStop.evidence.join('\n'), /repair worktree is not clean/);
    const porcelain = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: fx.root, encoding: 'utf8',
    });
    assert.notEqual(porcelain.trim(), '', 'the canary must genuinely leave dirty repository state');
  });
}

test('C4 — real server: restart reconciles a durable predecessor stop without a browser request', async (t) => {
  const fx = makeFixture();
  let srv = await spawnServer(fx.root);
  t.after(async () => { await srv.kill(); fx.clean(); });

  const root = await startRoot(srv, fx);
  plantTechnicalStop(fx, root.id);
  await srv.kill();
  srv = await spawnServer(fx.root);

  const successor = await waitFor(srv.port, (wf) => wf && wf.type === 'repair'
    && wf.lineage && wf.lineage.predecessorRunId === root.id);
  assert.equal(successor.lineage.successorOrdinal, 1);
  const registry = JSON.parse(fs.readFileSync(path.join(fx.root, '.build-studio', 'admission', 'registry.json'), 'utf8'));
  assert.equal(registry.runs[root.id].successorRunId, successor.id);
  assert.equal(registry.lineages[root.id].spent.successors, 1);
});

test('C5 — real server: restart launches a committed pending repair without a browser action', async (t) => {
  const fx = makeFixture();
  let srv = await spawnServer(fx.root);
  t.after(async () => { await srv.kill(); fx.clean(); });

  const root = await startRoot(srv, fx);
  plantTechnicalStop(fx, root.id);
  const created = await httpJson(srv.port, 'POST', '/api/workflow/successor', {});
  assert.equal(created.status, 201, JSON.stringify(created.body));
  await srv.kill();

  const wfFile = path.join(fx.root, '.build-studio', 'workflow-state.json');
  const pending = JSON.parse(fs.readFileSync(wfFile, 'utf8'));
  pending.steps.successor_repair = { status: 'pending', agents: [] };
  atomicJson(wfFile, pending);

  srv = await spawnServer(fx.root);
  const launched = await waitFor(srv.port, (wf) => wf && wf.id === created.body.workflow.id
    && wf.type === 'repair' && wf.steps.successor_repair.status === 'running'
    && wf.steps.successor_repair.agents.length === 1);
  assert.equal(launched.lineage.predecessorRunId, root.id);
});

test('C6 — real server: transient registry contention is retryable, not a fake terminal cap', async (t) => {
  const fx = makeFixture();
  const srv = await spawnServer(fx.root);
  t.after(async () => { await srv.kill(); fx.clean(); });

  const root = await startRoot(srv, fx);
  plantTechnicalStop(fx, root.id);
  const lock = path.join(fx.root, '.build-studio', 'admission', 'registry.lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));

  const busy = await httpJson(srv.port, 'POST', '/api/workflow/successor', {});
  assert.equal(busy.status, 503, JSON.stringify(busy.body));
  assert.equal(busy.body.code, 'ADMISSION_REGISTRY_BUSY');
  assert.equal(busy.body.terminal, false);
  assert.equal(busy.body.retryable, true);
  const stillStopped = await waitFor(srv.port, (wf) => wf && wf.id === root.id && wf.technicalStop);
  assert.equal(stillStopped.lineageRefusal, undefined, 'transient contention is not persisted as exhausted policy');

  fs.rmSync(lock, { recursive: true, force: true });
  const created = await httpJson(srv.port, 'POST', '/api/workflow/successor', {});
  assert.equal(created.status, 201, JSON.stringify(created.body));
});

test('C7 — real server: crash immediately after send-keys adopts the same live launch without duplication', async (t) => {
  const fx = makeFixture();
  let srv = await spawnServer(fx.root, { crashPoint: 'after-send' });
  t.after(async () => { await srv.kill(); fx.clean(); });

  const root = await startRoot(srv, fx);
  plantTechnicalStop(fx, root.id);
  await assert.rejects(httpJson(srv.port, 'POST', '/api/workflow/successor', {}));
  assert.equal(await srv.waitForExit(), 87, srv.logs());

  const wfFile = path.join(fx.root, '.build-studio', 'workflow-state.json');
  const crashed = JSON.parse(fs.readFileSync(wfFile, 'utf8'));
  assert.equal(crashed.steps.successor_repair.status, 'launching');
  assert.equal(crashed.steps.successor_repair.agents.length, 1,
    'the stable launch attempt is durable before send-keys');
  const receiptFile = crashed.successorRepair.launch.receiptFile;
  await waitForJsonFile(receiptFile, (receipt) => receipt.status === 'started');
  await waitForCondition(() => fakeLaunchCount(fx.root) === 1);
  assert.equal(fakeLaunchCount(fx.root), 1);

  srv = await spawnServer(fx.root);
  const adopted = await waitFor(srv.port, (wf) => wf && wf.id === crashed.id
    && wf.steps.successor_repair.status === 'running'
    && wf.successorRepair.launch.status === 'adopted');
  assert.equal(adopted.steps.successor_repair.agents[0].launchAttemptId,
    crashed.successorRepair.launch.attemptId);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(fakeLaunchCount(fx.root), 1, 'restart must not send the repair assignment twice');
});

test('C8 — real server: two project-server processes race one pending launch into one external process', async (t) => {
  const fx = makeFixture();
  let creator = await spawnServer(fx.root, { crashPoint: 'before-send' });
  let a = null;
  let b = null;
  t.after(async () => {
    await Promise.all([creator && creator.kill(), a && a.kill(), b && b.kill()].filter(Boolean));
    fx.clean();
  });

  const root = await startRoot(creator, fx);
  plantTechnicalStop(fx, root.id);
  await assert.rejects(httpJson(creator.port, 'POST', '/api/workflow/successor', {}));
  assert.equal(await creator.waitForExit(), 86, creator.logs());
  assert.equal(fakeLaunchCount(fx.root), 0, 'the pre-send crash point must not start a process');

  [a, b] = await Promise.all([
    spawnServer(fx.root, { crashPoint: 'barrier' }),
    spawnServer(fx.root, { crashPoint: 'barrier' }),
  ]);
  const running = await waitFor(a.port, (wf) => wf && wf.type === 'repair'
    && wf.steps.successor_repair.status === 'running');
  await waitForJsonFile(running.successorRepair.launch.receiptFile, (receipt) => receipt.status === 'started');
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(fakeLaunchCount(fx.root), 1,
    'cross-process launch exclusion must emit exactly one repair CLI invocation');
  assert.equal(running.steps.successor_repair.agents.length, 1);
});

test('C9 — real server: a failed CLI preflight can retry the same durable attempt exactly once', async (t) => {
  const fx = makeFixture();
  const fakeCli = path.join(fx.root, 'test-bin', 'opencode');
  const fakeCliBody = fs.readFileSync(fakeCli, 'utf8');
  const tmuxBin = execFileSync('/usr/bin/which', ['tmux'], { encoding: 'utf8' }).trim();
  fs.symlinkSync(tmuxBin, path.join(fx.root, 'test-bin', 'tmux'));
  const srv = await spawnServer(fx.root, { strictCliPath: true });
  t.after(async () => { await srv.kill(); fx.clean(); });

  const root = await startRoot(srv, fx);
  plantTechnicalStop(fx, root.id);
  fs.unlinkSync(fakeCli);

  const created = await httpJson(srv.port, 'POST', '/api/workflow/successor', {});
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.workflow.steps.successor_repair.status, 'error');
  assert.equal(fakeLaunchCount(fx.root), 0);
  const attemptId = created.body.workflow.successorRepair.launch.attemptId;

  fs.writeFileSync(fakeCli, fakeCliBody, { mode: 0o755 });
  const retried = await httpJson(srv.port, 'POST', '/api/workflow/advance', { action: 'launch' });
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  const running = await waitFor(srv.port, (wf) => wf && wf.id === created.body.workflow.id
    && wf.steps.successor_repair.status === 'running');
  await waitForJsonFile(running.successorRepair.launch.receiptFile, (receipt) => receipt.status === 'started');
  await waitForCondition(() => fakeLaunchCount(fx.root) === 1);
  assert.equal(running.successorRepair.launch.attemptId, attemptId,
    'retry must reuse the already durable launch identity');
  assert.equal(fakeLaunchCount(fx.root), 1,
    'recovering from a local preflight failure must launch exactly one process');
});
