# AGENTS.md

<!-- proof-or-stop:start -->
## Proof-or-Stop

- `.proof-or-stop/Proof-or-Stop.md` is the host-neutral Proof-or-Stop guide; this file keeps only Codex / AGENTS additions.
- At the start of a new session, or when resuming interrupted work, run `proof-or-stop session_brief`.
- Before acting, run `proof-or-stop aux_doc_list` to inspect relevant docs.
- Use the global `proof-or-stop` CLI for Story / checklist / fixture / bug operations. Do not edit story/fixture JSON directly.
- Parallel Proof-or-Stop work is local-only: use local git worktrees/local branches, finish by merging to local `main` and cleaning the worktree. Remote publish is default-denied; a human must run `proof-or-stop release_approve_push --confirm` for a short-lived one-shot approval before any `git push origin main`.
- Codex adapter verification uses the global CLI: `proof-or-stop codex verify`. For diagnostics, run `proof-or-stop codex doctor`.
- Run `proof-or-stop check` to check Proof-or-Stop managed asset/template drift; after review, use `proof-or-stop check --apply` to sync safe items.

<!-- proof-or-stop:end -->

## Repository-specific operating guide

This English guide supplements the managed global-thin block above for the
Proof-or-Stop repository. The repository-local CLI and implementation at the
current checkout are authoritative when this guide, generated help, and runtime
behavior disagree. Run `node bin/proof-or-stop.js --version` and command-specific
`--help` before relying on remembered syntax. This revision was reconciled
against repository-local Proof-or-Stop 0.3.270.

The current lifecycle is:

```text
INIT -> INIT_CHECK -> PLAN -> DEV -> REVIEW -> TEST -> DONE
```

`TEST_CASE` and `TEST_CASE_REVIEW` are compatibility-only phases for old data.
New Stories use checklist `verificationIntent`, tool-owned
`verificationEvidence`, reviewer lanes in REVIEW, and `proof-or-stop validate`
in TEST. A configured `doneRequiredCommands` policy additionally requires fresh
DONE-required evidence.

## Working rules

1. The first command in every new or resumed session must be
   `proof-or-stop session_brief`. It reports the active Story, phase, checklist,
   bugs, owner lease, recent activity, memory preflight, scope protection, git
   state, and the next recommended action.
2. Before acting, run `proof-or-stop aux_doc_list` and then read only the
   relevant truth sources. In 0.3.270, `aux_doc_list` and the other registered
   `aux_*` commands are available from the repository-local CLI; do not repeat
   the obsolete claim that all auxiliary commands require a separate bootstrap.
3. Use the complete Story lifecycle unless the user explicitly requests an
   immediate or quick edit and the CLI classifies the request as eligible.
4. Keep output concise, reasoning thorough, and the implementation direct.
5. Prefer a focused edit over an unrelated rewrite. Do not re-read files whose
   relevant contents are already known unless freshness matters.
6. Test or otherwise verify the result before announcing completion.
7. Do not add flattering openings or closings.
8. User instructions override this repository guide.
9. Never directly write or mutate Story or fixture JSON. Story state lives under
   `.proof-or-stop/story/actives`, and all Story, checklist, bug, finding,
   evidence, and fixture mutations must go through the CLI. Direct JSON edits
   bypass signatures, hashes, locks, receipts, and lifecycle validation. Prefer
   CLI reads for ordinary state inspection. Read-only access to the bounded Story
   inputs explicitly named by a canonical reviewer prompt is permitted when that
   reviewer contract requires it; this exception grants no mutation authority.
10. Engineering completion is not product completion. A Story is complete only
    when the requested user-visible result is delivered and the applicable
    technical and lifecycle evidence is current.

### Defect triage and bounded scope

Classify every newly discovered defect before changing scope.

