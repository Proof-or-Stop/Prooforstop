/**
 * Detection A/B switches (core/ab-variants.ts). Flag absent = production:
 * experimental switches default OFF (the old behavior); review.round2Lanes was
 * adopted and defaults to `fresh`, `resume` is its rollback;
 * remediation.grouping was adopted and defaults to `single`, `per-finding` is
 * its rollback.
 * For each experimental switch: flag absent = the old (production) behavior;
 * flag set = the variant. The end-to-end arms (each reaching DONE through `next`) live in
 * tasks/e2e-review-to-done-smoke.ts (AB / ND-V1..NF-V5).
 *
 *   V1 review.criticOnCleanRound=skip   cleanRoundCriticSkip / criticSkipReplayError
 *   V2 review.round2Scope=repaired-files repairedFilesReviewScope (changed files + direct callers)
 *   V3 review.round2Lanes (default fresh) reviewerRound2LanesFresh (no reviewer thread resume; resume = rollback)
 *   V4 remediation.grouping (default single) host_run grouped finding repair accepted unless the per-finding rollback is set
 *   V5 implementation.grouping=files     host_run grouped implementer accepted only under the flag
 *   V6 implementation.thread=fresh       host_run seals the arm + appends the item pack; the worker never resumes a code-writer thread
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  assert.deepEqual(off, { criticOnCleanRound: 'run', round2Scope: 'full', round2Lanes: 'fresh', remediationGrouping: 'single', implementationGrouping: 'per-item', implementationThread: 'resume' });
  assert.equal(abVariantEvidence(off), undefined);
  assert.throws(() => resolveAbVariants({ review: { criticOnCleanRound: 'always' } }), /invalid_ab_variant_config: review\.criticOnCleanRound/);
  const on = resolveAbVariants({ review: { criticOnCleanRound: 'skip' }, remediation: { grouping: 'per-finding' } });
  assert.deepEqual(abVariantEvidence(on), { schema: 'proof-or-stop.ab-variants.v1', flags: { 'review.criticOnCleanRound': 'skip', 'remediation.grouping': 'per-finding' } });
  assert.equal(abVariantEvidence(resolveAbVariants({ remediation: { grouping: 'single' } })), undefined, 'grouped remediation is production: not recorded');
  assert.equal(abVariantEvidence(resolveAbVariants({ review: { round2Lanes: 'fresh' } })), undefined, 'fresh lanes are production: not recorded');
  assert.deepEqual(abVariantEvidence(resolveAbVariants({ review: { round2Lanes: 'resume' } })), { schema: 'proof-or-stop.ab-variants.v1', flags: { 'review.round2Lanes': 'resume' } }, 'the rollback is recorded');
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

await check('V3 review.round2Lanes (adopted): absent/malformed/fresh = never resume reviewer threads; resume = rollback', async () => {
  const { reviewerRound2LanesFresh } = await load('core/managed-host-run.js');
  assert.equal(reviewerRound2LanesFresh(OFF()), true, 'production default: fresh later-round lanes');
  assert.equal(reviewerRound2LanesFresh(projectWith({ review: { round2Lanes: 'bogus' } })), true, 'malformed keeps production');
  assert.equal(reviewerRound2LanesFresh(projectWith({ review: { round2Lanes: 'fresh' } })), true);
  assert.equal(reviewerRound2LanesFresh(projectWith({ review: { round2Lanes: 'resume' } })), false, 'rollback resumes');
});

const findingStore = (findings, items = []) => ({ readFindings: () => ({ findings }), readChecklist: () => ({ items }) });
const findings = [
  { id: 'B-1:F-001', status: 'open', severity: 'medium', category: 'test', desc: 'Reverse("") untested' },
  { id: 'B-1:F-002', status: 'open', severity: 'medium', category: 'test', desc: 'Upper("") untested' },
];

await check('V4 remediation.grouping (adopted): absent/single = one run binds every finding (no A/B evidence); per-finding rollback = host_run refuses a group; commits must name each finding', async () => {
  const { resolveGroupedManagedDispatch } = await load('handlers/host-run.js');
  const { commitMessageNamesFinding, remediationGroupingSingle } = await load('core/ab-dispatch-grouping.js');
  assert.equal(remediationGroupingSingle(OFF()), true, 'production default: grouped remediation');
  assert.equal(remediationGroupingSingle(projectWith({ remediation: { grouping: 'single' } })), true);
  assert.equal(remediationGroupingSingle(projectWith({ remediation: { grouping: 'per-finding' } })), false, 'rollback: one repair per finding');
  assert.equal(remediationGroupingSingle(projectWith({ remediation: { grouping: 'bogus' } })), false, 'malformed: next proposes no group host_run would refuse');
  const args = { storyId: 'B-1', agentType: 'proof-or-stop-finding-repair', itemId: null, findingId: 'B-1:F-001', groupFindingIds: ['B-1:F-001', 'F-002'] };
  assert.equal(resolveGroupedManagedDispatch({ root: OFF(), store: findingStore(findings) }, { ...args, groupFindingIds: undefined }), null, 'no group: single target');
  const grouped = resolveGroupedManagedDispatch({ root: OFF(), store: findingStore(findings) }, args);
  assert.deepEqual(grouped.target, { groupFindingIds: ['B-1:F-001', 'B-1:F-002'] }, 'production group carries no A/B evidence');
  assert.match(grouped.section.join('\n'), /F-002 \[severity=medium/);
  assert.doesNotMatch(grouped.section.join('\n'), /experimental/);
  const withOther = resolveGroupedManagedDispatch({ root: projectWith({ review: { round2Lanes: 'resume' } }), store: findingStore(findings) }, args);
  assert.deepEqual(withOther.target.abVariant, { schema: 'proof-or-stop.ab-variants.v1', flags: { 'review.round2Lanes': 'resume' } }, 'another non-default switch is still recorded on the run');
  const rollback = projectWith({ remediation: { grouping: 'per-finding' } });
  assert.throws(() => resolveGroupedManagedDispatch({ root: rollback, store: findingStore(findings) }, args), /refused under the rollback remediation\.grouping="per-finding"/);
  assert.throws(() => resolveGroupedManagedDispatch({ root: projectWith({ remediation: { grouping: 'bogus' } }), store: findingStore(findings) }, args), /invalid_ab_variant_config: remediation\.grouping/);
  assert.throws(() => resolveGroupedManagedDispatch({ root: OFF(), store: findingStore([findings[0], { ...findings[1], status: 'resolved' }]) }, args), /open finding/);
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

await check('V6 implementation.thread: off = resume the Story code-writer thread, no pack, target unchanged; fresh = sealed arm, item/repair pack, never resume', async () => {
  const { resolveAbVariants, abVariantEvidence } = await load('core/ab-variants.js');
  const { resolveFreshImplementerThread } = await load('handlers/host-run.js');
  const { managedResumeSessionForSpec } = await load('core/managed-host-run.js');
  const { ITEM_PACK_MAX_BYTES } = await load('core/implementer-item-pack.js');
  assert.deepEqual(abVariantEvidence(resolveAbVariants({ implementation: { thread: 'fresh' } })), { schema: 'proof-or-stop.ab-variants.v1', flags: { 'implementation.thread': 'fresh' } });
  assert.equal(abVariantEvidence(resolveAbVariants({ implementation: { thread: 'resume' } })), undefined, 'resume is production: not recorded');
  assert.throws(() => resolveAbVariants({ implementation: { thread: 'new' } }), /invalid_ab_variant_config: implementation\.thread/);

  // A git repo with a Story base, one committed item, and a store stand-in.
  const repo = mkdtempSync(join(tmpdir(), 'ab-v6-'));
  dirs.push(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  mkdirSync(join(repo, 'strs'));
  writeFileSync(join(repo, 'strs/strs.go'), 'package strs\n\nfunc Upper(s string) string {\n\treturn s\n}\n');
  writeFileSync(join(repo, 'strs/strs_test.go'), 'package strs\n');
  git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  git('checkout', '-q', '-b', 'story/B-1');
  writeFileSync(join(repo, 'strs/strs.go'), 'package strs\n\nimport "strings"\n\nfunc Upper(s string) string {\n\treturn strings.ToUpper(s)\n}\n');
  git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'B-1 CHK-001: Upper');
  const storyDir = join(repo, 'docs/story/B-1');
  mkdirSync(storyDir, { recursive: true });
  const files = { modify: ['strs/strs.go'], create: [], test: ['strs/strs_test.go'] };
  const items = [
    { id: 'CHK-001', title: 'Upper', status: 'done', files },
    { id: 'CHK-002', title: 'Reverse', status: 'in_progress', files, verificationIntent: { happy: [{ id: 'CHK-002:happy:0', desc: 'reverse', verification: { command: 'go test ./strs -run TestReverse', selector: 'TestReverse' } }] } },
  ];
  const v6Findings = [{ id: 'B-1:F-001', status: 'open', severity: 'medium', category: 'edge', desc: 'strs/strs.go:6 Upper("") is untested for CHK-002', files: ['strs/strs.go'] }];
  const store = {
    readStory: () => { throw new Error('no story metadata in this fixture'); },
    readChecklist: () => ({ items }),
    readFindings: () => ({ findings: v6Findings }),
    storyDirRel: () => 'docs/story',
    storyFilePath: (id, file) => join(storyDir, file),
  };
  // loadConfig caches per root: the off/malformed arms use their own project roots.
  const itemArgs = { storyId: 'B-1', agentType: 'proof-or-stop-implementer', itemId: 'CHK-002', findingId: null };
  assert.equal(resolveFreshImplementerThread({ root: OFF(), store }, itemArgs), null, 'switch off: no pack, no evidence (production byte-identical)');
  assert.equal(resolveFreshImplementerThread({ root: projectWith({ implementation: { thread: 'resume' } }), store }, itemArgs), null, 'explicit resume: production');
  assert.equal(resolveFreshImplementerThread({ root: projectWith({ implementation: { thread: 'bogus' } }), store }, itemArgs), null, 'malformed: production');
  writeFileSync(join(repo, 'proof-or-stop.config.json'), JSON.stringify({ implementation: { thread: 'fresh' } }));
  const on = { root: repo, store };
  const fresh = resolveFreshImplementerThread(on, itemArgs);
  assert.deepEqual(fresh.abVariant.flags, { 'implementation.thread': 'fresh' });
  const pack = fresh.section.join('\n');
  assert.match(pack, /BEGIN ITEM PACK/);
  assert.match(pack, /This is a FRESH session/);
  assert.match(pack, /- CHK-001 \[done\] Upper/, 'prior item one-liner');
  assert.match(pack, /commit [0-9a-f]+ B-1 CHK-001: Upper/, 'Story commits so far');
  assert.match(pack, /strs\/strs\.go \| /, 'diff stat');
  assert.match(pack, /\+\treturn strings\.ToUpper\(s\)/, 'hunks of the declared file');
  assert.match(pack, /### strs\/strs\.go \(whole file/, 'declared file content');
  assert.ok(fresh.bytes <= ITEM_PACK_MAX_BYTES, `pack bounded (${fresh.bytes} <= ${ITEM_PACK_MAX_BYTES})`);
  const repair = resolveFreshImplementerThread(on, { storyId: 'B-1', agentType: 'proof-or-stop-finding-repair', itemId: null, findingId: 'B-1:F-001' });
  const repairPack = repair.section.join('\n');
  assert.match(repairPack, /F-001 \[severity=medium, category=edge, evidence=verified/);
  assert.match(repairPack, /go test \.\/strs -run TestReverse/, 'pinned command of the item the finding touches');
  assert.match(repairPack, /\+\treturn strings\.ToUpper\(s\)/, 'repair diff context');
  assert.equal(resolveFreshImplementerThread(on, { ...itemArgs, agentType: 'proof-or-stop-review-scope-plan', itemId: null }), null, 'only code writers');

  // The worker's resume decision: an earlier completed implementer run with a kept rollout.
  const thread = '11111111-2222-3333-4444-555555555555';
  const codexHome = join(repo, '.codex-home');
  mkdirSync(join(codexHome, 'sessions', '2026'), { recursive: true });
  writeFileSync(join(codexHome, 'sessions', '2026', `rollout-x-${thread}.jsonl`), '{}\n');
  const earlier = join(repo, '.proof-or-stop', 'runtime', 'host-runs', 'run-earlier');
  mkdirSync(earlier, { recursive: true });
  writeFileSync(join(earlier, 'spec.json'), JSON.stringify({ host: 'codex', profile: 'managed_dispatch', storyId: 'B-1', cwd: repo, model: 'm', agentType: 'proof-or-stop-implementer' }));
  writeFileSync(join(earlier, 'terminal.json'), JSON.stringify({ state: 'completed', terminalAt: '2026-10-08T00:00:00.000Z' }));
  writeFileSync(join(earlier, 'live-output.jsonl'), JSON.stringify({ type: 'thread.started', thread_id: thread }) + '\n');
  const spec = { runId: 'run-now', host: 'codex', profile: 'managed_dispatch', storyId: 'B-1', agentType: 'proof-or-stop-implementer', cwd: repo, root: repo, model: 'm' };
  assert.equal(managedResumeSessionForSpec({ ...spec, managedDispatchTarget: { itemId: 'CHK-002' } }, codexHome), thread, 'switch off: resume the Story thread');
  assert.equal(managedResumeSessionForSpec({ ...spec, managedDispatchTarget: { itemId: 'CHK-002', abVariant: fresh.abVariant } }, codexHome), null, 'fresh: new thread');
  assert.equal(managedResumeSessionForSpec({ ...spec, agentType: 'proof-or-stop-finding-repair', managedDispatchTarget: { findingId: 'B-1:F-001', abVariant: repair.abVariant } }, codexHome), null, 'fresh repair: new thread');
});

for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
if (failures.length) {
  console.log(`ab-variant-switches: FAIL (${failures.length}: ${failures.map(name => name.split(' ')[0]).join(', ')})`);
  process.exit(1);
}
console.log('ab-variant-switches: PASS');
