import { createHash } from 'node:crypto';
import { routingUserSees } from '../core/metadata-correction.js';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { HandlerContext } from './context.js';
import type { FormatArgs } from './verdict.js';
import {
  DEFAULT_CANDIDATE_HOST_STARTUP_TIMEOUT_MS,
  DEFAULT_CANDIDATE_HOST_TOTAL_TIMEOUT_MS,
  loadConfig,
} from '../core/config.js';
import {
  buildCorpusIndex,
  candidateRouteLaunchReady,
  CORPUS_INDEX_SCHEMA,
  buildKeywordSeeds,
  collectHostKeywordProposals,
  digestCandidateRoutingValue,
  evaluateCandidateRoutingPromotion,
  routeCandidateSpecs,
  touchpointProtectedPaths,
  type CandidateHostExecutor,
  type CandidateSpecSetArtifact,
  type HostKeywordProposal,
  type StoryRoutingInput,
  type CandidateRoutingEvaluationWindow,
} from '../core/candidate-spec-routing.js';
import { assertActiveIdentityConsumerContract } from '../core/active-identity-consumer-contract.js';
import { requireRepositoryBaselineRef } from '../core/git-baseline.js';
import { runHostRun, type HostRunResult } from '../core/host-run.js';
import {
  probeReviewHostAvailability,
  type ReviewHostAvailabilityProbeHostRow,
} from '../core/review-escalation.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';
import { captureReviewRunSnapshot } from '../core/review-run.js';
import { collectReviewerEvidenceState } from '../core/review-run.js';
import type { ReviewerEvidenceState } from '../core/review-run.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import { isStoryMetadataPath } from '../core/evidence-freshness.js';
import { currentOpenReviewInventory, withReviewInventoryMutationLock } from '../core/review-inventory-epoch.js';
import { refreshReviewInventoryContextLocked } from './review-inventory.js';

const MAX_PROPOSAL_OUTPUT_BYTES = 64 * 1024;

export interface CandidateSpecRouteArgs extends FormatArgs {
  storyId: string;
  hosts?: boolean;
  persist?: boolean;
  fullScanReason?: string;
}

export interface CandidateSpecRolloutCheckArgs extends FormatArgs {
  from: 'shadow' | 'warn' | 'enforce';
  to: 'shadow' | 'warn' | 'enforce';
  windows: CandidateRoutingEvaluationWindow[];
  maxP95LatencyMs?: number;
}

export type CandidateReadinessResolver = () => Pick<ReviewHostAvailabilityProbeHostRow,
  'host' | 'launcherSupport' | 'launcherOk' | 'executionReady' | 'reviewReady' | 'failureKind' | 'progressMode' | 'diagnostic' | 'remediation'>[];

export function unattendedReadinessRefusal(
  row: ReturnType<CandidateReadinessResolver>[number] | undefined,
): string | null {
  if (!row) return 'unattended_readiness_missing';
  if (row.launcherSupport !== 'supported') return `unattended_readiness_${row.launcherSupport}`;
  if (!row.launcherOk) return 'unattended_readiness_launcher_not_ready';
  if (!row.executionReady) return `unattended_readiness_${row.failureKind || 'execution_not_ready'}`;
  if (row.failureKind !== 'none') return `unattended_readiness_${row.failureKind}`;
  if (row.progressMode === 'none') return 'unattended_readiness_unobservable';
  return null;
}

export function withUnattendedReadiness(
  execute: CandidateHostExecutor,
  readiness: ReturnType<CandidateReadinessResolver>,
): CandidateHostExecutor {
  return async args => {
    const canonicalHost = hostName(args.host);
    const refusal = unattendedReadinessRefusal(readiness.find(row => row.host === canonicalHost));
    if (refusal) throw new Error(`${refusal}: host ${canonicalHost} skipped pre-spawn`);
    return execute(args);
  };
}

