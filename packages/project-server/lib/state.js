const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { createRunGuard, RunGuardCorruptError, RunGuardMissingError } = require('./run-guard');
const { createAdmissionRegistry } = require('./admission-registry');
const {
  isTechnicalStop,
  applyToWorkflow,
  TerminalRunError,
  TechnicalStopPersistError,
} = require('./technical-stop');

function syncAgentStatus(wf, docsPath) {
  const statusFile = path.join(docsPath, 'agent-status.json');
  let existing = { agents: [] };
  try {
    if (fs.existsSync(statusFile)) {
      existing = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    }
  } catch (_) {}

  // Build a map of currently active agents from all workflow steps
  const activeAgents = new Map();
  for (const [stepKey, step] of Object.entries(wf.steps || {})) {
    if (!step.agents) continue;
    for (const agent of step.agents) {
      if (!agent.role) continue;
      const status = step.status === 'running' && (agent.status === 'running' || agent.status === 'pending')
        ? 'working'
        : agent.status === 'done' ? 'done'
        : agent.status === 'error' ? 'error'
        : null;
      if (status) {
        activeAgents.set(agent.role, {
          status,
          lastActivity: `${wf.type}/${stepKey} (round ${wf.round || 1})`,
          lastUpdated: wf.updatedAt || new Date().toISOString(),
        });
      }
    }
  }

  // Update existing agents, preserving those not in the workflow
  const updated = (existing.agents || []).map(a => {
    const active = activeAgents.get(a.role);
    if (active) {
      activeAgents.delete(a.role);
      return { ...a, ...active };
    }
    // Reset to idle if workflow is completed or deleted
    if (wf.currentStep === 'completed' && a.status !== 'idle') {
      return { ...a, status: 'idle' };
    }
    return a;
  });

  // Add any workflow agents not already in the roster
  for (const [role, info] of activeAgents) {
    updated.push({ role, ...info });
  }

  fs.writeFileSync(statusFile, JSON.stringify({ agents: updated }, null, 2));
}

const MAX_SNAPSHOTS = 10;

/**
 * The authority seam: make the run guard the source of terminal truth at the
 * point where workflow state is actually read and written.
 *
 * Before this existed, terminality depended on every individual caller — each
 * route, the timer, the overseer, the restore path — remembering to consult
 * the guard. None of them had to, because workflow-state.json was written
 * whole by whoever held an object: a stale copy that predated a stop loaded
 * as transitionable and saved over the stop, and POST /workflow/restore could
 * put a pre-stop snapshot back outright. The guard recorded the stop; nothing
 * ENFORCED it.
 *
 * This decorator wraps a persistence implementation so the enforcement is a
 * property of the boundary, for every current and future caller:
 *
 *   - loadWorkflow projects the guard's technicalStop onto whatever the file
 *     says, so a stopped run always LOADS stopped, however stale the file;
 *   - saveWorkflow re-applies the guard's stop before anything is written, so
 *     a stale copy can never persist a transitionable state over a terminal
 *     one — and mirrors a workflow-carried stop INTO the guard so it becomes
 *     durable whichever way the run acquired it;
 *   - a guard that exists but cannot be read fails CLOSED: loads carry a
 *     machine-readable `guardUnverifiable` marker and every save throws
 *     RunGuardCorruptError before touching disk;
 *   - a stop that cannot be WRITTEN to the guard is held as a pending stop in
 *     this process (still enforced on every load and save, flushed to the
 *     guard as soon as it can be) and reported to the caller as a typed
 *     TechnicalStopPersistError — never as success.
 *
 * Applied to the real state manager by createStateManager. The workflow router
 * and the overseer attach it to whatever `state` they were handed, so a test
 * double gets the same seam bound to the same statePath — one behaviour, even
 * when there are two objects. Attaching twice is a no-op.
 */
