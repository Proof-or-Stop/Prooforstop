


import assert from 'node:assert/strict';

import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';



import ts from 'typescript';



import { check } from "./runner.mjs";
import { identityCutoverSourceMap } from "./identity-inventory.mjs";
import { assertOwnedIdentitySiteTotality, assertOwnedImportUseIntegrity, deriveOwnedImportUseContexts, deriveOwnedIdentityLiterals, assertDerivedIdentitySiteTotality } from "./identity-ownership.mjs";
import { IDENTITY_CUTOVER_REQUIRED_PATHS, repoRoot, ACTIVE_IDENTITY_OPERATION_BOUNDARIES, OWNED_NON_PROTOCOL_IDENTITY_CONTEXTS, OWNED_IMPORT_USE_CONTEXTS, PROJECT_CONFIG_IDENTITY_CASES, OWNED_IDENTITY_SITE_CONTEXTS, OWNED_IMPORTED_IDENTITY_ORIGINS, distRoot, fixtureRoots, assertCanonicalActiveIdentityRuntime, packageRoot, assertCanonicalActiveIdentityBoundary, retiredProtocolPrefix, promptContracts, mainRoot, INERT_PUBLIC_FIXTURE_LOG_SUBTREE } from "./data.mjs";
import { git } from "./fixture-support.mjs";
import { ensurePublicIdentityOperationFixture, snapshotGitMaterial, assertCanonicalPublicIdentityOperations } from "./public-fixtures.mjs";

