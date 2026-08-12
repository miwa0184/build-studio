'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTerminalRouter } = require('./terminal');

// Minimal harness: invoke the GET /workflow/:role handler directly.
function callRoute({ paneOutput, logsPath, window = 'brand-r3', status = 'done' }) {
  const wf = {
    id: 'review-2026-01-01T00-00-00',
    sessionName: 'wf-2026-01-01T00-00-00',
    currentStep: 'reviewing',
    steps: { reviewing: { agents: [{ role: 'Brand', window, status }] } },
  };
  const state = { loadWorkflow: () => wf, loadRun: () => null };
  const tmuxOps = { capturePane: () => paneOutput };
  const router = createTerminalRouter({ logsPath }, state, tmuxOps);
  const layer = router.stack.find(l => l.route && l.route.path === '/workflow/:role');
  let body = null;
  layer.route.stack[0].handle(
    { params: { role: 'Brand' }, query: {} },
    { json: (b) => { body = b; } },
  );
  return body;
}

test('a live pane is returned as-is', () => {
  const r = callRoute({ paneOutput: 'agent is working', logsPath: os.tmpdir() });
  assert.equal(r.source, 'pane');
  assert.match(r.log, /agent is working/);
});

test('a reaped pane falls back to the log FILE, not an empty string', () => {
  // The bug: a finished agent's window is reaped the moment it reports, so the
  // pane is empty and the hub rendered "No output yet — agent starting..." —
  // a completed review read as one that never began.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termlog-'));
  fs.writeFileSync(path.join(dir, 'brand-r3-review-2026-01-01T00-00-00.log'), 'line one\nfinal report here\n');
  const r = callRoute({ paneOutput: '', logsPath: dir });
  assert.equal(r.source, 'file');
  assert.match(r.log, /final report here/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a whitespace-only pane counts as empty and still falls back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termlog-'));
  fs.writeFileSync(path.join(dir, 'brand-r3-review-2026-01-01T00-00-00.log'), 'recorded output\n');
  const r = callRoute({ paneOutput: '   \n  \n', logsPath: dir });
  assert.equal(r.source, 'file');
  assert.match(r.log, /recorded output/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('no pane and no file degrades to empty rather than throwing', () => {
  const r = callRoute({ paneOutput: '', logsPath: path.join(os.tmpdir(), 'does-not-exist-'+Date.now()) });
  assert.equal(r.log, '');
});
