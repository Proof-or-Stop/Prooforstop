# Changelog

## Koala 0.2.2 - 2026-04-19

本版本跨越 4 天（04-16 ~ 04-19），完成 13 个 story，核心变化是新建 `packages/lab` 实验评估子系统并发布 0.2.2，同时对 worktree 隔离、元数据回链和测试门禁做了一轮系统性补强。

### 新增：koala-lab 实验评估子系统

从零搭建 `packages/lab/`，提供 prompt/reviewer 变体的 A/B 实验与自动评分能力。经历 5 个迭代 story 逐步交付：

#### B-9ba3 — 实验基础设施

- 新增 `packages/lab/` 子包，包含 `config.ts`（实验配置加载）、`sandbox.ts`（隔离执行沙箱）、`storage.ts`（实验数据持久化）、`patch-policy.ts`（变体 patch 策略）
- 定义 `types.ts` 完整类型体系：`LabExperiment`、`LabVariant`、`LabRun`、`LabRunResult`
- 实现 `handlers/lab.ts` 主入口，注册 `lab_create`、`lab_run`、`lab_status` 三个 CLI 命令
- `register.ts` + `tool-defs.ts` 完成工具注册链路
- `cli-engine.ts` 增加扩展包加载机制，支持 lab 作为可选扩展动态注入
- `bin/bootstrap-runner.js` 同步适配扩展加载

#### B-a591 — 评分与评估内核

- 新增 `core/scoring.ts`：多维度加权评分引擎，支持 pass/fail、numeric、categorical 三种评判类型
- 新增 `core/profile.ts`：评估 profile 抽象层，定义评分维度与权重
- 新增 `profiles/reviewer-quality-v1.ts`：首个内置 profile，评估 reviewer 输出的覆盖度、准确性、可操作性
- `storage.ts` 扩展 run result 持久化
- 配套 `scripts/verify-lab-scoring-core.mjs` 验证脚本

#### B-17a6 — Reviewer prompt 的 lab MVP

- 新增 `core/diff.ts`：实验结果对比引擎，支持两个 variant 的 run result 逐维度 diff
- `handlers/lab.ts` 新增 `lab_compare` 命令
- 配套 `scripts/verify-lab-reviewer-mvp.mjs` 验证脚本

#### B-0fb7 — normalizedScore 展示分

- `core/scoring.ts` 增加归一化评分（0-100 分制），消除不同 profile 间的量纲差异
- `handlers/lab.ts` 在 `lab_status` 输出中展示 normalizedScore
- 排序策略：同分时优先展示 normalizedScore 更高的 run

#### B-48ac — 全局 lab 扩展 + 发布 0.2.2

- `packages/main/src/cli.ts` 增加 lab 扩展自动发现与加载
- `core/project-config.ts` 支持项目级 lab 配置覆盖
- `core/runtime-types.ts` 补充运行时类型守卫
- 版本号升至 0.2.2，`packages/lab/package.json`、`packages/main/package.json`、根 `package.json` 同步更新

### Worktree 隔离增强

#### B-62e1 — 禁止 INIT_CHECK 默认自动 bootstrap commit

- `handlers/story-advance.ts` 移除 INIT_CHECK 阶段的自动 `git commit`，改为输出提示让用户显式确认
- 避免 worktree 创建时在用户不知情的情况下产生 commit

#### B-5b3e — INIT_CHECK bootstrap 只落 story 分支

- `handlers/worktree.ts` 重构 bootstrap 流程：资产文件（`.claude/`、`.Codex/`）只写入 story 分支，不再污染当前本地分支
- 配套 `scripts/verify-init-check-bootstrap.mjs` 回归验证

### 测试覆盖与元数据回链

#### B-1860 — @flow 步骤描述校验

- `tasks/types.ts` 新增 `description` 字段到 flow step 类型定义
- `tasks/extract.ts` 从源码注释中提取 flow step description
- `tasks/validate.ts` 新增校验规则：无 description 的 flow step 报 warning
- 配套 `scripts/verify-flow-step-desc.mjs`

#### B-4b17 — 高优先级能力 @task 元数据回链

- 为 `cli-engine.ts`、`fixture.ts`、`test-auto.ts`、`worktree.ts`、`extract.ts`、`validate.ts` 中已落地但缺少 `@task` 注释的高优先级函数补充元数据
- 确保 `aux_scan` 能准确反映当前代码的能力覆盖率

#### B-1dc6 — stack-layering 边界原则代码回链

- `machine.ts`、`store.ts`、`story-advance.ts`、`test-story.ts` 补充 `@stack-layer` 注释，标明各模块所属的架构层（core / handler / runner）
- 回链到 `docs/requirements/decisions/stack-layering.md`

#### B-f8af — StoryStore state 持有入口覆盖

- `core/store.ts` 新增 83 行，补充 state 入口的 `@test` 注释和类型守卫
- 配套 fixture 覆盖所有 state 读写路径

#### B-e1bd — CLI flags 与 metadata cross-check fixture

- `cli-prompts.ts` 调整 43 行，增强 flag 解析一致性
- 补充 fixture 覆盖 CLI flag 组合与 metadata 交叉校验场景
- `sandbox` 模式下允许 fixture 使用 `import()` 加载本地模块

### 流程修复与门禁增强

#### B-b2b3 — worktree 中资产说明 + null testIntent 门禁

- `core/machine.ts` 增加 null testIntent story 的 DONE gate 豁免逻辑
- `core/reviewer-status.ts` 适配 null testIntent 的 reviewer 状态判断
- `core/types.ts` 扩展类型定义
- `AGENTS.md` 补充 worktree 中 `.Codex/` 和 `.claude/` 资产的说明
- 配套 `scripts/verify-testintent-null-gates.mjs`

