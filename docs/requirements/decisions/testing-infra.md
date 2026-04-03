# 测试基础设施

## 双轨测试策略

### 白盒测试（@test fixture 驱动）

1. 通过 `git diff` 找到改动的函数
2. 匹配函数上的 `@test` 注释找到对应 fixture
3. 自动执行单函数测试

### Flow E2E 测试（@flow 注释驱动）

1. 从 `@flow` 注释自动提取链路顺序和函数名
2. 创建 sandbox 隔离环境
3. 逐步执行，`@output` 自动管道到下一步的 `@input`
4. 新增 flow 无需写测试代码，注释即测试

## 测试流程

- `story_advance(TEST)` 返回提示立即执行 `test_auto`
- `test_auto` 自动执行白盒 fixture + flow e2e
- `test_auto(full=true)` 全量模式跑所有 fixture 和所有 flow
- 结果自动写入测试证据（TE-AUTO-/TE-E2E- 前缀）
- `story_advance(DONE)` 门禁只认 test_auto 的记录
- 手动 `npm run test:e2e` 可独立跑 flow e2e

## MCP 工具

| 工具 | 用途 |
|---|---|
| `test_auto` | 自动执行白盒 fixture + flow e2e |
| `test_add` | 记录测试证据 |
| `test_list` | 查看测试证据 |
| `bug_report` | 报告 bug |
| `bug_update` | 更新 bug 状态 |
| `bug_list` | 查看 bug 列表 |
