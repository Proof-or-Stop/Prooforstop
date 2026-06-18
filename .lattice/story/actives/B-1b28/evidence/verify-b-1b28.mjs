// Acceptance verifier for B-1b28 (LLM usage ledger default-on rollout).
// Behavioral core = the committed default-on smoke (npm test:usage-ledger-default-on, 30 checks:
// flag parsing default-ON + escape hatch, =0 byte-identical legacy, default-on safety) PLUS the
// full ledger suite passing with the NEW default (no regression). Runs build + all 8 smokes +
// static checks; maps all intents (refs read from checklist.json).
import fs from 'fs';
import { execSync } from 'child_process';
const sh = (c) => { try { return execSync(c, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }); } catch (e) { return (e.stdout||'')+(e.stderr||''); } };
const codeOf = (c) => { try { execSync(c, { stdio: 'pipe' }); return 0; } catch (e) { return e.status ?? 1; } };
const read = (p) => { try { return fs.readFileSync(p,'utf8'); } catch { return ''; } };
const WR='packages/main/src/core/usage-ledger/writer.ts';

const buildOk = codeOf('npm --prefix packages/main run build') === 0;
const SUITES = ['usage-ledger','usage-ledger-adapter','usage-ledger-estimate','usage-ledger-diagnostics','usage-ledger-dispatch','usage-ledger-budget','usage-ledger-authority','usage-ledger-default-on'];
const suiteResult = Object.fromEntries(SUITES.map(t => [t, sh(`npm --prefix packages/main run test:${t}`).includes('smoke passed')]));
const defaultOnSmoke = suiteResult['usage-ledger-default-on'];
const fullSuite = SUITES.every(t => suiteResult[t]);
const flipPresent = /raw === undefined\)\s*return true/.test(read(WR));
const commentUpdated = !/Default OFF/.test(read(WR));
const pkg = read('packages/main/package.json');
const pkgScript = /"test:usage-ledger-default-on"\s*:/.test(pkg);
const nonMeta = sh('git diff --name-only main...HEAD').split('\n').map(s=>s.trim()).filter(Boolean).filter(f=>!f.startsWith('.lattice/'));
const scopeClean = nonMeta.length>0 && nonMeta.every(f => f.startsWith('packages/main/'));
const noProd = !nonMeta.some(f => /dispatch-runner|cli-engine|handlers|lattice-dispatch/.test(f));
const allModuleImports = [...sh(`grep -rhoE "from '[^']+'" packages/main/src/core/usage-ledger`).matchAll(/from '([^']+)'/g)].map(m=>m[1]);
const zeroImport = allModuleImports.length>0 && allModuleImports.every(i => i.startsWith('node:')||i.startsWith('./')||(i.startsWith('../')&&!i.startsWith('../../')));

const R={}; const ok=(ref,c,note)=>{R[ref]={pass:!!c,note:String(note).slice(0,150)};};
const SMOKE='exercised by committed usage-ledger-default-on smoke (30 checks: default-ON parsing + =0 byte-identical escape hatch + default-on safety)';
const extra = {
  'CHK-001': [flipPresent && commentUpdated, SMOKE+'; writer default flipped to true on unset; "Default OFF" comment updated'],
  'CHK-002': [defaultOnSmoke, SMOKE+'; =0 => writer no-op + original spawn args + inert budget (byte-identical legacy)'],
  'CHK-003': [defaultOnSmoke, SMOKE+'; unset => writes + seam enabled path + raw fallback + no budget block'],
  'CHK-004': [pkgScript && fullSuite && scopeClean && noProd && zeroImport && buildOk,
              `smoke wired (pkgScript=${pkgScript}); FULL suite green with new default=${fullSuite}; scopeClean=${scopeClean}; noProd=${noProd}; zeroImport=${zeroImport}`],
};
const cl = JSON.parse(read('.lattice/story/actives/B-1b28/checklist.json'));
for (const it of cl.items||[]) {
  const vi = it.verificationIntent||{};
  const [cond, note] = extra[it.id] || [true, SMOKE];
  for (const lane of ['happy','edge','adversarial']) (vi[lane]||[]).forEach((_,i)=> ok(`${it.id}:${lane}:${i}`, defaultOnSmoke && cond, note));
}
const refs=Object.keys(R); const fails=refs.filter(r=>!R[r].pass);
console.log(`TOTAL ${refs.length} | PASS ${refs.length-fails.length} | FAIL ${fails.length}`);
console.log(`(buildOk=${buildOk} defaultOnSmoke=${defaultOnSmoke} fullSuite=${fullSuite} flipPresent=${flipPresent} commentUpdated=${commentUpdated} pkgScript=${pkgScript} scopeClean=${scopeClean} noProd=${noProd} zeroImport=${zeroImport})`);
console.log('suites: ' + SUITES.map(t=>`${t.replace('usage-ledger','ul')}=${suiteResult[t]?'ok':'FAIL'}`).join(' '));
for(const f of fails) console.log(`  FAIL ${f} :: ${R[f].note}`);
fs.writeFileSync('.lattice/story/actives/B-1b28/evidence/verify-result.json', JSON.stringify(R,null,1));
