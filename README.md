# Lattice CLI

Lattice CLI 0.3.5 是 Koala Story 工作流的 CLI-first 产品入口。`lattice`
是主入口，`koala` 保留为 legacy alias；两者仍指向同一套 project state、
phase、gate、review、evidence 和 handoff 语义。

这个仓库当前包含：

- `packages/main`：Lattice/Koala 核心 CLI
- `packages/utils`：`aux_*`、`truth_*`、`tool_status` 等扩展工具
- `bin/lattice.js`：完整 bootstrap 主入口（`main + utils`）；仅此仓库自身使用，新项目 global-thin 默认 init 不生成此文件
- `bin/koala.js`：legacy bootstrap alias（`main + utils`）
- `bin/lattice-codex.js`：Codex 专用本地入口，会把活动记成 `source=codex`；full/thin 模式显式 opt-in 才生成，global-thin 默认不生成
- `bin/koala-codex.js`：legacy Codex wrapper alias for existing repositories

## Lattice CLI 0.3.5 Migration

Mac App provider/config dashboard capabilities are now exposed through CLI
surfaces first:

```bash
lattice --version
lattice host list --format=json
lattice host probe --host=codex --format=json
lattice host status --host=claude-code --format=json
lattice host install --host=desktop-app --format=json
lattice config doctor --format=json
lattice rollout_check --projects /path/to/project-a,/path/to/project-b --json
lattice authority status --format=json
lattice conduit status --format=json
lattice conduit explain --format=json
```

The flat command forms remain available for automation:

```bash
lattice host_list --format=json
lattice host_probe --host=codex --format=json
lattice host_status --host=claude-code --format=json
lattice host_install --host=local-runner --format=json
lattice lattice_config_doctor --format=json
lattice rollout_check --projects /path/to/project --json
lattice authority_status --format=json
lattice conduit_status --format=json
lattice conduit_explain --format=json
```

Local/global refresh after editing the CLI itself:

```bash
npm --prefix packages/main run build
npm install -g ./packages/main
lattice --version
koala --version
lattice check
lattice doctor --format=json
lattice rollout_check --projects "$(pwd)" --json
```

These commands are diagnostic/read-only unless their names explicitly say
otherwise. `host_install` is dry-run guidance only and never executes
third-party installers. `rollout_check` scans selected projects for install
drift, managed asset drift, runtime footprint, git/story state, and transcript
lifecycle readiness; it never runs `check --apply`, `check --upgrade`, repair
commands, installers, evidence submission, or receipt verification. External
projects and non-git projects are normalized into PASS/WARN/FAIL records with a
next action instead of opaque command failures. `authority_status` and
`conduit_status` are receipt-aware but conservative: without verified server
receipt support they report `productionDone=false`, `receiptVerified=false`,
and `canClaimProductionDone=false`.

## Host Overflow

Lattice Host Overflow is manual-first; Lattice keeps story/scope/receipt
authority; Claude Code is an execution host, not a production authority.

Use the overflow surfaces like this:

```bash
lattice dispatch_plan --storyId=B-xxxx --host=claude-code --allowedPaths=packages/main/src/foo.ts --format=json
lattice dispatch_prepare --storyId=B-xxxx --host=claude-code --allowedPaths=packages/main/src/foo.ts --format=json
lattice dispatch_run --dispatchId=D-B-xxxx-claude-code-1234 --format=json
lattice overflow_auto --storyId=B-xxxx --host=claude-code --format=json
lattice overflow_auto --storyId=B-xxxx --host=claude-code --approve=true --start=true --format=json
```

The contract is conservative by design:

- `dispatch_plan` is read-only planning. It picks a host, previews the bounded
  pack/worktree projection, and creates no dispatch record, worktree, or
  receipt.
- `dispatch_prepare` persists the bounded pack plus prompt/status placeholders
  under `.koala/dispatches`, but it still does not create the overflow worktree
  or start a host.
- `dispatch_run` is landed. For `fake`, it runs the deterministic local harness
  and returns a local diagnostic receipt. For real hosts, it creates the
  projected isolated worktree when scaffold creation succeeds, or returns
  `failed` with a diagnostic `nextAction` when `git worktree add` cannot create
  that scaffold. It never auto-drives the external host, verifies receipts, or
  claims `productionDone=true`.
