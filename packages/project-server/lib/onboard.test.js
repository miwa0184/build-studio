'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const { execFileSync } = require('child_process');
const { onboardProject, previewOnboard } = require('./onboard');

// ─── Fixture builders ───────────────────────────────────────────────────────

function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  return root;
}

function clean(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}

const GOVERNED_FIXTURE = path.resolve(__dirname, '..', 'test', 'fixtures', 'governed-existing-mobile');

function makeGovernedRepo(extraFiles = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'governed-onboard-test-'));
  fs.cpSync(GOVERNED_FIXTURE, root, { recursive: true });
  for (const [rel, content] of Object.entries(extraFiles)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  return root;
}

function fileBytes(root, rels) {
  return Object.fromEntries(rels.map(rel => [rel, fs.readFileSync(path.join(root, rel))]));
}

const EXAMPLE_APP_SHAPE = {
  'package.json': JSON.stringify({
    name: 'fixture',
    scripts: { dev: 'vite', build: 'tsc -b && vite build' },
    dependencies: { react: '^18' },
    devDependencies: { vite: '^5' },
  }),
  'vite.config.ts': '',
  'README.md': '# Fixture\nA tiny single-PRD MVP.',
  'PRD.md': '# PRD\nThe vision.',
  'DESIGN.md': '# Design',
};

// ─── Validation: refusals ───────────────────────────────────────────────────

test('onboardProject: refuses when path does not exist', async () => {
  await assert.rejects(
    onboardProject('/tmp/this-path-does-not-exist-xyz', { name: 'x', port: 9999 }),
    /does not exist/i
  );
});

test('onboardProject: refuses when path is not a git repo', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-non-git-'));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  try {
    await assert.rejects(
      onboardProject(root, { name: 'x', port: 9999 }),
      /not.*git repo/i
    );
  } finally { clean(root); }
});

test('onboardProject: refuses when no recognizable project file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-empty-'));
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  fs.writeFileSync(path.join(root, 'README.md'), '');
  try {
    await assert.rejects(
      onboardProject(root, { name: 'x', port: 9999 }),
      /No recognizable project file/i
    );
  } finally { clean(root); }
});

// ─── Apple projects (Xcode / XcodeGen / SwiftPM) ────────────────────────────
//
// An Apple app has none of the seven original PROJECT_FILE_MARKERS: no
// package.json, and CocoaPods (Podfile) is optional and increasingly rare.
// Before these markers existed, detectAll threw NO_CODE at the marker gate —
// which runs BEFORE detectPreset — so `mobile-app` detection was unreachable
// for the exact repo shape Xcode produces.

const XCODEGEN_APP_SHAPE = {
  'project.yml': 'name: SudokuDaily\ntargets:\n  SudokuDaily:\n    type: application\n    platform: iOS\n',
  'SudokuDaily.xcodeproj/project.pbxproj': '// !$*UTF8*$!\n{ archiveVersion = 1; }\n',
  'SudokuDailyApp.swift': 'import SwiftUI\n@main struct SudokuDailyApp: App { var body: some Scene { WindowGroup {} } }\n',
  'README.md': '# Sudoku Daily',
};

test('previewOnboard: accepts an Xcode/XcodeGen app and reaches preset detection', async () => {
  const root = makeRepo(XCODEGEN_APP_SHAPE);
  try {
    const preview = await previewOnboard(root);
    assert.equal(preview.preset, 'mobile-app');
  } finally { clean(root); }
});

// ─── Mature governed-existing adoption ─────────────────────────────────────

const GOVERNED_PRODUCT_AUTHORITY = [
  'BASELINE_LOCK.md',
  'CURRENT_STATE.md',
  'FOUNDER_DECISION_REGISTER.md',
  'PRODUCT_CONTROL.md',
  'PRODUCT_NORTH_STAR.md',
  'SPEC-001-CORE.md',
  'SPEC-002-REWARD.md',
];

