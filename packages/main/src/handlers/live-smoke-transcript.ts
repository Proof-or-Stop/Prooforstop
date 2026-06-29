import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { HandlerContext } from './context.js';
import {
  buildStoryReadinessReport,
  type StoryReadinessReport,
  type StoryReadinessRow,
} from '../core/lifecycle-readiness.js';
import { checkEvidenceFreshnessForGit, currentGitHead, currentMaterialHash } from '../core/evidence-freshness.js';
import { isCanonicalStoryId } from '../core/lifecycle-registry.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import type { ChecklistData } from '../core/types.js';

/**
 * P5 (B-9b5e) — `live_smoke_transcript`: the explicit live-smoke transcript
 * producer for the Lifecycle Readiness plan.
 *
 *   lattice live_smoke_transcript --storyId=B-xxxx [--capture="<command>"] [--write] [--format=text|json]
 *
 * Two INDEPENDENT opt-ins (plan lines 113-116):
 *   - --capture="<command>" (runCommands): run ONLY that one explicitly-provided
 *     command via spawnSync with a bounded timeout, capturing stdout/stderr/exit,
 *     and record it as the "actual" transcript. NEVER derives/appends a command.
 *     Capture alone persists NOTHING.
 *   - --write (writeEvidence): persist the structured expected-vs-actual artifact
 *     to <storyDir>/evidence/live-smoke-transcript.json. Write alone runs NO
 *     command (actual is whatever was captured this invocation, else null).
 *
 * All four flag combinations behave correctly. The command NEVER advances phase,
 * launches reviewers, claims Authority, writes verificationEvidence / delivery
 * checks, or ACCEPTS a metadata-only waiver (it may at most surface the waiver
 * path — only the delivery reviewer accepts it). It never widens local
 * assurance or release readiness.
 *
 * The V1 live-smoke readiness row + liveSmokeTranscriptRef artifact are CONSUMED
 * from buildStoryReadinessReport (the same reader lifecycle_check/evidence_plan
 * use); this command never re-derives that readiness classification.
 */

const READINESS_TARGET = 'DONE' as const;
const CAPTURE_TIMEOUT_MS = 60_000;
const STDOUT_MAX = 4000;
const STDERR_MAX = 2000;
const TRANSCRIPT_ARTIFACT = 'evidence/live-smoke-transcript.json';

interface LiveSmokeTranscriptArgs {
  storyId: string;
  capture?: string;
  write?: boolean;
  format?: 'text' | 'json';
  json?: boolean;
  runCommands?: boolean;
  advancePhase?: boolean;
  launchReviewers?: boolean;
  authorityDone?: boolean;
  fullAuthorityDone?: boolean;
  productionDone?: boolean;
}

type TranscriptStatus = 'missing' | 'present-fresh' | 'present-stale';

interface CapturedActual {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr?: string;
  capturedAtIso: string;
}

interface PersistedTranscriptArtifact {
  storyId: string;
  expected: string | null;
  actual: Omit<CapturedActual, 'capturedAtIso'> | null;
  mode: { runCommands: boolean; writeEvidence: boolean };
  capturedAtIso?: string;
  claims: { authorityDone: false; productionDone: false };
}

export interface LiveSmokeTranscriptReport {
  storyId: string;
  phase: StoryReadinessReport['phase'];
  mode: {
    /** true IFF --capture ran the provided command this invocation. */
    runCommands: boolean;
    /** true IFF --write persisted the artifact this invocation. */
    writeEvidence: boolean;
  };
  /** Expected user-visible output, read from the story checklist userSees. */
  expected: string | null;
  /** Current live-smoke transcript artifact status (present/missing/stale). */
  transcript: {
    status: TranscriptStatus;
    artifactPath: string;
    artifactRel: string;
  };
  /** The actual captured transcript this invocation (null unless --capture ran). */
  actual: CapturedActual | null;
  /** The V1 live-smoke readiness row, CONSUMED from the readiness reader. */
  readinessRow: StoryReadinessRow | null;
  /** The readiness reader's liveSmokeTranscriptRef artifact (consumed, not re-derived). */
  liveSmokeTranscriptRef: StoryReadinessReport['artifacts']['liveSmokeTranscriptRef'];
  /** Metadata-only waiver path, SURFACED only (never accepted here). */
  metadataOnlyWaiverRef: StoryReadinessReport['artifacts']['metadataOnlyWaiverRef'];
  /** The write outcome: requested + whether it actually persisted + the path. */
  write: {
    requested: boolean;
    persisted: boolean;
    artifactPath: string | null;
  };
  claims: {
    authorityDone: false;
    fullAuthorityDone: false;
    productionDone: false;
  };
}

function wantsJson(args: LiveSmokeTranscriptArgs): boolean {
  return args.json === true || args.format === 'json';
}

