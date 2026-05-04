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

export const CODEX_ADAPTER_MANIFEST = {
  adapterOwner: 'koala',
  adapterKind: 'codex',
  activitySource: 'codex',
  recommendedEntrypoints: [
    {
      name: 'local-wrapper',
      command: 'node bin/koala-codex.js',
      useWhen: 'This repository includes the Koala bootstrap wrapper.',
    },
    {
      name: 'global-fallback',
      command: 'KOALA_ACTIVITY_SOURCE=codex koala',
      useWhen: 'Only the global koala CLI is available.',
    },
  ],
  sessionEnv: {
    source: 'KOALA_ACTIVITY_SOURCE',
    session: 'KOALA_ACTIVITY_SESSION',
    recordReadOnly: 'KOALA_ACTIVITY_RECORD_READONLY',
    sessionCandidates: [
      'CODEX_SESSION_ID',
      'OPENAI_SESSION_ID',
      'TERM_SESSION_ID',
    ],
  },
  excludedRuntimeAssets: [
    '.Codex/hooks',
    '.Codex/settings.json',
  ],
  notes: [
    'This file is read by Koala tooling, not by the Codex runtime.',
    'Codex agent prompts live in .Codex/agents and are generated from .claude/agents.',
    'Claude Code hooks, settings, and skills remain under .claude only.',
  ],
} as const;

export function renderCodexAdapterManifest(): string {
  return `${JSON.stringify(CODEX_ADAPTER_MANIFEST, null, 2)}\n`;
}

export const CODEX_README_TEMPLATE = `# Codex + Koala

通用做法：

\`\`\`bash
KOALA_ACTIVITY_SOURCE=codex koala session_brief
\`\`\`

原因：

- \`KOALA_ACTIVITY_SOURCE=codex\` 会把本次调用写入 \`.koala/activity.jsonl\`，并标记 \`source=codex\`
- 如果当前项目只有全局 \`koala\`，这是最稳妥的 Codex 入口
- \`.Codex/agents\` 由 \`.claude/agents\` 的完整 prompt 集合受控生成；Claude hooks/settings/skills 仍只属于 \`.claude\`
- \`.Codex/koala.json\` 是 Koala 自己读取的 Codex adapter manifest，用来说明推荐入口、session 环境变量和不生成的 runtime 资产

如果当前仓库后续增加了本地 wrapper（例如 \`node bin/koala-codex.js\`），再优先切换到本地 wrapper。

建议：

- 新 session 第一条命令跑 \`KOALA_ACTIVITY_SOURCE=codex koala session_brief\`
- 日常所有 story/checklist/fixture/bug 操作尽量保持同一入口
- 如果 \`aux_*\` 不可用，说明当前是 core-only koala：优先找本地 bootstrap 入口；没有的话，用 AGENTS.md 规定的 shell 搜索兜底

边界：

- 不创建 \`.Codex/hooks\`，因为 Codex runtime 不会执行 Claude Code hooks
- 不创建 \`.Codex/settings.json\`，因为 Codex runtime 不会读取 Claude Code settings
- 需要观测 Codex 活动时，使用 \`.Codex/koala.json\` 记录的 wrapper 或 \`KOALA_ACTIVITY_SOURCE=codex\` fallback
`;

export function renderCodexAgentContent(content: string): string {
  return content
    .replace(/Claude Code/g, 'Codex')
    .replace(/\.claude\/agents\//g, '.Codex/agents/');
}
