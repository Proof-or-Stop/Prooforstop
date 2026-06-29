# Autopilot v2 — Unattended Long-Horizon Reliability (Execution Plan)

> **Authority Server retirement note:** Any server-backed Authority mode, receipt, or job language in this document is legacy/out-of-core. Active autopilot assurance is local proof admissibility, local gate evidence, signed/offline receipt bundles, and local review quorum.

**Status:** IMPLEMENTED for B-320f normal-channel DEV. M1 checkpoint/resume was already present;
B-320f adds M2 health-aware pause/resume semantics, M3 adaptive throttle state, M4 claim/lease/
fencing safety semantics, a host-neutral baseline export, and a dedicated reliability smoke.
This remains a multi-milestone program document for future production hardening beyond the local
deterministic smoke surface.

**North star (one sentence):** make `lattice autopilot_run` + `autopilot_resume` /
`autopilot_watch` **restart-safe** across the failure classes a multi-day unattended run
actually hits — **HTTP 429 / 503 / 529 / overload, network outages, provider-side session
limits, and host/session interruptions** — assuming a host, supervisor, CI job, or human
relaunches the process after process death.

Provider-health classification applies to provider-side rate-limit, overload, and network
failures surfaced by a runtime adapter. Dispatch/runtime timeouts owned by Proofbound's local
subprocess boundary remain the existing local `stopReason: timeout` unless a future
provider-specific timeout signal is deliberately reclassified.

**Scope boundary.** This plan makes an autopilot run **restart-safe and resume-correct**. It does
not make the CLI process immortal. If the host process, terminal, Codex window, Claude Code
window, Antigravity window, CI job, or OS process dies, a supervisor or human must relaunch
`lattice autopilot_resume` / `lattice autopilot_watch`; the product guarantee is that the
relaunched run can prove where to resume and will not replay committed admissible `done`
checkpoints. In other words:
external host/session keepalive is a wrapper concern; durable checkpoint identity and
health-aware pause/resume are the autopilot concern.

Before this program, those guarantees did not hold inside autopilot; this plan ports four
mechanisms that were built and tested as out-of-band Host scaffolding for the powered run into
the product.

---

## 1. Why now — the trigger

Running the §5/§6 ablation (9,240 live `claude -p` cells, multi-day) required building a
three-layer guard **outside** Proofbound because the autopilot could not be trusted to run
unattended:

- `session-guard.sh` (resident, detached) — health-probes the provider every 5 min; on
  **429 OR network/connection failure OR any error** it STOPS the worker fleet, waits until
  healthy, relaunches. Evidence refs: `experiments/recovery-runner/powered/session-guard.log`
  records session-limit and network/connection pause→relaunch cycles on 2026-06-27;
  `experiments/recovery-runner/powered/resume.log` records 429 polling followed by relaunch;
  `experiments/recovery-runner/powered/campaign.log` records resumed starts with non-zero
  `already done` counts and completed-task skips.
- key-set resume in `run-campaign.mjs` — resume keyed on a stable work-unit identity
  (skip units that already have a result on disk), **never** a positional count offset
  (a count offset double-ran the post-void tail after a restart → produced 21 duplicate records).
- `ramp.sh` — raise concurrency only while stable (throughput up AND failures/voids not
  spiking) = a live rate-limit ceiling probe that backs off instead of hammering.
- `run-fleet.mjs` — process-level parallelism, because the engine's synchronous `execFileSync`
  blocks Node's single event loop, making in-process `Promise.all` concurrency FAKE
  (measured: concurrency=4 → only 1 live call).

**Evidence language rule.** The Host scaffolding evidence proves that these mechanisms worked in
the powered-run wrapper. It does **not** prove autopilot already has the product capability.
Milestone DONE claims must cite fresh autopilot-level tests, not only the wrapper logs above.
Autopilot-level DONE evidence must include: repo commit SHA, exact source file references, test
command, test artifact path, artifact hash when available, and run/checkpoint id. Approximate
`~line` references are acceptable only for pre-implementation gap scouting, not for milestone
completion.

