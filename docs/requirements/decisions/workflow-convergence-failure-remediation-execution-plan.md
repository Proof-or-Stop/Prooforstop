# Workflow Convergence Failure Remediation Execution Plan

Status: proposal / execution coordination only; runtime fixes are not implemented by this document

Date: 2026-07-15

Story: B-9f8a

## 1. Decision

The six workflow failures confirmed while closing B-7776 will be remediated as
five cohesive implementation workstreams, not as one cross-subsystem patch:

1. DONE-required validation timeout and fresh-receipt reuse;
2. unattended host liveness and candidate-routing specificity;
3. typed agent dispatch contracts;
4. stable per-task, per-agent owner identity;
5. canonical scope paths and AST-backed semantic anchors.

This document coordinates execution order, shared invariants, verification, and
rollback. It does not replace the subsystem decisions listed in section 4 and
does not authorize runtime changes inside B-9f8a.

## 2. Trigger and Observed Evidence

B-7776 was a small cleanup that removed a misleading unused parameter. The
implementation itself was correct, but its lifecycle exposed six independent
failure modes. Claude's follow-up source audit confirmed all six; it also
corrected two details in the initial diagnosis:

- the multi-minute host stall occurs during real CLI execution, not during the
  bounded availability probe;
- the scope-path mismatch is between checklist-relative and repo-root-relative
  forms, not between `allowedModify` and `files.modify`, which preserve the same
  input string.

Two failures reproduced again while preparing this document:

- dispatching `verification-intent` or `test-intent` returned implementer
  instructions, so the reviewer had to use `testintent_handoff`;
- separate shells in the same Codex task and worktree derived different
  `ppid`-based session ids and rejected the owner as foreign until the existing
  `LATTICE_SESSION_ID` was reused.

| ID | Confirmed behavior | Primary evidence | Operational effect |
|---|---|---|---|
| C1 | `done_prepare` wraps DONE-required validation in a 240-second phase timeout, while configured sequential commands allow 290 seconds for build and 1,200 seconds for the full test suite. | `packages/main/src/handlers/done-prepare.ts`; `lattice.config.json` | A legal suite taking about 278 seconds is killed deterministically by the outer phase timeout. |
| C2 | Safe host probes are bounded, but a real host process can wait for the 12-minute execution timeout after a launcher with unverified unattended support is admitted. | `packages/main/src/core/host-execution-readiness.ts`; `packages/main/src/core/host-run.ts`; `packages/main/src/handlers/cross-host-review.ts` | Authentication, interactivity, or no-output startup can make unattended routing appear hung. |
| C3 | Generic path/project terms exceed the 50-hit raw-query cap; truncation is treated as ranking-affecting ambiguity and can escalate to a full-corpus read. | `packages/main/src/core/candidate-spec-routing.ts`; `packages/main/src/handlers/candidate-spec-routing.ts` | A tiny change can trigger a 116-file assurance scan and disproportionate token/time cost. |
| C4 | Story-level hints and handler cardinality disagree, while reviewer detection relies on the `lattice-review-` prefix. | `packages/main/src/handlers/story-dispatch.ts`; command catalogue and phase hints | Verification-intent agents can receive commit/status instructions intended for implementers; some reviewers receive prompts they cannot invoke. |
| C5 | The degraded owner id hashes host, repository root, and `ppid`, which changes across shells in one task. | `packages/main/src/core/owner-session.ts`; `packages/main/src/core/story-owner-lease.ts` | A single task can reject itself as a foreign lease owner. |
| C6 | Scope paths are compared without a canonical base, and regex anchor discovery can select control flow or local variables instead of the enclosing declaration. | `packages/main/src/handlers/scope-contract.ts`; `packages/main/src/core/scope-path-classifier.ts`; `packages/main/src/core/scope-diff-pack.ts`; `packages/main/src/core/semantic-scope-gate.ts` | Valid edits produce recoverable false positives; a false protected-anchor match can become unrecoverable. |

These are implementation observations, not new policy definitions. Every future
story must reproduce its relevant red state against the then-current code before
claiming that the issue remains open.

## 3. Goals

- Remove deterministic or unnecessarily long workflow stalls.
- Keep evidence freshness, role separation, scope containment, and fail-closed
  gates at least as strong as they are today.
