/** Pure configuration. Zero function definitions. */

export const STORY_ROOTS = [
  '.proof-or-stop/story/actives',
  '.lattice/story/actives',
] as const;

/**
 * Rewritten on a heartbeat cadence: they carry live state but no searchable prose,
 * so they must not invalidate the full-text index.
 */
export const LIVE_FILES = [
  'owner-lease.json',
  'takeover-count.json',
  'gate-failure-counts.json',
  'breaker-state.json',
] as const;

/** 96% of story bytes with no readable prose — summarised rather than shipped. */
export const HEAVY_FILES = ['prompt-envelopes.json', 'review-runs.json'] as const;

export const PHASE_ORDER = [
  'INIT', 'INIT_CHECK', 'PLAN', 'DEV', 'REVIEW', 'TEST', 'DONE',
] as const;

export const TERMINAL_PHASES = ['DONE', 'DISCARDED'] as const;

export const DEFAULTS = {
  /** Re-stat the story tree at most this often. */
  statThrottleMs: 1500,
  /** Skip indexing single files above this size. */
  maxIndexBytes: 4_000_000,
  searchLimit: 80,
  /** Hard ceiling: a caller-supplied limit can never exceed this. */
  maxSearchLimit: 500,
  /** Query bounds: a pathological input must not dominate the server. */
  maxQueryChars: 500,
  maxQueryTerms: 24,
  /** `git worktree list` is a subprocess (~25ms); worktrees change rarely. */
  worktreeTtlMs: 5_000,
  port: 8731,
} as const;
