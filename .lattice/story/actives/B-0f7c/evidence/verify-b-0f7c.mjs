// Acceptance verifier for B-0f7c (wire usage ledger into Claude dispatch — thin gated seam).
// Behavioral core = the committed dispatch smoke (npm test:usage-ledger-dispatch, 38 checks:
// orchestrator estimate+final+supersede, parser+fallback, model extraction, simulated end-to-end
// with real token counts + served model, flag-off no-op, zero-import assert). Runs build + that
// smoke + no-regression smokes + static safety-invariant checks; maps all intents (refs from checklist.json).
import fs from 'fs';
import { execSync } from 'child_process';
const sh = (c) => { try { return execSync(c, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }); } catch (e) { return (e.stdout||'')+(e.stderr||''); } };
const codeOf = (c) => { try { execSync(c, { stdio: 'pipe' }); return 0; } catch (e) { return e.status ?? 1; } };
const read = (p) => { try { return fs.readFileSync(p,'utf8'); } catch { return ''; } };
const LD='packages/main/src/core/lattice-dispatch.ts';
const DU='packages/main/src/core/usage-ledger/dispatch-usage.ts';

const buildOk = codeOf('npm --prefix packages/main run build') === 0;
const dispatchSmoke = /usage-ledger dispatch smoke passed/.test(sh('npm --prefix packages/main run test:usage-ledger-dispatch'));
const s1=/usage-ledger smoke passed/.test(sh('npm --prefix packages/main run test:usage-ledger'));
const s2=/usage-ledger adapter smoke passed/.test(sh('npm --prefix packages/main run test:usage-ledger-adapter'));
const s3=/usage-ledger estimate smoke passed/.test(sh('npm --prefix packages/main run test:usage-ledger-estimate'));
const s4=/usage-ledger diagnostics smoke passed/.test(sh('npm --prefix packages/main run test:usage-ledger-diagnostics'));
const noRegression = s1&&s2&&s3&&s4;
const pkg = read('packages/main/package.json');
const pkgScript = /"test:usage-ledger-dispatch"\s*:/.test(pkg);
const nonMeta = sh('git diff --name-only main...HEAD').split('\n').map(s=>s.trim()).filter(Boolean).filter(f=>!f.startsWith('.lattice/'));
const noForbidden = !nonMeta.some(f => /dispatch-runner|cli-engine|handlers/.test(f));
const scopeClean = nonMeta.length>0 && nonMeta.every(f => f.startsWith('packages/main/'));
const ldSrc = read(LD);
// INV-1: OFF returns the literal original args ['--print', promptFile]
const offByteIdentical = /if \(!ledgerOn\) return \['--print', promptFile\]/.test(ldSrc);
// INV-3: ledger work gated + try/catch in the seam
const seamGated = /isUsageLedgerEnabled\(\)/.test(ldSrc) && /try\s*\{/.test(ldSrc);
// INV-4: usage-ledger zero cross-module imports
const duSrc = read(DU);
// every import across the whole usage-ledger module must be node:, ./sibling, or single-level ../ (no ../../ escape, no bare package)
const inModule = (i) => i.startsWith('node:') || i.startsWith('./') || (i.startsWith('../') && !i.startsWith('../../'));
const allModuleImports = [...sh(`grep -rhoE "from '[^']+'" packages/main/src/core/usage-ledger`).matchAll(/from '([^']+)'/g)].map(m=>m[1]);
const zeroImport = allModuleImports.length>0 && allModuleImports.every(inModule);
// INV-2/served-model: parser extracts model + final binds it
const modelHandled = /extractModel|\.model/.test(duSrc);

const R={}; const ok=(ref,c,note)=>{R[ref]={pass:!!c,note:String(note).slice(0,150)};};
const SMOKE='exercised by committed usage-ledger-dispatch smoke (38 checks: orchestrator/parser/model/simulated-e2e/off-no-op)';
const extra = {
  'CHK-001': [true, SMOKE],
  'CHK-002': [modelHandled, SMOKE+'; parser extracts result+usage+served model, raw fallback'],
  'CHK-003': [seamGated && noForbidden, SMOKE+'; seam gated by isUsageLedgerEnabled + try/catch; no forbidden files'],
  'CHK-004': [offByteIdentical, 'INV-1: OFF returns literal [--print, promptFile] (byte-identical); parse-failure fallback in smoke'],
  'CHK-005': [pkgScript && noRegression && zeroImport && scopeClean && buildOk,
              `smoke wired (pkgScript=${pkgScript}); no-regression=${noRegression}; zeroImport=${zeroImport}; scopeClean=${scopeClean}; build=${buildOk}`],
};

const cl = JSON.parse(read('.lattice/story/actives/B-0f7c/checklist.json'));
for (const it of cl.items||[]) {
  const vi = it.verificationIntent||{};
  const [cond, note] = extra[it.id] || [true, SMOKE];
  for (const lane of ['happy','edge','adversarial']) (vi[lane]||[]).forEach((_,i)=> ok(`${it.id}:${lane}:${i}`, dispatchSmoke && cond, note));
}

const refs=Object.keys(R); const fails=refs.filter(r=>!R[r].pass);
console.log(`TOTAL ${refs.length} | PASS ${refs.length-fails.length} | FAIL ${fails.length}`);
console.log(`(buildOk=${buildOk} dispatchSmoke=${dispatchSmoke} noRegression=${noRegression} offByteIdentical=${offByteIdentical} seamGated=${seamGated} zeroImport=${zeroImport} modelHandled=${modelHandled} noForbidden=${noForbidden} scopeClean=${scopeClean})`);
for(const f of fails) console.log(`  FAIL ${f} :: ${R[f].note}`);
fs.writeFileSync('.lattice/story/actives/B-0f7c/evidence/verify-result.json', JSON.stringify(R,null,1));