- `overflow_auto` is a guarded wrapper around dispatch selection. By default it
  is suggest-only. It only materializes a dispatch when **both**
  `approve=true` and `start=true` are present; either flag by itself stays in
  suggest-only mode with an explicit warning.
- Local receipts remain diagnostic-only. Even on `accepted-local`,
  `receiptVerified=false` and `productionDone=false` remain.

### Unattended dispatch: `dispatch_auto` (policy-authorized)

`dispatch_auto` is the policy-authorized unattended scheduler. Unlike
`overflow_auto`, it may start unattended workers automatically — but only after
explicit user policy authorization and the full `dispatch_auto` launch gates
pass. The standalone `host_runtime_probe.unattendedSafe` fact remains
conservatively `false`; actual launch authorization is computed by
`dispatch_auto` from policy authorization plus Claude availability,
`claude --print` support, `commandAllowlist`, timeout/env, and scope checks. In
v1.0.1, real-host subprocess launch is Claude Code only and additionally
requires `allowRealHostSubprocess=true`; Gemini and Codex remain
scaffolded/refused real-subprocess targets.

**Opt-in command sequence:**

```bash
# 1. Define or verify a dispatch policy
lattice dispatch_policy_create --policy=nightly-safe \
  --allowedHosts=fake --allowedPaths=packages/main/src/generated/ \
  --maxParallel=2 --maxRuntimeMinutes=30 --maxBudgetUSD=5.0 \
  --network=none --commandAllowlist='node -e "process.exit(0)"' \
  --allowRealHostSubprocess=false \
  --requireReceipt=true --requireReview=true \
  --allowAutoMerge=false --allowProductionDone=false

lattice dispatch_policy_check --policy=nightly-safe --format=json

# Claude Code real subprocess v1.0.1 requires a separate explicit opt-in policy:
# --allowedHosts=claude-code ... --allowRealHostSubprocess=true

# 2. Probe host capability (works whether or not the CLI is installed)
lattice host_runtime_probe --host=claude-code --json

# 3. Start policy-authorized unattended workers
lattice dispatch_auto --storyId=B-xxxx --policy=nightly-safe --format=json

# 4. Watch lifecycle and runner status
lattice dispatch_watch --dispatchId=D-B-xxxx-1234 --format=json

# 5. Cancel if needed — evidence is preserved, never deleted
lattice dispatch_cancel --dispatchId=D-B-xxxx-1234 --format=json

# 6. Review transcripts, diffs, receipts, and runner evidence
lattice dispatch_review --dispatchId=D-B-xxxx-1234 --format=json

# 7. Merge manually — dispatch completion is NOT production authority
lattice dispatch_merge_plan --dispatchId=D-B-xxxx-1234 --format=json
```

**`dispatch_auto` versus `overflow_auto`:**

| | `overflow_auto` | `dispatch_auto` |
|---|---|---|
| Mode | Supervised/manual-first | Policy-authorized unattended |
| Starts workers automatically | Only with `approve=true --start=true` | Yes for fake; Claude Code real subprocess only with `allowRealHostSubprocess=true` |
| Policy required | No | Yes — refuses if missing or unauthorized |
| Host safety check | No | Yes — Gemini/Codex real subprocess support is not claimed |
| Unattended mode | No (suggest-only by default) | Yes (policy-gated) |
| Migration | Current default | Use this for unattended mode |

If you are currently using `overflow_auto` and want unattended workers, migrate
to `dispatch_auto` with an explicit policy. The `overflow_auto` `nextAction`
field will point you to `dispatch_auto` as the policy-authorized path.

**Unattended mode remains user-authorized and authority-safe:**

- `host_runtime_probe.unattendedSafe` is intentionally conservative and remains
  `false`; `dispatch_auto` is the component that combines policy authorization,
  Claude availability, `claude --print` support, launcher allowlisting,
  timeout/env filtering, scope checks, and lease/conflict checks before
  starting work. Real subprocess launch in v1.0.1 is Claude Code only and
  requires `allowRealHostSubprocess=true`.
- Worker output is evidence only. `dispatch_review` surfaces transcripts, diffs,
  receipts, and runner metadata as **evidence candidates**, not as gate authority.
- `dispatch_merge_plan` is always `manualOnly=true` — dispatch completion never
  auto-merges, auto-DONEs, or claims `productionDone=true`.
- All authority fields remain fixed: `productionDone=false`,
  `receiptVerified=false`, `authorityChanged=false`.

### Autopilot execution modes

