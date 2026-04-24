<!-- koala:start -->
# AGENTS.md

> Current lifecycle override: this branch uses the second Koala flow
> `INIT → INIT_CHECK → PLAN/快速跳过 → DEV → REVIEW → TEST → DONE`.
> Older references below to `TEST_CASE`, `TEST_CASE_REVIEW`, `testIntent`,
> fixture-only validation, or `test_auto` are legacy background. The current
> replacement is `verificationIntent` on checklist items, `verificationEvidence`
> recorded during DEV/REVIEW/TEST, `koala-review-test-coverage` in REVIEW, and
> `koala validate` in TEST.

## 行为准则

0. **每次新 session 或恢复中断工作时，第一个命令必须是 `koala session_brief`**。它会输出 active story / phase / checklist / bug / 最近 activity / 推断的下一步，避免凭记忆瞎猜
1. 任何需求先走完整 Story 流程，除非用户明确说"立刻改"或"快速修改"
2. 行动前先 `koala session_brief`（项目状态）+ `koala aux_doc_list`（相关文档），再酌情 Read 关键文件。注意：全局安装的 `@koala-agent/core` CLI **只有核心命令**（story / checklist / fixture / test / session_brief / summary / doctor），`aux_*` 系列（scan/detail/sync/trace/diagnose/doc_list/coverage/locate）在 `@koala-agent/utils` 里，需要 bootstrap 脚本才会加载——日常全局 `koala` 命令下 `aux_scan` 会报"未知命令"。用 `aux_doc_list` 是已 bootstrap 的 koala 开发环境下的路径
3. 输出要简洁，但推理要彻底
4. 优先编辑而不是重写整个文件
5. 不要重复阅读已经读过的文件
6. 在宣布完成前测试你的代码
7. 不要有奉承的开场白或结束语
8. 保持解决方案简单直接
9. 用户指令始终覆盖此文件
10. **禁止直接读写 `docs/story/` 和 `tests/fixtures/` 目录下的文件**。所有 story 操作走 `koala story_*`/`koala checklist_*`/`koala bug_*` 命令，所有 fixture 操作走 `koala fixture_*` 命令。直接 Read/Edit 这些 JSON 文件会绕过流程校验
11. **工程完成 ≠ 任务完成**。一个 story 真正完成的标志是用户能从产品视角说"好了"，不是事件链路打通 / 测试通过 / 函数返回正确这些工程指标。详见底部「用户价值验收（优先于技术链路验证）」段。开发者必须既有程序思维又有产品思维，两边都完整才叫完成。

## 项目配置（koala.config.json）

```json
{
  "scanRoot": "packages/main",       // 代码扫描根目录
  "rootDir": "src",                   // 源码目录（相对 scanRoot）
  "outDir": "packages/main/dist",     // 编译输出
  "testsDir": "packages/main/tests",  // 测试目录
  "fixturesDir": "packages/main/tests/fixtures",  // fixture 文件目录
  "storyDir": "docs/story/actives",   // Story 存储目录
  "requirementsDir": "docs/requirements",  // 真相源目录
  "storyPrefix": "B"                  // Story ID 前缀
}
```

注意：`sourceFile` 路径不含 `scanRoot` 前缀，如填 `game-logic.ts` 不是 `packages/main/game-logic.ts`。

## 架构原则

**数据、逻辑、渲染三层解耦**：
- **数据层**：纯状态定义和存储，不含业务判断
- **逻辑层**：纯业务规则，不依赖 DOM/IO/渲染
- **渲染层**：尽可能轻薄，只映射状态到 UI

逻辑层可通过 fixture 测试覆盖，渲染层通过浏览器 trace 验证。新建函数时先判断属于哪一层。

## Story 阶段流转

```
INIT → INIT_CHECK → PLAN → DEV → TEST_CASE → TEST_CASE_REVIEW → TEST → DONE
       (创建 worktree)  ↑ cwd 门禁：必须在 worktree 里执行 koala 命令 ↑
```

> 每次 `story_advance` 和 `testintent_check` 返回的 `hint` 会告诉你下一步做什么，不需要记忆状态跳转规则。

### 各阶段职责与 Agent 分工

