# Verification execution receipt fan-out and input-scoped freshness

Status: accepted for B-aa5f.

## Decision

Executable verification is represented by three immutable, versioned records instead of one selector-bearing execution record:

1. `VerificationExecutionReceiptV3` records the execution-affecting identity, effective timeout, complete-output artifact reference, dependency-manifest binding, `evidenceInputDigest`, exit status, and execution time. It contains no selector or selector result.
2. `VerificationAssertionReceiptV2` binds one `intentRef`, immutable selector digest, matcher version, execution-receipt digest, output digest, publication mode, exact nullable reuse-receipt digest, matched result, and an independent tool signature.
3. `VerificationReuseReceiptV1` binds a later admission to the unchanged prior execution receipt, output artifact, dependency manifest, input digest, and execution identity. It never rewrites the prior execution time or digest.

`VerificationReceiptBundleV5`, containing the current execution, assertion, and optional reuse records with their signed cross-links, is the only split bundle eligible for lifecycle admission and reuse. `VerificationAssertionReceiptV1`, `VerificationReceiptBundleV2`, `VerificationReceiptBundleV3`, `VerificationReceiptBundleV4`, and the legacy combined receipt remain readable only for audit and migration diagnostics; they are explicitly non-reusable, non-promotable, and cannot satisfy lifecycle admission.

V5 adds `VerificationPublicationBindingV1`, independently signed in the `publication` domain. It binds Story identity, the exact `headHash`/`materialHash`/`storyFilesHash` tuple, executed/reused mode, and all execution/assertion/reuse/output-artifact/output links. V3 execution, V2 assertion, and V1 reuse components retain their versions and immutable bytes. Producers capture and recheck freshness around actual execution; fan-out preserves that observation's tuple across metadata-only publication commits. Authorized reuse signs a new current publication tuple without rewriting the prior execution. Rewriting unsigned outer hashes cannot renew authority.

Gate admission, stale refresh, and DONE use one `current` / `stale-needs-execution` / `invalid` classification. Every current execution—including ordinary commands with incomplete closure—recomputes live environment/toolchain/input identity. Authentic stale or legacy evidence needs real execution; invalid signatures, command bindings, or publication links fail closed. Ordinary evidence never acquires persistent-cache authority. Signed execution command, evidence command, and the immutable intent pin must agree before lifecycle or narrowing consumption.

Toolchain identity hashes the actual child executable selected through the invocation's effective environment and child cwd, including relative PATH entries, separately from the absolute host Node runtime. Exact capsule invocation selects its closed environment even when evidence metadata does not establish reuse eligibility; dependency completeness remains a separate decision. Unresolvable or unreadable executable bytes fail closed rather than admitting a digest of missing identity. Resolution retains the existing platform-specific explicit-path/PATHEXT envelope and binds the Windows implicit ComSpec/cmd.exe shell separately; platform-injected checks establish identity compatibility, not a claim of Windows-native execution coverage.

Authentic V4 full output remains available for historical audit, preserving the frozen earlier narrowing requirement's observation semantics. Its current authority is renewed only by a genuine execution producing V5; V4 is never promoted or reused in place.

## Trust boundary

Receipt-shaped JSON, caller-provided hashes or signatures, and narrative text such as “PASS” have no authority. The runtime owns execution, artifact publication, digest creation, selector evaluation, and reuse lineage. Every REVIEW, TEST, DONE, validation, readiness, `done_prepare`, and certification coverage consumer calls the shared proof-admissibility evaluator, which in turn calls the authoritative receipt validator.

The same boundary applies to dependency declarations. The legacy v1 manifest's `complete`, `deterministic`, no-network, no-side-effect, and related booleans are caller assertions and cannot establish closure. A v1 manifest and every arbitrary JavaScript, package-manager, or ordinary validation command remain non-reusable, regardless of those values.

On every authoritative read, the validator recomputes receipt digests and links, reads the immutable content-addressed artifact, verifies its canonical artifact digest and embedded complete-output digest, and evaluates the pinned selector over the complete captured output. `outputTail` is display-only. For V5, it must equal the canonical bounded tail derived from the authenticated artifact; a missing or changed projection fails closed. Narrowing receives the validator's complete authenticated output for every direction, presence, and absence check, never the display tail.

