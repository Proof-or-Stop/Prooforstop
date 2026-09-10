# Trusted RED-to-GREEN Enforcement Program (v38)

Status: **FROZEN AUDIT CANDIDATE**. This v38 candidate preserves the v37 program design and reconciles its
frozen 0.3.296 baseline narrative with the bounded Lab implementation shipped alongside this document. That
Lab slice closes direct post-intake `story_create` entry and nothing else: it does not implement the trusted
RED evidence subsystem, activate the enforcement floor, or complete P1f. The companion remains rev 14 because
this reconciliation changes no companion-owned W2 schema or protocol. The v37 candidate preserved the v36 design and closed documentary round
R31 by aligning companion rev 14 with the complete program lock order, correcting R30's premature companion
scope claim, and tightening the summary GREEN wording to `strict descendant`. v36 preserved the v35 design and closed the recoverability
and lock-order defects found by the fresh but procedurally unrecordable Claude CLI audit documented as R30:
entry-level fence defects are inert instead of poisoning unrelated digest pairs, malformed top-level fence
recovery is owned and bounded, and the global order now places the main write lock explicitly. v35 preserved
the v34 design and repaired lifecycle-review
defects in its durable presentation and verification contract: current audit state is derived only from matching
digests, moving CLI/version observations are no longer restated as current truth, and audit unavailability or
timeout is explicitly blocking. These repairs do not mint a new documentary design round or change a normative
RED/GREEN requirement. v34 was v33 with one presentation-only historical-lineage repair: R28 describes the
retired predecessor path without reproducing that retired spelling in the current truth source. This does not
change the R28 event, its disposition, or any normative requirement. v33 is v32 with one documentary source-citation repair and
no semantic change of its own: §10's two preservation claims now name the records that settled them by
repository path, and the companion made the matching repair in its §6.5 (documentary round **R29** in §14),
so every statement here that described the companion as unchanged at rev 12 is restated against rev 13. v32
was itself v31 plus a documentary reconciliation: the companion spec left the v30-audited bytes for its own
§0.4 path-delegation repair (documentary round **R28** in §14). It preserves v27's answers to the three blocking findings
raised by a fresh independent audit of the exact v26 plan / companion spec rev 8 pair, recorded as documentary
round **R24** in §14: (a) §4 and §4.1 still let a mechanically non-executable Story render the registered
`express-exempt` disposition, so `docsExempt` was still described as an exemption from *authoring*
`verificationIntent` rather than only from baseline RED/characterization, and no replacement policy value,
function contract, user-visible message, process-fact registration, or compatibility disposition for
`EXPRESS_VERIFICATION_EXEMPTION_MESSAGE` was ever defined; (b) the freeze covered a `reproEvidenceBinding`
declaration only through a target descriptor's `verification-intent` source `contentDigest`, so a post-freeze
edit to a declaration carried by a non-descriptor intent item — and every edit to the zero-target docs
declaration, which has no `targets[]` entry at all — moved no frozen digest and was invisible to every
post-DEV boundary evaluator; and (c) §5.3 and §13 said a `characterizationRequired` or executable
manual-observation Story before P2f is "classified correctly but blocked from DEV", which contradicts the
program's own fail-closed rule that P1 writes no classification when a selected required unit cannot be bound,
and left pre-P2e/P2f behavior stated two different ways.

v26 in turn answered R23's three blocking findings and two low cleanups against the exact v25 plan / companion
spec rev 7 pair; v25 was v24 plus one documentary alignment amendment; v24 answered the three defects recorded
as documentary round R22 — the registry projection gap, the policy-namespace gap, and the express
`verificationIntent` conflict; and v24 superseded the v23 candidate and the earlier audited-and-approved v22
document pair.

Audit-record truth, stated exactly here and repeated in §1 and §14, and stated without counting the fence: at
this candidate's byte-freeze the audit document's machine-readable JSON fence recorded **no** entry matching
this plan/companion digest pair, and it records no entry carrying an R21-R31 round label. Entries whose two
digests do not match the current files are historical evidence for their own pairs only. No statement in this candidate depends on
how many entries the fence holds, here or anywhere else — §14's R27 row cites past counts only as
Git-verifiable lineage about superseded bytes, and nothing is derived from them. v26 through v30 did state a
fixed "one historical entry" count, and v30 scoped it to its own byte-freeze rather than dropping it; that
scoped snapshot was still false for the bytes it described, because further approvals had been appended before
the final v30/rev11 pair was frozen (§14, R27). The fence is append-only evidence and may gain a valid entry for these exact
candidate bytes **after** they are frozen; that append does not change either hashed truth-source file. Audit
state is always derived from the live fence by §1 steps 1-5, never from a count restated in prose. R21 through
R29 are documentary and Git-lineage rounds preserved in §14; no fence entry records them, so none is
mechanically latched. At byte-freeze no entry matches the current plan/companion pair and the derived state is `blocked`;
after a valid matching `APPROVE` is appended, and only then, the same immutable pair derives `approved` without
self-invalidating its plan hash. Entries bound to superseded pairs remain history and do not carry forward.
Nothing in this revision is an approval claim. This document is the program design and acceptance truth source; it authorizes
no runtime change and does not claim enforcement is active.

v28 closed v27's documentary plan/companion divergence by advancing the companion to rev 9 and
aligning its §0.5 and §7.3 mirrors with v27's required-intent policy, Story-level declaration-set digest, and
P2f-registry refusal. It also refreshes current-source truth from local `main` 0.3.294 to 0.3.296, gives the
new signed verification-intent amendment/checkpoint surface an explicit non-bypass disposition, and removes
the former direct-DONE historical-import exception so every newly created Story enters at `IDEA|INIT` only.
Those were candidate document changes, not an approval or a runtime claim. A fresh Claude CLI audit of the
exact v28/rev9 pair (`de8a2d8548c4a66ecf35ae01a38b259d1f831da607a86c3ca05ec45d5bd4a122` /
`88638e22015dac31d2e85c9d917b7be20a8862deaadd43ee860f7dd6fa402317`) returned REJECT with two P2
findings, recorded as documentary round R25 in §14: an ambiguous descriptor/declaration JSON-pointer
relation and unowned initial population of required `#/redEvidence` policy. The v29/rev10 pair repaired both
plus the three editorial P3 observations. A fresh audit of that exact pair returned `APPROVE` with
`REQUIRED_CHANGES: NONE`, but was deliberately not written into the machine fence after this agent noticed
the fixed-entry-count self-reference above. The v30/rev11 candidate removed that self-reference and fixed the
audit's three optional P3s.

v31 keeps every v30/rev11 semantic choice and repairs three current-truth defects that this Story's own
lifecycle REVIEW raised against the v30 bytes, recorded as documentary round **R27** in §14: (a) §3 said P4
*changes* the checked-in `reproFirstPreflight` value and *changes* the non-configurable code constant
`REPRO_FIRST_ENFORCEMENT_FLOOR` "from `warn` to `enforce`", but 0.3.296 has neither — the repository's
`proof-or-stop.config.json` carries no `reproFirstPreflight` block and the identifier occurs nowhere in
`packages/` or `scripts/` — so §3 now states introduction and §12's P4 row owns it; (b) §3 asserted in the
present tense that the constant "is a registered process-fact surface" when no `PROCESS_FACT_LEVELS` or
`process-fact-registry.ts` entry names it, so registration is now a P4 deliverable; and (c) the header, §1,
and §14 asserted a fixed one-entry fence snapshot that was false for the final v30 bytes, so every fence-entry
count is now removed rather than re-derived. None of the three defects is mirrored in the companion spec — its
§1.12 already scopes the floor constant to P4 as a target — so v31 introduced no companion change of its own.
The companion then moved independently to **rev 12** under the same Story for an unrelated documentary §0.4
repair, which v32 records as round **R28** in §14. v33 and companion **rev 13** then make one shared
documentary repair, round **R29** in §14: §10 here and §6.5 there deferred to two settled records — the legacy
v1 record-validation audit and the candidate-intake experiment — only as unnamed prose, so neither claim could
be traced to the record that settled it or checked against a later edit of it; both now cite those records by
repository path. Both hashed files therefore differ from the last approved
pair. The current pair is blocked and requires its own fresh matching audit entry.

Baseline: local `main` commit `442f6f38b6c6cb5f89521ddf9f79cabdd065a5c4`, source package version
Proof-or-Stop 0.3.296, inspected on 2026-09-10. Every baseline statement below is scoped to those immutable
bytes and was checked against authoritative `packages/main/src` and configuration at that commit. Later local,
worktree, built, or globally installed versions do not alter that historical baseline and must be queried afresh
by each implementation Story rather than restated here as current truth.

Independent audit record: `docs/audits/repro-first-gate-enforce-plan-claude-audit.md`.

Next implementation Stories after approval: **P0m — registry component-mapping foundation** and **P0p —
policy-namespace runtime foundation**. They are independent of each other and may run in either order or
concurrently, and both precede P1. Do not start either until the audit-state rule below resolves to
`approved`; the current design audit precedes all implementation.

## 1. Authority and audit state

This plan is authoritative for program scope, applicability, sequencing, lifecycle enforcement points, migration, rollout, and acceptance. The companion `red-evidence-subsystem-spec.md` is authoritative for the lower-level v2 envelope, runner, chain, operation, and query semantics where it does not conflict with this plan. A conflict blocks implementation until both documents are reconciled and the plan is re-audited.

The audit record contains exactly one machine-readable JSON fence with this schema:

```json
{
  "schemaVersion": "proof-or-stop.repro-first-plan-audit.v1",
  "entries": [
    {
      "planSha256": "<lowercase sha256 of exact plan bytes>",
      "companionSpecSha256": "<lowercase sha256 of exact companion-spec bytes>",
      "verdict": "<APPROVE|REJECT>",
      "auditor": "Claude CLI",
      "auditorVersion": "<version>",
      "model": "<model>",
      "mode": "read-only",
      "recordedAt": "<ISO-8601>",
      "rawResponseEncoding": "base64",
      "rawResponseBase64": "<base64 of exact stdout bytes>",
      "rawResponseSha256": "<lowercase sha256 of decoded stdout bytes>"
    }
  ]
}
```

The documentary audit state is reproducibly derived, not hand-edited:

1. `shasum -a 256 docs/requirements/decisions/repro-first-gate-enforce-execution-plan.md docs/requirements/decisions/red-evidence-subsystem-spec.md` computes both document digests over exact bytes.
2. Decode each entry's `rawResponseBase64`; hash the decoded bytes with `shasum -a 256` and require equality with `rawResponseSha256`.
3. Validate the JSON fence's top-level shape against the exact schema above. An unparseable fence, an unknown
   or missing top-level key, or a wrong top-level type blocks the whole audit document. Validate each array
   member independently against the entry schema. An entry with an unknown/missing key, invalid type, failed
   raw-response digest/header binding, or membership in a duplicate semantic group is **ineligible** and is
   excluded from step 4; it can never approve or reject any pair and does not poison an unrelated digest pair.
   A duplicate semantic group is two or more entries equal on `(planSha256, companionSpecSha256, auditor,
   auditorVersion, model, rawResponseSha256)`; `recordedAt` is deliberately excluded, so re-recording the same
   auditor response produces no eligible entry even with a new timestamp. A fresh independent/corroborating
   response has a distinct `rawResponseSha256` and is not a duplicate. Normalize CRLF to LF
   for response parsing only; the recorded response digest remains over the original decoded bytes. The
   decoded response must start with exactly one line matching `^VERDICT: (APPROVE|REJECT)$` and contain
   exactly one line matching `^PLAN_SHA256: [0-9a-f]{64}$` and one line matching
   `^COMPANION_SPEC_SHA256: [0-9a-f]{64}$`. These are the three required response header fields; later
   `SUMMARY`, `FINDINGS`, `REQUIRED_CHANGES`, `EVIDENCE_CHECKED`, and auditor prose lines are allowed and
   remain digest-bound. A missing/duplicate header, a byte before `VERDICT`, or a header value unequal to the
   entry's `verdict`, `planSha256`, or `companionSpecSha256` makes that entry ineligible.
4. From eligible entries only, select entries whose plan and companion digests both equal the current files.
   The state is `approved` when at least one matching entry has verdict `APPROVE` and no matching entry has
   another verdict. Additional independently valid matching `APPROVE` entries are corroboration.
5. No matching eligible entry, any matching eligible `REJECT`, or an invalid/unverified top-level audit fence
   means `blocked`. An ineligible entry is retained as inert history and affects no pair; a valid eligible entry
   for an older digest pair is retained history but does not affect the current pair.

This is a pre-implementation documentary approval check, not yet a runtime process fact. P3c introduces the registered read-only `repro_plan_audit_check` before any lifecycle gate consumes plan-approval state, and registers its typed verdict in `PROCESS_FACT_LEVELS`, `process-fact-registry.ts`, and `scripts/verify-process-fact-contract.mjs`.

Rejection is permanently latched for the rejected document-digest pair: it cannot be withdrawn or overwritten.
Repair requires changing at least one authoritative document, obtaining a new pair, and running a new independent
audit. Valid eligible entries are append-only and are never edited or removed. An ineligible array member remains
inert historical bytes. A top-level parse/schema failure is repaired only by the Story Owner in a fresh docs Story:
restore the most recent Git-reachable valid fence, preserve the malformed before-bytes digest and the restoring
commit in narrative outside the fence, obtain independent docs and concept review, and run a fresh Claude audit.
That recovery may remove only non-entry malformed bytes and may never edit or remove a previously valid eligible
entry. Any edit to either authoritative document invalidates approval until a new matching audit entry exists.
If Claude CLI is unavailable, times out, cannot read both authoritative files fully, cannot independently hash
both files, or cannot emit one syntactically valid bound response, no entry is appended and the current pair
remains `blocked`; recovery is a fresh independent session, never a narrative approval.

**The latch above is mechanical only for entries actually recorded in the machine-readable fence.** Steps 1-5
read the live fence and nothing else: a verdict that no entry records is invisible to this derivation. No
fence entry carries an R21 through R31 round label, so all of those rounds are documentary only. No statement
in this candidate depends on how many entries the fence holds: a count frozen into prose goes stale the moment
a valid entry is appended, and v30's freeze-scoped count was already false for its own final bytes (§14, R27).
A later append for the exact unchanged current pair is expected and changes the derived state
according to steps 1-5 alone. Any claim about a current count outside that derivation is non-authoritative. An unrecorded rejection is never mechanically
latched, a documentary round is never approval, and the only way for the immutable current pair to leave
`blocked` is a new valid matching `APPROVE` entry with no matching rejection.

### 1.1 Companion reconciliation state

The plan/companion authority split above is unchanged: the companion spec is authoritative for v2 envelope,
runner, chain, operation, and query semantics; it is **not** authoritative for lifecycle applicability, and
its express-`verificationIntent` paragraphs are explicitly written as mirrors of the plan rule they restate.
v27 retired that plan rule (§4 below), making those mirrors stale documentary text. v28 paired with companion
rev 9 to perform the three alignment changes below; rev 10 preserved them and added the R25 pointer and
policy-population repairs; this v37 candidate pairs with companion **rev 14**, which preserves rev 13's source
citation repair, rev 12's §0.4 path delegation, and rev 11's META compatibility-phase clarification while
aligning the program lock order:

1. **§0.5**, "Verification evidence binding" term — the paragraph that restates the v26 obligation-discriminated
   express rule, including "may retain `docsExempt` and render the re-scoped `express-exempt` disposition" and
   the typed name `express-verification-intent-required`.
2. **§7.3**, "Express behavior, stated consistently with §0.5's three-step rule" — the same mirror at the
   authoring-schema level, including the `flow-policy:express-verification-policy` re-scoping sentence.
3. **§7.3** carries the mirrors rev 9 added and rev 10 through rev 14 preserve: the Story-level `evidenceDeclarationSetDigest`
   preimage and its post-DEV recomputation (§4 and §4.1 below), and the typed
   `p2f-contract-registry-unavailable` refusal for an `execution:"p2f-artifact"` declaration (§4.1 and §5.3
   below).

v31's own three R27 repairs touch §3, §12, and the audit-lineage prose, none of which the companion mirrors,
so they moved no companion byte. The companion nevertheless left the v30-audited bytes for an independent
reason: R28 repaired its §0.4 to state the path delegation its own Story acceptance text promised. R29 then
moved both files together — §10 here and §6.5 there now name the legacy v1 record-validation audit and the
candidate-intake experiment by repository path. Companion rev 14 then aligns §4.1 and §7.2 with plan §8's
complete program lock order. Both
hashed files therefore differ from the last approved pair and both go through the same joint re-audit.

The plan and companion candidate bytes now agree on those mirrors and on R25's repairs, so the v27 conflict is closed. That
reconciliation alone does **not** grant approval: at byte-freeze §1 step 5 resolves `blocked` because no audit
entry matches the current plan/companion digest pair. Both documents must be audited together as that exact pair before any
implementation row begins. Recording this reconciliation is not an approval.

## 2. Required outcome

Every Story that intends to change executable behavior must prove a trusted failure-before-fix and the same
target's success-after-fix. Behavior-preserving executable work proves characterization instead, and only
machine-confirmed non-executable work may be exempt. The applicable path is mechanically classified as exactly one of:

| Obligation | Meaning | Required pre-implementation proof | Required completion proof |
|---|---|---|---|
| `redRequired` | Bug, feature, performance claim, gate, workflow, state machine, build, configuration behavior, runtime behavior, generated executable contract, or another executable acceptance target | Trusted RED at the baseline commit | Same-assertion GREEN at a descendant commit, plus risk-selected regression evidence |
| `characterizationRequired` | Behavior-preserving refactor or an acceptance target whose intended current behavior must remain invariant | Trusted characterization at the baseline commit; it must fail if the protected behavior is deliberately perturbed | The identical characterization remains green after the change |
| `docsExempt` | Fresh machine analysis proves that the Story has no executable or material acceptance target | Signed exemption classification and the normal documentation truth-source checks | Independent docs/concept review, validation, and normal lifecycle evidence |

Story `type`, labels, title, prose, a caller-authored bypass reason, a workflow channel, a checklist item
count, or a file extension alone can never grant `docsExempt`.

**`docsExempt` is exempt from baseline RED/characterization only.** It is never an exemption from authoring
`verificationIntent`. A `docsExempt` Story still selects the `docs-consistency` evidence unit of §7, and that
unit still requires an authored intent item carrying the Story-scoped §4.1 declaration. No obligation value,
and no workflow channel, exempts any Story from authoring the intent its selected required units demand; §4's
required-intent policy states the single mechanism.

### 2.1 Interpretation by work type

- A bug or regression reproduces the documented historical failure before repair.
- A feature proves that its acceptance assertion fails on the old implementation before implementation.
- A gate, process, evidence, state-machine, concurrency, or lock change additionally proves adversarial bypass and real-race behavior selected by its risk facts.
- A performance change records a controlled baseline that misses a predeclared threshold, then proves the same benchmark reaches it.
- A pure refactor never fabricates a RED; it uses `characterizationRequired`.
- Pure documentation authoring, documentation review, research, or audit may use `docsExempt` only after the classifier proves the absence of executable/material targets.
- A documentation-labelled Story that changes scripts, configuration, generators, CLI example contracts, executable snippets used by validation, or runtime gates is not exempt.
- Visual or non-deterministic behavior that is executable but cannot be asserted by the bounded mechanical runner remains non-exempt. It uses an attributable characterization or manual-observation protocol with a stable target, captured artifact, reviewer identity, and before/after relation.

## 3. Frozen 0.3.296 baseline and bounded Lab slice

The immutable 0.3.296 baseline did **not** satisfy the required outcome. Unless a bullet explicitly names the
bounded Lab slice, every present-tense implementation statement in this section describes that frozen baseline,
not the release containing v38:

- `resolveReproFirstPreflightMode` in `packages/main/src/core/repro-evidence-binding-gate.ts` currently resolves
  a live three-value `"off" | "warn" | "enforce"` union (`ReproFirstPreflightMode` in that file;
  `ReproFirstPreflightConfig.mode` in `packages/main/src/core/config.ts`) and silently normalizes an absent or
  unrecognized value to `"warn"`; `proof-or-stop.config.json` does not select `reproFirstPreflight.mode: "enforce"`.
- `classifyReproFirstRequirement` only requires repro-first for material-code `bug|feature` Stories or selected high-risk signals. It does not emit the three obligations in §2.
- `classifyTriggers` in `packages/main/src/core/proofstory.ts` marks a material-code-only RED trigger `diagnosticOnly`; it therefore cannot create an enforceable gap by itself.
- `redEvidenceRecordSatisfied` excludes v2 records from the live predicate and accepts shaped v1 caller-authored records through a weaker compatibility predicate.
- The v2 surface currently implements target binding, quarantine/recover, and read-only envelope checking. It does not yet implement `red_evidence_assert`, `red_evidence_green_confirm`, or `redEvidenceGateQuery`.
- At the frozen 0.3.296 baseline, `story_create` accepted direct `PLAN|DEV|REVIEW|TEST|DONE` creation, so it could bypass
  transition-owned facts and even mint a REVIEW round. The exact baseline surface, so the §6 and §13 closure
  lists can be read against it without a gap: the `story_create` schema in
  `packages/main/src/cli/command-catalog.ts` admits `phase` from the enum
  `IDEA|INIT|INIT_CHECK|PLAN|DEV|REVIEW|TEST|DONE`, and the handler in
  `packages/main/src/handlers/story-create.ts` refuses only `INIT_CHECK`
  (`story_create_direct_init_check_forbidden`). **`DISCARDED` is not a member of that enum today**, so it is
  was rejected as an unknown schema value rather than by any dedicated lifecycle refusal. P1f closes
  direct `INIT_CHECK|PLAN|DEV|REVIEW|TEST` and additionally names `DISCARDED` explicitly in its refusal list
  alongside every unknown value, so the closure is total today and stays total if that enum is ever widened;
  §6 and §13 state the same list. P1f removes direct DONE as well: historical material may be imported only
  through a separately designed, non-Story migration surface, never by constructing a terminal Story.
- A prior bounded local Lab candidate on branch `codex/lab-repro-first-enforcement-0296` at
  `b0ab33dbdc1e1573e9fa6a4999da076b11be2ad3` already proves one possible closure of that direct-create gap:
  its RED reproduces post-intake phase creation on this 0.3.296 baseline, its GREEN rejects every explicit
  phase except `IDEA|INIT` before persistence, and an independent Claude CLI audit returned PASS. It is not
  merged into `main`, is not formal Story evidence, and changes no current-truth statement or workstream
  completion claim. P1f may adopt or supersede that candidate only through its own governed scope, review,
  tests, and local-main integration evidence.
- The bounded Lab release containing v38 adopts only that direct-entry closure against local-main 0.3.306:
  the public `story_create` schema accepts explicit `IDEA|INIT` only and returns
  `story_create_direct_lifecycle_phase_forbidden` for every post-intake enum value; the handler independently
  refuses `INIT_CHECK|PLAN|DEV|REVIEW|TEST|DONE` before persistence; terminal fixtures use fixture-only state
  setup; and CLI, handler, adversarial no-persistence, and real-process concurrency regressions cover the
  boundary. This is a partial P1f implementation and is not evidence that any other P1f requirement or any
  trusted RED/GREEN program workstream is complete or active.
- Lab records are local maintenance evidence only. They are not formal Story RED, GREEN, REVIEW, TEST, DONE, or product-release evidence.
- 0.3.296 adds owner-only signed `verification_intent_append` in DEV, signed INIT/PLAN intent revisions,
  retained Git-anchored intent checkpoints, and `verification_intent_recover`. Canonical checklist reads
  verify this lineage, but the current append schema admits only `{id,desc,type,priority:"must"}` and cannot
  carry `reproEvidenceBinding`; none of these records is execution evidence or baseline RED. P1 must therefore
  preserve the signed history while refusing any post-freeze append/revision that would add, remove, move, or
  alter a repro declaration or acceptance target. The current ordinary-verification repair path is not a
  repro-classification mutation authority.
- 0.3.296 also adds `executionImplementationIdentity` transport/receipt binding and durable complete
  selector-output objects for ordinary verification execution. These are reusable primitives, not v2 RED
  records: P2b/P2c/P3b may reuse their implementation-identity and output-integrity mechanisms only after
  proving the companion envelope, frozen adapter command, four-tuple invariance, and RED/GREEN predicates;
  package-version equality, bounded output tails, or an ordinary verification receipt cannot substitute.
- `ProcessFactKind` and `PROCESS_FACT_REGISTRY` currently have no `serialization-boundary` kind or entries;
  P1 owns adding that kind and registering every production lock/lease that concurrency evidence may target.
- **The registry projections this plan consumes do not exist yet.** `ProcessFactRegistryEntry` in
  `packages/main/src/core/process-fact-registry.ts` is exactly
  `{ name, kind, semantics, level, lifecycle?, allowedPhases?, rootOnly?, legacy?, gateEvidence?,
  destructiveRisk?, producer, producerSourceRefs?, consumerGate?, consumerSourceRefs?, artifact?,
  reviewerLane?, rationale }`, where `artifact` is a single `ProcessFactArtifactRef`
  (`{ name, path, signed, signature?, producerCommand?, consumerGate?, reviewerLane? }`). There is no
  `factId`, no `paths` array, no `componentId`, no `serializationBoundaryId`, and no `generatedFrom` member;
  `producerSourceRefs`/`consumerSourceRefs` are optional advisory source pointers, not a total
  entry-to-component mapping. The 0.3.296 additions register acceptance-history checkpoints, execution
  implementation identity, and complete selector-output integrity, but they do not change that entry shape.
  `RuntimeFactRegistryEntry` in
  `packages/main/src/core/runtime-fact-registry.ts` is exactly
  `{ id, scope, selfSeverity, externalSeverity, checker, outputKey, rationale, driftMessage, repairHint? }`
  over the fixed `REQUIRED_RUNTIME_FACT_IDS` set; it has no `runtimeFactId`, `kind`, `paths`, `componentId`,
  or `generatedFrom` member either. Therefore the §4 `processFactRegistryDigest` /
  `runtimeFactRegistryDigest` classification inputs and the §12 component mapping projections are **not
  computable against 0.3.296** and require the prerequisite workstream P0m below before any consumer exists.
- **The live RED-evidence policy namespace is `proof-or-stop.config.json#/redEvidence`, not
  `#/reproEvidenceV2`.** `ProofOrStopConfig.redEvidence` (`RedEvidencePolicyConfig` in
  `packages/main/src/core/config.ts`) already declares exactly the fourteen policy keys `maxMatchers`,
  `maxMatcherLen`, `minMatcherLen`, `minMatcherEntropyBits`, `runTimeoutMs`, `prepTimeoutMs`, `killGraceMs`,
  `forbiddenCatchAlls`, `forbiddenEnvKeysExtensions`, `invarianceExcludePaths`, `pinnedPath`,
  `matcherClassRegistry`, `runnerAdapterRegistry`, `runnerProfileRegistry`, plus an open index signature so an
  unknown key still reaches the fail-closed resolver. `resolveRedEvidencePolicy` in
  `packages/main/src/core/red-evidence/policy.ts` resolves that block into the exhaustive fourteen-key
  `policySnapshot` with `pinnedPath` required-and-undefaulted, and it has live consumers today:
  `packages/main/src/handlers/red-evidence.ts` reads `loadConfig(root).redEvidence`, and
  `packages/main/src/handlers/doctor.ts` renders `resolveRedEvidenceDoctorLine(config.redEvidence)`. No
  `reproEvidenceV2` key exists anywhere in the config type, the resolver, or the checked-in
  `proof-or-stop.config.json`. Separately, the repository-local `proof-or-stop.config.json` currently
  populates **no** `redEvidence` block at all, so the subsystem is presently unconfigured and
  `pinnedPath` is unset; that is an unconfigured-but-live namespace, not a missing one. §4, §7, and §13 of
  this plan therefore name `#/redEvidence`, and companion spec rev 7 names `#/redEvidence` at every normative
  policy root (its §§0.5, 1.2, 1.12), so both documents now name the same root and no plan/companion
  namespace divergence remains outstanding. What P0p still owns is the runtime work: extending
  `RedEvidencePolicyConfig` / `resolveRedEvidencePolicy` in place with the additional keys the v2 contract
  needs and proving the compatibility disposition for already-populated `#/redEvidence` blocks.