| 阶段 | 谁做 | 做什么 |
|---|---|---|
| **INIT** | 主 agent | `story_create` 后停在这，story 文件在 main 分支上 |
| **INIT_CHECK** | CLI 自动 | `story_advance INIT_CHECK` 创建 `.worktrees/B-xxx/` worktree，提示 cd |
| **PLAN** | 主 agent 拆 checklist item（title + context），**test-intent agent** 写 testIntent + 标 type | story_review 门禁通过后进 DEV |
| **DEV** | 主 agent | 写代码实现，不写测试。**只有此阶段可改代码** |
| **TEST_CASE** | 主 agent | 根据 testIntent 编写 fixture case。**只改 fixture，不改代码** |
| **TEST_CASE_REVIEW** | **test-case-reviewer agent** | 逐条审核 testIntent 是否有对应测试，调 CLI 记录结果。**不改代码也不改 case** |
| **TEST** | CLI 自动 | `test_auto` 跑全部 fixture + e2e（含 V8 profiler trace） |
| **DONE** | — | 完成（所有 bug 已 fixed），`story_advance --phase=DONE` 内部合并回 main 并清理 worktree |

### Git Clean 门禁

进入 TEST_CASE / TEST_CASE_REVIEW / TEST 前，`story_advance` 会检查 `git status --porcelain`。
有未 commit 的改动时拒绝推进，因为 `test_auto` 执行后会 `git restore . && git clean -fd`，**未 commit 的代码和 fixture 会全部丢失**。

→ 每次写完代码或 fixture 后，先 `git add + git commit`，再 `story_advance`。

### Worktree 自动管理

支持多 session 并行开发：每个 story 一个独立 worktree，互不干扰。

**完整生命周期**：

1. `story_create` → 停在 **INIT**（在 main 分支上写 story 文件）
2. `story_advance INIT_CHECK` → 自动创建 `.worktrees/B-xxx/`，分支 `story/B-xxx`
3. **`cd .worktrees/B-xxx`**（必须切，否则下一步会被 cwd 门禁拒绝）
4. `story_advance PLAN` → cwd 门禁通过，正式进入开发流程
5. PLAN/DEV/TEST_CASE/TEST_CASE_REVIEW/TEST 全部在 worktree 里完成
6. `story_advance --phase=TEST` → 推进 TEST，自动跑测试
7. `story_advance --phase=DONE` → 内部自动合并回 main 并清理 worktree（dev_finish/dev_merge 是内部 handler，无独立 CLI 入口）

**cwd 门禁**：PLAN 起所有 phase 的 `story_advance` 都会校验当前 cwd 是 story 的 worktree。不在 worktree 时报错并提示 cd。

**Sub agent 工作目录约定**：sub agent（test-intent / test-case-reviewer）**不要**使用 Codex 的 `isolation: "worktree"`，否则它们的 koala CLI 调用会落到独立分支，主 agent 看不到 checklist/testIntent 的更新。sub agent 直接在主 agent 的 story worktree 里跑即可。

**配置**：worktree 路径默认 `.worktrees`，可在 `koala.config.json` 的 `worktreeDir` 字段自定义。`.worktrees/` 自动加入 `.gitignore`。

**Codex / Claude 入口资产**：story worktree 不需要额外手工复制 `.Codex` 或 `.claude`。`git worktree` 会把当前分支里**已被 git 跟踪**的仓库文件一起展开，所以只要根目录里的 `.Codex`、`.claude`、`AGENTS.md`、`CLAUDE.md` 已经提交，新建的 `.worktrees/B-xxx/` 就会自然包含它们。若 worktree 里缺少这些入口，先检查文件是否真的被 git 跟踪，或该 worktree 是否从尚未包含这些资产的旧分支/旧提交创建。

**DONE 门禁**：进入 DONE 前要求 story 分支已包含 main 的所有提交（`git merge-base --is-ancestor main story/B-xxx`），避免遗漏 main 的更新。如有冲突，在 worktree 里 `git merge main` 解决。

### TEST 阶段详细流程

```
test_auto 执行
  ├─ case PASS → 保存 trace 快照 → 若有关联 bug 则自动标 fixed
  ├─ case FAIL → 自动 aux_diagnose（lastPass trace diff + git diff）→ 自动 bug_report
  └─ trace 变化 → 输出 warning（调用链分叉/新增/消失）
→ 全部 PASS + 所有 bug fixed → DONE
→ 有 FAIL → hint 回退 DEV → 修复 → 重跑 test_auto
```

