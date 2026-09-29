
import { readFileSync } from 'node:fs';

import { resolve } from 'node:path';






import { validateReviewedDataSources } from ".././identity-reviewed-json-contexts.mjs";
import { validateReviewedFixtureSources } from ".././identity-reviewed-fixture-contexts.mjs";
import { validateReviewedSourceSources } from ".././identity-reviewed-source-contexts.mjs";
import { MAINTENANCE_SCHEMA_PROVENANCE_ROWS, MAINTENANCE_SCHEMA_WITNESSES } from ".././identity-maintenance-boundaries.mjs";
import { IMPORTED_HISTORY_CONTEXT_SOURCES, IMPORTED_HISTORY_CONTEXT_ROWS } from "./history-contexts.mjs";
import { git, sha256, countLiteral, occurrenceContextDigest, readTrackedText } from "./repository.mjs";
import { IMPORTED_RELEASE_SOURCE_COMMIT } from "./provenance-data.mjs";
import { MODULAR_WITNESS_CLOSURES, INTEGRATION_ROOT_HISTORY_CONTEXT, REVIEWED_NEGATIVE_SOURCE_INTEGRITY, BOTH_FAMILY_CONTEXT_ROWS, BOTH_FAMILY_CONTEXT_WITNESSES, OWNED_IDENTITY_MUTATION_CONTEXT_ROWS } from "./reviewed-contexts.mjs";
import { IMPORTED_DENY_CONTEXT_ROWS } from "./deny-contexts.mjs";
import { FINAL_NEGATIVE_CONTEXT_ROWS } from "./negative-contexts.mjs";
import { RUNTIME_DENY_CONTEXT_ROWS } from "./runtime-contexts.mjs";
import { TOKEN_PATTERN } from "./active-scan.mjs";
import { SCANNER_RETIRED_LINE_CONTEXTS, SCANNER_SOURCE_PATHS } from "./scanner-contexts.mjs";
import { NEGATIVE_SCHEMA_WITNESSES, NEGATIVE_SCHEMA_ROWS, CURRENT_COMPATIBLE_SCHEMA_ROWS } from "./schema-data.mjs";

export function verifyImportedHistoryContexts(root, sources = IMPORTED_HISTORY_CONTEXT_SOURCES, rows = IMPORTED_HISTORY_CONTEXT_ROWS) {
  const errors = [];
  const paths = new Set(sources.map(source => source.path));
  if (sources.length !== 11 || paths.size !== 11) errors.push('imported historical contexts require exactly 11 unique source paths');
  for (const row of rows) if (!paths.has(row.path)) errors.push(`historical context has no imported source: ${row.path}`);
  for (const source of sources) {
    try {
      const oid = git(['rev-parse', `${IMPORTED_RELEASE_SOURCE_COMMIT}:${source.path}`], { cwd: root }).trim();
      if (oid !== source.gitBlobOid) errors.push(`historical context source commit/path binding changed: ${source.path}`);
      const text = git(['cat-file', 'blob', source.gitBlobOid], { cwd: root });
      if (sha256(text) !== source.sha256) errors.push(`historical context source bytes changed: ${source.path}`);
      for (const row of rows.filter(row => row.path === source.path)) {
        if (countLiteral(text, row.token) !== row.expectedOccurrences || occurrenceContextDigest(text, row.token) !== row.contextSha256) {
          errors.push(`historical context does not match imported source: ${row.id}`);
        }
      }
    } catch { errors.push(`historical context source unavailable: ${source.path}`); }
  }
  return errors;
}

export function verifyIntegrationRootHistoryContext(root, row = INTEGRATION_ROOT_HISTORY_CONTEXT, readText = path => readTrackedText(root, path)) {
  try {
    const text = readText(row.path);
    if (row.path !== INTEGRATION_ROOT_HISTORY_CONTEXT.path
      || countLiteral(text, row.token) !== row.expectedOccurrences
      || occurrenceContextDigest(text, row.token) !== row.contextSha256) {
      return ['integration root current quotation context changed'];
    }
    return [];
  } catch { return ['integration root current quotation unavailable']; }
}

