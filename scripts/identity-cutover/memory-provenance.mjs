
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';





import { inspectDevMemoryFinishDecision, readDevMemoryFinishDecision } from "../../packages/main/dist/core/playbook-runtime-memory.js";




import { isPlainRecord } from "./release-history.mjs";
import { LEGACY_WORD, RETIRED_PRODUCT_NAME, CONCEPT_PROVENANCE_MANIFEST_PATH, CONCEPT_PROVENANCE_MANIFEST_SHA256, EXPECTED_CONCEPT_PROVENANCE_ROW_COUNT, TRUTH_SOURCE_ENTRYPOINTS } from "./rules.mjs";
import { sha256, git } from "./repository.mjs";
import { MEMORY_IMPORTED_PREFIX_SHA256, IMPORTED_RELEASE_SOURCE_COMMIT, MEMORY_LEDGER_PATH, MEMORY_IMPORTED_PREFIX_BLOB, CONCEPT_PROVENANCE_ROWS, EXPERIMENT_PROVENANCE_ROWS } from "./provenance-data.mjs";
import { currentTruthSourcePaths, isConceptProvenancePath } from "./guidance.mjs";
import { isFrozenSurface } from "./schema-scan.mjs";
import { scanActiveResidue } from "./active-scan.mjs";

export function memorySuffixRecordErrors(value) {
  if (!isPlainRecord(value)) return ['memory record must be an object'];
  const errors = [];
  for (const [field, min] of [['id', 7], ['createdAt', 1], ['sourceAgent', 1], ['summary', 10], ['trigger', 5], ['lesson', 10], ['reusePrompt', 5]]) {
    if (typeof value[field] !== 'string' || value[field].trim().length < min) errors.push(`memory record ${field} is invalid`);
  }
  if (Number.isNaN(Date.parse(value.createdAt))) errors.push('memory record createdAt is invalid');
  if (!['failure-mode', 'pattern', 'anti-pattern', 'workflow', 'tool-quirk', 'guard-bypass', 'debugging', 'communication', 'other'].includes(value.category)) errors.push('memory record category is invalid');
  if (!['project', 'global', 'story-candidate'].includes(value.scope)) errors.push('memory record scope is invalid');
  if (value.authority !== 'non_authoritative' || value.gateEvidence !== false) errors.push('memory record authority must remain non-authoritative');
  for (const field of ['tags', 'evidenceRefs']) {
    if (value[field] !== undefined && (!Array.isArray(value[field]) || value[field].some((entry) => typeof entry !== 'string'))) errors.push(`memory record ${field} is invalid`);
  }
  const retired = new RegExp(`(?:^|[^a-z0-9])(?:${LEGACY_WORD}|${RETIRED_PRODUCT_NAME})(?=$|[^a-z0-9])`, 'iu');
  const hasRetiredIdentity = (entry) => {
    if (typeof entry === 'string') return retired.test(entry);
    if (Array.isArray(entry)) return entry.some(hasRetiredIdentity);
    return isPlainRecord(entry) && Object.entries(entry).some(([key, item]) => retired.test(key) || hasRetiredIdentity(item));
  };
  if (hasRetiredIdentity(value)) errors.push('memory record contains a retired identity');
  return errors;
}

export function verifyMemoryLedgerBytes(row, originalPrefix, importedPrefix, currentBytes) {
  const errors = [];
  if (sha256(originalPrefix) !== row.byteSha256 || !importedPrefix.subarray(0, originalPrefix.length).equals(originalPrefix)) errors.push('memory provenance: original immutable prefix byte sha256 changed');
  if (sha256(importedPrefix) !== MEMORY_IMPORTED_PREFIX_SHA256) errors.push('memory provenance: imported prefix digest changed');
  if (!currentBytes.subarray(0, importedPrefix.length).equals(importedPrefix)) errors.push('memory provenance: imported immutable prefix changed');
  if (errors.length) return errors;
  const suffix = currentBytes.subarray(importedPrefix.length);
  if (!suffix.length) return errors;
  if (importedPrefix.at(-1) !== 0x0a || suffix.at(-1) !== 0x0a) return ['memory provenance: appended JSONL suffix is truncated'];
  const text = suffix.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(suffix)) return ['memory provenance: appended JSONL suffix is not valid UTF-8'];
  const ids = new Set(importedPrefix.toString('utf8').trimEnd().split('\n').map((line) => JSON.parse(line).id));
  for (const line of text.slice(0, -1).split('\n')) {
    try {
      const record = JSON.parse(line);
      errors.push(...memorySuffixRecordErrors(record));
      if (ids.has(record?.id)) errors.push(`memory provenance: duplicate appended record ${record.id}`);
      ids.add(record?.id);
    } catch {
      errors.push('memory provenance: appended record is invalid JSON');
    }
  }
  return errors;
}

