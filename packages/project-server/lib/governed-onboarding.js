'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { walkMarkdownPaths, sha256File } = require('./detect/existing-docs');

const GOVERNED_MODE = 'governed-existing';
const AUTHORITY_MAP_PATH = 'docs/onboarding/authority-map.json';
const AGENT_INSTRUCTION_PATH = '.build-studio/agent-instructions.md';

function onboardingPlanForInventory(inventory = {}) {
  if (inventory.adoptionMode === GOVERNED_MODE || inventory.shape === GOVERNED_MODE) {
    return {
      mode: GOVERNED_MODE,
      steps: {
        discovery: { status: 'pending', agents: [] },
        owner_signoff: { status: 'pending', agents: [] },
      },
      currentStep: 'discovery',
    };
  }
  return {
    mode: 'single-prd-mvp',
    steps: {
      discovery:          { status: 'pending', agents: [] },
      ceo_synthesis:      { status: 'pending', agents: [] },
      architect_backfill: { status: 'pending', agents: [] },
      pm_synthesis:       { status: 'pending', agents: [] },
      devops_detect:      { status: 'pending', agents: [] },
      team_review:        { status: 'pending', agents: [] },
      pm_revision:        { status: 'pending', agents: [] },
      owner_signoff:      { status: 'pending', agents: [] },
    },
    currentStep: 'discovery',
  };
}

function buildGovernedDiscoveryInstruction({ ownerNotes = '' } = {}) {
  return `You are the Surveyor for a governed-existing Build Studio adoption.

Read \`${AUTHORITY_MAP_PATH}\`, \`docs/onboarding/inventory.json\`, and every source listed in the authority map. Audit the map rather than inventing a new product hierarchy:

1. Confirm each \`product_authority\` source is founder/product law or an approved product specification and quote only short identifying headings.
2. Treat \`product_context\` as background that cannot override product authority.
3. Confirm every \`legacy_execution_governance\` source is retired from Build Studio runtime authority. Build Studio owns the pipeline, roles, run-state, QA, acceptance, and egress.
4. Confirm \`ignored/generated/runtime\` entries supply no adoption authority.
5. If any classification is wrong or ambiguous, report BLOCKED in the survey. Do not silently choose a different source or priority.

Produce only \`docs/onboarding/survey.md\` with: map review, product-authority allowlist, context summary, retired legacy execution files, ignored/generated/runtime files, and any owner decision required before adoption. Do not create or rewrite any product-authority source or any competing product/execution hierarchy.

STAGE the survey but DO NOT COMMIT. Owner signoff is the first and only adoption commit.${ownerNotes ? `\n\n## Owner notes from the previous signoff\n\n${ownerNotes}` : ''}`;
}

function governedSignoffPathspecs() {
  return [
    '.build-studio/config.yaml',
    AGENT_INSTRUCTION_PATH,
    '.gitignore',
    'docs/onboarding/inventory.json',
    AUTHORITY_MAP_PATH,
    'docs/onboarding/survey.md',
  ];
}

function loadGovernedAuthorityMap(projectRoot, inventory) {
  if (!inventory || inventory.adoptionMode !== GOVERNED_MODE) {
    throw governedError('inventory does not declare governed-existing adoption', 'GOVERNED_INVENTORY_INVALID');
  }
  const rel = safeRelative(inventory.authorityMapPath || AUTHORITY_MAP_PATH);
  const abs = path.join(projectRoot, rel);
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); }
  catch (error) {
    throw governedError(`cannot read governed authority map ${rel}: ${error.message}`, 'GOVERNED_AUTHORITY_MAP_MISSING');
  }
  const digest = crypto.createHash('sha256').update(text).digest('hex');
  if (!/^[a-f0-9]{64}$/.test(String(inventory.authorityMapSha256 || ''))
      || digest !== inventory.authorityMapSha256) {
    throw governedError('authority map digest does not match the bootstrap inventory', 'GOVERNED_AUTHORITY_MAP_DRIFT');
  }
  let map;
  try { map = JSON.parse(text); }
  catch (error) { throw governedError(`authority map is not valid JSON: ${error.message}`, 'GOVERNED_AUTHORITY_MAP_INVALID'); }
  validateMapShape(map);
  loadGovernedAgentInstruction(projectRoot, inventory);
  return map;
}

function loadGovernedAgentInstruction(projectRoot, inventory) {
  if (!inventory || inventory.adoptionMode !== GOVERNED_MODE) {
    throw governedError('inventory does not declare governed-existing adoption', 'GOVERNED_INVENTORY_INVALID');
  }
  const rel = safeRelative(inventory.agentInstructionPath || AGENT_INSTRUCTION_PATH);
  let content;
  try { content = fs.readFileSync(path.join(projectRoot, rel), 'utf8'); }
  catch (error) {
    throw governedError(`cannot read governed agent instruction ${rel}: ${error.message}`, 'GOVERNED_AGENT_INSTRUCTION_MISSING');
  }
  const digest = crypto.createHash('sha256').update(content).digest('hex');
  if (!/^[a-f0-9]{64}$/.test(String(inventory.agentInstructionSha256 || ''))
      || digest !== inventory.agentInstructionSha256) {
    throw governedError('agent instruction digest does not match the bootstrap inventory', 'GOVERNED_AGENT_INSTRUCTION_DRIFT');
  }
  return { rel, content };
}

