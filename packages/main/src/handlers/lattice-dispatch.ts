import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { HandlerContext } from './context.js';
import {
  buildDispatchMergePlan,
  cancelDispatch,
  collectDispatch,
  createDispatchReceipt,
  dispatchStatus,
  listDispatches,
  listHostRuntimes,
  overflowAuto,
  planDispatch,
  prepareDispatch,
  probeHostRuntime,
  renderDispatchCollectionText,
  renderDispatchListText,
  renderDispatchMergePlanText,
  renderDispatchPlanText,
  renderDispatchReceiptDraftText,
  renderDispatchRecordText,
  renderDispatchReviewText,
  renderDispatchRunText,
  renderDispatchStatusText,
  renderHostRuntimeListText,
  renderHostRuntimeProbeText,
  reviewDispatch,
  runDispatch,
  resumeDispatch,
} from '../core/lattice-dispatch.js';

type FormatArgs = { format?: 'text' | 'json'; json?: boolean; output?: string };

function wantsJson(args: FormatArgs | undefined): boolean {
  return args?.format === 'json' || args?.json === true;
}

function writeJsonNoOverwrite(file: string, value: unknown): void {
  if (existsSync(file)) throw new Error(`refusing to overwrite existing file: ${file}`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function maybeWriteOutput(root: string, output: string | undefined, value: unknown): string {
  if (!output) return '';
  const outputPath = resolve(root, output);
  writeJsonNoOverwrite(outputPath, value);
  return `\noutput: ${output}`;
}

function normalizeList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  }
  if (typeof value === 'string' && value.trim().length > 0) return [value.trim()];
  return undefined;
}

