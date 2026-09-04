'use strict';

// Tests for qaStrictGateVerdict — the qa_validation strict gate's pure verdict.
// Regression focus: the gate must AGREE with the auto-advance tick, which has
// always honored a certified-clean verdict (Approved: yes + Blocking: 0).
// Before honor_clean_approval defaulted on, tick-approve → gate-400 → step
// paused after the rejection cap (fazon PRD-026, deskrhythm PRD-025,
// launch-studio PRD-016 — three stalls, three overrides, zero real catches).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { qaStrictGateVerdict, qaServerSuiteGateVerdict } = require('./workflow');
const { parseTestCounts } = require('../qa-suite-run');
const { singleBundleLog } = require('../test-support/xcodebuild-log');

const CERTIFIED_WITH_FLAKE = [
  '**Tests passed:** 1305/1305 (unit) + 143/143 stable + 1 flaky-confirmed (E2E)',
  '',
  '**Approved:** yes',
  '**Blocking:** 0',
  '',
  'Full E2E: 143 passed, 1 failed on first pass — re-ran in isolation: passed.',
].join('\n');

const UNCERTIFIED_FAILURES = [
  '**Tests passed:** 520/525',
  '**Approved:** no',
  '**Blocking:** 2',
  '5 failed',
].join('\n');

test('certified-clean verdict passes despite a failing count (default config)', () => {
  const v = qaStrictGateVerdict(CERTIFIED_WITH_FLAKE, {}, false);
  assert.equal(v.blocked, false);
  assert.equal(v.cleanApproval, true);
  assert.equal(v.failingCount, 1);
  assert.equal(v.honoredBypass, true); // must be recorded on the step
});

test('uncertified failures still block (the strict property that matters)', () => {
  const v = qaStrictGateVerdict(UNCERTIFIED_FAILURES, {}, false);
  assert.equal(v.blocked, true);
  assert.equal(v.failingCount, 5);
  assert.equal(v.honoredBypass, false);
});

test('failures with NO structured verdict markers block', () => {
  const v = qaStrictGateVerdict('Ran suite: 3 failed, 140 passed.', {}, false);
  assert.equal(v.blocked, true);
  assert.equal(v.cleanApproval, false);
});

test('Approved: yes alone (no Blocking: 0) is not a certified verdict', () => {
  const fb = '**Approved:** yes\n2 failed';
  const v = qaStrictGateVerdict(fb, {}, false);
  assert.equal(v.blocked, true);
});

test('explicit opt-out restores block-on-any-failure even when certified', () => {
  const cfg = { qa_validation: { honor_clean_approval: false } };
  const v = qaStrictGateVerdict(CERTIFIED_WITH_FLAKE, cfg, false);
  assert.equal(v.blocked, true);
  assert.equal(v.cleanApproval, true); // certification recognized, deliberately not honored
});

test('operator override passes and is NOT an honored bypass (separate audit entry)', () => {
  const cfg = { qa_validation: { honor_clean_approval: false } };
  const v = qaStrictGateVerdict(UNCERTIFIED_FAILURES, cfg, true);
  assert.equal(v.blocked, false);
  assert.equal(v.honoredBypass, false);
});

test('zero failures is a plain pass — never an honored bypass, nothing to audit', () => {
  const v = qaStrictGateVerdict('**Approved:** yes\n**Blocking:** 0\nAll 143 passed.', {}, false);
  assert.equal(v.blocked, false);
  assert.equal(v.honoredBypass, false);
});

test('strict: false disables the gate entirely', () => {
  const cfg = { qa_validation: { strict: false } };
  const v = qaStrictGateVerdict(UNCERTIFIED_FAILURES, cfg, false);
  assert.equal(v.blocked, false);
});

test('PRD numbers are not parsed as failure counts (lookbehind regression)', () => {
  const v = qaStrictGateVerdict('**Approved:** yes\n**Blocking:** 0\n0 PRD-080 failures on main.', {}, false);
  assert.equal(v.failingCount, 0);
  assert.equal(v.blocked, false);
  assert.equal(v.honoredBypass, false);
});

test('failure count parsed from "(N failed" parenthetical form', () => {
  const v = qaStrictGateVerdict('suite red (4 failed, 139 passed)', {}, false);
  assert.equal(v.failingCount, 4);
  assert.equal(v.blocked, true);
});

test('server exact-count authority blocks before and regardless of an agent clean verdict or operator override', () => {
  const config = { qa_validation: { expected_test_count: 56 } };
  const counts = parseTestCounts(singleBundleLog('SampleAppUITests', 55, { style: 'objc' }));
  const step = {
    suiteRun: {
      status: 'completed',
      exitCode: 0,
      counts,
      authority: {
        configured: true, blocked: true, code: 'QA_EXPECTED_TEST_COUNT_MISMATCH',
        expectedTestCount: 56, actualTestCount: 55,
      },
    },
    agents: [{ feedback: '**Approved:** yes\n**Blocking:** 0\n55 passed' }],
  };
  const verdict = qaServerSuiteGateVerdict(step, config);
  assert.equal(verdict.blocked, true);
  assert.equal(verdict.code, 'QA_EXPECTED_TEST_COUNT_MISMATCH');
});

