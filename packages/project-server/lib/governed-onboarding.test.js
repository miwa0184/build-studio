'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { onboardProject } = require('./onboard');
const {
  loadGovernedAuthorityMap,
  validateGovernedSignoff,
  retireLegacyRuntimeReferences,
} = require('./governed-onboarding');

const FIXTURE = path.resolve(__dirname, '..', 'test', 'fixtures', 'governed-existing-mobile');

async function adoptedFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'governed-signoff-'));
  fs.cpSync(FIXTURE, root, { recursive: true });
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  await onboardProject(root, { name: 'atlas-mobile', port: 3096, mode: 'governed-existing' });
  fs.writeFileSync(path.join(root, 'docs', 'onboarding', 'survey.md'), '# Adoption survey\n\nAuthority map reviewed.\n');
  const inventory = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'onboarding', 'inventory.json'), 'utf8'));
  return { root, inventory, map: loadGovernedAuthorityMap(root, inventory) };
}

test('governed signoff accepts unchanged authority plus only the survey', async () => {
  const { root, map } = await adoptedFixture();
  try {
    assert.deepEqual(validateGovernedSignoff(root, map), { ok: true, errors: [] });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('governed signoff blocks changed founder product law', async () => {
  const { root, map } = await adoptedFixture();
  try {
    fs.appendFileSync(path.join(root, 'PRODUCT_CONTROL.md'), '\nUnauthorized rewrite.\n');
    const verdict = validateGovernedSignoff(root, map);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some(error => /PRODUCT_CONTROL\.md.*changed/.test(error)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('governed signoff preserves retired legacy execution files as byte-identical history', async () => {
  const { root, map } = await adoptedFixture();
  try {
    fs.appendFileSync(path.join(root, 'AGENT_ROUTING_LEGACY.md'), '\nUnauthorized rewrite.\n');
    const verdict = validateGovernedSignoff(root, map);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some(error => /AGENT_ROUTING_LEGACY\.md.*governed source.*changed/.test(error)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('governed signoff blocks a newly synthesized competing document hierarchy', async () => {
  const { root, map } = await adoptedFixture();
  try {
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'vision.md'), '# Synthesized competing vision\n');
    const verdict = validateGovernedSignoff(root, map);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some(error => /docs\/vision\.md.*outside/.test(error)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('governed map digest drift fails before workflow routing', async () => {
  const { root, inventory } = await adoptedFixture();
  try {
    fs.appendFileSync(path.join(root, 'docs', 'onboarding', 'authority-map.json'), ' ');
    assert.throws(
      () => loadGovernedAuthorityMap(root, inventory),
      (error) => error.code === 'GOVERNED_AUTHORITY_MAP_DRIFT',
    );
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('governed agent instruction drift fails before any agent launch', async () => {
  const { root, inventory } = await adoptedFixture();
  try {
    fs.appendFileSync(path.join(root, '.build-studio', 'agent-instructions.md'), '\nDisplace authority.\n');
    assert.throws(
      () => loadGovernedAuthorityMap(root, inventory),
      (error) => error.code === 'GOVERNED_AGENT_INSTRUCTION_DRIFT',
    );
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('governed prompts cannot route agents back into repo-local legacy commands', () => {
  const prompt = retireLegacyRuntimeReferences(
    'You are QA. Read your role definition at .claude/commands/qa.md first. Use the /qa skill. Use the /code-review skill.',
  );
  assert.doesNotMatch(prompt, /\.claude\/commands\/qa\.md|Use the \/qa skill/);
  assert.match(prompt, /Build Studio-owned qa role definition/);
  assert.match(prompt, /Build Studio-owned qa definition/);
  assert.match(prompt, /Use the \/code-review skill/);
});
