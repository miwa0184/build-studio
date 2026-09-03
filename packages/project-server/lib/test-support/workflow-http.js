'use strict';

// Router-level harness for authority tests: mounts the real workflow router
// over a real project directory and speaks HTTP to it, so a test exercises the
// same boundary the hub and the auto-advance tick use. Agent launches are
// stubbed at the tmux seam only; prompt files, state writes and git are real.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { execFileSync } = require('child_process');

const { createWorkflowRouter } = require('../api/workflow');
const { loadConfig } = require('../config');
const { createStateManager } = require('../state');
const { createGitOps } = require('../git');
const { registerTestRoot } = require('./root-aggregate');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

/** Executables that must exist for a launch to reach the prompt-writing seam. */
function stubBinDir(names, extraScripts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-stub-bin-'));
  for (const name of names) {
    fs.writeFileSync(path.join(dir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  for (const [name, script] of Object.entries(extraScripts)) {
    fs.writeFileSync(path.join(dir, name), script, { mode: 0o755 });
  }
  return dir;
}

function withPath(dir, fn) {
  const before = process.env.PATH;
  process.env.PATH = `${dir}:${before}`;
  return Promise.resolve().then(fn).finally(() => { process.env.PATH = before; });
}

/**
 * Mount the router. `wf` is saved through the real state manager and the run
 * is registered as an admitted root so launches pass the A1b.1 backstop.
 */
async function mountWorkflow(root, wf, { onAdvance } = {}) {
  const config = loadConfig(root);
  const state = createStateManager(config, () => {});
  const app = express();
  app.use(express.json());
  if (onAdvance) {
    app.use((req, _res, next) => {
      if (req.method === 'POST' && req.path === '/api/workflow/advance') onAdvance(req.body || {});
      next();
    });
  }
  const tmuxOps = {
    killSessionAndDevPorts() {}, killWindowAndChildren() {}, isPaneAlive() { return false; },
    hasSession() { return false; }, ensureWindow(session, windowName) { return `${session}:${windowName}`; },
    sendKeys() {}, pipePaneToLog() {},
  };
  app.use('/api', createWorkflowRouter(config, state, createGitOps(config), tmuxOps, () => {}));
  registerTestRoot({ statePath: config.statePath, runId: wf.id, guard: state.runGuard });
  state.saveWorkflow(wf);
  const listener = http.createServer(app);
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  // The auto-advance tick posts back to config.port.
  config.port = port;
  const request = (method, url, body) => send(port, method, url, body);
  const close = async () => {
    await request('POST', '/api/workflow/auto-advance', { enabled: false }).catch(() => {});
    await new Promise((done) => listener.close(done));
  };
  return { port, config, state, request, close };
}

function send(port, method, url, body) {
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

async function waitFor(predicate, { timeoutMs = 8000, intervalMs = 50, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

module.exports = { git, stubBinDir, withPath, mountWorkflow, send, waitFor };
