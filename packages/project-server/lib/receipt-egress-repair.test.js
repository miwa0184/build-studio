'use strict';

// Independent repair attacks for A1c.2. Each case captures a boundary that
// passed the first implementation review but must refuse before unsafe egress.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { digest } = require('./authority-store');
const { createRunReceiptStore } = require('./run-receipt');
const { createReceiptEgress } = require('./receipt-egress');

const SHA = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const OTHER = 'd'.repeat(40);
const RECEIPT_DIGEST = 'c'.repeat(64);
const RUN_ID = 'execution-a1c2-repair';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-egress-repair-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const remote = {
    fetchUrl: 'git@github.com:owner/project.git',
    pushUrl: 'git@github.com:owner/project.git',
    baseSha: BASE,
    localTip: SHA,
    branchSha: null,
    pr: null,
    statuses: [],
    active: true,
  };
  const receipt = {
    runId: RUN_ID,
    receiptDigest: RECEIPT_DIGEST,
    identity: { admittedRepo: 'owner/project' },
    candidate: {
      branch: 'factory/candidate-repair', sha: SHA, heldSha: SHA,
      base: { branch: 'main', sha: BASE },
    },
  };
  const authority = {
    finalize: () => ({ created: false, receipt }),
    verify: () => ({ receipt, verification: { matchesReceipt: true, candidateSha: SHA } }),
    verifyForDelivery: () => {
      calls.push(['verifyForDelivery']);
      if (!remote.active) throw Object.assign(new Error('run is no longer active'), { code: 'RECEIPT_NO_ACTIVE_RUN' });
      return { receipt, verification: { matchesReceipt: true, candidateSha: SHA, active: true } };
    },
    store: { withLease: (_id, fn) => fn() },
  };
  const git = (args) => {
    calls.push(['git', ...args]);
    if (args[0] === 'config') return '';
    if (args[0] === 'status') return '';
    if (args[0] === 'remote' && args.includes('--push')) return remote.pushUrl;
    if (args[0] === 'remote') return remote.fetchUrl;
    if (args[0] === 'fetch') return '';
    if (args[0] === 'rev-parse') {
      const spec = args.at(-1);
      if (spec.includes('refs/remotes/origin/main')) return remote.baseSha;
      if (spec.includes('refs/heads/factory/candidate-repair')) return remote.localTip;
      return SHA;
    }
    if (args[0] === 'ls-remote') return remote.branchSha ? `${remote.branchSha}\trefs/heads/factory/candidate-repair\n` : '';
    if (args[0] === 'push') { remote.branchSha = SHA; return ''; }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  function pr(state = 'OPEN', baseRefOid = BASE) {
    return {
      number: 19, url: 'https://github.com/owner/project/pull/19', state,
      headRefName: receipt.candidate.branch, headRefOid: SHA,
      headRepository: { nameWithOwner: 'owner/project' },
      baseRefName: 'main', baseRefOid,
    };
  }
  const github = {
    inspectRepo: () => ({ nameWithOwner: 'owner/project', defaultBranch: 'main', permission: 'WRITE' }),
    findOpenPr: () => remote.pr && remote.pr.state === 'OPEN' ? remote.pr : null,
    findPr: () => remote.pr,
    createPr: () => { calls.push(['createPr']); remote.pr = pr(); return remote.pr; },
    readPr: () => remote.pr,
    readStatuses: () => remote.statuses,
    publishStatus: (status) => { calls.push(['status', status]); remote.statuses.unshift({ context: 'factory-run-receipt', ...status, target_url: status.targetUrl }); },
  };
  const config = {
    projectRoot: root,
    statePath: path.join(root, '.build-studio'),
    deployment: { repo: 'owner/project' },
  };
  return { root, calls, remote, receipt, authority, git, github, config, pr };
}

function service(fx) {
  return createReceiptEgress({
    config: fx.config, receiptAuthority: fx.authority, git: fx.git, github: fx.github,
    randomToken: () => '0123456789abcdef0123456789abcdef',
  });
}

function mutated(fx) {
  return fx.calls.some((call) => call[0] === 'createPr' || call[0] === 'status' || (call[0] === 'git' && call[1] === 'push'));
}

test('repair — a mismatched effective pushurl refuses before remote mutation', (t) => {
  const fx = fixture(t);
  fx.remote.pushUrl = 'git@github.com:attacker/other.git';
  assert.throws(() => service(fx).deliver({ expectedSha: SHA }), (error) => error.code === 'EGRESS_REPO_MISMATCH');
  assert.equal(mutated(fx), false);
});

