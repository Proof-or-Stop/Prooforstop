import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
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
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { deriveCanonicalHostKeyId, deriveHostVerdictBindings } from '../core/host-verdict-bindings.js';
import { normalizeRelPath } from '../core/lattice-paths.js';
import { evaluateReviewEscalation } from '../core/review-escalation.js';
import { isCanonicalStoryId } from '../core/lifecycle-registry.js';
import { collectReviewerEvidenceState } from '../core/review-run.js';
import { detectMdTouchpointsFromGit } from '../core/touchpoints-fallback.js';
import { computeActiveReviewers } from './reviewer-list.js';

const REFUSAL = 'quorum_submit refuses: no current reviewer pass evidence for the required lanes — run the review lanes (review_run_start + review_pass_set) first; quorum_submit will not fabricate a floor quorum without a real review.';

type QuorumSubmitArgs = {
  storyId: string;
  hostA: string;
  hostB: string;
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
  return name.startsWith('lattice-review-') ? name : `lattice-review-${name}`;
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
  } catch {
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

function requiredReviewerLanes(ctx: HandlerContext, storyId: string, projectRoot: string): string[] {
  const story = ctx.store.readStory(storyId);
  const checklist = safeReadChecklist(ctx, storyId);
  const decision = safeReadDecision(ctx, storyId);
  const understanding = ctx.store.readUnderstanding(storyId);
  const touchpoints = understanding?.touchpoints ?? detectMdTouchpointsFromGit(projectRoot);
  return computeActiveReviewers(story, checklist, decision, touchpoints)
    .map(reviewer => toLane(reviewer.name));
}

function assertCurrentReviewerPasses(ctx: HandlerContext, storyId: string, projectRoot: string): RequiredReviewerPass[] {
  const story = ctx.store.readStory(storyId);
  if (!story.currentReviewRound) {
    throw new Error(`${REFUSAL}\nDetails: story has no currentReviewRound, so no current signed reviewer pass can be proven.`);
  }
  const requiredLanes = requiredReviewerLanes(ctx, storyId, projectRoot);
  const state = collectReviewerEvidenceState(ctx.store, storyId, projectRoot);
  const validPasses = state.valid.filter(evidence => evidence.kind === 'pass');
  const passByLane = new Map(validPasses.map(evidence => [evidence.agent, evidence]));
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
    `reviewerPasses: ${result.reviewerPasses.length}/${result.requiredReviewerLanes.length} lanes current`,
    `voluntaryLocalRounds: ${result.reviewEscalationStatus.voluntaryLocalRounds.validRoundCount}/${result.reviewEscalationStatus.voluntaryLocalRounds.requiredRounds} rounds x ${result.reviewEscalationStatus.voluntaryLocalRounds.requiredPassingHostsPerRound} hosts (complete=${result.reviewEscalationStatus.voluntaryLocalRounds.complete})`,
    'admissibilityStatus: local-quorum-recorded',
    `assuranceLevel: ${result.reviewEscalationStatus.assuranceLevel}`,
    'evidenceScope: local-review-quorum',
  ].join('\n');
}

