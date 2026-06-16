/**
 * docs-drift-path-drift-smoke (B-a7b0 CHK-001)
 *
 * Logic test for the path-reference drift extension of runDocsDriftGate.
 * Uses INJECTED pathExists / grepLiteral so there is NO real disk access and
 * the test is deterministic.
 *
 * Coverage:
 *   - happy:       a referenced path that does not exist (pathExists=false, grep=false)
 *                  → status 'fail', path appears in missingPaths.
 *   - edge:        a referenced path that exists (pathExists=true)
 *                  → status 'pass', missingPaths empty.
 *   - adversarial: docs/story/... path + uppercase-XXX placeholder are NOT flagged;
 *                  an allowlisted path is NOT flagged; AND the command-name
 *                  missing/stale result is byte-identical to a run WITHOUT repoRoot.
 */

import assert from 'node:assert/strict';
import {
  runDocsDriftGate,
} from '../handlers/validate-docs-drift.js';

const REPO_ROOT = '/fake/repo';
const REGISTRY = new Set<string>(['story_create', 'validate']);

// ── happy: missing referenced path → fail, named in missingPaths ──
{
  const md = [
    '# Doc',
    '',
    'The gate handler lives at `packages/main/src/handlers/ghost-file.ts` today.',
    '',
  ].join('\n');

  const result = runDocsDriftGate([md], REGISTRY, {
    repoRoot: REPO_ROOT,
    pathExists: () => false,
    grepLiteral: () => false,
  });

  assert.equal(result.status, 'fail', 'happy: missing path should fail the gate');
  assert.ok(
    result.missingPaths.includes('packages/main/src/handlers/ghost-file.ts'),
    `happy: missing path should be named in missingPaths (got ${JSON.stringify(result.missingPaths)})`,
  );
  assert.ok(
    result.summary.includes('packages/main/src/handlers/ghost-file.ts'),
    'happy: summary should name the missing path',
  );
}

// ── edge: referenced path exists → pass, missingPaths empty ──
{
  const md = [
    '# Doc',
    '',
    'See `packages/main/src/handlers/validate-docs-drift.ts` for the gate.',
    '',
  ].join('\n');

  const result = runDocsDriftGate([md], REGISTRY, {
    repoRoot: REPO_ROOT,
    pathExists: () => true, // path exists on disk
    grepLiteral: () => false,
  });

  assert.equal(result.status, 'pass', 'edge: existing path should pass the gate');
  assert.deepEqual(result.missingPaths, [], 'edge: missingPaths should be empty when path exists');
}

// ── edge: path absent on disk but grep-found in source → pass (grep fallback) ──
{
  const md = '# Doc\n\nReferenced literal `packages/foo/bar.ts` appears in source.\n';
  const result = runDocsDriftGate([md], REGISTRY, {
    repoRoot: REPO_ROOT,
    pathExists: () => false,
    grepLiteral: () => true, // string literal exists somewhere in repo source
  });
  assert.equal(result.status, 'pass', 'edge: grep-found path should pass via fallback');
  assert.deepEqual(result.missingPaths, [], 'edge: grep-found path should not be reported missing');
}

// ── adversarial: noise controls + allowlist + byte-identical command result ──
{
  const md = [
    '# Doc',
    '',
    // docs/story/ path: scanPathDrift ignores these
    'Story artifact at `docs/story/actives/B-xxx/index.json` is internal.',
    // uppercase placeholder: scanPathDrift ignores [A-Z]{3,}',
    'Template lives at `src/PLACEHOLDER/file.ts`.',
    // a real-looking but allowlisted path
    'Intentionally-absent example `packages/main/src/handlers/intentional-absent.ts`.',
    '',
    '```bash',
    'lattice not_a_real_command',
    '```',
  ].join('\n');

  const allowlist = new Set<string>(['packages/main/src/handlers/intentional-absent.ts']);

  // Run WITH repoRoot (path check active). Everything path-side is suppressed:
  // docs/story/ ignored, uppercase placeholder ignored, allowlisted path suppressed.
  const withRepo = runDocsDriftGate([md], REGISTRY, {
    repoRoot: REPO_ROOT,
    pathAllowlist: allowlist,
    pathExists: () => false,
    grepLiteral: () => false,
  });
  assert.deepEqual(
    withRepo.missingPaths,
    [],
    `adversarial: story/placeholder/allowlisted paths must NOT be flagged (got ${JSON.stringify(withRepo.missingPaths)})`,
  );

  // Run WITHOUT repoRoot (legacy command-only behavior, backward compatible).
  const withoutRepo = runDocsDriftGate([md], REGISTRY);
  assert.deepEqual(withoutRepo.missingPaths, [], 'adversarial: no-repoRoot run has empty missingPaths');

  // Command-name missing/stale result must be byte-identical between the two runs
  // (the path check is purely additive and does not perturb the command scan).
  assert.deepEqual(
    withRepo.missing,
    withoutRepo.missing,
    'adversarial: command missing[] must be byte-identical with vs without repoRoot',
  );
  assert.deepEqual(
    withRepo.stale,
    withoutRepo.stale,
    'adversarial: command stale[] must be byte-identical with vs without repoRoot',
  );
  assert.equal(
    withRepo.status,
    withoutRepo.status,
    'adversarial: gate status must match (both fail on the unregistered command)',
  );
  // The unregistered command IS still caught (proves the command scan still runs).
  assert.ok(
    withRepo.missing.includes('not_a_real_command'),
    'adversarial: unregistered command must still be flagged',
  );
}

console.log('docs-drift-path-drift smoke passed');
