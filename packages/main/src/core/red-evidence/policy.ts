// §1.2 / §1.12 fail-closed RED-evidence policy resolver (W2a / B-c054).
//
// Spec: docs/requirements/decisions/red-evidence-subsystem-spec.md §1.2 (the
// exhaustive 14-key policySnapshot + defaults), §1.12 (hard, non-tunable safety
// floors that clamp-REJECT rather than silently clamp). This resolver is
// DIAGNOSTIC ONLY: it validates a policy block and computes its `policyDigest`
// via §0.4 CANON. It performs NO runtime execution and resolves NO executable —
// runner/envelope wiring is fenced to W2e.
//
// Assurance scope (§0.6 practical tier): fail-closed config-load rejection
// guards against accidental mis-policy, workflow drift, and casual gaming
// through the registered surfaces. It does not defend against a hostile local
// agent with filesystem/toolchain control — that adversary is the Tier-C
// program's, not W2's.

import { canonDigest } from './canon.js';
import {
  DEFAULT_FORBIDDEN_CATCH_ALLS,
  DEFAULT_INVARIANCE_EXCLUDE_PATHS,
  DEFAULT_POLICY_SCALARS,
  FORBIDDEN_ENV_KEYS,
  HARD_FLOORS,
  MATCHER_CLASS_PREDICATE_KINDS,
  POLICY_SNAPSHOT_KEYS,
  defaultMatcherClassRegistry,
  defaultRunnerAdapterRegistry,
  defaultRunnerProfileRegistry,
  type MatcherClass,
  type RunnerAdapter,
  type RunnerProfile,
} from './registries.js';

export interface RedEvidencePolicySnapshot {
  maxMatchers: number;
  maxMatcherLen: number;
  minMatcherLen: number;
  minMatcherEntropyBits: number;
  runTimeoutMs: number;
  prepTimeoutMs: number;
  killGraceMs: number;
  forbiddenCatchAlls: string[];
  forbiddenEnvKeysExtensions: string[];
  invarianceExcludePaths: string[];
  pinnedPath: string[];
  matcherClassRegistry: MatcherClass[];
  runnerAdapterRegistry: RunnerAdapter[];
  runnerProfileRegistry: RunnerProfile[];
}

/** A single fail-closed rejection reason. `code` is stable and DISTINCT per floor/rule. */
export interface PolicyDiagnostic {
  code: string;
  message: string;
}

export type ResolveRedEvidencePolicyResult =
  | { ok: true; snapshot: RedEvidencePolicySnapshot; policyDigest: string; diagnostics: [] }
  | { ok: false; diagnostics: PolicyDiagnostic[]; snapshot?: undefined; policyDigest?: undefined };

export interface ResolveContext {
  /**
   * The LIVE tracked-material paths (repo-relative, slash-normalized) used for
   * the §1.12 invarianceExcludePaths material-overlap check. When omitted, only
   * the bare-catch-all check runs (the material-overlap direction needs the
   * caller's live classification).
   */
  trackedMaterialPaths?: string[];
}

const SCALAR_KEYS = [
  'maxMatchers',
  'maxMatcherLen',
  'minMatcherLen',
  'minMatcherEntropyBits',
  'runTimeoutMs',
  'prepTimeoutMs',
  'killGraceMs',
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAbsolutePosix(entry: string): boolean {
  // §1.12: pinnedPath entries are absolute directories. POSIX absolute = leading
  // '/'. A '.'-prefixed or bare-relative entry (or empty string) fails closed.
  return entry.startsWith('/');
}

/** All-wildcard glob (every segment is `*` or `**`) — a §1.12 bare catch-all. */
function isBareCatchAll(glob: string): boolean {
  const segments = glob.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) return true;
  return segments.every((segment) => segment === '*' || segment === '**');
}

