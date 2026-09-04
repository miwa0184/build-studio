'use strict';

/**
 * Who produced this feedback — and therefore whether it can mean "approved".
 *
 * The engine reads a verdict by regexing `**Approved:** yes` out of
 * `agent.feedback`. That is fine while agents are the only writers. They were
 * not: when an operator force-completed a runaway agent, the overseer pasted the
 * agent's tmux scrollback into that same field under a literal `**Approved:**
 * yes` header — and kill-and-skip wrote the same header over a task nobody had
 * done at all. An operator ending a stuck agent therefore manufactured positive
 * review evidence, and every downstream parser believed it.
 *
 * The fix is not a cleverer regex. Text cannot be trusted to describe its own
 * origin: a pane echoes the prompt, and the prompt contains the format spec, so
 * scrollback legitimately contains approval markers that were never a verdict.
 * Origin has to be a separate structured field that the text cannot forge.
 *
 * So: `agent.feedbackProvenance` records the writer, approval is only ever read
 * off an agent's own verdict, and operator output is kept — it is genuinely
 * useful diagnostic evidence — but marked untrusted and never counted.
 *
 * Absent provenance means AGENT. Runs that started before this field existed
 * have real agent feedback in that slot, and re-labelling their history as
 * untrusted would be its own falsehood.
 */

const PROVENANCE = {
  /** The agent POSTed this itself. The only kind that can be a verdict. */
  AGENT: 'agent',
  /** An operator force-completed the agent; the body is captured pane output. */
  OPERATOR_FORCE_COMPLETE: 'operator_force_complete',
  /** An operator killed the agent and skipped the task; no work was attributed. */
  OPERATOR_KILL_SKIP: 'operator_kill_skip',
};

const OPERATOR_PROVENANCE = new Set([
  PROVENANCE.OPERATOR_FORCE_COMPLETE,
  PROVENANCE.OPERATOR_KILL_SKIP,
]);

/** True when the feedback is the agent's own verdict. */
function isAgentVerdict(agent) {
  if (!agent) return false;
  const p = agent.feedbackProvenance;
  return p === undefined || p === null || p === PROVENANCE.AGENT;
}

/**
 * Can this agent's feedback be read as an approval at all?
 *
 * Note what this does NOT do: it does not decide whether the agent approved. It
 * decides whether the question may be asked. Callers still parse the verdict —
 * this only stops them parsing something an operator wrote.
 */
function countsAsApproval(agent) {
  return isAgentVerdict(agent) && !!(agent && agent.feedback);
}

/** Acceptance coverage has the same rule, and one more: a skipped task covers nothing. */
function countsAsAcceptanceEvidence(agent) {
  if (!isAgentVerdict(agent)) return false;
  return !!(agent && agent.feedback);
}

/** True for feedback an operator generated. */
function isOperatorGenerated(agent) {
  return !!agent && OPERATOR_PROVENANCE.has(agent.feedbackProvenance);
}

/**
 * The body written into `agent.feedback` for an operator action.
 *
 * Preserves the pane output — that is the whole reason force-complete is worth
 * having — but frames it as what it is. Deliberately contains no
 * `**Approved:**` line in any form: a parser that has not been taught about
 * provenance yet must not find an approval here either.
 */
