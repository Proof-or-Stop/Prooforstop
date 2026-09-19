# Managed cross-provider CLI execution

Status: Adopted
Story: B-137a
Date: 2026-08-14

Lab maintenance update: status and aggregate wait only observe persisted state.
They do not renew an owner lease, replay an interrupted snapshot/event transaction,
send process signals, or publish a terminal. An independent supervisor is ready
before the production worker starts and owns recovery. A pending transaction is
reported as requiring supervisor recovery until its exact journal replay completes.
The internal explicit recovery entry point supports recovery owners and process
boundary tests; it is not invoked by status or output readers.

The supervisor reports persistent provider absence (including an unreaped zombie),
identity mismatch, and unavailable OS inspection after a five-second observation
grace. Provider startup and result finalization stalled beyond thirty seconds use
the same bounded diagnostic path. These are actionable observations, never PASS,
exit receipts or permission to redispatch. Provider close is journaled before
asynchronous cleanup, so the five-stage projection distinguishes accepted,
starting provider, provider execution, result finalization and terminal. Worker
heartbeat never advances provider progress. Historical ETA and user notification
latency acceptance remain separate from these runtime stage facts.

## Context

When a Claude host started Codex (or a Codex host started Claude) with raw shell
execution, the caller owned the child process implicitly. A caller watchdog,
terminal disconnect, or ten-minute foreground boundary could end observation
without proving that the provider had failed. Treating that loss of observation
as failure caused duplicate reviewer launches; treating `running` forever as
proof of health caused unbounded waits. Output silence alone answers neither
question.

Proof-or-Stop is host-neutral. Native Codex/Claude subagent lifecycle APIs are not
portable and therefore are not the execution contract. This decision covers
only Proof-or-Stop-owned cross-provider CLI processes.

## Decision

Proof-or-Stop owns every public `host_run` and every formal cross-provider CLI
reviewer launch through a durable `ManagedHostRun`. General provider workloads
such as planned steps and autopilot repair keep their existing bounded adapters
but share the mandatory provider-process admission registry; they do not claim
durable reviewer ownership or reviewer evidence. The caller submits and
observes; a detached worker owns the managed provider process until an exclusive
terminal record exists.

The public surface is:

- `host_run`: submit, optionally attach in foreground, or return after claim
  with `--detach`;
- `host_run_status`: read or long-poll one run for at most 30 seconds;
- `host_run_cancel`: idempotently request cancellation;
- `host_run_worker`: private runtime continuation, dispatchable internally but
  hidden from ordinary help/catalog discovery;
- `managed_review_proposal_set`: compatibility-only provider callback for older
  adapters, not the formal managed happy path;
- `managed_review_evidence_import`: verdict-free exact-receipt importer.

`cross_host_review` remains the policy/profile owner for paired host verdicts,
but its Codex leaf executes inside ManagedHostRun and exposes the managed run
and receipt in host-B provenance.

## State and liveness contract

The states are `submitted`, `running`, `completed`, `failed`, `cancelled`, and
`timed_out`. Exactly one terminal file wins by exclusive creation. Repeated
status, cancel and resume operations are idempotent and never create a new run.

Two clocks are deliberately distinct:

- `workerHeartbeatAt` shows that the supervisor can still update its durable
  snapshot;
- `lastProviderProgressAt` changes only when observable provider stdout/stderr
  arrives.

Neither clock is a completion oracle. A provider may legitimately be silent,
and a worker heartbeat does not prove provider progress. Expiry of a 30-second
observation wait is non-terminal: it only wakes the caller and never authorizes
a retry. The `host_run_status` call is also the run's next-touch reconciler,
however, so during that call an already-requested cancellation or an expired
absolute deadline can legitimately publish the corresponding `cancelled` or
`timed_out` terminal state.

Every run has a finite absolute deadline (30 minutes by default, bounded to 24
hours). Deadline or cancellation reconciliation performs bounded TERM, KILL,
reap and residual probing only while the original isolated leader's PID,
PGID/session shape, and start fingerprint remain continuously verified. A
leaderless group with surviving descendants is not authority for a negative
PGID signal: it is retained as residual with `replacementSafe=false` rather
than guessed away. Replacement is safe only when cleanup facts prove there is
no residual process group.

