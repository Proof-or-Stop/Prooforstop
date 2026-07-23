# Trusted RED-Evidence Subsystem — Decision Spec (Program Workstream 2)

Status: decision spec / acceptance contract for the W2 implementation stories. No runtime change is authorized by this document; it ships zero code.
Date: 2026-07-23
Story: B-7dfa (program Workstream 2 spec story)
Program: `docs/requirements/decisions/repro-first-gate-enforce-execution-plan.md` (Workstream 2, lines 22-23)

This document is the citable, section-by-section acceptance contract for the Workstream 2 implementation
stories. Every §1..§6 below is written to be **implementable-mechanically**: an implementation story should
be able to build the described behavior with zero additional design decisions. Where this spec references
today's behavior it cites real source anchors (`packages/main/src/**`, never `dist/`).

---

## §0. Scope, non-goals, and grounding

### §0.1 Problem this subsystem closes

Today a RED record is created by `red_evidence_create`
(`packages/main/src/handlers/proofstory.ts:948`), which appends a record via `appendRedEvidence`
(`packages/main/src/core/proofstory.ts:1312`) into `.lattice/story/actives/<id>/red-evidence.json`
(schema `proofstory.red_evidence.v1` = `RED_EVIDENCE_SCHEMA_VERSION`, `packages/main/src/core/proofstory.ts:78`;
record shape `RedEvidenceRecord`, `packages/main/src/core/types.ts:2617`). The gate that consumes it,
`redEvidenceRecordSatisfied` (`packages/main/src/core/proofstory.ts:870`) and `redEvidenceSatisfied`
(`packages/main/src/core/proofstory.ts:883`), only checks that a record self-reports a non-empty
`observedFailure`, a `failingCommand` or `failureReceiptHash`, an in-target `acceptanceTargetRef`, non-empty
baseline hashes, and a `greenRelation` whose `targetRef` matches. The `missing_red_evidence` diagnostic
(`packages/main/src/core/proofstory.ts:1135`) fires only when no such self-reported record exists.

Nothing today binds **what** the RED run asserted, bounds the breadth of any matcher, proves the named
acceptance target was actually exercised, proves the working tree was untouched by the run, prevents a record
from being silently replaced instead of superseded, prevents replays from duplicating records, or provides an
owner-gated path to retire a bad record without mutating history. A fabricated or vacuous RED can therefore
satisfy the gate. This subsystem replaces that surface with a machine-checkable contract.

### §0.2 In scope (defined by this spec)

- §1 A **policy-owned assertion envelope** with bounded matchers, a quantified minimum-specificity rule, an
  expected exit class, a target-exercised proof, and the exact GREEN predicate.
- §2 A **disposable-workspace runner** that captures a pre/post four-tuple and asserts workspace invariance.
- §3 A **supersedes chain** with integrity digests plus an **idempotency key** for replay dedupe.
- §4 **Owner-gated quarantine/recover** operations, corrected retention semantics, and the legacy posture link.
- §5 The **gate-consumption query contract** and the boxed W2/W3 boundary.
- §6 The normative **legacy-record posture** and the downgrade-loophole closure.

### §0.3 Out of scope (audit-accepted fences)

- **No implementation source code and no gate/enforcement wiring.** Enforcement wiring is Workstream 3.
- **No cryptographic receipt signing.** Signed cross-host receipts are the separate Tier-C program.
- **No new language parsers.** Matchers are text/exit-class predicates only; no semantic source analysis.

### §0.4 Canonical digest form (used by §1, §3, §4)

Every digest named in this spec is computed identically:

> **CANON**: serialize the value as UTF-8 JSON using RFC 8785 (JSON Canonicalization Scheme) — object keys
> recursively sorted, no insignificant whitespace, minimal number/string encoding — then take `SHA-256` and
> render as lowercase hex. A digest is written as `sha256:<64-hex>`.

A record's `recordDigest` is `CANON` over the record object **with the `recordDigest` field itself omitted**
(a digest cannot contain itself). `specDigest`, `policyDigest`, and `assertionDigest` (§3) are `CANON` over
their respective subobjects.

### §0.5 Terms

- **Acceptance target** — the `acceptanceTargetRef` a RED proof addresses: an acceptance-binding id,
  `verificationIntent` ref, milestone id, or request hash (`RedEvidenceRecord.acceptanceTargetRef`,
  `packages/main/src/core/types.ts:2621`). The set of valid targets is computed as today by `expectedRedTargets`.
- **Policy** — the policy-owned tunable bounds (matcher limits, specificity floors, timeouts). Policy is a
  config-resolved object with a `policyDigest`; its numeric bounds are lower/upper bounds, never hard-coded
  constants inside evaluators.
