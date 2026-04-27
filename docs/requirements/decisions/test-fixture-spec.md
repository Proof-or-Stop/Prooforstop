# @test 注释与 Fixture 规范

## @test 注释放置规则

**必须写在函数/方法级别的 `@task` 块里，不能写在文件顶部。**

```js
// ✅ 正确：每个函数各自标注
/**
 * @task S-001
 * @checklist CHK-001
 * @title 发送消息
 * @type feature
 * @priority high
 * @description 发送消息到房间
 * @changes
 *   - [CHK-001] 新增 sendRoomMessage
 * @test application/agent-service-facade
 */
sendRoomMessage(conversationKey, content) { ... }

/**
 * @task S-001
 * @checklist CHK-002
 * @title 回复消息
 * @type feature
 * @priority high
 * @description 回复指定消息
 * @changes
 *   - [CHK-002] 新增 replyRoomMessage
 * @test application/agent-service-facade
 */
replyRoomMessage(conversationKey, targetEventId, content) { ... }
```

```js
// ❌ 错误：文件顶部写 @test，所有函数继承同一个 fixture
/**
 * @task S-001
 * @checklist CHK-001
 * @title AgentServiceFacade
 * @test application/agent-service-facade   ← 这里不该有 @test
 */
```

**原因**：文件级 `@task` 没有 `functionName`，但如果写在方法上的 `@task` 都指向同一个 fixture，test_auto 会对每个函数跑 fixture 的全部 case。需要用 `fn` 字段区分（见下文）。

## Fixture 路径映射

`@test application/agent-service-facade` → `{fixturesDir}/application/agent-service-facade.json`

- 路径相对于 `koala.config.json` 的 `fixturesDir`
- 不含 `.json` 后缀
- 多个函数可指向同一个 fixture 文件（用 `fn` 字段区分 case 归属）

## Fixture JSON 格式

### 基本结构

```json
{
  "cases": [
    {
      "name": "case 描述",
      "input": { ... },
      "expect": { ... }
    }
  ]
}
```

### Case 字段

| 字段 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `name` | 是 | string | case 描述 |
| `executor` | 否 | string | 执行器 ID；缺省时有 `execute` 走 `js.execute`，有 `command` 走 `command` |
| `input` | 否 | any | 传给函数的参数（函数 executor 中 array 展开为多参，object 传单参） |
| `fn` | 否 | string | 指定调用哪个函数（多函数共享 fixture 时必填） |
| `command` | 否 | string / array | `command` executor 的命令；数组形式为 `[cmd, ...args]` |
| `args` | 否 | string[] | 追加给 `command` 的参数 |
| `execute` | 否 | string | legacy JS executor 函数体 |
| `expect` | 否 | any | 期望返回值（部分匹配） |
| `throws` | 否 | string | 期望抛出的错误消息片段（与 expect 互斥） |
| `intentRef` | 否 | string | 关联 testIntent（如 CHK-001:happy:0） |

### Executor 协议

Fixture 是语言无关测试协议，不是 JS 脚本容器。`execute` 只代表 legacy `js.execute` executor；跨语言代码必须使用 `command`、语言 executor 或原生测试命令作为证据。

内置 executor：

| executor | 说明 |
|---|---|
| `js.execute` | 兼容旧格式，执行 JS `execute` 函数体并注入 `$handlers` / `$root` / `$ctx` |
| `command` | 通用进程边界 executor，适合 `pytest`、`go test`、`ctest`、`mvn test`、`swift test`、`xcodebuild test` |
| `python.function` | Python 函数级 executor，通过 JSON 调用 `file` 中的 `fn` |
| `go.test` | Go 标准测试入口，默认运行 `go test ./...` |
| `java.junit` | Java/JUnit 标准测试入口，默认运行 `mvn test`，`buildTool:"gradle"` 时运行 Gradle test |
| `cpp.binary` | C/C++ 已编译测试二进制入口，运行 `binary` 或 `command` |
| `swift.test` | Swift Package 测试入口，默认运行 `swift test` |
| `objc.xcodebuild` | Objective-C / Apple 平台测试入口，默认运行 `xcodebuild test` |
| `rust.cargo` | Rust Cargo 测试入口，默认运行 `cargo test` |

