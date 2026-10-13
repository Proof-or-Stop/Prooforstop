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
 *   D. Depth (lab lane-split, old-PoS run 64 §4.4: the merged R1 session read 2
 *      files fully and its test-coverage / docs lines were generic): every
 *      merged dimension lists the files it read in full (`[read] <dimension> ::
 *      <file>, ...`, at least one of them in the proposal's
 *      readManifest.filesReadFully), and every `[checked]` line's evidence cites
 *      a file:line or a command with its output; a generic line is NOT coverage.
 *   S. review.laneMerge=split: TWO merged sessions per round, run in parallel:
 *      concept + quality (carrier concept) and test-coverage + docs (carrier
 *      test-coverage; behavior joins this one); same per-dimension contract and
 *      fail-closed relaunch, per session: a carrier gap sends only that
 *      session's dimensions to their own lanes.
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

/** Specific evidence (a file:line and a command with its output) and one [read] line per dimension of the items. */
const fullNote = (items: string[]): string => [
  ...items.map(item => `[checked] ${item} :: strs/strs.go:12 read; \`go test ./strs\` -> ok strs 0.01s`),
  ...[...new Set(items.map(item => item.split(':')[0]))].map(dimension => `[read] ${dimension} :: strs/strs.go, strs/strs_test.go`),
].join('\n');
const MANIFEST = { filesReadFully: ['strs/strs.go', 'strs/strs_test.go'], filesTriagedByName: ['docs/types/string.md'] };

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
  const bare = `${fullNote(p.checkItems.filter((item: string) => !item.startsWith('docs:')))}\n${p.checkItems.filter((item: string) => item.startsWith('docs:')).map((item: string) => `[checked] ${item}`).join('\n')}\n[read] docs :: strs/strs.go`;
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
  const flat = [...p.checkItems.map((item: string) => `[checked] \`dimension:${item}\`: probed strs/strs.go:40 (Upper), fine.`),
    ...['concept', 'quality', 'test-coverage', 'docs'].map(name => `[read] *${name}*: \`strs/strs.go\`.`)].join(' ');
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