function attachStateAuthority(state, config) {
  if (state.runGuard) return state;
  const statePath = config.statePath || path.join(config.projectRoot || process.cwd(), '.build-studio');
  // The guard consults the admission registry so a REGISTERED run whose guard
  // file is missing fails closed (RUN_GUARD_MISSING) instead of loading as a
  // brand-new run with fresh budgets. An unregistered (pre-admission) run id
  // with no file keeps the old meaning: an in-memory empty document.
  const admissionRegistry = createAdmissionRegistry({ statePath });
  const runGuard = createRunGuard({ statePath, isRegistered: admissionRegistry.isRegistered });

  /** Stops that could not reach the guard yet, keyed by run id. */
  const pendingStops = new Map();

  /**
   * The terminal truth for a run: the guard's stop, else a pending one.
   * Throws RunGuardCorruptError when the guard exists but cannot be verified —
   * in that state the answer is not "no stop", it is "unknowable", and
   * everything that transitions state must stay closed.
   */
  function authoritativeStop(runId) {
    const doc = runGuard.load(runId);
    if (isTechnicalStop(doc.technicalStop)) {
      pendingStops.delete(String(runId));
      return doc.technicalStop;
    }
    return pendingStops.get(String(runId)) || null;
  }

  /** Write a stop into the guard; on failure remember it as pending. */
  function persistStopToGuard(runId, stop) {
    try {
      runGuard.mutate(runId, (doc) => {
        doc.technicalStop = stop;
        if (stop.tasks && stop.tasks.length) doc.blockingTasks = stop.tasks;
      });
      pendingStops.delete(String(runId));
      return null;
    } catch (e) {
      pendingStops.set(String(runId), stop);
      return e;
    }
  }

  const baseLoad = state.loadWorkflow.bind(state);
  state.loadWorkflow = function loadWorkflowWithAuthority() {
    const wf = baseLoad();
    if (!wf) return wf;
    try {
      const stop = authoritativeStop(wf.id);
      if (stop) applyToWorkflow(wf, stop);
    } catch (e) {
      if (!(e instanceof RunGuardCorruptError) && !(e instanceof RunGuardMissingError)) throw e;
      // Reads may still render; transitions may not. The advance route and the
      // auto-advance tick refuse on this marker, and every save fails closed.
      // RUN_GUARD_MISSING (a registered run whose guard file is gone) is the
      // same posture as corruption: the run's terminal truth is unknowable,
      // so it renders but never moves.
      wf.guardUnverifiable = { code: e.code, runId: String(wf.id), error: e.message };
    }
    return wf;
  };

  const baseSave = state.saveWorkflow.bind(state);
  state.saveWorkflow = function saveWorkflowWithAuthority(wf) {
    // Fail closed BEFORE anything is written: an unverifiable guard means the
    // run's terminal truth is unknowable, and no state may move on top of that.
    let stop = authoritativeStop(wf.id);
    if (!stop && isTechnicalStop(wf.technicalStop)) {
      // The workflow carries a stop the guard does not know yet — a restored
      // pre-boundary snapshot, or a run that was in flight when the stop
      // landed. Mirror it into the guard so a later stale copy cannot erase it.
      stop = wf.technicalStop;
      const err = persistStopToGuard(wf.id, stop);
      if (err) console.error(`[state] technical stop for run ${wf.id} is not yet durable in the run guard: ${err.message}`);
    } else if (stop && pendingStops.has(String(wf.id))) {
      // A pending stop rides every save until the guard accepts it.
      const err = persistStopToGuard(wf.id, stop);
      if (err) console.error(`[state] technical stop for run ${wf.id} is still not durable in the run guard: ${err.message}`);
    }
    if (stop) applyToWorkflow(wf, stop);
    // The load-side marker is diagnostic, not state — it must not persist and
    // then outlive a repaired guard.
    delete wf.guardUnverifiable;
    return baseSave(wf);
  };

  /**
   * The ONE write path for terminal truth: guard first, projection second,
   * and no silent degradation. Used by the workflow router's
   * applyTechnicalStop and the overseer's parkRun.
   *
   * Throws TechnicalStopPersistError when the guard could not take the stop.
   * The run is still non-transitionable — the stop is applied to `wf`, held
   * pending at this boundary, and re-applied on every subsequent load and
   * save — but the caller must surface the failure, because the stop is not
   * yet durable across a restart.
   */
  state.recordTechnicalStop = function recordTechnicalStop(wf, stop) {
    applyToWorkflow(wf, stop);
    const guardErr = persistStopToGuard(wf.id, stop);
    try {
      state.saveWorkflow(wf);
    } catch (e) {
      if (!guardErr) throw e;
    }
    if (guardErr) throw new TechnicalStopPersistError(stop, guardErr);
    return stop;
  };

  state.authoritativeStop = authoritativeStop;
  state.runGuard = runGuard;
  return state;
}

