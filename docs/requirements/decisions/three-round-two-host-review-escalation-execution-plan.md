# Three-Round Two-Host Review Escalation Execution Plan

Date: 2026-06-14
Story: B-1550
Status: Execution plan

## Purpose

This document defines the execution plan for making Lattice review escalation
mechanical:

```text
Default: ordinary stories use the existing REVIEW flow.
Escalation: if the first REVIEW round records >=2 countable problems,
            the story requires 3 quorum rounds x 2 independent PASS hosts
            before DONE.
Documentation audit: documentation and decision-doc changes use the same
                     default REVIEW path and the same automatic escalation
                     trigger as ordinary development.
Fallback: if 3x2 is required but only one verifier host is available or explicitly
          approved, policy may allow 3 quorum rounds x 1 PASS host as degraded
          single-host review.
Runtime: direct decision-doc edits are diagnostic only; review escalation is
         triggered by the first REVIEW round countable-problem threshold.
```

The plan also fixes the current weakness in the decision-doc quorum evaluator:
counting distinct `hostId` strings is not enough to prove host independence.
Future implementation must prove independence from durable host, session, key,
and material-binding facts.

This plan also defines an honest availability fallback. Degraded single-host
review keeps development moving when only one host can run, but it is not
equivalent to two-host independence and must be labeled as lower assurance in
status output, artifacts, and final summaries.

This document is a planning artifact. It does not implement source-code changes,
does not satisfy any future gate by itself, and does not claim Authority Server
receipt completion.

## Current State

Lattice currently has these pieces:

| Area | Current behavior |
| --- | --- |
| Ordinary REVIEW | A story enters REVIEW, reviewer lanes call `review_run_start`, then write `finding_add` or `review_pass_set`. If blockers are resolved, the story can proceed. One clean REVIEW round is usually enough. |
| Finding evidence state | `finding_add` defaults to `evidenceState=verified`; `suspected` and `disproven` findings are advisory and should not trigger escalation. |
| Decision-doc quorum | `decision_doc_quorum_check` remains a read-only diagnostic for direct changes to `docs/requirements/decisions/*.md`; direct decision-doc edits do not by themselves require 3x2 before DONE. |
| Host verdicts | `autopilot_review_submit` records local `host_verdict` process events consumed by the local review escalation gate when the first-round finding threshold fires. |
| Host identity binding | The review escalation gate counts host verdicts only when host, session, key, material, validation, and prompt bindings are present and fresh; stale material, duplicate identity, and FAIL/BLOCKED decisions fail closed. |
| Host availability gap | If only one host can run because of credits, auth, runtime, rate limits, or provider outage, strict 3x2 can block otherwise ready local development. |
| Documentation audit policy gap | The desired policy is now unified automatic escalation. Documentation and decision-doc changes should not require 3x2 solely because a documentation file changed. |

## Required Rule

### Default Rule

All stories start with the normal Lattice REVIEW flow.

The first version must not force every story through 3x2. Clean stories that
pass normal REVIEW without the escalation trigger should remain eligible for
the existing REVIEW -> TEST -> DONE path.

### Automatic Escalation Trigger

A story automatically requires 3x2 when the first lifecycle REVIEW round records
two or more countable problems.

The threshold is:

```text
firstReviewRound.countableProblems >= 2
```

This trigger is sticky. Once a story is escalated, later fixes, dismissals, or
clean follow-up review rounds do not remove the 3x2 requirement. The point of
the trigger is not whether the first-round findings still block; it is that the
first review exposed enough risk to require stronger final review.

### Documentation Audit Unified Rule

Documentation and decision-doc audit changes follow the Default Rule and the
Automatic Escalation Trigger. The low-risk annotation-compliance, pure typo,
or wording-only bucket stays in the one two-host audit round path defined in
`story-lifecycle.md`. A direct change to:

```text
docs/requirements/decisions/*.md
```

should be classified as governance documentation for diagnostics, reviewer
context, and migration checks, but it should not require 3x2 by itself under the
target policy.

The runtime gate is now migrated: direct decision-doc edits are
classification/diagnostic only. Operators should use `review_escalation_status`
to see whether the DONE escalation trigger actually fired.

### Degraded Single-Host Fallback Rule

Full 3x2 remains the default and preferred quorum. A story that requires 3x2 may
use degraded single-host review only through one of three explicit eligibility
values:

1. `single-host-environment`: the current local environment has only one viable
   verifier host.
