/**
 * artifact_declare — per-story declared product artifact registration (B-cf60).
 *
 * Flow position:
 *   - Can be called at any PLAN/DEV/REVIEW/TEST stage to declare a generated artifact path as the expected output
 *     of this story, so the dirty-worktree classifier categorizes it as declared_artifact_changes
 *     instead of unexpected_dirty_files.
 *   - Writes to .koala/story/actives/<storyId>/declared-artifacts.json (store interface).
 *   - After writing, calls autoCommitStoryMetadata(B-3506) to automatically commit metadata.
 *
 * Three-layer validation (packages/koala/CLAUDE.md "Handler coding conventions"):
 *   - Zod schema (cli-engine.ts registration side): structural constraints like min(1) / min(10) / regex.
 *   - Handler runtime (sanitizeArgs entry in this file): repeats same-standard trim / path-shape validation,
 *     preventing internal calls or legacy JSON paths from bypassing Zod.
 *   - Gate decision points (buildDoneChecklist + declared-artifact-gate.ts): re-validate on consumption whether
 *     the reference exists in checklist.verificationIntent or delivery-check.docsPromises.
 *
 * Path shape constraints (preMortem #1 anchor — defends against backdoor wildcards):
 *   - No `*` / `?` / `[` / `]` (glob characters)
 *   - Does not start with `/` (absolute path)
 *   - No `..` path segments (prevent traversal)
 *   - Length ≥ 1 (after trim)
 *
 * relatedIntent constraints:
 *   - Form 1: `CHK-NNN:(happy|edge|adversarial):INDEX` (points to verificationIntent)
 *   - Form 2: `promise:<docPath>` (points to delivery-check.docsPromises[*].docPath)
 *   handler only validates "shape"; whether the reference actually exists is determined by the DONE gate.
 *
 * Idempotent: repeated declaration with the same path → overwrites the original entry (deduplicated by path), return value contains "overwritten".
 */

import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';
import { loadConfig } from '../core/config.js';
import {
  classifyDeclarablePath,
  dirtyWorktreeClassifierOptionsFromConfig,
} from '../core/dirty-worktree.js';
import type { DeclaredArtifactEntry, DeclaredArtifactsData } from '../core/types.js';
import type { HandlerContext } from './context.js';

export interface ArtifactDeclareArgs {
  storyId: string;
  path: string;
  reason: string;
  relatedIntent: string;
}

const PATH_FORBIDDEN_RE = /[*?\[\]]/;
const RELATED_INTENT_INTENT_RE = /^CHK-\d+:(?:happy|edge|adversarial):\d+$/;
const RELATED_INTENT_PROMISE_RE = /^promise:.+$/;

/**
 * Runtime path validation. Zod has already checked min(1), but the handler entry must redo it, because
 * internal calls or JSON deserialization paths may bypass Zod. This throw is the hard anchor
 * for preMortem #1; when extending, always go through the centralized PATH_FORBIDDEN_RE rules.
 */
function assertSafePath(rawPath: string): string {
  if (typeof rawPath !== 'string') {
    throw new Error('artifact_declare: path must be a string');
  }
  const path = rawPath.trim();
  if (path.length < 1) {
    throw new Error('artifact_declare: path must be a non-empty string after trim');
  }
  if (path.startsWith('/')) {
    throw new Error(`artifact_declare: path must be relative (got leading slash: ${JSON.stringify(rawPath)})`);
  }
  if (PATH_FORBIDDEN_RE.test(path)) {
    throw new Error(
      `artifact_declare: path must not contain glob characters \`*\` / \`?\` / \`[\` / \`]\` ` +
      `(got ${JSON.stringify(rawPath)}); declared artifacts are exact relative paths.`,
    );
  }
  // Split on both forward and back slashes so we catch `foo/../bar` and `foo\..\bar`.
  const segments = path.split(/[\\/]+/);
  if (segments.some(s => s === '..')) {
    throw new Error(
      `artifact_declare: path must not contain \`..\` path segments ` +
      `(got ${JSON.stringify(rawPath)}); declared artifacts must not traverse outside the repo.`,
    );
  }
  return path;
}

/**
 * B-8db9 CHK-002 — declarability gate (fail-fast UX, layered on CHK-001's hard
 * classifier reorder).
 *
 * Runs the already-shape-validated path through `classifyDeclarablePath`, which
 * reuses the EXACT classifier vocabulary of dirty-worktree.ts
 * (`isStoryMetadataPath` / `isFixturePath` / `isMaterialSourcePath`, with config
 * files carried in `materialSourceFiles` by `dirtyWorktreeClassifierOptionsFromConfig`).
 * A path that classifies as material_source / fixture / koala-metadata is
 * rejected here so a bad declaration is caught at declare time instead of
 * silently surfacing as a mis-classification much later. The classifier reorder
 * remains the hard gate for hand-injected declared-artifacts.json entries.
 *
 * Runtime check at handler entry (Handler coding convention) — internal callers that
 * bypass Zod still hit this throw.
 */
