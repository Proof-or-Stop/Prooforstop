# 结构化注释系统

## @task 注释

代码中的 `@task` 注释是项目的核心元数据，每次写代码必须添加。

### 必填字段

| 字段 | 说明 |
|---|---|
| `@task` | Story ID（如 B-001），无对应 Story 用 ADHOC-xxx |
| `@checklist` | Checklist 项 ID（如 CHK-001） |
| `@title` | 任务标题 |
| `@type` | feature / bugfix / refactor / chore |
| `@priority` | critical / high / medium / low |
| `@description` | 多行描述 |
| `@changes` | 变更列表，格式 `- [CHK-xxx] 描述` |

### 粒度规则

- 新增文件：文件顶部（import 之前）
- 同一文件有多个功能：每个函数/方法上加独立的 @task 注释块
- 跨多文件改动：主入口文件顶部，@affected 列出所有文件

### 设计决策

- **函数级精度**（B-005）：提取脚本解析注释紧邻的函数声明，返回 functionName 和 functionSignature，实现 bug→checklist→代码函数 的精确定位链路
- **@changes 标注 Checklist ID**：每条变更关联到具体 checklist 项，支持覆盖率分析

## @flow 业务流转注释

描述函数间的业务流转链路。

| 字段 | 说明 |
|---|---|
| `@flow` | 流转链路名称 |
| `@step` | 步骤序号（从 1 开始） |
| `@input` | 输入数据格式 |
| `@output` | 输出数据格式 |
| `@next` | 下一步函数名（最后一步不填） |

校验规则：@next 目标函数必须存在、step 连续、最后一步无 @next。

## @test 自动化测试注释

指向外置 fixture 文件。

- fixture 路径相对于 `tests/fixtures/`，不含 `.json` 后缀
- fixture 格式：`{ "cases": [{ "name": "...", "input": {...}, "expect": {...} }] }`

## MCP 工具

| 工具 | 用途 |
|---|---|
| `task_scan` | 扫描 @task 注释 + 校验合规性 |
| `task_coverage` | @checklist 注释 vs checklist.json 覆盖率 |
| `task_locate` | 按 ID/关键词定位代码位置 |
| `flow_trace` | 按 flow name 输出完整链路 |
| `flow_list` | 列出所有 flow 概要 |
