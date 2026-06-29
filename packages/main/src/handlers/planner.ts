import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HandlerContext } from './context.js';
import { createStoryCreateHandlers } from './story-create.js';
import {
  buildJobPlan,
  buildPlannerDraft,
  listPlannerRuns,
  readPlannerRun,
  reviewPlannerDraft,
  sourceManifestDigest,
  writePlannerArtifact,
  writePlannerRun,
  type PlannerDraft,
  type PlannerDraftArgs,
  type PlannerRunRecord,
} from '../core/planner.js';
import { executePlannedSteps } from '../core/planned-steps-executor.js';
import { canonicalDigest } from '../core/authority-signing.js';
import { LATTICE_DIR } from '../core/lattice-paths.js';

/**
 * @task B-e3d9
 * @checklist CHK-004
 * @title Enforce planner confirmation before story creation
 * @type bugfix
 * @priority high
 * @description
 *   Handler linkage for requiresConfirmationBeforeStoryCreate: planner_create_story
 *   checks the persisted confirmationDigest and returns "confirmation required
 *   before Story creation" before invoking story_create when confirmation is
 *   required by plannerPolicy.
 * @changes
 *   - [CHK-004] Connect requiresConfirmationBeforeStoryCreate to fail-closed planner_create_story behavior covered by planner-unattended-smoke
 */

type JsonArgs = { json?: boolean; format?: 'text' | 'json' };

function wantsJson(args: JsonArgs | undefined): boolean {
  return args?.json === true || args?.format === 'json';
}

