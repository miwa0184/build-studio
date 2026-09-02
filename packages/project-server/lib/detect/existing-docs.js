'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AUTHORITY_CLASSES = new Set([
  'product_authority',
  'product_context',
  'legacy_execution_governance',
  'ignored/generated/runtime',
]);

// Lower number = earlier, explicit authority classification. These are glob
// families, not an exact filename allowlist: established projects use wildly
// different separators and prefixes. Callers may prepend project-specific
// rules; every selected rule and priority is copied into authority-map.json.
const DEFAULT_AUTHORITY_RULES = Object.freeze([
  Object.freeze({
    id: 'generated-runtime', priority: 10, class: 'ignored/generated/runtime',
    patterns: ['**/.build-studio/**', '**/tmp/**', '**/generated/**', '**/DerivedData/**', '**/*.xcresult/**'],
    disposition: 'ignored-generated-or-runtime-input',
    reason: 'Generated output and machine-local runtime state cannot supply adoption authority.',
  }),
  Object.freeze({
    id: 'legacy-execution-governance', priority: 20, class: 'legacy_execution_governance',
    patterns: [
      '**/*TASK*PACKET*.md', '**/*AGENT*ROUT*.md', '**/*WORKFLOW*STATE*.md',
      '**/*FACTORY*ROUTINE*.md', '**/*EXECUTION*GOVERNANCE*.md', '**/CLAUDE.md', '**/AGENTS.md',
      '**/.claude/**', '**/.codex/**', '**/.github/copilot-instructions.md',
    ],
    disposition: 'retired-from-build-studio-runtime-authority',
    reason: 'Pre-adoption task routing, agent policy, workflow state, and factory routines are historical; Build Studio owns execution.',
  }),
  Object.freeze({
    id: 'founder-product-law', priority: 30, class: 'product_authority',
    patterns: [
      '**/*PRODUCT*CONTROL*.md', '**/*CURRENT*STATE*.md', '**/*BASELINE*LOCK*.md',
      '**/*NORTH*STAR*.md', '**/*FOUNDER*DECISION*.md', '**/*PRODUCT*LAW*.md',
    ],
    disposition: 'preserve-byte-identical-product-authority',
    reason: 'Founder decisions, current-state locks, baselines, and product direction remain product authority.',
  }),
  Object.freeze({
    id: 'approved-product-specification', priority: 31, class: 'product_authority',
    patterns: ['**/SPEC*.md', '**/*SPECIFICATION*.md', '**/docs/prds/*.md'],
    disposition: 'preserve-byte-identical-product-authority',
    reason: 'Existing approved product specifications remain decision inputs and are not synthesized or rewritten.',
  }),
  Object.freeze({
    id: 'product-context', priority: 100, class: 'product_context',
    patterns: ['**/README.md', '**/*BACKLOG*.md', '**/*ROADMAP*.md', '**/*HISTORY*.md', '**/*CONTEXT*.md', '**/CHANGELOG.md'],
    disposition: 'preserve-as-product-context',
    reason: 'Background, history, backlog, and roadmap material informs adoption but does not outrank product authority.',
  }),
  Object.freeze({
    id: 'unclassified-document-context', priority: 1000, class: 'product_context',
    patterns: ['**/*.md'],
    disposition: 'preserve-as-product-context',
    reason: 'Unclassified source documents are retained as context and never gain implicit product or execution authority.',
  }),
]);

/**
 * Inventory the project's existing onboarding-relevant docs so the discovery
 * agent (PRD-001 onboarding workflow) can summarize them. The button writes
 * this list into `docs/onboarding/inventory.json`; the agent reads it.
 *
 * Each entry: { path, kind, bytes }. `kind` is the role the file likely plays:
 *   readme, claude-md, agents-md, prd-monolith, design-doc, action-plan,
 *   spec, strategy, architecture, branding, marketing, contracts, adrs, other.
 *
 * Only inventories shallow paths — README at root, single-PRD-MVP files, the
 * /specs/ and /docs/strategy/ folders. Doesn't walk arbitrary subtrees.
 */
