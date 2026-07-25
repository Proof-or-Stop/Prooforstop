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

/** The ONLY §1.2 placeholder form: a WHOLE token that is exactly `${<name>}`. */
const EXACT_PLACEHOLDER = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

function argvPlaceholders(argvTemplate: unknown): string[] {
  if (!Array.isArray(argvTemplate)) return [];
  const names: string[] = [];
  for (const token of argvTemplate) {
    if (typeof token !== 'string') continue;
    const match = EXACT_PLACEHOLDER.exec(token);
    if (match) names.push(match[1]);
  }
  return names;
}

/**
 * §1.2: each `argvTemplate` token is EITHER a pure literal (contains NO `${`) OR
 * EXACTLY `${<name>}` (the whole token) — "no partial-token interpolation". A
 * token that CONTAINS `${` but is not the exact placeholder form (e.g.
 * `prefix-${script}`, `${}`, `${1bad}`) is an unsupported partial interpolation
 * and fails closed at config load (R3-1). Returns the offending tokens.
 */
function partialPlaceholderTokens(argvTemplate: unknown): string[] {
  if (!Array.isArray(argvTemplate)) return [];
  const bad: string[] = [];
  for (const token of argvTemplate) {
    if (typeof token !== 'string') continue;
    if (/\$\{/.test(token) && !EXACT_PLACEHOLDER.test(token)) bad.push(token);
  }
  return bad;
}

/**
 * §1.2 `cwd` is repo-relative. Mirrors the scope-contract path canonicalizer
 * (`repo-relative-v1`, scope-path-classifier.ts): a repo-relative path is a
 * NON-EMPTY string that is NOT absolute (no leading `/`, backslash-normalized)
 * and contains NO `..` traversal segment. The default cwd `.` is valid. Runtime
 * resolution against the repo root is fenced to W2e — this is a shape check.
 */
function isRepoRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  const slash = value.replace(/\\/g, '/');
  if (slash.startsWith('/')) return false; // absolute
  return slash.split('/').every((segment) => segment !== '..'); // no traversal
}

/** §1.2 toolchain `sha256` STRUCTURAL shape: a 64-char lowercase hex string. */
function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/**
 * §1.2 adapter `testCaseRefPattern` is an ANCHORED regex ("starts ^ ends $").
 * Both ends must be REAL anchors: a leading `^` cannot be escaped (nothing
 * precedes the first char), but a trailing `$` preceded by an ODD run of
 * backslashes is an escaped literal dollar — NOT an end anchor — and rejects.
 */
function isAnchoredPattern(pattern: string): boolean {
  if (!pattern.startsWith('^') || !pattern.endsWith('$')) return false;
  let backslashes = 0;
  for (let i = pattern.length - 2; i >= 0 && pattern[i] === '\\'; i -= 1) backslashes += 1;
  return backslashes % 2 === 0;
}

/**
 * Enumerate the REAL named-capture-group names of a `testCaseRefPattern`.
 *
 * Returns `null` when the pattern is not a string or does not compile as an
 * ECMAScript `u`-mode regex. Otherwise returns the set of named-capture names.
 *
 * A prior implementation textually scanned `RegExp.source` for `(?<name>`, which
 * wrongly matched a `(?<name>`-shaped sequence appearing INSIDE a character class
 * `[...]` (there it is literal characters, not a group) or after a backslash
 * escape (an escaped `\(` is a literal paren, not a group opener). That let a
 * captureless pattern pass the ">=1 named capture" check and let a `${name}` argv
 * placeholder resolve against a nonexistent capture.
 *
 * This walks the source deterministically: it SKIPS an escape and the char it
 * escapes (`\` + next), SKIPS the span of a character class (from an unescaped
 * `[` to the matching unescaped `]`), and only OUTSIDE both recognizes
 * `(?<name>` — where `name` is a `[A-Za-z_][A-Za-z0-9_]*` group-name identifier
 * (same charset as the §1.2 argv placeholder form) — as a real named capture.
 * `(?<=` / `(?<!` lookbehinds are naturally excluded because `=` / `!` are not
 * valid name-start characters.
 */