test('previewOnboard: governed-existing inventories the whole flat mature corpus and routes mobile-app', async () => {
  const root = makeGovernedRepo();
  try {
    const preview = await previewOnboard(root, { mode: 'governed-existing' });
    assert.equal(preview.preset, 'mobile-app');
    assert.equal(preview.adoptionMode, 'governed-existing');
    const paths = preview.existingDocs.map(d => d.path).sort();
    for (const rel of [
      'README.md', 'PRODUCT_CONTROL.md', 'CURRENT_STATE.md', 'BASELINE_LOCK.md',
      'PRODUCT_NORTH_STAR.md', 'FOUNDER_DECISION_REGISTER.md', 'BACKLOG.md',
      'ROADMAP.md', 'SPEC-001-CORE.md', 'SPEC-002-REWARD.md',
      'TASK_PACKET_ARCHIVE.md', 'AGENT_ROUTING_LEGACY.md',
      'WORKFLOW_STATE_ARCHIVE.md', '.claude/commands/legacy-builder.md',
      'generated/API_REFERENCE.md',
    ]) assert.ok(paths.includes(rel), `inventory omitted ${rel}`);
    assert.equal(preview.shape, 'governed-existing');
  } finally { clean(root); }
});

test('onboardProject: governed-existing writes an explicit authority map and retires legacy execution governance', async () => {
  const root = makeGovernedRepo();
  try {
    const result = await onboardProject(root, {
      name: 'atlas-mobile', port: 3097, mode: 'governed-existing',
    });
    const mapPath = path.join(root, 'docs', 'onboarding', 'authority-map.json');
    const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    assert.equal(map.mode, 'governed-existing');
    assert.ok(Array.isArray(map.rules) && map.rules.every(rule => Number.isInteger(rule.priority)));
    assert.deepEqual(map.productAuthorityAllowlist.slice().sort(), GOVERNED_PRODUCT_AUTHORITY);
    for (const entry of map.entries) {
      assert.ok(entry.source && entry.class && entry.disposition && entry.reason, JSON.stringify(entry));
      assert.ok(entry.matchedRule, `missing explicit rule provenance for ${entry.source}`);
      assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    }
    for (const rel of [
      'TASK_PACKET_ARCHIVE.md', 'AGENT_ROUTING_LEGACY.md', 'WORKFLOW_STATE_ARCHIVE.md',
      '.claude/commands/legacy-builder.md',
    ]) {
      const entry = map.entries.find(item => item.source === rel);
      assert.equal(entry.class, 'legacy_execution_governance');
      assert.equal(entry.disposition, 'retired-from-build-studio-runtime-authority');
    }
    assert.equal(map.entries.find(item => item.source === 'generated/API_REFERENCE.md').class, 'ignored/generated/runtime');
    assert.equal(result.authorityMap.entries.length, map.entries.length);
  } finally { clean(root); }
});

test('onboardProject: governed-existing preserves product law byte-identically and creates no competing hierarchy', async () => {
  const root = makeGovernedRepo();
  const before = fileBytes(root, GOVERNED_PRODUCT_AUTHORITY);
  const legacyCommand = '.claude/commands/legacy-builder.md';
  const legacyCommandBefore = fs.readFileSync(path.join(root, legacyCommand));
  try {
    await onboardProject(root, { name: 'atlas-mobile', port: 3097, mode: 'governed-existing' });
    for (const rel of GOVERNED_PRODUCT_AUTHORITY) {
      assert.deepEqual(fs.readFileSync(path.join(root, rel)), before[rel], `${rel} changed`);
    }
    assert.deepEqual(
      fs.readFileSync(path.join(root, legacyCommand)),
      legacyCommandBefore,
      'legacy execution history must be preserved byte-identically even though it is retired from runtime authority',
    );
    for (const rel of [
      'docs/vision.md', 'docs/project-state.md', 'docs/adrs', 'docs/prds',
      'docs/backlog', 'docs/asset-register.md', 'docs/knowledge.yaml', '.claude/skills',
    ]) assert.equal(fs.existsSync(path.join(root, rel)), false, `governed adoption created ${rel}`);
    const cfg = yaml.load(fs.readFileSync(path.join(root, '.build-studio', 'config.yaml'), 'utf8'));
    assert.equal(cfg.onboarding.mode, 'governed-existing');
    assert.equal(cfg.onboarding.authority_map, 'docs/onboarding/authority-map.json');
    const agentInstruction = fs.readFileSync(path.join(root, '.build-studio', 'agent-instructions.md'), 'utf8');
    assert.match(agentInstruction, /Build Studio owns.*pipeline.*roles.*run-state.*QA.*acceptance.*egress/is);
    assert.match(agentInstruction, /product_authority/);
    assert.match(agentInstruction, /legacy_execution_governance.*retired/is);
  } finally { clean(root); }
});

