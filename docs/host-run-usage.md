# Host-run usage capture (`host_run`) and the read-only usage sweep (`usage_sweep`)

Proofbound launches host CLIs (Codex, Claude, Antigravity/agy) for reviewer and
quorum work. `lattice host_run` is the single launcher **choke point** that runs
those hosts and writes LLM usage-ledger rows for every run, so host-side spend is
attributed instead of invisible. `lattice usage_sweep` is a strictly read-only
companion that retro-attributes host transcript stores for runs that never went
through the choke point.

## Why this exists

A 2026-07-10 token-burn audit found the usage ledger only ever saw a handful of
probe rows: host-side reviewer launches, quorum cross-host reviews, and long
desktop sessions all burned real tokens that the ledger never recorded. Every
lattice-initiated host run now flows through `host_run`, which records a
preflight estimate row and a provider-reported final row per run. Runs that
Proofbound cannot route through the choke point (interactive desktop sessions)
are covered after the fact by the read-only `usage_sweep`.

Usage rows are diagnostics only (`gateEvidence=false`). They never gate the
workflow, never satisfy REVIEW/TEST/DONE/Authority evidence, and never advance a
phase.

## `host_run`

```
lattice host_run --host <codex|claude|agy> --agentType <type> \
  [--storyId B-xxxx] [--phase DEV] \
  ( --prompt "<text>" | --promptFile <path> ) \
  [--reviewRunId B-xxxx:RR-001] [--lane <reviewer-lane>] \
  [--timeoutMs <ms>] [--agyPrintTimeout 30m] [--json]
```

The host subprocess executes in the **resolved project root** (the `--root`
target — the same root the usage-ledger rows are attributed to), independent of
the caller's current working directory, so where the host actually runs can
never diverge from where the ledger says it ran.

The host stdout streams through **live**: the default production runner is an
async `child_process.spawn`, and host output passes through to the parent as it
arrives (no buffering-until-exit, no `maxBuffer` truncation). A one-line usage
summary is written to stderr, for example:

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

In `--json` mode the full host transcript is delivered live on **stderr** so that
**stdout stays clean** for the one JSON result; the JSON `stdout` field therefore
carries only the bounded usage-parse tail, not the full transcript.

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
fires while a listener is attached.

Exactly one of `--prompt` / `--promptFile` is required. A host non-zero exit (or
a cap refusal) propagates as a non-zero process exit; in `--json` mode the
command never throws and `exitCode` is a field.

### Reviewer launch

```
lattice host_run --host codex --storyId B-xxxx --agentType reviewer \
  --reviewRunId B-xxxx:RR-001 --lane lattice-review-quality \
  --promptFile reviewer-prompt.txt
```

### Quorum host review (one call per host)

```
# Codex host
lattice host_run --host codex --storyId B-xxxx --agentType reviewer \
  --reviewRunId B-xxxx:RR-002 --lane lattice-review-quality \
  --promptFile quorum-prompt.txt

# Claude host
lattice host_run --host claude --storyId B-xxxx --agentType reviewer \
  --reviewRunId B-xxxx:RR-002 --lane lattice-review-quality \
  --promptFile quorum-prompt.txt

# Antigravity / agy host
lattice host_run --host agy --storyId B-xxxx --agentType reviewer \
  --reviewRunId B-xxxx:RR-002 --lane lattice-review-quality \
  --promptFile quorum-prompt.txt
```

## Binding conventions

Every usage row carries the attribution passed to `host_run`:

| Argument | Ledger field | Notes |
|---|---|---|
| `--storyId` | `storyId` | Canonical Story id. Omit for an adhoc run. |
| `--agentType` | `agentType` | e.g. `reviewer`, `autopilot-repair`, `host-readiness-probe`. Required. |
| `--phase` | `phase` | When omitted and `--storyId` is set, the phase resolves from the **configured story store** at call time (honoring a project's `storyDir`); an explicit `--phase` is used as-is and the store is never read. |
| `--reviewRunId` | `threadId` | e.g. `B-xxxx:RR-001`. Joins rows against `review-runs.json`. |
| `--lane` | `subagentId` | e.g. `lattice-review-quality`. |

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
- **agy** — recorded as `source=unavailable` with provider `antigravity` and an
  explicit `unavailableReason`. agy print mode exposes no usage surface
  (verified 2026-07-10), so no counts can be reported.

A parse miss (no `turn.completed` event, no `result` usage) records an
`unavailable` final with a reason rather than inventing counts.

The one-line usage summary reflects the **actual append outcome**, not merely
that the provider envelope parsed. When the ledger append itself fails (a corrupt
ledger, or a lock-wait timeout that skips the write), the summary reports a
skipped state (`recorded: none`, reason `ledger_append_failed(...)`) and the
stderr line reads `usage: ledger_append_failed(...)` — it never claims
`usage recorded` for a row that never landed. This applies to all three hosts;
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

## Caps (fail-closed, before spawn)

Both caps run at the choke point BEFORE a host is spawned, and every refusal is
recorded as a `decision.kind=blocked` ledger row (diagnostics-honest).

- **Per-dispatch hard budget** — reuses the existing `LATTICE_HARD_BUDGET_TOKENS`
  preflight guard per call. An over-budget preflight estimate refuses with
  `reasonCode hard_budget_exceeded` before spawning.
- **Host-run concurrency** — a slot registry under `.lattice/usage/host-run-slots/`
  holds **fixed numbered slots** `slot-0.json` .. `slot-(cap-1).json`, one per
  live run (pid + `startedAt` + an acquire-minted **ownership token**).
  Admission is **atomic**: each index is tried in order with an exclusive
  (`wx`) create, and winning an index *is* the admission — only `cap`
  contenders can ever hold the `cap` fixed names, so simultaneous starts
  cannot all slip past the cap (no check-then-acquire race). When every index
  under `LATTICE_HOST_RUN_MAX_CONCURRENT` (default **4**; unset / invalid /
  `<=0` falls back to the default; an explicit larger value is honored) is
  held, the run refuses fail-closed with a non-zero exit, prints the live-run
  list, and writes a blocked row with `reasonCode concurrency_cap_exceeded`.
  Slot reclaim is **ownership-aware** (mirroring the ledger-lock doctrine
  below): a slot with a recorded **dead pid** is reclaimed at any age; a slot
  whose metadata is **missing/corrupt** (the holder crashed between creating
  the file and its metadata landing) is reclaimed once its mtime exceeds the
  `LATTICE_HOST_RUN_SLOT_STALE_MS` orphan backstop (default **6h**); a slot
  with a **live** recorded pid is **never reclaimed by age** — a long host run
  keeps its admission and waiters refuse at cap. Reclaim re-verifies the
  occupant immediately before the unlink and then re-creates exclusively (a
  lost reclaim race just moves to the next index), so a crashed run never
  wedges the cap and a racing reclaimer can never delete a slot a new holder
  just re-acquired. Slot release on exit is best-effort and **token-guarded**:
  the file is unlinked only while it still carries the releasing run's own
  token, so a reclaimed-and-re-acquired slot survives the original holder's
  late release (the accepted residual is the same pid-reuse class documented
  for the ledger lock). Raising the cap mid-flight exposes more indexes;
  lowering it lets high-index live runs drain (they still count in the
  reported live list) while new admissions only try the lowered range.

Blocked rows are provider-honest: a refusal records the provider of the host
that was asked to run (`openai` for codex, `anthropic` for claude,
`antigravity` for agy), never a hard-coded default.

The autopilot claude repair launch (`lattice autopilot execute
--allowClaudeRepair`) passes the **same pre-spawn admission**: with the ledger
ON, an over-budget or over-cap repair is refused before the claude runner is
invoked (recording the same blocked row, provider `anthropic`) and holds a
concurrency slot for the duration of the run; with the ledger OFF the repair
stays byte-identical (no admission, no slots, no rows).

The `cross_host_review` codex review leaf passes the **same pre-spawn
admission** (provider `openai`): with the ledger ON, an over-budget or over-cap
review is refused before the codex runner is invoked (recording the same
blocked row) and instead surfaces a synthesized `blocked` host-B verdict, so the
joint decision is `blocked` rather than a fabricated pass/fail; with the ledger
OFF the leaf stays byte-identical.

Concurrent runs' ledger appends are serialized by a cross-process lock at the
writer choke point (an atomic `llm-usage.jsonl.lock/` directory with a bounded
wait), so parallel host runs can never interleave appends and break the ledger
hash chain — a writer that cannot acquire the lock in time skips its append
(an honest under-count) rather than corrupting the chain. Lock reclaim is
ownership-aware: the acquirer records `owner.json` (holder pid + a unique
release token) inside the lock dir, and a held lock is reclaimed only when
that pid is dead, or — for an ownerless/corrupt lock, i.e. the holder crashed
between creating the dir and recording ownership — when the dir mtime exceeds
the `LATTICE_USAGE_LEDGER_LOCK_STALE_MS` orphan backstop. A live holder is
never reclaimed no matter how long it holds the lock (slow filesystem, GC
pause, suspension); release removes the lock only while `owner.json` still
carries the releaser's own token.

There is **no queuing** in this story: over the cap means refuse, not wait.

Set `LATTICE_USAGE_LEDGER=0` to disable ledger writes entirely; the host run is
then byte-identical to a raw launch (no preflight, no final, no slot files).

## `usage_sweep` (read-only retro-attribution)

```
lattice usage_sweep --since 2026-07-01 [--json]
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
    (`LATTICE_REVIEWER_READONLY=1`) and on a retired root; without `--out`,
    `usage_sweep` stays read-only and runnable by any session.
  - The **same `--out` boundary governs the CLI activity / hook layer** (F-028):
    a plain (no-`--out`) `usage_sweep` is read-only there too, so it runs **no
    pre/post command hooks** and writes **no activity-log entry by default** (the
    `LATTICE_ACTIVITY_RECORD_READONLY=1` read-only heartbeat override documented
    in docs/CLI.md still applies); a non-empty `--out` is treated as a write and
    runs the hooks + records activity like any other mutating command.
  - The same boundary also governs the **codex process-event surface** (F-032):
    under `LATTICE_ACTIVITY_SOURCE=codex` cli-engine appends a `codex_cli` event
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