export function createLatticeDispatchHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  return {
    host_runtime_list(args: FormatArgs = {}) {
      const result = listHostRuntimes();
      if (args.output) writeJsonNoOverwrite(resolve(ctx.root, args.output), result);
      if (wantsJson(args)) return result;
      return [renderHostRuntimeListText(result), args.output ? `output: ${args.output}` : ''].filter(Boolean).join('\n');
    },
    host_runtime_probe(args: { host: string } & FormatArgs) {
      const result = probeHostRuntime(args.host);
      if (args.output) writeJsonNoOverwrite(resolve(ctx.root, args.output), result);
      if (wantsJson(args)) return result;
      return [renderHostRuntimeProbeText(result), args.output ? `output: ${args.output}` : ''].filter(Boolean).join('\n');
    },
    dispatch_plan(args: {
      storyId: string;
      host?: string;
      fromHost?: string;
      role?: string;
      objective?: string;
      allowedPaths?: string[] | string;
      deniedPaths?: string[] | string;
      requiredCommands?: string[] | string;
      successCriteria?: string[] | string;
      baseSha?: string;
      packId?: string;
      authorityBoundary?: string;
      executionInstructions?: string[] | string;
      parallel?: number;
    } & FormatArgs) {
      const result = planDispatch(ctx.store, ctx.root, {
        storyId: args.storyId,
        host: args.host,
        fromHost: args.fromHost,
        role: args.role,
        objective: args.objective,
        allowedPaths: normalizeList(args.allowedPaths),
        deniedPaths: normalizeList(args.deniedPaths),
        requiredCommands: normalizeList(args.requiredCommands),
        successCriteria: normalizeList(args.successCriteria),
        baseSha: args.baseSha,
        packId: args.packId,
        authorityBoundary: args.authorityBoundary,
        executionInstructions: normalizeList(args.executionInstructions),
        parallel: args.parallel,
      });
      const outputNote = maybeWriteOutput(ctx.root, args.output, result);
      if (wantsJson(args)) return result;
      return `${renderDispatchPlanText(result)}${outputNote}`;
    },
    dispatch_prepare(args: {
      storyId: string;
      dispatchId?: string;
      host?: string;
      fromHost?: string;
      role?: string;
      objective?: string;
      allowedPaths?: string[] | string;
      deniedPaths?: string[] | string;
      requiredCommands?: string[] | string;
      successCriteria?: string[] | string;
      baseSha?: string;
      packId?: string;
      authorityBoundary?: string;
      executionInstructions?: string[] | string;
      parallel?: number;
    } & FormatArgs) {
      const result = prepareDispatch(ctx.store, ctx.root, {
        storyId: args.storyId,
        dispatchId: args.dispatchId,
        host: args.host,
        fromHost: args.fromHost,
        role: args.role,
        objective: args.objective,
        allowedPaths: normalizeList(args.allowedPaths),
        deniedPaths: normalizeList(args.deniedPaths),
        requiredCommands: normalizeList(args.requiredCommands),
        successCriteria: normalizeList(args.successCriteria),
        baseSha: args.baseSha,
        packId: args.packId,
        authorityBoundary: args.authorityBoundary,
        executionInstructions: normalizeList(args.executionInstructions),
        parallel: args.parallel,
      });
      const outputNote = maybeWriteOutput(ctx.root, args.output, result);
      if (wantsJson(args)) return result;
      return `${renderDispatchRecordText(result)}${outputNote}`;
    },
    dispatch_run(args: {
      storyId?: string;
      dispatchId?: string;
      host?: string;
      fromHost?: string;
      role?: string;
      objective?: string;
      allowedPaths?: string[] | string;
      deniedPaths?: string[] | string;
      requiredCommands?: string[] | string;
      successCriteria?: string[] | string;
      baseSha?: string;
      packId?: string;
      authorityBoundary?: string;
      executionInstructions?: string[] | string;
      parallel?: number;
    } & FormatArgs) {
      if (!args.dispatchId && !args.storyId) {
        throw new Error('dispatch_run requires storyId or dispatchId');
      }
      const result = runDispatch(ctx.store, ctx.root, {
        storyId: args.storyId ?? dispatchStatus(ctx.root, args.dispatchId!).dispatch.storyId,
        dispatchId: args.dispatchId,
        host: args.host,
        fromHost: args.fromHost,
        role: args.role,
        objective: args.objective,
        allowedPaths: normalizeList(args.allowedPaths),
        deniedPaths: normalizeList(args.deniedPaths),
        requiredCommands: normalizeList(args.requiredCommands),
        successCriteria: normalizeList(args.successCriteria),
        baseSha: args.baseSha,
        packId: args.packId,
        authorityBoundary: args.authorityBoundary,
        executionInstructions: normalizeList(args.executionInstructions),
        parallel: args.parallel,
      });
      const outputNote = maybeWriteOutput(ctx.root, args.output, result);
      if (wantsJson(args)) return result;
      return `${renderDispatchRunText(result)}${outputNote}`;
    },
    overflow_auto(args: {
      storyId: string;
      dispatchId?: string;
      host?: string;
      fromHost?: string;
      role?: string;
      objective?: string;
      allowedPaths?: string[] | string;
      deniedPaths?: string[] | string;
      requiredCommands?: string[] | string;
      successCriteria?: string[] | string;
      baseSha?: string;
      packId?: string;
      authorityBoundary?: string;
      executionInstructions?: string[] | string;
      parallel?: number;
      approve?: boolean;
      start?: boolean;
    } & FormatArgs) {
      const result = overflowAuto(ctx.store, ctx.root, {
        storyId: args.storyId,
        dispatchId: args.dispatchId,
        host: args.host,
        fromHost: args.fromHost,
        role: args.role,
        objective: args.objective,
        allowedPaths: normalizeList(args.allowedPaths),
        deniedPaths: normalizeList(args.deniedPaths),
        requiredCommands: normalizeList(args.requiredCommands),
        successCriteria: normalizeList(args.successCriteria),
        baseSha: args.baseSha,
        packId: args.packId,
        authorityBoundary: args.authorityBoundary,
        executionInstructions: normalizeList(args.executionInstructions),
        parallel: args.parallel,
        approve: args.approve,
        start: args.start,
      });
      const outputNote = maybeWriteOutput(ctx.root, args.output, result);
      if (wantsJson(args)) return result;
      return ('schemaVersion' in result && result.schemaVersion === 'lattice.dispatch_plan.v1'
        ? renderDispatchPlanText(result)
        : renderDispatchRunText(result)) + outputNote;
    },
    dispatch_collect(args: { dispatchId: string } & FormatArgs) {
      const result = collectDispatch(ctx.root, args.dispatchId);
      const outputNote = maybeWriteOutput(ctx.root, args.output, result);
      if (wantsJson(args)) return result;
      return `${renderDispatchCollectionText(result)}${outputNote}`;
    },
    dispatch_receipt_create(args: { dispatchId: string } & FormatArgs) {
      const result = createDispatchReceipt(ctx.root, args.dispatchId);
      const outputNote = maybeWriteOutput(ctx.root, args.output, result);
      if (wantsJson(args)) return result;
      return `${renderDispatchReceiptDraftText(result)}${outputNote}`;
    },
    dispatch_status(args: { dispatchId: string } & FormatArgs) {
      const result = dispatchStatus(ctx.root, args.dispatchId);
      const outputNote = maybeWriteOutput(ctx.root, args.output, result);
      if (wantsJson(args)) return result;
      return `${renderDispatchStatusText(result)}${outputNote}`;
    },
    dispatch_list(args: { storyId?: string } & FormatArgs) {
      const result = listDispatches(ctx.root, args.storyId);
      const outputNote = maybeWriteOutput(ctx.root, args.output, result);
      if (wantsJson(args)) return result;
      return `${renderDispatchListText(result)}${outputNote}`;
    },
    dispatch_resume(args: { dispatchId: string } & FormatArgs) {
      const result = resumeDispatch(ctx.store, ctx.root, args.dispatchId);
      const outputNote = maybeWriteOutput(ctx.root, args.output, result);
      if (wantsJson(args)) return result;
      return `${renderDispatchRunText(result)}${outputNote}`;
    },
    dispatch_cancel(args: { dispatchId: string } & FormatArgs) {
      const result = cancelDispatch(ctx.root, args.dispatchId);
      const outputNote = maybeWriteOutput(ctx.root, args.output, result);
      if (wantsJson(args)) return result;
      return `${renderDispatchStatusText(result)}${outputNote}`;
    },
    dispatch_review(args: { dispatchId: string } & FormatArgs) {
      const result = reviewDispatch(ctx.root, args.dispatchId);
      const outputNote = maybeWriteOutput(ctx.root, args.output, result);
      if (wantsJson(args)) return result;
      return `${renderDispatchReviewText(result)}${outputNote}`;
    },
    dispatch_merge_plan(args: { dispatchId: string } & FormatArgs) {
      const result = buildDispatchMergePlan(ctx.root, args.dispatchId);
      const outputNote = maybeWriteOutput(ctx.root, args.output, result);
      if (wantsJson(args)) return result;
      return `${renderDispatchMergePlanText(result)}${outputNote}`;
    },
  };
}
