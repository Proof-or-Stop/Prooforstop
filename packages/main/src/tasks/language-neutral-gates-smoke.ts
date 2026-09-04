#!/usr/bin/env node
/**
 * B-956f language-neutral advanced-gate classification smoke.
 *
 * Standalone task (not wired into a runner config — invoked directly like
 * transition-integrity-smoke). Covers EVERY verificationIntent lane in
 * .proof-or-stop/story/actives/B-956f/checklist.json (12 lanes across 4 CHKs):
 *
 *   CHK-001 (policy service + hash-bound snapshot threaded into 3 consumers)
 *     happy       — .py/.rs/.go/.java/.cpp + cross-ecosystem manifests classify
 *                   material; docs stay non-material (mirrors the RED harness).
 *     edge        — floor + repro + ProofStory all consume ONE snapshot object;
 *                   a stale-hash snapshot is re-resolved, never silently used.
 *     adversarial — repro classification requires the snapshot (compile-time) and
 *                   routes project config to the repro gate (no config-blind
 *                   regression, no re-derivation from raw paths).
 *
 *   CHK-002 (8-step precedence chain + non-excludable manifests + strict resolver)
 *     happy       — go.mod/Cargo.toml/pyproject.toml/pom.xml material with no
 *                   prefix/extension help.
 *     edge        — precedence pairs (docs beat prefix; shebang script vs README;
 *                   segment-aware src/ vs src-old/; storyDir-aware exclusion).
 *     adversarial — excludePaths naming a manifest rejected at resolve; backend/
 *                   covering backend/go.mod rejected by the fs preflight;
 *                   malformed config fails CLOSED naming the offending key.
 *
 *   CHK-003 (buildScopeDiffPack degradation diagnostics + process event)
 *     happy       — a no-scope-contract material .go diff surfaces exactly one
 *                   deduped semantic_analysis_unavailable event via the mutating
 *                   caller.
 *     edge        — same-extension dedupe; TS/JS produce none.
 *     adversarial — pure builder emits nothing; only the mutating caller writes.
 *
 *   CHK-004 (validate-concept skip diagnostic stays a distinct channel)
 *     happy       — a .go/.rs diff surfaces the concept skip diagnostic naming
 *                   those files.
 *     edge        — mixed .ts+.go: TS analyzed, non-TS only in skip; no leakage.
 *     adversarial — skip channel and scope-diff channel stay DISTINCT; no file is
 *                   double-reported as analyzed and skipped.
 *
 * FIX-ROUND checks (cross-host review round 1 — the smoke is re-pointed at
 * PRODUCTION entry points, no helper-only tautologies):
 *   FIX-A — stale/config-drifted snapshots rejected + re-resolved by the REAL
 *           consumers (floor + repro); deep-frozen snapshots refuse mutation.
 *   FIX-B — deleted / renamed-away extensionless scripts keep their OLD-tree
 *           identity (--find-renames + old-tree mode/blob).
 *   FIX-C — declared paths reuse the snapshot verbatim; off-diff bin/
 *           executables carry working-tree hints into classifyReproFirstRequirement.
 *   FIX-D — node_modules/dist/build/coverage manifests structurally excluded
 *           at step 0, before (and never weakening) level-1 immutability.
 *   FIX-E — the fs exclusion preflight fires INSIDE resolveMaterialCodePolicy
 *           (production) and FAILS CLOSED on enumeration failure or a
 *           malformed JSON config file (in CHK-002/adversarial).
 *   FIX-F — conceptSkipDiagnostics/checkConcept thread projectRoot so project
 *           config is honored.
 *   FIX-G — the production phase-gates diagnostic-input builder populates
 *           materialClassification; enforce outcomes stay byte-identical
 *           (diagnostic-only trigger consumption).
 *
 * Prints ✓/✗ per check and exits nonzero on the first failure.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  buildMaterialClassificationSnapshot,
  classifyDeclaredPaths,
  classifyMaterialCodePath,
  ensureFreshMaterialClassificationSnapshot,
  materialClassificationSnapshotStale,
  matchesScopePathEntry,
  preflightMaterialCodeExclusions,
  resolveMaterialCodePolicy,
  resetMaterialCodePolicyCache,
  tryBuildMaterialClassificationSnapshotForDiagnostics,
  __setAfterHeadCaptureHookForTest,
  MaterialCodePolicyError,
  type MaterialClassificationSnapshot,
} from '../core/material-code-policy.js';
import {
  classifyReviewAssuranceFloorPath,
  evaluateReviewAssuranceFloor,
} from '../core/review-assurance-floor.js';
import {
  classifyReproFirstRequirement,
  evaluateStoryEvidenceBindingGate,
  formatStoryEvidenceBindingGateFailure,
} from '../core/repro-evidence-binding-gate.js';
import {
  evaluateProofStoryDiagnostics,
  materialClassificationHasMaterialCode,
} from '../core/proofstory.js';
import {
  buildScopeDiffPack,
  buildSemanticDegradationEvent,
} from '../core/scope-diff-pack.js';
import { emitSemanticDegradationEvent } from '../handlers/scope-contract.js';
import {
  analyzeDeletedSymbols,
  checkConcept,
  conceptSkipDiagnostics,
} from '../handlers/validate-concept.js';
import { proofStoryDiagnosticInput } from '../handlers/phase-gates.js';
import { renderReproFirstStoryCreatePreflight } from '../handlers/story-create.js';
import { buildStoryReviewMaterialClassification } from '../handlers/story-review.js';
import { resetConfigCache } from '../core/config.js';
import type { ProcessEvent } from '../core/types.js';

let failures = 0;
function check(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  [✓] ${label}`);
  } catch (err) {
    failures++;
    console.log(`  [✗] ${label}`);
    console.error(`\n✗ language-neutral-gates smoke FAILED at: ${label}\n${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
  }
}

const tempRoots: string[] = [];
function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
function writeFile(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}
/** Empty temp git repo on branch `main` (no commits yet). */
function initRepo(prefix = 'proof-or-stop-lng-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'smoke@test']);
  git(root, ['config', 'user.name', 'smoke']);
  git(root, ['checkout', '-q', '-b', 'main']);
  return root;
}
function commitAll(root: string, message: string): void {
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', message]);
}
/** Temp git repo whose `feature` HEAD adds `changed` files on top of a `main` base. */
function makeGitRepo(base: Record<string, string>, changed: Record<string, string>): string {
  const root = initRepo();
  writeFile(root, 'README.md', '# base\n');
  for (const [p, c] of Object.entries(base)) writeFile(root, p, c);
  commitAll(root, 'base');
  git(root, ['checkout', '-q', '-b', 'feature']);
  for (const [p, c] of Object.entries(changed)) writeFile(root, p, c);
  commitAll(root, 'change');
  return root;
}
/**
 * Temp project dir with a proof-or-stop.config.json but NO git tree (fresh
 * policy/config caches). Note: an excludePaths-carrying config in a non-git
 * root now FAILS CLOSED at resolution (FIX E) — use makeGitConfigRoot for
 * fixtures that must resolve.
 */
function makeConfigRoot(config: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-lngcfg-'));
  tempRoots.push(root);
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify(config, null, 2));
  resetConfigCache();
  resetMaterialCodePolicyCache();
  return root;
}
/**
 * GIT-BACKED project root whose `main` base commit carries proof-or-stop.config.json
 * (+ base files); when `changed` is non-empty a `feature` HEAD adds them. The
 * production resolve-time exclusion preflight (FIX E) can enumerate this tree.
 */
function makeGitConfigRoot(
  config: unknown,
  base: Record<string, string> = {},
  changed: Record<string, string> = {},
): string {
  const root = initRepo('proof-or-stop-lngcfg-');
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify(config, null, 2));
  for (const [p, c] of Object.entries(base)) writeFile(root, p, c);
  commitAll(root, 'base');
  if (Object.keys(changed).length > 0) {
    git(root, ['checkout', '-q', '-b', 'feature']);
    for (const [p, c] of Object.entries(changed)) writeFile(root, p, c);
    commitAll(root, 'change');
  }
  resetConfigCache();
  resetMaterialCodePolicyCache();
  return root;
}
/**
 * B-956f FIX 1 (codex MED — wrapper-root path namespace): a git repo whose ROOT is
 * the git tree but whose proof-or-stop.config.json (+ project files) live in a SUBDIR
 * (`<root>/<subdir>/`). Mirrors real wrapper-root deployments (ClawCreek precedent):
 * git operations run at the git root (gitCwd) and emit REPO-relative paths, while the
 * policy namespace is the config subdir (projectRoot) with PROJECT-relative
 * excludePaths/pathPrefixes. `base`/`changed` keys are ROOT-relative so a fixture can
 * place files both inside and outside the project subtree.
 */
function makeWrapperRootConfigRoot(
  subdir: string,
  config: unknown,
  base: Record<string, string> = {},
  changed: Record<string, string> = {},
): { root: string; projectRoot: string } {
  const root = initRepo('proof-or-stop-lngwrap-');
  writeFile(root, `${subdir}/proof-or-stop.config.json`, JSON.stringify(config, null, 2));
  for (const [p, c] of Object.entries(base)) writeFile(root, p, c);
  commitAll(root, 'base');
  if (Object.keys(changed).length > 0) {
    git(root, ['checkout', '-q', '-b', 'feature']);
    for (const [p, c] of Object.entries(changed)) writeFile(root, p, c);
    commitAll(root, 'change');
  }
  resetConfigCache();
  resetMaterialCodePolicyCache();
  return { root, projectRoot: join(root, subdir) };
}
function fileDiff(path: string, oldSource: string, newSource: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1 +1 @@',
    ...oldSource.split('\n').map((line) => `-${line}`),
    ...newSource.split('\n').map((line) => `+${line}`),
  ].join('\n');
}

// A neutral ProofStory input skeleton whose corpus carries NO behavior-change /
// risk wording, so the ONLY red-evidence signal can come from materialClassification.
function proofStoryInput(materialClassification?: MaterialClassificationSnapshot | null) {
  return {
    story: {
      storyId: 'B-lng',
      name: 'tidy sample',
      title: 'tidy sample',
      description: 'tidy sample files',
      type: 'chore',
      priority: 'medium',
      riskSignals: [],
    },
    checklist: { items: [] },
    originalIntentSnapshot: null,
    milestoneLedger: null,
    slicePlan: null,
    parentLedgerRollup: null,
    proofStoryContract: null,
    intentCollision: null,
    scopeContract: null,
    scopeShrinkageDecision: null,
    redEvidence: null,
    spikeEvidence: null,
    ...(materialClassification !== undefined ? { materialClassification } : {}),
  } as unknown as Parameters<typeof evaluateProofStoryDiagnostics>[0];
}

console.log('language-neutral-gates smoke:');

// ─────────────────────────── CHK-001 ───────────────────────────

