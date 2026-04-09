# koala 多角色分离改造方案

> 2026.04 · 把 plan / 对抗 / 实现 / 测试验证 4 个职责从"一个 main agent 一身兼任"拆成可独立演化的角色

## 背景

koala 现在的实际角色分工只有 1.5 个：
- **main agent**：PLAN / DEV / TEST_CASE / TEST / DONE 全程主力
- **test-intent-reviewer**：只审 testIntent 文本质量
- **test-case-reviewer**：只审 fixture 设计

main agent 长期兼任"规划者 / 对抗者 / 实现者 / 验证者"四种心智模式，观察下来这种混合是大部分"偷懒类 bug"的根因：
- **PLAN 阶段**：想快点进 DEV，checklist 拆得粗、跳 testIntent、绕 decision
- **DEV 阶段**：同一个脑子既写代码又判断"是否满足 checklist"，自我打分宽松
- **TEST 阶段**：看到 fail 倾向于回改测试而非回改代码（幸存者偏差 — 改测试成本低）
- **DONE 阶段**：急着 merge，可能把"没跑通的真机验证"叙述成"已验证"

用户反复命中的痛点（做一半就汇报完成、绕 checklist、测试虚假通过）几乎都落在"同一 agent 同时持有'想做完'和'要严格'两个矛盾目标"这个根本矛盾里。

本文档提出**渐进的角色分离方案**，不是一步到位拆 4 个独立 agent。

## 核心判断

### 为什么不一口气拆 4 个独立 agent

1. **"对抗"角色的边界极难画清**。独立 red-team agent 最常见的失败模式不是不挑刺，而是挑一堆通用模板刺（磁盘满了怎么办 / 网络断了怎么办），淹没真正的高信号风险。koala 现在的 `riskSignals` + B-5010 的 `story_review_dismiss` 机制已经侧面证明了这点——dismiss 的出现就是因为 story_review 的 false-positive 太多。
2. **4 个独立 agent = 4 份 context window**。每次子 agent 启动是 fresh context，plan→对抗→实现→测试之间传递的上下文要在 prompt 里 inline 重建，token 成本是线性叠加。solo dev 预算下不划算。
3. **koala 现有机制（phase state machine / watchdog / activity.jsonl / signed review / hooks）都假设"一个 agent 全程在场"**。一次拆 4 个角色意味着这些机制全部要同步改，改动面大到难以安全回滚。
4. **真实痛点是否需要 4 个角色才能解决，尚未验证**。如果真实根因是 prompt 质量或 checklist 颗粒度，拆再多 agent 也无效。

### 真正值得独立的角色

经过痛点溯源，**只有 "实现" 这一个角色的独立收益是明确的**：
- 它要大量读写文件，context 污染最重
- 它的心智模式（"把事做成"）跟 plan 和对抗的心智模式（"挑毛病 / 想可能性"）最冲突
- 独立出来后可以收紧工具权限（只读改代码 + 跑测试，不能动 phase / 不能动 story 元数据）
- 可以跑在独立 worktree 里，自然隔离副作用

**"测试验证" 这个角色其实不需要 LLM**。koala 已经有 test_auto 这个确定性脚本，真正需要 LLM 判断的只有"测试失败时的根因分析"——这是按需触发的诊断角色，不是常驻角色。

**"对抗" 这个角色第一阶段用 self-critique 模式实现**（plan agent 写完 checklist 后切换心智模式挑自己的刺），比独立 agent 省一次 context 冷启动，经验上效果接近，关键是**能先验证边界是否可行**。如果 self-critique 数据说明对抗输出确实有价值，再考虑拆独立 agent。

### 目标架构（终态）

```
┌──────────────────────────────────────────────────────────┐
│                    main agent (coordinator)              │
│  负责 phase 推进、调度子 agent、汇报用户                  │
│  心智模式：规划者 + self-critique 模式的对抗者             │
└─────┬────────────────────────┬──────────────────────────┘
      │                        │
      │ Agent(implementer)     │ Agent(test-analyst)
      │                        │ (仅在 test_auto fail 时)
      ▼                        ▼
┌──────────────┐        ┌────────────────┐
│  implementer │        │  test-analyst  │
│  心智模式:    │        │  心智模式:       │
│  "把事做成"   │        │  "根因分析"      │
│  - Read/Edit │        │  - 读 diff       │
│  - Bash(koala│        │  - 读失败 log    │
│     /node/   │        │  - 写 bug.json   │
│     npm)     │        │  - 决定回改代码  │
│  - worktree  │        │    还是改测试    │
│    隔离       │        └────────────────┘
│  - update_   │
│    task_state│
│    汇报      │
└──────────────┘
         │
         ▼
┌──────────────────────────┐
│  test runner (脚本层)      │
│  DEV → TEST_CASE → TEST    │
│  phase transition 时自动跑 │
│  非 LLM，确定性输出         │
└──────────────────────────┘
```

**角色间通信走 artifact 文件，不走对话传话**（signed review 机制的推广）：

| artifact | 写入者 | 读取者 |
|---|---|---|
| `checklist.json` | main (plan mode) | all |
| `decision.json` | main (plan mode) | all |
| `plan-critique.json` (新) | main (critique mode) | main (plan mode 回应) |
| 源代码 + fixture | implementer | test runner / test-analyst |
| `implementation-log.jsonl` (新) | implementer | test-analyst |
| `test-runs.json` | test runner | test-analyst / main |
| `test-evidence.json` | test runner | main (DONE gate) |
| `bug.json` | test-analyst | main / implementer (修复) |
| `summary.json` | main (DONE 时) | user |

## 不引入的设计

明确排除以下方案，每条都有理由：

| 方案 | 排除理由 |
|---|---|
| 独立 red-team agent（一开始就拆） | 边界未经实战打磨，先验证 self-critique 模式 |
| 每个 phase 一个独立 agent | phase 数 ≠ 角色数；应该是 4 个角色在 8-9 个 phase 里按需调度 |
| agent 间直接对话传话 | 对话 context 不稳定，必须落 artifact 当物证 |
| plan agent 直接修改 checklist 回应 critique | 丢失 critique 历史；critique 和 resolve 都要留痕 |
| test-analyst 常驻在线 | 成本高；test_auto 脚本已足够，LLM 只在 fail 时诊断 |
| 把 test_auto 改成 LLM tool call | 反向；要降级为 phase transition 的自动动作 |
| implementer 可以调 story_advance | 角色越权；phase 推进只能 main agent 决定 |
| implementer 可以写 bug.json | 利益冲突；bug 识别应该由独立角色 test-analyst 做 |

## 风险与回滚

**最大风险**：implementer 独立后，如果"偷懒率"没有下降，说明问题不在角色混合，而在 prompt 质量或模型能力。届时需要回滚到 main agent 兼任 DEV，不能硬推下一步。

