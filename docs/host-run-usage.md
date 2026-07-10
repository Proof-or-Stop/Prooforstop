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

The host stdout streams through live. On success the command returns the host
stdout and writes a one-line usage summary to stderr, for example:

```
usage recorded: provider=openai input=10202 cacheRead=11008 output=85 (recordId llmuse_...)
```

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
| `--phase` | `phase` | When omitted and `--storyId` is set, the phase resolves from the story index at call time. |
| `--reviewRunId` | `threadId` | e.g. `B-xxxx:RR-001`. Joins rows against `review-runs.json`. |
| `--lane` | `subagentId` | e.g. `lattice-review-quality`. |

`--reviewRunId` must start with `<storyId>:` when `--storyId` is given, so a
ledger row can never silently mis-join across stories — a mismatch is refused
before any host is spawned. Omitting `--reviewRunId` / `--lane` leaves
`threadId` / `subagentId` null (no empty-string pollution).

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

## Caps (fail-closed, before spawn)

Both caps run at the choke point BEFORE a host is spawned, and every refusal is
recorded as a `decision.kind=blocked` ledger row (diagnostics-honest).

- **Per-dispatch hard budget** — reuses the existing `LATTICE_HARD_BUDGET_TOKENS`
  preflight guard per call. An over-budget preflight estimate refuses with
  `reasonCode hard_budget_exceeded` before spawning.
- **Host-run concurrency** — a slot registry under `.lattice/usage/host-run-slots/`
  holds **fixed numbered slots** `slot-0.json` .. `slot-(cap-1).json`, one per
  live run (pid + `startedAt`). Admission is **atomic**: each index is tried in
  order with an exclusive (`wx`) create, and winning an index *is* the
  admission — only `cap` contenders can ever hold the `cap` fixed names, so
  simultaneous starts cannot all slip past the cap (no check-then-acquire
  race). When every index under `LATTICE_HOST_RUN_MAX_CONCURRENT` (default
  **4**; unset / invalid / `<=0` falls back to the default; an explicit larger
  value is honored) is held, the run refuses fail-closed with a non-zero exit,
  prints the live-run list, and writes a blocked row with
  `reasonCode concurrency_cap_exceeded`. Slots with a dead pid or an mtime
  older than `LATTICE_HOST_RUN_SLOT_STALE_MS` (default **6h**) are reclaimed
  in place (unlink + fresh exclusive create; a lost reclaim race just moves to
  the next index), so a crashed run never wedges the cap. Raising the cap
  mid-flight exposes more indexes; lowering it lets high-index live runs drain
  (they still count in the reported live list) while new admissions only try
  the lowered range. Slot release on exit is best-effort, with staleness as
  the backstop.

Blocked rows are provider-honest: a refusal records the provider of the host
that was asked to run (`openai` for codex, `anthropic` for claude,
`antigravity` for agy), never a hard-coded default.

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
  `--out <path>` JSON report, and `--out` refuses any path outside the project
  root.

## Non-goals

- Usage rows **never gate the workflow** — they are `gateEvidence=false`
  diagnostics and are not consumed by any REVIEW/TEST/DONE/Authority gate.
- Interactive desktop host sessions are **out of reach** of the choke point;
  they are report-only via `usage_sweep`, never through `host_run`.
- `usage_sweep` never mutates story, ledger, or lifecycle state and never
  backfills the ledger.