check('CHK-001/happy: non-JS sources + cross-ecosystem manifests classify material; docs stay non-material (RED parity)', () => {
  const mat = (p: string) => classifyReviewAssuranceFloorPath(p).materialCode;
  for (const p of ['src/core/auth.py', 'src/core/auth.rs', 'src/core/auth.go', 'src/core/auth.java', 'lib/gate/check.cpp']) {
    assert.equal(mat(p), true, `${p} should be material (language-neutral)`);
  }
  for (const p of ['go.mod', 'Cargo.toml', 'pyproject.toml', 'pom.xml']) {
    assert.equal(mat(p), true, `${p} manifest should be material`);
  }
  for (const p of ['docs/plan.md', 'deck.pptx']) {
    assert.equal(mat(p), false, `${p} should stay non-material`);
  }
});

check('CHK-001/edge: floor + repro + ProofStory consume ONE snapshot; a stale-hash snapshot is re-resolved', () => {
  const repo = makeGitRepo({ 'src/base.ts': 'export const base = 1;\n' }, { 'src/core/auth.go': 'package core\n' });
  const snap = buildMaterialClassificationSnapshot(repo);
  // The snapshot classified the real main...HEAD diff (the .go file) as material.
  assert.equal(materialClassificationHasMaterialCode(snap), true, 'snapshot should see the material .go file');

  // Consumer 1 — review-assurance floor reuses the SAME snapshot's policy.
  const floor = evaluateReviewAssuranceFloor({
    projectRoot: repo,
    changedFiles: ['src/core/auth.go', 'docs/x.md'],
    materialHash: 'deadbeef',
    materialClassification: snap,
  });
  assert.deepEqual(floor.materialCodePaths, ['src/core/auth.go'], 'floor uses the shared snapshot policy');

  // Consumer 2 — repro classification receives the SAME snapshot object.
  const reproChecklist = { items: [{ files: { modify: ['src/core/auth.go'], create: [], test: [] } }] } as any;
  const repro = classifyReproFirstRequirement({ type: 'bug', priority: 'medium', riskSignals: [] } as any, reproChecklist, snap);
  assert.equal(repro.required, true, 'repro gate flips required=true for the material .go via the shared snapshot');

  // Consumer 3 — ProofStory trigger predicate reads the SAME snapshot object.
  const report = evaluateProofStoryDiagnostics(proofStoryInput(snap));
  assert.equal(report.triggerReasons.some((t) => t.code === 'red_evidence_required'), true, 'ProofStory flips red_evidence_required via the shared snapshot');

  // A fresh snapshot is NOT stale and ensureFresh returns the identical object.
  assert.equal(materialClassificationSnapshotStale(snap), false, 'freshly built snapshot is current');
  assert.ok(Object.is(ensureFreshMaterialClassificationSnapshot(snap), snap), 'a current snapshot is reused, not rebuilt');

  // A snapshot whose embedded hashes differ from the live tree is stale + re-resolved.
  const stale = buildMaterialClassificationSnapshot(repo, { headHash: 'stale-head', materialHash: 'stale-material' });
  assert.equal(materialClassificationSnapshotStale(stale, { gitCwd: repo, projectRoot: repo }), true, 'drifted embedded hashes are stale');
  const refreshed = ensureFreshMaterialClassificationSnapshot(stale, { gitCwd: repo, projectRoot: repo });
  assert.ok(!Object.is(refreshed, stale), 'a stale snapshot is re-resolved into a new object');
  assert.equal(materialClassificationSnapshotStale(refreshed, { gitCwd: repo, projectRoot: repo }), false, 're-resolved snapshot is current');
});

check('CHK-001/adversarial: repro classification requires the snapshot and routes project config (no config-blind regression)', () => {
  // collectMaterialCodeFiles/classifyReproFirstRequirement REQUIRE the snapshot:
  // omitting it is a compile-time type error (the 3rd parameter is non-optional).
  // Enforced statically — the following would not compile:
  //   classifyReproFirstRequirement(story, checklist);   // TS2554: expected 3 args
  type ReproParams = Parameters<typeof classifyReproFirstRequirement>;
  const _snapshotParamIsRequired: MaterialClassificationSnapshot = undefined as unknown as ReproParams[2];
  void _snapshotParamIsRequired;

  // Project config reaches the repro gate through the snapshot's policy: a file
  // under an excludePaths entry is non-material even though its extension is
  // code. GIT-BACKED root: the production resolve-time preflight (FIX E) walks
  // the tracked tree, and the repro consumer freshness-checks the snapshot.
  const root = makeGitConfigRoot({ materialCode: { excludePaths: ['experiments/'] } });
  const snap = buildMaterialClassificationSnapshot(root, { changedFiles: [] });
  const [excluded, included] = classifyDeclaredPaths(snap, ['experiments/model.py', 'src/core/model.py']);
  assert.equal(excluded.materialCode, false, 'project excludePaths reaches repro classification via the shared snapshot');
  assert.equal(included.materialCode, true, 'a non-excluded .py still classifies material');

  const checklist = { items: [{ files: { modify: ['experiments/model.py'], create: [], test: [] } }] } as any;
  const cls = classifyReproFirstRequirement({ type: 'bug', priority: 'medium', riskSignals: [] } as any, checklist, snap);
  assert.equal(cls.required, false, 'an excluded-only material file does not trip repro-first (config-blind path removed)');
});

// ─────────────────────────── CHK-002 ───────────────────────────

check('CHK-002/happy: root cross-ecosystem manifests classify material with no prefix/extension help (first hit wins)', () => {
  const policy = resolveMaterialCodePolicy();
  for (const manifest of ['go.mod', 'Cargo.toml', 'pyproject.toml', 'pom.xml']) {
    const c = classifyMaterialCodePath(policy, manifest);
    assert.equal(c.materialCode, true, `${manifest} should be material`);
    assert.equal(c.reason, 'level-1 immutable runtime/build manifest', `${manifest} matched via the level-1 immutable set`);
  }
});

check('CHK-002/edge: precedence pairs (docs>prefix, README vs shebang script, segment-aware src/, storyDir exclusion)', () => {
  const policy = resolveMaterialCodePolicy();

  // Docs step beats the source path prefix.
  assert.equal(classifyMaterialCodePath(policy, 'src/design.pptx').materialCode, false, 'src/design.pptx is documentation, not material');

  // README under scripts/ stays non-material; an extensionless shebang script under bin/ is material.
  assert.equal(classifyMaterialCodePath(policy, 'scripts/README').materialCode, false, 'plain-text README under scripts/ is non-material');
  assert.equal(classifyMaterialCodePath(policy, 'bin/deploy', { shebangOrExecutable: true }).materialCode, true, 'an extensionless shebang script under bin/ is material');
  assert.equal(classifyMaterialCodePath(policy, 'bin/deploy', { shebangOrExecutable: false }).materialCode, false, 'an extensionless non-script under bin/ is non-material');

  // Segment-aware path matching: src/ never matches src-old/.
  assert.equal(matchesScopePathEntry('src/', 'src/x.py'), true, 'src/ matches src/x.py');
  assert.equal(matchesScopePathEntry('src/', 'src-old/x.py'), false, 'src/ never matches src-old/x.py');

  // Segment-aware excludePaths at classification level: src/ excludes src/x.py but not src-old/x.py.
  const segPolicy = { ...policy, excludePaths: ['src/'] };
  assert.equal(classifyMaterialCodePath(segPolicy, 'src/x.py').materialCode, false, 'excludePaths src/ demotes src/x.py');
  assert.equal(classifyMaterialCodePath(segPolicy, 'src-old/x.py').materialCode, true, 'excludePaths src/ does NOT demote src-old/x.py');

  // storyDir-aware metadata exclusion WITHOUT hardcoding .proof-or-stop.
  const customRoot = makeConfigRoot({ storyDir: 'custom-stories/actives' });
  const customPolicy = resolveMaterialCodePolicy(customRoot);
  assert.equal(classifyMaterialCodePath(customPolicy, 'custom-stories/actives/B-1/story.json', { projectRoot: customRoot }).materialCode, false, 'a file under the resolved custom storyDir is excluded');
  assert.equal(classifyMaterialCodePath(customPolicy, '.proof-or-stop/story/actives/B-1/story.json', { projectRoot: customRoot }).materialCode, false, 'the default .proof-or-stop story metadata stays excluded too');
});

check('CHK-002/adversarial: manifest exclusion rejected at resolve AND by the PRODUCTION fs preflight; enumeration + malformed config fail closed', () => {
  // (a) config-resolve rejection: excludePaths naming a level-1 manifest
  // (basename rule fires before the tree walk, so no git tree is needed).
  const excludeRoot = makeConfigRoot({ materialCode: { excludePaths: ['go.mod'] } });
  assert.throws(
    () => resolveMaterialCodePolicy(excludeRoot),
    (err: unknown) => err instanceof MaterialCodePolicyError && err.offendingKey === 'materialCode.excludePaths' && /go\.mod/.test(err.message),
    'excludePaths naming go.mod is rejected at config-resolve naming the key',
  );

  // (b) FIX E: the filesystem-aware preflight fires INSIDE the production
  // resolveMaterialCodePolicy — a directory exclusion covering a real tracked
  // manifest rejects at RESOLUTION.
  const dirRoot = makeGitConfigRoot(
    { materialCode: { excludePaths: ['backend/'] } },
    { 'backend/go.mod': 'module example.com/x\n', 'backend/main.go': 'package main\n' },
  );
  assert.throws(
    () => resolveMaterialCodePolicy(dirRoot),
    (err: unknown) => err instanceof MaterialCodePolicyError && err.offendingKey === 'materialCode.excludePaths' && /backend\/go\.mod/.test(err.message),
    'backend/ hiding a real tracked backend/go.mod rejects at production resolution',
  );
  // The same config over a tree with NO covered manifest resolves fine.
  const okRoot = makeGitConfigRoot(
    { materialCode: { excludePaths: ['backend/'] } },
    { 'backend/main.go': 'package main\n' },
  );
  const okPolicy = resolveMaterialCodePolicy(okRoot);
  assert.deepEqual(okPolicy.excludePaths, ['backend/'], 'a non-covering directory exclusion survives resolution');

  // (b2) FAIL CLOSED (quality F-001): tracked-file enumeration failure (no git
  // tree) throws a named diagnostic — never []→ok:true.
  const nonGitRoot = makeConfigRoot({ materialCode: { excludePaths: ['backend/'] } });
  assert.throws(
    () => resolveMaterialCodePolicy(nonGitRoot),
    (err: unknown) => err instanceof MaterialCodePolicyError && /could not enumerate tracked files/.test(err.message) && /failing closed/.test(err.message),
    'enumeration failure fails CLOSED with a named diagnostic',
  );

  // (b3) unit-level preflight matrix with an explicit tracked-file list.
  const preflight = preflightMaterialCodeExclusions(okPolicy, okRoot, 'HEAD', ['backend/go.mod', 'backend/main.go', 'README.md']);
  assert.equal(preflight.ok, false, 'backend/ covering backend/go.mod is rejected by the fs preflight');
  assert.deepEqual(preflight.violations, [{ entry: 'backend/', manifest: 'backend/go.mod' }]);
  assert.equal(preflightMaterialCodeExclusions(okPolicy, okRoot, 'HEAD', ['backend/main.go']).ok, true, 'backend/ with no manifest inside passes');

  // (c) malformed materialCode blocks fail CLOSED naming the offending key.
  const badArrayRoot = makeConfigRoot({ materialCode: { addExtensions: 'ts' } });
  assert.throws(
    () => resolveMaterialCodePolicy(badArrayRoot),
    (err: unknown) => err instanceof MaterialCodePolicyError && err.offendingKey === 'materialCode.addExtensions',
    'a non-array addExtensions fails closed naming the key',
  );
  const badPathRoot = makeConfigRoot({ materialCode: { excludePaths: [42] } });
  assert.throws(
    () => resolveMaterialCodePolicy(badPathRoot),
    (err: unknown) => err instanceof MaterialCodePolicyError && err.offendingKey === 'materialCode.excludePaths[0]',
    'a non-string excludePaths entry fails closed naming the key',
  );
  const badBlockRoot = makeConfigRoot({ materialCode: ['not', 'an', 'object'] });
  assert.throws(
    () => resolveMaterialCodePolicy(badBlockRoot),
    (err: unknown) => err instanceof MaterialCodePolicyError && err.offendingKey === 'materialCode',
    'a non-object materialCode block fails closed naming the key',
  );

  // (c2) FIX E adversarial: an UNPARSEABLE proof-or-stop.config.json fails CLOSED
  // (parse error → MaterialCodePolicyError), never a silent default policy.
  const badJsonRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-lngcfg-'));
  tempRoots.push(badJsonRoot);
  writeFileSync(join(badJsonRoot, 'proof-or-stop.config.json'), '{ "materialCode": { invalid');
  resetConfigCache();
  resetMaterialCodePolicyCache();
  assert.throws(
    () => resolveMaterialCodePolicy(badJsonRoot),
    (err: unknown) => err instanceof MaterialCodePolicyError && err.offendingKey === 'proof-or-stop.config.json' && /fails closed/.test(err.message),
    'a malformed JSON config file fails closed naming the file',
  );
});