**回滚点**：
- Wave 0 结束时（实现 agent 独立 + 遥测）
- Wave 1 结束时（test 脚本化 + analyst）
- Wave 2 结束时（self-critique）

**每个 wave 结束时强制做 data review**，不达预期就停在当前 wave，不进下一个。

---

## Story 总览

按波次组织，每个波次独立可验证，波次间有数据 gate：

| 波次 | Story | 工作量 | 目标 | 优先级 |
|---|---|---|---|---|
| **Wave 0 — 验证 implementer 独立的 ROI** | | | | |
| S-01 | implementer agent 定义（`.claude/agents/koala-implementer.md`） | 1 天 | 写出一个能跑的 agent 定义 | P0 |
| S-02 | DEV / TEST_CASE phase 调度 implementer | 2 天 | phase transition 自动拉起子 agent | P0 |
| S-03 | 按角色分 tag 的 activity.jsonl 遥测 | 1 天 | 能用数据对比 before/after | P0 |
| S-04 | Wave 0 data review（2 周观察期后） | 0 天 | 决定是否进 Wave 1 | P0 gate |
| **Wave 1 — 测试执行确定性化** | | | | |
| S-05 | test_auto 从 LLM tool 降级为 phase transition 自动动作 | 2 天 | 测试执行脱离 LLM 判断 | P1 |
| S-06 | test-analyst fork agent（仅在 fail 时触发） | 2 天 | 失败诊断独立 | P1 |
| S-07 | test-evidence.json 协议收紧 + bug.json 归属字段 | 1 天 | artifact 契约硬化 | P1 |
| S-08 | Wave 1 data review | 0 天 | 决定是否进 Wave 2 | P1 gate |
| **Wave 2 — plan self-critique 模式** | | | | |
| S-09 | plan agent self-critique mode 切换指令 | 2 天 | 让 main agent 用两次 turn 扮演两个心智 | P2 |
| S-10 | plan-critique.json artifact + dismiss 机制 | 2 天 | critique 留痕 | P2 |
| S-11 | PLAN_REVIEW phase 插入 + gate 条件 | 1 天 | phase machine 容纳 critique 步骤 | P2 |
| S-12 | Wave 2 data review | 0 天 | 决定是否拆独立 red-team agent | P2 gate |
| **Wave 3 — 条件性** | | | | |
| S-13 | （条件）独立 red-team agent 定义 | 2 天 | 仅当 Wave 2 数据证明 self-critique 不够时做 | P3 |
| **横切关注点** | | | | |
| S-X1 | artifact 写权限矩阵（按角色限制） | 1 天 | 角色越权时硬拦截 | 随 S-02 做 |
| S-X2 | watchdog / session_brief 的角色感知改造 | 1 天 | 子 agent 切换不被误判为 stuck | 随 S-02 做 |
| S-X3 | hooks 的 role tag 透传 | 0.5 天 | hook 脚本知道当前是哪个角色 | 随 S-03 做 |

**Wave 0 总计 4 天**，是决定整个改造方向的关键波次。Wave 0 后的数据决定是否继续。
**Wave 0 + Wave 1 + Wave 2 理论工作量约 15 天**，但每个 wave 之间有强制观察期。

### 波次间的依赖

```
Wave 0: S-01 → S-02 → S-03 → S-04 (gate)
                ↓      ↓
              S-X1   S-X2   S-X3  (横切，跟 Wave 0 同步做)

Wave 1: S-05 → S-06 → S-07 → S-08 (gate)

Wave 2: S-09 → S-10 → S-11 → S-12 (gate)

Wave 3: (conditional on S-12 outcome) S-13
```

**gate story 不是空占位**，它是一次强制的数据回顾会议（你自己跟自己开），输出是"继续 / 停在当前 wave / 回滚"三选一的书面决策，写入 decision.json。

---

## Wave 0：验证 implementer 独立的 ROI

**目标**：在不改动 koala phase machine 和任何现有 artifact 的前提下，把 DEV + TEST_CASE 两个 phase 的实际执行委托给一个独立的 sub-agent，观察 2 周后对"偷懒率"的影响。

**Wave 0 不改变的东西**：
- phase 列表不变
- 所有 artifact schema 不变
- main agent 继续负责 phase 推进和用户汇报
- watchdog / activity.jsonl / hooks 的核心行为不变

**Wave 0 改变的东西**：
- DEV 阶段的代码编写工作由 implementer sub-agent 做
- activity.jsonl 增加 `role` 字段区分 main / implementer

---

### S-01：implementer agent 定义

**Description**

新建 `.claude/agents/koala-implementer.md`，定义一个专职"实现"角色的 CC sub-agent。这个 agent 被 main agent 通过 `Agent(subagent_type: "koala-implementer", ...)` 调起，负责完成 DEV 和 TEST_CASE phase 的具体编码工作。

关键设计：
- 权限收紧：只能 Read / Edit / Write / Glob / Grep / Bash 的子集。Bash 白名单：`koala:*`, `node:*`, `npm:*`, `pnpm:*`, `git:(status|diff|log|add|commit)`。黑名单：`rm`, `git reset --hard`, `git push`, `curl | sh`
- `permissionMode: acceptEdits`（不弹确认）
- `isolation: worktree`（自动复用 koala 的 worktree-per-story）
- system prompt 的心智模式锁定为"把事做成"，明确禁止它推进 phase / 写 bug.json / 修改 checklist 元数据
- prompt 末尾硬写一条："完成后只返回一段 plain text 总结，不要尝试 story_advance，不要自作主张决定是否进入 TEST phase"

Agent 的输入 prompt 由 main agent 构造，必须包含：
1. 当前 story id + phase
2. checklist 中 status != done 的 item 列表（含 title + context）
3. 已读文件的简短索引（避免子 agent 重复 Read）
4. 允许调用的 koala 命令（`checklist_update`, `update_task_state`, `fixture_batch_add`）
5. 禁止调用的 koala 命令清单

**Checklist**

1. **title**：创建 `.claude/agents/koala-implementer.md` 文件与 frontmatter
   **context**：frontmatter 包含 `name`, `description`, `whenToUse`, `tools`, `disallowedTools`, `permissionMode: acceptEdits`, `isolation: worktree`, `model: inherit`。whenToUse 要明确"只在 koala story 的 DEV / TEST_CASE phase 被 main agent 调用，不直接响应用户"

2. **title**：编写 system prompt 正文
   **context**：5 个 section：
   - "你是 koala implementer"（角色锚定）
   - "你的唯一目标：完成 checklist 中 pending 的 item"（心智模式锁定）
   - "严格禁止"（不能 story_advance / 不能改 phase / 不能写 bug.json / 不能改 checklist item 的 testIntent）
   - "工具使用规范"（read-before-edit / 同一 item 只有一个 in_progress / 完成后调 update_task_state）
   - "完成条件与返回格式"（返回一段 2-5 行的总结，不要多话）

