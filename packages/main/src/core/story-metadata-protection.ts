/**
 * story-metadata-protection — B-854c (CRITICAL data-loss fix)
 *
 * PURE predicate module (no direct process spawn here): given the result of two
 * git probes on a story-metadata LEAF path, decide whether that metadata is in
 * the data-loss-prone "neither tracked nor protected" state.
 *
 * Why a pure module: the same truth source is consumed by THREE entry points —
 *   (A) worktree.ts INIT_CHECK bootstrap (force-add + check-ignore guard),
 *   (B) doctor.ts invariant scan + --repair,
 *   (C) the regression tests —
 * so the predicate lives in one place and every consumer feeds it the same
 * structured probe results. Git I/O (spawning `git ls-files` / `git
 * check-ignore`) is injected via a `MetadataProbeRunner`, mirroring the
 * `CommandRunner` dependency-injection pattern in validate-lint.ts. This keeps
 * the predicate trivially unit-testable without spawning git.
 *
 * The incident (ClawCreek, Lattice 0.3.5): a project that broadly ignores
 * `.lattice/` keeps the volatile runtime safe from `git clean` but SILENTLY
 * untracks the persistent story metadata. The metadata is then never committed,
 * and the next `git clean -fdx` (ignored + untracked = exactly what clean
 * removes) or a wrong-branch checkout permanently deletes it. 19 stories were
 * lost and were unrecoverable from git history.
 *
 * The B-02a6 INIT-window incident (defense-in-depth broadening): the original
 * predicate flagged ONLY the `ignored && !tracked` state, reasoning that a
 * negation-allowlisted (`!ignored`) leaf was inherently safe because it is
 * trackable. That blind spot was real: a leaf in the INIT window is
 * `!ignored && !tracked` — the `.gitignore` `!.lattice/story/actives/**`
 * allowlist re-includes it (so it is NOT ignored), but `story_create` had not
 * yet committed it (so it is UNTRACKED). An untracked + not-ignored path is
 * EXACTLY what a plain `git clean -fd` targets (untracked, not ignored), so the
 * metadata is wiped even WITHOUT `-fdx`. "Trackable" is not "tracked": until the
 * leaf is actually committed it is clean-prone.
 *
 * Precise unsafe predicate (broadened for B-02a6 defense-in-depth):
 *   unsafe = leaf is NOT tracked (git ls-files empty for the leaf), REGARDLESS
 *            of ignore state.
 *
 * Rationale: only a committed (tracked) git object is immune to `git clean`. Any
 * untracked leaf is removable —
 *   - `!ignored && !tracked` → removed by a plain `git clean -fd` (the INIT
 *     window; the new case this broadening catches);
 *   - `ignored  && !tracked` → removed by `git clean -fdx` (the original
 *     ClawCreek case);
 * so BOTH untracked states are unsafe. A TRACKED leaf is always SAFE regardless
 * of ignore state (committed = clean-proof). `wouldBeCleaned` (`ignored &&
 * !tracked`) is retained as a diagnostic sub-field that distinguishes the
 * narrower `-fdx`-only case from the broader `!tracked` set, but it no longer
 * gates `unsafe`.
 *
 * The guard MUST be evaluated on the actual metadata LEAF (the index.json that
 * is git-added), NOT the `.lattice` prefix: under a negation allowlist git
 * check-ignore on the `.lattice` parent reports "ignored" even though the leaf
 * is re-included, which would mis-report the leaf's true ignore state.
 */

/**
 * Result of probing a single metadata leaf path against git's tracking + ignore
 * state. Callers supply these via a `MetadataProbeRunner`; the predicate is pure
 * over this structured input.
 */
export interface StoryMetadataProbe {
  /**
   * true when `git ls-files -- <leaf>` reports the leaf (the leaf is committed /
   * staged into the index of the resolved repo root).
   */
  readonly tracked: boolean;
  /**
   * true when `git check-ignore -- <leaf>` reports the LEAF path itself is
   * ignored (exit 0 with the leaf echoed). false when not ignored (exit 1),
   * which includes the negation-allowlist "re-included leaf" case.
   */
  readonly ignored: boolean;
}

/**
 * Structured protection verdict for one metadata leaf.
 *
 * `unsafe` is the single load-bearing field consumed by the bootstrap guard and
 * the doctor scan; `tracked` / `ignored` are passed through for diagnostics +
 * test assertions. `unsafe` is now `!tracked` (any untracked leaf is removable
 * by some `git clean` invocation — see the B-02a6 INIT-window note above).
 * `wouldBeCleaned` mirrors `ignored && !tracked` (the narrower case removable by
 * `git clean -fdx`), kept as a diagnostic sub-field that distinguishes the
 * `-fdx`-only case from the broader `!tracked` set; it no longer gates `unsafe`.
 */
