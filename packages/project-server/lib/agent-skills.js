'use strict';

/**
 * Making role definitions and skills reachable for agents that are not Claude.
 *
 * Build Studio scaffolds a project's role definitions into `.claude/commands/`
 * and its workflow skills into `.claude/skills/` (see onboard.js), and the step
 * prompts refer to them by name: "Use the /qa skill", "Use the
 * `qa-browser-testing` skill for any browser-based verification".
 *
 * Those are Claude Code paths. A codex or opencode agent cannot load either, so
 * for those CLIs the reference is not merely unhelpful — it names a capability
 * the agent does not have and cannot get. What it does instead is substitute
 * something of its own, and that substitute is chosen without any knowledge of
 * what the project actually provides.
 *
 * Observed end-to-end on a hello-world bugfix (HW-003, 2026-08-09). The codex QA
 * agent said so itself:
 *
 *   "The requested /qa and qa-browser-testing skills aren't available in this
 *    session, so I'll follow the supplied QA protocol directly."
 *   "I'm using the available in-app browser control skill for that verification
 *    (the specifically requested qa-browser-testing skill is absent)."
 *
 * It reached for codex's own bundled browser runtime — whose instructions
 * explicitly say to try it "before falling back to standalone Playwright" —
 * got `No browser is available` in a headless tmux pane, and reported the gap as
 * a BLOCKING defect. `playwright-cli`, which the absent skill documents and
 * which was installed the whole time, was never invoked once. Two fix rounds
 * followed, none of which could have helped: the one-character typo the run was
 * about had been correctly fixed in the first commit.
 *
 * So the reference is resolved here instead, at the single point where the
 * agent's CLI is known, and the file's contents are appended to the prompt for
 * any CLI that cannot read it natively.
 *
 * Resolution is by existence, never by a hardcoded list: a name is inlined only
 * when a matching file is actually on disk in this project. A list would drift
 * silently every time a project adds a role, and the failure mode of drift here
 * is exactly the one this module exists to remove.
 */

const path = require('path');

/** Which CLIs load `.claude/commands` and `.claude/skills` natively. */
const NATIVE_CLAUDE_DIR_CLIS = new Set(['claude']);

/**
 * Cap on inlined bytes per prompt. Role files run 4-7 KB and skills 4-13 KB, so
 * a role plus a skill is ~3k tokens — cheap against an agent that would
 * otherwise run with no role definition at all. The cap exists only to stop a
 * pathological project (a 200 KB skill) from crowding out the task itself.
 */
const MAX_INLINE_BYTES = 40 * 1024;

/**
 * Command references: `/qa`, `/fix_planner`, `/ios_dev`.
 *
 * Anchored on a word boundary before the slash so path segments (`docs/qa/…`,
 * `e2e/support/…`) cannot match — those are the common false positive, and one
 * of them would inline a role file into a prompt that never asked for it.
 */
const COMMAND_REF = /(?:^|[\s(*_"'`])\/([a-z][a-z0-9_-]*)\b/g;

/** Skill references, which the prompts always write in backticks. */
const SKILL_REF = /`([a-z][a-z0-9-]*)`\s+skill/g;

function uniq(xs) {
  return [...new Set(xs)];
}

/**
 * Names referenced by an instruction, split by kind. Pure — no IO — so the
 * matching rules can be tested without a project on disk.
 */
function referencedNames(instruction) {
  const text = String(instruction || '');
  const commands = [];
  const skills = [];
  for (const m of text.matchAll(COMMAND_REF)) commands.push(m[1]);
  for (const m of text.matchAll(SKILL_REF)) skills.push(m[1]);
  // A backticked name may also appear with a leading slash elsewhere in the
  // same prompt; commands win, since the command file is the role definition.
  return { commands: uniq(commands), skills: uniq(skills.filter((s) => !commands.includes(s))) };
}

/**
 * Resolve referenced names to files that exist in THIS project.
 *
 * `roots` is tried in order, so a worktree's own copy wins over the main
 * checkout's when a branch edits a role file — but a worktree that lacks
 * `.claude/` entirely (untracked in some projects) still resolves against the
 * project root instead of silently finding nothing.
 *
 * @param {string} instruction
 * @param {{roots:string[], fs:object}} ctx
 * @returns {{kind:'command'|'skill', name:string, file:string}[]}
 */
function resolveReferences(instruction, { roots, fs }) {
  const { commands, skills } = referencedNames(instruction);
  const dirs = uniq((roots || []).filter(Boolean));
  const firstExisting = (rel) => {
    for (const root of dirs) {
      const file = path.join(root, ...rel);
      if (fs.existsSync(file)) return file;
    }
    return null;
  };
  const found = [];
  for (const name of commands) {
    const file = firstExisting(['.claude', 'commands', `${name}.md`]);
    if (file) found.push({ kind: 'command', name, file });
  }
  for (const name of skills) {
    const file = firstExisting(['.claude', 'skills', name, 'SKILL.md']);
    if (file) found.push({ kind: 'skill', name, file });
  }
  return found;
}

/**
 * The text to append to an instruction so a non-Claude agent has the definitions
 * its prompt refers to. Returns '' when there is nothing to add — for a claude
 * agent (which loads them itself), or when nothing referenced exists on disk.
 *
 * The heading says the reference was resolved rather than unavailable, because
 * an agent told "the skill is missing" reasons its way to a substitute, which is
 * precisely the behaviour that produced the false blocker.
 *
 * @param {string} instruction
 * @param {{cli:string, roots:string[], fs:object, maxBytes?:number}} ctx
 */
function inlineReferencedDefinitions(instruction, { cli, roots, fs, maxBytes = MAX_INLINE_BYTES }) {
  if (NATIVE_CLAUDE_DIR_CLIS.has(cli)) return '';
  let refs;
  try { refs = resolveReferences(instruction, { roots, fs }); } catch { return ''; }
  if (!refs.length) return '';

  const parts = [];
  let budget = maxBytes;
  const skipped = [];
  for (const ref of refs) {
    let body;
    try { body = fs.readFileSync(ref.file, 'utf8'); } catch { continue; }
    if (body.length > budget) { skipped.push(ref.name); continue; }
    budget -= body.length;
    const label = ref.kind === 'command' ? `/${ref.name}` : `\`${ref.name}\``;
    parts.push(`### ${label} (${ref.kind})\n\n${body.trim()}`);
  }
  if (!parts.length) return '';

  const note = skipped.length
    ? `\n\nNot inlined (too large for the prompt budget): ${skipped.join(', ')}. Read the file directly if you need it.`
    : '';

  return `\n\n---\n\n## ROLE DEFINITIONS AND SKILLS REFERRED TO ABOVE\n\n`
    + `Your instructions reference these by name. They live under \`.claude/\`, which your CLI does not load, `
    + `so their full contents are included here. **This is the definitive version — follow it.** `
    + `Do not treat any of them as unavailable, and do not substitute a similar-sounding capability of your own `
    + `(a browser runtime, a built-in review mode) for what is written below.${note}\n\n`
    + parts.join('\n\n');
}

module.exports = {
  inlineReferencedDefinitions,
  resolveReferences,
  referencedNames,
  NATIVE_CLAUDE_DIR_CLIS,
  MAX_INLINE_BYTES,
};
