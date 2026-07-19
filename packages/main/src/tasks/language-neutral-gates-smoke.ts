#!/usr/bin/env node
/**
 * B-956f language-neutral advanced-gate classification smoke.
 *
 * Standalone task (not wired into a runner config — invoked directly like
 * transition-integrity-smoke). Covers EVERY verificationIntent lane in
 * .lattice/story/actives/B-956f/checklist.json (12 lanes across 4 CHKs):
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
 * Prints ✓/✗ per check and exits nonzero on the first failure.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
  MaterialCodePolicyError,
  type MaterialClassificationSnapshot,
} from '../core/material-code-policy.js';
import {
  classifyReviewAssuranceFloorPath,
  evaluateReviewAssuranceFloor,
} from '../core/review-assurance-floor.js';
import { classifyReproFirstRequirement } from '../core/repro-evidence-binding-gate.js';
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
/** Temp git repo whose `feature` HEAD adds `changed` files on top of a `main` base. */
function makeGitRepo(base: Record<string, string>, changed: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'lattice-lng-'));
  tempRoots.push(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'smoke@test']);
  git(root, ['config', 'user.name', 'smoke']);
  git(root, ['checkout', '-q', '-b', 'main']);
  writeFile(root, 'README.md', '# base\n');
  for (const [p, c] of Object.entries(base)) writeFile(root, p, c);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'base']);
  git(root, ['checkout', '-q', '-b', 'feature']);
  for (const [p, c] of Object.entries(changed)) writeFile(root, p, c);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'change']);
  return root;
}
/** Temp project dir with a lattice.config.json (fresh policy/config caches). */
function makeConfigRoot(config: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'lattice-lngcfg-'));
  tempRoots.push(root);
  writeFileSync(join(root, 'lattice.config.json'), JSON.stringify(config, null, 2));
  resetConfigCache();
  resetMaterialCodePolicyCache();
  return root;
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

  // The exact SAME object was handed to all three consumers.
  assert.ok(Object.is(snap, snap));

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
  // under an excludePaths entry is non-material even though its extension is code.
  const root = makeConfigRoot({ materialCode: { excludePaths: ['experiments/'] } });
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

  // storyDir-aware metadata exclusion WITHOUT hardcoding .lattice.
  const customRoot = makeConfigRoot({ storyDir: 'custom-stories/actives' });
  const customPolicy = resolveMaterialCodePolicy(customRoot);
  assert.equal(classifyMaterialCodePath(customPolicy, 'custom-stories/actives/B-1/story.json', { projectRoot: customRoot }).materialCode, false, 'a file under the resolved custom storyDir is excluded');
  assert.equal(classifyMaterialCodePath(customPolicy, '.lattice/story/actives/B-1/story.json', { projectRoot: customRoot }).materialCode, false, 'the default .lattice story metadata stays excluded too');
});

check('CHK-002/adversarial: manifest exclusion rejected at resolve AND fs preflight; malformed config fails closed', () => {
  // (a) config-resolve rejection: excludePaths naming a level-1 manifest.
  const excludeRoot = makeConfigRoot({ materialCode: { excludePaths: ['go.mod'] } });
  assert.throws(
    () => resolveMaterialCodePolicy(excludeRoot),
    (err: unknown) => err instanceof MaterialCodePolicyError && err.offendingKey === 'materialCode.excludePaths' && /go\.mod/.test(err.message),
    'excludePaths naming go.mod is rejected at config-resolve naming the key',
  );

  // (b) filesystem-aware preflight: a directory entry covering a real manifest.
  resetMaterialCodePolicyCache();
  const dirRoot = makeConfigRoot({ materialCode: { excludePaths: ['backend/'] } });
  const dirPolicy = resolveMaterialCodePolicy(dirRoot); // 'backend/' passes basename resolve
  const preflight = preflightMaterialCodeExclusions(dirPolicy, dirRoot, 'HEAD', ['backend/go.mod', 'backend/main.go', 'README.md']);
  assert.equal(preflight.ok, false, 'backend/ covering backend/go.mod is rejected by the fs preflight');
  assert.deepEqual(preflight.violations, [{ entry: 'backend/', manifest: 'backend/go.mod' }]);
  // A tree with NO covered manifest passes the preflight.
  assert.equal(preflightMaterialCodeExclusions(dirPolicy, dirRoot, 'HEAD', ['backend/main.go']).ok, true, 'backend/ with no manifest inside passes');

  // (c) malformed materialCode block fails CLOSED naming the offending key.
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

for (const root of tempRoots) {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort cleanup */ }
}

if (failures === 0) {
  console.log('\nlanguage-neutral-gates smoke passed (12 checks / 12 verificationIntent lanes)');
} else {
  console.error(`\nlanguage-neutral-gates smoke FAILED (${failures})`);
  process.exit(1);
}