2. `temporary-host-unavailability`: a second host was attempted or probed and is
   unavailable because of credits, auth, runtime, outage, or rate limits.
3. `explicit-human-approval`: the user or project policy explicitly approves
   single-host local review for this story even though it does not prove
   second-host unavailability.

All three eligibility values require project policy to allow degraded review for
the story's risk class. No degraded fallback is equivalent to two-host
independence.

The degraded fallback is:

```text
3 quorum rounds x 1 PASS host
assuranceLevel = degraded-single-host
```

Allowed fallback eligibility values are:

- `single-host-environment`;
- `temporary-host-unavailability`;
- `explicit-human-approval`.

The fallback must be explicit. It must not be inferred from a missing verdict,
timeout, or convenience preference alone. The evaluator must record the fallback
eligibility, a free-form reason, `evidenceRefs` or `approvalRef`, and current
head/material/validation binding.

Degraded single-host review must never be reported as "3x2 passed", "two-host
independent", or Authority receipt completion. It may unblock local lifecycle
progress only with a visible lower-assurance marker.

High-risk changes may require stricter project policy before using the fallback.
For gate, authority, process-fact, or escalated documentation changes, the
initial implementation should require either explicit user approval for the
degraded fallback or a project configuration that opts into degraded review for
that risk class.

## Definitions

### First REVIEW Round

The first REVIEW round is the first lifecycle REVIEW round entered after the
story first completes DEV and advances to REVIEW.

Implementation should derive it from existing REVIEW transition evidence rather
than a prose label. The first round must be stable even if the story rolls back
to DEV and later enters REVIEW again.

### Countable Problem

For version 1, a countable problem is a reviewer-lane finding that satisfies all
of the following:

1. It was recorded through `finding_add`.
2. It belongs to the first lifecycle REVIEW round.
3. It was produced by a reviewer lane, not the main author or a B-META audit
   container.
4. Its `evidenceState` is `verified`, or the field is absent on legacy data and
   is therefore treated as verified.
5. Its severity is `critical`, `high`, or `medium`.
6. It is not a pass-only finding normalized to `review_pass_set`.
7. It is not `suspected`, `disproven`, advisory-only, dismissed as invalid, or a
   plain note.

Low-severity findings do not trigger 3x2 in version 1. They remain useful
review feedback, but counting every low-severity style note would make normal
development too easy to escalate accidentally. If the project later wants all
verified severities to count, that should be a separate policy change with its
own tests.

### Quorum Round

A quorum round is one final independent review wave identified by a `runId` or
equivalent `reviewWaveId` in host-verdict evidence.

This is intentionally separate from the lifecycle REVIEW round. The lifecycle
REVIEW round decides whether escalation is required. The quorum rounds prove
that the final material was reviewed by independent hosts after implementation
and validation settled.

### Independent Host

For new 3x2 evidence, two PASS verdicts are independent only when they do not
share identity anchors that could represent the same reviewer execution context.

At minimum, counted verdicts must expose:

- `hostId`;
- `provider`;
- `sessionId`;
- `keyId` or an equivalent signing identity digest;
- `verdictId`;
- `runId` or `reviewWaveId`;
- `storyId`;
- `decision`;
- current `materialDigest`;
- current `headHash` when available;
- current `validationDigest` after TEST evidence exists;
- `promptDigest` or review profile digest for the final-review prompt;
- issue time.

For stories created after rollout, missing `sessionId` or missing key identity
must fail closed for the 3x2 gate. Provider diversity is useful diagnostic
context, but provider name alone is not a proof of independence.

### Degraded Quorum

A degraded quorum is a final review quorum that has enough rounds but not enough
independent hosts.

Version 1 allows degraded quorum only as:

```text
3 quorum rounds
AND each quorum round has at least 1 PASS host verdict
AND every counted verdict is bound to current head/material/validation evidence
AND fallback eligibility is one of single-host-environment,
    temporary-host-unavailability, or explicit-human-approval
AND the result is reported as degraded-single-host
```

Three PASS rounds from one host can catch repeated reasoning mistakes and stale
material, but they do not prove host independence. The gate must preserve that
difference in machine-readable fields and human-readable output.

## Gate Placement

### REVIEW Gate

REVIEW remains responsible for ordinary reviewer findings and passes.

When first-round findings trigger escalation, REVIEW output should report:

```text
3x2 review escalation: required
reason: first REVIEW round countable problems >= 2
```

REVIEW should not require the final 3x2 quorum before TEST. Forcing final quorum
before validation creates stale-review risk when TEST or later fixes change
material.