3. **title**：验证 CC 能加载这个 agent
   **context**：在 koala-agent repo 根目录启动 CC，跑 `/agents` 或者让主 agent 调 `Agent(subagent_type: "koala-implementer", description: "smoke", prompt: "echo hello")`，确认 agent 被识别且能运行

4. **title**：真机 smoke：让 implementer 做一个 trivial 改动
   **context**：在一个 scratch story 上让 implementer 新建一个 hello.txt 并 update_task_state。确认：(a) 文件真的创建了 (b) checklist item 真的被标 done (c) 没有 story_advance 调用 (d) 返回总结简洁

5. **title**：验证权限收紧生效
   **context**：故意让 implementer 尝试 `rm` 或 `git push`，确认被拦截。尝试 `story_advance` 确认子 agent 没这个 tool（或被 prompt 层驳回）

**测试方向**
- happy：implementer 正确完成一个 2-3 item 的 checklist
- edge：implementer 遇到 checklist item 前置依赖没做时，要停下来报告而不是跳过
- adversarial：implementer 尝试越权操作（story_advance / rm / push）时必须失败

**验收**
- `.claude/agents/koala-implementer.md` 存在且 frontmatter valid
- smoke 证明 agent 能被 CC 识别并执行
- 权限收紧可证

**触点**
- 新建：`.claude/agents/koala-implementer.md`
- （可选）新建：`docs/story/actives/B-xxxx/smoke/implementer-smoke.md` 作为真机验证记录

---

### S-02：DEV / TEST_CASE phase 调度 implementer

**Description**

让 main agent 在进入 DEV 或 TEST_CASE phase 时**自然倾向于** delegate 给 implementer。这个 story 是 prompt + 流程的改造，**不修改 koala 核心代码**。

改造两个点：
1. **CLAUDE.md 在顶部加一段角色分工说明**：告诉 main agent "DEV 和 TEST_CASE 的代码编写工作应该 delegate 给 koala-implementer sub-agent"
2. **story_advance 进入 DEV 或 TEST_CASE 时的 nextStepHint 里加一条**："建议调用 Agent(subagent_type='koala-implementer', ...) 执行本 phase 的编码工作"

注意：**不强制**。main agent 可以选择不 delegate，原因是有些 story 颗粒度极小（chore / docs 类），delegate 一次子 agent 比自己做还贵。让 main agent 根据 story 的 type 和 priority 自行判断。

**为什么不在代码层面硬编码 delegate**：
- koala 的核心价值是"机制不假设 agent 实现"，硬编码 delegate 就把 koala 绑死在 CC 上
- main agent 可能是 CC，也可能是 observer/Mastra agent（你现在两条路径都在走）
- 硬编码要同时维护两套 phase machine，太重

**Checklist**

1. **title**：在 `packages/koala/CLAUDE.md` 的顶部加"子 agent 分工"小节
   **context**：说明 koala 支持 implementer sub-agent，并给出 trigger 条件：story.type 在 `[feature, bug, refactor]` 且 priority >= medium 且 checklist item 数 >= 2 时推荐 delegate。type 在 `[chore, docs]` 或 item 数 < 2 时 main agent 自己做更快

2. **title**：story_advance 进入 DEV 的 hint 增加 delegate 建议
   **context**：在 `handlers/hints.ts` 的 `story_advance.DEV` hint 里追加一行："建议 Agent(subagent_type='koala-implementer', description='execute DEV', prompt='story id + pending checklist items + allowed tools')"。只在 story.type/priority/size 满足条件时追加

3. **title**：story_advance 进入 TEST_CASE 的 hint 同上
   **context**：同理，但 prompt 模板略不同（强调写 fixture 而不是写实现代码）

4. **title**：CLAUDE.md 加一段"implementer 没做完的收尾义务"
   **context**：明确 main agent 在 implementer 返回后必须：(a) 读 updated checklist 验证 in_progress 全部清零 (b) 读 implementation-log.jsonl 获取改动概览 (c) 决定是否直接 story_advance。不允许盲信子 agent 的总结

5. **title**：真机验证：跑一个真 story 走一次 DEV delegate
   **context**：选一个现有 backlog 的小 story，phase=PLAN，让 main agent 走 DEV 阶段。观察：(a) main 是否真的 delegate 了 (b) implementer 返回后 main 是否做了验证 (c) 整个 wall time 是否合理

**测试方向**
- happy：中等 story 被正确 delegate 并完成
- edge：trivial story（chore 类）main agent 选择不 delegate 自己做
- adversarial：implementer 返回 "已完成" 但 checklist 仍有 in_progress，main agent 必须察觉并要求继续

**验收**
- CLAUDE.md 顶部有清晰的子 agent 分工说明
- story_advance DEV/TEST_CASE 的 hint 文本包含 delegate 建议
- 真机跑通一次 delegate 并写入 DOGFOOD-EVIDENCE.md

**触点**
- 修改：`packages/koala/CLAUDE.md`
- 修改：`packages/koala/packages/main/src/handlers/hints.ts`

---

### S-03：按角色分 tag 的 activity.jsonl 遥测

**Description**

activity.jsonl 现在每条记录是 `{tool, args, status, at}`。加一个 `role` 字段（`main` / `implementer` / `test-analyst` / `unknown`），让 Wave 0 结束时能做数据分析。

`role` 的判断来源：环境变量 `KOALA_ROLE`。main agent 在 delegate 子 agent 时把这个变量塞到 sub-agent 的 env 里（CC 的 AgentTool 允许传环境变量或者用 initialPrompt 注入）。

注意这是 best-effort：如果 env 没传，role 字段为 `unknown`，不影响其它字段。

**为什么做这个 story 而不是等有数据后再加**：没有遥测分 role，Wave 0 结束时的 data review 就是瞎猜。这个 story 是 Wave 0 的 gate 的前提，必须在观察期开始前落地。

**Checklist**

1. **title**：activity.ts 加 `role` 字段
   **context**：在 appendActivity 的 record 对象里加 `role: process.env.KOALA_ROLE || 'unknown'`。schema 版本不变（新字段是 additive）

2. **title**：health.ts 同样加 role 字段
   **context**：health.jsonl 也要知道是哪个角色产生的 silent failure。同一个 env 变量来源

3. **title**：CLAUDE.md 的 implementer 段说明 env 变量注入
   **context**：告诉 main agent delegate 子 agent 时在 prompt 里带 `"你启动后第一个 Bash 调用是 export KOALA_ROLE=implementer"`。这个约定 ugly 但有效。TODO：未来 CC Agent tool 如果支持 env 透传就改

