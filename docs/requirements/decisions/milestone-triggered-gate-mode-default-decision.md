# Decision: Milestone-triggered gate-mode default stays `observe`

Status: decided
Story: B-f7b3 (CHK-009)
Source finding: docs/requirements/decisions/milestone-ledger-status-review-findings.md — M3/M7 (gate-mode default question)
Date: 2026-07-05

## Question

The B-b550 audit (M3 correction) established that the ProofStory strict-DONE milestone
gate only *blocks* when `doneGateMode === 'enforce'`; the default is `observe`, under
which milestone gaps are surfaced as advisories but do not block DONE. M7 asked whether
milestone-*triggered* stories should default to `enforce` instead of `observe`.

## Decision

**`observe` stays the default. Do NOT flip `doneGateMode`'s default to `enforce`, and do
NOT build an implicit "enforce-for-triggered" default.** `enforce` remains strictly
opt-in per project via `.lattice` config (`proofStory.doneGateMode: "enforce"`).

This closes findings M3/M7 with a recorded decision rather than a code change to the
default. It does not weaken the read-only / PLAN-only milestone contract: the strict path
is left exactly as-is, reachable only by explicit operator opt-in.

## Rationale

Source facts (verified in this worktree):

- `doneGateMode` resolves via `loadConfig(root).proofStory?.doneGateMode ?? 'observe'`
  (`packages/main/src/core/config.ts`; consumed at
  `packages/main/src/handlers/phase-gates.ts`, in `configuredProofStoryMode`). It is a single **flat,
  project-wide** default — there is no per-story or per-trigger mode selection anywhere in
  the code today. So the literal option "enforce-for-triggered" corresponds to no existing
  switch; delivering it would require BUILDING new machinery that keys the mode off
  `hasMilestonePath` / `classifyTriggers`. That is itself a wide behavior change and is out
  of scope for a decision item.
- `hasMilestonePath` (`packages/main/src/core/proofstory.ts`) auto-activates the
  strict path whenever a ledger has ≥1 milestone OR a slice plan exists OR the
  `milestone-ledger` trigger fired. That trigger (`classifyTriggers` in `proofstory.ts`)
  fires on **fuzzy regex text signals** (≥2 structural rows, "all/every/remaining
  milestones", "M1-M5" ranges, explicit milestone mentions). Defaulting *triggered* stories
  to `enforce` would therefore hand a hard DONE-blocking gate to any story whose prose
  happens to match those regexes — a wide, surprising blast radius across every
  milestone-triggered story, including in-flight ones.
- The B-b550 audit confirmed the milestone surface is **safe today**. The goal of this
  program is to close observability/coverage gaps, not to introduce a behavior change that
  could block existing DONE flows (e.g. B-b550's own confirmed-ledger closeout).

Conclusion: making `enforce` the default is a high-blast-radius behavior change that the
audit does not require. The conservative, contract-preserving choice is to keep `observe`
as the default and leave `enforce` as an explicit per-project opt-in.

## Consequences / risks accepted

- Strict-DONE coverage stays OFF by default, so a story *can* reach DONE with uncovered
  milestone rows unless the project opts in. **Mitigation:** observe-mode still renders the
  gaps as visible (non-blocking) diagnostics, so drift is surfaced, just not blocked.
- A future contributor might read "default observe" as an oversight and flip it.
  **Mitigation:** this decision doc + a code comment at the default site + a regression test
  pinning the default to `observe`.
- Per-trigger gate-mode selection ("enforce only for milestone-triggered stories") is a
  legitimate future capability but a separate build, not a config default. **It is
  explicitly deferred to a future story**, not silently dropped.
- This decision governs only the DEFAULT. Projects that have already set
  `doneGateMode: "enforce"` keep it — no regression.

## Verification

A committed regression test pins the config default to `observe` when unset, so a future
accidental flip is caught. It exercises the **real** resolver
`configuredProofStoryMode` (`packages/main/src/handlers/phase-gates.ts`,
`return loadConfig(ctx.root).proofStory?.[key] ?? 'observe';`) against a fresh temp root
with no `lattice.config.json`, asserting both `doneGateMode` and `reviewGateMode` resolve
to `observe`. Because the test drives the shipped resolver (not a re-implemented default),
flipping the `?? 'observe'` fallback to `?? 'enforce'` makes it fail.

Test location: `packages/main/src/tasks/milestone-done-gate-reconciliation-smoke.ts`,
block "(c) gate-mode DEFAULT pins to 'observe' when config is unset". (See CHK-009
verification intent.)
