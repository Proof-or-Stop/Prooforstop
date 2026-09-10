# Trusted RED-Evidence Subsystem — Decision Spec (Program Workstream 2)

Status: decision spec / acceptance contract for the W2 implementation stories. No runtime change is authorized by this document; it ships zero code.
Date: 2026-09-10 (rev 14 — PROGRAM LOCK-ORDER ALIGNMENT, preserving rev 13 while reconciling §4.1 with plan
§8: the main write lock is placed between the Story transition lock and per-Story repro locks, PLAN→DEV omits
it because it does not mutate shared main state, and the §7.2 manifest writer takes it in that same position.
This is documentary contract repair only, authorizes no runtime implementation, and is not an audit approval.
Because plan §1 hashes this file's exact bytes, the current pair remains `blocked` until a fresh independent
audit records a matching entry.)
Prior revision: 2026-09-10 (rev 13 — SOURCE-CITATION REPAIR, documentary only, preserving rev 12 and naming in §6.5 the
candidate-intake experiment it defers to by repository path
(`docs/requirements/decisions/repro-first-story-intake-experiment.md`) instead of the untraceable phrase "the
intake experiment". It adds no companion-owned §1..§6 semantic choice, authorizes no runtime implementation,
and is not an audit approval. Because plan §1 hashes this file's exact bytes, the current plan/companion pair
stays `blocked` until a fresh independent audit records an entry matching both current digests.)
Prior revision: 2026-09-10 (rev 12 — PATH-DELEGATION REPAIR, documentary only, preserving rev 11 and stating in §0.4 that
this spec names no pre-rename directory spelling as current storage, delegating retired-identity read
compatibility to `docs/requirements/decisions/proof-or-stop-identity-migration.md` rather than restating it
here. It adds no companion-owned §1..§6 semantic choice, authorizes no runtime implementation, and is not an
audit approval.)
Prior revision: 2026-09-10 (rev 11 — PLAN-v30 ALIGNMENT, documentary only, preserving rev 10 and naming the source
`META` compatibility phase as migration-required with no registered transition edge. This revision adds no
companion-owned semantic choice, authorizes no runtime implementation, and is not an audit approval.)
Prior revision: 2026-09-10 (rev 10 — PLAN-v29 ALIGNMENT, documentary only, answering documentary audit round R25:
(A) §7.3 pins the verification-intent descriptor pointer to the intent-item object and makes the declaration
pointer its strict `/reproEvidenceBinding` child; (B) §1.2 assigns P0p initial material population of the
repository's `#/redEvidence` block, including the required pinned executable directories and explicit
bootstrap registries. It also preserves rev 9's alignment and authorizes no runtime implementation or audit
approval. Because plan §1 hashes this file's exact bytes, the v29/rev10 pair remains `blocked` until a fresh
independent audit records a matching entry.)
Prior revision: 2026-09-10 (rev 9 — PLAN-v28 ALIGNMENT, documentary only, closing the v27 §1.1 reconciliation
obligation: (A) §0.5 and §7.3 retire every `express-exempt` mirror and require authored intent for every
selected unit under the plan's obligation-driven policy, including the Story-scoped docs unit; (B) §7.3
mirrors the Story-level `evidenceDeclarationSetDigest`, its total post-DEV recomputation, and the signed-intent
amendment/checkpoint non-bypass rule; (C) §7.3 names `p2f-contract-registry-unavailable` for an unavailable,
unapproved, unresolved, or incompatible `p2fContractId`; and (D) the lifecycle mirror rejects direct DONE
Story creation with no historical-import exception. Plan v28 remains authoritative for these program-level
rules. This revision authorizes no runtime implementation and is not an audit approval. Because plan §1
hashes this file's exact bytes, the v28/rev9 pair remains `blocked` until a fresh independent audit records a
matching entry.)
Prior revision: 2026-09-10 (rev 8 — PLAN-v26 ALIGNMENT, documentary only, mirroring the plan's R23 (a)-(b)
dispositions so the two documents cannot diverge: (A) new §7.3 mirrors plan v26 §4.1 in full — the additive,
closed `VerificationIntentItem.reproEvidenceBinding` authoring schema that is the sole admissible input to the
derived `evidenceBindings` / `storyEvidenceBindings` described in §0.5, its typed rejection rules, its
kind-fixed execution/expectation/subtype table, its total lane and `VerificationIntentType` constraint tables,
per-target association and `(target-or-story-scope, kind, subtype)` uniqueness, the one-to-one projection and
`evidenceBindingDigest` preimage, the PLAN→DEV freeze, the acyclic five-step derivation order, and the
firewall that keeps legacy `VerificationIntentItem.verification.command` / `.selector` and B-1482
narrowing out of every trusted repro runner and binding field; (B) §7.2 now states explicitly that P0m adds
`generatedFrom?` to **both** `ProcessFactRegistryEntry` and `RuntimeFactRegistryEntry` and defines
`coveredFiles` member (c) as the symmetric generated-path-plus-source-path relation for process-fact and
runtime-fact tuples alike, while plan §4's whole-registry preimages stay unchanged; (C) §0.5's "Verification
evidence binding" term and §7.1's no-caller-command rule point at §7.3 and restate the same legacy-pin fence.
Plan §4.1 remains authoritative for this authoring surface; this revision adds no semantic choice beyond
mirroring it, authorizes no runtime implementation, and is not an audit approval. Because the plan's §1
audit-state derivation hashes this file's exact bytes, this revision produces a new, currently unaudited
plan/companion digest pair whose derived state is `blocked` until a fresh independent audit records a matching
entry.)
Prior revision: 2026-09-10 (rev 7 — PLAN-v24 ALIGNMENT, documentary only, answering the plan's R22 (a)-(c)
dispositions: (A) every normative policy root moves from `proof-or-stop.config.json#/reproEvidenceV2` to the
live `#/redEvidence` root (§0.5, §1.2, §1.12), recording current 0.3.294 truth and stating the target as
in-place evolution of that namespace — no alias, no dual-read, no second namespace, no runtime/env
registration path, and no silent caller migration; (B) §7.2's component-manifest members are renamed
`componentProcessFactMappingDigest` / `componentRuntimeFactMappingDigest`, held distinct from plan §4's
whole-registry classification digests, extended to the `P0m|P0p|P1|P1f|P2a|P2b` component ids, and made
dependent on the prerequisite P0m mapping surface that 0.3.294's registries do not yet carry; (C) §0.5 records
the plan's obligation-discriminated express `verificationIntent` rule. Nothing in this revision is an
implementation claim or an audit verdict. Because the plan's §1 audit-state derivation hashes this file's
exact bytes, this revision produces a new, currently unaudited plan/companion digest pair whose derived state
is `blocked` until a fresh independent audit records a matching entry.)
Earlier revision: 2026-07-23 (rev 6 — ARCHITECTURAL CONVERGENCE after audit round 5: (MOVE 1) the regex matcher
language is REMOVED — matchers are `literal-line` + registered `class` only, deleting the entire
regex-gaming finding class; (MOVE 2) §0.6 gains an explicit assurance-tier clause — W2 defends against
accidental fabrication, workflow drift, and casual gaming; a fully hostile local agent with
filesystem/toolchain control is Tier-C's adversary, not W2's. All round-5 mechanical findings dispositioned;
earlier dispositions retained. Standing deviations, auditor-ACCEPTED in round 3: recordId stays in the
idempotency-key tuple as a deterministic derivation (§3.4); `recoversRecordId` keeps its program-pinned name
with a `linkKind` discriminator (§4.1))
Story: B-7dfa (program Workstream 2 spec story); rev 7 through rev 13 documentary alignments were authored
under Story B-de09 and change no companion-owned §1..§6 semantics.
Program: `docs/requirements/decisions/repro-first-gate-enforce-execution-plan.md` (§5 Trusted RED and GREEN contract; §12 Workstreams and delivery order)

This document is the citable, section-by-section acceptance contract for the Workstream 2 implementation
stories. Every §1..§6 below is written to be **implementable-mechanically**: an implementation story should
be able to build the described behavior with zero additional design decisions. Where this spec references
today's behavior it cites real source anchors (`packages/main/src/**`, never `dist/`).

---

## §0. Scope, non-goals, and grounding

### §0.1 Problem this subsystem closes

Today a RED record is created by the `red_evidence_create` handler in
`packages/main/src/handlers/proofstory.ts`, which appends a record through `appendRedEvidence` in
`packages/main/src/core/proofstory.ts` into `<storyDir>/<id>/red-evidence.json`
(schema `proofstory.red_evidence.v1` = `RED_EVIDENCE_SCHEMA_VERSION`; record shape `RedEvidenceRecord` in
`packages/main/src/core/types.ts`). The gate consumers `redEvidenceRecordSatisfied` and
`redEvidenceSatisfied` in `packages/main/src/core/proofstory.ts` only check that a record self-reports a non-empty
`observedFailure`, a `failingCommand` or `failureReceiptHash`, an in-target `acceptanceTargetRef`, non-empty
baseline hashes, a `greenRelation` whose `targetRef` matches the record's `acceptanceTargetRef` with a valid
`relation`, **at least one GREEN-related field** (`expectedGreenCommand`, `greenRelation.command`,
`greenRelation.greenHeadHash`, or `greenRelation.greenMaterialHash`), and — when GREEN hashes are supplied —
that they differ from the baseline hashes. The `missing_red_evidence` diagnostic in the same module fires only
when no such self-reported record exists.

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

Every content digest named in this spec is computed identically unless its definition explicitly says
`exact bytes` (as for scopeContractDigest, executableSha256, readyTokenDigest, and releaseTokenDigest):

> **CANON**: serialize the value as UTF-8 JSON using RFC 8785 (JSON Canonicalization Scheme) — object keys
> recursively sorted, no insignificant whitespace, minimal number/string encoding — then take `SHA-256` and
> render as lowercase hex. A content digest is written as `sha256:<64-hex>`.

Git object ids are not content digests under CANON: `baselineHeadHash`, `greenHeadHash`, `boundHead`,
`headHash`, and `frozenAtStoryHeadHash` are the bare lowercase 40- or 64-hex object ids returned by Git for
the repository's object format.
`currentMaterialHash` currently returns bare 64-hex; every P1/runner/query call MUST normalize that return at
the adapter boundary by prepending `sha256:` exactly once. Therefore `baselineMaterialHash`,
`greenMaterialHash`, `boundMaterial`, and `materialHash` are always `sha256:<64-hex>` before storage,
canonicalization, operation-key construction, or comparison. No consumer compares a prefixed value with the
raw function return.

`scopeContractDigest` is a content digest but not a legacy runtime digest: it is `sha256:` plus SHA-256 of
the exact bytes of `<storyDir>/<id>/scope-contract.json` read from
`frozenAtStoryHeadHash`. Consumers MUST NOT reuse or normalize the current bare-hex `digestScopeContract`,
`stableDigest`, or acceptance-basis fields; they recompute this exact-byte digest from the frozen Git tree.

`<storyDir>` always means the normalized repository-relative `storyDir` from the
`proof-or-stop.config.json` in the Git tree being read. P1 binds the exact string and `reproFreezeState`
stores it. Baseline, GREEN, and live readers resolve their own tree's config and require equality with the
frozen value before any artifact lookup; mismatch is `story-dir-drift` and no record/verdict is produced.
Changing `storyDir` for an active Story requires a separate explicit repository migration and fresh Story.
Because of that indirection this spec names no pre-rename directory spelling as current storage, and it does
not restate one: which retired identity spellings a reader still accepts, and which were renamed with
migration instead, is owned by `docs/requirements/decisions/proof-or-stop-identity-migration.md` (per-identity
verdicts in `docs/requirements/decisions/brand-rename-mapping.md`). A tree whose config still resolves a
pre-rename `storyDir` is handled by that truth source, not by a compatibility rule stated here.

The classification artifacts consumed by this spec use the program plan's fully public integrity-signature
scheme, repeated here to avoid an implicit design choice. Domains are
`REPRO_CLASSIFICATION_INTEGRITY_DOMAIN = "proof-or-stop.repro-obligation-classification.v1"` and
`REPRO_CLASSIFICATION_HEAD_INTEGRITY_DOMAIN = "proof-or-stop.repro-obligation-classification-head.v1"`, and
`REPRO_FREEZE_STATE_INTEGRITY_DOMAIN = "proof-or-stop.repro-freeze-state.v1"`. For each artifact,
`contentDigest` is `sha256:` plus SHA-256 of RFC-8785 CANON with `contentDigest` and
`integritySignature` omitted. `integritySignature` is `sha256:` plus SHA-256 of UTF-8
`<domain>\u0000<CANON(object with integritySignature omitted)>`, so it also binds the stored
`contentDigest`. Verification recomputes both. There is no secret/key custody and no signer authentication:
“signed” in this spec means this handler-generated tamper-evident integrity tag, not proof of human/reviewer
identity or resistance to the hostile-local-writer threat excluded by §0.6.

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
  `packages/main/src/core/types.ts`). P1 first computes every raw `targetCandidate` and mechanically assigns
  `targetDisposition:"executable-material|non-executable"` with registered reason codes. Non-executable is
  allowed only when all resolved paths are non-material, no executable runner/P2f target or generated
  executable output is referenced, and no affected process/runtime fact exists; unknowns fail closed as
  executable-material. It then computes the effective executable/material descriptors through
  `resolveExpectedRedTargetDescriptors`: `{ acceptanceTargetRef, sources }`, where sources is a
  UTF-8-byte-sorted, duplicate-free array of exact `{ sourceKind, sourcePointer, contentDigest }` objects;
  sourceKind is `acceptance-binding|verification-intent|milestone|request`, sourcePointer is the canonical
  JSON pointer in the committed PLAN artifact, and contentDigest is §0.4 over the exact referenced subobject.
  `acceptanceSemanticDigest = CANON(descriptor)`.
- **Verification evidence binding** — a P1 classification target carries a receipt-key-sorted discriminated
  array derived from registered verificationIntent plus an exact sorted `requiredEvidenceUnits` array
  selected by plan §7. These bindings are **derived, never authored directly**: their sole admissible input is
  the closed `VerificationIntentItem.reproEvidenceBinding` declaration whose authoring schema, rejection
  rules, association/uniqueness rules, projection, freeze, and acyclic derivation order are normative in plan
  §4.1 and mirrored in §7.3 below. Runner entries are exact
  `{ kind, subtype?, execution:"runner", testCaseRef, adapterId, selector, expectation }`; characterization/manual entries
  are exact `{ kind, subtype?, execution:"p2f-artifact", p2fContractId }`. Selector is a non-empty UTF-8
  literal-line value. P1 validates adapter/testCaseRef or P2f-contract
  compatibility and blocks missing, duplicate, or ambiguous entries. A zero-target docs classification
  instead carries `storyRequiredEvidenceUnits = [{kind:"docs-consistency"}]` and one top-level
  `storyEvidenceBindings` entry
  `{ kind:"docs-consistency", execution:"runner", testCaseRef, adapterId, selector, expectation }`. A receipt command
  cannot add or override a binding.
  Expectation is closed: ordinary/docs uses
  `{ type:"standard", expectedExitClass:"zero", selectorPolarity:"present" }`; concurrency uses
  `{ type:"concurrent", serializationBoundaryId, processCount, outcomeCounts,
  selectorPolarity:"present" }` with processCount >= 2
  and an exit-class-sorted unique array of exact `{ exitClass, min, max }` non-negative bounds satisfying
  min <= max and summed minima <= processCount <= summed maxima; exitClass is exactly
  `zero|nonzero|timeout|signal:<name>` with name from §1.10's closed signal set. P1 introduces
  `serialization-boundary` into ProcessFactKind and registers the production main-write, Story-owner,
  classification/binding/target-chain, and P3b receipt-head boundaries plus their canonical lock identities.
  For each affected registered boundary it emits one unit
  `{ kind:"concurrency", subtype:<serializationBoundaryId> }`; subtype and expectation id are identical.
  Multiple distinct ids produce sorted distinct units; missing, duplicate, caller-authored, or unregistered
  ids reject.
  Performance uses
  `{ type:"benchmark", repetitions, metric:"wall-clock-ns", unit:"ns",
  aggregate:"arithmetic-mean", comparator, thresholdNs, varianceRule, expectedExitClass:"zero",
  selectorPolarity:"present" }` with repetitions >= 2, comparator
  `lt|lte`, canonical unsigned-decimal-string thresholdNs, and exact
  `{ method:"max-relative-spread-ppm", limitPpm }` where limitPpm is an integer in 0..1000000. Unknown
  fields or a type/kind mismatch reject P1.
  Because these bindings are derived from registered `verificationIntent`, the plan's required-intent policy
  is a precondition of this derivation and is restated here so the two documents cannot diverge. Current
  0.3.296 source truth: `resolveVerificationIntentPolicy` in
  `packages/main/src/core/workflow-policy.ts` still returns `policy: 'express-exempt'` for an express-channel
  Story with zero authored intents, and that exemption is the registered `L4` process fact
  `flow-policy:express-verification-policy`. Target rule (plan §4 and §13, owned end to end by P1): obligation
  and required units resolve before policy; `resolveVerificationIntentPolicy` reads the resolved obligation,
  selected units, declared-unit keys, and committed intent count, but no channel. Its closed result is exactly
  `obligation-intent-satisfied|obligation-intent-required|obligation-unresolved`. Any Story of any channel and
  any obligation with a selected unit and zero authored intents is blocked with typed
  `verification-intent-required`; authored intents that leave a selected unit undeclared are blocked
  separately with `evidence-binding-declaration-missing`; unresolved classification remains
  `obligation-unresolved`. No classification, head, binding, freeze, or credential is written on either
  blocker. A mechanically non-executable Story may classify `docsExempt`, which exempts baseline
  RED/characterization only; it still authors the Story-scoped `docs-consistency` intent and declaration, and
  no `express-exempt` disposition exists after P1. Channel, item count, prose, or a caller-authored flag can
  never change the obligation or exempt intent authoring. "Authored" means the intent item **together with
  its §7.3 `reproEvidenceBinding` declaration**, and
  the legacy pin `VerificationIntentItem.verification` (`{ command, selector, narrowings? }`) is never an
  input to any binding here: per plan §4.1 and §7.3, `verification.command` and `verification.selector` are
  inadmissible to repro obligation classification, to every evidence binding, to `commandSpecDigest`, and to
  every P3b run.
- **Frozen scope paths** — the classification top-level `frozenScopePaths` is the normalized,
  UTF-8-byte-sorted, duplicate-free union of every admitted path in the exact scope-contract bytes. Each
  target also carries its normalized `implementationPaths`. Both are P1 fields covered by the immutable
  classification digest; no receipt writer reconstructs or supplies them.
- **Frozen changed-file base** — the classification top-level `storyBaseHead` is the exact commit passed as
  `explicitBaseHead` to `resolveStoryChangedFiles`; it is covered by the immutable classification digest and
  no receipt writer may replace it with a live-main merge base.
- **Classification artifact topology** — the chain is per-Story with one current head, not per-target. The
  exhaustive no-extra-key snapshot/head schemas, inputDigest preimages, classifierDigest preimage,
  targetCandidates dispositions, exact targets, and INIT_CHECK derivation of storyBaseHead are normative in
  program-plan §4; this spec's unique-head, freshness, and fork checks consume that one topology.
- **Frozen policy and governed evolution** — P1 embeds the complete resolved §1.2 policySnapshot and
  `policyDigest = CANON(policySnapshot)`. An independently reviewed policy-surface Story may additionally
  carry exact `policyEvolutionContract = { fromPolicyDigest, toPolicySnapshot, toPolicyDigest,
  changedJsonPointers, verificationPolicy:"frozen-baseline" }`; both snapshots satisfy §1.2/§1.12,
  toPolicyDigest is CANON(toPolicySnapshot), and the sorted unique pointers exactly equal the snapshot diff
  beneath `/redEvidence` — the single normative policy pointer root for this spec and the program plan, per
  plan §4 and the §1.2 statement below. The diff recursively compares object keys; a missing key or unequal
  scalar/array records that member's RFC-6901-escaped JSON Pointer, while unequal objects recurse. At
  post-DEV boundaries ordinary Stories require current policy equal the
  frozen digest; a valid evolution Story requires current config equal the contracted candidate or returns
  `policy-evolution-contract-mismatch`. All evidence for that Story still runs through frozen baseline
  adapters; after merge, new Stories classify under the new policy.
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

W2 does **NOT** resist an attacker with direct write access to `<storyDir>/<id>/red-evidence.json`
who rewrites the file and recomputes every digest offline. Hash chaining without an external trust anchor
detects accidental corruption and casual tampering, not a full offline rewrite. The partial mitigations W2 does
get for free are: (a) the story metadata directory is git-tracked, so offline rewrites appear in `git diff` /
history; (b) the legacy migration manifest is anchored to a commit (§6.2), so legacy membership cannot be
forged after adoption; (c) the gate query surfaces `corrupt-chain` / `fork-detected` errors (§5.6) on any
internally-inconsistent rewrite. **Full offline-rewrite resistance requires cryptographic receipt signing,
which is explicitly fenced to the Tier-C program (§0.3)** — implementation stories MUST NOT claim
tamper-proof storage on W2's behalf.

One further residual is stated for §1.1.3's target linkage: W2 proves that the REGISTERED harness adapter
reported the BOUND test case running with the observed result at the bound tree. A maliciously AUTHORED
registered test — committed into the story tree so that its own body fakes an outcome — is not detectable by
W2. It is caught by story review of the acceptance-material diff, which is exactly where the registered
target binding (§1.1.3) forces such a test to appear: to attack the linkage you must first change the
reviewed binding or the reviewed test file.

