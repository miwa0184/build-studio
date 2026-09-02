'use strict';

// F1 — exact-count authority across more than one test target.
//
// `qa_validation.only_testing` can name two bundles (a unit target and a UI
// target, say). xcodebuild then runs two sessions and prints one native
// `Executed N tests` summary per session; no line ever says 56. The first cut
// of evaluateSuiteAuthority required one summary to equal the whole run, so a
// perfectly coherent 30 + 26 run was blocked as QA_TEST_COUNT_INCONSISTENT.
//
// These tests pin the repaired semantics at the same boundary the server uses
// (parseTestCounts → evaluateSuiteAuthority, and the stream path in
// startSuiteRun), for one target and for several, and keep every fail-closed
// case closed: mismatched aggregate, contradictory summaries, replayed runs,
// missing summaries, failures, and duplicate banners.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseTestCounts, evaluateSuiteAuthority, startSuiteRun } = require('./qa-suite-run');

function cases(module, n, { failed = 0, cls = 'Cases' } = {}) {
  const lines = [];
  for (let i = 1; i <= n; i++) {
    lines.push(`Test Case '-[${module}.${cls} test${i}]' ${i <= failed ? 'failed' : 'passed'} (0.1 seconds).`);
  }
  return lines;
}

function suiteSummary(name, executed, failures = 0) {
  return [
    `Test Suite '${name}' ${failures ? 'failed' : 'passed'} at 2026-09-02 10:00:00.000.`,
    `\t Executed ${executed} test${executed === 1 ? '' : 's'}, with ${failures} failure${failures === 1 ? '' : 's'} (0 unexpected) in 1.0 (1.1) seconds`,
  ];
}

/** Two bundles in one xcodebuild invocation, the way a real serial run prints them. */
function twoTargetLog({ a = 30, b = 26, aFailed = 0, bFailed = 0, banner = 'SUCCEEDED', aSummary, bSummary } = {}) {
  return [
    "Test Suite 'All tests' started at 2026-09-02 10:00:00.000.",
    ...cases('AtlasTests', a, { failed: aFailed }),
    ...suiteSummary('AtlasTests.xctest', aSummary ?? a, aFailed),
    ...suiteSummary('All tests', aSummary ?? a, aFailed),
    "Test Suite 'All tests' started at 2026-09-02 10:05:00.000.",
    ...cases('AtlasUITests', b, { failed: bFailed }),
    ...suiteSummary('AtlasUITests.xctest', bSummary ?? b, bFailed),
    ...suiteSummary('All tests', bSummary ?? b, bFailed),
    ...(banner ? [`** TEST ${banner} **`] : []),
  ].join('\n');
}

function completed(log, exitCode = 0) {
  return { status: 'completed', exitCode, counts: parseTestCounts(log) };
}

test('F1 — two configured targets with 30 + 26 native summaries verify exactly 56', () => {
  const verdict = evaluateSuiteAuthority(completed(twoTargetLog()), 56);
  assert.equal(verdict.blocked, false, JSON.stringify(verdict));
  assert.equal(verdict.code, 'QA_EXACT_COUNT_VERIFIED');
  assert.equal(verdict.actualTestCount, 56);
});

test('F1 — a single target with nested class, bundle and All-tests summaries still verifies', () => {
  const log = [
    "Test Suite 'All tests' started at 2026-09-02 10:00:00.000.",
    ...cases('AtlasUITests', 20, { cls: 'HomeTests' }),
    ...suiteSummary('HomeTests', 20),
    ...cases('AtlasUITests', 36, { cls: 'PlayTests' }),
    ...suiteSummary('PlayTests', 36),
    ...suiteSummary('AtlasUITests.xctest', 56),
    ...suiteSummary('All tests', 56),
    '** TEST SUCCEEDED **',
  ].join('\n');
  const verdict = evaluateSuiteAuthority(completed(log), 56);
  assert.equal(verdict.blocked, false, JSON.stringify(verdict));
  assert.equal(verdict.actualTestCount, 56);
});

test('F1 — single-target semantics are unchanged: 55 and 57 still mismatch, a lone summary must agree', () => {
  for (const n of [55, 57]) {
    const log = [...cases('AtlasUITests', n), ...suiteSummary('All tests', n), '** TEST SUCCEEDED **'].join('\n');
    const verdict = evaluateSuiteAuthority(completed(log), 56);
    assert.equal(verdict.code, 'QA_EXPECTED_TEST_COUNT_MISMATCH');
    assert.equal(verdict.actualTestCount, n);
  }
  const disagreeing = [...cases('AtlasUITests', 56), ...suiteSummary('All tests', 55), '** TEST SUCCEEDED **'].join('\n');
  assert.equal(evaluateSuiteAuthority(completed(disagreeing), 56).code, 'QA_TEST_COUNT_INCONSISTENT');
});

test('F1 — a mismatched aggregate blocks: 30 + 26 executed is not 57', () => {
  const verdict = evaluateSuiteAuthority(completed(twoTargetLog()), 57);
  assert.equal(verdict.blocked, true);
  assert.equal(verdict.code, 'QA_EXPECTED_TEST_COUNT_MISMATCH');
  assert.equal(verdict.actualTestCount, 56);
});

