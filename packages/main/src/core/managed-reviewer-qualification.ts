/**
 * Dependency-free policy values shared by formal reviewer submission and
 * operator guidance. Keep this leaf free of provider/process imports so the
 * state-machine guidance graph does not acquire host-launch dependencies.
 */
export const QUALIFIED_MANAGED_REVIEWER_DEFAULTS = {
  codex: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
  claude: { model: 'opus', reasoningEffort: 'high' },
} as const;

export const CLAUDE_SUPPORTED_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export const QUALIFIED_MANAGED_REVIEWER_EFFORTS = {
  codex: ['high', 'xhigh', 'max', 'ultra'],
  claude: ['high', 'xhigh', 'max'],
} as const;