export function verifyReviewedNegativeSourceIntegrity(root, readText = path => readFileSync(resolve(root, path), 'utf8')) {
  const errors = [];
  const requiredPaths = new Set([...IMPORTED_DENY_CONTEXT_ROWS, ...FINAL_NEGATIVE_CONTEXT_ROWS, ...RUNTIME_DENY_CONTEXT_ROWS]
    .map(row => row.path).filter(path => path.startsWith('packages/main/tests/') || path.startsWith('packages/main/src/tasks/') || path.startsWith('scripts/')));
  requiredPaths.add('packages/main/src/core/runtime-environment-checks.ts');
  for (const paths of Object.values(MODULAR_WITNESS_CLOSURES)) for (const path of paths) requiredPaths.add(path);
  const seen = new Set();
  for (const pin of REVIEWED_NEGATIVE_SOURCE_INTEGRITY) {
    if (seen.has(pin.path) || !requiredPaths.has(pin.path)) errors.push(`negative source integrity duplicate/unlisted path: ${pin.path}`);
    seen.add(pin.path);
    if (sha256(readText(pin.path)) !== pin.sha256) errors.push(`reviewed negative source integrity changed: ${pin.path}`);
  }
  for (const path of requiredPaths) if (!seen.has(path)) errors.push(`reviewed negative source integrity missing: ${path}`);
  return errors;
}

export function verifyBothFamilyContexts(root, readText = path => readTrackedText(root, path)) {
  const errors = [];
  if (BOTH_FAMILY_CONTEXT_ROWS.length !== 75) errors.push('both-family exact context inventory count drift');
  const expectedPaths = new Set(BOTH_FAMILY_CONTEXT_ROWS.map(row => row.path).filter(path => !path.endsWith('.md')));
  const seen = new Set();
  for (const pin of BOTH_FAMILY_CONTEXT_WITNESSES) {
    if (seen.has(pin.path) || !expectedPaths.has(pin.path)) errors.push(`both-family witness duplicate/unlisted: ${pin.path}`);
    seen.add(pin.path);
    if (sha256(readText(pin.path)) !== pin.sha256) errors.push(`both-family witness integrity changed: ${pin.path}`);
  }
  for (const path of expectedPaths) if (!seen.has(path)) errors.push(`both-family witness missing: ${path}`);
  // Check every preserved quotation/negative input against its exact current
  // count and context. The former pre-repair Git object is unavailable; this
  // check claims current byte integrity, not authentication of that old snapshot.
  for (const row of BOTH_FAMILY_CONTEXT_ROWS) {
    const text = readText(row.path);
    if (countLiteral(text, row.token) !== row.expectedOccurrences || occurrenceContextDigest(text, row.token) !== row.contextSha256) {
      errors.push(`both-family current source context mismatch: ${row.path}`);
    }
  }
  return errors;
}

export function verifyScannerRetiredContexts(text, path = SCANNER_SOURCE_PATHS[0]) {
  if (!SCANNER_SOURCE_PATHS.includes(path)) return [`scanner unregistered source path: ${path}`];
  const counts = new Map();
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if ([...line.matchAll(TOKEN_PATTERN)].length === 0) continue;
    const digest = sha256(line);
    const positions = counts.get(digest) ?? [];
    positions.push(index + 1);
    counts.set(digest, positions);
  }
  const rows = SCANNER_RETIRED_LINE_CONTEXTS.filter(([sourcePath]) => sourcePath === path);
  const expected = new Map(rows.map(([, digest, count, positions]) => [digest, { count, positions }]));
  const errors = [];
  if (expected.size !== rows.length) errors.push('scanner negative line inventory duplicated');
  for (const [digest, positions] of counts) {
    const pin = expected.get(digest);
    if (!pin || pin.count !== positions.length || JSON.stringify(pin.positions) !== JSON.stringify(positions)) errors.push(`scanner unclassified, duplicated or relocated retired context: ${digest}`);
  }
  for (const [digest, pin] of expected) if (JSON.stringify(counts.get(digest)) !== JSON.stringify(pin.positions)) errors.push(`scanner retired context missing, changed or relocated: ${digest}`);
  return errors;
}

export function verifyNegativeSchemaWitnesses(root, readText = path => readFileSync(resolve(root, path), 'utf8')) {
  const errors = [];
  for (const witness of NEGATIVE_SCHEMA_WITNESSES) {
    if (sha256(readText(witness.path)) !== witness.sha256) errors.push(`negative schema witness changed: ${witness.path}`);
  }
  return errors;
}

