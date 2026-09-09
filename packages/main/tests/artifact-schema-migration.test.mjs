#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

const stableJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

for (const [canonical, accepts] of [
  [schema.DONE_REQUIRED_EVIDENCE_SCHEMA, schema.isDoneRequiredEvidenceSchema],
  [schema.DONE_REQUIRED_EVIDENCE_VERSIONED_SCHEMA, schema.isDoneRequiredEvidenceVersionedSchema],
  [schema.DONE_REQUIRED_COMMAND_SPEC_SCHEMA, schema.isDoneRequiredCommandSpecV2Schema],
  [schema.DONE_REQUIRED_COMMAND_SPEC_SCHEMA, schema.isDoneRequiredCommandSpecSchema],
  [schema.DONE_REQUIRED_COMMAND_SPEC_SCHEMA_V1, schema.isDoneRequiredCommandSpecSchema],
  [schema.CLOSEOUT_WRITE_RECEIPT_SCHEMA, schema.isCloseoutWriteReceiptSchema],
  [schema.EVIDENCE_HASH_SNAPSHOT_SCHEMA, schema.isEvidenceHashSnapshotSchema],
  [schema.DONE_PREPARE_GENERATED_METADATA_SCHEMA, schema.isDonePrepareGeneratedMetadataSchema],
  [schema.DONE_PREPARE_VALIDATION_REUSE_SCHEMA, schema.isDonePrepareValidationReuseSchema],
]) {
  assert.equal(accepts(canonical), true, `${canonical} is accepted`);
  for (const retiredPrefix of ['lattice', 'proofbound']) {
    const retired = canonical.replace(/^proof-or-stop/, retiredPrefix);
    assert.equal(accepts(retired), false, `${retired} cannot satisfy a current schema`);
  }
}

for (const canonical of [schema.DONE_REQUIRED_COMMAND_SPEC_SCHEMA_V1, schema.DONE_REQUIRED_COMMAND_SPEC_SCHEMA]) {
  for (const lookalike of [canonical.replace(/v\d+$/, 'v99'), `${canonical}.extra`, ` ${canonical}`, `${canonical} `, canonical.toUpperCase(), null, {}]) {
    assert.equal(schema.isDoneRequiredCommandSpecSchema(lookalike), false, 'the general command-spec validator remains an exact two-version allowlist');
  }
}

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