// ─────────────────────────── CHK-003 ───────────────────────────

check('CHK-003/happy: a no-scope-contract material .go diff surfaces exactly one deduped semantic_analysis_unavailable event', () => {
  const repo = makeGitRepo({ 'src/base.ts': 'export const base = 1;\n' }, { 'backend/auth.go': 'package backend\nfunc Auth() {}\n' });
  // buildScopeDiffPack never reads a scope contract, so the no-contract early
  // return cannot bypass the diagnostic.
  const pack = buildScopeDiffPack(repo, undefined, repo);
  assert.deepEqual(pack.semanticAnalysisUnavailable, ['go'], 'the pack reports the unsupported .go language');

  // The MUTATING validation caller writes exactly one deduped process event.
  const events: Array<Omit<ProcessEvent, 'timestamp'>> = [];
  const fakeStore = { appendProcessEvent: (_id: string, ev: Omit<ProcessEvent, 'timestamp'>) => { events.push(ev); } } as any;
  const emitted = emitSemanticDegradationEvent(fakeStore, 'B-x', pack);
  assert.deepEqual(emitted, ['go']);
  assert.equal(events.length, 1, 'exactly one degradation event is written');
  assert.equal(events[0]!.type, 'semantic_analysis_unavailable');
  assert.deepEqual((events[0] as any).extensions, ['go']);
});

check('CHK-003/edge: same-extension files dedupe to one entry; TS/JS produce none', () => {
  const dedupeRepo = makeGitRepo(
    { 'src/base.ts': 'export const base = 1;\n' },
    { 'a/one.go': 'package a\n', 'b/two.go': 'package b\n', 'src/mod.ts': 'export const x = 2;\n' },
  );
  const pack = buildScopeDiffPack(dedupeRepo, undefined, dedupeRepo);
  assert.deepEqual(pack.semanticAnalysisUnavailable, ['go'], 'two .go files dedupe to a single go entry; the .ts file adds nothing');

  const tsOnlyRepo = makeGitRepo({ 'src/base.ts': 'export const base = 1;\n' }, { 'src/added.ts': 'export const added = 3;\n', 'src/added.js': 'export const j = 4;\n' });
  const tsPack = buildScopeDiffPack(tsOnlyRepo, undefined, tsOnlyRepo);
  assert.equal(tsPack.semanticAnalysisUnavailable, undefined, 'a TS/JS-only diff produces no semantic_analysis_unavailable diagnostics');
});

check('CHK-003/adversarial: production and emission stay separated — pure builder emits nothing, only the mutating caller writes', () => {
  const repo = makeGitRepo({ 'src/base.ts': 'export const base = 1;\n' }, { 'svc/handler.rs': 'fn main() {}\n' });
  const events: Array<Omit<ProcessEvent, 'timestamp'>> = [];
  const fakeStore = { appendProcessEvent: (_id: string, ev: Omit<ProcessEvent, 'timestamp'>) => { events.push(ev); } } as any;

  // Repeated read-only pack builds never touch a store — no events can be spammed.
  const packs = [buildScopeDiffPack(repo, undefined, repo), buildScopeDiffPack(repo, undefined, repo), buildScopeDiffPack(repo, undefined, repo)];
  assert.equal(events.length, 0, 'read-only diff-pack builds emit nothing');
  for (const p of packs) assert.deepEqual(p.semanticAnalysisUnavailable, ['rs']);

  // The pure event builder returns a value without writing anything.
  const pureEvent = buildSemanticDegradationEvent(packs[0]!);
  assert.deepEqual(pureEvent, { type: 'semantic_analysis_unavailable', extensions: ['rs'] });
  assert.equal(events.length, 0, 'the pure event builder does not write to any store');

  // Only the mutating caller writes — and exactly once per call.
  emitSemanticDegradationEvent(fakeStore, 'B-x', packs[0]!);
  assert.equal(events.length, 1, 'the mutating caller writes exactly one event');

  // A pack with nothing unsupported emits nothing (no suppression state leaks).
  assert.equal(emitSemanticDegradationEvent(fakeStore, 'B-x', { semanticAnalysisUnavailable: [] }), null);
  assert.equal(events.length, 1, 'an empty pack writes no additional event');
});

// ─────────────────────────── CHK-004 ───────────────────────────

check('CHK-004/happy: a .go/.rs diff surfaces the concept skip diagnostic naming those files', () => {
  const diff = [
    fileDiff('src/core/auth.go', 'package core\nfunc Auth() {}\n', 'package core\n'),
    fileDiff('svc/handler.rs', 'fn handle() {}\n', 'fn handle() { let _ = 1; }\n'),
  ].join('\n');
  const skip = conceptSkipDiagnostics(diff);
  assert.equal(skip.some((d) => d.includes('src/core/auth.go')), true, 'the .go file is named in the skip diagnostic');
  assert.equal(skip.some((d) => d.includes('svc/handler.rs')), true, 'the .rs file is named in the skip diagnostic');

  const result = checkConcept({ projectRoot: '/tmp/unused', gitDiffReader: () => diff, grepReader: () => '' });
  assert.ok(result.skipDiagnostics && result.skipDiagnostics.length === 2, 'checkConcept surfaces the skip diagnostic (not silently absent)');
  assert.notEqual(result.status, 'fail', 'a language skip must not fail the concept gate');
});

check('CHK-004/edge: mixed .ts + .go — TS analyzed, non-TS only in the skip diagnostic, no leakage', () => {
  const diff = [
    fileDiff('src/keep.ts', 'export function removedTsExport() { return 1; }\n', '\n'),
    fileDiff('src/core/auth.go', 'package core\nfunc Auth() {}\n', 'package core\n'),
  ].join('\n');
  const analysis = analyzeDeletedSymbols(diff);
  assert.deepEqual(analysis.symbols, ['removedTsExport'], 'the TS export is analyzed as a deleted symbol');
  assert.equal(analysis.skipDiagnostics.length, 1, 'only the non-TS file is skipped');
  assert.equal(analysis.skipDiagnostics[0]!.includes('src/core/auth.go'), true, 'the skip diagnostic names the .go file');
  // No leakage in either direction.
  assert.equal(analysis.skipDiagnostics.some((d) => d.includes('src/keep.ts')), false, 'the analyzed TS file never appears in the skip channel');
  assert.equal(analysis.symbols.includes('src/core/auth.go'), false, 'the skipped .go file never appears as an analyzed symbol');
});

check('CHK-004/adversarial: skip channel and scope-diff channel stay DISTINCT; no file double-reported as analyzed and skipped', () => {
  const goRepo = makeGitRepo({ 'src/base.ts': 'export const base = 1;\n' }, { 'src/core/auth.go': 'package core\nfunc Auth() {}\n' });
  const goDiff = fileDiff('src/core/auth.go', 'package core\nfunc Auth() {}\n', 'package core\n');

  // Concept skip channel is present independent of any scope-diff computation.
  const analysis = analyzeDeletedSymbols(goDiff);
  assert.equal(analysis.skipDiagnostics.length, 1, 'concept skip channel fires on its own');

  // Scope-diff channel is a SEPARATE mechanism / structure.
  const pack = buildScopeDiffPack(goRepo, undefined, goRepo);
  const scopeEvent = buildSemanticDegradationEvent(pack);
  assert.deepEqual(scopeEvent, { type: 'semantic_analysis_unavailable', extensions: ['go'] }, 'scope-diff channel is a distinct union-typed event');

  // The two channels are different shapes and one does not gate the other:
  // the concept skip is prose naming files; the scope event is typed extensions.
  assert.notEqual(analysis.skipDiagnostics[0], (scopeEvent as any).type, 'the two channels are not the same value');

  // No file is double-reported as both analyzed (a deleted symbol) and skipped.
  assert.deepEqual(analysis.symbols, [], 'a pure-.go diff yields no analyzed symbols');
  assert.equal(analysis.skipDiagnostics[0]!.includes('src/core/auth.go'), true, 'the .go file is only in the skip channel');
});

// ─────────────────────── fix-round production wiring ───────────────────────