- **REVIEW Finding handling**: after reviewers return, use `finding_list` to confirm that every Finding was registered through `finding_add`. Every Finding reported only in reviewer prose must be redispatched for structured registration; prose alone is not a Finding. Process each registered Finding. Decide current-Story repair versus routing from applicability, gate impact, and evidence, never from severity alone or a desire to make the repository globally green.
- **Bounded current-Story repair**: the Story Owner must repair a verified applicable Finding in the current Story when it is critical or high, was introduced or worsened by the current Story, directly blocks acceptance, a verification intent, the core user result, or a public compatibility promise, has known or uncertain protected-surface impact, or would make lifecycle gate evidence or gate truth misleading. Severity and applicability are separate axes: severity alone does not decide scope. In the future official system, every final applicable assessment binds exactly one `dispositionPlan`: `repair_current` or `defer_with_proof`; only an otherwise eligible verified applicable low or medium Finding may use the latter.
- **Evidence-backed routing, otherwise fail closed**: route a defect only when structured evidence proves that it is not applicable to the current Story, names a traceable owner or route, and proves that it does not block the current gate. Critical or high Findings must never be left without a traceable owner. `not_reproduced_under_current_witness` requires fresh target-bound negative command and runtime receipts, signed command-policy and witness bindings, and a live receipted owner or route; an old DONE result is insufficient. Preserve reproduction evidence, impact, and the original Finding. If a defect would otherwise block and its applicability is unknown, keep it in the current Story, including a medium Finding in a policy round where medium is blocking. In the future official system, `REQUIRED_ASSESSMENT_INVALID = { missing, re_attestation_required, stale, unsigned, tampered, mismatched, incomplete, expired, unknown }` places a verified open high or critical Finding in a transient assessment-integrity floor before severity, round, and advisory policy; it does not itself prove applicability or require current-Story repair. Fresh strong non-applicable proof releases that floor, fresh applicable proof converts high or critical to mandatory repair, and weak or invalid proof remains blocked. In the future official system, invalid claimed deferral lineage is an independent first floor. In that future official system, only a fresh signed superseding `pre_existing_unaffected`, `out_of_scope`, or `duplicate` verdict satisfying its independent strong proof contract, a signed `disproven` truth transition with current counter-evidence, or complete repair closure releases that lineage floor. In that future official system, complete repair closure is a distinct release path and does not weaken the exact allowlist for non-repair supersession. In that future official system, `not_reproduced_under_current_witness` never releases claimed-deferral lineage or mandatory repair. In the future official system, invalid or exhausted deferral lineage also creates a downstream mandatory-repair classification; once that obligation is active, only a fresh signed `MandatoryRepairClassification(state='closure_proven')` clears it, so lineage-floor superseding proof does not clear the whole block. These future machine-owned floors do not authorize Story-scope expansion. Never expand the Story merely to make the repository globally green.
- **Compatibility boundary and dismissal**: the Dynamic Finding System execution plan is future authority. The current compatibility CLI does not implement a signed `FindingDeferralDisposition` or `defer_with_proof`. Future authority distinguishes final-assessment `dispositionPlan`, `FindingDeferralDisposition.assessmentDispositionPlan='defer_with_proof'`, and manifest `expectedAssessmentDispositionPlan`; `repair_current` forbids `acceptedRoute`, non-applicable verdicts bind an exact route without a plan, and `unknown` binds neither. Until official commands and artifacts exist, use only fields and commands exposed by the current CLI; never fabricate an assessment, disposition, owner, route, signature, freshness binding, expiry, lineage, receipt, manifest action, or any of those future fields. Only the Owner may use current `finding_dismiss` as an audited round/profile action when mechanical policy permits it; the command mechanically changes status from `open` to `dismissed` and therefore removes the Finding from the current REVIEW blocking predicate, but it proves neither applicability nor `out_of_scope`, and it is not proof of repair or resolution, nor proof of deferral. Gap and backlog handling remains compatibility accounting and does not itself change the predicate. Prompt text alone does not mechanically enforce this discipline. When the official system is available, consume its signed assessment and disposition; never use compatibility accounting or prose to erase or rewrite the original observation.

This rule replaces the former unbounded instruction to repair every nearby bug
or infrastructure issue while working on a Story. Checklist items and scope
artifacts are enforceable boundaries, not suggestions to ignore.

## Project configuration

The effective configuration is `proof-or-stop.config.json`. Its principal paths
are:

```json
{
  "scanRoot": "packages/main",
  "rootDir": "src",
  "outDir": "packages/main/dist",
  "testsDir": "packages/main/tests",
  "fixturesDir": "packages/main/tests/fixtures",
  "storyDir": ".proof-or-stop/story/actives",
  "requirementsDir": "docs/requirements"
}
```

Additional policy sections in the real file, including prompt envelopes,
candidate-spec routing, material-code exclusions, ProofStory enforcement,
admissibility, validation commands, and DONE-required commands, are also part of
the effective contract. Do not substitute the abbreviated example above for the
actual file. A `sourceFile` path is relative to `scanRoot`; for example, use
`game-logic.ts`, not `packages/main/game-logic.ts`.

## Architecture

Keep data, logic, and rendering separated:

- The data layer defines and stores state without business decisions.
- The logic layer implements business rules without DOM, rendering, or IO
  dependencies where practical.