function wantsWrite(args: LiveSmokeTranscriptArgs): boolean {
  return args.write === true || (args.write as unknown) === 'true';
}

function captureCommand(args: LiveSmokeTranscriptArgs): string | null {
  if (typeof args.capture !== 'string') return null;
  const trimmed = args.capture.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Fail closed BEFORE any store read. live_smoke_transcript is a transcript
 * producer with TWO sanctioned opt-ins (--capture / --write); every OTHER side
 * effect is refused. runCommands as a raw boolean flag is rejected here because
 * command capture is requested via the explicit --capture="<command>" string, not
 * a bare runCommands=true. --write is NOT rejected here (the CLI ownership gate
 * guards it as a story-scoped mutation instead).
 */
function assertBoundary(args: LiveSmokeTranscriptArgs): void {
  const rejected: string[] = [];
  if (args.runCommands === true) rejected.push('runCommands=true');
  if (args.advancePhase === true) rejected.push('advancePhase=true');
  if (args.launchReviewers === true) rejected.push('launchReviewers=true');
  if (args.authorityDone === true) rejected.push('authorityDone=true');
  if (args.fullAuthorityDone === true) rejected.push('fullAuthorityDone=true');
  if (args.productionDone === true) rejected.push('productionDone=true');
  if (rejected.length === 0) return;
  throw new Error(
    `live_smoke_transcript refuses unsupported side effects: ${rejected.join(' and ')}. ` +
    'live_smoke_transcript never advances a phase, launches reviewers, claims release readiness, ' +
    'writes verificationEvidence or delivery checks, or accepts a metadata-only waiver: no story facts were read. ' +
    'Command capture is the explicit --capture="<command>" opt-in (it runs ONLY that one command); persistence is ' +
    'the explicit --write opt-in (ownership/scope gated). Neither implies the other.',
  );
}

function assertSafeStoryId(storyId: unknown): asserts storyId is string {
  if (
    typeof storyId !== 'string' ||
    storyId.includes('/') ||
    storyId.includes('\\') ||
    storyId.includes('..') ||
    !isCanonicalStoryId(storyId)
  ) {
    throw new Error(
      `live_smoke_transcript: invalid storyId ${JSON.stringify(storyId)} ` +
      '(expected B-..., B-META-..., ADHOC-..., TOOL-..., or META-... without path traversal)',
    );
  }
}

function readChecklist(ctx: HandlerContext, storyId: string): ChecklistData {
  try {
    return ctx.store.readChecklist(storyId);
  } catch {
    return { items: [] };
  }
}

/**
 * Expected user-visible output is the FIRST non-empty checklist userSees. This is
 * read-only consumption of authored PLAN metadata — never synthesized.
 */
function expectedFromUserSees(checklist: ChecklistData): string | null {
  for (const item of checklist.items) {
    const sees = typeof item.userSees === 'string' ? item.userSees.trim() : '';
    if (sees.length > 0) return sees;
  }
  return null;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max))}\n...[truncated ${value.length - max} chars]`;
}

/**
 * Run EXACTLY the one operator-provided command through a shell (the operator
 * explicitly provided it), bounded by a timeout, capturing stdout/stderr/exit.
 * NEVER derives, appends, or runs any second command. A truncated-but-sufficient
 * stdout/stderr is recorded.
 */
function runCapture(command: string, cwd: string): CapturedActual {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: CAPTURE_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderrRaw = typeof result.stderr === 'string' ? result.stderr : '';
  // spawnSync sets result.status=null + result.signal/result.error on
  // timeout/spawn failure: surface that as a non-zero-ish null exit with the
  // failure reason folded into stderr so the actual transcript is honest.
  const failureNote = result.error ? `[capture error] ${result.error.message}` : '';
  const stderr = [stderrRaw, failureNote].filter((s) => s.length > 0).join('\n');
  const actual: CapturedActual = {
    command,
    exitCode: typeof result.status === 'number' ? result.status : null,
    stdout: truncate(stdout, STDOUT_MAX),
    capturedAtIso: new Date().toISOString(),
  };
  if (stderr.length > 0) actual.stderr = truncate(stderr, STDERR_MAX);
  return actual;
}

/**
 * Classify the CURRENT persisted transcript artifact: missing, present-fresh, or
 * present-stale (its recorded head/material drifted from current git state). This
 * reads the durable artifact, never re-running a command.
 */
function classifyTranscript(
  artifactPath: string,
  gitCwd: string,
  metadataRoot: string,
): TranscriptStatus {
  if (!existsSync(artifactPath)) return 'missing';
  let parsed: { headHash?: unknown; materialHash?: unknown; storyFilesHash?: unknown };
  try {
    parsed = JSON.parse(readFileSync(artifactPath, 'utf8'));
  } catch {
    // A present-but-unreadable artifact is treated as stale: it cannot prove a
    // fresh live-smoke run.
    return 'present-stale';
  }
  const headHash = typeof parsed.headHash === 'string' ? parsed.headHash : undefined;
  const materialHash = typeof parsed.materialHash === 'string' ? parsed.materialHash : undefined;
  const storyFilesHash = typeof parsed.storyFilesHash === 'string' ? parsed.storyFilesHash : undefined;
  // Legacy artifacts without a headHash cannot be proven stale by hash, but a
  // live-smoke transcript with no freshness anchor is not a fresh proof either —
  // report present-stale so the operator re-captures rather than silently passing.
  if (!headHash) return 'present-stale';
  const freshness = checkEvidenceFreshnessForGit(gitCwd, headHash, materialHash, metadataRoot, storyFilesHash);
  return freshness.fresh ? 'present-fresh' : 'present-stale';
}

/** Pick the V1 live-smoke readiness row from the readiness reader (consume, never re-derive). */
function liveSmokeReadinessRow(report: StoryReadinessReport): StoryReadinessRow | null {
  return (
    report.readiness.find(
      (r) =>
        r.code === 'missing_live_smoke_transcript' ||
        r.code === 'stale_live_smoke_transcript' ||
        r.id === 'done.live_smoke_transcript' ||
        r.code.includes('live_smoke'),
    ) ?? null
  );
}

/**
 * Persist the structured expected-vs-actual transcript artifact. Folds in the
 * current head/material/storyFiles hashes so classifyTranscript can later decide
 * freshness. This is the ONLY write path and is reached only on --write (which the
 * CLI ownership gate guards as story-scoped mutation).
 */
function persistArtifact(
  artifactPath: string,
  storyId: string,
  expected: string | null,
  actual: CapturedActual | null,
  gitCwd: string,
  metadataRoot: string,
): void {
  const persisted: PersistedTranscriptArtifact & {
    headHash?: string;
    materialHash?: string;
  } = {
    storyId,
    expected,
    actual: actual
      ? {
          command: actual.command,
          exitCode: actual.exitCode,
          stdout: actual.stdout,
          ...(actual.stderr !== undefined ? { stderr: actual.stderr } : {}),
        }
      : null,
    mode: { runCommands: actual !== null, writeEvidence: true },
    ...(actual ? { capturedAtIso: actual.capturedAtIso } : {}),
    claims: { authorityDone: false, productionDone: false },
  };
  const head = currentGitHead(gitCwd);
  const material = currentMaterialHash(gitCwd, 'HEAD', metadataRoot);
  if (head) persisted.headHash = head;
  if (material) persisted.materialHash = material;

  mkdirSync(dirname(artifactPath), { recursive: true });
  const serialized = JSON.stringify(persisted, null, 2) + '\n';
  const tmpPath = `${artifactPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmpPath, serialized, 'utf8');
    JSON.parse(readFileSync(tmpPath, 'utf8'));
    renameSync(tmpPath, artifactPath);
  } finally {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      /* best-effort */
    }
  }
}

