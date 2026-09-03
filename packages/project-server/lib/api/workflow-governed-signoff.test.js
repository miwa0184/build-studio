'use strict';

// F3 — the governed owner-signoff boundary, exercised over HTTP against a real
// git repository.
//
// The adoption commit is the only commit governed onboarding ever makes, and
// it is scoped to six paths. Everything here proves the refusal happens BEFORE
// any `git add` or `git commit`, and that a refusal leaves the index and the
// working tree exactly as it found them: a pre-staged file outside the
// allowlist is neither committed nor unstaged; a governed source that went
// missing or changed after inventory stops the commit; and a Markdown symlink
// that appeared after adoption fails the same gate closed (F5 at this seam).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { onboardProject } = require('../onboard');
const { git, mountWorkflow } = require('../test-support/workflow-http');

const FIXTURE = path.resolve(__dirname, '..', '..', 'test', 'fixtures', 'governed-existing-mobile');
const ALLOWLIST = [
  '.build-studio/config.yaml', '.build-studio/agent-instructions.md', '.gitignore',
  'docs/onboarding/inventory.json', 'docs/onboarding/authority-map.json', 'docs/onboarding/survey.md',
];

async function adoptedRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'governed-signoff-http-'));
  fs.cpSync(FIXTURE, root, { recursive: true });
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Governed Signoff']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  await onboardProject(root, { name: 'atlas-mobile', port: 3099, mode: 'governed-existing' });
  fs.writeFileSync(path.join(root, 'docs', 'onboarding', 'survey.md'), '# Adoption survey\n\nAuthority map reviewed.\n');
  return root;
}

function signoffWorkflow() {
  return {
    id: 'governed-signoff-run', type: 'onboarding', input: '', onboardingMode: 'governed-existing',
    currentStep: 'owner_signoff', round: 1, feedback: [], autoAdvance: false,
    sessionName: 'wf-governed-signoff', createdAt: new Date().toISOString(),
    steps: {
      discovery: { status: 'completed', agents: [] },
      owner_signoff: { status: 'pending', agents: [] },
    },
  };
}

function repoSnapshot(root) {
  return {
    index: git(root, ['diff', '--cached', '--name-only']),
    status: git(root, ['status', '--porcelain', '--untracked-files=all']),
    head: headOf(root),
  };
}

function headOf(root) {
  try { return git(root, ['rev-parse', '--verify', 'HEAD']); } catch { return null; }
}

function clean(root) { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} }

test('F3 — a file pre-staged outside the allowlist refuses signoff before any git add or commit', async () => {
  const root = await adoptedRepo();
  const server = await mountWorkflow(root, signoffWorkflow());
  try {
    git(root, ['add', '--', 'PRODUCT_CONTROL.md']);
    const before = repoSnapshot(root);
    assert.equal(before.index, 'PRODUCT_CONTROL.md');
    assert.equal(before.head, null, 'the fixture must start with no commits');

    const res = await server.request('POST', '/api/workflow/advance', { action: 'approve' });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'GOVERNED_SIGNOFF_SCOPE_REFUSED');
    assert.match(res.body.error, /PRODUCT_CONTROL\.md/);

    const after = repoSnapshot(root);
    assert.deepEqual(after, before, 'refusal must not stage, unstage, or commit anything');
    const wf = server.state.loadWorkflow();
    assert.equal(wf.currentStep, 'owner_signoff');
    assert.notEqual(wf.steps.owner_signoff.status, 'completed');
  } finally { await server.close(); clean(root); }
});

test('F3 — a governed source missing after inventory refuses signoff and mutates nothing', async () => {
  const root = await adoptedRepo();
  const server = await mountWorkflow(root, signoffWorkflow());
  try {
    fs.rmSync(path.join(root, 'BACKLOG.md'));
    const before = repoSnapshot(root);
    assert.equal(before.index, '');

    const res = await server.request('POST', '/api/workflow/advance', { action: 'approve' });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'GOVERNED_SIGNOFF_REFUSED');
    assert.ok((res.body.authorityErrors || []).some((e) => /BACKLOG\.md.*missing/.test(e)), JSON.stringify(res.body));

    assert.deepEqual(repoSnapshot(root), before);
    assert.equal(headOf(root), null, 'no adoption commit may exist after a refusal');
  } finally { await server.close(); clean(root); }
});

test('F3 — a governed source changed after inventory refuses signoff and mutates nothing', async () => {
  const root = await adoptedRepo();
  const server = await mountWorkflow(root, signoffWorkflow());
  try {
    fs.appendFileSync(path.join(root, 'PRODUCT_CONTROL.md'), '\nUnauthorized rewrite.\n');
    const before = repoSnapshot(root);

    const res = await server.request('POST', '/api/workflow/advance', { action: 'approve' });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'GOVERNED_SIGNOFF_REFUSED');
    assert.ok((res.body.authorityErrors || []).some((e) => /PRODUCT_CONTROL\.md.*changed/.test(e)), JSON.stringify(res.body));

    assert.deepEqual(repoSnapshot(root), before);
    assert.equal(headOf(root), null);
    assert.equal(server.state.loadWorkflow().currentStep, 'owner_signoff');
  } finally { await server.close(); clean(root); }
});

test('F3/F5 — a Markdown symlink that appeared after adoption fails signoff closed with a typed error', async () => {
  const root = await adoptedRepo();
  const server = await mountWorkflow(root, signoffWorkflow());
  try {
    fs.symlinkSync('PRODUCT_CONTROL.md', path.join(root, 'PRODUCT_LAW_MIRROR.md'));
    const before = repoSnapshot(root);

    const res = await server.request('POST', '/api/workflow/advance', { action: 'approve' });
    assert.ok(res.status >= 400, JSON.stringify(res.body));
    assert.equal(res.body.code, 'AUTHORITY_INVENTORY_SYMLINK');
    assert.match(res.body.error, /PRODUCT_LAW_MIRROR\.md/);

    assert.deepEqual(repoSnapshot(root), before);
    assert.equal(headOf(root), null);
  } finally { await server.close(); clean(root); }
});

test('F3 — a clean governed signoff commits exactly the allowlist and nothing else (the gate is not vacuous)', async () => {
  const root = await adoptedRepo();
  const server = await mountWorkflow(root, signoffWorkflow());
  try {
    // An unrelated UNSTAGED change must be left alone, not swept into the commit.
    fs.writeFileSync(path.join(root, 'scratch.txt'), 'not part of adoption\n');

    const res = await server.request('POST', '/api/workflow/advance', { action: 'approve' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const head = headOf(root);
    assert.ok(head, 'the adoption commit must exist');
    const committed = git(root, ['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean).sort();
    assert.ok(committed.length > 0);
    for (const rel of committed) assert.ok(ALLOWLIST.includes(rel), `${rel} is outside the adoption allowlist`);
    assert.ok(!committed.includes('scratch.txt'));
    assert.ok(!committed.includes('PRODUCT_CONTROL.md'), 'product law is preserved, never committed by adoption');
    assert.match(git(root, ['status', '--porcelain', '--untracked-files=all']), /scratch\.txt/);
    assert.equal(server.state.loadWorkflow().currentStep, 'completed');
  } finally { await server.close(); clean(root); }
});