- **Express-channel Stories may currently skip PLAN `verificationIntent` entirely.**
  `resolveVerificationIntentPolicy` in `packages/main/src/core/workflow-policy.ts` has the exact current
  signature `(story: ChannelStory, checklist: ChannelChecklist, decision?: ChannelDecision) =>
  VerificationIntentPolicyResolution`; it calls `computeChannel` itself and returns
  `policy: 'express-exempt'` whenever the resolved channel is `express` (no active riskSignals and at most two
  checklist items) and `countVerificationIntentEntries` is zero. The live closed policy union is exactly
  `VerificationIntentPolicyKind = 'express-exempt' | 'explicit-intent' | 'missing-intent'` and the resolution
  is exactly `{ policy, channel, intentCount, message?, reason }`. That exemption is a registered process fact,
  not reviewer prose: `flow-policy:express-verification-policy` is an `L4` entry in
  `packages/main/src/core/process-fact-levels.ts` owned by `core/flow-fact-policy`, whose registered
  `gateConsumer` is "validate verification coverage and story_review PLAN fast-path advisory gate"; the same
  name is a `FLOW_FACT_POLICIES` member in `packages/main/src/core/flow-fact-policy.ts` carrying
  `disposition: 'express-exempt'` and `policyId: 'express-verification-policy'` in the closed
  `FlowFactPolicyId` union; and `EXPRESS_VERIFICATION_EXEMPTION_MESSAGE` in that same file is exactly
  `'Verification policy: express-exempt (channel=express; PLAN verificationIntent intentionally skipped)'`,
  rendered by the `report.total === 0` branch of `renderVerificationCoverage` in
  `packages/main/src/core/verification.ts`. Its current assertions live in
  `packages/main/src/tasks/outcome-semantics-smoke.ts` (express policy value, express channel, and exact
  render equality) and `packages/main/src/tasks/flow-stability-smoke.ts` (registry `kind` and the
  `verification-policy` semantic), and `scripts/verify-process-fact-contract.mjs` prints the
  `express-verification-policy -> express-exempt` flow-policy line. `CLAUDE.md` additionally teaches the
  exemption and quotes that exact message line as required user-visible output.
  Because §4 derives acceptance targets partly from checklist `verificationIntent`, an executable express
  Story can today reach PLAN→DEV with zero authored intents. Retiring quick DEV entry at P1f does **not**
  close this: the express exemption is a separate flow-policy fact on a separate surface. §4's required-intent
  policy and the P1 exit condition below own **retiring it outright**, not narrowing it.
- **The retired `express-exempt` string also appears inside immutable historical evidence, and is never
  rewritten there.** Frozen `done-required-evidence.json` command receipts, `causal-evidence/receipts/*.json`,
  and at least one historical Story's `test-evidence.json` / `checklist.json` under `.proof-or-stop/story/`
  contain `express-exempt` inside hash-bound captured output or frozen Story metadata. Those bytes are
  immutable history: no retirement work re-signs, backfills, or edits them, and the §11 residue assertions
  scope their zero-occurrence requirement to product runtime source, active docs, and host agent mirrors —
  never to immutable evidence artifacts.

The configuration surface is not yet closed today. `proof-or-stop.config.json#/reproFirstPreflight/mode` is
currently typed `"off" | "warn" | "enforce"` and `loadConfig` performs no schema validation of this field:
`resolveReproFirstPreflightMode`'s `mode === 'off' || mode === 'enforce' ? mode : 'warn'` ternary maps every
absent or unrecognized value to `"warn"` and never throws, so no config-load error exists for any value today;
`"off"` is a real, currently live third value consumed by `evaluateStoryEvidenceBindingGate`'s own dedicated
`if (mode === 'off')` early-return branch, not excluded. "Shadow" is not a fourth configuration value: it is
the internal paired-evaluator path that records the candidate verdict while the resolved mode remains `"warn"`.

Neither half of the closed surface exists yet, so P4 **introduces** both rather than mutating them. The
repository's `proof-or-stop.config.json` carries no `reproFirstPreflight` block at all today — reading the
checked-in file and printing that key yields `undefined` — so there is no checked-in mode value to change. The
identifier `REPRO_FIRST_ENFORCEMENT_FLOOR` likewise occurs nowhere under `packages/` or `scripts/`:
`resolveReproFirstPreflightMode` contains no floor concept, only the projectRoot guard and the ternary quoted
above inside a `try`/`catch` that also yields `"warn"`. No entry in `PROCESS_FACT_LEVELS` or
`process-fact-registry.ts` names the constant either; the one registered neighbour is
`runtime:repro_first_story_intake_preflight`, whose rationale still describes the live three-value
`off`/`warn`/`enforce` rollout mode.

P4 is the Story that closes this surface, and §12's P4 row owns every introduction named here. From P4 onward,
`proof-or-stop.config.json#/reproFirstPreflight/mode` accepts exactly `"warn" | "enforce"`; an absent value
resolves to `"warn"` and every other value — including `"off"` and any unrecognized string — is a config-load
error. P4 atomically adds the checked-in `reproFirstPreflight` block with the value `"enforce"` and introduces
the non-configurable code constant `REPRO_FIRST_ENFORCEMENT_FLOOR` at `"enforce"`, registering it as a process
fact in that same Story. Mode resolution then rejects any configured value weaker than that constant with
`repro-enforcement-floor-violation`; it never clamps or falls back. From that registration onward the constant
is a registered process-fact surface, so changing it or the resolver is itself a material gate change governed
by this program. After P4, removing the key or setting `"warn"` therefore fails closed rather than disabling
enforcement.

These statements are baseline diagnostics. The target rules below take effect only through their implementation Stories and the final enforce flip.

## 4. Applicability classifier

P1 replaces the binary intake classification with one integrity-signed, hash-bound `ReproObligationClassification` snapshot. It is computed from the fresh union of:

1. diff-derived material classification, including language-neutral code and executable manifests;
2. the declared scope contract and all created, modified, tested, and generated paths;
3. acceptance targets and `verificationIntent` semantics;
4. Story type, risk signals, performance claims, state-machine/gate/build/configuration/runtime effects;
5. executable content referenced from documentation or generated by documentation tooling.

The tool-owned P1 writer stores each snapshot as an immutable, integrity-signed, content-addressed artifact at
`<storyDir>/<id>/repro-obligation-classifications/<contentDigest-without-prefix>.json`, schema
`proof-or-stop.repro_obligation_classification.v1`. Snapshots form a per-Story monotonic chain with `seq`,
`supersedesDigest`, and integrity-bound input digests. The writer atomically updates the integrity-signed
`<storyDir>/<id>/repro-obligation-classification-head.json`; the unique valid head is the
only current snapshot and no caller may choose its digest. Before DEV, a new head supersedes predecessors for
new writes and current-verdict evaluation; predecessors remain valid, readable historical bindings and never
become chain corruption. PLAN→DEV freezes the head and binding in the first-class `reproFreezeState` below;
later boundary evaluators recompute current facts directly against that frozen state rather than minting a
second recheck artifact. A stronger result blocks as described below.

The classification chain is per-Story, not per-target: one Story-level snapshot contains all target facts,
one integrity-signed head names its unique current snapshot, and one per-Story classification lock serializes
the chain. The artifact has exactly these keys (unknown or missing keys reject):

`{ schemaVersion, storyId, storyDir, seq, supersedesDigest, obligation, reasonCodes, inputDigests,
classifierDigest, policySnapshot, policyDigest, policyEvolutionContract?, storyBaseHead, frozenScopePaths,
targetCandidates, targets, storyRequiredEvidenceUnits, storyEvidenceBindings, createdAt, contentDigest,
integritySignature }`.

`schemaVersion` is `proof-or-stop.repro_obligation_classification.v1`; `seq` starts at 1 and
`supersedesDigest` is JSON null only at seq 1. `obligation` is the closed §2 enum; `reasonCodes` is a
UTF-8-byte-sorted, duplicate-free non-empty array of registered reason codes. `inputDigests` is exact
`{ scopeAdmissionDigest, scopeContractDigest, originalIntentSnapshotDigest, proofStoryDigest,
checklistDigest, evidenceDeclarationSetDigest, materialClassificationDigest, riskFactsDigest,
processFactRegistryDigest, runtimeFactRegistryDigest }` — exactly ten members, unknown or missing keys reject.
Each member uses the companion-§0.4 `sha256:` rendering and this exact preimage:
scopeAdmissionDigest is the §6 preimage,
scopeContractDigest is SHA-256 of exact committed bytes as defined below,
originalIntentSnapshotDigest/proofStoryDigest/checklistDigest are SHA-256 of the exact named committed file
bytes, and `evidenceDeclarationSetDigest` is the Story-level declaration-set preimage defined in §4.2. The two
checklist-derived members are deliberately different and are checked at different points:
`checklistDigest` is a whole-file byte digest over `<storyDir>/<id>/checklist.json` and moves on any ordinary
`status`, `startTime`, `endTime`, `verificationEvidence`, or `userSeesSnapshot` write, so it is compared only
at DEV admission; `evidenceDeclarationSetDigest` reads only the §4.1 declaration fields and their committed
positions, so it is provably invariant under those ordinary writes and is compared at **every** post-DEV
boundary. `materialClassificationDigest = CANON({ paths, generatedRelationships })`. Before DEV, `paths`
enumerates exactly `frozenScopePaths`; at and after a post-DEV boundary recomputation it enumerates exactly
the union of `frozenScopePaths` and committed Story diff paths from storyBaseHead to the evaluated head. In
both cases, any path for which `isMaterialExcludedPath(path, projectRoot)` is true is excluded, so P1/RED and
PLAN→DEV Story-metadata writes never enter the universe or stale this digest. Here `projectRoot` is the
canonical Story worktree root, byte-identical to the `gitCwd`/`metadataRoot`
realpath pinned for `currentMaterialHash` in companion §2.1.2 and for
`currentReproBoundaryFilesHash` in §7; callers cannot supply an outer checkout or alternate root. The remaining entries are
UTF-8-path-sorted unique exact `{ path, classification, reasonCodes }` objects (`classification` is
`material|verification-only|non-material`, reasonCodes sorted/unique), and
generatedRelationships are exact `{ sourcePath, generatedPath, classification }` entries whose source or
generated path is in that same universe, sorted by source/generated path. `riskFactsDigest = CANON({
riskSignalCategories, processFactCategories, targetKinds, performanceClaims })`, with the three string arrays
UTF-8-sorted/unique and performanceClaims ref-sorted exact
`{ acceptanceTargetRef, comparator, thresholdNs }` entries. `processFactRegistryDigest = CANON([{
factId, kind, paths, componentId?, serializationBoundaryId? },...])` and
`runtimeFactRegistryDigest = CANON([{ runtimeFactId, kind, paths, componentId? },...])`; both are the complete
registry projections at the classification head with no relevance filter, id-sorted with each paths array
normalized/sorted/unique and absent optionals omitted. An unrelated registry edit therefore intentionally
requires reclassification before freeze; after freeze it is evaluated only through the explicit current-fact
and registered-component freshness rules rather than silently changing the frozen digest.

These two members are **whole-registry classification inputs** and are deliberately distinct, both in name and
in preimage, from the **component-filtered mapping projections**
`componentProcessFactMappingDigest` / `componentRuntimeFactMappingDigest` defined in §12 for bootstrap
component manifests. The §4 members cover every registered entry with no `componentId` filter and carry a
sorted `paths` array per entry; the §12 members cover only entries whose `componentId` equals the manifest's
component and carry one flattened `path` per tuple with an optional `generatedFrom`. No digest name in this
program is ever computed over two different preimages, and neither projection may be substituted for the
other.

Both §4 members are **blocked on the P0m prerequisite workstream in §12**. As §3 records, 0.3.296's
`ProcessFactRegistryEntry` and `RuntimeFactRegistryEntry` carry none of `factId`, `runtimeFactId`, `paths`,
`componentId`, `serializationBoundaryId`, or `generatedFrom`, so neither projection is computable today. P0m
is the authoritative owner of that mapping surface and both projection functions; P1 consumes them and may not
re-derive, approximate, or infer a mapping from `producer`, `producerSourceRefs`, `consumerSourceRefs`, or
`artifact.path`. If any registered entry lacks a total, unambiguous mapping at the classification head, P1
fails closed with typed `registry-component-mapping-unavailable`, writes no classification, head, freeze, or
credential, and never substitutes a partial projection or an empty array. The same typed failure applies to
every later consumer of these digests.
`classifierDigest = CANON({
classifierId:"proof-or-stop:repro-obligation-classifier@1", classifierImplementationDigest,
materialClassifierDigest, targetResolverDigest, evidenceSelectorDigest })`; each component digest is
companion-§0.4 SHA-256 over the exact registered built implementation bytes, and P1 registers the bundle/path
mapping in the process-fact registry. `policyDigest = CANON(policySnapshot)`.

`targetCandidates` is sorted by `acceptanceTargetRef` and contains exact
`{ acceptanceTargetRef, descriptor, targetDisposition, dispositionReasonCodes, implementationPaths }`, where
descriptor has the exact form below, targetDisposition is `executable-material|non-executable`, reason codes
are registered/sorted/unique, and paths are normalized/sorted/unique. `targets` is exactly the
`executable-material` candidate projection, sorted by ref, with exact objects
`{ acceptanceTargetRef, descriptor, acceptanceSemanticDigest, baselineHeadHash, baselineMaterialHash,
targetBindingDigest, implementationPaths, requiredEvidenceUnits, evidenceBindings }`;
`acceptanceSemanticDigest = CANON(descriptor)`. `storyRequiredEvidenceUnits` and `storyEvidenceBindings` are
exactly empty for a non-exempt classification; for docsExempt they have the exact zero-target docs forms
below. `policyEvolutionContract` is omitted unless the exact governed case below applies. `createdAt` is a
tool-owned ISO-8601 UTC timestamp. contentDigest/signature use the exact computation and domains below.
The head artifact has exactly
`{ schemaVersion:"proof-or-stop.repro_obligation_classification_head.v1", storyId, storyDir, seq,
classificationDigest, updatedAt, contentDigest, integritySignature }`; classificationDigest is exactly the
pointed snapshot's contentDigest, seq matches it, and updatedAt is tool-owned ISO-8601 UTC.

“Integrity-signed” has one bounded meaning in this program. P1 defines public constants
`REPRO_CLASSIFICATION_INTEGRITY_DOMAIN = "proof-or-stop.repro-obligation-classification.v1"` and
`REPRO_CLASSIFICATION_HEAD_INTEGRITY_DOMAIN = "proof-or-stop.repro-obligation-classification-head.v1"`, and
`REPRO_FREEZE_STATE_INTEGRITY_DOMAIN = "proof-or-stop.repro-freeze-state.v1"`. For each artifact,
`contentDigest` is `sha256:` plus SHA-256 over RFC-8785 CANON of the object with
`contentDigest` and `integritySignature` omitted; `integritySignature` is `sha256:` plus SHA-256 over UTF-8
`<domain>\u0000<CANON(object with integritySignature omitted)>`. Verification recomputes both byte-for-byte.
There is no secret, key, or identity custody: this proves handler-produced content binding and detects casual
edits, not signer identity or resistance to a hostile local writer. P1 uses this exact scheme for these three
artifacts only; §7 explicitly extends the same computation under four distinct P3b domains for verification
and scope-binding receipts/heads. Existing reviewer-run signatures retain their independently registered
scheme and are not redefined here.

The freeze state lives at the exact JSON pointer
`<storyDir>/<id>/index.json#/reproFreezeState`, schema
`proof-or-stop.repro_freeze_state.v1`, with exactly these keys:
`{ schemaVersion, storyId, storyDir, frozenAtPhase, transitionAttemptId, scopeAdmissionDigest, scopeContractDigest, classificationDigest,
frozenAtStoryHeadHash, targets, frozenAt, contentDigest, integritySignature }`. `frozenAtPhase` is exactly
`DEV`; `transitionAttemptId = CANON({ storyId, storyDir, from:"PLAN", to:"DEV", scopeAdmissionDigest,
scopeContractDigest, classificationDigest, frozenAtStoryHeadHash, targets })`; `frozenAt` is tool-owned ISO-8601 UTC. `targets` is a
lexicographically `acceptanceTargetRef`-sorted, duplicate-free array of exact objects
`{ acceptanceTargetRef, classificationDigest, targetBindingDigest, baselineHeadHash,
baselineMaterialHash, acceptanceSemanticDigest }`. It is non-empty for `redRequired`/`characterizationRequired`; for `docsExempt` it is
exactly empty and the integrity-signed zero-target classification is identified by the top-level
`classificationDigest`, which is the Story-level current classification digest for every obligation; every
non-empty target entry's `classificationDigest` MUST equal that top-level value.
Digests and Git ids use the rendering below and companion §0.4. The freeze subobject uses
the public content/integrity computation above and is byte-immutable after DEV.

`<storyDir>` is the normalized repository-relative `storyDir` resolved from the
`proof-or-stop.config.json` in the Git tree being read. P1 stores that exact string in its classification and
the freeze stores it as `storyDir`. Baseline, GREEN, and live lookups each resolve their tree's config first
and MUST equal the frozen value before reading any Story artifact; mismatch is typed `story-dir-drift` and
requires a fresh Story after an explicit repository migration. A Story in this program may not change
`storyDir` underneath its own artifacts. Thus the configurable path has one derivation and a baseline/green
config change cannot silently redirect a binding lookup.

`scopeContractDigest` is `sha256:` plus SHA-256 over the exact bytes of
`<storyDir>/<id>/scope-contract.json` as committed at `frozenAtStoryHeadHash`; no existing
bare-hex `digestScopeContract`, `stableDigest`, or acceptance-basis value is reused. `frozenAtStoryHeadHash`
is the bare repository-format object id from `git rev-parse HEAD` immediately before the atomic `index.json`
replacement, and the referenced committed tree MUST contain the exact scope-contract bytes just hashed.

Only `runStoryTransition`'s PLAN→DEV reference evaluator may write this subobject. While holding the declared
lock order below, it validates the current classification, binding, scope, and applicable baseline proof,
then performs one atomic replacement of `index.json` that changes `phase` from `PLAN` to `DEV` and inserts
the complete freeze subobject. Thus no separate marker/phase crash window exists. The transition rejects if
`reproFreezeState` already exists in PLAN, is absent in DEV or later, fails its integrity checks, or differs
from the frozen targets. `red_evidence_binding_set`, every run/control writer, and the query read frozen-ness
only from this JSON pointer; `red-target-bindings.json` intentionally carries no duplicate frozen flag.

PLAN→DEV orders metadata before capture: while holding the transition/classification/binding/target locks, it
invokes the registered Story-metadata auto-commit for the current scope contract, target bindings,
classification artifacts/head, RED/characterization evidence, and PLAN review facts; it then requires those
paths clean and committed. Any non-metadata dirty path is refused by the existing scope/git gate. Auto-commit
failure returns `repro-plan-metadata-commit-failed` with no freeze or phase write; repair is to resolve the
reported CLI-owned metadata commit failure and retry the transition. Only after success does the evaluator
capture `frozenAtStoryHeadHash`, read/hash the scope contract from that commit, and build the atomic
phase/freeze replacement. P1f includes dirty, successful-auto-commit, and failed-auto-commit fixtures.

P1f installs this writer on the internal shadow evaluator while configured mode remains `warn` after its own PLAN→DEV transition. During shadow rollout the
evaluator always reports a missing or bootstrap proof as a typed gap in the existing transition result but,
provided classification/binding/scope inputs themselves are valid, still writes the freeze state; the freeze
artifact attests only which inputs were frozen, never that evidence was trusted. P2c and later must supply the
trusted proof as a lifecycle acceptance requirement even while the runtime verdict is shadow-only. P4 is the
only change that turns the already-produced typed proof gap into transition refusal; there is no selectable
bootstrap bypass in the enforced evaluator.

P1f activation is its verified merge commit on local `main`, recorded by the existing DONE/post-merge
process event. The new writer, direct-phase refusals, quick-path refusal, and adoption inventory take effect
only from that commit; therefore the P1f Story itself completes under pre-adoption behavior and is terminal
before the scan. The scan covers every other nonterminal Story: PLAN without `scopeAdmissionDigest` becomes
`repro-admission-migration-required`, DEV or later without freeze becomes
`repro-freeze-migration-required`, and `TEST_CASE|TEST_CASE_REVIEW|META` becomes
`legacy-lifecycle-migration-required`. `META` has no registered transition edge and can never reach a gate;
the scan still names it so the baseline phase union is total. No title, label, or Story-provided flag can move
the activation point.

Classification append, head resolution, deduplication, and integrity-signed-pointer replacement share one canonical
per-Story classification lock with compare-and-swap on prior digest/sequence. The pointer is written
atomically and fsynced before release; concurrent classifiers either return the same idempotent snapshot or
one loses the CAS and re-evaluates. P1 includes a real-process fork/pointer-race fixture.

A classification is fresh only when its content digest/integrity signature validate, its `seq`/`supersedesDigest` per-Story chain has one
head equal to the integrity-signed head pointer, its PLAN input digests still match at DEV admission, and each
post-DEV boundary evaluator directly recomputes current head/material/scope facts and reruns
`resolveExpectedRedTargetDescriptors` against `reproFreezeState` inside the transition lock. The normalized current
target-ref set MUST equal the frozen `targets[].acceptanceTargetRef` set exactly; widening, narrowing, or
replacement after freeze returns `acceptance-target-set-drift-after-freeze`, leaves phase and credentials
unchanged, and requires moving the work to a fresh Story/branch. A new target can never be silently omitted
from gate quantification or retrofitted into the immutable freeze. For every unchanged ref, the evaluator
also recomputes `acceptanceSemanticDigest` and requires equality with its frozen target entry; any in-place
acceptance, intent, milestone, request, or evidence-binding change returns
`acceptance-target-semantics-drift-after-freeze` with the same unchanged-phase/fresh-Story repair. Missing, forked,
superseded, mismatched, or stale classification state blocks.

Every post-DEV boundary evaluator additionally recomputes the Story-level `evidenceDeclarationSetDigest` of
§4.2 from the current committed checklist metadata and requires exact equality with the value frozen in the
classification's `inputDigests`. This conjunct is **unconditional**: it applies to `redRequired`,
`characterizationRequired`, and empty-target `docsExempt` freezes alike, and it runs in addition to — never
instead of — the target-set and per-target `acceptanceSemanticDigest` comparisons. Any inequality returns
`acceptance-target-semantics-drift-after-freeze` with phase and credentials unchanged and repair on a fresh
Story. It exists because the per-target `acceptanceSemanticDigest` binds a declaration only through the
`verification-intent` descriptor source that names it, so without this conjunct a declaration carried by a
non-descriptor intent item, and every edit to the Story-scoped zero-target docs declaration, would move no
frozen digest at all.

The post-DEV target-set equality above applies to non-empty `redRequired` and
`characterizationRequired` freezes. For an empty-target docsExempt freeze, the evaluator instead reruns the
complete P1 candidate classification against current committed inputs and requires the recomputed obligation
to remain `docsExempt`, every candidate to remain `targetDisposition:"non-executable"`, and the recomputed
executable/material target projection to remain empty; it also applies the unconditional
`evidenceDeclarationSetDigest` conjunct above, which is the only mechanism that binds that freeze's single
Story-scoped `docs-consistency` declaration. Raw non-executable documentation acceptance refs are
not compared with `reproFreezeState.targets`. If any candidate becomes executable/material, the evaluator
returns `docs-exemption-invalidated-after-freeze`, leaves phase/credentials unchanged, and requires a fresh
Story with baseline proof; this is distinct from ordinary target-set drift and from declaration-set drift, and
the three typed outcomes never substitute for one another.

P1 captures the baseline head before writing its own
metadata commit; the baseline must already contain the committed target binding and reproduction test. The
snapshot is never resolved from its own baseline tree. Writers and queries load it by recorded digest, verify
its integrity signature, content digest, and current-head/frozen status, and retain older snapshots only as invalidated
history. The classifier returns one obligation, reason codes, the inputs' digests, the full resolved
companion-§1.2 `policySnapshot`, `policyDigest = CANON(policySnapshot)`,
normalized `storyDir`, top-level `frozenScopePaths`, and per-target entries containing exact
`baselineHeadHash`, `baselineMaterialHash`, committed `targetBindingDigest`, `acceptanceSemanticDigest`,
`implementationPaths`, `requiredEvidenceUnits`, and `evidenceBindings` captured at the current PLAN head. `frozenScopePaths` is the
normalized, UTF-8-byte-sorted, duplicate-free union of every admitted path in the exact scope-contract bytes;
`implementationPaths` is the similarly normalized target subset selected by the material classifier.
The top-level snapshot also stores `storyBaseHead`. P1 adds the immutable tool-owned
`index.json#/storyBaseHead` at INIT_CHECK worktree creation as the bare commit returned by
`git rev-parse refs/heads/main^{commit}` under the main write lock immediately before `git worktree add`; the created Story branch must point
to that exact commit before the receipt/index update succeeds. P1 reads that field, verifies it is an ancestor
of the PLAN head and the recorded branch creation point, and supplies it as `explicitBaseHead` to the Story
changed-file resolver. It is frozen with the classification and never re-derived from a moving local `main`
ref. Missing, invalid, non-ancestor, or mismatched base state is `story-base-head-unverifiable` and blocks P1.

P1 first runs `resolveAcceptanceTargetCandidates` over every ref-only source. It assigns each candidate the
exact targetDisposition recorded in the schema by applying the same registered material classifier to the
source subobject, resolved verification type/adapter, target paths, executable snippets, generated outputs,
and affected process/runtime facts. `non-executable` is permitted only when all resolved paths are
non-material, no registered executable runner/P2f target or generated executable output is referenced, and
no affected process/runtime fact exists; unknown/unreadable inputs fail closed as executable-material.
`resolveExpectedRedTargetDescriptors` returns exactly the `executable-material` projection. Each descriptor is exact
`{ acceptanceTargetRef, sources }`, where `sources` is a UTF-8-byte-sorted, duplicate-free array of exact
`{ sourceKind, sourcePointer, contentDigest }`; `sourceKind` is
`acceptance-binding|verification-intent|milestone|request`, `sourcePointer` is its canonical JSON pointer in
the committed PLAN artifact, and `contentDigest` is companion-§0.4 SHA-256 over the exact referenced JSON
subobject. For `sourceKind:"verification-intent"`, the pointer is exactly
`/items/<itemIndex>/verificationIntent/<lane>/<laneIndex>` in committed `checklist.json`, and the referenced
subobject is the complete intent item at that pointer, including its nested `reproEvidenceBinding` when
present. `acceptanceSemanticDigest = CANON(descriptor)`. This derivation, not labels or prose summaries,
defines target identity and semantics.

For each target, `evidenceBindings` is a receipt-key-sorted discriminated array derived from registered
`verificationIntent`: runner units use exact
`{ kind, subtype?, execution:"runner", testCaseRef, adapterId, selector, expectation }`, while
`characterization-perturbation|manual-observation` use exact
`{ kind, subtype?, execution:"p2f-artifact", p2fContractId }`. Runner bindings are validated against the
existing adapter registry; `selector` is a non-empty UTF-8 literal-line value expected from that registered
test case, not a regex or shell fragment. P2f bindings must name the independently approved contract id and
cannot carry command fields; if the independently approved P2f contract registry does not exist at the
classification head, or the named id is unresolvable, unapproved, or incompatible with the declared
kind/subtype, P1 fails closed with the single typed `p2f-contract-registry-unavailable` defined in §4.1 and
writes no classification, head, binding, freeze, or credential. **The exact authoring surface these bindings are derived from, its rejection,
uniqueness, association, freeze, and digest rules, and the exact acyclic derivation order are normative in
§4.1 below**; nothing outside §4.1 is an admissible input to this derivation.
For a zero-target docs classification, top-level `storyRequiredEvidenceUnits` is exactly
`[{kind:"docs-consistency"}]` and `storyEvidenceBindings` contains exactly one analogous docs-consistency
runner binding `{ kind:"docs-consistency", execution:"runner", testCaseRef, adapterId, selector,
expectation }`.
A missing, duplicate, ambiguous, or adapter-incompatible required binding blocks
P1; a receipt invocation cannot supply or override any binding field.