export function candidateHostFailureReason(result: Pick<HostRunResult,
  'blocked' | 'refusalReason' | 'timedOut' | 'timeoutKind' | 'firstOutputMs' | 'durationMs' | 'exitCode' | 'terminalReason' | 'failureKind'>): string | null {
  if (result.blocked) return result.refusalReason || 'host_unavailable';
  if (result.terminalReason === 'spawn_error') return `post_readiness_spawn_error:${result.failureKind ?? 'unknown'}`;
  if (result.failureKind === 'auth') return 'post_readiness_auth_required';
  if (result.failureKind === 'interactive') return 'post_readiness_interactive_required';
  if (result.timedOut) return `${result.timeoutKind ?? 'host_timeout'}; firstOutputMs=${result.firstOutputMs ?? 'none'} durationMs=${result.durationMs ?? 'unknown'}`;
  if (result.exitCode !== 0 && result.firstOutputMs === null) return 'post_readiness_no_output';
  if (result.exitCode !== 0) return `post_readiness_execution_failure:${result.failureKind ?? 'unknown'}:exit_${result.exitCode}`;
  return null;
}

export function currentReviewerFullyReadPaths(evidence: ReviewerEvidenceState): string[] {
  return [...new Set(evidence.valid.flatMap(record => {
    const manifest = record.pass?.readManifest ?? record.finding?.readManifest;
    return manifest?.filesReadFully ?? [];
  }))].sort((a, b) => a.localeCompare(b, 'en'));
}

export function renderCandidateSpecRouteText(
  artifact: CandidateSpecSetArtifact,
  corpusCount: number,
  attempts: Array<{ host: string; status: string }>,
  mode?: 'shadow' | 'warn' | 'enforce',
): string {
  const effectiveMode = mode ?? artifact.mode;
  const modeMismatch = effectiveMode !== artifact.mode;
  if (modeMismatch && effectiveMode === 'enforce') throw new Error(`candidate routing mode disagreement: artifact=${artifact.mode} configured=${effectiveMode}`);
  const lines = [
    `Candidate spec route: ${artifact.storyId}`,
    `corpus=${artifact.candidateSpecSet.length}/${corpusCount} candidates digest=${artifact.artifactDigest}`,
    `hosts=${attempts.map(attempt => `${attempt.host}:${attempt.status}`).join(',') || 'disabled'}`,
    `agyReadiness=${artifact.agyReadinessDiagnostic
      ? `${artifact.agyReadinessDiagnostic.failureKind}:${artifact.agyReadinessDiagnostic.diagnostic ?? 'none'}`
      : 'not-probed'}`,
    `requiresEscalation=${artifact.requiresEscalation}`,
    `escalationReasons=${artifact.escalationReasons.join(',') || 'none'}`,
    `queryFiltering=maxDocumentFrequencyRatio=${artifact.queryFiltering.maxDocumentFrequencyRatio} filtered=${artifact.queryFiltering.filteredTerms.map(term => `${term.term}:${term.documentCount}:${term.reason}`).join(',') || 'none'}`,
  ];
  if (modeMismatch && effectiveMode === 'warn') {
    lines.push(`status=WARNING_MODE_MISMATCH artifact=${artifact.mode} configured=${effectiveMode}`);
    lines.push(`nextAction=proof-or-stop candidate_spec_route '{"storyId":"${artifact.storyId}"}'`);
  } else if (modeMismatch) {
    lines.push(`status=SHADOW_MODE_MISMATCH_RECORDED artifact=${artifact.mode} configured=${effectiveMode}`);
  }
  if (artifact.requiresEscalation && !artifact.fullScan && effectiveMode === 'enforce') {
    lines.push('status=BLOCKED_PENDING_ESCALATION');
    lines.push(`resolutionAction=proof-or-stop candidate_spec_route '{"storyId":"${artifact.storyId}","fullScanReason":"<specific justified tool-driven broad-scan reason>"}'`);
    lines.push('Do not submit scope_check_save, review_pass_set, or finding evidence with this unresolved candidate artifact.');
  } else if (artifact.requiresEscalation && !artifact.fullScan && effectiveMode === 'warn') {
    lines.push('status=WARNING_PENDING_ESCALATION');
    lines.push(`nextAction=proof-or-stop candidate_spec_route '{"storyId":"${artifact.storyId}","fullScanReason":"<specific justified tool-driven broad-scan reason>"}'`);
  } else if (artifact.requiresEscalation && !artifact.fullScan) {
    lines.push('status=SHADOW_RECORDED');
  }
  lines.push(`ambiguity=${artifact.ambiguitySignals.join(',') || 'none'}`);
  lines.push(`scanEscalationReason=${artifact.scanEscalationReason ?? 'null'}`);
  lines.push(...artifact.candidates.map((candidate, index) => `${index + 1}. ${candidate.path} score=${candidate.score}`));
  return lines.join('\n');
}