export function verifySchemaInventory(root, schemas) {
  const errors = verifyNegativeSchemaWitnesses(root);
  const key = row => `${row.path}\0${row.token}`;
  const negativeKeys = new Set(NEGATIVE_SCHEMA_ROWS.map(key));
  if (NEGATIVE_SCHEMA_ROWS.length !== 18 || negativeKeys.size !== 18) errors.push('negative schema inventory must have exactly 18 unique rows');
  for (const pin of NEGATIVE_SCHEMA_ROWS) {
    const matches = schemas.filter(row => key(row) === key(pin));
    if (matches.length !== 1 || matches[0].count !== pin.count || matches[0].contextSha256 !== pin.contextSha256) {
      errors.push(`negative schema exact occurrence changed: ${pin.path} ${pin.token}`);
    }
  }
  // These seven queue/snapshot/proof/quantum schemas are mutation inputs only.
  // Keep the original 29 and the independently reviewed 18 fixture rows intact.
  const mutationSchemas = OWNED_IDENTITY_MUTATION_CONTEXT_ROWS.filter(row => /^lattice\..*\.v\d+$/u.test(row.token));
  if (mutationSchemas.length !== 7) errors.push('owned mutation schema inventory must contain exactly seven queue/snapshot/proof/quantum controls');
  for (const pin of mutationSchemas) {
    const matches = schemas.filter(row => key(row) === key(pin));
    if (matches.length !== 1 || matches[0].count !== pin.expectedOccurrences || matches[0].contextSha256 !== pin.contextSha256) {
      errors.push(`owned mutation schema exact occurrence changed: ${pin.path} ${pin.token}`);
    }
  }
  const mutationKeys = new Set(mutationSchemas.map(key));
  const maintainedKeys = new Set(MAINTENANCE_SCHEMA_PROVENANCE_ROWS.map(key));
  for (const pin of MAINTENANCE_SCHEMA_PROVENANCE_ROWS) {
    const matches = schemas.filter(row => key(row) === key(pin));
    if (matches.length !== 1 || matches[0].count !== pin.expectedOccurrences || matches[0].contextSha256 !== pin.contextSha256) errors.push(`archived candidate schema descriptor changed: ${pin.path}`);
  }
  for (const pin of MAINTENANCE_SCHEMA_WITNESSES) if (sha256(readFileSync(resolve(root, pin.path))) !== pin.sha256) errors.push(`archived candidate source witness changed: ${pin.path}`);
  const originalRows = schemas.filter(row => !negativeKeys.has(key(row)) && !mutationKeys.has(key(row)) && !maintainedKeys.has(key(row)));
  const expected = new Map(CURRENT_COMPATIBLE_SCHEMA_ROWS.map(row => [key(row), row]));
  if (expected.size !== CURRENT_COMPATIBLE_SCHEMA_ROWS.length || expected.size !== 110) errors.push('current compatibility schema inventory duplicated or incomplete');
  const actual = new Map();
  for (const row of originalRows) {
    const id = key(row), pin = expected.get(id);
    if (actual.has(id) || !pin || row.count !== pin.count || row.contextSha256 !== pin.contextSha256) errors.push(`current compatibility schema changed or unregistered: ${row.path} ${row.token}`);
    actual.set(id, row);
  }
  for (const id of expected.keys()) if (!actual.has(id)) errors.push(`current compatibility schema missing: ${id}`);

  return errors;
}

export const REVIEWED_CONTEXT_READERS = [
  {
    "path": "scripts/identity-reviewed-source-contexts.mjs",
    "sha256": "3bfe59a70c11da26576e0bae929c86d45fa6c23c4ffb5c58b51e8c0a8a0b613f"
  },
  {
    "path": "scripts/identity-reviewed-json-contexts.mjs",
    "sha256": "b2d41286d5c10a46e16eee198880600ea6fa64d4a7833daa770beeb155bb7e35"
  },
  {
    "path": "scripts/identity-reviewed-fixture-contexts.mjs",
    "sha256": "2e19881483fd1be60c1154e09782730c31c35118e2e3e088551ef07e027de360"
  }
];

export function verifyReviewedContextReaders(root) {
  const errors = [];
  for (const row of REVIEWED_CONTEXT_READERS) {
    try { if (sha256(readFileSync(resolve(root, row.path))) !== row.sha256) errors.push(`reviewed context reader changed: ${row.path}`); }
    catch { errors.push(`reviewed context reader missing: ${row.path}`); }
  }
  return [...errors, ...validateReviewedDataSources(path => readTrackedText(root, path)), ...validateReviewedSourceSources(path => readTrackedText(root, path)), ...validateReviewedFixtureSources(path => readTrackedText(root, path))];
}
