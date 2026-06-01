# 测试完整性决策

## 决策 1：flow 函数必须有 @test

标注了 @flow 的函数是业务关键路径，必须有 @test 注释指向 fixture。
task_scan 校验时，flow 函数缺 @test 应报 error 而非静默忽略。

**理由**：flow 函数出问题影响整条链路，优先级高于普通函数。gap_analyze 之前将所有 no_test 统一报 medium，关键路径被淹没。

## 决策 2：flow 链路必须有端到端验证

每条 @flow 链路需要端到端测试——用临时数据跑完全流程，验证数据从头传到尾。
test_auto 改动 flow 中任一函数时，自动触发该 flow 的端到端回归。

**理由**：单函数测试通过不代表链路通。函数间的数据传递、状态依赖只有端到端才能覆盖。

## 决策 3：task_scan 应做全量代码健康检查

task_scan 当前只校验注释格式，应增加：
- @test 缺失检查（所有有 functionName 的注释）
- flow 函数无测试报 error（高于普通函数）

**理由**：AI 开发过程中随时调 task_scan 就应该知道"代码层面还差什么"，而不是等到 gap_analyze 才发现。

## 决策 4：gap_analyze 分层展示

gap_analyze 的 no_test 应区分：
- flow 函数缺测试 → severity: high
- 普通函数缺测试 → severity: medium

**理由**：扁平列表 39 条 medium 没有可操作性，分层后 AI 知道先补哪些。

## Policy: test-evidence.json is gate-consumed validation metadata

test-evidence.json is gate-consumed validation metadata, not material drift input. PASS/FAIL/coverage results still feed gates (TEST→DONE freshness check), and real source or evidence drift remains stale. Changes to test-evidence.json alone do not invalidate prior material-hash evidence.
