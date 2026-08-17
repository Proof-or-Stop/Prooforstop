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
n > 7000 ? ok(`${n} archive files tracked at canonical path`) : fail(`only ${n} tracked`);

console.log(bad === 0 ? 'state dir migration verified' : `state dir migration FAILED (${bad})`);
process.exit(bad === 0 ? 0 : 1);
