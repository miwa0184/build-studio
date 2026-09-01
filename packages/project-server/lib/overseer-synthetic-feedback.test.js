'use strict';

// F5, behavioural — drives the real forceCompleteTaskAgent / killAndSkipTaskAgent
// against an in-memory state manager. The tmux and loopback-HTTP calls inside
// both functions are already failure-tolerant (they swallow their own errors),
// so they run in-process with no session and no server.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createOverseer } = require('./overseer');
const { registerTestRoot } = require('./test-support/root-aggregate');

// Provenance values are asserted as literals here so this file exercises the
// real overseer on its own and fails on behaviour, not on a missing module.
// feedback-provenance.js pins the vocabulary itself.
const OPERATOR_FORCE_COMPLETE = 'operator_force_complete';
const OPERATOR_KILL_SKIP = 'operator_kill_skip';

function harness() {
  const wf = {
    id: 'run-a',
    type: 'execution',
    input: 'PRD-001',
    sessionName: 'bs-test',
    currentStep: 'task_execution',
    round: 1,
    steps: { task_execution: { status: 'running', agents: [] } },
    taskPlan: { tasks: [{ name: 'Auth screen' }, { name: 'Sync engine' }] },
    taskExecution: {
      currentTaskIndex: 0,
      taskStates: {
        0: { status: 'running', fixCycles: 0, agents: [{ role: 'iOS Dev', window: 't1-ios', status: 'running', taskIndex: 0 }] },
        1: { status: 'pending', fixCycles: 0, agents: [] },
      },
    },
  };
  const state = {
    loadWorkflow: () => JSON.parse(JSON.stringify(wf)),
    saveWorkflow: (next) => { Object.assign(wf, JSON.parse(JSON.stringify(next))); },
  };
  // A writable statePath: parking a run now writes the run guard through the
  // state authority boundary, and an unwritable guard correctly FAILS the
  // operator action instead of being swallowed. That failure mode has its own
  // test (state-authority.test.js R20); this file tests provenance.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-feedback-'));
  const config = { projectRoot: root, statePath: path.join(root, '.build-studio'), port: 0 };
  const overseer = createOverseer(config, state, () => {});
  registerTestRoot({ statePath: config.statePath, runId: wf.id, guard: state.runGuard });
  return { wf, overseer };
}

test('force-complete records operator provenance and never writes an approval marker', () => {
  const { wf, overseer } = harness();
  const r = overseer.forceCompleteTaskAgent('t1-ios');
  assert.equal(r.ok, true, r.error);

  const agent = wf.taskExecution.taskStates['0'].agents[0];
  assert.equal(agent.feedbackProvenance, OPERATOR_FORCE_COMPLETE);
  assert.doesNotMatch(agent.feedback, /\*\*Approved:\*\*\s*yes/i);
  assert.match(agent.feedback, /technical_override|force_completed/i);
});

test('force-complete does not mark the task verified done', () => {
  const { wf, overseer } = harness();
  overseer.forceCompleteTaskAgent('t1-ios');
  const ts = wf.taskExecution.taskStates['0'];
  assert.notEqual(ts.status, 'done');
  assert.equal(ts.forceCompleted, true);
  assert.equal(ts.acceptanceCovered, false);
});

test('kill-and-skip marks the task skipped, not done, and blocks its acceptance coverage', () => {
  const { wf, overseer } = harness();
  const r = overseer.killAndSkipTaskAgent('t1-ios');
  assert.equal(r.ok, true, r.error);

  const ts = wf.taskExecution.taskStates['0'];
  assert.equal(ts.status, 'skipped');
  assert.notEqual(ts.status, 'done');
  assert.equal(ts.acceptanceCovered, false);

  const agent = ts.agents[0];
  assert.equal(agent.feedbackProvenance, OPERATOR_KILL_SKIP);
  assert.doesNotMatch(agent.feedback, /\*\*Approved:\*\*\s*yes/i);
});

test('both operator actions raise a technical incident rather than clearing the record', () => {
  const { wf, overseer } = harness();
  overseer.forceCompleteTaskAgent('t1-ios');
  const incidents = (wf.overseer && wf.overseer.incidents) || [];
  assert.ok(incidents.length >= 1, 'expected an incident recording the override');
  assert.ok(incidents.some((i) => i.principal === 'technical' || i.principal === 'orchestrator'));
});
