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
- 改动 Codex adapter / \`.Codex\` / \`bin/koala-codex.js\` 后运行 \`node bin/koala-codex.js verify_codex\`，让 REVIEW/DONE gate 能消费硬证据。
- 诊断 Codex adapter 时运行 \`node bin/koala-codex.js doctor\`。

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
      command: 'KOALA_ACTIVITY_SOURCE=codex KOALA_ACTIVITY_RECORD_READONLY=1 koala',
      useWhen: 'Only the global koala CLI is available; include read-only recording for session_brief heartbeats.',
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
    'Run node bin/koala-codex.js verify_codex after changing Codex adapter assets; it records codex_adapter_verification evidence for gates.',
  ],
} as const;

export function renderCodexAdapterManifest(): string {
  return `${JSON.stringify(CODEX_ADAPTER_MANIFEST, null, 2)}\n`;
}

export const CODEX_README_TEMPLATE = `# Codex + Koala

优先做法：

\`\`\`bash
node bin/koala-codex.js session_brief
node bin/koala-codex.js aux_doc_list --format=json
\`\`\`

原因：

- \`node bin/koala-codex.js\` 是仓库内 Codex 首选入口，会加载本地 bootstrap（main + utils）
- wrapper 会写入 \`.koala/activity.jsonl\`，并标记 \`source=codex\`
- wrapper 会为 \`session_brief\` 这类只读恢复命令启用 activity heartbeat

只有当前项目没有本地 wrapper 时，才使用全局 fallback：

\`\`\`bash
KOALA_ACTIVITY_SOURCE=codex KOALA_ACTIVITY_RECORD_READONLY=1 koala session_brief
\`\`\`

fallback 说明：

- \`KOALA_ACTIVITY_SOURCE=codex\` 会把本次调用标记为 \`source=codex\`
- \`KOALA_ACTIVITY_RECORD_READONLY=1\` 会让 \`session_brief\` 这样的只读入口也记录 heartbeat
- 全局 \`koala\` 可能是 core-only，\`aux_*\` 命令不一定可用
- \`.Codex/agents\` 由 \`.claude/agents\` 的完整 prompt 集合受控生成；Claude hooks/settings/skills 仍只属于 \`.claude\`
- \`.Codex/koala.json\` 是 Koala 自己读取的 Codex adapter manifest，用来说明推荐入口、session 环境变量和不生成的 runtime 资产

建议：

- 新 session 第一条命令跑 \`node bin/koala-codex.js session_brief\`
- 日常所有 story/checklist/fixture/bug 操作尽量保持同一入口
- 改动 Codex adapter 资产后运行 \`node bin/koala-codex.js verify_codex\`（或 \`node bin/koala.js verify_codex\`）；它会验证 manifest、agent mirror、wrapper heartbeat、global fallback heartbeat 和 runtime 排除项，并写入 gate 可消费的 process-event evidence
- 初始化脚本可用 \`npx koala-init --verify-codex\` 做同源资产校验
- 诊断 Codex adapter 时运行 \`node bin/koala-codex.js doctor\`，可同时查看共享检查、health 和 worktree 状态
- 如果 \`aux_*\` 不可用，说明当前是 core-only koala：优先找本地 bootstrap 入口；没有的话，用 AGENTS.md 规定的 shell 搜索兜底

边界：

- 不创建 \`.Codex/hooks\`，因为 Codex runtime 不会执行 Claude Code hooks
- 不创建 \`.Codex/settings.json\`，因为 Codex runtime 不会读取 Claude Code settings
- 需要观测 Codex 活动时，使用 \`.Codex/koala.json\` 记录的 wrapper 或带 \`KOALA_ACTIVITY_RECORD_READONLY=1\` 的 fallback
`;

export function renderCodexAgentContent(content: string): string {
  return content
    .replace(/Claude Code/g, 'Codex')
    .replace(/\.claude\/agents\//g, '.Codex/agents/');
}
