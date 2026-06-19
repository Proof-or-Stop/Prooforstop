/**
 * Smoke: parallel-decomposition-overlap (Story 1 / B-4033).
 *
 * Exercises the static overlap engine (§4.2): literal overlap, tier-2 dir-prefix
 * over-flag, BROAD classification + broadSide attribution, disjoint sets, and write-set
 * grammar rejection. Exits non-zero (throws) on any failed assertion — never a silent pass.
 *
 * Run: node packages/main/dist/tasks/parallel-decomposition-overlap-smoke.js
 */

import {
  computeWriteSet,
  globsOverlap,
  validateWriteSetGrammar,
  classifyBroadness,
} from '../core/parallel-decomposition-overlap.js';
import type { ScopeContractData } from '../core/types.js';

let passed = 0;
function check(name: string, cond: boolean): void {
  if (!cond) throw new Error(`FAIL: ${name}`);
  passed += 1;
}

// 1. computeWriteSet unions allowedModify + allowedCreate, deduped (allowedTest excluded).
const contract = {
  storyId: 'B-test',
  allowedModify: ['src/csv/impl/parser.ts', 'src/csv/impl/parser.ts'],
  allowedCreate: ['src/csv/impl/parser.test.ts'],
  allowedTest: ['src/csv/impl/parser.test.ts'],
} as unknown as ScopeContractData;
const ws = computeWriteSet(contract);
check('computeWriteSet unions + dedupes', ws.length === 2 && ws.includes('src/csv/impl/parser.ts') && ws.includes('src/csv/impl/parser.test.ts'));

// 2. tier-1 literal overlap → overlap=true with the colliding pair.
const litA = ['src/csv/impl/parser.ts', 'src/csv/contract.ts'];
const litB = ['src/csv/impl/parser.ts'];
const r1 = globsOverlap(litA, litB);
check('literal overlap detected', r1.overlap === true);
check('literal overlap pair correct', r1.pairs.some(([x, y]) => x === 'src/csv/impl/parser.ts' && y === 'src/csv/impl/parser.ts'));
check('literal overlap not broad', r1.broadSide === null);

// 3. disjoint write-sets → no overlap.
const r2 = globsOverlap(['src/csv/impl/parser.ts'], ['src/csv/impl/writer.ts']);
check('disjoint literals: no overlap', r2.overlap === false && r2.pairs.length === 0);

// 4. tier-2 shared-dir-prefix over-flag: dir/* vs a literal child of dir.
const r3 = globsOverlap(['src/csv/impl/*'], ['src/csv/impl/parser.ts']);
check('children-glob vs child literal overlaps', r3.overlap === true);
// dir/* vs a literal NOT a direct child must not over-claim.
const r3b = globsOverlap(['src/csv/impl/*'], ['src/csv/other/deep/x.ts']);
check('children-glob vs unrelated literal: no overlap', r3b.overlap === false);

// 5. subtree vs literal under it overlaps; sibling subtree does not.
const r4 = globsOverlap(['src/csv/**'], ['src/csv/impl/parser.ts']);
check('subtree vs nested literal overlaps', r4.overlap === true);
const r4b = globsOverlap(['src/csv/**'], ['src/json/parser.ts']);
check('subtree vs sibling tree: no overlap', r4b.overlap === false);

// 6. BROAD classification + broadSide attribution.
check('dir/** at root is BROAD', classifyBroadness('src/**') === 'broad');
check('dir/* at root is NARROW (bounded)', classifyBroadness('src/*') === 'narrow');
check('deep dir/** is NARROW', classifyBroadness('src/csv/impl/**') === 'narrow');
check('literal is NARROW', classifyBroadness('src/csv/parser.ts') === 'narrow');
const r5 = globsOverlap(['src/**'], ['src/csv/parser.ts']);
check('broadSide=a when only A is broad', r5.broadSide === 'a');
const r6 = globsOverlap(['src/csv/parser.ts'], ['lib/**']);
check('broadSide=b when only B is broad', r6.broadSide === 'b');
const r7 = globsOverlap(['src/**'], ['lib/**']);
check('broadSide=both when both broad', r7.broadSide === 'both');

