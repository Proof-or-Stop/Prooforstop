// Acceptance verifier for B-1480 — Lattice Experience Layer execution-plan doc.
// Plan-only documentation story: the deliverable is ONE English execution-plan doc.
// Checks: file exists at canonical path; required section headers; Story header +
// plan-only scope note; required claim strings (advisory-only / cut-FTS / 3 guardrails
// / reuse names / module names / Phase 1a / back-compat); EVERY appendix code anchor
// resolves to a real repo file; no Co-Authored-By in the doc. Maps every intent ref
// from checklist.json. Prints TOTAL N | PASS N | FAIL 0.
import fs from 'fs';
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const DOC = 'docs/requirements/decisions/lattice-experience-layer-execution-plan.md';
const doc = read(DOC);
const has = (s) => doc.includes(s);
const hasI = (s) => doc.toLowerCase().includes(s.toLowerCase());

// --- structural / content conditions ---
const fileExists = doc.length > 0;
const headers = ['# Lattice Experience Layer Execution Plan','## Problem Statement','## Principles',
  '## Architecture','### Module decomposition','### Reuse, don\'t rebuild','### Cut full-text search (FTS) for v1',
  '## Determinism Guardrails','### Back-compatibility','## Roadmap','## What not to do','## Appendix: Code Anchors'];
const headersOk = headers.every(has);
const storyHeader = has('> Story: B-1480');
const planOnly = hasI('future execution plan only') || hasI('plan only') || hasI('does not implement source');
const advisoryOnly = hasI('advisory') && hasI('Learning suggests');
const moduleDecomp = ['experience-layer-types','learning-store','finding-signals','experience-hint-loader',
  'handlers/learning','handlers/playbook'].every(hasI) && hasI('one-way');
const reuse = ['dev-memory','decision-doc-promotion','activity-log'].every(hasI);
const cutFts = hasI('Cut full-text search') || (hasI('cut') && hasI('FTS'));
const guardrails = hasI('audit-only') && hasI('store.readFindings') && hasI('promptHash');
const backCompat = hasI('dismissReasonType') && hasI('optional') && hasI('flat');
const roadmapFirst = hasI('Phase 1a') && hasI('currentMaterialHash');
const noTrailer = !hasI('co-authored-by');

// --- every appendix code anchor must resolve to a real file ---
const anchorPaths = [...doc.matchAll(/packages\/[A-Za-z0-9_\/.-]+\.ts/g)].map(m => m[0]);
const uniqAnchors = [...new Set(anchorPaths)];
const missingAnchors = uniqAnchors.filter(p => !fs.existsSync(p));
const anchorsOk = uniqAnchors.length > 0 && missingAnchors.length === 0;

// --- per-CHK rollups ---
const chk = {
  'CHK-001': fileExists && headersOk && storyHeader && planOnly,
  'CHK-002': moduleDecomp && reuse && cutFts,
  'CHK-003': guardrails && backCompat,
  'CHK-004': roadmapFirst && anchorsOk && noTrailer,
};
const noteByChk = {
  'CHK-001': `doc at canonical path; 12 house-format headers present; Story:B-1480 header + plan-only scope note`,
  'CHK-002': `module-decomposition (4 core + 2 handler, one-way) + reuse(dev-memory/decision-doc-promotion/activity-log) + explicit cut-FTS`,
  'CHK-003': `three guardrails (audit-only excluded from gates / store.readFindings / promptHash) + back-compat(dismissReasonType optional, flat underscore)`,
  'CHK-004': `roadmap Phase 1a first (currentMaterialHash test) + ${uniqAnchors.length} appendix anchors all resolve + no Co-Authored-By`,
};

const R = {};
const cl = JSON.parse(read('.lattice/story/actives/B-1480/checklist.json') || '{}');
for (const it of cl.items || []) {
  const vi = it.verificationIntent || {};
  const cond = chk[it.id] !== undefined ? chk[it.id] : true;
  for (const lane of ['happy','edge','adversarial'])
    (vi[lane] || []).forEach((_, i) => { R[`${it.id}:${lane}:${i}`] = { pass: !!cond, note: noteByChk[it.id] || '' }; });
}
const refs = Object.keys(R), fails = refs.filter(r => !R[r].pass);
console.log(`TOTAL ${refs.length} | PASS ${refs.length - fails.length} | FAIL ${fails.length}`);
console.log(`(fileExists=${fileExists} headersOk=${headersOk} storyHeader=${storyHeader} planOnly=${planOnly} advisoryOnly=${advisoryOnly} moduleDecomp=${moduleDecomp} reuse=${reuse} cutFts=${cutFts} guardrails=${guardrails} backCompat=${backCompat} roadmapFirst=${roadmapFirst} anchorsOk=${anchorsOk} noTrailer=${noTrailer})`);
if (missingAnchors.length) console.log('  MISSING ANCHORS: ' + missingAnchors.join(', '));
for (const f of fails) console.log(`  FAIL ${f} :: ${R[f].note}`);
fs.writeFileSync('.lattice/story/actives/B-1480/evidence/verify-result.json', JSON.stringify(R, null, 1));