function detectExistingDocs(projectRoot, options = {}) {
  if (options.mode === 'governed-existing') {
    return detectGovernedExistingDocs(projectRoot, options.authorityRules || []);
  }
  const out = [];
  const claudeMdPresent = exists(projectRoot, 'CLAUDE.md');
  const agentsMdPresent = exists(projectRoot, 'AGENTS.md');
  const specsDirPresent = isDir(projectRoot, 'specs');

  // Root-level docs.
  for (const candidate of [
    { rel: 'README.md',           kind: 'readme' },
    { rel: 'CLAUDE.md',           kind: 'claude-md' },
    { rel: 'AGENTS.md',           kind: 'agents-md' },
    { rel: 'PRD.md',              kind: 'prd-monolith' },
    { rel: 'DESIGN.md',           kind: 'design-doc' },
    { rel: 'ARCHITECTURE.md',     kind: 'architecture' },
    { rel: 'ROADMAP.md',          kind: 'roadmap' },
    { rel: 'ACTION-PLAN.md',      kind: 'action-plan' },
    { rel: 'IMPLEMENTATION_PLAN.md', kind: 'action-plan' },
    { rel: 'CHANGELOG.md',        kind: 'changelog' },
  ]) {
    pushIfFile(out, projectRoot, candidate.rel, candidate.kind);
  }

  // /specs/ directory — common in skrivhjälp shape.
  if (specsDirPresent) {
    for (const f of safeReaddir(path.join(projectRoot, 'specs'))) {
      if (f.endsWith('.md')) pushIfFile(out, projectRoot, path.join('specs', f), 'spec');
    }
  }

  // /docs/strategy + /docs/branding + /docs/architecture + /docs/marketing + /docs/operations
  // Common in example-studio shape; harmless when absent.
  for (const sub of ['strategy', 'branding', 'architecture', 'marketing', 'operations', 'localization']) {
    const dir = path.join(projectRoot, 'docs', sub);
    if (!isDirAbs(dir)) continue;
    for (const f of safeReaddir(dir)) {
      if (f.endsWith('.md')) pushIfFile(out, projectRoot, path.join('docs', sub, f), sub);
    }
  }

  // Existing PRDs/ADRs/contracts — useful to count but don't expand each one
  // (could be hundreds in a mature project).
  const prdsDir = path.join(projectRoot, 'docs', 'prds');
  const adrsDir = path.join(projectRoot, 'docs', 'adrs');
  const contractsDir = path.join(projectRoot, 'docs', 'contracts');
  const counts = {
    existingPrds: countMdFiles(prdsDir),
    existingAdrs: countMdFiles(adrsDir),
    existingContracts: countMdFiles(contractsDir),
  };

  return {
    docs: out,
    claudeMdPresent,
    agentsMdPresent,
    specsDirPresent,
    counts,
  };
}

function detectGovernedExistingDocs(projectRoot, customRules) {
  const rules = normalizeAuthorityRules(customRules);
  const markdownPaths = walkMarkdownPaths(projectRoot);
  const docs = markdownPaths.map((rel) => {
    const abs = path.join(projectRoot, rel);
    const stat = fs.statSync(abs);
    const classification = classifyAuthoritySource(rel, rules);
    return {
      path: rel,
      kind: kindForPath(rel),
      bytes: stat.size,
      authorityClass: classification.class,
      disposition: classification.disposition,
      reason: classification.reason,
      matchedRule: classification.id,
      sha256: sha256File(abs),
    };
  });
  const authorityMap = {
    schemaVersion: 1,
    mode: 'governed-existing',
    generatedAt: new Date().toISOString(),
    precedence: 'lowest-explicit-rule-priority; equal-priority multi-class matches fail closed',
    rules,
    entries: docs.map(doc => ({
      source: doc.path,
      class: doc.authorityClass,
      disposition: doc.disposition,
      reason: doc.reason,
      matchedRule: doc.matchedRule,
      bytes: doc.bytes,
      sha256: doc.sha256,
    })),
    productAuthorityAllowlist: docs
      .filter(doc => doc.authorityClass === 'product_authority')
      .map(doc => doc.path)
      .sort(),
  };

  return {
    docs,
    authorityMap,
    claudeMdPresent: exists(projectRoot, 'CLAUDE.md'),
    agentsMdPresent: exists(projectRoot, 'AGENTS.md'),
    specsDirPresent: isDir(projectRoot, 'specs'),
    counts: {
      existingPrds: countMdFiles(path.join(projectRoot, 'docs', 'prds')),
      existingAdrs: countMdFiles(path.join(projectRoot, 'docs', 'adrs')),
      existingContracts: countMdFiles(path.join(projectRoot, 'docs', 'contracts')),
    },
  };
}

