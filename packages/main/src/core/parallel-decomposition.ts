/**
 * parallel-decomposition — frozen contract surface for the contract-first
 * parallel-decomposition gate (docs/parallel-decomposition-spec.md §4, §8).
 *
 * Story 0 (B-59c7) freezes this interface: pure-function SIGNATURES + NotImplemented
 * skeletons only. The four parallel impl stories fill the bodies:
 *   - computeWriteSet + globsOverlap   → Story 1 (static overlap engine)
 *   - evaluateDecompositionGate        → Story 2 (gate verdict)
 *   - parallelGate config resolution   → Story 3 (audit-config.ts resolveAuditConfig)
 *   - resolveWaveSafety advisory wiring → Story 4
 * No real logic or I/O lives here yet — every function throws NotImplemented.
 */

import type { ScopeContractData, StoryInfo } from './types.js';

/** Gate behaviour for the parallel-decomposition check (§4.7). A NEW set, disjoint in
 * meaningful values from AuditMode ({semi-auto, full-auto}); the two only share `off`. */
export type ParallelGateMode = 'advise' | 'block' | 'off';

/** Config block added to AuditConfig (resolution logic is Story 3). */
export interface ParallelGateConfig {
  /** advise = non-blocking hint; block = hard PLAN→DEV block; off = disabled. */
  mode: ParallelGateMode;
  /** Advisory cap on concurrent in-REVIEW stories (operator review bandwidth, §4.6). */
  maxConcurrentReview: number;
  /** When true, a BROAD glob asserted parallel-safe is a hard block (strict profile, §4.3 cond.2). */
  broadGlobBlocks: boolean;
}

/** Allowed parallelGate.mode values. Separate from audit-config's VALID_MODES
 * (typed ReadonlySet<AuditMode>), which cannot validate {advise, block, off}. */
export const VALID_PARALLEL_MODES: ReadonlySet<ParallelGateMode> = new Set<ParallelGateMode>([
  'advise',
  'block',
  'off',
]);

/**
 * Hard-block reasons the gate can return (§4.3). `null` (in the gate result) means no block.
 * Each is a provable scope contradiction — never a should-have-parallelized judgement.
 */
export type ParallelDecompositionBlock =
  | 'overlap_declared_parallel'
  | 'broad_glob_unprovable_parallel'
  | 'fake_dependency_chain'
  | 'peer_contract_unreadable_parallel';

/** Result of {@link globsOverlap}: tiered static overlap with broad-side attribution (§4.2). */
export interface GlobOverlapResult {
  /** True when the two write-sets are not provably disjoint. */
  overlap: boolean;
  /** Colliding (a-entry, b-entry) pairs supporting the overlap verdict. */
  pairs: Array<[string, string]>;
  /** Which operand carried a BROAD glob, for §4.3 block messages; null when neither. */
  broadSide: 'a' | 'b' | 'both' | null;
}

/** Result of {@link evaluateDecompositionGate}: advisories always; a block reason only on
 * a provable contradiction. The caller (canStartDevGuard) enforces mode, not this gate. */
export interface DecompositionGateResult {
  advisories: string[];
  block: ParallelDecompositionBlock | null;
}

/**
 * Compute the write-set (created/modified paths) of a scope contract. (Story 1)
 */
export function computeWriteSet(contract: ScopeContractData): string[] {
  void contract;
  throw new Error('NotImplemented: computeWriteSet');
}

/**
 * Static, tiered glob overlap between two write-sets (§4.2): literal-path intersection
 * plus shared-directory-prefix heuristic, with broadness classification. (Story 1)
 */
export function globsOverlap(a: string[], b: string[]): GlobOverlapResult {
  void a;
  void b;
  throw new Error('NotImplemented: globsOverlap');
}

/**
 * Pure decomposition gate (§4.4): computes advisories + an optional block reason from
 * scope facts only. Does NOT consult `cfg.mode` for enforcement — the caller
 * (canStartDevGuard) decides whether a non-null block aborts, per `cfg.mode`. (Story 2)
 */
export function evaluateDecompositionGate(
  story: StoryInfo,
  peers: StoryInfo[],
  contracts: Map<string, ScopeContractData>,
  cfg: ParallelGateConfig,
): DecompositionGateResult {
  void story;
  void peers;
  void contracts;
  void cfg;
  throw new Error('NotImplemented: evaluateDecompositionGate');
}
