## 触发事件
2026-06-04 B-798e 完成后，用户指出 cli-validate 仍有 2 个 warning：story_migrate_storage 和 story_sync_main 缺少 @test annotation。虽然 convergence_check 已经 true，但这两个 warning 仍会让维护者误以为 annotation hygiene 没完全收口。

## 关键洞察
这不是运行时 bug，而是结构化注释系统的卫生问题。两个函数已有 @task、@changes 和历史 story 归属，只缺少 validator 期望的函数级 @test 字段，因此最佳处理是补 metadata，而不是改 validator 或功能逻辑。

## 方案取舍
选择最小改动：只在 packages/main/src/handlers/story-query.ts 的两个任务注释块里补 @test，引用已有/相关 smoke coverage 名称，并通过 cli-validate、build、npm test 和 convergence_check 验证。避免新增测试或扩大命令行为，因为用户要求是清 warning。

## 对话纹理
用户刚看见“还有 2 个 warning”后直接说优化一下，关注的是把收敛报告打磨到更干净，而不是重新设计 annotation 系统。交付说明应直接告诉用户 warning 已清零、项目仍然 converged:true。