4. **title**：加一个简单的数据分析脚本
   **context**：新建 `packages/koala/scripts/wave0-review.sh`，按 role 分组统计 activity.jsonl 的 tool 频次、status=fail 比例、平均一个 story 的时长。输出可读表格

5. **title**：fixture：验证 role 字段正确写入
   **context**：单测构造带 KOALA_ROLE env 的调用，断言写入的 activity.jsonl 行含对应 role

**测试方向**
- happy：设置 env → activity.jsonl 和 health.jsonl 都记录正确 role
- edge：env 未设置时 role 为 'unknown'，不报错
- adversarial：env 值含空格/特殊字符时 sanitize 不破坏 JSONL

**验收**
- activity.jsonl 新行含 role 字段
- wave0-review.sh 能跑出分 role 的数据表
- fixture 覆盖

**触点**
- 修改：`packages/koala/packages/main/src/core/activity.ts`
- 修改：`packages/koala/packages/main/src/core/health.ts`
- 新建：`packages/koala/scripts/wave0-review.sh`
- 修改：`packages/koala/CLAUDE.md`（env 约定段落）

---

### S-04：Wave 0 data review（gate）

**Description**

S-01 ~ S-03 落地后，**强制观察 2 周**（至少 5 个 story 用 implementer delegate 跑完），然后做一次书面数据回顾。

回顾的关键指标：
1. **偷懒率变化**：跑完 story 后，"checklist 有 item 未真正完成就进 TEST / DONE" 的发生次数。before 是观察期前 2 周数据，after 是观察期数据
2. **DEV phase 时长变化**：delegate 是否显著拉长（因为有 agent spawn 冷启动）
3. **token 成本变化**：implementer context 重建 vs main agent 混做的总 token
4. **虚假汇报变化**：main agent 是否在 implementer 返回后没复核就 story_advance

**决策树**：

| 偷懒率 | DEV 时长 | Token 成本 | 决定 |
|---|---|---|---|
| 降低 >30% | <1.5x | <2x | ✓ 进 Wave 1 |
| 降低 10-30% | <1.5x | <2x | ⚠ 继续观察 2 周再决定 |
| 降低 <10% | 任意 | 任意 | ✗ 回滚 Wave 0，反思根因 |
| 任意 | >2x | 任意 | ⚠ 先优化 implementer prompt 再决定 |
| 任意 | 任意 | >3x | ✗ 成本不可接受，回滚 |

回顾结果写入本 story 的 `decision.json`，作为是否进入 Wave 1 的依据。

**Checklist**

1. **title**：等待观察期满 2 周且至少 5 个 story 用过 implementer
   **context**：这个 story 的 DEV 阶段就是"等"，不写代码。进入这个 story 的日期记录在 index.json 的 startedAt

2. **title**：跑 wave0-review.sh 收集数据
   **context**：输出按 role 分组的 tool 频次 / 失败率 / 时长。同时跑一次 before-period 的数据（从 git history 找到 S-01 之前 2 周的 activity.jsonl snapshot）

3. **title**：手工标注 "偷懒率"
   **context**：自动化判断"偷懒"很难。手工看过去 2 周每个 story 的 DONE merge commit，判断是否有 checklist 撒谎 / 测试虚假通过。写入 review.md

4. **title**：填 decision.json
   **context**：按上面决策树填 decision，`{decision: "proceed-wave-1" | "observe-more" | "rollback"}`，带详细 reasoning

5. **title**：根据决策执行
   **context**：proceed → 创建 Wave 1 story。observe-more → 不进新 wave，延长观察期。rollback → 删除 .claude/agents/koala-implementer.md 和 CLAUDE.md 的相关段落，恢复 main agent 兼任

**测试方向**
- 本 story 没有代码测试，只有数据回顾
- 可以写一个 fixture 验证 wave0-review.sh 的输出格式对常见 jsonl 输入是稳定的

**验收**
- decision.json 存在且含明确 `decision` 字段
- 观察期数据有存档（即使决定回滚也要留）

**触点**
- 新建：`docs/story/actives/B-xxxx/review.md`
- 填充：`docs/story/actives/B-xxxx/decision.json`
- （如果 rollback）修改：`packages/koala/CLAUDE.md`、删除 `.claude/agents/koala-implementer.md`

---

## Wave 1：测试执行确定性化

**前提**：Wave 0 的 S-04 gate 决定 `proceed-wave-1`。

**目标**：把测试执行从 LLM 判断里彻底剥离出来。LLM 只在诊断阶段出场。

---

### S-05：test_auto 从 LLM tool 降级为 phase transition 自动动作

**Description**

现状：test_auto 是 koala 的 handler，main agent 当作普通 tool 调用。问题：LLM 可以选择不调、调了选择性看结果、看了选择性汇报。

改造：把 test_auto 变成 `story_advance --phase TEST` 进入时**自动触发**的动作。main agent 不需要（也不能）显式调 test_auto，它只能调 story_advance，test_auto 作为 phase transition 的副作用运行，结果写入 test-runs.json，然后 phase 落到 TEST 或者回退到 DEV（根据结果）。

**关键契约**：
- `story_advance --phase TEST` 的返回值里包含 test 执行的完整结果（pass/fail 总数、第一个失败 case 的名字和 stdout tail）
- fail 时 phase 不进 TEST，留在 DEV，同时 nextStepHint 指向 test-analyst 诊断
- pass 时 phase 进 TEST，nextStepHint 指向 story_advance --phase DONE
- 原来的 test_auto handler **保留但标记 @deprecated**，只给 sub-agent 或脚本直接调用用，main agent 被 prompt 层禁用

**为什么保留而不删除**：
- 已有 fixture 依赖它
- sub-agent（比如 test-analyst）调试时还用得到
- 删除是破坏性变更，要单独一条 story 做

**Checklist**

1. **title**：story-advance.ts 在 `newState === 'TEST'` 分支自动调 test_auto
   **context**：在 phase 变更生效**之前**调 test_auto，结果存到一个局部变量。只有 test_auto 全 pass 才真的让 phase 进 TEST；否则 phase 留在 DEV 且返回 fail 详情

2. **title**：story_advance 的返回值类型扩展
   **context**：加 `testResult?: { pass: number; fail: number; firstFailure?: { name: string; stdoutTail: string } }` 字段。type 定义在 `core/types.ts`

3. **title**：CLAUDE.md 明确 main agent 不要直接调 test_auto
   **context**：加一条"TEST 阶段的测试执行是 story_advance 的副作用，不要单独调 test_auto"。同时说明 test_auto 在 sub-agent / 脚本场景仍然可用

4. **title**：test_auto handler 加 @deprecated tag（main agent 调用时打 warning）
   **context**：handler 入口检查 `process.env.KOALA_ROLE === 'main'` 时 console.warn，提示"请通过 story_advance 间接触发"。不强拦，保留兼容

