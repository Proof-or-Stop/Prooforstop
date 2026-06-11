# B-8596 — TEST 阶段用户视角真机 transcript

Story: **B-8596 Adopt session-ownership-and-write-leases.md as a process truth source**
类型: docs-only formalization（fast/express channel）。

## Expected（PLAN outcome）

B-8596 是 docs-only story，把多 session 写协调设计文档纳入流程、成为正式真相源——**无运行时行为变更**。完成后用户（后续并行开发的 agent / 维护者）应能观察到：

1. `docs/requirements/decisions/session-ownership-and-write-leases.md` 已被 git 跟踪（不再是未跟踪工作区文件）。
2. 该文档 Status 段为 "Adopted design; implementation pending"——声明它是已采纳设计真相源、运行时实现尚未做。
3. `CLAUDE.md` 与 `AGENTS.md` 各有一段短引用指向该文档，使 agent 与 scope-plan reviewer 能发现并以它为准。
4. 引用路径正确解析到实际文件。

## Actual（真机 transcript）

在 B-8596 worktree（分支 story/B-8596）真机执行验证命令：

```
[1] git ls-files docs/requirements/decisions/session-ownership-and-write-leases.md
    → docs/requirements/decisions/session-ownership-and-write-leases.md      ✓ 已被 git 跟踪

[2] Status 段（doc 第 3-5 行）
    → "## Status"
      "Adopted design; implementation pending. This document is the canonical, adopted design for"
                                                                              ✓ Status 已更新

[3] grep "session-ownership-and-write-leases.md" CLAUDE.md
    → CLAUDE.md:393  设计真相源：`docs/requirements/decisions/session-ownership-and-write-leases.md`
                                                                              ✓ CLAUDE.md 交叉引用就位

[4] grep "session-ownership-and-write-leases.md" AGENTS.md
    → AGENTS.md:126  设计真相源：`docs/requirements/decisions/session-ownership-and-write-leases.md`
                                                                              ✓ AGENTS.md 交叉引用就位

[5] test -f docs/requirements/decisions/session-ownership-and-write-leases.md
    → OK: 文件存在于交叉引用所指路径                                          ✓ 引用路径解析正确

[6] git diff main...HEAD --stat（内容文件）
    → session-ownership-and-write-leases.md | 214 ++（新增，含 F-001 lock-path runtime note）
      CLAUDE.md                            |   4 ++（短引用）
      AGENTS.md                            |   4 ++（短引用）
                                                                              ✓ 仅文档改动，无源码
```

`koala validate --story=B-8596` 全绿（npm test → ALL PASS）。

## Diff

**无差异。** 4 项 expected 全部被真机命令观察证实。B-8596 仅改动文档（新增 decision doc + CLAUDE.md/AGENTS.md 短引用），无任何源码 / 运行时行为改动——正是 docs-only formalization 的目标。

## 范围说明

- 本 story **不实现** session ownership / write lease 的运行时行为；文档 Status 明确标注 "implementation pending"，实现由后续 implementation story 跟进（见 framework-hardening roadmap）。
- REVIEW 阶段 concept reviewer 提的 F-001（文档提议的 main write lock 路径与现有 `.koala/runtime/done-main-merge.lock` 不一致）已修复：Storage 段加 runtime note 说明现状并把 lock 路径收敛决策交给 implementation story，未改文档规则实质。

## 结论

工程验证（`koala validate` 全绿、2 轮 REVIEW 0 blocking finding、F-001 resolved）与用户视角真机检查一致：session-ownership 设计文档已固化为可发现、可引用、git 跟踪的流程真相源，达成 docs-only formalization 目标。
