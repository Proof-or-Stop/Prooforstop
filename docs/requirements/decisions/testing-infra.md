# 测试基础设施

## 测试策略

当前测试契约以 story checklist 为中心：

1. PLAN 阶段为每个 checklist item 记录 happy/edge/adversarial `verificationIntent`。
2. DEV 阶段实现代码，并通过 `checklist_update` 记录 `verificationEvidence`（命令、摘要、intentRef、hash 等）。
3. REVIEW 阶段由 reviewer 和 `koala-review-test-coverage` 检查实现与 evidence 覆盖。
4. TEST 阶段运行 `koala validate`，写 validation evidence、bug、stale/missing evidence 结果。

### 项目原生验证

优先使用项目自己的验证命令（如 `npm test`、`pytest`、`go test`、`cargo test`）产出 evidence。Koala 不要求所有项目都有 TypeScript `validate.ts`，也不要求通过 fixture 才算验证。

### 浏览器真机测试

浏览器黑盒验证仍可作为 `verificationEvidence`：

1. 启动项目 dev server + bridge proxy
2. 在真实浏览器中执行用户可见流程
3. 将 transcript、截图/trace、命令和结果通过 `checklist_update` 关联到对应 `verificationIntent`

### Legacy fixture 兼容

`test_auto` / `test_story` / `test_fixture` / `fixture_batch_add` / `fixture_update` / `test_add` / `task_coverage` 是旧 fixture/test 家族，保留给旧 story、迁移、诊断和维护。它们不是当前 story 的默认流程；新流程应优先使用 `verificationIntent`、`verificationEvidence` 和 `koala validate`。

## 测试执行

`koala validate` 是项目级验证入口，不能假设所有项目都有 TypeScript
`validate.ts`。执行优先级：

1. 项目根目录存在 `validate.ts` / `validate.js` / `validate.mts` 时，按原 D/M/F verifier 路径执行。
2. 否则读取 `koala.config.json` 的 `validate.command` 或 `validate.commands`。
3. 否则按项目类型自动发现标准命令：`npm test`、`python -m pytest`、`go test ./...`、`cargo test`、`swift test`、`mvn test`、`gradle test`。
4. 仍找不到验证入口时返回 `warn/skip`，不把 Python/Go/C++ 等非 TS 项目误判为失败；需要强门禁的项目必须显式配置验证命令。

`koala validate` 的成功提示必须使用当前 story phase 和 gate oracle，而不是硬编码 DONE：
DEV 阶段通过后提示提交并进入 REVIEW；REVIEW 阶段通过后提示进入 TEST；
TEST 阶段通过后提示查看 DONE pre-check，并按失败 row 的 hint 补 summary、delivery check、dirty tree、missing/stale `verificationEvidence` 等门禁项。

Legacy `test_auto` 是兼容 runner，不是统一入口。维护旧 fixture 时它的行为是：

1. 扫描 `fixturesDir` 下所有 `.json` fixture 文件
2. 校验 `fn` + `file` 字段是否指向真实源码
3. 通过语言无关 executor registry 执行每个 case：优先 `executor` / `command`，兼容 legacy JS `execute`
4. 验证结果（`expect` 精确/pattern 匹配，或 `throws` 错误匹配）
5. 采集 V8 profiler trace，检测调用链变化
6. 自动 bug 管理：fail 创建 bug，pass 自动 fix bug

Outcome semantics 的 focused smoke 覆盖 dashboard/session wording、`summary_set.outcomeKind` schema、verification evidence verdict 渲染，以及 worktree authority wording：

```bash
npm --prefix packages/main run build
npm --prefix packages/main run test:outcome-semantics-smoke
```

它必须在回归成单一含糊 DONE 百分比，或恢复旧的 alarming main metadata wording 时失败。

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

