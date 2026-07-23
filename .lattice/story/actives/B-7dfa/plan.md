# Plan: B-7dfa Author the trusted RED-evidence subsystem decision spec (program Workstream 2)

Deliverable: a single decision document at `docs/requirements/decisions/red-evidence-subsystem-spec.md`.
No code ships this story. Each checklist item authors one section of that spec; the plan below states, per
section, the **Problem** it closes, the **Approach** (what the section must define and to what precision), and
the **Acceptance** (how a reader verifies the section is complete). All four sections live in one file, so
CHK-002..004 depend on CHK-001 having created it.

Source of truth: `.lattice/story/actives/B-7dfa/{background.md,index.json,checklist.json}` and
`docs/requirements/decisions/repro-first-gate-enforce-execution-plan.md` (Workstream 2, ~lines 22-23).
Fenced out (not in this spec): new language parsers; cryptographic receipt signing (Tier-C program);
implementation source and gate/enforcement wiring (W2 implementation + W3 stories).

---

## CHK-001: Spec section 1 — policy-owned assertion envelope + exact GREEN predicate + gate-consumption query contract

**Owner**: main-agent
**DependsOn**: none (creates the spec file)
**Files**:
- Create: docs/requirements/decisions/red-evidence-subsystem-spec.md

**Problem**
Today `red_evidence_create` (packages/main/src/handlers/proofstory.ts:948) records a self-reported
`failingCommand`/`observedFailure` with nothing binding WHAT the RED run asserted, no bound on matcher breadth,
and no proof the real target was exercised. A fabricated or vacuous RED can satisfy the gate.

**Approach** — the section must define, precisely enough to implement mechanically:
- Every assertion-envelope field with its validation rule: the bounded matcher set, the minimum-specificity
  threshold (as a policy-owned tunable lower bound, not a hard-coded constant), the expected exit class, and
  the target-exercised proof.
