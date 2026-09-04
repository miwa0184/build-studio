'use strict';

// Exact-count authority: evidence is bound one-to-one to native test bundles.
//
// Second independent review of the multi-target repair found two ways the
// per-bundle corroboration could be forged:
//
//   F1  summaries were matched to bundle tallies by (executed, failures) with
//       Array.some — no consumption, no bundle identity. One summary could
//       vouch for two equal-count bundles; a class-level or stray summary
//       could vouch for a bundle nobody summarised.
//   F2  bundle identity was inferred from the case name. Objective-C cases
//       print as `-[Class method]`, so one target with two classes became two
//       "bundles", entered the relaxed multi-target path, and a false whole-
//       bundle aggregate of 50 over 30 + 26 cases was verified at 56.
//       Swift-style `-[Module.Class method]` evidence blocked, so the verdict
//       depended on the declaration language.
//
// The repaired model binds evidence by the native hierarchy: a bundle is a
// `Test Suite '<Name>.xctest'` boundary, its cases are the case lines inside
// that boundary, and its summary is the `Executed` line that closes that
// boundary. Each configured `only_testing` target must bind to exactly one
// such bundle with exactly one summary equal to its own tally. Nothing is
// inferred from case syntax or from equal numbers, and when the output cannot
// bind every configured target the verdict fails closed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseTestCounts, evaluateSuiteAuthority, startSuiteRun } = require('./qa-suite-run');
const { bundleSession, xcodebuildLog, singleBundleLog, suiteEnd, suiteStart, caseLines, objcCase } = require('./test-support/xcodebuild-log');

function completed(log, exitCode = 0) {
  return { status: 'completed', exitCode, counts: parseTestCounts(log) };
}

const TWO_TARGETS = ['AtlasTests', 'AtlasUITests'];

/** Two equal-count bundles; the second one's own summaries can be withheld. */
function equalCountLog({ secondBundleSummary = true, secondSessionSummary = true, style = 'swift' } = {}) {
  return xcodebuildLog([
    bundleSession({ bundle: 'AtlasTests', style, classes: [{ name: 'Cases', count: 28 }] }),
    bundleSession({
      bundle: 'AtlasUITests', style, classes: [{ name: 'Cases', count: 28 }],
      bundleSummary: secondBundleSummary ? undefined : false,
      sessionSummary: secondSessionSummary ? undefined : false,
    }),
  ]);
}

// ── F1 — one-to-one binding ─────────────────────────────────────────────────

test('F1(a) — two configured targets with equal counts and only one corroborating summary block', () => {
  const log = equalCountLog({ secondBundleSummary: false, secondSessionSummary: false });
  const verdict = evaluateSuiteAuthority(completed(log), 56, { onlyTesting: TWO_TARGETS });
  assert.equal(verdict.blocked, true, JSON.stringify(verdict));
  assert.equal(verdict.code, 'QA_TEST_COUNT_INCONSISTENT');
  assert.match(verdict.reason, /AtlasUITests/);
  assert.notEqual(verdict.code, 'QA_EXACT_COUNT_VERIFIED');
});

test('F1(a) — a session-level "All tests" summary is not bundle evidence for the bundle that lacks its own', () => {
  // The second session prints `Test Suite 'All tests'` with 28 executed but
  // never closes `AtlasUITests.xctest`. That 28 belongs to the session line,
  // not to the bundle, and the equal count of the first bundle is irrelevant.
  const log = equalCountLog({ secondBundleSummary: false, secondSessionSummary: true });
  const verdict = evaluateSuiteAuthority(completed(log), 56, { onlyTesting: TWO_TARGETS });
  assert.equal(verdict.blocked, true, JSON.stringify(verdict));
  assert.equal(verdict.code, 'QA_TEST_COUNT_INCONSISTENT');
});