Stable denial classes are `verification_receipt_missing`, `verification_receipt_legacy`, `verification_receipt_invalid`, `verification_receipt_not_passing`, and `verification_reuse_incomplete`.

## Execution and fan-out flow

Rows are grouped only by execution-affecting identity: normalized command/argv, resolved cwd, effective timeout, capture semantics, environment, toolchain, platform, architecture, Node version, and input closure. Selector, intent type, evidence kind, and descriptive timeout provenance do not split an otherwise identical execution. Different effective timeout values do.

The command runs once per group and publishes one immutable complete-output artifact and execution receipt. Each row then evaluates its own immutable selector against that artifact and receives an independent assertion receipt. A missing selector therefore demotes only that intent; timeout or nonzero execution status demotes every assertion sharing the execution.

## Policy-owned reuse capsule

Input-scoped reuse is available only to `proof-or-stop.verification-reuse-capsule.v1` with a canonical v2 declarative manifest. The manifest contains only an ordered list of validated repository-local regular, non-symlink files; it contains no completeness booleans and no executable code. The tool constructs the exact Node argv itself, pins a digest of the capsule source and policy, enables Node's permission model, grants read access only to the manifest and listed files, and uses a fixed closed environment. The exact invocation rejects argv substitution, loaders, preloads, dynamic-code injection, ambient `NODE_OPTIONS`, network/child/worker/native/FFI/WASI/inspector access, filesystem writes, escaped or undeclared reads, and permission widening. A runtime without the required permission features fails closed.

Because the capsule's only semantics are to validate the manifest/permission profile and emit the listed file bytes in order, its declared list is mechanically total for the computation. This intentionally does not claim arbitrary verifier programs are hermetic. Those commands continue to execute normally for fresh evidence, but they use strict freshness and cannot mint reuse receipts.

## Input-scoped freshness and reuse

The capsule's validated manifest/input digests, capsule policy digest, exact closed environment, Node/toolchain/platform/architecture, command/argv/cwd/effective timeout, and capture semantics form `evidenceInputDigest` and the execution identity. Missing, malformed, duplicate, escaped, non-regular, symlinked, or changing files deny reuse.

When unrelated Story material changes but that complete identity is unchanged, the old execution receipt and output artifact remain immutable and a new auditable reuse receipt is issued with zero subprocesses. When one of two closures changes, only the affected execution reruns once. If capsule authority is unavailable, both `storyFilesHash` and `materialHash` must be present, canonical, freshly recomputed, and unchanged; metadata-only HEAD movement may remain acceptable. Material drift cannot be downgraded merely because `storyFilesHash` matches. HEAD accepts only a full 40/64-character lowercase Git hash and every SHA-256 field accepts exactly 64 lowercase hex characters.

A fresh real execution with an incomplete closure may satisfy its immediate assertion only while the normal strict whole-Story/material freshness binding remains current. It cannot be reused.

## Concurrency and publication

The repository-local producer lock is derived solely from execution-affecting identity. Single add, batch add, `verification_run`, and stale refresh all derive the same selector-free key; batch acquires sorted unique keys and executes each identity once. Each entrypoint re-reads authoritative pins and evidence inside the lock, and holds coordination through atomic checklist publication. A concurrent waiter consumes only a valid publication that appeared after its own pre-lock snapshot rather than creating persistent reuse for ordinary commands.

Producer coordination uses asynchronous, never-reused acquisition tickets. A live or uncertain owner is not displaced by heartbeat age; only a confirmed dead local PID permits reclaim of that exact ticket. Heartbeat and release target the unique acquisition, not a shared successor path. Incomplete, malformed and legacy mixed ownership layouts fail closed. The live-owner pause regression uses actual POSIX processes; the dead-owner control exits without leaving a child and does not claim containment of orphan subprocesses after an operating-system crash, distributed-filesystem coordination, or Windows-native pause coverage.

The runtime computes execution identity immediately before a real launch and again before issuing execution, assertion, or reuse evidence. If it changed, no receipt is issued and the stable diagnostic is `receiptIssued=false reason=input_changed_during_execution`.