/** Segment-aware glob -> anchored RegExp: `**` spans `/`, `*` stays within a segment. */
function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          // `**/` matches zero-or-more path segments INCLUDING zero, so a glob
          // like `**/*.ts` matches a ROOT-LEVEL `foo.ts` as well as `a/b/foo.ts`.
          // (The old `.*` + literal `/` required at least one slash and thus
          // fail-open-skipped root-level tracked material — F-CX2.)
          source += '(?:.*/)?';
          i += 2; // consume the second '*' and the '/'
        } else {
          source += '.*';
          i += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if ('\\^$.|?+()[]{}'.includes(ch)) {
      source += `\\${ch}`;
    } else {
      source += ch;
    }
  }
  return new RegExp(`^${source}$`);
}

/** Deep-freeze `value` in place (arrays + nested plain objects) and return it. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function forbiddenEnvKeyViolations(keys: unknown, extensions: string[]): string[] {
  if (!Array.isArray(keys)) return [];
  const violations: string[] = [];
  for (const key of keys) {
    if (typeof key !== 'string') continue;
    // Env var names are case-sensitive on POSIX, so the forbidden set is matched
    // case-sensitively (a lowercase `path` is NOT the forbidden `PATH`).
    if (FORBIDDEN_ENV_KEYS.includes(key) || key.startsWith('DYLD_') || extensions.includes(key)) {
      violations.push(key);
    }
  }
  return violations;
}

function argvPlaceholders(argvTemplate: unknown): string[] {
  if (!Array.isArray(argvTemplate)) return [];
  const names: string[] = [];
  for (const token of argvTemplate) {
    if (typeof token !== 'string') continue;
    const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(token);
    if (match) names.push(match[1]);
  }
  return names;
}

function patternCaptureNames(pattern: unknown): Set<string> | null {
  if (typeof pattern !== 'string') return null;
  try {
    const compiled = new RegExp(pattern, 'u');
    const names = new Set<string>();
    const rx = /\(\?<([A-Za-z_][A-Za-z0-9_]*)>/g;
    let match: RegExpExecArray | null;
    while ((match = rx.exec(compiled.source)) !== null) names.add(match[1]);
    return names;
  } catch {
    return null;
  }
}

/**
 * Resolve a `redEvidence` policy block into the exhaustive 14-key policySnapshot
 * and its `policyDigest`, or a fail-closed rejection carrying one DISTINCT named
 * diagnostic per violated rule. Never silently clamps and never substitutes a
 * default for the required `pinnedPath`.
 */
