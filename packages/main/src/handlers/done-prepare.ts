import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import type { HandlerContext } from './context.js';
import { assertCwdInWorktree } from './context.js';
import { createChecklistHandlers } from './checklist.js';
import { buildDoneClosureRunbook, type DoneClosureRunbook } from './done-closure.js';
import { createDoneRequiredValidationHandlers } from './done-required-validation.js';
import { createVerifierHandlers } from './verifier.js';
import { loadConfig } from '../core/config.js';
import { resolveDoneRequiredPolicy } from '../core/done-required-validation.js';
import { checkEvidenceFreshnessForGit, currentGitHead, currentMaterialHash, currentStoryFilesHash, isStoryMetadataPath } from '../core/evidence-freshness.js';
import { buildVerificationCoverage } from '../core/verification.js';
import {
  classifyGitStatusRows,
  dirtyWorktreeClassifierOptionsForStory,
  parseGitPorcelainRow,
  type DirtyWorktreeClassification,
  type DirtyWorktreeEntry,
} from '../core/dirty-worktree.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import { renderMemoryFreshnessPackSummary } from '../core/playbook-runtime-memory.js';

type StepStatus = 'pending' | 'skipped' | 'pass' | 'blocked';
type StepId =
  | 'preflight'
  | 'mergeMain'
  | 'staleEvidenceRefresh'
  | 'validate'
  | 'doneClosure'
  | 'worktreeVersionCheck'
  | 'runtimeChange'
  | 'cleanTree';

interface DonePrepareArgs {
  storyId: string;
  mergeMain?: boolean;
  refreshStale?: boolean;
  validate?: boolean;
  build?: boolean;
  dryRun?: boolean;
}

interface DonePrepareStep {
  id: StepId;
  status: StepStatus;
  reason?: string;
  command?: string;
}

interface DonePrepareBlocked {
  blockedAt: StepId | 'evidenceFreshness';
  reason: string;
  next: string;
  currentBinding?: DonePrepareCurrentBinding;
  files?: string[];
  commits?: string[];
  commands?: string[];
  steps: DonePrepareStep[];
}

interface DonePrepareCurrentBinding {
  currentHead?: string;
  currentMaterialHash?: string;
  currentStoryFilesHash?: string;
}

interface StaleEvidencePlan {
  dryRunTranscript: string;
  staleCount: number;
  safeRefresh: Array<{ intentRef: string; subject: string }>;
  rerunRequired: Array<{ intentRef: string; command: string }>;
}

interface RuntimeChangeReport {
  postDoneRuntimeVersionBumpRequired: boolean;
  changedFiles: string[];
  runtimeFiles: string[];
  docsOnly: boolean;
  postDoneVersionState: 'consistent' | 'inconsistent' | 'unknown';
  versionSources: Record<string, string>;
  versionMismatches: string[];
}

const VERSION_SOURCE_FILES = [
  'package.json',
  'package-lock.json',
  'packages/main/package.json',
  'packages/main/package-lock.json',
  'packages/main/src/core/lattice-brand.ts',
] as const;

const RUNTIME_PREFIXES = [
  'packages/main/src/core/',
  'packages/main/src/handlers/',
  'packages/main/src/tasks/',
  'packages/main/src/cli/',
  'bin/',
] as const;

const RUNTIME_FILES = new Set([
  'packages/main/src/cli.ts',
  'packages/main/src/index.ts',
  'packages/main/src/registry.ts',
  'packages/main/src/cli-engine.ts',
]);

function defaulted(args: DonePrepareArgs): Required<DonePrepareArgs> {
  return {
    storyId: args.storyId,
    mergeMain: args.mergeMain !== false,
    refreshStale: args.refreshStale !== false,
    validate: args.validate !== false,
    build: args.build === true,
    dryRun: args.dryRun === true,
  };
}

