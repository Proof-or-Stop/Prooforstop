// B-ab8d CHK-001: Pure experiment arm context resolver (experimentId override).
//
// M3 of the experience-layer ablation plan (docs/requirements/decisions/
// experience-layer-ablation-causal-validation-execution-plan.md) switches the
// full runtime memory pack between a control arm (pack hidden, retrieval
// blocked) and a treatment arm (pack shown), keyed by an EXPLICIT opt-in
// experiment context. This leaf resolves that context from two env vars:
// LATTICE_EXPERIMENT_ID + LATTICE_EXPERIMENT_ARM. BOTH must be set and valid,
// otherwise the resolver returns null and every consumer must behave
// byte-identically to production today (null = no experiment active). The arm
// value must never reach prompt hashes or gate decisions — consumers enforce
// that; this leaf only resolves the context.
//
// This leaf is intentionally pure: no fs, no time, no randomness, no I/O
// beyond the injected env snapshot (default process.env). The only process
// state is a module-level once-latch so that a misconfigured context warns a
// single time instead of spamming every resolution call.

export type ExperimentArm = 'control' | 'treatment';

/** Canonical accepted arm values (single source for validation + messages). */
export const EXPERIMENT_ARM_VALUES: readonly ExperimentArm[] = ['control', 'treatment'];

export interface ExperimentArmContext {
  readonly experimentId: string;
  readonly arm: ExperimentArm;
}

export const EXPERIMENT_ID_ENV_VAR = 'LATTICE_EXPERIMENT_ID';
export const EXPERIMENT_ARM_ENV_VAR = 'LATTICE_EXPERIMENT_ARM';

/** Once-per-process latch: misconfigured contexts warn once, not per call. */
let misconfigWarned = false;

/** Reset the once-latch (tests only, mirrors resetConfigCache in config.ts). */
export function resetExperimentArmWarnLatch(): void {
  misconfigWarned = false;
}

function warnOnce(message: string): void {
  if (misconfigWarned) return;
  misconfigWarned = true;
  console.warn(message);
}

/** Read an env value; empty or whitespace-only values are treated as unset. */
function readEnvValue(env: NodeJS.ProcessEnv, name: string): string | null {
  const raw = env[name];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isExperimentArm(value: string): value is ExperimentArm {
  return (EXPERIMENT_ARM_VALUES as readonly string[]).includes(value);
}

/**
 * Resolve the explicit opt-in experiment arm context.
 *
 * - Both vars set and valid -> `{ experimentId, arm }`.
 * - Neither set (empty/whitespace counts as unset) -> `null`, silently:
 *   this is normal production operation, not a misconfiguration.
 * - Exactly one set -> `null` plus ONE `console.warn` naming the ignored var
 *   (once-latched per process).
 * - Invalid arm value -> `null` plus ONE `console.warn` naming the accepted
 *   values `control|treatment` (same once-latch).
 *
 * Plain runtime validation, no schema library — consumers must re-validate
 * the arm value at their own boundaries per the handler coding convention.
 */
export function resolveExperimentArm(
  env: NodeJS.ProcessEnv = process.env,
): ExperimentArmContext | null {
  const experimentId = readEnvValue(env, EXPERIMENT_ID_ENV_VAR);
  const armValue = readEnvValue(env, EXPERIMENT_ARM_ENV_VAR);

  if (experimentId === null && armValue === null) return null;

  if (experimentId === null || armValue === null) {
    const ignored = experimentId === null ? EXPERIMENT_ARM_ENV_VAR : EXPERIMENT_ID_ENV_VAR;
    const missing = experimentId === null ? EXPERIMENT_ID_ENV_VAR : EXPERIMENT_ARM_ENV_VAR;
    warnOnce(
      `[experiment-arm] ${ignored} is set but ${missing} is missing; ` +
        `ignoring ${ignored} (no experiment context active).`,
    );
    return null;
  }

  if (!isExperimentArm(armValue)) {
    warnOnce(
      `[experiment-arm] ${EXPERIMENT_ARM_ENV_VAR}="${armValue}" is not a valid arm; ` +
        `accepted values are control|treatment (no experiment context active).`,
    );
    return null;
  }

  return { experimentId, arm: armValue };
}
