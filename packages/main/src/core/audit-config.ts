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
 * Render an arbitrary invalid value for a warning message WITHOUT ever throwing.
 * `JSON.stringify` throws on `bigint`, circular references, and throwing `toJSON`
 * getters — and this runs on the present-but-invalid path, whose contract is
 * warn+fallback, never crash. bigint is handled first (JSON can't serialize it).
 * The last-resort fallback `Object.prototype.toString.call` is ALSO fallible — it
 * reads `Symbol.toStringTag`, which throws for a revoked Proxy or a throwing
 * `@@toStringTag` getter — so it is nested in its own try/catch ending in a
 * constant. Every branch is therefore total.
 */
function describeInvalidValue(value: unknown): string {
  if (typeof value === 'bigint') return `${value}n`;
  try {
    // JSON.stringify(undefined) / (function) returns undefined — coalesce to String().
    return JSON.stringify(value) ?? String(value);
  } catch {
    try {
      return Object.prototype.toString.call(value);
    } catch {
      return '<unserializable>';
    }
  }
}

/**
 * Resolve the nested `parallelGate` config (spec §4.7). Unlike the flat scalar fields, the
 * nested object must be validated field-by-field — the flat per-scalar override path does not
 * recurse, so copying it would silently skip every sub-field check. Each sub-field guards and
 * falls back individually; a missing or non-object `raw` yields the full profile default.
 * `mode` validates against VALID_PARALLEL_MODES (NOT VALID_MODES, which is ReadonlySet<AuditMode>)
 * and an invalid value degrades to advise (safe, non-blocking). Two-param form (raw +
 * explicit profileDefault) keeps the helper pure and decoupled from the profile table (OQ-001).
 * Presence is tested with Object.hasOwn (own keys only — an inherited/prototype-shaped sub-field
 * never overrides a default), and the present-but-invalid path never throws (invalid values are
 * rendered via describeInvalidValue, so a bigint/circular config value still warn+falls-back).
 * The function is TOTAL: the field reader runs inside a try/catch wrapper, so even a raw that
 * cannot be introspected at all (a revoked Proxy) degrades to the profile default instead of
 * crashing the PLAN→DEV gate.
 */
export function resolveParallelGate(raw: unknown, profileDefault: ParallelGateConfig): ParallelGateConfig {
  try {
    return readParallelGateFields(raw, profileDefault);
  } catch (err) {
    // Defense-in-depth last resort. `raw` is normally a JSON-parsed value, so in practice this
    // never fires — but the function is exported with a never-throw contract, and introspecting a
    // hostile/revoked Proxy can make Array.isArray, Object.hasOwn, or a property read throw. A
    // config read must NEVER crash the PLAN→DEV gate, so any introspection failure degrades to the
    // profile default. (readParallelGateFields' per-field describeInvalidValue path is itself
    // total, so this only catches a raw that cannot be inspected at all, not ordinary invalid
    // sub-field values, which still get their granular per-field warn + fallback.)
    //
    // The caught `err` is itself rendered with describeInvalidValue (NOT `instanceof`/`message`/
    // `String`): a hostile trap can THROW a revoked Proxy, and `err instanceof Error`
    // ([[GetPrototypeOf]]) or `String(err)` (ToPrimitive) would themselves throw on it. Routing
    // every untrusted-input rendering through the one total primitive keeps this catch total too.
    console.warn(
      `[audit-config] parallelGate config could not be introspected (${describeInvalidValue(err)}); using profile default.`,
    );
    return { ...profileDefault };
  }
}

/** Field-by-field reader for resolveParallelGate. May throw only on an exotic, non-JSON `raw`
 *  (e.g. a revoked Proxy) whose introspection fails — the exported wrapper catches that. */
function readParallelGateFields(raw: unknown, profileDefault: ParallelGateConfig): ParallelGateConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...profileDefault };
  }
  const r = raw as Record<string, unknown>;
  const result: ParallelGateConfig = { ...profileDefault };

  // For each sub-field, distinguish a PRESENT-but-invalid value (warn + fallback) from an
  // ABSENT key (keep the profile default). A present-but-wrong-TYPE value is invalid, not
  // missing — e.g. mode: 123 under the strict profile must degrade to advise, never silently
  // keep block. Presence is tested with Object.hasOwn (NOT `key in r`): a `key in r` check
  // walks the prototype chain, so an Object.create({mode:'block',...})-shaped raw with no OWN
  // keys would silently override profile defaults — turning balanced/light into block with no
  // warn, violating the absent-key-keeps-profile-default invariant. An OWN `undefined` is still
  // present-invalid (hasOwn true, fails the type guard → warn + fallback).
  if (Object.hasOwn(r, 'mode')) {
    const mode = r.mode; // read once — a hostile getter must not differ between guard and assign
    if (typeof mode === 'string' && VALID_PARALLEL_MODES.has(mode as ParallelGateMode)) {
      result.mode = mode as ParallelGateMode;
    } else {
      console.warn(
        `[audit-config] invalid parallelGate.mode ${describeInvalidValue(mode)}, falling back to "${PARALLEL_MODE_FALLBACK}".`,
      );
      result.mode = PARALLEL_MODE_FALLBACK; // advise is non-blocking — never hard-block on a bad config value
    }
  }

  if (Object.hasOwn(r, 'maxConcurrentReview')) {
    const m = r.maxConcurrentReview;
    if (typeof m === 'number' && Number.isInteger(m) && m > 0) {
      result.maxConcurrentReview = m;
    } else {
      console.warn(
        `[audit-config] parallelGate.maxConcurrentReview must be a positive integer (>=1), got ${describeInvalidValue(m)}, falling back to ${profileDefault.maxConcurrentReview}.`,
      );
      // Keep profileDefault.maxConcurrentReview
    }
  }

  if (Object.hasOwn(r, 'broadGlobBlocks')) {
    const broadGlobBlocks = r.broadGlobBlocks; // read once — guard and assign must see the same value
    if (typeof broadGlobBlocks === 'boolean') {
      result.broadGlobBlocks = broadGlobBlocks;
    } else {
      console.warn(
        `[audit-config] parallelGate.broadGlobBlocks must be a boolean, got ${describeInvalidValue(broadGlobBlocks)}, falling back to ${profileDefault.broadGlobBlocks}.`,
      );
      // Keep profileDefault.broadGlobBlocks
    }
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
  // does not recurse). profileDefaults.parallelGate is always populated (set unconditionally
  // above), so the non-null assertion (`!`, which only strips `undefined` and keeps shape
  // checking — narrower than an `as` cast) is sound.
  merged.parallelGate = resolveParallelGate(
    (userOverrides as { parallelGate?: unknown }).parallelGate,
    profileDefaults.parallelGate!,
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

