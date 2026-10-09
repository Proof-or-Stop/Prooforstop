# AGENTS.md

<!-- proof-or-stop:start -->
## Proof-or-Stop

- `.proof-or-stop/Proof-or-Stop.md` is the host-neutral Proof-or-Stop guide; this file keeps only Codex / AGENTS additions.
- At the start of a new session, or when resuming interrupted work, run `proof-or-stop session_brief`.
- Before acting, run `proof-or-stop aux_doc_list` to inspect relevant docs.
- Use the global `proof-or-stop` CLI for Story / checklist / fixture / bug operations. Do not edit story/fixture JSON directly.
- Parallel Proof-or-Stop work is local-only: use local git worktrees/local branches, finish by merging to the resolved local integration branch and cleaning the worktree. Remote publish is default-denied; a human must run `proof-or-stop release_approve_push --confirm` for a short-lived one-shot approval before pushing that exact branch and SHA.
- Codex adapter verification uses the global CLI: `proof-or-stop codex verify`. For diagnostics, run `proof-or-stop codex doctor`.
- Run `proof-or-stop check` to check Proof-or-Stop managed asset/template drift; after review, use `proof-or-stop check --apply` to sync safe items.

<!-- proof-or-stop:end -->

## Repository-specific operating guide

For CHANGELOG.md, prepend only 3-5 concise bullets describing final delivered
changes. Link detailed investigation and audit records instead of copying them.
Read only the current entry or relevant Git diff when updating it; consult older
Git history only for a specific historical question. Do not regenerate the file.

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
- **Bounded current-Story repair**: the Story Owner must repair a verified applicable Finding in the current Story when it is critical or high, was introduced or worsened by the current Story, directly blocks acceptance, a verification intent, the core user result, or a public compatibility promise, has known or uncertain protected-surface impact, or would make lifecycle gate evidence or gate truth misleading. Severity and applicability are separate axes: severity alone does not decide scope. Every final applicable assessment binds exactly one `dispositionPlan`: `repair_current` or `defer_with_proof`; only an otherwise eligible verified applicable low or medium Finding may use the latter.
- **Evidence-backed routing, otherwise fail closed**: route a defect only when structured evidence proves that it is not applicable to the current Story, names a traceable owner or route, and proves that it does not block the current gate. Critical or high Findings must never be left without a traceable owner. `not_reproduced_under_current_witness` requires fresh target-bound negative command and runtime receipts, signed command-policy and witness bindings, and a live receipted owner or route; an old DONE result is insufficient. Preserve reproduction evidence, impact, and the original Finding. If a defect would otherwise block and its applicability is unknown, keep it in the current Story, including a medium Finding in a policy round where medium is blocking. In enforce mode, `REQUIRED_ASSESSMENT_INVALID = { missing, re_attestation_required, stale, unsigned, tampered, mismatched, incomplete, expired, unknown }` places a verified open high or critical Finding in a transient assessment-integrity floor before severity, round, and advisory policy; it does not itself prove applicability or require current-Story repair. Fresh strong non-applicable proof releases that floor, fresh applicable proof converts high or critical to mandatory repair, and weak or invalid proof remains blocked. Invalid claimed deferral lineage is an independent first floor. Only a fresh signed superseding `pre_existing_unaffected`, `out_of_scope`, or `duplicate` verdict satisfying its independent strong proof contract, a signed `disproven` truth transition with current counter-evidence, or complete repair closure releases that lineage floor. Complete repair closure is a distinct release path and does not weaken the exact allowlist for non-repair supersession. `not_reproduced_under_current_witness` never releases claimed-deferral lineage or mandatory repair. Invalid or exhausted deferral lineage also creates a downstream mandatory-repair classification; once that obligation is active, only a fresh signed `MandatoryRepairClassification(state='closure_proven')` clears it, so lineage-floor superseding proof does not clear the whole block. These machine-owned floors do not authorize Story-scope expansion. Never expand the Story merely to make the repository globally green.
- **Dynamic Finding activation boundary**: the official commands are `finding_applicability_assess`, `finding_applicability_batch`, `finding_deferral_record`, `finding_mandatory_repair_close`, `finding_triage`, and `finding_rollout_scorecard`. `observe` remains the default compatibility result, `warn` compares without changing gates, `enforce` activates signed assessment/disposition authority, and `killSwitch=true` restores the legacy predicate. Only official handlers may sign assessment, route binding, disposition, freshness, lineage, and manifest facts. `finding_dismiss`, gaps, backlog entries, and prompt prose remain compatibility accounting and prove neither applicability, repair, resolution, nor deferral; never use them to erase or rewrite the original observation.

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

## Explicit Lab maintenance exception

When the user explicitly requests a Lab for a bounded system bug or performance
regression, use the repository-local `npm run lab:worktree -- ...` commands and
[the Lab maintenance guide](docs/lab-maintenance.md). This is an authorized local
maintenance exception to Story lifecycle administration, not a replacement for
normal Stories. Create/sync from local main, record target RED, commit the minimal
repair, and record GREEN. Only an explicit user integration request authorizes
`finish --confirm`. Finish follows shared version rules and records changes;
remove the worktree and merged branch only after verified local integration.
Failures retain the workspace. Never label Lab records as formal Story DONE or
signed product-release evidence, disable hooks, or push automatically.

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
| DONE | CLI | Prepare convergence, validate current evidence and policy, merge to the resolved local integration branch, run post-merge effects, and remove the Story worktree. |

