/**
 * @task B-42c0
 * @checklist CHK-004
 * @title story capsule CLI handlers
 * @type feature
 * @priority high
 * @description
 *   Exposes Story Capsule projection commands. These commands write resumable
 *   handoff state while preserving Koala evidence authority: capsule content is
 *   display/projection state and only references evidence/process-events.
 * @changes
 *   - [CHK-004] Add capsule_show/update/handoff/run_add handlers
 *   - [CHK-005] Surface strict reference validation for forged/missing evidence refs
 */
import type { HandlerContext } from './context.js';
import type { ProcessEvent } from '../core/types.js';
import {
  appendRunRef,
  buildStoryCapsule,
  renderCapsuleBrief,
  renderHandoffMarkdown,
  truncateTranscript,
  validateCapsuleRefs,
  type CapsuleEvidenceRef,
  type CapsuleProcessEventRef,
  type CapsuleRunResult,
  type CapsuleRunRole,
  type StoryCapsuleData,
  type StoryCapsuleRunData,
} from '../core/story-capsule.js';

type StoryArg = { storyId?: string; story?: string };

function storyIdFrom(args: StoryArg): string {
  const storyId = (args.storyId || args.story || '').trim();
  if (!storyId) throw new Error('storyId is required');
  return storyId;
}

function readInputs(ctx: HandlerContext, storyId: string): {
  story: ReturnType<HandlerContext['store']['readStory']>;
  checklist: ReturnType<HandlerContext['store']['readChecklist']>;
  events: ReturnType<HandlerContext['store']['readProcessEvents']>;
  capsule: StoryCapsuleData | null;
} {
  return {
    story: ctx.store.readStory(storyId),
    checklist: ctx.store.readChecklist(storyId),
    events: ctx.store.readProcessEvents(storyId),
    capsule: ctx.store.readStoryCapsule(storyId),
  };
}

function refIssues(ctx: HandlerContext, storyId: string, capsule: StoryCapsuleData) {
  let checklist = null;
  try { checklist = ctx.store.readChecklist(storyId); } catch { /* probe */ }
  let events: ProcessEvent[] = [];
  try { events = ctx.store.readProcessEvents(storyId); } catch { /* probe */ }
  return validateCapsuleRefs({
    capsule,
    checklist,
    processEvents: events,
    projectRoot: ctx.root,
    storyDir: ctx.store.storyDirPath(storyId),
  });
}

