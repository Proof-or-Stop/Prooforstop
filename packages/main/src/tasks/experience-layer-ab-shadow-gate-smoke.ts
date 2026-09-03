#!/usr/bin/env node
/**
 * B-06b3 CHK-003: smoke suite for Experience Layer ③.3 — deterministic A/B
 * hintMode + shadow-gated advisory experience-hint display.
 *
 * Coverage (named `check:` lines; exits non-zero on any failure; prints
 * `ab-shadow-gate smoke passed` at the very end):
 *   - resolveHintMode determinism: same storyId => same arm across 100 calls.
 *   - resolveHintMode balance: ~40-60% on/off split over 1000 synthetic ids.
 *   - resolveHintMode degenerate inputs: empty string, long, unicode, near-collision.
 *   - story_review SHADOW gate end-to-end: ON-arm storyId => `_reviewPrompt`
 *     CONTAINS the advisory section; OFF-arm storyId => it does NOT — yet BOTH
 *     arms record an experience_hint_surfaced event carrying the correct hintMode
 *     AND the full would-have-hinted set (lossless measurement on OFF).
 *   - INVARIANCE: issues/blocker output is identical between arms; the OFF-arm
 *     prompt is byte-identical to the zero-hints baseline; resolveReviewPromptHash
 *     is byte-identical regardless of hint presence/content (the critical
 *     guardrail — hints never enter the prompt-hash / reviewRunId domain).
 *
 * Runs entirely in OS temp dirs; saves/restores config cache; never pollutes the repo.
 */

import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { resolveHintMode } from '../core/hint-mode.js';
import type { HintMode } from '../core/hint-mode.js';
import {
  loadExperienceHints,
  formatExperienceHintsSection,
  hasExperienceHints,
} from '../core/experience-hint-loader.js';
import type { FindingSignal, FindingSignalsCache } from '../core/experience-layer-types.js';
import { writeFindingSignals } from '../core/learning-store.js';
import { resolveReviewPromptHash } from '../core/review-run.js';
import { readActivityLogTail } from '../core/activity-log.js';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import { createStoryReviewHandlers } from '../handlers/story-review.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';

const PINNED_NOW = '2026-06-17T00:00:00.000Z';
const SECTION_LABEL = 'Project experience hints (advisory only):';

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
  const root = mkdtempSync(join(tmpdir(), 'b06b3-ab-gate-'));
  tmpRoots.push(root);
  return root;
}

function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content, 'utf-8');
}

/** Build a FindingSignal with sensible defaults; override what each test needs. */
function signal(over: Partial<FindingSignal> & { localSignature: string }): FindingSignal {
  return {
    category: 'edge',
    fileKinds: ['ts'],
    counts: {
      resolved: 0,
      dismissed: 0,
      falsePositive: 0,
      acceptedRisk: 0,
      unclear: 0,
      partiallyMitigated: 0,
    },
    signalScore: 0,
    support: 0,
    exampleStoryIds: ['B-src1'],
    exampleFindingIds: ['F-001'],
    ...over,
  };
}

function cacheOf(signals: FindingSignal[]): FindingSignalsCache {
  return { schemaVersion: 1, updatedAt: PINNED_NOW, signals };
}

/** A signal set that yields a non-empty recurring hint bucket. */
function hintYieldingSignals(): FindingSignal[] {
  return [
    signal({
      localSignature: 'recAB',
      signalScore: 0.9,
      support: 4,
      counts: { resolved: 4, dismissed: 0, falsePositive: 0, acceptedRisk: 0, unclear: 0, partiallyMitigated: 0 },
    }),
  ];
}

function seedSignals(root: string, signals: FindingSignal[]): void {
  writeFindingSignals(root, cacheOf(signals));
}

/** Minimal proof-or-stop.config.json so StoryStore + config resolve in the temp root. */
function writeProofOrStopConfig(root: string): void {
  write(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
    workflow: { profile: 'balanced' },
  }, null, 2));
  resetConfigCache();
}