export function resolveRedEvidencePolicy(
  block: unknown,
  ctx: ResolveContext = {},
): ResolveRedEvidencePolicyResult {
  const diagnostics: PolicyDiagnostic[] = [];
  const add = (code: string, message: string): void => {
    diagnostics.push({ code, message });
  };

  if (block !== undefined && block !== null && !isPlainObject(block)) {
    return {
      ok: false,
      diagnostics: [
        { code: 'red_evidence_policy_invalid_block', message: 'red_evidence_policy_invalid_block: redEvidence block must be a JSON object' },
      ],
    };
  }
  const b: Record<string, unknown> = isPlainObject(block) ? block : {};

  // Unknown keys fail closed (consistent with the W1 resolver contract, §1.2).
  const allowed = new Set<string>(POLICY_SNAPSHOT_KEYS as readonly string[]);
  for (const key of Object.keys(b)) {
    if (!allowed.has(key)) add('red_evidence_policy_unknown_key', `red_evidence_policy_unknown_key: ${key}`);
  }

  // ── scalars + §1.12 hard floors (clamp-REJECT, never clamp) ────────────────
  const scalar: Record<string, number> = { ...DEFAULT_POLICY_SCALARS };
  for (const key of SCALAR_KEYS) {
    if (!(key in b)) continue;
    const value = b[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      add('red_evidence_policy_invalid_type', `red_evidence_policy_invalid_type: ${key} must be a finite number`);
      continue;
    }
    scalar[key] = value;
  }
  if (scalar.minMatcherLen < HARD_FLOORS.minMatcherLenMin) {
    add('red_evidence_policy_floor_min_matcher_len', `red_evidence_policy_floor_min_matcher_len: minMatcherLen=${scalar.minMatcherLen} is below the §1.12 floor of ${HARD_FLOORS.minMatcherLenMin}`);
  }
  if (scalar.minMatcherEntropyBits < HARD_FLOORS.minMatcherEntropyBitsMin) {
    add('red_evidence_policy_floor_min_matcher_entropy_bits', `red_evidence_policy_floor_min_matcher_entropy_bits: minMatcherEntropyBits=${scalar.minMatcherEntropyBits} is below the §1.12 floor of ${HARD_FLOORS.minMatcherEntropyBitsMin}`);
  }
  if (scalar.maxMatchers > HARD_FLOORS.maxMatchersMax) {
    add('red_evidence_policy_cap_max_matchers', `red_evidence_policy_cap_max_matchers: maxMatchers=${scalar.maxMatchers} exceeds the §1.12 cap of ${HARD_FLOORS.maxMatchersMax}`);
  }
  if (scalar.maxMatcherLen > HARD_FLOORS.maxMatcherLenMax) {
    add('red_evidence_policy_cap_max_matcher_len', `red_evidence_policy_cap_max_matcher_len: maxMatcherLen=${scalar.maxMatcherLen} exceeds the §1.12 cap of ${HARD_FLOORS.maxMatcherLenMax}`);
  }
  if (scalar.runTimeoutMs > HARD_FLOORS.timeoutMsMax) {
    add('red_evidence_policy_ceiling_run_timeout_ms', `red_evidence_policy_ceiling_run_timeout_ms: runTimeoutMs=${scalar.runTimeoutMs} exceeds the §1.12 one-hour ceiling of ${HARD_FLOORS.timeoutMsMax}`);
  }
  if (scalar.prepTimeoutMs > HARD_FLOORS.timeoutMsMax) {
    add('red_evidence_policy_ceiling_prep_timeout_ms', `red_evidence_policy_ceiling_prep_timeout_ms: prepTimeoutMs=${scalar.prepTimeoutMs} exceeds the §1.12 one-hour ceiling of ${HARD_FLOORS.timeoutMsMax}`);
  }

  // ── forbiddenCatchAlls: superset-only (§1.12) ──────────────────────────────
  let forbiddenCatchAlls: string[] = [...DEFAULT_FORBIDDEN_CATCH_ALLS];
  if ('forbiddenCatchAlls' in b) {
    const provided = b.forbiddenCatchAlls;
    if (!Array.isArray(provided) || provided.some((entry) => typeof entry !== 'string')) {
      add('red_evidence_policy_invalid_type', 'red_evidence_policy_invalid_type: forbiddenCatchAlls must be an array of strings');
    } else {
      const missing = DEFAULT_FORBIDDEN_CATCH_ALLS.filter((entry) => !provided.includes(entry));
      if (missing.length > 0) {
        add('red_evidence_policy_forbidden_catch_alls_shrink', `red_evidence_policy_forbidden_catch_alls_shrink: forbiddenCatchAlls must be a superset of the §1.2 default set; missing ${JSON.stringify(missing)}`);
      }
      forbiddenCatchAlls = provided as string[];
    }
  }

  // ── forbiddenEnvKeysExtensions (project additions to the hard forbidden set) ─
  let forbiddenEnvKeysExtensions: string[] = [];
  if ('forbiddenEnvKeysExtensions' in b) {
    const provided = b.forbiddenEnvKeysExtensions;
    if (!Array.isArray(provided) || provided.some((entry) => typeof entry !== 'string')) {
      add('red_evidence_policy_invalid_type', 'red_evidence_policy_invalid_type: forbiddenEnvKeysExtensions must be an array of strings');
    } else {
      forbiddenEnvKeysExtensions = provided as string[];
    }
  }

  // ── invarianceExcludePaths: no bare catch-all, no tracked-material overlap ──
  let invarianceExcludePaths: string[] = [...DEFAULT_INVARIANCE_EXCLUDE_PATHS];
  if ('invarianceExcludePaths' in b) {
    const provided = b.invarianceExcludePaths;
    if (!Array.isArray(provided) || provided.some((entry) => typeof entry !== 'string')) {
      add('red_evidence_policy_invalid_type', 'red_evidence_policy_invalid_type: invarianceExcludePaths must be an array of strings');
    } else {
      invarianceExcludePaths = provided as string[];
    }
  }
  const material = ctx.trackedMaterialPaths ?? [];
  for (const glob of invarianceExcludePaths) {
    if (isBareCatchAll(glob)) {
      add('red_evidence_policy_invariance_catch_all', `red_evidence_policy_invariance_catch_all: invarianceExcludePaths entry ${JSON.stringify(glob)} is a bare catch-all that would exclude all tracked material`);
      continue;
    }
    if (material.length > 0) {
      const re = globToRegExp(glob);
      if (material.some((path) => re.test(path))) {
        add('red_evidence_policy_invariance_matches_material', `red_evidence_policy_invariance_matches_material: invarianceExcludePaths entry ${JSON.stringify(glob)} matches a tracked material path`);
      }
    }
  }

  // ── pinnedPath: REQUIRED, NO DEFAULT (§1.2) ────────────────────────────────
  let pinnedPath: string[] = [];
  const rawPinned = b.pinnedPath;
  if (!('pinnedPath' in b) || rawPinned === null || (Array.isArray(rawPinned) && rawPinned.length === 0)) {
    add('red_evidence_policy_missing', 'red_evidence_policy_missing: pinnedPath');
  } else if (!Array.isArray(rawPinned)) {
    add('red_evidence_policy_pinned_path_not_absolute', `red_evidence_policy_pinned_path_not_absolute: pinnedPath must be an array of absolute directories, got ${JSON.stringify(rawPinned)}`);
  } else {
    for (const entry of rawPinned) {
      if (typeof entry !== 'string' || !isAbsolutePosix(entry)) {
        add('red_evidence_policy_pinned_path_not_absolute', `red_evidence_policy_pinned_path_not_absolute: pinnedPath entry ${JSON.stringify(entry)} is not an absolute directory`);
      }
    }
    pinnedPath = rawPinned as string[];
  }

  // ── matcherClassRegistry: closed predicateKind enum (§1.12) ────────────────
  let matcherClassRegistry: MatcherClass[] = defaultMatcherClassRegistry();
  if ('matcherClassRegistry' in b) {
    const provided = b.matcherClassRegistry;
    if (!Array.isArray(provided)) {
      add('red_evidence_policy_invalid_type', 'red_evidence_policy_invalid_type: matcherClassRegistry must be an array');
    } else {
      for (const entry of provided) {
        if (!isPlainObject(entry)) {
          add('red_evidence_policy_matcher_class_invalid', 'red_evidence_policy_matcher_class_invalid: matcherClassRegistry entry must be an object');
          continue;
        }
        if (typeof entry.name !== 'string' || entry.name.length === 0) {
          add('red_evidence_policy_matcher_class_name', 'red_evidence_policy_matcher_class_name: matcherClassRegistry entry requires a non-empty string name');
        }
        const kind = entry.predicateKind;
        if (typeof kind !== 'string' || !(MATCHER_CLASS_PREDICATE_KINDS as readonly string[]).includes(kind)) {
          add('red_evidence_policy_matcher_class_predicate_kind', `red_evidence_policy_matcher_class_predicate_kind: predicateKind ${JSON.stringify(kind)} is outside the closed §1.2 enum ${JSON.stringify(MATCHER_CLASS_PREDICATE_KINDS)}`);
          continue; // param/stream semantics are keyed on a known predicateKind
        }
        if (kind === 'exit-code-in') {
          const param = entry.param;
          if (
            !Array.isArray(param) ||
            param.length === 0 ||
            param.some((n) => !Number.isInteger(n) || (n as number) < 0 || (n as number) > 255) ||
            new Set(param).size !== param.length
          ) {
            add('red_evidence_policy_matcher_class_param', 'red_evidence_policy_matcher_class_param: exit-code-in requires a non-empty array of UNIQUE integers in 0..255');
          }
          // exit classes consult no stream; a declared stream must be "combined".
          if (entry.stream !== undefined && entry.stream !== 'combined') {
            add('red_evidence_policy_matcher_class_stream', `red_evidence_policy_matcher_class_stream: exit-code-in stream must be "combined" (or absent), got ${JSON.stringify(entry.stream)}`);
          }
        } else if (entry.param !== undefined) {
          // stream-nonempty / stream-empty forbid param entirely.
          add('red_evidence_policy_matcher_class_param', `red_evidence_policy_matcher_class_param: ${kind} forbids param (present ⇒ config-load reject)`);
        }
      }
      matcherClassRegistry = provided as MatcherClass[];
    }
  }

  // ── runnerAdapterRegistry: allowlist + argv-placeholder resolution ─────────
  let runnerAdapterRegistry: RunnerAdapter[] = defaultRunnerAdapterRegistry();
  if ('runnerAdapterRegistry' in b) {
    const provided = b.runnerAdapterRegistry;
    if (!Array.isArray(provided)) {
      add('red_evidence_policy_invalid_type', 'red_evidence_policy_invalid_type: runnerAdapterRegistry must be an array');
    } else {
      for (const entry of provided) {
        if (!isPlainObject(entry)) {
          add('red_evidence_policy_runner_adapter_invalid', 'red_evidence_policy_runner_adapter_invalid: runnerAdapterRegistry entry must be an object');
          continue;
        }
        // §1.2 adapter schema — every field is required and fail-closed.
        const missingAdapter: string[] = [];
        if (typeof entry.adapterId !== 'string' || entry.adapterId.length === 0) missingAdapter.push('adapterId');
        if (typeof entry.runnerProfileId !== 'string' || entry.runnerProfileId.length === 0) missingAdapter.push('runnerProfileId');
        if (typeof entry.testCaseRefPattern !== 'string') missingAdapter.push('testCaseRefPattern');
        if (!Array.isArray(entry.argvTemplate) || entry.argvTemplate.length === 0 || entry.argvTemplate.some((tok) => typeof tok !== 'string')) missingAdapter.push('argvTemplate');
        if (!Array.isArray(entry.allowedEnvKeys) || entry.allowedEnvKeys.some((k) => typeof k !== 'string')) missingAdapter.push('allowedEnvKeys');
        if (typeof entry.cwd !== 'string') missingAdapter.push('cwd');
        if (entry.linkageKind !== 'reporter-event' && entry.linkageKind !== 'script-exit') missingAdapter.push('linkageKind');
        if (missingAdapter.length > 0) {
          add('red_evidence_policy_runner_adapter_schema', `red_evidence_policy_runner_adapter_schema: runnerAdapterRegistry entry has invalid/missing required fields ${JSON.stringify(missingAdapter)}`);
        }
        for (const bad of forbiddenEnvKeyViolations(entry.allowedEnvKeys, forbiddenEnvKeysExtensions)) {
          add('red_evidence_policy_forbidden_env_key', `red_evidence_policy_forbidden_env_key: ${bad}`);
        }
        const captures = patternCaptureNames(entry.testCaseRefPattern);
        if (entry.testCaseRefPattern !== undefined && captures === null) {
          add('red_evidence_policy_invalid_test_case_ref_pattern', `red_evidence_policy_invalid_test_case_ref_pattern: ${JSON.stringify(entry.testCaseRefPattern)} is not a valid ECMAScript pattern`);
        }
        for (const placeholder of argvPlaceholders(entry.argvTemplate)) {
          if (!captures || !captures.has(placeholder)) {
            add('red_evidence_policy_argv_unresolved_placeholder', `red_evidence_policy_argv_unresolved_placeholder: \${${placeholder}} names no capture in testCaseRefPattern`);
          }
        }
      }
      runnerAdapterRegistry = provided as RunnerAdapter[];
    }
  }

  // ── runnerProfileRegistry: allowlist forbidden-key check ───────────────────
  let runnerProfileRegistry: RunnerProfile[] = defaultRunnerProfileRegistry();
  if ('runnerProfileRegistry' in b) {
    const provided = b.runnerProfileRegistry;
    if (!Array.isArray(provided)) {
      add('red_evidence_policy_invalid_type', 'red_evidence_policy_invalid_type: runnerProfileRegistry must be an array');
    } else {
      for (const entry of provided) {
        if (!isPlainObject(entry)) {
          add('red_evidence_policy_runner_profile_invalid', 'red_evidence_policy_runner_profile_invalid: runnerProfileRegistry entry must be an object');
          continue;
        }
        // §1.2 profile schema — every field is required and fail-closed.
        const missingProfile: string[] = [];
        if (typeof entry.runnerProfileId !== 'string' || entry.runnerProfileId.length === 0) missingProfile.push('runnerProfileId');
        if (!Array.isArray(entry.prepCommands) || entry.prepCommands.some((cmd) => !Array.isArray(cmd) || cmd.some((a) => typeof a !== 'string'))) missingProfile.push('prepCommands');
        if (!Array.isArray(entry.allowedEnvKeys) || entry.allowedEnvKeys.some((k) => typeof k !== 'string')) missingProfile.push('allowedEnvKeys');
        if (typeof entry.cwd !== 'string') missingProfile.push('cwd');
        if (typeof entry.submodules !== 'boolean') missingProfile.push('submodules');
        if (missingProfile.length > 0) {
          add('red_evidence_policy_runner_profile_schema', `red_evidence_policy_runner_profile_schema: runnerProfileRegistry entry has invalid/missing required fields ${JSON.stringify(missingProfile)}`);
        }
        for (const bad of forbiddenEnvKeyViolations(entry.allowedEnvKeys, forbiddenEnvKeysExtensions)) {
          add('red_evidence_policy_forbidden_env_key', `red_evidence_policy_forbidden_env_key: ${bad}`);
        }
      }
      runnerProfileRegistry = provided as RunnerProfile[];
    }
  }

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  const snapshot: RedEvidencePolicySnapshot = {
    maxMatchers: scalar.maxMatchers,
    maxMatcherLen: scalar.maxMatcherLen,
    minMatcherLen: scalar.minMatcherLen,
    minMatcherEntropyBits: scalar.minMatcherEntropyBits,
    runTimeoutMs: scalar.runTimeoutMs,
    prepTimeoutMs: scalar.prepTimeoutMs,
    killGraceMs: scalar.killGraceMs,
    forbiddenCatchAlls,
    forbiddenEnvKeysExtensions,
    invarianceExcludePaths,
    pinnedPath,
    matcherClassRegistry,
    runnerAdapterRegistry,
    runnerProfileRegistry,
  };
  // §0.6 casual-mutation tier: deep-freeze so a post-resolution mutation (e.g.
  // adding a 15th key) cannot silently stale the precomputed policyDigest — it
  // throws in strict mode. Freezing does NOT change enumerable own properties, so
  // the CANON bytes and policyDigest are byte-identical to the unfrozen snapshot.
  const frozen = deepFreeze(snapshot);
  return { ok: true, snapshot: frozen, policyDigest: canonDigest(frozen), diagnostics: [] };
}

/**
 * Render the single, non-gating red-evidence health line for `lattice doctor`.
 * Returns the resolved `policyDigest` when a valid block is present, else the
 * fail-closed diagnostic. Never throws (doctor is not a gate); an unexpected
 * error degrades to a scan-error diagnostic. The rendered line contains the
 * substring "Red-evidence" exactly once.
 */
export function resolveRedEvidenceDoctorLine(block: unknown, ctx: ResolveContext = {}): string {
  const prefix = 'Red-evidence policy: ';
  const suffix = ' (advisory only; doctor is not a gate)';
  try {
    const result = resolveRedEvidencePolicy(block, ctx);
    if (result.ok) return `${prefix}${result.policyDigest}${suffix}`;
    const first = result.diagnostics[0];
    return `${prefix}${first ? first.message : 'red_evidence_policy_invalid'}${suffix}`;
  } catch {
    return `${prefix}red_evidence_policy_scan_error${suffix}`;
  }
}