- **RED run** — the run that must FAIL, exhibiting the declared failure matchers at the baseline tree.
- **GREEN run** — the run that must PASS once the fix lands, satisfying the GREEN predicate (§1.5).
- **Chain head** — the unique latest record of a story's supersedes chain (§3).

---

## §1. Assertion envelope, GREEN predicate, and rejection rules

The assertion envelope is a **policy-owned** subobject embedded in every new RED record (schema
`proofstory.red_evidence.v2`, superseding v1). It binds, in machine-checkable form, exactly what the RED run
asserted and how a later GREEN run is proven to satisfy the same assertion.

### §1.1 Envelope schema (every field + its validation rule)

```json
{
  "assertion": {
    "acceptanceTargetRef": "AB-001",
    "matchers": [
      {
        "id": "M1",
        "kind": "literal",
        "value": "Cannot find module .../autopilot-resume-smoke.js",
        "stream": "combined",
        "polarity": "present-in-red"
      }
    ],
    "expectedExitClass": "nonzero",
    "targetExercisedProof": {
      "method": "artifact-presence",
      "targetArtifactRef": "packages/main/dist/tasks/autopilot-resume-smoke.js",
      "expectation": "absent-in-red-present-in-green"
    },
    "policyDigest": "sha256:...",
    "assertionDigest": "sha256:..."
  }
}
```

The four **envelope fields** and their validation rules are:

1. **`matchers`** — the *bounded matcher set*. An array of 1..`policy.maxMatchers` matcher objects. Each matcher:
   - `kind` ∈ `{ "literal", "anchored-regex", "class" }`. `anchored-regex` MUST contain at least one anchor
     (`^`, `$`, `\b`, or a `\A`/`\z` equivalent); an unanchored regex is rejected. `class` is a named,
     policy-registered character/exit class (e.g. `"nonzero-exit"`, `"stderr-nonempty"`); free-form classes
     are rejected.
   - `value` — the literal string or anchored pattern. Length in bytes MUST satisfy
     `1 ≤ len(value) ≤ policy.maxMatcherLen`.
   - `stream` ∈ `{ "stdout", "stderr", "combined" }` — which captured stream the matcher applies to.
   - `polarity` ∈ `{ "present-in-red", "absent-in-green" }`. At least one matcher MUST have
     `polarity = "present-in-red"` (otherwise the RED assertion is vacuous). Matchers with
     `polarity = "absent-in-green"` feed the `pattern-absent` sub-predicate (§1.5); by default every
     `present-in-red` matcher is also required `absent-in-green` unless explicitly exempted.
   - Every matcher MUST pass the **minimum-specificity rule** (§1.3).
2. **`expectedExitClass`** — the *expected exit class* of the RED run. An enum:
   `"nonzero"` (any non-zero exit; the default RED expectation), `"exit:<n>"` (an exact exit code), or
   `"timeout-is-failure"` (a timeout counts as the RED failure). The RED run's observed exit MUST be a member
   of this class or the record is rejected (§1.6, R1-4). The GREEN run's exit expectation is fixed at `0` by the
   GREEN predicate and is not configurable per-envelope.
3. **`targetExercisedProof`** — the *target-exercised proof*: how a run proves the named
   `acceptanceTargetRef` was actually exercised (not merely referenced in prose). Exactly one `method`:
   - `"artifact-presence"` — names a `targetArtifactRef` (a repo-relative path) and an `expectation`
     (`"present"`, `"absent-in-red-present-in-green"`, or `"absent"`). The subsystem checks the artifact's
     presence/content-hash in the disposable workspace (§2) at RED time and GREEN time. This yields the
     `target-exists` sub-predicate (§1.5).
   - `"emitted-token"` — the command MUST emit, on `stream`, a policy-registered token that embeds the
     `acceptanceTargetRef` verbatim (e.g. a test harness printing `EXERCISED:AB-001`). The run proves the
     target was exercised by emitting the token; absence of the token means the target was not exercised.
   - `"path-touch"` — the run's `failingCommand`/`expectedGreenCommand` MUST name the `targetArtifactRef`
     path, and the runner's four-tuple diff (§2) MUST show that path was read/opened by the command
     (recorded via an access log the runner captures). A command that never touches the named path fails the
     proof.
   A record whose `targetExercisedProof` is absent, or whose declared proof does not hold at run time, is
   **rejected** (§1.6, R1-1).
4. **`expectedExitClass` + `matchers` + `targetExercisedProof`** are bound together by `assertionDigest`
   (`CANON` over the `assertion` subobject minus `assertionDigest`), and the active policy bounds are bound by
   `policyDigest` (`CANON` over the resolved policy subobject). These two digests are idempotency-key components
   (§3.4) and make the envelope tamper-evident.