// Historical ledger records remain available for audit through the read-only
// CLI. Reading preserves bytes; it does not confer current evidence authority.
const metaFindings = cliJson('finding_list', {
  storyId: 'B-META-framework-audit', format: 'json',
});
assert.ok(metaFindings.findings.length > 0, 'historical findings remain available for audit');

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
  const retiredCommandBytes = JSON.stringify(legacyV2CommandSpec);
  assert.equal(
    validation.validateCommandSpecDigestCoverage(
      { receipts: [{ command: command.command, args: command.args, cwd: root, commandSpec: legacyV2CommandSpec }] },
      root,
      [command],
    ).valid,
    false,
    'retired v2 command-spec envelope cannot satisfy current evidence',
  );
  assert.equal(JSON.stringify(legacyV2CommandSpec), retiredCommandBytes, 'rejected command-spec bytes remain unchanged');

  const legacyV1CommandSpec = validation.buildLegacyAbsoluteCwdCommandSpecEnvelope(root, command);
  assert.equal(legacyV1CommandSpec.schema, 'proof-or-stop.command-spec.v1', 'older command-spec version retains canonical identity');
  assert.equal(
    validation.validateCommandSpecDigestCoverage(
      { receipts: [{ command: command.command, args: command.args, cwd: root, commandSpec: legacyV1CommandSpec }] },
      root,
      [command],
    ).valid,
    true,
    'canonical v1 command-spec envelope remains readable',
  );
  for (const canonicalSpec of [canonicalCommandSpec, legacyV1CommandSpec]) {
    for (const prefix of ['lattice', 'proofbound']) {
      const retiredSpec = { ...canonicalSpec, schema: canonicalSpec.schema.replace(/^proof-or-stop/, prefix) };
      const evidence = { receipts: [{ command: command.command, args: command.args, cwd: root, commandSpec: retiredSpec }] };
      const before = JSON.stringify(evidence);
      assert.equal(validation.validateCommandSpecDigestCoverage(evidence, root, [command]).valid, false);
      assert.equal(JSON.stringify(evidence), before, 'retired command schema rejection leaves evidence unchanged');
    }
  }

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
  assert.equal(schema.isEvidenceHashSnapshotSchema('lattice.evidence_hash_snapshot.v1'), false, 'retired freshness schema is rejected');
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
    false,
    'retired freshness snapshot cannot authorize reuse',
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
  assert.equal(schema.isDoneRequiredEvidenceSchema('lattice.done-required-evidence'), false);
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
  const retiredReceiptBytes = JSON.stringify(legacyReceipt);
  assert.equal(closeout.verifyCloseoutWriteReceipt(legacyReceipt, {
    storyId: 'B-schema',
    artifactPath: 'summary.json',
    artifactBytes,
  }).ok, false, 'retired closeout receipt is rejected even with a recomputed integrity hash');
  assert.equal(JSON.stringify(legacyReceipt), retiredReceiptBytes, 'rejected closeout receipt remains unchanged');

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
    schemaVersion: 'lattice.proof_binding.v1',
  };
  const legacyProofBindingDigest = `sha256:${createHash('sha256')
    .update(stableJson(legacyProofBindingPayload), 'utf8')
    .digest('hex')}`;
  const retiredBindingBytes = JSON.stringify(legacyProofBindingPayload);
  assert.equal(
    proofBinding.verifyProofBindingDigest(legacyProofBindingPayload, legacyProofBindingDigest).ok,
    false,
    'retired proof binding cannot satisfy current evidence',
  );
  assert.throws(
    () => proofBinding.buildProofBindingDigestPayload(legacyProofBindingPayload),
    /unsupported proof binding schemaVersion/,
    'canonical proof binding writer does not emit the historical schema',
  );
  assert.equal(JSON.stringify(legacyProofBindingPayload), retiredBindingBytes, 'rejected proof binding remains unchanged');
  const unknownProofBinding = proofBinding.verifyProofBindingDigest(
    { ...canonicalProofBindingPayload, schemaVersion: 'lattice.proof_binding.v99' },
    canonicalProofBinding.digest,
  );
  assert.equal(unknownProofBinding.ok, false, 'unknown proof binding schemas fail closed');
  assert.deepEqual(unknownProofBinding.reasons, ['unsupported_schema_version']);

  // Prove canonical causal receipt reuse first, then append a retired-schema
  // epoch with valid integrity hashes. It must invalidate current reuse without
  // mutating the ledger or artifact, even after a canonical suffix is appended.
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
  const canonicalCausalReceipt = closeout.latestCausallyValidCloseoutReceipt(
    migrationStoryDir, migrationStoryId, migrationArtifactPath,
    { projectRoot: root, metadataRoot: root },
  );
  assert.equal(canonicalCausalReceipt?.sequence, 18, 'canonical causal ledger is reusable');
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
  const ledgerBeforeReject = readFileSync(migrationReceiptPath);
  const artifactBeforeReject = readFileSync(join(migrationStoryDir, migrationArtifactPath));
  const migratedReceipt = closeout.latestCausallyValidCloseoutReceipt(
    migrationStoryDir,
    migrationStoryId,
    migrationArtifactPath,
    { projectRoot: root, metadataRoot: root },
  );
  assert.equal(migratedReceipt, null, 'retired epoch cannot be laundered through a canonical suffix');
  assert.deepEqual(readFileSync(migrationReceiptPath), ledgerBeforeReject, 'rejected ledger bytes are preserved');
  assert.deepEqual(readFileSync(join(migrationStoryDir, migrationArtifactPath)), artifactBeforeReject, 'rejected artifact bytes are preserved');

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
    payload: { observed: 'canonical writer and retired schema rejection were exercised' },
    producer: 'artifact-schema-migration-test',
  });
  assert.equal(artifactStore.verifyArtifactDigest(candidate, candidate.artifactDigest), true, 'artifact store verifies the producer digest');
  assert.deepEqual(artifactStore.readArtifact(root, candidate.artifactId), candidate, 'artifact store reads the exact persisted envelope');
  assert.equal(checklistStatus.isTerminalChecklistStatus('withdrawn'), true);
  assert.equal(checklistStatus.isDeliveredChecklistStatus('withdrawn'), false);
  assert.ok(processFacts.getProcessFactRegistryEntry('acceptance_basis'), 'process-fact consumer retains the canonical command entry');
  assert.equal(freshness.isStoryMetadataPath('.proof-or-stop/story/actives/B-archived/story.json'), true, 'canonical story metadata remains excluded from material evidence');

  console.log('artifact-schema migration test passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