**The reflexive lesson** (worth a sentence in the paper's discussion too): validating
"don't trust the agent, trust the evidence" *itself* required out-of-band, evidence-driven
health gating + identity-keyed idempotent resume at the campaign layer — the same discipline
the gate applies at the story layer. Long-horizon autonomy is, today, as much an infrastructure
problem as a model-capability one. This program closes that gap inside the product.

---

## 2. Autopilot v1 — grounded current state (the gap)

| Capability | v1 state | Evidence (file:line) |
|---|---|---|
| `autopilot_resume` | **Always REFUSED** — `stale_state` if >15 min, else `unsafe_state`; both return `status:'refused'`. "autopilot v1 does not safely resume host-native runs." Crash ⇒ full restart. | `packages/main/src/handlers/lattice-autopilot.ts:1179-1203` |
| **C1 health-aware pause/resume** | **PARTIAL** — `callWithRetry` (detects 429/503/529/timeout/network/overload/rate, exponential backoff ≤5×) exists but lives ONLY in the open-ended Claude CLI provider and is **not wired into the autopilot step executor**, which uses `execFileSync` and stops the run on a failed step. | retry: `packages/main/src/providers/claude-cli.ts:200-231`; executor: `packages/main/src/.../autopilot-executor.ts` (`defaultRunner` ~206-224, sequential loop ~388-605, step-failed stop ~552-556) |
| **C2 idempotent resume** | **MISSING** — no per-step/per-phase checkpoint, no identity-keyed skip, no double-run hazard guard. `run.json` records `iterations[]`/`events[]` but resume never uses them to skip completed work. | `lattice-autopilot.ts` AutopilotRunRecord ~120-160, resume ~1179-1203 |
| **C3 adaptive throttle** | **MISSING** — strictly sequential loop; no runtime concurrency/backoff. `maxConcurrentReview` is a PLANNING gate, not a runtime throttle. | executor loop ~516-558; `audit-config.ts:63-65` |
| **C5 process-level parallelism** | **MISSING** — in-process synchronous `execFileSync`/`spawnSync`; steps serialized (the SAME fake-concurrency constraint the fleet hit). A TEST smoke (`story-create-concurrency-smoke.ts`) already spawns OS child processes for exactly this reason, but there is no production pool. | executor ~206-224, 516-558; dispatch `lattice-dispatch.ts` |

State persistence DOES exist: phase state in `.lattice/story/actives/<id>/index.json` and the
autopilot run record in `.lattice/autopilot-runs/<runId>/run.json` survive a crash — but nothing
consumes them to resume.

### 2.1 Audit issues converted into implementation rules

| Audit issue | Problem in the previous draft | Binding rule in this plan |
|---|---|---|
| North-star overclaim | It mixed two layers: product resume correctness and external process/session keepalive. That made it sound like M1+M2 alone could keep a dead process alive. | Product scope is restart-safe resume. Host/OS keepalive remains a wrapper/supervisor concern. M1+M2 may claim resume-correct single-run reliability, not "process immortality." |
| Resume identity under-bound | A key like `phase + stepIndex + command + sha256(inputs)` can falsely match after plan, material, policy, executor, or provider-runtime drift. | A completed checkpoint is admissible only when its semantic identity matches the current run plan, story/material hashes, policy digest, executor/checkpoint schema, and host-runtime adapter identity. Drift downgrades it to `stale`, not `done`. |
| Persistence model ambiguity | The old wording said both "checkpoint list in `run.json`" and "append-then-fsync" without saying which one is the source of truth. | M1 uses a per-run checkpoint ledger-backed snapshot: append-only checkpoint events are authoritative for that autopilot run; `run.json` is the latest readable projection. On mismatch or torn snapshot, replay the checkpoint ledger or fail closed. |
| Host naming drift | The draft named `gemini` as a peer provider, but current Proofbound host baseline is `codex`, `claude-code`, and `antigravity` (`agy` alias). | The feature is host-neutral. It should normalize transient-failure semantics across current host runtime adapters. `gemini` is legacy compatibility only and must not appear as the current third-host baseline. |
| Evidence refs missing | The old draft said "real-tested" and "zero data loss" without direct artifact paths. | Every product claim must cite concrete artifacts. Wrapper evidence can motivate milestones; product DONE requires autopilot-level smoke/integration evidence. |
| Exactly-once overclaim | The old M1 wording implied completed work can never run twice, but a process can crash after external output and before a `done` checkpoint is committed. | The guarantee is: once a `done` checkpoint is committed, that step is not re-dispatched. An uncommitted/interrupted step is at-least-once unless existing artifacts can be verified and promoted. |
| Auto-resume ambiguity | M2 said auto-resume, while `autopilot_watch` was optional. That left no actor for recovery after the run process exits. | M2 must distinguish in-process waiting from external resume. `autopilot_watch`/supervisor/human resume is part of the M2 acceptance whenever the claim says "auto-resume after process exit." |
| Parallel duplicate risk | M4 relied on completed checkpoints, but parallel workers can duplicate a still-pending step before either writes `done`. | M4 must add atomic claim/lease/fencing before execution; `done` checkpoints alone are insufficient for OS-process pools. |

---

### 2.2 Relation to existing ledgers

Proofbound already has several ledgers. M1 must reuse the **ledger pattern** and shared
integrity habits, but it must not overload ledgers that have a different subject or consumer.

| Existing state/ledger | Current role | Why it is not the M1 resume source-of-truth |
|---|---|---|
| `.lattice/usage/llm-usage.jsonl` | Append-only, hash-chained LLM usage diagnostic ledger. | It accounts for provider usage and budget. It is runtime diagnostic data, not ordered autopilot step state. |
| `.lattice/evidence/ledger/observed.jsonl` | Evidence artifact observation audit. | The Evidence Platform architecture explicitly treats it as append-only audit, not source-of-truth. |
| `.lattice/story/actives/<storyId>/process-events.jsonl` | Story lifecycle/process-fact event history. | It records lifecycle facts, not autopilot per-step dispatch identity or skip/resume admissibility. |
| `.lattice/autopilot-runs/<runId>/run.json` | Current autopilot readable snapshot. | It survives ordinary writes, but it is a snapshot only. A crash can leave it stale relative to the last completed step unless backed by an authoritative per-run checkpoint ledger. |

M1 therefore adds an **autopilot-local checkpoint ledger** under
`.lattice/autopilot-runs/<runId>/` (exact filename chosen by implementation, for example
`checkpoint-events.jsonl`). It should follow existing ledger discipline: append-only writes,
strict schema, canonical identity, optional hash chaining, corruption detection, and a single
writer chokepoint. `run.json` remains the status/watch projection derived from that ledger.

---

### 2.3 Run-state vocabulary

The implementation must keep run, step, and health states separate. A paused run is not the same
as a failed step.

| State/event | Meaning | Recovery actor |
|---|---|---|
| `waiting_for_provider_health` | The current process is alive and waiting for a transient provider condition to clear. | Same `autopilot_run`/executor process. |
| `paused_requires_resume` | Durable state says the run stopped at a safe boundary and needs `autopilot_resume` or `autopilot_watch`. | Host wrapper, supervisor, CI, or human. |
| `blocked_requires_human` | Auth, quota, policy, or other non-transient condition needs human action. | Human/operator. |
| `plan_drift` | Current recomputed plan is incompatible with the frozen run plan. | Human/operator or explicit new run. |
| `resume_state_corrupt` | Checkpoint ledger cannot be strictly replayed. | Manual inspection; fail closed. |

Checkpoint events should carry `pause_reason`, `resume_after`, `health_category`,
`last_error_class`, `runPlanHash`, `stepInputClosureHash`, and the producer/runtime provenance
needed to audit who executed or waited.

---

## 3. Design principle — ORDER IS LAW

Build strictly **C2 → C1 → C3 → C5**. Idempotence first.

- Ramping a **non-idempotent** parallel runner multiplies duplicate-work bugs (the 21-duplicate
  incident is the small-scale rehearsal).
- Pause/resume **without checkpoints** loses mid-step state — you cannot recover from a crash.
- Health-awareness **without pause** is just fail-fast — still useless for a long run.

So: resume-correctness (C2) → health pause/resume (C1) → throttle (C3) → parallelism (C5).

---

## 4. Positioning split — what's mandatory vs gated

- **Phase 1 = M1 (C2) + M2 (C1): positioning-INDEPENDENT, mandatory.** Even a single attended
  story benefits: a 429 mid-REVIEW currently fails hard and emits no evidence; a crash forces a
  full restart. M1+M2 alone deliver the **bounded** single-run product target: durable
  resume-correctness plus health-aware pause. They do not replace OS/Host/CI supervision.
- **Phase 2 = M3 (C3) + M4 (C5): GATED on a positioning decision.** Only needed if Proofbound
  targets running **many** stories / reviewer lanes concurrently unattended. A single story has
  no fleet to ramp and one dispatch at a time.

If Proofbound never targets batch/unattended-at-scale, Phase 1 is the correct permanent scope and
M3/M4 stay unbuilt.

---

## 5. Reuse map — proven Host scaffolding → autopilot feature

| Milestone | Reference implementation (this repo, Host scaffolding) | What to port |
|---|---|---|
| M1 (C2) | `experiments/recovery-runner/powered/run-campaign.mjs` (key-set resume) | resume on stable work-unit identity; never a count offset |
| M2 (C1) | `experiments/recovery-runner/powered/session-guard.sh` (health-gate) | probe → on unhealthy wait/pause → resume when healthy via live process, watch, supervisor, or human; uniform over classified transient provider failures |
| M3 (C3) | `experiments/recovery-runner/powered/ramp.sh` (adaptive probe) | raise concurrency only while stable (throughput up + failures not spiking); back off |
| M4 (C5) | `experiments/recovery-runner/powered/run-fleet.mjs` (OS-process pool) | real concurrency requires OS child processes over the synchronous-exec dispatch |

These are NOT promoted as-is (the shell daemons / fleet pumper / matrix stay in Host). The
*mechanisms* are ported into autopilot's run-record state machine and step executor.

---

## 6. Milestones

### M1 — C2: Idempotent resume + re-enable `autopilot_resume`  (OP-CRITICAL, do first)

**Goal.** A crashed/killed autopilot run resumes from the frozen plan at the next admissible step.
Once a `done` checkpoint is committed, that step is never re-dispatched. An interrupted step with
no committed `done` checkpoint is at-least-once: it must either be safe to re-run, recoverable by
verifying existing artifacts, or explicitly reported as duplicate external cost allowed.

**Changes.**
- Define the persistence model explicitly as **per-run checkpoint ledger-backed snapshot**:
  - **Checkpoint ledger** = append-only checkpoint events, fsynced after each committed step; this
    is the source of truth for that autopilot run's crash recovery.
  - **Snapshot** = `run.json`, an atomic, readable projection of the latest run state; it may be
    regenerated by replaying the checkpoint ledger and must never be trusted over a valid
    checkpoint ledger.
  - If the checkpoint ledger and snapshot disagree, replay the checkpoint ledger; if replay fails
    strict validation, fail closed with `resume_state_corrupt` and require manual inspection.
- Extend the run schema with per-step checkpoints keyed by a stable semantic identity. The key
  must separate:
  - `runBasisHash`: frozen run-start basis, including `storyId`, starting `headHash`,
    `materialHash`, frozen pre-run `storyFilesHash`, selected policy digest, and execution
    boundary. `storyFilesHash` excludes files declared as outputs of this run so Autopilot does
    not mark its own legitimate outputs as stale.
  - `frozenRunPlanHash`: canonical hash of the plan frozen at run start.
  - `stepInputClosureHash`: canonical hash of the specific step's inputs, command, and declared
    dependencies.
  - `validityPolicyDigest`: current policy that decides whether older checkpoint/evidence may be
    reused.
  - `producerRuntimeIdentity`: host/runtime/adapter provenance. This is recorded for audit; it
    makes a checkpoint stale only when `validityPolicyDigest` says the runtime change is
    semantically load-bearing.
- Freeze the run plan in the checkpoint ledger before executing the first step. Resume must read
  this frozen plan first. Recomputing the current plan is only a compatibility check; if the
  current plan is incompatible with the frozen plan, enter `plan_drift` instead of silently
  continuing with a mixed plan.
- Checkpoint status values are `pending|running|done|failed|stale`. A checkpoint can be skipped
  only when status is `done` **and** the full semantic identity still matches. Any plan/material/
  policy/executor/provider-runtime drift makes it `stale`, forcing recomputation or manual
  resume approval rather than silent skip.
- After each step completes, persist its checkpoint event atomically (append-then-fsync; never a
  positional count that voids/skips would desynchronize), then update `run.json` as a projection.
- Rewrite `autopilot_resume` (`lattice-autopilot.ts:1179-1203`) to: load and replay the
  checkpoint ledger → read the frozen plan → recompute the current plan only for compatibility →
  skip steps whose checkpoint is committed `done` and admissible → resume at the first non-`done`
  step. Resume only at step boundaries; a step interrupted mid-flight (no `done` checkpoint) is
  not exactly-once and must follow the side-effect/idempotency rule above.

**Acceptance (RED tests first).**
- Kill an autopilot run mid-phase; `autopilot_resume` completes the run without re-dispatching
  committed admissible `done` checkpoints.
- Inject a "void" step (no result) between committed `done` checkpoints; resume re-runs ONLY the
  void step, not the tail after it (the 21-duplicate regression test, ported).
- Change `materialHash`, `storyFilesHash`, policy digest, or any policy-declared semantic runtime
  input between the original run and resume; the old checkpoint is reported as `stale` or
  `plan_drift` and is not silently consumed as `done`.
- Corrupt or truncate `run.json` while leaving the checkpoint ledger valid; resume replays the
  checkpoint ledger and continues. Corrupt the checkpoint ledger; resume fails closed with
  `resume_state_corrupt`.
- Crash after a step writes an output/artifact but before its `done` checkpoint is committed.
  Resume must either verify and promote the existing artifact to `done`, or explicitly re-run it
  as an uncommitted at-least-once step and record the duplicate external cost boundary.
- `autopilot_resume` no longer returns `refused` for a healthy non-stale record.

**Files.** `handlers/lattice-autopilot.ts` (record schema + resume), `.../autopilot-executor.ts`
(checkpoint write per step). No lifecycle-gate surgery.

---

### M2 — C1: Health-aware pause/resume on provider failure

**Goal.** A retryable provider failure during a dispatch/review is classified and routed to the
right recovery state instead of being collapsed into a generic step failure. If the process is
alive, the run may enter `waiting_for_provider_health` and continue when healthy. If the process
exits or reaches a safe pause boundary, it enters `paused_requires_resume`; recovery is performed
by `autopilot_watch`, a host/supervisor wrapper, CI, or a human invoking `autopilot_resume`.
**This + M1 = bounded single-run reliability: restart-safe resume plus health-aware pause.**

**Changes.**
- Lift `callWithRetry`/`isRetryable`'s transient-vs-terminal classification (provider-side
  429/503/529/overload/rate/network failures) out of `claude-cli.ts:200-231` into a **shared**
  bounded-dispatch helper.
  The helper is host-neutral: it applies to whichever runtime adapter the current host/window
  selected (`claude-code`, `codex`, or `antigravity`/`agy`). Legacy `gemini` may reuse the helper
  where compatibility code still exists, but it is not the current third-host baseline.
