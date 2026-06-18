// Acceptance verifier for B-a2e3 — Experience Layer referential re-validation + valid-rate.
// Behavioral core = the committed smoke (test:experience-layer-revalidation) PLUS no-regression smokes.
// Static checks enforce leaf purity + read-only handler + full registration wiring + protected files unchanged.
// Maps every verificationIntent ref to pass/fail. Prints TOTAL N | PASS N | FAIL 0.
import fs from 'fs';
import { execSync } from 'child_process';
const sh = (c) => { try { return execSync(c, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }); } catch (e) { return (e.stdout||'')+(e.stderr||''); } };
const code = (c) => { try { execSync(c, { stdio: 'pipe' }); return 0; } catch (e) { return e.status ?? 1; } };
const read = (p) => { try { return fs.readFileSync(p,'utf8'); } catch { return ''; } };

// ── Behavioral: build clean + new smoke passes + no-regression smokes pass ──
const buildOk = code('npm --prefix packages/main run build') === 0;
const revalSmoke = sh('npm --prefix packages/main run test:experience-layer-revalidation').includes('smoke passed');
const reg = {
  sig: sh('npm --prefix packages/main run test:experience-layer-finding-signals').includes('smoke passed'),
  pb: sh('npm --prefix packages/main run test:experience-layer-playbook').includes('smoke passed'),
  recall: sh('npm --prefix packages/main run test:experience-layer-recall').includes('smoke passed'),
};
const noRegression = Object.values(reg).every(Boolean);

// ── Static: leaf purity (experience-revalidation.ts imports ONLY ./experience-layer-types.js + node:) ──
const leaf = read('packages/main/src/core/experience-revalidation.ts');
const leafImports = [...leaf.matchAll(/from '([^']+)'/g)].map(m => m[1]);
const leafIso = leaf.length > 0 && leafImports.length > 0
  && leafImports.every(i => i.startsWith('node:') || i === './experience-layer-types.js');
const leafNoIo = leaf.length > 0 && !/from '(node:)?(fs|child_process|node:fs\/promises)'/.test(leaf)
  && !/\b(execFileSync|execSync|readFileSync|writeFileSync)\b/.test(leaf);

// ── Static: handler read-only (no write/finding/gate refs; no projectRoot to deriveFindingSignalsFromStore) ──
const handler = read('packages/main/src/handlers/learning-validate.ts');
const handlerReadOnly = handler.length > 0
  && !/writeFileSync|appendFileSync|writeFindings|finding_add|advisory_add/.test(handler);
// Read-only contract: never PASS projectRoot into the derivation (matching it in
// a prose comment that says "NO projectRoot" is fine — only an actual
// `projectRoot:` object key would persist).
const handlerNoProjectRoot = handler.length > 0
  && /deriveFindingSignalsFromStore/.test(handler)
  && !/projectRoot\s*:/.test(handler);
// Handler must build its own git ls-tree, NOT IMPORT evidence-freshness.ts (a
// prose mention of the filename in a comment is fine — only a real import binds it).
const handlerOwnGit = /execFileSync\(\s*'git'\s*,\s*\[\s*'ls-tree'/.test(handler)
  && !/from '[^']*evidence-freshness[^']*'/.test(handler);

// ── Static: full registration wiring ──
const cli = read('packages/main/src/cli-engine.ts');
const cmdRegistered = /['"]learning_validate['"]/.test(cli);
const registry = read('packages/main/src/registry.ts');
const handlerRegistered = /createLearningValidateHandlers\(ctx\)/.test(registry);
const pkgScript = /"test:experience-layer-revalidation"\s*:/.test(read('packages/main/package.json'));
const configEntry = /'learning_validate'/.test(read('packages/main/src/core/config.ts'));
const policyEntry = /learning_validate\s*:/.test(read('packages/main/src/core/command-policy.ts'));

// ── Static: anchorFiles wiring in the core (CHK-001) ──
const types = read('packages/main/src/core/experience-layer-types.ts');
const fsigs = read('packages/main/src/core/finding-signals.ts');
const anchorTypes = /anchorFiles\?\s*:\s*string\[\]/.test(types);
const anchorDerive = /MAX_ANCHOR_FILES/.test(fsigs) && /anchorFiles/.test(fsigs);

// ── Protected files unchanged (must NOT appear in git diff name-only vs HEAD) ──
const diffNames = sh('git diff --name-only HEAD').split('\n').map(s => s.trim()).filter(Boolean);
const protectedUntouched = !diffNames.includes('packages/main/src/core/evidence-freshness.ts')
  && !diffNames.includes('packages/main/src/handlers/finding.ts');

// ── Per-checklist pass conditions ──
const chk = {
  'CHK-001': anchorTypes && anchorDerive && revalSmoke && buildOk,
  'CHK-002': leafIso && leafNoIo && revalSmoke && buildOk,
  'CHK-003': cmdRegistered && handlerRegistered && handlerReadOnly && handlerNoProjectRoot && handlerOwnGit && configEntry && policyEntry && buildOk,
  'CHK-004': pkgScript && revalSmoke && noRegression && buildOk && leafIso && handlerReadOnly && protectedUntouched,
};
const note = {
  'CHK-001': 'experience-layer-types.ts adds anchorFiles?: string[]; finding-signals.ts populates capped sorted union (MAX_ANCHOR_FILES); smoke asserts sorted/deduped/non-string-filtered',
  'CHK-002': 'experience-revalidation.ts imports ONLY ./experience-layer-types.js (no fs/child_process); smoke asserts validRate/driftRate, anchored-only denominator, no NaN, throw propagates',
  'CHK-003': 'learning_validate CLI + registry + config + policy registered; READ-ONLY (no write/finding/gate refs; no projectRoot); own git ls-tree (not evidence-freshness)',
  'CHK-004': 'revalidation smoke passes + no-regression (finding-signals/playbook/recall) + build clean + leaf isolation + read-only + protected files unchanged; npm script wired',
};

const R = {};
const cl = JSON.parse(read('.lattice/story/actives/B-a2e3/checklist.json') || '{}');
for (const it of cl.items || []) {
  const vi = it.verificationIntent || {};
  const cond = chk[it.id] !== undefined ? chk[it.id] : true;
  for (const lane of ['happy','edge','adversarial'])
    (vi[lane] || []).forEach((_, i) => { R[`${it.id}:${lane}:${i}`] = { pass: !!(revalSmoke && cond), note: note[it.id] || '' }; });
}
const refs = Object.keys(R), fails = refs.filter(r => !R[r].pass);
console.log(`TOTAL ${refs.length} | PASS ${refs.length - fails.length} | FAIL ${fails.length}`);
console.log(`(buildOk=${buildOk} revalSmoke=${revalSmoke} noRegression=${noRegression} leafIso=${leafIso} leafNoIo=${leafNoIo} handlerReadOnly=${handlerReadOnly} handlerNoProjectRoot=${handlerNoProjectRoot} handlerOwnGit=${handlerOwnGit} cmdRegistered=${cmdRegistered} handlerRegistered=${handlerRegistered} pkgScript=${pkgScript} configEntry=${configEntry} policyEntry=${policyEntry} anchorTypes=${anchorTypes} anchorDerive=${anchorDerive} protectedUntouched=${protectedUntouched})`);
console.log('regression: ' + Object.entries(reg).map(([k,v])=>`${k}=${v?'ok':'FAIL'}`).join(' '));
for (const f of fails) console.log(`  FAIL ${f} :: ${R[f].note}`);
fs.writeFileSync('.lattice/story/actives/B-a2e3/evidence/verify-result.json', JSON.stringify(R, null, 1));
