/**
 * artifact_declare — per-story declared product artifact registration (B-cf60).
 *
 * 流程位置：
 *   - PLAN/DEV/REVIEW/TEST 任何阶段都可以调用，把一个生成物路径声明为本 story
 *     的预期产出，让 dirty-worktree classifier 把它归到 declared_artifact_changes
 *     而不是 unexpected_dirty_files。
 *   - 写入 .koala/story/actives/<storyId>/declared-artifacts.json（store 接口）。
 *   - 写入完成后调用 autoCommitStoryMetadata(B-3506) 自动提交 metadata。
 *
 * 三层校验（packages/koala/CLAUDE.md「Handler 编码约定」）：
 *   - Zod schema（cli-engine.ts 注册端）：min(1) / min(10) / regex 等结构约束。
 *   - Handler runtime（本文件入口 sanitizeArgs）：重复同标准 trim / 路径形态校验，
 *     防止内部调用或老 JSON 路径绕过 Zod。
 *   - gate 决策点（buildDoneChecklist + declared-artifact-gate.ts）：消费时再校验
 *     reference 是否存在于 checklist.verificationIntent 或 delivery-check.docsPromises。
 *
 * 路径形态约束（preMortem #1 anchor — defends against backdoor wildcards）：
 *   - 不含 `*` / `?` / `[` / `]`（glob 字符）
 *   - 不以 `/` 开头（绝对路径）
 *   - 不含 `..` 路径段（防 traversal）
 *   - 长度 ≥ 1（trim 后）
 *
 * relatedIntent 约束：
 *   - 形式一：`CHK-NNN:(happy|edge|adversarial):INDEX`（指向 verificationIntent）
 *   - 形式二：`promise:<docPath>`（指向 delivery-check.docsPromises[*].docPath）
 *   handler 只校验"形态"；reference 实际是否存在由 DONE gate 决定。
 *
 * 幂等：同 path 重复声明 → 覆盖原 entry（按 path 去重），返回值含 "overwritten"。
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
 * 运行时路径校验。Zod 已经检查过 min(1)，但 handler 入口必须重做一次，因为
 * 内部调用或 JSON 反序列化路径都可能绕过 Zod。这条 throw 是 preMortem #1
 * 的 hard anchor，扩展时一律走 PATH_FORBIDDEN_RE 集中规则。
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
 * Runtime check at handler entry (Handler 编码约定) — internal callers that
 * bypass Zod still hit this throw.
 */
function assertDeclarablePath(path: string, root: string): void {
  const config = loadConfig(root);
  const options = dirtyWorktreeClassifierOptionsFromConfig(config);
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
      //    internal callers that bypass schema parsing — Handler 编码约定).
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