> **ASSURANCE TIER (normative scope clause — rev 6 MOVE 2).** W2's defended threat model is **accidental
> fabrication, workflow drift, and casual gaming**: agents that shortcut, misremember, replay, or lightly
> game the workflow through the registered surfaces. A **fully hostile local agent with filesystem and
> toolchain control is EXPLICITLY out of W2's scope** — this section already concedes that adversary can
> rewrite the evidence store directly and recompute every digest, so no amount of runner-side hardening
> against it changes the outcome; end-to-end resistance to that adversary is the Tier-C signed-receipt
> program (§0.3). Consequences drawn under this clause elsewhere in the spec are marked "assurance note
> (§0.6 tier)". Audit findings that require hermetic-sandbox or who-digests-the-digester guarantees are
> resolved AS SCOPED against this clause, never silently dropped: each carries an honest one-line residual
> note at the relevant section. Implementation stories MUST NOT advertise W2 as defending above this tier.

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
        "kind": "literal-line",
        "value": "Error: Cannot find module '/repo/packages/main/dist/tasks/autopilot-resume-smoke.js'",
        "stream": "combined",
        "polarity": "present-in-red"
      }
    ],
    "expectedExitClass": "nonzero",
    "targetExercisedProof": {
      "method": "harness-token",
      "testCaseRef": "npm-script:test:autopilot-resume-smoke",
      "adapterId": "npm-script@1",
      "targetBindingDigest": "sha256:...",
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
   - `kind` ∈ `{ "literal-line", "class" }` — the COMPLETE matcher language (rev 6 MOVE 1: `anchored-regex`
     is REMOVED; five audit rounds proved a prose-specified pattern language is an unbounded gaming surface —
     alternation precedence, quantifier bridges, universal classes, compilation edge cases. An
     implementation story MAY later propose a vetted pattern language as its OWN reviewed decision story;
     until then, no pattern semantics exist anywhere in this subsystem). For `kind: "class"`, `value` IS the
     registry class name: the exact, case-sensitive `name` key of a `policy.matcherClassRegistry` entry
     (§1.2); a `value` naming no registry entry is rejected.
   - `value` — for `literal-line`: the exact expected line text, stored TRIMMED (a value with leading or
     trailing whitespace is rejected). Length in bytes MUST satisfy `1 ≤ len(value) ≤ policy.maxMatcherLen`.
   - `stream` ∈ `{ "stdout", "stderr", "combined" }` — which captured stream the matcher applies to.
   - `polarity` ∈ `{ "present-in-red", "absent-in-green", "present-in-green" }`. At least one matcher MUST have
     `polarity = "present-in-red"` (otherwise the RED assertion is vacuous). Every `present-in-red` matcher is
     also implicitly required `absent-in-green` unless it carries `greenExempt: true`. `present-in-green`
     matchers feed the `pattern-present` conjunct (§1.5).
   - `greenExempt` — OPTIONAL boolean, default `false`; legal ONLY on `polarity: "present-in-red"` matchers
     (any other polarity carrying it is rejected). It is an assertion-subobject field, hence covered by
     `assertionDigest` canonicalization automatically; per §0.4 it is OMITTED when false/absent.
   - Every matcher MUST pass the **minimum-specificity rule** (§1.3) under the **evaluation semantics** of §1.11.
2. **`expectedExitClass`** — the *expected exit class* of the RED run. An enum:
   `"nonzero"` (any non-zero exit; the default RED expectation), `"exit:<n>"` (an exact exit code, `0 < n ≤ 255`),
   or `"timeout-is-failure"` (a timeout counts as the RED failure; runner protocol in §2.3 step 3b). The RED
   run's observed exit MUST be a member of this class or the record is rejected (§1.6, R1-4). The GREEN run's
   exit expectation is fixed at `0` by the GREEN predicate and is not configurable per-envelope.
   Membership is total and ordered: when `timedOut == true`, the observation is a member only of
   `timeout-is-failure`; otherwise an integer `exitCode = n` is a member of `nonzero` iff `n != 0` and of
   `exit:<n>` iff equal; otherwise `exitCode == null` plus a recorded non-timeout `terminationSignal` is a
   member of `nonzero` and of no exact/timeout class. Spawn failure produces no receipt and is a member of no
   class. Thus `null` is never compared with a number or treated via JavaScript truthiness.
   **Linkage compatibility (audit: a timed-out script never "runs to completion", so script-exit linkage is
   unobtainable):** `"timeout-is-failure"` is legal ONLY when the bound adapter's `linkageKind` is
   `reporter-event`; an envelope combining `timeout-is-failure` with a `script-exit` adapter is REJECTED at
   schema time (R1-3). For such RED runs the adapter's linkage signal is the reporter's START event (§1.1.3).
3. **`targetExercisedProof`** — the *target-exercised proof*: how a run proves the named `acceptanceTargetRef`
   was actually exercised (not merely referenced in prose). ONE method, `"harness-token"`, with an optional
   supplementary check (audit note, round 1: `artifact-presence`-standalone and `path-touch` REMOVED — file
   presence proves nothing about execution, and unprivileged macOS file-access tracing is unimplementable.
   Audit note, round 2: token emission is now ADAPTER-OWNED and the target↔test mapping is a registered
   binding — a test that merely prints a token no longer proves anything):
   - **The registered target binding (prerequisite; storage and mutation contract pinned).** Before any RED
     run, the binding `{ acceptanceTargetRef, adapterId, testCaseRef }` MUST be registered, with
     `targetBindingDigest = CANON` of exactly that object. Contract (audit: rev 3 left storage, uniqueness,
     mutation, and lookup-tree undefined):
     - **Storage**: `<storyDir>/<id>/red-target-bindings.json`, schema
       `proofstory.red_target_bindings.v1`:
       `{ schemaVersion, storyId, bindings: [ { acceptanceTargetRef, adapterId, testCaseRef, createdAt } ],
       createdAt, updatedAt }`. Exactly ONE binding per `acceptanceTargetRef`; a write while the binding is
       frozen is rejected. A legal pre-freeze EMPTY/quarantine-head rebind atomically replaces the existing array entry
       rather than appending a duplicate, so uniqueness is preserved. **Digest scope (audit: stored entries carry `createdAt`, the digest does not):**
       `targetBindingDigest` is `CANON` over the 3-field subobject
       `{ acceptanceTargetRef, adapterId, testCaseRef }` ONLY — every validator MUST strip `createdAt` (and
       any other storage metadata) from a stored entry before canonicalizing for digest comparison.
     - **Mutation**: only via the registered, lease-gated command
       `red_evidence_binding_set(storyId, acceptanceTargetRef, adapterId, testCaseRef)` (§4.1 gating).
       Before PLAN→DEV freezes the target's P1 classification head, setting a binding is legal while the
       target's chain is EMPTY or its head is a `quarantine` record. After that freeze, the binding is
       immutable even at a quarantine head: quarantine may authorize a replacement assertion/RED only with
       the same binding. A post-freeze binding defect requires a fresh Story/branch; no flag, takeover, or
       emergency field can authorize a live rebind at the frozen baseline.
     - **Single freeze source:** frozen-ness is read only from
       `<storyDir>/<id>/index.json#/reproFreezeState`, never from a field in
       `red-target-bindings.json`. Its exact schema is
       `{ schemaVersion, storyId, storyDir, frozenAtPhase, transitionAttemptId, scopeAdmissionDigest,
       scopeContractDigest, classificationDigest, frozenAtStoryHeadHash, targets, frozenAt, contentDigest,
       integritySignature }`, with `schemaVersion = "proof-or-stop.repro_freeze_state.v1"`,
       `frozenAtPhase = "DEV"`, and §0.4/`REPRO_FREEZE_STATE_INTEGRITY_DOMAIN` integrity. `targets` is sorted
       and unique by `acceptanceTargetRef`; each exact entry is
       `{ acceptanceTargetRef, classificationDigest, targetBindingDigest, baselineHeadHash,
       baselineMaterialHash, acceptanceSemanticDigest }`. It is non-empty for executable obligations and exactly empty for
       `docsExempt`; top-level `classificationDigest` always identifies the Story-level classification and
       every non-empty target entry's `classificationDigest` MUST equal it.
       `transitionAttemptId = CANON({ storyId, storyDir, from:"PLAN", to:"DEV", scopeAdmissionDigest,
       scopeContractDigest, classificationDigest, frozenAtStoryHeadHash, targets })`; `frozenAt` is
       tool-owned ISO-8601 UTC. Only the PLAN→DEV `runStoryTransition` evaluator writes it, in the same atomic
       `index.json` replacement that changes phase to DEV, under the §4.1 global lock order. It is immutable
       thereafter. Existing while phase is PLAN, missing from DEV or later, invalid integrity, duplicate or
       unsorted targets, or disagreement with a target's classification/binding is
       `classification-unverifiable`.
       Every DEV-or-later boundary evaluator reruns `resolveExpectedRedTargetDescriptors` under the transition lock and
       compares the normalized current target-ref set byte-for-byte with
       `reproFreezeState.targets[].acceptanceTargetRef`. Any widening, narrowing, or replacement returns
       `acceptance-target-set-drift-after-freeze`, leaves phase and credentials unchanged, and requires a
       fresh Story/branch. The immutable freeze is not extended, and gate quantification never ignores the
       new target. For an unchanged ref it also recomputes the descriptor digest and compares it with the
       frozen target's `acceptanceSemanticDigest`; changed acceptance/intent/milestone/request or evidence
       binding returns `acceptance-target-semantics-drift-after-freeze` with the same unchanged-phase and
       fresh-Story repair.
       That equality branch applies to non-empty redRequired/characterizationRequired freezes. For an
       empty-target docsExempt freeze, the evaluator reruns the complete P1 candidate classification and
       instead requires obligation docsExempt, every raw candidate still non-executable, and the effective
       executable/material projection still empty; raw documentation refs are not compared with the empty
       freeze array. Any executable/material candidate returns
       `docs-exemption-invalidated-after-freeze`, leaves phase/credentials unchanged, and requires a fresh
       Story with baseline proof.
       Before capture, PLAN→DEV invokes the registered Story-metadata auto-commit for scope contract,
       bindings, classification/head, baseline evidence, and PLAN-review facts under the global locks, then
       requires those paths clean. Failure is `repro-plan-metadata-commit-failed` and writes neither phase nor
       freeze; non-metadata dirt is refused by the existing scope/git gate. Only the resulting committed HEAD
       becomes `frozenAtStoryHeadHash`, and `scopeContractDigest` is read from that Git tree.
       P1f installs this as a shadow writer after its own PLAN→DEV transition. During shadow rollout any
       missing/bootstrap proof is a typed transition-result gap but valid classification/binding/scope inputs
       are still frozen; the artifact attests inputs, not proof sufficiency. P4 maps such a gap to refusal for
       every Story, with no workstream id, caller field, or prose-selectable bypass.
       P1f adoption is its verified local-main merge commit recorded by the existing DONE/post-merge event;
       activation and inventory occur only after P1f is terminal, so the adopting Story cannot self-block.
       At adoption the registered `INIT_CHECK→DEV`/`START` quick path is refused with
       `repro-plan-required`. The adoption scan marks any already-active DEV-or-later Story without the
       subobject `repro-freeze-migration-required`; it cannot advance and must move work to a fresh
       full-lifecycle Story. Its `DEV→PLAN`/`REPLAN` is also refused with the same migration-required code.
       `DEV→PLAN`/`REPLAN` with a valid freeze is refused as `repro-freeze-rollback-refused`, leaving both
       phase and subobject unchanged. `PLAN→INIT`/`REOPEN` remains legal only before freeze; it supersedes
       the old admission/classification/RED for current use and requires the full INIT→INIT_CHECK→PLAN
       sequence again. `REVIEW→DEV` and `TEST→DEV` with a valid freeze retain the byte-identical subobject
       and directly re-evaluate current facts against it; they never create a classification head or baseline
       proof. With no freeze/migration-required state, both refuse `repro-freeze-migration-required`, keep the
       phase unchanged, and require a fresh Story.
       P1f permits only default/explicit `story_create --phase=IDEA|INIT`. It refuses
       `INIT_CHECK|PLAN|DEV|REVIEW|TEST|DONE|DISCARDED`, every compatibility-only phase, and every unknown
       phase value before persistence with `story-create-lifecycle-bypass-forbidden`. There is no
       `historicalImport` exception and no direct-create path can mint a review round, freeze, or credential;
       historical material requires a separately approved non-Story migration surface.
       It refuses legacy `IDEA→PLAN` with `repro-init-required`; an adopted PLAN Story lacking admission must
       REOPEN to INIT. It refuses all `TEST_CASE|TEST_CASE_REVIEW` compatibility transitions as
       `legacy-lifecycle-migration-required`; source phase `META` has no registered transition edge and is
       likewise migration-required by the adoption scan. `story_reconcile` may reconcile registered non-phase metadata
       only; any request containing `phase`, for any known or unknown value, returns
       `story-reconcile-phase-write-forbidden` without phase/credential mutation. Normal transition and
       discard evaluators own every phase change. Non-purge `story_discard`
       alone may write DISCARDED through its owner/transition-locked discard evaluator, preserving
       evidence/freeze, invalidating current credentials, and never representing success. P1f
       unconditionally refuses `story_discard --purge` as
       `story-purge-evidence-destruction-forbidden`; the handler cannot delete `<storyDir>/<id>` or invoke
       `purgeSafeInitCommit`, including for frozen, migration-required, or v2-bearing Stories.
     - **Lookup tree (the anti-swap rule)**: the RUNNER reads the binding from the COMMITTED tree it
       materializes — `<RUN-HEAD>:<storyDir>/<id>/red-target-bindings.json` (§2.3 step 1) —
       never from the live story directory. An uncommitted or post-review edit is therefore invisible to the
       run; the binding that authorizes a run is always part of the committed, reviewable tree the run
       exercises. A green-confirm's tree MUST carry a binding whose `CANON` digest equals the red-assert's
       `targetBindingDigest`, else the green run is rejected.
     The assertion's `adapterId`/`testCaseRef` MUST equal that committed binding for its
     `acceptanceTargetRef`, and `targetBindingDigest` MUST recompute — a run against an unregistered or
     mismatched binding is rejected (§1.6, R1-6). This closes the "commit a fresh script that matches the
     pattern" attack: a NEW testCaseRef is unusable until the reviewed, committed binding names it. (Adapted
     from the round-2 prescription of a policy-global registry: acceptance-target ids are story-scoped, so
     story metadata — not global policy — is the registration surface; digest binding, rejection rule, and
     committed-snapshot lookup are as prescribed.)
     **P3b distinction (`R1-6V`)**: the adapterId/testCaseRef equality conjunct of R1-6 applies only to v2
     red-assert/green-confirm records. A target-scoped P3b verification receipt instead MUST (a) resolve the
     committed target binding at RUN-HEAD and recompute the stored targetBindingDigest for the same
     acceptanceTargetRef, (b) derive adapterId/testCaseRef/selector from the immutable per-unit
     evidenceBinding and recompute evidenceBindingDigest, and (c) observe the acceptanceTargetRef token from
     that evidence test. The target binding and evidence binding may name different commands; neither may be
     caller-supplied. Missing/mismatched (a)-(c) rejects. This is a replacement equality rule, not a waiver.
   - **`"harness-token"` (the required method, adapter-owned emission).** The RUNNER — never the caller —
     derives the argv from the adapter's template (§2.3 step 0); caller-supplied free shell text is never
     executed. At run time the runner generates a fresh random 128-bit hex **nonce** and exports it as
     `PROOF_OR_STOP_RED_RUN_NONCE`. The token `EXERCISED:<acceptanceTargetRef>:<nonce>` is EMITTED BY THE ADAPTER
     into the run receipt (`runReceipt.tokenValue`), NEVER scanned from command output; a token-shaped string
     in stdout/stderr is ignored. The adapter emits it only after observing its **linkage signal**, per the
     adapter's declared `linkageKind` (§1.2):
     - `reporter-event` — the adapter runs the harness with its structured reporter (e.g. TAP,
       `node --test` reporter, jest JSON) and emits the token only upon observing the completion event of the
       test id named by `testCaseRef`. EXCEPTION for `expectedExitClass: "timeout-is-failure"` RED runs
       (§1.1.2): the completion event cannot exist, so the linkage signal is the reporter's START event for
       `testCaseRef` — the bound test provably began before the timeout; the receipt records
       `linkageSignal: "start-event"` (all other runs record `"completion-event"` or `"script-exit"`).
       (Parsing a test-reporter protocol is not a language parser and stays inside the §0.3 fence.)
     - `script-exit` — coarse whole-script linkage: the adapter emits the token when the registered script
       ran to completion. Permitted, but the receipt records `linkageKind: "script-exit"` so W3 policy can
       weight the coarser evidence.
     The run receipt (§2.3) binds `adapterId`, resolved argv, cwd, environment projection, the nonce, the
     token, and `linkageKind`. Adapter linkage is checked at RED time and at GREEN time; it yields the
     `target-exists` sub-predicate (§1.5). Residual threat scope in §0.6 (a maliciously authored registered
     test is a review-caught, not W2-caught, attack).
   - **`supplementaryArtifact` (optional, never standalone).** Names a repo-relative `targetArtifactRef` and an
     `expectation` ∈ `{ "present", "absent-in-red-present-in-green", "absent" }`, checked against the
     disposable workspace at RED and GREEN time. It strengthens `target-exists` (both adapter linkage AND
     artifact expectation must hold when declared) but can never substitute for the adapter linkage.
     **Path validation (audit: "repo-relative" alone permits traversal/symlink escape, and a plain
     `realpath` cannot classify a MISSING path):** `targetArtifactRef` MUST be slash-normalized and
     relative — an absolute path, an empty segment, a `.` or `..` segment, or a backslash rejects at
     envelope schema time (R1-3). At observation time the runner walks the path COMPONENT BY COMPONENT from
     the workspace root: each existing component is `lstat`ed; a symlink component is `realpath`-resolved
     and MUST remain inside the workspace root (any escape ⇒ observation `"escape-rejected"`); the FIRST
     missing component classifies the observation as `"absent"`; if every component exists the observation
     is `"present"`. The CLOSED observation enum is `{ "present", "absent", "escape-rejected" }` — nothing
     else may be recorded. Truth table for `target-exists` (artifact part): expectation `present` requires
     `present` at RED and at GREEN; `absent` requires `absent` at both; `absent-in-red-present-in-green`
     requires `absent` at RED and `present` at GREEN; `escape-rejected` satisfies NO expectation, ever.
     Host files can never satisfy an artifact expectation.
   A record whose `targetExercisedProof` is absent, or whose adapter did not observe the bound linkage signal
   during the run, is **rejected** (§1.6, R1-1).
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
| `policy.minMatcherLen` | min `literal-line` value length (§1.3) | 8 |
| `policy.minMatcherEntropyBits` | min total Shannon entropy of `value` (§1.3 formula) | 24 |
| `policy.runTimeoutMs` | per-run wall clock ceiling (§2) | 600000 |
| `policy.prepTimeoutMs` | wall clock ceiling for EACH §2.3 step-2 preparation command (same SIGTERM→grace→SIGKILL discipline as step 3b; prep timeout aborts the run, no record) | 900000 |
| `policy.killGraceMs` | SIGTERM→SIGKILL grace on timeout (§2.3) | 5000 |
| `policy.forbiddenCatchAlls` | rejected catch-all patterns (blocklist layer of §1.3) | `.*`, `.+`, `.`, `^$`, `^.*$`, `^.+$`, `\s*`, `""` |
| `policy.invarianceExcludePaths` | globs excluded from the `gitStatus` digest (§2.1) | `node_modules/**`, `**/.cache/**`, `**/*.tsbuildinfo`, `**/__pycache__/**`, `**/.pytest_cache/**`, `coverage/**`, `tmp/**`, `**/.DS_Store` |
| `policy.matcherClassRegistry` | named classes: `{ name, predicateKind, param? }` — discriminated schemas: `exit-code-in` REQUIRES `param` = non-empty array of unique integers in `0..255` and the matcher's `stream` MUST be `"combined"` (exit classes consult no stream; any other declared stream rejects); `stream-nonempty` / `stream-empty` FORBID `param` (present ⇒ config-load reject) and consume the matcher's declared stream | `nonzero-exit` (= exit-code-in `[1..255]`), `stderr-nonempty` |
| `policy.runnerAdapterRegistry` | adapters (schema below) | `npm-script@1` (script-exit), `node-test@1` (reporter-event) |
| `policy.runnerProfileRegistry` | runner profiles (schema below) | `node-npm@1` |

**Adapter and profile schemas + command-resolution algorithm (audit: rev 3 used these without pinning
them):**

- **Profile**: `{ runnerProfileId (unique registry key), prepCommands: [ [argv...] ... ] (each an argv
  ARRAY executed directly with NO shell), allowedEnvKeys: [names], cwd (repo-relative, applies to
  prepCommands), submodules: boolean, toolchain?: { "<argv0>": { absolutePath, sha256 } } }` — a
  `toolchain.absolutePath` MUST be absolute and resolve (symlinks followed) to a regular, executable file
  before digesting. `runnerProfileDigest = CANON(profile object)`.
- **Adapter**: `{ adapterId (unique registry key), runnerProfileId (the profile this adapter selects — the
  caller never chooses a profile), testCaseRefPattern (an anchored ECMAScript regex compiled
  `new RegExp(pattern, "u")` with NAMED capture groups — CONFIG-SIDE ONLY: this registry field is reviewed
  material and is NOT part of the matcher language, which after rev 6 MOVE 1 contains no patterns),
  argvTemplate: [tokens], allowedEnvKeys: [names], cwd (repo-relative, applies to the exercised command —
  adapter `cwd` governs the run; profile `cwd` governs prep), linkageKind ∈ {reporter-event, script-exit} }`.
  `adapterDigest = CANON(adapter object)` (recorded in the receipt).
- **argv resolution**: match `testCaseRef` against `testCaseRefPattern`; no match → reject (R1-5). Each
  `argvTemplate` token is EITHER a literal string OR exactly `${<captureName>}` (the only placeholder form —
  no partial-token interpolation); a placeholder substitutes the named capture's full value VERBATIM as one
  argv element (argv arrays, no shell, hence no quoting/escaping rules); a placeholder naming a capture the
  pattern lacks fails CLOSED at config load.
- **Environment resolution**: `envProjection` = every key in `adapter.allowedEnvKeys ∪
  profile.allowedEnvKeys` that is SET in the runner's own environment, mapped to its value (an unset listed
  key is simply absent — never an error, never an empty string), PLUS the runner-injected
  `PROOF_OR_STOP_RED_RUN_NONCE` and the runner-set pinned `PATH` (below). Nothing else reaches the child
  environment. Preparation commands (§2.3 step 2) receive the SAME projection MINUS the nonce.
- **Forbidden environment keys (HARD, language-neutral — audit: an allowlisted `NODE_OPTIONS` or
  `LD_PRELOAD` lets the host inject code and manufacture reporter events without touching the committed
  tree):** no allowlist may contain, and the runner never propagates: `PATH`, `LD_PRELOAD`,
  `LD_LIBRARY_PATH`, any `DYLD_`-prefixed key, `NODE_OPTIONS`, `NODE_PATH`, `PYTHONPATH`, `PYTHONSTARTUP`,
  `PYTHONHOME`, `RUBYOPT`, `RUBYLIB`, `PERL5OPT`, `PERL5LIB`, `BASH_ENV`, `ENV`, `ZDOTDIR`,
  `JAVA_TOOL_OPTIONS`, `GIT_EXEC_PATH`. An allowlist naming any of them fails CLOSED at config load
  (§1.12). This set is a SPEC constant; policy may extend it, never shrink it.