5. **title**：fixture：验证 story_advance TEST 时的测试执行和回退
   **context**：构造一个有 fixture pass 的 scratch story → story_advance TEST 成功进 TEST。再构造一个 fail 的 → story_advance TEST 失败留 DEV 且返回 testResult

**测试方向**
- happy：pass 情况正确进 TEST
- edge：fixture 目录为空时 test_auto 返回 "no tests"，phase 仍然可以进 TEST（trivial story 允许空测试）
- adversarial：test_auto 自己抛异常时，phase 不变，返回 error 明确告诉 main agent

**验收**
- 用真机跑一个 fail 场景，观察 story_advance TEST 正确回退
- fixture 覆盖 pass/fail/empty 三种路径

**触点**
- 修改：`packages/koala/packages/main/src/handlers/story-advance.ts`
- 修改：`packages/koala/packages/main/src/core/types.ts`
- 修改：`packages/koala/packages/main/src/handlers/test-runner-core.ts` 或 `test-auto.ts`
- 修改：`packages/koala/CLAUDE.md`
- 新建/修改：`packages/koala/packages/main/tests/fixtures/story-advance-test-auto.json`

---

### S-06：test-analyst fork agent（仅在 fail 时触发）

**Description**

新建 `.claude/agents/koala-test-analyst.md`。职责：当 story_advance --phase TEST 的 testResult.fail > 0 时，main agent 调 `Agent(subagent_type: "koala-test-analyst", prompt: 包含失败 case 名和 stdout tail + 被改的文件列表)`，由 analyst 判断根因。

analyst 的输出：
1. 根因分类：`code-bug` / `test-bug` / `environment` / `flaky` / `unknown`
2. 建议修复路径：回改代码 / 回改测试 / 重跑 / 升级 dep
3. 写入 `bug.json`（如果是 `code-bug` 或 `test-bug`）

analyst 的权限收紧：
- tools: Read / Glob / Grep / Bash(git diff|log|show) / `koala bug_report`
- **不能 Edit / Write**——它只诊断，不修复
- **不能 story_advance**——phase 推进是 main agent 的事

**为什么 analyst 不能修复**：避免"自己出题自己答"。analyst 诊断出 code-bug 后，必须回到 main agent → delegate 给 implementer 修，形成"诊断者 / 实现者"闭环。

**Checklist**

1. **title**：创建 `.claude/agents/koala-test-analyst.md`
   **context**：frontmatter: name, whenToUse="Use when koala test phase fails and needs root cause analysis", tools (Read/Glob/Grep/Bash 白名单), disallowedTools (Edit/Write/NotebookEdit), permissionMode: acceptEdits, isolation: worktree (复用 story worktree)

2. **title**：system prompt 写诊断工作流
   **context**：5 步：(1) 读 testResult.firstFailure.stdoutTail (2) git diff HEAD 看最近改动 (3) 读失败 case 的源文件 (4) 分类根因 (5) 写 bug.json 或返回决策。特别强调：不能动代码/测试，只能写 bug.json

3. **title**：story_advance TEST fail 分支加 analyst delegate hint
   **context**：hint 文本加一段"fail 了请调 Agent(subagent_type='koala-test-analyst', prompt='storyId + testResult JSON + recent diff hint')"。带具体 prompt 模板

4. **title**：真机 smoke：构造一个故意 fail 的 story 走完 analyst 流程
   **context**：scratch story，故意写个错的 fixture → story_advance TEST fail → 按 hint 调 analyst → 观察 analyst 是否正确分类和写入 bug.json

5. **title**：验证 analyst 不能越权修代码
   **context**：给 analyst 一个明显可修复的 bug，观察它是否尝试 Edit（应该被工具层拦下）或者正确返回"需要 implementer 修复"

**测试方向**
- happy：typo 类 code-bug 被正确诊断并写 bug.json
- edge：flaky 测试（第二次跑就 pass）analyst 返回 `flaky` 分类
- adversarial：analyst 尝试 Edit 时被工具权限拒绝

**验收**
- `.claude/agents/koala-test-analyst.md` 存在
- 真机 smoke 证明诊断闭环
- analyst 不能 Edit 可证

**触点**
- 新建：`.claude/agents/koala-test-analyst.md`
- 修改：`packages/koala/packages/main/src/handlers/hints.ts`
- 新建：`docs/story/actives/B-xxxx/smoke/analyst-smoke.md`

---

### S-07：test-evidence.json 协议收紧 + bug.json 归属字段

**Description**

Wave 1 引入了 implementer 和 test-analyst 两个角色写 artifact，现在的 test-evidence.json 和 bug.json schema 没有"谁写的"字段，数据流追溯困难。这个 story 是 schema 扩展 + 反串防御。

**test-evidence.json 增加字段**：
- `producedBy`: `'main' | 'implementer' | 'test-analyst'`
- `method`: `'manual' | 'story_advance_trigger' | 'analyst_repro'`
- `verifiedAt`: ISO timestamp

**bug.json 增加字段**：
- `identifiedBy`: `'main' | 'test-analyst'`
- `fixedBy`: `'main' | 'implementer'`
- `fixStatus`: `'open' | 'in_progress' | 'fixed'`

**写权限硬约束**：
- implementer 禁止写 bug.json（test-analyst 专属）
- test-analyst 禁止写 test-evidence.json（由 story_advance 脚本写）

这两条约束在 handler 层加 role check：`if (role === 'implementer' && handlerName === 'bug_report') throw` 这种。role 从 `process.env.KOALA_ROLE` 读（S-03 已经铺好的）。

**Checklist**

1. **title**：扩展 test-evidence.json schema + 迁移
   **context**：`core/types.ts` 加 `TestEvidence` 类型新字段。旧 test-evidence.json 读取时字段缺失用默认值，不破坏旧 story

2. **title**：story_advance 自动触发 test_auto 时，把 `producedBy: 'main'` + `method: 'story_advance_trigger'` 写入 test-evidence
   **context**：沿用 S-05 的逻辑，在写 test-evidence 时填新字段

3. **title**：扩展 bug.json schema + 迁移
   **context**：同上加字段，旧 bug.json 读取时用默认值

4. **title**：handler 层加角色写权限 check
   **context**：`bug_report` handler 入口检查 KOALA_ROLE。若是 `implementer` 则 throw `'bug_report is not allowed for role=implementer, delegate back to main for analyst dispatch'`。`test_auto` 入口同理检查非 `main` 角色

5. **title**：fixture：角色越权 test
   **context**：模拟 env KOALA_ROLE=implementer 调 bug_report，断言 throw

**测试方向**
- happy：各角色只能写自己的 artifact
- edge：KOALA_ROLE unset 时兜底为 'unknown'，按宽松规则允许（避免把老 session 卡死）
- adversarial：故意伪造 env 尝试越权，被拦

