# Durable managed host runs, reviewer receipts, and usage diagnostics

Proof-or-Stop launches Codex and Claude as managed cross-provider CLI processes.
`proof-or-stop host_run` submits those processes to a durable
`ManagedHostRun`: the detached worker, not the caller shell, owns the provider
until a terminal record exists. A caller may attach, time out, disconnect, or
return after 30 seconds without cancelling or replacing the provider run.

The same launch path records optional LLM usage diagnostics. Usage rows are not
the execution owner and disabling them does not disable shared provider-process
admission. `proof-or-stop usage_sweep` remains the read-only companion for sessions
that never used the managed boundary.

## Why this exists

A 2026-07-10 token-burn audit found the usage ledger only ever saw a handful of
probe rows: host-side reviewer launches, quorum cross-host reviews, and long
desktop sessions all burned real tokens that the ledger never recorded. Every
`host_run` receives a durable `runId`, an absolute deadline and an exclusive
terminal receipt. The runtime persists under the primary worktree at
`.proof-or-stop/runtime/host-runs/<runId>/`, so Story worktree cleanup cannot erase an
active run or its receipt; secrets and prompt bytes are 0600
one-shot inputs removed when the worker claims them. Interactive desktop and
native-subagent lifecycles remain outside this boundary and are covered only by
their host or by read-only retrospective diagnostics.

Usage rows are diagnostics only (`gateEvidence=false`). They never gate the
workflow, never satisfy REVIEW/TEST/DONE/Authority evidence, and never advance a
phase.

## `host_run`

```
proof-or-stop host_run --host <codex|claude> --agentType <type> \
  [--storyId B-xxxx] [--phase DEV] \
  ( --prompt "<text>" | --promptFile <path> ) \
  [--reviewRunId B-xxxx:RR-001] [--lane <reviewer-lane>] \
  [--timeoutMs <ms>] [--deadlineMs <ms>] [--detach] \
  [--json]
```

`--detach` returns after a bounded worker-claim handshake with
`runId/state/generation/deadlineAt`. Foreground mode submits the same durable
run and attaches to it; it does not own the provider child. Operators use:

```bash
proof-or-stop host_run_status '{"runId":"<runId>","afterGeneration":4,"afterSequence":12,"waitMs":30000,"json":true}'
proof-or-stop host_run_cancel '{"runId":"<runId>","reason":"operator cancelled"}'
```

To observe several runs in one call, supply `targets` instead of `runId`:

```bash
proof-or-stop host_run_status '{"targets":[{"runId":"<run-a>","afterGeneration":4},{"runId":"<run-b>","afterGeneration":2}],"waitMs":30000,"json":true}'
```

The result contains `changed` and ordered `runs`, including terminal receipts.
Pass each returned generation on the next call to acknowledge that snapshot,
including terminal delivery. Heartbeats and acknowledged terminals do not wake
either the single-run or aggregate wait; actual generation changes do. A first
observer without a cursor receives an already terminal run immediately. An unchanged timeout is an
observation result. Up to 32 distinct runs with the same immutable Story subject
(or all without a Story) can be observed together. The ordinary ownership gate
still applies to the immutable Story subject; status remains read-only. Aggregate
arguments cannot be combined with single-run cursors or output-frame selection.

`waitMs` is capped at 30 seconds. A bounded return means “wake the caller and
inspect the current snapshot”, not “the provider failed”. Completion is known
only from `state=completed|failed|cancelled|timed_out` plus the terminal
receipt. Provider-output silence and a stale output timestamp are diagnostics,
never terminal predicates and never automatic-restart authorization. The
absolute deadline is enforced by the worker and autonomous supervisor, which
publish terminal truth and record whether process cleanup made replacement safe.
Status queries only observe that state; they never reconcile an overdue run,
refresh an owner lease, or authorize a replacement. Cancellation remains an
explicit control operation.

An ordinary host run executes in the **resolved project root** (the `--root`
target — the same root the usage-ledger rows are attributed to), independent of
the caller's current working directory, so where the host actually runs can
never diverge from where the ledger says it ran. A formal `--managedReview` is
different: the runtime-artifact registry resolves the canonical **primary
worktree** as the durable runtime/audit root for the sealed run, output journal,
terminal receipt, receipt archive, and imported evidence. A linked Story
worktree may submit the run, but is not the durable runtime location and can be
removed at DONE. The provider executes only in a fresh detached scratch
worktree at the submitted HEAD. The scratch is read-only for Codex and is
retained until terminal cleanup is proven replacement-safe; it is never a
substitute for the audit root.