`autopilot_run` is the host-to-host autopilot layer above dispatch. It keeps the
same Host Overflow authority boundary: hosts may execute bounded work, but
Lattice keeps story/scope/review authority. Autopilot completion does not
auto-merge, auto-DONE, or claim production authority.

| Mode | What it can do | Acceptance boundary |
|---|---|---|
| Conservative | Runs a bounded fake/local or supervised host-native delegation path from an explicit policy. | Local diagnostic receipts only; `receiptVerified=false` and `productionDone=false`. |
| Authority-Verified | Requires a verified authority receipt before the run is accepted. The fake authority server can be used for deterministic tests. | Missing or unverifiable authority receipts are refused. A verified authority receipt may set `receiptVerified=true`, but still does not imply `productionDone=true`. |
| Full Autopilot | May continue through bounded plan/run/watch/review loops within `maxSteps`, runtime, scope, and policy limits. | Stops at the declared bound or conflict boundary. Review and merge remain manual-only. |

Policy setup supports both flat and nested CLI forms:

```bash
lattice autopilot_policy_create --policy=fake \
  --modes=conservative,authority-verified,full-autopilot \
  --allowedHosts=fake --allowedPaths=packages/main/src/generated/ \
  --maxParallel=2 --maxRuntimeMinutes=10 --allowAutoMerge=false \
  --allowProductionDone=false --json

lattice autopilot policy create --policy=fake \
  --modes=conservative --allowedHosts=fake \
  --allowedPaths=packages/main/src/generated/ \
  --allowAutoMerge=false --allowProductionDone=false --json

lattice autopilot_policy_check --policy=fake --mode=conservative --json
```

Run and inspect a conservative autopilot attempt:

```bash
lattice autopilot_run --mode=conservative --storyId=B-demo --policy=fake --json
lattice autopilot_status --autopilotId=A-B-demo-1234 --json
lattice autopilot_watch --autopilotId=A-B-demo-1234 --json
lattice autopilot_review --autopilotId=A-B-demo-1234 --json
lattice autopilot_cancel --autopilotId=A-B-demo-1234 --json
lattice autopilot_resume --autopilotId=A-B-demo-1234 --json
```

Host-native delegation is execution-only. A delegated Claude Code, Gemini, Codex,
or fake host receives a bounded pack/prompt shape and returns transcript,
changed-file, command, and local diagnostic receipt data for review. Those local
diagnostic receipts do not imply `receiptVerified=true` or `productionDone=true`.
Only the Authority-Verified path may set `receiptVerified=true`, and only after a
verified authority receipt is bound to the run.

Merge and conflict handling stay outside autopilot. `autopilot_review` may
surface a manual merge plan, changed files, conflicts, or resume guidance, but it
must not run `git merge`, clean up the story worktree, advance DONE, or claim
`productionDone=true`. If a bounded Full Autopilot run hits a conflict, stale
base, denied path, missing receipt, or exhausted bound, it stops and reports the
manual next action.

Architecture and non-goals:
[`docs/requirements/decisions/host-overflow.md`](docs/requirements/decisions/host-overflow.md)

### Authority modes (off / shadow / enforce)

Lattice CLI 0.3.5 exposes three authority modes through `KOALA_AUTHORITY_MODE`.
All three keep ordinary local story development free, local, and unblocked —
`authority_status` will always report `localWorkflowUsable: true`. Local
lifecycle gates (`story_advance`, `verification_evidence_add`, DONE) do **not**
consume server receipts; missing enforce prerequisites are reported as
`readinessWarnings` / `nextActions`, never as global blockers.

| Mode | When to use | What the CLI does | Production authority? |
|------|-------------|-------------------|-----------------------|
| `off` (default) | Normal local Koala/Lattice story development. **Free, local-only.** | Zero network. Local evidence and DONE gate work exactly as without authority. | No — `productionDone=false`, `receiptVerified=false`. |
| `shadow` | You want to observe Python authority responses while still running locally. | Best-effort observational POST. Failure becomes a single stderr warning; the local evidence write still succeeds. | No — `accepted: true` from the transport is `thin-client-transport-accepted`, not a verified receipt. |
| `enforce` (future runner path) | Reserved namespace for the isolated headless runner. Requires the Python authority server, a registered actor key, and a runner identity. | Not implemented end-to-end yet: `authority_enforce_policy` is read-only policy discovery; envelope submission, signing, receipt verification are deferred to M2+. | No today — `productionDone` and `receiptVerified` stay `false` until an explicit receipt-backed authority path verifies a signed receipt. |