### TEST Gate

TEST should expose escalation status and refresh validation evidence. When a
story is escalated, `lattice validate` should make it clear that validation pass
is necessary but not sufficient for DONE.

### DONE Gate

DONE is the hard enforcement point.

Before DONE, Lattice must evaluate:

```text
requires3x2 = firstReviewRoundCountableProblems >= 2
```

Current runtime has migrated to this predicate. Direct decision-doc edits are
classification/diagnostic only, and review escalation is triggered by the first
REVIEW round countable reviewer problem threshold.

If `requires3x2` is true, DONE must fail closed unless current material has:

```text
3 quorum rounds
AND each quorum round has 2 independent PASS hosts
AND every counted verdict is bound to current head/material/validation evidence
```

If `requires3x2` is true and the story cannot obtain a second host, DONE may
accept degraded single-host review only when all of the following are true:

```text
degradedFallback.allowed = true
AND degradedFallback.eligibility is one of the allowed fallback eligibility values
AND degradedFallback.reason is non-empty free-form explanatory text
AND degradedFallback.evidenceRefs or degradedFallback.approvalRef is present
AND current material has 3 quorum rounds
AND each quorum round has at least 1 PASS host verdict
AND every counted verdict is bound to current head/material/validation evidence
AND output reports assuranceLevel=degraded-single-host
```

The degraded path is an explicit weaker DONE path. It must not satisfy checks
that specifically require independent two-host review.

## Proposed Artifacts

### `review-escalation.json`

Add a story-local derived artifact for durable gate diagnostics. This artifact
must not be written by the read-only `review_escalation_status` command.

Version 1 should support two safe write paths:

1. DONE pre-check / DONE gate writes or refreshes the artifact while evaluating
   the hard gate.
2. A separate explicitly mutating command such as `review_escalation_snapshot`
   writes the same report for handoff diagnostics.

Read-only status commands compute the same report in memory and print it without
writing files.

```json
{
  "schemaVersion": "lattice.review_escalation.v1",
  "storyId": "B-xxxx",
  "policyVersion": "2026-06-14.v1",
  "requires3x2": true,
  "requiredAssurance": "two-host",
  "assuranceLevel": "missing",
  "quorumMode": "full-3x2",
  "triggers": [
    {
      "kind": "first-review-round-findings",
      "reviewRound": "2026-06-14T10:00:00.000Z",
      "threshold": 2,
      "countableProblems": 2,
      "findingIds": ["FND-001", "FND-002"]
    }
  ],
  "requiredQuorum": {
    "rounds": 3,
    "passingIndependentHostsPerRound": 2
  },
  "degradedFallback": {
    "allowed": false,
    "eligibility": null,
    "reason": null,
    "evidenceRefs": [],
    "approvalRef": null,
    "requiredRounds": 3,
    "passingHostsPerRound": 1
  },
  "materialBinding": {
    "headHash": "abc123",
    "materialDigest": "sha256:...",
    "validationDigest": "sha256:..."
  },
  "status": "missing-quorum"
}
```

The gate can compute this on demand, but a persisted gate/snapshot artifact
improves diagnostics, handoff, and session recovery. If persisted, it must
include enough hashes to detect staleness.

When degraded review is used, the artifact must set:

```json
{
  "requiredAssurance": "two-host",
  "effectiveAssurance": "degraded-single-host",
  "achievedAssurance": "degraded-single-host",
  "quorumMode": "degraded-3x1",
  "degradedFallback": {
    "allowed": true,
    "eligibility": "temporary-host-unavailability",
    "reason": "Second verifier host was unavailable because the provider was out of credits.",
    "evidenceRefs": ["host_runtime_probe:claude-code:credit-exhausted"],
    "approvalRef": "user-approved:B-xxxx:2026-06-15"
  }
}
```

The words `full-3x2`, `two-host`, and `degraded-single-host` should be stable
machine-readable values so downstream status commands and delivery summaries do
not blur the assurance level. `requiredAssurance` records the original policy
target; `effectiveAssurance` records the gate path actually accepted for this
story; `achievedAssurance` records what the evidence proves.

### Host Verdict Process Event

Extend local `host_verdict` process events so the quorum evaluator does not have
to rely on `hostId` alone.

Required fields for counted new-policy verdicts:

```json
{
  "type": "host_verdict",
  "mode": "local",
  "verdictId": "hv-...",
  "storyId": "B-xxxx",
  "runId": "round-1",
  "reviewWaveId": "round-1",
  "hostId": "host-a",
  "provider": "codex",
  "sessionId": "sess-...",
  "keyId": "key-...",
  "identityDigest": "sha256:...",
  "decision": "pass",
  "headHash": "...",
  "materialDigest": "...",
  "validationDigest": "...",
  "promptDigest": "...",
  "artifactDigest": "...",
  "signature": "ed25519:...",
  "signatureKeyId": "key-...",
  "signaturePayloadDigest": "sha256:...",
  "issuedAt": "2026-06-14T00:00:00.000Z"
}
```

Local verdict identity fields are not enough when they are self-asserted. Every
counted local verdict must include a signature over the canonical verdict
payload, and the quorum evaluator must verify that signature before counting the
verdict. The signed payload must include at least:

- `storyId`;
- `runId` or `reviewWaveId`;
- `hostId`;
- `provider`;
- `sessionId`;
- `keyId` or `identityDigest`;
- `decision`;
- `headHash`;
- `materialDigest`;
- `validationDigest`;
- `promptDigest`;
- `artifactDigest`;
- `issuedAt`.

The `keyId` used for independence must match the key that verifies the
signature. A verdict with mismatched `keyId`, unverifiable signature,
unsupported signature scheme, or missing signed material binding must not count.

Authority-backed verdicts may provide stronger server-minted identity and
receipt fields. Local verdicts remain local workflow evidence and must not set
`authorityDone`, `fullAuthorityDone`, `receiptVerified`, or `productionDone`.

## Independence Predicate

Create one shared predicate for all local 3x2 quorum checks.

Suggested module:

```text
packages/main/src/core/host-independence.ts
```

Required behavior:

1. Reject verdicts whose `decision` is not `pass`.
2. Reject verdicts whose material binding does not match current material.
3. Reject verdicts whose validation binding is stale or missing when validation
   evidence exists.
4. Reject verdicts whose canonical payload signature is missing or invalid.
5. Reject verdicts whose signed `keyId` does not match the key identity used for
   independence.
6. Reject duplicate `verdictId`.
7. Reject duplicate `hostId` in the same quorum round.
8. Reject shared `sessionId` in the same quorum round.
9. Reject shared `keyId` or `identityDigest` in the same quorum round.
10. Reject new-policy verdicts with missing `sessionId` or missing key identity.
11. Report ignored verdicts with structured reasons.

Pseudo-code:

```ts
function areIndependent(a, b) {
  if (!verifyVerdictSignature(a) || !verifyVerdictSignature(b)) return false;
  if (!a.hostId || !b.hostId) return false;
  if (!a.sessionId || !b.sessionId) return false;
  if (!identityKey(a) || !identityKey(b)) return false;
  if (normalize(a.hostId) === normalize(b.hostId)) return false;
  if (a.sessionId === b.sessionId) return false;
  if (identityKey(a) === identityKey(b)) return false;
  return true;
}
```

The same predicate must be used by:

- decision-doc quorum;
- review-escalation quorum;
- read-only quorum status commands;
- DONE pre-check output.

## Evaluation Algorithm

### Step 1. Classify Documentation and Decision-Doc Changes

Reuse the existing decision-doc changed-file detector:

```text
docs/requirements/decisions/*.md
```

This classification is for diagnostics, reviewer context, migration reporting,
and documentation-audit labeling. It must not set `requires3x2=true` by itself
under the target policy. Nested directories or alternate project-specific
decision paths remain out of scope unless a later story explicitly adds
configuration.

### Step 2. Count First-Round Problems

Read reviewer findings and signed reviewer-run bindings.

Count only findings that match the Countable Problem definition above.

Return:

```json
{
  "firstReviewRound": "2026-06-14T10:00:00.000Z",
  "countableProblems": 2,
  "findingIds": ["FND-001", "FND-002"],
  "requiresEscalation": true
}
```

### Step 3. Compute Current Material Binding

Use the same material-hash concept already consumed by validation and DONE
freshness gates. The evaluator must bind counted verdicts to current material,
not to stale source snapshots.

For DONE, include:

- current `HEAD`;
- current material digest;
- current validation digest or validation evidence id.

### Step 4. Group Verdicts Into Quorum Rounds

Group eligible PASS verdicts by `runId` or `reviewWaveId`.

Each quorum round is valid only if it contains at least two mutually independent
PASS verdicts after filtering stale, duplicate, failed, blocked, missing, or
non-independent entries.

### Step 5. Evaluate Full 3x2 Or Degraded 3x1