function validateGovernedSignoff(projectRoot, map) {
  validateMapShape(map);
  const errors = [];
  for (const entry of map.entries) {
    if (entry.class === 'ignored/generated/runtime') continue;
    const rel = safeRelative(entry.source);
    const abs = path.join(projectRoot, rel);
    if (!fs.existsSync(abs)) {
      errors.push(`${rel}: governed source is missing`);
      continue;
    }
    const digest = sha256File(abs);
    if (digest !== entry.sha256) {
      errors.push(`${rel}: ${entry.class === 'product_authority' ? 'product authority' : 'governed source'} changed after inventory`);
    }
  }

  const initialDocs = new Set(map.entries.map(entry => safeRelative(entry.source)));
  const allowedNewDocs = new Set(['docs/onboarding/survey.md', AGENT_INSTRUCTION_PATH]);
  for (const rel of walkMarkdownPaths(projectRoot)) {
    if (!initialDocs.has(rel) && !allowedNewDocs.has(rel)) {
      errors.push(`${rel}: new document is outside the governed adoption artifact allowlist`);
    }
  }
  if (!fs.existsSync(path.join(projectRoot, 'docs', 'onboarding', 'survey.md'))) {
    errors.push('docs/onboarding/survey.md: required owner-review survey is missing');
  }
  return { ok: errors.length === 0, errors };
}

function governedAgentContext(config, projectRoot) {
  if (!config.onboarding || config.onboarding.mode !== GOVERNED_MODE) return '';
  let inventory;
  try {
    inventory = JSON.parse(fs.readFileSync(path.join(projectRoot, 'docs', 'onboarding', 'inventory.json'), 'utf8'));
  } catch (error) {
    throw governedError(`cannot load governed bootstrap inventory: ${error.message}`, 'GOVERNED_INVENTORY_INVALID');
  }
  const loaded = loadGovernedAgentInstruction(projectRoot, inventory);
  const configuredRel = safeRelative(config.onboarding.agent_instruction || AGENT_INSTRUCTION_PATH);
  if (loaded.rel !== configuredRel) {
    throw governedError('configured agent instruction does not match the bootstrap inventory', 'GOVERNED_AGENT_INSTRUCTION_DRIFT');
  }
  const content = loaded.content;
  return `\n\n## GOVERNED-EXISTING AUTHORITY — SERVER-INJECTED\n\n${content.trim()}\n`;
}

function retireLegacyRuntimeReferences(instruction) {
  return String(instruction || '')
    .replace(
      /Read (?:your|the) role definition at\s+`?\.claude\/commands\/([a-z][a-z0-9_-]*)\.md`?\s+first\.?/gi,
      'Use the Build Studio-owned $1 role definition inlined into this server prompt.',
    )
    .replace(/Use the \/([a-z][a-z0-9_-]*) skill\./gi, (match, name) => (
      name === 'code-review'
        ? match
        : `Apply the Build Studio-owned ${name} definition inlined into this server prompt.`
    ));
}

function validateMapShape(map) {
  if (!map || map.schemaVersion !== 1 || map.mode !== GOVERNED_MODE || !Array.isArray(map.entries)
      || !Array.isArray(map.productAuthorityAllowlist) || !Array.isArray(map.rules)) {
    throw governedError('authority map has an invalid governed-existing schema', 'GOVERNED_AUTHORITY_MAP_INVALID');
  }
  const seen = new Set();
  for (const entry of map.entries) {
    const rel = safeRelative(entry && entry.source);
    if (seen.has(rel)) throw governedError(`duplicate authority-map source: ${rel}`, 'GOVERNED_AUTHORITY_MAP_INVALID');
    seen.add(rel);
    if (!['product_authority', 'product_context', 'legacy_execution_governance', 'ignored/generated/runtime'].includes(entry.class)
        || typeof entry.disposition !== 'string' || !entry.disposition
        || typeof entry.reason !== 'string' || !entry.reason
        || typeof entry.matchedRule !== 'string' || !entry.matchedRule
        || !/^[a-f0-9]{64}$/.test(String(entry.sha256 || ''))) {
      throw governedError(`invalid authority-map entry: ${rel}`, 'GOVERNED_AUTHORITY_MAP_INVALID');
    }
    if (entry.class === 'legacy_execution_governance'
        && entry.disposition !== 'retired-from-build-studio-runtime-authority') {
      throw governedError(`${rel}: legacy execution governance is not retired`, 'GOVERNED_AUTHORITY_MAP_INVALID');
    }
  }
  const expected = map.entries.filter(entry => entry.class === 'product_authority').map(entry => entry.source).sort();
  const declared = map.productAuthorityAllowlist.slice().sort();
  if (JSON.stringify(expected) !== JSON.stringify(declared)) {
    throw governedError('productAuthorityAllowlist does not match product_authority entries', 'GOVERNED_AUTHORITY_MAP_INVALID');
  }
}

function safeRelative(value) {
  const rel = String(value || '').split(path.sep).join('/');
  if (!rel || path.isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.includes('/../')) {
    throw governedError(`unsafe governed-adoption path: ${value}`, 'GOVERNED_AUTHORITY_MAP_INVALID');
  }
  return rel;
}

function governedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  GOVERNED_MODE,
  AUTHORITY_MAP_PATH,
  AGENT_INSTRUCTION_PATH,
  onboardingPlanForInventory,
  buildGovernedDiscoveryInstruction,
  governedSignoffPathspecs,
  loadGovernedAuthorityMap,
  loadGovernedAgentInstruction,
  validateGovernedSignoff,
  governedAgentContext,
  retireLegacyRuntimeReferences,
};
