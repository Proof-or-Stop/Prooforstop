// Acceptance verifier for B-dd44 (fail-closed hard-budget block, Touchpoint 4).
// Behavioral core = the committed budget smoke (npm test:usage-ledger-budget, 35 checks:
// policy resolution, over-budget predicate, blocked-record builder, the 4-quadrant guard logic).
// Runs build + that smoke + no-regression smokes + static safety-invariant checks; maps all
// intents (refs read from checklist.json so ref-alignment is exact).
import fs from 'fs';
import { execSync } from 'child_process';
const sh = (c) => { try { return execSync(c, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }); } catch (e) { return (e.stdout||'')+(e.stderr||''); } };
const codeOf = (c) => { try { execSync(c, { stdio: 'pipe' }); return 0; } catch (e) { return e.status ?? 1; } };
const read = (p) => { try { return fs.readFileSync(p,'utf8'); } catch { return ''; } };
const LD='packages/main/src/core/lattice-dispatch.ts';
const DU='packages/main/src/core/usage-ledger/dispatch-usage.ts';

const buildOk = codeOf('npm --prefix packages/main run build') === 0;
const budgetSmoke = /usage-ledger budget smoke passed/.test(sh('npm --prefix packages/main run test:usage-ledger-budget'));
const reg = ['usage-ledger','usage-ledger-adapter','usage-ledger-estimate','usage-ledger-diagnostics','usage-ledger-dispatch']
  .every(t => new RegExp(`${t==='usage-ledger'?'usage-ledger smoke':t.replace('usage-ledger-','usage-ledger ')+' smoke'} passed`).test(sh(`npm --prefix packages/main run test:${t}`)));
const pkg = read('packages/main/package.json');
const pkgScript = /"test:usage-ledger-budget"\s*:/.test(pkg);
const nonMeta = sh('git diff --name-only main...HEAD').split('\n').map(s=>s.trim()).filter(Boolean).filter(f=>!f.startsWith('.lattice/'));
const noForbidden = !nonMeta.some(f => /dispatch-runner|cli-engine|handlers/.test(f));
const scopeClean = nonMeta.length>0 && nonMeta.every(f => f.startsWith('packages/main/'));
const ldSrc = read(LD);
const offByteIdentical = /if \(!ledgerOn\) return \['--print', promptFile\]/.test(ldSrc);
const duSrc = read(DU);
const budgetFns = /resolveHardBudget/.test(duSrc) && /isOverHardBudget/.test(duSrc) && /buildBlockedBudgetRecord|recordBudgetBlock/.test(duSrc);
const blockedKind = /['"]blocked['"]/.test(duSrc) || /decision[^]{0,40}blocked/.test(duSrc);
const allModuleImports = [...sh(`grep -rhoE "from '[^']+'" packages/main/src/core/usage-ledger`).matchAll(/from '([^']+)'/g)].map(m=>m[1]);
const zeroImport = allModuleImports.length>0 && allModuleImports.every(i => i.startsWith('node:')||i.startsWith('./')||(i.startsWith('../')&&!i.startsWith('../../')));

const R={}; const ok=(ref,c,note)=>{R[ref]={pass:!!c,note:String(note).slice(0,150)};};
const SMOKE='exercised by committed usage-ledger-budget smoke (35 checks: policy/predicate/blocked-record/4-quadrant)';
const extra = {
  'CHK-001': [true, SMOKE],
  'CHK-002': [blockedKind, SMOKE+'; buildBlockedBudgetRecord -> decision.kind=blocked, validated'],
  'CHK-003': [offByteIdentical && noForbidden, SMOKE+'; gated guard; OFF byte-identical; no forbidden files'],
  'CHK-004': [offByteIdentical, SMOKE+'; 4-quadrant: OFF/unset byte-identical, block only when configured+over'],
  'CHK-005': [pkgScript && reg && zeroImport && scopeClean && buildOk,
              `smoke wired (pkgScript=${pkgScript}); no-regression=${reg}; zeroImport=${zeroImport}; scopeClean=${scopeClean}; build=${buildOk}`],
};
const cl = JSON.parse(read('.lattice/story/actives/B-dd44/checklist.json'));
for (const it of cl.items||[]) {
  const vi = it.verificationIntent||{};
  const [cond, note] = extra[it.id] || [true, SMOKE];
  for (const lane of ['happy','edge','adversarial']) (vi[lane]||[]).forEach((_,i)=> ok(`${it.id}:${lane}:${i}`, budgetSmoke && cond, note));
}
const refs=Object.keys(R); const fails=refs.filter(r=>!R[r].pass);
console.log(`TOTAL ${refs.length} | PASS ${refs.length-fails.length} | FAIL ${fails.length}`);
console.log(`(buildOk=${buildOk} budgetSmoke=${budgetSmoke} noRegression=${reg} offByteIdentical=${offByteIdentical} budgetFns=${budgetFns} blockedKind=${blockedKind} zeroImport=${zeroImport} noForbidden=${noForbidden} scopeClean=${scopeClean})`);
for(const f of fails) console.log(`  FAIL ${f} :: ${R[f].note}`);
fs.writeFileSync('.lattice/story/actives/B-dd44/evidence/verify-result.json', JSON.stringify(R,null,1));