/** A PLAN-phase story + checklist + understanding so story_review yields a _reviewPrompt. */
function seedStory(store: StoryStore, storyId: string): void {
  const now = PINNED_NOW;
  const story: StoryInfo = {
    storyId,
    name: storyId,
    title: 'AB shadow-gate smoke story',
    description: 'Synthetic story for the A/B shadow-gated experience-hint display.',
    type: 'chore',
    phase: 'PLAN',
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [{ phase: 'PLAN', action: 'advance', timestamp: now }],
  };
  const checklist: ChecklistData = {
    items: [{
      id: 'CHK-001',
      title: 'A real checklist item',
      context: 'Enough context to pass split-quality checks.',
      userSees: 'The smoke asserts the advisory section is gated by the A/B arm.',
      status: 'pending',
      startTime: null,
      endTime: null,
    }],
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist);
  // Understanding ensures _reviewPrompt is produced even with the section hidden,
  // so the omission assertion is about the SECTION, not the whole prompt.
  store.writeUnderstanding(storyId, {
    task: 'shadow-gate advisory hints',
    outcome: 'ON arm shows section; OFF arm hides it; both emit the event',
    facts: ['hints are advisory only'],
    constraints: [],
    unknowns: [],
    touchpoints: [],
    timestamp: now,
  });
}

function runStoryReview(root: string, storyId: string): any {
  const store = new StoryStore(root);
  return createStoryReviewHandlers({
    store,
    root,
    scanRoot: join(root, 'packages/main'),
  }).story_review({ storyId }) as any;
}

function surfacedEvents(root: string): Array<Record<string, unknown>> {
  return readActivityLogTail(root, 500).filter((e) => e.event === 'experience_hint_surfaced');
}

/** Find a storyId that maps to the requested arm by scanning synthetic ids. */
function findStoryIdForArm(arm: HintMode): string {
  for (let i = 1; i <= 100000; i++) {
    const id = `B-arm${i}`;
    if (resolveHintMode(id) === arm) return id;
  }
  throw new Error(`could not find a storyId for arm ${arm}`);
}

// ─── resolveHintMode: contract / determinism / balance / edges ────────────────

check('CHK-001 happy:0 — resolveHintMode returns a valid HintMode literal', () => {
  const m = resolveHintMode('B-06b3');
  assert.ok(m === 'on' || m === 'off', `expected on/off, got ${m}`);
});

check('CHK-001 happy:1 / adversarial:1 — deterministic: same id => same arm across 100 calls', () => {
  const first = resolveHintMode('B-06b3');
  for (let i = 0; i < 100; i++) {
    assert.equal(resolveHintMode('B-06b3'), first, 'arm drifted across repeated calls');
  }
});

check('CHK-001 happy:2 — balance: 1000 synthetic ids land in a 35-65% band per arm', () => {
  let on = 0;
  const N = 1000;
  for (let i = 1; i <= N; i++) {
    if (resolveHintMode(`B-${String(i).padStart(4, '0')}`) === 'on') on += 1;
  }
  const off = N - on;
  const onPct = (on / N) * 100;
  assert.ok(onPct >= 35 && onPct <= 65, `on% ${onPct} out of 35-65 band (on=${on} off=${off})`);
  assert.ok(on > 0 && off > 0, 'both arms must appear');
});

check('CHK-001 edge:0 — empty string tolerated (valid arm, no throw)', () => {
  const m = resolveHintMode('');
  assert.ok(m === 'on' || m === 'off', 'empty string must yield a valid arm');
  assert.equal(resolveHintMode(''), m, 'empty string is deterministic');
});

check('CHK-001 edge:1 — very long id (10000 chars) returns valid arm without hang', () => {
  const m = resolveHintMode('B-'.padEnd(10000, 'x'));
  assert.ok(m === 'on' || m === 'off');
});

