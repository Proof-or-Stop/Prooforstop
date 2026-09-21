import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';










import { verifyBothFamilyContexts, verifyReviewedNegativeSourceIntegrity, verifyImportedHistoryContexts, verifyIntegrationRootHistoryContext, verifySchemaInventory, verifyNegativeSchemaWitnesses, verifyScannerRetiredContexts } from "./source-integrity.mjs";
import { verifyImportedFinishDecisionBoundary, verifyMemoryLedger, verifyMemoryLedgerBytes, verifyExperimentProvenance, verifyConceptProvenance } from "./memory-provenance.mjs";
import { verifyCurrentWitnessCoverage } from "./witness-controls.mjs";
import { REVIEWED_NEGATIVE_SOURCE_INTEGRITY, INTEGRATION_ROOT_HISTORY_CONTEXT, OWNED_IDENTITY_MUTATION_CONTEXT_ROWS } from "./reviewed-contexts.mjs";
import { IMPORTED_HISTORY_CONTEXT_SOURCES, IMPORTED_HISTORY_CONTEXT_ROWS } from "./history-contexts.mjs";
import { schemaRows, isFrozenSurface } from "./schema-scan.mjs";
import { CURRENT_COMPATIBLE_SCHEMA_ROWS, NEGATIVE_SCHEMA_ROWS, NEGATIVE_SCHEMA_WITNESSES } from "./schema-data.mjs";
import { SELF_TEST_PASS_SUMMARY, TRUTH_SOURCE_ENTRYPOINTS, RETIRED_PROTOCOL_PREFIX, CURRENT_CONTRACT_PATHS, LEGACY_WORD, RETIRED_PRODUCT_NAME, SCRIPT_PATH, CURRENT_GUIDANCE_PATHS, CANONICAL_STORY_DIR, LEGACY_STORY_DIR, CANONICAL_ARTIFACT_RELEASE_SCHEMA, RETIRED_ARTIFACT_RELEASE_SCHEMA, RETIRED_CAPABILITY_RELEASE_SCHEMA, CANONICAL_CAPABILITY_RELEASE_SCHEMA, CURRENT_LEGACY_CONTEXT_MANIFEST_PATH, POLICY_PATH } from "./rules.mjs";
import { classifyToken, TOKEN_PATTERN, scanRegisteredActiveIdentityResidue, scanActiveResidue, exactAllowedRow } from "./active-scan.mjs";
import { readTrackedText, validateExactRows, sha256, git } from "./repository.mjs";
import { FROZEN_FILE_BASELINES, EXPERIMENT_PROVENANCE_ROWS, CONCEPT_PROVENANCE_ROWS, MEMORY_LEDGER_PATH, MEMORY_IMPORTED_PREFIX_BLOB, IMPORTED_RELEASE_PROVENANCE, APPEND_ONLY_LEDGER_SUFFIX_PROVENANCE, retiredToken } from "./provenance-data.mjs";
import { currentTruthSourcePaths, isRetiredActiveInstruction, verifyCurrentGuidance, verifyCurrentLegacyContextManifest } from "./guidance.mjs";
import { EXACT_ALLOWLIST, CURRENT_LEGACY_CONTEXT_ROWS } from "./base-contexts.mjs";
import { verifyFrozenFiles, verifyImportedReleaseProvenance, selfTestAppendRecord, verifyAppendOnlyJsonlPrefix } from "./release-history.mjs";
import { createOrderingSelfTestFixture, verifyOrdering } from "./ordering.mjs";

