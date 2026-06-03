import { execFileSync, execSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { changedFilesBetween, checkEvidenceFreshnessForGit, currentGitHead } from './evidence-freshness.js';
import {
  buildHandoffWorktreeProjection,
  createHandoffPack,
  submitHandoffReceipt,
  type HandoffPack,
  type HandoffReceipt,
  type HandoffReceiptSubmission,
} from './lattice-handoff.js';
import type { StoryStore } from './store.js';

export type HostRuntimeId = 'fake' | 'claude-code' | 'gemini' | 'codex';
export type HostRuntimeStatus = 'ready' | 'scaffolded' | 'unavailable';
export type DispatchLifecycleStatus =
  | 'planned'
  | 'prepared'
  | 'running'
  | 'needs_receipt'
  | 'accepted_local'
  | 'diagnostic'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'unavailable';

export interface DispatchAuthorityState {
  authorityChanged: false;
  receiptVerified: false;
  productionDone: false;
}

export interface HostRuntimeProbe {
  schemaVersion: 'lattice.host_runtime_probe.v1';
  host: HostRuntimeId;
  requestedHost: string;
  status: HostRuntimeStatus;
  available: boolean;
  supportsParallel: boolean;
  matchedFallback: boolean;
  runtimeKind: 'fake' | 'scaffolded' | 'missing-cli';
  cliCommand?: string;
  commandPath?: string;
  invocationTemplate?: string[];
  limitations: string[];
  warnings: string[];
  nextAction: string;
  authority: DispatchAuthorityState;
}

export interface HostRuntimeList {
  schemaVersion: 'lattice.host_runtime_list.v1';
  runtimes: HostRuntimeProbe[];
  authority: DispatchAuthorityState;
}

export interface DispatchPackPreview {
  packId: string;
  packHash: string;
  baseSha?: string;
  fromHost: string;
  toHost: string;
  allowedPaths: string[];
  deniedPaths: string[];
  requiredCommands: string[];
  successCriteria: string[];
  authorityBoundarySummary: string;
}

export interface DispatchPlanResult {
  schemaVersion: 'lattice.dispatch_plan.v1';
  storyId: string;
  requestedHost: string;
  selectedHost: HostRuntimeId;
  status: 'planned' | 'unavailable';
  parallel: number;
  runtime: HostRuntimeProbe;
  fallbackHosts: Array<{
    host: HostRuntimeId;
    status: HostRuntimeStatus;
    reason: string;
  }>;
  pack: DispatchPackPreview;
  worktree: {
    branch: string;
    worktreePath: string;
    reviewCommand: string;
    cleanupCommand: string;
  };
  risks: string[];
  warnings: string[];
  nextAction: string;
  authorityChanged: false;
  receiptVerified: false;
  productionDone: false;
}

export interface DispatchRecord {
  schemaVersion: 'lattice.dispatch_record.v1';
  dispatchId: string;
  storyId: string;
  requestedHost: string;
  selectedHost: HostRuntimeId;
  status: DispatchLifecycleStatus;
  parallel: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  runtime: HostRuntimeProbe;
  warnings: string[];
  nextAction: string;
  packFile: string;
  statusFile: string;
  promptFile: string;
  transcriptFile: string;
  collectFile: string;
  receiptFile: string;
  receiptSubmissionFile: string;
  worktree: {
    branch: string;
    worktreePath: string;
    reviewCommand: string;
    cleanupCommand: string;
  };
  workerIds: string[];
  parentDispatchId?: string;
  latestHeadSha?: string;
  cancelledAt?: string;
  authorityChanged: false;
  receiptVerified: false;
  productionDone: false;
}

export interface DispatchCollection {
  schemaVersion: 'lattice.dispatch_collect.v1';
  dispatchId: string;
  storyId: string;
  host: HostRuntimeId;
  status: DispatchLifecycleStatus;
  baseSha?: string;
  headSha?: string;
  freshness: 'fresh' | 'stale' | 'unknown';
  changedFiles: string[];
  commands: string[];
  transcriptExists: boolean;
  warnings: string[];
  limitations: string[];
  workers: DispatchCollection[];
  authorityChanged: false;
  receiptVerified: false;
  productionDone: false;
}

export interface DispatchReceiptDraft {
  schemaVersion: 'lattice.dispatch_receipt_create.v1';
  dispatchId: string;
  status: 'created' | 'diagnostic';
  receipt: HandoffReceipt;
  warnings: string[];
  authorityChanged: false;
  receiptVerified: false;
  productionDone: false;
}

export interface DispatchRunResult {
  schemaVersion: 'lattice.dispatch_run.v1';
  dispatchId: string;
  storyId: string;
  host: HostRuntimeId;
  status: DispatchLifecycleStatus;
  parallel: number;
  runtime: HostRuntimeProbe;
  workers: DispatchRunResult[];
  receipt?: HandoffReceiptSubmission;
  warnings: string[];
  nextAction: string;
  authorityChanged: false;
  receiptVerified: false;
  productionDone: false;
}

export interface DispatchStatusResult {
  schemaVersion: 'lattice.dispatch_status.v1';
  dispatch: DispatchRecord;
  receipt?: HandoffReceiptSubmission;
  workers: DispatchStatusResult[];
  authorityChanged: false;
  receiptVerified: false;
  productionDone: false;
}

export interface DispatchListResult {
  schemaVersion: 'lattice.dispatch_list.v1';
  dispatches: Array<{
    dispatchId: string;
    storyId: string;
    host: HostRuntimeId;
    status: DispatchLifecycleStatus;
    parallel: number;
    updatedAt: string;
  }>;
  authorityChanged: false;
  receiptVerified: false;
  productionDone: false;
}

export interface DispatchReviewResult {
  schemaVersion: 'lattice.dispatch_review.v1';
  dispatchId: string;
  storyId: string;
  status: DispatchLifecycleStatus;
  changedFiles: string[];
  receipt?: HandoffReceiptSubmission;
  workers: DispatchReviewResult[];
  warnings: string[];
  risks: string[];
  nextAction: string;
  authorityChanged: false;
  receiptVerified: false;
  productionDone: false;
}

export interface DispatchMergePlanResult {
  schemaVersion: 'lattice.dispatch_merge_plan.v1';
  dispatchId: string;
  storyId: string;
  status: DispatchLifecycleStatus;
  mergeable: boolean;
  manualOnly: true;
  workers: Array<{
    dispatchId: string;
    status: DispatchLifecycleStatus;
    reviewCommand: string;
    cleanupCommand: string;
  }>;
  commands: string[];
  warnings: string[];
  nextAction: string;
  authorityChanged: false;
  receiptVerified: false;
  productionDone: false;
}

type DispatchPlanArgs = {
  storyId: string;
  host?: string;
  fromHost?: string;
  role?: string;
  objective?: string;
  allowedPaths?: string[];
  deniedPaths?: string[];
  requiredCommands?: string[];
  successCriteria?: string[];
  baseSha?: string;
  packId?: string;
  authorityBoundary?: string;
  executionInstructions?: string[];
  parallel?: number;
};

type DispatchPrepareArgs = DispatchPlanArgs & {
  dispatchId?: string;
};

type DispatchRunArgs = DispatchPrepareArgs & {
  dispatchId?: string;
};

const TERMINAL_DISPATCH_STATUSES = new Set<DispatchLifecycleStatus>([
  'accepted_local',
  'diagnostic',
  'failed',
  'cancelled',
  'expired',
  'unavailable',
]);

const HOST_RUNTIME_ORDER: HostRuntimeId[] = ['claude-code', 'gemini', 'codex', 'fake'];
const REAL_HOST_CLI: Record<Exclude<HostRuntimeId, 'fake'>, string> = {
  'claude-code': 'claude',
  gemini: 'gemini',
  codex: 'codex',
};

function authorityState(): DispatchAuthorityState {
  return {
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function plusHoursIso(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function normalizeHostRuntimeId(host: string | undefined): HostRuntimeId | null {
  const value = (host ?? '').trim().toLowerCase();
  if (!value || value === 'auto') return null;
  if (value === 'claude' || value === 'claude-code') return 'claude-code';
  if (value === 'gemini') return 'gemini';
  if (value === 'codex') return 'codex';
  if (value === 'fake') return 'fake';
  return null;
}

function detectCommandPath(command: string): string | null {
  try {
    const path = execFileSync('sh', ['-lc', `command -v ${command}`], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return path || null;
  } catch {
    return null;
  }
}

function currentCodexSessionAvailable(): boolean {
  return process.env.KOALA_ACTIVITY_SOURCE === 'codex'
    || typeof process.env.CODEX_SESSION_ID === 'string'
    || typeof process.env.CODEX_HOME === 'string';
}

function runtimeTemplate(host: HostRuntimeId): string[] | undefined {
  if (host === 'fake') return ['fake-runtime', '--deterministic'];
  if (host === 'claude-code') return ['claude', '--print', '<prompt-file>'];
  if (host === 'gemini') return ['gemini', '--prompt-file', '<prompt-file>'];
  return ['codex', 'exec', '--prompt-file', '<prompt-file>'];
}

export function probeHostRuntime(host: string): HostRuntimeProbe {
  const normalized = normalizeHostRuntimeId(host);
  if (!normalized) {
    throw new Error(`host_runtime_probe requires host=fake|claude-code|gemini|codex; got ${host || '(empty)'}`);
  }
  if (normalized === 'fake') {
    return {
      schemaVersion: 'lattice.host_runtime_probe.v1',
      host: 'fake',
      requestedHost: host,
      status: 'ready',
      available: true,
      supportsParallel: true,
      matchedFallback: host.trim().toLowerCase() !== 'fake',
      runtimeKind: 'fake',
      invocationTemplate: runtimeTemplate('fake'),
      limitations: [
        'Deterministic local test harness only.',
        'Produces local diagnostic receipts only.',
        'Never verifies receipts, changes authority, or claims productionDone.',
      ],
      warnings: [],
      nextAction: 'Ready for deterministic local dispatch_prepare/dispatch_run coverage in an isolated overflow worktree.',
      authority: authorityState(),
    };
  }

  const cliCommand = REAL_HOST_CLI[normalized];
  const commandPath = normalized === 'codex' && currentCodexSessionAvailable()
    ? process.execPath
    : detectCommandPath(cliCommand);
  const available = Boolean(commandPath);
  const warnings = available
    ? [
      `${normalized} runtime is scaffolded only: Lattice records invocation metadata and waits for a local receipt; it does not auto-drive the external host.`,
    ]
    : [
      `${cliCommand} CLI is not available in PATH; runtime stays unavailable-safe and will not start the host automatically.`,
    ];
  return {
    schemaVersion: 'lattice.host_runtime_probe.v1',
    host: normalized,
    requestedHost: host,
    status: available ? 'scaffolded' : 'unavailable',
    available,
    supportsParallel: false,
    matchedFallback: host.trim().toLowerCase() !== normalized,
    runtimeKind: available ? 'scaffolded' : 'missing-cli',
    cliCommand,
    ...(commandPath ? { commandPath } : {}),
    invocationTemplate: runtimeTemplate(normalized),
    limitations: [
      'Real-host execution is scaffolded only in this milestone.',
      'No external host is auto-driven by Lattice dispatch_run.',
      'A local receipt is still diagnostic-only and leaves productionDone=false.',
    ],
    warnings,
    nextAction: available
      ? `Use dispatch_prepare/dispatch_run to generate the isolated worktree + prompt metadata, then run ${cliCommand} manually and return a local receipt.`
      : `Install or expose ${cliCommand} in PATH, or use host=fake for deterministic local coverage.`,
    authority: authorityState(),
  };
}

export function listHostRuntimes(): HostRuntimeList {
  return {
    schemaVersion: 'lattice.host_runtime_list.v1',
    runtimes: ['fake', 'claude-code', 'gemini', 'codex'].map(host => probeHostRuntime(host)),
    authority: authorityState(),
  };
}

function normalizeList(values: string[] | undefined): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function normalizeDispatchId(dispatchId: string, label = 'dispatchId'): string {
  const trimmed = dispatchId.trim();
  if (!trimmed) {
    throw new Error(`${label} must not be empty.`);
  }
  if (isAbsolute(trimmed)) {
    throw new Error(`${label} must not be absolute: ${trimmed}`);
  }
  if (/[\\/]/.test(trimmed)) {
    throw new Error(`${label} must not contain path separators or traversal segments: ${trimmed}`);
  }
  if (trimmed === '.' || trimmed === '..') {
    throw new Error(`${label} must not be "." or "..": ${trimmed}`);
  }
  return trimmed;
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'dispatch';
}

function dispatchStorageRoot(root: string): string {
  return join(root, '.koala', 'dispatches');
}

function projectedDispatchWorktreePath(storyId: string, packId: string): string {
  return `.worktrees/overflow/${sanitizeSegment(storyId)}/${sanitizeSegment(packId)}`;
}

function normalizePackPathList(
  root: string,
  storyId: string,
  packId: string,
  values: string[] | undefined,
  label: 'allowedPaths' | 'deniedPaths',
): string[] {
  const worktreeAbs = resolve(root, projectedDispatchWorktreePath(storyId, packId));
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const [index, value] of (values ?? []).entries()) {
    const relativePath = assertWorktreeRelativePath(worktreeAbs, value, `${label}[${index}]`);
    if (seen.has(relativePath)) continue;
    seen.add(relativePath);
    normalized.push(relativePath);
  }
  return normalized;
}

function dispatchDir(root: string, dispatchId: string): string {
  return join(dispatchStorageRoot(root), normalizeDispatchId(dispatchId));
}

function dispatchFile(root: string, dispatchId: string, name: string): string {
  return join(dispatchDir(root, dispatchId), name);
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function maybeReadJson<T>(file: string): T | undefined {
  return existsSync(file) ? readJson<T>(file) : undefined;
}

function ensureDispatchDir(root: string, dispatchId: string): void {
  mkdirSync(dispatchDir(root, dispatchId), { recursive: true });
}

function createDispatchId(storyId: string, host: HostRuntimeId): string {
  const stamp = Date.now().toString(36);
  return `D-${sanitizeSegment(storyId)}-${sanitizeSegment(host)}-${stamp}`;
}

function dispatchPrompt(pack: HandoffPack, runtime: HostRuntimeProbe, dispatchId: string): string {
  return [
    `# Lattice Dispatch ${dispatchId}`,
    '',
    `Story: ${pack.storyId}`,
    `Host runtime: ${runtime.host}`,
    `Pack: ${pack.packId} (${pack.packHash})`,
    '',
    '## Execution Instructions',
    ...pack.executionInstructions.map(line => `- ${line}`),
    '',
    '## Required Commands',
    ...(pack.requiredCommands.length > 0 ? pack.requiredCommands.map(line => `- ${line}`) : ['- (none)']),
    '',
    '## Success Criteria',
    ...(pack.successCriteria.length > 0 ? pack.successCriteria.map(line => `- ${line}`) : ['- Return a local diagnostic receipt for review.']),
    '',
    '## Authority Boundary',
    `- ${pack.authorityBoundary.summary}`,
    ...pack.authorityBoundary.notes.map(line => `- ${line}`),
  ].join('\n') + '\n';
}

function handoffTargetForRuntime(host: HostRuntimeId): string {
  if (host === 'claude-code') return 'claude-code';
  if (host === 'gemini') return 'gemini';
  return 'codex';
}

function chooseHost(requestedHost: string | undefined): {
  selectedHost: HostRuntimeId;
  runtime: HostRuntimeProbe;
  fallbackHosts: Array<{ host: HostRuntimeId; status: HostRuntimeStatus; reason: string }>;
} {
  const explicit = normalizeHostRuntimeId(requestedHost);
  if (explicit) {
    const runtime = probeHostRuntime(explicit);
    return {
      selectedHost: explicit,
      runtime,
      fallbackHosts: HOST_RUNTIME_ORDER
        .filter(host => host !== explicit)
        .map(host => ({ host, status: probeHostRuntime(host).status, reason: probeHostRuntime(host).nextAction })),
    };
  }

  const probes = HOST_RUNTIME_ORDER.map(host => probeHostRuntime(host));
  const selected = probes.find(probe => probe.status !== 'unavailable') ?? probes[probes.length - 1];
  return {
    selectedHost: selected.host,
    runtime: selected,
    fallbackHosts: probes
      .filter(probe => probe.host !== selected.host)
      .map(probe => ({ host: probe.host, status: probe.status, reason: probe.nextAction })),
  };
}

function packPreview(pack: HandoffPack): DispatchPackPreview {
  return {
    packId: pack.packId,
    packHash: pack.packHash,
    ...(pack.baseSha ? { baseSha: pack.baseSha } : {}),
    fromHost: pack.fromHost,
    toHost: pack.toHost,
    allowedPaths: [...pack.allowedPaths],
    deniedPaths: [...pack.deniedPaths],
    requiredCommands: [...pack.requiredCommands],
    successCriteria: [...pack.successCriteria],
    authorityBoundarySummary: pack.authorityBoundary.summary,
  };
}

function buildPack(
  store: StoryStore,
  root: string,
  args: DispatchPlanArgs,
  selectedHost: HostRuntimeId,
  dispatchId?: string,
): HandoffPack {
  const role = args.role?.trim() || 'overflow-worker';
  const objective = args.objective?.trim() || `Dispatch runtime work for ${args.storyId}`;
  const packId = args.packId?.trim() || dispatchId || 'dispatch-preview';
  return createHandoffPack(store, root, {
    storyId: args.storyId,
    fromHost: args.fromHost?.trim() || 'codex',
    toHost: handoffTargetForRuntime(selectedHost),
    role,
    objective,
    allowedPaths: normalizePackPathList(root, args.storyId, packId, args.allowedPaths, 'allowedPaths'),
    deniedPaths: normalizePackPathList(root, args.storyId, packId, args.deniedPaths, 'deniedPaths'),
    requiredCommands: normalizeList(args.requiredCommands),
    successCriteria: normalizeList(args.successCriteria),
    baseSha: args.baseSha?.trim(),
    packId,
    authorityBoundary: args.authorityBoundary?.trim(),
    executionInstructions: normalizeList(args.executionInstructions),
  });
}

function computePlan(
  store: StoryStore,
  root: string,
  args: DispatchPlanArgs,
): DispatchPlanResult {
  const { selectedHost, runtime, fallbackHosts } = chooseHost(args.host);
  const pack = buildPack(store, root, args, selectedHost);
  const worktree = buildHandoffWorktreeProjection(pack);
  const constraintWarnings = [
    ...(pack.allowedPaths.length === 0 ? ['No allowedPaths declared; scope remains advisory until constrained.'] : []),
    ...(pack.requiredCommands.length === 0 ? ['No requiredCommands declared; validation expectations are minimal.'] : []),
  ];
  const risks = [
    ...(runtime.status === 'unavailable' ? [`${selectedHost} runtime is unavailable.`] : []),
    ...(runtime.status === 'scaffolded' ? ['Real-host execution remains scaffolded/manual-first.'] : []),
    ...constraintWarnings,
  ];
  const warnings = [
    ...runtime.warnings,
    ...worktree.warnings,
    ...constraintWarnings,
  ];
  return {
    schemaVersion: 'lattice.dispatch_plan.v1',
    storyId: args.storyId,
    requestedHost: args.host?.trim() || 'auto',
    selectedHost,
    status: runtime.status === 'unavailable' ? 'unavailable' : 'planned',
    parallel: Math.max(1, args.parallel ?? 1),
    runtime,
    fallbackHosts,
    pack: packPreview(pack),
    worktree: {
      branch: worktree.branch,
      worktreePath: worktree.worktreePath,
      reviewCommand: worktree.reviewCommand,
      cleanupCommand: worktree.cleanupCommand,
    },
    risks,
    warnings,
    nextAction: runtime.status === 'unavailable'
      ? runtime.nextAction
      : selectedHost === 'fake'
        ? 'Run dispatch_prepare or dispatch_run --host=fake to create isolated local dispatch state and a diagnostic receipt.'
        : `Run dispatch_prepare to materialize prompt/worktree metadata for ${selectedHost}; real-host execution stays manual-first and receipt-aware.`,
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
  };
}

function readPack(root: string, dispatchId: string): HandoffPack {
  return readJson<HandoffPack>(dispatchFile(root, dispatchId, 'pack.json'));
}

function writePack(root: string, dispatchId: string, pack: HandoffPack): void {
  writeJson(dispatchFile(root, dispatchId, 'pack.json'), pack);
}

function writeRecord(root: string, record: DispatchRecord): DispatchRecord {
  const dispatchId = normalizeDispatchId(record.dispatchId, 'record.dispatchId');
  const next = {
    ...record,
    dispatchId,
    updatedAt: nowIso(),
  };
  writeJson(dispatchFile(root, dispatchId, 'dispatch.json'), next);
  return next;
}

function readRecord(root: string, dispatchId: string): DispatchRecord {
  const normalizedDispatchId = normalizeDispatchId(dispatchId);
  const file = dispatchFile(root, normalizedDispatchId, 'dispatch.json');
  if (!existsSync(file)) {
    throw new Error(`Unknown dispatchId ${normalizedDispatchId}. Expected ${relative(root, file)}.`);
  }
  const record = readJson<DispatchRecord>(file);
  const recordedDispatchId = normalizeDispatchId(record.dispatchId, 'dispatch.json dispatchId');
  if (recordedDispatchId !== normalizedDispatchId) {
    throw new Error(`Dispatch metadata mismatch: requested ${normalizedDispatchId}, found ${recordedDispatchId}.`);
  }
  return {
    ...record,
    dispatchId: recordedDispatchId,
  };
}

function resolveEffectiveStatus(record: DispatchRecord): DispatchLifecycleStatus {
  if (!TERMINAL_DISPATCH_STATUSES.has(record.status) && Date.parse(record.expiresAt) < Date.now()) {
    return 'expired';
  }
  return record.status;
}

function ensurePreparedPackForFake(root: string, dispatchId: string, pack: HandoffPack): HandoffPack {
  if (pack.allowedPaths.length > 0) return pack;
  const safePath = `.koala/dispatches/${dispatchId}/worker/fake-result.txt`;
  const patched: HandoffPack = {
    ...pack,
    allowedPaths: [safePath],
    executionInstructions: [
      ...pack.executionInstructions,
      `Fake runtime defaulted allowedPaths to ${safePath} so deterministic local scope can still be reviewed.`,
    ],
  };
  writePack(root, dispatchId, patched);
  return patched;
}

function assertWorktreeRelativePath(worktreeAbs: string, candidatePath: string, label: string): string {
  const trimmed = candidatePath.trim();
  if (!trimmed) {
    throw new Error(`${label} must not be empty.`);
  }
  if (isAbsolute(trimmed)) {
    throw new Error(`${label} must stay inside the isolated worktree; absolute paths are forbidden: ${trimmed}`);
  }
  const candidateAbs = resolve(worktreeAbs, trimmed);
  const candidateRel = relative(worktreeAbs, candidateAbs);
  if (candidateRel === '..' || candidateRel.startsWith(`..${sep}`)) {
    throw new Error(`${label} escapes the isolated worktree via path traversal: ${trimmed}`);
  }
  return candidateRel || '.';
}

function pathResolvesWithinRoot(rootReal: string, candidateReal: string): boolean {
  const rel = relative(rootReal, candidateReal);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`));
}

function assertCanonicalWorktreePath(worktreeAbs: string, candidatePath: string, label: string): string {
  const relativePath = assertWorktreeRelativePath(worktreeAbs, candidatePath, label);
  const worktreeReal = realpathSync(worktreeAbs);
  const segments = relativePath === '.' ? [] : relativePath.split(/[\\/]+/).filter(Boolean);
  let currentAbs = worktreeAbs;
  for (const segment of segments) {
    currentAbs = join(currentAbs, segment);
    try {
      lstatSync(currentAbs);
    } catch {
      break;
    }
    let currentReal: string;
    try {
      currentReal = realpathSync(currentAbs);
    } catch (error: any) {
      throw new Error(`${label} traverses an unresolved symlink inside the isolated worktree: ${candidatePath} (${String(error?.message || error)})`);
    }
    if (!pathResolvesWithinRoot(worktreeReal, currentReal)) {
      throw new Error(`${label} resolves outside the isolated worktree via an existing symlinked path segment: ${candidatePath}`);
    }
  }
  return relativePath;
}

function listedGitWorktreeRoots(root: string): string[] {
  const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  return output
    .split(/\r?\n/)
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length).trim())
    .filter(Boolean)
    .map((path) => {
      try {
        return realpathSync(path);
      } catch {
        return resolve(root, path);
      }
    });
}

function assertProjectedWorktreeAncestors(root: string, worktreeAbs: string, label: string): void {
  const relativePath = relative(root, worktreeAbs);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`${label} must stay within the repository root: ${worktreeAbs}`);
  }
  const rootReal = realpathSync(root);
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  let currentAbs = root;
  for (const segment of segments) {
    currentAbs = join(currentAbs, segment);
    let entry: ReturnType<typeof lstatSync>;
    try {
      entry = lstatSync(currentAbs);
    } catch (error: any) {
      if (error?.code === 'ENOENT') break;
      const detail = String(error?.message || error).trim();
      throw new Error(`${label} ancestor could not be inspected: ${relative(root, currentAbs)} (${detail})`);
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`${label} traverses a symlinked ancestor: ${relative(root, currentAbs)}`);
    }
    if (!entry.isDirectory()) {
      throw new Error(`${label} ancestor must be a directory: ${relative(root, currentAbs)}`);
    }
    const currentReal = realpathSync(currentAbs);
    if (!pathResolvesWithinRoot(rootReal, currentReal)) {
      throw new Error(`${label} ancestor resolves outside the repository root: ${relative(root, currentAbs)}`);
    }
  }
}

function assertRegisteredDispatchWorktreeRoot(root: string, worktreeAbs: string, label: string): void {
  const entry = lstatSync(worktreeAbs);
  if (entry.isSymbolicLink()) {
    throw new Error(`${label} must be a real git worktree root, not a symlink: ${relative(root, worktreeAbs)}`);
  }
  if (!entry.isDirectory()) {
    throw new Error(`${label} must be a directory git worktree root: ${relative(root, worktreeAbs)}`);
  }
  const rootReal = realpathSync(root);
  const worktreeReal = realpathSync(worktreeAbs);
  if (!pathResolvesWithinRoot(rootReal, worktreeReal)) {
    throw new Error(`${label} resolves outside the repository root: ${relative(root, worktreeAbs)}`);
  }

  let gitTopLevel: string;
  try {
    gitTopLevel = execFileSync('git', ['-C', worktreeAbs, 'rev-parse', '--show-toplevel'], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    }).trim();
  } catch (error: any) {
    const detail = String(error?.stderr || error?.stdout || error?.message || error).trim();
    throw new Error(`${label} is not a git worktree root: ${relative(root, worktreeAbs)} (${detail})`);
  }

  const gitTopLevelReal = realpathSync(gitTopLevel);
  if (gitTopLevelReal !== worktreeReal) {
    throw new Error(`${label} must be the git top-level worktree root, got ${relative(root, worktreeAbs)} inside ${relative(root, gitTopLevelReal)}`);
  }

  if (!listedGitWorktreeRoots(root).includes(worktreeReal)) {
    throw new Error(`${label} is not registered in this repository's git worktree list: ${relative(root, worktreeAbs)}`);
  }
}

function normalizePackPaths(
  root: string,
  dispatchId: string,
  worktreeAbs: string,
  pack: HandoffPack,
  mode: 'relative' | 'canonical' = 'relative',
): HandoffPack {
  const normalizePath = mode === 'canonical'
    ? assertCanonicalWorktreePath
    : assertWorktreeRelativePath;
  const allowedPaths = pack.allowedPaths.map((entry, index) =>
    normalizePath(worktreeAbs, entry, `allowedPaths[${index}]`));
  const deniedPaths = pack.deniedPaths.map((entry, index) =>
    normalizePath(worktreeAbs, entry, `deniedPaths[${index}]`));
  const packChanged = allowedPaths.some((entry, index) => entry !== pack.allowedPaths[index])
    || deniedPaths.some((entry, index) => entry !== pack.deniedPaths[index]);
  if (!packChanged) return pack;
  const patched: HandoffPack = {
    ...pack,
    allowedPaths,
    deniedPaths,
  };
  writePack(root, dispatchId, patched);
  return patched;
}

function ensureWorktree(root: string, worktreePath: string, branch: string, baseRef: string): string {
  const absPath = resolve(root, worktreePath);
  assertProjectedWorktreeAncestors(root, absPath, 'Dispatch worktree path');
  if (existsSync(absPath)) {
    assertRegisteredDispatchWorktreeRoot(root, absPath, 'Dispatch worktree path');
    return absPath;
  }
  mkdirSync(dirname(absPath), { recursive: true });
  assertProjectedWorktreeAncestors(root, absPath, 'Dispatch worktree path');
  try {
    execFileSync('git', ['worktree', 'add', absPath, '-b', branch, baseRef], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } catch (error: any) {
    const message = String(error?.stderr || error?.stdout || error?.message || error);
    if (!existsSync(absPath)) {
      throw new Error(`git worktree add failed for ${worktreePath}: ${message.trim()}`);
    }
  }
  try {
    assertRegisteredDispatchWorktreeRoot(root, absPath, 'Dispatch worktree path');
  } catch (error: any) {
    const detail = String(error?.message || error).trim();
    const cleanupWarnings = cleanupCreatedWorktree(root, worktreePath, branch);
    const suffix = cleanupWarnings.length > 0 ? ` (${cleanupWarnings.join(' | ')})` : '';
    throw new Error(`${detail}${suffix}`);
  }
  return absPath;
}

function cleanupCreatedWorktree(root: string, worktreePath: string, branch: string): string[] {
  const warnings: string[] = [];
  const absPath = resolve(root, worktreePath);
  try {
    execFileSync('git', ['worktree', 'remove', '--force', absPath], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } catch (error: any) {
    const detail = String(error?.stderr || error?.stdout || error?.message || error).trim();
    warnings.push(`Worktree cleanup warning: git worktree remove failed for ${worktreePath}: ${detail}`);
  }
  if (existsSync(absPath)) {
    try {
      rmSync(absPath, { recursive: true, force: true });
    } catch (error: any) {
      const detail = String(error?.message || error).trim();
      warnings.push(`Worktree cleanup warning: rm -rf failed for ${worktreePath}: ${detail}`);
    }
  }
  try {
    execFileSync('git', ['worktree', 'prune'], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } catch {
    // probe: stale worktree metadata can remain until prune, but prune failure is non-fatal here
  }
  try {
    execFileSync('git', ['branch', '-D', branch], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } catch (error: any) {
    const detail = String(error?.stderr || error?.stdout || error?.message || error).trim();
    warnings.push(`Worktree cleanup warning: branch delete failed for ${branch}: ${detail}`);
  }
  return warnings;
}

function appendTranscript(file: string, lines: string[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const previous = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const payload = `${previous}${lines.join('\n')}\n`;
  writeFileSync(file, payload, 'utf8');
}

function gitOutput(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function runRequiredCommands(worktreeRoot: string, commands: string[]): Array<{ command: string; ok: boolean; output: string }> {
  return commands.map((command) => {
    try {
      const output = execSync(command, {
        cwd: worktreeRoot,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { command, ok: true, output: output.trim() };
    } catch (error: any) {
      const details = String(error?.stderr || error?.stdout || error?.message || error).trim();
      return { command, ok: false, output: details };
    }
  });
}

function dispatchReceiptHost(record: Pick<DispatchRecord, 'selectedHost'>, pack: HandoffPack): string {
  return normalizeHostRuntimeId(record.selectedHost) ?? pack.toHost;
}

function createFakeReceipt(
  pack: HandoffPack,
  record: Pick<DispatchRecord, 'dispatchId' | 'selectedHost'>,
  headSha: string,
  changedFiles: string[],
  commandResults: Array<{ command: string; ok: boolean; output: string }>,
  warnings: string[],
): HandoffReceipt {
  const failedCommand = commandResults.find(result => !result.ok);
  return {
    schemaVersion: 'lattice.handoff_receipt.v1',
    storyId: pack.storyId,
    host: dispatchReceiptHost(record, pack),
    packId: pack.packId,
    packHash: pack.packHash,
    fromHost: pack.fromHost,
    toHost: pack.toHost,
    ...(pack.baseSha ? { baseSha: pack.baseSha } : {}),
    ...(pack.role ? { role: pack.role } : {}),
    ...(pack.objective ? { objective: pack.objective } : {}),
    allowedPaths: [...pack.allowedPaths],
    deniedPaths: [...pack.deniedPaths],
    requiredCommands: [...pack.requiredCommands],
    successCriteria: [...pack.successCriteria],
    authorityBoundary: pack.authorityBoundary,
    executionInstructions: [...pack.executionInstructions],
    headSha,
    changedFiles,
    commands: commandResults.map(result => result.command),
    verdict: failedCommand ? 'fail' : 'pass',
    summary: failedCommand
      ? `Fake dispatch ${record.dispatchId} hit command failure: ${failedCommand.command}`
      : `Fake dispatch ${record.dispatchId} produced a deterministic local diff for review.`,
    limitations: [
      'Local fake runtime receipt only.',
      'receiptVerified=false, authorityChanged=false, productionDone=false.',
      ...warnings,
    ],
  };
}

function leafDispatchCollection(root: string, record: DispatchRecord, pack: HandoffPack): DispatchCollection {
  const warnings = [...record.warnings];
  const transcriptExists = existsSync(resolve(root, record.transcriptFile));
  const commands = maybeReadJson<Array<{ command: string; ok: boolean; output: string }>>(resolve(root, record.collectFile.replace(/collect\.json$/, 'command-results.json')))
    ?.map(result => result.command)
    ?? [];
  let headSha: string | undefined;
  let changedFiles: string[] = [];
  let freshness: DispatchCollection['freshness'] = 'unknown';
  const worktreeAbs = resolve(root, record.worktree.worktreePath);
  if (existsSync(worktreeAbs)) {
    try {
      headSha = currentGitHead(worktreeAbs);
      if (pack.baseSha) {
        changedFiles = changedFilesBetween(root, pack.baseSha, headSha);
        freshness = checkEvidenceFreshnessForGit(root, pack.baseSha).fresh ? 'fresh' : 'stale';
      } else {
        freshness = 'unknown';
        warnings.push('Pack is missing baseSha, so freshness is unknown.');
      }
    } catch (error: any) {
      warnings.push(String(error?.message || error));
    }
  } else {
    warnings.push(`Worktree missing: ${record.worktree.worktreePath}`);
  }
  const limitations = [
    ...(transcriptExists ? [] : ['Transcript placeholder is missing.']),
    ...(changedFiles.length > 0 ? [] : ['No git-derived changedFiles detected.']),
  ];
  return {
    schemaVersion: 'lattice.dispatch_collect.v1',
    dispatchId: record.dispatchId,
    storyId: record.storyId,
    host: record.selectedHost,
    status: resolveEffectiveStatus(record),
    ...(pack.baseSha ? { baseSha: pack.baseSha } : {}),
    ...(headSha ? { headSha } : {}),
    freshness,
    changedFiles,
    commands,
    transcriptExists,
    warnings,
    limitations,
    workers: [],
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
  };
}

function aggregateStatus(statuses: DispatchLifecycleStatus[]): DispatchLifecycleStatus {
  if (statuses.length === 0) return 'diagnostic';
  const first = statuses[0];
  if (statuses.every(status => status === first)) return first;
  if (statuses.some(status => status === 'running')) return 'running';
  if (statuses.some(status => status === 'needs_receipt')) return 'needs_receipt';
  if (statuses.some(status => status === 'prepared')) return 'prepared';
  if (statuses.some(status => status === 'planned')) return 'planned';
  return 'diagnostic';
}

type CollectDispatchOptions = {
  persist?: boolean;
};

function aggregateWorkerCollections(root: string, record: DispatchRecord, options: CollectDispatchOptions = {}): DispatchCollection {
  const workers = record.workerIds.map(workerId => collectDispatch(root, workerId, options));
  return {
    schemaVersion: 'lattice.dispatch_collect.v1',
    dispatchId: record.dispatchId,
    storyId: record.storyId,
    host: record.selectedHost,
    status: aggregateStatus(workers.map(worker => worker.status)),
    freshness: workers.every(worker => worker.freshness === 'fresh')
      ? 'fresh'
      : workers.some(worker => worker.freshness === 'stale')
        ? 'stale'
        : 'unknown',
    changedFiles: [...new Set(workers.flatMap(worker => worker.changedFiles))].sort(),
    commands: [...new Set(workers.flatMap(worker => worker.commands))],
    transcriptExists: workers.every(worker => worker.transcriptExists),
    warnings: workers.flatMap(worker => worker.warnings),
    limitations: workers.flatMap(worker => worker.limitations),
    workers,
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
  };
}

export function planDispatch(store: StoryStore, root: string, args: DispatchPlanArgs): DispatchPlanResult {
  return computePlan(store, root, args);
}

export function prepareDispatch(store: StoryStore, root: string, args: DispatchPrepareArgs): DispatchRecord {
  const requestedDispatchId = args.dispatchId?.trim() ? normalizeDispatchId(args.dispatchId) : undefined;
  const plan = computePlan(store, root, args);
  const dispatchId = requestedDispatchId ?? createDispatchId(args.storyId, plan.selectedHost);
  ensureDispatchDir(root, dispatchId);
  const pack = buildPack(store, root, args, plan.selectedHost, dispatchId);
  writePack(root, dispatchId, pack);
  const worktree = buildHandoffWorktreeProjection(pack);
  const promptFile = dispatchFile(root, dispatchId, 'prompt.md');
  const transcriptFile = dispatchFile(root, dispatchId, 'transcript.log');
  writeFileSync(promptFile, dispatchPrompt(pack, plan.runtime, dispatchId), 'utf8');
  if (!existsSync(transcriptFile)) writeFileSync(transcriptFile, '', 'utf8');
  const record: DispatchRecord = {
    schemaVersion: 'lattice.dispatch_record.v1',
    dispatchId,
    storyId: args.storyId,
    requestedHost: args.host?.trim() || 'auto',
    selectedHost: plan.selectedHost,
    status: plan.status === 'unavailable' ? 'unavailable' : 'prepared',
    parallel: Math.max(1, args.parallel ?? 1),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    expiresAt: plusHoursIso(24),
    runtime: plan.runtime,
    warnings: [...plan.warnings],
    nextAction: plan.nextAction,
    packFile: relative(root, dispatchFile(root, dispatchId, 'pack.json')),
    statusFile: relative(root, dispatchFile(root, dispatchId, 'dispatch.json')),
    promptFile: relative(root, promptFile),
    transcriptFile: relative(root, transcriptFile),
    collectFile: relative(root, dispatchFile(root, dispatchId, 'collect.json')),
    receiptFile: relative(root, dispatchFile(root, dispatchId, 'receipt.json')),
    receiptSubmissionFile: relative(root, dispatchFile(root, dispatchId, 'receipt-submit.json')),
    worktree: {
      branch: worktree.branch,
      worktreePath: worktree.worktreePath,
      reviewCommand: worktree.reviewCommand,
      cleanupCommand: worktree.cleanupCommand,
    },
    workerIds: [],
    ...(requestedDispatchId ? { parentDispatchId: requestedDispatchId } : {}),
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
  };
  return writeRecord(root, record);
}

function runFakeLeafDispatch(store: StoryStore, root: string, record: DispatchRecord): DispatchRunResult {
  let pack = readPack(root, record.dispatchId);
  pack = ensurePreparedPackForFake(root, record.dispatchId, pack);
  const projectedWorktreeAbs = resolve(root, record.worktree.worktreePath);
  pack = normalizePackPaths(root, record.dispatchId, projectedWorktreeAbs, pack);
  const baseRef = pack.baseSha ?? 'HEAD';
  const worktreeAbs = ensureWorktree(root, record.worktree.worktreePath, record.worktree.branch, baseRef);
  pack = normalizePackPaths(root, record.dispatchId, worktreeAbs, pack, 'canonical');
  const markerPath = pack.allowedPaths[0] ?? `.koala/dispatches/${record.dispatchId}/worker/fake-result.txt`;
  const safeMarkerPath = assertCanonicalWorktreePath(worktreeAbs, markerPath, 'fake dispatch marker');
  const markerAbs = resolve(worktreeAbs, safeMarkerPath);
  mkdirSync(dirname(markerAbs), { recursive: true });
  writeFileSync(markerAbs, `dispatch=${record.dispatchId}\nstory=${record.storyId}\nrunAt=${nowIso()}\n`, 'utf8');
  appendTranscript(resolve(root, record.transcriptFile), [
    `[${nowIso()}] fake runtime prepared ${safeMarkerPath}`,
  ]);
  const commandResults = runRequiredCommands(worktreeAbs, pack.requiredCommands);
  appendTranscript(resolve(root, record.transcriptFile), commandResults.map(result => (
    `[${nowIso()}] command ${result.ok ? 'ok' : 'fail'} ${result.command}${result.output ? ` :: ${result.output}` : ''}`
  )));
  writeJson(resolve(root, record.collectFile.replace(/collect\.json$/, 'command-results.json')), commandResults);
  gitOutput(worktreeAbs, ['add', '-f', safeMarkerPath]);
  const commitMessage = `fake dispatch ${record.dispatchId}`;
  try {
    gitOutput(worktreeAbs, ['commit', '-m', commitMessage]);
  } catch {
    gitOutput(worktreeAbs, ['commit', '--allow-empty', '-m', `${commitMessage} (empty)`]);
  }
  const headSha = currentGitHead(worktreeAbs);
  if (!headSha) {
    throw new Error(`fake dispatch ${record.dispatchId} could not resolve HEAD after commit`);
  }
  const changedFiles = pack.baseSha ? changedFilesBetween(root, pack.baseSha, headSha) : [safeMarkerPath];
  const commandWarnings = commandResults.filter(result => !result.ok).map(result => `command failed: ${result.command}`);
  const receipt = createFakeReceipt(pack, record, headSha, changedFiles, commandResults, commandWarnings);
  writeJson(resolve(root, record.receiptFile), receipt);
  const submission = submitHandoffReceipt(root, receipt);
  writeJson(resolve(root, record.receiptSubmissionFile), submission);
  const collection = leafDispatchCollection(root, {
    ...record,
    latestHeadSha: headSha,
    warnings: [...record.warnings, ...commandWarnings],
  }, pack);
  writeJson(resolve(root, record.collectFile), collection);
  const nextStatus: DispatchLifecycleStatus =
    submission.status === 'accepted-local'
      ? 'accepted_local'
      : receipt.verdict === 'fail'
        ? 'failed'
        : 'diagnostic';
  const nextAction = submission.status === 'accepted-local'
    ? 'Fake dispatch completed. Review the isolated overflow diff and receipt manually before any merge.'
    : submission.nextAction;
  writeRecord(root, {
    ...record,
    status: nextStatus,
    latestHeadSha: headSha,
    warnings: [...record.warnings, ...commandWarnings, ...submission.warnings],
    nextAction,
  });
  return {
    schemaVersion: 'lattice.dispatch_run.v1',
    dispatchId: record.dispatchId,
    storyId: record.storyId,
    host: 'fake',
    status: nextStatus,
    parallel: 1,
    runtime: record.runtime,
    workers: [],
    receipt: submission,
    warnings: [...record.warnings, ...commandWarnings, ...submission.warnings],
    nextAction,
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
  };
}

function childDispatchArgs(parentPack: HandoffPack, parent: DispatchRecord, workerIndex: number): DispatchPrepareArgs {
  const childId = `${parent.dispatchId}-w${workerIndex + 1}`;
  return {
    storyId: parent.storyId,
    host: 'fake',
    fromHost: parentPack.fromHost,
    role: parentPack.role ? `${parentPack.role}-worker-${workerIndex + 1}` : `worker-${workerIndex + 1}`,
    objective: parentPack.objective ? `${parentPack.objective} (worker ${workerIndex + 1})` : `Worker ${workerIndex + 1}`,
    allowedPaths: parentPack.allowedPaths.length > workerIndex
      ? [parentPack.allowedPaths[workerIndex]]
      : [`.koala/dispatches/${childId}/worker/fake-result.txt`],
    deniedPaths: [...parentPack.deniedPaths],
    requiredCommands: [...parentPack.requiredCommands],
    successCriteria: [...parentPack.successCriteria],
    baseSha: parentPack.baseSha,
    packId: `${parentPack.packId}-w${workerIndex + 1}`,
    authorityBoundary: parentPack.authorityBoundary.summary,
    executionInstructions: [...parentPack.executionInstructions],
    dispatchId: childId,
    parallel: 1,
  };
}

export function runDispatch(store: StoryStore, root: string, args: DispatchRunArgs): DispatchRunResult {
  const requestedDispatchId = args.dispatchId?.trim() ? normalizeDispatchId(args.dispatchId) : undefined;
  const existing = requestedDispatchId ? readRecord(root, requestedDispatchId) : null;
  const record = existing ?? prepareDispatch(store, root, args);
  if (resolveEffectiveStatus(record) === 'expired') {
    const expired = writeRecord(root, { ...record, status: 'expired', nextAction: 'Dispatch expired. Run dispatch_resume to refresh metadata and rerun it.' });
    return {
      schemaVersion: 'lattice.dispatch_run.v1',
      dispatchId: expired.dispatchId,
      storyId: expired.storyId,
      host: expired.selectedHost,
      status: 'expired',
      parallel: expired.parallel,
      runtime: expired.runtime,
      workers: [],
      warnings: [...expired.warnings],
      nextAction: expired.nextAction,
      authorityChanged: false,
      receiptVerified: false,
      productionDone: false,
    };
  }

  if (record.selectedHost === 'fake' && record.parallel > 1 && record.workerIds.length === 0) {
    const pack = readPack(root, record.dispatchId);
    const workers: DispatchRunResult[] = [];
    const workerIds: string[] = [];
    for (let index = 0; index < record.parallel; index += 1) {
      const childArgs = childDispatchArgs(pack, record, index);
      const childRecord = prepareDispatch(store, root, { ...childArgs });
      workerIds.push(childRecord.dispatchId);
      workers.push(runFakeLeafDispatch(store, root, childRecord));
    }
    const aggregate = aggregateStatus(workers.map(worker => worker.status));
    const warnings = workers.flatMap(worker => worker.warnings);
    const nextAction = aggregate === 'accepted_local'
      ? 'All fake workers completed with local accepted receipts. Review each isolated worker diff manually before any merge.'
      : 'At least one fake worker did not complete cleanly. Review worker receipts/status before attempting merge guidance.';
    const updated = writeRecord(root, {
      ...record,
      status: aggregate,
      workerIds,
      warnings: [...record.warnings, ...warnings],
      nextAction,
    });
    return {
      schemaVersion: 'lattice.dispatch_run.v1',
      dispatchId: updated.dispatchId,
      storyId: updated.storyId,
      host: 'fake',
      status: aggregate,
      parallel: updated.parallel,
      runtime: updated.runtime,
      workers,
      warnings: [...updated.warnings],
      nextAction: updated.nextAction,
      authorityChanged: false,
      receiptVerified: false,
      productionDone: false,
    };
  }

  if (record.selectedHost === 'fake') {
    return runFakeLeafDispatch(store, root, record);
  }

  const runtime = record.runtime;
  if (!runtime.available) {
    const updated = writeRecord(root, {
      ...record,
      status: 'unavailable',
      nextAction: runtime.nextAction,
      warnings: [...record.warnings, ...runtime.warnings],
    });
    return {
      schemaVersion: 'lattice.dispatch_run.v1',
      dispatchId: updated.dispatchId,
      storyId: updated.storyId,
      host: updated.selectedHost,
      status: updated.status,
      parallel: updated.parallel,
      runtime: updated.runtime,
      workers: [],
      warnings: [...updated.warnings],
      nextAction: updated.nextAction,
      authorityChanged: false,
      receiptVerified: false,
      productionDone: false,
    };
  }
  let pack = readPack(root, record.dispatchId);
  pack = normalizePackPaths(root, record.dispatchId, resolve(root, record.worktree.worktreePath), pack);
  const baseRef = pack.baseSha ?? 'HEAD';
  const worktreeAbsPath = resolve(root, record.worktree.worktreePath);
  const worktreeCreatedThisRun = !existsSync(worktreeAbsPath);
  let worktreeAbs: string;
  try {
    worktreeAbs = ensureWorktree(root, record.worktree.worktreePath, record.worktree.branch, baseRef);
  } catch (error: any) {
    const detail = String(error?.message || error).trim();
    appendTranscript(resolve(root, record.transcriptFile), [
      `[${nowIso()}] scaffolded runtime ${runtime.host} failed to create worktree`,
      detail,
    ]);
    const warnings = [...record.warnings, ...runtime.warnings, `Worktree creation failed: ${detail}`];
    const nextAction = `Dispatch scaffold could not create ${record.worktree.worktreePath}. Resolve the git worktree error, then rerun dispatch_run for ${record.dispatchId}.`;
    const failed = writeRecord(root, {
      ...record,
      status: 'failed',
      warnings,
      nextAction,
    });
    return {
      schemaVersion: 'lattice.dispatch_run.v1',
      dispatchId: failed.dispatchId,
      storyId: failed.storyId,
      host: failed.selectedHost,
      status: failed.status,
      parallel: failed.parallel,
      runtime: failed.runtime,
      workers: [],
      warnings: [...failed.warnings],
      nextAction: failed.nextAction,
      authorityChanged: false,
      receiptVerified: false,
      productionDone: false,
      };
  }
  try {
    pack = normalizePackPaths(root, record.dispatchId, worktreeAbs, pack, 'canonical');
  } catch (error: any) {
    const detail = String(error?.message || error).trim();
    const cleanupWarnings = worktreeCreatedThisRun
      ? cleanupCreatedWorktree(root, record.worktree.worktreePath, record.worktree.branch)
      : [];
    appendTranscript(resolve(root, record.transcriptFile), [
      `[${nowIso()}] scaffolded runtime ${runtime.host} canonical pack-path validation failed`,
      detail,
      ...cleanupWarnings.map(warning => `[${nowIso()}] ${warning}`),
    ]);
    const warnings = [
      ...record.warnings,
      ...runtime.warnings,
      `Canonical pack-path validation failed: ${detail}`,
      ...cleanupWarnings,
    ];
    const nextAction = worktreeCreatedThisRun
      ? `Dispatch scaffold was rolled back after canonical pack-path validation failed. Fix the allowed/denied paths for ${record.dispatchId}, then rerun dispatch_run.`
      : `Canonical pack-path validation failed for ${record.dispatchId}. Fix the allowed/denied paths, verify the existing worktree at ${record.worktree.worktreePath}, then rerun dispatch_run.`;
    const failed = writeRecord(root, {
      ...record,
      status: 'failed',
      warnings,
      nextAction,
    });
    return {
      schemaVersion: 'lattice.dispatch_run.v1',
      dispatchId: failed.dispatchId,
      storyId: failed.storyId,
      host: failed.selectedHost,
      status: failed.status,
      parallel: failed.parallel,
      runtime: failed.runtime,
      workers: [],
      warnings: [...failed.warnings],
      nextAction: failed.nextAction,
      authorityChanged: false,
      receiptVerified: false,
      productionDone: false,
    };
  }
  const promptFile = resolve(root, record.promptFile);
  const invocation = runtime.invocationTemplate?.map(part =>
    part === '<prompt-file>' ? promptFile : part === '<worktree>' ? record.worktree.worktreePath : part,
  ) ?? [];
  appendTranscript(resolve(root, record.transcriptFile), [
    `[${nowIso()}] scaffolded runtime ${runtime.host}`,
    `[${nowIso()}] worktree ready ${record.worktree.worktreePath} (${worktreeAbs})`,
    invocation.length > 0 ? invocation.join(' ') : '(no invocation template)',
  ]);
  const status: DispatchLifecycleStatus = 'needs_receipt';
  const nextAction = `Manual-first only. Worktree is ready at ${record.worktree.worktreePath}. Run ${invocation.join(' ')} there, then return a local receipt via dispatch_collect/dispatch_receipt_create.`;
  const updated = writeRecord(root, {
    ...record,
    status,
    nextAction,
    warnings: [...record.warnings, ...runtime.warnings],
  });
  return {
    schemaVersion: 'lattice.dispatch_run.v1',
    dispatchId: updated.dispatchId,
    storyId: updated.storyId,
    host: updated.selectedHost,
    status,
    parallel: updated.parallel,
    runtime: updated.runtime,
    workers: [],
    warnings: [...updated.warnings],
    nextAction,
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
  };
}

export function collectDispatch(root: string, dispatchId: string, options: CollectDispatchOptions = {}): DispatchCollection {
  const record = readRecord(root, dispatchId);
  if (record.workerIds.length > 0) {
    const aggregate = aggregateWorkerCollections(root, record, options);
    if (options.persist !== false) writeJson(resolve(root, record.collectFile), aggregate);
    return aggregate;
  }
  const pack = readPack(root, dispatchId);
  const result = leafDispatchCollection(root, record, pack);
  if (options.persist !== false) writeJson(resolve(root, record.collectFile), result);
  return result;
}

export function createDispatchReceipt(root: string, dispatchId: string): DispatchReceiptDraft {
  const record = readRecord(root, dispatchId);
  if (record.workerIds.length > 0) {
    throw new Error(`dispatch_receipt_create only supports leaf dispatches. ${dispatchId} is a parent dispatch; inspect workerIds instead.`);
  }
  const pack = readPack(root, dispatchId);
  const collection = collectDispatch(root, dispatchId);
  const warnings = [...collection.warnings];
  const receipt: HandoffReceipt = {
    schemaVersion: 'lattice.handoff_receipt.v1',
    storyId: record.storyId,
    host: dispatchReceiptHost(record, pack),
    packId: pack.packId,
    packHash: pack.packHash,
    fromHost: pack.fromHost,
    toHost: pack.toHost,
    ...(pack.baseSha ? { baseSha: pack.baseSha } : {}),
    ...(pack.role ? { role: pack.role } : {}),
    ...(pack.objective ? { objective: pack.objective } : {}),
    allowedPaths: [...pack.allowedPaths],
    deniedPaths: [...pack.deniedPaths],
    requiredCommands: [...pack.requiredCommands],
    successCriteria: [...pack.successCriteria],
    authorityBoundary: pack.authorityBoundary,
    executionInstructions: [...pack.executionInstructions],
    headSha: collection.headSha ?? '',
    changedFiles: [...collection.changedFiles],
    commands: [...collection.commands],
    verdict: collection.changedFiles.length > 0 ? 'pass' : 'warn',
    summary: `Dispatch ${dispatchId} draft receipt generated from git-derived collect data.`,
    limitations: [
      ...collection.limitations,
      'Draft receipt only: receiptVerified=false, authorityChanged=false, productionDone=false.',
    ],
  };
  writeJson(resolve(root, record.receiptFile), receipt);
  return {
    schemaVersion: 'lattice.dispatch_receipt_create.v1',
    dispatchId,
    status: collection.changedFiles.length > 0 ? 'created' : 'diagnostic',
    receipt,
    warnings,
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
  };
}

function maybeReadReceiptSubmission(root: string, record: DispatchRecord): HandoffReceiptSubmission | undefined {
  return maybeReadJson<HandoffReceiptSubmission>(resolve(root, record.receiptSubmissionFile));
}

export function dispatchStatus(root: string, dispatchId: string): DispatchStatusResult {
  const record = readRecord(root, dispatchId);
  const effectiveStatus = resolveEffectiveStatus(record);
  const current = effectiveStatus === record.status ? record : { ...record, status: effectiveStatus };
  return {
    schemaVersion: 'lattice.dispatch_status.v1',
    dispatch: current,
    receipt: maybeReadReceiptSubmission(root, current),
    workers: current.workerIds.map(workerId => dispatchStatus(root, workerId)),
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
  };
}

export function listDispatches(root: string, storyId?: string): DispatchListResult {
  const storageRoot = dispatchStorageRoot(root);
  if (!existsSync(storageRoot)) {
    return {
      schemaVersion: 'lattice.dispatch_list.v1',
      dispatches: [],
      authorityChanged: false,
      receiptVerified: false,
      productionDone: false,
    };
  }
  const dispatches = readdirSync(storageRoot)
    .filter(entry => existsSync(join(storageRoot, entry, 'dispatch.json')))
    .map(entry => readRecord(root, entry))
    .filter(record => !storyId || record.storyId === storyId)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .map(record => ({
      dispatchId: record.dispatchId,
      storyId: record.storyId,
      host: record.selectedHost,
      status: resolveEffectiveStatus(record),
      parallel: record.parallel,
      updatedAt: record.updatedAt,
    }));
  return {
    schemaVersion: 'lattice.dispatch_list.v1',
    dispatches,
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
  };
}

export function resumeDispatch(store: StoryStore, root: string, dispatchId: string): DispatchRunResult {
  const record = readRecord(root, dispatchId);
  if (record.status === 'cancelled') {
    const resumed = writeRecord(root, { ...record, status: 'prepared', cancelledAt: undefined, nextAction: 'Dispatch resumed. Rerun dispatch_run to continue.' });
    return runDispatch(store, root, { dispatchId: resumed.dispatchId, storyId: resumed.storyId, host: resumed.selectedHost });
  }
  return runDispatch(store, root, { dispatchId: record.dispatchId, storyId: record.storyId, host: record.selectedHost });
}

export function cancelDispatch(root: string, dispatchId: string): DispatchStatusResult {
  const record = readRecord(root, dispatchId);
  const updated = writeRecord(root, {
    ...record,
    status: 'cancelled',
    cancelledAt: nowIso(),
    nextAction: 'Dispatch cancelled. Review or clean up the isolated worktree manually; no authority state changed.',
  });
  return dispatchStatus(root, updated.dispatchId);
}

export function reviewDispatch(root: string, dispatchId: string): DispatchReviewResult {
  const status = dispatchStatus(root, dispatchId);
  const receipt = status.receipt;
  if (status.dispatch.workerIds.length > 0) {
    const workers = status.workers.map(worker => reviewDispatch(root, worker.dispatch.dispatchId));
    const warnings = workers.flatMap(worker => worker.warnings);
    const risks = workers.flatMap(worker => worker.risks);
    return {
      schemaVersion: 'lattice.dispatch_review.v1',
      dispatchId,
      storyId: status.dispatch.storyId,
      status: aggregateStatus(workers.map(worker => worker.status)),
      changedFiles: [...new Set(workers.flatMap(worker => worker.changedFiles))].sort(),
      workers,
      warnings,
      risks,
      nextAction: status.dispatch.status === 'accepted_local'
        ? 'Parallel dispatch review is ready. Inspect each worker receipt and diff manually before merge planning.'
        : 'Parallel dispatch review found non-accepted workers. Resolve warnings before merge planning.',
      authorityChanged: false,
      receiptVerified: false,
      productionDone: false,
    };
  }
  const collection = collectDispatch(root, dispatchId, { persist: false });
  const risks = [
    ...(status.dispatch.status === 'accepted_local' ? [] : [`dispatch status=${status.dispatch.status}`]),
    ...(receipt?.status === 'accepted-local' ? [] : ['receipt is diagnostic-only or missing']),
    ...(collection.changedFiles.length > 0 ? [] : ['no git-derived changedFiles collected']),
  ];
  return {
    schemaVersion: 'lattice.dispatch_review.v1',
    dispatchId,
    storyId: status.dispatch.storyId,
    status: status.dispatch.status,
    changedFiles: collection.changedFiles,
    ...(receipt ? { receipt } : {}),
    workers: [],
    warnings: [...status.dispatch.warnings, ...collection.warnings, ...(receipt?.warnings ?? [])],
    risks,
    nextAction: status.dispatch.status === 'accepted_local'
      ? 'Review the isolated overflow diff and local receipt manually; merge remains manual-only.'
      : status.dispatch.nextAction,
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
  };
}

export function buildDispatchMergePlan(root: string, dispatchId: string): DispatchMergePlanResult {
  const status = dispatchStatus(root, dispatchId);
  const workers = status.dispatch.workerIds.length > 0
    ? status.workers.map(worker => ({
      dispatchId: worker.dispatch.dispatchId,
      status: worker.dispatch.status,
      reviewCommand: worker.dispatch.worktree.reviewCommand,
      cleanupCommand: worker.dispatch.worktree.cleanupCommand,
    }))
    : [{
      dispatchId: status.dispatch.dispatchId,
      status: status.dispatch.status,
      reviewCommand: status.dispatch.worktree.reviewCommand,
      cleanupCommand: status.dispatch.worktree.cleanupCommand,
    }];
  const mergeable = workers.every(worker => worker.status === 'accepted_local');
  const commands = mergeable
    ? workers.flatMap(worker => [`${worker.reviewCommand}`, `${worker.cleanupCommand}`])
    : [];
  return {
    schemaVersion: 'lattice.dispatch_merge_plan.v1',
    dispatchId,
    storyId: status.dispatch.storyId,
    status: status.dispatch.status,
    mergeable,
    manualOnly: true,
    workers,
    commands,
    warnings: mergeable
      ? ['Manual merge only: review each isolated worker diff and cherry-pick/merge by hand if accepted.']
      : ['Normal merge guidance is withheld because the dispatch is not accepted_local across all required workers.'],
    nextAction: mergeable
      ? 'Manual merge only. Review diffs, receipt diagnostics, and required command output before merging anything back.'
      : status.dispatch.nextAction,
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
  };
}

export function overflowAuto(
  store: StoryStore,
  root: string,
  args: DispatchRunArgs & { approve?: boolean; start?: boolean },
): DispatchPlanResult | DispatchRunResult {
  const plan = computePlan(store, root, { ...args, host: args.host ?? 'auto' });
  if (args.start === true && args.approve === true) {
    return runDispatch(store, root, {
      ...args,
      host: plan.selectedHost,
    });
  }
  const gatingWarning = args.start === true
    ? 'overflow_auto received start=true without approve=true; staying in suggest-only mode.'
    : args.approve === true
      ? 'overflow_auto received approve=true without start=true; staying in suggest-only mode.'
      : 'overflow_auto defaulted to suggest-only mode; no host was started.';
  return {
    ...plan,
    warnings: [
      ...plan.warnings,
      gatingWarning,
    ],
    nextAction: plan.selectedHost === 'fake'
      ? 'Run overflow_auto --approve=true --start=true or dispatch_run --host=fake to execute the deterministic local harness.'
      : 'Review the suggested host and rerun with --approve=true --start=true if you want to materialize dispatch metadata.',
  };
}

function summaryLine(record: DispatchRecord): string {
  return `${record.dispatchId} ${record.storyId} host=${record.selectedHost} status=${record.status} parallel=${record.parallel}`;
}

export function renderHostRuntimeListText(result: HostRuntimeList): string {
  return [
    `Host runtime list (${result.schemaVersion})`,
    ...result.runtimes.map(runtime => `${runtime.host}: ${runtime.status} — ${runtime.nextAction}`),
  ].join('\n');
}

export function renderHostRuntimeProbeText(result: HostRuntimeProbe): string {
  const lines = [
    `Host runtime probe (${result.schemaVersion})`,
    `host: ${result.host}`,
    `requestedHost: ${result.requestedHost}`,
    `status: ${result.status}`,
    `available: ${result.available}`,
    `supportsParallel: ${result.supportsParallel}`,
    `nextAction: ${result.nextAction}`,
  ];
  if (result.warnings.length > 0) {
    lines.push('', 'warnings:');
    lines.push(...result.warnings.map(warning => `  - ${warning}`));
  }
  return lines.join('\n');
}

export function renderDispatchPlanText(result: DispatchPlanResult): string {
  const lines = [
    `Dispatch plan (${result.schemaVersion})`,
    `storyId: ${result.storyId}`,
    `requestedHost: ${result.requestedHost}`,
    `selectedHost: ${result.selectedHost}`,
    `status: ${result.status}`,
    `parallel: ${result.parallel}`,
    `packId: ${result.pack.packId}`,
    `packHash: ${result.pack.packHash}`,
    `worktreePath: ${result.worktree.worktreePath}`,
    `branch: ${result.worktree.branch}`,
    `nextAction: ${result.nextAction}`,
  ];
  if (result.warnings.length > 0) {
    lines.push('', 'warnings:');
    lines.push(...result.warnings.map(warning => `  - ${warning}`));
  }
  return lines.join('\n');
}

export function renderDispatchRecordText(record: DispatchRecord): string {
  return [
    `Dispatch prepare (${record.schemaVersion})`,
    summaryLine(record),
    `nextAction: ${record.nextAction}`,
    `packFile: ${record.packFile}`,
    `statusFile: ${record.statusFile}`,
    `promptFile: ${record.promptFile}`,
    `transcriptFile: ${record.transcriptFile}`,
  ].join('\n');
}

export function renderDispatchRunText(result: DispatchRunResult): string {
  const lines = [
    `Dispatch run (${result.schemaVersion})`,
    `dispatchId: ${result.dispatchId}`,
    `storyId: ${result.storyId}`,
    `host: ${result.host}`,
    `status: ${result.status}`,
    `parallel: ${result.parallel}`,
    `nextAction: ${result.nextAction}`,
  ];
  if (result.receipt) {
    lines.push(`receipt.status: ${result.receipt.status}`);
  }
  if (result.workers.length > 0) {
    lines.push('', 'workers:');
    lines.push(...result.workers.map(worker => `  - ${worker.dispatchId}: ${worker.status}`));
  }
  if (result.warnings.length > 0) {
    lines.push('', 'warnings:');
    lines.push(...result.warnings.map(warning => `  - ${warning}`));
  }
  return lines.join('\n');
}

export function renderDispatchCollectionText(result: DispatchCollection): string {
  const lines = [
    `Dispatch collect (${result.schemaVersion})`,
    `dispatchId: ${result.dispatchId}`,
    `storyId: ${result.storyId}`,
    `status: ${result.status}`,
    `freshness: ${result.freshness}`,
    `changedFiles: ${result.changedFiles.length}`,
  ];
  if (result.workers.length > 0) {
    lines.push('', 'workers:');
    lines.push(...result.workers.map(worker => `  - ${worker.dispatchId}: ${worker.status}`));
  }
  if (result.warnings.length > 0) {
    lines.push('', 'warnings:');
    lines.push(...result.warnings.map(warning => `  - ${warning}`));
  }
  return lines.join('\n');
}

export function renderDispatchReceiptDraftText(result: DispatchReceiptDraft): string {
  return [
    `Dispatch receipt create (${result.schemaVersion})`,
    `dispatchId: ${result.dispatchId}`,
    `status: ${result.status}`,
    `packId: ${result.receipt.packId}`,
    `packHash: ${result.receipt.packHash}`,
    `changedFiles: ${result.receipt.changedFiles.length}`,
  ].join('\n');
}

export function renderDispatchStatusText(result: DispatchStatusResult): string {
  const lines = [
    `Dispatch status (${result.schemaVersion})`,
    summaryLine(result.dispatch),
    `nextAction: ${result.dispatch.nextAction}`,
  ];
  if (result.receipt) {
    lines.push(`receipt.status: ${result.receipt.status}`);
  }
  if (result.workers.length > 0) {
    lines.push('', 'workers:');
    lines.push(...result.workers.map(worker => `  - ${worker.dispatch.dispatchId}: ${worker.dispatch.status}`));
  }
  return lines.join('\n');
}

export function renderDispatchListText(result: DispatchListResult): string {
  return [
    `Dispatch list (${result.schemaVersion})`,
    ...(result.dispatches.length > 0
      ? result.dispatches.map(dispatch => `${dispatch.dispatchId} ${dispatch.storyId} ${dispatch.host} ${dispatch.status}`)
      : ['(none)']),
  ].join('\n');
}

export function renderDispatchReviewText(result: DispatchReviewResult): string {
  const lines = [
    `Dispatch review (${result.schemaVersion})`,
    `dispatchId: ${result.dispatchId}`,
    `storyId: ${result.storyId}`,
    `status: ${result.status}`,
    `changedFiles: ${result.changedFiles.length}`,
    `nextAction: ${result.nextAction}`,
  ];
  if (result.workers.length > 0) {
    lines.push('', 'workers:');
    lines.push(...result.workers.map(worker => `  - ${worker.dispatchId}: ${worker.status}`));
  }
  if (result.warnings.length > 0) {
    lines.push('', 'warnings:');
    lines.push(...result.warnings.map(warning => `  - ${warning}`));
  }
  return lines.join('\n');
}

export function renderDispatchMergePlanText(result: DispatchMergePlanResult): string {
  const lines = [
    `Dispatch merge plan (${result.schemaVersion})`,
    `dispatchId: ${result.dispatchId}`,
    `storyId: ${result.storyId}`,
    `status: ${result.status}`,
    `mergeable: ${result.mergeable}`,
    `manualOnly: ${result.manualOnly}`,
    `nextAction: ${result.nextAction}`,
  ];
  if (result.commands.length > 0) {
    lines.push('', 'commands:');
    lines.push(...result.commands.map(command => `  - ${command}`));
  }
  if (result.warnings.length > 0) {
    lines.push('', 'warnings:');
    lines.push(...result.warnings.map(warning => `  - ${warning}`));
  }
  return lines.join('\n');
}
