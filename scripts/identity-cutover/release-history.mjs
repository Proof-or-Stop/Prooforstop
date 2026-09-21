
import { readFileSync } from 'node:fs';

import { resolve } from 'node:path';


import { capabilityReleaseRecordValidationErrors, computeCapabilityDigest } from "../../packages/main/dist/core/capability-release.js";
import { artifactReleaseRecordValidationErrors } from "../../packages/main/dist/core/artifact-release.js";





import { changelogPreservesHistory, reviewedChangelogCompaction, reviewedProvenanceAmendment } from ".././identity-maintenance-boundaries.mjs";
import { CANONICAL_ARTIFACT_RELEASE_SCHEMA, RETIRED_ARTIFACT_RELEASE_SCHEMA, CANONICAL_CAPABILITY_RELEASE_SCHEMA, RETIRED_CAPABILITY_RELEASE_SCHEMA, RETIRED_PRODUCT_NAME, ALLOWED_CLASSES } from "./rules.mjs";
import { sha256, git } from "./repository.mjs";
import { APPEND_ONLY_LEDGER_SUFFIX_PROVENANCE, IMPORTED_RELEASE_SOURCE_COMMIT, IMPORTED_RELEASE_PROVENANCE, IMPORTED_RELEASE_SOURCES, FROZEN_FILE_BASELINES, EXPECTED_FROZEN_FILE_BASELINE_COUNT } from "./provenance-data.mjs";

export function isProtectedArtifact(path) {
  return path.startsWith('.proof-or-stop/story/')
    || path.startsWith('.lattice/story/')
    || path.includes('/tests/fixtures/')
    || path.startsWith('tests/fixtures/');
}