check('FIX-A/adversarial: config-drifted snapshot rejected + re-resolved by REAL consumers (floor + repro); frozen snapshot refuses mutation', () => {
  const root = makeGitConfigRoot(
    { materialCode: { excludePaths: ['src/'] } },
    { 'legacy/keep.ts': 'export const keep = 1;\n' },
    { 'src/app.py': 'print(1)\n' },
  );
  const staleSnap = buildMaterialClassificationSnapshot(root);
  // Under the OLD config the diffed src/app.py is excluded (the codex repro:
  // a stale policy whose exclusion covered src/).
  assert.equal(staleSnap.files.find((f) => f.path === 'src/app.py')!.materialCode, false, 'old policy excludes src/app.py');

  // (1) deep-freeze (FIX A): mutating the snapshot, its policy, or its files THROWS.
  assert.throws(() => { (staleSnap.policy.excludePaths as string[]).push('lib/'); }, TypeError, 'policy mutation throws');
  assert.throws(() => { (staleSnap.files as unknown[]).pop(); }, TypeError, 'files mutation throws');
  assert.throws(() => { (staleSnap as { materialHash?: string }).materialHash = 'forged'; }, TypeError, 'hash forgery throws');

  // (2) config drift WITHOUT any commit: head/materialHash alone still look
  // "fresh" — the policyDigest-vs-live-config check catches it (and the
  // signature-keyed cache makes re-resolve a REAL config reload).
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ materialCode: {} }, null, 2));
  assert.equal(materialClassificationSnapshotStale(staleSnap), true, 'policy drift marks the snapshot stale');

  // (3) REAL consumer 1 — the floor re-resolves; src/app.py is material now.
  const floor = evaluateReviewAssuranceFloor({
    projectRoot: root,
    changedFiles: ['src/app.py'],
    materialHash: 'deadbeef',
    materialClassification: staleSnap,
  });
  assert.deepEqual(floor.materialCodePaths, ['src/app.py'], 'the floor NEVER consumes the stale exclusion — it re-resolves');

  // (4) REAL consumer 2 — repro classification re-resolves.
  const checklist = { items: [{ files: { modify: ['src/app.py'], create: [], test: [] } }] } as any;
  const cls = classifyReproFirstRequirement({ type: 'bug', priority: 'medium', riskSignals: [] } as any, checklist, staleSnap);
  assert.equal(cls.required, true, 'the repro gate NEVER consumes the stale exclusion — it re-resolves');

  // (5) head drift: a commit after build is detected and re-resolution
  // includes the new material file.
  const snap2 = buildMaterialClassificationSnapshot(root);
  assert.equal(materialClassificationSnapshotStale(snap2), false, 'freshly rebuilt snapshot is current');
  writeFile(root, 'src/extra.py', 'print(2)\n');
  commitAll(root, 'more');
  assert.equal(materialClassificationSnapshotStale(snap2), true, 'a commit after build marks the snapshot stale');
  const refreshed = ensureFreshMaterialClassificationSnapshot(snap2);
  assert.ok(!Object.is(refreshed, snap2), 'a stale snapshot is re-resolved into a new object');
  assert.equal(refreshed.files.some((f) => f.path === 'src/extra.py' && f.materialCode), true, 're-resolution sees the new material file');
});

check('FIX-B/adversarial: deleted exec-bit-only script and renamed-away shebang script classify material from the OLD tree (--find-renames)', () => {
  const root = initRepo();
  writeFile(root, 'src/base.ts', 'export const base = 1;\n');
  writeFile(root, 'bin/tool', 'echo hi\n'); // NO shebang — executable bit only
  chmodSync(join(root, 'bin/tool'), 0o755);
  writeFile(root, 'scripts/runner', '#!/bin/sh\necho r\n'); // shebang, no exec bit
  commitAll(root, 'base');
  git(root, ['checkout', '-q', '-b', 'feature']);
  rmSync(join(root, 'bin/tool'));
  git(root, ['mv', 'scripts/runner', 'scripts/renamed-runner']);
  commitAll(root, 'change');

  const snap = buildMaterialClassificationSnapshot(root);
  const byPath = new Map(snap.files.map((f) => [f.path, f]));

  const deleted = byPath.get('bin/tool');
  assert.ok(deleted, 'the DELETED bin/tool keeps its identity in the snapshot');
  assert.equal(deleted!.materialCode, true, 'deleted exec-bit-only script is material via the OLD-tree file MODE');
  assert.equal(deleted!.reason, 'extensionless shebang/executable script');

  const renamedOld = byPath.get('scripts/runner');
  assert.ok(renamedOld, 'the rename OLD path appears in the snapshot (--find-renames pairs parsed)');
  assert.equal(renamedOld!.materialCode, true, 'renamed-away shebang script is material via the OLD-tree blob');

  const renamedNew = byPath.get('scripts/renamed-runner');
  assert.ok(renamedNew && renamedNew.materialCode === true, 'the rename NEW path classifies material too');
});

check('F-059: >1MiB non-executable shebang scripts stay material on current, deleted, and renamed sides', () => {
  const root = initRepo();
  const largeScript = `#!/bin/sh\n${'# padding\n'.repeat(140_000)}`;
  writeFile(root, 'scripts/deleted-large', largeScript);
  writeFile(root, 'scripts/renamed-large', largeScript);
  commitAll(root, 'large old-tree scripts');
  git(root, ['checkout', '-q', '-b', 'feature']);
  rmSync(join(root, 'scripts/deleted-large'));
  git(root, ['mv', 'scripts/renamed-large', 'scripts/renamed-large-new']);
  writeFile(root, 'scripts/current-large', largeScript);
  commitAll(root, 'large script changes');

  const snap = buildMaterialClassificationSnapshot(root);
  const byPath = new Map(snap.files.map((file) => [file.path, file]));
  for (const path of [
    'scripts/deleted-large',
    'scripts/renamed-large',
    'scripts/renamed-large-new',
    'scripts/current-large',
  ]) {
    assert.equal(byPath.get(path)?.materialCode, true, `${path} must remain conservatively material`);
    assert.equal(byPath.get(path)?.reason, 'extensionless shebang/executable script');
  }
});

check('FIX-C/adversarial: declared paths reuse the snapshot VERBATIM; off-diff bin/ executables carry working-tree hints into the REAL repro consumer', () => {
  const root = initRepo();
  writeFile(root, 'src/base.ts', 'export const base = 1;\n');
  writeFile(root, 'bin/oldtool', 'echo unchanged\n'); // exec-bit script OUTSIDE the diff
  chmodSync(join(root, 'bin/oldtool'), 0o755);
  commitAll(root, 'base');
  git(root, ['checkout', '-q', '-b', 'feature']);
  writeFile(root, 'bin/deploy', 'echo deploy\n'); // exec-bit script IN the diff
  chmodSync(join(root, 'bin/deploy'), 0o755);
  commitAll(root, 'change');

  const snap = buildMaterialClassificationSnapshot(root);
  const inDiff = snap.files.find((f) => f.path === 'bin/deploy');
  assert.ok(inDiff && inDiff.materialCode === true, 'the changed bin/deploy executable is material in the snapshot');

  // Verbatim reuse: the declared classification IS the snapshot classification
  // (no hintless re-derivation that would flip a changed executable).
  const [reused] = classifyDeclaredPaths(snap, ['bin/deploy']);
  assert.deepEqual(
    reused,
    { path: inDiff!.path, materialCode: inDiff!.materialCode, reason: inDiff!.reason },
    'declared-path classification reuses the snapshot entry verbatim',
  );

  // Off-diff declared path: hints come from the working tree at the snapshot
  // boundary — the hintless pure classifier is never used for it.
  const [offDiff] = classifyDeclaredPaths(snap, ['bin/oldtool']);
  assert.equal(offDiff!.materialCode, true, 'an off-diff bin/ executable gets working-tree exec-bit hints');

  // The REAL consumer: classifyReproFirstRequirement flips for bin/ executables.
  const mkChecklist = (file: string) => ({ items: [{ files: { modify: [file], create: [], test: [] } }] }) as any;
  const bug = { type: 'bug', priority: 'medium', riskSignals: [] } as any;
  assert.equal(classifyReproFirstRequirement(bug, mkChecklist('bin/deploy'), snap).required, true, 'repro-first flips for the in-diff bin/deploy (no snapshot/classifier divergence)');
  assert.equal(classifyReproFirstRequirement(bug, mkChecklist('bin/oldtool'), snap).required, true, 'repro-first flips for the off-diff bin/oldtool via working-tree hints');
});

check('FIX-D/adversarial: node_modules/dist/build/coverage manifests structurally excluded at step 0; first-party manifests stay immutable material', () => {
  const policy = resolveMaterialCodePolicy();
  for (const p of ['node_modules/pkg/package.json', 'dist/package.json', 'build/go.mod', 'coverage/pyproject.toml', 'node_modules/pkg/index.js', 'packages/x/dist/cli.js']) {
    const c = classifyMaterialCodePath(policy, p);
    assert.equal(c.materialCode, false, `${p} must NOT classify material`);
    assert.equal(c.reason, 'generated/vendored artifact directory (non-source)', `${p} excluded structurally at step 0`);
  }
  // First-party manifests/sources are untouched (structural rule cannot weaken level 1).
  assert.equal(classifyMaterialCodePath(policy, 'package.json').materialCode, true, 'root package.json stays level-1 material');
  assert.equal(classifyMaterialCodePath(policy, 'backend/go.mod').materialCode, true, 'a first-party nested manifest stays material');
  assert.equal(classifyMaterialCodePath(policy, 'build.gradle').materialCode, true, 'build.gradle is a manifest basename, not a dir segment');
  assert.equal(classifyMaterialCodePath(policy, 'src/dist.ts').materialCode, true, 'a file basename matching a segment name is not excluded');
});

check('FIX-F: concept skip classification honors project config (configured-nonmaterial experiments/ never reported skipped-material)', () => {
  const root = makeGitConfigRoot({ materialCode: { excludePaths: ['experiments/'] } });
  const diff = [
    fileDiff('experiments/model.rs', 'fn old() {}\n', 'fn newer() {}\n'),
    fileDiff('svc/handler.go', 'package svc\n', 'package svc\nfunc H() {}\n'),
  ].join('\n');
  const skip = conceptSkipDiagnostics(diff, root);
  assert.equal(skip.some((d) => d.includes('svc/handler.go')), true, 'a real non-TS source file is still reported skipped');
  assert.equal(skip.some((d) => d.includes('experiments/model.rs')), false, 'the configured-nonmaterial file is NOT reported (projectRoot threaded)');

  // The production entry (checkConcept) threads deps.projectRoot the same way.
  const result = checkConcept({ projectRoot: root, gitDiffReader: () => diff, grepReader: () => '' });
  assert.equal((result.skipDiagnostics ?? []).some((d) => d.includes('experiments/model.rs')), false, 'checkConcept honors the project config');
  assert.equal((result.skipDiagnostics ?? []).some((d) => d.includes('svc/handler.go')), true, 'checkConcept still reports the real skip');
});

