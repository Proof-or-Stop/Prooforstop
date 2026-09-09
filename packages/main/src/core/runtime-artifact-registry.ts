/**
 * Runtime-artifact registry — the single source for "which paths are runtime
 * state" (materialHash exclusion, volatility, gitignore patterns, repairability).
 *
 * B-cc10 CHK-007: every state-directory path below is DERIVED from
 * `core/brand-paths.ts` instead of spelling `.proof-or-stop/` literally, and each
 * derivation expands to BOTH accepted spellings.
 *
 * WHY THIS IS A CORRECTNESS FIX, NOT A COSMETIC ONE
 * -------------------------------------------------
 * `listRuntimeArtifactIgnorePatterns()` is what generates the managed
 * `# proof-or-stop runtime artifacts (managed)` block in `.gitignore`. While every
 * entry here was pinned to the DEPRECATED spelling, the runtime wrote to the
 * CANONICAL directory that no pattern covered. Measured before this fix:
 *
 *     git check-ignore .proof-or-stop/locks/x        -> ignored (.gitignore:28)
 *     git check-ignore .proof-or-stop/locks/x  -> NOT ignored
 *
 * so `validate-execution-lock-smoke` failed with `unexpected_dirty_files=2` on
 * `.proof-or-stop/locks/validation-capacity.lock/...`: the capacity lock is
 * runtime state that the dirty-tree classifier could no longer recognize. The
 * same latent break applied to materialHash exclusion — a runtime write under
 * the canonical directory would have been INCLUDED in the digest, silently
 * changing what an evidence hash means (the exact hazard `core/brand-paths.ts`
 * documents for `isStoryMetadataPath`).
 *
 * Deriving BOTH spellings is deliberate and mirrors the read-both contract: an
 * un-migrated checkout still has runtime state under the deprecated directory,
 * so dropping that spelling would strand it as unexplained dirt.
 */
import {
  PROOF_OR_STOP_STATE_DIR,
  STATE_DIR_NAMES,
} from './brand-paths.js';

export type RuntimeArtifactPathMatcher =
  | { kind: 'exact'; value: string }
  | { kind: 'prefix'; value: string }
  | { kind: 'regexp'; value: RegExp };

/**
 * Expand a state-dir-relative tail into one `exact` matcher per accepted
 * spelling, canonical first.
 *
 * Callers never write the directory name, so a future rename cannot leave a
 * matcher recognizing only one spelling — the F-065/F-061 shape that
 * `core/brand-paths.ts` exists to prevent.
 */
function stateDirExact(tail: string): RuntimeArtifactPathMatcher[] {
  return STATE_DIR_NAMES.map((dir) => ({ kind: 'exact' as const, value: `${dir}/${tail}` }));
}

/** Same expansion for `prefix` matchers. */
function stateDirPrefix(tail: string): RuntimeArtifactPathMatcher[] {
  return STATE_DIR_NAMES.map((dir) => ({ kind: 'prefix' as const, value: `${dir}/${tail}` }));
}

/**
 * Ignore patterns for a state-dir-relative tail, one per accepted spelling.
 *
 * Both spellings are emitted into `.gitignore` on purpose: git silently ignores
 * a pattern for a directory that does not exist, so listing the deprecated name
 * costs nothing on a migrated checkout while still covering an unmigrated one.
 */
function stateDirIgnore(tail: string): string[] {
  return STATE_DIR_NAMES.map((dir) => `${dir}/${tail}`);
}

export interface RuntimeArtifactRegistryEntry {
  id: string;
  description: string;
  matchers: RuntimeArtifactPathMatcher[];
  ignorePatterns: string[];
  materialHash: 'exclude' | 'include';
  volatile: boolean;
  repairableTrackedArtifact: boolean;
}

export const PROOF_OR_STOP_RUNTIME_IGNORE_BLOCK_START = '# proof-or-stop runtime artifacts (managed)';
export const PROOF_OR_STOP_RUNTIME_IGNORE_BLOCK_END = '# /proof-or-stop runtime artifacts (managed)';

function rx(value: string): RegExp {
  return new RegExp(value);
}

export const LAB_MAINTENANCE_GIT_DIR = 'lab-maintenance';