function syntheticFeedback(provenance, paneOutput, detail) {
  const body = String(paneOutput || '').trim();
  const block = body ? `\n\n\`\`\`\n${body}\n\`\`\`` : '\n\n(empty pane)';

  if (provenance === PROVENANCE.OPERATOR_KILL_SKIP) {
    return [
      '**Outcome:** skipped',
      '**Provenance:** operator_kill_skip',
      '**Technical override:** yes — this is NOT an agent verdict and is NOT an approval',
      '',
      '### Summary',
      detail || 'Task aborted by operator after a wallclock overrun. No work is attributed to this task.',
      'Its acceptance coverage stays unmet until a real replacement run passes.',
    ].join('\n');
  }

  return [
    '**Outcome:** force_completed',
    '**Provenance:** operator_force_complete',
    '**Technical override:** yes — this is NOT an agent verdict and is NOT an approval',
    '',
    '### Summary',
    detail || 'Agent force-completed by operator after a wallclock overrun.',
    '',
    '### Untrusted diagnostic evidence (agent pane output, last lines)',
    'Captured from the terminal, not POSTed by the agent. Treat as a diagnostic',
    'artefact only — it may contain echoed prompt text, including format examples.'
    + block,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// One strict, structured reading of a verdict body.
//
// Provenance answers WHO wrote the text. This answers WHAT the text says, for
// a reader that must fail closed (the factory-run receipt). The engine's
// advance path keeps its lenient regexes; this reader is deliberately
// stricter, and every difference is in the refusing direction:
//
//   - markers are line-anchored: `**Approved:** yes` must be the whole line
//     (case-insensitive, a closing period tolerated). A value with anything
//     else on it — "yes | no", "yes/no", "yes (see below)" — is the prompt's
//     format line or an unreadable hedge, never a verdict;
//   - fenced and indented code blocks, blockquotes, inline code and list
//     bullets are not markers: that is where prompts, pane echoes and
//     prior-round quotes live;
//   - `**Verdict:** …` is read against a closed vocabulary. Any refusing word
//     ("not approved", "unapproved", "reject", "changes requested", "block",
//     "fail") makes it a refusal even when "approved" also appears; only a
//     bare "approved"/"approve" is an approval; anything else is unrecognized;
//   - an explicit refusal anywhere wins. Otherwise more than one marker, a
//     template-shaped marker, an unrecognized verdict, or disagreeing counts
//     leave the verdict ambiguous (`approved: null`) — never approved.
// ---------------------------------------------------------------------------

const APPROVED_LINE = /^\*\*Approved:\*\*[ \t]*(.*?)[ \t]*$/i;
const VERDICT_LINE = /^\*\*Verdict:\*\*[ \t]*(.*?)[ \t]*$/i;
const COUNT_LINE = /^\*\*(Blocking|Medium|Low):\*\*[ \t]*(\d+)[ \t]*$/i;
const COUNT_LINE_START = /^\*\*(?:Blocking|Medium|Low):\*\*/i;
const REFUSING_VERDICT = /\bnot\s+approved\b|\bunapproved\b|\breject(?:ed|s)?\b|\bchanges?\s+requested\b|\bblock(?:ed|ing|s)?\b|\bfail(?:ed|s|ure|ures)?\b|\bdeclined?\b/i;
const APPROVING_VERDICT = /^(?:approved?|lgtm|pass(?:ed)?)$/i;

function startsIndentedCode(raw) {
  let columns = 0;
  for (const char of raw) {
    if (char === ' ') columns += 1;
    else if (char === '\t') columns += 4 - (columns % 4);
    else break;
    if (columns >= 4) return true;
  }
  return false;
}

/** The lines that can carry a marker: outside fences, not quoted, not bulleted. */
function markerLines(feedback) {
  const out = [];
  let fence = null;
  for (const raw of String(feedback || '').split(/\r?\n/)) {
    const indentedCode = startsIndentedCode(raw);
    const line = raw.trim();
    const fenceLine = !indentedCode ? line.match(/^(`{3,}|~{3,})(.*)$/) : null;
    if (fenceLine) {
      const marker = fenceLine[1];
      if (!fence) {
        fence = { character: marker[0], length: marker.length };
        continue;
      }
      if (marker[0] === fence.character
        && marker.length >= fence.length
        && /^[ \t]*$/.test(fenceLine[2])) {
        fence = null;
        continue;
      }
    }
    if (fence || indentedCode) continue;
    if (line.startsWith('>') || /^[-*+]\s/.test(line) || /^\d+[.)]\s/.test(line)) continue;
    out.push(line);
  }
  return out;
}

function classifyApproved(value) {
  const v = value.replace(/[.!]+$/, '').trim().toLowerCase();
  if (v === 'yes') return 'yes';
  if (v === 'no') return 'no';
  return /\byes\b/.test(v) && /\bno\b/.test(v) ? 'template' : 'unrecognized';
}

function classifyVerdict(value) {
  const v = value.replace(/[.!]+$/, '').trim();
  if (REFUSING_VERDICT.test(v)) return 'no';
  if (APPROVING_VERDICT.test(v)) return 'yes';
  return 'unrecognized';
}

function parseFailing(feedback) {
  const text = String(feedback || '');
  const m = text.match(/(?<![\w-])(\d+)\s+(?:failed|failures)\b/i)
    || text.match(/\*\*Failures:\*\*\s*(\d+)/i)
    || text.match(/\((\d+)\s+failed/i);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * @returns {{approved: true|false|null, reason: string, markers: string[],
 *   blocking: number|null, medium: number|null, low: number|null, failing: number}}
 *
 * `reason` is one of: approved, refused, no_marker, template, unrecognized,
 * multiple, counts_malformed, counts_conflict. Counts are null when no
 * anchored count exists or a structured count line is malformed.
 */
function parseStructuredVerdict(feedback) {
  const markers = [];
  const counts = { blocking: [], medium: [], low: [] };
  let countsMalformed = false;
  for (const line of markerLines(feedback)) {
    const approved = line.match(APPROVED_LINE);
    if (approved) markers.push({ kind: 'approved', value: classifyApproved(approved[1]) });
    const verdict = line.match(VERDICT_LINE);
    if (verdict) markers.push({ kind: 'verdict', value: classifyVerdict(verdict[1]) });
    if (COUNT_LINE_START.test(line)) {
      for (const field of line.split('|')) {
        const count = field.trim().match(COUNT_LINE);
        if (!count) {
          countsMalformed = true;
          continue;
        }
        counts[count[1].toLowerCase()].push(parseInt(count[2], 10));
      }
    }
  }
  const kinds = markers.map((m) => `${m.kind}:${m.value}`);
  const single = (list) => (list.length === 0 ? null : new Set(list).size === 1 ? list[0] : undefined);
  const blocking = single(counts.blocking);
  const medium = single(counts.medium);
  const low = single(counts.low);
  const base = {
    markers: kinds,
    blocking: blocking === undefined ? null : blocking,
    medium: medium === undefined ? null : medium,
    low: low === undefined ? null : low,
    failing: parseFailing(feedback),
  };
  const ambiguousCounts = countsMalformed
    ? { ...base, blocking: null, medium: null, low: null }
    : base;
  if (markers.some((m) => m.value === 'no')) return { approved: false, reason: 'refused', ...base };
  if (markers.length === 0) return { approved: null, reason: 'no_marker', ...ambiguousCounts };
  if (markers.some((m) => m.value === 'template')) return { approved: null, reason: 'template', ...ambiguousCounts };
  if (markers.some((m) => m.value === 'unrecognized')) return { approved: null, reason: 'unrecognized', ...ambiguousCounts };
  if (markers.length > 1) return { approved: null, reason: 'multiple', ...ambiguousCounts };
  if (countsMalformed) return { approved: null, reason: 'counts_malformed', ...ambiguousCounts };
  if (blocking === undefined || medium === undefined || low === undefined) return { approved: null, reason: 'counts_conflict', ...base };
  return { approved: true, reason: 'approved', ...base };
}

module.exports = {
  PROVENANCE,
  isAgentVerdict,
  isOperatorGenerated,
  countsAsApproval,
  countsAsAcceptanceEvidence,
  syntheticFeedback,
  parseStructuredVerdict,
};