test('repair — inactive run or moved local candidate ref refuses inside the delivery lease', (t) => {
  const inactive = fixture(t);
  inactive.remote.active = false;
  assert.throws(() => service(inactive).deliver({ expectedSha: SHA }), /no longer active/);
  assert.equal(mutated(inactive), false);

  const moved = fixture(t);
  moved.remote.localTip = OTHER;
  assert.throws(() => service(moved).deliver({ expectedSha: SHA }), (error) => error.code === 'EGRESS_CANDIDATE_DRIFT');
  assert.equal(mutated(moved), false);
});

test('repair — branch publication is a create-only zero-old ref CAS to the verified URL', (t) => {
  const fx = fixture(t);
  service(fx).deliver({ expectedSha: SHA });
  const push = fx.calls.find((call) => call[0] === 'git' && call[1] === 'push');
  assert.deepEqual(push, [
    'git', 'push', '--porcelain',
    '--force-with-lease=refs/heads/factory/candidate-repair:',
    fx.remote.pushUrl,
    `${SHA}:refs/heads/factory/candidate-repair`,
  ]);
});

test('repair — base movement or a PR bound to another base SHA refuses before SUCCESS', (t) => {
  const movedDuringPr = fixture(t);
  movedDuringPr.github.createPr = () => {
    movedDuringPr.calls.push(['createPr']);
    movedDuringPr.remote.pr = movedDuringPr.pr();
    movedDuringPr.remote.baseSha = OTHER;
    return movedDuringPr.remote.pr;
  };
  assert.throws(() => service(movedDuringPr).deliver({ expectedSha: SHA }), (error) => error.code === 'EGRESS_BASE_DRIFT');
  assert.equal(movedDuringPr.calls.some((call) => call[0] === 'status'), false);

  const wrongPrBase = fixture(t);
  wrongPrBase.remote.branchSha = SHA;
  wrongPrBase.remote.pr = wrongPrBase.pr('OPEN', OTHER);
  assert.throws(() => service(wrongPrBase).deliver({ expectedSha: SHA }), (error) => error.code === 'EGRESS_PR_CONFLICT');
  assert.equal(wrongPrBase.calls.some((call) => call[0] === 'status'), false);
});

test('repair — a closed unjournaled PR is never replaced after a create crash', (t) => {
  const fx = fixture(t);
  fx.remote.branchSha = SHA;
  fx.remote.pr = fx.pr('CLOSED');
  assert.throws(() => service(fx).deliver({ expectedSha: SHA }), (error) => error.code === 'EGRESS_PR_CONFLICT');
  assert.equal(fx.calls.some((call) => call[0] === 'createPr'), false);
});

test('repair — malformed stage invariants and parent symlinks make the journal fail closed', (t) => {
  const malformed = fixture(t);
  const intent = {
    schemaVersion: 1, kind: 'ReceiptEgressDelivery', runId: RUN_ID, repo: 'owner/project',
    baseBranch: 'main', baseSha: BASE, candidateBranch: 'factory/candidate-repair',
    candidateSha: SHA, receiptDigest: RECEIPT_DIGEST,
  };
  const dir = path.join(malformed.config.statePath, 'run-receipt', 'egress');
  fs.mkdirSync(path.join(dir, RUN_ID), { recursive: true });
  fs.writeFileSync(path.join(dir, RUN_ID, '1-prepared.json'), JSON.stringify({
    ...intent, intentDigest: digest(intent), revision: 1, stage: 'delivered', pr: null,
    statusNonce: null, priorDigest: null, updatedAt: new Date().toISOString(),
  }));
  assert.throws(() => service(malformed).deliver({ expectedSha: SHA }), (error) => error.code === 'EGRESS_JOURNAL_CONFLICT');
  assert.equal(mutated(malformed), false);

  const linked = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-egress-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(linked.config.statePath, { recursive: true });
  fs.symlinkSync(outside, path.join(linked.config.statePath, 'run-receipt'));
  assert.throws(() => service(linked).deliver({ expectedSha: SHA }), (error) => error.code === 'EGRESS_JOURNAL_CONFLICT');
  assert.equal(mutated(linked), false);
});

test('repair — an exact-looking pre-existing status is not accepted without a pending journal intent', (t) => {
  const fx = fixture(t);
  fx.remote.branchSha = SHA;
  fx.remote.pr = fx.pr();
  fx.remote.statuses = [{
    context: 'factory-run-receipt', state: 'success',
    description: `receipt ${RECEIPT_DIGEST.slice(0, 16)} · run ${RUN_ID}`,
    target_url: fx.remote.pr.url,
  }];
  assert.throws(() => service(fx).deliver({ expectedSha: SHA }), (error) => error.code === 'EGRESS_STATUS_CONFLICT');
  assert.equal(fx.calls.some((call) => call[0] === 'status'), false);
});

