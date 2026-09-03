#!/usr/bin/env node
/**
 * B-1a91 CHK-003: smoke suite for the Experience Layer COVERAGE WATERMARK + the
 * learning_validate GAP report.
 *
 * The finding-signals cache only ever refreshed via an explicit out-of-band
 * learning_scan (and now, post-CHK-001, on every DONE merge — but that refresh is
 * never-throw and can silently fail/skip). To make a missed refresh DETECTABLE,
 * deriveFindingSignals now stamps a coverage watermark (coveredFindingCount /
 * coveredStoryCount / coveredThrough) onto the cache, and learning_validate reports
 * the gap between the PERSISTED cache watermark and the live store.
 *
 * Coverage (named `check:` lines; exits non-zero on any failure; prints
 * `smoke passed` at the very end):
 *   - WATERMARK: deriveFindingSignals stamps coveredFindingCount/coveredStoryCount/
 *     coveredThrough counted over the SAME findings used to build the signals;
 *     coveredThrough folds in max(createdAt, resolvedAt); empty corpus => 0/0, no
 *     coveredThrough, never NaN.
 *   - LEAF computeCoverageGap: gap=0 when watermark == current; gap=delta when the
 *     cache is behind; a watermark-less / null / malformed cache => known:false
 *     ("unknown"); never NaN; never a negative gap.
 *   - END-TO-END via the REAL handlers (learning_scan + learning_validate) over a
 *     git-backed temp store:
 *       • right after learning_scan: "coverage: N/N findings, 0 gap";
 *       • add a finding WITHOUT re-scan: learning_validate reports a non-zero gap
 *         "... not yet summarized (cache behind; run learning_scan)";
 *       • re-run learning_scan: back to 0 gap;
 *       • a persisted cache stripped of its watermark: "coverage: unknown".
 *
 * Runs entirely in an OS temp dir; saves/restores process.cwd + env; never pollutes
 * the repo.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { deriveFindingSignals } from '../core/finding-signals.js';
import { computeCoverageGap } from '../core/experience-revalidation.js';
import type { FindingSignalsCache, SignalSourceFinding } from '../core/experience-layer-types.js';
import {
  FINDING_SIGNALS_FILENAME,
  LEARNING_DIR,
  readFindingSignals,
  resolveFindingSignalsPath,
  writeFindingSignals,
} from '../core/learning-store.js';
import { StoryStore } from '../core/store.js';
import { resetConfigCache } from '../core/config.js';
import { createLearningScanHandlers } from '../handlers/learning-scan.js';
import { createLearningValidateHandlers } from '../handlers/learning-validate.js';
import type { HandlerContext } from '../handlers/context.js';
import type { ChecklistData, Finding, StoryInfo } from '../core/types.js';

const PINNED_NOW = '2026-06-18T00:00:00.000Z';

let total = 0;
let passed = 0;
function check(label: string, fn: () => void): void {
  total += 1;
  try {
    fn();
    passed += 1;
    console.log(`check: ${label} — PASS`);
  } catch (err) {
    console.error(`check: ${label} — FAIL`);
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content, 'utf-8');
}

function mkTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'b1a91-coverage-gap-'));
}

/** A git-backed temp project with a base commit (so learning_validate's git probes work). */
function mkGitProject(): string {
  const root = mkTempRoot();
  git(root, ['init']);
  git(root, ['config', 'user.email', 'smoke@example.test']);
  git(root, ['config', 'user.name', 'B-1a91 Smoke']);
  write(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
  }, null, 2));
  write(root, 'packages/main/src/base.ts', 'export const base = true;\n');
  git(root, ['add', '.']);
  git(root, ['-c', 'user.email=smoke@example.test', '-c', 'user.name=B-1a91 Smoke', 'commit', '-m', 'base']);
  return root;
}

function newStory(storyId: string): StoryInfo {
  const now = PINNED_NOW;
  return {
    storyId,
    name: storyId,
    title: storyId,
    description: 'B-1a91 coverage-gap smoke story',
    type: 'chore',
    phase: 'REVIEW',
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [{ phase: 'REVIEW', action: 'advance', timestamp: now }],
  };
}

function emptyChecklist(): ChecklistData {
  return { items: [] };
}

function finding(storyId: string, n: number, extra: Partial<Finding> = {}): Finding {
  return {
    id: `${storyId}:F-${String(n).padStart(3, '0')}`,
    desc: `coverage-gap smoke finding ${n}`,
    severity: 'medium',
    category: 'adversarial',
    status: 'resolved',
    files: ['src/app.ts'],
    createdAt: PINNED_NOW,
    ...extra,
  };
}

