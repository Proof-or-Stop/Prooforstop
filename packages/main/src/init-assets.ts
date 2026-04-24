export const CODEX_AGENT_FILES = ['test-intent.md', 'test-case-reviewer.md', 'product-reviewer.md', 'implementation-reviewer.md'] as const;

export interface InitGuideConfig {
  storyDir: string;
  storyPrefix: string;
  worktreeDir: string;
}

export const CODEX_README_TEMPLATE = `# Codex + Koala

通用做法：

\`\`\`bash
KOALA_ACTIVITY_SOURCE=codex koala session_brief
\`\`\`

原因：

- \`KOALA_ACTIVITY_SOURCE=codex\` 会把本次调用写入 \`.koala/activity.jsonl\`，并标记 \`source=codex\`
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

export function renderInitAgentsTemplate(cfg: InitGuideConfig): string {
  return `# AGENTS.md

## Working Rules

1. First command in a new session: \`koala session_brief\`
2. Before coding, read the current project state with \`koala session_brief\` and \`koala aux_doc_list\`
3. This project uses the current Koala lifecycle:

\`\`\`
INIT → INIT_CHECK → PLAN / quick-path → DEV → REVIEW → TEST → DONE
\`\`\`

4. The old \`TEST_CASE\` / \`TEST_CASE_REVIEW\` / \`testIntent\` / \`test_auto\` flow is legacy background only. Use:
   - \`verificationIntent\` on checklist items
   - \`verificationEvidence\` / \`verification_evidence_add\`
   - \`koala validate\`
5. Story data lives in \`${cfg.storyDir}/<${cfg.storyPrefix}-xxxx>/\`
6. New stories use the \`${cfg.storyPrefix}-\` prefix
7. Worktrees are created under \`${cfg.worktreeDir}/\`
8. Do not edit story JSON files directly; use Koala CLI commands

## Typical Flow

\`\`\`bash
koala session_brief
koala story_create '{"name":"example","title":"...","description":"...","type":"feature","priority":"high","checklist":[{"title":"...","context":"..."}]}'
koala story_advance '{"storyId":"${cfg.storyPrefix}-xxxx","phase":"INIT_CHECK"}'
cd ${cfg.worktreeDir}/${cfg.storyPrefix}-xxxx
koala story_review '{"storyId":"${cfg.storyPrefix}-xxxx"}'
koala story_advance '{"storyId":"${cfg.storyPrefix}-xxxx","phase":"DEV"}'
koala validate
\`\`\`
`;
}

export function renderInitClaudeTemplate(cfg: InitGuideConfig): string {
  return `# CLAUDE.md

## First Steps

1. Run \`koala session_brief\`
2. Run \`koala aux_doc_list\` if you need related docs
3. Follow the current Koala lifecycle only:

\`\`\`
INIT → INIT_CHECK → PLAN / quick-path → DEV → REVIEW → TEST → DONE
\`\`\`

## Important Conventions

- Story records live in \`${cfg.storyDir}\`
- Story IDs use prefix \`${cfg.storyPrefix}-\`
- Worktrees live under \`${cfg.worktreeDir}\`
- Use \`koala validate\` for verification
- Use \`verificationIntent\` / \`verificationEvidence\`, not legacy \`testIntent\`
- Do not rely on legacy \`TEST_CASE\`, \`TEST_CASE_REVIEW\`, or \`test_auto\` guidance

## Starter Commands

\`\`\`bash
koala session_brief
koala story_create '{"name":"example","title":"...","description":"...","type":"feature","priority":"high","checklist":[{"title":"...","context":"..."}]}'
koala story_review '{"storyId":"${cfg.storyPrefix}-xxxx"}'
koala story_advance '{"storyId":"${cfg.storyPrefix}-xxxx","phase":"DEV"}'
koala validate
\`\`\`
`;
}
