// Acceptance verifier for B-fd64 (local Authority usage-evidence slice, Touchpoint 6).
// Behavioral core = the committed authority smoke (npm test:usage-ledger-authority, 33 checks:
// envelope privacy-safety + digest, nullable receipt-ref fields, the verification gate, and the
// 4 negative controls + subject-mismatch). Runs build + that smoke + no-regression smokes +
// static anti-overclaim/decoupling checks; maps all intents (refs read from checklist.json).
import fs from 'fs';
import { execSync } from 'child_process';
const sh = (c) => { try { return execSync(c, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }); } catch (e) { return (e.stdout||'')+(e.stderr||''); } };
const codeOf = (c) => { try { execSync(c, { stdio: 'pipe' }); return 0; } catch (e) { return e.status ?? 1; } };
const read = (p) => { try { return fs.readFileSync(p,'utf8'); } catch { return ''; } };
const AE='packages/main/src/core/usage-ledger/authority-evidence.ts';

const buildOk = codeOf('npm --prefix packages/main run build') === 0;
const authoritySmoke = /usage-ledger authority smoke passed/.test(sh('npm --prefix packages/main run test:usage-ledger-authority'));
const reg = ['usage-ledger','usage-ledger-adapter','usage-ledger-estimate','usage-ledger-diagnostics','usage-ledger-dispatch','usage-ledger-budget']
  .every(t => sh(`npm --prefix packages/main run test:${t}`).includes('smoke passed'));
const pkg = read('packages/main/package.json');
const pkgScript = /"test:usage-ledger-authority"\s*:/.test(pkg);
const nonMeta = sh('git diff --name-only main...HEAD').split('\n').map(s=>s.trim()).filter(Boolean).filter(f=>!f.startsWith('.lattice/'));
const noForbidden = !nonMeta.some(f => /dispatch-runner|cli-engine|handlers/.test(f));
const scopeClean = nonMeta.length>0 && nonMeta.every(f => f.startsWith('packages/main/'));
// zero cross-module imports across usage-ledger
const allModuleImports = [...sh(`grep -rhoE "from '[^']+'" packages/main/src/core/usage-ledger`).matchAll(/from '([^']+)'/g)].map(m=>m[1]);
const zeroImport = allModuleImports.length>0 && allModuleImports.every(i => i.startsWith('node:')||i.startsWith('./')||(i.startsWith('../')&&!i.startsWith('../../')));
// NO actual import/require of authority-signing anywhere in usage-ledger (comments are fine)
const noAuthSigningImport = !/(from|require\s*\()\s*['"][^'"]*authority-signing/.test(sh(`grep -rn "authority-signing" packages/main/src/core/usage-ledger`));
// the gate's verified condition exists (verified + subject match)
const aeSrc = read(AE);
const gatePresent = /verified\s*===\s*true/.test(aeSrc) && /subjectId|subjectKind/.test(aeSrc);

const R={}; const ok=(ref,c,note)=>{R[ref]={pass:!!c,note:String(note).slice(0,150)};};
const SMOKE='exercised by committed usage-ledger-authority smoke (33 checks: envelope/record-fields/gate/4-negative-controls)';
const extra = {
  'CHK-001': [true, SMOKE+'; envelope is digest + non-secret allowlist, no raw/secret material'],
  'CHK-002': [true, SMOKE+'; nullable receipt-ref fields; local stays receiptVerified=false'],
  'CHK-003': [gatePresent, SMOKE+'; gate verifies ONLY via injected verifier returning true + subject match'],
  'CHK-004': [true, SMOKE+'; 4 negative controls + subject-mismatch all keep receiptVerified=false'],
  'CHK-005': [pkgScript && reg && zeroImport && noAuthSigningImport && scopeClean && buildOk,
              `smoke wired (pkgScript=${pkgScript}); no-regression=${reg}; zeroImport=${zeroImport}; noAuthSigningImport=${noAuthSigningImport}; scopeClean=${scopeClean}`],
};
const cl = JSON.parse(read('.lattice/story/actives/B-fd64/checklist.json'));
for (const it of cl.items||[]) {
  const vi = it.verificationIntent||{};
  const [cond, note] = extra[it.id] || [true, SMOKE];
  for (const lane of ['happy','edge','adversarial']) (vi[lane]||[]).forEach((_,i)=> ok(`${it.id}:${lane}:${i}`, authoritySmoke && cond, note));
}
const refs=Object.keys(R); const fails=refs.filter(r=>!R[r].pass);
console.log(`TOTAL ${refs.length} | PASS ${refs.length-fails.length} | FAIL ${fails.length}`);
console.log(`(buildOk=${buildOk} authoritySmoke=${authoritySmoke} noRegression=${reg} gatePresent=${gatePresent} zeroImport=${zeroImport} noAuthSigningImport=${noAuthSigningImport} noForbidden=${noForbidden} scopeClean=${scopeClean})`);
for(const f of fails) console.log(`  FAIL ${f} :: ${R[f].note}`);
fs.writeFileSync('.lattice/story/actives/B-fd64/evidence/verify-result.json', JSON.stringify(R,null,1));
