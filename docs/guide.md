# Project Documentation Navigation

---

## Project Overview

This project uses software engineering to manage the automated generation, optimization, and maintenance of a complete programming project by AI. It builds large-model development orchestration around the Codex CLI, Claude Code CLI, Antigravity CLI (`agy`), and LLM APIs, with Gemini retained only as a deprecated legacy compatibility host, plugging the right large model into the right scenario and making the best decisions across four dimensions: development needs, cost, efficiency, and production quality. It forms a closed development loop from a stakeholder raising a requirement, to the requirement landing as documentation, to task breakdown, and finally to delivery. The end goal is a system that can be maintained over the long term and that self-tunes and self-upgrades automatically.

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

## Proofbound CLI Rollout

`lattice` is the current command entry point and the only active product command. For local project development, inspection, and restoring context, prefer:

```bash
lattice check
lattice doctor --format=json
lattice session_brief
lattice host status --host=claude-code --format=json
lattice rollout_check --projects /path/to/project --json
```

After developing the Proofbound CLI itself, the local/global refresh flow is:

```bash
npm --prefix packages/main run build
npm install -g ./packages/main
lattice --version
lattice check
lattice doctor --format=json
lattice rollout_check --projects "$(pwd)" --json
```

`rollout_check` is a read-only cross-project inspection: it reads Git state, managed asset state, runtime footprint, and story/transcript scope readiness, and outputs each project's `status` and `nextAction`. It never runs `check --apply`, `check --upgrade`, repair/fix, third-party installers, evidence submission, or receipt verification. The main repo can be PASS; external projects, old wrappers, or non-git projects are interpreted as WARN/FAIL with a next step, rather than forcing the user to run doctor/check one by one and guess at the cause.

### Local Proof Admissibility

Server-backed authority modes and receipt commands are retired from the active Proofbound CLI. Active evidence vocabulary is `admissibilityStatus`, `assuranceLevel`, `evidenceScope`, gate-consumed local evidence, signed/offline receipt bundles, and local review quorum assurance.

### Autopilot Mode: Local Only

`lattice autopilot` is the local unattended-development control surface.

```bash
lattice autopilot status --json
lattice autopilot doctor --json
lattice autopilot run --mode=local --storyId=B-xxxx --until=TEST --json
lattice autopilot execute --mode=local --storyId=B-xxxx --until=TEST --maxSteps=20 --json
```

- `local` is the only active mode.
- `autopilot_run` is dry-run by default. Only `--dryRun=false` records an
  `autopilot_projection` process event, and that projection is not gate
  evidence or release readiness.
- `autopilot_execute` is the true bounded executor loop. Non-dry-run execution
  requires `--storyId`, runs only argv-mapped Proofbound commands, records a
  non-authoritative `autopilot_execution` event, and only invokes Claude Code
  CLI repair when `--allowClaudeRepair=true` is explicit.

### Planner: natural language → Story + plan

`lattice planner ...` is the Proofbound-native planner entry point: it turns a one-sentence natural-language requirement into a Proofbound Story draft, checklist, verification intent, and typed `plannedSteps[]` for the autopilot executor to consume. It never hands Story / job / receipt authority to an external framework.

```bash
lattice planner draft --request="Add a hello command that prints hi" --json
lattice planner review --draftFile=draft.json --json
lattice planner status --runId=<plannerRun> --json
lattice planner source-manifest --sourceRepo=<path> --json
lattice planner run --request="<one sentence>" --mode=local --until=DONE --json
```

Boundaries:

- `planner draft` / `review` / `status` / `source-manifest` are read-only; `planner create-story` / `create-job` write state only through Proofbound commands.
- Interaction mode is `--interactionMode=autonomous|interview|decision-gated` (default `autonomous`); a paused run resumes with `planner answer` / `planner decision submit` / `planner resume`.
- `planner run` strings together draft → review → Story → local plan → executor, but DONE is still bound by the same local gates as autopilot. Treat it as the planning entry point, not a guarantee of unattended DONE.

### Multi-host verdicts and run status

Release certification can require independent local host verdicts:

```bash
lattice autopilot review submit --storyId=<story> --runId=<run> --verdictFile=<verdict.json> --json
lattice autopilot review status --storyId=<story> --runId=<run> --json
lattice quorum_submit '{"storyId":"B-xxxx","hostA":"codex","hostB":"claude"}'

# Read-only resolution of a planned step's worktree / phase
lattice story resolve --storyId=<story> --json
```

Boundaries:

- `autopilot review submit/status` records local verifier verdicts keyed by `storyId` / `runId`.
- `quorum_submit` bulk-records local 3x2 quorum evidence only after current reviewer pass evidence exists for every required review lane.

### Source-Aligned Redevelopment Workflow

`planner run --workflow=source-aligned-redevelopment` composes a source-aligned redevelopment plan: take an authorized source codebase and reproduce its modules, functions, behavior, and fine details in a target project and target language, with project-name-based identifier renaming.

```bash
lattice planner run --workflow=source-aligned-redevelopment \
  --sourceRepo=<path-or-ref> --targetProject=<path> --targetProjectName=<name> \
  --sourceLanguage=typescript --targetLanguage=rust \
  --mode=local --until=DONE --json
```

Boundaries:

- It is a development workflow, not a new interaction mode; it runs in local mode and uses `--interactionMode=autonomous|interview|decision-gated` for human interaction policy.
- The source codebase is read-only input; target files are written only through the story worktree and normal lifecycle gates. The workflow is language-pair agnostic (e.g. `typescript -> rust`, `swift -> kotlin`).
- It preserves license/attribution notices and excludes secrets, `.git`, caches, and build outputs from prompts/output/evidence. It produces evidence-backed alignment, not a promise of perfect semantic equivalence; in-scope details that cannot be verified are recorded as explicit gaps. This is a current-pass capability still converging against its fixtures, not part of the already-shipped baseline.

### Legacy enforce matrix smoke

This legacy matrix is retained only as historical migration context; it is not an active runtime baseline. Current Proofbound assurance uses local proof-admissibility, receipt-bundle anti-tamper checks, and local review quorum evidence.

- Local proof evidence remains local and does not require a remote receipt.
- Legacy shadow/enforce transport behavior is out-of-core and superseded by local admissibility gates.
- Legacy remote receipt classifications must not be used as current release evidence.
- `parallel_report` remains non-production evidence unless admitted by local gate evidence and review quorum.

## Host Overflow

Proofbound Host Overflow is a **manual-first** bounded overflow process: Proofbound holds story, scope, receipt review, and merge responsibility, and Claude Code is only an execution host, not a release-readiness oracle.

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
- `host_dispatch` only returns `planned|unavailable` and `nextAction`; it does not auto-trust, submit evidence, verify receipts, or widen local assurance.
- `handoff_receipt_submit` only accepts a local diagnostic receipt; even on `accepted-local`, it remains diagnostic until matching local assurance evidence exists.

The later `dispatch_plan` / `dispatch_prepare` / `dispatch_run` must also obey the same boundary:

- They may only perform supervised, visible automation. The operator must be able to see the target host, the plan, the receipt, the status, and the review/merge guidance.
- If the target host lacks the corresponding CLI/runtime, the result must degrade to `unavailable` or a diagnostic `nextAction`; it must not silently switch to another host or skip silently.
- Even a fake/local receipt may not auto-merge, may not verify a receipt bundle, and may not widen local assurance.

For the detailed architecture, see [`requirements/decisions/host-overflow.md`](requirements/decisions/host-overflow.md).

### Truth-First Host Handoff Guard

Before a host tells the user a task is still missing, run a truth-first preflight:

```bash
lattice session_brief
lattice story_get '{"storyId":"<storyId>"}'
lattice checklist_get '{"storyId":"<storyId>"}'
```

When checking linked documents, inspect the `supersession` frontmatter fields in the
decision docs:

- `status`: `completed`, `superseded`, `historical`, or `draft`.
- `completedByStory` + `completionCommit`: proof anchor to the live story outcome.
- `supersededBy`: when set, users and hosts should prefer the newer story/document.

Compatibility:
- `sourceStoryId` / `sourceCompletionCommit` are accepted as legacy aliases for
  back-compat, but hosts should treat `completedByStory` / `completionCommit` as
  the authoritative fields.

If live story/checklist facts say DONE but a referenced doc says pending, host responses
must follow live facts first and should mark the doc as stale rather than re-assigning
the work.

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
  --allowAutoMerge=false

# 2. Verify policy authorization
lattice dispatch_policy_check --policy=my-policy --format=json

# 3. Probe host capability (does not start an external process; returns unavailable when the CLI is not on PATH)
lattice host_runtime_probe --host=claude-code --json
lattice host_runtime_probe --host=antigravity --json

# 4. Start policy-authorized unattended workers
lattice dispatch_auto --storyId=B-xxxx --policy=my-policy --format=json

# 5. Watch lifecycle / runner status
lattice dispatch_watch --dispatchId=D-xxxx --format=json

# 6. Cancel (evidence is not deleted)
lattice dispatch_cancel --dispatchId=D-xxxx --format=json

# 7. Manual review: transcript / diff / receipt / runner evidence
lattice dispatch_review --dispatchId=D-xxxx --format=json

# 8. Manual merge (dispatch completion is not release readiness)
lattice dispatch_merge_plan --dispatchId=D-xxxx --format=json
```

**Unattended mode remains user-authorized and local-assurance-safe:**

- `dispatch_auto` **refuses** (explicitly, without pretending to execute) in the following cases:
  - the `policy` argument is missing
  - the policy does not exist or is unauthorized (`authorized=false`)
  - the host is unavailable (`status=unavailable`) or `unattendedSafe=false`
  - the host is not in the policy's `allowedHosts` list
  - the policy's `maxParallel` limit is exceeded
- Worker output is only an evidence candidate; it does not constitute gate proof.
- `dispatch_merge_plan` is always `manualOnly=true`; it never auto-merges or auto-DONEs.
- Dispatch output remains diagnostic until proof-admissibility, receipt-bundle,
  and review-quorum evidence make it locally admissible.

## Combining Code and Documentation

When code is generated, the documentation for that code must be generated in sync, in JSON format. Every time the code is modified, the code's documentation must be updated in sync, down to every Class and function. A Class's documentation is fixed once set, but a function's documentation must be updated every time. The purpose of this is to extract the project's overall state in real time, to make it easy to analyze task completion, to tie it back to source material, and to keep it dynamically and promptly updated. Where each piece of code's requirement came from, how many times it has been updated, and the content of each update should all be recorded; deleted or deprecated code should not be removed either—all history must be preserved. Much of this content is subjective and needs to be validated with automated scripts.

## Testing

This includes white-box and black-box tests. Every test needs detailed tracking: time, content, a test code reference (`{featureId}-{name}`), whether it is verified, and the verification result.

## Use MCP to invoke scripts; do not let the LLM call a script directly—it must be written as an MCP service, otherwise the service becomes very hard to use.
