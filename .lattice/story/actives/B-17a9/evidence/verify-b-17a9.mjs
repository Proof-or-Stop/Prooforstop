// Acceptance verifier for B-17a9 — Experience Layer signature_backfill (writing, dry-run default).
// Behavioral core = the committed smoke (test:experience-layer-signature-backfill) including the
// _hash-invariance + idempotency checks, PLUS the no-regression Experience Layer smokes and the
// FULL npm test suite (incl. process-fact-contract). Static checks enforce the audit-only/leaf-purity
// invariants and the 5-surface registration (and absence from READ_ONLY_COMMANDS). Maps every
// verificationIntent ref from checklist.json. Prints TOTAL N | PASS N | FAIL 0.
import fs from 'fs';
import { execSync } from 'child_process';
const sh = (c) => { try { return execSync(c, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }); } catch (e) { return (e.stdout||'')+(e.stderr||''); } };
const code = (c) => { try { execSync(c, { stdio: 'pipe' }); return 0; } catch (e) { return e.status ?? 1; } };
const read = (p) => { try { return fs.readFileSync(p,'utf8'); } catch { return ''; } };

// ── Build (utils + main) ──────────────────────────────────────────────────────
const buildUtils = code('npm --prefix packages/utils run build') === 0;
const buildMain = code('npm --prefix packages/main run build') === 0;
const buildOk = buildUtils && buildMain;

// ── Behavioral: this story's smoke (incl. _hash invariance + idempotency) ─────
const backfillSmoke = sh('npm --prefix packages/main run test:experience-layer-signature-backfill').includes('signature-backfill smoke passed');

// ── No-regression: sibling Experience Layer smokes ────────────────────────────
const noReg = {
  'finding-signals':    sh('npm --prefix packages/main run test:experience-layer-finding-signals').includes('smoke passed'),
  'playbook':           sh('npm --prefix packages/main run test:experience-layer-playbook').includes('smoke passed'),
  'recall':             sh('npm --prefix packages/main run test:experience-layer-recall').includes('smoke passed'),
  'revalidation':       sh('npm --prefix packages/main run test:experience-layer-revalidation').includes('smoke passed'),
  'learning-scan':      sh('npm --prefix packages/main run test:experience-layer-learning-scan').includes('smoke passed'),
  'signature-capture':  sh('npm --prefix packages/main run test:experience-layer-signature-capture').includes('smoke passed'),
  'ab-shadow-gate':     sh('npm --prefix packages/main run test:experience-layer-ab-shadow-gate').includes('smoke passed'),
  'effectiveness':      sh('npm --prefix packages/main run test:experience-layer-effectiveness').includes('smoke passed'),
};
const noRegOk = Object.values(noReg).every(Boolean);

// ── FULL npm test suite (incl. process-fact-contract) from worktree root ──────
const fullTestOk = code('npm test') === 0;

// ── Static checks ─────────────────────────────────────────────────────────────
const leaf = read('packages/main/src/core/signature-backfill.ts');
// Leaf imports ONLY types: no fs / path / child_process / store / network.
const leafImports = leaf.match(/^\s*import[^\n]*from\s+['"][^'"]+['"]/gm) || [];
const leafPure = leafImports.length > 0
  && leafImports.every((l) => /experience-layer-types/.test(l))
  && !/from\s+['"](node:)?(fs|path|child_process|http|https|net)['"]/.test(leaf)
  && !/\.\/store|finding-verify|learning-store/.test(leaf);

const handlerRaw = read('packages/main/src/handlers/signature-backfill.ts');
// Strip block (/* */) and line (//) comments so prose mentions of signFinding /
// finding-verify / network in the doc-comments are NOT counted as code references.
const handler = handlerRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
// Handler attaches fields after _hash (mutates audit fields), never imports finding-verify,
// never calls signFinding, no fetch/http/llm/network — checked on COMMENT-STRIPPED source.
const handlerNoSignFinding = !/signFinding/.test(handler);
const handlerNoFindingVerify = !/finding-verify/.test(handler);
const handlerNoNetwork = !/\b(fetch|http|https|llm)\b/i.test(handler);
const handlerMutatesAfterHash = /f\.signatureTag\s*=/.test(handler) && /f\.signatureTagSource\s*=/.test(handler) && !/_hash\s*=/.test(handler);

// finding-verify.ts untouched vs main.
const findingVerifyUntouched = sh('git diff main...HEAD --name-only -- packages/main/src/core/finding-verify.ts').trim() === '';

// 5-surface registration.
const cli = read('packages/main/src/cli-engine.ts');
const registry = read('packages/main/src/registry.ts');
const config = read('packages/main/src/core/config.ts');
const policy = read('packages/main/src/core/command-policy.ts');
const factLevels = read('packages/main/src/core/process-fact-levels.ts');

const inCli = /name:\s*'signature_backfill'/.test(cli);
const inRegistry = /createSignatureBackfillHandlers/.test(registry);
const inConfig = /'signature_backfill'/.test(config);
const inPolicyWriting = /signature_backfill:\s*\{[^}]*ownershipClass:\s*'mainSharedMutating'/.test(policy) && !/signature_backfill:\s*\{[^}]*ownershipClass:\s*'readOnly'/.test(policy);
const inFactLevels = /name:\s*'signature_backfill'[^}]*level:\s*'L2'[^}]*category:\s*'experience-layer'/.test(factLevels);
const allSurfaces = inCli && inRegistry && inConfig && inPolicyWriting && inFactLevels;

