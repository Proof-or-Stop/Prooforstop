<!-- koala:start -->
# CLAUDE.md

## 行为准则

1. 任何需求先走完整 Story 流程，除非用户明确说"立刻改"或"快速修改"
2. 行动前先 `koala task_scan` 了解项目，不要直接 Read 文件或用 Explore
3. 输出要简洁，但推理要彻底
4. 优先编辑而不是重写整个文件
5. 不要重复阅读已经读过的文件
6. 在宣布完成前测试你的代码
7. 不要有奉承的开场白或结束语
8. 保持解决方案简单直接
9. 用户指令始终覆盖此文件

## 架构原则

**数据、逻辑、渲染三层解耦**：
- **数据层**：纯状态定义和存储，不含业务判断
- **逻辑层**：纯业务规则，不依赖 DOM/IO/渲染
- **渲染层**：尽可能轻薄，只映射状态到 UI

逻辑层可通过 fixture 白盒测试覆盖，渲染层通过浏览器 trace 验证。新建函数时先判断属于哪一层。

## koala CLI

```bash
koala <command> '{"key":"value"}'   # 全局命令，任何目录可用
koala <command> --help              # 查看参数（出错时先查）
koala help                          # 列出所有命令
koala --root /path/to/project ...   # 指定项目根目录
```

**调用出错时先 `koala <command> --help`**，不要靠记忆猜参数。

### 常用命令速查

```bash
# 一键创建 Story + DEV + worktree（最常用）
koala story_quick '{"name":"xxx","title":"...","description":"...","type":"feature","priority":"high","checklist":[{"title":"做什么"}]}'

# 查文件详情（签名、属性、import）
koala aux_detail '{"files":["game-logic.ts","main.ts"]}'

# 元数据写入：在源码注释里写 /** @task B-xxx ... */，然后跑 aux_sync extract 自动同步到 task.json
koala aux_sync --direction=extract

# 批量添加 fixture case
koala fixture_batch_add '{"fixturePath":"game-logic","cases":[{"name":"test1","run_type":"cli","file":"game-logic","execute":"return $handlers.foo({})","expect":true}]}'

# checklist
koala checklist_get '{"storyId":"B-xxx"}'
koala checklist_update '{"storyId":"B-xxx","itemId":"CHK-001","status":"done"}'

# 推进 + 测试
koala story_advance '{"storyId":"B-xxx","phase":"TEST"}'
koala test_auto '{"storyId":"B-xxx"}'
```

## Checklist 写法

```json
{ "title": "做什么（一句话）", "context": "根因/参考方案" }
```

title 描述「做什么」，不描述「怎么做」。context 给执行 agent 提供决策上下文。

## Fixture 写法

用 `fixture_batch_add` 一次提交所有 case，不要逐个 `fixture_update`。

**白盒 case**（每个 case 必须有 `fn` 字段）：
```json
{ "name": "正常调用", "fn": "functionName", "input": {...}, "expect": {...} }
{ "name": "抛错", "fn": "functionName", "input": {...}, "throws": "error message" }
```

**有状态依赖的 case 链**（如 place → resign → getState）：按顺序排列，共享同一个 test-runtime 实例状态：
```json
{ "name": "setup: 落子", "fn": "place", "input": {"r":7,"c":7}, "expect": {"success":true} }
{ "name": "认输成功", "fn": "resign", "input": {}, "expect": true }
{ "name": "验证状态", "fn": "getState", "input": {}, "expect": {"gameOver":true} }
```

**OOP 类方法**：`fn` 填 test-runtime handler 名（如 `Game`、`resign`），不是源码方法名。

**Browser case**：
```json
{ "name": "点击测试", "browser": true, "steps": [
  { "action": "eval", "code": "document.getElementById('btn').click()" },
  { "action": "assert", "selector": "#status", "contains": "完成" }
]}
```

steps: `eval`、`click`、`type`、`assert`（自动轮询）、`screenshot`、`wait`

## 元数据管理

元数据来自源码内联注释 `/** @task B-xxx ... */`，由 `aux_sync extract` 同步到 `docs/metadata/task.json`：

- 在函数上方写 `/** @task ... */` 注释（task / checklist / title / type / priority / description / test / changes 等字段）
- `koala aux_sync --direction=extract` — 扫描源码注释批量写入 task.json
- `koala aux_scan` — 查询 task.json + 校验合规
- `koala aux_sync --direction=validate` — 校验 task.json 与源码一致性
- `koala aux_detail '{"files":["x.ts"]}'` — 按文件查函数签名/属性

每个函数必须有 `test` 字段（fixture 路径或 `"skip"`）。

### 常见错误（必读）

1. **sourceFile 不含 scanRoot 前缀**：`scanRoot` 是 `src` 时，填 `game-logic.ts` 不是 `src/game-logic.ts`
2. **fn 填 test-runtime handler 名**：如 `Game`、`resign`，不是源码方法名
3. **元数据写源码注释**：直接在函数上方写 `/** @task B-xxx ... */`，不要走 CLI 单条注解；fixture case 用 `fixture_batch_add` 批量提交
4. **fixture 一次写对**：先想清楚所有 case 再 batch_add，不要加了再删重建
5. **checklist 逐项完成**：做完一项标一项 done，不要一开始就全标 done
6. **门禁失败时**：读错误信息里的 `→` 修复命令，直接执行，不要放弃重做
7. **渲染层函数必须标 test:"skip"**：DOM 相关函数（如 updateStatus、doResign）标 skip

## 规则

- 所有 Story/fixture/元数据操作通过 `koala` CLI 完成，禁止直接读写 JSON
- 浏览器项目通过 `koala test_auto` 跑 `run_type:browser` 的 case 测试
- 所有环境统一用 CLI

<!-- koala:end -->
