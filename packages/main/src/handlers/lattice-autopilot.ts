import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { HandlerContext } from './context.js';

type FormatArgs = { format?: 'text' | 'json'; json?: boolean; output?: string };
type CoreModule = Record<string, unknown>;
type CoreFn = (...args: any[]) => unknown | Promise<unknown>;

const AUTOPILOT_POLICY_MODULE = '../core/autopilot-policy.js';
const LATTICE_AUTOPILOT_MODULE = '../core/lattice-autopilot.js';

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
  const { format: _format, json: _json, output: _output, ...rest } = args;
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
  if (rest.requireServerReceipt === undefined && typeof rest.requireServerAuthorityReceipt === 'boolean') {
    rest.requireServerReceipt = rest.requireServerAuthorityReceipt;
  }
  return rest;
}

function policyCheckOptions(args: Record<string, unknown>): Record<string, unknown> | undefined {
  if (args.serverAuthorityReceipt === undefined) return undefined;
  return { serverAuthorityReceipt: args.serverAuthorityReceipt };
}

async function loadCoreModule(modulePath: string, expectedExports: string[]): Promise<CoreModule> {
  try {
    return await import(modulePath) as CoreModule;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`autopilot core module is unavailable: ${modulePath}; expected exports: ${expectedExports.join(', ')}; ${reason}`);
  }
}

function pickFunction(module: CoreModule, candidates: string[]): CoreFn {
  for (const candidate of candidates) {
    const value = module[candidate];
    if (typeof value === 'function') return value as CoreFn;
  }
  throw new Error(`autopilot core export missing; expected one of: ${candidates.join(', ')}`);
}

function maybeFunction(module: CoreModule, candidates: string[]): CoreFn | undefined {
  for (const candidate of candidates) {
    const value = module[candidate];
    if (typeof value === 'function') return value as CoreFn;
  }
  return undefined;
}

function readBooleanFact(result: unknown, key: 'authorityChanged' | 'receiptVerified' | 'productionDone'): boolean {
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
  lines.push(`authorityChanged: ${readBooleanFact(result, 'authorityChanged')}`);
  lines.push(`receiptVerified: ${readBooleanFact(result, 'receiptVerified')}`);
  lines.push(`productionDone: ${readBooleanFact(result, 'productionDone')}`);
  const nextAction = readStringFact(result, 'nextAction');
  if (nextAction) lines.push(`nextAction: ${nextAction}`);
  return lines.join('\n');
}

function renderResult(render: CoreFn | undefined, fallbackTitle: string, result: unknown): string {
  if (render) return String(render(result));
  return renderFallback(fallbackTitle, result);
}

async function loadPolicyCore(): Promise<CoreModule> {
  return loadCoreModule(AUTOPILOT_POLICY_MODULE, [
    'createAutopilotPolicy',
    'getAutopilotPolicy',
    'checkAutopilotPolicy',
    'renderAutopilotPolicyText',
    'renderAutopilotPolicyCheckText',
  ]);
}

async function loadRunCore(): Promise<CoreModule> {
  return loadCoreModule(LATTICE_AUTOPILOT_MODULE, [
    'autopilotRun',
    'autopilotStatus',
    'autopilotWatch',
    'autopilotCancel',
    'autopilotReview',
    'autopilotResume',
    'renderAutopilotRunText',
    'renderAutopilotWatchText',
    'renderAutopilotCancelText',
    'renderAutopilotReviewText',
    'renderAutopilotResumeText',
  ]);
}

function requireRunId(args: { runId?: string }): string {
  const runId = args.runId?.trim();
  if (!runId) throw new Error('runId is required');
  return runId;
}

