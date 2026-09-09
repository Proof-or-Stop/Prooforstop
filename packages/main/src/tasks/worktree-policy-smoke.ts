#!/usr/bin/env node

/**
 * Worktree-safety runtime enforcement smoke (§B2 / M7 / M9 / M11).
 *
 * Drives `executePlannedSteps` in-process with synthetic JobPlans + an injected
 * git runner and bounded provider executor, so the worktree preflight/postflight
 * runs deterministically without a real repository or a real Codex/Claude process.
 *
 * Covers: authoritative-cwd resolution before provider work, dirty unrelated
 * worktree rejection, forbidden-path blocking (declared + provider-introduced),
 * git-status evidence capture, the fail-closed printable stop summary, and that
 * local mode (provider.fake / no worktreePolicy) keeps working.
 */

import assert from 'node:assert/strict';
import { executePlannedSteps } from '../core/planned-steps-executor.js';
import {
  resolveWorktreePolicy,
  resolveAuthoritativeWorktree,
  captureGitStatus,
  matchesForbiddenGlob,
  partitionDirtyEntries,
  evaluateWorktreePreflight,
  evaluateForbiddenEdits,
  buildWorktreeStopSummary,
  renderWorktreeStopSummary,
  type GitRunner,
  type GitStatusEvidence,
  type WorktreePolicyView,
} from '../core/worktree-policy.js';
import type { BoundedProviderExecutor, ProviderExecResult } from '../providers/types.js';

type Json = Record<string, any>;

const WORKTREE = '/tmp/proof-or-stop-story-worktree';
const ROOT = '/tmp/proof-or-stop-project-root';

// --- Stubs -------------------------------------------------------------------

/** Git runner that returns a fixed porcelain status per call (or "not a repo"). */
function gitStub(...sequences: Array<string[] | null>): { run: GitRunner; calls: number } {
  let i = 0;
  const state = { calls: 0 };
  const run: GitRunner = () => {
    state.calls++;
    const entries = sequences[Math.min(i, sequences.length - 1)];
    i++;
    if (entries === null) return { code: 1, stdout: '', stderr: 'not a git repository', spawnError: false };
    return { code: 0, stdout: entries.join('\n'), stderr: '', spawnError: false };
  };
  return { run, get calls() { return state.calls; } } as { run: GitRunner; calls: number };
}

function providerStub(capture?: (cwd: string) => void): BoundedProviderExecutor {
  return {
    available: () => true,
    run: (req): ProviderExecResult => {
      capture?.(req.cwd);
      return { provider: req.provider, argvDigest: 'ad', exitCode: 0, stdoutDigest: 'sd', stderrDigest: 'ed', stdoutBytes: 1, stderrBytes: 0, durationMs: 1, attempts: 1, timedOut: false, spawnError: false };
    },
  };
}

function story(worktreePath: string | null): Json {
  return { storyId: 'B-wt', phase: 'DEV', ...(worktreePath ? { worktree: { path: worktreePath, branch: 'story/B-wt', createdAt: 'x' } } : {}) };
}

function storeStub(worktreePath: string | null): any {
  return {
    readStory: () => story(worktreePath),
    storyExists: () => true,
    listStoryIds: () => ['B-wt'],
    appendProcessEvent: () => {},
  };
}

const WORKTREE_POLICY: WorktreePolicyView = {
  resolver: 'proofOrStop.story.resolve',
  requiresAuthoritativeWorktree: true,
  allowWorktreeRepair: false,
  allowedPathRoots: [],
  forbiddenPathGlobs: ['.proof-or-stop/story/**', 'docs/story/**', '**/tests/fixtures/**'],
  requiresCleanWorktree: false,
  preserveUnrelatedDirtyChanges: true,
  requireGitStatusEvidence: true,
};

function codexStep(args: Json, requiresCleanWorktree = true): Json {
  return {
    stepId: 'step-codex',
    type: 'provider.codex',
    title: 'bounded provider',
    purpose: 'bounded provider action',
    cwdPolicy: 'story-worktree',
    timeoutMs: 30_000,
    maxAttempts: 1,
    requiresCleanWorktree,
    producesEvidence: true,
    blocksUntilEvidenceUploaded: true,
    provider: 'codex',
    evidenceBinding: 'B-wt:provider',
    args,
  };
}