**验收**
- test-evidence.json 和 bug.json 新 schema 生效
- 角色写权限 check 有 fixture 覆盖
- 旧 story 兼容读

**触点**
- 修改：`packages/koala/packages/main/src/core/types.ts`
- 修改：`packages/koala/packages/main/src/handlers/bug.ts`
- 修改：`packages/koala/packages/main/src/handlers/test-runner-core.ts` 或 `test-auto.ts`
- 新建/修改：角色越权 fixture

---

### S-08：Wave 1 data review（gate）

**Description**

跟 S-04 同构。关键指标：
1. **测试虚假通过率**：before（main agent 可以直接调 test_auto 并选择性汇报）vs after（test 执行变成 phase transition 自动动作）
2. **test-analyst 的诊断准确率**：手工标注 analyst 写的 bug.json 里的 `identifiedBy` 判断是否真的击中根因
3. **DEV ↔ TEST 循环次数**：fail → analyst → implementer fix → 再 test 的往返次数

决策树跟 S-04 类似。输出写 `decision.json`。

**Checklist**

1. **title**：观察期 2 周 + 至少 3 个 story 经历 TEST fail 路径
   **context**：如果 2 周都没 fail 过，可能说明没覆盖到需要诊断的场景，延长观察期

2. **title**：跑 wave1-review.sh（基于 wave0 的分析脚本扩展）
   **context**：新增"测试虚假通过率"、"analyst 分类分布"等维度

3. **title**：手工校验 analyst 诊断准确率
   **context**：逐条看 bug.json，打标 correct / partial / wrong。写 review.md

4. **title**：填 decision.json 决定进 Wave 2 或停

**测试方向**、**验收**、**触点**：同 S-04 结构

---

## Wave 2：plan self-critique 模式

**前提**：Wave 1 的 S-08 gate 决定 `proceed-wave-2`。

**目标**：在不新建独立 agent 的前提下，让 main agent 在 plan 阶段经过一轮"切换心智模式挑自己的刺"，看看对抗输出是否有真实价值。

---

### S-09：plan agent self-critique mode 切换指令

**Description**

在 main agent 的 PLAN phase 流程里增加一步：checklist + testIntent 写完后，**通过一条 meta-prompt 指令让 agent 切换到 "red team 模式"**，读自己刚写的 plan 并挑刺。挑刺范围**硬锁定在 3 类**（避免通用噪声）：

1. **未验证假设**：plan 里的事实性陈述（"X 函数在 file Y 的 Z 行"、"接口返回 JSON"）必须有证据（文件路径 / 命令输出 / 文档链接）。缺证据的记 `unverified`
2. **边界缺失**：每个 checklist item 的 testIntent 如果只有 happy 没有 edge/adversarial，记 `missing-edge`
3. **决策未留痕**：plan 里隐含选了方案 A 而没解释为什么不选 B，记 `undocumented-decision`

**不挑**的类：
- 通用风险（磁盘、网络、信号）
- 实现细节（这是 implementer 的事）
- 测试覆盖率数字（这是 test-analyst 的事）

挑完后 main agent 切回 plan 模式，对每一条 critique 决定：
- `resolve` → 修改 checklist / testIntent / decision，记录对应修改
- `dismiss` → 写 dismiss reason（至少 20 字符），引用具体 story 上下文

**关键实现点**：self-critique 是 prompt 层的改造，不动 handler。通过 checklist_update 或 testintent_record 之后的 nextStepHint 引导 main agent 进入 critique 模式。

**Checklist**

1. **title**：在 `cli-prompts.ts` 加 `CRITIQUE_MODE_PROMPT` 常量
   **context**：这段 prompt 是 main agent 的"切换心智"指令。硬编码 3 类挑刺范围 + 3 类不挑的范围 + 输出格式要求

2. **title**：PLAN phase 完成触发条件
   **context**：什么时候 main agent 应该进 critique？定义：checklist 所有 item 都有 title + context + happy testIntent 后。在 `hints.ts` 的 `checklist_update` 或 `testintent_record` 的 hint 里注入"现在进入 critique 模式"的提示

3. **title**：为 critique 输出定义结构
   **context**：在 `core/types.ts` 加 `PlanCritique` 类型：`{ category: 'unverified' | 'missing-edge' | 'undocumented-decision'; itemId?: string; message: string; evidence?: string }`

4. **title**：在 CLAUDE.md 写 critique 模式的工作流
   **context**：明确告诉 main agent：(a) 进入 critique 时要切换心智，假设自己是 red team (b) 挑刺范围严格限定 (c) 挑完后要切回 plan 模式 resolve/dismiss

5. **title**：真机 smoke：跑一次 PLAN 阶段观察 critique 输出
   **context**：写一个故意有漏洞的 plan（假设没证据 + 缺 edge），观察 main agent 是否在 critique 阶段正确命中

**测试方向**
- happy：完整 plan → 3 类 critique 都能被命中一些
- edge：无可挑的 plan（理论上不该存在但模型可能）critique 输出为空数组不报错
- adversarial：main agent 在 critique 模式下挑了 "通用风险"，下一轮自己要驳回

**验收**
- CRITIQUE_MODE_PROMPT 存在且可被 hint 引用
- 真机验证 critique 输出结构正确

**触点**
- 修改：`packages/koala/packages/main/src/cli-prompts.ts`
- 修改：`packages/koala/packages/main/src/handlers/hints.ts`
- 修改：`packages/koala/packages/main/src/core/types.ts`
- 修改：`packages/koala/CLAUDE.md`

---

### S-10：plan-critique.json artifact + dismiss 机制

**Description**

给 critique 输出一个持久化位置 `docs/story/actives/B-xxxx/plan-critique.json`，schema：

```json
{
  "critiques": [
    {
      "id": "pc-1",
      "category": "unverified" | "missing-edge" | "undocumented-decision",
      "itemId": "CHK-003",
      "message": "CHK-003 假设 foo 函数在 a.ts 第 42 行，但没有证据",
      "createdAt": "2026-04-09T10:00:00Z",
      "resolution": null | {
        "status": "resolved" | "dismissed",
        "reason": "至少 20 字符的说明",
        "resolvedAt": "2026-04-09T10:15:00Z",
        "diff": "optional: 修改了哪里"
      }
    }
  ],
  "createdBy": "main:critique-mode",
  "schemaVersion": 1
}
```

新增两个 koala handler：
- `plan_critique_record`：main agent 在 critique 模式下调用，追加 critiques
- `plan_critique_resolve`：main agent 切回 plan 模式后调用，标记 resolve/dismiss

**硬约束**：
- critique 一旦 record 就不能删除（append-only）
- dismiss 的 reason 必须 ≥ 20 字符
- PLAN → DEV phase gate 检查所有 critique 都有 resolution（resolved 或 dismissed），否则阻塞

