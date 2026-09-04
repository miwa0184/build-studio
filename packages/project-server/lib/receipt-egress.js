'use strict';

/**
 * Receipt-backed PR egress. It can publish one frozen candidate branch, open
 * one exact PR, and attach one exact-SHA commit status. It cannot merge, tag,
 * deploy, force-push, or delete a branch.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { writeAtomic, digest, exactKeys, safeRunId } = require('./authority-store');

const STATUS_CONTEXT = 'factory-run-receipt';
const DELIVERY_DIR = path.join('run-receipt', 'egress');
const SHA_RE = /^[0-9a-f]{40}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^(?!.*\.\.)(?!\/)(?!.*\/$)[A-Za-z0-9._/-]+$/;
const JOURNAL_STAGES = new Set(['prepared', 'branch_pushed', 'pr_open', 'delivered']);
const JOURNAL_STAGE_RANK = new Map([...JOURNAL_STAGES].map((stage, index) => [stage, index]));
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
    findOpenPr({ repo, head }) {
      const rows = json(run(['pr', 'list', '--repo', repo, '--state', 'open', '--head', head,
        '--json', 'number,url,state,headRefName,headRefOid,baseRefName', '--limit', '2'])) || [];
      if (rows.length > 1) refuse(CODES.PR_CONFLICT, `more than one open PR targets branch ${head}`);
      return rows[0] || null;
    },
    createPr({ repo, head, base, title, body }) {
      run(['pr', 'create', '--repo', repo, '--head', head, '--base', base, '--title', title, '--body', body]);
      return this.findOpenPr({ repo, head });
    },
    readPr({ repo, number }) {
      return json(run(['pr', 'view', String(number), '--repo', repo,
        '--json', 'number,url,state,headRefName,headRefOid,baseRefName']));
    },
    readStatuses({ repo, sha }) {
      // GitHub returns newest-first. One page is sufficient because this
      // context is written at most once per exact receipt delivery.
      return json(run(['api', '--method', 'GET', `repos/${repo}/commits/${sha}/statuses`, '-f', 'per_page=100'])) || [];
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
    || pr.baseRefName !== receipt.candidate.base.branch) {
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

function validateJournal(doc, intent) {
  if (!doc || !exactKeys(doc, [...Object.keys(intent), 'intentDigest', 'revision', 'stage', 'pr', 'updatedAt'])
    || doc.intentDigest !== digest(intent)
    || Object.keys(intent).some((key) => doc[key] !== intent[key])
    || !Number.isInteger(doc.revision) || doc.revision < 1
    || !JOURNAL_STAGES.has(doc.stage)
    || typeof doc.updatedAt !== 'string'
    || (doc.pr !== null && (!exactKeys(doc.pr, ['number', 'url'])
      || !Number.isInteger(doc.pr.number) || typeof doc.pr.url !== 'string'))) {
    refuse(CODES.JOURNAL_CONFLICT, `run ${intent.runId} has a delivery journal for different evidence`);
  }
  return doc;
}

function createReceiptEgress({ config, receiptAuthority, git, github, now = () => new Date() } = {}) {
  if (!config || !config.projectRoot || !receiptAuthority) throw new Error('createReceiptEgress requires config and receiptAuthority');
  const runGit = git || defaultGit(config.projectRoot);
  const gh = github || createGithubAdapter();
  const journalDir = path.join(config.statePath || path.join(config.projectRoot, '.build-studio'), DELIVERY_DIR);

  function loadJournal(intent) {
    if (fs.existsSync(journalDir) && fs.lstatSync(journalDir).isSymbolicLink()) {
      refuse(CODES.JOURNAL_CONFLICT, 'delivery journal directory must not be a symbolic link');
    }
    const file = path.join(journalDir, `${safeRunId(intent.runId)}.json`);
    if (!fs.existsSync(file)) return { file, doc: null };
    if (fs.lstatSync(file).isSymbolicLink()) {
      refuse(CODES.JOURNAL_CONFLICT, `delivery journal for ${intent.runId} must not be a symbolic link`);
    }
    try {
      return { file, doc: validateJournal(JSON.parse(fs.readFileSync(file, 'utf8')), intent) };
    } catch (error) {
      if (error instanceof ReceiptEgressError) throw error;
      refuse(CODES.JOURNAL_CONFLICT, `delivery journal for ${intent.runId} is unreadable: ${error.message}`);
    }
  }

  function saveJournal(file, intent, stage, pr, prior = null) {
    if (prior && JOURNAL_STAGE_RANK.get(prior.stage) >= JOURNAL_STAGE_RANK.get(stage)) return prior;
    const doc = {
      ...intent,
      intentDigest: digest(intent),
      revision: prior ? prior.revision + 1 : 1,
      stage,
      pr: pr ? { number: pr.number, url: pr.url } : null,
      updatedAt: now().toISOString(),
    };
    writeAtomic(file, doc);
    return doc;
  }

  function preflight(receipt, expectedSha) {
    if (!receipt || expectedSha !== receipt.candidate.sha || receipt.candidate.heldSha !== expectedSha) {
      refuse(CODES.CANDIDATE_DRIFT, 'expectedSha does not match the immutable receipt candidate');
    }
    if (!SHA_RE.test(expectedSha) || !BRANCH_RE.test(receipt.candidate.branch)) {
      refuse(CODES.CANDIDATE_DRIFT, 'receipt candidate identity is invalid');
    }
    const repo = config.deployment && config.deployment.repo;
    if (!REPO_RE.test(repo || '')) refuse(CODES.CONFIG, 'deployment.repo must be an owner/repo value');
    if (receipt.identity.admittedRepo !== repo) {
      refuse(CODES.REPO_MISMATCH, 'deployment.repo does not match the admitted repository');
    }
    const originRepo = parseOriginRepo(runGit(['remote', 'get-url', 'origin']));
    if (!originRepo || originRepo.toLowerCase() !== repo.toLowerCase()) {
      refuse(CODES.REPO_MISMATCH, 'origin does not point at the admitted deployment repository');
    }
    const tracked = runGit(['status', '--porcelain', '--untracked-files=no']);
    if (tracked.trim()) refuse(CODES.WORKTREE_DIRTY, 'tracked worktree changes exist at PR egress');
    const repoView = gh.inspectRepo(repo);
    if (!repoView || String(repoView.nameWithOwner).toLowerCase() !== repo.toLowerCase()
      || repoView.defaultBranch !== receipt.candidate.base.branch
      || !['ADMIN', 'MAINTAIN', 'WRITE'].includes(repoView.permission)) {
      refuse(CODES.REPO_MISMATCH, 'GitHub repository identity, default branch, or write authority does not match the receipt');
    }
    runGit(['fetch', '--quiet', 'origin',
      `refs/heads/${receipt.candidate.base.branch}:refs/remotes/origin/${receipt.candidate.base.branch}`]);
    const baseSha = runGit(['rev-parse', '--verify', `refs/remotes/origin/${receipt.candidate.base.branch}^{commit}`]).trim();
    if (baseSha !== receipt.candidate.base.sha) {
      refuse(CODES.BASE_DRIFT, 'remote default branch moved after the candidate evidence was frozen', {
        expectedBaseSha: receipt.candidate.base.sha, actualBaseSha: baseSha,
      });
    }
    const localSha = runGit(['rev-parse', '--verify', `${expectedSha}^{commit}`]).trim();
    if (localSha !== expectedSha) refuse(CODES.CANDIDATE_DRIFT, 'the exact candidate object is not available locally');
    return repo;
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
      const repo = preflight(receipt, body.expectedSha);
      const intent = deliveryIntent(receipt, repo);
      const { file, doc: prior } = loadJournal(intent);
      let journal = prior || saveJournal(file, intent, 'prepared', null);

      const remoteLine = runGit(['ls-remote', '--heads', 'origin', `refs/heads/${intent.candidateBranch}`]).trim();
      const remoteSha = remoteLine ? remoteLine.split(/\s+/)[0] : null;
      if (remoteSha && remoteSha !== intent.candidateSha) {
        refuse(CODES.REMOTE_BRANCH_CONFLICT, 'remote candidate branch already points at another commit', { remoteSha });
      }
      if (!remoteSha) {
        runGit(['push', 'origin', `${intent.candidateSha}:refs/heads/${intent.candidateBranch}`]);
      }
      journal = saveJournal(file, intent, 'branch_pushed', journal.pr, journal);

      let pr = journal.pr
        ? gh.readPr({ repo, number: journal.pr.number })
        : gh.findOpenPr({ repo, head: intent.candidateBranch });
      if (pr) validatePr(pr, receipt);
      if (!pr) {
        pr = gh.createPr({
          repo, head: intent.candidateBranch, base: intent.baseBranch,
          title: `Factory candidate: ${intent.candidateBranch}`,
          body: `Factory run receipt: ${intent.receiptDigest}\nCandidate: ${intent.candidateSha}`,
        });
      }
      validatePr(pr, receipt);
      pr = gh.readPr({ repo, number: pr.number });
      validatePr(pr, receipt);
      journal = saveJournal(file, intent, 'pr_open', pr, journal);

      const description = `receipt ${intent.receiptDigest.slice(0, 16)} · run ${intent.runId}`.slice(0, 140);
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
        gh.publishStatus({ repo, sha: intent.candidateSha, state: 'success', description, targetUrl: pr.url });
      }
      journal = saveJournal(file, intent, 'delivered', pr, journal);
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