function statusLabel(status: TranscriptStatus): string {
  switch (status) {
    case 'missing':
      return 'missing';
    case 'present-fresh':
      return 'present(fresh)';
    case 'present-stale':
      return 'present(stale)';
  }
}

export function renderLiveSmokeTranscriptReport(report: LiveSmokeTranscriptReport): string {
  const captureRan = report.mode.runCommands;
  const wrote = report.mode.writeEvidence;
  let modeLine: string;
  if (wrote && captureRan) {
    modeLine = 'mode: capture + write (ran the provided command, persisted the artifact)';
  } else if (wrote) {
    modeLine = 'mode: write (persisted the artifact; no command run)';
  } else if (captureRan) {
    modeLine = 'mode: capture (ran the provided command; nothing persisted)';
  } else {
    modeLine = 'mode: read-only status (no command run, no artifact written)';
  }

  const lines = [
    `Live smoke transcript (${report.storyId})`,
    modeLine,
    `phase: ${report.phase}`,
    `expected (from userSees): ${report.expected ?? '(none authored)'}`,
    `current transcript: ${statusLabel(report.transcript.status)}`,
    `artifact: ${report.transcript.artifactRel}`,
  ];

  if (report.actual) {
    lines.push('', 'actual (captured this run):');
    lines.push(`  command: ${report.actual.command}`);
    lines.push(`  exitCode: ${report.actual.exitCode === null ? 'null (timeout/spawn failure)' : report.actual.exitCode}`);
    lines.push('  stdout:');
    for (const sLine of report.actual.stdout.split('\n')) lines.push(`    ${sLine}`);
    if (report.actual.stderr) {
      lines.push('  stderr:');
      for (const sLine of report.actual.stderr.split('\n')) lines.push(`    ${sLine}`);
    }
  }

  lines.push('', 'Live-smoke readiness row:');
  if (report.readinessRow) {
    const r = report.readinessRow;
    const marker = r.blocking ? 'BLOCKED' : r.status.toUpperCase();
    lines.push(`  [${marker}] ${r.id} code=${r.code} category=${r.category} owner=${r.owner}`);
    lines.push(`        ${r.reason}`);
  } else {
    lines.push('  (no dedicated live-smoke row in the V1 readiness reader for this target)');
  }
  lines.push(`  liveSmokeTranscriptRef: ${report.liveSmokeTranscriptRef === null ? 'null' : JSON.stringify(report.liveSmokeTranscriptRef)}`);
  if (report.metadataOnlyWaiverRef !== null) {
    lines.push(`  metadata-only waiver (surfaced only; the delivery reviewer accepts it): ${JSON.stringify(report.metadataOnlyWaiverRef)}`);
  }

  lines.push('', 'Write:');
  lines.push(`  requested: ${report.write.requested}`);
  lines.push(`  persisted: ${report.write.persisted}`);
  if (report.write.artifactPath) lines.push(`  path: ${report.write.artifactPath}`);

  if (!captureRan && !wrote) {
    lines.push('', 'Hint: pass --capture="<live smoke command>" to run+record the actual transcript, and --write to persist it.');
  } else if (captureRan && !wrote) {
    lines.push('', 'Hint: re-run with --write to persist the captured expected-vs-actual transcript.');
  }

  lines.push('', 'Local assurance:');
  lines.push('  admissibilityStatus: transcript-context');
  lines.push('  assuranceLevel: local');
  lines.push('  evidenceScope: live-smoke-output');
  return lines.join('\n');
}

export function createLiveSmokeTranscriptHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  function liveSmokeTranscript(args: LiveSmokeTranscriptArgs): LiveSmokeTranscriptReport | string {
    assertBoundary(args);
    assertSafeStoryId(args.storyId);

    if (!ctx.store.storyExists(args.storyId)) {
      throw new Error(`live_smoke_transcript: story ${args.storyId} not found`);
    }

    const gitCwd = resolveGitCwd({
      store: ctx.store,
      storyId: args.storyId,
      metadataRoot: ctx.root,
      projectRoot: ctx.root,
    });

    // Consume the V1 readiness reader (same reader lifecycle_check uses); never
    // re-derive the live-smoke classification.
    const readinessReport = buildStoryReadinessReport({
      storyId: args.storyId,
      target: READINESS_TARGET,
      store: ctx.store,
      root: ctx.root,
    });

    const checklist = readChecklist(ctx, args.storyId);
    const expected = expectedFromUserSees(checklist);

    const artifactPath = ctx.store.storyFilePath(args.storyId, TRANSCRIPT_ARTIFACT);
    const artifactRel = TRANSCRIPT_ARTIFACT;

    // --capture: run ONLY the provided command (independent of --write).
    const command = captureCommand(args);
    const actual = command !== null ? runCapture(command, gitCwd) : null;

    // --write: persist (independent of --capture). Write alone runs no command;
    // it persists whatever actual was captured this invocation (else null).
    const writeRequested = wantsWrite(args);
    let persisted = false;
    if (writeRequested) {
      persistArtifact(artifactPath, args.storyId, expected, actual, gitCwd, ctx.root);
      persisted = true;
    }

    // Classify the CURRENT durable artifact AFTER any write so a fresh --write run
    // reports present-fresh; a read-only/capture-only run reports the pre-existing
    // artifact's status.
    const transcriptStatus = classifyTranscript(artifactPath, gitCwd, ctx.root);

    const report: LiveSmokeTranscriptReport = {
      storyId: args.storyId,
      phase: readinessReport.phase,
      mode: { runCommands: actual !== null, writeEvidence: persisted },
      expected,
      transcript: {
        status: transcriptStatus,
        artifactPath,
        artifactRel,
      },
      actual,
      readinessRow: liveSmokeReadinessRow(readinessReport),
      liveSmokeTranscriptRef: readinessReport.artifacts.liveSmokeTranscriptRef,
      metadataOnlyWaiverRef: readinessReport.artifacts.metadataOnlyWaiverRef,
      write: {
        requested: writeRequested,
        persisted,
        artifactPath: persisted ? artifactPath : null,
      },
      claims: {
        authorityDone: false,
        fullAuthorityDone: false,
        productionDone: false,
      },
    };

    return wantsJson(args) ? report : renderLiveSmokeTranscriptReport(report);
  }

  return {
    live_smoke_transcript: liveSmokeTranscript,
  };
}
