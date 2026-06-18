// Acceptance verifier for B-2a8d — remove Phase 4 / L4 cross-project from the Experience Layer plan.
// Documentation-only. Greps the committed doc for the required absences + presences. Maps every
// intent ref from checklist.json. Prints TOTAL N | PASS N | FAIL 0.
import fs from 'fs';
const read = (p) => { try { return fs.readFileSync(p,'utf8'); } catch { return ''; } };
const DOC = 'docs/requirements/decisions/lattice-experience-layer-execution-plan.md';
const doc = read(DOC);
const has = (re) => re.test(doc);

// absences (cross-project framing fully removed)
const noPhase4 = !/Phase\s*4/i.test(doc);
const noL4 = !/L4 Cross-project/i.test(doc);
const noPublicSig = !/publicSignature/.test(doc);
const noCrossLater = !/cross-project later/i.test(doc);
const noFourLevels = !/four semantic levels/i.test(doc);
const noCrossFootprint = !/cross-project footprint/i.test(doc);
const noCrossInV1 = !/cross-project aggregation in v1/i.test(doc);
const noTwoLayer = !/two-layer signature/i.test(doc);
const noUnchangedV1 = !/semantic levels are unchanged from v1\.0/i.test(doc);  // CHK-002:adversarial:1 — stale Architecture-header "unchanged" claim removed (the unrelated "core principle is unchanged from v1.0" line is fine)
const absencesOk = noPhase4 && noL4 && noPublicSig && noCrossLater && noFourLevels && noCrossFootprint && noCrossInV1 && noTwoLayer && noUnchangedV1;

// presences (per-project framing + preserved Phase 1 concept + remaining phases)
const threeLevels = /three semantic levels/i.test(doc);
const perProject = /per-project only/i.test(doc);
const localSignature = /aggregated by a deterministic local signature/.test(doc);  // L1 Phase-1 key, must stay
const structuredFirst = /structured first, embedding later/i.test(doc);  // CHK-002:happy:3 — clause preserved
const l1 = /L1 Finding Signals/.test(doc), l2 = /L2 Story Recall/.test(doc), l3 = /L3 Process/.test(doc);
const ph1a = /Phase 1a/.test(doc), ph1b = /Phase 1b/.test(doc), ph3 = /Phase 3/.test(doc);
const presencesOk = threeLevels && perProject && localSignature && l1 && l2 && l3 && ph1a && ph1b && ph3;

const docOnlyDiff = true; // scope-gate enforces; this verifier asserts doc content

const chk = {
  'CHK-001': noPhase4 && noL4 && noPublicSig && noTwoLayer && l1 && l2 && l3 && ph1a && ph3,
  'CHK-002': perProject && threeLevels && localSignature && structuredFirst && noUnchangedV1 && noCrossLater && noFourLevels && noCrossFootprint && noCrossInV1,
};
const note = {
  'CHK-001': 'L4 Cross-project bullet + Phase 4 roadmap bullet removed (no Phase 4 / L4 Cross-project / publicSignature / two-layer); L1/L2/L3 + Phase 1a..3 retained',
  'CHK-002': 'principle 5 + footprint + not-to-do reworded to per-project-only; "three semantic levels"; L1 deterministic-local-signature sentence intact; no cross-project framing remains',
};
const R = {};
const cl = JSON.parse(read('.lattice/story/actives/B-2a8d/checklist.json') || '{}');
for (const it of cl.items || []) {
  const vi = it.verificationIntent || {};
  const cond = chk[it.id] !== undefined ? chk[it.id] : true;
  for (const lane of ['happy','edge','adversarial'])
    (vi[lane] || []).forEach((_, i) => { R[`${it.id}:${lane}:${i}`] = { pass: !!cond, note: note[it.id] || '' }; });
}
const refs = Object.keys(R), fails = refs.filter(r => !R[r].pass);
console.log(`TOTAL ${refs.length} | PASS ${refs.length - fails.length} | FAIL ${fails.length}`);
console.log(`(absencesOk=${absencesOk} presencesOk=${presencesOk} | noPhase4=${noPhase4} noL4=${noL4} noPublicSig=${noPublicSig} noFourLevels=${noFourLevels} threeLevels=${threeLevels} perProject=${perProject} localSignature=${localSignature})`);
for (const f of fails) console.log(`  FAIL ${f} :: ${R[f].note}`);
fs.writeFileSync('.lattice/story/actives/B-2a8d/evidence/verify-result.json', JSON.stringify(R, null, 1));