test('governed-existing classification is configurable and rejects ambiguous equal-priority authority', async () => {
  const root = makeGovernedRepo({ 'CANON.md': '# Canon\nA deliberately non-standard product-law filename.\n' });
  try {
    const customRule = {
      id: 'owner-configured-canon', priority: 15, class: 'product_authority',
      patterns: ['**/CANON.md'], disposition: 'preserve-byte-identical-product-authority',
      reason: 'Owner configured this corpus as product law.',
    };
    const preview = await previewOnboard(root, { mode: 'governed-existing', authorityRules: [customRule] });
    assert.equal(preview.authorityMap.entries.find(entry => entry.source === 'CANON.md').class, 'product_authority');

    await assert.rejects(
      previewOnboard(root, {
        mode: 'governed-existing',
        authorityRules: [
          customRule,
          { ...customRule, id: 'conflicting-canon', class: 'product_context' },
        ],
      }),
      (error) => error.code === 'AUTHORITY_CLASSIFICATION_AMBIGUOUS' && /CANON\.md/.test(error.message),
    );
  } finally { clean(root); }
});

test('governed-existing refuses the opt-in CLAUDE/AGENTS migration because source governance is immutable', async () => {
  const root = makeGovernedRepo({ 'CLAUDE.md': '# Legacy execution instructions\n' });
  try {
    await assert.rejects(
      onboardProject(root, { name: 'atlas-mobile', port: 3097, mode: 'governed-existing', migrateAgentsMd: true }),
      (error) => error.code === 'GOVERNED_SOURCE_MUTATION_REFUSED',
    );
  } finally { clean(root); }
});

test('governed-existing refuses reserved artifact collisions without overwriting source files', async () => {
  const existing = '{"owner":"existing"}\n';
  const root = makeGovernedRepo({ 'docs/onboarding/authority-map.json': existing });
  try {
    await assert.rejects(
      onboardProject(root, {
        name: 'atlas-mobile', port: 3097, mode: 'governed-existing',
      }),
      (error) => error.code === 'GOVERNED_ARTIFACT_EXISTS' && /authority-map\.json/.test(error.message),
    );
    assert.equal(fs.readFileSync(path.join(root, 'docs/onboarding/authority-map.json'), 'utf8'), existing);
    assert.equal(fs.existsSync(path.join(root, '.build-studio', 'config.yaml')), false);
  } finally { clean(root); }
});

test('previewOnboard: accepts a SwiftPM package past the marker gate', async () => {
  const root = makeRepo({
    'Package.swift': '// swift-tools-version:5.9\nimport PackageDescription\nlet package = Package(name: "Kit")\n',
    'Sources/Kit/Kit.swift': 'public struct Kit {}\n',
  });
  try {
    await previewOnboard(root);
  } catch (e) {
    assert.notEqual(e.code, 'NO_CODE', 'Package.swift must satisfy the recognizable-code gate');
  } finally { clean(root); }
});

test('previewOnboard: a bare .xcworkspace also satisfies the marker gate', async () => {
  const root = makeRepo({
    'SudokuDaily.xcworkspace/contents.xcworkspacedata': '<?xml version="1.0"?><Workspace version="1.0"></Workspace>\n',
    'App.swift': 'import SwiftUI\n',
  });
  try {
    const preview = await previewOnboard(root);
    assert.equal(preview.preset, 'mobile-app');
  } finally { clean(root); }
});

test('onboardProject: refuses when .build-studio/config.yaml already exists (409 shape)', async () => {
  const root = makeRepo(EXAMPLE_APP_SHAPE);
  fs.mkdirSync(path.join(root, '.build-studio'));
  fs.writeFileSync(path.join(root, '.build-studio', 'config.yaml'), 'name: existing\n');
  try {
    await assert.rejects(
      onboardProject(root, { name: 'x', port: 9999 }),
      (e) => e.code === 'CONFIG_EXISTS' && /already initialized/i.test(e.message)
    );
  } finally { clean(root); }
});

test('onboardProject: refuses monorepo shape (PRD-001 v1 doesn\'t support)', async () => {
  const root = makeRepo({
    'package.json': JSON.stringify({ name: 'monorepo', workspaces: ['apps/*'] }),
    'apps/web/package.json': '{}',
    'apps/api/package.json': '{}',
  });
  try {
    await assert.rejects(
      onboardProject(root, { name: 'x', port: 9999 }),
      (e) => e.code === 'MONOREPO_NOT_SUPPORTED'
    );
  } finally { clean(root); }
});

