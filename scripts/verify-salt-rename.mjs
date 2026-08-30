#!/usr/bin/env node
/**
 * fbca-salt-rename-check.mjs — proves the 8 koala-* → proof-or-stop-* salt rename
 * is consistent across the product runtime source + scripts.
 *
 * For each of the 8 salts: assert
 *   git grep -c 'koala-<salt>'   in packages/** + scripts/**  === 0   (old gone)
 *   git grep -c 'proof-or-stop-<salt>' in packages/** + scripts/**  >= 1     (new present)
 * Exit 0 = consistent rename; exit 1 = any inconsistency.
 */
import { execFileSync } from 'node:child_process';

const SALTS = [
  'review-integrity-v1',
  'review-pass-integrity-v1',
  'review-run-integrity-v1',
  'review-run-workspace-binding-v1',
  'review-scope-binding-v1',
  'scope-check-integrity-v1',
  'finding-integrity-v1',
  'story-store',
];

// CHK-001 scope: the live salt VALUES live in product runtime source
// (packages/<pkg>/src) and the residue gate script. Test fixtures under
// packages/main/tests/fixtures/*.json embed throwaway test repos that
// legitimately use `.koala/` paths + a `koala` helper var and are NOT the
// live salts — they are intentionally out of the rename scope.
const PATHSPEC = [
  '--',
  'packages/main/src/',
  'packages/lab/src/',
  'packages/utils/src/',
  'scripts/',
];

/** git grep -c <pat>; returns total match count across files (0 when no match). */
function grepCount(pat) {
  try {
    const out = execFileSync('git', ['grep', '-c', pat, ...PATHSPEC], { encoding: 'utf8' });
    // -c prints "path:count" per file; sum the counts.
    return out
      .split('\n')
      .filter(Boolean)
      .reduce((acc, line) => acc + Number(line.slice(line.lastIndexOf(':') + 1) || 0), 0);
  } catch (e) {
    // git grep exits 1 when there are zero matches.
    if (e.status === 1) return 0;
    throw e;
  }
}

let failed = false;
for (const salt of SALTS) {
  const oldHits = grepCount(`koala-${salt}`);
  const newHits = grepCount(`proof-or-stop-${salt}`);
  const ok = oldHits === 0 && newHits >= 1;
  if (!ok) failed = true;
  console.log(
    `${ok ? 'OK  ' : 'FAIL'} salt ${salt}: koala-=${oldHits} (want 0), proof-or-stop-=${newHits} (want >=1)`,
  );
}

if (failed) {
  console.error('\nFAIL salt-rename: at least one salt is not consistently renamed.');
  process.exit(1);
}
console.log(`\nPASS salt-rename: all ${SALTS.length} salts renamed koala-* -> proof-or-stop-* (old gone, new present).`);
process.exit(0);
