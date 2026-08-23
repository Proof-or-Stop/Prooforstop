#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const distName = existsSync(join(packageRoot, 'dist', 'core', 'artifact-schema.js'))
  ? 'dist'
  : 'dist.staging';
const distRoot = join(packageRoot, distName);

const schema = await import(join(distRoot, 'core/artifact-schema.js'));
const validation = await import(join(distRoot, 'core/done-required-validation.js'));
const closeout = await import(join(distRoot, 'core/closeout-trust.js'));
const freshness = await import(join(distRoot, 'core/evidence-freshness.js'));
const artifactStore = await import(join(distRoot, 'core/evidence/artifact-store.js'));
const checklistStatus = await import(join(distRoot, 'core/checklist-status.js'));
const processFacts = await import(join(distRoot, 'core/process-fact-registry.js'));

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

  // A schema migration may start a new canonical receipt epoch. Validate the
  // complete legacy chain and the reset canonical chain through the same
  // causal reader used by review-retention and pre-review gates.
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
      schemaVersion: 'lattice.closeout_write_receipt.v3',
      sequence,
      previousIntegrityHash: previousMigrationReceipt?.integrityHash ?? null,
      value: `legacy-${sequence}`,
    });
  }
  previousMigrationReceipt = null;
  for (let sequence = 1; sequence <= 4; sequence += 1) {
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
  assert.equal(migratedReceipt?.sequence, 4, 'canonical epoch is selected after a sequence reset');

  const migrationLedger = readFileSync(migrationReceiptPath, 'utf8');
  const tamperedLegacy = migrationLedger.replace(
    '"sequence":1,"previousIntegrityHash":null',
    '"sequence":2,"previousIntegrityHash":null',
  );
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
