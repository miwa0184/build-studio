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

// ── Raw pipe-pane stream rendering ──────────────────────────────────────────
const { renderPipePaneLog } = require('../tmux');

// A pipe-pane FILE is the raw stream a TUI wrote: \r is the line break and
// cursor-column escapes carry the spacing. A 52 KB real log held TWO \n bytes,
// so splitting on \n returned the whole file as one blob — which is what a
// reader sees as "confusing", and why every agent's log looked alike.
const RAW = '\x1b[?25lbanner\rline one\x1b[12Gtail\rline two\r\n\x1b[32mline three\x1b[0m\r';

test('a raw stream splits on CR, not just LF', () => {
  const out = renderPipePaneLog(RAW).split('\n');
  assert.ok(out.length >= 4, `expected several lines, got ${out.length}`);
  assert.ok(out.includes('line two'));
  assert.ok(out.includes('line three'));
});

test('cursor-column escapes become spacing instead of running words together', () => {
  // \x1b[12G positions the cursor — dropping it silently glues "one" to "tail".
  assert.match(renderPipePaneLog(RAW), /line one\s+tail/);
});

test('escape sequences and empty lines are removed', () => {
  const out = renderPipePaneLog(RAW);
  assert.doesNotMatch(out, /\x1b/);
  assert.ok(!out.split('\n').some(l => !l.trim()));
});

test('unicode survives — the agent UI carries meaning in it', () => {
  // stripAnsi() drops non-ASCII; this renderer must not.
  assert.match(renderPipePaneLog('⏺ Review: Brand §2.4\r'), /⏺ Review: Brand §2\.4/);
});

test('stripAnsi is NOT usable here — it deletes the line breaks', () => {
  // Pins WHY a separate function exists, so nobody merges them back.
  const { stripAnsi } = require('../tmux');
  // stripAnsi keeps only the one real \n in the fixture; the renderer recovers
  // every \r-delimited line, which is where the content actually is.
  assert.ok(renderPipePaneLog(RAW).split('\n').length > stripAnsi(RAW).split('\n').length);
});

test('modern terminal negotiation sequences are stripped, not left as garbage', () => {
  // A narrower CSI pattern ([0-9;?]*[a-zA-Z]) misses every sequence a current
  // terminal negotiates on startup, and they surfaced as literal junk at the
  // top of the log: "78[<u[>1u[>4;2m[>0q[?2026$p".
  const junk = '\x1b[>1u\x1b[>4;2m\x1b[>0q\x1b[?2026$p\x1b[<u\x1b7\x1b8real text\r';
  assert.equal(renderPipePaneLog(junk), 'real text');
});

test('OSC terminated by ST as well as BEL', () => {
  assert.equal(renderPipePaneLog('\x1b]0;title\x07kept\r'), 'kept');
  assert.equal(renderPipePaneLog('\x1b]0;title\x1b\\kept\r'), 'kept');
});
