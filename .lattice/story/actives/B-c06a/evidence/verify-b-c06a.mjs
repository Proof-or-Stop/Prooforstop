// Acceptance verifier for B-c06a — Experience Layer ③.4 learning_effectiveness.
// Behavioral core = the committed effectiveness smoke (test:experience-layer-effectiveness)
// PLUS no-regression smokes PLUS the FULL npm test (incl. process-fact-contract).
// Static checks enforce leaf purity (node:/types only), read-only handler (no
// write/finding/gate/projectRoot), and full registration across all 6 surfaces
// (cli-engine command schema, registry registerBatch, config DEFAULT_PHASE_TOOLS,
// command-policy readOnly entry, process-fact-levels L0 entry, READ_ONLY_COMMANDS).
// Maps every verificationIntent ref to pass/fail. Prints TOTAL N | PASS N | FAIL 0.
import fs from 'fs';
import { execSync } from 'child_process';
const sh = (c) => { try { return execSync(c, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }); } catch (e) { return (e.stdout||'')+(e.stderr||''); } };
const code = (c) => { try { execSync(c, { stdio: 'pipe' }); return 0; } catch (e) { return e.status ?? 1; } };
const read = (p) => { try { return fs.readFileSync(p,'utf8'); } catch { return ''; } };

// ── Behavioral: build clean + new smoke passes ──
const buildUtils = code('npm --prefix packages/utils run build') === 0;
const buildOk = code('npm --prefix packages/main run build') === 0;
const effSmoke = sh('npm --prefix packages/main run test:experience-layer-effectiveness').includes('effectiveness smoke passed');

// ── No-regression smokes (each prints "smoke passed") ──
const reg = {
  findingSignals: sh('npm --prefix packages/main run test:experience-layer-finding-signals').includes('smoke passed'),
  playbook: sh('npm --prefix packages/main run test:experience-layer-playbook').includes('smoke passed'),
  recall: sh('npm --prefix packages/main run test:experience-layer-recall').includes('smoke passed'),
  revalidation: sh('npm --prefix packages/main run test:experience-layer-revalidation').includes('smoke passed'),
  learningScan: sh('npm --prefix packages/main run test:experience-layer-learning-scan').includes('smoke passed'),
  signatureCapture: sh('npm --prefix packages/main run test:experience-layer-signature-capture').includes('smoke passed'),
  abShadowGate: sh('npm --prefix packages/main run test:experience-layer-ab-shadow-gate').includes('smoke passed'),
};
const noRegression = Object.values(reg).every(Boolean);

// ── FULL npm test (incl. process-fact-contract) from the worktree root ──
const fullTestExit = code('npm test');
const fullTestOk = fullTestExit === 0;

// ── Static: leaf purity (experience-effectiveness.ts imports ONLY node:/types) ──
const leaf = read('packages/main/src/core/experience-effectiveness.ts');
const leafImports = [...leaf.matchAll(/from '([^']+)'/g)].map(m => m[1]);
// Only `import type ...` lines (type-only) and node: builtins are allowed. The
// leaf currently imports nothing at runtime, so leafImports may be empty (OK).
const leafIso = leaf.length > 0 && leafImports.every(i => i.startsWith('node:'));
const leafNoIo = leaf.length > 0
  && !/from '(node:)?(fs|child_process|path|node:fs\/promises)'/.test(leaf)
  && !/\b(execFileSync|execSync|readFileSync|writeFileSync|appendFileSync)\b/.test(leaf);