check('FIX-G: the PRODUCTION phase-gates builder populates materialClassification; enforce outcomes stay byte-identical (diagnostic-only)', () => {
  const repo = makeGitRepo({ 'src/base.ts': 'export const base = 1;\n' }, { 'src/core/auth.go': 'package core\n' });
  const neutralStory = {
    storyId: 'B-lng-g', name: 'tidy sample', title: 'tidy sample', description: 'tidy sample files',
    type: 'chore', priority: 'medium', riskSignals: [],
  };
  const nullReader = (): null => null;
  const fakeStore = {
    readStory: () => neutralStory,
    readChecklist: () => ({ items: [] }),
    readOriginalIntentSnapshot: nullReader,
    readMilestoneLedger: nullReader,
    readProofStorySlicePlan: nullReader,
    readProofStoryParentLedgerRollup: nullReader,
    readProofStoryContract: nullReader,
    readIntentCollision: nullReader,
    readScopeContract: nullReader,
    readScopeShrinkageDecision: nullReader,
    readRedEvidence: nullReader,
    readProofStorySpikes: nullReader,
    readSummary: nullReader,
  } as any;

  // Drive the REAL production diagnostic-input builder (handlers/phase-gates.ts).
  const input = proofStoryDiagnosticInput(fakeStore, 'B-lng-g', repo);
  assert.ok(input.materialClassification, 'the production builder POPULATES materialClassification');
  assert.equal(materialClassificationHasMaterialCode(input.materialClassification), true, 'the populated snapshot sees the material .go diff');

  // The trigger flips language-neutrally, marked diagnostic-only…
  const enforced = evaluateProofStoryDiagnostics(input, 'enforce');
  const red = enforced.triggerReasons.find((t) => t.code === 'red_evidence_required');
  assert.ok(red, 'red_evidence_required flips via the production-populated snapshot');
  assert.equal(red!.diagnosticOnly, true, 'the material-driven trigger is diagnostic-only until the program enforce flip');

  // …and the ENFORCE outcome is byte-identical with and without the field
  // (FIX G constraint: no enforce outcome change for existing projects).
  const baseline = evaluateProofStoryDiagnostics({ ...input, materialClassification: null }, 'enforce');
  assert.equal(enforced.blocking, baseline.blocking, 'enforce blocking unchanged');
  assert.deepEqual(
    enforced.gaps.map((g) => g.code).sort(),
    baseline.gaps.map((g) => g.code).sort(),
    'enforce gap set unchanged by the populated snapshot',
  );
  assert.equal(enforced.hardeningLevel, baseline.hardeningLevel, 'hardening level unchanged');
});

// ─────────────────── R2 fix-round production-boundary checks ───────────────────

check('FIX-1: a deleted exec-bit-only bin/tool is material in the SNAPSHOT and to the FLOOR (floor-through-snapshot path)', () => {
  const root = initRepo();
  writeFile(root, 'src/base.ts', 'export const base = 1;\n');
  writeFile(root, 'bin/tool', 'echo hi\n'); // NO shebang — executable bit only
  chmodSync(join(root, 'bin/tool'), 0o755);
  commitAll(root, 'base');
  git(root, ['checkout', '-q', '-b', 'feature']);
  rmSync(join(root, 'bin/tool'));
  commitAll(root, 'delete the tool');

  // The snapshot classifies the DELETED exec-bit-only script as material.
  const snap = buildMaterialClassificationSnapshot(root);
  const inSnap = snap.files.find((f) => f.path === 'bin/tool');
  assert.ok(inSnap && inSnap.materialCode === true, 'the deleted bin/tool is material in the snapshot');

  // The FLOOR — with NO explicit changedFiles and NO supplied snapshot — builds
  // its OWN identity-preserving snapshot and classifies THROUGH it, so the
  // deletion is material to the floor too (the codex repro: the old --name-only
  // + hintless floor classified it non-material → snapshot=true/floor=false).
  const floor = evaluateReviewAssuranceFloor({ projectRoot: root, gitCwd: root, materialHash: 'deadbeef' });
  assert.equal(floor.materialCodePaths.includes('bin/tool'), true, 'the floor classifies the deleted bin/tool material via its snapshot');
  const floorEntry = floor.changedFiles.find((f) => f.path === 'bin/tool');
  assert.ok(floorEntry && floorEntry.materialCode === true, 'the floor changed-file entry carries the old-tree exec-bit classification');
});

check('FIX-2: a snapshot consumed with a nonexistent gitCwd throws a named freshness diagnostic (never silent acceptance)', () => {
  const root = makeGitRepo({ 'src/app.ts': 'export const x = 1;\n' }, { 'src/app.ts': 'export const x = 2;\n' });
  const snap = buildMaterialClassificationSnapshot(root);
  assert.ok(snap.headHash && snap.materialHash, 'the snapshot is git-bound with embedded hashes');
  // The live HEAD/materialHash cannot be computed for a nonexistent git tree —
  // freshness is UNVERIFIABLE, so the stale check throws instead of returning
  // false ("fresh") and silently accepting the snapshot (fail-open).
  const missingGitCwd = join(root, 'this-dir-does-not-exist');
  assert.throws(
    () => materialClassificationSnapshotStale(snap, { gitCwd: missingGitCwd }),
    (err: unknown) => err instanceof MaterialCodePolicyError
      && err.offendingKey === 'materialClassification.freshness'
      && /cannot verify snapshot freshness/.test(err.message)
      && /fail closed/.test(err.message),
    'unverifiable freshness fails CLOSED with a named diagnostic',
  );
});

check('FIX-3(a): an unreadable proof-or-stop.config.json (EISDIR — not ENOENT) fails CLOSED naming the file (no silent defaults)', () => {
  // A DIRECTORY named proof-or-stop.config.json is not "absent" — reading it throws
  // EISDIR. The previous catch-all treated any read error as absent (fail-open,
  // silently dropping removeExtensions/excludePaths); now only ENOENT degrades.
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-lngcfg-'));
  tempRoots.push(root);
  mkdirSync(join(root, 'proof-or-stop.config.json'));
  resetConfigCache();
  resetMaterialCodePolicyCache();
  assert.throws(
    () => resolveMaterialCodePolicy(root),
    (err: unknown) => err instanceof MaterialCodePolicyError
      && err.offendingKey === 'proof-or-stop.config.json'
      && /could not be read/.test(err.message)
      && /fails closed/.test(err.message),
    'an unreadable (non-ENOENT) config file fails closed naming the file',
  );
});

check('FIX-3(b): a JSON-parse-broken config makes the FLOOR return a structured failing outcome naming proof-or-stop.config.json (no uncaught throw)', () => {
  // A broken config now throws through resolveMaterialCodePolicy into the floor.
  // The floor evaluator MUST catch it and return ok:false naming the file, not
  // crash the DONE-readiness callers with an unrelated-looking exception.
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-lngcfg-'));
  tempRoots.push(root);
  writeFileSync(join(root, 'proof-or-stop.config.json'), '{ "materialCode": { invalid');
  resetConfigCache();
  resetMaterialCodePolicyCache();

  let report: ReturnType<typeof evaluateReviewAssuranceFloor>;
  assert.doesNotThrow(() => {
    report = evaluateReviewAssuranceFloor({ projectRoot: root, gitCwd: root, storyId: 'B-lng-cfg' });
  }, 'the floor evaluator does not throw on a malformed config');
  assert.equal(report!.ok, false, 'the floor blocks (fail closed) on a malformed config');
  assert.equal(report!.required, true, 'the floor marks the transition required');
  assert.match(report!.reasons.join('\n'), /proofOrStop\.config\.json/, 'the failing outcome names proof-or-stop.config.json');
  assert.match(report!.reasons.join('\n'), /fails closed|not valid JSON/, 'the failing outcome explains the fail-closed config error');
});

check('FIX-4: excludePaths:["dist/"] with a tracked dist/package.json resolves WITHOUT throwing; backend/go.mod coverage still rejects', () => {
  // A tracked dist/package.json is a BUILD OUTPUT (structural non-material at
  // step 0), not the project's level-1 manifest — excluding dist/ is legitimate,
  // so the preflight skips it and resolution succeeds.
  const distRoot = makeGitConfigRoot(
    { materialCode: { excludePaths: ['dist/'] } },
    { 'dist/package.json': '{"generated":true}\n', 'src/app.ts': 'export const x = 1;\n' },
  );
  const distPolicy = resolveMaterialCodePolicy(distRoot);
  assert.deepEqual(distPolicy.excludePaths, ['dist/'], 'excluding a build-output dir with a generated manifest resolves without throwing');

  // A FIRST-PARTY backend/go.mod is a real level-1 manifest — excluding its
  // directory still rejects (structural skip must NOT weaken level-1 immutability).
  const backendRoot = makeGitConfigRoot(
    { materialCode: { excludePaths: ['backend/'] } },
    { 'backend/go.mod': 'module example.com/x\n', 'backend/main.go': 'package main\n' },
  );
  assert.throws(
    () => resolveMaterialCodePolicy(backendRoot),
    (err: unknown) => err instanceof MaterialCodePolicyError && err.offendingKey === 'materialCode.excludePaths' && /backend\/go\.mod/.test(err.message),
    'excluding a first-party manifest directory still rejects',
  );
});

// ─────────────────── R3 fix-round production-boundary checks ───────────────────

check('R3-a: a JSON-broken proof-or-stop.config.json makes the PLAN/DEV repro gate return a structured "Cannot enter" failure naming the file (no raw throw)', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-lngcfg-'));
  tempRoots.push(root);
  writeFileSync(join(root, 'proof-or-stop.config.json'), '{ "materialCode": { invalid');
  resetConfigCache();
  resetMaterialCodePolicyCache();
  // readStory/readChecklist throwing is tolerated by the gate (story/checklist=null);
  // the throw comes from the shared classifier resolving the malformed config.
  const fakeStore = { readStory: () => null, readChecklist: () => null } as any;
  let result: ReturnType<typeof evaluateStoryEvidenceBindingGate>;
  assert.doesNotThrow(() => {
    result = evaluateStoryEvidenceBindingGate(root, fakeStore, 'B-lng-guard', { mode: 'warn' });
  }, 'the repro gate does not throw raw on a malformed config');
  assert.equal(result!.ok, false, 'the gate fails closed on a malformed config');
  assert.equal(result!.reasonCode, 'repro_first_material_policy_error', 'distinct material-policy reason code');
  assert.equal(result!.blocking, true, 'the failure blocks regardless of reproFirst mode (fail closed)');
  for (const phase of ['PLAN', 'DEV'] as const) {
    const msg = formatStoryEvidenceBindingGateFailure(phase, 'B-lng-guard', result!);
    assert.ok(msg, `${phase} guard renders a failure message`);
    assert.match(msg!, new RegExp(`Cannot enter ${phase}:`), `${phase} keeps the "Cannot enter <PHASE>:" guard convention`);
    assert.match(msg!, /\[repro_first_material_policy_error\]/, 'keeps the "[reason_code]" convention');
    assert.match(msg!, /proofOrStop\.config\.json/, 'names the offending config file');
  }
});

