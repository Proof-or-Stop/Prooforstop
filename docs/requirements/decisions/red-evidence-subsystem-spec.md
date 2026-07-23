# Trusted RED-Evidence Subsystem — Decision Spec (Program Workstream 2)

Status: decision spec / acceptance contract for the W2 implementation stories. No runtime change is authorized by this document; it ships zero code.
Date: 2026-07-23 (rev 2 — post cross-host audit round 1: codex 22 findings, agy 9 findings, both `AUDIT: reject`; every finding dispositioned in this revision)
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
baseline hashes, a `greenRelation` whose `targetRef` matches the record's `acceptanceTargetRef` with a valid
`relation`, **at least one GREEN-related field** (`expectedGreenCommand`, `greenRelation.command`,
`greenRelation.greenHeadHash`, or `greenRelation.greenMaterialHash`; `packages/main/src/core/proofstory.ts:877`),
and — when GREEN hashes are supplied — that they differ from the baseline hashes
(`packages/main/src/core/proofstory.ts:878-879`). The `missing_red_evidence` diagnostic
(`packages/main/src/core/proofstory.ts:1135`) fires only when no such self-reported record exists.

Nothing today binds **what** the RED run asserted, bounds the breadth of any matcher, proves the named
acceptance target was actually exercised, proves the working tree was untouched by the run, prevents a record
from being silently replaced instead of superseded, prevents replays from duplicating records, or provides an
owner-gated path to retire a bad record without mutating history. A fabricated or vacuous RED can therefore
satisfy the gate. This subsystem replaces that surface with a machine-checkable contract.

### §0.2 In scope (defined by this spec)

- §1 A **policy-owned assertion envelope** with bounded matchers, a quantified minimum-specificity rule, an
  expected exit class, a target-exercised proof, and the exact GREEN predicate.
- §2 A **disposable-workspace runner** that captures a pre/post four-tuple and asserts net-state invariance.
- §3 A **supersedes chain** (per acceptance target) with integrity digests plus an **idempotency key**.
- §4 **Owner-gated quarantine/recover** operations, corrected retention semantics, and the legacy posture link.
- §5 The **gate-consumption query contract** (total algorithm + tagged errors) and the boxed W2/W3 boundary.
- §6 The normative **legacy-record posture** (adoption-time migration manifest) and the loophole closure.

### §0.3 Out of scope (audit-accepted fences)

- **No implementation source code and no gate/enforcement wiring.** Enforcement wiring is Workstream 3.
- **No cryptographic receipt signing.** Signed cross-host receipts are the separate Tier-C program.
- **No new language parsers.** Matchers are text/exit-class predicates only; no semantic source analysis.

### §0.4 Canonical digest form (used by §1, §3, §4, §6)

Every digest named in this spec is computed identically:

> **CANON**: serialize the value as UTF-8 JSON using RFC 8785 (JSON Canonicalization Scheme) — object keys
> recursively sorted, no insignificant whitespace, minimal number/string encoding — then take `SHA-256` and
> render as lowercase hex. A digest is written as `sha256:<64-hex>`.

Nullability rules for canonicalization (audit: divergent nullability would fork digests across hosts):

- Chain fields `seq`, `priorRecordDigest`, and `supersedes` are ALWAYS PRESENT on a v2 record.
  `priorRecordDigest` and `supersedes` carry JSON `null` (not `""`, not omitted) on a chain-founding record
  (`seq == 1`).
- Every OTHER optional field is OMITTED entirely when absent — never written as `null` or `""`.
- A record's `recordDigest` is `CANON` over the record object **with the `recordDigest` field itself omitted**
  (a digest cannot contain itself). `specDigest`, `policyDigest`, and `assertionDigest` are `CANON` over the
  exact subobjects defined in §1.10.

### §0.5 Terms

- **Acceptance target** — the `acceptanceTargetRef` a RED proof addresses: an acceptance-binding id,
  `verificationIntent` ref, milestone id, or request hash (`RedEvidenceRecord.acceptanceTargetRef`,
  `packages/main/src/core/types.ts:2621`). The set of valid targets is computed as today by `expectedRedTargets`.
- **Policy** — the policy-owned tunable bounds (matcher limits, specificity floors, timeouts, adapters,
  exclusion sets). The complete resolved policy is embedded in every record as `policySnapshot` (§1.10) with
  `policyDigest = CANON(policySnapshot)`. Bounds are tunables, never hard-coded constants inside evaluators.
- **RED run** — the run that must FAIL, exhibiting the declared failure matchers at the baseline tree.
- **GREEN run** — the run that must PASS once the fix lands, satisfying the GREEN predicate (§1.5).
- **Target chain / chain head** — the per-`(storyId, acceptanceTargetRef)` supersedes chain and its unique
  latest record (§3).
- **Run receipt** — the runner-produced attestation of one execution: derived command, streams, exit,
  four-tuple, nonce (§1.1.3, §2.3).

### §0.6 Threat model and tamper-resistance scope (what this subsystem does and does not resist)

W2's integrity guarantees are **handler-enforced append consistency**: every guarantee in this spec holds for
records created, superseded, quarantined, or recovered THROUGH the registered CLI surfaces. The attacker this
subsystem resists is an agent (or careless owner) operating **through those surfaces**: it cannot fabricate a
satisfying RED without a real failing run (§1, §2), cannot silently replace history (§3), cannot erase records
(§4), and cannot smuggle a post-adoption record in as legacy (§6).

W2 does **NOT** resist an attacker with direct write access to `.lattice/story/actives/<id>/red-evidence.json`
who rewrites the file and recomputes every digest offline. Hash chaining without an external trust anchor
detects accidental corruption and casual tampering, not a full offline rewrite. The partial mitigations W2 does
get for free are: (a) the story metadata directory is git-tracked, so offline rewrites appear in `git diff` /
history; (b) the legacy migration manifest is anchored to a commit (§6.2), so legacy membership cannot be
forged after adoption; (c) the gate query surfaces `corrupt-chain` / `fork-detected` errors (§5.6) on any
internally-inconsistent rewrite. **Full offline-rewrite resistance requires cryptographic receipt signing,
which is explicitly fenced to the Tier-C program (§0.3)** — implementation stories MUST NOT claim
tamper-proof storage on W2's behalf.

---

## §1. Assertion envelope, GREEN predicate, and rejection rules

