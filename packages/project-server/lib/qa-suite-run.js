'use strict';

/**
 * Run the iOS test suite server-side, so the QA agent never has to babysit it.
 *
 * WHY THIS EXISTS
 *
 * qa_validation used to render an `xcodebuild test` command into the agent's
 * prompt and ask the agent to run it. Because a foreground run blocks the Bash
 * tool (and, past 15 minutes of log silence, trips the idle-stall watchdog),
 * the prompt also told the agent to background the run and tail the log
 * "every few minutes". In practice "every few minutes" became every ~13
 * seconds, and each poll is a full API request that re-reads the whole
 * conversation from cache.
 *
 * Measured across every QA run we can still see (2026-08-26):
 *
 *   fazon FAZ-286   148 requests,  90 polling,  61% of the step's cache reads
 *   deskrhythm #1    39 requests,  17 polling,  47%
 *   deskrhythm #2    47 requests,  16 polling,  37%
 *
 * On FAZ-286 that was 10.8M cache-read tokens spent watching a counter, in a
 * step that was itself 60% of the whole execution run. Non-iOS projects never
 * had the problem: the polling instructions are gated on a configured
 * simulator, and vitest/playwright runs finish inside one foreground call.
 *
 * The cost is turn COUNT, not context size — context sat flat around 90K while
 * 148 requests each paid to re-read it. Nothing the agent learned from poll 40
 * differed from poll 39. So the run moves here: one child process, no tokens,
 * and the agent starts with the answer instead of waiting for it.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not replace the QA agent. Visual smoke, test-data cleanup, failure
 * triage and the gate-parseable report all stay with the agent — only the
 * blocking wait is hoisted.
 */

const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { finished } = require('stream');

/** A suite that has not finished in this long is not going to. */
const DEFAULT_TIMEOUT_MINUTES = 45;
/** How long SIGTERM gets to work before SIGKILL. */
const KILL_GRACE_MS = 10 * 1000;
/** Progress is recomputed from the stream, not by re-reading the log. */
const PROGRESS_INTERVAL_MS = 15 * 1000;

/**
 * Parallel-testing flags for a project's `simulator.parallel_testing`.
 *
 * Cloning halves wallclock, but on some iOS-26 simulator cohorts the clones
 * crash on boot (FBSOpenApplicationServiceError cascade) and make XCUITests
 * flaky, so a project can dial it down: `false` → serial, a number → capped
 * workers, unset/true → full parallel.
 */
function parallelArgs(parallelTesting) {
  if (parallelTesting === false) return ['-parallel-testing-enabled', 'NO'];
  if (typeof parallelTesting === 'number') {
    return ['-parallel-testing-enabled', 'YES', '-parallel-testing-worker-count', String(parallelTesting)];
  }
  return ['-parallel-testing-enabled', 'YES'];
}

/**
 * The argv for the run. Built as an ARRAY and spawned without a shell — the
 * agent-facing version of this command was a shell string, which is where
 * `-resultBundlePath` and quoting mistakes used to creep in.
 */
function buildXcodebuildArgs({
  project, scheme, destination, parallelTesting, onlyTesting = [],
  testLanguage, derivedDataPath, resultBundlePath,
}) {
  if (!project) throw new Error('buildXcodebuildArgs: project is required');
  if (!scheme) throw new Error('buildXcodebuildArgs: scheme is required');
  if (!destination) throw new Error('buildXcodebuildArgs: destination is required');
  // Reject prompt placeholders before they reach xcodebuild.
  //
  // The prompt text this replaced carries `<Scheme>` deliberately — it means
  // "substitute your project's scheme", and an agent reading it does. The
  // server does not, and an unsubstituted one produced
  // `-only-testing:<Scheme>Tests`: xcodebuild aborted during target resolution
  // in 683ms having run nothing, and the failure surfaced a whole step later as
  // a gate that could not run. Fail here instead, where the caller falls back
  // to the agent-run path (2026-08-29).
  for (const [name, value] of [['project', project], ['scheme', scheme], ['destination', destination]]) {
    if (/<[^>]+>/.test(String(value))) {
      throw new Error(`buildXcodebuildArgs: ${name} still contains a placeholder (${value})`);
    }
  }
  const args = ['test', '-project', project, '-scheme', scheme, '-destination', destination];
  args.push(...parallelArgs(parallelTesting));
  for (const [flag, value] of [
    ['-testLanguage', testLanguage],
    ['-derivedDataPath', derivedDataPath],
    ['-resultBundlePath', resultBundlePath],
  ]) {
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`buildXcodebuildArgs: ${flag.slice(1)} must be a non-empty string`);
    }
    if (/<[^>]+>/.test(value)) {
      throw new Error(`buildXcodebuildArgs: ${flag.slice(1)} still contains a placeholder (${value})`);
    }
    args.push(flag, value);
  }
  for (const t of onlyTesting) {
    if (!t) continue;
    // A scope target is built from the scheme too (`<Scheme>Tests`), so it
    // carries the same placeholder risk and the same silent failure.
    if (/<[^>]+>/.test(String(t))) {
      throw new Error(`buildXcodebuildArgs: only-testing target still contains a placeholder (${t})`);
    }
    args.push(`-only-testing:${t}`);
  }
  return args;
}

/** A filesystem-safe label only; identity remains in the persisted run record. */
function safeArtifactLabel(value) {
  const cleaned = String(value || 'run').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return (cleaned || 'run').slice(0, 80);
}

/**
 * Atomically reserve a unique artifact directory for one server-run attempt.
 * mkdtemp is the stale-artifact guard: an existing result bundle can never be
 * mistaken for output from this attempt, including a retry of the same round.
 */
