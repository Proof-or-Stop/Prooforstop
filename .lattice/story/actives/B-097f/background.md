## Trigger Event
2026-06-16 用户在某个已用 Claude Code 的项目里跑 lattice init,发现仍生成一堆 .md。排查确认:B-4ee0 的 global-thin 只收了 Codex/asset-mode 轴,Claude 侧的 .claude/agents/*.md 由 profile 轴控制,claude/all profile 下 init 仍向项目写 16 个 agent 模板(当前为 symlink,target 指向 dev 仓 packages/main/templates/agents/)。

## Key Insights
profile 轴与 asset-mode 轴正交:asset-mode=global-thin 跳过 LATTICE.md/bin/.Codex,但 .claude/agents 由 wantsClaude(profile)决定,与 asset-mode 无关。Claude Code subagent 必须从磁盘解析,无纯 CLI 内存解析路径;但 Claude Code 支持用户级全局 ~/.claude/agents/,可作为所有项目的单一解析源。当前每个项目 16 条 symlink 既冗余又指向不健壮的 dev 路径。

## Solution Tradeoffs
候选 A 全局 agents 目录:模板装一次到 ~/.claude/agents(symlink 指向运行中 CLI 包),init 项目内零 agent 文件,所有项目全局解析——改动小、风险低、改 CLI 即全局生效;需处理 project-local 旧文件 shadow 全局的迁移。候选 B 彻底取消 subagent_type 由 CLI 内联吐 prompt——最贴单一来源但需重构整个 reviewer 调用流 + 改 CLAUDE.md,工作量大。用户已选 A。

## Conversational Texture
用户原话:目的是让所有项目不要使用之前生成的 .md 文档,只能通过 Lattice CLI 调用 prompt 以确保改 Lattice 后一致性;且 init 不允许再生成这么多 .md。用户明确要求简洁、直接执行,不要冗长解释。