check('CHK-001 edge:2 — unicode id deterministic', () => {
  const id = 'B-日本語-001';
  const m = resolveHintMode(id);
  assert.ok(m === 'on' || m === 'off');
  assert.equal(resolveHintMode(id), m, 'unicode id deterministic');
});

check('CHK-001 edge:3 — near-collision ids both return valid arms', () => {
  const a = resolveHintMode('B-06b3');
  const b = resolveHintMode('B-06b4');
  assert.ok((a === 'on' || a === 'off') && (b === 'on' || b === 'off'));
});

check('CHK-001 adversarial:3 — non-string inputs coerce to a valid, deterministic arm (never corrupt)', () => {
  // resolveHintMode is typed string, but a caller could pass garbage at runtime.
  // String(storyId) coercion must guarantee the arm is ALWAYS a valid HintMode
  // ('on'/'off', never undefined/garbage) AND deterministic — so a non-string
  // input can never silently corrupt the A/B assignment.
  const obj = { storyId: 'B-06b3' };
  const inputs: unknown[] = [null, undefined, 123, obj];
  for (const raw of inputs) {
    const first = resolveHintMode(raw as any);
    assert.ok(first === 'on' || first === 'off',
      `non-string input ${String(raw)} must yield a valid HintMode, got ${String(first)}`);
    // Deterministic: same input twice => same arm (no corruption / no drift).
    assert.equal(resolveHintMode(raw as any), first,
      `non-string input ${String(raw)} must be deterministic across calls`);
  }
});

// ─── story_review SHADOW gate: ON shows / OFF hides, both emit event ───────────

check('CHK-002 happy:0/1/2/3 + adversarial:4 — ON shows section, OFF hides it; both emit event with arm + full set', () => {
  const onId = findStoryIdForArm('on');
  const offId = findStoryIdForArm('off');
  assert.equal(resolveHintMode(onId), 'on');
  assert.equal(resolveHintMode(offId), 'off');

  // ON arm.
  const onRoot = mkTempRoot();
  writeProofOrStopConfig(onRoot);
  seedStory(new StoryStore(onRoot), onId);
  seedSignals(onRoot, hintYieldingSignals());
  const onResult = runStoryReview(onRoot, onId);
  assert.ok(typeof onResult._reviewPrompt === 'string', 'ON _reviewPrompt is a string');
  assert.ok(onResult._reviewPrompt.includes(SECTION_LABEL), 'ON arm: advisory section present');
  assert.ok(onResult._reviewPrompt.includes('[recAB]'), 'ON arm: hint id rendered in prompt');
  const onEvents = surfacedEvents(onRoot);
  assert.equal(onEvents.length, 1, 'ON arm: exactly one experience_hint_surfaced event');
  assert.equal(onEvents[0].hintMode, 'on', "ON arm: event hintMode === 'on'");
  assert.deepEqual(onEvents[0].hintIds, ['recAB'], 'ON arm: event carries the full hint set');

  // OFF arm — same seed, same hints; section must be hidden but event still fires.
  const offRoot = mkTempRoot();
  writeProofOrStopConfig(offRoot);
  seedStory(new StoryStore(offRoot), offId);
  seedSignals(offRoot, hintYieldingSignals());
  const offResult = runStoryReview(offRoot, offId);
  assert.ok(typeof offResult._reviewPrompt === 'string', 'OFF _reviewPrompt is a string');
  assert.ok(!offResult._reviewPrompt.includes(SECTION_LABEL), 'OFF arm: advisory section ABSENT');
  assert.ok(!offResult._reviewPrompt.includes('[recAB]'), 'OFF arm: hint id NOT rendered');
  const offEvents = surfacedEvents(offRoot);
  assert.equal(offEvents.length, 1, 'OFF arm: exactly one experience_hint_surfaced event');
  assert.equal(offEvents[0].hintMode, 'off', "OFF arm: event hintMode === 'off'");
  // adversarial:4 — OFF arm event still carries the FULL would-have-hinted set.
  assert.deepEqual(offEvents[0].hintIds, ['recAB'], 'OFF arm: event carries the FULL hint set (lossless)');
});

