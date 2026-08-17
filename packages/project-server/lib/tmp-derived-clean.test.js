'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs, registryScanDirs, isDerivedDataRoot } = require('./tmp-derived-clean');

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

/** A directory carrying the DerivedData signature: info.plist + Build/. */
function makeDerivedData(root, name) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'Build'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'info.plist'), '<plist/>');
  return dir;
}

test('defaults to /private/tmp when no directory is given', () => {
  assert.deepEqual(parseArgs([]).dirs, ['/private/tmp']);
});

test('--tmp-dir still works — existing LaunchAgents depend on it', () => {
  assert.deepEqual(parseArgs(['--tmp-dir', '/a']).dirs, ['/a']);
});

test('--dir is repeatable and replaces the default', () => {
  assert.deepEqual(parseArgs(['--dir', '/a', '--dir', '/b']).dirs, ['/a', '/b']);
});

test('duplicate scan dirs collapse — a second pass would re-du deleted dirs', () => {
  assert.deepEqual(parseArgs(['--dir', '/a', '--dir', '/a']).dirs, ['/a']);
});

test('registry scanning finds project build dirs that exist', () => {
  const root = tmpdir('reg');
  const proj = path.join(root, 'proj-a');
  fs.mkdirSync(path.join(proj, 'ios', 'build'), { recursive: true });
  const registry = path.join(root, 'registry.json');
  fs.writeFileSync(registry, JSON.stringify({
    version: 1,
    projects: {
      'proj-a': { path: proj },
      'proj-gone': { path: path.join(root, 'does-not-exist') },
    },
  }));

  const dirs = registryScanDirs(registry);
  assert.deepEqual(dirs, [path.join(proj, 'ios', 'build')]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a missing or malformed registry yields no dirs rather than throwing', () => {
  assert.deepEqual(registryScanDirs('/nope/registry.json'), []);
  const root = tmpdir('badreg');
  const bad = path.join(root, 'r.json');
  fs.writeFileSync(bad, 'not json');
  assert.deepEqual(registryScanDirs(bad), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('--scan-projects appends registry dirs to the default scan', () => {
  const root = tmpdir('reg2');
  const proj = path.join(root, 'p');
  fs.mkdirSync(path.join(proj, 'ios', 'build'), { recursive: true });
  const registry = path.join(root, 'r.json');
  fs.writeFileSync(registry, JSON.stringify({ projects: { p: { path: proj } } }));

  const opts = parseArgs(['--scan-projects', '--registry', registry]);
  assert.ok(opts.dirs.includes('/private/tmp'), 'keeps the default');
  assert.ok(opts.dirs.includes(path.join(proj, 'ios', 'build')), 'adds the project dir');
  fs.rmSync(root, { recursive: true, force: true });
});

// The signature is the only thing standing between this reaper and a web
// project's build output, which `--scan-projects` now walks into.
test('only a real DerivedData root is recognised', () => {
  const root = tmpdir('sig');
  const real = makeDerivedData(root, 'DerivedDataReal');
  assert.equal(isDerivedDataRoot(real), true);

  const webBuild = path.join(root, 'dist');
  fs.mkdirSync(path.join(webBuild, 'Build'), { recursive: true });
  assert.equal(isDerivedDataRoot(webBuild), false, 'Build/ alone is not enough');

  const plistOnly = path.join(root, 'plistonly');
  fs.mkdirSync(plistOnly, { recursive: true });
  fs.writeFileSync(path.join(plistOnly, 'info.plist'), '<plist/>');
  assert.equal(isDerivedDataRoot(plistOnly), false, 'info.plist alone is not enough');

  assert.equal(isDerivedDataRoot(path.join(root, 'missing')), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('guard-minutes rejects nonsense and falls back to the default', () => {
  assert.equal(parseArgs(['--guard-minutes', 'abc']).guardMinutes, 180);
  assert.equal(parseArgs(['--guard-minutes', '-5']).guardMinutes, 180);
  assert.equal(parseArgs(['--guard-minutes', '30']).guardMinutes, 30);
});