The `proof-or-stop-residue` REVIEW-to-TEST preflight is repository maintenance
for the Proof-or-Stop source tree, not a requirement imposed on consumer
repositories. Consumers skip it by default. A repository opts in with
`reviewPreflight.proofOrStopResidue: "enforce"`; in that mode malformed project
JSON or `reviewPreflight` policy, a missing
`scripts/verify-proof-or-stop-residue.mjs`, a timeout, or a nonzero detector
result blocks the transition. An explicit `"off"` also skips the preflight.

### Story creation and INIT

`story_create` requires a meaningful background unless `fromDraft` applies. The
background has four Markdown sections named `Trigger Event`, `Key Insights`,
`Solution Tradeoffs`, and `Conversational Texture`; each section needs at least
50 characters, the total needs at least 300 characters, and the trigger needs a
concrete Story/finding/checklist/commit/date identifier. Write these sections in
English in this repository. Creation conservatively stops in INIT; it does not
silently skip INIT or create the worktree.

Pass the user's request verbatim as `request` (or `requestFile`); ask the user
for their exact words rather than paraphrasing. It is stored as the Story's
`request.md` (bounded to 16 KB with an explicit truncation marker; sha256 bound
in `request.json`; included in the INIT_CHECK signature). A wrapper can stage it
before the Story exists with `story_request_set` without `storyId`; the next
`story_create` consumes it once. Replacing it, or recording it after INIT, goes
through `story_request_set` with an `amendmentReason`, and only through PLAN.
`story_create` names every backticked request literal (example, listed variant,
exact message) that no checklist title, `userSees` or `verificationIntent`
states yet, with one exact `checklist_update` per item to record them in
`userSees`: `userSees` is editable in INIT and PLAN (frozen from DEV), so the
literals go on the same Story; never recreate it. Intake intents follow the
PLAN intent-metadata rule: every `verificationIntent` row carries `scope`,
`expectation` and `requirementSource`, else `story_create REFUSED, nothing was
written ... [verification_intent_metadata_required]` names each row and its
missing field (the same refusal `checklist_update` and `plan_acceptance_*` print).
Intake intents also follow the derivation rule (below): an example whose
expected value the request does not quote carries a `derivation`, else
`[intent_derivation_required]` (old-PoS run 23 pinned its wrong value here).

INIT to INIT_CHECK requires independent records from both
`proof-or-stop-review-story-init` and `proof-or-stop-product-reviewer`; each reviewer persists
its result through `init_check_set`. Launch each through `host_run` with
`managedDispatch:true`; PoS derives and delivers the canonical prompt, returns a
nonempty run id, and binds the reviewer write to that live provider process. A
caller-supplied `agentId` does not create independent evidence. The gate consumes:
`init-check.json`, `scope-boundary.json`, `execution-boundary.json`,
`scope-freeze-check.json`, `scope-extension-proposals.json`, and
`scope-discard-digest.json`. Use the read-only `init_preflight` command to inspect
every prerequisite and its repair hint. The CLI does not automatically invent
missing reviewer evidence. Only when the independent INIT reviewers cannot be
launched may an authorized operator use the explicit, acknowledged
`init_check_repair` fallback with a substantive fallback reason; otherwise run
both reviewers and repair the underlying scope artifact reported by the gate.

The checklist accepted at creation time is not limited to title and context.
Current fields include `title`, `context`, `relatedDocs`, `userSees`, `excludes`,
affected `files`, and structured `verificationIntent`. The main agent owns the
requirement-facing fields. A verification-intent role may write only its allowed
intent fields.

Write exact user-visible messages in `userSees` and intent `desc` as quoted or
backticked literals (or as output lines in a fenced block). `dispatch` copies
them verbatim, with the pinned output selectors of cli/browser/manual intents,
into an "Exact required output — must match byte-for-byte" section of the
implementer prompt and of the finding-repair prompt for items the finding names
(`CHK-NNN`) or whose files it touches. It copies literals only and never
rewrites or adds a string; the section is capped at 24 entries / 4000
characters and states how many were omitted.

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
files, not every read-only truth source consulted during planning. They may be
free text ("ast/ast.go IndexExpression and String", a comma list): candidate
routing protects only the leading path token of a part that resolves to a real
file (run 17); prose is a ranking seed and never a missing protected source, so
a project without a requirements corpus routes with the automatic full scan.

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
  "title": "做什么（一句话）",
  "context": "根因/参考方案",
  "relatedDocs": ["requirements/foo.md", "AGENTS.md#section"]
}
```

For verification intent, distinguish Story acceptance from repository health.
Run or inspect the pre-change baseline before freezing a repository-wide check.
Focused changed behavior is normally an absolute-pass `must`. A repository-wide
suite that is already red uses an explicit `no_new_regressions` expectation as
a `should` repository-health input for reviewer comparison. Only a user, task, or official-verifier
requirement may make repository-wide absolute success a `must`.

Pin every executable (`logic`/`cli`/`browser`) `must`/`should` intent in PLAN:
`"verification":{"command":"go test -v ./pkg -run ^TestName$","selector":"--- PASS: TestName"}`
(executable and argv, no shell; the test may not exist yet, the implementer prompt
requires exactly these names). `story_review` blocks an unpinned one
(`missing_verification_pin`). With pins, DEV records every receipt with one
`verification_run --pending`; without them the owner must judge, intent by
intent, which test proves it (run 16: 32 hand-authored receipts, two wrong
framework-proposed binds).

The scope-plan reviewer verdict (`scope-check.json`) is required on PLAN→DEV
whenever the checklist is non-empty and any of: an `understanding` snapshot
exists; the policy declares `plan.requireUnderstanding: 'always'` (balanced,
strict); it declares `'high_risk'` and the Story is high risk; or a `request.md`
exists under a policy other than `'never'` (core/plan-scope-check-requirement.ts).
It no longer depends on `understanding_set` (run 16: the owner skipped the
advisory understanding, so the reviewer never ran). `story_review` reports
`missing_scope_check`, the DEV-entry gate itself refuses with
`[missing_scope_check]` and one `Next:` (the managed scope-plan reviewer
`host_run`) even after a clean `story_review`. Exception (v4.1 N8,
core/scope-plan-deferral.ts): while a managed scope-plan run launched in PLAN
is still live, no verdict exists and the reviewer has nothing to pin-audit
(no intent pins an expected value request.md does not quote and no request
sentence says "same ... semantics as" / "works like" / "consistent with";
otherwise DEV entry waits for that run's verdict, so a pin-audit gap lands
before any item is implemented against the pin), story_review reports the
advisory `scope_check_pending` and the DEV-entry gate admits DEV, so the first
implementer runs beside the reviewer; that run saves its verdict in DEV, and
DEV→REVIEW then requires it (present, signed, delivered, no gap:
`[scope_check_pending]` / `[scope_gap]`); a gap found after DEV started sends
the Story back to PLAN. `next` in PLAN first returns the
deterministic PLAN blockers as one `plan_authoring` batch (run 19: one exact
`checklist_update` per item for missing intent lanes, unpinned intents, a
missing `userSees`, examples without a valid `derivation`, and request literals
no item states or excludes), and only
when those are clear launches the reviewer, so it runs once on the final
checklist (or waits on the run in flight). A verdict that must be rerun (gaps
open and the checklist changed since it, or a stale review round) is relaunched
by `next` too, as a framework step when the selection is bound and the last
run delivered that verdict. light and the express channel are unchanged.

- title 描述「做什么」，不描述「怎么做」
- context 给执行 agent 提供决策上下文
- **主 agent 只写 title + context + relatedDocs，不写旧 testIntent；当前验收意图是 `verificationIntent`**
- relatedDocs 是关联的文档路径数组（可带 `#锚点` 给人看，不参与机器匹配），用于三次提醒避免代码改了文档忘改

