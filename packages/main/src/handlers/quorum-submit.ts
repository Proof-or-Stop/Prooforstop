import { rethrowIntentAmendmentIntegrityError } from '../core/verification-intent-amendment.js';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { hostname } from 'node:os';
import { execFileSync } from 'node:child_process';
import type { HandlerContext } from './context.js';
import { resolveStoryCommandWorkspace } from './context.js';
import { submitLocalVerdictWithOutputIdentity, type FormatArgs } from './verdict.js';
import {
  captureLifecycleMetadataTransaction,
  commitLifecycleMetadataTransaction,
  readLifecycleMetadataOutputHashes,
  type LifecycleMetadataTransaction,
} from '../core/auto-commit-metadata.js';
import type { ImmutableMetadataCommitTestHooks } from '../core/done-prepare-generated-metadata.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash, EMPTY_STORY_FILES_HASH } from '../core/evidence-freshness.js';
import { deriveCanonicalHostKeyId, deriveHostVerdictBindings } from '../core/host-verdict-bindings.js';
import { normalizeRelPath } from '../core/proof-or-stop-paths.js';
import { assessReviewHostAvailabilityForFallbackEligibility, evaluateReviewEscalation } from '../core/review-escalation.js';
import { evaluateReviewAssuranceFloor } from '../core/review-assurance-floor.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import { createReviewEscalationHandlers } from './review-escalation.js';
import { isCanonicalStoryId } from '../core/lifecycle-registry.js';
import { collectReviewerEvidenceState } from '../core/review-run.js';
import { canonicalReviewerLane } from '../core/reviewer-opt-in.js';
import { detectMdTouchpointsFromGit } from '../core/touchpoints-fallback.js';
import { computeActiveReviewers, computeFinalReviewRoster } from './reviewer-list.js';
import { readGitBlobAt } from '../core/git-blob-reader.js';
import {
  inspectControllerConfigProjectionReceipt,
  inspectControllerRuntimeProjectionReceipt,
  isByteIdenticalControllerConfig,
  isByteIdenticalControllerRuntimeAsset,
  isMaterialExcludedRuntimeArtifactPath,
} from '../core/runtime-artifact-registry.js';

const REFUSAL = 'quorum_submit refuses: no current reviewer pass evidence for the required lanes — run the review lanes (review_run_start + review_pass_set) first; quorum_submit will not fabricate a floor quorum without a real review.';

type QuorumSubmitArgs = {
  storyId: string;
  hostA?: string;
  hostB?: string;
  /** Run 14: one step for a single-host environment (probe, fallback, missing single-host rounds). */
  singleHost?: boolean;
  rounds?: number | string;
  validationDigest?: string;
  promptDigestA?: string;
  promptDigestB?: string;
  keyA?: string;
  keyB?: string;
  sessionA?: string;
  sessionB?: string;
  providerA?: string;
  providerB?: string;
  note?: string;
} & FormatArgs;

type HostSide = 'A' | 'B';

interface QuorumHostInput {
  side: HostSide;
  hostId: string;
  provider: string;
  sessionId: string;
  keyId: string;
  promptDigest: string;
}

interface RequiredReviewerPass {
  lane: string;
  passId: string;
  reviewRunId?: string;
}

export interface QuorumSubmitTestHooks {
  metadataCommit?: ImmutableMetadataCommitTestHooks;
  beforeCaptureOwnedVerdict?: (args: { verdictId: string; emittedCount: number; projectRoot: string }) => void;
  afterVerdictWrite?: (args: { verdictId: string; emittedCount: number; projectRoot: string }) => void;
  /**
   * B-3144 F-028: invoked after the FIRST (pre-baseline) duplicate guard and before the clean
   * baseline check + transaction capture. Exists so a test can script the exact concurrent
   * interleaving the guard must survive: a competing invocation that commits its own quorum inside
   * this window, i.e. after we observed "no standing quorum" but before we captured HEAD.
   */
  beforeTransactionCapture?: (args: { storyId: string; materialDigest: string }) => void;
}

