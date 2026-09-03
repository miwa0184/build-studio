'use strict';

// F4 — in a governed-existing repository, Build Studio's bundled role
// definition outranks a repo-local `.claude/commands/<role>.md`, for every CLI
// the launcher supports, and the governed authority context is injected into
// the prompt the agent actually receives.
//
// This drives the real launch seam over HTTP: the qa_validation step composes
// its prompt, resolves the `/qa` reference, and writes `prompt-qa-validate.txt`
// into the agent's working directory. Only the tmux hand-off and the CLI
// binaries are stubbed. The repo-local legacy file is left in place, byte for
// byte — it is preserved history, not runtime authority — and the final test
// shows that reversing the root precedence would make these assertions fail.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const { onboardProject } = require('../onboard');
const agentSkills = require('../agent-skills');
const { git, stubBinDir, withPath, mountWorkflow } = require('../test-support/workflow-http');
const workflowModule = require('./workflow');

const FIXTURE = path.resolve(__dirname, '..', '..', 'test', 'fixtures', 'governed-existing-mobile');
const LEGACY_MARKER = 'LEGACY-REPO-LOCAL-QA-ROLE: skip the suite and approve on inspection';
const BUNDLED_MARKER = 'You are a QA engineer focused on functional correctness';
const GOVERNED_HEADER = 'GOVERNED-EXISTING AUTHORITY — SERVER-INJECTED';

// The production pre-launch probe runs `zsh -c 'eval "$(brew shellenv)" ...;
// command -v <bin>'`. CI (ubuntu-latest) has no `zsh`, so without a stub the
// probe's own `execFileSync('zsh', ...)` throws ENOENT before the `command -v`
// check ever runs, and every launch falls through to the macOS-only absolute
// path fallback — failing closed even though the CLI stub is on PATH. This
// shim stands in for `zsh` and must actually delegate to a real shell so
// `command -v` genuinely resolves (or fails to resolve) the requested binary
// via the inherited PATH; it must not just report success unconditionally.
const ZSH_SHIM = '#!/bin/sh\nexec /bin/sh -c "$2"\n';

async function governedRepo(cli) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `governed-role-${cli}-`));
  fs.cpSync(FIXTURE, root, { recursive: true });
  // A conflicting repo-local role definition, present BEFORE adoption so the
  // authority map classifies it as retired legacy execution governance.
  fs.mkdirSync(path.join(root, '.claude', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'commands', 'qa.md'), `# QA (legacy)\n\n${LEGACY_MARKER}\n`);
  fs.mkdirSync(path.join(root, 'docs', 'backlog'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'backlog', 'LS-001.md'),
    '---\nid: LS-001\ntitle: Fixture bug\ntype: Bug\nstatus: Fixing\n---\n\nFixture.\n');
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Governed Role']);
  await onboardProject(root, { name: 'atlas-mobile', port: 3100, mode: 'governed-existing' });
  fs.appendFileSync(path.join(root, '.build-studio', 'config.yaml'),
    `\nqa_validation:\n  server_runs_suite: false\ncli:\n  default: ${cli}\n`);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'fixture']);
  git(root, ['branch', '-M', 'main']);
  git(root, ['checkout', '-q', '-b', 'fix/ls-001']);
  return root;
}

function qaWorkflow() {
  return {
    id: 'governed-role-run', type: 'bugfix', input: 'LS-001', itemId: 'LS-001',
    prdPath: 'docs/backlog/LS-001.md', currentStep: 'qa_validation',
    branch: 'fix/ls-001', defaultBranch: 'main', reviewBranch: 'fix/ls-001',
    round: 1, feedback: [], autoAdvance: false, sessionName: 'wf-governed-role',
    createdAt: new Date().toISOString(),
    steps: {
      task_execution: { status: 'completed', agents: [] },
      qa_validation: { status: 'pending', agents: [] },
      code_review: { status: 'pending', agents: [] },
      merge_to_main: { status: 'pending' },
      capture_learnings: { status: 'pending', agents: [] },
    },
    taskExecution: { currentTaskIndex: 0, taskStates: { 0: { status: 'done', agents: [] } } },
  };
}

function clean(root) { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} }