Pass only when:

```text
validQuorumRounds.length >= 3
AND every counted quorum round has >=2 independent PASS hosts
```

If full 3x2 fails only because a second independent host is unavailable, evaluate
the degraded fallback:

```text
degradedAllowed = projectPolicy.allowsDegradedSingleHost
                  OR explicitUserApprovalForThisStory

fallbackEligibility =
  single-host-environment
  OR temporary-host-unavailability
  OR explicit-human-approval

degradedPass =
  degradedAllowed
  AND allowedFallbackEligibility
  AND nonEmptyFreeFormReason
  AND fallbackEligibility
  AND evidenceRefsOrApprovalRefPresent
  AND validSingleHostRounds.length >= 3
  AND every counted single-host round has >=1 PASS host
  AND every counted verdict is fresh for current material
```

`evidenceRefs` or `approvalRef` is required for every degraded fallback. The
eligibility value must be reported separately from the free-form reason so
implementation cannot silently treat user approval as proof that a second host
was unavailable.

The evaluator result must distinguish:

```text
quorumResult=pass-full-3x2
quorumResult=pass-degraded-3x1
quorumResult=blocked
```

`pass-degraded-3x1` is allowed only for local lifecycle progress where policy
permits it. It must not be consumed by any claim that specifically requires
independent two-host proof.

Fail output must include:

- whether 3x2 is required;
- which trigger caused it;
- whether degraded fallback was considered;
- fallback eligibility, free-form reason, and evidence refs or approval ref when
  degraded fallback is used;
- current material digest;
- valid rounds count;
- missing rounds count;
- missing hosts per round;
- ignored verdict reasons.

## Proposed CLI Surface

### `review_escalation_status`

Read-only. Reports whether the story requires 3x2 and why.

This command must not write `review-escalation.json`. It should compute the
current report from story evidence, host verdicts, and current material, then
print text or JSON. Persisted snapshots belong to DONE gate evaluation or a
separate mutating command.

Example:

```bash
lattice review_escalation_status '{"storyId":"B-xxxx"}'
```

Expected text:

```text
Review escalation: required
trigger: first REVIEW round countable problems 2/2
quorum: 1/3 rounds valid
materialDigest: sha256:...
next: collect 2 independent PASS host verdicts for round-2 and round-3
```

If degraded fallback is active, expected text:

```text
Review escalation: required
trigger: first REVIEW round countable problems 2/2
quorum: degraded-single-host
valid single-host rounds: 3/3
fallback eligibility: temporary-host-unavailability
fallback reason: second verifier host was unavailable because the provider was out of credits
assurance: degraded-single-host, not full-3x2
next: continue only if project policy accepts degraded review for this story
```

### `autopilot_review_submit`

Keep this as the local host-verdict write command, but extend the process event
to persist the identity fields already accepted by the command schema:

- `sessionId`;
- `keyId`;
- `reviewWaveId`;
- `headHash` when available;
- `validationDigest` when provided;
- `promptDigest`;
- `artifactDigest`;
- `signature`;
- `signatureKeyId`;
- `signaturePayloadDigest`;
- `issuedAt`.

If a future command name is preferred, it must be a thin alias over the same
host-verdict artifact path and predicate.

### `decision_doc_quorum_check`

Keep this read-only command as decision-doc diagnostics. It may report local
decision-doc digest quorum state for operators, but it must not claim that every
direct decision-doc edit requires DONE quorum. The hard DONE gate is
`review_escalation_status` / the review escalation evaluator.

## File-Level Execution Plan