## Persistence and process ownership

Each run has a 0700 directory at
`<primary-worktree>/.proof-or-stop/runtime/host-runs/<runId>/`. Resolving to the
primary worktree keeps the run observable after a Story worktree is removed at
DONE. Immutable spec and digest-only owner data, snapshot, append-only events,
bounded live output, result and terminal receipt are durable. Live output is
capped at 8 MiB per run and reports truncation instead of growing without bound.
Prompt and optional redacted environment are 0600 one-shot files; the worker
validates and deletes them before provider launch. For ordinary managed runs,
the capability is likewise a 0600 one-shot file. A formal
`managed_reviewer`, however, creates no durable `input.cap` private-key
file: its proposal-invocation private key crosses only an inherited descriptor
FD to the worker, which consumes and validates it before provider launch. Only
root and runId cross the detached-worker argv boundary.

On POSIX the provider runs in an isolated process group. Formal managed Codex
reviews receive the prompt through documented stdin and an observable terminal
event stream (`codex exec --json -s read-only -C <scratch> -`). Only Claude launches with
`launchProfile=managed_reviewer` receive a 0600 one-shot prompt file below the
exact provider cwd's ignored `.proof-or-stop/runtime/host-run-prompts/` tree, because
Claude's workspace sandbox rejects an otherwise protected OS-temp prompt outside
that cwd. Ordinary Claude `host_run` launches retain their OS-temporary prompt
transport (`tmpdir()`); neither prompt path puts prompt text in argv. A managed
Claude leaf is bound to its sealed runId, so normal worker cleanup and
post-crash terminal reconciliation remove only that exact leaf after settlement
rather than scanning sibling prompts. A detached formal Claude reviewer has
no approval terminal, so only the signed `managed_reviewer` profile launches it
with `--permission-mode bypassPermissions`; ordinary Claude host runs retain
their configured policy, and the strict final proposal/parser boundary is
unchanged. The current agy print launcher accepts prompt text only in argv, so
managed agy execution refuses before provider spawn until agy exposes a stdin or
protected prompt-file transport. Unsupported platforms likewise refuse before
provider spawn rather than pretending child-only cleanup is equivalent.

## Shared provider admission

Provider capacity is owned by `core/provider-process-registry.ts`, independent
of the usage ledger. All Proof-or-Stop-owned provider workloads acquire an atomic,
token-owned slot under `.proof-or-stop/runtime/provider-process-slots/` before spawn.
Turning off `PROOF_OR_STOP_USAGE_LEDGER` disables usage rows and budget accounting,
not process admission.

A live recorded pid is never reclaimed because of age. Dead pids are
reclaimable only after an isolated provider PGID is also confirmed absent; a
dead supervisor with a live provider group still owns capacity. Corrupt/ownerless
slots use a bounded stale backstop. Release checks the acquire token so a late
old holder cannot delete a slot that has already been reclaimed and reassigned.

Low-level provider adapter modules remain `adapter_only`: their caller owns
admission. Non-provider inspection and verification probes (including
readiness/version, Git/process, provenance, evidence, and lint checks) are
classified separately and do not become review evidence.

### Provider execution surface classification

Every production provider spawn site is classified by
`ProviderExecutionSurfaceStatus` (`packages/main/src/core/provider-process-registry.ts`),
and `packages/main/src/tasks/provider-execution-inventory-contract.ts` fails if a
new spawn path appears without one:

| Status | Meaning |
|---|---|
| `managed` | Executes through ManagedHostRun: durable run identity, supervised process group, absolute deadline, exactly one terminal receipt. |
| `admission_only` | Not managed-executed, but routed through the shared provider admission boundary, so the concurrency cap and slot accounting still apply. |
| `adapter_only` | A low-level adapter module whose caller owns admission; the adapter itself makes no gate claim. |
| `readiness_probe` | A non-provider-workload inspection or verification subprocess, including readiness/version, Git/process, provenance, evidence, or lint checks. Never becomes review evidence. |
| `legacy_unmanaged` | A provider spawn that is neither managed nor admission-routed. **Reserved, and currently empty by contract.** |

`admission_managed` is not a status value: admission and managed execution are
two separate properties, expressed by `admission_only` (admission without
managed execution) and `managed` (both).

