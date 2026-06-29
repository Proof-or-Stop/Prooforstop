import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  buildParallelDispatch,
  buildParallelMergeQueue,
  buildParallelPlan,
  buildParallelReport,
  buildParallelStatus,
  createParallelWave,
  inspectParallelWave,
  readParallelWave,
  type LatticeParallelDispatch,
  type LatticeParallelMergeQueue,
  type LatticeParallelPlan,
  type LatticeParallelReport,
  type LatticeParallelStatus,
  type LatticeParallelWave,
  type LatticeParallelWaveInspection,
  type ParallelWaveProjectionOptions,
} from '../core/lattice-parallel-wave.js';
import type { HandlerContext } from './context.js';

function writeJsonNoOverwrite(file: string, value: unknown): void {
  if (existsSync(file)) throw new Error(`refusing to overwrite existing file: ${file}`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function storySummary(wave: Pick<LatticeParallelWave, 'storyRefs'>): string {
  const candidateCount = wave.storyRefs.filter(ref => ref.parallelDevRecommended).length;
  const planOnlyCount = wave.storyRefs.filter(ref => ref.recommendation === 'plan_only').length;
  const blockedCount = wave.storyRefs.filter(ref => ref.recommendation === 'blocked').length;
  return `stories: ${wave.storyRefs.length}; parallelDev=${candidateCount}; planOnly=${planOnlyCount}; blocked=${blockedCount}`;
}

function countSummary(summary: { storyCount: number; candidateCount: number; planOnlyCount: number; blockedCount: number }): string {
  return `stories: ${summary.storyCount}; parallelDev=${summary.candidateCount}; planOnly=${summary.planOnlyCount}; blocked=${summary.blockedCount}`;
}

function localAssuranceLines(scope: string, receiptRefs: number): string[] {
  return [
    `admissibilityStatus: ${scope}`,
    'assuranceLevel: local',
    'evidenceScope: parallel-wave',
    `receiptRefs: ${receiptRefs}`,
  ];
}

function waveFromArgs(ctx: HandlerContext, args: {
  file?: string;
  storyIds?: string[];
  hosts?: string[];
  waveId?: string;
}): LatticeParallelWave {
  return args.file
    ? readParallelWave(resolve(process.cwd(), args.file))
    : createParallelWave(ctx.store, ctx.root, {
      storyIds: args.storyIds,
      hosts: args.hosts,
      waveId: args.waveId,
    });
}

function projectionOptions(ctx: HandlerContext, args: {
  includeExperience?: boolean;
  experienceQuery?: string;
  maxExperienceRefs?: number;
}): ParallelWaveProjectionOptions {
  return {
    projectRoot: ctx.root,
    includeExperience: args.includeExperience,
    experienceQuery: args.experienceQuery,
    maxExperienceRefs: args.maxExperienceRefs,
  };
}

function renderParallelWaveText(wave: LatticeParallelWave): string {
  return [
    `Parallel wave (${wave.schemaVersion})`,
    `waveId: ${wave.waveId}`,
    storySummary(wave),
    `hosts: ${wave.hostCandidates.map(host => host.host).join(', ') || '(none)'}`,
    `evidenceRefs: ${wave.evidenceRefs.length}`,
    `mergeOrder: ${wave.mergeOrder.map(entry => entry.storyId).join(' -> ') || '(none)'}`,
    ...localAssuranceLines('parallel-wave', wave.authority.receiptRefs.length),
  ].join('\n');
}

function renderParallelDispatchText(dispatch: LatticeParallelDispatch): string {
  return [
    `Parallel dispatch (${dispatch.schemaVersion})`,
    `waveId: ${dispatch.waveId}`,
    countSummary(dispatch.summary),
    `dispatchable: ${dispatch.dispatchEntries.filter(entry => entry.dispatchable).map(entry => entry.storyId).join(', ') || '(none)'}`,
    `blocked: ${dispatch.dispatchEntries.filter(entry => !entry.dispatchable).map(entry => entry.storyId).join(', ') || '(none)'}`,
    `experienceRefs: ${dispatch.dispatchEntries.reduce((count, entry) => Math.max(count, entry.experienceRefs.length), 0)}`,
    ...localAssuranceLines('parallel-dispatch', dispatch.authority.receiptRefs.length),
  ].join('\n');
}

function renderParallelStatusText(status: LatticeParallelStatus): string {
  return [
    `Parallel status (${status.schemaVersion})`,
    `waveId: ${status.waveId}`,
    countSummary(status.summary),
    `parallelDevCandidates: ${status.candidates.join(', ') || '(none)'}`,
    `planOnlyStories: ${status.planOnly.join(', ') || '(none)'}`,
    `blockedStories: ${status.blocked.map(entry => entry.storyId).join(', ') || '(none)'}`,
    `readyGuidance: ${status.mergeGuidance.ready.length}`,
    `blockedGuidance: ${status.mergeGuidance.blocked.length}`,
    ...localAssuranceLines('parallel-status', status.authority.receiptRefs.length),
  ].join('\n');
}

function renderParallelMergeQueueText(queue: LatticeParallelMergeQueue): string {
  return [
    `Parallel merge queue (${queue.schemaVersion})`,
    `waveId: ${queue.waveId}`,
    countSummary(queue.summary),
    `ready: ${queue.ready.map(entry => entry.storyId).join(', ') || '(none)'}`,
    `blocked: ${queue.blocked.map(entry => entry.storyId).join(', ') || '(none)'}`,
    `readyGuidance: ${queue.mergeGuidance.ready.length}`,
    `blockedGuidance: ${queue.mergeGuidance.blocked.length}`,
    ...localAssuranceLines('parallel-merge-queue', queue.authority.receiptRefs.length),
  ].join('\n');
}

function renderParallelReportText(report: LatticeParallelReport): string {
  return [
    `Parallel report (${report.schemaVersion})`,
    `waveId: ${report.waveId}`,
    countSummary(report.summary),
    `parallelDevCandidates: ${report.candidates.join(', ') || '(none)'}`,
    `planOnlyStories: ${report.planOnly.join(', ') || '(none)'}`,
    `blockedStories: ${report.blocked.join(', ') || '(none)'}`,
    `dispatchEntries: ${report.dispatchEntries.length}`,
    `experienceRefs: ${report.experienceRefs.length}`,
    `evidenceRefs: ${report.evidenceSummary.topLevelRefs.length}`,
    `readyGuidance: ${report.mergeGuidance.ready.length}`,
    `blockedGuidance: ${report.mergeGuidance.blocked.length}`,
    ...localAssuranceLines('parallel-report', report.authority.receiptRefs.length),
  ].join('\n');
}

function renderParallelWaveInspectionText(inspection: LatticeParallelWaveInspection): string {
  return [
    `Parallel wave inspect (${inspection.schemaVersion})`,
    `waveId: ${inspection.waveId}`,
    storySummary(inspection),
    `hosts: ${inspection.inspection.hostCandidateCount}`,
    `blockingDegradations: ${inspection.inspection.blockingDegradationCount}`,
    `mergeOrder: ${inspection.mergeOrder.map(entry => entry.storyId).join(' -> ') || '(none)'}`,
    ...localAssuranceLines('parallel-inspection', inspection.authority.receiptRefs.length),
  ].join('\n');
}

function renderParallelPlanText(plan: LatticeParallelPlan): string {
  return [
    `Parallel plan (${plan.schemaVersion})`,
    `waveId: ${plan.waveId}`,
    storySummary(plan),
    `parallelDevCandidates: ${plan.parallelDevCandidates.join(', ') || '(none)'}`,
    `planOnlyStories: ${plan.planOnlyStories.join(', ') || '(none)'}`,
    `blockedStories: ${plan.blockedStories.join(', ') || '(none)'}`,
    `mergeOrder: ${plan.mergeOrder.map(entry => entry.storyId).join(' -> ') || '(none)'}`,
    ...localAssuranceLines('parallel-plan', plan.authority.receiptRefs.length),
  ].join('\n');
}

export function createLatticeParallelWaveHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  return {
    parallel_wave_create(args: {
      storyIds?: string[];
      hosts?: string[];
      waveId?: string;
      format?: 'text' | 'json';
      output?: string;
    } = {}) {
      const wave = createParallelWave(ctx.store, ctx.root, args);
      if (args.output) {
        const outputPath = resolve(process.cwd(), args.output);
        writeJsonNoOverwrite(outputPath, wave);
      }
      if (args.format === 'json') return wave;
      const outputNote = args.output ? `\noutput: ${args.output}` : '';
      return [renderParallelWaveText(wave), outputNote.trimEnd()].filter(Boolean).join('\n');
    },
    parallel_wave_inspect(args: {
      file: string;
      format?: 'text' | 'json';
      output?: string;
    }) {
      const wave = readParallelWave(resolve(process.cwd(), args.file));
      const inspection = inspectParallelWave(wave);
      if (args.output) {
        const outputPath = resolve(process.cwd(), args.output);
        writeJsonNoOverwrite(outputPath, inspection);
      }
      if (args.format === 'json') return inspection;
      const outputNote = args.output ? `\noutput: ${args.output}` : '';
      return [renderParallelWaveInspectionText(inspection), outputNote.trimEnd()].filter(Boolean).join('\n');
    },
    parallel_plan(args: {
      file?: string;
      storyIds?: string[];
      hosts?: string[];
      waveId?: string;
      format?: 'text' | 'json';
      output?: string;
    } = {}) {
      const wave = args.file
        ? readParallelWave(resolve(process.cwd(), args.file))
        : createParallelWave(ctx.store, ctx.root, args);
      const plan = buildParallelPlan(wave);
      if (args.output) {
        const outputPath = resolve(process.cwd(), args.output);
        writeJsonNoOverwrite(outputPath, plan);
      }
      if (args.format === 'json') return plan;
      const outputNote = args.output ? `\noutput: ${args.output}` : '';
      return [renderParallelPlanText(plan), outputNote.trimEnd()].filter(Boolean).join('\n');
    },
    parallel_dispatch(args: {
      file?: string;
      storyIds?: string[];
      hosts?: string[];
      waveId?: string;
      includeExperience?: boolean;
      experienceQuery?: string;
      maxExperienceRefs?: number;
      format?: 'text' | 'json';
      output?: string;
    } = {}) {
      const wave = waveFromArgs(ctx, args);
      const dispatch = buildParallelDispatch(wave, projectionOptions(ctx, args));
      if (args.output) {
        const outputPath = resolve(process.cwd(), args.output);
        writeJsonNoOverwrite(outputPath, dispatch);
      }
      if (args.format === 'json') return dispatch;
      const outputNote = args.output ? `\noutput: ${args.output}` : '';
      return [renderParallelDispatchText(dispatch), outputNote.trimEnd()].filter(Boolean).join('\n');
    },
    parallel_status(args: {
      file?: string;
      storyIds?: string[];
      hosts?: string[];
      waveId?: string;
      format?: 'text' | 'json';
      output?: string;
    } = {}) {
      const wave = waveFromArgs(ctx, args);
      const status = buildParallelStatus(wave);
      if (args.output) {
        const outputPath = resolve(process.cwd(), args.output);
        writeJsonNoOverwrite(outputPath, status);
      }
      if (args.format === 'json') return status;
      const outputNote = args.output ? `\noutput: ${args.output}` : '';
      return [renderParallelStatusText(status), outputNote.trimEnd()].filter(Boolean).join('\n');
    },
    parallel_merge_queue(args: {
      file?: string;
      storyIds?: string[];
      hosts?: string[];
      waveId?: string;
      format?: 'text' | 'json';
      output?: string;
    } = {}) {
      const wave = waveFromArgs(ctx, args);
      const queue = buildParallelMergeQueue(wave);
      if (args.output) {
        const outputPath = resolve(process.cwd(), args.output);
        writeJsonNoOverwrite(outputPath, queue);
      }
      if (args.format === 'json') return queue;
      const outputNote = args.output ? `\noutput: ${args.output}` : '';
      return [renderParallelMergeQueueText(queue), outputNote.trimEnd()].filter(Boolean).join('\n');
    },
    parallel_report(args: {
      file?: string;
      storyIds?: string[];
      hosts?: string[];
      waveId?: string;
      includeExperience?: boolean;
      experienceQuery?: string;
      maxExperienceRefs?: number;
      format?: 'text' | 'json';
      output?: string;
    } = {}) {
      const wave = waveFromArgs(ctx, args);
      const report = buildParallelReport(wave, projectionOptions(ctx, args));
      if (args.output) {
        const outputPath = resolve(process.cwd(), args.output);
        writeJsonNoOverwrite(outputPath, report);
      }
      if (args.format === 'json') return report;
      const outputNote = args.output ? `\noutput: ${args.output}` : '';
      return [renderParallelReportText(report), outputNote.trimEnd()].filter(Boolean).join('\n');
    },
  };
}
