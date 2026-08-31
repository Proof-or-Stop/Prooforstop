# Proof-or-Stop Host-Neutral Observability Console (CLI-backed read-only)

> Status: **adopted source-of-truth reference** · v0 · 2026-06-02 · located in `docs/requirements/decisions/`, indexed in `docs/requirements/NAV.md`
> Positioning: this is a **read-only consumption layer over the Proof-or-Stop CLI JSON surface** — not a Mac Native App, nor a new authority; it refactors the reference picture's "Claude Code Agent Monitor" from a **single-host transcript monitor** into a **host-neutral orchestration observatory**.
> Data source: it may **only** be consumed via `proof-or-stop ... --format=json` (L0 commands); the underlying backing store (worktree / Story store / activity.jsonl) is a backing store and is **not read as JSON directly**.
> Red line: it is entirely an **L0 read-only projection**, never claims production DONE, and the authority recognizes only receipt-backed evidence.
> Maturity: the M1-M3 data capabilities are ready (the CLI is fully there); the M4 projection is feasible but the Thread/Trajectory schema is not first-classed; **M5 depends on B-2522's receipt-backed verifier (the README makes clear the enforce path is not yet end-to-end)**; the M6 parallel/wave/dispatch data plane already exists.
> Naming note: the repository's existing `proof-or-stop dashboard` is a **terminal-resident real-time story-progress board**, which is not the same thing as this document's multi-page read-only console; existing commands still have `proof-or-stop` naming residue, which is a follow-up outside this proposal.

---

## 0. Why We Cannot Copy the Reference Picture Directly

The reference picture (Claude Code Agent Monitor) is essentially a **transcript inversion**: it reads the hook events of `~/.claude/projects/*.jsonl` and reverse-engineers the token / tool / session of a single host (Claude Code) runtime into a board. Its "Completed / Error" is **host runtime state**, not delivery authority.

The core of the next-generation Proof-or-Stop is **Host-Neutral**: it fully decouples "complete" from the host runtime. Any host (Codex, Claude Code, a future headless runner) is just an **adapter**, which can only execute the authorized task package and submit an **auditable receipt**. The authority layer recognizes only Canonical Story + receipt-backed evidence, and the host-local "it's green" is always only `local-evidence`.

> Source truth: `docs/requirements/decisions/project-vision.md` (host-neutral general orchestration CLI), `docs/requirements/decisions/lattice-parallel-wave.md` (Authority Boundary), `packages/main/src/core/canonical-story.ts` (the actual data structure).

So the Dashboard's semantic axis must change from "is the session alive" to "**which authority tier are we at / where did a visible degradation occur / can we recover**."

---

## 1. The Eight Host-Neutral Core Concepts → Real Data Structures → Dashboard Surface

Each row of the table below anchors to **code or a CLI that already exists** in the repository, not to a hypothetical:

| Concept | Landing structure (real) | The CLI that produces it (L0 read-only) | Dashboard surface |
|---|---|---|---|
| **Host-neutral State** | `CanonicalStory.authority.tier ∈ {local-evidence, server-record, server-receipt}`; the dual values `lifecycle.localDone` vs `lifecycle.productionDone` | `story_export --format=json` | The three-tier distribution of the "Authority Ladder" at the top of Overview + the localDone↔productionDone gap |
| **Canonical Story** | `schemaVersion:'canonical-story-v0'` + `canonicalStoryDigest` / `gateInputDigest` (sha256 tamper-proof) | `story_export` | Canonical Story Board (replaces Kanban, columned by tier rather than by host state) |
| **Capability Contract** | `hostCandidates[].capability status` + the Proof-or-Stop capability registry | `host_list` / `host_probe` / `host_install`(dry-run) / `parallel_wave_create.hostCandidates` | Capability Matrix (a host × capability grid) |
| **Visible Degradation** | `degradations[]`: `{host, capability, reason, fallback, authorityImpact, recovery}`, `authorityImpact ∈ {none, evidence-local-only, verification-evidence-limited, blocks-production-done}` | Embedded in `story_export` / `parallel_*` / `conduit_explain` | Degradation Heat (colored by authorityImpact, with blocks-production-done in red) |
| **Lineage** | `lineage:{source, storyDir, worktree, processEvents[], artifacts{checklist,processEvents,deliveryCheck}}` + `evidenceRefs` (lineage reference only) | `story_export`, `parallel_report.evidenceSummary` | Lineage Graph (the story↔worktree↔evidence↔receipt traceability chain) |
| **Thread** | A single host's bounded execution of **one task package**: `handoff → story_export.lineage.processEvents fragment → receipt` (a per-agent thread) | `parallel_dispatch.dispatchEntries`, `story_export.lineage.processEvents` | Thread Inspector (replaces the reference picture's Conversation, threading by host/agent) |
| **Trajectory** | The ordered path formed by lifecycle transitions + `story_export.lineage.processEvents` + `mergeOrder`: `truth→story→code→extract→gap→converge` | `convergence_check`, `parallel_merge_queue.mergeOrder`, `story_export.lineage.processEvents` | Trajectory Timeline (replaces the reference picture's Timeline; the axis is lifecycle, not wall-clock) |
| **Recovery Point** | `lineage.recoveryPoints[]:{id, kind:'story-store', path}` + the wave's `recoveryRefs` | `story_export`, `parallel_plan.recoveryGuidance` | Recovery Console (the recoverable anchor of each story / wave + the resume instruction) |

> Honest annotation: `Thread` and `Trajectory` are currently **projection concepts on top of process-events + lifecycle**, with no independent persistence struct yet (`canonical-story.ts` has only the `processEvents` atomic events). The Dashboard implements them with projections, and only milestone M4 promotes them to first-class schemas. `productionDone` is currently **always false** — in `buildCanonicalStory`, `verifiedReceiptRefs` is always `[]`, until B-2522's receipt-backed verifier lands (see M5). This gap is itself the first-class citizen the Dashboard is meant to visualize.

---

## 2. Data Source: Read-Only Consumption of the Proof-or-Stop CLI JSON (does not touch the transcript, nor read the backing store directly)

```
backing store (for understanding only, the adapter is forbidden to read it directly)
├── Story store          .proof-or-stop/story/actives/B-xxx/{index.json, checklist.json,
│                          process-events.jsonl, delivery-check.json, test-evidence.json}
├── Worktree on-site      .worktrees/B-xxx/  + authority:{main|worktree} + mirror:{phase}
└── Global heartbeat      .proof-or-stop/activity.jsonl / docs/story/activity.jsonl

The only authoritative way to read ── CLI L0 projection (the adapter consumes only this layer's --format=json)
    ├── session_brief / status              → ⚠ currently 【only returns Markdown, no --format=json】, see §2.1(0)
    ├── story_export --format=json          → Canonical Story v0 (contains all 8 concepts; --format=json is implemented)
    ├── parallel_wave_create / _inspect      → the full Wave envelope (storyRefs/hostCandidates/mergeOrder/evidenceRefs)
    ├── parallel_plan / _dispatch / _status  → scheduling projection (note that status does not repeat the full envelope)
    ├── parallel_merge_queue / _report       → merge order + lineage summary (does not repeat the full envelope)
    ├── host_list / host_probe / host_install→ Capability Contract
    ├── authority_status                      → snapshot of the current authority tier
    ├── conduit_status / conduit_explain      → the host↔authority channel + degradation explanation
    ├── rollout_check                         → version/wrapper/managed-assets/runtime inspection
    └── convergence_check                     → truth↔code convergence judgment (the Trajectory endpoint)
```

### 2.0 CLI JSON stdout contract (B-7fc2)

The adapter / dashboard / smoke can treat the following assumptions as a hard contract:

- **stdout in machine JSON mode is JSON.parse-able as a single document.** When the caller passes `--json` or `--format=json`, the corresponding command's stdout must be "**a single JSON document + an optional trailing newline**," with no next-step hint, decorative text, ANSI control characters, or a second JSON document concatenated after it. The caller **does not need** to do substring extraction (`extractFirstJsonObject` / regex matching `\{...\}`, etc.); a direct `JSON.parse(stdout)` must succeed.
- **Human-readable guidance goes only through text mode or stderr.** The `→ Validation passed`, `→ Next step…`, and other next-step hints of commands such as `proof-or-stop validate` are appended only in **non-JSON mode**. `stderr` is used for logs / progress / config notices and does not pollute the stdout contract.
- **Implementation-choice note**: the contract is enforced by the unified choke point of the CLI output pipeline (`cli-engine.ts`) — a hit on `wantsMachineJson(args)` skips `decorateResult`, and all hint-registered commands (including `validate`) automatically comply. If a `--json` / `--format=json` command is added later, a hit on the same detector automatically gains contract protection, with no need to patch each one separately.
- **Regression protection**: `tests/cli-json-stdout-contract-smoke.ts` (`packages/main/src/tasks/cli-json-stdout-contract-smoke.ts`) spawns a real CLI subprocess and directly `JSON.parse(stdout)` — any regression that concatenates a hint back into JSON mode will immediately turn the smoke red. Text mode is checked at the same time to ensure it keeps `→ Validation passed`, preventing "deleting the human hint along with the fix to JSON mode."

> Actual effect: the dashboard / host adapter treats the Proof-or-Stop CLI's `--format=json` / `--json` stdout as a stable contract, with no need to handle the past anti-pattern where `validate --json` concatenated `→ Validation passed. Next: …` at the end, causing `JSON.parse` to fail.

### 2.1 Three schema/authority Pitfalls the Adapter Must Solve First

0. **The resolver JSON surface is currently missing (the real first task of M1)**: in practice, `proof-or-stop status --format=json` / `--json` and `session_brief` **both ignore the flag and only return Markdown**, and `--help` has no `--format` parameter either. So M1 is **not "writing an adapter to consume ready-made JSON"**, but first **adding/extending a machine-readable resolver surface** that returns `{storyId, authority, mirrorPhase, authoritativePhase, authoritativeCwd, worktreePath}` for each active story. Before it lands, having the UI adapter parse Markdown is a fragile anti-pattern and is forbidden.
1. **worktree authority vs main mirror (the most critical)**: running `story_export B-xxx` at the repo root reads the **main mirror** (often stuck at INIT_CHECK, stale); only running it inside `.worktrees/B-xxx` gives the **authoritative** phase. The adapter **must first use the (0) resolver to get `authoritativeCwd`, then export in the correct cwd** — it cannot just aggregate the root's export.
2. **The parallel projection does not share the same envelope**: `parallel_wave_create` has the full `storyRefs/hostCandidates/mergeOrder`; but `parallel_status` / `parallel_merge_queue` / `parallel_report` **do not repeat the full envelope** (the source of truth `lattice-parallel-wave.md` §Projection JSON Contracts states this explicitly). The adapter must write a mapping per **each command's real schema**, and cannot assume all fields are present.

### 2.2 resolver Row Schema (**example, does not embed a specific active story**)

> This document **deliberately does not embed any specific story on-site** — an active story's phase moves on a minute scale (within the same day B-aa98 has gone back and forth between DEV↔REVIEW), so hardcoding will surely go stale. The table below is the **field contract** of the §2.1(0) resolver surface, and each field is filled in by the resolver in real time at render time:

| Field | Type | Meaning |
|---|---|---|
| `storyId` | string | `B-xxxx` |
| `authority` | `main` \| `worktree` | Whether the authority is in the main repo or the worktree |
| `mirrorPhase` | phase | The main-metadata mirror phase (may lag) |
| `authoritativePhase` | phase | **The truly authoritative phase** (worktree first) |
| `authoritativeCwd` | path | The adapter must switch to this directory before `story_export` |
| `worktreePath` | path \| null | `.worktrees/B-xxxx` or null |

> Anchoring the main thread (from the B-aa98 background, citing the concept not the on-site): "treat Claude Code as another host adapter… an external host can only execute the authorized task package and submit auditable results" — this is exactly the host-neutral main thread this console aims to present.

---

## 3. Information Architecture (reuses the reference picture's left navigation + dark-card style, refactoring the semantics)

| Reference picture page | Proof-or-Stop replacement page | Semantic axis from → to | Main data source |
|---|---|---|---|
| Dashboard | **Host-Neutral Overview** | host runtime health → Authority Ladder + degradation gap | `story_export` aggregation + `authority_status` |
| Kanban (Working/Waiting/Completed/Error) | **Canonical Story Board** | the four host-state columns → **three tier columns** (local-evidence / server-record / server-receipt) | `story_export` |
| Sessions | **Wave / Lane View** | a single session list → parallel worktree lanes + merge queue | `parallel_status` / `parallel_merge_queue` |
| Conversation | **Thread Inspector** | the Main Agent conversation stream → per-host task-package threads (handoff→events→receipt) | `parallel_dispatch` + process-events |
| Timeline | **Trajectory** | wall-clock events → the lifecycle trajectory (truth→…→converge) + recovery anchors | `convergence_check` + process-events |
| Activity Feed | **Lineage & Degradation Feed** | the all-host event stream → the degradation/authority-change event stream (colored by authorityImpact) | `conduit_explain` + degradations[] |
| Analytics | **Capability & Authority Analytics** | token/cost → capability coverage / tier drift / productionDone-gap trend | `host_probe` + historical export |
| Claude Config | **Host Registry / Conduit** | browsing the Claude config → the host adapter registry + conduit + rollout inspection | `host_list` / `conduit_status` / `rollout_check` |
| Run Claude | **Dispatch Console** | running Claude → generating a task package for an overflow host (needs runner confirm, spawned=false) | `parallel_dispatch` (`requiresRunnerConfirmation=true`) |
| Settings | **Authority Boundary & Pricing** | pricing → read-only display of the authority-boundary switch + pricing | `proof_or_stop_config_doctor` |

**New page**: **Recovery Console** (no reference-picture counterpart) — aggregates all `recoveryPoints` + `recoveryGuidance`, and gives a one-click resume path of `cd .worktrees/B-xxx` / re-running `story_export`.

---

## 4. Key Panel Specs (ASCII mockup, reusing the dark / card / progress-bar style)

> **All the mockups below are illustrative only**; the numbers and storyIds in them are all placeholders `<...>`, **not real counts**, and are filled in by the resolver/`story_export` in real time at render time. The document does not embed any specific on-site that would go stale.

### 4.1 Host-Neutral Overview — Authority Ladder (replaces the Health Score ring)

```
┌─ AUTHORITY LADDER ────────────────────────  <totalStories> stories ─┐
│                                                                      │
│  server-receipt   ▓                          <receiptCount>   (n%)   │  ← productionDone true value
│  server-record    ▓▓                         <recordCount>    (n%)   │
│  local-evidence   ████████████████████████   <localEvidenceCount>(n%)│  ← localDone but not receipt
│  in-flight        ▓▓▓                         <activeCount> (active)  │
│                                                                      │
│  ⚠ localDone↔productionDone GAP: <localEvidenceCount> local-green, zero receipt│
│    authorityImpact=blocks-production-done                            │
└──────────────────────────────────────────────────────────────────────┘
```

> This cell is the whole console's thesis: the reference picture would mark `<localEvidenceCount>` of them green as "Completed," while Proof-or-Stop marks them as "local-evidence" — **the server receipt has not been obtained yet, so it does not count as production done**.

### 4.2 Canonical Story Board (replaces Kanban, columned by tier)

```
 LOCAL-EVIDENCE        SERVER-RECORD       SERVER-RECEIPT      DEGRADED ⚠
 ┌───────────────┐    ┌──────────────┐    ┌──────────────┐   ┌────────────────┐
 │ <storyId>     │    │  (empty until│    │  (empty until│   │ <storyId>      │
 │ <title>       │    │   server-    │    │   receipt    │   │ missing-server │
 │ wt:<worktree> │    │   record)    │    │   verified)  │   │ -receipt       │
 │ digest:<d4>.. │    │              │    │              │   │ impact: BLOCKS │
 │ evidence:<n>  │    └──────────────┘    └──────────────┘   │ -production    │
 └───────────────┘                                           │ recovery: run  │
 │ <storyId>     │                                            │ receipt flow   │
 │ wt:<worktree> │                                            └────────────────┘
 └───────────────┘
```

Each card shows: `storyId · phase · worktree · the first 4 bytes of canonicalStoryDigest · evidence count · highest authorityImpact`. Clicking it open = the full text of `story_export`.

### 4.3 Capability Matrix (replaces Subagent Effectiveness)

```
┌─ CAPABILITY CONTRACT ─────────── host × capability ────────────┐
│ host            story  scope  receipt  diff-apply  job-claim    │
│ codex           ✓ ok   ✓ ok   ✓ ok     ✓ ok        ✓ ok         │
│ claude-code     ✓ ok   ✓ ok   ⚠ DEGR   ⛔ none      ⚠ DEGR       │
│ headless-runner ✓ ok   ✓ ok   ✓ ok     ✓ ok        ✓ ok         │
│                                                                 │
│ ⚠ claude-code/receipt-verify → fallback: keep local-evidence   │
│   authorityImpact: blocks-production-done                       │
└─────────────────────────────────────────────────────────────────┘
```

The data comes from `host_probe` + `parallel_wave_create.hostCandidates`. Hovering over each ⚠/⛔ = the degradation reason/fallback/recovery of `conduit_explain`.

### 4.4 Trajectory + Recovery (replaces Timeline)

```
<storyId> TRAJECTORY    truth ──► story ──► code ──► extract ──► gap ──► converge
                       ✓        ✓        ◉<phase>  ·          ·        ·
                                         │
 RECOVERY POINTS ──────────────────────┤
   • <storyId>:story-store  kind=story-store  <lineage.recoveryPoints[].path>
   • resume: cd <authoritativeCwd> && proof-or-stop story_export --storyId=<storyId> --format=json
```

---

## 5. The Essential Difference Between Host-Neutral and the Reference Picture (a thesis that can be stated in one sentence)

| Dimension | Reference picture (transcript monitor) | Proof-or-Stop Host-Neutral Dashboard |
|---|---|---|
| Data source | `~/.claude/projects/*.jsonl` hook events | worktree + Story store + L0 CLI projection |
| Definition of "complete" | the host runtime marks Completed | **receipt-backed `server-receipt` tier** |
| host binding | hard-bound to Claude Code | adapter-ized (codex / claude-code / runner are equal) |
| Failure expression | a red Error card | **Visible Degradation** (with fallback + recovery + authorityImpact) |
| Recoverable | none | **Recovery Point** is a first-class citizen |
| Tamper-proof | none | `canonicalStoryDigest` / `gateInputDigest` sha256 |
| Authority | monitoring is the truth | **read-only projection, never authorizing** (`authority.productionDone=false` hardcoded) |

---

## 6. Milestones (anchored to real story progress)

> Each milestone maps to a real CLI + the current story state, and introduces no new authority path.

| M | Name | Delivery (all L0 read-only) | Real story dependency | Exit criterion |
|---|---|---|---|---|
| **M1** | Resolver surface + Read-only adapter | **First add a machine-readable resolver JSON surface** (returns `storyId/authority/mirrorPhase/authoritativePhase/authoritativeCwd/worktreePath` for active stories), then wrap the `story_export`/`parallel_*`/`host_*`/`authority_status` adapter, zero writes | `status`/`session_brief` currently only Markdown (needs extending); the other CLIs already exist | **The first acceptance item** = the resolver JSON surface exists and the UI does not need to parse Markdown; all 8 concept fields can be obtained from the CLI JSON |
| **M2** | Authority Ladder + Story Board | The Overview three-tier ladder + the tier-columned board + degradation coloring | M1 resolver + `story_export` aggregation | `localEvidenceCount` lands correctly in the local-evidence column; the localDone↔productionDone GAP card is shown |
| **M3** | Capability & Conduit | Capability Matrix + Host Registry + `conduit_explain` hover | B-aa98 (Host Overflow adapter) | claude-code's receipt-verify degradation is visible and comes with a recovery |
| **M4** | Promote Thread + Trajectory to first-class schemas | Define the Thread / Trajectory projection schema on top of `story_export.lineage.processEvents`; Thread Inspector + Trajectory Timeline | B-5cdc (runner job claim / provider event flow, **already DONE and can serve as a base**) | A single-host task-package thread can be replayed; the lifecycle trajectory is connected |
| **M5** | Recovery Console + productionDone true value wired through | recoveryPoints/guidance aggregation; when B-2522's receipt-backed verifier lands, the server-receipt column is non-empty for the first time | **B-2522 (receipt-backed verifier + local/enforce E2E); the README makes clear the enforce path is not yet end-to-end** | At least 1 story enters the `server-receipt` tier, and the change in the gap metric is visible |
| **M6** | Wave scheduling view + Dispatch Console | Parallel lanes + merge queue + task-package dispatch (`spawned=false` / `requiresRunnerConfirmation=true`) | The full parallel-wave set (already exists) | The dispatch projection does not auto-spawn, does not auto-merge, and does not submit a receipt |

**Key order**: M1→M2 first establishes the thesis that "host-local green ≠ production done" (the data is already ready); M5 is the high point of the Host-Neutral closed loop — once B-2522 submits a verifiable receipt, the Dashboard's `server-receipt` column **lights up for the first time**, and the whole table goes from "the honest anxiety of all-local-evidence" to "a production done that is on record."

---

## 7. Authority-Boundary Red Lines (not to be crossed)

1. **The Dashboard is an L0 read-only projection**: it may write the export file requested by the caller, but **never** changes story metadata / process evidence / lifecycle / receipt / authority / and does not spawn a runner.
2. **Never claim production DONE**: all projections hard-carry `authority.productionDone=false`, `authorityChanged=false`, `receiptRefs=[]`, unless a **verified** receipt appears in the export.
3. **A local PASS is not upgraded**: a host-local "green" always stops at `local-evidence`, and rollout_check / wave / handoff cannot promote it to production authority.
4. **Degradation must be visible**: any capability gap enters `degradations[]` and is marked with `authorityImpact`, and is not silently swallowed.
5. **Tamper-proof**: display `canonicalStoryDigest`, alarm when the diff does not match, and do not trust a "Canonical Story that has been modified."
6. **Enforce is not yet closed-loop**: the README makes clear the `enforce` path is "Not implemented end-to-end yet"; even with a Python authority env configured, the `shadow`-mode `accepted:true` is only `thin-client-transport-accepted`, **not a verified receipt**. Before the B-2522 receipt flow is wired through, the `server-receipt` column must stay empty, and `productionDone`/`receiptVerified` must stay `false`. The Dashboard must not render shadow accepted as "complete."

> The source of truth is the Authority Boundary of `docs/requirements/decisions/lattice-parallel-wave.md`, `packages/main/src/core/canonical-story.ts`, and `README.md` (Authority modes off/shadow/enforce). This document is a read-only console design projection, and does not modify any authority semantics.

---

## 8. Adoption Status and Next Steps

**This document has been adopted as a design source of truth**: it is located at `docs/requirements/decisions/host-neutral-observability-console.md`, registered in the decisions list of `docs/requirements/NAV.md`, and can be referenced by other stories / decisions as an implementation contract. It has completed de-hardcoding (no specific active-story on-site) and de-legacy-command examples (unified `proof-or-stop ... --format=json`).

**Next step = the M1 implementation story** (see the §6 milestone table): `Read-only adapter skeleton + worktree-authority resolver`.

- **The first acceptance item**: the **resolver JSON surface** of §2.1(0) — `status`/`session_brief` currently return only Markdown, so a machine-readable surface must be added first that returns `{storyId, authority, mirrorPhase, authoritativePhase, authoritativeCwd, worktreePath}`, to avoid the UI adapter parsing Markdown.
- After M1 lands, advance per M2→M6; M5 (the `server-receipt` column lighting up for the first time) is blocked on B-2522's receipt-backed verifier.