The *minimum-specificity threshold* (§1.3) is a **policy-owned tunable lower bound** (`policy.minMatcherLen`,
`policy.minMatcherEntropyBits`), never a constant hard-coded inside an evaluator. Implementations resolve it
from config; the numbers below are stated defaults.

### §1.2 Bounded-matcher limits (policy-owned)

| Policy key | Meaning | Stated default |
|---|---|---|
| `policy.maxMatchers` | max matcher count per envelope | 8 |
| `policy.maxMatcherLen` | max bytes per matcher `value` | 512 |
| `policy.minMatcherLen` | min effective-literal length (§1.3) | 8 |
| `policy.minMatcherEntropyBits` | min Shannon entropy of `value` | 24 |
| `policy.runTimeoutMs` | per-run wall clock ceiling (§2) | 600000 |
| `policy.forbiddenCatchAlls` | rejected catch-all patterns | `.*`, `.+`, `.`, `^$`, `^.*$`, `\s*`, `""`, single-char classes |

### §1.3 Minimum-specificity rule (quantified)

A matcher is **admissible** only if its `value` satisfies BOTH of the following, else it is rejected:

- **Not a catch-all.** `value` (after trimming) MUST NOT be a member of `policy.forbiddenCatchAlls`, MUST NOT
  match the empty string, and MUST NOT match an all-whitespace line. Any `anchored-regex` whose language
  includes the empty string or every non-empty line (e.g. `^.*$`, `^.+$`) is a forbidden catch-all.
- **Meets a specificity floor.** Compute the *effective literal* = the longest run of literal (non-metacharacter)
  bytes in `value`. The matcher is admissible iff
  `len(effectiveLiteral) ≥ policy.minMatcherLen` **OR** `shannonEntropyBits(value) ≥ policy.minMatcherEntropyBits`.
  This lets a short high-entropy token (a hash fragment) pass while forcing low-entropy patterns to carry a
  meaningful literal anchor.

### §1.4 GREEN relation (retained, tightened)

The v1 `greenRelation` (`packages/main/src/core/types.ts:2628`) is retained: `targetRef` MUST equal the
record's `acceptanceTargetRef`, and `relation` ∈ `{ same_acceptance, regression_to_green, replacement }`
(`VALID_GREEN_RELATIONS`, `packages/main/src/core/proofstory.ts:91`). The GREEN run is bound to
`greenHeadHash`/`greenMaterialHash`, which — as today (`packages/main/src/core/proofstory.ts:878-879`) — MUST
differ from the baseline head/material (a GREEN at the identical tree proves nothing).

### §1.5 The exact GREEN predicate

The GREEN verdict is defined verbatim as:

> **`GREEN = exit0 AND !timeout AND pattern-absent AND target-exists`**

where, evaluated over the GREEN run in the disposable workspace (§2):

- **`exit0`** — the GREEN run exited with status `0`.
- **`!timeout`** — the GREEN run completed within `policy.runTimeoutMs` (it did NOT time out).
- **`pattern-absent`** — NO matcher with `polarity = "absent-in-green"` (which by default includes every
  `present-in-red` matcher) matched the GREEN run's declared `stream` output.
- **`target-exists`** — the `targetExercisedProof` (§1.1.3) holds at GREEN time (the named target artifact is
  present / the token was emitted / the path was touched, per the declared `expectation`).

A record is **GREEN-satisfying** iff all four conjuncts are true; otherwise its verdict is **RED**. The
gate-consumption query (§5) returns exactly this verdict for the chain head.

### §1.6 Rejection rules (fabrication is detectable by construction)

The envelope schema REJECTS a record — it is never written — when any of the following holds:

- **R1-1 (missing target-exercised proof).** *A record whose `assertion.targetExercisedProof` is absent, or
  whose declared proof does not hold when the run executes, is REJECTED.* A RED that cannot prove it exercised
  the named acceptance target cannot satisfy the gate.
- **R1-2 (over-broad / below-threshold matcher).** *A record carrying any matcher that fails the
  minimum-specificity rule of §1.3 — a forbidden catch-all, or below both `policy.minMatcherLen` and
  `policy.minMatcherEntropyBits` — is REJECTED.* A vacuous or over-broad RED cannot satisfy the gate.
- **R1-3 (matcher bounds).** A record with `0` matchers, more than `policy.maxMatchers`, or any matcher longer
  than `policy.maxMatcherLen`, is REJECTED.
- **R1-4 (RED not exhibited).** A record whose `present-in-red` matchers did NOT all match the RED run output,
  or whose RED exit is not a member of `expectedExitClass`, is REJECTED (the asserted failure was not actually
  observed).