### 三方制衡

- **主 agent**：写需求（checklist item）+ 写代码 + 写测试
- **test-intent agent**：写验收标准（testIntent），对抗姿态逼出 edge/adversarial
- **test-case-reviewer agent**：审验收，独立验证测试覆盖和通过情况

主 agent 和 sub agent 是**同事关系**，不是上下级。共同目标是高质量完成任务。主 agent 是与人沟通的入口和主要参与者，但不是掌控者。reviewer 和 test-intent agent 有各自的判定权，主 agent 不应该绕过他们。

**人的角色**：人是最终决策者。当 agent 之间有根本分歧（超过 5 轮）时，由人裁决。人也可以随时介入调整方向。

### Subagent 定义

subagent prompt 文件放在 `.Codex/agents/` 下（Codex 官方约定），格式为 Markdown + YAML frontmatter：

```markdown
---
name: test-case-reviewer
description: 审查 testIntent 覆盖和测试通过情况
model: sonnet
tools: Read, Glob, Grep, Bash
---
（审查规则和输出格式要求）
```

subagent 可调用 koala CLI 命令（通过 Bash tool），能独立验证测试结果。

## koala CLI

```bash
koala <command> '{"key":"value"}'   # 全局命令，任何目录可用
koala <command> --help              # 查看参数（出错时先查）
koala help                          # 列出所有命令
koala --root /path/to/project ...   # 指定项目根目录
```

**调用出错时先 `koala <command> --help`**，不要靠记忆猜参数。

### 常用命令速查

```bash
# 创建 Story（有 checklist 时停在 PLAN，checklist 只写 title+context，testIntent 由 test-intent agent 填）
koala story_create '{"name":"xxx","title":"...","description":"...","type":"feature","priority":"high","checklist":[{"title":"做什么","context":"根因/参考方案"}]}'

# 对抗审查（PLAN 阶段必须通过才能进 DEV）
koala story_review '{"storyId":"B-xxx"}'

# 推进阶段（PLAN→DEV 时自动创建 .worktrees/B-xxx/，需 cd 进去开发）
koala story_advance '{"storyId":"B-xxx","phase":"DEV"}'

# 批量添加 fixture case
koala fixture_batch_add '{"fixturePath":"game-logic","cases":[{"name":"test1","run_type":"cli","file":"mcp/handlers/my","execute":"return $handlers.myTool({})","expect":true}]}'

# PLAN 阶段产物：理解快照 + 结构化决策
koala understanding_set '{"storyId":"B-xxx","task":"...","outcome":"...","facts":[...],"constraints":[...],"unknowns":[...],"touchpoints":[...]}'
koala understanding_get '{"storyId":"B-xxx"}'
koala decision_set '{"storyId":"B-xxx","principles":[...],"drivers":[...],"options":[{"name":"A","pros":[...],"cons":[...]},{"name":"B","pros":[...],"cons":[...]}],"chosen":"A","rationale":"...","preMortem":[{"scenario":"...","trigger":"...","consequence":"...","mitigation":"..."}]}'
koala decision_get '{"storyId":"B-xxx"}'

# 5 轮 cap 触发后的人类介入（必须 human:true）
koala testintent_resume '{"storyId":"B-xxx","itemId":"CHK-001","lane":"happy","index":0,"reason":"...","human":true}'

# checklist
koala checklist_get '{"storyId":"B-xxx"}'
koala checklist_update '{"storyId":"B-xxx","itemId":"CHK-001","status":"done"}'

# 文档列表（PLAN 阶段挑 relatedDocs 用，扫 docs/ + requirements/ + 根目录的 Codex/README/AGENTS）
koala aux_doc_list                          # text 格式，按目录分组 + H1 标题 + 修改时间
koala aux_doc_list '{"format":"json"}'      # json 格式

# 测试
koala test_auto                       # 全量回归：跑所有 fixture 所有 case（CI/发版前用）
koala test_story '{"storyId":"B-xxx"}'  # story 级测试：只跑关联 case，写 bug/evidence
koala test_fixture '{"fixtureId":"uuid"}'  # 单 case/单链测试：按 _id 定位

# 自动诊断（case fail 时定位根因）
koala aux_diagnose '{"caseName":"case名"}'  # lastPass trace diff + git diff → 根因 + 修复建议

# 架构提取（基于 trace 数据）
koala aux_trace '{"format":"json"}'    # 输出业务逻辑线、函数影响图、覆盖盲区
koala aux_trace '{"format":"mermaid"}' # 输出 mermaid 流程图

# 元数据辅助（@koala-agent/utils，需 bootstrap 启用；非全局 koala 下不可用）
koala aux_scan                        # 扫源码 @task 注释 + 校验
koala aux_detail '{"files":["foo.ts"]}'  # 按文件查函数签名/属性/import
koala aux_sync --direction=extract    # 从源码注释提取到 task.json
```