test('server exact-count authority passes only its persisted exact verdict; legacy projects are unaffected', () => {
  const config = {
    qa_validation: { expected_test_count: 56, only_testing: ['SampleAppUITests'] },
    simulator: { parallel_testing: false },
  };
  const counts = parseTestCounts(singleBundleLog('SampleAppUITests', 56, { style: 'objc' }));
  assert.equal(qaServerSuiteGateVerdict({
    suiteRun: { status: 'completed', exitCode: 0, counts, authority: {
      configured: true, blocked: false, code: 'QA_EXACT_COUNT_VERIFIED',
      expectedTestCount: 56, actualTestCount: 56,
      onlyTesting: ['SampleAppUITests'], parallelTesting: false,
    } },
  }, config).blocked, false);
  assert.equal(qaServerSuiteGateVerdict({}, {}).blocked, false);
  assert.equal(qaServerSuiteGateVerdict({}, config).code, 'QA_SERVER_SUITE_AUTHORITY_MISSING');
});

test('persisted exact authority is bound to current target scope and serial setting', () => {
  const config = {
    qa_validation: { expected_test_count: 56, only_testing: ['SampleAppUITests'] },
    simulator: { parallel_testing: false },
  };
  const authority = {
    configured: true, blocked: false, code: 'QA_EXACT_COUNT_VERIFIED',
    expectedTestCount: 56, actualTestCount: 56,
    onlyTesting: ['OtherUITests'], parallelTesting: false,
  };
  const counts = parseTestCounts(singleBundleLog('SampleAppUITests', 56, { style: 'objc' }));
  const suiteRun = { status: 'completed', exitCode: 0, counts, authority };
  assert.equal(qaServerSuiteGateVerdict({ suiteRun }, config).code, 'QA_SERVER_SUITE_SCOPE_STALE');
  authority.onlyTesting = ['SampleAppUITests'];
  authority.parallelTesting = true;
  assert.equal(qaServerSuiteGateVerdict({ suiteRun }, config).code, 'QA_SERVER_SUITE_PARALLELISM_STALE');
});

test('persisted pass cannot disagree with the raw server result', () => {
  const config = { qa_validation: { expected_test_count: 56 } };
  const counts = parseTestCounts(singleBundleLog('T', 55, { style: 'objc' }));
  const verdict = qaServerSuiteGateVerdict({ suiteRun: {
    status: 'completed', exitCode: 0, counts,
    authority: {
      configured: true, blocked: false, code: 'QA_EXACT_COUNT_VERIFIED',
      expectedTestCount: 56, actualTestCount: 56,
    },
  } }, config);
  assert.equal(verdict.code, 'QA_SERVER_SUITE_AUTHORITY_DRIFT');
  assert.equal(verdict.blocked, true);
});

test('persisted Apple authority is bound to current artifact policy and language', () => {
  const config = {
    qa_validation: {
      expected_test_count: 2, only_testing: ['ExampleUITests'],
      apple_result_authority: true, test_language: 'en',
    },
    simulator: { parallel_testing: false },
  };
  const counts = parseTestCounts(singleBundleLog('ExampleUITests', 2, { style: 'objc' }));
  const artifacts = {
    status: 'complete',
    log: { path: '/tmp/log', sha256: 'a'.repeat(64) },
    resultBundle: { path: '/tmp/result.xcresult', fileCount: 1, manifestDigest: 'b'.repeat(64) },
    apple: { totalTestCount: 2, passedTests: 2, failedTests: 0, skippedTests: 0, expectedFailures: 0, result: 'Passed' },
  };
  const authority = {
    configured: true, blocked: false, code: 'QA_APPLE_RESULT_VERIFIED',
    expectedTestCount: 2, actualTestCount: 2,
    onlyTesting: ['ExampleUITests'], parallelTesting: false,
    appleResultAuthority: true, testLanguage: 'en',
  };
  const suiteRun = { status: 'completed', exitCode: 0, counts, artifacts, authority };
  assert.equal(qaServerSuiteGateVerdict({ suiteRun }, config).blocked, false);

  authority.testLanguage = 'sv';
  assert.equal(qaServerSuiteGateVerdict({ suiteRun }, config).code, 'QA_SERVER_SUITE_LANGUAGE_STALE');
  authority.testLanguage = 'en';
  authority.appleResultAuthority = false;
  assert.equal(qaServerSuiteGateVerdict({ suiteRun }, config).code, 'QA_SERVER_SUITE_ARTIFACT_POLICY_STALE');
});