function changedPaths(ctx: HandlerContext, storyId: string): string[] {
  try {
    const gitCwd = resolveGitCwd({
      store: ctx.store,
      storyId,
      metadataRoot: ctx.root,
      projectRoot: ctx.root,
    });
    return execFileSync('git', ['diff', '--name-only', `${requireRepositoryBaselineRef(gitCwd)}...HEAD`], { cwd: gitCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/)
      .map(value => value.trim())
      .filter(path => Boolean(path) && !isStoryMetadataPath(path, ctx.root))
      .sort();
  } catch {
    return [];
  }
}

function parseProposalOutput(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1]?.trim();
  for (const candidate of [fenced, trimmed].filter((value): value is string => Boolean(value))) {
    try { return JSON.parse(candidate); } catch { /* try bounded object below */ }
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new Error('host proposal output did not contain a JSON object');
}

/**
 * Bounded final proposal lane shared by the production passthrough and its
 * executable boundary smoke. Overflow invalidates the entire candidate stream:
 * a parseable prefix is never accepted after later bytes exceed the cap.
 */
export class CandidateProposalOutputCollector {
  private output = '';
  private overflow = false;

  push(text: string): void {
    if (this.overflow) return;
    if (Buffer.byteLength(this.output) + Buffer.byteLength(text) > MAX_PROPOSAL_OUTPUT_BYTES) {
      this.overflow = true;
      this.output = '';
      return;
    }
    this.output += text;
  }

  finish(result: Pick<HostRunResult,
    'blocked' | 'refusalReason' | 'timedOut' | 'timeoutKind' | 'firstOutputMs' | 'durationMs' | 'exitCode' | 'terminalReason' | 'failureKind'>): unknown {
    const failureReason = candidateHostFailureReason(result);
    if (failureReason) throw new Error(failureReason);
    if (this.overflow) throw new Error('host proposal output budget exceeded');
    if (result.firstOutputMs === null) throw new Error('post_readiness_no_output');
    return parseProposalOutput(this.output);
  }
}

// B-137a:F-122 — exhaustive, no silent fallback. The previous form returned
// 'agy' for anything that was not codex/claude, so a future host added to the
// union would have been silently mislabeled as agy rather than failing to
// compile. The union no longer contains 'agy-cli' (its construction site was
// deleted), and the `never` check now makes any new host a compile error here.
function hostName(host: HostKeywordProposal['host']): 'codex' | 'claude' {
  if (host === 'codex-cli') return 'codex';
  if (host === 'claude-cli') return 'claude';
  const unreachable: never = host;
  throw new Error(`unsupported candidate-spec routing host: ${String(unreachable)}`);
}

function projectRootHash(root: string): string {
  return `sha256:${createHash('sha256').update(root).digest('hex')}`;
}

const CANONICAL_STRUCTURED_RISK_PATHS: Readonly<Record<string, string>> = {
  'machine.ts': 'packages/main/src/core/machine.ts',
  'process-fact-registry.ts': 'packages/main/src/core/process-fact-registry.ts',
  'runtime-fact-registry.ts': 'packages/main/src/core/runtime-fact-registry.ts',
};

function structuredRiskProtectedPath(root: string, matched: string): string | null {
  const normalized = posix.normalize(matched.trim().replace(/\\/g, '/')).replace(/^\.\//, '');
  if (!normalized || normalized === '..' || normalized.startsWith('../')) return null;
  const candidate = normalized.includes('/') ? normalized : CANONICAL_STRUCTURED_RISK_PATHS[normalized.toLowerCase()];
  return candidate && existsSync(join(root, candidate)) ? candidate : null;
}

function productionExecutor(
  ctx: HandlerContext,
  phase: string,
  startupTimeoutMs?: number,
  totalTimeoutMs?: number,
): CandidateHostExecutor {
  return async ({ host, storyId, sanitizedPayload, promptDigest, seedDigest }) => {
    const canonicalHost = hostName(host);
    const prompt = [
      'Return only one compact JSON object matching proof-or-stop.keyword-proposal.v1.',
      'Proposals are advisory terms only. Do not claim reads, gates, or completion.',
      'Use at most 20 terms, 5 ambiguity signals, and 160 characters per rationale.',
      `Required identity: storyId=${storyId} host=${host} promptDigest=${promptDigest} deterministicSeedDigest=${seedDigest}`,
      `Sanitized routing input: ${JSON.stringify(sanitizedPayload)}`,
    ].join('\n');
    const proposalOutput = new CandidateProposalOutputCollector();
    const result = await runHostRun({
      host: canonicalHost,
      storyId,
      agentType: 'candidate-keyword-proposer',
      phase,
      promptText: prompt,
      promptLabel: `candidate-spec:${host}`,
      startupTimeoutMs,
      timeoutMs: totalTimeoutMs,
      env: process.env,
      cwd: ctx.root,
      root: ctx.root,
      recordedAt: new Date().toISOString(),
      projectRootHash: projectRootHash(ctx.root),
    }, {
      resolveStory: id => {
        try { return { phase: ctx.store.readStory(id).phase }; } catch { return null; }
      },
      passthrough: chunk => {
        if (chunk.stream === 'stdout') proposalOutput.push(chunk.text);
      },
    });
    return proposalOutput.finish(result);
  };
}

export function currentStoryRoutingInput(ctx: HandlerContext, storyId: string): StoryRoutingInput {
  const story = ctx.store.readStory(storyId);
  const checklist = ctx.store.readChecklist(storyId);
  const understanding = ctx.store.readUnderstanding(storyId);
  const relatedDocs = checklist.items.flatMap(item => item.relatedDocs ?? []);
  const materialChangedPaths = changedPaths(ctx, storyId);
  // A diff path is freshness/ranking input, not a durable exact-path authority.
  // Promoting every `main...HEAD` entry into protectedSources made an unrelated
  // branch commit manufacture a selected candidate, so a routing-neutral reroute
  // could never remain neutral. Explicit understanding touchpoints retain the
  // protected exact-path contract; changed paths continue to seed ranking below.
  // Run 17: touchpoints are free text; only the leading path token of one that
  // resolves to a real file is protected (prose stays a ranking seed only).
  const exactPaths = touchpointProtectedPaths(ctx.root, understanding?.touchpoints ?? []);
  let reviewerEvidencePaths: string[] = [];
  try {
    const evidence = collectReviewerEvidenceState(ctx.store, storyId, ctx.root);
    reviewerEvidencePaths = currentReviewerFullyReadPaths(evidence);
  } catch {
    // Missing/stale/unbound evidence is intentionally not promoted.
  }
  const structuredRiskSignals = story.riskSignals ?? [];
  const riskSignals = structuredRiskSignals.map(signal => `${signal.category}:${signal.matched}`);
  const protectedSources: NonNullable<StoryRoutingInput['protectedSources']> = [
    ...relatedDocs.map((path, index) => ({ kind: 'related-doc' as const, path, sourceRef: `relatedDocs[${index}]` })),
    ...exactPaths.map((path, index) => ({
      kind: /(?:process|runtime)-fact-registry\.ts$/i.test(path) ? 'registry-ref' as const : 'exact-path' as const,
      path,
      sourceRef: `exactPaths[${index}]`,
    })),
    ...structuredRiskSignals
      .map((signal, index) => ({ index, path: structuredRiskProtectedPath(ctx.root, signal.matched) }))
      .filter((row): row is { index: number; path: string } => row.path !== null)
      .map(row => ({ kind: 'typed-risk' as const, path: row.path, sourceRef: `riskSignals[${row.index}]` })),
    ...reviewerEvidencePaths.map((path, index) => ({ kind: 'reviewer-evidence' as const, path, sourceRef: `reviewerEvidence[${index}]` })),
  ];
  return {
    storyId,
    title: story.title,
    description: story.description,
    keywords: story.keywords,
    riskSignals,
    relatedDocs: [...new Set(relatedDocs)].sort(),
    checklist: checklist.items.map(item => ({
      id: item.id,
      title: item.title,
      // Old-PoS run 31: a verified metadata correction does not stale the route.
      userSees: routingUserSees(ctx.store as never, storyId, item.userSees, item.id),
      excludes: item.excludes,
      relatedDocs: item.relatedDocs,
    })),
    understanding,
    changedPaths: materialChangedPaths,
    protectedSources,
  };
}

/**
 * Lab reroute-mid-inventory: an owner `candidate_spec_route` in REVIEW after the
 * current round's lanes ran against a route that is still launch-ready has no
 * purpose (the material the lanes reviewed is unchanged) and invalidates the
 * round: the reroute commit breaks the managed passes' live binding, the open
 * inventory epoch is invalidated (OPEN_REVIEW_INVENTORY_CANDIDATE_ROUTING_MUTATION),
 * every lane reruns, and an open finding of a superseded lane run blocks the
 * verdict as stale_run. A stale or missing route (readiness blocked) is still
 * rerouted, by review_round_prepare itself; a dry run (persist=false) is never
 * refused.
 */
function refuseRerouteOfCurrentReviewRoute(ctx: HandlerContext, storyId: string, story: { phase: string; currentReviewRound?: string | null },
  snapshot: { materialHash: string | null | undefined; storyFilesHash?: string | null | undefined }): void {
  if (story.phase !== 'REVIEW' || !story.currentReviewRound) return;
  const roundRuns = ctx.store.readReviewRuns(storyId).runs.filter(run => run.reviewRound === story.currentReviewRound);
  if (roundRuns.length === 0) return;
  if (!candidateRouteLaunchReady(ctx.store.readCandidateSpecSet(storyId),
    { materialHash: snapshot.materialHash, storyFilesHash: snapshot.storyFilesHash ?? null })) return;
  const openEpoch = currentOpenReviewInventory(ctx.store, storyId);
  throw new Error(`candidate_spec_route refused [candidate_route_current_in_review]: the candidate route is current and review round `
    + `${story.currentReviewRound} already ran ${roundRuns.length} ReviewRun(s) against it`
    + `${openEpoch && openEpoch.reviewRound === story.currentReviewRound ? ` (inventory epoch ${openEpoch.epochId} is OPEN)` : ''}. `
    + 'The material the lanes reviewed is unchanged, so a reroute gives them nothing new, but it invalidates the round (the inventory epoch, '
    + 'the managed passes\' live binding; every lane reruns). review_round_prepare reroutes by itself when the route goes stale; nothing was written.\n'
    + `Next: proof-or-stop next --storyId=${storyId}`);
}

export function createCandidateSpecRoutingHandlers(
  ctx: HandlerContext,
  options: { executeHost?: CandidateHostExecutor; resolveReadiness?: CandidateReadinessResolver } = {},
) {
  return {
    async candidate_spec_route(args: CandidateSpecRouteArgs): Promise<CandidateSpecSetArtifact | string> {
      const story = ctx.store.readStory(args.storyId);
      const config = loadConfig(ctx.root);
      const input = currentStoryRoutingInput(ctx, args.storyId);
      const corpus = buildCorpusIndex(ctx.root, config.requirementsDir);
      const seeds = buildKeywordSeeds(input);
      const snapshot = captureReviewRunSnapshot(ctx.root, {
        storyId: args.storyId,
        storyPhase: story.phase,
      });
      if (args.persist !== false) refuseRerouteOfCurrentReviewRoute(ctx, args.storyId, story, snapshot);
      const readiness = args.hosts === false
        ? []
        : (options.resolveReadiness ?? (() => probeReviewHostAvailability({
            storyId: args.storyId,
            materialHash: snapshot.materialHash,
            storyFilesHash: snapshot.storyFilesHash,
            cwd: ctx.root,
          }).hosts))();
      // agy remains a diagnostics-only readiness probe. Candidate proposal
      // execution stays exhaustively codex/claude, so this projection can never
      // turn a negative readiness report into an agy launch attempt.
      const agyReadiness = readiness.find(row => row.host === 'agy');
      const hostResult = args.hosts === false
        ? { attempts: [], accepted: [], sanitizedDigest: '', hostDisagreement: false }
        : await collectHostKeywordProposals({
            storyId: args.storyId,
            payload: input,
            seeds,
            execute: withUnattendedReadiness(
              options.executeHost ?? productionExecutor(
                ctx,
                story.phase,
                typeof config.candidateSpecRouting?.hostStartupTimeoutMs === 'number' && config.candidateSpecRouting.hostStartupTimeoutMs > 0
                  ? config.candidateSpecRouting.hostStartupTimeoutMs
                  : DEFAULT_CANDIDATE_HOST_STARTUP_TIMEOUT_MS,
                typeof config.candidateSpecRouting?.hostTotalTimeoutMs === 'number' && config.candidateSpecRouting.hostTotalTimeoutMs > 0
                  ? config.candidateSpecRouting.hostTotalTimeoutMs
                  : DEFAULT_CANDIDATE_HOST_TOTAL_TIMEOUT_MS,
              ),
              readiness,
            ),
          });
      const artifact = routeCandidateSpecs({
        projectRoot: ctx.root,
        storyId: args.storyId,
        corpus,
        seeds,
        proposals: hostResult.accepted,
        hostDisagreement: hostResult.hostDisagreement,
        // Only structured Story riskSignals can trigger typed risk escalation.
        // Narrative title/description/checklist prose remains seed material, not authority.
        riskSignals: input.riskSignals ?? [],
        protectedSources: input.protectedSources,
        mode: config.candidateSpecRouting?.mode ?? 'shadow',
        candidateBudget: config.candidateSpecRouting?.candidateBudget,
        queryGroupBudget: config.candidateSpecRouting?.queryGroupBudget,
        rawHitsPerGroup: config.candidateSpecRouting?.rawHitsPerGroup,
        maxDocumentFrequencyRatio: config.candidateSpecRouting?.maxDocumentFrequencyRatio,
        forceFullScanReason: args.fullScanReason,
        storyInputDigest: digestCandidateRoutingValue(input),
        ...(agyReadiness ? {
          agyReadinessDiagnostic: {
            launcherSupport: agyReadiness.launcherSupport,
            launcherOk: agyReadiness.launcherOk,
            executionReady: agyReadiness.executionReady,
            reviewReady: agyReadiness.reviewReady,
            failureKind: agyReadiness.failureKind,
            progressMode: agyReadiness.progressMode,
            diagnostic: agyReadiness.diagnostic ?? null,
            remediation: agyReadiness.remediation ?? null,
          },
        } : {}),
        ...snapshot,
      });
      if (args.persist !== false) {
        withReviewInventoryMutationLock(ctx.store, args.storyId, () => {
          ctx.store.writeCandidateSpecSet(args.storyId, artifact);
          // A reroute that got here (a stale/missing route, or no ReviewRun of
          // the round yet; a current route mid-round is refused above) completes,
          // but it atomically invalidates the old epoch before any consumer can
          // mix old/new candidate universes.
          refreshReviewInventoryContextLocked(ctx, args.storyId);
          autoCommitStoryMetadata(ctx.root, args.storyId, 'candidate_spec_route');
        });
      }
      if (args.json || args.format === 'json') return artifact;
      return renderCandidateSpecRouteText(artifact, corpus.entries.length, hostResult.attempts, config.candidateSpecRouting?.mode ?? 'shadow');
    },
    candidate_spec_rollout_check(args: CandidateSpecRolloutCheckArgs) {
      assertActiveIdentityConsumerContract('candidate-spec-routing', CORPUS_INDEX_SCHEMA);
      if (!Array.isArray(args.windows)) throw new Error('candidate_spec_rollout_check.windows must be an array');
      const verdict = evaluateCandidateRoutingPromotion(args);
      if (args.json || args.format === 'json') return verdict;
      return [
        `Candidate routing rollout: ${args.from} -> ${args.to}`,
        `allowed=${verdict.allowed}`,
        `windows=${verdict.evaluatedWindowIds.join(',') || 'none'}`,
        `blockers=${verdict.blockers.join('; ') || 'none'}`,
        `rollback=${verdict.rollback}`,
        'corpusPromptInjectionAllowed=false',
      ].join('\n');
    },
  };
}
