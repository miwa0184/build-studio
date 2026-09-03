'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveNameInProjects } = require('@build-studio/shared/registry');

// ─── resolveNameInProjects — canonicalizes a URL-derived project name against
//     an in-memory `projects` map. Pure function, no disk I/O: keeps these
//     tests from ever touching the real ~/.build-studio/registry.json. ──────

test('exact match wins immediately, no decoding attempted', () => {
  const projects = { 'Sample Project': { path: '/a', port: 3001 } };
  assert.equal(resolveNameInProjects(projects, 'Sample Project'), 'Sample Project');
});

test('once-encoded space resolves to the canonical registered key', () => {
  const projects = { 'Sample Project': { path: '/a', port: 3001 } };
  assert.equal(resolveNameInProjects(projects, 'Sample%20Project'), 'Sample Project');
});

test('once-encoded parentheses resolve to the canonical registered key', () => {
  const projects = { 'Sample Project (beta)': { path: '/b', port: 3002 } };
  assert.equal(
    resolveNameInProjects(projects, 'Sample%20Project%20(beta)'),
    'Sample Project (beta)'
  );
});

test('exact key wins even when it looks like a percent-encoded literal', () => {
  const projects = {
    'Sample%20Project': { path: '/literal', port: 4000 },
    'Sample Project': { path: '/decoded', port: 4001 },
  };
  // The raw name is itself a registered key — must not be decoded further.
  assert.equal(resolveNameInProjects(projects, 'Sample%20Project'), 'Sample%20Project');
});

test('malformed percent-encoding fails closed (no match, no throw)', () => {
  const projects = { 'Sample Project': { path: '/a', port: 3001 } };
  assert.doesNotThrow(() => {
    assert.equal(resolveNameInProjects(projects, 'Quiet%2'), null);
    assert.equal(resolveNameInProjects(projects, '%E0%A4%A'), null);
  });
});

test('unknown name (exact or decoded) resolves to null', () => {
  const projects = { 'Sample Project': { path: '/a', port: 3001 } };
  assert.equal(resolveNameInProjects(projects, 'Nope'), null);
  assert.equal(resolveNameInProjects(projects, 'No%20Such%20Project'), null);
});

test('decoding is attempted at most once — a double-encoded name does not resolve', () => {
  // "Quiet%2520Nine" decodes once to "Sample%20Project", which is not a registered
  // key unless it is itself literally registered — decoding must not recurse.
  const projects = { 'Sample Project': { path: '/a', port: 3001 } };
  assert.equal(resolveNameInProjects(projects, 'Quiet%2520Nine'), null);
});

test('decoding cannot alias one existing key onto a different existing key', () => {
  // Both "Sample Project" and "Sample%20Project" are independently registered.
  // Resolving the encoded literal must return itself (exact-match precedence),
  // never fall through to the other key.
  const projects = {
    'Sample Project': { path: '/decoded', port: 3001 },
    'Sample%20Project': { path: '/literal', port: 3002 },
  };
  assert.equal(resolveNameInProjects(projects, 'Sample%20Project'), 'Sample%20Project');
  assert.equal(resolveNameInProjects(projects, 'Sample Project'), 'Sample Project');
});

test('a decoded path-traversal attempt only resolves if it happens to be a real registered key', () => {
  const projects = { 'Sample Project': { path: '/a', port: 3001 } };
  assert.equal(resolveNameInProjects(projects, '..%2F..%2Fetc%2Fpasswd'), null);
});

test('prototype-polluting names never resolve via inherited properties', () => {
  const projects = { 'Sample Project': { path: '/a', port: 3001 } };
  assert.equal(resolveNameInProjects(projects, '__proto__'), null);
  assert.equal(resolveNameInProjects(projects, 'constructor'), null);
  assert.equal(resolveNameInProjects(projects, 'toString'), null);
});
