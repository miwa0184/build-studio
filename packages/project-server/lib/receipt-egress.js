'use strict';

/**
 * Receipt-backed PR egress. It can publish one frozen candidate branch, open
 * one exact PR, and attach one exact-SHA commit status. It cannot merge, tag,
 * deploy, force-push, or delete a branch.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const {
  writeExclusive, digest, exactKeys, safeRunId, assertPathComponentsNoSymlink,
} = require('./authority-store');

const STATUS_CONTEXT = 'factory-run-receipt';
const DELIVERY_DIR = path.join('run-receipt', 'egress');
const SHA_RE = /^[0-9a-f]{40}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^(?!-)(?!.*\.\.)(?!\/)(?!.*\/$)[A-Za-z0-9._/-]+$/;
const JOURNAL_STAGE_ORDER = ['prepared', 'branch_pushed', 'pr_open', 'status_pending', 'delivered'];
const JOURNAL_STAGES = new Set(JOURNAL_STAGE_ORDER);
const JOURNAL_STAGE_RANK = new Map(JOURNAL_STAGE_ORDER.map((stage, index) => [stage, index]));
const COMMAND_TIMEOUT_MS = 30_000;

const CODES = Object.freeze({
  BAD_REQUEST: 'EGRESS_BAD_REQUEST',
  CONFIG: 'EGRESS_CONFIG_INVALID',
  REPO_MISMATCH: 'EGRESS_REPO_MISMATCH',
  WORKTREE_DIRTY: 'EGRESS_WORKTREE_DIRTY',
  CANDIDATE_DRIFT: 'EGRESS_CANDIDATE_DRIFT',
  BASE_DRIFT: 'EGRESS_BASE_DRIFT',
  REMOTE_BRANCH_CONFLICT: 'EGRESS_REMOTE_BRANCH_CONFLICT',
  PR_CONFLICT: 'EGRESS_PR_CONFLICT',
  STATUS_CONFLICT: 'EGRESS_STATUS_CONFLICT',
  JOURNAL_CONFLICT: 'EGRESS_JOURNAL_CONFLICT',
});

class ReceiptEgressError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ReceiptEgressError';
    this.code = code;
    Object.assign(this, details);
  }
}

function refuse(code, message, details) {
  throw new ReceiptEgressError(code, message, details);
}

function parseOriginRepo(url) {
  if (typeof url !== 'string') return null;
  const value = url.trim().replace(/\.git$/, '');
  const ssh = value.match(/^git@github\.com:([^/]+\/[^/]+)$/i);
  if (ssh) return ssh[1];
  const https = value.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)$/i);
  return https ? https[1] : null;
}

function defaultGit(projectRoot) {
  return (args) => execFileSync('git', args, {
    cwd: projectRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    timeout: COMMAND_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024,
  }).trim();
}

function json(output) {
  if (typeof output !== 'string') return output;
  return JSON.parse(output || 'null');
}

function createGithubAdapter(run = (args) => execFileSync('gh', args, {
  encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  timeout: COMMAND_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024,
}).trim()) {
  return {
    inspectRepo(repo) {
      const value = json(run(['repo', 'view', repo, '--json', 'nameWithOwner,defaultBranchRef,viewerPermission']));
      return {
        nameWithOwner: value.nameWithOwner,
        defaultBranch: value.defaultBranchRef && value.defaultBranchRef.name,
        permission: value.viewerPermission,
      };
    },
    findPr({ repo, head }) {
      const rows = json(run(['pr', 'list', '--repo', repo, '--state', 'all', '--head', head,
        '--json', 'number,url,state,headRefName,headRefOid,headRepository,baseRefName,baseRefOid', '--limit', '2'])) || [];
      if (rows.length > 1) refuse(CODES.PR_CONFLICT, `more than one PR targets branch ${head}`);
      return rows[0] || null;
    },
    createPr({ repo, head, base, title, body }) {
      run(['pr', 'create', '--repo', repo, '--head', head, '--base', base, '--title', title, '--body', body]);
      return this.findPr({ repo, head });
    },
    readPr({ repo, number }) {
      return json(run(['pr', 'view', String(number), '--repo', repo,
        '--json', 'number,url,state,headRefName,headRefOid,headRepository,baseRefName,baseRefOid']));
    },
    readStatuses({ repo, sha }) {
      const pages = json(run(['api', '--method', 'GET', `repos/${repo}/commits/${sha}/statuses`,
        '-f', 'per_page=100', '--paginate', '--slurp']));
      if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
        refuse(CODES.STATUS_CONFLICT, 'GitHub commit-status pagination returned an invalid response');
      }
      const statuses = pages.flat();
      if (statuses.some((status) => !status || typeof status !== 'object' || Array.isArray(status))) {
        refuse(CODES.STATUS_CONFLICT, 'GitHub commit-status pagination returned an invalid status');
      }
      return statuses;
    },
    publishStatus({ repo, sha, state, description, targetUrl }) {
      run(['api', '--method', 'POST', `repos/${repo}/statuses/${sha}`,
        '-f', `state=${state}`, '-f', `context=${STATUS_CONTEXT}`,
        '-f', `description=${description}`, '-f', `target_url=${targetUrl}`]);
    },
  };
}

function validatePr(pr, receipt) {
  if (!pr || !Number.isInteger(pr.number)
    || pr.state !== 'OPEN'
    || pr.headRefName !== receipt.candidate.branch
    || pr.headRefOid !== receipt.candidate.sha
    || !pr.headRepository
    || String(pr.headRepository.nameWithOwner).toLowerCase() !== receipt.identity.admittedRepo.toLowerCase()
    || pr.baseRefName !== receipt.candidate.base.branch
    || pr.baseRefOid !== receipt.candidate.base.sha) {
    refuse(CODES.PR_CONFLICT, 'the open PR does not match the receipt-bound branch, head, and base', {
      prNumber: pr && pr.number || null,
    });
  }
}

function deliveryIntent(receipt, repo) {
  return {
    schemaVersion: 1,
    kind: 'ReceiptEgressDelivery',
    runId: receipt.runId,
    repo,
    baseBranch: receipt.candidate.base.branch,
    baseSha: receipt.candidate.base.sha,
    candidateBranch: receipt.candidate.branch,
    candidateSha: receipt.candidate.sha,
    receiptDigest: receipt.receiptDigest,
  };
}

function validateJournal(doc, intent, expectedStage, prior) {
  const stage = doc && JOURNAL_STAGE_RANK.get(doc.stage);
  const needsPr = Number.isInteger(stage) && stage >= JOURNAL_STAGE_RANK.get('pr_open');
  const needsNonce = Number.isInteger(stage) && stage >= JOURNAL_STAGE_RANK.get('status_pending');
  if (!doc || !exactKeys(doc, [...Object.keys(intent), 'intentDigest', 'revision', 'stage', 'pr', 'statusNonce', 'priorDigest', 'updatedAt'])
    || doc.intentDigest !== digest(intent)
    || Object.keys(intent).some((key) => doc[key] !== intent[key])
    || !Number.isInteger(doc.revision) || doc.revision !== stage + 1
    || !JOURNAL_STAGES.has(doc.stage)
    || doc.stage !== expectedStage
    || doc.priorDigest !== (prior ? digest(prior) : null)
    || typeof doc.updatedAt !== 'string'
    || needsPr !== (doc.pr !== null)
    || needsNonce !== (typeof doc.statusNonce === 'string' && /^[0-9a-f]{32}$/.test(doc.statusNonce))
    || (doc.pr !== null && (!exactKeys(doc.pr, ['number', 'url'])
      || !Number.isInteger(doc.pr.number)
      || doc.pr.url.toLowerCase() !== `https://github.com/${intent.repo}/pull/${doc.pr.number}`.toLowerCase()))) {
    refuse(CODES.JOURNAL_CONFLICT, `run ${intent.runId} has a delivery journal for different evidence`);
  }
  return doc;
}

function createReceiptEgress({
  config, receiptAuthority, git, github, now = () => new Date(),
  randomToken = () => crypto.randomBytes(16).toString('hex'),
} = {}) {
  if (!config || !config.projectRoot || !receiptAuthority) throw new Error('createReceiptEgress requires config and receiptAuthority');
  const runGit = git || defaultGit(config.projectRoot);
  const gh = github || createGithubAdapter();
  const statePath = config.statePath || path.join(config.projectRoot, '.build-studio');
  const authorityBase = path.dirname(path.resolve(statePath));
  const journalDir = path.join(statePath, DELIVERY_DIR);

  function assertJournalPathSafe(target = journalDir) {
    try {
      assertPathComponentsNoSymlink(authorityBase, target);
    } catch (error) {
      refuse(CODES.JOURNAL_CONFLICT, `delivery journal path is unsafe: ${error.message}`);
    }
  }

  function loadJournal(intent) {
    const runDir = path.join(journalDir, safeRunId(intent.runId));
    assertJournalPathSafe(runDir);
    try {
      const stat = fs.lstatSync(runDir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        refuse(CODES.JOURNAL_CONFLICT, `delivery journal for ${intent.runId} must be a real directory`);
      }
    } catch (error) {
      if (error && error.code === 'ENOENT') return { runDir, doc: null };
      if (error instanceof ReceiptEgressError) throw error;
      refuse(CODES.JOURNAL_CONFLICT, `delivery journal for ${intent.runId} is unreadable: ${error.message}`);
    }
    try {
      const expectedNames = new Set(JOURNAL_STAGE_ORDER.map((stage, index) => `${index + 1}-${stage}.json`));
      const entries = fs.readdirSync(runDir);
      if (entries.some((entry) => !expectedNames.has(entry))) {
        refuse(CODES.JOURNAL_CONFLICT, `delivery journal for ${intent.runId} contains an unknown entry`);
      }
      let prior = null;
      let gap = false;
      for (let index = 0; index < JOURNAL_STAGE_ORDER.length; index += 1) {
        const stage = JOURNAL_STAGE_ORDER[index];
        const file = path.join(runDir, `${index + 1}-${stage}.json`);
        let stat;
        try {
          stat = fs.lstatSync(file);
        } catch (error) {
          if (error && error.code === 'ENOENT') { gap = true; continue; }
          throw error;
        }
        if (gap || stat.isSymbolicLink() || !stat.isFile()) {
          refuse(CODES.JOURNAL_CONFLICT, `delivery journal for ${intent.runId} has a gap or unsafe stage file`);
        }
        prior = validateJournal(JSON.parse(fs.readFileSync(file, 'utf8')), intent, stage, prior);
      }
      return { runDir, doc: prior };
    } catch (error) {
      if (error instanceof ReceiptEgressError) throw error;
      refuse(CODES.JOURNAL_CONFLICT, `delivery journal for ${intent.runId} is unreadable: ${error.message}`);
    }
  }

  function assertJournalCurrent(intent, prior) {
    const current = loadJournal(intent).doc;
    if ((!current && prior) || (current && !prior) || (current && digest(current) !== digest(prior))) {
      refuse(CODES.JOURNAL_CONFLICT, 'delivery journal changed since it was read');
    }
    return current;
  }

  function saveJournal(runDir, intent, stage, pr, prior = null, statusNonce = null) {
    const current = assertJournalCurrent(intent, prior);
    if (current && JOURNAL_STAGE_RANK.get(current.stage) >= JOURNAL_STAGE_RANK.get(stage)) return current;
    const targetRank = JOURNAL_STAGE_RANK.get(stage);
    if (!Number.isInteger(targetRank)
      || (!prior && stage !== 'prepared')
      || (prior && JOURNAL_STAGE_RANK.get(prior.stage) + 1 !== targetRank)) {
      refuse(CODES.JOURNAL_CONFLICT, `invalid delivery journal transition to ${stage}`);
    }
    assertJournalPathSafe(runDir);
    const doc = {
      ...intent,
      intentDigest: digest(intent),
      revision: targetRank + 1,
      stage,
      pr: pr ? { number: pr.number, url: pr.url } : null,
      statusNonce: statusNonce || (prior && prior.statusNonce) || null,
      priorDigest: prior ? digest(prior) : null,
      updatedAt: now().toISOString(),
    };
    validateJournal(doc, intent, stage, prior);
    fs.mkdirSync(runDir, { recursive: true });
    assertJournalPathSafe(runDir);
    const file = path.join(runDir, `${targetRank + 1}-${stage}.json`);
    if (!writeExclusive(file, doc)) {
      const raced = loadJournal(intent).doc;
      if (!raced || digest(raced) !== digest(doc)) {
        refuse(CODES.JOURNAL_CONFLICT, `delivery journal stage ${stage} appeared with different evidence`);
      }
      return raced;
    }
    return loadJournal(intent).doc;
  }

  function readUrlRewrites() {
    let output;
    try {
      output = String(runGit(['config', '--null', '--get-regexp', '^url\\..*\\.(insteadof|pushinsteadof)$']));
    } catch (error) {
      if (error && error.status === 1) return [];
      refuse(CODES.REPO_MISMATCH, `cannot verify Git URL rewrites: ${error.message}`);
    }
    return output.split('\0').filter(Boolean).map((entry) => {
      const separator = entry.indexOf('\n');
      if (separator <= 0 || separator === entry.length - 1) {
        refuse(CODES.REPO_MISMATCH, 'Git URL rewrite configuration is malformed');
      }
      const key = entry.slice(0, separator);
      const prefix = entry.slice(separator + 1);
      if (!/^url\..*\.(insteadof|pushinsteadof)$/i.test(key)) {
        refuse(CODES.REPO_MISMATCH, 'Git URL rewrite configuration is malformed');
      }
      return prefix;
    });
  }

  function assertNoSecondUrlRewrite(...urls) {
    const rewrites = readUrlRewrites();
    const unsafe = urls.find((url) => rewrites.some((prefix) => url.startsWith(prefix)));
    if (unsafe) {
      refuse(CODES.REPO_MISMATCH, 'an effective origin URL would be rewritten a second time by Git configuration');
    }
  }

  function remoteUrls(repo) {
    const read = (args) => String(runGit(args)).split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    const fetchUrls = read(['remote', 'get-url', '--all', 'origin']);
    const pushUrls = read(['remote', 'get-url', '--push', '--all', 'origin']);
    if (fetchUrls.length !== 1 || pushUrls.length !== 1
      || !parseOriginRepo(fetchUrls[0]) || !parseOriginRepo(pushUrls[0])
      || parseOriginRepo(fetchUrls[0]).toLowerCase() !== repo.toLowerCase()
      || parseOriginRepo(pushUrls[0]).toLowerCase() !== repo.toLowerCase()) {
      refuse(CODES.REPO_MISMATCH, 'origin must have exactly one fetch URL and one effective push URL for the admitted repository');
    }
    assertNoSecondUrlRewrite(fetchUrls[0], pushUrls[0]);
    return { fetchUrl: fetchUrls[0], pushUrl: pushUrls[0] };
  }

  function verifyBase(receipt, fetchUrl) {
    assertNoSecondUrlRewrite(fetchUrl);
    runGit(['fetch', '--quiet', fetchUrl,
      `refs/heads/${receipt.candidate.base.branch}:refs/remotes/origin/${receipt.candidate.base.branch}`]);
    const baseSha = runGit(['rev-parse', '--verify', `refs/remotes/origin/${receipt.candidate.base.branch}^{commit}`]).trim();
    if (baseSha !== receipt.candidate.base.sha) {
      refuse(CODES.BASE_DRIFT, 'remote default branch moved after the candidate evidence was frozen', {
        expectedBaseSha: receipt.candidate.base.sha, actualBaseSha: baseSha,
      });
    }
  }

  /**
   * Re-prove that the admitted run is still active and still finalizes the
   * same immutable receipt. Called at stage entry and again immediately before
   * each external mutation (push, PR creation, status publication), after the
   * last read that precedes it, so a run that stops during that read leaves
   * no external effect behind.
   */
  function verifyAuthority(receipt) {
    if (typeof receiptAuthority.verifyForDelivery !== 'function') {
      refuse(CODES.CANDIDATE_DRIFT, 'receipt authority cannot re-verify active delivery evidence');
    }
    const checked = receiptAuthority.verifyForDelivery({
      runId: receipt.runId,
      candidateSha: receipt.candidate.sha,
      receiptDigest: receipt.receiptDigest,
    });
    if (!checked || !checked.verification || checked.verification.active !== true
      || checked.verification.matchesReceipt !== true
      || checked.verification.candidateSha !== receipt.candidate.sha
      || !checked.receipt || checked.receipt.receiptDigest !== receipt.receiptDigest) {
      refuse(CODES.CANDIDATE_DRIFT, 'active run no longer matches the immutable delivery receipt');
    }
  }

  function preflight(receipt, expectedSha) {
    if (!receipt || expectedSha !== receipt.candidate.sha || receipt.candidate.heldSha !== expectedSha) {
      refuse(CODES.CANDIDATE_DRIFT, 'expectedSha does not match the immutable receipt candidate');
    }
    if (!SHA_RE.test(expectedSha)
      || !BRANCH_RE.test(receipt.candidate.branch)
      || !BRANCH_RE.test(receipt.candidate.base.branch)) {
      refuse(CODES.CANDIDATE_DRIFT, 'receipt candidate identity is invalid');
    }
    if (receipt.candidate.branch.toLowerCase() === receipt.candidate.base.branch.toLowerCase()) {
      refuse(CODES.CANDIDATE_DRIFT, 'receipt candidate branch must not be the default branch');
    }
    const repo = config.deployment && config.deployment.repo;
    if (!REPO_RE.test(repo || '')) refuse(CODES.CONFIG, 'deployment.repo must be an owner/repo value');
    if (receipt.identity.admittedRepo !== repo) {
      refuse(CODES.REPO_MISMATCH, 'deployment.repo does not match the admitted repository');
    }
    const urls = remoteUrls(repo);
    const tracked = runGit(['status', '--porcelain', '--untracked-files=no']);
    if (tracked.trim()) refuse(CODES.WORKTREE_DIRTY, 'tracked worktree changes exist at PR egress');
    const repoView = gh.inspectRepo(repo);
    if (!repoView || String(repoView.nameWithOwner).toLowerCase() !== repo.toLowerCase()
      || repoView.defaultBranch !== receipt.candidate.base.branch
      || !['ADMIN', 'MAINTAIN', 'WRITE'].includes(repoView.permission)) {
      refuse(CODES.REPO_MISMATCH, 'GitHub repository identity, default branch, or write authority does not match the receipt');
    }
    verifyBase(receipt, urls.fetchUrl);
    const localSha = runGit(['rev-parse', '--verify', `${expectedSha}^{commit}`]).trim();
    if (localSha !== expectedSha) refuse(CODES.CANDIDATE_DRIFT, 'the exact candidate object is not available locally');
    const branchSha = runGit(['rev-parse', '--verify', `refs/heads/${receipt.candidate.branch}^{commit}`]).trim();
    if (branchSha !== expectedSha) refuse(CODES.CANDIDATE_DRIFT, 'the local candidate branch moved after receipt finalization');
    return { repo, ...urls };
  }

  function deliver(body = {}) {
    if (!body || !exactKeys(body, ['expectedSha']) || !SHA_RE.test(body.expectedSha || '')) {
      refuse(CODES.BAD_REQUEST, 'delivery accepts exactly one field: expectedSha as a 40-hex commit sha');
    }
    const finalized = receiptAuthority.finalize({ candidateSha: body.expectedSha });
    const verified = receiptAuthority.verify(finalized.receipt.runId);
    if (!verified || !verified.verification || verified.verification.matchesReceipt !== true
      || verified.verification.candidateSha !== body.expectedSha) {
      refuse(CODES.CANDIDATE_DRIFT, 'the local candidate branch no longer matches its finalized receipt');
    }
    const receipt = verified.receipt;
    return receiptAuthority.store.withLease(receipt.runId, () => {
      verifyAuthority(receipt);
      const { repo, fetchUrl, pushUrl } = preflight(receipt, body.expectedSha);
      const intent = deliveryIntent(receipt, repo);
      const { runDir, doc: prior } = loadJournal(intent);
      let journal = prior || saveJournal(runDir, intent, 'prepared', null);

      journal = assertJournalCurrent(intent, journal);
      assertNoSecondUrlRewrite(pushUrl);
      const remoteLine = runGit(['ls-remote', '--heads', pushUrl, `refs/heads/${intent.candidateBranch}`]).trim();
      const remoteSha = remoteLine ? remoteLine.split(/\s+/)[0] : null;
      if (remoteSha && remoteSha !== intent.candidateSha) {
        refuse(CODES.REMOTE_BRANCH_CONFLICT, 'remote candidate branch already points at another commit', { remoteSha });
      }
      if (!remoteSha) {
        journal = assertJournalCurrent(intent, journal);
        assertNoSecondUrlRewrite(pushUrl);
        verifyAuthority(receipt);
        runGit(['push', '--porcelain', `--force-with-lease=refs/heads/${intent.candidateBranch}:`,
          pushUrl, `${intent.candidateSha}:refs/heads/${intent.candidateBranch}`]);
      }
      journal = saveJournal(runDir, intent, 'branch_pushed', journal.pr, journal);

      verifyAuthority(receipt);
      verifyBase(receipt, fetchUrl);
      let pr = journal.pr
        ? gh.readPr({ repo, number: journal.pr.number })
        : gh.findPr({ repo, head: intent.candidateBranch });
      if (pr) validatePr(pr, receipt);
      if (!pr) {
        journal = assertJournalCurrent(intent, journal);
        verifyAuthority(receipt);
        pr = gh.createPr({
          repo, head: intent.candidateBranch, base: intent.baseBranch,
          title: `Factory candidate: ${intent.candidateBranch}`,
          body: `Factory run receipt: ${intent.receiptDigest}\nCandidate: ${intent.candidateSha}`,
        });
      }
      validatePr(pr, receipt);
      pr = gh.readPr({ repo, number: pr.number });
      validatePr(pr, receipt);
      journal = saveJournal(runDir, intent, 'pr_open', pr, journal);

      verifyAuthority(receipt);
      verifyBase(receipt, fetchUrl);
      pr = gh.readPr({ repo, number: pr.number });
      validatePr(pr, receipt);
      if (journal.stage === 'pr_open') {
        journal = saveJournal(runDir, intent, 'status_pending', pr, journal, randomToken());
      }
      const description = `receipt ${intent.receiptDigest} nonce ${journal.statusNonce}`.slice(0, 140);
      const statuses = gh.readStatuses({ repo, sha: intent.candidateSha });
      const currentStatus = statuses.find((status) => status.context === STATUS_CONTEXT);
      const exactStatus = currentStatus
        && currentStatus.state === 'success'
        && currentStatus.description === description
        && currentStatus.target_url === pr.url;
      if (currentStatus && !exactStatus) {
        refuse(CODES.STATUS_CONFLICT, 'the exact candidate already has a conflicting factory-run-receipt status');
      }
      if (!currentStatus) {
        if (journal.stage === 'delivered') {
          refuse(CODES.STATUS_CONFLICT, 'delivered journal exists but its exact receipt status is missing');
        }
        journal = assertJournalCurrent(intent, journal);
        verifyAuthority(receipt);
        gh.publishStatus({ repo, sha: intent.candidateSha, state: 'success', description, targetUrl: pr.url });
      }
      const confirmed = gh.readStatuses({ repo, sha: intent.candidateSha })
        .find((status) => status.context === STATUS_CONTEXT);
      if (!confirmed || confirmed.state !== 'success'
        || confirmed.description !== description || confirmed.target_url !== pr.url) {
        refuse(CODES.STATUS_CONFLICT, 'the exact receipt status could not be verified after publication');
      }
      journal = saveJournal(runDir, intent, 'delivered', pr, journal);
      return {
        outcome: 'delivered', replayed: Boolean(prior), runId: intent.runId,
        repo, candidateBranch: intent.candidateBranch, candidateSha: intent.candidateSha,
        receiptDigest: intent.receiptDigest, statusContext: STATUS_CONTEXT,
        pr: { number: pr.number, url: pr.url }, journal,
      };
    });
  }

  return { deliver, statusContext: STATUS_CONTEXT };
}

module.exports = {
  STATUS_CONTEXT,
  DELIVERY_DIR,
  CODES,
  ReceiptEgressError,
  parseOriginRepo,
  createGithubAdapter,
  createReceiptEgress,
};
