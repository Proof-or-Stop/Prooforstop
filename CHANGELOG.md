# Changelog

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