function wantsJson(args: FormatArgs | undefined): boolean {
  return args?.json === true || args?.format === 'json';
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeIdentity(value: unknown): string {
  return normalizeString(value).toLowerCase();
}

function toLane(name: string): string {
  return canonicalReviewerLane(name)
    ?? (name.startsWith('proof-or-stop-review-') ? name : `proof-or-stop-review-${name}`);
}

function parseRounds(value: unknown): number {
  const rounds = value === undefined ? 3 : Math.floor(Number(value));
  if (!Number.isFinite(rounds) || rounds < 1) {
    throw new Error('quorum_submit: rounds must be a positive integer');
  }
  return rounds;
}

function derivedSession(storyId: string, hostId: string): string {
  return `quorum:${storyId}:${hostId}:session`;
}

function assertHostIndependence(hostA: QuorumHostInput, hostB: QuorumHostInput): void {
  const shared: string[] = [];
  if (normalizeIdentity(hostA.hostId) === normalizeIdentity(hostB.hostId)) shared.push('hostId');
  if (normalizeIdentity(hostA.sessionId) === normalizeIdentity(hostB.sessionId)) shared.push('sessionId');
  if (normalizeIdentity(hostA.keyId) === normalizeIdentity(hostB.keyId)) shared.push('keyId');
  if (shared.length > 0) {
    throw new Error(`quorum_submit: hostA and hostB must be independent; shared ${shared.join(', ')} would collapse the quorum`);
  }
}

function safeReadChecklist(ctx: HandlerContext, storyId: string) {
  try {
    return ctx.store.readChecklist(storyId);
  } catch (intentIntegrityError) { rethrowIntentAmendmentIntegrityError(intentIntegrityError);
    return { items: [] };
  }
}

function safeReadDecision(ctx: HandlerContext, storyId: string) {
  try {
    return ctx.store.readDecision(storyId);
  } catch {
    return null;
  }
}

function safeReadTestEvidence(ctx: HandlerContext, storyId: string): unknown {
  try {
    return ctx.store.readTestEvidence(storyId);
  } catch {
    return null;
  }
}

function requiredReviewRoster(ctx: HandlerContext, storyId: string, projectRoot: string) {
  const story = ctx.store.readStory(storyId);
  const checklist = safeReadChecklist(ctx, storyId);
  const decision = safeReadDecision(ctx, storyId);
  const understanding = ctx.store.readUnderstanding(storyId);
  const touchpoints = understanding?.touchpoints ?? detectMdTouchpointsFromGit(projectRoot);
  const active = computeActiveReviewers(story, checklist, decision, touchpoints);
  return computeFinalReviewRoster(ctx.store, projectRoot, storyId, active);
}

function assertCurrentReviewerPasses(ctx: HandlerContext, storyId: string, projectRoot: string, roster: ReturnType<typeof requiredReviewRoster>): RequiredReviewerPass[] {
  const story = ctx.store.readStory(storyId);
  if (!story.currentReviewRound) {
    throw new Error(`${REFUSAL}\nDetails: story has no currentReviewRound, so no current signed reviewer pass can be proven.`);
  }
  const requiredLanes = roster.requiredReviewers.map(reviewer => toLane(reviewer.name));
  const state = collectReviewerEvidenceState(ctx.store, storyId, projectRoot);
  const validPasses = state.valid.filter(evidence => evidence.kind === 'pass');
  const passByLane = new Map(validPasses.map(evidence => [canonicalReviewerLane(evidence.agent) ?? evidence.agent, evidence]));
  const missing = requiredLanes.filter(lane => !passByLane.has(lane));
  if (missing.length > 0 || state.invalid.length > 0) {
    const details = [
      ...(missing.length > 0 ? [`missing current pass lane(s): ${missing.join(', ')}`] : []),
      ...state.invalid.slice(0, 8).map(issue => `${issue.agent}: ${issue.message}`),
    ];
    throw new Error(`${REFUSAL}${details.length > 0 ? `\nDetails: ${details.join('\n')}` : ''}`);
  }
  return requiredLanes.map((lane) => {
    const pass = passByLane.get(lane)!;
    return {
      lane,
      passId: pass.id,
      ...(pass.reviewRunId ? { reviewRunId: pass.reviewRunId } : {}),
    };
  });
}

function formatResult(result: QuorumSubmitResult): string {
  return [
    `Quorum submit (${result.schemaVersion})`,
    `storyId: ${result.storyId}`,
    `verdictIds: ${result.verdictIds.join(', ')}`,
    `runIds: ${result.runIds.join(', ')}`,
    `materialDigest: ${result.materialDigest}`,
    `storyFilesHash: ${result.storyFilesHash}`,
    `validationDigest: ${result.validationDigest}`,
    `metadataCommitSha: ${result.metadataCommitSha}`,
    `promptDigestA: ${result.promptDigests.hostA}`,
    `promptDigestB: ${result.promptDigests.hostB}`,
    `reviewerPasses: ${result.reviewerPasses.length}/${result.requiredReviewerLanes.length} required lanes current; ${result.reviewSelection.activeLanes.length} active lanes`,
    `reviewSelection: ${result.reviewSelection.reason}; digest=${result.reviewSelection.digest}; excluded=${result.reviewSelection.activeLanes.filter(lane => !result.reviewSelection.requiredLanes.includes(lane)).join(',') || 'none'}`,
    `voluntaryLocalRounds: ${result.reviewEscalationStatus.voluntaryLocalRounds.validRoundCount}/${result.reviewEscalationStatus.voluntaryLocalRounds.requiredRounds} rounds x ${result.reviewEscalationStatus.voluntaryLocalRounds.requiredPassingHostsPerRound} hosts (complete=${result.reviewEscalationStatus.voluntaryLocalRounds.complete})`,
    'admissibilityStatus: local-quorum-recorded',
    `assuranceLevel: ${result.reviewEscalationStatus.assuranceLevel}`,
    'evidenceScope: local-review-quorum',
  ].join('\n');
}

interface QuorumSubmitResult {
  schemaVersion: 'proof-or-stop.quorum_submit.v1';
  storyId: string;
  rounds: number;
  emittedCount: number;
  verdictIds: string[];
  runIds: string[];
  materialDigest: string;
  storyFilesHash: string;
  validationDigest: string;
  metadataCommitSha: string;
  promptDigests: {
    hostA: string;
    hostB: string;
  };
  hosts: {
    hostA: QuorumHostInput;
    hostB: QuorumHostInput;
  };
  requiredReviewerLanes: string[];
  reviewSelection: { activeLanes: string[]; requiredLanes: string[]; reason: string; digest: string };
  reviewerPasses: RequiredReviewerPass[];
  verdicts: Array<{
    verdictId: string;
    runId: string;
    hostId: string;
    provider: string;
    sessionId: string;
    keyId?: string;
  }>;
  reviewEscalationStatus: ReturnType<typeof evaluateReviewEscalation>;
  authorityDone: false;
  fullAuthorityDone: false;
  productionDone: false;
}

/**
 * `git status` rows that make the atomic verdict batch refuse.
 *
 * Every tracked change, staged entry, and untracked product file blocks, as
 * before. An untracked path the framework itself owns does not: a registered
 * runtime artifact (runtime-artifact registry, materialHash=exclude) or a
 * controller projection (native hooks / config / Story receipt) whose signed
 * byte-identity proof verifies for this Story. Those files are never staged by
 * the batch (it commits through an isolated index), and without this a project
 * whose tracked .gitignore lacks the runtime block could never submit (run 11).
 */
export function quorumBaselineBlockingRows(gitCwd: string, storyId: string): string[] {
  const fields = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: gitCwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).split('\0');
  const blocking: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const row = fields[index];
    if (!row) continue;
    const code = row.slice(0, 2);
    const path = row.slice(3);
    // Rename/copy rows carry the source path as the next NUL field.
    if (/[RC]/.test(code)) index += 1;
    if (code === '??' && isFrameworkOwnedUntrackedPath(gitCwd, storyId, path)) continue;
    blocking.push(`${code} ${path}`);
  }
  return blocking;
}

function isFrameworkOwnedUntrackedPath(gitCwd: string, storyId: string, path: string): boolean {
  if (isMaterialExcludedRuntimeArtifactPath(path)) return true;
  const proof = { projectRoot: gitCwd, gitCwd, storyId, path };
  return isByteIdenticalControllerConfig(proof)
    || isByteIdenticalControllerRuntimeAsset(proof)
    || inspectControllerRuntimeProjectionReceipt(proof).valid
    || inspectControllerConfigProjectionReceipt(proof).valid;
}

function assertCleanQuorumBaseline(gitCwd: string, storyId: string): void {
  const dirty = quorumBaselineBlockingRows(gitCwd, storyId);
  if (dirty.length > 0) {
    throw new Error(`quorum_submit refuses: worktree/index must be clean before the atomic verdict batch; pre-existing bytes were left untouched: ${dirty.join('\n')}`);
  }
}