The `legacy_unmanaged` bucket exists so an unmanaged spawn path must be declared
rather than pass silently. It is asserted empty — `provider-execution-inventory-contract.ts`
requires that no surface carries it — so adding one is a deliberate, reviewable
act that fails the contract until justified. It is not a claim that unmanaged
execution is impossible, only that none is currently admitted.

## Formal managed reviewer evidence

Native-host reviewers retain the existing signed ReviewRun plus direct
ReviewPass/Finding flow. A cross-provider CLI reviewer uses a two-phase flow:

1. The controller creates the signed ReviewRun.
2. `host_run --managedReview` derives the exact assembled prompt and seals
   story, provider, lane, ReviewRun, head, material, story-files and prompt
   bindings. Before the immutable run spec is created, formal Codex/Claude
   managed review and required-reviewer dispatch resolve omitted selectors to Codex
   `gpt-5.6-sol/high` or Claude `opus/high`. Explicit selections must remain
   in the GPT or Opus reviewer family at `high` or greater effort. This keeps
   a reviewer from silently inheriting the implementation agent's model. Grok
   remains governed by its separate managed-review-only adapter contract and
   rejects caller-supplied model or effort selectors.
   Qualification happens only at submission, before immutable spec creation;
   import verifies exact sealed selector equality rather than re-deriving the
   qualification policy. If a named default is unavailable, the operator starts
   a fresh run and key with an explicitly available qualified selector. Existing
   selector-less historical specs retain their exact compatibility semantics.
   The advisory-only `cross_host_review` profile remains outside this formal
   evidence boundary and retains provider-owned model selection.
3. The managed prompt requires the provider's final assistant result to be one
   bounded `lattice.managed_review_final_proposal.v1` JSON envelope with
   pass-or-findings and truthful read evidence. It cannot write final
   `review_pass_set`/`finding_add` evidence from inside the managed run. This
   protocol overrides the generic reviewer role
   template's direct pass/finding closing instructions: the provider returns the
   envelope only, and the managed adapter is the sole proposal writer.
   The protected managed Codex launcher uses `codex exec --json -s read-only
   -C <scratch> -`, so after a successful provider exit its formal path accepts
   exactly one schema-valid terminal `item.completed` `agent_message` envelope.
   The exact standalone raw stdout envelope remains a bounded compatibility
   path for a non-JSON Codex transport; Claude accepts only successful terminal
   provider-validated `structured_output` (`type=result`, `subtype=success`,
   field present). Claude non-success result events, success events without
   `structured_output`, and `event.result` are ignored. Claude's signed
   managed-review launch supplies a bounded non-secret `--json-schema` bound
   to the exact story/provider/lane/ReviewRun tuple. Tool logs, ordinary or
   mixed raw stdout, Claude prose or fenced JSON, and controller fields are
   never proposal inputs. The worker
   validates the same tuple and atomically writes the immutable proposal.
   Missing, malformed, multiple or oversized final envelopes fail the managed
   run closed. The older descriptor-authorized
   `managed_review_proposal_set` callback remains compatibility-only.
4. Successful terminal creation seals spec, proposal, result, live-output and
   event-journal digests plus cleanup facts.
5. The controller calls `managed_review_evidence_import` with only the exact
   runId and receiptId. It cannot provide or alter verdict bytes. Import still
   fails closed unless the completed receipt proves `replacementSafe=true`,
   `processCleanup.reaped=true`, and
   `processCleanup.residualProcessGroup=false`.
6. The importer preserves provider reviewer/lane/ReviewRun/read provenance and
   writes the existing signed ReviewPass/Finding shape.
7. Import time and the REVIEW gate both call the shared Proof Admissibility
   registry/intake/evaluator and revalidate the current terminal, proposal,
   journal, prompt and material tuple.

Raw CLI output outside the trusted final-result adapter lane, usage-ledger rows, time-window correlations, pre-terminal
proposals, failed/cancelled/timed-out terminals and controller-authored verdicts
cannot upgrade to managed reviewer evidence. Raw same-UID CLI calls, forged
environment values, stale process groups, terminal/reaped runs and
ambiguous/multiple active candidates cannot borrow the descriptor authority.

