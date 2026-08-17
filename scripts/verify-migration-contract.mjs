#!/usr/bin/env node
/**
 * B-cc10 witness for CHK-001 (migration contract doc) and CHK-008 (abort path).
 *
 * Both items were executed by the main agent during the convergence-breaker
 * freeze. This script turns their acceptance criteria into mechanical checks so
 * they rest on receipts rather than prose.
 */
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const DOC = 'docs/requirements/decisions/proof-or-stop-identity-migration.md';
let bad = 0;
const ok = (m) => console.log(`ok ${m}`);
const fail = (m) => { console.log(`not ok ${m}`); bad++; };

const doc = existsSync(DOC) ? readFileSync(DOC, 'utf8') : '';
if (!doc) fail(`${DOC} missing`);

// CHK-001 happy: the storyFilesHash question is answered in the doc.
const sfh = (doc.match(/storyFilesHash/g) || []).length;
console.log(`storyFilesHashMentions=${sfh}`);
sfh >= 1 ? ok('contract doc answers the storyFilesHash question') : fail('storyFilesHash unanswered');

// CHK-001 edge: EVERY migrated identity carries a verdict. Absence of any row is the failure.
const IDENTS = ['bin/lattice.js', '.lattice/', '.lattice-codex/', 'lattice.config.json',
  'lattice.json', '@lattice/core'];
const missing = IDENTS.filter((id) => !doc.includes(id));
console.log(`identitiesWithoutRow=${missing.length}`);
missing.length === 0
  ? ok(`all ${IDENTS.length} migrated identities carry a verdict row`)
  : fail(`identities with no verdict row: ${missing.join(', ')}`);

// CHK-001 adversarial: a reader cannot conclude a FROZEN row was silently ignored.
const supersessions = /[Ss]upersession/.test(doc)
  && doc.includes('brand-rename-mapping.md:130') && doc.includes('brand-rename-mapping.md:72');
console.log(`supersessionsDocumented=${supersessions}`);
supersessions
  ? ok('both FROZEN supersessions documented with citations, not silently ignored')
  : fail('a FROZEN override lacks an explicit cited supersession');

// CHK-008 happy: archives readable at the canonical path after the real move.
const canon = '.proof-or-stop/story/actives';
const readable = existsSync(`${canon}/B-0168/index.json`);
console.log(`archivesReadableAfterMove=${readable}`);
readable ? ok('archives readable at canonical path after the move') : fail('archives unreadable');

// CHK-008 edge: the half-done detector. Exactly one state dir may exist.
// A half-done MOVE means TRACKED files still sit under the deprecated dir. A
// deprecated dir holding only gitignored runtime artifacts is not half-done: the
// CLI recreates activity.jsonl on any invocation against an older layout. B-cc10's
// first CHK-003 attempt conflated these and the confusion cost a full abort, so the
// discriminator is tracked-file count, not directory existence.
const strayTracked = execFileSync('git', ['ls-files', '.lattice'], { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean).length;
console.log(`deprecatedDirTrackedFiles=${strayTracked}`);
strayTracked === 0
  ? ok('no tracked files remain under the deprecated state dir (move is complete)')
  : fail(`${strayTracked} tracked files still under .lattice — half-done move, abort`);

// CHK-008 adversarial: the move was ONE commit whose renames are pure, so one revert undoes it.
// Find the state-dir move commit by SUBJECT, not by path filter. A path filter on
// the canonical dir misses it: that commit recorded its renames under a nested
// path (the first attempt's mv landed inside an existing dir), which is exactly the
// defect the follow-up commit corrected.
const moveSha = execFileSync('git',
  ['log', '--format=%H', '--grep=CHK-003: move state dirs', '-1'], { encoding: 'utf8' }).trim();
const stat = moveSha
  ? execFileSync('git', ['show', '--shortstat', '--format=', moveSha], { encoding: 'utf8' })
  : '';
const pure = /0 insertions/.test(stat) && /0 deletions/.test(stat);
console.log(`moveIsPureRenameCommit=${pure}`);
pure
  ? ok(`move commit ${moveSha.slice(0, 8)} is pure rename (0 insertions, 0 deletions) — one revert undoes it`)
  : fail(`move commit is not a pure rename: ${stat.trim()}`);

console.log(bad === 0 ? 'migration contract verified' : `migration contract FAILED (${bad})`);
process.exit(bad === 0 ? 0 : 1);
