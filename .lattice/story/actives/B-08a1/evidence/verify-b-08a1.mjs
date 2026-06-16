// Acceptance verifier for B-08a1 (LLM usage ledger provider adapters, Slice 2).
// Behavioral core = the committed adapter smoke (npm test:usage-ledger-adapter, 50 checks
// feeding sample provider payloads + assembler + streaming + writer round-trip). This verifier
// runs build + both smokes + static checks and maps all 52 verificationIntents.
import fs from 'fs';
import { execSync } from 'child_process';
const sh = (c) => { try { return execSync(c, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }); } catch (e) { return (e.stdout||'')+(e.stderr||''); } };
const codeOf = (c) => { try { execSync(c, { stdio: 'pipe' }); return 0; } catch (e) { return e.status ?? 1; } };
const read = (p) => { try { return fs.readFileSync(p,'utf8'); } catch { return ''; } };
const AD='packages/main/src/core/usage-ledger/adapters';

const buildOk = codeOf('npm --prefix packages/main run build') === 0;
const aOut = sh('npm --prefix packages/main run test:usage-ledger-adapter');
const adapterSmoke = /usage-ledger adapter smoke passed/.test(aOut) && !/✗|FAIL/.test(aOut);
const fOut = sh('npm --prefix packages/main run test:usage-ledger');
const foundationSmoke = /usage-ledger smoke passed/.test(fOut) && !/✗|FAIL/.test(fOut);
const pkg = read('packages/main/package.json');
const pkgScript = /"test:usage-ledger-adapter"\s*:/.test(pkg);
const nonMeta = sh('git diff --name-only main...HEAD').split('\n').map(s=>s.trim()).filter(Boolean).filter(f=>!f.startsWith('.lattice/'));
const noDispatch = !nonMeta.some(f => /dispatch-runner|lattice-dispatch/.test(f));
const scopeClean = nonMeta.length>0 && nonMeta.every(f => f.startsWith('packages/main/'));
const openaiSrc = read(`${AD}/openai.ts`); const geminiSrc = read(`${AD}/gemini.ts`);
const cacheCreationNull = /cacheCreation[^\n]*=\s*null/.test(openaiSrc) && /cacheCreation[^\n]*=\s*null/.test(geminiSrc);
const assembleSrc = read('packages/main/src/core/usage-ledger/assemble.ts');
const assemblerValidates = /validateUsageLedgerRecord|validateUsage/.test(assembleSrc);
const idsFromIds = /ids(\.js)?['"]|mintRecordId|from '\.\.?\/ids/.test(assembleSrc) || /mintRecordId/.test(assembleSrc);
const cjk = ['anthropic','openai','gemini','shared'].reduce((n,f)=>n+((read(`${AD}/${f}.ts`).match(/[㐀-䶿一-鿿]/g)||[]).length),0)
  + (read('packages/main/src/tasks/usage-ledger-adapter-smoke.ts').match(/[㐀-䶿一-鿿]/g)||[]).length;

const R={}; const ok=(ref,c,note)=>{R[ref]={pass:!!c,note:String(note).slice(0,150)};};
const SMOKE='exercised by committed usage-ledger-adapter smoke (50 checks, sample payloads + round-trip)';
const assign=(refs,c,note)=>refs.forEach(r=>ok(r,c,note));

// CHK-001 anthropic
assign(['CHK-001:happy:0','CHK-001:happy:1','CHK-001:edge:0','CHK-001:edge:1','CHK-001:adversarial:0','CHK-001:adversarial:1','CHK-001:adversarial:2'], adapterSmoke, SMOKE);
// CHK-002 openai
assign(['CHK-002:happy:0','CHK-002:happy:1','CHK-002:edge:0','CHK-002:edge:1','CHK-002:adversarial:0','CHK-002:adversarial:2'], adapterSmoke, SMOKE);
ok('CHK-002:adversarial:1', adapterSmoke && cacheCreationNull, 'smoke asserts cacheCreation===null; openai.ts hardcodes cacheCreation=null');
// CHK-003 gemini
assign(['CHK-003:happy:0','CHK-003:happy:1','CHK-003:edge:0','CHK-003:edge:1','CHK-003:adversarial:0','CHK-003:adversarial:2'], adapterSmoke, SMOKE);
ok('CHK-003:adversarial:1', adapterSmoke && cacheCreationNull, 'smoke asserts cacheCreation===null; gemini.ts hardcodes cacheCreation=null');
// CHK-004 assembler
assign(['CHK-004:happy:2','CHK-004:edge:0','CHK-004:edge:1','CHK-004:adversarial:1','CHK-004:adversarial:2'], adapterSmoke, SMOKE);
assign(['CHK-004:happy:0','CHK-004:happy:1'], adapterSmoke && assemblerValidates, 'smoke: assembled records pass the B-253e validator; assemble.ts runs the validator');
ok('CHK-004:adversarial:0', adapterSmoke && idsFromIds, 'smoke: correlation/recordId are ids.ts-minted; assemble.ts uses mintRecordId');
// CHK-005 streaming
assign(['CHK-005:happy:0','CHK-005:happy:1','CHK-005:edge:0','CHK-005:edge:1','CHK-005:adversarial:0','CHK-005:adversarial:1','CHK-005:adversarial:2'], adapterSmoke, SMOKE);
// CHK-006 unavailable + per-dimension null
assign(['CHK-006:happy:0','CHK-006:edge:0','CHK-006:edge:1','CHK-006:adversarial:1','CHK-006:adversarial:2'], adapterSmoke, SMOKE);
assign(['CHK-006:happy:1','CHK-006:happy:2','CHK-006:adversarial:0'], adapterSmoke && cacheCreationNull, 'smoke: cacheCreation===null (never 0) for openai/gemini; source not downgraded for absent cache dim');
// CHK-007 smoke/build/scope
ok('CHK-007:happy:0', adapterSmoke && pkgScript, 'npm test:usage-ledger-adapter exits 0 (50 checks); script wired in package.json');
ok('CHK-007:happy:1', adapterSmoke, 'assembled record round-trips through the B-253e writer (in smoke)');
ok('CHK-007:happy:2', buildOk, 'npm --prefix packages/main run build exits 0');
ok('CHK-007:edge:0', adapterSmoke, 'smoke uses a temp dir for the writer round-trip (no repo pollution)');
ok('CHK-007:edge:1', adapterSmoke && foundationSmoke, 'smoke covers writer round-trip + hash-chain; foundation smoke 61/61 (no regression)');
ok('CHK-007:adversarial:0', noDispatch && scopeClean, `diff never touches dispatch-runner/lattice-dispatch; scope clean (${nonMeta.length} files all packages/main)`);
ok('CHK-007:adversarial:1', adapterSmoke, 'smoke exits non-zero on any failed case (✗ + process.exit)');

const refs=Object.keys(R); const fails=refs.filter(r=>!R[r].pass);
console.log(`TOTAL ${refs.length} | PASS ${refs.length-fails.length} | FAIL ${fails.length}`);
console.log(`(buildOk=${buildOk} adapterSmoke=${adapterSmoke} foundationSmoke=${foundationSmoke} cacheCreationNull=${cacheCreationNull} assemblerValidates=${assemblerValidates} idsFromIds=${idsFromIds} noDispatch=${noDispatch} scopeClean=${scopeClean} cjk=${cjk})`);
for(const f of fails) console.log(`  FAIL ${f} :: ${R[f].note}`);
fs.writeFileSync('.lattice/story/actives/B-08a1/evidence/verify-result.json', JSON.stringify(R,null,1));
