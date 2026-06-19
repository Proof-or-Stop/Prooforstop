/**
 * parallel-decomposition gate VERDICT (program Story 2 / B-986c).
 *
 * The pure decision core for the parallel-decomposition gate (docs/parallel-decomposition-spec.md
 * §4.3/§4.4). Given a story, its peers, their scope contracts, and the gate config, it returns
 * advisories (always) plus an optional PROVABLE block reason — never a should-have-parallelized
 * judgement. It does NOT consult cfg.mode: enforcement is the caller's job
 * (canStartDevGuard, Story 5). No I/O — contracts are passed in as a Map.
 *
 * Why a separate file from the frozen contract (parallel-decomposition.ts): the four impl
 * stories stay on disjoint files; Story 5 reconciles the contract to re-export the real impls.
 */

import type { StoryInfo, ScopeContractData } from './types.js';
import type {
  ParallelGateConfig,
  ParallelDecompositionBlock,
  DecompositionGateResult,
} from './parallel-decomposition.js';
import { computeWriteSet, globsOverlap, classifyBroadness } from './parallel-decomposition-overlap.js';
import { TERMINAL_PHASES } from './parallel-policy.js';

/** A write-set entry is a literal path (tier-1 eligible) iff it carries no trailing wildcard. */
function isLiteralPath(entry: string): boolean {
  return !entry.endsWith('/*') && !entry.endsWith('/**');
}

/**
 * Tier-1 (spec §4.2): literal exact-path collisions between two write-sets. Zero false
 * positives — this is the only tier strong enough to HARD-block (§4.3 cond 1). globsOverlap
 * also reports the tier-2 shared-prefix heuristic, which may over-flag, so the block computes
 * tier-1 itself rather than trusting globsOverlap.overlap.
 */
function literalCollisions(a: string[], b: string[]): string[] {
  const litB = new Set(b.filter(isLiteralPath));
  return a.filter((e) => isLiteralPath(e) && litB.has(e));
}

const assertsParallel = (s: StoryInfo): boolean => s.parallelSafe === 'yes';

/** Most-severe-first; the gate returns the first triggered reason. fake_dependency_chain is
 *  intentionally absent — it is advise-only in this data model (see below). */
const BLOCK_PRECEDENCE: readonly ParallelDecompositionBlock[] = [
  'overlap_declared_parallel',
  'peer_contract_unreadable_parallel',
  'broad_glob_unprovable_parallel',
];

/**
 * Pure decomposition-gate verdict. See the file header. Block precedence is by severity
 * (BLOCK_PRECEDENCE), independent of peer iteration order; all advisories are always returned.
 */
export function evaluateDecompositionGate(
  story: StoryInfo,
  peers: StoryInfo[],
  contracts: Map<string, ScopeContractData>,
  cfg: ParallelGateConfig,
): DecompositionGateResult {
  const advisories: string[] = [];
  const triggered = new Set<ParallelDecompositionBlock>();

  const sContract = contracts.get(story.storyId);
  const sWriteSet = sContract ? computeWriteSet(sContract) : [];

  // Active peers: not terminal (single TERMINAL_PHASES source), not self.
  const activePeers = peers.filter(
    (p) => p.storyId !== story.storyId && !TERMINAL_PHASES.has(p.phase),
  );

  // Parallel-specific checks only when THIS story asserts parallel.
  if (assertsParallel(story)) {
    for (const peer of activePeers) {
      if (!assertsParallel(peer)) continue;

      const pContract = contracts.get(peer.storyId);
      if (!pContract) {
        // peer_contract_unreadable_parallel: disjointness is unprovable without the contract.
        advisories.push(`cannot read scope contract for parallel peer ${peer.storyId}; disjointness unprovable`);
        triggered.add('peer_contract_unreadable_parallel');
        continue;
      }

      const pWriteSet = computeWriteSet(pContract);

      // overlap_declared_parallel: tier-1 literal collision (provable, zero false positives).
      const tier1 = literalCollisions(sWriteSet, pWriteSet);
      if (tier1.length > 0) {
        advisories.push(`literal write-set collision with parallel peer ${peer.storyId}: ${tier1[0]}`);
        triggered.add('overlap_declared_parallel');
      }

      // tier-2 shared-prefix pairs (NOT already a tier-1 literal collision) -> advisory only.
      const tier1Set = new Set(tier1);
      for (const [x, y] of globsOverlap(sWriteSet, pWriteSet).pairs) {
        if (x === y && tier1Set.has(x)) continue; // already reported as a tier-1 block
        advisories.push(`possible shared-prefix overlap with ${peer.storyId}: ${x} ~ ${y}`);
      }
    }

    // broad_glob_unprovable_parallel: a BROAD glob asserted parallel-safe. Hard block ONLY
    // under the strict profile (cfg.broadGlobBlocks); otherwise advise to narrow the contract.
    const broadEntries = sWriteSet.filter((e) => classifyBroadness(e) === 'broad');
    if (broadEntries.length > 0) {
      if (cfg.broadGlobBlocks) {
        advisories.push(`broad glob asserted parallel-safe (strict profile): ${broadEntries[0]}`);
        triggered.add('broad_glob_unprovable_parallel');
      } else {
        advisories.push(`broad glob asserted parallel-safe: ${broadEntries[0]} (narrow the contract)`);
      }
    }
  }

  // fake_dependency_chain: ADVISE-ONLY by design. StoryInfo.depends is string[] with no cited
  // symbol (spec §4.5 recommends adding no field), so the falsifiable "cited symbol absent from
  // the peer's allowedCreate" sub-case has no input here and is NEVER a hard block. We only
  // advise on a dependency edge that names a storyId not present among the supplied peers (a
  // possibly-stale or fabricated edge), which is a hint, not a provable contradiction.
  if (story.depends && story.depends.length > 0) {
    const peerIds = new Set(peers.map((p) => p.storyId));
    for (const dep of story.depends) {
      if (!peerIds.has(dep)) {
        advisories.push(`depends cites ${dep}, which is not among the supplied peers (verify the dependency)`);
      }
    }
  }

  const block = BLOCK_PRECEDENCE.find((r) => triggered.has(r)) ?? null;
  return { advisories, block };
}
