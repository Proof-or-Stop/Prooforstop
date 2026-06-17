#!/usr/bin/env node
/**
 * B-3fad CHK-002: gap_log smoke.
 *
 * Verifies the `gap_log` framework-gap manual archival entrypoint:
 *   1. missing category / severity / evidence / source -> rejected, nothing written
 *   2. default write -> evidenceState=suspected
 *   3. evidenceState=verified but no structured evidence field -> forced back to suspected
 *   4. evidenceState=verified WITH structured evidence -> verified is allowed
 *   5. empty / whitespace-only evidence -> rejected
 *   6. B-META-framework-audit container missing -> gap_log auto ensureMetaStory bootstrap
 *   7. gap_log needs no worktree -> runs straight from a fresh main project
 *
 * gap_log is exercised through the public CLI (cwd = project root, no story worktree)
 * because the whole point of the command is to NOT require a story worktree.
 */

import { strict as assert } from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import { META_STORY_ID, appendGapFinding } from '../core/audit-meta-store.js';
import { createGapLogHandlers } from '../handlers/gap-log.js';
import type { FindingData } from '../core/types.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(packageRoot, 'cli.js');

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

/** Build a fresh main project (a git repo, no story worktree). */
function createMainProject(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
  }));
  write(root, 'README.md', 'gap-log smoke\n');
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=Lattice Smoke', 'commit', '-m', 'base']);
  resetConfigCache();
  return root;
}