- The rendering layer maps state to UI and remains thin.

Exercise the logic layer with focused logic or integration verification. Verify
rendering through browser-visible evidence when the user-facing behavior depends
on it. Classify a new function before placing it.

## Two-layer process-fact contract

Every fact that can affect phase transitions, review, test, DONE, or audit needs
two protections: prompts guide role behavior, while CLI handlers and gates enforce
the fact mechanically. A prompt-only change does not complete a process-fact
change.

Process facts include phase transitions, pass or no-issue credentials, finding
category/severity/role/agent, reviewer runs, reviewer passes, verification
evidence, scope and delivery checks, and REVIEW/TEST/DONE artifacts. Ordinary
design prose and examples may remain documentation, but gates must not treat
free-form text such as "checks passed" as evidence.

- A reviewer with no blocker calls `review_pass_set`; pass-like text submitted
  through `finding_add` is normalized by the handler rather than stored as a
  finding.
- A REVIEW reviewer calls `review_run_start` before recording a pass or finding.
  Gates verify that the `reviewRunId` belongs to the correct lane and current
  round, has a valid signature, and is fresh for the applicable hashes.
- A signed PASS from the current review round may remain valid when it is bound
  to a non-latest run on that lane, provided its material freshness and scope
  checks still pass. This deliberately avoids invalidating sound PASS evidence
  after a concurrent or retried `review_run_start`. The latest-run rejection is
  retained for findings, so an older open finding cannot be hidden by a newer
  pass on the same lane. No pass overrides material or scope drift, an invalid
  binding, or a still-open blocking finding.
- Finding categories are narrowed by both the CLI schema and runtime. Known
  legacy categories may normalize to `missing`; they do not create new current
  categories.
- Gates consume structured signatures, hashes, receipts, evidence, and check
  artifacts, never narrative claims alone.
- `packages/main/src/core/process-fact-registry.ts` derives command facts from
  `COMMAND_POLICIES` and `PROCESS_FACT_LEVELS` and explicitly registers reviewer
  lanes, artifacts, and required semantics. Any changed gate evidence, signed
  artifact, review lane, validation, reviewer-pass, or finding behavior must also
  update the registry and `scripts/verify-process-fact-contract.mjs`.
- Runtime and environment facts belong in
  `packages/main/src/core/runtime-fact-registry.ts`, with regression protection in
  `scripts/verify-runtime-fact-contract.mjs`. External-project local symlink or
  realpath expectations are advisory, not hard failures. The bounded external
  reference policy scans docs/config; it is not a network probe. Loopback hosts
  are internal examples.
- Runtime files, logs, and caches belong in
  `packages/main/src/core/runtime-artifact-registry.ts`. Material hashing,
  baseline risk, sync, init, and doctor behavior must consume that registry
  instead of hard-coding paths. Story evidence is a process artifact, not a
  runtime artifact.

## Story lifecycle

Always use the `hint` and structured blocker output returned by
`story_advance`, `checklist_update`, review commands, and `validate`. Generated
help can lag a handler detail; the state machine and gate output are decisive.

| Phase | Primary actor | Required work |
|---|---|---|
| INIT | Main agent and INIT reviewers | Create or import the Story, preserve the four-section background, confirm scope/execution boundaries, and complete INIT review evidence. |
| INIT_CHECK | CLI and main agent | Advance to INIT_CHECK to create the local Story branch/worktree, then enter that worktree. Complete INIT_CHECK gates before PLAN. |
| PLAN | Main agent, verification-intent agent, scope reviewer | Record understanding and any required decision, define checklist fields and verification intent, save independent scope evidence, and pass adversarial Story review. |
| DEV | Main agent | Modify scoped files, commit implementation, and record tool-owned verification evidence. Code or document implementation changes are allowed only here. |
| REVIEW | Independent reviewer lanes | Start signed reviewer runs, inspect the committed diff and intent coverage, then record current passes or findings. Complete any configured independent-host quorum. |
| TEST | Main agent and CLI | Run routine validation, resolve recorded bugs, refresh stale admissible evidence, and complete the delivery/summary prerequisites. |
| DONE | CLI | Prepare convergence, validate current evidence and policy, merge to local main, run post-merge effects, and remove the Story worktree. |

### Story creation and INIT

`story_create` requires a meaningful background unless `fromDraft` applies. The
background has four Markdown sections named `Trigger Event`, `Key Insights`,
`Solution Tradeoffs`, and `Conversational Texture`; each section needs at least
50 characters, the total needs at least 300 characters, and the trigger needs a
concrete Story/finding/checklist/commit/date identifier. Write these sections in
English in this repository. Creation conservatively stops in INIT; it does not
silently skip INIT or create the worktree.