- The exact GREEN predicate, stated verbatim: `GREEN = exit0 AND !timeout AND pattern-absent AND target-exists`.
- The GATE-CONSUMPTION QUERY CONTRACT (W2/W3 boundary): the exact read-only question ProofStory gates ask the
  subsystem (e.g. "does a GREEN-satisfying record exist for acceptanceTargetRef X at a freshness-compatible
  head H?") and the exact answer shape returned, so W3 enforcement consumes a stable query API and never reaches
  into storage. Whether resolution is exact-head or bounded-staleness is an open point the section must resolve.
- The rejection rules that make fabrication detectable: a record without a target-exercised proof, or with an
  over-broad matcher below the minimum-specificity threshold, is REJECTED by the schema.

**Verify** (reader-checkable)
- A reader can cite each envelope field name and its validation rule verbatim from the section.
- A reader can quote the exact GREEN predicate.
- A reader can name the query contract inputs and outputs and locate the W2/W3 boundary statement.
- A reader can quote the rejection rule for a missing target-exercised proof and for a below-threshold matcher.

**DoneWhen**
- Section 1 pins all four envelope fields + the exact GREEN predicate + the gate-consumption query contract +
  the two rejection rules, each traceable to text (covers CHK-001 happy[0], happy[1], edge[0], adversarial[0]).

---

## CHK-002: Spec section 2 — runner pre/post four-tuple invariance in a disposable workspace

**Owner**: main-agent
**DependsOn**: CHK-001
**Files**:
- Modify: docs/requirements/decisions/red-evidence-subsystem-spec.md

**Problem**
Nothing today proves the RED run left the working tree untouched, so a RED command could mutate the tree (or
run against a doctored tree) with no detectable trace.

**Approach** — the section must define:
- The four measured quantities (head / material / index / status) captured PRE and POST, and the exact pass
  rule: all four identical pre and post = workspace-untouched proof.
- The disposable workspace: a plain filesystem-level temp copy/worktree, created → exercised → discarded,
  isolated from the real story tree; how isolation is established and torn down. The section must explicitly
  avoid container/overlay/root requirements and record macOS-sandbox compatibility as a constraint (pre-mortem 1).
- Edge behavior: a command that leaves a dirty index or an untracked file (post status differs) and a command
  that TIMES OUT before the post-snapshot, each with a concrete verdict.
- The rejection rule: a record whose post four-tuple != its pre four-tuple, or that omits either snapshot, is
  REJECTED.

**Verify** (reader-checkable)
- A reader can list the four fields and the comparison performed.
- A reader can confirm the isolation primitive is filesystem-level and macOS-sandbox-compatible.
- A reader can trace the dirty-index/untracked and timeout cases to explicit rules.
- A reader can quote the invariance-violation rejection rule.

**DoneWhen**
- Section 2 names the four-tuple, the disposable-workspace lifecycle, the two edge cases, and the rejection
  rule (covers CHK-002 happy[0], happy[1], edge[0], adversarial[0]).

---

## CHK-003: Spec section 3 — supersedes-chain integrity + idempotency key

**Owner**: main-agent
**DependsOn**: CHK-001
**Files**:
- Modify: docs/requirements/decisions/red-evidence-subsystem-spec.md

**Problem**
Records in `.lattice/story/actives/<id>/red-evidence.json` are append-only with no chain integrity: a record
can be silently replaced rather than superseded, replays can duplicate records, and a forked history can
present a second "latest" record.

**Approach** — the section must define:
- The supersedes-chain integrity rule: monotonic seq + prior-record digest link + fork rejection, yielding a
  single unique chain head (= latest). All three checks are required (pre-mortem 3): an adversarial fork example
  MUST be rejected.
- The idempotency key composition — every component enumerated: recordId, materialHash, specDigest,
  policy/assertion digest, freshness-compatible head — and the replay-dedup rule (identical key ⇒ no new record).
- Edge behavior: two records claiming the SAME prior digest (fork attempt) and a replay with an identical
  idempotency key, each with a concrete outcome.
- The rejection rule: a record that silently REPLACES a prior record (absent/broken prior digest, non-monotonic
  seq, or a second chain head) is REJECTED.

**Verify** (reader-checkable)
- A reader can enumerate every idempotency-key component and state the chain-head uniqueness invariant.
- A reader can trace fork-rejection and replay-dedup to explicit rules, including the adversarial fork example.
- A reader can quote the silent-replace rejection rule.

**DoneWhen**
- Section 3 pins the three-part chain-integrity rule, the full idempotency key, the fork + replay edge cases,
  and the rejection rule (covers CHK-003 happy[0], edge[0], adversarial[0]).

---

## CHK-004: Spec section 4 — quarantine/recover owner-gated operations + corrected retention + legacy-record posture

**Owner**: main-agent
**DependsOn**: CHK-001
**Files**:
- Modify: docs/requirements/decisions/red-evidence-subsystem-spec.md

**Problem**
There is no owner-gated path to retire a bad record without mutating history, and the program plan's retention
claim drifted (its `:663` citation is now `story.currentReviewRound = now` at
packages/main/src/handlers/transition-orchestrator.ts:775 after the S1/W1 merges). Existing red-evidence.json
records also need a stated status once the subsystem lands, or in-flight stories stall.

**Approach** — the section must define:
- Quarantine and recover as OWNER-GATED registered operations that create NEW record IDs linked to the original
  by `recoversRecordId`, never mutating or deleting the prior record (immutability preserved).
- The corrected retention claim: canonical receipts preserve metadata freshness within a round only; review
  rounds are per-entry via `story.currentReviewRound = now` (transition-orchestrator.ts:775), correcting the
  plan's stale `:663` citation.
- The LEGACY-RECORD POSTURE: whether existing red-evidence.json records are grandfathered, migrated, or
  invalidated, with the concrete rule/criteria. A compatibility rule must keep pre-subsystem records
  gate-satisfying until superseded and forbid silent invalidation without a stated rule (pre-mortem 4).
- Edge behavior: recovering an already-recovered record and quarantining the current chain head, each with the
  resulting record linkage and chain-head outcome.
- The rejection rule: an operation that mutates fields of, or deletes, the referenced prior record is DISALLOWED.

**Verify** (reader-checkable)
- A reader can cite the operation gating, the `recoversRecordId` linkage, and the corrected retention sentence.
- A reader can name the chosen legacy posture and its rationale/compatibility rule.
- A reader can trace the recover-of-recover and quarantine-of-head edge cases to rules.
- A reader can quote the non-destructive (immutability) rejection rule.

**DoneWhen**
- Section 4 pins owner-gated quarantine/recover with `recoversRecordId`, the corrected retention claim, the
  legacy-record posture with its compatibility rule, the two edge cases, and the immutability rejection rule
  (covers CHK-004 happy[0], happy[1], edge[0], adversarial[0]).

---

## Cross-section acceptance (whole document)

The finished spec passes when a cross-host audit confirms all four sections are present and each section's
DoneWhen is satisfied by traceable text, plus the two folded-in product-review advisories are addressed: the
gate-consumption query contract (§1, drawing the W2/W3 boundary) and the legacy-record posture (§4). The
document is the citable acceptance contract for the W2 implementation stories; no implementation code is in
scope here.
