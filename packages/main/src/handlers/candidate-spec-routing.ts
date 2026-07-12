import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { HandlerContext } from './context.js';
import type { FormatArgs } from './verdict.js';
import { loadConfig } from '../core/config.js';
import {
  buildCorpusIndex,
  buildKeywordSeeds,
  collectHostKeywordProposals,
  digestCandidateRoutingValue,
  evaluateCandidateRoutingPromotion,
  routeCandidateSpecs,
  type CandidateHostExecutor,
  type CandidateSpecSetArtifact,
  type HostKeywordProposal,
  type StoryRoutingInput,
  type CandidateRoutingEvaluationWindow,
} from '../core/candidate-spec-routing.js';
import { runHostRun } from '../core/host-run.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';
import { captureReviewRunSnapshot } from '../core/review-run.js';

const MAX_PROPOSAL_OUTPUT_BYTES = 64 * 1024;

export interface CandidateSpecRouteArgs extends FormatArgs {
  storyId: string;
  hosts?: boolean;
  requestAgy?: boolean;
  persist?: boolean;
  fullScanReason?: string;
}

export interface CandidateSpecRolloutCheckArgs extends FormatArgs {
  from: 'shadow' | 'warn' | 'enforce';
  to: 'shadow' | 'warn' | 'enforce';
  windows: CandidateRoutingEvaluationWindow[];
  maxP95LatencyMs?: number;
}

function changedPaths(root: string): string[] {
  try {
    return execFileSync('git', ['diff', '--name-only', 'main...HEAD'], { cwd: root, encoding: 'utf8' })
      .split(/\r?\n/).map(value => value.trim()).filter(Boolean).sort();
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

function hostName(host: HostKeywordProposal['host']): 'codex' | 'claude' | 'agy' {
  if (host === 'codex-cli') return 'codex';
  if (host === 'claude-cli') return 'claude';
  return 'agy';
}

function projectRootHash(root: string): string {
  return `sha256:${createHash('sha256').update(root).digest('hex')}`;
}

function productionExecutor(ctx: HandlerContext, phase: string): CandidateHostExecutor {
  return async ({ host, storyId, sanitizedPayload, promptDigest, seedDigest }) => {
    const prompt = [
      'Return only one compact JSON object matching proofbound.keyword-proposal.v1.',
      'Proposals are advisory terms only. Do not claim reads, gates, or completion.',
      'Use at most 20 terms, 5 ambiguity signals, and 160 characters per rationale.',
      `Required identity: storyId=${storyId} host=${host} promptDigest=${promptDigest} deterministicSeedDigest=${seedDigest}`,
      `Sanitized routing input: ${JSON.stringify(sanitizedPayload)}`,
    ].join('\n');
    let output = '';
    let overflow = false;
    const result = await runHostRun({
      host: hostName(host),
      storyId,
      agentType: 'candidate-keyword-proposer',
      phase,
      promptText: prompt,
      promptLabel: `candidate-spec:${host}`,
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
        if (chunk.stream !== 'stdout' || overflow) return;
        if (Buffer.byteLength(output) + Buffer.byteLength(chunk.text) > MAX_PROPOSAL_OUTPUT_BYTES) {
          overflow = true;
          output = '';
          return;
        }
        output += chunk.text;
      },
    });
    if (result.blocked) throw new Error(result.refusalReason || 'host unavailable');
    if (result.timedOut) throw new Error('host timeout');
    if (result.exitCode !== 0) throw new Error(result.stderr || `host unavailable exit ${result.exitCode}`);
    if (overflow) throw new Error('host proposal output budget exceeded');
    return parseProposalOutput(output);
  };
}

export function currentStoryRoutingInput(ctx: HandlerContext, storyId: string): StoryRoutingInput {
  const story = ctx.store.readStory(storyId);
  const checklist = ctx.store.readChecklist(storyId);
  const understanding = ctx.store.readUnderstanding(storyId);
  const relatedDocs = checklist.items.flatMap(item => item.relatedDocs ?? []);
  return {
    storyId,
    title: story.title,
    description: story.description,
    keywords: story.keywords,
    riskSignals: story.riskSignals?.map(signal => `${signal.category}:${signal.matched}`),
    relatedDocs: [...new Set(relatedDocs)].sort(),
    checklist: checklist.items.map(item => ({
      id: item.id,
      title: item.title,
      userSees: item.userSees,
      excludes: item.excludes,
      relatedDocs: item.relatedDocs,
    })),
    understanding,
    changedPaths: changedPaths(ctx.root),
  };
}

export function createCandidateSpecRoutingHandlers(
  ctx: HandlerContext,
  options: { executeHost?: CandidateHostExecutor } = {},
) {
  return {
    async candidate_spec_route(args: CandidateSpecRouteArgs): Promise<CandidateSpecSetArtifact | string> {
      const story = ctx.store.readStory(args.storyId);
      const config = loadConfig(ctx.root);
      const input = currentStoryRoutingInput(ctx, args.storyId);
      const corpus = buildCorpusIndex(ctx.root, config.requirementsDir);
      const seeds = buildKeywordSeeds(input);
      const hostResult = args.hosts === false
        ? { attempts: [], accepted: [], sanitizedDigest: '', hostDisagreement: false }
        : await collectHostKeywordProposals({
            storyId: args.storyId,
            payload: input,
            seeds,
            execute: options.executeHost ?? productionExecutor(ctx, story.phase),
            requestAgy: args.requestAgy,
          });
      const snapshot = captureReviewRunSnapshot(ctx.root, {
        storyId: args.storyId,
        storyPhase: story.phase,
      });
      const artifact = routeCandidateSpecs({
        projectRoot: ctx.root,
        storyId: args.storyId,
        corpus,
        seeds,
        proposals: hostResult.accepted,
        hostDisagreement: hostResult.hostDisagreement,
        riskSignals: [
          ...(input.riskSignals ?? []),
          input.title ?? '',
          input.description ?? '',
          ...(input.checklist ?? []).map(item => item.title ?? ''),
        ],
        candidateBudget: config.candidateSpecRouting?.candidateBudget,
        queryGroupBudget: config.candidateSpecRouting?.queryGroupBudget,
        rawHitsPerGroup: config.candidateSpecRouting?.rawHitsPerGroup,
        forceFullScanReason: args.fullScanReason,
        storyInputDigest: digestCandidateRoutingValue(input),
        ...snapshot,
      });
      if (args.persist !== false) {
        ctx.store.writeCandidateSpecSet(args.storyId, artifact);
        autoCommitStoryMetadata(ctx.root, args.storyId, 'candidate_spec_route');
      }
      if (args.json || args.format === 'json') return artifact;
      return [
        `Candidate spec route: ${args.storyId}`,
        `corpus=${artifact.candidateSpecSet.length}/${corpus.entries.length} candidates digest=${artifact.artifactDigest}`,
        `hosts=${hostResult.attempts.map(attempt => `${attempt.host}:${attempt.status}`).join(',') || 'disabled'}`,
        `ambiguity=${artifact.ambiguitySignals.join(',') || 'none'}`,
        `scanEscalationReason=${artifact.scanEscalationReason ?? 'null'}`,
        ...artifact.candidates.map((candidate, index) => `${index + 1}. ${candidate.path} score=${candidate.score}`),
      ].join('\n');
    },
    candidate_spec_rollout_check(args: CandidateSpecRolloutCheckArgs) {
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
