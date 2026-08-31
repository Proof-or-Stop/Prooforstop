#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = join(packageRoot, '..', '..');
const localCli = join(repoRoot, 'bin', 'proof-or-stop.js');
const distName = existsSync(join(packageRoot, 'dist', 'core', 'artifact-schema.js'))
  ? 'dist'
  : 'dist.staging';
const distRoot = join(packageRoot, distName);

const schema = await import(join(distRoot, 'core/artifact-schema.js'));
const validation = await import(join(distRoot, 'core/done-required-validation.js'));
const closeout = await import(join(distRoot, 'core/closeout-trust.js'));
const freshness = await import(join(distRoot, 'core/evidence-freshness.js'));
const proofBinding = await import(join(distRoot, 'core/proof-admissibility-binding.js'));
const artifactStore = await import(join(distRoot, 'core/evidence/artifact-store.js'));
const checklistStatus = await import(join(distRoot, 'core/checklist-status.js'));
const processFacts = await import(join(distRoot, 'core/process-fact-registry.js'));
const findingVerification = await import(join(distRoot, 'core/finding-verify.js'));

const stableJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

// CHK-003 migration witness: exercise the local worktree CLI against two named
// archives from different eras. The schema/integrity/freshness/byte assertions
// below remain in this same pinned test, so a passing receipt covers both the
// executable read path and the historical artifact invariants.
const archivedStories = [
  {
    storyId: 'B-0168',
    phase: 'INIT',
    era: 'earliest-era archive',
    files: [
      'index.json',
      'checklist.json',
      'scope-boundary.json',
      'execution-boundary.json',
      'scope-freeze-check.json',
    ],
  },
  {
    storyId: 'B-META-framework-audit',
    phase: 'META',
    era: 'signed cross-story ledger',
    files: ['index.json', 'findings.json', 'gap-log-provenance.jsonl'],
  },
];
const archiveBytesBefore = new Map(
  archivedStories.flatMap(({ storyId, files }) => files.map((file) => {
    const path = join(repoRoot, '.proof-or-stop/story/actives', storyId, file);
    return [path, readFileSync(path)];
  })),
);
const cliJson = (command, args) => JSON.parse(execFileSync(
  process.execPath,
  [localCli, command, JSON.stringify(args)],
  { cwd: repoRoot, encoding: 'utf8' },
));

const migrationWitness = execFileSync(
  process.execPath,
  [join(repoRoot, 'scripts/verify-state-dir-migration.mjs')],
  { cwd: repoRoot, encoding: 'utf8' },
);
assert.match(migrationWitness, /state dir migration verified/);

for (const expected of archivedStories) {
  const result = cliJson('story_get', { storyId: expected.storyId, detail: true });
  assert.equal(result.index?.storyId, expected.storyId, `${expected.era} CLI read returns the requested story`);
  assert.equal(result.index?.phase, expected.phase, `${expected.era} CLI read preserves its historical phase`);
  assert.ok(Array.isArray(result.checklist?.items), `${expected.era} CLI read returns checklist data`);
  assert.ok(Array.isArray(result.review?.reviews), `${expected.era} CLI read returns review data`);
}

// B-0168's archived scope artifacts are the earliest-era signed evidence. The
// public preflight CLI must still validate their integrity and expose the
// current-binding result rather than silently treating stale historical data as
// fresh evidence.
const earliestPreflight = cliJson('init_preflight', { storyId: 'B-0168', json: true });
const earliestPrerequisites = new Map(earliestPreflight.prerequisites.map((row) => [row.id, row.status]));
for (const id of ['scope-boundary', 'execution-boundary', 'scope-freeze-check']) {
  assert.equal(earliestPrerequisites.get(id), 'PASS', `B-0168 ${id} signature remains valid`);
}
assert.equal(typeof earliestPreflight.gate?.ready, 'boolean', 'B-0168 preflight reports current binding state');