- Make inexpensive changes receive proportionate candidate discovery and review.
- Make dispatch output schema-valid for the requested role and cardinality.
- Make one task stable across shells without merging independent agents or roles.
- Eliminate known scope false positives without hiding genuine out-of-scope or
  protected-anchor changes.
- Land and roll back each subsystem independently.

## 4. Source-of-Truth Boundaries

This plan is subordinate to the current canonical contracts:

- [DONE Prepare Automation Execution Plan](./done-prepare-automation-execution-plan.md)
- [DONE Prepare Heartbeat And Review Assurance UX Execution Plan](./done-prepare-heartbeat-review-assurance-ux-execution-plan.md)
- [Multi-Host Keyword Candidate-Spec Routing Execution Plan](./multi-host-keyword-candidate-spec-routing-execution-plan.md)
- [Owner Session Contract Execution Plan](./owner-session-contract-execution-plan.md)
- [Session Ownership and Write Leases](./session-ownership-and-write-leases.md)
- [Prewrite Scope Guard Guide](../../guide-scope-guard.md)
- [Proofbound Multi-Role Separation Refactor Plan](./role-separation.md)

If this plan and a canonical subsystem document disagree, the subsystem document
wins. The implementation story must update that owner document or record a new
decision; it must not silently rely on this umbrella plan as an override.

## 5. Shared Invariants

All five workstreams must preserve these invariants:

1. **Freshness remains structural.** A cached receipt is reusable only when its
   required provenance, policy, and command-set bindings match current state.
2. **Unknown authority fails closed.** Unknown launchers, agent types, identities,
   paths, and anchors do not inherit a more privileged default.
3. **Explicit evidence outranks heuristics.** `relatedDocs`, explicit paths,
   typed risk signals, signed reviewer lanes, and protected anchors cannot be
   discarded by keyword or convenience heuristics.
4. **Role identity remains distinct.** A stable task id cannot make implementer,
   verification-intent, reviewer, and delivery roles indistinguishable.
5. **Configured mode is honored end to end.** `shadow`, `warn`, and `enforce`
   semantics must agree across handlers, artifacts, prompts, and gates.
6. **Timeouts clean up.** Every timeout or liveness abort terminates the child,
   releases concurrency/lease resources, and records a diagnostic failure.
7. **Compatibility is explicit.** Legacy artifacts are migrated or read through
   a versioned compatibility path; they are not silently reinterpreted.

## 6. Workstream A — DONE-Required Validation Convergence

### 6.1 Scope

Own C1 only: `done_prepare` phase timing, DONE-required receipt reuse, progress
diagnostics, and focused regression coverage. It must not change which commands
are required by project policy.

### 6.2 Required design

The DONE-required phase must retain the independent hard wall-clock deadline
required by the canonical heartbeat contract, but that deadline must not be
shorter than the legal work it wraps. Derive it from
`sum(effective sequential command deadlines) + bounded orchestration grace`.
Each sequential subcommand also keeps its own hard deadline and cleanup path, so
both a hung subcommand and a stuck interval between subcommands remain bounded.

Using only `max(command timeout)` is rejected because build and test execute
sequentially. Raising the hard-coded default without relating it to configured
commands is also rejected.

Before rerunning DONE-required commands, `done_prepare` may reuse an existing
receipt only when all policy-required bindings match, including at minimum:

- post-merge HEAD;
- material hash;
- story-files hash where applicable;
- DONE-required policy/config digest;
- normalized ordered command specifications, including args and timeouts;
- required build-proof dependencies;
- successful completion state and schema version.

`validate:false` remains an explicit operator choice. It must not manufacture a
receipt or turn stale evidence into PASS. When it is safe only because a fresh
receipt already exists, output must say that directly.

### 6.3 Acceptance

- A fixture with sequential 290-second and 1,200-second declared budgets is not
  rejected by a 240-second wrapper, while the phase still has a derived hard
  wall-clock deadline.
- A deliberately hung child still stops at its own command deadline and leaves
  no process, concurrency slot, or temporary state behind.
- A fresh, fully bound receipt avoids redundant execution.
- Changes to HEAD, material, story files, policy, command order, args, timeout,
  or build-proof dependency make the receipt stale.
- Human and JSON output identify whether validation ran, was reused, was skipped
  explicitly, timed out, or failed.
