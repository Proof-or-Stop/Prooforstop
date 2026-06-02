import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  buildParallelPlan,
  createParallelWave,
  inspectParallelWave,
  readParallelWave,
  type LatticeParallelPlan,
  type LatticeParallelWave,
  type LatticeParallelWaveInspection,
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

function renderParallelWaveText(wave: LatticeParallelWave): string {
  return [
    `Parallel wave (${wave.schemaVersion})`,
    `waveId: ${wave.waveId}`,
    storySummary(wave),
    `hosts: ${wave.hostCandidates.map(host => host.host).join(', ') || '(none)'}`,
    `evidenceRefs: ${wave.evidenceRefs.length}`,
    `mergeOrder: ${wave.mergeOrder.map(entry => entry.storyId).join(' -> ') || '(none)'}`,
    `authorityChanged: ${wave.authority.authorityChanged}`,
    `productionDone: ${wave.authority.productionDone}`,
    `receiptRefs: ${wave.authority.receiptRefs.length}`,
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
    `authorityChanged: ${inspection.authority.authorityChanged}`,
    `productionDone: ${inspection.authority.productionDone}`,
    `receiptRefs: ${inspection.authority.receiptRefs.length}`,
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
    `authorityChanged: ${plan.authority.authorityChanged}`,
    `productionDone: ${plan.authority.productionDone}`,
    `receiptRefs: ${plan.authority.receiptRefs.length}`,
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
  };
}
