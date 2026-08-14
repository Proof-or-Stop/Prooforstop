# Quorum Duplicate-Guard: downgrade-aware fix — Design Spec (rev 3, draft)

Status: DRAFT for review · Date: 2026-07-25 · Author: jek + Claude (brainstorming)
Supersedes: rev 1 (PreToolUse-as-gate) and rev 2 (per-story lock + atomic critical
section) — both retracted after two rounds of cross-host audit (Codex + Agy).

## 0. Why rev 3 (what two audit rounds established)

- Rev 1 (PreToolUse hook + CLI pre-check): a hook cannot enforce (fail-open, sees a
  raw Bash program not argv, trivially evaded), and a pre-check before the handler
  is TOCTOU-racy. Retracted.
- Rev 2 (per-story lock + atomic critical section): direction affirmed, but it
  **over-reached into concurrency hardening the actual burn never exhibited**, and
  in doing so introduced new blockers — AB/BA lock-ordering vs `main-write-lock`,
  a sync→async handler-contract change, a fail-closed path with no ledger-recovery
  story, and a cross-host mutual-exclusion guarantee a filesystem lock cannot give.
  Retracted.
- **The real burn (S3) was same-host, sequential re-submission after a `main`
  merge — not concurrent racing.** Root cause: the duplicate guard keys on the raw
  material digest, while the floor accepts the prior verdict via
  `eventsWithStoryFilesHashDowngrade` (stable `storyFilesHash`). A merge that
  changes material but not `storyFilesHash` lands in the gap: the prior verdict is
  no longer "same material" to the duplicate guard, so a second quorum is appended.

Rev 3 fixes exactly that gap and nothing more.

## 1. Goal

Make `quorum_submit`'s existing duplicate-runId guard **downgrade-aware**, so a
re-submission of a round whose verdict is already recorded — and still accepted by
the floor via `storyFilesHash` downgrade — is recognized as a duplicate and
refused. Reuse the existing exact-byte transaction + HEAD CAS for atomicity. No new
lock, no async-contract change, no cross-host claims.

Explicit non-goals: concurrent multi-host mutual exclusion; guarding
`autopilot_review_submit` / `story_advance` / `verification_evidence_add`; any
PreToolUse hook; any general "quorum-evidence idempotency" claim.

## 2. The fix (design proposal — see note on what actually shipped)

> **Delivered differently (B-3144, merged):** the shipped
> `assertNoStandingQuorum` in `handlers/quorum-submit.ts` does NOT call
> `eventsWithStoryFilesHashDowngrade` directly as proposed below. It
> reimplements the same drift-accept predicate inline, hand-synced
> ("LOCKSTEP", per the guard's own comment) with the floor helper, because the
> guard needs a pre-commit boolean collision check while the floor helper
> rewrites already-committed events post-hoc — the two don't share a call
> signature that fits both use sites. The refusal is a thrown `Error` with a
> caller-facing explanation, matching this doc's intent, but the "single
> source of truth" framing below (§ "Single source of truth") is aspirational,
> not literally what was built; a future change to the floor's drift-accept
> predicate must update the guard's mirror in the same story or the two
> silently diverge. The rest of this section is preserved as the original
> design rationale.

In `handlers/quorum-submit.ts`, the duplicate guard (currently ~lines 474–490)
reads committed `host_verdict` events and refuses if one exists for a planned
runId (`${storyId}-q-r${round}`) **at the same `materialDigest`**.

Change: before comparing, pass the committed events through
`eventsWithStoryFilesHashDowngrade(events, currentMaterialHash,
currentStoryFilesHash, advisories)` (`core/review-escalation.ts:948`) — the same
helper the floor uses. This rewrites the `materialDigest` of prior verdicts whose
`storyFilesHash` matches the current one to the current material digest. The
existing runId duplicate check then sees the post-merge prior verdict as current
and refuses the redundant re-submit.

Semantics stay narrow and correct: the criterion is **"a verdict for this exact
runId already exists (after downgrade)"**, NOT "the floor is satisfied". A
genuinely new round (`round+1`, different runId) has no matching prior verdict and
is never refused — so an escalation that still needs another quorum is unaffected.
This is deliberately the opposite of rev 2 §4, whose floor-satisfaction shortcut
would have falsely refused needed submissions (audit blocker).

### Single source of truth
The downgrade helper is the one the floor already consumes; using it here makes the
duplicate guard and the floor agree by construction. The gap that produced S3 was
precisely the two disagreeing.

## 3. Atomicity — reuse what exists, add one cheap revalidation

No new lock. The existing `commitLifecycleMetadataTransaction` already performs a
HEAD `update-ref` CAS, which aborts if HEAD moved under the operation — sufficient
for the sequential same-host case that burned us.

Optional hardening (small, in the same handler): immediately before the commit,
re-derive `currentMaterialHash` / `currentStoryFilesHash` and re-run the
downgrade-aware duplicate check against freshly-read committed events. This closes
the narrow window where an *uncommitted/untracked* change (which leaves HEAD
unchanged, so the CAS does not catch it) drifts material between the initial check
and the commit. Marked optional so the core change stays minimal; include if the
RED test shows the window is reachable.

## 4. Fail behavior — degrade to today, never strand

If the downgrade-aware evaluation cannot run (unreadable/parse-failed events), fall
back to the **current** raw-digest duplicate check (today's behavior) and proceed.
This introduces no new hard-fail path, so it needs no process-events recovery story
and cannot strand an escalation-required story — sidestepping the rev 2 fail-closed
blocker. The fix only ever makes the existing check *smarter*, never *stricter in a
way that can brick the workflow*.

## 5. Known residuals (explicitly NOT closed)

State these in code comments and the story so no false "idempotent" claim is made:

- **Concurrent multi-host racing** is not closed. Two independent checkouts have no
  shared lock; the existing exact-byte transaction + HEAD CAS give best-effort
  protection only. Out of scope by design (a filesystem lock cannot provide it).
- **`autopilot_review_submit`** ordinary path writes the same `host_verdict`
  evidence and can still append a redundant single verdict after a merge — the same
  class, deferred. A fast-follow can reuse this same downgrade-aware check on that
  path.
- No claim of general quorum-evidence idempotency; this fixes one specific
  duplicate-runId gap.

## 6. Testing

- **S3 repro (RED):** set up a satisfied round; apply a `main` merge that changes
  material but leaves `storyFilesHash` stable; re-run `quorum_submit` for the same
  round. Assert current code appends a redundant quorum; assert the downgrade-aware
  guard refuses it after the fix.
- **No false refusal (regression guard for the rev-2 blocker):** a story where
  escalation legitimately requires a further round — assert the new guard does NOT
  refuse the needed, distinct-runId submission.
- **Fallback:** corrupt/unreadable events → guard degrades to raw-digest behavior,
  no throw, no strand.
- (If §3 optional hardening is included) **uncommitted-drift window:** mutate
  material without moving HEAD between check and commit; assert the pre-commit
  revalidation refuses.

## 7. Implementation path

Lands through a Lattice story (audit trail), not a direct commit to `main`. It
touches the `quorum_submit` guard, so it is a high-assurance change and should go
through full cross-host quorum review itself — dogfooding the very command it fixes.