### §1.7 Worked examples

**VALID envelope (accepted).**

```json
{
  "acceptanceTargetRef": "AB-001",
  "matchers": [
    { "id": "M1", "kind": "literal",
      "value": "Cannot find module .../autopilot-resume-smoke.js",
      "stream": "combined", "polarity": "present-in-red" }
  ],
  "expectedExitClass": "nonzero",
  "targetExercisedProof": {
    "method": "artifact-presence",
    "targetArtifactRef": "packages/main/dist/tasks/autopilot-resume-smoke.js",
    "expectation": "absent-in-red-present-in-green"
  }
}
```

Accepted: one `present-in-red` matcher whose effective literal (`Cannot find module`) exceeds
`policy.minMatcherLen`; exit class `nonzero` matches the observed non-zero RED exit; the target-exercised
proof names a concrete artifact whose absence at RED and presence at GREEN is checkable.

**INVALID envelope (rejected).**

```json
{
  "acceptanceTargetRef": "AB-001",
  "matchers": [
    { "id": "M1", "kind": "anchored-regex", "value": "^.*$",
      "stream": "combined", "polarity": "present-in-red" }
  ],
  "expectedExitClass": "nonzero"
}
```

Rejected twice over: `^.*$` is a forbidden catch-all matching every line (R1-2, fails §1.3), and
`targetExercisedProof` is absent (R1-1). Either failure alone rejects the record.

### §1.8 Edge cases (traceable to rules)

- **Matcher matches ZERO lines in the RED output** (vacuous / under-specific pattern). Two sub-cases, each with
  a concrete result: (a) if the matcher is below the specificity floor, it is rejected at schema time by
  **R1-2** before any run. (b) if the matcher is admissible but simply did not appear in the RED run output,
  the RED assertion was not exhibited and the record is rejected by **R1-4**. In neither case is a
  zero-matching RED written.
- **Target file DELETED between the RED and GREEN runs.** The `target-exists` sub-predicate of §1.5 evaluates
  FALSE at GREEN time, so `GREEN = exit0 AND !timeout AND pattern-absent AND target-exists` is FALSE. The
  record's chain-head verdict is **RED** (not GREEN); the gate query (§5) reports verdict `RED` for the target.
  The record is not rejected as malformed — it is simply not GREEN-satisfying until the target exists again.

### §1.9 Gate-consumption query contract (summary — full contract in §5)

The subsystem exposes a single **read-only** query for gates: given `storyId` + `acceptanceTargetRef`, it
returns the latest chain-head record's status, its GREEN/RED verdict (per §1.5), and its freshness binding.
This is the W2/W3 boundary: **W2 defines and answers the query; W3 wires gates to consume the answer and makes
enforcement decisions.** The complete request/response schema, the edge-state answers, and the MUST NOT list
are pinned in §5. Freshness resolution is settled there as **bounded-staleness** (§5.3).

---

## §2. Disposable-workspace runner and four-tuple invariance

### §2.1 The four-tuple (measured PRE and POST)

Every RED run and every GREEN run is executed by a runner that captures a **four-tuple** immediately before the
command starts (PRE) and immediately after it exits (POST). The four measured quantities are:

1. **`headHash`** — `git rev-parse HEAD` in the workspace (the checked-out commit).
2. **`materialHash`** — the canonical material digest over the workspace tree (the same notion of material hash
   used today by `currentMaterialHash`, invoked at `packages/main/src/handlers/proofstory.ts:969`).
3. **`indexState`** — a digest of the git index: `CANON`/`SHA-256` over the output of `git ls-files --stage -z`
   (equivalently the `git write-tree` object id of the staged index). Captures staged mutations.
4. **`gitStatus`** — a digest over `git status --porcelain=v1 -z` (tracked modifications AND untracked files).
   Captures unstaged and untracked mutations.

The four-tuple is stored on the record as `{ pre: {headHash, materialHash, indexState, gitStatus},
post: {...same four} }`.

### §2.2 The invariance assertion (exact pass rule)

> **INVARIANCE**: a run is *workspace-untouched* iff `pre.headHash == post.headHash` AND
> `pre.materialHash == post.materialHash` AND `pre.indexState == post.indexState` AND
> `pre.gitStatus == post.gitStatus` — all four fields byte-identical PRE and POST.

If and only if all four compare equal is the run allowed to produce a record. The comparison is exact string
equality of the four digest/hash pairs.

### §2.3 Disposable-workspace lifecycle

The command executes inside a **disposable workspace**, never the real story tree:

1. **Create** — materialize a filesystem-level temporary copy of the story tree at the record's
   `baselineHeadHash`: either a `git worktree add` into an OS temp directory (e.g. under `$TMPDIR`) or a plain
   recursive filesystem copy of the tree at that commit. The workspace lives entirely under a fresh temp path
   isolated from the real story worktree.
2. **Snapshot PRE** — capture the four-tuple (§2.1).
3. **Exercise** — run the command with a wall-clock ceiling of `policy.runTimeoutMs` (§1.2). Capture
   `stdout`/`stderr`/`exitCode` and, for `path-touch` proofs, the file-access log.
4. **Snapshot POST** — capture the four-tuple again.
5. **Assert** — evaluate INVARIANCE (§2.2). Evaluate the envelope predicates (§1) and, for GREEN, the GREEN
   predicate (§1.5).
6. **Discard** — remove the temp workspace (`git worktree remove` / `rm -rf` of the temp path) unconditionally,
   including on timeout or error. The real story tree is never written to.

**Isolation constraints (pre-mortem 1).** Isolation is **filesystem-level only**. The runner MUST NOT require
containers, overlay filesystems, mount namespaces, `chroot`, or root/elevated privileges. It MUST be
**macOS-sandbox-compatible**: it operates with only ordinary temp-directory write access under the default
macOS seatbelt sandbox. This is a recorded constraint on the W2 implementation.

### §2.4 Edge cases (traceable to rules)

- **Dirty index or untracked file left by the command.** If the command stages a change (`post.indexState !=
  pre.indexState`) or leaves an untracked/modified file (`post.gitStatus != pre.gitStatus`), INVARIANCE fails.
  The run is an **invariance violation**: the record is **REJECTED and never written** (§2.5, R2-1). Because the
  workspace is disposable, the real tree is unaffected regardless.
- **Command TIMES OUT before the POST snapshot.** The command is killed at `policy.runTimeoutMs`. No valid POST
  four-tuple can be captured, so the invariance proof is absent. Concrete verdict: the record is **REJECTED**
  (missing POST snapshot, §2.5 R2-2); the disposable workspace is force-discarded (§2.3 step 6). For a GREEN
  run specifically, a timeout also makes the `!timeout` conjunct of §1.5 FALSE, so the run is not
  GREEN-satisfying — but the operative outcome is rejection for the missing invariance proof.

### §2.5 Rejection rule (tampered runner is detectable)

> **R2-1 / R2-2 (invariance-violation rejection).** *A record whose POST four-tuple is not byte-identical to
> its PRE four-tuple (R2-1), or that omits either the PRE or the POST snapshot (R2-2), is REJECTED and never
> written.*

A runner that silently mutated the tree produces `post != pre` and is rejected; a runner that skipped the
invariance proof omits a snapshot and is rejected. Neither can produce a gate-satisfying record.

---

## §3. Supersedes-chain integrity and idempotency key

### §3.1 Chain schema

`.lattice/story/actives/<id>/red-evidence.json` remains an append-only `records[]` array
(`RedEvidenceData`, `packages/main/src/core/types.ts:2639`). Under v2 every record additionally carries:

```json
{
  "id": "RED-...",
  "seq": 3,
  "priorRecordDigest": "sha256:<digest of the record this one supersedes>",
  "recordDigest": "sha256:<CANON of this record minus recordDigest>",
  "supersedes": "RED-...",
  "operation": "assert"
}
```

- **`seq`** — a monotonic integer, `1` for the first record in the chain, `prevHead.seq + 1` for each
  supersession.
- **`priorRecordDigest`** — the `recordDigest` of the record this one supersedes; `null` iff `seq == 1`.
- **`recordDigest`** — `CANON` (§0.4) over this record with `recordDigest` omitted.
- **`operation`** ∈ `{ "assert", "quarantine", "recover" }` (quarantine/recover defined in §4).

### §3.2 Chain-head uniqueness invariant

> **CHAIN-HEAD**: the *chain head* (= the latest record) is the unique record that (a) is not referenced by any
> other record's `priorRecordDigest` AND (b) has the maximal `seq`. A well-formed chain has **exactly one**
> chain head.

### §3.3 The three required integrity checks

A new appended record is admitted only if ALL THREE hold (pre-mortem 3):