// ─── Successful onboarding (example-app shape) ───────────────────────────────

test('onboardProject: writes config.yaml with detected values', async () => {
  const root = makeRepo(EXAMPLE_APP_SHAPE);
  try {
    const result = await onboardProject(root, { name: 'desk-fixture', port: 3099 });
    const cfg = yaml.load(fs.readFileSync(path.join(root, '.build-studio', 'config.yaml'), 'utf8'));
    assert.equal(cfg.name, 'desk-fixture');
    assert.equal(cfg.port, 3099);
    assert.equal(cfg.preset, 'static-site');
    assert.equal(cfg.dev_commands.length, 1);
    assert.equal(cfg.dev_commands[0].cmd, 'npm run dev');
    assert.equal(cfg.dev_commands[0].type, 'vite');
    assert.equal(result.preset, 'static-site');
  } finally { clean(root); }
});

test('onboardProject: writes .claude/commands templates', async () => {
  const root = makeRepo(EXAMPLE_APP_SHAPE);
  try {
    await onboardProject(root, { name: 'desk', port: 3099 });
    const cmds = fs.readdirSync(path.join(root, '.claude', 'commands'));
    assert.ok(cmds.length >= 10, 'should write all role command templates');
    assert.ok(cmds.includes('pm.md'));
    assert.ok(cmds.includes('qa.md'));
  } finally { clean(root); }
});

test('onboardProject: writes inventory.json with required schema fields', async () => {
  const root = makeRepo(EXAMPLE_APP_SHAPE);
  try {
    await onboardProject(root, { name: 'desk', port: 3099 });
    const inv = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'onboarding', 'inventory.json'), 'utf8'));
    assert.ok(inv.detectedAt);
    assert.equal(inv.preset, 'static-site');
    assert.ok(inv.deployment);
    assert.ok(Array.isArray(inv.devCommands));
    assert.ok(Array.isArray(inv.existingDocs));
    assert.ok(typeof inv.claudeMdPresent === 'boolean');
    assert.ok(typeof inv.agentsMdPresent === 'boolean');
    assert.ok(typeof inv.specsDirPresent === 'boolean');
    assert.equal(inv.shape, 'single-prd-mvp');
  } finally { clean(root); }
});

test('onboardProject: creates empty workflow scaffolding (prds, learnings, tmp) with .gitkeep', async () => {
  const root = makeRepo(EXAMPLE_APP_SHAPE);
  try {
    await onboardProject(root, { name: 'desk', port: 3099 });
    assert.ok(fs.existsSync(path.join(root, 'docs', 'prds', '.gitkeep')));
    assert.ok(fs.existsSync(path.join(root, 'docs', 'learnings', 'workflow', '.gitkeep')));
    assert.ok(fs.existsSync(path.join(root, 'tmp')));
  } finally { clean(root); }
});

// ─── Files explicitly NOT created ──────────────────────────────────────────

test('onboardProject: does NOT create vision.md or project-state.md (workflow outputs)', async () => {
  const root = makeRepo(EXAMPLE_APP_SHAPE);
  try {
    await onboardProject(root, { name: 'desk', port: 3099 });
    assert.ok(!fs.existsSync(path.join(root, 'docs', 'vision.md')), 'vision.md must not be scaffolded');
    assert.ok(!fs.existsSync(path.join(root, 'docs', 'project-state.md')), 'project-state.md must not be scaffolded');
    assert.ok(!fs.existsSync(path.join(root, 'docs', 'inputs')), 'docs/inputs/ must not be created');
    assert.ok(!fs.existsSync(path.join(root, 'docs', 'adrs')), 'docs/adrs/ must not be pre-created');
  } finally { clean(root); }
});

test('onboardProject: does NOT overwrite an existing CLAUDE.md', async () => {
  const root = makeRepo({ ...EXAMPLE_APP_SHAPE, 'CLAUDE.md': 'EXISTING CONTENT — do not touch' });
  try {
    await onboardProject(root, { name: 'desk', port: 3099 });
    const after = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
    assert.equal(after, 'EXISTING CONTENT — do not touch');
  } finally { clean(root); }
});

