import { readdirSync } from 'fs';

export function listAgentPromptFiles(agentDir: string): string[] {
  return readdirSync(agentDir)
    .filter(file => file.endsWith('.md'))
    .sort((a, b) => a.localeCompare(b));
}

export const AGENTS_MD_TEMPLATE = `# AGENTS.md

<!-- koala:start -->
## Koala

- 新 session 或恢复中断工作时，先运行 \`koala session_brief\`。
- 行动前运行 \`koala aux_doc_list\` 查看相关文档；若当前全局 core-only 环境没有 aux 命令，用本地 bootstrap 或 shell 搜索兜底。
- Story / checklist / fixture / bug 操作优先通过 \`koala\` CLI，不直接改 story/fixture JSON。
- Codex subagent prompts 位于 \`.Codex/agents\`；Claude subagent prompts 位于 \`.claude/agents\`。

<!-- koala:end -->
`;

export const CODEX_README_TEMPLATE = `# Codex + Koala

通用做法：

\`\`\`bash
KOALA_ACTIVITY_SOURCE=codex koala session_brief
\`\`\`

原因：

- \`KOALA_ACTIVITY_SOURCE=codex\` 会把本次调用写入 \`.koala/activity.jsonl\`，并标记 \`source=codex\`
- 如果当前项目只有全局 \`koala\`，这是最稳妥的 Codex 入口
- \`.Codex/agents\` 由 \`.claude/agents\` 的完整 prompt 集合受控生成；Claude hooks/settings/skills 仍只属于 \`.claude\`

如果当前仓库后续增加了本地 wrapper（例如 \`node bin/koala-codex.js\`），再优先切换到本地 wrapper。

建议：

- 新 session 第一条命令跑 \`KOALA_ACTIVITY_SOURCE=codex koala session_brief\`
- 日常所有 story/checklist/fixture/bug 操作尽量保持同一入口
- 如果 \`aux_*\` 不可用，说明当前是 core-only koala：优先找本地 bootstrap 入口；没有的话，用 AGENTS.md 规定的 shell 搜索兜底
`;

export function renderCodexAgentContent(content: string): string {
  return content
    .replace(/Claude Code/g, 'Codex')
    .replace(/\.claude\/agents\//g, '.Codex/agents/');
}