// B-META-framework-audit's archive is a signed finding ledger. Read it through
// the local CLI, verify every historical finding signature, then verify the
// existing HMAC receipt chain and its current-HEAD ancestor bindings. Receipt
// path/schema spellings are accepted in their canonical or historical forms;
// their bytes and signatures are never rewritten by a read.
const metaFindings = cliJson('finding_list', {
  storyId: 'B-META-framework-audit',
  format: 'json',
});
assert.ok(metaFindings.findings.length > 0, 'B-META archive returns signed findings');
assert.ok(
  metaFindings.findings.every((finding) => findingVerification.verifyFinding('B-META-framework-audit', finding)),
  'B-META archive finding signatures verify',
);
const metaReceipts = findingVerification.readGapLogProvenanceLedger(repoRoot);
assert.ok(metaReceipts.length > 0, 'B-META archive returns its provenance receipts');
const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: repoRoot, encoding: 'utf8' }).trim();
const commonDirPath = commonDir.startsWith('/') ? commonDir : join(repoRoot, commonDir);
const receiptKey = readFileSync(join(commonDirPath, 'lattice-gap-log-provenance.key'));
const canonicalReceiptArtifactPath = findingVerification.GAP_LOG_ARTIFACT_PATH;
const legacyReceiptArtifactPath = '.lattice/story/actives/B-META-framework-audit/findings.json';
const canonicalReceiptLedgerPath = findingVerification.GAP_LOG_PROVENANCE_LEDGER_PATH;
let previousIntegrityHash = '';
for (const [index, receipt] of metaReceipts.entries()) {
  const { integrityHash, ...unsigned } = receipt;
  const expectedIntegrityHash = createHmac('sha256', receiptKey)
    .update(JSON.stringify(unsigned))
    .digest('hex');
  assert.equal(receipt.sequence, index + 1, 'B-META receipt sequence is contiguous');
  assert.equal(receipt.previousIntegrityHash, previousIntegrityHash, 'B-META receipt chain links to its predecessor');
  assert.equal(integrityHash, expectedIntegrityHash, 'B-META receipt HMAC verifies');
  assert.ok(
    [canonicalReceiptArtifactPath, legacyReceiptArtifactPath].includes(receipt.artifactPath),
    'B-META receipt artifact path is canonical or historical-compatible',
  );
  assert.ok(
    [canonicalReceiptLedgerPath, '.lattice/story/actives/B-META-framework-audit/gap-log-provenance.jsonl'].includes(receipt.ledgerPath),
    'B-META receipt ledger path is canonical or historical-compatible',
  );
  execFileSync('git', ['merge-base', '--is-ancestor', receipt.parentHead, 'HEAD'], { cwd: repoRoot });
  previousIntegrityHash = integrityHash;
}
assert.equal(
  metaReceipts.at(-1).postArtifactDigest,
  findingVerification.digestGapLogArtifact({ findings: metaFindings.findings }),
  'B-META latest receipt binds the CLI-read archive bytes',
);

for (const [path, bytes] of archiveBytesBefore) {
  assert.deepEqual(readFileSync(path), bytes, `archive bytes preserved after CLI reads: ${path}`);
}