INIT to INIT_CHECK requires independent records from both
`proof-or-stop-review-story-init` and `product-reviewer`; each reviewer persists
its result through `init_check_set`. The gate consumes six facts/artifacts:
`init-check.json`, `scope-boundary.json`, `execution-boundary.json`,
`scope-freeze-check.json`, `scope-extension-proposals.json`, and
`scope-discard-digest.json`. Use the read-only `init_preflight` command to inspect
every prerequisite and its repair hint. The CLI does not automatically invent
missing reviewer evidence. Only when the independent INIT reviewers cannot be
spawned may an authorized operator use the explicit, acknowledged
`init_check_repair` fallback with a substantive fallback reason; otherwise run
both reviewers and repair the underlying scope artifact reported by the gate.

The checklist accepted at creation time is not limited to title and context.
Current fields include `title`, `context`, `relatedDocs`, `userSees`, `excludes`,
affected `files`, and structured `verificationIntent`. The main agent owns the
requirement-facing fields. A verification-intent role may write only its allowed
intent fields.

Before creating another Story, check existing active and draft Stories. The
handler normalizes names, performs duplicate/risk checks, and supports a
deliberate `forceNew` override. Do not reproduce implementation constants for
deduplication windows or keyword lists in policy prose; inspect the current
handler when that behavior matters.

### INIT_CHECK and worktrees

The correct worktree sequence is:

```bash
proof-or-stop story_advance --storyId=B-xxxx --phase=INIT_CHECK
cd .worktrees/B-xxxx
proof-or-stop story_advance --storyId=B-xxxx --phase=PLAN
```

INIT to INIT_CHECK creates the Story branch and worktree. The cwd gate begins
when entering PLAN: PLAN and later lifecycle mutations must run inside that
Story's worktree. Do not repeat the obsolete claim that PLAN to DEV creates the
worktree.

Tracked `.proof-or-stop-codex`, `.claude`, `AGENTS.md`, and `CLAUDE.md` assets
naturally appear in a new git worktree. If an entry asset is missing, first
verify that the file was tracked at the commit from which the worktree was
created.

### Session ownership and write coordination

Story owner leases, takeover UX, and `session_brief` owner rendering are
implemented in 0.3.270. Treat an active foreign lease as read-only. Use
`--takeover` only to recover a stale lease and `--forceTakeover` only as a
deliberate human-authorized seizure of an active lease; neither happens
implicitly because two sessions share a cwd.

Main-repository mutations use the shared main write lock and canonical runtime
lock path. DONE, recovery, gap/audit writes, Story creation, and framework audit
finding writes enforce idempotency under that lock. Use `doctor` for stuck-lock
diagnostics. The design source for ownership and write leases remains
`docs/requirements/decisions/session-ownership-and-write-leases.md`.

### PLAN artifacts and gate

Record a pre-context snapshot with `understanding_set` before freezing the plan.
It must describe the task, observable outcome, facts, constraints, unresolved
unknowns, and the files expected to change. `touchpoints` are material Story
files, not every read-only truth source consulted during planning.

For a nontrivial decision, use `decision_set` with 3-5 principles, 1-5 drivers,
fair alternatives, a chosen option, rationale, and required pre-mortem entries.
The normal form has at least two options with pros and cons. A deliberate
`options: []` single-solution exit is also supported, but its rationale must be
at least 50 characters and explicitly explain why alternatives were excluded or
not enumerated. A single listed option must state in its cons why other
alternatives are invalid. High-risk Stories require at least three complete
pre-mortem scenarios.

Every checklist item should define:

```json
{
  "title": "Observable requirement",
  "context": "Why it matters and the relevant truth source",
  "relatedDocs": ["docs/requirements/example.md#section"],
  "userSees": "Specific terminal or UI output after completion",
  "excludes": ["Explicit non-goal"],
  "files": {
    "modify": ["AGENTS.md"],
    "create": [],
    "test": []
  },
  "verificationIntent": {
    "happy": [],
    "edge": [],
    "adversarial": []
  }
}
```

Use `relatedDocs` as a reminder, not a substitute for a scoped file declaration.
The CLI surfaces related-document reminders during lifecycle work; whether the
document requires a change remains a reasoned decision.

An independent scope-plan reviewer must save signed `scope-check.json` evidence
through `scope_check_save`. The implementation agent must not self-sign it.
Every `openQuestions` entry in that signed scope check must have a substantive
written resolution before `story_review` can pass. The current handler-directed
path is the registered `scope_question_resolve` command; the main agent owns the
conclusion and should cite the controlling decision or checklist source rather
than asking the scope reviewer to self-approve it.