Inspect what the local CLI thinks the authority surface looks like:

```bash
# Plain status (default = off; no env needed)
lattice authority status --json

# Probe what's missing if you try shadow / enforce
KOALA_AUTHORITY_MODE=shadow lattice authority status --json
KOALA_AUTHORITY_MODE=enforce lattice authority status --json

# Conduit-side mirror of the same readiness fields
lattice conduit status --json
lattice conduit explain --json
```

`authority status --json` returns (among other fields):

- `mode` — `off` | `shadow` | `enforce`
- `localWorkflowUsable: true` — local Story workflow is never blocked
- `authorityUrlConfigured` — is `KOALA_AUTHORITY_URL` set?
- `actorKeyConfigured` — is `KOALA_AUTHORITY_ACTOR_KEY` / `_PATH` set?
- `runnerConfigured` — is `KOALA_AUTHORITY_RUNNER_ID` set?
- `readinessWarnings: string[]` — actionable, only populated when `shadow` / `enforce` is configured but prerequisites are missing
- `nextActions: string[]` — suggested env / command fixes
- `productionDone: false`, `receiptVerified: false`, `canClaimProductionDone: false`

**Important boundary**: this local JSON output (or `lattice` text output) is
**not** authority evidence. The Python authority is the only source of a
verified `AuthorityReceipt`. Even with `KOALA_AUTHORITY_URL`,
`KOALA_AUTHORITY_ACTOR_KEY`, and `KOALA_AUTHORITY_RUNNER_ID` all set,
`productionDone` stays `false` until a signed receipt is verified by a future
receipt-backed runner path. See
[`docs/requirements/decisions/authority-client-role.md`](docs/requirements/decisions/authority-client-role.md)
for the PD-1 / PD-2 trust boundary.

The Mac App is no longer required for release or provider/config status. It is
an optional dashboard/archive surface unless a future, explicitly reviewed
receipt-backed runner path lands.

### CHK-002 authority enforce matrix smoke

`npm run test:authority-enforce-matrix` runs a deterministic in-process matrix
that proves:

- **local/off stays free/local** — `loadAuthoritySettings({})` is `mode: off`;
  `classifyCliAuthoritySubmission('off', …)` returns `local-only`.
- **shadow is warning-only** — a failing server returns `proceed=true` with a
  `[warning]` rather than throwing.
- **enforce fake receipt can only be classified after receipt verification** —
  `classifyCliAuthoritySubmission` keeps `thin-client-transport-accepted`; only a
  fully-bound envelope whose signed `AuthorityReceipt` is verified through
  `classifyReceiptBackedEvidence` reaches `receipt-backed-l2-plus`.
- **enforce missing server fails closed for runner/submission path** —
  `createAuthoritySubmitter(enforce, no baseURL).submitSingle(…)` returns
  `proceed=false` without touching the network.
- **parallel_report remains non-authoritative** — `buildParallelReport(wave)`
  always has `authority.productionDone=false`,
  `authority.authorityChanged=false`, and `authority.receiptRefs=[]`.

Primary path: Lattice CLI + Server Authority receipts. Mac App:
optional/archive dashboard only.

## Codex 使用

## Koala 状态入口

Koala 不负责 Codex / Claude Code 的 agent runtime；它负责 project state：
story、phase、worktree、gate、review、fixture、bug 和 evidence。

恢复现场时优先使用只读入口：

```bash
lattice status
lattice next
```

- `lattice status` 展示当前工程状态总览，复用 `session_brief` 的事实来源
- `lattice next` 只输出当前最可信的下一步建议
- 两个命令都不推进 phase、不写 `.koala/state`、不修改 story/fixture/git

`session_brief` 仍然是新 agent session 的开场简报入口；`status` / `next` 是给人和
agent 在工作中快速恢复现场的短入口。

### 1. 先构建完整 CLI

```bash
npm --prefix packages/main run build
npm --prefix packages/utils run build
npm --prefix packages/lab run build
```

### 2. 在 Codex 里优先用仓库内入口

```bash
node bin/lattice-codex.js session_brief
node bin/lattice-codex.js aux_doc_list --format=json
node bin/lattice-codex.js story_create '...'
node bin/lattice-codex.js lab create --target=test-case-reviewer --profile=reviewer-quality-v1
```