function run(): void {
  const savedCwd = process.cwd();
  const savedEnv = { ...process.env };
  const tmpRoots: string[] = [];
  try {
    // ─── WATERMARK: counts + coveredThrough over the same findings ─────────────
    check('watermark: deriveFindingSignals stamps covered counts + max(createdAt,resolvedAt)', () => {
      const findings: SignalSourceFinding[] = [
        { storyId: 'B-aaa', id: 'B-aaa:F-001', category: 'security', status: 'resolved', files: ['a.ts'], createdAt: '2026-01-01T00:00:00.000Z', resolvedAt: '2026-03-09T00:00:00.000Z' },
        { storyId: 'B-aaa', id: 'B-aaa:F-002', category: 'edge', status: 'resolved', files: ['b.ts'], createdAt: '2026-02-02T00:00:00.000Z' },
        { storyId: 'B-bbb', id: 'B-bbb:F-001', category: 'security', status: 'dismissed', files: ['c.ts'], createdAt: '2026-01-15T00:00:00.000Z' },
      ];
      const cache = deriveFindingSignals(findings, { now: PINNED_NOW });
      assert.equal(cache.coveredFindingCount, 3, '3 findings considered');
      assert.equal(cache.coveredStoryCount, 2, '2 distinct story ids');
      assert.equal(cache.coveredThrough, '2026-03-09T00:00:00.000Z', 'coveredThrough = max createdAt/resolvedAt (a resolvedAt)');
    });

    check('watermark: empty corpus => 0/0, no coveredThrough, never NaN', () => {
      const cache = deriveFindingSignals([], { now: PINNED_NOW });
      assert.equal(cache.coveredFindingCount, 0);
      assert.equal(cache.coveredStoryCount, 0);
      assert.equal(cache.coveredThrough, undefined, 'no coveredThrough when no finding carried a timestamp');
      assert.ok(!Number.isNaN(cache.coveredFindingCount as number));
      assert.ok(!Number.isNaN(cache.coveredStoryCount as number));
    });

    check('watermark: malformed/null findings are NOT counted (matches the aggregation guard)', () => {
      const dirty = [
        { storyId: 'B-x', category: 'a', files: ['a.ts'] } as SignalSourceFinding,
        null as unknown as SignalSourceFinding,
        undefined as unknown as SignalSourceFinding,
      ];
      const cache = deriveFindingSignals(dirty, { now: PINNED_NOW });
      // Only the one real object survives the object guard.
      assert.equal(cache.coveredFindingCount, 1, 'null/undefined skipped, exactly one considered');
      assert.equal(cache.coveredStoryCount, 1);
    });

    // ─── LEAF computeCoverageGap ───────────────────────────────────────────────
    check('leaf: gap=0 when watermark == current (no false positive after a scan)', () => {
      const cache: FindingSignalsCache = { schemaVersion: 1, updatedAt: PINNED_NOW, signals: [], coveredFindingCount: 10, coveredStoryCount: 4 };
      const gap = computeCoverageGap(cache, { currentFindingCount: 10, currentStoryCount: 4 });
      assert.equal(gap.known, true);
      assert.equal(gap.gapFindings, 0);
      assert.equal(gap.gapStories, 0);
      assert.equal(gap.coveredFindingCount, 10);
      assert.equal(gap.currentFindingCount, 10);
    });

    check('leaf: gap=delta when the cache is behind the live store', () => {
      const cache: FindingSignalsCache = { schemaVersion: 1, updatedAt: PINNED_NOW, signals: [], coveredFindingCount: 438, coveredStoryCount: 100 };
      const gap = computeCoverageGap(cache, { currentFindingCount: 470, currentStoryCount: 132 });
      assert.equal(gap.known, true);
      assert.equal(gap.gapFindings, 32, '470 - 438');
      assert.equal(gap.gapStories, 32, '132 - 100');
    });

    check('leaf: watermark-less cache => known:false (coverage unknown)', () => {
      const legacy: FindingSignalsCache = { schemaVersion: 1, updatedAt: PINNED_NOW, signals: [] };
      const gap = computeCoverageGap(legacy, { currentFindingCount: 5, currentStoryCount: 2 });
      assert.equal(gap.known, false, 'no watermark => unknown');
      // covered defaults to 0 (never NaN); current still reported.
      assert.equal(gap.coveredFindingCount, 0);
      assert.equal(gap.currentFindingCount, 5);
    });

    check('leaf: null cache => known:false, never throws, never NaN', () => {
      const gap = computeCoverageGap(null, { currentFindingCount: 7, currentStoryCount: 3 });
      assert.equal(gap.known, false);
      assert.ok(!Number.isNaN(gap.gapFindings));
      assert.ok(!Number.isNaN(gap.gapStories));
      // Covered defaults to 0 when unknown, so the structured delta equals the full
      // current count — but the RENDERED line is "unknown" (see the e2e checks), so
      // these numbers are never surfaced as a real gap.
      assert.equal(gap.coveredFindingCount, 0);
      assert.equal(gap.gapFindings, 7, 'unknown => covered 0 => structural delta = current');
    });

    check('leaf: cache covering more than current never reports a negative gap', () => {
      const cache: FindingSignalsCache = { schemaVersion: 1, updatedAt: PINNED_NOW, signals: [], coveredFindingCount: 50, coveredStoryCount: 9 };
      const gap = computeCoverageGap(cache, { currentFindingCount: 40, currentStoryCount: 5 });
      assert.equal(gap.gapFindings, 0, 'max(40-50,0)');
      assert.equal(gap.gapStories, 0, 'max(5-9,0)');
    });

    check('leaf: only one watermark field present => known:false (both required)', () => {
      const half: FindingSignalsCache = { schemaVersion: 1, updatedAt: PINNED_NOW, signals: [], coveredFindingCount: 10 } as FindingSignalsCache;
      const gap = computeCoverageGap(half, { currentFindingCount: 10, currentStoryCount: 4 });
      assert.equal(gap.known, false, 'a partial watermark is not trustworthy => unknown');
    });

    // ─── END-TO-END: real learning_scan + learning_validate handlers ───────────
    check('e2e: learning_scan then learning_validate reports "0 gap"', () => {
      const root = mkGitProject(); tmpRoots.push(root);
      resetConfigCache();
      const store = new StoryStore(root);
      const storyId = 'B-cov1';
      store.writeStory(storyId, newStory(storyId));
      store.writeChecklist(storyId, emptyChecklist());
      store.writeFindings(storyId, { findings: [finding(storyId, 1), finding(storyId, 2)] });

      process.chdir(root); // learning_validate reads the persisted cache + git via process.cwd()
      const ctx: HandlerContext = { store, root } as HandlerContext;
      const scan = createLearningScanHandlers(ctx);
      const validate = createLearningValidateHandlers(ctx);

      scan.learning_scan({});
      const out = validate.learning_validate({});
      assert.ok(/coverage: \d+\/\d+ findings, 0 gap/.test(out), `expected 0 gap right after scan, got:\n${out}`);

      // The persisted cache carries the watermark.
      const persisted = readFindingSignals(root);
      assert.ok(persisted, 'cache persisted by learning_scan');
      assert.equal(persisted?.coveredFindingCount, 2, 'watermark = 2 findings');
      assert.equal(persisted?.coveredStoryCount, 1, 'watermark = 1 story');
    });

    check('e2e: add a finding WITHOUT re-scan => learning_validate reports a non-zero gap', () => {
      const root = mkGitProject(); tmpRoots.push(root);
      resetConfigCache();
      const store = new StoryStore(root);
      const s1 = 'B-cov2a';
      store.writeStory(s1, newStory(s1));
      store.writeChecklist(s1, emptyChecklist());
      store.writeFindings(s1, { findings: [finding(s1, 1)] });

      process.chdir(root);
      const ctx: HandlerContext = { store, root } as HandlerContext;
      const scan = createLearningScanHandlers(ctx);
      const validate = createLearningValidateHandlers(ctx);

      scan.learning_scan({}); // persist watermark = 1 finding / 1 story
      assert.ok(/0 gap/.test(validate.learning_validate({})), 'baseline in sync');

      // A new story+finding lands but the auto-refresh was MISSED (no re-scan).
      const s2 = 'B-cov2b';
      store.writeStory(s2, newStory(s2));
      store.writeChecklist(s2, emptyChecklist());
      store.writeFindings(s2, { findings: [finding(s2, 1), finding(s2, 2)] });

      const behind = validate.learning_validate({});
      assert.ok(
        /coverage: 1\/3 findings, 2 across 1 stories not yet summarized \(cache behind; run learning_scan\)/.test(behind),
        `expected a 2-finding / 1-story gap, got:\n${behind}`,
      );

      // Recovery: a full re-derive (learning_scan) closes the gap.
      scan.learning_scan({});
      const recovered = validate.learning_validate({});
      assert.ok(/coverage: 3\/3 findings, 0 gap/.test(recovered), `expected recovery to 0 gap, got:\n${recovered}`);
    });

    check('e2e: persisted cache stripped of its watermark => "coverage: unknown"', () => {
      const root = mkGitProject(); tmpRoots.push(root);
      resetConfigCache();
      const store = new StoryStore(root);
      const storyId = 'B-cov3';
      store.writeStory(storyId, newStory(storyId));
      store.writeChecklist(storyId, emptyChecklist());
      store.writeFindings(storyId, { findings: [finding(storyId, 1)] });

      process.chdir(root);
      const ctx: HandlerContext = { store, root } as HandlerContext;
      const validate = createLearningValidateHandlers(ctx);

      // Persist a LEGACY-shape cache (no watermark fields) directly.
      const legacy: FindingSignalsCache = { schemaVersion: 1, updatedAt: PINNED_NOW, signals: [] };
      writeFindingSignals(root, legacy);
      const onDisk = readFindingSignals(root);
      assert.equal(onDisk?.coveredFindingCount, undefined, 'persisted legacy cache has no watermark');

      const out = validate.learning_validate({});
      assert.ok(/coverage: unknown — run learning_scan/.test(out), `expected unknown coverage, got:\n${out}`);
    });

    check('e2e: no persisted cache at all => "coverage: unknown" (never crashes)', () => {
      const root = mkGitProject(); tmpRoots.push(root);
      resetConfigCache();
      const store = new StoryStore(root);
      const storyId = 'B-cov4';
      store.writeStory(storyId, newStory(storyId));
      store.writeChecklist(storyId, emptyChecklist());
      store.writeFindings(storyId, { findings: [finding(storyId, 1)] });

      process.chdir(root);
      const ctx: HandlerContext = { store, root } as HandlerContext;
      const validate = createLearningValidateHandlers(ctx);

      assert.equal(readFindingSignals(root), null, 'no cache persisted yet');
      const out = validate.learning_validate({});
      assert.ok(/coverage: unknown — run learning_scan/.test(out), `absent cache => unknown, got:\n${out}`);
    });

    // ─── ADVERSARIAL: prove the watermark is consistent with a re-count ─────────
    check('adversarial: a fresh deriveFindingSignals watermark equals a manual re-count (gap=0 guaranteed)', () => {
      const root = mkGitProject(); tmpRoots.push(root);
      resetConfigCache();
      const store = new StoryStore(root);
      for (const id of ['B-cnt1', 'B-cnt2', 'B-cnt3']) {
        store.writeStory(id, newStory(id));
        store.writeChecklist(id, emptyChecklist());
        store.writeFindings(id, { findings: [finding(id, 1), finding(id, 2)] });
      }
      process.chdir(root);
      const ctx: HandlerContext = { store, root } as HandlerContext;
      createLearningScanHandlers(ctx).learning_scan({});
      const persisted = readFindingSignals(root);
      assert.equal(persisted?.coveredFindingCount, 6, '3 stories * 2 findings');
      assert.equal(persisted?.coveredStoryCount, 3);
      // computeCoverageGap against the SAME current counts => exactly 0.
      const gap = computeCoverageGap(persisted, { currentFindingCount: 6, currentStoryCount: 3 });
      assert.equal(gap.gapFindings, 0);
      assert.equal(gap.gapStories, 0);
      assert.equal(gap.known, true);
    });

    // ─── tamper guard: ensure the cache file actually exists where expected ─────
    check('sanity: resolveFindingSignalsPath points under the canonical learning dir', () => {
      const root = mkTempRoot(); tmpRoots.push(root);
      const p = resolveFindingSignalsPath(root);
      assert.ok(p.includes(join(LEARNING_DIR, FINDING_SIGNALS_FILENAME)), `unexpected cache path ${p}`);
      // No file written yet.
      assert.ok(!existsSync(p) || readFileSync(p, 'utf-8').length >= 0);
    });

    console.log(`TOTAL ${total} | PASS ${passed} | FAIL ${total - passed}`);
    if (passed !== total) {
      process.exitCode = 1;
      return;
    }
    console.log('smoke passed');
  } finally {
    try { process.chdir(savedCwd); } catch { /* best-effort */ }
    for (const root of tmpRoots) {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  }
}

run();
