#!/usr/bin/env node
/**
 * @task B-6bfd
 * @checklist CHK-003
 * @title semantic scope guard smoke coverage
 * @type feature
 * @priority high
 * @description
 *   Logic-level smoke coverage for the semantic hunk gate (CHK-003):
 *   - allowed file + allowed anchor passes
 *   - v1 (path-only) contracts skip the semantic gate entirely
 *   - allowed file touching a denied/protected anchor fails even when the path
 *     is allowed, and the gate escalates a path-pass result to fail
 *   - acknowledgements by hunkDigest / anchor downgrade denied anchors to warn,
 *     but protected anchors stay blocking even when acknowledged
 *   - lifecycle-facing render output shows "Semantic scope gate: pass/fail"
 *     with the violating path, anchor, and hunkDigest
 * @changes
 *   - [CHK-003] Verify checkSemanticScope / mergeSemanticScopeResult / render
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ChecklistData,
  ReviewRun,
  ReviewScopeBinding,
  ScopeContractAcknowledgement,
  ScopeContractData,
  ScopeContractMode,
  ScopeDiffHunk,
  ScopeDiffPack,
  StoryInfo,
  FileRule,
} from '../core/types.js';
import { checkScopeContract, renderScopeCheckResult } from '../core/scope-contract.js';
import {
  checkSemanticScope,
  isSemanticContract,
  mergeSemanticScopeResult,
} from '../core/semantic-scope-gate.js';
import {
  resolveGuardMode,
  providerSupportsPreToolBlocking,
  buildGuardSession,
  digestScopeContract,
  detectGuardViolations,
  applyGuardCheck,
  guardSessionHasBlockingViolations,
  guardSessionStateLabel,
  renderGuardSessionLine,
} from '../core/guard-session.js';
import {
  computeReviewScopeBinding,
  compareScopeBinding,
  verifyReviewScopeBinding,
  buildCurrentScopeContext,
  materialDiffPackDigest,
  signReviewScopeBinding,
  buildScopeProtectionSummary,
  computeReviewHashFreshness,
  renderScopeProtectionSummary,
} from '../core/review-scope-binding.js';
import { StoryStore } from '../core/store.js';
import { resetConfigCache } from '../core/config.js';
import { collectReviewerEvidenceState, currentScopeContextForStory, signReviewRun } from '../core/review-run.js';
import { getGuardFailureReason } from '../core/machine.js';
import { signFinding, signReviewPass } from '../core/finding-verify.js';
import { buildScopeDiffPack } from '../core/scope-diff-pack.js';
import { createScopeContractHandlers } from '../handlers/scope-contract.js';
import type { HandlerContext } from '../handlers/context.js';

function makeContract(overrides: Partial<ScopeContractData> & { mode: ScopeContractMode }): ScopeContractData {
  const now = new Date().toISOString();
  return {
    storyId: 'B-semantic',
    mode: overrides.mode,
    allowedModify: overrides.allowedModify ?? [],
    allowedCreate: overrides.allowedCreate ?? [],
    allowedTest: overrides.allowedTest ?? [],
    protectedFiles: overrides.protectedFiles ?? [],
    explicitExcludes: overrides.explicitExcludes ?? [],
    acknowledgements: overrides.acknowledgements ?? [],
    createdAt: now,
    updatedAt: now,
    ...(overrides.fileRules ? { fileRules: overrides.fileRules } : {}),
    ...(overrides.protectedAnchors ? { protectedAnchors: overrides.protectedAnchors } : {}),
  };
}

let hunkSeq = 0;
function makeHunk(path: string, opts: { anchor?: string; keyPath?: string; changeKind?: ScopeDiffHunk['changeKind']; digest?: string } = {}): ScopeDiffHunk {
  hunkSeq += 1;
  return {
    path,
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    header: `@@ -1 +1 @@ ${path} #${hunkSeq}`,
    hunkDigest: opts.digest ?? `deadbeef${hunkSeq.toString(16).padStart(8, '0')}`,
    ...(opts.anchor ? { anchor: opts.anchor } : {}),
    ...(opts.keyPath ? { keyPath: opts.keyPath } : {}),
    changeKind: opts.changeKind ?? 'modify',
  };
}

function makePack(hunks: ScopeDiffHunk[]): ScopeDiffPack {
  return {
    diffPackHash: 'pack-hash',
    changedFiles: [...new Set(hunks.map((h) => h.path))].sort(),
    hunks,
    generatedAt: new Date().toISOString(),
  };
}

function mergedFor(contract: ScopeContractData, pack: ScopeDiffPack) {
  return mergeSemanticScopeResult(
    checkScopeContract(contract, pack.changedFiles),
    checkSemanticScope(contract, pack),
  );
}

// ── 1. Happy: allowed file + allowed anchor passes ──────────────────────────
{
  const allowRule: FileRule = { path: 'src/allowed.ts', allowedAnchors: ['publicFn'] };
  const contract = makeContract({
    mode: 'enforce',
    allowedModify: ['src/allowed.ts'],
    fileRules: [allowRule],
  });
  const pack = makePack([makeHunk('src/allowed.ts', { anchor: 'publicFn' })]);
  const semantic = checkSemanticScope(contract, pack);
  assert.equal(semantic.status, 'pass', 'allowed file + allowed anchor must pass semantic gate');
  assert.equal(semantic.violations.length, 0, 'allowed anchor must produce no violations');

  const merged = mergedFor(contract, pack);
  assert.equal(merged.status, 'pass', 'merged path+semantic must pass for allowed anchor');
  const rendered = renderScopeCheckResult(merged);
  assert.match(rendered, /Semantic scope gate: pass/, 'render must surface "Semantic scope gate: pass"');
}

// ── 2. Edge: v1 (path-only) contracts skip the semantic gate ────────────────
{
  const v1 = makeContract({ mode: 'enforce', allowedModify: ['src/allowed.ts'] });
  assert.equal(isSemanticContract(v1), false, 'contract with no fileRules/protectedAnchors is v1');
  const pack = makePack([makeHunk('src/allowed.ts', { anchor: 'anything' })]);
  const semantic = checkSemanticScope(v1, pack);
  assert.equal(semantic.status, 'skip', 'v1 contract must skip semantic gate');

  const merged = mergedFor(v1, pack);
  assert.equal(merged.semantic, undefined, 'v1 merge must not attach a semantic block (path-only)');
  const rendered = renderScopeCheckResult(merged);
  assert.doesNotMatch(rendered, /Semantic scope gate/, 'v1 render must stay path-only');
}

// ── 3. Adversarial: allowed file touching a DENIED anchor fails ─────────────
{
  const contract = makeContract({
    mode: 'enforce',
    allowedModify: ['src/allowed.ts'],
    fileRules: [{ path: 'src/allowed.ts', deniedAnchors: ['secretFn'] }],
  });
  const hunk = makeHunk('src/allowed.ts', { anchor: 'secretFn' });
  const pack = makePack([hunk]);

  // path gate alone passes (file path is allowed)
  const pathOnly = checkScopeContract(contract, pack.changedFiles);
  assert.equal(pathOnly.status, 'pass', 'path gate alone must pass for an allowed file');

  const semantic = checkSemanticScope(contract, pack);
  assert.equal(semantic.status, 'fail', 'denied anchor on an allowed file must fail semantic gate');

  const merged = mergedFor(contract, pack);
  assert.equal(merged.status, 'fail', 'semantic fail must escalate a path-pass result to fail');
  const rendered = renderScopeCheckResult(merged);
  assert.match(rendered, /Semantic scope gate: fail/, 'render must surface "Semantic scope gate: fail"');
  assert.match(rendered, /DENIED_ANCHOR: src\/allowed\.ts/, 'render must name the violating path');
  assert.match(rendered, /anchor=secretFn/, 'render must name the violating anchor');
  assert.match(rendered, new RegExp(`hunkDigest=${hunk.hunkDigest}`), 'render must name the violating hunkDigest');
}

// ── 3b. Adversarial: allowed file touching a PROTECTED anchor fails ─────────
{
  const contract = makeContract({
    mode: 'enforce',
    allowedModify: ['src/allowed.ts'],
    fileRules: [{ path: 'src/allowed.ts', protectedAnchors: ['criticalFn'] }],
  });
  const pack = makePack([makeHunk('src/allowed.ts', { anchor: 'criticalFn' })]);
  const semantic = checkSemanticScope(contract, pack);
  assert.equal(semantic.status, 'fail', 'protected anchor on an allowed file must fail');
  assert.ok(
    semantic.violations.some((v) => v.rule === 'protected_anchor' && v.anchor === 'criticalFn'),
    'protected anchor violation must be reported',
  );
}

// ── 3c. Global protectedAnchors also block ──────────────────────────────────
{
  const contract = makeContract({
    mode: 'enforce',
    allowedModify: ['src/allowed.ts'],
    protectedAnchors: ['globalGuard'],
  });
  const pack = makePack([makeHunk('src/allowed.ts', { anchor: 'globalGuard' })]);
  assert.equal(isSemanticContract(contract), true, 'global protectedAnchors makes contract v2');
  assert.equal(checkSemanticScope(contract, pack).status, 'fail', 'global protected anchor must block');
}

// ── 4a. Acknowledgement by hunkDigest downgrades a denied anchor to warn ─────
{
  const hunk = makeHunk('src/allowed.ts', { anchor: 'secretFn' });
  const ack: ScopeContractAcknowledgement = {
    actor: 'main-agent',
    reason: 'Deliberate edit to the denied anchor for migration, reviewed by lead.',
    timestamp: new Date().toISOString(),
    paths: ['src/allowed.ts'],
    hunkDigest: hunk.hunkDigest,
  };
  const contract = makeContract({
    mode: 'enforce',
    allowedModify: ['src/allowed.ts'],
    fileRules: [{ path: 'src/allowed.ts', deniedAnchors: ['secretFn'] }],
    acknowledgements: [ack],
  });
  const semantic = checkSemanticScope(contract, makePack([hunk]));
  assert.equal(semantic.status, 'warn', 'acknowledged denied anchor (by digest) must warn, not fail');
  assert.equal(semantic.violations.length, 0, 'acknowledged denied anchor must not be a blocking violation');
  assert.ok(semantic.warnings.some((w) => w.acknowledged && w.anchor === 'secretFn'), 'ack must surface as warning');
}

// ── 4b. Acknowledgement by anchor downgrades a denied anchor to warn ─────────
{
  const hunk = makeHunk('src/allowed.ts', { anchor: 'secretFn' });
  const ack: ScopeContractAcknowledgement = {
    actor: 'main-agent',
    reason: 'Anchor-level acknowledgement of the denied anchor for this story.',
    timestamp: new Date().toISOString(),
    paths: ['src/allowed.ts'],
    anchors: ['secretFn'],
  };
  const contract = makeContract({
    mode: 'enforce',
    allowedModify: ['src/allowed.ts'],
    fileRules: [{ path: 'src/allowed.ts', deniedAnchors: ['secretFn'] }],
    acknowledgements: [ack],
  });
  assert.equal(checkSemanticScope(contract, makePack([hunk])).status, 'warn', 'acknowledged denied anchor (by anchor) must warn');
}

// ── 4c. Acknowledgement CANNOT downgrade a protected anchor ──────────────────
{
  const hunk = makeHunk('src/allowed.ts', { anchor: 'criticalFn' });
  const ack: ScopeContractAcknowledgement = {
    actor: 'main-agent',
    reason: 'Attempting to acknowledge a protected anchor — must still block.',
    timestamp: new Date().toISOString(),
    paths: ['src/allowed.ts'],
    hunkDigest: hunk.hunkDigest,
    anchors: ['criticalFn'],
  };
  const contract = makeContract({
    mode: 'enforce',
    allowedModify: ['src/allowed.ts'],
    fileRules: [{ path: 'src/allowed.ts', protectedAnchors: ['criticalFn'] }],
    acknowledgements: [ack],
  });
  assert.equal(checkSemanticScope(contract, makePack([hunk])).status, 'fail', 'protected anchor must block even when acknowledged');
}

// ── 5. Shadow mode: only protected anchors block; denied are advisory ────────
{
  const deniedContract = makeContract({
    mode: 'shadow',
    allowedModify: ['src/allowed.ts'],
    fileRules: [{ path: 'src/allowed.ts', deniedAnchors: ['secretFn'] }],
  });
  assert.equal(
    checkSemanticScope(deniedContract, makePack([makeHunk('src/allowed.ts', { anchor: 'secretFn' })])).status,
    'warn',
    'shadow mode must warn (not fail) on a denied anchor',
  );

  const protectedContract = makeContract({
    mode: 'shadow',
    allowedModify: ['src/allowed.ts'],
    fileRules: [{ path: 'src/allowed.ts', protectedAnchors: ['criticalFn'] }],
  });
  assert.equal(
    checkSemanticScope(protectedContract, makePack([makeHunk('src/allowed.ts', { anchor: 'criticalFn' })])).status,
    'fail',
    'shadow mode must still fail on a protected anchor',
  );
}

// ── 6. Disallowed changeKind is gated; story/koala metadata is never gated ───
{
  const contract = makeContract({
    mode: 'enforce',
    allowedModify: ['src/allowed.ts'],
    fileRules: [{ path: 'src/allowed.ts', allowedChangeKinds: ['modify'] }],
  });
  assert.equal(
    checkSemanticScope(contract, makePack([makeHunk('src/allowed.ts', { anchor: 'fn', changeKind: 'remove' })])).status,
    'fail',
    'disallowed changeKind must fail',
  );

  const metaContract = makeContract({
    mode: 'enforce',
    protectedAnchors: ['criticalFn'],
  });
  assert.equal(
    checkSemanticScope(metaContract, makePack([makeHunk('docs/story/actives/B-x/index.json', { anchor: 'criticalFn' })])).status,
    'pass',
    'story metadata hunks must never be semantically gated',
  );
}

// ── 7. CHK-004 Happy: guard_session_start records provider/guardMode/hash ─────
//   Guard mode truth: claude-code requires nativeHookVerified=true for native-pretool;
//   without it, falls back to watcher-fallback. viaDispatch is irrelevant for Claude Code.
{
  const contract = makeContract({
    mode: 'enforce',
    allowedModify: ['src/allowed.ts'],
    protectedAnchors: ['criticalFn'],
  });
  const scopeContractHash = digestScopeContract(contract);
  assert.match(scopeContractHash, /^[0-9a-f]{64}$/, 'scopeContractHash must be a sha256 hex digest');

  assert.equal(providerSupportsPreToolBlocking('claude-code'), true, 'claude-code CAN support native pre-tool blocking');

  // native-pretool only when hook is verified
  assert.equal(
    resolveGuardMode('claude-code', { nativeHookVerified: true }),
    'native-pretool',
    'claude-code + nativeHookVerified=true → native-pretool',
  );
  // without hook verification, falls back
  assert.equal(
    resolveGuardMode('claude-code'),
    'watcher-fallback',
    'claude-code without nativeHookVerified context → watcher-fallback (avoids overclaiming)',
  );

  // Session built with hook verified
  const session = buildGuardSession({
    storyId: 'B-guard',
    provider: 'claude-code',
    scopeContractHash,
    context: { nativeHookVerified: true },
  });
  assert.equal(session.provider, 'claude-code', 'guard session records provider');
  assert.equal(session.guardMode, 'native-pretool', 'guard session records native-pretool when hook verified');
  assert.equal(session.scopeContractHash, scopeContractHash, 'guard session records scopeContractHash');
  assert.equal(session.status, 'active', 'fresh guard session starts active');
  assert.equal(session.violations.length, 0, 'fresh guard session has no violations');
  assert.equal(guardSessionStateLabel(session), 'native-pretool', 'native-pretool session renders as native-pretool');
  assert.match(renderGuardSessionLine(session), /guard session: native-pretool/, 'session_brief line shows native-pretool');

  // Digest stability: same contract → same hash; changed rules → different hash.
  assert.equal(digestScopeContract(contract), scopeContractHash, 'digestScopeContract is stable for identical contracts');
  const changed = makeContract({ mode: 'enforce', allowedModify: ['src/allowed.ts', 'src/extra.ts'], protectedAnchors: ['criticalFn'] });
  assert.notEqual(digestScopeContract(changed), scopeContractHash, 'changing scope rules changes the hash');
}

// ── 8. CHK-004 Edge: watcher-fallback when no interception context available ─
{
  assert.equal(providerSupportsPreToolBlocking('codex'), false, 'codex is not a native-pretool provider');
  assert.equal(resolveGuardMode('codex'), 'watcher-fallback', 'codex without dispatch context → watcher-fallback');
  assert.equal(resolveGuardMode('codex', { viaDispatch: false }), 'watcher-fallback', 'codex + viaDispatch=false → watcher-fallback');

  const session = buildGuardSession({ storyId: 'B-guard', provider: 'codex' });
  assert.equal(session.guardMode, 'watcher-fallback', 'guard session records watcher-fallback when no dispatch context');
  assert.equal(guardSessionStateLabel(session), 'watcher-fallback', 'watcher-fallback session renders as watcher-fallback');
  assert.match(renderGuardSessionLine(session), /guard session: watcher-fallback/, 'session_brief line shows watcher-fallback');

  // Absent session reads as inactive (legacy / never-started stories).
  assert.equal(guardSessionStateLabel(null), 'inactive', 'no guard session renders as inactive');
  assert.match(renderGuardSessionLine(null), /guard session: inactive/, 'session_brief line shows inactive for no session');
}

// ── 9. CHK-004 Adversarial: a simulated forbidden write blocks lifecycle ─────
{
  // Contract allows only src/allowed.ts; touching a protected file is forbidden.
  const contract = makeContract({
    mode: 'enforce',
    allowedModify: ['src/allowed.ts'],
    protectedFiles: ['src/protected.ts'],
  });
  const emptyPack = makePack([]); // clean real diff — only the simulated write is forbidden
  const session = buildGuardSession({ storyId: 'B-guard', provider: 'codex', scopeContractHash: digestScopeContract(contract) });

  // No forbidden write yet → no violations, no block.
  const cleanViolations = detectGuardViolations(contract, emptyPack, []);
  assert.equal(cleanViolations.length, 0, 'clean diff produces no guard violations');
  const cleanSession = applyGuardCheck(session, cleanViolations);
  assert.equal(cleanSession.status, 'active', 'clean check keeps session active');
  assert.equal(guardSessionHasBlockingViolations(cleanSession), false, 'clean session does not block lifecycle');

  // Simulated forbidden write to a protected file → recorded as a violation.
  const violations = detectGuardViolations(contract, emptyPack, ['src/protected.ts']);
  assert.equal(violations.length, 1, 'a simulated forbidden write is recorded as exactly one violation');
  assert.equal(violations[0].path, 'src/protected.ts', 'violation names the forbidden path');
  assert.equal(violations[0].rule, 'protected', 'violation names the violated rule');
  assert.equal(violations[0].simulated, true, 'simulated forbidden write is flagged as simulated');

  const blocked = applyGuardCheck(session, violations);
  assert.equal(blocked.status, 'violations_detected', 'recorded forbidden write moves session to violations_detected');
  assert.equal(guardSessionStateLabel(blocked), 'violations detected', 'session renders as violations detected');
  assert.equal(guardSessionHasBlockingViolations(blocked), true, 'recorded forbidden write blocks lifecycle progression');

  // Mode-independence: a guard session escalates protection even for shadow mode.
  const shadowContract = makeContract({ mode: 'shadow', allowedModify: ['src/allowed.ts'] });
  const outOfScope = detectGuardViolations(shadowContract, emptyPack, ['src/rogue.ts']);
  assert.ok(outOfScope.some((v) => v.path === 'src/rogue.ts' && v.rule === 'out_of_scope'),
    'guard detection is mode-independent: shadow-mode out-of-scope write is still a forbidden write');

  // Re-checking a now-clean diff clears stale violations (overwrite, not append).
  const recovered = applyGuardCheck(blocked, detectGuardViolations(contract, emptyPack, []));
  assert.equal(recovered.status, 'active', 're-check with clean diff clears violations and returns to active');
  assert.equal(guardSessionHasBlockingViolations(recovered), false, 'cleared session no longer blocks lifecycle');

  // Acknowledged out-of-scope writes are not blocking guard violations
  // (an explicit, reviewed scope expansion via scope_contract_acknowledge).
  const ackContract = makeContract({
    mode: 'enforce',
    allowedModify: ['src/allowed.ts'],
    acknowledgements: [{
      actor: 'main-agent',
      reason: 'Deliberate out-of-scope edit, reviewed and approved by lead for this story.',
      timestamp: new Date().toISOString(),
      paths: ['src/rogue.ts'],
    }],
  });
  const ackViolations = detectGuardViolations(ackContract, emptyPack, ['src/rogue.ts']);
  assert.equal(ackViolations.length, 0, 'acknowledged out-of-scope write is not a blocking guard violation');
}

// ── 10. CHK-005 pure logic: binding helper round-trips & compares ───────────
{
  const contract = makeContract({
    mode: 'enforce',
    allowedModify: ['src/allowed.ts'],
    protectedAnchors: ['criticalFn'],
  });
  const packA = makePack([makeHunk('src/allowed.ts', { anchor: 'publicFn', digest: 'aaaa1111aaaa1111' })]);

  // No contract → not scope-protected → no binding required (legacy compatible).
  assert.equal(
    computeReviewScopeBinding({ contract: null, diffPack: packA }),
    null,
    'computeReviewScopeBinding returns null when the story has no scope contract',
  );

  const binding = computeReviewScopeBinding({ contract, diffPack: packA, reviewedIntentRefs: ['CHK-001:happy:0'] });
  assert.ok(binding, 'scope-protected story produces a binding');
  assert.equal(binding!.scopeContractHash, digestScopeContract(contract), 'binding records the live scopeContractHash');
  assert.match(binding!.bindingHash, /^[0-9a-f]{64}$/, 'bindingHash is a sha256 hex digest');
  assert.equal(verifyReviewScopeBinding(binding), true, 'a freshly computed binding verifies');
  assert.deepEqual(binding!.reviewedIntentRefs, ['CHK-001:happy:0'], 'binding records reviewed intent refs');

  // Fresh: live context built from the same contract + pack compares ok.
  const freshCtx = buildCurrentScopeContext(contract, packA);
  assert.equal(compareScopeBinding(binding, freshCtx).ok, true, 'fresh binding matches the live scope context');

  // Missing: no binding on a scope-protected story is rejected.
  const missing = compareScopeBinding(null, freshCtx);
  assert.equal(missing.ok, false, 'missing binding is rejected');
  assert.equal(missing.code, 'missing_scope_binding', 'missing binding reports missing_scope_binding');

  // Tampered: mutate a signed field without re-signing → tamper detected.
  const tampered: ReviewScopeBinding = { ...binding!, scopeContractHash: 'deadbeef'.repeat(8) };
  assert.equal(verifyReviewScopeBinding(tampered), false, 'tampered binding fails verification');
  assert.equal(compareScopeBinding(tampered, freshCtx).code, 'scope_binding_tampered', 'tampered binding reports scope_binding_tampered');

  // Scope contract changed: different contract → scope_contract_changed.
  const changedContract = makeContract({ mode: 'enforce', allowedModify: ['src/allowed.ts', 'src/extra.ts'], protectedAnchors: ['criticalFn'] });
  const changedScopeCtx = buildCurrentScopeContext(changedContract, packA);
  assert.equal(compareScopeBinding(binding, changedScopeCtx).code, 'scope_contract_changed', 'changed scope contract is rejected');

  // Diff pack changed: different hunks → diff_pack_changed / hunk_digest_set_changed.
  const packB = makePack([makeHunk('src/allowed.ts', { anchor: 'publicFn', digest: 'bbbb2222bbbb2222' })]);
  const changedDiffCtx = buildCurrentScopeContext(contract, packB);
  const diffCmp = compareScopeBinding(binding, changedDiffCtx);
  assert.equal(diffCmp.ok, false, 'changed diff pack is rejected');
  assert.ok(
    diffCmp.code === 'diff_pack_changed' || diffCmp.code === 'hunk_digest_set_changed',
    'changed diff pack reports diff_pack_changed or hunk_digest_set_changed',
  );
}

// ── 11. CHK-005: story-metadata churn does NOT invalidate the binding ────────
{
  const contract = makeContract({ mode: 'enforce', allowedModify: ['src/allowed.ts'] });
  const codeHunk = makeHunk('src/allowed.ts', { anchor: 'fn', digest: 'cccc3333cccc3333' });
  const metaHunkA = makeHunk('.koala/story/actives/B-x/findings.json', { digest: 'eeee5555eeee5555' });
  const metaHunkB = makeHunk('docs/story/actives/B-x/index.json', { digest: 'ffff6666ffff6666' });

  const packBefore = makePack([codeHunk, metaHunkA]);
  const packAfter = makePack([codeHunk, metaHunkB]); // metadata churned, code unchanged
  const before = materialDiffPackDigest(packBefore);
  const after = materialDiffPackDigest(packAfter);
  assert.equal(before.diffPackHash, after.diffPackHash, 'material diff digest ignores story-metadata churn');
  assert.deepEqual(before.reviewedChangedFiles, ['src/allowed.ts'], 'metadata files are excluded from reviewedChangedFiles');
  assert.deepEqual(before.reviewedHunkDigests, [codeHunk.hunkDigest], 'metadata hunks are excluded from reviewedHunkDigests');

  const binding = computeReviewScopeBinding({ contract, diffPack: packBefore });
  assert.equal(
    compareScopeBinding(binding, buildCurrentScopeContext(contract, packAfter)).ok,
    true,
    'a metadata-only diff change keeps the binding fresh (auto-commit churn safe)',
  );
}

// ── 11b. B-edca: custom storyDir paths are excluded from the digest when
//         projectRoot is provided; sibling paths outside storyDir stay material. ─
{
  const root = mkdtempSync(join(tmpdir(), 'koala-custom-storydir-'));
  try {
    writeFileSync(join(root, 'koala.config.json'), JSON.stringify({
      storyDir: 'workflow/stories',
    }, null, 2));
    resetConfigCache();

    const contract = makeContract({ mode: 'enforce', allowedModify: ['src/allowed.ts'] });
    const codeHunk = makeHunk('src/allowed.ts', { anchor: 'fn', digest: 'aa001100aa001100' });
    // Custom storyDir metadata path — should be excluded when projectRoot is known.
    const customMetaHunk = makeHunk('workflow/stories/B-smoke/checklist.json', { digest: 'bb002200bb002200' });
    // Sibling path outside storyDir — must stay material.
    const siblingHunk = makeHunk('workflow/notes.md', { digest: 'cc003300cc003300' });

    const packWithMeta = makePack([codeHunk, customMetaHunk]);
    const packWithSibling = makePack([codeHunk, siblingHunk]);

    // Without projectRoot: custom storyDir path is NOT excluded (unknown prefix).
    const withoutRoot = materialDiffPackDigest(packWithMeta);
    assert.ok(
      withoutRoot.reviewedChangedFiles.includes('workflow/stories/B-smoke/checklist.json'),
      'without projectRoot, custom storyDir path is NOT excluded from reviewedChangedFiles',
    );

    // With projectRoot: custom storyDir path IS excluded.
    const withRoot = materialDiffPackDigest(packWithMeta, root);
    assert.deepEqual(
      withRoot.reviewedChangedFiles,
      ['src/allowed.ts'],
      'with projectRoot, custom storyDir path is excluded from reviewedChangedFiles',
    );
    assert.deepEqual(
      withRoot.reviewedHunkDigests,
      [codeHunk.hunkDigest],
      'with projectRoot, custom storyDir hunk is excluded from reviewedHunkDigests',
    );

    // Sibling outside storyDir must stay material even with projectRoot.
    const siblingResult = materialDiffPackDigest(packWithSibling, root);
    assert.ok(
      siblingResult.reviewedChangedFiles.includes('workflow/notes.md'),
      'with projectRoot, sibling path outside storyDir is still material',
    );

    // Binding produced with projectRoot excludes the metadata hunk;
    // metadata-only churn in the custom storyDir does NOT invalidate it.
    const packCodeOnly = makePack([codeHunk]);
    const packWithCustomMeta = makePack([codeHunk, customMetaHunk]);
    const bindingWithRoot = computeReviewScopeBinding({ contract, diffPack: packCodeOnly, projectRoot: root });
    assert.ok(bindingWithRoot, 'scope-protected story produces a binding with projectRoot');
    const ctxWithMeta = buildCurrentScopeContext(contract, packWithCustomMeta, root);
    assert.equal(
      compareScopeBinding(bindingWithRoot, ctxWithMeta).ok,
      true,
      'custom-storyDir metadata churn does not invalidate the binding when projectRoot is passed',
    );
  } finally {
    resetConfigCache();
    rmSync(root, { recursive: true, force: true });
  }
}

// ── 12. CHK-005: review run signature folds in the binding hash ──────────────
{
  const base = ['B-x', 'B-x:RR-001', 'koala-review-quality', 'koala-review-quality', 'round-1', '2026-01-01T00:00:00.000Z', 'head', 'material', ''] as const;
  const noBinding = signReviewRun(...base);
  const withBinding = signReviewRun(...base, 'binding-hash-abc');
  assert.notEqual(noBinding, withBinding, 'a present scope binding hash changes the run signature');
  // backward compat: omitting the binding hash signs byte-identically to passing undefined.
  assert.equal(signReviewRun(...base, undefined), noBinding, 'no scope binding signs identically to the legacy algorithm');
}

// ── 13. CHK-005 integration: collectReviewerEvidenceState gate behavior ──────
const BASELINE_LANES = ['koala-review-concept', 'koala-review-quality', 'koala-review-test-coverage'];

function writeScopeStory(root: string, opts: { withContract: boolean }): { store: StoryStore; storyId: string; reviewRound: string; contract: ScopeContractData | null } {
  writeFileSync(join(root, 'koala.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: '.koala/story/actives',
    requirementsDir: 'docs/requirements',
    workflow: { profile: 'balanced' },
  }));
  resetConfigCache();
  const store = new StoryStore(root);
  const storyId = 'B-scopebind';
  const now = '2026-05-23T12:00:00.000Z';
  const reviewRound = '2026-05-23T12:01:00.000Z';
  const story: StoryInfo = {
    storyId,
    name: 'scope-binding-smoke',
    title: 'Scope binding smoke',
    description: 'Synthetic scope-protected story for CHK-005 gate coverage.',
    type: 'chore',
    phase: 'REVIEW',
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    currentReviewRound: reviewRound,
    events: [{ phase: 'REVIEW', action: 'advance', timestamp: reviewRound }],
  };
  const checklist: ChecklistData = {
    items: ['001', '002', '003'].map((suffix) => ({
      id: `CHK-${suffix}`,
      title: `Done item ${suffix}`,
      context: 'Synthetic checklist item.',
      status: 'done',
      startTime: now,
      endTime: now,
    })),
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist);
  store.writeUnderstanding(storyId, {
    task: 'Bind reviewer evidence to scope',
    outcome: 'Gate rejects stale scope bindings',
    facts: [], constraints: [], unknowns: [],
    touchpoints: ['packages/main/src/core/review-run.ts'],
    timestamp: now,
  });
  store.writeDecision(storyId, {
    principles: ['bind evidence mechanically', 'stay backward compatible', 'reuse the review run binding'],
    drivers: ['scope-protected review gate'],
    options: [
      { name: 'A: run-level binding', pros: ['single source'], cons: ['needs sig change'] },
      { name: 'B: per-evidence binding', pros: ['granular'], cons: ['duplication'] },
    ],
    chosen: 'A: run-level binding',
    rationale: 'binding the run covers all findings/passes that reference it',
    timestamp: now,
  });
  let contract: ScopeContractData | null = null;
  if (opts.withContract) {
    contract = {
      storyId,
      mode: 'enforce',
      allowedModify: ['packages/main/src/core/review-run.ts'],
      allowedCreate: ['packages/main/src/core/review-scope-binding.ts'],
      allowedTest: [],
      protectedFiles: [],
      explicitExcludes: [],
      acknowledgements: [],
      createdAt: now,
      updatedAt: now,
    };
    store.writeScopeContract(storyId, contract);
  }
  return { store, storyId, reviewRound, contract };
}

function seedScopeRuns(
  root: string,
  store: StoryStore,
  storyId: string,
  reviewRound: string,
  opts: { binding: boolean },
): Map<string, string> {
  const contract = store.readScopeContract(storyId);
  const binding = opts.binding && contract
    ? computeReviewScopeBinding({ contract, diffPack: buildScopeDiffPack(root) }) ?? undefined
    : undefined;
  const runs: ReviewRun[] = BASELINE_LANES.map((agent, index) => {
    const reviewRunId = `${storyId}:RR-${String(index + 1).padStart(3, '0')}`;
    const startedAt = `2026-05-23T12:1${index}:00.000Z`;
    const headHash = `head-${index}`;
    const materialHash = `material-${index}`;
    return {
      reviewRunId,
      storyId,
      agent,
      lane: agent,
      reviewRound,
      startedAt,
      headHash,
      materialHash,
      promptHash: '',
      ...(binding ? { scopeBinding: binding } : {}),
      _hash: signReviewRun(storyId, reviewRunId, agent, agent, reviewRound, startedAt, headHash, materialHash, '', binding?.bindingHash),
    };
  });
  store.writeReviewRuns(storyId, { runs });
  return new Map(runs.map((run) => [run.agent, run.reviewRunId]));
}

function seedScopePasses(store: StoryStore, storyId: string, reviewRound: string, runIds: Map<string, string>): void {
  const passes = BASELINE_LANES.map((agent, index) => {
    const id = `${storyId}:RP-${String(index + 1).padStart(3, '0')}`;
    const createdAt = `2026-05-23T12:2${index}:00.000Z`;
    const note = `${agent} reviewed the scope-protected diff and found no blocking issue`;
    const reviewRunId = runIds.get(agent)!;
    return { id, agent, note, createdAt, reviewRound, reviewRunId, _hash: signReviewPass(storyId, id, agent, note, createdAt, reviewRound, reviewRunId) };
  });
  store.writeReviewPasses(storyId, { passes });
}

// 13a. Fresh scope binding passes the gate.
{
  const root = mkdtempSync(join(tmpdir(), 'koala-scopebind-fresh-'));
  try {
    const { store, storyId, reviewRound } = writeScopeStory(root, { withContract: true });
    const runIds = seedScopeRuns(root, store, storyId, reviewRound, { binding: true });
    seedScopePasses(store, storyId, reviewRound, runIds);
    const state = collectReviewerEvidenceState(store, storyId, root);
    assert.equal(state.invalid.length, 0, 'fresh scope binding yields no invalid evidence');
    assert.equal(state.valid.length, BASELINE_LANES.length, 'all baseline reviewer passes are valid with fresh bindings');
    assert.equal(getGuardFailureReason(storyId, store, 'TEST', root), null, 'fresh scope binding passes REVIEW→TEST');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 13b. No-scope legacy story stays backward compatible (no binding required).
{
  const root = mkdtempSync(join(tmpdir(), 'koala-scopebind-legacy-'));
  try {
    const { store, storyId, reviewRound } = writeScopeStory(root, { withContract: false });
    const runIds = seedScopeRuns(root, store, storyId, reviewRound, { binding: false });
    seedScopePasses(store, storyId, reviewRound, runIds);
    const state = collectReviewerEvidenceState(store, storyId, root);
    assert.equal(state.invalid.length, 0, 'a story without a scope contract never requires scope bindings');
    assert.equal(getGuardFailureReason(storyId, store, 'TEST', root), null, 'no-scope legacy story passes REVIEW→TEST without bindings');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 13c. Stale scope binding (scope contract changed after review) is rejected.
{
  const root = mkdtempSync(join(tmpdir(), 'koala-scopebind-stale-'));
  try {
    const { store, storyId, reviewRound, contract } = writeScopeStory(root, { withContract: true });
    const runIds = seedScopeRuns(root, store, storyId, reviewRound, { binding: true });
    seedScopePasses(store, storyId, reviewRound, runIds);
    // Change the scope contract AFTER the reviewer bound to it — materialHash
    // (committed tree) would not catch this; the scope binding must.
    store.writeScopeContract(storyId, { ...contract!, allowedModify: [...contract!.allowedModify, 'packages/main/src/cli-engine.ts'], updatedAt: '2026-05-23T13:00:00.000Z' });
    const state = collectReviewerEvidenceState(store, storyId, root);
    assert.ok(state.invalid.length > 0, 'a changed scope contract invalidates the bound reviewer evidence');
    assert.ok(
      state.invalid.every(issue => issue.code === 'stale_scope_binding'),
      'changed scope contract reports stale_scope_binding',
    );
    const reason = getGuardFailureReason(storyId, store, 'TEST', root) ?? '';
    assert.match(reason, /scope binding/, 'gate failure reason names the scope binding problem');
    assert.match(reason, /koala-review-/, 'gate failure reason names the affected reviewer lane');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 13d. Natural-language-only evidence (run with no scope binding) is rejected.
{
  const root = mkdtempSync(join(tmpdir(), 'koala-scopebind-nl-'));
  try {
    const { store, storyId, reviewRound } = writeScopeStory(root, { withContract: true });
    // Seed runs WITHOUT a scope binding (prose-only reviewer evidence: a run was
    // started and a pass written, but nothing binds it to the inspected scope).
    const runIds = seedScopeRuns(root, store, storyId, reviewRound, { binding: false });
    seedScopePasses(store, storyId, reviewRound, runIds);
    const state = collectReviewerEvidenceState(store, storyId, root);
    assert.ok(state.invalid.length > 0, 'scope-protected story rejects evidence whose run has no scope binding');
    assert.ok(
      state.invalid.every(issue => issue.code === 'missing_scope_binding'),
      'evidence with no scope binding reports missing_scope_binding',
    );
    const reason = getGuardFailureReason(storyId, store, 'TEST', root) ?? '';
    assert.match(reason, /scope binding|missing_scope_binding/, 'gate rejects natural-language-only reviewer evidence');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── 14. CHK-006 fail-closed: a corrupt scope-contract.json must NOT silently
//        downgrade a scope-protected story to "no contract" (= gate bypass). ──
{
  const root = mkdtempSync(join(tmpdir(), 'koala-scopebind-corrupt-'));
  try {
    const { store, storyId, reviewRound } = writeScopeStory(root, { withContract: true });
    const runIds = seedScopeRuns(root, store, storyId, reviewRound, { binding: true });
    seedScopePasses(store, storyId, reviewRound, runIds);

    // Precondition: a valid contract + fresh bindings passes before corruption.
    assert.equal(
      collectReviewerEvidenceState(store, storyId, root).invalid.length,
      0,
      'precondition: valid contract + fresh bindings yields no invalid evidence',
    );
    assert.equal(
      getGuardFailureReason(storyId, store, 'TEST', root),
      null,
      'precondition: fresh scope-protected state passes REVIEW→TEST',
    );

    // Corrupt the on-disk contract: the file EXISTS but cannot be parsed.
    const contractPath = join(store.storyDirPath(storyId), 'scope-contract.json');
    writeFileSync(contractPath, '{ "mode": "enforce", THIS IS NOT VALID JSON ');

    // readScopeContract must THROW for a corrupt existing file (vs null for missing).
    assert.throws(
      () => store.readScopeContract(storyId),
      'corrupt EXISTING scope contract must throw, not silently return null',
    );
    // The live scope context must fail closed, not silently downgrade to null.
    assert.throws(
      () => currentScopeContextForStory(store, storyId, root),
      'currentScopeContextForStory must fail closed (throw) on a corrupt contract',
    );
    // The REVIEW→TEST gate must now BLOCK instead of waving the review through.
    assert.notEqual(
      getGuardFailureReason(storyId, store, 'TEST', root),
      null,
      'corrupt scope contract blocks REVIEW→TEST (fail-closed, no silent downgrade)',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── 14b. CHK-006 backward compat: a genuinely MISSING contract → null (legacy). ──
{
  const root = mkdtempSync(join(tmpdir(), 'koala-scopebind-missing-'));
  try {
    const { store, storyId } = writeScopeStory(root, { withContract: false });
    assert.equal(
      store.readScopeContract(storyId),
      null,
      'a missing scope contract reads as null (legacy stories stay backward compatible)',
    );
    assert.equal(
      currentScopeContextForStory(store, storyId, root),
      null,
      'a missing contract produces no scope context (no scope-binding enforcement)',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── 15. CHK-006: scope_contract_init_from_plan seeds a usable contract ───────
{
  const root = mkdtempSync(join(tmpdir(), 'koala-initplan-'));
  try {
    writeFileSync(join(root, 'koala.config.json'), JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      testsDir: 'packages/main/tests',
      fixturesDir: 'packages/main/tests/fixtures',
      storyDir: '.koala/story/actives',
      requirementsDir: 'docs/requirements',
      workflow: { profile: 'balanced' },
    }));
    resetConfigCache();
    const store = new StoryStore(root);
    const storyId = 'B-initplan';
    const now = '2026-05-23T12:00:00.000Z';
    const story: StoryInfo = {
      storyId,
      name: 'init-from-plan-smoke',
      title: 'Init from plan smoke',
      description: 'Synthetic story for CHK-006 init_from_plan coverage.',
      type: 'chore',
      phase: 'PLAN',
      priority: 'medium',
      createdAt: now,
      startedAt: now,
      endedAt: null,
      events: [{ phase: 'PLAN', action: 'advance', timestamp: now }],
    };
    const checklist: ChecklistData = {
      items: [
        {
          id: 'CHK-001', title: 'a', context: 'c', status: 'pending', startTime: null, endTime: null,
          files: { modify: ['src/a.ts'], create: ['src/b.ts'], test: ['tests/a.test.ts'] },
        },
        {
          id: 'CHK-002', title: 'b', context: 'c', status: 'pending', startTime: null, endTime: null,
          files: { modify: ['src/c.ts'], create: [], test: [] },
        },
      ],
    };
    store.writeStory(storyId, story);
    store.writeChecklist(storyId, checklist);

    const ctx = { store, root, scanRoot: 'packages/main' } as HandlerContext;
    const handlers = createScopeContractHandlers(ctx);
    const out = String(handlers.scope_contract_init_from_plan({ storyId, mode: 'enforce' }));
    assert.match(out, /Scope contract initialized from PLAN files/, 'init_from_plan reports success');

    const contract = store.readScopeContract(storyId);
    assert.ok(contract, 'init_from_plan persists a contract');
    assert.equal(contract!.mode, 'enforce', 'init_from_plan honors the requested mode');
    assert.deepEqual([...contract!.allowedModify].sort(), ['src/a.ts', 'src/c.ts'], 'allowedModify is the union of checklist modify files');
    assert.deepEqual([...contract!.allowedCreate].sort(), ['src/b.ts'], 'allowedCreate is the union of checklist create files');
    assert.deepEqual([...contract!.allowedTest].sort(), ['tests/a.test.ts'], 'allowedTest is the union of checklist test files');

    // The seeded contract is usable: in-scope passes, out-of-scope fails.
    assert.equal(checkScopeContract(contract!, ['src/a.ts']).status, 'pass', 'an in-scope change passes the seeded contract');
    assert.equal(checkScopeContract(contract!, ['src/rogue.ts']).status, 'fail', 'an out-of-scope change fails the seeded contract');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── 16. CHK-006: aggregate "Scope protection summary" projection ─────────────
{
  // 16a. Unprotected (legacy) story: not protected, every gate n/a, honest hint.
  const legacy = buildScopeProtectionSummary({
    contract: null,
    diffPack: makePack([]),
    guardSession: null,
    reviewRuns: [],
    phase: 'DEV',
  });
  assert.equal(legacy.protected, false, 'no contract → not protected');
  assert.equal(legacy.pathGate, 'n/a', 'no contract → path gate n/a');
  assert.equal(legacy.semanticGate, 'n/a', 'no contract → semantic gate n/a');
  assert.equal(legacy.guardMode, 'inactive', 'no guard session → guard mode inactive');
  assert.equal(legacy.reviewHashFreshness, 'n/a', 'no contract → freshness n/a');
  assert.match(legacy.nextAction, /scope_contract_init_from_plan/, 'legacy next action points at init_from_plan');
  const legacyRender = renderScopeProtectionSummary(legacy).join('\n');
  assert.match(legacyRender, /## Scope protection summary/, 'render emits the summary heading');
  assert.match(legacyRender, /path gate: n\/a \(no scope contract\)/, 'render names the path gate row and "no scope contract"');
  assert.match(legacyRender, /semantic gate: n\/a/, 'render names the semantic gate row');
  assert.match(legacyRender, /guard mode: inactive/, 'render names the guard mode row');
  assert.match(legacyRender, /review hash freshness: n\/a/, 'render names the review hash freshness row');
  assert.match(legacyRender, /next action: /, 'render names the next action row');

  // 16b. Protected + clean diff → pass/pass, "proceed".
  const v2 = makeContract({ mode: 'enforce', allowedModify: ['src/allowed.ts'], protectedAnchors: ['criticalFn'] });
  const cleanPack = makePack([makeHunk('src/allowed.ts', { anchor: 'publicFn' })]);
  const clean = buildScopeProtectionSummary({ contract: v2, diffPack: cleanPack, guardSession: null, reviewRuns: [], phase: 'DEV' });
  assert.equal(clean.protected, true, 'a contract makes the story protected');
  assert.equal(clean.pathGate, 'pass', 'allowed file passes the path gate');
  assert.equal(clean.semanticGate, 'pass', 'allowed anchor passes the semantic gate');
  assert.match(clean.nextAction, /clean|proceed/i, 'clean scope → proceed');

  // 16c. Protected + denied-anchor hunk → semantic fail, blocking next action.
  const denyContract = makeContract({ mode: 'enforce', allowedModify: ['src/allowed.ts'], fileRules: [{ path: 'src/allowed.ts', deniedAnchors: ['secretFn'] }] });
  const badPack = makePack([makeHunk('src/allowed.ts', { anchor: 'secretFn' })]);
  const bad = buildScopeProtectionSummary({ contract: denyContract, diffPack: badPack, guardSession: null, reviewRuns: [], phase: 'DEV' });
  assert.equal(bad.semanticGate, 'fail', 'denied anchor fails the semantic gate even on an allowed file');
  assert.match(bad.nextAction, /scope_contract_acknowledge|Out-of-scope/i, 'a semantic fail surfaces a blocking next action');

  // 16d. Review hash freshness: fresh / missing / stale / n/a-outside-review.
  const bindContract = makeContract({ mode: 'enforce', allowedModify: ['src/allowed.ts'] });
  const bindPack = makePack([makeHunk('src/allowed.ts', { anchor: 'fn', digest: 'abcd1234abcd1234' })]);
  const binding = computeReviewScopeBinding({ contract: bindContract, diffPack: bindPack })!;
  const round = '2026-05-23T12:01:00.000Z';
  const boundRun: ReviewRun = {
    reviewRunId: 'B-x:RR-1', storyId: 'B-x', agent: 'koala-review-quality', lane: 'koala-review-quality',
    reviewRound: round, startedAt: round, headHash: 'h', materialHash: 'm', promptHash: '', scopeBinding: binding,
  };
  assert.equal(
    computeReviewHashFreshness({ contract: bindContract, diffPack: bindPack, guardSession: null, reviewRuns: [boundRun], currentReviewRound: round, phase: 'REVIEW' }),
    'fresh',
    'a current-round bound run matching the live scope is fresh',
  );
  const proseRun: ReviewRun = { ...boundRun, scopeBinding: undefined };
  assert.equal(
    computeReviewHashFreshness({ contract: bindContract, diffPack: bindPack, guardSession: null, reviewRuns: [proseRun], currentReviewRound: round, phase: 'REVIEW' }),
    'missing',
    'a current-round run with no scope binding (prose-only) is missing',
  );
  const changedPack = makePack([makeHunk('src/allowed.ts', { anchor: 'fn', digest: 'ffff9999ffff9999' })]);
  assert.equal(
    computeReviewHashFreshness({ contract: bindContract, diffPack: changedPack, guardSession: null, reviewRuns: [boundRun], currentReviewRound: round, phase: 'REVIEW' }),
    'stale',
    'a bound run no longer matching the live diff is stale',
  );
  assert.equal(
    computeReviewHashFreshness({ contract: bindContract, diffPack: bindPack, guardSession: null, reviewRuns: [boundRun], currentReviewRound: round, phase: 'DEV' }),
    'n/a',
    'freshness is n/a outside REVIEW/TEST',
  );

  // 16e. A missing binding surfaces review_run_start as the next action — this is
  //      the mechanical reason natural-language-only review evidence cannot pass.
  const missingSummary = buildScopeProtectionSummary({ contract: bindContract, diffPack: bindPack, guardSession: null, reviewRuns: [proseRun], currentReviewRound: round, phase: 'REVIEW' });
  assert.equal(missingSummary.reviewHashFreshness, 'missing', 'prose-only reviewer evidence reads as missing freshness');
  assert.match(missingSummary.nextAction, /review_run_start/, 'missing freshness next action requires a bound reviewer run');
}

console.log('semantic scope guard smoke passed');