### relatedDocs 三次提醒

关联文档在三个时机被**软提醒**（不阻塞）：

1. **PLAN→DEV 推进时**：`story_advance DEV` hint 列出 story 全部 relatedDocs 去重清单
2. **`checklist_update` 标 done 时**：列出该 item 的关联文档清单
3. **DONE 推进时**：列出 `git diff main...HEAD` 中未出现的关联文档清单

是否更新文档由 agent 自己判断，没有 ack 机制也没有门禁。

### English authoring and legacy relatedDocs recovery

English-artifact gates scan all recursively scanned string leaves of story metadata. The listed examples (`excludes`, `files`, `reason`, `verificationEvidence`) are non-exhaustive. Recover leftover CJK in relatedDocs and other leaves before REVIEW→TEST. Captured program output is not authored text and is exempt (verification `outputTail` / `stdout` / `stderr` / `output` / `observedOutput`, the summary's observed `actualTranscript`; old-PoS runs 20 and 25: `go test -v` of the task's own Unicode tests). Never edit source or tests to satisfy this gate: each refusal names the framework command that rewrites the authored text (`checklist_update`, `summary_set`, `background_set`, ...) and the code points (`U+XXXX`) to quote a required non-English literal by.

Reviewer latest-run binding is kind-aware: a fresh PASS is accepted on any current-round material-fresh run; an open FINDING still requires the latest run on the lane.

### Pre-context Intake（understanding.json）

PLAN 阶段开拆 checklist 之前，主 agent 应该先调 `understanding_set` 落一份理解快照：

| 字段 | 含义 |
|---|---|
| `task` | 一句话描述要解决的问题（≥ 5 字符）|
| `outcome` | 完成后能观察到什么变化（≥ 5 字符）|
| `facts` | 已知事实（来自真相源、已有代码、上下文）|
| `constraints` | 必须遵守的规则（性能/兼容性/规范）|
| `unknowns` | 拆 checklist 时还没想清楚的问题 |
| `touchpoints` | 可能受影响的代码文件列表 |

**第一版软引入**：未填只 hint 提醒，不阻塞。但 `story_review` 会把"missing understanding / unresolved unknowns / empty touchpoints"作为 advisory 列出，reviewer 也能看到 prompt 里的完整 understanding。`unknowns` 非空时建议拆 checklist 前先调研。

### 高风险关键词检测

`story_create` 自动扫 description + checklist titles 命中以下分类时自动 elevate priority 到 high 并写 `riskSignals`：

- 安全/凭证（auth/password/token/credential）
- 数据迁移/破坏性（migration/destructive/drop table）
- 状态机/门禁（machine.ts/state machine/guard/gate）
- test runner 框架（fixture runner / legacy test_auto / cleanupFixtureDir）
- git 破坏性操作（git restore/reset/clean/push --force）
- 生产环境/紧急（production/incident/hotfix/p0/p1）
- 合规/隐私（PII/GDPR/compliance）
- 破坏性 API 变更（public api/api break/breaking change）

命中时 `story_review` 会强制要求 decision.json + ≥ 3 preMortem 场景（缺则 blocker）。

### 重复 story 检测（dedup）

`story_create` 在新建前对已有 story 做重复检测，防止跨 session / 多 agent 并发跑同一 backlog 时产生语义重复 story（B-6812 G2）：