export async function runCases() {
await check(["identity-sites", "identity-config-boundary", "identity-policy-boundary", "round24"], 'F-060 all owned source and emitted identity sites have independent totality and public-operation cases', () => {
  const sources = identityCutoverSourceMap();
  assertOwnedIdentitySiteTotality(sources);
  assertOwnedImportUseIntegrity(sources);
  const emitted = new Map(sources);
  for (const path of IDENTITY_CUTOVER_REQUIRED_PATHS.filter(path => path.endsWith('.ts'))) {
    emitted.set(path, readFileSync(join(repoRoot, path.replace('/src/', '/dist/').replace(/\.ts$/u, '.js')), 'utf8'));
  }
  assertOwnedIdentitySiteTotality(emitted, ACTIVE_IDENTITY_OPERATION_BOUNDARIES, OWNED_NON_PROTOCOL_IDENTITY_CONTEXTS, { emitted: true });
});

await check(["identity-sites"], 'F-060 reconciled consumers still reject added and moved identity uses', () => {
  const sources = identityCutoverSourceMap();
  assertOwnedIdentitySiteTotality(sources);
  assertOwnedImportUseIntegrity(sources);
  for (const [path, original, changed, importedName] of [
    ['packages/main/src/core/store.ts', 'isWithinValidationEvidenceWriteBound(bytes)', 'isWithinValidationEvidenceWriteBound(bytes + 1)', 'isWithinValidationEvidenceWriteBound'],
    ['scripts/verify-proof-or-stop-identity-cutover.mjs', "mkdtempSync(join(tmpdir(), 'identity-current-witness-'))", "mkdtempSync(join(tmpdir(), 'identity-current-witness-changed-'))", 'readFileSync'],
  ]) {
    assert.equal(sources.get(path).split(original).length - 1, 1, 'reviewed imported call must be unique');
    const changedSources = new Map(sources);
    changedSources.set(path, sources.get(path).replace(original, changed));
    const expected = OWNED_IMPORT_USE_CONTEXTS.find(row => row.sourcePath === path);
    const observed = deriveOwnedImportUseContexts(changedSources).find(row => row.sourcePath === path);
    assert.equal(observed.occurrences, expected.occurrences, 'changed call preserves imported-use count');
    assert.notEqual(observed.contextSha256, expected.contextSha256, 'changed call changes exact context');
    assert.throws(() => assertOwnedImportUseIntegrity(changedSources), /owned import use changed/, 'same-count changed call must be refused');
    const additional = new Map(sources);
    additional.set(path, `${sources.get(path)}\nvoid ${importedName};\n`);
    assert.throws(() => assertOwnedImportUseIntegrity(additional), /owned import use changed/, 'new imported use must be refused');
  }
  for (const inputCase of PROJECT_CONFIG_IDENTITY_CASES) {
    assert.throws(() => assertOwnedIdentitySiteTotality(sources, ACTIVE_IDENTITY_OPERATION_BOUNDARIES,
      OWNED_NON_PROTOCOL_IDENTITY_CONTEXTS, { projectConfigCases: PROJECT_CONFIG_IDENTITY_CASES.filter(row => row !== inputCase) }),
      /unclassified owned executable identity sites/, `omitted config case: ${inputCase.siteId}`);
  }
  const registryPath = 'packages/main/src/core/process-fact-registry.ts';
  const registryDefault = 'entries: readonly unknown[] = PROCESS_FACT_REGISTRY';
  assert.equal(sources.get(registryPath).split(registryDefault).length - 1, 1, 'reviewed registry default must be unique');
  const registryMoved = new Map(sources);
  registryMoved.set(registryPath, sources.get(registryPath).replace(registryDefault, `${registryDefault}.slice(0, 0)`));
  const registryPin = OWNED_IMPORT_USE_CONTEXTS.find(row => row.sourcePath === registryPath);
  const registryContext = deriveOwnedImportUseContexts(registryMoved).find(row => row.sourcePath === registryPath);
  assert.equal(registryContext.occurrences, registryPin.occurrences, 'registry default mutation preserves imported-use count');
  assert.notEqual(registryContext.contextSha256, registryPin.contextSha256, 'registry default mutation changes exact context');
  assert.throws(() => assertOwnedImportUseIntegrity(registryMoved), /owned import use changed/, 'same-count registry default remains closed');
  const registryAdded = new Map(sources);
  registryAdded.set(registryPath, `${sources.get(registryPath)}\nvoid PROCESS_FACT_REGISTRY;\n`);
  assert.throws(() => assertOwnedImportUseIntegrity(registryAdded), /owned import use changed/, 'added registry imported use remains closed');
  const signerPath = 'packages/main/src/core/verification-execution-evidence.ts';
  const readerCall = 'join(location.commonDir, VERIFICATION_SIGNER_KEY_FILE)';
  assert.equal(sources.get(signerPath).split(readerCall).length - 1, 1, 'the reviewed located signer reader must be unique');
  const moved = new Map(sources);
  moved.set(signerPath, sources.get(signerPath).replace(readerCall, 'join(gitCwd, VERIFICATION_SIGNER_KEY_FILE)'));
  assert.throws(() => assertOwnedIdentitySiteTotality(moved), /owned identity use context changed/, 'same signer identity and count cannot move to another directory authority');
  for (const path of [signerPath, 'packages/main/src/handlers/agent-prompt.ts']) {
    const pin = OWNED_IDENTITY_SITE_CONTEXTS.find(row => row.sourcePath === path);
    const added = new Map(sources);
    added.set(path, `${sources.get(path)}\nconst unreviewedIdentityConsumer = ${JSON.stringify(pin.canonical)};\n`);
    assert.throws(() => assertOwnedIdentitySiteTotality(added), /owned identity use count changed/, path);
  }
  const changedConfig = new Map(sources);
  const config = JSON.parse(sources.get('proof-or-stop.config.json'));
  config.unreviewedIdentityConsumer = 'proof-or-stop.config.json';
  changedConfig.set('proof-or-stop.config.json', JSON.stringify(config));
  assert.throws(() => assertOwnedIdentitySiteTotality(changedConfig), /owned identity classification count drift/, 'reviewed command-index movement does not admit a new config use');
  // Move one actual scheduler claim to another command without adding/removing
  // any canonical literal. Classification context must reject this too.
  const resourceMoved = new Map(sources);
  const movedConfig = JSON.parse(sources.get('proof-or-stop.config.json'));
  const resourceKey = 'proof-or-stop-real-root-admission';
  const from = movedConfig.validate.commands.find(command => command.resources?.some(resource => resource.key === resourceKey));
  const to = movedConfig.validate.commands.find(command => !command.resources?.some(resource => resource.key === resourceKey));
  assert.ok(from && to && from !== to, 'the movement control needs distinct configured commands');
  const index = from.resources.findIndex(resource => resource.key === resourceKey);
  const [claim] = from.resources.splice(index, 1);
  (to.resources ??= []).push(claim);
  resourceMoved.set('proof-or-stop.config.json', JSON.stringify(movedConfig));
  const movedResource = deriveOwnedIdentityLiterals(resourceMoved).find(row => row.sourcePath === 'proof-or-stop.config.json' && row.canonical === resourceKey);
  const resourcePin = OWNED_NON_PROTOCOL_IDENTITY_CONTEXTS.find(row => row.sourcePath === 'proof-or-stop.config.json' && row.canonical === resourceKey);
  assert.equal(movedResource.occurrences, resourcePin.occurrences, 'movement must preserve all eight resource claims');
  assert.notEqual(movedResource.contextSha256, resourcePin.contextSha256, 'movement must actually change the structural location');
  assert.throws(() => assertOwnedIdentitySiteTotality(resourceMoved), /owned identity classification context drift/, 'same-count scheduler claim movement must remain rejected');
  for (const path of [
    'packages/main/src/core/evidence-freshness.ts',
    'packages/main/src/core/lifecycle-control/queue/index.ts',
    'packages/main/src/core/process-fact-registry.ts',
    'packages/main/src/core/prompt-registry.ts',
    signerPath,
    'packages/main/src/handlers/agent-prompt.ts',
    'packages/main/src/handlers/checklist.ts',
  ]) {
    const emitted = ts.transpileModule(sources.get(path), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
    const ast = ts.createSourceFile(path, emitted, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const binding = ast.statements.filter(ts.isImportDeclaration).flatMap(node => {
      const names = node.importClause?.namedBindings;
      return names && ts.isNamedImports(names) ? names.elements.map(entry => entry.name.text) : [];
    })[0];
    assert.ok(binding, `reviewed import consumer needs an actual executable binding: ${path}`);
    const added = new Map(sources);
    added.set(path, `${sources.get(path)}\nvoid ${binding};\n`);
    assert.throws(() => assertOwnedImportUseIntegrity(added), /owned import use changed/, path);
  }
});

await check(["identity-sites"], 'F-060 causal index central identity retains exact consumer coverage', () => {
  const sources = identityCutoverSourceMap();
  const causalConsumer = 'packages/main/src/core/store.ts';
  const causalOrigin = 'packages/main/src/core/causal-evidence.ts';
  const causalIdentity = 'proof-or-stop.causal-evidence-index.v1';
  const causalPin = OWNED_IDENTITY_SITE_CONTEXTS.find(row => row.sourcePath === causalConsumer && row.canonical === causalIdentity);
  const assertCausalConsumer = sourceMap => assert.deepEqual(
    deriveOwnedIdentityLiterals(sourceMap).find(row => row.sourcePath === causalConsumer && row.canonical === causalIdentity),
    causalPin, 'causal index imported consumer must retain its exact count and context');
  assert.ok(causalPin, 'causal index consumer must retain its independently reviewed pin');
  assertCausalConsumer(sources);
  const originDeclaration = "export const CAUSAL_EVIDENCE_INDEX_SCHEMA = 'proof-or-stop.causal-evidence-index.v1' as const;";
  assert.equal(sources.get(causalOrigin).split(originDeclaration).length - 1, 1, 'central causal identity declaration must be unique');
  const changedOrigin = new Map(sources);
  changedOrigin.set(causalOrigin, sources.get(causalOrigin).replace(originDeclaration, originDeclaration.replace(causalIdentity, 'proof-or-stop.unreviewed-causal-index.v1')));
  assert.throws(() => assertCausalConsumer(changedOrigin), /causal index imported consumer/, 'central literal substitution must remain refused');
  const addedUse = new Map(sources);
  addedUse.set(causalConsumer, `${sources.get(causalConsumer)}\nvoid CAUSAL_EVIDENCE_INDEX_SCHEMA;\n`);
  assert.throws(() => assertCausalConsumer(addedUse), /causal index imported consumer/, 'new imported consumer must remain refused');
  const consumerComparison = 'index.schemaVersion === CAUSAL_EVIDENCE_INDEX_SCHEMA';
  assert.equal(sources.get(causalConsumer).split(consumerComparison).length - 1, 1, 'causal index comparison must be unique');
  const movedUse = new Map(sources);
  movedUse.set(causalConsumer, sources.get(causalConsumer).replace(consumerComparison, 'index.schemaVersion !== CAUSAL_EVIDENCE_INDEX_SCHEMA'));
  const movedContext = deriveOwnedIdentityLiterals(movedUse).find(row => row.sourcePath === causalConsumer && row.canonical === causalIdentity);
  assert.equal(movedContext.occurrences, causalPin.occurrences, 'comparison mutation preserves consumer count');
  assert.notEqual(movedContext.contextSha256, causalPin.contextSha256, 'comparison mutation changes exact consumer context');
  assert.throws(() => assertCausalConsumer(movedUse), /causal index imported consumer/, 'same-count changed consumer must remain refused');
});

await check(["identity-sites"], 'F-060 memory v2 ownership retains exact consumer and mutation coverage', () => {
  const sources = identityCutoverSourceMap();
  assertOwnedIdentitySiteTotality(sources);
  assertOwnedImportUseIntegrity(sources);
  for (const [path, canonical, binding, property] of [
    ['packages/main/src/core/playbook-runtime-memory-cache.ts', 'proof-or-stop.runtime-memory-pack-cache.v2', 'RUNTIME_MEMORY_PACK_CACHE_POLICY_VERSION', 'consumerPolicyVersion'],
    ['packages/main/src/core/playbook-runtime-memory.ts', 'proof-or-stop.memory-pack.v1', 'SCHEMA_VERSION', 'schemaVersion'],
  ]) {
    const owner = ACTIVE_IDENTITY_OPERATION_BOUNDARIES.flatMap(row => row.identitySites).filter(row => row.sourcePath === path && row.canonical === canonical);
    assert.equal(owner.length, 1, 'current memory identity must have one actual registry owner');
    assert.equal(ACTIVE_IDENTITY_OPERATION_BOUNDARIES.flatMap(row => row.retiredIdentityCases).filter(row => row.siteId === owner[0].siteId).length, 1, 'current memory identity must retain its public-operation mutation case');
    const pin = OWNED_IDENTITY_SITE_CONTEXTS.find(row => row.sourcePath === path && row.canonical === canonical);
    const added = new Map(sources);
    added.set(path, `${sources.get(path)}\nvoid ${binding};\n`);
    assert.throws(() => assertOwnedIdentitySiteTotality(added), /owned identity use count changed/, 'additional memory identity use remains refused');
    const original = `${property}: ${binding}`;
    assert.ok(sources.get(path).includes(original), 'actual consumer property must exist');
    const moved = new Map(sources);
    moved.set(path, sources.get(path).replace(original, `${property}Changed: ${binding}`));
    const observed = deriveOwnedIdentityLiterals(moved).find(row => row.sourcePath === path && row.canonical === canonical);
    assert.equal(observed.occurrences, pin.occurrences, 'moved memory consumer retains original count');
    assert.throws(() => assertOwnedIdentitySiteTotality(moved), /owned identity use context changed/, 'same-count memory consumer movement remains refused');
    const omittedCase = ACTIVE_IDENTITY_OPERATION_BOUNDARIES.map(row => ({ ...row, retiredIdentityCases: row.retiredIdentityCases.filter(entry => entry.siteId !== owner[0].siteId) }));
    assert.throws(() => assertOwnedIdentitySiteTotality(sources, omittedCase), /owned identity case missing/, 'current memory mutation case cannot be removed');
  }
});

await check(["identity-sites", "round24"], 'F-060 discovered-site omissions and new typed producers fail independently of registry agreement', async () => {
  const sources = identityCutoverSourceMap();
  const derived = assertOwnedIdentitySiteTotality(sources);
  for (const usage of [
    'import { CANDIDATE_SET_SCHEMA as ImportedIdentity } from "./candidate-spec-routing.js"; export const addedImportedProducer = { schemaVersion: ImportedIdentity };',
    'import * as ImportedIdentities from "./candidate-spec-routing.js"; export const addedNamespaceProducer = { schemaVersion: ImportedIdentities.CANDIDATE_SET_SCHEMA };',
    'import { CANDIDATE_SET_SCHEMA as ImportedIdentity } from "./candidate-spec-routing.js"; export function addedImportedReader(value) { return value === ImportedIdentity; }',
    'import { constructIdentity } from "./unresolved-identity.js"; export const addedUnresolvedProducer = { schemaVersion: constructIdentity() };',
  ]) {
    const changed = new Map(sources);
    const path = 'packages/main/src/core/candidate-spec-routing.ts';
    changed.set(path, `${sources.get(path)}\n${usage}\n`);
    assert.throws(() => assertOwnedImportUseIntegrity(changed), /owned import use changed/, usage);
  }
  assert.throws(() => assertOwnedImportUseIntegrity(sources, OWNED_IMPORT_USE_CONTEXTS.slice(1)), /owned import use changed/);
  const aliasSources = new Map(sources);
  const aliasPath = 'packages/main/src/core/candidate-spec-routing.ts';
  aliasSources.set(aliasPath, `${sources.get(aliasPath)}\nimport { OTHER_SCHEMA } from './other.js'; const importedAlias = OTHER_SCHEMA;\n`);
  const aliasPins = deriveOwnedImportUseContexts(aliasSources);
  aliasSources.set(aliasPath, `${aliasSources.get(aliasPath)}\nexport const aliasedProducer = { schemaVersion: importedAlias };\n`);
  assert.throws(() => assertOwnedImportUseIntegrity(aliasSources, aliasPins), /owned import use changed/);
  for (const [consumerPath, originPath, exportName] of OWNED_IMPORTED_IDENTITY_ORIGINS) {
    const originSites = ACTIVE_IDENTITY_OPERATION_BOUNDARIES.flatMap(boundary => boundary.identitySites).filter(site => site.sourcePath === consumerPath && site.identityOrigin?.sourcePath === originPath && site.identityOrigin.exportName === exportName);
    assert.equal(originSites.length, 1, `imported identity origin has no exact consumer operation site: ${originPath}#${exportName}`);
    const changedOrigin = new Map(sources);
    changedOrigin.set(originPath, readFileSync(join(repoRoot, originPath), 'utf8').replace(exportName, `${exportName}_REMOVED`));
    assert.throws(() => deriveOwnedIdentityLiterals(changedOrigin), /imported identity origin missing/, exportName);
  }
  const allSites = ACTIVE_IDENTITY_OPERATION_BOUNDARIES.flatMap(boundary => boundary.identitySites);
  for (const row of derived) {
    const site = allSites.find(site => site.sourcePath === row.sourcePath && site.canonical === row.canonical);
    if (site) {
      // Remove BOTH declarations: site-to-case equality remains true, but the
      // independently observed source still requires this identity's coverage.
      const omitted = ACTIVE_IDENTITY_OPERATION_BOUNDARIES.map(boundary => ({ ...boundary,
        identitySites: boundary.identitySites.filter(entry => entry.siteId !== site.siteId),
        retiredIdentityCases: boundary.retiredIdentityCases.filter(entry => entry.siteId !== site.siteId),
      }));
      assert.throws(() => assertDerivedIdentitySiteTotality(derived, omitted, OWNED_NON_PROTOCOL_IDENTITY_CONTEXTS), /unclassified owned executable identity sites/, site.siteId);
      const missingCase = ACTIVE_IDENTITY_OPERATION_BOUNDARIES.map(boundary => ({ ...boundary,
        retiredIdentityCases: boundary.retiredIdentityCases.filter(entry => entry.siteId !== site.siteId),
      }));
      assert.throws(() => assertDerivedIdentitySiteTotality(derived, missingCase, OWNED_NON_PROTOCOL_IDENTITY_CONTEXTS), /owned identity case missing\/duplicate/, site.siteId);
      const missingContext = OWNED_IDENTITY_SITE_CONTEXTS.filter(entry => entry.sourcePath !== row.sourcePath || entry.canonical !== row.canonical);
      assert.throws(() => assertDerivedIdentitySiteTotality(derived, ACTIVE_IDENTITY_OPERATION_BOUNDARIES, OWNED_NON_PROTOCOL_IDENTITY_CONTEXTS, { contextPins: missingContext }), /owned identity occurrence context missing\/duplicate/, site.siteId);
    } else if (PROJECT_CONFIG_IDENTITY_CASES.some(entry => entry.sourcePath === row.sourcePath && entry.canonical === row.canonical)) {
      const omitted = PROJECT_CONFIG_IDENTITY_CASES.filter(entry => entry.sourcePath !== row.sourcePath || entry.canonical !== row.canonical);
      assert.throws(() => assertDerivedIdentitySiteTotality(derived, ACTIVE_IDENTITY_OPERATION_BOUNDARIES, OWNED_NON_PROTOCOL_IDENTITY_CONTEXTS,
        { projectConfigCases: omitted }), /unclassified owned executable identity sites/, row.canonical);
      const pins = OWNED_IDENTITY_SITE_CONTEXTS.filter(entry => entry.sourcePath !== row.sourcePath || entry.canonical !== row.canonical);
      assert.throws(() => assertDerivedIdentitySiteTotality(derived, ACTIVE_IDENTITY_OPERATION_BOUNDARIES, OWNED_NON_PROTOCOL_IDENTITY_CONTEXTS,
        { contextPins: pins }), /owned identity occurrence context missing\/duplicate/, row.canonical);
    } else {
      const omitted = OWNED_NON_PROTOCOL_IDENTITY_CONTEXTS.filter(entry => entry.sourcePath !== row.sourcePath || entry.canonical !== row.canonical);
      assert.throws(() => assertDerivedIdentitySiteTotality(derived, ACTIVE_IDENTITY_OPERATION_BOUNDARIES, omitted), /unclassified owned executable identity sites/, row.canonical);
      const drifted = derived.map(entry => entry === row ? { ...entry, occurrences: entry.occurrences + 1 } : entry);
      assert.throws(() => assertDerivedIdentitySiteTotality(drifted, ACTIVE_IDENTITY_OPERATION_BOUNDARIES, OWNED_NON_PROTOCOL_IDENTITY_CONTEXTS), /classification count drift/, row.canonical);
      const contextDrifted = derived.map(entry => entry === row ? { ...entry, contextSha256: '0'.repeat(64) } : entry);
      assert.throws(() => assertDerivedIdentitySiteTotality(contextDrifted, ACTIVE_IDENTITY_OPERATION_BOUNDARIES, OWNED_NON_PROTOCOL_IDENTITY_CONTEXTS), /classification context drift/, row.canonical);
    }
  }
  const path = 'packages/main/src/core/candidate-spec-routing.ts';
  for (const producer of [
    "export const typedProducer: { schemaVersion: string } = { schemaVersion: 'proof-or-stop.synthetic-owned-producer.v1' };",
    "export function typedReader(value: string): boolean { return value === 'proof-or-stop.synthetic-owned-reader.v1'; }",
    "export const unversionedDomain: string = 'proof-or-stop-synthetic-domain';",
    "export const joinedSchema: string = ['proof-or-stop', '.synthetic-joined.v1'].join('');",
    "export const concatenatedSchema: string = 'proof-or-stop' + '.synthetic-concatenated.v1';",
    "const syntheticBrand: string = 'proof-or-stop'; export const templateSchema = `${syntheticBrand}.synthetic-template.v1`;",
  ]) {
    const mutant = new Map(sources);
    mutant.set(path, `${sources.get(path)}\n${producer}\n`);
    assert.throws(() => assertOwnedIdentitySiteTotality(mutant), /unclassified owned executable identity sites/, producer);
  }
  const empty = new Map(sources);
  empty.delete(path);
  assert.throws(() => assertOwnedIdentitySiteTotality(empty), /owned identity source missing/);
  const reusedRole = new Map(sources);
  const rolePath = 'packages/main/src/handlers/story-dispatch.ts';
  reusedRole.set(rolePath, `${sources.get(rolePath)}\nexport const extraRoleSchema = { schemaVersion: 'proof-or-stop-implementer' };\n`);
  assert.throws(() => assertOwnedIdentitySiteTotality(reusedRole), /owned identity use count changed/, 'an already registered role value must not authorize a new schema use');
  for (const usage of [
    'export const newlyAddedProducer = { schemaVersion: CANDIDATE_SET_SCHEMA };',
    'export function newlyAddedReader(value: string) { return value === CANDIDATE_SET_SCHEMA; }',
    'const alias = CANDIDATE_SET_SCHEMA; export const aliasProducer = { schemaVersion: alias };',
  ]) {
    const aliasMutation = new Map(sources);
    aliasMutation.set(path, `${sources.get(path)}\n${usage}\n`);
    assert.throws(() => assertOwnedIdentitySiteTotality(aliasMutation), /owned identity use count changed/, usage);
  }
  const moved = derived.map(row => row.sourcePath === rolePath && row.canonical === 'proof-or-stop-implementer' ? { ...row, contextSha256: '0'.repeat(64) } : row);
  assert.throws(() => assertDerivedIdentitySiteTotality(moved, ACTIVE_IDENTITY_OPERATION_BOUNDARIES, OWNED_NON_PROTOCOL_IDENTITY_CONTEXTS), /owned identity use context changed/, 'same value/count cannot move into a different active context');
  const estimatorSource = readFileSync(join(repoRoot, 'packages/main/src/core/usage-ledger/estimate.ts'), 'utf8');
  const assertIgnoredLabel = source => {
    const ast = ts.createSourceFile('estimate.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'bytesCharsEstimator');
    assert.equal(functions.length, 1, 'ignored estimator witness must resolve exactly one function');
    const fn = functions[0];
    assert.ok(fn.body && ts.isIdentifier(fn.parameters[0]?.name), 'ignored estimator witness requires a named first parameter and body');
    const references = [];
    const visit = node => {
      if (ts.isIdentifier(node) && [fn.parameters[0].name.text, 'arguments', 'eval', 'Function'].includes(node.text)) references.push(node.text);
      ts.forEachChild(node, visit);
    };
    visit(fn.body);
    assert.deepEqual(references, [], 'ignored estimator label became consumed');
  };
  assertIgnoredLabel(estimatorSource);
  assert.throws(() => assertIgnoredLabel(estimatorSource.replace('const text =', 'void _model; const text =')), /ignored estimator label became consumed/);
  const { bytesCharsEstimator } = await import(join(distRoot, 'core/usage-ledger/estimate.js'));
  assert.deepEqual(bytesCharsEstimator('proof-or-stop-observational-baseline', 'label-independent content'), bytesCharsEstimator('arbitrary-ignored-label', 'label-independent content'), 'the classified estimator argument must remain non-authoritative and absent from output');
});

await check(["identity-sites", "round24"], 'F-060 exact verifier mutation-data fragment never admits changed data or surrounding active code', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-b49df-fragment-control-'));
  fixtureRoots.push(root);
  mkdirSync(join(root, 'scripts'));
  const path = join(root, 'scripts', 'verify-proof-or-stop-identity-cutover.mjs');
  const canonical = readFileSync(join(repoRoot, 'scripts', 'verify-proof-or-stop-identity-cutover.mjs'), 'utf8');
  const checks = [
    () => assertCanonicalActiveIdentityRuntime({ command: 'artifact_release_list', projectRoot: root, runtimePackageRoot: packageRoot }),
    () => assertCanonicalActiveIdentityBoundary({ boundaryId: 'release-ledgers', projectRoot: root, runtimePackageRoot: packageRoot }),
  ];
  writeFileSync(path, canonical);
  for (const check of checks) assert.doesNotThrow(check, 'exact data fragment must not reject canonical reader code');
  for (const marker of ['const OWNED_IDENTITY_MUTATION_CONTEXT_ROWS = [', 'const BOTH_FAMILY_CONTEXT_ROWS = [']) {
    const start = canonical.indexOf(marker);
    const end = canonical.indexOf('\n].map(', start) + 2;
    assert.ok(start >= 0 && end > start);
    const fragment = canonical.slice(start, end);
    for (const [label, mutated] of [
      ['missing', canonical.replace(fragment, '')],
      ['duplicated', `${canonical}\n${fragment}`],
      ['altered', canonical.replace(fragment, `${fragment.slice(0, -1)} ]`)],
    ]) {
      writeFileSync(path, mutated);
      for (const check of checks) assert.throws(check, /identity|mutation-data/, `${marker}: ${label}`);
    }
  }
  writeFileSync(path, `${canonical}\nif (schema === '${retiredProtocolPrefix}product-capability-release.v1') return schema;`);
  for (const check of checks) assert.throws(check, /identity|mutation-data/, 'unchanged data fragments do not admit an outside active reader');
});

await check(["identity-sites", "round24"], 'F-060 historical counterparts bind actual source while constructed controls claim no historical admission', () => {
  const importedCommit = '69403365ae9a19422564babf93f6c10de869c81d';
  const historicalSources = new Map();
  const assertProvenance = site => {
    assert.ok(['historical-retired', 'unsupported-family-control'].includes(site.mutationKind));
    if (site.mutationKind === 'unsupported-family-control') {
      assert.equal(site.retiredProvenance, undefined, 'constructed control must not claim historical authority');
      return;
    }
    const proof = site.retiredProvenance;
    assert.equal(proof?.commit, importedCommit, 'historical counterpart source commit changed');
    assert.equal(proof?.sourcePath, site.identityOrigin?.sourcePath ?? site.sourcePath, 'historical counterpart source path changed');
    assert.equal(proof?.value, site.retired, 'historical counterpart value changed');
    assert.ok(['producer-or-domain', 'reader-or-type-alternative'].includes(proof.use));
    if (!historicalSources.has(proof.sourcePath)) {
      const text = git(repoRoot, ['show', `${importedCommit}:${proof.sourcePath}`]);
      const ast = ts.createSourceFile(proof.sourcePath, text, ts.ScriptTarget.Latest, true,
        proof.sourcePath.endsWith('.json') ? ts.ScriptKind.JSON : ts.ScriptKind.TS);
      const values = new Set();
      const visit = node => { if (ts.isStringLiteralLike(node)) values.add(node.text); ts.forEachChild(node, visit); };
      visit(ast); historicalSources.set(proof.sourcePath, values);
    }
    assert.ok(historicalSources.get(proof.sourcePath).has(proof.value), `historical counterpart not found as an actual source literal: ${site.siteId}`);
  };
  const sites = ACTIVE_IDENTITY_OPERATION_BOUNDARIES.flatMap(boundary => boundary.identitySites);
  sites.forEach(assertProvenance);
  const historical = sites.find(site => site.mutationKind === 'historical-retired');
  assert.ok(historical, 'historical source checks must not be vacuous');
  for (const change of [{ commit: '0'.repeat(40) }, { sourcePath: 'package.json' }, { value: 'unlisted-counterpart' }]) {
    assert.throws(() => assertProvenance({ ...historical, retiredProvenance: { ...historical.retiredProvenance, ...change } }), /historical counterpart/);
  }
});

await check(['round24'], 'F-060 every exported prompt identity has an independently declared site and public-operation case', () => {
  const path = 'packages/main/src/core/prompt-contracts.ts';
  const sites = ACTIVE_IDENTITY_OPERATION_BOUNDARIES.flatMap((boundary) => boundary.identitySites);
  const cases = ACTIVE_IDENTITY_OPERATION_BOUNDARIES.flatMap((boundary) => boundary.retiredIdentityCases);
  for (const canonical of Object.values(promptContracts.CURRENT_PROMPT_IDENTITIES)) {
    const owned = sites.filter((site) => site.sourcePath === path && site.canonical === canonical);
    assert.equal(owned.length, 1, `missing or duplicate exported prompt identity site: ${canonical}`);
    assert.equal(cases.filter((entry) => entry.siteId === owned[0].siteId).length, 1, `missing or duplicate operation case: ${canonical}`);
  }
});

await check(['round24'], 'F-062 ReviewRun mutation uses the historical salt actually retired by the cutover', () => {
  const site = ACTIVE_IDENTITY_OPERATION_BOUNDARIES.flatMap((boundary) => boundary.identitySites)
    .find((entry) => entry.canonical === 'proof-or-stop-review-run-integrity-v1');
  assert.equal(site?.retired, ['lat', 'tice-review-run-integrity-v1'].join(''));
  assert.equal(site?.retiredNeedle, site?.retired);
});

for (const path of [
  'packages/main/src/handlers/dev-memory.ts',
  'packages/main/src/handlers/quorum-prune.ts',
  'packages/main/src/core/usage-ledger/ids.ts',
  'packages/main/src/handlers/validate-docs-drift.ts',
  'experiments/experience-ablation/snapshot-builder.mjs',
]) {
  await check(['round24'], `F-061 active producer or diagnostic uses canonical product prose: ${path}`, () => {
    assert.equal(/proofbound/iu.test(readFileSync(join(repoRoot, path), 'utf8')), false, `${path}: active retired product prose remains`);
  });
}

await check(['round24'], 'F-061 freshly built memory snapshot emits only canonical product prose', async () => {
  const { buildSnapshotFiles } = await import(join(repoRoot, 'experiments/experience-ablation/snapshot-builder.mjs'));
  const files = buildSnapshotFiles();
  assert.ok(Object.keys(files).length > 0);
  for (const [path, bytes] of Object.entries(files)) {
    assert.equal(/proofbound/iu.test(bytes), false, `${path}: freshly generated retired product prose`);
  }
});

await check(['round23'], 'F-058 shared Story6 provenance consumer is in the exact active-runtime verifier inventory', () => {
  const verifierSource = readFileSync(join(repoRoot, 'scripts/verify-proof-or-stop-identity-cutover.mjs'), 'utf8');
  assert.match(
    verifierSource,
    /'experiments\/role-prompt-ab-replay\/lib\/story6-provenance\.mjs'/,
    'ACTIVE_IDENTITY_EXACT_RUNTIME_PATHS must include the shared Story6 provenance consumer',
  );
});

await check(['round23'], 'F-059 identity sites and public-operation mutation cases have independent declarations', () => {
  const registrySource = readFileSync(join(repoRoot, 'packages/main/src/core/runtime-environment-checks.ts'), 'utf8');
  assert.doesNotMatch(registrySource, /const identitySites = seed\.retiredIdentityCases/);
  for (const boundary of ACTIVE_IDENTITY_OPERATION_BOUNDARIES) {
    assert.notStrictEqual(boundary.identitySites, boundary.retiredIdentityCases, `${boundary.id}: sites and cases alias the same array`);
  }
});

await check(['round23'], 'F-059 every registered path has an explicit owned-site or identity-free classification', () => {
  const registrySource = readFileSync(join(repoRoot, 'packages/main/src/core/runtime-environment-checks.ts'), 'utf8');
  assert.doesNotMatch(registrySource, /identitySites\[0\]/, 'unmatched paths must not silently map to the first identity site');
  for (const boundary of ACTIVE_IDENTITY_OPERATION_BOUNDARIES) {
    assert.deepEqual(
      boundary.pathBindings.map((binding) => binding.sourcePath).sort(),
      boundary.paths.map((entry) => entry.sourcePath).sort(),
      `${boundary.id}: path classification must be total`,
    );
    for (const binding of boundary.pathBindings) {
      assert.ok(
        binding.classification === 'owned-site' || binding.classification === 'identity-free',
        `${boundary.id}/${binding.sourcePath}: missing explicit classification`,
      );
      assert.equal(Object.hasOwn(binding, 'sharedConsumerReason'), false, `${boundary.id}/${binding.sourcePath}: generic shared-consumer prose is forbidden`);
      if (binding.classification === 'owned-site') {
        assert.ok(binding.siteIds.length > 0, `${boundary.id}/${binding.sourcePath}: owned-site path has no sites`);
      } else {
        assert.ok(binding.evidence, `${boundary.id}/${binding.sourcePath}: identity-free classification lacks rationale`);
        const registeredPath = boundary.paths.find((entry) => entry.sourcePath === binding.sourcePath);
        const absolute = registeredPath.scope === 'runtime-package'
          ? join(packageRoot, registeredPath.path)
          : join(repoRoot, registeredPath.path);
        assert.doesNotMatch(
          readFileSync(absolute, 'utf8'),
          /proof-or-stop[.-]/,
          `${boundary.id}/${binding.sourcePath}: identity-free emitted bytes contain an active identity site`,
        );
      }
    }
  }
});

for (const [sourcePath, canonical] of [
  ['packages/main/src/core/review-incremental-context.ts', 'proof-or-stop.incremental-review-basis.v1'],
  ['packages/main/src/handlers/review-run.ts', 'proof-or-stop.prompt-envelope.v1'],
  ['packages/main/src/core/prompt-envelope.ts', 'proof-or-stop.prompt-envelope.v1'],
  ['packages/main/src/cli-init.ts', 'proof-or-stop.js'],
]) {
  await check(['round23'], `F-059 registered real identity site ${sourcePath}`, () => {
    const sites = ACTIVE_IDENTITY_OPERATION_BOUNDARIES.flatMap((boundary) => boundary.identitySites);
    const site = sites.find((candidate) => candidate.sourcePath === sourcePath && candidate.canonical === canonical);
    assert.ok(site, `${sourcePath}: missing exact identity site ${canonical}`);
    const cases = ACTIVE_IDENTITY_OPERATION_BOUNDARIES.flatMap((boundary) => boundary.retiredIdentityCases);
    assert.equal(cases.filter((candidate) => candidate.siteId === site.siteId).length, 1, `${site.siteId}: requires exactly one public-operation mutation case`);
  });
}

await check(['identity-cutover', 'identity-snapshot'], 'public fixture reads only required history while preserving mutation detection', () => {
  const result = spawnSync(process.execPath, [join(packageRoot, 'tests/public-fixture-read-scope.test.mjs')], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /PUBLIC_FIXTURE_HISTORY_READ_BUDGET_GREEN/);
});

await check(['identity-cutover', 'identity-snapshot'], 'Git material snapshot detects changes at exact special-character paths', () => {
  const result = spawnSync(process.execPath, [join(packageRoot, 'tests/identity-snapshot-paths.test.mjs')], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /IDENTITY_SNAPSHOT_PATH_GREEN/);
});

await check(['identity-cutover', 'identity-snapshot'], 'sparse public fixture retains complete indexed-path creation detection and outside material', () => {
  const { root } = ensurePublicIdentityOperationFixture();
  assert.ok(fixtureRoots.includes(root) && root !== repoRoot && root !== mainRoot);
  const index = git(root, ['ls-files', '--stage', '-z']);
  const paths = git(root, ['ls-files', '-z']).split('\0').filter(Boolean);
  const omitted = paths.find(path => path.startsWith(INERT_PUBLIC_FIXTURE_LOG_SUBTREE));
  assert.ok(omitted, 'the exact inert log subtree must have a tracked creation control');
  const absolute = join(root, omitted);
  assert.equal(lstatSync(absolute, { throwIfNoEntry: false }), undefined);
  const baseline = snapshotGitMaterial(root);
  assert.ok(baseline.split('\n').includes(`${omitted}\0deleted`), 'absent indexed log must remain in the material snapshot');
  const outside = snapshot => snapshot.split('\n').filter(row => !row.startsWith(INERT_PUBLIC_FIXTURE_LOG_SUBTREE)).join('\n');
  mkdirSync(dirname(absolute), { recursive: true });
  for (const kind of ['empty', 'nonempty', 'symlink']) {
    try {
      if (kind === 'symlink') symlinkSync('../../../proof-or-stop.config.json', absolute);
      else writeFileSync(absolute, kind === 'empty' ? '' : 'a newly created tracked log must remain observable\n');
      const changed = snapshotGitMaterial(root);
      assert.notEqual(changed, baseline, `${kind} creation at an omitted tracked path escaped the snapshot`);
      assert.equal(outside(changed), outside(baseline), `${kind} control changed nonexcluded material`);
      assert.equal(git(root, ['ls-files', '--stage', '-z']), index, `${kind} control changed the complete index`);
      assert.deepEqual(git(root, ['ls-files', '-z']).split('\0').filter(Boolean), paths, `${kind} control dropped an indexed path`);
    } finally {
      rmSync(absolute, { force: true });
    }
    assert.equal(snapshotGitMaterial(root), baseline, `${kind} restoration did not recover the complete baseline`);
  }
});

await check(['identity-cutover', 'identity-canonical', 'identity-config-boundary', 'identity-policy-boundary', 'f050', 'round24'], 'CHK-007 canonical controls: every distinct registered public operation succeeds before mutation', () => {
  const startedAt = Date.now();
  const fixture = ensurePublicIdentityOperationFixture();
  assertCanonicalPublicIdentityOperations(fixture, 'normal preflight');
  process.stdout.write(`PASS canonical fixture and operation elapsedMs=${Date.now() - startedAt}\n`);
});
}
