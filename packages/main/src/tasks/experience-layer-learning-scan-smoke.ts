#!/usr/bin/env node
/**
 * B-4eb6 CHK-003: smoke suite for Experience Layer ③.1 — `learning_scan`
 * derive + PERSIST, and the END-TO-END proof that persisting the cache ACTIVATES
 * the previously-inert Phase 1.5 advisory review hints.
 *
 * Coverage (named `check:` lines; exits non-zero on any failure; prints
 * `learning-scan smoke passed` at the very end):
 *   - BEFORE scan (absent / empty cache) the hint loader returns NO hints.
 *   - Running the scan handler PERSISTS .proof-or-stop/learning/finding-signals.json as
 *     a valid FindingSignalsCache (schemaVersion, signals[] with anchorFiles where
 *     the composing findings carried files).
 *   - AFTER scan the hint loader returns a NON-EMPTY hints section for a story
 *     whose accumulated findings match a recurring signal — proving the loop fires
 *     (empty before -> firing after).
 *   - Re-running the scan with a pinned `now` is deterministic (byte-identical cache).
 *   - Zero-findings store -> signals:[] (empty array, not undefined/null/crash).
 *   - --story scoping restricts derivation to one story.
 *
 * Runs entirely in an OS temp dir (hermetic, no network); cleans up after itself.
 */

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadExperienceHints,
  formatExperienceHintsSection,
  hasExperienceHints,
} from '../core/experience-hint-loader.js';
import { deriveFindingSignalsFromStore } from '../core/finding-signals.js';
import type { FindingSignalsCache } from '../core/experience-layer-types.js';
import {
  resolveFindingSignalsPath,
  readFindingSignals,
} from '../core/learning-store.js';
import { StoryStore } from '../core/store.js';
import { createLearningScanHandlers } from '../handlers/learning-scan.js';
import type { Finding, StoryInfo } from '../core/types.js';

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

const tmpRoots: string[] = [];
function mkTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'b4eb6-learning-scan-'));
  tmpRoots.push(root);
  return root;
}

/** A minimal story envelope so listStoryIds() enumerates the seeded story. */
function seedStory(store: StoryStore, storyId: string): void {
  const story: StoryInfo = {
    storyId,
    name: storyId,
    title: `Learning-scan smoke story ${storyId}`,
    description: 'Synthetic story for learning_scan derive+persist smoke.',
    type: 'chore',
    phase: 'DONE',
    priority: 'medium',
    createdAt: PINNED_NOW,
    startedAt: PINNED_NOW,
    endedAt: PINNED_NOW,
    events: [{ phase: 'DONE', action: 'advance', timestamp: PINNED_NOW }],
  };
  store.writeStory(storyId, story);
}

/**
 * Build a resolved finding with resolutionType=fixed. With several of these
 * sharing a category + file-kind (and no signatureTag), they aggregate into one
 * localSignature with signalScore = positive/(positive+1) (e.g. 2 fixed => 0.667)
 * which clears the recurring threshold (>=0.65).
 */
function fixedFinding(storyId: string, n: number, file: string): Finding {
  return {
    id: `${storyId}:F-00${n}`,
    desc: `recurring edge case in ${file}`,
    severity: 'high',
    category: 'edge',
    status: 'resolved',
    resolutionType: 'fixed',
    files: [file],
    createdAt: PINNED_NOW,
  };
}

/** Seed a story whose findings all share one recurring (fixed) localSignature. */
function seedRecurringStory(store: StoryStore, storyId: string): void {
  seedStory(store, storyId);
  store.writeFindings(storyId, {
    findings: [
      fixedFinding(storyId, 1, 'src/widget.ts'),
      fixedFinding(storyId, 2, 'src/widget.ts'),
      fixedFinding(storyId, 3, 'src/widget.ts'),
    ],
  });
}

function runScan(root: string, args: { json?: boolean; story?: string } = {}): string {
  const store = new StoryStore(root);
  return createLearningScanHandlers({
    store,
    root,
    scanRoot: join(root, 'packages/main'),
  }).learning_scan(args);
}

// ─── END-TO-END: empty before -> firing after ─────────────────────────────────

check('BEFORE scan: no cache => hint loader returns NO hints', () => {
  const root = mkTempRoot();
  const store = new StoryStore(root);
  seedRecurringStory(store, 'B-rec1');
  // No scan has run yet — the cache file is absent.
  assert.equal(existsSync(resolveFindingSignalsPath(root)), false, 'cache absent pre-scan');
  const hints = loadExperienceHints(root);
  assert.equal(hasExperienceHints(hints), false, 'no hints before the cache is written');
  assert.equal(formatExperienceHintsSection(hints), '', 'empty section before scan');
});