test('repair — a two-stage insteadOf chain is refused before Git can rewrite the verified URL again', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-egress-rewrite-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const work = path.join(root, 'work');
  const attacker = path.join(root, 'attacker.git');
  fs.mkdirSync(work);
  execFileSync('git', ['init', '-q'], { cwd: work });
  execFileSync('git', ['init', '--bare', '-q', attacker], { cwd: root });
  execFileSync('git', ['config', 'url.https://github.com/owner/.insteadOf', 'short:'], { cwd: work });
  execFileSync('git', ['config', `url.file://${attacker}/.insteadOf`, 'https://github.com/owner/'], { cwd: work });
  execFileSync('git', ['remote', 'add', 'origin', 'short:project'], { cwd: work });

  const fx = fixture(t);
  fx.config.projectRoot = work;
  fx.config.statePath = path.join(work, '.build-studio');
  const before = execFileSync('git', [`--git-dir=${attacker}`, 'for-each-ref', '--format=%(objectname) %(refname)'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const egress = createReceiptEgress({
    config: fx.config, receiptAuthority: fx.authority, github: fx.github,
  });
  assert.throws(() => egress.deliver({ expectedSha: SHA }), (error) => error.code === 'EGRESS_REPO_MISMATCH');
  const after = execFileSync('git', [`--git-dir=${attacker}`, 'for-each-ref', '--format=%(objectname) %(refname)'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  assert.equal(after, before);
  assert.equal(mutated(fx), false);
});

test('repair — a changed pending journal is re-read immediately before status publication', (t) => {
  const fx = fixture(t);
  fx.remote.branchSha = SHA;
  fx.remote.pr = fx.pr();
  let attacked = false;
  fx.github.readStatuses = () => {
    if (!attacked) {
      attacked = true;
      const file = path.join(fx.config.statePath, 'run-receipt', 'egress', RUN_ID, '4-status_pending.json');
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      doc.statusNonce = 'f'.repeat(32);
      fs.writeFileSync(file, JSON.stringify(doc));
    }
    return [];
  };
  assert.throws(() => service(fx).deliver({ expectedSha: SHA }), (error) => error.code === 'EGRESS_JOURNAL_CONFLICT');
  assert.equal(fx.calls.some((call) => call[0] === 'status'), false);
});

test('repair — GitHub status pagination includes a conflicting context on page two', () => {
  const { createGithubAdapter } = require('./receipt-egress');
  const pageOne = Array.from({ length: 100 }, (_, index) => ({ context: `other-${index}` }));
  const conflict = { context: 'factory-run-receipt', state: 'failure' };
  const calls = [];
  const adapter = createGithubAdapter((args) => {
    calls.push(args);
    return JSON.stringify([pageOne, [conflict]]);
  });
  const statuses = adapter.readStatuses({ repo: 'owner/project', sha: SHA });
  assert.equal(statuses.length, 101);
  assert.deepEqual(statuses.at(-1), conflict);
  assert.deepEqual(calls[0].slice(-2), ['--paginate', '--slurp']);
});

test('repair — the real receipt store refuses direct, dangling, and intermediate authority symlinks', (t) => {
  const cases = ['direct', 'dangling', 'intermediate'];
  for (const scenario of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `receipt-store-${scenario}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), `receipt-store-outside-${scenario}-`));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    fs.writeFileSync(path.join(outside, 'sentinel'), 'unchanged');
    let statePath = path.join(root, '.build-studio');
    if (scenario === 'direct') {
      fs.mkdirSync(statePath);
      fs.symlinkSync(outside, path.join(statePath, 'run-receipt'));
    } else if (scenario === 'dangling') {
      fs.mkdirSync(statePath);
      fs.symlinkSync(path.join(root, 'missing-target'), path.join(statePath, 'run-receipt'));
    } else {
      const linked = path.join(root, 'linked-project');
      fs.symlinkSync(outside, linked);
      statePath = path.join(linked, '.build-studio');
    }
    const store = createRunReceiptStore({ statePath });
    assert.throws(() => store.withLease('symlink-run', () => 'unsafe'), (error) => error.code === 'RECEIPT_STORAGE_UNPROTECTED');
    assert.equal(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8'), 'unchanged');
    assert.deepEqual(fs.readdirSync(outside).sort(), ['sentinel']);
  }
});

test('repair — the real receipt store refuses symlinked lease and receipt leaf targets before mutation', (t) => {
  for (const scenario of ['locks-existing', 'locks-dangling', 'receipt-existing', 'receipt-dangling']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `receipt-leaf-${scenario}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), `receipt-leaf-outside-${scenario}-`));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    const statePath = path.join(root, '.build-studio');
    const receiptDir = path.join(statePath, 'run-receipt');
    fs.mkdirSync(receiptDir, { recursive: true });
    fs.writeFileSync(path.join(outside, 'sentinel'), 'unchanged');
    const before = fs.readdirSync(outside).sort();
    const store = createRunReceiptStore({ statePath });
    let callbackRan = false;

    if (scenario.startsWith('locks-')) {
      const target = scenario.endsWith('existing') ? outside : path.join(root, 'missing-locks');
      fs.symlinkSync(target, path.join(receiptDir, '.locks'));
      assert.throws(() => store.withLease('leaf-symlink-run', () => {
        callbackRan = true;
      }), (error) => error.code === 'RECEIPT_STORAGE_UNPROTECTED');
      assert.equal(callbackRan, false);
    } else {
      const target = scenario.endsWith('existing')
        ? path.join(outside, 'sentinel')
        : path.join(root, 'missing-receipt');
      fs.symlinkSync(target, store.fileFor('leaf-symlink-run'));
      assert.throws(() => store.withLease('leaf-symlink-run', () => {
        callbackRan = true;
      }), (error) => error.code === 'RECEIPT_STORAGE_UNPROTECTED');
      assert.equal(callbackRan, false);
      assert.throws(() => store.load('leaf-symlink-run'), (error) => error.code === 'RECEIPT_STORAGE_UNPROTECTED');
    }

    assert.equal(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8'), 'unchanged');
    assert.deepEqual(fs.readdirSync(outside).sort(), before);
  }
});

test('repair — a symlink above the configured project path refuses before creating authority state', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-parent-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-parent-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(outside, 'project'));
  fs.writeFileSync(path.join(outside, 'sentinel'), 'unchanged');
  fs.symlinkSync(outside, path.join(root, 'linked-parent'));
  const statePath = path.join(root, 'linked-parent', 'project', '.build-studio');
  const store = createRunReceiptStore({ statePath });
  let callbackRan = false;
  assert.throws(() => store.withLease('parent-link-run', () => {
    callbackRan = true;
  }), (error) => error.code === 'RECEIPT_STORAGE_UNPROTECTED');
  assert.equal(callbackRan, false);
  assert.equal(fs.existsSync(path.join(outside, 'project', '.build-studio')), false);
  assert.equal(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8'), 'unchanged');
});

