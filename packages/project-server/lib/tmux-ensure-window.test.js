'use strict';

// A launch must survive the tmux session disappearing underneath it.
//
// Reaping an agent's window when its feedback lands ends the session if it was
// the last window, and tmux tears the server down asynchronously. A step
// launched in the same request as the reap can therefore see the session alive
// and then find the server gone a moment later. launch-studio hit this on
// 2026-08-01: the fix planner reported, its window was reaped, and the
// fix_execution launch that followed died on `no server running` — leaving the
// step half-started with an errored agent and no process.
//
// These drive a REAL tmux server on a throwaway socket, because the bug lives
// in tmux's own lifecycle (last window closes → server exits), which a stub
// cannot reproduce.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// ensureWindow is an admission BACKSTOP (A1b.1): it refuses to create the
// window an agent would be spawned into unless handed the verified context the
// admission service issued for the run. These tests mint a real context the
// same way the server does — registry entry + guard file + contextFor — on a
// throwaway state dir.
function admittedContext(t) {
  const statePath = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-adm-ctx-'));
  t.after(() => { try { fs.rmSync(statePath, { recursive: true, force: true }); } catch (_) {} });
  const { createAdmission } = require('./admission');
  const admission = createAdmission({ projectRoot: statePath, statePath });
  const runId = `test-run-${Date.now().toString(36)}`;
  admission.registry.admit({ nonce: `n-${runId}-0123456789abcdef`, runId, verdict: { kind: 'GateVerdict', runId }, lineage: { runId } });
  admission.runGuard.register(runId, { identity: { runId } });
  return admission.contextFor(runId);
}

const SOCKET = 'bs-ensure-window-test';
const tmux = (...args) => execFileSync('tmux', ['-L', SOCKET, ...args], { stdio: ['pipe', 'pipe', 'pipe'] }).toString();
const quiet = (...args) => { try { tmux(...args); } catch (_) {} };

/** createTmuxOps bound to the throwaway socket, so real sessions are untouched. */
function opsOnTestSocket() {
  const real = require('child_process');
  const originalExecFileSync = real.execFileSync;
  // Wrap execFileSync so every tmux call in tmux.js goes to our socket.
  real.execFileSync = (cmd, args, opts) => (cmd === 'tmux'
    ? originalExecFileSync(cmd, ['-L', SOCKET, ...args], opts)
    : originalExecFileSync(cmd, args, opts));
  delete require.cache[require.resolve('./tmux')];
  const { createTmuxOps } = require('./tmux');
  const ops = createTmuxOps({ name: 'test' });
  return { ops, restore: () => { real.execFileSync = originalExecFileSync; delete require.cache[require.resolve('./tmux')]; } };
}

test('ensureWindow creates the session when there is none', (t) => {
  const { ops, restore } = opsOnTestSocket();
  t.after(() => { quiet('kill-server'); restore(); });
  quiet('kill-server');

  const target = ops.ensureWindow('s1', 'first', process.cwd(), admittedContext(t));
  assert.equal(target, 's1:first');
  assert.equal(ops.hasSession('s1'), true);
});

test('ensureWindow adds a window to a live session', (t) => {
  const { ops, restore } = opsOnTestSocket();
  t.after(() => { quiet('kill-server'); restore(); });
  quiet('kill-server');

  const ctx = admittedContext(t);
  ops.ensureWindow('s1', 'first', process.cwd(), ctx);
  const target = ops.ensureWindow('s1', 'second', process.cwd(), ctx);
  assert.match(target, /^s1:\d+$/); // indexed, not named
  const windows = tmux('list-windows', '-t', 's1', '-F', '#{window_name}').trim().split('\n');
  assert.deepEqual(windows.sort(), ['first', 'second']);
});

test('ensureWindow survives the session dying between the check and the call', (t) => {
  // The launch-studio regression, reproduced: the session exists when the
  // launch starts, and is gone by the time the window is created.
  const { ops, restore } = opsOnTestSocket();
  t.after(() => { quiet('kill-server'); restore(); });
  quiet('kill-server');

  const ctx = admittedContext(t);
  ops.ensureWindow('s1', 'only-window', process.cwd(), ctx);
  assert.equal(ops.hasSession('s1'), true);

  // Reap the last window — exactly what the feedback handler now does. tmux
  // ends the session and shuts the server down.
  ops.killWindowAndChildren('s1:only-window');

  // The launch proceeds believing the session is alive. It must not throw.
  const target = ops.ensureWindow('s1', 'next-step', process.cwd(), ctx);
  assert.equal(target, 's1:next-step');
  assert.equal(ops.hasSession('s1'), true);
  assert.equal(tmux('list-windows', '-t', 's1', '-F', '#{window_name}').trim(), 'next-step');
});

test('a genuine window failure still surfaces', (t) => {
  // The recovery must not swallow errors that are not the race — a session
  // that is still standing when the call fails means something else is wrong.
  const { ops, restore } = opsOnTestSocket();
  t.after(() => { quiet('kill-server'); restore(); });
  quiet('kill-server');

  const ctx = admittedContext(t);
  ops.ensureWindow('s1', 'live', process.cwd(), ctx);
  assert.throws(
    () => ops.ensureWindow('s1', 'bad', '/definitely/not/a/directory/here', ctx),
    /.+/,
    'a bad cwd on a live session should throw',
  );
  assert.equal(ops.hasSession('s1'), true);
});

test('ensureWindow refuses without a verified admission context (backstop)', (t) => {
  const { ops, restore } = opsOnTestSocket();
  t.after(() => { quiet('kill-server'); restore(); });
  quiet('kill-server');

  // No context, a forged plain object, and a stale-looking copy all refuse —
  // only a context the admission service actually issued passes.
  for (const bad of [undefined, null, {}, { runId: 'x', verdict: {} }]) {
    assert.throws(
      () => ops.ensureWindow('s1', 'w', process.cwd(), bad),
      (e) => e.code === 'ADMISSION_BACKSTOP',
      'a missing or forged admission context must refuse the spawn window',
    );
  }
  assert.equal(ops.hasSession('s1'), false, 'a refused launch must not have created the session');
});
