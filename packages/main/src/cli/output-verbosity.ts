/**
 * Shared output-verbosity resolver (B-7c05).
 *
 * Whale CLI outputs (help catalog, story_list / bug_list dumps, finding_list,
 * the milestone ledger table appended after every mutating command) are re-paid
 * by an agent loop on every subsequent model call in the same turn. This helper
 * makes those commands BRIEF by default while keeping a per-call `--full` escape
 * hatch, a global `LATTICE_BRIEF_OUTPUT` env hatch, and a frozen explicit
 * machine-JSON shape. It mirrors the existing per-handler `wantsJson()`
 * convention so handlers opt in the same way.
 *
 * Precedence (highest first):
 *   1. explicit machine-JSON opt-in (`--json` / `--format=json`) → FULL frozen shape
 *   2. per-call `--full` → full
 *   3. per-call `--brief` → brief
 *   4. `LATTICE_BRIEF_OUTPUT` === literal string "0" → full
 *   5. brief default
 *
 * Rendering-only: this changes no gate/state-machine logic and no storage.
 */

export const BRIEF_OUTPUT_ENV_VAR = 'LATTICE_BRIEF_OUTPUT';

/** The full-output flag name surfaced in hints/docs so callers stay consistent. */
export const FULL_OUTPUT_FLAG = '--full';

export interface OutputVerbosityArgs {
  full?: unknown;
  brief?: unknown;
  json?: unknown;
  format?: unknown;
  [key: string]: unknown;
}

/**
 * Explicit machine-JSON opt-in. Kept separate from `wantsFullOutput` so text
 * commands (e.g. milestone_status) can return their JSON report object BEFORE
 * choosing between brief and full text.
 */
export function wantsExplicitJson(args?: OutputVerbosityArgs | null): boolean {
  if (!args || typeof args !== 'object') return false;
  return args.json === true || args.format === 'json';
}

/**
 * Only the literal env string "0" disables the brief default (exactly as the
 * story requested). Any other value — including "false", "1", "" — keeps brief.
 */
export function envDisablesBrief(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[BRIEF_OUTPUT_ENV_VAR] === '0';
}

/**
 * True when the caller wants the current FULL output shape. Explicit machine
 * JSON always maps to full (the frozen shape). See the precedence list above.
 */
export function wantsFullOutput(
  args?: OutputVerbosityArgs | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (wantsExplicitJson(args)) return true;
  if (args && args.full === true) return true;
  if (args && args.brief === true) return false;
  if (envDisablesBrief(env)) return true;
  return false;
}

/** Convenience negation of {@link wantsFullOutput}. */
export function wantsBriefOutput(
  args?: OutputVerbosityArgs | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !wantsFullOutput(args, env);
}

/**
 * Collapse a possibly-multiline free-text field to a single truncated line for
 * brief renderings. Never throws; returns '' for nullish input.
 */
export function truncateOneLine(value: unknown, max = 100): string {
  if (typeof value !== 'string') return '';
  const oneLine = value.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
