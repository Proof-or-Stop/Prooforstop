#!/usr/bin/env node
/**
 * Run 19 (abs-stepped-slices, B-8166; bench-staging/oldpos/run19-cost-analysis.md
 * §2 and §5): PLAN ran the scope-plan reviewer twice and the owner spent 9
 * story_review calls.
 *
 *   P1  `next` launched the scope-plan reviewer before PLAN authoring, while
 *       deterministic blockers (missing intent lanes, unpinned intents, the
 *       story_create request-literal pre-check) were still open, so the
 *       reviewer judged a checklist that was about to change and had to rerun.
 *       Contract: while the verdict is missing (or must be rerun), `next`
 *       first returns ONE plan_authoring batch with an exact checklist_update
 *       per item that names every deterministic blocker, and launches the
 *       reviewer only when they are clear.
 *   P2  A stale verdict (scope-check.json checklistDigest != current checklist,
 *       gaps open) sent the owner to story_review. Contract: `next` returns the
 *       scope-plan relaunch itself; it is a framework step when the selection is
 *       bound and the stale verdict came from the last completed run.
 *   P3  The brief story_review view cut the `Next:` remedy ("…Next (PLAN, no
 *       INI…"). Contract: the remedy is never truncated; identical remedies
 *       are printed once.
 *   P4  story_create accepted unclassified intents that PLAN later refuses
 *       ([verification_intent_metadata_required]); the refusal must name the
 *       exact missing field. The request-literal warning at story_create must
 *       be actionable (exact command; userSees is editable in INIT and PLAN),
 *       never a reason to recreate the Story.
 *
 * Usage: node packages/main/dist/tasks/plan-author-before-scope-smoke.js
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, ChecklistItem, StoryInfo } from '../core/types.js';
import { writeStoryRequest } from '../core/story-request.js';
import { createMainRegistry } from '../registry.js';
import { createNextDriver, type NextStep } from '../handlers/next-driver.js';
import { createReferenceNextDriver } from './helpers/next-driver-reference.js';
import { isDeepStrictEqual } from 'node:util';
import { createScopeCheckHandlers } from '../handlers/scope-check.js';
import { createStoryReviewHandlers } from '../handlers/story-review.js';
import { createStoryCreateHandlers } from '../handlers/story-create.js';
import * as scopeRequirement from '../core/plan-scope-check-requirement.js';
import * as classification from '../core/verification-intent-classification.js';
import { MAIN_TOOLS } from '../cli/command-catalog.js';

const STORY_DIR = '.proof-or-stop/story/actives';
const SCOPE_REVIEWER = 'proof-or-stop-review-scope-plan';
const failures: string[] = [];
function check(ok: boolean, message: string, detail = ''): boolean {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${message}${ok || !detail ? '' : `\n         ${detail.slice(0, 2500).replace(/\n/g, '\n         ')}`}`);
  if (!ok) failures.push(message);
  return ok;
}
function attempt(label: string, fn: () => void): void {
  try { fn(); } catch (error) { check(false, `${label} threw`, error instanceof Error ? error.stack ?? error.message : String(error)); }
}
const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (root: string, rel: string, text: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

const LIT_UNMAPPED = 'index operator not supported: <inspect> on ARRAY';
const LIT_STATED = 'range-step-ok';
const LIT_EXCLUDED = 'legacy slice syntax';
const REQUEST = [
  'Add stepped slices to arrays and strings.',
  `An invalid index must fail with \`${LIT_UNMAPPED}\`.`,
  `A valid stepped slice prints \`${LIT_STATED}\`.`,
  `Do not touch the \`${LIT_EXCLUDED}\` path.`,
].join('\n');

const pin = (test: string) => ({ verification: { command: `go test -v ./evaluator -run ^${test}$`, selector: `--- PASS: ${test}` } });
const row = (desc: string, test: string) => ({ desc, type: 'logic' as const, priority: 'must' as const,
  scope: 'focused' as const, expectation: 'absolute_pass' as const, requirementSource: 'story' as const, ...pin(test) });

/** CHK-001 lacks the adversarial lane; CHK-002 lacks userSees and pins its happy intent nowhere. */
function incompleteItems(): ChecklistItem[] {
  return [{
    id: 'CHK-001', title: 'Array stepped read slicing', context: 'evaluator index expressions',
    userSees: `"[1, 2, 3, 4][::2]" prints "[1, 3]" and "${LIT_STATED}"`,
    files: { modify: ['evaluator/evaluator.go'], create: [], test: ['evaluator/evaluator_test.go'] },
    verificationIntent: {
      happy: [row(`[1,2,3,4][::2] -> [1, 3], prints ${LIT_STATED}`, 'TestStepHappy')],
      edge: [row('[1,2,3][::-1] -> [3, 2, 1]', 'TestStepEdge')],
      adversarial: [],
    },
    status: 'pending', startTime: null, endTime: null,
  }, {
    id: 'CHK-002', title: 'String stepped read slicing', context: 'evaluator string index expressions',
    excludes: [`${LIT_EXCLUDED}: reference only, unchanged by this Story`],
    files: { modify: ['evaluator/evaluator.go'], create: [], test: ['evaluator/evaluator_test.go'] },
    verificationIntent: {
      happy: [{ desc: '"12345"[::-1] -> "54321"', type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story' }],
      edge: [row('"abc"[::2] -> "ac"', 'TestStrEdge')],
      adversarial: [row('"abc"[::0] -> error', 'TestStrAdv')],
    },
    status: 'pending', startTime: null, endTime: null,
  }] as ChecklistItem[];
}

function completeItems(): ChecklistItem[] {
  const [one, two] = incompleteItems();
  return [
    { ...one!, verificationIntent: { ...one!.verificationIntent!, adversarial: [row(`[1,2][x] -> ${LIT_UNMAPPED}`, 'TestStepAdv')] } },
    { ...two!, userSees: '"12345"[::-1] prints "54321"',
      verificationIntent: { ...two!.verificationIntent!, happy: [row('"12345"[::-1] -> "54321"', 'TestStrHappy')] } },
  ] as ChecklistItem[];
}

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'plan-author-before-scope-')));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Bench Owner']);
  git(root, ['config', 'user.email', 'owner@bench.invalid']);
  write(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: '.', rootDir: '.', storyDir: STORY_DIR, requirementsDir: 'docs/requirements', workflow: { profile: 'balanced' },
  }, null, 2));
  write(root, 'README.md', 'fixture\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'baseline']);
  resetConfigCache();
  const store = new StoryStore(root);
  const storyId = 'B-19a1';
  const now = '2026-10-07T03:00:00.000Z';
  // High priority: story_review demands happy/edge/adversarial on every item.
  const story: StoryInfo = {
    storyId, name: 'stepped-slices', title: 'Stepped slices',
    description: 'Add stepped slices inside index brackets.',
    type: 'feature', phase: 'PLAN', priority: 'high',
    createdAt: now, startedAt: now, endedAt: null,
    events: [{ phase: 'PLAN', action: 'advance', timestamp: now }],
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, { items: incompleteItems() } as ChecklistData);
  writeStoryRequest(store, { storyId, phase: 'INIT', request: REQUEST, source: 'smoke', now });
  store.writeDevMemoryPreflightAck(storyId, {
    schemaVersion: 'proof-or-stop.dev_memory_preflight_ack.v1', storyId, topHitIds: [],
    acknowledgedAt: now, acknowledgedBy: 'smoke',
  } as never);
  const ctx = { store, root, scanRoot: root };
  const registry = createMainRegistry(ctx);
  const next = () => {
    const live = createNextDriver(ctx, (name: string) => registry.get(name)).decide(storyId) as NextStep;
    const reference = createReferenceNextDriver(ctx as never, (name: string) => registry.get(name)).decide(storyId);
    check(isDeepStrictEqual(live, reference), `golden: the frozen reference driver returns the same PLAN step (${live.reason})`, JSON.stringify({ live, reference }));
    return live;
  };
  const signScope = (gap: boolean) => createScopeCheckHandlers(ctx).scope_check_save({
    storyId,
    features: [
      { feature: 'Array stepped read slicing', status: 'covered', covered_by: 'CHK-001', excluded_by: null, source: 'request.md' },
      ...(gap ? [{ feature: LIT_UNMAPPED, status: 'gap', covered_by: null, excluded_by: null, source: 'request.md' },
        { feature: 'index ranges can only be numerical', status: 'gap', covered_by: null, excluded_by: null, source: 'request.md' }] : []),
    ],
    summary: { total: gap ? 3 : 1, covered: 1, excluded: 0, gaps: gap ? 2 : 0 },
    readManifest: { filesReadFully: [], filesTriagedByName: [], scanEscalationReason: null },
    openQuestions: [],
  } as never);
  const review = (brief: boolean) => createStoryReviewHandlers(ctx).story_review({ storyId, ...(brief ? { brief: true } : {}) }) as {
    issues: Array<{ type: string; severity: string; message: string }>;
  };
  return { root, store, storyId, next, signScope, review };
}