The worker's reserved durable cancellation reason
`absolute_deadline_exceeded` always reconciles to a `timed_out` terminal with
that exact reason, even if the next observation occurs through the cancellation
branch. Human/operator cancellation remains `cancelled`; both paths retain the
same cleanup and replacement-safety proof.

The authority classifications remain disjoint. A native-host reviewer keeps the
signed ReviewRun plus direct ReviewPass/Finding path only when a registered
host-adapter broker signs the exact closeout invocation. Its Ed25519 attestation
binds Story, agent/lane, ReviewRun, writer session, signed dispatch,
adapter/host identity and a one-shot nonce. Proof-or-Stop stores the registered public
key and nonce-consumption record, but exposes no issuer command and stores no
broker private key. `dispatch`, `review_run_start`, inherited environment values
and raw provider CLIs cannot mint this authority. The host adapter must inject
the signed attestation over a dedicated descriptor for the exact CLI process;
without that integration, native direct evidence is advisory-only and formal
review must use the managed path.

Process ancestry is secondary evidence. An unobservable process table, as in a
brokered desktop sandbox, does not negate a valid broker signature. When a full
ancestry is observable, any mixed distinct provider families (Claude→Codex or
Codex→Claude) veto direct evidence even if the nearest ancestor matches. The
one-shot local nonce ledger prevents replay but is not represented as protection
against a same-UID/root attacker capable of replacing trusted configuration or
instrumenting the broker.

A cross-provider CLI reviewer requires a managed terminal receipt;
cross-provider CLI output without that receipt is advisory-only. An explicit
`degraded-single-host` fallback is local DONE assurance through host-verdict
evidence, not direct or managed REVIEW evidence, and cannot borrow either
reviewer authority path.

## Operator guidance

`proof-or-stop dispatch` prints two explicit execution modes. A native subagent uses
its host lifecycle. A cross-provider CLI reviewer must use `host_run
--managedReview`; raw `bash + codex/claude/agy` is advisory-only and cannot
satisfy the managed evidence path.

Poll the same run with `host_run_status --waitMs 30000`. Continue observing the
same run across silent intervals. Cancel only on an explicit operator decision.
Start a replacement only after an authoritative terminal and only when its
cleanup proves replacement safety.

## Retention and trust boundary

`proof-or-stop doctor` reports worker liveness, provider-progress observability,
deadline/cancel state, residuals, replacement safety and retention. Explicit
`doctor --repair` garbage-collects heavy terminal run directories only beyond
90 days and first revalidates sealed spec, result, event-journal, proposal and
evidence-binding digests, then archives the sealed receipt, evidence-binding
digest, binding projection, provider-authored proposal body, and import-seal
pair (evidence-binding.json + evidence-binding.seal.json) under
`.proof-or-stop/runtime/host-run-receipts/`. On recover, the proposal body is
re-digested against the sealed receipt's evidenceProposalDigest, the binding
body is re-digested against the archive's evidenceBindingDigest, and the
archived seal's schemaVersion, runId, and bindingDigest are checked the same
way as the live path. Heavy live-output and result provider text are not
retained. Pre-F-127 archives that lack the later capture fields refuse closed
rather than reconstructing missing bodies. Any mismatch is reported as corrupt
and retained for manual review. GC does not treat a receiptId match as
sufficient: an incomplete leftover is atomically replaced from still-valid
live artifacts, and if neither the existing archive nor the live runtime can
form a complete capture, the live directory is retained. The import-time evidence-binding seal is
checked before GC, and an expired cross-host run removes only its canonical
temporary detached snapshot. Active or corrupt runs and
runs that still contain one-shot inputs are retained fail-closed. Failed startup
removes one-shot secrets immediately.

The local filesystem boundary does not defend against a same-UID or root
attacker. Retained output may contain sensitive provider text and must be
treated accordingly.

## Compatibility and non-goals

- Existing finite provider timeouts, cross-host policy ceilings, bounded retry
  and fail-closed classifications remain in force.
- Ordinary non-review host runs remain compatible but now gain durable
  ownership and shared admission.
- No remote scheduler, daemon, queue or native-host subagent abstraction is
  introduced.
- Usage diagnostics remain non-authoritative and never become lifecycle proof.
