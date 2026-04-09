# koala 向 Claude Code 学习的改造方案

> 2026.04 · 基于完整审计 koala 当前状态后总结

## 背景

koala 已经做对了大部分接地机制：phase gate / DONE Final Checklist / 签名 review / 物理事实验证 / watchdog / activity.jsonl / silent test rejection 等。审计 CC 源码后，确认 koala 还缺**几个 CC 验证过、且对 koala 实际场景有真实价值**的机制。

本文档整理为可拆 story 的形式，每个 story 独立完整，含 description / checklist / 测试方向 / 验收。

## 核心洞察

回头看用户列出的所有 koala 痛点（worktree 没创建、做一半就完成、跨 session 丢上下文、写 story 和做 story 不一致、功能没跑起来没察觉），**全部不是 koala 缺功能**，而是：

1. **agent 不知道什么时候用 koala 的哪个命令** → 工具描述太薄
2. **koala 命令成功后没告诉 agent 下一步** → 只有 story_advance 有 nextStepHint
3. **agent 离开 session 后失去上下文** → 没有 brief 入口
4. **silent catch 让失败被吞掉** → fail-fast 不彻底

修完这 4 类问题对应的 5 个 story，预期 koala 痛点减少 70-80%。

## 不学的部分

CC 的以下机制**不适合**koala，本文档明确不引入：

| CC 机制 | 为什么 koala 不需要 |
|---|---|
| `shouldDefer` / 工具延迟加载 | koala 是 CLI 工具，工具描述不进 LLM context，没有 token 成本 |
| `<system-reminder>` attachment 注入 | koala 没有 LLM 对话流，不适用（reminder 走 stderr） |
| `autoCompact` / 分层压缩 | koala 没有 context window 概念 |
| `cache-safe params` for forked agents | koala 命令是独立进程，没有"父 cache" |
| `tokenCountWithEstimation` | koala 不调 LLM |
| `yoloClassifier` Haiku 自动判决 | koala 是无 LLM 的纯 CLI；让上层 observer 做 LLM 判断 |
| `feature flags` + Growthbook | koala 用户量小；用 stability 字段足够 |
| `BQ 遥测` | koala 已经有 activity.jsonl |
| `prompt cache break detection` | 没 prompt cache |
| `1M context beta` | 没 context |
| `subagent` 嵌套 | koala 命令是独立进程，没嵌套 |

---

## Story 总览

按 ROI 顺序排：

| 顺序 | Story | 工作量 | 影响 | 优先级 |
|---|---|---|---|---|
| 1 | 命令返回的 nextStepHint 全覆盖 | 2 天 | agent 自动找到下一个命令 | P0 |
| 2 | silent catch 修复（fail-fast 分类处理） | 1 天 | 修最隐蔽的 bug 类 | P0 |
| 3 | session_brief 命令 | 1 天 | 跨 session 上下文不丢 | P0 |
| 4 | 4 个核心命令 PROMPT 化（CC TodoWrite 风格） | 3 天 | 单点最大杠杆 | P0 |
| 5 | stale state 检测 | 2 天 | 防 stuck phase | P1 |
| 6 | Hook 系统 | 3 天 | observer 接通基础 | P1 |
| 7 | 命令 metadata + dry-run | 2 天 | 防误操作 | P2 |
| 8 | progress streaming 补全 | 1 天 | 长命令可见性 | P2 |
| 9 | schemaVersion + 空 migration | 0.5 天 | 未来债务对冲 | P3 |
| 10 | search 命令 + 调用栈防递归 | 2 天 | discoverability | P3 |

**P0 + P1 共 12 天工作量**，做完是 koala 单点改进的天花板。P2/P3 锦上添花。

---

## Story 1：命令返回的 nextStepHint 全覆盖【P0】

### Description