function git(gitCwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: gitCwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function gitMaybe(gitCwd: string, args: string[]): { ok: true; output: string } | { ok: false; error: string } {
  try {
    return { ok: true, output: git(gitCwd, args) };
  } catch (err: any) {
    return {
      ok: false,
      error: String(err?.stderr || err?.stdout || err?.message || err).trim(),
    };
  }
}

function gitStatusRows(gitCwd: string): string[] {
  const raw = git(gitCwd, ['status', '--porcelain=v1', '--untracked-files=all']);
  return raw.split('\n').map((line) => line.trimEnd()).filter(Boolean);
}

function statusFiles(rows: string[]): string[] {
  return rows
    .map((row) => parseGitPorcelainRow(row)?.path || row.slice(3).trim() || row)
    .filter(Boolean);
}

function entryFiles(entries: DirtyWorktreeEntry[]): string[] {
  return [...new Set(entries.flatMap((entry) => dirtyEntryPaths(entry)))];
}

function ownerLeaseRelPath(ctx: HandlerContext, storyId: string): string {
  return `${ctx.store.storyDirRel()}/${storyId}/owner-lease.json`.replace(/\\/g, '/');
}

function nonLeaseDirtyRows(ctx: HandlerContext, storyId: string, rows: string[]): string[] {
  const leasePath = ownerLeaseRelPath(ctx, storyId);
  return rows.filter((row) => {
    const parsed = parseGitPorcelainRow(row);
    if (!parsed) return true;
    const dirtyPaths = [parsed.path, parsed.originalPath].filter((path): path is string => Boolean(path));
    return dirtyPaths.length === 0 || !dirtyPaths.every((path) => path === leasePath);
  });
}

function classifyDirtyRows(ctx: HandlerContext, storyId: string, rows: string[]): DirtyWorktreeClassification {
  const config = loadConfig(ctx.root);
  return classifyGitStatusRows(
    rows,
    dirtyWorktreeClassifierOptionsForStory(config, storyId, ctx.store, ctx.root),
  );
}

function dirtyEntryPaths(entry: DirtyWorktreeEntry): string[] {
  return [entry.path, entry.originalPath].filter((path): path is string => Boolean(path));
}

function normalizeRelPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function isSameStoryLifecycleMetadataPath(ctx: HandlerContext, storyId: string, path: string): boolean {
  const storyDir = normalizeRelPath(ctx.store.storyDirRel());
  const normalized = normalizeRelPath(path);
  return normalized === `${storyDir}/${storyId}` || normalized.startsWith(`${storyDir}/${storyId}/`);
}

function isDonePrepareAllowedInitialMetadataEntry(ctx: HandlerContext, storyId: string, entry: DirtyWorktreeEntry): boolean {
  const paths = dirtyEntryPaths(entry);
  return entry.category === 'lattice_metadata_changes'
    && paths.length > 0
    && paths.every((path) => isStoryMetadataPath(path, ctx.root))
    && paths.every((path) => isSameStoryLifecycleMetadataPath(ctx, storyId, path));
}

function initialDonePrepareBlockingEntries(
  ctx: HandlerContext,
  storyId: string,
  classification: DirtyWorktreeClassification,
): DirtyWorktreeEntry[] {
  return classification.entries.filter((entry) => !isDonePrepareAllowedInitialMetadataEntry(ctx, storyId, entry));
}

function dirtyPathDigest(gitCwd: string, path: string): string {
  const absPath = join(gitCwd, path);
  try {
    if (!existsSync(absPath)) return 'missing';
    const stat = statSync(absPath);
    if (stat.isDirectory()) return 'directory';
    if (!stat.isFile()) return `non-file:${stat.mode}`;
    return createHash('sha256').update(readFileSync(absPath)).digest('hex');
  } catch (err: any) {
    return `unreadable:${err?.code || err?.message || String(err)}`;
  }
}

function dirtyEntrySignature(gitCwd: string, entry: DirtyWorktreeEntry): string {
  const paths = [entry.path, entry.originalPath].filter((path): path is string => Boolean(path));
  return [
    entry.statusCode,
    entry.path,
    entry.originalPath ?? '',
    ...paths.map((path) => `${path}:${dirtyPathDigest(gitCwd, path)}`),
  ].join('\0');
}

function unchangedFromInitialAllowedMetadata(
  ctx: HandlerContext,
  storyId: string,
  gitCwd: string,
  entry: DirtyWorktreeEntry,
  initialAllowedMetadataSignatures: ReadonlySet<string>,
): boolean {
  return isDonePrepareAllowedInitialMetadataEntry(ctx, storyId, entry)
    && initialAllowedMetadataSignatures.has(dirtyEntrySignature(gitCwd, entry));
}

function isMainAncestor(gitCwd: string): boolean {
  return gitMaybe(gitCwd, ['merge-base', '--is-ancestor', 'main', 'HEAD']).ok;
}

function ensureStep(steps: DonePrepareStep[], id: StepId): DonePrepareStep {
  let step = steps.find((candidate) => candidate.id === id);
  if (!step) {
    step = { id, status: 'pending' };
    steps.push(step);
  }
  return step;
}

function setStep(
  steps: DonePrepareStep[],
  id: StepId,
  status: StepStatus,
  reason?: string,
  command?: string,
): void {
  const step = ensureStep(steps, id);
  step.status = status;
  if (reason !== undefined) step.reason = reason;
  if (command !== undefined) step.command = command;
}

function block(args: DonePrepareBlocked): string {
  const lines = [
    'DONE prepare: BLOCKED',
    `blockedAt: ${args.blockedAt}`,
    `reason: ${args.reason}`,
  ];
  if (args.files && args.files.length > 0) {
    lines.push('files:');
    for (const file of args.files) lines.push(`  - ${file}`);
  }
  if (args.commits && args.commits.length > 0) {
    lines.push('commits:');
    for (const commit of args.commits) lines.push(`  - ${commit}`);
  }
  if (args.currentBinding) {
    lines.push('Current material binding:');
    lines.push(`  currentHead: ${args.currentBinding.currentHead || '(unavailable)'}`);
    lines.push(`  currentMaterialHash: ${args.currentBinding.currentMaterialHash || '(unavailable)'}`);
    lines.push(`  currentStoryFilesHash: ${args.currentBinding.currentStoryFilesHash || '(unavailable)'}`);
  }
  if (args.commands && args.commands.length > 0) {
    lines.push('commands:');
    for (const command of args.commands) lines.push(`  - ${command}`);
  }
  lines.push(`next: ${args.next}`);
  lines.push('');
  lines.push(renderSteps(args.steps));
  return lines.join('\n');
}

function renderSteps(steps: DonePrepareStep[]): string {
  const lines = ['Steps:'];
  for (const step of steps) {
    const suffix = step.reason ? ` — ${step.reason}` : '';
    lines.push(`  ${step.id}: ${step.status.toUpperCase()}${suffix}`);
  }
  return lines.join('\n');
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return JSON.stringify(value, null, 2);
}

function parseValidateOutput(text: string, next = 'lattice validate --story=<storyId> --json'): { ok: boolean; summary: string; next: string } {
  try {
    const parsed = JSON.parse(text);
    const status = typeof parsed.status === 'string' ? parsed.status.toLowerCase() : '';
    const ok = typeof parsed.allPass === 'boolean'
      ? parsed.allPass
      : !['fail', 'failed', 'error'].includes(status);
    const detail = [
      typeof parsed.summary === 'string' ? parsed.summary : '',
      Array.isArray(parsed.details) ? parsed.details.slice(0, 3).join('; ') : '',
      Array.isArray(parsed.reasons) ? parsed.reasons.slice(0, 3).join('; ') : '',
    ].filter(Boolean).join(': ');
    return {
      ok,
      summary: detail || (ok ? 'validation passed' : 'validation failed'),
      next,
    };
  } catch {
    return {
      ok: !/status["']?\s*:\s*["']fail|allPass["']?\s*:\s*false|validation failed/i.test(text),
      summary: text.split('\n').find((line) => line.trim())?.trim() || 'validation output was not JSON',
      next,
    };
  }
}

function classifyStaleEvidence(ctx: HandlerContext, storyId: string, gitCwd: string): StaleEvidencePlan {
  const checklistHandlers = createChecklistHandlers(ctx);
  const dryRunTranscript = asText(checklistHandlers.verification_evidence_refresh_stale({ storyId, dryRun: true }));
  const cl = ctx.store.readChecklist(storyId);
  const headHash = currentGitHead(gitCwd);
  if (!headHash) {
    throw new Error('done_prepare: cannot read git HEAD for stale evidence classification');
  }
  const coverage = buildVerificationCoverage(
    cl,
    headHash,
    (oldHeadHash, evidence) => checkEvidenceFreshnessForGit(gitCwd, oldHeadHash, evidence?.materialHash, ctx.root, evidence?.storyFilesHash).fresh,
    { deferredGateEvidence: 'missing' },
  );
  const stale = coverage.entries.filter((entry) => entry.status === 'stale' && entry.evidence);
  const safeRefresh: StaleEvidencePlan['safeRefresh'] = [];
  const rerunRequired: StaleEvidencePlan['rerunRequired'] = [];
  for (const entry of stale) {
    const ev = entry.evidence!;
    const command = typeof ev.command === 'string' ? ev.command.trim() : '';
    const subject = command || ev.file || ev.kind || 'evidence';
    if (command) {
      rerunRequired.push({ intentRef: entry.intentRef, command });
    } else {
      safeRefresh.push({ intentRef: entry.intentRef, subject });
    }
  }
  return {
    dryRunTranscript,
    staleCount: stale.length,
    safeRefresh,
    rerunRequired,
  };
}

function conflictFiles(gitCwd: string): string[] {
  const result = gitMaybe(gitCwd, ['diff', '--name-only', '--diff-filter=U']);
  if (!result.ok || !result.output.trim()) return [];
  return result.output.split('\n').map((line) => line.trim()).filter(Boolean);
}

function commitSummariesSince(gitCwd: string, beforeHead: string, afterHead: string): string[] {
  if (!beforeHead || !afterHead || beforeHead === afterHead) return [];
  const result = gitMaybe(gitCwd, ['log', '--reverse', '--pretty=format:%h %s', `${beforeHead}..${afterHead}`]);
  if (result.ok && result.output.trim()) {
    return result.output.split('\n').map((line) => line.trim()).filter(Boolean);
  }
  return [afterHead.slice(0, 12)];
}

function blockingRows(runbook: DoneClosureRunbook) {
  return runbook.blockers.filter((row) => row.blocking && row.status === 'fail');
}

function hasReviewAssuranceBlocker(runbook: DoneClosureRunbook): boolean {
  return blockingRows(runbook).some((row) => row.id === 'review-assurance-floor' || row.id === 'review-escalation');
}

function nextForDoneClosureBlock(storyId: string, runbook: DoneClosureRunbook): string {
  if (hasReviewAssuranceBlocker(runbook)) {
    return `inspect review status, submit current-material review/quorum evidence, then rerun lattice done_prepare '{"storyId":"${storyId}"}'`;
  }
  const row = blockingRows(runbook).find((candidate) => candidate.nextCommand);
  return row?.nextCommand || `lattice done_closure '{"storyId":"${storyId}"}'`;
}

function commandsForDoneClosureBlock(
  storyId: string,
  runbook: DoneClosureRunbook,
  currentBinding?: DonePrepareCurrentBinding,
): string[] {
  if (hasReviewAssuranceBlocker(runbook)) {
    const currentMaterialHashValue = currentBinding?.currentMaterialHash || '<current-materialHash>';
    const currentStoryFilesHashValue = currentBinding?.currentStoryFilesHash || '<current-storyFilesHash>';
    return [
      `lattice review_escalation_status '{"storyId":"${storyId}"}'`,
      `lattice quorum_submit '{"storyId":"${storyId}","hostA":"<independent-host-a>","hostB":"<independent-host-b>"}'`,
      `lattice autopilot_review_submit --storyId=${storyId} --runId=<round-id> --hostId=<host> --sessionId=<session> --keyId=<key> --decision=pass --materialDigest=${currentMaterialHashValue} --storyFilesHash=${currentStoryFilesHashValue} --validationDigest=<fresh-validation-digest> --promptDigest=<current-prompt-digest>`,
      `lattice done_prepare '{"storyId":"${storyId}"}'`,
    ];
  }
  const blockers = blockingRows(runbook);
  return blockers.map((row) => row.nextCommand).filter((value): value is string => Boolean(value));
}

function reviewAssuranceText(runbook: DoneClosureRunbook): string {
  const floor = runbook.blockers.find((row) => row.id === 'review-assurance-floor');
  const escalation = runbook.blockers.find((row) => row.id === 'review-escalation');
  const detail = floor?.reason || escalation?.reason || '';
  const level = detail.match(/: ([a-z0-9-]+);/i)?.[1] || detail.match(/\b(degraded-single-host|full-3x2|local-one-round|ordinary-review|not required)\b/i)?.[1];
  return level || 'not-required';
}

function isRuntimePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  if (RUNTIME_FILES.has(normalized)) return true;
  return RUNTIME_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function isDocumentationOrMetadataPath(path: string): boolean {
  const lower = path.replace(/\\/g, '/').toLowerCase();
  return lower.startsWith('docs/')
    || lower.startsWith('.lattice/')
    || lower.endsWith('.md')
    || lower.endsWith('.mdx');
}

function isCommentLikeLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === ''
    || trimmed.startsWith('//')
    || trimmed.startsWith('/*')
    || trimmed.startsWith('*')
    || trimmed.startsWith('*/')
    || trimmed.startsWith('#');
}

