# 项目愿景与定位

## 核心定位

Lattice CLI（packages/main，legacy alias: `koala`）是一个 **host-neutral 的通用项目开发编排 CLI**，目标是实现从需求到代码的完整闭环：

```
truth（需求真相源）→ story（执行计划）→ code（开发）→ extract（提取验证）→ gap（差距分析）→ converge（收敛判定）
```

## 设计原则

- **CLI / MCP 工具驱动**：所有项目管理操作通过 Lattice/Koala 命令或 MCP 工具完成，AI 通过结构化入口而非文档约束来执行流程
- **主入口**：`lattice` 是 0.3.5 主产品入口，`koala` 保留为兼容 alias；`/koala` Skill 仍可路由到同一套命令
- **结构化注释即元数据**：代码中的 `@task`/`@flow`/`@test` 注释是项目状态的活文档，可被工具扫描和校验
- **真相源分离**：需求决策（docs/requirements/decisions/）与执行计划（Story）分离，避免循环依赖
- **CLI-first host migration**：Mac App provider/config dashboard 功能通过 `host_*`、`lattice_config_doctor`、`rollout_check`、`authority_status`、`conduit_*` 等 CLI surface 表达；Mac App 只保留 optional/dashboard/archive 角色
- **Host Overflow manual-first**：Lattice Host Overflow 把 Claude Code / Codex 等看作 execution hosts；Lattice 继续持有 story、scope、receipt、merge authority。`host_status`、`handoff_*`、`host_dispatch` 都只能投影 readiness / handoff / receipt / worktree 信息，不能 auto-trust、auto-merge 或 claim `productionDone`
- **Rollout 可巡检但不越权**：`lattice rollout_check` 只读扫描项目版本、wrapper/realpath、managed assets、runtime footprint、git/story 状态与 transcript lifecycle readiness；它不执行 apply/upgrade/repair/fix，不提交 evidence，不验证 receipt，也不把本地 PASS 提升为 production authority
- **Alias refresh 可审计**：本地或全局 CLI 刷新后必须同时验证 `lattice --version` 与 `koala --version`，让主入口和 legacy alias 的漂移都显式可见

## 技术栈

- TypeScript + Node.js
- xstate（状态机管理 Story 生命周期）
- MCP Server（Claude Code 集成）
- Claude Code Skills（用户交互层）

## 约束

- Story 文件操作必须通过 MCP 工具，禁止直接读写 JSON
- 真相源是 Markdown 文件，不转 JSON，每次从 md 实时扫描提取