- **归一化 name idempotency**：用 `normalizeName(name)`（lowercase + trim + 下划线/空格/连续连字符归一为单连字符 + 去首尾连字符）比较，而非 exact-name。`"Fix Login"` / `"fix-login"` / `"  FIX__LOGIN  "` 视为同一 story → 返回已有 storyId 并复用，不新建。**仅当 `normalizeName(name)` 非空才参与匹配**——旧数据多 name 为空串/全分隔符，归一化后为 `""`，绝不会让两个空 normalized name 互相误判成同一个 story。
- **keyword 完全重叠 block**：遍历 active non-terminal story（phase ∉ DONE/DISCARDED），算 keyword 重叠率；当新 story 的全部 keyword 都被某已有 story 覆盖（`ratio === 1`）且共同 keyword ≥ 2 个时，`story_create` 抛错 `❌ 疑似重复 story B-xxxx（keyword 完全重叠），确认要新建请加 forceNew:true` 并以非零 exit code 退出。DONE/DISCARDED story 的 keyword 完全重叠仅 warn（关键词查重段），不 block。
- **`forceNew: true` override**：传 `forceNew:true` 整体绕过归一化 name idempotency 与 keyword 完全重叠 block，强制新建。确认确实要新建语义相近的 story 时使用。

#### 重复 / 并发警告走 stderr（B-6812 G3/G4）

`story_create` 的 advisory 文本（keyword 重叠 `dupWarning`、高风险 `riskHint`、最近并发 story 提示）全部走 `process.stderr.write`，**不**拼进 stdout 返回值。stdout 只保留创建结论（`Story B-xxxx created ...`）+ 非 advisory 引导（INIT reviewer 提示、non-git 提示）。原因：`proof-or-stop story_create | tail` 这类管道只消费 stdout，advisory 拼进 stdout 会被 tail 静默吃掉；走 stderr 后即使被管道也仍然可见。

- **最近并发 story 摊开（G4）**：每次成功创建后扫 `listStoryIds()`，筛 `createdAt` 在过去 30 分钟内且 phase ∉ DONE/DISCARDED 的**其它** story，写 stderr：`⚠ 最近 30 分钟内还创建了 N 个 story：B-xxxx [phase] title`。无并发 story 时不输出（不误报）。30 分钟为硬编码常量（`RECENT_CONCURRENT_WINDOW_MS`），非配置项。
- 终态 story（DONE/DISCARDED）、`createdAt` 缺失或非法 ISO 的 story 都被跳过，不计入并发提示也不会让创建崩溃。

### 结构化决策（decision.json）

PLAN 阶段为非 trivial story 落 `decision_set`。schema：

```json
{
  "principles": ["..", "..", ".."],
  "drivers": ["..", "..", ".."],
  "options": [
    {"name": "A: ...", "pros": ["..."], "cons": ["..."]},
    {"name": "B: ...", "pros": ["..."], "cons": ["..."]}
  ],
  "chosen": "A: ...",
  "rationale": "选 A 因为 ...",
  "preMortem": [
    {"scenario": "..", "trigger": "..", "consequence": "..", "mitigation": ".."}
  ]
}
```

校验规则（hard）：
- `principles`: 3-5 条
- `drivers`: 1-5 条
- `options`: ≥ 2 个；只有 1 个时 cons 必须写明"为什么其他备选被排除"
- 每个 option 必须有 pros + cons（不能只列好处）
- `chosen` 必须 ∈ options
- `rationale` ≥ 10 字符
- 高风险 story（priority=high/critical 或 riskSignals 非空）：`preMortem` 必须 ≥ 3 条，每条 4 个字段全填

非高风险 story 的 decision 是可选的（`story_review` 只 advisory）。

### Legacy testIntent（兼容背景）

本节保留旧 story / 旧 fixture 兼容语义，不能作为新 story 的标准流程。当前流程使用 checklist item 上的 `verificationIntent`，DEV/REVIEW/TEST 用 `verificationEvidence` 证明，TEST 跑 `proof-or-stop validate`。

每条 testIntent 从纯字符串改为带类型的对象：

```json
{
  "testIntent": {
    "happy": [
      { "desc": "正常操作 → 预期结果", "type": "cli_blackbox" }
    ],
    "edge": [
      { "desc": "边界条件下的表现", "type": "cli_blackbox" }
    ],
    "adversarial": [
      { "desc": "异常操作下的表现", "type": "browser_blackbox" }
    ]
  }
}
```

Use `relatedDocs` as a reminder, not a substitute for a scoped file declaration.
The CLI surfaces related-document reminders during lifecycle work; whether the
document requires a change remains a reasoned decision.

An independent scope-plan reviewer must save signed `scope-check.json` evidence
through `scope_check_save` (required as described in the checklist section
above; the PLAN→DEV gate refuses `[missing_scope_check]` without it, unless
its managed run is still live, in which case DEV→REVIEW requires it). The
implementation agent must not self-sign it.
When the Story has a `request.md`, the scope-plan dispatch prompt carries it
inline: every normative sentence, every "for example" and every enumerated
variant is its own feature row, covered only when a `userSees` or
`verificationIntent` states that exact variant or output; unmapped rows are
gaps, and a mechanical pre-check lists request literals no checklist item
states. The prompt also lists what is already covered and never a gap (run
17): delivery-workflow sentences the Proof-or-Stop workflow guarantees (working
on a branch from main, committing everything, merging back; `covered_by:
"proof-or-stop-workflow"`) and restriction-only constraints the Story already
acknowledges in its INIT `scopeBoundary.excluded` / `understanding.constraints`
(`covered_by: "init-scope"`); every behavior, output, error, example and
compatibility promise stays strict. The verification-intent author is pointed at `request.md` and writes one
exact-output intent per example and listed variant. The INIT product reviewer
gets only its path.

