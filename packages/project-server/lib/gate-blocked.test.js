'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseGateBlocked } = require('./gate-blocked');

// The two real incidents this exists for. In both the code was fine, the check
// never executed, and the fix loop was handed work nobody could complete.
const NO_BROWSER = `**Approved:** no
**Tests passed:** 7/7
**Gate could not run:** agent.browsers.getForUrl("http://localhost:5173/") → No browser is available`;

const NO_SERVER = `**Tests passed:** 7/7
**Gate could not run:** playwright-cli open http://localhost:5173 → net::ERR_CONNECTION_REFUSED`;

test('an unrunnable check is recognised and its reason captured', () => {
  for (const fb of [NO_BROWSER, NO_SERVER]) {
    const r = parseGateBlocked(fb);
    assert.ok(r && r.blocked, 'should detect');
    assert.match(r.reason, /No browser is available|ERR_CONNECTION_REFUSED/);
  }
});

test('a gate that RAN and failed is NOT diverted — that is the fix loop', () => {
  // The whole risk of this feature: becoming an escape hatch from real failures.
  const real = `**Approved:** no
**Blocking:** 2

### Failures
- testExportPrecision failed: expected 112.1, got 112.09999999999999`;
  assert.equal(parseGateBlocked(real), null);
});

test('prose about being blocked does not trip it', () => {
  const prose = `The build was blocked earlier. A gate could not run in round 2,
but it runs now. Gate could not run: is discussed in the notes.`;
  assert.equal(parseGateBlocked(prose), null);
});

test('the marker is recognised anywhere in the report, not only at the top', () => {
  const late = `## QA\n\nRan the suite.\n\n**Gate could not run:** xcodebuild → simulator unreachable\n\nDone.`;
  assert.match(parseGateBlocked(late).reason, /simulator unreachable/);
});

test('a marker with no reason is not actionable and is ignored', () => {
  assert.equal(parseGateBlocked('**Gate could not run:**   '), null);
});

test('empty and missing feedback are safe', () => {
  for (const v of ['', null, undefined]) assert.equal(parseGateBlocked(v), null);
});
