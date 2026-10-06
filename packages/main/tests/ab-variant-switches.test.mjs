/**
 * EXPERIMENTAL detection A/B switches (core/ab-variants.ts), all default OFF.
 * For each switch: flag absent = the old (production) behavior; flag set = the
 * variant. The end-to-end arms (each reaching DONE through `next`) live in
 * tasks/e2e-review-to-done-smoke.ts (AB / ND-V1..NF-V5).
 *
 *   V1 review.criticOnCleanRound=skip   cleanRoundCriticSkip / criticSkipReplayError
 *   V2 review.round2Scope=repaired-files repairedFilesReviewScope (changed files + direct callers)
 *   V3 review.round2Lanes=fresh          reviewerRound2LanesFresh (no reviewer thread resume)
 *   V4 remediation.grouping=single       host_run grouped finding repair accepted only under the flag
 *   V5 implementation.grouping=files     host_run grouped implementer accepted only under the flag
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const failures = [];
async function check(name, fn) {
  try { await fn(); console.log(`ok   ${name}`); } catch (error) { failures.push(name); console.log(`FAIL ${name}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`); }
}
const load = async (path) => import(new URL(`../dist/${path}`, import.meta.url));
const dirs = [];
function projectWith(config) {
  const dir = mkdtempSync(join(tmpdir(), 'ab-variant-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'proof-or-stop.config.json'), JSON.stringify(config));
  return dir;
}
const OFF = () => projectWith({});
const lane = (name, terminal = 'pass') => ({ lane: name, reviewRunId: `B-1:RR-${name}`, terminal, hostIdentity: 'h', promptIdentity: 'p', evidenceIds: [`E-${name}`], coverageDigest: `c-${name}` });
const cleanEvaluation = () => ({ lanes: [lane('a'), lane('b')], missingLanes: [], duplicateIdentities: [], newFamilies: [], rawFindingIds: [], unresolvedFindingIds: [], invalidDispositionIds: [], baselineMismatchIds: [] });
const epoch = { epochId: 'E1', storyId: 'B-1', requiredLanes: ['a', 'b'], waves: [], baselineFindingIds: [] };

await check('config: absent switches resolve to production values; malformed fails closed; evidence lists only ON switches', async () => {
  const { resolveAbVariants, abVariantEvidence } = await load('core/ab-variants.js');
  const off = resolveAbVariants({});
  assert.deepEqual(off, { criticOnCleanRound: 'run', round2Scope: 'full', round2Lanes: 'resume', remediationGrouping: 'per-finding', implementationGrouping: 'per-item' });
  assert.equal(abVariantEvidence(off), undefined);
  assert.throws(() => resolveAbVariants({ review: { criticOnCleanRound: 'always' } }), /invalid_ab_variant_config: review\.criticOnCleanRound/);
  const on = resolveAbVariants({ review: { criticOnCleanRound: 'skip' }, remediation: { grouping: 'single' } });
  assert.deepEqual(abVariantEvidence(on), { schema: 'proof-or-stop.ab-variants.v1', flags: { 'review.criticOnCleanRound': 'skip', 'remediation.grouping': 'single' } });
});

await check('V1 review.criticOnCleanRound: off = critic required on a clean round; skip = signed skip only for a clean first wave, replay refuses once the flag is removed', async () => {
  const { cleanRoundCriticSkip, criticSkipReplayError } = await load('core/review-inventory-critic-skip.js');
  assert.equal(cleanRoundCriticSkip(OFF(), epoch, cleanEvaluation()), undefined, 'flag off: no skip');
  const on = projectWith({ review: { criticOnCleanRound: 'skip' } });
  const skip = cleanRoundCriticSkip(on, epoch, cleanEvaluation());
  assert.ok(skip, 'flag on + clean first wave: skip record');
  assert.equal(skip.abVariant.flags['review.criticOnCleanRound'], 'skip');
  assert.equal(cleanRoundCriticSkip(on, epoch, { ...cleanEvaluation(), lanes: [lane('a'), lane('b', 'finding')] }), undefined, 'a lane with a finding terminal: critic required');
  assert.equal(cleanRoundCriticSkip(on, epoch, { ...cleanEvaluation(), rawFindingIds: ['B-1:F-001'] }), undefined, 'verified finding: critic required');
  assert.equal(cleanRoundCriticSkip(on, { ...epoch, waves: [{}] }, cleanEvaluation()), undefined, 'later wave: critic required');
  assert.equal(cleanRoundCriticSkip(on, { ...epoch, requiredLanes: ['a', 'b', 'c'] }, cleanEvaluation()), undefined, 'missing required lane: critic required');
  assert.equal(criticSkipReplayError(on, epoch, skip, cleanEvaluation()), undefined, 'replay accepts while flag set and wave clean');
  assert.match(criticSkipReplayError(OFF(), epoch, skip, cleanEvaluation()) ?? '', /no longer set/, 'replay refuses once the flag is removed');
  assert.match(criticSkipReplayError(on, epoch, skip, { ...cleanEvaluation(), lanes: [lane('a'), lane('b', 'finding')] }) ?? '', /no longer clean/);
  assert.equal(cleanRoundCriticSkip(projectWith({ review: { criticOnCleanRound: 'yes' } }), epoch, cleanEvaluation()), undefined, 'malformed value fails closed');
});

await check('V2 review.round2Scope=repaired-files: scope = files changed by the repair + direct callers of changed definitions', async () => {
  const { repairedFilesReviewScope } = await load('core/managed-review-evidence.js');
  const repo = mkdtempSync(join(tmpdir(), 'ab-v2-'));
  dirs.push(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.go'), 'package p\n\nfunc Reverse(s string) string {\n\treturn s\n}\n');
  writeFileSync(join(repo, 'b.go'), 'package p\n\nfunc Use() string { return Reverse("x") }\n');
  writeFileSync(join(repo, 'c.go'), 'package p\n\nfunc Other() int { return 1 }\n');
  git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  const from = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'a.go'), 'package p\n\nfunc Reverse(s string) string {\n\tr := []rune(s)\n\treturn string(r)\n}\n');
  git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'repair');
  const scope = repairedFilesReviewScope(repo, repo, from, git('rev-parse', 'HEAD'));
  assert.deepEqual(scope?.changed, ['a.go']);
  assert.deepEqual(scope?.callers, ['b.go'], 'b.go calls Reverse; c.go does not');
  assert.equal(repairedFilesReviewScope(repo, repo, from, from), null, 'unchanged candidate: no scope');
});

await check('V3 review.round2Lanes: off/malformed = resume reviewer threads; fresh = never resume', async () => {
  const { reviewerRound2LanesFresh } = await load('core/managed-host-run.js');
  assert.equal(reviewerRound2LanesFresh(OFF()), false);
  assert.equal(reviewerRound2LanesFresh(projectWith({ review: { round2Lanes: 'bogus' } })), false);
  assert.equal(reviewerRound2LanesFresh(projectWith({ review: { round2Lanes: 'fresh' } })), true);
});

const findingStore = (findings, items = []) => ({ readFindings: () => ({ findings }), readChecklist: () => ({ items }) });
const findings = [
  { id: 'B-1:F-001', status: 'open', severity: 'medium', category: 'test', desc: 'Reverse("") untested' },
  { id: 'B-1:F-002', status: 'open', severity: 'medium', category: 'test', desc: 'Upper("") untested' },
];

await check('V4 remediation.grouping: off = host_run refuses a grouped repair; single = one run binds every finding + the A/B evidence; commits must name each finding', async () => {
  const { resolveGroupedManagedDispatch } = await load('handlers/host-run.js');
  const { commitMessageNamesFinding } = await load('core/ab-dispatch-grouping.js');
  const args = { storyId: 'B-1', agentType: 'proof-or-stop-finding-repair', itemId: null, findingId: 'B-1:F-001', groupFindingIds: ['B-1:F-001', 'F-002'] };
  assert.equal(resolveGroupedManagedDispatch({ root: OFF(), store: findingStore(findings) }, { ...args, groupFindingIds: undefined }), null, 'no group: production single target');
  assert.throws(() => resolveGroupedManagedDispatch({ root: OFF(), store: findingStore(findings) }, args), /requires the experimental A\/B switch remediation\.grouping="single"/);
  const on = projectWith({ remediation: { grouping: 'single' } });
  const grouped = resolveGroupedManagedDispatch({ root: on, store: findingStore(findings) }, args);
  assert.deepEqual(grouped.target, { groupFindingIds: ['B-1:F-001', 'B-1:F-002'], abVariant: { schema: 'proof-or-stop.ab-variants.v1', flags: { 'remediation.grouping': 'single' } } });
  assert.match(grouped.section.join('\n'), /F-002 \[severity=medium/);
  assert.throws(() => resolveGroupedManagedDispatch({ root: on, store: findingStore([findings[0], { ...findings[1], status: 'resolved' }]) }, args), /open finding/);
  assert.ok(commitMessageNamesFinding('B-1 F-002: resolve finding', 'B-1', 'B-1:F-002'));
  assert.ok(!commitMessageNamesFinding('B-1 F-0020: resolve finding', 'B-1', 'B-1:F-002'));
  assert.ok(!commitMessageNamesFinding('B-1 F-001: resolve finding', 'B-1', 'B-1:F-002'));
});

await check('V5 implementation.grouping: off = host_run refuses a grouped implementer; files = items sharing declared files in one run', async () => {
  const { resolveGroupedManagedDispatch } = await load('handlers/host-run.js');
  const { sharedFileItemGroup } = await load('core/ab-dispatch-grouping.js');
  const files = { modify: ['strs/strs.go'], create: [], test: ['strs/strs_test.go'] };
  const items = [
    { id: 'CHK-001', title: 'Upper', status: 'in_progress', files },
    { id: 'CHK-002', title: 'Reverse', status: 'in_progress', files },
    { id: 'CHK-003', title: 'Docs', status: 'in_progress', files: { modify: ['docs/x.md'], create: [], test: [] } },
  ];
  assert.deepEqual(sharedFileItemGroup(items[0], items).map(item => item.id), ['CHK-001', 'CHK-002']);
  const args = { storyId: 'B-1', agentType: 'proof-or-stop-implementer', itemId: 'CHK-001', findingId: null, groupItemIds: ['CHK-001', 'CHK-002'] };
  assert.throws(() => resolveGroupedManagedDispatch({ root: OFF(), store: findingStore([], items) }, args), /requires the experimental A\/B switch implementation\.grouping="files"/);
  const on = projectWith({ implementation: { grouping: 'files' } });
  const grouped = resolveGroupedManagedDispatch({ root: on, store: findingStore([], items) }, args);
  assert.deepEqual(grouped.target.groupItemIds, ['CHK-001', 'CHK-002']);
  assert.match(grouped.section.join('\n'), /ONLY for CHK-001/);
  assert.throws(() => resolveGroupedManagedDispatch({ root: on, store: findingStore([], items) }, { ...args, groupItemIds: ['CHK-001', 'CHK-003'] }), /sharing a declared file/);
});

for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
if (failures.length) {
  console.log(`ab-variant-switches: FAIL (${failures.length}: ${failures.map(name => name.split(' ')[0]).join(', ')})`);
  process.exit(1);
}
console.log('ab-variant-switches: PASS');
