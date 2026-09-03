const fs = require('fs');
const path = require('path');
const { BUILD_STUDIO_DIR, REGISTRY_PATH, DEFAULT_PROJECT_PORT_START } = require('./constants');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load() {
  ensureDir(BUILD_STUDIO_DIR);
  if (!fs.existsSync(REGISTRY_PATH)) {
    return { version: 1, projects: {} };
  }
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
}

function save(registry) {
  ensureDir(BUILD_STUDIO_DIR);
  const tmp = REGISTRY_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2));
  fs.renameSync(tmp, REGISTRY_PATH);
}

function list() {
  const reg = load();
  return Object.entries(reg.projects).map(([name, info]) => ({ name, ...info }));
}

/**
 * Resolve a URL-derived project name to the canonical key registered in
 * `projects`. An exact key always wins without decoding. Otherwise the name
 * is decoded exactly once (no recursive decoding) and matched against
 * `projects`; a malformed percent-encoding or a decoded value that isn't
 * itself a registered key fails closed (returns null) rather than throwing
 * or guessing. Pure and disk-free so it can be unit-tested directly.
 */
function resolveNameInProjects(projects, name) {
  if (Object.prototype.hasOwnProperty.call(projects, name)) return name;
  let decoded;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    return null;
  }
  if (decoded !== name && Object.prototype.hasOwnProperty.call(projects, decoded)) {
    return decoded;
  }
  return null;
}

function resolveName(name) {
  const reg = load();
  return resolveNameInProjects(reg.projects, name);
}

function get(name) {
  const reg = load();
  const canonical = resolveNameInProjects(reg.projects, name);
  if (!canonical) return null;
  return { name: canonical, ...reg.projects[canonical] };
}

function add(name, projectPath, port, workspace = null) {
  const reg = load();
  reg.projects[name] = {
    path: projectPath,
    port,
    ...(workspace ? { workspace } : {}),
    addedAt: new Date().toISOString(),
  };
  save(reg);
  return reg.projects[name];
}

/**
 * List projects grouped by workspace. Projects with no workspace go in the
 * default group (null key).
 */
function listByWorkspace() {
  const all = list();
  const groups = new Map();
  for (const p of all) {
    const ws = p.workspace || null;
    if (!groups.has(ws)) groups.set(ws, []);
    groups.get(ws).push(p);
  }
  return groups;
}

/**
 * Check for name collision — returns existing entry if a project with the
 * same name (but possibly a different workspace) exists.
 */
function findByName(name) {
  return get(name);
}

function remove(name) {
  const reg = load();
  const canonical = resolveNameInProjects(reg.projects, name);
  if (!canonical) return false;
  delete reg.projects[canonical];
  save(reg);
  return true;
}

function nextAvailablePort() {
  const reg = load();
  const usedPorts = Object.values(reg.projects).map(p => p.port);
  let port = DEFAULT_PROJECT_PORT_START;
  while (usedPorts.includes(port)) port++;
  return port;
}

/**
 * Find a project by path (for registering existing projects).
 */
function findByPath(projectPath) {
  const reg = load();
  const resolved = path.resolve(projectPath);
  for (const [name, info] of Object.entries(reg.projects)) {
    if (path.resolve(info.path) === resolved) return { name, ...info };
  }
  return null;
}

module.exports = {
  load, save, list, get, add, remove, nextAvailablePort, findByPath, listByWorkspace, findByName,
  resolveName,
  // Exported for unit tests.
  resolveNameInProjects,
};
