'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  onboardingPlanForInventory,
  buildGovernedDiscoveryInstruction,
  governedSignoffPathspecs,
} = require('./workflow');

test('governed-existing routes discovery directly to owner signoff, never greenfield synthesis', () => {
  const plan = onboardingPlanForInventory({ adoptionMode: 'governed-existing' });
  assert.deepEqual(Object.keys(plan.steps), ['discovery', 'owner_signoff']);
  assert.equal(plan.currentStep, 'discovery');
});

test('governed discovery audits the authority map without creating or committing a competing product hierarchy', () => {
  const instruction = buildGovernedDiscoveryInstruction({ ownerNotes: 'Recheck the baseline classification.' });
  assert.match(instruction, /authority-map\.json/);
  assert.match(instruction, /product_authority/);
  assert.match(instruction, /legacy_execution_governance/);
  assert.match(instruction, /docs\/onboarding\/survey\.md/);
  assert.match(instruction, /DO NOT COMMIT/i);
  assert.match(instruction, /Recheck the baseline classification/);
  assert.doesNotMatch(instruction, /produce docs\/vision\.md/i);
  assert.doesNotMatch(instruction, /ADR-001|PRD-001-onboarding-baseline|docs\/project-state\.md/i);
});

test('governed owner signoff commits only adoption artifacts, never a repository-wide git add', () => {
  assert.deepEqual(governedSignoffPathspecs(), [
    '.build-studio/config.yaml',
    '.build-studio/agent-instructions.md',
    '.gitignore',
    'docs/onboarding/inventory.json',
    'docs/onboarding/authority-map.json',
    'docs/onboarding/survey.md',
  ]);
});