export function isPlainRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function normalizedUniquePaths(paths) {
  return [...new Set(paths.map((path) => path.replace(/\\/gu, '/').replace(/^\.?\//u, '').replace(/\/+/gu, '/').trim()).filter(Boolean))].sort();
}

export function appendOnlyReleaseRecordStructureErrors(schemaVersion, value) {
  if (!isPlainRecord(value)) return ['record must be an object'];
  const errors = [];
  const requireStrings = (fields) => {
    for (const field of fields) if (!isNonEmptyString(value[field])) errors.push(`${field} must be a non-empty string`);
  };
  const validateCommon = (idPattern, idLabel) => {
    requireStrings(['id', 'idempotencyKey', 'storyId', 'createdAt', 'mainCommit']);
    if (isNonEmptyString(value.id) && !idPattern.test(value.id)) errors.push(`id must be ${idLabel}`);
    if (isNonEmptyString(value.storyId) && !/^B-[A-Za-z0-9][A-Za-z0-9-]*$/u.test(value.storyId)) errors.push('storyId must be a B-* Story id');
    if (isNonEmptyString(value.createdAt) && Number.isNaN(Date.parse(value.createdAt))) errors.push('createdAt must be an ISO-compatible timestamp');
    if (isNonEmptyString(value.mainCommit) && value.mainCommit !== 'uncommitted' && !/^[a-f0-9]{40}$/u.test(value.mainCommit)) errors.push('mainCommit must be a full lowercase Git SHA or uncommitted');
    if (typeof value.runtimeSemverChanged !== 'boolean') errors.push('runtimeSemverChanged must be boolean');
    if (!Array.isArray(value.notes) || value.notes.length === 0 || value.notes.some((note) => !isNonEmptyString(note))) errors.push('notes must be a non-empty array of non-empty strings');
  };
  if (value.schemaVersion !== schemaVersion) errors.push(`schemaVersion must be ${schemaVersion}`);
  if (schemaVersion === CANONICAL_ARTIFACT_RELEASE_SCHEMA || schemaVersion === RETIRED_ARTIFACT_RELEASE_SCHEMA) {
    validateCommon(/^AR-[a-f0-9]{24}$/u, 'AR-<24 lowercase hex>');
    requireStrings(['artifactSetDigest', 'claimBoundary']);
    if (!Number.isInteger(value.changedPathCount) || value.changedPathCount < 0) errors.push('changedPathCount must be a non-negative integer');
    if (!Array.isArray(value.paths) || value.paths.length === 0 || value.paths.some((path) => !isNonEmptyString(path))) {
      errors.push('paths must be a non-empty array of non-empty strings');
    } else {
      if (JSON.stringify(normalizedUniquePaths(value.paths)) !== JSON.stringify(value.paths)) errors.push('paths must be normalized, unique, and sorted');
      if (value.changedPathCount !== value.paths.length) errors.push('changedPathCount must equal paths.length');
    }
    if (isNonEmptyString(value.artifactSetDigest) && !/^sha256:[a-f0-9]{64}$/u.test(value.artifactSetDigest)) errors.push('artifactSetDigest must be sha256:<64 lowercase hex>');
    if (isNonEmptyString(value.storyId) && isNonEmptyString(value.mainCommit) && isNonEmptyString(value.artifactSetDigest)) {
      const expectedKey = `${value.storyId}:${value.mainCommit}:${value.artifactSetDigest}`;
      if (value.idempotencyKey !== expectedKey) errors.push('idempotencyKey does not match artifact identity inputs');
      if (isNonEmptyString(value.id) && value.id !== `AR-${sha256(expectedKey).slice(0, 24)}`) errors.push('id does not match idempotencyKey');
    }
  } else if (schemaVersion === CANONICAL_CAPABILITY_RELEASE_SCHEMA || schemaVersion === RETIRED_CAPABILITY_RELEASE_SCHEMA) {
    if (schemaVersion === CANONICAL_CAPABILITY_RELEASE_SCHEMA) {
      if (value.changedPathsScope !== 'capability-material') errors.push('changedPathsScope must be capability-material for new canonical release records');
      errors.push(...capabilityReleaseRecordValidationErrors(value, { requireCurrentWrite: true }));
    }
    validateCommon(/^PCR-[a-f0-9]{24}$/u, 'PCR-<24 lowercase hex>');
    requireStrings(['capabilityId', 'capabilityVersion', 'capabilityDigest']);
    if (value.capabilityName !== undefined && !isNonEmptyString(value.capabilityName)) errors.push('capabilityName must be a non-empty string when present');
    if (!new Set(['experiment-launch-control', 'workflow-control', 'evidence-control', 'memory-control', 'documentation-control', 'other']).has(value.capabilityKind)) errors.push('capabilityKind is invalid');
    if (isNonEmptyString(value.capabilityDigest) && !/^sha256:[a-f0-9]{64}$/u.test(value.capabilityDigest)) errors.push('capabilityDigest must be sha256:<64 lowercase hex>');
    if (isNonEmptyString(value.capabilityVersion) && value.capabilityVersion !== value.capabilityDigest?.replace(/^sha256:/u, '').slice(0, 12)) errors.push('capabilityVersion does not match capabilityDigest');
    if (value.artifactReleaseId !== undefined && (!isNonEmptyString(value.artifactReleaseId) || !/^AR-[a-f0-9]{24}$/u.test(value.artifactReleaseId))) errors.push('artifactReleaseId is invalid');
    if (value.artifactSetDigest !== undefined && (!isNonEmptyString(value.artifactSetDigest) || !/^sha256:[a-f0-9]{64}$/u.test(value.artifactSetDigest))) errors.push('artifactSetDigest is invalid');
    if (!Array.isArray(value.changedPaths) || value.changedPaths.length === 0 || value.changedPaths.some((path) => !isNonEmptyString(path))) {
      errors.push('changedPaths must be a non-empty array of non-empty strings');
    } else if (JSON.stringify(normalizedUniquePaths(value.changedPaths)) !== JSON.stringify(value.changedPaths)) {
      errors.push('changedPaths must be normalized, unique, and sorted');
    }
    if (!new Set(['non-runtime-capability', 'runtime-capability']).has(value.activationBoundary)) errors.push('activationBoundary is invalid');
    if (value.authority !== 'non_authoritative') errors.push("authority must be 'non_authoritative'");
    if (value.gateEvidence !== false) errors.push('gateEvidence must be false');
    if (isNonEmptyString(value.storyId) && isNonEmptyString(value.capabilityId) && isNonEmptyString(value.capabilityDigest)) {
      const expectedKey = `${value.storyId}:${value.capabilityId}:${value.capabilityDigest}`;
      if (value.idempotencyKey !== expectedKey) errors.push('idempotencyKey does not match capability identity inputs');
      if (isNonEmptyString(value.id) && value.id !== `PCR-${sha256(expectedKey).slice(0, 24)}`) errors.push('id does not match idempotencyKey');
    }
  } else {
    errors.push(`unsupported append-only ledger schema ${schemaVersion}`);
  }
  return errors;
}

export function retiredTokenCounts(value, includeRetiredProduct = false) {
  const counts = new Map();
  const scan = (candidate) => {
    if (typeof candidate === 'string') {
      // Historical suffix pins predate the general both-family active scanner.
      // Preserve their exact counting contract; do not recount or rewrite ledgers.
      const historicalPattern = /@lattice\/[A-Za-z0-9._/-]+|__?LATTICE_[A-Z0-9_]+|LATTICE_[A-Z0-9_]+|\.lattice(?:-[A-Za-z0-9._-]+|\/[A-Za-z0-9._/-]*)?|lattice\.config\.json|lattice\.json|lattice-[a-z0-9-]+|[A-Za-z0-9_.-]*lattice[A-Za-z0-9_.-]*|Lattice[A-Za-z0-9_]*|LATTICE[A-Z0-9_]*/giu;
      for (const match of candidate.matchAll(historicalPattern)) counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
      if (includeRetiredProduct) {
        const pattern = new RegExp(`${RETIRED_PRODUCT_NAME}[a-z0-9._/-]*`, 'giu');
        for (const match of candidate.matchAll(pattern)) counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const entry of candidate) scan(entry);
      return;
    }
    if (!isPlainRecord(candidate)) return;
    for (const [key, entry] of Object.entries(candidate)) {
      scan(key);
      scan(entry);
    }
  };
  scan(value);
  return counts;
}

export function validateAppendOnlySuffixProvenance(row, line, record, pins = APPEND_ONLY_LEDGER_SUFFIX_PROVENANCE) {
  const errors = [];
  const pin = pins.find((candidate) => candidate.path === row.path && candidate.recordId === record.id);
  const counts = retiredTokenCounts(record, !pin || Boolean(pin.sourceCommit));
  if (pin?.sourceCommit) {
    if (pin.sourceCommit !== IMPORTED_RELEASE_SOURCE_COMMIT) errors.push(`frozen baseline ${row.id}: suffix record ${record.id} source commit changed`);
    if (record.mainCommit !== pin.mainCommit) errors.push(`frozen baseline ${row.id}: suffix record ${record.id} embedded main commit changed`);
    if (record.schemaVersion !== pin.schemaVersion) errors.push(`frozen baseline ${row.id}: suffix record ${record.id} pinned schema changed`);
  }
  if (counts.size === 0) {
    if (pin?.allowSchemaOnly) {
      if (sha256(line) !== pin.recordSha256) errors.push(`frozen baseline ${row.id}: suffix record ${record.id} digest changed`);
      return errors;
    }
    if (pin) errors.push(`frozen baseline ${row.id}: stale retired-identity provenance pin for suffix record ${record.id}`);
    return errors;
  }
  if (!pin) return [`frozen baseline ${row.id}: suffix record ${record.id || '<missing-id>'} contains unclassified retired identity tokens`];
  if (!pin.reason || pin.reason.length < 20) errors.push(`frozen baseline ${row.id}: suffix record ${record.id} provenance rationale is missing`);
  if (sha256(line) !== pin.recordSha256) errors.push(`frozen baseline ${row.id}: suffix record ${record.id} digest changed`);
  const expected = new Map();
  for (const tokenRow of pin.retiredTokens) {
    if (!tokenRow.token || /[*?\[\]{}]/u.test(tokenRow.token) || !tokenRow.reason || tokenRow.reason.length < 20 || !Number.isInteger(tokenRow.expectedOccurrences) || tokenRow.expectedOccurrences <= 0) {
      errors.push(`frozen baseline ${row.id}: suffix record ${record.id} has malformed exact token provenance`);
      continue;
    }
    if (expected.has(tokenRow.token)) errors.push(`frozen baseline ${row.id}: suffix record ${record.id} has duplicate token provenance ${tokenRow.token}`);
    expected.set(tokenRow.token, tokenRow.expectedOccurrences);
  }
  for (const [token, count] of counts) if (expected.get(token) !== count) errors.push(`frozen baseline ${row.id}: suffix record ${record.id} token ${token} count ${count}, expected ${expected.get(token) ?? 0}`);
  for (const [token, count] of expected) if (counts.get(token) !== count) errors.push(`frozen baseline ${row.id}: suffix record ${record.id} pinned token ${token} is stale`);
  return errors;
}

export function verifyImportedReleaseProvenance(root, pins = IMPORTED_RELEASE_PROVENANCE) {
  const errors = [];
  if (pins.length !== 14) errors.push('imported release provenance: expected exactly 14 records');
  const seen = new Set();
  const sources = new Map();
  for (const [path, blobOid, digest] of IMPORTED_RELEASE_SOURCES) {
    try {
      if (git(['rev-parse', `${IMPORTED_RELEASE_SOURCE_COMMIT}:${path}`], { cwd: root }).trim() !== blobOid) {
        errors.push(`imported release provenance ${path}: source commit/path blob changed`);
      }
      const bytes = git(['cat-file', 'blob', blobOid], { cwd: root, encoding: null });
      if (sha256(bytes) !== digest) errors.push(`imported release provenance ${path}: source blob digest changed`);
      sources.set(path, bytes.toString('utf8').trimEnd().split('\n'));
    } catch {
      errors.push(`imported release provenance ${path}: exact source commit/blob unavailable`);
    }
  }
  for (const pin of pins) {
    const key = `${pin.path}\0${pin.recordId}`;
    if (seen.has(key)) errors.push(`imported release provenance ${pin.recordId}: duplicate pin`);
    seen.add(key);
    if (pin.sourceCommit !== IMPORTED_RELEASE_SOURCE_COMMIT) errors.push(`imported release provenance ${pin.recordId}: source commit changed`);
    const lines = (sources.get(pin.path) || []).filter((line) => {
      try { return JSON.parse(line).id === pin.recordId; } catch { return false; }
    });
    if (lines.length !== 1) {
      errors.push(`imported release provenance ${pin.recordId}: source path/id must identify exactly one record`);
      continue;
    }
    errors.push(...validateAppendOnlySuffixProvenance({ id: 'imported-source', path: pin.path }, lines[0], JSON.parse(lines[0]), pins));
    const validateCurrent = pin.recordId.startsWith('AR-') ? artifactReleaseRecordValidationErrors : capabilityReleaseRecordValidationErrors;
    if (!validateCurrent(JSON.parse(lines[0])).some((error) => error.includes('schemaVersion'))) {
      errors.push(`imported release provenance ${pin.recordId}: production reader no longer rejects the retired schema`);
    }
  }
  return errors;
}

export function verifyAppendOnlyJsonlPrefix(row, frozenBytes, currentBytes) {
  const errors = [];
  if (sha256(frozenBytes) !== row.byteSha256) {
    errors.push(`frozen baseline ${row.id}: pinned Git blob bytes do not match byteSha256`);
    return errors;
  }
  if (currentBytes.length < frozenBytes.length || !currentBytes.subarray(0, frozenBytes.length).equals(frozenBytes)) {
    errors.push(`frozen baseline ${row.id}: immutable JSONL prefix changed`);
    return errors;
  }
  const suffix = currentBytes.subarray(frozenBytes.length);
  if (suffix.length === 0) {
    for (const pin of APPEND_ONLY_LEDGER_SUFFIX_PROVENANCE.filter((candidate) => candidate.path === row.path)) {
      errors.push(`frozen baseline ${row.id}: pinned suffix provenance record ${pin.recordId} is missing`);
    }
    return errors;
  }
  if (frozenBytes.at(-1) !== 0x0a) {
    errors.push(`frozen baseline ${row.id}: pinned JSONL prefix does not end at a record boundary`);
    return errors;
  }
  if (suffix.at(-1) !== 0x0a) {
    errors.push(`frozen baseline ${row.id}: appended JSONL suffix is truncated`);
    return errors;
  }
  const text = suffix.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(suffix)) {
    errors.push(`frozen baseline ${row.id}: appended JSONL suffix is not valid UTF-8`);
    return errors;
  }
  const lines = text.slice(0, -1).split('\n');
  const seenPinnedRecords = new Map();
  for (const [index, line] of lines.entries()) {
    if (!line) {
      errors.push(`frozen baseline ${row.id}: appended JSONL record ${index + 1} is empty`);
      continue;
    }
    try {
      const record = JSON.parse(line);
      const pin = APPEND_ONLY_LEDGER_SUFFIX_PROVENANCE.find((candidate) => candidate.path === row.path && candidate.recordId === record.id);
      const expectedSchema = pin
        ? pin.schemaVersion || (row.path.endsWith('/artifact-releases.jsonl') ? RETIRED_ARTIFACT_RELEASE_SCHEMA : RETIRED_CAPABILITY_RELEASE_SCHEMA)
        : row.appendOnlyJsonlSchemaVersion;
      for (const error of appendOnlyReleaseRecordStructureErrors(expectedSchema, record)) errors.push(`frozen baseline ${row.id}: appended JSONL record ${index + 1} ${error}`);
      errors.push(...validateAppendOnlySuffixProvenance(row, line, record));
      if (APPEND_ONLY_LEDGER_SUFFIX_PROVENANCE.some((pin) => pin.path === row.path && pin.recordId === record.id)) {
        const count = (seenPinnedRecords.get(record.id) ?? 0) + 1;
        seenPinnedRecords.set(record.id, count);
        if (count > 1) errors.push(`frozen baseline ${row.id}: pinned suffix provenance record ${record.id} appears ${count} times, expected exactly once`);
      }
    } catch {
      errors.push(`frozen baseline ${row.id}: appended JSONL record ${index + 1} is invalid JSON`);
    }
  }
  for (const pin of APPEND_ONLY_LEDGER_SUFFIX_PROVENANCE.filter((candidate) => candidate.path === row.path)) {
    if ((seenPinnedRecords.get(pin.recordId) ?? 0) === 0) errors.push(`frozen baseline ${row.id}: pinned suffix provenance record ${pin.recordId} is missing`);
  }
  return errors;
}

export function verifyFrozenFiles(root, tracked, baselines = FROZEN_FILE_BASELINES) {
  const errors = [];
  if (baselines.length !== EXPECTED_FROZEN_FILE_BASELINE_COUNT) {
    errors.push(`frozen baseline row count ${baselines.length}, expected ${EXPECTED_FROZEN_FILE_BASELINE_COUNT}`);
  }
  const ids = new Set();
  for (const row of baselines) {
    if (ids.has(row.id)) errors.push(`frozen baseline duplicate id ${row.id}`);
    ids.add(row.id);
    if (!ALLOWED_CLASSES.has(row.class)) errors.push(`frozen baseline ${row.id}: unknown class ${row.class}`);
    if (!tracked.has(row.path)) {
      errors.push(`frozen baseline ${row.id}: missing tracked path ${row.path}`);
      continue;
    }
    if (!/^[a-f0-9]{40}$/u.test(row.gitBlobOid || '')) errors.push(`frozen baseline ${row.id}: invalid Git blob OID`);
    if (!/^[a-f0-9]{64}$/u.test(row.byteSha256 || '')) errors.push(`frozen baseline ${row.id}: invalid byte sha256`);
    if (row.appendOnlyJsonlSchemaVersion) {
      let frozenBytes;
      try {
        frozenBytes = git(['cat-file', 'blob', row.gitBlobOid], { cwd: root, encoding: null });
      } catch {
        errors.push(`frozen baseline ${row.id}: pinned Git blob cannot be read`);
        continue;
      }
      errors.push(...verifyAppendOnlyJsonlPrefix(row, frozenBytes, readFileSync(resolve(root, row.path))));
      continue;
    }
    if (row.id === 'changelog-history' || row.id === 'brand-rename-provenance') {
      let frozen;
      try { frozen = git(['cat-file', 'blob', row.gitBlobOid], { cwd: root, encoding: null }); }
      catch { errors.push(`frozen baseline ${row.id}: byte mutation (pinned Git blob unavailable)`); continue; }
      const current = readFileSync(resolve(root, row.path));
      if ((row.id === 'changelog-history' && sha256(frozen) === row.byteSha256 && changelogPreservesHistory(frozen, current)) || reviewedChangelogCompaction(row, frozen, current, commit => git(['show', `${commit}:CHANGELOG.md`], { cwd: root, encoding: null }), commit => { git(['merge-base', '--is-ancestor', commit, 'HEAD'], { cwd: root }); return true; })) continue;
      if (reviewedProvenanceAmendment(row, frozen, current)) continue;
    }
    let actualOid;
    try {
      actualOid = git(['hash-object', '--', row.path], { cwd: root }).trim();
    } catch (error) {
      errors.push(`frozen baseline ${row.id}: git hash-object failed`);
      continue;
    }
    if (actualOid !== row.gitBlobOid) {
      errors.push(`frozen baseline ${row.id}: byte mutation (Git blob ${actualOid}, expected ${row.gitBlobOid})`);
      continue;
    }
    if (!isProtectedArtifact(row.path)) {
      const actualSha = sha256(readFileSync(resolve(root, row.path)));
      if (actualSha !== row.byteSha256) {
        errors.push(`frozen baseline ${row.id}: sha256 ${actualSha}, expected ${row.byteSha256}`);
      }
    }
  }
  return errors;
}

export function selfTestAppendRecord(schemaVersion) {
  const mainCommit = 'a'.repeat(40);
  if (schemaVersion === CANONICAL_ARTIFACT_RELEASE_SCHEMA) {
    const storyId = 'B-selftest';
    const artifactSetDigest = `sha256:${'b'.repeat(64)}`;
    const idempotencyKey = `${storyId}:${mainCommit}:${artifactSetDigest}`;
    return {
      schemaVersion,
      id: `AR-${sha256(idempotencyKey).slice(0, 24)}`,
      idempotencyKey,
      storyId,
      createdAt: '2026-08-31T00:00:00.000Z',
      mainCommit,
      changedPathCount: 1,
      paths: ['docs/self-test.md'],
      artifactSetDigest,
      runtimeSemverChanged: false,
      claimBoundary: 'provenance-only self-test record',
      notes: ['Canonical append-only verifier self-test.'],
    };
  }
  const storyId = 'B-selftest';
  const capabilityId = 'docs-self-test';
  const capabilityDigest = computeCapabilityDigest(capabilityId, 'documentation-control', ['docs/self-test.md']);
  const idempotencyKey = `${storyId}:${capabilityId}:${capabilityDigest}`;
  return {
    schemaVersion,
    id: `PCR-${sha256(idempotencyKey).slice(0, 24)}`,
    idempotencyKey,
    storyId,
    createdAt: '2026-08-31T00:00:00.000Z',
    mainCommit,
    capabilityId,
    capabilityVersion: capabilityDigest.slice('sha256:'.length, 'sha256:'.length + 12),
    capabilityKind: 'documentation-control',
    capabilityDigest,
    changedPaths: ['docs/self-test.md'],
    changedPathsScope: 'capability-material',
    runtimeSemverChanged: false,
    activationBoundary: 'non-runtime-capability',
    authority: 'non_authoritative',
    gateEvidence: false,
    notes: ['Canonical append-only verifier self-test.'],
  };
}
