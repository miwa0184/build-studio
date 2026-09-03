'use strict';

// Realistic serial `xcodebuild test` output for authority tests.
//
// Xcode prints one SESSION per test bundle. Inside a session the hierarchy is
// `Test Suite 'All tests'` (or `'Selected tests'` under -only-testing) →
// `Test Suite '<Bundle>.xctest'` → `Test Suite '<Class>'` → `Test Case` lines,
// and every suite is closed by a `Test Suite '<name>' passed/failed at` line
// followed by its own native `Executed N tests, with M failures` summary. The
// bundle boundary is the only stable identity in the stream: Swift cases print
// as `-[Module.Class method]`, Objective-C cases as `-[Class method]`, and
// neither says which bundle it belongs to. Tests build logs here so every
// fixture carries the same hierarchy a real run does, and so a fixture that
// deliberately omits or forges a line says so in its own words.

const T = '2026-09-02 10:00:00.000';

function suiteStart(name, at = T) {
  return `Test Suite '${name}' started at ${at}.`;
}

function suiteEnd(name, executed, failures = 0, at = T) {
  return [
    `Test Suite '${name}' ${failures ? 'failed' : 'passed'} at ${at}.`,
    `\t Executed ${executed} test${executed === 1 ? '' : 's'}, with ${failures} failure${failures === 1 ? '' : 's'} (0 unexpected) in 1.0 (1.1) seconds`,
  ];
}

/** Swift-style case identity, as xcodebuild prints it: `-[Module.Class method]`. */
const swiftCase = (module, cls) => (i) => `-[${module}.${cls} test${i}]`;
/** Objective-C-style case identity: `-[Class method]` — no module, no bundle. */
const objcCase = (cls) => (i) => `-[${cls} test${i}]`;

function caseLines(idOf, count, { failed = 0 } = {}) {
  const lines = [];
  for (let i = 1; i <= count; i++) {
    const id = idOf(i);
    lines.push(`Test Case '${id}' started.`);
    lines.push(`Test Case '${id}' ${i <= failed ? 'failed' : 'passed'} (0.1 seconds).`);
  }
  return lines;
}

/**
 * One bundle session.
 *
 * `classes`: `[{ name, count, failed?, summary? }]` — `summary: false` omits the
 * class-level summary, a number forges it.
 * `style`: `'swift'` (default) or `'objc'` case identities.
 * `bundleSummary` / `sessionSummary`: `false` omits that summary line pair,
 * a number forges its executed count; default is the honest tally.
 * `bundleStart`: `false` omits the bundle's `started` line.
 * `session`: the session suite name, `'All tests'` by default.
 */
function bundleSession({
  bundle, classes, style = 'swift', at = T,
  bundleSummary, sessionSummary, bundleStart = true, session = 'All tests',
}) {
  const lines = [suiteStart(session, at)];
  if (bundleStart) lines.push(suiteStart(`${bundle}.xctest`, at));
  let executed = 0;
  let failures = 0;
  for (const cls of classes) {
    const failed = cls.failed || 0;
    const idOf = style === 'objc' ? objcCase(cls.name) : swiftCase(bundle, cls.name);
    lines.push(suiteStart(cls.name, at), ...caseLines(idOf, cls.count, { failed }));
    if (cls.summary !== false) lines.push(...suiteEnd(cls.name, cls.summary ?? cls.count, failed, at));
    executed += cls.count;
    failures += failed;
  }
  if (bundleSummary !== false) lines.push(...suiteEnd(`${bundle}.xctest`, bundleSummary ?? executed, failures, at));
  if (sessionSummary !== false) lines.push(...suiteEnd(session, sessionSummary ?? executed, failures, at));
  return lines;
}

/** Whole-run output: the sessions in order, then the verdict banner. */
function xcodebuildLog(sessions, { banner = 'SUCCEEDED' } = {}) {
  const lines = sessions.flat();
  if (banner) lines.push(`** TEST ${banner} **`);
  return lines.join('\n');
}

/** A plain single-bundle, single-class run of `count` tests. */
function singleBundleLog(bundle, count, { failed = 0, banner = failed ? 'FAILED' : 'SUCCEEDED', style = 'swift', cls = 'Cases' } = {}) {
  return xcodebuildLog([bundleSession({ bundle, style, classes: [{ name: cls, count, failed }] })], { banner });
}

module.exports = { T, suiteStart, suiteEnd, swiftCase, objcCase, caseLines, bundleSession, xcodebuildLog, singleBundleLog };
