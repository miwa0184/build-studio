'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyStalledAgent, isAwaitingInput } = require('./agent-stalled');

// Real pane tails, trimmed. The discriminator is what the pane ENDS with.
const WORKING = '✻ Whirlpooling… (1m 6s · ↓ 4.0k tokens)\n⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for agents';
const WAITING = '### Action Items\n- [ ] (none)\n❯\n⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents';
const EXPIRED = '⏺ Login expired · Please run /login\n✻ Cogitated for 41s\n❯\n⏵⏵ bypass permissions on';
const LONG = 10 * 60 * 1000;

test('a working agent is never flagged, however long it has run', () => {
  assert.equal(classifyStalledAgent({ paneText: WORKING, idleMs: LONG, hasFeedback: false }), null);
});

test('an agent that already reported is never flagged', () => {
  assert.equal(classifyStalledAgent({ paneText: WAITING, idleMs: LONG, hasFeedback: true }), null);
});

test('auth expiry is caught, and does not wait out the confirmation window', () => {
  // The message is terminal — waiting two minutes to say so helps nobody, and
  // this one blocked three agents for 39 minutes with nothing surfacing it.
  const r = classifyStalledAgent({ paneText: EXPIRED, idleMs: 0, hasFeedback: false });
  assert.equal(r.reason, 'auth_blocked');
  assert.match(r.action, /\/login/);
  assert.match(r.detail, /every other agent in this step is likely blocked/);
});

test('the other auth and quota shapes are covered', () => {
  for (const t of ['Invalid API key · Please run /login', 'Your credit balance is too low', 'usage limit reached', 'session limit reached · resets 3pm']) {
    const r = classifyStalledAgent({ paneText: `${t}\n❯`, idleMs: 0, hasFeedback: false });
    assert.equal(r && r.reason, 'auth_blocked', t);
  }
});

test('finished-but-not-reported needs the recoverable report to claim it', () => {
  const r = classifyStalledAgent({ paneText: WAITING, idleMs: LONG, hasFeedback: false, hasRecoverableReport: true });
  assert.equal(r.reason, 'finished_not_reported');
  assert.match(r.action, /Recover/);
});

test('a bare prompt with nothing recoverable is reported as the weaker case', () => {
  const r = classifyStalledAgent({ paneText: WAITING, idleMs: LONG, hasFeedback: false });
  assert.equal(r.reason, 'agent_waiting');
  // Must not imply a diagnosis it does not have, or offer an action that would
  // silently discard work.
  assert.doesNotMatch(r.action, /Recover/);
});

test('a brief pause between tool calls is not a stall', () => {
  assert.equal(classifyStalledAgent({ paneText: WAITING, idleMs: 5000, hasFeedback: false }), null);
});

test('an unreadable pane proves nothing and is never flagged', () => {
  for (const t of ['', '   ', null, undefined]) {
    assert.equal(classifyStalledAgent({ paneText: t, idleMs: LONG, hasFeedback: false }), null);
  }
});

test('isAwaitingInput keys off positive evidence of working', () => {
  assert.equal(isAwaitingInput(WORKING), false);
  assert.equal(isAwaitingInput(WAITING), true);
  assert.equal(isAwaitingInput(''), false);   // no evidence either way
});
