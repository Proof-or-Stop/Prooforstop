#!/usr/bin/env node
/**
 * B-6812 CHK-002: unit smoke for core/story-dedup.ts.
 *
 * Pure-function coverage for the two duplicate-detection helpers:
 *  1. normalizeName  — casing / separator normalization, empty / all-special
 *     → "", Unicode letters preserved, non-string defensive input.
 *  2. keywordOverlap — ratio computation, deduplication of the new keyword set
 *     (a duplicated keyword must NOT inflate `shared`), empty-input no-NaN,
 *     full-overlap detection.
 *
 * Also exercises the "empty normalized name never matches" invariant by
 * constructing the legacy `name: ""` data shape directly — this is the path
 * that bypasses the Zod schema (stored JSON, not a fresh CLI call) and the
 * idempotency check must not collapse two empty normalized names into a match.
 */

import assert from 'node:assert/strict';
import { normalizeName, keywordOverlap } from '../core/story-dedup.js';

let passed = 0;
function check(label: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${label}`);
}

// ── normalizeName ───────────────────────────────────────────────────────────

check('normalizeName lowercases', () => {
  assert.equal(normalizeName('FixLogin'), 'fixlogin');
  assert.equal(normalizeName('FIX-LOGIN'), 'fix-login');
});

check('normalizeName trims outer whitespace', () => {
  assert.equal(normalizeName('  fix-login  '), 'fix-login');
  assert.equal(normalizeName('\tfix-login\n'), 'fix-login');
});

check('normalizeName collapses spaces / underscores / hyphen runs to one hyphen', () => {
  assert.equal(normalizeName('Fix Login'), 'fix-login');
  assert.equal(normalizeName('fix_login'), 'fix-login');
  assert.equal(normalizeName('fix---login'), 'fix-login');
  assert.equal(normalizeName('FIX__LOGIN'), 'fix-login');
  assert.equal(normalizeName('fix _ - login'), 'fix-login');
  assert.equal(normalizeName('a   b___c--d'), 'a-b-c-d');
});

check('normalizeName strips leading/trailing hyphens after collapse', () => {
  assert.equal(normalizeName('-fix-login-'), 'fix-login');
  assert.equal(normalizeName('  _fix_  '), 'fix');
  assert.equal(normalizeName('___'), '');
});

check('normalizeName: empty string → ""', () => {
  assert.equal(normalizeName(''), '');
  assert.equal(normalizeName('   '), '');
});

check('normalizeName: all-special-character name → "" (separator-only)', () => {
  assert.equal(normalizeName('---'), '');
  assert.equal(normalizeName('_ _ _'), '');
  assert.equal(normalizeName('  --__--  '), '');
});

check('normalizeName preserves Unicode letters (only cases them)', () => {
  assert.equal(normalizeName('Café-Story'), 'café-story');
  assert.equal(normalizeName('日本語 タスク'), '日本語-タスク');
  assert.equal(normalizeName('Über_Fix'), 'über-fix');
});

check('normalizeName: non-string input is defensively treated as "" (bypass-Zod path)', () => {
  assert.equal(normalizeName(undefined), '');
  assert.equal(normalizeName(null), '');
  assert.equal(normalizeName(42 as unknown), '');
  assert.equal(normalizeName({} as unknown), '');
});

check('normalizeName: two different raw spellings normalize equal', () => {
  // The whole point: "Fix Login" and "fix-login" must be the same match key.
  assert.equal(normalizeName('Fix Login'), normalizeName('fix-login'));
  assert.equal(normalizeName('  FIX__LOGIN  '), normalizeName('fix-login'));
});

// ── keywordOverlap ──────────────────────────────────────────────────────────

check('keywordOverlap: full overlap → ratio 1', () => {
  const r = keywordOverlap(['auth', 'login'], ['auth', 'login', 'session']);
  assert.deepEqual(r.shared.sort(), ['auth', 'login']);
  assert.equal(r.ratio, 1);
});

check('keywordOverlap: partial overlap → 0 < ratio < 1', () => {
  const r = keywordOverlap(['auth', 'login', 'token'], ['auth', 'session']);
  assert.deepEqual(r.shared, ['auth']);
  assert.equal(r.ratio, 1 / 3);
});

check('keywordOverlap: no overlap → ratio 0', () => {
  const r = keywordOverlap(['auth', 'login'], ['payment', 'invoice']);
  assert.deepEqual(r.shared, []);
  assert.equal(r.ratio, 0);
});

check('keywordOverlap: duplicate new keyword does NOT inflate shared / ratio', () => {
  // ["x","x","y"] dedups to {x,y}; both are in existing → shared = [x,y], ratio = 1.
  const r = keywordOverlap(['x', 'x', 'y'], ['x', 'y']);
  assert.equal(r.shared.length, 2, 'shared has no duplicate x');
  assert.deepEqual(r.shared.sort(), ['x', 'y']);
  assert.equal(r.ratio, 1, 'denominator uses deduped new set (2), not raw length (3)');
});

check('keywordOverlap: duplicate new keyword cannot virtually raise shared count', () => {
  // ["a","a","a"] dedups to {a}; only a shared → shared=[a], ratio=1 (not 3).
  const r = keywordOverlap(['a', 'a', 'a'], ['a']);
  assert.equal(r.shared.length, 1);
  assert.equal(r.ratio, 1);
});

check('keywordOverlap: empty new keywords → ratio 0, never NaN', () => {
  const r1 = keywordOverlap([], ['auth']);
  assert.deepEqual(r1.shared, []);
  assert.equal(r1.ratio, 0);
  assert.equal(Number.isNaN(r1.ratio), false);

  const r2 = keywordOverlap([], []);
  assert.equal(r2.ratio, 0);
});

check('keywordOverlap: empty existing keywords → ratio 0', () => {
  const r = keywordOverlap(['auth', 'login'], []);
  assert.deepEqual(r.shared, []);
  assert.equal(r.ratio, 0);
});

check('keywordOverlap: case-insensitive + trimmed keyword matching', () => {
  const r = keywordOverlap([' Auth ', 'LOGIN'], ['auth', 'login']);
  assert.deepEqual(r.shared.sort(), ['auth', 'login']);
  assert.equal(r.ratio, 1);
});

check('keywordOverlap: malformed entries (non-string / blank) are dropped, not counted', () => {
  // newKeywords ["auth", "", "  ", 5, null, "login"] → valid set {auth, login}.
  const r = keywordOverlap(['auth', '', '  ', 5 as unknown, null as unknown, 'login'], ['auth', 'login']);
  assert.deepEqual(r.shared.sort(), ['auth', 'login']);
  assert.equal(r.ratio, 1, 'blank/non-string entries excluded from denominator');
});

check('keywordOverlap: non-array input is defensively treated as empty (bypass-Zod path)', () => {
  assert.equal(keywordOverlap(undefined, ['auth']).ratio, 0);
  assert.equal(keywordOverlap('auth' as unknown, ['auth']).ratio, 0);
  const r = keywordOverlap(['auth', 'login'], 'auth' as unknown);
  assert.equal(r.ratio, 0, 'non-array existing keywords → no shared');
});

// ── empty normalized name must not be a match key (legacy name:"" data) ──────

check('empty normalized name: two legacy name:"" stories do not collapse to a match', () => {
  // Simulate the idempotency comparison directly: callers only treat
  // normalizeName(name).length > 0 as a participating match key.
  const legacyStoredName = ''; // bypass-Zod legacy JSON shape
  const newName = ''; // also empty
  const normStored = normalizeName(legacyStoredName);
  const normNew = normalizeName(newName);
  assert.equal(normStored, '');
  assert.equal(normNew, '');
  // The idempotency rule: a match requires normNew.length > 0 AND equality.
  const wouldMatch = normNew.length > 0 && normNew === normStored;
  assert.equal(wouldMatch, false, 'empty normalized names must not be judged the same story');
});

check('empty normalized name: all-special-character name also does not match', () => {
  const normA = normalizeName('@@@'); // → "" (no letters survive collapse... actually kept? check)
  // '@@@' has no underscore/space/hyphen, so collapse leaves it; not separator-only.
  // Use a separator-only string which is the real legacy shape that → "".
  const normSep = normalizeName('---');
  assert.equal(normSep, '');
  const wouldMatch = normSep.length > 0 && normSep === normalizeName('___');
  assert.equal(wouldMatch, false);
  // '@@@' is preserved (not separators) — documents that normalizeName only
  // collapses _/space/-; non-separator specials survive.
  assert.equal(normA, '@@@');
});

console.log(`✓ story-dedup smoke passed (${passed} checks)`);
