# Story 生命周期

## 五阶段状态机

```
IDEA → PLAN → DEV → TEST → DONE
                ↑      |
                └──────┘ (回退)
```

| Phase | 含义 | 进入门禁 |
|---|---|---|
| IDEA | 待办，只有标题和描述 | 无 |
| PLAN | 已拆解 checklist | 提供 checklist |
| DEV | 开发中 | 无 |
| TEST | 测试中 | checklist 全部 done + 覆盖率检查 |
| DONE | 完成 | 测试全部 PASS + bug 全部 fixed |

## 设计决策

- **Story 即 Feature**：删除了独立的 Feature/Backlog 概念，Story 本身就是最小可追踪单元
- **状态机管理**：使用 xstate 而非手动 if 判断，门禁（guard）内置到状态机定义中
- **TEST→DEV 可回退**：测试发现问题后可回退到开发阶段修复
- **门禁不可跳过**：DEV→TEST 必须 checklist 全 done，TEST→DONE 必须测试通过且 bug 全 fixed

## MCP 工具

| 工具 | 用途 |
|---|---|
| `story_create` | 创建 Story（有 checklist=PLAN，无=IDEA） |
| `story_advance` | 推进阶段（校验门禁） |
| `story_update` | 编辑基本信息 |
| `story_get` | 读取详情 |
| `story_list` | 全局总览 |
| `checklist_get` | 读取 checklist |
| `checklist_update` | 更新 checklist 项状态 |
