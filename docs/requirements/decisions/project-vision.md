# 项目愿景与定位

## 核心定位

koala (packages/main) 是一个 **Claude 驱动的通用项目开发框架**，目标是实现从需求到代码的完整闭环：

```
truth（需求真相源）→ story（执行计划）→ code（开发）→ extract（提取验证）→ gap（差距分析）→ converge（收敛判定）
```

## 设计原则

- **MCP 工具驱动**：所有项目管理操作通过 24 个 MCP 工具完成，AI 通过工具调用而非文档约束来执行流程
- **单一入口**：`/koala` Skill 是唯一用户交互入口，内部根据意图路由到对应工具
- **结构化注释即元数据**：代码中的 `@task`/`@flow`/`@test` 注释是项目状态的活文档，可被工具扫描和校验
- **真相源分离**：需求决策（docs/requirements/decisions/）与执行计划（Story）分离，避免循环依赖

## 技术栈

- TypeScript + Node.js
- xstate（状态机管理 Story 生命周期）
- MCP Server（Claude Code 集成）
- Claude Code Skills（用户交互层）

## 约束

- Story 文件操作必须通过 MCP 工具，禁止直接读写 JSON
- 真相源是 Markdown 文件，不转 JSON，每次从 md 实时扫描提取
