/**
 * B-7691: shared dirty-worktree git-status read + classifier-options helpers.
 *
 * `readGitStatusLines` and `classifierOptionsForCheck` were relocated VERBATIM
 * from `core/done-oracle.ts` (pure move, zero logic change) so a second consumer
 * — the `review_run_start` clean-tree preflight (handlers/review-run.ts) — can
 * reuse the EXACT same git-status read + classifier-options resolution the DONE
 * gate uses, without importing done-oracle (which would create a cycle:
 * review-run → done-oracle → review-escalation/assurance-floor → … ).
 *
 * This module imports ONLY leaf modules:
 *   - ./dirty-worktree.js   (classifyGitStatusRows + classifier-options builders)
 *   - ./dirty-gate-policy.js (DIRTY_GATE_POLICY — the single blocking table)
 * It must NOT import done-oracle or review-run.
 *
 * `isBlockingDirty` is a gate-agnostic blocking check derived from the SAME
 * `DIRTY_GATE_POLICY` table the DONE gate's `evaluateDirtyGate` consumes: a
 * category contributes to the blocked verdict exactly when its policy entry has
 * `blocking === true` (material_source_changes / fixture_changes /
 * unexpected_dirty_files). It does NOT write audit events or recompute any hash;
 * the DONE verdict, materialHash computation, and the evidence-write-time
 * freshness guard are untouched.
 */

import { execSync } from 'child_process';
import type { LatticeConfig } from './config.js';
import type { StoryStore } from './store.js';
import {
  DIRTY_WORKTREE_CATEGORIES,
  classifyGitStatusRows,
  dirtyWorktreeClassifierOptionsForStory,
  dirtyWorktreeClassifierOptionsFromConfig,
  type DirtyWorktreeClassification,
} from './dirty-worktree.js';
import { DIRTY_GATE_POLICY } from './dirty-gate-policy.js';

// B-6666 CHK-001: gitCwd is the resolved git cwd (wrapper-root aware). On a
// wrapper-root layout the bare metadataRoot is not a git repo, so reading
// `git status` from it errors -> the git-working-tree DONE row falsely blocks.
export function readGitStatusLines(gitCwd: string): { ok: true; lines: string[] } | { ok: false; error: string } {
  try {
    const raw = execSync('git status --porcelain=v1 --untracked-files=all', {
      cwd: gitCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true, lines: raw.split('\n').map(line => line.trimEnd()).filter(Boolean) };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// Task B-6326: DONE gate dirty output uses the shared ownership classifier.
// Task B-cf60: when a storyId/store is available, mix in declaredArtifactPaths from the
// per-story declared-artifacts.json so declared paths flip from unexpected → declared.
export function classifierOptionsForCheck(
  config: LatticeConfig,
  storyId: string | undefined,
  store: StoryStore | undefined,
  projectRoot?: string,
) {
  if (storyId && store) {
    return dirtyWorktreeClassifierOptionsForStory(config, storyId, store, projectRoot);
  }
  return dirtyWorktreeClassifierOptionsFromConfig(config, projectRoot);
}

/**
 * B-7691: gate-agnostic blocking check over the shared `DIRTY_GATE_POLICY`.
 *
 * A category contributes to the blocked verdict exactly when
 * `DIRTY_GATE_POLICY[cat].blocking === true` (material_source_changes,
 * fixture_changes, unexpected_dirty_files). The non-blocking categories
 * (lattice_metadata / runtime_artifact / declared_artifact) pass.
 *
 * This shares the SAME table the DONE gate's `evaluateDirtyGate` reads, so the
 * blocked/allowed split is identical by construction — no inline category
 * literals, no second policy source.
 */
export function isBlockingDirty(
  classification: DirtyWorktreeClassification,
): { blocked: boolean; blockingPaths: string[]; blockingCategories: string[] } {
  const blockingCategories: string[] = [];
  const blockingPaths: string[] = [];
  for (const category of DIRTY_WORKTREE_CATEGORIES) {
    if (!DIRTY_GATE_POLICY[category].blocking) continue;
    const entries = classification.groups[category];
    if (!entries || entries.length === 0) continue;
    blockingCategories.push(category);
    for (const entry of entries) blockingPaths.push(entry.path);
  }
  return { blocked: blockingCategories.length > 0, blockingPaths, blockingCategories };
}

export { classifyGitStatusRows };