- **Executable resolution (pinned)**: the runner SETS the child `PATH` to `policy.pinnedPath` (an ordered
  list of absolute directories; a relative entry fails config load) and resolves `argv[0]` against it to an
  absolute real path recorded in the receipt as `resolvedExecutable`. A profile MAY pin a digest-bound
  toolchain: `toolchain: { "<argv0>": { "absolutePath", "sha256" } }` — when pinned, the resolved real path
  MUST equal `absolutePath` and the executable file's SHA-256 MUST match, else the run ABORTS with no
  record. Unsafe keys reject at config load; unsafe resolved executable identity rejects at run time.
  **Assurance note (§0.6 tier):** the pinned PATH + forbidden-key set + recorded `resolvedExecutable` are
  the PRACTICAL tier; the digest-bound toolchain stays OPTIONAL. The named residual: an adversary who can
  replace binaries inside `pinnedPath` directories defeats the optional digest only if it is unpinned — but
  that adversary has filesystem control and is outside W2's tier (they can rewrite the evidence store
  directly); mandatory whole-toolchain digesting would only move the question to who digests the digester
  (Tier-C's job).

**The exhaustive `policySnapshot` schema (audit: "complete resolved policy object" must not require design
choices):** the resolved policy object contains EXACTLY these keys, no more, no fewer — `maxMatchers`,
`maxMatcherLen`, `minMatcherLen`, `minMatcherEntropyBits`, `runTimeoutMs`, `prepTimeoutMs`, `killGraceMs`,
`forbiddenCatchAlls`, `forbiddenEnvKeysExtensions` (project additions to the §1.2 hard set; may be empty),
`invarianceExcludePaths`, `pinnedPath`, `matcherClassRegistry`, `runnerAdapterRegistry`,
`runnerProfileRegistry` (profiles embed their optional `toolchain`). The exact project-config location is the
top-level JSON object `proof-or-stop.config.json#/redEvidence`; it is distinct from and shares no keys
with the existing `#/materialCode` block consumed by `resolveMaterialCodePolicy`. An UNKNOWN key inside
`#/redEvidence` REJECTS at config load (fail closed, consistent with the P1 classifier/config contract in
the program plan).
`policyDigest = CANON` over exactly this object.

**Current 0.3.296 source truth for this root (recorded so target design is never read as shipped behavior).**
`#/redEvidence` is already the live namespace: `ProofOrStopConfig.redEvidence` is typed
`RedEvidencePolicyConfig` in `packages/main/src/core/config.ts`, declaring exactly the fourteen keys above
plus an open index signature so an unknown key still reaches the fail-closed resolver rather than being
dropped at parse time; `resolveRedEvidencePolicy` in `packages/main/src/core/red-evidence/policy.ts` resolves
that block into the same exhaustive fourteen-key snapshot (`POLICY_SNAPSHOT_KEYS` in
`packages/main/src/core/red-evidence/registries.ts`) with `pinnedPath` required-and-undefaulted; and it has
live consumers today — `packages/main/src/handlers/red-evidence.ts` reads `loadConfig(root).redEvidence` and
`packages/main/src/handlers/doctor.ts` renders `resolveRedEvidenceDoctorLine(config.redEvidence)`. No
`reproEvidenceV2` key exists in the config type, in the resolver, or in the checked-in
`proof-or-stop.config.json`. Separately, the repository-local `proof-or-stop.config.json` currently populates
**no** `redEvidence` block at all, so the subsystem is presently unconfigured and `pinnedPath` is unset; that
is an unconfigured-but-live namespace, not a missing one. The live fourteen-key set already equals this
section's `policySnapshot` key set, so this revision requires no additional resolver key. What the resolver
does today is diagnostic policy validation and `policyDigest` computation only; it executes nothing, and no
statement here claims that the runner, envelope, or gate consumption is implemented.

**Target disposition (design, not shipped behavior).** The existing `#/redEvidence` namespace **evolves in
place**. There is no alias, no dual-read, no second namespace, no runtime or environment registration path,
and no silent migration of caller configuration; any key the v2 contract later requires is added to
`RedEvidencePolicyConfig` and `resolveRedEvidencePolicy` in place, under the same fail-closed unknown-key rule
and the same required-no-default `pinnedPath`. P0p also owns the initial material population of this
repository's checked-in `#/redEvidence` block before P1: `pinnedPath` is exactly
`["/opt/homebrew/bin","/usr/local/bin","/usr/bin","/bin"]`, and all three registry keys explicitly carry
the canonical matcher, adapter, and profile objects defined below. P0p proves that those ordered directories
resolve `npm` for `node-npm@1` and both `npm` and `node` for the bootstrap adapters on supported validation
hosts; missing resolution fails closed. The config bytes are review-visible, unconditionally material Phase-B
input and are bound into every later policy digest — no environment value or operator-local file substitutes.
Existing populated `#/redEvidence` blocks keep working and are never silently rewritten or relocated by this
program; P0p applies the reviewed compatibility change explicitly. Program plan §12 assigns this
reconciliation and bootstrap population to prerequisite workstream **P0p**; this revision performs its
companion-spec half. If a future reconciliation instead
concludes that a distinct namespace is required, it must arrive through an approved migration Story with its
own compatibility disposition — never by naming a namespace that no resolver reads.

**Per-key default status (audit round 6: exhaustive — every key is either given a complete canonical
default or marked required-no-default; two conforming implementations MUST resolve identical default
snapshots and digests):**

- **Defaulted scalars/sets** (values from the table above): `maxMatchers: 8`, `maxMatcherLen: 512`,
  `minMatcherLen: 8`, `minMatcherEntropyBits: 24`, `runTimeoutMs: 600000`, `prepTimeoutMs: 900000`,
  `killGraceMs: 5000`, `forbiddenCatchAlls` = the §1.2 table set, `invarianceExcludePaths` = the §1.2 table
  set, `forbiddenEnvKeysExtensions: []`.
- **`pinnedPath`: REQUIRED, NO DEFAULT** (host filesystem layouts differ; a silent default would be wrong
  somewhere). A resolved policy missing `pinnedPath` fails CLOSED at config load with diagnostic
  `red_evidence_policy_missing: pinnedPath`; no red-evidence operation can run until it is set.
- **`matcherClassRegistry` default (complete canonical objects):**
  `[ { "name": "nonzero-exit", "predicateKind": "exit-code-in", "param": [1..255] }`
  `, { "name": "stderr-nonempty", "predicateKind": "stream-nonempty" } ]`
  — where `[1..255]` denotes the fully enumerated integer array 1 through 255 (canonicalized enumerated,
  not as a range expression).
- **`runnerProfileRegistry` default (complete canonical object):**
  `[ { "runnerProfileId": "node-npm@1", "prepCommands": [["npm","ci"]],`
  `"allowedEnvKeys": ["HOME","TMPDIR","CI"], "cwd": ".", "submodules": false } ]` (no `toolchain` pinned by
  default).
- **`runnerAdapterRegistry` default (complete canonical objects):**
  `[ { "adapterId": "npm-script@1", "runnerProfileId": "node-npm@1",`
  `"testCaseRefPattern": "^npm-script:(?<script>[A-Za-z0-9:_-]+)$",`
  `"argvTemplate": ["npm", "run", "${script}"], "allowedEnvKeys": [], "cwd": ".",`
  `"linkageKind": "script-exit" }`
  `, { "adapterId": "node-test@1", "runnerProfileId": "node-npm@1",`
  `"testCaseRefPattern": "^node-test:(?<file>[A-Za-z0-9/._-]+)#(?<test>[^#]+)$",`
  `"argvTemplate": ["node", "--test", "--test-reporter", "tap", "--test-name-pattern", "${test}", "${file}"],`
  `"allowedEnvKeys": [], "cwd": ".", "linkageKind": "reporter-event" } ]`

Policy and registry contents live only at `proof-or-stop.config.json#/redEvidence`. Validation has two
ordered phases. Phase A is baseline-independent config load: parse the exact-key schema, resolve defaults,
validate the glob grammar/catch-all rule, and enforce every scalar/registry/environment hard floor. Phase B
is P1 Story/target classification: treat the repository-relative file `proof-or-stop.config.json` as
unconditionally material before applying any configurable path policy, bind its exact content digest, use the
normal P1 material classifier (which never consults `invarianceExcludePaths`) to classify all tracked paths at
that target's named baseline, and reject the P1 snapshot if an exclusion matches any material path. Thus the
config can be loaded before P1, P1 cannot exclude the config that defines it, and the Story-scoped check has a
concrete baseline without recursion. A command with no Story/target context performs Phase A only and cannot
write trusted evidence; every trusted writer requires a successful Phase-B P1 artifact. Every later policy
or registry change changes the P1 digest and surfaces in Story review. All tunables are additionally clamped
by the HARD spec-level floors of §1.12, which no policy value may cross.

**`invarianceExcludePaths` glob language (normative and complete).** Both candidate paths and patterns are
repository-relative POSIX paths: convert `\\` to `/`, reject absolute paths, NUL, empty segments, `.`/`..`
segments, and duplicate `/`. Matching is anchored to the whole normalized path. Split both values on `/`:

- a pattern segment `**` matches zero or more complete path segments;
- within any other pattern segment, `*` matches zero or more characters other than `/`;
- every other character is literal; `?`, bracket classes, braces, extglobs, escaping, and platform-native
  glob behavior do not exist.

Dynamic programming over `(patternSegmentIndex, pathSegmentIndex)` yields the unique result: `**` either
consumes zero segments or one path segment and remains active; an ordinary segment uses the character rule
above and consumes exactly one segment. Both indices must reach the end for a match. Thus `src/**` matches
`src` and its descendants but never `src-old/x`, and `**/*.tsbuildinfo` matches at any depth.

For §1.12, a bare catch-all is any normalized pattern composed only of `**` segments, or of `**` segments
plus exactly one literal `*` segment. Members containing `**` match every valid non-empty relative path;
the lone `*` matches every valid single-segment path. Both forms are forbidden because they erase an entire
path namespace rather than naming bounded runtime artifacts. The Phase-B “must not match tracked material”
check enumerates repository-tracked paths at the target's named P1 baseline, normalizes each by this algorithm,
selects paths the baseline-independent P1 material classifier marks material, and rejects the classification
artifact if any exclusion pattern matches a selected path. The runner and every verifier use this
same algorithm; no host glob library may substitute.

### §1.3 Minimum-specificity rule (quantified)

A `literal-line` matcher is **admissible** only if ALL of the following hold, else it is rejected (rev 6
MOVE 1: with the pattern language removed, a matcher can no longer be "broad" — it matches exactly one line
text — so specificity reduces to two mechanical checks on the literal itself):

1. **Not a degenerate literal.** `value` MUST be stored trimmed (§1.1.1), MUST be non-empty, and MUST NOT be
   a member of `policy.forbiddenCatchAlls` (hygiene blocklist — punctuation-only lines like `.*` are
   rejected as asserted failure text even though they carry no pattern semantics).
2. **Length floor AND entropy floor (conjunction).** The matcher is admissible iff
   `len(value) ≥ policy.minMatcherLen` **AND** `entropyBits(value) ≥ policy.minMatcherEntropyBits`, with
   `entropyBits` as defined in §1.11.4.

`class` matchers are exempt from rule 2 (their breadth is bounded by the policy registry itself) but the
registry MUST only contain classes from the closed `predicateKind` enum of §1.2, AND:

3. **Class matchers are supplementary for RED (audit: a lone `stderr-nonempty` matcher would accept any
   warning byte as the asserted failure).** At least one matcher with `polarity = "present-in-red"` MUST be
   of kind `literal-line` and pass rules 1-2. A `class` matcher can never be the sole `present-in-red`
   evidence; an envelope violating this is REJECTED (R1-2).

### §1.4 GREEN relation and GREEN binding rule (retained, tightened)

The v1 `RedEvidenceRecord.greenRelation` shape in `packages/main/src/core/types.ts` is retained: `targetRef` MUST equal the
record's `acceptanceTargetRef`, and `relation` ∈ `{ same_acceptance, regression_to_green, replacement }`
(`VALID_GREEN_RELATIONS` in `packages/main/src/core/proofstory.ts`).

The binding rule is strengthened over `redEvidenceRecordSatisfied`'s v1 optional-field check,
and the RED-vs-GREEN baseline semantics are operation-specific (audit: rev 2 made every record inherit
`baselineHeadHash`, leaving R2-3 and GREEN-BIND contradictory for green-confirms). A `green-confirm` record
(§3.1, schema §1.10) carries FOUR binding hashes:

- **`redBaselineHeadHash` / `redBaselineMaterialHash`** — copied from the referenced red-assert record
  (`confirmsRecordId`) and VERIFIED equal to that record's `baselineHeadHash`/`baselineMaterialHash` at
  append time (copy-mismatch rejects).
- **`greenHeadHash` / `greenMaterialHash`** — the GREEN run's OWN tree binding, equal by definition to the
  GREEN run receipt's PRE `headHash`/`materialHash` (runner-measured, §2.3; never caller-supplied).

> **GREEN-BIND**: `greenHeadHash` MUST be a strict descendant of `redBaselineHeadHash`
> (mechanically: `git merge-base --is-ancestor <redBaselineHeadHash> <greenHeadHash>` succeeds and the
> hashes differ), AND `greenMaterialHash` MUST differ from `redBaselineMaterialHash` (the fix changed
> material). A green-confirm violating either clause, or whose red-copy fields do not match the referenced
> record, is rejected.

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
- **`target-exists`** — the `targetExercisedProof` (§1.1.3) holds at GREEN time: the adapter observed the
  bound linkage signal for `testCaseRef` and emitted the token `EXERCISED:<targetRef>:<nonce>` (with the
  GREEN run's own nonce) into the receipt, and any declared `supplementaryArtifact` expectation holds. Note
  this also closes the silent-GREEN hole even without `present-in-green` matchers: a run whose harness never
  reported the bound test case yields no adapter linkage.

**Mechanical evaluation (audit: the `!timeout` negation must not be an implementation decision).** Each
conjunct maps to ONE stored transcript boolean whose SATISFIED value is `true` — no stored field is ever
negated at evaluation time:

| Predicate conjunct | Transcript field (§1.10) | Stored value when satisfied | Defined as |
|---|---|---|---|
| `exit0` | `exit0` | `true` | `runReceipt.exitCode === 0` |
| `!timeout` | `notTimedOut` | `true` | `runReceipt.timedOut === false` |
| `pattern-absent` | `patternAbsent` | `true` | no effective green-absence matcher matched |
| `pattern-present` | `patternPresent` | `true` | every `present-in-green` matcher matched (vacuous `true` if none) |
| `target-exists` | `targetExists` | `true` | adapter linkage + declared supplementary artifact hold |

> `GREEN_v2 = exit0 && notTimedOut && patternAbsent && patternPresent && targetExists`
> — mechanically: all five stored transcript booleans are `true`.

A target is **GREEN-satisfying** iff its chain head is a `green-confirm` record (§3.1) whose transcript
satisfies all five conjuncts as above; otherwise the verdict is **RED**. The gate-consumption query (§5)
returns exactly this verdict.

### §1.6 Rejection rules (fabrication is detectable by construction)

The envelope schema REJECTS a record — it is never written — when any of the following holds:

- **R1-1 (missing target-exercised proof).** *A record whose `assertion.targetExercisedProof` is absent,
  whose run's adapter did not observe the bound linkage signal (and therefore never emitted the nonce-bound
  token `EXERCISED:<targetRef>:<nonce>` into the receipt), or whose declared `supplementaryArtifact`
  expectation is not met at run time, is REJECTED.* A RED that cannot prove it exercised the named
  acceptance target cannot satisfy the gate.
- **R1-2 (below-threshold or class-only matcher set).** *A record carrying any matcher that fails the
  minimum-specificity rule of §1.3 — a degenerate/blocklisted literal, one failing the length-AND-entropy
  floor, or a class-only `present-in-red` set (§1.3 rule 3) — is REJECTED.* A vacuous RED cannot satisfy
  the gate.
- **R1-3 (matcher and path bounds — audit: this rule explicitly covers path validation, not only matcher
  bounds).** A record with `0` matchers, more than `policy.maxMatchers`, any matcher `value` longer than
  `policy.maxMatcherLen` or carrying leading/trailing whitespace, a duplicate matcher `id`, an unknown
  matcher `kind`, a `class` value naming no registry entry, or a syntactically invalid
  `supplementaryArtifact.targetArtifactRef` (absolute, empty/`.`/`..` segment, or backslash — §1.1.3), is
  REJECTED.
- **R1-4 (RED not exhibited).** A record whose `present-in-red` matchers did NOT all match the RED run output,
  or whose RED exit is not a member of `expectedExitClass` under §1.1.2's ordered integer/timeout/signal rule,
  is REJECTED (the asserted failure was not actually observed).
- **R1-5 (non-derived command).** A record whose run receipt shows argv not derived from the declared
  `adapterId`'s registered template for the declared `testCaseRef`, or an `adapterId` absent from
  `policy.runnerAdapterRegistry`, is REJECTED. (Closes the `sh -c 'echo ...; exit 7'` fabrication class: the
  caller cannot choose the executable.)
- **R1-6 (unregistered target binding).** A record whose `(adapterId, testCaseRef)` does not equal the
  story's registered target binding for `acceptanceTargetRef`, or whose `targetBindingDigest` does not
  recompute over that registered binding, is REJECTED. (Closes the "commit a fresh pattern-matching script"
  class: an unreviewed testCaseRef cannot carry the proof.)

### §1.7 Worked examples

**VALID envelope (accepted).**

```json
{
  "acceptanceTargetRef": "AB-001",
  "matchers": [
    { "id": "M1", "kind": "literal-line",
      "value": "Error: Cannot find module '/repo/packages/main/dist/tasks/autopilot-resume-smoke.js'",
      "stream": "combined", "polarity": "present-in-red" }
  ],
  "expectedExitClass": "nonzero",
  "targetExercisedProof": {
    "method": "harness-token",
    "testCaseRef": "npm-script:test:autopilot-resume-smoke",
    "adapterId": "npm-script@1",
    "targetBindingDigest": "sha256:...",
    "supplementaryArtifact": {
      "targetArtifactRef": "packages/main/dist/tasks/autopilot-resume-smoke.js",
      "expectation": "absent-in-red-present-in-green"
    }
  }
}
```

Accepted: one `present-in-red` matcher of kind `literal-line` (satisfying §1.3 rule 3) whose trimmed value
exceeds `policy.minMatcherLen` and the entropy floor; exit class `nonzero`; the proof names the
story-registered binding (adapter + test-case ref, digest recomputes), so the runner derives
`npm run test:autopilot-resume-smoke` itself and the adapter emits the nonce token into the receipt on
script completion; the supplementary artifact strengthens the proof.

**INVALID envelope (rejected).**

```json
{
  "acceptanceTargetRef": "AB-001",
  "matchers": [
    { "id": "M1", "kind": "literal-line", "value": "failed",
      "stream": "combined", "polarity": "present-in-red" },
    { "id": "M2", "kind": "class", "value": "stderr-nonempty",
      "stream": "stderr", "polarity": "present-in-red" }
  ],
  "expectedExitClass": "nonzero"
}
```

Rejected three times over: `failed` is 6 bytes < `policy.minMatcherLen` default 8 and below the entropy
floor (§1.3 rule 2 → R1-2); with M1 inadmissible the only surviving `present-in-red` matcher is a `class`
matcher, violating §1.3 rule 3 (R1-2); and `targetExercisedProof` is absent (R1-1). Any one failure alone
rejects the record.

### §1.8 Edge cases (traceable to rules)

- **Matcher matches ZERO lines in the RED output** (vacuous / under-specific pattern). Two sub-cases, each with
  a concrete result: (a) if the matcher fails §1.3, it is rejected at schema time by **R1-2** before any run.
  (b) if the matcher is admissible but simply did not appear in the RED run output, the RED assertion was not
  exhibited and the record is rejected by **R1-4**. In neither case is a zero-matching RED written.
- **Target file DELETED between the RED and GREEN runs** (declared `supplementaryArtifact` with expectation
  `present`, or no adapter linkage because the bound test was deleted). The `target-exists` conjunct
  of §1.5 evaluates FALSE at GREEN time, so no green-confirm can be appended (its receipt fails the
  predicate); the chain head remains the `red-assert` record and the gate query (§5) reports verdict **RED**
  for the target. The existing red-assert record is not rejected retroactively — it is simply never
  GREEN-confirmed until the target is exercised again.

### §1.9 Gate-consumption query contract (summary — full contract in §5)

The subsystem exposes a single **read-only** query for gates: given `storyId` + `acceptanceTargetRef`, it
returns the latest target-chain-head record's status, its GREEN/RED verdict (per §1.5), and its freshness
binding. For an active fresh GREEN it additionally returns the exact §5.1 resolvedEvidence projection that
identifies the underlying green-confirm and governing red-assert records and runner hashes, including through
a recover head; every other success returns null. This is the W2/W3 boundary: **W2 defines and answers the query; W3 wires gates to consume the answer
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
  "reproObligationClassificationDigest": "sha256:...",
  "baselineHeadHash": "<git sha1/sha256 hex — runner-measured, §2.3>",
  "baselineMaterialHash": "sha256:<64-hex — runner-measured, §2.3>",
  "greenRelation": { "targetRef": "AB-001", "relation": "same_acceptance" },
  "assertion": { "«§1.1 envelope, including policyDigest & assertionDigest»": "..." },
  "policySnapshot": { "«complete resolved policy object of §1.2»": "..." },
  "specDigest": "sha256:...",
  "operationKey": "sha256:...",
  "runReceipt": {
    "adapterId": "npm-script@1",
    "adapterDigest": "sha256:...",
    "testCaseRef": "npm-script:test:autopilot-resume-smoke",
    "linkageKind": "script-exit",
    "linkageSignal": "script-exit",
    "argv": ["npm", "run", "test:autopilot-resume-smoke"],
    "cwd": ".",
    "envProjection": { "PROOF_OR_STOP_RED_RUN_NONCE": "<nonce hex>" },
    "runnerProfileId": "node-npm@1",
    "runnerProfileDigest": "sha256:...",
    "exitCode": 1,
    "timedOut": false,
    "stdoutDigest": "sha256:...",
    "stderrDigest": "sha256:...",
    "streamFrames": [
      { "seq": 1, "stream": "stdout", "digest": "sha256:..." },
      { "seq": 2, "stream": "stderr", "digest": "sha256:..." }
    ],
    "resolvedExecutable": "/usr/local/bin/npm",
    "tokenValue": "EXERCISED:AB-001:<nonce hex>",
    "tokenObserved": true,
    "evaluationTranscript": {
      "matcherResults": [
        { "id": "M1", "stream": "combined", "polarity": "present-in-red",
          "matched": true, "matchedLineIndex": 12, "matchedLineDigest": "sha256:..." }
      ],
      "artifactObservations": [
        { "targetArtifactRef": "packages/main/dist/tasks/autopilot-resume-smoke.js",
          "observed": "absent" }
      ],
      "conjuncts": { "exit0": false, "notTimedOut": true, "patternAbsent": false,
                     "patternPresent": true, "targetExists": true }
    },
    "prepMutationAudit": {
      "classifierDigest": "sha256:...",
      "deltaPathDigest": "sha256:...",
      "deltaPathCount": 124,
      "materialDeltaPaths": [],
      "allDeltasNonMaterial": true
    },
    "clean": { "headHash": "<bare git oid>", "materialHash": "sha256:...", "indexState": "<bare git tree oid>", "gitStatus": "sha256:..." },
    "pre":  { "headHash": "<bare git oid>", "materialHash": "sha256:...", "indexState": "<bare git tree oid>", "gitStatus": "sha256:..." },
    "post": { "headHash": "<bare git oid>", "materialHash": "sha256:...", "indexState": "<bare git tree oid>", "gitStatus": "sha256:..." }
  },
  "note": "<optional>",
  "createdAt": "<ISO-8601>",
  "recordDigest": "sha256:..."
}
```

**`prepMutationAudit` is mandatory on every run record.** The trusted runner derives it after preparation by
the §2.3.3(i) algorithm. `classifierDigest` must equal the P1 classifier digest in the governing
classification, `deltaPathDigest` must be a CANON digest, `deltaPathCount` is a non-negative integer,
`materialDeltaPaths` must be an empty array, and `allDeltasNonMaterial` must be true. The summary is
handler-attested at append time and covered by `recordDigest`; query-time validation checks its structure and
bindings, while the disposed workspace means it does not pretend to replay the path scan.

**The evaluation transcript is mandatory on every run record**: one entry per matcher id (all matchers
covered, none extra); `matchedLineIndex`/`matchedLineDigest` present iff `matched: true` AND the matcher's
`kind != "class"` (line digest = SHA-256 of the matched line's bytes; `class` matchers OMIT both fields
regardless of `matched` — they consult streams or exit codes, not lines — audit round 5); one
`artifactObservations` entry per declared supplementary artifact with `observed` from the CLOSED enum of
§1.1.3 (`present` / `absent` / `escape-rejected`); and the five predicate conjunct booleans of the §1.5
mapping table (`notTimedOut`, never a negated field). **Trust scope
(audit: a stream DIGEST cannot prove a claimed matched line occurred in the stream):** the transcript's
content-level truth is established ONCE, inside the trusted append handler, which evaluates matchers against
the raw captured streams it holds at write time. Query-time transcript validation (§5.6 step 5a) is
STRUCTURAL — shape, matcher coverage, boolean/conjunct consistency, digest recomputation — not re-derivation
from stream bytes; this is the §0.6 threat model applied (handler-enforced append consistency; offline
transcript forgery is countered only by the Tier-C program, and implementation stories MUST NOT claim
query-time re-verification of stream content).

**`streamFrames` is MANDATORY on every run receipt (audit round 6: §1.11.3's chunk framing must be
persisted, not implied):** an ordered array of `{ seq, stream, digest }` frames — `seq` the runner-assigned
monotonic chunk sequence (§1.11.3), `stream` ∈ `{ "stdout", "stderr" }`, `digest` = SHA-256 of the chunk's
raw bytes. The frames are the complete canonical representation of the capture: `stdout` is the
concatenation of `stream=="stdout"` frames by `seq`, `stderr` likewise, and `combined` is ALL frames by
`seq` — so all three views (and `stdoutDigest`/`stderrDigest` consistency) are reconstructible from the
framing, with each chunk's bytes bound by its digest under the §1.10 trust scope (content truth is
handler-verified at write time).

**Exit/termination representation (audit: a signaled process has no exit code):** `exitCode` is an integer
OR `null`; optional `terminationSignal` is one of the macOS/Node names
`{ "SIGHUP", "SIGINT", "SIGQUIT", "SIGILL", "SIGTRAP", "SIGABRT", "SIGEMT", "SIGFPE", "SIGKILL",
"SIGBUS", "SIGSEGV", "SIGSYS", "SIGPIPE", "SIGALRM", "SIGTERM", "SIGURG", "SIGSTOP", "SIGTSTP",
"SIGCONT", "SIGCHLD", "SIGTTIN", "SIGTTOU", "SIGIO", "SIGXCPU", "SIGXFSZ", "SIGVTALRM", "SIGPROF",
"SIGWINCH", "SIGINFO", "SIGUSR1", "SIGUSR2" }`. Permitted combinations — normal exit:
integer `exitCode`, no `terminationSignal`; timeout (§2.3.3b): `timedOut: true` and either (a) integer
`exitCode` with no `terminationSignal` when the process traps SIGTERM and exits during the grace window, or
(b) `exitCode: null` with the actual `terminationSignal` when signal-terminated; any other signal death:
`timedOut: false`, `exitCode: null`, `terminationSignal` recorded, run treated
as failed (never `exit0`) and classified only by §1.1.2; spawn failure: no receipt is produced — the run
aborts with no record. A platform signal not in the closed set aborts without a record rather than inventing a
portable name.

For P3b concurrency receipts, the total ordered exitClass projection over these same fields is: timedOut true
→ `timeout`; else integer exitCode 0 → `zero`; else nonzero integer exitCode → `nonzero`; else a present
closed-set terminationSignal → `signal:<name>`; every other combination aborts without a receipt. Exactly one
branch applies, and §7.1 uses this same projection for both processOutcomes and outcomeCounts.

Operation-specific field sets (exhaustive; §0.4 omission rules apply — a field not listed for an operation is
OMITTED, never null):

- `operation: "red-assert"` — the full shape above: chain fields, `storyId`, `acceptanceTargetRef`,
  `trigger`, `observedFailure`, `reproObligationClassificationDigest`, `baselineHeadHash`,
  `baselineMaterialHash`, `greenRelation`, `assertion`,
  `policySnapshot`, `specDigest`, `operationKey`, `runReceipt`, optional `note`, `createdAt`, `recordDigest`.
- `operation: "green-confirm"` — chain fields, `storyId`, `acceptanceTargetRef`, `confirmsRecordId` (the
  red-assert record id), `confirmsRecordDigest` (its `recordDigest`), `confirmsAssertionDigest` (MUST equal
  the red-assert's `assertionDigest` — a green-confirm can only confirm the SAME assertion),
  `redBaselineHeadHash`/`redBaselineMaterialHash` (verified copies, §1.4), `greenHeadHash`/`greenMaterialHash`
  (= its receipt PRE, §1.4), `greenRelation` (copied from the red-assert), `specDigest`, `operationKey`,
  `runReceipt` (the GREEN run's, including its own nonce and transcript), optional `note`, `createdAt`,
  `recordDigest`. It
  carries NO `assertion`/`policySnapshot` of its own — the confirmed assertion is reachable via
  `confirmsRecordId` and pinned by `confirmsAssertionDigest`.
- `operation: "quarantine"` / `"recover"` — chain fields, `storyId`, `acceptanceTargetRef`,
  `recoversRecordId`, `referencedRecordDigest` (the `recordDigest` of the record named by
  `recoversRecordId`), `linkKind` (`"quarantines"` | `"recovers"`), `reason`, `approvedBy` (derived, §4.1),
  `operationKey`, `createdAt`, `recordDigest`. They carry NO `baselineHeadHash`/`baselineMaterialHash`, NO `greenRelation`,
  NO `specDigest`, NO `assertion`/`policySnapshot`/`runReceipt` (audit: rev 2 left these ambiguous — they
  are chain-control records; their idempotency preimage is the control preimage of §3.4, which references
  none of the omitted fields, so omission cannot fork digests).

**Registered CLI surface (full handler contracts in §4.1):** four chain-append entrypoints —
`red_evidence_assert` (red-assert), `red_evidence_green_confirm` (green-confirm), `red_evidence_quarantine`,
`red_evidence_recover` — plus the binding registration `red_evidence_binding_set` (§1.1.3; writes
`red-target-bindings.json`, never chain records). The v1 `red_evidence_create` handler is retired at the
§6.2 adoption point (new v1-schema appends are `unsupported-schema` thereafter, §6.4).

**`specDigest`** is defined exactly as
`CANON({ "acceptanceTargetRef": <record.acceptanceTargetRef>, "greenRelation": { "targetRef": <...>, "relation": <...> } })` —
those keys, that nesting, nothing else.

### §1.11 Matcher evaluation semantics (pinned — zero design decisions)

1. **Literal-line comparison (the entire matching rule — no pattern semantics exist).** A `literal-line`
   matcher *matches* iff at least one line of its declared stream, after trimming leading and trailing
   whitespace per ECMAScript `String.prototype.trim()`, is STRING-EQUAL to `value` (post-decode, code-unit
   equality). Nothing is compiled; there is no dialect, no anchors, no quantifiers.
2. **Byte/unicode treatment**: captured stream bytes are decoded as UTF-8 with invalid sequences replaced by
   U+FFFD. NO unicode normalization (no NFC/NFD) is applied — matching is byte-faithful post-decode.
3. **Framing and `combined` (deterministic, from framed chunks — audit round 5: a single merged pipe cannot
   coexist with separate per-stream capture, so the one-pipe claim is dropped):** stdout and stderr are
   captured on SEPARATE pipes; the runner assigns every read chunk a single monotonically increasing
   sequence number at read time, tagged with its source stream. `combined` is DEFINED as the concatenation
   of all chunks ordered by that sequence number (runner-observed arrival order, fixed once in the receipt
   as `runReceipt.streamFrames`, §1.10); per-stream captures are the same chunks filtered by source. Streams are split into lines on `\n`; a
   trailing `\r` is stripped (CRLF tolerance). `class` matchers: exit-code classes consult `exitCode`;
   stream classes consult the whole captured declared stream.
4. **Entropy formula (exact)**: `entropyBits(value) = len(value) × H`, where `len` is byte length and
   `H = −Σ_b p(b)·log2(p(b))` is the empirical per-byte Shannon entropy over the byte frequency distribution
   `p(b)` of `value`. (Total bits, not per-symbol: a long low-variety string and a short high-variety string
   are both measured honestly.)

### §1.12 Hard safety floors (spec-level, non-tunable)

(Audit: without these, a policy edit could zero out every anti-fabrication floor and the embedded
`policySnapshot` would merely record the bypass.) The following limits are SPEC constants. Policy resolution
MUST clamp-reject: a resolved policy that crosses a Phase-A floor fails CLOSED at config load; the one
Story/target-scoped Phase-B floor is checked while P1 creates/rechecks its artifact. The subsystem refuses to
run when its applicable phase fails; it does not silently clamp.

The program-level gate mode follows the same rule, as a **P4 target rather than current behavior**. From P4
onward `proof-or-stop.config.json#/reproFirstPreflight/mode` accepts exactly `"warn" | "enforce"`; “shadow” is
an internal paired evaluator, not a configuration value. At P4 the non-configurable registered process-fact
constant `REPRO_FIRST_ENFORCEMENT_FLOOR` becomes `"enforce"`; mode resolution rejects an absent or weaker
value with `repro-enforcement-floor-violation`. No policy field can lower that constant. Today, as plan §3
records, `resolveReproFirstPreflightMode` still resolves a live three-value `"off" | "warn" | "enforce"` union
and silently normalizes any absent or unrecognized value to `"warn"` with no config-load error, so this
paragraph describes the closed target surface, not shipped 0.3.296 behavior.

