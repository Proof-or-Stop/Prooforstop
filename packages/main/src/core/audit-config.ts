/**
 * audit-config — resolve runtime configuration for framework audit (B-9bd9 CHK-004).
 *
 * Pure function module: `resolveAuditConfig(profile, projectRoot)`.
 *
 * Priority (high → low):
 *   1. Fields in `<projectRoot>/.lattice/audit-config.json` (per-field override;
 *      the legacy `<projectRoot>/.koala/audit-config.json` read fallback was removed in B-a4e3)
 *   2. Profile defaults: auditTriggerWindow tiered as light=10 / balanced=5 / strict=3
 *      (requireClaudeMdDiff and mode have no profile differences, use hardcoded defaults)
 *   3. Hardcoded fallback: auditTriggerWindow=5, requireClaudeMdDiff=true, mode="semi-auto"
 *
 * Failure policy:
 *   - Config file missing → silently use profile defaults
 *   - JSON parse failure → one-time console.warn + fallback to profile defaults
 *   - Invalid mode field value → console.warn + fallback to "semi-auto"
 *
 * This module does **not** register a dedicated CLI command (YAGNI, hand-editing JSON suffices).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LATTICE_DIR } from './lattice-paths.js';
import type { WorkflowProfile } from './types.js';
import { VALID_PARALLEL_MODES } from './parallel-decomposition.js';
import type { ParallelGateConfig, ParallelGateMode } from './parallel-decomposition.js';

export type AuditMode = 'semi-auto' | 'full-auto' | 'off';

export interface AuditConfig {
  auditTriggerWindow: number;
  requireClaudeMdDiff: boolean;
  mode: AuditMode;
  deprecatedGcThreshold: number;
  /** Parallel-decomposition gate config. Optional in Story 0 (contract only);
   * resolveAuditConfig populates it in Story 3 (per-field override + profile tiering). */
  parallelGate?: ParallelGateConfig;
}

/** Hardcoded fallback (last line of defense when all fields are missing). */
const HARD_DEFAULTS: AuditConfig = {
  auditTriggerWindow: 5,
  requireClaudeMdDiff: true,
  mode: 'semi-auto',
  deprecatedGcThreshold: 10,
};

/** profile → auditTriggerWindow default mapping. All other fields share hardcoded fallback across profiles. */
const PROFILE_TRIGGER_WINDOW: Record<WorkflowProfile, number> = {
  light: 10,
  balanced: 5,
  strict: 3,
};

const VALID_MODES: ReadonlySet<AuditMode> = new Set<AuditMode>(['semi-auto', 'full-auto', 'off']);

/** Safe fallback for an invalid parallelGate.mode: advise is non-blocking, so a config typo
 *  degrades to a hint, never a hard PLAN→DEV block. */
const PARALLEL_MODE_FALLBACK: ParallelGateMode = 'advise';

/** Per-profile parallel-decomposition gate defaults (spec §4.7). */
const PARALLEL_GATE_PROFILE_DEFAULTS: Record<WorkflowProfile, ParallelGateConfig> = {
  light: { mode: 'advise', maxConcurrentReview: 2, broadGlobBlocks: false },
  balanced: { mode: 'advise', maxConcurrentReview: 3, broadGlobBlocks: false },
  strict: { mode: 'block', maxConcurrentReview: 4, broadGlobBlocks: true },
};

/**
 * Resolve the nested `parallelGate` config (spec §4.7). Unlike the flat scalar fields, the
 * nested object must be validated field-by-field — the flat per-scalar override path does not
 * recurse, so copying it would silently skip every sub-field check. Each sub-field guards and
 * falls back individually; a missing or non-object `raw` yields the full profile default.
 * `mode` validates against VALID_PARALLEL_MODES (NOT VALID_MODES, which is ReadonlySet<AuditMode>)
 * and an invalid value degrades to advise (safe, non-blocking). Two-param form (raw +
 * explicit profileDefault) keeps the helper pure and decoupled from the profile table (OQ-001).
 */
export function resolveParallelGate(raw: unknown, profileDefault: ParallelGateConfig): ParallelGateConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...profileDefault };
  }
  const r = raw as Record<string, unknown>;
  const result: ParallelGateConfig = { ...profileDefault };

  if (typeof r.mode === 'string') {
    if (VALID_PARALLEL_MODES.has(r.mode as ParallelGateMode)) {
      result.mode = r.mode as ParallelGateMode;
    } else {
      console.warn(
        `[audit-config] invalid parallelGate.mode "${r.mode}", falling back to "${PARALLEL_MODE_FALLBACK}".`,
      );
      result.mode = PARALLEL_MODE_FALLBACK;
    }
  }

  if (typeof r.maxConcurrentReview === 'number' && Number.isFinite(r.maxConcurrentReview)) {
    const m = r.maxConcurrentReview;
    if (!Number.isInteger(m) || m <= 0) {
      console.warn(
        `[audit-config] parallelGate.maxConcurrentReview must be a positive integer (>=1), got ${m}, falling back to ${profileDefault.maxConcurrentReview}.`,
      );
      // Keep profileDefault.maxConcurrentReview
    } else {
      result.maxConcurrentReview = m;
    }
  }

  if (typeof r.broadGlobBlocks === 'boolean') {
    result.broadGlobBlocks = r.broadGlobBlocks;
  }

  return result;
}

