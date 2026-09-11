# Dynamic Finding head-only recovery and activation diagnosis

Date: 2026-09-11. Bounded Lab maintenance based on main
`e78fc432722c500ec54c21d82decafb6835cf8a9` (0.3.318).
This is not formal Story DONE, operational qualification, or a release.

## Why dynamic authority remains disabled

Observe compares decisions without changing legacy lifecycle gates. Qualified
enforce may consume signed applicability and disposition evidence; requesting
enforce in configuration does not bypass the qualification scorecard. The
Finding-to-validation interface exists, but outside effective enforce returns
disabled constraints. Finding constraints can add required validation; they
cannot remove acceptance tests or authorize Story-scope expansion.

The live main CLI, invoked from the authoritative B-03b7 worktree, returned
47 Finding rows, zero non-null assessment verdicts, zero changed classifications,
and null operation reduction. The qualification query reports an unconfigured
corpus and zero recognized Stories/cases/days. These are scoped query results,
not proof that every raw case or prerequisite receipt is absent repository-wide.
The source report and native Claude audit are local diagnostics under
`.proof-or-stop/tmp/dynamic-finding-claims-audit-20260911/` in the primary checkout.

The direct qualification diagnosis is an unconfigured/unpopulated recognized
corpus, not an absent predicate or evidence that waiting alone will qualify it.
The deterministic calculator controls cover missing input, a complete simulated
boundary input, missing denominators, synthetic-only input, window-only input,
missing independent adjudication and missing prerequisites. A passing simulated
calculator is not a real operational sample. No configuration is changed here.

## Native target RED

Test-first commit: `50ec3a5e3e77889961c597effcdfd680fb14041c`.
The official Lab RED ran the exact command below, exit 1, in 54,318 ms:

```sh
node packages/main/tests/red/red-dynamic-finding-head-continuity.mjs
```

The calculator passed 87 assertions; the original material re-attestation
integration passed 9 assertions. The new native head-only case failed, producing
`DYNAMIC_FINDING_HEAD_CONTINUITY FAIL 2 passed 1 failed`.

It used a disposable linked-worktree fixture with real signed Finding/proposal,
target-owner consent, runtime receipts and a signed initial deferral. Committing
its actual process evidence changed only HEAD: material, Story files, scope,
base, acceptance and the selected runtime binding stayed identical. The shadow
gate blocked. After a new equivalent runtime execution, the recovery producer
refused before reaching its independent-review requirement:

```text
HEAD_CONTINUITY fresh equivalent execution must reach independent-review binding,
not permanent drift refusal: reattestation: not an isolated current material drift
```

This proves the bounded recovery-entry gap. It does not prove that every
head-only invalidation is wrong, or that old execution evidence can be reused
without additional proof.

## Root cause and minimal repair

Three parts previously disagreed: the freshness classifier marks head drift
`mismatched`; the recovery producer required an actual material mismatch; and
the gate/source-route readers attempted recovery only for material drift.

The existing recovery port now additionally admits a signed `head_only` recovery
for an otherwise eligible applicable low/medium deferral. It requires unchanged
material and base, descendant Git ancestry, unchanged scope/acceptance/Story,
process, canonical and target-route dependencies, new same-command execution
receipts, and a current independent signed PASS over the exact runtime mapping.
The reader rechecks these conditions, including base and ancestry, on use.
The historical action/type is retained; the signed `driftKind` distinguishes
this bounded branch. Existing material-drift records retain their compatible
path, and unknown recovery kinds refuse.

The raw freshness classifier and its head/base checks are deliberately unchanged.
A mismatch without the complete signed recovery remains blocking. The old
assessment and observation are not rewritten; expiry is not extended. This
does not introduce general no-execution HEAD reuse or arbitrary unrelated-code
reuse. Prompt guidance and process-fact registration/guards describe the same
mechanical boundary.

## Acceptance contract and before/after comparison

| Scenario | Recorded RED behavior | Required repaired behavior |
| --- | --- | --- |
| Persist process evidence, no new proof | Shadow block | Still blocks |
| New equivalent execution at descendant HEAD, unchanged base/dependencies | Refuses before independent review | Reaches and requires independent review |
| Exact current independent PASS plus signed recovery | Unreachable through this port | Restores the bounded deferral |
| Old runtime receipt, changed base, non-descendant history | Not covered by the initial failing branch | Refuses |
| Base changes after accepted recovery | Not covered by the initial failing branch | Reader blocks; no stored fresh-bit authority |
| Replay, self-adjudication, unknown material input | Existing material regression covered | No duplicate write, self-approval or unsafe release |

The pinned command includes the qualification characterization, new head-only
native scenario and original material scenario. GREEN expands the native
negative controls without changing the executable/argv. Official RED/GREEN
results are retained by `lab:worktree status dynamic-finding-head-continuity`.
An intermediate type-check refusal was repaired before acceptance; an accidental
replay against the previous emitted RED build is not represented as GREEN.

## Real closed-loop rollout remains separate

### Executed repaired checkpoint

At `8c11d391e918a2e673d4d3f6aea154a82001a5ea`, official GREEN replayed
the exact pinned command: **3 passed / 0 failed**, exit 0, 91,358 ms. Its three
parts reported 87 calculator assertions, 13 head-only assertions and 9 original
material assertions. These are overlapping fixture checks, not independent
operational cases or a measured reduction in Story time. The process-fact
contract verifier passed.

Independent Claude CLI session `13fdc724-cddb-4d9f-8980-54953d7a0f17`
inspected that frozen fix and executed the head-only command, exit 0, 13 checks
passed. It reported no blockers. Its full returned report is preserved in
`dynamic-finding-head-continuity-claude.json`. The audit explicitly limits
recovery to unchanged dependencies and expiry and rejects orphaned history;
it is not formal reviewer PASS or operational qualification.

The subsequent non-runtime closeout registers the head-only invocation in the
existing Dynamic Finding package chain and protects that registration with a
removal check. It changes no production recovery logic. The package regression
attempt initially stopped at the reviewer-batch compatibility case because this
new Lab lacked `packages/utils/dist/index.js`; that is an environment failure,
not target RED. Utilities are prepared before replaying the affected case and
remaining components. Previously completed components are not represented as
freshly rerun or combined into a fictitious full-command PASS.

### Operational collection sequence

During actual REVIEW work: execute reviewed reproduction/impact witnesses;
obtain a reviewer-owned proposal and target consent where needed; record the
Owner assessment/disposition; independently adjudicate each case through the
official qualification writer; then include the complete cohort in the configured
qualification corpus. Observe/warn keep legacy gate authority while accumulating
evidence. Qualified controlled activation additionally needs the 20-Story,
200-independent-case, 30-day window and all safety/performance prerequisites.

The fixed 2,273-Finding-scale latency requirement is a workload-size contract,
not a count of timing samples; this change does not weaken or reinterpret it.
Matched real workflow operations, review convergence and elapsed-time evidence
remain necessary for any Story-speed claim. The native fixture is regression
evidence, not a fabricated real Story or operational qualification case.

Main configuration, real Story states, runtime trust policy and rollout thresholds
are unchanged. Integration/versioning and any remote publication require their
separate authorized workflows.