| Hard floor/cap | Value | Rule |
|---|---|---|
| `minMatcherLen` | ≥ 4 | policy may raise, never set below 4 |
| `minMatcherEntropyBits` | ≥ 12 | policy may raise, never set below 12 |
| `maxMatchers` | ≤ 32 | policy may lower, never exceed 32 |
| `maxMatcherLen` | ≤ 4096 | policy may lower, never exceed 4096 |
| `runTimeoutMs` / `prepTimeoutMs` | ≤ 3600000 | never above one hour |
| `forbiddenCatchAlls` | ⊇ the §1.2 default set | policy may extend, never remove a default entry |
| `matcherClassRegistry` | `predicateKind` ∈ closed §1.2 enum only | no free-form predicates, ever |
| `invarianceExcludePaths` | Phase A: MUST NOT contain a bare `**`/`*` catch-all. Phase B: MUST NOT match any tracked path classified material at the target's named P1 baseline | violating globs fail closed at their named phase |
| §1.3 rule 3 | always in force | no policy key can exempt class-only `present-in-red` |
| Forbidden environment keys (§1.2) | ⊇ the §1.2 hard set (`PATH`, `LD_PRELOAD`, `DYLD_*`, `NODE_OPTIONS`, ...) | policy may extend, never shrink; allowlist naming one fails closed |
| `policy.pinnedPath` | absolute directories only | relative entry fails config load; child `PATH` is always runner-set |
| Adapter/profile registration | only via `proof-or-stop.config.json#/redEvidence/runnerAdapterRegistry` and `proof-or-stop.config.json#/redEvidence/runnerProfileRegistry` (P1-bound material policy input) | no runtime/env registration path exists |

---

## §2. Disposable-workspace runner and four-tuple net-state invariance

### §2.1 The four-tuple (measured PRE and POST)

Every RED run and every GREEN run is executed by a runner that captures a **four-tuple** immediately before the
command starts (PRE) and immediately after it exits (POST). The four measured quantities are:

1. **`headHash`** — `git rev-parse HEAD` in the workspace (the checked-out commit).
2. **`materialHash`** — the canonical material digest over the workspace tree at HEAD, computed by the SAME
   function the CLI uses today, with its ACTUAL signature (audit: earlier revisions drifted the parameter
   names): `currentMaterialHash(gitCwd, ref = 'HEAD', metadataRoot = gitCwd)`. The call-site rule is fixed:
   `metadataRoot` is ALWAYS exactly the same canonical realpath as `gitCwd`, never an outer checkout or
   caller-supplied project root. In the disposable runner both are `<tmpdir>` and its checked-out
   `proof-or-stop.config.json` supplies `storyDir`; in P1 and live query both are the canonical Story
   worktree root and that tree's checked-out config supplies `storyDir`
   (`currentGitHead`/`currentMaterialHash` in `packages/main/src/core/evidence-freshness.ts`, consumed by the
   ProofStory handler).
   W2 does not redefine the material hash; it reuses this function verbatim. **Scope caveat (audit):** this
   is a COMMITTED-TREE hash (`git ls-tree` at HEAD) — it never binds dirty worktree bytes. Worktree-content
   equivalence with the committed tree is established separately by the material-dirt-empty check of
   §2.3.3(i)/R2-4, not by this hash.
3. **`indexState`** — EXACTLY the object id printed by `git write-tree` run against the workspace index
   (recorded verbatim, in the repository's git object format). (Audit: rev 2 called this "equivalent" to a
   SHA-256 over `git ls-files --stage -z` — they are NOT equivalent; the write-tree object id is the single
   normative definition.) Captures staged mutations. NOT filtered by any exclusion set — a RED/GREEN command
   has no business touching the index at all.
4. **`gitStatus`** — SHA-256 over the FILTERED, re-serialized output of `git status --porcelain=v1 -z`
   (WITHOUT `--ignored`, so gitignored build artifacts never enter the tuple). Byte-level parse rule (audit:
   "removing lines" is not well-defined for NUL-delimited rename records): split the raw output into entries
   at NUL boundaries, where an entry whose two-letter `XY` code contains `R` or `C` consumes TWO
   NUL-terminated path fields (new path, then original path) and every other entry consumes ONE; paths are
   raw bytes (no encoding assumption). An entry is EXCLUDED iff EVERY path field it carries matches a glob in
   `policy.invarianceExcludePaths` (§1.2); an entry with any non-matching path field is kept — for
   invariance, either side of a rename touching a non-excluded path counts. The kept entries are
   re-serialized in original order with single-NUL termination and hashed. Glob semantics: the same
   segment-aware matching defined completely in §1.2. The exclusion set is part of `policySnapshot`,
   hence digest-bound into the record.

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

0. **Derive the command.** For v2 RED/GREEN, read adapterId/testCaseRef from the registered target binding.
   For a P3b `execution:"runner"` verification receipt, read kind/subtype/adapterId/testCaseRef/selector only from the frozen P1
   target `evidenceBindings` entry or zero-target docs `storyEvidenceBindings` entry; the invocation supplies
   none of them. Resolve `adapterId` in `policy.runnerAdapterRegistry`; match `testCaseRef` against
   the adapter's `testCaseRefPattern`; instantiate `argvTemplate` → argv. No shell interpretation of
   caller-supplied text (R1-5). Resolve the runner profile `runnerProfileId` from policy: an ordered list of
   preparation commands (e.g. `npm ci`, build steps), an environment allowlist (`allowedEnvKeys`), and a
   relative `cwd`. `runnerProfileDigest = CANON(profile)` goes into the receipt.
1. **Create.** `git worktree add --detach <tmpdir> <RUN-HEAD>` where `<tmpdir>` is a fresh directory under
   the OS temp root (`$TMPDIR`) and `<RUN-HEAD>` is operation-specific: for a **red-assert** run, the target's
   exact `baselineHeadHash` from the current pre-freeze or frozen post-freeze
   `ReproObligationClassification`; for a **green-confirm** run, the pre-run CANDIDATE head captured by
   the handler before the dedupe search (§4.1 — the candidate becomes `greenHeadHash`, §1.4; PRE must equal
   it, §2.3.3(ii)); for P3b target-scoped standard/concurrency/candidate-performance evidence and Story-scope
   docs-consistency, the clean committed boundary CANDIDATE head captured by the P3b batch writer; for each
   baseline-performance repetition, the target's exact frozen baselineHeadHash. P2f-backed
   characterization/manual receipts do not invoke this runner. An unknown operation/kind aborts. This is the ONLY materialization
   method. Submodules are initialized iff the profile declares `submodules: true`; symlinks/exec bits
   materialize per git defaults. **Consequence (stated, not implied): the run tree MUST be a committed
   state.** A reproduction test (or fix) that exists only as an uncommitted working-tree file is NOT visible
   to the runner — the owner MUST commit it (story branch) before the run. Uncommitted-file injection into
   the workspace is prohibited: it would break the §2.3.3 binding-equality requirement.
   1b. **Snapshot CLEAN** — capture the four-tuple (§2.1) of the freshly materialized, UNPREPARED tree, and
   record it in the receipt as `runReceipt.clean`. Require `clean.headHash == <RUN-HEAD>`,
   `clean.indexState == git rev-parse <RUN-HEAD>^{tree}` (the mechanical clean-index predicate — audit:
   "a clean index" alone named no comparison tree), and an EMPTY filtered `gitStatus` (a fresh detached
   checkout satisfies all three; any failure aborts — the materialization itself was tampered).
   Before any Story-artifact lookup, resolve `<storyDir>` from this RUN-HEAD config and require equality with
   the current pre-freeze classification value or post-freeze `reproFreezeState.storyDir`; mismatch aborts as
   `story-dir-drift`.
2. **Prepare.** Run the profile's preparation commands inside the workspace (dependency install, build),
   with the §1.2 preparation environment (same projection, no nonce, pinned PATH). EACH preparation command
   is bounded by `policy.prepTimeoutMs` under the same process-group SIGTERM → `killGraceMs` → SIGKILL
   discipline as step 3b; a prep timeout or nonzero prep exit ABORTS the run — no record, workspace
   discarded (step 6). **Preparation MUST preserve the committed acceptance material** (audit: prep ran
   before PRE in rev 4, so a hostile profile could overwrite the bound test and PRE would bless the doctored
   bytes): prep may create or modify ONLY paths the P1 material classifier marks non-material. Gitignore or
   `invarianceExcludePaths` membership is insufficient by itself.
