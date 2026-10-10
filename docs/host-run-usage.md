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

An owner waiting for one worker uses the text form instead:

```bash
proof-or-stop host_run_status --runId=<runId> --untilTerminal=true
```

Its first line (stderr) is the wait instruction: it blocks up to 285 s per call
(`OWNER_WAIT_BLOCK_MS`, core/owner-wait-guidance.ts), so give it one tool
yield/shell timeout of 300000 ms (Codex: `write_stdin yield_time_ms=300000`) and
re-run it only if it returns non-terminal. On Codex the first `exec_command`
always returns after 30 s while the call still runs, whatever its
`yield_time_ms` (Codex 0.154; v4.1 cost plan N5: 34 of 34 long owner calls in
old-PoS runs 22-24): the one `write_stdin` poll with the long yield is expected,
not a sign of a short yield. A host that raises Codex's
`background_terminal_max_timeout` may raise the block with
`PROOF_OR_STOP_OWNER_WAIT_BLOCK_MS` (30000-585000 ms; the instruction then names
a yield of block + 15 s), so one exec+poll pair covers more of the wait. Text output without `waitMs` or
`afterGeneration` defaults to this until-terminal wait; `waitMs=0` is a snapshot.
The text result is a compact summary of at most ~300 tokens. A terminal summary
starts with a plain verdict line, `OK: ...` or `FAILED: ...`. After that come the
run line (state, stage, generation, terminal reason, exit, and failureKind only
when the run did not complete), the binding (Story, phase, agentType, host,
model, effort, profile, lane, reviewRunId, itemId/findingId), progress fields
while running, and the output. For a reviewer the output is the verdict and
finding count by severity from the sealed evidence proposal or the provider
final result. For a code writer (implementer, finding repair) it is the sealed
item or finding and the material commit the run left in its window (`output:
sealed item CHK-005 commit 39c8303`); these roles never send a provider final
result (review JSON). Their last assistant message is read by `next` only for
the mandatory `[intent-conflict]` section (old-PoS run 23; docs/CLI.md "The
request outranks intents"): a declared conflict blocks the item until the owner
amends the intent in PLAN. Under the A/B switch `implementation.probeMatrix=on`
(default off since old-PoS run 33: one line instead) the implementer prompt also
carries the probe matrix (old-PoS runs 24-30) and asks for a `[probes]` line in that message (the implementer agent template itself asks for no `[probes]` line since old-PoS run 34); `next`
parses its `probed-only:` rows: a done item whose latest completed implementer
run left decided rows untested gets `probe_tests_missing` (reopen, relaunch
with the rows; old-PoS run 30). Old-PoS run 31 (core/request-probes.ts): the
prompt also pairs the item's example rows with the request sentence that defines
each and asks for `[probe-row] <row> | request: ... | observed: ... |
ok|contradiction` lines; an unresolved contradiction gets `probe_request_mismatch`
(reopen; with `dev.probeEnforcement=enforce`). With a project `probeRunner`,
`checklist_update status=done` inside the implementer run first runs the rows on
the Story base and HEAD (base build once, then a build per HEAD material); under
`dev.probeEnforcement=enforce` it refuses once per set of flagged rows, under the
default `advisory` (old-PoS run 33) it only prints them; the
prompt then carries a compact contract instead of the matrix. Old-PoS run 32:
every statement of a row runs in order (a row with a statement the extractor
cannot place is never run or flagged). Old-PoS runs 35-39: a prose connector
(`returns`, `evaluates to`, `outputs`, ...) after a code input and before a
concrete value is a case too, and the contract and the done note state `N rows
not extractable (not run: ...)` instead of a bare 0 example rows; and an item reopened because its added
tests compare a request-quoted exact string only by prefix / contains applied to
that expected text (`exact_text_prefix_assertion`) gets each row (`file:line`),
test and comparison in its relaunch prompt; since old-PoS run 40 that reopen and
the relaunch are framework steps (`next --run` runs both; the relaunch is a
framework launch once per flag when the selection is bound). The summary ends with receiptId, replacementSafe, any supervision
diagnostic, the next action and the full-record directory. A completed run never
shows a failureKind (old-PoS run 15: a stale `failureKind=auth` next to a
completed implementer made the owner relaunch it). A run that ended with
`managed_dispatch_target_already_done` reads `OK: nothing to do` and names the
earlier run, and its next action is `proof-or-stop next`. A non-terminal summary
repeats the wait instruction first.

**Provider failure classification.** `failureKind` (`auth`, `interactive`, ...)
is a diagnosis for a run that failed. It is never the verdict. Stdout of a
JSON-mode provider (Codex `exec --json`, Claude `stream-json`) carries items,
tool output and usage counters, so the runner classifies stdout one complete
line at a time. Plain-text lines and provider error events are classified: a
Codex `error` or `turn.failed` event, a Claude `is_error` result, or a top-level
`error` on a non-item event. Every other JSON line (`item.*`, `turn.completed`
usage) is ignored. Stderr is classified as before. Patterns are word-bounded:
`401` counts only after `http`/`status`/`code`, or as `401 Unauthorized`.
`authentication` counts only as `authentication failed/required/error`, and
`interactive` only as `interactive terminal/session/input required`. A bare
`401` used to match the counter `"cached_input_tokens":7401088`, and a bare
`interactive` matched "non-interactive". A provider exit 0 that the worker
accepts as completed always has `failureKind=none`. The completed terminal
projection normalizes legacy sealed results the same way. This also keeps a
false `auth` from revoking a managed execution-batch admission. The full record (projection, receipt and retained live
output, often 25k-75k tokens for a real reviewer) is returned only with
`--json=true` or `--full=true`; write it to a file rather than printing it into
an agent's context.

Run diagnostics (old-PoS run 27, `core/managed-run-diagnostics.ts`; diagnostic
only, never gate evidence): every managed run appends to
`<run dir>/diagnostics.jsonl` one `command` row per provider shell command (the
wall time between the Codex `item.started` and `item.completed` events of a
`command_execution` item as the worker observed them, commands in flight in the
session, live managed runs of the project) and one `load` row at each provider
spawn and every 15 s (`PROOF_OR_STOP_HOST_LOAD_SAMPLE_MS`): `os.loadavg`, CPU
count, free memory, live managed runs, and where readable: the container's
cgroup v2 PSI (`/sys/fs/cgroup/{cpu,io,memory}.pressure`: some avg10, some and
full total usec; else the host `/proc/pressure/*`, `pressureSource` says which,
`hostCpuPressureSome10` keeps the host CPU value), the full cgroup `cpu.stat`
(`nr_periods`, `nr_throttled`, `throttled_usec`, `usage_usec`), the cgroup CPU
quota in CPUs (`cpu.max`) and the `/proc/stat` iowait and total CPU ticks (an
IO-wait signal where PSI is disabled). The file is capped at 512 KB.
`--full=true` / `--json=true` add a `diagnostics` summary: command count,
mean/median/p90/max wall, median wall by live runs, the five slowest commands,
load1 mean/max, max live runs, max CPU pressure, the cgroup throttled-time
delta, and rates over the run: throttled seconds per wall second, throttled
share of CFS periods, mean CPUs used, CPU/IO/memory PSI stall shares and the
iowait share. Run 27 motivated it: lane `cat`/`sed` calls took ~5.7 s with 4
lanes live and the cause could not be isolated afterwards. Runs 28/29
(`run28-29-analysis.md` §1) isolated it: synchronized lane bursts were
CFS-throttled by the 2-CPU container quota (>= 1 s throttled per wall second;
light lane commands 4.46 s mean launched at once, 0.20 s staggered), not host
load. `review.laneLaunchStaggerMs` (integer 0..60000) therefore defaults to
8000: `next --run` starts one round's lane launches 8 s apart (about 8-10 s per
extra lane); `0` launches them all at once (the rollback). Old-PoS run 34: the
lanes are launched historically slowest first (docs, test-coverage, concept,
quality, then any other lane; `core/review-lane-launch-order.ts`, also the order
`review_round_prepare` starts the ReviewRuns in), so the stagger delays the
fastest lanes, and a lane that finished is imported while the others still run
(the import waited for the slowest lane: 15 + 8 + 7 s per round on the critical
path).

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