CC 的 TodoWrite 每次返回都强化"Continue to use the todo list..."，这是模型用一次后持续用的关键。koala 现在只有 `story_advance` 在返回里加了 nextStepHint（[story-advance.ts:432-439](packages/main/src/handlers/story-advance.ts#L432-L439)），其它 state-mutating 命令（checklist_update、fixture_batch_add、bug_report、testintent_record、story_create）都没有。

agent 看到一个成功的 koala 返回，如果不告诉它"下一步该做 X"，它会**自己猜**。猜对的时候命令链路顺畅，猜错就跳过流程。

修复目标：每个 state-mutating 命令的成功路径都返回 next step hint，hint 里包含**条件判断**（"如果 X 已 done 则 Y，否则 Z"），等于在每个命令出口处帮 agent 做一次 state 推理。

### Checklist

1. **title**：在 cli-engine.ts 加 decorateResult 统一注入器
   **context**：新增 `function decorateResult(cmdName: string, result: unknown, ctx: HintContext): unknown`，被 run() 函数在 print result 之前调用。HintContext 含 store / config / loadConfig / activeStory，让 hint 函数能查询当前状态。

2. **title**：注册 checklist_update 的 hint
   **context**：检查 status：
   - in_progress → 提示"开始写代码，完成后再次 checklist_update status=done"
   - done 且非全部 done → 提示"继续下一项"
   - done 且全部 done → 提示"所有 item 完成。下一步：story_advance phase=TEST_CASE"
   - testIntent 更新 → 提示"testIntent 已记录，继续完善其它 item"

3. **title**：注册 fixture_batch_add 的 hint
   **context**：检查 added 数量 + 当前 story phase。例如 TEST_CASE 阶段加了 N 个 case → "已添加 N 个 case。继续添加 / 或 story_advance phase=TEST_CASE_REVIEW 进入审核"

4. **title**：注册 story_create 的 hint
   **context**：检查 story 是否含 checklist：
   - 有 checklist → "Story 创建在 IDEA。下一步：story_advance phase=INIT_CHECK 创建 worktree"
   - 无 checklist → "Story 创建在 IDEA。需要先讨论 checklist 后再用 story_advance phase=PLAN"
   - 已有同名 keyword 的 story → 警告并列出可能重复的 story id

5. **title**：注册 bug_report 的 hint
   **context**：单条 bug 创建后 → "Bug 已记录。修复后 git commit + test_story 自动标 fixed"

6. **title**：注册 testintent_record 的 hint
   **context**：检查 lastJudgment：
   - 用户首次记录 pass=true → 提示是否所有 item 都已审核
   - 全部 reviewer pass → 提示 story_advance phase=TEST
   - 任意 fail → 提示 story_advance phase=DEV 回退修复

7. **title**：注册 dev_start / dev_finish / story_discard 的 hint
   **context**：worktree 操作类命令的下一步提示

8. **title**：将所有 hint 函数集中到 src/handlers/hints.ts 单文件
   **context**：而不是散落在各 handler 里。这样 cli-engine.ts 只 import 一个 registry，新加 hint 直接在这个文件加一行

9. **title**：为 hint 函数加单元 fixture
   **context**：构造 mock store + mock state，验证每种 case 路径返回的 hint 文本符合预期

10. **title**：在 ToolDef 加 hint?: HintFn 字段（可选）
    **context**：让 cli-engine.ts 可以通过 ToolDef 找到对应的 hint 函数。MAIN_TOOLS 注册时如果 hint 函数已定义就 wire 上。如果 ToolDef 不暴露这个字段，就在 cli-engine 里维护一个独立的 cmdName → HintFn map

### 测试方向

- happy：每个命令成功时都返回非空的 hint 字段
- edge：命令边界情况（如 checklist 全 done、bug 全 fixed）的 hint 切换
- adversarial：错误情况（如 store 中无对应 story）hint 不抛错，降级返回 null

### 验收

- grep `nextSteps` / `hint` 在 cli-engine.ts 输出，至少 8 个命令有非 null 返回
- 写一个 fixture：构造含 in_progress checklist 的 story，调 checklist_update status=done 标完最后一项，断言返回里包含 "story_advance phase=TEST_CASE" 字符串

### 触点

- 新建：`packages/main/src/handlers/hints.ts`
- 修改：`packages/main/src/cli-engine.ts:575-594`（run 函数加 decorateResult 调用）
- 修改：`packages/main/src/handlers/checklist.ts`、`fixture.ts`、`bug.ts`、`story-create.ts` 等（如果需要把 hint 函数注册到 hints.ts）

---

## Story 2：silent catch 修复（fail-fast 分类处理）【P0】

### Description

koala 代码里有几十处 `try { ... } catch { /* ignore */ }`。CC 有明确原则："**安全相关的错误必须响**"。koala 的 silent catch 在几类地方很危险：

- `writeLog` 失败 → audit 不完整，事后没法回溯
- `_persistPending` 失败 → 跨进程恢复失效
- worktree 创建失败但被 swallow → 用户描述过的"worktree 没创建但以为创建了"经典场景
- markLost 失败被 swallow → restart recovery 数据不一致

这些 silent catch **不能全删**（有些是探测类的合理 ignore），但**必须分类处理**：什么时候 silent ok，什么时候必须 throw，什么时候必须降级到日志。

### Checklist

1. **title**：grep 所有 silent catch 并列出
   **context**：`grep -rn "catch.*{.*ignore\|catch.*{$" packages/main/src --include="*.ts"`，输出结果列到一个 markdown 文件，每条标记当前位置 + 上下文。

2. **title**：按 4 类标签分类
   **context**：
   - **DEBUG**（日志/进度类）：保留 silent
   - **PROBE**（探测类如 readReview / detectActiveStory 文件不存在）：保留 silent 但返回 null/empty
   - **PERSIST**（writeLog / persistPending / save）：改成 stderr 输出 + 写 health flag
   - **MUTATION**（git / fs.write / spawn 失败）：改成 throw 或返回结构化 error

3. **title**：新建 health.ts 模块，提供 reportHealthIssue 函数
   **context**：`export function reportHealthIssue(category: string, error: Error, context: Record<string, unknown>): void`。把 issue append 到 `~/.koala/health.jsonl`，每条含 timestamp / category / error.message / context。失败本身也不抛错（防止 health module 自己崩了把主流程拖死）。

4. **title**：把 PERSIST 类 silent catch 改成 reportHealthIssue
   **context**：例如 [worktree.ts](packages/main/src/handlers/worktree.ts) 里所有 markLost 的 silent catch、cli-engine.ts 的 writeLog 的 silent catch、context-assembler 的 _persistPending 的 silent catch。改成：
   ```ts
   try { ... } catch (e: any) {
     reportHealthIssue('persist:writeLog', e, { command: cmd })
   }
   ```

5. **title**：把 MUTATION 类 silent catch 改成 throw KoalaError
   **context**：例如 worktree 创建调用、git merge 调用、fs.writeFileSync 调用。失败必须能被上层感知。

6. **title**：新增 koala doctor 命令
   **context**：扫 `~/.koala/health.jsonl`，输出最近 24 小时的 health issue，按 category 分组。让用户能定期 doctor 一下看 koala 自己有没有隐藏问题。

7. **title**：fixture 验证 health issue 真的写入
   **context**：构造一个会触发 PERSIST 类失败的场景（比如让 health.jsonl 所在目录没有写权限），调用 koala 命令，断言后续 doctor 能看到这个 issue。

8. **title**：write a doc section in CLAUDE.md about fail-fast policy
   **context**：明确"new code 不允许 silent catch"作为约定，让以后的 agent 改 koala 代码时遵守

### 测试方向

- happy：正常路径无 health issue
- edge：可恢复的失败（比如临时 fs.write 失败）正确写入 health
- adversarial：health.jsonl 自己写入失败时不影响主流程

### 验收

- grep `catch.*{.*ignore` 数量从基线减少至少一半
- 故意触发一个 worktree 创建失败，观察是否 throw 而非 swallow
- 跑 `koala doctor` 输出格式正确

### 触点

- 新建：`packages/main/src/core/health.ts`
- 新建：`packages/main/src/handlers/doctor.ts`
- 修改：所有含 silent catch 的文件（grep 输出列表）
- 修改：`packages/koala/CLAUDE.md` 加 fail-fast policy 段落

---

## Story 3：session_brief 命令【P0】

### Description

CC 有 conversation memory + system_reminder 让 agent 跨 session 记得之前的事。koala 通过 story 文件做了类似的事，但**没有"开场白"接口** —— 新 session 的 agent 启动时不会被告知"你上次停在哪里、刚才发生过什么"。

新 agent 进来要么 `koala story_list` + `koala story_get` 一通查询（多次往返），要么直接开始干活（错的概率很大）。

修复目标：给 agent 一个 single-shot 命令，输出"当前应该做什么"的完整简报。CLAUDE.md 要求新 session 第一件事跑这个命令。

### Checklist

1. **title**：新增 ToolDef session_brief
   **context**：cli-engine.ts MAIN_TOOLS 数组加 `{ name: 'session_brief', description: '生成本 session 的开场简报：当前 active story + 最近活动 + 应该做的事', schema: {} }`。无参数。

2. **title**：实现 session_brief handler 框架
   **context**：新建 `packages/main/src/handlers/session.ts`，导出 `createSessionHandlers(ctx)` 含 `session_brief()`。通过 detectActiveStory 拿 active story，没有 active story 时返回 "No active story. To start: koala story_create ..."

3. **title**：组装 brief 内容
   **context**：active story 存在时，组装 markdown 输出含：
   - story id + phase + title
   - 最近 5 个 events（来自 story.events）
   - checklist 状态摘要：N in_progress / M pending / K done，列出 in_progress 的具体 item
   - 最后一次 test_story / test_auto 的结果（read test-evidence.json）
   - 最后一次 bug_report 的状态

4. **title**：实现 computeNextStep 推理函数
   **context**：根据 (phase, checklist 状态, test result, bug 状态) 推理"现在应该做什么"。例如：
   - PLAN + 无 testIntent → "完成 testIntent 后跑 story_review"
   - DEV + checklist 全 done + 无 fixture → "story_advance phase=TEST_CASE 然后写 fixture"
   - TEST + 有未 fixed bug → "修复 bug 后 test_story 重跑"
   - 各 phase 的具体下一步建议

5. **title**：从 activity.jsonl 拿"最近活动时间线"
   **context**：读最后 20 条 activity 记录，按时间排列输出。让 agent 看到"最近的开发动作发生在什么时候"。

6. **title**：detect git 状态
   **context**：跑 `git status --short`、`git log -3 --oneline`，把结果一起放进 brief

7. **title**：写一段 CLAUDE.md 强制 session 开头跑 session_brief
   **context**：在 koala 项目的 CLAUDE.md 加："每次 session 开始或恢复中断的工作时，第一个命令必须是 `koala session_brief`，理解状态后再继续工作"

8. **title**：fixture 验证不同 state 的 brief 输出
   **context**：构造 5 种状态的 mock story（IDEA / PLAN / DEV / TEST / DONE），断言每种状态的 brief 输出包含正确的 nextStep 提示

### 测试方向

- happy：常见状态下 brief 输出符合预期
- edge：无 active story、刚 PLAN 完没 events 等边界
- adversarial：activity.jsonl 不存在 / story 文件损坏 / git 仓库不存在

### 验收

- 手动跑：`koala session_brief` 在你当前项目能输出有意义的 brief
- 给一个新 Claude session 跑这个命令开局，观察它能不能直接进入正确的下一步

### 触点

- 新建：`packages/main/src/handlers/session.ts`
- 修改：`packages/main/src/cli-engine.ts` MAIN_TOOLS 数组
- 修改：`packages/main/src/registry.ts` createMainRegistry
- 修改：`packages/koala/CLAUDE.md`（加 session 开局规约）

---

## Story 4：4 个核心命令的完整 PROMPT 化【P0】

### Description

CC 的 TodoWrite description 是 184 行的完整 PROMPT，含 7 个 when-to-use/when-not 示例。koala 的工具描述全是一句话：

```ts
{ name: 'story_create', description: '创建 Story 条目', schema: {...} },
{ name: 'checklist_update', description: '更新 checklist 项', schema: {...} },
{ name: 'fixture_batch_add', description: '...', schema: {...} },
```

agent 看到一句话只知道"能做什么"，不知道"什么时候该用"。具体表现：

- 该用 `story_advance` 推 phase 时不推（卡在 PLAN 不进 DEV）
- 该用 `checklist_update` 标 done 时不标（一堆 in_progress 挂着）
- 该用 `fixture_batch_add` 时直接 Edit 写入 fixture json 文件（绕过 schema 校验）
- 该用 `story_review` 对抗审查时直接进 DEV（被签名 guard 拦下，但反复重试）

注意：koala 的工具描述出现在 `koala help` 和 `koala <cmd> --help` 输出里，**不进 agent 的 LLM context**（因为 koala 是 CLI）。所以"PROMPT 化"的目标不是省 token，是让 **`koala <cmd> --help` 的输出能教会 agent 怎么用**。agent 在调用前会先 `--help`，那时候教育它。

### Checklist

1. **title**：把 ToolDef.description 字段从 string 改为 string | { short: string, long: string }
   **context**：short 用于 `koala help` 一行展示；long 用于 `koala <cmd> --help` 详细展示。printToolHelp 函数检测到 long 时打印 long，否则打印 short。保持向后兼容。

2. **title**：为 story_create 写完整 PROMPT
   **context**：long 字段包含：
   - When to use（用户明确说"开发 X"、用户给了一段需求要拆解时）
   - When NOT to use（用户在讨论 / 用户问问题 / 用户描述 idea 但还在迭代）
   - 4-6 个 koala 实际场景示例（用真实 story 名字）
   - 必填字段说明 + 常见错误（如忘记加 keywords 导致重复创建）
   - 反例：show how *not* to use（如把 "讨论一下方案" 当成 story_create 触发）

3. **title**：为 story_advance 写完整 PROMPT
   **context**：
   - 何时主动 advance（checklist 全 done + 阶段 guard 满足）
   - 各 phase 转换的前置条件清单
   - DONE Final Checklist 失败时的处理流程（不要反复重试，先看哪一项 fail）
   - "卡死不推进"是反模式（应该 retry / fix / discard 三选一）
   - 包含 ROLLBACK 路径的说明（DEV ← TEST_CASE_REVIEW、TEST_CASE ← TEST 等）

4. **title**：为 checklist_update 写完整 PROMPT
   **context**：
   - "标 in_progress 在开始前，标 done 在 commit 后" 的纪律
   - 每次只动一项（避免批量 update 多个 done）
   - testIntent 字段是 test-intent agent 的事，主 agent 不要写
   - 反例：批量标 done 5 个 item 然后才写代码 = 撒谎

5. **title**：为 fixture_batch_add 写完整 PROMPT
   **context**：
   - 何时 batch 添加（DEV→TEST_CASE 切换时）
   - execute 字段的写法（动态 import dist/，不能 import src/）
   - intentRef 必填，格式 `CHK-xxx:happy|edge|adversarial:N`
   - 完整 case 示例（cli_blackbox 和 browser_blackbox 各一个）
   - 反例：execute 里直接 import 源码（编译产物才是真相）

6. **title**：在 PROMPT 里包含场景化的 step-by-step 引导
   **context**：每个 PROMPT 末尾加一段 "如果你不确定该怎么用，按以下步骤："。让 agent 在不确定时有 fallback。

7. **title**：printToolHelp 在输出末尾加 "→ 用 koala session_brief 看当前应该做什么"
   **context**：每个 --help 输出最后都引导 agent 回到 session_brief（如果它是因为不知道做什么才查 --help 的）

8. **title**：fixture 验证 long PROMPT 包含必要关键词
   **context**：grep 4 个核心命令的 long description，断言包含 "When to use"、"When NOT"、"Example" 等结构标记

### 测试方向

- happy：4 个 PROMPT 都包含 5 段结构（when-to-use / when-not / examples / step-by-step / 反例）
- edge：每个 PROMPT 长度合理（200-500 行），不要太短不要太长
- adversarial：拿一个新 Claude session 跑 `koala story_create --help`，观察它是不是真的学会了用法

### 验收

- 4 个 long PROMPT 已写
- 拿一个干净 session 跑 koala help → koala story_create --help → 让 Claude 创建一个 story，观察是不是 first-try 就用对

### 触点

- 修改：`packages/main/src/cli-engine.ts` 的 ToolDef interface 和 MAIN_TOOLS 数组
- 修改：`packages/main/src/cli-engine.ts:207-235` 的 printToolHelp 函数
- 新建（可选）：`packages/main/src/cli-prompts/`目录，把 4 个长 PROMPT 单独放文件里

---

## Story 5：stale state 检测【P1】

### Description

CC 的 todo_reminder 每 10 轮没用 TodoWrite 就注入 system-reminder。koala 没有这个 —— 一旦 agent 忘了 advance，story 一直挂着，没人提醒。

koala 的 activity.jsonl 已经记录了所有命令时间戳。**消费它就能做 stale state 检测**。

修复目标：每个 koala 命令运行前先 print warning 到 stderr（不阻塞），如果检测到 stale state（超时未 advance、in_progress item 卡死、长时间无 koala 调用），让 agent 看到。

### Checklist

1. **title**：新建 src/core/stale-detector.ts
   **context**：导出 `detectStaleState(ctx: HandlerContext): string[]` 返回 warning 数组。每条 warning 是一行可读文字。

2. **title**：实现 rule 1 — story 在某个 phase 超过 30 分钟没 event
   **context**：读 active story 的 events，最后一条事件超过 30 分钟前就 warn `Story B-xxx 已在 PHASE 阶段 N 分钟未 advance`

3. **title**：实现 rule 2 — checklist 有 in_progress 超过 30 分钟
   **context**：扫 checklist.items，status === 'in_progress' && (Date.now() - new Date(item.startTime).getTime()) > 30min，warn `CHK-xxx 已 in_progress N 分钟，是不是已经做完忘记标 done?`

4. **title**：实现 rule 3 — 距离上次任意 koala 命令超过 60 分钟
   **context**：读 activity.jsonl 最后一条记录，超过 60 分钟前就 warn `距离上次 koala 命令已过 N 分钟，记得继续走流程`

5. **title**：实现 rule 4 — open bug 超过 24 小时未 fixed
   **context**：扫 bug.json，status === 'open' 且 createdAt 超过 24h 前，warn `Bug BUG-xxx 已 open 超过 24h，建议优先修复`

6. **title**：runCli 在 dispatch 命令前调用 detectStaleState
   **context**：把每条 warning 输出到 stderr。注意只在有 active story 时才检测，避免 koala help 这种命令被打扰。

7. **title**：thresholds 通过 koala.config.json 可配置
   **context**：config 加 `staleThresholds: { phaseStale: 30, itemStale: 30, idleKoala: 60, bugStale: 1440 }` (单位分钟)

8. **title**：fixture 验证每个 rule 触发条件
   **context**：构造 4 种 stale 状态的 mock，分别断言对应 warning 出现

### 测试方向

- happy：无 stale 时不输出 warning
- edge：刚跨过阈值 1 秒时正确触发
- adversarial：activity.jsonl 损坏 / story.events 缺失时不抛错

### 验收

- 手动制造一个 in_progress 超 30 分钟的 item，跑任意 koala 命令观察是否 print warning
- 跑过一次后做 checklist_update done，再跑命令应该不再 warn

### 触点

- 新建：`packages/main/src/core/stale-detector.ts`
- 修改：`packages/main/src/cli-engine.ts:519-530`（runCli 在 createMainRegistry 之后调用 detectStaleState）
- 修改：`packages/main/src/core/config.ts` 加 staleThresholds

---

## Story 6：Hook 系统【P1】

### Description

CC 有 PreToolUse / PostToolUse / SessionStart / Stop hook，用户在 settings.json 挂自己的 shell 脚本。koala 完全没有。

为什么 koala 需要：

- agent 跑完 `story_advance phase=DEV` 后想自动 `git fetch origin main && git merge`，现在没机制
- 用户想在 koala 命令出错时自动 push 错误日志
- **observer 想在 koala state 变化时收到通知**（比 polling activity.jsonl 优雅）

这也是 observer 接通 koala 的关键基础设施 —— observer 不需要 polling，挂个 PostCommand hook 就能实时收到事件。

### Checklist

1. **title**：在 koala.config.json 加 hooks 字段定义
   **context**：core/config.ts 的 KoalaConfig 加：
   ```ts
   hooks?: {
     preCommand?: Record<string /* commandName or "*" */, string[] /* shell commands */>
     postCommand?: Record<string, string[]>
     onError?: Record<string, string[]>
     onPhaseChange?: Record<string /* "FROM->TO" or "*" */, string[]>
   }
   ```

2. **title**：新建 src/core/hooks.ts 调度框架
   **context**：导出 `runHooks(stage: 'preCommand' | 'postCommand' | 'onError' | 'onPhaseChange', commandName: string, env: Record<string, string>): Promise<void>`。匹配 commandName 或通配 "*"，spawn shell 命令。环境变量传给 hook 脚本（KOALA_STORY_ID、KOALA_PHASE、KOALA_COMMAND、KOALA_ERROR 等）。

3. **title**：在 cli-engine.ts run() 里 invoke preCommand hooks
   **context**：parse 完参数、validate 完之后、执行 handler 之前，调用 runHooks('preCommand', cmd, env)。如果 hook 返回非零退出，决定是否阻塞主命令（默认不阻塞，只输出 warning）

4. **title**：在 run() 里 invoke postCommand hooks
   **context**：handler 执行完成后调用 runHooks('postCommand', cmd, env)。env 里加 KOALA_RESULT_JSON

5. **title**：在 run() 的 error 路径加 onError hook
   **context**：catch 到错误时调用 runHooks('onError', cmd, env)，env 里加 KOALA_ERROR

6. **title**：在 story-advance.ts 加 onPhaseChange hook 触发
   **context**：phase 转换成功后，按 "FROM->TO" 格式查找 hook，调用 runHooks('onPhaseChange', `${oldPhase}->${newPhase}`, env)

7. **title**：实现 hook timeout 保护
   **context**：每个 hook 命令默认 30 秒 timeout，超时 kill 进程并输出 warning。防止有问题的 hook 拖垮 koala

8. **title**：写 hook 文档 + 示例
   **context**：在 docs/guide.md 加一节 "Hooks"，含完整配置示例和几个常用 use case（auto sync、telegram notify、auto backup）

9. **title**：fixture 验证 hook 调度
   **context**：构造一个临时的 koala.config.json 含 echo hook，跑 koala 命令，断言 hook 被执行（通过检查 echo 的输出）

### 测试方向

- happy：所有 4 类 hook 都能正常触发并传递 env 变量
- edge：hook 命令不存在 / hook 输出超大 / hook 执行很慢但未超时
- adversarial：hook 命令有 SQL injection 风险（用户配置错误时）/ hook 死循环

### 验收

- 配一个 postCommand hook 写日志到 /tmp/koala.log，跑任意命令观察日志被写入
- 观察 onPhaseChange hook 在 story_advance 时被触发

### 触点

- 新建：`packages/main/src/core/hooks.ts`
- 修改：`packages/main/src/core/config.ts` 加 hooks 字段
- 修改：`packages/main/src/cli-engine.ts:575-594` 的 run 函数
- 修改：`packages/main/src/handlers/story-advance.ts` 加 onPhaseChange 触发
- 新建：`packages/koala/docs/guide-hooks.md`

---

## Story 7：命令 metadata + dry-run 支持【P2】

### Description

CC 没有显式 metadata，但 koala 是 CLI 工具，agent 需要知道：

- `test_auto` 跑一次要 30 秒还是 5 分钟？（决定是否等）
- `story_discard` 是否不可逆？（决定是否需要 confirm）
- `arch_trace` 是只读还是写 state？

危险命令（story_discard、dev_merge、fixture_migrate、fixture_batch_add 大批量）应该支持 `--dry-run` 显示会做什么但不真做。

### Checklist

1. **title**：ToolDef 加 metadata 字段
   **context**：
   ```ts
   interface ToolDef {
     // 现有字段
     expectedDuration?: 'fast' | 'medium' | 'slow' | number  // < 1s / 1-10s / > 10s
     sideEffects?: Array<'read-only' | 'writes-state' | 'writes-fs' | 'spawns-process' | 'irreversible'>
     stability?: 'stable' | 'experimental' | 'deprecated'
     supportsDryRun?: boolean
   }
   ```

2. **title**：为所有 MAIN_TOOLS 填 metadata
   **context**：根据每个命令实际行为填写。read-only 类（story_get / story_list / checklist_get）标 read-only。state-mutating 类标 writes-state。git 操作类标 writes-fs。test_* 类标 spawns-process + slow。

3. **title**：标记 4 个 irreversible 命令
   **context**：story_discard / dev_merge / fixture_migrate / test_auto（会 git restore）。这些命令的 metadata 加 `irreversible: true`

4. **title**：printHelp 按 stability 分组
   **context**：把 deprecated 命令放最下面，experimental 命令单独标记 [exp]

5. **title**：irreversible 命令默认要求 --confirm
   **context**：cli-engine.ts 在 dispatch 前检查，如果命令是 irreversible 且没传 --confirm，print warning + 跳出 dry-run 报告，不真执行

6. **title**：实现通用 dry-run 框架
   **context**：handler 函数接受 ctx.dryRun: boolean。dry-run 时只 print 计划不真改 store。约定输出格式：
   ```
   [DRY-RUN] story_discard B-042 would:
     - delete worktree .worktrees/B-042/
     - delete branch story/B-042
     - mark story as DISCARDED
   → 加 --confirm 真实执行
   ```

7. **title**：为 4 个 irreversible 命令实现 dry-run 路径
   **context**：每个命令实现一个 plan() 函数返回"会做什么"，dry-run 时只调 plan() + print；正常执行时调 plan() + execute()

8. **title**：fixture 验证 dry-run
   **context**：跑 `story_discard B-test --dry-run`，断言 store 中 story 仍存在 + 输出包含 "[DRY-RUN]"

### 测试方向

- happy：每个 irreversible 命令的 dry-run 输出符合预期
- edge：dry-run 后真实执行能成功
- adversarial：dry-run 执行 + 期间状态被外部改变 + 真实执行的 race condition

### 验收

- `koala help` 输出按 stability 分组
- `koala story_discard B-xxx` 默认拒绝执行，提示加 --confirm
- `koala story_discard B-xxx --dry-run` 输出计划且不改 store

### 触点

- 修改：`packages/main/src/cli-engine.ts` ToolDef + MAIN_TOOLS + printHelp
- 修改：`packages/main/src/handlers/worktree.ts`、`fixture.ts` 等含 irreversible 操作的 handler

---

## Story 8：progress streaming 补全【P2】

### Description

`test_auto` 跑 30 秒到几分钟，期间 agent 看不到中间进度。CC 的 streaming 给 agent 实时信号知道还在跑没卡死。koala 有 `ctx.log` 但很多地方没用。

watchdog 机制（2 分钟无活动 kill）也需要这些 log 调用来重置 lastActivity。**进度日志缺失 = watchdog 误杀慢命令**。

### Checklist

1. **title**：grep 所有 ctx.log 的使用 + 找出 high-latency 函数
   **context**：找出哪些 handler 跑超过 5 秒但 log 调用稀疏。重点关注：test_auto / test_story / arch_trace / aux_scan / fixture_migrate

2. **title**：为 test_auto 补 progress log
   **context**：每个 fixture file 处理前 log 一行 `[Ns] processing fixtureName: total=X executable=Y`，每 10 个 case 输出一行 `[Ns] running cases: K/Total`

3. **title**：为 arch_trace / aux_scan 补 progress log
   **context**：scanning 阶段、parsing 阶段、analysis 阶段各 log 一行

4. **title**：log 格式统一加时间戳
   **context**：参考 cli-engine.ts:524 的 `[${elapsed}s] ${msg}` 格式，确保所有 log 都用这个格式（runtime 自动加，handler 不需要自己加）

5. **title**：handler 内部异步任务的 progress 上报
   **context**：例如 test_auto 跑多个 fixture file，每个 file 完成后 log 一行。可以加一个 helper `progressFor(label, items, fn)` 自动 log

6. **title**：fixture 验证 watchdog 不会误杀慢命令
   **context**：构造一个跑 3 分钟但每 30 秒 log 一次的命令，断言 watchdog 不 kill（IDLE_TIMEOUT 是 2 分钟）

### 测试方向

- happy：长命令期间持续输出
- edge：log 输出频率刚好到 IDLE_TIMEOUT 临界
- adversarial：log 自身写入失败时不影响主流程

### 验收

- 跑 `koala test_auto` 观察 stderr 持续有时间戳输出
- 故意构造一个 5 分钟才结束的 fixture，观察是否被 watchdog 误杀

### 触点

- 修改：`packages/main/src/handlers/test-auto.ts`
- 修改：`packages/main/src/handlers/test-story.ts`
- 修改：`packages/utils/src/handlers/aux-trace.ts`
- 修改：`packages/utils/src/handlers/aux.ts`

---

## Story 9：schemaVersion + 空 migration【P3】

### Description

koala 的 store 写的 JSON 文件没有 schemaVersion 字段。**未来要改 story.json / checklist.json 的字段结构，老 story 文件会炸**。

CC 有 [src/migrations/](src/migrations/) 处理 schema 升级。现在做这件事 0 成本（schemaVersion=1 + 一个空 migration），未来真需要改 schema 时直接加 v1→v2 migration。

### Checklist

1. **title**：所有 store 类型加 schemaVersion 字段
   **context**：types.ts 的 StoryInfo / ChecklistData / BugData / TestEvidenceData / ReviewData 都加 `schemaVersion: 1`

2. **title**：新建 src/core/migrations.ts 框架
   **context**：导出 `migrateStory(data: any): StoryInfo`、`migrateChecklist(data: any): ChecklistData` 等。内部按 schemaVersion 分支处理。v1 是 noop（直接补 schemaVersion=1）

3. **title**：store.readJson 内部调 migrate
   **context**：所有 read* 方法 read 完后调对应的 migrate 函数。让老格式数据自动升级（write 时会带上新的 schemaVersion）

4. **title**：fixture 验证 v0 → v1 自动迁移
   **context**：构造一个无 schemaVersion 的老 story.json，readStory 后断言返回数据含 schemaVersion=1

5. **title**：写一段文档说明 migration policy
   **context**：在 docs/decisions 加一个 schema-migration.md，写清楚未来 schema 改动的流程：
   - bump schemaVersion
   - 加 migrate 函数
   - 写至少一个老 → 新数据的 fixture
   - 不允许 breaking change，只允许 additive

### 测试方向

- happy：老格式 read 后自动补 schemaVersion
- edge：write 后 read 一遍格式仍正确
- adversarial：schemaVersion 是字符串 / 是负数 / 缺失等异常情况

### 验收

- 把现有的某个 story.json 手动删掉 schemaVersion，read 后能正常返回
- 手动加 schemaVersion=999，read 时报清晰错误

### 触点

- 修改：`packages/main/src/core/types.ts`
- 新建：`packages/main/src/core/migrations.ts`
- 修改：`packages/main/src/core/store.ts` readJson
- 新建：`packages/koala/docs/requirements/decisions/schema-migration.md`

---

## Story 10：search 命令 + 调用栈防递归【P3】

### Description

两个独立但都属于 P3 的小改进，合并成一个 story。

**search 命令**：CC 有 ToolSearchTool 用 select/keyword 找工具。koala 有 40+ 命令，agent 不确定某个功能叫什么时要 grep 一遍 help 输出。

**调用栈防递归**：koala 已经有 `__koalaTestAutoRunning` 全局标志防 test_auto 递归，但只针对一个命令。需要通用化为 call stack。

### Checklist

1. **title**：实现 koala search
   **context**：新增 ToolDef `{ name: 'search', description: '按关键词搜索 koala 命令', schema: { keyword: z.string() } }`。handler 用简单 BM25 在所有 MAIN_TOOLS 的 description 上做匹配，输出按相关性排序的列表

2. **title**：search 输出格式
   **context**：
   ```
   koala search 决策
     - testintent_record (0.85): 追加 testIntent 审核结果
     - story_review     (0.70): 对抗审查 testIntent 完整性
     - checklist_update (0.55): 更新 checklist 项
   → 加 --help 看完整参数
   ```

3. **title**：模糊匹配中文 + 英文
   **context**：tokenize 时同时支持中文和英文，避免 "决策" 匹配不到 "decision"

4. **title**：实现通用调用栈
   **context**：cli-engine.ts run() 函数开头 push 命令名到 `globalThis.__koalaCallStack`，结束时 pop。fixture runner 调 `$handlers.foo()` 时也 push。

5. **title**：递归检测
   **context**：push 前检查 stack 中是否已含本命令名。已含就 throw `Recursion detected: ${stack.join(' → ')} → ${cmd}`

6. **title**：移除老的 __koalaTestAutoRunning 标志
   **context**：通用 call stack 已经覆盖这个 case，老标志可以删除。但要先确保 fixture runner 也走通用 stack

7. **title**：fixture 验证递归被检测
   **context**：构造一个 fixture case 调 `$handlers.test_auto()`，断言抛 "Recursion detected" 错误

### 测试方向

- happy：search 返回相关命令；调用栈正常 push/pop
- edge：search 关键词匹配不到任何命令时返回空结果
- adversarial：fixture 内部调多层嵌套命令，确保检测到递归而不是无限循环

### 验收

- `koala search 决策` 输出至少 3 个相关命令
- 故意构造递归 fixture 跑 test_auto，看是否被检测到

### 触点

- 修改：`packages/main/src/cli-engine.ts` 加 search ToolDef + run() 加 call stack
- 新建：`packages/main/src/handlers/search.ts`
- 修改：`packages/main/src/handlers/test-auto.ts` 移除 __koalaTestAutoRunning
- 修改：`packages/main/src/handlers/test-runner-core.ts` fixture runner 加 call stack push

---

## 实施建议

### 推荐落地顺序

按 ROI 排序，**优先做 Story 1-4（P0）**。

```
第 1 周（核心改造）:
  Day 1-2: Story 1 (nextStepHint 全覆盖)
  Day 3:   Story 2 (silent catch 修复)
  Day 4:   Story 3 (session_brief)
  Day 5-7: Story 4 (4 个核心命令 PROMPT 化)

第 2 周（基础设施）:
  Day 8-9:  Story 5 (stale state 检测)
  Day 10-12: Story 6 (Hook 系统)

第 3 周后（可选）:
  Story 7-10 视实际需求做
```

P0 + P1 共 12 天工作量，做完后 koala 的"agent 用错"问题会显著减少。

### 不要一次全做

每个 story 落地后**至少跑一周**，观察 activity.jsonl 数据：

- agent 调 koala 的频率是否上升（hint 起作用了）
- silent failure 是否减少（health.jsonl 不为空）
- 新 session 启动时是否真的跑 session_brief（CLAUDE.md 引导生效）
- 如果数据没动 → 改造没生效 → 排查为什么 agent 没采纳

不要一次做完所有 story 然后等长期效果。**每个 story 是独立可验证的**。

### Story 间的依赖

```
Story 1 (nextStepHint)  ← 独立
Story 2 (silent catch)  ← 独立
Story 3 (session_brief) ← 独立
Story 4 (PROMPT 化)     ← 独立（但和 Story 3 协同 — 4 在 PROMPT 末尾引用 session_brief）

Story 5 (stale)         ← 依赖 Story 2 的 health.ts 框架
Story 6 (hooks)         ← 依赖 Story 1 的 decorateResult 设计

Story 7-10 ← 独立
```

P0 4 个 story 完全无依赖，可以并行。

### 验证遥测

每个 story 落地后跑这个分析：

```bash
# Story 1 验证：koala 命令调用频率
cat docs/story/activity.jsonl | jq -r '.tool' | sort | uniq -c | sort -rn

# Story 2 验证：health.jsonl 是否被合理写入
ls ~/.koala/health.jsonl
wc -l ~/.koala/health.jsonl

# Story 3 验证：每天有几次 session_brief 调用
cat docs/story/activity.jsonl | grep session_brief | wc -l

# Story 4 验证：观察新 session 是否减少了 koala 调用错误
# 看 activity.jsonl 的 status=fail 的比例
```

## 一句话总结

**koala 现在的问题不是"机制不够"，是"跟 agent 沟通不够"**。它有 phase gate、Final Checklist、签名 review、物理验证 —— 这些都对，但**这些信号没有清晰传达给 agent**。

CC 的 TodoWrite 强大不是因为它的数据结构多复杂（其实极简），而是因为它的 PROMPT + reminder + result reinforce 三合一让模型内化了使用习惯。

把这套"沟通三合一"搬到 koala，是从 CC 学的最有价值的事。其它机制（cache、deferred、autoCompact）都是 CC 在 LLM 上下文场景下的特化，对 CLI 工具不直接适用。

## B-5ea4 复盘 (2026-04-08)：工程完成 ≠ 任务完成

来自 koala-agent 项目 B-5ea4 (avatar-escalation-resume-loop) 的实战教训。这个 story 的工程完成度 9/9 但用户价值完成度 0/5，是 koala 流程**最严重的盲区**实例。

### 工程视角看到的（全绿）
- EscalationQueue 加 answered 事件 + answerPromise API → ✓
- intercept 在 low-confidence + llm-failed 都走 wait-then-resume → ✓
- spawn 第 2 个 claude 子进程 + 同 sessionId → ✓
- canonical resume prompt 让第 2 个 claude 不被 CLAUDE.md 项目 context 绑架 → ✓
- /code summary 输出 wall=/wait=/active= 三段时间 → ✓
- 8 个 unit fixture 全 pass → ✓
- reviewer 三方制衡过审 → ✓
- 真机手测 2 次（3 问题 batch + 1+1 单问题）9/9 事件验证点全过 → ✓

### 用户视角看到的（不及格）
真机跑 `/code 必须调 AskUserQuestion 工具问我一个问题：1+1=？ 选项 2/3/4`，用户实际看到的最后段：

```
[claude] session ea3045f9 started   ← 第 2 个 claude
问题已发出，等你选择。               ← claude 说的，看起来还在等
[✓ claude-code ea3045f9 exit=0 3t $0.0711 wall=100.4s wait=9.8s active=90.6s]
> 
```

用户读完会问："**它到底完成了没有？'问题已发出，等你选择' 是什么意思？我刚才已经选了啊**？" 没有一句人话告诉用户"答案已推送给 Claude Code，它已经基于你的答案完成任务"。

### 4 个根因
1. **PLAN 阶段没写 outcome transcript** —— understanding_set 的 outcome 字段当时只写了一句抽象的"escalation 事件链路打通"，没有写"用户敲完命令后会在终端依次看到 X/Y/Z 这些行"。
2. **DEV 阶段真机测试时主 agent 用工程师视角读输出** —— 验证了 9 个事件点（session 数、stub 检测、event emit、event subscribe、queue answer、resume spawn、time accounting、cap），但**没有把自己当成用户从头读一遍最终输出**，问"这串文字读完用户会觉得任务完成了吗？"
3. **三方制衡只兜工程，不兜产品** —— test-intent agent 写的 testIntent 全是工程行为；test-case-reviewer 审的是 testIntent 覆盖率；reviewer 没有"假装我是用户"这一步。9/9 工程指标全通过 reviewer 仍然 pass。
4. **smoke fixture 文化是"证明事件流通了"** —— 强调"LLM 真的会按预期反应"和"工具调用真的发生了"，没强调"用户读这段输出感觉任务结束了吗"。

### koala 框架因此做的修改

1. **packages/koala/CLAUDE.md** 加新章节「用户价值验收（优先于技术链路验证）」，明确写"工程完成 ≠ 任务完成"、PLAN 阶段必须产出 user-facing transcript、真机测试必须切换视角、5 题 DONE 自检清单。完整 B-5ea4 复盘也写在那里。
2. **story-advance.ts** 的 PLAN/DEV/TEST/DONE phase hint 都加了 "⚠ 用户价值验收" 提醒段，每次 phase 推进时主 agent 都会被重新提示一次"不要只盯事件日志"。
3. **本 cc-learnings.md** 加这一段，作为 koala 框架的永久学习记录。

### 还没做但应该做的

- **product-reviewer agent**：和 test-case-reviewer 并列的第 4 类角色，专门审"用户视角下 outcome 是否达到"。当前 review 阶段只有工程视角的 reviewer，加这个才能完整三方制衡。属于未来 story。
- **understanding_set 的 outcome 字段在 review 阶段做软质量检查**：如果 outcome 长度 < 100 或包含太多抽象词（"链路、事件、机制、闭环"等），reviewer prompt 加一条"质疑 outcome 是不是 user-facing transcript"。属于未来 story。
- **DONE gate 强制要求 evidence/transcript-diff.md**：把 PLAN outcome 当 expected、真机 actual transcript 当 actual，diff 后的产物作为 DONE 必交物。属于未来 story（要小心：硬 gate 会惩罚那些不需要 user-facing transcript 的 story 比如纯重构 / koala 框架修复，可能需要 type-aware 豁免）。

### 一句话总结

**koala 之前的所有机制都是程序思维的延伸**（fixture、reviewer、phase gate、smoke）。B-5ea4 暴露的是 koala **没有产品思维的延伸**——一个能让主 agent 在每次推进时被强制问"用户视角你说完成了吗"的机制。本次修改加的是这个产品思维通道的最小可用版本：CLAUDE.md 写规则 + phase hint 重复提醒。下一次有人在 koala 流程下犯同样错误，至少在 PLAN/DEV/TEST/DONE 任何一次 advance 都会被提示一遍。

## 参考

- `/Users/xiaoxx/Documents/GitHub/CC/src/tools/TodoWriteTool/prompt.ts` — PROMPT 风格参考
- `/Users/xiaoxx/Documents/GitHub/CC/src/utils/attachments.ts:3266-3317` — periodic reminder 注入逻辑
- `/Users/xiaoxx/Documents/GitHub/CC/src/services/compact/autoCompact.ts:67-70` — 断路器示例
- `/Users/xiaoxx/Documents/GitHub/CC/src/tools.ts:191` — 跨系统 cache key 注释
- `packages/koala/packages/main/src/handlers/story-advance.ts:432-449` — 现有 nextStepHint 唯一参考
- `packages/koala/packages/main/src/cli-engine.ts:534-553` — 现有 watchdog 实现
- `packages/koala/packages/main/src/cli-engine.ts:556-573` — 现有 activity.jsonl 写入