| File | Change |
| --- | --- |
| `packages/main/src/core/host-independence.ts` | New shared independence predicate and ignored-verdict reason model. |
| `packages/main/src/core/review-escalation.ts` | New trigger evaluator, quorum evaluator, report formatter, and derived artifact model. |
| `packages/main/src/core/decision-doc-quorum.ts` | Keep direct decision-doc change detection for diagnostics and migration reporting; remove direct decision-doc change as a target escalation trigger. |
| `packages/main/src/handlers/verdict.ts` | Persist `sessionId`, `keyId`, `validationDigest`, and `promptDigest` into local `host_verdict` process events. |
| `packages/main/src/core/machine.ts` | Add review-escalation DONE gate based on the first-round threshold; migrate the legacy direct decision-doc gate to the unified documentation-audit policy; keep REVIEW gate behavior unchanged except diagnostics; report degraded DONE separately from full 3x2. |
| `packages/main/src/handlers/decision-doc-quorum.ts` | Surface new ignored reasons in existing read-only diagnostics. |
| `packages/main/src/handlers/review-escalation.ts` | Add read-only status handler and explicit degraded fallback setter. |
| `packages/main/src/cli-engine.ts` | Add `review_escalation_status` schema and update `autopilot_review_submit` descriptions to require identity fields for new-policy 3x2. |
| `packages/main/src/core/command-policy.ts` | Register read-only status command and confirm host verdict writes remain reviewer evidence writes. |
| `packages/main/src/core/process-fact-registry.ts` | Register review-escalation trigger, host-verdict identity fields, quorum result, and DONE gate consumption. |
| `packages/main/src/core/process-fact-levels.ts` | Add L4 process facts for the new gate-consumed evidence. |
| `scripts/verify-process-fact-contract.mjs` | Fail if docs mention the new gate but registry/handler/gate entries are missing. |
| `packages/main/src/tasks/decision-doc-quorum-smoke.ts` | Add same-session, same-key, missing-identity, stale-material negative controls. |
| `packages/main/src/tasks/review-escalation-smoke.ts` | New smoke test for trigger and non-trigger stories. |
| `docs/requirements/decisions/story-lifecycle.md` | Update after implementation to describe threshold-triggered 3x2 or approved degraded 3x1 in DONE gate rules for both code and documentation audit. |
| `docs/requirements/decisions/lifecycle-gate-receipt-consumption.md` | Update after implementation to describe local review-escalation quorum as local workflow evidence, not Authority receipt completion. |

## Test Matrix

### Trigger Tests

| Case | Expected |
| --- | --- |
| First REVIEW round has 0 countable findings | `requires3x2=false`. |
| First REVIEW round has 1 countable finding | `requires3x2=false`. |
| First REVIEW round has 2 countable findings | `requires3x2=true`. |
| First REVIEW round has 3 countable findings | `requires3x2=true`. |
| First REVIEW round has 2 suspected findings | `requires3x2=false`. |
| First REVIEW round has 2 disproven findings | `requires3x2=false`. |
| First REVIEW round has 2 low findings | `requires3x2=false` for version 1. |
| First REVIEW round has 1 high and 1 medium verified finding | `requires3x2=true`. |
| Findings are later resolved | Escalation remains required. |
| Findings are later dismissed as invalid before TEST | Escalation evaluator reports the dismissal reason; version 1 should still preserve the trigger unless dismissal explicitly marks the original first-round finding non-countable. |

### Decision-Doc Tests

| Case | Expected |
| --- | --- |
| Direct `docs/requirements/decisions/foo.md` changed and first round has 0 countable findings | `requires3x2=false`; `decision_doc_quorum_check` is diagnostic only. |
| Nested `docs/requirements/decisions/sub/foo.md` changed | No special 3x2 trigger in version 1 unless separately configured. |
| Non-decision documentation changed and first round has 0 countable findings | `requires3x2=false`. |
| Decision doc changed and first round has 2 countable findings | `requires3x2=true` because the ordinary escalation threshold fired. |
| Escalated decision-doc audit has approved degraded 3x1 evidence | DONE may pass only with `assuranceLevel=degraded-single-host`. |

### Independence Negative Controls

| Case | Expected |
| --- | --- |
| Same `hostId`, different `sessionId` | Only one host counts. |
| Different `hostId`, same `sessionId` | Not independent. |
| Different `hostId`, same `keyId` | Not independent. |
| Different `hostId`, missing `sessionId` | Does not count for new-policy 3x2. |
| Different `hostId`, missing `keyId` or identity digest | Does not count for new-policy 3x2. |
| Different `hostId`, fabricated `keyId`, no valid payload signature | Does not count for new-policy 3x2. |
| Valid identity fields but signature payload omits material digest | Does not count for new-policy 3x2. |
| Same host submits PASS twice in one quorum round | Second verdict ignored as duplicate. |
| One PASS and one FAIL in a quorum round | Only PASS counts; round invalid if fewer than 2 independent PASS hosts remain. |
| One PASS and one BLOCKED in a quorum round | Only PASS counts; round invalid if fewer than 2 independent PASS hosts remain. |
| Verdict material digest is stale | Verdict ignored. |
| Verdict validation digest is stale after TEST | Verdict ignored. |
| Three quorum rounds exist but one round has only one independent PASS host | Gate fails. |

### Degraded Fallback Tests

