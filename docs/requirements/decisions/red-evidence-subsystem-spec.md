# Trusted RED-Evidence Subsystem — Decision Spec (Program Workstream 2)

Status: decision spec / acceptance contract for the W2 implementation stories. No runtime change is authorized by this document; it ships zero code.
Date: 2026-07-23 (rev 6 — ARCHITECTURAL CONVERGENCE after audit round 5: (MOVE 1) the regex matcher
language is REMOVED — matchers are `literal-line` + registered `class` only, deleting the entire
regex-gaming finding class; (MOVE 2) §0.6 gains an explicit assurance-tier clause — W2 defends against
accidental fabrication, workflow drift, and casual gaming; a fully hostile local agent with
filesystem/toolchain control is Tier-C's adversary, not W2's. All round-5 mechanical findings dispositioned;
earlier dispositions retained. Standing deviations, auditor-ACCEPTED in round 3: recordId stays in the
idempotency-key tuple as a deterministic derivation (§3.4); `recoversRecordId` keeps its program-pinned name
with a `linkKind` discriminator (§4.1))
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
     - **Storage**: `.lattice/story/actives/<id>/red-target-bindings.json`, schema
       `proofstory.red_target_bindings.v1`:
       `{ schemaVersion, storyId, bindings: [ { acceptanceTargetRef, adapterId, testCaseRef, createdAt } ],
       createdAt, updatedAt }`. Exactly ONE binding per `acceptanceTargetRef`; a duplicate-target write is
       rejected. **Digest scope (audit: stored entries carry `createdAt`, the digest does not):**
       `targetBindingDigest` is `CANON` over the 3-field subobject
       `{ acceptanceTargetRef, adapterId, testCaseRef }` ONLY — every validator MUST strip `createdAt` (and
       any other storage metadata) from a stored entry before canonicalizing for digest comparison.
     - **Mutation**: only via the registered, lease-gated command
       `red_evidence_binding_set(storyId, acceptanceTargetRef, adapterId, testCaseRef)` (§4.1 gating).
       Setting a binding for a target is legal while the target's chain is EMPTY or its head is a
       `quarantine` record; once a run record exists on an unquarantined chain, the binding is frozen for
       that target (retire the assertion first — this forecloses swap-after-review reuse).
     - **Lookup tree (the anti-swap rule)**: the RUNNER reads the binding from the COMMITTED tree it
       materializes — `<RUN-HEAD>:.lattice/story/actives/<id>/red-target-bindings.json` (§2.3 step 1) —
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
   - **`"harness-token"` (the required method, adapter-owned emission).** The RUNNER — never the caller —
     derives the argv from the adapter's template (§2.3 step 0); caller-supplied free shell text is never
     executed. At run time the runner generates a fresh random 128-bit hex **nonce** and exports it as
     `LATTICE_RED_RUN_NONCE`. The token `EXERCISED:<acceptanceTargetRef>:<nonce>` is EMITTED BY THE ADAPTER
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
  `LATTICE_RED_RUN_NONCE` and the runner-set pinned `PATH` (below). Nothing else reaches the child
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
`runnerProfileRegistry` (profiles embed their optional `toolchain`). An UNKNOWN key in the `materialCode`
red-evidence policy block REJECTS at config load (fail closed, consistent with the W1 resolver contract).
`policyDigest = CANON` over exactly this object.

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

Policy and registry contents live in project config (`lattice.config.json`), which is in the W1 immutable
runtime/build-config manifest set (`language-neutral-gates-execution-plan.md` Change B precedence 1): every
policy or registry change is a material-code diff that surfaces in story review, and no config key can
exclude it. All tunables are additionally clamped by the HARD spec-level floors of §1.12, which no policy
value may cross.

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

The v1 `greenRelation` (`packages/main/src/core/types.ts:2628`) is retained: `targetRef` MUST equal the
record's `acceptanceTargetRef`, and `relation` ∈ `{ same_acceptance, regression_to_green, replacement }`
(`VALID_GREEN_RELATIONS`, `packages/main/src/core/proofstory.ts:91`).