await check('B2 a dimension brings only its own role text: no frontmatter, the framework rules shared with the carrier\'s role prompt are not repeated', async () => {
  const mod = await import(new URL('../core/review-lane-merge-prompt.js', import.meta.url).href) as Record<string, Fn>;
  const shared = Array.from({ length: 60 }, (_, i) => `Shared framework rule ${i}: always report honestly.`).join('\n');
  const carrier = `---\nname: c\n---\n## Concept checks\nGrep for residue.\n\n${shared}\n`;
  const own = mod.ownRolePart(`---\nname: q\n---\n## Quality checks\nProbe edge cases.\n\n${shared}\n`, carrier) as string;
  assert.match(own, /^## Quality checks\nProbe edge cases\./);
  assert.ok(!own.includes('Shared framework rule 30'), 'shared rules not repeated');
  assert.match(own, /identical to the end of your own role prompt above/);
  assert.ok(!own.includes('name: q'), 'no frontmatter');
  const short = mod.ownRolePart('## Docs checks\nRun the examples.\nEnd.', '## Concept\nEnd.') as string;
  assert.equal(short, '## Docs checks\nRun the examples.\nEnd.', 'a short common tail is kept');
  const real = (await import(new URL('../core/prompt-role-contract-registry.js', import.meta.url).href) as Record<string, Fn>).resolvePromptRoleBody;
  const quality = mod.ownRolePart(real(L('quality'), undefined).body, real(L('concept'), undefined).body) as string;
  assert.ok(Buffer.byteLength(quality) < 10_000, `the quality lane's own part is small (${Buffer.byteLength(quality)} B)`);
});

await check('D1 depth: every merged dimension lists the files it read in full; none listed (or none of them in readManifest.filesReadFully) = NOT covered', async () => {
  const p = await plan(ON(), store());
  const binding = (await api('laneMergeBinding'))(p);
  const checkNote = await api('checkLaneMergeNote');
  const checked = fullNote(p.checkItems).split('\n').filter(line => !line.startsWith('[read] '));
  const reads = (dims: string[], files = 'strs/strs.go, strs/strs_test.go') => dims.map(name => `[read] ${name} :: ${files}`);
  const noDocsRead = checkNote({ binding, note: [...checked, ...reads(['concept', 'quality', 'test-coverage'])].join('\n'), readManifest: MANIFEST });
  assert.deepEqual(noDocsRead.missingLanes, [L('docs')], 'no [read] line for docs');
  assert.deepEqual(noDocsRead.unreadLanes, [L('docs')]);
  const triagedOnly = checkNote({ binding, note: [...checked, ...reads(['concept', 'quality', 'test-coverage']), '[read] docs :: docs/types/string.md'].join('\n'), readManifest: MANIFEST });
  assert.deepEqual(triagedOnly.missingLanes, [L('docs')], 'a file only triaged by name is not a full read');
  assert.deepEqual(triagedOnly.unverifiedReads, ['docs:docs/types/string.md']);
  const mixed = checkNote({ binding, note: [...checked, ...reads(['concept', 'quality', 'test-coverage']), '[read] docs :: ./strs/strs.go:1, docs/types/string.md'].join('\n'), readManifest: MANIFEST });
  assert.deepEqual(mixed.missingLanes, [], 'one fully read file (normalized ./ and :line) is enough; the other is reported');
  assert.deepEqual(mixed.readFiles?.docs, ['strs/strs.go', 'docs/types/string.md']);
  assert.deepEqual(mixed.unverifiedReads, ['docs:docs/types/string.md']);
  const noManifest = checkNote({ binding, note: [...checked, ...reads(['concept', 'quality', 'test-coverage', 'docs'], 'the whole diff')].join('\n') });
  assert.deepEqual(noManifest.missingLanes, DIMS, 'without a manifest a [read] line still has to name a file path');
  const carrierUnread = checkNote({ binding, note: [...checked, ...reads(['quality', 'test-coverage', 'docs'])].join('\n'), readManifest: MANIFEST });
  assert.equal(carrierUnread.carrierMissing, true, 'the carrier\'s own dimension needs its [read] line too');
});

await check('D2 depth: a [checked] line whose evidence is generic (no file:line, no command with its output) is NOT coverage', async () => {
  const p = await plan(ON(), store());
  const binding = (await api('laneMergeBinding'))(p);
  const checkNote = await api('checkLaneMergeNote');
  const reads = ['concept', 'quality', 'test-coverage', 'docs'].map(name => `[read] ${name} :: strs/strs.go`);
  // Old-PoS run 64 R1: the test-coverage and docs lines were one-line generic summaries.
  const run64 = [
    ...fullNote(p.checkItems.filter((item: string) => item.startsWith('concept:') || item.startsWith('quality:'))).split('\n').filter(line => !line.startsWith('[read] ')),
    '[checked] test-coverage:behaviours :: mapped every verificationIntent to its tests; all exercised and pass',
    '[checked] test-coverage:assertions :: assertions check exact values throughout',
    '[checked] docs:sections :: no documentation section names a changed symbol',
    '[checked] docs:promises :: no new documented promises',
    ...reads,
  ].join('\n');
  const result = checkNote({ binding, note: run64, readManifest: MANIFEST });
  assert.deepEqual(result.missingLanes, [L('test-coverage'), L('docs')], 'generic lines leave their dimensions uncovered');
  assert.deepEqual(result.genericItems, ['test-coverage:behaviours', 'test-coverage:assertions', 'docs:sections', 'docs:promises']);
  const specific = [
    '[checked] concept:residue :: `git grep -n OldName` -> no output (exit 1)',
    '[checked] concept:readers :: String() at ast/ast.go:118 renders the new field',
    '[checked] quality:edges :: ran `./run.sh probe.txt` → panic: index out of range',
    '[checked] quality:code :: evaluator/eval.go:204-230 handles the error path',
    '[checked] test-coverage:behaviours :: `go test ./strs -run TestUpper -v` printed --- PASS: TestUpper',
    '[checked] test-coverage:assertions :: strs/strs_test.go:31 compares with == against the request string',
    '[checked] docs:sections :: docs/types/string.md:7 example matches `go run ./cmd/demo` output => HELLO',
    '[checked] docs:promises :: README.md#L40 promise delivered by strs/strs.go:20',
    ...reads,
  ].join('\n');
  const ok = checkNote({ binding, note: specific, readManifest: MANIFEST });
  assert.deepEqual(ok.missingLanes, [], `file:line / #L / a command with its output is specific (${JSON.stringify(ok.genericItems)})`);
  assert.deepEqual(ok.genericItems, []);
  const commandOnly = checkNote({ binding, note: specific.replace('`go test ./strs -run TestUpper -v` printed --- PASS: TestUpper', 'ran `go test ./strs` and it was fine'), readManifest: MANIFEST });
  assert.deepEqual(commandOnly.genericItems, ['test-coverage:behaviours'], 'a command without its output is not evidence');
});

const SPLIT = () => project({ review: { laneMerge: 'split' } });

await check('S1 split: TWO merged sessions (concept + quality | test-coverage + docs), each carrier seals only its own dimensions', async () => {
  const p = await plan(SPLIT(), store());
  assert.equal(p.eligible, true);
  assert.equal(p.reason, 'LANE_MERGE');
  assert.equal(p.mode, 'split');
  assert.equal(p.abVariant?.flags?.['review.laneMerge'], 'split', 'the arm is recorded');
  assert.deepEqual(p.groups.map((group: Record<string, unknown>) => group.carrier), [L('concept'), L('test-coverage')]);
  assert.deepEqual(p.groups.map((group: Record<string, unknown>) => group.mergedLanes), [[L('concept'), L('quality')], [L('test-coverage'), L('docs')]]);
  assert.deepEqual(p.selectedLanes, [L('concept'), L('test-coverage')], 'two sessions are launched (in parallel, as lanes are)');
  assert.deepEqual(p.mergedLanes, DIMS, 'every dimension is merged into one of the two sessions');
  const binding = await api('laneMergeBinding');
  const a = binding(p, L('concept'));
  const b = binding(p, L('test-coverage'));
  assert.equal(a.carrier, L('concept'));
  assert.deepEqual(a.mergedLanes, [L('concept'), L('quality')]);
  assert.ok(a.checkItems.every((item: string) => /^(concept|quality):/.test(item)), `session A checkpoints ${a.checkItems.join(', ')}`);
  assert.equal(b.carrier, L('test-coverage'));
  assert.deepEqual(b.mergedLanes, [L('test-coverage'), L('docs')]);
  assert.ok(b.checkItems.every((item: string) => /^(test-coverage|docs):/.test(item)), `session B checkpoints ${b.checkItems.join(', ')}`);
  assert.equal(a.mode, 'split');
  const role = await api('laneMergeRole');
  assert.equal(role(p, L('concept'), ROUND1), 'merged');
  assert.equal(role(p, L('test-coverage'), ROUND1), 'merged');
  assert.equal(role(p, L('quality'), ROUND1), null);
  assert.equal(role(p, L('docs'), ROUND1), null);
  assert.throws(() => binding(p, L('quality')), /not a carrier/, 'a merged dimension is never bound as a carrier');
  const basis = JSON.parse((await api('laneMergeRosterBasis'))(p, 'v2'));
  assert.equal(basis.kind, 'lane-merge');
  assert.deepEqual(basis.selectedLanes, [L('concept'), L('test-coverage')]);
  const on = await plan(ON(), store());
  assert.notEqual(on.planDigest, p.planDigest, 'on and split never share a roster basis');
  assert.equal(on.mode, 'on');
  assert.deepEqual(on.groups.map((group: Record<string, unknown>) => group.carrier), [L('concept')], 'on = one session');
});

await check('S2 split: behavior joins the test-coverage + docs session; a third-party lane joins the smaller session; 3 lanes = one merged session + one ordinary lane', async () => {
  const five = await plan(SPLIT(), store(), { dimensionLanes: [...DIMS.slice(0, 3), L('behavior'), L('docs')] });
  assert.deepEqual(five.groups.map((group: Record<string, unknown>) => group.mergedLanes), [[L('concept'), L('quality')], [L('test-coverage'), L('behavior'), L('docs')]]);
  const other = await plan(SPLIT(), store(), { dimensionLanes: [...DIMS.slice(0, 3), L('behavior'), L('docs'), L('channel')] });
  assert.deepEqual(other.groups.map((group: Record<string, unknown>) => group.mergedLanes), [[L('concept'), L('quality'), L('channel')], [L('test-coverage'), L('behavior'), L('docs')]]);
  const three = await plan(SPLIT(), store(), { dimensionLanes: DIMS.slice(0, 3) });
  assert.equal(three.eligible, true);
  assert.deepEqual(three.selectedLanes, [L('concept'), L('test-coverage')]);
  assert.deepEqual(three.groups.map((group: Record<string, unknown>) => group.mergedLanes), [[L('concept'), L('quality')], [L('test-coverage')]]);
  assert.equal((await api('laneMergeRole'))(three, L('test-coverage'), ROUND1), null, 'a one-dimension session is an ordinary lane (its own prompt)');
  const two = await plan(SPLIT(), store(), { dimensionLanes: [L('concept'), L('test-coverage')] });
  assert.equal(two.eligible, false, 'no session with two dimensions: no merge');
  assert.equal(two.reason, 'FEWER_THAN_TWO_DIMENSIONS');
});

await check('S3 split: a session whose carrier left its own dimension uncovered sends only ITS dimensions to their own lanes; the other session stays merged', async () => {
  const gap = { ...coverage(ROUND1, 'pass', [L('test-coverage'), L('docs')], true), carrier: L('test-coverage'), mergedLanes: [L('test-coverage'), L('docs')] };
  const p = await plan(SPLIT(), store({ events: [gap] }));
  assert.equal(p.eligible, true);
  assert.deepEqual(p.selectedLanes, [L('concept'), L('test-coverage'), L('docs')], 'session A stays merged (concept carries quality); test-coverage and docs run on their own');
  assert.equal(p.separateReasons[L('test-coverage')], 'carrier_gap');
  assert.equal(p.separateReasons[L('docs')], 'carrier_gap');
  assert.deepEqual(p.groups[0].mergedLanes, [L('concept'), L('quality')]);
  assert.equal((await api('laneMergeRole'))(p, L('concept'), ROUND1), 'merged');
  assert.equal((await api('laneMergeRole'))(p, L('test-coverage'), ROUND1), null, 'the relaunched carrier runs its ordinary prompt');
  const both = await plan(SPLIT(), store({ events: [gap, { ...coverage(ROUND1, 'pass', [L('concept')], true), carrier: L('concept'), mergedLanes: [L('concept'), L('quality')] }] }));
  assert.equal(both.eligible, false);
  assert.equal(both.reason, 'CARRIER_GAP');
  assert.deepEqual(both.selectedLanes, DIMS);
  const onGap = await plan(ON(), store({ events: [coverage(ROUND1, 'pass', [L('concept')], true)] }));
  assert.equal(onGap.reason, 'CARRIER_GAP', 'on: unchanged (every dimension separate)');
});

await check('S4 split: an uncovered non-carrier dimension is relaunched alone (same round after a pass, next round after findings)', async () => {
  const pass = await plan(SPLIT(), store({ events: [{ ...coverage(ROUND1, 'pass', [L('docs')]), carrier: L('test-coverage') }] }));
  assert.deepEqual(pass.selectedLanes, DIMS.filter(lane => lane !== L('quality')), 'concept + test-coverage carriers, docs on its own');
  assert.equal(pass.separateReasons[L('docs')], 'dimension_gap');
  const next = await plan(SPLIT(), store({ round: ROUND2, earlierRound: true, events: [{ ...coverage(ROUND1, 'findings', [L('quality')]), carrier: L('concept') }] }));
  assert.equal(next.separateReasons[L('quality')], 'previous_dimension_gap');
  assert.deepEqual(next.selectedLanes, [L('concept'), L('quality'), L('test-coverage')], 'concept alone (ordinary), quality alone, B merged');
  assert.equal((await api('laneMergeRole'))(next, L('concept'), ROUND2), null, 'session A has one dimension left: an ordinary lane');
  assert.equal((await api('laneMergeRole'))(next, L('test-coverage'), ROUND2), 'merged');
});

await check('S5 split: malformed value = off; the switch value is in the arm evidence', async () => {
  const p = await plan(project({ review: { laneMerge: 'Split' } }), store());
  assert.equal(p.reason, 'LANE_MERGE_OFF');
  assert.equal((await api('laneMergeVariant'))(SPLIT())?.flags?.['review.laneMerge'], 'split');
});

await check('B3 split prompt block: only the session\'s own dimensions, the other session named, the depth contract stated', async () => {
  const p = await plan(SPLIT(), store());
  const render = await api('renderLaneMergeBlock');
  const sections = DIMS.map(lane => ({ lane, roleBody: `ROLE BODY OF ${lane}`, extras: [] }));
  const b = (render(p, sections, L('test-coverage')) as string[]).join('\n');
  assert.match(b, /review\.laneMerge=split/);
  assert.match(b, /### Dimension 1\/2: test-coverage[^\n]*your role prompt above/);
  assert.match(b, /### Dimension 2\/2: docs/);
  assert.doesNotMatch(b, /### Dimension \d\/\d: (concept|quality)/);
  assert.match(b, /concept, quality[^\n]*another session|another session[^\n]*concept, quality/, 'the parallel session is named');
  assert.ok(!b.includes('ROLE BODY OF proof-or-stop-review-test-coverage'), 'the carrier\'s role prompt is not repeated');
  assert.match(b, /\[read\] <dimension> :: /, 'read-list line form');
  assert.match(b, /file:line[^\n]*command[^\n]*output|command[^\n]*output[^\n]*file:line/, 'specific-evidence rule');
  const a = (render(p, sections, L('concept')) as string[]).join('\n');
  assert.match(a, /### Dimension 2\/2: quality/);
  const on = (render(await plan(ON(), store()), sections) as string[]).join('\n');
  assert.match(on, /\[read\] <dimension> :: /, 'on carries the depth contract too');
  assert.match(on, /review\.laneMerge=on/);
});

for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
if (failures.length) {
  console.log(`review-lane-merge-smoke: FAIL (${failures.length}: ${failures.map(name => name.split(' ')[0]).join(', ')})`);
  process.exit(1);
}
console.log('review-lane-merge-smoke: PASS');