check('R3-b: a freshness-failure structured floor outcome names workspace/git remediation, NOT proof-or-stop.config.json', () => {
  const root = makeGitRepo({ 'src/app.ts': 'export const x = 1;\n' }, { 'src/app.ts': 'export const x = 2;\n' });
  const snap = buildMaterialClassificationSnapshot(root);
  assert.ok(snap.headHash && snap.materialHash, 'snapshot is git-bound');
  // Consuming the snapshot against a nonexistent gitCwd makes freshness UNVERIFIABLE,
  // so the floor catches the freshness throw and returns a structured outcome.
  const missingGitCwd = join(root, 'this-dir-does-not-exist');
  let report: ReturnType<typeof evaluateReviewAssuranceFloor>;
  assert.doesNotThrow(() => {
    report = evaluateReviewAssuranceFloor({ projectRoot: root, gitCwd: missingGitCwd, storyId: 'B-lng-fresh', materialClassification: snap });
  }, 'the floor catches the freshness throw');
  assert.equal(report!.ok, false, 'a freshness failure fails the floor closed');
  const reasons = report!.reasons.join('\n');
  assert.match(reasons, /workspace\/git/, 'freshness remediation names workspace/git');
  assert.match(reasons, /cannot verify snapshot freshness/i, 'the reason names the freshness failure');
  assert.doesNotMatch(reasons, /Fix proofOrStop\.config\.json/, 'freshness must NOT give the config remediation');
});

check('R3-c: the exclusion preflight re-fires despite a warm config cache — committing a covered go.mod after a clean resolve rejects on the next resolve', () => {
  // excludePaths:["backend/"] over a tree with NO covered manifest → clean resolve
  // (which warms the config-signature cache).
  const root = makeGitConfigRoot(
    { materialCode: { excludePaths: ['backend/'] } },
    { 'backend/main.go': 'package main\n' },
  );
  const first = resolveMaterialCodePolicy(root);
  assert.deepEqual(first.excludePaths, ['backend/'], 'a non-covering directory exclusion resolves clean and caches the policy');

  // Commit a NEW backend/go.mod covered by the SAME excludePaths. The config file
  // (and thus its signature) is UNCHANGED, so a signature-only cache would echo the
  // stale "ok" policy. FIX 4: the tree-bound preflight re-fires and rejects.
  // NOTE: deliberately NO resetMaterialCodePolicyCache() — the warm cache is the point.
  writeFile(root, 'backend/go.mod', 'module example.com/x\n');
  commitAll(root, 'add go.mod under the excluded backend/');
  assert.throws(
    () => resolveMaterialCodePolicy(root),
    (err: unknown) => err instanceof MaterialCodePolicyError && err.offendingKey === 'materialCode.excludePaths' && /backend\/go\.mod/.test(err.message),
    'the preflight re-fires against the new tree and rejects the now-covered manifest',
  );
});

