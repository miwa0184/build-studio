'use strict';

// F5 — a symlink in a governed corpus must never vanish from the inventory.
//
// The governed-existing authority map is the complete list of Markdown the
// adoption reasons about. walkMarkdownPaths used to `continue` past every
// symlink, so a symlinked product-law file, or a symlinked directory full of
// specs, silently left the map — and validateGovernedSignoff, which walks the
// same way, would then accept a corpus it had never fully seen.
//
// The safe generic behaviour, pinned here: a Markdown-relevant symlink (a link
// named *.md, a link to a directory, or a link whose target cannot be
// resolved) fails the inventory closed with a typed error that names the path.
// Nothing is followed, inside or outside the repository. Symlinks to
// non-Markdown files are not Markdown-relevant and are still skipped.
// Standard onboarding is untouched by this rule.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { previewOnboard, onboardProject } = require('./onboard');
const { walkMarkdownPaths } = require('./detect/existing-docs');
const { loadGovernedAuthorityMap, validateGovernedSignoff } = require('./governed-onboarding');

const FIXTURE = path.resolve(__dirname, '..', 'test', 'fixtures', 'governed-existing-mobile');

function governedRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'governed-symlink-'));
  fs.cpSync(FIXTURE, root, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}

function clean(root) { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} }

const SYMLINK_CODE = 'AUTHORITY_INVENTORY_SYMLINK';

test('F5 — a symlinked Markdown file fails the governed inventory closed with its path', async () => {
  const root = governedRepo();
  try {
    fs.symlinkSync('README.md', path.join(root, 'LINKED_NOTES.md'));
    await assert.rejects(
      previewOnboard(root, { mode: 'governed-existing' }),
      (error) => error.code === SYMLINK_CODE && /LINKED_NOTES\.md/.test(error.message),
    );
    assert.throws(() => walkMarkdownPaths(root), (error) => error.code === SYMLINK_CODE);
  } finally { clean(root); }
});

test('F5 — a symlinked directory that could hold Markdown fails closed and is not followed', async () => {
  const root = governedRepo();
  try {
    fs.symlinkSync('generated', path.join(root, 'linked-docs'));
    await assert.rejects(
      previewOnboard(root, { mode: 'governed-existing' }),
      (error) => error.code === SYMLINK_CODE && /linked-docs/.test(error.message),
    );
  } finally { clean(root); }
});

test('F5 — a symlink pointing outside the repository is refused without being followed', async () => {
  const root = governedRepo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'governed-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'SECRET_LAW.md'), '# Outside the repo\n');
    fs.symlinkSync(outside, path.join(root, 'vendor-docs'));
    fs.symlinkSync(path.join(outside, 'SECRET_LAW.md'), path.join(root, 'IMPORTED_LAW.md'));
    let caught = null;
    try { walkMarkdownPaths(root); } catch (error) { caught = error; }
    assert.ok(caught, 'the inventory must refuse');
    assert.equal(caught.code, SYMLINK_CODE);
    assert.doesNotMatch(caught.message, /SECRET_LAW|Outside the repo/, 'the target must not be read or named');
  } finally { clean(root); clean(outside); }
});

test('F5 — a dangling symlink is refused rather than guessed at', () => {
  const root = governedRepo();
  try {
    fs.symlinkSync('does-not-exist', path.join(root, 'ghost'));
    assert.throws(() => walkMarkdownPaths(root), (error) => error.code === SYMLINK_CODE && /ghost/.test(error.message));
  } finally { clean(root); }
});

test('F5 — a symlink to a non-Markdown file is not Markdown-relevant and stays skipped', async () => {
  const root = governedRepo();
  try {
    fs.symlinkSync('AtlasMobileApp.swift', path.join(root, 'App.swift'));
    const preview = await previewOnboard(root, { mode: 'governed-existing' });
    assert.equal(preview.adoptionMode, 'governed-existing');
    assert.ok(!walkMarkdownPaths(root).includes('App.swift'));
  } finally { clean(root); }
});

test('F5 — an unreadable directory in the corpus fails the inventory closed', { skip: process.getuid && process.getuid() === 0 ? 'root ignores mode bits' : false }, async () => {
  const root = governedRepo();
  const locked = path.join(root, 'locked');
  try {
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, 'HIDDEN_SPEC.md'), '# hidden\n');
    fs.chmodSync(locked, 0o000);
    await assert.rejects(
      previewOnboard(root, { mode: 'governed-existing' }),
      (error) => error.code === 'AUTHORITY_INVENTORY_UNREADABLE' && /locked/.test(error.message),
    );
  } finally {
    try { fs.chmodSync(locked, 0o755); } catch {}
    clean(root);
  }
});

test('F5 — a Markdown symlink added after adoption fails owner signoff validation closed', async () => {
  const root = governedRepo();
  try {
    await onboardProject(root, { name: 'atlas-mobile', port: 3098, mode: 'governed-existing' });
    fs.writeFileSync(path.join(root, 'docs', 'onboarding', 'survey.md'), '# Survey\n');
    const inventory = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'onboarding', 'inventory.json'), 'utf8'));
    const map = loadGovernedAuthorityMap(root, inventory);
    assert.deepEqual(validateGovernedSignoff(root, map), { ok: true, errors: [] });
    fs.symlinkSync('PRODUCT_CONTROL.md', path.join(root, 'PRODUCT_LAW_MIRROR.md'));
    assert.throws(
      () => validateGovernedSignoff(root, map),
      (error) => error.code === SYMLINK_CODE && /PRODUCT_LAW_MIRROR\.md/.test(error.message),
    );
  } finally { clean(root); }
});

test('F5 — standard onboarding keeps its shallow, symlink-tolerant inventory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'standard-symlink-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { dev: 'vite' } }));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export {};\n');
    fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
    fs.symlinkSync('README.md', path.join(root, 'LINKED.md'));
    execFileSync('git', ['init', '-q'], { cwd: root });
    const preview = await previewOnboard(root);
    assert.equal(preview.adoptionMode, 'single-prd-mvp');
  } finally { clean(root); }
});