For a new-scope Story whose checklist declares files, initialize the versioned
scope contract from the plan with `scope_contract_init_from_plan`, or create it
explicitly with `scope_contract_set`, then inspect it with
`scope_contract_check`. A missing contract is an advisory, not a blocker, on the
PLAN-to-DEV transition because it may still be created during DEV. It becomes a
hard missing-scope-contract blocker when that new-scope Story enters REVIEW; the
legacy no-file-declaration path remains backward compatible.

Run `story_review` after understanding, decision, checklist, ProofStory, signed
scope-check resolution, scope-contract preparation, and memory-preflight
requirements are ready. PLAN passes when
`blockerCount` is zero. Advisory issues are intentionally possible, so total
issue count is not a zero-only acceptance criterion. A quick-channel Story may
make adversarial review optional only when the CLI says it is eligible; normal
scope, intent, ownership, memory, and policy gates still apply.

```bash
proof-or-stop scope_question_resolve '{"storyId":"B-xxxx","oqId":"OQ-1","resolution":"The approved scope follows the cited decision and excludes unrelated changes.","sourcePointers":["docs/requirements/example.md"]}'
proof-or-stop scope_contract_init_from_plan --storyId=B-xxxx
proof-or-stop scope_contract_check --storyId=B-xxxx --json
```

### DEV and checklist discipline

Work on one item at a time:

```bash
proof-or-stop checklist_update --storyId=B-xxxx --itemId=CHK-001 --status=in_progress
# implement and verify
git add AGENTS.md
git commit -m "docs: update AGENTS guidance"
proof-or-stop checklist_update --storyId=B-xxxx --itemId=CHK-001 --status=done
```

`title`, `context`, and `userSees` freeze at the configured lifecycle boundary;
`verificationIntent` freezes from DEV. A scope change must use the authorized
scope workflow rather than mutating frozen requirements. The direct
`withdrawn` status is refused by `checklist_update`; the scope-shrinkage decision
workflow is the authorized applier.

Record verification with `verification_evidence_add` or its batch form. For an
executable intent, provide an executable-plus-argv command and a selector that
must appear in stdout. The CLI executes the command itself, derives pass/fail,
and issues a tool-owned receipt. The first selector-bearing write immutably pins
the exact command and selector for that intent. A later caller cannot replace
the pin or claim a contradictory result. Raw shell is not accepted. A
`nonMechanicalReason` is an attributable audit record and does not grant
mechanical coverage. Use a bounded timeout override only with the required
recorded reason.

Do not insert caller-authored hashes, timestamps, or fake receipts through raw
checklist evidence. Reload full checklist/story output before evidence-sensitive
conclusions or mutations.

### REVIEW and independent agents

`reviewer_list --json` reports the current Story's opt-in roster. That roster is
computed in real time from shared workflow policy plus Story risk signals,
checklist/decision facts, and documentation touchpoints: concept, quality, and
test-coverage are baseline lanes; behavior and docs are enabled only when their
current triggers apply. Do not hard-code one universal roster or infer lane
eligibility from a role-name prefix.

`reviewer_batch` is a read-only launch plan. It reports which lanes need work and
uses the same policy-computed opt-in path as `reviewer_list`. It prints
host-orchestrator `Agent(...)` instructions; it never launches a reviewer, runs
commands, writes evidence, or advances a phase. Do not pass its refused
side-effect flags.

`dispatch` validates a registered role and its story/item/finding/cluster target
cardinality and prepares the role-specific dispatch surface. `agent_prompt`
prints the canonical package-registry prompt. For migrated review roles it
returns a body-free bootstrap whose first action is `review_run_start`; that
command selects exactly one canonical role body. The host orchestrator, not a
fictional CLI side effect, creates the actual subagent.

A current reviewer flow is:

1. The host launches the requested independent reviewer in the existing Story
   worktree, without creating another isolated worktree.
2. The reviewer calls `review_run_start` with its registered role and current
   Story.
3. The reviewer reads the bounded candidate truth sources, the committed Story
   diff, and lane-specific evidence.
4. The reviewer records a blocking or advisory finding through `finding_add`, or
   records no-blocker evidence through `review_pass_set` using the returned
   `reviewRunId` and a signed read manifest.
5. A later material change, scope change, round change, or invalid read binding
   requires another reviewer run and fresh pass.