export function createLatticeAutopilotHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  return {
    async autopilot_policy_create(args: Record<string, unknown> & FormatArgs) {
      const core = await loadPolicyCore();
      const createPolicy = pickFunction(core, ['createAutopilotPolicy']);
      const renderPolicy = maybeFunction(core, ['renderAutopilotPolicyText']);
      const result = await createPolicy(ctx.root, normalizePolicyArgs(args), policyCheckOptions(args));
      const outputNote = maybeWriteOutput(ctx.root, args.output, result);
      if (wantsJson(args)) return result;
      return `${renderResult(renderPolicy, 'Autopilot policy', result)}${outputNote}`;
    },
    async autopilot_policy_get(args: { policy: string } & FormatArgs) {
      const core = await loadPolicyCore();
      const getPolicy = pickFunction(core, ['getAutopilotPolicy']);
      const renderPolicy = maybeFunction(core, ['renderAutopilotPolicyText']);
      const result = await getPolicy(ctx.root, args.policy);
      const outputNote = maybeWriteOutput(ctx.root, args.output, result);
      if (wantsJson(args)) return result;
      return `${renderResult(renderPolicy, 'Autopilot policy', result)}${outputNote}`;
    },
    async autopilot_policy_check(args: { policy: string } & FormatArgs) {
      const core = await loadPolicyCore();
      const checkPolicy = pickFunction(core, ['checkAutopilotPolicy']);
      const renderCheck = maybeFunction(core, ['renderAutopilotPolicyCheckText']);
      const result = await checkPolicy(ctx.root, args.policy, policyCheckOptions(args));
      const outputNote = maybeWriteOutput(ctx.root, args.output, result);
      if (wantsJson(args)) return result;
      return `${renderResult(renderCheck, 'Autopilot policy check', result)}${outputNote}`;
    },
    async autopilot_run(args: Record<string, unknown> & FormatArgs) {
      const core = await loadRunCore();
      const runAutopilot = pickFunction(core, ['autopilotRun', 'runAutopilot']);
      const renderRun = maybeFunction(core, ['renderAutopilotRunText']);
      const result = await runAutopilot(ctx.store, ctx.root, normalizeRunArgs(args));
      const outputNote = maybeWriteOutput(ctx.root, args.output, result);
      if (wantsJson(args)) return result;
      return `${renderResult(renderRun, 'Autopilot run', result)}${outputNote}`;
    },
    async autopilot_status(args: { runId?: string } & FormatArgs) {
      const runId = requireRunId(args);
      const core = await loadRunCore();
      const status = pickFunction(core, ['autopilotStatus']);
      const renderStatus = maybeFunction(core, ['renderAutopilotRunText', 'renderAutopilotStatusText']);
      const result = await status(ctx.root, runId);
      const outputNote = maybeWriteOutput(ctx.root, args.output, result);
      if (wantsJson(args)) return result;
      return `${renderResult(renderStatus, 'Autopilot status', result)}${outputNote}`;
    },
    async autopilot_watch(args: { runId?: string } & FormatArgs) {
      const runId = requireRunId(args);
      const core = await loadRunCore();
      const watch = pickFunction(core, ['autopilotWatch']);
      const renderWatch = maybeFunction(core, ['renderAutopilotWatchText']);
      const result = await watch(ctx.root, runId);
      const outputNote = maybeWriteOutput(ctx.root, args.output, result);
      if (wantsJson(args)) return result;
      return `${renderResult(renderWatch, 'Autopilot watch', result)}${outputNote}`;
    },
    async autopilot_cancel(args: { runId?: string } & FormatArgs) {
      const runId = requireRunId(args);
      const core = await loadRunCore();
      const cancel = pickFunction(core, ['autopilotCancel', 'cancelAutopilot']);
      const renderStatus = maybeFunction(core, ['renderAutopilotCancelText', 'renderAutopilotStatusText', 'renderAutopilotRunText']);
      const result = await cancel(ctx.root, runId, stripFormatArgs(args));
      const outputNote = maybeWriteOutput(ctx.root, args.output, result);
      if (wantsJson(args)) return result;
      return `${renderResult(renderStatus, 'Autopilot status', result)}${outputNote}`;
    },
    async autopilot_review(args: { runId?: string } & FormatArgs) {
      const runId = requireRunId(args);
      const core = await loadRunCore();
      const review = pickFunction(core, ['autopilotReview', 'reviewAutopilot']);
      const renderReview = maybeFunction(core, ['renderAutopilotReviewText']);
      const result = await review(ctx.root, runId);
      const outputNote = maybeWriteOutput(ctx.root, args.output, result);
      if (wantsJson(args)) return result;
      return `${renderResult(renderReview, 'Autopilot review', result)}${outputNote}`;
    },
    async autopilot_resume(args: { runId?: string } & Record<string, unknown> & FormatArgs) {
      const runId = requireRunId(args);
      const core = await loadRunCore();
      const resume = pickFunction(core, ['autopilotResume', 'resumeAutopilot']);
      const renderRun = maybeFunction(core, ['renderAutopilotResumeText', 'renderAutopilotRunText']);
      const result = await resume(ctx.store, ctx.root, { ...normalizeRunArgs(args), runId });
      const outputNote = maybeWriteOutput(ctx.root, args.output, result);
      if (wantsJson(args)) return result;
      return `${renderResult(renderRun, 'Autopilot run', result)}${outputNote}`;
    },
  };
}