check('R3-d: the snapshot is pinned to ONE HEAD sha; after a HEAD move (amend) it is stale and re-resolves bound to the NEW sha (post-build validation)', () => {
  const root = initRepo();
  writeFile(root, 'src/base.ts', 'export const base = 1;\n');
  commitAll(root, 'base');
  git(root, ['checkout', '-q', '-b', 'feature']);
  writeFile(root, 'src/app.py', 'print(1)\n');
  commitAll(root, 'add py');

  const snap = buildMaterialClassificationSnapshot(root);
  // (1) Pinned: the embedded headHash IS the resolved HEAD commit sha (all diff/hint
  // enumeration ran against that exact sha, not the symbolic ref).
  const headSha = git(root, ['rev-parse', 'HEAD']);
  assert.equal(snap.headHash, headSha, 'snapshot headHash is the pinned HEAD commit sha');
  assert.equal(snap.files.some((f) => f.path === 'src/app.py' && f.materialCode), true, 'the pinned-sha diff sees the material .py');
  assert.equal(materialClassificationSnapshotStale(snap), false, 'a freshly pinned snapshot is current');

  // (2) HEAD MOVES (amend rewrites the commit sha). The pinned snapshot is now
  // stale, and re-resolution rebinds to the NEW sha with an internally consistent
  // file set — the observable guarantee of FIX 1's capture-once + post-build
  // HEAD-stability validation (no path returns an unvalidated snapshot).
  writeFile(root, 'src/app.py', 'print(2)\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '--amend', '--no-edit']);
  const newSha = git(root, ['rev-parse', 'HEAD']);
  assert.notEqual(newSha, headSha, 'amend moved HEAD to a new sha');
  assert.equal(materialClassificationSnapshotStale(snap), true, 'the pinned snapshot is stale after the HEAD move');
  const refreshed = ensureFreshMaterialClassificationSnapshot(snap);
  assert.equal(refreshed.headHash, newSha, 're-resolution binds the rebuilt snapshot to the NEW HEAD sha');
  assert.equal(materialClassificationSnapshotStale(refreshed), false, 'the rebuilt snapshot is internally consistent and current');
});

// ─────────────────── R4 fix-round production-boundary checks ───────────────────

check('R4-a: the exclusion preflight binds to the PINNED sha INSIDE the retry loop — a covered go.mod committed mid-build (after sha capture) is REJECTED, not returned as a snapshot', () => {
  // Base tree: excludePaths:["backend/"] over backend/main.go ONLY (no manifest),
  // so config-only resolution AND the first-attempt pinned-sha preflight both pass
  // clean. The bug (codex HIGH): the old builder ran the preflight against LIVE HEAD
  // before the sha was captured / outside the loop, so a commit landing mid-build
  // yielded a snapshot bound to the NEW sha carrying the now-invalid policy.
  const root = makeGitConfigRoot(
    { materialCode: { excludePaths: ['backend/'] } },
    { 'backend/main.go': 'package main\n' },
  );
  // One-shot seam: on the FIRST head capture, land a NEW commit adding backend/go.mod
  // (a level-1 manifest) UNDER the excluded backend/. This moves HEAD, so the
  // post-build validation forces a rebuild; the SECOND attempt captures the moved
  // sha and the in-loop preflight run against THAT pinned sha sees the covered
  // manifest and rejects. A live-HEAD-only or once-before-the-loop preflight would
  // instead return a snapshot bound to the invalid policy.
  let fired = false;
  const landCoveredManifestOnce = (headRef: string | undefined): void => {
    if (fired) return;
    fired = true;
    void headRef;
    writeFile(root, 'backend/go.mod', 'module example.com/x\n');
    commitAll(root, 'add go.mod under the excluded backend/ mid-build');
  };
  // B-956f FIX 4: the mid-build seam is a MODULE-PRIVATE hook installed via the
  // test-only setter — NOT a public option on the production snapshot builder.
  __setAfterHeadCaptureHookForTest(landCoveredManifestOnce);
  try {
    assert.throws(
      () => buildMaterialClassificationSnapshot(root),
      (err: unknown) => err instanceof MaterialCodePolicyError
        && err.offendingKey === 'materialCode.excludePaths'
        && /backend\/go\.mod/.test(err.message),
      'the pinned-sha preflight rejects the mid-build covered manifest instead of returning a snapshot',
    );
  } finally {
    __setAfterHeadCaptureHookForTest(undefined); // always reset the module-private hook
  }
  assert.equal(fired, true, 'the mid-build commit seam actually fired (the race window was exercised)');
});

check('R4-b: the exclusion preflight scales O(files) not O(exclusions × files) — a tens-of-thousands-file tree resolves well under a generous bound (a future O(n×m) regression trips this)', () => {
  const policy = resolveMaterialCodePolicy(); // default policy: excludePaths empty
  // 20 non-covering exclusion entries + tens of thousands of tracked files, of
  // which only a handful are manifests. The prefiltered candidate set is tiny, so
  // the compare is O(files + exclusions × candidates), not O(files × exclusions).
  const excludePaths = Array.from({ length: 20 }, (_, i) => `vendored-${i}/`);
  const bigPolicy = { ...policy, excludePaths } as typeof policy;
  const files: string[] = [];
  for (let i = 0; i < 30000; i++) files.push(`src/module-${i}/impl.ts`);
  // Real manifests, none under any vendored-* exclusion → verdict must stay clean.
  files.push('go.mod', 'package.json', 'backend/go.mod', 'services/api/pyproject.toml');
  const started = Date.now();
  const verdict = preflightMaterialCodeExclusions(bigPolicy, '/unused-no-git', 'HEAD', files);
  const elapsedMs = Date.now() - started;
  assert.equal(verdict.ok, true, 'no exclusion covers a manifest, so the tree resolves clean');
  assert.ok(
    elapsedMs < 1000,
    `preflight over ${files.length} files with ${excludePaths.length} exclusions must stay well under 1s (was ${elapsedMs}ms); an O(files × exclusions) regression would exceed this`,
  );
});

// ─────────────────── R5 fix-round production-boundary checks ───────────────────

check('R5-a: a non-git root with a covered exclusion FAILS CLOSED through buildMaterialClassificationSnapshot AND a real gate consumer (never a silently-returned unvalidated snapshot)', () => {
  // Non-git project dir (no tree to validate exclusions against) carrying an
  // excludePaths policy. codex H3 = quality F-006 = test-coverage F-007: the old
  // builder gated the tree-bound preflight on `if (headRef)`, so a non-git root
  // returned an UNVALIDATED snapshot (fail open) while resolveMaterialCodePolicy on
  // the same dir correctly threw.
  const root = makeConfigRoot({ materialCode: { excludePaths: ['backend/'] } });

  // (1) The builder now validates on EVERY path: a policy WITH exclusions fails
  // CLOSED through assertMaterialCodeExclusionsAgainstTree's enumeration throw — the
  // SAME behavior class as resolveMaterialCodePolicy.
  assert.throws(
    () => buildMaterialClassificationSnapshot(root),
    (err: unknown) => err instanceof MaterialCodePolicyError
      && err.offendingKey === 'materialCode.excludePaths'
      && /could not enumerate tracked files/.test(err.message)
      && /failing closed/.test(err.message),
    'a non-git root with exclusions fails CLOSED in the builder (no unvalidated snapshot)',
  );
  // Consistency: resolveMaterialCodePolicy fails closed on the same dir the same way.
  assert.throws(
    () => resolveMaterialCodePolicy(root),
    (err: unknown) => err instanceof MaterialCodePolicyError && err.offendingKey === 'materialCode.excludePaths',
    'resolveMaterialCodePolicy fails closed on the same non-git root (same behavior class)',
  );

  // (2) A REAL gate consumer surfaces a STRUCTURED blocking outcome, not a silent pass.
  const fakeStore = { readStory: () => null, readChecklist: () => null } as any;
  let result: ReturnType<typeof evaluateStoryEvidenceBindingGate>;
  assert.doesNotThrow(() => {
    result = evaluateStoryEvidenceBindingGate(root, fakeStore, 'B-lng-nongit', { mode: 'warn' });
  }, 'the repro gate does not throw raw on the non-git fail-closed');
  assert.equal(result!.ok, false, 'the gate fails closed');
  assert.equal(result!.blocking, true, 'the failure blocks regardless of reproFirst mode');
  assert.equal(result!.reasonCode, 'repro_first_material_policy_error', 'distinct material-policy reason code');
});

check('R5-b: a non-git root with NO exclusions still BUILDS a snapshot (no over-blocking) — only exclusions need a tree to validate against', () => {
  const root = makeConfigRoot({ materialCode: { addExtensions: ['zig'] } }); // valid config, NO excludePaths
  let snap: MaterialClassificationSnapshot | undefined;
  assert.doesNotThrow(() => {
    snap = buildMaterialClassificationSnapshot(root, { changedFiles: ['src/app.py', 'docs/x.md'] });
  }, 'a no-exclusions policy on a non-git root builds without throwing (nothing to validate)');
  assert.ok(snap, 'the snapshot is returned');
  assert.equal(snap!.files.find((f) => f.path === 'src/app.py')!.materialCode, true, 'a .py under src/ still classifies material');
  assert.equal(snap!.files.find((f) => f.path === 'docs/x.md')!.materialCode, false, 'a doc stays non-material');
});

check('R5-c: a hand-built policy whose embedded policyDigest does not match its actual fields is REJECTED before any cached verdict can be aliased (cache-poison closed)', () => {
  // Warm the preflight verdict cache with a LEGIT policy over a tree where the
  // exclusion covers NO manifest (clean verdict cached at this HEAD sha). The tree
  // ALSO carries a real backend/go.mod NOT under the legit exclusion.
  const root = makeGitConfigRoot(
    { materialCode: { excludePaths: ['other/'] } },
    { 'backend/go.mod': 'module example.com/x\n', 'other/readme.txt': 'x\n' },
  );
  const legit = resolveMaterialCodePolicy(root); // excludePaths ['other/'] — resolves clean, warms the cache
  assert.deepEqual(legit.excludePaths, ['other/'], 'the legit policy resolved clean and cached its verdict');

  // Hand-build a FORGED policy: excludePaths ['backend/'] (which DOES cover the real
  // backend/go.mod) but stamped with the legit policy's UNRELATED embedded digest, so
  // a digest-keyed cache would alias the legit clean verdict.
  const forged = { ...legit, excludePaths: ['backend/'] } as typeof legit; // policyDigest still == legit's
  assert.notDeepEqual(forged.excludePaths, legit.excludePaths, 'forged policy really differs in excludePaths');
  assert.equal(forged.policyDigest, legit.policyDigest, 'forged policy carries the legit embedded digest (the poison vector)');

  // FIX 3: the builder feeds the forged policy to the tree-bound preflight, which
  // recomputes the digest from the forged fields, sees the mismatch, and REJECTS
  // before any cache lookup — the covered backend/go.mod can never slip through on an
  // aliased clean verdict.
  assert.throws(
    () => buildMaterialClassificationSnapshot(root, { policy: forged }),
    (err: unknown) => err instanceof MaterialCodePolicyError
      && err.offendingKey === 'materialCode.policyDigest'
      && /does not match the digest recomputed/.test(err.message),
    'a forged embedded digest is rejected (no cached-verdict aliasing)',
  );
});

check('R6: wrapper-root layout — a project-relative exclusion covering a real level-1 manifest UNDER the config subdir is REJECTED by the pinned-sha preflight (git ls-tree paths are git-root-relative; excludePaths are project-relative)', () => {
  // Config lives in <root>/project/; git operations run at <root> (gitCwd = git root).
  // The exclusion `backend/` is PROJECT-relative and covers a real project/backend/go.mod
  // whose git-root-relative path is `project/backend/go.mod`. Before FIX 1 the namespace
  // mismatch made this exclusion silently MISS (builder ACCEPTED it); it must now reject.
  const { root, projectRoot } = makeWrapperRootConfigRoot(
    'project',
    { materialCode: { excludePaths: ['backend/'] } },
    { 'project/backend/go.mod': 'module example.com/x\n', 'project/src/keep.py': 'k = 1\n' },
  );
  assert.throws(
    () => buildMaterialClassificationSnapshot(projectRoot, { gitCwd: root }),
    (err: unknown) => err instanceof MaterialCodePolicyError
      && err.offendingKey === 'materialCode.excludePaths'
      && /exclusion covers real level-1 immutable/.test(err.message)
      && /backend\/go\.mod/.test(err.message),
    'the wrapper-root exclusion backend/ covering project/backend/go.mod (project-relative backend/go.mod) is rejected by the pinned-sha preflight',
  );
});

check('R6: wrapper-root layout — classification translates git-root-relative diff paths into the project namespace: a project-relative excludePaths entry applies, and files OUTSIDE the project subtree are ignored', () => {
  // Config in <root>/project/; gitCwd = <root>. The feature diff (enumerated at the git
  // root) yields git-root-relative paths that FIX 1 translates into project-relative
  // paths before classification: project/legacy/ is covered by the project-relative
  // exclusion `legacy/`, and sibling/outside.py is not this project's file.
  const { root, projectRoot } = makeWrapperRootConfigRoot(
    'project',
    { materialCode: { excludePaths: ['legacy/'] } }, // non-manifest dir → preflight stays clean
    { 'project/src/keep.py': 'k = 1\n' },
    {
      'project/src/app.py': 'a = 1\n',        // inside project → material code under src/
      'project/legacy/old.py': 'g = 1\n',     // inside project → EXCLUDED by config excludePaths
      'sibling/outside.py': 'o = 1\n',        // OUTSIDE the project subtree → dropped
    },
  );
  const snap = buildMaterialClassificationSnapshot(projectRoot, { gitCwd: root });
  // Snapshot file paths are PROJECT-relative after the FIX 1 translation.
  const appFile = snap.files.find((f) => f.path === 'src/app.py');
  const legacyFile = snap.files.find((f) => f.path === 'legacy/old.py');
  assert.ok(appFile && appFile.materialCode === true, 'a project-relative code file under src/ classifies material');
  assert.ok(legacyFile, 'the excluded file is enumerated in the project namespace (project/legacy/old.py -> legacy/old.py)');
  assert.equal(legacyFile!.materialCode, false, 'a project-relative excludePaths entry applies to the translated path');
  assert.equal(legacyFile!.reason, 'config excludePaths', 'the exclusion fires via the config excludePaths precedence rule');
  assert.equal(
    snap.files.some((f) => f.path.includes('outside') || f.path.includes('sibling')),
    false,
    "a file OUTSIDE the project subtree is not this project's file and is dropped from the snapshot",
  );
});

// ── R7 (F-008/F-009/F-011/F-013): the wrapper-root translation must engage through
// the EXACT production call shapes — no manual gitCwd in the driven calls. ──

/**
 * Wrapper-root fixture for the R7 consumer-call-shape checks: config in
 * <root>/project/ with a project-relative exclusion, a shebang script
 * project/bin/tool DELETED by the feature diff (old-tree identity — the case a
 * projectRoot-cwd fallback hint read can NEVER recover), and an excluded
 * project/legacy/old.py modified by the diff.
 */
function makeR7WrapperFixture(): { root: string; projectRoot: string } {
  const root = initRepo('proof-or-stop-lngwrap-');
  writeFile(root, 'project/proof-or-stop.config.json', JSON.stringify({
    reproFirstPreflight: { mode: 'warn' },
    materialCode: { excludePaths: ['legacy/'] },
  }, null, 2));
  writeFile(root, 'project/bin/tool', '#!/bin/sh\necho tool\n');
  writeFile(root, 'project/src/keep.py', 'k = 1\n');
  commitAll(root, 'base');
  git(root, ['checkout', '-q', '-b', 'feature']);
  git(root, ['rm', '-q', 'project/bin/tool']);
  writeFile(root, 'project/legacy/old.py', 'g = 1\n');
  commitAll(root, 'change');
  resetConfigCache();
  resetMaterialCodePolicyCache();
  return { root, projectRoot: join(root, 'project') };
}
const r7Checklist = { items: [{ files: { modify: ['bin/tool', 'legacy/old.py'], create: [], test: [] } }] };

check('R7-a: evaluateStoryEvidenceBindingGate (production call shape, NO manual gitCwd) translates wrapper-root paths — the deleted bin/tool script is material, the project-relative exclusion applies', () => {
  const { projectRoot } = makeR7WrapperFixture();
  // Minimal story-backed store: resolveGitCwd inside the gate resolves the
  // signed workspace THROUGH this store (metadata-git-root probe → the wrapper
  // git root); the gate then reads the same story/checklist for classification.
  const store = {
    readStory: () => ({ storyId: 'B-lng-wrap', phase: 'DEV', type: 'bug', priority: 'medium', riskSignals: [] }),
    readChecklist: () => r7Checklist,
    storyDirPath: (id: string) => join(projectRoot, '.proof-or-stop', 'story', 'actives', id),
  } as any;
  const result = evaluateStoryEvidenceBindingGate(projectRoot, store, 'B-lng-wrap', { mode: 'enforce' });
  // Pre-FIX the snapshot held UNTRANSLATED repo-relative paths (project/bin/tool →
  // default non-material; the deleted script's old-tree identity unreachable from a
  // projectRoot-cwd hint read) → required=false, gate silently ok. Post-FIX the
  // declared bin/tool matches the translated snapshot entry (old-tree shebang) and
  // the story is repro-first required with no binding.
  assert.equal(result.required, true, 'the deleted wrapper-root bin/tool script classifies material through the production gate call');
  assert.equal(result.reasonCode, 'missing_story_evidence_binding', 'repro-first requirement surfaces (no binding bound)');
  assert.equal(result.ok, false, 'enforce mode blocks');
  assert.equal(result.blocking, true, 'enforce mode blocks the transition');
  const details = (result.requirementDetails ?? []).join(' | ');
  assert.ok(/material code files: .*bin\/tool/.test(details), `requirement details name the translated bin/tool (got: ${details})`);
  assert.ok(!details.includes('legacy/old.py'), 'the project-relative excludePaths entry applies through the production call shape');
});

check('R7-b: story_create STORY_INTAKE preflight (production call shape, NO manual gitCwd) translates wrapper-root paths and flags the repro-first requirement', () => {
  const { projectRoot } = makeR7WrapperFixture();
  const rendered = renderReproFirstStoryCreatePreflight({
    projectRoot,
    storyId: 'B-lng-wrap2',
    name: 'wrapper-root-intake',
    title: 'wrapper root intake sample',
    description: 'change the deleted tool script behavior',
    type: 'bug',
    phase: 'INIT',
    priority: 'medium',
    checklist: r7Checklist as any,
  });
  // Pre-FIX the untranslated snapshot classified NO material code → the preflight
  // returned '' (not required). Post-FIX it warns with the missing-binding reason.
  assert.ok(rendered.includes('missing_story_evidence_binding'), `STORY_INTAKE preflight flags the repro-first requirement (got: ${JSON.stringify(rendered)})`);
  assert.ok(rendered.includes('bin/tool'), 'the classifier names the translated material bin/tool');
  assert.ok(!rendered.includes('legacy/old.py'), 'the excluded legacy/old.py is not reported as material');
});

check('R7-c: classifyDeclaredPaths fallback translates a declared PROJECT-relative extensionless script into the git namespace before the working-tree hint read (FIX 2)', () => {
  // bin/deploy is committed on the BASE (off-diff → absent from the snapshot file
  // set → the fallback hint path is exercised) and present in the working tree at
  // <root>/project/bin/deploy with a shebang and no exec bit.
  const { root, projectRoot } = makeWrapperRootConfigRoot(
    'project',
    { materialCode: {} },
    { 'project/bin/deploy': '#!/usr/bin/env python3\nprint(1)\n', 'project/src/keep.py': 'k = 1\n' },
    { 'project/src/app.py': 'a = 1\n' },
  );
  const snap = buildMaterialClassificationSnapshot(projectRoot, { gitCwd: root });
  assert.equal(snap.files.some((f) => f.path.endsWith('bin/deploy')), false, 'bin/deploy is off-diff — classification must come from the declared-path fallback');
  const [declared] = classifyDeclaredPaths(snap, ['bin/deploy']);
  // Without the reverse translation the hint read stats <gitRoot>/bin/deploy (absent)
  // and ls-trees the git namespace bin/deploy (absent) → shebang lost → non-material.
  assert.equal(declared.materialCode, true, 'the declared extensionless script keeps its shebang signal in a wrapper-root layout');
  assert.equal(declared.reason, 'extensionless shebang/executable script', 'material via the shebang/exec rule, not an extension accident');
});

check('R7-d: a BARE buildMaterialClassificationSnapshot(projectRoot) — no gitCwd option — resolves the wrapper git root itself and translates (safe default)', () => {
  const { root, projectRoot } = makeWrapperRootConfigRoot(
    'project',
    { materialCode: { excludePaths: ['legacy/'] } },
    { 'project/src/keep.py': 'k = 1\n' },
    {
      'project/src/app.py': 'a = 1\n',      // inside project → material
      'project/legacy/old.py': 'g = 1\n',   // inside project → excluded by config
      'sibling/outside.py': 'o = 1\n',      // outside the project subtree → dropped
    },
  );
  const snap = buildMaterialClassificationSnapshot(projectRoot); // production default — no override anywhere
  assert.equal(snap.gitCwd, git(root, ['rev-parse', '--show-toplevel']), 'the default gitCwd resolves to the wrapper git toplevel, not projectRoot');
  const appFile = snap.files.find((f) => f.path === 'src/app.py');
  const legacyFile = snap.files.find((f) => f.path === 'legacy/old.py');
  assert.ok(appFile && appFile.materialCode === true, 'project code under src/ classifies material through the safe default');
  assert.ok(legacyFile && legacyFile.materialCode === false && legacyFile.reason === 'config excludePaths', 'the project-relative exclusion applies through the safe default');
  assert.equal(snap.files.some((f) => f.path.includes('sibling') || f.path.includes('outside')), false, 'outside-project files are dropped through the safe default');
});

// ── R8 (quality F-014 + test-coverage F-015): the story_review diagnostic-input
// builder's distinguishing value over the SAFE DEFAULT is STORY-AWARE git-root
// resolution. buildMaterialClassificationSnapshot's default gitCwd
// (resolveDefaultSnapshotGitCwd, material-code-policy.ts) is project-root based —
// it probes the metadataRoot's OWN git toplevel (or a configured gitRoot). The
// story_review builder instead threads resolveGitCwd(store, storyId, …), whose
// FIRST resolution branch is the STORY's registered worktree
// (resolveStorySignedWorkspace: story.worktree.path → story-worktree). When a
// story's worktree is a DIFFERENT git root than the project default — the norm in
// the multi-worktree story flow (`.worktrees/B-xxxx` on `story/B-xxxx`) — the two
// resolutions diverge, and only the story-aware one enumerates the STORY's tree.
//
// F-015 correction: R7-d already proves the SAFE DEFAULT resolves a wrapper git
// toplevel and translates. A bare one-arg revert of this site
// (tryBuildMaterialClassificationSnapshotForDiagnostics(projectRoot)) would be
// RESCUED by that same safe default whenever the story worktree == the project
// default root — so a wrapper-root-only R8-a would duplicate R7-d and its
// "revert-proof" claim would be hollow. This fixture makes the two resolutions
// DIFFER (story worktree = separate repo B; project default = repo A) so the bare
// revert observably fails: it resolves repo A, never the story's repo B. ──

/**
 * F-015 fixture: two SEPARATE git repos whose resolutions diverge.
 *   repoA — the metadata/project root (`<repoA>/project`, config here). This is
 *           what resolveDefaultSnapshotGitCwd (the bare-call safe default) picks:
 *           it probes projectRoot's OWN git toplevel = repoA. Its main...HEAD diff
 *           adds src/appA.go.
 *   repoB — a DISTINCT git repo registered as the story's worktree
 *           (story.worktree.path). resolveGitCwd's story-worktree branch resolves
 *           THIS root (story-aware). Its main...HEAD diff adds src/appB.go.
 * The two roots — and thus the two enumerated diffs — are observably different.
 */
function makeR8StoryAwareFixture(): {
  projectRoot: string; repoAToplevel: string; repoBToplevel: string; storyBranch: string;
} {
  const { root: repoA, projectRoot } = makeWrapperRootConfigRoot(
    'project',
    { materialCode: {} },
    { 'project/src/keepA.py': 'k = 1\n' },
    { 'project/src/appA.go': 'package a\n' }, // repoA (default-root) diff
  );
  // makeGitRepo leaves HEAD on `feature`; that is the story worktree's branch.
  const repoB = makeGitRepo(
    { 'src/keepB.py': 'k = 1\n' },
    { 'src/appB.go': 'package b\n' }, // repoB (story-worktree) diff
  );
  const repoAToplevel = git(repoA, ['rev-parse', '--show-toplevel']);
  const repoBToplevel = git(repoB, ['rev-parse', '--show-toplevel']);
  resetConfigCache();
  resetMaterialCodePolicyCache();
  return { projectRoot, repoAToplevel, repoBToplevel, storyBranch: 'feature' };
}

check('R8-a: story_review diagnostic builder (buildStoryReviewMaterialClassification) resolves the STORY worktree via resolveGitCwd (story-aware) — NOT the project default git root (revert-proof: the bare one-arg call resolves the DEFAULT root instead)', () => {
  const { projectRoot, repoAToplevel, repoBToplevel, storyBranch } = makeR8StoryAwareFixture();
  // The story is registered against repoB (a distinct git root). resolveGitCwd's
  // FIRST branch — story.worktree.path — resolves it THROUGH this store, so the
  // snapshot enumerates repoB's tree, not the project default root (repoA).
  const store = {
    readStory: () => ({
      storyId: 'B-lng-wrap3',
      phase: 'DEV',
      type: 'bug',
      priority: 'medium',
      riskSignals: [],
      worktree: { path: repoBToplevel, branch: storyBranch },
    }),
    readChecklist: () => r7Checklist,
    storyDirPath: (id: string) => join(projectRoot, '.proof-or-stop', 'story', 'actives', id),
  } as any;

  // Precondition: the two resolutions genuinely differ (else R8-a would just
  // re-prove R7-d's safe default).
  assert.notEqual(repoBToplevel, repoAToplevel, 'the story worktree (repoB) and the project default root (repoA) are distinct git roots');

  const snap = buildStoryReviewMaterialClassification(store, 'B-lng-wrap3', projectRoot);
  assert.ok(snap, 'the diagnostic snapshot builds (fail-safe undefined is only for a resolver/policy throw)');
  // STORY-AWARE resolution: gitCwd is the story's worktree (repoB), NOT the
  // metadata/project default root (repoA).
  assert.equal(snap!.gitCwd, repoBToplevel, 'resolveGitCwd resolved the STORY worktree (repoB), the story-aware git root');
  assert.notEqual(snap!.gitCwd, repoAToplevel, 'the story-aware resolution is NOT the project default git root (repoA)');
  // The enumerated diff is repoB's, confirming the snapshot reflects the story tree.
  const appB = snap!.files.find((f) => f.path === 'src/appB.go');
  assert.ok(appB && appB.materialCode === true, 'the snapshot enumerates repoB (the story worktree) main...HEAD diff — src/appB.go is material');
  assert.equal(snap!.files.some((f) => f.path.includes('appA')), false, 'no repoA (default-root) file leaks into the story-aware snapshot');

  // GENUINE REVERT-PROOF (baked-in negative control): the pre-R7 bare one-arg form
  // — tryBuildMaterialClassificationSnapshotForDiagnostics(projectRoot), i.e.
  // buildStoryReviewMaterialClassification WITHOUT the resolveGitCwd thread — falls
  // through to the SAFE DEFAULT (resolveDefaultSnapshotGitCwd), which resolves the
  // project's OWN git toplevel = repoA, NEVER the story's repoB. So the two
  // assertions above (snap.gitCwd === repoB / enumerates src/appB.go) FAIL under
  // that revert. This is exactly the divergence R7-d cannot exhibit — R7-d has one
  // repo, so its default and any story-aware resolution coincide.
  const reverted = tryBuildMaterialClassificationSnapshotForDiagnostics(projectRoot);
  assert.ok(reverted, 'the bare-call control snapshot builds');
  assert.equal(reverted!.gitCwd, repoAToplevel, 'the bare one-arg revert resolves the project DEFAULT git root (repoA)');
  assert.notEqual(reverted!.gitCwd, repoBToplevel, 'the bare revert loses story-awareness — it never reaches the story worktree (repoB)');
  const revertedAppA = reverted!.files.find((f) => f.path === 'src/appA.go');
  assert.ok(revertedAppA && revertedAppA.materialCode === true, 'the reverted default snapshot enumerates repoA (src/appA.go), not the story tree');
  assert.equal(reverted!.files.some((f) => f.path.includes('appB')), false, 'the bare revert never sees the story worktree diff (src/appB.go)');
});

for (const root of tempRoots) {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort cleanup */ }
}

if (failures === 0) {
  console.log('\nlanguage-neutral-gates smoke passed (39 checks: 12 verificationIntent lanes + 6 fix-round production-wiring checks + 5 R2 fix-round production-boundary checks + 4 R3 fix-round production-boundary checks + 2 R4 fix-round production-boundary checks + 3 R5 fix-round production-boundary checks + 2 R6 wrapper-root path-namespace checks + 4 R7 production-call-shape wrapper-root checks + 1 R8 story-review story-aware git-root resolution check (revert-proof against the bare project-default call))');
} else {
  console.error(`\nlanguage-neutral-gates smoke FAILED (${failures})`);
  process.exit(1);
}