function createNativeArtifactPaths({ projectRoot, runId, round, fsImpl = fs }) {
  if (!projectRoot) throw new Error('createNativeArtifactPaths: projectRoot is required');
  const parent = path.join(projectRoot, 'tmp', 'qa-artifacts');
  fsImpl.mkdirSync(parent, { recursive: true });
  const prefix = `${safeArtifactLabel(runId)}-r${Number.isInteger(round) && round > 0 ? round : 1}-`;
  const artifactDir = fsImpl.mkdtempSync(path.join(parent, prefix));
  return {
    schemaVersion: 1,
    artifactDir,
    derivedDataPath: path.join(artifactDir, 'DerivedData'),
    resultBundlePath: path.join(artifactDir, 'result.xcresult'),
  };
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function regularFilesBelow(root, fsImpl = fs) {
  const files = [];
  const visit = (dir) => {
    for (const name of fsImpl.readdirSync(dir).sort()) {
      const absolute = path.join(dir, name);
      const stat = fsImpl.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`symbolic link is not valid xcresult evidence: ${path.relative(root, absolute)}`);
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile()) files.push({ absolute, relative: path.relative(root, absolute), size: stat.size });
    }
  };
  visit(root);
  return files.sort((a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0);
}

function parseAppleSummary(raw) {
  let value;
  try { value = JSON.parse(String(raw)); } catch (e) { throw new Error(`xcresult summary is not JSON (${e.message})`); }
  const keys = ['totalTestCount', 'passedTests', 'failedTests', 'skippedTests', 'expectedFailures'];
  for (const key of keys) {
    if (!Number.isInteger(value[key]) || value[key] < 0) {
      throw new Error(`xcresult summary ${key} is not a non-negative integer`);
    }
  }
  if (typeof value.result !== 'string' || !value.result) throw new Error('xcresult summary result is missing');
  return Object.fromEntries([...keys, 'result'].map((key) => [key, value[key]]));
}