**Checklist**

1. **title**：定义 `PlanCritiqueFile` 类型 + reader/writer
   **context**：参考 `decision.ts` / `review.ts` 的 jsonl/json 文件读写模式。plan-critique.json 每次 write 全量覆盖（不是 append-only 文件，但逻辑上是 append-only 因为不允许删 entry）

2. **title**：`plan_critique_record` handler
   **context**：参数 `{ storyId, critiques: PlanCritique[] }`。追加到已有文件，生成 `pc-N` id，validate category 枚举。如果有 itemId，验证 checklist 里该 item 存在

3. **title**：`plan_critique_resolve` handler
   **context**：参数 `{ storyId, critiqueId, status, reason, diff? }`。加 reason 长度 check。不允许对已 resolved 的 critique 再改

4. **title**：PLAN → DEV 的 phase gate 检查 critiques 全 resolved
   **context**：`machine.ts` 加一条 guard：如果 plan-critique.json 存在且有 resolution=null 的条目，禁止进 DEV。错误消息里列出 unresolved critique id

5. **title**：`story_review` handler 读 critique 数据
   **context**：story_review 的输出里追加 critique 统计（总数 / resolved / dismissed / 分类分布）

6. **title**：fixture 覆盖 happy/edge/adversarial

**测试方向**
- happy：record 3 条 critique → resolve 2 条 + dismiss 1 条 → 全 resolved → phase gate 放行
- edge：单条 critique 未 resolve → phase gate 阻塞
- adversarial：dismiss reason 10 字符 → 拒绝

**验收**
- plan-critique.json 读写正确
- phase gate 硬检查
- 完整 fixture 覆盖

**触点**
- 新建：`packages/koala/packages/main/src/handlers/plan-critique.ts`
- 修改：`packages/koala/packages/main/src/core/types.ts`
- 修改：`packages/koala/packages/main/src/core/machine.ts`
- 修改：`packages/koala/packages/main/src/handlers/story-review.ts`
- 新建：fixture 文件

---

### S-11：PLAN_REVIEW phase 插入 + gate 条件

**Description**

现在 phase machine 是 `PLAN → DEV`。插入一个中间 phase `PLAN_REVIEW`：

```
PLAN → PLAN_REVIEW → DEV
```

- `PLAN → PLAN_REVIEW`：条件是 checklist 所有 item 都有 title + context + happy testIntent（即 S-09 识别的 "可以进 critique" 条件）
- `PLAN_REVIEW → DEV`：条件是 plan-critique.json 所有 critique 都 resolved + decision.json 里有对关键选择的记录（S-10 的 gate）

`PLAN_REVIEW` phase 的 allowed tools 白名单：
- `plan_critique_record`
- `plan_critique_resolve`
- `checklist_update`（允许 main agent resolve 时修改 checklist）
- `testintent_record`（允许补 edge/adversarial）
- `decision_set`（允许补决策记录）

**不允许**：
- `story_advance`（必须走 gate）
- `fixture_batch_add`（这是 TEST_CASE 阶段的事）
- `Agent(implementer)`（还没到 DEV）

**Checklist**

1. **title**：在 `core/machine.ts` 的 state 列表加 `PLAN_REVIEW`
   **context**：更新 `PhaseEnum`、transition table。注意向后兼容：老 story 的 phase 如果是 `PLAN`，story_advance 进入下一步时默认先进 `PLAN_REVIEW`

2. **title**：PLAN → PLAN_REVIEW 的 guard
   **context**：checklist 所有 item 有 title/context/testIntent.happy。否则错误返回"请先补齐 checklist 再进 PLAN_REVIEW"

3. **title**：PLAN_REVIEW → DEV 的 guard
   **context**：plan-critique.json 存在且所有 critique resolved，以及（软性）decision.json 存在。没 critique 文件时降级为 advisory（向后兼容老 story）

4. **title**：allowed tools 按 phase 白名单
   **context**：在 `cli-engine.ts` 或 handlers context 里按 phase 过滤可调用的 handler 列表。已有类似 logic（TEST_CASE_REVIEW 白名单了 test_fixture + test_story），扩展到 PLAN_REVIEW

5. **title**：story_advance 进入 PLAN_REVIEW 的 hint
   **context**：hint 说"请进入 critique 模式，使用 plan_critique_record 记录挑刺，resolve/dismiss 后用 story_advance --phase DEV"

6. **title**：旧 story 兼容测试
   **context**：模拟一个现有 active story 处于 PLAN phase，跑 story_advance 看它是否正确进 PLAN_REVIEW 而不是直接 DEV

7. **title**：回滚脚本
   **context**：万一 PLAN_REVIEW 造成阻塞，提供一个应急 override：`story_advance --phase DEV --skip-plan-review --reason "..."`。reason 必填，写入 activity.jsonl 方便追查

**测试方向**
- happy：PLAN → PLAN_REVIEW → DEV 全流程
- edge：老 story 从 PLAN 跳到 DEV 时经过 PLAN_REVIEW（使用 skip 参数）
- adversarial：critique 未 resolved 时 PLAN_REVIEW → DEV 被阻塞

**验收**
- phase machine 图更新
- guard 有 fixture
- skip 逃生门有 fixture

**触点**
- 修改：`packages/koala/packages/main/src/core/machine.ts`
- 修改：`packages/koala/packages/main/src/core/types.ts`（PhaseEnum）
- 修改：`packages/koala/packages/main/src/handlers/story-advance.ts`
- 修改：`packages/koala/packages/main/src/handlers/hints.ts`
- 修改：`packages/koala/packages/main/src/cli-engine.ts`（phase-scoped allowed tools）

---

### S-12：Wave 2 data review（gate）

**Description**

跟 S-04 / S-08 同构。关键指标：
1. **Critique 数据分布**：category 比例、resolved vs dismissed 比例
2. **Critique 命中率**：手工标注"挑得对 / 通用噪声 / 无意义"的比例
3. **DONE 质量变化**：Wave 2 之后的 story 在 DONE merge 后 2 周内反查有没有"plan 阶段没想到"类 bug

**决策树**：

| Critique 命中率 | resolve rate | Dismissed 噪声比例 | 决定 |
|---|---|---|---|
| > 60% | > 50% | < 30% | self-critique 够用，**停止在 Wave 2，不拆独立 red-team agent** |
| 40-60% | > 30% | < 50% | ⚠ 优化 CRITIQUE_MODE_PROMPT 再观察 |
| < 40% | 任意 | > 50% | self-critique 无效，拆独立 red-team agent 可能有改善，进 Wave 3 试 |
| 任意 | < 10% | 任意 | critique 流程本身有问题，回滚 S-11 |

**Checklist**