Provider output is durably journaled and projected to an attached foreground
caller as it arrives, up to the per-run 8 MiB retention ceiling. The foreground
projection is explicitly bounded: once the ceiling is reached, `--json` reports
`truncated=true` on the `lattice.host_run.v1` result and text mode writes
`truncated=true` to stderr; neither promises the omitted tail.
`host_run_status --json` exposes the same flag as `output.truncated`. Worker
heartbeat and `lastProviderProgressAt` are separate. Diagnostic heartbeat writes
do not advance `generation` or wake a status waiter; actual provider output,
state transitions and terminal receipts do:
the former proves only that the supervisor can update state; the latter moves
only when observable provider bytes arrive. `providerProgressMode=unobservable`
is reported honestly when progress cannot be observed. A one-line usage summary
is written to stderr, for example:

```
usage recorded: provider=openai input=10202 cacheRead=11008 output=85 (recordId llmuse_...)
```

Only a **bounded** amount of state is retained for usage parsing — the last
usage-bearing line (codex `turn.completed` / the claude `result` envelope),
capped at 1 MiB per line. A line over the cap is dropped (not retained), so a
flooding host can never exhaust memory or manufacture a count. Truncation
poisoning is tracked **relative to the retained usage candidate**: when a drop
happens **after** the retained usage line — or no usage line was ever
retained — the dropped line may have carried the real final numbers, so the
usage final records `unavailable` (reason `usage_line_retention_truncated`)
rather than a fabricated **or stale** value. A drop **followed by** a later
valid usage-bearing line does not poison the run: last-usage-wins makes the
later retained line the freshest usage information, so it is recorded honestly
(e.g. one huge non-usage output line early in the stream no longer discards a
perfectly good final usage event).

### Passthrough routing (text vs `--json`)

| Mode | Host stdout | Host stderr | Process stdout carries |
|---|---|---|---|
| text (default) | streamed live to **process.stdout** | streamed live to **process.stderr** | the live host stdout (the handler does not re-print it — no double-print) |
| `--json` | streamed live to **process.stderr** | streamed live to **process.stderr** | ONLY the single JSON result line (kept clean) |

In `--json` mode the bounded host transcript (at most 8 MiB per managed run) is
delivered live on **stderr** so that **stdout stays clean** for the one JSON
result. If the transcript exceeds that ceiling, the JSON result reports
`truncated=true` and does not promise the omitted tail; the JSON `stdout` field
carries only the bounded usage-parse tail, not an unbounded or complete
transcript.

If the live passthrough sink fails mid-run, delivery stops at the first failure
but the run, usage recording, and slot release still complete: text mode prints a
`host_run warning:` line to stderr and the `--json` result carries a non-null
`passthroughError` field. This holds for **both** failure shapes a closed
downstream pipe can take: a **synchronous** write throw, and — because Node
delivers pipe write failures like a real `EPIPE` as an **asynchronous `'error'`
event** on `process.stdout` / `process.stderr` rather than a throw — that async
stream error too. `host_run` attaches (and, in a `finally`, removes) its own
stdout/stderr `'error'` listeners for the duration of the run, so a real EPIPE is
contained into the same `passthroughError` state instead of crashing the process;
once a stream is known broken, the best-effort diagnostic writes to it are
skipped rather than risk a late unhandled `'error'`, and **every** live
passthrough chunk write *and* final diagnostic write is settle-aware:
outstanding writes are tracked with a shared pending counter (throughput is never
serialized) that the `finally` **drains before removing the listeners** — bounded
by a defensive ~2s cap so a pathologically wedged stream can never hang the
command — so a late EPIPE from the FINAL live stdout chunk of a text-mode run, or
from the FIRST stderr write of a quiet run (which never tripped the skip), still
fires while a listener is attached. If the drain cap wins, one shared guard stays
per physical stream until each pending write settles; its release is deferred
through the next event-loop turn because Node `Writable` can invoke the write
callback before emitting the same failed write's `EPIPE` event. This contains the real
callback-then-error ordering without retaining one listener per foreground run.

Exactly one of `--prompt` / `--promptFile` is required for ordinary managed
runs. Formal cross-provider reviewer mode is the exception: `--managedReview`
forbids both and derives the exact prompt from the signed ReviewRun. A host
non-zero exit (or a cap refusal) propagates as a non-zero process exit; in
`--json` mode `exitCode` is a field.