- In the autopilot step executor: classify failures into at least
  `transient_provider_overload`, `temporary_rate_limit`, `quota_exhausted`, `auth_required`,
  `session_expired`, `network_unreachable`, `terminal_step_error`, and `policy_blocked`.
  Only retryable/transient classes may wait or pause. Auth, quota, policy, and terminal step
  failures must not be retried as if they were overload.
- On a classified transient failure, exponential-backoff retry a bounded number of times; on
  persistent rate-limit/overload, transition to `waiting_for_provider_health` or
  `paused_requires_resume`, emit a categorized health issue (`health.ts`: add `llm_rate_limit` /
  `llm_overload` categories), append checkpoint-ledger health events, and surface a retry-after /
  pause hint in the failure reason instead of a hard stop.
- A paused run is resumable by M1's mechanism (idempotent, from the last `done` checkpoint).
- Extend the existing `lattice autopilot_watch` command so that, on `paused_requires_resume`, it
  re-probes health, appends observable health/resume events, and invokes resume when safe — the
  in-product analogue of `session-guard.sh`, while any resident daemon itself can stay a thin Host
  wrapper.

**Acceptance.**
- Simulate a 429 mid-dispatch: run enters `waiting_for_provider_health` or
  `paused_requires_resume`, NOT `failed`; no void emitted; on health restored, resume/watch
  finishes the run, committed `done` steps are not re-dispatched.