Pinned values the request does not quote carry a derivation (old-PoS run 23 at
its source, core/intent-derivation.ts). When the Story has a `request.md`, an
intent row whose `desc` is an input -> output example (separator `->`, `→`,
`=>`, `==`, else returns/yields/gives/prints/...) with a concrete expected
value (backticked literals, else quoted strings, `[...]`/`{...}` groups,
numbers) that is not quoted verbatim from `request.md` (case-sensitive,
whitespace aside) must carry `"derivation":{"requestQuote":"<verbatim
request.md sentence>","computation":"<steps to the pinned value>"}`:
`requestQuote` occurs in `request.md` (case, whitespace and backticks aside,
`...` may elide, at least 12 characters) and `computation` states the pinned
value. `story_create`, `checklist_add`, `checklist_update` and
`plan_acceptance_prepare/apply` refuse a missing or invalid one
(`[intent_derivation_required]`, nothing written); a quoted example needs none.
A row stored without one (request recorded or amended later) is a
`missing_intent_derivation` blocker, and `next`'s `plan_authoring` batch gives
the exact `checklist_update` with a derivation placeholder. Whether the
derivation is right is the scope-plan reviewer's pin audit: its prompt lists
every such row (ref, desc, requestQuote, computation) and requires it to
recompute each value from the request; a mismatch is a blocking `pin-audit
<ref>` gap. Its same-semantics rule: when a request sentence makes one behaviour
follow another ("same ... semantics as X"), at least one intent must use an
input on which the plausible readings differ (an asymmetric example), else an
`asymmetric-example` gap. The `story_review` message of both gaps names the
intent fix (`checklist_update` with the corrected row and its derivation), then
the reviewer rerun. Prompt cost: about 1.1 KB plus about 270 B per listed row. Because the scope-plan prompt has pin-audit rows (or a same-semantics sentence) to judge, its verdict is not deferred past DEV entry (N8 `scopeVerdictDeferral` = held): DEV entry waits for it, so the gap lands before any item is implemented against the pin.

The request outranks intents (old-PoS run 23, core/request-authority.ts).
Intents, `userSees`, context and pinned tests are owner-authored and can be
wrong. Every REVIEW lane and the inventory critic get `request.md` inline with
the shared rubric: re-derive expected values for behaviors the request
specifies; a pinned intent or test that contradicts the request is a finding
(at least medium), never "the checklist is the requirement source"; the critic
may not file such a contradiction as a note or "limitation". The implementer and
the finding-repair worker end their result with a mandatory `[intent-conflict]`
section (`none`, or `<intentRef> | request: "<sentence>" | request implies:
<value> | intent pins: <value>`); a prose "deliberate choice" is not accepted.
`next` blocks on a declared conflict: `story_advance --phase=PLAN` (intents are
frozen in DEV), then `checklist_update` with the revised `verificationIntent`, a
`reason` and `status: pending`. A finding repair that changes how an input is
handled keeps base behavior for the input variants the request did not change.
The DEV implementer prompt carries the same check before REVIEW as a probe
matrix (old-PoS runs 24-29): operand positions x value classes (omitted,
explicit null, 0, negative, out of range, wrong type, empty receiver, multibyte,
aliased value) x operations (read, write, stringify, error path, neighbouring
receiver types), run on the Story base and on the change, reported as a
`[probes]` line in the implementer's final result.

PLAN coverage matrix (old-PoS runs 24-29, core/plan-coverage-matrix.ts). With a
recorded `request.md`, `story_review` (PLAN) reports a `missing_coverage_row`
blocker, and `next`'s pre-scope `plan_authoring` adds a placeholder intent, for
each row the request patterns demand that no intent states: the write mirror of
every read-side value class when a request sentence makes writes follow reads;
each omission pattern of an n-part syntax whose omitted forms the request
lists; each enumerated member (operand position, receiver, form) x the value
class its sentence states, plus explicit null for an omittable non-numeric
operand. Each gap names the triggering request sentences; an `excludes` entry
naming the row's key excludes it. The scope-plan prompt carries the judgment
form of the same three checks.
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
issue count is not a zero-only acceptance criterion.

Every exclusion a PLAN gate asks for is recorded in PLAN, never by reopening
INIT (the INIT scope boundary stays INIT-only and is not an input of the gate
checks; the scope-plan reviewer prompt only lists its exclusions as
already-acknowledged constraints). A `touchpoint_uncovered` path is satisfied by an item's
`files.modify/create/test`, or, for reference-only material, by an item
`excludes` entry that names the exact path and gives a reason (a bare path
does not count): `proof-or-stop checklist_update --storyId=B-xxxx
--itemId=CHK-001 --excludes='[...current, "docs/x.md: reference only, not
changed"]'`. A `scope_gap` is the signed scope-plan reviewer verdict and
story_review never re-judges it: cover the point in a checklist item, or append
an `excludes` entry naming it with the reason (reference-only material or an
acknowledged "do not ..." constraint; a `pin-audit` / `asymmetric-example` gap
is fixed in the intent row itself), then rerun the scope-plan reviewer with
the managed `host_run` command the hint prints. When the checklist changed after
the verdict (`scope-check.json` `checklistDigest`, guidance only), the hint names
only the rerun, and `next` returns that relaunch itself. The brief
`story_review` view never truncates an issue's `Next` remedy. A quick-channel Story may
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

### REVIEW → DONE is framework-driven: `proof-or-stop next --storyId=<id>`

