# Codex Session Performance and Workflow Optimization Plan

Status: operational companion for B-5a15 U-03
Scope: make long-running agent sessions resume safely and spend work only where the current evidence requires it.

## Operating principle

Session speed is useful only when proof identity and freshness remain intact.
Reuse the same authoritative story session and worktree when resuming; reuse a
verification receipt only when its execution identity, semantic subject, and
material binding still match. A shorter transcript or a green command without
those bindings is not an optimization.

This plan is operational guidance, not a claim that every suggested workflow
step is implemented by the CLI. Gate-consumed facts remain the responsibility of
the handlers and gates described in the implementation sources.

## 1. Resume and workspace preflight

At the start of a new or resumed session:

1. run `proof-or-stop session_brief` first to recover the active story, phase,
   owner lease, checklist, findings, and next action;
2. run `proof-or-stop aux_doc_list` before selecting related source documents;
3. keep the existing `PROOF_OR_STOP_SESSION_ID` when the same owner is resuming, and
   use the story's existing worktree rather than creating a second worktree;
4. verify the story owner lease, canonical Git worktree, readable Git index,
   current material hashes, and writable evidence target before an expensive run;
5. preserve unrelated generated/runtime files and never use a source checkout
   or metadata edit to bypass a lifecycle gate.

The implementation's last-moment verifier callback is in
`packages/main/src/handlers/verifier.ts`. It refreshes a lease only when the
existing lease belongs to the current session, then rechecks the signed causal
preflight facts before launching a child. It refuses a missing or foreign lease;
it does not create ownership as an accidental side effect of a preflight.

## 2. Spend one execution per causal identity

Before launching a costly command, form the content-addressed identity described
in `causal-evidence.ts`: realpath cwd, structured command, explicit inputs,
story-owned file hash, effective redacted environment, runtime/tool version, and
selector policy. Group only exact identities. Each selector still gets its own
coverage result, so sharing an execution does not merge intent semantics.

The execution ledger is the source for `intentCount`,
`uniqueExecutionKeys`, `commandExecutions`, `cacheHitRate`, `commandReruns`,
`commitFailureReruns`, `unrelatedSpecializedRerun`, `affectedNodeRerun`, and
`falseFresh`. These metrics describe work and correctness; they cannot waive a
missing reviewer pass, stale evidence, incomplete coverage, or a strict
DONE-required command.

## 3. Separate command execution from canonical import

Persist the immutable CAS receipt before importing canonical checklist evidence.
The import transaction must verify the same execution key, receipt hash,
material identity, environment facts, writer lease, and current index/base. If
metadata writing or Git closeout fails, retry the idempotent import transaction
only. Do not rerun the command merely because the canonical write failed.

`runtime-artifact-registry.ts` identifies the story-scoped causal receipt/index
as runtime evidence excluded from behavioral `materialHash`. That keeps receipt
persistence auditable without making the receipt write itself look like a new
product-material change.

## 4. Preserve semantic freshness boundaries

Checklist evidence has two distinct re-persist cases:

- an exact same-semantic row may retain its server-owned prior binding when the
  safe provenance rules allow it;
- a changed note, verdict, file, command, result, waiver, kind, or structured
  attestation is newly authored and must receive hashes computed from the
  current tree. It must not inherit `headHash`, `materialHash`, or
  `storyFilesHash` merely because command and result are unchanged.

`carryForwardOnDiskProvenance` and `evidenceHashesForPersistence` in
`packages/main/src/handlers/checklist.ts` enforce this boundary. Caller-supplied
receipt and freshness fields are not authority. The focused
`tool-executed-evidence-receipt-smoke.ts` regression covers exact carry-forward
and semantic mutations across note, verdict, file, and structured attestation.

## 5. Dependency-aware revalidation

Use declared dependency domains for specialized evidence. A source, test,
build-input, manifest-semantic, integration, or review-subject change should
invalidate the affected transitive closure. An incomplete or ambiguous domain
identity falls back to strict whole-tree freshness. `storyFilesHash` can narrow
the diagnosis and support an explicit advisory where the consumer allows it; it
does not replace `materialHash`, rewrite old hashes, or make a stale result
fresh.

The causal decision is signed and consumed by `CertificationWindow`. The
DONE-required build and full-suite evidence remains strict, so workflow
optimization never becomes an excuse to skip full validation after whole-tree
drift.

## 6. Lifecycle and retry discipline

Use the story lifecycle as the durable work queue: implement in DEV, obtain the
current review evidence in REVIEW, run routine validation in TEST, and use
`done_prepare --mergeMain --refreshStale --validate` before DONE. Do not repeat
the same validation group at the same TEST anchor after a flaky or unavailable
run. If the workflow's convergence guard reports an unchanged-suite retry,
acknowledge the current DEV memory and bounce through DEV, REVIEW, and TEST to
create a new evidence anchor before one fresh attempt.

A validation PASS is admissible only when its command identity, current HEAD,
material hash, story-files hash, coverage snapshot, and clean-tree conditions
match the consumer. Stored PASS metadata is a reuse candidate, not an automatic
completion decision.

## 7. Measurement and review

Measure:

- command executions versus unique execution keys;
- command reruns after failed canonical writes;
- cache-hit rate and receipt reuse;
- affected versus unrelated specialized reruns;
- false-fresh count;
- time spent in execution, import, Git closeout, and lifecycle waiting.

Reviewers must be able to trace each metric to the execution ledger and each
freshness decision to its hashes and signed causal decision. A performance
improvement is rejected if it hides a failed selector, drops coverage, accepts
stale material, or changes the reviewer/TEST/DONE authority boundary.

## Verification commands

The implementation baseline is:

```text
node packages/main/tests/causal-evidence.test.mjs
npm --prefix packages/main run build
node packages/main/dist/tasks/verifier-causal-preflight-smoke.js
node packages/main/dist/tasks/tool-executed-evidence-receipt-smoke.js
proof-or-stop validate --story=B-5a15
```

The root `npm test` is a broader repository check and should be run separately
for shared handler/core changes. No command output or session duration alone is
completion evidence; the lifecycle gates consume the structured artifacts.
