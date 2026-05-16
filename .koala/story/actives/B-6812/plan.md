# Plan: B-6812 Harden story_create against concurrent duplicate creation

## 总览

修复 story_create 并发重复创建漏洞 G1-G4。三个 item 全部触及 `packages/main/src/handlers/story-create.ts`，写集重叠，必须**串行**实现，不可并行 dispatch。代码由 koala-implementer 写，主 agent 只做 PLAN / 分配 / 验收。每个 item 完成并 commit 后再派下一个 fresh worker。

## CHK-001: 为 story_create 加目录锁让 idempotency 检查与写入原子化

**Owner**: koala-implementer
**DependsOn**: none
**Files**:
- Create: packages/main/src/core/mkdir-lock.ts
- Modify: packages/main/src/handlers/checklist.ts, packages/main/src/handlers/story-create.ts
- Test: packages/main/tests/mkdir-lock.test.ts, packages/main/src/tasks/story-create-concurrency-smoke.ts

**实现要点**:
- 新建 `core/mkdir-lock.ts` 导出 `withMkdirLock(lockDir: string, fn: () => T): T`：`mkdirSync` 原子获取 + deadline 约 5s 超时抛明确错误 + 持锁期间 lockDir mtime 超过 10s 视为 stale 强制回收 + `finally` 释放。机制照搬 checklist.ts 现有 `withChecklistLock`，不改语义。
- `checklist.ts` 的 `withChecklistLock` 改为内部委托 `withMkdirLock`（锁路径仍为 `<story>/checklist.lock`），对外行为零变化。
- `story-create.ts` 的 `story_create` handler body（fromDraft 分支 + 正常分支）整体包进 `withMkdirLock`，锁作用域覆盖 idempotency 扫描 → nextStoryId → writeStory → writeChecklist 全程。
- 锁路径 = `join(ctx.root, store.storyDirRel(), '.create.lock')`，从 `store` 解析实际写目标 baseDir，**绝不**硬编码 `docs/story` 或 `.koala/story`。锁文件父目录不存在时先 `mkdirSync(recursive)`。

**Verify**:
- `koala validate --story=B-6812` 全绿
- `mkdir-lock.test.ts` 单测覆盖：正常获取/释放、deadline 超时抛错、stale（mtime>10s）回收
- `story-create-concurrency-smoke` 用真子进程并发多轮跑 `story_create` 同 name，断言只产生一份 story 目录

**DoneWhen**:
- `withMkdirLock` 抽出且 `checklist.ts` 复用，checklist 相关测试不回归
- 并发 smoke 在**非默认 storyDir 配置**下也通过（直接覆盖 decision preMortem「锁错目录形成假安全」风险）
- 串行创建不同 name 行为不变，各得独立 storyId

## CHK-002: 把重复检测从 exact-name 加强为归一化 name 加 keyword 完全重叠 block

**Owner**: koala-implementer
**DependsOn**: CHK-001
**Files**:
- Create: packages/main/src/core/story-dedup.ts
- Modify: packages/main/src/handlers/story-create.ts, AGENTS.md
- Test: packages/main/tests/story-dedup.test.ts

**实现要点**:
- 新建 `core/story-dedup.ts`（纯模块，无 I/O）：
  - `normalizeName(name)`：lowercase + trim + 下划线/空格/连续连字符归一为单连字符 + 去首尾连字符
  - `keywordOverlap(newKeywords, existingKeywords)`：返回 `{ shared: string[], ratio: number }`，`ratio = shared.length / dedup(newKeywords).length`
- `story-create.ts` idempotency：name 比较改用 `normalizeName`，**仅当 `normalizeName(name).length > 0`** 才参与 normalized-name 匹配（空名/全特殊字符名 fallback，不被误判成同一个 story）。
- keyword block：遍历 active non-terminal story（phase ∉ DONE/DISCARDED），算 `keywordOverlap`；当 `ratio === 1 && shared.length >= 2` → 抛错 `❌ 疑似重复 story B-xxxx（keyword 完全重叠），确认要新建请加 forceNew:true`。`forceNew:true` 时跳过 block。
- DONE/DISCARDED story 的 keyword 完全重叠 → 仅 warn（走 stderr，由 CHK-003 落地），不 block。
- 遵守 CLAUDE.md Handler 编码约定：若 schema 有约束，handler runtime 与所有消费点同标准校验。

**Verify**:
- `story-dedup.test.ts` 单测：`normalizeName` 大小写/分隔符/空串/全特殊字符→空串、`keywordOverlap` ratio 计算 + 去重
- `koala validate --story=B-6812` 全绿
- concurrency-smoke：normalized name 命中返回已有 storyId；keyword 完全重叠 block + `forceNew` override；部分重叠（ratio<1）不 block；DONE story 完全重叠不 block

**DoneWhen**:
- 空 normalized name 不参与 dedup，旧 `name:""` 数据不被误判成同一个
- keyword block 仅对 active non-terminal story，DONE/DISCARDED 最多 warn
- `forceNew:true` 能 override block
- AGENTS.md story_create 段说明新 dedup 行为与 `forceNew` override

## CHK-003: 重复与并发警告改走 stderr 并在创建时摊开最近并发 story

**Owner**: koala-implementer
**DependsOn**: CHK-002
**Files**:
- Modify: packages/main/src/handlers/story-create.ts, AGENTS.md, CLAUDE.md
- Test: packages/main/src/tasks/story-create-concurrency-smoke.ts

**实现要点**:
- `story-create.ts` 的 `dupWarning`、keyword 重叠警告、`riskHint` 等 advisory 文本从拼进返回字符串改为 `process.stderr.write`（与现有 normal 通道 DEPRECATED 警告一致）。创建成功结论 `Story B-xxxx created ...` 仍留 stdout 返回值。
- 创建成功后扫 `listStoryIds()`，筛 `createdAt` 在 now 减 30 分钟内、且 phase ∉ DONE/DISCARDED 的其它 story，写 stderr：`⚠ 最近 30 分钟内还创建了 N 个 story：B-xxxx [phase] title`。无则不输出。
- 30 分钟阈值用硬编码常量，不做配置项（YAGNI）。

**Verify**:
- `koala validate --story=B-6812` 全绿
- concurrency-smoke：`story_create 2>err 1>out` 断言 err 含重复/并发警告、out 只剩创建结论；`story_create ... | tail` 场景断言警告仍在 stderr 可见
- 无并发 story 时不输出误报行

**DoneWhen**:
- 重复/并发警告全部走 stderr，stdout 只剩创建结论
- 最近并发 story 列表正确：30min 窗口、排除终态 story
- AGENTS.md 与 CLAUDE.md 的 story_create 相关段同步更新