test('onboardProject: does NOT create CLAUDE.md when absent (workflow synthesizes it)', async () => {
  const root = makeRepo(EXAMPLE_APP_SHAPE);
  try {
    await onboardProject(root, { name: 'desk', port: 3099 });
    assert.ok(!fs.existsSync(path.join(root, 'CLAUDE.md')), 'no CLAUDE.md written by button — workflow handles it');
  } finally { clean(root); }
});

// ─── AGENTS.md migration (opt-in via migrateAgentsMd) ──────────────────────

test('onboardProject: migrateAgentsMd moves CLAUDE.md content to AGENTS.md + stub', async () => {
  const root = makeRepo({ ...EXAMPLE_APP_SHAPE, 'CLAUDE.md': 'EXISTING CONTENT — preserve me' });
  try {
    await onboardProject(root, { name: 'desk', port: 3099, migrateAgentsMd: true });
    assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), 'EXISTING CONTENT — preserve me');
    const stub = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
    assert.ok(stub.includes('@AGENTS.md'), 'CLAUDE.md is now the import stub');
  } finally { clean(root); }
});

test('onboardProject: migrateAgentsMd=false (default) leaves CLAUDE.md untouched', async () => {
  const root = makeRepo({ ...EXAMPLE_APP_SHAPE, 'CLAUDE.md': 'EXISTING CONTENT — do not touch' });
  try {
    await onboardProject(root, { name: 'desk', port: 3099, migrateAgentsMd: false });
    assert.equal(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), 'EXISTING CONTENT — do not touch');
    assert.ok(!fs.existsSync(path.join(root, 'AGENTS.md')));
  } finally { clean(root); }
});

test('onboardProject: migrateAgentsMd with BOTH files present reconciles nothing', async () => {
  const root = makeRepo({ ...EXAMPLE_APP_SHAPE, 'CLAUDE.md': 'REAL CLAUDE', 'AGENTS.md': 'REAL AGENTS' });
  try {
    await onboardProject(root, { name: 'desk', port: 3099, migrateAgentsMd: true });
    assert.equal(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), 'REAL CLAUDE');
    assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), 'REAL AGENTS');
  } finally { clean(root); }
});

test('previewOnboard: reports the AGENTS.md migration plan without writing', async () => {
  const root = makeRepo({ ...EXAMPLE_APP_SHAPE, 'CLAUDE.md': 'EXISTING CONTENT' });
  try {
    const preview = await previewOnboard(root);
    assert.equal(preview.agentsMdMigration.action, 'migrate');
    assert.ok(!fs.existsSync(path.join(root, 'AGENTS.md')), 'preview must not write');
    assert.equal(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), 'EXISTING CONTENT');
  } finally { clean(root); }
});

// ─── Per-file no-overwrite for .claude/commands/ ───────────────────────────

test('onboardProject: skips an existing .claude/commands/<role>.md file', async () => {
  const root = makeRepo(EXAMPLE_APP_SHAPE);
  fs.mkdirSync(path.join(root, '.claude', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'commands', 'pm.md'), 'CUSTOM PM ROLE');
  try {
    const result = await onboardProject(root, { name: 'desk', port: 3099 });
    const after = fs.readFileSync(path.join(root, '.claude', 'commands', 'pm.md'), 'utf8');
    assert.equal(after, 'CUSTOM PM ROLE', 'existing pm.md must be preserved');
    // Other roles should still be written.
    assert.ok(fs.existsSync(path.join(root, '.claude', 'commands', 'qa.md')));
    // Result should report the skip for transparency.
    assert.ok(Array.isArray(result.skipped), 'result must report skipped files');
    assert.ok(result.skipped.includes('.claude/commands/pm.md'));
  } finally { clean(root); }
});

// ─── Git state untouched ────────────────────────────────────────────────────

test('onboardProject: makes no git commits and no git stages', async () => {
  const root = makeRepo(EXAMPLE_APP_SHAPE);
  // Capture pre-state
  const headBefore = (() => {
    try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); }
    catch { return 'EMPTY'; }
  })();
  try {
    await onboardProject(root, { name: 'desk', port: 3099 });
    const headAfter = (() => {
      try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); }
      catch { return 'EMPTY'; }
    })();
    assert.equal(headAfter, headBefore, 'no commits should have been made');
    // status --porcelain must show ONLY untracked entries (no staged ones).
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).toString();
    for (const line of status.split('\n').filter(Boolean)) {
      assert.match(line, /^\?\?/, `every changed file must be untracked, got: ${line}`);
    }
  } finally { clean(root); }
});

