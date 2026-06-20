# B-986c — Real-machine acceptance (parallel-decomposition gate verdict)

Story 2 of the parallel-decomposition gate program. evaluateDecompositionGate is the PURE
verdict: from a story, its peers, their scope contracts, and the gate config it returns
advisories + an optional PROVABLE block reason. It does not enforce cfg.mode (Story 5 does)
and is not yet wired into canStartDevGuard (Story 5) — so it has no end-user-visible gate
enforcement YET; its user-observable acceptance is the verdict behavior via its hermetic smoke.

## 5-question user-value self-check

1. **Who / what?** The PLAN→DEV guard (Story 5) and the wave/review surfaces (Story 4) will
   call this verdict to decide/advise whether a parallel decomposition is genuinely disjoint.
2. **What was missing?** The overlap MATH existed (Story 1) but nothing turned it into a
   verdict; evaluateDecompositionGate was a NotImplemented skeleton.
3. **What's delivered?** A pure verdict that BLOCKS only on provable contradictions
   (tier-1 literal overlap; broad glob asserted parallel under the strict profile WITH active
   peers; an active parallel peer with an unreadable contract) and ADVISES on everything
   heuristic (tier-2 shared-prefix, broad without strict/peers, stale depends edges).
   §4.8 fail-OPEN on own unreadable contract; fail-CLOSED on a peer's; no-active-peers no-op.
4. **How observed?** The 32-assertion hermetic smoke (registered in lattice.config.json) +
   the live demo below.
5. **Gap vs need?** fake_dependency_chain is advise-only (the depends model carries no cited
   symbol; spec §4.5). Enforcement wiring is Story 5. No other gap for the verdict itself.

## Expected (from PLAN)

- A tier-1 literal write-set collision between two active parallel stories -> `block:"overlap_declared_parallel"`.
- A broad glob asserted parallel under the strict profile, with an active peer -> `block:"broad_glob_unprovable_parallel"`.
- A clean disjoint parallel pair -> `block:null`, no advisories.
- A lone parallel story (no active peers) -> §4.8 no-op: `block:null` AND empty advisories.

## Actual (observed on this machine, 2026-06-20, darwin)

```
OVERLAP      => {"advisories":["literal write-set collision with parallel peer P: src/x.ts"],"block":"overlap_declared_parallel"}
BROAD/strict => {"advisories":["broad glob asserted parallel-safe (strict profile): src/**"],"block":"broad_glob_unprovable_parallel"}
CLEAN        => {"advisories":[],"block":null}
LONE no-op   => {"advisories":[],"block":null}

# full validate (the smoke is a configured command):
✓ configured validate.commands[7]: node packages/main/dist/tasks/parallel-decomposition-gate-smoke.js
  parallel-decomposition-gate smoke passed: 32 assertions
```

## Diff (expected vs actual)

None. Actual matches expected on every point: the overlap block cites the colliding path +
peer; the broad-strict block cites the glob; the clean pair and the lone story both return
`block:null` with empty advisories (the §4.8 no-op). `lattice validate --story=B-986c`
reports verificationCoverage covered=32/32, missingRequired=0.

## Dual-host review

Genuine cross-provider review over 3 rounds: Claude (concept/quality/test-coverage) + Codex
host-2 (`codex exec`). Codex round-1 caught 2 real MAJORs against spec §4.8 — a broad-glob
hard block with zero active peers, and a missing-OWN-contract that was not a true fail-open —
that all three Claude lanes missed. 7 findings (F-001..F-007) all resolved; round-3 both
hosts PASS, 0 findings.
