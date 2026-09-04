'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig, loadLocalOverrides, saveLocalOverrides, CLI_DEFAULTS } = require('./config');

function makeProject(configYaml, localJson) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'config-local-test-'));
  fs.mkdirSync(path.join(root, '.build-studio'), { recursive: true });
  fs.writeFileSync(path.join(root, '.build-studio', 'config.yaml'), configYaml);
  if (localJson !== undefined) {
    fs.writeFileSync(path.join(root, '.build-studio', 'local.json'), localJson);
  }
  return root;
}

function clean(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}

const BASE_YAML = 'name: t\nport: 3999\n';

test('cli defaults: no cli block anywhere → claude, null models', () => {
  const root = makeProject(BASE_YAML);
  try {
    const cfg = loadConfig(root);
    assert.deepEqual(cfg.cli, CLI_DEFAULTS);
    assert.equal(cfg.cli.default, 'claude');
  } finally { clean(root); }
});

test('cli from config.yaml is honored', () => {
  const root = makeProject(BASE_YAML + 'cli:\n  default: codex\n  groups:\n    build:\n      model: openrouter/a/b\n');
  try {
    const cfg = loadConfig(root);
    assert.equal(cfg.cli.default, 'codex');
    assert.equal(cfg.cli.groups.build.model, 'openrouter/a/b');
    assert.deepEqual(cfg.cli.groups.review, undefined);
  } finally { clean(root); }
});

test('local.json overrides config.yaml for cli (hub writes win)', () => {
  const root = makeProject(
    BASE_YAML + 'cli:\n  default: claude\n  groups:\n    build:\n      model: openrouter/a/b\n',
    JSON.stringify({ cli: { default: 'opencode', groups: { review: { model: 'openrouter/c/d' } } } })
  );
  try {
    const cfg = loadConfig(root);
    // local.json wins where set…
    assert.equal(cfg.cli.default, 'opencode');
    assert.equal(cfg.cli.groups.review.model, 'openrouter/c/d');
    // …yaml value survives where local.json is silent.
    assert.equal(cfg.cli.groups.build.model, 'openrouter/a/b');
  } finally { clean(root); }
});

test('invalid cli.default falls back to claude with a warning', () => {
  const root = makeProject(BASE_YAML + 'cli:\n  default: bogus\n');
  try {
    const cfg = loadConfig(root);
    assert.equal(cfg.cli.default, 'claude');
  } finally { clean(root); }
});

test('corrupt local.json is tolerated (yaml stays authoritative)', () => {
  const root = makeProject(BASE_YAML + 'cli:\n  default: codex\n', '{ not json');
  try {
    const cfg = loadConfig(root);
    assert.equal(cfg.cli.default, 'codex');
    assert.deepEqual(loadLocalOverrides(root), {});
  } finally { clean(root); }
});

test('an array local.json is treated as malformed and a later supported save is effective', () => {
  const root = makeProject(BASE_YAML, '[1, 2]');
  try {
    assert.deepEqual(loadLocalOverrides(root), {});
    saveLocalOverrides(root, { cli: { default: 'codex' } });
    assert.deepEqual(loadLocalOverrides(root), { cli: { default: 'codex' } });
    assert.equal(loadConfig(root).cli.default, 'codex');
  } finally { clean(root); }
});

test('local.json refuses prototype-shaped top-level keys', () => {
  const root = makeProject(BASE_YAML, '{"__proto__":{"model":"bogus"}}');
  try {
    assert.throws(
      () => loadConfig(root),
      /local\.json contains unsupported top-level keys: __proto__/,
    );
  } finally { clean(root); }
});

test('local.json refuses unknown top-level keys instead of silently ignoring policy', () => {
  const root = makeProject(
    BASE_YAML,
    JSON.stringify({ builder_strategy: 'goal', support: { auto_commit: false } }),
  );
  try {
    assert.throws(
      () => loadConfig(root),
      /local\.json contains unsupported top-level keys: builder_strategy, support/,
    );
  } finally { clean(root); }
});

test('every supported local.json category reaches the effective config', () => {
  const root = makeProject(
    BASE_YAML,
    JSON.stringify({
      cli: { default: 'codex' },
      agent_defaults: { model: 'claude-opus-5', effort: 'high' },
      step_groups: [{ key: 'verify', label: 'Verify', steps: ['qa_validation'] }],
    }),
  );
  try {
    const cfg = loadConfig(root);
    assert.equal(cfg.cli.default, 'codex');
    assert.equal(cfg.agent_defaults.model, 'claude-opus-5');
    assert.equal(cfg.agent_defaults.effort, 'high');
    assert.deepEqual(cfg.step_groups, [
      { key: 'verify', label: 'Verify', hint: '', steps: ['qa_validation'] },
    ]);
  } finally { clean(root); }
});

