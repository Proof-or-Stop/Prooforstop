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

export type AuditMode = 'semi-auto' | 'full-auto' | 'off';

export interface AuditConfig {
  auditTriggerWindow: number;
  requireClaudeMdDiff: boolean;
  mode: AuditMode;
  deprecatedGcThreshold: number;
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

