# Project Documentation Navigation

---

## Project Overview

This project uses software engineering to manage the automated generation, optimization, and maintenance of a complete programming project by AI. It builds large-model development orchestration around the Claude Code CLI, the Codex CLI, and LLM APIs, plugging the right large model into the right scenario and making the best decisions across four dimensions: development needs, cost, efficiency, and production quality. It forms a closed development loop from a stakeholder raising a requirement, to the requirement landing as documentation, to task breakdown, and finally to delivery. The end goal is a system that can be maintained over the long term and that self-tunes and self-upgrades automatically.

---

## Key Notes

`Key terms:`

* Resource consumption must be measurable; dimensions can include CPU time and tokens (if those are unavailable, use the number of FunctionCall invocations, with a minimum of 1).
* It must produce and maintain data (including code, documentation, logs, and so on); without that, it cannot exist on its own.
* Total output measurement: how much documentation, how much code, how many bugs were reported. Actual output measurement: how many bugs the code produced, and how many of those bugs were genuinely valid.
* Bug distillation: every bug must be recorded in detail—which role reported it, the time, the related code, the Git revision, the cause, the handling process (the solution), the resolution outcome, and keywords (so it can be quickly located on reproduction).
* Sub Agent evaluation: it must record in detail how many resources each Agent consumed, how much content it produced, and how much of that content was valid.
* The entire development process and the Story lifecycle are managed by the program, with the underlying Agent or LLM reasoning making the decisions. Advancing the development process is like breathing—it cannot stop or err (and is relatively fixed), so it must not be left to the Agent to decide.
* Every Sub Agent must be tunable: its context, scope of responsibility, workload, and whether it participates must all be dynamically adjustable. Each Story's development cadence must be dynamically adjusted according to the system's runtime and monitoring state, never rigidly fixed.

---

## Table of Contents

---

## Lattice CLI Rollout

`lattice` is the current command entry point and the only active product command. For local project development, inspection, and restoring context, prefer:

```bash
lattice check
lattice doctor --format=json
lattice session_brief
lattice host status --host=claude-code --format=json
lattice rollout_check --projects /path/to/project --json
```

After developing the Lattice CLI itself, the local/global refresh flow is:

```bash
npm --prefix packages/main run build
npm install -g ./packages/main
lattice --version
lattice check
lattice doctor --format=json
lattice rollout_check --projects "$(pwd)" --json
```

`rollout_check` is a read-only cross-project inspection: it reads Git state, managed asset state, runtime footprint, and story/transcript scope readiness, and outputs each project's `status` and `nextAction`. It never runs `check --apply`, `check --upgrade`, repair/fix, third-party installers, evidence submission, or receipt verification. The main repo can be PASS; external projects, old wrappers, or non-git projects are interpreted as WARN/FAIL with a next step, rather than forcing the user to run doctor/check one by one and guess at the cause.

### Authority modes: off / shadow / enforce

`LATTICE_AUTHORITY_MODE` controls whether the CLI interacts with the Python authority. **None of the three modes block the local Story workflow**: local lifecycle gates (`story_advance`, `verification_evidence_add`, DONE) do not read server receipts, so `authority_status` always reports `localWorkflowUsable: true`; missing enforce prerequisites only feed `readinessWarnings` / `nextActions` and never become a global blocker.

| Mode | When to use | CLI behavior | Production authority? |
|------|----------|----------|------------------------|
| `off` (default) | Normal local Lattice story development, **free and purely local**. | No network requests at all; local evidence and DONE gate behavior are unchanged. | No: `productionDone=false`, `receiptVerified=false`. |
| `shadow` | You want to observe the Python authority's responses while keeping local behavior. | Best-effort observational POST; on failure, only a stderr warning, with no effect on the local write. | No: the transport's `accepted: true` is `thin-client-transport-accepted`, not a signed receipt. |
| `enforce` | Isolated headless runner / Authority job path, which **requires** a Python authority server + customer API key + a registered actor key + runner identity + project id + pinned server key. | `authority enforce runner --dry-run` projects readiness; `--live` signs the native envelope, registers/heartbeats the runner, and claims jobs. Authority job execution consumes typed `plannedSteps[]`, uploads evidence, requests server `gate_decision`, verifies the native receipt, and then completes or releases the lease according to policy. | Only a signature-verified native `gate_decision` receipt can support per-run `authorityDone`; `fullAuthorityDone` also requires final multi-host certification. Runner heartbeat/claim alone is not production authority. |

Inspect the authority surface the local CLI sees:

```bash
# Default off: no env needed
lattice authority status --json

# With shadow / enforce missing prerequisites you will see readinessWarnings + nextActions
LATTICE_AUTHORITY_MODE=shadow lattice authority status --json
LATTICE_AUTHORITY_MODE=enforce lattice authority status --json

# The Conduit view mirrors the same readiness fields
lattice conduit status --json
lattice conduit explain --json
```