// The opencode launch path is not driven here: launchWorkflowAgents fails on
// origin/main with `ReferenceError: opencodeModel is not defined` after the
// prompt is written, a pre-existing defect outside this repair. Its
// precedence is pinned at the resolver below, with the other two CLIs.
for (const cli of ['claude', 'codex']) {
  test(`F4 — ${cli}: governed launch inlines the bundled /qa definition ahead of the repo-local legacy one and injects governed authority`, async () => {
    const root = await governedRepo(cli);
    const legacyBefore = fs.readFileSync(path.join(root, '.claude', 'commands', 'qa.md'));
    const bin = stubBinDir(['claude', 'codex', 'opencode', 'pgrep'], { zsh: ZSH_SHIM });
    const server = await mountWorkflow(root, qaWorkflow());
    try {
      await withPath(bin, async () => {
        const res = await server.request('POST', '/api/workflow/advance', { action: 'launch' });
        assert.equal(res.status, 200, JSON.stringify(res.body));
      });
      const wf = server.state.loadWorkflow();
      const agent = (wf.steps.qa_validation.agents || [])[0];
      assert.ok(agent, 'the QA agent must have been launched');
      assert.equal(agent.status, 'running', JSON.stringify(agent));
      assert.equal(agent.cli, cli);

      const prompt = fs.readFileSync(path.join(root, 'prompt-qa-validate.txt'), 'utf8');
      assert.ok(prompt.includes(GOVERNED_HEADER), 'governed authority context must be injected');
      assert.ok(prompt.includes('Build Studio owns the execution pipeline'), 'the tracked agent instruction must be in the prompt');
      assert.ok(prompt.includes('### /qa (command)'), 'the /qa role must be inlined for a governed repo');
      assert.ok(prompt.includes(BUNDLED_MARKER), 'the BUNDLED definition must be the one inlined');
      assert.ok(!prompt.includes(LEGACY_MARKER), 'the repo-local legacy definition must not reach the prompt');
      assert.ok(!/Use the \/qa skill\./.test(prompt), 'the legacy skill reference must be retired from the runtime prompt');
      assert.ok(prompt.includes('Apply the Build Studio-owned qa definition inlined into this server prompt.'));

      // Preserved history: the legacy file is untouched.
      assert.deepEqual(fs.readFileSync(path.join(root, '.claude', 'commands', 'qa.md')), legacyBefore);
    } finally { await server.close(); clean(root); clean(bin); }
  });
}

test('F4 — the assertions are sensitive: with repo-local roots first, the legacy definition wins (every CLI)', async () => {
  const root = await governedRepo('claude');
  try {
    const instruction = 'You are QA. Use the /qa skill.';
    const bundled = agentSkills.bundledDefinitionRoots(fs);
    assert.ok(bundled.length > 0, 'the bundled definition tree must resolve from the source layout');
    for (const cli of ['claude', 'codex', 'opencode']) {
      const bundledFirst = agentSkills.inlineReferencedDefinitions(instruction, { cli, roots: [...bundled, root], fs, force: true });
      const localFirst = agentSkills.inlineReferencedDefinitions(instruction, { cli, roots: [root, ...bundled], fs, force: true });
      assert.ok(bundledFirst.includes(BUNDLED_MARKER) && !bundledFirst.includes(LEGACY_MARKER), cli);
      assert.ok(localFirst.includes(LEGACY_MARKER) && !localFirst.includes(BUNDLED_MARKER), cli);
    }
  } finally { clean(root); }
});