/** Collect a content-digest snapshot after xcodebuild and the log flush. */
function collectNativeArtifacts({
  logPath, resultBundlePath, derivedDataPath,
  fsImpl = fs, execFileSyncImpl = execFileSync,
}) {
  const base = {
    schemaVersion: 1,
    derivedDataPath,
    resultBundle: { path: resultBundlePath },
    log: { path: logPath },
  };
  let logBytes;
  try { logBytes = fsImpl.readFileSync(logPath); } catch (e) {
    return { ...base, status: 'error', code: 'QA_LOG_ARTIFACT_UNAVAILABLE', error: e.message };
  }
  base.log.sha256 = sha256(logBytes);
  let files;
  try {
    if (!fsImpl.statSync(resultBundlePath).isDirectory()) throw new Error('result bundle is not a directory');
    files = regularFilesBelow(resultBundlePath, fsImpl);
    if (files.length === 0) throw new Error('result bundle contains no regular files');
  } catch (e) {
    return { ...base, status: 'error', code: 'QA_APPLE_RESULT_MISSING', error: e.message };
  }
  const manifest = [];
  let totalBytes = 0;
  try {
    for (const file of files) {
      const bytes = fsImpl.readFileSync(file.absolute);
      totalBytes += file.size;
      manifest.push(`${sha256(bytes)} ${file.size} ${file.relative}\n`);
    }
  } catch (e) {
    return { ...base, status: 'error', code: 'QA_RESULT_BUNDLE_DIGEST_FAILED', error: e.message };
  }
  base.resultBundle = {
    path: resultBundlePath,
    fileCount: files.length,
    totalBytes,
    manifestDigest: sha256(manifest.join('')),
  };
  let rawSummary;
  try {
    rawSummary = execFileSyncImpl('xcrun', [
      'xcresulttool', 'get', 'test-results', 'summary',
      '--path', resultBundlePath, '--compact',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return { ...base, status: 'error', code: 'QA_APPLE_RESULT_UNAVAILABLE', error: e.message };
  }
  try {
    return { ...base, status: 'complete', apple: parseAppleSummary(rawSummary) };
  } catch (e) {
    return { ...base, status: 'error', code: 'QA_APPLE_RESULT_INVALID', error: e.message };
  }
}

/** Human-readable form of the argv, for the prompt and for error messages. */
function displayCommand(args) {
  return ['xcodebuild', ...args.map(a => (/[\s"']/.test(a) ? JSON.stringify(a) : a))].join(' ');
}

/**
 * Test counts from xcodebuild stdout.
 *
 * Evidence is read off the NATIVE HIERARCHY, not off the numbers. Serial
 * xcodebuild output nests `Test Suite 'All tests'` (or `'Selected tests'`) →
 * `Test Suite '<Bundle>.xctest'` → `Test Suite '<Class>'` → `Test Case` lines,
 * and closes every suite with `Test Suite '<name>' passed|failed at` followed
 * by that suite's own `Executed N tests, with M failures` summary. The
 * `.xctest` boundary is the only stable identity in the stream: a Swift case
 * prints as `-[Module.Class method]`, an Objective-C case as `-[Class method]`,
 * and neither names its bundle. So a bundle is a `.xctest` boundary, its cases
 * are the case lines inside that boundary, and its summary is the `Executed`
 * line that closes it. Nothing is inferred from the case name and nothing is
 * matched by equal counts — the second review of this file found both
 * inferences forgeable (one summary vouching for two equal-count bundles; two
 * Objective-C classes masquerading as two bundles).
 *
 * `succeeded` comes from the `** TEST SUCCEEDED **` / `** TEST FAILED **`
 * banner, and is null when neither appeared — a run killed on timeout has
 * counts but no verdict, and reporting a verdict we did not see would be worse
 * than reporting none.
 */
const CASE_LINE = /^Test Case '(.*)' (passed|failed) \(/;
const SUITE_START_LINE = /^Test Suite '(.*)' started at /;
const SUITE_END_LINE = /^Test Suite '(.*)' (passed|failed) at /;
const SUMMARY_LINE = /^\s*Executed (\d+) tests?, with (\d+) failures?/;
const SUCCESS_BANNER = /\*\* TEST SUCCEEDED \*\*/g;
const FAILURE_BANNER = /\*\* TEST (?:FAILED|BUILD FAILED) \*\*/g;
const BUNDLE_SUFFIX = /\.xctest$/;

/** The bundle a `Test Suite` name denotes, or null when it is a session or class suite. */
function bundleNameOf(suiteName) {
  return BUNDLE_SUFFIX.test(suiteName) ? suiteName.replace(BUNDLE_SUFFIX, '') : null;
}

/** The test target an `only_testing` entry (`Target`, `Target/Class`, `Target/Class/method`) names. */
function targetOf(entry) {
  const head = String(entry || '').trim().split('/')[0];
  return head || null;
}

function createTally() {
  return {
    casesPassed: 0, casesFailed: 0,
    // One entry per `.xctest` boundary in output order. `ordinal` disambiguates
    // a bundle that appears twice (a replay), which is never valid evidence.
    bundles: [],
    // Indexes into `bundles` of boundaries opened and not yet closed, innermost last.
    openBundles: [],
    // Case lines seen outside every bundle boundary. They belong to nothing.
    unboundCases: { passed: 0, failed: 0 },
    // The suite a `Test Suite ... passed|failed at` line just closed; the next
    // `Executed` line is that suite's summary and nobody else's.
    pendingSummaryOwner: null,
    summaryCounts: [],
    successBannerCount: 0, failureBannerCount: 0,
  };
}

function openBundle(tally, name) {
  const ordinal = tally.bundles.filter((b) => b.name === name).length + 1;
  tally.bundles.push({ name, ordinal, passed: 0, failed: 0, started: true, closed: false, summaries: [] });
  return tally.bundles.length - 1;
}

/** Fold one COMPLETE line of xcodebuild output into the tally. */
function tallyLine(tally, line) {
  const kase = CASE_LINE.exec(line);
  if (kase) {
    tally.pendingSummaryOwner = null;
    const open = tally.openBundles.length ? tally.bundles[tally.openBundles[tally.openBundles.length - 1]] : null;
    const bucket = open || tally.unboundCases;
    if (kase[2] === 'passed') { tally.casesPassed++; bucket.passed++; } else { tally.casesFailed++; bucket.failed++; }
    return;
  }
  const started = SUITE_START_LINE.exec(line);
  if (started) {
    tally.pendingSummaryOwner = null;
    const bundle = bundleNameOf(started[1]);
    if (bundle !== null) tally.openBundles.push(openBundle(tally, bundle));
    return;
  }
  const ended = SUITE_END_LINE.exec(line);
  if (ended) {
    const bundle = bundleNameOf(ended[1]);
    let bundleIndex = null;
    if (bundle !== null) {
      for (let i = tally.openBundles.length - 1; i >= 0; i--) {
        if (tally.bundles[tally.openBundles[i]].name === bundle) {
          bundleIndex = tally.openBundles.splice(i, 1)[0];
          break;
        }
      }
      if (bundleIndex === null) {
        // Closed without ever starting: a boundary that encloses no cases. Its
        // summary is recorded against an empty tally, which cannot corroborate.
        bundleIndex = openBundle(tally, bundle);
        tally.bundles[bundleIndex].started = false;
      }
      tally.bundles[bundleIndex].closed = true;
    }
    tally.pendingSummaryOwner = { suite: ended[1], bundleIndex };
    return;
  }
  const summary = SUMMARY_LINE.exec(line);
  if (summary) {
    const owner = tally.pendingSummaryOwner;
    const entry = {
      executed: parseInt(summary[1], 10), failures: parseInt(summary[2], 10),
      suite: owner ? owner.suite : null,
      bundle: owner && owner.bundleIndex !== null
        ? `${tally.bundles[owner.bundleIndex].name}#${tally.bundles[owner.bundleIndex].ordinal}`
        : null,
    };
    const index = tally.summaryCounts.push(entry) - 1;
    if (owner && owner.bundleIndex !== null) {
      tally.bundles[owner.bundleIndex].summaries.push({ executed: entry.executed, failures: entry.failures, index });
    }
    // The owner is kept until the next suite or case line: a second
    // `Executed` line closing the same boundary is two claims for one bundle,
    // which the authority rejects, not a stray line to be ignored.
  }
  tally.successBannerCount += (line.match(SUCCESS_BANNER) || []).length;
  tally.failureBannerCount += (line.match(FAILURE_BANNER) || []).length;
}

function tallyText(tally, text) {
  for (const line of String(text || '').split('\n')) tallyLine(tally, line);
}

/** The counts object the rest of the server reads, from a finished tally. */
function finalizeTally(tally) {
  const sawSummary = tally.summaryCounts.length > 0;
  // `executed`/`failures` are the display sum of every native summary in the
  // log, as before. The authority never reads them: it reads `bundles`.
  const executed = tally.summaryCounts.reduce((n, item) => n + item.executed, 0);
  const failures = tally.summaryCounts.reduce((n, item) => n + item.failures, 0);
  const succeeded = tally.successBannerCount > 0 && tally.failureBannerCount === 0
    ? true
    : (tally.failureBannerCount > 0 && tally.successBannerCount === 0 ? false : null);
  return {
    executed: sawSummary ? executed : null,
    failures: sawSummary ? failures : null,
    summaryCounts: tally.summaryCounts.map((item) => ({ ...item })),
    casesPassed: tally.casesPassed,
    casesFailed: tally.casesFailed,
    bundles: tally.bundles.map((b) => ({ ...b, summaries: b.summaries.map((s) => ({ ...s })) })),
    unboundCases: { ...tally.unboundCases },
    successBannerCount: tally.successBannerCount,
    failureBannerCount: tally.failureBannerCount,
    succeeded,
  };
}

function parseTestCounts(text) {
  const tally = createTally();
  tallyText(tally, text);
  return finalizeTally(tally);
}

/**
 * Bind every expected test bundle to its own native evidence, one-to-one.
 *
 * The expected bundles are the targets named by `only_testing` when it is
 * configured, otherwise every bundle boundary the run printed. Each must be
 * exactly one `.xctest` boundary that started, closed, and was closed by
 * exactly one `Executed` summary equal to the case tally inside it. A summary
 * is consumed by the boundary that printed it and by nothing else; a bundle
 * that appears twice, a case outside every boundary, and a bundle that ran
 * outside the configured scope are all inconsistent evidence. Counts are
 * never compared across bundles.
 */
function bindBundleEvidence(counts, onlyTesting) {
  const block = (code, reason) => ({ blocked: true, code, reason });
  const sessions = (Array.isArray(counts.bundles) ? counts.bundles : []).filter((b) => b
    && typeof b.name === 'string' && b.name
    && Number.isInteger(b.passed) && b.passed >= 0 && Number.isInteger(b.failed) && b.failed >= 0
    && Array.isArray(b.summaries));
  const unbound = counts.unboundCases && typeof counts.unboundCases === 'object' ? counts.unboundCases : {};
  const unboundTotal = (Number.isInteger(unbound.passed) ? unbound.passed : 0) + (Number.isInteger(unbound.failed) ? unbound.failed : 0);
  const caseTotal = counts.casesPassed + counts.casesFailed;
  if (!Array.isArray(counts.bundles) || !counts.unboundCases) {
    return block('QA_TEST_COUNT_INCONSISTENT', 'the run carries no native test-bundle evidence (recorded before bundle binding); rerun the suite');
  }
  if (unboundTotal > 0) {
    return block('QA_TEST_COUNT_INCONSISTENT', `${unboundTotal} test-case results were printed outside any native test bundle (Test Suite '<Target>.xctest') boundary`);
  }
  const configured = [...new Set((Array.isArray(onlyTesting) ? onlyTesting : []).map(targetOf).filter(Boolean))];
  const expected = configured.length ? configured : [...new Set(sessions.map((b) => b.name))];
  if (expected.length === 0) {
    return block('QA_TEST_COUNT_INCONSISTENT', `parsed ${caseTotal} test-case results but no native test bundle (Test Suite '<Target>.xctest') boundary`);
  }
  const consumed = new Set();
  const bound = [];
  let executed = 0;
  let failures = 0;
  for (const name of expected) {
    const matches = sessions.filter((b) => b.name === name);
    if (matches.length === 0) {
      return block('QA_TEST_TARGET_UNBOUND', `configured target ${name} produced no native test bundle (Test Suite '${name}.xctest') in the xcodebuild output`);
    }
    if (matches.length > 1) {
      return block('QA_TEST_COUNT_INCONSISTENT', `test bundle ${name} appeared ${matches.length} times in one xcodebuild run`);
    }
    const session = matches[0];
    const tally = session.passed + session.failed;
    if (!session.closed) {
      return block('QA_TEST_COUNT_INCONSISTENT', `test bundle ${name} started but was never closed by a native summary`);
    }
    if (session.summaries.length !== 1) {
      return block(
        'QA_TEST_COUNT_INCONSISTENT',
        session.summaries.length === 0
          ? `test bundle ${name} has no native Executed summary of its own (${tally} test-case results inside its boundary)`
          : `test bundle ${name} closed with ${session.summaries.length} native Executed summaries`,
      );
    }
    const summary = session.summaries[0];
    if (!Number.isInteger(summary.executed) || !Number.isInteger(summary.failures) || consumed.has(summary.index)) {
      return block('QA_TEST_COUNT_INCONSISTENT', `test bundle ${name} is bound to a summary that is not its own`);
    }
    consumed.add(summary.index);
    if (summary.executed !== tally || summary.failures !== session.failed) {
      return block(
        'QA_TEST_COUNT_INCONSISTENT',
        `test bundle ${name}: its native summary reports ${summary.executed} executed with ${summary.failures} failures, but ${tally} test-case results with ${session.failed} failures were parsed inside its boundary`,
      );
    }
    executed += tally;
    failures += session.failed;
    bound.push(`${name}=${tally}/${session.failed}`);
  }
  const outside = sessions.filter((b) => !expected.includes(b.name)
    && (b.passed + b.failed > 0 || b.summaries.some((s) => s.executed > 0)));
  if (outside.length) {
    return block('QA_TEST_COUNT_INCONSISTENT', `test bundle(s) ${[...new Set(outside.map((b) => b.name))].join(', ')} ran outside the configured only_testing scope`);
  }
  if (executed !== caseTotal) {
    return block('QA_TEST_COUNT_INCONSISTENT', `${caseTotal - executed} test-case results were parsed outside the bound test bundles`);
  }
  return { blocked: false, executed, failures, bound };
}

/**
 * Evaluate the immutable server-side authority for an exact-count QA run.
 *
 * The agent still explains failures and inspects visual evidence, but it never
 * decides whether the configured executable test inventory actually ran. Once
 * `expected_test_count` is present, only a completed xcodebuild process with a
 * coherent native count, one success verdict, exit 0 and exactly that count can
 * pass. Missing or contradictory evidence is a block, not an invitation to
 * infer a result from prose.
 *
 * `onlyTesting` is the configured `qa_validation.only_testing` list the run
 * was spawned with; every target in it must bind to its own bundle evidence
 * (see bindBundleEvidence). Without it, every bundle the run printed must.
 */
function evaluateSuiteAuthority(run, expectedTestCount, { onlyTesting, appleResultAuthority = false } = {}) {
  if (expectedTestCount === undefined || expectedTestCount === null) {
    return { configured: false, blocked: false, code: 'QA_EXACT_COUNT_NOT_CONFIGURED' };
  }
  const base = { configured: true, expectedTestCount, appleResultAuthority: appleResultAuthority === true };
  const block = (code, reason, actualTestCount = null) => ({
    ...base, blocked: true, code, reason, actualTestCount,
  });

  if (!Number.isInteger(expectedTestCount) || expectedTestCount <= 0) {
    return block('QA_EXPECTED_TEST_COUNT_INVALID', 'expected_test_count is not a positive integer');
  }
  if (!run || run.status !== 'completed') {
    const status = (run && run.status) || 'missing';
    const code = status === 'unavailable' ? 'QA_SERVER_SUITE_UNAVAILABLE'
      : status === 'timeout' ? 'QA_SERVER_SUITE_TIMEOUT'
        : 'QA_SUITE_INCOMPLETE';
    return block(code, `server suite did not complete (status: ${status}${run && run.error ? `; ${run.error}` : ''})`);
  }

  const counts = run.counts || {};
  const successBanners = Number.isInteger(counts.successBannerCount)
    ? counts.successBannerCount
    : (counts.succeeded === true ? 1 : 0);
  const failureBanners = Number.isInteger(counts.failureBannerCount)
    ? counts.failureBannerCount
    : (counts.succeeded === false ? 1 : 0);
  if (successBanners > 1 || failureBanners > 1 || (successBanners > 0 && failureBanners > 0)) {
    return block('QA_TEST_VERDICT_AMBIGUOUS', 'xcodebuild emitted duplicate or contradictory TEST SUCCEEDED/FAILED banners');
  }

  const summaries = Array.isArray(counts.summaryCounts) ? counts.summaryCounts : [];
  const validSummaries = summaries.filter((item) => item
    && Number.isInteger(item.executed) && item.executed >= 0
    && Number.isInteger(item.failures) && item.failures >= 0);
  const caseTotal = Number.isInteger(counts.casesPassed) && Number.isInteger(counts.casesFailed)
    ? counts.casesPassed + counts.casesFailed
    : 0;

  if (caseTotal === 0) {
    // Summaries alone never carry a verdict: a summary is corroboration for
    // case lines, not a substitute for them.
    const unique = new Set(validSummaries.map((item) => `${item.executed}:${item.failures}`));
    if (unique.size === 0) {
      return block('QA_TEST_COUNT_MISSING', 'no native Executed test-count summary and no test-case results were parsed');
    }
    if (unique.size > 1) {
      return block('QA_TEST_COUNT_AMBIGUOUS', 'multiple different native Executed summaries were parsed and no per-case tally disambiguates them');
    }
    return block('QA_TEST_COUNT_INCONSISTENT', `a native summary reports ${validSummaries[0].executed} executed tests but no test-case results were parsed`);
  }
  // No native summary may claim more tests than were seen to run: that is
  // either a summary from somewhere else or per-case evidence that was lost.
  const oversized = validSummaries.find((item) => item.executed > caseTotal);
  if (oversized) {
    return block(
      'QA_TEST_COUNT_INCONSISTENT',
      `a native summary reports ${oversized.executed} executed tests but only ${caseTotal} test-case results were parsed`,
      caseTotal,
    );
  }
  if (validSummaries.length === 0) {
    return block('QA_TEST_COUNT_MISSING', `parsed ${caseTotal} test-case results but no native Executed summary`, caseTotal);
  }
  const binding = bindBundleEvidence(counts, onlyTesting);
  if (binding.blocked) {
    return block(binding.code, `test-case tally parsed ${caseTotal} tests with ${counts.casesFailed} failures, but ${binding.reason}`, caseTotal);
  }
  const actualTestCount = binding.executed;
  const actualFailures = binding.failures;

  if (successBanners !== 1 || failureBanners !== 0 || counts.succeeded !== true) {
    return block(
      failureBanners > 0 || counts.succeeded === false ? 'QA_TESTS_FAILED' : 'QA_TEST_VERDICT_MISSING',
      failureBanners > 0 || counts.succeeded === false
        ? 'xcodebuild reported TEST FAILED'
        : 'xcodebuild did not emit exactly one uncontradicted TEST SUCCEEDED banner',
      actualTestCount,
    );
  }
  if (run.exitCode !== 0) {
    return block('QA_XCODEBUILD_EXIT_NONZERO', `xcodebuild exited ${run.exitCode}`, actualTestCount);
  }
  if (actualFailures !== 0) {
    return block('QA_TESTS_FAILED', `parsed ${actualFailures} failing tests`, actualTestCount);
  }
  if (actualTestCount !== expectedTestCount) {
    return block(
      'QA_EXPECTED_TEST_COUNT_MISMATCH',
      `expected ${expectedTestCount} executable tests but parsed ${actualTestCount}`,
      actualTestCount,
    );
  }
  const stdoutPass = {
    ...base,
    blocked: false,
    code: 'QA_EXACT_COUNT_VERIFIED',
    reason: `expected ${expectedTestCount} executable tests and parsed exactly ${actualTestCount} across ${binding.bound.length} native test bundle${binding.bound.length === 1 ? '' : 's'} (${binding.bound.join(', ')}); zero failures; TEST SUCCEEDED; exit 0`,
    actualTestCount,
  };
  if (!appleResultAuthority) return stdoutPass;

  const artifacts = run.artifacts;
  if (!artifacts) {
    return block('QA_APPLE_RESULT_MISSING', 'Apple result authority is configured but the run carries no xcresult evidence', actualTestCount);
  }
  if (artifacts.status !== 'complete') {
    return block(artifacts.code || 'QA_APPLE_RESULT_UNAVAILABLE', artifacts.error || 'xcresult evidence collection did not complete', actualTestCount);
  }
  if (!artifacts.log || !/^[0-9a-f]{64}$/.test(artifacts.log.sha256 || '')
      || !artifacts.resultBundle || !/^[0-9a-f]{64}$/.test(artifacts.resultBundle.manifestDigest || '')
      || !Number.isInteger(artifacts.resultBundle.fileCount) || artifacts.resultBundle.fileCount <= 0) {
    return block('QA_ARTIFACT_DIGEST_MISSING', 'native QA artifacts are not bound to both a raw-log digest and a non-empty xcresult manifest digest', actualTestCount);
  }
  const apple = artifacts.apple || {};
  for (const key of ['totalTestCount', 'passedTests', 'failedTests', 'skippedTests', 'expectedFailures']) {
    if (!Number.isInteger(apple[key]) || apple[key] < 0) {
      return block('QA_APPLE_RESULT_INVALID', `Apple result field ${key} is missing or invalid`, actualTestCount);
    }
  }
  if (apple.totalTestCount !== actualTestCount || apple.failedTests !== actualFailures) {
    return block(
      'QA_APPLE_STDOUT_CONTRADICTION',
      `Apple reports ${apple.totalTestCount} total/${apple.failedTests} failed while native stdout binds ${actualTestCount} total/${actualFailures} failed`,
      actualTestCount,
    );
  }
  if (apple.result !== 'Passed' || apple.totalTestCount !== expectedTestCount
      || apple.passedTests !== expectedTestCount || apple.failedTests !== 0
      || apple.skippedTests !== 0 || apple.expectedFailures !== 0) {
    return block(
      'QA_APPLE_RESULT_NOT_CLEAN',
      `Apple result is ${apple.result || 'missing'} with ${apple.totalTestCount} total, ${apple.passedTests} passed, ${apple.failedTests} failed, ${apple.skippedTests} skipped and ${apple.expectedFailures} expected failures`,
      actualTestCount,
    );
  }
  return {
    ...stdoutPass,
    code: 'QA_APPLE_RESULT_VERIFIED',
    reason: `${stdoutPass.reason}; Apple xcresult independently reports ${apple.passedTests}/${apple.totalTestCount} passed with zero failed, skipped or expected failures`,
    appleTotalTestCount: apple.totalTestCount,
    logSha256: artifacts.log.sha256,
    resultBundleManifestDigest: artifacts.resultBundle.manifestDigest,
  };
}

/** Lines worth putting in front of the agent when something went wrong. */
function failureExcerpt(text, maxLines = 60) {
  const lines = String(text || '').split('\n');
  const interesting = lines.filter(l =>
    /^Test Case .*' failed \(/.test(l)
    || /error:/i.test(l)
    || /\*\* TEST (FAILED|BUILD FAILED) \*\*/.test(l)
    || /Executed \d+ tests?, with \d+ failure/.test(l));
  return interesting.slice(-maxLines).join('\n');
}

/**
 * Which .xcodeproj and which scheme, when the project has not said.
 *
 * `simulator.scheme` / `simulator.project` are optional and frequently unset —
 * the agent-run path told the agent to "find it with xcodebuild -list", so
 * plenty of working projects never needed them. The server has to do the same
 * lookup, and has to be stricter about it: an agent that picks the wrong scheme
 * notices and retries, a server just runs the wrong tests.
 *
 * The trap is real. fazon's project carries TWO schemes — `Copy of Fazon` and
 * `Fazon` — and they sort with the copy first, so "take the first scheme" picks
 * the abandoned duplicate. The rule is therefore: the scheme NAMED AFTER THE
 * PROJECT wins; failing that, a lone scheme wins; anything else is ambiguous
 * and we decline rather than guess, falling back to letting the agent run it.
 *
 * @returns {{project:string, scheme:string}|{error:string}}
 */
function discoverProjectAndScheme({ projectRoot, simulator }) {
  const sim = simulator || {};
  let project = sim.project || null;
  if (!project) {
    for (const dir of ['ios', '.']) {
      const abs = path.join(projectRoot, dir);
      let entries = [];
      try { entries = fs.readdirSync(abs); } catch (_) { continue; }
      const found = entries.filter(f => f.endsWith('.xcodeproj')).sort();
      if (found.length === 1) { project = dir === '.' ? found[0] : path.join(dir, found[0]); break; }
      if (found.length > 1) return { error: `${found.length} .xcodeproj files in ${dir}/ — set simulator.project` };
    }
  }
  if (!project) return { error: 'no .xcodeproj found — set simulator.project' };
  if (sim.scheme) return { project, scheme: sim.scheme };

  let listed;
  try {
    // stderr carries unrelated Xcode chatter (DVTDeviceOperation warnings), so
    // parse from the first brace rather than trusting the whole stream.
    const raw = execFileSync('xcodebuild', ['-list', '-json', '-project', project],
      { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 120000 });
    listed = JSON.parse(raw.slice(raw.indexOf('{')));
  } catch (e) {
    return { error: `xcodebuild -list failed (${e.message}) — set simulator.scheme` };
  }
  const info = listed.project || listed.workspace || {};
  const schemes = Array.isArray(info.schemes) ? info.schemes : [];
  if (schemes.length === 0) return { error: `no schemes in ${project} — set simulator.scheme` };
  const named = schemes.find(s => s === info.name);
  if (named) return { project, scheme: named };
  if (schemes.length === 1) return { project, scheme: schemes[0] };
  return { error: `${schemes.length} schemes and none named "${info.name}" — set simulator.scheme` };
}

/**
 * Every run this process started, so a shutdown can take them with it.
 *
 * The runs are spawned into their own process GROUP (see startSuiteRun), which
 * makes them survivable by default — that is the point for killing, and a
 * liability at exit. Without this, quitting the app would leave an xcodebuild
 * holding the simulator with nothing left that knows how to wait for it.
 */
const activeRuns = new Set();

/**
 * Signal a whole process group.
 *
 * `child.kill()` signals only xcodebuild itself, and xcodebuild is a
 * supervisor: it spawns the build, the simulator runner and the test host.
 * Signalling the leader alone leaves those running and the stdio pipes open, so
 * the run neither stops nor reports — a timeout would hang instead of firing
 * (caught by the timeout test, which took the full 60s before this).
 */
function killGroup(pid, signal) {
  if (!pid) return;
  try {
    process.kill(-pid, signal); // negative pid = the group
  } catch (_) {
    try { process.kill(pid, signal); } catch (_) { /* already gone */ }
  }
}

/** Stop every suite this process started. Called on server shutdown. */
function killAllActive() {
  for (const pid of activeRuns) killGroup(pid, 'SIGTERM');
  activeRuns.clear();
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * Is another xcodebuild test already in flight anywhere on this machine?
 *
 * The simulator handles one test session at a time; a second run queues behind
 * the first, doubles wallclock and leaves zombie clones. When one is running we
 * decline to start rather than queue, and the caller falls back to letting the
 * agent handle it with the pre-existing "one xcodebuild at a time" guidance.
 */
function xcodebuildInFlight() {
  try {
    const out = execFileSync('pgrep', ['-f', 'xcodebuild.*test'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').map(s => s.trim()).filter(Boolean).length > 0;
  } catch (_) {
    return false; // pgrep exits non-zero when nothing matched
  }
}

/**
 * Spawn the suite, stream it to `logPath`, and resolve when it ends.
 *
 * Resolves rather than rejects on a failing suite: a red suite is a normal,
 * reportable outcome, not an error in running it. It rejects only when the
 * process could not be started at all.
 *
 * @returns {{pid:number|null, promise:Promise<object>, cancel:function}}
 */
function startSuiteRun({
  cwd, args, logPath, timeoutMs, env, onProgress,
  nativeArtifactPaths, execFileSyncImpl,
}) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const out = fs.createWriteStream(logPath, { flags: 'w' });
  const startedAt = Date.now();

  let child;
  try {
    // detached: its own process group, so a timeout or a cancel can take the
    // whole tree down rather than just the supervisor. The cost is that the run
    // outlives this process, which is what activeRuns/killAllActive is for.
    child = spawn('xcodebuild', args, { cwd, env: env || process.env, detached: true });
  } catch (e) {
    out.end();
    return { pid: null, promise: Promise.reject(e), cancel: () => {} };
  }
  if (child.pid) activeRuns.add(child.pid);

  // Counts are tallied off the STREAM. Re-reading a multi-megabyte log every
  // 15s to answer "how far along is it" would just move the waste from tokens
  // to disk.
  let tail = '';
  // The tally is folded off the stream, line by line, so a two-target run's
  // first summary — printed mid-log, easily outside the tail window — counts
  // exactly like the last one. The tail survives only for the failure excerpt.
  const caseLineBuffers = { stdout: '', stderr: '' };
  const tally = createTally();
  const absorb = (source, buf) => {
    const chunk = buf.toString('utf8');
    out.write(chunk);
    const combined = caseLineBuffers[source] + chunk;
    const lastNewline = combined.lastIndexOf('\n');
    if (lastNewline >= 0) {
      tallyText(tally, combined.slice(0, lastNewline));
      caseLineBuffers[source] = combined.slice(lastNewline + 1);
    } else {
      caseLineBuffers[source] = combined;
    }
    tail = (tail + chunk).slice(-200000); // enough for the failure excerpt
  };
  child.stdout.on('data', (buf) => absorb('stdout', buf));
  child.stderr.on('data', (buf) => absorb('stderr', buf));

  const progressTimer = onProgress && setInterval(() => {
    try {
      onProgress({ casesPassed: tally.casesPassed, casesFailed: tally.casesFailed, elapsedMs: Date.now() - startedAt });
    } catch (_) { /* progress is advisory — never let it kill the run */ }
  }, PROGRESS_INTERVAL_MS);

  let timedOut = false;
  let killTimer = null;
  const timeoutTimer = timeoutMs > 0 && setTimeout(() => {
    timedOut = true;
    killGroup(child.pid, 'SIGTERM');
    killTimer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), KILL_GRACE_MS);
  }, timeoutMs);

  const promise = new Promise((resolve, reject) => {
    let settled = false;
    let childResult = null;
    let writerFinished = false;
    let writerError = null;
    const settleAfterWriter = () => {
      if (settled || !childResult || !writerFinished) return;
      settled = true;
      if (writerError) {
        childResult.status = 'error';
        childResult.error = `QA log writer failed (${writerError.message || writerError})`;
      } else if (nativeArtifactPaths) {
        childResult.artifacts = collectNativeArtifacts({
          logPath,
          resultBundlePath: nativeArtifactPaths.resultBundlePath,
          derivedDataPath: nativeArtifactPaths.derivedDataPath,
          ...(execFileSyncImpl ? { execFileSyncImpl } : {}),
        });
      }
      resolve(childResult);
    };
    // Observe the writer itself, not out.end(callback): Node invokes the end
    // callback with an error before emitting `error` when finalization fails.
    // `finished` handles both pre-close write failures and final-flush errors.
    finished(out, (error) => {
      writerError = error || null;
      writerFinished = true;
      if (writerError && child.exitCode === null && child.signalCode === null) {
        killGroup(child.pid, 'SIGTERM');
        if (!killTimer) killTimer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), KILL_GRACE_MS);
      }
      settleAfterWriter();
    });
    child.on('error', (e) => {
      if (progressTimer) clearInterval(progressTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (child.pid) activeRuns.delete(child.pid);
      out.end();
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
    child.on('close', (code, signal) => {
      if (progressTimer) clearInterval(progressTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (child.pid) activeRuns.delete(child.pid);
      for (const source of ['stdout', 'stderr']) {
        if (caseLineBuffers[source]) tallyLine(tally, caseLineBuffers[source]);
        caseLineBuffers[source] = '';
      }
      const counts = finalizeTally(tally);
      childResult = {
        status: timedOut ? 'timeout' : 'completed',
        exitCode: code,
        signal: signal || null,
        durationMs: Date.now() - startedAt,
        logPath,
        counts,
        failureExcerpt: failureExcerpt(tail),
      };
      // The log is authoritative evidence. Ending requests the flush; actual
      // settlement happens only from the `finished` observer above.
      out.end();
      settleAfterWriter();
    });
  });

  return {
    pid: child.pid || null,
    promise,
    cancel: () => killGroup(child.pid, 'SIGTERM'),
  };
}

/** Minutes → ms, with the project's override and a floor of one minute. */
function resolveTimeoutMs(qaConfig) {
  const raw = qaConfig && qaConfig.suite_timeout_minutes;
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MINUTES;
  return Math.max(1, minutes) * 60 * 1000;
}

/**
 * The block handed to the QA agent in place of "go run this yourself".
 *
 * Written to be read by an agent whose skill file still tells it to run a test
 * suite: it has to be unambiguous that the run already happened, and it has to
 * carry enough detail that the agent can report counts without opening the log
 * at all in the common case.
 */
function formatSuiteSection(run) {
  const exactUnavailable = run.status === 'unavailable' && run.authority && run.authority.configured;
  const lines = [exactUnavailable
    ? '\n\n## THE SERVER QA SUITE DID NOT COMPLETE — DO NOT SUBSTITUTE AN AGENT RUN'
    : '\n\n## THE TEST SUITE HAS ALREADY BEEN RUN — DO NOT RUN IT AGAIN'];

  if (run.authority && run.authority.configured) {
    const authority = run.authority;
    lines.push(
      '',
      `## SERVER-AUTHORITATIVE QA VERDICT: ${authority.blocked ? 'BLOCKED' : 'PASS'}`,
      '',
      `Authority code: \`${authority.code}\`.`,
      `Reason: ${authority.reason || 'No reason recorded.'}`,
      '',
      '**This verdict is immutable for this run. The QA agent cannot override it, and neither can an operator override.**',
    );
  }

  if (run.status === 'unavailable') {
    lines.push(
      '',
      `The workflow tried to run the suite for you and could not: ${run.error}`,
      '',
      run.authority && run.authority.configured
        ? 'Do not substitute an agent-run suite for this server-authoritative run. Report the blocked authority and stop.'
        : 'Run it yourself using the iOS guidance below, and report the result as usual.',
    );
    return lines.join('\n');
  }

  lines.push(
    '',
    `The workflow ran the suite before starting you. Command:`,
    '',
    '```',
    run.command,
    '```',
    '',
    `Full log: \`${run.logPath}\` (already on disk — grep it, do not re-run).`,
    `Duration: ${Math.round((run.durationMs || 0) / 1000)}s.`,
    '',
  );

  if (run.artifacts && run.artifacts.status === 'complete') {
    const apple = run.artifacts.apple;
    lines.push(
      `Apple result bundle: \`${run.artifacts.resultBundle.path}\`.`,
      `Apple summary: ${apple.passedTests}/${apple.totalTestCount} passed, ${apple.failedTests} failed, ${apple.skippedTests} skipped, ${apple.expectedFailures} expected failures; result ${apple.result}.`,
      `Evidence digests: log \`${run.artifacts.log.sha256}\`; xcresult manifest \`${run.artifacts.resultBundle.manifestDigest}\`.`,
      '',
    );
  } else if (run.artifacts && run.artifacts.status === 'error') {
    lines.push(`Apple artifact collection failed closed: \`${run.artifacts.code}\` — ${run.artifacts.error || 'no detail recorded'}.`, '');
  }

  const c = run.counts || {};
  if (run.status === 'timeout') {
    lines.push(
      `**The run was killed after hitting the ${Math.round(run.timeoutMs / 60000)}-minute limit.** It did not finish, so there is no verdict.`,
      `Progress at the kill: ${c.casesPassed || 0} test cases passed, ${c.casesFailed || 0} failed.`,
      '',
      'Report this on a `**Gate could not run:**` line with the command and the timeout — a suite that could not finish is an environment outcome, not a defect a developer can fix.',
    );
    return lines.join('\n');
  }

  if (c.executed !== null && c.executed !== undefined) {
    lines.push(`**Executed ${c.executed} tests, with ${c.failures} failures.**`);
  }
  lines.push(`Per-case tally: ${c.casesPassed || 0} passed, ${c.casesFailed || 0} failed.`);
  lines.push(
    '',
    run.counts.succeeded === true
      ? 'xcodebuild reported `** TEST SUCCEEDED **`.'
      : run.counts.succeeded === false
        ? 'xcodebuild reported `** TEST FAILED **`.'
        : 'xcodebuild printed no SUCCEEDED/FAILED banner — say so rather than inferring one.',
  );

  if (run.failureExcerpt) {
    lines.push('', '### Failure lines from the log', '', '```', run.failureExcerpt.slice(0, 6000), '```');
  }

  lines.push('', run.authority && run.authority.configured && run.authority.blocked
    ? 'Use these counts in your report as the reason the server-authoritative gate is blocked. Open the log only for failure detail you actually need.'
    : 'Use these counts in your report — they satisfy the approval gate. Open the log only for detail you actually need');
  lines.push('(a specific failure, a stack trace). Re-running the suite duplicates 20-40 minutes of work and is never required.');
  return lines.join('\n');
}

module.exports = {
  DEFAULT_TIMEOUT_MINUTES,
  PROGRESS_INTERVAL_MS,
  parallelArgs,
  discoverProjectAndScheme,
  buildXcodebuildArgs,
  createNativeArtifactPaths,
  collectNativeArtifacts,
  displayCommand,
  parseTestCounts,
  evaluateSuiteAuthority,
  failureExcerpt,
  isPidAlive,
  killGroup,
  killAllActive,
  xcodebuildInFlight,
  startSuiteRun,
  resolveTimeoutMs,
  formatSuiteSection,
};
