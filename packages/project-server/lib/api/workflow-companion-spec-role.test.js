'use strict';

// Which ROLE VARIANT a companion-spec author gets.
//
// Regression (2026-08-23): the review flow's companion_specs step resolved each
// §10 owner with a bare findRole(config, name). findRole searches
// review → execution → standalone, and every preset ships TWO roles named QA:
// review:QA (skill qa_review — the PRD-review skill, whose mandated output is
// `**Approved:** yes | no`) and standalone:QA (skill qa — the test-authoring
// role). So the spec AUTHOR was handed the REVIEWER skill, dutifully emitted a
// review verdict, and a fully delivered spec (file written, committed, §10 row
// flipped to Done) rendered in the dashboard as "Changes requested".
//
// The fix is a preference, not a filter: companion_specs asks for 'standalone'.
// findRole falls back to the full search when the category has no match, so
// roles that exist only under review are unaffected.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { findRole } = require('../config');
const { PRESETS } = require('../presets');

const PRESET_NAMES = Object.keys(PRESETS);

/** A config shaped the way findRole reads it, for one preset. */
function configFor(name) {
  return { roles: PRESETS[name].roles };
}

test('every preset ships two QA variants — the ambiguity this guards is real', () => {
  for (const name of PRESET_NAMES) {
    const { roles } = configFor(name);
    const review = (roles.review || []).find(r => r.role === 'QA');
    const standalone = (roles.standalone || []).find(r => r.role === 'QA');
    if (!review || !standalone) continue; // preset without the duplicate: nothing to disambiguate
    assert.notEqual(review.skill, standalone.skill,
      `${name}: the two QA roles must differ, else this test proves nothing`);
  }
});

test('a spec author asking for standalone gets the authoring QA, not the reviewer', () => {
  for (const name of PRESET_NAMES) {
    const config = configFor(name);
    const standalone = (config.roles.standalone || []).find(r => r.role === 'QA');
    if (!standalone) continue;
    const resolved = findRole(config, 'QA', 'standalone');
    assert.equal(resolved.skill, standalone.skill, `${name}: wrong QA variant`);
    assert.doesNotMatch(resolved.skill, /review/,
      `${name}: companion_specs must not load a review skill — that is what produced the bogus verdict`);
  }
});

test('the review flow still gets the reviewer QA', () => {
  // The fix must not swap the variants globally: `reviewing` wants qa_review.
  for (const name of PRESET_NAMES) {
    const config = configFor(name);
    const review = (config.roles.review || []).find(r => r.role === 'QA');
    if (!review) continue;
    assert.equal(findRole(config, 'QA', 'review').skill, review.skill, `${name}: wrong QA variant for review`);
  }
});

test('roles with no standalone entry resolve exactly as before', () => {
  // UX / Brand / Architect / Marketing / Security live only under review. The
  // preference must be a no-op for them, or this fix would have quietly
  // rerouted every other spec author too.
  for (const name of PRESET_NAMES) {
    const config = configFor(name);
    for (const role of (config.roles.review || [])) {
      const alsoStandalone = (config.roles.standalone || []).some(r => r.role === role.role);
      if (alsoStandalone) continue;
      assert.equal(
        findRole(config, role.role, 'standalone').skill,
        findRole(config, role.role).skill,
        `${name}/${role.role}: preference changed resolution for a role with no standalone variant`,
      );
    }
  }
});

test('an unknown preferred category is ignored, not fatal', () => {
  // config.roles.standalone is absent in a hand-rolled config that overrides
  // only roles.execution — the launcher must still resolve the owner.
  const config = { roles: { review: [{ role: 'UX', skill: 'ux', command: 'ux.md' }] } };
  assert.equal(findRole(config, 'UX', 'standalone').skill, 'ux');
});
