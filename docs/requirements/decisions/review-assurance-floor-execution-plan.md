# Review Assurance Floor Execution Plan

Status: accepted
Source story: B-503b
Source proposal: DDP-001
Created: 2026-06-19

## Decision

Proof-or-Stop should add a mandatory review assurance floor for code-changing stories: ordinary code diffs require at least one review round before DONE, failure or bug signals escalate to three local single-host rounds, and high-risk lifecycle/gate/Authority/process-fact work keeps the stronger three-round two-host or explicit degraded-single-host path.

## Context

A small development task can look low risk during PLAN but still ship a bug when it reaches DONE with no review floor. Existing review escalation is threshold-triggered by first REVIEW round countable findings, which is useful but does not prevent zero-review code closure. This plan documents the missing floor and the escalation rule without implementing runtime code in this story.

## Scope

Applies to future Proof-or-Stop CLI lifecycle policy and DONE closure design for code-changing stories. This document is a planning and policy artifact only; runtime DONE oracle implementation, storage fields, and exact row ids are future work.

## Non-Goals

- Do not force every code-changing story into three rounds by default.
- Do not weaken existing review_escalation_status, decision_doc_quorum_check, or DONE gates.
- Do not claim local 3x1 review is two-host independent review.
- Do not claim Authority completion without verified Authority Server gate_decision receipts.
- Do not implement runtime gate code in this story.

## Options Considered

### Force every code change through three local single-host rounds

Pros:
- Simple to explain
- Stronger than one-round review for every code diff

Cons:
- Over-applies heavy review to clean small changes
- Raises token and time cost without requiring a real failure signal

### Keep current threshold-triggered review escalation only

Pros:
- No new policy or implementation work
- Preserves current lifecycle behavior

Cons:
- Does not solve zero-review code DONE
- Misses low-risk-looking tasks that only reveal bugs after implementation

### Require full 3x2 for every code change

Pros:
- Maximal independent review assurance
- Reduces reliance on single-host judgment

Cons:
- Too expensive for ordinary small code changes
- Can block local development when a second host is unavailable

## Chosen Approach

Introduce a review assurance floor: zero-review code DONE is invalid; clean ordinary code requires at least one review round; real failure signals such as validation fail, bug, verified reviewer finding, post-DONE regression, or repeated rework make 3x1 local single-host audit sticky for closure; high-risk gate/Authority/lifecycle/process-fact work still requires 3x2 unless explicit degraded-single-host evidence is recorded.

## Operational Rules

- If a story has no material code diff, it may use the existing docs/typo/annotation policy for one-round low-risk review.
- If a story has a material code diff, DONE must require at least one review round over the current material hash.
- If a story records a validation fail, bug, verified reviewer finding, post-DONE regression, or repeated rework signal, DONE must require three rounds x one local host unless stronger policy requires 3x2.
- Failure-triggered 3x1 escalation must be sticky for the story material until DONE or an explicit approved fallback supersedes it.
- Lifecycle, gate, Authority, review, and process-fact work remains high-risk and should use three rounds x two hosts, or an explicit degraded-single-host fallback when policy allows.
- Local host verdicts and degraded fallback evidence are Non-authority evidence and must not set authorityDone, fullAuthorityDone, or productionDone.
- Future implementation must fail closed on stale material hash, missing host identity, missing prompt or validation binding, and duplicate/self-claimed assurance.

## Local Diagnostic UX

The local diagnostic surfaces are operator guidance only. They explain why a
local DONE pre-check is blocked and which local commands refresh the evidence;
they do not create remote proof, Authority receipt evidence, or a new completion
capability.

- `autopilot_review_status --storyId=<storyId>` may show all local run ids and
  latest local run summaries, including counted and ignored host verdicts.
- `review_escalation_status --storyId=<storyId>` may show
  `voluntaryLocalRounds` even when escalation is not required. That visibility
  must not change `required`, `ok`, or `assuranceLevel`.