The assertion envelope is a **policy-owned** subobject embedded in every new RED record (schema
`proofstory.red_evidence.v2`, superseding v1; complete record schema in §1.10). It binds, in machine-checkable
form, exactly what the RED run asserted and how a later GREEN run is proven to satisfy the same assertion.

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
      "method": "harness-token",
      "testCaseRef": "npm-script:test:autopilot-resume-smoke",
      "adapterId": "npm-script@1",
      "supplementaryArtifact": {
        "targetArtifactRef": "packages/main/dist/tasks/autopilot-resume-smoke.js",
        "expectation": "absent-in-red-present-in-green"
      }
    },
    "policyDigest": "sha256:...",
    "assertionDigest": "sha256:..."
  }
}
```

The four **envelope fields** and their validation rules are:

1. **`matchers`** — the *bounded matcher set*. An array of 1..`policy.maxMatchers` matcher objects. Each matcher:
   - `id` — unique within the envelope (duplicate ids reject).
   - `kind` ∈ `{ "literal", "anchored-regex", "class" }`. An `anchored-regex` MUST begin with `^` and end with
     `$` (both line anchors required; `\b` is NOT an accepted anchor). `class` is a named, policy-registered
     class from `policy.matcherClassRegistry` (§1.2); free-form classes are rejected.
   - `value` — the literal string or anchored pattern. Length in bytes MUST satisfy
     `1 ≤ len(value) ≤ policy.maxMatcherLen`.
   - `stream` ∈ `{ "stdout", "stderr", "combined" }` — which captured stream the matcher applies to.
   - `polarity` ∈ `{ "present-in-red", "absent-in-green", "present-in-green" }`. At least one matcher MUST have
     `polarity = "present-in-red"` (otherwise the RED assertion is vacuous). Every `present-in-red` matcher is
     also implicitly required `absent-in-green` unless it carries `"greenExempt": true`. `present-in-green`
     matchers feed the `pattern-present` conjunct (§1.5).
   - Every matcher MUST pass the **minimum-specificity rule** (§1.3) under the **evaluation semantics** of §1.11.
2. **`expectedExitClass`** — the *expected exit class* of the RED run. An enum:
   `"nonzero"` (any non-zero exit; the default RED expectation), `"exit:<n>"` (an exact exit code, `0 < n ≤ 255`),
   or `"timeout-is-failure"` (a timeout counts as the RED failure; runner protocol in §2.3 step 3b). The RED
   run's observed exit MUST be a member of this class or the record is rejected (§1.6, R1-4). The GREEN run's
   exit expectation is fixed at `0` by the GREEN predicate and is not configurable per-envelope.
3. **`targetExercisedProof`** — the *target-exercised proof*: how a run proves the named `acceptanceTargetRef`
   was actually exercised (not merely referenced in prose). ONE method, `"harness-token"`, with an optional
   supplementary check (audit note: the rev-1 `artifact-presence`-standalone and `path-touch` methods are
   REMOVED — presence of a file proves nothing about execution, and unprivileged macOS file-access tracing is
   unimplementable):
   - **`"harness-token"` (the required method).** The assertion names a `testCaseRef` (a registered test-case
     reference, e.g. `npm-script:<name>` or `node-test:<file>#<test-name>`) and an `adapterId` from
     `policy.runnerAdapterRegistry`. The RUNNER — never the caller — derives the argv from the adapter's
     template (§2.3 step 0); caller-supplied free shell text is never executed. At run time the runner
     generates a fresh random 128-bit hex **nonce**, exports it to the command's environment as
     `LATTICE_RED_RUN_NONCE`, and requires the run to emit, on the matcher-visible streams, the exact token
     `EXERCISED:<acceptanceTargetRef>:<nonce>`. Because the nonce is unknown before the run and injected only
     into that process's environment, pre-fabricated output cannot contain it; because the command itself is
     adapter-derived (registered argv, not caller shell), a bare `echo` cannot be substituted for the real
     test invocation. The run receipt (§2.3) binds `adapterId`, resolved argv, cwd, environment projection,
     and the nonce. Token emission is checked at RED time and at GREEN time; it yields the `target-exists`
     sub-predicate (§1.5).
   - **`supplementaryArtifact` (optional, never standalone).** Names a repo-relative `targetArtifactRef` and an
     `expectation` ∈ `{ "present", "absent-in-red-present-in-green", "absent" }`, checked against the
     disposable workspace at RED and GREEN time. It strengthens `target-exists` (both harness token AND
     artifact expectation must hold when declared) but can never substitute for the harness token.
   A record whose `targetExercisedProof` is absent, or whose harness token was not emitted with the correct
   nonce during the run, is **rejected** (§1.6, R1-1).
4. **`policyDigest` + `assertionDigest`** — `policyDigest = CANON(policySnapshot)` (the complete resolved
   policy embedded in the record, §1.10 — so any later evaluator can recompute it without config archaeology).
   `assertionDigest = CANON` over the `assertion` subobject **including `policyDigest` but excluding
   `assertionDigest` itself** (stated explicitly: the assertion digest COVERS the policy digest). These digests
   are idempotency-key components (§3.4) and make the envelope tamper-evident under §0.6's threat model.

The *minimum-specificity threshold* (§1.3) is a **policy-owned tunable lower bound** (`policy.minMatcherLen`,
`policy.minMatcherEntropyBits`), never a constant hard-coded inside an evaluator. Implementations resolve it
from config; the numbers below are stated defaults.

### §1.2 Bounded-matcher limits and registries (policy-owned)

| Policy key | Meaning | Stated default |
|---|---|---|
| `policy.maxMatchers` | max matcher count per envelope | 8 |
| `policy.maxMatcherLen` | max bytes per matcher `value` | 512 |
| `policy.minMatcherLen` | min effective-literal length (§1.3) | 8 |
| `policy.minMatcherEntropyBits` | min total Shannon entropy of `value` (§1.3 formula) | 24 |
| `policy.runTimeoutMs` | per-run wall clock ceiling (§2) | 600000 |
| `policy.killGraceMs` | SIGTERM→SIGKILL grace on timeout (§2.3) | 5000 |
| `policy.forbiddenCatchAlls` | rejected catch-all patterns (blocklist layer of §1.3) | `.*`, `.+`, `.`, `^$`, `^.*$`, `^.+$`, `\s*`, `""` |
| `policy.invarianceExcludePaths` | globs excluded from the `gitStatus` digest (§2.1) | `node_modules/**`, `**/.cache/**`, `**/*.tsbuildinfo`, `**/__pycache__/**`, `**/.pytest_cache/**`, `coverage/**`, `tmp/**`, `**/.DS_Store` |
| `policy.matcherClassRegistry` | named classes: `{ name, predicateKind, param }`, `predicateKind` ∈ `{exit-code-in, stream-nonempty, stream-empty}` | `nonzero-exit`, `stderr-nonempty` |
| `policy.runnerAdapterRegistry` | adapters: `{ adapterId, testCaseRefPattern, argvTemplate, allowedEnvKeys, cwd }` | `npm-script@1`, `node-test@1` |

### §1.3 Minimum-specificity rule (quantified)

A matcher of kind `literal` or `anchored-regex` is **admissible** only if ALL of the following hold, else it is
rejected (audit: the rev-1 entropy-OR-literal disjunction admitted high-entropy-but-generic regexes; it is now
a conjunction, and structural wildcard bridges are banned):

1. **Not a catch-all (blocklist layer).** `value` (after trimming) MUST NOT be a member of
   `policy.forbiddenCatchAlls`.
2. **Not a catch-all (structural layer).** For `anchored-regex`: the compiled pattern MUST NOT match the empty
   string (mechanical check: `regex.test('')` MUST be `false`), MUST NOT match a single-space string
   (`regex.test(' ')` MUST be `false`), and the pattern MUST NOT begin with `^.*`/`^.+` nor end with
   `.*$`/`.+$` (unbounded wildcard bridges at either line boundary are rejected by token inspection of the
   pattern source).
3. **Literal floor AND entropy floor (conjunction).** Compute the *effective literal* per §1.11.4. The matcher
   is admissible iff `len(effectiveLiteral) ≥ policy.minMatcherLen` **AND**
   `entropyBits(value) ≥ policy.minMatcherEntropyBits`, with `entropyBits` as defined in §1.11.5.

`class` matchers are exempt from rule 3 (their breadth is bounded by the policy registry itself) but the
registry MUST only contain classes from the closed `predicateKind` enum of §1.2.

### §1.4 GREEN relation and GREEN binding rule (retained, tightened)

The v1 `greenRelation` (`packages/main/src/core/types.ts:2628`) is retained: `targetRef` MUST equal the
record's `acceptanceTargetRef`, and `relation` ∈ `{ same_acceptance, regression_to_green, replacement }`
(`VALID_GREEN_RELATIONS`, `packages/main/src/core/proofstory.ts:91`).

The binding rule is strengthened over v1's optional-field check (`packages/main/src/core/proofstory.ts:878-879`):
a `green-confirm` record (§3.1) MUST carry **BOTH** `greenHeadHash` **AND** `greenMaterialHash`, and both are
taken from the GREEN run's own receipt (runner-measured, §2.3), never caller-supplied. The exact rule:

> **GREEN-BIND**: `greenHeadHash` MUST be a strict descendant of the bound RED record's `baselineHeadHash`
> (mechanically: `git merge-base --is-ancestor <baselineHeadHash> <greenHeadHash>` succeeds and the hashes
> differ), AND `greenMaterialHash` MUST differ from `baselineMaterialHash` (the fix changed material). A
> green-confirm violating either clause is rejected.

### §1.5 The exact GREEN predicate

The program-mandate GREEN predicate is, verbatim:

> **`GREEN = exit0 AND !timeout AND pattern-absent AND target-exists`**

