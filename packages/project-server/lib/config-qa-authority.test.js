'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('./config');

function withConfig(extra, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'config-qa-authority-'));
  fs.mkdirSync(path.join(root, '.build-studio'), { recursive: true });
  fs.writeFileSync(path.join(root, '.build-studio', 'config.yaml'), `name: qa-authority\nport: 3998\npreset: mobile-app\n${extra}`);
  try { return fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('valid exact serial QA config survives load byte-for-value', () => {
  withConfig([
    'qa_validation:',
    '  only_testing:',
    '    - SampleAppUITests',
    '  expected_test_count: 56',
    'simulator:',
    '  destination: platform=iOS Simulator,id=DEVICE',
    '  parallel_testing: false',
    '',
  ].join('\n'), (root) => {
    const cfg = loadConfig(root);
    assert.deepEqual(cfg.qa_validation.only_testing, ['SampleAppUITests']);
    assert.equal(cfg.qa_validation.expected_test_count, 56);
    assert.equal(cfg.simulator.parallel_testing, false);
  });
});

test('valid Apple result authority requires and preserves an explicit test language', () => {
  withConfig([
    'qa_validation:',
    '  only_testing: [ExampleUITests]',
    '  expected_test_count: 56',
    '  apple_result_authority: true',
    '  test_language: en',
    'simulator:',
    '  destination: platform=iOS Simulator,id=DEVICE',
    '  parallel_testing: false',
    '',
  ].join('\n'), (root) => {
    const cfg = loadConfig(root);
    assert.equal(cfg.qa_validation.apple_result_authority, true);
    assert.equal(cfg.qa_validation.test_language, 'en');
  });
});

for (const [label, yaml] of [
  ['empty list', 'qa_validation:\n  only_testing: []\nsimulator:\n  destination: d\n'],
  ['blank target', 'qa_validation:\n  only_testing: [""]\nsimulator:\n  destination: d\n'],
  ['flag injection', 'qa_validation:\n  only_testing: ["-destination evil"]\nsimulator:\n  destination: d\n'],
  ['duplicate target', 'qa_validation:\n  only_testing: [SampleAppUITests, SampleAppUITests]\nsimulator:\n  destination: d\n'],
  ['zero expected count', 'qa_validation:\n  only_testing: [SampleAppUITests]\n  expected_test_count: 0\nsimulator:\n  destination: d\n  parallel_testing: false\n'],
  ['fractional expected count', 'qa_validation:\n  only_testing: [SampleAppUITests]\n  expected_test_count: 55.5\nsimulator:\n  destination: d\n  parallel_testing: false\n'],
  ['string expected count', 'qa_validation:\n  only_testing: [SampleAppUITests]\n  expected_test_count: "56"\nsimulator:\n  destination: d\n  parallel_testing: false\n'],
  ['missing exact target scope', 'qa_validation:\n  expected_test_count: 56\nsimulator:\n  destination: d\n  parallel_testing: false\n'],
  ['missing simulator destination', 'qa_validation:\n  only_testing: [SampleAppUITests]\n  expected_test_count: 56\nsimulator:\n  parallel_testing: false\n'],
  ['parallel execution enabled', 'qa_validation:\n  only_testing: [SampleAppUITests]\n  expected_test_count: 56\nsimulator:\n  destination: d\n  parallel_testing: true\n'],
  ['server suite disabled', 'qa_validation:\n  only_testing: [SampleAppUITests]\n  expected_test_count: 56\n  server_runs_suite: false\nsimulator:\n  destination: d\n  parallel_testing: false\n'],
  ['Apple authority without language', 'qa_validation:\n  only_testing: [ExampleUITests]\n  expected_test_count: 56\n  apple_result_authority: true\nsimulator:\n  destination: d\n  parallel_testing: false\n'],
  ['unsafe test language', 'qa_validation:\n  only_testing: [ExampleUITests]\n  expected_test_count: 56\n  apple_result_authority: true\n  test_language: "en; touch /tmp/pwn"\nsimulator:\n  destination: d\n  parallel_testing: false\n'],
  ['Apple authority without exact count', 'qa_validation:\n  only_testing: [ExampleUITests]\n  apple_result_authority: true\n  test_language: en\nsimulator:\n  destination: d\n  parallel_testing: false\n'],
  ['test language without Apple authority', 'qa_validation:\n  test_language: en\n'],
]) {
  test(`invalid exact QA config fails closed: ${label}`, () => {
    withConfig(yaml, (root) => {
      assert.throws(() => loadConfig(root), /Config validation failed.*qa_validation/s);
    });
  });
}

test('projects without exact QA fields preserve legacy defaults', () => {
  withConfig('', (root) => {
    const cfg = loadConfig(root);
    assert.equal(cfg.qa_validation && cfg.qa_validation.only_testing, undefined);
    assert.equal(cfg.qa_validation && cfg.qa_validation.expected_test_count, undefined);
  });
});