- The timeout hint does not recommend an identical rerun that deterministically
  repeats the same failure.

### 6.4 Rollback

Receipt reuse must be independently switchable off. If derived phase timing
regresses, retain the independent phase deadline and fall back to a conservative
derived sum plus grace rather than restoring 240 seconds.

## 7. Workstream B — Unattended Host Liveness and Routing Specificity

### 7.1 Scope

Own C2 and C3 together because both belong to candidate proposal routing and its
host-execution boundary. This workstream does not alter cross-host quorum policy
or claim that a fake host is production evidence.

### 7.2 Host readiness and liveness

Availability, launcher compatibility, unattended readiness, first output, and
total execution are distinct states. The router must require positive unattended
readiness before automatic execution. `launcherSupport: unverified` is not
eligible for unattended routing.

Add two bounded execution controls:

- a configurable startup/first-output watchdog;
- a total host execution deadline.

The first-output watchdog must account for known launchers that legitimately
delay output, and its timeout must produce a launcher/auth/interactive/no-output
diagnostic rather than a generic disagreement. Both controls must propagate
abort to `host_run`, kill the child, and release capacity.

`host=fake` is allowed only in deterministic tests or explicit local diagnostics.
It must never be suggested as a production assurance substitute.

### 7.3 Query specificity

Add corpus document-frequency/IDF information to deterministic query selection.
Generic tokens above a configurable frequency threshold may be removed or
down-weighted. A 40% threshold is a candidate rollout value, not a permanent
unexplained constant.

Frequency filtering must never suppress:

- explicit `relatedDocs`;
- exact file paths or semantic anchors;
- process/runtime fact registry references;
- typed, structured risk signals;
- reviewer-selected evidence already bound to the story.

Titles, descriptions, and checklist prose must not be copied wholesale into
`riskSignals`. Structured risk signals and search seeds need separate types.

Raw-hit truncation alone must not force full-corpus escalation when all omitted
items are below a deterministic relevance floor. Escalation must record which
query group, cutoff tie, risk signal, or missing explicit source required it.

### 7.4 Mode consistency

The configured routing mode must flow through handler, artifact, reviewer prompt,
and gate:

- `shadow`: record comparison and metrics; never instruct a reviewer to stop;
- `warn`: display an actionable advisory; do not count it as enforce evidence;
- `enforce`: block only on the documented enforce predicates.

### 7.5 Acceptance

- An unverified launcher is not spawned by unattended routing.
- A no-output child terminates at the startup watchdog; a productive long-running
  child is governed by the total timeout, not the startup timeout.
- Child cleanup and capacity release are verified for timeout and abort paths.
- Generic `lattice`, `proofbound`, `core`, and `handlers` terms no longer cause a
  full-corpus scan by themselves.
- Exact paths and all configured `relatedDocs` remain candidates even if their
  tokens are common.
- A genuinely high-risk typed signal can still escalate.
- Shadow mode produces artifacts and metrics without enforce-style STOP text.
- Routing artifacts explain included, filtered, truncated, and escalated terms.

### 7.6 Rollback

Roll out IDF and unattended-readiness enforcement behind separate configuration
flags. Roll back ranking changes without re-enabling unverified unattended hosts.

## 8. Workstream C — Typed Agent Dispatch Contract

### 8.1 Scope

Own both C4 subproblems: story-level/item-level cardinality and role-specific
prompt selection. Do not fix this with additional prefix checks.

### 8.2 Required design

Introduce one explicit agent-type registry shared by command schema, handler,
prompt builder, hints, and tests. Each registered type declares:

- canonical name and supported legacy aliases;
- role class;
- allowed lifecycle phases;
- story-level or required identifier cardinality;
- accepted identifier kinds (`itemId`, `findingId`, `clusterId`);
- prompt builder;
- permitted state-changing commands;
- whether commit instructions are allowed;
- reviewer lane and evidence ownership, if any.

At minimum the registry must model implementer, verification-intent, INIT
reviewers, story reviewers, item reviewers, coverage reviewer, finding repair,
and delivery reviewer. `verification-intent` is the current name; legacy
`test-intent` and `test-case-reviewer` behavior must be deliberate compatibility,
not accidental fallback.

Unknown agent types fail before prompt generation. They must never receive
implementer instructions. Hints must contain a dispatch invocation accepted by
the same schema they describe.