> ⚠ **aux_\* 命令的可用性**：全局 `npm i -g @koala-agent/core` 安装的 `koala` CLI **只包含** main 包的核心命令。`aux_*` 在 `@koala-agent/utils` 里，需要通过 `packages/koala/bin/koala.js` bootstrap 脚本同时加载 utils 才可用。如果在 observer 仓库（koala-agent）里 `koala aux_scan` 报 "未知命令"，用 `koala aux_doc_list`（也属 utils 但可能已注入）或直接用 `Glob`/`Grep` 替代。

## Checklist 写法

```json
{
  "title": "做什么（一句话）",
  "context": "根因/参考方案",
  "relatedDocs": ["requirements/foo.md", "AGENTS.md#section"]
}
```

- title 描述「做什么」，不描述「怎么做」
- context 给执行 agent 提供决策上下文
- **主 agent 只写 title + context + relatedDocs，不写 testIntent**
- relatedDocs 是关联的文档路径数组（可带 `#锚点` 给人看，不参与机器匹配），用于三次提醒避免代码改了文档忘改

### relatedDocs 三次提醒

关联文档在三个时机被**软提醒**（不阻塞）：

1. **PLAN→DEV 推进时**：`story_advance DEV` hint 列出 story 全部 relatedDocs 去重清单
2. **`checklist_update` 标 done 时**：列出该 item 的关联文档清单
3. **DONE 推进时**：列出 `git diff main...HEAD` 中未出现的关联文档清单

是否更新文档由 agent 自己判断，没有 ack 机制也没有门禁。

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
- test runner 框架（fixture runner/test_auto/cleanupFixtureDir）
- git 破坏性操作（git restore/reset/clean/push --force）
- 生产环境/紧急（production/incident/hotfix/p0/p1）
- 合规/隐私（PII/GDPR/compliance）
- 破坏性 API 变更（public api/api break/breaking change）

命中时 `story_review` 会强制要求 decision.json + ≥ 3 preMortem 场景（缺则 blocker）。

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

### testIntent（由 test-intent agent 填写）

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

- `type` 取值：`cli_blackbox`（CLI / 纯函数测试）、`browser_blackbox`（浏览器 UI）
- type 由 test-intent agent 在 PLAN 阶段根据 testIntent 的操作对象判断
- 每个 item 必须有 happy/edge/adversarial 三栏，填不满说明 item 拆得不对

### testIntent results（由 test-case-reviewer agent 记录）

每条 testIntent 对应一个 `results` 数组，每次审核追加一条：

```json
{ "time": "...", "pass": true, "note": "说明", "role": "reviewer" }
```

- `note` 硬性格式：`file:line` 引用 + WHY + severity
- `role` 由 CLI 从 `agent` 参数自动推断：`test-case-reviewer` → `reviewer`，`test-intent` → `intent`，其他 → `author`
- results 只能通过 CLI 写入，不允许手动修改
- results 永不删除，用于长期质量追踪
- reviewer agent 启动时读 results 历史作为上下文

#### 对话式审核

results 数组支持多方对话。典型流程：

1. reviewer 记 `pass=false`（如「框架限制：无法从 case 内部制造 dirty git state」）
2. 主 agent 通过 `testintent_record` 回复（不带 `pass`，纯回复）��说明同意原因
3. reviewer 读到主 agent 回复，自行判断是否合理，记最终 `pass=true` 或 `pass=false`

**判定权始终在 reviewer**。主 agent 只提供上下文，不能越权判定。

### 门禁与回退

- CLI 检查每条 testIntent 的 results 中最后一条 `role="reviewer"` 的判定记录
- 全部 `pass=true` → 允许 TEST_CASE_REVIEW → TEST
- 有 `pass=false` → 回退 **DEV**（主 agent 根据 reviewer 反馈决定改代码还是改 case）
- CLI 返回详细失败列表（哪些 case、note 内容），reviewer agent 原样转告主 agent