interface OwnedQuorumEventRecord {
  start: number;
  end: number;
  bytes: Buffer;
}

function expectedOwnedProcessBytes(
  capture: LifecycleMetadataTransaction,
  eventRecords: readonly OwnedQuorumEventRecord[],
): Buffer {
  const state = capture.transaction.states[0];
  if (!state) throw new Error('quorum transaction lost process-events baseline');
  return Buffer.concat([state.worktreeContent ?? Buffer.alloc(0), ...eventRecords.map(record => record.bytes)]);
}

function assertExactQuorumAppend(args: {
  projectRoot: string;
  capture: LifecycleMetadataTransaction;
  eventRecords: readonly OwnedQuorumEventRecord[];
}): void {
  const state = args.capture.transaction.states[0];
  if (!state || args.capture.transaction.states.length !== 1) {
    throw new Error('quorum transaction must own exactly process-events.jsonl');
  }
  const baseline = state.worktreeContent ?? Buffer.alloc(0);
  const current = readFileSync(join(args.projectRoot, state.path));
  if (current.length < baseline.length || !current.subarray(0, baseline.length).equals(baseline)) {
    throw new Error('canonical process-events bytes changed before the quorum batch could be verified');
  }
  const expected = expectedOwnedProcessBytes(args.capture, args.eventRecords);
  if (!current.equals(expected)) {
    throw new Error(`quorum transaction changed bytes outside its append boundary or did not retain the exact canonical host_verdict bytes for its ${args.eventRecords.length} generated rows`);
  }
}

function quorumStoryRel(projectRoot: string, ctx: HandlerContext, storyId: string): string {
  const rel = normalizeRelPath(relative(projectRoot, ctx.store.storyDirPath(storyId)));
  if (!rel || rel === '.' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    throw new Error(`quorum_submit: canonical story metadata path is outside the signed workspace (${rel || '<empty>'})`);
  }
  return rel;
}

function committedHostVerdictEvents(
  gitCwd: string,
  storyRel: string,
  // B-3144 F-028: the duplicate guard must be able to read the log at an EXACT commit, not just at
  // whatever HEAD happens to be when the call is made. The post-capture re-check binds itself to
  // the SHA the transaction froze, so a competing quorum that landed between the two checks is
  // read from the same commit the transaction is about to build on.
  ref = 'HEAD',
): Array<Record<string, unknown>> {
  const path = `${storyRel}/process-events.jsonl`;
  const read = readGitBlobAt(gitCwd, ref, path);
  if (read.status === 'missing') return [];
  if (read.status === 'error') {
    throw new Error(`quorum_submit refuses: committed process-events could not be read (${read.reason})`);
  }
  return read.content.toString('utf8').split('\n').filter(Boolean).flatMap((line) => {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      return event.type === 'host_verdict' ? [event] : [];
    } catch {
      return [];
    }
  });
}

function rollbackQuorumOutputs(args: {
  projectRoot: string;
  capture: LifecycleMetadataTransaction;
  storyId: string;
  eventRecords: readonly OwnedQuorumEventRecord[];
  verdictFiles: ReadonlyMap<string, { filePath: string; bytes: Buffer }>;
}): { ok: boolean; reason?: string } {
  const state = args.capture.transaction.states[0];
  if (!state || args.capture.transaction.states.length !== 1) {
    return { ok: false, reason: 'quorum rollback transaction did not contain exactly process-events.jsonl' };
  }
  const processEventsPath = join(args.projectRoot, state.path);
  const baseline = state.worktreeContent ?? Buffer.alloc(0);
  const current = existsSync(processEventsPath) ? readFileSync(processEventsPath) : Buffer.alloc(0);
  if (current.length < baseline.length) {
    return { ok: false, reason: `${state.path}: pre-quorum bytes changed; concurrent bytes preserved` };
  }
  const baselineConflict = !current.subarray(0, baseline.length).equals(baseline);
  const spans: Array<{ start: number; end: number }> = [];
  const missingRows: number[] = [];
  for (const [index, record] of args.eventRecords.entries()) {
    const startsAtRecordBoundary = record.start === baseline.length || current[record.start - 1] === 0x0a;
    const exactAtCapturedOffset = record.start >= baseline.length
      && record.end <= current.length
      && current.subarray(record.start, record.end).equals(record.bytes);
    const endsAtRecordBoundary = record.bytes.at(-1) === 0x0a;
    if (!startsAtRecordBoundary || !exactAtCapturedOffset || !endsAtRecordBoundary) missingRows.push(index);
    else spans.push({ start: record.start, end: record.end });
  }
  spans.sort((left, right) => left.start - right.start);
  const overlap = spans.some((span, index) => index > 0 && span.start < spans[index - 1].end);
  if (overlap) return { ok: false, reason: `${state.path}: owned byte spans overlap; concurrent bytes preserved` };
  if (spans.length > 0) {
    const kept: Buffer[] = [];
    let cursor = 0;
    for (const span of spans) {
      kept.push(current.subarray(cursor, span.start));
      cursor = span.end;
    }
    kept.push(current.subarray(cursor));
    const restored = Buffer.concat(kept);
    writeFileSync(processEventsPath, restored);
  }
  const conflicts: string[] = [];
  if (missingRows.length > 0 && !current.equals(baseline)) {
    conflicts.push(`${state.path}: ${missingRows.length} owned row byte span(s) changed and were preserved`);
  }
  for (const [, owned] of args.verdictFiles) {
    const path = owned.filePath;
    if (!existsSync(path)) continue;
    try {
      const stored = readFileSync(path);
      if (!stored.equals(owned.bytes)) {
        conflicts.push(`${path}: verdict bytes changed`);
        continue;
      }
      rmSync(path);
    } catch {
      conflicts.push(`${path}: verdict bytes could not be inspected`);
    }
  }
  if (baselineConflict) conflicts.unshift(`${state.path}: pre-quorum bytes changed and were preserved`);
  return conflicts.length > 0
    ? { ok: false, reason: `rollback conflicts preserved: ${conflicts.join(', ')}` }
    : { ok: true };
}