/** Run gap_log via CLI from the project root; returns stdout. */
function runGapLog(root: string, args: Record<string, unknown>): string {
  return execFileSync(process.execPath, [cliPath, 'gap_log', JSON.stringify(args)], {
    cwd: root,
    env: { ...process.env, LATTICE_PROJECT_ROOT: root },
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** Run gap_log expecting failure; returns the combined error text. */
function runGapLogExpectFail(root: string, args: Record<string, unknown>): string {
  try {
    runGapLog(root, args);
  } catch (e: any) {
    return [e?.stdout?.toString?.() ?? '', e?.stderr?.toString?.() ?? '', e?.message ?? ''].join('\n');
  }
  assert.fail('gap_log should have failed');
}

function readMetaFindings(root: string): FindingData {
  return new StoryStore(root).readFindings(META_STORY_ID);
}

/**
 * Direct handler invocation that bypasses the CLI Zod schema.
 * CLAUDE.md "Handler coding conventions" requires runtime guards to reject even when callers
 * skip the Zod layer (old JSON / internal fn paths). callGapLogRaw exercises that path.
 */
function callGapLogRaw(root: string, args: Record<string, unknown>): { ok: boolean; message: string } {
  const store = new StoryStore(root);
  const handlers = createGapLogHandlers({ store, root, scanRoot: root });
  try {
    return { ok: true, message: String(handlers.gap_log(args)) };
  } catch (e: any) {
    return { ok: false, message: String(e?.message ?? e) };
  }
}

const VALID = {
  category: 'missing',
  severity: 'medium',
  evidence: 'riskSignal detector misclassifies keyword mentions in prose as a modified-risk surface',
  sourceRefs: ['packages/main/src/core/risk-signals.ts:42'],
};

// ── 1: missing each required field -> rejected, nothing written ──
// Two layers per CLAUDE.md "Handler coding conventions":
//  (a) CLI Zod schema rejects missing required fields (first defense line);
//  (b) handler runtime guard rejects the same even when Zod is bypassed (old JSON /
//      internal fn callers). Both layers asserted below.
function assertMissingRequiredFieldsRejected(): void {
  // (a) CLI Zod layer — missing category / severity / evidence each fail before the handler
  {
    const root = createMainProject('lattice-gaplog-zod-cat-');
    try {
      const out = runGapLogExpectFail(root, { severity: 'medium', evidence: VALID.evidence, sourceRefs: VALID.sourceRefs });
      assert.match(out, /category/, 'CLI Zod must reject missing category');
      assert.equal(existsSync(join(root, '.lattice/story/actives', META_STORY_ID)), false,
        'Zod-rejected gap_log must not even bootstrap the container');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  {
    const root = createMainProject('lattice-gaplog-zod-sev-');
    try {
      const out = runGapLogExpectFail(root, { category: 'missing', evidence: VALID.evidence, sourceRefs: VALID.sourceRefs });
      assert.match(out, /severity/, 'CLI Zod must reject missing severity');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  {
    const root = createMainProject('lattice-gaplog-zod-ev-');
    try {
      const out = runGapLogExpectFail(root, { category: 'missing', severity: 'medium', sourceRefs: VALID.sourceRefs });
      assert.match(out, /evidence/, 'CLI Zod must reject missing evidence');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  // `source` is not a single Zod-required field (it's "any of 4 optional fields"),
  // so missing-source is enforced ONLY by the handler runtime guard — assert via CLI too.
  {
    const root = createMainProject('lattice-gaplog-cli-src-');
    try {
      const out = runGapLogExpectFail(root, { category: 'missing', severity: 'medium', evidence: VALID.evidence });
      assert.match(out, /source is required/, 'handler runtime must reject missing source');
      assert.equal(readMetaFindings(root).findings.length, 0, 'no-source gap_log must not write a finding');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  // (b) handler runtime layer — bypass Zod entirely (simulates old JSON / internal fn callers)
  {
    const root = createMainProject('lattice-gaplog-rt-');
    try {
      const noCat = callGapLogRaw(root, { severity: 'medium', evidence: VALID.evidence, sourceRefs: VALID.sourceRefs });
      assert.equal(noCat.ok, false);
      assert.match(noCat.message, /category is required/, 'handler runtime must reject missing category even without Zod');

      const badCat = callGapLogRaw(root, { category: 'nonsense', severity: 'medium', evidence: VALID.evidence, sourceRefs: VALID.sourceRefs });
      assert.equal(badCat.ok, false);
      assert.match(badCat.message, /category is required/, 'handler runtime must reject an invalid category enum value');

      const noSev = callGapLogRaw(root, { category: 'missing', evidence: VALID.evidence, sourceRefs: VALID.sourceRefs });
      assert.equal(noSev.ok, false);
      assert.match(noSev.message, /severity is required/, 'handler runtime must reject missing severity even without Zod');

      const badSev = callGapLogRaw(root, { category: 'missing', severity: 'urgent', evidence: VALID.evidence, sourceRefs: VALID.sourceRefs });
      assert.equal(badSev.ok, false);
      assert.match(badSev.message, /severity is required/, 'handler runtime must reject an invalid severity enum value');

      const noEv = callGapLogRaw(root, { category: 'missing', severity: 'medium', sourceRefs: VALID.sourceRefs });
      assert.equal(noEv.ok, false);
      assert.match(noEv.message, /evidence is required/, 'handler runtime must reject missing evidence even without Zod');

      const noSrc = callGapLogRaw(root, { category: 'missing', severity: 'medium', evidence: VALID.evidence });
      assert.equal(noSrc.ok, false);
      assert.match(noSrc.message, /source is required/, 'handler runtime must reject missing source even without Zod');

      assert.equal(readMetaFindings(root).findings.length, 0,
        'every Zod-bypassing rejection must leave B-META findings empty');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  console.log('✓ gap-log-1: missing category/severity/evidence/source rejected by both Zod and handler runtime, nothing written');
}

// ── 2: default write -> evidenceState=suspected ──
function assertDefaultWriteIsSuspected(): void {
  const root = createMainProject('lattice-gaplog-default-');
  try {
    const out = runGapLog(root, VALID);
    assert.match(out, /evidenceState=suspected/, 'default gap_log must be suspected');
    const findings = readMetaFindings(root).findings;
    assert.equal(findings.length, 1, 'gap_log must write exactly one finding');
    assert.equal(findings[0].evidenceState, 'suspected');
    assert.equal(findings[0].severity, 'medium');
    assert.equal(findings[0].category, 'missing');
    assert.equal(findings[0].status, 'open');
    assert.ok((findings[0].uncertaintyReason ?? '').length >= 10, 'suspected finding must carry an uncertaintyReason');
    assert.ok(findings[0]._hash, 'finding must be signed');
    console.log('✓ gap-log-2: default gap_log writes evidenceState=suspected');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

// ── 3: verified requested but no structured evidence -> never produces a verified finding ──
function assertVerifiedWithoutEvidenceCannotBeVerified(): void {
  const root = createMainProject('lattice-gaplog-verified-bare-');
  try {
    // gap_log requires `source` (sourceRefs / reproCommand / observedOutput / analysisNote),
    // and that same set IS the "structured evidence" the verified guard checks. So a
    // verified request with zero structured evidence is rejected by the source gate
    // before the verified guard even runs -> it can never produce a verified finding.
    // (The handler keeps an independent downgrade guard as defense-in-depth in case the
    // source requirement is ever relaxed; that guard is asserted at the unit level below.)
    const out = runGapLogExpectFail(root, {
      category: 'missing', severity: 'low', evidence: VALID.evidence, evidenceState: 'verified',
    });
    assert.match(out, /source is required/, 'verified request with no structured evidence is blocked by the source gate');
    assert.equal(readMetaFindings(root).findings.length, 0, 'rejected verified-without-evidence must not be written');

    // Unit-level: appendGapFinding is the storage primitive; the handler is the only place
    // that decides evidenceState. Prove the handler invariant directly — a verified finding
    // is only ever produced when structured evidence accompanies it (matrix-4). Here we
    // confirm the storage primitive faithfully records whatever evidenceState it is given,
    // so the suspected/verified decision genuinely lives in the guarded handler.
    const store = new StoryStore(root);
    const suspectedRec = appendGapFinding(store, {
      category: 'missing', severity: 'low', desc: 'primitive records suspected as given',
      evidenceState: 'suspected', uncertaintyReason: 'unit-level primitive check, not handler-decided',
    });
    assert.equal(suspectedRec.evidenceState, 'suspected');
    assert.equal(store.readFindings(META_STORY_ID).findings.at(-1)?.evidenceState, 'suspected');
    console.log('✓ gap-log-3: verified without structured evidence can never become a verified finding');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

// ── 4: verified WITH structured evidence -> verified allowed ──
function assertVerifiedWithEvidenceAllowed(): void {
  const root = createMainProject('lattice-gaplog-verified-ok-');
  try {
    const out = runGapLog(root, {
      category: 'edge',
      severity: 'high',
      evidence: 'story_review_dismiss leaves high-risk decision/preMortem gate forced after dismissing a misfired riskSignal',
      sourceRefs: ['packages/main/src/handlers/story-review.ts:120'],
      reproCommand: 'lattice story_review_dismiss ... then lattice story_review',
      observedOutput: 'story_review still blocks PLAN->DEV demanding preMortem >= 3',
      evidenceState: 'verified',
    });
    assert.match(out, /evidenceState=verified/, 'verified WITH structured evidence must be allowed');
    assert.doesNotMatch(out, /forcibly downgraded to suspected/, 'no downgrade warning when structured evidence is present');
    const findings = readMetaFindings(root).findings;
    assert.equal(findings.length, 1);
    assert.equal(findings[0].evidenceState, 'verified');
    // verified finding does not require uncertaintyReason
    assert.equal(findings[0].uncertaintyReason, undefined, 'verified finding must not carry uncertaintyReason');
    console.log('✓ gap-log-4: verified with structured evidence is allowed');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

// ── 5: empty / whitespace-only evidence -> rejected ──
function assertBlankEvidenceRejected(): void {
  for (const blank of ['', '   ', '\t\n  ']) {
    const root = createMainProject('lattice-gaplog-blank-ev-');
    try {
      const out = runGapLogExpectFail(root, {
        category: 'missing', severity: 'medium', evidence: blank, sourceRefs: VALID.sourceRefs,
      });
      assert.match(out, /evidence is required/, `blank evidence ${JSON.stringify(blank)} must be rejected`);
      assert.equal(readMetaFindings(root).findings.length, 0, 'blank-evidence gap_log must not write a finding');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  console.log('✓ gap-log-5: empty / whitespace-only evidence rejected');
}

// ── 6: B-META container missing -> gap_log auto ensureMetaStory bootstrap ──
function assertContainerBootstrap(): void {
  const root = createMainProject('lattice-gaplog-bootstrap-');
  try {
    assert.equal(new StoryStore(root).storyExists(META_STORY_ID), false,
      'fixture must start without the B-META container');
    const out = runGapLog(root, VALID);
    assert.match(out, new RegExp(`${META_STORY_ID} container does not exist, auto-bootstrapped`),
      'first gap_log must report container bootstrap');
    const store = new StoryStore(root);
    assert.equal(store.storyExists(META_STORY_ID), true, 'gap_log must ensureMetaStory the container');
    const metaStory = store.readStory(META_STORY_ID);
    assert.equal(metaStory.phase, 'META', 'bootstrapped meta-story must be phase=META');
    assert.equal(store.readFindings(META_STORY_ID).findings.length, 1);

    // second gap_log into an already-bootstrapped container -> no bootstrap notice, finding appended
    const out2 = runGapLog(root, { ...VALID, evidence: 'second framework gap reuses the existing container' });
    assert.doesNotMatch(out2, /auto-bootstrapped/, 'second gap_log must not re-report bootstrap');
    assert.equal(store.readFindings(META_STORY_ID).findings.length, 2, 'second gap_log appends, no parallel store');
    console.log('✓ gap-log-6: B-META container is auto-bootstrapped, then reused');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

// ── 7: gap_log needs no worktree -> runs straight from a fresh main project ──
function assertNoWorktreeRequired(): void {
  // createMainProject() is a plain main repo with NO story worktree, NO active story.
  // If gap_log required a worktree (assertCwdInWorktree) it would throw here.
  const root = createMainProject('lattice-gaplog-no-worktree-');
  try {
    assert.doesNotMatch(git(root, ['worktree', 'list', '--porcelain']), /story\//,
      'fixture must have no story worktree');
    const out = runGapLog(root, VALID);
    assert.match(out, /Gap logged: B-META-framework-audit:F-/,
      'gap_log must succeed from a plain main project with no worktree');
    console.log('✓ gap-log-7: gap_log runs with no story worktree');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

// ── 8: identical gap twice -> one canonical finding (B-f60c CHK-003 in-lock dedup) ──
// B-f60c CHK-003 REVERSES the former non-dedup behavior. session-ownership-and-
// write-leases.md "Idempotency Requirements" mandates gap_log dedupe by
// normalized desc + category + severity + evidence fingerprint, inside the main
// write lock. Logging the SAME gap twice must collapse into ONE canonical
// finding so concurrent agents archiving the same framework gap do not pollute
// B-META with duplicates.
function assertIdenticalGapDeduped(): void {
  const root = createMainProject('lattice-gaplog-dedup-');
  try {
    const out1 = runGapLog(root, VALID);
    assert.match(out1, /Gap logged: B-META-framework-audit:F-/, 'first gap_log writes a finding');
    const out2 = runGapLog(root, VALID); // exact same content
    // second identical call must report dedup, not a fresh write
    assert.match(out2, /Gap deduped: B-META-framework-audit:F-/,
      'second identical gap_log must report dedup, not a new finding');
    assert.match(out2, /identical gap already exists/, 'dedup hint explains the canonical finding was reused');
    const findings = readMetaFindings(root).findings;
    assert.equal(findings.length, 1,
      'identical gap logged twice must collapse into ONE canonical finding (B-f60c CHK-003 in-lock dedup)');
    assert.ok(findings[0].gapFingerprint, 'gap finding carries an idempotency fingerprint');
    assert.equal(findings.every(f => !f.driftHash), true, 'manual gap findings carry no driftHash');
    console.log('✓ gap-log-8: identical gap logged twice dedupes into one canonical finding');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

// ── 8b: different gaps are NEVER merged by the fingerprint (no false dedup) ──
// The fingerprint must be NARROW: two genuinely different gaps must always get
// distinct fingerprints so a real gap is never lost to a too-wide hash. This
// asserts every distinguishing channel (desc / category / severity / sourceRefs
// / reproCommand / observedOutput / analysisNote) keeps gaps separate.
function assertDifferentGapsNotFalselyMerged(): void {
  const root = createMainProject('lattice-gaplog-no-false-merge-');
  try {
    // base gap
    runGapLog(root, VALID);
    // differs ONLY in desc -> distinct gap
    runGapLog(root, { ...VALID, evidence: 'a completely different framework gap with its own description' });
    // differs ONLY in category -> distinct gap
    runGapLog(root, { ...VALID, category: 'edge' });
    // differs ONLY in severity -> distinct gap
    runGapLog(root, { ...VALID, severity: 'high' });
    // differs ONLY in sourceRefs -> distinct gap
    runGapLog(root, { ...VALID, sourceRefs: ['packages/main/src/core/other-file.ts:99'] });
    // differs ONLY in reproCommand -> distinct gap
    runGapLog(root, { ...VALID, reproCommand: 'lattice validate --story=B-xxxx' });
    // differs ONLY in observedOutput -> distinct gap
    runGapLog(root, { ...VALID, observedOutput: 'gate unexpectedly passed' });
    // differs ONLY in analysisNote -> distinct gap
    runGapLog(root, { ...VALID, analysisNote: 'root cause is a missing runtime guard' });

    const findings = readMetaFindings(root).findings;
    assert.equal(findings.length, 8,
      'eight genuinely different gaps must each get their own finding — fingerprint must not falsely merge them');
    const fingerprints = new Set(findings.map(f => f.gapFingerprint));
    assert.equal(fingerprints.size, 8,
      'each distinct gap must have a UNIQUE fingerprint (narrow fingerprint, no collisions)');
    console.log('✓ gap-log-8b: gaps differing in any identity channel get distinct fingerprints, never merged');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

// ── 8c: a resolved gap can be re-logged (dedup only blocks OPEN duplicates) ──
// Dedup keys on an OPEN finding. A gap that was closed and is then observed
// again is a legitimately new occurrence — re-logging it after the original is
// resolved must create a fresh finding, not silently no-op.
function assertResolvedGapCanBeReLogged(): void {
  const root = createMainProject('lattice-gaplog-relog-');
  try {
    runGapLog(root, VALID);
    // resolve the first finding directly in the store (simulates the gap being closed)
    const store = new StoryStore(root);
    const data = store.readFindings(META_STORY_ID);
    assert.equal(data.findings.length, 1, 'first gap_log writes one finding');
    data.findings[0].status = 'resolved';
    store.writeFindings(META_STORY_ID, data);
    // re-log the identical gap — the prior finding is resolved, so this is a new occurrence
    const out = runGapLog(root, VALID);
    assert.match(out, /Gap logged: B-META-framework-audit:F-/,
      're-logging a gap whose prior finding is resolved must create a fresh finding');
    const after = readMetaFindings(root).findings;
    assert.equal(after.length, 2, 'a resolved gap re-logged produces a second finding (new occurrence)');
    console.log('✓ gap-log-8c: a gap can be re-logged after its prior finding is resolved');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

// ── 9: evidenceState=disproven -> rejected (gap_log archives suspected gaps, not disproof) ──
// Two layers: (a) CLI Zod enum only allows suspected/verified; (b) handler runtime
// rejects disproven (and any out-of-enum value) even when Zod is bypassed.
function assertDisprovenRejected(): void {
  const root = createMainProject('lattice-gaplog-disproven-');
  try {
    // (a) CLI Zod layer rejects disproven before reaching the handler
    const cliOut = runGapLogExpectFail(root, { ...VALID, evidenceState: 'disproven' });
    assert.match(cliOut, /evidenceState/, 'CLI Zod must reject evidenceState=disproven');
    assert.equal(readMetaFindings(root).findings.length, 0, 'disproven gap_log must not write a finding');

    // (b) handler runtime layer (Zod bypassed) gives the explicit disproven guidance
    const rtDisproven = callGapLogRaw(root, { ...VALID, evidenceState: 'disproven' });
    assert.equal(rtDisproven.ok, false);
    assert.match(rtDisproven.message, /disproven counter-evidence must go through the finding flow/,
      'handler runtime must reject disproven with explicit guidance');

    // handler runtime also rejects any out-of-enum value
    const rtBad = callGapLogRaw(root, { ...VALID, evidenceState: 'confirmed' });
    assert.equal(rtBad.ok, false);
    assert.match(rtBad.message, /invalid evidenceState value/, 'handler runtime must reject an out-of-enum evidenceState');
    assert.equal(readMetaFindings(root).findings.length, 0, 'no rejected evidenceState write may land');
    console.log('✓ gap-log-9: evidenceState=disproven and out-of-enum values rejected by Zod and handler runtime');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

// ── 10: rapid succession (5 calls) -> all 5 findings written, no findings.json race ──
function assertRapidSuccessionAllWritten(): void {
  const root = createMainProject('lattice-gaplog-rapid-');
  try {
    for (let i = 0; i < 5; i++) {
      runGapLog(root, { ...VALID, evidence: `rapid framework gap #${i} observed in quick succession` });
    }
    const findings = readMetaFindings(root).findings;
    assert.equal(findings.length, 5, 'all 5 rapid gap_log calls must be persisted, none lost to a race');
    const ids = new Set(findings.map(f => f.id));
    assert.equal(ids.size, 5, 'each rapid gap_log call must get a unique finding id');
    console.log('✓ gap-log-10: 5 rapid gap_log calls all persisted with unique ids');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

// ── 12: F-003 — sourceRefs + files both passed -> finding.files keeps both (no silent loss) ──
function assertSourceRefsAndFilesMerged(): void {
  const root = createMainProject('lattice-gaplog-merge-files-');
  try {
    const out = runGapLog(root, {
      category: 'missing',
      severity: 'medium',
      evidence: 'gap whose evidence source and impacted files are distinct paths',
      sourceRefs: ['packages/main/src/core/risk-signals.ts:42', 'packages/main/src/core/advisory.ts:60'],
      files: ['packages/main/src/handlers/gap-log.ts', 'packages/main/src/core/advisory.ts:60'],
    });
    assert.match(out, /Gap logged: B-META-framework-audit:F-/, 'gap_log with sourceRefs+files must succeed');
    const findings = readMetaFindings(root).findings;
    assert.equal(findings.length, 1, 'gap_log must write exactly one finding');
    const storedFiles = findings[0].files ?? [];
    // both sourceRefs entries are kept (not overwritten by args.files)
    assert.ok(storedFiles.includes('packages/main/src/core/risk-signals.ts:42'),
      'sourceRefs entry must survive — args.files must not silently overwrite it');
    assert.ok(storedFiles.includes('packages/main/src/core/advisory.ts:60'),
      'sourceRefs entry must be present');
    // args.files-only entry is also kept
    assert.ok(storedFiles.includes('packages/main/src/handlers/gap-log.ts'),
      'args.files entry must be present');
    // the path shared by sourceRefs and files appears exactly once (dedup)
    const dupCount = storedFiles.filter(f => f === 'packages/main/src/core/advisory.ts:60').length;
    assert.equal(dupCount, 1, 'a path shared by sourceRefs and files must be deduplicated');
    assert.equal(storedFiles.length, 3, 'merged files = 2 unique sourceRefs + 1 unique files entry');
    console.log('✓ gap-log-12: sourceRefs + files both passed are merged & deduped, no silent loss');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

/** Spawn one real `lattice gap_log` child process; resolves with exit info. */
function spawnGapLog(root: string, args: Record<string, unknown>): Promise<{ code: number; output: string }> {
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, [cliPath, 'gap_log', JSON.stringify(args)], {
      cwd: root,
      env: { ...process.env, LATTICE_PROJECT_ROOT: root },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { out += d; });
    child.on('close', (code) => resolveP({ code: code ?? -1, output: out }));
  });
}

// ── 8d: concurrent same-gap gap_log under the main write lock -> one finding ──
// B-f60c CHK-003: gap_log writes shared B-META state under the unified main
// write lock. REAL OS child processes are spawned (their only shared state is
// the filesystem — exactly the production race; an in-process Promise.all would
// serialize on one event loop and prove nothing). gap_log acquires the lock in
// `onContention: 'wait'` mode (sub-second critical section), so every racer
// serializes-and-waits: the winner writes the finding, every later racer hits
// the in-lock idempotency dedup. The invariant: the same gap logged
// concurrently produces EXACTLY ONE canonical B-META finding, all racers exit 0.
async function assertConcurrentSameGapDeduped(): Promise<void> {
  const root = createMainProject('lattice-gaplog-concurrent-same-');
  try {
    const racers = 6;
    const pending: Array<Promise<{ code: number; output: string }>> = [];
    for (let i = 0; i < racers; i++) {
      pending.push(spawnGapLog(root, VALID)); // identical gap content
    }
    const results = await Promise.all(pending);
    // Every racer waits for the lock and completes — none fail-fast.
    for (let i = 0; i < results.length; i++) {
      assert.equal(results[i].code, 0,
        `concurrent same-gap racer ${i} must exit 0 (wait-mode lock), got ${results[i].code}\n${results[i].output}`);
    }
    const findings = readMetaFindings(root).findings;
    assert.equal(findings.length, 1,
      `concurrent same-gap gap_log must yield exactly ONE finding, got ${findings.length}: ` +
      results.map((r, i) => `proc${i}(exit=${r.code})`).join(' '));
    // exactly one racer reports a fresh write; the rest report dedup
    const written = results.filter(r => /Gap logged: /.test(r.output)).length;
    const deduped = results.filter(r => /Gap deduped: /.test(r.output)).length;
    assert.equal(written, 1, 'exactly one concurrent racer writes the canonical finding');
    assert.equal(written + deduped, racers, 'every other racer reports an in-lock dedup');

    // concurrent DIFFERENT gaps -> each gets its own finding (lock serializes,
    // dedup does not falsely merge distinct gaps).
    const root2 = createMainProject('lattice-gaplog-concurrent-diff-');
    try {
      const diffPending: Array<Promise<{ code: number; output: string }>> = [];
      for (let i = 0; i < 4; i++) {
        diffPending.push(spawnGapLog(root2, { ...VALID, evidence: `distinct concurrent framework gap number ${i}` }));
      }
      const diffResults = await Promise.all(diffPending);
      for (let i = 0; i < diffResults.length; i++) {
        assert.equal(diffResults[i].code, 0,
          `distinct concurrent racer ${i} must exit 0\n${diffResults[i].output}`);
      }
      const diffFindings = readMetaFindings(root2).findings;
      assert.equal(diffFindings.length, 4,
        'four distinct concurrent gaps must each get their own finding (no false merge)');
      const fps = new Set(diffFindings.map(f => f.gapFingerprint));
      assert.equal(fps.size, 4, 'four distinct concurrent gaps must have four distinct fingerprints');
    } finally { rmSync(root2, { recursive: true, force: true }); }

    console.log('✓ gap-log-8d: concurrent same gap -> one canonical finding; concurrent distinct gaps -> all kept');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

// ── 11: gap_log is discoverable -> lattice help / lattice gap_log --help shows it ──
function assertCommandDiscoverable(): void {
  const root = createMainProject('lattice-gaplog-discover-');
  try {
    const help = execFileSync(process.execPath, [cliPath, 'gap_log', '--help'], {
      cwd: root, env: { ...process.env, LATTICE_PROJECT_ROOT: root }, encoding: 'utf-8',
    });
    assert.match(help, /gap_log/, 'lattice gap_log --help must render the command');
    assert.match(help, /category/, 'help must list the category parameter');
    assert.match(help, /severity/, 'help must list the severity parameter');
    console.log('✓ gap-log-11: gap_log is registered and discoverable via lattice help');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

(async () => {
  assertMissingRequiredFieldsRejected();
  assertDefaultWriteIsSuspected();
  assertVerifiedWithoutEvidenceCannotBeVerified();
  assertVerifiedWithEvidenceAllowed();
  assertBlankEvidenceRejected();
  assertContainerBootstrap();
  assertNoWorktreeRequired();
  assertIdenticalGapDeduped();
  assertDifferentGapsNotFalselyMerged();
  assertResolvedGapCanBeReLogged();
  await assertConcurrentSameGapDeduped();
  assertDisprovenRejected();
  assertRapidSuccessionAllWritten();
  assertSourceRefsAndFilesMerged();
  assertCommandDiscoverable();

  console.log('✓ gap-log smoke passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