### 5 轮 cap（segment-aware）

`testintent_record` 对每条 testIntent 强制 5 轮 cap：当前段（不含被 `human-resume` 重置过的历史段）累计 reviewer/author 条数 ≥ 5 时拒绝再写。这是 hard gate，不是 soft 提醒。

触发后正确反应：
1. **优先反思**：5 轮还没达成共识说明 testIntent 描述本身有问题，或者 checklist item 拆错了。先改根，不要找绕路
2. **让人裁决**：实在需要继续，让用户调 `koala testintent_resume` 显式开新段（必须带 `human:true` 和 ≥ 5 字符的 `reason`）

```bash
koala testintent_resume '{
  "storyId":"B-xxx",
  "itemId":"CHK-001",
  "lane":"happy",
  "index":0,
  "reason":"用户裁决：xxx 原因，继续审",
  "human":true
}'
```

主 agent 不应该自己调 `testintent_resume`——CLI 会拒绝 `human:false`，且 prompt 里"如果你是主 agent 在跑——这正是 cap 在保护你"是显式提醒。

### checklist item 拆解标准

1. 有可观测的结果（用户能看到变化）
2. 有明确的输入触发（操作/事件/时间）
3. happy/edge/adversarial 三栏都能填满

### 对抗审查

checklist 写完后必须跑 `story_review` 对抗审查，审查通过（issueCount=0）才能进 DEV：

```bash
koala story_review '{"storyId":"B-xxx"}'
```

story_review 检查：缺失/弱 testIntent、item 间交叉场景遗漏、真相源未覆盖的约束。
审查结果自动写入 review.json，可追溯审了几轮、每轮发现什么。

## Fixture 写法

用 `fixture_batch_add` 一次提交所有 case。每条 case 必须包含：

```json
{
  "name": "测试名称",
  "run_type": "cli",
  "file": "mcp/handlers/story",
  "execute": "const _r = await $handlers.story_create({...}); $ctx.storyId = _r.match(/B-[a-f0-9]+/)[0]; return _r",
  "expect": {"pattern": "created"},
  "intentRef": "CHK-001:happy:0"
}
```

### 字段说明

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | case 名称 |
| `run_type` | 是 | `cli` 或 `browser` |
| `file` | 是 | 源文件路径（相对 scanRoot，不含扩展名） |
| `execute` | 是 | 函数体（agent 自己写 import + 调用逻辑） |
| `expect` | 否 | 预期返回值（支持 `{pattern:"regex"}` 或精确匹配） |
| `throws` | 否 | 预期抛出的错误（与 expect 互斥） |
| `intentRef` | 否 | 关联 testIntent（如 `CHK-001:happy:0`） |
| `_id` | 自动 | uuid，`fixture_batch_add` 自动生成，用于 bug 绑定和 `test_fixture` 定位 |
| `prevCaseId` | 自动 | 指向前一个 case 的 `_id`，批��添加时自动建立链关系 |
| `nextCaseId` | 自动 | 指向后一个 case 的 `_id`，runner 按链拓扑执行 |

### execute 中可用的变量

- `$handlers` — 所有已注册工具（如 `$handlers.story_create({...})`）
- `$root` — 项目根目录
- `$ctx` — 跨 case 共享上下文（如 `$ctx.storyId`）
- `$file` — 自动替换为编译后 .js 文件的 URL（需配合 `await import($file)`）

### 链式 case

`fixture_batch_add` 批量添加时自动按顺序建立 `prevCaseId/nextCaseId` 链关系。
链式 case 共享 `$ctx`，按链拓扑顺序执行，链尾才触发 `git restore` 清理。
独立 case（无链关系）跑完立即清��。

```json
{"name":"setup: 创建 story", "execute":"...", "_id":"auto", "nextCaseId":"auto"}
{"name":"查询 story", "execute":"...", "_id":"auto", "prevCaseId":"auto"}
```

可用 `koala test_fixture '{"fixtureId":"<uuid>"}'` 按 `_id` 定位单个 case 或整条链测试。

### 常见错误