test('F1 — a native summary that contradicts its own target blocks even when the total adds up', () => {
  // Per-case lines say 30 + 26; the second session claims 25. The aggregate of
  // summaries is 55, the case tally is 56 — nothing agrees, so nothing passes.
  const verdict = evaluateSuiteAuthority(completed(twoTargetLog({ bSummary: 25 })), 56);
  assert.equal(verdict.blocked, true);
  assert.equal(verdict.code, 'QA_TEST_COUNT_INCONSISTENT');

  // The other direction: summaries say 30 + 26 but 27 cases actually ran in
  // the second session. Expected 56 must not pass on the summaries alone.
  const extraCase = evaluateSuiteAuthority(completed(twoTargetLog({ b: 27, bSummary: 26 })), 56);
  assert.equal(extraCase.blocked, true);
  assert.notEqual(extraCase.code, 'QA_EXACT_COUNT_VERIFIED');
});

test('F1 — summaries alone never carry a multi-target run: no per-case tally means no verdict', () => {
  const log = [...suiteSummary('All tests', 30), ...suiteSummary('All tests', 26), '** TEST SUCCEEDED **'].join('\n');
  const verdict = evaluateSuiteAuthority(completed(log), 56);
  assert.equal(verdict.blocked, true);
  assert.equal(verdict.code, 'QA_TEST_COUNT_AMBIGUOUS');
});

test('F1 — a replayed run stays blocked: doubled cases, or doubled banners', () => {
  const once = twoTargetLog({ banner: null });
  const twiceCases = `${once}\n${once}\n** TEST SUCCEEDED **`;
  const replayed = evaluateSuiteAuthority(completed(twiceCases), 56);
  assert.equal(replayed.blocked, true);
  assert.notEqual(replayed.code, 'QA_EXACT_COUNT_VERIFIED');

  const twiceBanners = `${twoTargetLog()}\n** TEST SUCCEEDED **`;
  assert.equal(evaluateSuiteAuthority(completed(twiceBanners), 56).code, 'QA_TEST_VERDICT_AMBIGUOUS');
});

test('F1 — a repeated summary for one target cannot stand in for the other target', () => {
  // 30 + 26 cases ran, but the log carries two summaries of 30 and none of 26.
  const log = [
    ...cases('AtlasTests', 30), ...suiteSummary('All tests', 30),
    ...cases('AtlasUITests', 26), ...suiteSummary('All tests', 30),
    '** TEST SUCCEEDED **',
  ].join('\n');
  const verdict = evaluateSuiteAuthority(completed(log), 56);
  assert.equal(verdict.blocked, true);
  assert.equal(verdict.code, 'QA_TEST_COUNT_INCONSISTENT');
});

test('F1 — multi-target failures, missing summaries, exit status and banners still fail closed', () => {
  const failed = evaluateSuiteAuthority(completed(twoTargetLog({ bFailed: 1, banner: 'FAILED' }), 65), 56);
  assert.equal(failed.blocked, true);
  assert.equal(failed.code, 'QA_TESTS_FAILED');

  const noSummaries = [...cases('AtlasTests', 30), ...cases('AtlasUITests', 26), '** TEST SUCCEEDED **'].join('\n');
  assert.equal(evaluateSuiteAuthority(completed(noSummaries), 56).code, 'QA_TEST_COUNT_MISSING');

  const nonZeroExit = evaluateSuiteAuthority(completed(twoTargetLog(), 1), 56);
  assert.equal(nonZeroExit.code, 'QA_XCODEBUILD_EXIT_NONZERO');

  const noBanner = evaluateSuiteAuthority(completed(twoTargetLog({ banner: null })), 56);
  assert.equal(noBanner.code, 'QA_TEST_VERDICT_MISSING');
});

test('F1 — the streamed run keeps the first target summary even when it scrolls out of the tail', async () => {
  // startSuiteRun keeps a 200 KB tail for the summary. In a two-target run the
  // first session's summary sits in the middle of the log, and a chatty UI
  // session can push it out of the tail. The authority must be evaluated on
  // what actually streamed, not on what happened to remain in the window.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-multi-'));
  const log = twoTargetLog();
  const [first, second] = log.split("Test Suite 'All tests' started at 2026-09-02 10:05:00.000.");
  const filler = Array.from({ length: 4000 }, (_, i) => `t = ${i} noisy simulator line ${'x'.repeat(60)}`).join('\n');
  const script = `#!/bin/sh\ncat "${path.join(dir, 'part1.txt')}"\ncat "${path.join(dir, 'filler.txt')}"\ncat "${path.join(dir, 'part2.txt')}"\nexit 0\n`;
  fs.writeFileSync(path.join(dir, 'part1.txt'), `${first}\n`);
  fs.writeFileSync(path.join(dir, 'filler.txt'), `${filler}\n`);
  fs.writeFileSync(path.join(dir, 'part2.txt'), `Test Suite 'All tests' started at 2026-09-02 10:05:00.000.${second}\n`);
  fs.writeFileSync(path.join(dir, 'xcodebuild'), script, { mode: 0o755 });
  assert.ok(Buffer.byteLength(filler) > 200000, 'the filler must exceed the tail window for this test to mean anything');

  const run = startSuiteRun({
    cwd: dir, args: ['test'], logPath: path.join(dir, 'run.log'), timeoutMs: 30000,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
  const result = await run.promise;
  assert.equal(result.status, 'completed');
  assert.equal(result.exitCode, 0);
  assert.equal(result.counts.casesPassed, 56);
  const verdict = evaluateSuiteAuthority(result, 56);
  assert.equal(verdict.blocked, false, JSON.stringify(verdict));
  assert.equal(verdict.actualTestCount, 56);
  fs.rmSync(dir, { recursive: true, force: true });
});