- Simulate a network drop (ECONNRESET/ETIMEDOUT): same pause→resume, no data loss.
- Simulate `auth_required`, `quota_exhausted`, `terminal_step_error`, and `policy_blocked`: none
  are treated as transient provider overload.
- Assert checkpoint/run events include enough observable data for `session-guard`-class behavior:
  `health_probe`, `provider_unhealthy`, `waiting_for_provider_health`, `paused_requires_resume`,
  `health_recovered`, and `resumed`, with concrete event/log artifact paths.
- `claude-code`, `codex`, and `antigravity`/`agy` adapters classify provider-side
  429/503/529/overload/network failures consistently. Local dispatch/runtime timeout remains
  `stopReason: timeout` unless a future provider-specific timeout signal is deliberately
  reclassified. Any remaining `gemini` compatibility path must be explicitly marked legacy and
  cannot be used as evidence for the current third-host baseline.

**Files.** provider/runtime adapters for `claude-code`, `codex`, and `antigravity`/`agy`
(plus legacy `gemini` only where compatibility still exists), `providers/<shared>`,
`.../autopilot-executor.ts` (pause-on-transient), `core/health.ts` (categories),
`handlers/lattice-autopilot.ts` (status=paused).

---

### M3 — C3: Adaptive runtime throttle  (GATED on Phase-2 positioning)

