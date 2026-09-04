'use strict';

// A1c.2 contract tests for receipt-backed PR delivery. The injected adapters
// model git/GitHub while the real filesystem persists the recovery journal.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SHA = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const DIGEST = 'c'.repeat(64);
const RUN_ID = 'execution-a1c2-fixture';

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-egress-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const remote = { branchSha: null, pr: null, statuses: [] };
  const receipt = {
    runId: RUN_ID,
    receiptDigest: DIGEST,
    identity: { admittedRepo: 'owner/project' },
    candidate: { branch: 'factory/candidate-001', sha: SHA, heldSha: SHA, base: { branch: 'main', sha: BASE } },
  };
  const authority = {
    finalize: ({ candidateSha }) => {
      calls.push(['finalize', candidateSha]);
      if (candidateSha !== SHA) throw Object.assign(new Error('candidate drift'), { code: 'RECEIPT_CANDIDATE_DRIFT' });
      return { created: true, receipt };
    },
    verify: () => ({ receipt, verification: { matchesReceipt: true, candidateSha: SHA } }),
    store: { withLease: (_runId, fn) => fn() },
  };
  const git = (args) => {
    calls.push(['git', ...args]);
    if (args[0] === 'status') return '';
    if (args[0] === 'remote') return 'git@github.com:owner/project.git';
    if (args[0] === 'fetch') return '';
    if (args[0] === 'rev-parse') return args.at(-1).includes('origin/main') ? BASE : SHA;
    if (args[0] === 'ls-remote') return remote.branchSha ? `${remote.branchSha}\trefs/heads/factory/candidate-001\n` : '';
    if (args[0] === 'push') { remote.branchSha = SHA; return ''; }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  const github = {
    inspectRepo: () => ({ nameWithOwner: 'owner/project', defaultBranch: 'main', permission: 'ADMIN' }),
    findOpenPr: () => remote.pr,
    createPr: ({ head, base }) => {
      calls.push(['createPr', head, base]);
      remote.pr = { number: 17, url: 'https://github.com/owner/project/pull/17', state: 'OPEN', headRefName: head, headRefOid: SHA, headRepository: { nameWithOwner: 'owner/project' }, baseRefName: base };
      return remote.pr;
    },
    readPr: () => remote.pr,
    readStatuses: () => remote.statuses,
    publishStatus: (status) => { calls.push(['status', status.state, status.sha]); remote.statuses.unshift(status); },
  };
  const config = { projectRoot: root, statePath: path.join(root, '.build-studio'), deployment: { repo: 'owner/project' } };
  return { root, calls, remote, receipt, authority, git, github, config, ...overrides };
}

function service(fx) {
  const { createReceiptEgress } = require('./receipt-egress');
  return createReceiptEgress({ config: fx.config, receiptAuthority: fx.authority, git: fx.git, github: fx.github });
}

test('A1c.2 refuses before remote mutation when receipt candidate, local branch, or base drifts', (t) => {
  const fx = fixture(t);
  fx.authority.verify = () => ({ receipt: fx.receipt, verification: { matchesReceipt: false, candidateSha: 'd'.repeat(40) } });
  assert.throws(() => service(fx).deliver({ expectedSha: SHA }), (error) => error.code === 'EGRESS_CANDIDATE_DRIFT');
  assert.equal(fx.calls.some((call) => call[1] === 'push' || call[0] === 'createPr' || call[0] === 'status'), false);

  const baseDrift = fixture(t);
  baseDrift.git = (args) => {
    baseDrift.calls.push(['git', ...args]);
    if (args[0] === 'status') return '';
    if (args[0] === 'remote') return 'https://github.com/owner/project.git';
    if (args[0] === 'fetch') return '';
    if (args[0] === 'rev-parse') return 'e'.repeat(40);
    throw new Error('remote mutation reached');
  };
  assert.throws(() => service(baseDrift).deliver({ expectedSha: SHA }), (error) => error.code === 'EGRESS_BASE_DRIFT');
  assert.equal(baseDrift.calls.some((call) => call[1] === 'push' || call[0] === 'createPr' || call[0] === 'status'), false);
});