function patternCaptureNames(pattern: unknown): Set<string> | null {
  if (typeof pattern !== 'string') return null;
  try {
    new RegExp(pattern, 'u'); // fail closed on an uncompilable pattern
  } catch {
    return null;
  }
  const names = new Set<string>();
  const src = pattern;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNamePart = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  let inClass = false;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      i += 2; // skip the escape and the escaped character (literal, never a group)
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      i += 1;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      i += 1;
      continue;
    }
    // Outside a character class: a real named-capture opener is `(?<name>`.
    if (ch === '(' && src[i + 1] === '?' && src[i + 2] === '<' && isNameStart(src[i + 3] ?? '')) {
      let k = i + 4;
      while (k < src.length && isNamePart(src[k])) k += 1;
      if (src[k] === '>') {
        names.add(src.slice(i + 3, k));
        i = k + 1;
        continue;
      }
    }
    i += 1;
  }
  return names;
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
      const seenMatcherNames = new Set<string>();
      for (const entry of provided) {
        if (!isPlainObject(entry)) {
          add('red_evidence_policy_matcher_class_invalid', 'red_evidence_policy_matcher_class_invalid: matcherClassRegistry entry must be an object');
          continue;
        }
        if (typeof entry.name !== 'string' || entry.name.length === 0) {
          add('red_evidence_policy_matcher_class_name', 'red_evidence_policy_matcher_class_name: matcherClassRegistry entry requires a non-empty string name');
        } else if (seenMatcherNames.has(entry.name)) {
          add('red_evidence_policy_matcher_class_duplicate_name', `red_evidence_policy_matcher_class_duplicate_name: matcherClassRegistry name ${JSON.stringify(entry.name)} is not unique (§1.2 unique registry key)`);
        } else {
          seenMatcherNames.add(entry.name);
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
      const seenAdapterIds = new Set<string>();
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
        // adapterId UNIQUE (§1.2 unique registry key).
        if (typeof entry.adapterId === 'string' && entry.adapterId.length > 0) {
          if (seenAdapterIds.has(entry.adapterId)) {
            add('red_evidence_policy_runner_adapter_duplicate_id', `red_evidence_policy_runner_adapter_duplicate_id: adapterId ${JSON.stringify(entry.adapterId)} is not unique (§1.2 unique registry key)`);
          } else {
            seenAdapterIds.add(entry.adapterId);
          }
        }
        for (const bad of forbiddenEnvKeyViolations(entry.allowedEnvKeys, forbiddenEnvKeysExtensions)) {
          add('red_evidence_policy_forbidden_env_key', `red_evidence_policy_forbidden_env_key: ${bad}`);
        }
        const captures = patternCaptureNames(entry.testCaseRefPattern);
        if (entry.testCaseRefPattern !== undefined && captures === null) {
          add('red_evidence_policy_invalid_test_case_ref_pattern', `red_evidence_policy_invalid_test_case_ref_pattern: ${JSON.stringify(entry.testCaseRefPattern)} is not a valid ECMAScript pattern`);
        }
        // §1.2 testCaseRefPattern MUST be anchored (^...$). A compilable but
        // UNANCHORED pattern would match a prefix/suffix and widen the config
        // surface — reject fail-closed (runtime matching stays W2e).
        if (typeof entry.testCaseRefPattern === 'string' && captures !== null && !isAnchoredPattern(entry.testCaseRefPattern)) {
          add('red_evidence_policy_test_case_ref_pattern_unanchored', `red_evidence_policy_test_case_ref_pattern_unanchored: ${JSON.stringify(entry.testCaseRefPattern)} is not anchored (must start ^ and end with an unescaped $)`);
        }
        // §1.2 testCaseRefPattern is compiled "with NAMED capture groups"; a
        // captureless pattern makes testCaseRef identification meaningless, so a
        // pattern with ZERO named capture groups fails closed (R3-3).
        if (typeof entry.testCaseRefPattern === 'string' && captures !== null && captures.size === 0) {
          add('red_evidence_policy_test_case_ref_pattern_no_capture', `red_evidence_policy_test_case_ref_pattern_no_capture: ${JSON.stringify(entry.testCaseRefPattern)} has no named capture group (§1.2 requires >=1 named capture)`);
        }
        // §1.2 adapter cwd is repo-relative (governs the exercised run).
        if (typeof entry.cwd === 'string' && !isRepoRelativePath(entry.cwd)) {
          add('red_evidence_policy_runner_adapter_cwd_not_repo_relative', `red_evidence_policy_runner_adapter_cwd_not_repo_relative: adapter cwd ${JSON.stringify(entry.cwd)} must be a non-empty repo-relative path (not absolute, no ".." segment)`);
        }
        // §1.2 "no partial-token interpolation": a token containing ${ that is
        // not the exact ${name} placeholder fails closed (R3-1).
        for (const partial of partialPlaceholderTokens(entry.argvTemplate)) {
          add('red_evidence_policy_argv_partial_placeholder', `red_evidence_policy_argv_partial_placeholder: argvTemplate token ${JSON.stringify(partial)} is neither a pure literal nor the exact placeholder form (partial-token interpolation is unsupported, §1.2)`);
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
      const seenProfileIds = new Set<string>();
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
        // §1.2 each prepCommands entry is executed directly as an argv array with
        // NO shell — argv[0] is the command, so an EMPTY argv is unexecutable and
        // fails closed with a distinct diagnostic (R3-4). (Type/string-element
        // checks live in the schema block above.)
        if (Array.isArray(entry.prepCommands)) {
          for (const cmd of entry.prepCommands) {
            if (Array.isArray(cmd) && cmd.length === 0) {
              add('red_evidence_policy_runner_profile_prep_command_empty', 'red_evidence_policy_runner_profile_prep_command_empty: each prepCommands entry must be a NON-EMPTY argv array (argv[0] is the command)');
            }
          }
        }
        // §1.2 profile cwd is repo-relative (governs prep commands).
        if (typeof entry.cwd === 'string' && !isRepoRelativePath(entry.cwd)) {
          add('red_evidence_policy_runner_profile_cwd_not_repo_relative', `red_evidence_policy_runner_profile_cwd_not_repo_relative: profile cwd ${JSON.stringify(entry.cwd)} must be a non-empty repo-relative path (not absolute, no ".." segment)`);
        }
        // runnerProfileId UNIQUE (§1.2 unique registry key).
        if (typeof entry.runnerProfileId === 'string' && entry.runnerProfileId.length > 0) {
          if (seenProfileIds.has(entry.runnerProfileId)) {
            add('red_evidence_policy_runner_profile_duplicate_id', `red_evidence_policy_runner_profile_duplicate_id: runnerProfileId ${JSON.stringify(entry.runnerProfileId)} is not unique (§1.2 unique registry key)`);
          } else {
            seenProfileIds.add(entry.runnerProfileId);
          }
        }
        for (const bad of forbiddenEnvKeyViolations(entry.allowedEnvKeys, forbiddenEnvKeysExtensions)) {
          add('red_evidence_policy_forbidden_env_key', `red_evidence_policy_forbidden_env_key: ${bad}`);
        }
        // §1.2 optional `toolchain`: STRUCTURAL shape only — an object mapping each
        // non-empty argv0 to `{ absolutePath (absolute string), sha256 (string) }`.
        // The runtime resolve-real-path + sha256 MATCH is fenced to W2e; here we
        // only reject a malformed shape at config load (R2-CX1).
        if ('toolchain' in entry && entry.toolchain !== undefined) {
          const tc = entry.toolchain;
          if (!isPlainObject(tc)) {
            add('red_evidence_policy_runner_profile_toolchain_not_object', `red_evidence_policy_runner_profile_toolchain_not_object: toolchain must be an object mapping argv0 -> {absolutePath, sha256}, got ${JSON.stringify(tc)}`);
          } else {
            for (const [argv0, spec] of Object.entries(tc)) {
              const absolutePath = isPlainObject(spec) ? spec.absolutePath : undefined;
              const sha256 = isPlainObject(spec) ? spec.sha256 : undefined;
              if (argv0.length === 0 || !isPlainObject(spec) || typeof absolutePath !== 'string' || typeof sha256 !== 'string') {
                add('red_evidence_policy_runner_profile_toolchain_entry', `red_evidence_policy_runner_profile_toolchain_entry: toolchain[${JSON.stringify(argv0)}] must be a non-empty argv0 mapping to {absolutePath: string, sha256: string}`);
                continue;
              }
              // STRUCTURAL: absolutePath must be an absolute path string. The file
              // is NOT resolved and the sha256 is NOT verified here (that is W2e).
              if (!isAbsolutePosix(absolutePath)) {
                add('red_evidence_policy_runner_profile_toolchain_absolute_path', `red_evidence_policy_runner_profile_toolchain_absolute_path: toolchain[${JSON.stringify(argv0)}].absolutePath ${JSON.stringify(absolutePath)} must be absolute`);
              }
              // STRUCTURAL: sha256 must be a 64-char lowercase hex string. The
              // digest is NOT matched against the file here (that is W2e).
              if (!isSha256Hex(sha256)) {
                add('red_evidence_policy_runner_profile_toolchain_sha256', `red_evidence_policy_runner_profile_toolchain_sha256: toolchain[${JSON.stringify(argv0)}].sha256 ${JSON.stringify(sha256)} must be a 64-char lowercase hex string`);
              }
            }
          }
        }
      }
      runnerProfileRegistry = provided as RunnerProfile[];
    }
  }

  // ── cross-registry: every adapter.runnerProfileId references a registered ───
  // profile (§1.2 "the profile this adapter selects"). Uses the RESOLVED profile
  // registry (provided override or default) so a same-override profile counts.
  {
    const registeredProfileIds = new Set<string>();
    for (const profile of runnerProfileRegistry) {
      if (isPlainObject(profile) && typeof profile.runnerProfileId === 'string' && profile.runnerProfileId.length > 0) {
        registeredProfileIds.add(profile.runnerProfileId);
      }
    }
    for (const adapter of runnerAdapterRegistry) {
      if (isPlainObject(adapter) && typeof adapter.runnerProfileId === 'string' && adapter.runnerProfileId.length > 0
        && !registeredProfileIds.has(adapter.runnerProfileId)) {
        add('red_evidence_policy_runner_adapter_unknown_profile', `red_evidence_policy_runner_adapter_unknown_profile: adapter runnerProfileId ${JSON.stringify(adapter.runnerProfileId)} references no registered runnerProfileRegistry entry`);
      }
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