A Story whose declared implementation target is the policy surface
`proof-or-stop.config.json#/redEvidence` may freeze one independently reviewed
`policyEvolutionContract` with exact fields
`{ fromPolicyDigest, toPolicySnapshot, toPolicyDigest, changedJsonPointers,
verificationPolicy:"frozen-baseline" }`. Both snapshots satisfy companion §1.2/§1.12; fromPolicyDigest equals
the classification policyDigest, toPolicyDigest equals CANON(toPolicySnapshot), and changedJsonPointers is a
UTF-8-byte-sorted, duplicate-free array of exact pointers beneath `/redEvidence`. PLAN review rejects a
contract for any other target/path or one whose exact snapshot diff is not precisely those pointers.

`/redEvidence` is the single normative policy pointer root for this whole plan: the classification
`policySnapshot`, `policyDigest`, this contract's `changedJsonPointers`, and every §7 receipt that resolves an
adapter or runner profile all read exactly that root and no other. This plan makes no normative claim about
`#/reproEvidenceV2`, which is not a key of `ProofOrStopConfig` and is not read by any resolver in 0.3.296.
Compatibility and ownership are explicit: **the existing `#/redEvidence` namespace evolves in place**; there
is no new namespace, no dual-read, no alias, and no silent migration of caller configuration. From companion
spec rev 7 onward the companion names this same `/redEvidence` root at every normative policy pointer, so no
plan/companion namespace divergence is outstanding and no evaluator ever has to prefer one document at read
time. P0p owns the remaining runtime and repository-bootstrap work: extending
`resolveRedEvidencePolicy`/`RedEvidencePolicyConfig` in place with whatever additional keys the v2 contract
needs, and materially populating this repository's `proof-or-stop.config.json#/redEvidence` before P1. The
committed block contains `pinnedPath` exactly
`["/opt/homebrew/bin","/usr/local/bin","/usr/bin","/bin"]` and explicitly contains the exact canonical
`matcherClassRegistry`, `runnerAdapterRegistry`, and `runnerProfileRegistry` objects specified in companion
§1.2, rather than relying on an invisible operator setup. P0p proves that the ordered path resolves `npm` for
`node-npm@1` and both `npm` and `node` for the bootstrap adapters on the supported validation hosts; a host
where it resolves neither fails closed and cannot issue evidence. The config bytes are material,
digest-bound, review-visible input to every later P1 policy snapshot. P0p preserves the existing fail-closed
unknown-key rule and proves the compatibility disposition for already-populated `#/redEvidence` blocks. P0p
does not own a further documentary reconciliation and is not blocked on one; running P0p does not
by itself require another edit to this plan. If a future reconciliation instead concludes that a distinct
namespace is required, it must be introduced by an approved, documented migration Story with its own
compatibility disposition for existing
`#/redEvidence` blocks — never by this plan silently naming a namespace that no resolver reads.
The diff recursively compares object keys; a missing key or unequal scalar/array records that member's JSON
Pointer (RFC 6901 escaping), while unequal objects recurse, so the derived set is deterministic.
At each
post-DEV boundary, ordinary Stories require the currently resolved policy digest to equal the frozen
classification's `policyDigest`; a policy-evolution
Story instead requires current config to resolve exactly to toPolicySnapshot/toPolicyDigest or returns
`policy-evolution-contract-mismatch`. Its RED/GREEN and P3b commands still execute under the immutable
baseline policySnapshot, permitting the policy change to prove itself through already-trusted adapters.
After merge, later Stories classify under the new snapshot. There is no live-config fallback or circular
fresh-Story requirement for this one exact governed transition.

`expectation` is also closed and frozen. `happy|edge|regression|adversarial|gate-bypass|docs-consistency`
use exact `{ type:"standard", expectedExitClass:"zero", selectorPolarity:"present" }`. `concurrency` uses
`{ type:"concurrent", serializationBoundaryId, processCount, outcomeCounts,
selectorPolarity:"present" }`, where processCount is
an integer at least 2 and `outcomeCounts` is an exit-class-sorted, duplicate-free array of exact
`{ exitClass, min, max }` entries with non-negative integer bounds, min <= max, and summed minima <=
processCount <= summed maxima. Here `exitClass` is exactly `zero|nonzero|timeout|signal:<name>`, with name
from companion §1.10's closed signal set. `serializationBoundaryId` is selected by P1 from the affected
`PROCESS_FACT_REGISTRY` entries whose registered `kind` is exactly `serialization-boundary`. P1 introduces
that ProcessFactKind and registers the main write lock, Story owner lease, classification/binding/target-chain
locks, P3b receipt-head locks, and their canonical `withMkdirLock` identities. For each affected registered
boundary the selector emits one distinct evidence unit
`{ kind:"concurrency", subtype:<serializationBoundaryId> }`; subtype and expectation id must be equal. A
classification may contain several concurrency units sorted by subtype, but each unit binds one boundary and
produces one receipt. Missing, caller-supplied, duplicate, or non-registered ids block; several distinct
affected ids are mandatory units, not an ambiguity.
`performance` uses exact
`{ type:"benchmark", repetitions, metric:"wall-clock-ns", unit:"ns",
aggregate:"arithmetic-mean", comparator, thresholdNs, varianceRule, expectedExitClass:"zero",
selectorPolarity:"present" }`, with repetitions >= 2, comparator
`lt|lte`, canonical unsigned-decimal-string `thresholdNs` (zero or no leading zero), and exact
varianceRule `{ method:"max-relative-spread-ppm", limitPpm }` where limitPpm is an integer in 0..1000000.
Unknown fields or type/kind mismatch block P1.

The classification metadata commit and every production implementation commit are
descendants of that baseline. Unknown, unreadable, stale, unsigned, conflicting, or
incomplete inputs fail closed to `redRequired`; they never produce `docsExempt`.

For every target P1 computes `baselineMaterialHash` as
`currentMaterialHash(storyWorktreeRoot, baselineHeadHash, storyWorktreeRoot)` and prepends `sha256:` exactly
once to the function's bare lowercase hex return. The disposable runner uses its own temporary worktree root
for both root arguments, and live query uses the Story worktree root for both; each call therefore reads the
`proof-or-stop.config.json` checked out in the same tree. Git head fields remain bare repository-format object
ids. This rendering and root rule is identical to companion spec §§0.4, 2.1.2, and 5.3.

P1 partitions declared paths into `implementationPaths`, `verificationOnlyPaths`, and Story metadata. A
Story-specific production implementation commit is any commit after the Story branch base and at or before
the proposed RED baseline whose material diff intersects `implementationPaths`; pre-existing main history is
not reclassified. `verificationOnlyPaths` must be target tests/harnesses that cannot ship runtime behavior;
generated executable contracts belong to `implementationPaths`. The RED writer rejects a baseline containing
any Story-specific production implementation commit by this predicate.

PLAN gains one registered `proof-or-stop-red-author` role whose mutation authority is limited to declared
`verificationOnlyPaths` plus target-binding metadata. That role may author and commit the reproduction test
before PLAN→DEV freezes the current classification head and binding; it cannot touch `implementationPaths`, alter acceptance targets, or approve
its own binding. This is the only exception to PLAN's no-file-edit rule, and it preserves the stronger
boundary: PLAN permits verification scaffolding, never production implementation.

`docsExempt` is permitted only when the fresh union contains zero executable/material targets **and** the
registered material-diff classifier returns an empty material change set for the Story's declared and actual
scope. A documentation label, non-material candidate refs, or `.md` paths cannot override a material config,
script, generator, executable example, generated output, process fact, or runtime fact. `characterizationRequired` is permitted only when acceptance explicitly requires preserved behavior and no intended behavior change is present. All other executable work is `redRequired`.

P1 runs `resolveAcceptanceTargetCandidates` and its `resolveExpectedRedTargetDescriptors` projection over the registered PLAN artifacts
`original-intent-snapshot.json`, `proofstory.json` acceptance bindings/milestone ledger, and checklist
`verificationIntent`. A `redRequired` or `characterizationRequired` result with an empty target set is the
typed blocker `acceptance-targets-missing`, never vacuous success; repair in PLAN is to establish a concrete
binding/intent target, rerun P1, and produce its baseline proof. Only `docsExempt` may freeze an empty target
array. P1 registers this target-establishment preflight as a PLAN gate.

**The express exemption is retired outright, not narrowed.** §3 records the live exemption; from P1 onward
there is no `express-exempt` disposition, no channel-conditioned verification-intent branch, and no obligation
value that exempts a Story from authoring `verificationIntent`. `docsExempt` is exempt from baseline
RED/characterization only (§2). The replacement is one obligation-driven required-intent policy, evaluated at
one exact point in the §4.1 derivation order, so it is not circular:

**Where it runs.** Immediately after step 3 (`selectRequiredReproEvidence` has produced
`requiredEvidenceUnits` for the resolved obligation) and strictly before step 4 (declaration matching and
binding projection). It therefore consumes the resolved obligation value and the selected required units, and
nothing downstream of itself. It reads no declaration object — only the unit keys that committed declarations
name — no target disposition it could influence, no adapter
registry, no policy snapshot, and no channel. Its result never feeds back into the obligation, the candidate
set, the target set, or the unit set; it can only accept those inputs or block on them. §4.1's derivation
order states the same placement once, as step 3.5.

**Exact closed replacement policy.** The live union
`VerificationIntentPolicyKind = 'express-exempt' | 'explicit-intent' | 'missing-intent'` is replaced in place
by exactly:

```
type VerificationIntentPolicyKind =
  | 'obligation-intent-satisfied'
  | 'obligation-intent-required'
  | 'obligation-unresolved';
```

`'express-exempt'`, `'explicit-intent'`, and `'missing-intent'` cease to exist; no alias, no deprecated
member, and no compatibility value is retained, because none of the three is a stored or signed artifact
member.

**Exact function contract.** `resolveVerificationIntentPolicy` in `packages/main/src/core/workflow-policy.ts`
changes from `(story, checklist, decision?)` to exactly one closed input object, so a caller cannot reach the
resolver without the resolved obligation:

```
export function resolveVerificationIntentPolicy(
  input: VerificationIntentPolicyInput,
): VerificationIntentPolicyResolution;

export interface VerificationIntentPolicyInput {
  storyId: string;
  obligation: ReproObligation | null;            // resolved §2 obligation value; null only when no current
                                                 // integrity-valid classification exists for this Story
  requiredEvidenceUnits: readonly ReproEvidenceUnitRef[];  // step-3 output; exactly [] iff obligation === null
  declaredIntentUnits: readonly ReproEvidenceUnitRef[];    // units the committed §4.1 declarations name
  intentCount: number;                           // countVerificationIntentEntries over committed checklist
}

export interface VerificationIntentPolicyResolution {
  policy: VerificationIntentPolicyKind;
  obligation: ReproObligation | null;
  requiredUnitCount: number;
  declaredUnitCount: number;
  intentCount: number;
  missingUnits: readonly ReproEvidenceUnitRef[]; // non-empty iff policy === 'obligation-intent-required'
  blocker?: 'verification-intent-required';
  message: string;
  reason: string;
}
```

`ReproEvidenceUnitRef` is exactly `{ acceptanceTargetRef?, kind, subtype? }` with `kind` from §7's closed
ten-kind set; `missingUnits` is sorted by UTF-8 bytes of `acceptanceTargetRef` (absent sorts first), then
`kind`, then `subtype`, and is duplicate-free. `channel` is **removed** from both the input and the
resolution: `StoryChannel` and `computeChannel` are untouched and keep every other consumer, but no
verification-intent decision reads them again.

The three results are total and mutually exclusive:

- `'obligation-intent-required'` iff `requiredEvidenceUnits` is non-empty and `intentCount === 0`. It sets
  `blocker: 'verification-intent-required'` and `missingUnits` to every required unit. P1 writes no
  classification, head, binding, freeze, or credential; repair is to author the required `verificationIntent`
  in PLAN and rerun P1.
- `'obligation-intent-satisfied'` iff `requiredEvidenceUnits` is non-empty and `intentCount > 0`. Step 4 then
  decides declaration coverage; a unit left undeclared is `evidence-binding-declaration-missing`, never this
  policy's concern.
- `'obligation-unresolved'` iff `obligation === null`. It is the fail-closed disposition for a caller with no
  current integrity-valid classification — a pre-P1 legacy Story, or a phase before classification. It renders
  the neutral line below, satisfies no gate, and is never an exemption.

Because `docsExempt` always selects the `docs-consistency` unit, `requiredEvidenceUnits` is non-empty for
every obligation; there is no obligation whose required set is empty, and therefore no obligation that reaches
a satisfied result with zero authored intents.

**Blocker disjointness.** The three neighbouring blockers partition the failure space and never absorb one
another: `verification-intent-required` is exactly `intentCount === 0`;
`evidence-binding-declaration-missing` (§4.1) is `intentCount > 0` with a selected unit left undeclared; and
`acceptance-targets-missing` remains the distinct blocker for a `redRequired`/`characterizationRequired` Story
that resolves no concrete target at all. v26's channel-specific `express-verification-intent-required` is
retired with the exemption it named; no channel-qualified blocker code remains anywhere in the program.

**Exact user-visible messages.** `EXPRESS_VERIFICATION_EXEMPTION_MESSAGE` is deleted from
`packages/main/src/core/flow-fact-policy.ts` and replaced by exactly three renderings owned by the same
module, with `<obligation>` the literal §2 obligation value and `<n>`/`<m>` canonical unsigned decimals:

```
VERIFICATION_INTENT_REQUIRED_MESSAGE_TEMPLATE
  Verification policy: intent-required (obligation=<obligation>; requiredUnits=<n>; authored verificationIntent entries=0; blocker verification-intent-required)

VERIFICATION_INTENT_SATISFIED_MESSAGE_TEMPLATE
  Verification policy: intent-satisfied (obligation=<obligation>; requiredUnits=<n>; declaredUnits=<m>)

VERIFICATION_INTENT_OBLIGATION_UNRESOLVED_MESSAGE
  Verification policy: obligation-unresolved (no current repro obligation classification; verificationIntent is not exempt)
```

`renderVerificationCoverage` in `packages/main/src/core/verification.ts` loses its
`policy?.policy === 'express-exempt' && policy.message` branch and renders `policy.message` for whichever of
the three results it was given. No code path renders any exemption line for any channel.

**Registered process fact.** `flow-policy:express-verification-policy` is removed from `FlowFactPolicyId`,
`FLOW_FACT_POLICIES`, and `PROCESS_FACT_LEVELS`, and is replaced by exactly one new registered entry:

- name `flow-policy:obligation-verification-intent-policy`, `policyId`
  `obligation-verification-intent-policy`, level `L4`, category `flow-policy`, owner `core/flow-fact-policy`,
  semantics `['flow-policy', 'verification-policy', 'gate-evidence']`, and **no `disposition` member** — the
  retired entry's `disposition: 'express-exempt'` has no successor because there is no exemption to name.
- rationale: "Every Story authors the verificationIntent its resolved repro obligation's selected required
  evidence units demand. No workflow channel, checklist item count, or obligation value exempts a Story from
  authoring intent; docsExempt is exempt from baseline RED/characterization only."
- `gateConsumer` / `consumerGate`: "P1 repro obligation classification required-intent preflight, validate
  verification coverage rendering, and story_review PLAN advisory gate".

**Compatibility disposition, stated exactly.** The retirement touches renderings, one resolver, and registry
metadata — never stored evidence:

1. `EXPRESS_VERIFICATION_EXEMPTION_MESSAGE`: deleted outright. It is a display string with no artifact,
   signature, or digest domain, so deletion needs no migration and leaves no dangling reference once the
   `renderVerificationCoverage` branch and the smoke assertion below are updated in the same Story.
2. `CLAUDE.md`: P1 rewrites the express-exemption section that currently teaches the exemption and quotes the
   exact retired line as required user-visible output, replacing it with the required-intent policy and the
   three exact messages above. This is inside P1's docs-drift obligation, not a separate Story.
3. `packages/main/src/tasks/outcome-semantics-smoke.ts`: the three express assertions are **inverted, not
   deleted** — an express-channel Story with zero authored intents and a resolved obligation must produce
   `policy === 'obligation-intent-required'`, `blocker === 'verification-intent-required'`, and the exact
   `VERIFICATION_INTENT_REQUIRED_MESSAGE_TEMPLATE` rendering, and no input may produce any exemption line.
   `packages/main/src/tasks/flow-stability-smoke.ts`'s registry assertions move to the replacement name.
4. `scripts/verify-process-fact-contract.mjs`: asserts the retired name and the retired disposition have zero
   occurrences in product runtime source, active docs, and host agent mirrors, and that the replacement entry
   is registered with the rationale and consumer above.
5. Immutable historical evidence is untouched, exactly as §3 records: frozen command receipts, causal-evidence
   receipts, and historical Story metadata that captured the retired string keep it as hash-bound history. No
   zero-occurrence assertion may scan them, and nothing is re-signed or backfilled.

Channel, item count, prose, or a caller-authored flag can never place a Story in the non-executable
`docsExempt` branch, and no branch exempts intent authoring; only the fresh classification decides the
obligation. P1 owns this retirement end to end across `core/workflow-policy.ts`, `core/flow-fact-policy.ts`,
`core/verification.ts`, `core/process-fact-levels.ts`, both smoke tasks,
`scripts/verify-process-fact-contract.mjs`, and `CLAUDE.md`. Until that Story lands, an executable express
Story is a known live gap and no evaluator in this plan may claim otherwise.

The classification and target binding are established and may be superseded/rebound through their legal
pre-freeze paths during PLAN. A trusted baseline proof names the then-current head and binding. PLAN→DEV is
the single freeze point: while holding the classification, binding, target-chain, and transition locks in the
declared global order, the evaluator rechecks the current head/binding, requires the corresponding proof, and
atomically writes `reproFreezeState` with DEV in the same `index.json` replacement. From DEV onward the
classification is rechecked from the committed diff before REVIEW and at TEST/DONE after rebases or material
drift, but no new head or binding replaces the frozen pair; the boundary evaluator uses the frozen subobject
as its comparison source and persists only the existing transition/validation result. The pre-DEV comparison
uses declared scope and acceptance facts because no implementation diff exists yet; the pre-REVIEW comparison
adds the real diff.

A stronger obligation discovered after production implementation is a typed `obligation-escalated-after-implementation` block. The Story cannot cure it with a retroactive RED or emergency token. It must move the implementation to a fresh Story/branch that runs the required baseline proof before its first production commit. It never keeps the weaker obligation or becomes `docsExempt`.

### 4.1 Per-unit evidence-binding authoring schema (`reproEvidenceBinding`)

`evidenceBindings` and `storyEvidenceBindings` are derived, never authored directly. Their sole admissible
input is one closed structured field nested on `VerificationIntentItem`, named `reproEvidenceBinding`. P1 owns
this schema, its CLI surface, and its migration (§11, and the P1 row in §12).

**Where it lives.** `VerificationIntentItem` in `packages/main/src/core/types.ts` is today exactly
`{ id?, desc, type, requiredIn?, priority?, plannedPathDeclarations?, verification? }`, keyed into
`VerificationIntent = Record<VerificationLane, VerificationIntentItem[]>` over
`VerificationLane = 'happy' | 'edge' | 'adversarial'` with
`VerificationIntentType = 'logic' | 'cli' | 'browser' | 'manual' | 'docs'`. P1 adds exactly one optional
member, `reproEvidenceBinding`, and changes no existing member's type or meaning. The authoring object is
exact and closed:

