/**
 * docs-drift-path-drift-smoke (B-a7b0 CHK-003)
 *
 * CANONICAL regression for the two CLAUDE.md docs-drift extensions added by this
 * story (CHK-001 path-reference drift + CHK-002 managed-asset contradiction).
 * Everything is dependency-injected — in-memory md strings + injected
 * pathExists / grepLiteral / managedAssetDefs — so there is NEVER any real disk
 * access and the real CLAUDE.md is NEVER read or mutated. The test is fully
 * deterministic.
 *
 * The four behaviors this story's checks MUST hold (CHK-003 acceptance):
 *   (a) STALE-PATH fixture          → runDocsDriftGate status 'fail', path in missingPaths.
 *   (b) MANAGED-ASSET-CONTRADICTION → forbids a non-allowlisted generated-kind
 *                                     relPath → status 'fail', asset in
 *                                     managedAssetContradictions.
 *   (c) CLEAN fixture               → paths exist, no forbidden generated assets
 *                                     → status 'pass', missingPaths AND
 *                                     managedAssetContradictions both empty.
 *   (d) COMMAND-NAME BEHAVIOR UNCHANGED → for a fixture exercising the command-name
 *                                     scan, runDocsDriftGate WITHOUT opts produces
 *                                     byte-identical missing/stale/status vs. the
 *                                     same call WITH opts that have no path/asset
 *                                     drift (the additive checks do not perturb the
 *                                     existing command-name result).
 *
 * Below, the original CHK-001 / CHK-002 sub-fixtures are kept as the detailed
 * coverage (happy/edge/adversarial per check); the four lettered behaviors are
 * then asserted explicitly as a consolidated acceptance block.
 */