3. **Snapshot PRE** — capture the four-tuple (§2.1). Enforce THREE checks:
   (i) **Prep invariance (R2-4):** first derive the complete prep delta-path set as the bytewise-sorted union
   of unfiltered tracked changes from `git diff --name-only -z`, non-ignored untracked paths from
   `git ls-files --others --exclude-standard -z`, and ignored untracked paths from
   `git ls-files --others --ignored --exclude-standard -z`. Rename/copy pairs contribute both paths; a
   submodule contributes its repository-relative mount path. Evaluate every path with the same P1 material
   classifier and classifier/config digest bound by the target's classification. Any material delta aborts.
   Persist `prepMutationAudit = { classifierDigest, deltaPathDigest, deltaPathCount, materialDeltaPaths,
   allDeltasNonMaterial }`, where `deltaPathDigest` is CANON of the complete normalized sorted path array,
   `materialDeltaPaths` MUST be empty, and `allDeltasNonMaterial` MUST be true. Then require
   `pre.headHash == clean.headHash` AND `pre.indexState ==
   clean.indexState` AND `pre.gitStatus == clean.gitStatus` (audit round 5: full filtered-status equality,
   aligning exactly with step 2's constraint — since CLEAN's filtered status is empty, EVERY path prep
   created or modified must be gitignored or `invarianceExcludePaths`-excluded for tuple equality; a non-excluded untracked
   `build_stamp.txt` fails here, and in particular no tracked MATERIAL path can be dirty, so the worktree
   BYTES of every tracked material path still equal the committed `<RUN-HEAD>` blobs. The separate unfiltered
   prep-delta audit closes the new ignored/excluded material-file channel, so the exercise tree is equivalent
   to the committed RUN-HEAD for acceptance material. This is required precisely because
   `materialHash` is a COMMITTED-tree hash — `git ls-tree` at HEAD — and by itself never binds dirty
   worktree bytes; see §2.1.2.) Any violation → abort, no record.
   (ii) **Binding equality (R2-3), operation-specific:** for a red-assert run, the handler reads the immutable
   signed `<storyDir>/<id>/repro-obligation-classifications/<digest>.json` named by
   `reproObligationClassificationDigest`, verifies its signature, content digest, and freshness,
   resolves the integrity-signed `repro-obligation-classification-head.json`, and reads only
   `index.json#/reproFreezeState` under the shared lock. Before PLAN→DEV has persisted this subobject, the digest MUST be the
   unique current head. After the freeze, it MUST be the exact frozen digest; later current-head replacement
   is forbidden and rechecks only bind new facts to that digest. PLAN→DEV itself first validates a RED
   against the current pre-freeze head, then atomically freezes that same digest/binding before persisting
   DEV. A superseded pre-freeze digest, a non-frozen post-freeze digest, or a broken
   `seq`/`supersedesDigest` chain is stale and rejected. It verifies target membership, requires the record's
   `reproObligationClassificationDigest` to equal the resolved artifact digest, and requires `pre.headHash ==
   classification.targets[target].baselineHeadHash == record.baselineHeadHash` AND `pre.materialHash ==
   classification.targets[target].baselineMaterialHash == record.baselineMaterialHash`; it also requires the
   classification baseline to be an ancestor of the current Story head. Any mismatch aborts with no record.
   For a green-confirm run, PRE MUST equal
   the pre-run CANDIDATE binding (`pre.headHash == candidateHead` AND `pre.materialHash ==
   candidateMaterial`, §4.1 — the story tree moved between key derivation and materialization ⇒ abort and
   retry), and those candidate values ARE the record's `greenHeadHash`/`greenMaterialHash` (§1.4);
   GREEN-BIND is then checked against the referenced red-assert's fields at append time.
   For a P3b target-scoped standard run, the enclosing concurrent run, and every candidate-performance run,
   PRE MUST equal the batch writer's candidateHead/candidateMaterial and those values MUST equal the
   verification receipt's headHash/materialHash. The frozen classification and target binding must validate
   and contain the exact evidenceBindingDigest. For baseline-performance, PRE MUST instead equal the frozen
   target baselineHeadHash/baselineMaterialHash; paired candidate runs obey the preceding branch and both
   sets use identical commandSpecDigest/environmentDigest. For Story-scoped docs, PRE MUST equal
   candidateHead/candidateMaterial and the integrity-valid zero-target classification must contain the exact
   top-level docs evidence binding. Any mismatch aborts with no receipt.
   (iii) For v2 RED/GREEN, full R1-6 resolves against `<RUN-HEAD>`. For target-scoped P3b runs, R1-6V resolves
   both the committed target binding/digest and the frozen per-unit evidence binding/digest; command equality
   is to the evidence binding, not the target binding. Zero-target docs has no target binding and instead verifies the frozen top-level Story
   evidence binding plus the Story-scope token in step 3b. Unknown scope aborts.
   3b. **Exercise.** Spawn argv in its own process group, env = allowlisted projection + `PROOF_OR_STOP_RED_RUN_NONCE`
   (per §1.2, with pinned `PATH` and `resolvedExecutable` checks), cwd = the ADAPTER's `cwd` (audit: rev 4
   said profile cwd here, contradicting §1.2 — adapter cwd governs the exercised command; profile cwd
   governs prep only). The adapter cwd MUST be slash-normalized and relative with no `..`/empty segments,
   and its realpath MUST remain inside the disposable workspace, else config-load reject; the receipt `cwd`
   MUST equal this normalized adapter cwd. Capture stdout and stderr on SEPARATE pipes as sequenced chunk
   frames per §1.11.3, persisted in the receipt as `runReceipt.streamFrames` (§1.10). Wall-clock ceiling
   `policy.runTimeoutMs`. For concurrency, the registered bundled
   `proof-or-stop-race-launcher@1` helper (its exact bytes/digest are a process fact) starts `processCount`
   children in the same disposable workspace without a shell. Each helper writes one READY byte on its
   inherited control pipe, blocks, then on the parent's single GO write calls `execve(resolvedExecutable,
   argv)`; failure to receive every READY or to release every child aborts without a receipt. The shared
   READY is raw byte `0x52`; GO is raw byte `0x47`. `readyTokenDigest` and `releaseTokenDigest` are §0.4
   `sha256:` digests of those exact one-byte preimages, not CANON strings. The shared
   enclosing CLEAN/PRE occurs before launch and POST after every child is reaped. `startBarrierDigest` is
   `CANON({ helperId:"proof-or-stop-race-launcher@1", helperDigest, processCount, readyTokenDigest,
   releaseTokenDigest, serializationBoundaryId })`, where serializationBoundaryId equals the concurrency
   receipt subtype; processReceipts contain per-process frames/exit/target token but no false
   individual PRE/POST claim. A target-scoped run emits the §1.1.3 target token. A docs-consistency run instead
   emits and verifies exact `EXERCISED-STORY:<storyId>:docs-consistency:<nonce>` and records
   `storyScopeExercisedProofDigest = CANON({ storyId, evidenceBindingDigest, tokenValue, tokenObserved })`
   with `tokenObserved = true`; target R1-6 does not apply to this zero-target branch. **On timeout:** SIGTERM the process GROUP, wait `policy.killGraceMs`, SIGKILL the
   group, reap all descendants — THEN CONTINUE to step 4 (audit: rev 1 made every timeout unrecordable, which
   contradicted `timeout-is-failure`; the POST snapshot is taken after group termination).
4. **Snapshot POST** — capture the four-tuple again.
5. **Assert.** Evaluate INVARIANCE (§2.2), the envelope predicates (§1), and for GREEN the full predicate
   (§1.5). P3b standard/docs runs evaluate their frozen selector and kind predicate; concurrency evaluates
   one enclosing CLEAN/PRE/POST plus every process outcome; performance evaluates every baseline/candidate
   repetition and the same-command threshold/variance predicate. A timed-out RED run is recordable iff `expectedExitClass == "timeout-is-failure"` AND POST was
   captured AND INVARIANCE passes; a timed-out GREEN run fails `!timeout` and is never GREEN.
6. **Discard.** `git worktree remove --force <tmpdir>` (fallback `rm -rf`) unconditionally — on success,
   rejection, timeout, or error. The runner MUST register process signal/termination handlers (`SIGINT`,
   `SIGTERM`, uncaught exception) so `<tmpdir>` is force-removed even when the runner process itself dies
   mid-protocol (no orphaned worktrees under `$TMPDIR`). The real story tree is never written to.

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
> **R2-3 (classification/binding-equality rejection).** *A red-assert run whose signed classification digest,
> target baseline, target binding, ancestry, or PRE four-tuple does not satisfy §2.3.3(ii) is aborted; no
> record is written. A green-confirm's `greenHeadHash`/`greenMaterialHash` are BY DEFINITION its receipt PRE values
> (§2.3.3); a green-confirm whose stored green hashes differ from its receipt PRE is rejected.*
>
> **R2-4 (prep-invariance rejection).** *A run whose PRE checks fail §2.3.3(i) — any prep delta path is
> classified material, head or index changed since CLEAN, the filtered `gitStatus` differs from CLEAN, or
> `prepMutationAudit` is missing/inconsistent — is aborted; no record is written. A record omitting the CLEAN
> snapshot is REJECTED.* This covers tracked modifications plus new ignored/excluded material paths;
> preparation cannot place acceptance-material bytes under the exercise through the registered runner.

A runner that silently mutated the tree produces `post != pre` and is rejected; a runner that skipped the
invariance proof omits a snapshot and is rejected; a record claiming a baseline the workspace never had is
rejected. None can produce a satisfying record through the registered surfaces (§0.6).

---

## §3. Supersedes-chain integrity and idempotency key

### §3.1 Chain schema — one chain per acceptance target

`<storyDir>/<id>/red-evidence.json` remains ONE append-only `records[]` array per story (storage
layout unchanged from `RedEvidenceData` in `packages/main/src/core/types.ts`). Logically, the records form
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

**Transition legality (complete table — audit: ordering checks alone let a green-confirm bless a stale RED,
or a red-assert bypass a quarantine invisibly).** Define the **governing red-assert** of a chain as its most
recent `red-assert` record, and the **effective head operation** as the head's operation, except that a
`recover` head's effective operation is that of the record it reinstates (transitively). A new append is
legal iff it appears in this table; anything else is REJECTED:

| Effective head operation | Legal next operations |
|---|---|
| (empty chain) | `red-assert` only |
| `red-assert` | `green-confirm` (MUST confirm the governing red-assert: `confirmsRecordId` == its id, `confirmsRecordDigest` == its `recordDigest`, `confirmsAssertionDigest` == its `assertionDigest`); `red-assert` (supersede with a new assertion); `quarantine` |
| `green-confirm` | `red-assert` (re-open/regression); `green-confirm` (RE-confirmation of the SAME governing red-assert at a newer green tree — same `confirmsRecordId` constraint); `quarantine` |
| `quarantine` | `recover` (undo a mistaken quarantine, §4.1); `red-assert` (the DELIBERATE REPLACEMENT rule: a fresh assertion may follow without recovering the quarantined record; after PLAN→DEV freeze it MUST retain the frozen binding and classification, while a pre-freeze replacement may use the atomically rebound binding plus a new current classification that remains current until PLAN→DEV later freezes it) |

A `green-confirm` whose `confirmsRecordId` is not the current governing red-assert — an old, superseded, or
foreign assertion — is REJECTED regardless of chain ordering.

**Target membership is a WRITE-time gate (audit: rev 4 checked it only in one query clause, so hosts could
disagree and topology changes could retroactively corrupt valid chains):** every mutating operation —
`red_evidence_binding_set` and all four appends — REQUIRES `acceptanceTargetRef ∈ expectedRedTargets`
(§0.5) at write time. Membership is NOT re-checked at query time: a chain whose target was later removed
from the story topology remains fully queryable (records are historical facts and do not rot into
`corrupt-chain`); what an answer for a since-removed target MEANS for enforcement is W3 policy (§5.5).

### §3.4 Idempotency key (every component enumerated; recordId is deterministic)

**Deterministic record id via the logical operation key (audit round 1: random ids defeated dedupe; round
2: one universal preimage was unimplementable; round 4: `priorRecordDigest` inside the preimage meant a
retry AFTER a successful append derived a NEW key — the head had changed — and appended again, so "retries
collide by construction" was false exactly where retries occur).** Logical request identity is SEPARATED
from chain placement: the **operation key** contains NO `priorRecordDigest`; `priorRecordDigest`/`seq`
remain record fields covered by `recordDigest` and enforced by the §3.3 append-time chain checks:

> `red-assert`:    `operationKey = CANON({ operation, storyId, acceptanceTargetRef,
>                   reproObligationClassificationDigest, baselineHeadHash, baselineMaterialHash,
>                   targetBindingDigest: assertion.targetExercisedProof.targetBindingDigest,
>                   specDigest, assertionDigest, policyDigest })`
> `green-confirm`: `operationKey = CANON({ operation, storyId, acceptanceTargetRef, greenHeadHash,
>                   greenMaterialHash, confirmsRecordDigest, confirmsAssertionDigest, specDigest })`
> `quarantine`/`recover` (control key): `operationKey = CANON({ operation, storyId, acceptanceTargetRef,
>                   recoversRecordId, referencedRecordDigest, normalizedReason })` —
>                   `normalizedReason` = `reason` trimmed with internal whitespace runs collapsed to single
>                   spaces. `approvedBy` is DELIBERATELY excluded (audit round 5: session identity in the
>                   key broke cross-host/cross-session retry dedupe — a replacement session retrying a lost
>                   response derived a fresh key and hit a transition rejection); it stays on the record,
>                   covered by `recordDigest`.
>
> Every v2 record STORES its `operationKey`. `recordId = <OP> + "-" + first12hex(operationKey) + "-" + seq`,
> with `<OP>` ∈ `{RED, GRN, QUA, REC}` per operation (`seq` is assigned at append, after dedupe).

A retry of the same logical operation — whatever the chain head now is — reproduces the identical
`operationKey` and is deduplicated by the §3.5 search. A green-confirm re-run at a NEWER green tree (G2
after G1) produces a DIFFERENT `greenHeadHash`, hence a different key — a legal re-confirmation append
(§3.3 table), never a false conflict.

The **idempotency key** of a candidate RUN record (red-assert, green-confirm) is the tuple:

> **IDEMPOTENCY-KEY** = ( `recordId`, `materialHash`, `specDigest`, `policyDigest`/`assertionDigest`,
> `freshness-compatible head` )

instantiated per operation:

- **`recordId`** — the derived id above (deterministic, so retries collide by construction).
- **`materialHash`** — red-assert: `baselineMaterialHash` (runner-verified per R2-3); green-confirm:
  `greenMaterialHash` (= receipt PRE).
- **`specDigest`** — as defined in §1.10 (exact subobject pinned).
- **`policyDigest` / `assertionDigest`** — red-assert: the two envelope digests from §1.1.4; green-confirm:
  `confirmsAssertionDigest` (which pins the confirmed envelope, including its policyDigest, §1.1.4).
- **`reproObligationClassificationDigest` / target baseline** — red-assert only: tool-resolved from the signed
  P1 snapshot and included in `operationKey`; no caller override exists.
- **`freshness-compatible head`** — red-assert: `baselineHeadHash`; green-confirm: `greenHeadHash`. Two
  appends are freshness-compatible iff they bind the identical run head. Chain position
  (`priorRecordDigest`/`seq`) is deliberately NOT key material — it is placement data enforced at append
  time by §3.3 (audit round 4). (Bounded staleness applies only to the read-side query, §5.3 — never to
  append dedupe.)

Control records (quarantine/recover) use their control preimage directly as the dedupe key — the
five-component frame above applies to run records, which is where the program's idempotency mandate lives.

### §3.5 Replay-dedup semantics (dedupe vs conflict)

> **DEDUP (pre-run, pre-placement short-circuit):** every operation-key input is known BEFORE any run
> executes and BEFORE the chain head is consulted (audit round 4: dedupe must precede transition
> resolution, or a post-append retry sees a moved head and re-appends; audit round 5: green-confirm key
> inputs come from the handler's PRE-RUN CANDIDATE BINDING of §4.1, captured from the live story tree
> before the search — §2.3.3(ii) then requires runner PRE to equal that candidate). The handler derives
> `operationKey` FIRST and searches the target chain for a record with an EQUAL stored `operationKey`;
> found ⇒ the append
> is a *replay*: the existing record is returned and NO run is executed — no fresh nonce, no second receipt,
> nothing written (same key ⇒ same record). If the found record's stored key fields do NOT recompute to its
> stored `operationKey`/`recordId` (§3.4 derivation broken), the handler refuses with a **CONFLICT error**
> and writes nothing — store corruption surfacing at append time, not a retry. Only after the dedupe search
> does the handler resolve the head, run, and apply the §3.3 chain-integrity checks — so a benign retry
> never appears as a fork.

The run is outside the append mutex. Immediately before running, the handler retains the authoritative
`recordDigest`/`seq` head plus binding and policy digests as its expected snapshot. After the run, it acquires
the canonical per-story/per-target `withMkdirLock`, repeats the dedupe search, re-reads the authoritative head
plus authoritative binding, policy, and current-or-frozen classification-state digests, and compare-and-swaps
them against that snapshot. A matching snapshot permits the
transition check and append inside the short critical section; a moved or illegal head rejects with no append.
This post-run dedupe/CAS step is mandatory even though pre-run dedupe already ran.

### §3.6 Edge cases (traceable to rules)

- **Two records claiming the SAME prior digest (fork attempt).** The first is admitted and becomes the target
  chain head; the second violates §3.3 check 3 (fork rejection) and is **REJECTED**. The chain head remains
  the first record; there is never a second "latest" for a target.
- **Replay with an identical idempotency key.** Per §3.5 DEDUP the derived `operationKey` already exists in
  the target chain (even if the head has since moved), so the handler returns the existing record WITHOUT
  executing a run; `records.length` unchanged. A stored record failing its own key/id recomputation →
  CONFLICT error, chain unchanged, nothing written.

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

### §4.1 The four registered operations (all owner-gated); quarantine/recover semantics

Every chain mutation goes through exactly four **owner-gated registered operations**; together with the
binding registration command `red_evidence_binding_set` (§1.1.3, same gating, writes bindings — never chain
records) they are the complete W2 mutating CLI surface (audit: rev 2 specified quarantine/recover contracts
but left green-confirm's entrypoint undefined). Each chain operation appends a NEW record (never edits or
deletes an existing one):

- **`red_evidence_assert(storyId, acceptanceTargetRef, assertion...)`** — creates a `red-assert` record: the
  handler validates the envelope (§1.1-§1.3, R1-1..R1-6 schema-side), resolves the registered target binding
  (§1.1.3), reads the signed P1 classification and resolves the target baseline (never a caller argument),
  derives the §3.4 red-assert operation key and performs the §3.5 dedupe search FIRST, verifies
  transition legality (§3.3 table), executes the RED run via the runner protocol (§2.3 with `<RUN-HEAD>` =
  the classification-bound `baselineHeadHash`), evaluates R1-4/R2-* against the receipt, and appends. Supersedes the v1
  `red_evidence_create` (retired at adoption, §6).
- **`red_evidence_green_confirm(storyId, acceptanceTargetRef)`** — creates a `green-confirm` record, in
  this ORDER (audit round 5: the key must exist before any run, so the candidate binding is captured
  first): (1) capture the **pre-run candidate binding** from the live story tree — `candidateHead := git
  rev-parse HEAD`, `candidateMaterial := currentMaterialHash(gitCwd, 'HEAD', gitCwd)` followed by the §0.4
  one-time `sha256:` normalization; (2) resolve
  the target chain, identify the **governing red-assert** (§3.3), verify the head's effective operation
  admits `green-confirm` (§3.3 table), and extract `confirmsRecordId` / `confirmsRecordDigest` /
  `confirmsAssertionDigest` and the red-copy fields (`redBaselineHeadHash`/`redBaselineMaterialHash`, §1.4)
  FROM the governing record — none are caller arguments; (3) derive the §3.4 green-confirm operation key
  with `greenHeadHash := candidateHead`, `greenMaterialHash := candidateMaterial` and run the §3.5 dedupe
  search — a replay returns here, BEFORE any run; (4) execute the GREEN run via §2.3 (`<RUN-HEAD>` =
  `candidateHead`), with runner parameters (timeouts, adapters, profiles, exclusion sets) resolved from the
  `policySnapshot` EMBEDDED IN the governing red-assert — never live config (audit: config drift between
  RED and GREEN would silently change execution parameters); only the target-binding lookup reads the
  committed tree; (5) require runner PRE == candidate (§2.3.3(ii)); (6) evaluate the full GREEN predicate
  (§1.5) and GREEN-BIND (§1.4) against the receipt; append. The record's verdict facts live in its
  `evaluationTranscript` (§1.10).
- **`red_evidence_quarantine(storyId, recordId, reason)`** — appends a new record with `operation:
  "quarantine"`, `linkKind: "quarantines"`, `recoversRecordId: <recordId>` (the link back to the record being
  retired), `referencedRecordDigest`, a derived `id` (§3.4 control preimage), and `seq`/`priorRecordDigest`
  continuing the target chain (§3). The quarantine record becomes the new target chain head; the prior record
  is untouched.
- **`red_evidence_recover(storyId, recordId, reason)`** — appends a new record with `operation: "recover"`,
  `linkKind: "recovers"`, `recoversRecordId: <recordId>`, `referencedRecordDigest`, a derived `id`, and
  `seq`/`priorRecordDigest` continuing the target chain. The recover record becomes the new target chain head.

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

**Owner-gated — the concrete, implemented authorization, and its precise strength.** "Owner-gated" in this
spec means exactly **lease-gated**: authorized by holding the story's ACTIVE owner lease under the resolved
actor authority below — no more (audit: the shared gate accepts an argument-driven `--forceTakeover`
override, so W2 cannot and does not claim proof of human presence; a human-presence approval artifact is
outside W2's scope and would be a W3/Tier-C addition). All operations MUST be wired through the two
mechanisms mutating story commands use today:

1. **The story-owner lease gate**: `enforceStoryOwnerLeaseGate` in
   `packages/main/src/cli/ownership-gate.ts`, which acquires/refreshes the per-story `owner-lease.json` via
   `packages/main/src/core/story-owner-lease.ts` and REJECTS the command when another session holds an ACTIVE lease
   (heartbeat-based staleness; `--takeover` transfers only a stale lease; `--forceTakeover` is a deliberate
   human override).
2. **Actor mutation authority**: `resolveAgentMutationAuthority` in
   `packages/main/src/core/agent-dispatch-registry.ts`, which classifies the acting identity — a
   nonblank `PROOF_OR_STOP_AGENT` env identity is authoritative, registered roles follow registry authority, a
   payload identity can never override the dispatched env identity, and conflicting identities fail closed
   (`[agent_dispatch_identity_conflict]`).

**`approvedBy` is DERIVED, never caller text**: the recorded `approvedBy` is the resolved actor from
`resolveAgentMutationAuthority` plus the lease `sessionId` (serialized as `<actor>@<sessionId>`; stored on
the record and covered by `recordDigest` — deliberately NOT part of the §3.4 operation key, so a
replacement session can retry a lost response and dedupe correctly) — a free-form `approvedBy` argument is
not accepted.

The owner lease is identity/ownership authorization, not the append mutex. Every W2 implementation Story MUST
re-establish the live concurrency baseline. RED/GREEN execution occurs outside the mutex; their post-run
authoritative re-read, repeated dedupe, CAS, transition check, and append use the canonical per-target
`withMkdirLock` discipline in `packages/main/src/core/mkdir-lock.ts`. Quarantine/recover use that same lock for
their authoritative read through append. No operation may hold the lock across preparation or target
execution, and no implementation may rely on a historical W0.3 line-number diagnosis.

The program-wide acquisition order, including the transition evaluator and shared-main mutation, is fixed as:
Story transition lock, then main write lock, then per-Story classification lock, then binding-metadata lock, then per-Story
verification-receipt-head lock, then per-Story scope-binding-receipt-head lock, then per-target chain locks in lexicographic
`acceptanceTargetRef` order. A surface may take a suffix/single lock but never acquire leftward after taking a
rightward lock. A lifecycle operation that mutates shared main state takes transition then main; a main-only
operation takes only main. PLAN→DEV takes transition and the complete per-Story suffix without main because it
does not mutate shared main state. This spec's binding-before-chain rule is therefore the same order, not a local exception.
The canonical `withMkdirLock` identities are
`repro-verification-receipt-head:<storyId>` and `repro-scope-binding-receipt-head:<storyId>`, registered as
process facts; writers never construct ad hoc lock paths.

`red_evidence_binding_set` also participates in that per-target chain lock because its EMPTY/quarantine-head
freeze predicate reads chain state. Its fixed lock order is binding-metadata lock first, then the target-chain
lock; it re-reads the chain head and writes the binding before releasing the inner lock. Chain appenders take
the target-chain lock only and read the live binding metadata plus `index.json#/reproFreezeState` digest inside it for CAS; the separate
authoritative binding-content lookup remains the committed-tree lookup at RUN-HEAD required by §1.1.3 and
§5.6 step 5a. No reverse acquisition exists. A real-process
binding-registration/rebinding-versus-append fixture is required in addition to the four chain-operation races.
P3b verification writers take the verification-head lock and any target locks; Story-scope docs takes that
head lock without a target lock. Scope writers take the scope-head lock then target locks. A combined batch
takes verification-head, scope-head, then lexical target locks. Real-process fixtures cover different-key
whole-map lost updates, docs-versus-target serialization, and verification/scope/target no-inversion.

### §4.2 Immutability (no in-place edits, ever)

> **IMMUTABILITY**: no operation ever mutates a field of, or deletes, an already-written record. P1f's
> unconditional registered-surface purge refusal is part of this guarantee. Every state
> change — red-assert, green-confirm, quarantine, recover — is a NEW appended record linked by
> `priorRecordDigest` (chain) and, for quarantine/recover, `recoversRecordId` (operation link).

### §4.3 Retention and freshness boundary

The program claim is deliberately narrow:

> **Canonical receipts preserve only the metadata freshness that their recorded bindings and current
> consumers actually verify. Review-round identity is minted on REVIEW entry, but RED-evidence freshness is
> independent of review-round identity and is governed exclusively by §5.3.**

The stable source anchors are the REVIEW-entry assignment to `story.currentReviewRound` inside
`runStoryTransition` (`packages/main/src/handlers/transition-orchestrator.ts`) and the exported
`currentGitHead`, `currentMaterialHash`, and `currentStoryFilesHash` consumers in
`packages/main/src/core/evidence-freshness.ts`. Line numbers and a historical product version are not part of
the contract. Each implementation Story MUST verify the current symbol behavior instead of trusting this
prose.

W2 therefore commits to exactly two separable facts:

1. REVIEW entry mints a review-round identity; this fact grants no RED-evidence retention by itself.
2. RED-evidence freshness consumes no review-round identity. Cross-round reuse is governed solely by the
   §5.3 hash algorithm and never widens beyond the hashes it actually checks.

The assurance boundary remains §0.6: these bindings detect accidental fabrication, workflow drift, casual
gaming, staleness, and internally inconsistent chains through registered surfaces. They do not resist a
fully hostile local writer with filesystem/toolchain control and MUST NOT be described as Tier-C evidence.

### §4.4 Legacy-record posture (link — full posture in §6)