The binding rule is strengthened over v1's optional-field check (`packages/main/src/core/proofstory.ts:878-879`),
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
  or whose RED exit is not a member of `expectedExitClass`, is REJECTED (the asserted failure was not actually
  observed).
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
  "operationKey": "sha256:...",
  "runReceipt": {
    "adapterId": "npm-script@1",
    "adapterDigest": "sha256:...",
    "testCaseRef": "npm-script:test:autopilot-resume-smoke",
    "linkageKind": "script-exit",
    "linkageSignal": "script-exit",
    "argv": ["npm", "run", "test:autopilot-resume-smoke"],
    "cwd": ".",
    "envProjection": { "LATTICE_RED_RUN_NONCE": "<nonce hex>" },
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
    "clean": { "headHash": "...", "materialHash": "...", "indexState": "...", "gitStatus": "..." },
    "pre":  { "headHash": "...", "materialHash": "...", "indexState": "...", "gitStatus": "..." },
    "post": { "headHash": "...", "materialHash": "...", "indexState": "...", "gitStatus": "..." }
  },
  "note": "<optional>",
  "createdAt": "<ISO-8601>",
  "recordDigest": "sha256:..."
}
```

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

**Exit/termination representation (audit: a SIGKILLed process has no exit code):** `exitCode` is an integer
OR `null`; optional `terminationSignal` ∈ `{ "SIGTERM", "SIGKILL" }`. Permitted combinations — normal exit:
integer `exitCode`, no `terminationSignal`; timeout kill (§2.3.3b): `timedOut: true`, `exitCode: null`,
`terminationSignal` set; any other signal death: `exitCode: null`, `terminationSignal` recorded, run treated
as failed (never `exit0`); spawn failure: no receipt is produced — the run aborts with no record.

Operation-specific field sets (exhaustive; §0.4 omission rules apply — a field not listed for an operation is
OMITTED, never null):

- `operation: "red-assert"` — the full shape above: chain fields, `storyId`, `acceptanceTargetRef`,
  `trigger`, `observedFailure`, `baselineHeadHash`, `baselineMaterialHash`, `greenRelation`, `assertion`,
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
MUST clamp-reject: a resolved policy that crosses any of them fails CLOSED at config load with a diagnostic —
the subsystem refuses to run, it does not silently clamp.

| Hard floor/cap | Value | Rule |
|---|---|---|
| `minMatcherLen` | ≥ 4 | policy may raise, never set below 4 |
| `minMatcherEntropyBits` | ≥ 12 | policy may raise, never set below 12 |
| `maxMatchers` | ≤ 32 | policy may lower, never exceed 32 |
| `maxMatcherLen` | ≤ 4096 | policy may lower, never exceed 4096 |
| `runTimeoutMs` / `prepTimeoutMs` | ≤ 3600000 | never above one hour |
| `forbiddenCatchAlls` | ⊇ the §1.2 default set | policy may extend, never remove a default entry |
| `matcherClassRegistry` | `predicateKind` ∈ closed §1.2 enum only | no free-form predicates, ever |
| `invarianceExcludePaths` | MUST NOT match any tracked material path (checked against the live classification at config load) and MUST NOT contain a bare `**`/`*` catch-all | violating globs fail closed |
| §1.3 rule 3 | always in force | no policy key can exempt class-only `present-in-red` |
| Forbidden environment keys (§1.2) | ⊇ the §1.2 hard set (`PATH`, `LD_PRELOAD`, `DYLD_*`, `NODE_OPTIONS`, ...) | policy may extend, never shrink; allowlist naming one fails closed |
| `policy.pinnedPath` | absolute directories only | relative entry fails config load; child `PATH` is always runner-set |
| Adapter/profile registration | only via `policy.runnerAdapterRegistry`/`runnerProfileRegistry` entries in `lattice.config.json` (material, W1-immutable manifest set) | no runtime/env registration path exists |

---

## §2. Disposable-workspace runner and four-tuple net-state invariance

### §2.1 The four-tuple (measured PRE and POST)

Every RED run and every GREEN run is executed by a runner that captures a **four-tuple** immediately before the
command starts (PRE) and immediately after it exits (POST). The four measured quantities are:

1. **`headHash`** — `git rev-parse HEAD` in the workspace (the checked-out commit).
2. **`materialHash`** — the canonical material digest over the workspace tree at HEAD, computed by the SAME
   function the CLI uses today, with its ACTUAL signature (audit: earlier revisions drifted the parameter
   names): `currentMaterialHash(gitCwd, ref = 'HEAD', metadataRoot = gitCwd)` — here `gitCwd` = the
   workspace root, `metadataRoot` = the project metadata root
   (`packages/main/src/core/evidence-freshness.ts`, invoked at `packages/main/src/handlers/proofstory.ts:969`).
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
   segment-aware matching as the W1 material-policy resolver contract
   (`language-neutral-gates-execution-plan.md` Change C). The exclusion set is part of `policySnapshot`,
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

0. **Derive the command.** Resolve `adapterId` in `policy.runnerAdapterRegistry`; match `testCaseRef` against
   the adapter's `testCaseRefPattern`; instantiate `argvTemplate` → argv. No shell interpretation of
   caller-supplied text (R1-5). Resolve the runner profile `runnerProfileId` from policy: an ordered list of
   preparation commands (e.g. `npm ci`, build steps), an environment allowlist (`allowedEnvKeys`), and a
   relative `cwd`. `runnerProfileDigest = CANON(profile)` goes into the receipt.
1. **Create.** `git worktree add --detach <tmpdir> <RUN-HEAD>` where `<tmpdir>` is a fresh directory under
   the OS temp root (`$TMPDIR`) and `<RUN-HEAD>` is operation-specific: for a **red-assert** run, the
   record's claimed `baselineHeadHash`; for a **green-confirm** run, the pre-run CANDIDATE head captured by
   the handler before the dedupe search (§4.1 — the candidate becomes `greenHeadHash`, §1.4; PRE must equal
   it, §2.3.3(ii)). This is the ONLY materialization
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
2. **Prepare.** Run the profile's preparation commands inside the workspace (dependency install, build),
   with the §1.2 preparation environment (same projection, no nonce, pinned PATH). EACH preparation command
   is bounded by `policy.prepTimeoutMs` under the same process-group SIGTERM → `killGraceMs` → SIGKILL
   discipline as step 3b; a prep timeout or nonzero prep exit ABORTS the run — no record, workspace
   discarded (step 6). **Preparation MUST preserve the committed acceptance material** (audit: prep ran
   before PRE in rev 4, so a hostile profile could overwrite the bound test and PRE would bless the doctored
   bytes): prep may create or modify ONLY gitignored or `invarianceExcludePaths`-excluded non-material paths.
3. **Snapshot PRE** — capture the four-tuple (§2.1). Enforce THREE checks:
   (i) **Prep invariance (R2-4):** `pre.headHash == clean.headHash` AND `pre.indexState ==
   clean.indexState` AND `pre.gitStatus == clean.gitStatus` (audit round 5: full filtered-status equality,
   aligning exactly with step 2's constraint — since CLEAN's filtered status is empty, EVERY path prep
   created or modified must be gitignored or `invarianceExcludePaths`-excluded; a non-excluded untracked
   `build_stamp.txt` fails here, and in particular no tracked MATERIAL path can be dirty, so the worktree
   BYTES of every tracked material path still equal the committed `<RUN-HEAD>` blobs — the exercise tree is
   equivalent to the committed RUN-HEAD for acceptance material. This is required precisely because
   `materialHash` is a COMMITTED-tree hash — `git ls-tree` at HEAD — and by itself never binds dirty
   worktree bytes; see §2.1.2.) Any violation → abort, no record.
   (ii) **Binding equality (R2-3), operation-specific:** for a red-assert run, `pre.headHash ==
   record.baselineHeadHash` AND `pre.materialHash == record.baselineMaterialHash` (the claimed baseline is
   runner-verified, not self-reported), else abort with no record. For a green-confirm run, PRE MUST equal
   the pre-run CANDIDATE binding (`pre.headHash == candidateHead` AND `pre.materialHash ==
   candidateMaterial`, §4.1 — the story tree moved between key derivation and materialization ⇒ abort and
   retry), and those candidate values ARE the record's `greenHeadHash`/`greenMaterialHash` (§1.4);
   GREEN-BIND is then checked against the referenced red-assert's fields at append time.
   (iii) The committed-tree binding lookup of §1.1.3 (R1-6) resolves against `<RUN-HEAD>`.
   3b. **Exercise.** Spawn argv in its own process group, env = allowlisted projection + `LATTICE_RED_RUN_NONCE`
   (per §1.2, with pinned `PATH` and `resolvedExecutable` checks), cwd = the ADAPTER's `cwd` (audit: rev 4
   said profile cwd here, contradicting §1.2 — adapter cwd governs the exercised command; profile cwd
   governs prep only). The adapter cwd MUST be slash-normalized and relative with no `..`/empty segments,
   and its realpath MUST remain inside the disposable workspace, else config-load reject; the receipt `cwd`
   MUST equal this normalized adapter cwd. Capture stdout and stderr on SEPARATE pipes as sequenced chunk
   frames per §1.11.3, persisted in the receipt as `runReceipt.streamFrames` (§1.10). Wall-clock ceiling
   `policy.runTimeoutMs`. **On timeout:** SIGTERM the process GROUP, wait `policy.killGraceMs`, SIGKILL the
   group, reap all descendants — THEN CONTINUE to step 4 (audit: rev 1 made every timeout unrecordable, which
   contradicted `timeout-is-failure`; the POST snapshot is taken after group termination).
4. **Snapshot POST** — capture the four-tuple again.
5. **Assert.** Evaluate INVARIANCE (§2.2), the envelope predicates (§1), and for GREEN the full predicate
   (§1.5). A timed-out RED run is recordable iff `expectedExitClass == "timeout-is-failure"` AND POST was
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
> **R2-3 (binding-equality rejection).** *A red-assert run whose PRE four-tuple does not satisfy
> `pre.headHash == baselineHeadHash AND pre.materialHash == baselineMaterialHash` is aborted; no record is
> written. A green-confirm's `greenHeadHash`/`greenMaterialHash` are BY DEFINITION its receipt PRE values
> (§2.3.3); a green-confirm whose stored green hashes differ from its receipt PRE is rejected.*
>
> **R2-4 (prep-invariance rejection).** *A run whose PRE snapshot fails §2.3.3(i) — head or index changed
> since CLEAN, or the filtered `gitStatus` differing from CLEAN (any non-ignored, non-excluded path created
> or modified by preparation, which includes every tracked material path) — is aborted; no record is
> written. A record omitting the CLEAN snapshot is REJECTED.* Preparation can never place doctored
> acceptance-material bytes under the exercise.

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
| `quarantine` | `recover` (undo a mistaken quarantine, §4.1); `red-assert` (the DELIBERATE REPLACEMENT rule: retire-and-replace is the intended bad-record flow — a fresh assertion may follow a quarantine without recovering the quarantined record) |

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

> `red-assert`:    `operationKey = CANON({ operation, storyId, acceptanceTargetRef, baselineHeadHash,
>                   baselineMaterialHash, specDigest, assertionDigest, policyDigest })`
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
  (§1.1.3), derives the §3.4 red-assert operation key and performs the §3.5 dedupe search FIRST, verifies
  transition legality (§3.3 table), executes the RED run via the runner protocol (§2.3 with `<RUN-HEAD>` =
  the claimed `baselineHeadHash`), evaluates R1-4/R2-* against the receipt, and appends. Supersedes the v1
  `red_evidence_create` (retired at adoption, §6).
- **`red_evidence_green_confirm(storyId, acceptanceTargetRef)`** — creates a `green-confirm` record, in
  this ORDER (audit round 5: the key must exist before any run, so the candidate binding is captured
  first): (1) capture the **pre-run candidate binding** from the live story tree — `candidateHead := git
  rev-parse HEAD`, `candidateMaterial := currentMaterialHash(gitCwd, 'HEAD', metadataRoot)`; (2) resolve
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
`resolveAgentMutationAuthority` plus the lease `sessionId` (serialized as `<actor>@<sessionId>`; stored on
the record and covered by `recordDigest` — deliberately NOT part of the §3.4 operation key, so a
replacement session can retry a lost response and dedupe correctly) — a free-form `approvedBy` argument is
not accepted. Known
limitation (program plan W0.3): the owner lease is not yet a mutex for same-owner concurrent commands; the
W2 implementation MUST serialize ALL FOUR append operations under the same atomic claim discipline the
transition orchestrator uses (the `mkdir`-claim pattern of B-d877 R3, visible at
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
against those consumers, not against line 775.

**W2-normative restatement (mechanically defined — the quoted sentence above is the program plan's claim,
carried for program traceability; W2 itself commits to exactly two separable facts):**
1. Review-round identity is minted on each REVIEW entry (`story.currentReviewRound = now`,
   transition-orchestrator.ts:775) — nothing more is inferred from it.
2. RED-evidence freshness is EXCLUSIVELY the §5.3 hash algorithm; it consumes NO review-round identity.
   Cross-round reuse is governed solely by §5.3.

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
- **`provenance`** ∈ `{ "v2", "legacy-manifest", "none" }` — whether the answer derives from a v2 chain, a
  manifest-grandfathered legacy record (§6), or no records at all.
- **`freshness`** — the head's bound hashes, the resolution `mode`, `liveMatch`, and the `reason` code from
  the §5.3 algorithm.

**State-specific response variants (audit: rev 2's single shape was unsatisfiable for `none` and silent for
legacy drift):** for `status: "none"` the response carries `chainHeadRecordId: null`,
`provenance: "none"`, and `freshness: null` (there is no binding to resolve). For a legacy head whose FRESH
run yields `liveMatch: false`, the response is exactly
`{ status: "active", verdict: "indeterminate", provenance: "legacy-manifest", freshness: { ..., liveMatch: false } }`
— freshness mismatch overrides `legacy-unverified` the same way it overrides GREEN/RED (§5.3). Every other
success state carries all fields non-null.

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
existing function `currentMaterialHash(gitCwd, ref = 'HEAD', metadataRoot = gitCwd)` (actual signature)
(`packages/main/src/core/evidence-freshness.ts` — the function already used at
`packages/main/src/handlers/proofstory.ts:969` and `transition-orchestrator.ts:873`). W2 does not define a new
material classification; the material set is whatever that function (post-W1 snapshot policy) hashes.
**Shared classifier (audit: `currentMaterialHash` hashes the HEAD tree and does not itself classify
untracked paths; formal-review F-001: the dirty filter binds to the classification the hash ACTUALLY
applies):** the dirty filter uses EXACTLY the material classification `currentMaterialHash` applies today:
the path-based exclusion predicate `isMaterialExcludedPath(path, metadataRoot)`
(`packages/main/src/core/evidence-freshness.ts:163-165`, applied inside `currentMaterialHash` at
`evidence-freshness.ts:502`). A path is material for the dirty filter iff `isMaterialExcludedPath` returns
FALSE — the same rule by which the hash includes tree entries; being purely path-based, it classifies ANY
path, tracked or not. The single-shared-predicate requirement is that the step-3 dirty filter MUST call
this SAME function — never a reimplementation and never a different policy (consistent with §2.1.2: W2
reuses the material-hash function verbatim and does not redefine this global freshness primitive). Any
future unification of `isMaterialExcludedPath` with W1's `resolveMaterialCodePolicy`
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
  3. PARTITION the target's records SOLELY by exact `schemaVersion` string (audit:
     "valid-shaped" pre-validation made the error class implementation-dependent):
     V2 := records with schemaVersion "proofstory.red_evidence.v2"; V1 := records
     with "proofstory.red_evidence.v1". ALL shape validation is deferred: a
     V2-version record failing shape dies as "corrupt-chain" in step 5a; a record
     with any other/missing schemaVersion               → error "unsupported-schema"
  4. Route (audit: rev 2 sent legacy-only stories into v2 chain validation, where
     v1 records — having no seq/digests — always died as "corrupt-chain"):
       V2 empty AND V1 empty  → ok { status:"none", verdict:"RED",
                                     chainHeadRecordId:null, provenance:"none", freshness:null }
       V2 empty AND V1 nonempty → legacy path (step 7)
       V2 nonempty              → v2 path (step 5); V1 records for the target are
                                  then unreachable through the query (§6.3)
  5. Validate the v2 target chain — TWO mandatory layers (audit: chain-shape checks
     alone let a canonically-hashed but semantically invalid record reach verdicts):
     5a. validateV2Record (each record): operation-specific schema completeness
         (§1.10 field sets); recordDigest recomputes; specDigest / policyDigest /
         assertionDigest recompute over their pinned subobjects (for the run
         records carrying them — control records omit them, §1.10); operationKey
         recomputes over its §3.4 preimage and recordId matches its derivation;
         run records: CLEAN snapshot present AND the three §2.3.3(i)
         prep-invariance equalities hold — pre.headHash == clean.headHash,
         pre.indexState == clean.indexState, pre.gitStatus == clean.gitStatus
         (violation detail "R2-4"); receipt pre==post (R2-1),
         red-assert baseline==receipt PRE (R2-3), transcript STRUCTURALLY valid
         (§1.10 trust scope: shape, full matcher coverage, boolean/conjunct
         consistency — not stream re-derivation); binding-digest resolution is
         operation-specific (audit: a green-confirm has no assertion subobject to
         inspect), and every comparison uses the 3-field binding subobject with
         createdAt STRIPPED (§1.1.3 digest scope): red-assert — its assertion's
         targetBindingDigest equals the CANON of the stripped binding stored in
         <baselineHeadHash>:.lattice/story/actives/<id>/red-target-bindings.json;
         green-confirm — the targetBindingDigest is RESOLVED via confirmsRecordId
         from the referenced red-assert's assertion and MUST equal the CANON of
         the stripped binding in
         <greenHeadHash>:.lattice/story/actives/<id>/red-target-bindings.json;
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
         verdictRecord is green-confirm → read its evaluationTranscript conjuncts
           (§1.10; structurally validated in 5a) → GREEN iff all five stored
           conjunct booleans are true per the §1.5 mapping table (no negation
           applied), else RED
         verdictRecord is red-assert (incl. superseded status) → RED
         Run FRESH (§5.3) on verdictRecord's binding → may force "indeterminate".
     Return ok with provenance:"v2".
  7. Legacy path. FIRST validate the manifest itself (audit: rev 3 consumed it
     unvalidated): schema check; manifestDigest recomputes; entries unique on
     (storyId, recordId); adoptionCommit resolves in repo history —
       any manifest violation                            → error "corrupt-chain"
                                                           (detail "manifest")
     The answer record is the target's manifest-member v1 record whose manifest
     entry has the HIGHEST entry index (entry order was fixed at adoption from v1
     storage order, §6.2 — a deterministic ordinal, never an author-controlled
     timestamp).
       V1 records NOT in the manifest                    → error "unsupported-schema"
     Verify the answer record's CANON digest equals the manifest entry's recordDigest;
       mismatch                                          → error "corrupt-chain"
     Run FRESH on the v1 baseline hashes:
       liveMatch → ok { status:"active", verdict:"legacy-unverified",
                        provenance:"legacy-manifest" }
       !liveMatch → ok { status:"active", verdict:"indeterminate",
                         provenance:"legacy-manifest" }   (§5.1 variant)
```

**Error taxonomy** (`errorKind` closed enum): `missing-story`, `storage-error`, `corrupt-chain` (with a
`detail` rule id from the 5a/5b lists — stable strings, machine-consumable), `fork-detected`,
`unsupported-schema`. W2 assigns NO gate behavior to errors — the W3 policy decides whether each error
blocks, warns, or escalates (§5.5).

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
   record, `recordDigest` = `CANON` of the v1 record as stored. Entries are unique on `(storyId, recordId)`
   (the migration refuses duplicates) and are ORDERED by each source file's `records[]` storage order at
   adoption — this fixed ordinal is the query's "newest member" tiebreaker (§5.6 step 7), deliberately not
   `createdAt`, which is author-writable.
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