This spec extends it with one conjunct (audit: a GREEN run that exits 0 silently, emitting nothing, must not
pass when the envelope demanded positive evidence). The **full evaluated predicate** is:

> **`GREEN_v2 = exit0 AND !timeout AND pattern-absent AND pattern-present AND target-exists`**

`pattern-present` is **vacuously TRUE when the envelope declares no `present-in-green` matchers**, so
`GREEN_v2` reduces exactly to the mandate predicate in the base case. The conjuncts, evaluated over the GREEN
run in the disposable workspace (§2):

- **`exit0`** — the GREEN run exited with status `0`.
- **`!timeout`** — the GREEN run completed within `policy.runTimeoutMs` (it did NOT time out).
- **`pattern-absent`** — NO matcher with effective green-absence polarity (every `absent-in-green` matcher,
  plus every `present-in-red` matcher not marked `greenExempt`) matched the GREEN run's declared `stream`
  output (per §1.11 semantics).
- **`pattern-present`** — EVERY `present-in-green` matcher matched the GREEN run's declared `stream` output
  (vacuously true when none are declared).
- **`target-exists`** — the `targetExercisedProof` (§1.1.3) holds at GREEN time: the harness token
  `EXERCISED:<targetRef>:<nonce>` (with the GREEN run's own nonce) was emitted, and any declared
  `supplementaryArtifact` expectation holds. Note this also closes the silent-GREEN hole even without
  `present-in-green` matchers: an empty-output GREEN run cannot have emitted the token.

A target is **GREEN-satisfying** iff its chain head is a `green-confirm` record (§3.1) whose receipt satisfies
all conjuncts; otherwise the verdict is **RED**. The gate-consumption query (§5) returns exactly this verdict.

### §1.6 Rejection rules (fabrication is detectable by construction)

The envelope schema REJECTS a record — it is never written — when any of the following holds:

- **R1-1 (missing target-exercised proof).** *A record whose `assertion.targetExercisedProof` is absent, or
  whose run did not emit the nonce-bound harness token `EXERCISED:<targetRef>:<nonce>` on a matcher-visible
  stream, is REJECTED.* A RED that cannot prove it exercised the named acceptance target cannot satisfy the
  gate.
- **R1-2 (over-broad / below-threshold matcher).** *A record carrying any matcher that fails the
  minimum-specificity rule of §1.3 — a blocklisted or structurally catch-all pattern, or one failing the
  literal-AND-entropy floor — is REJECTED.* A vacuous or over-broad RED cannot satisfy the gate.
- **R1-3 (matcher bounds).** A record with `0` matchers, more than `policy.maxMatchers`, any matcher longer
  than `policy.maxMatcherLen`, a duplicate matcher `id`, or an `anchored-regex` that fails to compile under
  §1.11.1, is REJECTED.
- **R1-4 (RED not exhibited).** A record whose `present-in-red` matchers did NOT all match the RED run output,
  or whose RED exit is not a member of `expectedExitClass`, is REJECTED (the asserted failure was not actually
  observed).
- **R1-5 (non-derived command).** A record whose run receipt shows argv not derived from the declared
  `adapterId`'s registered template for the declared `testCaseRef`, or an `adapterId` absent from
  `policy.runnerAdapterRegistry`, is REJECTED. (Closes the `sh -c 'echo ...; exit 7'` fabrication class: the
  caller cannot choose the executable.)

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
    "method": "harness-token",
    "testCaseRef": "npm-script:test:autopilot-resume-smoke",
    "adapterId": "npm-script@1",
    "supplementaryArtifact": {
      "targetArtifactRef": "packages/main/dist/tasks/autopilot-resume-smoke.js",
      "expectation": "absent-in-red-present-in-green"
    }
  }
}
```

Accepted: one `present-in-red` matcher whose effective literal (the full 48-byte value) exceeds
`policy.minMatcherLen` and whose entropy exceeds the floor; exit class `nonzero`; the proof names a registered
adapter + test-case ref, so the runner derives `npm run test:autopilot-resume-smoke` itself and requires the
nonce token in its output; the supplementary artifact strengthens the proof.

**INVALID envelope (rejected).**

```json
{
  "acceptanceTargetRef": "AB-001",
  "matchers": [
    { "id": "M1", "kind": "anchored-regex", "value": "^.*failure.*$",
      "stream": "combined", "polarity": "present-in-red" }
  ],
  "expectedExitClass": "nonzero"
}
```

Rejected three times over: the pattern begins `^.*` and ends `.*$` (structural catch-all, §1.3.2 → R1-2); its
effective literal `failure` is 7 bytes < `policy.minMatcherLen` default 8 (R1-2); and `targetExercisedProof`
is absent (R1-1). Any one failure alone rejects the record.

### §1.8 Edge cases (traceable to rules)

- **Matcher matches ZERO lines in the RED output** (vacuous / under-specific pattern). Two sub-cases, each with
  a concrete result: (a) if the matcher fails §1.3, it is rejected at schema time by **R1-2** before any run.
  (b) if the matcher is admissible but simply did not appear in the RED run output, the RED assertion was not
  exhibited and the record is rejected by **R1-4**. In neither case is a zero-matching RED written.
- **Target file DELETED between the RED and GREEN runs** (declared `supplementaryArtifact` with expectation
  `present`, or harness token no longer emitted because the test was deleted). The `target-exists` conjunct
  of §1.5 evaluates FALSE at GREEN time, so no green-confirm can be appended (its receipt fails the
  predicate); the chain head remains the `red-assert` record and the gate query (§5) reports verdict **RED**
  for the target. The existing red-assert record is not rejected retroactively — it is simply never
  GREEN-confirmed until the target is exercised again.

### §1.9 Gate-consumption query contract (summary — full contract in §5)

The subsystem exposes a single **read-only** query for gates: given `storyId` + `acceptanceTargetRef`, it
returns the latest target-chain-head record's status, its GREEN/RED verdict (per §1.5), and its freshness
binding. This is the W2/W3 boundary: **W2 defines and answers the query; W3 wires gates to consume the answer
and makes every enforcement decision.** The complete request/response schema, the total algorithm with tagged
errors, the edge-state answers, and the MUST NOT list are pinned in §5. Freshness resolution is settled there
as a deterministic bounded-staleness algorithm (§5.3).

### §1.10 Complete top-level v2 record schema (normative)

The full `RedEvidenceRecordV2` shape — field placement for every v1 field, the envelope, chain fields, and
receipts (audit: rev 1 never unified these; implementers had to guess):

```json
{
  "id": "RED-a3f2b8c91d04-1",
  "schemaVersion": "proofstory.red_evidence.v2",
  "operation": "red-assert",
  "seq": 1,
  "priorRecordDigest": null,
  "supersedes": null,
  "storyId": "B-xxxx",
  "acceptanceTargetRef": "AB-001",
  "trigger": "<why RED evidence is required — human-readable, non-normative>",
  "observedFailure": "<human-readable failure description, non-normative>",
  "baselineHeadHash": "<git sha1/sha256 hex — runner-measured, §2.3>",
  "baselineMaterialHash": "<sha256 hex — runner-measured, §2.3>",
  "greenRelation": { "targetRef": "AB-001", "relation": "same_acceptance" },
  "assertion": { "«§1.1 envelope, including policyDigest & assertionDigest»": "..." },
  "policySnapshot": { "«complete resolved policy object of §1.2»": "..." },
  "specDigest": "sha256:...",
  "runReceipt": {
    "adapterId": "npm-script@1",
    "testCaseRef": "npm-script:test:autopilot-resume-smoke",
    "argv": ["npm", "run", "test:autopilot-resume-smoke"],
    "cwd": ".",
    "envProjection": { "LATTICE_RED_RUN_NONCE": "<nonce hex>" },
    "runnerProfileId": "node-npm@1",
    "runnerProfileDigest": "sha256:...",
    "exitCode": 1,
    "timedOut": false,
    "stdoutDigest": "sha256:...",
    "stderrDigest": "sha256:...",
    "tokenObserved": true,
    "pre":  { "headHash": "...", "materialHash": "...", "indexState": "...", "gitStatus": "..." },
    "post": { "headHash": "...", "materialHash": "...", "indexState": "...", "gitStatus": "..." }
  },
  "note": "<optional>",
  "createdAt": "<ISO-8601>",
  "recordDigest": "sha256:..."
}
```

Type-specific additions:

- `operation: "green-confirm"` records ADD: `confirmsRecordId` (the red-assert record id),
  `confirmsRecordDigest` (its `recordDigest`), `confirmsAssertionDigest` (MUST equal the red-assert's
  `assertionDigest` — a green-confirm can only confirm the SAME assertion), `greenHeadHash`,
  `greenMaterialHash` (both runner-measured; GREEN-BIND rule §1.4). Their `runReceipt` is the GREEN run's.
- `operation: "quarantine"` / `"recover"` records ADD: `recoversRecordId`, `linkKind`
  (`"quarantines"` | `"recovers"`), `reason`, `approvedBy` (§4.1); they carry NO `assertion`/`runReceipt`
  (they are chain-control records, not run attestations — verdict derivation in §5.4 accounts for this).

**`specDigest`** is defined exactly as
`CANON({ "acceptanceTargetRef": <record.acceptanceTargetRef>, "greenRelation": { "targetRef": <...>, "relation": <...> } })` —
those keys, that nesting, nothing else.

### §1.11 Matcher evaluation semantics (pinned — zero design decisions)

1. **Regex dialect**: ECMAScript regular expressions as implemented by Node.js ≥ 20 (`new RegExp(value, "u")`).
   Flags: exactly `u` (unicode). No `m` (matchers are evaluated per line, so `^`/`$` bind to the evaluated
   line), no `i`, no `s`. A pattern that throws `SyntaxError` at compile is rejected (R1-3).
2. **Byte/unicode treatment**: captured stream bytes are decoded as UTF-8 with invalid sequences replaced by
   U+FFFD. NO unicode normalization (no NFC/NFD) is applied — matching is byte-faithful post-decode.
3. **Framing**: streams are split into lines on `\n`; a trailing `\r` is stripped from each line (CRLF
   tolerance). `combined` is the runner's single merged capture of stdout+stderr (one pipe, `2>&1` semantics,
   arrival order). A matcher *matches* iff at least one line of its declared stream satisfies it —
   `literal`: the line CONTAINS `value` as a contiguous byte substring; `anchored-regex`: `regex.test(line)`
   is true; `class`: the registered predicate holds (exit-code classes consult `exitCode`, stream classes
   consult the whole captured stream).
4. **Effective literal**: for `kind: "literal"`, the entire `value`. For `anchored-regex`, the longest
   contiguous run of bytes in the pattern source consisting only of non-metacharacter literals, where the
   metacharacters are `^ $ . * + ? ( ) [ ] { } | \`; an escape sequence `\<meta>` contributes its single
   escaped byte to the run; any other escape (`\d`, `\s`, `\w`, `\b`, `\x..`, `\u....`) terminates the run.
5. **Entropy formula (exact)**: `entropyBits(value) = len(value) × H`, where `len` is byte length and
   `H = −Σ_b p(b)·log2(p(b))` is the empirical per-byte Shannon entropy over the byte frequency distribution
   `p(b)` of `value`. (Total bits, not per-symbol: a long low-variety string and a short high-variety string
   are both measured honestly.)

---

## §2. Disposable-workspace runner and four-tuple net-state invariance

### §2.1 The four-tuple (measured PRE and POST)

Every RED run and every GREEN run is executed by a runner that captures a **four-tuple** immediately before the
command starts (PRE) and immediately after it exits (POST). The four measured quantities are:

1. **`headHash`** — `git rev-parse HEAD` in the workspace (the checked-out commit).
2. **`materialHash`** — the canonical material digest over the workspace tree at HEAD, computed by the SAME
   function the CLI uses today: `currentMaterialHash(workspaceRoot, 'HEAD', metadataRoot)`
   (`packages/main/src/core/evidence-freshness.ts`, invoked at `packages/main/src/handlers/proofstory.ts:969`).
   W2 does not redefine the material hash; it reuses this function verbatim.
3. **`indexState`** — the `git write-tree` object id of the staged index (equivalently a SHA-256 over
   `git ls-files --stage -z` output). Captures staged mutations. NOT filtered by any exclusion set — a RED/GREEN
   command has no business touching the index at all.
4. **`gitStatus`** — SHA-256 over the output of `git status --porcelain=v1 -z` (WITHOUT `--ignored`, so
   gitignored build artifacts never enter the tuple), after removing every line whose path matches a glob in
   `policy.invarianceExcludePaths` (§1.2 — the precisely-defined invariance exclusion set for non-ignored
   ephemera such as test caches). Glob semantics: the same segment-aware matching as the W1 material-policy
   resolver contract (`language-neutral-gates-execution-plan.md` Change C). The exclusion set is part of
   `policySnapshot`, hence digest-bound into the record.

The four-tuple pair is stored on the record as `runReceipt.pre` / `runReceipt.post` (§1.10).

### §2.2 The invariance assertion (exact pass rule; honestly scoped)

> **INVARIANCE**: a run is *workspace-untouched* (in the net-state sense defined here) iff
> `pre.headHash == post.headHash` AND `pre.materialHash == post.materialHash` AND
> `pre.indexState == post.indexState` AND `pre.gitStatus == post.gitStatus` — all four fields byte-identical
> PRE and POST.

If and only if all four compare equal is the run allowed to produce a record. The comparison is exact string
equality of the four digest/hash pairs.

**Scope of the claim (audit: PRE/POST equality cannot see transient mid-run writes).** This is **net-state
invariance**: it proves the run's NET effect on the measured workspace state is nil. It does NOT prove the
command performed no write at any instant (a command could modify a tracked file and byte-restore it before
POST). Mid-run write monitoring would require privileges or mechanisms excluded by §2.3's isolation
constraints, so W2 claims exactly net-state invariance and no more. Two facts bound the residual risk: the
workspace is disposable (a mid-run self-restoring write cannot poison the real tree), and the command is
adapter-derived (R1-5 — the attacker does not control the executable text). Implementation stories MUST NOT
describe the four-tuple as proof of zero mid-run writes.

### §2.3 Canonical workspace materialization and run protocol (single algorithm)

The command executes inside a **disposable workspace**, never the real story tree. ONE materialization method
is mandated (audit: rev 1's "worktree OR recursive copy" produced divergent PRE tuples):

0. **Derive the command.** Resolve `adapterId` in `policy.runnerAdapterRegistry`; match `testCaseRef` against
   the adapter's `testCaseRefPattern`; instantiate `argvTemplate` → argv. No shell interpretation of
   caller-supplied text (R1-5). Resolve the runner profile `runnerProfileId` from policy: an ordered list of
   preparation commands (e.g. `npm ci`, build steps), an environment allowlist (`allowedEnvKeys`), and a
   relative `cwd`. `runnerProfileDigest = CANON(profile)` goes into the receipt.
1. **Create.** `git worktree add --detach <tmpdir> <baselineHeadHash>` where `<tmpdir>` is a fresh directory
   under the OS temp root (`$TMPDIR`). This is the ONLY materialization method. Submodules are initialized iff
   the profile declares `submodules: true`; symlinks/exec bits materialize per git defaults. **Consequence
   (stated, not implied): the baseline MUST be a committed state.** A reproduction test that exists only as an
   uncommitted working-tree file is NOT visible to the runner — the owner MUST commit it (story branch) before
   the RED run. Uncommitted-file injection into the workspace is prohibited: it would break the §2.3.3
   baseline-equality requirement.
2. **Prepare.** Run the profile's preparation commands inside the workspace (dependency install, build). Then:
3. **Snapshot PRE** — capture the four-tuple (§2.1). **REQUIRE baseline equality (R2-3):**
   `pre.headHash == record.baselineHeadHash` AND `pre.materialHash == record.baselineMaterialHash`, else the
   run is aborted and no record is written. (The claimed baseline is thereby runner-verified, not
   self-reported.)
   3b. **Exercise.** Spawn argv in its own process group, env = allowlisted projection + `LATTICE_RED_RUN_NONCE`,
   cwd = profile cwd, capturing stdout/stderr (merged pipe for `combined`). Wall-clock ceiling
   `policy.runTimeoutMs`. **On timeout:** SIGTERM the process GROUP, wait `policy.killGraceMs`, SIGKILL the
   group, reap all descendants — THEN CONTINUE to step 4 (audit: rev 1 made every timeout unrecordable, which
   contradicted `timeout-is-failure`; the POST snapshot is taken after group termination).
4. **Snapshot POST** — capture the four-tuple again.
5. **Assert.** Evaluate INVARIANCE (§2.2), the envelope predicates (§1), and for GREEN the full predicate
   (§1.5). A timed-out RED run is recordable iff `expectedExitClass == "timeout-is-failure"` AND POST was
   captured AND INVARIANCE passes; a timed-out GREEN run fails `!timeout` and is never GREEN.
6. **Discard.** `git worktree remove --force <tmpdir>` (fallback `rm -rf`) unconditionally — on success,
   rejection, timeout, or error. The real story tree is never written to.

**Isolation constraints (pre-mortem 1).** Isolation is **filesystem-level only**. The runner MUST NOT require
containers, overlay filesystems, mount namespaces, `chroot`, or root/elevated privileges. It MUST be
**macOS-sandbox-compatible**: it operates with only ordinary temp-directory write access under the default
macOS seatbelt sandbox. This is a recorded constraint on the W2 implementation.

### §2.4 Edge cases (traceable to rules)

- **Dirty index or untracked file left by the command.** If the command stages a change (`post.indexState !=
  pre.indexState`) or leaves a non-excluded untracked/modified file (`post.gitStatus != pre.gitStatus`),
  INVARIANCE fails. The run is an **invariance violation**: the record is **REJECTED and never written**
  (§2.5, R2-1). Files matching `policy.invarianceExcludePaths` or `.gitignore` never enter the comparison
  (§2.1.4), so ordinary test-runner caches do not trip this rule. Because the workspace is disposable, the
  real tree is unaffected regardless.
- **Command TIMES OUT.** The runner terminates the process group (§2.3.3b) and then captures POST. Concrete
  verdicts: (a) RED run with `expectedExitClass == "timeout-is-failure"`, POST captured, INVARIANCE passes →
  the record is admissible (the timeout IS the asserted failure). (b) RED run with any other exit class →
  rejected by R1-4 (exit not in class). (c) GREEN run → `!timeout` is FALSE, never GREEN-satisfying. (d) POST
  snapshot itself unobtainable (workspace destroyed/git failure after kill) → **REJECTED** (missing POST
  snapshot, §2.5 R2-2); the workspace is force-discarded (§2.3.6).

### §2.5 Rejection rules (tampered runner is detectable)

> **R2-1 / R2-2 (invariance-violation rejection).** *A record whose POST four-tuple is not byte-identical to
> its PRE four-tuple (R2-1), or that omits either the PRE or the POST snapshot (R2-2), is REJECTED and never
> written.*
>
> **R2-3 (baseline-equality rejection).** *A run whose PRE four-tuple does not satisfy
> `pre.headHash == baselineHeadHash AND pre.materialHash == baselineMaterialHash` is aborted; no record is
> written.*

A runner that silently mutated the tree produces `post != pre` and is rejected; a runner that skipped the
invariance proof omits a snapshot and is rejected; a record claiming a baseline the workspace never had is
rejected. None can produce a satisfying record through the registered surfaces (§0.6).

---

## §3. Supersedes-chain integrity and idempotency key

### §3.1 Chain schema — one chain per acceptance target

`.lattice/story/actives/<id>/red-evidence.json` remains ONE append-only `records[]` array per story (storage
layout unchanged from `RedEvidenceData`, `packages/main/src/core/types.ts:2639`). Logically, the records form
**independent supersedes chains keyed by `(storyId, acceptanceTargetRef)`** (audit: a single story-global
chain made unrelated targets supersede each other and could not answer §5's per-target query). All chain
fields — `seq`, `priorRecordDigest`, `supersedes`, head-ness — are scoped to the record's target chain.

Chain fields on every v2 record (full schema in §1.10):

- **`operation`** ∈ `{ "red-assert", "green-confirm", "quarantine", "recover" }` (audit: rev 1 had no GREEN
  record type, so no implementable path existed from RED to a GREEN verdict under immutability; `green-confirm`
  is that path — a NEW record superseding the red-assert head, §1.10).
- **`seq`** — monotonic integer within the target chain: `1` for the chain-founding record,
  `targetChainHead.seq + 1` thereafter.
- **`priorRecordDigest`** — the `recordDigest` of the target-chain record this one supersedes; JSON `null`
  iff `seq == 1`.
- **`supersedes`** — the `id` of that same record; `null` iff `seq == 1`.
- **`recordDigest`** — `CANON` (§0.4) over this record with `recordDigest` omitted.

### §3.2 Chain-head uniqueness invariant (per target)

> **CHAIN-HEAD**: for each `(storyId, acceptanceTargetRef)`, the *chain head* (= the latest record for that
> target) is the unique record of that target chain that (a) is not referenced by any other record's
> `priorRecordDigest` AND (b) has the maximal `seq` in that chain. A well-formed target chain has **exactly
> one** chain head. Distinct targets' chains are independent: appending to AB-002's chain never changes
> AB-001's head.

### §3.3 The three required integrity checks (per target chain)

A new appended record is admitted only if ALL THREE hold within its target chain (pre-mortem 3):

1. **Monotonic seq.** `newRecord.seq == targetChainHead.seq + 1` (exactly; no gaps, no reuse; `1` iff the
   chain is empty).
2. **Prior-digest link.** `newRecord.priorRecordDigest == targetChainHead.recordDigest` (the link resolves to
   the current head's canonical digest; `null` iff the chain is empty).
3. **Fork rejection.** No existing record of the same target chain already claims
   `newRecord.priorRecordDigest` as ITS `priorRecordDigest`. If a prior digest has already been consumed, the
   new record is a fork attempt and is rejected. This preserves a single head per target chain.

### §3.4 Idempotency key (every component enumerated; recordId is deterministic)

**Deterministic record id (audit: a randomly-minted id made every retry a "new" record, defeating dedupe).**
The record id is DERIVED, never caller-chosen:

> `idempotencyDigest = CANON({ operation, acceptanceTargetRef, baselineHeadHash, baselineMaterialHash,
> specDigest, assertionDigest, policyDigest, priorRecordDigest })`
> `recordId = <OP> + "-" + first12hex(idempotencyDigest) + "-" + seq`, with `<OP>` ∈
> `{RED, GRN, QUA, REC}` per operation.

A retry of the same append at the same chain state therefore reproduces the identical `recordId`.

The **idempotency key** of a candidate record is the tuple:

> **IDEMPOTENCY-KEY** = ( `recordId`, `materialHash`, `specDigest`, `policyDigest`/`assertionDigest`,
> `freshness-compatible head` )

- **`recordId`** — the derived id above (deterministic, so retries collide by construction).
- **`materialHash`** — the record's `baselineMaterialHash` (runner-verified per R2-3).
- **`specDigest`** — as defined in §1.10 (exact subobject pinned).
- **`policyDigest` / `assertionDigest`** — the two envelope digests from §1.1.4. Both participate; a change to
  either yields a different key.
- **`freshness-compatible head`** — defined EXACTLY as the pair (`baselineHeadHash`, `priorRecordDigest`):
  two appends are freshness-compatible iff they bind the identical baseline head AND the identical chain
  position. (Audit: rev 1's "freshness bucket" had no algorithm; this pair is fully deterministic. Bounded
  staleness applies only to the read-side query, §5.3 — never to append dedupe.)

### §3.5 Replay-dedup semantics (dedupe vs conflict)

> **DEDUP**: an append whose IDEMPOTENCY-KEY equals that of an already-present record is compared to it by
> FULL canonical payload (`CANON` of the candidate minus `recordDigest` vs the stored record's
> `recordDigest` preimage). If the payloads are IDENTICAL, the append is a *replay*: NO new record is written
> and the existing record is returned (same key + same payload ⇒ same record). If the payloads DIFFER, the
> append is a **CONFLICT and is REJECTED with a conflict error** — never silently deduped and never written
> (audit: rev 1's "same key ⇒ same record" would have masked materially different runs, e.g. differing exit
> codes or receipts, behind one key). Dedup/conflict is decided before the chain-integrity checks of §3.3, so
> a benign retry never appears as a fork.

### §3.6 Edge cases (traceable to rules)

- **Two records claiming the SAME prior digest (fork attempt).** The first is admitted and becomes the target
  chain head; the second violates §3.3 check 3 (fork rejection) and is **REJECTED**. The chain head remains
  the first record; there is never a second "latest" for a target.
- **Replay with an identical idempotency key.** Identical payload → per §3.5 DEDUP, no new record, existing
  record returned, `records.length` unchanged. Differing payload → CONFLICT rejection, chain unchanged.

### §3.7 Rejection rule (silent replacement is detectable)

> **R3 (silent-replace rejection).** *A record that would silently REPLACE a prior record instead of superseding
> it — an absent or broken `priorRecordDigest` (does not resolve to its target-chain head's `recordDigest`), a
> non-monotonic `seq` (not exactly `head.seq + 1`), or any append that would create a second head in one
> target chain — is REJECTED.*

Because supersession requires a valid prior-digest link and a monotonic seq, an auditable append-only history
cannot be forged through the registered surfaces (§0.6): every target's latest state is reachable by walking
`priorRecordDigest` links from that target's unique head back to `seq == 1`.

---

## §4. Owner-gated quarantine/recover, corrected retention, and legacy link

### §4.1 Quarantine and recover as owner-gated registered operations

Retiring or reinstating a record is done ONLY through two **owner-gated registered operations**, each of which
appends a NEW record (never edits or deletes an existing one):

- **`red_evidence_quarantine(storyId, recordId, reason)`** — appends a new record with `operation:
  "quarantine"`, `linkKind: "quarantines"`, `recoversRecordId: <recordId>` (the link back to the record being
  retired), a derived `id` (§3.4), and `seq`/`priorRecordDigest` continuing the target chain (§3). The
  quarantine record becomes the new target chain head; the prior record is untouched.
- **`red_evidence_recover(storyId, recordId, reason)`** — appends a new record with `operation: "recover"`,
  `linkKind: "recovers"`, `recoversRecordId: <recordId>`, a derived `id`, and `seq`/`priorRecordDigest`
  continuing the target chain. The recover record becomes the new target chain head.

**Reference validation (state machine — audit: rev 1 allowed recovering arbitrary records):**

| Operation | `recoversRecordId` MUST reference | Resulting head state |
|---|---|---|
| `quarantine` | the CURRENT head of the same `(storyId, target)` chain, whose operation is `red-assert`, `green-confirm`, or `recover` | `quarantined` |
| `recover` | the CURRENT head of the same chain, whose operation is `quarantine` | the state the quarantined record had (its operation re-governs verdict derivation, §5.4) |

An operation whose `recoversRecordId` does not exist, belongs to a different story or target chain, or is not
the current head in the required state, is REJECTED. Quarantining an already-quarantined head and recovering a
non-quarantined head are both invalid transitions. Recovery reinstates the SPECIFIC record retired by the
referenced quarantine (transitively: the quarantine's own `recoversRecordId`); a stale GREEN verdict regains
force only if the §5.3 freshness algorithm still passes at query time — recovery does not refresh freshness.

**Owner-gated — the concrete, implemented authorization (audit: "same gate other handlers use" was not
citable).** Both operations MUST be wired through the two mechanisms mutating story commands use today:

1. **The story-owner lease gate**: `enforceStoryOwnerLeaseGate`
   (`packages/main/src/cli/ownership-gate.ts:235`), which acquires/refreshes the per-story
   `owner-lease.json` via the lease core (`packages/main/src/core/story-owner-lease.ts`; acquisition call at
   `ownership-gate.ts:282`) and REJECTS the command when another session holds an ACTIVE lease
   (heartbeat-based staleness; `--takeover` transfers only a stale lease; `--forceTakeover` is a deliberate
   human override).
2. **Actor mutation authority**: `resolveAgentMutationAuthority`
   (`packages/main/src/core/agent-dispatch-registry.ts:504`), which classifies the acting identity — a
   nonblank `LATTICE_AGENT` env identity is authoritative, registered roles follow registry authority, a
   payload identity can never override the dispatched env identity, and conflicting identities fail closed
   (`[agent_dispatch_identity_conflict]`).

**`approvedBy` is DERIVED, never caller text**: the recorded `approvedBy` is the resolved actor from
`resolveAgentMutationAuthority` plus the lease `sessionId` — a free-form `approvedBy` argument is not
accepted. Known limitation (program plan W0.3): the owner lease is not yet a mutex for same-owner concurrent
commands; the W2 implementation MUST serialize quarantine/recover appends under the same atomic claim
discipline the transition orchestrator uses (the `mkdir`-claim pattern of B-d877 R3, visible at
`packages/main/src/handlers/transition-orchestrator.ts:777-789`), or land after W0.3.

### §4.2 Immutability (no in-place edits, ever)

> **IMMUTABILITY**: no operation ever mutates a field of, or deletes, an already-written record. Every state
> change — red-assert, green-confirm, quarantine, recover — is a NEW appended record linked by
> `priorRecordDigest` (chain) and, for quarantine/recover, `recoversRecordId` (operation link).

### §4.3 Corrected retention claim (with honest anchor attribution)

The program plan's retention citation drifted across the S1/W1 merges (its `:663` line moved). The corrected
claim, which this spec pins:

> **Canonical receipts preserve metadata freshness within a round only; review rounds are per-entry via the
> `story.currentReviewRound = now` assignment at `packages/main/src/handlers/transition-orchestrator.ts:775`
> (v0.3.230).**

Anchor attribution (audit: line 775 alone does not prove the whole sentence): the SECOND half — review rounds
are minted per-entry, `= now`, on every advance to REVIEW — is directly proven by `transition-orchestrator.ts:775`
and is the fact this spec relies on. The FIRST half — receipts preserving metadata freshness within a round
only — is the program plan's corrected retention claim
(`repro-first-gate-enforce-execution-plan.md`, Workstream 2 scope), whose enforcement lives in the
receipt-freshness consumers (the `currentGitHead`/`currentMaterialHash`/`currentStoryFilesHash` family,
`packages/main/src/core/evidence-freshness.ts`); the W2 implementation story MUST verify its freshness wiring
against those consumers, not against line 775. Practical consequence for W2: RED records bind freshness by
hash (§5.3), and review-round identity is NEVER a freshness input — cross-round reuse is governed solely by
the §5.3 algorithm.

### §4.4 Legacy-record posture (link — full posture in §6)

Existing `.lattice/story/actives/<id>/red-evidence.json` records (schema `proofstory.red_evidence.v1`) predate
this subsystem. Their normative posture (§6): **grandfathered read-only via an adoption-time migration
manifest**. The gate query answers a legacy head with verdict **`legacy-unverified`** plus provenance
(`legacy-manifest` membership); W2 never declares a legacy record satisfying or unsatisfying — that mapping is
W3 enforcement policy (§5.5). Legacy records are never silently upgraded, never silently invalidated, and a
record outside the manifest can never claim legacy status. Rationale, manifest mechanics, the in-flight
transition rule, and the downgrade-loophole closure are the dedicated §6.

### §4.5 Edge cases (traceable to rules)

- **Recover of an already-recovered record (recover of a recover).** After a recover, the chain head is a
  `recover` record — NOT a `quarantine` — so a second `recover` referencing it violates the §4.1 state
  machine and is **REJECTED** (nothing is quarantined; there is nothing to recover). The correct sequence to
  re-retire and re-reinstate is quarantine → recover → quarantine → recover, each a new head; each recover
  reinstates exactly the record retired by the quarantine it references. No record is ever mutated.
- **Quarantining the current chain head.** `quarantine` on the current head (the only record it may
  reference) appends a new head record with `operation: "quarantine"`, `recoversRecordId` = the retired
  head's id, and `seq = head.seq + 1`. The retired head is unchanged; the new target chain head is the
  quarantine record, and the gate query (§5) then answers `status: quarantined` for that target.

### §4.6 Rejection rule (non-destructive by construction)

> **R4 (immutability rejection).** *An operation that mutates fields of, or deletes, the referenced prior record
> is DISALLOWED. Only new, linked records may be created.*

An owner cannot use quarantine/recover to erase inconvenient RED history: the retired record persists verbatim
and remains reachable by walking the chain, and the reference-validation state machine (§4.1) forecloses
resurrecting arbitrary stale records as heads. And — reinforcing §6 — the legacy posture cannot silently
invalidate the records of an in-flight story mid-program: a legacy record's classification can only change via
an explicit, auditable superseding append, never a silent status flip.

---

## §5. Gate-consumption query contract (the W2/W3 boundary)

### §5.1 The single read-only query

W2 exposes exactly ONE read-only query for gates. Name: **`redEvidenceGateQuery`**.

**Request:**

```json
{ "storyId": "B-xxxx", "acceptanceTargetRef": "AB-001" }
```

- `storyId` — the story whose red-evidence chains are queried.
- `acceptanceTargetRef` — the acceptance target (chain key, §3.1) the gate is asking about.

**Response — a tagged union.** Success shape (`result: "ok"`):

```json
{
  "result": "ok",
  "storyId": "B-xxxx",
  "acceptanceTargetRef": "AB-001",
  "chainHeadRecordId": "GRN-9c41d2e07a3b-2",
  "status": "active",
  "verdict": "GREEN",
  "provenance": "v2",
  "freshness": {
    "boundHead": "<hex>",
    "boundMaterial": "sha256:...",
    "mode": "bounded-staleness",
    "liveMatch": true,
    "reason": "exact-head"
  }
}
```

Error shape (`result: "error"`; full error taxonomy in §5.6):

```json
{ "result": "error", "storyId": "B-xxxx", "acceptanceTargetRef": "AB-001",
  "errorKind": "corrupt-chain", "detail": "<machine-readable reason>" }