**Goal.** Bound and adapt live LLM concurrency to the provider's actual ceiling, backing off on
rate-limit signals — turning the planning-only `maxConcurrentReview` into a real runtime throttle.

**Changes.**
- A sliding-window/semaphore rate limiter in the dispatch path; `--maxConcurrentLive` (distinct
  from the planning `maxConcurrentReview`).
- On 429/overload: increase inter-dispatch delay (back off); on a stable window: cautiously raise
  toward the cap (the consumer side of M2's health signal — port `ramp.sh`'s "raise only while
  stable, failures not spiking" rule).

**Acceptance.**
- Standalone M3: limiter state-machine tests prove `--maxConcurrentLive` is enforced in simulated
  multi-permit dispatch, inter-dispatch delay increases on 429/overload, and throttle events log
  `throttle_hold`, `throttle_raise`, `throttle_backoff`, and window stats.
- M3 + M4 integration: under induced 429s in the real process pool, actual live concurrent
  dispatches drop and later recover; never exceeds `--maxConcurrentLive`.

**Files.** `core/lattice-dispatch.ts` (throttle), `cli/command-schemas.ts` (`--maxConcurrentLive`).

---

### M4 — C5: Process-level parallelism  (GATED, LAST)

**Goal.** Run independent units (reviewer lanes / parallel-wave stories) truly concurrently,
which is impossible in-process because dispatch is synchronous `execFileSync`/`spawnSync`.

**Changes.**
- A bounded OS-process pool dispatcher in `core/` (control-file or arg-driven worker count),
  generalizing `story-create-concurrency-smoke.ts`'s rationale into a production path.
- Drive only steps with **no inter-step dependency** in parallel; gate concurrency by M3's
  `--maxConcurrentLive`.
- Add atomic step claim before execution: `claim` event, `ownerWorkerId`, `leaseId`,
  `leaseExpiresAt`, `fencingToken`, and compare-and-swap / file-lock semantics. A worker may
  execute only a step it has successfully claimed; expired claims must be fenced so a late worker
  cannot commit stale output.
- **Hard invariant:** committed `done` checkpoints prevent re-dispatch after completion, while
  claim/lease/fencing prevents two workers from executing the same pending step concurrently.
  (This is why M4 is LAST — parallelism atop a non-idempotent runner multiplies the duplicate-work bug.)

**Acceptance.** N independent lanes complete concurrently (wall-clock < serial sum); each unit's
checkpoint run count == 1; concurrent workers cannot claim the same pending step; an expired
claim cannot commit after a newer fencing token; a mid-run kill + resume still touches each
committed unit once.

**Files.** `core/<process-pool>.ts`, `core/lattice-dispatch.ts`.

---

## 7. Non-goals (stay out of the product)

- **C4 process-crash keepalive** — use `launchd`/`systemd`/CI runner; Proofbound's crash-resilience
  contribution is the durable phase/run persistence that already exists. A bespoke daemon in the
  CLI would duplicate mature init systems and blur the evidence value proposition.
- **C6 the 9,240-cell campaign matrix + two-phase equal-spend** — this is the paper's measurement
  apparatus; it lives in the experiments repo as a committed runnable generator, not a CLI feature.
- The resident 5-minute guard *daemon* and the fleet *pumper* stay as thin Host wrappers; only the
  *mechanisms* (health classification, idempotent resume, adaptive throttle, OS-process pool) move
  into autopilot.

---

## 8. Sequencing summary

1. **M1 (C2)** — idempotent resume + re-enable `autopilot_resume`. Positioning-independent. First.
2. **M2 (C1)** — health-aware pause/resume; shared provider retry. Positioning-independent. With M1 = bounded single-run reliability, provided a host/human/supervisor relaunches resume/watch after process death.
3. *Positioning decision: does Proofbound target unattended-at-scale?* If no → STOP here.
4. **M3 (C3)** — adaptive throttle. Gated.
5. **M4 (C5)** — OS-process pool. Gated. Last (needs M1's idempotence to be safe).

Each milestone is its own Lattice story (DEV via `lattice-implementer`, full 2-host review).
M1-M4 now have a deterministic product-level smoke surface under
`packages/main/src/tasks/autopilot-v2-reliability-smoke.ts`. Future stories may deepen the live
process-pool runner, but must keep these semantics: committed admissible `done` checkpoints are
not re-dispatched; uncommitted/interrupted steps are at-least-once unless verified and promoted;
`storyFilesHash` is frozen from the pre-run baseline while excluding declared outputs; and
runtime identity is recorded as audit provenance unless the active validity policy declares it
semantically load-bearing.

---

## 9. B-320f implementation and acceptance status

| Item | Implementation status | Acceptance evidence |
|---|---|---|
| M1 checkpoint/resume | Present before B-320f and preserved. The checkpoint ledger remains authoritative and `run.json` remains a readable projection. | Existing `packages/main/src/core/lattice-autopilot.ts` checkpoint ledger and `autopilot_resume` replay path are unchanged in structure; B-320f only adds health events around pause/resume. |
| M2 health-aware pause/resume | Implemented as shared classification/state helpers plus minimal `autopilot_run` integration at dispatch failure boundaries. Provider-side retryable 429/503/529/overload/network failures become provider-health states; quota/auth/policy/terminal errors are non-transient. Dispatch/runtime timeout remains the local `stopReason: timeout` boundary unless a future provider-specific timeout signal is deliberately reclassified. | `node packages/main/dist/tasks/autopilot-v2-reliability-smoke.js` asserts `health_probe`, `provider_unhealthy`, `waiting_for_provider_health`, `paused_requires_resume`, `health_recovered`, and `resumed` event semantics. |
| M3 adaptive throttle | Implemented as deterministic local throttle state with bounded `maxConcurrentLive`, permit checks, `throttle_hold`, `throttle_raise`, and `throttle_backoff`. | Smoke asserts bounded concurrency, raise on stable windows, backoff on provider failures, and hold behavior. |
| M4 process-pool safety | Implemented as deterministic claim/lease/fencing state semantics for worker-owned step execution. Duplicate live claims are refused; expired leases can be reclaimed; stale fencing tokens cannot complete a step. | Smoke asserts duplicate live claim refusal, expired lease reclaim, stale fencing-token refusal, successful completion by the current owner, and refusal after completion. |
| Host baseline | Current host-neutral baseline is Codex, Claude Code, and Antigravity. `agy` is an alias for Antigravity. Gemini is legacy/deprecated compatibility only. | `HOST_RUNTIME_BASELINE` is exported from `packages/main/src/core/lattice-dispatch.ts`; smoke asserts the current and legacy sets. |
| Documentation acceptance | Updated. The document no longer overclaims exactly-once behavior and explicitly distinguishes wrapper keepalive from product restart-safe resume. | This table records the B-320f acceptance surface and expected verification commands. |
| Build | PASS in B-320f DEV. | `npm --prefix packages/main run build` |
| Reliability smoke | PASS in B-320f DEV. | `node packages/main/dist/tasks/autopilot-v2-reliability-smoke.js` prints `autopilot-v2-reliability smoke PASS`. |
| Regression smokes | PASS in B-320f DEV. | `node packages/main/dist/tasks/autopilot-resume-smoke.js`; `node packages/main/dist/tasks/autopilot-run-smoke.js`. These protect M1 replay, existing Authority-boundary behavior, full-autopilot bounded retry, budget-capped fail-closed behavior, and local dispatch guard classification. |
| Version and CLI entrypoint | PASS in B-320f DEV. | `node packages/main/dist/tasks/lattice-cli-migration-smoke.js`; `node packages/main/dist/cli.js --version` prints `Proofbound CLI 0.3.103`. |
| Routine validate | Required in TEST phase, not advanced by this DEV task. | `lattice validate --story=B-320f` after phase advancement to TEST. |
| DONE | Not performed by this DEV task. | DONE requires the normal Lattice review/test/DONE flow and any configured DONE-required evidence. |