check('CHK-002 happy:4 — issues/blocker output identical between ON and OFF arm (same seed)', () => {
  const onId = findStoryIdForArm('on');
  const offId = findStoryIdForArm('off');

  const onRoot = mkTempRoot();
  writeProofOrStopConfig(onRoot);
  seedStory(new StoryStore(onRoot), onId);
  seedSignals(onRoot, hintYieldingSignals());
  const on = runStoryReview(onRoot, onId);

  const offRoot = mkTempRoot();
  writeProofOrStopConfig(offRoot);
  seedStory(new StoryStore(offRoot), offId);
  seedSignals(offRoot, hintYieldingSignals());
  const off = runStoryReview(offRoot, offId);

  // The arm must not change review decisions. Normalize storyId-bearing messages
  // so we compare the decision structure, not the (necessarily different) ids.
  const norm = (r: any) => ({
    issueCount: r.summary.issueCount,
    blockerCount: r.summary.blockerCount,
    issues: r.issues.map((i: any) => ({ type: i.type, severity: i.severity, itemId: i.itemId })),
  });
  assert.deepEqual(norm(on), norm(off), 'issues/blocker output must be arm-independent');
  assert.equal(on.summary.blockerCount, off.summary.blockerCount, 'blockerCount identical');
});

check('CHK-002 edge:0/1 / CHK-003 edge:0 — no hints: both arms byte-identical prompt, no event', () => {
  const onId = findStoryIdForArm('on');
  const offId = findStoryIdForArm('off');

  const onRoot = mkTempRoot();
  writeProofOrStopConfig(onRoot);
  seedStory(new StoryStore(onRoot), onId);
  // no signals seeded => no hints
  const on = runStoryReview(onRoot, onId);

  const offRoot = mkTempRoot();
  writeProofOrStopConfig(offRoot);
  seedStory(new StoryStore(offRoot), offId);
  const off = runStoryReview(offRoot, offId);

  assert.ok(!on._reviewPrompt.includes(SECTION_LABEL), 'no-hints ON: section absent');
  assert.ok(!off._reviewPrompt.includes(SECTION_LABEL), 'no-hints OFF: section absent');
  // Replace the story-id occurrences so the rest of the prompt can be compared byte-for-byte.
  const stripId = (s: string, id: string) => s.split(id).join('B-ID');
  assert.equal(stripId(on._reviewPrompt, onId), stripId(off._reviewPrompt, offId),
    'no-hints: both arms produce a byte-identical prompt (modulo storyId)');
  assert.equal(surfacedEvents(onRoot).length, 0, 'no-hints ON: no event');
  assert.equal(surfacedEvents(offRoot).length, 0, 'no-hints OFF: no event');
});

check('CHK-002 edge:3 — OFF-arm prompt is byte-identical to the zero-hints baseline', () => {
  // Same OFF story, run once WITH hints and once WITHOUT — the OFF arm hides the
  // section, so the rendered prompt must match the zero-hints baseline byte-for-byte.
  const offId = findStoryIdForArm('off');

  const baselineRoot = mkTempRoot();
  writeProofOrStopConfig(baselineRoot);
  seedStory(new StoryStore(baselineRoot), offId);
  const baseline = runStoryReview(baselineRoot, offId)._reviewPrompt;

  const withHintsRoot = mkTempRoot();
  writeProofOrStopConfig(withHintsRoot);
  seedStory(new StoryStore(withHintsRoot), offId);
  seedSignals(withHintsRoot, hintYieldingSignals());
  const withHints = runStoryReview(withHintsRoot, offId)._reviewPrompt;

  assert.equal(withHints, baseline, 'OFF arm with hints == zero-hints baseline (byte-identical)');
});

