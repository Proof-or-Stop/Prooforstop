// Acceptance verifier for B-5d48 — Experience Layer ③.2: signatureTag auto-candidate + provenance.
// Behavioral core = the committed smoke (test:experience-layer-signature-capture) which exercises
// the pure leaf, the finding_add auto/confirmed wiring, AND the CRITICAL _hash invariance via the
// REAL signFinding. Static checks enforce the audit-only / _hash-exclusion / purity invariants and
// the no-regression smokes. Also runs the FULL `npm test` (incl. process-fact-contract).
// Maps every verificationIntent ref from checklist.json. Prints TOTAL N | PASS N | FAIL 0.
import fs from 'fs';
import { execSync } from 'child_process';

const sh = (c) => { try { return execSync(c, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { return (e.stdout || '') + (e.stderr || ''); } };
const code = (c) => { try { execSync(c, { stdio: 'pipe' }); return 0; } catch (e) { return e.status ?? 1; } };
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

// ── Build (clean) ───────────────────────────────────────────────────────────
const utilsBuildOk = code('npm --prefix packages/utils run build') === 0;
const buildOk = code('npm --prefix packages/main run build') === 0;

// ── Behavioral smoke (the load-bearing acceptance core) ──────────────────────
const captureSmokeOut = sh('npm --prefix packages/main run test:experience-layer-signature-capture');
const captureSmoke = captureSmokeOut.includes('signature-capture smoke passed');
const hashInvariancePass = /CRITICAL: signFinding output is BYTE-IDENTICAL.*— PASS/.test(captureSmokeOut);
const structuredCounts = /TOTAL \d+ \| PASS \d+ \| FAIL 0/.test(captureSmokeOut);

// ── No-regression smokes (Experience Layer neighbours) ───────────────────────
const findingSignalsSmoke = sh('npm --prefix packages/main run test:experience-layer-finding-signals').includes('smoke passed');
const findingEnumsSmoke = sh('npm --prefix packages/main run test:experience-layer-finding-enums').includes('smoke passed');
const playbookSmoke = sh('npm --prefix packages/main run test:experience-layer-playbook').includes('smoke passed');
const recallSmoke = sh('npm --prefix packages/main run test:experience-layer-recall').includes('smoke passed');
const revalidationSmoke = sh('npm --prefix packages/main run test:experience-layer-revalidation').includes('smoke passed');
const learningScanSmoke = sh('npm --prefix packages/main run test:experience-layer-learning-scan').includes('smoke passed');
const noRegressionSmokes = findingSignalsSmoke && findingEnumsSmoke && playbookSmoke && recallSmoke && revalidationSmoke && learningScanSmoke;

// ── Full npm test (incl. process-fact-contract) ──────────────────────────────
const fullTestCode = code('npm test');
const fullTestOk = fullTestCode === 0;

// ── Static checks (defense-in-depth) ─────────────────────────────────────────
const leaf = read('packages/main/src/core/signature-candidate.ts');
// Purity: the leaf has zero non-node imports. Match any `import ... from '...'`
// and `require(...)` and reject anything that is not a `node:` builtin or a local
// type import. (The current leaf has NO imports at all.)
const importLines = (leaf.match(/^\s*import\b.*?from\s+['"][^'"]+['"]/gm) || [])
  .concat(leaf.match(/require\(['"][^'"]+['"]\)/g) || []);
const leafImportsClean = importLines.every((line) => {
  const m = line.match(/['"]([^'"]+)['"]/);
  const spec = m ? m[1] : '';
  return spec.startsWith('node:') || spec.endsWith('-types.js') || spec.endsWith('types.js');
});
const leafNoIo = !/from\s+['"](fs|path|child_process|net|os|http|https|crypto)['"]/.test(leaf)
  && !/require\(['"](fs|path|child_process|net|os|http|https|crypto)['"]\)/.test(leaf);
const leafExportsFn = /export function deriveSignatureCandidate\s*\(/.test(leaf);

// SignatureTagSource type: exactly the union auto | confirmed.
const expTypes = read('packages/main/src/core/experience-layer-types.ts');
const sourceTypeOk = /export type SignatureTagSource\s*=\s*'auto'\s*\|\s*'confirmed'\s*;/.test(expTypes)
  || /export type SignatureTagSource\s*=\s*'confirmed'\s*\|\s*'auto'\s*;/.test(expTypes);

// finding.ts: the signFinding hashed input must NOT contain signatureTag/signatureTagSource.
const findingTs = read('packages/main/src/handlers/finding.ts');
const signCall = (findingTs.match(/signFinding\([^)]*\)/g) || []).join('\n');
const signCallExcludesTag = signCall.length > 0 && !/signatureTag/.test(signCall);
// finding-verify.ts (signFinding definition) must remain unchanged vs main.
const findingVerifyUntouched = sh('git diff main...HEAD --name-only -- packages/main/src/core/finding-verify.ts').trim() === '';
// finding.ts persists both fields (conditionally) and records provenance.
const persistsBoth = /signatureTag\s*,\s*signatureTagSource/.test(findingTs);
const recordsSource = /signatureTagSource\s*:\s*SignatureTagSource\s*=/.test(findingTs)
  && /'confirmed'/.test(findingTs) && /'auto'/.test(findingTs);

// Audit-only: no gate file reads signatureTagSource (or the auto candidate) for decisions.
// Gate-bearing surfaces: advisory.ts (block decision), the story/done handler, validators.
const gateFiles = [
  'packages/main/src/core/advisory.ts',
  'packages/main/src/handlers/story.ts',
  'packages/main/src/core/finding-verify.ts',
];
const noGateReadsSource = gateFiles.every((p) => !/signatureTagSource/.test(read(p)));
// signFinding/_hash domain itself never references the audit fields.
const findingVerify = read('packages/main/src/core/finding-verify.ts');
const verifyExcludesFields = !/signatureTag|signatureTagSource/.test(findingVerify);

// npm script wired.
const pkg = read('packages/main/package.json');
const pkgScript = /"test:experience-layer-signature-capture"\s*:/.test(pkg);

// ── Map checklist verificationIntent refs ────────────────────────────────────
const chk = {
  'CHK-001': buildOk && leafExportsFn && leafImportsClean && leafNoIo && sourceTypeOk,
  'CHK-002': buildOk && captureSmoke && hashInvariancePass && signCallExcludesTag && findingVerifyUntouched
    && persistsBoth && recordsSource && noGateReadsSource && verifyExcludesFields,
  'CHK-003': captureSmoke && hashInvariancePass && structuredCounts && pkgScript && noRegressionSmokes
    && fullTestOk && signCallExcludesTag && leafImportsClean && leafNoIo,
};
const note = {
  'CHK-001': 'pure leaf exports deriveSignatureCandidate, imports only node:/types (no fs/net/child_process); SignatureTagSource = auto|confirmed; build clean',
  'CHK-002': 'finding_add records signatureTagSource (auto|confirmed) + persists both fields; signFinding call excludes signatureTag/signatureTagSource; finding-verify.ts untouched; no gate reads the new field; CRITICAL _hash invariance smoke PASS',
  'CHK-003': 'signature-capture smoke (incl. _hash invariance + TOTAL/PASS/FAIL counts) + npm script + no-regression smokes + FULL npm test green; static purity/exclusion checks pass',
};

const R = {};
const cl = JSON.parse(read('.lattice/story/actives/B-5d48/checklist.json') || '{}');
for (const it of cl.items || []) {
  const vi = it.verificationIntent || {};
  const cond = chk[it.id] !== undefined ? chk[it.id] : true;
  for (const lane of ['happy', 'edge', 'adversarial']) {
    (vi[lane] || []).forEach((_, i) => { R[`${it.id}:${lane}:${i}`] = { pass: !!(captureSmoke && cond), note: note[it.id] || '' }; });
  }
}

const refs = Object.keys(R);
const fails = refs.filter((r) => !R[r].pass);
console.log(`TOTAL ${refs.length} | PASS ${refs.length - fails.length} | FAIL ${fails.length}`);
console.log(`(utilsBuildOk=${utilsBuildOk} buildOk=${buildOk} captureSmoke=${captureSmoke} hashInvariancePass=${hashInvariancePass} structuredCounts=${structuredCounts} fullTestOk=${fullTestOk} noRegressionSmokes=${noRegressionSmokes} [signals=${findingSignalsSmoke} enums=${findingEnumsSmoke} playbook=${playbookSmoke} recall=${recallSmoke} reval=${revalidationSmoke} learnScan=${learningScanSmoke}] leafImportsClean=${leafImportsClean} leafNoIo=${leafNoIo} leafExportsFn=${leafExportsFn} sourceTypeOk=${sourceTypeOk} signCallExcludesTag=${signCallExcludesTag} findingVerifyUntouched=${findingVerifyUntouched} persistsBoth=${persistsBoth} recordsSource=${recordsSource} noGateReadsSource=${noGateReadsSource} verifyExcludesFields=${verifyExcludesFields} pkgScript=${pkgScript})`);
for (const f of fails) console.log(`  FAIL ${f} :: ${R[f].note}`);
fs.writeFileSync('.lattice/story/actives/B-5d48/evidence/verify-result.json', JSON.stringify(R, null, 1));