// ─── .gitignore patterns appended (regression test for example-app pilot) ──

test('onboardProject: appends build-studio runtime patterns to existing .gitignore', async () => {
  const root = makeRepo({ ...EXAMPLE_APP_SHAPE, '.gitignore': 'node_modules\ndist\n' });
  try {
    await onboardProject(root, { name: 'desk', port: 3099 });
    const gi = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    assert.match(gi, /node_modules/, 'existing entries preserved');
    assert.match(gi, /dist/, 'existing entries preserved');
    assert.match(gi, /\.build-studio\/workflow-state\.json/);
    assert.match(gi, /\.build-studio\/snapshots\//);
    assert.match(gi, /docs\/agent-status\.json/);
    assert.match(gi, /^prompt-\*\.txt$/m);
    assert.match(gi, /^start-\*\.sh$/m);
    assert.match(gi, /\.claude\/scheduled_tasks\.lock/);
  } finally { clean(root); }
});

test('onboardProject: idempotent — re-adding patterns already present does not duplicate', async () => {
  const root = makeRepo({
    ...EXAMPLE_APP_SHAPE,
    '.gitignore': 'node_modules\n.build-studio/workflow-state.json\n.build-studio/snapshots/\ndocs/agent-status.json\nprompt-*.txt\nstart-*.sh\nstart.sh\nTASK.md\ntmp/\n.build-studio/run-state.json\n.build-studio/*.bak*\n.build-studio/local.json\n.build-studio/*-cache.json\n.claude/scheduled_tasks.lock\n.claude/settings.local.json\ndocs/pr-evidence/**/*.png\ndocs/pr-evidence/**/*.jpg\ndocs/pr-evidence/**/*.jpeg\ndocs/pr-evidence/**/*.gif\ndocs/pr-evidence/**/*.pdf\n',
  });
  try {
    const result = await onboardProject(root, { name: 'desk', port: 3099 });
    assert.ok(result.skipped.some((s) => s.startsWith('.gitignore')), 'should report .gitignore as skipped when nothing to add');
    const gi = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    const occurrences = (gi.match(/\.build-studio\/workflow-state\.json/g) || []).length;
    assert.equal(occurrences, 1, 'pattern must appear exactly once even after re-onboarding');
  } finally { clean(root); }
});

// ─── previewOnboard (dry-run) ──────────────────────────────────────────────

test('previewOnboard: returns detected config without writing anything', async () => {
  const root = makeRepo(EXAMPLE_APP_SHAPE);
  try {
    const preview = await previewOnboard(root);
    assert.equal(preview.preset, 'static-site');
    assert.ok(preview.deployment);
    assert.ok(Array.isArray(preview.devCommands));
    // Nothing was written.
    assert.ok(!fs.existsSync(path.join(root, '.build-studio')), 'preview must not create config dir');
    assert.ok(!fs.existsSync(path.join(root, 'docs', 'onboarding')), 'preview must not create inventory');
  } finally { clean(root); }
});

test('previewOnboard: refuses with same shape errors as onboardProject', async () => {
  await assert.rejects(
    previewOnboard('/tmp/nope-this-does-not-exist'),
    /does not exist/i
  );
});

test('onboardProject: gitignores visual evidence but keeps the prose beside it', async () => {
  // Evidence is a run artifact — the AC verifier checks the working tree, so the
  // files only need to exist on disk. Committing them is what grew one measured
  // repository to 1 060 MB of screenshots. The .md/.txt/.json notes stay tracked:
  // they are small and they are the part that gets read.
  const root = makeRepo(EXAMPLE_APP_SHAPE);
  try {
    await onboardProject(root, { name: 'desk', port: 3098 });
    const gi = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'pdf']) {
      assert.ok(gi.includes(`docs/pr-evidence/**/*.${ext}`), `missing ignore for .${ext}`);
    }
    assert.ok(!/docs\/pr-evidence\/\*\*\/\*\.md/.test(gi), 'evidence prose must stay tracked');
    assert.ok(!/^docs\/pr-evidence\/?$/m.test(gi), 'the directory itself must not be ignored wholesale');
  } finally { clean(root); }
});