test('A1c.2 categorically refuses to publish a receipt candidate onto the default branch', (t) => {
  const fx = fixture(t);
  fx.receipt.candidate.branch = 'main';
  assert.throws(() => service(fx).deliver({ expectedSha: SHA }), (error) => error.code === 'EGRESS_CANDIDATE_DRIFT');
  assert.equal(fx.calls.some((call) => call[1] === 'push' || call[0] === 'createPr' || call[0] === 'status'), false);
});

test('A1c.2 pushes the exact object, creates one exact PR, then publishes SUCCESS on that SHA', (t) => {
  const fx = fixture(t);
  const result = service(fx).deliver({ expectedSha: SHA });
  assert.equal(result.outcome, 'delivered');
  assert.equal(result.candidateSha, SHA);
  assert.equal(result.pr.number, 17);
  const push = fx.calls.find((call) => call[0] === 'git' && call[1] === 'push');
  assert.deepEqual(push, ['git', 'push', 'origin', `${SHA}:refs/heads/factory/candidate-001`]);
  assert.equal(fx.calls.some((call) => call.includes('--force') || call.includes('--delete')), false);
  const createIndex = fx.calls.findIndex((call) => call[0] === 'createPr');
  const statusIndex = fx.calls.findIndex((call) => call[0] === 'status');
  assert.ok(createIndex >= 0 && statusIndex > createIndex, 'SUCCESS must be published only after the exact PR exists');
  assert.deepEqual(fx.calls[statusIndex].slice(0, 3), ['status', 'success', SHA]);
});

test('A1c.2 is retry-safe after every external boundary and never creates a second PR', (t) => {
  const fx = fixture(t);
  const firstGithub = { ...fx.github };
  firstGithub.publishStatus = () => { throw new Error('injected status outage'); };
  assert.throws(() => createWith(fx, firstGithub).deliver({ expectedSha: SHA }), /status outage/);
  assert.equal(fx.remote.branchSha, SHA);
  assert.equal(fx.remote.pr.number, 17);

  const result = service(fx).deliver({ expectedSha: SHA });
  assert.equal(result.outcome, 'delivered');
  assert.equal(fx.calls.filter((call) => call[0] === 'createPr').length, 1);
  assert.equal(fx.calls.filter((call) => call[0] === 'git' && call[1] === 'push').length, 1);

  const again = service(fx).deliver({ expectedSha: SHA });
  assert.equal(again.outcome, 'delivered');
  assert.equal(again.replayed, true);
  assert.equal(fx.calls.filter((call) => call[0] === 'createPr').length, 1);
  const journal = again.journal;
  assert.equal(journal.stage, 'delivered');
  assert.equal(journal.revision, 4, 'a replay must not regress or rewrite the delivered journal');
});

test('A1c.2 refuses a remote branch or PR that points at any other SHA', (t) => {
  const fx = fixture(t);
  fx.remote.branchSha = 'd'.repeat(40);
  assert.throws(() => service(fx).deliver({ expectedSha: SHA }), (error) => error.code === 'EGRESS_REMOTE_BRANCH_CONFLICT');
  assert.equal(fx.calls.some((call) => call[0] === 'createPr' || call[0] === 'status'), false);

  const prDrift = fixture(t);
  prDrift.remote.branchSha = SHA;
  prDrift.remote.pr = { number: 9, url: 'https://github.com/owner/project/pull/9', state: 'OPEN', headRefName: 'factory/candidate-001', headRefOid: 'e'.repeat(40), headRepository: { nameWithOwner: 'owner/project' }, baseRefName: 'main' };
  assert.throws(() => service(prDrift).deliver({ expectedSha: SHA }), (error) => error.code === 'EGRESS_PR_CONFLICT');
  assert.equal(prDrift.calls.some((call) => call[0] === 'status'), false);
});