```
reproEvidenceBinding = {
  schemaVersion: "proof-or-stop.repro_evidence_binding_declaration.v1",
  acceptanceTargetRef?,      // required for target scope; omitted only for the zero-target docs case
  kind,                      // one of the ten §7 evidence kinds
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
fragment. Every rejection in this subsection is fail-closed: P1 writes no classification, no head, no
binding, no freeze, and no credential, and never falls back to a partial or empty binding array. As elsewhere
in this program, the Zod schema is the first layer only: the `checklist_update` handler entry and every gate
or function that consumes a declaration re-validate the identical constraints at runtime, so a path that
bypasses schema parsing (an internal call, or previously stored JSON) is rejected on the same terms.

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
frozen earlier in §4 — including `expectedExitClass:"zero"`, `selectorPolarity:"present"`, the
`processCount >= 2` and `outcomeCounts` rules, and the `repetitions >= 2`, comparator,
canonical-decimal `thresholdNs`, and `max-relative-spread-ppm` variance rules — and are not restated with any
variation here.

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
boundary is a process-level fact the P3b runner drives directly. A declaration whose owning lane or whose
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
matched runner unit P1 resolves `adapterId` in the `runnerAdapterRegistry` of the resolved policy snapshot and
matches `testCaseRef` against that adapter's `testCaseRefPattern`; a missing adapter or non-matching ref is
the existing adapter-incompatible block. For a matched `p2f-artifact` unit it verifies the independently
approved contract id, and every failure of that verification is the single typed
`p2f-contract-registry-unavailable`: no independently approved P2f contract registry exists at the
classification head, the declared `p2fContractId` resolves to no registry entry, the entry is not
independently approved, or the entry is incompatible with the declaration's `kind`/`subtype`. Ordering is
deterministic and the codes are disjoint: structural validation runs first, so a wholly absent or wrong-typed
`p2fContractId` member is `evidence-binding-declaration-incomplete`, and every remaining case above is
`p2f-contract-registry-unavailable`. In either case P1 writes no classification, head, binding, freeze, or
credential; there is no "classified but blocked" intermediate state, and no fallback to v1, RED, or
`docsExempt`. §5.3 states the same rule for the pre-P2e/P2f window once. Each accepted declaration is then
projected to its binding by taking exactly its
`{ kind, subtype?, execution, testCaseRef, adapterId, selector, expectation }` members for a runner unit, or
exactly its `{ kind, subtype?, execution, p2fContractId }` members for a P2f unit; `schemaVersion` and
`acceptanceTargetRef` are authoring-envelope members and are **dropped** by the projection, because the ref
becomes the association key and the version governs the authoring surface, not the frozen binding.
`evidenceBindingDigest = CANON(binding)` is computed over that projection and over nothing else, so this
digest name — like every other name in this program — has exactly one preimage. The projected bindings are
sorted by receipt key into the target's `evidenceBindings`, or into top-level `storyEvidenceBindings` for the
zero-target docs case. P3b's §7 lookup reads only these projected bindings; it never reads a declaration.

**PLAN freeze.** Declarations are authored and revised during PLAN like any other PLAN artifact, and are
frozen by the single PLAN→DEV freeze together with the classification that consumed them. Two independent
mechanisms bind them, and both are required because neither alone is total:

1. **Per-target, through the descriptor source digest.** A `verification-intent` descriptor source's
   `contentDigest` is taken over the exact referenced intent-item subobject, so an edit to a nested
   `reproEvidenceBinding` on an item that *is* a descriptor source moves that source digest and therefore
   `acceptanceSemanticDigest`, and the post-DEV boundary evaluator returns
   `acceptance-target-semantics-drift-after-freeze`.
2. **Story-level, through `evidenceDeclarationSetDigest` (§4.2).** That digest covers **every** committed
   declaration — including one carried by an intent item that is not a descriptor source of any target, and
   the Story-scoped zero-target docs declaration, which has no `targets[]` entry to bind at all — and is
   recomputed and compared at every post-DEV boundary. Mechanism 1 alone left both of those cases invisible.

In both cases phase and credentials are unchanged and repair is a fresh Story. There is no post-freeze
declaration edit, waiver, re-derivation, or narrowing path.

**0.3.296 signed-intent amendment compatibility.** P1 preserves and verifies the existing
`verificationIntentAmendments` chain and checkpoint before reading any intent, but neither
`verification_intent_append` nor `verification_intent_recover` is a repro-classification writer. The DEV
append schema remains unable to author `reproEvidenceBinding`; P1 additionally rejects an append whose new
intent ref would enter the acceptance-target candidate set or whose resulting checklist changes any frozen
target, semantic digest, or `evidenceDeclarationSetDigest`. It returns
`acceptance-target-semantics-drift-after-freeze` with no checklist, classification, phase, or credential write
and directs the new acceptance target to a fresh Story with its own baseline proof. Recovery may restore only
the exact already-signed projection and then reruns the same frozen-digest checks; it never blesses changed
bytes, creates a declaration, or refreshes evidence. INIT/PLAN signed revisions remain admissible before the
single PLAN→DEV freeze and naturally move the classification inputs, requiring a fresh current
classification before admission. Tampered, stripped, forked, or mismatched amendment/checkpoint lineage
propagates its existing typed `AMENDMENT_*` integrity error and cannot be collapsed into an empty checklist or
`docsExempt` classification.

**Required-intent behavior, stated consistently with §4's replacement policy.** "Authored, registered, and
adapter-resolvable at PLAN" means the intent item *and* its `reproEvidenceBinding`. The three blockers stay
mechanically distinct so none absorbs another: a Story of **any** channel and **any** obligation whose
committed checklist authors zero `verificationIntent` entries while at least one required unit is selected is
the typed `verification-intent-required` case; a Story that has authored intents but leaves a selected
required unit without a valid matching declaration is `evidence-binding-declaration-missing`; and a
`redRequired`/`characterizationRequired` Story that has authored intents but still resolves no concrete target
is `acceptance-targets-missing`. A mechanically non-executable Story classifies `docsExempt` — exempt from
baseline RED/characterization only — and its one required unit is satisfied by the single Story-scoped
`docs-consistency` declaration above, never by an absent one and never by an exemption. No `express-exempt`
disposition and no channel-qualified blocker exists after P1; channel, item count, prose, or a caller flag
cannot move a Story between obligations or exempt it from authoring intent.

**Legacy `verification` pin: preserved, and fenced out of this derivation.** `VerificationIntentItem.verification`
(`VerificationIntentPin = { command, selector, narrowings? }`) keeps its existing B-ec67 meaning and its
B-1482 narrowing-only semantics for **ordinary verification evidence only**, unchanged in every respect by
this program. It is a separate field with a separate lifecycle, and this program neither extends nor
restricts it. Explicitly: `verification.command` and `verification.selector` are **never** admissible inputs
to repro obligation classification, to any evidence binding, to `commandSpecDigest`, or to any P3b run.
`verification.command` is caller-authored free text, which is exactly why it can never reach the trusted
runner — admitting it would defeat companion R1-5, whose whole content is that the caller cannot choose the
executable. Repro argv comes only from adapter-template resolution against a registered `testCaseRef` under
the frozen policy snapshot, and the repro selector comes only from the frozen `reproEvidenceBinding.selector`.
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
   declaration is not the "registered executable runner/P2f target reference" that the disposition rule tests.
3. `selectRequiredReproEvidence` runs on the resolved obligation, risk facts, target kind, frozen scope paths,
   and material classification, producing `requiredEvidenceUnits`. Declarations are not read.
   3.5. `resolveVerificationIntentPolicy` (§4 above) runs on the resolved obligation value, step 3's selected
   units, the units the committed declarations name, and the committed intent count. It reads no declaration
   *object* and no channel, and its result is consumed by nothing upstream of itself: a
   `verification-intent-required` result blocks P1 outright, and no other result changes the obligation, the
   candidate set, the target set, or the unit set.
4. Declarations are read as objects for the first time and matched one-to-one onto step 3's units, as
   specified above. Runner units resolve their adapter; `p2f-artifact` units resolve their independently
   approved contract id or fail with `p2f-contract-registry-unavailable`.
5. `evidenceDeclarationSetDigest` (§4.2) is computed over every accepted declaration and its committed
   position, and recorded in `inputDigests`. It is a pure function of the declaration objects and their
   positions; it reads no target set, no selector output, no adapter registry, and no policy snapshot.
6. The completed classification artifact — obligation, units, projected bindings, `inputDigests` and all — is
   then content-digested and integrity-signed.

Because no step reads a declaration before the step that produces what it is matched against, authoring a
declaration can never change the obligation, the candidate set, the target set, or the selected unit set. It
can only be accepted against them or rejected by them.

### 4.2 Story-level declaration-set binding (`evidenceDeclarationSetDigest`)

`evidenceDeclarationSetDigest` is the tenth `inputDigests` member of §4 and the only mechanism that binds
**every** §4.1 declaration to the freeze. Its preimage is exact:

```
evidenceDeclarationSetDigest = CANON([{ checklistItemId, intentRef, sourcePointer, scope,
declarationDigest, evidenceBindingDigest },...])
```

Each element is produced from exactly one committed `reproEvidenceBinding` object in
`<storyDir>/<id>/checklist.json`, with exactly these members and no others:

- `checklistItemId` is the exact committed `ChecklistItem.id` of the item carrying the declaration.
- `intentRef` is the intent item's stable ref: its `VerificationIntentItem.id` when present, otherwise the
  derived `<checklistItemId>:<lane>:<laneIndex>` form Proof-or-Stop already uses.
- `sourcePointer` is the RFC-6901 JSON Pointer of the declaration object relative to the committed
  `checklist.json` root, exactly `/items/<itemIndex>/verificationIntent/<lane>/<laneIndex>/reproEvidenceBinding`,
  with `<lane>` from the closed `happy|edge|adversarial` set and both indices canonical unsigned decimals with
  no leading zeros. Where the carrying intent item is also a §4 `verification-intent` descriptor source, the
  declaration pointer is exactly that descriptor pointer extended by the single
  `/reproEvidenceBinding` segment; it is a strict child, never byte-identical. It remains defined for a
  declaration whose intent item is not a descriptor source.
- `scope` is exactly `target:<acceptanceTargetRef>` when the declaration carries `acceptanceTargetRef`, and
  exactly `story` when it omits it. The zero-target docs declaration therefore contributes an element with
  `scope: "story"`, which no per-target digest covers.
- `declarationDigest` is the companion-§0.4 digest of RFC-8785 CANON over the **exact authored declaration
  object with every member retained** — `schemaVersion` and `acceptanceTargetRef` included. Unlike the §4.1
  binding projection, nothing is dropped here, so re-pointing a declaration at a different target or changing
  its `schemaVersion` moves this member.
- `evidenceBindingDigest` is exactly the §4.1 projected binding digest for that declaration, computed over the
  projection alone, so this name keeps its single preimage.

Sorting, duplicates, and totality are exact. Elements sort by UTF-8 bytes of `checklistItemId`, then
`intentRef`, then `sourcePointer`. **No deduplication is performed**: every committed declaration contributes
exactly one element, so adding a second declaration with byte-identical content at a different position moves
the digest rather than collapsing into the first. Two elements sharing one `sourcePointer` is impossible for
well-formed input and rejects with typed `evidence-declaration-set-invalid`. A Story with zero declarations has
`evidenceDeclarationSetDigest = CANON([])`, never omitted and never null, so removing the last declaration
still moves the value.

At PLAN→DEV the digest is frozen exactly like every other `inputDigests` member: it is covered by the
classification's `contentDigest` and `integritySignature`, and therefore by the `classificationDigest` that
`reproFreezeState` names. `reproFreezeState` stores no separate copy, so there is one frozen value and no
second place to keep in sync.

At **every** post-DEV boundary the evaluator recomputes it from the current committed checklist metadata using
only the declaration fields and positions enumerated above, and requires exact equality with the frozen value.
Any edit, addition, removal, or move of any declaration — including one carried by a non-descriptor intent
item, and including the zero-target docs declaration — returns
`acceptance-target-semantics-drift-after-freeze` with phase and credentials unchanged and repair on a fresh
Story.

What provably cannot move it, so ordinary DEV work is not spurious drift: a `status`, `startTime`, `endTime`,
`verificationEvidence`, or `userSeesSnapshot` write, because no such field is in any element's preimage; and an
appended checklist item carrying no declaration, because it adds no element and changes no earlier item's
`<itemIndex>`. That last statement is only about this digest: the independent target-set/semantic checks still
reject the appended item if it contributes an acceptance-target candidate. What does move the declaration
digest, deliberately: appending an item that *does* carry a declaration, and
inserting or reordering committed items ahead of a declaration-bearing item, because that moves a frozen
declaration's committed position. PLAN owns final item ordering; post-freeze reordering is declaration-set
drift by construction, not an exception.

## 5. Trusted RED and GREEN contract

The v2 evidence subsystem is the only normal source of RED/GREEN gate facts after adoption.

### 5.1 RED

A trusted RED must be produced in PLAN after the plan, current classification head, and current target binding
are recorded, but before their single PLAN→DEV freeze and before any production implementation change for
that target. The tool-owned writer:

- resolves the baseline commit and material hash itself;
- requires exact equality with that target's current pre-freeze `ReproObligationClassification.baselineHeadHash`,
  `baselineMaterialHash`, and target-binding digest, and proves the baseline is an ancestor of the Story head;
- reads a committed target binding and policy-owned bounded assertion envelope;
- executes executable-plus-argv through the disposable-workspace runner;
- proves target exercise, expected failure class and matcher specificity;
- records stdout/stderr digests, exit/timeout facts, pre/post workspace invariance, command policy, runner policy, and immutable chain linkage;
- includes the classification digest and target baseline fields in the operation key;
- rejects caller-authored pass/fail, hashes, timestamps, receipts, target-exercised claims, shell strings, forked chains, any other baseline, or a baseline containing a production implementation commit.

For `redRequired`, DEV admission first requires the non-empty target set above, then blocks until every target
has an active trusted `red-assert`; universal quantification over an empty set is never applied. The command
may run during PLAN only through the registered pre-implementation evidence surface; PLAN otherwise retains
its normal no-implementation boundary.

### 5.2 GREEN

A trusted GREEN is a new immutable `green-confirm` record. It must:

- identify the governing RED record and reuse its exact assertion and target binding;
- run on a strict descendant of the RED baseline; separately, P3b's `evaluateReproScopeBinding` requires the RED→GREEN material
  diff to intersect the frozen target implementation paths and rejects any changed material path outside the
  frozen scope contract;
- execute the same derived target command under the RED record's frozen policy;
- satisfy the exact GREEN predicate and workspace invariance rules;
- append atomically to the same target chain.

A different test, matcher, command, target, or independently asserted success is not the GREEN for that RED. Replacing the assertion requires a new RED chain head before further implementation.

### 5.3 Characterization and manual observation

Characterization evidence uses the same trusted-run and immutable binding principles, but proves a stable property at both baseline and descendant rather than pretending the baseline is defective. A manual-observation adapter is permitted only for targets mechanically classified as non-deterministic or visual; it must capture content-addressed before/after artifacts, the observation protocol, target exercise, attributable reviewer identities, and an independent acceptance verdict. It is never a `docsExempt` shortcut.

The current RED-evidence companion spec intentionally defines only `red-assert`, `green-confirm`, `quarantine`, and `recover`; it does not authorize characterization or manual-observation records. P2e must first deliver and independently approve a separate characterization/manual-evidence decision spec defining baseline/confirm operations, schemas, transition legality, idempotency, verdicts, freshness, attribution, query projection, and the handler-resolved baseline/confirm record digests plus runner-measured head/material hashes consumed by the obligation-discriminated scope evaluator below.

**Pre-P2e/P2f behavior is stated once, and it is a P1 refusal — not a classification followed by a DEV
block.** Before an independently approved P2f contract registry exists, a Story whose selector output contains
any `execution:"p2f-artifact"` unit — that is, any `characterization-perturbation` or `manual-observation` unit,
which is every `characterizationRequired` Story and every Story with a mechanically visual/non-deterministic
target — cannot bind that unit, so P1 fails closed at §4.1 step 4 with the single typed
`p2f-contract-registry-unavailable` and **writes no classification, head, binding, freeze, or credential**.
The same code and the same total refusal apply once the registry exists but the declared `p2fContractId` is
unresolvable, unapproved, or incompatible with the declared kind/subtype; a structurally absent or wrong-typed
member remains `evidence-binding-declaration-incomplete`. There is still no fallback to v1, RED, or
`docsExempt`, no phase or credential mutation, and — correcting v25/v26 wording carried here and in §13 — no
state in which such a Story is "classified correctly but blocked from DEV". Its work waits for P2f or moves to a
Story whose targets need no `p2f-artifact` unit.

**Bootstrap remains reachable, and no P2f self-dependency is created.** P2e is a decision-spec authoring
Story: its acceptance targets are documentation, so its fresh classification is `docsExempt`, its single
required unit is the `docs-consistency` unit of §7 with `execution:"runner"`, and it therefore never selects a
`p2f-artifact` unit and is never refused by the code above. It still authors that unit's intent item and the
single Story-scoped `docs-consistency` declaration; `docsExempt` exempts it from baseline
RED/characterization only. P2f is an implementation Story delivering new executable behavior, so its fresh
classification is `redRequired` and its selected units are the runner-executed `happy|edge|regression` base set
plus whatever `adversarial`/`gate-bypass` subtypes its risk facts union — all of which the P2b `red-assert` and
P2c `green-confirm` writers already provide by the time P2f runs. P2f therefore proves itself with
already-available `redRequired` runner evidence and never needs its own output. The fence is explicit: if any
P2f-scoped target ever resolved a `p2f-artifact` unit, the correct outcome is
`p2f-contract-registry-unavailable` and the repair is to move that target to a post-P2f Story — never a
bootstrap exemption, a self-satisfying receipt, or a weaker obligation. P2r, which does consume trusted
characterization chains, runs after P2f, so the registry exists by then.

## 6. Lifecycle enforcement

The complete normal lifecycle remains `INIT → INIT_CHECK → PLAN → DEV → REVIEW → TEST → DONE`.

`reproCompletionReady` is the shared hard predicate at every boundary named below. For each frozen
`redRequired` target, `redEvidenceGateQuery` must return `result:"ok"`, `status:"active"`, `verdict:"GREEN"`,
and `freshness.liveMatch:true`; every other status/verdict/error blocks. For each frozen
`characterizationRequired` target, the P2e-defined `reproCharacterizationGateQuery` must analogously return
`result:"ok"`, `status:"active"`, `verdict:"PRESERVED"`, and `freshness.liveMatch:true`. For every frozen
target of either obligation, the unique current `ReproScopeBindingReceipt` head must be integrity-valid,
fresh, and `result:"scope-bound"`; missing/stale/error/`scope-violation` blocks. For docsExempt, the current
classification must pass the zero-executable/material recheck and the Story-scoped docs-consistency receipt
must be fresh/pass. In all cases, every selector-produced `ReproVerificationReceipt` head must be current,
integrity-valid, fresh, and `result:"pass"`. The predicate returns one typed blocker per failed conjunct and
never treats prose, an older pass, an error, or an empty required target set as success.

| Boundary | Required machine decision |
|---|---|
| IDEA → INIT | This is the only post-P1f route from a draft into the governed lifecycle. |
| IDEA → PLAN (legacy) | P1f refuses it with `repro-init-required`; repair is IDEA→INIT. An already-PLAN Story lacking `scopeAdmissionDigest` is `repro-admission-migration-required` and may only use registered PLAN→INIT REOPEN before proceeding. |
| INIT | Admit the initial scope/execution boundaries. Any extension must use `scope_extension_proposal` plus an independent `scope_extension_decide`; the Owner cannot self-approve. |
| INIT → INIT_CHECK | Existing INIT reviewers and gates require valid `init-check.json`, `scope-boundary.json`, `execution-boundary.json`, `scope-freeze-check.json`, `scope-extension-proposals.json`, and `scope-discard-digest.json`, including every extension decision. |
| INIT_CHECK → PLAN | Require the Story worktree and cwd/owner lease. The evaluator computes the exact `scopeAdmissionDigest` below. PLAN receives it as an immutable classifier input and builds the scope contract within the admitted boundary. A pre-freeze expansion must use registered `PLAN→INIT` REOPEN; after freeze it requires a new Story. |
| INIT_CHECK → DEV (`START` quick path) | From P1f adoption onward reject with `repro-plan-required`; no compliant Story may skip PLAN. An already-active DEV-or-later Story lacking `reproFreezeState` is `repro-freeze-migration-required` and cannot advance; its work must move to a fresh full-lifecycle Story/branch. |
| PLAN | Establish acceptance targets, current bindings, classifier inputs, and the current obligation. Run trusted RED or baseline characterization before production edits; legal pre-freeze supersession/rebinding invalidates the prior proof and requires a new one. |
| PLAN → INIT (`REOPEN`) | Allowed only before any freeze and only through the registered guard. Returning to INIT supersedes the prior `scopeAdmissionDigest`; existing classification/RED records remain readable history but cannot be current or reusable. Scope extension runs through the INIT proposal/decision gates, then INIT_CHECK and PLAN produce new admission, scope-contract, classification, binding, and baseline proof. |
| PLAN → DEV | Under one serialized transition, recheck the admitted scope digest and current classification/binding/proof, then freeze that exact head and binding before persisting DEV. `docsExempt` requires its integrity-signed zero-target proof. |
| DEV | Allow scoped implementation; keep the target binding frozen after PLAN→DEV, including while quarantined. Quarantine may precede a replacement assertion/RED only with the same binding. A bad binding requires a fresh Story/branch. Record GREEN/characterization and all verification evidence through tool-owned writers. |
| DEV → PLAN (`REPLAN` rollback) | If `reproFreezeState` exists, reject with `repro-freeze-rollback-refused`; if it is absent and the Story is migration-required, reject with `repro-freeze-migration-required`. In both cases phase is unchanged. Repair is to continue within a valid frozen Story or discard/rehome missing-freeze work in a fresh Story. The immutable freeze is never deleted, rewritten, or rebound. |
| DEV → REVIEW | Re-evaluate the committed diff against the frozen classification without creating a new head; any stronger/different obligation or target semantic drift blocks and requires a fresh Story. Require `reproCompletionReady`, including GREEN/PRESERVED liveMatch, one fresh `scope-bound` head per frozen target, and a fresh pass head for every selector-produced unit: happy, edge, regression, adversarial subtype, gate-bypass subtype, concurrency, performance, docs-consistency, characterization-perturbation, and manual-observation whenever selected. DEV-issued P2f verifier attestations satisfy manual evidence without using REVIEW run ids. |
| REVIEW | Require current independent lanes, signed runs, registered findings/passes, material freshness, and `reproCompletionReady`; GREEN/PRESERVED, every target's `scope-bound` result, and every selected receipt must still satisfy the exact shared predicate. |
| REVIEW → TEST | Reuse the existing validation transition only when all REVIEW facts remain current; formal docs/concept lanes apply here when selected and are separate from the earlier docs-consistency receipt. Recheck `reproCompletionReady`, including GREEN/PRESERVED liveMatch, every target's `scope-bound` result, and all selected receipt heads. |
| REVIEW → DEV / TEST → DEV | With a valid freeze, preserve the byte-identical `reproFreezeState` and directly re-evaluate current material/scope/evidence against the frozen pair; no new classification head, binding, or baseline credential is created. If freeze is absent/migration-required, refuse with `repro-freeze-migration-required`, leave phase unchanged, and require a fresh Story. |
| TEST | Run `proof-or-stop validate`, resolve bugs, refresh stale evidence, and satisfy delivery/summary prerequisites. |
| TEST → DONE | After synchronization, require `reproCompletionReady` again: GREEN/PRESERVED liveMatch, every target's fresh `scope-bound` head, docsExempt recheck where applicable, and every selected pass head. If bounded hashes drifted, rerun through the registered writer before requiring configured DONE commands and delivery evidence, merging locally, and performing normal post-merge effects. |
| Direct `story_create --phase=*` | P1f permits explicit or default `IDEA|INIT` creation only. It refuses `INIT_CHECK|PLAN|DEV|REVIEW|TEST|DONE|DISCARDED`, every compatibility-only phase, and every unknown value with `story-create-lifecycle-bypass-forbidden`, before persistence and without minting a review round, freeze, or credential. There is no `historicalImport` exception; historical material requires a separately approved non-Story migration surface. |
| Legacy `TEST_CASE|TEST_CASE_REVIEW|META` phases | P1f marks every nonterminal Story in any of these phases `legacy-lifecycle-migration-required`; it refuses all five registered TEST_CASE/TEST_CASE_REVIEW edges, while META has no registered edge and reaches no gate. Work moves to a fresh full-lifecycle Story and no compatibility phase mints current credentials. |
| `story_reconcile` phase repair | May reconcile registered non-phase metadata only. P1f refuses any request containing a `phase` field, regardless of value (`IDEA|INIT|INIT_CHECK|PLAN|DEV|REVIEW|TEST|DONE|DISCARDED` or unknown), with `story-reconcile-phase-write-forbidden`; phase and credentials remain unchanged and the normal transition/discard evaluator is the only repair path. |
| `story_discard` | Non-purge discard uses the registered discard evaluator under the transition/owner locks. It may set only `DISCARDED`, preserves freeze/evidence as immutable history, invalidates all current credentials, records actor/reason, and never means DONE or success; it remains available to frozen, migration-required, and evidence-incomplete Stories. P1f unconditionally refuses `--purge` with `story-purge-evidence-destruction-forbidden`; no registered path may delete the Story directory or run `purgeSafeInitCommit`/rewind main. |

The INIT evaluator owns the six existing artifacts and derived `scopeAdmissionDigest`; from INIT_CHECK→PLAN
onward the reference evaluator consumes that digest, and from PLAN→DEV onward it additionally consumes the
PLAN scope-contract digest and one hash-bound repro snapshot. The XState
guard, orchestrator/compatibility path, pre-write recheck, rollback/re-entry path, recovery path, and DONE
preparation must call the applicable reference evaluator or a mechanically proven equivalent. No handler may
directly mint `DEV`, `REVIEW`, `TEST`, or `DONE`, a pass, validation, or completion credential.
`story_discard` is the sole non-success terminal exception and may write only `DISCARDED` through the discard
evaluator described above.

`scopeAdmissionDigest` is `CANON` of exactly
`{ initCheckDigest, scopeBoundaryDigest, executionBoundaryDigest, scopeFreezeCheckDigest,
scopeExtensionProposalsDigest, scopeDiscardDigest, extensionDecisions }`. Each `*Digest` is the §0.4-form
SHA-256 of the exact named artifact bytes. `extensionDecisions` is an array of exact
`{ proposalId, decision, decisionDigest }` objects, with `decision` in `accepted|rejected`, exactly one object
per proposal id, sorted by UTF-8 byte order of `proposalId`; `decisionDigest` is CANON of the registered decision record with its
`decisionDigest` field omitted if present. No proposals means `extensionDecisions: []`, never omission or null.

No onboarding path may create a Story directly at DONE. Historical completed material may be represented by
a separately approved inventory or migration artifact, but that artifact is not a Story, cannot carry current
RED/GREEN, reviewer, validation, or DONE-required credentials, and cannot satisfy a new Story's obligation.

## 7. Regression, adversarial, concurrency, and gate evidence

Evidence selection is derived from risk and affected process facts, not from free-form reviewer preference:

- Every `redRequired` target: happy, edge, and regression coverage.
- Security, evidence, policy, state-machine, lifecycle, or gate target: union `adversarial` and `gate-bypass`.
  The `adversarial` requirement carries mandatory subtypes `malformed-input`, `stale-binding`, and
  `tampered-binding`; `gate-bypass` carries `direct-write`, `prewrite-bypass`, `rollback`, and
  `compatibility-path`. Every listed subtype is a separate evidence unit and requires its own receipt.
- Concurrency, lock, lease, idempotency, chain, or single-use operation: real OS-process race evidence at the same serialization boundary used in production; deterministic test doubles may supplement but cannot replace it.
- Performance target: controlled benchmark repetitions, declared environment, threshold, variance treatment, and a same-command baseline/candidate comparison.
- Documentation exemption: executable-snippet/config/generator scan plus docs/concept review and normal validation.
- Every `characterizationRequired` target: `characterization-perturbation` plus `regression`.
- A target mechanically classified as visual or non-deterministic additionally selects `manual-observation`.

The gate consumes typed receipts and structured artifacts. Narrative such as “tests passed” is never evidence.

P1 implements one pure `selectRequiredReproEvidence` function and stores its exact sorted
`requiredEvidenceUnits` plus their evidence bindings in the classification. Its inputs are the **resolved
obligation value** together with normalized risk-signal categories, affected process-fact categories, target
kind, frozen scope paths, and material-path classification. The ordering is the §4.1 six-step chain and
carries no signature precondition: the selector runs during construction of the classification, consuming the
obligation value that the classifier has already resolved, and only the **completed** artifact — obligation,
`requiredEvidenceUnits`, and projected `evidenceBindings` together — is then content-digested and
integrity-signed. No integrity signature exists at the moment the selector is invoked, and none is required
for it to run. From that point the stored units and bindings are covered by the signature like every other
member, and no later re-run may replace them: after freeze they move only through the fresh-Story path. Its output is a closed set drawn only from:

`happy`, `edge`, `regression`, `adversarial`, `concurrency`, `gate-bypass`, `performance`,
`docs-consistency`, `characterization-perturbation`, and `manual-observation`.

The selection mapping is fixed by the bullets above, including the explicit risk-to-kind/subtype mapping. The obligation base sets are:
`redRequired → happy|edge|regression`,
`characterizationRequired → characterization-perturbation|regression`, and
`docsExempt → docs-consistency`. Each matched risk/target-kind bullet unions its named kinds; no caller may
subtract a kind. An unknown risk category or obligation returns typed `risk-category-unknown` or
`obligation-unknown` and blocks before selecting receipts; it never invents evidence kinds that the target
cannot produce. Before PLAN→DEV, repair is to register/review the category mapping and rerun P1 plus the
selector. After freeze, a registry change cannot mutate/rebind the frozen classification: the Story remains
typed blocked and its work moves to a fresh Story/branch that classifies under the new registry before
implementation. No free-form override or emergency field converts an unknown classification into an empty set.

Selector invocation is target-bound for every non-exempt target and supplies its real target kind and
`acceptanceTargetRef`. For a zero-target `docsExempt` Story it runs exactly once at Story scope with
`targetKind = "story-zero-target-docs"`, `acceptanceTargetRef` absent, and the empty freeze target array.

Each selected evidence unit requires one tool-owned `ReproVerificationReceipt`. An evidence unit is exactly
`{ kind, subtype }`, where `kind` is selected from the closed set above and `subtype` is one closed subtype
selected for that kind or omitted when the kind has none. For concurrency, subtype is exactly its registered
`serializationBoundaryId`; a receipt may not collapse boundaries or other subtypes.
The exact schema is `proof-or-stop.repro_verification_receipt.v1` with fields
`{ schemaVersion, receiptKey, seq, supersedesDigest, storyId, storyDir, scope, kind, subtype?,
acceptanceTargetRef?, classificationDigest, reproFreezeStateDigest, targetBindingDigest?,
evidenceBindingDigest, operationKey, selectorInputDigest, policyDigest, commandSpecDigest?, artifactDigest?,
executionReceipt?, executorIdentity, result, headHash, materialHash, boundaryFilesHash, storyScopeDigest?,
kindEvidence, actor, issuer, createdAt, contentDigest, integritySignature }`. `reproFreezeStateDigest` is
exactly `index.json#/reproFreezeState/contentDigest`. `scope` is `target|story`; target scope requires
`acceptanceTargetRef` and `targetBindingDigest`, while Story scope is permitted only for `docs-consistency`,
omits both, requires `storyScopeDigest`, and uses
`executorIdentity = "proof-or-stop-docs-consistency-runner@1"`. A target-scoped executable receipt derives
`executorIdentity = "proof-or-stop-repro-verification-runner@1:<adapterId>:<runnerProfileId>"`; a P2f
artifact-backed receipt derives the P2f verifier identity stored in that artifact. No identity is supplied by
the caller. `result` is exactly `pass|fail`; only the current fresh `pass` head satisfies a unit.

`kindEvidence` has these exact closed shapes:

- `happy|edge|regression|adversarial|gate-bypass`:
  `{ targetExercisedProofDigest, selectorTranscriptDigest }`;
- `concurrency`: `{ targetExercisedProofDigest, selectorTranscriptDigest, processCount,
  serializationBoundaryId, startBarrierDigest, processOutcomes }`, with integer `processCount >= 2` and a
  process-id-sorted, duplicate-free array of exact `{ processId, exitClass, resultDigest }` outcomes, one per
  process; serializationBoundaryId/processCount MUST equal the frozen expectation and receipt subtype;
- `performance`: `{ targetExercisedProofDigest, baselineRunSetDigest, candidateRunSetDigest,
  sameCommandSpecDigest, environmentDigest, expectationDigest }`, where sameCommandSpecDigest equals the
  receipt commandSpecDigest and expectationDigest equals CANON of the frozen benchmark expectation;
- `docs-consistency`: `{ storyScopeExercisedProofDigest, scanArtifactDigest,
  documentCheckReceiptDigest }`; formal docs/concept lanes and TEST validation remain separate later facts;
- `characterization-perturbation`: `{ p2fReceiptDigest, protectedPropertyDigest,
  perturbationFailureDigest }`;
- `manual-observation`: `{ p2fReceiptDigest, beforeArtifactDigest, afterArtifactDigest,
  verifierAttestations }`, where attestations are verifier-role-sorted, duplicate-free exact
  `{ verifierRole, verificationActorId, verdict, artifactBindingDigest }` objects with `verdict = pass|fail`.
  `verificationActorId` is issued to the independent P2f verifier in DEV and is not a REVIEW round/run id.