function assertDeclarablePath(path: string, root: string): void {
  const config = loadConfig(root);
  const options = dirtyWorktreeClassifierOptionsFromConfig(config, root);
  const category = classifyDeclarablePath(path, options);
  if (category === null) return;
  if (category === 'runtime_artifact_changes') {
    throw new Error(
      `artifact_declare: path ${path} is a runtime artifact, already handled by ` +
      `runtime-artifact-registry; do not declare it (runtime artifacts are routed ` +
      `to runtime_artifact_changes, not declared_artifact_changes).`,
    );
  }
  throw new Error(
    `artifact_declare: path ${path} classifies as ${category} and cannot be ` +
    `declared as a generated artifact (declare only generated output paths, ` +
    `e.g. under tests/output/).`,
  );
}

function assertSafeReason(rawReason: string): string {
  if (typeof rawReason !== 'string') {
    throw new Error('artifact_declare: reason must be a string');
  }
  const reason = rawReason.trim();
  if (reason.length < 10) {
    throw new Error('artifact_declare: reason must be ≥ 10 characters after trim');
  }
  return reason;
}

function assertSafeRelatedIntent(rawRef: string): string {
  if (typeof rawRef !== 'string') {
    throw new Error('artifact_declare: relatedIntent must be a string');
  }
  const ref = rawRef.trim();
  if (ref.length < 1) {
    throw new Error('artifact_declare: relatedIntent must be a non-empty string after trim');
  }
  if (!RELATED_INTENT_INTENT_RE.test(ref) && !RELATED_INTENT_PROMISE_RE.test(ref)) {
    throw new Error(
      `artifact_declare: relatedIntent must match \`CHK-NNN:(happy|edge|adversarial):IDX\` ` +
      `or \`promise:<docPath>\` (got ${JSON.stringify(rawRef)}); ` +
      `the form is checked by handler + DONE gate so bogus refs cannot pass.`,
    );
  }
  return ref;
}

function assertSafeStoryId(rawId: string): string {
  if (typeof rawId !== 'string') {
    throw new Error('artifact_declare: storyId must be a string');
  }
  const id = rawId.trim();
  if (id.length < 1) {
    throw new Error('artifact_declare: storyId must be non-empty after trim');
  }
  return id;
}

export function createArtifactDeclareHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  const { store, root } = ctx;
  return {
    artifact_declare(args: ArtifactDeclareArgs): string {
      // 1) Runtime double-validation (mirrors Zod min/regex; defends against
      //    internal callers that bypass schema parsing — Handler coding convention).
      const storyId = assertSafeStoryId(args?.storyId);
      const path = assertSafePath(args?.path);
      const reason = assertSafeReason(args?.reason);
      const relatedIntent = assertSafeRelatedIntent(args?.relatedIntent);

      // 1b) Declarability gate (B-8db9 CHK-002): reject material/fixture/config/
      //     koala-metadata paths fail-fast, reusing the dirty-worktree classifier
      //     vocabulary so this layer cannot disagree with the CHK-001 hard gate.
      assertDeclarablePath(path, root);

      // 2) Story existence — refuse to write a declared-artifact for a non-existent
      //    story id (otherwise the metadata file would orphan).
      if (!store.storyExists(storyId)) {
        throw new Error(`artifact_declare: story ${storyId} not found`);
      }

      // 3) Idempotent merge: read existing entries, drop any with the same path,
      //    push the new one. Path equality uses the post-trim normalized form.
      const previous = store.readDeclaredArtifacts(storyId);
      const remaining = previous.entries.filter(e => e.path !== path);
      const overwrote = remaining.length !== previous.entries.length;

      const entry: DeclaredArtifactEntry = {
        path,
        reason,
        relatedIntent,
        declaredAt: new Date().toISOString(),
      };
      remaining.push(entry);

      const data: DeclaredArtifactsData = { entries: remaining };
      store.writeDeclaredArtifacts(storyId, data);

      // 4) Auto-commit metadata (B-3506) so the just-written declared-artifacts.json
      //    does not leave the worktree dirty for the next gate.
      const commitHint = autoCommitStoryMetadata(root, storyId, 'artifact_declare');

      const totalSuffix = remaining.length === 1 ? '' : ` (${remaining.length} total)`;
      const overwriteNote = overwrote ? ' overwritten' : '';
      return `✓ artifact declared: ${path} registered for ${storyId} (related: ${relatedIntent})${overwriteNote}${totalSuffix}${commitHint}`;
    },
  };
}