function plan(opts: { mode?: 'local' | 'authority'; worktreePolicy?: Json | null; providerPolicy?: Json; steps: Json[] }): any {
  return {
    schemaVersion: 'proof-or-stop.job_plan.v1',
    plannerRunId: 'run-wt',
    storyId: 'B-wt',
    mode: opts.mode ?? 'authority',
    until: 'DONE',
    developmentWorkflow: 'standard',
    plannedSteps: opts.steps,
    coverageMap: [],
    multiHostPolicy: {},
    providerPolicy: opts.providerPolicy ?? { allowedProviders: ['codex'], productionDoneProviders: ['codex'], credentialsEnvAllowlist: ['CODEX_KEY'] },
    ...(opts.worktreePolicy === null ? {} : { worktreePolicy: opts.worktreePolicy ?? WORKTREE_POLICY }),
    plannerDigest: 'pd',
    jobPlanDigest: 'jd',
    status: 'planned',
  };
}

function exec(opts: { jobPlan: any; store: any; git: GitRunner; provider?: BoundedProviderExecutor; env?: Json }): Json {
  return executePlannedSteps({
    root: ROOT,
    store: opts.store,
    jobPlan: opts.jobPlan,
    now: () => new Date('2026-06-06T00:00:00Z'),
    env: opts.env ?? { CODEX_KEY: 'secret' },
    providerExecutor: opts.provider ?? providerStub(),
    gitRunner: opts.git,
  }) as Json;
}

// --- Pure-unit checks --------------------------------------------------------

// glob matching: story / fixture JSON are forbidden; ordinary src files are not.
assert.equal(matchesForbiddenGlob('docs/story/actives/B-x/index.json', WORKTREE_POLICY.forbiddenPathGlobs), 'docs/story/**');
assert.equal(matchesForbiddenGlob('.proof-or-stop/story/actives/B-x/checklist.json', WORKTREE_POLICY.forbiddenPathGlobs), '.proof-or-stop/story/**');
assert.equal(matchesForbiddenGlob('packages/main/tests/fixtures/foo.json', WORKTREE_POLICY.forbiddenPathGlobs), '**/tests/fixtures/**');
assert.equal(matchesForbiddenGlob('./docs/story/x.json', WORKTREE_POLICY.forbiddenPathGlobs), 'docs/story/**');
assert.equal(matchesForbiddenGlob('packages/main/src/core/foo.ts', WORKTREE_POLICY.forbiddenPathGlobs), null);

// resolveWorktreePolicy keeps the forbidden globs as a floor even if a plan tries to drop them.
const floored = resolveWorktreePolicy({ worktreePolicy: { resolver: 'proofOrStop.story.resolve', forbiddenPathGlobs: ['custom/**'] } } as any);
assert.ok(floored.forbiddenPathGlobs.includes('docs/story/**'), 'story glob is a non-droppable floor');
assert.ok(floored.forbiddenPathGlobs.includes('custom/**'), 'plan may add globs');

// partition: with no allowed roots, all dirty entries are "unrelated" (preserve-protected).
const part = partitionDirtyEntries([{ code: ' M', path: 'a.ts' }, { code: '??', path: 'b.ts' }], []);
assert.equal(part.unrelated.length, 2);
assert.equal(part.related.length, 0);
const partRooted = partitionDirtyEntries([{ code: ' M', path: 'src/a.ts' }, { code: ' M', path: 'other/b.ts' }], ['src']);
assert.equal(partRooted.related.length, 1);
assert.equal(partRooted.unrelated.length, 1);

// captureGitStatus: clean, dirty, and uncaptured (non-repo).
assert.equal(captureGitStatus(WORKTREE, gitStub([]).run).clean, true);
const dirtyEvidence = captureGitStatus(WORKTREE, gitStub([' M src/a.ts']).run);
assert.equal(dirtyEvidence.clean, false);
assert.equal(dirtyEvidence.entries[0].path, 'src/a.ts');
assert.ok(dirtyEvidence.digest.length > 0);
assert.equal(captureGitStatus(WORKTREE, gitStub(null).run).captured, false);

// resolveAuthoritativeWorktree: configured worktree vs fallback to root.
const resConfigured = resolveAuthoritativeWorktree(storeStub(WORKTREE), 'B-wt', ROOT);
assert.equal(resConfigured.authoritativeCwd, WORKTREE);
assert.equal(resConfigured.worktreeConfigured, true);
const resFallback = resolveAuthoritativeWorktree(storeStub(null), 'B-wt', ROOT);
assert.equal(resFallback.authoritativeCwd, ROOT);
assert.equal(resFallback.worktreeConfigured, false);

// --- Integration: executePlannedSteps enforcement ----------------------------