function validateOwnedVerdictOutput(args: {
  eventRow: Buffer;
  verdictBytes: Buffer;
  verdict: {
    verdictId: string;
    runId: string;
    hostId: string;
    provider: string;
    sessionId: string;
    keyId?: string;
    decision: string;
    materialDigest: string;
    storyFilesHash?: string;
    validationDigest?: string;
    promptDigest?: string;
  };
}): void {
  const eventRow = args.eventRow;
  if (eventRow[eventRow.length - 1] !== 0x0a || eventRow.subarray(0, -1).includes(0x0a)) {
    throw new Error('quorum verdict writer must append exactly one newline-terminated event row');
  }
  const event = JSON.parse(eventRow.subarray(0, -1).toString('utf8')) as Record<string, unknown>;
  const expected = {
    type: 'host_verdict',
    mode: 'local',
    verdictId: args.verdict.verdictId,
    runId: args.verdict.runId,
    hostId: args.verdict.hostId,
    provider: args.verdict.provider,
    sessionId: args.verdict.sessionId,
    keyId: args.verdict.keyId,
    decision: args.verdict.decision,
    materialDigest: args.verdict.materialDigest,
    ...(args.verdict.storyFilesHash ? { storyFilesHash: args.verdict.storyFilesHash } : {}),
    validationDigest: args.verdict.validationDigest,
    promptDigest: args.verdict.promptDigest,
  };
  const keys = Object.keys(event).filter(key => key !== 'timestamp').sort();
  const expectedKeys = Object.keys(expected).filter(key => expected[key as keyof typeof expected] !== undefined).sort();
  if (
    typeof event.timestamp !== 'string'
    || keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])
    || expectedKeys.some(key => event[key] !== expected[key as keyof typeof expected])
  ) {
    throw new Error('quorum verdict writer did not emit its full canonical host_verdict envelope');
  }
  const canonicalVerdictBytes = Buffer.from(`${JSON.stringify(args.verdict, null, 2)}\n`);
  if (!args.verdictBytes.equals(canonicalVerdictBytes)) {
    throw new Error('quorum verdict writer did not retain the exact canonical verdict JSON bytes');
  }
}

export interface SingleHostAssuranceResult {
  schemaVersion: 'proof-or-stop.quorum_submit_single_host.v1';
  storyId: string;
  materialDigest: string;
  storyFilesHash: string;
  probeId: string | null;
  probed: boolean;
  fallbackId: string | null;
  roundsRecorded: number;
  runIds: string[];
  verdictIds: string[];
  host: { hostId: string; provider: string; sessionId: string; keyId: string } | null;
  reviewerPasses: RequiredReviewerPass[];
  metadataCommitSha: string | null;
  satisfied: boolean;
  authorityDone: false;
  fullAuthorityDone: false;
  productionDone: false;
}

/**
 * What the DONE review-assurance rows still need on a single host, read from
 * their own evaluators (review escalation + review-assurance floor): missing
 * 1-host rounds, whether a degraded single-host fallback must be recorded, or
 * why a single host cannot satisfy them (explicit 3x2-only policy).
 */
export function singleHostAssuranceNeed(ctx: HandlerContext, storyId: string): { rounds: number; fallback: boolean; refusal?: string } {
  const gitCwd = resolveGitCwd({ store: ctx.store, storyId, metadataRoot: ctx.root, projectRoot: ctx.root });
  const args = { projectRoot: ctx.root, gitCwd, storyId, store: ctx.store };
  const escalation = evaluateReviewEscalation(args);
  const floor = evaluateReviewAssuranceFloor(args);
  let rounds = 0;
  let fallback = false;
  if (escalation.required && !escalation.ok) {
    if (escalation.trigger.explicitHighRiskPolicy.validPolicy?.degradedFallbackAllowed === false) {
      return { rounds: 0, fallback: false, refusal: 'the explicit high-risk review policy disallows the degraded single-host fallback; it needs a 3x2 quorum of independent hosts' };
    }
    rounds = Math.max(rounds, escalation.degradedFallback.requiredRounds - escalation.degradedFallback.validRounds.length);
    if (!escalation.degradedFallback.allowed) fallback = true;
  }
  if (floor.required && !floor.ok) {
    if (floor.highRiskSignals.length > 0) {
      rounds = Math.max(rounds, floor.degradedFallback.requiredRounds - floor.degradedFallback.validRounds.length);
      if (!floor.degradedFallback.allowed) fallback = true;
    } else {
      rounds = Math.max(rounds, floor.localRounds.requiredRounds - floor.localRounds.validRounds.length);
    }
  }
  return { rounds: Math.max(0, rounds), fallback };
}

function assessSingleHost(ctx: HandlerContext, storyId: string) {
  const gitCwd = resolveGitCwd({ store: ctx.store, storyId, metadataRoot: ctx.root, projectRoot: ctx.root });
  const materialHash = currentMaterialHash(gitCwd, 'HEAD', ctx.root) ?? '';
  return assessReviewHostAvailabilityForFallbackEligibility(ctx.store.readProcessEvents(storyId), 'single-host-environment',
    materialHash, currentStoryFilesHash(gitCwd, 'HEAD', ctx.root) ?? null);
}

/**
 * next-driver predicate: the single-host step can run now (TEST, something is
 * missing, every required lane has a current reviewer pass, and no fresh probe
 * already shows two review-ready hosts). Read-only.
 */
