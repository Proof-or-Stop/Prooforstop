#!/usr/bin/env node
/**
 * Old-PoS run 52 (bench-staging/oldpos/run52-analysis.md §4; run 48 cycle C):
 * 12 of 17 findings were ONE pre-existing documentation defect, re-filed by
 * four lanes in rounds 1, 3, 4 and 5. The `preexisting_out_of_scope`
 * disposition (core/finding-preexisting.ts, old-PoS run 30/36/37) closes ONE
 * finding id per owner turn; nothing tied a later copy to it, so every copy was
 * a new open blocking finding and a round whose only findings were copies
 * forced another full round on unchanged code.
 *
 * Unit level, real git repositories, generic toy files only:
 *   K. Site keys: a pre-existing finding's defect sites keyed by path and Story
 *      base line (so a re-filing in other words, or after an unrelated line
 *      shift, names the same site).
 *   M. Recurrence match: a new finding is a recurrence only when it is itself
 *      pre-existing (every defect line outside every Story hunk and
 *      byte-identical at the base) AND every one of its sites belongs to an
 *      already dispositioned pre-existing finding. A site the Story edited, a
 *      new site of the same file, or a code line inside a Story hunk is never
 *      a recurrence (detection is not reduced).
 * The end-to-end arms (closure at import, no owner turn, no extra round, the
 * prompt block, both negative controls) are tasks/e2e-review-to-done-smoke.ts
 * NPXR, NPXRE, NPXRN.
 *
 * Usage: node packages/main/dist/tasks/run52-fixes-smoke.js
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

type Fn = (...args: unknown[]) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
const failures: string[] = [];
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`ok   ${name}`); } catch (error) { failures.push(name); console.log(`FAIL ${name}: ${error instanceof Error ? error.message.split('\n').slice(0, 4).join(' | ') : String(error)}`); }
}
const core = await import(new URL('../core/finding-preexisting.js', import.meta.url).href) as Record<string, unknown>;
const api = (name: string): Fn => {
  assert.equal(typeof core[name], 'function', `${name} is exported by core/finding-preexisting.ts`);
  return core[name] as Fn;
};

const dirs: string[] = [];
const GUIDE = '# Guide\n\nUpper lower-cases every letter.\nReverse keeps its input unchanged.\nBoth accept UTF-8.\n';
const CODE = 'package strs\n\nfunc Upper(s string) string { return s }\n\nfunc Reverse(s string) string { return s }\n';
const CODE_STORY = 'package strs\n\nimport "strings"\n\nfunc Upper(s string) string { return strings.ToUpper(s) }\n\nfunc Reverse(s string) string { return s }\n';

function repo(opts: { editGuideLine3?: boolean } = {}): { dir: string; base: string; head: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'run52-recurring-')));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const put = (rel: string, text: string) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
  const commit = (message: string) => { git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', message); return git('rev-parse', 'HEAD'); };
  git('init', '-q', '-b', 'main');
  put('docs/guide.md', GUIDE);
  put('strs/strs.go', CODE);
  const base = commit('base');
  git('checkout', '-q', '-b', 'story/B-rx01');
  put('strs/strs.go', CODE_STORY);
  if (opts.editGuideLine3) put('docs/guide.md', GUIDE.replace('every letter.', 'every letter, rune by rune.'));
  const head = commit('B-rx01 CHK-001: Upper');
  return { dir, base, head };
}

const presenceOf = (r: { dir: string; base: string; head: string }, desc: string, files: string[]) =>
  api('assessFindingBasePresence')({ gitCwd: r.dir, base: r.base, head: r.head, finding: { desc, files } });

const DISPOSITIONED = 'doc-code-drift: docs/guide.md:3 says Upper lower-cases every letter, but strs.Upper upper-cases.';
const REFILED = 'docs/guide.md:3 still documents Upper as lower-casing; readers get the opposite.';

await check('K1 site keys: path and Story-base line per defect line; none for a finding that is not pre-existing', () => {
  const r = repo();
  const keys = api('preexistingSiteKeys');
  assert.deepEqual(keys(presenceOf(r, 'docs/guide.md:3-4 are wrong.', ['docs/guide.md'])), ['docs/guide.md#3', 'docs/guide.md#4']);
  assert.deepEqual(keys(presenceOf(r, 'strs/strs.go:5 upper-cases.', ['strs/strs.go'])), [], 'a line inside a Story hunk is not a pre-existing site');
});

await check('M1 a re-filing of a dispositioned, unchanged site in other words (another lane) is a recurrence of that disposition', () => {
  const r = repo();
  const match = api('recurringPreexistingSites')({
    candidate: presenceOf(r, REFILED, ['docs/guide.md']),
    dispositioned: [{ findingId: 'B-rx01:F-001', presence: presenceOf(r, DISPOSITIONED, ['docs/guide.md', 'strs/strs.go']) }],
  });
  assert.equal(match.recurring, true, match.reason);
  assert.deepEqual(match.of, ['B-rx01:F-001']);
  assert.deepEqual(match.sites, ['docs/guide.md:3']);
});

await check('M2 a new site of the same file (one line never dispositioned) is NOT a recurrence, alone or beside a dispositioned site', () => {
  const r = repo();
  const dispositioned = [{ findingId: 'B-rx01:F-001', presence: presenceOf(r, DISPOSITIONED, ['docs/guide.md']) }];
  const recurring = api('recurringPreexistingSites');
  assert.equal(recurring({ candidate: presenceOf(r, 'docs/guide.md:4 says Reverse keeps its input.', ['docs/guide.md']), dispositioned }).recurring, false);
  const mixed = recurring({ candidate: presenceOf(r, 'docs/guide.md:3 and :4 are wrong.', ['docs/guide.md']), dispositioned });
  assert.equal(mixed.recurring, false, 'every site must be dispositioned');
  assert.match(mixed.reason, /docs\/guide\.md:4/);
});

await check('M3 a dispositioned site the Story edited is never a recurrence (the defect is now the Story\'s own)', () => {
  const r = repo({ editGuideLine3: true });
  const candidate = presenceOf(r, REFILED, ['docs/guide.md']);
  assert.equal(candidate.preExisting, false, 'the edited line is not pre-existing');
  const match = api('recurringPreexistingSites')({ candidate,
    dispositioned: [{ findingId: 'B-rx01:F-001', presence: presenceOf(r, DISPOSITIONED, ['docs/guide.md']) }] });
  assert.equal(match.recurring, false, match.reason);
});

await check('M4 a finding that also cites a code line inside a Story hunk is never a recurrence (a real defect in Story-changed code stays open)', () => {
  const r = repo();
  const match = api('recurringPreexistingSites')({
    candidate: presenceOf(r, 'docs/guide.md:3 is wrong and strs/strs.go:5 mishandles the empty string.', ['docs/guide.md', 'strs/strs.go']),
    dispositioned: [{ findingId: 'B-rx01:F-001', presence: presenceOf(r, DISPOSITIONED, ['docs/guide.md']) }],
  });
  assert.equal(match.recurring, false, match.reason);
});

await check('M5 a disposition that no longer holds (its own presence fails now) authorizes nothing', () => {
  const r = repo();
  const stale = { ...presenceOf(r, DISPOSITIONED, ['docs/guide.md']), preExisting: false, reason: 'changed after the reviewed head' };
  const match = api('recurringPreexistingSites')({ candidate: presenceOf(r, REFILED, ['docs/guide.md']), dispositioned: [{ findingId: 'B-rx01:F-001', presence: stale }] });
  assert.equal(match.recurring, false);
});

for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
if (failures.length) {
  console.log(`run52-fixes-smoke: FAIL (${failures.length}): ${failures.join('; ')}`);
  process.exit(1);
}
console.log('run52-fixes-smoke: PASS');
