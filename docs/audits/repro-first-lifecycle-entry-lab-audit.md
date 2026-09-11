# Repro-first lifecycle-entry Lab audit

Date: 2026-09-10
Lab: `repro-first-plan-integration-0306`
Lab branch: `codex/lab-repro-first-plan-integration-0306`
Lab base: local `main` commit `4e46d3723ef8ddf70ad8c797ff8eccf6cbe02619` (0.3.306)
Scope: bounded Lab maintenance evidence; this is not formal Story REVIEW, TEST, DONE, or release evidence.

## Design truth

The imported design pair remains byte-identical to the already approved v37/rev14 pair:

- execution plan SHA-256: `25e17517ec646147ac4ddfe3fdc508772461661e7509c3be3cb8058144125e3f`
- companion spec SHA-256: `763cbaa39d21055d10b4c106b9b44afd5725edcbc8479b16d293308a5dd9e48a`

`docs/audits/repro-first-gate-enforce-plan-claude-audit.md` contains the matching Claude CLI approval fence. A proposed v38 current-state reconciliation was not retained because its full 4,994-line audit timed out without a verdict; no approval was fabricated or appended. The Lab implements only the direct lifecycle-entry closure described below. It does not claim that the full trusted RED-to-GREEN program is implemented or enabled.

## Before and after

| Surface | Before repair | After repair |
|---|---|---|
| Public `story_create.phase` | Accepted `IDEA|INIT|INIT_CHECK|PLAN|DEV|REVIEW|TEST|DONE` | Accepts `IDEA|INIT` only and emits `story_create_direct_lifecycle_phase_forbidden` otherwise |
| Handler fallback | Refused only direct `INIT_CHECK`; direct `DONE` could persist terminal state | Independently refuses all six post-intake phases before any Story persistence |
| Terminal checklist/review fields | Direct `DONE` marked checklist items done; direct `REVIEW` minted `currentReviewRound` | Unreachable terminal/review seeding removed |
| Onboarding compatibility | Hint and tests treated direct `DONE`/`REVIEW` as supported | Historical fixtures use fixture-only state setup; no onboarding path mints lifecycle credentials |

## RED

The Lab runner executed the committed reproducer at head `aca8d5d8180df257d75a0634a02840625f5957b1`:

```text
node packages/main/tests/red/red-story-create-direct-done-bypass.mjs
exit: 1
RED::DIRECT_DONE_STORY_CREATE_BYPASS: story_create persisted B-5f3d directly in DONE
```

The marker matched the predeclared Lab expectation and the runner recorded the RED locally.

## GREEN and regression coverage

The same command now prints `GREEN::DIRECT_DONE_STORY_CREATE_REFUSED` and exits zero. It is registered as `npm --prefix packages/main run test:story-create-direct-lifecycle`.

Additional passing checks before final Lab integration:

- package build;
- 37-case repro-evidence binding DEV gate smoke;
- scope anti-expansion smoke;
- CLI black-box rejection of `INIT_CHECK|PLAN|DEV|REVIEW|TEST|DONE` with no Story directory persisted;
- positive CLI creation for explicit `IDEA` and `INIT`;
- two real-process concurrency suites, each running four rounds of ten concurrent creators;
- deduplication, advisory-channel, terminal-fixture, and malformed-time regressions;
- process-fact contract verification, including handler and CLI-schema inventory pins.

The broad `field-regression-cli-smoke` currently fails on the same unrelated cluster-finding assertion on both untouched local main and this Lab. The failure predates and is outside the lifecycle-entry change; the collateral review-loop input assertions touched during migration were preserved in their existing REVIEW smoke.

## Claude CLI audit

Claude CLI 2.1.268 performed three read-only code-diff reviews. The first two exposed missing CLI coverage, stale onboarding compatibility, unregistered RED execution, and two collateral review-loop assertions. Those issues were repaired and retested. The final exact-diff review returned:

```text
VERDICT: APPROVE
REQUIRED_CHANGES: NONE
```

Its attestation explicitly confirmed the public CLI error code, handler-before-persistence ordering, six forbidden phases, `IDEA|INIT` positive coverage, fixture-only terminal setup, restored review-loop assertions, runnable RED script, and process-fact inventory coverage. Execution claims in this log come from the Lab runner and local test transcripts, not from Claude's read-only diff review.

## Story draft preservation

Story worktree `.worktrees/B-de09` remained clean on branch `story/B-de09`; no Story JSON, signed receipt, phase transition, or new Story commit was produced by this Lab. Only the three final document files were copied into the Lab. The separate draft-protection branch `codex/preserve-main-drafts-20260910` remains outside the Lab integration.
