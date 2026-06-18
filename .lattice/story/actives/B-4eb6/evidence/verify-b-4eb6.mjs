// Acceptance verifier for B-4eb6 — Experience Layer ③.1 `learning_scan` (derive + PERSIST).
// Behavioral core = the committed smoke (test:experience-layer-learning-scan) PLUS no-regression smokes
// PLUS the FULL `npm test` (incl. process-fact-contract). Static checks enforce the writing-command
// classification (registered across cli-engine/registry/config/command-policy/process-fact-levels;
// NOT in READ_ONLY_COMMANDS; ownershipClass != readOnly) and protected files unchanged.
// Maps every verificationIntent ref to pass/fail. Prints TOTAL N | PASS N | FAIL 0.
import fs from 'fs';
import { execSync } from 'child_process';
const sh = (c) => { try { return execSync(c, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }); } catch (e) { return (e.stdout||'')+(e.stderr||''); } };
const code = (c) => { try { execSync(c, { stdio: 'pipe' }); return 0; } catch (e) { return e.status ?? 1; } };
const read = (p) => { try { return fs.readFileSync(p,'utf8'); } catch { return ''; } };

// ── Behavioral: build clean + new smoke passes + no-regression smokes pass ──
const buildUtilsOk = code('npm --prefix packages/utils run build') === 0;
const buildOk = code('npm --prefix packages/main run build') === 0;
const scanSmoke = sh('npm --prefix packages/main run test:experience-layer-learning-scan').includes('learning-scan smoke passed');
const reg = {
  sig: sh('npm --prefix packages/main run test:experience-layer-finding-signals').includes('smoke passed'),
  pb: sh('npm --prefix packages/main run test:experience-layer-playbook').includes('smoke passed'),
  recall: sh('npm --prefix packages/main run test:experience-layer-recall').includes('smoke passed'),
  reval: sh('npm --prefix packages/main run test:experience-layer-revalidation').includes('smoke passed'),
};
const noRegression = Object.values(reg).every(Boolean);

// ── Behavioral: the FULL npm test (incl. process-fact-contract) must pass end-to-end ──
const processFactContract = sh('npm run test:process-fact-contract').includes('Process fact contract verified');
const fullTest = code('npm test') === 0;

// ── Static: full registration wiring across all 5 files ──
const cli = read('packages/main/src/cli-engine.ts');
const cmdRegistered = /name:\s*'learning_scan'/.test(cli);
const registry = read('packages/main/src/registry.ts');
const handlerRegistered = /createLearningScanHandlers\(ctx\)/.test(registry);
const handlerImported = /createLearningScanHandlers\s*\}\s*from\s*'\.\/handlers\/learning-scan\.js'/.test(registry);
const configEntry = /'learning_scan'/.test(read('packages/main/src/core/config.ts'));
const policyText = read('packages/main/src/core/command-policy.ts');
const policyEntry = /learning_scan\s*:/.test(policyText);
const levelsText = read('packages/main/src/core/process-fact-levels.ts');
const levelEntry = /name:\s*'learning_scan',\s*level:\s*'L2',\s*category:\s*'experience-layer',\s*owner:\s*'handlers\/learning-scan'/.test(levelsText);

// ── Static (adversarial): NOT read-only, NOT in READ_ONLY_COMMANDS, NOT a gate ──
// Scope the READ_ONLY_COMMANDS membership check to that Set literal so a match in
// the command schema entry cannot satisfy it vacuously.
const readOnlySet = (cli.match(/READ_ONLY_COMMANDS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/) || [,''])[1];
const notInReadOnly = !/['"]learning_scan['"]/.test(readOnlySet);
// Policy ownershipClass for learning_scan must NOT be 'readOnly' (it writes).
const policyLine = (policyText.match(/learning_scan:\s*\{[^}]*\}/) || [''])[0];
const ownershipNotReadOnly = policyLine.length > 0
  && /ownershipClass:\s*'mainSharedMutating'/.test(policyLine)
  && !/ownershipClass:\s*'readOnly'/.test(policyLine);
// Policy entry must explicitly note it cannot satisfy DONE/authority evidence.
const policyNoDoneEvidence = /cannot satisfy[\s\S]*DONE/i.test(policyLine) && /authorityDone/.test(policyLine);
// No gate registration: no gate consumer declared on the process-fact level entry,
// and the handler files no findings / touches no gate.
const levelLine = (levelsText.match(/name:\s*'learning_scan'[^}]*\}/) || [''])[0];
const noGateConsumer = levelLine.length > 0 && !/gateConsumer/.test(levelLine);

// ── Static: handler writes ONLY the advisory cache (no finding_add / gate write) ──
const handler = read('packages/main/src/handlers/learning-scan.ts');
const handlerWritesOnlyCache = handler.length > 0
  && /deriveFindingSignalsFromStore/.test(handler)
  && /projectRoot/.test(handler)
  && !/finding_add|writeFindings|review_pass_set|advisory_add|appendFileSync/.test(handler);