Every named digest is a companion-§0.4 digest of the exact runner/verifier-owned object it references.
For standard target runner units, `targetExercisedProofDigest = CANON({ acceptanceTargetRef, targetBindingDigest,
testCaseRef, adapterId, tokenValue, tokenObserved })` with tokenObserved true, and
`selectorTranscriptDigest = CANON(runReceipt.selectorTranscript)`. `selectorTranscript` is exact
`{ selector, stream:"combined", polarity:"present", matched, matchedLineIndex?, matchedLineDigest?,
exitZero, notTimedOut, tokenObserved }`; line fields are present iff matched and use the companion §1.10 line
index/digest rules. Concurrency uses CANON of the process-id-sorted array of that same proof preimage plus
each `processId`, and its selectorTranscriptDigest is CANON of the corresponding
`{processId,selectorTranscript}` array. For performance, each run's `proofDigest = CANON({
acceptanceTargetRef, targetBindingDigest, testCaseRef, adapterId, tokenValue, tokenObserved })`; then
`targetExercisedProofDigest = CANON({ baseline:[{runIndex,proofDigest},...],
candidate:[{runIndex,proofDigest},...] })`, with each array in contiguous runIndex order.
For docs, `documentCheckReceiptDigest = CANON(runReceipt)` and
`scanArtifactDigest = CANON({ scannedPaths, executableFindings, configFindings, generatorFindings })`; every
array is path-sorted and each finding is exact `{ path, lineDigest, outcome }` with outcome `pass|fail`.
Unknown or extra discriminants reject.

No receipt invocation chooses a command. For an `execution:"runner"` binding the writer looks up the exact `{ kind, subtype? }` member in the
frozen classification target's `evidenceBindings`, or in top-level `storyEvidenceBindings` for zero-target
docs, verifies `evidenceBindingDigest = CANON(binding)`, resolves `adapterId` through the existing
`runnerAdapterRegistry` in the full policySnapshot embedded in the frozen classification, verifies
`CANON(policySnapshot) == policyDigest`, derives its runner profile, matches the frozen `testCaseRef`, and
derives argv. It never resolves the command from live config; the receipt `policyDigest` equals the frozen
classification value. It likewise never reads `VerificationIntentItem.verification`: per §4.1 neither that
legacy pin's `command` nor its `selector` is an admissible input to any binding, `commandSpecDigest`, or
receipt, and offering one is rejected rather than resolved. Any candidate policy evolution is validated separately by its contract above.
`commandSpecDigest = CANON({ evidenceBindingDigest, adapterId, adapterDigest, runnerProfileId,
runnerProfileDigest, testCaseRef, resolvedExecutable, argv, cwd, selector })`; `selector` is exactly the
non-empty literal stored in that frozen evidence binding. None of those values is caller-authored and no
shell string is accepted. For an `execution:"p2f-artifact"` binding it instead verifies the artifact's
contract id/digest and derives no command. This extends companion R1-5 to every executable verification
receipt.

`P3bRunReceipt` is the exact §2.3 execution shape
`{ adapterId, adapterDigest, testCaseRef, linkageKind, linkageSignal, argv, cwd, envProjection,
runnerProfileId, runnerProfileDigest, exitCode, terminationSignal?, timedOut, stdoutDigest, stderrDigest,
streamFrames, resolvedExecutable, tokenValue, tokenObserved, selectorTranscript, prepMutationAudit, clean,
pre, post }`; it deliberately uses `selectorTranscript`, not §1.10's assertion-envelope transcript.
`executionReceipt` is kind-discriminated. Ordinary target-scoped and docs evidence uses
`{ type:"standard", runReceipt:P3bRunReceipt }`; concurrency uses
`{ type:"concurrent", commandBinding, clean, pre, post, prepMutationAudit, barrierReceipt, processReceipts }`,
where `commandBinding` is exact
`{ evidenceBindingDigest, adapterId, adapterDigest, runnerProfileId, runnerProfileDigest, testCaseRef,
resolvedExecutable, argv, cwd, selector }` and `commandSpecDigest = CANON(commandBinding)`. Every process
executes the byte-identical `resolvedExecutable`, `argv`, and `cwd` from that binding; no process or caller
may substitute a command.
`barrierReceipt` is exact `{ helperId, helperDigest, readyTokenDigest, releaseTokenDigest }` and
`processReceipts` is a process-id-sorted array of exact
`{ processId, exitCode, terminationSignal?, timedOut, streamFrames, stdoutDigest, stderrDigest, tokenValue,
tokenObserved, selectorObserved, selectorTranscript, resultDigest }`; selectorObserved MUST equal
selectorTranscript.matched; resultDigest is CANON of that object with resultDigest
omitted and exit/signal combinations follow companion §1.10. All real OS processes
share one disposable workspace, barrier, and serialization boundary and the single enclosing PRE/POST pair
must pass §2.2. The registered, digest-bound `proof-or-stop-race-launcher@1` helper starts every process
behind inherited READY/GO pipes and then directly `execve`s the resolved executable without a shell, exactly
as companion §2.3. READY is the single raw byte `0x52` and GO is `0x47`;
`readyTokenDigest`/`releaseTokenDigest` are companion-§0.4 `sha256:` digests of those one-byte preimages,
not CANON strings. Performance uses
`{ type:"benchmark", environment, baselineRuns, candidateRuns }`. `environment` is exact
`{ adapterDigest, runnerProfileDigest, resolvedExecutable, executableSha256, stableEnvProjection, cwd, platform,
arch }`; `environmentDigest = CANON(environment)`. Each run array has exactly `repetitions` ordered exact
`{ runIndex, runReceipt:P3bRunReceipt, measurement }` entries, where runIndex is contiguous from 0 and measurement is
`{ metric:"wall-clock-ns", unit:"ns", clock:"monotonic-hrtime", valueNs }`. The trusted runner captures
`process.hrtime.bigint()` immediately before spawn and after the process group is reaped; valueNs is the
canonical unsigned-decimal difference. Every runReceipt passes §2.2 and resolves the identical
commandSpecDigest/environment. `baselineRunSetDigest = CANON([{ runIndex, runReceiptDigest, measurement },
...])`, in baselineRuns order, where each `runReceiptDigest = CANON(runReceipt)`; candidateRunSetDigest uses
the same exact projection/order over candidateRuns.
`executableSha256` is companion-§0.4 SHA-256 of the resolved executable bytes; platform/arch are the exact
`process.platform`/`process.arch` strings. `stableEnvProjection` is each runReceipt.envProjection with only
the runner-generated nonce removed; it must be byte-equal across both sets while every run retains its own
fresh nonce/token.
Concurrency `processOutcomes` is exactly the `{ processId, exitClass, resultDigest }` projection of
processReceipts, and `startBarrierDigest = CANON({ helperId, helperDigest, readyTokenDigest,
releaseTokenDigest, processCount, serializationBoundaryId })` using the exact barrierReceipt values and
receipt subtype. The writer derives exactly one `exitClass` per process in this order: `timedOut === true`
yields `timeout`; otherwise integer `exitCode === 0` yields `zero`; otherwise a nonzero integer exitCode
yields `nonzero`; otherwise a present closed-set `terminationSignal` yields `signal:<name>`; every other
field combination aborts without a receipt. No process is counted twice. This same function derives
`processOutcomes[].exitClass` and the counts checked against frozen `outcomeCounts`. Every member of the
closed exitClass enum is admissible in a frozen outcomeCounts entry; P1 performs no additional speculative
command-reachability analysis beyond schema/count validation.
`characterization-perturbation` and `manual-observation` omit commandSpecDigest/executionReceipt and require
`artifactDigest` equal to their independently approved P2f receipt digest. P2f's trusted runner/attribution
contract, not caller JSON, owns those facts.

The writer derives `result` with no discretionary branch. Standard passes only when §2.2 INVARIANCE holds,
the process exits zero without timeout, the frozen selector appears as a literal line in the sequenced
stream, and the applicable target/Story exercise token is observed. Concurrent passes only when the shared
INVARIANCE holds, every process observes the target token and selector, every process is reaped, and the
observed exit-class counts satisfy every frozen min/max with no unlisted exit class. Performance passes iff
every baseline and candidate repetition satisfies §2.2 INVARIANCE, exits with integer exitCode 0, has
timedOut false and no terminationSignal, records the frozen selector as a literal line in its sequenced
stream with selectorTranscript.matched true, and is target-exercised; both sets use the same
commandSpecDigest/environmentDigest; every baseline valueNs misses thresholdNs; the candidate arithmetic
mean meets it; and both sets pass the frozen variance rule. A nonzero/signalled/timed-out/selector-failing
repetition aborts the benchmark with no receipt. “Meets” means the comparator is true; “misses” means its
logical negation, so `lt` misses at `>=` and `lte` misses at `>`. Compare the mean by integer cross-multiplication
`sum(valueNs) comparator thresholdNs * repetitions`; a set passes variance exactly when
`(max-min) * repetitions * 1000000 <= limitPpm * sum`, with no floating point.
P2f-backed kinds pass only when the referenced immutable P2f artifact is fresh, integrity-valid, contract-id
matched, and itself has a machine verdict of pass; manual additionally requires every independent verifier
attestation to pass. Otherwise result is fail or no receipt where the runner contract requires abort.

Target-scoped standard/concurrency/candidate-performance runs materialize the writer-captured committed
boundary candidate HEAD; baseline-performance runs materialize the frozen target baseline. Their PRE values
must equal the respective head/material binding and `R1-6V` applies: the committed target binding at RUN-HEAD
must recompute targetBindingDigest for the same acceptanceTargetRef, while adapterId/testCaseRef/selector
must equal the frozen per-unit evidence binding and recompute evidenceBindingDigest. Unlike RED/GREEN R1-6,
P3b command equality is to the evidence binding; the target and evidence commands may differ, neither is
caller-supplied, and the evidence command must emit the acceptanceTargetRef token. Docs runs materialize the
committed boundary candidate HEAD but use the frozen top-level Story evidence binding and exact token
`EXERCISED-STORY:<storyId>:docs-consistency:<nonce>`; their
`storyScopeExercisedProofDigest = CANON({ storyId, evidenceBindingDigest, tokenValue, tokenObserved })` with
`tokenObserved = true`. Target R1-6 does not apply to zero-target docs; this Story-scoped binding/token is its
replacement. Companion §2.3 pins these additional branches.

`selectorInputDigest = CANON({ classificationDigest, obligation, riskSignalCategories,
processFactCategories, targetKind, acceptanceTargetRef, frozenScopePaths, materialPaths })`, where
`frozenScopePaths` is exactly the classification top-level field and `materialPaths` is the target's
`implementationPaths` (empty for docs); `acceptanceTargetRef` is omitted only for Story-scope docs.
`storyScopeDigest = CANON({ storyId, classificationDigest, scopeAdmissionDigest, scopeContractDigest,
targetKind, frozenScopePaths })`, where `targetKind = "story-zero-target-docs"`.
`receiptKey = CANON({ storyId, scope, acceptanceTargetRef, kind, subtype })`; optional members are omitted.
Every array is normalized, UTF-8-byte sorted, and duplicate-free. All digests use companion §0.4 form.

`boundaryFilesHash` is computed by the new single-owner helper
`currentReproBoundaryFilesHash(gitCwd, candidateHead, metadataRoot, storyId, storyBaseHead)`. It calls the
existing function with its full actual signature
`resolveStoryChangedFiles(gitCwd, candidateHead, metadataRoot, storyBaseHead)`, where `storyBaseHead` is the
P1-frozen value and is therefore the resolver's explicit base rather than a live-main merge base. That function
first applies `isMaterialExcludedPath(path, projectRoot?)` using metadataRoot as projectRoot and therefore
omits every configured-Story metadata path, `docs/framework-audit/`, registered evidence-output path, and
registered runtime-artifact path. The new helper asserts/filters the current `<storyDir>/<storyId>/` prefix
again as defense in depth, then returns the companion-§0.4 CANON digest of exact UTF-8-path-sorted
`{ path, blobOid }` objects. Sorting compares UTF-8 bytes of `path`, then UTF-8 bytes of `blobOid`; identical
pairs are duplicate-rejected before hashing. If the explicit base is missing/unreachable or changed-file
resolution fails, the helper returns `repro-boundary-files-unverifiable` and writes no receipt, credential,
or phase. It claims freshness only for this returned non-excluded set; every excluded
process artifact is checked by its owning registered consumer. `blobOid` is `entry.blobId`: the bare
Git blob id at candidateHead or the existing literal `<deleted>`; renames contribute both old and new paths.

The registered P3b batch writer captures one clean committed boundary candidate HEAD and its material and
boundary-files hashes under the transition lock, then releases the short mutex while it produces every
selected unit. All receipts in that batch bind the same candidate snapshot. After per-key CAS appends, the
registered Story-metadata auto-commit commits the receipt/head files before the boundary evaluator reads
them; `repro-verification-metadata-commit-failed` leaves phase unchanged. That evidence-only commit advances
HEAD but changes neither materialHash nor boundaryFilesHash, so the ancestor freshness rule below keeps all
sibling receipts current simultaneously. There is no sequential “last receipt wins” ordering and no older
passing-head fallback.

Verification receipts are immutable content-addressed files at
`<storyDir>/<id>/repro-verification-receipts/<contentDigest-without-prefix>.json`. Per evidence-unit heads live
in the integrity-signed `<storyDir>/<id>/repro-verification-receipt-heads.json`, with exact schema
`{ schemaVersion:"proof-or-stop.repro_verification_receipt_heads.v1", storyId, storyDir, heads,
updatedAt, contentDigest, integritySignature }`; `heads` is a UTF-8-key-sorted map from `receiptKey` to
`{ seq, receiptDigest }` and `updatedAt` is tool-owned ISO-8601 UTC. A receipt has
`seq = prior.seq + 1` (or 1), and `supersedesDigest` is the prior head
digest (or null). The only writer is the registered P3b receipt command/evaluator; raw JSON import and direct
Story mutation are refused. All result, runner, command, hash, actor, issuer, and timestamp fields are derived
by that writer: `actor` is the verified current session identity from the Story owner lease, `issuer` is
exactly `proof-or-stop:p3b-verification-writer@1` (or
`proof-or-stop:p3b-scope-binding-evaluator@1` for the scope family), and `createdAt` is handler-owned ISO-8601
UTC. The caller supplies only a frozen Story/target selection. Identical requests deduplicate by
`operationKey = CANON({ receiptKey, classificationDigest, reproFreezeStateDigest, selectorInputDigest,
policyDigest, evidenceBindingDigest, headHash, materialHash, boundaryFilesHash, commandSpecDigest, artifactDigest })`;
the optional member is omitted. The runner executes outside the mutex, then reacquires the global lock order,
rechecks freeze/current facts and the prior-head CAS, and either returns the existing identical receipt or
appends one immutable successor. A moved conflicting head rejects and re-evaluates; no fork is written.

P3b also implements obligation-discriminated `evaluateReproScopeBinding`. It reads the immutable P1
classification and resolves evidence through the governing query, never caller fields. For `redRequired`,
baseline/confirm are the active governing red-assert and green-confirm records returned by
`redEvidenceGateQuery`'s exact companion-§5.1 `resolvedEvidence` projection; that projection is the sole
permitted source, including when a recover control record is the physical chain head, and the evaluator never
reads chain storage directly. For `characterizationRequired`, they are the active baseline/confirm records returned
by P2e's `reproCharacterizationGateQuery`. In either branch, their immutable record digests and runner-measured
head/material hashes become the receipt bindings. The evaluator computes the baseline→confirm material diff
with the shared classifier; `scope-bound` is derived iff the material diff has a non-empty intersection with
the frozen target `implementationPaths` and no material path outside `frozenScopePaths`, otherwise it is
`scope-violation`. In both branches, baseline head/material must equal the frozen target baseline and confirm
head must be its strict descendant; mismatch aborts without a receipt. It emits schema
`proof-or-stop.repro_scope_binding_receipt.v1` with exact fields
`{ schemaVersion, receiptKey, seq, supersedesDigest, storyId, storyDir, acceptanceTargetRef, obligation,
classificationDigest, reproFreezeStateDigest, targetBindingDigest, baselineEvidenceDigest,
confirmEvidenceDigest, baselineHeadHash, baselineMaterialHash, confirmHeadHash, confirmMaterialHash,
scopeContractDigest, implementationPathIntersection, outOfScopePaths,
operationKey, result, headHash, materialHash, boundaryFilesHash, actor, issuer, createdAt, contentDigest, integritySignature }`.
Both path arrays are normalized, UTF-8-byte sorted, and duplicate-free; `result` is exactly
`scope-bound|scope-violation`; `receiptKey = CANON({ storyId, acceptanceTargetRef })`. Its immutable files live
at `<storyDir>/<id>/repro-scope-binding-receipts/<contentDigest-without-prefix>.json`; its integrity-signed
per-key pointer is `<storyDir>/<id>/repro-scope-binding-receipt-heads.json`, with exact schema
`{ schemaVersion:"proof-or-stop.repro_scope_binding_receipt_heads.v1", storyId, storyDir, heads,
updatedAt, contentDigest, integritySignature }` and the same sequence, CAS, atomic-pointer, and
deduplication rules. Its `operationKey = CANON({ receiptKey, classificationDigest, reproFreezeStateDigest,
targetBindingDigest, obligation, baselineEvidenceDigest, confirmEvidenceDigest, baselineHeadHash,
baselineMaterialHash, confirmHeadHash, confirmMaterialHash,
scopeContractDigest, headHash, materialHash, boundaryFilesHash })`. Only `evaluateReproScopeBinding` may write it; no command accepts caller-supplied result,
paths, hashes, digest, actor, issuer, or timestamp.
For redRequired, baselineEvidenceDigest/confirmEvidenceDigest are the governing red-assert/green-confirm
recordDigests and confirmHeadHash/confirmMaterialHash are those GREEN runner PRE bindings. For
characterizationRequired they are the P2e baseline/confirm recordDigests and the confirm fields are the
characterization confirm runner's measured PRE bindings. The obligation field must equal the frozen
classification and any query/record/hash mismatch aborts without a receipt.

P3b defines four public integrity domains:
`proof-or-stop.repro-verification-receipt.v1`,
`proof-or-stop.repro-verification-receipt-heads.v1`,
`proof-or-stop.repro-scope-binding-receipt.v1`, and
`proof-or-stop.repro-scope-binding-receipt-heads.v1`. Every receipt and head uses §4's exact
`contentDigest`/`integritySignature` computation with its named domain. Receipt files are never edited or
deleted. Each head file is the sole mutable pointer and changes only by the atomic, integrity-checked CAS
replacement above; every previously pointed-to receipt remains immutable and readable. Freshness requires
exact `storyDir`, valid freeze digest, classification and binding,
selector/policy digests, scope-contract digest where applicable, and bounded freshness: receipt `headHash`
must equal or be an ancestor of the evaluated boundary head while `materialHash` and `boundaryFilesHash`
equal the recomputed values exactly. Receipt/head writes beneath the Story directory do not change those two
hashes; any implementation/document drift does. Missing, invalid,
superseded, stale, failed, duplicated-head, forked, or mismatched evidence blocks; the gate never searches an
older passing receipt. These receipts feed the P3 shadow evaluator and P4 gates without mutating or
reinterpreting the factual GREEN verdict returned by P2d.

There is no DEV/REVIEW scope self-waiver. A scope extension is accepted only through the independent
`scope_extension_proposal` plus `scope_extension_decide` workflow in INIT, before P1 creates the PLAN classification, followed by
a new scope contract and a new current classification snapshot. The Story Owner cannot approve its own
extension. After implementation begins, an out-of-scope change must be removed or moved to a new Story; a
DEV/REVIEW acknowledgement is not an authorization digest and never changes `scope-violation`.

## 8. Concurrency, serialization, and anti-bypass invariants

The one global acquisition order is: **Story transition lock → main write lock → per-Story classification lock →
binding-metadata lock → per-Story verification-receipt-head lock → per-Story scope-binding-receipt-head
lock → per-target chain locks in lexicographic `acceptanceTargetRef` order**. An operation
may acquire a suffix or a single lock, but after acquiring any lock it may never acquire a lock to its left;
an operation needing multiple target locks takes them only in the stated lexical order. A lifecycle operation
that also mutates shared main state takes the transition lock before the main write lock; a main-only operation
takes only the main write lock. PLAN→DEV takes the transition lock and the complete per-Story suffix without
the main write lock because it mutates no shared main state. Classification-only writers take only the classification lock; binding set/rebind takes
binding-metadata then its target-chain lock; a RED/GREEN run/control append takes only its target-chain lock.
A verification receipt writer takes the verification-head lock and, for target scope, its target-chain lock;
Story-scope docs takes the verification-head lock only. A scope receipt writer takes the scope-head lock then
its target-chain lock. A P3b batch updating both whole-Story head maps takes verification-head then
scope-head, followed by target locks in lexical order. Every
current and future acquirer, including recovery and transition compatibility paths, follows this order.
The two new canonical `withMkdirLock` identities are exactly
`repro-verification-receipt-head:<storyId>` and `repro-scope-binding-receipt-head:<storyId>` and are
registered in the process-fact registry; no receipt writer invents a filesystem lock path.

RED/GREEN execution occurs **outside** the append mutex; a 600-second run must never hold a short-lived
`withMkdirLock`. The writer uses one pinned optimistic protocol:

1. briefly acquire the canonical per-story/per-target lock, read the authoritative head/sequence/digest and
   binding/policy snapshot, perform pre-run deduplication, then release;
2. run in the disposable workspace;
3. reacquire the same lock, repeat deduplication, re-read every authoritative value, and compare-and-swap on
   the expected head `recordDigest` and `seq` plus the frozen binding/policy digests;
4. reject a moved or illegal head, otherwise append and fsync within that short critical section.

Quarantine/recover use the same lock and therefore serialize with the post-run CAS. A race loser reruns from
a fresh snapshot or returns the already-existing idempotent record; it never appends against stale state.
Required fixtures prove:

- concurrent identical RED or GREEN requests deduplicate to one logical operation;
- conflicting writers cannot create two heads or skip sequence/digest linkage;
- quarantine/recover cannot race a RED/GREEN append into an illegal state;
- target-binding registration/rebinding cannot race a run/control append past the binding-freeze predicate;
- a concurrent phase transition cannot validate one snapshot and persist against another;
- different verification receipt keys cannot lose one another when replacing the whole-Story head map;
- Story-scope docs and target receipt writers serialize on the verification-head lock;
- verification-head/scope-head/target-chain contenders prove the declared order has no inversion;
- a real-process no-inversion fixture holds the transition at each acquisition point while classification,
  binding, and multi-target chain operations contend, and proves bounded completion with no reversed wait;
- stale, forked, replayed, malformed, or unsupported records fail closed without destroying history.

## 9. Emergency and non-reproducible executable work

Production-only, destructive, timing-sensitive, or urgent executable work is not silently exempt. This
program has no DEV-without-baseline-proof bypass: neither an Owner flag, environment identity, prose approval,
reviewer acceptance, nor an emergency token satisfies or suppresses the obligation. If the baseline cannot be
run safely, the Story remains blocked before DEV.

An organization may operate a separately governed incident/hotfix channel outside this lifecycle, but that
work cannot be marked as a compliant Story, cannot mint RED/GREEN or DONE credentials, and must create a
traceable follow-up Story that obtains the missing proof. This is an explicit non-compliance route, not
`docsExempt` and not an input to any evaluator in this plan. P3/P4 must reject legacy `--force`, takeover,
caller identity, or future emergency fields when offered as repro-obligation substitutes.

## 10. Legacy v1 and candidate-intake compatibility

The Repro-First intake artifacts (`repro-probe`, `red-green-relation`, and `story-evidence-binding`) remain candidate-workflow evidence. They do not become Story RED/GREEN, REVIEW, TEST, or DONE authority merely because they are linked to a Story. Promotion requires the trusted v2 writer to rerun or independently verify the bound assertion under the v2 contract.

Legacy v1 handling preserves the accepted subsystem decisions. The validation, quarantine, and pre-merge
migration-scan decisions restated in the first, second, and fifth bullets below were settled in
`docs/requirements/decisions/red-evidence-legacy-v1-record-validation-audit.md` ("Fail Closed On Malformed
Legacy v1 Red-Evidence Records — Pre-Story Audit", settled 2026-07-26 as Axis A = full validation, Axis B =
quarantine, and OPEN-7 migration scan required before merge), which remains their truth source; this plan
restates them and does not amend them. The remaining bullets are this program's own adoption and
promotion rules:

- record-local `schemaVersion` wins when present; a versionless record inherits the evidence file envelope's
  era, and a versionless record in a v1-declared file is fully validated as a v1 candidate rather than rejected
  or presumed satisfying; unknown record or envelope versions are unsupported;
- every mandatory v1 field is validated, malformed envelopes and mixed/illegal ordering fail closed, and unreadable originals are quarantined without destructive rewrite;
- P2a runs before any trusted writer and freezes the exact grandfathered records at an adoption commit;
- manifest construction and the v1 writer switch share one serialized adoption operation: after that commit,
  `red_evidence_create` cannot create a manifest-eligible record and every later v1 record is unsupported;
- a pre-merge migration scan reports every active Story and target disposition;
- `legacy-unverified` is never silently promoted to v2 or treated as trusted RED/GREEN;
- active Stories either obtain v2 proof, receive an explicit historical/non-applicable disposition where mechanically eligible, or remain blocked.

The candidate-intake experiment is `docs/requirements/decisions/repro-first-story-intake-experiment.md` ("Repro-First Story Intake Experiment"), and it remains historical authority for how those candidate artifacts were collected. This plan supersedes any broader intake bypass or exemption language in it for lifecycle applicability.

Transitional posture is explicit. Until P4 atomically switches the live predicate to
`redEvidenceGateQuery`, trusted v2 heads remain non-satisfying to the current blocking gate while only
manifest-member v1 compatibility records retain their pre-existing compatibility behavior. New v1 writes are
disabled at P2a, no v2 result is advertised as gate-satisfying, and Stories needing the new contract remain
blocked or in shadow evaluation. P3b makes the internal shadow evaluator, while configured mode is `warn`, consume v2 query results, models closure
of the v1 satisfying path, and records atomic-cutover deltas and fixtures without changing blocking behavior.
P4 switches the live predicate, closes v1 satisfaction, sets configured mode and the non-configurable
`REPRO_FIRST_ENFORCEMENT_FLOOR` to `enforce` in one reviewed cutover after all deltas are dispositioned.

## 11. Process-fact integration

Every new classification, writer, query, lifecycle credential, and gate verdict is a process fact. Each implementation Story must update, as applicable:

- CLI schemas and command policies;
- `PROCESS_FACT_LEVELS` and `process-fact-registry.ts`;
- the P0m entry-to-component mapping surface, stated per registry so no member is ambiguous:
  `ProcessFactRegistryEntry` gains `factId`, a normalized `paths` array, and optional `componentId`,
  `serializationBoundaryId`, and **`generatedFrom`**; `RuntimeFactRegistryEntry` gains `runtimeFactId`,
  `kind`, a normalized `paths` array, and optional `componentId` and `generatedFrom`. Both registries
  therefore carry `generatedFrom?`, which is what makes §12's `componentProcessFactMappingDigest` and
  `componentRuntimeFactMappingDigest` preimages computable and their `generatedFrom` sort key well defined.
  P0m also owns its two deterministic total projection functions and the
  `verify-process-fact-contract.mjs` / `verify-runtime-fact-contract.mjs` completeness assertions that make
  an unmapped entry fail closed;
- the §4.1 `reproEvidenceBinding` authoring schema on `VerificationIntentItem`: the type change in
  `packages/main/src/core/types.ts`, the matching `verificationIntentSchema` extension in
  `packages/main/src/cli/command-catalog.ts` under the same fail-closed unknown-key rule, the runtime
  re-validation at the `checklist_update` handler entry and at every consuming gate/function, the derivation
  and projection to `evidenceBindings` / `storyEvidenceBindings` / `evidenceBindingDigest`, and the migration
  disposition: the member is additive and optional at the type level, no historical Story metadata is
  rewritten or backfilled, and a Story that reaches PLAN under P1 without the declarations its selected units
  require is blocked rather than auto-filled. `VerificationIntentItem.verification` and
  `plannedPathDeclarations` are untouched, and `verification_pin_narrow` gains an explicit refusal for any
  request naming a `reproEvidenceBinding` member;
- the 0.3.296 signed-intent lineage boundary: P1 verifies existing `verificationIntentAmendments` and the
  retained checkpoint before classification, leaves `verification_intent_recover` exact-restore-only, keeps
  the DEV append authoring schema unable to carry `reproEvidenceBinding`, and makes the append handler refuse
  before persistence when a proposed intent would enter the candidate set or change any frozen target,
  semantic digest, or declaration-set digest. Existing `AMENDMENT_*` integrity failures propagate
  fail-closed and are never normalized into an empty checklist or an exemption;
- the §4.2 Story-level `evidenceDeclarationSetDigest`: its exact preimage and sort/duplicate rules, its place
  as the tenth `inputDigests` member covered by the classification signature, its recomputation at every
  post-DEV boundary, and the fixtures proving that ordinary `status`/`verificationEvidence` writes leave it
  unchanged while an edit, addition, removal, or move of any declaration — non-descriptor items and the
  zero-target docs declaration included — returns `acceptance-target-semantics-drift-after-freeze`;
- the typed `p2f-contract-registry-unavailable` refusal and its disjointness from
  `evidence-binding-declaration-incomplete`, registered so no consumer can read a "classified but blocked"
  intermediate state that this program does not produce;
- the `serialization-boundary` ProcessFactKind, production boundary inventory, and exact affected-fact/path
  mapping that selects one concurrency evidence subtype per boundary;
- the retirement of `flow-policy:express-verification-policy` and the registration of its replacement
  `flow-policy:obligation-verification-intent-policy` with the exact rationale and consumer of §4, removing
  `'express-exempt'` from `FlowFactPolicyId`, `FLOW_FACT_POLICIES`, `PROCESS_FACT_LEVELS`, and
  `VerificationIntentPolicyKind`, deleting `EXPRESS_VERIFICATION_EXEMPTION_MESSAGE` in favour of the three
  exact required-intent/satisfied/unresolved renderings, and updating `core/flow-fact-policy.ts`,
  `core/workflow-policy.ts`, `core/verification.ts`, `core/process-fact-levels.ts`,
  `tasks/outcome-semantics-smoke.ts`, `tasks/flow-stability-smoke.ts`, and the `CLAUDE.md` section that
  currently teaches the exemption. The zero-occurrence assertions scope to product runtime source, active docs,
  and host agent mirrors only; immutable historical receipts and frozen Story metadata that captured the
  retired string are never rescanned, rewritten, or re-signed;
- integrity/signature artifact schemas and freshness consumers;
- deliberate reuse, where compatible, of 0.3.296's `executionImplementationIdentity` and durable complete
  selector-output integrity primitives, with explicit contract tests proving that ordinary verification
  receipts, package-version equality, display tails, and unbound output objects do not satisfy any v2
  RED/GREEN or P3b receipt predicate;
- role authority and owner-lease classification;
- `scripts/verify-process-fact-contract.mjs` and focused regression fixtures.

Prompt text may teach the workflow, but no prompt-only rule satisfies this plan.

## 12. Workstreams and delivery order

Each row is a separate normal Story with DEV → REVIEW → TEST → DONE lifecycle, regression evidence, and independent review. No row may claim a later row's outcome.

Two prerequisite workstreams precede P1 and are named explicitly so no later row silently assumes a surface
that 0.3.296 does not have.

**P0m — registry component-mapping foundation.** P0m is the sole authoritative owner of the entry-to-component
mapping that §4's classification projections and §12's component manifests both consume. As §3 records,
neither registry carries it today. P0m extends `ProcessFactRegistryEntry` with `factId`, a normalized
`paths` array, and optional `componentId` / `serializationBoundaryId` / **`generatedFrom`**, and extends
`RuntimeFactRegistryEntry` with `runtimeFactId`, `kind`, a normalized `paths` array, and optional
`componentId` / `generatedFrom`. **Both registries carry `generatedFrom?`**: it is the member that names the
source a generated path was produced from, and without it on `ProcessFactRegistryEntry` the
`componentProcessFactMappingDigest` preimage below — which carries `generatedFrom?` in each tuple and sorts
on it — would not be computable for process facts at all. `generatedFrom?` belongs to the
**component-filtered** projection only; §4's whole-registry `processFactRegistryDigest` /
`runtimeFactRegistryDigest` preimages are unchanged by this member and continue to carry exactly
`{ factId, kind, paths, componentId?, serializationBoundaryId? }` and
`{ runtimeFactId, kind, paths, componentId? }` respectively, so neither name acquires a second preimage.
It exports two deterministic, total projection functions — one whole-registry
projection for §4's `processFactRegistryDigest` / `runtimeFactRegistryDigest` and one component-filtered
projection for §12's `componentProcessFactMappingDigest` / `componentRuntimeFactMappingDigest` — with the
normalization, sort, and duplicate rules those sections state. It extends
`scripts/verify-process-fact-contract.mjs` and `scripts/verify-runtime-fact-contract.mjs` so that an entry with
a missing, ambiguous, or non-total mapping fails the contract verifier rather than being dropped from a
projection. Ordering is hard: **P0m completes before P1 begins**, and no consumer — P1, P2r, or any later row —
may re-derive, approximate, or infer the mapping from `producer`, `producerSourceRefs`, `consumerSourceRefs`,
or `artifact.path`. P0m's own exit is `registry-component-mapping-unavailable` returning zero occurrences
across the complete registry at its DONE snapshot.

**P0p — policy-namespace runtime foundation (`#/redEvidence`).** The documentary half of this workstream is
already complete: companion spec rev 7 names `#/redEvidence` at every normative policy root, so P0p carries no
document-reconciliation task and needs no further edit to this plan in order to run. P0p is the runtime and
bootstrap implementation workstream. It extends `RedEvidencePolicyConfig` and `resolveRedEvidencePolicy` **in
place** with any additional keys the v2 contract requires and materially populates this repository's
`proof-or-stop.config.json#/redEvidence` with `pinnedPath` exactly
`["/opt/homebrew/bin","/usr/local/bin","/usr/bin","/bin"]` plus explicit copies of companion §1.2's
canonical matcher, adapter, and profile registries. It proves `npm`/`node` resolution for the bootstrap
profiles/adapters on supported validation hosts, keeps missing resolution fail-closed, preserves the existing
unknown-key and required-no-default rules, binds the committed config bytes into later policy digests, and
proves the compatibility disposition for already-populated `#/redEvidence` blocks: evolution in place, no
alias, no dual-read, no silent caller migration. Ordering is hard: **P0p completes before P1 begins**, because P1's classification
`policySnapshot`/`policyDigest` and §7's adapter/profile resolution read that extended resolver. Independently
of P0p's own scope, no implementation row begins until the current design audit of this plan and its companion
resolves to `approved` under §1.