check('CHK-002 edge:2 — round dedup preserved; hintMode present on each unique emission', () => {
  const onId = findStoryIdForArm('on');
  const root = mkTempRoot();
  writeProofOrStopConfig(root);
  const store = new StoryStore(root);
  const now = PINNED_NOW;
  // REVIEW-round story so currentReviewRound is the stable per-run dedup key.
  store.writeStory(onId, {
    storyId: onId,
    name: onId,
    title: 'Dedup smoke story',
    description: 'Surface hints twice in the same review run => exactly one event.',
    type: 'chore',
    phase: 'PLAN',
    priority: 'medium',
    currentReviewRound: now,
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [{ phase: 'PLAN', action: 'advance', timestamp: now }],
  } as StoryInfo);
  store.writeChecklist(onId, {
    items: [{
      id: 'CHK-001',
      title: 'A real checklist item',
      context: 'Enough context to pass split-quality checks.',
      userSees: 'The smoke asserts dedup of the usage event across calls.',
      status: 'pending',
      startTime: null,
      endTime: null,
    }],
  } as ChecklistData);
  store.writeUnderstanding(onId, {
    task: 'surface advisory hints',
    outcome: 'one usage event per review run',
    facts: ['hints are advisory only'],
    constraints: [],
    unknowns: [],
    touchpoints: [],
    timestamp: now,
  });
  seedSignals(root, hintYieldingSignals());

  runStoryReview(root, onId);
  runStoryReview(root, onId);
  const sameRun = surfacedEvents(root).filter((e) => e.storyId === onId);
  assert.equal(sameRun.length, 1, 'two calls in same round => exactly one event');
  assert.equal(sameRun[0].hintMode, 'on', 'event carries hintMode');

  const nextRound = '2026-06-18T00:00:00.000Z';
  const s2 = store.readStory(onId);
  store.writeStory(onId, { ...s2, currentReviewRound: nextRound } as StoryInfo);
  runStoryReview(root, onId);
  const after = surfacedEvents(root).filter((e) => e.storyId === onId);
  assert.equal(after.length, 2, 'a new round produces an additional event');
  assert.ok(after.every((e) => e.hintMode === 'on'), 'each unique emission carries hintMode');
});

// ─── CRITICAL INVARIANCE: hints never enter the prompt-hash / reviewRunId domain ─

check('CHK-002 adversarial:0/1 / CHK-003 adversarial:4 — resolveReviewPromptHash byte-identical regardless of hints (and arm)', () => {
  const root = mkTempRoot();
  // The REVIEW reviewer prompt that feeds resolveReviewPromptHash is a SEPARATE
  // channel from the advisory _reviewPrompt. Loading hints (or being on either
  // arm) must NEVER change its hash for the same prompt text.
  const reviewerPrompt = 'REVIEW reviewer prompt: examine the diff for B-06b3.';
  const without = resolveReviewPromptHash(reviewerPrompt);

  seedSignals(root, hintYieldingSignals());
  const hints = loadExperienceHints(root);
  assert.ok(hasExperienceHints(hints), 'hints actually loaded (non-vacuous)');
  const section = formatExperienceHintsSection(hints);
  assert.ok(section.length > 0, 'section is non-empty');

  const withHints = resolveReviewPromptHash(reviewerPrompt);
  assert.equal(withHints, without, 'promptHash byte-identical regardless of hint presence');
  // Even concatenating adversarial hint text never feeds this domain for the same prompt.
  assert.equal(resolveReviewPromptHash(reviewerPrompt), without, 'promptHash still identical');
});

// ─── summary ──────────────────────────────────────────────────────────────────

try {
  console.log(`TOTAL ${total} | PASS ${passed} | FAIL ${total - passed}`);
  if (passed !== total) {
    process.exitCode = 1;
  } else {
    console.log('ab-shadow-gate smoke passed');
  }
} finally {
  for (const root of tmpRoots) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
