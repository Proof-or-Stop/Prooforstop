<!-- koala:start -->
# Koala 模块分类与流程

本文按当前仓库约定整理 Koala 的模块分类、职责边界和 Story 流程。

当前生命周期以第二版 Koala flow 为准：

```text
INIT -> INIT_CHECK -> PLAN/快速跳过 -> DEV -> REVIEW -> TEST -> DONE
```

旧文档中出现的 `TEST_CASE`、`TEST_CASE_REVIEW`、`testIntent`、fixture-only validation、`test_auto` 等，是历史背景。当前替代口径是：

- checklist item 上的 `verificationIntent`
- DEV / REVIEW / TEST 阶段记录的 `verificationEvidence`
- REVIEW 阶段的 `koala-review-test-coverage`
- TEST 阶段的 `koala validate`

## 一句话定位

Koala 不是 agent runtime，也不是完整 agent 方法论层。Koala 的定位是：

> project execution and verification substrate

更直白地说：

> Koala 负责把需求、阶段、门禁、证据、bug、review 结果落成可判定、可追踪、可复查的项目状态。

## 三层体系

| 层 | 回答的问题 | 负责什么 | 不负责什么 |
|---|---|---|---|
| Claude Code / Codex Runtime | agent 在哪里运行、原生有什么能力 | 模型、对话上下文、tool calling、subagent、UI 宿主、插件/skill 运行环境 | 不保存 story、checklist、gate、evidence 的真相源 |
| Superpowers / Skills Workflow | agent 应该按什么方法工作 | brainstorming、planning、review、verification-before-completion、subagent-driven development 等工作习惯 | 不长期保存项目状态和验证证据 |
| Koala Execution / Verification | 项目状态怎么推进、验证、复查 | story、checklist、phase、gate、worktree、artifact、review、bug、evidence | 不替代 Codex/Claude runtime，也不包办全部 agent methodology |

健康的组合关系是：

```text
用户 / agent
  -> Superpowers skills / workflow
  -> Koala CLI / MCP / story machine
  -> story / checklist / phase / gate / artifact / evidence
```

也可以概括成：

- Claude Code / Codex：让 agent 能工作
- Superpowers：告诉 agent 应该怎么工作
- Koala：记录并验证 agent 到底工作到了哪

## 仓库模块分类

| 分类 | 模块 | 负责什么 | 备注 |
|---|---|---|---|
| 核心包 | `packages/main` | Koala 核心 CLI、story 流程、phase、gate、worktree、验证主逻辑 | 全局 `@koala-agent/core` 主要来自这里 |
| 扩展包 | `packages/utils` | `aux_*`、`truth_*`、`tool_status` 等扩展工具 | 需要完整 bootstrap 入口加载 |
| 实验包 | `packages/lab` | 离线实验、reviewer/profile eval、compare、promote | 用于优化 agent/prompt，不直接替代 story 流程 |
| 完整入口 | `bin/koala.js` | 加载 `main + utils`，可选接入 `lab` | 仓库内优先使用 |
| Codex 入口 | `bin/koala-codex.js` | Codex 专用入口，记录 `source=codex` activity | 便于区分 Codex 与普通 CLI 调用 |
| Agent 资产 | full: `.Codex/agents/*`；thin: `.Codex/lattice.json` registry；legacy: `.Codex/koala.json` | test-intent、reviewer、implementation-reviewer 等角色 prompt | full 模式物化本地 prompt；thin 模式可省略本地 copy，由 package registry 解析；Claude 资产只在启用 Claude profile 时生成 |
| 真相源 | `docs/requirements/*` | 需求、架构决策、流程规范 | 不是当前执行状态 |
| 执行状态 | story / checklist / phase metadata | 当前做到哪、下一步是什么、门禁是否通过 | 不靠聊天记忆判定 |
| 验证资产 | verificationIntent / verificationEvidence / fixture / validate evidence | 证明需求是否满足 | 不能用“我觉得好了”代替 |
| 健康诊断 | `session_brief` / `status` / `next` / `doctor` | 恢复现场、发现 worktree/phase/残留问题 | 只读入口不应推进 phase |

## 代码内部分层

Koala 开发时遵循数据、逻辑、渲染三层解耦。

| 层 | 定义 | 应该放什么 | 不应该放什么 | 验证方式 |
|---|---|---|---|---|
| 数据层 | 纯状态定义和存储 | story/checklist/bug/evidence 的结构、读写、持久化 | 业务判断、phase gate、渲染输出 | schema、CLI、fixture |
| 逻辑层 | 纯业务规则，不依赖 DOM/IO/渲染 | phase transition、gate、riskSignals、validate 规则、review 判定 | UI 文案、DOM、终端格式化细节 | fixture、unit、story 级验证 |
| 渲染层 | 尽可能轻薄，只映射状态到 UI/输出 | CLI 文案、session_brief/status 输出、dashboard 展示 | 业务规则和持久化逻辑 | 输出快照、浏览器 trace |

新建函数时先判断属于哪一层：状态存储归数据层，业务判断归逻辑层，展示映射归渲染层。

## Story 流程总表