function writeCapsuleProjection(ctx: HandlerContext, storyId: string, capsule: StoryCapsuleData, eventType: 'capsule_updated' | 'handoff_written' | 'run_added', extra: Record<string, unknown> = {}) {
  ctx.store.writeStoryCapsule(storyId, capsule);
  ctx.store.writeStoryCapsuleMarkdown(storyId, 'session-brief.md', renderCapsuleBrief(capsule).join('\n'));
  ctx.store.appendProcessEvent(storyId, {
    type: eventType,
    storyId,
    phase: capsule.phase,
    ...extra,
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

function defaultRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createCapsuleHandlers(ctx: HandlerContext) {
  return {
    capsule_show(args: StoryArg & { format?: 'text' | 'json'; strict?: boolean }) {
      const storyId = storyIdFrom(args);
      const capsule = ctx.store.readStoryCapsule(storyId);
      if (!capsule) {
        const message = `No story capsule yet for ${storyId}. Run capsule_update to create one.`;
        if (args.format === 'json') return { storyId, capsule: null, issues: [], message };
        return message;
      }
      const issues = refIssues(ctx, storyId, capsule);
      if (args.strict && issues.some(i => i.severity === 'error')) {
        throw new Error(`capsule refs invalid: ${issues.map(i => i.message).join('; ')}`);
      }
      if (args.format === 'json') return { storyId, capsule, issues };
      const lines = renderCapsuleBrief(capsule, issues);
      if (issues.length > 0) {
        lines.push('');
        lines.push('## Capsule ref issues');
        for (const issue of issues) lines.push(`  [${issue.severity}] ${issue.message}`);
      }
      return lines.join('\n');
    },

    capsule_update(args: StoryArg & {
      rebuild?: boolean;
      summary?: string;
      nextAction?: string;
      currentChecklistId?: string;
      activeRunId?: string;
      openBlockers?: string[];
      evidenceRefs?: CapsuleEvidenceRef[];
      processEventRefs?: CapsuleProcessEventRef[];
      strict?: boolean;
    }) {
      const storyId = storyIdFrom(args);
      const input = readInputs(ctx, storyId);
      const patch: Partial<StoryCapsuleData> = {};
      if (args.summary !== undefined) patch.summary = args.summary;
      if (args.nextAction !== undefined) patch.nextAction = args.nextAction;
      if (args.currentChecklistId !== undefined) patch.currentChecklistId = args.currentChecklistId;
      if (args.activeRunId !== undefined) patch.activeRunId = args.activeRunId;
      if (args.openBlockers !== undefined) patch.openBlockers = args.openBlockers;
      if (args.evidenceRefs !== undefined) patch.evidenceRefs = args.evidenceRefs;
      if (args.processEventRefs !== undefined) patch.processEventRefs = args.processEventRefs;
      const capsule = buildStoryCapsule({
        story: input.story,
        checklist: input.checklist,
        processEvents: input.events,
        existing: args.rebuild ? null : input.capsule,
        patch,
        source: args.rebuild ? 'rebuild' : 'manual',
      });
      const issues = validateCapsuleRefs({
        capsule,
        checklist: input.checklist,
        processEvents: input.events,
        projectRoot: ctx.root,
        storyDir: ctx.store.storyDirPath(storyId),
      });
      if (args.strict && issues.some(i => i.severity === 'error')) {
        throw new Error(`capsule refs invalid: ${issues.map(i => i.message).join('; ')}`);
      }
      writeCapsuleProjection(ctx, storyId, capsule, 'capsule_updated', { rebuild: args.rebuild === true });
      return { storyId, path: ctx.store.capsuleFilePath(storyId, 'capsule.json'), issues, capsule };
    },

    capsule_handoff(args: StoryArg & { nextAction: string; notes?: string; openBlockers?: string[] }) {
      const storyId = storyIdFrom(args);
      if (!args.nextAction || args.nextAction.trim().length < 3) throw new Error('nextAction is required');
      const input = readInputs(ctx, storyId);
      const capsule = buildStoryCapsule({
        story: input.story,
        checklist: input.checklist,
        processEvents: input.events,
        existing: input.capsule,
        patch: {
          nextAction: args.nextAction,
          openBlockers: args.openBlockers ?? input.capsule?.openBlockers ?? [],
        },
        source: 'handoff',
      });
      const handoff = renderHandoffMarkdown(capsule, args.notes);
      ctx.store.writeStoryCapsuleMarkdown(storyId, 'handoff.md', handoff);
      writeCapsuleProjection(ctx, storyId, capsule, 'handoff_written');
      return { storyId, handoffPath: ctx.store.capsuleFilePath(storyId, 'handoff.md'), capsule };
    },

    capsule_run_add(args: StoryArg & {
      runId?: string;
      checklistId?: string;
      provider?: string;
      model?: string;
      vendor?: string;
      role?: CapsuleRunRole;
      result?: CapsuleRunResult;
      commands?: string[];
      transcript?: string;
      evidenceRefs?: CapsuleEvidenceRef[];
      processEventRefs?: CapsuleProcessEventRef[];
      metrics?: Record<string, unknown>;
      artifacts?: Record<string, unknown>;
    }) {
      const storyId = storyIdFrom(args);
      const input = readInputs(ctx, storyId);
      if (args.checklistId && !input.checklist.items.some(item => item.id === args.checklistId)) {
        throw new Error(`unknown checklistId for ${storyId}: ${args.checklistId}`);
      }
      const run: StoryCapsuleRunData = {
        storyId,
        runId: args.runId || defaultRunId(),
        checklistId: args.checklistId ?? null,
        provider: args.provider,
        model: args.model,
        vendor: args.vendor,
        role: args.role ?? 'other',
        startedAt: nowIso(),
        endedAt: nowIso(),
        result: args.result ?? 'unknown',
        commands: args.commands ?? [],
        evidenceRefs: args.evidenceRefs ?? [],
        processEventRefs: args.processEventRefs ?? [],
        metrics: args.metrics ?? {},
        artifacts: args.artifacts ?? {},
      };
      ctx.store.writeCapsuleRun(storyId, run, {
        transcript: truncateTranscript(args.transcript),
        metrics: run.metrics,
        artifacts: run.artifacts,
      });
      const base = input.capsule ?? buildStoryCapsule({
        story: input.story,
        checklist: input.checklist,
        processEvents: input.events,
        source: 'rebuild',
      });
      const beforeRunRefCount = [...base.runRefs.filter(r => r.runId !== run.runId), { runId: run.runId }].length;
      const capsule = appendRunRef(base, run);
      writeCapsuleProjection(ctx, storyId, capsule, 'run_added', { runId: run.runId, checklistId: args.checklistId ?? null });
      ctx.store.appendProcessEvent(storyId, {
        type: 'run_metrics_recorded',
        storyId,
        runId: run.runId,
        checklistId: args.checklistId ?? null,
      });
      return {
        storyId,
        runId: run.runId,
        runPath: ctx.store.capsuleRunDirPath(storyId, run.runId),
        retention: {
          runRefsKept: capsule.runRefs.length,
          runRefsPruned: Math.max(0, beforeRunRefCount - capsule.runRefs.length),
        },
        capsule,
      };
    },
  };
}
