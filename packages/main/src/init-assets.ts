export const CODEX_AGENT_FILES = ['test-intent.md', 'test-case-reviewer.md', 'product-reviewer.md'] as const;

export const CODEX_README_TEMPLATE = `# Codex + Koala

通用做法：

\`\`\`bash
KOALA_ACTIVITY_SOURCE=codex koala session_brief
\`\`\`

原因：

- \`KOALA_ACTIVITY_SOURCE=codex\` 会把本次调用写入 \`docs/story/activity.jsonl\`，并标记 \`source=codex\`
- 如果当前项目只有全局 \`koala\`，这是最稳妥的 Codex 入口

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