export const RUNTIME_ARTIFACT_REGISTRY: RuntimeArtifactRegistryEntry[] = [
  {
    id: 'lab-maintenance-git-records',
    description: 'Local Lab command records, output and key in the Git common directory; not Story evidence.',
    matchers: [{ kind: 'prefix', value: `.git/${LAB_MAINTENANCE_GIT_DIR}/` }],
    ignorePatterns: [], materialHash: 'exclude', volatile: false, repairableTrackedArtifact: false,
  },
  {
    id: 'proof-or-stop-runtime-root-ignore',
    description: `Ignore runtime state under the state directory (${STATE_DIR_NAMES.join(', ')}) while keeping tracked story evidence visible.`,
    matchers: [],
    // Order is load-bearing: within one spelling the broad ignore must precede
    // its own re-inclusions, so the patterns are grouped PER DIRECTORY rather
    // than interleaved across directories.
    ignorePatterns: STATE_DIR_NAMES.flatMap((dir) => [
      `${dir}/*`,
      `!${dir}/story/`,
      `${dir}/story/*`,
      `!${dir}/story/actives/`,
      `!${dir}/story/actives/**`,
      `${dir}/story/actives/**/activity.jsonl`,
    ]),
    materialHash: 'include',
    volatile: false,
    repairableTrackedArtifact: false,
  },
  {
    id: 'runtime-activity-log',
    description: 'Primary Proof-or-Stop runtime activity log.',
    matchers: stateDirExact('activity.jsonl'),
    ignorePatterns: ['**/activity.jsonl'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    // B-c55d CHK-001: the per-story owner lease (`owner-lease.json`) is process
    // metadata, not story evidence. It lives under the git-tracked
    // `.proof-or-stop/story/actives/<id>/` subtree, so it MUST be ignored — an
    // un-ignored lease file would surface as a dirty write and could block the
    // DONE `git merge story/<id>` (the F-008 failure mode). The `**/` ignore
    // pattern mirrors `runtime-activity-log` above, which ignores the equally
    // story-scoped `activity.jsonl`.
    id: 'runtime-story-owner-lease',
    description: 'Per-story owner lease (local session ownership) written under .proof-or-stop/story/actives/<id>/.',
    matchers: [{ kind: 'regexp', value: rx(String.raw`(?:^|/)(?:owner-lease\.json|\.owner-lease-[a-f0-9-]+\.tmp)$`) }],
    ignorePatterns: ['**/owner-lease.json', '**/.owner-lease-*.tmp'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    // Complete selector objects are durable evidence. They remain non-material
    // alongside their receipt, but must never be offered as disposable runtime data.
    id: 'causal-complete-selector-output',
    description: 'Signed-receipt-bound complete selector output objects.',
    matchers: [{kind:'regexp',value:rx(String.raw`(?:^|/)(?:\.lattice|\.proof-or-stop)/story/actives/[^/]+/causal-evidence/outputs(?:/|$)|(?:^|/)docs/story/actives/[^/]+/causal-evidence/outputs(?:/|$)`)}],
    ignorePatterns: [], materialHash: 'exclude', volatile: false, repairableTrackedArtifact: false,
  },
  {
    // B-5a15: immutable command receipts are lookup/runtime state, not story
    // source material. The CAS bytes remain auditable and story-scoped, but
    // writing them must not invalidate materialHash or make DONE's clean-tree
    // gate depend on a verification retry.
    id: 'runtime-causal-evidence-receipts',
    description: 'Story-scoped CausalEvidence CAS receipt bytes and execution-key index.',
    matchers: [{ kind: 'regexp', value: rx(String.raw`(?:^|/)(?:\.lattice|\.proof-or-stop)/story/actives/[^/]+/causal-evidence(?:/|$)|(?:^|/)docs/story/actives/[^/]+/causal-evidence(?:/|$)`) }],
    ignorePatterns: ['**/causal-evidence/'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    // B-bbaf CHK-002/006: the convergence-breaker runtime state — breaker-state.json
    // (graduated freeze + auto-recovery budget), takeover-count.json (per-story
    // takeover counter), and gate-failure-counts.json (repeated-identical-gate-
    // failure counter) — are process/diagnostic metadata, NOT story evidence.
    // They live under the git-tracked .proof-or-stop/story/actives/<id>/ subtree, so
    // they MUST be ignored: an un-ignored breaker-state would surface as a dirty
    // write and could block the DONE `git merge story/<id>` (the F-008 failure
    // mode, exactly as for owner-lease.json above). materialHash-excluded so a
    // freeze/bump never perturbs currentMaterialHash and invalidates gate evidence.
    id: 'runtime-convergence-breaker-state',
    description: 'Per-story convergence-breaker runtime state (freeze state + takeover/gate-failure counters) under .proof-or-stop/story/actives/<id>/.',
    matchers: [
      { kind: 'regexp', value: rx(String.raw`(?:^|/)breaker-state\.json$`) },
      { kind: 'regexp', value: rx(String.raw`(?:^|/)takeover-count\.json$`) },
      { kind: 'regexp', value: rx(String.raw`(?:^|/)gate-failure-counts\.json$`) },
    ],
    ignorePatterns: ['**/breaker-state.json', '**/takeover-count.json', '**/gate-failure-counts.json'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    id: 'legacy-activity-log',
    description: 'Legacy top-level activity log retained for compatibility reads.',
    matchers: [{ kind: 'exact', value: 'docs/story/activity.jsonl' }],
    ignorePatterns: [],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    id: 'owner-session-token-store',
    description: 'Local generated owner-session tokens under <state-dir>/runtime/owner-session-tokens/.',
    matchers: stateDirPrefix('runtime/owner-session-tokens/'),
    ignorePatterns: stateDirIgnore('runtime/owner-session-tokens/'),
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    id: 'runtime-cache',
    description: 'Mutable runtime cache and trigger state under <state-dir>/runtime/.',
    matchers: stateDirPrefix('runtime/'),
    ignorePatterns: stateDirIgnore('runtime/'),
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    // B-a7c5 F-005: dev_memory_finish_decision (core/playbook-runtime-memory.ts
    // finishDecisionPath) writes OUTSIDE .proof-or-stop/story/actives/<storyId>/, so
    // autoCommitStoryMetadata (deliberately hard-scoped to the story dir --
    // its own anti-broadening preMortem #1 anchor) never covers it. Before this
    // entry existed, an uncommitted write here fell through classifyParsedRow
    // to `unexpected_dirty_files` (blocking) and stranded review_run_start and
    // other dirty-tree-sensitive gates -- found live during B-a7c5's own REVIEW
    // round 3. UNLIKE this registry's other entries, deliberately NO
    // ignorePatterns: .proof-or-stop/dev-memory/** is explicitly un-ignored (see
    // .gitignore) because these records are meant to be git-tracked and shared
    // across agents/hosts, not ephemeral runtime state. materialHash:'exclude'
    // is still required so writing/refreshing this record can never perturb
    // currentMaterialHash and thus never invalidate an already-signed evidence
    // freshness binding (test-evidence.json / delivery-check.json) -- this was
    // confirmed as a real regression risk when an earlier draft of this fix
    // tried auto-committing the write instead (that approach moved HEAD and
    // broke delivery-check materialHash freshness; excluding from materialHash
    // computation avoids the problem at its root instead).
    // B-5a15: dev_memory_capture writes <state-dir>/dev-memory/experience.jsonl,
    // a sibling of finish-decisions/ that the entry below does NOT match. Without
    // an entry it counted as story MATERIAL, and that broke certification:
    // deriveCertificationDomainInputHashes (handlers/certification-window.ts)
    // returns undefined for any story-owned path matching no CERTIFICATION_DOMAIN_PATH_RULES
    // entry, which drove causalInputHashes absent -> identityComplete false ->
    // certification_window_begin BLOCKED [pre_cert_causal_freshness_required]. The
    // DONE gate itself requires dev_memory_finish_decision, so capturing a lesson is
    // a mandatory closeout step that must not be able to block certification.
    // Same rationale and same shape as the finish-decision entry below: git-tracked
    // and shared across agents/hosts (hence NO ignorePatterns), but
    // materialHash:'exclude' so writing a lesson can never perturb currentMaterialHash
    // and invalidate an already-signed evidence freshness binding.
    id: 'dev-memory-experience-log',
    description: 'Append-only dev_memory_capture experience log under <state-dir>/dev-memory/experience.jsonl, tracked but non-authoritative.',
    // stateDirExact, not stateDirPrefix (B-5a15:F-392): this is always one fixed
    // filename -- resolveProjectMemoryPath/resolveGlobalMemoryPath never produce a
    // variant -- so it follows the activity.jsonl / learning-log.jsonl convention.
    // The prefix form was an imprecise copy from the finish-decisions sibling, which
    // is genuinely a directory; prefix also wrongly matched nested paths under the
    // filename, widening the materialHash exclusion beyond the one real file.
    matchers: stateDirExact('dev-memory/experience.jsonl'),
    ignorePatterns: [],
    materialHash: 'exclude',
    volatile: false,
    repairableTrackedArtifact: false,
  },
  {
    id: 'dev-memory-finish-decision',
    description: 'Per-story dev_memory_finish_decision record under <state-dir>/dev-memory/finish-decisions/, tracked but non-authoritative.',
    matchers: stateDirPrefix('dev-memory/finish-decisions/'),
    ignorePatterns: [],
    materialHash: 'exclude',
    volatile: false,
    repairableTrackedArtifact: false,
  },
  {
    id: 'runtime-traces',
    description: 'Trace artifacts emitted under <state-dir>/traces/.',
    matchers: stateDirPrefix('traces/'),
    ignorePatterns: stateDirIgnore('traces/'),
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    // B-cc10 CHK-007 (F-004): this entry named ONLY the deprecated state
    // directory while the runtime had already moved to the canonical one, so
    // `.proof-or-stop/locks/` was neither gitignored nor recognized as runtime
    // state. Measured symptom: validate-execution-lock-smoke failed with
    // `unexpected_dirty_files=2` on the validation-capacity lock's holder.json /
    // heartbeat.json. Now derived, so it covers both spellings by construction.
    id: 'runtime-locks',
    description: 'Main write lock and other mkdir-style coordination locks under <state-dir>/locks/.',
    matchers: stateDirPrefix('locks/'),
    // B-cc10 F-062: `**/*.lock/` must be REGISTRY-owned, not hand-typed into .gitignore.
    // It lived only as a literal inside the generator-owned managed block, so
    // mergeProofOrStopRuntimeIgnores() regenerated that block WITHOUT it — meaning the next
    // `init --upgrade` would delete the rule again (it had already been lost twice). The
    // pattern is deliberately state-dir-INDEPENDENT: transient <name>.lock/ dirs
    // (checklist/finding/review-run/init-check) each carry a holder.json token and appear
    // wherever the artifact they guard lives, not only under <state-dir>/locks/.
    ignorePatterns: [...stateDirIgnore('locks/'), '**/*.lock/'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    // B-253e CHK-005: the local LLM usage ledger (.proof-or-stop/usage/llm-usage.jsonl)
    // is a mutable runtime diagnostic — budget accounting and operator
    // diagnostics, NOT story evidence, validation evidence, or gate-consumed
    // proof. doctor / material-hash / runtime-artifact repair / gitignore must
    // treat it like other mutable runtime diagnostics under .proof-or-stop/. The
    // prefix matcher also covers future adjacent usage-runtime files under
    // .proof-or-stop/usage/ without catching unrelated paths (e.g. story evidence).
    id: 'llm-usage-ledger',
    description: 'local LLM usage diagnostic ledger',
    matchers: [
      ...stateDirExact('usage/llm-usage.jsonl'),
      ...stateDirPrefix('usage/'),
    ],
    ignorePatterns: stateDirIgnore('usage/'),
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    // B-000c CHK-003: the Experience Layer derived caches under
    // .proof-or-stop/learning/ (finding-signals.json + learning-log.jsonl) are mutable
    // runtime diagnostics derived from existing findings — NOT story evidence,
    // validation evidence, or gate-consumed proof. They MUST be materialHash-
    // excluded so deriving/refreshing the cache never perturbs currentMaterialHash
    // and thus never invalidates a gate's evidence freshness. Mirrors the
    // llm-usage-ledger entry above; the prefix matcher also covers future
    // adjacent learning-runtime files under .proof-or-stop/learning/.
    id: 'experience-layer-learning-cache',
    description: 'Experience Layer derived finding-signals cache and learning log under <state-dir>/learning/.',
    matchers: [
      ...stateDirExact('learning/finding-signals.json'),
      ...stateDirExact('learning/learning-log.jsonl'),
      ...stateDirPrefix('learning/'),
    ],
    ignorePatterns: stateDirIgnore('learning/'),
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    id: 'serve-metadata',
    description: 'Transient dev-server handshake file.',
    // NOT derived, and not a bug: `.proof-or-stop-serve.json` is a SIBLING marker file,
    // not a path inside the state directory, and it is not one of the six
    // identities B-cc10 migrates. `verifier/serve.ts` and `verifier/dev-host.ts`
    // still write exactly this name, so the registry must keep matching it —
    // deriving it would rename the ignore pattern away from the file the runtime
    // actually creates. Same reasoning as `PROOF_OR_STOP_REPAIR_IGNORE` in
    // `core/proof-or-stop-paths.ts`: renaming a sibling marker stays a separate,
    // deliberate decision.
    matchers: [
      { kind: 'exact', value: '.proof-or-stop-serve.json' },
    ],
    ignorePatterns: ['.proof-or-stop-serve.json'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    id: 'proof-or-stop-authority-key-file',
    description: 'Internal Proof-or-Stop Authority key-management file; may contain local private key material.',
    // The capitalized `.proof-or-stop/` variant is retained deliberately: this file may
    // hold private key material, so on a case-insensitive filesystem a
    // differently-cased path must never fall out of the ignore set. It is kept as
    // an explicit legacy literal rather than derived, because the canonical
    // spelling is all-lowercase and has no capitalized twin to generate.
    matchers: [
      ...stateDirExact('authority.md'),
      { kind: 'exact', value: '.proof-or-stop/authority.md' },
    ],
    ignorePatterns: [...stateDirIgnore('authority.md'), '.proof-or-stop/authority.md'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    id: 'proof-or-stop-baseline-artifacts',
    description: 'Proof-or-Stop baseline proof artifacts kept outside the material tree.',
    // `.proof-or-stop/` retained for the same case-insensitive-filesystem reason as the
    // authority key file above.
    matchers: [
      ...stateDirPrefix('artifacts/baseline/'),
      { kind: 'prefix', value: '.proof-or-stop/artifacts/baseline/' },
    ],
    ignorePatterns: [
      ...stateDirIgnore('artifacts/baseline/'),
      '.proof-or-stop/artifacts/baseline/',
    ],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    id: 'memory-playbook-baseline-artifacts',
    description: 'Deterministic playbook runtime memory benchmark corpora and reports.',
    matchers: stateDirPrefix('benchmarks/memory-playbook/'),
    ignorePatterns: stateDirIgnore('benchmarks/memory-playbook/'),
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    id: 'runtime-temp',
    description: 'Temporary runtime scratch files and directories.',
    matchers: [{ kind: 'regexp', value: rx(String.raw`^\.proof-or-stop-tmp-[^/]+(?:/.*)?$`) }],
    ignorePatterns: ['.proof-or-stop-tmp-*'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    id: 'debug-log',
    description: 'CLI debug log emitted in the repo root.',
    matchers: [
      { kind: 'exact', value: 'proof-or-stop-debug.log' },
    ],
    ignorePatterns: ['proof-or-stop-debug.log'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    id: 'browser-test-log',
    description: 'Browser verification log emitted in the repo root.',
    matchers: [{ kind: 'exact', value: 'browser-test.log' }],
    ignorePatterns: ['browser-test.log'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
  {
    id: 'project-root-scratch',
    description: 'Host scratch directory created by external adapters.',
    matchers: [{ kind: 'prefix', value: '$PROJECT_ROOT/' }],
    ignorePatterns: ['$PROJECT_ROOT/'],
    materialHash: 'exclude',
    volatile: true,
    repairableTrackedArtifact: true,
  },
];

export function normalizeRuntimeArtifactPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function matchesRuntimeArtifact(entry: RuntimeArtifactRegistryEntry, path: string): boolean {
  const normalized = normalizeRuntimeArtifactPath(path);
  return entry.matchers.some((matcher) => {
    if (matcher.kind === 'exact') return normalized === normalizeRuntimeArtifactPath(matcher.value);
    if (matcher.kind === 'prefix') {
      const base = normalizeRuntimeArtifactPath(matcher.value);
      return normalized === base || normalized.startsWith(`${base}/`);
    }
    return matcher.value.test(normalized);
  });
}

export function findRuntimeArtifactEntry(path: string): RuntimeArtifactRegistryEntry | undefined {
  const normalized = normalizeRuntimeArtifactPath(path);
  return RUNTIME_ARTIFACT_REGISTRY.find((entry) => entry.matchers.length > 0 && matchesRuntimeArtifact(entry, normalized));
}

export function isRuntimeArtifactPath(path: string): boolean {
  return Boolean(findRuntimeArtifactEntry(path));
}

export function isMaterialExcludedRuntimeArtifactPath(path: string): boolean {
  return findRuntimeArtifactEntry(path)?.materialHash === 'exclude';
}

export function isVolatileRuntimeArtifactPath(path: string): boolean {
  return findRuntimeArtifactEntry(path)?.volatile === true;
}

export function isRepairableTrackedRuntimeArtifactPath(path: string): boolean {
  return findRuntimeArtifactEntry(path)?.repairableTrackedArtifact === true;
}

export function listRuntimeArtifactIgnorePatterns(): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const entry of RUNTIME_ARTIFACT_REGISTRY) {
    for (const pattern of entry.ignorePatterns) {
      if (seen.has(pattern)) continue;
      seen.add(pattern);
      lines.push(pattern);
    }
  }
  return lines;
}