export function runSelfTest(root, files) {
  if (verifyBothFamilyContexts(root).length > 0) throw new Error('both-family exact contexts or witnesses are not current');
  const failures = [...verifyImportedFinishDecisionBoundary(root, files), ...verifyImportedFinishDecisionBoundary(root, files, '.proof-or-stop/dev-memory/finish-decisions/B-e256.json'), ...verifyImportedFinishDecisionBoundary(root, files, '.proof-or-stop/dev-memory/finish-decisions/B-29bc.json'), ...verifyImportedFinishDecisionBoundary(root, files, '.proof-or-stop/dev-memory/finish-decisions/B-42f6.json'), ...verifyImportedFinishDecisionBoundary(root, files, '.proof-or-stop/dev-memory/finish-decisions/B-5a52.json'), ...verifyImportedFinishDecisionBoundary(root, files, '.proof-or-stop/dev-memory/finish-decisions/B-adc3.json'), ...verifyImportedFinishDecisionBoundary(root, files, '.proof-or-stop/dev-memory/finish-decisions/B-88c7.json'), ...verifyImportedFinishDecisionBoundary(root, files, '.proof-or-stop/dev-memory/finish-decisions/B-0208.json')];
  const expect = (condition, message) => { if (!condition) failures.push(message); }; verifyCurrentWitnessCoverage(root, files, expect);
  expect(verifyReviewedNegativeSourceIntegrity(root).length === 0, 'reviewed negative source integrity failed');
  const customWitnessControls = new Map([
    ['packages/main/src/core/runtime-environment-checks.ts', 'if (exactOccurrenceDrift || countNeedle(site.sourceNeedle) === 0 || (!counts && countNeedle(site.retiredNeedle) > 0)) {'],
    ['scripts/verify-migration-contract.mjs', 'if (!doc) fail(`${DOC} missing`);'],
    ['scripts/verify-proof-or-stop-prompt-baseline.mjs', 'if (actual !== expected)'],
    ['scripts/verify-proof-or-stop-residue.mjs', 'if (actual !== expected)'],
  ]);
  for (const pin of REVIEWED_NEGATIVE_SOURCE_INTEGRITY) {
    const original = readFileSync(resolve(root, pin.path), 'utf8');
    const assertion = customWitnessControls.get(pin.path)
      ?? original.split(/\r?\n/u).find(line => /^\s*(?:assert(?:\.[A-Za-z]+)?|check|rejects)\(/u.test(line) && !/lattice|proofbound/iu.test(line));
    expect(Boolean(assertion) && original.includes(assertion), `reviewed witness has no separate control: ${pin.path}`);
    const changed = original.replace(assertion, assertion === 'if (actual !== expected)' ? 'if (false)' : '// removed independent control');
    expect(verifyReviewedNegativeSourceIntegrity(root, path => path === pin.path ? changed : readFileSync(resolve(root, path), 'utf8')).length > 0,
      `negative witness control removal escaped source integrity: ${pin.path}`);
  }
  expect(verifyImportedHistoryContexts(root).length === 0, 'exact imported historical contexts failed');
  expect(verifyImportedHistoryContexts(root, IMPORTED_HISTORY_CONTEXT_SOURCES.slice(1)).length > 0, 'missing historical context source accepted');
  expect(verifyIntegrationRootHistoryContext(root).length === 0, 'exact integration root history source rejected');
  expect(verifyIntegrationRootHistoryContext(root, INTEGRATION_ROOT_HISTORY_CONTEXT, () => { throw new Error('missing current quotation'); }).length > 0, 'missing current quotation accepted');
  for (const change of [{ path: 'package.json' }, { token: 'unlisted.config.json' }, { expectedOccurrences: 2 }, { contextSha256: '0'.repeat(64) }]) {
    expect(verifyIntegrationRootHistoryContext(root, { ...INTEGRATION_ROOT_HISTORY_CONTEXT, ...change }).length > 0, 'altered integration history context accepted');
  }
  expect(verifyImportedHistoryContexts(root, [...IMPORTED_HISTORY_CONTEXT_SOURCES, IMPORTED_HISTORY_CONTEXT_SOURCES[0]]).length > 0, 'duplicate historical context source accepted');
  for (const change of [{ gitBlobOid: '0'.repeat(40) }, { sha256: '0'.repeat(64) }, { path: 'README.md' }]) {
    expect(verifyImportedHistoryContexts(root, IMPORTED_HISTORY_CONTEXT_SOURCES.map((row, i) => i === 0 ? { ...row, ...change } : row)).length > 0,
      'changed historical context source accepted');
  }
  for (const change of [{ token: 'unlisted-token' }, { contextSha256: '0'.repeat(64) }, { expectedOccurrences: 999 }]) {
    expect(verifyImportedHistoryContexts(root, IMPORTED_HISTORY_CONTEXT_SOURCES, IMPORTED_HISTORY_CONTEXT_ROWS.map((row, i) => i === 0 ? { ...row, ...change } : row)).length > 0,
      'changed imported historical context accepted');
  }
  const exactSchemas = schemaRows(root, files);
  expect(verifySchemaInventory(root, exactSchemas).length === 0, 'reviewed schema inventory did not pass');
  for (const pin of [...CURRENT_COMPATIBLE_SCHEMA_ROWS, ...NEGATIVE_SCHEMA_ROWS, ...OWNED_IDENTITY_MUTATION_CONTEXT_ROWS.filter(row => /^lattice\..*\.v\d+$/u.test(row.token)).map(row => ({ ...row, count: row.expectedOccurrences }))]) {
    const otherRows = exactSchemas.filter(row => row.path !== pin.path || row.token !== pin.token);
    expect(verifySchemaInventory(root, otherRows).length > 0, `missing schema pin accepted: ${pin.token}`);
    expect(verifySchemaInventory(root, [...exactSchemas, pin]).length > 0, `duplicate schema pin accepted: ${pin.token}`);
    for (const mutation of [{ ...pin, count: pin.count + 1 }, { ...pin, contextSha256: '0'.repeat(64) }, { ...pin, path: 'packages/main/src/unlisted.ts' }, { ...pin, token: `${pin.token}-unlisted` }]) {
      expect(verifySchemaInventory(root, [...otherRows, mutation]).length > 0, `changed schema pin accepted: ${pin.token}`);
    }
  }
  for (const witness of NEGATIVE_SCHEMA_WITNESSES) {
    const original = readFileSync(resolve(root, witness.path), 'utf8');
    // Remove a rejection assertion line while retaining all schema literal lines.
    const assertionLine = witness.rejectionAssertion;
    expect(original.includes(assertionLine), `negative witness has no named rejection assertion: ${witness.path}`);
    const tampered = original.replace(assertionLine, '// removed rejection control');
    expect(verifyNegativeSchemaWitnesses(root, path => path === witness.path ? tampered : readFileSync(resolve(root, path), 'utf8')).length > 0,
      `removed assertion escaped schema witness integrity: ${witness.path}`);
  }
  expect(
    SELF_TEST_PASS_SUMMARY.includes('all fail closed'),
    'self-test PASS summary must retain the immutable acceptance selector `all fail closed`',
  );
  const injections = [
    ['package', 'package.json', '@lattice/lab', '"@lattice/lab": "1.0.0"'],
    ['bin', 'packages/main/package.json', 'lattice', '"lattice": "dist/cli.js"'],
    ['command', 'scripts/injected.mjs', 'lattice', 'run lattice help now'],
    ['agent_role', '.claude/agents/injected.md', 'lattice-review-story-init', 'lattice-review-story-init'],
    ['environment', 'packages/main/src/injected.ts', 'LATTICE_DEBUG', 'LATTICE_DEBUG'],
    ['path_config', 'packages/main/src/injected.ts', '.lattice', '".lattice"'],
    ['runtime', 'packages/main/src/injected.ts', 'latticeRuntime', 'const latticeRuntime = true'],
    ['prompt', 'packages/main/templates/agents/injected.md', 'Lattice', 'Lattice agent'],
    ['documentation', 'AGENTS.md', 'Lattice', 'Lattice product'],
  ];
  for (const [expected, path, token, line] of injections) {
    expect(classifyToken(path, token, line) === expected, `injected active residue was not classified as ${expected}`);
  }
  for (const canonicalIdentity of [
    'proof-or-stop-review-story-init',
    'proof-or-stop-review-quality',
    'proof-or-stop-review-topology-critic',
    'proof_or_stop_metadata_changes',
    'proof-or-stop-verifier-pass',
  ]) {
    expect(
      [...canonicalIdentity.matchAll(TOKEN_PATTERN)].length === 0,
      `canonical identity was misclassified as legacy residue: ${canonicalIdentity}`,
    );
  }
  const activeExperimentFixture = 'experiments/experience-ablation/f051-injected.mjs';
  const activeDocumentationFixture = 'docs/requirements/decisions/testing-infra.md';
  const activeExperimentRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-f051-identity-subtree-'));
  try {
    for (const entrypoint of TRUTH_SOURCE_ENTRYPOINTS) {
      mkdirSync(resolve(activeExperimentRoot, dirname(entrypoint)), { recursive: true });
      writeFileSync(resolve(activeExperimentRoot, entrypoint), '');
    }
    mkdirSync(resolve(activeExperimentRoot, dirname(activeExperimentFixture)), { recursive: true });
    writeFileSync(
      resolve(activeExperimentRoot, activeExperimentFixture),
      `export const schemaVersion = '${RETIRED_PROTOCOL_PREFIX}experience-ablation-injected.v1';\n`,
    );
    expect(
      scanRegisteredActiveIdentityResidue(activeExperimentRoot, [activeExperimentFixture])
        .some((hit) => hit.path === activeExperimentFixture && hit.class === 'runtime'),
      'active experience-ablation retired identity mutation was not detected',
    );
    writeFileSync(
      resolve(activeExperimentRoot, activeExperimentFixture),
      "export const schemaVersion = 'proof-or-stop.experience-ablation-injected.v1';\n",
    );
    expect(
      scanRegisteredActiveIdentityResidue(activeExperimentRoot, [activeExperimentFixture]).length === 0,
      'canonical experience-ablation identity was rejected',
    );
    for (const path of [
      activeExperimentFixture,
      'packages/main/src/handlers/dev-memory.ts',
      'packages/main/src/handlers/quorum-prune.ts',
      'packages/main/src/core/usage-ledger/ids.ts',
      'packages/main/src/handlers/validate-docs-drift.ts',
      'packages/unregistered/src/new-consumer.ts',
      '.claude/hooks/new-managed-hook.cjs',
      '.codex/new-assets.json',
      'docs/requirements/decisions/new-current-guidance.md',
    ]) {
      mkdirSync(resolve(activeExperimentRoot, dirname(path)), { recursive: true });
      for (const token of ['Proofbound', 'PROOFBOUND', 'proofbound', 'Lattice', 'LATTICE', 'lattice']) {
        writeFileSync(resolve(activeExperimentRoot, path), `export const message = '${token} current product';\n`);
        expect(scanRegisteredActiveIdentityResidue(activeExperimentRoot, [path]).length === 1,
          `active product prose escaped scanner: ${path}/${token}`);
      }
      writeFileSync(resolve(activeExperimentRoot, path), "export const message = 'Proof-or-Stop current product';\n");
      expect(scanRegisteredActiveIdentityResidue(activeExperimentRoot, [path]).length === 0,
        `canonical product prose was rejected: ${path}`);
    }
    mkdirSync(resolve(activeExperimentRoot, dirname(activeDocumentationFixture)), { recursive: true });
    writeFileSync(resolve(activeExperimentRoot, activeDocumentationFixture), 'The current boundary uses Proofbound handlers.\n');
    expect(
      scanRegisteredActiveIdentityResidue(activeExperimentRoot, [activeDocumentationFixture])
        .some((hit) => hit.path === activeDocumentationFixture && hit.class === 'documentation'),
      'active current-document retired product name mutation was not detected',
    );
    writeFileSync(resolve(activeExperimentRoot, activeDocumentationFixture), 'The current boundary uses Proof-or-Stop handlers.\n');
    expect(
      scanRegisteredActiveIdentityResidue(activeExperimentRoot, [activeDocumentationFixture]).length === 0,
      'canonical current-document product name was rejected',
    );
    for (const path of CURRENT_CONTRACT_PATHS) {
      const original = readTrackedText(root, path);
      mkdirSync(resolve(activeExperimentRoot, dirname(path)), { recursive: true });
      writeFileSync(resolve(activeExperimentRoot, path), original);
      expect(scanActiveResidue(activeExperimentRoot, [path]).length === 0,
        `canonical current contract and exact negative contexts rejected: ${path}`);
      for (const family of [LEGACY_WORD, RETIRED_PRODUCT_NAME]) {
        writeFileSync(resolve(activeExperimentRoot, path), `${original}\nRun ${family} validate now.\n`);
        expect(scanActiveResidue(activeExperimentRoot, [path]).some(hit => hit.path === path && hit.token === family),
          `active retired command hidden by current contract provenance: ${path}`);
      }
      writeFileSync(resolve(activeExperimentRoot, path), `${original}\nRun proof-or-stop validate now.\n`);
      expect(scanActiveResidue(activeExperimentRoot, [path]).length === 0,
        `canonical current contract command rejected: ${path}`);
    }
    const scannerPath = 'scripts/identity-cutover/repository.mjs';
    const scannerText = readTrackedText(root, scannerPath);
    expect(verifyScannerRetiredContexts(scannerText, scannerPath).length === 0, 'audited scanner negative contexts drifted');
    const knownLine = scannerText.split(/\r?\n/u).find(line => [...line.matchAll(TOKEN_PATTERN)].length > 0);
    expect(verifyScannerRetiredContexts(`${scannerText}\n${knownLine}\n`, scannerPath).length > 0, 'duplicated scanner metadata context escaped');
    expect(verifyScannerRetiredContexts(scannerText.replace(knownLine, ''), scannerPath).length > 0, 'removed scanner metadata context escaped');
    mkdirSync(resolve(activeExperimentRoot, dirname(scannerPath)), { recursive: true });
    const retiredTitle = RETIRED_PRODUCT_NAME[0].toUpperCase() + RETIRED_PRODUCT_NAME.slice(1);
    const movableLine = scannerText.split(/\r?\n/u).find(line => line.trim() === `'${retiredTitle}',`);
    expect(Boolean(movableLine), 'scanner transplant control must have an actual negative data line');
    const transplanted = scannerText.replace(`${movableLine}\n`, '') + `\nconsole.log(\n${movableLine}\n);\n`;
    expect(verifyScannerRetiredContexts(transplanted, scannerPath).length > 0, 'unchanged negative line transplanted into active output escaped');
    writeFileSync(resolve(activeExperimentRoot, scannerPath), transplanted);
    expect(scanActiveResidue(activeExperimentRoot, [scannerPath]).some(hit => hit.token === retiredTitle),
      'scanner active scan admitted a negative literal moved into console output');
    for (const family of [LEGACY_WORD, RETIRED_PRODUCT_NAME]) {
      for (const injected of [`${family} current product`, `${family}.injected-live-schema.v1`]) {
        const mutated = `${scannerText}\nexport const injectedIdentity = '${injected}';\n`;
        expect(verifyScannerRetiredContexts(mutated, scannerPath).length > 0, 'unclassified scanner executable identity escaped integrity');
        writeFileSync(resolve(activeExperimentRoot, scannerPath), mutated);
        expect(scanActiveResidue(activeExperimentRoot, [scannerPath]).some(hit => hit.token.includes(family)),
          'scanner own-file executable/prose mutation escaped active scan');
      }
    }
    writeFileSync(resolve(activeExperimentRoot, scannerPath), `${scannerText}\nexport const canonicalControl = 'Proof-or-Stop current product';\n`);
    expect(scanActiveResidue(activeExperimentRoot, [scannerPath]).length === 0, 'canonical scanner own-file control rejected');
  } finally {
    rmSync(activeExperimentRoot, { recursive: true, force: true });
  }
  for (const path of [
    'docs/requirements/decisions/injected-current.md',
    'packages/main/tests/fixtures/injected-current.json',
    '.proof-or-stop/dev-memory/injected-current.jsonl',
  ]) {
    expect(!isFrozenSurface(path), `broad directory exemption survived for ${path}`);
  }
  expect(isFrozenSurface(FROZEN_FILE_BASELINES[0].path), 'exact frozen-file baseline was not exempted');
  expect(isFrozenSurface(EXPERIMENT_PROVENANCE_ROWS[0].path), 'exact provenance-manifest file was not exempted');
  expect(isFrozenSurface(CONCEPT_PROVENANCE_ROWS[0].path), 'exact concept-provenance file was not exempted');
  const currentTruthSources = currentTruthSourcePaths(root);
  expect(currentTruthSources.has('docs/requirements/decisions/story-lifecycle.md'), 'mechanical current-truth-source extraction missed story-lifecycle.md');
  for (const path of CURRENT_CONTRACT_PATHS) {
    expect(currentTruthSources.has(path), `current contract classification missing: ${path}`);
    expect(!isFrozenSurface(path), `current contract was frozen: ${path}`);
  }
  expect(
    isRetiredActiveInstruction('docs/requirements/decisions/story-lifecycle.md', 'lattice', 'Run lattice validate now.', currentTruthSources),
    'retired active instruction in a current truth source was not classified as active residue',
  );
  expect(
    !isRetiredActiveInstruction('docs/requirements/decisions/story-lifecycle.md', 'lattice', 'The retired legacy command `lattice validate` is rejected.', currentTruthSources),
    'explicit historical legacy context was misclassified as an active instruction',
  );
  expect(
    isRetiredActiveInstruction('docs/requirements/decisions/root-document-migration-guide.md', 'lattice', 'Run lattice validate now.', currentTruthSources),
    'active retired instruction inside a migration-context document was not classified as active',
  );

  const guidance = new Map(CURRENT_GUIDANCE_PATHS.map((path) => [path, readFileSync(resolve(root, path), 'utf8')]));
  const guidanceRead = (path) => guidance.get(path);
  expect(verifyCurrentGuidance(root, guidanceRead).length === 0, 'current guidance baseline is not canonical');
  const oldAgents = new Map(guidance);
  oldAgents.set('AGENTS.md', guidance.get('AGENTS.md').replace(CANONICAL_STORY_DIR, LEGACY_STORY_DIR));
  expect(
    verifyCurrentGuidance(root, (path) => oldAgents.get(path)).some((error) => error.includes('canonical storyDir') || error.includes('active legacy StoryStore path')),
    'legacy AGENTS.md storyDir mutation did not fail closed',
  );
  const oldClaudePath = new Map(guidance);
  oldClaudePath.set('CLAUDE.md', `${guidance.get('CLAUDE.md')}\nStore the current plan at ${LEGACY_STORY_DIR}/B-test/plan.md.\n`);
  expect(
    verifyCurrentGuidance(root, (path) => oldClaudePath.get(path)).some((error) => error.includes('active legacy StoryStore path')),
    'active CLAUDE.md legacy StoryStore path mutation did not fail closed',
  );
  const directClaudeWrite = new Map(guidance);
  directClaudeWrite.set('CLAUDE.md', `${guidance.get('CLAUDE.md')}\n主 agent 直接写文件（当前无 CLI 命令）。\n`);
  expect(
    verifyCurrentGuidance(root, (path) => directClaudeWrite.get(path)).some((error) => error.includes('direct-write/no-CLI')),
    'CLAUDE.md direct-write/no-CLI mutation did not fail closed',
  );
  const compatibilityLine = guidance.get('CLAUDE.md').split(/\r?\n/u).find((line) => line.includes('兼容读取旧版'));
  expect(Boolean(compatibilityLine), 'current guidance self-test requires the exact legacy heartbeat compatibility line');
  if (compatibilityLine) {
    const compatibilityComposition = new Map(guidance);
    compatibilityComposition.set(
      'CLAUDE.md',
      guidance.get('CLAUDE.md').replace(
        compatibilityLine,
        `${compatibilityLine} Run cat on ${LEGACY_STORY_DIR}/B-live/plan.md and edit it directly.`,
      ),
    );
    expect(
      verifyCurrentGuidance(root, (path) => compatibilityComposition.get(path)).some((error) => error.includes('active legacy StoryStore path')),
      'legacy heartbeat compatibility label plus appended direct StoryStore instruction did not fail closed',
    );
  }
  expect(
    verifyCurrentGuidance(root, guidanceRead).length === 0,
    'current guidance clean control did not restore to PASS after composition mutations',
  );

  const tracked = new Set(files);
  const first = EXACT_ALLOWLIST[0];
  const source = readFileSync(resolve(root, first.path), 'utf8');
  const virtualRead = (path) => (path === first.path ? source : readFileSync(resolve(root, path), 'utf8'));
  const stale = EXACT_ALLOWLIST.map((row) => row === first ? { ...row, expectedOccurrences: row.expectedOccurrences + 1 } : row);
  expect(validateExactRows(stale, tracked, root, virtualRead).some((error) => error.includes('occurrence count')), 'stale allowlist count mutation did not fail');
  const broadened = EXACT_ALLOWLIST.map((row) => row === first ? { ...row, token: LEGACY_WORD } : row);
  expect(validateExactRows(broadened, tracked, root, virtualRead).some((error) => error.includes('forbidden broad')), 'broadened allowlist token did not fail');
  const semanticFirst = CURRENT_LEGACY_CONTEXT_ROWS[0];
  const broadenedSemantic = EXACT_ALLOWLIST.map((row) => row === semanticFirst ? { ...row, token: LEGACY_WORD } : row);
  expect(
    validateExactRows(broadenedSemantic, tracked, root, virtualRead).some((error) => error.includes('forbidden broad')),
    'broad semantic-context token mutation did not fail',
  );
  const changedToken = EXACT_ALLOWLIST.map((row) => row === first ? { ...row, token: `${row.token}-changed` } : row);
  expect(validateExactRows(changedToken, tracked, root, virtualRead).some((error) => error.includes('occurrence count')), 'changed exact allowlist token did not fail');
  const changedPath = EXACT_ALLOWLIST.map((row) => row === first ? { ...row, path: 'package.json' } : row);
  expect(validateExactRows(changedPath, tracked, root, virtualRead).some((error) => error.includes('occurrence count')), 'changed exact allowlist path did not fail');
  const changedContext = EXACT_ALLOWLIST.map((row) => row === first ? { ...row, contextSha256: '0'.repeat(64) } : row);
  expect(validateExactRows(changedContext, tracked, root, virtualRead).some((error) => error.includes('bounded context digest changed')), 'changed exact allowlist context digest did not fail');
  const missingRow = EXACT_ALLOWLIST.slice(1);
  expect(validateExactRows(missingRow, tracked, root, virtualRead).some((error) => error.includes('row count') || error.includes('missing signature allowlist')), 'missing allowlist row did not fail');
  const missingOccurrenceText = source.replace(first.token, `proof-or-stop-review-integrity-v1`);
  const missingRead = (path) => (path === first.path ? missingOccurrenceText : readFileSync(resolve(root, path), 'utf8'));
  expect(validateExactRows(EXACT_ALLOWLIST, tracked, root, missingRead).some((error) => error.includes('occurrence count')), 'missing frozen occurrence did not fail');
  const migrationRow = CURRENT_LEGACY_CONTEXT_ROWS.find((row) => row.class === 'migration_input' && row.token.includes(LEGACY_WORD));
  expect(Boolean(migrationRow), 'self-test requires an exact migration-input context for the retired command token');
  if (migrationRow) {
    const migrationSource = readFileSync(resolve(root, migrationRow.path), 'utf8');
    const migrationLine = migrationSource.split(/\r?\n/u).find((line) => line.includes(migrationRow.token)) || '';
    expect(
      exactAllowedRow(migrationRow.path, LEGACY_WORD, migrationLine) === migrationRow,
      'exact migration context did not cover its bounded retired token',
    );
    expect(
      !exactAllowedRow(migrationRow.path, LEGACY_WORD, `Run ${LEGACY_WORD} validate now.`),
      'active retired instruction reused an unrelated exact migration context',
    );
  }
  const frozen = FROZEN_FILE_BASELINES[0];
  const mutatedBytes = Buffer.concat([readFileSync(resolve(root, frozen.path)), Buffer.from('\nmutation')]);
  expect(sha256(mutatedBytes) !== frozen.byteSha256, 'frozen-byte mutation did not change digest');
  const changedFrozenPath = FROZEN_FILE_BASELINES.map((row) => row === frozen ? { ...row, path: 'missing-frozen-file' } : row);
  expect(verifyFrozenFiles(root, tracked, changedFrozenPath).some((error) => error.includes('missing tracked path')), 'changed frozen path did not fail');
  const changedFrozenDigest = FROZEN_FILE_BASELINES.map((row) => row === frozen ? { ...row, gitBlobOid: '0'.repeat(40) } : row);
  expect(verifyFrozenFiles(root, tracked, changedFrozenDigest).some((error) => error.includes('byte mutation')), 'changed frozen digest did not fail');
  const missingFrozenRow = FROZEN_FILE_BASELINES.slice(1);
  expect(verifyFrozenFiles(root, tracked, missingFrozenRow).some((error) => error.includes('row count')), 'missing frozen baseline row did not fail');
  const appendOnlyRows = FROZEN_FILE_BASELINES.filter((row) => row.appendOnlyJsonlSchemaVersion);
  const memoryRow = CONCEPT_PROVENANCE_ROWS.find((row) => row.path === MEMORY_LEDGER_PATH);
  const originalMemory = git(['cat-file', 'blob', memoryRow.gitBlobOid], { cwd: root, encoding: null });
  const importedMemory = git(['cat-file', 'blob', MEMORY_IMPORTED_PREFIX_BLOB], { cwd: root, encoding: null });
  const validMemory = { id: 'memory-test-id', createdAt: '2026-09-05T00:00:00.000Z', sourceAgent: 'proof-or-stop-implementer', category: 'pattern', scope: 'project',
    summary: 'Canonical memory append', trigger: 'A focused test', lesson: 'Use proof-or-stop for current project instructions.', reusePrompt: 'Read the current example.', authority: 'non_authoritative', gateEvidence: false };
  const memoryAppend = (record) => Buffer.concat([importedMemory, Buffer.from(`${JSON.stringify(record)}\n`)]);
  expect(verifyMemoryLedger(root, memoryRow).length === 0, 'exact preserved memory history failed');
  expect(verifyMemoryLedgerBytes(memoryRow, originalMemory, importedMemory, memoryAppend(validMemory)).length === 0, 'canonical memory append was refused');
  expect(verifyMemoryLedgerBytes(memoryRow, originalMemory, importedMemory, originalMemory).length > 0, 'missing imported memory suffix was accepted');
  for (const offset of [0, originalMemory.length]) {
    const changed = Buffer.from(importedMemory); changed[offset] ^= 1;
    expect(verifyMemoryLedgerBytes(memoryRow, originalMemory, importedMemory, changed).length > 0, 'changed historical memory bytes were accepted');
  }
  for (const changed of [
    { ...validMemory, lesson: `Run ${LEGACY_WORD} validate.` },
    { ...validMemory, [RETIRED_PRODUCT_NAME]: true },
    { ...validMemory, notes: { injected: `${RETIRED_PRODUCT_NAME}.current` } },
    { ...validMemory, authority: 'authoritative' },
    { ...validMemory, gateEvidence: true },
    { ...validMemory, category: 'unknown' },
    { ...validMemory, lesson: '' },
    { ...validMemory, id: JSON.parse(importedMemory.toString('utf8').split('\n')[0]).id },
  ]) expect(verifyMemoryLedgerBytes(memoryRow, originalMemory, importedMemory, memoryAppend(changed)).length > 0, 'invalid or retired memory append was accepted');
  const escapedMemory = JSON.stringify({ ...validMemory, lesson: `Run ${LEGACY_WORD} validate.` }).replace(LEGACY_WORD, `\\u006c${LEGACY_WORD.slice(1)}`);
  expect(verifyMemoryLedgerBytes(memoryRow, originalMemory, importedMemory, Buffer.concat([importedMemory, Buffer.from(`${escapedMemory}\n`)])).some((error) => error.includes('retired identity')), 'escaped retired memory append was accepted');
  expect(verifyMemoryLedgerBytes(memoryRow, originalMemory, importedMemory, memoryAppend(validMemory).subarray(0, -1)).some((error) => error.includes('truncated')), 'truncated memory append was accepted');
  expect(appendOnlyRows.length === 2, 'both append-only frozen prefix rows are required');
  expect(verifyImportedReleaseProvenance(root).length === 0, 'exact imported release source bindings failed');
  for (const [label, mutate] of [
    ['missing pin', (pins) => pins.slice(1)],
    ['duplicate pin', (pins) => [...pins.slice(0, -1), pins[0]]],
    ['wrong path', (pins) => pins.map((pin, index) => index ? pin : { ...pin, path: 'package.json' })],
    ['wrong id', (pins) => pins.map((pin, index) => index ? pin : { ...pin, recordId: 'AR-000000000000000000000000' })],
    ['wrong source', (pins) => pins.map((pin, index) => index ? pin : { ...pin, sourceCommit: '0'.repeat(40) })],
    ['wrong embedded commit', (pins) => pins.map((pin, index) => index ? pin : { ...pin, mainCommit: '0'.repeat(40) })],
    ['wrong record digest', (pins) => pins.map((pin, index) => index ? pin : { ...pin, recordSha256: '0'.repeat(64) })],
    ['wrong token count', (pins) => pins.map((pin, index) => index ? pin : { ...pin, retiredTokens: pin.retiredTokens.map((token) => ({ ...token, expectedOccurrences: token.expectedOccurrences + 1 })) })],
    ['wrong token', (pins) => pins.map((pin, index) => index ? pin : { ...pin, retiredTokens: pin.retiredTokens.map((token) => ({ ...token, token: `${token.token}-changed` })) })],
  ]) {
    expect(verifyImportedReleaseProvenance(root, mutate(IMPORTED_RELEASE_PROVENANCE)).length > 0, `imported release provenance accepted ${label}`);
  }
  for (const appendOnlyRow of appendOnlyRows) {
    const appendOnlyPrefix = git(['cat-file', 'blob', appendOnlyRow.gitBlobOid], { cwd: root, encoding: null });
    const syntheticRow = { ...appendOnlyRow, path: `${appendOnlyRow.path}.synthetic-self-test` };
    const validRecord = selfTestAppendRecord(appendOnlyRow.appendOnlyJsonlSchemaVersion);
    const validAppend = Buffer.from(`${JSON.stringify(validRecord)}\n`);
    expect(verifyAppendOnlyJsonlPrefix(syntheticRow, appendOnlyPrefix, Buffer.concat([appendOnlyPrefix, validAppend])).length === 0, `valid complete ${appendOnlyRow.appendOnlyJsonlSchemaVersion} append did not preserve the frozen prefix`);
    const missingRequired = { ...validRecord };
    delete missingRequired.mainCommit;
    const missingRequiredAppend = Buffer.from(`${JSON.stringify(missingRequired)}\n`);
    expect(verifyAppendOnlyJsonlPrefix(syntheticRow, appendOnlyPrefix, Buffer.concat([appendOnlyPrefix, missingRequiredAppend])).some((error) => error.includes('mainCommit must be a non-empty string')), `append-only ${appendOnlyRow.appendOnlyJsonlSchemaVersion} row accepted a missing required field`);
    const requiredPathField = appendOnlyRow.appendOnlyJsonlSchemaVersion === CANONICAL_ARTIFACT_RELEASE_SCHEMA ? 'paths' : 'changedPaths';
    const emptyRequiredPaths = { ...validRecord, [requiredPathField]: [] };
    if (requiredPathField === 'paths') emptyRequiredPaths.changedPathCount = 0;
    const emptyRequiredPathsAppend = Buffer.from(`${JSON.stringify(emptyRequiredPaths)}\n`);
    expect(verifyAppendOnlyJsonlPrefix(syntheticRow, appendOnlyPrefix, Buffer.concat([appendOnlyPrefix, emptyRequiredPathsAppend])).some((error) => error.includes('must be a non-empty array')), `append-only ${appendOnlyRow.appendOnlyJsonlSchemaVersion} row accepted an empty required path array`);
    const retiredPayload = { ...validRecord, notes: [...validRecord.notes, 'new .lattice/injected identity'] };
    const retiredAppend = Buffer.from(`${JSON.stringify(retiredPayload)}\n`);
    expect(verifyAppendOnlyJsonlPrefix(syntheticRow, appendOnlyPrefix, Buffer.concat([appendOnlyPrefix, retiredAppend])).some((error) => error.includes('unclassified retired identity tokens')), `append-only ${appendOnlyRow.appendOnlyJsonlSchemaVersion} row accepted a new retired-token payload`);
    const escapedRetiredLine = JSON.stringify(retiredPayload).replace('.lattice', '.\\u006cattice');
    const escapedRetiredAppend = Buffer.from(`${escapedRetiredLine}\n`);
    expect(verifyAppendOnlyJsonlPrefix(syntheticRow, appendOnlyPrefix, Buffer.concat([appendOnlyPrefix, escapedRetiredAppend])).some((error) => error.includes('unclassified retired identity tokens')), `append-only ${appendOnlyRow.appendOnlyJsonlSchemaVersion} row accepted a Unicode-escaped retired-token payload`);
    const retiredKeyPayload = { ...validRecord, '.lattice/injected identity': true };
    const escapedRetiredKeyLine = JSON.stringify(retiredKeyPayload).replace('".lattice/injected identity"', '".\\u006cattice/injected identity"');
    const escapedRetiredKeyAppend = Buffer.from(`${escapedRetiredKeyLine}\n`);
    expect(verifyAppendOnlyJsonlPrefix(syntheticRow, appendOnlyPrefix, Buffer.concat([appendOnlyPrefix, escapedRetiredKeyAppend])).some((error) => error.includes('unclassified retired identity tokens')), `append-only ${appendOnlyRow.appendOnlyJsonlSchemaVersion} row accepted a Unicode-escaped retired-token object key`);
    const wrongSchemaAppend = Buffer.from(`${JSON.stringify({ ...validRecord, schemaVersion: 'wrong.schema.v1' })}\n`);
    expect(verifyAppendOnlyJsonlPrefix(syntheticRow, appendOnlyPrefix, Buffer.concat([appendOnlyPrefix, wrongSchemaAppend])).some((error) => error.includes('schemaVersion')), `append-only ${appendOnlyRow.appendOnlyJsonlSchemaVersion} row accepted another schema`);
    const retiredSchema = appendOnlyRow.appendOnlyJsonlSchemaVersion === CANONICAL_ARTIFACT_RELEASE_SCHEMA
      ? RETIRED_ARTIFACT_RELEASE_SCHEMA
      : RETIRED_CAPABILITY_RELEASE_SCHEMA;
    const retiredSchemaAppend = Buffer.from(`${JSON.stringify({ ...validRecord, schemaVersion: retiredSchema })}\n`);
    expect(
      verifyAppendOnlyJsonlPrefix(syntheticRow, appendOnlyPrefix, Buffer.concat([appendOnlyPrefix, retiredSchemaAppend])).some((error) => error.includes('schemaVersion')),
      `append-only ${appendOnlyRow.appendOnlyJsonlSchemaVersion} row accepted a new retired-schema suffix`,
    );
    if (appendOnlyRow.appendOnlyJsonlSchemaVersion === CANONICAL_CAPABILITY_RELEASE_SCHEMA) {
      for (const [label, record] of [
        ['missing scope marker', { ...validRecord, changedPathsScope: undefined }],
        ['wrong scope marker', { ...validRecord, changedPathsScope: 'full-diff' }],
        ['unrelated path', { ...validRecord, changedPaths: ['packages/main/src/cli.ts'] }],
        ['changed material path', { ...validRecord, changedPaths: ['docs/changed.md'] }],
      ]) {
        const bytes = Buffer.concat([appendOnlyPrefix, Buffer.from(`${JSON.stringify(record)}\n`)]);
        expect(verifyAppendOnlyJsonlPrefix(syntheticRow, appendOnlyPrefix, bytes).length > 0, `canonical capability suffix accepted ${label}`);
      }
    }
    expect(verifyAppendOnlyJsonlPrefix(syntheticRow, appendOnlyPrefix, Buffer.concat([appendOnlyPrefix, validAppend.subarray(0, validAppend.length - 1)])).some((error) => error.includes('truncated')), `append-only ${appendOnlyRow.appendOnlyJsonlSchemaVersion} row accepted a truncated appended record`);
  }
  for (const appendOnlyRow of appendOnlyRows) {
    const appendOnlyPrefix = git(['cat-file', 'blob', appendOnlyRow.gitBlobOid], { cwd: root, encoding: null });
    const currentBytes = readFileSync(resolve(root, appendOnlyRow.path));
    expect(verifyAppendOnlyJsonlPrefix(appendOnlyRow, appendOnlyPrefix, currentBytes).length === 0, `exact historical release ledger ${appendOnlyRow.path} failed`);
    expect(verifyAppendOnlyJsonlPrefix(appendOnlyRow, appendOnlyPrefix, appendOnlyPrefix).some((error) => error.includes('is missing')), 'removing the complete historical suffix was accepted');
    for (const pin of APPEND_ONLY_LEDGER_SUFFIX_PROVENANCE.filter((candidate) => candidate.path === appendOnlyRow.path)) {
      const pinnedLine = currentBytes.toString('utf8').split('\n').find((line) => {
        if (!line) return false;
        try { return JSON.parse(line).id === pin.recordId; } catch { return false; }
      });
      expect(Boolean(pinnedLine), `self-test requires current pinned suffix record ${pin.recordId}`);
      if (!pinnedLine) continue;
      const duplicated = Buffer.concat([currentBytes, Buffer.from(`${pinnedLine}\n`)]);
      expect(
        verifyAppendOnlyJsonlPrefix(appendOnlyRow, appendOnlyPrefix, duplicated)
          .some((error) => error.includes(`pinned suffix provenance record ${pin.recordId} appears 2 times, expected exactly once`)),
        `append-only ${appendOnlyRow.appendOnlyJsonlSchemaVersion} accepted a byte-identical duplicate of pinned suffix record ${pin.recordId}`,
      );
      if (!pin.sourceCommit) continue;
      const replaceLine = (line) => Buffer.from(currentBytes.toString('utf8').replace(`${pinnedLine}\n`, line === null ? '' : `${line}\n`));
      expect(verifyAppendOnlyJsonlPrefix(appendOnlyRow, appendOnlyPrefix, replaceLine(null)).some((error) => error.includes(`record ${pin.recordId} is missing`)), `missing imported record ${pin.recordId} was accepted`);
      const record = JSON.parse(pinnedLine);
      for (const [label, changed] of [
        ['bytes', { ...record, notes: [...record.notes, 'altered historical note'] }],
        ['embedded commit', { ...record, mainCommit: '0'.repeat(40) }],
        ['unlisted id', { ...record, id: `${record.id.slice(0, -1)}${record.id.endsWith('0') ? '1' : '0'}` }],
        ['new token', { ...record, notes: [...record.notes, retiredToken('.lat', 'tice/unlisted')] }],
        ['schema', { ...record, schemaVersion: appendOnlyRow.appendOnlyJsonlSchemaVersion }],
      ]) {
        expect(verifyAppendOnlyJsonlPrefix(appendOnlyRow, appendOnlyPrefix, replaceLine(JSON.stringify(changed))).length > 0, `imported record ${pin.recordId} accepted altered ${label}`);
      }
      const escapedLine = pinnedLine.replace(RETIRED_PRODUCT_NAME, `\\u0070${RETIRED_PRODUCT_NAME.slice(1)}`);
      expect(verifyAppendOnlyJsonlPrefix(appendOnlyRow, appendOnlyPrefix, replaceLine(escapedLine)).some((error) => error.includes('digest changed')), `imported record ${pin.recordId} accepted escaped byte mutation`);
    }
  }
  const firstAppendOnlyRow = appendOnlyRows[0];
  const firstAppendOnlyPrefix = git(['cat-file', 'blob', firstAppendOnlyRow.gitBlobOid], { cwd: root, encoding: null });
  const mutatedPrefix = Buffer.from(firstAppendOnlyPrefix);
  mutatedPrefix[0] ^= 1;
  const firstValidAppend = Buffer.from(`${JSON.stringify(selfTestAppendRecord(firstAppendOnlyRow.appendOnlyJsonlSchemaVersion))}\n`);
  expect(verifyAppendOnlyJsonlPrefix({ ...firstAppendOnlyRow, path: `${firstAppendOnlyRow.path}.synthetic-self-test` }, firstAppendOnlyPrefix, Buffer.concat([mutatedPrefix, firstValidAppend])).some((error) => error.includes('immutable JSONL prefix changed')), 'append-only row accepted a frozen-prefix mutation');
  const mixedCaseIdentity = ['La', 'Tt', 'Ic', 'E'].join('');
  expect(
    [...`run ${mixedCaseIdentity} validate now`.matchAll(TOKEN_PATTERN)].length > 0,
    'mixed-case retired command mutation was not detected',
  );
  expect(
    [...`.${mixedCaseIdentity}/story/actives/B-mixed/index.json`.matchAll(TOKEN_PATTERN)].length > 0,
    'mixed-case retired path mutation was not detected',
  );
  const experimentMutation = EXPERIMENT_PROVENANCE_ROWS.map((row, index) => index === 0
    ? { ...row, byteSha256: '0'.repeat(64) }
    : row);
  expect(
    verifyExperimentProvenance(root, files, experimentMutation).some((error) => error.includes('byte sha256 changed')),
    'experiment provenance byte mutation did not fail',
  );
  const conceptMutation = CONCEPT_PROVENANCE_ROWS.map((row, index) => index === 0
    ? { ...row, byteSha256: '0'.repeat(64) }
    : row);
  expect(
    verifyConceptProvenance(root, tracked, conceptMutation).some((error) => error.includes('byte sha256 changed')),
    'concept provenance byte mutation did not fail',
  );
  const broadConceptRow = CONCEPT_PROVENANCE_ROWS.map((row, index) => index === 0
    ? { ...row, path: 'docs/requirements/decisions/' }
    : row);
  expect(
    verifyConceptProvenance(root, tracked, broadConceptRow).some((error) => error.includes('one exact eligible file')),
    'concept provenance broad-directory mutation did not fail',
  );
  const currentTruthSourceRow = CONCEPT_PROVENANCE_ROWS.map((row, index) => index === 0
    ? { ...row, path: 'docs/requirements/decisions/story-lifecycle.md' }
    : row);
  expect(
    verifyConceptProvenance(root, tracked, currentTruthSourceRow).some((error) => error.includes('current truth source cannot be frozen')),
    'current truth source inserted into concept provenance did not fail',
  );
  for (const path of CURRENT_CONTRACT_PATHS) {
    const bytes = readFileSync(resolve(root, path));
    const exactCurrentRow = {
      class: 'provenance_bytes', path,
      gitBlobOid: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
      byteSha256: sha256(bytes),
    };
    // Preserve the required count and supply correct current digests: refusal
    // must come from current authority, not a stale hash or malformed row.
    const refrozen = CONCEPT_PROVENANCE_ROWS.map((row, index) => index === 0 ? exactCurrentRow : row);
    const refrozenErrors = verifyConceptProvenance(root, tracked, refrozen);
    expect(refrozenErrors.some(error => error.includes(`${path}: current truth source cannot be frozen`)),
      `current contract reinsertion escaped: ${path}`);
    expect(!refrozenErrors.some(error => error.includes(path) && /digest changed|sha256 changed/.test(error)),
      `current contract reinsertion control used stale digests: ${path}`);
  }
  const contextManifestBytes = readFileSync(resolve(root, CURRENT_LEGACY_CONTEXT_MANIFEST_PATH));
  expect(
    verifyCurrentLegacyContextManifest(root, Buffer.concat([contextManifestBytes, Buffer.from('\n')]))
      .some((error) => error.includes('manifest byte digest changed')),
    'current legacy context manifest byte mutation did not fail',
  );

  const orderingFixtures = [];
  try {
    const positiveOrdering = createOrderingSelfTestFixture();
    orderingFixtures.push(positiveOrdering.root);
    const orderingOptions = {
      storyInitCommit: positiveOrdering.storyInitCommit,
      policyCommit: positiveOrdering.policyCommit,
      policyPath: POLICY_PATH,
      scriptPath: SCRIPT_PATH,
    };
    expect(verifyOrdering(positiveOrdering.root, orderingOptions).length === 0, 'valid decision-before-RED ordering fixture did not pass');
    expect(
      verifyOrdering(positiveOrdering.root, { ...orderingOptions, policyCommit: positiveOrdering.unrelatedPolicyCommit })
        .some((error) => error.includes('not an ancestor') || error.includes('does not descend')),
      'non-ancestor rewritten policy pin did not fail ordering verification',
    );
    expect(
      verifyOrdering(positiveOrdering.root, { ...orderingOptions, policyCommit: '0'.repeat(40) })
        .some((error) => error.includes('cannot be inspected')),
      'unknown rewritten policy SHA did not fail ordering verification',
    );
    const wrongPolicyPath = createOrderingSelfTestFixture(false, false, 'wrong');
    orderingFixtures.push(wrongPolicyPath.root);
    expect(
      verifyOrdering(wrongPolicyPath.root, {
        storyInitCommit: wrongPolicyPath.storyInitCommit,
        policyCommit: wrongPolicyPath.policyCommit,
        policyPath: POLICY_PATH,
        scriptPath: SCRIPT_PATH,
      }).some((error) => error.includes(`policy commit must contain only ${POLICY_PATH}`)),
      'wrong one-path policy commit did not fail the exact policy-path verification',
    );
    const extraPolicyPath = createOrderingSelfTestFixture(false, false, 'extra');
    orderingFixtures.push(extraPolicyPath.root);
    expect(
      verifyOrdering(extraPolicyPath.root, {
        storyInitCommit: extraPolicyPath.storyInitCommit,
        policyCommit: extraPolicyPath.policyCommit,
        policyPath: POLICY_PATH,
        scriptPath: SCRIPT_PATH,
      }).some((error) => error.includes(`policy commit must contain only ${POLICY_PATH}`)),
      'policy commit with an extra production path did not fail the exact one-path verification',
    );
    const prePolicyProduction = createOrderingSelfTestFixture(true, false);
    orderingFixtures.push(prePolicyProduction.root);
    expect(
      verifyOrdering(prePolicyProduction.root, {
        storyInitCommit: prePolicyProduction.storyInitCommit,
        policyCommit: prePolicyProduction.policyCommit,
        policyPath: POLICY_PATH,
        scriptPath: SCRIPT_PATH,
      }).some((error) => error.includes('pre-policy commit') && error.includes('production/non-story paths')),
      'production migration before the decision did not fail ordering verification',
    );
    const preRedProduction = createOrderingSelfTestFixture(false, true);
    orderingFixtures.push(preRedProduction.root);
    expect(
      verifyOrdering(preRedProduction.root, {
        storyInitCommit: preRedProduction.storyInitCommit,
        policyCommit: preRedProduction.policyCommit,
        policyPath: POLICY_PATH,
        scriptPath: SCRIPT_PATH,
      }).some((error) => error.includes('pre-RED commit') && error.includes('production/non-story paths')),
      'production migration between the decision and RED did not fail ordering verification',
    );
  } finally {
    for (const fixtureRoot of orderingFixtures) rmSync(fixtureRoot, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`SELF-TEST FAIL: ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(SELF_TEST_PASS_SUMMARY);
}
