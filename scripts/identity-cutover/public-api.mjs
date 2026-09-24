import './bootstrap.mjs';
import { EXPECTED_EXACT_ALLOWLIST_COUNT } from './scanner-contexts.mjs';













import { MAINTENANCE_SCHEMA_WITNESSES } from ".././identity-maintenance-boundaries.mjs";
import { EXACT_ALLOWLIST, CURRENT_LEGACY_CONTEXT_ROWS } from "./base-contexts.mjs";
import { CURRENT_COMPATIBLE_SCHEMA_ROWS, NEGATIVE_SCHEMA_ROWS, NEGATIVE_SCHEMA_WITNESSES } from "./schema-data.mjs";
import { REVIEWED_NEGATIVE_SOURCE_INTEGRITY } from "./reviewed-contexts.mjs";

export function identityCutoverReviewedContexts() {
  if (EXACT_ALLOWLIST.length !== EXPECTED_EXACT_ALLOWLIST_COUNT) {
    throw new Error(`Incomplete identity context assembly: ${EXACT_ALLOWLIST.length}, expected ${EXPECTED_EXACT_ALLOWLIST_COUNT}`);
  }
  return {
    rows: [...EXACT_ALLOWLIST, ...[...CURRENT_COMPATIBLE_SCHEMA_ROWS, ...NEGATIVE_SCHEMA_ROWS].map(row => ({ ...row, expectedOccurrences: row.count }))].map(row => ({ ...row })),
    witnesses: [...REVIEWED_NEGATIVE_SOURCE_INTEGRITY, ...NEGATIVE_SCHEMA_WITNESSES, ...MAINTENANCE_SCHEMA_WITNESSES,
      ...CURRENT_LEGACY_CONTEXT_ROWS.filter(row => row.sourceSha256).map(row => ({ path: row.path, sha256: row.sourceSha256 })),
    ].filter((row, index, rows) => rows.findIndex(other => other.path === row.path && other.sha256 === row.sha256) === index)
      .map(({ path, sha256 }) => ({ path, sha256 })),
  };
}