export function singleHostAssuranceReady(ctx: HandlerContext, storyId: string): { ok: boolean; reason: string } {
  try {
    if (ctx.store.readStory(storyId).phase !== 'TEST') return { ok: false, reason: 'not in TEST' };
    const need = singleHostAssuranceNeed(ctx, storyId);
    if (need.refusal) return { ok: false, reason: need.refusal };
    if (need.rounds === 0 && !need.fallback) return { ok: false, reason: 'nothing missing' };
    if (need.fallback) {
      const assessment = assessSingleHost(ctx, storyId);
      if (assessment.latestFreshProbe && !assessment.ok) return { ok: false, reason: assessment.reasons.join('; ') };
    }
    const projectRoot = resolveStoryCommandWorkspace(ctx.store, storyId, ctx.root).signedWorkspaceRoot;
    assertCurrentReviewerPasses(ctx, storyId, projectRoot, requiredReviewRoster(ctx, storyId, projectRoot));
    return { ok: true, reason: 'ready' };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Old-PoS run 40 (§6): bounded redo of a single-host closeout another writer's concurrent metadata refused. */
const SINGLE_HOST_CONCURRENT_WRITER_RETRIES = 2;
const SINGLE_HOST_CONCURRENT_WRITER_WAIT_MS = 20_000;

/**
 * A closeout refusal caused by another writer's concurrent metadata, after
 * which nothing of this closeout remains (every emitted verdict rolled back,
 * or the capture refused before writing): safe to redo once that writer is done.
 */
export function transientConcurrentCloseout(message: string): boolean {
  if (/canonical metadata was already dirty before quorum-submit/.test(message)) return true;
  // The clean-baseline refusal when the only pending bytes are another writer's journal append.
  const baseline = message.match(/worktree\/index must be clean before the atomic verdict batch; pre-existing bytes were left untouched: ([\s\S]*)$/);
  if (baseline) {
    const rows = baseline[1]!.split('\n').map(row => row.trim()).filter(Boolean);
    return rows.length > 0 && rows.every(row => /\/process-events\.jsonl$/.test(row));
  }
  return /all emitted verdicts were rolled back/.test(message)
    && /concurrent divergence preserved|HEAD changed before isolated metadata commit CAS|publication refused before HEAD CAS/.test(message);
}

/** Block until the Story metadata directory has no uncommitted change (true), or the wait ends (false). */
function waitForCleanStoryMetadata(gitCwd: string, storyRel: string, maxMs: number): boolean {
  const deadline = Date.now() + maxMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    let dirty = 'unknown';
    try { dirty = execFileSync('git', ['status', '--porcelain', '--', storyRel], { cwd: gitCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { dirty = 'unknown'; }
    if (!dirty) return true;
    if (Date.now() >= deadline) return false;
    Atomics.wait(sleeper, 0, 0, 250);
  }
}

export function createQuorumSubmitHandlers(ctx: HandlerContext, testHooks: QuorumSubmitTestHooks = {}) {
  /**
   * One atomic host-verdict batch: every planned runId x host, committed as one
   * `quorum-submit` lifecycle metadata transaction or rolled back entirely.
   */
  function emitVerdictBatch(input: {
    label: string;
    storyId: string;
    projectRoot: string;
    gitCwd: string;
    materialDigest: string;
    storyFilesHash: string;
    validationDigest: string;
    note: string;
    runIds: string[];
    hosts: QuorumHostInput[];
  }): { emitted: QuorumSubmitResult['verdicts']; runIds: string[]; metadataCommitSha: string; reviewEscalationStatus: ReturnType<typeof evaluateReviewEscalation> } {
    const { storyId, projectRoot, gitCwd, materialDigest, storyFilesHash, validationDigest, note } = input;
    const storyRel = quorumStoryRel(gitCwd, ctx, storyId);
    // Guard: refuse to re-submit a quorum for a runId that already carries a verdict the
    // floor would still count at evaluation time. Two collision branches:
    //   (a) SAME materialDigest — an exact-material duplicate would pile redundant verdicts
    //       onto an already-populated runId. Existing message preserved.
    //   (b) STALE materialDigest but matching storyFilesHash — a drift-accept collision. The
    //       review-escalation floor rewrites such stale-material verdicts to the current
    //       material (eventsWithStoryFilesHashDowngrade, core/review-escalation.ts:948-969)
    //       whenever storyFilesHash is unchanged, which is the normal effect of `git merge
    //       main` (materialHash moves, story-owned diff does not). If we accepted the
    //       re-submit here, the old + new verdicts would share the deterministic runIds and
    //       host/session/key identities and every round would then collapse as "duplicate
    //       host/session/key identity" — the B-bf52 poisoning.
    //
    // LOCKSTEP: branch (b) mirrors eventsWithStoryFilesHashDowngrade EXACTLY. A committed
    // event with a blank/absent storyFilesHash is treated as no-signal and never collides on
    // this branch, matching the floor. If a future floor-hardening story changes the
    // drift-accept predicate, THIS guard MUST be updated in the same story to keep
    // producer/consumer parity; otherwise the guard would over-block resubmissions the floor
    // would no longer drift-accept (or under-block ones it no longer would). review_escalation_status
    // reveals any such mismatch.
    //
    // B-3144 F-035: the floor's top-level EMPTY_STORY_FILES_HASH exclusion (B-f88e,
    // review-escalation.ts:975 — currentStoryFilesHash===EMPTY_STORY_FILES_HASH disables ALL
    // downgrades, since two "owns zero files" hashes are not evidence anything is unchanged) was
    // missing here. Without it, a story with EMPTY_STORY_FILES_HASH would have this guard
    // over-block: it would see a stale-material event whose storyFilesHash also happens to equal
    // EMPTY_STORY_FILES_HASH, treat it as a drift-accept collision, and refuse a resubmit the
    // floor is NOT actually drift-accepting (the floor ignores that event entirely) — falsely
    // claiming "nothing needs resubmitting" while the floor holds zero valid assurance for that
    // round. Mirrored the floor's exact top-level exclusion below.
    //
    // B-3144 F-029: the same-material branch compares the NORMALIZED material on both sides,
    // exactly as the consumer does (core/host-independence.ts normalizes event.materialDigest
    // before comparing it to the current material hash). A raw comparison left a hole between the
    // two branches: a committed verdict whose materialDigest carries surrounding whitespace still
    // COUNTS at the floor (the consumer trims it), yet raw equality was false here, and the drift
    // branch — which already normalized — saw current material and was false too. Both producer
    // branches missed it, so a re-submit could still poison that run.
    //
    // B-3144 F-028: this check is TIME-OF-CHECK only. It reads the log at the HEAD of this
    // moment, while the transaction that decides what gets appended captures HEAD later, so two
    // concurrent invocations could both observe "no standing quorum" and the second would append
    // a second identical quorum onto the same runIds. It is therefore run TWICE: once here (so a
    // redundant call refuses before doing any work) and once again immediately after the capture,
    // bound to the SHA the transaction froze. Both runs use the same predicates and the same two
    // refusal messages.
    const plannedRunIds = new Set<string>(input.runIds);
    const normalizedMaterialDigest = normalizeString(materialDigest);
    const assertNoStandingQuorum = (ref: string): void => {
      const committedForGuard = committedHostVerdictEvents(gitCwd, storyRel, ref)
        .filter(event => event.type === 'host_verdict' && plannedRunIds.has(normalizeString(event.runId)));
      const sameMaterialRunIds = [...new Set(
        committedForGuard
          .filter(event => normalizeString(event.materialDigest) === normalizedMaterialDigest)
          .map(event => normalizeString(event.runId)),
      )].sort();
      if (sameMaterialRunIds.length > 0) {
        throw new Error(`quorum_submit refuses: verdicts already exist for runId(s) ${sameMaterialRunIds.join(', ')} at the current material (${materialDigest}); re-submitting would duplicate the quorum. Re-run only after the material changes (a new commit), or use a fresh review round.`);
      }
      // F-035: matches eventsWithStoryFilesHashDowngrade's top-level guard exactly — when the
      // CURRENT storyFilesHash is the empty-set sentinel, no event can ever drift-accept
      // (two EMPTY_STORY_FILES_HASH values are not evidence of "unchanged").
      const driftAcceptEvents = storyFilesHash === EMPTY_STORY_FILES_HASH ? [] : committedForGuard.filter((event) => {
        const eventMaterial = normalizeString(event.materialDigest);
        const eventStoryFilesHash = normalizeString(event.storyFilesHash);
        return eventMaterial !== ''
          && eventMaterial !== normalizedMaterialDigest
          && eventStoryFilesHash !== ''
          && eventStoryFilesHash === storyFilesHash;
      });
      if (driftAcceptEvents.length > 0) {
        const driftRunIds = [...new Set(driftAcceptEvents.map(event => normalizeString(event.runId)))].sort();
        const standingMaterials = [...new Set(driftAcceptEvents.map(event => normalizeString(event.materialDigest)))].sort();
        throw new Error(
          `quorum_submit refuses: the standing quorum on runId(s) ${driftRunIds.join(', ')} at the older material(s) `
          + `${standingMaterials.join(', ')} still drift-accepts because storyFilesHash is unchanged `
          + `(${storyFilesHash}); the review-escalation floor rewrites those verdicts to the current material, so `
          + `nothing needs resubmitting. A re-submit would poison the rounds as duplicate host/session/key identity. `
          + `Check review_escalation_status to confirm the standing quorum, and note that a fresh quorum becomes `
          + `possible only when the story-owned files change (storyFilesHash moves), not merely the whole-tree material.`,
        );
      }
    };
    assertNoStandingQuorum('HEAD');

    testHooks.beforeTransactionCapture?.({ storyId, materialDigest });
    assertCleanQuorumBaseline(gitCwd, storyId);
    const transaction = captureLifecycleMetadataTransaction({
      root: gitCwd,
      gitCwd,
      storyId,
      storyRel,
      kind: 'quorum-submit',
    });
    // F-028: re-check bound to the captured HEAD. Everything this call is about to append is
    // built on transaction.headHash, so the question "does a standing quorum already exist" must
    // be answered against THAT commit. A competitor that committed its quorum between the first
    // check and this capture is now visible, and we refuse instead of appending a second
    // identical quorum onto the same runIds. Nothing has been written yet, so the refusal needs
    // no rollback and leaves the same clean state the first check does.
    assertNoStandingQuorum(transaction.headHash);
    const emitted: QuorumSubmitResult['verdicts'] = [];
    const runIds: string[] = [];
    const ownedEventRecords: OwnedQuorumEventRecord[] = [];
    const ownedVerdictFiles = new Map<string, { filePath: string; bytes: Buffer }>();
    try {
      for (const runId of input.runIds) {
        runIds.push(runId);
        for (const host of input.hosts) {
          const written = submitLocalVerdictWithOutputIdentity(ctx, {
            storyId,
            runId,
            hostId: host.hostId,
            provider: host.provider,
            sessionId: host.sessionId,
            keyId: host.keyId,
            decision: 'pass',
            materialDigest,
            storyFilesHash,
            validationDigest,
            promptDigest: host.promptDigest,
            note,
          });
          const { verdict, outputIdentity } = written;
          emitted.push({
            verdictId: verdict.verdictId,
            runId: verdict.runId,
            hostId: verdict.hostId,
            provider: verdict.provider,
            sessionId: verdict.sessionId,
            keyId: verdict.keyId,
          });
          const eventRow = outputIdentity.processEvent.eventBytes;
          ownedEventRecords.push({
            start: outputIdentity.processEvent.start,
            end: outputIdentity.processEvent.end,
            bytes: eventRow,
          });
          ownedVerdictFiles.set(verdict.verdictId, outputIdentity.verdictJson);
          testHooks.beforeCaptureOwnedVerdict?.({
            verdictId: verdict.verdictId,
            emittedCount: emitted.length,
            projectRoot,
          });
          validateOwnedVerdictOutput({
            eventRow,
            verdictBytes: outputIdentity.verdictJson.bytes,
            verdict,
          });
          testHooks.afterVerdictWrite?.({
            verdictId: verdict.verdictId,
            emittedCount: emitted.length,
            projectRoot,
          });
        }
      }

      const reviewEscalationStatus = evaluateReviewEscalation({
        projectRoot,
        storyId,
        store: ctx.store,
        materialHash: materialDigest,
        storyFilesHash,
      });
      assertExactQuorumAppend({
        projectRoot: gitCwd,
        capture: transaction,
        eventRecords: ownedEventRecords,
      });
      const hashes = readLifecycleMetadataOutputHashes({ root: gitCwd, capture: transaction });
      if (!hashes.ok) throw new Error(hashes.reason);
      const committed = commitLifecycleMetadataTransaction({
        root: gitCwd,
        gitCwd,
        storyId,
        capture: transaction,
        verifiedHashes: hashes.hashes,
        testHooks: testHooks.metadataCommit,
      });
      if (!committed.ok) throw new Error(committed.reason || 'immutable quorum metadata commit failed');
      if (!committed.commitSha) throw new Error('immutable quorum metadata commit produced no commit SHA');
      return { emitted, runIds, metadataCommitSha: committed.commitSha, reviewEscalationStatus };
    } catch (error) {
      const rolledBack = rollbackQuorumOutputs({
        projectRoot: gitCwd,
        capture: transaction,
        storyId,
        eventRecords: ownedEventRecords,
        verdictFiles: ownedVerdictFiles,
      });
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${input.label} atomic closeout failed: ${message}`
        + (rolledBack.ok ? '; all emitted verdicts were rolled back' : `; ${rolledBack.reason}`),
      );
    }
  }

  /**
   * Run 14 (TEST cost ~5.2 min): on a single host the owner had to discover the
   * environment, run review_host_availability_probe, record
   * review_escalation_fallback_set and submit 3 autopilot_review_submit rounds
   * by hand. This is the same rule in one step. Nothing is weakened:
   *   - the round count and hosts-per-round are the evaluators' own
   *     (review escalation 3 x 1 degraded, review-assurance floor 1 or 3 x 1);
   *   - the degraded single-host-environment fallback is recorded only when a
   *     rule needs it AND this host's own availability probe (fresh for the
   *     current material) finds fewer than 2 review-ready hosts; with 2 ready
   *     hosts it refuses and names the full 3x2 quorum;
   *   - verdicts exist only when every required lane has a current signed
   *     reviewer pass (assertCurrentReviewerPasses, as for the 3x2 quorum):
   *     each round transcribes those real reviews, never a self-attestation;
   *   - probe, fallback and verdict batch keep their own authenticated
   *     metadata commits (review-maintenance lineage subjects).
   */
  function singleHostSubmit(args: QuorumSubmitArgs): SingleHostAssuranceResult | string {
    const storyId = normalizeString(args.storyId);
    if (!storyId || !isCanonicalStoryId(storyId)) throw new Error('quorum_submit --singleHost: a canonical storyId is required');
    if (normalizeString(args.hostA) || normalizeString(args.hostB)) {
      throw new Error('quorum_submit --singleHost takes no hostA/hostB: the single host is this machine; use hostA+hostB without singleHost for a 3x2 quorum');
    }
    const story = ctx.store.readStory(storyId);
    if (story.phase !== 'TEST') {
      throw new Error(`quorum_submit --singleHost records DONE review assurance in TEST; Story ${storyId} is ${story.phase}.`);
    }
    const workspace = resolveStoryCommandWorkspace(ctx.store, storyId, ctx.root);
    const projectRoot = workspace.signedWorkspaceRoot;
    const gitCwd = ctx.root;
    const reviewRoster = requiredReviewRoster(ctx, storyId, projectRoot);
    const reviewerPasses = assertCurrentReviewerPasses(ctx, storyId, projectRoot, reviewRoster);
    const need = singleHostAssuranceNeed(ctx, storyId);
    if (need.refusal) throw new Error(`quorum_submit --singleHost refuses: ${need.refusal}`);

    let probeId: string | null = null;
    let fallbackId: string | null = null;
    let probed = false;
    if (need.fallback) {
      const escalation = createReviewEscalationHandlers(ctx);
      let assessment = assessSingleHost(ctx, storyId);
      if (!assessment.latestFreshProbe) {
        escalation.review_host_availability_probe({ storyId, json: true });
        probed = true;
        assessment = assessSingleHost(ctx, storyId);
      }
      probeId = assessment.latestFreshProbe?.probeId ?? null;
      if (!assessment.ok) {
        throw new Error(`quorum_submit --singleHost refuses: ${assessment.reasons.join('; ')}. This is not a single-host environment, so the rule needs the full 3x2 quorum: proof-or-stop quorum_submit --storyId=${storyId} --hostA=<host> --hostB=<independent host>.`);
      }
      const recorded = escalation.review_escalation_fallback_set({ storyId, eligibility: 'single-host-environment',
        reason: `review_host_availability_probe ${probeId ?? 'latest'} found fewer than 2 review-ready canonical hosts; degraded single-host 3x1 fallback is the only available path`,
        evidenceRefs: [`process-events.jsonl:review_host_availability_probe:${probeId ?? 'latest'}`], json: true }) as { fallbackId?: string };
      fallbackId = recorded.fallbackId ?? null;
    }

    // Old-PoS run 40 (§6): another framework writer (the delivery reviewer's metadata save under the
    // N1 overlap) may append to process-events.jsonl inside this closeout's commit window; the
    // closeout then refuses and rolls itself back completely (fail-closed, unchanged). That is a
    // transient conflict, not a verdict: wait until the other writer's metadata has landed (the
    // Story metadata is clean again) and redo the closeout on the new HEAD, bounded.
    const closeout = () => {
      const materialDigest = currentMaterialHash(projectRoot, 'HEAD', workspace.metadataRoot || ctx.root);
      const storyFilesHash = currentStoryFilesHash(projectRoot, 'HEAD', workspace.metadataRoot || ctx.root);
      if (!materialDigest || !storyFilesHash) throw new Error('quorum_submit --singleHost: cannot compute the current materialHash/storyFilesHash');
      const rounds = singleHostAssuranceNeed(ctx, storyId).rounds;
      let batch: ReturnType<typeof emitVerdictBatch> | null = null;
      let host: QuorumHostInput | null = null;
      if (rounds > 0) {
        const hostId = hostname() || 'single-host';
        const base = {
          side: 'A' as const,
          hostId,
          provider: 'local',
          sessionId: derivedSession(storyId, hostId),
          keyId: deriveCanonicalHostKeyId(storyId, hostId),
        };
        const bindings = deriveHostVerdictBindings({ storyId, headHash: currentGitHead(projectRoot), materialDigest, storyFilesHash,
          testEvidence: safeReadTestEvidence(ctx, storyId), ...base });
        host = { ...base, promptDigest: bindings.promptDigest };
        const occupied = new Set(ctx.store.readProcessEvents(storyId)
          .filter(event => event.type === 'host_verdict').map(event => normalizeString(event.runId)));
        const runIds: string[] = [];
        for (let round = 1; runIds.length < rounds; round += 1) {
          const runId = `${storyId}-sh-r${round}`;
          if (!occupied.has(runId)) runIds.push(runId);
        }
        batch = emitVerdictBatch({ label: 'quorum_submit --singleHost', storyId, projectRoot, gitCwd, materialDigest, storyFilesHash,
          validationDigest: bindings.validationDigest,
          note: normalizeString(args.note) || `single-host round transcribed from current signed reviewer passes ${reviewerPasses.map(pass => pass.passId).join(', ')}`,
          runIds, hosts: [host] });
      }
      return { materialDigest, storyFilesHash, batch, host };
    };
    let closed: ReturnType<typeof closeout> | null = null;
    for (let attempt = 0; closed === null; attempt += 1) {
      // A redo transcribes the same reviews: they must still be the current signed passes.
      if (attempt > 0) assertCurrentReviewerPasses(ctx, storyId, projectRoot, reviewRoster);
      try { closed = closeout(); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt >= SINGLE_HOST_CONCURRENT_WRITER_RETRIES || !transientConcurrentCloseout(message)
          || !waitForCleanStoryMetadata(gitCwd, quorumStoryRel(gitCwd, ctx, storyId), SINGLE_HOST_CONCURRENT_WRITER_WAIT_MS)) throw error;
      }
    }
    const { materialDigest, storyFilesHash, batch, host } = closed;
    const after = singleHostAssuranceNeed(ctx, storyId);
    const result: SingleHostAssuranceResult = {
      schemaVersion: 'proof-or-stop.quorum_submit_single_host.v1',
      storyId,
      materialDigest,
      storyFilesHash,
      probeId,
      probed,
      fallbackId,
      roundsRecorded: batch?.runIds.length ?? 0,
      runIds: batch?.runIds ?? [],
      verdictIds: batch?.emitted.map(verdict => verdict.verdictId) ?? [],
      host: host ? { hostId: host.hostId, provider: host.provider, sessionId: host.sessionId, keyId: host.keyId } : null,
      reviewerPasses,
      metadataCommitSha: batch?.metadataCommitSha ?? null,
      satisfied: after.rounds === 0 && !after.fallback && !after.refusal,
      authorityDone: false,
      fullAuthorityDone: false,
      productionDone: false,
    };
    if (wantsJson(args)) return result;
    return [
      `Single-host review assurance (${result.schemaVersion})`,
      `storyId: ${storyId}`,
      `probe: ${probeId ?? 'not needed'}${probed ? ' (run now)' : probeId ? ' (fresh, reused)' : ''}`,
      `fallback: ${fallbackId ?? 'not needed'}`,
      `rounds recorded: ${result.roundsRecorded} (${result.runIds.join(', ') || 'none missing'}) from reviewer passes ${reviewerPasses.map(pass => `${pass.lane.replace('proof-or-stop-review-', '')}=${pass.passId}`).join(', ')}`,
      `review assurance now satisfied: ${result.satisfied}`,
      'evidenceScope: local-single-host-review-assurance',
    ].join('\n');
  }

  return {
    quorum_submit(args: QuorumSubmitArgs): QuorumSubmitResult | SingleHostAssuranceResult | string {
      if (args.singleHost === true) return singleHostSubmit(args);
      const storyId = normalizeString(args.storyId);
      if (!storyId) throw new Error('quorum_submit: storyId is required');
      if (!isCanonicalStoryId(storyId)) {
        throw new Error(`quorum_submit: storyId "${storyId}" is not a canonical, path-safe Proof-or-Stop story id`);
      }
      const hostAId = normalizeString(args.hostA);
      const hostBId = normalizeString(args.hostB);
      if (!hostAId || !hostBId) throw new Error('quorum_submit: hostA and hostB are required');
      const rounds = parseRounds(args.rounds);
      const workspace = resolveStoryCommandWorkspace(ctx.store, storyId, ctx.root);
      const projectRoot = workspace.signedWorkspaceRoot;
      const gitCwd = ctx.root;

      const reviewRoster = requiredReviewRoster(ctx, storyId, projectRoot);
      const reviewerPasses = assertCurrentReviewerPasses(ctx, storyId, projectRoot, reviewRoster);

      const materialDigest = currentMaterialHash(projectRoot, 'HEAD', workspace.metadataRoot || ctx.root);
      if (!materialDigest) {
        throw new Error('quorum_submit: cannot compute current materialHash; refusing to emit quorum verdicts with an empty materialDigest');
      }
      const storyFilesHash = currentStoryFilesHash(projectRoot, 'HEAD', workspace.metadataRoot || ctx.root);
      if (!storyFilesHash) {
        throw new Error('quorum_submit: cannot compute current storyFilesHash; refusing to emit quorum verdicts without the story-owned file hash');
      }
      const headHash = currentGitHead(projectRoot);
      const baseHostA = {
        side: 'A' as const,
        hostId: hostAId,
        provider: normalizeString(args.providerA) || 'claude',
        sessionId: normalizeString(args.sessionA) || derivedSession(storyId, hostAId),
        keyId: normalizeString(args.keyA) || deriveCanonicalHostKeyId(storyId, hostAId),
      };
      const baseHostB = {
        side: 'B' as const,
        hostId: hostBId,
        provider: normalizeString(args.providerB) || 'codex',
        sessionId: normalizeString(args.sessionB) || derivedSession(storyId, hostBId),
        keyId: normalizeString(args.keyB) || deriveCanonicalHostKeyId(storyId, hostBId),
      };
      const testEvidence = safeReadTestEvidence(ctx, storyId);
      const bindingsA = deriveHostVerdictBindings({
        storyId, headHash, materialDigest, storyFilesHash, testEvidence, ...baseHostA,
      });
      const bindingsB = deriveHostVerdictBindings({
        storyId, headHash, materialDigest, storyFilesHash, testEvidence, ...baseHostB,
      });
      const hostA: QuorumHostInput = {
        ...baseHostA,
        promptDigest: normalizeString(args.promptDigestA) || bindingsA.promptDigest,
      };
      const hostB: QuorumHostInput = {
        ...baseHostB,
        promptDigest: normalizeString(args.promptDigestB) || bindingsB.promptDigest,
      };
      assertHostIndependence(hostA, hostB);
      const validationDigest = normalizeString(args.validationDigest)
        || bindingsA.validationDigest;
      const note = normalizeString(args.note) || 'quorum_submit local voluntary floor quorum after current signed reviewer passes';

      const batch = emitVerdictBatch({ label: 'quorum_submit', storyId, projectRoot, gitCwd, materialDigest, storyFilesHash, validationDigest, note,
        runIds: Array.from({ length: rounds }, (_unused, index) => `${storyId}-q-r${index + 1}`), hosts: [hostA, hostB] });
      const result: QuorumSubmitResult = {
        schemaVersion: 'proof-or-stop.quorum_submit.v1',
        storyId,
        rounds,
        emittedCount: batch.emitted.length,
        verdictIds: batch.emitted.map(verdict => verdict.verdictId),
        runIds: batch.runIds,
        materialDigest,
        storyFilesHash,
        validationDigest,
        metadataCommitSha: batch.metadataCommitSha,
        promptDigests: {
          hostA: hostA.promptDigest,
          hostB: hostB.promptDigest,
        },
        hosts: { hostA, hostB },
        requiredReviewerLanes: reviewerPasses.map(pass => pass.lane),
        reviewSelection: { activeLanes: reviewRoster.selection.activeLanes, requiredLanes: reviewerPasses.map(pass => pass.lane), reason: reviewRoster.selection.reason, digest: reviewRoster.selection._hash },
        reviewerPasses,
        verdicts: batch.emitted,
        reviewEscalationStatus: batch.reviewEscalationStatus,
        authorityDone: false,
        fullAuthorityDone: false,
        productionDone: false,
      };
      return wantsJson(args) ? result : formatResult(result);
    },
  };
}