// 1. authoritative_worktree_unresolved — authority + requiresAuthoritativeWorktree,
//    but the story has no worktree configured. Fails closed BEFORE any provider work.
const unresolved = exec({ jobPlan: plan({ steps: [codexStep({ argv: ['exec'] })] }), store: storeStub(null), git: gitStub([]).run });
assert.equal(unresolved.status, 'blocked');
assert.equal(unresolved.stopReason, 'authoritative_worktree_unresolved');
assert.equal(unresolved.steps[0].reason, 'authoritative_worktree_unresolved');
assert.equal(unresolved.steps[0].summary.worktreeConfigured, false, 'authoritative worktree absence is the specific failing condition');
assert.equal(unresolved.steps[0].summary.requiresCleanWorktree, true, 'the clean-worktree requirement stays visible but does not mask worktree resolution');
assert.ok(unresolved.worktreeStopSummary, 'a worktree stop summary is surfaced');
assert.equal(unresolved.worktreeStopSummary.schemaVersion, 'proof-or-stop.worktree_stop_summary.v1');
assert.ok(unresolved.nextActions.some((a: string) => a.includes('story_advance --phase=INIT_CHECK') || a.includes('authoritative')));
assert.equal(unresolved.authorityDone, false);

// 2. git_status_evidence_unavailable — worktree resolves but git status can't be captured.
const noGit = exec({ jobPlan: plan({ steps: [codexStep({ argv: ['exec'] })] }), store: storeStub(WORKTREE), git: gitStub(null).run });
assert.equal(noGit.status, 'blocked');
assert.equal(noGit.stopReason, 'git_status_evidence_unavailable');

// 3. dirty_worktree — clean required, but unrelated dirty changes are present. The run
//    preserves them (never clobbers) and stops safely.
const dirty = exec({ jobPlan: plan({ steps: [codexStep({ argv: ['exec'] }, true)] }), store: storeStub(WORKTREE), git: gitStub([' M src/unrelated.ts', '?? notes.txt']).run });
assert.equal(dirty.status, 'blocked');
assert.equal(dirty.stopReason, 'dirty_worktree');
assert.equal(dirty.steps[0].reason, 'dirty_worktree');
assert.equal(dirty.steps[0].summary.worktreeConfigured, true, 'dirty_worktree is reached only after the authoritative worktree resolves');
assert.equal(dirty.steps[0].summary.gitStatusCaptured, true, 'dirty_worktree is based on captured git status evidence');
assert.equal(dirty.steps[0].summary.unrelatedDirtyCount, 2);
assert.ok(String(dirty.steps[0].summary.note).includes('preserv'), 'dirty-stop note documents preservation, not discard');

// 4. forbidden_path_glob (preflight) — the step declares it will edit story JSON.
const declaredForbidden = exec({
  jobPlan: plan({ steps: [codexStep({ argv: ['exec'], paths: ['docs/story/actives/B-wt/index.json'] }, false)] }),
  store: storeStub(WORKTREE),
  git: gitStub([]).run,
});
assert.equal(declaredForbidden.status, 'blocked');
assert.equal(declaredForbidden.stopReason, 'forbidden_path_glob');
assert.equal(declaredForbidden.steps[0].summary.phase, 'preflight');
assert.equal(declaredForbidden.steps[0].summary.matchedGlob, 'docs/story/**');

// 5. forbidden_path_glob (postflight) — provider passes, but INTRODUCES a story JSON edit.
const introducedForbidden = exec({
  jobPlan: plan({ steps: [codexStep({ argv: ['exec'] }, false)] }),
  store: storeStub(WORKTREE),
  // before: clean; after: a new forbidden file appeared.
  git: gitStub([], ['?? docs/story/actives/B-wt/index.json']).run,
});
assert.equal(introducedForbidden.status, 'blocked');
assert.equal(introducedForbidden.stopReason, 'forbidden_path_glob');
assert.equal(introducedForbidden.steps[0].summary.phase, 'postflight');
assert.ok(introducedForbidden.worktreeStopSummary.gitStatusAfterDigest, 'postflight summary records after-status digest');

// 6. Happy path — worktree resolves, clean, provider runs IN the authoritative worktree.
let providerCwd: string | null = null;
const happy = exec({
  jobPlan: plan({ steps: [codexStep({ argv: ['exec'] }, true)] }),
  store: storeStub(WORKTREE),
  git: gitStub([], []).run,
  provider: providerStub(cwd => { providerCwd = cwd; }),
});
assert.equal(happy.steps[0].status, 'passed', JSON.stringify(happy.steps[0]));
assert.equal(providerCwd, WORKTREE, 'provider work runs in the authoritative story worktree, not the project root');
assert.equal(happy.steps[0].summary.gitStatusCaptured, true);
assert.ok(String(happy.steps[0].summary.gitStatusDigest).length > 0, 'git status evidence digest captured on the passing step');
assert.equal(happy.worktreeStopSummary, undefined, 'no stop summary on a clean pass');
// Provider success is still never validation / DONE.
assert.equal(happy.steps[0].summary.validationSatisfied, false);