```

- **`status`** ∈ `{ "none", "active", "quarantined", "superseded" }` — derived by the total algorithm of §5.6.
- **`verdict`** ∈ `{ "GREEN", "RED", "legacy-unverified", "indeterminate" }` — per §1.5 for v2 heads, §6 for
  legacy heads, `indeterminate` for freshness mismatch (§5.3/§5.4).
- **`provenance`** ∈ `{ "v2", "legacy-manifest" }` — whether the answer derives from a v2 chain or a
  manifest-grandfathered legacy record (§6).
- **`freshness`** — the head's bound hashes, the resolution `mode`, `liveMatch`, and the `reason` code from
  the §5.3 algorithm.

The query is **read-only**: it computes the answer from stored records, the manifest, and the live tree; it
writes nothing.

### §5.2 Answer determinacy

For any `(storyId, acceptanceTargetRef)` the query returns exactly ONE answer (success or tagged error). A W3
implementer wires the gate from this section alone with **zero design decisions**: the gate calls
`redEvidenceGateQuery`, reads `status`/`verdict`/`freshness`/`provenance` (or `errorKind`), and maps them to an
enforcement decision — which mapping is W3's alone (§5.5).

### §5.3 Freshness resolution — the deterministic algorithm

(Audit: rev 1 mixed a "current review round window" with cross-round acceptance and left the material set,
hash function, ancestry failure, and dirty tree undefined. The algorithm below is total; review-round identity
is NOT an input — cross-round evidence is acceptable exactly when the hash conditions hold.)

**Authoritative binding**: the chain-head record's own runner-measured hashes — for a `red-assert` head,
(`baselineHeadHash`, `baselineMaterialHash`); for a `green-confirm` head, (`greenHeadHash`,
`greenMaterialHash`); for a `quarantine`/`recover` head, the binding of the record it retires/reinstates.
These are `boundHead` / `boundMaterial` in the response.

**Material set and hash function**: `boundMaterial` and the live material hash are both computed by the SAME
existing function `currentMaterialHash(gitCwd, 'HEAD', projectRoot)`
(`packages/main/src/core/evidence-freshness.ts` — the function already used at
`packages/main/src/handlers/proofstory.ts:969` and `transition-orchestrator.ts:873`). W2 does not define a new
material classification; the material set is whatever that function (post-W1 snapshot policy) hashes.

**Algorithm** (evaluated at query time against the live story tree):

```
FRESH(head):
  1. liveHead     := git rev-parse HEAD            — on git failure → error "storage-error"
  2. liveMaterial := currentMaterialHash(...)      — on failure → error "storage-error"
  3. dirty        := any line of `git status --porcelain=v1 -z` names a path that is
                     material under the SAME classification currentMaterialHash uses
                     (excluded/ignored paths never count)
  4. if dirty                          → liveMatch=false, reason="dirty-tree"
  5. else if boundHead == liveHead
          AND boundMaterial == liveMaterial → liveMatch=true,  reason="exact-head"
  6. else if isAncestor(boundHead, liveHead)      — `git merge-base --is-ancestor`
          AND boundMaterial == liveMaterial → liveMatch=true,  reason="ancestor-material-unchanged"
  7. else if isAncestor errored (missing object, shallow clone)
                                       → liveMatch=false, reason="ancestry-unverifiable"
  8. else                              → liveMatch=false, reason="drift"
