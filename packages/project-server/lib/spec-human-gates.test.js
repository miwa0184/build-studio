'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findHumanGates, scanSpecsForHumanGates } = require('./spec-human-gates');

// The sentence that cost eight rounds, verbatim from QA-105 §5.5.
const REAL = `### 5.5 Synthetic-only and deterministic gate

The corpus is generated only from authored synthetic records.

A second person reviews the fixture diff for sensitive data before commit and
records reviewer/date in the manifest. PREC-CORPUS-03 generates the corpus twice.
`;

test('it finds the gate that an eight-round loop could not clear', () => {
  const gates = findHumanGates(REAL, 'docs/qa/QA-105.md');
  assert.equal(gates.length, 1);
  assert.equal(gates[0].path, 'docs/qa/QA-105.md');
  assert.match(gates[0].quote, /A second person reviews the fixture diff/);
  assert.equal(gates[0].why, 'requires a second person');
});

test('one sentence matching several patterns is one gate, not several', () => {
  // "manual sign-off by a human reviewer" trips three patterns; the owner has
  // one thing to do.
  const gates = findHumanGates('AC-5 needs a manual sign-off by a human reviewer.', 'p.md');
  assert.equal(gates.length, 1);
});

test('a spec that has REPLACED its gate is not reported as having one', () => {
  // The post-fix wording deliberately reuses the same vocabulary. Re-reporting
  // it would train the owner to ignore the list.
  const fixed = `The four properties above are enforced mechanically, not by attestation.
No human attestation is recorded because none is required.`;
  assert.deepEqual(findHumanGates(fixed, 'p.md'), []);
});

test('ordinary spec prose about agent review does not trip it', () => {
  const ordinary = `The Code Reviewer reviews the diff and reports findings.
A review round follows each fix. Reviewers must not raise blocking findings about specs.
The QA agent reviews test output, not methodology.`;
  assert.deepEqual(findHumanGates(ordinary, 'p.md'), []);
});

test('it catches the variants that mean the same thing', () => {
  const cases = [
    ['AC-5 requires a manual schema review against PRD §2.2.', 'requires a manual review'],
    ['A human reviewer must confirm the mapping.', 'names a human reviewer'],
    ['This requires a human to inspect the output.', 'requires a human'],
    ['Release needs security sign-off before merge.', 'requires a sign-off'],
    ['Record reviewer identity and date in the manifest.', 'requires a recorded reviewer identity'],
    ['This is an owner decision, not an agent one.', 'is an owner decision'],
  ];
  for (const [line, why] of cases) {
    const g = findHumanGates(line, 'p.md');
    assert.equal(g.length, 1, line);
    assert.equal(g[0].why, why, line);
  }
});

test('line numbers point at the gate so it can be opened', () => {
  const gates = findHumanGates(REAL, 'q.md');
  assert.equal(gates[0].line, 5);
});

test('a very long line is truncated with an ellipsis, not dropped', () => {
  const long = `A second person ${'x'.repeat(400)}`;
  const g = findHumanGates(long, 'p.md');
  assert.equal(g.length, 1);
  assert.ok(g[0].quote.length <= 240);
  assert.match(g[0].quote, /…$/);
});

test('scanning skips missing files instead of throwing', () => {
  const fs = {
    existsSync: (p) => p.endsWith('there.md'),
    readFileSync: () => 'A second person must approve.',
  };
  const r = scanSpecsForHumanGates(['gone.md', 'there.md'], fs, '/root');
  assert.equal(r.total, 1);
  assert.equal(r.gates[0].path, 'there.md');
});

test('an unreadable file degrades to skipping it, not to failing the scan', () => {
  const fs = {
    existsSync: () => true,
    readFileSync: (p) => { if (p.includes('bad')) throw new Error('EACCES'); return 'A second person signs.'; },
  };
  const r = scanSpecsForHumanGates(['bad.md', 'ok.md'], fs, '/root');
  assert.equal(r.total, 1);
  assert.equal(r.gates[0].path, 'ok.md');
});

test('the cap is reported rather than silently applied', () => {
  // Blank-line separated so they stay distinct gates rather than collapsing.
  const fs = { existsSync: () => true, readFileSync: () => Array(30).fill('A second person approves.').join('\n\n') };
  const r = scanSpecsForHumanGates(['a.md'], fs, '/root', 5);
  assert.equal(r.gates.length, 5);
  assert.equal(r.total, 30);
  assert.equal(r.truncated, true);
});