// Determinism guards: no hidden RNG / clock / env dependency.
const leafDeterministic = leaf.length > 0
  && !/Math\.random|Date\.now|new Date\(|process\.env/.test(leaf);

// ── Static: handler read-only (no write/finding/gate; no projectRoot persist) ──
const handler = read('packages/main/src/handlers/learning-effectiveness.ts');
const handlerReadOnly = handler.length > 0
  && !/writeFileSync|appendFileSync|writeFindings|writeStory|finding_add|advisory_add|appendActivityLog/.test(handler);
const handlerNoProjectRoot = handler.length > 0 && !/projectRoot\s*:/.test(handler);

// ── Static: full registration wiring (all 6 surfaces) ──
const cli = read('packages/main/src/cli-engine.ts');
const cmdRegistered = /name:\s*['"]learning_effectiveness['"]/.test(cli);
const registry = read('packages/main/src/registry.ts');
const handlerRegistered = /createLearningEffectivenessHandlers\(ctx\)/.test(registry)
  && /from '\.\/handlers\/learning-effectiveness\.js'/.test(registry);
const configEntry = /'learning_effectiveness'/.test(read('packages/main/src/core/config.ts'));
const policy = read('packages/main/src/core/command-policy.ts');
const policyEntry = /learning_effectiveness\s*:/.test(policy);
// Read-only contract in the policy entry: ownershipClass readOnly + destructiveRisk none.
const policyBlock = (policy.match(/learning_effectiveness\s*:\s*\{[\s\S]*?\},/) || [''])[0];
const policyReadOnly = /ownershipClass:\s*'readOnly'/.test(policyBlock)
  && /destructiveRisk:\s*'none'/.test(policyBlock)
  && /allowedPhases:\s*'all'/.test(policyBlock);
const factLevels = read('packages/main/src/core/process-fact-levels.ts');
const factLevelEntry = /name:\s*'learning_effectiveness',\s*level:\s*'L0',\s*category:\s*'experience-layer-read'/.test(factLevels);
// READ_ONLY_COMMANDS membership (scope to that Set literal so a schema match doesn't satisfy it).
const readOnlySet = (cli.match(/READ_ONLY_COMMANDS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/) || [,''])[1];
const readOnlyListed = /['"]learning_effectiveness['"]/.test(readOnlySet);

// ── Static: npm script wired ──
const pkgJson = read('packages/main/package.json');
const pkgScript = /"test:experience-layer-effectiveness"\s*:/.test(pkgJson);

const allReg = cmdRegistered && handlerRegistered && configEntry && policyEntry && policyReadOnly && factLevelEntry && readOnlyListed;

// ── Per-checklist pass conditions ──
const chk = {
  'CHK-001': leafIso && leafNoIo && leafDeterministic && effSmoke && buildOk,
  'CHK-002': allReg && handlerReadOnly && handlerNoProjectRoot && buildOk,
  'CHK-003': effSmoke && pkgScript && noRegression && fullTestOk && allReg && handlerReadOnly && leafIso && buildOk,
};
const note = {
  'CHK-001': 'experience-effectiveness.ts imports ONLY node:/types (no fs/child_process/path), no RNG/clock/env; smoke asserts exact recall/precision/windows/slope + never-NaN + determinism + conservative arm gate',
  'CHK-002': 'learning_effectiveness registered across all 6 surfaces (cli command schema + READ_ONLY_COMMANDS, registry registerBatch, config DEFAULT_PHASE_TOOLS, command-policy readOnly/none/all, process-fact-levels L0 experience-layer-read); handler writes nothing / no finding / no gate / no projectRoot',
  'CHK-003': 'effectiveness smoke passes + npm script wired + no-regression smokes (finding-signals/playbook/recall/revalidation/learning-scan/signature-capture/ab-shadow-gate) + FULL npm test (incl. process-fact-contract) exit 0',
};

const R = {};
const cl = JSON.parse(read('.lattice/story/actives/B-c06a/checklist.json') || '{}');
for (const it of cl.items || []) {
  const vi = it.verificationIntent || {};
  const cond = chk[it.id] !== undefined ? chk[it.id] : true;
  for (const lane of ['happy','edge','adversarial'])
    (vi[lane] || []).forEach((_, i) => { R[`${it.id}:${lane}:${i}`] = { pass: !!(effSmoke && cond), note: note[it.id] || '' }; });
}
const refs = Object.keys(R), fails = refs.filter(r => !R[r].pass);
console.log(`TOTAL ${refs.length} | PASS ${refs.length - fails.length} | FAIL ${fails.length}`);
console.log(`(buildUtils=${buildUtils} buildOk=${buildOk} effSmoke=${effSmoke} noRegression=${noRegression} fullTestOk=${fullTestOk} leafIso=${leafIso} leafNoIo=${leafNoIo} leafDeterministic=${leafDeterministic} handlerReadOnly=${handlerReadOnly} handlerNoProjectRoot=${handlerNoProjectRoot} cmdRegistered=${cmdRegistered} handlerRegistered=${handlerRegistered} configEntry=${configEntry} policyEntry=${policyEntry} policyReadOnly=${policyReadOnly} factLevelEntry=${factLevelEntry} readOnlyListed=${readOnlyListed} pkgScript=${pkgScript})`);
console.log('regression: ' + Object.entries(reg).map(([k,v])=>`${k}=${v?'ok':'FAIL'}`).join(' '));
for (const f of fails) console.log(`  FAIL ${f} :: ${R[f].note}`);
fs.writeFileSync('.lattice/story/actives/B-c06a/evidence/verify-result.json', JSON.stringify(R, null, 1));
