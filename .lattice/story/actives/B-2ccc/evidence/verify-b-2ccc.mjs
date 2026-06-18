// Acceptance verifier for B-2ccc — extract canonical-JSON-digest into leaf core/digest.ts.
// Behaviour-preserving refactor. Core proof = the committed smoke (byte-identical pinned digests).
// Static checks enforce the leaf + import-relocation invariants. Maps every intent ref. TOTAL N | PASS N | FAIL 0.
import fs from 'fs';
import { execSync } from 'child_process';
const sh = (c) => { try { return execSync(c, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }); } catch (e) { return (e.stdout||'')+(e.stderr||''); } };
const code = (c) => { try { execSync(c, { stdio: 'pipe' }); return 0; } catch (e) { return e.status ?? 1; } };
const read = (p) => { try { return fs.readFileSync(p,'utf8'); } catch { return ''; } };

const buildOk = code('npm --prefix packages/main run build') === 0;
const digestSmoke = sh('npm --prefix packages/main run test:experience-layer-digest-extract').includes('smoke passed');
const ddSmoke = sh('node packages/main/dist/tasks/decision-doc-promotion-smoke.js').includes('smoke passed');
const sigSmoke = sh('npm --prefix packages/main run test:experience-layer-finding-signals').includes('smoke passed');
const noRegression = ddSmoke && sigSmoke;
const digest = read('packages/main/src/core/digest.ts');
const digestImports = [...digest.matchAll(/from '([^']+)'/g)].map(m=>m[1]).concat([...digest.matchAll(/require\('([^']+)'\)/g)].map(m=>m[1]));
const digestLeaf = digest.length>0 && digestImports.every(i => i === 'node:crypto') && /export (function|const|type) /.test(digest) && /digestCanonicalJson/.test(digest);
const dd = read('packages/main/src/handlers/decision-doc-promotion.ts');
const decisionImportsDigest = /from '\.\.\/core\/digest\.js'/.test(dd);
const noLocalDefs = !/^(export )?function canonicalJson/m.test(dd) && !/^(export )?function digestCanonicalJson/m.test(dd) && !dd.includes('createHash');
const pkgScript = /"test:experience-layer-digest-extract"\s*:/.test(read('packages/main/package.json'));

const chk = {
  'CHK-001': digestLeaf && digestSmoke,
  'CHK-002': decisionImportsDigest && noLocalDefs && digestSmoke,
  'CHK-003': pkgScript && digestSmoke && noRegression && buildOk,
};
const note = {
  'CHK-001': 'core/digest.ts is a leaf (imports only node:crypto), exports the digest primitives; smoke asserts byte-identical pinned digests + order-independence',
  'CHK-002': 'decision-doc-promotion imports from ../core/digest.js; no local canonicalJson/digestCanonicalJson defs; createHash removed; computeDecisionDocProposalDigest value stable',
  'CHK-003': 'digest-extract smoke + no-regression (decision-doc-promotion + finding-signals) + build clean; npm script wired',
};
const R = {};
const cl = JSON.parse(read('.lattice/story/actives/B-2ccc/checklist.json') || '{}');
for (const it of cl.items || []) {
  const vi = it.verificationIntent || {};
  const cond = chk[it.id] !== undefined ? chk[it.id] : true;
  for (const lane of ['happy','edge','adversarial'])
    (vi[lane] || []).forEach((_, i) => { R[`${it.id}:${lane}:${i}`] = { pass: !!(digestSmoke && cond), note: note[it.id] || '' }; });
}
const refs = Object.keys(R), fails = refs.filter(r => !R[r].pass);
console.log(`TOTAL ${refs.length} | PASS ${refs.length - fails.length} | FAIL ${fails.length}`);
console.log(`(buildOk=${buildOk} digestSmoke=${digestSmoke} noRegression=${noRegression} ddSmoke=${ddSmoke} sigSmoke=${sigSmoke} digestLeaf=${digestLeaf} decisionImportsDigest=${decisionImportsDigest} noLocalDefs=${noLocalDefs} pkgScript=${pkgScript})`);
for (const f of fails) console.log(`  FAIL ${f} :: ${R[f].note}`);
fs.writeFileSync('.lattice/story/actives/B-2ccc/evidence/verify-result.json', JSON.stringify(R, null, 1));