Existing `<storyDir>/<id>/red-evidence.json` records (schema `proofstory.red_evidence.v1`) predate
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
  "resolvedEvidence": {
    "kind": "v2-green",
    "governingRedAssertRecordId": "RED-...",
    "governingRedAssertRecordDigest": "sha256:...",
    "confirmRecordId": "GRN-...",
    "confirmRecordDigest": "sha256:...",
    "baselineHeadHash": "<hex>",
    "baselineMaterialHash": "sha256:...",
    "confirmHeadHash": "<hex>",
    "confirmMaterialHash": "sha256:..."
  },
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
- **`provenance`** ∈ `{ "v2", "legacy-manifest", "none" }` — whether the answer derives from a v2 chain, a
  manifest-grandfathered legacy record (§6), or no records at all.
- **`resolvedEvidence`** is always present. It is the exact object shown above only when provenance is v2,
  status is active, verdict is GREEN, and freshness.liveMatch is true; otherwise it is JSON null. The object
  has no extra/optional keys. The query derives it after the §5.6 control-record loop: confirmRecordId/digest
  identify the resolved underlying green-confirm even when the physical chain head is a recover record;
  governingRedAssertRecordId/digest identify that confirm's validated governing red-assert; baseline hashes
  are copied from the red-assert runner binding and confirm hashes from the green-confirm runner PRE. No id is
  substituted for a digest and no caller field participates.
- **`freshness`** — the head's bound hashes, the resolution `mode`, `liveMatch`, and the `reason` code from
  the §5.3 algorithm.

**State-specific response variants (audit: rev 2's single shape was unsatisfiable for `none` and silent for
legacy drift):** for `status: "none"` the response carries `chainHeadRecordId: null`,
`provenance: "none"`, `resolvedEvidence: null`, and `freshness: null` (there is no binding to resolve). Every
quarantined, superseded, RED, indeterminate, or legacy success likewise carries `resolvedEvidence: null`.
For a legacy head whose FRESH
run yields `liveMatch: false`, the response is exactly
`{ status: "active", verdict: "indeterminate", provenance: "legacy-manifest", freshness: { ..., liveMatch: false } }`
— freshness mismatch overrides `legacy-unverified` the same way it overrides GREEN/RED (§5.3). Every other
success state carries all fields non-null.

The query is **read-only**: it computes the answer from stored records, the manifest, and the live tree; it
writes nothing.

### §5.2 Answer determinacy

For any `(storyId, acceptanceTargetRef)` the query returns exactly ONE answer (success or tagged error). A W3
implementer wires the gate from this section alone with **zero design decisions**: the gate calls
`redEvidenceGateQuery`, reads `status`/`verdict`/`freshness`/`provenance`/`resolvedEvidence` (or `errorKind`), and maps them to an
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
existing function `currentMaterialHash(gitCwd, ref = 'HEAD', metadataRoot = gitCwd)` (actual signature),
with `metadataRoot` pinned to the identical canonical realpath as `gitCwd` at every call site per §2.1.2,
(`packages/main/src/core/evidence-freshness.ts` — consumed by the ProofStory and transition handlers). W2 does not define a new
material classification; the material set is whatever that function under the P1-bound snapshot policy hashes.
**Shared classifier (audit: `currentMaterialHash` hashes the HEAD tree and does not itself classify
untracked paths; formal-review F-001: the dirty filter binds to the classification the hash ACTUALLY
applies):** the dirty filter uses EXACTLY the material classification `currentMaterialHash` applies today:
the path-based exclusion predicate `isMaterialExcludedPath(path, projectRoot?)` from
`packages/main/src/core/material-path-policy.ts`, applied by `currentMaterialHash`. A path is material for the dirty filter iff `isMaterialExcludedPath` returns
FALSE — the same rule by which the hash includes tree entries; being purely path-based, it classifies ANY
path, tracked or not. The single-shared-predicate requirement is that the step-3 dirty filter MUST call
this SAME function — never a reimplementation and never a different policy (consistent with §2.1.2: W2
reuses the material-hash function verbatim and does not redefine this global freshness primitive). Any
future unification of `isMaterialExcludedPath` with `resolveMaterialCodePolicy`
(`material-code-policy.ts` — today consumed by the review floor / scope-diff / concept validation, NOT by
`currentMaterialHash`) is a SEPARATE reviewed change outside this spec. Untracked paths: classified by the
predicate directly. Renames: BOTH porcelain path fields are tested (either material ⇒ dirty; consistent
with §2.1.4). Submodules: a dirty submodule pointer is dirty iff the submodule's path is material under the
predicate.

**Algorithm** (evaluated at query time against the live story tree):

```
FRESH(head):
  1. liveHead     := git rev-parse HEAD            — on git failure → error "storage-error"
  2. liveMaterial := currentMaterialHash(...)      — on failure → error "storage-error"
  3. dirty        := any porcelain-v1 -z entry (parsed per §2.1.4, both path fields
                     of an R/C entry) names a path with
                     isMaterialExcludedPath(path, metadataRoot) == false
                     (the call passes metadataRoot as the optional projectRoot argument)
                     (the shared classifier above; excluded/ignored paths never count)
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
tree. **PRECEDENCE EXCEPTION (audit round 5): a QUARANTINED head answers `RED` ALWAYS — freshness is
computed and reported informationally but never overrides a quarantined RED to `indeterminate`** (§5.4,
§5.6 step 6). `liveMatch` is true in BOTH the exact-head and the ancestor-plus-unchanged-material cases —
bounded staleness is exactly rule 6, and an implementer setting `liveMatch=false` merely because
`boundHead != liveHead` violates this section.

### §5.4 Edge-state answers (exactly one answer each; status derivation is total)

Status is a total function of the target-chain head's `operation` history (audit: rev 1's `superseded` had no
derivation):

- head absent → `none`;
- head is `red-assert` or `green-confirm` → `active`, EXCEPT the superseded case below;
- head is `quarantine` → `quarantined`;
- head is `recover` → the status the reinstated record would have (its operation re-enters this derivation —
  and, symmetrically, VERDICT derivation follows it too: §5.6 step 6 resolves the verdict record with an
  explicit recursive loop over `recover`/`quarantine` control records until a run record is reached, which
  handles quarantine-of-recover chains of any depth);
- **`superseded`** — the head is a `red-assert` whose prior-digest walk since the most recent `green-confirm`
  of the same chain shows it superseded that green-confirm (i.e. the target WAS green-confirmed, a newer RED
  assertion re-opened it, and no newer green-confirm exists). The old GREEN is superseded and not yet
  replaced.

| Edge state | `status` | `verdict` | Notes |
|---|---|---|---|
| **No records** for the target | `none` | `RED` | `chainHeadRecordId: null`; nothing exists for the target. |
| **Quarantined head** | `quarantined` | `RED` | ALWAYS — quarantine outranks freshness; freshness reported informationally only (§5.3 precedence). |
| **Superseded-but-unreplaced head** | `superseded` | `RED` | Prior GREEN superseded by a newer red-assert; no replacement green-confirm yet. |
| **Freshness-mismatched head** | `active` (or as derived) | `indeterminate` | `freshness.liveMatch: false` with reason ∈ {`dirty-tree`,`ancestry-unverifiable`,`drift`} (§5.3). |

### §5.5 W2/W3 boundary (boxed, with MUST NOT list)

> **╔══════════════════ W2/W3 BOUNDARY ══════════════════╗**
>
> **W2 (this subsystem) exposes ONLY the read-only `redEvidenceGateQuery`. It returns FACTS
> (status + verdict + provenance + freshness + resolved evidence, or a tagged error) and makes NO enforcement decision.**
>
> **MUST NOT (scope fence):**
> - A gate MUST NOT write through the query (it is read-only; there is no write path in this contract).
> - A gate MUST NOT reach into `red-evidence.json` storage or the legacy manifest directly; it consumes only
>   the query answer.
> - The query MUST NOT return a block/allow/pass/fail enforcement decision — only status, verdict,
>   provenance, freshness, resolved evidence, and tagged errors.
> - Mapping the answer to an enforcement outcome (block DEV→REVIEW, warn during shadow rollout, and how
>   `legacy-unverified` and every `errorKind` translate to gate behavior) is the enforcement program's
>   responsibility and MUST live in its wiring, not here. The program plan bounds that mapping; Story age
>   alone never grants an exemption.
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
  3. Filter to records whose `acceptanceTargetRef` exactly equals the requested target; all V1/V2 sets below
     are target-local. DERIVE ERA for those records, then partition without shape inference:
     - a record-local exact schemaVersion wins when present;
     - a versionless record inherits the file envelope's exact schemaVersion;
     - V2 := derived era "proofstory.red_evidence.v2"; V1 := derived era
       "proofstory.red_evidence.v1";
     - an unrecognized present record version, or a versionless record under an
       unrecognized/missing envelope version            → error "unsupported-schema".
     ALL record-shape validation is deferred: a V2-era record failing shape dies
     as "corrupt-chain" in step 5a; a V1-era record proceeds to the full mandatory
     v1 validator in step 7. Era derivation never presumes the record satisfies.
  4. Route (audit: rev 2 sent legacy-only stories into v2 chain validation, where
     v1 records — having no seq/digests — always died as "corrupt-chain"):
       V2 empty AND V1 empty  → ok { status:"none", verdict:"RED",
                                     chainHeadRecordId:null, provenance:"none",
                                     resolvedEvidence:null, freshness:null }
       V2 empty AND V1 nonempty → legacy path (step 7)
       V2 nonempty              → v2 path (step 5); V1 records for the target are
                                  then unreachable through the query (§6.3)
  5. Validate the v2 target chain — TWO mandatory layers (audit: chain-shape checks
     alone let a canonically-hashed but semantically invalid record reach verdicts):
     5a. validateV2Record (each record): operation-specific schema completeness
         (§1.10 field sets); recordDigest recomputes; for `red-assert`, specDigest, policyDigest, and
         assertionDigest each recompute over their pinned subobjects; for `green-confirm`, specDigest
         recomputes and confirmsAssertionDigest equals the referenced red-assert's assertionDigest; control
         records omit all three digests; operationKey
         recomputes over its §3.4 preimage and recordId matches its derivation;
         run records: CLEAN snapshot and `prepMutationAudit` present; the prep audit has valid field shape,
         `classifierDigest` equals the governing classification's classifier digest,
         `materialDeltaPaths == []`, and `allDeltasNonMaterial == true`; AND the three §2.3.3(i)
         prep-invariance equalities hold — pre.headHash == clean.headHash,
         pre.indexState == clean.indexState, pre.gitStatus == clean.gitStatus
         (violation detail "R2-4"); receipt pre==post (R2-1),
         red-assert baseline==receipt PRE and the immutable signed classification artifact addressed by
         `reproObligationClassificationDigest` verifies, belongs to the valid signed classification chain,
         and binds the same target baseline and target-binding digest (R2-3); historical superseded bindings
         remain structurally valid here, while current/frozen-head currency is checked only for the resolved
         verdict record in step 6; the classification is never read from `<baselineHeadHash>` because it is written in a
         later metadata commit, while the target binding and reproduction test are read from the baseline
         committed tree; transcript STRUCTURALLY valid
         (§1.10 trust scope: shape, full matcher coverage, boolean/conjunct
         consistency — not stream re-derivation); binding-digest resolution is
         operation-specific (audit: a green-confirm has no assertion subobject to
         inspect), and every comparison uses the 3-field binding subobject with
         createdAt STRIPPED (§1.1.3 digest scope): red-assert — its assertion's
         targetBindingDigest equals the CANON of the stripped binding stored in
         <baselineHeadHash>:<storyDir>/<id>/red-target-bindings.json;
         green-confirm — the targetBindingDigest is RESOLVED via confirmsRecordId
         from the referenced red-assert's assertion and MUST equal the CANON of
         the stripped binding in
         <greenHeadHash>:<storyDir>/<id>/red-target-bindings.json;
         green-confirm additionally: confirms* fields match the referenced record,
         red-copy fields verified, GREEN-BIND holds; control records:
         referencedRecordDigest matches. (Target membership is a WRITE-time gate,
         §3.3 — deliberately NOT re-checked here.)
     5b. validateTargetChainSemantics (whole chain): priorRecordDigest links resolve;
         seq is 1..n monotonic; every transition legal per the §3.3 table
         (incl. governing-red-assert constraint and §4.1 reference validation).
       any 5a/5b violation                               → error "corrupt-chain"
                                                           (detail = violated rule id,
                                                            e.g. "R2-3", "transition",
                                                            "assertion-digest")
       two heads / duplicated prior-digest consumption   → error "fork-detected"
  6. Resolve the unique head; derive status (§5.4). QUARANTINE PRECEDENCE FIRST
     (audit round 5: the rev-5 loop walked THROUGH an active quarantine and
     silently un-revoked a quarantined GREEN):
       if head.operation == "quarantine":
         verdict := RED  — ALWAYS. Freshness is still computed on the retired
         record's binding and reported INFORMATIONALLY; it never lifts a
         quarantined RED to "indeterminate" (§5.3 precedence).
       else:
         verdictRecord := head
         while verdictRecord.operation == "recover":
           q := chain record with id == verdictRecord.recoversRecordId   // a quarantine
           verdictRecord := chain record with id == q.recoversRecordId   // the reinstated record
           (any dangling reference, or q.operation != "quarantine" → error "corrupt-chain")
         — terminates at a run record: each iteration steps past one
         recover/quarantine PAIR to a strictly earlier record; seq is finite.
         Resolve the governing red-assert's `reproObligationClassificationDigest`
         (for green-confirm via `confirmsRecordId`) and the integrity-signed classification state: before
         PLAN→DEV, compare with the unique current head; from DEV onward, compare with the exact digest in
         `index.json#/reproFreezeState`. If the phase/freeze-subobject combination is impossible → error
         "classification-unverifiable". If the live, baseline, or GREEN config resolves a `storyDir` unequal to the classification/frozen value →
         error "story-dir-drift" with repair kind `migrate-repository-and-start-fresh-story`. If the
         pointer/artifact is missing, unreadable,
         unsigned, digest-invalid, or the classification chain is forked → error
         "classification-unverifiable" with repair kind
         `repair-classification-head-or-reclassify`; this is neither record-chain
         corruption nor supersession. If valid values differ → error "classification-superseded"
         with repair kind `reassert-current-classification`; historical records
         remain valid and the chain is not corrupt.
         verdictRecord is green-confirm → read its evaluationTranscript conjuncts
           (§1.10; structurally validated in 5a) → GREEN iff all five stored
           conjunct booleans are true per the §1.5 mapping table (no negation
           applied), else RED
         verdictRecord is red-assert (incl. superseded status) → RED
         Run FRESH (§5.3) on verdictRecord's binding → may force "indeterminate".
     If and only if final status is active, verdict is GREEN, and freshness.liveMatch is true, derive
     resolvedEvidence exactly as §5.1 from verdictRecord (the underlying green-confirm, even behind a
     recover) plus its validated governing red-assert. Otherwise resolvedEvidence := null.
     Return ok with provenance:"v2".
  7. Legacy path. FIRST validate the manifest itself (audit: rev 3 consumed it
     unvalidated): schema check; manifestDigest recomputes; entries unique on
     (storyId, recordId). A schema/digest/uniqueness violation → error "corrupt-chain". Then load the optional
     disqualification artifact of §6.2: malformed/digest-invalid/mismatched → error "corrupt-chain"; valid and
     matching → error "legacy-manifest-disqualified" with repair kind `reprove-active-targets-v2`.
     Resolve adoptionCommit in repo history. If it is unavailable → error
     "legacy-anchor-unverifiable" with repair kind `fetch-history-or-reprove-v2`;
     this is not misreported as chain corruption and no legacy verdict is emitted.
     The answer record is the target's manifest-member v1 record whose manifest
     entry has the HIGHEST entry index (entry order was fixed at adoption from v1
     storage order, §6.2 — a deterministic ordinal, never an author-controlled
     timestamp).
       V1 records NOT in the manifest                    → error "unsupported-schema"
     Verify the answer record's CANON digest equals the manifest entry's recordDigest;
       mismatch                                          → error "corrupt-chain"
     Run FRESH on the v1 baseline hashes:
       liveMatch → ok { status:"active", verdict:"legacy-unverified",
                        provenance:"legacy-manifest", resolvedEvidence:null }
       !liveMatch → ok { status:"active", verdict:"indeterminate",
                         provenance:"legacy-manifest", resolvedEvidence:null }   (§5.1 variant)
