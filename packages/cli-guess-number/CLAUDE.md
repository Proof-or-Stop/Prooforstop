# CLAUDE.md

## 代码目录

项目核心代码在 `packages/main/` 下，使用 TypeScript。

## 新 Session 入口（强制）

**任何需求都必须先执行 `/koala`**。不要直接写代码或写测试。`/koala` 会引导你走 Story 流程：创建 → 开发 → 测试 → 收尾。

- 用户说"加个功能" → `/koala` → 创建 Story → 开发 → 测试
- 用户说"测试一下" → `/koala` → 用 `test_auto` / `browser_test` 跑测试
- 用户说"修个 bug" → `/koala` → 创建 Bug Story → 修复 → 测试

**禁止**：直接写 `.test.ts` 文件、直接用 jest/vitest/mocha。所有测试通过 koala 的 fixture + MCP 工具完成。

## 元数据管理（强制）

源码是纯业务代码，**不含 @task/@flow 注释**。所有元数据存储在 `docs/metadata/` 下：

- `task.json` — 函数级元数据（task/checklist/description/changes/test 等）

**元数据和函数是绑定的**。每次新增、修改、删除函数时，**必须同步更新 task.json**：
- 新增函数 → `task_annotate` 添加元数据（包括 test 字段指向 fixture）
- 修改函数 → `task_annotate(action=update)` 更新 description/changes
- 删除函数 → 从 task.json 删除对应记录
- DEV→TEST 门禁会检查：改了函数没更新元数据 = 不放行

<!-- flow.json 暂时屏蔽，后续启用 -->

### 操作方式

通过 MCP 工具操作元数据，**禁止直接编辑 JSON 文件**：

| 工具 | 用途 |
|------|------|
| `task_annotate` | 给函数添加/更新元数据（AST 验证函数存在性） |
| `task_sync(validate)` | 校验元数据和源码是否一致 |
| `task_sync(extract)` | 从源码注释提取到 JSON（迁移用） |
| `task_scan` | 查询元数据（从 task.json 读取） |
| `task_locate` | 按 ID/关键词定位代码 |

### 元数据字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `task` | 是 | Story ID，如 `B-001` |
| `checklist` | 是 | Checklist 项 ID |
| `title` | 是 | 任务标题 |
| `type` | 是 | `feature` / `bugfix` / `refactor` / `chore` |
| `priority` | 是 | `critical` / `high` / `medium` / `low` |
| `description` | 是 | 描述 |
| `changes` | 是 | 变更列表 |
| `test` | 是* | fixture 路径（相对 fixturesDir） |

\* 每个函数必须有 test 字段，DEV→TEST 门禁会检查。遇到不可单测的函数时：
1. **先拆**——把纯逻辑从 DOM/渲染/IO 中拆到独立函数，独立函数写 fixture 测试
2. **拆不了才 skip**——确实无法拆分的函数（如纯 canvas 绘制）标 `test: "skip"`
3. **skip 的函数真机 trace 必须覆盖到**——浏览器/CLI 真机测试运行时会追踪函数调用，skip 的函数必须在 trace 中出现

### @test 与 fixture

- fixture 路径相对于 `tests/fixtures/`，不含 `.json` 后缀
- 多个函数共享一个 fixture 时，每个 case 必须用 `fn` 字段标注归属
- fixture 格式详见 `docs/requirements/decisions/test-fixture-spec.md`

## 规则

- 所有 Story 文件操作通过 `koala` MCP 工具完成，禁止直接读写 JSON 文件
- 所有 fixture 文件操作通过 `fixture_get` / `fixture_update` / `fixture_gen` MCP 工具完成，禁止直接读写 JSON 文件
- 所有元数据通过 `task_annotate` / `task_sync` MCP 工具管理，源码不含注释
- 浏览器项目通过 `browser_test` MCP 工具测试，配置 `browser.devCommand` 即可，代理自动注入
