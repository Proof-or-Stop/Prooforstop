// Acceptance verifier for B-4f46 — Experience Layer Phase 1b (finding outcome enums + signature-registry).
// Behavioral core = the committed smoke (test:experience-layer-finding-enums) PLUS the Phase 1a
// smoke (no regression). Static checks enforce the audit-only/back-compat invariants. Maps every
// intent ref from checklist.json. Prints TOTAL N | PASS N | FAIL 0.
import fs from 'fs';
import { execSync } from 'child_process';
const sh = (c) => { try { return execSync(c, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }); } catch (e) { return (e.stdout||'')+(e.stderr||''); } };
const code = (c) => { try { execSync(c, { stdio: 'pipe' }); return 0; } catch (e) { return e.status ?? 1; } };
const read = (p) => { try { return fs.readFileSync(p,'utf8'); } catch { return ''; } };

const buildOk = code('npm --prefix packages/main run build') === 0;
const enumsSmoke = sh('npm --prefix packages/main run test:experience-layer-finding-enums').includes('smoke passed');
const phase1aSmoke = sh('npm --prefix packages/main run test:experience-layer-finding-signals').includes('smoke passed');
const usageLedgerSmoke = sh('npm --prefix packages/main run test:usage-ledger').includes('smoke passed');
const types = read('packages/main/src/core/types.ts');
const typesFields = ['signatureTag?','resolutionType?','dismissReasonType?','resolveEvidenceStrength?','dismissEvidenceStrength?'].every(f => types.includes(f));
const auditComment = /audit-only/i.test(types);
const advisory = read('packages/main/src/core/advisory.ts');
const advisoryClean = !/signatureTag|resolutionType|dismissReasonType|evidenceStrength/.test(advisory);
const findingVerifyUntouched = sh('git diff main...HEAD --name-only -- packages/main/src/core/finding-verify.ts').trim() === '';
const cli = read('packages/main/src/cli-engine.ts');
const cliSchemas = cli.includes('signatureTag') && cli.includes('resolutionType') && cli.includes('dismissReasonType');
const sigCli = cli.includes('signature_registry_list') && cli.includes('signature_registry_set');
const sigHandler = fs.existsSync('packages/main/src/handlers/signature-registry.ts');
const learning = read('packages/main/src/core/learning-store.ts');
const sigRegistry = /signature-registry\.json/.test(learning);
const pkgScript = /"test:experience-layer-finding-enums"\s*:/.test(read('packages/main/package.json'));

const chk = {
  'CHK-001': typesFields && auditComment && findingVerifyUntouched && buildOk,
  'CHK-002': enumsSmoke && cliSchemas,
  'CHK-003': sigHandler && sigCli && sigRegistry && advisoryClean && enumsSmoke,
  'CHK-004': pkgScript && enumsSmoke && phase1aSmoke && usageLedgerSmoke && buildOk,
};
const note = {
  'CHK-001':'types.ts has 5 optional audit-only fields with audit-only comment; finding-verify.ts untouched (signature domain unchanged); build clean',
  'CHK-002':'enums smoke covers capture+enum validation+back-compat (field-less calls unchanged); cli-engine schemas carry the optional fields',
  'CHK-003':'signature-registry.json in learning-store + signature_registry_list/set CLI; GUARDRAIL: advisory.ts has zero audit-field references (gate decision unaffected)',
  'CHK-004':'enums smoke + phase-1a smoke + usage-ledger smoke all pass (no regression); npm script wired; build clean',
};
const R = {};
const cl = JSON.parse(read('.lattice/story/actives/B-4f46/checklist.json') || '{}');
for (const it of cl.items || []) {
  const vi = it.verificationIntent || {};
  const cond = chk[it.id] !== undefined ? chk[it.id] : true;
  for (const lane of ['happy','edge','adversarial'])
    (vi[lane] || []).forEach((_, i) => { R[`${it.id}:${lane}:${i}`] = { pass: !!(enumsSmoke && cond), note: note[it.id] || '' }; });
}
const refs = Object.keys(R), fails = refs.filter(r => !R[r].pass);
console.log(`TOTAL ${refs.length} | PASS ${refs.length - fails.length} | FAIL ${fails.length}`);
console.log(`(buildOk=${buildOk} enumsSmoke=${enumsSmoke} phase1aSmoke=${phase1aSmoke} usageLedgerSmoke=${usageLedgerSmoke} typesFields=${typesFields} auditComment=${auditComment} advisoryClean=${advisoryClean} findingVerifyUntouched=${findingVerifyUntouched} cliSchemas=${cliSchemas} sigCli=${sigCli} sigHandler=${sigHandler} sigRegistry=${sigRegistry} pkgScript=${pkgScript})`);
for (const f of fails) console.log(`  FAIL ${f} :: ${R[f].note}`);
fs.writeFileSync('.lattice/story/actives/B-4f46/evidence/verify-result.json', JSON.stringify(R, null, 1));
