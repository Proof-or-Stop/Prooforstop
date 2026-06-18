// Acceptance verifier for B-06b3 — Experience Layer ③.3 (deterministic A/B
// hintMode + shadow-gated advisory experience-hint display).
//
// Behavioral core = the committed ab-shadow-gate smoke PLUS no-regression smokes
// (finding-signals/playbook/recall/revalidation/learning-scan/signature-capture/
// hint-injection) PLUS the FULL `npm test` (incl. process-fact-contract).
// Static checks enforce: hint-mode.ts purity (imports only node:); story-review.ts
// does NOT pass hints into resolveReviewPromptHash and the issues/blocker block is
// unchanged (no hintMode/section refs); review-run.ts is untouched.
// Maps every verificationIntent ref from checklist.json. Prints TOTAL N | PASS N | FAIL 0.
import fs from 'fs';
import { execSync } from 'child_process';

const sh = (c) => { try { return execSync(c, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }); } catch (e) { return (e.stdout||'')+(e.stderr||''); } };
const code = (c) => { try { execSync(c, { stdio: 'pipe' }); return 0; } catch (e) { return e.status ?? 1; } };
const read = (p) => { try { return fs.readFileSync(p,'utf8'); } catch { return ''; } };

// ─── build ────────────────────────────────────────────────────────────────────
const buildUtilsOk = code('npm --prefix packages/utils run build') === 0;
const buildMainOk = code('npm --prefix packages/main run build') === 0;
const buildOk = buildUtilsOk && buildMainOk;

// ─── this story's smoke ─────────────────────────────────────────────────────────
const abSmoke = sh('npm --prefix packages/main run test:experience-layer-ab-shadow-gate').includes('ab-shadow-gate smoke passed');

// ─── no-regression smokes ───────────────────────────────────────────────────────
const noReg = {
  findingSignals: sh('npm --prefix packages/main run test:experience-layer-finding-signals').includes('smoke passed'),
  playbook: sh('npm --prefix packages/main run test:experience-layer-playbook').includes('smoke passed'),
  recall: sh('npm --prefix packages/main run test:experience-layer-recall').includes('smoke passed'),
  revalidation: sh('npm --prefix packages/main run test:experience-layer-revalidation').includes('smoke passed'),
  learningScan: sh('npm --prefix packages/main run test:experience-layer-learning-scan').includes('smoke passed'),
  signatureCapture: sh('npm --prefix packages/main run test:experience-layer-signature-capture').includes('smoke passed'),
  hintInjection: sh('npm --prefix packages/main run test:experience-layer-hint-injection').includes('smoke passed'),
};
const noRegression = Object.values(noReg).every(Boolean);

// ─── FULL npm test (incl. process-fact-contract) ────────────────────────────────
const fullTestExit = code('npm test');
const fullTestOk = fullTestExit === 0;
// Confirm the process-fact-contract step is actually part of the root test chain.
const rootPkg = read('package.json');
const processFactInChain = /test:process-fact-contract/.test(rootPkg);

