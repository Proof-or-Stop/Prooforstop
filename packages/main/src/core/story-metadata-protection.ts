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
 * Precise unsafe predicate (per decision.json preMortem #4):
 *   unsafe = leaf is NOT tracked (git ls-files empty for the leaf)
 *            AND the leaf would be cleaned (git check-ignore reports the leaf
 *            itself is ignored).
 *
 * A negation-allowlist that re-includes the leaf (`git check-ignore` reports the
 * leaf is NOT ignored, e.g. Orchestrate's `.gitignore` allowlist) is SAFE — the
 * leaf is trackable, plain `git add` works, and after bootstrap force-add it
 * becomes a committed (clean-proof) tracked path. A tracked leaf is always SAFE.
 *
 * The guard MUST be evaluated on the actual metadata LEAF (the index.json that
 * is git-added), NOT the `.lattice` prefix: under a negation allowlist git
 * check-ignore on the `.lattice` parent reports "ignored" even though the leaf
 * is re-included, which would false-positive a correctly-configured repo.
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
 * test assertions. `wouldBeCleaned` mirrors `ignored && !tracked` (an
 * ignored-and-untracked leaf is precisely what `git clean -fdx` removes), kept
 * as an explicit field so the data-loss reasoning is legible at every consumer.
 */
export interface StoryMetadataProtectionResult {
  readonly leafPath: string;
  readonly tracked: boolean;
  readonly ignored: boolean;
  /** ignored && !tracked — the leaf an `git clean -fdx` would delete. */
  readonly wouldBeCleaned: boolean;
  /** The data-loss state: neither tracked nor protected by a tracking allowlist. */
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
  // ignored AND untracked = exactly what `git clean -fdx` removes, and it was
  // never committed → permanently lost. A tracked leaf is committed (clean-proof);
  // a not-ignored (negation-allowlist / no-ignore) leaf is trackable and becomes
  // safe after the bootstrap force-add.
  const wouldBeCleaned = ignored && !tracked;
  const unsafe = wouldBeCleaned;

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
    '⚠ DATA-LOSS RISK: story metadata is ignored by .gitignore and is NOT git-tracked.',
    `      leaf: ${leafPath}`,
    '      A broad `.lattice/` ignore leaves this metadata neither tracked nor protected;',
    '      a later `git clean -fdx` or a wrong-branch checkout can PERMANENTLY delete it',
    '      (this is exactly how ClawCreek lost 19 stories).',
    '      → Run `lattice doctor --repair` to install the managed ignore-volatile/track-metadata',
    '        allowlist so story metadata stays tracked while runtime stays ignored.',
  ].join('\n');
}