interface QuorumSubmitResult {
  schemaVersion: 'lattice.quorum_submit.v1';
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

function assertCleanQuorumBaseline(gitCwd: string): void {
  const dirty = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: gitCwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  if (dirty) {
    throw new Error(`quorum_submit refuses: worktree/index must be clean before the atomic verdict batch; pre-existing bytes were left untouched: ${dirty}`);
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

function committedHostVerdictEvents(gitCwd: string, storyRel: string): Array<Record<string, unknown>> {
  try {
    const content = execFileSync('git', ['show', `HEAD:${storyRel}/process-events.jsonl`], {
      cwd: gitCwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return content.split('\n').filter(Boolean).flatMap((line) => {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        return event.type === 'host_verdict' ? [event] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
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

export function createQuorumSubmitHandlers(ctx: HandlerContext, testHooks: QuorumSubmitTestHooks = {}) {
  return {
    quorum_submit(args: QuorumSubmitArgs): QuorumSubmitResult | string {
      const storyId = normalizeString(args.storyId);
      if (!storyId) throw new Error('quorum_submit: storyId is required');
      if (!isCanonicalStoryId(storyId)) {
        throw new Error(`quorum_submit: storyId "${storyId}" is not a canonical, path-safe Proofbound story id`);
      }
      const hostAId = normalizeString(args.hostA);
      const hostBId = normalizeString(args.hostB);
      if (!hostAId || !hostBId) throw new Error('quorum_submit: hostA and hostB are required');
      const rounds = parseRounds(args.rounds);
      const workspace = resolveStoryCommandWorkspace(ctx.store, storyId, ctx.root);
      const projectRoot = workspace.signedWorkspaceRoot;
      const gitCwd = ctx.root;

      const reviewerPasses = assertCurrentReviewerPasses(ctx, storyId, projectRoot);

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

      // Guard: refuse to re-submit a quorum for a runId that already carries a verdict at the
      // SAME materialDigest. This prevents silently piling duplicate verdicts onto an already-
      // populated runId, while still allowing a fresh quorum after the material changes (a
      // different materialDigest does not collide).
      const storyRel = quorumStoryRel(gitCwd, ctx, storyId);
      const plannedRunIds = new Set<string>();
      for (let round = 1; round <= rounds; round += 1) plannedRunIds.add(`${storyId}-q-r${round}`);
      const duplicateRunIds = [...new Set(
        committedHostVerdictEvents(gitCwd, storyRel)
          .filter(event => event.type === 'host_verdict'
            && plannedRunIds.has(normalizeString(event.runId))
            && event.materialDigest === materialDigest)
          .map(event => normalizeString(event.runId)),
      )].sort();
      if (duplicateRunIds.length > 0) {
        throw new Error(`quorum_submit refuses: verdicts already exist for runId(s) ${duplicateRunIds.join(', ')} at the current material (${materialDigest}); re-submitting would duplicate the quorum. Re-run only after the material changes (a new commit), or use a fresh review round.`);
      }

      assertCleanQuorumBaseline(gitCwd);
      const transaction = captureLifecycleMetadataTransaction({
        root: gitCwd,
        gitCwd,
        storyId,
        storyRel,
        kind: 'quorum-submit',
      });
      const emitted = [];
      const runIds: string[] = [];
      const ownedEventRecords: OwnedQuorumEventRecord[] = [];
      const ownedVerdictFiles = new Map<string, { filePath: string; bytes: Buffer }>();
      try {
        for (let round = 1; round <= rounds; round += 1) {
          const runId = `${storyId}-q-r${round}`;
          runIds.push(runId);
          for (const host of [hostA, hostB]) {
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
        const result: QuorumSubmitResult = {
          schemaVersion: 'lattice.quorum_submit.v1',
          storyId,
          rounds,
          emittedCount: emitted.length,
          verdictIds: emitted.map(verdict => verdict.verdictId),
          runIds,
          materialDigest,
          storyFilesHash,
          validationDigest,
          metadataCommitSha: committed.commitSha,
          promptDigests: {
            hostA: hostA.promptDigest,
            hostB: hostB.promptDigest,
          },
          hosts: { hostA, hostB },
          requiredReviewerLanes: reviewerPasses.map(pass => pass.lane),
          reviewerPasses,
          verdicts: emitted,
          reviewEscalationStatus,
          authorityDone: false,
          fullAuthorityDone: false,
          productionDone: false,
        };
        return wantsJson(args) ? result : formatResult(result);
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
          `quorum_submit atomic closeout failed: ${message}`
          + (rolledBack.ok ? '; all emitted verdicts were rolled back' : `; ${rolledBack.reason}`),
        );
      }
    },
  };
}