语言策略：

- 新语言优先走 `command`，保证任何 CLI/测试框架都能接入。
- 常见语言用专用 executor 固化默认命令，减少每个 fixture 重复写命令细节。
- 专用 executor 不改变断言模型；`expect`、`throws`、`timeoutMs`、`cwd`、`env` 仍由统一 runner 处理。

#### command 示例

```json
{
  "name": "go package tests pass",
  "run_type": "cli",
  "executor": "command",
  "command": ["go", "test", "./..."],
  "expect": { "pattern": "PASS|ok" },
  "intentRef": "CHK-001:happy:0"
}
```

#### python.function 示例

```json
{
  "name": "calculator add",
  "run_type": "cli",
  "executor": "python.function",
  "file": "src/calculator.py",
  "fn": "add",
  "input": [1, 2],
  "expect": 3,
  "intentRef": "CHK-001:happy:0"
}
```

#### 常见语言 executor 示例

```json
{
  "name": "go package tests pass",
  "run_type": "cli",
  "executor": "go.test",
  "packages": ["./..."],
  "expect": { "pattern": "PASS|ok" }
}
```

```json
{
  "name": "java junit tests pass",
  "run_type": "cli",
  "executor": "java.junit",
  "buildTool": "gradle",
  "args": ["test"],
  "expect": { "pattern": "BUILD SUCCESSFUL|BUILD SUCCESS" }
}
```

```json
{
  "name": "cpp test binary passes",
  "run_type": "cli",
  "executor": "cpp.binary",
  "binary": "./build/calculator_tests",
  "expect": { "pattern": "PASS|OK" }
}
```

```json
{
  "name": "swift package tests pass",
  "run_type": "cli",
  "executor": "swift.test",
  "expect": { "pattern": "Test Suite.*passed|Build complete" }
}
```

```json
{
  "name": "objc xcode tests pass",
  "run_type": "cli",
  "executor": "objc.xcodebuild",
  "workspace": "App.xcworkspace",
  "scheme": "AppTests",
  "destination": "platform=iOS Simulator,name=iPhone 15",
  "expect": { "pattern": "TEST SUCCEEDED" }
}
```

## 阶段语义

- `DEV` 阶段可以提前用 `fixture_batch_add` 补 fixture，主要用于兼容验证或边写边跑；这不是完成测试阶段的必要条件。
- `TEST_CASE` 阶段是正式补齐 fixture 覆盖的阶段。写完 case 后应立即运行 `test_story --storyId=...` 验证当前 story 关联 case。
- `checklist_update --status=done` 不再要求 fixture intentRef 已覆盖；fixture 覆盖由 `testintent_check` / TEST_CASE_REVIEW gate 负责。
- 如果 `testintent_check` 报 fixture coverage missing，请给对应 case 添加 `intentRef`，格式如 `CHK-001:happy:0`。在 story worktree 中 `fixture_batch_add` 会自动补成带 storyId 的 scoped ref。

### expect 匹配规则

1. **部分匹配**：expect 中的每个字段都必须在 actual 中存在且相等，actual 可以有额外字段
2. **pattern 正则**：如果 expect 含 `pattern` 字段，用正则匹配 actual（string 直接匹配，object 先 JSON.stringify）
3. **throws 错误匹配**：throws 字段是字符串，actual error message 包含该字符串即通过

### 示例

#### 1. 函数返回字符串，用 pattern 匹配

```json
{
  "name": "create story with checklist",
  "input": { "name": "test", "title": "Test", "type": "feature", "priority": "high" },
  "expect": { "pattern": "Story [A-Z]+-[a-f0-9]+ created" }
}
```

#### 2. 函数返回对象，部分匹配

```json
{
  "name": "list room context returns empty",
  "fn": "listRoomContext",
  "input": { "conversationKey": "bot1:room1" },
  "expect": { "recentTurns": [], "summary": "" }
}
```