test('F1(b) — a summary is bound to exactly one bundle and is never consumed twice', () => {
  const honest = parseTestCounts(equalCountLog());
  // Evidence model: every bundle carries exactly one summary, every bound
  // summary names exactly one bundle, and no two bundles share a summary.
  assert.equal(honest.bundles.length, 2);
  const boundIndexes = honest.bundles.map((b) => {
    assert.equal(b.summaries.length, 1, JSON.stringify(b));
    return b.summaries[0].index;
  });
  assert.equal(new Set(boundIndexes).size, 2, 'two bundles must consume two distinct summaries');
  const bundleOwners = honest.summaryCounts.filter((s) => s.bundle).map((s) => s.bundle);
  assert.deepEqual(bundleOwners, ['AtlasTests#1', 'AtlasUITests#1']);

  // The second bundle is closed by a REPEAT of the first bundle's summary
  // lines instead of its own. The same evidence now appears twice in the log
  // and AtlasUITests still has none of its own: blocked, never re-used.
  const reused = xcodebuildLog([
    bundleSession({ bundle: 'AtlasTests', classes: [{ name: 'Cases', count: 28 }] }),
    [
      suiteStart('All tests'), suiteStart('AtlasUITests.xctest'), suiteStart('Cases'),
      ...caseLines((i) => `-[AtlasUITests.Cases test${i}]`, 28),
      ...suiteEnd('Cases', 28),
      ...suiteEnd('AtlasTests.xctest', 28),
      ...suiteEnd('All tests', 28),
    ],
  ]);
  const verdict = evaluateSuiteAuthority(completed(reused), 56, { onlyTesting: TWO_TARGETS });
  assert.equal(verdict.blocked, true, JSON.stringify(verdict));
  assert.equal(verdict.code, 'QA_TEST_COUNT_INCONSISTENT');

  // Two `Executed` lines closing one bundle is two claims for one identity.
  const doubled = xcodebuildLog([
    bundleSession({ bundle: 'AtlasTests', classes: [{ name: 'Cases', count: 28 }] }),
    [
      ...bundleSession({ bundle: 'AtlasUITests', classes: [{ name: 'Cases', count: 28 }], sessionSummary: false }),
      '\t Executed 28 tests, with 0 failures (0 unexpected) in 1.0 (1.1) seconds',
      ...suiteEnd('All tests', 28),
    ],
  ]);
  const twice = evaluateSuiteAuthority(completed(doubled), 56, { onlyTesting: TWO_TARGETS });
  assert.equal(twice.blocked, true, JSON.stringify(twice));
  assert.equal(twice.code, 'QA_TEST_COUNT_INCONSISTENT');
});

test('F1(c) — a class-level summary cannot satisfy a configured bundle that has no summary', () => {
  // AtlasTests holds classes of 26 and 4 with honest class summaries; the
  // AtlasUITests bundle runs 26 cases and never prints a summary. The 26 in
  // the log belongs to a class inside the OTHER bundle.
  const log = xcodebuildLog([
    bundleSession({ bundle: 'AtlasTests', classes: [{ name: 'Alpha', count: 26 }, { name: 'Beta', count: 4 }] }),
    bundleSession({ bundle: 'AtlasUITests', classes: [{ name: 'Cases', count: 26 }], bundleSummary: false, sessionSummary: false }),
  ]);
  const verdict = evaluateSuiteAuthority(completed(log), 56, { onlyTesting: TWO_TARGETS });
  assert.equal(verdict.blocked, true, JSON.stringify(verdict));
  assert.equal(verdict.code, 'QA_TEST_COUNT_INCONSISTENT');
  assert.match(verdict.reason, /AtlasUITests/);
});

test('F1(c) — an unrelated summary line outside any suite cannot satisfy a missing bundle', () => {
  const log = [
    '\t Executed 26 tests, with 0 failures (0 unexpected) in 0.0 (0.0) seconds',
    ...bundleSession({ bundle: 'AtlasTests', classes: [{ name: 'Cases', count: 30 }] }),
    ...bundleSession({ bundle: 'AtlasUITests', classes: [{ name: 'Cases', count: 26 }], bundleSummary: false, sessionSummary: false }),
    '** TEST SUCCEEDED **',
  ].join('\n');
  const verdict = evaluateSuiteAuthority(completed(log), 56, { onlyTesting: TWO_TARGETS });
  assert.equal(verdict.blocked, true, JSON.stringify(verdict));
  assert.equal(verdict.code, 'QA_TEST_COUNT_INCONSISTENT');
  // The stray line is recorded, but bound to nothing.
  const stray = parseTestCounts(log).summaryCounts[0];
  assert.equal(stray.executed, 26);
  assert.equal(stray.bundle, null);
  assert.equal(stray.suite, null);
});

// ── F2 — bundle identity comes from the hierarchy, not from case syntax ─────

function twoClassBundle({ style, bundleSummary, sessionSummary, bundleStart } = {}) {
  return xcodebuildLog([bundleSession({
    bundle: 'AtlasUITests', style, bundleSummary, sessionSummary, bundleStart,
    classes: [{ name: 'HomeTests', count: 30 }, { name: 'PlayTests', count: 26 }],
  })]);
}