1. **title**：观察期 3 周 + 至少 5 个 story 经历 critique 流程
2. **title**：跑 wave2-review.sh
3. **title**：手工校验 critique 命中率
4. **title**：填 decision.json 决定：停 / 优化再观察 / 进 Wave 3 / 回滚

**测试方向**、**验收**、**触点**：同 S-04 结构

---

## Wave 3：条件性独立 red-team agent

**前提**：S-12 决定 self-critique 不够，需要独立 agent。

### S-13：独立 red-team agent 定义（conditional）

**Description**（骨架，细节在真到这一步时再展开）

如果 Wave 2 数据证明 self-critique 的局限（同一个脑子很难真的挑自己的刺），则新建 `.claude/agents/koala-red-team.md`：

- 专职 PLAN_REVIEW phase
- 独立 context（fresh agent），只看 checklist.json + decision.json，不看 main agent 的 thought trace
- 挑刺范围仍然是 S-09 的 3 类（unverified / missing-edge / undocumented-decision）
- 输出写 plan-critique.json
- main agent 在 PLAN_REVIEW phase 的第一步就 delegate 给 red-team

细节留白。Wave 3 的 checklist 等真进入时再补。

---

## 横切 story

### S-X1：artifact 写权限矩阵（按角色限制）

**Description**

随 S-02 做。在 koala handler 的通用入口加一层角色 check：

```ts
const ROLE_ARTIFACT_WRITE: Record<string, Set<string>> = {
  main: new Set(['*']),
  implementer: new Set(['checklist_update', 'update_task_state', 'fixture_batch_add']),
  'test-analyst': new Set(['bug_report']),
  unknown: new Set(['*']),  // 兼容老 session
};
```

入口在 `cli-engine.ts` 的 tool dispatch 之前。role 从 `KOALA_ROLE` env 读。越权 → 返回清晰错误。

**Checklist**（略，简单结构）

### S-X2：watchdog / session_brief 的角色感知

**Description**

现在 watchdog 检测 "idle 2min → kill" 假设一个 agent 全程在场。delegate 到 implementer 时，main agent 短期不动，但 implementer 在动。watchdog 不能误杀。

改造：watchdog 读 activity.jsonl 时把 role 字段一起算，只要**任何 role** 有活动就算 story 活着。

`session_brief` 的 `computeNextStep` 也要能区分"main 在等 implementer 回报" vs "main 自己卡住"。

**Checklist**（略）

### S-X3：hooks 的 role tag 透传

**Description**

随 S-03 做。hook env 里加 `KOALA_ROLE` 透传，让 preCommand / postCommand 脚本能按角色分支。

**Checklist**（略）

---

## 实施建议

### 落地顺序

**Wave 0 必须先做完，它是整个方案的 de-risking 切片**。Wave 0 决策不明朗之前，不要同时开 Wave 1/2。

```
第 1 周：Wave 0 coding
  Day 1: S-01 (implementer agent 定义)
  Day 2-3: S-02 (DEV/TEST_CASE 调度)
  Day 4: S-03 (遥测分 role)
  Day 5: 真机验证 + 收尾

第 2-3 周：Wave 0 观察期
  （不写代码，只跑 story 攒数据）

第 4 周初：S-04 data review
  决策 → 下一步

（如果 proceed-wave-1）

第 4-5 周：Wave 1 coding
  S-05 + S-06 + S-07

第 6-7 周：Wave 1 观察期 + S-08 review

第 8-9 周：Wave 2 coding (if)

第 10-12 周：Wave 2 观察期 + S-12 review
```

**不要 overlap wave**。重叠会让数据归因混乱，gate 决策失去意义。

### 不要贪快跳 gate

每个 wave 的 gate story 看起来"只是等和看数据"，但这是整个方案里**最关键的 story**。跳过 gate 直接进下一 wave 等于盲飞。如果真有紧急业务需要提前做 Wave 1，也必须先有 Wave 0 的观察数据——哪怕只有 3 个 story 的数据也比没有强。

### Wave 0 的默默退出条件

如果 Wave 0 落地 2 周内出现以下任一情况，**立即暂停新 story 进入 implementer delegate 路径**，回到 main agent 兼任 DEV，排查原因：

- implementer 在 3 个以上 story 里超 maxTurns 还没完成
- implementer 的 activity.jsonl 里 `status=fail` 比例 > 30%
- main agent 在 implementer 返回后没复核就 story_advance 的情况发生 2 次以上（人工抽查）
- CC sub-agent 机制本身出 bug（比如 isolation worktree 没清理、子 agent 无法启动）

### Rollback playbook

每个 wave 都有可回滚点。具体操作：

**Wave 0 rollback**：
```bash
rm .claude/agents/koala-implementer.md
git revert <S-02 commit>   # CLAUDE.md + hints.ts 的改动
# activity.jsonl 的 role 字段是 additive，可以保留
```

**Wave 1 rollback**：
```bash
rm .claude/agents/koala-test-analyst.md
git revert <S-05 commit>   # story_advance 自动 test_auto 的改动
# test-evidence.json / bug.json 的新字段是 additive，保留
```

**Wave 2 rollback**：
```bash
git revert <S-11 commit>   # PLAN_REVIEW phase 删除
# 老 story 的 plan-critique.json 保留，只是没有 phase gate 在用它
# CRITIQUE_MODE_PROMPT 可以保留，只是不再通过 hint 引导 main agent
```

每次 rollback 后必须写一份 retrospective（review.md），至少回答：
1. 为什么没达到预期？
2. 是方向错还是执行错？
3. 下一次尝试的前置条件是什么？

---

## 一句话总结

**不要一次拆 4 个独立 agent**。先拆一个最有把握的（implementer），用 2 周数据验证角色隔离能否降低真实痛点。如果能，再把测试执行确定性化（Wave 1）。如果还行，再用 self-critique 模式试对抗角色（Wave 2）。self-critique 不够才考虑独立 red-team agent（Wave 3）。

每个 wave 都有强制 gate story 和 rollback playbook。gate 的数据决策比 coding 本身更重要——那才是真正决定 koala 长什么样的步骤。

---

## 参考

- `docs/requirements/decisions/cc-learnings.md` — 现有 koala 改造方案，本文档的前身和基线
- `docs/requirements/decisions/task-checklist-cc-style.md` — CC TodoWrite 风格改造，本文档的 prompt 模式来源
- `CC/src/tools/AgentTool/builtInAgents.ts` — CC 的 built-in sub-agent 定义，implementer/test-analyst agent 定义的参考
- `packages/koala/packages/main/src/handlers/story-advance.ts` — B-7eed 自动 merge 实现，Wave 1 S-05 改造的基础
- `packages/koala/packages/main/src/core/machine.ts` — phase state machine，Wave 2 S-11 要改的地方