Coverage review is a reviewer lane, not a standalone verification command. Its
current canonical role is `proof-or-stop-review-test-coverage`. The main agent,
verification-intent agent, and reviewers are peers with independent authority.
The human is the final arbiter when a substantive disagreement cannot converge
after the configured review-loop limit.

Where the configured policy requires cross-host assurance, first run
`review_escalation_status`. Submit a voluntary local 3x2 host-verdict quorum with
`quorum_submit` only after every required current reviewer pass exists. A valid
standing quorum can survive unrelated main drift when `storyFilesHash` is
unchanged and will reject a duplicate submission. Prompt-envelope freshness is
a separate binding and may still require lane re-attestation. Never fabricate a
second host identity or treat dispatch output as a host receipt.

```bash
proof-or-stop reviewer_list --storyId=B-xxxx --json
```

`Finding.evidenceState` is `suspected`, `verified`, or `disproven`.

| Source | Default | Gate effect |
|---|---|---|
| REVIEW `finding_add` | `verified` | An open critical/high finding blocks REVIEW to TEST unless the current round policy makes it advisory. |
| Explicit suspected reviewer finding | `suspected` | Advisory only and requires an `uncertaintyReason`. |
| `gap_log` | `suspected` | Long-lived framework-audit backlog; it does not block lifecycle gates. |
| Legacy finding without the field | treated as `verified` | Preserves old blocking behavior. |

The REVIEW blocking predicate requires an open finding, critical/high severity,
a blocking evidence state, and no current-round advisory downgrade. Suspected
and disproven findings do not block. Disproven findings need structured
counter-evidence.

Use `gap_log` for a nonblocking framework gap outside the current Story. It
requires category, severity, evidence, and at least one structured source trace
such as source refs, a reproduction command, observed output, or analysis note.
It defaults to suspected; verified is retained only when structured evidence
supports it. `gap_log` does not accept disproven findings. If the audit container
cannot be extended safely, create a traceable draft/backlog through the CLI
rather than editing metadata or bypassing provenance checks.

### Git cleanliness and drift classification

Commit material changes before entering REVIEW, TEST, or DONE. Do not assume all
dirty files mean the same thing: lifecycle checks classify Story metadata,
generated runtime artifacts, and material source/config/doc changes separately.
Use `lifecycle_check`, `review_run_start`, `done_prepare`, and freshness-reader
output as the classification authority. Do not manually bypass `cleanTree`,
erase generated evidence, or self-declare a raw hash difference safe.

- `headHash`-only drift is often metadata or provenance movement, but the CLI
  decides whether re-attestation is sufficient.
- `materialHash` drift with unchanged `storyFilesHash` can be unrelated
  whole-tree drift. In advisory paths it may permit re-attestation instead of a
  full re-review.
- Changed `storyFilesHash` is the strong signal that Story-owned material moved;
  reviewer passes, quorum, verification, and delivery evidence may need rebinding.

Different consumers have different freshness rules. Follow the consumer's
structured result instead of applying a universal shortcut.

### TEST and DONE

The routine TEST path is:

```text
proof-or-stop validate
  -> PASS: persist validation evidence bound to current material
  -> FAIL: persist classified failure/bug evidence and return to DEV
  -> missing or stale intent coverage: fail with an evidence action
```

Use `proof-or-stop validate --story=B-xxxx` in TEST. A passing command alone is
not enough: all required verification intent, bugs, review evidence, ProofStory
artifacts, acceptance topology, delivery/summary checks, and freshness gates must
also pass. If DONE-required policy is configured, run
`proof-or-stop done_required_validate --storyId=B-xxxx`; its evidence must bind
the current HEAD, material hash, and Story-files hash. Without that policy, the
command is advisory and must not be described as full-suite assurance.

Before DONE, run:

```bash
proof-or-stop done_prepare --storyId=B-xxxx --mergeMain --refreshStale --validate
```

`done_prepare` is a conservative readiness assistant. It can merge main, safely
refresh classified stale evidence, validate, and aggregate the next blockers;
it never advances DONE and never mutates version files. Related Story-file drift
still requires the appropriate re-review, re-quorum, re-verification, or
re-delivery work. Advance to DONE only after the prepare result and every
applicable lifecycle gate pass. The Story branch must contain current local main.

DONE merges the Story to local main and performs post-merge effects. When watched
CLI/runtime or capability-contract inputs changed, the DONE effect automatically
patch-bumps and commits all synchronized version points. It skips the bump when
no watched inputs changed, including ordinary documentation-only work. Do not
manually bump a version merely because a Story completed, and do not ask
`done_prepare` to bump it.