Wrapper 优先级：`bin/lattice-codex.js`（本仓标准）> `bin/koala-codex.js`（legacy 项目等价 fallback）> `bin/lattice.js`（通用 bootstrap，不带 `source=codex` 标记）> `bin/koala.js`（legacy 通用 bootstrap fallback）。legacy 项目或新 worktree 只有 `bin/koala-codex.js` 时，直接替换前缀，语义等价。

原因：

- 这个入口会加载 `main + utils`，所以 `aux_*` 命令可用
- 如果 `packages/lab` 已构建，它也会把 `lattice lab ...` 子命令一起接进来
- 它会把 Koala 调用写入 `.koala/activity.jsonl`
- 写入记录会带 `source=codex`，可以和普通 CLI、Claude Code 区分
- 它会为 `session_brief` 这类只读恢复命令启用 heartbeat 记录

如果本地 bootstrap 还没准备好，wrapper 会直接打印恢复步骤，而不是抛出模糊的模块加载错误。在 Koala 仓库自己的 story worktree 里，状态、gate、`validate` 这类判断先用当前 worktree 的本地 core CLI：

```bash
node packages/main/dist/cli.js status
node packages/main/dist/cli.js validate --json
node packages/main/dist/cli.js doctor --format=json
```

## Optional Desktop Binary Packaging

Lattice can still be packaged as a single desktop executable with Vercel `pkg`,
but this is optional packaging, not the Mac App release path. The desktop build
uses a small pkg-specific entrypoint that loads the same full local bootstrap as
`bin/lattice.js` / `bin/koala.js`, so packaged binaries include core commands
and utils commands such as `aux_doc_list`.
The entrypoint exists because pkg's Node 18 snapshot loader does not reliably
run this repo's ESM bootstrap directly from the snapshot; it stages the bundled
bootstrap assets into a temp runtime directory first.

```bash
npm install
npm run package:desktop:host
npm run test:desktop-package
```

The host binary is written to `dist/desktop/koala-<platform>-<arch>`. Release
packaging for macOS, Linux, and Windows x64 targets is available with:

```bash
npm run package:desktop:release
```

Desktop/archive surfaces can copy the matching `dist/desktop/koala-*` binary
into an app bundle and invoke it directly; users do not need a separate Node.js
install. This is optional dashboard/archive support. Provider/config status now
belongs to the Lattice CLI commands above.
Vercel `pkg` is an early distribution shortcut here, not the long-term final
runtime strategy: the upstream Vercel project is archived, and `pkg` 5.8.1 was
its last release. Future release hardening should revisit Node SEA or an
actively maintained `pkg` fork before adding installer, signing, or auto-update
workflows.

全局 `koala` 只适合作为 source-tagged heartbeat fallback；它可能滞后于当前 worktree，不应作为当前 story 的 gate/status/next-step 证据。Global `lattice`/`koala` in a story worktree is **heartbeat-only, not current-worktree gate/status evidence**.

`validate --json` 的 `commands[]` 是验证 receipt：结构化命令默认记录 argv 形式；
包含 `cd`、`&&`、管道或重定向等 shell 语义的字符串配置会记录 `shell=true`，表示这是有意的 shell receipt。必需命令失败会让 validate fail；`optional:true` 失败只会 warn。`doctor` 的 Validation scan 只做 advisory：它展示 validate 文件、配置命令、fallback 发现和 no-validator warning，帮助你决定是否要补显式 `validate.command(s)`。

项目配置文件 canonical 为 `lattice.config.json`，legacy `koala.config.json` 仍可读作为兜底；两者并存时 `lattice.config.json` 胜出并打印冲突诊断。`lattice validate` 的自动 fallback 集合只包含 `npm test` / `pytest` / `go test` / `cargo test` / `mvn test` / `gradle test`；Swift / Mac Native App 已退役，**不**在自动 fallback 列表，必须显式配置 `validate.commands` 才会运行 `swift test`。