`host_run` also accepts optional `--model` and `--reasoningEffort` selectors.
For a formal managed review these values are normalized before submission,
included in the idempotency input, sealed into the immutable spec and binding
projection, copied into the result and terminal receipt, and checked again when
the proposal is imported as REVIEW evidence. Codex receives `--model` plus
`--config model_reasoning_effort=...`; Claude receives `--model` plus
`--effort`. Claude accepts `low`, `medium`, `high`, `xhigh`, or `max`.
Omitting either selector preserves the provider default and records `null`.
These fields prove the exact selector placed on the protected provider argv;
they do not claim that a provider-side alias resolved to a particular hidden
model revision.

### Reviewer launch

Native direct `review_pass_set` / reviewer `finding_add` is formal evidence only
when the exact tool invocation carries a short-lived Ed25519 attestation from a
registered host-adapter broker. The signed claims bind the Story, agent and
lane, ReviewRun, writer session, signed dispatch prompt/binding, adapter and host
identity, and an invocation nonce. Proof-or-Stop stores only the broker public-key
registration; it has no issuer command and does not keep the broker private key
in the repository or `.proof-or-stop` runtime state. The adapter injects the signed
attestation over a dedicated inherited descriptor for that exact proof-or-stop
CLI process. Inline environment tokens are not accepted.

An adapter integration must therefore do both parts: register its public key in
`nativeReviewInvocation.brokers`, then sign and descriptor-inject each exact
review closeout invocation from its authenticated host tool-execution seam. If
the current Codex/Claude host does not provide that broker integration, native
direct evidence fails closed and is advisory-only; use the managed reviewer flow
below for formal evidence. `dispatch` and `review_run_start` do not issue this
capability, and a raw provider CLI cannot promote a self-generated key into the
registered broker set.