Remote publication is a separate human-authorized action. Story branches are
local implementation details and must not be pushed. After a clean, verified
local main exists, a human may grant one exact-SHA, exact-main, short-lived
approval with `proof-or-stop release_approve_push --confirm`, then perform the
manual push.

## Codex, Claude, and subagent assets

Proof-or-Stop adapter prompts are package/tooling conventions, not native Codex
agent-file conventions. Global-thin mode resolves prompts through the package
registry instead of requiring local prompt copies. Native Codex custom agents
use lowercase `.codex/agents` or `~/.codex/agents` TOML assets. Native Codex hooks
use lowercase `.codex/hooks.json` and `.codex/hooks`. Claude Code assets remain
under `.claude`. Do not create a misleading `.proof-or-stop-codex/settings.json`.

After changing adapter manifests, wrappers, hooks, prompt registry, telemetry, or
gate integration, use the current adapter entrypoint shown by local help,
normally `proof-or-stop codex verify`. Diagnose with `proof-or-stop codex doctor`.
Do not use the retired local-wrapper spelling as the primary current instruction.

A modern host-orchestrated reviewer example is conceptual, not a CLI command:

```text
1. proof-or-stop reviewer_batch --storyId=B-xxxx --json
2. Host launches each requested Agent in the existing Story worktree.
3. Reviewer runs proof-or-stop review_run_start for its canonical role.
4. Reviewer records finding_add or review_pass_set with current signed evidence.
```

Legacy `test-intent` and `test-case-reviewer` role names remain compatibility
aliases where the registry accepts them, but new planning uses the
`verification-intent` role and new review uses the current named reviewer lanes.
The retired conversational test-intent mutation commands are unavailable and
must not appear in runnable examples.

## CLI usage

```bash
proof-or-stop <command> --help
proof-or-stop help
proof-or-stop --version
proof-or-stop --root /path/to/project <command> ...
```

Prefer named CLI arguments for evidence-sensitive commands. JSON object input is
also supported by many compatibility entrypoints. On any error, read the exact
command help before changing arguments.

Useful current commands include:

```bash
# Recover context and inspect relevant docs
proof-or-stop session_brief
proof-or-stop aux_doc_list --format=json

# Inspect Story and checklist state
proof-or-stop story_get --storyId=B-xxxx
proof-or-stop checklist_get --storyId=B-xxxx

# Plan review and lifecycle progression
proof-or-stop story_review --storyId=B-xxxx --json
proof-or-stop story_advance --storyId=B-xxxx --phase=DEV

# Evidence and validation
proof-or-stop verification_evidence_add --help
proof-or-stop validate --story=B-xxxx
proof-or-stop done_required_validate --storyId=B-xxxx

# Review orchestration and diagnostics
proof-or-stop reviewer_batch --storyId=B-xxxx --json
proof-or-stop review_escalation_status --storyId=B-xxxx
proof-or-stop codex doctor
proof-or-stop doctor
```

### Preserved current command examples

The following examples preserve the still-current commands from the previous
guide. `tests/AGENTS.verify.mjs` binds every complete invocation to a case ledger:
safe read-only examples run with `B-d854` and the current repository root,
mutating examples are validated against the built `MAIN_TOOLS` Zod schema without
being executed against this Story, and explicitly marked conceptual placeholders
are syntax-checked but not executed.