`doctor` 还会输出 `Runtime scan:`，这不是流程 gate 证据，而是运行环境漂移检查。runtime facts 由 `packages/main/src/core/runtime-fact-registry.ts` 定义并由 `scripts/verify-runtime-fact-contract.mjs` 保护，覆盖 CLI entrypoint、global `@koala-agent/core` realpath、项目本地 `node_modules/.bin/koala`、Node/package version、validate source 和 `external-reference-policy`。外部项目只收到 warn/advisory，不因为 Orchestrate 本仓的 symlink 期望 hard fail。`external-reference-policy` 只扫描 `lattice.config.json`（canonical）/ `koala.config.json`（legacy fallback）、`AGENTS.md`、`CLAUDE.md`、`README.md`、`docs/requirements/**/*.md`，排除 story/fixture/build/source-comment 噪音；它只报告 policy warning，不声明 connectivity pass。

Koala runtime artifacts 是另一张表：`packages/main/src/core/runtime-artifact-registry.ts` 定义 `.koala/activity.jsonl`、legacy `docs/story/activity.jsonl`、`.koala/runtime/`、`.koala/traces/`、`.koala-serve.json`、debug/browser logs 等运行时文件的 ignore、materialHash 和 repair 语义。`lattice init` 会把缺失的 runtime ignore 规则合并进已有 `.gitignore`；`lattice doctor` 会报告已被 git 跟踪的 runtime artifacts，并在 `--repair` 时只对 registry 标记为 repairable 的路径执行 `git rm --cached`。这些文件不会让 materialHash-backed verification evidence stale；`.koala/story/` 仍是流程证据，不按 runtime artifact 处理。

Lifecycle facts are also registry-backed. `packages/main/src/core/lifecycle-registry.ts` records the active phase order, legacy phase aliases, transition events, rollback edges, TEST/DONE gate ids, effects, and oracle row ids. `phase-flow.ts`, `handlers/context.ts`, and `test:flow-stability-smoke` must agree with it; inconsistent phase/event/policy edits should fail with a direct lifecycle registry mismatch.

Dashboard 和 `session_brief` 会把 lifecycle progress 与 terminal outcome 分开显示：
`Lifecycle DONE: N/M (...)` 只表示 story 进入 DONE；`DONE-success/default`、`DONE-blocked`、`DONE-audit-only` 来自 `summary_set.outcomeKind`，旧 summary 缺字段时归入 success/default 兼容桶。相关回归可运行：

```bash
npm --prefix packages/main run build
npm --prefix packages/main run test:outcome-semantics-smoke
```

通过 `lattice story_advance ... INIT_CHECK` 新建的 story worktree 不需要手工复制 `.Codex`。`git worktree` 会把当前分支已跟踪的仓库文件一并展开出来，所以只要 `.Codex`、`.claude`、`AGENTS.md`、`CLAUDE.md` 已经提交到仓库，新的 `.worktrees/B-xxx/` 里就会自然带上这些入口。只有两种常见缺失原因：这些文件本来就没被 git 跟踪，或这个 worktree 是从还没包含这些资产的旧分支/旧提交分出来的。

### 3. 新 session 的第一步

用当前 worktree 已有的 codex wrapper（按优先级选一）：

```bash
node bin/lattice-codex.js session_brief     # 本仓标准 wrapper
# node bin/koala-codex.js session_brief    # legacy 项目 fallback（等价）
```

项目里的 [AGENTS.md](/Users/jek/Documents/Work/Orchestrate/AGENTS.md:1) 也要求每个新 session 先跑这条命令。

### 4. 查看 Codex 自己的 Koala 活动

```bash
node bin/lattice.js tool_status --source=codex --days=1 --limit=10
```

### 5. 跑入口回归验证

```bash
npm run test:entrypoints
```

这会验证当前 worktree 的 repo-local entrypoints / generated local wrapper，不要求当前环境里的 bare global `koala` 已经更新：

- 当前仓库的 `bin/lattice.js` / `bin/lattice-codex.js`，以及 legacy `bin/koala.js` / `bin/koala-codex.js`
- repo-local `node packages/main/dist/cli.js init --help` 和 generated local wrapper `node bin/lattice.js init --help` 都把 `--starter` / `--with-template` 标为可选 starter 内容
- repo-local default init 只生成 Koala management assets，不生成 starter `src/core` / `src/shells` / `tests`
- repo-local `init --starter` / `init --with-template` 会生成旧版 starter 模板，并使用 `scanRoot: "src"`
- Python no-src 项目默认 init 不创建 `src/`，并使用 `scanRoot: "."`
- `.Codex/README.md` 是否包含正确的降级入口说明

### 6. 验证 Codex 资产没有漂移

```bash
npm run test:codex-assets
node bin/lattice-codex.js verify_codex
```