test('F2(d) — one Objective-C target with several classes is one bundle, never a synthetic multi-bundle run', () => {
  const objc = parseTestCounts(twoClassBundle({ style: 'objc' }));
  const swift = parseTestCounts(twoClassBundle({ style: 'swift' }));
  for (const counts of [objc, swift]) {
    assert.equal(counts.bundles.length, 1, JSON.stringify(counts.bundles));
    assert.equal(counts.bundles[0].name, 'AtlasUITests');
    assert.equal(counts.bundles[0].passed, 56);
  }
  assert.deepEqual(objc.bundles, swift.bundles, 'the evidence model must not depend on case-name syntax');

  // With the bundle's own summary withheld, the class summaries of 30 and 26
  // are the only summaries left. They must not be promoted to bundles.
  for (const style of ['objc', 'swift']) {
    const verdict = evaluateSuiteAuthority(
      completed(twoClassBundle({ style, bundleSummary: false, sessionSummary: false })), 56, { onlyTesting: ['AtlasUITests'] },
    );
    assert.equal(verdict.blocked, true, `${style}: ${JSON.stringify(verdict)}`);
    assert.equal(verdict.code, 'QA_TEST_COUNT_INCONSISTENT');
  }
});

test('F2(e) — Objective-C 30 + 26 with a false whole-bundle aggregate of 50 blocks, exactly like Swift', () => {
  const verdicts = {};
  for (const style of ['objc', 'swift']) {
    const log = twoClassBundle({ style, bundleSummary: 50, sessionSummary: 50 });
    verdicts[style] = evaluateSuiteAuthority(completed(log, 0), 56, { onlyTesting: ['AtlasUITests'] });
    assert.equal(verdicts[style].blocked, true, `${style}: ${JSON.stringify(verdicts[style])}`);
    assert.equal(verdicts[style].code, 'QA_TEST_COUNT_INCONSISTENT');
    assert.equal(verdicts[style].actualTestCount, 56);
    assert.match(verdicts[style].reason, /50/);
  }
  assert.equal(verdicts.objc.code, verdicts.swift.code);
  // The same forgery with no configured scope (observed-bundle mode) blocks too.
  const unscoped = evaluateSuiteAuthority(completed(twoClassBundle({ style: 'objc', bundleSummary: 50, sessionSummary: 50 })), 56);
  assert.equal(unscoped.code, 'QA_TEST_COUNT_INCONSISTENT');
});

// ── positive controls ───────────────────────────────────────────────────────

test('control — genuine multi-target output with independently bound evidence verifies, equal counts included', () => {
  const unequal = xcodebuildLog([
    bundleSession({ bundle: 'AtlasTests', classes: [{ name: 'Cases', count: 30 }] }),
    bundleSession({ bundle: 'AtlasUITests', classes: [{ name: 'Home', count: 20 }, { name: 'Play', count: 6 }] }),
  ]);
  for (const onlyTesting of [TWO_TARGETS, ['AtlasTests', 'AtlasUITests/Home', 'AtlasUITests/Play'], undefined, []]) {
    const verdict = evaluateSuiteAuthority(completed(unequal), 56, { onlyTesting });
    assert.equal(verdict.blocked, false, JSON.stringify({ onlyTesting, verdict }));
    assert.equal(verdict.code, 'QA_EXACT_COUNT_VERIFIED');
    assert.equal(verdict.actualTestCount, 56);
  }

  for (const style of ['swift', 'objc']) {
    const equal = evaluateSuiteAuthority(completed(equalCountLog({ style })), 56, { onlyTesting: TWO_TARGETS });
    assert.equal(equal.blocked, false, JSON.stringify(equal));
    assert.equal(equal.code, 'QA_EXACT_COUNT_VERIFIED');
    assert.equal(equal.actualTestCount, 56);
  }

  const three = xcodebuildLog([
    bundleSession({ bundle: 'CoreTests', classes: [{ name: 'A', count: 10 }] }),
    bundleSession({ bundle: 'AppTests', classes: [{ name: 'B', count: 10 }] }),
    bundleSession({ bundle: 'AppUITests', classes: [{ name: 'C', count: 10 }] }),
  ]);
  const verdict = evaluateSuiteAuthority(completed(three), 30, { onlyTesting: ['CoreTests', 'AppTests', 'AppUITests'] });
  assert.equal(verdict.code, 'QA_EXACT_COUNT_VERIFIED', JSON.stringify(verdict));
  assert.equal(verdict.actualTestCount, 30);
});