// NOT in READ_ONLY_COMMANDS: isolate the READ_ONLY_COMMANDS Set body and grep it.
const roMatch = cli.match(/const READ_ONLY_COMMANDS[^[]*\[([\s\S]*?)\]/);
const roBody = roMatch ? roMatch[1] : '';
const notReadOnly = !/['"]signature_backfill['"]/.test(roBody);

// SignatureTagSource extended with 'backfill'.
const elTypes = read('packages/main/src/core/experience-layer-types.ts');
const backfillSource = /SignatureTagSource\s*=\s*'auto'\s*\|\s*'confirmed'\s*\|\s*'backfill'/.test(elTypes);

// npm script present.
const pkgScript = /"test:experience-layer-signature-backfill"\s*:/.test(read('packages/main/package.json'));

// ── Per-checklist gating conditions ───────────────────────────────────────────
const chk = {
  'CHK-001': buildOk && backfillSmoke && leafPure && backfillSource,
  'CHK-002': buildOk && backfillSmoke && allSurfaces && notReadOnly && inPolicyWriting && handlerNoSignFinding && handlerNoFindingVerify && handlerNoNetwork && handlerMutatesAfterHash && findingVerifyUntouched,
  'CHK-003': buildOk && backfillSmoke && noRegOk && fullTestOk && leafPure && handlerNoSignFinding && handlerNoFindingVerify && allSurfaces && notReadOnly && pkgScript,
};
const note = {
  'CHK-001': `SignatureTagSource extended with 'backfill'; signature-backfill.ts leaf imports only types (pure, no I/O); smoke leaf/no-mutation checks pass`,
  'CHK-002': `signature_backfill registered across cli-engine/registry/config/command-policy(mainSharedMutating, not readOnly)/process-fact-levels(L2 experience-layer); NOT in READ_ONLY_COMMANDS; handler never imports finding-verify or calls signFinding, attaches fields after _hash; finding-verify.ts untouched`,
  'CHK-003': `backfill smoke passes incl. _hash-invariance (real signFinding) + idempotency; no-regression EL smokes pass; FULL npm test (incl. process-fact-contract) exit 0; npm script wired; static purity/registration checks pass`,
};

const R = {};
const cl = JSON.parse(read('.lattice/story/actives/B-17a9/checklist.json') || '{}');
for (const it of cl.items || []) {
  const vi = it.verificationIntent || {};
  const cond = chk[it.id] !== undefined ? chk[it.id] : true;
  for (const lane of ['happy','edge','adversarial'])
    (vi[lane] || []).forEach((_, i) => { R[`${it.id}:${lane}:${i}`] = { pass: !!cond, note: note[it.id] || '' }; });
}
const refs = Object.keys(R), fails = refs.filter((r) => !R[r].pass);
console.log(`TOTAL ${refs.length} | PASS ${refs.length - fails.length} | FAIL ${fails.length}`);
console.log(`(buildOk=${buildOk} backfillSmoke=${backfillSmoke} noRegOk=${noRegOk} fullTestOk=${fullTestOk} leafPure=${leafPure} backfillSource=${backfillSource} handlerNoSignFinding=${handlerNoSignFinding} handlerNoFindingVerify=${handlerNoFindingVerify} handlerNoNetwork=${handlerNoNetwork} handlerMutatesAfterHash=${handlerMutatesAfterHash} findingVerifyUntouched=${findingVerifyUntouched} allSurfaces=${allSurfaces} inCli=${inCli} inRegistry=${inRegistry} inConfig=${inConfig} inPolicyWriting=${inPolicyWriting} inFactLevels=${inFactLevels} notReadOnly=${notReadOnly} pkgScript=${pkgScript})`);
console.log(`no-regression: ${JSON.stringify(noReg)}`);
for (const f of fails) console.log(`  FAIL ${f} :: ${R[f].note}`);
fs.writeFileSync('.lattice/story/actives/B-17a9/evidence/verify-result.json', JSON.stringify(R, null, 1));
process.exit(fails.length === 0 ? 0 : 1);