function createStateManager(config, broadcast) {
  const wfFile = path.join(config.statePath, 'workflow-state.json');
  const runFile = path.join(config.statePath, 'run-state.json');
  const snapshotsDir = path.join(config.statePath, 'snapshots');

  // Track last saved currentStep in memory to detect transitions
  let _lastStep = null;
  let _onCompleted = null;

  function snapshotWorkflow(wf) {
    try {
      fs.mkdirSync(snapshotsDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const name = `workflow-${wf.id || 'unknown'}-step-${wf.currentStep || 'unknown'}-${ts}.json`;
      fs.writeFileSync(path.join(snapshotsDir, name), JSON.stringify(wf, null, 2));

      // Prune oldest snapshots, keep at most MAX_SNAPSHOTS
      const files = fs.readdirSync(snapshotsDir)
        .filter(f => f.endsWith('.json'))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(snapshotsDir, f)).mtimeMs }))
        .sort((a, b) => a.mtime - b.mtime);
      for (const old of files.slice(0, Math.max(0, files.length - MAX_SNAPSHOTS))) {
        try { fs.unlinkSync(path.join(snapshotsDir, old.name)); } catch (_) {}
      }
    } catch (_) {}
  }

  /** The raw file, no authority projection — internal use only. */
  function readWorkflowFile() {
    if (!fs.existsSync(wfFile)) return null;
    try { return JSON.parse(fs.readFileSync(wfFile, 'utf8')); } catch (_) { return null; }
  }

  const manager = {
    loadWorkflow() {
      const wf = readWorkflowFile();
      if (wf) _lastStep = wf.currentStep;
      return wf;
    },

    registerCompletionHook(fn) {
      _onCompleted = fn;
    },

    saveWorkflow(wf) {
      // Snapshot before each step transition so any past step can be restored
      if (wf.currentStep !== _lastStep) {
        snapshotWorkflow(wf);
        if (wf.currentStep === 'completed' && _lastStep !== 'completed' && _onCompleted) {
          try { _onCompleted(wf); } catch (e) { console.error('[state] completion hook failed:', e.message); }
        }
        _lastStep = wf.currentStep;
      }
      wf.updatedAt = new Date().toISOString();
      // A unique temp name per write. The constant `.tmp` is not known to have
      // corrupted anything in normal single-process operation — the rename is
      // what makes the swap atomic, and that part was already right — but two
      // writers meeting on one path is a hazard worth not having. The real
      // lost-update problem (a stale whole-object save rolling back guard
      // state) is fixed by moving that state out of here entirely: see
      // run-guard.js, and the authority seam above that re-applies the guard's
      // terminal stop before this raw write ever runs.
      const tmp = `${wfFile}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(wf, null, 2));
      fs.renameSync(tmp, wfFile);
      syncAgentStatus(wf, config.docsPath);
      broadcast('workflow-updated', {});
    },

    deleteWorkflow() {
      _lastStep = null;
      if (fs.existsSync(wfFile)) fs.unlinkSync(wfFile);
      broadcast('workflow-updated', {});
    },

    listSnapshots() {
      if (!fs.existsSync(snapshotsDir)) return [];
      return fs.readdirSync(snapshotsDir)
        .filter(f => f.endsWith('.json'))
        .sort()
        .reverse()
        .map(f => ({
          file: f,
          mtime: fs.statSync(path.join(snapshotsDir, f)).mtime,
        }));
    },

    /**
     * Read a snapshot. A READ: no write to workflow state, no step-tracker
     * movement, no agent-status sync, no broadcast, no restore marker.
     *
     * This exists because the statistics route used to read snapshots through
     * restoreSnapshot — a write path — so "show me token usage" was one field
     * name away from replacing the live workflow with each snapshot it summed.
     */
    readSnapshot(filename) {
      const snapshotPath = path.join(snapshotsDir, path.basename(String(filename)));
      if (!fs.existsSync(snapshotPath)) throw new Error(`Snapshot not found: ${filename}`);
      return JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    },

    /**
     * Replace the live workflow with a snapshot — a WRITE, and therefore
     * subject to the same authority boundary as every other write.
     *
     * Refused outright (TerminalRunError, before any mutation) when the
     * ACTIVE run's guard holds a technical stop: a terminal run may not be
     * rolled back to a pre-stop state of itself, and may not be replaced by a
     * different run's snapshot either — the stop, and the acceptance gap
     * behind it, would vanish with it. A refused restore leaves the workflow
     * file, the guard, agent status and broadcasts untouched.
     *
     * An allowed restore goes through saveWorkflow, so the restored run's OWN
     * guard is consulted too: restoring a snapshot of a stopped run yields a
     * stopped workflow, whatever the snapshot says.
     */
    restoreSnapshot(filename) {
      const snap = manager.readSnapshot(filename);
      const active = readWorkflowFile();
      if (active) {
        const activeStop = manager.authoritativeStop(active.id);
        if (activeStop) throw new TerminalRunError(activeStop);
      }
      snap._restoredFrom = path.basename(String(filename));
      // A restore is not a step transition — do not snapshot it as one.
      _lastStep = snap.currentStep;
      manager.saveWorkflow(snap);
      return snap;
    },

    loadRun() {
      if (!fs.existsSync(runFile)) return null;
      try { return JSON.parse(fs.readFileSync(runFile, 'utf8')); } catch (_) { return null; }
    },

    saveRun(run) {
      fs.writeFileSync(runFile, JSON.stringify(run, null, 2));
      broadcast('run-state-updated', {});
    },

    deleteRun() {
      if (fs.existsSync(runFile)) fs.unlinkSync(runFile);
      broadcast('run-state-updated', {});
    },
  };

  return attachStateAuthority(manager, config);
}

module.exports = { createStateManager, attachStateAuthority };