test('control — valid single-target Swift and Objective-C output verifies when exact and fully corroborated', () => {
  for (const style of ['swift', 'objc']) {
    const verdict = evaluateSuiteAuthority(completed(singleBundleLog('SampleAppUITests', 56, { style })), 56, { onlyTesting: ['SampleAppUITests'] });
    assert.equal(verdict.blocked, false, `${style}: ${JSON.stringify(verdict)}`);
    assert.equal(verdict.code, 'QA_EXACT_COUNT_VERIFIED');
    assert.equal(verdict.actualTestCount, 56);
    // Two honest Objective-C classes in one bundle, with the bundle's own
    // honest summary, is the shape the F2 report came from — it must pass.
    const twoClasses = evaluateSuiteAuthority(completed(twoClassBundle({ style })), 56, { onlyTesting: ['AtlasUITests'] });
    assert.equal(twoClasses.code, 'QA_EXACT_COUNT_VERIFIED', `${style}: ${JSON.stringify(twoClasses)}`);
    // No configured scope: the observed bundle is the whole run.
    assert.equal(evaluateSuiteAuthority(completed(twoClassBundle({ style })), 56).code, 'QA_EXACT_COUNT_VERIFIED');
    // A `-only-testing` run prints `Selected tests` for the session suite.
    const selected = xcodebuildLog([bundleSession({ bundle: 'AtlasUITests', style, session: 'Selected tests', classes: [{ name: 'Cases', count: 56 }] })]);
    assert.equal(evaluateSuiteAuthority(completed(selected), 56, { onlyTesting: ['AtlasUITests/Cases'] }).code, 'QA_EXACT_COUNT_VERIFIED');
  }
  // Exactness is unchanged: 55 and 57 mismatch by count, not by evidence.
  for (const n of [55, 57]) {
    const verdict = evaluateSuiteAuthority(completed(singleBundleLog('SampleAppUITests', n)), 56, { onlyTesting: ['SampleAppUITests'] });
    assert.equal(verdict.code, 'QA_EXPECTED_TEST_COUNT_MISMATCH');
    assert.equal(verdict.actualTestCount, n);
  }
});

// ── fail-closed edges of the binding model ──────────────────────────────────

test('a configured target that produced no native bundle boundary fails closed', () => {
  const log = singleBundleLog('AtlasUITests', 56);
  const verdict = evaluateSuiteAuthority(completed(log), 56, { onlyTesting: ['AtlasUITests', 'AtlasTests'] });
  assert.equal(verdict.blocked, true, JSON.stringify(verdict));
  assert.equal(verdict.code, 'QA_TEST_TARGET_UNBOUND');
  assert.match(verdict.reason, /AtlasTests/);
  // A product name that does not match the configured target is the same
  // failure: the authority binds names, it does not guess.
  const renamed = evaluateSuiteAuthority(completed(singleBundleLog('AtlasUITestsProduct', 56)), 56, { onlyTesting: ['AtlasUITests'] });
  assert.equal(renamed.code, 'QA_TEST_TARGET_UNBOUND');
});

test('cases outside any bundle boundary, a bundle without a start, and a replayed bundle fail closed', () => {
  const outside = [
    ...caseLines(objcCase('Loose'), 56),
    ...suiteEnd('Loose', 56),
    '** TEST SUCCEEDED **',
  ].join('\n');
  const loose = evaluateSuiteAuthority(completed(outside), 56, { onlyTesting: ['AtlasUITests'] });
  assert.equal(loose.blocked, true);
  assert.equal(loose.code, 'QA_TEST_COUNT_INCONSISTENT');
  assert.equal(evaluateSuiteAuthority(completed(outside), 56).code, 'QA_TEST_COUNT_INCONSISTENT');

  // A `passed at` + `Executed 56` for a bundle that never started encloses no
  // cases: its summary contradicts its own (empty) boundary.
  const noStart = twoClassBundle({ bundleStart: false });
  const phantom = evaluateSuiteAuthority(completed(noStart), 56, { onlyTesting: ['AtlasUITests'] });
  assert.equal(phantom.blocked, true, JSON.stringify(phantom));
  assert.equal(phantom.code, 'QA_TEST_COUNT_INCONSISTENT');

  const once = bundleSession({ bundle: 'AtlasUITests', classes: [{ name: 'Cases', count: 28 }] });
  const replayed = evaluateSuiteAuthority(completed(xcodebuildLog([once, once])), 56, { onlyTesting: ['AtlasUITests'] });
  assert.equal(replayed.blocked, true, JSON.stringify(replayed));
  assert.equal(replayed.code, 'QA_TEST_COUNT_INCONSISTENT');
  assert.equal(evaluateSuiteAuthority(completed(xcodebuildLog([once, once])), 56).code, 'QA_TEST_COUNT_INCONSISTENT');
});