import assert from 'node:assert/strict';
import {
  checkDocsDrift,
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
    'proof-or-stop not_a_real_command',
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

// ════════════════════════════════════════════════════════════════════════════
// B-a7b0 CHK-002: managed-asset contradiction check (the P3 class).
// All defs are INJECTED fixtures — the real listManagedAssetDefinitions is NEVER
// called in the assertion path.
// ════════════════════════════════════════════════════════════════════════════

// ── happy: md forbids a generated-kind relPath → fail, named in contradictions ──
{
  const md = [
    '# Doc',
    '',
    'Claude hook/settings 只放在 `.claude/`，不要创建 `.codex/hooks` 或 `.codex/settings.json`。',
    '',
  ].join('\n');

  // Injected registry: the codex hook file is a GENERATED kind (codex-hooks).
  const result = runDocsDriftGate([md], REGISTRY, {
    managedAssetDefs: [
      { relPath: '.codex/hooks/proof-or-stop-scope-pretool.cjs', kind: 'codex-hooks' },
    ],
    // Empty allowlist so the contradiction is NOT suppressed (proves detection).
    managedAssetAllowlist: new Set<string>(),
  });

  assert.equal(result.status, 'fail', 'happy: forbidding a generated asset must fail the gate');
  assert.deepEqual(
    result.managedAssetContradictions,
    [{ asset: '.codex/hooks/proof-or-stop-scope-pretool.cjs', kind: 'codex-hooks' }],
    `happy: the asset + kind must appear in managedAssetContradictions (got ${JSON.stringify(result.managedAssetContradictions)})`,
  );
  assert.ok(
    result.summary.includes('.codex/hooks/proof-or-stop-scope-pretool.cjs') && result.summary.includes('codex-hooks'),
    'happy: summary should name the asset + registry kind',
  );
}

// ── edge: md forbids an excluded-path (NON-generated) kind → NO contradiction ──
{
  const md = '# Doc\n\n不要创建 `.codex/settings.json`。\n';
  const result = runDocsDriftGate([md], REGISTRY, {
    managedAssetDefs: [
      { relPath: '.codex/settings.json', kind: 'excluded-path' },
    ],
    managedAssetAllowlist: new Set<string>(),
  });
  assert.equal(result.status, 'pass', 'edge: forbidding a NON-generated kind must not fail');
  assert.deepEqual(
    result.managedAssetContradictions,
    [],
    'edge: excluded-path kind must produce no contradiction',
  );
}

// ── edge: md with no do-not-create claims → pass, contradictions empty ──
{
  const md = '# Doc\n\nThe framework generates `.codex/hooks/x.cjs` automatically.\n';
  const result = runDocsDriftGate([md], REGISTRY, {
    managedAssetDefs: [
      { relPath: '.codex/hooks/x.cjs', kind: 'codex-hooks' },
    ],
    managedAssetAllowlist: new Set<string>(),
  });
  assert.equal(result.status, 'pass', 'edge: no forbidding claim → pass');
  assert.deepEqual(result.managedAssetContradictions, [], 'edge: no claim → no contradiction');
}

// ── edge: forbidden ANCESTOR dir of a generated asset → contradiction ──
{
  // CLAUDE.md forbids the parent dir `.Codex/hooks` (uppercase C); the generated
  // asset is the lowercase file under it. Casing-insensitive + ancestor match.
  const md = '# Doc\n\n不要创建 `.Codex/hooks`。\n';
  const result = runDocsDriftGate([md], REGISTRY, {
    managedAssetDefs: [
      { relPath: '.codex/hooks/proof-or-stop-scope-pretool.cjs', kind: 'codex-hooks' },
    ],
    managedAssetAllowlist: new Set<string>(),
  });
  assert.equal(result.status, 'fail', 'edge: forbidding an ancestor dir of a generated asset must fail');
  assert.deepEqual(
    result.managedAssetContradictions,
    [{ asset: '.codex/hooks/proof-or-stop-scope-pretool.cjs', kind: 'codex-hooks' }],
    'edge: ancestor-dir prohibition must flag the generated child asset',
  );
}

// ── adversarial: allowlisted forbidden generated asset → NOT flagged ──
{
  // Proves the allowlist SEAM still suppresses a forbidden generated asset, using an
  // EXPLICITLY-INJECTED allowlist rather than the default. B-d633 emptied the default
  // (DOCS_DRIFT_MANAGED_ASSET_ALLOWLIST) so it can no longer permanently mask the real
  // '.codex/hooks' class; the seam itself is still exercised here via injection.
  const md = '# Doc\n\n不要创建 `.Codex/hooks` 或 `.Codex/settings.json`。\n';
  const result = runDocsDriftGate([md], REGISTRY, {
    managedAssetDefs: [
      { relPath: '.codex/hooks/proof-or-stop-scope-pretool.cjs', kind: 'codex-hooks' },
    ],
    // Explicit allowlist (NOT the default) → suppressed via the seam.
    managedAssetAllowlist: new Set<string>(['.codex/hooks']),
  });
  assert.equal(result.status, 'pass', 'adversarial: allowlisted (injected) pending claim must NOT block the gate');
  assert.deepEqual(
    result.managedAssetContradictions,
    [],
    'adversarial: allowlisted forbidden generated asset must not be flagged',
  );
}

// ── B-d633 regression: with the DEFAULT allowlist now empty, the same forbidden
//    generated asset IS flagged (proves the bridge no longer masks the .codex/hooks
//    class). No managedAssetAllowlist override → uses the empty default. ──
{
  const md = '# Doc\n\n不要创建 `.Codex/hooks` 或 `.Codex/settings.json`。\n';
  const result = runDocsDriftGate([md], REGISTRY, {
    managedAssetDefs: [
      { relPath: '.codex/hooks/proof-or-stop-scope-pretool.cjs', kind: 'codex-hooks' },
    ],
    // No managedAssetAllowlist → DEFAULT (now empty) → contradiction must surface.
  });
  assert.equal(result.status, 'fail', 'B-d633: empty default allowlist must no longer suppress the .codex/hooks contradiction');
  assert.deepEqual(
    result.managedAssetContradictions,
    [{ asset: '.codex/hooks/proof-or-stop-scope-pretool.cjs', kind: 'codex-hooks' }],
    'B-d633: the .codex/hooks prohibition must now be flagged via the empty default allowlist',
  );
}

// ── adversarial: check reads the INJECTED registry, not a hardcoded list ──
{
  // Same forbidding md; flip ONLY the injected def's kind from generated→excluded.
  // If the check were hardcoded it would flag both; it must instead follow the
  // injected registry and flag ONLY the generated variant.
  const md = '# Doc\n\n不要创建 `.codex/hooks/probe.cjs`。\n';

  const asGenerated = runDocsDriftGate([md], REGISTRY, {
    managedAssetDefs: [{ relPath: '.codex/hooks/probe.cjs', kind: 'codex-hooks' }],
    managedAssetAllowlist: new Set<string>(),
  });
  const asExcluded = runDocsDriftGate([md], REGISTRY, {
    managedAssetDefs: [{ relPath: '.codex/hooks/probe.cjs', kind: 'excluded-path' }],
    managedAssetAllowlist: new Set<string>(),
  });

  assert.equal(asGenerated.status, 'fail', 'adversarial: generated injected def → fail');
  assert.equal(asExcluded.status, 'pass', 'adversarial: excluded injected def → pass');
  assert.notDeepEqual(
    asGenerated.managedAssetContradictions,
    asExcluded.managedAssetContradictions,
    'adversarial: different injected defs must yield different outcomes (proves registry-driven, not hardcoded)',
  );

  // And with NO managedAssetDefs at all → always empty (backward compatible).
  const noDefs = runDocsDriftGate([md], REGISTRY, { repoRoot: REPO_ROOT, pathExists: () => true });
  assert.deepEqual(
    noDefs.managedAssetContradictions,
    [],
    'adversarial: absent managedAssetDefs → empty contradictions (additive/backward compatible)',
  );
}

// ════════════════════════════════════════════════════════════════════════════
// B-a7b0 CHK-003: consolidated four-behavior acceptance block.
// Asserts the exact (a)/(b)/(c)/(d) shapes the story acceptance enumerates,
// using DI fixtures only (no real CLAUDE.md, no disk).
// ════════════════════════════════════════════════════════════════════════════

// ── (a) stale-path fixture → status 'fail', path in missingPaths ──
{
  const md = '# Doc\n\nThe gate lives at `packages/main/src/handlers/stale-path.ts`.\n';
  const result = runDocsDriftGate([md], REGISTRY, {
    repoRoot: REPO_ROOT,
    pathExists: () => false, // referenced path does not exist on disk
    grepLiteral: () => false, // and is not a string literal anywhere in source
  });
  assert.equal(result.status, 'fail', '(a) stale-path fixture must fail the gate');
  assert.ok(
    result.missingPaths.includes('packages/main/src/handlers/stale-path.ts'),
    `(a) the stale path must appear in missingPaths (got ${JSON.stringify(result.missingPaths)})`,
  );
}

// ── (b) managed-asset-contradiction fixture (non-allowlisted generated kind) → fail ──
{
  const md = '# Doc\n\n不要创建 `.codex/hooks/proof-or-stop-scope-pretool.cjs`。\n';
  const result = runDocsDriftGate([md], REGISTRY, {
    managedAssetDefs: [
      { relPath: '.codex/hooks/proof-or-stop-scope-pretool.cjs', kind: 'codex-hooks' },
    ],
    // Empty allowlist → the contradiction is NOT suppressed (proves detection).
    managedAssetAllowlist: new Set<string>(),
  });
  assert.equal(result.status, 'fail', '(b) forbidding a non-allowlisted generated asset must fail');
  assert.deepEqual(
    result.managedAssetContradictions,
    [{ asset: '.codex/hooks/proof-or-stop-scope-pretool.cjs', kind: 'codex-hooks' }],
    `(b) the asset must appear in managedAssetContradictions (got ${JSON.stringify(result.managedAssetContradictions)})`,
  );
}

// ── (c) clean fixture → status 'pass', BOTH missingPaths & contradictions empty ──
{
  // Paths exist; the only managed-asset mention is a NEUTRAL statement (the doc
  // says the framework generates it — NOT a "do not create" prohibition), so no
  // contradiction. Command names all resolve against REGISTRY.
  const md = [
    '# Doc',
    '',
    'See `packages/main/src/handlers/validate-docs-drift.ts` for the gate.',
    'The framework generates `.codex/hooks/proof-or-stop-scope-pretool.cjs` automatically.',
    '',
    '```bash',
    'proof-or-stop story_create',
    'proof-or-stop validate',
    '```',
  ].join('\n');
  const result = runDocsDriftGate([md], REGISTRY, {
    repoRoot: REPO_ROOT,
    pathExists: () => true, // every referenced path exists on disk
    grepLiteral: () => true,
    managedAssetDefs: [
      { relPath: '.codex/hooks/proof-or-stop-scope-pretool.cjs', kind: 'codex-hooks' },
    ],
    managedAssetAllowlist: new Set<string>(),
  });
  assert.equal(result.status, 'pass', '(c) clean fixture must pass the gate');
  assert.deepEqual(result.missingPaths, [], '(c) clean fixture: missingPaths must be empty');
  assert.deepEqual(
    result.managedAssetContradictions,
    [],
    '(c) clean fixture: managedAssetContradictions must be empty',
  );
}

// ── (d) command-name behavior UNCHANGED: WITHOUT opts ≡ WITH no-drift opts ──
{
  // A fixture that exercises the command-name scan: one unregistered command
  // (caught by the command scan) plus a registered one. The path it references
  // EXISTS and the managed-asset claim is neutral, so the additive checks find
  // NO path/asset drift — meaning command-name missing/stale/status must be
  // byte-identical whether or not opts are supplied.
  const md = [
    '# Doc',
    '',
    'See `packages/main/src/handlers/validate-docs-drift.ts`.',
    '',
    '```bash',
    'proof-or-stop story_create',
    'proof-or-stop not_a_real_command',
    '```',
  ].join('\n');

  // Baseline: legacy command-only behavior (no opts at all).
  const withoutOpts = runDocsDriftGate([md], REGISTRY);

  // Same call WITH opts that introduce NO path/asset drift (path exists, neutral
  // asset mention, empty asset allowlist).
  const withNoDriftOpts = runDocsDriftGate([md], REGISTRY, {
    repoRoot: REPO_ROOT,
    pathExists: () => true,
    grepLiteral: () => true,
    managedAssetDefs: [
      { relPath: '.codex/hooks/proof-or-stop-scope-pretool.cjs', kind: 'codex-hooks' },
    ],
    managedAssetAllowlist: new Set<string>(),
  });

  // The additive checks contributed nothing.
  assert.deepEqual(withNoDriftOpts.missingPaths, [], '(d) no-drift opts must yield empty missingPaths');
  assert.deepEqual(
    withNoDriftOpts.managedAssetContradictions,
    [],
    '(d) no-drift opts must yield empty managedAssetContradictions',
  );

  // Command-name results must be byte-identical between the two calls.
  assert.deepEqual(
    withNoDriftOpts.missing,
    withoutOpts.missing,
    '(d) command missing[] must be byte-identical with vs without opts',
  );
  assert.deepEqual(
    withNoDriftOpts.stale,
    withoutOpts.stale,
    '(d) command stale[] must be byte-identical with vs without opts',
  );
  assert.equal(
    withNoDriftOpts.status,
    withoutOpts.status,
    '(d) gate status must be identical with vs without opts (both fail on the unregistered command)',
  );

  // Cross-check the command scan result directly against the pure checkDocsDrift
  // (the gate must not perturb what the pure scanner reports for this fixture).
  const pure = checkDocsDrift(md, REGISTRY, new Set<string>());
  assert.deepEqual(
    withoutOpts.missing,
    pure.missing,
    '(d) gate missing[] must match pure checkDocsDrift missing[]',
  );
  assert.ok(
    withoutOpts.missing.includes('not_a_real_command'),
    '(d) the unregistered command must still be flagged (proves the command scan runs)',
  );
}

console.log('docs-drift path+asset smoke passed');