| Case | Expected |
| --- | --- |
| Full 3x2 available | `quorumResult=pass-full-3x2`; degraded fallback is not used. |
| `single-host-environment` with policy approval and evidence refs | `quorumResult=pass-degraded-3x1` after 3 fresh PASS rounds from the available host and `assuranceLevel=degraded-single-host`. |
| `temporary-host-unavailability` with host-runtime evidence refs | `quorumResult=pass-degraded-3x1` after 3 fresh PASS rounds from the available host and `assuranceLevel=degraded-single-host`. |
| `explicit-human-approval` with approval ref and free-form reason | `quorumResult=pass-degraded-3x1` after 3 fresh PASS rounds from the available host and `assuranceLevel=degraded-single-host`. |
| Provider outage or rate limit is recorded but no evidence refs or approval ref exists | Gate blocks and reports missing degraded fallback evidence. |
| No second host verdict and no unavailable-host evidence | Gate blocks; missing verdict alone is not fallback eligibility. |
| Fabricated unavailable reason without a valid eligibility value and evidence refs or approval ref | Gate blocks with invalid fallback evidence. |
| Degraded 3x1 tries to set `quorumResult=pass-full-3x2` | Gate blocks or contract test fails. |
| Degraded 3x1 tries to set Authority receipt completion fields | Gate blocks and reports Authority overclaim. |

### Gate Tests

| Case | Expected |
| --- | --- |
| Escalated story reaches DONE without quorum | DONE blocks with `[review_escalation_quorum_missing]`. |
| Escalated story has 3x2 over stale material | DONE blocks with stale-material reasons. |
| Escalated story has valid 3x2 over current material | DONE gate passes this requirement. |
| Clean non-decision story without trigger | DONE does not require 3x2. |
| Decision-doc story with zero countable first-round findings | DONE does not require 3x2; direct decision-doc edits remain classification/diagnostic only unless the first REVIEW round countable reviewer problem threshold fires. |
| Escalated decision-doc story has old hostId-only 3x2 but missing session/key | New-policy gate blocks after rollout. |
| Escalated decision-doc story uses approved degraded 3x1 | DONE may pass only with `assuranceLevel=degraded-single-host`. |

## Rollout Plan

### Phase 0. Freeze Policy

Land this document and confirm the version 1 trigger:

```text
first REVIEW round countable verified critical/high/medium findings >= 2
```

Confirm documentation and decision-doc audit use the same target trigger. A
documentation file change can affect reviewer context and diagnostics, but it is
not a standalone 3x2 trigger under the target policy.

Do not add a `critical >= 1` shortcut in version 1. That can be a later policy
if product review wants it.

### Phase 1. Strengthen Host Verdict Identity

Update local host-verdict write paths so process events preserve identity and
binding fields. Add canonical payload signing and verification before any local
verdict can count toward quorum. Add tests proving these fields and signature
metadata survive `autopilot_review_submit`.

Stop condition: if host identity cannot be captured reliably, do not wire the
new DONE gate yet.

### Phase 2. Add Shared Independence Predicate

Implement the shared predicate and refactor decision-doc quorum to use it. During
the same migration, remove direct decision-doc file changes as a target
escalation trigger and retain the detector only for diagnostics, compatibility
reporting, and migration warnings.

The B-2c0c spoof reproduction must flip from pass to fail:

```text
3 rounds x 2 hostId strings
but same sessionId/keyId
=> quorum fails
```

### Phase 3. Add Review Escalation Evaluator

Add the first-round trigger evaluator and read-only status output.

Do not wire DONE yet. First, make diagnostics visible and testable.

### Phase 3b. Add Degraded Fallback Policy Evaluator

Add degraded single-host policy evaluation before DONE wiring. This evaluator
must require:

- one allowed fallback eligibility value;
- a non-empty free-form fallback reason;
- evidence refs or an approval ref for the selected eligibility;
- recent second-host unavailable evidence, single-host environment evidence, or
  explicit user-approved local mode;
- project policy or story-level user approval;
- three fresh single-host PASS rounds;
- `assuranceLevel=degraded-single-host` in every report path.

Do not allow the fallback evaluator to set full-3x2 status or Authority receipt
status.

### Phase 4. Wire DONE Gate

Add the hard DONE predicate:

```text
if requires3x2 then require valid 3x2 quorum
```

The failure reason must tell the operator whether the blocker came from:

- first-round finding threshold;
- missing quorum rounds;
- missing independent hosts;
- stale material;
- missing identity fields;
- degraded fallback eligibility, free-form reason, evidence/approval reference,
  and assurance level when fallback is used.