```bash
# Safe read-only repository examples
proof-or-stop aux_detail --files='["core/machine.ts"]'
proof-or-stop aux_scan --format=json
proof-or-stop aux_sync --direction=status
proof-or-stop aux_trace --format=json
proof-or-stop decision_get --storyId=B-xxxx
proof-or-stop understanding_get --storyId=B-xxxx

# Conceptual legacy-case placeholder: replace example-case with a real case name
proof-or-stop aux_diagnose --caseName=example-case

# Schema-validated PLAN mutations; do not execute them against an existing Story
proof-or-stop understanding_set '{"storyId":"B-xxxx","task":"Describe the requested change","outcome":"State the observable result","facts":["Repository-local behavior is authoritative"],"constraints":["Stay within the approved scope"],"unknowns":[],"touchpoints":["AGENTS.md"]}'
proof-or-stop decision_set '{"storyId":"B-xxxx","principles":["Preserve user value","Prefer mechanical evidence","Keep scope bounded"],"drivers":["Current runtime behavior"],"options":[{"name":"A","pros":["Focused"],"cons":["Requires precise evidence"]},{"name":"B","pros":["Broader coverage"],"cons":["Expands scope"]}],"chosen":"A","rationale":"Option A satisfies the requested outcome without unrelated expansion."}'

# Schema-validated Story/backlog mutations; examples are never run by the verifier
proof-or-stop story_create '{"name":"example-story","title":"Example Story","description":"Deliver a concrete observable repository result.","type":"feature","priority":"medium","background":"## Trigger Event\nOn 2026-09-02, B-example identified a concrete need requiring a reviewed Story.\n\n## Key Insights\nThe result has observable behavior, explicit scope, and verification needs that should be frozen before implementation.\n\n## Solution Tradeoffs\nKeep the Story focused on requested behavior and defer unrelated medium or low issues through the bounded policy.\n\n## Conversational Texture\nThe user expects evidence, concise status, and a product-visible result, so acceptance must preserve those expectations.","checklist":[{"title":"Deliver the observable result","context":"Bind implementation to the stated need"}]}'
proof-or-stop gap_log '{"category":"missing","severity":"medium","evidence":"Documented nonblocking framework gap with a reproducible source trace.","sourceRefs":["packages/main/src/core/machine.ts:1"]}'

# Legacy fixture maintenance; preview writes and replace conceptual identifiers
proof-or-stop fixture_batch_add '{"fixturePath":"example","cases":[{"name":"example case","run_type":"cli","file":"core/machine","execute":"return true","expect":true}],"storyId":"B-xxxx","dryRun":true}'
proof-or-stop test_story --storyId=B-xxxx
proof-or-stop test_fixture --fixtureId=legacy-maintenance-fixture-id
```

`aux_detail` inspects signatures and imports for files relative to `scanRoot`.
`aux_scan` checks source task annotations. `aux_sync` maintains annotation-derived
metadata, and `status` is its read-only direction. `aux_trace` reports business
paths, impact edges, and coverage gaps. `aux_diagnose` compares legacy-case trace
and git evidence when a real case name is supplied. The `*_get` commands are
read-only snapshots; their paired setters persist structured PLAN facts through
the CLI. `gap_log` creates attributable deferred audit work. The fixture/test
commands remain compatibility-only maintenance entrypoints, not the default
verification path for a new Story.

### Audit and verification

The durable claim-by-claim audit is
`docs/audits/AGENTS-current-version-audit.md`. Re-run the baseline RED and final
GREEN checks with:

```bash
node tests/AGENTS.verify.mjs --baseline
node tests/AGENTS.verify.mjs --final
```

The verifier also checks complete command examples, structure and technical
tokens, normative lifecycle semantics with negative mutations, runtime
path/version drift, Unicode purity, and the managed template block.

## Legacy fixture compatibility

Fixture commands and fixture-only validation are not the default flow for a new
Story. Use them only to maintain old Stories, migrate fixture data, or diagnose a
legacy runner. New Stories specify `verificationIntent`, earn tool-owned
`verificationEvidence`, and use routine validation.

A legacy fixture case may include `name`, `run_type`, `file`, `execute`,
`expect` or mutually exclusive `throws`, an optional `intentRef`, and generated
chain identifiers `_id`, `prevCaseId`, and `nextCaseId`. The source `file` is
relative to `scanRoot` and omits the extension. The runner exposes `$handlers`,
`$root`, `$ctx`, and `$file`. Chained cases share `$ctx`, execute in topology
order, and clean up at the chain tail. Use `await import($file)` in the ESM
environment. Assertions must test specific behavior, never a convenient
unconditional result or broad success pattern.

The workspace-destructive full legacy runner is `test_auto`. Preview it with
`--dryRun`; every real run requires explicit `--confirm`. Commit valuable work
first, inspect the plan, and use it only for legacy fixture maintenance. Current
Story validation remains `validate`.

## Fail-fast policy for caught errors

When changing CLI framework code, every new `try ... catch` must use one of four
explicit classes. Bare silent catches are forbidden.

| Class | Appropriate use | Required behavior |
|---|---|---|
| DEBUG | Logging or progress reporting fails | Silence is allowed; add a `debug:` comment when useful. |
| PROBE | An optional file, branch, config, or capability probe misses | Return `null` or a documented default. |
| PERSIST | A log or pending-state persistence operation fails | Call `reportHealthIssue('persist:...', error, context)`. |
| MUTATION | Git mutation, file write, or spawned operation fails | Throw a contextual error to the caller. |

`reportHealthIssue` is defined in `packages/main/src/core/health.ts`, appends to
the CLI health log, and must not throw. Before silencing a caught error, ask how a
user will discover the failure ten minutes later. If there is no answer, leave a
health trace or fail visibly.
