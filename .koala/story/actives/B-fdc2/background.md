## 触发事件
B-META-framework-audit:F-007（severity low, evidenceState verified, status open）——cross-story 框架自省 audit 记录的一条 advisory finding。session ownership rollout（B-8596 / B-f60c / B-c55d）2026-05-19 收口后，audit backlog 还剩若干 advisory，F-007 是其中最小、风险最低、已 verified 的一条。

## 关键洞察
flow-stability-smoke.ts 的 import-isolation grep（文件内标号 section (7)，约 line 444-477，B-4b22 preMortem #3 anchor）硬编码扫描列表 ['handlers/story-advance.ts', 'core/validation-executor.ts']：对每个文件 grep DIRTY_WORKTREE_CATEGORIES 字面量，断言它们只能从 dirty-gate-policy.js import、不能内联。但 story-advance.ts 在 transition orchestrator 重构后已是 thin handler，不再 import 或消费 dirty-gate category 字面量——guard 对它是空扫。真实的 evaluateDirtyGate 消费方是 core/done-oracle.ts 与 core/validation-executor.ts。结果：core/done-oracle.ts 不在 import-isolation 检查覆盖内，若将来 done-oracle.ts 内联 DIRTY_WORKTREE_CATEGORIES 字面量造成漂移，preMortem #3 anchor 不会拦住。

## 方案取舍
当前无实际字面量漂移（done-oracle.ts 正确地从 dirty-worktree.js / dirty-gate-policy.js import），测试仍 green——这是 verified-low、非紧急的测试指向订正，不是 bug 修复。修法唯一且明确：把扫描列表里失效的 'handlers/story-advance.ts' 换成真实消费方 'core/done-oracle.ts'。不扩大范围、不重构 guard 结构。

## 对话纹理
用户在 B-c55d（story owner lease）验收通过后明确：F-007 适合单独开一个小 story 做掉，不要并进 reviewer identity 大 story，也不要并进 owner lease。reviewer identity / attestation 是更大的设计，等 F-007 之后单独规划。
