/**
 * B-ab8d CHK-004 — observability_snapshot resolvedLearningRoot surface.
 *
 * Small standalone logic/integration test (no runner framework; run directly
 * after `npm --prefix packages/main run build`):
 *
 *   node packages/main/tests/observability-snapshot-learning-root.test.mjs
 *
 * Asserts:
 *   1. JSON output gains a read-only `resolvedLearningRoot` field.
 *   2. The field is computed by the EXISTING `resolveLearningDir` leaf
 *      (byte-equal), i.e. resolution behavior is unchanged.
 *   3. Text output renders a `resolvedLearningRoot: <path>` line.
 *   4. In a fresh non-git temp root the field points under that temp root
 *      and ends with /.lattice/learning.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const distRoot = fileURLToPath(new URL('../dist/', import.meta.url));
const { StoryStore } = await import(join(distRoot, 'core/store.js'));
const { resolveLearningDir } = await import(join(distRoot, 'core/learning-store.js'));
const { createObservabilitySnapshotHandlers } = await import(join(distRoot, 'handlers/observability-snapshot.js'));

const root = mkdtempSync(join(tmpdir(), 'lattice-obs-learning-root-'));
try {
  const store = new StoryStore(root);
  const ctx = { store, root, scanRoot: root };
  const handlers = createObservabilitySnapshotHandlers(ctx);

  // 1 + 2: JSON shape gains the field, and it delegates to resolveLearningDir.
  const json = handlers.observability_snapshot({ format: 'json' });
  assert.equal(typeof json.resolvedLearningRoot, 'string', 'JSON output must include resolvedLearningRoot');
  assert.equal(
    json.resolvedLearningRoot,
    resolveLearningDir(root),
    'resolvedLearningRoot must be byte-equal to the existing resolveLearningDir(root) — resolution unchanged',
  );

  // 4: fresh mkdtemp non-git root => resolved under that temp root.
  assert.ok(
    json.resolvedLearningRoot.endsWith(join('.lattice', 'learning')),
    'resolvedLearningRoot must end with .lattice/learning',
  );
  assert.ok(
    json.resolvedLearningRoot.startsWith(root),
    `non-git temp root must resolve under itself (got ${json.resolvedLearningRoot}, want prefix ${root})`,
  );

  // 3: text output renders the same value.
  const text = handlers.observability_snapshot({});
  assert.ok(
    text.includes(`resolvedLearningRoot: ${json.resolvedLearningRoot}`),
    'text output must render the resolvedLearningRoot line',
  );

  console.log('ok observability-snapshot-learning-root:', json.resolvedLearningRoot);
} finally {
  rmSync(root, { recursive: true, force: true });
}