function readJsonFile<T>(root: string, file: string): T {
  const path = file.startsWith('/') ? file : join(root, file);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function digestFile(root: string, file: string): string {
  return canonicalDigest(readJsonFile(root, file));
}

function renderLines(title: string, data: Record<string, unknown>): string {
  const lines = [title];
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: ${value.length}`);
    } else if (value && typeof value === 'object') {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    } else {
      lines.push(`${key}: ${String(value)}`);
    }
  }
  return lines.join('\n');
}

function loadDraft(ctx: HandlerContext, args: { draftFile?: string; runId?: string }): PlannerDraft {
  if (args.draftFile) return readJsonFile<PlannerDraft>(ctx.root, args.draftFile);
  if (args.runId) {
    const record = readPlannerRun(ctx.root, args.runId);
    if (record.draft) return record.draft;
  }
  throw new Error('draftFile or runId is required');
}

function saveRecord(ctx: HandlerContext, record: PlannerRunRecord): PlannerRunRecord {
  writePlannerRun(ctx.root, record);
  return record;
}

function draftRecord(draft: PlannerDraft): PlannerRunRecord {
  return {
    schemaVersion: 'lattice.planner_run_record.v1',
    plannerRunId: draft.plannerRunId,
    draft,
    decisionReceiptDigests: [],
    finalStatus: draft.status === 'paused' ? 'paused' : 'drafted',
    updatedAt: new Date().toISOString(),
  };
}

function parseCreatedStoryId(output: string): string {
  const match = output.match(/\bB-[0-9a-f]{4,6}\b/i);
  if (!match) throw new Error(`planner create-story could not find created Story id in story_create output: ${output}`);
  return match[0];
}

function backgroundForDraft(draft: PlannerDraft): string {
  return [
    '## Trigger Event',
    `Planner request ${draft.plannerRunId} created this Story from canonical natural-language input.`,
    '',
    '## Key Insights',
    'The Story must keep Proofbound evidence, receipt, and lifecycle gates mechanical. Provider prose is not gate evidence.',
    '',
    '## Solution Tradeoffs',
    'Use the smallest verifiable plannedSteps set. Defer unrelated refactors and optimizations unless required by safety or verification.',
    '',
    '## Conversational Texture',
    'The user wants unattended development, but final DONE must remain bounded by local or Authority evidence and independent host review policy.',
  ].join('\n');
}

export function createPlannerHandlers(ctx: HandlerContext) {
  const handlers = {
    planner_draft(args: PlannerDraftArgs & JsonArgs = {}) {
      const draft = buildPlannerDraft(ctx.root, args);
      const record = draftRecord(draft);
      saveRecord(ctx, record);
      if (wantsJson(args)) return draft;
      return renderLines(`Proofbound planner draft (${draft.schemaVersion})`, {
        plannerRunId: draft.plannerRunId,
        plannerDraftId: draft.plannerDraftId,
        interactionMode: draft.interactionMode,
        mode: draft.mode,
        until: draft.until,
        developmentWorkflow: draft.developmentWorkflow,
        status: draft.status,
        questions: draft.questions.length,
        requiredDecisions: draft.requiredDecisions.length,
        plannerDigest: draft.plannerDigest,
      });
    },

    planner_review(args: { draftFile?: string; runId?: string } & JsonArgs) {
      const draft = loadDraft(ctx, args);
      const review = reviewPlannerDraft(draft);
      let record: PlannerRunRecord;
      try {
        record = readPlannerRun(ctx.root, draft.plannerRunId);
      } catch {
        record = draftRecord(draft);
      }
      record.review = review;
      record.finalStatus = review.status === 'pass' ? 'drafted' : 'blocked';
      record.updatedAt = new Date().toISOString();
      saveRecord(ctx, record);
      if (wantsJson(args)) return review;
      return renderLines(`Proofbound planner review (${review.schemaVersion})`, {
        plannerRunId: review.plannerRunId,
        status: review.status,
        issueCount: review.issueCount,
        plannerDigest: review.plannerDigest,
      });
    },

    planner_create_story(args: { draftFile?: string; runId?: string; forceNew?: boolean } & JsonArgs) {
      const draft = loadDraft(ctx, args);
      const review = reviewPlannerDraft(draft);
      if (review.status !== 'pass') {
        const result = {
          schemaVersion: 'lattice.planner_create_story.v1' as const,
          status: 'blocked' as const,
          plannerRunId: draft.plannerRunId,
          issueCount: review.issueCount,
          issues: review.issues,
        };
        if (wantsJson(args)) return result;
        return renderLines(`Proofbound planner create-story (${result.schemaVersion})`, result);
      }
      if (draft.plannerPolicy.requiresConfirmationBeforeStoryCreate) {
        let record: PlannerRunRecord | null = null;
        try { record = readPlannerRun(ctx.root, draft.plannerRunId); } catch { /* no state */ }
        if (!record?.confirmationDigest) {
          const result = {
            schemaVersion: 'lattice.planner_create_story.v1' as const,
            status: 'blocked' as const,
            plannerRunId: draft.plannerRunId,
            blockedReason: 'confirmation required before Story creation',
          };
          if (wantsJson(args)) return result;
          return renderLines(`Proofbound planner create-story (${result.schemaVersion})`, result);
        }
      }
      const storyCreate = createStoryCreateHandlers(ctx).story_create;
      const output = storyCreate({
        name: draft.storyDraft.name,
        title: draft.storyDraft.title,
        description: draft.storyDraft.description,
        type: draft.storyDraft.type,
        priority: draft.storyDraft.priority,
        forceNew: args.forceNew,
        background: backgroundForDraft(draft),
        checklist: draft.checklist.map(item => ({
          title: item.title,
          context: item.context,
          relatedDocs: item.relatedDocs,
          verificationIntent: item.verificationIntent,
        })),
      });
      const storyId = parseCreatedStoryId(output);
      let record: PlannerRunRecord;
      try {
        record = readPlannerRun(ctx.root, draft.plannerRunId);
      } catch {
        record = draftRecord(draft);
      }
      record.review = review;
      record.storyId = storyId;
      record.finalStatus = 'planned';
      record.updatedAt = new Date().toISOString();
      saveRecord(ctx, record);
      ctx.store.appendProcessEvent(storyId, {
        type: 'planner_story_created',
        plannerRunId: draft.plannerRunId,
        plannerDraftId: draft.plannerDraftId,
        plannerDigest: draft.plannerDigest,
      });
      const result = {
        schemaVersion: 'lattice.planner_create_story.v1' as const,
        status: 'created' as const,
        plannerRunId: draft.plannerRunId,
        storyId,
        storyCreateOutput: output,
      };
      if (wantsJson(args)) return result;
      return renderLines(`Proofbound planner create-story (${result.schemaVersion})`, result);
    },

    planner_create_job(args: { storyId?: string; draftFile?: string; runId?: string; projectId?: string; requireMultiHost?: boolean; requiredHostVerdictCount?: number } & JsonArgs) {
      const draft = args.draftFile || args.runId
        ? loadDraft(ctx, args)
        : buildPlannerDraft(ctx.root, { request: `Create job for ${args.storyId}`, mode: 'local' });
      const storyId = args.storyId ?? (args.runId ? readPlannerRun(ctx.root, args.runId).storyId : undefined);
      if (!storyId) throw new Error('storyId is required when no planner run has created a Story');
      const review = reviewPlannerDraft(draft);
      if (review.status !== 'pass') {
        const result = { schemaVersion: 'lattice.job_plan.v1' as const, status: 'blocked' as const, storyId, plannerRunId: draft.plannerRunId, issues: review.issues };
        return wantsJson(args) ? result : renderLines('Proofbound planner create-job (blocked)', result);
      }
      const jobPlan = buildJobPlan(draft, storyId, args.projectId, {
        requireMultiHost: args.requireMultiHost,
        requiredHostVerdictCount: args.requiredHostVerdictCount,
      });
      let record: PlannerRunRecord;
      try {
        record = readPlannerRun(ctx.root, draft.plannerRunId);
      } catch {
        record = draftRecord(draft);
      }
      record.review = review;
      record.storyId = storyId;
      record.jobPlan = jobPlan;
      record.finalStatus = jobPlan.status === 'planned' ? 'planned' : 'blocked';
      record.updatedAt = new Date().toISOString();
      saveRecord(ctx, record);
      ctx.store.appendProcessEvent(storyId, {
        type: 'planner_job_created',
        plannerRunId: draft.plannerRunId,
        jobPlanDigest: jobPlan.jobPlanDigest,
        plannedStepCount: jobPlan.plannedSteps.length,
        mode: jobPlan.mode,
        status: jobPlan.status,
      });
      if (wantsJson(args)) return jobPlan;
      return renderLines(`Proofbound planner create-job (${jobPlan.schemaVersion})`, {
        plannerRunId: jobPlan.plannerRunId,
        storyId: jobPlan.storyId,
        status: jobPlan.status,
        mode: jobPlan.mode,
        plannedSteps: jobPlan.plannedSteps.length,
        jobPlanDigest: jobPlan.jobPlanDigest,
      });
    },

    planner_status(args: { runId?: string } & JsonArgs = {}) {
      const result = args.runId
        ? readPlannerRun(ctx.root, args.runId)
        : { schemaVersion: 'lattice.planner_status.v1' as const, runs: listPlannerRuns(ctx.root) };
      if (wantsJson(args)) return result;
      if ('runs' in result) return renderLines(`Proofbound planner status (${result.schemaVersion})`, { runs: result.runs.length });
      return renderLines(`Proofbound planner status (${result.schemaVersion})`, {
        plannerRunId: result.plannerRunId,
        storyId: result.storyId ?? '',
        finalStatus: result.finalStatus,
        updatedAt: result.updatedAt,
      });
    },

    planner_answer(args: { runId: string; answersFile: string } & JsonArgs) {
      const record = readPlannerRun(ctx.root, args.runId);
      const answers = readJsonFile<Record<string, unknown>>(ctx.root, args.answersFile);
      record.answersDigest = digestFile(ctx.root, args.answersFile);
      if (answers.confirmed === true) record.confirmationDigest = canonicalDigest({ answersDigest: record.answersDigest, confirmed: true });
      record.finalStatus = record.confirmationDigest ? 'drafted' : 'paused';
      record.updatedAt = new Date().toISOString();
      saveRecord(ctx, record);
      const result = { schemaVersion: 'lattice.planner_answer.v1' as const, plannerRunId: record.plannerRunId, answersDigest: record.answersDigest, confirmationDigest: record.confirmationDigest ?? null, status: record.finalStatus };
      return wantsJson(args) ? result : renderLines(`Proofbound planner answer (${result.schemaVersion})`, result);
    },

    planner_decision_submit(args: { runId: string; decisionFile: string } & JsonArgs) {
      const record = readPlannerRun(ctx.root, args.runId);
      const digest = digestFile(ctx.root, args.decisionFile);
      record.decisionReceiptDigests.push(digest);
      record.finalStatus = 'drafted';
      record.updatedAt = new Date().toISOString();
      saveRecord(ctx, record);
      const result = { schemaVersion: 'lattice.planner_decision.v1' as const, plannerRunId: record.plannerRunId, decisionReceiptDigest: digest, status: record.finalStatus };
      return wantsJson(args) ? result : renderLines(`Proofbound planner decision (${result.schemaVersion})`, result);
    },

    planner_resume(args: { runId: string } & JsonArgs) {
      const record = readPlannerRun(ctx.root, args.runId);
      if (record.finalStatus === 'paused' && (record.confirmationDigest || record.decisionReceiptDigests.length > 0 || record.draft?.interactionMode === 'autonomous')) {
        record.finalStatus = 'drafted';
        record.updatedAt = new Date().toISOString();
        saveRecord(ctx, record);
      }
      const result = { schemaVersion: 'lattice.planner_resume.v1' as const, plannerRunId: record.plannerRunId, status: record.finalStatus, storyId: record.storyId ?? null, jobPlanDigest: record.jobPlan?.jobPlanDigest ?? null };
      return wantsJson(args) ? result : renderLines(`Proofbound planner resume (${result.schemaVersion})`, result);
    },

    async planner_run(args: PlannerDraftArgs & { projectId?: string; planOnly?: boolean; execute?: boolean; maxExecuteSteps?: number; requireMultiHost?: boolean; requiredHostVerdictCount?: number } & JsonArgs = {}) {
      const draft = buildPlannerDraft(ctx.root, args);
      const review = reviewPlannerDraft(draft);
      const record = draftRecord(draft);
      record.review = review;
      // Persist the run record up front so the composed planner_create_story /
      // planner_create_job calls below can resolve the draft back via { runId }.
      // Without this, the first one-shot run has no planner run file to read.
      saveRecord(ctx, record);
      if (review.status !== 'pass') {
        record.finalStatus = 'blocked';
        saveRecord(ctx, record);
        const result = { schemaVersion: 'lattice.planner_run.v1' as const, status: 'blocked' as const, plannerRunId: draft.plannerRunId, review };
        return wantsJson(args) ? result : renderLines(`Proofbound planner run (${result.schemaVersion})`, result);
      }
      if (draft.status === 'paused') {
        record.finalStatus = 'paused';
        saveRecord(ctx, record);
        const result = { schemaVersion: 'lattice.planner_run.v1' as const, status: 'paused' as const, plannerRunId: draft.plannerRunId, questions: draft.questions, requiredDecisions: draft.requiredDecisions };
        return wantsJson(args) ? result : renderLines(`Proofbound planner run (${result.schemaVersion})`, { plannerRunId: draft.plannerRunId, status: 'paused', questions: draft.questions.length, requiredDecisions: draft.requiredDecisions.length });
      }
      const storyResult = handlers.planner_create_story({ runId: draft.plannerRunId, json: true }) as { status: string; storyId?: string };
      if (storyResult.status !== 'created' || !storyResult.storyId) {
        record.finalStatus = 'blocked';
        saveRecord(ctx, record);
        return wantsJson(args)
          ? storyResult
          : renderLines('Proofbound planner run (blocked)', { plannerRunId: draft.plannerRunId, status: storyResult.status });
      }
      const jobPlan = handlers.planner_create_job({
        runId: draft.plannerRunId,
        storyId: storyResult.storyId,
        projectId: args.projectId,
        requireMultiHost: args.requireMultiHost,
        requiredHostVerdictCount: args.requiredHostVerdictCount,
        json: true,
      }) as { status?: string };
      if (jobPlan.status !== 'planned' || args.planOnly === true || args.execute === false) {
        return wantsJson(args)
          ? jobPlan
          : renderLines('Proofbound planner run', { plannerRunId: draft.plannerRunId, storyId: storyResult.storyId, status: jobPlan.status ?? 'planned' });
      }
      const execution = executePlannedSteps({
        root: ctx.root,
        store: ctx.store,
        jobPlan: jobPlan as ReturnType<typeof buildJobPlan>,
        maxSteps: args.maxExecuteSteps,
      });
      const completed = execution.status === 'done';
      const completion = {
        schemaVersion: 'lattice.local_planner_completion.v1' as const,
        completed,
        localDoneReady: completed,
        authorityDone: false,
        fullAuthorityDone: false,
        receiptVerified: false,
        blockingReasons: completed ? [] : [execution.stopReason ?? 'planner_execution_incomplete'],
        receiptRefs: [],
        hostVerdictRefs: [],
        nextAction: completed
          ? 'Use local proof admissibility, receipt-bundle validation, and quorum evidence before lifecycle advancement.'
          : 'Inspect failed planned step output, repair locally, and rerun planner/autopilot.',
      };
      let finalRecord: PlannerRunRecord;
      try {
        finalRecord = readPlannerRun(ctx.root, draft.plannerRunId);
      } catch {
        finalRecord = record;
      }
      finalRecord.execution = execution;
      finalRecord.completion = completion;
      const plannerRunStatus = completion.completed ? execution.status : 'blocked';
      finalRecord.finalStatus = completion.completed ? 'executed' : 'blocked';
      finalRecord.updatedAt = new Date().toISOString();
      saveRecord(ctx, finalRecord);
      const result = {
        schemaVersion: 'lattice.planner_run.v1' as const,
        status: plannerRunStatus,
        plannerRunId: draft.plannerRunId,
        storyId: storyResult.storyId,
        jobPlan,
        execution,
        completion,
        blockingReasons: completion.blockingReasons,
        receiptRefs: completion.receiptRefs,
        hostVerdictRefs: completion.hostVerdictRefs,
        nextAction: completion.nextAction,
      };
      return wantsJson(args)
        ? result
        : renderLines('Proofbound planner run', { plannerRunId: draft.plannerRunId, storyId: storyResult.storyId, status: plannerRunStatus, stopReason: execution.stopReason, completed: completion.completed, localDoneReady: completion.localDoneReady, nextAction: completion.nextAction });
    },

    planner_source_manifest(args: { sourceRepo: string; includedPaths?: string[] | string; excludedPaths?: string[] | string } & JsonArgs) {
      const includedPaths = Array.isArray(args.includedPaths) ? args.includedPaths : typeof args.includedPaths === 'string' ? args.includedPaths.split(',').map(s => s.trim()).filter(Boolean) : [];
      const excludedPaths = Array.isArray(args.excludedPaths) ? args.excludedPaths : typeof args.excludedPaths === 'string' ? args.excludedPaths.split(',').map(s => s.trim()).filter(Boolean) : [];
      const result = sourceManifestDigest(ctx.root, args.sourceRepo, includedPaths, excludedPaths);
      const artifactRef = writePlannerArtifact(ctx.root, `${LATTICE_DIR}/planner/source-manifests/${result.digest}.json`, result);
      const output = { schemaVersion: 'lattice.planner_source_manifest.v1' as const, ...result, artifactRef };
      return wantsJson(args) ? output : renderLines(`Proofbound planner source-manifest (${output.schemaVersion})`, { digest: result.digest, files: result.files.length, blocked: result.blocked, artifactRef });
    },
  };
  return handlers;
}
