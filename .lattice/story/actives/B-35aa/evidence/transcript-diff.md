# B-35aa — 真机 transcript-diff

**Commit:** decision doc at 72ab6bbbd; story HEAD includes lifecycle metadata commits
**Sole deliverable:** docs/requirements/decisions/test-runner-consolidation-plan.md

## 预期 (PLAN outcome)
新决策文档存在 + 6 H2 节 + 4 个固定数字(151/70,280/258/49) + 3 路径命名 + 选 B + B1-B4 follow-up + testing-infra.md 引用 + 0 代码/其它 decision 修改。

## 实际 (observed)
```
$ ls docs/requirements/decisions/test-runner-consolidation-plan.md  → 文件在
$ wc -l docs/requirements/decisions/test-runner-consolidation-plan.md → 211 lines
$ grep -c '^## ' docs/...                                          → 6 (>= 4 required)
$ grep -c '151' docs/...                                           → 2
$ grep -c '70,280' docs/...                                        → 1
$ grep -c '258' docs/...                                           → 4
$ grep -c '49' docs/...                                            → 1
$ grep -n 'Path A — Vitest|Path B — In-house|Path C' docs/...      → 全部命名,Path B *(chosen)*
$ grep -cE '^### B[1-4] ' docs/...                                 → 4 (B1, B2, B3, B4)
$ grep -c 'testing-infra' docs/...                                 → 6
$ grep -n 'B4 (optional)' docs/...                                 → 命中
$ grep -c 'c8' docs/...                                            → 多次出现
$ git diff main -- docs/requirements/decisions/testing-infra.md | wc -l → 0
$ git diff main -- docs/requirements/decisions/testing-completeness.md | wc -l → 0
$ git diff --name-only main -- packages | wc -l                    → 0
$ git diff --name-only main -- 'package.json' 'packages/*/package.json' | wc -l → 0
$ git diff --name-only main -- scripts | wc -l                     → 0
$ lattice validate                                                 → PASS, 22/22 intent coverage
```

## Diff (预期 vs 实际) — 0 差距
A0 决策文档 (path B = in-house parallel runner + manifest + c8 coverage) 已落地。所有
22 verificationIntent 都有具体的 CLI 命令绑定(B-d7ef 教训),且独立 reviewer 已在 round 2 复审通过。

## 流程
- INIT round 3 通过 (lattice-review-story-init 修了 4 个 medium advisory)
- product-reviewer 补签 (round 1 漏调度)
- scope-plan reviewer PASS,0 gap
- REVIEW round 1: docs PASS, concept PASS, test-coverage 提 F-001/F-002 (evidence-correspondence,我的 helper 又把多 intent 绑同一通用命令,B-d7ef 教训复发)
- 重录 6 个错命令后 test-coverage round 2 PASS,quality PASS
- 4 lane 全过,2 finding 全 resolved
- delivery reviewer 待签

## User-value 自检
- 用户看得到结果? ✓ — 决策文档可读,锁定 path B,B1-B4 跑后续故事有 verbatim 范围草图。
- 真机跑过? ✓ — grep / wc / git diff 都核实。
- 残留? ✓ — testing-infra.md / testing-completeness.md / packages/ / scripts/ / package.json 全部 byte-identical。
