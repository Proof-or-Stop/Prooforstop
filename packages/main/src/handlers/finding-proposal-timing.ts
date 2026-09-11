/** Server-owned proposal clock. An interrupted start is visible and never
 * treated as a successful zero-latency run. These records are non-gate facts. */
import { performance } from 'node:perf_hooks';
import type { HandlerContext } from './context.js';
import { resolveRegisteredAgentActor } from '../core/agent-dispatch-registry.js';
import { readBrandEnv } from '../core/brand-env.js';
import { applicabilityDigest } from '../core/finding-applicability.js';
import { currentGitHead } from '../core/evidence-freshness.js';
import { readCandidates } from './finding-identity.js';

export function freezeFindingProposalPopulation(ctx: HandlerContext, storyId: string, requestDigest: string) {
  const actor = resolveRegisteredAgentActor(readBrandEnv('AGENT'));
  if (!actor?.reviewerLane || ctx.store.readStory(storyId).phase !== 'REVIEW') throw new Error('proposal timing: current reviewer required');
  const ledger = ctx.store.readFindingLedger(storyId);
  const currentFindings = ctx.store.readFindings(storyId).findings.filter(row => row.status === 'open').map(row => row.recordId);
  const currentCandidates = readCandidates(ctx, storyId).candidates.filter(row => row.envelope.payload.state === 'pending_verification').map(row => row.record.recordId);
  const current = new Set([...currentFindings, ...currentCandidates]);
  const observations = ledger.records.filter(row => current.has(row.recordId)).map(row => ({ recordId: row.recordId, recordType: row.recordType }));
  const startedAt = new Date().toISOString(); const monotonicStart = performance.now();
  return { monotonicStart, record: { schemaVersion: 1, action: 'proposal_timing_start', attemptId: `proposal-attempt:${requestDigest}`,
    storyId, requestDigest, startedAt, repositoryHead: currentGitHead(ctx.root), actor: actor.canonicalName,
    population: observations, populationDigest: applicabilityDigest(observations), candidateCount: observations.length,
    clock: 'node.performance.monotonic', timeoutBudgetMs: 300_000, gateEvidence: false } };
}
export function finishFindingProposalTiming(start: ReturnType<typeof freezeFindingProposalPopulation>, outcome: 'signed' | 'failed', proposalId?: string) {
  return { schemaVersion: 1, action: 'proposal_timing_end', attemptId: start.record.attemptId, storyId: start.record.storyId,
    startedAt: start.record.startedAt, completedAt: new Date().toISOString(), durationMs: performance.now() - start.monotonicStart,
    outcome, ...(proposalId ? { proposalId } : {}), populationDigest: start.record.populationDigest, gateEvidence: false };
}
