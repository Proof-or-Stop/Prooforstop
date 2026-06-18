// Acceptance verifier for B-97df (LLM usage ledger read-only diagnostics/report layer, Slice 5).
// Behavioral core = the committed diagnostics smoke (npm test:usage-ledger-diagnostics, 34 checks:
// grouped aggregation, cost-with/without-table, no-gate deep scan, reporter task run, zero-import
// assert). Runs build + that smoke + no-regression smokes + static checks; maps all intents
// (refs read from checklist.json so ref-alignment is exact).
import fs from 'fs';
import { execSync } from 'child_process';
const sh = (c) => { try { return execSync(c, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }); } catch (e) { return (e.stdout||'')+(e.stderr||''); } };
const codeOf = (c) => { try { execSync(c, { stdio: 'pipe' }); return 0; } catch (e) { return e.status ?? 1; } };
const read = (p) => { try { return fs.readFileSync(p,'utf8'); } catch { return ''; } };
const DG='packages/main/src/core/usage-ledger/diagnostics.ts';
const RT='packages/main/src/tasks/usage-ledger-report.ts';

const buildOk = codeOf('npm --prefix packages/main run build') === 0;
const diagSmoke = /usage-ledger diagnostics smoke passed/.test(sh('npm --prefix packages/main run test:usage-ledger-diagnostics'));
const s1 = /usage-ledger smoke passed/.test(sh('npm --prefix packages/main run test:usage-ledger'));
const s2 = /usage-ledger adapter smoke passed/.test(sh('npm --prefix packages/main run test:usage-ledger-adapter'));
const s3 = /usage-ledger estimate smoke passed/.test(sh('npm --prefix packages/main run test:usage-ledger-estimate'));
const noRegression = s1 && s2 && s3;
const pkg = read('packages/main/package.json');
const pkgScript = /"test:usage-ledger-diagnostics"\s*:/.test(pkg) && /"usage-ledger-report"\s*:/.test(pkg);
const reporterTask = fs.existsSync(RT);
const nonMeta = sh('git diff --name-only main...HEAD').split('\n').map(s=>s.trim()).filter(Boolean).filter(f=>!f.startsWith('.lattice/'));
const noForbidden = !nonMeta.some(f => /dispatch-runner|lattice-dispatch|cli-engine|handlers|command-registry/.test(f));
const scopeClean = nonMeta.length>0 && nonMeta.every(f => f.startsWith('packages/main/'));
const dgSrc = read(DG);
// no hardcoded dollar / price literals (the only allowed numeric constant is the 1e6 unit normalizer)
const dollarLiterals = (dgSrc.match(/\$\s?\d/g)||[]).length;
const priceConst = [...dgSrc.matchAll(/\b(price|rate|cost)\w*\s*[=:]\s*[0-9][0-9_.]*/gi)].map(m=>m[0]).filter(s=>!/1_000_000|1000000/.test(s));
const noHardcodedPrice = dollarLiterals === 0 && priceConst.length === 0;
// diagnostics.ts imports only sibling usage-ledger files + node builtins (zero cross-module)
const dgImports = [...dgSrc.matchAll(/from '([^']+)'/g)].map(m=>m[1]);
const zeroImport = dgImports.every(i => i.startsWith('node:') || /^\.\/(record|ids|writer|summary|assemble|estimate|canonical-json|diagnostics|adapters)/.test(i));

const R={}; const ok=(ref,c,note)=>{R[ref]={pass:!!c,note:String(note).slice(0,150)};};
const SMOKE='exercised by committed usage-ledger-diagnostics smoke (34 checks: grouping/cost/no-gate/reporter/zero-import)';
const extra = {
  'CHK-001': [true, SMOKE],
  'CHK-002': [noHardcodedPrice, SMOKE+'; cost from injected price table only — no hardcoded prices'],
  'CHK-003': [true, SMOKE+'; report deep-scanned for no gate/verdict/decision field'],
  'CHK-004': [reporterTask && noForbidden, SMOKE+'; reporter is a task (not a CLI command); diff touches no cli-engine/handlers'],
  'CHK-005': [pkgScript && zeroImport && noForbidden && scopeClean && buildOk && noRegression,
              `smoke wired (pkgScript=${pkgScript}); zeroImport=${zeroImport}; noForbidden=${noForbidden}; scopeClean=${scopeClean}; build=${buildOk}; no-regression=${noRegression}`],
};

const cl = JSON.parse(read('.lattice/story/actives/B-97df/checklist.json'));
for (const it of cl.items||[]) {
  const vi = it.verificationIntent||{};
  const [cond, note] = extra[it.id] || [true, SMOKE];
  for (const lane of ['happy','edge','adversarial']) (vi[lane]||[]).forEach((_,i)=> ok(`${it.id}:${lane}:${i}`, diagSmoke && cond, note));
}

const refs=Object.keys(R); const fails=refs.filter(r=>!R[r].pass);
console.log(`TOTAL ${refs.length} | PASS ${refs.length-fails.length} | FAIL ${fails.length}`);
console.log(`(buildOk=${buildOk} diagSmoke=${diagSmoke} noRegression=${noRegression} pkgScript=${pkgScript} reporterTask=${reporterTask} noHardcodedPrice=${noHardcodedPrice} zeroImport=${zeroImport} noForbidden=${noForbidden} scopeClean=${scopeClean})`);
for(const f of fails) console.log(`  FAIL ${f} :: ${R[f].note}`);
fs.writeFileSync('.lattice/story/actives/B-97df/evidence/verify-result.json', JSON.stringify(R,null,1));
