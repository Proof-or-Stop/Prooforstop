#!/usr/bin/env node
/**
 * B-cc10 CHK-003 witness: the state-directory migration preserved the archives.
 *
 * Asserts on TWO NAMED archives from DIFFERENT ERAS, not one convenient recent
 * story — a single recent archive would pass even if early-era ones were lost.
 *   B-0168                  earliest era (first archive commit 2026-06-22)
 *   B-META-framework-audit  the cross-story finding ledger, signed records
 */
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const ERAS = [
  { id: 'B-0168', expectPhase: 'INIT', why: 'earliest-era archive' },
  { id: 'B-META-framework-audit', expectPhase: 'META', why: 'signed cross-story ledger' },
];
let bad = 0;
const fail = (m) => { console.log(`not ok ${m}`); bad++; };
const ok = (m) => console.log(`ok ${m}`);

// 1. canonical dir is the live one; deprecated must NOT be resurrected as tracked state
const canonicalPresent = existsSync('.proof-or-stop/story/actives');
console.log(`canonicalStateDir=${canonicalPresent}`);
canonicalPresent ? ok('.proof-or-stop/story/actives exists') : fail('canonical state dir missing');

// 2. every named era archive is readable AND its phase matches the pre-move baseline
for (const e of ERAS) {
  const p = `.proof-or-stop/story/actives/${e.id}/index.json`;
  if (!existsSync(p)) { fail(`${e.id} (${e.why}) missing at canonical path`); continue; }
  const phase = JSON.parse(readFileSync(p, 'utf8')).phase;
  console.log(`archive ${e.id} phase=${phase}`);
  phase === e.expectPhase
    ? ok(`${e.id} (${e.why}) phase ${phase} matches pre-move baseline`)
    : fail(`${e.id} phase ${phase} != baseline ${e.expectPhase}`);
}

// 3. the move was a pure rename: history must follow, content must not change
const log = execFileSync('git', ['log', '--follow', '--format=%h', '--',
  '.proof-or-stop/story/actives/B-0168/background.md'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
console.log(`historyFollows=${log.length >= 2}`);
log.length >= 2
  ? ok(`git log --follow traces ${log.length} commits through the rename`)
  : fail('history did not follow the rename');

// 4. archive count preserved
const n = execFileSync('git', ['ls-files', '.proof-or-stop/story/actives'], { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean).length;
console.log(`trackedArchiveFiles=${n}`);
// B-cc10: a STABLE invariant line is emitted AFTER the floor check below, once the result is
// actually known. F-042: it used to print here, unconditionally, BEFORE the check ran — an
// assertion that looked computed but was a literal. That is the same "looks verified but
// isn't" class this story exists to eliminate, so it must be derived, never asserted early.
// B-cc10 F-008: 'n > 7000' was too loose — it would have accepted losing ~580 archive
// files during the move. Derive the floor from the commit BEFORE the move instead of
// hardcoding it, so the check tracks reality rather than a number that rots.
// A floor (not equality) is correct because this story keeps writing its own metadata
// under the canonical dir, so the count legitimately grows after the move.
let preMoveCount = null;
try {
  const moveSha = execFileSync('git', ['log', '--format=%H', '--grep=CHK-003: move state dirs', '-1'],
    { encoding: 'utf8' }).trim();
  if (moveSha) {
    preMoveCount = execFileSync('git', ['ls-tree', '-r', '--name-only', `${moveSha}^`, '.proof-or-stop/story/actives'],
      { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length;
  }
} catch { preMoveCount = null; }
console.log(`preMoveArchiveFiles=${preMoveCount ?? 'unresolved'}`);
if (preMoveCount === null) {
  // Fail closed: without a derivable baseline this check has no discriminating power,
  // so it must not silently pass on the old loose threshold.
  fail('could not derive the pre-move archive count; refusing to pass on a loose threshold');
} else if (n < preMoveCount) {
  fail(`archive files LOST in the move: ${n} tracked now vs ${preMoveCount} before (delta ${n - preMoveCount})`);
} else {
  ok(`${n} archive files tracked at canonical path (>= ${preMoveCount} pre-move; no loss)`);
  // Derived from the check that just passed, so a selector pinned to it means something.
  console.log('archiveFloorHeld=true');
}

console.log(bad === 0 ? 'state dir migration verified' : `state dir migration FAILED (${bad})`);
process.exit(bad === 0 ? 0 : 1);