```

**Error taxonomy** (`errorKind` closed enum): `missing-story`, `storage-error`, `corrupt-chain` (with a
`detail` rule id from the 5a/5b lists — stable strings, machine-consumable), `fork-detected`,
`unsupported-schema`, `classification-unverifiable`, `classification-superseded`,
`legacy-anchor-unverifiable`, `legacy-manifest-disqualified`, `story-dir-drift`. W2 assigns NO gate behavior to errors — the enforcement program decides whether each error
blocks, warns, or escalates (§5.5).

---

## §6. Legacy record posture

### §6.1 The one normative decision

> **POSTURE (verbatim, citable):** Existing `proofstory.red_evidence.v1` records are
> **GRANDFATHERED, read-only, via the adoption-time migration manifest (§6.2)**. The file envelope declares
> the evidence era; a versionless record in a v1-declared file is a v1 candidate and MUST pass full mandatory
> v1-field validation. Manifest membership is the sole chronology/lineage criterion for a validated record to
> be grandfathered; it is not a substitute for schema validation. The gate query (§5) answers such a legacy
> record with verdict **`legacy-unverified`** and provenance
> **`legacy-manifest`**; W2 states no opinion on whether that satisfies any gate — the mapping of
> `legacy-unverified` to allow/warn/block is W3 enforcement policy (§5.5). Legacy records are **never
> silently upgraded** to v2 and **never silently invalidated**. Every record created after the adoption point
> MUST be a v2 record with the §1 envelope; a v1-schema record outside the manifest is `unsupported-schema`
> (§5.6) wherever it appears.

**Rationale.** Grandfathering (rather than silently migrating or invalidating) preserves historical records
without upgrading their assurance. Full v1 validation prevents a versionless, malformed, or partially shaped
record from becoming trusted merely because it is old. Manifest membership (rather than any timestamp) is the
only chronology classification an attacker cannot satisfy after the fact (§6.4). And
`legacy-unverified` as a distinct verdict — neither GREEN nor RED, with no W2 "satisfies the gate" claim —
keeps the W2/W3 boundary intact: facts here, policy in W3.

### §6.2 Adoption point and the migration manifest

The **adoption point** is fixed by the program plan's P2a Story, before any trusted RED/GREEN writer lands.
One registered, serialized migration operation both freezes the manifest and disables new
manifest-eligible v1 writes:

1. It enumerates EVERY v1-declared evidence file and candidate v1 record then existing across
   `<storyDir>/*/red-evidence.json`.
   It validates the file envelope and every mandatory v1 field before manifest construction. A blank
   `observedFailure` remains the one legacy-tolerated UNSATISFIED case; it is not quarantined and never becomes
   satisfying. Other malformed envelope/record entries are quarantined non-destructively, reported, and
   excluded from the clean manifest entries. Mixed or illegal schema ordering fails closed.
2. It writes the **legacy migration manifest** — an immutable file
   (`.proof-or-stop/red-evidence-legacy-manifest.json`):
   `{ "schemaVersion": "proofstory.red_evidence.legacy_manifest.v1", "adoptionCommit": "<head sha at adoption>",
   "adoptionTimestamp": "<ISO-8601>", "entries": [ { "storyId", "recordId", "recordDigest" } ... ],
   "manifestDigest": "<CANON(manifest with manifestDigest omitted)>" }` — one entry per grandfathered
   record, `recordDigest` = `CANON` of the v1 record as stored. Entries are unique on `(storyId, recordId)`
   (the migration refuses duplicates) and are ORDERED by each source file's `records[]` storage order at
   adoption — this fixed ordinal is the query's "newest member" tiebreaker (§5.6 step 7), deliberately not
   `createdAt`, which is author-writable.
3. The manifest is committed in P2a; `adoptionCommit` is that commit's parent head. The same serialized
   operation switches `red_evidence_create` to refusal/unsupported output before releasing its write lock.
   The manifest is **append-never**: no operation may add, remove, or edit entries after creation (the
   migration operation refuses to run twice), and no record created after `adoptionCommit` is eligible.

If P2r later proves that admission was over-inclusive or under-inclusive, immutability is preserved by
disqualifying rather than editing the manifest. The registered P2r repair operation writes exactly one
`.proof-or-stop/red-evidence-legacy-manifest-disqualification.json` under the migration lock:
`{ "schemaVersion": "proofstory.red_evidence.legacy_manifest_disqualification.v1", "manifestDigest",
"defectClass": "over-inclusive|under-inclusive|both", "affectedTargets": [...],
"reviewEvidenceDigests": [...], "createdAt", "disqualificationDigest" }`, with no extra keys.
`manifestDigest`, every `reviewEvidenceDigest`, and `disqualificationDigest` use §0.4 form;
`affectedTargets` is a non-empty lexicographically sorted, duplicate-free array of exact
`{ "storyId", "acceptanceTargetRef" }` string objects; `reviewEvidenceDigests` is likewise non-empty,
sorted, and duplicate-free; `createdAt` is tool-owned ISO-8601 UTC. `defectClass` is the displayed closed
enum, and
`disqualificationDigest = CANON` of the object with that field omitted. The operation is idempotent only for
byte-identical content and otherwise refuses a second
write. A valid disqualification matching the active `manifestDigest` makes the entire manifest unusable;
query returns `legacy-manifest-disqualified`. P2a repairs validator/migration code but never reruns or edits
the adoption artifact. Every active target that used an admitted entry, and every omitted target that still
needs proof, must obtain a v2 chain. A malformed, digest-invalid, or mismatched disqualification artifact is
`corrupt-chain`, never ignored.

While any active target relies on the manifest, repository policy forbids rebasing, squashing, amending, or
otherwise making `adoptionCommit` unreachable; validation checks reachability before merge and DONE. A shallow
clone repairs `legacy-anchor-unverifiable` by fetching the anchored history. If history was actually rewritten,
the manifest is never edited or re-anchored: each affected target must obtain a trusted v2 RED/GREEN chain (or
remain blocked), after which the unreachable legacy entry is retained as history but no longer queried.

> **LEGACY-CLASSIFICATION RULE:** a schema-valid v1 record is grandfathered legacy iff `(storyId, recordId)`
> appears in the manifest AND the stored record's `CANON` digest equals the manifest entry's `recordDigest`.
> The file-envelope era and full v1 validator establish schema eligibility; manifest membership establishes
> pre-adoption lineage. `createdAt`, record-local version claims, and any other author-writable field play NO
> role in chronology classification (audit: rev 1 classified by
> `createdAt`, which an attacker with storage access can backdate; manifest membership anchored to a commit
> cannot be forged after adoption without visibly rewriting git history — see §0.6 for the residual threat
> scope).

Before merge, the migration Story MUST scan every real Story evidence artifact and compare the current v1
verdict with the fully validated verdict. It reports the artifact count even when zero records change verdict,
and individually dispositions every non-empty delta. The scan is a registered validation command; silence is
not evidence.

### §6.3 In-flight transition rule (deterministic)

A story mid-lifecycle at the enforce flip whose latest record for a target is a manifest-member v1 record:

- The gate query (§5.6 step 7) answers `status: "active"`, `verdict: "legacy-unverified"`,
  `provenance: "legacy-manifest"`, with freshness computed from the record's baseline hashes.
- What that answer MEANS for the gate is the enforcement program's P3/P4 policy (§5.5), bounded by the program plan's §10 and
  §14 disposition tables. Story age alone is not an exemption. An active executable target must obtain v2
  proof or remain blocked; only a mechanically eligible historical/non-applicable disposition may avoid it.
- A manifest-member record needs no owner intervention merely to remain readable and queryable. To satisfy a
  trusted lifecycle obligation, however, the forward-only path is a v2 `red-assert` and later
  `green-confirm`. Once that same target has a v2 record, the v2 path wins at query time (§5.6 step 4), while the legacy record remains intact
  and unreachable rather than edited.

### §6.4 Downgrade-loophole closure

> **LOOPHOLE-CLOSURE:** legacy status is **manifest membership, fixed at the adoption point** (§6.2). The
> manifest is immutable and anchored to `adoptionCommit`; the migration operation runs exactly once. A record
> created after adoption — whatever `schemaVersion` or `createdAt` it declares — is not in the manifest and
> therefore can NEVER be classified legacy: as v1-schema it is `unsupported-schema` (§5.6 step 7); as v2 it
> must satisfy the full §1 envelope.

The downgrade path is closed on all three edges: (a) a new record cannot be created "as legacy" (not a
manifest member); (b) an existing legacy record cannot be edited to smuggle new content (its digest would no
longer match the manifest entry → `corrupt-chain`, §5.6 step 7); (c) deleting a v2 record to fall back to an
older legacy record is visible and self-defeating — IMMUTABILITY (§4.2), including P1f's unconditional
`story_discard --purge` refusal, forbids deletion through registered
surfaces, and even under §0.6's offline-rewrite threat the v2 chain's absence changes nothing the attacker
wants: the legacy record still answers only `legacy-unverified`, never GREEN.

### §6.5 Candidate-intake boundary

`repro-probe`, `red-green-relation`, and `story-evidence-binding` artifacts belong to the Repro-First intake
workflow. Linking them to a Story does not promote them into this subsystem and cannot satisfy RED, GREEN,
REVIEW, TEST, or DONE. A target crosses the boundary only when a registered trusted v2 writer reruns or
independently verifies the assertion and appends the resulting v2 chain record under §§1-5. The intake
experiment is `docs/requirements/decisions/repro-first-story-intake-experiment.md` ("Repro-First Story Intake
Experiment"), and it remains historical authority for candidate collection; the program plan
(`docs/requirements/decisions/repro-first-gate-enforce-execution-plan.md`, this spec's front-matter
`Program:` pointer) governs lifecycle applicability and may narrow earlier candidate bypass language.

---

## §7. Cross-section acceptance (whole document)

### §7.1 P3b verification/scope receipt integration contract

The P3b gates consume two additional immutable receipt families beside the v2 RED/GREEN query. They do not
alter a v2 chain verdict, and they receive no trust merely from being JSON.

`ReproVerificationReceipt` has schema `proof-or-stop.repro_verification_receipt.v1` and exact fields
`{ schemaVersion, receiptKey, seq, supersedesDigest, storyId, storyDir, scope, kind, subtype?,
acceptanceTargetRef?, classificationDigest, reproFreezeStateDigest, targetBindingDigest?,
evidenceBindingDigest, operationKey, selectorInputDigest, policyDigest, commandSpecDigest?, artifactDigest?,
executionReceipt?, executorIdentity, result, headHash, materialHash, boundaryFilesHash, storyScopeDigest?,
kindEvidence, actor, issuer, createdAt, contentDigest, integritySignature }`. `reproFreezeStateDigest` is
exactly the freeze subobject's contentDigest. One receipt covers exactly one selected `{ kind, subtype }`
unit; subtype is omitted when absent. Target scope requires acceptanceTargetRef/targetBindingDigest. Story
scope is only docs-consistency and omits them. Executor identity is handler-derived exactly as plan §7:
the fixed docs runner, `proof-or-stop-repro-verification-runner@1:<adapterId>:<runnerProfileId>` for target
execution, or the identity bound in a P2f artifact. Result is `pass|fail`; only a fresh pass head satisfies.

The exact kindEvidence shapes are:

- `happy|edge|regression|adversarial|gate-bypass`:
  `{ targetExercisedProofDigest, selectorTranscriptDigest }`;
- `concurrency`: `{ targetExercisedProofDigest, selectorTranscriptDigest, processCount,
  serializationBoundaryId, startBarrierDigest, processOutcomes }`, with integer processCount >= 2 and one
  process-id-sorted unique exact `{ processId, exitClass, resultDigest }` entry per process;
  serializationBoundaryId/processCount equal the frozen expectation and receipt subtype;
- `performance`: `{ targetExercisedProofDigest, baselineRunSetDigest, candidateRunSetDigest,
  sameCommandSpecDigest, environmentDigest, expectationDigest }`, with sameCommandSpecDigest equal to
  commandSpecDigest and expectationDigest equal to CANON of the frozen benchmark expectation;
- `docs-consistency`: `{ storyScopeExercisedProofDigest, scanArtifactDigest,
  documentCheckReceiptDigest }`;
- `characterization-perturbation`: `{ p2fReceiptDigest, protectedPropertyDigest,
  perturbationFailureDigest }`;
- `manual-observation`: `{ p2fReceiptDigest, beforeArtifactDigest, afterArtifactDigest,
  verifierAttestations }`, with verifier-role-sorted unique exact
  `{ verifierRole, verificationActorId, verdict, artifactBindingDigest }` entries and verdict `pass|fail`.
  verificationActorId is issued to an independent P2f verifier in DEV, never a REVIEW round/run id.

Every named digest is §0.4 over the exact runner/verifier-owned object. For standard target runner units,
`targetExercisedProofDigest = CANON({ acceptanceTargetRef, targetBindingDigest, testCaseRef, adapterId,
tokenValue, tokenObserved })` with tokenObserved true, and
`selectorTranscriptDigest = CANON(runReceipt.selectorTranscript)`, where selectorTranscript is exact
`{ selector, stream:"combined", polarity:"present", matched, matchedLineIndex?, matchedLineDigest?,
exitZero, notTimedOut, tokenObserved }`; line fields are present iff matched and follow §1.10's line rules.
Concurrency uses CANON of the process-id-sorted array of the proof preimage plus each processId, and
selectorTranscriptDigest is CANON of `{processId,selectorTranscript}` entries; performance uses CANON of
exact `{ baseline:[{runIndex,proofDigest},...], candidate:[{runIndex,proofDigest},...] }`, arrays in
contiguous runIndex order, where each proofDigest is CANON of
`{ acceptanceTargetRef, targetBindingDigest, testCaseRef, adapterId, tokenValue, tokenObserved }`. For docs,
`documentCheckReceiptDigest = CANON(runReceipt)` and
`scanArtifactDigest = CANON({ scannedPaths, executableFindings, configFindings, generatorFindings })`; arrays
are path-sorted and findings are exact `{ path, lineDigest, outcome }` with outcome `pass|fail`.
Extra/unknown discriminants reject.
Formal docs/concept review and TEST validation are separate later lifecycle facts.

No receipt invocation supplies a command. The writer looks up the kind/subtype entry in the frozen target's
`evidenceBindings` or zero-target `storyEvidenceBindings` and verifies
`evidenceBindingDigest = CANON(binding)`. For `execution:"runner"` it resolves adapter/profile through the
full policySnapshot embedded in the frozen classification, verifies its CANON equals policyDigest, and
writes that value as receipt policyDigest. It never derives a command from live config; a candidate policy
change is checked separately against the exact policyEvolutionContract. It then
derives argv. `commandSpecDigest = CANON({ evidenceBindingDigest, adapterId, adapterDigest,
runnerProfileId, runnerProfileDigest, testCaseRef, resolvedExecutable, argv, cwd, selector })`; selector is
the non-empty literal in that frozen binding. For `execution:"p2f-artifact"` it verifies the approved
p2fContractId/artifact digest and derives no command. No field is caller-authored and no shell string is accepted.
The writer likewise never reads `VerificationIntentItem.verification`: per plan §4.1/§7 and §7.3 below,
neither that legacy pin's `command` nor its `selector` is an admissible input to any evidence binding, to
`commandSpecDigest`, or to any receipt, and offering one is rejected rather than resolved. Repro argv comes
only from adapter-template resolution against the registered `testCaseRef` under the frozen policy snapshot,
and the repro selector only from the frozen `reproEvidenceBinding.selector`; this extends R1-5 to every
executable verification receipt rather than weakening it.

`P3bRunReceipt` is exact
`{ adapterId, adapterDigest, testCaseRef, linkageKind, linkageSignal, argv, cwd, envProjection,
runnerProfileId, runnerProfileDigest, exitCode, terminationSignal?, timedOut, stdoutDigest, stderrDigest,
streamFrames, resolvedExecutable, tokenValue, tokenObserved, selectorTranscript, prepMutationAudit, clean,
pre, post }`; unlike a v2 assertion run it uses selectorTranscript, not evaluationTranscript.
executionReceipt is kind-discriminated: ordinary target/docs is
`{ type:"standard", runReceipt:P3bRunReceipt }`;
concurrency is `{ type:"concurrent", commandBinding, clean, pre, post, prepMutationAudit, barrierReceipt,
processReceipts }`, where commandBinding is exact
`{ evidenceBindingDigest, adapterId, adapterDigest, runnerProfileId, runnerProfileDigest, testCaseRef,
resolvedExecutable, argv, cwd, selector }`, `commandSpecDigest = CANON(commandBinding)`, and every child
executes that byte-identical resolvedExecutable/argv/cwd without caller substitution. The exact barrierReceipt is `{ helperId, helperDigest, readyTokenDigest,
releaseTokenDigest }` and process-id-sorted exact process receipts
`{ processId, exitCode, terminationSignal?, timedOut, streamFrames, stdoutDigest, stderrDigest, tokenValue,
tokenObserved, selectorObserved, selectorTranscript, resultDigest }`; selectorObserved equals
selectorTranscript.matched; resultDigest is CANON with itself omitted and exit/signal
combinations follow §1.10. One workspace/PRE/POST encloses all real OS processes. Performance is
`{ type:"benchmark", environment, baselineRuns, candidateRuns }`, with exact environment
`{ adapterDigest, runnerProfileDigest, resolvedExecutable, executableSha256, stableEnvProjection, cwd, platform,
arch }` and environmentDigest = CANON(environment). Each array has exactly repetitions ordered exact
`{ runIndex, runReceipt:P3bRunReceipt, measurement }` entries with contiguous zero-based runIndex and measurement
`{ metric:"wall-clock-ns", unit:"ns", clock:"monotonic-hrtime", valueNs }`. The runner measures valueNs as
the canonical unsigned-decimal `process.hrtime.bigint()` difference from immediately before spawn until the
process group is reaped. Each run is §2.2-invariant with identical command/environment. Characterization/manual omit commandSpecDigest and
executionReceipt, and require artifactDigest equal to their independently approved P2f receipt digest.
`baselineRunSetDigest = CANON([{ runIndex, runReceiptDigest, measurement },...])` in baselineRuns order,
with each runReceiptDigest = CANON(runReceipt); candidateRunSetDigest uses the same exact projection/order.
executableSha256 is §0.4 over the resolved executable bytes; platform/arch are exact
`process.platform`/`process.arch`. stableEnvProjection is runReceipt.envProjection with only the generated
nonce removed; it is byte-equal across sets while each run has a fresh nonce/token.
Concurrency processOutcomes is the exact `{ processId, exitClass, resultDigest }` projection of
processReceipts, and `startBarrierDigest = CANON({ helperId, helperDigest, readyTokenDigest,
releaseTokenDigest, processCount, serializationBoundaryId })` using the exact barrierReceipt values and
receipt subtype. Exactly one exitClass is derived per process in this order: timedOut true yields `timeout`;
otherwise integer exitCode 0 yields `zero`; otherwise a nonzero integer exitCode yields `nonzero`; otherwise
a present §1.10 closed-set terminationSignal yields `signal:<name>`; every other combination aborts without a
receipt. The identical function supplies processOutcomes and the counts checked against frozen outcomeCounts,
and no process is double-counted. Every closed-enum class is admissible in outcomeCounts; P1 performs no
additional command-reachability analysis beyond schema/count validation.

Result derivation has no discretionary branch. Standard passes iff §2.2 INVARIANCE holds, exit is zero with
no timeout, the frozen selector occurs as a literal line, and the applicable target/Story token is observed.
Concurrent passes iff shared INVARIANCE holds, all processes are reaped and observe selector/target token,
and observed exit-class counts satisfy every frozen min/max with no unlisted class. Performance passes iff
every baseline/candidate repetition is §2.2-invariant, exits with integer exitCode 0, has timedOut false and
no terminationSignal, matches the frozen literal-line selector in its sequenced stream, and is
target-exercised; both sets use identical commandSpecDigest/environmentDigest; every baseline valueNs misses
thresholdNs; the candidate arithmetic mean meets it; and both sets pass the frozen variance rule. A
nonzero/signalled/timed-out/selector-failing repetition aborts with no receipt. Meets is comparator
satisfaction and misses its logical negation (`lt` misses at `>=`; `lte` misses at `>`). Compare the mean by integer cross-multiplication
`sum(valueNs) comparator thresholdNs * repetitions`; a set passes variance exactly when
`(max-min) * repetitions * 1000000 <= limitPpm * sum`, with no floating point. P2f-backed
kinds pass only for a fresh integrity-valid matching-contract artifact with machine verdict pass; manual also
requires every verifier attestation to pass. Otherwise result is fail or no receipt where §2.3 requires abort.

Target standard/concurrency/candidate-performance runs use the captured committed boundary candidate HEAD;
baseline-performance uses the frozen baseline. PRE equality and R1-6V apply. Docs uses the boundary
candidate, frozen top-level Story binding, and exact token
`EXERCISED-STORY:<storyId>:docs-consistency:<nonce>`; its
`storyScopeExercisedProofDigest = CANON({ storyId, evidenceBindingDigest, tokenValue, tokenObserved })` with
tokenObserved true. Target R1-6 does not apply to zero-target docs; this is its replacement.

The remaining exact preimages are:

- `selectorInputDigest = CANON({ classificationDigest, obligation, riskSignalCategories,
  processFactCategories, targetKind, acceptanceTargetRef, frozenScopePaths, materialPaths })`, where
  frozenScopePaths is the classification top-level field and materialPaths is the target implementationPaths
  (empty for docs);
- `storyScopeDigest = CANON({ storyId, classificationDigest, scopeAdmissionDigest, scopeContractDigest,
  targetKind, frozenScopePaths })`, with targetKind `story-zero-target-docs`;
- `receiptKey = CANON({ storyId, scope, acceptanceTargetRef, kind, subtype })`;
- `operationKey = CANON({ receiptKey, classificationDigest, reproFreezeStateDigest, selectorInputDigest,
  policyDigest, evidenceBindingDigest, headHash, materialHash, boundaryFilesHash, commandSpecDigest,
  artifactDigest })`.

Optional members are omitted under §0.4. All category/path arrays are normalized, UTF-8-byte sorted, and
duplicate-free. The new single-owner
`currentReproBoundaryFilesHash(gitCwd,candidateHead,metadataRoot,storyId,storyBaseHead)` calls the existing
function with its full actual signature
`resolveStoryChangedFiles(gitCwd,candidateHead,metadataRoot,storyBaseHead)`. storyBaseHead is the
P1-frozen explicit base and is never re-derived from moving local main. That function first
applies `isMaterialExcludedPath(path, projectRoot?)` with metadataRoot as projectRoot, omitting every
configured-Story metadata path, `docs/framework-audit/`, registered evidence-output path, and registered
runtime-artifact path. The new helper defensively asserts/filters the current Story prefix again and returns
§0.4 CANON over exact `{ path, blobOid }` objects sorted by UTF-8 bytes of path and then blobOid; identical
pairs are duplicate-rejected. A missing/unreachable explicit base or resolver failure returns
`repro-boundary-files-unverifiable` and writes no receipt, credential, or phase. It claims freshness only for this
returned non-excluded set; each excluded process artifact has its own registered consumer. blobOid is
`entry.blobId`, the bare Git blob id or existing literal `<deleted>`; renames contribute both paths.

The P3b batch writer captures one clean committed candidate head/material/boundaryFiles snapshot under the
transition lock, releases the mutex for all selected runs, and binds every unit to that snapshot. After the
per-key CAS appends, the registered metadata auto-commit commits receipt/head files; failure returns
`repro-verification-metadata-commit-failed` without phase change. That evidence-only descendant commit does
not change materialHash/boundaryFilesHash, so every sibling receipt remains fresh. Files live at
`<storyDir>/<id>/repro-verification-receipts/<contentDigest-without-prefix>.json`. The head file is exactly
`<storyDir>/<id>/repro-verification-receipt-heads.json` with schema
`{ schemaVersion:"proof-or-stop.repro_verification_receipt_heads.v1", storyId, storyDir, heads,
updatedAt, contentDigest, integritySignature }`; heads is a UTF-8-key-sorted map from receiptKey to
`{ seq, receiptDigest }`.

`evaluateReproScopeBinding` is obligation-discriminated. For redRequired it consumes only the active fresh
GREEN `resolvedEvidence` projection from redEvidenceGateQuery §5.1; direct chain-storage reads and caller
fields are forbidden, and a recover head is already resolved to its underlying GREEN by the query. For characterizationRequired it resolves the
active baseline/confirm records through the P2e-defined reproCharacterizationGateQuery. Record digests and
runner-measured head/material hashes are handler-owned in both branches. It computes the baseline→confirm
material diff; result is scope-bound iff that diff intersects frozen implementationPaths non-emptily and has
no material path outside frozenScopePaths, otherwise scope-violation. In both branches baseline head/material
equals the frozen target baseline and confirm head is its strict descendant; mismatch aborts without receipt.

`ReproScopeBindingReceipt` has schema `proof-or-stop.repro_scope_binding_receipt.v1` and exact fields
`{ schemaVersion, receiptKey, seq, supersedesDigest, storyId, storyDir, acceptanceTargetRef, obligation,
classificationDigest, reproFreezeStateDigest, targetBindingDigest, baselineEvidenceDigest,
confirmEvidenceDigest, baselineHeadHash, baselineMaterialHash, confirmHeadHash, confirmMaterialHash,
scopeContractDigest, implementationPathIntersection, outOfScopePaths,
operationKey, result, headHash, materialHash, boundaryFilesHash, actor, issuer, createdAt, contentDigest,
integritySignature }`. Its path arrays are normalized, sorted, and unique; result is exactly
`scope-bound|scope-violation`; `receiptKey = CANON({ storyId, acceptanceTargetRef })`; and
`operationKey = CANON({ receiptKey, classificationDigest, reproFreezeStateDigest, targetBindingDigest,
obligation, baselineEvidenceDigest, confirmEvidenceDigest, baselineHeadHash, baselineMaterialHash,
confirmHeadHash, confirmMaterialHash, scopeContractDigest, headHash, materialHash, boundaryFilesHash })`.
For redRequired, the evidence digests are the red/green recordDigests and confirm hashes are GREEN runner PRE;
for characterizationRequired, they are P2e baseline/confirm recordDigests and confirm runner PRE. obligation
equals the frozen classification; any query/record/hash mismatch aborts without a receipt. Files live at
`<storyDir>/<id>/repro-scope-binding-receipts/<contentDigest-without-prefix>.json`. The exact head file is
`<storyDir>/<id>/repro-scope-binding-receipt-heads.json` with schema
`{ schemaVersion:"proof-or-stop.repro_scope_binding_receipt_heads.v1", storyId, storyDir, heads,
updatedAt, contentDigest, integritySignature }` and the same sorted-map shape.

The public integrity domains are respectively
`proof-or-stop.repro-verification-receipt.v1`,
`proof-or-stop.repro-verification-receipt-heads.v1`,
`proof-or-stop.repro-scope-binding-receipt.v1`, and
`proof-or-stop.repro-scope-binding-receipt-heads.v1`. Each artifact uses the plan §4 computation:
`contentDigest` is SHA-256 over RFC-8785 CANON with contentDigest/integritySignature omitted, and
`integritySignature` is SHA-256 over `<domain>\u0000<CANON(object with integritySignature omitted)>`. This
is handler-content binding under §0.6, not hostile-writer identity proof.

Both families are append-only per receiptKey: seq begins at 1, each successor names the prior head digest,
and receipt files are never edited or deleted. Each head file is the sole mutable pointer and changes only by
atomic integrity-checked CAS replacement; every previously pointed-to receipt remains immutable/readable.
Only the registered P3b writer/evaluator may append; raw import/direct Story mutation is refused. Every
result, runner, command, hash, actor, issuer, and timestamp field is handler-derived: actor is the verified
current session identity from the owner lease, issuer is exactly
`proof-or-stop:p3b-verification-writer@1` or `proof-or-stop:p3b-scope-binding-evaluator@1` for its family, and
createdAt is handler-owned ISO-8601 UTC. The caller supplies only a frozen Story/target selection. The writer runs outside the mutex, then reacquires the plan
§8 global locks, rechecks freeze/current facts and prior-head CAS, deduplicates an identical operationKey, or
rejects a moved conflicting head and re-evaluates. The head pointer is atomically replaced and fsynced.
Freshness requires exact storyDir, freeze, classification, target binding where applicable, selector/policy,
scope-contract where applicable, and a receipt head equal to or ancestral to the evaluated boundary head
with exact materialHash/boundaryFilesHash equality. Missing, invalid,
superseded, stale, failed, duplicated-head, forked, or mismatched receipts block; an older pass is never used.

DEV→REVIEW requires the exact plan-§6 `reproCompletionReady` predicate: active GREEN/liveMatch for every
redRequired target, active PRESERVED/liveMatch from the P2e query for every characterization target, one
fresh `scope-bound` head per frozen target, the docsExempt current-empty-target recheck when applicable, and
a fresh pass head for every selector-produced kind/subtype, including performance, docs-consistency,
characterization-perturbation, and manual-observation when selected. P2f verifier identities are issued in
DEV, so manual evidence has no REVIEW-run dependency. REVIEW→TEST and TEST→DONE recheck the same predicate;
formal review-lane and validation/DONE facts are additional. After sync, changed material/boundary hashes
require rerunning the registered batch before TEST→DONE.

### §7.2 Bootstrap component manifest boundary

P2r consumes only independently recomputable component identities. Each `P0m|P0p|P1|P1f|P2a|P2b` component has
an append-only manifest chain at
`<metadataRoot>/.proof-or-stop/repro-bootstrap-components/<componentId>/manifests/<contentDigest-without-prefix>.json` and an
integrity-signed CAS `head.json`. A manifest is exact
`{ schemaVersion:"proof-or-stop.repro_bootstrap_component_manifest.v1", seq, supersedesDigest,
componentId, componentStoryId, changeCommit, snapshotHead, coveredFiles, componentProcessFactMappingDigest,
componentRuntimeFactMappingDigest, createdAt, contentDigest, integritySignature }`. `componentId` is exactly
`P0m|P0p|P1|P1f|P2a|P2b`; seq starts at 1 and
supersedesDigest is null only at seq 1. changeCommit is the component-introducing/repair local-main merge;
snapshotHead is the immutable commit whose component bytes are qualified and MUST equal changeCommit or
satisfy `git merge-base --is-ancestor <changeCommit> <snapshotHead>`; equality is allowed and is the normal
DONE post-merge successor case.

coveredFiles is the duplicate-free `{ path, blobOid }` array sorted by UTF-8 path then blobOid, unioning
(a) every non-Story-metadata path changed from changeCommit's first parent to changeCommit, (b) every path
mapped to the component by the process/runtime fact projections at snapshotHead, and (c) every mapped
generated counterpart. Member (c) is exactly the `generatedFrom?` relation and is **symmetric across both
registries**: a component-filtered tuple whose `generatedFrom` is present contributes both that tuple's
`path` (the generated path) and the `generatedFrom` value (its source path) to coveredFiles, and this holds
identically for process-fact and runtime-fact tuples — which is only possible because P0m puts
`generatedFrom?` on `ProcessFactRegistryEntry` as well as on `RuntimeFactRegistryEntry`. A generated path
mapped to the component by a tuple carrying no `generatedFrom` is a non-total mapping and is
`registry-component-mapping-unavailable`, never a silently half-covered file. blobOid is the bare blob id in
snapshotHead or `<deleted>`. An unmapped changed component path
fails the fact-contract verifier. `componentProcessFactMappingDigest = CANON([{ factId, componentId, path,
generatedFrom? },...])` and `componentRuntimeFactMappingDigest = CANON([{ runtimeFactId, componentId, path,
generatedFrom? },...])`; each complete snapshotHead projection is sorted by UTF-8 id/path/generatedFrom,
omits absent generatedFrom — a tuple without the member sorts before an otherwise equal tuple that carries
one — and duplicate-rejects. Both preimages read `generatedFrom?` from their own registry entry, so the
process-fact tuple and its sort key are computable exactly because P0m adds that member to
`ProcessFactRegistryEntry` too.

These two names are reserved for this **component-filtered** flattened-`path` preimage and are deliberately
distinct, in name and in preimage, from plan §4's **whole-registry** classification inputs
`processFactRegistryDigest` / `runtimeFactRegistryDigest`, which cover every registered entry with no
`componentId` filter and carry a sorted `paths` array per entry. Neither pair may be substituted for the
other, and no digest name in this program is computed over two different preimages.

Both projections are **blocked on prerequisite workstream P0m** (plan §12). Current 0.3.296 source truth:
`ProcessFactRegistryEntry` in `packages/main/src/core/process-fact-registry.ts` carries no `factId`, `paths`,
`componentId`, `serializationBoundaryId`, or `generatedFrom` — its `producerSourceRefs` /
`consumerSourceRefs` are optional advisory source pointers, not a total entry-to-component mapping — and
`RuntimeFactRegistryEntry` in `packages/main/src/core/runtime-fact-registry.ts` carries no `runtimeFactId`,
`kind`, `paths`, `componentId`, or `generatedFrom` either. Neither projection is therefore computable against
0.3.296. Under plan §§11-12, P0m extends `ProcessFactRegistryEntry` with `factId`, a normalized `paths`
array, and optional `componentId` / `serializationBoundaryId` / **`generatedFrom`**, and extends
`RuntimeFactRegistryEntry` with `runtimeFactId`, `kind`, a normalized `paths` array, and optional
`componentId` / **`generatedFrom`**. **Both registries therefore carry `generatedFrom?`**, which is what makes
the `componentProcessFactMappingDigest` and `componentRuntimeFactMappingDigest` preimages above computable
and their `generatedFrom` sort key well defined, and what makes coveredFiles member (c) symmetric. That member
belongs to the **component-filtered** projection only: plan §4's whole-registry `processFactRegistryDigest` /
`runtimeFactRegistryDigest` preimages are unchanged by it and continue to carry exactly
`{ factId, kind, paths, componentId?, serializationBoundaryId? }` and
`{ runtimeFactId, kind, paths, componentId? }` respectively, so no digest name acquires a second preimage.
P0m is the sole authoritative owner of that mapping surface, of both the whole-registry and the
component-filtered projection functions, and of the `verify-process-fact-contract.mjs` /
`verify-runtime-fact-contract.mjs` assertions that fail an entry whose mapping is absent, ambiguous, or
non-total instead of dropping it from a projection. The manifest writer and every other consumer call P0m's
component-filtered function and may not re-derive, approximate, or infer a mapping from `producer`,
`producerSourceRefs`, `consumerSourceRefs`, or `artifact.path`. If any covered entry lacks a total,
unambiguous mapping at snapshotHead, the writer returns `registry-component-mapping-unavailable` and issues
no manifest or head; it never substitutes a partial projection and never emits an empty projection as
success.

The manifest uses public domain `proof-or-stop.repro-bootstrap-component-manifest.v1`. The exact head is
`{ schemaVersion:"proof-or-stop.repro_bootstrap_component_head.v1", componentId, seq, manifestDigest,
updatedAt, contentDigest, integritySignature }` with domain
`proof-or-stop.repro-bootstrap-component-head.v1`; both follow plan §4 omission rules. The registered writer
takes the main write lock after the Story transition lock when a transition is present and before any per-Story
or target lock; as a main-only operation it takes only main. Under that lock it validates the prior chain,
creates the content-addressed manifest, and atomically
CAS-replaces/fsyncs the head. Identical input deduplicates; changed input appends seq+1 naming the prior
manifest. Initial P2r writes the first current manifests. Any later Story changing a headed component path
or mapping must append a successor as a DONE post-merge effect before new dependent credentials.
The storage prefixes are registered evidence-output paths excluded from material/boundary hashing and owned
for freshness solely by this checker.

The checker uses only the unique current head and recomputes manifest identity against its pinned
snapshotHead, never moving main. Broken lineage/integrity/forks are
`bootstrap-component-chain-invalid`; unrelated later merges do not stale it. A separate current-head
freshness comparison derives the matching component path/mapping projection at candidate local main without
rewriting historical identity; a difference without a successor is `bootstrap-component-head-stale`. A valid
successor changes the current component digest and stales dependent older-head evidence until rerun or
equivalently requalified. Each P2r qualification binds the current verified manifestDigest; caller values are
inadmissible, and component digest means that manifestDigest/contentDigest identity.

### §7.3 Per-unit evidence-binding authoring schema (`reproEvidenceBinding`) — plan §4.1 mirror

**Normativity.** Program plan §4.1 is authoritative for this authoring surface; this section mirrors it so the
two documents cannot diverge, and adds no semantic choice of its own. A conflict between them blocks
implementation under plan §1 until both documents are reconciled and the plan is re-audited. §0.5's
"Verification evidence binding" term describes the **derived** bindings that the declarations defined here are
projected into; nothing outside this authoring surface is an admissible input to that derivation.

`evidenceBindings` and `storyEvidenceBindings` are derived, never authored directly. Their sole admissible
input is one closed structured field nested on `VerificationIntentItem`, named `reproEvidenceBinding`. P1 owns
this schema, its CLI surface, and its migration (plan §11 and the P1 row in plan §12).

**Where it lives.** Current 0.3.296 source truth: `VerificationIntentItem` in `packages/main/src/core/types.ts` is
exactly `{ id?, desc, type, requiredIn?, priority?, plannedPathDeclarations?, verification? }`, keyed into
`VerificationIntent = Record<VerificationLane, VerificationIntentItem[]>` over
`VerificationLane = 'happy' | 'edge' | 'adversarial'` with
`VerificationIntentType = 'logic' | 'cli' | 'browser' | 'manual' | 'docs'`. P1 adds exactly one optional
member, `reproEvidenceBinding`, and changes no existing member's type or meaning. The authoring object is
exact and closed:

```
reproEvidenceBinding = {
  schemaVersion: "proof-or-stop.repro_evidence_binding_declaration.v1",
  acceptanceTargetRef?,      // required for target scope; omitted only for the zero-target docs case
  kind,                      // one of the ten plan §7 evidence kinds
  subtype?,                  // present exactly when the kind's subtype rule below requires it
  execution,                 // "runner" | "p2f-artifact"; must equal the kind's fixed execution
  adapterId?, testCaseRef?, selector?,   // present exactly when execution === "runner"
  p2fContractId?,                        // present exactly when execution === "p2f-artifact"
  expectation?               // present exactly when execution === "runner"; closed payload below
}
```

**Unknown and missing fields reject.** Any key not listed above, at the top level or nested anywhere inside
`expectation`, rejects with typed `evidence-binding-declaration-unknown-field`. Any required field absent, or
present with the wrong JSON type, rejects with `evidence-binding-declaration-incomplete`. `selector` must be a
non-empty UTF-8 literal-line value with no leading or trailing whitespace; it is not a regex, glob, or shell
fragment. Every rejection in this subsection is fail-closed: P1 writes no classification, no head, no binding,
no freeze, and no credential, and never falls back to a partial or empty binding array. The Zod schema is the
first layer only: the `checklist_update` handler entry and every gate or function that consumes a declaration
re-validate the identical constraints at runtime, so a path that bypasses schema parsing — an internal call,
or previously stored JSON — is rejected on the same terms.

**Execution, expectation, and subtype are fixed by `kind`, not chosen by the caller.** This table is total
over the ten kinds and closed; widening it requires a plan revision and a fresh audit.

| kind | `execution` | `expectation.type` | `subtype` |
|---|---|---|---|
| `happy` | `runner` | `standard` | forbidden |
| `edge` | `runner` | `standard` | forbidden |
| `regression` | `runner` | `standard` | forbidden |
| `adversarial` | `runner` | `standard` | required: `malformed-input\|stale-binding\|tampered-binding` |
| `gate-bypass` | `runner` | `standard` | required: `direct-write\|prewrite-bypass\|rollback\|compatibility-path` |
| `concurrency` | `runner` | `concurrent` | required: the registered `serializationBoundaryId`, which MUST equal `expectation.serializationBoundaryId` |
| `performance` | `runner` | `benchmark` | forbidden |
| `docs-consistency` | `runner` | `standard` | forbidden |
| `characterization-perturbation` | `p2f-artifact` | forbidden | forbidden |
| `manual-observation` | `p2f-artifact` | forbidden | forbidden |

`execution` is authored explicitly so the object stays a self-describing discriminated union, but it is not
caller-selectable: a value unequal to the kind's fixed execution rejects with
`evidence-binding-declaration-discriminant-mismatch`, as does a runner payload on a `p2f-artifact`
declaration, a `p2fContractId` on a runner declaration, or an `expectation` on a `p2f-artifact` declaration.
A caller therefore cannot move a unit off the trusted runner path by editing a discriminant. The three
`expectation` payloads are byte-identical to the closed `standard` / `concurrent` / `benchmark` forms already
stated in §0.5's "Verification evidence binding" term and in plan §4 — including `expectedExitClass:"zero"`,
`selectorPolarity:"present"`, the `processCount >= 2` and `outcomeCounts` rules, and the `repetitions >= 2`,
comparator, canonical-decimal `thresholdNs`, and `max-relative-spread-ppm` variance rules — and are not
restated with any variation here.

**Lanes and types constrain the kind; they never determine it.** The three lanes and five types predate the
ten evidence kinds and are not in bijection with them, so no mapping from lane or type to kind exists or is
inferred. `kind` is authored explicitly and validated against the selector's output (step 4 below); lane and
type act only as necessary conditions. Both tables are total over all ten kinds:

| kind | admissible lane | admissible `type` |
|---|---|---|
| `happy` | `happy` | `logic\|cli\|browser` |
| `edge` | `edge` | `logic\|cli\|browser` |
| `regression` | any lane | `logic\|cli\|browser` |
| `adversarial` | `adversarial` | `logic\|cli\|browser` |
| `gate-bypass` | `adversarial` | `logic\|cli\|browser` |
| `concurrency` | any lane | `logic\|cli` |
| `performance` | any lane | `logic\|cli\|browser` |
| `docs-consistency` | any lane | `docs` |
| `characterization-perturbation` | any lane | `logic\|cli\|browser` |
| `manual-observation` | any lane | `manual` |

"any lane" means the lane is descriptive PLAN organization for that kind and carries no derivation weight;
`concurrency` is restricted to `logic|cli` because a real OS-process race at a production serialization
boundary is a process-level fact the §7.1 P3b runner drives directly. A declaration whose owning lane or whose
item `type` is outside its row rejects with `evidence-binding-declaration-lane-type-invalid`. Nothing in
either table lets a lane or a type select, imply, or default a kind.

**Per-target association and uniqueness.** A declaration is associated with exactly one acceptance target by
its own `acceptanceTargetRef`, never by the position of the checklist item or intent item that carries it.
That ref MUST name a member of the classification's `targets[]`, or the declaration rejects with
`evidence-binding-declaration-target-unresolved`. For a zero-target `docsExempt` Story the ref is omitted and
the declaration is Story-scoped; exactly one such Story-scoped declaration may exist across the whole Story,
its kind MUST be `docs-consistency`, and a second one rejects. Across the entire Story checklist, the tuple
`(acceptanceTargetRef-or-story-scope, kind, subtype)` MUST be unique; a second declaration on the same tuple
rejects with `evidence-binding-declaration-duplicate` regardless of which checklist item or lane carries it.
One intent item carries at most one declaration, so several units on one target are authored as several
intent items — including one item per registered `serializationBoundaryId` when several concurrency units
are selected.

**Exact derivation to `evidenceBindings` / `evidenceBindingDigest`.** After step 3 below has produced
`requiredEvidenceUnits`, P1 matches declarations to units one-to-one on `(acceptanceTargetRef-or-story-scope,
kind, subtype)`. A selected unit with no matching declaration rejects with
`evidence-binding-declaration-missing`; a declaration matching no selected unit rejects with
`evidence-binding-declaration-unselected`, so an extra binding can never be smuggled past the selector. For a
matched runner unit P1 resolves `adapterId` in the `runnerAdapterRegistry` of the resolved §1.2 policy
snapshot and matches `testCaseRef` against that adapter's `testCaseRefPattern`; a missing adapter or
non-matching ref is the existing adapter-incompatible block. For a matched `p2f-artifact` unit it verifies the
independently approved contract id. If no approved P2f contract registry exists at the classification head,
or the declared id is unresolved, unapproved, or incompatible with the declaration's kind/subtype, P1
returns `p2f-contract-registry-unavailable` and writes no classification, head, binding, freeze, or
credential. A structurally absent or wrong-typed `p2fContractId` remains
`evidence-binding-declaration-incomplete`; the codes are disjoint and there is no "classified but blocked"
intermediate state. Each accepted declaration is then projected to its binding by taking
exactly its `{ kind, subtype?, execution, testCaseRef, adapterId, selector, expectation }` members for a
runner unit, or exactly its `{ kind, subtype?, execution, p2fContractId }` members for a P2f unit;
`schemaVersion` and `acceptanceTargetRef` are authoring-envelope members and are **dropped** by the
projection, because the ref becomes the association key and the version governs the authoring surface, not the
frozen binding. `evidenceBindingDigest = CANON(binding)` is computed over that projection and over nothing
else, so this digest name — like every other name in this program — has exactly one preimage. The projected
bindings are sorted by receipt key into the target's `evidenceBindings`, or into top-level
`storyEvidenceBindings` for the zero-target docs case. The §7.1 receipt writer's lookup reads only these
projected bindings; it never reads a declaration.

**PLAN freeze.** Declarations are authored and revised during PLAN and are frozen by the single PLAN→DEV
freeze together with the classification that consumed them. Two independent mechanisms bind them. For a
declaration on an intent item that is a target descriptor source, the exact intent-item `contentDigest` moves
`acceptanceSemanticDigest`. That descriptor's `sourcePointer` is exactly
`/items/<itemIndex>/verificationIntent/<lane>/<laneIndex>` and its digest covers the complete intent-item
subobject. The declaration pointer is exactly the descriptor pointer plus the single
`/reproEvidenceBinding` segment where both exist — a strict child, never the same pointer — and remains
defined when the carrying item is not a descriptor source. The Story-level
`evidenceDeclarationSetDigest = CANON([{ checklistItemId, intentRef, sourcePointer, scope,
declarationDigest, evidenceBindingDigest },...])` additionally covers every committed declaration, including
one on a non-descriptor item and the Story-scoped zero-target docs declaration. Elements sort by UTF-8 bytes
of `checklistItemId`, then `intentRef`, then `sourcePointer`; no deduplication occurs;
`declarationDigest` retains the complete authored declaration while `evidenceBindingDigest` is the projected
binding digest; zero declarations is exactly `CANON([])`. It is the tenth classification `inputDigests`
member, covered by the classification signature and recomputed from declaration fields and committed
positions at every post-DEV boundary for every obligation. An edit, addition, removal, or move returns
`acceptance-target-semantics-drift-after-freeze` with phase and credentials unchanged and repair on a fresh
Story. Ordinary status/time/evidence/snapshot writes do not move it; an appended declaration-free item does
not move this digest but remains subject to independent target-set and semantic checks. Malformed or
duplicate source pointers return `evidence-declaration-set-invalid`. There is no post-freeze declaration
edit, waiver, re-derivation, or narrowing path.

Current 0.3.296 signed `verificationIntentAmendments` and checkpoints are verified before classification but
grant no repro mutation authority. Exact `verification_intent_recover` restores only the already-signed
projection and then reruns frozen checks. `verification_intent_append` remains unable to carry a
`reproEvidenceBinding`, and P1 refuses it before persistence if the new intent would enter the candidate set
or move any frozen target, semantic digest, or declaration-set digest. Existing typed `AMENDMENT_*` integrity
failures propagate rather than becoming an empty checklist or `docsExempt`.

**Required-intent behavior, stated consistently with §0.5.** "Authored, registered, and adapter-resolvable at
PLAN" means the intent item *and* its `reproEvidenceBinding`. The blockers stay mechanically distinct: any
Story of any channel and any obligation with selected units and **zero authored `verificationIntent`
entries** returns `verification-intent-required`; authored intents that leave a selected required unit
without a valid declaration return `evidence-binding-declaration-missing`; and a
`redRequired|characterizationRequired` Story with no concrete target returns `acceptance-targets-missing`.
A mechanically non-executable Story classifies `docsExempt` but still satisfies its one required unit through
the Story-scoped `docs-consistency` intent and declaration. No `express-exempt` disposition and no
channel-qualified blocker exists after P1.

**Legacy `verification` pin: preserved, and fenced out of this derivation.** `VerificationIntentItem.verification`
(`VerificationIntentPin = { command, selector, narrowings? }`) keeps its existing B-ec67 meaning and its
B-1482 narrowing-only semantics for **ordinary verification evidence only**, unchanged in every respect by
this program. It is a separate field with a separate lifecycle, and this program neither extends nor
restricts it. Explicitly: `verification.command` and `verification.selector` are **never** admissible inputs
to repro obligation classification, to any evidence binding, to `commandSpecDigest`, or to any §7.1 P3b run.
`verification.command` is caller-authored free text, which is exactly why it can never reach the trusted
runner — admitting it would defeat R1-5, whose whole content is that the caller cannot choose the executable.
Repro argv comes only from adapter-template resolution against a registered `testCaseRef` under the frozen
policy snapshot, and the repro selector comes only from the frozen `reproEvidenceBinding.selector`.
Conversely, `verification_pin_narrow` operates only on `verification.selector`: it may not read, write, or
narrow any `reproEvidenceBinding` member, and a request naming one is refused. A repro selector that turns out
to be wrong is not narrowed — it is semantics drift, repaired on a fresh Story.

**No circular classification dependency.** The derivation order is a six-step chain with no back edge:

1. `resolveAcceptanceTargetCandidates` runs over the ref-only sources (`original-intent-snapshot.json`,
   `proofstory.json` acceptance bindings / milestone ledger, checklist `verificationIntent` refs).
   Declarations are not read.
2. Each candidate's `targetDisposition` is assigned by the registered material classifier. Declarations are
   not read: **the presence of a declaration never makes a candidate `executable-material`, and its absence
   never makes one `non-executable`.** In particular, naming an `adapterId` or a `p2fContractId` in a
   declaration is not the "registered executable runner/P2f target reference" that the §0.5 disposition rule
   tests.
3. `selectRequiredReproEvidence` runs on the resolved obligation, risk facts, target kind, frozen scope paths,
   and material classification, producing `requiredEvidenceUnits`. Declarations are not read. No integrity
   signature exists or is required at this point.
3.5. `resolveVerificationIntentPolicy` reads the resolved obligation, step 3's units, the unit keys named by
   committed declarations, and the committed intent count. It reads no declaration object and no channel;
   its output changes nothing upstream and a required/unresolved result blocks without a write.
4. Declarations are read as objects for the first time and matched one-to-one onto step 3's units, as
   specified above; P2f contract resolution happens here.
5. `evidenceDeclarationSetDigest` is computed over every accepted declaration and committed position.
6. The completed classification artifact — obligation, units, projected bindings, input digests, and all — is then
   content-digested and integrity-signed under §0.4.

Because no step reads a declaration before the step that produces what it is matched against, authoring a
declaration can never change the obligation, the candidate set, the target set, or the selected unit set. It
can only be accepted against them or rejected by them.

**P1 ownership and migration.** P1 owns, as one deliverable: the `VerificationIntentItem` type change in
`packages/main/src/core/types.ts`; the matching `verificationIntentSchema` extension in
`packages/main/src/cli/command-catalog.ts` under the same fail-closed unknown-key rule; the runtime
re-validation at the `checklist_update` handler entry and at every consuming gate or function; the derivation
and projection to `evidenceBindings` / `storyEvidenceBindings` / `evidenceBindingDigest`; and the
`verification_pin_narrow` refusal for any request naming a `reproEvidenceBinding` member. The migration
disposition is exact: the member is **additive and optional at the type level**, no historical Story metadata
is rewritten or backfilled, and a Story that reaches PLAN under P1 without the declarations its selected units
require is **blocked rather than auto-filled**. `VerificationIntentItem.verification` and
`plannedPathDeclarations` are untouched. P1 also verifies the existing signed intent-amendment/checkpoint
lineage before classification and installs the pre-persistence DEV-append refusal stated above. This
subsection is a decision contract only: it authorizes no runtime
change, ships zero code, and is not an audit approval.

The spec is complete when a cross-host audit confirms all of §1..§6 and the §7.1-§7.3 integration boundaries
are present and each section's rules are traceable to text, and the two folded-in product-review advisories
are addressed: the gate-consumption query contract drawing the W2/W3 boundary (§5, summarized in §1.9) and
the legacy-record posture (§6, linked in §4.4). This document is the citable acceptance contract for the W2
implementation stories and for the receipt interface later P3 gates consume; no implementation code is in
scope here.