// 7a. Local mode keeps working — provider.fake is exempt even with a worktreePolicy present.
const fakeStep = { stepId: 'step-fake', type: 'provider.fake', title: 't', purpose: 'p', cwdPolicy: 'story-worktree', timeoutMs: 1000, maxAttempts: 1, requiresCleanWorktree: true, producesEvidence: true, blocksUntilEvidenceUploaded: true, provider: 'fake', evidenceBinding: 'B-wt:fake', args: { operation: 'implement' } };
const localFake = exec({ jobPlan: plan({ mode: 'local', steps: [fakeStep] }), store: storeStub(null), git: gitStub([]).run });
assert.equal(localFake.steps[0].status, 'passed', 'provider.fake never triggers worktree enforcement');
assert.equal(localFake.worktreeStopSummary, undefined);

// 7b. A plan WITHOUT a worktreePolicy block leaves enforcement OFF (legacy behavior):
//     the codex provider runs in the project root and git is never consulted.
let legacyCwd: string | null = null;
const legacyGit = gitStub([]);
const legacy = exec({
  jobPlan: plan({ mode: 'local', worktreePolicy: null, steps: [codexStep({ argv: ['exec'] }, true)] }),
  store: storeStub(null),
  git: legacyGit.run,
  provider: providerStub(cwd => { legacyCwd = cwd; }),
});
assert.equal(legacy.steps[0].status, 'passed', 'no worktreePolicy → no enforcement → codex runs as before');
assert.equal(legacyCwd, ROOT, 'without enforcement the provider uses the project root');
assert.equal(legacyGit.calls, 0, 'git status is never captured when enforcement is inactive');

// --- Stop summary rendering ---------------------------------------------------
const summary = buildWorktreeStopSummary({
  storyId: 'B-wt',
  stepId: 'step-codex',
  stopReason: 'dirty_worktree',
  authoritativeCwd: WORKTREE,
  gitStatusBefore: { captured: true, clean: false, entries: [{ code: ' M', path: 'a.ts' }], digest: 'abc' },
  detail: {},
});
const rendered = renderWorktreeStopSummary(summary);
assert.ok(rendered.includes('stopReason: dirty_worktree'));
assert.ok(rendered.includes('authoritativeCwd: ' + WORKTREE));
assert.ok(rendered.includes('nextAction:'));

// evaluateWorktreePreflight / evaluateForbiddenEdits direct unit coverage.
const before: GitStatusEvidence = { captured: true, clean: true, entries: [], digest: 'b' };
const after: GitStatusEvidence = { captured: true, clean: false, entries: [{ code: '??', path: 'docs/story/x.json' }], digest: 'a' };
assert.equal(evaluateForbiddenEdits(before, after, WORKTREE_POLICY.forbiddenPathGlobs).ok, false);
assert.equal(evaluateForbiddenEdits(before, before, WORKTREE_POLICY.forbiddenPathGlobs).ok, true);
const pfOk = evaluateWorktreePreflight({
  policy: WORKTREE_POLICY,
  resolution: resolveAuthoritativeWorktree(storeStub(WORKTREE), 'B-wt', ROOT),
  gitStatus: before,
  step: codexStep({ argv: ['exec'] }, true) as any,
});
assert.equal(pfOk.ok, true);
const pfPolicyClean = evaluateWorktreePreflight({
  policy: { ...WORKTREE_POLICY, requiresCleanWorktree: true },
  resolution: resolveAuthoritativeWorktree(storeStub(WORKTREE), 'B-wt', ROOT),
  gitStatus: { captured: true, clean: false, entries: [{ code: ' M', path: 'src/policy-dirty.ts' }], digest: 'dirty-policy' },
  step: codexStep({ argv: ['exec'] }, false) as any,
});
assert.equal(pfPolicyClean.ok, false, 'policy-level requiresCleanWorktree also blocks dirty worktrees');
assert.equal(pfPolicyClean.reason, 'dirty_worktree');
assert.equal(pfPolicyClean.summary.requiresCleanWorktree, true);

console.log('worktree-policy-smoke: OK');