export interface StoryMetadataProtectionResult {
  readonly leafPath: string;
  readonly tracked: boolean;
  readonly ignored: boolean;
  /**
   * ignored && !tracked — the narrower leaf class a `git clean -fdx` removes.
   * Diagnostic only: a `!ignored && !tracked` leaf is still `unsafe` (a plain
   * `git clean -fd` removes it) even though `wouldBeCleaned` is false.
   */
  readonly wouldBeCleaned: boolean;
  /** The data-loss state: the leaf is NOT tracked (any untracked leaf is clean-prone). */
  readonly unsafe: boolean;
}

/**
 * Injected git probe runner. Production wiring spawns `git ls-files` /
 * `git check-ignore` in the resolved repo root; tests inject a stub returning a
 * fixed `StoryMetadataProbe`. The runner — not this module — owns I/O.
 */
export type MetadataProbeRunner = (leafPath: string) => StoryMetadataProbe;

/**
 * Pure predicate: classify a single story-metadata leaf as safe or unsafe.
 *
 * Runtime re-validation (Handler encoding convention): `metadataLeafPath` must
 * be a non-empty string at EVERY consumer, not only at a Zod boundary. A blank /
 * whitespace-only leaf cannot be probed meaningfully and is rejected here so no
 * caller path (bootstrap, doctor, internal fn call, test fixture) can silently
 * classify an empty path as "safe".
 */
export function evaluateStoryMetadataProtection(args: {
  metadataLeafPath: string;
  runner: MetadataProbeRunner;
}): StoryMetadataProtectionResult {
  const leafPath = (args.metadataLeafPath ?? '').trim();
  if (leafPath.length === 0) {
    throw new Error(
      'evaluateStoryMetadataProtection: metadataLeafPath must be a non-empty path to the story metadata leaf (e.g. <storyRel>/index.json)',
    );
  }
  if (typeof args.runner !== 'function') {
    throw new Error('evaluateStoryMetadataProtection: runner must be a MetadataProbeRunner function');
  }

  const probe = args.runner(leafPath);
  const tracked = probe.tracked === true;
  const ignored = probe.ignored === true;
  // Broadened (B-02a6 defense-in-depth): ANY untracked leaf is unsafe, because
  // only a committed (tracked) git object is immune to `git clean`.
  //   - `ignored  && !tracked` → removed by `git clean -fdx` (ClawCreek case).
  //   - `!ignored && !tracked` → removed by a plain `git clean -fd` (the INIT
  //     window: allowlisted/not-ignored but not yet committed). "Trackable" is
  //     NOT "tracked" — until the bootstrap/safe-init commit lands, it is wiped.
  // A tracked leaf is committed = clean-proof = SAFE regardless of ignore state.
  // `wouldBeCleaned` is kept as a diagnostic that isolates the narrower
  // `-fdx`-only class; it no longer drives `unsafe`.
  const wouldBeCleaned = ignored && !tracked;
  const unsafe = !tracked;

  return { leafPath, tracked, ignored, wouldBeCleaned, unsafe };
}

/**
 * Loud, actionable warning text for the data-loss state, pointing the operator
 * at `lattice doctor --repair` (which installs the managed ignore-volatile /
 * track-metadata allowlist). Shared by the bootstrap guard and the doctor scan
 * so the remediation phrasing stays in one place.
 */
export function renderStoryMetadataProtectionWarning(leafPath: string): string {
  return [
    '⚠ DATA-LOSS RISK: story metadata is NOT git-tracked (uncommitted).',
    `      leaf: ${leafPath}`,
    '      An untracked leaf is clean-prone: if ignored, a `git clean -fdx` removes it',
    '      (the ClawCreek case, 19 stories lost); if allowlisted-but-uncommitted (the',
    '      B-02a6 INIT window), even a plain `git clean -fd` removes it. A wrong-branch',
    '      checkout can also PERMANENTLY delete it. Only a committed object is clean-proof.',
    '      → Commit the story metadata (story_create now lands a safe-init commit), or run',
    '        `lattice doctor --repair` to install the managed ignore-volatile/track-metadata',
    '        allowlist so story metadata stays tracked while runtime stays ignored.',
  ].join('\n');
}