function runtimeDiffHasOnlyComments(gitCwd: string, path: string): boolean {
  const result = gitMaybe(gitCwd, ['diff', '--unified=0', 'main...HEAD', '--', path]);
  if (!result.ok) return false;
  const changed = result.output
    .split('\n')
    .filter((line) => (line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---'))
    .map((line) => line.slice(1));
  return changed.length > 0 && changed.every(isCommentLikeLine);
}

function readPackageVersion(root: string, relPath: string): string | undefined {
  const path = join(root, relPath);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return typeof parsed.version === 'string' ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

function readBrandVersion(root: string): string | undefined {
  const path = join(root, 'packages/main/src/core/lattice-brand.ts');
  if (!existsSync(path)) return undefined;
  const match = readFileSync(path, 'utf-8').match(/LATTICE_CLI_VERSION\s*=\s*['"]([^'"]+)['"]/);
  return match?.[1];
}

function readVersionSources(root: string): Record<string, string> {
  const sources: Record<string, string> = {};
  for (const rel of VERSION_SOURCE_FILES) {
    const value = rel.endsWith('lattice-brand.ts')
      ? readBrandVersion(root)
      : readPackageVersion(root, rel);
    if (value) sources[rel] = value;
  }
  return sources;
}

function detectRuntimeChanges(root: string, gitCwd: string): RuntimeChangeReport {
  const diff = gitMaybe(gitCwd, ['diff', '--name-only', 'main...HEAD']);
  const changedFiles = diff.ok && diff.output.trim()
    ? diff.output.split('\n').map((line) => line.trim()).filter(Boolean)
    : [];
  const runtimeFiles = changedFiles
    .filter(isRuntimePath)
    .filter((path) => !runtimeDiffHasOnlyComments(gitCwd, path));
  const docsOnly = changedFiles.length > 0 && changedFiles.every(isDocumentationOrMetadataPath);
  const versionSources = readVersionSources(root);
  const uniqueVersions = [...new Set(Object.values(versionSources))];
  const postDoneVersionState = Object.keys(versionSources).length === 0
    ? 'unknown'
    : uniqueVersions.length === 1
      ? 'consistent'
      : 'inconsistent';
  const versionMismatches = postDoneVersionState === 'inconsistent'
    ? Object.entries(versionSources).map(([file, version]) => `${file}=${version}`)
    : [];
  return {
    postDoneRuntimeVersionBumpRequired: runtimeFiles.length > 0,
    changedFiles,
    runtimeFiles,
    docsOnly,
    postDoneVersionState,
    versionSources,
    versionMismatches,
  };
}

function renderRuntimeReport(report: RuntimeChangeReport): string[] {
  const lines = [
    `postDoneRuntimeVersionBumpRequired: ${report.postDoneRuntimeVersionBumpRequired}`,
    `postDoneVersionState: ${report.postDoneVersionState}`,
  ];
  if (report.versionMismatches.length > 0) {
    lines.push('postDoneVersionMismatches:');
    for (const mismatch of report.versionMismatches) lines.push(`  - ${mismatch}`);
  }
  if (report.runtimeFiles.length > 0) {
    lines.push('runtimeChangedFiles:');
    for (const file of report.runtimeFiles.slice(0, 12)) lines.push(`  - ${file}`);
  } else if (report.docsOnly) {
    lines.push('runtimeChangeClassification: docs-only');
  } else {
    lines.push('runtimeChangeClassification: no runtime source changes detected');
  }
  return lines;
}

/**
 * @task B-4363
 * @checklist CHK-001
 * @title done_prepare current-material review guidance
 * @type bugfix
 * @priority high
 * @description
 *   Report the post-main-sync HEAD/material/story file binding when DONE
 *   closure blocks on review assurance, so reviewers do not keep submitting
 *   stale pre-merge host verdicts.
 * @changes
 *   - [CHK-001] Add current binding output and ordered review/quorum commands to done_prepare blockers.
 * @test current-done-material-binding
 */
function currentDoneMaterialBinding(ctx: HandlerContext, gitCwd: string): DonePrepareCurrentBinding {
  return {
    currentHead: currentGitHead(gitCwd),
    currentMaterialHash: currentMaterialHash(gitCwd, 'HEAD', ctx.root),
    currentStoryFilesHash: currentStoryFilesHash(gitCwd, 'HEAD', ctx.root),
  };
}

function renderPass(args: {
  storyId: string;
  phase: string;
  steps: DonePrepareStep[];
  runbook: DoneClosureRunbook;
  runtime: RuntimeChangeReport;
  dryRun: boolean;
}): string {
  const lines = [
    'DONE prepare: PASS',
    `storyId: ${args.storyId}`,
    `phase: ${args.phase}`,
    `dryRun: ${args.dryRun}`,
    `mergeMain: ${ensureStep(args.steps, 'mergeMain').status.toUpperCase()}`,
    `staleEvidenceRefresh: ${ensureStep(args.steps, 'staleEvidenceRefresh').status.toUpperCase()}`,
    `validate: ${ensureStep(args.steps, 'validate').status.toUpperCase()}`,
    `doneClosure: ${ensureStep(args.steps, 'doneClosure').status.toUpperCase()}`,
    `worktreeClean: ${ensureStep(args.steps, 'cleanTree').status.toUpperCase()}`,
    ...renderRuntimeReport(args.runtime),
    '',
    'Local assurance:',
    '  localDoneReady: true',
    '  releaseReadiness: not-established',
    `  admissibilityStatus: ${args.runbook.localAssurance.admissibilityStatus}`,
    `  assuranceLevel: ${args.runbook.localAssurance.assuranceLevel}`,
    `  evidenceScope: ${args.runbook.localAssurance.evidenceScope}`,
    `  reviewAssurance: ${reviewAssuranceText(args.runbook)}`,
    '',
    'Advisory memory considered:',
    ...renderMemoryFreshnessPackSummary(args.runbook.memoryFreshnessPack).split('\n').map((line) => `  ${line}`),
    `  completionClaimSource: ${args.runbook.completionClaimSource}`,
    '  memoryCompletionProof: false',
    '',
    'Next:',
    `lattice story_advance '{"storyId":"${args.storyId}","phase":"DONE"}'`,
  ];
  return lines.join('\n');
}

async function runDonePrepare(ctx: HandlerContext, rawArgs: DonePrepareArgs): Promise<string> {
  const args = defaulted(rawArgs);
  const storyId = args.storyId.trim();
  const steps: DonePrepareStep[] = [
    { id: 'preflight', status: 'pending' },
    { id: 'mergeMain', status: 'pending' },
    { id: 'staleEvidenceRefresh', status: 'pending' },
    { id: 'validate', status: 'pending' },
    { id: 'doneClosure', status: 'pending' },
    { id: 'runtimeChange', status: 'pending' },
    { id: 'cleanTree', status: 'pending' },
  ];

  if (!storyId) {
    setStep(steps, 'preflight', 'blocked', 'storyId is required');
    return block({
      blockedAt: 'preflight',
      reason: 'storyId is required',
      next: 'lattice done_prepare \'{"storyId":"B-xxxx"}\'',
      steps,
    });
  }

  let story;
  try {
    story = ctx.store.readStory(storyId);
  } catch (err: any) {
    setStep(steps, 'preflight', 'blocked', `story ${storyId} cannot be read`);
    return block({
      blockedAt: 'preflight',
      reason: err?.message || `story ${storyId} cannot be read`,
      next: `lattice story_get '{"storyId":"${storyId}"}'`,
      steps,
    });
  }

  const gitCwd = resolveGitCwd({ store: ctx.store, storyId, metadataRoot: ctx.root, projectRoot: ctx.root });

  try {
    assertCwdInWorktree(ctx.store, storyId);
  } catch (err: any) {
    setStep(steps, 'preflight', 'blocked', 'current cwd is not the requested story worktree');
    return block({
      blockedAt: 'preflight',
      reason: err?.message || 'current cwd is not the requested story worktree',
      next: story.worktree?.path ? `cd ${story.worktree.path}` : `lattice story_resolve '{"storyId":"${storyId}"}'`,
      steps,
    });
  }

  if (story.phase !== 'TEST') {
    setStep(steps, 'preflight', 'blocked', `story phase is ${story.phase}, expected TEST`);
    return block({
      blockedAt: 'preflight',
      reason: `story ${storyId} is in ${story.phase}; done_prepare only runs for TEST stories`,
      next: `lattice story_advance '{"storyId":"${storyId}","phase":"TEST"}'`,
      steps,
    });
  }

  const expectedBranch = story.worktree?.branch || `story/${storyId}`;
  const branch = gitMaybe(gitCwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch.ok || branch.output !== expectedBranch) {
    setStep(steps, 'preflight', 'blocked', `current branch is ${branch.ok ? branch.output : '<unknown>'}, expected ${expectedBranch}`);
    return block({
      blockedAt: 'preflight',
      reason: `current branch is ${branch.ok ? branch.output : '<unknown>'}, expected ${expectedBranch}`,
      next: story.worktree?.path ? `cd ${story.worktree.path}` : `git switch ${expectedBranch}`,
      steps,
    });
  }

  const mainRef = gitMaybe(gitCwd, ['rev-parse', '--verify', 'main^{commit}']);
  if (!mainRef.ok) {
    setStep(steps, 'preflight', 'blocked', 'local main ref is unavailable');
    return block({
      blockedAt: 'preflight',
      reason: `local main cannot be found: ${mainRef.error}`,
      next: 'fetch or create a local main branch, then rerun lattice done_prepare',
      steps,
    });
  }

  const initialDirty = nonLeaseDirtyRows(ctx, storyId, gitStatusRows(gitCwd));
  const initialDirtyClassification = classifyDirtyRows(ctx, storyId, initialDirty);
  const initialBlockingEntries = initialDonePrepareBlockingEntries(ctx, storyId, initialDirtyClassification);
  if (initialBlockingEntries.length > 0) {
    const files = entryFiles(initialBlockingEntries);
    setStep(steps, 'cleanTree', 'blocked', 'worktree must be clean before DONE prepare can mutate');
    return block({
      blockedAt: 'cleanTree',
      reason: 'worktree has dirty files that are not Proofbound story lifecycle metadata; done_prepare cannot mutate yet',
      files,
      next: 'git status --short',
      steps,
    });
  }
  const initialAllowedMetadataSignatures = new Set(
    initialDirtyClassification.groups.lattice_metadata_changes
      .filter((entry) => isDonePrepareAllowedInitialMetadataEntry(ctx, storyId, entry))
      .map((entry) => dirtyEntrySignature(gitCwd, entry)),
  );
  setStep(
    steps,
    'preflight',
    'pass',
    initialAllowedMetadataSignatures.size > 0
      ? 'only pre-existing Proofbound story lifecycle metadata is dirty'
      : undefined,
  );

  if (!args.mergeMain) {
    setStep(steps, 'mergeMain', 'skipped', 'mergeMain=false');
  } else if (args.dryRun) {
    setStep(
      steps,
      'mergeMain',
      isMainAncestor(gitCwd) ? 'pass' : 'skipped',
      isMainAncestor(gitCwd) ? undefined : 'planned mutation skipped: dryRun would run git merge main',
      'git merge main',
    );
  } else {
    const merge = gitMaybe(gitCwd, ['merge', 'main', '--no-edit']);
    if (!merge.ok) {
      const files = conflictFiles(gitCwd);
      setStep(steps, 'mergeMain', 'blocked', 'git merge main failed with conflicts', 'git merge main');
      return block({
        blockedAt: 'mergeMain',
        reason: merge.error || 'git merge main failed',
        files,
        next: 'resolve conflicts, git add the resolved files, commit the merge, then rerun lattice done_prepare',
        steps,
      });
    }
    setStep(steps, 'mergeMain', 'pass', merge.output || 'main already merged', 'git merge main');
  }

  const prepareMutationStartHead = currentGitHead(gitCwd);
  if (!prepareMutationStartHead) {
    setStep(steps, 'preflight', 'blocked', 'cannot read git HEAD before refresh/validate');
    return block({
      blockedAt: 'preflight',
      reason: 'cannot read git HEAD before refresh/validate',
      next: 'git rev-parse HEAD',
      steps,
    });
  }

  let stalePlan: StaleEvidencePlan;
  try {
    stalePlan = classifyStaleEvidence(ctx, storyId, gitCwd);
  } catch (err: any) {
    setStep(steps, 'staleEvidenceRefresh', 'blocked', err?.message || 'stale evidence classification failed');
    return block({
      blockedAt: 'evidenceFreshness',
      reason: err?.message || 'stale evidence classification failed',
      next: `lattice verification_evidence_refresh_stale --storyId=${storyId} --dryRun`,
      steps,
    });
  }

  if (stalePlan.staleCount === 0) {
    setStep(steps, 'staleEvidenceRefresh', 'pass', 'no stale verification evidence');
  } else if (!args.refreshStale) {
    setStep(steps, 'staleEvidenceRefresh', 'blocked', `${stalePlan.staleCount} stale evidence item(s); refreshStale=false`);
    return block({
      blockedAt: 'evidenceFreshness',
      reason: `${stalePlan.staleCount} stale verification evidence item(s) found; refreshStale=false`,
      next: `lattice verification_evidence_refresh_stale --storyId=${storyId}`,
      commands: stalePlan.rerunRequired.map((entry) => entry.command),
      steps,
    });
  } else if (stalePlan.rerunRequired.length > 0) {
    const commands = [...new Set(stalePlan.rerunRequired.map((entry) => entry.command))];
    setStep(steps, 'staleEvidenceRefresh', 'blocked', 'stale command-backed evidence must be rerun');
    return block({
      blockedAt: 'evidenceFreshness',
      reason: 'stale command-backed verification evidence must be rerun; done_prepare will not freshen it by rewriting hashes',
      commands,
      next: commands[0] || `lattice validate --story=${storyId} --json`,
      steps,
    });
  } else if (args.dryRun) {
    setStep(steps, 'staleEvidenceRefresh', 'skipped', `planned mutation skipped: dryRun would refresh ${stalePlan.safeRefresh.length} metadata-only stale evidence item(s)`);
  } else {
    const refreshed = asText(createChecklistHandlers(ctx).verification_evidence_refresh_stale({ storyId }));
    setStep(steps, 'staleEvidenceRefresh', 'pass', refreshed.split('\n').find((line) => line.trim()) || stalePlan.dryRunTranscript);
  }

  if (!args.validate) {
    setStep(steps, 'validate', 'skipped', 'validate=false');
  } else if (args.dryRun) {
    setStep(steps, 'validate', 'skipped', 'planned mutation skipped: dryRun does not run lattice validate');
  } else {
    const verifier = createVerifierHandlers(ctx);
    let validateText = '';
    const validationSummaries: string[] = [];
    try {
      validateText = asText(await verifier.validate({ story: storyId, json: true, noSync: true }));
    } catch (err: any) {
      setStep(steps, 'validate', 'blocked', err?.message || 'lattice validate failed');
      return block({
        blockedAt: 'validate',
        reason: err?.message || 'lattice validate failed',
        next: `lattice validate --story=${storyId} --json`,
        steps,
      });
    }
    const parsed = parseValidateOutput(validateText);
    if (!parsed.ok) {
      setStep(steps, 'validate', 'blocked', parsed.summary);
      return block({
        blockedAt: 'validate',
        reason: parsed.summary,
        next: parsed.next.replace('<storyId>', storyId),
        steps,
      });
    }
    validationSummaries.push(parsed.summary);

    const doneRequiredPolicy = resolveDoneRequiredPolicy(ctx.root);
    if (doneRequiredPolicy.required) {
      const doneRequiredHandlers = createDoneRequiredValidationHandlers(ctx);
      const command = `lattice done_required_validate --storyId=${storyId}`;
      let doneRequiredText = '';
      try {
        doneRequiredText = asText(await doneRequiredHandlers.done_required_validate({ storyId, json: true }));
      } catch (err: any) {
        setStep(steps, 'validate', 'blocked', err?.message || 'DONE-required validation failed', command);
        return block({
          blockedAt: 'validate',
          reason: err?.message || 'DONE-required validation failed',
          next: command,
          steps,
        });
      }
      const parsedDoneRequired = parseValidateOutput(doneRequiredText, command);
      if (!parsedDoneRequired.ok) {
        setStep(steps, 'validate', 'blocked', parsedDoneRequired.summary, command);
        return block({
          blockedAt: 'validate',
          reason: parsedDoneRequired.summary,
          next: parsedDoneRequired.next,
          steps,
        });
      }
      validationSummaries.push(`DONE-required validation passed: ${parsedDoneRequired.summary}`);
    }

    setStep(
      steps,
      'validate',
      'pass',
      validationSummaries.join('; '),
      `lattice validate --story=${storyId} --json`,
    );
  }

  const prepareMutationEndHead = currentGitHead(gitCwd);
  if (prepareMutationEndHead && prepareMutationEndHead !== prepareMutationStartHead) {
    const commits = commitSummariesSince(gitCwd, prepareMutationStartHead, prepareMutationEndHead);
    const dirtyRows = nonLeaseDirtyRows(ctx, storyId, gitStatusRows(gitCwd));
    const files = statusFiles(dirtyRows);
    setStep(steps, 'cleanTree', 'blocked', 'refresh/validate produced commit(s); rerun from the new HEAD before DONE');
    return block({
      blockedAt: 'cleanTree',
      reason: 'done_prepare produced commit(s) during refresh/validate; rerun from the new HEAD before DONE',
      commits,
      ...(files.length > 0 ? { files } : {}),
      commands: [
        `git log --oneline ${prepareMutationStartHead}..HEAD`,
        `lattice done_prepare '{"storyId":"${storyId}"}'`,
      ],
      next: 'review the generated commit(s), then rerun lattice done_prepare from the new HEAD',
      steps,
    });
  }

  if (args.build) {
    if (args.dryRun) {
      setStep(steps, 'worktreeVersionCheck', 'skipped', 'planned mutation skipped: dryRun does not build');
    } else {
      try {
        execFileSync('npm', ['--prefix', 'packages/main', 'run', 'build'], {
          cwd: ctx.root,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        execFileSync(process.execPath, ['packages/main/dist/cli.js', '--version'], {
          cwd: ctx.root,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        setStep(steps, 'worktreeVersionCheck', 'pass', 'worktree CLI build executes');
      } catch (err: any) {
        setStep(steps, 'worktreeVersionCheck', 'blocked', 'worktree CLI build does not execute');
        return block({
          blockedAt: 'worktreeVersionCheck',
          reason: String(err?.stderr || err?.stdout || err?.message || err).trim() || 'worktree CLI build does not execute',
          next: 'npm --prefix packages/main run build',
          steps,
        });
      }
    }
  }

  const runbook = buildDoneClosureRunbook(ctx, storyId);
  const blockers = blockingRows(runbook);
  const nonCleanBlockers = blockers.filter((row) => row.id !== 'git-working-tree');
  if (nonCleanBlockers.length > 0) {
    const currentBinding = hasReviewAssuranceBlocker(runbook)
      ? currentDoneMaterialBinding(ctx, gitCwd)
      : undefined;
    const reason = nonCleanBlockers.map((row) => `${row.id}: ${row.reason}`).join('; ');
    setStep(steps, 'doneClosure', 'blocked', reason);
    return block({
      blockedAt: 'doneClosure',
      reason,
      currentBinding,
      next: nextForDoneClosureBlock(storyId, runbook),
      commands: commandsForDoneClosureBlock(storyId, runbook, currentBinding),
      steps,
    });
  }
  setStep(steps, 'doneClosure', 'pass', runbook.canAttemptDone ? 'canAttemptDone=true' : 'only git clean-tree remains');

  const runtime = detectRuntimeChanges(ctx.root, gitCwd);
  setStep(steps, 'runtimeChange', 'pass', runtime.postDoneRuntimeVersionBumpRequired ? 'runtime behavior change detected' : 'no runtime version bump required before DONE');

  const finalDirty = nonLeaseDirtyRows(ctx, storyId, gitStatusRows(gitCwd));
  const finalDirtyClassification = classifyDirtyRows(ctx, storyId, finalDirty);
  const finalBlockingEntries = finalDirtyClassification.entries.filter(
    (entry) => !unchangedFromInitialAllowedMetadata(ctx, storyId, gitCwd, entry, initialAllowedMetadataSignatures),
  );
  if (finalBlockingEntries.length > 0) {
    const files = entryFiles(finalBlockingEntries);
    setStep(steps, 'cleanTree', 'blocked', 'done_prepare produced files that must be committed before DONE');
    return block({
      blockedAt: 'cleanTree',
      reason: 'done_prepare produced metadata changes that must be committed before DONE',
      files,
      next: `git add ${files.map((file) => `"${file}"`).join(' ')} && git commit -m "lattice: prepare ${storyId} for DONE"`,
      steps,
    });
  }
  setStep(
    steps,
    'cleanTree',
    'pass',
    finalDirtyClassification.total > 0 ? 'only unchanged pre-existing Proofbound story lifecycle metadata remains dirty' : undefined,
  );

  return renderPass({
    storyId,
    phase: story.phase,
    steps,
    runbook,
    runtime,
    dryRun: args.dryRun,
  });
}

export function createDonePrepareHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  return {
    done_prepare(args: DonePrepareArgs) {
      return runDonePrepare(ctx, args);
    },
  };
}