test('saveLocalOverrides refuses an unsupported category before writing anything', () => {
  const root = makeProject(BASE_YAML);
  try {
    assert.throws(
      () => saveLocalOverrides(root, { builder_strategy: 'goal' }),
      /unsupported top-level keys: builder_strategy/,
    );
    assert.equal(fs.existsSync(path.join(root, '.build-studio', 'local.json')), false);
  } finally { clean(root); }
});

test('saveLocalOverrides: shallow-merges per top-level key, preserves others', () => {
  const root = makeProject(BASE_YAML);
  try {
    saveLocalOverrides(root, { cli: { default: 'opencode' } });
    saveLocalOverrides(root, { cli: { groups: { build: { cli: null, model: 'openrouter/x/y', effort: null } } } });
    const local = loadLocalOverrides(root);
    assert.deepEqual(local.cli, { default: 'opencode', groups: { build: { cli: null, model: 'openrouter/x/y', effort: null } } });

    // null clears a field; unrelated keys preserved
    saveLocalOverrides(root, { cli: { groups: null } });
    const local2 = loadLocalOverrides(root);
    assert.deepEqual(local2.cli, { default: 'opencode', groups: null });

    // config.yaml on disk was never touched by saves
    const yamlOnDisk = fs.readFileSync(path.join(root, '.build-studio', 'config.yaml'), 'utf8');
    assert.equal(yamlOnDisk, BASE_YAML);
  } finally { clean(root); }
});

test('final_review defaults keep effort and wrap-up policy in one object', () => {
  const { DEFAULTS } = require('./config');
  assert.deepEqual(DEFAULTS.final_review, { effort: 'high', wrapup_past_cap: true });

  const root = makeProject(BASE_YAML + 'final_review:\n  wrapup_past_cap: false\n');
  try {
    assert.deepEqual(loadConfig(root).final_review, { effort: 'high', wrapup_past_cap: false });
  } finally { clean(root); }
});

test('the review cap has one source, so the loop and the UI cannot disagree', () => {
  // Three call sites used to spell their own fallback (`|| 4`, `|| 4`, `|| 2`).
  // A config that failed to supply the value would cap the loop at 2 while the
  // UI displayed 4 — so the number lives in one place now.
  const { DEFAULT_MAX_REVIEW_ROUNDS, DEFAULTS } = require('./config');
  assert.equal(typeof DEFAULT_MAX_REVIEW_ROUNDS, 'number');
  assert.equal(DEFAULTS.max_review_rounds, DEFAULT_MAX_REVIEW_ROUNDS);

  const src = fs.readFileSync(path.join(__dirname, 'api', 'workflow.js'), 'utf8');
  const hardcoded = src.match(/config\.max_review_rounds \|\| \d+/g) || [];
  assert.deepEqual(hardcoded, [], `hardcoded review-cap fallbacks: ${hardcoded.join(', ')}`);

  // Every read of the cap goes through one of two spellings of the same
  // number: the direct `config.max_review_rounds || DEFAULT_MAX_REVIEW_ROUNDS`,
  // or `budgets()` — run-budgets.js, which resolves the run's budgets from the
  // same config key and is where the persistent round counters are checked.
  // The cap is now read in two places — directly here, and through
  // run-budgets.js, which owns the persistent round counters. Counting call
  // sites stopped being the useful assertion once the number moved; what
  // matters is that NEITHER file spells its own fallback, so they cannot drift.
  // A count of `budgets()` calls would not do: six unrelated budgets share that
  // accessor, so such a count passes with every cap read deleted.
  const budgetsSrc = fs.readFileSync(path.join(__dirname, 'run-budgets.js'), 'utf8');
  const budgetsHardcoded = budgetsSrc.match(/max_review_rounds\)? \|\| \d+/g) || [];
  assert.deepEqual(budgetsHardcoded, [], `hardcoded review-cap fallbacks in run-budgets.js: ${budgetsHardcoded.join(', ')}`);
  assert.ok(
    (src.match(/config\.max_review_rounds \|\| DEFAULT_MAX_REVIEW_ROUNDS/g) || []).length >= 1,
    'workflow.js must still resolve the cap from the shared default',
  );

  // …and run-budgets.js must agree with config.js about what that number is,
  // or the loop and the UI can disagree again through the new path.
  const { resolveBudgets, DEFAULT_MAX_REVIEW_ROUNDS: BUDGET_DEFAULT } = require('./run-budgets');
  assert.equal(BUDGET_DEFAULT, DEFAULT_MAX_REVIEW_ROUNDS);
  assert.equal(resolveBudgets({}).maxReviewRounds, DEFAULT_MAX_REVIEW_ROUNDS);
  assert.equal(resolveBudgets({ max_review_rounds: 9 }).maxReviewRounds, 9);
});
