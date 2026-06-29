import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { HandlerContext } from './context.js';
import {
  checkAutopilotPolicy,
  createAutopilotPolicy,
  getAutopilotPolicy,
  renderAutopilotPolicyCheckText,
  renderAutopilotPolicyText,
} from '../core/autopilot-policy.js';
import {
  autopilotCancel,
  autopilotResume,
  autopilotReview,
  autopilotRun,
  autopilotStatus,
  autopilotWatch,
  renderAutopilotCancelText,
  renderAutopilotResumeText,
  renderAutopilotReviewText,
  renderAutopilotRunText,
  renderAutopilotWatchText,
} from '../core/lattice-autopilot.js';

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

function stripFormatArgs<T extends Record<string, unknown>>(args: T): Record<string, unknown> {
  const {
    format: _format,
    json: _json,
    output: _output,
    takeover: _takeover,
    forceTakeover: _forceTakeover,
    ...rest
  } = args;
  return rest;
}

function normalizeList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim());
  }
  if (typeof value === 'string' && value.trim().length > 0) return [value.trim()];
  return undefined;
}

function normalizeRunArgs(args: Record<string, unknown>): Record<string, unknown> {
  const rest = stripFormatArgs(args);
  for (const key of ['allowedPaths', 'deniedPaths', 'requiredCommands', 'successCriteria', 'executionInstructions']) {
    const list = normalizeList(rest[key]);
    if (list) rest[key] = list;
  }
  if (typeof rest.maxRuntimeMinutes === 'number' && rest.timeoutMs === undefined) {
    rest.timeoutMs = Math.max(1, Math.floor(rest.maxRuntimeMinutes * 60 * 1000));
  }
  return rest;
}

function normalizePolicyArgs(args: Record<string, unknown>): Record<string, unknown> {
  const rest = stripFormatArgs(args);
  delete rest.requireLocalAssurance;
  return rest;
}

function readBooleanFact(result: unknown, key: 'authorityChanged' | 'receiptVerified'): boolean {
  if (result && typeof result === 'object') {
    const top = (result as Record<string, unknown>)[key];
    if (typeof top === 'boolean') return top;
    const authority = (result as Record<string, unknown>).authority;
    if (authority && typeof authority === 'object') {
      const nested = (authority as Record<string, unknown>)[key];
      if (typeof nested === 'boolean') return nested;
    }
  }
  return false;
}