`validate.command` / `validate.commands` 的 JSON receipt 是审计证据：每条命令应记录
`command`、`args`、`code`、`durationMs`、`output`，以及需要 shell 语义时的
`shell=true`。字符串命令里包含 `cd`/`&&`/管道/重定向等 shell 语义时，Koala 会把它
作为一个有意的 shell receipt 执行；结构化命令对象默认不走 shell，除非显式写
`"shell": true`。必需命令失败时 `koala validate` hard fail；`optional:true`
命令失败时只返回 warn。

`koala doctor` 的 Validation scan 是项目级 advisory，不替代 `koala validate`：
它说明 `validate.ts/js/mts` 是否存在、`koala.config.json` 是否配置了验证命令、
自动发现的 fallback 命令标签、是否处于 no-validator warning，以及 shell 风格配置
是否会留下 `shell=true` receipt。这里不能写项目专属测试数量或 PVSC 之类的假设；
需要强门禁时应配置显式 validate command。

### 阶段行为差异

- **DEV 阶段**：用项目原生命令验证，并通过 `checklist_update` 写 `verificationEvidence`；legacy `test_auto` 只在维护旧 fixture 时可用，且必须明确提示可能修改实际文件
- **REVIEW 阶段**：reviewer 和 coverage gate 消费 `verificationIntent` / `verificationEvidence`
- **TEST 阶段**：`koala validate` 写 validation evidence；legacy `test_auto` 若被维护场景显式调用，仍会执行 `git restore . && git clean -fd`

## 测试流程

- PLAN：用 `verificationIntent` 描述每个 checklist item 的 happy/edge/adversarial 验收。
- DEV：实现后跑项目原生命令或浏览器流程，并用 `checklist_update` 写入 `verificationEvidence`。
- REVIEW：`koala-review-test-coverage` 检查 `verificationIntent` 是否都有可追溯 evidence。
- TEST：`koala validate` 执行项目级验证，记录 validation evidence；缺失或 stale evidence 时返回 `allPass:false`。
- DONE：只接受 PASS、bug fixed、evidence fresh、summary/delivery gate 全部满足的结果。

## CLI 工具

| 工具 | 用途 |
|---|---|
| `koala validate` | 当前标准项目级验证入口，写 validation evidence / bug / stale evidence 结果 |
| `checklist_update` | DEV 阶段记录 checklist status、`verificationIntent`、`verificationEvidence` |
| `verification_evidence_refresh_stale` | 在重跑真实验证后刷新 stale evidence 的 HEAD/material hash |
| `test_auto` | legacy/compat 全量 fixture runner，维护旧 fixture 时才用 |
| `test_story` | legacy/compat story fixture runner |
| `test_fixture` | legacy/compat 单 fixture/链路 runner |
| `fixture_batch_add` / `fixture_update` | legacy/compat fixture 维护入口 |
| `test_add` | legacy/compat 测试证据写入；新流程用 `verificationEvidence` |
| `task_coverage` | legacy/maintenance 覆盖辅助；当前 coverage gate 读取 `verificationEvidence` |
| `browser_test` | 单独跑浏览器测试，结果应转写为 `verificationEvidence` |
| `test_list` | 查看测试证据 |
| `bug_report` | 报告 bug（自动标关联 item in_progress + 回退 DEV） |
| `bug_update` | 更新 bug 状态 |
| `bug_list` | 查看 bug 列表 |
| `diagnose` | 自动诊断（DEV 纯建议，TEST 关联 bug_report） |

## 跨语言执行协议

Legacy fixture 是语言无关测试协议，不是 JS 脚本容器。`execute` 只代表 legacy `js.execute` executor；Python、Go、C++、Java、Swift、Objective-C 等项目应优先通过 `command` / 语言 executor / 原生测试命令产生 `verificationEvidence`，再由 `koala validate` 在 TEST 阶段消费。

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

Reviewer 不能把“JS runner 无法 import Python/Go/C++/Java/Swift/OC”判定为测试通过；这只能说明缺少对应 executor 证据或 `verificationEvidence`。