```

**Error-to-verdict map**: steps 1-2 failures are query errors (§5.6), not verdicts. `liveMatch=true` keeps the
head's own verdict (GREEN/RED/legacy-unverified). `liveMatch=false` forces verdict **`indeterminate`**
(reasons `dirty-tree`, `ancestry-unverifiable`, `drift`) — the evidence neither passes nor fails at the live
tree. `liveMatch` is therefore true in BOTH the exact-head and the ancestor-plus-unchanged-material cases —
bounded staleness is exactly rule 6, and an implementer setting `liveMatch=false` merely because
`boundHead != liveHead` violates this section.

### §5.4 Edge-state answers (exactly one answer each; status derivation is total)

Status is a total function of the target-chain head's `operation` history (audit: rev 1's `superseded` had no
derivation):

- head absent → `none`;
- head is `red-assert` or `green-confirm` → `active`, EXCEPT the superseded case below;
- head is `quarantine` → `quarantined`;
- head is `recover` → the status the reinstated record would have (its operation re-enters this derivation);
- **`superseded`** — the head is a `red-assert` whose prior-digest walk since the most recent `green-confirm`
  of the same chain shows it superseded that green-confirm (i.e. the target WAS green-confirmed, a newer RED
  assertion re-opened it, and no newer green-confirm exists). The old GREEN is superseded and not yet
  replaced.

| Edge state | `status` | `verdict` | Notes |
|---|---|---|---|
| **No records** for the target | `none` | `RED` | `chainHeadRecordId: null`; nothing exists for the target. |
| **Quarantined head** | `quarantined` | `RED` | A quarantined head never yields GREEN. |
| **Superseded-but-unreplaced head** | `superseded` | `RED` | Prior GREEN superseded by a newer red-assert; no replacement green-confirm yet. |
| **Freshness-mismatched head** | `active` (or as derived) | `indeterminate` | `freshness.liveMatch: false` with reason ∈ {`dirty-tree`,`ancestry-unverifiable`,`drift`} (§5.3). |

### §5.5 W2/W3 boundary (boxed, with MUST NOT list)

> **╔══════════════════ W2/W3 BOUNDARY ══════════════════╗**
>
> **W2 (this subsystem) exposes ONLY the read-only `redEvidenceGateQuery`. It returns FACTS
> (status + verdict + provenance + freshness, or a tagged error) and makes NO enforcement decision.**
>
> **MUST NOT (scope fence):**
> - A gate MUST NOT write through the query (it is read-only; there is no write path in this contract).
> - A gate MUST NOT reach into `red-evidence.json` storage or the legacy manifest directly; it consumes only
>   the query answer.
> - The query MUST NOT return a block/allow/pass/fail enforcement decision — only status, verdict,
>   provenance, freshness, and tagged errors.
> - Mapping the answer to an enforcement outcome (block DEV→REVIEW, warn, allow-with-bypass, how
>   `legacy-unverified` and every `errorKind` translate to gate behavior, any per-story-age legacy handling)
>   is **W3's** responsibility and MUST live in W3's enforcement wiring, not here.
> - No new query surface, mutation, or side effect may be added to W2 to satisfy an enforcement need; such
>   needs are resolved in W3.
>
> **╚═════════════════════════════════════════════════════╝**

### §5.6 Total query algorithm and tagged error schema

The query is TOTAL: every input yields exactly one success or one tagged error (audit: rev 1 was silent on
corrupt chains, forks, unknown stories, and storage failures).

**Algorithm:**

```
redEvidenceGateQuery(storyId, acceptanceTargetRef):
  1. Resolve story dir. Story unknown                    → error "missing-story"
  2. Read red-evidence.json. I/O or JSON-parse failure   → error "storage-error"
  3. File absent, or zero records for the target:
       if legacy manifest (§6.2) has entries for (storyId, target) → legacy path (step 7)
       else → ok { status:"none", verdict:"RED", chainHeadRecordId:null }
  4. Validate schema versions. A record that is neither valid v2 nor a
     manifest-member v1 record                           → error "unsupported-schema"
  5. Build the target chain (v2 records). Verify: every recordDigest recomputes;
     every priorRecordDigest resolves; seq is 1..n monotonic.
       digest/link/seq violation                         → error "corrupt-chain"
       two heads / duplicated prior-digest consumption   → error "fork-detected"
  6. Resolve the unique head; derive status (§5.4); derive verdict —
     green-confirm head: evaluate the stored receipt facts against §1.5 → GREEN or RED;
     red-assert/quarantine/superseded head: RED; run FRESH (§5.3) → may force "indeterminate".
     Return ok with provenance:"v2".
  7. Legacy path: the target's newest manifest-member v1 record is the answer record.
     Verify its CANON digest equals the manifest entry's recordDigest;
       mismatch                                          → error "corrupt-chain"
     Return ok { status:"active", verdict:"legacy-unverified", provenance:"legacy-manifest",
                 freshness from the v1 baseline hashes via FRESH }.
     If BOTH a v2 chain and legacy records exist for the target, the v2 chain wins
     (steps 5-6); legacy records are then unreachable through the query.