function readStringFact(result: unknown, key: string): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const value = (result as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function renderFallback(title: string, result: unknown): string {
  if (typeof result === 'string') return result;
  const lines = [
    title,
    `schemaVersion: ${readStringFact(result, 'schemaVersion') ?? 'unknown'}`,
  ];
  const runId = readStringFact(result, 'runId') ?? readStringFact(result, 'autopilotId');
  if (runId) lines.push(`runId: ${runId}`);
  const policy = readStringFact(result, 'policy');
  if (policy) lines.push(`policy: ${policy}`);
  const mode = readStringFact(result, 'mode');
  if (mode) lines.push(`mode: ${mode}`);
  const status = readStringFact(result, 'status');
  if (status) lines.push(`status: ${status}`);
  lines.push('admissibilityStatus: local-autopilot-diagnostic');
  lines.push(`receiptBundleAdmissibility: ${readBooleanFact(result, 'receiptVerified') ? 'admissible' : 'not-established'}`);
  lines.push('evidenceScope: autopilot-metadata');
  const nextAction = readStringFact(result, 'nextAction');
  if (nextAction) lines.push(`nextAction: ${nextAction}`);
  return lines.join('\n');
}

function renderResult(render: ((result: any) => string) | undefined, fallbackTitle: string, result: unknown): string {
  if (render) return String(render(result));
  return renderFallback(fallbackTitle, result);
}

function requireRunId(args: { runId?: string; autopilotId?: string }): string {
  const runId = args.runId?.trim() || args.autopilotId?.trim();
  if (!runId) throw new Error('runId is required');
  return runId;
}

export function createLatticeAutopilotHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  return {
    autopilot_policy_create(args: Record<string, unknown> & FormatArgs) {
      const result = createAutopilotPolicy(ctx.root, normalizePolicyArgs(args) as any);
      const outputNote = maybeWriteOutput(ctx.root, args.output, result);
      if (wantsJson(args)) return result;
      return `${renderResult(renderAutopilotPolicyText, 'Autopilot policy', result)}${outputNote}`;
    },
    autopilot_policy_get(args: { policy: string } & FormatArgs) {
      const result = getAutopilotPolicy(ctx.root, args.policy);
      const outputNote = maybeWriteOutput(ctx.root, args.output, result);
      if (wantsJson(args)) return result;
      return `${renderResult(renderAutopilotPolicyText, 'Autopilot policy', result)}${outputNote}`;
    },
    autopilot_policy_check(args: { policy: string } & FormatArgs) {
      const result = checkAutopilotPolicy(ctx.root, args.policy);
      const outputNote = maybeWriteOutput(ctx.root, args.output, result);
      if (wantsJson(args)) return result;
      return `${renderResult(renderAutopilotPolicyCheckText, 'Autopilot policy check', result)}${outputNote}`;
    },
    autopilot_run(args: Record<string, unknown> & FormatArgs) {
      const result = autopilotRun(ctx.store, ctx.root, normalizeRunArgs(args) as any);
      const outputNote = maybeWriteOutput(ctx.root, args.output, result);
      if (wantsJson(args)) return result;
      return `${renderResult(renderAutopilotRunText, 'Autopilot run', result)}${outputNote}`;
    },
    autopilot_status(args: { runId?: string; autopilotId?: string } & FormatArgs) {
      const runId = requireRunId(args);
      const result = autopilotStatus(ctx.root, runId);
      const outputNote = maybeWriteOutput(ctx.root, args.output, result);
      if (wantsJson(args)) return result;
      return `${renderResult(renderAutopilotRunText, 'Autopilot status', result)}${outputNote}`;
    },
    autopilot_watch(args: { runId?: string; autopilotId?: string } & FormatArgs) {
      const runId = requireRunId(args);
      const result = autopilotWatch(ctx.root, runId);
      const outputNote = maybeWriteOutput(ctx.root, args.output, result);
      if (wantsJson(args)) return result;
      return `${renderResult(renderAutopilotWatchText, 'Autopilot watch', result)}${outputNote}`;
    },
    autopilot_cancel(args: { runId?: string; autopilotId?: string } & FormatArgs) {
      const runId = requireRunId(args);
      const result = autopilotCancel(ctx.root, runId);
      const outputNote = maybeWriteOutput(ctx.root, args.output, result);
      if (wantsJson(args)) return result;
      return `${renderResult(renderAutopilotCancelText, 'Autopilot status', result)}${outputNote}`;
    },
    autopilot_review(args: { runId?: string; autopilotId?: string } & FormatArgs) {
      const runId = requireRunId(args);
      const result = autopilotReview(ctx.root, runId);
      const outputNote = maybeWriteOutput(ctx.root, args.output, result);
      if (wantsJson(args)) return result;
      return `${renderResult(renderAutopilotReviewText, 'Autopilot review', result)}${outputNote}`;
    },
    autopilot_resume(args: { runId?: string; autopilotId?: string } & Record<string, unknown> & FormatArgs) {
      const runId = requireRunId(args);
      const result = autopilotResume(ctx.store, ctx.root, { ...normalizeRunArgs(args), runId });
      const outputNote = maybeWriteOutput(ctx.root, args.output, result);
      if (wantsJson(args)) return result;
      return `${renderResult(renderAutopilotResumeText, 'Autopilot run', result)}${outputNote}`;
    },
  };
}
