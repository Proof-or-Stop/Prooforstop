# B-6974 — TEST 阶段用户视角真机 transcript

Story: **B-6974 Introduce transition orchestrator and thin story_advance handler**
类型: behavior-preserving 重构（Lifecycle Phase 2 收尾）。

## Expected（PLAN outcome）

B-6974 是 behavior-preserving 重构：把 transition 协调从 `story-advance.ts` 抽进
`handlers/transition-orchestrator.ts`，`story-advance.ts` 退化为 thin handler。
**对用户而言不应有任何可观察变化**——`story_advance` 各 transition 的用户可见输出、
退出码、advisory 文案、phase 写入时机、DONE pre/post-merge 语义全部 byte-identical。
判定标准：跑重构后的 koala，`story_advance` 系列命令产出的 transcript 与重构前一致。

## Actual（真机 transcript）

环境：`npm --prefix packages/main run build` 重新构建 B-6974 worktree 的 koala
（即重构后的代码），在临时 git 仓库里用 **新 koala**（`.worktrees/B-6974/packages/main/dist/cli.js`）
真机驱动 `story_advance` 各路径。脚本：`/tmp/b6974_realtest.py`。

```
1) story_create (probe story)
   → "Story B-c032 created (INIT) with 2 checklist items"  + INIT reviewer 引导
   exit=0  ✓

2) story_advance INIT_CHECK（缺 init-check.json）→ orchestrator guard-failure 路径
   → "story_advance failed: Cannot enter INIT_CHECK: 未跑 koala-review-story-init
      agent（缺 init-check.json）。 [missing_init_check]"  + 恢复指引
   exit=1  ✓（守卫失败正确以非零退出 + 正确 blocker 文案）

3) init_check_set ×2（koala-review-story-init / product-reviewer）满足 B-e71f gate
   → "Init check saved for B-c032 ... recorded agents: ..."
   exit=0  ✓

4) story_advance INIT_CHECK → orchestrator success 路径 + worktree-create effect
   → "Story B-c032 advanced to INIT_CHECK"
   → baseline-risk advisory 段（4 个未提交文件）正确渲染
   → "Story B-c032 开发环境已就绪 / 分支: story/B-c032 / 路径: ..." + cd 引导 + nextSteps
   exit=0  ✓

5) story_advance DEV（在 worktree 内）→ 另一条 transition
   → "Story B-c032 advanced to DEV"
   → "极速通道（极速，≤2 项，无 riskSignals）" 正确判定
   → relatedDocs hint 正确渲染
   exit=0  ✓
```

## Diff

**无差异。** 重构后 koala 的 `story_advance` 在真机上覆盖到的全部路径
（guard-failure 路径 / success 路径 / worktree-create effect / baseline-risk advisory /
nextSteps 渲染 / fast-channel 判定 / relatedDocs hint）均产出与重构前一致的、
格式正确的用户可见输出与退出码。transition-orchestrator.ts 的引入对用户不可见——
正是 behavior-preserving 的目标。

## 字节级回归证明（机械、全覆盖）

上面的真机 transcript 是用户视角抽查；**byte-identical 的全覆盖证明**由 CHK-003 的
回归套件给出，已随 `koala validate --story=B-6974` 跑绿：

- `worktree-authority-smoke.ts` — DONE 成功路径（checklist 段 + advance line +
  merge-report + step ordering merge→worktree remove→branch delete）byte-identical；
  DONE 三道 pre-merge gate 失败路径 story 仍 TEST；post-merge 失败路径 story 已 DONE +
  抛错。
- `flow-stability-smoke.ts` — 各 transition（INIT_CHECK/PLAN/DEV/REVIEW/TEST/DONE +
  REPLAN 回退）外部 CLI 输出 byte-identical；4 段 inline advisory
  （deps/session/baseline-risk/init-check）文本顺序与内容不变；静态 import graph
  无循环依赖。
- `validation-protocol-smoke.ts` / `process-fact-contract` / `runtime-fact-contract`
  / `lifecycle-registry-contract` — 全绿。

## 结论

工程验证（`koala validate` 全绿、34/34 verificationIntent covered、4 轮 REVIEW
0 blocking finding）与用户视角真机抽查一致：B-6974 重构对用户零可观察变化，
达成 behavior-preserving 目标。
