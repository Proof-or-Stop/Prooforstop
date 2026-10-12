/**
 * Detection A/B switches (core/ab-variants.ts). Flag absent = production:
 * experimental switches default OFF (the old behavior); review.round2Lanes was
 * adopted and defaults to `fresh`, `resume` is its rollback;
 * remediation.grouping was adopted and defaults to `single`, `per-finding` is
 * its rollback; remediation.thread was adopted and defaults to `fresh`
 * (old-PoS run 25), `resume` is its rollback.
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
 *   V7 remediation.thread (default fresh) finding-repair runs start a new Codex thread with the repair pack; `resume` = rollback
 *      (old-PoS run 25: fresh repair 0.86M input vs resumed 2.8-3.9M); implementer items keep implementation.thread (default resume)
 *   V8 review.lanePack=shared           every code-review lane and the inventory critic get ONE framework-built lane pack per round
 *                                        (Story diff, checklist digest, changed files + hashes, candidate route), cached in runtime
 *   V9 review.roundDelta=pack           from round 2 on the pack also carries the delta since the previous round's head
 *                                        (repair commits + diff, earlier findings and their resolutions)
 *   V10 review.deltaRounds=on          a REVIEW round N>=2 after a remediation re-reviews only the repair: the lanes that raised
 *                                        findings re-review in full, the others are replaced by ONE confirmation lane; the critic
 *                                        is skipped on such a round with no finding (core/review-delta-round.ts; plan, scope and
 *                                        fallbacks in tasks/review-delta-round-smoke.ts, end to end in ND-DR*)
 *   V11 review.laneMerge=on            ONE managed review session per round carries every active lane's dimension (the first
 *                                        dimension is the carrier lane; core/review-lane-merge.ts; plan, coverage contract and
 *                                        prompt block in tasks/review-lane-merge-smoke.ts, end to end in NLM*)
 *   Lab plan-light (EXPERIMENTAL, default off; behaviour in tasks/plan-light-smoke.ts, end to end in NPP / NPM-I / NPM-P / NRB):
 *   plan.pinProbe                    example pins probed on the Story base + request-literal examples before PLAN→DEV
 *   plan.reviewMerge                 no INIT reviewers; ONE merged plan review in PLAN; a rerun confirms the changed rows
 *   plan.rowBudget                   one intent row per operand class: guidance + an advisory (never blocking) check
 *   Old-PoS run 43 (`off` = recorded rollback; behaviour in tasks/run43-fixes-smoke.ts S / P):
 *   review.siblingParity             the test-coverage and quality lane prompts carry the sibling-parity check
 *                                    (old-PoS run 58: default OFF, `on` = the recorded arm; tasks/run58-fixes-smoke.ts P)
 *   plan.exclusionRationaleCheck     an excludes entry may not close a scope row whose behaviour another item changes (default ON)
 *   Old-PoS run 46 (default ON; behaviour in tasks/run46-fixes-smoke.ts B):
 *   plan.baseDisagreement            the scope-plan dispatch carries the base-disagreement check
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  assert.deepEqual(off, { criticOnCleanRound: 'run', round2Scope: 'full', round2Lanes: 'fresh', remediationGrouping: 'single', remediationThread: 'fresh', implementationGrouping: 'per-item', implementationThread: 'resume', lanePack: 'off', roundDelta: 'off',
    // Old-PoS run 33: the catch-earlier line is off by default (A/B arms A1-A4).
    coverageMatrix: 'off', scopeDeferral: 'off', pinAuditEnforcement: 'off', probeEnforcement: 'advisory', probeMatrix: 'off',
    // Old-PoS run 43: exclusionRationaleCheck defaults on (`off` = recorded rollback). Old-PoS run 58: siblingParity
    // defaults OFF (runs 46/47/58 with it on: 131 min / timeout / timeout); `on` is the recorded arm.
    siblingParity: 'off', exclusionRationaleCheck: 'on',
    // Old-PoS run 46: the base-disagreement check defaults on.
    baseDisagreement: 'on',
    // EXPERIMENTAL delta review rounds (lab codex/lab-delta-review): off by default.
    deltaRounds: 'off',
    // EXPERIMENTAL lane merge (lab codex/lab-review-merge): off by default.
    laneMerge: 'off',
    // EXPERIMENTAL lab plan-light switches: off by default.
    pinProbe: 'off', reviewMerge: 'off', rowBudget: 'off' });
  assert.equal(abVariantEvidence(off), undefined);
  assert.deepEqual(abVariantEvidence(resolveAbVariants({ plan: { pinProbe: 'on', reviewMerge: 'on', rowBudget: 'on' } })),
    { schema: 'proof-or-stop.ab-variants.v1', flags: { 'plan.pinProbe': 'on', 'plan.reviewMerge': 'on', 'plan.rowBudget': 'on' } }, 'lab plan-light: each arm is recorded');
  assert.equal(abVariantEvidence(resolveAbVariants({ review: { siblingParity: 'off' }, plan: { exclusionRationaleCheck: 'on' } })), undefined, 'the production values are not recorded');
  assert.deepEqual(abVariantEvidence(resolveAbVariants({ review: { siblingParity: 'on' }, plan: { exclusionRationaleCheck: 'off' } })),
    { schema: 'proof-or-stop.ab-variants.v1', flags: { 'review.siblingParity': 'on', 'plan.exclusionRationaleCheck': 'off' } }, 'old-PoS run 58: siblingParity=on is the recorded arm; run 43: the exclusion rollback is recorded');
  assert.throws(() => resolveAbVariants({ review: { siblingParity: 'maybe' } }), /invalid_ab_variant_config: review\.siblingParity/);
  const { siblingParityOn, exclusionRationaleCheckOn } = await load('core/ab-variants.js');
  assert.equal(siblingParityOn({ review: { siblingParity: 'maybe' } }), false, 'malformed keeps the default (off since old-PoS run 58) where it is consumed');
  assert.equal(siblingParityOn({}), false, 'old-PoS run 58: absent = off');
  assert.equal(siblingParityOn({ review: { siblingParity: 'on' } }), true);
  assert.equal(exclusionRationaleCheckOn({ plan: { exclusionRationaleCheck: 7 } }), true, 'malformed keeps the default (on) where it is consumed');
  assert.equal(siblingParityOn({ review: { siblingParity: 'off' } }), false);
  assert.equal(exclusionRationaleCheckOn({ plan: { exclusionRationaleCheck: 'off' } }), false);
  const { baseDisagreementOn } = await load('core/ab-variants.js');
  assert.equal(typeof baseDisagreementOn, 'function', 'old-PoS run 46: baseDisagreementOn is exported');
  assert.equal(baseDisagreementOn({ plan: { baseDisagreement: 'maybe' } }), true, 'malformed keeps the default (on) where it is consumed');
  assert.equal(baseDisagreementOn({ plan: { baseDisagreement: 'off' } }), false);
  assert.deepEqual(abVariantEvidence(resolveAbVariants({ plan: { baseDisagreement: 'off' } })),
    { schema: 'proof-or-stop.ab-variants.v1', flags: { 'plan.baseDisagreement': 'off' } }, 'old-PoS run 46: the rollback is recorded');
  assert.throws(() => resolveAbVariants({ review: { criticOnCleanRound: 'always' } }), /invalid_ab_variant_config: review\.criticOnCleanRound/);
  const on = resolveAbVariants({ review: { criticOnCleanRound: 'skip' }, remediation: { grouping: 'per-finding' } });
  assert.deepEqual(abVariantEvidence(on), { schema: 'proof-or-stop.ab-variants.v1', flags: { 'review.criticOnCleanRound': 'skip', 'remediation.grouping': 'per-finding' } });
  assert.equal(abVariantEvidence(resolveAbVariants({ remediation: { grouping: 'single' } })), undefined, 'grouped remediation is production: not recorded');
  assert.equal(abVariantEvidence(resolveAbVariants({ review: { round2Lanes: 'fresh' } })), undefined, 'fresh lanes are production: not recorded');
  assert.deepEqual(abVariantEvidence(resolveAbVariants({ review: { round2Lanes: 'resume' } })), { schema: 'proof-or-stop.ab-variants.v1', flags: { 'review.round2Lanes': 'resume' } }, 'the rollback is recorded');
  assert.deepEqual(abVariantEvidence(resolveAbVariants({ plan: { coverageMatrix: 'on', scopeDeferral: 'on', pinAuditEnforcement: 'on' }, dev: { probeEnforcement: 'enforce' }, implementation: { probeMatrix: 'on' } })),
    { schema: 'proof-or-stop.ab-variants.v1', flags: { 'plan.coverageMatrix': 'on', 'plan.scopeDeferral': 'on', 'plan.pinAuditEnforcement': 'on', 'dev.probeEnforcement': 'enforce', 'implementation.probeMatrix': 'on' } },
    'old-PoS run 33: every catch-earlier arm is recorded');
  assert.throws(() => resolveAbVariants({ dev: { probeEnforcement: 'loud' } }), /invalid_ab_variant_config: dev\.probeEnforcement/);
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

await check('V7 remediation.thread (adopted): absent = finding repairs start fresh with the repair pack (not recorded); resume = rollback; implementer items unchanged', async () => {
  const { resolveAbVariants, abVariantEvidence } = await load('core/ab-variants.js');
  const { resolveFreshImplementerThread } = await load('handlers/host-run.js');
  const { managedResumeSessionForSpec } = await load('core/managed-host-run.js');
  assert.equal(resolveAbVariants({}).remediationThread, 'fresh', 'production default: fresh repair threads');
  assert.equal(abVariantEvidence(resolveAbVariants({ remediation: { thread: 'fresh' } })), undefined, 'fresh repairs are production: not recorded');
  assert.deepEqual(abVariantEvidence(resolveAbVariants({ remediation: { thread: 'resume' } })), { schema: 'proof-or-stop.ab-variants.v1', flags: { 'remediation.thread': 'resume' } }, 'the rollback is recorded');
  assert.throws(() => resolveAbVariants({ remediation: { thread: 'new' } }), /invalid_ab_variant_config: remediation\.thread/);
  // One git fixture per config (loadConfig caches per root): a Story commit, a repair target, an earlier code-writer run.
  const thread = '66666666-7777-8888-9999-000000000000';
  const fixture = (config) => {
    const repo = mkdtempSync(join(tmpdir(), 'ab-v7-'));
    dirs.push(repo);
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    mkdirSync(join(repo, 'strs'));
    writeFileSync(join(repo, 'strs/strs.go'), 'package strs\n\nfunc Upper(s string) string {\n\treturn s\n}\n');
    git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
    git('checkout', '-q', '-b', 'story/B-7');
    writeFileSync(join(repo, 'strs/strs.go'), 'package strs\n\nimport "strings"\n\nfunc Upper(s string) string {\n\treturn strings.ToUpper(s)\n}\n');
    git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'B-7 CHK-001: Upper');
    writeFileSync(join(repo, 'proof-or-stop.config.json'), JSON.stringify(config));
    const earlier = join(repo, '.proof-or-stop', 'runtime', 'host-runs', 'run-earlier');
    mkdirSync(earlier, { recursive: true });
    writeFileSync(join(earlier, 'spec.json'), JSON.stringify({ host: 'codex', profile: 'managed_dispatch', storyId: 'B-7', cwd: repo, model: 'm', agentType: 'proof-or-stop-implementer' }));
    writeFileSync(join(earlier, 'terminal.json'), JSON.stringify({ state: 'completed', terminalAt: '2026-10-08T00:00:00.000Z' }));
    writeFileSync(join(earlier, 'live-output.jsonl'), JSON.stringify({ type: 'thread.started', thread_id: thread }) + '\n');
    const codexHome = join(repo, '.codex-home');
    mkdirSync(join(codexHome, 'sessions', '2026'), { recursive: true });
    writeFileSync(join(codexHome, 'sessions', '2026', `rollout-x-${thread}.jsonl`), '{}\n');
    const files = { modify: ['strs/strs.go'], create: [], test: [] };
    const store = {
      readStory: () => { throw new Error('no story metadata in this fixture'); },
      readChecklist: () => ({ items: [{ id: 'CHK-001', title: 'Upper', status: 'done', files }] }),
      readFindings: () => ({ findings: [{ id: 'B-7:F-001', status: 'open', severity: 'medium', category: 'edge', desc: 'strs/strs.go:6 Upper("") is untested', files: ['strs/strs.go'] }] }),
      storyDirRel: () => 'docs/story',
      storyFilePath: (id, file) => join(repo, 'docs/story', id, file),
    };
    return { ctx: { root: repo, store }, codexHome, spec: { runId: 'run-now', host: 'codex', profile: 'managed_dispatch', storyId: 'B-7', cwd: repo, root: repo, model: 'm' } };
  };
  const repairArgs = { storyId: 'B-7', agentType: 'proof-or-stop-finding-repair', itemId: null, findingId: 'B-7:F-001' };
  const itemArgs = { storyId: 'B-7', agentType: 'proof-or-stop-implementer', itemId: 'CHK-001', findingId: null };
  // Default: the repair gets the pack and no A/B evidence; the worker starts a fresh thread; items still resume.
  const def = fixture({});
  const repair = resolveFreshImplementerThread(def.ctx, repairArgs);
  assert.ok(repair, 'default: a finding repair carries the repair pack');
  assert.match(repair.section.join('\n'), /This is a FRESH session/);
  assert.match(repair.section.join('\n'), /F-001 \[severity=medium/);
  assert.equal(repair.abVariant, undefined, 'production default: nothing sealed as an A/B arm');
  assert.equal(resolveFreshImplementerThread(def.ctx, itemArgs), null, 'implementer items keep implementation.thread=resume (no pack)');
  assert.equal(managedResumeSessionForSpec({ ...def.spec, agentType: 'proof-or-stop-finding-repair', managedDispatchTarget: { findingId: 'B-7:F-001' } }, def.codexHome), null, 'default: a repair starts a new thread');
  assert.equal(managedResumeSessionForSpec({ ...def.spec, agentType: 'proof-or-stop-implementer', managedDispatchTarget: { itemId: 'CHK-001' } }, def.codexHome), thread, 'default: an implementer item resumes the Story thread');
  // Rollback: remediation.thread=resume restores the resumed repair thread (no pack).
  const back = fixture({ remediation: { thread: 'resume' } });
  assert.equal(resolveFreshImplementerThread(back.ctx, repairArgs), null, 'rollback: no repair pack');
  assert.equal(managedResumeSessionForSpec({ ...back.spec, agentType: 'proof-or-stop-finding-repair', managedDispatchTarget: { findingId: 'B-7:F-001' } }, back.codexHome), thread, 'rollback: the repair resumes the Story thread');
  // The V6 arm still makes repairs fresh even under the rollback (sealed as before).
  const v6 = fixture({ remediation: { thread: 'resume' }, implementation: { thread: 'fresh' } });
  assert.deepEqual(resolveFreshImplementerThread(v6.ctx, repairArgs)?.abVariant?.flags, { 'remediation.thread': 'resume', 'implementation.thread': 'fresh' });
});


/** A Story repo with a base, one implemented item, and (optionally) a repair commit; a duck-typed store over it. */
function lanePackFixture(config, { repaired = false, request = true } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'ab-lanepack-'));
  dirs.push(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const commit = (msg) => { git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg); return git('rev-parse', 'HEAD'); };
  git('init', '-q', '-b', 'main');
  mkdirSync(join(repo, 'strs'));
  writeFileSync(join(repo, 'strs/strs.go'), 'package strs\n\nfunc Upper(s string) string {\n\treturn s\n}\n');
  writeFileSync(join(repo, 'strs/strs_test.go'), 'package strs\n');
  commit('base');
  git('checkout', '-q', '-b', 'story/B-8');
  writeFileSync(join(repo, 'strs/strs.go'), 'package strs\n\nimport "strings"\n\nfunc Upper(s string) string {\n\treturn strings.ToUpper(s)\n}\n');
  const round1Head = commit('B-8 CHK-001: Upper');
  let head = round1Head;
  if (repaired) {
    writeFileSync(join(repo, 'strs/strs_test.go'), 'package strs\n\nimport "testing"\n\nfunc TestUpperEmpty(t *testing.T) {\n\tif Upper("") != "" {\n\t\tt.Fatal("empty")\n\t}\n}\n');
    head = commit('B-8 F-001: resolve finding');
  }
  const storyDir = join(repo, 'docs/story/B-8');
  mkdirSync(storyDir, { recursive: true });
  if (request) {
    const text = 'Add Upper(s) that upper-cases s. Upper("") returns "".\n';
    writeFileSync(join(storyDir, 'request.md'), text);
    const { createHash } = awaitCrypto;
    writeFileSync(join(storyDir, 'request.json'), JSON.stringify({ sha256: createHash('sha256').update(text).digest('hex'), bytes: text.length, truncated: false }));
  }
  writeFileSync(join(repo, 'proof-or-stop.config.json'), JSON.stringify(config));
  const files = { modify: ['strs/strs.go'], create: [], test: ['strs/strs_test.go'] };
  const items = [{
    id: 'CHK-001', title: 'Upper', status: 'done', files,
    verificationIntent: { happy: [{ id: 'CHK-001:happy:0', desc: 'Upper("ab") == "AB"', type: 'logic', verification: { command: 'go test ./strs -run TestUpper', selector: 'TestUpper' } }] },
    verificationEvidence: [{ intentRef: 'CHK-001:happy:0', kind: 'logic_test', result: 'pass', mechanical: true, command: 'go test ./strs -run TestUpper', note: 'ok', headHash: round1Head }],
  }];
  const reviewRuns = [
    { storyId: 'B-8', reviewRunId: 'B-8:RR-001', lane: 'proof-or-stop-review-quality', startedAt: '2026-10-09T00:00:01.000Z', headHash: round1Head, materialHash: 'm1', reviewRound: '2026-10-09T00:00:00.000Z' },
    ...(repaired ? [{ storyId: 'B-8', reviewRunId: 'B-8:RR-003', lane: 'proof-or-stop-review-quality', startedAt: '2026-10-09T01:00:01.000Z', headHash: head, materialHash: 'm2', reviewRound: '2026-10-09T01:00:00.000Z' }] : []),
  ];
  const findings = [{ id: 'B-8:F-001', status: repaired ? 'resolved' : 'open', severity: 'medium', category: 'edge', agent: 'proof-or-stop-review-quality', reviewRunId: 'B-8:RR-001', desc: 'strs/strs.go:6 Upper("") is untested', files: ['strs/strs.go'], ...(repaired ? { resolvedReason: 'TestUpperEmpty added [repair commit abc1234]' } : {}) }];
  const candidate = { artifactDigest: 'sha256:' + 'a'.repeat(64), corpusDigest: 'sha256:' + 'b'.repeat(64), mode: 'enforce', fullScan: false, scanEscalationReason: null, requiresEscalation: false, escalationReasons: [],
    candidateSpecSet: ['docs/strings.md'], candidates: [{ path: 'docs/strings.md', contentHash: 'sha256:' + 'c'.repeat(64), score: 3, reasons: [] }] };
  const store = {
    readStory: () => { throw new Error('no story metadata in this fixture'); },
    readChecklist: () => ({ items }),
    readFindings: () => ({ findings }),
    readReviewRuns: () => ({ runs: reviewRuns }),
    readCandidateSpecSet: () => candidate,
    storyDirRel: () => 'docs/story',
    storyFilePath: (id, file) => join(repo, 'docs/story', id, file),
  };
  return { repo, store, head, round1Head, runs: reviewRuns, git };
}
const awaitCrypto = await import('node:crypto');