Coordination is execution-key-wide rather than intent-row-wide. A waiter snapshots all current v5 bundle publication digests for its key, then searches the whole authoritative checklist under the lock for a newly published valid execution or reuse publication. It evaluates and signs its own selector assertion over that publication's complete artifact; it never copies another intent's selector outcome, and it preserves the exact signed reuse lineage when the publication was reused. If a receipt that previously carried a v2 capsule binding no longer has current capsule authority, both stale refresh and `done_prepare` classify it as rerun-required even when strict Git hashes have not moved.

## Compatibility boundaries

B-1482’s separately authorized narrowing-only new-pin route remains possible only when the new selector is mechanically proven narrower. Selector substitution, widening, or an unproved repin fails closed. This decision does not turn a reused execution into authority to change an existing selector.

B-83aa partial-hash semantics remain strict: missing or partial material, Story-file, or input hashes cannot authorize reuse or receipt promotion. Legacy records are never silently upgraded by copying current hashes into them.

Receipt-less, unpinned legacy rows retain non-authoritative metadata maintenance. Only existing, genuinely stale metadata is refreshed; failed, waived, deferred, missing-head, pinned and receipt-bearing rows cannot enter this fallback. An unexecuted command-backed pass is explicitly demoted, and a commandless attestation never acquires a receipt or executable gate authority. This compatibility scheduling is separate from the unchanged authoritative receipt-admission evaluator.

## Failure and tamper behavior

Artifact bytes, embedded output digest, execution receipt, assertion receipt, reuse receipt, selector binding, matcher version, cross-record links, execution identity, and dependency/input bindings are all verified. For V5, SHA-256 of the top-level compatibility selector must equal the selector digest carried by the independently signed assertion; a missing or substituted projection fails closed before lifecycle or narrowing consumption, while the ExecutionReceipt remains selector-free. `VerificationAssertionReceiptV2` and `VerificationReceiptBundleV5` explicitly bind `publicationMode` (`executed` or `reused`) and the exact nullable reuse-receipt digest. A reused bundle requires its reuse receipt; an executed bundle forbids one. Deleting or injecting reuse lineage, or changing any linked digest, fails closed. Nonzero exit and timeout fail every assertion sharing that execution; a selector mismatch fails only that assertion.

Canonical digests provide addressing and cross-links, not producer authenticity. Each tool-owned v5 graph therefore independently signs the execution, every per-intent assertion, any reuse record, and publication context using Ed25519 with separate `execution`, `assertion`, `reuse`, and `publication` domains. Verification resolves the trusted public key from a fixed git-common-dir key path and requires the embedded key and key id to match it. Recomputing every public digest or replacing the embedded key cannot forge these signatures. This boundary does not claim resistance to an operating-system attacker who can steal the repository-local private key.

## Local-main causal integration

CHK-008 preserves causal preflight/import isolation at the execution layer.
Signed causal inputs bind the selector-free physical key; receipt-keyed import
snapshots cannot substitute readiness from another causal identity. Each actual
execution also has an observation-only identifier, so a new ordinary subprocess
cannot inherit a cached observation's timestamp. This identifier never enters
physical fan-out grouping or producer locks. Current V3 execution time projects
that actual signed causal source, and V5 fan-out retains the producer's execution
bytes and time while issuing distinct assertions. Selector, intent type,
evidence kind and descriptive timeout provenance remain assertion-local;
effective timeout, command and environment remain execution inputs. Complete
verification output capture coexists with the capsule's exact closed environment;
routine validation display stays bounded.

Batch followers replay the actual authenticated producer observation through
the existing causal API so its ledger counts each independently evaluated
consumer, not only subprocess producers. These causal selector verdicts retain
their bounded diagnostic semantics: a probe miss cannot demote a valid V5
assertion, and a probe match cannot grant admission. Only the independently
evaluated authenticated complete-output V5 AssertionReceipt controls selector
admission. Replay does not launch, re-sign, retime or mutate the source execution.

## Migration and rollback

Migration is additive. Legacy combined receipts, `VerificationReceiptBundleV2`, `VerificationReceiptBundleV3`, `VerificationReceiptBundleV4`, and legacy `VerificationAssertionReceiptV1` records remain visible as read-only audit history with explicit legacy diagnostics, while the next tool-owned execution emits a `VerificationReceiptBundleV5` containing `VerificationAssertionReceiptV2`. Those legacy records cannot satisfy lifecycle admission, reuse, or selector-narrowing proof—even when a selector field is present—and there is no in-place promotion.

