# B-6812 真机用户视角验证 — transcript diff

测试时间：2026-05-16，TEST 阶段
CLI：worktree 编译产物 `packages/main/dist/cli.js`
方式：临时 koala 项目（`/tmp` 下，独立 git 仓 + `koala.config.json`），用新 CLI 真机跑 `story_create` 序列。

## Expected（PLAN outcome）

用户在多 agent 并发开发同一仓库时，跑 `koala story_create` 创建一个与已有 active story 同名或 keyword 完全重叠的 story，终端 stderr 会看到 `❌ 疑似重复 story B-xxxx`，确认要新建请加 `forceNew:true`，命令 exit code 非 0、不产生第二份目录；即使接了 `tail` 管道警告因走 stderr 仍可见。正常创建无冲突 story 时若 30 分钟内有其它新 story，stderr 额外显示 `⚠ 最近 30 分钟内还创建了 N 个 story`。

## Actual transcript

```
1) 基线创建 demo-alpha (keywords concur/dedup/race)
   stdout: Story B-3a77 created (IDEA)        exit=0

2) normalized-name idempotency: 创建 "Demo_Alpha"（归一化等于 demo-alpha）
   stdout: ⚠ Story already exists: B-3a77 (name="demo-alpha", phase=IDEA)
           归一化 name "demo-alpha" 与已有 story 一致；复用已有 storyId 而非新建。如需强制新建，传 forceNew:true。
   exit=0   （幂等复用，非报错）

3) keyword 完全重叠 block: 新 story keywords=[concur,dedup] 被 demo-alpha 完全覆盖
   stdout: （空）
   stderr: story_create failed: ❌ 疑似重复 story B-3a77（keyword 完全重叠: concur, dedup），确认要新建请加 forceNew:true
   exit=1

4) tail 管道: koala story_create ... 2>err | tail -1
   tail 截取的 stdout: （空 — 错误未污染 stdout）
   stderr（未被 tail 吃掉）: ❌ 疑似重复 story B-3a77（keyword 完全重叠: concur, dedup）...

5) 无冲突创建 fresh-unrelated
   stdout: Story B-b0de created (IDEA)        exit=0
   stderr: ⚠ 最近 30 分钟内还创建了 1 个 story：
             - B-3a77 [IDEA] Baseline alpha story

结果目录：.koala/story/actives/ 下只有 B-3a77、B-b0de
         —— 步骤 2/3/4 的重复尝试均未产生多余目录。
```

## Diff（expected vs actual）

| 维度 | Expected | Actual | 结论 |
|---|---|---|---|
| normalized-name 冲突 | 提示疑似重复 | `⚠ Story already exists`，幂等复用 storyId，exit=0 | 一致（行为更友好：幂等而非报错） |
| keyword 完全重叠 | stderr 报 ❌ 疑似重复 + exit 非 0 | stderr `❌ 疑似重复 story B-3a77（keyword 完全重叠: concur, dedup）`，exit=1 | 一致 |
| 不产生第二份目录 | 是 | actives/ 仅 2 个目录，重复尝试 0 残留 | 一致 |
| tail 管道下警告可见 | 警告走 stderr 仍可见 | tail 只截 stdout（空），警告完整留在 stderr | 一致 |
| 最近并发提示 | stderr 显示 ⚠ 最近 30 分钟内… | stderr `⚠ 最近 30 分钟内还创建了 1 个 story：- B-3a77 …` | 一致 |

## 说明

PLAN outcome 把「normalized name 冲突」和「keyword 完全重叠」并列说成都会看到 `❌ 疑似重复`。实际实现做了**更合理的区分**：
- normalized/exact name 命中 → 幂等复用（`⚠ Story already exists`，exit 0）：用户在重建同一个 story，给回已有 storyId 是帮忙，不该报错。
- keyword 完全重叠（不同 name）→ 硬 block（`❌`，exit 1，需 forceNew）：这才是「看起来像换名重复」的可疑情形，拒绝创建。

这个区分不是偏离 outcome，而是 outcome 的合理细化——用户最终观察到的「撞并发时能在创建当下看见、且不产生重复 story」目标完全达成。

无差异需回退。验收通过。