#### 3. 期望抛错

```json
{
  "name": "throws when adapter absent",
  "fn": "sendRoomMessage",
  "input": { "conversationKey": "bot1:room1", "content": "Hello" },
  "throws": "roomAdapter is not configured"
}
```

#### 4. 前置 case + $prev 引用（取代旧 setup 字段）

需要前置数据的 fixture 通过前置 case 创建数据，后续 case 用 `$prev.xxx` 引用前一个 case 的输出：

```json
{
  "cases": [
    {
      "name": "prereq: create story",
      "fn": "story_create",
      "input": { "name": "t", "title": "T", "description": "t", "type": "feature", "priority": "high" },
      "expect": { "pattern": "created" }
    },
    {
      "name": "advance to PLAN",
      "fn": "story_advance",
      "input": { "storyId": "$prev.storyId", "phase": "PLAN" },
      "expect": { "pattern": "advanced to PLAN" }
    }
  ]
}
```

context 传递机制：
- executor 维护共享 `context` 对象，每个 case 执行后自动提取返回值字段
- 字符串返回值：自动匹配 `Story B-xxxx`→`storyId`、`Bug BUG-xxx`→`bugId` 等模式
- 对象返回值：直接 `Object.assign` 到 context
- 后续 case 的 input 中 `$prev.xxx` 被替换为 context 中对应字段

#### 5. 多函数共享一个 fixture 文件

当一个模块/类的多个方法共用一个 fixture 时，**每个 case 必须用 `fn` 字段标注归属**：

```json
{
  "cases": [
    {
      "name": "listRoomContext — returns empty",
      "fn": "listRoomContext",
      "input": { "conversationKey": "bot1:room1" },
      "expect": { "recentTurns": [], "summary": "" }
    },
    {
      "name": "sendRoomMessage — throws when absent",
      "fn": "sendRoomMessage",
      "input": { "conversationKey": "bot1:room1", "content": "Hello" },
      "throws": "roomAdapter is not configured"
    },
    {
      "name": "approveAgentAction — invalid decision",
      "fn": "approveAgentAction",
      "input": { "requestId": "req-001", "decision": "maybe" },
      "throws": "decision must be"
    }
  ]
}
```

**没有 `fn` 字段的 case 会被每个指向该 fixture 的函数都跑一遍**——这是笛卡尔积问题的根源。

## 常见错误格式

### ❌ 不要用 `expect.throws: true`

```json
// ❌ 错误
{ "expect": { "throws": true, "errorMessageContains": "not configured" } }

// ✅ 正确
{ "throws": "not configured" }
```

### ❌ 不要用 `expect.error`

```json
// ❌ 错误
{ "expect": { "error": "Bug BUG-001 already exists" } }

// ✅ 正确
{ "throws": "Bug BUG-001 already exists" }
```

### ❌ 不要在 input 里放 dispatch 路由字段

```json
// ❌ 错误：scenario/method 是 dispatch 框架字段，koala 不识别
{ "input": { "scenario": "send_no_adapter", "method": "sendRoomMessage", "content": "Hello" } }

// ✅ 正确：用顶层 fn + 干净的 input
{ "fn": "sendRoomMessage", "input": { "conversationKey": "bot1:room1", "content": "Hello" } }
```

## 批量转换旧格式

对于已有的 dispatch 风格 fixture，用转换脚本批量处理：

```bash
# 转换整个 fixtures 目录
node /path/to/koala/scripts/convert-fixtures.cjs tests/fixtures

# 转换单个文件
node /path/to/koala/scripts/convert-fixtures.cjs tests/fixtures/application/agent-service-facade.json
```

转换规则：
- `input.method` → 顶层 `fn`
- `input.scenario` → 移除
- `expect.throws: true` + `errorMessageContains` → 顶层 `throws`
- `expect.throws: false` + 自定义断言 → 标 `_warning`，需手动检查
- 原文件备份为 `.bak`

### 转换后需要手动检查

