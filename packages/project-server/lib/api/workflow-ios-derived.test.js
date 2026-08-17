'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { iosDerivedDataGuidance } = require('./workflow');

const IOS = { simulator: { destination: 'platform=iOS Simulator,name=iPhone 16 Pro' } };

test('non-simulator projects get nothing', () => {
  assert.equal(iosDerivedDataGuidance({}, { itemId: 'FAZ-268' }), '');
  assert.equal(iosDerivedDataGuidance({ simulator: {} }, { itemId: 'FAZ-268' }), '');
});

test('a simulator project gets one shared path keyed to the run', () => {
  const g = iosDerivedDataGuidance(IOS, { itemId: 'FAZ-268' });
  assert.match(g, /-derivedDataPath ios\/build\/dd-FAZ-268/);
  assert.doesNotMatch(g, /\{\{RUN_ID\}\}/, 'placeholder must be substituted');
});

test('the same run yields the same path across steps and rounds', () => {
  // The whole point: round 2's fix agent and round 3's reviewer must land on
  // one directory, so the second build is incremental and only one is left behind.
  const wf = { itemId: 'FAZ-268' };
  assert.equal(iosDerivedDataGuidance(IOS, wf), iosDerivedDataGuidance(IOS, { ...wf }));
});

/** The path the agent is told to pass — the only part built from run data. */
function derivedPath(guidance) {
  // The path is rendered inside a markdown code span, so stop at the backtick.
  const m = guidance.match(/-derivedDataPath ([^`\s]+)/);
  assert.ok(m, 'guidance must name a path');
  return m[1];
}

// The id is interpolated into a path on an xcodebuild command line. Assertions
// target the PATH, not the prose — the surrounding text legitimately contains
// punctuation the path must not.
test('the run id is sanitised for the shell and the filesystem', () => {
  const p = derivedPath(iosDerivedDataGuidance(IOS, { itemId: 'FAZ-1; rm -rf ~/' }));
  assert.match(p, /^ios\/build\/dd-[A-Za-z0-9._-]+$/, `unsafe path: ${p}`);
  assert.doesNotMatch(p, /rm -rf/);
});

test('path traversal in the id cannot escape the build dir', () => {
  const p = derivedPath(iosDerivedDataGuidance(IOS, { itemId: '../../etc/evil' }));
  assert.doesNotMatch(p, /\.\.\//);
  assert.match(p, /^ios\/build\/dd-/);
});

test('an id of only unusable characters still yields a valid path', () => {
  const p = derivedPath(iosDerivedDataGuidance(IOS, { itemId: '///' }));
  assert.match(p, /^ios\/build\/dd-[A-Za-z0-9._-]+$/);
});

test('falls back through itemId → input → id', () => {
  assert.match(iosDerivedDataGuidance(IOS, { input: 'PRD-116' }), /dd-PRD-116/);
  assert.match(iosDerivedDataGuidance(IOS, { id: 'execution-2026' }), /dd-execution-2026/);
  assert.match(iosDerivedDataGuidance(IOS, {}), /dd-run/);
});

test('a long id is bounded', () => {
  const g = iosDerivedDataGuidance(IOS, { itemId: 'X'.repeat(200) });
  const m = g.match(/dd-(X+)/);
  assert.ok(m[1].length <= 40, `run id should be capped, got ${m[1].length}`);
});

test('it tells the agent to reuse rather than invent a new dir', () => {
  const g = iosDerivedDataGuidance(IOS, { itemId: 'A' });
  assert.match(g, /Do NOT invent a fresh directory name/);
  assert.match(g, /REUSE THIS RUN/, 'marker the launcher uses to avoid double-injection');
});
