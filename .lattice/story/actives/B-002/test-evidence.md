# 测试证据 — B-002

## 环境
- Node: v22.x
- OS: macOS Darwin 25.2.0
- 时间: 2026-04-01

## 测试 1: TypeScript 编译通过
**目的:** 验证 xstate 集成后编译无错误
**命令:** `cd packages/main && npm run build`
**预期:** 编译成功
**实际输出:** `> tsc` (无错误)
**结果:** PASS

## 测试 2: 注释校验通过
**目的:** 验证新增 machine.ts 的 @task 注释合规
**命令:** `npm run lint:tasks`
**预期:** 8 个 task，0 error
**实际输出:** `PASSED: All task annotations are valid.`
**结果:** PASS

## 测试 3: INIT→DEVELOP 正常跳转
**目的:** 验证状态机允许 INIT→DEVELOP
**命令:** `story_update(storyId: "TEST-SM", phase: "DEVELOP")`
**预期:** 成功跳转
**实际输出:** `Story TEST-SM updated to DEVELOP`
**结果:** PASS

## 测试 4: DEVELOP→TEST 被 guard 拦截（checklist 未完成）
**目的:** 验证 checklistAllDone guard 生效
**命令:** `story_update(storyId: "TEST-SM", phase: "TEST")`
**预期:** 拒绝跳转，提示 checklist 未完成
**实际输出:** `Cannot enter TEST: 1 checklist item(s) not done: CHK-001`
**结果:** PASS

## 测试 5: DEVELOP→DONE 非法跳转被拦截
**目的:** 验证状态机不允许跳过 TEST 直接到 DONE
**命令:** `story_update(storyId: "TEST-SM", phase: "DONE")`
**预期:** 拒绝跳转
**实际输出:** `Cannot enter DONE: no test evidence found`
**结果:** PASS