test('A1c.2 never replaces a journaled PR and never overwrites a conflicting receipt status', (t) => {
  const closed = fixture(t);
  const firstGithub = { ...closed.github, publishStatus: () => { throw new Error('stop after PR'); } };
  assert.throws(() => createWith(closed, firstGithub).deliver({ expectedSha: SHA }), /stop after PR/);
  closed.remote.pr.state = 'CLOSED';
  assert.throws(() => service(closed).deliver({ expectedSha: SHA }), (error) => error.code === 'EGRESS_PR_CONFLICT');
  assert.equal(closed.calls.filter((call) => call[0] === 'createPr').length, 1);

  const statusConflict = fixture(t);
  statusConflict.remote.branchSha = SHA;
  statusConflict.remote.pr = { number: 18, url: 'https://github.com/owner/project/pull/18', state: 'OPEN', headRefName: 'factory/candidate-001', headRefOid: SHA, headRepository: { nameWithOwner: 'owner/project' }, baseRefName: 'main' };
  statusConflict.remote.statuses = [{ context: 'factory-run-receipt', state: 'failure', description: 'revoked', target_url: statusConflict.remote.pr.url }];
  assert.throws(() => service(statusConflict).deliver({ expectedSha: SHA }), (error) => error.code === 'EGRESS_STATUS_CONFLICT');
  assert.equal(statusConflict.calls.some((call) => call[0] === 'status'), false);
});

test('A1c.2 rejects client authority fields and never exposes merge or branch deletion', (t) => {
  const fx = fixture(t);
  assert.throws(() => service(fx).deliver({ expectedSha: SHA, repo: 'attacker/repo' }), (error) => error.code === 'EGRESS_BAD_REQUEST');
  assert.equal(fx.calls.length, 0);
  const source = fs.readFileSync(require.resolve('./receipt-egress'), 'utf8');
  assert.doesNotMatch(source, /gh\s+pr\s+merge|push[^\n]*--delete|branch[^\n]*-D/);
});

test('A1c.2 refuses a tampered delivery journal instead of trusting or repairing it', (t) => {
  const fx = fixture(t);
  const firstGithub = { ...fx.github, publishStatus: () => { throw new Error('stop after PR'); } };
  assert.throws(() => createWith(fx, firstGithub).deliver({ expectedSha: SHA }), /stop after PR/);
  const journalDir = path.join(fx.config.statePath, 'run-receipt', 'egress');
  const journalFile = path.join(journalDir, `${RUN_ID}.json`);
  const doc = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
  doc.candidateSha = 'd'.repeat(40);
  fs.writeFileSync(journalFile, JSON.stringify(doc));
  assert.throws(() => service(fx).deliver({ expectedSha: SHA }), (error) => error.code === 'EGRESS_JOURNAL_CONFLICT');
  assert.equal(fx.calls.filter((call) => call[0] === 'status').length, 0);
});

test('A1c.2 GitHub adapter uses only repo reads, PR create/read, and exact commit statuses', () => {
  const { createGithubAdapter } = require('./receipt-egress');
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === 'repo') return JSON.stringify({ nameWithOwner: 'owner/project', defaultBranchRef: { name: 'main' }, viewerPermission: 'WRITE' });
    if (args[0] === 'pr' && args[1] === 'list') return '[]';
    if (args[0] === 'pr' && args[1] === 'create') return 'https://github.com/owner/project/pull/17';
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ number: 17, url: 'https://github.com/owner/project/pull/17', state: 'OPEN', headRefName: 'factory/candidate-001', headRefOid: SHA, headRepository: { nameWithOwner: 'owner/project' }, baseRefName: 'main' });
    if (args[0] === 'api' && args.includes('--method') && args.includes('GET')) return '[]';
    if (args[0] === 'api') return '{}';
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  const gh = createGithubAdapter(run);
  assert.equal(gh.inspectRepo('owner/project').permission, 'WRITE');
  assert.equal(gh.findOpenPr({ repo: 'owner/project', head: 'factory/candidate-001' }), null);
  gh.createPr({ repo: 'owner/project', head: 'factory/candidate-001', base: 'main', title: 'title', body: 'body' });
  gh.readPr({ repo: 'owner/project', number: 17 });
  gh.readStatuses({ repo: 'owner/project', sha: SHA });
  gh.publishStatus({ repo: 'owner/project', sha: SHA, state: 'success', description: 'receipt', targetUrl: 'https://github.com/owner/project/pull/17' });
  const flat = calls.map((args) => args.join(' ')).join('\n');
  assert.doesNotMatch(flat, /\bmerge\b|--delete|--force|\/git\/refs/);
  assert.match(flat, new RegExp(`repos/owner/project/statuses/${SHA}`));
});

function createWith(fx, github) {
  const { createReceiptEgress } = require('./receipt-egress');
  return createReceiptEgress({ config: fx.config, receiptAuthority: fx.authority, git: fx.git, github });
}