With `untilTerminal: true` an aggregate wait returns only once ANY target is
terminal (or its wait expires; `waitMs` then up to 600 s, default 285 s), and
progress does not end it. `next` waits on one round's running lanes this way
(old-PoS run 34) and imports each lane as it ends:

```bash
proof-or-stop host_run_status '{"targets":[{"runId":"<lane-a>"},{"runId":"<lane-b>"}],"untilTerminal":true}'
```

Without `untilTerminal`, `waitMs` is capped at 30 seconds. A bounded return means “wake the caller and
inspect the current snapshot”, not “the provider failed”. Completion is known
only from `state=completed|failed|cancelled|timed_out` plus the terminal
receipt. A status observer never treats provider-output silence or a stale
output timestamp as terminal or as restart authorization; only the worker's own
stall rule below does, and it publishes an ordinary terminal receipt. The
absolute deadline is enforced by the worker and autonomous supervisor, which
publish terminal truth and record whether process cleanup made replacement safe.

**Provider stall.** A managed provider that writes no stdout for the stall
window (`MANAGED_PROVIDER_STALL_RUNTIME_POLICY`, default 300 s, counted from
spawn and reset by every stdout chunk; stderr does not count) has its process
group terminated (TERM, then KILL) and the run fails
`provider_stalled:no provider stdout for <N> s after <last event> (stall window
<W> s)`, never success and never a deadline timeout (old-PoS run 20: Codex printed
`thread.started` and then nothing for 30 min, and the run burned its whole
deadline). The window is sealed into the spec at submit from
`PROOF_OR_STOP_MANAGED_PROVIDER_STALL_MS` (milliseconds; `0` turns detection
off). 300 s is about 3x the largest gap measured on 388 managed Codex runs
(21,545 stdout gaps, reasoning turns and tool commands included: p50 1.2 s,
p99 22.7 s, p99.9 43.2 s, max 92.5 s); raise it for projects whose tool commands
run silent for minutes. The stalled run is `replacementSafe=true` only when the
group was reaped and the provider left no work product: its cwd HEAD, porcelain
status and tracked diff (outside `.proof-or-stop/runtime`) equal the
fingerprint taken before launch, and for a managed dispatch no role output was
delivered. Otherwise the reason adds `work product present, not auto-replaced`
and the run is `replacementSafe=false`.
Status queries only observe that state; they never reconcile an overdue run,
refresh an owner lease, or authorize a replacement. Cancellation remains an
explicit control operation.

