'use strict';

// F3 — the hub is not an autonomous transition driver.
//
// Two independent auto-advance policies used to run against the same workflow:
// the server's 8-second tick, and a React effect in workflow-view.tsx that
// re-derived the next transition from whatever state it had polled and POSTed
// it itself. They disagreed by construction — the client deliberately left
// round-1 reviews manual, the server did not; the client's safety budget lived
// in React state and the server's in process memory — and merely mounting the
// page could carry a run past a halt the server had already decided on.
//
// A1a makes the server the sole autonomous transition authority. The hub may
// render state, render incidents, send an EXPLICIT user action, and toggle the
// server's auto-advance policy. It may not decide a transition, hold a safety
// budget, or re-enable autonomy as a side effect of mounting.
//
// This is a structural test rather than a grep: it walks the source, extracts
// each useEffect body by brace matching, and asserts what those bodies contain.
//
// It lives in project-server, not in the hub, because the invariant belongs to
// the server: this is the server's exclusivity being protected, and the server's
// test suite is what CI already runs as a required check. a1a-canary.test.js
// reads the same file for the same reason.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const VIEW = path.join(__dirname, '..', '..', 'hub', 'components', 'workflow-view.tsx');
const src = fs.readFileSync(VIEW, 'utf8');

/** Return the source of every `useEffect(` call body in `text`. */
function useEffectBodies(text) {
  const bodies = [];
  const re = /useEffect\s*\(/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let depth = 0;
    let i = m.index + m[0].length - 1; // at the '('
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) { bodies.push(text.slice(m.index, i + 1)); break; }
      }
    }
  }
  return bodies;
}

const effects = useEffectBodies(src);

test('the source parses into effects at all (guards the scanner itself)', () => {
  assert.ok(effects.length > 3, `expected several useEffect blocks, found ${effects.length}`);
});

test('no effect posts a workflow transition — the client never advances on its own', () => {
  const offenders = effects.filter((b) => /['"`]\/workflow\/advance['"`]/.test(b));
  assert.deepEqual(
    offenders.map((b) => b.slice(0, 90).replace(/\s+/g, ' ')),
    [],
    'a useEffect posts /workflow/advance — that is an autonomous client transition',
  );
});

test('every /workflow/advance POST is inside the explicit user-action helper', () => {
  const posts = [...src.matchAll(/api\.post\(\s*['"`]\/workflow\/advance['"`]/g)];
  assert.ok(posts.length > 0, 'the hub must still be able to send an explicit user action');

  const helperStart = src.indexOf('async function advanceWorkflow');
  assert.ok(helperStart > 0, 'advanceWorkflow (the explicit user-action helper) must exist');
  // End of the helper: the next top-level `\n  }` after its opening brace.
  const helperEnd = src.indexOf('\n  }\n', helperStart);
  assert.ok(helperEnd > helperStart);

  for (const p of posts) {
    assert.ok(
      p.index > helperStart && p.index < helperEnd,
      `/workflow/advance posted outside advanceWorkflow at offset ${p.index}`,
    );
  }
});

test('the client holds no advance budget of its own', () => {
  for (const symbol of ['AUTO_ADVANCE_MAX_ROUNDS', 'autoAdvanceRound', 'setAutoAdvanceRound']) {
    assert.ok(!src.includes(symbol), `client-side advance budget survives: ${symbol}`);
  }
});

test('the client does not re-derive a verdict into a transition', () => {
  // These action strings are what a decision-making client produced. They may
  // still appear as explicit button handlers, but never assigned into a
  // computed `action` variable that an effect posts.
  assert.ok(!/\baction\s*=\s*['"`]send_to_devs['"`]/.test(src), 'client computes send_to_devs');
  assert.ok(!/\baction\s*=\s*['"`]send_to_pm['"`]/.test(src), 'client computes send_to_pm');
  assert.ok(!/\baction\s*=\s*['"`]launch['"`]/.test(src), 'client computes launch');
  assert.ok(!/strictHasFindings/.test(src), 'client re-implements the strict-review policy');
});

test('mounting does not re-enable server autonomy — no side-loaded enable:true', () => {
  const offenders = effects.filter((b) => /\/workflow\/auto-advance['"`]\s*,\s*\{[^}]*enabled:\s*true/.test(b));
  assert.deepEqual(
    offenders.map((b) => b.slice(0, 90).replace(/\s+/g, ' ')),
    [],
    'an effect POSTs auto-advance enabled:true — mounting the page re-enables autonomy',
  );
});

test('the hub may still toggle the server auto-advance policy from a user action', () => {
  assert.ok(
    /api\.post\(\s*['"`]\/workflow\/auto-advance['"`]/.test(src),
    'the policy toggle is an allowed client capability and must survive',
  );
});