1. **Monotonic seq.** `newRecord.seq == currentHead.seq + 1` (exactly; no gaps, no reuse).
2. **Prior-digest link.** `newRecord.priorRecordDigest == currentHead.recordDigest` (the link resolves to the
   current head's canonical digest).
3. **Fork rejection.** No existing record already claims `newRecord.priorRecordDigest` as ITS
   `priorRecordDigest`. If a prior digest has already been consumed by another record, the new record is a fork
   attempt and is rejected. This preserves a single chain head.

### §3.4 Idempotency key (every component enumerated)

The **idempotency key** of a candidate record is the tuple:

> **IDEMPOTENCY-KEY** = ( `recordId`, `materialHash`, `specDigest`, `policyDigest`/`assertionDigest`,
> `freshness-compatible head` )

- **`recordId`** — the candidate record's `id`.
- **`materialHash`** — the record's `baselineMaterialHash`.
- **`specDigest`** — `CANON` over the spec/target subobject (`acceptanceTargetRef` + `greenRelation`).
- **`policyDigest` / `assertionDigest`** — the two envelope digests from §1.1.4 (the active policy bounds and
  the bound assertion). Both participate; a change to either yields a different key.
- **`freshness-compatible head`** — the `baselineHeadHash` normalized into its freshness bucket per the
  bounded-staleness window of §5.3 (so two appends at the same freshness-compatible head hash the same).

### §3.5 Replay-dedup semantics

> **DEDUP**: an append whose IDEMPOTENCY-KEY equals that of an already-present record is a *replay*. The
> subsystem writes NO new record and returns the existing record (same key ⇒ same record). Dedup is decided
> before the chain-integrity checks of §3.3, so a benign retry never appears as a fork.

### §3.6 Edge cases (traceable to rules)

- **Two records claiming the SAME prior digest (fork attempt).** The first is admitted and becomes the head;
  the second violates §3.3 check 3 (fork rejection) and is **REJECTED**. The chain head remains the first
  record; there is never a second "latest".
- **Replay with an identical idempotency key.** Per §3.5 DEDUP, no new record is written and the existing
  record is returned. The chain is unchanged (`records.length` does not grow).

### §3.7 Rejection rule (silent replacement is detectable)

> **R3 (silent-replace rejection).** *A record that would silently REPLACE a prior record instead of superseding
> it — an absent or broken `priorRecordDigest` (does not resolve to the current head's `recordDigest`), a
> non-monotonic `seq` (not exactly `head.seq + 1`), or any append that would create a second chain head — is
> REJECTED.*

Because supersession requires a valid prior-digest link and a monotonic seq, an auditable append-only history
cannot be forged: every latest state is reachable by walking `priorRecordDigest` links from the unique head
back to `seq == 1`.

---

## §4. Owner-gated quarantine/recover, corrected retention, and legacy link

### §4.1 Quarantine and recover as owner-gated registered operations

Retiring or reinstating a record is done ONLY through two **owner-gated registered operations**, each of which
appends a NEW record (never edits or deletes an existing one):

- **`quarantine(storyId, recordId, reason, approvedBy)`** — appends a new record with `operation:
  "quarantine"`, `recoversRecordId: <recordId>` (the link back to the record being retired), a fresh `id`, and
  `seq`/`priorRecordDigest` continuing the chain (§3). The quarantine record becomes the new chain head with
  status `quarantined`. The prior record is untouched.
- **`recover(storyId, recordId, reason, approvedBy)`** — appends a new record with `operation: "recover"`,
  `recoversRecordId: <recordId>`, a fresh `id`, and `seq`/`priorRecordDigest` continuing the chain. The recover
  record becomes the new chain head with status `active` again.

**Owner-gated** means both operations are registered mutating handlers subject to the story ownership lease /
`approvedBy` gate (the same gate other mutating handlers use); an unauthenticated or non-owner caller cannot
invoke them. The `recoversRecordId` field is the audit link between the new record and the record it retires or
reinstates.

### §4.2 Immutability (no in-place edits, ever)

> **IMMUTABILITY**: no operation ever mutates a field of, or deletes, an already-written record. Every state
> change — assert, supersede, quarantine, recover — is a NEW appended record linked by `priorRecordDigest`
> (chain) and, for quarantine/recover, `recoversRecordId` (operation link).

### §4.3 Corrected retention claim

The program plan's retention citation drifted across the S1/W1 merges (its `:663` line moved). The corrected
claim, which this spec pins:

> **Canonical receipts preserve metadata freshness within a round only; review rounds are per-entry via the
> `story.currentReviewRound = now` assignment at `packages/main/src/handlers/transition-orchestrator.ts:775`
> (v0.3.230).**

That is: a receipt's metadata-freshness binding is scoped to a single review round, and review rounds are
assigned per-entry (a new round id is minted `= now` each time a story advances to REVIEW), not globally. RED
records therefore bind freshness within a round, and cross-round staleness is resolved by §5.3, not by any
persistent global freshness claim.

### §4.4 Legacy-record posture (decision stated here; full posture in §6)

Existing `.lattice/story/actives/<id>/red-evidence.json` records (schema `proofstory.red_evidence.v1`) predate
this subsystem. Their normative posture is: **GRANDFATHERED read-only.** A legacy record remains
gate-satisfying — answered by the query (§5) with verdict `legacy-unverified` — until it is superseded by a
v2 record; it is **never silently invalidated** and **never silently upgraded**. New records created after the
adoption point MUST use the v2 assertion envelope (§1). The rationale (avoid stranding in-flight stories),
the in-flight transition rule, and the downgrade-loophole closure are the dedicated §6.

### §4.5 Edge cases (traceable to rules)

- **Recover of an already-recovered record (recover of a recover).** `recover` on a record whose latest state
  is itself a recover record appends YET ANOTHER new record with `operation: "recover"` and
  `recoversRecordId` pointing at the prior recover record; `seq` increments and the `priorRecordDigest` chain
  continues. No record is mutated; the new recover record becomes the chain head.
- **Quarantining the current chain head.** `quarantine` on the current head appends a new head record with
  `operation: "quarantine"`, status `quarantined`, `recoversRecordId` = the retired head, and `seq =
  head.seq + 1`. The retired head is unchanged; the new chain head is the quarantine record, and the gate query
  (§5) then answers `quarantined` for that target.

### §4.6 Rejection rule (non-destructive by construction)

> **R4 (immutability rejection).** *An operation that mutates fields of, or deletes, the referenced prior record
> is DISALLOWED. Only new, linked records may be created.*

An owner cannot use quarantine/recover to erase inconvenient RED history: the retired record persists verbatim
and remains reachable by walking the chain. And — reinforcing §6 — the legacy posture cannot silently
invalidate the records of an in-flight story mid-program: invalidation of a legacy record requires an explicit
superseding v2 record (an auditable append), never a silent status flip.

---

## §5. Gate-consumption query contract (the W2/W3 boundary)

### §5.1 The single read-only query

W2 exposes exactly ONE read-only query for gates. Name: **`redEvidenceGateQuery`**.

**Request:**

```json
{ "storyId": "B-xxxx", "acceptanceTargetRef": "AB-001" }
```

- `storyId` — the story whose red-evidence chain is queried.
- `acceptanceTargetRef` — the acceptance target the gate is asking about.

**Response:**

```json
{
  "storyId": "B-xxxx",
  "acceptanceTargetRef": "AB-001",
  "chainHeadRecordId": "RED-...",
  "status": "active",
  "verdict": "GREEN",
  "freshness": {
    "boundHead": "sha1:...",
    "boundMaterial": "sha256:...",
    "mode": "bounded-staleness",
    "liveMatch": true
  }
}
```

- **`status`** ∈ `{ "none", "active", "quarantined", "superseded" }` — the state of the latest chain-head
  record for that target.
- **`verdict`** ∈ `{ "GREEN", "RED", "legacy-unverified", "indeterminate" }` — the GREEN/RED verdict per §1.5
  (`legacy-unverified` per §6; `indeterminate` for a freshness-mismatched head, §5.4).
- **`freshness`** — the head's `boundHead`/`boundMaterial`, the resolution `mode` (§5.3), and `liveMatch`
  (whether the binding still matches the live tree).

The query is **read-only**: it computes the answer from stored records and the live tree; it writes nothing.

### §5.2 Answer determinacy

For any `(storyId, acceptanceTargetRef)` the query returns exactly ONE answer. A W3 implementer wires the gate
from this section alone with **zero design decisions**: the gate calls `redEvidenceGateQuery`, reads
`status`/`verdict`/`freshness`, and maps them to an enforcement decision (which mapping is W3's, §5.5).

### §5.3 Freshness resolution (open point resolved)

Freshness resolution is **bounded-staleness**, not exact-head. A chain head satisfies freshness for a live tree
iff its `boundHead` is an ancestor of (or equal to) the live `HEAD` AND the live `materialHash` for the target's
material set is unchanged from `boundMaterial` (no material drift affecting the target). The staleness window is
the current review round (§4.3): a head bound in the current `story.currentReviewRound` is freshness-compatible;
a head from a prior round with unchanged material is still compatible, but material drift sets `liveMatch:
false`. This resolves the §1 open point: gates consume a stable answer without re-deriving classification.

### §5.4 Edge-state answers (exactly one answer each)

| Edge state | `status` | `verdict` | Notes |
|---|---|---|---|
| **No records** for the target | `none` | `RED` | `chainHeadRecordId: null`; nothing satisfies the gate. |
| **Quarantined head** | `quarantined` | `RED` | A quarantined head never satisfies the gate. |
| **Superseded-but-unreplaced head** | `superseded` | `RED` | Head is a supersede/quarantine marker with no active replacement record; not satisfying. |
| **Freshness-mismatched head** | `active` | `indeterminate` | `freshness.liveMatch: false`; the bound head/material no longer matches the live tree, so GREEN/RED cannot be asserted at the live tree. |

### §5.5 W2/W3 boundary (boxed, with MUST NOT list)

> **╔══════════════════ W2/W3 BOUNDARY ══════════════════╗**
>
> **W2 (this subsystem) exposes ONLY the read-only `redEvidenceGateQuery`. It returns FACTS
> (status + verdict + freshness) and makes NO enforcement decision.**
>
> **MUST NOT (scope fence):**
> - A gate MUST NOT write through the query (it is read-only; there is no write path in this contract).
> - A gate MUST NOT reach into `red-evidence.json` storage directly; it consumes only the query answer.
> - The query MUST NOT return a block/allow/pass/fail enforcement decision — only status, verdict, freshness.
> - Mapping the answer to an enforcement outcome (block DEV→REVIEW, warn, allow-with-bypass, per-story-age
>   legacy handling) is **W3's** responsibility and MUST live in W3's enforcement wiring, not here.
> - No new query surface, mutation, or side effect may be added to W2 to satisfy an enforcement need; such
>   needs are resolved in W3.
>
> **╚═════════════════════════════════════════════════════╝**

---

## §6. Legacy record posture

### §6.1 The one normative decision

> **POSTURE (verbatim, citable):** Records written before the subsystem's **adoption point** (schema
> `proofstory.red_evidence.v1`, `packages/main/src/core/proofstory.ts:78`) are **GRANDFATHERED, read-only**.
> The gate query (§5) answers them with verdict **`legacy-unverified`**. They are **never silently upgraded**
> to the v2 envelope and **never silently invalidated**. Every record created **after** the adoption point MUST
> carry the v2 assertion envelope (§1); a v1-schema record appended after the adoption point is rejected.

**Rationale.** Grandfathering (rather than migrating or invalidating) is the only posture that does not strand
in-flight stories: migration would require re-running RED assertions that may no longer be reproducible, and
invalidation would break stories whose only sin is predating the subsystem. `legacy-unverified` is a distinct
verdict (not `GREEN`, not `RED`) precisely so that W3's enforce policy can map it per story age without W2
pre-deciding the enforcement outcome.

### §6.2 Adoption point

The **adoption point** is a pinned marker recorded in config/subsystem metadata: a `{ adoptionCommit,
adoptionTimestamp }` pair fixed when the subsystem lands. A record is **legacy** iff its `createdAt` is strictly
before `adoptionTimestamp` AND its `schemaVersion` is `proofstory.red_evidence.v1`. Legacy status is a function
of *record creation time relative to the adoption point*, not of any field the author can set.

### §6.3 In-flight transition rule (deterministic)

A story mid-lifecycle at the enforce flip whose latest chain-head record is legacy:

- The gate query (§5) answers `status: active`, `verdict: legacy-unverified` for that target.
- W3's enforce policy maps `legacy-unverified` **per story age**: a story whose record predates the adoption
  point is grandfathered (the legacy record satisfies the gate); a story that adds NEW material after the
  adoption point must supply a v2 record for the newly-covered target.
- **Owner action:** none is required for a purely legacy, pre-adoption story. The owner must create a v2
  envelope record only when adding post-adoption material to a target (at which point §1 applies normally).

### §6.4 Downgrade-loophole closure

> **LOOPHOLE-CLOSURE:** legacy status is bound to record **creation time** relative to the adoption point and
> verified by the subsystem at **append time**. A record whose append time is at or after `adoptionTimestamp`
> is treated as **post-adoption regardless of any declared `schemaVersion` or `createdAt`**, and MUST carry a
> v2 envelope; a v1-schema record presented after adoption is REJECTED.

A post-adoption record can therefore **never** claim legacy treatment: a new record cannot be created "as
legacy" to escape the envelope rules, because (a) the subsystem stamps append time and rejects any v1-schema
append after adoption, and (b) IMMUTABILITY (§4.2) forbids deleting and recreating an existing record. The two
together close the downgrade path: neither back-dating a new record nor deleting-and-recreating an old one can
smuggle post-adoption work past §1.

---

## §7. Cross-section acceptance (whole document)

The spec is complete when a cross-host audit confirms all of §1..§6 are present and each section's rules are
traceable to text, and the two folded-in product-review advisories are addressed: the gate-consumption query
contract drawing the W2/W3 boundary (§5, summarized in §1.9) and the legacy-record posture (§6, decision
restated in §4.4). This document is the citable acceptance contract for the W2 implementation stories; no
implementation code is in scope here.