### Bug 修复

- `story_list` 不再把已 DISCARDED 的 bug story 计入活跃列表（`story-query.ts`，配套验证脚本 `verify-story-list-bug-summary.mjs`）
- 清理两个误创建的 story（B-5a36、B-b568）的 revert commit
- `koala: reconcile completed story metadata` 修正已完成 story 的元数据一致性

### 统计

- **完成 story 数**：13（B-1860、B-4b17、B-1dc6、B-f8af、B-e1bd、B-b2b3、B-62e1、B-5b3e、B-9ba3、B-a591、B-17a6、B-0fb7、B-48ac）
- **新增文件**：~215 files changed, +16,345 / -179 lines
- **新增子包**：`packages/lab/`（17 个源文件，1,396 行）
- **版本**：0.2.1.1 → 0.2.2

---

## Koala 0.2.1.1 - 2026-04-16

本次版本把当前未提交的 `implementation-reviewer` 资产补齐工作，与最近一轮已经落地的安全护栏、runtime 稳定性、review/artifact 统一和 Codex 接入增强一起收敛成一个可发布版本。

### 本次纳入的未提交内容

- 新增 `implementation-reviewer` agent，分别落在 `.claude/agents/implementation-reviewer.md` 与 `.Codex/agents/implementation-reviewer.md`，把“实现层风险审查”从 fixture/testIntent/user-value 审查中拆出来，职责边界更清楚。
- `packages/main/src/init-assets.ts` 把 `implementation-reviewer.md` 纳入默认生成资产，后续初始化新项目时 Claude/Codex 两侧都会同步带上这类 reviewer。
- `packages/main/src/handlers/story-advance.ts` 在 `TEST_CASE_REVIEW` 提示中加入 implementation-reviewer advisory，明确主 agent 在进 TEST 前要做一次实现层自检。
- `README.md` 补充 `.Codex/agents/implementation-reviewer.md` 入口，确保仓库内的 Codex 使用说明和实际资产一致。
- 新增 `scripts/verify-implementation-reviewer.mjs`，并提供 `npm run test:implementation-reviewer` 脚本入口，用来校验 agent 资产、`init-assets` 注册以及 `story_advance` 提示文案没有漂移。
- 新增 `docs/requirements/decisions/stack-layering.md`，把 Claude Code / Codex、Superpowers、Koala 三层职责做成一份可复用的边界说明，便于后续继续演进 workflow 与 substrate。

### 本版本一并包含的已提交能力

#### 安全与破坏性操作护栏

- `5526c86`, `d7343fa`: 为危险命令补上 dry-run 与 confirm 护栏，降低误执行和误伤仓库状态的风险。
- `22ee17d`, `f5f2e93`: 为 `test_auto` 的 destructive 路径增加显式防护，避免 fixture/test 回归时直接把工作区清掉。
- `713ebd3`, `11ea54c`: 为上述护栏补回归测试，保证提示语和阻断条件稳定。

#### Runtime、状态机与 reviewer/artifact 统一

- `27d8adc`, `5c598d8`: 强化 runtime reviewer artifact flow，让 reviewer 状态与 artifact 消费规则更一致。
- `336b5c9`, `0efd9d8`: 引入 implementation review result protocol，允许 implementation-reviewer 的结构化结果进入主流程。
- `70e2c06`, `dd8b32e`: 增加 phase-aware artifact contract，并统一更多 artifact consumer。
- `888cfcb`: 阻止 cross-session story advance，减少多人/多 session 并发时误推进 phase 的问题。
- `34c7cc5`: convergence backlog 不再把 `DISCARDED` story 当成未完成项，回收列表更准确。
- `91a2b3f`, `5031571`, `1941605`: 稳住 `INIT_CHECK` bootstrap 与相关 fixture，减少 worktree 启动过程里的竞争态。
- `c989cae`, `9ef6cdf`: 修复 linked worktree zombie 检测，避免历史 worktree 残留持续污染运行态判断。

#### 可观测性、入口与 agent 使用体验

- `c1494fa`: 升级 `session_brief` 指挥台，让新 session 更快拿到 active story、health 和 next step。
- `6a0e9be`: 加入 role-aware telemetry，后续可按 agent 角色区分运行记录。
- `2c4fb0b`: 引入 product-reviewer lane，把“用户价值是否真的闭环”的提醒带进流程。
- `c9610d8`: 产品化 Codex onboarding 资产，统一 `.Codex` 入口与 transform 约束。
- `9fe0883`, `fa4a38d`: 稳固 koala 入口与 truth CLI wrapper，让 bootstrap / wrapper 场景更可靠。
- `0e21a41`, `46438f1`: 加强 fail-fast audit 与 health 留痕，silent catch 和异常观测更加系统化。
- `5a3e4f5`, `a9a58cb`, `2400e68`: 继续补 anti-stall、framework gap 与 browser screenshot smoke 这类高风险空洞，减少“看起来能跑、其实没覆盖”的盲区。

### 版本影响

- 对使用 Koala 自己维护 story 流程的仓库来说，这一版把 reviewer 体系从“工程覆盖”和“用户价值”进一步延伸到“实现质量”层，收尾自检会更完整。
- 对日常 CLI 使用来说，这一版重点在于减少 destructive 误操作、提升 worktree/runtime 稳定性，并强化 Codex/Claude 双端资产一致性。
- 对后续版本演进来说，`stack-layering.md` 为 runtime / workflow / substrate 三层边界提供了更清晰的落脚点，后续做能力拆分时更容易解释“该放在哪一层”。

### 建议验证

- `npm run test:codex-assets`
- `npm run test:implementation-reviewer`