1. **`_warning` 标记的 case** — 含自定义断言（`resultLength`、`memoryNull` 等），需要 wrapper 配合验证
2. **constructor case** — `fn` 不会设为 `constructor`，需要在 wrapper 里特殊处理
3. **`input.deps` / `input.stubTasks`** — 测试桩数据，wrapper 需要知道如何使用

## case 执行路由机制

`test_auto` / `test_story` / `test_fixture` 共用 executor registry：

```
对 fixture 的每个 case:
  1. 若 case.executor 存在，选择对应 executor
  2. 否则若 case.execute 存在，兼容为 js.execute
  3. 否则若 case.command 存在，兼容为 command
  4. executor 返回 actual 或抛错
  5. runner 统一用 expect / throws 判定，并写入 evidence / bug / gate
```

handler 优先只属于 `js.execute` 兼容路径；跨语言项目不要依赖 JS import，应使用 `command` 或语言 executor。

## test-runtime 机制

`test_auto` 执行时创建临时 store 隔离测试数据，加载 handlers：

1. **koala 自身**：直接使用 `createToolHandlers(testStore, root)`
2. **外部项目**：通过 `koala.config.json` 的 `testRuntime` 配置指向 `tests/test-runtime.js`，该文件 export `createTestHandlers(store, projectRoot)` 返回 handler 映射

## 浏览器真机测试（browser case）

### 配置

`koala.config.json` 加 `browser` 配置（`koala init` 会自动检测浏览器项目）：

```json
{
  "browser": {
    "devCommand": "npx vite"
  }
}
```

支持任何 HTTP dev server：vite / webpack / next / serve 等。

### browser case 格式

fixture 里 `browser: true` 的 case 由 `browser_test` MCP 工具执行：

```json
{
  "name": "点击后状态变化",
  "browser": true,
  "steps": [
    { "action": "eval", "code": "document.getElementById('btn').click()" },
    { "action": "assert", "selector": "#status", "contains": "完成" },
    { "action": "screenshot", "saveTo": "result.png" }
  ]
}
```

### steps action 类型

| action | 参数 | 说明 |
|--------|------|------|
| `eval` | `code` | 在浏览器执行 JS，返回结果 |
| `click` | `selector` 或 `x`/`y` | 模拟点击 |
| `type` | `selector`, `text` | 模拟键盘输入 |
| `assert` | `selector`, `contains` | 断言 DOM 文本内容（自动轮询，默认 3s 超时） |
| `screenshot` | `saveTo` | 截图保存到 tests/screenshots/ |
| `wait` | `ms` | 等待（尽量用 assert 代替） |
| `call` | `code`(fn name), `text`(args JSON) | 调用 __koala_modules 注册的函数 |
| `trace` | 无 | 获取 window.__trace 调用链 |

### 运行方式

```
# MCP 工具调用
browser_test({ projectRoot: "packages/game" })

# 指定 fixture
browser_test({ projectRoot: "packages/game", fixture: "game-browser" })
```

### 工作原理

1. 启动 bridge server（WS :9876 + HTTP :9877）
2. 启动项目 dev server（如 vite :5173）
3. 启动代理（:5174）→ 拦截 HTML 自动注入 WS client 脚本
4. 打开浏览器访问代理地址
5. WS client 连接 bridge → 通过 HTTP API 执行 steps
6. 项目不需要改任何代码

### 示例：五子棋游戏测试

```json
{
  "cases": [
    {
      "name": "初始状态显示黑棋落子",
      "browser": true,
      "steps": [
        { "action": "assert", "selector": "#status", "contains": "黑棋" },
        { "action": "screenshot", "saveTo": "initial-state.png" }
      ]
    },
    {
      "name": "落子后切换到白棋",
      "browser": true,
      "steps": [
        { "action": "eval", "code": "(() => { const c = document.getElementById('board'); const r = c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left+30+7*40, clientY: r.top+30+7*40 })); })()" },
        { "action": "assert", "selector": "#status", "contains": "白棋" },
        { "action": "screenshot", "saveTo": "after-move.png" }
      ]
    }
  ]
}
```