这会检查：

- legacy/full prompt mode 下，`.Codex/agents/*.md` 是否仍然等于 `.claude/agents/*.md` 的受控 transform 结果
- legacy/full prompt mode 下，`.Codex/agents` 是否没有漏掉 `.claude/agents` 中新增的 prompt
- registry/thin prompt mode 下，`.Codex/lattice.json` 的 `promptRegistry` version/hash 是否匹配 package registry，且 Codex prompt renderability 正常；legacy `.Codex/koala.json` 仍被兼容识别
- `.Codex/lattice.json` 是否声明 Lattice-managed Codex adapter、`activitySource=codex`、推荐入口和不生成的 runtime 资产
- `.Codex/README.md` 是否保留正确的 Codex fallback 入口
- `README.md` / `AGENTS.md` 是否仍然包含关键的 Codex 接入说明

`node bin/lattice-codex.js verify_codex`（legacy 项目也可继续用 `node bin/koala-codex.js verify_codex`；通用本地入口是 `node bin/lattice.js verify_codex`）复用同一套共享检查，并额外执行本地 wrapper 与全局 fallback heartbeat：它确认 activity 记录包含 `source=codex`、session、entrypoint，并把带当前 HEAD/material hash 的 `codex_adapter_verification` 追加到当前 story 的 `process-events.jsonl`。触及 Codex adapter 的 story 在 REVIEW/DONE gate 会区分这条证据是 missing / failing / stale / passing，并给出可直接重跑的本地 wrapper 命令。

诊断同一组 Codex adapter 检查、health 和 worktree 状态：

```bash
node bin/lattice-codex.js doctor
```

初始化新项目时也可以直接跑：

```bash
npx koala-init --verify-codex
```

## 没有本地 wrapper 时

如果某个项目只有全局 CLI，没有 `bin/lattice-codex.js` 也没有 `bin/koala-codex.js`，可以这样跑：

```bash
KOALA_ACTIVITY_SOURCE=codex KOALA_ACTIVITY_RECORD_READONLY=1 KOALA_CODEX_ENTRYPOINT=global-fallback lattice session_brief
```

这能保证 activity 里仍然按 `source=codex` / `entrypoint=global-fallback` 记账，并让 `session_brief` 这种只读入口也留下 heartbeat；但如果没有 bootstrap 入口，`aux_*` 命令可能不可用。**Global CLI is heartbeat-only, not current-worktree gate/status evidence**; do not use its `status` / `validate` output as gate authority for the active story worktree.

注意：在 Lattice/Koala 仓库开发自身时，全局 CLI 可能来自旧安装、主仓或另一个 worktree。不要用旧全局 `koala` alias 的 `status` / `next` / `validate` 输出判断当前 story 是否可推进；先构建本地 wrapper，或使用 `node packages/main/dist/cli.js <command>` 读取当前 worktree 的代码和状态。

如果全局 core 入口提示 `未知命令: aux_doc_list`，在 Koala 仓库内使用完整 bootstrap：

```bash
node bin/lattice.js aux_doc_list --format=json
```

`story_create` / `story_update` 支持并行调度元数据，建议在多 story 并行时显式填写：

```bash
lattice story_update '{"storyId":"B-xxxx","lane":"mainline","parallelSafe":"plan_only","sharedHotspots":["packages/main/src/handlers/session.ts"]}'
```

如果完整入口提示缺少 `packages/main/dist/*` 或 `packages/utils/dist/*`，先执行：

```bash
npm --prefix packages/main run build
npm --prefix packages/utils run build
npm --prefix packages/lab run build
```

全局安装的 `lattice`（legacy alias: `koala`，来自 `@koala-agent/core`）在 `@koala-agent/lab` 可解析时也会自动启用 `lattice lab ...`；如果没有安装 lab，普通 core 命令仍然可用，只有 `lattice lab ...` 会提示安装/构建 lab。

发布 `0.3.5` 前建议跑：

```bash
npm --prefix packages/main run build
npm --prefix packages/lab run build
npm run test:lattice-cli-migration-smoke
npm run test:global-lab-entrypoint
```

## koala-lab

`koala-lab` 是 Koala 的离线优化实验室，用来创建实验配置、预览隔离 sandbox、校验 patch 白名单，以及为后续 compare/promote 留出统一骨架。

