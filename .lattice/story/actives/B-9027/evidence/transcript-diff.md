# B-9027 真机验证 — transcript diff

测试时间：2026-05-17，TEST 阶段
对象：DONE merge / worktree cleanup 从 `story-advance.ts` 抽到 `handlers/done-effects.ts`（behavior-preserving extraction，Option A）。

## 为什么真机验证 = worktree-authority-smoke

B-9027 是 behavior-preserving refactor，验收核心是「`story_advance --phase=DONE` 的可见行为前后完全一致」。要真机验证一次完整 DONE 需要一个走完 INIT→...→TEST、带齐 DONE gate 证据（test-evidence / delivery-check / summary）的 story——手工在临时项目造这个不现实。`worktree-authority-smoke.ts` 的 `buildDoneReadyStory` helper 以编程方式造出 DONE-ready story，再用**真子进程** spawn worktree 编译产物 `dist/cli.js` 跑真实 `story_advance --phase=DONE`。所以 smoke 就是 B-9027 的真机测试，且比手工单次跑覆盖更全（成功路径 + 全部失败路径）。

## Expected（PLAN outcome，behavior-preserving）

用户/agent 跑 `koala story_advance --phase=DONE` 看到的输出与重构前 byte-identical：DONE Gate Checklist 各 [✓] 行 + `✓ 分支 story/B-xxx 已合并到 main` + `✓ Worktree 已清理` + `✓ 分支已删除` + summary 段。pre-merge gate（done oracle / stray offender / merge-tree 冲突）失败时 story 保持 TEST；真实 merge 失败时 story 已 DONE + 抛 `已标记为 DONE 但自动合并失败` + 手动 cd/git merge/worktree remove/branch -d 指引。

## Actual（worktree-authority-smoke 真子进程跑）

```
$ npm --prefix packages/main run test:worktree-authority-smoke
✓ worktree authority smoke passed        （15/15 用例：9 原有 + 6 B-9027 新增）
```

6 个 B-9027 新增用例（真子进程 spawn dist/cli.js 跑真实 DONE）：

| 用例 | 验证 |
|---|---|
| `assertDoneSuccessPathOutputAndOrdering` | 成功 DONE 输出 byte-identical；Step metadata commit→merge→worktree remove→branch delete 严格顺序；story-advance.ts 无 inline merge 结构断言 |
| `assertDoneOracleGateFailureKeepsStoryTest` | done oracle gate 失败 → 两 store 中 phase 仍 TEST |
| `assertStrayFileOffenderKeepsStoryTest` | stray-file offender → phase 仍 TEST |
| `assertMergeConflictPreMergeGateKeepsStoryTest` | merge-tree dry-run 检出冲突 → phase 仍 TEST |
| `assertRealMergeFailureMarksDoneAndThrows` | 真实 merge 失败 → phase=DONE 已落盘 + 抛错含 cd/git merge/worktree remove --force/branch -d 四行 |
| `assertWorktreeCleanupFailureMarksDoneMergedAndThrows` | worktree cleanup 失败 → phase=DONE+已合并 + 抛 koala doctor 指引 |

`koala validate --story=B-9027`：✓ ALL PASS，verification coverage 23/32（**0 required missing**，22/22 must intent 全覆盖；9 个 should 级 missing 由 test-coverage reviewer round 1 确认可接受为 advisory）。

## Diff（expected vs actual）

| 维度 | Expected | Actual | 结论 |
|---|---|---|---|
| DONE 成功输出 byte-identical | 是 | `assertDoneSuccessPathOutputAndOrdering` 严格 indexOf 顺序断言 + git log 断言通过 | 一致 |
| Step1-5 顺序不变 | 是 | metadata commit→merge→worktree remove→branch delete 顺序断言通过 | 一致 |
| pre-merge gate 失败 story 保持 TEST | 是 | 三道 gate 各失败用例断言 phase=TEST 通过 | 一致 |
| post-merge 失败 story 已 DONE+抛错+手动指引 | 是 | merge 失败 / cleanup 失败两用例断言通过 | 一致 |
| 时序：pre-merge gate 在 phase 落盘前 | 是 | behavior reviewer 核实 `runDonePreMergeGate`(line 215) 在 `actor.send`(218)/`writeStory`(251) 之前 | 一致 |

无差异需回退。重构前后行为一致——用户察觉不到 done-effects.ts 抽取发生。验收通过。
