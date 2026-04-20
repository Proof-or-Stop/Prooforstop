# 测试证据 — B-004

## 环境
- Node: v22.x
- OS: macOS Darwin 25.2.0
- 时间: 2026-04-01

## 测试 1: TypeScript 编译通过
**命令:** `cd packages/main && npm run build`
**预期:** 编译成功
**实际:** `> tsc` (无错误)
**结果:** PASS

## 测试 2: 注释校验通过
**命令:** `npm run lint:tasks`
**预期:** 17 个 task，0 error
**实际:** PASSED: All task annotations are valid.
**结果:** PASS

## 测试 3: feature_register
**命令:** `feature_register(id: "B-001", title: "生成 main 项目", description: "...")`
**预期:** 注册成功
**实际:** `Feature B-001 registered`
**结果:** PASS

## 测试 4: feature_get
**命令:** `feature_get(id: "B-001")`
**预期:** 返回 feature 详情
**实际:** 返回完整 FeatureInfo JSON
**结果:** PASS

## 测试 5: feature_list
**命令:** `feature_list()`
**预期:** 返回包含 B-001 的列表
**实际:** 返回 1 个 feature 的数组
**结果:** PASS

## 测试 6: feature_map
**命令:** `feature_map(id: "B-001")`
**预期:** 返回 B-001 的代码地图，包含文件和 checklist
**实际:** 返回 7 个文件 + 9 个 checklist 项，完整映射
**结果:** PASS

## 测试 7: Skills 文件创建
**命令:** `ls .claude/skills/*/SKILL.md`
**预期:** 4 个 skill 文件：story, dev, test, done
**实际:** 4 个文件全部存在
**结果:** PASS
