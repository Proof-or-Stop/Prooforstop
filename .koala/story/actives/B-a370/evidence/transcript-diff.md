# B-a370 真机用户视角验证 — transcript diff

测试时间：2026-05-16，TEST 阶段
CLI：worktree 编译产物 `packages/main/dist/cli.js`
方式：临时 koala 项目（`/tmp` 下，独立 git 仓 + `koala.config.json`），用新 CLI 真机跑 `session_brief` / `next`；META 容器经 `ensureMetaStory` 创建。

## Expected（PLAN outcome）

用户对 `B-META-framework-audit` 这种 meta-story 跑 `koala next` 或 `koala session_brief` 时，终端看到的不再是 `story_advance --phase=INIT_CHECK` 或创建 worktree 这类对容器无效的 lifecycle 引导，而是 META 专用建议（指向 audit/finding flow）。同时 `session_brief` 的 lifecycle/worktree 建议排序里不再出现 META 容器。

## Actual transcript

```
$ koala session_brief        （META 容器是唯一 story）

# koala session brief
**Dashboard**: Lifecycle DONE: 0/1 (0%) · ...

## META containers (1)
  B-META-framework-audit — audit/finding flow 容器，不走 story lifecycle
  → 用 `koala audit` / `koala finding_list` 处理，不要 story_advance 或建 worktree

## → Next step
  B-META-framework-audit 是 META 容器（audit/finding flow 的常驻容器），不走普通 story
  lifecycle，也不需要 worktree。用 `koala audit` 查看框架自省结果、`koala finding_list`
  处理它的 finding；不要对它 story_advance 或创建 worktree。

$ koala next

B-META-framework-audit 是 META 容器（audit/finding flow 的常驻容器），不走普通 story
lifecycle，也不需要 worktree。用 `koala audit` 查看框架自省结果、`koala finding_list`
处理它的 finding；不要对它 story_advance 或创建 worktree。
```

关键观察：
- **没有** `## Active stories` 段 —— META 容器没被算进 active story 排序。
- **没有** `story_advance --storyId=B-META-framework-audit --phase=INIT_CHECK` 这类无效 lifecycle hint。
- META 容器单独进 `## META containers` 段，并给出 audit/finding flow 专用引导。
- `koala next` 返回同一条 META 专用引导。

## Diff（expected vs actual）

| 维度 | Expected | Actual | 结论 |
|---|---|---|---|
| META 容器不进 lifecycle 排序 | 是 | 无 `## Active stories` 段，META 不在排序里 | 一致 |
| 不输出无效 lifecycle hint | 是 | 无 `story_advance` / `INIT_CHECK` / worktree 引导 | 一致 |
| META 专用建议 | 指向 audit/finding flow | `## META containers` 段 + Next step 均指向 `koala audit` / `koala finding_list` | 一致 |
| `koala next` 同样修复 | 是 | next 返回 META 专用引导 | 一致 |

无差异需回退。验收通过。

## 修复前对照（F-003 根因）

修复前：`session_brief` 的 `computeNextStep` switch 无 META 分支、`activeStories` 不排除 META 容器 → META 容器被当普通 active story，`→ Next step` 对它输出 `Story B-META-framework-audit is in META but has no worktree. Try koala story_advance --storyId=B-META-framework-audit --phase=INIT_CHECK` —— 一条注定被 `audit-meta-store` guard 拒绝的无效引导。
