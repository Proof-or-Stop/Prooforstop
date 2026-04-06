# 测试基础设施

## 测试策略

### 白盒测试（@test fixture 驱动）

1. 通过 `git diff` 找到改动的函数
2. 匹配函数上的 `@test` 注释找到对应 fixture
3. 自动执行单函数测试

### 浏览器真机测试

1. 启动项目 dev server + bridge proxy
2. 在真实浏览器中执行 fixture 中的 browser case
3. 含 V8 profiler trace 采集

## 测试执行

`test_auto` 是统一测试入口：

1. 扫描 `fixturesDir` 下所有 `.json` fixture 文件
2. 校验 `fn` + `file` 字段是否指向真实源码
3. 执行每个 case 的 `execute` 代码（注入 `$handlers`、`$root`、`$ctx`）
4. 验证结果（`expect` 精确/pattern 匹配，或 `throws` 错误匹配）
5. 采集 V8 profiler trace，检测调用链变化
6. 自动 bug 管理：fail 创建 bug，pass 自动 fix bug

### 阶段行为差异

- **DEV 阶段**：`test_auto` 不还原代码 + 提示"注意：可能修改实际文件"
- **TEST 阶段**：`test_auto` 正常还原（`git restore . && git clean -fd`）

## 测试流程

- `story_advance(TEST)` 返回提示立即执行 `test_auto`
- `test_auto` 自动执行白盒 fixture + 浏览器测试
- 结果自动写入测试证据
- `story_advance(DONE)` 门禁只认 test_auto 的记录
- TEST fail 时 `bug_report` 自动回退 DEV

## CLI 工具

| 工具 | 用途 |
|---|---|
| `test_auto` | 自动执行白盒 fixture + 浏览器测试 |
| `browser_test` | 单独跑浏览器测试 |
| `test_add` | 记录测试证据 |
| `test_list` | 查看测试证据 |
| `bug_report` | 报告 bug（自动标关联 item in_progress + 回退 DEV） |
| `bug_update` | 更新 bug 状态 |
| `bug_list` | 查看 bug 列表 |
| `diagnose` | 自动诊断（DEV 纯建议，TEST 关联 bug_report） |
