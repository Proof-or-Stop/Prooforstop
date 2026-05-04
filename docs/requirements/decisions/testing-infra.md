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
3. 通过语言无关 executor registry 执行每个 case：优先 `executor` / `command`，兼容 legacy JS `execute`
4. 验证结果（`expect` 精确/pattern 匹配，或 `throws` 错误匹配）
5. 采集 V8 profiler trace，检测调用链变化
6. 自动 bug 管理：fail 创建 bug，pass 自动 fix bug

`koala validate` 是项目级验证入口，不能假设所有项目都有 TypeScript
`validate.ts`。执行优先级：

1. 项目根目录存在 `validate.ts` / `validate.js` / `validate.mts` 时，按原 D/M/F verifier 路径执行。
2. 否则读取 `koala.config.json` 的 `validate.command` 或 `validate.commands`。
3. 否则按项目类型自动发现标准命令：`npm test`、`python -m pytest`、`go test ./...`、`cargo test`、`swift test`、`mvn test`、`gradle test`。
4. 仍找不到验证入口时返回 `warn/skip`，不把 Python/Go/C++ 等非 TS 项目误判为失败；需要强门禁的项目必须显式配置验证命令。

`koala validate` 的成功提示必须使用当前 story phase 和 gate oracle，而不是硬编码 DONE：
DEV 阶段通过后提示提交并进入 REVIEW；REVIEW 阶段通过后提示进入 TEST；
TEST 阶段通过后提示查看 DONE pre-check，并按失败 row 的 hint 补 summary、delivery check、dirty tree 等门禁项。

配置示例：

```json
{
  "validate": {
    "commands": [
      { "label": "python tests", "command": "python", "args": ["-m", "pytest"] },
      "ruff check ."
    ]
  }
}
```

### 阶段行为差异

- **DEV 阶段**：`test_auto` 不还原代码 + 提示"注意：可能修改实际文件"
- **TEST 阶段**：`test_auto` 正常还原（`git restore . && git clean -fd`）

## 测试流程

- `story_advance(TEST)` 返回提示立即执行 `test_auto`
- `test_auto` 自动执行白盒 fixture + 浏览器测试
- 结果自动写入测试证据
- `test_story` 写入测试证据时记录当前 git HEAD；`story_advance(DONE)` 只接受 PASS 且 HEAD 匹配当前 story 分支的证据
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

## 跨语言执行协议

Fixture 是语言无关测试协议，不是 JS 脚本容器。`execute` 只代表 legacy `js.execute` executor；Python、Go、C++、Java、Swift、Objective-C 等项目应优先通过 `command` / 语言 executor / 原生测试命令产生证据。

第一批内置 executor：

| executor | 用途 |
|---|---|
| `js.execute` | 兼容旧 JS fixture，执行 `execute` 函数体 |
| `command` | 通用黑盒命令，适合 `go test`、`pytest`、`ctest`、`mvn test`、`swift test`、`xcodebuild test` 等 |
| `python.function` | Python 函数级样板 executor，通过 JSON 进程边界调用单个函数 |
| `go.test` | Go 标准入口，默认 `go test ./...` |
| `java.junit` | Java/JUnit 标准入口，默认 `mvn test`，可选 `buildTool:"gradle"` |
| `cpp.binary` | C/C++ 测试二进制入口 |
| `swift.test` | Swift Package 标准入口，默认 `swift test` |
| `objc.xcodebuild` | Objective-C / Apple 平台标准入口，默认 `xcodebuild test` |
| `rust.cargo` | Rust 标准入口，默认 `cargo test` |

Reviewer 不能把“JS runner 无法 import Python/Go/C++/Java/Swift/OC”判定为测试通过；这只能说明缺少对应 executor 证据。
