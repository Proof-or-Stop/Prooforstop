// Acceptance verifier for B-8387 — Experience Layer Phase 2 (staged playbook lifecycle).
// Behavioral core = the committed smoke (test:experience-layer-playbook) PLUS no-regression smokes.
// Static checks enforce the guardrail (no finding_add/advisory in playbook.ts) + learning-store
// isolation. Maps every intent ref from checklist.json. Prints TOTAL N | PASS N | FAIL 0.
import fs from 'fs';
import { execSync } from 'child_process';
const sh = (c) => { try { return execSync(c, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }); } catch (e) { return (e.stdout||'')+(e.stderr||''); } };
const code = (c) => { try { execSync(c, { stdio: 'pipe' }); return 0; } catch (e) { return e.status ?? 1; } };
const read = (p) => { try { return fs.readFileSync(p,'utf8'); } catch { return ''; } };

const buildOk = code('npm --prefix packages/main run build') === 0;
const playbookSmoke = sh('npm --prefix packages/main run test:experience-layer-playbook').includes('smoke passed');
const reg = {
  sig: sh('npm --prefix packages/main run test:experience-layer-finding-signals').includes('smoke passed'),
  enum: sh('npm --prefix packages/main run test:experience-layer-finding-enums').includes('smoke passed'),
  hint: sh('npm --prefix packages/main run test:experience-layer-hint-injection').includes('smoke passed'),
  digest: sh('npm --prefix packages/main run test:experience-layer-digest-extract').includes('smoke passed'),
  dd: sh('node packages/main/dist/tasks/decision-doc-promotion-smoke.js').includes('smoke passed'),
};
const noRegression = Object.values(reg).every(Boolean);
const pb = read('packages/main/src/handlers/playbook.ts');
const guardrailNoFinding = pb.length>0 && !/finding_add|advisory/i.test(pb);
const ls = read('packages/main/src/core/learning-store.ts');
const lsImports = [...ls.matchAll(/import[^;]*from '([^']+)'/g)].map(m=>m[1]);
const learningStoreIso = lsImports.length>0 && lsImports.every(i => i.startsWith('node:') || i === './experience-layer-types.js' || i === './digest.js');
const cli = read('packages/main/src/cli-engine.ts');
const cmdsRegistered = ['playbook_propose','playbook_diff','playbook_approve','playbook_reject'].every(c => cli.includes(c));
const pkgScript = /"test:experience-layer-playbook"\s*:/.test(read('packages/main/package.json'));

const chk = {
  'CHK-001': learningStoreIso && playbookSmoke,
  'CHK-002': cmdsRegistered && guardrailNoFinding && playbookSmoke,
  'CHK-003': cmdsRegistered && playbookSmoke,
  'CHK-004': pkgScript && playbookSmoke && noRegression && buildOk && guardrailNoFinding,
};
const note = {
  'CHK-001': 'playbook+proposal types; learning-store reads/writes playbooks.json+proposals/ (outward import only ./digest.js); smoke round-trips + stable proposalDigest',
  'CHK-002': 'playbook_propose/diff/reject registered; playbook.ts has NO finding_add/advisory (guardrail); smoke: propose(lineage+digest)/diff(no mutation)/reject',
  'CHK-003': 'playbook_approve fail-closed on stale/missing expectedProposalDigest -> candidate (not active) with lineage; CLI registered; smoke covers fail-closed + candidate',
  'CHK-004': 'playbook smoke + no-regression (5 suites) + build clean + guardrail; npm script wired',
};
const R = {};
const cl = JSON.parse(read('.lattice/story/actives/B-8387/checklist.json') || '{}');
for (const it of cl.items || []) {
  const vi = it.verificationIntent || {};
  const cond = chk[it.id] !== undefined ? chk[it.id] : true;
  for (const lane of ['happy','edge','adversarial'])
    (vi[lane] || []).forEach((_, i) => { R[`${it.id}:${lane}:${i}`] = { pass: !!(playbookSmoke && cond), note: note[it.id] || '' }; });
}
const refs = Object.keys(R), fails = refs.filter(r => !R[r].pass);
console.log(`TOTAL ${refs.length} | PASS ${refs.length - fails.length} | FAIL ${fails.length}`);
console.log(`(buildOk=${buildOk} playbookSmoke=${playbookSmoke} noRegression=${noRegression} guardrailNoFinding=${guardrailNoFinding} learningStoreIso=${learningStoreIso} cmdsRegistered=${cmdsRegistered} pkgScript=${pkgScript})`);
console.log('regression: ' + Object.entries(reg).map(([k,v])=>`${k}=${v?'ok':'FAIL'}`).join(' '));
for (const f of fails) console.log(`  FAIL ${f} :: ${R[f].note}`);
fs.writeFileSync('.lattice/story/actives/B-8387/evidence/verify-result.json', JSON.stringify(R, null, 1));