`authority status --json` field reference:

- `mode` — `off` | `shadow` | `enforce`
- `localWorkflowUsable: true` — the local story workflow is never blocked by authority
- `authorityUrlConfigured` — whether `LATTICE_AUTHORITY_URL` is set
- `customerApiKeyConfigured` — whether `LATTICE_AUTHORITY_CUSTOMER_API_KEY` / `_PATH` is set
- `customerApiKeySource` — `env` | `path` | `authority_md` | `missing`
- `customerApiKeyValid` — unknown until a live probe; presence alone does not imply validity
- `actorKeyConfigured` — whether `LATTICE_AUTHORITY_ACTOR_KEY` / `_PATH` is set
- `actorKeyRegistered` — whether the actor public key is registered with the Authority server
- `serverPublicKeyPinned` — whether the receipt server public key is pinned/verified
- `runnerConfigured` — whether `LATTICE_AUTHORITY_RUNNER_ID` is set
- `readinessWarnings: string[]` — only populated when shadow/enforce is configured but prerequisites are missing
- `nextActions: string[]` — the corresponding env / command suggestions
- `productionDone: false`, `receiptVerified: false`, `canClaimProductionDone: false`

**Important boundary**: this local JSON or text output is **not** authority evidence. Only an `AuthorityReceipt` issued by the Python authority and signature-verified by the runner / client counts as signed production authority. Even with `LATTICE_AUTHORITY_URL`, `LATTICE_AUTHORITY_ACTOR_KEY`, and `LATTICE_AUTHORITY_RUNNER_ID` all set, `productionDone` stays `false` until a signed native Lattice Authority `gate_decision` receipt is signature-verified. Full `fullAuthorityDone` additionally requires final multi-host certification. For the PD-1 / PD-2 trust boundary, see [`requirements/decisions/authority-client-role.md`](requirements/decisions/authority-client-role.md).

### Autopilot modes: local / shadow / authority

`lattice autopilot` is the unattended-development control surface. It keeps the
local workflow available by default and only uses Python authority in the
explicit authority mode.

```bash
lattice autopilot status --json
lattice autopilot doctor --json
lattice autopilot run --mode=local --storyId=B-xxxx --until=TEST --json
lattice autopilot execute --mode=local --storyId=B-xxxx --until=TEST --maxSteps=20 --json
lattice autopilot run --mode=authority --storyId=B-xxxx --until=DONE \
  --receiptFile=receipt.json --serverPublicKey="$SERVER_PUBLIC_KEY_HEX" \
  --receiptKind=gate_decision --receiptProjectId="$PROJECT_ID" \
  --receiptStoryId=B-xxxx --serverKeyId="$SERVER_KEY_ID" \
  --expectedDecisionDigest="$DECISION_DIGEST" --json
```

- `local` is the default and never requires Python authority.
- `shadow` reports authority readiness warnings without blocking local work.
- `authority` fail-closes on missing Python authority readiness; `DONE` also
  requires a signed native `gate_decision` receipt, server public key, and
  explicit project/story/server-key/decision binding before reporting
  `status: pass`. Legacy `subjectId` / `subjectKind` receipts do not satisfy
  native authority DONE.
- `autopilot_run` is dry-run by default. Only `--dryRun=false` records an
  `autopilot_projection` process event, and that projection is not gate
  evidence or production authority.
- `autopilot_execute` is the true bounded executor loop. Non-dry-run execution
  requires `--storyId`, runs only argv-mapped Lattice commands, records a
  non-authoritative `autopilot_execution` event, and only invokes Claude Code
  CLI repair when `--allowClaudeRepair=true` is explicit.

### Planner: natural language → Story + plan

`lattice planner ...` is the Lattice-native planner entry point: it turns a one-sentence natural-language requirement into a Lattice Story draft, checklist, verification intent, and typed `plannedSteps[]` for the autopilot executor to consume. It never hands Story / job / receipt authority to an external framework.

```bash
lattice planner draft --request="Add a hello command that prints hi" --json
lattice planner review --draftFile=draft.json --json
lattice planner status --runId=<plannerRun> --json
lattice planner source-manifest --sourceRepo=<path> --json
lattice planner run --request="<one sentence>" --mode=local --until=DONE --json
lattice planner run --request="<one sentence>" --mode=authority --until=DONE --json
```

Boundaries:

- `planner draft` / `review` / `status` / `source-manifest` are read-only; `planner create-story` / `create-job` write state only through Lattice commands.
- Interaction mode is `--interactionMode=autonomous|interview|decision-gated` (default `autonomous`); a paused run resumes with `planner answer` / `planner decision submit` / `planner resume`.
- `planner run` strings together draft → review → Story → job/local plan → executor, but DONE is still bound by the same gates as autopilot: `local` reaches at most local certified completion, and authority DONE still requires a signature-verified native `gate_decision` receipt. The planner is still converging against its fixtures, so treat it as the planning entry point, not a guarantee of unattended DONE.

### Multi-host verdicts and run status

Release certification can require independent host verdicts. There are two verdict paths, and they are deliberately not interchangeable:

```bash
# Authority (server-backed) path
lattice authority verdict submit --jobId=<job> --runId=<run> --verdictFile=<verdict.json> --json
lattice authority verdict list   --jobId=<job> --json
lattice authority job status      --jobId=<job> --json

# Local (non-authority) path
lattice autopilot review submit --storyId=<story> --runId=<run> --verdictFile=<verdict.json> --json
lattice autopilot review status --storyId=<story> --runId=<run> --json

# Read-only resolution of a planned step's worktree / phase
lattice story resolve --storyId=<story> --json
```

Boundaries:

- `authority verdict submit` is the Authority path; `autopilot review submit` is the local path. The local path only records verifier verdicts into local run state keyed by `storyId` / `runId`, and never creates an Authority receipt or sets Authority DONE flags.
- `authority verdict list` / `authority job status` / `story resolve` are all read-only. `authority job status` summarizes host-verdict status without minting or replacing a native receipt; until the real Authority criteria are met, `multiHostVerified` / `fullAuthorityDone` stay `false`.

### Source-Aligned Redevelopment Workflow

`planner run --workflow=source-aligned-redevelopment` composes a source-aligned redevelopment plan: take an authorized source codebase and reproduce its modules, functions, behavior, and fine details in a target project and target language, with project-name-based identifier renaming.

```bash
lattice planner run --workflow=source-aligned-redevelopment \
  --sourceRepo=<path-or-ref> --targetProject=<path> --targetProjectName=<name> \
  --sourceLanguage=typescript --targetLanguage=rust \
  --mode=local --until=DONE --json
```

Boundaries:

- It is a development workflow, not a new interaction mode; it runs under one of `autonomous` / `interview` / `decision-gated`, and under either `local` or `authority`.
- The source codebase is read-only input; target files are written only through the story worktree and normal lifecycle gates. The workflow is language-pair agnostic (e.g. `typescript -> rust`, `swift -> kotlin`).
- It preserves license/attribution notices and excludes secrets, `.git`, caches, and build outputs from prompts/output/evidence. It produces evidence-backed alignment, not a promise of perfect semantic equivalence; in-scope details that cannot be verified are recorded as explicit gaps. This is a current-pass capability still converging against its fixtures, not part of the already-shipped baseline.

### CHK-002 enforce matrix smoke

`npm run test:authority-enforce-matrix` verifies the following five cells through a pure in-process matrix:

- **local/off stays free/local** — `loadAuthoritySettings({})` returns `mode: off`; `classifyCliAuthoritySubmission('off', …)` returns `local-only`, with no network access.
- **shadow is warning-only** — when the server fails, `proceed=true` + a stderr `[warning]`, with no exception thrown and no blocking of the local write.
- **enforce fake receipt can be classified as L2+ only after receipt verification** — an ordinary CLI submission is always `thin-client-transport-accepted`; only when a fully-bound envelope + a signed `AuthorityReceipt` is passed into `classifyReceiptBackedEvidence` and signature-verified does it reach `receipt-backed-l2-plus`.
- **enforce missing server fails closed for the runner/submission path** — `createAuthoritySubmitter(enforce, no baseURL).submitSingle(…)` returns `proceed=false`, with no network access.
- **parallel_report is always non-authoritative** — `buildParallelReport(wave)` always has `authority.productionDone=false`, `authority.authorityChanged=false`, and an empty `authority.receiptRefs`.

## Host Overflow

Lattice Host Overflow is a **manual-first** bounded overflow process: Lattice holds story / scope / receipt / merge authority, and Claude Code is only an execution host, not a production authority.

Recommended order:

```bash
lattice host_status --host=claude-code --json
lattice handoff_create --storyId=B-xxxx --fromHost=codex --toHost=claude-code --json
lattice handoff_worktree_create --file=handoff-pack.json --json
lattice host_dispatch --host=claude-code --file=handoff-pack.json --mode=supervised --json
lattice handoff_receipt_submit --file=receipt.json --json
```

Key boundaries:

- `host_status` only reports overflow readiness; it does not grant authority.
- `handoff_create` produces a bounded pack containing `packId`, `packHash`, `baseSha`, `allowedPaths`, `deniedPaths`, required commands, and execution instructions.
- `handoff_worktree_create` only projects worktree/branch/cleanup guidance; it does not automatically create, merge, clean up, or trust results.
- `host_dispatch` only returns `planned|unavailable` and `nextAction`; it does not auto-trust, submit evidence, verify receipts, or claim `productionDone`.
- `handoff_receipt_submit` only accepts a local diagnostic receipt; even on `accepted-local`, it still keeps `receiptVerified=false` and `productionDone=false`.