check('scan PERSISTS a valid FindingSignalsCache (schemaVersion, signals[], anchorFiles)', () => {
  const root = mkTempRoot();
  const store = new StoryStore(root);
  seedRecurringStory(store, 'B-rec2');
  runScan(root);
  const cachePath = resolveFindingSignalsPath(root);
  assert.ok(existsSync(cachePath), '.proof-or-stop/learning/finding-signals.json written');
  const parsed = JSON.parse(readFileSync(cachePath, 'utf8')) as FindingSignalsCache;
  assert.equal(parsed.schemaVersion, 1, 'schemaVersion present');
  assert.ok(Array.isArray(parsed.signals), 'signals is an array');
  assert.ok(parsed.signals.length >= 1, 'at least one signal derived');
  assert.ok(typeof parsed.updatedAt === 'string' && parsed.updatedAt.length > 0, 'updatedAt present');
  // The composing findings carried files => anchorFiles must propagate.
  const withAnchors = parsed.signals.find((s) => Array.isArray(s.anchorFiles) && s.anchorFiles.length > 0);
  assert.ok(withAnchors, 'a signal carries anchorFiles (propagated from finding.files)');
  assert.ok(withAnchors!.anchorFiles!.includes('src/widget.ts'), 'anchorFiles holds the finding file');
});

check('AFTER scan: hint loader returns NON-EMPTY hints (the loop activates)', () => {
  const root = mkTempRoot();
  const store = new StoryStore(root);
  seedRecurringStory(store, 'B-rec3');
  // Empty before...
  assert.equal(hasExperienceHints(loadExperienceHints(root)), false, 'empty before scan');
  // ...run the scan to persist the cache...
  runScan(root);
  // ...firing after.
  const hints = loadExperienceHints(root);
  assert.ok(hasExperienceHints(hints), 'hints fire after the scan persists the cache');
  assert.ok(hints.recurring.length >= 1, 'at least one recurring hint surfaced');
  const section = formatExperienceHintsSection(hints);
  assert.ok(section.includes('Project experience hints (advisory only):'), 'advisory section present after scan');
});

// ─── determinism / boundaries ─────────────────────────────────────────────────

check('re-running the scan with a pinned now is deterministic (byte-identical cache)', () => {
  const root = mkTempRoot();
  const store = new StoryStore(root);
  seedRecurringStory(store, 'B-rec4');
  // Drive the deterministic derive+persist twice with a pinned now via the
  // store adapter (the handler uses real time; determinism is a property of the
  // persisted cache given a pinned now, which the verifier/CLI proves separately).
  const cachePath = resolveFindingSignalsPath(root);
  deriveFindingSignalsFromStore(store, { projectRoot: root, now: PINNED_NOW });
  const first = readFileSync(cachePath, 'utf8');
  deriveFindingSignalsFromStore(store, { projectRoot: root, now: PINNED_NOW });
  const second = readFileSync(cachePath, 'utf8');
  assert.equal(first, second, 'two pinned-now scans yield byte-identical cache');
});

check('zero-findings store => signals:[] (empty array, no crash)', () => {
  const root = mkTempRoot();
  const store = new StoryStore(root);
  seedStory(store, 'B-empty'); // story exists, but no findings written
  const out = runScan(root, { json: true });
  const payload = JSON.parse(out) as { written: boolean; signals: number };
  assert.equal(payload.written, true, 'json reports written:true');
  assert.equal(payload.signals, 0, 'zero signals for an empty store');
  const cache = readFindingSignals(root);
  assert.ok(cache, 'cache still written');
  assert.deepEqual(cache!.signals, [], 'signals is an empty array, not undefined/null');
});

check('--story scoping restricts derivation to one story', () => {
  const root = mkTempRoot();
  const store = new StoryStore(root);
  seedRecurringStory(store, 'B-scopeA');
  seedRecurringStory(store, 'B-scopeB');
  runScan(root, { story: 'B-scopeA' });
  const cache = readFindingSignals(root);
  assert.ok(cache, 'cache written');
  const exampleStories = new Set(cache!.signals.flatMap((s) => s.exampleStoryIds));
  assert.ok(exampleStories.has('B-scopeA'), 'scoped story contributes signals');
  assert.ok(!exampleStories.has('B-scopeB'), 'unscoped story is excluded');
});

check('--story nonexistent-id => signals:[] and no error', () => {
  const root = mkTempRoot();
  const store = new StoryStore(root);
  seedRecurringStory(store, 'B-real');
  const out = runScan(root, { story: 'B-does-not-exist', json: true });
  const payload = JSON.parse(out) as { written: boolean; signals: number };
  assert.equal(payload.written, true, 'still writes the cache');
  assert.equal(payload.signals, 0, 'non-matching story filter yields zero signals');
});

// ─── summary ──────────────────────────────────────────────────────────────────

try {
  console.log(`TOTAL ${total} | PASS ${passed} | FAIL ${total - passed}`);
  if (passed !== total) {
    process.exitCode = 1;
  } else {
    console.log('learning-scan smoke passed');
  }
} finally {
  for (const root of tmpRoots) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