A detached launch starts the recovery supervisor first and spawns the provider
worker only after the supervisor reports ready
(`MANAGED_SUPERVISOR_RUNTIME_POLICY.readyTimeoutMs`, 30 s: before ready it loads
the CLI module graph, with the on-disk compile cache, and may wait on the run's
terminal authority lock, whose deadline is 30 s; the earlier 5 s timed out under
host load). If it never becomes ready the run fails
`worker_launch_failed:managed supervisor readiness timeout` (or `... exited
before readiness`). No worker was spawned, so when the supervisor child was
reaped this failure is `replacementSafe=true` (any other launcher error stays
`false`).

**Provider transport failure.** A provider that exits non-zero on a transport
error fails `provider_transport_error:<the provider's error line>`, never an
opaque `exit_nonzero` / `child_error`. The error line is the last Codex `error` /
`turn.failed` event naming one (stream disconnected, error sending request,
connection reset, ECONNRESET/EPIPE, broken pipe, socket hang up), observed live
on stdout (tool output never counts), else such a plain stderr line (including
host_run's own `review invocation descriptor delivery failed: EPIPE|ECONNRESET`).
Auth and other classified failures keep their own reason. Like a stall, it is
`replacementSafe=true` only when the provider left no work product; otherwise
the reason adds `work product present, not auto-replaced`.

The review invocation descriptor (fd 3) is written once at spawn; Codex closes it
when it exits, and Darwin reports that peer close as a late EPIPE/ECONNRESET on
the write side (old-PoS run 24: `host_run review invocation descriptor delivery
failed: ECONNRESET` after the critic's turn had completed, which killed the
exiting provider and turned a missing envelope into `child_error`). A peer close
after the provider reported its turn finished (Codex `turn.completed`, a
Claude/Grok `result`), or after one final candidate, is ignored: the provider's
own exit decides. Without either, the decision waits for the provider's close
(at most `HOST_RUN_DESCRIPTOR_PEER_CLOSE_GRACE_MS`, 2 s): a finished turn by
then is a normal exit; otherwise the run fails `child_error` with that delivery
message, and a provider still running after the grace is killed as before.

The auto-replaceable failures (`isAutoReplaceableManagedLaunchFailure`, all with
`replacementSafe=true`) are: supervisor-not-ready, a clean provider stall
(`provider_stalled:` with no work product), a provider transport failure with no
work product (`provider_transport_error:`), a managed review run that ended
without a valid final envelope after the bounded same-session format repair
(`managed_review_final_result_*`: a reviewer's only work product is that
proposal, which was never written), and a managed dispatch run whose save was
refused because its dispatch binding is stale (`managed_dispatch_binding_stale:`,
old-PoS run 27; no save-repair turn is attempted, see below), and, for the save reviewers (scope-plan,
delivery: their only work product is the saved artifact), a run that ended
`managed_dispatch_output_missing` or `managed_dispatch_save_refused:<class>:` (old-PoS run 33: a
deterministic refusal such as the phase gate, no save-repair turn) with no work product. `next` relaunches their target itself as a
bound framework step (`targetRelaunchIsFramework`): a review lane of a round,
the inventory critic of a wave (old-PoS run 24: the replacement critic was
handed to the owner), a checklist item's implementer, a finding repair, or the
scope-plan reviewer, or the TEST delivery reviewer (any delivery run of the
current TEST entry that failed with `replacementSafe=true`), at most
`MANAGED_AUTO_RELAUNCHES_PER_TARGET` (3) such failures per target. After that, or after any other failure (including a
deadline timeout, or a stall or transport failure that left work product), the
replacement is the agent's call.

An ordinary host run executes in the **resolved project root** (the `--root`
target — the same root the usage-ledger rows are attributed to), independent of
the caller's current working directory, so where the host actually runs can
never diverge from where the ledger says it ran. A formal `--managedReview` is
different: the runtime-artifact registry resolves the canonical **primary
worktree** as the durable runtime/audit root for the sealed run, output journal,
terminal receipt, receipt archive, and imported evidence. A linked Story
worktree may submit the run, but is not the durable runtime location and can be
removed at DONE. A fresh managed review creates two detached scratch worktrees
at the submitted HEAD: one sealed source and one disposable execution checkout.
The provider starts in the execution checkout, so ordinary test commands may
generate ignored or untracked products without touching the sealed source.
Tracked execution changes still invalidate the run, and neither scratch is a
substitute for the audit root. Both are retained until terminal cleanup is
proven replacement-safe.

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
For an ordinary managed run, omitting either selector preserves the provider
default and records `null`. Formal Codex/Claude `--managedReview` and
`--managedDispatch` runs never inherit the ambient implementation-agent model:
omitted selectors resolve to `gpt-5.6-sol` / `high` for Codex and
`opus` / `high` for Claude before submission. Explicit formal selections
must use a GPT-family Codex model or an Opus-family Claude model, with at least
`high` reasoning effort. These effective values are normalized before submission,
included in the idempotency input, sealed into the immutable spec and binding
projection, and copied into the result and terminal receipt. Qualification is
enforced before immutable spec creation; import does not re-run model-family or
effort qualification and instead verifies exact equality among the sealed spec,
projection, result, and receipt. Codex receives `--model` plus
`--config model_reasoning_effort=...`; Claude receives `--model` plus
`--effort`. Claude accepts `low`, `medium`, `high`, `xhigh`, or `max`.
These fields prove the exact selector placed on the protected provider argv;
they do not claim that a provider-side alias resolved to a particular hidden
model revision. Grok formal review uses its separately audited managed-review-only
adapter and preserves that adapter's provider-owned model selection; callers
must omit both selectors because explicit Grok model or effort values are refused.
`cross_host_review` is a separate advisory host-verdict profile rather than
sealed formal REVIEW evidence; its Codex leaf also retains provider-owned model
selection and is outside this qualification boundary.

The named defaults are controller policy, not a promise that every installed
provider CLI exposes those aliases. If a default alias is unavailable, inspect
the provider launch diagnostic and submit a fresh run with an explicitly
available qualified GPT or Opus model and supported effort of at least `high`.
Because resolved selectors are part of the idempotency input, a pre-upgrade
selector-less formal run cannot be retried through the current handler with its
old idempotency key: use a fresh key. Its already sealed historical spec remains
readable and importable under the existing exact receipt compatibility checks.

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

单个 DEV checklist implementer、INIT reviewer、PLAN 的必需 scope reviewer 和 TEST delivery reviewer
可使用独立的 `managedDispatch` 模式。它不接受调用方 prompt，
而是调用 canonical `dispatch` 取得完整 envelope，并把 Story、role、prompt
digest 与 provider process identity 封存在 managed run 中。controller 还会签发
一个只在 run deadline 前有效、绑定 Story、role、run ID 和随机 nonce 的一次性
调用凭证。真实 Codex 工具宿主可以为每条 CLI 命令创建独立 process group/session；
`init_check_set` 或 `scope_check_save` 因此以该签名凭证为权威并原子消费 nonce，而不是要求 CLI
进程仍属于外层 provider 的 PGID。旧 adapter 的同进程组路径只保留兼容性；
对应 gate 仍会验证完成态 receipt 和其中精确的 delivery run binding。篡改
Story/role/run、重放凭证或在 run 终态后调用均 fail closed。

同一个仍在运行的 managed run 可以重复保存自己的输出（re-seal）：`scope_check_save`
与 `delivery_check_set` 再次出示同一个已消费的凭证（同 run、同 nonce、同 role）时
会重新绑定到该 run，后一次保存覆盖前一次；其他 run、nonce 或 role 仍按重放拒绝。

v4.1 N8（`core/scope-plan-deferral.ts`）：PLAN 里启动的 managed scope-plan run 仍在跑、
裁决尚缺、且没有 pin audit 要做时（没有 intent 钉住 request.md 未原文引用的期望值，
request 也没有 same-semantics 句），Story 可以进入 DEV；有 pin audit 时 DEV 入口
仍要求已保存的裁决（`scopeVerdictDeferral` = held）；这个 run 在 DEV 里用自己的 managed invocation 保存裁决
（DEV 里只接受它；其 candidate 读绑定按 run 启动前最后一个 commit 的 material /
story-files hash 校验，不受 implementer 之后的提交影响）。DEV→REVIEW 要求该裁决存在、
签名与 delivery 有效且无 gap。
v4.1 N1：TEST 中 delivery reviewer 运行期间，`next` 先给出只写 Story 元数据的步骤
（finish decision / summary、review assurance），`done_prepare` 与 DONE 仍等待它。
old-PoS run 20（scope reviewer run 265cbed2）中，reviewer 的第一次 probe 保存消费了凭证，
真实保存因此被拒为 "already consumed"，reviewer 随后用
`env -u LATTICE_MANAGED_INIT_INVOCATION` 保存，写出了未绑定（`deliveryRunId: null`）的
scope-check，run 以 `managed_dispatch_output_missing` 结束并被冷启动重跑。现在：
scope reviewer 的保存若不带凭证、而该 Story/role 有在运行的 managed run，只能经该 run
的 process group 绑定，否则被拒绝（错误指名缺失的 `LATTICE_MANAGED_INIT_INVOCATION`，
并要求在 run 自己的 shell 环境里不 unset/override 它重试），绝不会写出未绑定的输出。
拒绝的错误文本不再建议"换一个新的 host_run"，也不会建议修改环境。每次被拒的保存都以
`managed_dispatch_save_refused`（含精确错误）记入该 run 的 `events.jsonl`。

DEV implementer 额外要求精确 `itemId`。该目标写入不可变 run binding；只有同一
managed run 内对该 item 的 `checklist_update status=done` 才能消费一次性凭证并写入
带 `managedDispatchRunId` 的成功 `subagent_result`。old-PoS run 34 起该完成调用可带
`commit: {files}`（`isManagedImplementerCompletionPayload` 只额外接受这一字段）：同一次调用先暂存这些
文件、`git diff --cached --check` 有空白错误时拒绝且不提交（`[item_done_diff_check]`）、以规范
implementer 作者提交，再执行原有的 done 检查；implementer prompt 内联 background.md、该 item 的
plan.md 段与 request.md，不再每个 item 重读。provider 退出 0、仅把 item 标成
`in_progress`、完成其他 item，或缺少绑定结果时都不会生成 completed terminal。
对已由 managed run 封存完成的 item 不会再派发 implementer（old-PoS run 15）。若 item 已为
done，且存在绑定到另一个 run 的成功 `subagent_result`，并且该 run 的 terminal 为 `completed`
且封存了输出摘要，那么 `dispatch` 和 `host_run --managedDispatch` 在生成 prompt、启动 provider
之前就拒绝，错误信息只给出一个下一步：
`managed_dispatch_target_already_done: CHK-005 is already done, completed by managed run <runId> (commit <sha>); do not relaunch it. Next: proof-or-stop next --storyId=<storyId>`。
done→done 的 `checklist_update` 不是完成迁移，不会绑定新的结果，所以重复派发只会失败。
由 owner 直接写入（没有 `managedDispatchRunId`）的 done 不受这条拒绝影响。若重复的 run 仍然启动了
（例如与第一个 run 竞争），worker 会以 `managed_dispatch_target_already_done` 结束，而不是
`managed_dispatch_output_missing`。这个结果不是失败：状态摘要显示 `OK: nothing to do`，
并给出先前的 run 与 commit，下一步是 `proof-or-stop next`，不会进入“relaunch 一次、再失败就停止”的路径。
implementer 与 finding-repair 的 prompt 指向 `request.md`，并要求最终消息以 `[intent-conflict]` 段结尾
（`none`，或每个冲突一行 `<intentRef> | request: "<原句>" | request implies: <值> | intent pins: <值>`）。
`next` 从 run 的 `live-output.jsonl` 读最后一条 assistant 消息解析该段（implementer 只在散文里写、且提到
intent/checklist/pin/request 的「deliberate choice」也算冲突）：未修订的冲突在 DEV 返回 `intent_conflict`（`story_advance --phase=PLAN`），
在 PLAN 返回 `intent_conflict_amend`（`checklist_update` 新 intent，冲突点名 userSees 时改 userSees，+ reason + `status: pending`；old-PoS run 37：pin 不是代码字面量时，同一步还列出任何 item 中写着同一错误 pin 片段的行，并对每个兄弟 item 给一条 `checklist_update {itemId, intentRows}` 行级修补）；item 的 verificationIntent 或 userSees 与派发时不同，或已写出 request 推出的值、不再含被钉住的字面量，冲突即解除（old-PoS run 31）。
finding-repair 的 prompt 还要求在 Story base（打印确切 SHA）与修复后运行该 finding 的输入及其字面变体，
request 没改的变体保持 base 行为（old-PoS run 24）。old-PoS run 44 起它还要求修整个缺陷族：grep finding 指向的代码路径（处理错的分支及所有到达它的调用者），
列出到达同一分支的每种 receiver、目标（lvalue / parent / container）与操作数形态（含嵌套与计算出的），逐个修复（或以显式错误拒绝）并各配一个测试；
最终报告每个检查过的形态一行 `[family] <shape>: fixed | rejected | unaffected (why)`（run 44 的四次修复各只修了被报告的形态，下一轮再找出下一种）。implementer 的 prompt（仅 A/B 开关 `implementation.probeMatrix=on` 时；old-PoS run 33 起默认 off，只留一行）带同样性质的探针矩阵
（操作数位置 × 值类 × 操作，在 Story base 与改动后各跑一次，old-PoS runs 24-29），最终消息报告 `[probes]` 行（含 `tested:` / `probed-only:`；`next` 解析 probed-only 行，done item 有未测的已决定行时返回 `probe_tests_missing`，old-PoS run 30）。old-PoS run 31：prompt 还把本 item 的例子行与定义它的 request 句子配对，要求 `[probe-row]` 行，未解决的 contradiction 返回 `probe_request_mismatch`；项目声明 `probeRunner` 时，implementer 运行中的 `checklist_update status=done` 先在 Story base 与 HEAD 上跑这些行，`dev.probeEnforcement=enforce` 时每组 flag 拒绝一次（old-PoS run 33 起默认 `advisory`：只打印，不拒绝、不 reopen），prompt 用紧凑契约代替矩阵。
普通 implementer 模式保留调用方明确选择的模型与 reasoning effort；它不冒充 reviewer，
也不套用独立 reviewer 的模型资格限制。

凭证通过环境变量传递，是为了兼容会把每条工具命令放入新 session/PGID 的
Codex host；这里的环境变量只是 transport，信任来自 controller 的 Ed25519
签名、精确 claims 校验和 nonce 原子消费。该边界依赖 managed reviewer 已有的
host/container 隔离来阻止无关的同 UID 或 root 进程读取其环境；环境变量本身
不提供针对同 UID/root 进程的保密性。若 host 能稳定把 capability descriptor
传入 reviewer 后续启动的每条工具命令，可改用 fd transport 而不改变签名协议。

provider 进程退出 0 本身不构成完成：worker 只有在配置的 Story store 中读到
与该 Story、role 和 managed run ID 精确绑定的 `init-check.json` reviewer 记录或
`scope-check.json` 记录，或与 Story、item、run 精确绑定的成功 implementer
`subagent_result` 后才写
`completed` terminal。记录不存在或不匹配时以
`managed_dispatch_output_missing` 失败（例外：implementer 的 item 已由另一个已封存的
managed run 完成时，以非致命的 `managed_dispatch_target_already_done` 结束，见下文）；配置路径中的记录无法读取或解析时以
`managed_dispatch_output_unreadable` 保留受限错误诊断并继续 fail closed；签名
或当前 Story 内容绑定失效时以 `managed_dispatch_output_invalid` 失败。
对 PLAN scope reviewer 与 TEST delivery reviewer（输出只是一条绑定到 run 的保存命令），
`managed_dispatch_output_missing` 之前先做同 session 修复：worker 以 `codex exec resume`
恢复该 run 自己的 Codex session（这两个 role 因此不带 `--ephemeral`），提示中给出
保存产物当前绑定到哪里、以及本次 launch 以来最后一次 `managed_dispatch_save_refused`
的精确错误，要求只用原有的最终 payload 重跑保存、不重新 review。最多
`MANAGED_DISPATCH_SAVE_REPAIR_MAX_ATTEMPTS`（2）次；每次记入
`managed_dispatch_save_repair` / `managed_dispatch_save_repair_outcome` 事件。session
不可恢复（非 Codex、provider 不可安全替换、rollout 不存在）或次数用尽时记入
`managed_dispatch_save_repair_unavailable` 并按原样以 `managed_dispatch_output_missing` 结束。
例外（old-PoS run 27）：若最后一次拒绝是确定性的 dispatch 绑定过期（拒绝事件带
`code: dispatch_binding_stale`，例如 delivery reviewer 的 dispatch 之后有非 delivery-neutral
的提交），重试必然再次被拒，因此不做同 session 修复：记入
`managed_dispatch_save_repair_unavailable`（`reason: deterministic_binding_refusal`），
run 以 `managed_dispatch_binding_stale: <拒绝原文>` 失败（保留 `replacementSafe`），
由 `next` 以新的 dispatch 自动重新启动该角色。同理（old-PoS run 33）：Story 的阶段不允许这次保存时
（CLI 的 active-Story phase gate，或 `scope_check_save` 的 DEV 规则；拒绝事件带 `code: phase_gate`）
不做同 session 修复，run 以 `managed_dispatch_save_refused:phase_gate: <拒绝原文>` 失败；该失败及无工作产物的
`managed_dispatch_output_missing` 对保存类 reviewer 都可自动替换，`next` 在保存所需的阶段自己重新启动（每个目标最多 3 次）。
失败 terminal 的投影把 provider exit 0 改写为 `exitCode: 1` / `terminalReason: child_error`；
run 20 记录的 "exit 1" 就是这个投影，provider 本身正常退出。
PLAN scope reviewer 的 completed terminal/receipt 还封存当时精确的
`scope-check.json` 摘要；完成后替换内容，即使保留 delivery run ID 并重算公开
内容哈希，也会在 receipt 校验与 `story_review` 中失败。

Linux Docker/OCI 中的 Codex reviewer 已位于外层容器隔离边界。PoS 检测到
`/.dockerenv` 或 `/run/.containerenv` 时为这个 managedDispatch 子进程关闭
不可用的嵌套 bwrap；未容器化 Linux 与 Darwin 不采用该旁路，仍使用 Codex
正常 sandbox。两条路径都保留既有 canonical Codex 非交互参数
`--skip-git-repo-check --ephemeral --ignore-rules`；容器检测只决定 sandbox mode。
例外：保留 session 的 role 去掉 `--ephemeral`——implementer / finding-repair
（容器路径，供下一个 item 恢复），以及 scope / delivery reviewer（两条路径，供上面的
同 session 保存修复用 `codex exec resume` 恢复）。

所有 managed Codex worker（managedDispatch 的 implementer / finding-repair / scope /
INIT / delivery reviewer，以及 managedReview 的 lane 与 inventory critic；新启动与
`exec resume` 都算）额外带 `--config skills.include_instructions=false`、
`--config features.multi_agent=false`、`--config features.multi_agent_v2=false`；
若 provider home 的 `config.toml` 指向的 `model_catalog_json` 里有模型声明
`multi_agent_version`（它会无视 feature 开关强制注入 multi-agent 块），再带
`--config model_catalog_json="<派生副本>"`：派生副本只把 `multi_agent_version` 置为
null，写在系统临时目录 `proof-or-stop-codex-worker-catalog/<内容哈希>.json`，源 catalog
不改（lab `owner-init-and-worker-prompt`，N7，`core/managed-worker-codex-config.ts`）。
这去掉了没有任何 managed role 使用的 skills 列表与 multi-agent 开发者文本和
`collaboration` 工具：在 Codex 0.154 + bench catalog 上实测每个请求从 36,647 B 降到
25,993 B（−10.7 KB，约 −2.7k token；保留 exec_command、write_stdin、apply_patch、
view_image、web_search、request_user_input）。普通 host_run 与 cross-host review 不变。

```bash
proof-or-stop host_run '{"host":"codex","model":"<configured-implementation-model>","reasoningEffort":"high","storyId":"B-xxxx","itemId":"CHK-001","agentType":"proof-or-stop-implementer","managedDispatch":true,"detach":true,"json":true}'
proof-or-stop host_run '{"host":"codex","model":"gpt-5.6-sol","reasoningEffort":"high","storyId":"B-xxxx","agentType":"proof-or-stop-review-story-init","managedDispatch":true,"detach":true,"json":true}'
proof-or-stop host_run '{"host":"codex","model":"gpt-5.6-sol","reasoningEffort":"high","storyId":"B-xxxx","agentType":"proof-or-stop-product-reviewer","managedDispatch":true,"detach":true,"json":true}'
proof-or-stop host_run '{"host":"codex","model":"gpt-5.6-sol","reasoningEffort":"high","storyId":"B-xxxx","agentType":"proof-or-stop-review-scope-plan","managedDispatch":true,"detach":true,"json":true}'
```

For a formal managed review, the provider must remain in its host-configured
disposable execution worktree. It must never `cd` to, execute commands in, or
write to the canonical Story worktree named by the signed ReviewRun. The controller
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

A second `review_run_start` for a target whose ReviewRun is still live (same round,
lane, purpose, inventory epoch and wave and material; no evidence yet; its managed run
not launched or still running) is refused with `[review_run_live]` and ONE Next,
`proof-or-stop next --storyId=<id> --run`, which launches or waits on that run (old-PoS
run 44: six hand starts for one critic, five orphaned). A run whose managed run ended
without evidence may be replaced as before.

```bash
# 1. Controller creates the signed ReviewRun.
proof-or-stop review_run_start '{"storyId":"B-xxxx","agent":"proof-or-stop-review-quality"}'

#    One-command owner path for every launchable lane of the round: runs the
#    reviewer_batch plan, candidate_spec_route --hosts=false when the route is
#    missing/stale (add --fullScanReason only when it reports escalation; a
#    project with no requirements corpus gets an automatic full scan), then
#    dispatch + review_run_start per lane; prints lane=reviewRunId (--json too).
#    With inventoryCritic=true it prepares the round's inventory critic instead,
#    in one process: review_inventory_begin when no OPEN epoch of the round
#    exists, then (when review_inventory_status reports
#    REVIEW_INVENTORY_CRITIC_INCOMPLETE) the critic dispatch unless already bound
#    and its review_run_start (v4.1 N2).
proof-or-stop review_round_prepare --storyId=B-xxxx

#    `next --run` launches every fully bound prepared lane concurrently (one
#    host_run process each, the same command as alone; v4.1 N2), as the
#    pos-review-batch-controller does.

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
The protected managed Codex launcher runs from the disposable same-HEAD
execution checkout inside the registered outer readonly-lane policy, so after a
successful provider exit its formal path accepts
exactly one schema-valid terminal `item.completed` `agent_message` envelope.
The exact standalone raw stdout envelope remains a bounded compatibility path
for a non-JSON Codex transport; Claude accepts only its terminal `result` lane.
Tool
logs, ordinary/raw mixed stdout, arbitrary streamed output, and controller
fields are ignored. The worker validates the sealed story/provider/lane/ReviewRun
tuple and atomically writes the immutable proposal. A malformed envelope, or a
final message that is not an envelope at all (old-PoS run 24: the critic
validated its proposal and then ended its turn with the prose "I'll now emit the
single required JSON object" and no JSON), is not a verdict: when the provider
session is resumable the same session is asked, at most twice, to re-emit only
the envelope, with the exact validation error (for the prose case
`managed_review_final_result_missing: final message must be the JSON
envelope`); the re-emission passes the identical strict parser. Multiple or
oversized envelopes, and an envelope still missing or malformed after the
bounded repair, fail the run closed
(`managed_review_final_result_invalid:...`). Such a run wrote no proposal, so it
is auto-replaceable (see below). The
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

The candidate route a managed reviewer is launched against
(`candidate-spec-set.json` `artifactDigest` and `corpusDigest`) is sealed in its
run spec as `reviewBinding.candidateRouting`. Those digests are controller-owned:
the worker writes the proposal's `readManifest.candidateSpecSetDigest` /
`corpusDigest` from the sealed values, not from the provider's copy, and journals
a difference as run event `read_manifest_routing_sealed` (provider and sealed
values), as it already does for the full-scan reason. A/B V3 R2A-r2 (de80753)
lost a round to a critic that read the right digest and wrote a mistyped one.
The import still compares the sealed launch digest with the current artifact, so
a route that changed after launch refuses
(`candidate routing evidence rejected: candidateSpecSetDigest does not match
current artifact`). Such a refusal, and any other import refusal of a receipt
that no retry can change, is recorded once as process event
`managed_review_import_refused`; `next` never proposes that import again and
relaunches the lane or critic instead (docs/CLI.md, `next` decision table).

Later-candidate (round 2+) code-review lanes start a fresh Codex thread by
default (`review.round2Lanes=fresh`, adopted from the detection A/B V3 arm: the
post-repair seed was found 4/4 against 3/4 with resumed lanes, and round-2 lane
input tokens fell 56% because a resumed lane re-sends its 400–500 KB earlier
context on every request). The re-review prompt says it is a fresh session and
focuses it on the earlier findings and the repair diff. `review.round2Lanes=resume`
in `proof-or-stop.config.json` is the rollback: the lane resumes its newest
earlier-candidate thread (`codex exec resume`) and is told to build on it.

Two EXPERIMENTAL A/B arms (v41 cost plan A3/A4, default off, docs/CLI.md
"Detection A/B variant switches") change what a managed lane and the inventory
critic receive, not how they launch. `review.lanePack=shared`: `host_run
--managedReview` inlines the round's REVIEW LANE PACK in the sealed prompt (Story
base, candidate and commits, changed files with sha256, candidate-spec route
summary, checklist intents with pins and recorded evidence, the bounded Story
diff), computed once per round into
`.proof-or-stop/runtime/review-lane-packs/<storyId>/`, and seals
`reviewBinding.lanePack` (arm, path, digest, bytes) in the run spec. The pack is
authoritative for those facts; lanes keep full tool access and the unchanged
read-evidence rules. `review.roundDelta=pack`: from the second candidate on the
pack also carries the delta since the previous round (repair commits and diff,
earlier findings with their resolutions), and the lane starts there but still
reviews the whole Story.

Finding repair is grouped by default (`remediation.grouping=single`, adopted from
the detection A/B V4 arm: remediation wall time −48% and tokens −70% per replay,
every finding still fixed on the final tree with its own commit, round-2
detection unchanged). In DEV, `next` proposes ONE managed finding-repair for all
open blocking findings of the round that have no bound repair yet:
`host_run '{"storyId":"B-xxxx","findingId":"B-xxxx:F-001","groupFindingIds":["B-xxxx:F-001","B-xxxx:F-002"],"agentType":"proof-or-stop-finding-repair","managedDispatch":true,"detach":true,"json":true}'`.
The run spec seals `managedDispatchTarget {findingId, groupFindingIds}`. The prompt
asks, per finding, for its own regression test and one commit whose message
names the finding id. A finding counts as repaired only by such a commit inside
the run's window; a finding the run left without one gets its own single-target
repair. When two or more open findings are repaired (old-PoS run 24: closure
after a grouped repair took four `next` → `finding_resolve` cycles, ~1.5 min and
~1M tokens), `next` proposes ONE `finding_resolve` (`finding_resolve_batch`):
`finding_resolve '{"storyId":"B-xxxx","resolutions":[{"findingId":"B-xxxx:F-001","resolution":"<commit + focused test>"},{"findingId":"B-xxxx:F-002","resolution":"<commit + focused test>"}]}'`.
Each entry keeps its own evidence: the handler re-checks that finding's own
repair (open, and `managedFindingRepairState` shows its own commit) and appends
`[repair commit <sha> of managed finding-repair run <runId>]` to its
resolution; a finding that fails is left open and reported (the call is refused
only when none passes). Since old-PoS run 34 (REM: the owner re-read findings,
diffs and tests for 7 turns / 1.4M only to write what the handler re-checks) the
resolutions are framework-authored (repair commit, run, "the pinned evidence
chain is fresh", the first line of the repair report) and the step is a
framework step `next --run` executes; a single repaired finding uses the same
`resolutions` form with one entry (same per-finding re-check). When a finding
would fail the cited-change check (`resolutionCitationRefusal`), the step stays
the owner's with placeholders. Duplicates (critic
`duplicate`, superseded-run restatement, or a later run's restatement of an
earlier finding: old-PoS run 29, `restatedEarlierFindingOf`, a finding from a
review run that started after the earlier finding was recorded and names its id
or restates its claim on a shared file) and advisory (low / suspected) findings
are not grouped; a duplicate closes only through the coverage run of its own case.

The repair prompt states the Story's allowed files (scope contract
`allowedModify` / `allowedTest` / `allowedCreate`) and that no other file may be
created or changed. When a managed writer run (finding repair, implementer)
ends, the worker classifies every path its commits and worktree changed since
the run started with the REVIEW scope gate's classifier; a blocking violation
gets ONE resumed turn of the same Codex session naming the paths and the
allowed lists (`managed_writer_scope_repair` / `_outcome` events), before the
run seals. A violation that survives it is left to the REVIEW scope gate (old-PoS
run 29 REM2: a grouped repair created a new test file outside the declared
files and the owner moved it by hand). Code writers keep their Codex session
(no `--ephemeral`) on the contained and the uncontained launch path alike.
`remediation.grouping=per-finding` in `proof-or-stop.config.json` is the
rollback: one repair run per finding, and `host_run` refuses `groupFindingIds`.

Finding-repair runs start a new Codex thread by default
(`remediation.thread=fresh`, adopted from old-PoS run 25: a fresh repair took
0.86M input / 2.4 min against 2.8–3.9M for a repair resumed on the Story
code-writer thread at 10–16M context). `host_run` appends the bounded repair
pack (below) to the prompt and the worker starts the run fresh, both decided
from the project config (like `review.round2Lanes`); nothing is sealed as an
A/B arm. `remediation.thread=resume` is the rollback: the repair resumes the
Story's newest code-writer thread with no pack. Malformed = fresh.

Implementer items resume the Story's newest code-writer Codex thread by default
(`implementation.thread=resume`). The EXPERIMENTAL A/B arm
`implementation.thread=fresh` (v41 cost plan A1: the resumed context grows to
143–180k tokens) starts a new Codex thread for every implementer item and every
finding repair (also under the `remediation.thread=resume` rollback). `host_run`
then seals
`managedDispatchTarget.abVariant.flags["implementation.thread"]="fresh"` and
appends a bounded ITEM PACK to the prompt (request.md, other items and Story
commits, findings with their evidence, Story diff stat plus the hunks of the
declared or cited files, and those files at HEAD; at most 38,912 bytes,
`core/implementer-item-pack.ts`). The worker reads only the sealed arm, so the
pack and the fresh launch always go together. Unset or malformed = resume for
items, and the item prompt and target are byte-identical to before.

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

For projects opting into `managedReviewIsolation`, fresh ordinary managed
reviews use the sealed-source plus disposable-execution pair described above.
Fresh `cross_host_review` Codex runs build a private readonly lane on their
existing detached snapshot and retain that controller's existing cleanup model.
Executable and supported credential-format preflight runs before creating that
snapshot. Resume attaches the original sealed run without rebuilding or changing
its recorded isolation facts. See [readonly lane support and limits](managed-review-readonly-lanes.md).
