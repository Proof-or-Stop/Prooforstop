import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
import {
  checkDispatchPolicy,
  createDispatchPolicy,
  getDispatchPolicy,
  renderDispatchPolicyCheckText,
  renderDispatchPolicyText,
  type CreateDispatchPolicyArgs,
  type DispatchPolicy,
  type DispatchPolicyCheckResult,
} from '../core/dispatch-policy.js';

type FormatArgs = { format?: 'text' | 'json'; json?: boolean; output?: string };

function wantsJson(args: FormatArgs | undefined): boolean {
  return args?.format === 'json' || args?.json === true;
}

function assertNoExistingOutput(file: string): void {
  try {
    lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`refusing to overwrite existing file: ${file}`);
}

function pathResolvesWithinRoot(rootReal: string, candidateReal: string): boolean {
  const rel = relative(rootReal, candidateReal);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function resolveRepoContainedOutputPath(root: string, output: string): string {
  const trimmed = output.trim();
  if (!trimmed) {
    throw new Error('--output must not be empty');
  }
  if (isAbsolute(trimmed)) {
    throw new Error(`--output must be a relative path inside the repository root: ${trimmed}`);
  }
  const rootPath = resolve(root);
  const outputPath = resolve(rootPath, trimmed);
  const outputRel = relative(rootPath, outputPath);
  if (outputRel === '') {
    throw new Error('--output must resolve to a file inside the repository root, not the repository root itself');
  }
  if (!pathResolvesWithinRoot(rootPath, outputPath)) {
    throw new Error(`--output escapes the repository root via path traversal: ${trimmed}`);
  }

  const rootReal = realpathSync(rootPath);
  const segments = outputRel.split(/[\\/]+/).filter(Boolean);
  let currentPath = rootPath;
  for (const segment of segments.slice(0, -1)) {
    currentPath = join(currentPath, segment);
    let entry: ReturnType<typeof lstatSync>;
    try {
      entry = lstatSync(currentPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
    const ancestorRel = relative(rootPath, currentPath) || '.';
    if (entry.isSymbolicLink()) {
      throw new Error(`--output traverses a symlinked ancestor: ${ancestorRel}`);
    }
    if (!entry.isDirectory()) {
      throw new Error(`--output ancestor must be a directory: ${ancestorRel}`);
    }
    const currentReal = realpathSync(currentPath);
    if (!pathResolvesWithinRoot(rootReal, currentReal)) {
      throw new Error(`--output ancestor resolves outside the repository root: ${ancestorRel}`);
    }
  }

  return outputPath;
}

function writeJsonNoOverwrite(file: string, value: unknown): void {
  assertNoExistingOutput(file);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function maybeWriteOutput(root: string, output: string | undefined, value: unknown): string {
  if (!output) return '';
  const outputPath = resolveRepoContainedOutputPath(root, output);
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
      const outputNote = maybeWriteOutput(ctx.root, args.output, result);
      if (wantsJson(args)) return result;
      return `${renderHostRuntimeListText(result)}${outputNote}`;
    },
    host_runtime_probe(args: { host: string } & FormatArgs) {
      const result = probeHostRuntime(args.host);
      const outputNote = maybeWriteOutput(ctx.root, args.output, result);
      if (wantsJson(args)) return result;
      return `${renderHostRuntimeProbeText(result)}${outputNote}`;
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
    dispatch_policy_create(args: CreateDispatchPolicyArgs & FormatArgs) {
      const result = createDispatchPolicy(ctx.root, args);
      const outputNote = maybeWriteOutput(ctx.root, args.output, result);
      if (wantsJson(args)) return result;
      return `${renderDispatchPolicyText(result)}${outputNote}`;
    },
    dispatch_policy_get(args: { policy: string } & FormatArgs) {
      const result = getDispatchPolicy(ctx.root, args.policy);
      const outputNote = maybeWriteOutput(ctx.root, args.output, result);
      if (wantsJson(args)) return result;
      return `${renderDispatchPolicyText(result)}${outputNote}`;
    },
    dispatch_policy_check(args: { policy: string } & FormatArgs) {
      const result = checkDispatchPolicy(ctx.root, args.policy);
      const outputNote = maybeWriteOutput(ctx.root, args.output, result);
      if (wantsJson(args)) return result;
      return `${renderDispatchPolicyCheckText(result)}${outputNote}`;
    },
  };
}