export function verifyMemoryLedger(root, row) {
  try {
    if (git(['rev-parse', `${IMPORTED_RELEASE_SOURCE_COMMIT}:${MEMORY_LEDGER_PATH}`], { cwd: root }).trim() !== MEMORY_IMPORTED_PREFIX_BLOB) return ['memory provenance: source commit/path blob changed'];
    return verifyMemoryLedgerBytes(row,
      git(['cat-file', 'blob', row.gitBlobOid], { cwd: root, encoding: null }),
      git(['cat-file', 'blob', MEMORY_IMPORTED_PREFIX_BLOB], { cwd: root, encoding: null }),
      readFileSync(resolve(root, MEMORY_LEDGER_PATH)));
  } catch {
    return ['memory provenance: exact source commit/blob unavailable'];
  }
}

export function verifyConceptProvenance(root, tracked, rows = CONCEPT_PROVENANCE_ROWS) {
  const errors = [];
  const currentTruthSources = currentTruthSourcePaths(root);
  const manifestBytes = readFileSync(resolve(root, CONCEPT_PROVENANCE_MANIFEST_PATH));
  if (sha256(manifestBytes) !== CONCEPT_PROVENANCE_MANIFEST_SHA256) {
    errors.push('concept provenance: manifest byte digest changed');
  }
  if (rows.length !== EXPECTED_CONCEPT_PROVENANCE_ROW_COUNT) {
    errors.push(`concept provenance: row count ${rows.length}, expected ${EXPECTED_CONCEPT_PROVENANCE_ROW_COUNT}`);
  }
  const paths = new Set();
  for (const row of rows) {
    if (!['provenance_bytes', 'compatibility_fixture'].includes(row.class)) {
      errors.push(`concept provenance ${row.path || '<missing>'}: invalid class`);
    }
    if (!row.path || isAbsolute(row.path) || row.path.endsWith('/') || row.path.includes('..') || /[*?\[\]{}]/u.test(row.path)
      || !isConceptProvenancePath(row.path)) {
      errors.push(`concept provenance ${row.path || '<missing>'}: path must be one exact eligible file`);
      continue;
    }
    if (paths.has(row.path)) errors.push(`concept provenance ${row.path}: duplicate exact path`);
    paths.add(row.path);
    if (currentTruthSources.has(row.path)) {
      errors.push(`concept provenance ${row.path}: current truth source cannot be frozen as whole-file provenance`);
    }
    if (!tracked.has(row.path) || statSync(resolve(root, row.path)).isDirectory()) {
      errors.push(`concept provenance ${row.path}: stale/missing tracked file`);
      continue;
    }
    if (!/^[a-f0-9]{40}$/u.test(row.gitBlobOid || '') || !/^[a-f0-9]{64}$/u.test(row.byteSha256 || '')) {
      errors.push(`concept provenance ${row.path}: invalid exact digest`);
      continue;
    }
    if (row.path === MEMORY_LEDGER_PATH) {
      errors.push(...verifyMemoryLedger(root, row));
      continue;
    }
    const actualOid = git(['hash-object', '--', row.path], { cwd: root }).trim();
    const actualSha = sha256(readFileSync(resolve(root, row.path)));
    if (actualOid !== row.gitBlobOid) errors.push(`concept provenance ${row.path}: Git blob digest changed`);
    if (actualSha !== row.byteSha256) errors.push(`concept provenance ${row.path}: byte sha256 changed`);
  }
  return errors;
}

export function isProtectedExperimentPath(path) {
  return path.startsWith('experiments/baselines/') || path.startsWith('experiments/recovery-runner/');
}

export function deriveExperimentProvenanceRow(root, path) {
  const text = readFileSync(resolve(root, path), 'utf8');
  return {
    class: 'provenance_bytes',
    path,
    gitBlobOid: git(['hash-object', '--', path], { cwd: root }).trim(),
    byteSha256: sha256(Buffer.from(text)),
  };
}

