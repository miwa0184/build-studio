'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createGitOps } = require('./git');


// ── Argument-list form (2026-08-15) ────────────────────────────────────────
const { execFileSync } = require('child_process');
const os = require('os');
const fsx = require('fs');
const pathx = require('path');

test('a branch name containing shell metacharacters cannot execute anything', () => {
  // The whole point: in a shell string, `git branch -D "x$(touch pwned)"` runs
  // the substitution. In argv form it is just a (bad) branch name.
  const root = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'gitops-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
  fsx.writeFileSync(pathx.join(root, 'a.txt'), 'x');
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });

  const ops = createGitOps({ projectRoot: root, worktreesPath: pathx.join(root, '.wt') });
  const marker = pathx.join(root, 'pwned');
  // Each of these would run the substitution under a shell.
  ops.branchExists(`x"; touch ${marker}; echo "`);
  ops.deleteBranch(`x$(touch ${marker})`, true);
  ops.commitsAhead(`x\`touch ${marker}\``);

  assert.equal(fsx.existsSync(marker), false, 'shell substitution executed');
  fsx.rmSync(root, { recursive: true, force: true });
});

test('ordinary git reads still work through the argv form', () => {
  const root = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'gitops-ok-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
  fsx.writeFileSync(pathx.join(root, 'a.txt'), 'x');
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });

  const ops = createGitOps({ projectRoot: root, worktreesPath: pathx.join(root, '.wt') });
  assert.equal(ops.branchExists('main'), true);
  assert.equal(ops.branchExists('no-such-branch'), false);
  assert.equal(ops.commitsAhead('main', 'main'), 0);
  fsx.rmSync(root, { recursive: true, force: true });
});