P0m, P0p, P1, P1f, P2a, and P2b are unavoidable bootstrap Stories because the trusted writer/query they create
does not yet
exist. They use the current strongest pre-implementation Story evidence plus the explicitly requested Lab
RED/GREEN workflow, and are marked `bootstrap-untrusted`; Lab records are never relabelled formal Story
evidence. P2c and later Stories use the available trusted writers. After P2f, P2r qualifies the current P0m,
P0p, P1, P1f, P2a, and P2b invariants through trusted characterization baseline/confirm chains, including
deliberate
disposable perturbations that make each characterization fail, plus current independent review. P2r does not
retroactively manufacture RED or rewrite the bootstrap Stories' evidence history. No P3 work begins and no
enforcement claim is permitted until P2r passes; a failed qualification repairs the owning component and
repeats P2r.

Before P2r initializes trusted component heads, every P2c-P2f receipt/reviewer decision is explicitly marked
`bootstrap-component-unqualified`; it cannot satisfy P3 or later and makes no caller-authored component
claim. P2r independently builds the initial manifests from the current qualifying snapshots and reruns or
equivalently requalifies every P2c-P2f target through trusted writers/reviewers that bind all six current
component heads. If P2r exposes a defect or a later successor changes any bootstrap component digest, all
dependent evidence is typed stale through that provenance graph. P2r cannot pass until each affected target
has rerun verification/review against the repaired component or P2r has recorded an equivalent trusted
qualification. Historical DONE metadata is not rewritten; the qualification campaign owns replacement
evidence and names every superseded receipt.

Those component digests have one exact, independently recomputable succession contract. Each component has
an append-only manifest chain at
`<metadataRoot>/.proof-or-stop/repro-bootstrap-components/<componentId>/manifests/<contentDigest-without-prefix>.json` and one
integrity-signed CAS head at
`<metadataRoot>/.proof-or-stop/repro-bootstrap-components/<componentId>/head.json`. A manifest is exact
`{ schemaVersion:"proof-or-stop.repro_bootstrap_component_manifest.v1", seq, supersedesDigest,
componentId, componentStoryId, changeCommit, snapshotHead, coveredFiles, componentProcessFactMappingDigest,
componentRuntimeFactMappingDigest, createdAt, contentDigest, integritySignature }`. `componentId` is exactly
`P0m|P0p|P1|P1f|P2a|P2b`; seq starts at 1 and supersedesDigest is null only for seq 1. `changeCommit` is the local-main
merge commit that introduced or repaired the component; `snapshotHead` is the local-main commit whose exact
component bytes P2r or the post-merge successor writer qualifies. It MUST equal changeCommit or satisfy
`git merge-base --is-ancestor <changeCommit> <snapshotHead>`; equality is expressly allowed, and a normal
DONE post-merge successor uses `snapshotHead == changeCommit`.

`coveredFiles` is the duplicate-free array of exact `{ path, blobOid }` objects sorted by UTF-8 bytes of path
then blobOid. It is the union of (a) every non-Story-metadata tracked path changed from the first parent of
`changeCommit` to changeCommit; (b) every path mapped to componentId by the process/runtime fact registry
projections at snapshotHead; and (c) every generated counterpart mapped by those projections. Member (c) is
exactly the `generatedFrom?` relation and is symmetric across both registries: a component-filtered tuple
whose `generatedFrom` is present contributes both that tuple's `path` (the generated path) and the
`generatedFrom` value (its source path) to `coveredFiles`, and this holds identically for process-fact and
runtime-fact tuples — which is only possible because P0m puts `generatedFrom?` on `ProcessFactRegistryEntry`
as well. A generated path mapped to the component whose tuple carries no `generatedFrom` is a non-total
mapping and is `registry-component-mapping-unavailable`, not a silently half-covered file. `blobOid` is
the bare blob id in the immutable snapshotHead tree or `<deleted>`. A changed component path absent from the
mappings fails the process/runtime fact-contract verifier and blocks issuance.

`componentProcessFactMappingDigest = CANON([{ factId, componentId, path, generatedFrom? },...])` and
`componentRuntimeFactMappingDigest = CANON([{ runtimeFactId, componentId, path, generatedFrom? },...])`. Each is the
complete snapshotHead projection whose componentId matches, sorted by UTF-8 bytes of id, then path, then
`generatedFrom`; a tuple whose `generatedFrom` is absent omits the member entirely and sorts before any tuple
that is otherwise equal and carries one. Duplicate tuples reject. Both preimages read `generatedFrom?` from
their own registry entry, so the process-fact tuple is computable exactly because P0m adds that member to
`ProcessFactRegistryEntry`. These two names are reserved for this
component-filtered flattened-`path` preimage and are deliberately distinct from §4's whole-registry
`processFactRegistryDigest` / `runtimeFactRegistryDigest` classification inputs, which cover every entry with
no `componentId` filter and carry a sorted `paths` array per entry. Neither pair may be substituted for the
other, and no name in this program is computed over two different preimages. Both projections are produced by
the P0m component-filtered projection function; if any covered entry lacks a total, unambiguous mapping at
snapshotHead, the writer returns `registry-component-mapping-unavailable` and issues no manifest or head. The
manifest public integrity domain is
`proof-or-stop.repro-bootstrap-component-manifest.v1`. The head is exact
`{ schemaVersion:"proof-or-stop.repro_bootstrap_component_head.v1", componentId, seq, manifestDigest,
updatedAt, contentDigest, integritySignature }` and uses domain
`proof-or-stop.repro-bootstrap-component-head.v1`; both artifacts use §4 omission rules.
Both storage prefixes are registered evidence-output paths: material/boundary hashing excludes them, while
this component checker is their sole freshness/integrity consumer.

The registered writer runs under the main write lock, validates the prior head/chain, derives every field,
atomically creates the content-addressed manifest, and CAS-replaces/fsyncs the head. Byte-identical input is
idempotent; changed input appends seq+1 naming the prior manifest and never edits history. Initial P2r may
issue the first manifest for each bootstrap component at its qualification snapshot. Thereafter, every Story
whose post-merge diff or new registry projection changes a currently headed component path must invoke the
same writer as a DONE post-merge effect before any new component-dependent credential can be minted.

`repro_bootstrap_component_check` resolves only the unique integrity-valid current head and recomputes that
manifest against its immutable snapshotHead tree, never a moving ref. Missing/unreachable snapshot lineage,
signature/digest error, fork, or mismatch is `bootstrap-component-chain-invalid`. A later unrelated merge
does not affect the pinned manifest. Separately, its current-head freshness branch derives the component
path/mapping projection at the candidate local-main HEAD and compares it with the headed snapshot; this does
not alter or invalidate historical manifest identity, but a difference without the required successor is
`bootstrap-component-head-stale` and blocks. A valid successor deliberately changes the current component
digest and makes every receipt/review bound to an older head typed stale until rerun or equivalently
requalified. P2r records the verified current-head `manifestDigest` in each qualification; no caller-authored
component digest is accepted. “Component digest” means exactly the current head's verified manifestDigest,
which equals the pointed manifest contentDigest.

If P2r finds that P2a admitted an over-inclusive v1 entry or omitted an otherwise eligible entry, the
original adoption manifest remains byte-immutable. P2r writes a separate integrity-bound
`LegacyManifestDisqualification` defined in companion spec §6.2, naming the manifest digest, defect class,
affected targets, and review evidence. From that point the entire manifest is unusable for gate decisions and queries return the
typed `legacy-manifest-disqualified` error. P2a repairs the validator/migration implementation, but never
reruns or edits the adoption manifest. Every affected or still-active target must obtain trusted v2 proof;
an omitted record remains unsupported and is also re-proved v2. P2r passes only after dependent P2c-P2f
evidence/review is requalified against the repaired P2a component and no evaluator relies on that manifest.

For the P1 row below, "post-freeze edits" includes the 0.3.296 signed-amendment surface: the existing chain
and checkpoint must verify before classification; exact recovery grants no new authority; and a DEV append
that would create a candidate target or move any frozen target, semantic, or declaration-set digest is
refused before persistence. This is part of P1's exit condition, not an advisory compatibility note.

| Order | Story-sized deliverable | Exit condition |
|---|---|---|
| P0m | Registry component-mapping foundation | `ProcessFactRegistryEntry` carries `factId`, normalized `paths`, and optional `componentId`/`serializationBoundaryId`/`generatedFrom`; `RuntimeFactRegistryEntry` carries `runtimeFactId`, `kind`, normalized `paths`, and optional `componentId`/`generatedFrom`; both registries therefore make the `generatedFrom?` member of §12's `componentProcessFactMappingDigest` and `componentRuntimeFactMappingDigest` preimages and their `generatedFrom` sort key computable, while §4's whole-registry preimages stay unchanged and carry no `generatedFrom`; the whole-registry and component-filtered projection functions are deterministic and total; both fact-contract verifiers fail closed on a missing, ambiguous, or non-total mapping, including a generated path mapped to a component by a tuple carrying no `generatedFrom`; `registry-component-mapping-unavailable` has zero occurrences across the complete registry at the DONE snapshot; no consumer infers a mapping from `producer`, `producerSourceRefs`, `consumerSourceRefs`, or `artifact.path` |
| P0p | Policy-namespace runtime and repository-config foundation (`#/redEvidence`) | `RedEvidencePolicyConfig` and `resolveRedEvidencePolicy` are extended in place with any v2 additions under the existing fail-closed unknown-key rule; `proof-or-stop.config.json#/redEvidence` is materially committed with `pinnedPath` exactly `["/opt/homebrew/bin","/usr/local/bin","/usr/bin","/bin"]` and explicit companion-§1.2 canonical matcher/adapter/profile registries; supported validation hosts prove that path resolves `npm` for `node-npm@1` and both `npm`/`node` for bootstrap adapters, while missing resolution fails closed; the config bytes are review-visible and digest-bound; an absent/null/empty `pinnedPath` returns `red_evidence_policy_missing` and writes no classification; the `policyEvolutionContract` pointer root, §7 adapter/profile resolution root, and §13 governed-policy row all resolve exactly `/redEvidence`; already-populated blocks have a proven no-alias/no-dual-read/no-silent-migration disposition; no second namespace or unowned operator setup exists |
| P1 | Tri-class obligation snapshot, fail-closed classifier, evidence-unit selector, §4.1 evidence-binding authoring schema and migration, §4.2 declaration-set binding, express-exemption retirement, and serialization-boundary registry | `redRequired`, `characterizationRequired`, and `docsExempt` are integrity-signed, fresh, deterministic, target-baseline-bound, store exact required evidence units/bindings; both §4 registry projections are computed only through P0m's functions and fail closed with `registry-component-mapping-unavailable`; the §4.1 `reproEvidenceBinding` member exists on `VerificationIntentItem` and in the `verificationIntent` CLI schema as an additive optional member with no historical backfill, rejects unknown/missing fields, discriminant/payload mismatch, lane/type violations, duplicate tuples, unresolved targets, and unselected units, is matched one-to-one onto the selector's units and projected to `evidenceBindings`/`storyEvidenceBindings` with `evidenceBindingDigest` over that projection alone, is frozen by the single PLAN→DEV freeze with post-freeze edits typed `acceptance-target-semantics-drift-after-freeze`, and is derived through the acyclic six-step order in which no declaration object is read before step 4 and `resolveVerificationIntentPolicy` runs at step 3.5 with no back edge; the §4.2 `evidenceDeclarationSetDigest` is the tenth `inputDigests` member with the exact stated preimage, sort order, no-deduplication rule, `CANON([])` empty value, and `evidence-declaration-set-invalid` refusal, is covered by the classification signature at freeze, is recomputed at every post-DEV boundary from declaration fields and positions alone, is provably unmoved by `status`/`startTime`/`endTime`/`verificationEvidence`/`userSeesSnapshot` writes and by appending a declaration-free item, and returns `acceptance-target-semantics-drift-after-freeze` for any declaration edit, addition, removal, or move including non-descriptor items and the zero-target docs declaration; an `execution:"p2f-artifact"` unit with no approved registry, or an unresolvable/unapproved/incompatible `p2fContractId`, returns `p2f-contract-registry-unavailable` and writes nothing, disjoint from `evidence-binding-declaration-incomplete`; `VerificationIntentItem.verification` keeps its B-ec67/B-1482 ordinary-verification meaning while its `command`/`selector` are inadmissible to every repro binding, `commandSpecDigest`, and receipt, and `verification_pin_narrow` refuses any request naming a `reproEvidenceBinding` member; the express exemption is retired outright — `VerificationIntentPolicyKind` is exactly `obligation-intent-satisfied\|obligation-intent-required\|obligation-unresolved`, `resolveVerificationIntentPolicy` takes the closed obligation-bearing input object and reads no channel, any Story of any channel and any obligation with zero authored `verificationIntent` entries is blocked with `verification-intent-required`, any Story leaving a selected unit undeclared is blocked with `evidence-binding-declaration-missing`, a mechanically non-executable Story classifies `docsExempt` and carries exactly one Story-scoped `docs-consistency` declaration with no exemption rendered, `EXPRESS_VERIFICATION_EXEMPTION_MESSAGE` and `flow-policy:express-verification-policy` are deleted in favour of the three exact renderings and `flow-policy:obligation-verification-intent-policy`, the inverted smoke assertions and `CLAUDE.md` rewrite land in this Story, and zero-occurrence assertions cover product runtime source, active docs, and host agent mirrors while immutable historical evidence is never rescanned or rewritten; ProcessFactKind plus the production boundary inventory selects one concurrency subtype per affected boundary; all are covered across diff/scope/target conflicts |
| P1f | Lifecycle-entry closure plus atomic PLAN→DEV freeze-state contract and shadow writer | `index.json#/reproFreezeState` is written with DEV in one atomic replacement; local-main merge activates only after P1f is terminal; `story_create` permits only default/explicit `IDEA\|INIT` and refuses `INIT_CHECK\|PLAN\|DEV\|REVIEW\|TEST\|DONE\|DISCARDED`, compatibility-only phases, and unknown values before persistence with no historical-import exception; exact integrity/schema/lock, IDEA→PLAN, direct-phase/reconcile, non-purge discard and unconditional purge refusal (frozen/migration/v2-chain cases), legacy-phase, metadata-commit, missing/tampered/raced/no-inversion, quick-path, missing-admission/freeze inventory and REPLAN refusal, and both REVIEW/TEST→DEV freeze-present/missing branches pass before configured repro enforcement |
| P2a | Legacy/candidate adoption manifest, migration scan, and v1 writer cutoff | Every existing record has a deterministic disposition; the cutoff is atomic and no later v1 record can become manifest-eligible |
| P2b | Trusted v2 `red-assert` writer and controlled runner | A real failing target at the P1-bound baseline produces one immutable, target-exercised RED; forged, vacuous, mutating, stale, replayed, and raced runs are rejected |
| P2c | Trusted `green-confirm` writer | Same-assertion descendant GREEN works and target/assertion substitution rejects; this factual writer does not claim the later P3b scope verdict |
| P2d | Total `redEvidenceGateQuery` with resolved v2 evidence projection | Every RED/GREEN/control-chain, legacy, and corruption state returns one typed result without mutation; active fresh GREEN returns exact handler-resolved governing RED/confirm record digests and runner head/material bindings, including through a recover head, while every other success returns resolvedEvidence null; runtime gates still do not consume it |
| P2e | Characterization/manual-evidence decision spec | Operations, records, transitions, idempotency, freshness, attribution, verdicts, query projection, and handler-owned baseline/confirm record/head/material outputs for the scope evaluator are independently approved with no unresolved design decision; P2e is itself a `docsExempt` Story whose one required unit is the runner-executed `docs-consistency` unit with an authored intent item and the single Story-scoped declaration, so it selects no `p2f-artifact` unit and is never refused by `p2f-contract-registry-unavailable` |
| P2f | Characterization/manual-evidence writers and query projection | Refactor perturbation and bound visual/non-deterministic before/after fixtures pass; weaker evidence cannot satisfy the obligation; P2f's own classification is `redRequired` and its selected units are runner-executed, proved with the already-available P2b/P2c `red-assert`/`green-confirm` writers, so no P2f self-dependency exists; a P2f-scoped target that ever resolved a `p2f-artifact` unit returns `p2f-contract-registry-unavailable` and moves to a post-P2f Story rather than taking a bootstrap exemption; from this Story's DONE onward the independently approved P2f contract registry exists and `p2f-artifact` units become bindable |
| P2r | Bootstrap qualification and component-head initialization | P0m, P0p, P1, P1f, P2a, and P2b frozen invariants have trusted characterization baseline/confirm chains, deliberate-perturbation failures, current independent review, and unique verified bootstrap component heads; successor/head-staleness fixtures pass, original Lab records remain non-formal, and no retroactive RED is claimed |
| P3a | INIT/PLAN/DEV shadow evaluator and binding freeze | The evaluator validates scope admission, returns typed `blocked` for missing baseline proof on every target, and models the atomic PLAN→DEV freeze; no runtime transition is blocked yet |
| P3b | DEV→REVIEW shadow evaluator, obligation-discriminated scope evaluator, and risk evidence writers | One internal shadow evaluator consumes v2/P2e query results while configured mode remains `warn`, models v1-path closure, returns typed `blocked` across normal, compatibility, rollback, prewrite, and direct-transition fixtures, produces integrity-bound scope/verification receipts for P1's frozen required units through registered runners, derives red→green and characterization baseline→confirm scope bindings without caller hashes, and proves different-key head-map lost-update, docs-vs-target serialization, verification/scope/target no-inversion, and atomic-cutover fixtures; configured blocking behavior remains unchanged |
| P3c | REVIEW/TEST/DONE shadow integration, credential isolation, and `repro_plan_audit_check` | Later-phase evaluators produce the target verdict without changing runtime mode; no direct-DONE Story-creation path exists; any separately approved historical inventory remains non-Story and cannot mint current credentials; audit verification is a registered process fact |
| P3d | Concurrency and emergency-bypass refusal closure | Real-race fixtures pass at production serialization boundaries, and every Owner/force/takeover/emergency attempt to substitute for baseline proof is rejected while configured mode remains `warn` and the internal shadow evaluator records candidate verdicts |
| P4 | Shadow comparison, migration convergence, enforcement-floor introduction, and enforce flip | Shadow/current verdict deltas are zero or dispositioned, active inventory is migrated; this Story **introduces** both closure surfaces that §3 records as absent in 0.3.296 — it adds the checked-in `proof-or-stop.config.json#/reproFirstPreflight` block selecting `enforce`, and it creates the non-configurable constant `REPRO_FIRST_ENFORCEMENT_FLOOR` at `enforce`, closes the resolved mode union to `"warn"\|"enforce"` with a config-load error for every other value, and registers the constant in `PROCESS_FACT_LEVELS`, `process-fact-registry.ts`, and `scripts/verify-process-fact-contract.mjs`; downgrade/omission fixtures fail closed, and bypass attempts remain blocked |

P0m through P2r may not be collapsed into one implementation Story and execute in the table's order. P0m and
P0p are strict runtime prerequisites: P0m must be DONE before P1 begins because §4's classification
projections are not computable without its mapping surface, and P0p must be DONE before P1 begins because
P1's `policySnapshot`/`policyDigest` and §7's adapter/profile resolution read its in-place-extended
`resolveRedEvidencePolicy`. P0m and P0p are independent of each other and may run in either order or
concurrently. Both are implementation rows and therefore sit behind the §1 documentary gate: the current
design audit of this plan and its companion must resolve to `approved` before any implementation row —
including P0m and P0p — begins. P1f is
the adoption point for the freeze subobject: P0m, P0p, P1, and P1f necessarily lack it; every
later Story is shadow-recorded under the pre-freeze/current regime until its PLAN→DEV transition atomically
writes the subobject, after which queries use the post-freeze regime. Thus P2b and P2d consume an already
defined/stored freeze state even though blocking enforcement remains off. A P3 row may proceed only after P2r
and every P1/P2 contract it consumes are implemented and independently reviewed. P3 proves evaluator results
through the internal shadow evaluator while configured mode is `warn`; only P4 claims runtime blocking. The final product outcome exists only after P4 is DONE.

The `P*` identifiers belong only to this program. The companion spec is self-contained for matcher, policy,
runner, chain, and query semantics; no unapproved external workstream is a prerequisite by shorthand. Any
future external dependency must name its full program, approved version/digest, and consumed contract.

## 13. Acceptance matrix

Before P4 can flip enforcement, evidence must cover at least these cases:

| Case | Expected obligation/result |
|---|---|
| Historical bug in material code | trusted historical RED → same-target GREEN |
| New executable feature | old implementation fails frozen acceptance → same-target GREEN |
| `redRequired`/`characterizationRequired` with zero resolved targets | `acceptance-targets-missing`; PLAN must establish a concrete registered target before classification/proof/freeze |
| Acceptance target set widens, narrows, or changes after PLAN→DEV freeze | `acceptance-target-set-drift-after-freeze`; phase/credentials unchanged and work moves to a fresh Story, never omitted from proof or retrofitted into the freeze |
| Acceptance semantics or evidence binding changes under an unchanged frozen target ref | `acceptance-target-semantics-drift-after-freeze`; phase/credentials unchanged and work moves to a fresh Story, never reuses the old assertion |
| Gate/process/config/build/runtime change | RED→GREEN plus adversarial bypass and affected-path coverage |
| Governed `#/redEvidence` policy/adapter/profile change | exact reviewed policyEvolutionContract whose `changedJsonPointers` lie beneath `/redEvidence`; evidence runs under frozen baseline policy, candidate config must equal contracted snapshot, and later Stories adopt it after merge |
| P1 reads an absent `#/redEvidence` block or an absent, null, empty, non-absolute, or non-resolving `pinnedPath` after P0p | fail closed with `red_evidence_policy_missing` or the applicable policy-resolution error; write no classification, head, binding, freeze, or credential; repair the material review-visible P0p configuration rather than using an environment/operator default |
| Classification, manifest, or receipt consumer needs a registry entry whose component mapping is missing, ambiguous, or non-total | `registry-component-mapping-unavailable`; the classification/manifest/receipt writer produces nothing and mutates no head, phase, or credential; the consumer never infers a mapping from `producer`, `producerSourceRefs`, `consumerSourceRefs`, or `artifact.path`, never substitutes a partial projection, and never emits an empty projection as success |
| A digest name is proposed for two different preimages | reject at review; §4's whole-registry `processFactRegistryDigest`/`runtimeFactRegistryDigest` and §12's component-filtered `componentProcessFactMappingDigest`/`componentRuntimeFactMappingDigest` stay distinct in name and preimage and are never substituted for one another |
| A later revision of this plan or of the companion spec moves either document's normative policy pointer root off `/redEvidence` | reject at the design/audit gate as a §1 plan/companion conflict; the current candidate names `/redEvidence` consistently in both documents, so this case guards future drift rather than an open divergence; no evaluator may prefer one document at read time, and no root that no resolver reads may be named |
| Any Story, of any channel and any obligation, whose committed checklist authors zero `verificationIntent` entries | `verification-intent-required`; `resolveVerificationIntentPolicy` returns `obligation-intent-required` with every selected unit in `missingUnits`, P1 writes no classification, head, binding, freeze, or credential, and repair is to author the required `verificationIntent` in PLAN and rerun P1 |
| Express-channel Story whose fresh classification is mechanically non-executable | `docsExempt`, exempt from baseline RED/characterization only; its required unit is the runner-executed Story-scoped `docs-consistency` unit and binding, it must still author that unit's intent item, and **no** exemption line is rendered — `express-exempt` and `flow-policy:express-verification-policy` no longer exist |
| Channel, item count, prose, or a caller flag offered as grounds to skip `verificationIntent` on any Story | reject; `resolveVerificationIntentPolicy` reads no channel, no obligation has an empty required-unit set, and only the fresh classification decides the obligation |
| Caller with no current integrity-valid classification asks for the verification-intent policy | `obligation-unresolved` with the exact neutral rendering; it satisfies no gate, is never an exemption, and never substitutes for a classification |
| A retired `express-exempt` value, `EXPRESS_VERIFICATION_EXEMPTION_MESSAGE` rendering, or `flow-policy:express-verification-policy` registry entry appears in product runtime source, active docs, or a host agent mirror after P1 | reject at the process-fact/residue verifier; the same string inside immutable historical receipts, causal-evidence receipts, or frozen Story metadata is untouched history and is never scanned, rewritten, or re-signed |
| Selected required evidence unit whose intent item carries no §4.1 `reproEvidenceBinding` | `evidence-binding-declaration-missing`; P1 writes no classification, head, binding, freeze, or credential, and never derives, defaults, or infers a binding from the item's lane, `type`, `desc`, or `verification` pin |
| `reproEvidenceBinding` carrying an unknown key, a missing required field, or a wrong-typed field, at top level or nested in `expectation` | `evidence-binding-declaration-unknown-field` or `evidence-binding-declaration-incomplete`; fail closed with no partial or empty binding array, and the identical constraint is re-checked at the handler entry and at every consuming gate, not only by the schema |
| `reproEvidenceBinding` whose `execution`, payload members, `expectation.type`, or `subtype` disagree with its `kind`'s fixed row | `evidence-binding-declaration-discriminant-mismatch`; a caller can never move a unit off the trusted runner path or onto an unintended expectation payload by editing a discriminant |
| `reproEvidenceBinding` whose owning lane or item `type` is outside its `kind`'s admissible row | `evidence-binding-declaration-lane-type-invalid`; lane and `type` are necessary conditions only and never select, imply, or default a `kind` |
| Two `reproEvidenceBinding` declarations on the same `(target-or-story-scope, kind, subtype)`, or a second Story-scoped docs declaration | `evidence-binding-declaration-duplicate`; the checklist item, intent item, or lane carrying them is irrelevant |
| `reproEvidenceBinding` naming a ref absent from frozen `targets[]`, or matching no unit the selector produced | `evidence-binding-declaration-target-unresolved` or `evidence-binding-declaration-unselected`; an extra binding can never be smuggled past the selector, and authoring a declaration never adds a target or a unit |
| `verification.command` or `verification.selector` offered as the repro command or selector, or any caller-supplied executable/argv/selector for an evidence receipt | reject; the legacy B-ec67 pin governs ordinary verification only, repro argv comes solely from adapter-template resolution against a registered `testCaseRef` under the frozen policy snapshot, and the repro selector solely from the frozen `reproEvidenceBinding.selector`, so companion R1-5 is extended rather than weakened |
| `verification_pin_narrow` invoked against a `reproEvidenceBinding` member | reject; B-1482 narrowing-only movement applies to `verification.selector` alone, and a wrong repro selector is semantics drift repaired on a fresh Story, never narrowed |
| `reproEvidenceBinding` edited after the PLAN→DEV freeze on an intent item that is a target descriptor source | `acceptance-target-semantics-drift-after-freeze` through the intent-item source `contentDigest`; phase/credentials unchanged, no post-freeze edit, waiver, re-derivation, or narrowing path exists |
| `reproEvidenceBinding` edited, added, removed, or moved after freeze on an intent item that is **no** descriptor source, or any edit to the zero-target docs declaration | `acceptance-target-semantics-drift-after-freeze` through the §4.2 `evidenceDeclarationSetDigest` recomputation; the per-target `acceptanceSemanticDigest` covers neither case, so this Story-level conjunct is the mechanism and it runs at every post-DEV boundary for every obligation |
| Ordinary post-freeze `status`, `startTime`, `endTime`, `verificationEvidence`, or `userSeesSnapshot` write, or an appended checklist item carrying neither a declaration nor any acceptance-target candidate source | no drift; `checklistDigest` moves and is compared only at DEV admission, while target/semantic and `evidenceDeclarationSetDigest` projections are provably unchanged |
| 0.3.296 `verification_intent_append` proposes a new intent ref that would enter the acceptance-target candidate set or move any frozen target/semantic/declaration digest | refuse before checklist persistence with `acceptance-target-semantics-drift-after-freeze`; retain the signed prior state and move the new target to a fresh Story with baseline proof |
| `verification_intent_recover` restores an exact signed checkpoint | verify the full amendment/checkpoint lineage, restore only the identical projection, then rerun frozen-digest checks; no declaration, evidence, classification, or credential is created or refreshed |
| Intent amendment/checkpoint lineage is stripped, tampered, forked, or mismatched | propagate the existing typed `AMENDMENT_*` integrity refusal; never interpret the checklist as empty, never classify `docsExempt`, and never write a replacement classification |
| Committed checklist items inserted or reordered after freeze ahead of a declaration-bearing item | `acceptance-target-semantics-drift-after-freeze`; the move changes a frozen declaration's `sourcePointer`, which is declaration-set drift by construction and not an exception |
| Two declaration-set elements share one `sourcePointer`, or a declaration set is otherwise malformed | `evidence-declaration-set-invalid`; no deduplication is performed, a byte-identical second declaration at another position moves the digest instead of collapsing, and a Story with no declarations has the exact `CANON([])` value rather than an omitted or null member |
| Component-filtered projection tuple for a generated path that carries no `generatedFrom` | `registry-component-mapping-unavailable`; both registries carry `generatedFrom?`, `coveredFiles` covers generated path and source path symmetrically for process-fact and runtime-fact tuples, and a half-covered generated file is never issued |
| Concurrency/lock/idempotency change | RED→GREEN plus real multi-process race proof |
| Story affects multiple registered serialization boundaries | one sorted concurrency evidence subtype and receipt per boundary; missing any boundary blocks, while multiple ids never cause an ambiguity rejection |
| Performance claim | runner-owned monotonic nanosecond samples prove every old-baseline run misses the frozen threshold, the same-command candidate arithmetic mean meets it, and both sets meet the integer ppm variance rule |
| Behavior-preserving refactor | baseline characterization passes, deliberate protected-behavior perturbation makes it fail, the unperturbed descendant preserves the identical property, and its baseline→confirm material diff earns `scope-bound` |
| Pure Markdown wording/review | integrity-signed `docsExempt`; docs/concept review and validation still required, and the Story still authors the `docs-consistency` intent item plus its single Story-scoped declaration — `docsExempt` never exempts intent authoring |
| Implementation row started from the aligned current plan/companion pair before a matching audit entry exists | reject under §1 step 5; documentary reconciliation and finding repair are not approval, and a fresh joint audit of the exact pair is still required |
| docsExempt with non-executable acceptance refs at a post-DEV boundary | rerun candidate classification; remain docsExempt with an empty executable/material projection and continue through REVIEW→TEST→DONE |
| docsExempt acquires any executable/material target after freeze | `docs-exemption-invalidated-after-freeze`; phase/credentials unchanged and work moves to a fresh Story with baseline proof |
| Zero-target docs-consistency execution | frozen Story evidence binding plus `EXERCISED-STORY:<storyId>:docs-consistency:<nonce>` proves the registered Story runner executed; target R1-6 is not fabricated |
| “Docs” change touching generator/config/script/executable example | not exempt; `redRequired` or `characterizationRequired` |
| Visual/non-deterministic executable target | attributable bound before/after observation; not exempt |
| Manual-observation required before first REVIEW | independent P2f verifier identity/attestation is issued in DEV; no REVIEW round id prerequisite or cycle |
| Urgent or production-only failure | Story remains blocked before DEV; a separately governed incident channel cannot mint compliant Story credentials |
| Stale/tampered/unknown classification or evidence | block with typed repair guidance |
| Raw/imported risk or scope receipt, caller-selected executable/argv, invalid integrity, stale head, fork, or older passing receipt behind a failing head | reject/block; only the registered P3b writer, policy-resolved adapter, current CAS head, and fresh integrity-bound pass may satisfy |
| P4 or later config omits mode, selects `warn`, or uses an unknown value | `repro-enforcement-floor-violation` for omission/weaker value or config-load error for unknown; no evaluator fallback |
| Baseline/GREEN/live config resolves a different `storyDir` | `story-dir-drift`; explicit repository migration plus fresh Story required, never alternate artifact lookup |
| Classification head/pointer missing, unsigned, digest-invalid, or forked | `classification-unverifiable`; repair the head/chain or reclassify, never treat as record-chain corruption or GREEN |
| Superseded classification digest named for a new write/current verdict | writer rejects or query returns `errorKind: classification-superseded` with repair `reassert-current-classification`; historical record remains valid readable history |
| PLAN RED classification legally superseded before DEV | prior RED remains non-corrupt history; query reports typed `classification-superseded` until a new RED is asserted against the current head, restoring a normal verdict |
| Concurrent classification writers | one integrity-signed head/sequence survives; identical work deduplicates and a conflicting loser re-evaluates |
| Scope extension independently approved in INIT before P1 classification | PLAN scope contract and current classification include it; later evidence binds the new digest |
| Scope extension absent, rejected, unresolved, or Owner-self-approved in INIT | INIT/INIT_CHECK evaluator blocks; no admitted scope digest reaches PLAN |
| PLAN→INIT REOPEN before freeze | old admission/classification/RED stays historical but unusable; full INIT→INIT_CHECK→PLAN facts and baseline proof are regenerated |
| DEV/REVIEW Owner attempts scope self-waiver | reject; acknowledgement cannot change `scope-violation` |
| v1/candidate-only evidence after adoption | `legacy-unverified` or candidate-only; cannot satisfy trusted gate |
| v1 write after P2a cutoff | refused or unsupported; never included in the adoption manifest |
| P2r proves the adoption manifest over- or under-inclusive | immutable disqualification artifact retires the whole manifest from decisions; active/omitted targets re-prove v2 and dependent evidence is requalified |
| A later Story changes a currently covered bootstrap-component path or registry mapping | without a post-merge successor, `bootstrap-component-head-stale` blocks; a valid append-only successor becomes current and makes older-head dependent evidence typed stale until rerun/requalification |
| P2a→P2b no-writer window | new `redRequired` targets remain blocked/shadow-only; no v1 fallback or completion claim |
| RED baseline differs from P1 target baseline | writer rejects before execution/append |
| RED baseline contains a Story-specific commit touching frozen implementation paths | writer rejects; verification-only/test and Story-metadata commits remain eligible |
| GREEN changes only unrelated material | chain may prove same assertion, but `reproCompletionReady` blocks DEV→REVIEW, REVIEW→TEST, and TEST→DONE because the current scope receipt is `scope-violation` when target-path intersection is empty |
| redRequired scope binding with direct GREEN or recover chain head | evaluator consumes only query-resolved governing RED/confirm digests and runner hashes; caller fields and direct chain reads reject, and a recover head resolves the underlying GREEN rather than using the control-record id |
| Characterization confirm changes only material outside frozen implementation paths | the characterization query may return PRESERVED, but the obligation-discriminated scope evaluator returns `scope-violation` and `reproCompletionReady` blocks DEV→REVIEW, REVIEW→TEST, and TEST→DONE |
| Obligation escalates after implementation | typed block; restart on a fresh Story/branch, never retroactive RED or emergency substitution |
| Concurrent identical RED requests | one logical record; post-run dedupe returns the same result |
| Concurrent identical GREEN requests | one logical record; post-run dedupe returns the same result |
| Conflicting target writers | exactly one head advances; loser rejects moved `recordDigest`/`seq` without a fork |
| Quarantine/recover races RED/GREEN append | legal serialized head only; no skipped sequence or hidden record |
| Binding registration/rebinding races run/control append | shared target lock preserves EMPTY/quarantine freeze predicate; illegal rebind rejects |
| Pre-freeze quarantine then rebind | atomic replacement succeeds, a new classification head becomes current, a new RED restores the current verdict, and only PLAN→DEV later freezes that pair |
| Post-freeze rebind, including at quarantine head | reject; move the binding repair to a fresh Story/branch |
| Quarantine bad assertion with unchanged binding | replacement RED is reachable at the frozen baseline; prior chain history remains immutable |
| Owner/force/takeover/emergency substitute for baseline proof | reject on every transition path; no credential or phase mutation |
| Phase transition races evidence append | transition cannot validate one snapshot and persist against another |
| `INIT_CHECK→DEV` quick-path attempt after P1f | `repro-plan-required`; no phase or freeze mutation |
| `IDEA→PLAN` legacy attempt after P1f | `repro-init-required`; remain IDEA and enter INIT normally |
| Pre-P1f Story already in PLAN without admission digest | `repro-admission-migration-required`; only PLAN→INIT REOPEN can repair in-Story |
| Pre-P1f quick-path Story already in DEV+ without freeze | `repro-freeze-migration-required`; cannot advance or mint credentials, work moves to a fresh full-lifecycle Story |
| `DEV→PLAN` REPLAN with freeze | `repro-freeze-rollback-refused`; immutable freeze remains and phase does not change |
| `DEV→PLAN` REPLAN while migration-required/missing freeze | `repro-freeze-migration-required`; phase does not change and work moves to a fresh Story |
| Direct create at `INIT_CHECK|PLAN|DEV|REVIEW|TEST|DISCARDED` or an unknown phase after P1f | `story-create-lifecycle-bypass-forbidden`; no Story/review round/freeze/credential is written |
| Direct create at DONE or any other post-intake/internal phase | `story-create-lifecycle-bypass-forbidden` before persistence; no historical-import exception and no current credential |
| `story_reconcile` contains any phase write, including `IDEA|INIT|INIT_CHECK|PLAN|DEV|REVIEW|TEST|DONE|DISCARDED` or unknown | `story-reconcile-phase-write-forbidden`; no phase/credential mutation, and the normal transition or discard evaluator is required |
| Non-purge `story_discard` from any nonterminal/frozen/migration state | registered discard evaluator writes only DISCARDED, preserves history, invalidates credentials, never signals completion |
| `story_discard --purge` for any Story | `story-purge-evidence-destruction-forbidden`; no directory deletion, evidence removal, or local-main rewind |
| Legacy TEST_CASE/TEST_CASE_REVIEW transition | `legacy-lifecycle-migration-required`; fresh full-lifecycle Story required |
| PLAN→DEV with dirty/uncommitted governed Story metadata | auto-commit under transition lock; on failure `repro-plan-metadata-commit-failed`, no freeze or phase write |
| XState normal guard path | returns the same typed evaluator verdict and binding digest as the reference evaluator |
| Orchestrator/compatibility path | returns the same typed evaluator verdict and binding digest as the reference evaluator |
| Pre-write recheck path | re-reads current facts; moved snapshot rejects before phase persistence |
| REVIEW/TEST rollback to DEV and re-entry | freeze present: preserve/recheck it; freeze absent or migration-required: `repro-freeze-migration-required`, phase unchanged, fresh Story required |
| Recovery path | cannot mint or restore lifecycle credentials outside the reference evaluator |
| DONE preparation path | rechecks classification/evidence after sync before DONE persistence |
| Direct-DONE onboarding import | historical non-applicable marker; no current credentials |
| Characterization/manual Story before an independently approved P2f contract registry exists | `p2f-contract-registry-unavailable` at P1; no classification, head, binding, freeze, or credential is written, and there is no "classified correctly but DEV-blocked" intermediate state, no fallback to v1, RED, or `docsExempt`, and no phase or credential mutation |
| `p2fContractId` present but unresolvable, unapproved, or incompatible with the declaration's `kind`/`subtype` | `p2f-contract-registry-unavailable`, the same total refusal; a structurally absent or wrong-typed member is `evidence-binding-declaration-incomplete` instead, checked first, so the two codes stay disjoint |
| P2e or P2f bootstrap reachability challenged | P2e is `docsExempt` with the runner-executed `docs-consistency` unit and therefore selects no `p2f-artifact` unit; P2f is `redRequired` and proves itself with the already-available P2b/P2c runner writers; a P2f-scoped target that resolved a `p2f-artifact` unit is refused and moves to a post-P2f Story, so no self-dependency and no bootstrap exemption exists |
| P2r bootstrap qualification | each P0m/P0p/P1/P1f/P2a/P2b frozen invariant passes baseline/confirm characterization, fails under deliberate disposable perturbation, and passes current review; no historical RED credential is emitted |
| P2r fails after dependent P2c-P2f Stories are DONE | repaired component digest stales every dependent receipt/review; P2r remains blocked until each dependency is rerun or equivalently re-qualified and superseded evidence is named |
| Unknown risk category/obligation | typed block; pre-freeze register/review then rerun P1, post-freeze move to a fresh Story under the new registry; no frozen-head mutation or impossible receipt set |
| Three or more selected evidence units append sequentially | every head remains fresh because the shared material-exclusion predicate omits registered Story/process artifacts and head ancestry/material/boundary hashes remain valid; no older-head fallback |
| Legacy adoption anchor unavailable | `legacy-anchor-unverifiable`; fetch history or re-prove v2, never re-anchor the manifest silently |

## 14. Audit lineage and non-goals

This plan carries forward the prior audit's accepted core requirements: policy-owned assertions, target exercise, disposable-runner invariance, immutable supersedes chains, fork rejection, idempotency, owner-gated quarantine/recover, a single transition choke point, typed fail-closed reads, explicit emergency-bypass refusal, and canonical-receipt freshness only within the scope actually proven by its metadata bindings.

The companion spec's round-3 standing deviations remain explicit rather than silently rewritten: deterministic `recordId` remains in the idempotency tuple, and `recoversRecordId` retains its name with a `linkKind` discriminator. Earlier R1-R4 findings are historical design inputs, not current pass counts. The previous W0 defect table is not repeated as an unverified prerequisite list; every implementation Story must re-establish the live baseline by symbols and tests.

Prior audit lineage is dispositioned as follows; no earlier rejection is converted into an approval claim.
R1-R23 are retained verbatim in substance; R24 through R31 are appended below, with **R31 the latest round**:
R24 records the independent
audit of the exact v26 plan / companion spec rev 8 pair, which returned `REJECT` with three blocking findings.
The v27 revision answered all three; v29 preserved those corrections and added R25; v30 added R26; v31 added
R27, v32 added R28, and v33 added R29 — those are this Story's lifecycle REVIEW rounds rather than external
audits. R30 records the later Claude CLI rejection of v35/rev13: digest verification was unavailable in that
session, so no machine entry was eligible, while its substantive read identified the recoverability defect
addressed in v36. R31 records the next independently digest-verified rejection and the cross-document lock-order
repair now carried by v37/rev14.

Which of these rounds is mechanically latched, stated exactly (this corrects language carried by v21-v25, and
drops the freeze-time entry count v26-v30 carried): the §1 derivation reads the live audit document fence and
nothing else. No fence entry carries any of these documentary round labels, and no statement in this candidate
depends on how many entries the fence holds — a count is not re-derivable from frozen prose, and v30's own
freeze-scoped count was false for its final bytes (R27 below). **R21 through R31 are documentary and Git-lineage rounds only.** They are preserved immutably
in this section and in repository history, they remain permanently non-withdrawable as documentary record, and
they are never converted into approvals — but no fence entry records those documentary round labels, so none
of them is mechanically latched, and this plan makes no such claim anywhere. Prior text that described R21/R22 as "permanently
latched for their digest pair" overstated the mechanism and is corrected here and in §1. Nothing depends on
the correction: at byte-freeze no fence entry matched the current plan/companion digest pair, so §1 step 5's
"no matching entry" branch resolved the state to `blocked`. A revision that answers a
rejection is not a verdict; only a new valid matching `APPROVE` entry in the fence can change the state.