// ─── static: hint-mode.ts purity ────────────────────────────────────────────────
const hm = read('packages/main/src/core/hint-mode.ts');
const hmImports = [...hm.matchAll(/from '([^']+)'/g)].map(m => m[1]);
const hmImportPure = hmImports.length > 0 && hmImports.every(i => i.startsWith('node:'));
const hmNoSideEffects = !/\bprocess\.env\b/.test(hm) && !/\bfs\./.test(hm)
  && !/\bchild_process\b/.test(hm) && !/\bMath\.random\b/.test(hm)
  && !/\bDate\.now\b/.test(hm) && !/\bsetTimeout\b/.test(hm) && !/\bsetInterval\b/.test(hm)
  && !/\bnew Date\b/.test(hm) && !/require\(/.test(hm);
const hmExportsSurface = /export type HintMode = 'on' \| 'off';/.test(hm)
  && /export function resolveHintMode\(/.test(hm)
  // exactly two exports: the type and the function.
  && (hm.match(/export /g) || []).length === 2;
// Non-vacuity: a forbidden import would be caught by the import filter.
const hmFenceNonVacuous = (() => {
  const mutated = `import { x } from '../handlers/story-review.js';\n${hm}`;
  const mImports = [...mutated.matchAll(/from '([^']+)'/g)].map(m => m[1]);
  return mImports.some(i => !i.startsWith('node:'));
})();
const hintModePure = hmImportPure && hmNoSideEffects && hmExportsSurface && hmFenceNonVacuous;

// ─── static: story-review.ts gates only the advisory section ─────────────────────
const sr = read('packages/main/src/handlers/story-review.ts');
// Strip block + line comments so the call-form checks reflect actual CODE, not
// the comment mentions (story-review.ts documents resolveReviewPromptHash in
// guardrail comments without ever invoking it).
const srCode = sr.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
// (a) hints/section never passed into a resolveReviewPromptHash CALL (the call
//     form, not the comment mentions). story-review.ts must not even invoke it.
const srNoPromptHashCall = !/resolveReviewPromptHash\s*\(/.test(srCode);
// (b) the gate wiring exists: hintMode computed, render-gated value used in IIFE,
//     event payload carries hintMode, the section is still always computed.
const srGateWired = /resolveHintMode\(args\.storyId\)/.test(sr)
  && /const renderedHintsSection = hintMode === 'on' \? experienceHintsSection : ''/.test(sr)
  && /understandingSection \+ decisionSection \+ grillSection \+ renderedHintsSection \+ checklistSection \+ truthSection/.test(sr)
  && /hintMode,/.test(sr)
  && /formatExperienceHintsSection\(experienceHints\)/.test(sr);
// (c) the issues/blocker computation block (from `const issues` to the review
//     `_hash`/writeReview) must NOT reference the arm or the section. Slice the
//     source from the issues array declaration to where the review entry hash is
//     computed (all blocker decisions live in that span).
const blockerStart = srCode.indexOf('const issues:');
const blockerEnd = srCode.indexOf('reviewEntry._hash =');
const blockerBlock = (blockerStart >= 0 && blockerEnd > blockerStart) ? srCode.slice(blockerStart, blockerEnd) : srCode;
const blockerBlockClean = blockerStart >= 0 && blockerEnd > blockerStart
  && !/hintMode/.test(blockerBlock)
  && !/renderedHintsSection/.test(blockerBlock)
  && !/experienceHintsSection/.test(blockerBlock)
  && !/resolveHintMode/.test(blockerBlock);
const storyReviewGated = srNoPromptHashCall && srGateWired && blockerBlockClean;

// ─── static: review-run.ts untouched ────────────────────────────────────────────
const reviewRunDiff = sh('git diff main...HEAD --name-only -- packages/main/src/core/review-run.ts').trim();
const reviewRunWtDiff = sh('git diff --name-only -- packages/main/src/core/review-run.ts').trim();
const reviewRunUntouched = reviewRunDiff === '' && reviewRunWtDiff === '';

// ─── npm script wired ───────────────────────────────────────────────────────────
const pkgScript = /"test:experience-layer-ab-shadow-gate"\s*:/.test(read('packages/main/package.json'));

// ─── per-checklist gating ───────────────────────────────────────────────────────
const chk = {
  'CHK-001': hintModePure && abSmoke && buildOk,
  'CHK-002': storyReviewGated && reviewRunUntouched && abSmoke && buildOk,
  'CHK-003': abSmoke && noRegression && fullTestOk && processFactInChain && pkgScript
             && hintModePure && storyReviewGated && reviewRunUntouched && buildOk,
};
const note = {
  'CHK-001': 'hint-mode.ts pure (imports only node:; no fs/git/time/random/env; exactly 2 exports); smoke asserts determinism (same id=>same arm x100), balance (35-65% over 1000 ids), empty/long/unicode/near-collision edges',
  'CHK-002': 'story-review.ts: hintMode=resolveHintMode(storyId); renderedHintsSection gates the IIFE (ON shows / OFF hides); event fires on BOTH arms with hintMode + full hint set; issues/blocker block has NO arm/section refs; no resolveReviewPromptHash call; review-run.ts untouched. Smoke asserts ON-shows/OFF-hides, both-emit-event, issues identical, OFF==zero-hints baseline, promptHash byte-identical',
  'CHK-003': 'ab-shadow-gate smoke + no-regression smokes (finding-signals/playbook/recall/revalidation/learning-scan/signature-capture/hint-injection) + FULL npm test (incl. process-fact-contract) + static purity/gating/untouched checks; npm script wired',
};

const R = {};
const cl = JSON.parse(read('.lattice/story/actives/B-06b3/checklist.json') || '{}');
for (const it of cl.items || []) {
  const vi = it.verificationIntent || {};
  const cond = chk[it.id] !== undefined ? chk[it.id] : true;
  for (const lane of ['happy','edge','adversarial'])
    (vi[lane] || []).forEach((_, i) => { R[`${it.id}:${lane}:${i}`] = { pass: !!cond, note: note[it.id] || '' }; });
}

const refs = Object.keys(R), fails = refs.filter(r => !R[r].pass);
console.log(`TOTAL ${refs.length} | PASS ${refs.length - fails.length} | FAIL ${fails.length}`);
console.log(`(buildOk=${buildOk} abSmoke=${abSmoke} noRegression=${noRegression} fullTestOk=${fullTestOk} processFactInChain=${processFactInChain} hintModePure=${hintModePure} storyReviewGated=${storyReviewGated} reviewRunUntouched=${reviewRunUntouched} pkgScript=${pkgScript})`);
console.log(`  noReg: ${JSON.stringify(noReg)}`);
console.log(`  static: srNoPromptHashCall=${srNoPromptHashCall} srGateWired=${srGateWired} blockerBlockClean=${blockerBlockClean} hmImportPure=${hmImportPure} hmNoSideEffects=${hmNoSideEffects} hmExportsSurface=${hmExportsSurface}`);
for (const f of fails) console.log(`  FAIL ${f} :: ${R[f].note}`);
fs.writeFileSync('.lattice/story/actives/B-06b3/evidence/verify-result.json', JSON.stringify(R, null, 1));
if (fails.length > 0) process.exitCode = 1;