- A review-assurance DONE block should render `Stale material recovery` with:
  `proof-or-stop validate --story=<storyId> --json`,
  `proof-or-stop verification_evidence_refresh_stale --storyId=<storyId> --dryRun`
  followed by the same command without `--dryRun` after rerunning listed
  evidence commands, and `node bin/proof-or-stop.js autopilot_review_submit ... --materialDigest=<current-materialHash>`
  for fresh local host verdicts.
- The degraded-single-host writer guidance emits one executable worktree-local
  `node bin/proof-or-stop.js autopilot_review_submit` command per required round; it
  does not rely on a global `proof-or-stop` runtime that may resolve an older main
  build. Each command uses explicit `--deriveBindings`, a real local
  hostname/session identity, and the current material/story-files hashes. The
  handler holds the story validation-execution lock keyed by the same canonical
  metadata/runtime root used by validation writers (including wrapper-root
  layouts) while applying the same
  canonical PASS-admissibility predicate as the TEST gate: canonical command,
  parseable `allPass`, current complete verification-coverage snapshot, no
  blocking dirty paths, exact material/story-files identity, and exact-head or
  trusted story-metadata-descendant lineage. It then derives the complete
  canonical `keyId`/`validationDigest`/`promptDigest` envelope and persists the
  single verdict plus process event before releasing the lock.
  Any supplied binding mismatch fails before persistence. Omitting
  `--deriveBindings` retains the legacy warning/non-counting behavior and does
  not silently synthesize bindings.
- Stale verification evidence and stale or ignored host verdicts remain
  non-counting until refreshed or resubmitted over the current material hash.
  The runbook must not suggest bypassing stale-material checks.

## Verification Requirements

- A future smoke test proves an ordinary code-diff story cannot reach DONE with zero review rounds.
- A future smoke test proves a clean ordinary code-diff story can close after one valid review round.
- A future smoke test proves validation failure or bug evidence makes 3x1 required and sticky before DONE.
- A future smoke test proves high-risk lifecycle/gate/Authority/process-fact stories still require 3x2 or explicit degraded-single-host evidence.
- A future smoke test proves 3x1 evidence reports assuranceLevel=degraded-single-host and never claims Authority Server receipt-backed completion.
- A smoke test proves stale-material recovery text names stale local host
  verdicts, truncates long ignored-verdict details, shows the validation,
  stale-evidence refresh, and local verdict resubmission commands, and preserves
  the local/non-authority boundary.
- A smoke test proves the executable degraded guidance covers three distinct
  one-host rounds, rejects stale/tampered bindings before write, and never
  fabricates a second host or upgrades degraded assurance to 3x2.

### Atomic local quorum persistence

`quorum_submit` closes its bounded host-verdict batch as one immutable metadata
transaction. It requires a clean entry HEAD/index/worktree, verifies that the
`process-events.jsonl` delta contains exactly the invocation's `rounds × 2`
`host_verdict` rows, runs normal commit hooks, and installs the exact metadata
tree through a HEAD compare-and-swap. Pre-existing dirt is refused before any
verdict write. Hook, content, or HEAD failures remove every generated verdict
row and ignored local verdict file together; concurrent foreign bytes are
preserved and reported rather than staged or overwritten. The assurance
evaluator therefore consumes a durable complete quorum, never a partial dirty
batch left by a failed closeout. `quorum_submit` owns this terminal completely:
the CLI does not append a generic post-handler `codex_cli` row that would dirty
the just-committed file. Same-material duplicate refusal reads committed
`process-events.jsonl`, not the gitignored local verdict cache. Rollback removes
only frozen event/JSON byte spans, preserving altered files and arbitrary
foreign binary suffix bytes exactly.

## Risks

- Over-escalation could waste tokens if every source diff is treated as failure-triggered.
- Under-escalation could persist if failure signals are not captured in a gate-consumed artifact.
- Confusing 3x1 with two-host independence would overclaim review assurance.
- Confusing local host verdicts with Authority receipts would violate the Authority boundary.

## Supersession

If this decision changes, update this file through a Proof-or-Stop story. Because
this file is under `docs/requirements/decisions/*.md`, future edits should use
the current story-lifecycle review escalation policy: direct decision-doc edits
are diagnostic/classification inputs, and DONE requires 3x2 only when the
review escalation trigger or an explicit high-risk policy requires it.