### 8.3 Acceptance

- `verification-intent`, `test-intent`, and `test-case-reviewer` never receive
  implementer commit or `status:done` guidance.
- Unknown types fail closed with valid type/cardinality guidance.
- Every story-level hint succeeds as story-level, or explicitly supplies the
  required `itemId`/finding/cluster identifier.
- Story reviewers cannot write implementer status, and implementers cannot mint
  reviewer pass evidence.
- Prompt examples contain only schema-valid command payloads; optional nullable
  fields are omitted when the CLI does not accept `null`.
- A table-driven smoke covers every registry entry, alias, phase, identifier
  cardinality, prompt class, and denied command class.
- Process-fact registry and contract verification are updated if reviewer/gate
  semantics change.

### 8.4 Rollback

Keep legacy aliases during migration, but route them through registry entries.
Do not restore prefix-based privilege inference as rollback.

## 9. Workstream D — Stable Per-Task, Per-Agent Owner Identity

### 9.1 Scope

Own C5 as a regression repair against the fully implemented B-9089 owner-session
contract. The observed `derived-ppid` self-conflict is a defect or newly exposed
contract gap in shipped behavior, not evidence that the canonical rollout is
unfinished. Any change to canonical identity or resolution priority requires an
explicit update/new decision rather than being smuggled in as implementation.
This workstream is security- and role-separation-sensitive.

### 9.2 Required identity model

The stable identity must include two independent dimensions:

```text
taskIdentity + agentOrRoleIdentity
```

The host adapter should inject both into child shells and retain them for the
lifetime of the task/agent. A repository-global token is rejected. A thread id
alone is also rejected when implementer and reviewers share that thread.

Resolution order should remain explicit and observable:

1. deliberate `LATTICE_SESSION_ID` override;
2. validated host-adapter task + agent identity;
3. bounded generated-token fallback with defined storage, ownership, and cleanup;
4. `derived-ppid` degraded fallback with a warning before mutating commands.

The adapter must not expose raw host tokens in logs or artifacts. The resulting
session id should be a stable derived identifier with source metadata sufficient
for `session_brief` diagnostics.

Before implementation begins, record fresh review of the current owner-session
decision from at least two independent hosts, following its canonical evidence
requirements. Prefer Codex CLI plus Claude Code CLI; Antigravity CLI (`agy`) may
be used where the owner document permits it. Local two-host review remains local
assurance and does not widen Authority or release claims.

### 9.3 Acceptance

- The same agent in the same task and worktree retains one owner identity across
  multiple shells and process-parent changes.
- Two independent tasks in one repository do not share an owner identity.
- Implementer, verification-intent, reviewer, and delivery agents in one task do
  not collapse to one privileged identity unless the canonical policy explicitly
  defines shared ownership.
- An actual foreign session remains blocked; stale and active takeover semantics
  are unchanged and audited.
- Explicit `LATTICE_SESSION_ID` remains a supported deterministic override.
- Degraded `ppid` use is rendered in diagnostics and warns before the first
  story-scoped mutation.
- Codex CLI, Claude Code CLI, and Antigravity CLI (`agy`) adapter cases are tested.

### 9.4 Rollback

Host adapters may fall back to explicit `LATTICE_SESSION_ID`. Rollback must not
use a repository-global token or silently treat all same-worktree processes as
one owner.

## 10. Workstream E — Canonical Scope Paths and AST Semantic Anchors

### 10.1 Scope

Own C6. Canonicalize path semantics at the contract boundary, then replace
declaration inference with a versioned parser-backed representation.

### 10.2 Canonical path contract

New scope contracts must store one explicit path base, preferably
repo-root-relative. Inputs such as package-source-relative paths are resolved at
write time using project configuration and persisted in canonical form.

Canonicalization must:

- normalize separators and dot segments;
- reject absolute paths where the schema requires repository-relative paths;
- reject `..` escape;
- resolve or reject symlink escape consistently;
- preserve exact-file versus subtree/glob meaning;
- record original input when useful for diagnostics;
- version legacy read/migration behavior.

The gate must compare canonical paths on both sides. It must not indefinitely
accept multiple ambiguous bases by trial and error.

### 10.3 Semantic anchors

Use the TypeScript parser/AST to select the nearest enclosing declaration:

- function or method;
- class/interface/type declaration;
- top-level variable declaration when it is the intended declaration;
- explicit file/module fallback.

Control-flow nodes (`if`, `for`, `while`, `switch`, `catch`) and local variables
must not replace their enclosing function/method anchor. Regex keyword exclusion
is acceptable only as a bounded stopgap before AST landing.

Persist an `anchorParserVersion` or equivalent in scope/evidence artifacts.
Changing parser semantics makes affected evidence explicitly stale; it must not
silently reinterpret signed historical evidence.

Protected-anchor behavior remains fail closed. Acknowledgement may continue for
the existing recoverable violation classes, but must not become a bypass for a
real protected anchor.

### 10.4 Acceptance

- `core/foo.ts` declared relative to configured source root resolves to the same
  canonical file as `packages/main/src/core/foo.ts` from git diff.
- repo-relative, source-relative, Windows separator, dot segment, traversal, and
  symlink cases have deterministic results.
- `if`, `for`, `while`, `switch`, `catch`, local `const`, methods, nested
  functions, classes, and top-level declarations map to expected anchors.
- Genuine out-of-scope paths and protected-anchor edits still block.
- Legacy artifacts are migrated or diagnosed; parser-version drift produces a
  stale/re-attestation result rather than silent PASS.
- Scope diagnostics display original input, canonical path, selected declaration,
  parser version, and the rule responsible for pass/fail.

### 10.5 Rollback

Path canonicalization and AST anchors need independent rollout flags. Existing
signed artifacts remain readable through versioned readers; rollback does not
rewrite them in place.

## 11. Story Slicing and Landing Order

Do not combine A, B, and C into one "deterministic fixes" story. They touch
different state machines, evidence contracts, and rollback surfaces; combining
them would recreate the assurance-cost imbalance this program is meant to fix.

| Order | Proposed story | Owns | Why here |
|---|---|---|---|
| 1 | DONE-required validation convergence | A / C1 | Removes a deterministic DONE blocker and makes later stories cheaper to close. |
| 2 | Typed agent dispatch registry | C / C4 | Prevents role-polluting prompts during the remaining implementation program. |
| 3 | Unattended host liveness and candidate specificity | B / C2+C3 | Reduces stuck external execution and disproportionate review scans. |
| 4 | Stable task-and-agent owner identity | D / C5 | Needs deliberate adapter/role design; explicit session id remains a safe interim workaround. |
| 5 | Canonical scope paths and AST anchors | E / C6 | Benefits from clean role/session behavior and requires versioned evidence migration. |

Workstreams A and C may proceed in parallel only if they do not share command
catalogue or generated prompt files. Workstream D must receive role-separation
review before changing adapter identity. Workstream E must define artifact
versioning before enabling AST results in an enforce gate.

## 12. Rollout Stages

Every workstream follows the same control pattern where applicable:

1. **Red fixture:** reproduce the exact current failure with bounded deterministic
   inputs; do not depend on a live external host unless the claim is host-specific.
2. **Observe/shadow:** record old and new decisions, durations, candidate counts,
   identities, or anchors without changing gates.
3. **Warn:** surface actionable divergence with the canonical next command.
4. **Enforce:** enable only after negative regression cases pass and divergence
   metrics are within the story's accepted threshold.
5. **Cleanup:** remove legacy behavior only after the compatibility window and
   source-of-truth docs are updated.

Not every subsystem exposes all three modes today. A story must not invent a
mode label without wiring it through config, handler, artifact, prompt, and gate.

## 13. Verification Matrix

| Area | Positive proof | Edge proof | Adversarial/negative proof |
|---|---|---|---|
| DONE convergence | Legal long suite completes or fresh receipt is reused. | Sequential budgets derive an independent phase deadline from their sum plus bounded grace. | Stale/mismatched receipt is rejected; hung child is killed and cleaned up. |
| Host liveness | Verified unattended host produces output and completes. | Slow productive host passes startup but remains under total deadline. | Unverified/no-output/interactively blocked host is not left running. |
| Candidate specificity | Exact paths and related docs are selected. | Common terms are down-weighted with an explainable threshold. | High-specificity risk still escalates; shadow never emits enforce STOP. |
| Dispatch | Every known role receives its registered prompt and legal identifiers. | Legacy aliases map explicitly. | Unknown/reviewer roles never fall through to implementer commands. |
| Owner identity | Same task+agent survives shell changes. | Explicit override and generated fallback remain deterministic. | Different tasks/roles do not collide; foreign owner still blocks. |
| Scope paths | Equivalent path forms canonicalize identically. | Separators, dots, source-root mapping, and migration are deterministic. | Traversal/symlink escape and genuine out-of-scope writes remain blocked. |
| Semantic anchors | Functions, methods, classes, and nested declarations resolve correctly. | Local variables and control-flow nodes retain the correct enclosing declaration. | Protected anchors remain unacknowledgeable; parser drift stales evidence. |

