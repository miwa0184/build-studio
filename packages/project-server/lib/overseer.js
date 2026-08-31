/**
 * WorkflowOverseer — deterministic rule-based monitor for active workflows.
 *
 * Runs on a 15-second interval while a workflow is active.
 * Detects mechanical issues, auto-fixes safe ones (max once per symptom),
 * escalates ambiguous ones to the user.
 *
 * State lives in wf.overseer and is saved with saveWorkflow so the frontend
 * can read it from the normal GET /api/workflow response.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const incidentsLib = require('./incidents');
const { PROVENANCE, syntheticFeedback } = require('./feedback-provenance');
const { createTechnicalStop, REASON_CODES, applyToWorkflow } = require('./technical-stop');
const { createRunGuard } = require('./run-guard');

const CHECK_INTERVAL_MS = 15_000;
const STALL_THRESHOLD_MS = 10 * 60 * 1000; // 10 min — agent stall warning
const LOOP_THRESHOLD = 2; // same step visited > this many times → loop
const FEEDBACK_NUDGE_DELAY_MS = 2 * 60 * 1000;   // agent must be running >= 2 min before we consider nudging
const FEEDBACK_NUDGE_GRACE_MS = 5 * 60 * 1000;   // suppress stall flag for 5 min after a nudge — give agent time to react
const USAGE_LIMIT_DETECT_AFTER_MS = 30 * 1000;   // skip pane-scan for first 30s — agent's startup output can include nothing yet
const DONE_AGENT_EXIT_GRACE_MS = 60 * 1000;      // wait 60s after status=done before sending /exit — let the agent finish printing
const TASK_WALLCLOCK_WARN_MS = 45 * 60 * 1000;   // raise UI escalation if a task agent has been running > 45 min without POSTing feedback

// Claude CLI prints these when an account hits a usage cap. Detection is
// pane-text only — there's no machine-readable signal — so the patterns must
// match what users actually see in the terminal. Add new variants here as
// Anthropic's CLI evolves.
const USAGE_LIMIT_PATTERNS = [
  /You['']ve hit your org['']s (?:monthly )?usage limit/i,
  /Claude AI usage limit reached/i,
  /usage limit reached/i,
  /rate limit exceeded/i,
];

// Structured-output markers that an agent produces when its feedback body is
// ready. Matched against the agent's recent tmux pane.
// Quote-tolerant variants (\\?"): opencode runs with --format json (FU-1), so
// its pane shows NDJSON where quotes are escaped (\"tasks\").
const FEEDBACK_COMPLETION_PATTERNS = [
  /\*\*Approved:\*\*\s*(yes|no)/i,
  /\*\*All issues addressed:\*\*\s*(yes|no)/i,
  /\*\*Tests passed:\*\*/i,
  /\*\*Verdict:\*\*/i,
  /```json[\s\S]*?\\?"tasks\\?"[\s\S]*?```/,  // closed json plan block
  /```json[\s\S]*?\\?"tasks\\?"\s*:\s*\[/,    // unclosed json plan block
];

// Claude Code emits a "✻ <Word> for <time>" line when an agent's turn ends
// (e.g. "✻ Cogitated for 3m 39s", "✻ Crunched for 24s"). While processing it
// shows "✶ <Word>ing… still thinking" instead. This signal disambiguates
// "agent finished and is waiting" from "agent is still working" — and it also
// disambiguates the agent's own output from prompt scrollback (prompts may
// contain prior-round feedback markers like **Approved:** but never the
// turn-complete glyph).
// Anchor on the duration unit ("for 32s" / "for 4m 32s"), not just "for <digit>":
// Claude Code 2.1.x shows `✻ Waiting for 2 background agents to finish` WHILE
// the agent is still working, which the unit-less pattern false-matched —
// nudging (and risking a premature feedback POST from) mid-task agents.
const TURN_COMPLETE_PATTERN = /✻\s+\S+\s+for\s+\d+[smh]\b/;

/**
 * Create an overseer bound to a specific project's state + config.
 *
 * @param {object} config    — project config (projectRoot, etc.)
 * @param {object} state     — state manager (loadWorkflow, saveWorkflow)
 * @param {function} broadcast — SSE broadcast function
 */
function createOverseer(config, state, broadcast) {
  let intervalId = null;
  let running = false;

  // ---------- helpers ----------

  function log(msg) {
    console.log(`[overseer] ${msg}`);
  }

  function ensureOverseer(wf) {
    if (!wf.overseer) {
      wf.overseer = {
        status: 'watching',      // watching | acting | escalating | idle
        activity: 'Monitoring workflow…',
        interventions: [],       // { at, symptom, action, result }
        incidents: [],           // independent, deduplicated — see incidents.js
        pendingEscalation: null, // DERIVED mirror of the most urgent open incident
        stepVisits: {},          // { [stepKey]: count }
        lastCheckedStep: null,   // persisted — deduplicates visit counting across restarts
        workflowId: null,        // persisted — detects new workflow without in-memory state
      };
    }
    return wf.overseer;
  }

  /** Returns true if the same symptom has already been attempted once this run. */
  function alreadyAttempted(overseer, symptom) {
    return overseer.interventions.some(i => i.symptom === symptom);
  }

  /**
   * Incidents, and the single-slot banner they replaced.
   *
   * `pendingEscalation` used to BE the state: one slot, and every detector after
   * the first was written `if (!overseer.pendingEscalation)`. So one agent's
   * usage limit made the overseer blind to a merge conflict, a step loop and
   * every other agent's overrun until somebody dismissed the banner.
   *
   * Incidents are now the state, and each detector asks only about its OWN
   * symptom. `pendingEscalation` is kept as a derived mirror of the most urgent
   * open incident so the existing hub banner keeps rendering unchanged — it is a
   * view now, never a gate.
   */
  const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 };

  function syncEscalationMirror(overseer) {
    const open = incidentsLib.openIncidents(overseer.incidents);
    const top = [...open].sort(
      (a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9),
    )[0];
    overseer.pendingEscalation = top
      ? {
        symptom: top.symptom,
        description: top.description,
        askedAt: top.createdAt,
        action: top.allowedRecoveryAction || undefined,
        actionTarget: top.agent || undefined,
        actionTaskIdx: top.task === null ? undefined : top.task,
        incidentId: top.id,
        openIncidentCount: open.length,
      }
      : null;
  }

  /** True when this exact symptom is already open — the per-symptom dedupe. */
  function incidentOpen(overseer, symptom) {
    return incidentsLib.openIncidents(overseer.incidents).some((i) => i.symptom === symptom);
  }

  function raiseIncident(overseer, runId, input) {
    overseer.incidents = incidentsLib.pruneIncidents(
      incidentsLib.openIncident(overseer.incidents || [], { runId, ...input }),
    );
    syncEscalationMirror(overseer);
  }

  function resolveIncidentSymptom(overseer, symptom) {
    if (!overseer) return;
    overseer.incidents = incidentsLib.resolveIncident(overseer.incidents || [], symptom);
    syncEscalationMirror(overseer);
  }

  /**
   * Park the run after an operator action that no agent verified.
   *
   * Both force-complete and kill-and-skip used to fire a loopback POST to
   * /workflow/advance so the next task launched. That is the fail-open at its
   * purest: the operator's intervention says "this task cannot be completed",
   * and the engine answered by carrying on as though it had been. Whatever the
   * run produced from there rested on a task nobody checked.
   *
   * The task record stays honest — provenance, untrusted pane evidence, an
   * incident — and the agent process is still terminated. What stops is the
   * run. A real attempt at that task is a successor repair run (A1b), which is
   * also the only place acceptance evidence for it can honestly come from.
   */
  function parkRun(wf, { reasonCode, taskIndex, taskName, agentWindow, detail }) {
    const stop = createTechnicalStop({
      reasonCode,
      runId: wf.id,
      step: 'task_execution',
      tasks: [{
        index: typeof taskIndex === 'number' ? taskIndex : Number(taskIndex) || 0,
        name: taskName || `task ${(Number(taskIndex) || 0) + 1}`,
        reason: detail,
      }],
      evidence: [
        `agent ${agentWindow} ended by operator without an agent verdict`,
        `taskStates.${taskIndex}.acceptanceCovered=false`,
      ],
      recoveryHint:
        'This run is parked because a task finished with no agent verdict. Acceptance coverage for it cannot '
        + 'be rebuilt inside this run — start a successor repair run.',
    });
    applyToWorkflow(wf, stop);
    try {
      const statePath = config.statePath || path.join(config.projectRoot || process.cwd(), '.build-studio');
      createRunGuard({ statePath }).mutate(wf.id, (doc) => {
        doc.technicalStop = stop;
        doc.blockingTasks = stop.tasks;
      });
    } catch (e) {
      log(`could not persist the technical stop to the run guard: ${e.message}`);
    }
    log(`TECHNICAL_STOP ${reasonCode} — run parked (${agentWindow})`);
    return stop;
  }

  /** Any open incident other than this one — i.e. is something still wrong? */
  function hasOpenIncidentsBesides(overseer, symptom) {
    return incidentsLib.openIncidents(overseer.incidents).some((i) => i.symptom !== symptom);
  }

  /** Resolve whichever open incident is about this agent window. */
  function resolveIncidentsForAgent(overseer, windowName) {
    if (!overseer) return;
    for (const inc of incidentsLib.openIncidents(overseer.incidents)) {
      if (inc.agent === windowName) {
        overseer.incidents = incidentsLib.resolveIncident(overseer.incidents, inc.symptom);
      }
    }
    syncEscalationMirror(overseer);
  }

  function recordIntervention(overseer, symptom, action, result) {
    overseer.interventions.push({
      at: new Date().toISOString(),
      symptom,
      action,
      result,
    });
    // Keep last 20
    if (overseer.interventions.length > 20) {
      overseer.interventions = overseer.interventions.slice(-20);
    }
  }

  // ---------- detectors ----------

  function detectPackageLockConflict(projectRoot) {
    // Skip non-Node projects — a stray package-lock.json with no package.json
    // is something the overseer shouldn't touch.
    if (!fs.existsSync(path.join(projectRoot, 'package.json'))) return false;
    const lockfile = path.join(projectRoot, 'package-lock.json');
    if (!fs.existsSync(lockfile)) return false;
    try {
      const content = fs.readFileSync(lockfile, 'utf8');
      return content.includes('<<<<<<<') || content.includes('>>>>>>>');
    } catch (_) { return false; }
  }

  function detectMissingNodeModules(projectRoot) {
    // Only fire for Node projects. A project without package.json (e.g. a
    // native iOS / Android / Swift / Rust project) has nothing for npm to do,
    // and a bare `npm install` will exit non-zero — looks like a "fix failed"
    // and surfaces as a false escalation.
    if (!fs.existsSync(path.join(projectRoot, 'package.json'))) return false;
    return !fs.existsSync(path.join(projectRoot, 'node_modules'));
  }

  /** Check if a tmux window has a running process (beyond the shell itself). */
  function isTmuxWindowAlive(sessionName, windowName) {
    try {
      const target = `${sessionName}:${windowName}`;
      const paneCount = execFileSync('tmux', ['list-panes', '-t', target, '-F', '#{pane_pid}'], {
        encoding: 'utf8', timeout: 3000,
      }).trim();
      // If the window exists and has panes, the agent process is alive
      return paneCount.length > 0;
    } catch (_) {
      return false;
    }
  }

  function detectAgentStall(wf) {
    const stalledAgents = [];
    const sessionName = wf.sessionName;

    function checkAgent(agent, stepLabel) {
      if (agent.status !== 'running') return;
      if (recentlyNudged(agent)) return; // give the feedback-nudge time to land
      const agentStart = agent.startedAt ? new Date(agent.startedAt).getTime() : 0;
      const lastUpdate = agent.lastUpdate
        ? new Date(agent.lastUpdate).getTime()
        : (wf.updatedAt ? new Date(wf.updatedAt).getTime() : agentStart);
      if (lastUpdate > 0 && Date.now() - lastUpdate > STALL_THRESHOLD_MS) {
        // Before flagging, check if the tmux window process is still alive
        if (sessionName && agent.window && isTmuxWindowAlive(sessionName, agent.window)) {
          return; // Process alive — not stalled, just slow
        }
        stalledAgents.push({ role: agent.role, step: stepLabel, stalledFor: Math.round((Date.now() - lastUpdate) / 60000) });
      }
    }

    for (const [stepKey, step] of Object.entries(wf.steps || {})) {
      if (step.status !== 'running') continue;
      for (const agent of (step.agents || [])) checkAgent(agent, stepKey);
    }
    // Also check per-task agents in task_execution
    if (wf.taskExecution?.taskStates) {
      for (const [idx, ts] of Object.entries(wf.taskExecution.taskStates)) {
        if (!['running', 'reviewing', 'fixing'].includes(ts.status)) continue;
        for (const agent of (ts.agents || [])) checkAgent(agent, `task_${idx}`);
      }
    }
    return stalledAgents.length > 0 ? stalledAgents : false;
  }

  // Loop detection disabled — stepVisits state gets overwritten by concurrent
  // workflow saves (85+ saveWorkflow calls share the same JSON file).
  // eslint-disable-next-line no-unused-vars
  function detectStepLoop(_overseer, _currentStep) {
    return false;
  }

  /** Capture the last N lines of a tmux pane. Returns '' on failure. */
  function captureTmuxPane(sessionName, windowName, lines = 80) {
    try {
      const target = `${sessionName}:${windowName}`;
      return execFileSync('tmux', ['capture-pane', '-t', target, '-p', '-S', `-${lines}`], {
        encoding: 'utf8', timeout: 3000,
      });
    } catch (_) {
      return '';
    }
  }

  /**
   * Detect agents that have produced what looks like completed output but have
   * not POSTed feedback to the workflow API. Common failure mode: agents
   * (especially planners and review-style agents) print their full result to
   * the terminal and then consider their turn done — they forget the curl
   * command from their prompt and the workflow stalls until a human notices.
   *
   * Returns the list of agents to nudge. Each candidate has the pane content
   * already captured to avoid double-tmux calls.
   */
  function detectAgentForgotFeedback(wf) {
    const candidates = [];
    const sessionName = wf.sessionName;
    if (!sessionName) return candidates;

    function checkAgent(agent, stepLabel) {
      if (agent.status !== 'running') return;
      if (agent.feedback && agent.feedback.trim().length > 0) return;
      if (agent.feedbackNudgedAt) return;            // only nudge once per agent
      if (!agent.window) return;
      const startedAt = agent.startedAt ? new Date(agent.startedAt).getTime() : 0;
      if (!startedAt || Date.now() - startedAt < FEEDBACK_NUDGE_DELAY_MS) return;
      const pane = captureTmuxPane(sessionName, agent.window);
      if (!pane) return;
      // Single primary signal: the Claude Code turn-complete glyph
      // (`✻ <Word> for <Xs>`) appears only when an agent's turn ends — never
      // in prompt scrollback, never in tool output, never during processing
      // (which shows `✶ <Word>ing…` instead). If it's present and the agent
      // has no feedback recorded, the agent has stopped and forgotten the
      // curl POST regardless of whether its output uses the structured
      // markdown markers we expect. (Earlier double-check on
      // FEEDBACK_COMPLETION_PATTERNS missed agents like example-ios T12 that
      // produced free-form prose summaries instead of the mandated
      // **All issues addressed:** / **Approved:** format.)
      if (!TURN_COMPLETE_PATTERN.test(pane)) return;
      candidates.push({ agent, stepLabel });
    }

    for (const [stepKey, step] of Object.entries(wf.steps || {})) {
      if (step.status !== 'running') continue;
      for (const agent of (step.agents || [])) checkAgent(agent, stepKey);
    }
    if (wf.taskExecution?.taskStates) {
      for (const [idx, ts] of Object.entries(wf.taskExecution.taskStates)) {
        if (!['running', 'reviewing', 'fixing'].includes(ts.status)) continue;
        for (const agent of (ts.agents || [])) checkAgent(agent, `task_${idx}`);
      }
    }
    return candidates;
  }

  /**
   * Detect agents that have stopped because their account hit a Claude usage
   * limit. Common failure mode: agent loads its skill, then the first API call
   * returns a usage-limit error. Claude CLI prints the message and returns to
   * an empty prompt — the process stays alive (passes stall detection) but is
   * doing nothing. Returns candidates the UI can offer the user a "Nudge"
   * button for; we never auto-nudge, since the limit may still be active.
   */
  /**
   * G2 — per-task wallclock guard. If a task agent has been `running` for
   * >45 min without POSTing feedback, raise a UI escalation with two action
   * options (force-complete, kill-and-skip). Catches the "Nx full-suite run"
   * task class that survived the planner-side anti-pattern check, plus any
   * slow-task that emerges from prompt evolution.
   *
   * Only fires for `task_execution` task agents — step-level agents
   * (reviewers, security audit, etc.) have their own stall semantics and a
   * 45-min review is sometimes legitimate.
   *
   * One escalation per agent per workflow run (gated on `wallclockWarnedAt`).
   */
  function detectTaskWallclockOverrun(wf) {
    const candidates = [];
    if (!wf.taskExecution?.taskStates) return candidates;
    for (const [idx, ts] of Object.entries(wf.taskExecution.taskStates)) {
      if (ts.status !== 'running') continue;
      for (const agent of (ts.agents || [])) {
        if (agent.status !== 'running') continue;
        if (agent.wallclockWarnedAt) continue;
        if (agent.feedback && agent.feedback.trim().length > 0) continue;
        const startedAt = agent.startedAt ? new Date(agent.startedAt).getTime() : 0;
        if (!startedAt || Date.now() - startedAt < TASK_WALLCLOCK_WARN_MS) continue;
        const ageMin = Math.round((Date.now() - startedAt) / 60000);
        candidates.push({ agent, taskIdx: idx, ageMin });
      }
    }
    return candidates;
  }

  function detectAgentHitUsageLimit(wf) {
    const candidates = [];
    if (!wf.sessionName) return candidates;

    function checkAgent(agent, stepLabel) {
      if (agent.status !== 'running') return;
      if (!agent.window) return;
      if (agent.usageLimitNotifiedAt) return;          // only raise once per hit
      // No feedback progress check: a usage limit blocks the agent before it
      // can produce structured feedback. If the agent has already POSTed
      // feedback for this turn, it isn't the stuck-on-limit case.
      if (agent.feedback && agent.feedback.trim().length > 0) return;
      const startedAt = agent.startedAt ? new Date(agent.startedAt).getTime() : 0;
      if (!startedAt || Date.now() - startedAt < USAGE_LIMIT_DETECT_AFTER_MS) return;
      const pane = captureTmuxPane(wf.sessionName, agent.window, 30);
      if (!pane) return;
      if (!USAGE_LIMIT_PATTERNS.some(p => p.test(pane))) return;
      candidates.push({ agent, stepLabel });
    }

    for (const [stepKey, step] of Object.entries(wf.steps || {})) {
      if (step.status !== 'running') continue;
      for (const agent of (step.agents || [])) checkAgent(agent, stepKey);
    }
    if (wf.taskExecution?.taskStates) {
      for (const [idx, ts] of Object.entries(wf.taskExecution.taskStates)) {
        if (!['running', 'reviewing', 'fixing'].includes(ts.status)) continue;
        for (const agent of (ts.agents || [])) checkAgent(agent, `task_${idx}`);
      }
    }
    return candidates;
  }

  /**
   * Send "continue" + Enter to a stuck agent's tmux pane. Used by the
   * UI-triggered nudge button (POST /api/overseer/nudge-agent). The same
   * two-call pattern as nudgeAgentToPostFeedback avoids Claude Code's
   * bracketed-paste quirk where Enter delivered in one send-keys call gets
   * swallowed.
   */
  function sendContinueToAgentPane(sessionName, windowName) {
    const target = `${sessionName}:${windowName}`;
    try {
      execFileSync('tmux', ['send-keys', '-t', target, 'continue'], { timeout: 3000 });
      execFileSync('sleep', ['0.2'], { timeout: 2000 });
      execFileSync('tmux', ['send-keys', '-t', target, 'Enter'], { timeout: 3000 });
      return true;
    } catch (e) {
      log(`sendContinueToAgentPane failed for ${target}: ${e.message}`);
      return false;
    }
  }

  /**
   * Send Claude Code's `/exit` slash command + Enter to the agent's tmux pane.
   * Used by the post-completion cleanup pass to terminate the claude CLI once
   * a task is marked done. Without this, claude returns to an empty prompt
   * after the agent POSTs feedback and lingers indefinitely — every completed
   * task leaves a zombie process holding ~50MB of RAM, file handles, and a
   * pipe to the project-server. Across a typical PRD run this is hundreds of
   * megabytes of leaked memory.
   *
   * `/exit` is a Claude Code CLI-level command (not a model message), so it
   * works regardless of conversation state. The two-call send-keys pattern
   * sidesteps the bracketed-paste quirk where Enter delivered in the same
   * call gets swallowed.
   */
  function exitAgentPane(sessionName, windowName) {
    const target = `${sessionName}:${windowName}`;
    try {
      execFileSync('tmux', ['send-keys', '-t', target, '/exit'], { timeout: 3000 });
      execFileSync('sleep', ['0.2'], { timeout: 2000 });
      execFileSync('tmux', ['send-keys', '-t', target, 'Enter'], { timeout: 3000 });
      return true;
    } catch (e) {
      // Window may have already been killed by something else — not fatal.
      return false;
    }
  }

  /**
   * Type a reminder into the agent's tmux pane and press Enter.
   *
   * Tone matters: agents have rightly refused earlier wording that read like a
   * prompt-injection attempt ("OVERSEER NUDGE: workflow is BLOCKED, Run X NOW"
   * — pattern-matches as an external system asserting authority over the
   * agent's task). This is intentionally framed as a reminder from the same
   * operator who launched the agent, not as a system override.
   *
   * The curl command IS included verbatim — earlier versions told the agent to
   * "scroll back to your original prompt" instead, which was useless after
   * compaction (the original curl is no longer in context). The injection
   * concern is mitigated because we just echo the same role + taskIndex the
   * agent was assigned at launch — nothing the workflow doesn't already know.
   */
  function nudgeAgentToPostFeedback(sessionName, agent) {
    const target = `${sessionName}:${agent.window}`;
    const taskIndexPart = agent.taskIndex !== undefined ? `,"taskIndex":${agent.taskIndex}` : '';
    const curl = `curl -s -X POST http://localhost:${config.port}/api/workflow/feedback -H 'Content-Type: application/json' -d '{"role":"${agent.role}"${taskIndexPart},"feedback":"<paste your structured feedback here>"}'`;
    const msg = `Hi — your task output looks complete but I don't see the feedback submitted yet. Your conversation may have been compacted, so the curl from your original prompt may not be in context anymore. For reference, the same command (role and taskIndex prefilled for this run): ${curl} — printing your summary in the terminal does not submit it. Thanks.`;
    try {
      // Send the message and Enter as SEPARATE tmux calls. Claude Code's TUI
      // detects bulk send-keys input as a bracketed paste and swallows any
      // Enter delivered in the same call — the composer fills but never
      // submits. A second standalone send-keys with Enter (after a brief
      // settle pause) is what actually triggers submit.
      execFileSync('tmux', ['send-keys', '-t', target, msg], { timeout: 3000 });
      execFileSync('sleep', ['0.2'], { timeout: 2000 });
      execFileSync('tmux', ['send-keys', '-t', target, 'Enter'], { timeout: 3000 });
      return true;
    } catch (_) {
      return false;
    }
  }

  /** True if this agent was nudged recently — used to suppress stall flag for the grace window. */
  function recentlyNudged(agent) {
    if (!agent.feedbackNudgedAt) return false;
    return Date.now() - new Date(agent.feedbackNudgedAt).getTime() < FEEDBACK_NUDGE_GRACE_MS;
  }

  // ---------- auto-fixers ----------

  function fixPackageLockConflict(projectRoot) {
    log('Auto-fixing package-lock.json conflict — deleting and running npm install');
    const lockfile = path.join(projectRoot, 'package-lock.json');
    try { fs.unlinkSync(lockfile); } catch (_) {}
    // Use execFileSync with explicit args — no shell injection risk
    execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts'], {
      cwd: projectRoot,
      timeout: 60_000,
      stdio: 'ignore',
    });
    return 'deleted conflicted package-lock.json and regenerated it';
  }

  function fixMissingNodeModules(projectRoot) {
    log('Auto-fixing missing node_modules — running npm install');
    execFileSync('npm', ['install'], {
      cwd: projectRoot,
      timeout: 120_000,
      stdio: 'ignore',
    });
    return 'ran npm install to restore node_modules';
  }

  // ---------- main check loop ----------

  function runChecks() {
    if (!running) return;

    let wf;
    try { wf = state.loadWorkflow(); } catch (_) { return; }
    if (!wf) return;

    // Overseer only monitors execution workflows — review workflows don't have
    // the mechanical issues (merge conflicts, missing modules, step loops) it fixes.
    if (wf.type !== 'execution') return;

    const terminalSteps = ['completed', 'cancelled', 'failed'];
    if (terminalSteps.includes(wf.currentStep)) {
      stopOverseer();
      return;
    }

    const overseer = ensureOverseer(wf);

    // Migrate old overseer state that lacks persisted fields
    if (overseer.lastCheckedStep === undefined) {
      overseer.lastCheckedStep = wf.currentStep || null;
      overseer.workflowId = wf.id || null;
      overseer.stepVisits = {};
      overseer.interventions = [];
      overseer.incidents = [];
      overseer.pendingEscalation = null;
      log(`Migrated overseer state: lastCheckedStep=${overseer.lastCheckedStep}, workflowId=${overseer.workflowId}`);
    }

    // Reset state when a new workflow starts — fully persisted, survives restarts
    if (wf.id && wf.id !== overseer.workflowId) {
      log(`New workflow detected: ${wf.id} (was ${overseer.workflowId})`);
      overseer.workflowId = wf.id;
      overseer.stepVisits = {};
      overseer.interventions = [];
      overseer.incidents = [];
      overseer.pendingEscalation = null;
      overseer.lastCheckedStep = wf.currentStep || null;
    }

    // Track step transitions (for logging only — loop detection is disabled)
    if (wf.currentStep && wf.currentStep !== overseer.lastCheckedStep) {
      log(`Step transition: ${overseer.lastCheckedStep} → ${wf.currentStep}`);
      overseer.lastCheckedStep = wf.currentStep;
    }

    let changed = false;

    // --- Check: package-lock.json merge conflict ---
    if (detectPackageLockConflict(config.projectRoot)) {
      const symptom = 'package-lock-conflict';
      if (!alreadyAttempted(overseer, symptom)) {
        overseer.status = 'acting';
        overseer.activity = 'Fixing package-lock.json merge conflict…';
        try { state.saveWorkflow(wf); } catch (_) {}
        try {
          const result = fixPackageLockConflict(config.projectRoot);
          recordIntervention(overseer, symptom, 'delete-and-reinstall', result);
          overseer.status = 'watching';
          overseer.activity = 'Fixed package-lock.json conflict. Monitoring…';
        } catch (e) {
          recordIntervention(overseer, symptom, 'delete-and-reinstall', `failed: ${e.message}`);
          overseer.status = 'escalating';
          overseer.activity = 'Could not auto-fix package-lock.json conflict.';
          raiseIncident(overseer, wf.id, {
            symptom,
            principal: incidentsLib.PRINCIPALS.ORCHESTRATOR,
            severity: incidentsLib.SEVERITIES.CRITICAL,
            step: wf.currentStep,
            description: `package-lock.json has merge conflicts and auto-fix failed: ${e.message}. Please resolve manually.`,
            allowedRecoveryAction: 'resolve-conflict',
          });
        }
        changed = true;
      } else if (!incidentOpen(overseer, symptom)) {
        // Tried once and it persists — escalate
        overseer.status = 'escalating';
        overseer.activity = 'package-lock.json conflict persists after auto-fix attempt.';
        raiseIncident(overseer, wf.id, {
          symptom,
          principal: incidentsLib.PRINCIPALS.ORCHESTRATOR,
          severity: incidentsLib.SEVERITIES.CRITICAL,
          step: wf.currentStep,
          description: 'package-lock.json still has merge conflicts after one auto-fix attempt. Please resolve manually.',
          allowedRecoveryAction: 'resolve-conflict',
        });
        changed = true;
      }
    }

    // --- Check: missing node_modules ---
    if (detectMissingNodeModules(config.projectRoot)) {
      const symptom = 'missing-node-modules';
      if (!alreadyAttempted(overseer, symptom)) {
        overseer.status = 'acting';
        overseer.activity = 'Running npm install (node_modules missing)…';
        try { state.saveWorkflow(wf); } catch (_) {}
        try {
          const result = fixMissingNodeModules(config.projectRoot);
          recordIntervention(overseer, symptom, 'npm-install', result);
          overseer.status = 'watching';
          overseer.activity = 'Restored node_modules. Monitoring…';
        } catch (e) {
          recordIntervention(overseer, symptom, 'npm-install', `failed: ${e.message}`);
          overseer.status = 'escalating';
          raiseIncident(overseer, wf.id, {
            symptom,
            principal: incidentsLib.PRINCIPALS.ORCHESTRATOR,
            severity: incidentsLib.SEVERITIES.CRITICAL,
            step: wf.currentStep,
            description: `npm install failed: ${e.message}`,
            allowedRecoveryAction: 'install-dependencies',
          });
        }
        changed = true;
      }
    }

    // --- Check: step loop ---
    if (detectStepLoop(overseer, wf.currentStep)) {
      const symptom = `loop-${wf.currentStep}`;
      if (!alreadyAttempted(overseer, symptom)) {
        const visits = overseer.stepVisits[wf.currentStep];
        recordIntervention(overseer, symptom, 'escalate', `step '${wf.currentStep}' visited ${visits} times`);
        overseer.status = 'escalating';
        overseer.activity = `Workflow may be stuck in a loop at: ${wf.currentStep}`;
        raiseIncident(overseer, wf.id, {
          symptom,
          principal: incidentsLib.PRINCIPALS.ORCHESTRATOR,
          severity: incidentsLib.SEVERITIES.WARNING,
          step: wf.currentStep,
          description: `The workflow has visited step '${wf.currentStep}' ${visits} times. This may indicate a loop. Consider cancelling or inspecting the workflow.`,
          allowedRecoveryAction: 'inspect-or-cancel',
        });
        changed = true;
      }
    }

    // --- Check: agent finished its work but forgot to POST feedback (nudge) ---
    // Catches the common failure mode where planner / review-style agents
    // print their full output and consider their turn done, never running the
    // curl command to submit feedback. We type a reminder into their tmux pane
    // before the 10-min stall watchdog fires.
    {
      const forgot = detectAgentForgotFeedback(wf);
      for (const { agent, stepLabel } of forgot) {
        const symptom = `forgot-feedback-${agent.role.toLowerCase().replace(/\s+/g, '-')}-${stepLabel}`;
        log(`Nudging ${agent.role} in ${agent.window} (${stepLabel}): pane shows completion signal, no feedback POSTed`);
        const ok = nudgeAgentToPostFeedback(wf.sessionName, agent);
        agent.feedbackNudgedAt = new Date().toISOString();
        recordIntervention(overseer, symptom, 'nudge-pane', ok ? `sent curl-reminder to ${agent.window}` : `tmux send-keys failed for ${agent.window}`);
        changed = true;
      }
    }

    // --- Check: agent hit a Claude usage limit and stopped ---
    // No auto-nudge: the limit may still be active, and resending input would
    // just burn through nothing. Surface the agent + window to the UI via the
    // pendingEscalation banner, which renders a Nudge button when the user
    // believes the limit has lifted.
    {
      // Every agent that hit the limit, not just the first: two agents capped at
      // once is the common case, and reporting one of them hid the other.
      for (const { agent, stepLabel } of detectAgentHitUsageLimit(wf)) {
        const symptom = `usage-limit-${agent.window}`;
        if (incidentOpen(overseer, symptom)) continue;
        log(`Detected usage-limit stall: ${agent.role} in ${agent.window} (${stepLabel})`);
        agent.usageLimitNotifiedAt = new Date().toISOString();
        overseer.status = 'escalating';
        overseer.activity = `Usage limit hit: ${agent.role} (${agent.window})`;
        raiseIncident(overseer, wf.id, {
          symptom,
          principal: incidentsLib.PRINCIPALS.TECHNICAL,
          severity: incidentsLib.SEVERITIES.WARNING,
          step: stepLabel,
          agent: agent.window,
          task: agent.taskIndex,
          description: `${agent.role} (${agent.window}) hit a Claude usage limit and stopped. Click Nudge to retry — only works if the limit has lifted; otherwise the agent will hit it again and the banner will reappear.`,
          allowedRecoveryAction: 'nudge-agent',
        });
        recordIntervention(overseer, symptom, 'await-nudge', `pane in ${agent.window} matched usage-limit pattern; awaiting user nudge`);
        changed = true;
      }
    }

    // --- G2: Task wallclock overrun — agent running >45 min, no feedback ---
    // Caught the t36/t37/t38 class that destroyed PRD-008 overnight runtime.
    // Provides two action paths (handled by the UI/API):
    //   • force-complete: agent's pane-printed work is taken as feedback,
    //     workflow advances. Used when the agent is iterating uselessly but
    //     work is committed.
    //   • kill-and-skip: kills the agent, marks task done with a synthetic
    //     "skipped by operator" feedback. Used when the task itself is
    //     ill-conceived (e.g. an Nx flake check that slipped past G1).
    {
      // One incident per overrunning agent. The t36/t37/t38 case this rule was
      // written for was THREE agents at once; the old single slot reported one.
      for (const { agent, taskIdx, ageMin } of detectTaskWallclockOverrun(wf)) {
        const symptom = `task-wallclock-${agent.window}`;
        if (incidentOpen(overseer, symptom)) continue;
        log(`Task wallclock overrun: ${agent.role} in ${agent.window} (task_${taskIdx}, ${ageMin}min)`);
        agent.wallclockWarnedAt = new Date().toISOString();
        overseer.status = 'escalating';
        overseer.activity = `Task running ${ageMin}min: ${agent.window}`;
        raiseIncident(overseer, wf.id, {
          symptom,
          principal: incidentsLib.PRINCIPALS.TECHNICAL,
          severity: incidentsLib.SEVERITIES.WARNING,
          step: 'task_execution',
          agent: agent.window,
          task: taskIdx,
          description: `${agent.role} (${agent.window}, task ${parseInt(taskIdx,10)+1}) has been running ${ageMin}min without POSTing feedback. Likely an oversized task (full-suite run, Nx flake check, omnibus). Force-complete keeps the agent's pane output as untrusted diagnostic evidence — it is not an approval; Kill-and-skip aborts the task and leaves its acceptance coverage unmet. Both stop the wasted runtime.`,
          allowedRecoveryAction: 'task-overrun',
        });
        recordIntervention(overseer, symptom, 'await-decision', `${agent.role} task_${taskIdx} running ${ageMin}min; awaiting operator force-complete or kill-skip`);
        changed = true;
      }
    }

    // --- Check: agent stall (warning only, no auto-fix) ---
    const stalledAgents = !changed ? detectAgentStall(wf) : false;
    if (stalledAgents) {
      const symptom = 'agent-stall';
      if (!alreadyAttempted(overseer, symptom) && !incidentOpen(overseer, symptom)) {
        const stalledDesc = stalledAgents.map(a => `${a.role} (${a.step}, ${a.stalledFor}min)`).join(', ');
        recordIntervention(overseer, symptom, 'warn', `stalled agents: ${stalledDesc}`);
        overseer.status = 'escalating';
        overseer.activity = `Agent stall detected: ${stalledAgents[0].role} (${stalledAgents[0].stalledFor}min)`;
        raiseIncident(overseer, wf.id, {
          symptom,
          principal: incidentsLib.PRINCIPALS.TECHNICAL,
          severity: incidentsLib.SEVERITIES.WARNING,
          step: wf.currentStep,
          agent: stalledAgents[0].role,
          description: `These agents have not updated in 10+ minutes and may be stuck: ${stalledDesc}. Check their tmux windows or consider relaunching.`,
          allowedRecoveryAction: 'inspect-or-relaunch',
        });
        changed = true;
      }
    }

    // --- Cleanup: send /exit to completed agents to terminate zombie claude processes ---
    // Claude CLI is launched in interactive mode (workflow.js cliInvocation).
    // After the agent POSTs feedback and the workflow marks it done, claude
    // returns to an empty prompt and waits forever for the next user input.
    // The process holds ~50MB of RAM plus open file handles. With ~30 tasks
    // per PRD, this leaks hundreds of MB per workflow run.
    //
    // Each agent gets a grace window after completedAt so it can finish
    // printing its summary before we close the CLI. exitedAt is set the
    // first time we send /exit so we don't spam the pane on every poll.
    if (wf.sessionName) {
      const exitCandidates = [];
      function checkDoneAgent(agent) {
        if (!agent.window) return;
        if (agent.exitedAt) return;
        if (agent.status !== 'done') return;
        const completedAt = agent.completedAt ? new Date(agent.completedAt).getTime() : 0;
        if (!completedAt || Date.now() - completedAt < DONE_AGENT_EXIT_GRACE_MS) return;
        exitCandidates.push(agent);
      }
      for (const step of Object.values(wf.steps || {})) {
        for (const a of (step.agents || [])) checkDoneAgent(a);
      }
      for (const ts of Object.values(wf.taskExecution?.taskStates || {})) {
        for (const a of (ts.agents || [])) checkDoneAgent(a);
      }
      for (const agent of exitCandidates) {
        const ok = exitAgentPane(wf.sessionName, agent.window);
        agent.exitedAt = new Date().toISOString();
        log(`Sent /exit to ${agent.role} (${agent.window}) — ${ok ? 'ok' : 'tmux send-keys failed (window may be gone)'}`);
        changed = true;
      }
    }

    // Keep activity label fresh when all is well — show agent progress
    if (!changed && overseer.status === 'watching') {
      let agentSummary = '';
      // Summarise agent statuses for the current step
      const step = wf.steps?.[wf.currentStep];
      const agents = step?.agents || [];
      // Also check task execution agents
      const taskAgents = [];
      if (wf.currentStep === 'task_execution' && wf.taskExecution?.taskStates) {
        for (const ts of Object.values(wf.taskExecution.taskStates)) {
          for (const a of (ts.agents || [])) taskAgents.push(a);
        }
      }
      const allAgents = agents.length > 0 ? agents : taskAgents;
      if (allAgents.length > 0) {
        const running = allAgents.filter(a => a.status === 'running').length;
        const done = allAgents.filter(a => a.status === 'done').length;
        const total = allAgents.length;
        if (running > 0) {
          agentSummary = ` · ${running} running, ${done}/${total} done`;
        } else if (done === total) {
          agentSummary = ' · all agents done — awaiting approval';
        }
      }
      // Show elapsed time for the current step
      let elapsed = '';
      const stepStart = step?.agents?.[0]?.startedAt;
      if (stepStart) {
        const mins = Math.round((Date.now() - new Date(stepStart).getTime()) / 60000);
        if (mins > 0) elapsed = ` (${mins}m)`;
      }
      const newActivity = `Monitoring: ${(wf.currentStep || 'workflow').replace(/_/g, ' ')}${elapsed}${agentSummary}`;
      if (overseer.activity !== newActivity) {
        overseer.activity = newActivity;
        changed = true;
      }
    }

    if (changed) {
      try { state.saveWorkflow(wf); } catch (e) {
        log(`saveWorkflow failed: ${e.message}`);
      }
    }
  }

  // ---------- public API ----------

  function startOverseer() {
    if (running) return;
    running = true;
    log('Starting');

    // Initialise overseer state in the workflow immediately
    try {
      const wf = state.loadWorkflow();
      if (wf && wf.type === 'execution') {
        const overseer = ensureOverseer(wf);
        overseer.status = 'watching';
        overseer.activity = `Monitoring step: ${wf.currentStep || 'workflow'}`;
        // Reset step visits and interventions for a fresh run
        overseer.stepVisits = {};
        overseer.interventions = [];
        overseer.incidents = [];
        overseer.pendingEscalation = null;
        overseer.lastCheckedStep = wf.currentStep || null;
        overseer.workflowId = wf.id || null;
        delete overseer._lastSeenStep; // clean up legacy field
        log(`Init: lastCheckedStep=${overseer.lastCheckedStep}, workflowId=${overseer.workflowId}`);
        state.saveWorkflow(wf);
      }
    } catch (e) {
      log(`init failed: ${e.message}`);
    }

    intervalId = setInterval(runChecks, CHECK_INTERVAL_MS);
    // First check after a short delay
    setTimeout(runChecks, 2000);
  }

  function stopOverseer() {
    if (!running) return;
    running = false;
    log('Stopping');
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }

    // Mark idle in workflow state
    try {
      const wf = state.loadWorkflow();
      if (wf && wf.overseer) {
        wf.overseer.status = 'idle';
        wf.overseer.activity = 'Workflow complete.';
        state.saveWorkflow(wf);
      }
    } catch (_) {}
  }

  /**
   * Dismiss the pending escalation — user has acknowledged it.
   */
  function dismissEscalation() {
    try {
      const wf = state.loadWorkflow();
      if (!wf || !wf.overseer) return;
      // Dismissing the banner resolves the incident it was showing — and only
      // that one. Any other open incident takes its place in the mirror rather
      // than disappearing with it.
      const shown = wf.overseer.pendingEscalation;
      if (shown && shown.symptom) resolveIncidentSymptom(wf.overseer, shown.symptom);
      else wf.overseer.pendingEscalation = null;
      if (incidentsLib.openIncidents(wf.overseer.incidents).length === 0 && wf.overseer.status === 'escalating') {
        wf.overseer.status = 'watching';
        wf.overseer.activity = `Monitoring step: ${wf.currentStep || 'workflow'}`;
      }
      state.saveWorkflow(wf);
    } catch (_) {}
  }

  /**
   * Send "continue" to a stuck agent's tmux pane. Called by the UI Nudge
   * button when the user believes a previously-hit usage limit has lifted.
   * Clears the per-agent notified flag so the same agent can be re-detected
   * if the limit is still in effect, and clears the matching escalation so
   * the banner disappears on success.
   *
   * @returns {{ok: boolean, error?: string}}
   */
  function nudgeAgent(windowName) {
    try {
      const wf = state.loadWorkflow();
      if (!wf || !wf.sessionName) return { ok: false, error: 'no active workflow' };
      if (!windowName) return { ok: false, error: 'window required' };

      const ok = sendContinueToAgentPane(wf.sessionName, windowName);
      if (!ok) return { ok: false, error: `tmux send-keys failed for ${windowName}` };

      // Clear the per-agent notified flag wherever this agent lives so the
      // overseer can re-detect if the limit is still active.
      for (const step of Object.values(wf.steps || {})) {
        for (const a of (step.agents || [])) {
          if (a.window === windowName) delete a.usageLimitNotifiedAt;
        }
      }
      for (const ts of Object.values(wf.taskExecution?.taskStates || {})) {
        for (const a of (ts.agents || [])) {
          if (a.window === windowName) delete a.usageLimitNotifiedAt;
        }
      }

      if (wf.overseer) {
        resolveIncidentsForAgent(wf.overseer, windowName);
        if (incidentsLib.openIncidents(wf.overseer.incidents).length === 0 && wf.overseer.status === 'escalating') {
          wf.overseer.status = 'watching';
          wf.overseer.activity = `Nudged ${windowName} — awaiting agent`;
        }
        recordIntervention(wf.overseer, `nudge-${windowName}`, 'user-nudge', `sent "continue" to ${windowName}`);
      }
      state.saveWorkflow(wf);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * G2 — Force-complete a stuck task. Keeps the agent's tmux pane scrollback as
   * diagnostic evidence and stops the wasted runtime. For when the work is
   * committed but the agent is iterating uselessly.
   *
   * What this deliberately does NOT do any more: it used to write the captured
   * pane into `agent.feedback` under a literal `**Approved:** yes` header, and
   * mark the task `done`. Every downstream verdict parser reads approval by
   * regexing that string, so an operator ending a runaway agent manufactured a
   * positive review out of terminal scrollback — including, on a pane that had
   * echoed its own prompt, out of the format example.
   *
   * Now the output is preserved and labelled: provenance is recorded on the
   * agent (feedback-provenance.js), the body carries no approval marker in any
   * form, and the task is marked force-completed with its acceptance coverage
   * explicitly unmet. The run continues — the operator decided that — but
   * nothing can later claim the task was verified.
   *
   * @returns {{ok: boolean, error?: string}}
   */
  function forceCompleteTaskAgent(windowName) {
    try {
      const wf = state.loadWorkflow();
      if (!wf || !wf.sessionName) return { ok: false, error: 'no active workflow' };
      if (!windowName) return { ok: false, error: 'window required' };

      // Find the task and agent
      let foundAgent = null;
      let foundTaskState = null;
      for (const ts of Object.values(wf.taskExecution?.taskStates || {})) {
        for (const a of (ts.agents || [])) {
          if (a.window === windowName && a.status === 'running') {
            foundAgent = a;
            foundTaskState = ts;
            break;
          }
        }
        if (foundAgent) break;
      }
      if (!foundAgent) return { ok: false, error: `no running task agent in ${windowName}` };

      // Capture pane scrollback as synthetic feedback. The agent's printed
      // summary is usually present in the last ~200 lines even if it never
      // ran the curl POST.
      const pane = captureTmuxPane(wf.sessionName, windowName, 200) || '';
      const summary = pane.trim().split('\n').slice(-80).join('\n').slice(-2000);

      foundAgent.status = 'done';
      foundAgent.feedbackProvenance = PROVENANCE.OPERATOR_FORCE_COMPLETE;
      foundAgent.feedback = syntheticFeedback(
        PROVENANCE.OPERATOR_FORCE_COMPLETE,
        summary,
        'Agent force-completed by operator after a wallclock overrun. The pane below is the last 80 lines of terminal output, not a verdict the agent submitted.',
      );
      foundAgent.completedAt = new Date().toISOString();
      foundAgent.forceCompletedAt = foundAgent.completedAt;
      // `force_completed`, not `done`: no agent certified this task, so nothing
      // downstream may count it as verified work.
      foundTaskState.status = 'force_completed';
      foundTaskState.forceCompleted = true;
      foundTaskState.acceptanceCovered = false;
      foundTaskState.completedAt = foundAgent.completedAt;

      // Send /exit to terminate the claude CLI
      exitAgentPane(wf.sessionName, windowName);
      foundAgent.exitedAt = new Date().toISOString();

      ensureOverseer(wf);
      if (wf.overseer) {
        // The overrun incident is resolved; a new one records the override, so
        // the run carries the fact that a task advanced without a verdict.
        resolveIncidentsForAgent(wf.overseer, windowName);
        raiseIncident(wf.overseer, wf.id, {
          symptom: `force-completed-${windowName}`,
          principal: incidentsLib.PRINCIPALS.TECHNICAL,
          severity: incidentsLib.SEVERITIES.WARNING,
          step: 'task_execution',
          agent: windowName,
          task: foundAgent.taskIndex,
          description: `Task force-completed by operator. Pane output is kept as untrusted diagnostic evidence — it is not an agent verdict and does not count as approval or acceptance evidence. The run is parked; a successor repair run is the route to a real verdict.`,
          allowedRecoveryAction: 'successor-repair-run',
        });
        // Ignore the incident just raised: it records the override, it is not a
        // problem waiting on anyone. Counting it meant the condition could never
        // hold, so the overseer stayed 'escalating' with its activity frozen on
        // the overrun text until somebody dismissed a banner by hand.
        wf.overseer.status = 'idle';
        wf.overseer.activity = `Force-completed ${windowName} — run parked, no agent verdict`;
        recordIntervention(wf.overseer, `force-complete-${windowName}`, 'user-force-complete', `task force-completed; pane scrollback kept as untrusted diagnostic evidence, not as approval; run parked`);
      }

      parkRun(wf, {
        reasonCode: REASON_CODES.TASK_FORCE_COMPLETED_UNVERIFIED,
        taskIndex: foundAgent.taskIndex,
        taskName: (wf.taskPlan && wf.taskPlan.tasks && wf.taskPlan.tasks[foundAgent.taskIndex]
          && (wf.taskPlan.tasks[foundAgent.taskIndex].name)) || undefined,
        agentWindow: windowName,
        detail: 'force-completed by operator after a wallclock overrun — no agent verdict was produced',
      });
      state.saveWorkflow(wf);

      // No loopback to /workflow/advance here any more. Both actions used to
      // fire one so the next task launched — which turned "this task cannot be
      // completed" into "carry on as though it had been". The run is parked
      // above; nothing follows it in this run.
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * G2 — Kill-and-skip a stuck task. Terminates the agent and marks the task
   * SKIPPED. For when the task itself is ill-conceived (e.g. an Nx flake check
   * that slipped past the planner anti-pattern check).
   *
   * It used to mark the task `done` under a `**Approved:** yes` header, which
   * said the opposite of what happened: no work was attributed and no agent
   * reviewed anything. The task is now `skipped`, its acceptance coverage stays
   * unmet until a real replacement run passes, and the feedback body carries no
   * approval marker. The workflow still advances to the next task — that is the
   * operator's call — but it advances honestly.
   *
   * @returns {{ok: boolean, error?: string}}
   */
  function killAndSkipTaskAgent(windowName) {
    try {
      const wf = state.loadWorkflow();
      if (!wf || !wf.sessionName) return { ok: false, error: 'no active workflow' };
      if (!windowName) return { ok: false, error: 'window required' };

      let foundAgent = null;
      let foundTaskState = null;
      for (const ts of Object.values(wf.taskExecution?.taskStates || {})) {
        for (const a of (ts.agents || [])) {
          if (a.window === windowName && a.status === 'running') {
            foundAgent = a;
            foundTaskState = ts;
            break;
          }
        }
        if (foundAgent) break;
      }
      if (!foundAgent) return { ok: false, error: `no running task agent in ${windowName}` };

      // /exit cleanly first; if claude is stuck, the pane just stops responding.
      exitAgentPane(wf.sessionName, windowName);

      foundAgent.status = 'done';
      foundAgent.feedbackProvenance = PROVENANCE.OPERATOR_KILL_SKIP;
      foundAgent.feedback = syntheticFeedback(
        PROVENANCE.OPERATOR_KILL_SKIP,
        '',
        'Task aborted by operator after a wallclock overrun. No work is attributed to this task; review downstream tasks for missing coverage.',
      );
      foundAgent.completedAt = new Date().toISOString();
      foundAgent.skippedAt = foundAgent.completedAt;
      foundAgent.exitedAt = foundAgent.completedAt;
      foundTaskState.status = 'skipped';
      foundTaskState.completedAt = foundAgent.completedAt;
      foundTaskState.skipped = true;
      foundTaskState.acceptanceCovered = false;
      foundTaskState.skipReason = 'aborted by operator after wallclock overrun — no work attributed';

      ensureOverseer(wf);
      if (wf.overseer) {
        resolveIncidentsForAgent(wf.overseer, windowName);
        raiseIncident(wf.overseer, wf.id, {
          symptom: `skipped-${windowName}`,
          principal: incidentsLib.PRINCIPALS.TECHNICAL,
          severity: incidentsLib.SEVERITIES.WARNING,
          step: 'task_execution',
          agent: windowName,
          task: foundAgent.taskIndex,
          description: 'Task aborted by operator with no work attributed. Its acceptance coverage stays unmet; the run is parked and a successor repair run is the route to a real verdict.',
          allowedRecoveryAction: 'successor-repair-run',
        });
        wf.overseer.status = 'idle';
        wf.overseer.activity = `Skipped ${windowName} — run parked, no work attributed`;
        recordIntervention(wf.overseer, `kill-skip-${windowName}`, 'user-kill-skip', `task aborted and marked skipped; acceptance coverage left unmet; run parked`);
      }

      parkRun(wf, {
        reasonCode: REASON_CODES.TASK_SKIPPED_UNVERIFIED,
        taskIndex: foundAgent.taskIndex,
        taskName: (wf.taskPlan && wf.taskPlan.tasks && wf.taskPlan.tasks[foundAgent.taskIndex]
          && (wf.taskPlan.tasks[foundAgent.taskIndex].name)) || undefined,
        agentWindow: windowName,
        detail: 'aborted by operator after a wallclock overrun — no work attributed',
      });
      state.saveWorkflow(wf);

      // No loopback to /workflow/advance here any more. Both actions used to
      // fire one so the next task launched — which turned "this task cannot be
      // completed" into "carry on as though it had been". The run is parked
      // above; nothing follows it in this run.
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  return { startOverseer, stopOverseer, dismissEscalation, nudgeAgent, forceCompleteTaskAgent, killAndSkipTaskAgent, isRunning: () => running };
}

module.exports = { createOverseer };