/**
 * Compute audit configuration.
 *
 * @param profile      current workflow profile (already resolved by upstream resolveProfile)
 * @param projectRoot  project root path (base for reading .lattice/audit-config.json)
 */
export function resolveAuditConfig(profile: WorkflowProfile, projectRoot: string): AuditConfig {
  // 1. First compute profile defaults (only triggerWindow is tiered)
  const profileDefaults: AuditConfig = {
    auditTriggerWindow: PROFILE_TRIGGER_WINDOW[profile] ?? HARD_DEFAULTS.auditTriggerWindow,
    requireClaudeMdDiff: HARD_DEFAULTS.requireClaudeMdDiff,
    mode: HARD_DEFAULTS.mode,
    deprecatedGcThreshold: HARD_DEFAULTS.deprecatedGcThreshold,
    // §4.7: parallelGate is tiered per profile; carried on profileDefaults so the early
    // no-user-config return below also ships a populated gate config.
    parallelGate: { ...(PARALLEL_GATE_PROFILE_DEFAULTS[profile] ?? PARALLEL_GATE_PROFILE_DEFAULTS.balanced) },
  };

  // 2. Try reading project-level config (per-field override)
  const userOverrides = readUserConfig(projectRoot);
  if (!userOverrides) return profileDefaults;

  const merged: AuditConfig = { ...profileDefaults };

  if (typeof userOverrides.auditTriggerWindow === 'number' && Number.isFinite(userOverrides.auditTriggerWindow)) {
    const w = userOverrides.auditTriggerWindow;
    // Non-integer / <= 0 are invalid (0 makes bumped.doneSinceLastAudit < 0 always false, rendering the window meaningless)
    if (!Number.isInteger(w) || w <= 0) {
      console.warn(
        `[audit-config] auditTriggerWindow must be a positive integer (>=1), got ${w}, falling back to profile default (${profileDefaults.auditTriggerWindow}).`,
      );
      // Keep profileDefaults.auditTriggerWindow
    } else {
      merged.auditTriggerWindow = w;
    }
  }
  if (typeof userOverrides.requireClaudeMdDiff === 'boolean') {
    merged.requireClaudeMdDiff = userOverrides.requireClaudeMdDiff;
  }
  if (typeof userOverrides.deprecatedGcThreshold === 'number' && Number.isFinite(userOverrides.deprecatedGcThreshold)) {
    const t = userOverrides.deprecatedGcThreshold;
    if (!Number.isInteger(t) || t <= 0) {
      console.warn(
        `[audit-config] deprecatedGcThreshold must be a positive integer (>=1), got ${t}, falling back to default (${profileDefaults.deprecatedGcThreshold}).`,
      );
      // Keep profileDefaults.deprecatedGcThreshold
    } else {
      merged.deprecatedGcThreshold = t;
    }
  }
  if (typeof userOverrides.mode === 'string') {
    if (VALID_MODES.has(userOverrides.mode as AuditMode)) {
      merged.mode = userOverrides.mode as AuditMode;
    } else {
      console.warn(
        `[audit-config] invalid mode "${userOverrides.mode}" in ${LATTICE_DIR}/audit-config.json, falling back to "semi-auto".`,
      );
      merged.mode = 'semi-auto';
    }
  }

  // §4.7: the nested parallelGate object needs field-by-field validation (the flat path above
  // does not recurse). profileDefaults.parallelGate is always populated, so the non-null
  // assertion is sound.
  merged.parallelGate = resolveParallelGate(
    (userOverrides as { parallelGate?: unknown }).parallelGate,
    profileDefaults.parallelGate as ParallelGateConfig,
  );

  return merged;
}

/**
 * Read `.lattice/audit-config.json`.
 *   - File does not exist → return null (silent)
 *   - JSON parse failure → warn once + return null
 */
function readUserConfig(projectRoot: string): Partial<AuditConfig> | null {
  const path = [
    join(projectRoot, LATTICE_DIR, 'audit-config.json'),
  ].find((candidate) => existsSync(candidate));
  if (!path) return null;

  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn(`[audit-config] ${path} is not a JSON object, using profile defaults.`);
      return null;
    }
    return parsed as Partial<AuditConfig>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[audit-config] failed to parse ${path}: ${msg}. Falling back to profile defaults.`);
    return null;
  }
}