test('a bundle that ran outside the configured scope blocks; an empty unconfigured bundle is tolerated', () => {
  const extraRan = xcodebuildLog([
    bundleSession({ bundle: 'AtlasUITests', classes: [{ name: 'Cases', count: 50 }] }),
    bundleSession({ bundle: 'AtlasTests', classes: [{ name: 'Cases', count: 6 }] }),
  ]);
  const verdict = evaluateSuiteAuthority(completed(extraRan), 56, { onlyTesting: ['AtlasUITests'] });
  assert.equal(verdict.blocked, true, JSON.stringify(verdict));
  assert.equal(verdict.code, 'QA_TEST_COUNT_INCONSISTENT');
  assert.match(verdict.reason, /AtlasTests/);

  const extraEmpty = xcodebuildLog([
    bundleSession({ bundle: 'AtlasTests', classes: [] }),
    bundleSession({ bundle: 'AtlasUITests', classes: [{ name: 'Cases', count: 56 }] }),
  ]);
  const tolerated = evaluateSuiteAuthority(completed(extraEmpty), 56, { onlyTesting: ['AtlasUITests'] });
  assert.equal(tolerated.code, 'QA_EXACT_COUNT_VERIFIED', JSON.stringify(tolerated));
});

test('summary-only evidence never verifies: one summary with no case lines is inconsistent, two are ambiguous', () => {
  const one = ['Test Suite \'AtlasUITests.xctest\' started at 2026-09-02 10:00:00.000.', ...suiteEnd('AtlasUITests.xctest', 56), '** TEST SUCCEEDED **'].join('\n');
  const verdict = evaluateSuiteAuthority(completed(one), 56, { onlyTesting: ['AtlasUITests'] });
  assert.equal(verdict.blocked, true, JSON.stringify(verdict));
  assert.equal(verdict.code, 'QA_TEST_COUNT_INCONSISTENT');
  const two = [...suiteEnd('All tests', 30), ...suiteEnd('All tests', 26), '** TEST SUCCEEDED **'].join('\n');
  assert.equal(evaluateSuiteAuthority(completed(two), 56).code, 'QA_TEST_COUNT_AMBIGUOUS');
});

test('a persisted run from before the binding model carries no bundle evidence and fails closed on recompute', () => {
  const legacy = {
    status: 'completed', exitCode: 0,
    counts: {
      executed: 56, failures: 0, summaryCounts: [{ executed: 56, failures: 0 }],
      casesPassed: 56, casesFailed: 0, caseTallies: { AtlasUITests: { passed: 56, failed: 0 } },
      successBannerCount: 1, failureBannerCount: 0, succeeded: true,
    },
  };
  const verdict = evaluateSuiteAuthority(legacy, 56, { onlyTesting: ['AtlasUITests'] });
  assert.equal(verdict.blocked, true, JSON.stringify(verdict));
  assert.notEqual(verdict.code, 'QA_EXACT_COUNT_VERIFIED');
});

test('the streamed run binds evidence the same way: the Objective-C forgery blocks and the honest run verifies', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-bind-'));
  const runStub = async (log) => {
    fs.writeFileSync(path.join(dir, 'out.txt'), `${log}\n`);
    fs.writeFileSync(path.join(dir, 'xcodebuild'), `#!/bin/sh\ncat "${path.join(dir, 'out.txt')}"\nexit 0\n`, { mode: 0o755 });
    const run = startSuiteRun({
      cwd: dir, args: ['test'], logPath: path.join(dir, 'run.log'), timeoutMs: 30000,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
    return run.promise;
  };
  try {
    const forged = await runStub(twoClassBundle({ style: 'objc', bundleSummary: 50, sessionSummary: 50 }));
    assert.equal(forged.status, 'completed');
    assert.equal(forged.exitCode, 0);
    const blocked = evaluateSuiteAuthority(forged, 56, { onlyTesting: ['AtlasUITests'] });
    assert.equal(blocked.blocked, true, JSON.stringify(blocked));
    assert.equal(blocked.code, 'QA_TEST_COUNT_INCONSISTENT');

    const honest = await runStub(twoClassBundle({ style: 'objc' }));
    const verified = evaluateSuiteAuthority(honest, 56, { onlyTesting: ['AtlasUITests'] });
    assert.equal(verified.code, 'QA_EXACT_COUNT_VERIFIED', JSON.stringify(verified));
    assert.equal(honest.counts.bundles.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