1. **fixture 一次写对**：先想清楚所有 case 再 batch_add
2. **checklist 逐项完成**：做完一项标一项 done
3. **门禁失败时**：读错误信息里的 `→` 修复命令，直接执行
4. **主 agent 不写 testIntent**：testIntent 由 test-intent agent 填写

### 踩坑记录

1. **写完必须 commit 再推进**：test_auto 会 `git restore . && git clean -fd`，未 commit 的代码和 fixture 会丢。已有 git clean 门禁拦截，但不要依赖门禁——养成写完就 commit 的习惯。

2. **fixture 断言从 testIntent 反推，不从"怎么容易 pass"正推**：`return true`、宽泛 pattern（如 `"allPassed|totalCases"`）是无效断言。reviewer 会拒绝。execute 中应该直接调用被测函数、检查返回值的具体字段。

3. **reviewer 说 fail 就去改，不要反复解释**：reviewer 说"不是框架限制"的时候，应该立刻回 DEV 改代码，不要在 fixture 层面打补丁或写 testintent_record 解释。来回对话超过 2 轮说明方向错了。

4. **fixture 提交前先本地 `test_auto` 验证**：不要让 reviewer 替你发现运行时错误（ESM 兼容、JSON 转义、递归卡死）。

5. **fixture 的 execute 在 ESM 环境运行**：用 `await import("fs")` 不用 `require("fs")`。Windows 路径用 `$root.split("\\").join("/")` 不用 regex（JSON 转义地狱）。

6. **sub agent 的 prompt 也是代码**：写完要 review，不要等跑了 5 轮才发现 prompt 里让 reviewer 跑 test_auto。

### 主 agent 行为准则

- **主 agent 不是上帝视角**：不要试图掌控一切。reviewer 有判定权，test-intent agent 有对抗权。主 agent 的角色是写代码和测试，不是裁判。
- **reviewer 是信号不是障碍**：reviewer fail 了，正确反应是"他说得对，我去改"，不是"怎么解释让他 pass"。把 reviewer 当障碍绕，只会制造更多轮次。
- **三方制衡是设计不是形式**：reviewer fail 了不要想着怎么说服他 pass，而是思考他看到了什么你没看到的。
- **多揽责任少推卸**：发现问题时主动修，不要说"不在 scope 内"。story 里发现的相关问题、顺手能修的 bug、reviewer 指出的实现缺失，都应该在当前 story 里一并处理。checklist 和 testIntent 是指引不是边界——做好一件事自然会衍生出相关的改动。
- **跨 story 全局意识**：主 agent 在 story 中把控开发节奏，但不应该只看当前 story 的 checklist。修一个 feature 可能发现基础设施的 bug（如 DONE gate 缺检查、fixture runner 递归卡死），这些都应该一起修，不要留给"下一个 story"。
- **5 轮上限**：同一 story 的 reviewer 对话超过 5 轮，停下来等人类裁决。超过 5 轮说明主 agent 和 reviewer 对需求理解有根本分歧，需要人类介入。

## 规则

- 所有 Story/fixture 操作通过 `koala` CLI 完成，禁止直接读写 JSON
- 测试统一通过 `koala test_auto` 执行（CLI 黑盒 + Browser 黑盒）
- 所有环境统一用 CLI

## Fail-fast policy（silent catch 分类约定）

修 koala 框架内部代码时，新增的 `try ... catch` 必须在四个分类里挑一个，**不允许裸 silent**：

| 分类 | 何时使用 | 处理方式 |
|---|---|---|
| **DEBUG** | 日志 / 进度上报失败 | 保留 silent，可加 `// debug:` 注释 |
| **PROBE** | 探测类（文件/分支/git config 不存在） | 保留 silent，返回 `null`/默认值 |
| **PERSIST** | writeLog / persistPending / save 失败 | 调 `reportHealthIssue('persist:xxx', e, ctx)` |
| **MUTATION** | git / fs.writeFileSync / spawn 失败 | `throw new Error(...)`，让上层感知 |

`reportHealthIssue` 在 `core/health.ts`，往 `~/.koala/health.jsonl` append 一条记录，**自身永不抛错**。用户跑 `koala doctor` 可以看到所有 PERSIST 失败 + 按分类汇总。

写 silent catch 时问自己一个问题：**如果这里失败了，10 分钟后用户会怎么发现？** 没答案就用 `reportHealthIssue` 留痕。

<!-- koala:end -->