Each implementation story must add focused smokes and update process-fact or
runtime-fact contract verification when it changes a fact consumed by a gate.
The full DONE-required suite remains required only under the project's configured
policy; no focused smoke may be presented as equivalent full-suite assurance.

## 14. Metrics and Exit Criteria

Record before/after values where the subsystem supports them:

- DONE validation executions reused versus rerun, phase duration, command timeout,
  cleanup failures, and repeated identical timeout hints;
- host probe duration, startup-to-first-output, total execution, timeout reason,
  orphan cleanup, and unattended-readiness rejection;
- query groups, document frequency, filtered tokens, raw hits, candidate count,
  escalation reason, corpus-read count, and routing mode;
- dispatch type, alias, cardinality, prompt class, rejected unknowns, and schema
  validation failures;
- session source, task stability, role collision, foreign-owner rejection, and
  takeover rate;
- original/canonical path, parser version, chosen anchor, false-positive fixture,
  genuine violation, and stale-evidence classification.

The program is complete only when all five stories are DONE, their canonical
subsystem documents reflect shipped behavior, no open high/critical finding
remains, and the negative cases in section 13 pass. Finishing this umbrella
document does not satisfy those exit criteria.

## 15. Risks and Controls

| Risk | Failure introduced by a naive fix | Required control |
|---|---|---|
| Longer timeout hides a real hang | Operators wait longer with no useful signal. | Per-command deadline, first-output/heartbeat diagnostics, child cleanup. |
| Receipt reuse weakens freshness | Stale full-suite evidence passes DONE. | Bind HEAD, hashes, policy, ordered command specs, build proof, and schema. |
| IDF removes a relevant document | Review cost falls but coverage silently regresses. | Exempt explicit paths, relatedDocs, registries, and typed risks. |
| Readiness enforcement rejects usable hosts | Cross-host capacity drops unexpectedly. | Shadow measurement, launcher-specific fixtures, actionable remediation. |
| Registry migration breaks legacy agents | Valid aliases stop dispatching. | Explicit alias entries and table-driven compatibility tests. |
| Stable token merges roles/tasks | Lease or anti-self-review boundaries are bypassed. | Separate task and agent/role dimensions; collision tests. |
| Canonicalization broadens scope | A path outside the repository becomes allowed. | Containment, traversal, and symlink checks at write and compare boundaries. |
| AST upgrade changes historical meaning | Old evidence appears valid under new anchors. | Parser version and explicit stale/re-attestation handling. |

## 16. Explicit Non-Goals

This plan does not:

- implement any of the five runtime workstreams;
- create the five downstream stories automatically;
- combine all fixes into one large story;
- change DONE-required command policy or waive the full suite;
- treat `validate:false` as evidence generation;
- use `host=fake` as production assurance;
- hard-code 40% document frequency as an unexplained permanent threshold;
- use `CODEX_THREAD_ID`, repository root, or a repository token as the sole owner
  identity;
- allow unknown agent types to inherit implementer or reviewer privilege;
- make scope acknowledgement bypass protected anchors;
- claim that the six issues are fixed merely because this document is DONE.

## 17. Implementation Intake Template

Each downstream story should copy this minimum intake structure:

```text
Observed red state:
Canonical owner document:
Files/process facts touched:
Chosen design and rejected shortcuts:
Compatibility/versioning boundary:
Positive acceptance cases:
Edge acceptance cases:
Adversarial negative cases:
Shadow/warn/enforce plan:
Rollback switch:
Metrics and DONE evidence:
```

The story description must identify one workstream from this plan and cite its
canonical subsystem document. Cross-workstream changes require a new explicit
decision rather than silent scope expansion.
