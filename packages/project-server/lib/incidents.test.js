'use strict';

// F6 — the escalation mutex.
//
// `overseer.pendingEscalation` is a single slot, and every detector after the
// first is written `if (!overseer.pendingEscalation)`. One agent hitting a usage
// limit therefore made the overseer blind to a merge conflict, a missing
// node_modules, a step loop, and every other agent's wallclock overrun — for as
// long as nobody dismissed the banner.
//
// Incidents replace it: independent, deduplicated, several open at once.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  PRINCIPALS,
  SEVERITIES,
  createIncident,
  openIncident,
  resolveIncident,
  openIncidents,
  findIncident,
} = require('./incidents');

const base = {
  runId: 'run-a',
  symptom: 'usage-limit-t3-ios',
  principal: PRINCIPALS.TECHNICAL,
  severity: SEVERITIES.WARNING,
  step: 'task_execution',
  agent: 't3-ios',
  task: '3',
  description: 'iOS Dev hit a usage limit and stopped.',
  allowedRecoveryAction: 'nudge-agent',
};

test('an incident carries the full model', () => {
  const inc = createIncident(base);
  assert.ok(inc.id);
  assert.equal(inc.runId, 'run-a');
  assert.equal(inc.symptom, 'usage-limit-t3-ios');
  assert.equal(inc.principal, 'technical');
  assert.equal(inc.severity, 'warning');
  assert.equal(inc.step, 'task_execution');
  assert.equal(inc.agent, 't3-ios');
  assert.equal(inc.task, '3');
  assert.equal(inc.status, 'open');
  assert.ok(inc.createdAt);
  assert.equal(inc.resolvedAt, null);
  assert.equal(inc.allowedRecoveryAction, 'nudge-agent');
});

test('two independent symptoms are both open at the same time — no mutex', () => {
  let list = [];
  list = openIncident(list, base);
  list = openIncident(list, {
    ...base,
    symptom: 'package-lock-conflict',
    agent: null,
    task: null,
    allowedRecoveryAction: 'resolve-conflict',
  });
  assert.equal(openIncidents(list).length, 2);
});

test('two agents with the same symptom class are separate incidents', () => {
  let list = [];
  list = openIncident(list, { ...base, symptom: 'wallclock-t3', agent: 't3-ios' });
  list = openIncident(list, { ...base, symptom: 'wallclock-t7', agent: 't7-backend' });
  const open = openIncidents(list);
  assert.equal(open.length, 2);
  assert.deepEqual(open.map((i) => i.agent).sort(), ['t3-ios', 't7-backend']);
});

test('the same symptom raised twice while open does not duplicate', () => {
  let list = [];
  list = openIncident(list, base);
  list = openIncident(list, base);
  assert.equal(openIncidents(list).length, 1);
});

test('resolving one incident leaves the others open', () => {
  let list = [];
  list = openIncident(list, base);
  list = openIncident(list, { ...base, symptom: 'package-lock-conflict', agent: null });
  list = resolveIncident(list, 'usage-limit-t3-ios');
  const open = openIncidents(list);
  assert.equal(open.length, 1);
  assert.equal(open[0].symptom, 'package-lock-conflict');
  const resolved = findIncident(list, 'usage-limit-t3-ios');
  assert.equal(resolved.status, 'resolved');
  assert.ok(resolved.resolvedAt);
});

test('a resolved symptom can be raised again as a fresh open incident', () => {
  let list = [];
  list = openIncident(list, base);
  list = resolveIncident(list, base.symptom);
  list = openIncident(list, base);
  assert.equal(openIncidents(list).length, 1);
});

test('principal must be one of orchestrator | technical | founder', () => {
  assert.deepEqual(
    Object.values(PRINCIPALS).sort(),
    ['founder', 'orchestrator', 'technical'],
  );
  assert.throws(() => createIncident({ ...base, principal: 'robot' }), /principal/);
});