| 阶段 | 谁负责 | 主要动作 | 关键产物 | 门禁/完成条件 | 下一步 |
|---|---|---|---|---|---|
| INIT | 主 agent | `story_create` 创建 story | story metadata | story 已创建 | `story_advance INIT_CHECK` |
| INIT_CHECK | CLI 自动 | 创建 `.worktrees/B-xxx/`，切本地 `story/B-xxx` 分支 | 独立 worktree | worktree 创建成功，提示 `cd` | 进入 worktree 后推进 PLAN |
| PLAN / 快速跳过 | 主 agent + test-intent agent | 理解需求、拆 checklist、写 `verificationIntent`、必要时写 decision | understanding、checklist、verificationIntent、decision | story review / 计划审查无 blocker；高风险 story 要有 decision + preMortem | DEV |
| DEV | 主 agent | 实现代码、逐项更新 checklist、记录 `verificationEvidence` | 代码改动、evidence、done checklist | checklist 的用户可观察结果已实现；改动已提交 | REVIEW |
| REVIEW | reviewer / CLI gate | 实现审查、测试覆盖审查、`koala-review-test-coverage` | review result、coverage result、findings | reviewer 认可；coverage 对应 verificationIntent；问题已回 DEV 修复 | TEST |
| TEST | CLI 自动 + 主 agent 处理失败 | 跑 `koala validate` / story 级验证 / 必要回归 | validation evidence、bug report | 全部 PASS；bug 全 fixed；evidence 对应当前 HEAD | DONE |
| DONE | CLI 自动 + 用户价值验收 | 合并回本地 main、清理 worktree、确认用户价值 | merged story、清理后的 worktree 状态 | 测试证据新鲜，story 分支包含 main，用户从产品角度认可 | 结束 |

## 回退规则

| 触发点 | 回退到 | 原因 |
|---|---|---|
| PLAN 审查失败 | PLAN | checklist、verificationIntent 或 decision 不足 |
| REVIEW 发现实现问题 | DEV | 需要改代码、补 evidence 或修复行为 |
| REVIEW 发现覆盖问题 | DEV 或 REVIEW | 需要补验证覆盖、补 evidence 或调整 checklist |
| TEST 失败 | DEV | 自动/手动记录 bug 后修复 |
| DONE gate 发现 story 分支未包含 main | 当前 worktree | 需要 merge main 并解决冲突 |
| 用户认为产品价值未达成 | DEV 或 PLAN | 工程通过不等于任务完成 |

## 标准执行链

| 顺序 | 命令/动作 | 说明 |
|---:|---|---|
| 1 | `koala session_brief` | 每个新 session 或恢复工作的第一步 |
| 2 | `koala aux_doc_list` | 找相关真相源、设计文档和入口说明 |
| 3 | `koala story_create ...` | 创建 story，停在 INIT |
| 4 | `koala story_advance ... INIT_CHECK` | 创建 story worktree |
| 5 | `cd .worktrees/B-xxx` | 从 PLAN 起必须在 story worktree 内 |
| 6 | PLAN 产物 | understanding、checklist、verificationIntent、必要 decision |
| 7 | `koala story_review ...` | 对抗审查 |
| 8 | `koala story_advance ... DEV` | 进入开发 |
| 9 | 改代码 + evidence + checklist done | 只在 DEV 改代码 |
| 10 | `git add` + `git commit` | 进入 REVIEW / TEST 前保持干净 |
| 11 | REVIEW | 实现审查 + 覆盖审查 |
| 12 | TEST | `koala validate`，失败回 DEV |
| 13 | DONE | merge 本地 main、清理 worktree |
| 14 | 用户价值确认 | 用户从产品视角认可，才是真完成 |

并行开发只使用本地 git worktree + 本地分支。`story/*`、`codex/*`、`lab/*` 等任务分支是本地实现细节，不要 push 到 GitHub/origin；需要远端发布时，只在本地 main 干净且已验证后 push main。

## Phase 里的工具边界

| 阶段 | 常用工具 | 边界 |
|---|---|---|
| 全阶段 | `story_get`、`story_list`、`checklist_get`、`session_brief`、`status`、`next` | 只读恢复现场 |
| PLAN | `story_update`、`story_review`、`checklist_add`、`checklist_update`、`testintent_handoff` / verification handoff | 主要补需求、拆解、验收意图，不改代码 |
| DEV | `checklist_update`、`fixture_batch_add`、`fixture_get`、`fixture_update`、诊断工具 | 可改代码，可提前补验证，但要记录 evidence |
| REVIEW | reviewer 命令、coverage gate、只读 fixture/story 查询 | 审实现和覆盖，不把 reviewer 当障碍绕过 |
| TEST | `koala validate`、story 级测试、bug 工具 | 标准验证失败应回 DEV 修复 |
| DONE | `story_advance DONE` | 合并、清理、收束 |

## 三方制衡

| 角色 | 职责 | 关键原则 |
|---|---|---|
| 主 agent | 写需求、拆 checklist、写代码、写验证、修 bug | 不是裁判；reviewer fail 时优先反思和修复 |
| test-intent agent | 写验收意图，逼出 happy/edge/adversarial | 对抗姿态，避免主 agent 自己给自己出简单题 |
| test-case-reviewer / implementation reviewer | 审验收覆盖、审实现、记录结论 | 有独立判定权，结果通过 CLI 留痕 |
| 用户 | 最终产品价值裁决 | “测试通过”不等于“用户觉得好了” |

## 完成定义

Koala 里“工程完成”不等于“任务完成”。

真正完成需要同时满足：

1. Story phase 到 DONE。
2. 验证证据对应当前 story HEAD。
3. bug 全部 fixed。
4. worktree / 本地 branch 生命周期被正确收束，没有残留任务 worktree，也没有把任务分支推到远端。
5. 用户能从产品视角说“好了”。

因此，Koala 的完成不是“函数返回正确”或“链路打通”，而是：

> 系统有证据证明需求被实现，reviewer 能复查，用户能感受到价值。
<!-- koala:end -->