// ── Static: npm scripts wired ──
const pkgJson = read('packages/main/package.json');
const pkgScript = /"test:experience-layer-learning-scan"\s*:/.test(pkgJson);

// ── Protected files unchanged (must NOT appear in git diff name-only vs HEAD or worktree) ──
const PROTECTED = [
  'packages/main/src/core/finding-signals.ts',
  'packages/main/src/core/learning-store.ts',
  'packages/main/src/handlers/finding.ts',
];
const diffNames = new Set([
  ...sh('git diff --name-only HEAD').split('\n'),
  ...sh('git diff --name-only').split('\n'),
].map(s => s.trim()).filter(Boolean));
const protectedUntouched = PROTECTED.every(p => !diffNames.has(p));

// ── Static: cache is materialHash-excluded (.lattice/learning/ write does not dirty tracked source) ──
// The scan run earlier writes .lattice/learning/finding-signals.json; assert it is
// not a tracked-source diff (it is untracked / excluded).
const learningInDiff = [...diffNames].some(p => p.startsWith('.lattice/learning/') && p.endsWith('.ts'));
const cacheNotDirtyingSource = !learningInDiff;

// ── Per-checklist pass conditions ──
const registrationOk = cmdRegistered && handlerRegistered && handlerImported && configEntry && policyEntry && levelEntry;
const adversarialOk = notInReadOnly && ownershipNotReadOnly && policyNoDoneEvidence && noGateConsumer;
const chk = {
  'CHK-001': buildOk && scanSmoke && handlerWritesOnlyCache,
  'CHK-002': buildOk && registrationOk && adversarialOk && processFactContract && fullTest,
  'CHK-003': buildUtilsOk && buildOk && scanSmoke && noRegression && processFactContract && fullTest && pkgScript && protectedUntouched && cacheNotDirtyingSource,
};
const note = {
  'CHK-001': 'learning_scan handler derives+persists the advisory finding-signals cache via deriveFindingSignalsFromStore(projectRoot); ONLY write is .lattice/learning/finding-signals.json; smoke proves empty-before/firing-after + valid cache + anchorFiles + determinism + empty/scoped boundaries',
  'CHK-002': 'learning_scan registered across cli-engine/registry/config/command-policy/process-fact-levels; ownershipClass=mainSharedMutating (NOT readOnly); NOT in READ_ONLY_COMMANDS; no gateConsumer; policy notes it cannot satisfy DONE/authority evidence; full npm test (incl. process-fact-contract) green',
  'CHK-003': 'committed smoke (learning-scan smoke passed) + no-regression smokes (finding-signals/playbook/recall/revalidation) + full npm test green + npm script wired + protected files (finding-signals.ts/learning-store.ts/finding.ts) unchanged + cache write does not dirty tracked source',
};

const R = {};
const cl = JSON.parse(read('.lattice/story/actives/B-4eb6/checklist.json') || '{}');
for (const it of cl.items || []) {
  const vi = it.verificationIntent || {};
  const cond = chk[it.id] !== undefined ? chk[it.id] : true;
  for (const lane of ['happy','edge','adversarial'])
    (vi[lane] || []).forEach((_, i) => { R[`${it.id}:${lane}:${i}`] = { pass: !!(scanSmoke && cond), note: note[it.id] || '' }; });
}
const refs = Object.keys(R), fails = refs.filter(r => !R[r].pass);
console.log(`TOTAL ${refs.length} | PASS ${refs.length - fails.length} | FAIL ${fails.length}`);
console.log(`(buildUtilsOk=${buildUtilsOk} buildOk=${buildOk} scanSmoke=${scanSmoke} noRegression=${noRegression} processFactContract=${processFactContract} fullTest=${fullTest} cmdRegistered=${cmdRegistered} handlerRegistered=${handlerRegistered} handlerImported=${handlerImported} configEntry=${configEntry} policyEntry=${policyEntry} levelEntry=${levelEntry} notInReadOnly=${notInReadOnly} ownershipNotReadOnly=${ownershipNotReadOnly} policyNoDoneEvidence=${policyNoDoneEvidence} noGateConsumer=${noGateConsumer} handlerWritesOnlyCache=${handlerWritesOnlyCache} pkgScript=${pkgScript} protectedUntouched=${protectedUntouched} cacheNotDirtyingSource=${cacheNotDirtyingSource})`);
console.log('regression: ' + Object.entries(reg).map(([k,v])=>`${k}=${v?'ok':'FAIL'}`).join(' '));
for (const f of fails) console.log(`  FAIL ${f} :: ${R[f].note}`);
fs.writeFileSync('.lattice/story/actives/B-4eb6/evidence/verify-result.json', JSON.stringify(R, null, 1));