test('repair — the create-only push cannot fast-forward a branch created in the race window', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-egress-cas-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bare = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  const run = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  fs.mkdirSync(work);
  run(root, ['init', '--bare', '-q', bare]);
  run(work, ['init', '-q']);
  run(work, ['config', 'user.email', 'fixture@example.com']);
  run(work, ['config', 'user.name', 'Fixture']);
  fs.writeFileSync(path.join(work, 'file.txt'), 'base\n');
  run(work, ['add', 'file.txt']);
  run(work, ['commit', '-q', '-m', 'base']);
  const ancestor = run(work, ['rev-parse', 'HEAD']);
  run(work, ['push', '-q', bare, 'HEAD:refs/heads/main']);
  fs.appendFileSync(path.join(work, 'file.txt'), 'candidate\n');
  run(work, ['commit', '-qam', 'candidate']);
  const candidate = run(work, ['rev-parse', 'HEAD']);

  run(work, [
    'push', '--porcelain', '--force-with-lease=refs/heads/factory/fresh:',
    bare, `${candidate}:refs/heads/factory/fresh`,
  ]);
  assert.equal(run(root, [`--git-dir=${bare}`, 'rev-parse', 'refs/heads/factory/fresh']), candidate);

  // The competing actor creates the branch after an earlier absence check.
  run(root, [`--git-dir=${bare}`, 'update-ref', 'refs/heads/factory/candidate', ancestor]);
  assert.throws(() => run(work, [
    'push', '--porcelain', '--force-with-lease=refs/heads/factory/candidate:',
    bare, `${candidate}:refs/heads/factory/candidate`,
  ]));
  assert.equal(run(root, [`--git-dir=${bare}`, 'rev-parse', 'refs/heads/factory/candidate']), ancestor);
});