```bash
node bin/lattice.js lab create --target=test-case-reviewer --profile=reviewer-quality-v1
node bin/lattice.js lab run --config experiments/configs/lab-reviewer-reviewer-quality-v1.json --dry-run
node bin/lattice.js lab eval '{"config":"experiments/configs/lab-reviewer-reviewer-quality-v1.json","files":[".Codex/agents/test-case-reviewer.md"]}'
```

第一版默认只支持离线、安全的实验配置：

- `lab run` 需要先 `--dry-run` 预览，真实创建 sandbox 时带 `--confirm`
- `lab eval` 默认拦截 `docs/story`、`tests/fixtures` 和任何不在 `editableFiles` 白名单内的路径
- `packages/lab` 未构建时，普通 `lattice` 命令仍可继续使用；只有 `lattice lab ...` 会提示补 build

当前 `reviewer-quality-v1` 已经能给出真实的 baseline / score / delta / kept-discard 决策：

```bash
node bin/lattice.js lab run --config experiments/configs/lab-reviewer-reviewer-quality-v1.json --confirm
node bin/lattice.js lab compare --config experiments/configs/lab-reviewer-reviewer-quality-v1.json
node bin/lattice.js lab promote --config experiments/configs/lab-reviewer-reviewer-quality-v1.json
```

对 reviewer 目标来说，`lab run --confirm` 现在还会把真实 `patch.diff` 写进 run 目录；`lab compare` / `lab promote` 会把对应的 patch 路径和 baseline ref 一起带出来，便于直接审阅。

`score` 是 koala-lab 的内部加权决策分，会保留 `qualityWeight` 等权重语义；`normalizedScore` 是 0-1 的展示分，用于更直观地阅读 prompt 质量。`kept/rejected` 仍然只由 `score` 和 `minScoreGain` 决定。

可用回归：

```bash
npm run test:lab-foundation
npm run test:lab-scoring-core
npm run test:lab-reviewer-mvp
npm run test:lab-normalized-score
npm run test:lab-flow-profiles
npm run test:real-story-replay
```

真实任务回放评分表可用下面的脚本生成，输出同时包含 `Score`、`Evidence Quality`、`Why`、`Explain`，并写入 `experiments/reports/real-story-replay-v1.{md,json}`。`Evidence Quality=backfilled` 代表该行使用了显式 replay metadata 补齐旧 story 的证据缺口，分数会低权重计算并在解释中标明来源。

```bash
node scripts/real-story-replay-benchmark.mjs
```

## Claude Code

Claude Code 侧仍然使用 `.claude/` 下的 hooks、settings 和 skill。Codex 不消费这些 Claude runtime 配置，也不会读取 `.Codex/settings.json`。Lattice 为 Codex 生成的是 adapter 资产：full mode 会把 agent prompt 从 `.claude/agents` 全量受控生成到 `.Codex/agents`；thin mode 则在 `.Codex/lattice.json` 记录 package prompt registry 的版本和 material hash，不要求本地 prompt copies。Codex native PreToolUse hook 使用官方小写 `.codex/hooks.json` 与 `.codex/hooks/lattice-scope-pretool.cjs`；在大小写不敏感文件系统上可能显示为 `.Codex/hooks` alias。`.Codex/lattice.json` 同时记录 Lattice-managed adapter 的推荐入口、`source=codex` 活动标记、session 环境变量和明确排除的 runtime 资产；旧 `.Codex/koala.json` 仍作为 legacy manifest 被识别。Codex 侧的说明放在：

- [AGENTS.md](/Users/jek/Documents/Work/Orchestrate/AGENTS.md:1)
- [.Codex/README.md](/Users/jek/Documents/Work/Orchestrate/.Codex/README.md:1)
- `.Lattice/lattice.json`（global-thin default init primary；full/thin mode projects may use `.Codex/lattice.json` instead; legacy [.Codex/koala.json](/Users/jek/Documents/Work/Orchestrate/.Codex/koala.json:1) is still recognized as a compatibility input）
- [.Codex/agents/](/Users/jek/Documents/Work/Orchestrate/.Codex/agents:1)（full mode materialization；thin mode 可省略）

full mode 仓库里的 `.Codex/agents` 由 `.claude/agents` 经过受控 transform 全量生成，并通过 `npm run test:codex-assets` 防止后续漂移；thin mode 仓库由 `node bin/lattice-codex.js verify_codex` 校验 registry manifest/hash/renderability。