### Phase 5. Registry and Contract Verification

Register the new process facts and update the contract verifier so future docs,
prompts, or handlers cannot drift silently.

### Phase 6. Documentation and Migration

Update lifecycle docs after code lands.

Rollout policy:

- The implementation story must explicitly migrate existing direct decision-doc
  quorum behavior from an always-on trigger to the unified documentation-audit
  trigger.
- Active stories created before the implementation may use compatibility mode
  only if they already have legacy local host-verdict evidence.
- New stories after rollout must fail closed on missing identity fields.
- Completed DONE stories are not retroactively reopened.

## Acceptance Criteria

Implementation is complete only when all are true:

1. A clean ordinary story with no first-round findings does not require 3x2.
2. A story with exactly one countable first-round finding does not require 3x2.
3. A story with exactly two countable first-round findings requires 3x2.
4. A story with direct decision-doc or documentation changes and zero countable
   first-round findings does not require 3x2.
5. Same-session or same-key host-verdict spoofing fails.
6. Missing session/key identity fails for new-policy 3x2 evidence.
7. Missing, invalid, mismatched, or material-weak local verdict signatures fail.
8. Stale head/material/validation digest fails.
9. Three rounds with two independent PASS hosts each passes the local 3x2
   requirement.
10. When a second host is unavailable, approved degraded single-host review can
    pass only after 3 fresh PASS rounds from the available host.
11. Degraded review reports `assuranceLevel=degraded-single-host` and never
    reports `pass-full-3x2`.
12. Degraded review requires an allowed fallback eligibility value, free-form
    reason, `evidenceRefs` or `approvalRef`, fresh material binding, and
    `assuranceLevel=degraded-single-host`.
13. Fabricated unavailability, silent downgrade, and Authority overclaim all
    fail closed.
14. `decision_doc_quorum_check` and `review_escalation_status` report the same
   ignored-verdict reasons used by DONE.
15. Process fact registry and contract verification cover every new
    gate-consumed fact.
16. Documentation states clearly that local host verdict quorum is not Authority
    Server receipt completion.
17. Documentation states clearly that direct decision-doc edits are
    diagnostic/classification-only, and review escalation is triggered only by
    the first REVIEW round countable reviewer problem threshold.

## Operator Transcript

Expected status output after implementation for a triggered story:

```text
Review escalation: required
trigger: first REVIEW round countable problems 2/2
quorum: blocked
valid rounds: 1/3
round-2: missing 2 independent PASS hosts
round-3: missing 2 independent PASS hosts
materialDigest: sha256:...
next: collect 2 independent PASS host verdicts for each missing quorum round
```

Expected status output after implementation for a documentation-only audit that
does not trigger escalation:

```text
Review escalation: not required
classification: documentation-audit
trigger: none
first REVIEW round countable problems 0/2
next: continue through the normal REVIEW -> TEST -> DONE path
```

Expected DONE failure:

```text
Cannot enter DONE: review escalation requires 3x2 host quorum.
reason: first REVIEW round countable problems >= 2
materialDigest: sha256:...
valid rounds: 1/3
ignored hv-123: shared sessionId with hv-122
ignored hv-124: materialDigest mismatch
```

Expected successful DONE pre-check row:

```text
review_escalation_quorum: PASS
trigger: first-review-round-findings
rounds: 3/3
independent PASS hosts per round: 2/2
```

Expected degraded DONE pre-check row:

```text
review_escalation_quorum: PASS (degraded)
trigger: first-review-round-findings
rounds: 3/3
PASS hosts per round: 1/1
fallback eligibility: temporary-host-unavailability
fallback reason: second verifier host was unavailable because the provider was out of credits
assuranceLevel: degraded-single-host
note: degraded review is not full 3x2 and not Authority receipt completion
```

## Non-Goals

This plan does not:

- make every ordinary story always require 3x2;
- keep documentation or decision-doc changes as permanent always-on 3x2 target
  policy;
- silently downgrade full 3x2 to 3x1;
- report degraded single-host review as independent two-host review;
- change the current REVIEW blocker decay policy;
- count suspected or disproven findings as escalation triggers;
- treat local host verdicts as Authority Server receipts;
- set `authorityDone`, `fullAuthorityDone`, `receiptVerified`, or
  `productionDone`;
- require retroactive review of stories already completed before rollout;
- solve custom decision-doc directories outside direct
  `docs/requirements/decisions/*.md` files;
- implement code in B-1550.
