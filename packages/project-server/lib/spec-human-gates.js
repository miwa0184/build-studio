'use strict';

/**
 * Finding the human-only requirements a spec contains, BEFORE a run starts.
 *
 * `needs-attention.js` already knows about human gates that are workflow STEPS
 * (`demo_review`) — the engine defines those, so it can stop at them. This
 * module is about the other kind: a requirement written in prose inside a PRD
 * or companion spec, which the engine cannot see at all.
 *
 * Those are the expensive ones. A QA spec authored by an agent said "a second
 * person reviews the fixture diff for sensitive data and records reviewer/date
 * in the manifest". No agent can satisfy that. It was reported BLOCKING in all
 * seven code-review rounds of a run, the dev correctly refused to fabricate a
 * reviewer each time, and the run hit its round cap having found zero product
 * defects (fazon PRD-105, 2026-08-09). Nothing surfaced it, because to the
 * engine it was just another blocking finding.
 *
 * The owner's rule, and the design here: a human gate is legitimate and should
 * be highlighted, not removed — but it belongs at the START, listed and
 * resolved before the run begins. What surfaces mid-run should stop the run and
 * be resolved ad hoc, not be handed to an agent that can only refuse it.
 *
 * This module does the listing half. It is deliberately advisory: it reports
 * what it found and never blocks a start on its own. A false positive that
 * costs a glance is the acceptable direction; the failure being prevented is
 * eight rounds of an unwinnable loop.
 */

const { assertInside } = require('./path-guard');

/**
 * Phrases that mark a requirement only a person can discharge.
 *
 * Each needs to be specific enough that ordinary spec prose does not trip it.
 * "review" alone is hopeless — every spec says it a dozen times about agents.
 * What distinguishes a human gate is a SECOND party, a recorded identity, or an
 * explicit contrast with what automation checks.
 */
const PATTERNS = [
  { re: /\ba second person\b/i, why: 'requires a second person' },
  { re: /\bsecond[- ]person\b/i, why: 'requires a second person' },
  { re: /\bhuman reviewer\b/i, why: 'names a human reviewer' },
  { re: /\brequires? a human\b/i, why: 'requires a human' },
  // "manual schema review", "manual corpus review" — the noun between the two
  // words is the norm in these specs, not the exception.
  { re: /\bmanual (?:\w+ ){0,2}(?:review|judgment|judgement|sign-?off|verification|inspection)\b/i, why: 'requires a manual review' },
  { re: /\bmanually (?:review|verify|confirm|inspect|sign)\b/i, why: 'requires a manual review' },
  { re: /\bsign-?off\b/i, why: 'requires a sign-off' },
  { re: /\battestation\b/i, why: 'requires an attestation' },
  { re: /\brecords? reviewer\b/i, why: 'requires a recorded reviewer identity' },
  { re: /\breviewer (?:identity|name)\b/i, why: 'requires a recorded reviewer identity' },
  { re: /\bowner (?:decision|judgment|judgement|approval)\b/i, why: 'is an owner decision' },
];

/**
 * Lines that look like a human gate is being RULED OUT rather than imposed.
 *
 * A spec that has already replaced its attestation says so in the same
 * vocabulary — "enforced mechanically, not by attestation", "no human
 * attestation is recorded because none is required". Re-reporting those as
 * gates would train the owner to ignore this list, which costs more than
 * missing one.
 */
const NEGATIONS = [
  /\bnot by attestation\b/i,
  /\bno human attestation\b/i,
  /\bnone is required\b/i,
  /\bwithout (?:a )?(?:human|manual|second[- ]person)\b/i,
  /\benforced mechanically\b/i,
  /\bdoes not (?:require|need) a (?:human|second person|manual)\b/i,
  /\bno longer requires?\b/i,
];

function isNegated(line) {
  return NEGATIONS.some((re) => re.test(line));
}

/**
 * Human gates in one document.
 *
 * Markdown quote/code context is not stripped: a gate stated inside a fenced
 * block is still a gate someone has to discharge, and the quote shown to the
 * owner carries enough context to judge.
 *
 * @param {string} text
 * @param {string} path  reported back so the owner knows where to look
 * @returns {{path:string, line:number, quote:string, why:string}[]}
 */
function findHumanGates(text, path) {
  const out = [];
  const lines = String(text || '').split('\n');
  const seen = new Set();
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || isNegated(line)) return;
    for (const { re, why } of PATTERNS) {
      if (!re.test(line)) continue;
      // One finding per line — several patterns matching the same sentence is
      // one gate, not three.
      const key = `${path}:${i + 1}`;
      if (seen.has(key)) break;
      seen.add(key);
      out.push({
        path,
        line: i + 1,
        why,
        quote: line.length > 240 ? `${line.slice(0, 237)}…` : line,
      });
      break;
    }
  });
  // Markdown hard-wraps prose, so one sentence — "A second person reviews the
  // fixture diff … / records reviewer/date in the manifest." — lands on two
  // lines and trips two patterns. That is one thing to do, so consecutive hits
  // collapse into the first.
  return out.filter((g, i) => i === 0 || g.line > out[i - 1].line + 1);
}

/**
 * Scan a document set. IO is injected so the rules stay testable.
 *
 * @param {string[]} paths        repo-relative paths, missing ones skipped
 * @param {{readFileSync:Function, existsSync:Function}} fs
 * @param {string} rootDir
 * @param {number} [limit]        cap on reported gates (the rest are counted)
 */
function scanSpecsForHumanGates(paths, fs, rootDir, limit = 20) {
  const gates = [];
  for (const rel of paths || []) {
    if (!rel) continue;
    // Every path here is untrusted. The list is built from a request parameter,
    // from a `prd:` frontmatter value, and from a regex over PRD body text —
    // all of them repo content that agents write. An earlier revision resolved
    // absolute paths as given and joined relative ones without a containment
    // check, so `prd: ../../../../etc/hosts.md` or an absolute path read that
    // file and returned every matching LINE in the API response. Reading is the
    // whole job of this module, so the guard has to be here rather than at the
    // one caller that happens to exist today.
    let abs;
    try {
      abs = assertInside(rel, rootDir);
    } catch { continue; }   // outside the project — not a gate, not an error
    let text;
    try {
      if (!fs.existsSync(abs)) continue;
      text = fs.readFileSync(abs, 'utf8');
    } catch { continue; }
    gates.push(...findHumanGates(text, rel));
  }
  // Report the cap rather than silently truncating — a list that says "20 of
  // 34" is actionable; a list that quietly shows 20 reads as "there are 20".
  return { gates: gates.slice(0, limit), total: gates.length, truncated: gates.length > limit };
}

module.exports = { findHumanGates, scanSpecsForHumanGates, PATTERNS, NEGATIONS };