`nativeReviewInvocation` is the containing object, and `nativeReviewInvocation.brokers`
is the array of broker registrations. Each registration has all four required fields:
`brokerId` (the unique trusted broker name), `adapterId` (the adapter identity the
attestation claims), `host` (exactly `"codex"` or `"claude"`), and `publicKey`
(the broker's Ed25519 public key).
For example:

```json
{
  "nativeReviewInvocation": {
    "brokers": [{
      "brokerId": "desktop-codex-review-broker",
      "adapterId": "desktop-codex-adapter-v1",
      "host": "codex",
      "publicKey": "<Ed25519 public key>"
    }]
  }
}
```

The attestation nonce is atomically consumed once to prevent replay. That local
ledger is replay protection, not a same-UID security boundary. Likewise process
ancestry is corroboration rather than required authority: an unavailable `ps`
view does not reject a valid broker attestation, but any observable mixed
Codex/Claude ancestry rejects direct evidence even when the nearest provider
matches. A same-UID/root attacker that can replace trusted configuration or
instrument the broker is outside this local assurance boundary.

Reviewer Prompt 不应由调用方手工拼接或假定某个 rollout mode。先由
`review_run_start` 按当前 Story、lane 和 `promptEnvelope.roles` 的逐角色 flag
选择可信正文与 full/incremental context，再让 `host_run --managedReview`
按 `reviewRunId` 重新取得并校验这份内容。当前可独立启用 `proof-or-stop-review-concept`、
`proof-or-stop-review-quality`、`proof-or-stop-review-test-coverage`、
`proof-or-stop-review-behavior`、`proof-or-stop-review-docs`；未启用角色保持
`legacy-full-context`，retired channel 不可进入该 rollout。

ReviewRun 摘要会记录 rollout mode、role-body/context/assembled digest、selection
reason 和预算判定。reviewer 如发现增量材料不足，必须通过既有 escalation
reason 请求 full context；feature flag 本身不会授予 incremental eligibility，
也不会改变 pass/finding 的签名与 freshness 门禁。在途 legacy pass 仍只按其
原始 ReviewRun/round/Envelope 解释，不能因后来切换 flag 被重新绑定。

For a formal managed review, the provider must remain in its host-configured
detached scratch worktree. It must never `cd` to, execute commands in, or write
to the canonical Story worktree named by the signed ReviewRun. The controller
evaluates the canonical read-only acceptance topology, pre-review, rollout
report, and rollout-policy projections before launch, then places only a
bounded path-free status snapshot in the provider-visible derived prompt. A
provider consumes that snapshot rather than invoking those Story CLI readers
from scratch; an `unavailable` entry is an honest limitation, not permission to
bypass the normal worktree cwd gate. This snapshot is provider context only: it
does not replace the signed report artifacts, their lifecycle gates, or their
canonical consumers. The original signed ReviewRun prompt stays unchanged as
audit context, and the exact derived provider-prompt digest is sealed in the
managed run before receipt import.

```bash
# 1. Controller creates the signed ReviewRun.
proof-or-stop review_run_start '{"storyId":"B-xxxx","agent":"proof-or-stop-review-quality"}'

# 2. Submit the exact provider reviewer; raw `bash + codex exec` is unmanaged.
proof-or-stop host_run '{"host":"codex","model":"gpt-5.6-terra","reasoningEffort":"high","storyId":"B-xxxx","agentType":"proof-or-stop-review-quality","reviewRunId":"B-xxxx:RR-001","lane":"proof-or-stop-review-quality","managedReview":true,"detach":true,"json":true}'

# 3. Repeat this bounded status call. Silence does not cause replacement.
proof-or-stop host_run_status '{"runId":"<runId>","afterGeneration":<generation>,"waitMs":30000,"json":true}'

# 4. Import only after completed + replacementSafe=true + reaped=true + residualProcessGroup=false.
proof-or-stop managed_review_evidence_import '{"runId":"<runId>","receiptId":"<receiptId>"}'
```

Inside the provider process, the managed prompt forbids `review_run_start`,
`review_pass_set` and `finding_add`. Its final assistant result must be exactly
one bounded `lattice.managed_review_final_proposal.v1` JSON envelope containing
pass-or-findings plus truthful read evidence. This protocol overrides the generic
reviewer role template's normal `review_pass_set` / `finding_add` closing rules.
The protected managed Codex launcher uses `codex exec --json -s read-only -C
<scratch> -`, so after a successful provider exit its formal path accepts
exactly one schema-valid terminal `item.completed` `agent_message` envelope.
The exact standalone raw stdout envelope remains a bounded compatibility path
for a non-JSON Codex transport; Claude accepts only its terminal `result` lane.
Tool
logs, ordinary/raw mixed stdout, arbitrary streamed output, and controller
fields are ignored. The worker validates the sealed story/provider/lane/ReviewRun
tuple and atomically writes the immutable proposal. Missing, malformed,
multiple, or oversized envelopes fail the run closed. The
`pass` form requires a trimmed note of at least 10 characters and no findings
(an empty findings array is equivalent to absence). The `findings` form
requires at least one fully valid finding and may carry a trimmed explanatory
note of at least 10 characters. Claude's provider-facing JSON schema keeps this
field type-only because that transport rejects `minLength`; the local sealed
envelope parser enforces the same trimmed minimum before persistence. Both the canonical final
envelope and the older compatibility proposal ingress accept that diagnostic
note, then discard it before the immutable evidence proposal is written, so it
can never become a formal finding or evidence field. Whitespace-only notes,
missing findings, malformed envelopes, and oversized provider final results
fail closed. The older
descriptor-authorized `managed_review_proposal_set` command remains a
compatibility path, not the formal happy path; its private signing key is never
placed in the prompt, argv, provider environment, or durable run artifact.
Raw same-UID CLI calls, copied environment variables, stale PGIDs,
terminal/reaped runs, and ambiguous/multiple run candidates fail closed.
Successful terminal creation seals the proposal and journal. That state alone
is not importable: the receipt must also prove `replacementSafe=true`,
`processCleanup.reaped=true`, and
`processCleanup.residualProcessGroup=false`. The importer accepts only
`runId + receiptId`, exposes no verdict override, and preserves the provider
lane/ReviewRun/provenance. Both import time and the REVIEW gate revalidate the
same shared Proof Admissibility contract. Raw CLI stdout,
usage rows and time-window correlations cannot satisfy this evidence class.

For a managed Claude reviewer, the worker materializes the authoritative prompt
as a mode-`0600` one-shot file below the provider's exact working directory at
`.proof-or-stop/runtime/host-run-prompts/`; Claude's workspace sandbox can therefore
read it without exposing prompt text in argv. Because a detached reviewer has no
interactive terminal on which to approve required inspection and proof-or-stop CLI
commands, only the signed `managed_reviewer` launch profile adds Claude's
`--permission-mode bypassPermissions`. That same profile supplies a bounded,
non-secret `--json-schema` which fixes the exact story/provider/lane/ReviewRun
tuple and proposal vocabulary. The schema is an unavoidable CLI argument, but
contains neither prompt/capability bytes nor a controller-authored conclusion.
The adapter consumes only a `type=result` event with `subtype=success` and a
present provider-validated `structured_output`. Every other Claude result
event is ignored, including error/non-success envelopes and success events
without `structured_output`. Ordinary prose, Markdown-fenced JSON, and
`event.result` are never proposal inputs. Ordinary Claude `host_run` keeps its
configured permission policy and has no JSON schema, while Codex keeps stdin
transport. The private leaf is named by the sealed managed `runId`; the normal
worker cleanup removes it when the provider settles, and terminal
reconciliation/expiry repair repeats that exact run-bound removal after an
abnormal worker exit. It never scans or removes sibling reviewer prompt leaves.
Missing,
prose-only, malformed, multiple, or oversized proposal envelopes still fail
closed.

`host_run_worker` is an internal continuation command. It remains dispatchable
by the detached launcher but is omitted from ordinary help/catalog discovery;
operators use `host_run`, `host_run_status`, and `host_run_cancel`.

### Ordinary/quorum managed runs

```
# Codex host
proof-or-stop host_run --host codex --storyId B-xxxx --agentType quorum-reviewer \
  --reviewRunId B-xxxx:RR-002 --lane proof-or-stop-review-quality \
  --promptFile quorum-prompt.txt

# Claude host
proof-or-stop host_run --host claude --storyId B-xxxx --agentType quorum-reviewer \
  --reviewRunId B-xxxx:RR-002 --lane proof-or-stop-review-quality \
  --promptFile quorum-prompt.txt
```

The current agy print CLI accepts prompt bytes only as a plaintext argv value.
It is therefore not a managed `host_run` host and is absent from that command's
public schema. Antigravity/agy remains available only on diagnostic host-runtime
surfaces; a future managed adapter would require stdin or protected prompt-file
transport before it could be added as a new execution capability.

## Binding conventions

Every usage row carries the attribution passed to `host_run`:

| Argument | Ledger field | Notes |
|---|---|---|
| `--storyId` | `storyId` | Canonical Story id. Omit for an adhoc run. |
| `--agentType` | `agentType` | e.g. `reviewer`, `autopilot-repair`, `host-readiness-probe`. Required. |
| `--phase` | `phase` | When omitted and `--storyId` is set, the phase resolves from the **configured story store** at call time (honoring a project's `storyDir`); an explicit `--phase` is used as-is and the store is never read. |
| `--reviewRunId` | `threadId` | e.g. `B-xxxx:RR-001`. Joins rows against `review-runs.json`. |
| `--lane` | `subagentId` | e.g. `proof-or-stop-review-quality`. |

`--reviewRunId` must start with `<storyId>:` when `--storyId` is given, so a
ledger row can never silently mis-join across stories — a mismatch is refused
before any host is spawned. Omitting `--reviewRunId` / `--lane` leaves
`threadId` / `subagentId` null (no empty-string pollution).

When `--storyId` is given **without** `--phase`, the phase is resolved through the
configured story store; a story unknown to that store is refused pre-spawn. When
`--phase` is supplied the store is never consulted, so `--phase` works with or
without `--storyId` even in a project whose story metadata lives under a
custom `storyDir`.

## Per-host usage semantics

Provider truth is preferred over estimates; an absence is recorded as an explicit
`source=unavailable`, never a fabricated zero.

- **codex** — parses the terminal `turn.completed` usage event from
  `codex exec --json` and maps it to `{ input: input_tokens - cached_input_tokens,
  cacheRead: cached_input_tokens, cacheCreation: null, output: output_tokens }`.
  The `input` field is the **uncached remainder** (codex `input_tokens` includes
  cached input); the original payload (including `reasoning_output_tokens`) is
  digested raw.
- **claude** — parses the stream-json `result` envelope usage via
  `parseClaudeCliOutput` (the four-field Anthropic usage plus the served model).

A parse miss (no `turn.completed` event, no `result` usage) records an
`unavailable` final with a reason rather than inventing counts.

同样的诚实口径适用于 reviewer A/B：缺少 exact per-role historical envelope、
reviewer output、adjudication bytes 或 provider receipt 时结果是
`INCONCLUSIVE`，不是“0 token”或已证明的节省。B-235e 的独立 replay campaign
因此不声称达到计划中的 50% incremental / 40% assembled 降幅。

The one-line usage summary reflects the **actual append outcome**, not merely
that the provider envelope parsed. When the ledger append itself fails (a corrupt
ledger, or a lock-wait timeout that skips the write), the summary reports a
skipped state (`recorded: none`, reason `ledger_append_failed(...)`) and the
stderr line reads `usage: ledger_append_failed(...)` — it never claims
`usage recorded` for a row that never landed. This applies to both managed hosts;
the provider is still surfaced for attribution, but token counts stay null. A
provider record that BUILT fine but whose append failed is reported as an
append failure keyed on the parsed usage — it is **never degraded to
`source=unavailable`** (which would falsely read as "the provider reported
nothing"), and no second `unavailable` final is attempted for it.

The same honesty gate covers the **blocked rows**: a cap refusal claims
`recorded: blocked` (and, for a concurrency refusal, surfaces the blocked row's
`recordId`) only when the blocked row **actually appended**. When that append is
swallowed too, the refusal itself is unchanged — still fail-closed, no spawn,
non-zero exit — but the summary reports `recorded: none` with `recordId: null`
and a composed reason that keeps the refusal visible, e.g.
`hard_budget_exceeded (...); ledger_append_failed(...)` or
`concurrency_cap_exceeded (...); ledger_append_failed(...)`. A recordId is never
minted for a blocked row that never persisted.

## Provider execution surfaces

Every production provider spawn site carries a `ProviderExecutionSurfaceStatus`
and is enumerated by `provider-execution-inventory-contract`, which fails if a
new spawn path appears unclassified:

- `managed` — runs through ManagedHostRun (durable run identity, supervised
  process group, absolute deadline, one terminal receipt).
- `admission_only` — not managed-executed, but still routed through the shared
  admission boundary, so the concurrency cap below applies.
- `adapter_only` — a low-level adapter whose caller owns admission.
- `readiness_probe` — a non-provider-workload inspection or verification
  subprocess (including readiness/version, Git/process, provenance, evidence,
  or lint checks); it never becomes review evidence.
- `legacy_unmanaged` — neither managed nor admission-routed. Reserved and
  **currently empty by contract**: the inventory test asserts no surface uses
  it, so introducing one is a deliberate, reviewable act.

There is no `admission_managed` status — admission and managed execution are
independent properties, spelled `admission_only` and `managed`.

See `docs/requirements/decisions/managed-cross-provider-cli-execution.md` for
the decision record.

## Caps (fail-closed, before spawn)

With the usage ledger enabled, both caps run at the choke point BEFORE a host
is spawned, and each refusal attempts to record a
`decision.kind=blocked` ledger row (diagnostics-honest; an append failure is
reported as `recorded: none`). With `PROOF_OR_STOP_USAGE_LEDGER=0`, budget enforcement
and every ledger row are disabled; the provider-process capacity admission
still runs before every spawn and refuses fail-closed without claiming a
blocked row was persisted.

- **Per-dispatch hard budget** — reuses the existing `PROOF_OR_STOP_HARD_BUDGET_TOKENS`
  preflight guard per call. An over-budget preflight estimate refuses with
  `reasonCode hard_budget_exceeded` before spawning.
- **Provider-process concurrency** — a shared slot registry under
  `.proof-or-stop/runtime/provider-process-slots/`
  holds **fixed numbered slots** `slot-0.json` .. `slot-(cap-1).json`, one per
  live run (pid + `startedAt` + an acquire-minted **ownership token**).
  Admission and reclaim are serialized by the ownership-checked provider
  registry lock, then the selected fixed slot is created with exclusive `wx`.
  The lock makes the live-count check, stale reclaim, cap-lowering check and
  create one cross-process transaction, so simultaneous starts and corrupt-slot
  replacement cannot slip past the cap. When every index
  under `PROOF_OR_STOP_HOST_RUN_MAX_CONCURRENT` (default **4**; unset / invalid /
  `<=0` falls back to the default; an explicit larger value is honored) is
  held, the run refuses fail-closed with a non-zero exit, prints the live-run
  list, and, when the ledger is enabled, writes a blocked row with `reasonCode
  concurrency_cap_exceeded`.
  Slot reclaim is **ownership-aware** (mirroring the ledger-lock doctrine
  below): a slot with a recorded **dead pid** is reclaimable at any age only
  after its isolated provider PGID is also confirmed absent; a dead supervisor
  whose provider group remains live still consumes capacity and is retained.
  A slot whose metadata is **missing/corrupt** (the holder crashed between
  creating the file and its metadata landing) is reclaimed once its mtime
  exceeds the `PROOF_OR_STOP_HOST_RUN_SLOT_STALE_MS` orphan backstop (default
  **6h**); a fresh non-reclaimable corrupt slot also consumes capacity (even at
  a high index after a cap is lowered), although it has no safe descriptor to
  render in the live-run list; a slot with a **live** recorded pid is **never
  reclaimed by age** — a long host run keeps its admission and waiters refuse
  at cap. Reclaim re-verifies the
  occupant immediately before the unlink under the same registry lock and then
  re-creates exclusively, so a crashed run never wedges the cap and a racing
  reclaimer cannot delete a slot a new holder just re-acquired. Slot release on
  exit is best-effort, registry-serialized and **token-guarded**:
  the file is unlinked only while it still carries the releasing run's own
  token, so a reclaimed-and-re-acquired slot survives the original holder's
  late release. Raising the cap mid-flight exposes more indexes; lowering it
  counts every non-reclaimable high-index slot and refuses new starts until the
  total occupied count drops below the new cap.

Blocked rows are provider-honest: a refusal records the provider of the managed
host that was asked to run (`openai` for codex or `anthropic` for claude), never
a hard-coded default.

The autopilot Claude repair launch (`proof-or-stop autopilot execute
--allowClaudeRepair`) passes the **same pre-spawn admission** in both ledger
modes. With the ledger ON, budget and capacity refusals can also write the
diagnostic blocked row. With the ledger OFF there are no usage rows or budget
guard, but capacity admission remains mandatory and the slot is still released
after the run.

The `cross_host_review` Codex leaf runs through ManagedHostRun and the same
provider admission (provider `openai`). It supports detach/resume by exact
`managedRunId`, never spawns a replacement on resume, and binds the terminal
`receiptId` into host-B verdict provenance. Budget/cap/provider failures still
produce an honest blocked/error decision; raw stdout is never gate evidence.

Concurrent runs' ledger appends are serialized by a cross-process lock at the
writer choke point (an atomic `llm-usage.jsonl.lock/` directory with a bounded
wait), so parallel host runs can never interleave appends and break the ledger
hash chain — a writer that cannot acquire the lock in time skips its append
(an honest under-count) rather than corrupting the chain. Lock reclaim is
ownership-aware: the acquirer records `owner.json` (holder pid + a unique
release token) inside the lock dir, and a held lock is reclaimed only when
that pid is dead, or — for an ownerless/corrupt lock, i.e. the holder crashed
between creating the dir and recording ownership — when the dir mtime exceeds
the `PROOF_OR_STOP_USAGE_LEDGER_LOCK_STALE_MS` orphan backstop. A live holder is
never reclaimed no matter how long it holds the lock (slow filesystem, GC
pause, suspension); release removes the lock only while `owner.json` still
carries the releaser's own token.

There is **no queuing** in this story: over the cap means refuse, not wait.

Set `PROOF_OR_STOP_USAGE_LEDGER=0` to disable usage preflight/budget/final rows. It
does **not** disable ManagedHostRun ownership or provider-process admission.

## Diagnostics, cleanup, and trust boundary

Negative-PGID TERM/KILL is authorized only while the original isolated leader's
PID, PGID/session shape, and start fingerprint remain continuously verified.
Surviving descendants after that leader exits do not authorize a blind group
signal: cleanup records the residual group with `replacementSafe=false`, and
the receipt remains non-importable.

`proof-or-stop doctor --full` lists every managed run with state, worker liveness,
worker heartbeat, provider progress mode/time, deadline, cancellation,
residual-process status, `replacementSafe`, and retention state. `proof-or-stop
doctor --repair` removes heavy terminal run directories only after the 90-day
retention window and first revalidates sealed spec, result, event-journal,
proposal and evidence-binding digests, then archives the sealed receipt,
evidence-binding digest, binding projection, provider-authored proposal body,
and import-seal pair under `.proof-or-stop/runtime/host-run-receipts/`. On recover,
the proposal body is re-digested against the sealed receipt's
evidenceProposalDigest, the binding body is re-digested against the archive's
evidenceBindingDigest, and the archived seal's schemaVersion, runId, and
bindingDigest are checked the same way as the live path. A pre-existing
receipt archive is kept only when that complete capture is valid. An
incomplete crash leftover or pre-F-127 archive whose receiptId matches is
atomically replaced from still-valid live artifacts; if neither side can
form a complete archive, GC reports corrupt and retains the live runtime
instead of deleting it. Heavy live-output
and result provider text are not retained. Active or
corrupt runs and any directory still carrying one-shot inputs are retained
fail-closed for inspection; failed launch, claim, and pre-provider startup
(including scratch validation) paths erase prompt, capability, and one-shot
environment immediately. A terminal managed Claude run also
reclaims only its sealed `host-run-prompts/<runId>/` leaf, including from the
next status/cancel reconciliation after a worker crash. The imported binding carries a separate
immutable digest seal, so a shape-preserving binding rewrite is corrupt before
doctor/GC can delete it. Expired cross-host runs also remove only their canonical
`proof-or-stop-xhr-review-*/worktree` snapshot (the retired
`lattice-xhr-review-*/worktree` prefix remains cleanable for leftovers from an
older build); paths outside that tmp boundary fail closed. Per-run live output is capped at 8 MiB;
status readers page bounded frames and surface truncation rather than loading an
unbounded transcript.

The runtime directory is local and mode 0700; sensitive one-shot files are 0600.
This protects against other users under ordinary filesystem permissions, not a
same-UID/root attacker. Operators must treat retained live output as locally
sensitive. Native Codex/Claude subagent APIs are deliberately out of scope:
ManagedHostRun owns only cross-provider CLI processes launched by Proof-or-Stop.

## `usage_sweep` (read-only retro-attribution)

```
proof-or-stop usage_sweep --since 2026-07-01 [--json]
```

`usage_sweep` stream-reads `~/.codex/sessions/**/rollout-*.jsonl` and
`~/.claude/projects/*/*.jsonl` since a cutoff and reports per-session token
totals, originator (desktop vs exec vs claude-code), cwd, first/last timestamps,
and `B-xxxx` story mentions, plus a per-story rollup and grand totals. It exists
to make runs that never went through `host_run` (interactive desktop sessions in
particular) at least visible.

- The report header states **NON-AUTHORITATIVE ESTIMATE** prominently in both
  the human table and `--json`. The totals come from host transcript stores, not
  billing truth.
- It performs **no ledger backfill**: swept sessions are never written into the
  usage ledger.
- It is strictly **read-only**. The only write it can perform is an explicit
  `--out <path>` JSON report, and that write is create-only and fenced:
  - `--out` must be a **relative** path that resolves inside the project root;
    absolute paths and any `..` traversal escaping the root are refused
    outright.
  - It only ever **creates a new report file** — the file is opened with the
    exclusive-create `wx` flag, so an already-existing target is refused
    atomically and `usage_sweep` can never overwrite or truncate anything
    (not even via a symlink at the target path).
  - It refuses to write through **symlinked ancestor directories**, and the
    resolved real path must still fall inside the (realpath'd) project root,
    so an inside-root symlink cannot redirect the report outside the project.
  - Missing report directories are created only **after** all of those checks
    pass.
  - Because `--out` writes a file into the material tree, a **non-empty `--out`
    is dynamically classified `storyScopedMutating`** by the ownership gate
    (F-014), so it is refused in read-only reviewer mode
    (`PROOF_OR_STOP_REVIEWER_READONLY=1`) and on a retired root; without `--out`,
    `usage_sweep` stays read-only and runnable by any session.
  - The **same `--out` boundary governs the CLI activity / hook layer** (F-028):
    a plain (no-`--out`) `usage_sweep` is read-only there too, so it runs **no
    pre/post command hooks** and writes **no activity-log entry by default** (the
    `PROOF_OR_STOP_ACTIVITY_RECORD_READONLY=1` read-only heartbeat override documented
    in docs/CLI.md still applies); a non-empty `--out` is treated as a write and
    runs the hooks + records activity like any other mutating command.
  - The same boundary also governs the **codex process-event surface** (F-032):
    under `PROOF_OR_STOP_ACTIVITY_SOURCE=codex` cli-engine appends a `codex_cli` event
    to the active story's `process-events.jsonl` after a command. That append is
    STORY metadata, so it obeys the identical read-only contract — a plain
    (no-`--out`) `usage_sweep` appends **no process event** (even with an
    inferred active story), while a non-empty `--out` (a write) records the
    process event like any other mutating command. The owner-lease heartbeat is
    intentionally exempt: it is keyed on the ownership class (only a
    `storyScopedMutating`/`dangerousMutating` write touches the lease), never on
    this read-only classification, so read-only session upkeep is unaffected.

## Non-goals

- Usage rows **never gate the workflow** — they are `gateEvidence=false`
  diagnostics and are not consumed by any REVIEW/TEST/DONE/Authority gate.
- Interactive desktop host sessions are **out of reach** of the choke point;
  they are report-only via `usage_sweep`, never through `host_run`.
- `usage_sweep` never mutates story, ledger, or lifecycle state and never
  backfills the ledger.

For retry-safe ad hoc submissions, pass a stable `host_run --idempotencyKey`.
Formal managed reviews derive the logical identity from host, Story, review run
and lane automatically. Concurrent callers and restarted controllers receive
the same durable run; changed inputs for that identity are refused. A partial
submission reports its run ID for recovery, and an archived run reports its
terminal-receipt anchor. Neither condition authorizes another provider launch.

For projects opting into `managedReviewIsolation`, fresh `cross_host_review`
Codex runs also build a private readonly lane on the existing detached snapshot.
Executable and supported credential-format preflight runs before creating that
snapshot. Resume attaches the original sealed run without rebuilding or changing
its recorded isolation facts. See [readonly lane support and limits](managed-review-readonly-lanes.md).
