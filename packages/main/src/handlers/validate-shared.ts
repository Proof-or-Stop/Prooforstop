/**
 * validate-shared — Shared constants across validate-* CLI gates.
 *
 * Currently only DEFAULT_BASE (the default base branch for git diff / git log),
 * which was duplicated as a same-name constant in validate-channel.ts and validate-concept.ts →
 * extracted here for a unified export (F-008 fix).
 */

/** Default base branch for git diff / git log (story branch compared against main). */
export const DEFAULT_BASE = 'main';
