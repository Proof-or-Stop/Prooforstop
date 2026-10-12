#!/usr/bin/env node
/**
 * EXPERIMENTAL A/B review.laneMerge (core/review-lane-merge.ts): ONE managed
 * review session per REVIEW round carries every active lane's dimension (the
 * new PoS's ADR-064, ported as an idea). Unit level, a minimal store stand-in,
 * generic lane names only. The end-to-end arms (each reaching DONE through
 * `next`) live in tasks/e2e-review-to-done-smoke.ts (NLM, NLM-OFF, NLM-G,
 * NLM-C, NLM-F, NLM-FG; `LM` = all six).
 *
 *   P. Plan / roster: off or malformed = no merge (every dimension its own lane);
 *      on = the first dimension carries ONE session for all of them; a forced
 *      lane, a dimension the current round's merged PASS left uncovered, and a
 *      dimension the previous round's merged FINDINGS verdict left uncovered run
 *      as their own lanes; the carrier's own dimension uncovered = every
 *      dimension separate (CARRIER_GAP); fewer than two mergeable dimensions =
 *      no merge.
 *   N. Coverage contract: one `[checked] <dimension>:<checkpoint> :: <evidence>`
 *      line per checkpoint; a missing line, a line without evidence or a
 *      `[gap]` leaves the dimension uncovered (never passed); flattened and
 *      decorated notes parse; lines naming nothing of the binding are ignored.
 *   T. A merged finding keeps its dimension tag (`[dimension:<name>]`).
 *   B. Prompt block: one explicit section per dimension (concern, checkpoints,
 *      the lane's role prompt, its rules), the finding tag rule and the
 *      fail-closed coverage contract; the carrier's section points at its own
 *      role prompt.
 *
 * Usage: node packages/main/dist/tasks/review-lane-merge-smoke.js
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Fn = (...args: unknown[]) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
const failures: string[] = [];
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`ok   ${name}`); } catch (error) { failures.push(name); console.log(`FAIL ${name}: ${error instanceof Error ? error.message.split('\n').slice(0, 4).join(' | ') : String(error)}`); }
}
// Loaded at run time so this smoke compiles (and fails) before the module exists.
async function mergeModule(): Promise<Record<string, unknown>> {
  try { return await import(new URL('../core/review-lane-merge.js', import.meta.url).href) as Record<string, unknown>; }
  catch (error) { throw new Error(`core/review-lane-merge.js is missing: ${error instanceof Error ? error.message : String(error)}`); }
}
const api = async (name: string): Promise<Fn> => {
  const fn = (await mergeModule())[name];
  assert.equal(typeof fn, 'function', `${name} is exported by core/review-lane-merge.ts`);
  return fn as Fn;
};

const dirs: string[] = [];
const STORY = 'B-lm01';
const ROUND1 = '2026-10-13T10:00:00.000Z';
const ROUND2 = '2026-10-13T11:00:00.000Z';
const L = (name: string): string => `proof-or-stop-review-${name}`;
const DIMS = ['concept', 'quality', 'test-coverage', 'docs'].map(L);

function project(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'lane-merge-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'proof-or-stop.config.json'), JSON.stringify(config));
  return dir;
}
const ON = () => project({ review: { laneMerge: 'on' } });

function store(opts: { round?: string; events?: Array<Record<string, unknown>>; earlierRound?: boolean } = {}): Record<string, Fn> {
  const round = opts.round ?? ROUND1;
  const runs = opts.earlierRound
    ? [{ reviewRunId: `${STORY}:RR-001`, storyId: STORY, lane: L('concept'), reviewRound: ROUND1, headHash: 'a'.repeat(40), startedAt: ROUND1 }]
    : [];
  return {
    readStory: () => ({ id: STORY, phase: 'REVIEW', currentReviewRound: round }),
    readReviewRuns: () => ({ runs }),
    readProcessEvents: () => opts.events ?? [],
  };
}
const coverage = (reviewRound: string, conclusion: 'pass' | 'findings', missingLanes: string[], carrierMissing = false) =>
  ({ type: 'review_lane_merge_coverage', storyId: STORY, reviewRound, conclusion, missingLanes, carrierMissing });

async function plan(root: string, s: Record<string, Fn>, extra: Record<string, unknown> = {}): Promise<Record<string, any>> { // eslint-disable-line @typescript-eslint/no-explicit-any
  return (await api('computeLaneMergePlan'))({ store: s, projectRoot: root, storyId: STORY, dimensionLanes: DIMS, ...extra });
}

await check('P1 off / malformed: no merge, every dimension is its own lane', async () => {
  for (const root of [project({}), project({ review: { laneMerge: 'yes' } })]) {
    const p = await plan(root, store());
    assert.equal(p.eligible, false);
    assert.equal(p.reason, 'LANE_MERGE_OFF');
    assert.deepEqual(p.selectedLanes, DIMS);
    assert.equal(p.carrier, null);
  }
  assert.equal((await api('laneMergeVariant'))(project({ review: { laneMerge: 'yes' } })), undefined, 'malformed = off where consumed');
});

await check('P2 on: the first dimension carries ONE session for all dimensions (one checkpoint set each)', async () => {
  const p = await plan(ON(), store());
  assert.equal(p.eligible, true);
  assert.equal(p.reason, 'LANE_MERGE');
  assert.equal(p.carrier, L('concept'));
  assert.deepEqual(p.mergedLanes, DIMS);
  assert.deepEqual(p.selectedLanes, [L('concept')], 'only the carrier is launched');
  assert.deepEqual(p.separateLanes, []);
  for (const name of ['concept', 'quality', 'test-coverage', 'docs']) {
    assert.ok(p.checkItems.filter((item: string) => item.startsWith(`${name}:`)).length >= 2, `${name} has at least two checkpoints (${p.checkItems.join(', ')})`);
  }
  assert.equal(p.abVariant?.flags?.['review.laneMerge'], 'on', 'the arm is recorded');
  assert.match(p.planDigest, /^[0-9a-f]{64}$/);
  assert.equal((await plan(ON(), store())).planDigest, p.planDigest, 'digest is stable for the same facts');
  const binding = (await api('laneMergeBinding'))(p);
  assert.equal(binding.role, 'merged');
  assert.deepEqual(binding.checkItems, p.checkItems);
  assert.equal((await api('laneMergeRole'))(p, L('concept'), ROUND1), 'merged');
  assert.equal((await api('laneMergeRole'))(p, L('quality'), ROUND1), null, 'a merged dimension never runs its own merged prompt');
  assert.equal((await api('laneMergeRole'))(p, L('concept'), ROUND2), null, 'another round: no role');
  const basis = JSON.parse((await api('laneMergeRosterBasis'))(p, 'v2'));
  assert.equal(basis.kind, 'lane-merge');
  assert.deepEqual(basis.selectedLanes, [L('concept')]);
});

await check('P3 a forced lane runs as its own lane; the rest stay merged', async () => {
  const p = await plan(ON(), store(), { forcedLanes: [L('docs')] });
  assert.deepEqual(p.selectedLanes, [L('concept'), L('docs')]);
  assert.deepEqual(p.mergedLanes, [L('concept'), L('quality'), L('test-coverage')]);
  assert.equal(p.separateReasons[L('docs')], 'forced');
  assert.ok(!p.checkItems.some((item: string) => item.startsWith('docs:')), 'no docs checkpoint in the merged session');
});

await check('P4 a merged PASS that left a dimension uncovered: only that dimension is relaunched as its own lane (same round)', async () => {
  const p = await plan(ON(), store({ events: [coverage(ROUND1, 'pass', [L('quality')])] }));
  assert.equal(p.eligible, true);
  assert.equal(p.carrier, L('concept'), 'the carrier does not move');
  assert.deepEqual(p.selectedLanes, [L('concept'), L('quality')]);
  assert.equal(p.separateReasons[L('quality')], 'dimension_gap');
  const other = await plan(ON(), store({ round: ROUND2, events: [coverage(ROUND1, 'pass', [L('quality')])] }));
  assert.deepEqual(other.selectedLanes, [L('concept')], 'a pass gap of an earlier round does not carry over');
});

await check('P5 the carrier left its OWN dimension uncovered: every dimension runs as its own lane (CARRIER_GAP)', async () => {
  const p = await plan(ON(), store({ events: [coverage(ROUND1, 'pass', [L('concept')], true)] }));
  assert.equal(p.eligible, false);
  assert.equal(p.reason, 'CARRIER_GAP');
  assert.deepEqual(p.selectedLanes, DIMS);
});

await check('P6 a merged FINDINGS verdict that left a dimension uncovered: no late lane now; that dimension runs on its own in the NEXT round', async () => {
  const now = await plan(ON(), store({ events: [coverage(ROUND1, 'findings', [L('test-coverage')])] }));
  assert.deepEqual(now.selectedLanes, [L('concept')], 'the findings round launches no late lane');
  const next = await plan(ON(), store({ round: ROUND2, earlierRound: true, events: [coverage(ROUND1, 'findings', [L('test-coverage')])] }));
  assert.equal(next.previousRound, ROUND1);
  assert.deepEqual(next.selectedLanes, [L('concept'), L('test-coverage')]);
  assert.equal(next.separateReasons[L('test-coverage')], 'previous_dimension_gap');
  assert.ok(!next.checkItems.some((item: string) => item.startsWith('test-coverage:')));
});

await check('P7 fewer than two mergeable dimensions: no merge', async () => {
  const single = (await api('computeLaneMergePlan'))({ store: store(), projectRoot: ON(), storyId: STORY, dimensionLanes: [L('concept')] });
  assert.equal(single.eligible, false);
  assert.equal(single.reason, 'FEWER_THAN_TWO_DIMENSIONS');
  assert.deepEqual(single.selectedLanes, [L('concept')]);
  const p = await plan(ON(), store(), { forcedLanes: [L('quality'), L('test-coverage'), L('docs')] });
  assert.equal(p.eligible, false, 'all but one dimension forced: nothing to merge');
});

const fullNote = (items: string[]): string => items.map(item => `[checked] ${item} :: read strs.go and ran go test ./strs; no problem`).join('\n');

await check('N1 coverage contract: every checkpoint checked with evidence = every dimension covered', async () => {
  const p = await plan(ON(), store());
  const binding = (await api('laneMergeBinding'))(p);
  const result = (await api('checkLaneMergeNote'))({ binding, note: `Reviewed all dimensions.\n${fullNote(p.checkItems)}` });
  assert.deepEqual(result.missingLanes, []);
  assert.deepEqual(result.coveredLanes, DIMS);
  assert.equal(result.carrierMissing, false);
});

await check('N2 a missing line, a line without evidence, or a [gap] leaves that dimension uncovered (fail closed)', async () => {
  const p = await plan(ON(), store());
  const binding = (await api('laneMergeBinding'))(p);
  const checkNote = await api('checkLaneMergeNote');
  const withoutQuality = fullNote(p.checkItems.filter((item: string) => !item.startsWith('quality:')));
  assert.deepEqual(checkNote({ binding, note: withoutQuality }).missingLanes, [L('quality')], 'missing lines');
  const bare = p.checkItems.map((item: string) => item.startsWith('docs:') ? `[checked] ${item}` : `[checked] ${item} :: ran the docs examples; all match`).join('\n');
  assert.deepEqual(checkNote({ binding, note: bare }).missingLanes, [L('docs')], 'a [checked] line without evidence is not coverage');
  const gapped = `${fullNote(p.checkItems)}\n[gap] test-coverage:assertions :: ran out of time`;
  const result = checkNote({ binding, note: gapped });
  assert.deepEqual(result.missingLanes, [L('test-coverage')], 'a [gap] wins over a [checked] line');
  assert.equal(result.gaps.length, 1);
  const carrierGap = checkNote({ binding, note: `${fullNote(p.checkItems)}\n[gap] concept:residue :: grep not run` });
  assert.equal(carrierGap.carrierMissing, true, 'the carrier\'s own dimension');
  assert.deepEqual(checkNote({ binding, note: '' }).missingLanes, DIMS, 'an empty note covers nothing');
});

await check('N3 flattened / decorated notes parse; lines naming nothing of the binding are ignored', async () => {
  const p = await plan(ON(), store());
  const binding = (await api('laneMergeBinding'))(p);
  const flat = p.checkItems.map((item: string) => `[checked] \`dimension:${item}\`: read the diff and probed it, fine.`).join(' ');
  assert.deepEqual((await api('checkLaneMergeNote'))({ binding, note: flat }).missingLanes, [], 'one-line note with decorated items');
  const unrelated = `${fullNote(p.checkItems)}\n[gap] plan.md :: no such file`;
  assert.deepEqual((await api('checkLaneMergeNote'))({ binding, note: unrelated }).missingLanes, [], 'a [gap] on something that is no checkpoint is not a gap');
});

await check('T1 a merged finding keeps its dimension tag', async () => {
  const dimension = await api('findingDimension');
  assert.equal(dimension('[dimension:quality] Upper("") panics on an empty string.'), 'quality');
  assert.equal(dimension('[regression-of F-001] [dimension:test-coverage] TestX asserts by prefix.'), 'test-coverage');
  assert.equal(dimension('Reverse has no focused test for an empty string.'), null);
});

await check('B1 prompt block: one explicit section per dimension, tag rule, fail-closed coverage contract', async () => {
  const p = await plan(ON(), store());
  const render = await api('renderLaneMergeBlock');
  const sections = DIMS.map(lane => ({ lane, roleBody: lane === L('concept') ? null : `ROLE BODY OF ${lane}`, extras: lane === L('test-coverage') ? ['Exact-text rubric: scripted'] : [] }));
  const text = (render(p, sections) as string[]).join('\n');
  assert.match(text, /^--- BEGIN MERGED REVIEW DIMENSIONS/);
  assert.match(text, /--- END MERGED REVIEW DIMENSIONS ---$/);
  assert.match(text, /### Dimension 1\/4: concept[^\n]*your role prompt above/);
  for (const [index, name] of ['quality', 'test-coverage', 'docs'].entries()) {
    assert.match(text, new RegExp(`### Dimension ${index + 2}/4: ${name}`), `${name} section`);
    assert.match(text, new RegExp(`ROLE BODY OF proof-or-stop-review-${name}`), `${name} role prompt carried`);
  }
  for (const item of p.checkItems) assert.ok(text.includes(`- ${item} — `), `checkpoint ${item} listed`);
  assert.match(text, /Exact-text rubric: scripted/, 'lane rules carried');
  assert.match(text, /\[dimension:quality\]/, 'finding tag rule');
  assert.match(text, /\[checked\] <checkpoint> :: /, 'coverage line form');
  assert.match(text, /NOT covered[^\n]*relaunches that dimension as its own separate review session/, 'fail-closed contract stated');
  assert.ok(!text.includes('ROLE BODY OF proof-or-stop-review-concept'), 'the carrier\'s role prompt is not repeated');
});

for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
if (failures.length) {
  console.log(`review-lane-merge-smoke: FAIL (${failures.length}: ${failures.map(name => name.split(' ')[0]).join(', ')})`);
  process.exit(1);
}
console.log('review-lane-merge-smoke: PASS');