After DEV (every checklist item done and committed), run `proof-or-stop next --storyId=<id>` from the Story worktree and execute the one command it prints, then ask again. It is read-only, decides each step from the real gate predicates (evidence-chain check, REVIEW verdict, reviewer batch plan, inventory status, PRE_CERT admit predicates, certification status, DONE oracle), and labels it `framework` (mechanical, including a managed launch fully bound to this Story's own earlier host/model/effort and the wait on it; `proof-or-stop next --storyId=<id> --run` executes them through the normal CLI, all waits of one call within one 285 s budget, and prints `paused:` to rerun it), `agent` (code, a first or replacement managed launch, authored text or a host verdict; `<...>` placeholders name the fields to author, each with a one-line description, and a `batch` step lists several authoring commands to run in one turn, e.g. TEST's finish decision + summary) or `human`. Prefer `next --run`; no command `next` prints needs `--help`. It covers REVIEW entry, every review round (prepare → launch all prepared lanes → wait → import), the inventory epoch and critic, remediation back to DEV (repair → evidence refresh → `finding_resolve`), the review reopen back to DEV when material was committed during REVIEW with no open finding (old-PoS run 25: one framework step `review_reopen`, then DEV refreshes the evidence and REVIEW starts a fresh round; do not edit code or tests during REVIEW, a needed change goes through it), PRE_CERT (fast check → `certification_window_begin` → routine `validate`), TEST (live smoke, delivery reviewer, finish decision + summary as one step, review assurance floor; on a single host that is one framework step, `quorum_submit` with `singleHost:true`) and DONE. It also drives INIT from `story_create` on (lab `owner-init-and-worker-prompt`): with no unfinished Story, `proof-or-stop next` prints the one complete `story_create` template (boundaries inline, every placeholder hinted); then `next --storyId=<id> --run` records the scope freeze check, launches both managed INIT reviewers in parallel (their first launch uses the Story's selection, else the qualified managed-reviewer default), waits, and runs `story_advance` INIT_CHECK and PLAN; called outside the Story worktree it runs there and prints the `cd`. In PLAN it names the DEV entry too: the dev-memory acknowledgement, the deterministic PLAN authoring batch, the scope-plan reviewer launch (or relaunch of a stale verdict), then `story_advance --phase=DEV` or the DEV guard's own Next. Its commands accept trailing flags such as `--json`. Do not reorder these steps or probe `story_advance` ahead of it. Decision table: `docs/CLI.md` ("`next --storyId`").

### REVIEW and independent agents

`reviewer_list --json` reports the current Story's opt-in roster. That roster is
computed in real time from shared workflow policy plus Story risk signals,
checklist/decision facts, and documentation touchpoints: concept, quality, and
test-coverage are baseline lanes; behavior and docs are enabled only when their
current triggers apply (behavior: a risk-signal category whose `/`-separated,
case-insensitive tokens include `state machine`, `guard` or `gate`, such as the
`State Machine/Gate` category `story_create` detects). Do not hard-code one universal roster or infer lane
eligibility from a role-name prefix.

`reviewer_batch` is a read-only launch plan. It reports which lanes need work and
uses the same policy-computed opt-in path as `reviewer_list`. It prints
host-orchestrator `Agent(...)` instructions; it never launches a reviewer, runs
commands, writes evidence, or advances a phase. In JSON mode, issue every
`executionPlan.launchableLanes` launchInstruction before any wait, retain one
nonempty distinct child id per lane, then make one host wait call with the full
child-id set. When that set is empty, do not call wait. Do not pass its refused
side-effect flags. The compact `executionPlan` control header is serialized
before verbose `lanes`; inspect it first and never infer scheduling from a
truncated lane-detail preview.

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
current canonical role is `proof-or-stop-review-test-coverage`. It reports product
coverage gaps only (including a test whose asserted value contradicts the requirement); stale or missing receipts, unpinned intents and tests bound
to no intent are framework-owned evidence-chain items checked before REVIEW
(`pre_review_check_read`), reclassified as framework actions if a reviewer
reports them (`category: "evidence_chain"`). The main agent,
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
| REVIEW `finding_add` | `verified` | An open critical/high/medium finding blocks REVIEW to TEST and DONE in every profile and round until it is closed (`finding_resolve` with repair evidence or the audited `disposition: preexisting_out_of_scope`, `review_remediation_close`, or `finding_dismiss`). |
| Explicit suspected reviewer finding | `suspected` | Advisory only and requires an `uncertaintyReason`. |
| `gap_log` | `suspected` | Long-lived framework-audit backlog; it does not block lifecycle gates. |
| Legacy finding without the field | treated as `verified` | Preserves old blocking behavior. |

The REVIEW blocking predicate requires an open finding, critical/high/medium
severity (the closure set in `core/finding-closure-severities.ts`, the same in
every profile and round; low is advisory), and a blocking evidence state.
Reviewers rate severity with the one shared rubric (`REVIEW_SEVERITY_RUBRIC`,
core/finding-closure-severities.ts): a confirmed regression of existing behavior (a base-to-head behavior change the request did not ask for, documented or not) or a wrong result on a documented or tested path is at least medium; low is only for cosmetic or non-behavioral issues. A low finding the owner
repaired through a managed finding-repair bound to it is resolved before REVIEW
(`next` proposes `finding_resolve`). A critic `duplicate` of a repaired and
resolved canonical finding gets no repair of its own when a coverage run of its
own case passes: `next` proposes `finding_resolve` with `duplicateOf` and
`coverage {command, selector}`, the framework runs the command and closes it
only on exit 0 plus the selector; otherwise it refuses and `next` dispatches the
duplicate's own repair (run 17). A finding whose cited `path:line` defect sites
are unchanged since the Story base and that no scope-contract path, checklist
file, scope-boundary entry or request sentence covers (old-PoS run 30) is never
routed to repair: `next` proposes one `finding_resolve` with
`disposition: preexisting_out_of_scope`, which recomputes that evidence and
records it with a follow-up (severity unchanged; `finding_applicability_assess
--verdict=pre_existing_unaffected --proposalRef=<finding id>` is the same
disposition). A repair run that ends without a commit is relaunched once with
its report in the prompt; after a second one `next` returns the Story to PLAN
(`finding_repair_replan`). Details: `docs/CLI.md` ("Pre-existing findings
outside the Story"). After DONE, `finding_resolve` and `finding_dismiss` refuse
with one `Next:`.
Findings from earlier rounds count; there is no round decay. Suspected
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

The routine `proof-or-stop validate --story=B-xxxx --json` runs once, in REVIEW,
right after PRE_CERT admits the certification window; TEST consumes that signed
PASS and does not run a second unscoped suite (`proof-or-stop next --storyId=B-xxxx`
names each of these steps in order). A passing command alone is
not enough: all required verification intent, bugs, review evidence, ProofStory
artifacts, acceptance topology, delivery/summary checks, and freshness gates must
also pass. If DONE-required policy is configured, run
`proof-or-stop done_required_validate --storyId=B-xxxx`; its evidence must bind
the current HEAD, material hash, and Story-files hash. Without that policy, the
command is advisory and must not be described as full-suite assurance.

When a DONE oracle row that it recovers fails (evidence freshness, DONE-required
validation, integration-branch sync), `next` proposes:

```bash
proof-or-stop done_prepare --storyId=B-xxxx --mergeMain --refreshStale --validate
```

`done_prepare` is a conservative readiness assistant. It can merge the resolved integration branch, safely
refresh classified stale evidence, validate, and aggregate the next blockers;
it never advances DONE and never mutates version files. Related Story-file drift
still requires the appropriate re-review, re-quorum, re-verification, or
re-delivery work. Advance to DONE only after the prepare result and every
applicable lifecycle gate pass. The Story branch must contain the current local integration branch.

DONE merges the Story to the resolved local integration branch and performs post-merge effects. When watched
CLI/runtime or capability-contract inputs changed, the DONE effect automatically
patch-bumps and commits all synchronized version points. It skips the bump when
no watched inputs changed, including ordinary documentation-only work. Do not
manually bump a version merely because a Story completed, and do not ask
`done_prepare` to bump it.

Remote publication is a separate human-authorized action. Story branches are
local implementation details and must not be pushed. After a clean, verified
local integration branch exists, a human may grant one exact-SHA, exact-branch,
short-lived approval with `proof-or-stop release_approve_push --confirm`, then
perform the exact manual push command returned by the approval.

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
2. Host launches every requested Agent in the existing Story worktree before waiting for any one lane; after every target acknowledges, wait for the batch collectively.
3. Reviewer runs proof-or-stop review_run_start for its canonical role.
4. Reviewer records finding_add or review_pass_set with current signed evidence.
```

Planning uses the canonical `proof-or-stop-verification-intent` role, and
review uses the current registry-selected canonical reviewer lanes. Retired
role names are not dispatch aliases.
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

`reportHealthIssue` 在 `core/health.ts`，往 CLI health log append 一条记录，**自身永不抛错**。用户跑 `proof-or-stop doctor` 可以看到所有 PERSIST 失败 + 按分类汇总。

写 silent catch 时问自己一个问题：**如果这里失败了，10 分钟后用户会怎么发现？** 没答案就用 `reportHealthIssue` 留痕。

### 证据链检查（框架负责，永远不是 review finding）

Review finding 只能是真实的产品缺陷。证据链问题（receipt 过期、intent 没有 pinned command 或没有 receipt、
Story diff 里新增/改动的 Go 测试没有被任何 intent 的 pinned `go test -run` 选中）由
`core/evidence-chain-check.ts`（接线在 `handlers/evidence-chain.ts`）在进 REVIEW 前机械检测，每次只给一个 `Next:`：

- `stale_receipt`（must/should）：阻塞 DEV→REVIEW，Next 固定为 `proof-or-stop verification_evidence_refresh_stale --storyId=<id>`；不要逐条 `verification_evidence_add` 重放。
- `missing_receipt`：must 阻塞、should 只提示；Next 是 `verification_run --pending`（已 pin 的 must，一次跑完）/ `verification_run --intentRef`（已 pin 的 should），未 pin 时是**一条** `verification_evidence_batch_add` 模板，覆盖所有未 pin 的缺 receipt intent，`command`/`selector`/`note` 都是 `<...>` 占位符，由 agent 填写；每个 intent 附带排序后的候选测试（测试体里出现 intent 描述中的代码字面量者优先，其次是测试名与描述共享的词）及理由。
- `unbound_test`：只提示；Next 是带该测试命令的 `verification_evidence_add` 模板，`intentRef` 是列出该 item 未 pin intent 的占位符：只在它确实证明某个 intent 时绑定那一个。全部 intent 已 pin（pin 不可改）时无需动作，除非它是某个 userSees 行为的唯一测试（走 `acceptance_amendment_propose`）。`next` 不再把它作为单独一步，只写进下一步的 `why`。
- **测试与 intent 是否匹配是判断，不是机械操作**（run 16）：框架从不替 agent 选测试，从不生成「X proves: <desc>」备注；带占位符的命令在 `next` 里一定是 `agent` 步骤，`next --run` 不会执行它。此前框架把 item 文件里第一个改动的测试当作 `framework` 步骤提出，`next --run` 会把不相干的测试（只测两段式 range 的 `TestParsingIndexRangeExpressions`）永久 pin 给 `myArray[99 : 101 : 2]`。
- **PLAN 就要 pin**：`story_review` 对每个没有 `verification:{command,selector}` 的可执行（logic/cli/browser）must/should intent 报 `missing_verification_pin` blocker（manual/docs、nice 豁免）；PLAN 里用 `checklist_update` 写 pin（测试可以还不存在，implementer prompt 会要求用这些测试名）。有了 pin，DEV 一条 `verification_run --pending` 记完全部 receipt。跳过 story_review 的路径（express 通道、light profile）仍可能无 pin 进 DEV，此时走上面的 batch 模板。
- 选择集是算出来的，不猜：无法计算的 pinned command（make、shell、模块外 import path 等）会跳过扫描并写明原因；JS/TS 不扫描。
- 输出位置：`pre_review_check` / `pre_review_check_read` 文本末尾的 `Evidence-chain check` 段，以及 `story_advance REVIEW` 的 gate。

test-coverage reviewer 只报产品覆盖缺口。reviewer 若仍报证据链项，用 `category: "evidence_chain"`：
`managed_review_evidence_import` 只导入产品 finding（保留 sealed proposal index），只含证据链项的 proposal 以 pass 导入
（note 由 verifier 从 sealed proposal 重算），每项记为 `review_evidence_chain_reclassified` process event，并打印
`Framework next action:`；native `finding_add` 直接拒绝（`evidence_chain_not_a_finding`）。

### acceptance basis 与 pre_review_check 的顺序约束（B-45a0 F-435/F-438）

**先 `acceptance_basis_generate`，再 `pre_review_check`，顺序不能反。**

`pre_review_check` 会把当时的 plan `basisDigest` 快照进 `priorPlanBasisDigest`，
而 `basisDigest` 覆盖 `binding`（headHash/materialHash/storyFilesHash）与 `receiptRef`。
所以事后再跑一次 `acceptance_basis_generate`——哪怕 acceptance 语义完全没变——也会移动那个 digest，
把刚拿到的 PASS 打成 `PR_COVERAGE_BASIS_CHANGED`（通常伴随 `PR_ARTIFACT_TAMPERED`），
而 `storyFilesHash` 根本没动。

这是**操作顺序陷阱，不是代码缺陷**：fail-closed 符合 Section 9 Rule 3「never a silent pass」（Rule 9 讲的是 coverage-basis freshness，不是这条）。
但补救只能靠重跑 `pre_review_check`，而它是 `allowedPhases: ['DEV']`——
在 REVIEW 撞上这个的 story 无法自愈，必须回 DEV。

代码里已有 `acceptanceCoverageBasisSemanticDigest`（剥掉 `basisDigest`/`binding`/`receiptRef`）
专门识别这种 hash-only rebinding，`verifyAcceptanceBasisReceipt` 也在用；
但要接进 `PR_COVERAGE_BASIS_CHANGED` 的比较需要持久化一个 semantic digest，
因为 `priorPlanBasisDigest` 只存原始 hash。

真相源：`docs/requirements/decisions/proofstory-acceptance-topology-and-pre-review-gates-execution-plan.md`
Section 9 Rule 10。

## Defect triage discipline

Fix major or acceptance-blocking defects on the spot. Record non-major, non-blocking
defects with evidence and defer them. Never widen scope to chase all-green.

### Step 1 — classify before acting

For every new defect found during development, first decide: is this a major risk to
the current story, or does it block its acceptance? Do not start fixing before this
question is answered. The reviewer's job is to find; the main agent's job is to triage.

### Step 2 — fix in the current story

Mandatory when the defect is any of:

- verified critical / high / medium severity
- security, data integrity, or destructive-compatibility impact
- blocks the current story's acceptance, REVIEW, TEST, or DONE
- makes already-registered evidence false (a selector that cannot match the real
  verdict, a receipt claiming `pass` for a command that failed) — this is the subtlest
  case and the easiest to wave past

Action: fix, add the regression test, `finding_resolve` with mechanical evidence — the
command run and its actual output, not a description of it.

### Step 3 — record and defer

Applies when the defect is medium / low **and** all of:

- not a direct regression of the current acceptance scope
- does not affect the user's core outcome
- does not distort a lifecycle gate

Action: preserve reproduction steps, evidence, blast radius, and a recommended fix.
Record it in a finding / gap / backlog entry and name the follow-up story that owns it.
Do not widen the current story's scope. Convenience is not a reason to fix out-of-scope
work.

### Step 4 — deferral must be traceable, and is reversible

A deferral decided verbally does not count. It needs a durable, followable record:
`finding_add`, `gap_log`, or a follow-up `story_create` with the evidence linked, plus a
line in this story's resolution or summary saying it was recorded and deferred.

If later evidence shows the severity was underestimated, or the defect turns out to
block acceptance after all, pull it back into the current story immediately. Step 3 is a
classification, not a commitment.

### Why rule 3 has teeth

Green is not the goal; trustworthy evidence is. Never make a check pass by relaxing its
decision rule, widening an allowlist, or bending acceptance inputs to fit your own change.

B-45a0 case: adding files to `REPLAY_ADMISSION_NONEXECUTING_PATHS` looked like a cheap
way to make the replay admission pass. Measuring the actual diff showed the drift was in
`story-aware-validation.ts` — where `discoverValidationInventory` and
`compileValidationCatalog` are defined — i.e. producer-side drift, precisely what that
allowlist refuses by design. The honest fix was re-running the campaign for a fresh report.

Every out-of-scope fix is also another material change: it can invalidate an open review
inventory epoch, re-stale acceptance surfaces, and force another review round.

One-line test: **if this defect goes unfixed, is this story's acceptance conclusion
false?** Yes → step 2. No → step 3.