```

**Error taxonomy** (`errorKind` closed enum): `missing-story`, `storage-error`, `corrupt-chain`,
`fork-detected`, `unsupported-schema`. W2 assigns NO gate behavior to errors — the W3 policy decides whether
each error blocks, warns, or escalates (§5.5).

---

## §6. Legacy record posture

### §6.1 The one normative decision

> **POSTURE (verbatim, citable):** Existing `proofstory.red_evidence.v1` records
> (`packages/main/src/core/proofstory.ts:78`) are **GRANDFATHERED, read-only, via the adoption-time migration
> manifest (§6.2)**. A record is legacy **iff it is a member of that manifest** — membership is the sole
> criterion. The gate query (§5) answers a legacy record with verdict **`legacy-unverified`** and provenance
> **`legacy-manifest`**; W2 states no opinion on whether that satisfies any gate — the mapping of
> `legacy-unverified` to allow/warn/block is W3 enforcement policy (§5.5). Legacy records are **never
> silently upgraded** to v2 and **never silently invalidated**. Every record created after the adoption point
> MUST be a v2 record with the §1 envelope; a v1-schema record outside the manifest is `unsupported-schema`
> (§5.6) wherever it appears.

**Rationale.** Grandfathering (rather than migrating or invalidating) is the only posture that does not strand
in-flight stories: migration would require re-running RED assertions that may no longer be reproducible, and
invalidation would break stories whose only sin is predating the subsystem. Manifest membership (rather than
any timestamp) is the only classification an attacker cannot satisfy after the fact (§6.4). And
`legacy-unverified` as a distinct verdict — neither GREEN nor RED, with no W2 "satisfies the gate" claim —
keeps the W2/W3 boundary intact: facts here, policy in W3.

### §6.2 Adoption point and the migration manifest

The **adoption point** is fixed by a one-time, registered migration operation executed when the subsystem
lands:

1. It enumerates EVERY v1 record then existing across
   `.lattice/story/actives/*/red-evidence.json`.
2. It writes the **legacy migration manifest** — an immutable file
   (`.lattice/red-evidence-legacy-manifest.json`):
   `{ "schemaVersion": "proofstory.red_evidence.legacy_manifest.v1", "adoptionCommit": "<head sha at adoption>",
   "adoptionTimestamp": "<ISO-8601>", "entries": [ { "storyId", "recordId", "recordDigest" } ... ],
   "manifestDigest": "sha256:<CANON of the manifest minus manifestDigest>" }` — one entry per grandfathered
   record, `recordDigest` = `CANON` of the v1 record as stored.
3. The manifest is committed in the same commit that lands the subsystem; `adoptionCommit` is that commit's
   parent head. The manifest is **append-never**: no operation may add, remove, or edit entries after
   creation (the migration operation refuses to run twice).

> **LEGACY-CLASSIFICATION RULE:** a record is legacy iff `(storyId, recordId)` appears in the manifest AND the
> stored record's `CANON` digest equals the manifest entry's `recordDigest`. `createdAt`, `schemaVersion`
> claims, and any other author-writable field play NO role in the classification (audit: rev 1 classified by
> `createdAt`, which an attacker with storage access can backdate; manifest membership anchored to a commit
> cannot be forged after adoption without visibly rewriting git history — see §0.6 for the residual threat
> scope).

### §6.3 In-flight transition rule (deterministic)

A story mid-lifecycle at the enforce flip whose latest record for a target is a manifest-member v1 record:

- The gate query (§5.6 step 7) answers `status: "active"`, `verdict: "legacy-unverified"`,
  `provenance: "legacy-manifest"`, with freshness computed from the record's baseline hashes.
- What that answer MEANS for the gate — allow, warn, or require a v2 record — is W3's enforce policy, which
  MAY differentiate by story age or by whether post-adoption material touches the target; W2 pre-decides none
  of it (§5.5).
- **Owner action required by W2: none.** A manifest-member record needs no owner intervention to keep
  answering the query. If the owner (or W3 policy) wants a verifiable verdict for that target, the path is
  forward-only: create a v2 `red-assert` (and later `green-confirm`) for the target — the v2 chain then wins
  at query time (§5.6 step 7) and the legacy record simply becomes unreachable, never edited.

### §6.4 Downgrade-loophole closure

> **LOOPHOLE-CLOSURE:** legacy status is **manifest membership, fixed at the adoption point** (§6.2). The
> manifest is immutable and anchored to `adoptionCommit`; the migration operation runs exactly once. A record
> created after adoption — whatever `schemaVersion` or `createdAt` it declares — is not in the manifest and
> therefore can NEVER be classified legacy: as v1-schema it is `unsupported-schema` (§5.6 step 4); as v2 it
> must satisfy the full §1 envelope.

The downgrade path is closed on all three edges: (a) a new record cannot be created "as legacy" (not a
manifest member); (b) an existing legacy record cannot be edited to smuggle new content (its digest would no
longer match the manifest entry → `corrupt-chain`, §5.6 step 7); (c) deleting a v2 record to fall back to an
older legacy record is visible and self-defeating — IMMUTABILITY (§4.2) forbids deletion through registered
surfaces, and even under §0.6's offline-rewrite threat the v2 chain's absence changes nothing the attacker
wants: the legacy record still answers only `legacy-unverified`, never GREEN.

---

## §7. Cross-section acceptance (whole document)

The spec is complete when a cross-host audit confirms all of §1..§6 are present and each section's rules are
traceable to text, and the two folded-in product-review advisories are addressed: the gate-consumption query
contract drawing the W2/W3 boundary (§5, summarized in §1.9) and the legacy-record posture (§6, linked in
§4.4). This document is the citable acceptance contract for the W2 implementation stories; no implementation
code is in scope here.
