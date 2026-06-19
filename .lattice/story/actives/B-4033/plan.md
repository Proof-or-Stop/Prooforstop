# Plan — B-4033 Story 1: static overlap engine

## Overview
Implement the conservative two-tier glob-overlap engine in a new file core/parallel-decomposition-overlap.ts (file-disjoint from sibling stories), plus a smoke test. Pure functions; imports types from the frozen contract.

## CHK-001 — computeWriteSet + globsOverlap in core/parallel-decomposition-overlap.ts
- computeWriteSet(contract: ScopeContractData): string[] = dedupe(allowedModify ++ allowedCreate)
- globsOverlap(a: string[], b: string[]): GlobOverlapResult
  - tier-1: normalize + literal-path set intersection (zero false positives) → pairs
  - tier-2: shared-directory-prefix heuristic when one side has trailing /* or /** and shares a below-root prefix → possible overlap (conservative)
  - broadness: NARROW (literal | dir/* | dir/** below package root) vs BROAD (dir/** at/near repo root or spanning >1 second-level dir); set broadSide ∈ a|b|both|null
- import GlobOverlapResult / ScopeContractData from parallel-decomposition.js. No I/O.

## CHK-002 — grammar validator + smoke (packages/main/src/tasks/parallel-decomposition-overlap-smoke.ts)
- validateWriteSetGrammar(entries): rejects mid-path ** (e.g. src/**/*.ts) and bare top-level *; allows literal | dir/* | dir/**
- smoke asserts: literal overlap, tier-2 dir-prefix over-flag, BROAD + broadSide, disjoint→no overlap, grammar rejection; prints PASS and exits 0, throws/exits non-zero on failure
- run: node packages/main/dist/tasks/parallel-decomposition-overlap-smoke.js