const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-artifact-schema-'));
try {
  const command = {
    label: 'migration smoke',
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    cwd: root,
  };

  const canonicalCommandSpec = validation.buildDoneRequiredCommandSpecEnvelope(root, command);
  assert.equal(canonicalCommandSpec.schema, 'proof-or-stop.command-spec.v2', 'new command-spec writes use proof-or-stop schema');
  assert.equal(
    validation.validateCommandSpecDigestCoverage(
      { receipts: [{ command: command.command, args: command.args, cwd: root, commandSpec: canonicalCommandSpec }] },
      root,
      [command],
    ).valid,
    true,
    'canonical command-spec envelope verifies',
  );

  const legacyV2CommandSpec = {
    ...canonicalCommandSpec,
    schema: 'lattice.command-spec.v2',
  };
  assert.equal(
    validation.validateCommandSpecDigestCoverage(
      { receipts: [{ command: command.command, args: command.args, cwd: root, commandSpec: legacyV2CommandSpec }] },
      root,
      [command],
    ).valid,
    true,
    'historical lattice v2 command-spec envelope remains readable',
  );

  const legacyV1CommandSpec = validation.buildLegacyAbsoluteCwdCommandSpecEnvelope(root, command);
  assert.equal(legacyV1CommandSpec.schema, 'lattice.command-spec.v1', 'legacy v1 helper retains historical schema');
  assert.equal(
    validation.validateCommandSpecDigestCoverage(
      { receipts: [{ command: command.command, args: command.args, cwd: root, commandSpec: legacyV1CommandSpec }] },
      root,
      [command],
    ).valid,
    true,
    'historical lattice v1 command-spec envelope remains readable',
  );

  const unknownCommandSpec = { ...canonicalCommandSpec, schema: 'lattice.command-spec.v99' };
  assert.equal(
    validation.validateCommandSpecDigestCoverage(
      { receipts: [{ command: command.command, args: command.args, cwd: root, commandSpec: unknownCommandSpec }] },
      root,
      [command],
    ).valid,
    false,
    'unknown command-spec schemas fail closed and are not rewritten',
  );

  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Proof-or-Stop migration test'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'migration-test@example.invalid'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, 'tracked.txt'), 'baseline\n');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'baseline'], { cwd: root, stdio: 'ignore' });

  const canonicalSnapshot = freshness.captureEvidenceHashSnapshot({ gitCwd: root, metadataRoot: root, ref: 'HEAD' });
  assert.equal(canonicalSnapshot.schemaVersion, 'proof-or-stop.evidence_hash_snapshot.v1', 'freshness capture writes the canonical schema');
  assert.equal(schema.isEvidenceHashSnapshotSchema(canonicalSnapshot.schemaVersion), true);
  assert.equal(schema.isEvidenceHashSnapshotSchema('lattice.evidence_hash_snapshot.v1'), true, 'legacy freshness schema remains readable');
  assert.equal(schema.isEvidenceHashSnapshotSchema('proof-or-stop.evidence_hash_snapshot.v99'), false, 'unknown freshness schemas fail closed');
  assert.equal(
    freshness.checkEvidenceHashSnapshotReuse(canonicalSnapshot, { gitCwd: root, metadataRoot: root, ref: 'HEAD' }).reusable,
    true,
    'canonical freshness snapshot can be captured and reused',
  );
  assert.equal(
    freshness.checkEvidenceHashSnapshotReuse(
      { ...canonicalSnapshot, schemaVersion: 'lattice.evidence_hash_snapshot.v1' },
      { gitCwd: root, metadataRoot: root, ref: 'HEAD' },
    ).reusable,
    true,
    'historical lattice freshness snapshot remains readable through intentional dual-read compatibility',
  );
  assert.equal(
    freshness.checkEvidenceHashSnapshotReuse(
      { ...canonicalSnapshot, schemaVersion: 'proof-or-stop.evidence_hash_snapshot.v99' },
      { gitCwd: root, metadataRoot: root, ref: 'HEAD' },
    ).reusable,
    false,
    'unknown freshness schemas remain rejected',
  );

  assert.equal(schema.DONE_REQUIRED_EVIDENCE_SCHEMA, 'proof-or-stop.done-required-evidence');
  assert.equal(schema.DONE_REQUIRED_EVIDENCE_SCHEMA_LEGACY, 'lattice.done-required-evidence');
  assert.equal(schema.isDoneRequiredEvidenceSchema('lattice.done-required-evidence'), true);
  assert.equal(schema.isDoneRequiredEvidenceSchema('lattice.done-required-evidence.v99'), false);

  const artifactBytes = JSON.stringify({ status: 'complete' });
  const canonicalReceipt = closeout.buildCloseoutWriteReceipt({
    storyId: 'B-schema',
    artifactPath: 'summary.json',
    writerCommand: 'summary_set',
    artifactDigest: closeout.rawArtifactDigest(artifactBytes),
    phase: 'DONE',
    headHash: 'head',
    materialHash: 'material',
    storyFilesHash: 'story-files',
    sequence: 1,
    previousIntegrityHash: null,
  });
  assert.equal(canonicalReceipt.schemaVersion, 'proof-or-stop.closeout_write_receipt.v3');
  assert.equal(closeout.verifyCloseoutWriteReceipt(canonicalReceipt, {
    storyId: 'B-schema',
    artifactPath: 'summary.json',
    artifactBytes,
  }).ok, true, 'canonical closeout receipt verifies');

  const { integrityHash: _ignored, ...legacyUnsigned } = {
    ...canonicalReceipt,
    schemaVersion: 'lattice.closeout_write_receipt.v3',
  };
  const legacyReceipt = {
    ...legacyUnsigned,
    integrityHash: closeout.computeCloseoutWriteReceiptIntegrity(legacyUnsigned),
  };
  assert.equal(closeout.verifyCloseoutWriteReceipt(legacyReceipt, {
    storyId: 'B-schema',
    artifactPath: 'summary.json',
    artifactBytes,
  }).ok, true, 'historical lattice closeout receipt remains readable');

  const unknownReceipt = { ...canonicalReceipt, schemaVersion: 'lattice.closeout_write_receipt.v99' };
  assert.equal(closeout.verifyCloseoutWriteReceipt(unknownReceipt, {
    storyId: 'B-schema',
    artifactPath: 'summary.json',
    artifactBytes,
  }).ok, false, 'unknown closeout schemas fail closed and are not rewritten');

  const canonicalProofBindingPayload = {
    schemaVersion: proofBinding.PROOF_BINDING_SCHEMA_VERSION,
    verifierVersion: 'v1',
    artifactKind: 'done-required-evidence',
    claim: 'done-readiness',
    storyId: 'B-schema',
    headHash: 'head',
    materialHash: 'material',
    verdict: 'pass',
    reason: 'verified',
    producerId: 'artifact-schema-migration-test',
    signatureDigest: 'sha256:signature',
  };
  const canonicalProofBinding = proofBinding.buildProofBindingDigestPayload(canonicalProofBindingPayload);
  assert.equal(canonicalProofBinding.schemaVersion, schema.PROOF_BINDING_SCHEMA, 'proof binding writers retain the canonical schema');
  assert.equal(
    proofBinding.verifyProofBindingDigest(canonicalProofBindingPayload, canonicalProofBinding.digest).ok,
    true,
    'canonical proof binding verifies',
  );

  const legacyProofBindingPayload = {
    ...canonicalProofBindingPayload,
    schemaVersion: schema.PROOF_BINDING_SCHEMA_LEGACY,
  };
  const legacyProofBindingDigest = `sha256:${createHash('sha256')
    .update(stableJson(legacyProofBindingPayload), 'utf8')
    .digest('hex')}`;
  assert.equal(
    proofBinding.verifyProofBindingDigest(legacyProofBindingPayload, legacyProofBindingDigest).ok,
    true,
    'exact historical lattice proof binding schema remains readable',
  );
  assert.throws(
    () => proofBinding.buildProofBindingDigestPayload(legacyProofBindingPayload),
    /unsupported proof binding schemaVersion/,
    'canonical proof binding writer does not emit the historical schema',
  );
  const unknownProofBinding = proofBinding.verifyProofBindingDigest(
    { ...canonicalProofBindingPayload, schemaVersion: 'lattice.proof_binding.v99' },
    canonicalProofBinding.digest,
  );
  assert.equal(unknownProofBinding.ok, false, 'unknown proof binding schemas fail closed');
  assert.deepEqual(unknownProofBinding.reasons, ['unsupported_schema_version']);

  // Global CLI/package interop can interleave the two exact supported schema
  // aliases: canonical seq1..18, legacy seq1..3, then canonical seq4..5.
  // Validate that real ledger shape through the same causal reader used by
  // review-retention and pre-review gates.
  const migrationStoryDir = join(root, 'migration-story');
  mkdirSync(migrationStoryDir, { recursive: true });
  const migrationStoryId = 'B-schema-migration';
  const migrationArtifactPath = 'summary.json';
  const migrationReceiptPath = join(migrationStoryDir, closeout.CLOSEOUT_WRITE_RECEIPTS_PATH);
  const writeMigrationReceipt = ({ schemaVersion, sequence, previousIntegrityHash, value }) => {
    const migrationBytes = JSON.stringify({ value }) + '\n';
    writeFileSync(join(migrationStoryDir, migrationArtifactPath), migrationBytes);
    const parentHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const baseReceipt = closeout.buildCloseoutWriteReceipt({
      storyId: migrationStoryId,
      artifactPath: migrationArtifactPath,
      writerCommand: 'summary_set',
      artifactDigest: closeout.rawArtifactDigest(migrationBytes),
      phase: 'TEST',
      headHash: parentHead,
      materialHash: freshness.currentMaterialHash(root, parentHead, root),
      storyFilesHash: freshness.currentStoryFilesHash(root, parentHead, root),
      sequence,
      previousIntegrityHash,
    });
    const { integrityHash: _baseIntegrityHash, ...unsigned } = { ...baseReceipt, schemaVersion };
    const receipt = {
      ...unsigned,
      integrityHash: closeout.computeCloseoutWriteReceiptIntegrity(unsigned),
    };
    const existingLedger = existsSync(migrationReceiptPath) ? readFileSync(migrationReceiptPath, 'utf8') : '';
    writeFileSync(migrationReceiptPath, `${existingLedger}${JSON.stringify(receipt)}\n`);
    execFileSync('git', ['add', 'migration-story'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', `receipt ${schemaVersion} ${sequence}`], { cwd: root, stdio: 'ignore' });
    return receipt;
  };

  let previousMigrationReceipt = null;
  for (let sequence = 1; sequence <= 18; sequence += 1) {
    previousMigrationReceipt = writeMigrationReceipt({
      schemaVersion: 'proof-or-stop.closeout_write_receipt.v3',
      sequence,
      previousIntegrityHash: previousMigrationReceipt?.integrityHash ?? null,
      value: `canonical-${sequence}`,
    });
  }
  previousMigrationReceipt = null;
  for (let sequence = 1; sequence <= 3; sequence += 1) {
    previousMigrationReceipt = writeMigrationReceipt({
      schemaVersion: 'lattice.closeout_write_receipt.v3',
      sequence,
      previousIntegrityHash: previousMigrationReceipt?.integrityHash ?? null,
      value: `legacy-${sequence}`,
    });
  }
  for (let sequence = 4; sequence <= 5; sequence += 1) {
    previousMigrationReceipt = writeMigrationReceipt({
      schemaVersion: 'proof-or-stop.closeout_write_receipt.v3',
      sequence,
      previousIntegrityHash: previousMigrationReceipt?.integrityHash ?? null,
      value: `canonical-${sequence}`,
    });
  }
  const migratedReceipt = closeout.latestCausallyValidCloseoutReceipt(
    migrationStoryDir,
    migrationStoryId,
    migrationArtifactPath,
    { projectRoot: root, metadataRoot: root },
  );
  assert.equal(migratedReceipt?.schemaVersion, 'proof-or-stop.closeout_write_receipt.v3');
  assert.equal(migratedReceipt?.sequence, 5, 'canonical interop resumes after the legacy epoch');

  const migrationLedger = readFileSync(migrationReceiptPath, 'utf8');
  const tamperedLegacy = migrationLedger.replace(
    /("schemaVersion":"lattice\.closeout_write_receipt\.v3"[^\n]*?)"sequence":1,"previousIntegrityHash":null/,
    '$1"sequence":2,"previousIntegrityHash":null',
  );
  assert.notEqual(tamperedLegacy, migrationLedger, 'the legacy epoch tamper fixture must target a legacy receipt');
  writeFileSync(migrationReceiptPath, tamperedLegacy);
  assert.equal(
    closeout.latestCausallyValidCloseoutReceipt(migrationStoryDir, migrationStoryId, migrationArtifactPath),
    null,
    'tampering inside the legacy epoch remains fail closed after migration',
  );
  writeFileSync(migrationReceiptPath, migrationLedger);

  // Exercise the adjacent consumers that must continue to read the migrated
  // artifact family: freshness classification, immutable evidence storage,
  // checklist terminal-status semantics, and the process-fact registry.
  assert.equal(freshness.classifyEvidenceFreshness({
    fresh: true,
    reason: 'current material',
    changedFiles: [],
    materialFiles: [],
  }, 'current-hash'), 'CURRENT_MATERIAL');
  const candidate = artifactStore.writeArtifact(root, {
    artifactKind: 'repro-probe',
    evidenceScope: 'evidence-candidate',
    subjectBinding: { candidateId: 'candidate-artifact-schema' },
    payload: { observed: 'canonical writer and legacy reader were exercised' },
    producer: 'artifact-schema-migration-test',
  });
  assert.equal(artifactStore.verifyArtifactDigest(candidate, candidate.artifactDigest), true, 'artifact store verifies the producer digest');
  assert.deepEqual(artifactStore.readArtifact(root, candidate.artifactId), candidate, 'artifact store reads the exact persisted envelope');
  assert.equal(checklistStatus.isTerminalChecklistStatus('withdrawn'), true);
  assert.equal(checklistStatus.isDeliveredChecklistStatus('withdrawn'), false);
  assert.ok(processFacts.getProcessFactRegistryEntry('acceptance_basis'), 'process-fact consumer retains the canonical command entry');
  assert.equal(freshness.isStoryMetadataPath('.lattice/story/actives/B-archived/story.json'), true, 'archived story metadata remains excluded from material evidence');

  console.log('artifact-schema migration test passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