// 7. grammar validator: literal / dir/* / dir/** valid; mid-path ** and bare * rejected.
const good = validateWriteSetGrammar(['src/a.ts', 'src/dir/*', 'src/dir/**']);
check('valid grammar accepted', good.ok === true && good.invalid.length === 0);
const bad = validateWriteSetGrammar(['src/**/*.ts', '*', 'src/x.ts']);
check('mid-path ** rejected', bad.invalid.some((i) => i.entry === 'src/**/*.ts'));
check('bare * rejected', bad.invalid.some((i) => i.entry === '*'));
check('grammar rejects exactly the 2 bad entries', !bad.ok && bad.invalid.length === 2);

// 8. empty-directory wildcards are rejected (a root-wide scope must not slip through).
const empties = validateWriteSetGrammar(['/*', '/**']);
check('empty-dir /* rejected', empties.invalid.some((i) => i.entry === '/*'));
check('empty-dir /** rejected', empties.invalid.some((i) => i.entry === '/**'));
check('classifyBroadness(/*) is broad', classifyBroadness('/*') === 'broad');
check('classifyBroadness(/**) is broad', classifyBroadness('/**') === 'broad');

// 9. tier-2 shared-prefix collisions for children globs (must NOT under-flag).
check('children vs nested children (src/* vs src/csv/*) overlaps', globsOverlap(['src/*'], ['src/csv/*']).overlap === true);
check('children vs deep literal under it overlaps', globsOverlap(['src/csv/*'], ['src/csv/impl/parser.ts']).overlap === true);
check('children vs children same dir overlaps', globsOverlap(['src/csv/*'], ['src/csv/*']).overlap === true);
check('children vs children sibling dirs: no overlap', globsOverlap(['src/a/*'], ['src/b/*']).overlap === false);
check('children vs subtree nested overlaps', globsOverlap(['src/csv/*'], ['src/**']).overlap === true);
check('subtree vs subtree nested overlaps', globsOverlap(['src/csv/**'], ['src/**']).overlap === true);
check('subtree vs subtree sibling: no overlap', globsOverlap(['src/csv/**'], ['lib/**']).overlap === false);

// 10. computeWriteSet excludes allowedTest (only modify + create are write targets).
const c2 = { storyId: 'B-t', allowedModify: ['src/a.ts'], allowedCreate: ['src/a.create.ts'], allowedTest: ['src/a.test.ts'] } as unknown as ScopeContractData;
const ws2 = computeWriteSet(c2);
check('computeWriteSet excludes allowedTest', ws2.length === 2 && !ws2.includes('src/a.test.ts'));

// 11. single-segment root literals participate in wildcard overlap (literal IS the dir).
check('root literal vs its children-glob (docs vs docs/*) overlaps', globsOverlap(['docs'], ['docs/*']).overlap === true);
check('root literal vs its subtree (docs vs docs/**) overlaps', globsOverlap(['docs'], ['docs/**']).overlap === true);
check('distinct root file vs unrelated dir-glob (README.md vs README/*): no overlap', globsOverlap(['README.md'], ['README/*']).overlap === false);

// 12. redundant path segments canonicalize so equivalent paths collide (no missed overlap).
check('src/./a.ts vs src/a.ts overlaps (canonicalized)', globsOverlap(['src/./a.ts'], ['src/a.ts']).overlap === true);
check('src//a.ts vs src/a.ts overlaps (canonicalized)', globsOverlap(['src//a.ts'], ['src/a.ts']).overlap === true);
const c3 = { storyId: 'B-t', allowedModify: ['src/./a.ts'], allowedCreate: ['src//a.ts'] } as unknown as ScopeContractData;
check('computeWriteSet dedupes redundant-but-equal paths', computeWriteSet(c3).length === 1);

console.log(`parallel-decomposition-overlap smoke passed: ${passed} assertions`);