function p1(): void {
  console.log('P1 deterministic PLAN blockers come before the scope-plan reviewer');
  const t = setup();
  try {
    const step = t.next();
    const calls = step.batch ?? [];
    const updateFor = (itemId: string) => calls.find(call => call.cli.command === 'checklist_update' && call.cli.payload.itemId === itemId);
    check(step.reason === 'plan_authoring' && step.kind === 'agent', 'verdict missing + open intent blockers: next returns plan_authoring, not the reviewer launch', JSON.stringify(step));
    check(!JSON.stringify(step).includes('host_run'), 'no reviewer launch is offered while deterministic blockers are open', JSON.stringify(step));
    const one = updateFor('CHK-001');
    const adversarial = (one?.cli.payload.verificationIntent as { adversarial?: Array<Record<string, unknown>> } | undefined)?.adversarial ?? [];
    check(adversarial.length === 1 && adversarial[0]!.requirementSource === 'story' && adversarial[0]!.scope === 'focused'
      && adversarial[0]!.expectation === 'absolute_pass' && typeof (adversarial[0]!.verification as { command?: string } | undefined)?.command === 'string',
    'CHK-001 checklist_update adds a classified, pinned adversarial placeholder row', JSON.stringify(one));
    const keptHappy = (one?.cli.payload.verificationIntent as { happy?: Array<{ desc: string }> } | undefined)?.happy ?? [];
    check(keptHappy.length === 1 && keptHappy[0]!.desc.includes(LIT_STATED), 'CHK-001 checklist_update keeps the existing intents (full replacement value)', JSON.stringify(one));
    const two = updateFor('CHK-002');
    check(typeof two?.cli.payload.userSees === 'string' && /^<.*>$/.test(String(two.cli.payload.userSees)), 'CHK-002 checklist_update asks for the missing userSees', JSON.stringify(two));
    const twoHappy = (two?.cli.payload.verificationIntent as { happy?: Array<{ verification?: { command?: string } }> } | undefined)?.happy ?? [];
    check(typeof twoHappy[0]?.verification?.command === 'string', 'CHK-002 checklist_update pins the unpinned happy intent', JSON.stringify(two));
    check(step.why.includes(LIT_UNMAPPED), 'the unmapped request literal is named in the authoring step', step.why);
    check(!step.why.includes(`\`${LIT_STATED}\``) && !step.why.includes(`\`${LIT_EXCLUDED}\``), 'stated and PLAN-excluded literals are not reported', step.why);
    check(calls.every(call => call.cli.command !== 'story_review'), 'the pre-scope batch does not spend a story_review round', JSON.stringify(calls.map(call => call.cli.command)));
    check(/next --storyId=B-19a1 --run/.test(step.why) && /scope-plan reviewer/.test(step.why), 'the step says next --run then launches the scope-plan reviewer on the final checklist', step.why);

    t.store.writeChecklist(t.storyId, { items: completeItems() } as ChecklistData);
    const launch = t.next();
    check(launch.reason === 'scope_plan_review_launch' && launch.cli?.command === 'host_run' && launch.cli.payload.agentType === SCOPE_REVIEWER,
      'blockers clear: next launches the scope-plan reviewer', JSON.stringify(launch));
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
}

function p2p3(): void {
  console.log('P2 stale verdict: next relaunches the reviewer; P3 brief story_review keeps the Next remedy');
  const t = setup();
  try {
    t.store.writeChecklist(t.storyId, { items: completeItems() } as ChecklistData);
    t.signScope(true);
    const fresh = t.next();
    check(fresh.reason !== 'scope_plan_review_launch', 'a fresh verdict with gaps is not relaunched (the owner covers the gaps first)', JSON.stringify(fresh));
    // The owner covers the gaps: the checklist changes after the verdict.
    const items = completeItems();
    items[1] = { ...items[1]!, verificationIntent: { ...items[1]!.verificationIntent!,
      edge: [...items[1]!.verificationIntent!.edge!, row('"abc"["x":"y"] -> index ranges can only be numerical', 'TestStrRange')] } } as ChecklistItem;
    t.store.writeChecklist(t.storyId, { items } as ChecklistData);
    const stale = t.next();
    check(stale.reason === 'scope_plan_review_launch' && stale.cli?.command === 'host_run' && stale.cli.payload.agentType === SCOPE_REVIEWER,
      'checklist changed since the verdict: next returns the scope-plan relaunch, not guard_dev_blocked -> story_review', JSON.stringify(stale));
    check(/changed since/.test(stale.why), 'the relaunch says why (checklist changed since the verdict)', stale.why);

    const brief = t.review(true).issues.filter(issue => issue.type === 'scope_gap');
    const command = `proof-or-stop host_run`;
    check(brief.length === 2, 'brief story_review keeps both scope_gap rows', JSON.stringify(brief));
    check(brief[0]?.message.includes('rerun the scope-plan reviewer') === true && brief[0]!.message.includes(command)
      && brief[0]!.message.includes(SCOPE_REVIEWER), 'brief view: the first scope_gap keeps its whole Next remedy (the rerun command)', brief[0]?.message ?? '');
    check(brief.every(issue => !/Next \(PLAN, no INI…|Next[^:]*…$/.test(issue.message)), 'brief view never cuts a Next remedy', JSON.stringify(brief.map(issue => issue.message)));
    check((brief[1]?.message.match(/proof-or-stop host_run/g) ?? []).length === 0 && /same as above/i.test(brief[1]?.message ?? ''),
      'brief view: an identical remedy is collapsed to one line', brief[1]?.message ?? '');
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }

  const auto = (scopeRequirement as unknown as Record<string, unknown>).scopePlanLaunchIsFramework as
    ((args: { bound: boolean; rerun: boolean; last?: { runId: string; state: string; createdAt: string }; verdict?: { checkedAt: string; deliveryRunId?: string } | null }) => boolean) | undefined;
  if (!check(typeof auto === 'function', 'scopePlanLaunchIsFramework is exported (shared launch rule)')) return;
  const last = { runId: 'run-1', state: 'completed', createdAt: '2026-10-07T03:00:00.000Z' };
  check(auto!({ bound: true, rerun: false }) === true, 'first run, bound selection: framework launch');
  check(auto!({ bound: false, rerun: false }) === false, 'unbound selection: agent launch');
  check(auto!({ bound: true, rerun: true, last, verdict: { checkedAt: '2026-10-07T03:05:00.000Z', deliveryRunId: 'run-1' } }) === true,
    'stale verdict delivered by the last completed run: framework relaunch');
  check(auto!({ bound: true, rerun: true, last: { ...last, state: 'failed' }, verdict: { checkedAt: '2026-10-07T03:05:00.000Z', deliveryRunId: 'run-1' } }) === false,
    'last run failed: the relaunch stays the agent\'s call');
  check(auto!({ bound: true, rerun: true, last: { ...last, runId: 'run-2' }, verdict: { checkedAt: '2026-10-07T03:05:00.000Z', deliveryRunId: 'run-1' } }) === false,
    'last run completed without delivering the verdict: no framework relaunch loop');
  check(auto!({ bound: true, rerun: false, last, verdict: null }) === false, 'verdict missing after a completed run: agent\'s call (unchanged)');
}

function p4(): void {
  console.log('P4 one intent-metadata rule; loud refusal; actionable literal warning');
  const describe = (classification as unknown as Record<string, unknown>).verificationIntentClassificationFailure as
    ((itemId: string, intent: Record<string, unknown>, command: string) => string | null) | undefined;
  if (check(typeof describe === 'function', 'verificationIntentClassificationFailure is the shared rule (checklist_update, plan acceptance, story_create)')) {
    attempt('classification rule', () => {
      const message = describe!('CHK-001', { happy: [{ desc: 'x -> y', type: 'logic', scope: 'focused', expectation: 'absolute_pass' }] } as never, 'checklist_update') ?? '';
      check(/\[verification_intent_metadata_required\]/.test(message) && /missing requirementSource/.test(message) && !/missing scope/.test(message),
        'the refusal names exactly the missing field (requirementSource)', message);
      check(/^checklist_update REFUSED/.test(message) && /nothing was written/i.test(message), 'the refusal says loudly that nothing was written', message);
    });
  }

  const root = realpathSync(mkdtempSync(join(tmpdir(), 'plan-author-before-scope-create-')));
  try {
    write(root, 'proof-or-stop.config.json', JSON.stringify({ scanRoot: '.', testsDir: 'tests', storyDir: STORY_DIR, requirementsDir: 'docs/requirements' }));
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'p4@example.invalid']);
    git(root, ['config', 'user.name', 'P4 Smoke']);
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'fixture']);
    resetConfigCache();
    const store = new StoryStore(root);
    const create = createStoryCreateHandlers({ root, scanRoot: root, store } as never);
    const background = ['## Trigger Event', 'Run 19 on 2026-10-06 refused an intent batch for a missing requirementSource after story_create had accepted the same shape.', '',
      '## Key Insights', 'One intent-metadata rule must hold from story_create to PLAN, and a refusal must name the missing field.', '',
      '## Solution Tradeoffs', 'Refuse unclassified intents at intake with a copyable classified row instead of accepting them silently.', '',
      '## Conversational Texture', 'The owner wants every refusal to say exactly which field is missing and what to run next.'].join('\n');
    const base = { name: 'p4-intake', title: 'Stepped slice intake', description: 'Intake with request literals.', type: 'feature', priority: 'medium',
      background, request: REQUEST, forceNew: true };
    let refused = '';
    try {
      create.story_create({ ...base, checklist: [{ title: 'Array stepped read slicing', userSees: '"[1,2][::1]" prints "[1, 2]"',
        verificationIntent: { happy: [{ desc: 'slice works', type: 'logic', priority: 'must' }] } }] } as never);
    } catch (error) { refused = error instanceof Error ? error.message : String(error); }
    check(/\[verification_intent_metadata_required\]/.test(refused) && /requirementSource/.test(refused),
      'story_create refuses an unclassified intent with the same rule PLAN applies, naming requirementSource', refused || '(accepted)');
    check(store.listStoryIds().length === 0, 'the refused story_create wrote no Story (nothing to recreate)');

    let out = '';
    attempt('story_create with literals', () => {
      out = String(create.story_create({ ...base, checklist: [{ title: 'Array stepped read slicing', userSees: '"[1,2][::1]" prints "[1, 2]"' }] } as never));
    });
    const storyId = out.match(/B-[a-z0-9]{4}/)?.[0] ?? '';
    check(out.includes(LIT_UNMAPPED), 'story_create still names the unmapped literals', out);
    check(out.includes(`proof-or-stop checklist_update`) && out.includes(`"storyId":"${storyId}"`) && /"userSees"/.test(out),
      'the literal warning gives the exact checklist_update command to record them in INIT', out);
    check(/editable in INIT and PLAN/.test(out) && !/recreate/i.test(out), 'the warning says userSees is editable in INIT and PLAN (no recreate)', out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const description = MAIN_TOOLS.find(entry => entry.name === 'checklist_update')?.description ?? '';
  check(!/title\/context\/userSees frozen/.test(description) && /userSees/.test(description) && /DEV/.test(description),
    'checklist_update help no longer claims userSees is frozen before DEV', description);
}

attempt('P1', p1);
attempt('P2/P3', p2p3);
attempt('P4', p4);
if (failures.length) {
  console.log(`plan-author-before-scope-smoke: FAIL (${failures.length})\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('plan-author-before-scope-smoke: PASS');
