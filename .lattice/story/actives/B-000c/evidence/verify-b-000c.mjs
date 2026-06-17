// Acceptance verifier for B-000c — Experience Layer Phase 1a (finding-signals).
// Behavioral core = the committed smoke (test:experience-layer-finding-signals, 20 checks:
// derivation correctness + signalScore/support + zero-sample/single-hit edges + store-port
// path + currentMaterialHash-unchanged gate-safety + static import isolation). Runs build +
// smoke + static checks; maps every intent ref from checklist.json.
import fs from 'fs';
import { execSync } from 'child_process';
const sh = (c) => { try { return execSync(c, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }); } catch (e) { return (e.stdout||'')+(e.stderr||''); } };
const code = (c) => { try { execSync(c, { stdio: 'pipe' }); return 0; } catch (e) { return e.status ?? 1; } };
const read = (p) => { try { return fs.readFileSync(p,'utf8'); } catch { return ''; } };
const CORE = 'packages/main/src/core';
const MODS = [`${CORE}/experience-layer-types.ts`, `${CORE}/learning-store.ts`, `${CORE}/finding-signals.ts`];

const buildOk = code('npm --prefix packages/main run build') === 0;
const smokePass = sh('npm --prefix packages/main run test:experience-layer-finding-signals').includes('smoke passed');
const filesExist = MODS.every(f => fs.existsSync(f)) && fs.existsSync('packages/main/src/tasks/experience-layer-finding-signals-smoke.ts');
const reg = read(`${CORE}/runtime-artifact-registry.ts`);
const registryEntry = reg.includes('.lattice/learning/finding-signals.json') && /experience-layer-learning-cache[\s\S]{0,400}materialHash:\s*'exclude'/.test(reg);
const pkg = read('packages/main/package.json');
const pkgScript = /"test:experience-layer-finding-signals"\s*:/.test(pkg);

// import isolation: only ./store.js permitted as an existing-core import; own module siblings ok; no ../ ever.
const OWN = new Set(['./experience-layer-types.js','./learning-store.js','./finding-signals.js']);
const PORT = './store.js';
let isoViolations = [];
for (const f of MODS) {
  const imps = [...read(f).matchAll(/from '([^']+)'/g)].map(m => m[1]);
  for (const imp of imps) {
    if (imp.startsWith('node:')) continue;
    if (OWN.has(imp)) continue;
    if (imp === PORT) continue;
    if (imp.startsWith('../')) { isoViolations.push(`${f}: outward ${imp}`); continue; }
    if (imp.startsWith('./')) { isoViolations.push(`${f}: unexpected sibling ${imp}`); continue; }
    isoViolations.push(`${f}: foreign ${imp}`);
  }
}
const importIso = isoViolations.length === 0;
// types + learning-store must not import the store port at all (only finding-signals may)
const leafClean = !read(MODS[0]).includes(PORT) && !read(MODS[1]).includes(PORT);

const chk = {
  'CHK-001': filesExist && leafClean && smokePass,
  'CHK-002': smokePass && read(MODS[2]).includes(PORT) && /signalScore/.test(read(MODS[2])),
  'CHK-003': registryEntry && smokePass,
  'CHK-004': pkgScript && smokePass && buildOk && importIso,
};
const note = {
  'CHK-001': 'types(leaf)+learning-store created; leaf modules do not import the store port; smoke round-trips finding-signals.json',
  'CHK-002': 'finding-signals derivation imports the ./store.js port; signalScore present; smoke asserts aggregation + signalScore/support + store path',
  'CHK-003': "runtime-artifact-registry entry experience-layer-learning-cache materialHash:'exclude'; smoke asserts currentMaterialHash unchanged after cache write",
  'CHK-004': `smoke wired (test:experience-layer-finding-signals) + build clean + import isolation (only ./store.js outward); violations=${isoViolations.length}`,
};

const R = {};
const cl = JSON.parse(read('.lattice/story/actives/B-000c/checklist.json') || '{}');
for (const it of cl.items || []) {
  const vi = it.verificationIntent || {};
  const cond = chk[it.id] !== undefined ? chk[it.id] : true;
  for (const lane of ['happy','edge','adversarial'])
    (vi[lane] || []).forEach((_, i) => { R[`${it.id}:${lane}:${i}`] = { pass: !!(smokePass && cond), note: note[it.id] || '' }; });
}
const refs = Object.keys(R), fails = refs.filter(r => !R[r].pass);
console.log(`TOTAL ${refs.length} | PASS ${refs.length - fails.length} | FAIL ${fails.length}`);
console.log(`(buildOk=${buildOk} smokePass=${smokePass} filesExist=${filesExist} registryEntry=${registryEntry} pkgScript=${pkgScript} importIso=${importIso} leafClean=${leafClean})`);
if (isoViolations.length) console.log('  ISO VIOLATIONS: ' + isoViolations.join(' ; '));
for (const f of fails) console.log(`  FAIL ${f} :: ${R[f].note}`);
fs.writeFileSync('.lattice/story/actives/B-000c/evidence/verify-result.json', JSON.stringify(R, null, 1));