Rollback disables new reuse/fan-out production and forces strict real execution. Existing v5 records remain readable and verifiable; they are not rewritten to older shapes. Removing the v2 capsule manifest, changing the capsule policy, losing permission enforcement, or presenting a legacy/self-attested manifest immediately denies reuse and returns to strict Story/material freshness.

## Dynamic intent fingerprint diagnostics

`proof-or-stop evidence_plan --storyId=B-xxxx --json` derives its intent list from
current structured verification intents, including requirements without evidence.
It displays each real description, stable ID (or the existing lane/index fallback),
execution-group key, current per-intent fingerprint and an order-stable root fingerprint.
Nothing is sized to a particular Story or historical receipt count. Explicit IDs
survive reordering; legacy positional IDs retain their existing positional meaning.
Duplicate IDs are rejected instead of silently collapsing requirements.

The execution fingerprint uses the existing live command/input/environment/toolchain
identity. A mechanically complete capsule closure excludes unrelated material;
ordinary commands retain both material and Story-file bindings. Selector and intent
semantics belong to the leaf, not the shared execution group. Changing an input used
by two intents schedules one existing execution, with two independently authenticated
assertions. Adding an unverified intent changes the root and remains visible as missing.
Timestamps, receipt publication and result status are not fresh execution inputs.

These fingerprints are diagnostic-only: equality never replaces signature/output
validation, pin binding, lifecycle expiry or current state checks. Executable rows
use the shared gate receipt evaluator and report current, reuse, rerun or invalid.
The existing signed refresh writer remains the only execution/reuse producer.
In `evidence_plan`, an unsigned or stale ordinary pass is never advertised as a hash-only refresh.
The legacy `evidence_refresh` compatibility preview explicitly labels its JSON and
text as metadata drift only, without evaluating executable admission, and directs
the operator to `evidence_plan` for execution/reuse requirements. Its existing
metadata-only apply path is unchanged; it never substitutes for command re-execution.
Non-executable attestations and existing waivers retain their separate compatibility
behavior. A waiver is reported as manual policy coverage and never authorizes execution reuse.
An informational command on an unpinned docs/manual attestation does not make the
intent executable or create an execution group. Both planner buckets and fingerprints
select evidence from the owning checklist item, matching the writer's item/ref check;
a misplaced record on another item remains missing coverage.

Legacy receipts without complete input authority are not upgraded by inventing a
manifest. A genuine eligible execution must establish that authority first. This
repair does not extend the fixed capsule to arbitrary programs or claim that import
scanning or an observed read trace proves complete dependencies. For the historical
B-e6d9 commands, incomplete closure remains an explicit reason for re-execution.

Regression: `node packages/main/tests/intent-fingerprint-reuse.test.mjs`, also called
by the existing evidence-plan smoke, executes the real producer and refresh handlers.
It checks dynamic membership/descriptions, unrelated and affected input groups,
shared-command fan-out, strict ordinary fallback, immutable reuse, tampering and
read-only reports, zero planner executions and individually admitted assertions
after shared-command fan-out. The smoke imports this regression in its own supervised
process rather than launching an unmanaged child. Fixture results are not real-Story acceptance receipts.
The existing root `test:all` script discovers `dist/tasks/*-smoke.js`, including
`evidence-plan-smoke.js`; this smoke is not skipped in `smoke-manifest.json` and
imports the new regression. Run its actual suite path with
`npm run test:all -- --select evidence-plan --jobs 1 --no-retry` (one worker,
the runner's existing 60-second per-smoke default). Canonical serial-reference
membership is unchanged. The smoke's stale `authorityDone`/`productionDone` text
assertions were also repaired to check the already-published `admissibilityStatus`
and `evidenceScope` output; their old literals failed against the pre-Lab renderer.

At maintenance base `db43a2611c25bb8153d1a32db67c6d39be1b4e3e`, the full process-fact
verifier has a pre-existing failure: it expects the retired-vocabulary guard to
contain `52a283cfcdc3bfbb233feab6d31614d0eabf8470a41d3af10ad7786246905720`,
but that unchanged guard does not contain the literal. The candidate run reported
that same sole failure; the new diagnostic checks passed. This comparison checks
the exact baseline source predicate, not a claim that the complete baseline suite
was rerun. The unrelated guard is preserved; full process-fact success is not claimed.