The later `dispatch_plan` / `dispatch_prepare` / `dispatch_run` must also obey the same boundary:

- They may only perform supervised, visible automation. The operator must be able to see the target host, the plan, the receipt, the status, and the review/merge guidance.
- If the target host lacks the corresponding CLI/runtime, the result must degrade to `unavailable` or a diagnostic `nextAction`; it must not silently switch to another host or skip silently.
- Even a fake/local receipt may not auto-merge, may not verify an authority receipt, and may not change `productionDone` to `true`.

For the detailed architecture, see [`requirements/decisions/host-overflow.md`](requirements/decisions/host-overflow.md).

### Unattended dispatch — `dispatch_auto` (policy-authorized)

`dispatch_auto` is the **policy-authorized unattended scheduler**, an extension path of `overflow_auto`. How it differs from `overflow_auto`:

| | `overflow_auto` | `dispatch_auto` |
|---|---|---|
| Default mode | suggest-only (requires `--approve --start` to actually start) | policy-gated (starts workers automatically once checks pass) |
| Policy required | No | Yes (refuses if the policy is missing or unauthorized) |
| Host safety check | No | Yes (refuses if `unattendedSafe=false`) |
| Unattended | No | Yes |

If you are already using `overflow_auto` and want unattended workers, first define a dispatch policy and then migrate to `dispatch_auto`. The `overflow_auto` `nextAction` field will point to `dispatch_auto`.

**Full opt-in sequence:**

```bash
# 1. Define the dispatch policy (only once)
lattice dispatch_policy_create --policy=my-policy \
  --allowedHosts=fake --allowedPaths=packages/main/src/generated/ \
  --maxParallel=2 --maxRuntimeMinutes=30 --maxBudgetUSD=5.0 \
  --network=none --commandAllowlist='node -e "process.exit(0)"' \
  --requireReceipt=true --requireReview=true \
  --allowAutoMerge=false --allowProductionDone=false

# 2. Verify policy authorization
lattice dispatch_policy_check --policy=my-policy --format=json

# 3. Probe host capability (does not start an external process; returns unavailable when the CLI is not on PATH)
lattice host_runtime_probe --host=claude-code --json

# 4. Start policy-authorized unattended workers
lattice dispatch_auto --storyId=B-xxxx --policy=my-policy --format=json

# 5. Watch lifecycle / runner status
lattice dispatch_watch --dispatchId=D-xxxx --format=json

# 6. Cancel (evidence is not deleted)
lattice dispatch_cancel --dispatchId=D-xxxx --format=json

# 7. Manual review: transcript / diff / receipt / runner evidence
lattice dispatch_review --dispatchId=D-xxxx --format=json

# 8. Manual merge (dispatch completion ≠ production authority)
lattice dispatch_merge_plan --dispatchId=D-xxxx --format=json
```

**Unattended mode remains user-authorized and authority-safe:**

- `dispatch_auto` **refuses** (explicitly, without pretending to execute) in the following cases:
  - the `policy` argument is missing
  - the policy does not exist or is unauthorized (`authorized=false`)
  - the host is unavailable (`status=unavailable`) or `unattendedSafe=false`
  - the host is not in the policy's `allowedHosts` list
  - the policy's `maxParallel` limit is exceeded
- Worker output is only an evidence candidate; it does not constitute gate authority.
- `dispatch_merge_plan` is always `manualOnly=true`; it never auto-merges or auto-DONEs.
- All authority fields are fixed to `false`: `productionDone=false`, `receiptVerified=false`, `authorityChanged=false`.

## Combining Code and Documentation

When code is generated, the documentation for that code must be generated in sync, in JSON format. Every time the code is modified, the code's documentation must be updated in sync, down to every Class and function. A Class's documentation is fixed once set, but a function's documentation must be updated every time. The purpose of this is to extract the project's overall state in real time, to make it easy to analyze task completion, to tie it back to source material, and to keep it dynamically and promptly updated. Where each piece of code's requirement came from, how many times it has been updated, and the content of each update should all be recorded; deleted or deprecated code should not be removed either—all history must be preserved. Much of this content is subjective and needs to be validated with automated scripts.

## Testing

This includes white-box and black-box tests. Every test needs detailed tracking: time, content, a test code reference (`{featureId}-{name}`), whether it is verified, and the verification result.

## Use MCP to invoke scripts; do not let the LLM call a script directly—it must be written as an MCP service, otherwise the service becomes very hard to use.
