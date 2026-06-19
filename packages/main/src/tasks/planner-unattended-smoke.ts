#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetConfigCache } from '../core/config.js';
import { executePlannedSteps } from '../core/planned-steps-executor.js';
import { assertJobPolicyConsistency, buildJobPlan, buildPlannerDraft, PlannedStepsSchema } from '../core/planner.js';
import { summarizeVerdictRuns } from '../core/verdicts.js';
import type { BoundedProviderExecutor, ProviderExecResult } from '../providers/types.js';

type JsonObject = Record<string, any>;

const taskDir = dirname(fileURLToPath(import.meta.url));
const cliPath = join(taskDir, '..', 'cli.js');
const root = mkdtempSync(join(tmpdir(), 'lattice-planner-unattended-'));

function run(args: string[]): JsonObject {
  const out = execFileSync(process.execPath, [cliPath, '--root', root, ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(out) as JsonObject;
}

function writeConfig(): void {
  writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));
  mkdirSync(join(root, 'docs/requirements/decisions'), { recursive: true });
  writeFileSync(join(root, 'docs/requirements/decisions/lattice-authority-live-integration.md'), '# Requirements\n');
  resetConfigCache();
}

try {
  writeConfig();

  const draft = run(['lattice', 'planner', 'draft', '--request=Add a bounded local autopilot smoke command with validation evidence', '--mode=local', '--until=DONE', '--json']);
  assert.equal(draft.schemaVersion, 'lattice.planner_draft.v1');
  assert.equal(draft.interactionMode, 'autonomous');
  assert.equal(draft.status, 'drafted');
  assert.equal(draft.checklist.length, 2);
  assert.equal(draft.deferredOptimizations.length, 1);
  assert.equal(draft.plannerPolicy.requiresConfirmationBeforeStoryCreate, false, 'local autonomous planning does not require a confirmation digest before Story creation');

  const reviewed = run(['lattice', 'planner', 'review', `--runId=${draft.plannerRunId}`, '--json']);
  assert.equal(reviewed.status, 'pass');

  // requiresConfirmationBeforeStoryCreate linkage: policy false creates without a
  // confirmation digest; policy true blocks before story_create, then unblocks
  // only after planner_answer records a confirmationDigest.
  const noConfirmDraft = run(['lattice', 'planner', 'draft', '--request=Create a local no-confirmation planner smoke Story', '--mode=local', '--json']);
  assert.equal(noConfirmDraft.plannerPolicy.requiresConfirmationBeforeStoryCreate, false);
  const noConfirmCreated = run(['lattice', 'planner', 'create-story', `--runId=${noConfirmDraft.plannerRunId}`, '--json']);
  assert.equal(noConfirmCreated.status, 'created', 'policy=false path creates a Story without confirmation');
  assert.match(noConfirmCreated.storyId, /^B-[0-9a-f]{4,6}$/i);

  const confirmDraft = run(['lattice', 'planner', 'draft', '--request=Create a confirmation-gated planner smoke Story', '--interactionMode=interview', '--json']);
  assert.equal(confirmDraft.plannerPolicy.requiresConfirmationBeforeStoryCreate, true);
  const blockedCreate = run(['lattice', 'planner', 'create-story', `--runId=${confirmDraft.plannerRunId}`, '--json']);
  assert.equal(blockedCreate.status, 'blocked');
  assert.equal(blockedCreate.blockedReason, 'confirmation required before Story creation');
  const blockedStatus = run(['lattice', 'planner', 'status', `--runId=${confirmDraft.plannerRunId}`, '--json']);
  assert.equal(blockedStatus.storyId, undefined, 'missing confirmation must block before story_create produces a Story');
  writeFileSync(join(root, 'confirm-answers.json'), JSON.stringify({ 'Q-001': 'Confirmed creation outcome', confirmed: true }));
  const confirmAnswer = run(['lattice', 'planner', 'answer', `--runId=${confirmDraft.plannerRunId}`, '--answersFile=confirm-answers.json', '--json']);
  assert(confirmAnswer.confirmationDigest, 'planner_answer records the confirmationDigest used by planner_create_story');
  const confirmedCreate = run(['lattice', 'planner', 'create-story', `--runId=${confirmDraft.plannerRunId}`, '--json']);
  assert.equal(confirmedCreate.status, 'created');
  assert.match(confirmedCreate.storyId, /^B-[0-9a-f]{4,6}$/i);
  const confirmedStatus = run(['lattice', 'planner', 'status', `--runId=${confirmDraft.plannerRunId}`, '--json']);
  assert.equal(confirmedStatus.storyId, confirmedCreate.storyId, 'confirmed create-story persists the created Story id');

  const job = run(['lattice', 'planner', 'create-job', `--runId=${draft.plannerRunId}`, '--storyId=B-plan', '--json']);
  assert.equal(job.schemaVersion, 'lattice.job_plan.v1');
  assert.equal(job.status, 'planned');
  assert.equal(job.mode, 'local');
  assert(job.plannedSteps.every((step: JsonObject) => !String(step.type).includes('typescript-rust')), 'root step types must not encode language pairs');
  assert(job.coverageMap.every((row: JsonObject) => row.verificationIntentDigest), 'coverage rows must bind verification intent');

  // typed plannedSteps: every step uses a canonical step kind and carries typed evidence bindings
  const PLANNED_STEP_TYPES = ['lattice.command', 'provider.fake', 'provider.codex', 'provider.claude', 'validate.run', 'codex.verify', 'gate.evaluate', 'story.advance', 'stop.summary'];
  assert(job.plannedSteps.length >= 1, 'job plan must contain at least one planned step');
  assert(job.plannedSteps.every((step: JsonObject) => PLANNED_STEP_TYPES.includes(step.type)), 'every planned step must use a canonical typed step kind');
  assert(job.plannedSteps.every((step: JsonObject) => typeof step.stepId === 'string' && typeof step.evidenceBinding === 'string' && step.args && typeof step.args === 'object'), 'planned steps must be fully typed with stepId, evidenceBinding, and args');
  const baseStepTypes = job.plannedSteps.map((step: JsonObject) => step.type);
  assert(baseStepTypes.includes('validate.run') && baseStepTypes.includes('gate.evaluate') && baseStepTypes.includes('stop.summary'), 'job plan must bind validation, gate, and stop-summary steps');

  // story resolve: the first planned step resolves Story context through a typed lattice.command
  const storyResolveStep = job.plannedSteps.find((step: JsonObject) => step.args?.operation === 'story.resolve');
  assert(storyResolveStep, 'planned steps must include a story.resolve context step');
  assert.equal(storyResolveStep.type, 'lattice.command');
  assert.equal(storyResolveStep.args.storyId, 'B-plan');

  // multiHostPolicy knobs: a default job plan must not silently claim a multi-host requirement.
  assert.equal(job.multiHostPolicy.requireMultiHost, false, 'default create-job must not require multi-host');
  assert.equal(job.multiHostPolicy.requiredHostVerdictCount, 0, 'default create-job records zero required host verdicts');
  assert.equal(job.multiHostPolicy.minIndependentHosts, 2, 'default multi-host floor stays at 2');

  // --requireMultiHost is wired MECHANICALLY into JobPlan.multiHostPolicy (not silently ignored).
  // It only TIGHTENS policy: it floors requiredHostVerdictCount at 2 and never asserts verification.
  const reqJob = run(['lattice', 'planner', 'create-job', `--runId=${draft.plannerRunId}`, '--storyId=B-plan-mh', '--requireMultiHost', '--json']);
  assert.equal(reqJob.status, 'planned');
  assert.equal(reqJob.multiHostPolicy.requireMultiHost, true, '--requireMultiHost must set requireMultiHost on the JobPlan');
  assert.equal(reqJob.multiHostPolicy.requiredHostVerdictCount, 2, '--requireMultiHost floors requiredHostVerdictCount at 2');
  assert.equal(reqJob.multiHostPolicy.minIndependentHosts, 2, 'minIndependentHosts reflects the multi-host floor');

  // A higher --requiredHostVerdictCount tightens both the required count and the independent-host floor.
  const tightJob = run(['lattice', 'planner', 'create-job', `--runId=${draft.plannerRunId}`, '--storyId=B-plan-mh3', '--requireMultiHost', '--requiredHostVerdictCount=3', '--json']);
  assert.equal(tightJob.multiHostPolicy.requiredHostVerdictCount, 3, 'requiredHostVerdictCount must reflect the requested tighter count');
  assert.equal(tightJob.multiHostPolicy.minIndependentHosts, 3, 'minIndependentHosts must tighten with requiredHostVerdictCount');

  // requiredHostVerdictCount > 0 activates the requirement even without an explicit --requireMultiHost.
  const impliedJob = run(['lattice', 'planner', 'create-job', `--runId=${draft.plannerRunId}`, '--storyId=B-plan-mh-implied', '--requiredHostVerdictCount=2', '--json']);
  assert.equal(impliedJob.multiHostPolicy.requireMultiHost, true, 'a positive requiredHostVerdictCount activates the multi-host requirement');
  assert.equal(impliedJob.multiHostPolicy.requiredHostVerdictCount, 2);

  // === JobPlan policy blocks (lattice-authority-live-integration.md §B1) ===
  // Every plan — local AND authority — must carry machine-readable provider / worktree / retry /
  // stop / lease / evidence / receipt blocks with conservative, unambiguous defaults so the Stage B
  // executor never infers provider fallback, worktree, retry, or receipt semantics from prose.
  for (const planMode of ['local', 'authority'] as const) {
    const probeDraft = buildPlannerDraft(root, { request: `Probe JobPlan policy blocks with a concrete bounded ${planMode} scope`, mode: planMode, until: 'DONE', allowUnattendedPlanning: true });
    const plan: any = buildJobPlan(probeDraft, `B-pol-${planMode}`, 'local-project', {});
    // providerPolicy: fail-closed, fake-only, no production-DONE eligibility, explicit secretRefs.
    assert.equal(plan.providerPolicy.providerAvailability, 'fail_closed', `${planMode} providerPolicy must be fail_closed`);
    assert.deepEqual(plan.providerPolicy.allowedProviders, ['fake'], `${planMode} providerPolicy allows only the fake provider by default`);
    assert.equal(plan.providerPolicy.primaryProvider, 'fake');
    assert.deepEqual(plan.providerPolicy.fallbackProviders, [], 'no provider fallback is configured by default (fallback semantics stay explicit)');
    assert.deepEqual(plan.providerPolicy.productionDoneProviders, [], 'no provider is production-DONE eligible by default');
    assert.equal(plan.providerPolicy.allowFakeProviderForProductionDone, false, 'fake provider must never satisfy production DONE by default');
    assert(Array.isArray(plan.providerPolicy.secretRefs), 'providerPolicy carries an explicit secretRefs array (secrets are referenced, never inlined)');
    // worktreePolicy: authoritative resolver, dirty-change preservation, git-status evidence required.
    assert.equal(plan.worktreePolicy.resolver, 'lattice.story.resolve');
    assert.equal(plan.worktreePolicy.preserveUnrelatedDirtyChanges, true, 'unrelated dirty changes must be preserved');
    assert.equal(plan.worktreePolicy.requireGitStatusEvidence, true, 'mutating steps must require git-status evidence');
    assert.equal(plan.worktreePolicy.requiresAuthoritativeWorktree, planMode === 'authority', 'authority mode requires an authoritative worktree; local does not force it');
    assert.equal(plan.worktreePolicy.requiresCleanWorktree, false, 'JobPlan policy does not globally require clean worktrees unless a step or policy tightens it');
    assert(plan.worktreePolicy.forbiddenPathGlobs.some((g: string) => g.includes('story')), 'story JSON must be a forbidden direct-edit target');
    const providerStep = plan.plannedSteps.find((step: JsonObject) => String(step.type).startsWith('provider.'));
    assert(providerStep, `${planMode} plan must include a provider step`);
    assert.equal(providerStep.requiresCleanWorktree, true, `${planMode} provider step carries the clean-worktree preflight requirement`);
    // retry / stop separation (§B5): the two blocks stay disjoint and finite, never ambiguous.
    assert(plan.retryPolicy.maxAttemptsPerStep >= 1 && plan.retryPolicy.repairAllowed === false, 'retryPolicy carries bounded, conservative retry semantics');
    assert(plan.stopPolicy.maxSteps >= 1 && plan.stopPolicy.maxWallClockMs > 0, 'stopPolicy carries finite step and wall-clock limits');
    assert.equal(plan.retryPolicy.maxSteps, undefined, 'retryPolicy must not carry stopPolicy fields');
    assert.equal(plan.stopPolicy.maxAttemptsPerStep, undefined, 'stopPolicy must not carry retryPolicy fields');
    // lease: renewal strictly before expiry; claim-time fields stay null until a runner claims the job.
    assert(plan.lease.renewalThresholdMs < plan.lease.leaseTtlMs, 'lease renewal must happen before expiry (unambiguous renewal semantics)');
    assert.equal(plan.lease.leaseId, null, 'an unclaimed plan lease has no claim-time id');
    // receiptPolicy: native gate_decision receipt with positive freshness / non-negative skew bounds.
    assert.equal(plan.receiptPolicy.requiredKind, 'gate_decision');
    assert(plan.receiptPolicy.freshnessMaxAgeMs > 0 && plan.receiptPolicy.clockSkewToleranceMs >= 0, 'receipt freshness / skew bounds must be unambiguous');
    // evidencePolicy: redaction + checklist coverage required; never continue without evidence by default.
    assert.equal(plan.evidencePolicy.redactionRequired, true);
    assert.equal(plan.evidencePolicy.checklistCoverageRequired, true);
    assert.equal(plan.evidencePolicy.allowContinueWithoutEvidence, false);
    // a planner-built plan passes its own consistency gate.
    assert.equal(assertJobPolicyConsistency(plan), plan, `a planner-built ${planMode} plan must pass the policy-consistency gate`);
  }

  // Suspicious / ambiguous policy values are REJECTED before a plan is treated as planned
  // (§B5: schema validation before execution). The validator is the JobPlan-level review gate.
  const negDraft = buildPlannerDraft(root, { request: 'Probe rejection of suspicious JobPlan policy values', mode: 'local', until: 'DONE' });
  const cleanPlan: any = buildJobPlan(negDraft, 'B-pol-neg', 'local-project', {});
  const mutate = (fn: (p: any) => void): any => { const p = JSON.parse(JSON.stringify(cleanPlan)); fn(p); return p; };
  const rejects = (p: any, label: string): void => assert.throws(() => assertJobPolicyConsistency(p), /job policy inconsistency/, label);
  rejects(mutate(p => { p.lease.renewalThresholdMs = p.lease.leaseTtlMs; }), 'lease renewal at/after expiry must be rejected');
  rejects(mutate(p => { p.receiptPolicy.freshnessMaxAgeMs = 0; }), 'zero receipt freshness must be rejected (enforce-mode disallows 0)');
  rejects(mutate(p => { p.providerPolicy.fallbackProviders = ['codex']; }), 'fallback to a non-allowed provider must be rejected');
  rejects(mutate(p => { p.worktreePolicy.preserveUnrelatedDirtyChanges = false; }), 'dropping unrelated dirty-change preservation must be rejected');
  rejects(mutate(p => { p.retryPolicy.maxSteps = 99; }), 'mixing a stopPolicy field into retryPolicy must be rejected');
  rejects(mutate(p => { delete p.receiptPolicy; }), 'a missing required policy block must be rejected');
  assert.equal(PlannedStepsSchema.safeParse(cleanPlan.plannedSteps).success, true, 'planner-built plannedSteps must pass the executable step schema');
  const noOperationSteps = JSON.parse(JSON.stringify(cleanPlan.plannedSteps));
  delete noOperationSteps[0].args.operation;
  assert.equal(PlannedStepsSchema.safeParse(noOperationSteps).success, false, 'plannedSteps without args.operation must be rejected as prose-only');
  const placeholderSteps = JSON.parse(JSON.stringify(cleanPlan.plannedSteps));
  placeholderSteps[0].title = 'TODO';
  assert.equal(PlannedStepsSchema.safeParse(placeholderSteps).success, false, 'placeholder plannedSteps must be rejected before execution');

  // evidencePolicy redaction + retention (§B4a / §B4b): SCOPE HONESTY. The CLI emits the
  // redaction flag and a per-kind retention map and the consistency gate rejects an unknown
  // retention class — but there is NO runtime evidence GC / retention-window enforcement and
  // NO content-redaction enforcement yet (Stage B gap; see lattice-authority-live-integration.md
  // "Minimal-projection gaps"). These assertions therefore pin POLICY EMISSION + the consistency
  // gate ONLY; they must not be read as proof of runtime deletion/redaction behavior.
  const KNOWN_RETENTION_CLASSES = ['short_lived_run_log', 'verification_artifact', 'receipt_bound_artifact', 'final_summary'];
  const retentionMap = cleanPlan.evidencePolicy.retentionClassByKind as Record<string, string>;
  assert(Object.keys(retentionMap).length > 0, 'evidencePolicy must emit an explicit per-kind retention map');
  for (const [kind, cls] of Object.entries(retentionMap)) {
    assert(KNOWN_RETENTION_CLASSES.includes(cls), `retention class for ${kind} must be a known class, got "${cls}"`);
  }
  // The receipt-bound class (§B4b: artifacts a passing receipt references must outlive a GC sweep)
  // and the final-summary class must be assigned to the kinds the doc names.
  assert.equal(retentionMap.gate_request, 'receipt_bound_artifact', 'gate_request evidence must be retention-classed receipt_bound_artifact');
  assert.equal(retentionMap.stop_summary, 'final_summary', 'stop_summary evidence must be retention-classed final_summary');
  // The consistency gate rejects an unknown retention class so a typo can never silently widen
  // (or drop) a retention window before the runtime layer that will consume it exists.
  rejects(mutate(p => { p.evidencePolicy.retentionClassByKind.run_record = 'keep_forever'; }), 'an unknown evidence retention class must be rejected');

  // planOnly threads the knob into the composed JobPlan AND persists the run record as planned
  // (no execution, no overclaim). This is the plan-only branch of planner run.
  const planOnlyRun = run(['lattice', 'planner', 'run', '--request=Plan only run that requires multi-host certification', '--mode=local', '--until=DONE', '--requireMultiHost', '--planOnly', '--json']);
  assert.equal(planOnlyRun.schemaVersion, 'lattice.job_plan.v1', 'planOnly returns the JobPlan, not an execution result');
  assert.equal(planOnlyRun.multiHostPolicy.requireMultiHost, true, 'planner run --requireMultiHost --planOnly must wire the knob into the JobPlan');
  assert.equal(planOnlyRun.execution, undefined, 'planOnly must not execute plannedSteps');
  const planOnlyStatus = run(['lattice', 'planner', 'status', `--runId=${planOnlyRun.plannerRunId}`, '--json']);
  assert.equal(planOnlyStatus.finalStatus, 'planned', 'a planOnly run must persist finalStatus=planned, not executed');
  assert.equal(planOnlyStatus.jobPlan.multiHostPolicy.requireMultiHost, true, 'the persisted run record must retain the multi-host requirement');

  const localRun = run(['lattice', 'planner', 'run', '--request=Add deterministic plannedSteps execution for local unattended development', '--mode=local', '--until=DONE', '--json']);
  assert.equal(localRun.schemaVersion, 'lattice.planner_run.v1');
  assert.equal(localRun.status, 'done');
  assert.equal(localRun.execution.schemaVersion, 'lattice.planned_steps_execution.v1');
  assert.equal(localRun.execution.status, 'done');
  assert.equal(localRun.execution.localDone, false, 'plannedSteps completion must not overclaim local Story lifecycle DONE');
  assert.equal(localRun.execution.authorityDone, false);
  assert.equal(localRun.execution.fullAuthorityDone, false);
  // A passing local plannedSteps run is the path most prone to silently masquerading as
  // authority-backed completion. Pin both receipt-coupled flags false on the DONE path,
  // not only on the blocked authority run below.
  assert.equal(localRun.execution.receiptVerified, false, 'local plannedSteps execution must never claim a verified native gate_decision receipt');
  assert.equal(localRun.execution.multiHostVerified, false, 'local plannedSteps execution must not claim multi-host verification');
  assert(localRun.execution.steps.some((step: JsonObject) => step.type === 'provider.fake'), 'planner run must consume provider.fake plannedSteps');
  // The fake provider is fixtures-only: its evidence must declare itself production-ineligible so
  // a deterministic test transcript can never be promoted into authority DONE evidence.
  const fakeProviderStep = localRun.execution.steps.find((step: JsonObject) => step.type === 'provider.fake');
  assert.equal(fakeProviderStep.status, 'passed', 'provider.fake step should pass deterministically');
  assert.equal(fakeProviderStep.summary.productionAuthorityEligible, false, 'provider.fake evidence must be production-authority-ineligible');
  assert(localRun.execution.steps.some((step: JsonObject) => step.type === 'gate.evaluate'), 'planner run must execute the gate step');
  const localRunStatus = run(['lattice', 'planner', 'status', `--runId=${localRun.plannerRunId}`, '--json']);
  assert.equal(localRunStatus.finalStatus, 'executed');
  assert.equal(localRunStatus.execution.status, 'done');

  // The natural-language request must have produced a real Story + JobPlan, and the plannedSteps
  // execution must bind that same Story end to end (NL -> Story -> JobPlan -> plannedSteps).
  assert.match(localRun.storyId, /^B-[0-9a-f]{4,6}$/i, 'planner run must create a real Lattice Story from the natural-language request');
  assert.equal(localRun.jobPlan.storyId, localRun.storyId, 'the JobPlan must bind the Story created from the request');
  assert.equal(localRun.execution.storyId, localRun.storyId, 'plannedSteps execution must bind the same created Story');
  const localSteps = localRun.execution.steps as JsonObject[];
  assert(localSteps.length >= 1 && localSteps.every((step: JsonObject) => step.status === 'passed'), 'a completed local execution must record every planned step as passed');
  assert.equal(localRun.execution.executedStepCount, localSteps.length, 'executedStepCount must match the recorded planned steps');
  assert.equal(localSteps[localSteps.length - 1].type, 'stop.summary', 'a completed local execution must reach the terminal stop.summary step');
  assert(!localSteps.some((step: JsonObject) => step.type === 'provider.codex' || step.type === 'provider.claude'), 'local unattended execution must not run real Codex/Claude providers');
  // The crux: the local gate step PASSES, yet that pass is planned-step certification only and must
  // never be promoted to Story lifecycle DONE.
  const localGate = localSteps.find((step: JsonObject) => step.type === 'gate.evaluate');
  assert(localGate && localGate.status === 'passed', 'local mode must execute and pass the gate step without a server receipt');
  assert.equal(localRun.execution.localDone, false, 'a passing local planned-step gate must not be treated as Story lifecycle DONE');
  assert(localRun.execution.evidenceRefs.length >= localSteps.length, 'every executed planned step must surface an evidence ref');
  assert(localRun.execution.evidenceRefs.every((ref: string) => ref.startsWith(`${localRun.storyId}:`)), 'plannedSteps evidence refs must bind the created Story');
  assert(localRun.execution.nextActions.some((action: string) => /local Story lifecycle has not reached DONE/i.test(action)), 'local completion must tell the operator that lifecycle DONE still requires the normal Lattice gates');

  const authorityRun = run([
    'lattice', 'planner', 'run',
    '--request=Run authority unattended development until DONE with receipt gating',
    '--mode=authority',
    '--until=DONE',
    '--allowUnattendedPlanning',
    '--json',
  ]);
  assert.equal(authorityRun.schemaVersion, 'lattice.planner_run.v1');
  assert.equal(authorityRun.status, 'blocked');
  assert.equal(authorityRun.execution.schemaVersion, 'lattice.planned_steps_execution.v1');
  assert.equal(authorityRun.execution.stopReason, 'authority_gate_decision_receipt_required');
  assert.equal(authorityRun.execution.authorityDone, false);
  assert.equal(authorityRun.execution.fullAuthorityDone, false);
  assert.equal(authorityRun.execution.receiptVerified, false);

  // Authority mode still plans NL -> Story -> JobPlan and executes bounded local work, but must block
  // PRECISELY at the gate on the missing native gate_decision receipt. The block must be non-vacuous:
  // provider + validation steps run first, then the gate refuses; nothing advances Story lifecycle.
  assert.match(authorityRun.storyId, /^B-[0-9a-f]{4,6}$/i, 'authority planner run must still create a Story + JobPlan from the request');
  assert.equal(authorityRun.execution.localDone, false, 'a receipt-blocked authority run must not claim local DONE either');
  assert.equal(authorityRun.execution.multiHostVerified, false, 'a receipt-blocked authority run must not claim multi-host verification');
  const authSteps = authorityRun.execution.steps as JsonObject[];
  const authGateIndex = authSteps.findIndex((step: JsonObject) => step.type === 'gate.evaluate');
  assert(authGateIndex >= 0, 'authority execution must reach the gate step');
  assert.equal(authSteps[authGateIndex].status, 'blocked', 'authority DONE must block at the gate step');
  assert.equal(authSteps[authGateIndex].reason, 'authority_gate_decision_receipt_required', 'the gate must block specifically on the missing native gate_decision receipt');
  assert(authSteps.slice(0, authGateIndex).every((step: JsonObject) => step.status === 'passed'), 'authority block must be non-vacuous: bounded work must run before the gate refuses');
  assert(authSteps.slice(0, authGateIndex).some((step: JsonObject) => step.type === 'provider.fake'), 'authority run must execute provider work before blocking at the receipt gate');
  assert(authSteps.slice(0, authGateIndex).some((step: JsonObject) => step.type === 'validate.run'), 'authority run must execute validation before blocking at the receipt gate');
  assert.equal(authGateIndex, authSteps.length - 1, 'execution must stop at the gate: no stop.summary or advance step runs after a receipt block');
  assert(!authSteps.some((step: JsonObject) => step.type === 'story.advance' && step.status === 'passed'), 'a receipt-blocked authority run must never advance Story lifecycle');
  assert(authorityRun.execution.nextActions.some((action: string) => /gate_decision receipt/i.test(action)), 'a receipt-blocked run must point the operator at native gate_decision receipt issuance');

  const interview = run(['lattice', 'planner', 'draft', '--request=Create an import workflow for customer CSV files', '--interactionMode=interview', '--json']);
  assert.equal(interview.status, 'paused');
  assert(interview.questions.length >= 5 && interview.questions.length <= 10, 'interview must ask 5-10 questions');

  const decisionGated = run(['lattice', 'planner', 'draft', '--request=Add a database migration for account billing records', '--interactionMode=decision-gated', '--json']);
  assert.equal(decisionGated.status, 'paused');
  assert.equal(decisionGated.pauseReason, 'major_decision_required');
  assert(decisionGated.requiredDecisions.length > 0);

  // autonomous mode asks no questions / requires no decisions and stays mechanically resolvable
  assert.equal(draft.questions.length, 0);
  assert.equal(draft.requiredDecisions.length, 0);
  const autonomousStatus = run(['lattice', 'planner', 'status', `--runId=${draft.plannerRunId}`, '--json']);
  assert.equal(autonomousStatus.finalStatus, 'planned');

  // interview mode resolves only after structured answers + explicit confirmation
  assert.equal(interview.pauseReason, 'interview_questions');
  writeFileSync(join(root, 'interview-answers.json'), JSON.stringify({ 'Q-001': 'CSV importer succeeds end to end', confirmed: true }));
  const interviewAnswer = run(['lattice', 'planner', 'answer', `--runId=${interview.plannerRunId}`, '--answersFile=interview-answers.json', '--json']);
  assert.equal(interviewAnswer.status, 'drafted');
  assert(interviewAnswer.confirmationDigest, 'interview confirmation digest must be recorded before resume');
  const interviewResume = run(['lattice', 'planner', 'resume', `--runId=${interview.plannerRunId}`, '--json']);
  assert.equal(interviewResume.status, 'drafted');

  // decision-gated mode resolves only after structured decision evidence
  writeFileSync(join(root, 'decision.json'), JSON.stringify({ 'D-001': 'approved to mutate Story/job', mutateStory: true }));
  const decisionSubmit = run(['lattice', 'planner', 'decision', 'submit', `--runId=${decisionGated.plannerRunId}`, '--decisionFile=decision.json', '--json']);
  assert.equal(decisionSubmit.status, 'drafted');
  assert(decisionSubmit.decisionReceiptDigest, 'decision-gated run must record a decision receipt digest');
  const decisionResume = run(['lattice', 'planner', 'resume', `--runId=${decisionGated.plannerRunId}`, '--json']);
  assert.equal(decisionResume.status, 'drafted');

  const invalidRedevelopment = run([
    'lattice', 'planner', 'draft',
    '--workflow=source-aligned-redevelopment',
    '--request=Rewrite the source project into Rust with behavior parity',
    '--sourceRepo=source',
    '--targetProject=target',
    '--targetProjectName=target-rs',
    '--sourceLanguage=typescript',
    '--targetLanguage=rust',
    '--json',
  ]);
  const invalidReview = run(['lattice', 'planner', 'review', `--runId=${invalidRedevelopment.plannerRunId}`, '--json']);
  assert.equal(invalidReview.status, 'blocked');
  assert(invalidReview.issues.some((issue: JsonObject) => issue.id === 'SRC-languageAdapterPolicy'));
  assert(invalidReview.issues.some((issue: JsonObject) => issue.id === 'SRC-parityOraclePolicy'));

  mkdirSync(join(root, 'source/src'), { recursive: true });
  writeFileSync(join(root, 'source/src/index.ts'), 'export function add(a:number,b:number){ return a + b; }\n');
  writeFileSync(join(root, 'source/.env'), 'SECRET=must-not-appear\n');
  const manifest = run(['lattice', 'planner', 'source-manifest', '--sourceRepo=source', '--includedPaths=src', '--json']);
  assert.equal(manifest.blocked, false);
  assert.equal(manifest.files.length, 1);
  assert.equal(manifest.files[0].path, 'src/index.ts');
  assert(!JSON.stringify(manifest).includes('must-not-appear'));
  assert(!manifest.files.some((file: JsonObject) => file.path === '.env' || file.path.endsWith('/.env')), 'source manifest must exclude .env secrets by path, not merely omit their contents');

  const validRedevelopment = run([
    'lattice', 'planner', 'draft',
    '--workflow=source-aligned-redevelopment',
    '--request=Rewrite the source project into Rust with behavior parity',
    '--sourceRepo=source',
    '--targetProject=target',
    '--targetProjectName=target-rs',
    '--sourceLanguage=typescript',
    '--targetLanguage=rust',
    '--includedPaths=src',
    '--languageAdapterPolicy={"adapterRegistryRef":"local","requiredAdapters":["typescript","rust"],"adapterUnavailableBehavior":"block"}',
    '--semanticMappingPolicy={"allowedMappingKinds":["1:1","1:N","N:1","mapped_to_gap"],"requiresMappingRationale":true,"forbidOptimizationForItsOwnSake":true}',
    '--parityOraclePolicy={"allowedOracleKinds":["target_build","target_test","cli_golden"],"sourceOnlyBehavior":"gap","requiresTargetRunnableEvidence":true}',
    '--alignmentVerificationIntent=build parity,target runnable tests',
    '--json',
  ]);
  const validReview = run(['lattice', 'planner', 'review', `--runId=${validRedevelopment.plannerRunId}`, '--json']);
  assert.equal(validReview.status, 'pass');
  const redevJob = run(['lattice', 'planner', 'create-job', `--runId=${validRedevelopment.plannerRunId}`, '--storyId=B-redev', '--json']);
  const operations = redevJob.plannedSteps.map((step: JsonObject) => step.args?.operation).filter(Boolean);
  assert(operations.includes('language.resolve_adapters'));
  assert(operations.includes('target.run_parity_oracles'));
  assert(redevJob.plannedSteps.every((step: JsonObject) => ['lattice.command', 'provider.fake', 'validate.run', 'gate.evaluate', 'stop.summary'].includes(step.type)));

  // cross-language proof: the planner is target-agnostic. The same TypeScript source redevelops into
  // multiple targets with identical canonical operations; language ids stay abstract policy strings, no
  // planned step kind hardcodes a single target, and target-runnable parity/gap rules hold per target.
  for (const targetLanguage of ['rust', 'python', 'go', 'swift', 'kotlin']) {
    const xlangDraft = run([
      'lattice', 'planner', 'draft',
      '--workflow=source-aligned-redevelopment',
      `--request=Rewrite the source project into ${targetLanguage} with behavior parity`,
      '--sourceRepo=source',
      '--targetProject=target',
      `--targetProjectName=target-${targetLanguage}`,
      '--sourceLanguage=typescript',
      `--targetLanguage=${targetLanguage}`,
      '--includedPaths=src',
      `--languageAdapterPolicy={"adapterRegistryRef":"local","requiredAdapters":["typescript","${targetLanguage}"],"adapterUnavailableBehavior":"block"}`,
      '--semanticMappingPolicy={"allowedMappingKinds":["1:1","1:N","N:1","mapped_to_gap"],"requiresMappingRationale":true,"forbidOptimizationForItsOwnSake":true}',
      '--parityOraclePolicy={"allowedOracleKinds":["target_build","target_test","cli_golden"],"sourceOnlyBehavior":"gap","requiresTargetRunnableEvidence":true}',
      '--alignmentVerificationIntent=build parity,target runnable tests',
      '--json',
    ]);
    const xlangReview = run(['lattice', 'planner', 'review', `--runId=${xlangDraft.plannerRunId}`, '--json']);
    assert.equal(xlangReview.status, 'pass', `source-aligned redevelopment into ${targetLanguage} must pass review with no target-specific policy`);
    const xlangJob = run(['lattice', 'planner', 'create-job', `--runId=${xlangDraft.plannerRunId}`, `--storyId=B-redev-${targetLanguage}`, '--json']);
    const xlangOps = xlangJob.plannedSteps.map((step: JsonObject) => step.args?.operation).filter(Boolean);
    // canonical operations are identical across targets: adapters resolve, target oracles run, gaps recorded
    assert(xlangOps.includes('language.resolve_adapters'), `language adapters must resolve for ${targetLanguage}`);
    assert(xlangOps.includes('target.run_parity_oracles'), `target-runnable parity oracles must run for ${targetLanguage}`);
    assert(xlangOps.includes('source.record_gaps'), `source-only constructs must record gaps for ${targetLanguage}`);
    // no planned step kind bakes a single target language (or a TS→target pair) into the schema
    assert(xlangJob.plannedSteps.every((step: JsonObject) => !String(step.type).toLowerCase().includes(targetLanguage) && !String(step.type).includes('typescript-')), `planned step types must not hardcode the ${targetLanguage} target`);
    // language ids round-trip as abstract policy strings, not enumerated step kinds
    const adapterStep = xlangJob.plannedSteps.find((step: JsonObject) => step.args?.operation === 'language.resolve_adapters');
    assert.deepEqual(adapterStep.args.sourceAlignedRedevelopmentSpec.languageAdapterPolicy.requiredAdapters, ['typescript', targetLanguage], `language ids must stay abstract strings for ${targetLanguage}`);
    // target-runnable parity + source-only gap rules are asserted, not optimized away
    const parityStep = xlangJob.plannedSteps.find((step: JsonObject) => step.args?.operation === 'target.run_parity_oracles');
    const parityPolicy = parityStep.args.sourceAlignedRedevelopmentSpec.parityOraclePolicy;
    assert.equal(parityPolicy.requiresTargetRunnableEvidence, true, `${targetLanguage} parity must require target-runnable evidence`);
    assert.equal(parityPolicy.sourceOnlyBehavior, 'gap', `${targetLanguage} source-only constructs must become gaps, not silent drops`);
  }

  // block rule remains non-vacuous across targets: a missing policy blocks regardless of target language
  const blockedGo = run([
    'lattice', 'planner', 'draft',
    '--workflow=source-aligned-redevelopment',
    '--request=Rewrite the source project into Go with behavior parity',
    '--sourceRepo=source',
    '--targetProject=target',
    '--targetProjectName=target-go',
    '--sourceLanguage=typescript',
    '--targetLanguage=go',
    '--includedPaths=src',
    '--json',
  ]);
  const blockedGoReview = run(['lattice', 'planner', 'review', `--runId=${blockedGo.plannerRunId}`, '--json']);
  assert.equal(blockedGoReview.status, 'blocked', 'missing redevelopment policies must block any target, not just rust');
  assert(blockedGoReview.issues.some((issue: JsonObject) => issue.id === 'SRC-languageAdapterPolicy'));
  assert(blockedGoReview.issues.some((issue: JsonObject) => issue.id === 'SRC-parityOraclePolicy'));

  const v1 = run(['lattice', 'autopilot', 'review', 'submit', '--storyId=B-plan', '--runId=run-1', '--hostId=codex-host', '--provider=codex', '--sessionId=s1', '--decision=pass', '--materialDigest=mat-1', '--json']);
  const v2 = run(['lattice', 'autopilot', 'review', 'submit', '--storyId=B-plan', '--runId=run-1', '--hostId=antigravity-host', '--provider=antigravity', '--sessionId=s2', '--decision=pass', '--materialDigest=mat-1', '--json']);
  const v3 = run(['lattice', 'autopilot', 'review', 'submit', '--storyId=B-plan', '--runId=run-1', '--hostId=codex-host', '--provider=codex', '--sessionId=s1', '--decision=pass', '--materialDigest=mat-1', '--json']);
  assert.equal(v1.schemaVersion, 'lattice.host_verdict.v1');
  assert.equal(v2.schemaVersion, 'lattice.host_verdict.v1');
  assert.equal(v3.schemaVersion, 'lattice.host_verdict.v1');
  const localSummary = run(['lattice', 'autopilot', 'review', 'status', '--storyId=B-plan', '--runId=run-1', '--json']);
  assert.equal(localSummary.status, 'pass');
  assert.equal(localSummary.localReviewCertified, true);
  assert.equal(localSummary.authorityDone, false);
  assert.equal(localSummary.fullAuthorityDone, false);
  assert.equal(localSummary.duplicateVerdicts, 1);
  // Local multi-host semantic tension (truth source §X9): a passing LOCAL wave is
  // certified ONLY via localReviewCertified. `multiHostVerified` is an Authority-mode
  // projection and must stay false in local mode even when the wave passes — local
  // review must never set authorityDone / fullAuthorityDone / multiHostVerified.
  assert.equal(localSummary.multiHostVerified, false, 'local review must never set multiHostVerified, even on a passing wave');
  assert.equal(localSummary.passingIndependentHosts, 2);

  const defaultRunStatus = run(['lattice', 'autopilot', 'review', 'status', '--storyId=B-plan', '--json']);
  assert.equal(defaultRunStatus.runId, 'default-run', 'status without runId keeps the default-run top-level view');
  assert.equal(defaultRunStatus.status, 'blocked', 'an empty default-run still reports the selected default run status');
  assert(defaultRunStatus.allRunIds.includes('default-run'), 'allRunIds includes the default-run compatibility view');
  assert(defaultRunStatus.allRunIds.includes('run-1'), 'allRunIds exposes custom run ids that would otherwise be hidden');
  assert(defaultRunStatus.allRuns.some((row: JsonObject) => row.runId === 'run-1' && row.status === 'pass'), 'allRuns preserves per-run status for custom run ids');
  assert(defaultRunStatus.latestRuns.some((row: JsonObject) => row.runId === 'run-1' && row.localReviewCertified === true), 'latestRuns includes the latest local review certification without moving it to the default-run top level');
  assert.equal(defaultRunStatus.authorityDone, false, 'default-run compatibility summary must not claim server-backed authorityDone');
  assert.equal(defaultRunStatus.fullAuthorityDone, false, 'default-run compatibility summary must not claim fullAuthorityDone');
  assert.equal(defaultRunStatus.multiHostVerified, false, 'local diagnostic summaries must not set multiHostVerified');
  assert.equal(defaultRunStatus.runDiagnostics.diagnosticOnly, true);
  assert.equal(defaultRunStatus.runDiagnostics.authorityServerContact, false);

  run(['lattice', 'autopilot', 'review', 'submit', '--storyId=B-run-diag', '--runId=round-pass', '--hostId=codex-pass', '--provider=codex', '--sessionId=s-pass-1', '--keyId=k-pass-1', '--decision=pass', '--materialDigest=fresh-material', '--json']);
  run(['lattice', 'autopilot', 'review', 'submit', '--storyId=B-run-diag', '--runId=round-pass', '--hostId=antigravity-pass', '--provider=antigravity', '--sessionId=s-pass-2', '--keyId=k-pass-2', '--decision=pass', '--materialDigest=fresh-material', '--json']);
  run(['lattice', 'autopilot', 'review', 'submit', '--storyId=B-run-diag', '--runId=round-stale', '--hostId=codex-stale', '--provider=codex', '--sessionId=s-stale-1', '--keyId=k-stale-1', '--decision=pass', '--materialDigest=stale-material', '--json']);
  run(['lattice', 'autopilot', 'review', 'submit', '--storyId=B-run-diag', '--runId=round-stale', '--hostId=antigravity-stale', '--provider=antigravity', '--sessionId=s-stale-2', '--keyId=k-stale-2', '--decision=pass', '--materialDigest=stale-material', '--json']);
  run(['lattice', 'autopilot', 'review', 'submit', '--storyId=B-run-diag', '--runId=round-dup', '--hostId=codex-dup', '--provider=codex', '--sessionId=shared-dup-session', '--keyId=k-dup-1', '--decision=pass', '--materialDigest=fresh-material', '--json']);
  run(['lattice', 'autopilot', 'review', 'submit', '--storyId=B-run-diag', '--runId=round-dup', '--hostId=antigravity-dup', '--provider=antigravity', '--sessionId=shared-dup-session', '--keyId=k-dup-2', '--decision=pass', '--materialDigest=fresh-material', '--json']);
  run(['lattice', 'autopilot', 'review', 'submit', '--storyId=B-run-diag', '--runId=round-fail', '--hostId=codex-fail', '--provider=codex', '--sessionId=s-fail-1', '--keyId=k-fail-1', '--decision=pass', '--materialDigest=fresh-material', '--json']);
  run(['lattice', 'autopilot', 'review', 'submit', '--storyId=B-run-diag', '--runId=round-fail', '--hostId=antigravity-fail', '--provider=antigravity', '--sessionId=s-fail-2', '--keyId=k-fail-2', '--decision=fail', '--materialDigest=fresh-material', '--json']);
  const runDiagnostics = summarizeVerdictRuns(root, 'local', 'B-run-diag', 'default-run', 2, { currentAnchor: { materialDigest: 'fresh-material' } });
  const runById = new Map(runDiagnostics.allRuns.map(row => [row.runId, row]));
  assert.equal(runById.get('round-pass')?.status, 'pass', 'a fresh independent custom run passes');
  assert.equal(runById.get('round-stale')?.status, 'blocked', 'stale custom runs must not count as passing');
  assert.equal(runById.get('round-stale')?.staleVerdicts, 2, 'all stale verdicts remain visible in the per-run diagnostic');
  assert.equal(runById.get('round-dup')?.status, 'blocked', 'duplicate-identity custom runs must not count as passing independence');
  assert.equal(runById.get('round-dup')?.duplicateVerdicts, 1);
  assert.equal(runById.get('round-fail')?.status, 'blocked', 'failing custom runs must not count as passing independence');
  assert.equal(runById.get('round-fail')?.failingIndependentHosts, 1);
  assert(runDiagnostics.latestRuns.some(row => row.runId === 'round-fail'), 'latestRuns exposes custom run ids from the newest submissions');
  assert.equal(runDiagnostics.authorityServerContact, false);
  assert.equal(runDiagnostics.diagnosticOnly, true);

  // Authority host verdicts are host opinions, not verified native gate_decision receipts.
  // Per docs/requirements/decisions/lattice-authority-live-integration.md, native receipt
  // verification is owned by the authority executor/verifier; the verdict summary reports a passing
  // multi-host wave (multiHostVerified=true) but must NEVER set authorityDone from host agreement.
  // (fullAuthorityDone is intentionally not asserted here: its receipt-coupling is owned by the
  // executor/verifier path and is the subject of active design, so this smoke pins only the durable
  // invariant — host verdicts never mint native-receipt authorityDone.)
  run(['lattice', 'authority', 'verdict', 'submit', '--jobId=job-1', '--runId=run-2', '--hostId=claude-host', '--provider=claude', '--sessionId=s3', '--decision=pass', '--materialDigest=mat-2', '--json']);
  run(['lattice', 'authority', 'verdict', 'submit', '--jobId=job-1', '--runId=run-2', '--hostId=antigravity-host', '--provider=antigravity', '--sessionId=s4', '--decision=pass', '--materialDigest=mat-2', '--json']);
  const authoritySummary = run(['lattice', 'authority', 'verdict', 'list', '--jobId=job-1', '--runId=run-2', '--json']);
  assert.equal(authoritySummary.status, 'pass');
  assert.equal(authoritySummary.multiHostVerified, true);
  assert.equal(authoritySummary.authorityDone, false, 'host verdicts do not replace verified native gate_decision receipts');
  // The mirror of the local invariant: localReviewCertified is a LOCAL-only label and
  // must stay false in authority mode. multiHostVerified is the Authority-side passing
  // wave signal; the two never cross modes.
  assert.equal(authoritySummary.localReviewCertified, false, 'localReviewCertified is local-only and must stay false in authority mode');
  assert.equal(authoritySummary.fullAuthorityDone, false, 'a passing authority host wave alone (no verified native receipt) must never mint fullAuthorityDone');

  // authority job status projects the verdict summary without minting or replacing native receipts
  const authorityJobStatus = run(['lattice', 'authority', 'job', 'status', '--jobId=job-1', '--runId=run-2', '--json']);
  assert.equal(authorityJobStatus.schemaVersion, 'lattice.authority_job_status.v1');
  assert.equal(authorityJobStatus.status, 'pass');
  assert.equal(authorityJobStatus.passingIndependentHosts, 2);
  assert.equal(authorityJobStatus.multiHostVerified, true);
  assert.equal(authorityJobStatus.authorityDone, false, 'job status must not claim native authorityDone from host verdicts alone');
  assert.equal(authorityJobStatus.fullAuthorityDone, false, 'two agreeing host verdicts must not mint fullAuthorityDone without a verified native gate_decision receipt');
  assert.equal(authorityJobStatus.nativeReceiptRequired, true);

  // multi-host gate is non-vacuous: a single independent host blocks both local review and authority job status
  const soloLocal = run(['lattice', 'autopilot', 'review', 'submit', '--storyId=B-solo', '--runId=run-solo', '--hostId=codex-host', '--provider=codex', '--sessionId=s-solo', '--decision=pass', '--materialDigest=mat-solo', '--json']);
  assert.equal(soloLocal.schemaVersion, 'lattice.host_verdict.v1');
  const soloLocalStatus = run(['lattice', 'autopilot', 'review', 'status', '--storyId=B-solo', '--runId=run-solo', '--json']);
  assert.equal(soloLocalStatus.status, 'blocked');
  assert.equal(soloLocalStatus.localReviewCertified, false);
  assert.equal(soloLocalStatus.multiHostVerified, false);

  run(['lattice', 'authority', 'verdict', 'submit', '--jobId=job-solo', '--runId=run-solo', '--hostId=claude-host', '--provider=claude', '--sessionId=s-solo', '--decision=pass', '--materialDigest=mat-solo', '--json']);
  const soloAuthorityStatus = run(['lattice', 'authority', 'job', 'status', '--jobId=job-solo', '--runId=run-solo', '--json']);
  assert.equal(soloAuthorityStatus.status, 'blocked');
  assert.equal(soloAuthorityStatus.fullAuthorityDone, false);
  assert.equal(soloAuthorityStatus.multiHostVerified, false);
  assert(soloAuthorityStatus.blockedReason, 'single-host authority job status must explain the multi-host shortfall');
  assert(/insufficient_independent_hosts/.test(soloAuthorityStatus.blockedReason), 'a coverage shortfall must be labeled insufficient_independent_hosts, not a disagreement');

  // Duplicate same-session rejection: two DIFFERENT host ids that share one provider
  // session are not materially independent (§X9). They must collapse to a single
  // independent host, so a two-verdict wave under one shared session still blocks.
  run(['lattice', 'autopilot', 'review', 'submit', '--storyId=B-sess', '--runId=run-sess', '--hostId=codex-host', '--provider=codex', '--sessionId=shared-session', '--decision=pass', '--materialDigest=mat-sess', '--json']);
  run(['lattice', 'autopilot', 'review', 'submit', '--storyId=B-sess', '--runId=run-sess', '--hostId=antigravity-host', '--provider=antigravity', '--sessionId=shared-session', '--decision=pass', '--materialDigest=mat-sess', '--json']);
  const sharedSessionStatus = run(['lattice', 'autopilot', 'review', 'status', '--storyId=B-sess', '--runId=run-sess', '--json']);
  assert.equal(sharedSessionStatus.totalVerdicts, 2, 'both same-session verdicts are stored for audit');
  assert.equal(sharedSessionStatus.independentHosts, 1, 'two verdicts sharing one session collapse to a single independent host');
  assert.equal(sharedSessionStatus.duplicateVerdicts, 1, 'the same-session second verdict is counted as a duplicate, not new independence');
  assert.equal(sharedSessionStatus.status, 'blocked', 'a same-session pair must not certify a multi-host wave');
  assert.equal(sharedSessionStatus.localReviewCertified, false);
  assert.equal(sharedSessionStatus.multiHostVerified, false);

  // Two genuinely independent hosts (distinct host id AND session) DO clear the floor —
  // proves the same-session collapse above is non-vacuous.
  run(['lattice', 'autopilot', 'review', 'submit', '--storyId=B-indep', '--runId=run-indep', '--hostId=codex-host', '--provider=codex', '--sessionId=sess-a', '--decision=pass', '--materialDigest=mat-indep', '--json']);
  run(['lattice', 'autopilot', 'review', 'submit', '--storyId=B-indep', '--runId=run-indep', '--hostId=antigravity-host', '--provider=antigravity', '--sessionId=sess-b', '--decision=pass', '--materialDigest=mat-indep', '--json']);
  const independentStatus = run(['lattice', 'autopilot', 'review', 'status', '--storyId=B-indep', '--runId=run-indep', '--json']);
  assert.equal(independentStatus.independentHosts, 2);
  assert.equal(independentStatus.status, 'pass');
  assert.equal(independentStatus.localReviewCertified, true);
  assert.equal(independentStatus.multiHostVerified, false, 'local certification still never sets multiHostVerified');

  // Disagreement blocks: one of two independent hosts FAILS. The wave must block with a
  // multi_host_disagreement reason (reconcile or return to DEV for repair, §X9), distinct
  // from a plain coverage shortfall.
  run(['lattice', 'authority', 'verdict', 'submit', '--jobId=job-dis', '--runId=run-dis', '--hostId=codex-host', '--provider=codex', '--sessionId=s-dis-1', '--decision=pass', '--materialDigest=mat-dis', '--json']);
  run(['lattice', 'authority', 'verdict', 'submit', '--jobId=job-dis', '--runId=run-dis', '--hostId=antigravity-host', '--provider=antigravity', '--sessionId=s-dis-2', '--decision=fail', '--materialDigest=mat-dis', '--json']);
  const disagreementStatus = run(['lattice', 'authority', 'job', 'status', '--jobId=job-dis', '--runId=run-dis', '--json']);
  assert.equal(disagreementStatus.independentHosts, 2, 'both hosts are independent; the wave is non-vacuous');
  assert.equal(disagreementStatus.failingIndependentHosts, 1);
  assert.equal(disagreementStatus.status, 'blocked');
  assert.equal(disagreementStatus.multiHostVerified, false, 'a failing independent verdict must block multiHostVerified');
  assert.equal(disagreementStatus.fullAuthorityDone, false);
  assert(/multi_host_disagreement/.test(disagreementStatus.blockedReason), 'an independent verdict failure must be reported as multi_host_disagreement');

  // A host that fails then re-submits a pass under a fresh session cannot launder the
  // disagreement away: same host id collapses both verdicts, and the fail-closed rule
  // keeps the host failing.
  run(['lattice', 'authority', 'verdict', 'submit', '--jobId=job-dis', '--runId=run-dis', '--hostId=antigravity-host', '--provider=antigravity', '--sessionId=s-dis-3', '--decision=pass', '--materialDigest=mat-dis', '--json']);
  const launderStatus = run(['lattice', 'authority', 'job', 'status', '--jobId=job-dis', '--runId=run-dis', '--json']);
  assert.equal(launderStatus.independentHosts, 2, 'the re-submission collapses into the same antigravity host, not a third host');
  assert.equal(launderStatus.failingIndependentHosts, 1, 'a host that ever failed stays failing (fail-closed) despite a later pass');
  assert.equal(launderStatus.status, 'blocked');
  assert.equal(launderStatus.multiHostVerified, false);

  // --- M7 provider executor gating (in-process; never spawns a real provider) ---
  // Drive executePlannedSteps directly with synthetic JobPlans so the codex/claude
  // provider branches are exercised deterministically, with a stubbed bounded executor.
  const provStore = {
    readStory: () => ({ phase: 'DEV' } as JsonObject),
    storyExists: () => true,
    listStoryIds: () => [] as string[],
    appendProcessEvent: () => {},
  } as any;
  const provStub = (available: boolean, result?: Partial<ProviderExecResult>): BoundedProviderExecutor => ({
    available: () => available,
    run: (req): ProviderExecResult => ({
      provider: req.provider,
      argvDigest: 'argv-digest',
      exitCode: 0,
      stdoutDigest: 'stdout-digest',
      stderrDigest: 'stderr-digest',
      stdoutBytes: 12,
      stderrBytes: 0,
      durationMs: 4,
      attempts: 1,
      timedOut: false,
      spawnError: false,
      ...result,
    }),
  });
  const provStep = (type: 'provider.codex' | 'provider.claude', argv?: string[]): JsonObject => ({
    stepId: 'step-provider',
    type,
    title: 'bounded provider',
    purpose: 'bounded provider action',
    cwdPolicy: 'story-worktree',
    timeoutMs: 30_000,
    maxAttempts: 1,
    requiresCleanWorktree: true,
    producesEvidence: true,
    blocksUntilEvidenceUploaded: true,
    provider: type === 'provider.codex' ? 'codex' : 'claude',
    evidenceBinding: 'B-syn:provider',
    args: argv ? { operation: 'implement', argv } : { operation: 'implement' },
  });
  const provPlan = (step: JsonObject, providerPolicy: JsonObject): JsonObject => ({
    schemaVersion: 'lattice.job_plan.v1',
    plannerRunId: 'run-syn',
    storyId: 'B-syn',
    mode: 'local',
    until: 'DONE',
    developmentWorkflow: 'standard',
    plannedSteps: [step],
    coverageMap: [],
    multiHostPolicy: {},
    providerPolicy,
    plannerDigest: 'pd',
    jobPlanDigest: 'jd',
    status: 'planned',
  });
  const provExec = (jobPlan: JsonObject, env: JsonObject, executor: BoundedProviderExecutor): JsonObject =>
    executePlannedSteps({ root, store: provStore, jobPlan: jobPlan as any, env, providerExecutor: executor }) as JsonObject;

  // disabled: provider not in allowedProviders -> fail closed before any spawn
  const provDisabled = provExec(
    provPlan(provStep('provider.codex', ['--version']), { allowedProviders: [], credentialsEnvAllowlist: [] }),
    {}, provStub(true));
  assert.equal(provDisabled.status, 'blocked');
  assert.equal(provDisabled.stopReason, 'disabled');
  assert.equal(provDisabled.steps[0].reason, 'disabled');
  assert.equal(provDisabled.authorityDone, false);
  assert.equal(provDisabled.receiptVerified, false);

  // provider_unavailable: enabled + credentials present, but CLI not available
  const provUnavailable = provExec(
    provPlan(provStep('provider.codex', ['--version']), { allowedProviders: ['codex'], credentialsEnvAllowlist: ['CODEX_KEY'] }),
    { CODEX_KEY: 'k' }, provStub(false));
  assert.equal(provUnavailable.stopReason, 'provider_unavailable');
  assert.equal(provUnavailable.steps[0].reason, 'provider_unavailable');

  // credential_unavailable: enabled + available, but no configured credential present
  const provNoCred = provExec(
    provPlan(provStep('provider.claude', ['--version']), { allowedProviders: ['claude'], credentialsEnvAllowlist: ['CLAUDE_KEY'] }),
    {}, provStub(true));
  assert.equal(provNoCred.stopReason, 'credential_unavailable');
  assert.equal(provNoCred.steps[0].reason, 'credential_unavailable');

  // provider_request_invalid: missing/shell-string argv is rejected (no spawn)
  const provInvalid = provExec(
    provPlan(provStep('provider.codex'), { allowedProviders: ['codex'], credentialsEnvAllowlist: ['CODEX_KEY'] }),
    { CODEX_KEY: 'k' }, provStub(true));
  assert.equal(provInvalid.steps[0].reason, 'provider_request_invalid');

  // bounded success: runs, captures digests, and NEVER equals validation / DONE
  let capturedReq: JsonObject | null = null;
  const provOk = provExec(
    provPlan(provStep('provider.codex', ['exec', '--task', 'implement']),
      { allowedProviders: ['codex'], productionDoneProviders: ['codex'], credentialsEnvAllowlist: ['CODEX_KEY'] }),
    { CODEX_KEY: 'secret-value', PATH: '/usr/bin', UNRELATED_SECRET: 'leak-me' },
    {
      available: () => true,
      run: (req): ProviderExecResult => {
        capturedReq = req as any;
        return { provider: req.provider, argvDigest: 'ad', exitCode: 0, stdoutDigest: 'sd', stderrDigest: 'ed', stdoutBytes: 3, stderrBytes: 0, durationMs: 7, attempts: 1, timedOut: false, spawnError: false };
      },
    });
  const okStep = provOk.steps[0];
  assert.equal(okStep.status, 'passed');
  assert.equal(okStep.type, 'provider.codex');
  assert.equal(okStep.summary.validationSatisfied, false, 'provider success must never equal validation success');
  assert.equal(okStep.summary.providerProseAcceptedAsEvidence, false);
  assert.equal(okStep.summary.productionAuthorityEligible, false);
  assert.equal(okStep.summary.exitCode, 0);
  assert.equal(typeof okStep.summary.stdoutDigest, 'string');
  assert.equal(provOk.authorityDone, false);
  assert.equal(provOk.fullAuthorityDone, false);
  assert.equal(provOk.receiptVerified, false);
  assert.equal(provOk.multiHostVerified, false);
  // bounded request: explicit argv + cwd + timeout; redacted env carries ONLY the allowlisted credential
  assert.deepEqual(capturedReq!.argv, ['exec', '--task', 'implement']);
  assert.equal(capturedReq!.cwd, root);
  assert.equal(capturedReq!.timeoutMs, 30_000);
  assert.equal(capturedReq!.env.CODEX_KEY, 'secret-value', 'allowlisted credential is projected to the provider process');
  assert.equal(capturedReq!.env.UNRELATED_SECRET, undefined, 'non-allowlisted env must be redacted out of the provider projection');
  assert(!JSON.stringify(provOk).includes('secret-value'), 'raw credential must never surface in provider execution evidence');

  // provider failure (non-zero exit) is a step failure, not a validation pass or DONE
  const provFail = provExec(
    provPlan(provStep('provider.codex', ['exec']), { allowedProviders: ['codex'], credentialsEnvAllowlist: ['CODEX_KEY'] }),
    { CODEX_KEY: 'k' }, provStub(true, { exitCode: 2, stderrBytes: 9 }));
  assert.equal(provFail.steps[0].status, 'failed');
  assert.equal(provFail.steps[0].reason, 'provider_failed');
  assert.equal(provFail.status, 'failed');
  assert.equal(provFail.authorityDone, false);

  // --- provider_timeout vs no_progress stop classification (E5 gap closure) ---
  // A SINGLE bounded attempt that times out is a retryable provider_timeout (failed).
  const provTimeout = provExec(
    provPlan(provStep('provider.codex', ['exec']), { allowedProviders: ['codex'], credentialsEnvAllowlist: ['CODEX_KEY'] }),
    { CODEX_KEY: 'k' }, provStub(true, { timedOut: true, attempts: 1 }));
  assert.equal(provTimeout.steps[0].status, 'failed', 'a single-attempt provider timeout is a retryable failure, not a hard block');
  assert.equal(provTimeout.steps[0].reason, 'provider_timeout');
  assert.equal(provTimeout.status, 'failed');
  assert.equal(provTimeout.stopReason, 'provider_timeout');
  assert.equal(provTimeout.authorityDone, false);
  assert.equal(provTimeout.receiptVerified, false);

  // When the bounded retry budget (>1 attempt) is exhausted and EVERY attempt timed out,
  // the step made no progress -> a blocked `no_progress` stop (release/stop, never DONE).
  const noProgressStep: JsonObject = { ...provStep('provider.codex', ['exec']), stepId: 'step-noprogress', maxAttempts: 2 };
  const provNoProgress = provExec(
    provPlan(noProgressStep, { allowedProviders: ['codex'], credentialsEnvAllowlist: ['CODEX_KEY'] }),
    { CODEX_KEY: 'k' }, provStub(true, { timedOut: true, attempts: 2 }));
  assert.equal(provNoProgress.steps[0].status, 'blocked', 'an exhausted retry budget with no progress blocks the step');
  assert.equal(provNoProgress.steps[0].reason, 'no_progress');
  assert.equal(provNoProgress.status, 'blocked');
  assert.equal(provNoProgress.stopReason, 'no_progress', 'no_progress is a distinct blocked stop reason, not provider_timeout');
  assert.equal(provNoProgress.steps[0].summary.attempts, 2, 'no_progress evidence records the exhausted attempt count');
  assert.equal(provNoProgress.authorityDone, false);
  assert.equal(provNoProgress.receiptVerified, false);

  // --- planner intake digest preservation: paragraph + requestFile (E5 gap) ---
  // The natural-language intake digest must cover the WHOLE request body, not just the
  // first line / title, and a requestFile must hash identically to the same inline text.
  const paragraph = 'Add a CSV import command.\nIt must validate headers.\nAnd reject rows with missing required fields.';
  const paraA = buildPlannerDraft(root, { request: paragraph, mode: 'local' });
  const paraB = buildPlannerDraft(root, { request: paragraph, mode: 'local' });
  assert.equal(paraA.request, paragraph, 'the full multi-line paragraph is preserved verbatim in the draft request');
  assert.equal(paraA.naturalLanguageDigest, paraB.naturalLanguageDigest, 'intake digest is deterministic for identical paragraphs');
  const paraVariant = buildPlannerDraft(root, { request: 'Add a CSV import command.\nIt must validate headers.\nAnd silently drop bad rows.', mode: 'local' });
  assert.notEqual(paraA.naturalLanguageDigest, paraVariant.naturalLanguageDigest, 'a body change under the same first line must change the intake digest');
  assert.notEqual(paraA.plannerRunId, paraVariant.plannerRunId, 'plannerRunId derives from the full-intake digest, not just the title line');
  writeFileSync(join(root, 'intake.md'), paragraph);
  const fileDraft = run(['lattice', 'planner', 'draft', '--requestFile=intake.md', '--mode=local', '--json']);
  assert.equal(fileDraft.request, paragraph, 'requestFile content is read verbatim into the intake request');
  assert.equal(fileDraft.naturalLanguageDigest, paraA.naturalLanguageDigest, 'requestFile preserves the same intake digest as the identical inline request');

  // --- duplicate-request idempotency + --forceNewRun (E5 gap closure) ---------
  // The planner idempotency scope is the full-intake digest + interaction mode: an identical
  // request deterministically resolves to the SAME plannerRunId, and the duplicate run reuses
  // the same Story scope rather than forking a second one.
  const dupRequest = 'Add an idempotent planner intake regression probe with bounded local scope';
  const dup1 = run(['lattice', 'planner', 'run', `--request=${dupRequest}`, '--mode=local', '--until=DONE', '--planOnly', '--json']);
  const dup2 = run(['lattice', 'planner', 'run', `--request=${dupRequest}`, '--mode=local', '--until=DONE', '--planOnly', '--json']);
  assert.equal(dup1.plannerRunId, dup2.plannerRunId, 'an identical request resolves to the same deterministic plannerRunId (idempotent scope)');
  assert.equal(dup1.storyId, dup2.storyId, 'a duplicate planner run reuses the same Story scope, not a forked duplicate');
  // --forceNewRun / --forceNewRunReason now fork a DISTINCT idempotency scope: the intake digest is
  // unchanged (same request text) but plannerRunId, the Story scope, and the job plan all diverge so
  // an operator can deliberately re-run an identical request against fresh state instead of colliding
  // with the prior run. The forced reason/scope are surfaced in the job plan JSON + digests so this is
  // mechanically provable, not prose.
  const forceReason = 'regression probe wants a distinct scope';
  const forced = run(['lattice', 'planner', 'run', `--request=${dupRequest}`, '--mode=local', '--until=DONE', '--planOnly', '--forceNewRun', `--forceNewRunReason=${forceReason}`, '--json']);
  assert.notEqual(forced.plannerRunId, dup1.plannerRunId, '--forceNewRun forks a distinct deterministic plannerRunId (new idempotency scope)');
  assert.notEqual(forced.storyId, dup1.storyId, '--forceNewRun forks a distinct Story scope rather than reusing the default run');
  assert.equal(forced.forceNewRun, true, 'the forced job plan records forceNewRun=true so the fork is auditable in JSON');
  assert.equal(forced.forceNewRunReason, forceReason, 'the forced reason is preserved verbatim in the job plan record');
  assert.equal(typeof forced.forceScope?.scopeDigest, 'string', 'the forced scope digest is exposed for downstream provenance');
  assert.notEqual(forced.jobPlanDigest, dup1.jobPlanDigest, 'a forced run produces a distinct jobPlanDigest (forced scope folds into the digest)');
  // A repeated forced run with the SAME reason is deterministic: it collapses back onto the forked
  // scope/Story rather than spawning an unbounded chain of duplicates.
  const forcedAgain = run(['lattice', 'planner', 'run', `--request=${dupRequest}`, '--mode=local', '--until=DONE', '--planOnly', '--forceNewRun', `--forceNewRunReason=${forceReason}`, '--json']);
  assert.equal(forcedAgain.plannerRunId, forced.plannerRunId, 'an identical forced request stays idempotent within the forced scope (same plannerRunId)');
  assert.equal(forcedAgain.storyId, forced.storyId, 'an identical forced request reuses the forked Story, not a second fork');
  // A different reason forks a different scope (the reason is part of the idempotency key).
  const forcedOtherReason = run(['lattice', 'planner', 'run', `--request=${dupRequest}`, '--mode=local', '--until=DONE', '--planOnly', '--forceNewRun', '--forceNewRunReason=a separate operator intent', '--json']);
  assert.notEqual(forcedOtherReason.plannerRunId, forced.plannerRunId, 'a different forceNewRunReason forks a distinct scope (reason is part of the idempotency key)');
  assert.notEqual(forcedOtherReason.storyId, forced.storyId, 'a different forceNewRunReason forks a distinct Story');
  // --forceNewRun WITHOUT a reason fails closed (the fork must be attributable).
  let forcedNoReasonFailed = false;
  try {
    run(['lattice', 'planner', 'run', `--request=${dupRequest}`, '--mode=local', '--until=DONE', '--planOnly', '--forceNewRun', '--json']);
  } catch {
    forcedNoReasonFailed = true;
  }
  assert.equal(forcedNoReasonFailed, true, '--forceNewRun without --forceNewRunReason fails closed instead of silently forking');

  // --- deferredOptimizations must never enter plannedSteps (E5 gap closure) ---
  // deferredOptimizations is planner DRAFT metadata ("defer unrequested refactors/optimizations").
  // It must never be projected into executable plannedSteps — the executor runs the smallest
  // verifiable set, never speculative optimization work ("don't optimize for the sake of it").
  const deferDraft = buildPlannerDraft(root, { request: 'Implement a bounded health-check command with validation evidence', mode: 'local', until: 'DONE' });
  assert(deferDraft.deferredOptimizations.length >= 1, 'the draft must actually carry deferredOptimizations (non-vacuous guard)');
  const deferJob: any = buildJobPlan(deferDraft, 'B-defer', 'local-project', {});
  const plannedStepsJson = JSON.stringify(deferJob.plannedSteps);
  for (const opt of deferDraft.deferredOptimizations) {
    assert(!plannedStepsJson.includes(opt), 'a deferredOptimization string must not leak into any planned step');
  }
  assert.equal(deferJob.deferredOptimizations, undefined, 'the JobPlan must not carry deferredOptimizations at all');
  assert(deferJob.plannedSteps.every((step: JsonObject) => !/\b(optimiz|refactor)/i.test(String(step.purpose ?? ''))), 'no planned step purpose may describe speculative optimization/refactor work');
} finally {
  resetConfigCache();
  rmSync(root, { recursive: true, force: true });
}

console.log('✓ planner unattended smoke passed: autonomous/interview/decision-gated modes, source-aligned redevelopment block/pass, typed plannedSteps + story.resolve, authority job status, multi-host local/authority verdict block/pass, local-only multiHostVerified tension, same-session duplicate collapse, multi_host_disagreement block, M7 provider gating (disabled/provider_unavailable/credential_unavailable/invalid + bounded success never equals validation/DONE), provider_timeout vs no_progress stop classification, paragraph/requestFile intake digest preservation, duplicate-request idempotency + --forceNewRun forked scope (distinct run/Story/jobPlanDigest, reason-keyed idempotency, fail-closed on missing reason), and deferredOptimizations never entering plannedSteps verified');