function normalizeAuthorityRules(customRules) {
  if (!Array.isArray(customRules)) {
    throw authorityError('authorityRules must be an array', 'AUTHORITY_RULES_INVALID');
  }
  const rules = [...customRules, ...DEFAULT_AUTHORITY_RULES].map((rule) => ({
    id: rule && rule.id,
    priority: rule && rule.priority,
    class: rule && rule.class,
    patterns: rule && Array.isArray(rule.patterns) ? [...rule.patterns] : rule && rule.patterns,
    disposition: rule && rule.disposition,
    reason: rule && rule.reason,
  }));
  const ids = new Set();
  for (const rule of rules) {
    if (!rule || !/^[a-z0-9][a-z0-9-]*$/.test(String(rule.id || ''))) {
      throw authorityError('every authority rule needs a stable lowercase id', 'AUTHORITY_RULES_INVALID');
    }
    if (ids.has(rule.id)) throw authorityError(`duplicate authority rule id: ${rule.id}`, 'AUTHORITY_RULES_INVALID');
    ids.add(rule.id);
    if (!Number.isInteger(rule.priority) || rule.priority < 0) {
      throw authorityError(`authority rule ${rule.id} needs a non-negative integer priority`, 'AUTHORITY_RULES_INVALID');
    }
    if (!AUTHORITY_CLASSES.has(rule.class)) {
      throw authorityError(`authority rule ${rule.id} has invalid class: ${rule.class}`, 'AUTHORITY_RULES_INVALID');
    }
    if (!Array.isArray(rule.patterns) || rule.patterns.length === 0
        || rule.patterns.some(pattern => typeof pattern !== 'string' || !pattern.trim())) {
      throw authorityError(`authority rule ${rule.id} needs non-empty glob patterns`, 'AUTHORITY_RULES_INVALID');
    }
    if (typeof rule.disposition !== 'string' || !rule.disposition.trim()
        || typeof rule.reason !== 'string' || !rule.reason.trim()) {
      throw authorityError(`authority rule ${rule.id} needs disposition and reason`, 'AUTHORITY_RULES_INVALID');
    }
  }
  return rules;
}

function classifyAuthoritySource(relPath, rules) {
  const normalized = relPath.split(path.sep).join('/');
  const matches = rules.filter(rule => rule.patterns.some(pattern => globMatches(normalized, pattern)));
  if (matches.length === 0) {
    throw authorityError(`no authority rule classified ${normalized}`, 'AUTHORITY_CLASSIFICATION_MISSING');
  }
  const priority = Math.min(...matches.map(rule => rule.priority));
  const winners = matches.filter(rule => rule.priority === priority);
  const classes = new Set(winners.map(rule => rule.class));
  if (classes.size > 1) {
    throw authorityError(
      `ambiguous authority classification for ${normalized}: ${winners.map(rule => `${rule.id}=${rule.class}`).join(', ')}`,
      'AUTHORITY_CLASSIFICATION_AMBIGUOUS',
    );
  }
  // Same-class, same-priority matches do not change authority. Choose the
  // stable lexical id so the map remains reproducible and explicit.
  return winners.slice().sort((a, b) => a.id.localeCompare(b.id))[0];
}

function walkMarkdownPaths(projectRoot) {
  const out = [];
  const skipDirs = new Set(['.git', 'node_modules', '.swiftpm', '.build']);
  const walk = (abs, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch (error) {
      throw authorityError(
        `could not inventory governed source directory ${rel || '.'}: ${error.message}`,
        'AUTHORITY_INVENTORY_UNREADABLE',
      );
    }
    for (const entry of entries) {
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      const childAbs = path.join(abs, entry.name);
      if (entry.isSymbolicLink()) {
        refuseMarkdownRelevantSymlink(entry, childAbs, childRel.split(path.sep).join('/'), skipDirs);
        continue;
      }
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        walk(childAbs, childRel);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        out.push(childRel.split(path.sep).join('/'));
      }
    }
  };
  walk(projectRoot, '');
  return out.sort();
}

