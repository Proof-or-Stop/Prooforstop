import { readdirSync } from 'fs';

export const SUPPORTED_INIT_PROFILES = ['codex', 'claude', 'all', 'core'] as const;
export type InitProfile = typeof SUPPORTED_INIT_PROFILES[number];

export function listAgentPromptFiles(agentDir: string): string[] {
  return readdirSync(agentDir)
    .filter(file => file.endsWith('.md'))
    .sort((a, b) => a.localeCompare(b));
}

export const AGENTS_MD_TEMPLATE = `# AGENTS.md

<!-- koala:start -->
## Koala

- \`KOALA.md\` 是 host-neutral 的 Koala 指南；以下只保留 Codex / AGENTS 侧补充。
- 新 session 或恢复中断工作时，先运行 \`koala session_brief\`。
- 行动前运行 \`koala aux_doc_list\` 查看相关文档；若当前全局 core-only 环境没有 aux 命令，用本地 bootstrap 或 shell 搜索兜底。
- Story / checklist / fixture / bug 操作优先通过 \`koala\` CLI，不直接改 story/fixture JSON。
- Codex subagent prompts 位于 \`.Codex/agents\`；Claude Code 专属资产只会在启用 Claude profile 的仓库里生成。
- 改动 Codex adapter / \`.Codex\` / \`bin/koala-codex.js\` 后运行 \`node bin/koala-codex.js verify_codex\`，让 REVIEW/DONE gate 能消费硬证据。
- 诊断 Codex adapter 时运行 \`node bin/koala-codex.js doctor\`。

<!-- koala:end -->
`;

export const KOALA_MD_TEMPLATE = `# KOALA.md

<!-- koala:start -->
## Koala

\`KOALA.md\` 是 Koala 的 canonical、host-neutral 指南。所有 init profile 都会创建或同步这个文件。

- 新 session 或恢复中断工作时，先运行 \`koala session_brief\`。
- 行动前运行 \`koala aux_doc_list\` 查看相关文档；若当前全局 core-only 环境没有 aux 命令，用本地 bootstrap 或 shell 搜索兜底。
- Story / checklist / fixture / bug 操作优先通过 \`koala\` CLI，不直接改 story/fixture JSON。
- 默认本地入口是 \`node bin/koala.js\`；若 profile 生成了 Codex adapter，可额外使用 \`node bin/koala-codex.js\`。
- Codex 专属说明放在 \`AGENTS.md\` 和 \`.Codex/README.md\`；Claude 专属说明放在 \`CLAUDE.md\` 和 \`.claude/\`。
- 改动 Koala adapter 资产后先跑对应验证：项目验证用 \`koala validate\`，Codex adapter 额外跑 \`node bin/koala-codex.js verify_codex\`。

<!-- koala:end -->
`;

export const CLAUDE_MD_TEMPLATE = `# CLAUDE.md

<!-- koala:start -->
## Koala For Claude Code

- \`KOALA.md\` 是 canonical、host-neutral 的 Koala 指南；Story 生命周期、流程事实和通用规则都以它为准。
- Claude Code 入口先跑 \`koala session_brief\`，日常操作继续使用 \`koala\` CLI。
- Claude Code subagents 位于 \`.claude/agents\`。
- Claude Code hooks 位于 \`.claude/hooks\`，Claude settings 位于 \`.claude/settings.json\`。
- Claude Code 的 \`/koala\` skill 位于 \`.claude/skills/koala\`。
- 当仓库同时启用 Codex profile 时，Codex 资产会单独放在 \`.Codex/\`，不要把这里当成双端共享真相源。

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
      command: 'KOALA_ACTIVITY_SOURCE=codex KOALA_ACTIVITY_RECORD_READONLY=1 KOALA_CODEX_ENTRYPOINT=global-fallback koala',
      useWhen: 'Only the global koala CLI is available for read-only heartbeats; do not use it as current-worktree gate/status evidence when a local wrapper or core CLI exists.',
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
KOALA_ACTIVITY_SOURCE=codex KOALA_ACTIVITY_RECORD_READONLY=1 KOALA_CODEX_ENTRYPOINT=global-fallback koala session_brief
\`\`\`

fallback 说明：

- \`KOALA_ACTIVITY_SOURCE=codex\` 会把本次调用标记为 \`source=codex\`
- \`KOALA_ACTIVITY_RECORD_READONLY=1\` 会让 \`session_brief\` 这样的只读入口也记录 heartbeat
- \`KOALA_CODEX_ENTRYPOINT=global-fallback\` 会防止本地 wrapper 子进程把 global fallback 误记成 \`local-wrapper\`
- 全局 \`koala\` 可能是 core-only，\`aux_*\` 命令不一定可用
- 全局 \`koala\` 也可能滞后于当前 worktree；有本地 wrapper 或 \`node packages/main/dist/cli.js\` 时，不要把 fallback 的 \`status\` / \`next\` / \`validate\` 输出当作 gate 证据
- \`.Codex/agents\` 由 \`.claude/agents\` 的完整 prompt 集合受控生成；Claude hooks/settings/skills 仍只属于 \`.claude\`
- \`.Codex/koala.json\` 是 Koala 自己读取的 Codex adapter manifest，用来说明推荐入口、session 环境变量和不生成的 runtime 资产

建议：

- 新 session 第一条命令跑 \`node bin/koala-codex.js session_brief\`
- 日常所有 story/checklist/fixture/bug 操作尽量保持同一入口
- 在 Koala 仓库自身开发时，若完整 wrapper 暂不可用，用 \`node packages/main/dist/cli.js <command>\` 做当前 worktree 的 status/gate/validate 判断
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
