# Plan — B-59c7 Story 0: parallel-decomposition gate contract

## Overview
Freeze the gate's shared interface as one new pure-function module plus a single type-only field on AuditConfig. No runtime logic; every function is a NotImplemented skeleton that the four parallel impl stories fill in later.

## CHK-001 — Create parallel-decomposition.ts contract
Create packages/main/src/core/parallel-decomposition.ts exporting:
- type ParallelGateMode = 'advise' | 'block' | 'off'
- interface ParallelGateConfig { mode: ParallelGateMode; maxConcurrentReview: number; broadGlobBlocks: boolean }
- const VALID_PARALLEL_MODES: ReadonlySet<ParallelGateMode>
- type ParallelDecompositionBlock = 'overlap_declared_parallel' | 'broad_glob_unprovable_parallel' | 'fake_dependency_chain' | 'peer_contract_unreadable_parallel'
- function computeWriteSet(contract: ScopeContractData): string[]  // throws NotImplemented
- function globsOverlap(a: string[], b: string[]): { overlap: boolean; pairs: [string,string][]; broadSide: 'a'|'b'|'both'|null }  // throws NotImplemented
- function evaluateDecompositionGate(story: StoryInfo, peers: StoryInfo[], contracts: Map<string, ScopeContractData>, cfg: ParallelGateConfig): { advisories: string[]; block: ParallelDecompositionBlock | null }  // throws NotImplemented
Verify: tsc passes; each skeleton body is exactly throw new Error('NotImplemented: <name>').

## CHK-002 — Add parallelGate field to AuditConfig
Edit packages/main/src/core/audit-config.ts:
- import type { ParallelGateConfig } from './parallel-decomposition.js'
- add `parallelGate: ParallelGateConfig;` to the AuditConfig interface only
- do NOT modify resolveAuditConfig / HARD_DEFAULTS resolution (deferred to Story 3)
Verify: tsc passes; the diff is one import + one field line.