/**
 * A symlink can hide Markdown from the governed inventory, and the inventory
 * is the authority map's complete evidence base. So a symlink that could
 * carry Markdown — one named *.md, one that resolves to a directory, or one
 * that cannot be resolved at all — fails the inventory closed with the path
 * that needs an owner decision. Nothing is followed: the target's metadata is
 * examined only to tell a directory from a file, never read or traversed, so
 * a link pointing outside the repository stays outside it. A link to a
 * non-Markdown file is not Markdown-relevant and is skipped as before, and a
 * link named like a skipped directory (node_modules) is skipped like one.
 * Standard onboarding does not walk the tree and is unaffected.
 */
function refuseMarkdownRelevantSymlink(entry, abs, rel, skipDirs) {
  if (skipDirs.has(entry.name)) return;
  const isMarkdownName = entry.name.toLowerCase().endsWith('.md');
  let target = null;
  if (!isMarkdownName) {
    try { target = fs.statSync(abs); } catch (_) { target = null; }
    if (target && target.isFile()) return;
  }
  const kind = isMarkdownName ? 'a symlinked Markdown file'
    : target && target.isDirectory() ? 'a symlinked directory'
      : target ? 'a symlink to a non-regular file'
        : 'an unresolvable symlink';
  throw authorityError(
    `governed inventory cannot include ${rel}: ${kind} is not inventoried and must not disappear silently — `
      + 'replace it with a real file or directory, or remove it, then re-run the inventory',
    'AUTHORITY_INVENTORY_SYMLINK',
  );
}

function kindForPath(rel) {
  const base = path.basename(rel).toLowerCase();
  if (base === 'readme.md') return 'readme';
  if (base === 'claude.md') return 'claude-md';
  if (base === 'agents.md') return 'agents-md';
  if (/spec/.test(base)) return 'spec';
  if (/roadmap/.test(base)) return 'roadmap';
  if (/backlog/.test(base)) return 'action-plan';
  if (/architecture|adr/.test(base)) return 'architecture';
  return 'other';
}

function globMatches(rel, pattern) {
  let source = '^';
  const p = pattern.split(path.sep).join('/');
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === '*' && p[i + 1] === '*' && p[i + 2] === '/') {
      source += '(?:.*/)?';
      i += 2;
    } else if (ch === '*' && p[i + 1] === '*') {
      source += '.*';
      i += 1;
    } else if (ch === '*') {
      source += '[^/]*';
    } else if (ch === '?') {
      source += '[^/]';
    } else {
      source += ch.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`, 'i').test(rel);
}

function sha256File(abs) {
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

function authorityError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// ─── helpers ────────────────────────────────────────────────────────────────

function exists(root, rel) {
  try { return fs.existsSync(path.join(root, rel)); } catch { return false; }
}

function isDir(root, rel) {
  const abs = path.join(root, rel);
  try { return fs.statSync(abs).isDirectory(); } catch { return false; }
}

function isDirAbs(abs) {
  try { return fs.statSync(abs).isDirectory(); } catch { return false; }
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function countMdFiles(dir) {
  if (!isDirAbs(dir)) return 0;
  return safeReaddir(dir).filter((f) => f.endsWith('.md')).length;
}

function pushIfFile(out, root, rel, kind) {
  const abs = path.join(root, rel);
  let stat;
  try { stat = fs.statSync(abs); } catch { return; }
  if (!stat.isFile()) return;
  out.push({ path: rel, kind, bytes: stat.size });
}

module.exports = {
  AUTHORITY_CLASSES,
  DEFAULT_AUTHORITY_RULES,
  detectExistingDocs,
  normalizeAuthorityRules,
  classifyAuthoritySource,
  walkMarkdownPaths,
  sha256File,
};