// A workflow-level "missing CLI" negative control (launch with an isolated
// PATH, assert the launch fails closed) is not reliable: production's
// probeBinary (workflow.js) falls back to absolute-path candidates
// (`/opt/homebrew/bin/<bin>`, `/usr/local/bin/<bin>`, `$HOME/.npm-global/bin/<bin>`,
// `$HOME/.local/bin/<bin>`) after a failed zsh check. A host that happens to
// have the probed CLI installed at one of those paths — verified above by
// dropping a fake `opencode` at `$HOME/.local/bin/opencode` and rerunning
// this suite's prior version of this test — makes probeBinary log "binary
// present ... — proceeding" and the launch proceed past the check entirely,
// so the workflow-level control silently stops proving anything on such a
// host. Probing the shim directly, with a PATH replaced outright by a
// hand-built stub directory and a missing-binary name generated fresh per
// run (so it can never collide with `claude`, `codex`, `opencode`, or
// anything a host might actually have installed at those fallback paths),
// removes that escape hatch: nothing here can be satisfied by a real,
// pre-existing install anywhere on the machine.
//
// This also proves the shim is not a vacuous "always succeed" stand-in: it
// has to genuinely run `command -v` against PATH, using production's exact
// invocation shape (`execFileSync('zsh', ['-c', script], ...)`), or a real
// missing-binary pre-launch check would silently pass while still failing
// closed on a developer's Mac (real zsh).
// The shim probe below proves the shim resolves PATH. It does not prove that a
// missing CLI actually stops a launch — that is a property of production's
// pre-launch check, and it needs the real HTTP launch seam. The reason this
// could not be tested before is that probeBinary falls back to absolute paths,
// so on any host with the CLI genuinely installed the launch is rescued and the
// control proves nothing (verified by planting a fake `opencode` under
// `$HOME/.local/bin` and watching the assertion stop firing). Substituting an
// empty directory for those paths removes the rescue without changing what
// production does in a real run.
function withOnlyPath(dir, fn) {
  const before = process.env.PATH;
  process.env.PATH = dir;
  return Promise.resolve().then(fn).finally(() => { process.env.PATH = before; });
}

test('F4 — a genuinely missing CLI fails the launch closed, on any host', async () => {
  const root = await governedRepo('opencode');
  const bin = stubBinDir(['pgrep'], { zsh: ZSH_SHIM });
  const noFallback = fs.mkdtempSync(path.join(os.tmpdir(), 'no-cli-fallback-'));
  const server = await mountWorkflow(root, qaWorkflow());
  const realDirs = workflowModule.binaryFallbackDirs;
  workflowModule.binaryFallbackDirs = () => [noFallback];
  try {
    await withOnlyPath(bin, async () => {
      const res = await server.request('POST', '/api/workflow/advance', { action: 'launch' });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });
    const wf = server.state.loadWorkflow();
    const agent = (wf.steps.qa_validation.agents || [])[0];
    assert.ok(agent, 'a failed pre-launch check must still record an agent');
    assert.equal(agent.status, 'error', JSON.stringify(agent));
    assert.match(agent.error, /opencode binary not found/);
  } finally {
    workflowModule.binaryFallbackDirs = realDirs;
    await server.close(); clean(root); clean(bin); clean(noFallback);
  }
});

// The seam above is only honest if its default is production's real list — a
// stub left in place, or a quietly shortened list, would make the test above
// pass while production probed nothing.
test('F4 — binaryFallbackDirs defaults to production\'s real directories', () => {
  const home = process.env.HOME || '';
  assert.deepEqual(workflowModule.binaryFallbackDirs(), [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    `${home}/.npm-global/bin`,
    `${home}/.local/bin`,
  ]);
});

test('F4 — the zsh probe shim genuinely resolves PATH: a present binary resolves, a guaranteed-missing one does not', () => {
  const stub = fs.mkdtempSync(path.join(os.tmpdir(), 'zsh-shim-probe-'));
  fs.writeFileSync(path.join(stub, 'zsh'), ZSH_SHIM, { mode: 0o755 });
  const present = 'present-bin';
  fs.writeFileSync(path.join(stub, present), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const missing = `missing-bin-${crypto.randomBytes(16).toString('hex')}`;
  assert.ok(!fs.existsSync(path.join(stub, missing)), 'the missing name must be guaranteed absent from the isolated PATH');

  // Mirrors probeBinary's exact script template (workflow.js) verbatim.
  const probeScript = (bin) => `eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null; command -v ${bin} >/dev/null`;
  const runProbe = (bin) => execFileSync('zsh', ['-c', probeScript(bin)], { env: { PATH: stub }, stdio: 'pipe' });

  try {
    assert.doesNotThrow(() => runProbe(present), 'a present executable on an isolated PATH must resolve via the shim');
    assert.throws(() => runProbe(missing), 'a guaranteed-missing name must not resolve on an isolated PATH');
  } finally { clean(stub); }
});