| Prior round | Durable concern | Current disposition |
|---|---|---|
| R1 | Caller-authored RED facts and unbounded assertions were not trustworthy | carried into §§2, 5, and 13 as tool-owned execution, target exercise, and bounded same-assertion proof |
| R2 | Runner invariance and RED/GREEN binding were incomplete | carried into §§5 and 8 and delegated in detail to the companion spec |
| R3 | Chain integrity, idempotency, retention, and standing field-name decisions needed precision | carried into §§8 and 14; the two accepted standing deviations remain named |
| R4 | A single Story could not safely deliver the program, and transition/concurrency preconditions could drift | carried into §12's separate Stories; each Story must re-prove its live prerequisites rather than trust stale line-number findings |
| R7 | Freeze timing, config/material circularity, prep-created material, selector mapping, P2a qualification repair, root/hash rendering, config namespace, integrity semantics, audit derivation, emergency authority, and INIT boundary coverage remained ambiguous | **corrected in v24.** Every member except the config-namespace concern is resolved in §§1, 4, 6-9, 12-13 and companion §§0.4, 1.1-1.2, 1.10-1.12, 2.1-2.5, 3.3-3.5, 5.3-5.6, and 6.2. The config-namespace member was **not** resolved: v7-v23 recorded it as closed while both documents named `proof-or-stop.config.json#/reproEvidenceV2`, a pointer that is not a `ProofOrStopConfig` key and is read by no resolver in 0.3.294, so the "resolution" pointed at a namespace that does not exist. R22 re-opened exactly that member; v24 records the live `#/redEvidence` truth in §3 and retargets §§4, 7, and 13 to `/redEvidence`, and companion spec rev 7 — authored under Story B-de09 — then moved every normative companion policy root to the same `/redEvidence`. As of v25 the config-namespace member is repaired in both documents, no plan/companion divergence remains outstanding, and P0p retains only the in-place runtime extension. None of this is treated as an approval |
| R8 | Freeze storage/integrity/adoption, global lock order, duplicate-audit identity, and signaled-exit membership were incomplete | resolved in §§1, 4, 8, 12-13 and companion §§0.4, 1.1-1.2, 4.1, and 5.6 by a phase-coatomic `index.json#/reproFreezeState`, P1f adoption, total lock/audit predicates, and an ordered exit classifier; the rejection remains history, not approval |
| R9 | Registered quick-path and REPLAN edges bypassed or stranded freeze state; timeout-exit, docs zero-target receipt, and scope-admission preimages were incomplete | resolved in §§6-7, 12-13 and companion §§1.1-1.2 by retiring express DEV entry at P1f, refusing frozen REPLAN, preserving freeze on REVIEW/TEST rollback, and pinning all three data contracts; the rejection remains history |
| R10 | Direct-phase creation, P1f self-activation, missing-freeze REPLAN, PLAN REOPEN, frozen digest preimages, post-freeze unknown-category repair, and docs receipt digests remained open | resolved in §§3-7, 12-13 and companion §§0.4/1.1 by P1f post-merge activation/refusals, total edge dispositions, exact-byte scope binding, fresh-Story post-freeze repair, and exact receipt preimages; the rejection remains history |
| R11 | IDEA direct PLAN, reconcile/discard phase writers, configurable Story paths, empty executable target sets, and PLAN metadata-commit ordering remained open | resolved in §§3-7, 12-13 and companion §§0.4/1.1/2.3/5.6 through P1f edge/writer closure, config-bound `<storyDir>`, `acceptance-targets-missing`, and pre-freeze metadata commit; the rejection remains history |
| R12 | Purge could delete every frozen/v2 artifact and rewind main; missing-freeze REVIEW/TEST rollback was not total | resolved in §§6, 12-13 and companion §§1.1/4.2/6.4 by unconditional purge refusal and explicit freeze-present/absent rollback branches; the rejection remains history |
| R13 | Risk/scope receipts lacked exact integrity and writer contracts; evidence commands remained caller-selectable; post-freeze target drift, enforcement-mode downgrade, reconcile phase authority, and GREEN digest validation were incomplete | resolved in §§3-7, 12-13 and companion §§1.1, 5.6, and 7 by registered-runner immutable receipt chains, exact target-set re-derivation, a closed mode enum with hard floor, total reconcile refusal, and operation-specific digest checks; the rejection remains history |
| R14 | P3b receipts were disconnected from the existing registries/runner, docs/manual evidence had impossible target/review dependencies, Story-file freshness self-invalidated sibling receipts, several digest inputs were undefined, and create/semantic-drift totality remained open | resolved in §§4, 6-7, 13 and companion §§0.5, 1.1, 2.3, and 7 by frozen evidence bindings, total runner branches, Story-scope exercise, DEV verifier identities, boundary-files freshness, exact preimages, and total phase/semantic drift refusals; the rejection remains history |
| R15 | Performance lacked samples, live-policy equality deadlocked policy evolution, new receipt heads lacked locks, selector transcripts reused incompatible RED enums, and concurrency/exclusion preimages were imprecise | resolved in §§4, 7-8, 13 and companion §§0.4-0.5, 2.3, 4.1, 5.3, and 7 by integer monotonic benchmark samples, a frozen-policy evolution contract, named head locks, a P3b-specific selector transcript, registered serialization boundaries, exact READY/GO bytes, and the real shared exclusion predicate; the rejection remains history |
| R16 | Performance proof aggregation and variance, P3b command/target equality, changed-file base ordering, bootstrap component identity, and concurrent command identity remained underdefined | resolved in §§4, 7, 12-14 and companion §§0.5, 2.3, and 7 by exact run-proof wrappers, the R1-6V replacement rule, the complete integer variance conjunct, frozen explicit-base resolution with total ordering, integrity-bound component manifests, and a recomputable concurrent command binding; the rejection remains history |
| R17 | Component manifests could not be renewed, docsExempt self-blocked, multi-boundary races were unrepresentable, concurrency exit classes forked, and the root classification topology/schema were incomplete | resolved in §§3-4, 7, 11-14 and companion §§0.5, 1.1, 1.10, and 7 by append-only component heads pinned to immutable snapshots, a docs-specific post-freeze reclassification branch, one concurrency subtype per registered boundary, a total exit-class projection, a per-Story classification chain, and an exhaustive classification schema; the rejection remains history |
| R18 | Benchmark failures could masquerade as speedups, classifier path/registry universes were ambiguous, completion boundaries omitted GREEN/scope predicates, and concurrency reachability, component snapshot ancestry, and policy freshness had divergent readings | resolved in §§4, 6-7, 12-14 and companion §§0.5, 7.1-7.2 by zero-exit/selector-valid benchmark repetitions, exact material/registry universes, shared `reproCompletionReady` checks at all completion boundaries, removal of speculative exit reachability, inclusive snapshot ancestry, and comparison with the frozen ordinary-Story policyDigest; the rejection remains history |
| R19 | Characterization targets had no defined scope-confirm source, and one material-classifier root was unpinned | resolved in §§4-7, 12-14 and companion §7.1 by an obligation-neutral baseline/confirm scope receipt whose hashes/digests come from the governing RED/GREEN or P2e query, explicit P2e/P3b ownership and refactor scope fixtures, and canonical Story-worktree projectRoot binding; the rejection remains history |
| R20 | redRequired scope receipts required record digests that the sole read-only query did not expose and the scope evaluator was forbidden to read directly | resolved in §§7, 12-14 and companion §§1.9, 5.1-5.6, and 7.1 by an exact `resolvedEvidence` query projection for active fresh GREEN, null on every other success, recover-head resolution to the underlying GREEN/RED pair, P2d ownership, and a no-caller/no-direct-chain acceptance case; the rejection remains history |
| R21 | The v22 candidate's §3 "current 0.3.294 truth" misstated the live configuration surface as already closed to exactly `warn|enforce` with a config-load error for every other value, when `resolveReproFirstPreflightMode` still resolves a live `off|warn|enforce` union and silently normalizes any absent/unrecognized value to `warn` with no config-load error today | resolved in §3 by restating current behavior accurately (the live three-value union, the silent-`warn` fallback, and the absence of any config-load error today) and confining the closed two-value enum and config-load-error behavior to the existing §13 P4 acceptance-matrix row; this edit changes the plan's bytes, so it supersedes the v22/R20-approved digest pair and this v23 candidate is unaudited pending a fresh independent audit, not an approval carryover |
| R22 (a) | **Registry projection gap.** §4's `processFactRegistryDigest = CANON([{ factId, kind, paths, componentId?, serializationBoundaryId? },...])` and `runtimeFactRegistryDigest = CANON([{ runtimeFactId, kind, paths, componentId? },...])`, and §12's component-manifest projections, all consume mapping fields that 0.3.294 does not have: `ProcessFactRegistryEntry` carries no `factId`, `paths`, `componentId`, `serializationBoundaryId`, or `generatedFrom`, and `RuntimeFactRegistryEntry` carries no `runtimeFactId`, `kind`, `paths`, `componentId`, or `generatedFrom`. §4 and §12 additionally reused the names `processFactRegistryDigest`/`runtimeFactRegistryDigest` for two different preimages | recorded as current truth in §3 with the exact present entry shapes and the note that `producerSourceRefs`/`consumerSourceRefs` are advisory pointers, not a total mapping; §12 assigns prerequisite workstream **P0m** with its own table row, exit condition, and hard ordering before P1 and every later consumer; §4 binds both classification projections to P0m's functions and forbids inference from `producer`, `producerSourceRefs`, `consumerSourceRefs`, or `artifact.path`; §11 registers the mapping surface, projection functions, and verifier assertions as process facts; §12's manifest members are renamed `componentProcessFactMappingDigest`/`componentRuntimeFactMappingDigest` so the whole-registry and component-filtered preimages never share a name; §13 adds a fail-closed `registry-component-mapping-unavailable` case and a distinct-preimage case. The rejection remains history, not approval |
| R22 (b) | **Policy namespace gap.** The plan and companion spec named `proof-or-stop.config.json#/reproEvidenceV2` normatively, but 0.3.294 already ships `#/redEvidence` with exactly the fourteen policy keys on `RedEvidencePolicyConfig`, the fail-closed `resolveRedEvidencePolicy` resolver, and live consumers in `handlers/red-evidence.ts` and `handlers/doctor.ts`. No `reproEvidenceV2` key exists in the config type, the resolver, or the checked-in config, so the plan's `policyEvolutionContract` pointer root and governed-policy acceptance row pointed at a namespace no resolver reads, and R7 had wrongly recorded this member as closed | recorded as current truth in §3, including that the repository-local config populates no `redEvidence` block today so the namespace is live-but-unconfigured with `pinnedPath` unset; the coherent target is **evolving `#/redEvidence` in place** — no new namespace, alias, dual-read, or silent caller migration; §4 retargets the `policyEvolutionContract` pointer root and declares `/redEvidence` the single normative policy root for the whole plan, §13's governed-policy row follows, and §12 assigns prerequisite workstream **P0p** to extend `RedEvidencePolicyConfig`/`resolveRedEvidencePolicy` in place and prove the compatibility disposition. The documentary mismatch this finding named was then repaired by companion spec rev 7, authored under Story B-de09, which moved every normative companion policy root to `/redEvidence`; as of v25 both documents name the same root, the divergence is no longer outstanding, and P0p's remaining scope is runtime only. §13 accordingly carries a stable future-drift acceptance case in place of the resolved-conflict case, and the R7 disposition is corrected above. The rejection remains immutable documentary history for the v23 digest pair — preserved here and in Git, never withdrawn, never an approval — and, as the preamble above and §1 state, it is not recorded in the machine fence and therefore not mechanically latched |
| R22 (c) | **Express `verificationIntent` conflict.** §4 asserted that "P1f's retirement of IDEA/direct PLAN/quick DEV means no express policy can skip it", but `resolveVerificationIntentPolicy` returns `express-exempt` for any express-channel Story (no active riskSignals, at most two checklist items) with zero authored intents, and that exemption is the registered `L4` process fact `flow-policy:express-verification-policy` on a separate flow-policy surface that P1f does not touch. An executable express Story could therefore reach PLAN→DEV with zero authored intents while §4 derives targets partly from `verificationIntent` | recorded as current truth in §3 with the exact live symbols and the registered gate consumer; §4 replaces the false assertion with an obligation-discriminated, explicitly non-circular three-step rule — classification runs first and is never gated by channel; an executable/material classification blocks with typed `express-verification-intent-required` until the required `verificationIntent` is authored, registered, and adapter-resolvable at PLAN before classification and binding; only a mechanically non-executable classification may keep `docsExempt` and render the re-scoped exemption. P1 owns the narrowing end to end, including `PROCESS_FACT_LEVELS`, `core/flow-fact-policy.ts`, `core/workflow-policy.ts`, `core/verification.ts`, and `scripts/verify-process-fact-contract.mjs`; §11 lists the process-fact update and §12's P1 exit condition carries it; §13 adds three typed cases. **The re-scoping half of this disposition is superseded by R24 (a): v27 retires the exemption outright rather than re-scoping it**, so no `express-exempt` disposition survives for any obligation; the rest of R22 (c)'s disposition — classification first, never channel-gated — stands. The rejection remains history, not approval |
| R23 (a) | **Undefined evidence-binding authoring surface (blocking).** §4 stated that each target's `evidenceBindings` and the zero-target `storyEvidenceBindings` are "derived from registered `verificationIntent`", and §7 required the P3b writer to look up an exact `{ kind, subtype? }` member in them, but no document defined the authoring surface that derivation reads. 0.3.294's `VerificationIntentItem` is exactly `{ id?, desc, type, requiredIn?, priority?, plannedPathDeclarations?, verification? }`, whose three lanes and five types are not in bijection with the ten §7 evidence kinds and carry no adapter id, test-case ref, selector, P2f contract id, or expectation payload. The inputs to a frozen, integrity-signed classification were therefore undefined, and an implementer's only reachable command/selector source would have been the caller-authored `verification` pin — which would have defeated companion R1-5 | **corrected in v26.** New §4.1 defines the closed `reproEvidenceBinding` member nested on `VerificationIntentItem`, carrying `schemaVersion`, optional `acceptanceTargetRef`, `kind`, optional `subtype`, the `runner`/`p2f-artifact` execution discriminant, `adapterId`/`testCaseRef`/`selector` or `p2fContractId`, and the already-frozen closed `standard`/`concurrent`/`benchmark` expectation payloads. §4.1 pins unknown/missing-field rejection, the kind-fixed execution/expectation/subtype table, total lane and `type` constraint tables that never determine a kind, per-target association and `(target-or-story-scope, kind, subtype)` uniqueness, one-to-one matching onto the selector's units, the exact projection to `evidenceBindings`/`storyEvidenceBindings` with `evidenceBindingDigest` over that projection alone, PLAN freeze through the intent-item source digest, express consistency, and an explicit fence keeping `verification.command`/`verification.selector` out of every repro binding, `commandSpecDigest`, and receipt while preserving their B-ec67/B-1482 ordinary-verification semantics. The acyclic five-step derivation order forbids reading a declaration before step 4, so no circular classification dependency exists. §7 restates the fence, §11 carries the schema/CLI/migration process-fact update, §12's P1 row carries the exit condition, and §13 adds seven typed cases. **v27 extends that order to six steps** — inserting the required-intent policy at step 3.5 (R24 (a)) and the declaration-set digest at step 5 (R24 (b)) — without adding any back edge. The rejection remains documentary history, not approval |
| R23 (b) | **`generatedFrom` inconsistency (blocking).** §12's `componentProcessFactMappingDigest = CANON([{ factId, componentId, path, generatedFrom? },...])` carried `generatedFrom?` and sorted on it, and `coveredFiles` member (c) unioned "every generated counterpart mapped by those projections" for both registries — but §11 listed the mapping members jointly and §12's P0m prose and exit row granted `generatedFrom` only to `RuntimeFactRegistryEntry`. The process-fact preimage and its sort key were therefore not computable, and a generated counterpart mapped from a process fact had no member to come from | **corrected in v26** by choosing that `ProcessFactRegistryEntry` **does** gain `generatedFrom?` under P0m. §3 already recorded it among that entry's missing members and is unchanged; §11 now states the mapping surface per registry with `generatedFrom?` on both; §12's P0m prose and exit row grant it on both and state that §4's whole-registry `processFactRegistryDigest`/`runtimeFactRegistryDigest` preimages stay unchanged and carry no `generatedFrom`, so no name acquires a second preimage; `coveredFiles` member (c) is defined as the symmetric `generatedFrom?` relation contributing both generated and source path for process-fact and runtime-fact tuples alike; the component-filtered sort is pinned including absent-`generatedFrom` ordering; and §13 adds a fail-closed case for a generated path whose tuple carries no `generatedFrom`. Companion §7.2 already records this same current-truth and preimage and needs no change. The rejection remains documentary history, not approval |
| R23 (c) | **Audit-truth misstatement (blocking).** The v25 header, §1, and §14 described R22 — and by the same wording R21 — as "permanently latched" under §1, and the v25 header asserted that "no R23 rejection exists" as though the machine fence governed that fact. At that time the audit document's fence recorded exactly one entry, the v22/R20 `APPROVE`; no entry recorded R21, R22, or any later rejection, so §1's latch could not have applied to them. The plan asserted a mechanical property its own derivation cannot produce | **corrected in v26, and the count half superseded by R27 in v31.** The header, §1, and this section state the same exact truth: the §1 latch is mechanical **only** for entries actually recorded in that fence, and R21/R22/R23 — and, as of v27, R24 — are documentary and Git-lineage rounds: immutably preserved, never withdrawn, never approvals, and never described as mechanically latched. §1 adds that no unrecorded rejection may be claimed as latched and that nothing turns on the correction, because no entry matches the current digest pair and step 5's "no matching entry" branch already resolves the state to `blocked`. This round R23, and R24 after it, are recorded on the same documentary terms. The rejection remains documentary history, not approval |
| R23 (d) | **Low: §3 direct-create summary omitted `DISCARDED`.** §3 summarized the current surface as "accepts direct `PLAN\|DEV\|REVIEW\|TEST\|DONE` (while only direct `INIT_CHECK` is refused)" while §6 and §13 close `INIT_CHECK\|PLAN\|DEV\|REVIEW\|TEST\|DISCARDED`, leaving a reader unable to check the closure list against the baseline | **corrected in v26** by restating §3 against source: the `story_create` schema in `packages/main/src/cli/command-catalog.ts` admits `IDEA\|INIT\|INIT_CHECK\|PLAN\|DEV\|REVIEW\|TEST\|DONE`, the handler refuses only `INIT_CHECK` (`story_create_direct_init_check_forbidden`), and `DISCARDED` is not an enum member today, so it is currently rejected as an unknown value rather than by a dedicated lifecycle refusal. P1f names it explicitly anyway so the closure is total now and stays total if the enum widens, matching §6 and §13 |
| R23 (e) | **Low: §7 selector signature/order tension.** §7 named the selector's first input "the integrity-signed obligation", but the selector's own output is stored in the classification that the signature later covers, so no signature can exist when it runs | **corrected in v26** by rewording §7 to consume the **resolved obligation value** during construction and to state that only the completed artifact — obligation, `requiredEvidenceUnits`, and projected `evidenceBindings` together — is then content-digested and integrity-signed, that no signature exists or is required at selector invocation, and that the stored units and bindings are covered by the signature from that point and move afterwards only through the fresh-Story path. The §4.1 derivation order, six steps as of v27, states the same sequence once |
| R24 (a) | **Express exemption survived as a `docsExempt` promise (blocking).** v26 §4 and §4.1 still said a mechanically non-executable Story "may classify `docsExempt` and continue to render the registered `express-exempt` disposition", and §12's P1 row and §13's rows carried the same promise. That conflates two different exemptions: `docsExempt` proves the absence of an executable/material acceptance target, which exempts a Story from baseline RED/characterization — it says nothing about whether the Story must *author* `verificationIntent`. Meanwhile the plan named no replacement policy value, no function contract for the `resolveVerificationIntentPolicy` change it required, no user-visible message to replace `EXPRESS_VERIFICATION_EXEMPTION_MESSAGE`, no registered process fact to replace `flow-policy:express-verification-policy`, and no compatibility disposition for the live `CLAUDE.md` teaching or the `outcome-semantics-smoke.ts` assertions | **corrected in v27** by retiring the exemption outright. §2 states that `docsExempt` is exempt from baseline RED/characterization only and never from authoring intent. §4 replaces the three-branch express rule with one obligation-driven required-intent policy: the exact closed union `obligation-intent-satisfied\|obligation-intent-required\|obligation-unresolved`, the exact `VerificationIntentPolicyInput`/`VerificationIntentPolicyResolution` contract that removes `channel` and requires the resolved obligation plus the selected units, the typed `verification-intent-required` blocker for zero authored intents in any channel and any obligation, disjointness from `evidence-binding-declaration-missing` and `acceptance-targets-missing`, the three exact replacement message constants, the replacement registered fact `flow-policy:obligation-verification-intent-policy` with its exact rationale and consumer, and a five-part compatibility disposition covering the deleted message constant, `CLAUDE.md`, both smoke tasks, the contract verifier, and the immutable historical receipts that keep the retired string as hash-bound history. Non-circularity is pinned by placing the policy at §4.1 step 3.5 — after obligation and unit resolution, before binding projection, reading no declaration object and no channel, with no back edge. §3 records the exact live surface being retired, §4.1's required-intent paragraph replaces the express paragraph, §11 carries the retirement and registration, §12's P1 row carries the exit condition, and §13 replaces the two express rows with five obligation-neutral rows. Because companion rev 8 mirrors the retired rule at its §0.5 and §7.3, §1.1 records the resulting plan/companion divergence and the exact rev 9 alignment it requires. The rejection remains documentary history, not approval |
| R24 (b) | **Declaration freeze was not total (blocking).** v26 froze a `reproEvidenceBinding` only through the `verification-intent` descriptor source `contentDigest` that feeds `acceptanceSemanticDigest`. That binds a declaration only when its intent item is a descriptor source of some target. A declaration carried by any other intent item moved no frozen digest, and the Story-scoped zero-target docs declaration has no `targets[]` entry at all, so **every** post-freeze edit to it was invisible to every post-DEV boundary evaluator. `checklistDigest` could not close the hole either: it is a whole-file byte digest that ordinary `status`/`verificationEvidence` writes move, which is exactly why it is compared only at DEV admission | **corrected in v27** by adding the Story-level `evidenceDeclarationSetDigest` as the tenth `inputDigests` member and defining it in new §4.2: the exact `CANON([{ checklistItemId, intentRef, sourcePointer, scope, declarationDigest, evidenceBindingDigest },...])` preimage over **every** committed declaration, with `scope: "story"` for the zero-target docs declaration, `declarationDigest` retaining the members the §4.1 projection drops, the exact three-key sort order, an explicit no-deduplication rule, the `CANON([])` empty value, and the `evidence-declaration-set-invalid` refusal. It is covered by the classification `contentDigest`/`integritySignature` and therefore by the frozen `classificationDigest`, with no duplicate copy in `reproFreezeState`. §4's freshness algorithm gains an unconditional post-DEV conjunct that recomputes it from declaration fields and positions alone at **every** boundary, for `redRequired`, `characterizationRequired`, and empty-target `docsExempt` alike, returning `acceptance-target-semantics-drift-after-freeze` for any edit, addition, removal, or move. §4 also states why the two checklist-derived digests are compared at different points, and §4.2 states exactly what cannot move the value (ordinary `status`/`startTime`/`endTime`/`verificationEvidence`/`userSeesSnapshot` writes, an appended declaration-free item) and what deliberately does (an appended declaration-bearing item, reordering ahead of one). §4.1's freeze paragraph names both mechanisms and why neither alone is total, §11 carries the process-fact update and fixtures, §12's P1 row carries the exit condition, and §13 adds five typed rows. The rejection remains documentary history, not approval |
| R24 (c) | **Pre-P2e/P2f behavior was stated two incompatible ways (blocking).** §5.3 and §13 said a `characterizationRequired` or executable manual-observation Story before P2f is "classified correctly but blocked from DEV", while §4/§4.1's own rule is that P1 fails closed and writes no classification when a selected required unit cannot be bound. Both cannot hold: an integrity-signed classification either exists or it does not, and a "classified but blocked" state would leave a frozen-artifact chain and a readable current head for a Story whose units are unbindable. The plan also never named a typed code for the missing P2f contract registry, and never showed that the bootstrap sequence remains reachable without P2f depending on itself | **corrected in v27** by unifying on one behavior and one code. §4, §4.1, and §5.3 now state that any selected `execution:"p2f-artifact"` unit whose contract cannot be bound — no independently approved P2f contract registry at the classification head, or an unresolvable, unapproved, or kind/subtype-incompatible `p2fContractId` — returns the single typed `p2f-contract-registry-unavailable` and writes **no** classification, head, binding, freeze, or credential; ordering makes it disjoint from `evidence-binding-declaration-incomplete`, which covers only a structurally absent or wrong-typed member. The "classified correctly but blocked from DEV" wording is removed from §5.3 and from §13's row. §5.3 additionally proves bootstrap reachability: P2e is a `docsExempt` decision-spec Story whose one required unit is the runner-executed `docs-consistency` unit with an authored intent item and the single Story-scoped declaration, so it never selects a `p2f-artifact` unit; P2f is `redRequired` and proves itself with the already-available P2b/P2c `red-assert`/`green-confirm` runner writers; a P2f-scoped target that ever resolved a `p2f-artifact` unit is refused and moves to a post-P2f Story rather than taking a bootstrap exemption; and P2r, which does consume trusted characterization chains, runs after P2f. §12's P2e and P2f exit rows carry the same statements and §13 adds three typed rows. The rejection remains documentary history, not approval |
| R25 | Claude CLI 2.1.267 independently recomputed and matched the exact v28/rev9 digests `de8a2d8548c4a66ecf35ae01a38b259d1f831da607a86c3ca05ec45d5bd4a122` / `88638e22015dac31d2e85c9d917b7be20a8862deaadd43ee860f7dd6fa402317`, verified the sampled 0.3.296 source truth and all requested cross-document surfaces, then returned REJECT for two P2 defects: §4.2 incorrectly called a declaration pointer byte-identical to its parent intent-item descriptor pointer, and P0p did not own material population of the required-no-default `#/redEvidence` configuration. It also reported three P3 wording issues: stale v27 self-references, "reads no declaration" versus declaration-key inputs, and a docsExempt predicate that named targets but not the Story material diff | **corrected in v29/rev10.** §4 pins the descriptor pointer to `/items/<itemIndex>/verificationIntent/<lane>/<laneIndex>` over the complete intent item; §4.2 and companion §7.3 define the declaration pointer as its strict `/reproEvidenceBinding` child. P0p now owns the checked-in material `#/redEvidence` block with exact pinned directories and explicit companion-§1.2 bootstrap registries, executable-resolution proof, fail-closed absence, and digest binding; §13 tests the missing/unresolvable case and companion §1.2 mirrors ownership. §14 self-references, §4's declaration-object wording, and the docsExempt material-diff conjunct are corrected. This rejection is documentary/Git lineage, not a machine-fence entry, so it is not mechanically latched; the new pair remains blocked because it has no matching approval |

| R26 | Claude CLI 2.1.267 independently matched the exact v29/rev10 digests `e2aebb9d93d835103af4c169fcff6773d5f67f46f4bb64c482d4a33a9b599ae2` / `0cbc3552172ea6b969b494d11a04165cc588f973aa69591fd8d0d6fcdee3d7d2`, read both files end to end, rechecked 0.3.296 source truth and R25, and returned `APPROVE` with `REQUIRED_CHANGES: NONE`. It listed only three P3 editorial observations: §1.1 attributed rev9 mirrors imprecisely to rev10, §14 still called R24 latest, and lifecycle compatibility prose omitted source phase `META` even though no META transition exists. Before recording that approval in the machine fence, the Story Owner independently noticed that v29 asserted a fixed current fence-entry count; appending the approval would immediately stale that prose while leaving the plan digest unchanged | **corrected in v30/rev11, and the scoped-count half superseded by R27 in v31.** §1.1 attributes rev9/rev10/rev11 changes exactly, and §4/§6 plus companion §1.1.3 name META as a migration-required compatibility phase with no registered edge. v30 scoped the one-entry count to its own byte-freeze instead of removing it, which R27 showed to be insufficient; v31 removes every fence-entry count. The v29 approval is preserved as documentary evidence but intentionally not entered in the machine fence |
| R27 | Lifecycle REVIEW of the frozen v30/rev11 bytes under Story B-de09 (Proof-or-Stop reviewers, not an external audit) registered three medium findings against §3 and the audit-lineage prose, verified against 0.3.296 source: (a) §3's "P4 ... changes the non-configurable code constant `REPRO_FIRST_ENFORCEMENT_FLOOR` from `warn` to `enforce`" presupposed a constant that occurs in no file under `packages/` or `scripts/`, and "atomically changes the checked-in value" presupposed a `reproFirstPreflight` block that the repository's `proof-or-stop.config.json` does not contain, leaving the creation of both surfaces unowned by any §12 row while §15 makes the constant a program-completion criterion; (b) §3 asserted in the present tense that the constant "is a registered process-fact surface" although no `PROCESS_FACT_LEVELS` or `process-fact-registry.ts` entry names it; and (c) the header, §1, and §14 stated that at this candidate's byte-freeze the fence "contained one historical entry", but Git shows the fence already held three entries when the final v30/rev11 pair was frozen — the one-entry snapshot was true only of the first v30 byte-state, so v30's scoping fix did not make the count true | **corrected in v31/rev11.** §3 now records both absences against source and states that P4 **introduces** the config block and the constant rather than mutating them, and moves the process-fact registration into P4's deliverables; §12's P4 row is retitled to own both introductions, the closed mode union, and the registration in `PROCESS_FACT_LEVELS`, `process-fact-registry.ts`, and `scripts/verify-process-fact-contract.mjs`; and every fence-entry count is removed from the header, §1, and §14 in favour of the count-free statements that no entry matches the current pair and no entry carries a documentary round label, both of which survive any later append. R27 moved no companion byte: its §1.12 already scopes the floor constant to P4 as a target and no §3 mirror exists there, so the companion stayed at rev 11 through this round and left it later under R28. This round is a lifecycle REVIEW, not a verdict on the design; the resulting pair remains `blocked` under §1 step 5 until a fresh matching `APPROVE` entry exists |
| R28 | Lifecycle REVIEW of the companion spec under Story B-de09 registered one low finding (B-de09:F-006) against checklist item CHK-007, whose acceptance text promised that the companion delegates legacy pre-rename path compatibility to the identity-migration truth source. The delivered rev 11 bytes satisfied only the first half: every retired predecessor storage example had been replaced with `<storyDir>`/`.proof-or-stop` forms — the companion's then-current retired-name scan returned `0` — but no sentence anywhere stated the delegation, so the promised outcome did not occur. The plan carried no mirror of it either | **corrected in companion rev 12.** Its §0.4 `<storyDir>` paragraph now states that the spec names no pre-rename directory spelling as current storage and that which retired identity spellings a reader still accepts is owned by `docs/requirements/decisions/proof-or-stop-identity-migration.md` (per-identity verdicts in `brand-rename-mapping.md`), not by a compatibility rule restated there. No §1..§6 semantics change and no runtime path moves. This round is a lifecycle REVIEW, not a verdict on the design; because plan §1 hashes the companion's exact bytes, the repair moved the companion digest as well as leaving the plan's already-superseded one, and §1 step 5 keeps the current pair `blocked` until one fresh `APPROVE` matches both |
| R29 | Lifecycle REVIEW under Story B-de09 registered one medium finding (B-de09:F-011) against both hashed files: §10's "Legacy v1 handling preserves the accepted subsystem decisions" and "The candidate-intake experiment remains historical authority", and companion §6.5's matching "The intake experiment remains historical authority", deferred to two settled records without naming either. `docs/requirements/decisions/red-evidence-legacy-v1-record-validation-audit.md` and `docs/requirements/decisions/repro-first-story-intake-experiment.md` both exist in the repository, but grep over both changed documents for `legacy-v1`, `record-validation`, `validation audit`, and `repro-first-story-intake` returned zero hits. Because this plan declares itself the program design and acceptance truth source and cites its other sources by exact path (§1 step 1 hashes the companion by path; the companion's front matter names this plan by path), those were the only preservation claims a reader could not trace to the record that settled them, and a later edit to either settled record could not be detected as divergence — the same fragile-reference class R28's own backlink repair had just fixed for the plan/companion link. Documentation traceability only: no runtime, gate, or evidence semantics depend on it | **corrected in v33 / companion rev 13.** §10 now names the legacy v1 audit record by repository path and title, attributes to it exactly the three bullets it settled (its first, second, and fifth — Axis A full validation, Axis B quarantine, and the OPEN-7 pre-merge migration scan), states that this plan restates rather than amends them, marks the remaining bullets as this program's own adoption and promotion rules, and names the candidate-intake experiment by repository path and title; companion §6.5 makes the same citation for the intake experiment and points at this plan by path for lifecycle applicability. No bullet's content, no §1..§6 companion semantics, and no supersession rule changes; the settled records themselves are untouched. This round is a lifecycle REVIEW, not a verdict on the design; it moved both hashed files, so §1 step 5 keeps the current pair `blocked` until one fresh `APPROVE` matches both |
| R30 | A fresh Claude CLI audit of v35/rev13 returned `REJECT` and deliberately emitted non-hex digest headers because its Bash tool was unavailable, so the response was procedurally ineligible and no machine entry was appended. Its complete read still identified one blocking design defect: §1 made any invalid or duplicate entry block the whole append-only fence, but assigned no recovery path, allowing one bad append to poison every future pair. It also observed that §8's universal lock-order claim omitted the registered main write lock and that the header called audit unavailability "explicitly" blocking while §1 only implied it through the no-match rule | **partly corrected in v36 and completed by R31.** §1 separates top-level fence failure from entry eligibility: unparseable or invalid top-level shape blocks globally; invalid entries and every member of a duplicate semantic group are excluded from selection, grant no verdict, remain inert history, and cannot poison unrelated pairs. A bounded fresh-Story recovery restores only non-entry malformed top-level bytes from the most recent Git-valid fence, preserves the before digest/restoring commit outside the fence, requires independent docs/concept review and a fresh Claude audit, and forbids editing or removing any valid eligible entry. §1 now states audit unavailability, timeout, incomplete reads, unavailable independent hashing, and malformed output as explicit no-append blockers. v36 placed the main write lock in plan §8 but incorrectly claimed companion rev13 was already scoped; the next digest-verified audit rejected that conflict, and v37/rev14 completes the lock-order repair as R31 records. The repaired pair remains blocked until a fresh eligible Claude response independently verifies both digests and approves it |
| R31 | Claude CLI independently matched the v36/rev13 digests `5685108c8f567cb755414fb30e4c67c531aaeccdb46855a178bb621291c7d596` / `8885cc9d9fa5fccc1d731545f8ff291337b90c1d55cc141ffc8e3cea8ffa190e`, read both files end to end, and returned `REJECT`. Plan §8 placed main write between transition and per-Story locks, but companion §4.1 still called its main-less order “program-wide,” companion §7.2 defined a main-write-held DONE manifest writer, and R30 falsely claimed the companion order was already scoped. The audit also observed non-blockingly that §5.2 said only “descendant” while authoritative GREEN-BIND requires a strict descendant | **corrected in v37 / companion rev14.** Companion §4.1 now states the same total order as plan §8, including transition-plus-main, main-only, and PLAN→DEV-without-main cases. Companion §7.2 places its manifest writer's main lock after transition when present and before any per-Story or target lock. The R30 disposition above records its partial closure and this superseding repair rather than claiming rev13 already contained it. Plan §5.2 now says `strict descendant`. The rejection remains documentary history and is not a machine-fence entry; the new pair remains blocked pending its own matching audit |

Applicability dispositions are also exact:

| Situation | Allowed disposition | Lifecycle effect |
|---|---|---|
| Fresh analysis proves zero executable/material acceptance targets | `docsExempt` | baseline RED/characterization is not applicable; normal lifecycle, docs/concept review, and validation remain mandatory |
| Historical completed material | separately approved non-Story inventory/migration artifact only | no Story is created at DONE, no current lifecycle credential is minted, and no evidence is reusable by a new Story |
| Pre-adoption v1 record in the manifest | `legacy-unverified` | preserved read-only; cannot satisfy the trusted RED/GREEN gate |
| Repro-First intake artifact without trusted v2 promotion | `candidate-only` | may inform planning; cannot satisfy Story lifecycle evidence |
| Executable target whose RED cannot currently run | `blocked` | never becomes `docsExempt`; any separate incident route is non-compliant and mints no Story credential |
| Unrelated legacy documentation/provenance defect | routed out of this program with a traceable owner | does not broaden this program and does not erase the observation |

No free-form `not applicable`, `non-reproducible`, `docs-only`, or `already done` string is a recognized disposition.

Out of scope for this program:

- cryptographic resistance to a fully hostile local writer with filesystem/toolchain control (Tier-C signed-receipt work);
- new language parsers unrelated to the language-neutral material classifier;
- treating Lab records as formal lifecycle or release evidence;
- widening unrelated receipt-reuse policy;
- repairing unrelated legacy brand paths or audit-document provenance defects.

## 15. Program completion rule

This plan is complete only when every workstream is DONE, `reproFirstPreflight.mode` resolves to `enforce`,
`REPRO_FIRST_ENFORCEMENT_FLOOR` is `enforce`, downgrade/omission fails closed, the acceptance matrix passes
against all transition paths, legacy/candidate inventory is dispositioned, and the current repository can no
longer complete an executable Story without its required trusted baseline-to-completion chain.

Until then, reports must say **program incomplete** and identify the next unfinished workstream. A successful plan audit approves the design for implementation; it is not evidence that the runtime already enforces it.
