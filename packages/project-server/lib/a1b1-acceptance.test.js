'use strict';

// A1b.1 acceptance contract (A1–A13): server-side admission before the first
// work-related side effect, at the REAL server assembly.
//
// These tests spawn the actual project-server (lib/server.js) as a child
// process and drive it over HTTP — the exact surface the hub, an agent's
// curl, and an attacker's script all share. Deliberately, this file imports
// NOTHING from the new admission modules: it needs only node's stdlib and the
// server entrypoint, so the very same file runs against an unchanged main
// checkout, where it fails on BEHAVIOUR (starts that should refuse succeed) —
// the red-first evidence for this slice.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');

const SERVER_JS = path.join(__dirname, 'server.js');
const ORIGIN = 'test-owner/test-repo';

// ─── fixture ─────────────────────────────────────────────────────────────────

function makeFixture({ withOrigin = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-a1b1-acc-'));
  const g = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const files = {
    '.build-studio/config.yaml': [
      'name: a1b1-fixture',
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
    'README.md': '# a1b1 fixture\n',
    'docs/prds/PRD-001-widget.md': '# PRD-001 — Widget\n\nA fixture PRD.\n',
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
  g('commit', '-q', '-m', 'one');
  g('branch', '-M', 'main');
  const staleHead = g('rev-parse', 'HEAD');
  fs.appendFileSync(path.join(root, 'README.md'), 'second line\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'two');
  const head = g('rev-parse', 'HEAD');
  if (withOrigin) g('remote', 'add', 'origin', `https://github.com/${ORIGIN}.git`);
  return {
    root, head, staleHead, g,
    clean: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} },
  };
}

// ─── the real server, as a child process ─────────────────────────────────────

async function spawnServer(root) {
  const basePort = 21000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [
    '-e', 'require(process.argv[1]).startServer(process.argv[2], { portOverride: Number(process.argv[3]) })',
    SERVER_JS, root, String(basePort),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });

  // The server auto-increments on port conflicts; read the port it SAYS it
  // bound, then confirm via /api/health.
  const deadline = Date.now() + 20000;
  let port = null;
  while (Date.now() < deadline) {
    const m = out.match(/Server:\s+http:\/\/localhost:(\d+)/);
    if (m) { port = Number(m[1]); break; }
    if (child.exitCode !== null) throw new Error(`server exited before binding:\n${out}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!port) throw new Error(`server did not report a port in time:\n${out}`);
  while (Date.now() < deadline) {
    try {
      const health = await httpJson(port, 'GET', '/api/health');
      if (health.body && health.body.ok) break;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    port,
    child,
    logs: () => out,
    kill: () => new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 3000).unref();
    }),
  };
}

function httpJson(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const hasBody = body !== undefined;
    const data = hasBody ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method, timeout: 15000,
        headers: hasBody ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let parsed = {};
          try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { raw }; }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('request timeout')); });
    if (hasBody) req.write(data);
    req.end();
  });
}

let nonceCounter = 0;
function validRunRequest(fx, overrides = {}) {
  const now = Date.now();
  return {
    version: 1,
    repo: ORIGIN,
    head: fx.head,
    task_packet: 'docs/prds/PRD-001-widget.md',
    claims: [],
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 5 * 60 * 1000).toISOString(),
    nonce: `acc-nonce-${process.pid}-${++nonceCounter}-${crypto.randomBytes(4).toString('hex')}`,
    ...overrides,
  };
}

/**
 * A13 — what a refusal must NOT leave behind. Called after every refused
 * start. On unchanged main these starts succeed, so this is where the
 * red-first failures land, each naming the artifact that leaked.
 */
async function assertRefusalLeftNothing(fx, port, res) {
  assert.equal(res.status, 403, `a refused start must answer 403, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.admission, 'refused', 'the refusal must be machine-readable');
  assert.ok(res.body.code, 'the refusal must carry a typed code');
  const wf = await httpJson(port, 'GET', '/api/workflow');
  assert.equal(wf.body.workflow, null, 'a refusal must leave no workflow record');
  assert.equal(fs.existsSync(path.join(fx.root, '.build-studio', 'workflow-state.json')), false, 'no workflow state file');
  assert.equal(fs.existsSync(path.join(fx.root, '.build-studio', 'run-state.json')), false, 'no run state file');
  const branches = fx.g('branch', '--format=%(refname:short)').split('\n').filter(Boolean);
  assert.deepEqual(branches, ['main'], 'a refusal must create no branch');
  const wtDir = path.join(fx.root, 'tmp', '.worktrees');
  const worktrees = fs.existsSync(wtDir) ? fs.readdirSync(wtDir) : [];
  assert.deepEqual(worktrees, [], 'a refusal must create no worktree');
}

/** Undo whatever a fail-open start (old main) left, so the next case stands alone. */
async function cleanupAnyRun(fx, port) {
  try { await httpJson(port, 'POST', '/api/workflow/cancel', {}); } catch (_) {}
  try { fs.rmSync(path.join(fx.root, '.build-studio', 'workflow-state.json'), { force: true }); } catch (_) {}
}

// ─── group 1: one fixture, one server, the refusal battery then acceptance ───

let fx1;
let srv1;

test('setup: fixture and real server', async (t) => {
  fx1 = makeFixture();
  srv1 = await spawnServer(fx1.root);
});

test('A1 — a start without a RunRequest is refused, before any side effect', async () => {
  const res = await httpJson(srv1.port, 'POST', '/api/workflow/start', { type: 'review', input: 'PRD-001' });
  try {
    await assertRefusalLeftNothing(fx1, srv1.port, res);
    assert.equal(res.body.code, 'ADMISSION_REQUEST_MISSING');
  } finally { await cleanupAnyRun(fx1, srv1.port); }
});

test('A2 — a fabricated head sha is refused', async () => {
  const res = await httpJson(srv1.port, 'POST', '/api/workflow/start', {
    type: 'review', input: 'PRD-001',
    runRequest: validRunRequest(fx1, { head: 'a'.repeat(40) }),
  });
  try {
    await assertRefusalLeftNothing(fx1, srv1.port, res);
    assert.equal(res.body.code, 'ADMISSION_HEAD_UNKNOWN');
    // Nothing was consumed either: the registry holds no runs and no nonces.
    const regFile = path.join(fx1.root, '.build-studio', 'admission', 'registry.json');
    if (fs.existsSync(regFile)) {
      const reg = JSON.parse(fs.readFileSync(regFile, 'utf8'));
      assert.deepEqual(reg.runs, {}, 'no run may be registered by a refusal');
      assert.deepEqual(reg.nonces, {}, 'no nonce may be consumed by a refusal');
    }
  } finally { await cleanupAnyRun(fx1, srv1.port); }
});

test('A3 — the correct sha for the wrong repo is refused', async () => {
  const res = await httpJson(srv1.port, 'POST', '/api/workflow/start', {
    type: 'review', input: 'PRD-001',
    runRequest: validRunRequest(fx1, { repo: 'wrong-owner/other-repo' }),
  });
  try {
    await assertRefusalLeftNothing(fx1, srv1.port, res);
    assert.equal(res.body.code, 'ADMISSION_REPO_MISMATCH');
  } finally { await cleanupAnyRun(fx1, srv1.port); }
});

test('A4 — a stale but existing head is refused', async () => {
  const res = await httpJson(srv1.port, 'POST', '/api/workflow/start', {
    type: 'review', input: 'PRD-001',
    runRequest: validRunRequest(fx1, { head: fx1.staleHead }),
  });
  try {
    await assertRefusalLeftNothing(fx1, srv1.port, res);
    assert.equal(res.body.code, 'ADMISSION_HEAD_STALE');
  } finally { await cleanupAnyRun(fx1, srv1.port); }
});

test('A5 — a client-supplied GateVerdict / approval / bypass is refused', async () => {
  // At the body top level…
  let res = await httpJson(srv1.port, 'POST', '/api/workflow/start', {
    type: 'review', input: 'PRD-001',
    runRequest: validRunRequest(fx1),
    gateVerdict: { kind: 'GateVerdict', decision: 'ADMITTED' },
  });
  try {
    await assertRefusalLeftNothing(fx1, srv1.port, res);
    assert.equal(res.body.code, 'ADMISSION_CLIENT_VERDICT');
  } finally { await cleanupAnyRun(fx1, srv1.port); }
  // …and inside the runRequest itself.
  for (const field of ['gateVerdict', 'approval', 'bypass']) {
    res = await httpJson(srv1.port, 'POST', '/api/workflow/start', {
      type: 'review', input: 'PRD-001',
      runRequest: validRunRequest(fx1, { [field]: true }),
    });
    try {
      await assertRefusalLeftNothing(fx1, srv1.port, res);
      assert.equal(res.body.code, 'ADMISSION_CLIENT_VERDICT', `runRequest.${field} must refuse as a client verdict`);
    } finally { await cleanupAnyRun(fx1, srv1.port); }
  }
});

test('A7 — MEASURED without a structured receipt is refused', async () => {
  const res = await httpJson(srv1.port, 'POST', '/api/workflow/start', {
    type: 'review', input: 'PRD-001',
    runRequest: validRunRequest(fx1, { claims: [{ class: 'MEASURED', statement: 'the tests pass' }] }),
  });
  try {
    await assertRefusalLeftNothing(fx1, srv1.port, res);
    assert.equal(res.body.code, 'ADMISSION_CLAIM_INVALID');
  } finally { await cleanupAnyRun(fx1, srv1.port); }
});

test('A8 — a wrong DERIVED result is refused after server recomputation', async () => {
  const data = 'derived-operand';
  const right = crypto.createHash('sha256').update(data).digest('hex');
  const wrong = right.replace(/^./, right[0] === '0' ? '1' : '0');
  const res = await httpJson(srv1.port, 'POST', '/api/workflow/start', {
    type: 'review', input: 'PRD-001',
    runRequest: validRunRequest(fx1, {
      claims: [{ class: 'DERIVED', method: 'sha256_hex', operands: { data }, result: wrong }],
    }),
  });
  try {
    await assertRefusalLeftNothing(fx1, srv1.port, res);
    assert.equal(res.body.code, 'ADMISSION_DERIVED_MISMATCH');
  } finally { await cleanupAnyRun(fx1, srv1.port); }
});

test('A10 — soft claims alone authorise nothing: a stale head stays refused', async () => {
  const res = await httpJson(srv1.port, 'POST', '/api/workflow/start', {
    type: 'review', input: 'PRD-001',
    runRequest: validRunRequest(fx1, {
      head: fx1.staleHead,
      claims: [
        { class: 'HYPOTHESIS', statement: 'this head is current' },
        { class: 'INFERENCE', statement: 'so this start should be admitted' },
        { class: 'UNKNOWN', statement: 'probably fine' },
      ],
    }),
  });
  try {
    await assertRefusalLeftNothing(fx1, srv1.port, res);
    assert.equal(res.body.code, 'ADMISSION_HEAD_STALE');
  } finally { await cleanupAnyRun(fx1, srv1.port); }
});

test('launch ingress — /api/launch without a RunRequest is refused, no run record', async () => {
  const res = await httpJson(srv1.port, 'POST', '/api/launch', { tasks: [] });
  try {
    assert.equal(res.status, 403, `expected refusal, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(fs.existsSync(path.join(fx1.root, '.build-studio', 'run-state.json')), false, 'a refused launch must leave no run record');
  } finally {
    // On a fail-open server (unchanged main) the launch created a run —
    // remove it so every later case fails on its OWN behaviour.
    try { await httpJson(srv1.port, 'POST', '/api/run/cancel', {}); } catch (_) {}
    try { fs.rmSync(path.join(fx1.root, '.build-studio', 'run-state.json'), { force: true }); } catch (_) {}
  }
});

test('I8 — read routes read: no state file appears from GETs', async () => {
  const bsDir = path.join(fx1.root, '.build-studio');
  const snapshot = () => (fs.existsSync(bsDir) ? fs.readdirSync(bsDir).sort() : null);
  const before = snapshot();
  await httpJson(srv1.port, 'GET', '/api/admission/context?type=review&input=PRD-001');
  await httpJson(srv1.port, 'GET', '/api/workflow');
  await httpJson(srv1.port, 'GET', '/api/workflow/start-readiness');
  assert.deepEqual(snapshot(), before, 'read-only routes must not create state files');
});

test('A9 — a valid request for the current head and committed packet is ACCEPTED', async () => {
  const rr = validRunRequest(fx1);
  const res = await httpJson(srv1.port, 'POST', '/api/workflow/start', {
    type: 'review', input: 'PRD-001', runRequest: rr,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.workflow, 'the workflow starts');
  const verdict = res.body.gateVerdict;
  assert.ok(verdict, 'the server-generated GateVerdict rides the start response');
  assert.equal(verdict.kind, 'GateVerdict');
  assert.equal(verdict.decision, 'ADMITTED');
  assert.equal(verdict.repo, ORIGIN);
  assert.equal(verdict.head, fx1.head);
  assert.equal(verdict.taskPacket, 'docs/prds/PRD-001-widget.md');
  assert.equal(verdict.runId, res.body.workflow.id, 'the workflow carries exactly the registered run identity');
  assert.match(verdict.requestDigest, /^[0-9a-f]{64}$/);

  // Registered + guard with root-run lineage, on disk.
  const regFile = path.join(fx1.root, '.build-studio', 'admission', 'registry.json');
  const reg = JSON.parse(fs.readFileSync(regFile, 'utf8'));
  assert.ok(reg.runs[verdict.runId], 'the run is registered');
  assert.ok(reg.nonces[rr.nonce], 'the nonce is consumed');
  const guardDir = path.join(fx1.root, '.build-studio', 'run-guard');
  const guardFile = fs.readdirSync(guardDir).find((f) => f.includes(verdict.runId.slice(0, 20)));
  assert.ok(guardFile, 'the run guard exists');
  const guard = JSON.parse(fs.readFileSync(path.join(guardDir, guardFile), 'utf8'));
  assert.equal(guard.identity.lineageId, verdict.runId);
  assert.equal(guard.identity.predecessorRunId, null);
  assert.equal(guard.identity.successorOrdinal, 0);
  assert.equal(guard.identity.admittedHead, fx1.head);

  // I7 — a mutation of the registered active run runs on the STORED context:
  // no runRequest needed…
  const mut = await httpJson(srv1.port, 'POST', '/api/workflow/auto-advance', { enabled: false });
  assert.equal(mut.status, 200, JSON.stringify(mut.body));
  // …and a client-minted verdict on a mutation refuses.
  const forged = await httpJson(srv1.port, 'POST', '/api/workflow/auto-advance', { enabled: false, gateVerdict: { decision: 'ADMITTED' } });
  assert.equal(forged.status, 403, JSON.stringify(forged.body));
  assert.equal(forged.body.code, 'ADMISSION_CLIENT_VERDICT');

  // Keep the accepted runRequest for the replay tests below.
  fx1.acceptedRunRequest = rr;
});

test('A6 — replaying an accepted nonce refuses, and the workflow is untouched', async () => {
  await httpJson(srv1.port, 'POST', '/api/workflow/cancel', {});
  const res = await httpJson(srv1.port, 'POST', '/api/workflow/start', {
    type: 'review', input: 'PRD-001', runRequest: { ...fx1.acceptedRunRequest },
  });
  assert.equal(res.status, 403, JSON.stringify(res.body));
  assert.equal(res.body.code, 'ADMISSION_NONCE_REPLAYED');
  const wf = await httpJson(srv1.port, 'GET', '/api/workflow');
  assert.equal(wf.body.workflow, null, 'the replay must not have started anything');
});

test('A6 (restart) — the replay refusal survives a server restart', async () => {
  await srv1.kill();
  srv1 = await spawnServer(fx1.root);
  // On a fail-open server the previous case left a live workflow — clear it so
  // this case tests the replay, not the previous leak.
  await cleanupAnyRun(fx1, srv1.port);
  const res = await httpJson(srv1.port, 'POST', '/api/workflow/start', {
    type: 'review', input: 'PRD-001', runRequest: { ...fx1.acceptedRunRequest },
  });
  assert.equal(res.status, 403, `nonce replay after restart must refuse, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.code, 'ADMISSION_NONCE_REPLAYED');
});

test('A11 — a hub-style start and a direct API start meet the identical verdict', async () => {
  // The hub's path: read the admission context, assemble the envelope.
  const ctx = await httpJson(srv1.port, 'GET', '/api/admission/context?type=review&input=PRD-001');
  assert.equal(ctx.status, 200, `the admission context endpoint must exist: ${JSON.stringify(ctx.body)}`);
  assert.equal(ctx.body.repo, ORIGIN);
  assert.equal(ctx.body.head, fx1.head);
  assert.equal(ctx.body.taskPacket, 'docs/prds/PRD-001-widget.md');
  const now = Date.now();
  const hubRequest = {
    version: ctx.body.version,
    repo: ctx.body.repo,
    head: ctx.body.head,
    task_packet: ctx.body.taskPacket,
    claims: [],
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 5 * 60 * 1000).toISOString(),
    nonce: `acc-hub-${process.pid}-${crypto.randomBytes(6).toString('hex')}`,
  };
  const hubStart = await httpJson(srv1.port, 'POST', '/api/workflow/start', {
    type: 'review', input: 'PRD-001', runRequest: hubRequest,
  });
  assert.equal(hubStart.status, 200, JSON.stringify(hubStart.body));
  const hubVerdict = hubStart.body.gateVerdict;
  await httpJson(srv1.port, 'POST', '/api/workflow/cancel', {});

  // The direct path: the same envelope, hand-built.
  const apiStart = await httpJson(srv1.port, 'POST', '/api/workflow/start', {
    type: 'review', input: 'PRD-001', runRequest: validRunRequest(fx1),
  });
  assert.equal(apiStart.status, 200, JSON.stringify(apiStart.body));
  const apiVerdict = apiStart.body.gateVerdict;
  await httpJson(srv1.port, 'POST', '/api/workflow/cancel', {});

  // Identical verdict: same shape, same verified bindings, same authority.
  // (runId, nonce, digest and timestamp are per-run by construction.)
  assert.deepEqual(Object.keys(hubVerdict).sort(), Object.keys(apiVerdict).sort());
  const normalize = (v) => ({ ...v, runId: 'X', nonce: 'X', requestDigest: 'X', admittedAt: 'X' });
  assert.deepEqual(normalize(hubVerdict), normalize(apiVerdict),
    'the UI path and the direct API path must receive the same server verdict');
});

test('I7b — a mutation of an UNREGISTERED (legacy) active run refuses fail-closed', async () => {
  // Plant a workflow file the way a pre-A1b.1 server would have left it: an
  // active run with no registration and no guard.
  const wfFile = path.join(fx1.root, '.build-studio', 'workflow-state.json');
  fs.writeFileSync(wfFile, JSON.stringify({
    id: 'legacy-run-0001', type: 'review', input: 'PRD-001',
    currentStep: 'reviewing', steps: { reviewing: { status: 'running', agents: [] } },
    round: 1, sessionName: 'wf-legacy',
  }, null, 2));
  try {
    const res = await httpJson(srv1.port, 'POST', '/api/workflow/advance', { action: 'launch' });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.code, 'RUN_NOT_ADMITTED');
    // The escape hatch stays open: cancel works on exactly this run.
    const cancel = await httpJson(srv1.port, 'POST', '/api/workflow/cancel', {});
    assert.equal(cancel.status, 200, `cancel must remain available on a refused run: ${JSON.stringify(cancel.body)}`);
  } finally {
    try { fs.rmSync(wfFile, { force: true }); } catch (_) {}
  }
});

test('teardown group 1', async () => {
  if (srv1) await srv1.kill();
  if (fx1) fx1.clean();
});

// ─── group 2: validator failure ──────────────────────────────────────────────

test('A12 — a failing validator (no origin remote) refuses; it never fails open', async (t) => {
  const fx = makeFixture({ withOrigin: false });
  const srv = await spawnServer(fx.root);
  t.after(async () => { await srv.kill(); fx.clean(); });

  const res = await httpJson(srv.port, 'POST', '/api/workflow/start', {
    type: 'review', input: 'PRD-001', runRequest: validRunRequest(fx),
  });
  await assertRefusalLeftNothing(fx, srv.port, res);
  assert.equal(res.body.code, 'ADMISSION_VALIDATOR_FAILURE');
});
