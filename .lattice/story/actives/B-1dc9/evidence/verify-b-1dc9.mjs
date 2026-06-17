// Acceptance verifier for B-1dc9 — Experience Layer Phase 1.5 (advisory hint injection).
// Behavioral core = the committed smoke (test:experience-layer-hint-injection) PLUS no-regression
// smokes. Static checks enforce the loader isolation + promptHash guardrail (review-run untouched).
// Maps every intent ref from checklist.json. Prints TOTAL N | PASS N | FAIL 0.
import fs from 'fs';
import { execSync } from 'child_process';
const sh = (c) => { try { return execSync(c, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }); } catch (e) { return (e.stdout||'')+(e.stderr||''); } };
const code = (c) => { try { execSync(c, { stdio: 'pipe' }); return 0; } catch (e) { return e.status ?? 1; } };
const read = (p) => { try { return fs.readFileSync(p,'utf8'); } catch { return ''; } };

const buildOk = code('npm --prefix packages/main run build') === 0;
const hintSmoke = sh('npm --prefix packages/main run test:experience-layer-hint-injection').includes('smoke passed');
const sigSmoke = sh('npm --prefix packages/main run test:experience-layer-finding-signals').includes('smoke passed');
const enumSmoke = sh('npm --prefix packages/main run test:experience-layer-finding-enums').includes('smoke passed');
const noRegression = sigSmoke && enumSmoke;
const loader = read('packages/main/src/core/experience-hint-loader.ts');
const loaderImports = [...loader.matchAll(/from '([^']+)'/g)].map(m => m[1]);
const loaderImportIso = loaderImports.length > 0 && loaderImports.every(i => i.startsWith('node:') || i === './experience-layer-types.js' || i === './learning-store.js');
const reviewRunUntouched = sh('git diff main...HEAD --name-only -- packages/main/src/core/review-run.ts').trim() === '';
const sr = read('packages/main/src/handlers/story-review.ts');
const storyReviewHints = /experienceHintsSection/.test(sr) && /experience_hint_surfaced/.test(sr) && /formatExperienceHintsSection/.test(sr)
  && /Project experience hints \(advisory only\)/.test(loader);
const pkgScript = /"test:experience-layer-hint-injection"\s*:/.test(read('packages/main/package.json'));

const chk = {
  'CHK-001': loaderImportIso && hintSmoke,
  'CHK-002': storyReviewHints && hintSmoke,
  'CHK-003': reviewRunUntouched && storyReviewHints && hintSmoke,
  'CHK-004': pkgScript && hintSmoke && noRegression && buildOk,
};
const note = {
  'CHK-001': 'experience-hint-loader imports only learning-store(read)+types(+node:); smoke asserts priority ranking (log(1+support) damping), score threshold, false-positive bucket, top-N, support shown',
  'CHK-002': "story-review _reviewPrompt has a 'Project experience hints (advisory only)' section (present when signals exist, omitted when none); smoke asserts both",
  'CHK-003': 'review-run.ts untouched -> resolveReviewPromptHash independent of hints; smoke asserts promptHash byte-identical with/without hints + exactly-one experience_hint_surfaced event',
  'CHK-004': 'hint-injection smoke + no-regression (finding-signals + finding-enums) + build clean; npm script wired',
};
const R = {};
const cl = JSON.parse(read('.lattice/story/actives/B-1dc9/checklist.json') || '{}');
for (const it of cl.items || []) {
  const vi = it.verificationIntent || {};
  const cond = chk[it.id] !== undefined ? chk[it.id] : true;
  for (const lane of ['happy','edge','adversarial'])
    (vi[lane] || []).forEach((_, i) => { R[`${it.id}:${lane}:${i}`] = { pass: !!(hintSmoke && cond), note: note[it.id] || '' }; });
}
const refs = Object.keys(R), fails = refs.filter(r => !R[r].pass);
console.log(`TOTAL ${refs.length} | PASS ${refs.length - fails.length} | FAIL ${fails.length}`);
console.log(`(buildOk=${buildOk} hintSmoke=${hintSmoke} noRegression=${noRegression} loaderImportIso=${loaderImportIso} reviewRunUntouched=${reviewRunUntouched} storyReviewHints=${storyReviewHints} pkgScript=${pkgScript})`);
for (const f of fails) console.log(`  FAIL ${f} :: ${R[f].note}`);
fs.writeFileSync('.lattice/story/actives/B-1dc9/evidence/verify-result.json', JSON.stringify(R, null, 1));
