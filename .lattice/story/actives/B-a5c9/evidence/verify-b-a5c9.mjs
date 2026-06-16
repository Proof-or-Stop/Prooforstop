// Acceptance verifier for B-a5c9 (LLM usage ledger preflight estimate path, Slice 3).
// Behavioral core = the committed estimate smoke (npm test:usage-ledger-estimate, 55 checks:
// confidence map, bytes/chars determinism, selector ordering w/ injected stubs, model binding,
// record validation, supersedes/summary, writer round-trip, zero-import assertion). This verifier
// runs build + the estimate smoke + no-regression smokes + static checks and maps all intents
// (refs read from checklist.json so ref-alignment is exact).
import fs from 'fs';
import { execSync } from 'child_process';
const sh = (c) => { try { return execSync(c, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }); } catch (e) { return (e.stdout||'')+(e.stderr||''); } };
const codeOf = (c) => { try { execSync(c, { stdio: 'pipe' }); return 0; } catch (e) { return e.status ?? 1; } };
const read = (p) => { try { return fs.readFileSync(p,'utf8'); } catch { return ''; } };
const EST='packages/main/src/core/usage-ledger/estimate.ts';

const buildOk = codeOf('npm --prefix packages/main run build') === 0;
const estSmoke = /usage-ledger estimate smoke passed/.test(sh('npm --prefix packages/main run test:usage-ledger-estimate'));
const foundationSmoke = /usage-ledger smoke passed/.test(sh('npm --prefix packages/main run test:usage-ledger'));
const adapterSmoke = /usage-ledger adapter smoke passed/.test(sh('npm --prefix packages/main run test:usage-ledger-adapter'));
const pkg = read('packages/main/package.json');
const pkgScript = /"test:usage-ledger-estimate"\s*:/.test(pkg);
const nonMeta = sh('git diff --name-only main...HEAD').split('\n').map(s=>s.trim()).filter(Boolean).filter(f=>!f.startsWith('.lattice/'));
const noDispatch = !nonMeta.some(f => /dispatch-runner|lattice-dispatch/.test(f));
const scopeClean = nonMeta.length>0 && nonMeta.every(f => f.startsWith('packages/main/'));
const estSrc = read(EST);
// estimate.ts imports only sibling usage-ledger files + node builtins (zero cross-module)
const estImports = [...estSrc.matchAll(/from '([^']+)'/g)].map(m=>m[1]);
const zeroImport = estImports.every(i => i.startsWith('node:') || /^\.\/(record|ids|writer|summary|assemble|canonical-json|adapters)/.test(i));
// flag only a real tiktoken import/require/dependency — a comment mentioning "NOT tiktoken" is fine
const notTiktoken = !/(from|require\s*\()\s*['"][^'"]*(tiktoken|gpt-tokenizer)/i.test(estSrc) && !/"[^"]*tiktoken[^"]*"\s*:/.test(pkg);
const noRegression = foundationSmoke && adapterSmoke;

const R={}; const ok=(ref,c,note)=>{R[ref]={pass:!!c,note:String(note).slice(0,150)};};
const SMOKE='exercised by committed usage-ledger-estimate smoke (55 checks: confidence/selector/record/supersedes/round-trip)';
// per-item extra condition ANDed with the estimate smoke
const extra = {
  'CHK-001': [true, SMOKE],
  'CHK-002': [notTiktoken, SMOKE+'; bytes/chars heuristic, no tiktoken dependency'],
  'CHK-003': [true, SMOKE],
  'CHK-004': [true, SMOKE+'; buildEstimateRecord output passes the B-253e validator'],
  'CHK-005': [foundationSmoke, SMOKE+'; summary excludes superseded estimates (foundation smoke green)'],
  'CHK-006': [pkgScript && zeroImport && noDispatch && scopeClean && buildOk && noRegression,
              `smoke wired (pkgScript=${pkgScript}); estimate.ts zero cross-module imports=${zeroImport}; noDispatch=${noDispatch}; scopeClean=${scopeClean}; build=${buildOk}; no-regression=${noRegression}`],
};

const cl = JSON.parse(read('.lattice/story/actives/B-a5c9/checklist.json'));
for (const it of cl.items||[]) {
  const vi = it.verificationIntent||{};
  const [cond, note] = extra[it.id] || [true, SMOKE];
  for (const lane of ['happy','edge','adversarial']) {
    (vi[lane]||[]).forEach((_,i)=> ok(`${it.id}:${lane}:${i}`, estSmoke && cond, note));
  }
}

const refs=Object.keys(R); const fails=refs.filter(r=>!R[r].pass);
console.log(`TOTAL ${refs.length} | PASS ${refs.length-fails.length} | FAIL ${fails.length}`);
console.log(`(buildOk=${buildOk} estSmoke=${estSmoke} foundationSmoke=${foundationSmoke} adapterSmoke=${adapterSmoke} pkgScript=${pkgScript} zeroImport=${zeroImport} notTiktoken=${notTiktoken} noDispatch=${noDispatch} scopeClean=${scopeClean})`);
for(const f of fails) console.log(`  FAIL ${f} :: ${R[f].note}`);
fs.writeFileSync('.lattice/story/actives/B-a5c9/evidence/verify-result.json', JSON.stringify(R,null,1));