await check('V8 review.lanePack: off/malformed = no pack (production prompt); shared = one bounded framework pack per round for every code-review lane and the critic', async () => {
  const { resolveAbVariants, abVariantEvidence } = await load('core/ab-variants.js');
  const { resolveReviewLanePack, LANE_PACK_MAX_BYTES } = await load('core/review-lane-pack.js');
  assert.equal(resolveAbVariants({}).lanePack, 'off');
  assert.equal(resolveAbVariants({}).roundDelta, 'off');
  assert.deepEqual(abVariantEvidence(resolveAbVariants({ review: { lanePack: 'shared' } })), { schema: 'proof-or-stop.ab-variants.v1', flags: { 'review.lanePack': 'shared' } });
  assert.throws(() => resolveAbVariants({ review: { lanePack: 'yes' } }), /invalid_ab_variant_config: review\.lanePack/);
  const laneRun = (f) => ({ storyId: 'B-8', reviewRunId: 'B-8:RR-002', lane: 'proof-or-stop-review-behavior', startedAt: '2026-10-09T00:00:02.000Z', headHash: f.head, materialHash: 'm1', reviewRound: '2026-10-09T00:00:00.000Z' });
  for (const config of [{}, { review: { lanePack: 'off' } }, { review: { lanePack: 'bogus' } }]) {
    const f = lanePackFixture(config);
    assert.equal(resolveReviewLanePack(f.repo, laneRun(f), { store: f.store }), null, `${JSON.stringify(config)}: no pack`);
  }
  const f = lanePackFixture({ review: { lanePack: 'shared' } });
  const pack = resolveReviewLanePack(f.repo, laneRun(f), { store: f.store });
  assert.ok(pack, 'shared: a pack');
  assert.deepEqual(pack.abVariant.flags, { 'review.lanePack': 'shared' });
  const text = pack.lines.join('\n');
  assert.match(text, /^--- BEGIN REVIEW LANE PACK \(A\/B review\.lanePack=shared, experimental; B-8 candidate [0-9a-f]{12}\) ---/m);
  assert.match(text, /authoritative/, 'states that the pack is authoritative for its facts');
  assert.match(text, /keep probing|probe/i, 'lanes keep probing the code');
  assert.match(text, /\+\treturn strings\.ToUpper\(s\)/, 'Story diff hunks');
  assert.match(text, /strs\/strs\.go \[M\] sha256=[0-9a-f]{64}/, 'changed file with its hash');
  assert.match(text, /CHK-001:happy:0 \[logic\] Upper\("ab"\) == "AB"/, 'checklist intent');
  assert.match(text, /pin: `go test \.\/strs -run TestUpper`/, 'pinned command');
  assert.match(text, /evidence: logic_test pass mechanical @[0-9a-f]{7}/, 'verification evidence summary');
  assert.match(text, /candidateSpecSetDigest=sha256:a{64}/, 'candidate route digests');
  assert.match(text, /docs\/strings\.md/, 'candidate spec list');
  assert.match(text, /request\.md.*sha256=/, 'request reference');
  assert.doesNotMatch(text, /Delta since the previous round/, 'no delta without review.roundDelta');
  assert.ok(pack.bytes <= LANE_PACK_MAX_BYTES, `bounded (${pack.bytes} <= ${LANE_PACK_MAX_BYTES})`);
  assert.equal(Buffer.byteLength(text, 'utf8'), pack.bytes);
  assert.ok(existsSync(pack.path) && readFileSync(pack.path, 'utf8') === text, 'written to the runtime pack file');
  assert.match(pack.path, /\.proof-or-stop\/runtime\/review-lane-packs\/B-8\//);
  assert.equal(pack.cached, false);
  // Same round, another lane and the inventory critic: the same file, not recomputed.
  const other = resolveReviewLanePack(f.repo, { ...laneRun(f), reviewRunId: 'B-8:RR-004', lane: 'proof-or-stop-review-concept' }, { store: f.store });
  assert.equal(other.path, pack.path);
  assert.equal(other.cached, true, 'computed once per round');
  assert.equal(other.lines.join('\n'), text);
  const critic = resolveReviewLanePack(f.repo, { ...laneRun(f), reviewRunId: 'B-8:RR-005', lane: 'proof-or-stop-review-topology-critic', reviewPurpose: 'inventory-completeness' }, { store: f.store });
  assert.equal(critic?.path, pack.path, 'the inventory critic gets the same pack');
  assert.equal(resolveReviewLanePack(f.repo, { ...laneRun(f), reviewRunId: 'B-8:RR-006', lane: 'proof-or-stop-review-topology-critic' }, { store: f.store }), null, 'topology-proof critic: no pack');
});

await check('V9 review.roundDelta=pack: round 1 = no delta; round 2+ = delta (repair commits, repair diff, findings + resolutions) and still the whole Story', async () => {
  const { resolveAbVariants, abVariantEvidence } = await load('core/ab-variants.js');
  const { resolveReviewLanePack } = await load('core/review-lane-pack.js');
  assert.deepEqual(abVariantEvidence(resolveAbVariants({ review: { roundDelta: 'pack' } })), { schema: 'proof-or-stop.ab-variants.v1', flags: { 'review.roundDelta': 'pack' } });
  assert.throws(() => resolveAbVariants({ review: { roundDelta: 'full' } }), /invalid_ab_variant_config: review\.roundDelta/);
  const round2Run = (f) => ({ storyId: 'B-8', reviewRunId: 'B-8:RR-007', lane: 'proof-or-stop-review-behavior', startedAt: '2026-10-09T01:00:02.000Z', headHash: f.head, materialHash: 'm2', reviewRound: '2026-10-09T01:00:00.000Z' });
  const off = lanePackFixture({ review: { lanePack: 'shared' } }, { repaired: true });
  assert.doesNotMatch(resolveReviewLanePack(off.repo, round2Run(off), { store: off.store }).lines.join('\n'), /Delta since the previous round/, 'roundDelta off: no delta');
  assert.equal(resolveReviewLanePack(lanePackFixture({ review: { roundDelta: 'bogus' } }, { repaired: true }).repo, round2Run(off), { store: off.store }), null, 'malformed: production');
  const f = lanePackFixture({ review: { lanePack: 'shared', roundDelta: 'pack' } }, { repaired: true });
  const pack = resolveReviewLanePack(f.repo, round2Run(f), { store: f.store });
  assert.deepEqual(pack.abVariant.flags, { 'review.lanePack': 'shared', 'review.roundDelta': 'pack' });
  assert.equal(pack.delta?.fromHead, f.round1Head, 'delta from the previous round head');
  const text = pack.lines.join('\n');
  assert.match(text, /## Delta since the previous round/);
  assert.match(text, /commit [0-9a-f]+ B-8 F-001: resolve finding/, 'repair commits');
  assert.match(text, /\+func TestUpperEmpty/, 'repair diff');
  assert.match(text, /F-001 \[severity=medium, status=resolved, lane=proof-or-stop-review-quality\]/, 'earlier finding');
  assert.match(text, /resolution: TestUpperEmpty added/, 'its resolution');
  assert.match(text, /[Ss]tart from (this|the) delta[\s\S]*whole Story/, 'start from the delta but review the whole Story');
  assert.match(text, /\+\treturn strings\.ToUpper\(s\)/, 'shared Story diff still present');
  // Round 1 under roundDelta=pack: no earlier round, no delta.
  const r1 = lanePackFixture({ review: { lanePack: 'shared', roundDelta: 'pack' } });
  const r1Pack = resolveReviewLanePack(r1.repo, { storyId: 'B-8', reviewRunId: 'B-8:RR-002', lane: 'proof-or-stop-review-behavior', startedAt: '2026-10-09T00:00:02.000Z', headHash: r1.head, materialHash: 'm1', reviewRound: '2026-10-09T00:00:00.000Z' }, { store: r1.store });
  assert.equal(r1Pack.delta, null);
  assert.doesNotMatch(r1Pack.lines.join('\n'), /Delta since the previous round/);
  // roundDelta alone (lanePack off): a delta-only pack from round 2 on, none in round 1.
  const only = lanePackFixture({ review: { roundDelta: 'pack' } }, { repaired: true });
  const onlyPack = resolveReviewLanePack(only.repo, round2Run(only), { store: only.store });
  assert.match(onlyPack.lines.join('\n'), /## Delta since the previous round/);
  assert.doesNotMatch(onlyPack.lines.join('\n'), /## Story diff/, 'lanePack off: no shared sections');
  const onlyR1 = lanePackFixture({ review: { roundDelta: 'pack' } });
  assert.equal(resolveReviewLanePack(onlyR1.repo, { storyId: 'B-8', reviewRunId: 'B-8:RR-002', lane: 'proof-or-stop-review-behavior', startedAt: '2026-10-09T00:00:02.000Z', headHash: onlyR1.head, materialHash: 'm1', reviewRound: '2026-10-09T00:00:00.000Z' }, { store: onlyR1.store }), null, 'roundDelta alone in round 1: no pack');
});

await check('V10 review.deltaRounds: off/malformed = no delta round and no delta critic skip; on = recorded arm, clean delta-round wave skips the critic, replay refuses once the flag is removed', async () => {
  const { resolveAbVariants, abVariantEvidence, deltaRoundsOn } = await load('core/ab-variants.js');
  assert.equal(resolveAbVariants({}).deltaRounds, 'off');
  assert.deepEqual(abVariantEvidence(resolveAbVariants({ review: { deltaRounds: 'on' } })), { schema: 'proof-or-stop.ab-variants.v1', flags: { 'review.deltaRounds': 'on' } });
  assert.equal(abVariantEvidence(resolveAbVariants({ review: { deltaRounds: 'off' } })), undefined, 'off is production: not recorded');
  assert.throws(() => resolveAbVariants({ review: { deltaRounds: 'yes' } }), /invalid_ab_variant_config: review\.deltaRounds/);
  assert.equal(deltaRoundsOn({ review: { deltaRounds: 'yes' } }), false, 'malformed keeps production where it is consumed');
  assert.equal(deltaRoundsOn({ review: { deltaRounds: 'on' } }), true);
  const { cleanRoundCriticSkip, criticSkipReplayError } = await load('core/review-inventory-critic-skip.js');
  const deltaEpoch = { ...epoch, rosterBasis: JSON.stringify({ kind: 'delta-round', planDigest: 'a'.repeat(64) }) };
  const on = projectWith({ review: { deltaRounds: 'on' } });
  assert.equal(cleanRoundCriticSkip(OFF(), deltaEpoch, cleanEvaluation()), undefined, 'flag off: critic required');
  assert.equal(cleanRoundCriticSkip(projectWith({ review: { deltaRounds: 'bogus' } }), deltaEpoch, cleanEvaluation()), undefined, 'malformed: critic required');
  assert.equal(cleanRoundCriticSkip(on, epoch, cleanEvaluation()), undefined, 'not a delta-round epoch: critic required');
  const skip = cleanRoundCriticSkip(on, deltaEpoch, cleanEvaluation());
  assert.ok(skip, 'delta-round epoch + clean first wave: skip');
  assert.match(skip.reason, /review\.deltaRounds=on/);
  assert.equal(skip.abVariant.flags['review.deltaRounds'], 'on');
  assert.equal(cleanRoundCriticSkip(on, deltaEpoch, { ...cleanEvaluation(), lanes: [lane('a'), lane('b', 'finding')] }), undefined, 'a finding (a new finding of the round): critic runs');
  assert.equal(criticSkipReplayError(on, deltaEpoch, skip, cleanEvaluation()), undefined, 'replay accepts while flag set, epoch delta and wave clean');
  assert.match(criticSkipReplayError(OFF(), deltaEpoch, skip, cleanEvaluation()) ?? '', /no longer set/, 'replay refuses once the flag is removed');
  assert.match(criticSkipReplayError(on, epoch, skip, cleanEvaluation()) ?? '', /delta/, 'replay refuses a skip on a non-delta epoch');
});

await check('V11 review.laneMerge: off/malformed = every lane its own session (no merged prompt); on = recorded arm', async () => {
  const { resolveAbVariants, abVariantEvidence, laneMergeOn } = await load('core/ab-variants.js');
  assert.equal(resolveAbVariants({}).laneMerge, 'off');
  assert.deepEqual(abVariantEvidence(resolveAbVariants({ review: { laneMerge: 'on' } })), { schema: 'proof-or-stop.ab-variants.v1', flags: { 'review.laneMerge': 'on' } });
  assert.equal(abVariantEvidence(resolveAbVariants({ review: { laneMerge: 'off' } })), undefined, 'off is production: not recorded');
  assert.throws(() => resolveAbVariants({ review: { laneMerge: 'yes' } }), /invalid_ab_variant_config: review\.laneMerge/);
  assert.equal(laneMergeOn({ review: { laneMerge: 'yes' } }), false, 'malformed keeps production where it is consumed');
  assert.equal(laneMergeOn({}), false);
  assert.equal(laneMergeOn({ review: { laneMerge: 'on' } }), true);
  const { laneMergeVariant } = await load('core/review-lane-merge.js');
  assert.equal(laneMergeVariant(OFF()), undefined, 'flag off: no merge');
  assert.equal(laneMergeVariant(projectWith({ review: { laneMerge: 'bogus' } })), undefined, 'malformed: no merge');
  assert.equal(laneMergeVariant(projectWith({ review: { laneMerge: 'on' } }))?.flags?.['review.laneMerge'], 'on', 'on: the arm is recorded in the evidence');
});

for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
if (failures.length) {
  console.log(`ab-variant-switches: FAIL (${failures.length}: ${failures.map(name => name.split(' ')[0]).join(', ')})`);
  process.exit(1);
}
console.log('ab-variant-switches: PASS');