export function verifyExperimentProvenance(root, files, rows = EXPERIMENT_PROVENANCE_ROWS) {
  const errors = [];
  const actualPaths = files.filter(isProtectedExperimentPath).sort();
  const expectedPaths = rows.map((row) => row.path).sort();
  if (new Set(expectedPaths).size !== expectedPaths.length) errors.push('experiment provenance: duplicate exact file row');
  for (const path of actualPaths) if (!expectedPaths.includes(path)) errors.push(`experiment provenance: missing exact file row ${path}`);
  for (const path of expectedPaths) if (!actualPaths.includes(path)) errors.push(`experiment provenance: stale exact file row ${path}`);
  for (const row of rows) {
    if (row.class !== 'provenance_bytes') errors.push(`experiment provenance ${row.path}: invalid class`);
    if (!row.path || isAbsolute(row.path) || /[*?\[\]{}]/u.test(row.path) || !isProtectedExperimentPath(row.path)) {
      errors.push(`experiment provenance ${row.path || '<missing>'}: path must be one exact protected file`);
      continue;
    }
    if (!actualPaths.includes(row.path)) continue;
    const actual = deriveExperimentProvenanceRow(root, row.path);
    if (actual.gitBlobOid !== row.gitBlobOid) errors.push(`experiment provenance ${row.path}: Git blob digest changed`);
    if (actual.byteSha256 !== row.byteSha256) errors.push(`experiment provenance ${row.path}: byte sha256 changed`);
  }
  return errors;
}

export function verifyImportedFinishDecisionBoundary(root, files, path = '.proof-or-stop/dev-memory/finish-decisions/B-8a40.json') {
  const failures = [];

  const originalBytes = readFileSync(resolve(root, path));
  const tracked = new Set(files);
  const exactRow = CONCEPT_PROVENANCE_ROWS.find(row => row.path === path);
  if (exactRow?.class !== 'provenance_bytes' || !isFrozenSurface(path)) {
    failures.push('imported finish decision lacks its exact audit-only provenance row');
  }
  for (const [field, value, diagnostic] of [
    ['gitBlobOid', '0'.repeat(40), 'Git blob digest changed'],
    ['byteSha256', '0'.repeat(64), 'byte sha256 changed'],
  ]) {
    const changedRows = CONCEPT_PROVENANCE_ROWS.map(row => row.path === path ? { ...row, [field]: value } : row);
    if (!verifyConceptProvenance(root, tracked, changedRows).some(error => error.includes(path) && error.includes(diagnostic))) {
      failures.push(`imported finish decision ${field} mutation escaped provenance verification`);
    }
  }
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-finish-decision-boundary-'));
  const neighbor = '.proof-or-stop/dev-memory/finish-decisions/B-unlisted-schema.json';
  try {
    for (const entrypoint of TRUTH_SOURCE_ENTRYPOINTS) {
      mkdirSync(resolve(fixtureRoot, dirname(entrypoint)), { recursive: true });
      writeFileSync(resolve(fixtureRoot, entrypoint), '');
    }
    mkdirSync(resolve(fixtureRoot, dirname(neighbor)), { recursive: true });
    writeFileSync(resolve(fixtureRoot, path), originalBytes);
    const storyId = path.split('/').at(-1).replace(/\.json$/, '');
    const inspected = inspectDevMemoryFinishDecision(fixtureRoot, storyId);
    if (inspected.record !== null || !inspected.unsupportedIdentity || readDevMemoryFinishDecision(fixtureRoot, storyId) !== null) {
      failures.push('historical finish decision escaped the actual canonical reader');
    }
    if (!readFileSync(resolve(fixtureRoot, path)).equals(originalBytes)) failures.push('reader mutated quarantined finish decision');
    writeFileSync(resolve(fixtureRoot, neighbor), JSON.stringify({ schemaVersion: `${RETIRED_PRODUCT_NAME}.dev-memory-finish-decision.v1` }));
    if (isFrozenSurface(neighbor) || !scanActiveResidue(fixtureRoot, [neighbor]).some(hit => hit.path === neighbor)) {
      failures.push('unlisted finish-decisions neighbor escaped the active identity scanner');
    }
    writeFileSync(resolve(fixtureRoot, neighbor), JSON.stringify({ schemaVersion: 'proof-or-stop.dev-memory-finish-decision.v1' }));
    if (scanActiveResidue(fixtureRoot, [neighbor]).length !== 0) {
      failures.push('canonical fresh finish-decision neighbor was misclassified');
    }
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
  if (!readFileSync(resolve(root, path)).equals(originalBytes)) failures.push('historical finish-decision bytes changed during read-only controls');
  return failures;
}
