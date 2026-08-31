'use strict';

/**
 * Is task_execution allowed to finish?
 *
 * The old answer was accidental. `launchNextTask` looked for the next task with
 * status `pending`; if it found none, every task was assumed done and the step
 * was marked completed. But a task that exhausted its fix cycles was set to
 * `blocked` — which is also not `pending`. So the search came up empty for the
 * wrong reason, the step reported completed, and the run advanced to
 * merge_for_review carrying code a reviewer had refused three times running.
 * Nothing downstream ever re-read the task states, so the refusal simply
 * vanished.
 *
 * This module is the explicit answer that replaces the accident: ask what the
 * task states actually say, and let `blocked` be terminal. No downstream review
 * substitutes for this gate — code_review runs on the merged branch, which is
 * exactly the thing that must not be produced.
 *
 * Two failure shapes, deliberately kept apart:
 *
 *   blocked  — the engine could not finish the task. Fail closed: TECHNICAL_STOP.
 *   skipped  — an operator chose to abandon it. The step may finish (the person
 *              decided), but the task's acceptance coverage stays unmet, so
 *              nothing can later claim it was verified.
 */

const { createTechnicalStop, REASON_CODES } = require('./technical-stop');

/** Task statuses that stop the step. `error` is here for the same reason `blocked` is. */
const BLOCKING_STATUSES = ['blocked', 'error'];

/** Statuses that finish a task without verifying it. */
const UNVERIFIED_STATUSES = ['skipped', 'aborted'];

function taskStatesOf(wf) {
  return (wf && wf.taskExecution && wf.taskExecution.taskStates) || {};
}

function taskNameAt(wf, index) {
  const tasks = (wf && wf.taskPlan && wf.taskPlan.tasks) || [];
  const t = tasks[index];
  return (t && (t.name || t.title)) || `task ${index + 1}`;
}

/** Indices are numeric even though taskStates is keyed by string. */
function orderedIndices(wf) {
  return Object.keys(taskStatesOf(wf))
    .map((k) => Number(k))
    .filter((n) => Number.isInteger(n) && n >= 0)
    .sort((a, b) => a - b);
}

/**
 * Every task that cannot complete — all of them, not the first.
 *
 * The outcome names each one because a run with three blocked tasks and a
 * message about one of them sends the reader back to the state file to find
 * the other two.
 */
function findBlockingTasks(wf) {
  const states = taskStatesOf(wf);
  const out = [];
  for (const i of orderedIndices(wf)) {
    const ts = states[String(i)];
    if (!ts || !BLOCKING_STATUSES.includes(ts.status)) continue;
    out.push({
      index: i,
      name: taskNameAt(wf, i),
      status: ts.status,
      reason: ts.blockedReason || ts.error || `task is ${ts.status}`,
    });
  }
  return out;
}

/**
 * Tasks that finished without being verified.
 *
 * An operator-skipped task and a force-completed one are both "the step moved
 * on without an agent verdict". They do not stop the step — a person made that
 * call — but they must stop anything downstream claiming the task's acceptance
 * criteria are covered.
 */
function findAcceptanceGaps(wf) {
  const states = taskStatesOf(wf);
  const out = [];
  for (const i of orderedIndices(wf)) {
    const ts = states[String(i)];
    if (!ts) continue;
    const unverified = UNVERIFIED_STATUSES.includes(ts.status)
      || ts.forceCompleted === true
      || ts.acceptanceCovered === false;
    if (!unverified) continue;
    out.push({
      index: i,
      name: taskNameAt(wf, i),
      status: ts.status,
      reason: ts.skipReason || ts.blockedReason
        || (ts.forceCompleted ? 'force-completed by operator — no agent verdict' : 'task was not verified'),
    });
  }
  return out;
}

/**
 * What task_execution should do next.
 *
 * @returns {{kind:'technical_stop', technicalStop:object}
 *          |{kind:'launch_next', nextIndex:number, acceptanceGaps:Array}
 *          |{kind:'complete', acceptanceGaps:Array}}
 *
 * A blocked task wins over remaining pending work: launching task 4 while task 2
 * is unrecoverable spends agent time on a run that cannot land.
 */
function taskExecutionOutcome(wf) {
  const blocking = findBlockingTasks(wf);
  const acceptanceGaps = findAcceptanceGaps(wf);

  if (blocking.length > 0) {
    return {
      kind: 'technical_stop',
      blockingTasks: blocking,
      acceptanceGaps,
      technicalStop: createTechnicalStop({
        reasonCode: REASON_CODES.BLOCKED_TASKS,
        runId: wf && wf.id,
        step: 'task_execution',
        tasks: blocking.map(({ index, name, reason }) => ({ index, name, reason })),
        evidence: blocking.map((t) => `taskStates.${t.index}.status=${t.status}`),
        recoveryHint:
          `Relaunch ${blocking.length === 1 ? 'the blocked task' : 'the blocked tasks'} `
          + `(${blocking.map((t) => `#${t.index + 1} ${t.name}`).join(', ')}) after addressing the review findings, `
          + 'or cancel the run. The workflow will not merge while a task is blocked.',
      }),
    };
  }

  const states = taskStatesOf(wf);
  const nextIndex = orderedIndices(wf).find((i) => states[String(i)] && states[String(i)].status === 'pending');
  if (nextIndex !== undefined) {
    return { kind: 'launch_next', nextIndex, acceptanceGaps };
  }

  return { kind: 'complete', acceptanceGaps };
}

/**
 * A transition guard for everything downstream of task_execution.
 *
 * task_execution is not the only door into merge — a manual advance, a restored
 * snapshot or a fix loop returning can all put the run on a later step. Each of
 * those asks here.
 */
function blocksTransition(wf) {
  const blocking = findBlockingTasks(wf);
  if (blocking.length === 0) return null;
  return taskExecutionOutcome(wf).technicalStop;
}

module.exports = {
  BLOCKING_STATUSES,
  UNVERIFIED_STATUSES,
  findBlockingTasks,
  findAcceptanceGaps,
  taskExecutionOutcome,
  blocksTransition,
};
