/**
 * B-1dc9 CHK-001: Experience Layer Phase 1.5 — advisory experience-hint loader.
 *
 * Reads the derived finding-signals cache (via the read-only learning-store) and
 * turns it into a small, ranked set of ADVISORY review-time hints with two
 * buckets:
 *
 *  - `recurring`: signatures with a high positive signalScore (>= 0.65) and at
 *    least one decisive sample — patterns worth surfacing because they recur and
 *    have historically been real (fixed) findings.
 *  - `falsePositives`: signatures with a low signalScore (< 0.45) AND a material
 *    number of false-positive dismissals — patterns reviewers historically waved
 *    off, so the hint says "this is commonly a false positive".
 *
 * Ranking: priority = signalScore * log(1 + support) * recencyBoost. The
 * `log(1 + support)` damping prevents a single high-score "one-hit wonder" from
 * dominating a moderate-score signature backed by many samples. Sorted by
 * priority descending, then capped (default <= 3 recurring + <= 2 false-positive)
 * with progressive disclosure (a one-line summary up front; full `detail` carried
 * on the object for on-demand expansion).
 *
 * PURITY / DETERMINISM: this module is advisory-only and NEVER calls Date.now()
 * or new Date() — the caller injects `opts.now` for the recencyBoost so the
 * output is deterministic given the same inputs (hermetic tests, reproducible
 * prompts). When `opts.now` is absent the recencyBoost is a flat 1 (no recency
 * weighting), so the ranking still degrades to signalScore * log(1 + support).
 *
 * ISOLATION BAR: imports ONLY the read-only learning-store, the leaf types, and
 * `node:` builtins. NO other outward import. Hint content must NEVER feed the
 * deterministic reviewRunId promptHash domain — see story-review.ts / review-run.ts.
 */

import type { FindingSignal, FindingSignalsCache } from './experience-layer-types.js';

import { readFindingSignals } from './learning-store.js';

/** Recurring-issue inclusion threshold: signalScore at or above this qualifies. */
export const RECURRING_SCORE_THRESHOLD = 0.65;
/** Common-false-positive inclusion threshold: signalScore strictly below this qualifies. */
export const FALSE_POSITIVE_SCORE_CEILING = 0.45;
/** Minimum false-positive dismissals for a low-score signal to count as a common false positive. */
export const FALSE_POSITIVE_MIN_COUNT = 2;
/** Default cap on recurring hints surfaced. */
export const DEFAULT_MAX_RECURRING = 3;
/** Default cap on common-false-positive hints surfaced. */
export const DEFAULT_MAX_FALSE_POSITIVE = 2;

/** One advisory experience hint derived from a finding-signal row. */
export interface ExperienceHint {
  /** Which bucket this hint belongs to. */
  kind: 'recurring' | 'common_false_positive';
  /** The source signal's aggregation key (used as a stable hint id). */
  localSignature: string;
  /** Progressive-disclosure summary line (score + support + source). */
  summary: string;
  /** Fuller advisory text shown on demand. */
  detail: string;
  /** Source signal's conservative positive-fraction in [0, 1]. */
  signalScore: number;
  /** Source signal's decisive-sample count (positive + negative). */
  support: number;
  /** Computed ranking priority (signalScore * log(1+support) * recencyBoost). */
  priority: number;
  /** Example story ids that contributed to this signature (deduped, sorted). */
  sourceStoryIds: string[];
}

/** Result of {@link loadExperienceHints}: the two capped, ranked buckets. */
export interface ExperienceHints {
  recurring: ExperienceHint[];
  falsePositives: ExperienceHint[];
}

export interface LoadExperienceHintsOptions {
  /** Pinned ISO "now" for the recencyBoost. Omitted => flat recencyBoost of 1. */
  now?: string;
  /** Cap on recurring hints (default {@link DEFAULT_MAX_RECURRING}). */
  maxRecurring?: number;
  /** Cap on common-false-positive hints (default {@link DEFAULT_MAX_FALSE_POSITIVE}). */
  maxFalsePositive?: number;
}

/** Half-life (days) for the recencyBoost decay; older signals weigh slightly less. */
const RECENCY_HALF_LIFE_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Compute a recency boost in (0, 1] from `lastSeen` relative to `now`. Returns a
 * flat 1 when either timestamp is missing/unparseable (no recency weighting) or
 * when `lastSeen` is at/after `now`. Never NaN; never <= 0.
 */
function recencyBoost(lastSeen: string | undefined, now: string | undefined): number {
  if (!now || !lastSeen) return 1;
  const nowMs = Date.parse(now);
  const seenMs = Date.parse(lastSeen);
  if (!Number.isFinite(nowMs) || !Number.isFinite(seenMs)) return 1;
  const ageDays = (nowMs - seenMs) / MS_PER_DAY;
  if (!(ageDays > 0)) return 1; // future / same instant => no decay
  // Exponential half-life decay, floored so it never reaches 0.
  const boost = Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
  return Number.isFinite(boost) && boost > 0 ? boost : 1;
}

function computePriority(signalScore: number, support: number, boost: number): number {
  return signalScore * Math.log(1 + support) * boost;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function firstSource(signal: FindingSignal): string {
  return Array.isArray(signal.exampleStoryIds) && signal.exampleStoryIds.length > 0
    ? signal.exampleStoryIds[0]
    : '(unknown)';
}

function fixedCount(signal: FindingSignal): number {
  const resolved = signal.counts?.resolved;
  return isFiniteNumber(resolved) ? resolved : 0;
}

function falsePositiveCount(signal: FindingSignal): number {
  const fp = signal.counts?.falsePositive;
  return isFiniteNumber(fp) ? fp : 0;
}

/**
 * One summary line per the progressive-disclosure requirement:
 * "score X · support N fixed / M false-positive · Source: <storyId>".
 */
function summaryLine(signal: FindingSignal): string {
  const fixed = fixedCount(signal);
  const fp = falsePositiveCount(signal);
  return `score ${round2(signal.signalScore)} · support ${fixed} fixed / ${fp} false-positive · Source: ${firstSource(signal)}`;
}

function recurringDetail(signal: FindingSignal): string {
  const fileKinds = Array.isArray(signal.fileKinds) && signal.fileKinds.length > 0
    ? signal.fileKinds.join(', ')
    : 'unknown';
  const sources = Array.isArray(signal.exampleStoryIds) && signal.exampleStoryIds.length > 0
    ? signal.exampleStoryIds.join(', ')
    : '(none)';
  return [
    `Recurring finding pattern "${signal.localSignature}" (category: ${signal.category}).`,
    `Historically a real issue (score ${round2(signal.signalScore)} over ${signal.support} decisive samples, ${fixedCount(signal)} fixed).`,
    `Observed in file kinds: ${fileKinds}. Example stories: ${sources}.`,
    'Advisory only: worth an extra look, but it does not gate this review.',
  ].join(' ');
}

function falsePositiveDetail(signal: FindingSignal): string {
  const sources = Array.isArray(signal.exampleStoryIds) && signal.exampleStoryIds.length > 0
    ? signal.exampleStoryIds.join(', ')
    : '(none)';
  return [
    `Commonly a FALSE POSITIVE: pattern "${signal.localSignature}" (category: ${signal.category}).`,
    `Reviewers have dismissed this ${falsePositiveCount(signal)} time(s) as a false positive (score ${round2(signal.signalScore)} over ${signal.support} samples).`,
    `Example stories: ${sources}.`,
    'Advisory only: before raising this, sanity-check whether it is the known false positive; it does not gate this review.',
  ].join(' ');
}

function toRecurringHint(signal: FindingSignal, now: string | undefined): ExperienceHint {
  const boost = recencyBoost(signal.lastSeen, now);
  return {
    kind: 'recurring',
    localSignature: signal.localSignature,
    summary: summaryLine(signal),
    detail: recurringDetail(signal),
    signalScore: signal.signalScore,
    support: signal.support,
    priority: computePriority(signal.signalScore, signal.support, boost),
    sourceStoryIds: Array.isArray(signal.exampleStoryIds) ? [...signal.exampleStoryIds] : [],
  };
}

function toFalsePositiveHint(signal: FindingSignal, now: string | undefined): ExperienceHint {
  const boost = recencyBoost(signal.lastSeen, now);
  // Rank false positives by how often they were dismissed (their "negative
  // weight"), damped by log(1+support) and recency — symmetric with recurring.
  const fpStrength = falsePositiveCount(signal);
  return {
    kind: 'common_false_positive',
    localSignature: signal.localSignature,
    summary: summaryLine(signal),
    detail: falsePositiveDetail(signal),
    signalScore: signal.signalScore,
    support: signal.support,
    priority: computePriority(fpStrength, signal.support, boost),
    sourceStoryIds: Array.isArray(signal.exampleStoryIds) ? [...signal.exampleStoryIds] : [],
  };
}

/**
 * Deterministic sort by priority descending, then by `localSignature` ascending
 * as a stable tiebreaker so identical priorities never flicker in ordering.
 */
function byPriorityDescThenSignature(a: ExperienceHint, b: ExperienceHint): number {
  if (b.priority !== a.priority) return b.priority - a.priority;
  return a.localSignature < b.localSignature ? -1 : a.localSignature > b.localSignature ? 1 : 0;
}

function isUsableSignal(signal: unknown): signal is FindingSignal {
  if (!signal || typeof signal !== 'object') return false;
  const s = signal as Partial<FindingSignal>;
  return (
    typeof s.localSignature === 'string'
    && s.localSignature.length > 0
    && isFiniteNumber(s.signalScore)
    && isFiniteNumber(s.support)
  );
}

function readUsableSignals(cache: FindingSignalsCache | null): FindingSignal[] {
  if (!cache || !Array.isArray(cache.signals)) return [];
  return cache.signals.filter(isUsableSignal);
}

/**
 * Load, rank, filter, and cap the advisory experience hints for a project.
 *
 * Reads `.lattice/learning/finding-signals.json` via the read-only learning-store
 * (returns empty buckets when the file is absent or malformed — graceful cold
 * start). Pure given its inputs + `opts.now`; never throws on bad data.
 */
export function loadExperienceHints(
  projectRoot: string,
  opts: LoadExperienceHintsOptions = {},
): ExperienceHints {
  const now = opts.now;
  const maxRecurring = isFiniteNumber(opts.maxRecurring) ? Math.max(0, Math.floor(opts.maxRecurring)) : DEFAULT_MAX_RECURRING;
  const maxFalsePositive = isFiniteNumber(opts.maxFalsePositive) ? Math.max(0, Math.floor(opts.maxFalsePositive)) : DEFAULT_MAX_FALSE_POSITIVE;

  const signals = readUsableSignals(readFindingSignals(projectRoot));

  const recurring = signals
    .filter((s) => s.signalScore >= RECURRING_SCORE_THRESHOLD && s.support >= 1)
    .map((s) => toRecurringHint(s, now))
    .sort(byPriorityDescThenSignature)
    .slice(0, maxRecurring);

  const falsePositives = signals
    .filter((s) => s.signalScore < FALSE_POSITIVE_SCORE_CEILING && falsePositiveCount(s) >= FALSE_POSITIVE_MIN_COUNT)
    .map((s) => toFalsePositiveHint(s, now))
    .sort(byPriorityDescThenSignature)
    .slice(0, maxFalsePositive);

  return { recurring, falsePositives };
}

/** True when there is at least one hint to surface. */
export function hasExperienceHints(hints: ExperienceHints): boolean {
  return hints.recurring.length > 0 || hints.falsePositives.length > 0;
}

/** All hint ids (localSignatures) in surfaced order: recurring first, then false positives. */
export function experienceHintIds(hints: ExperienceHints): string[] {
  return [...hints.recurring, ...hints.falsePositives].map((h) => h.localSignature);
}

/**
 * Render the advisory "Project experience hints" section as a string for the
 * story-review `_reviewPrompt`. Progressive disclosure: only the one-line
 * summaries are rendered here (full `detail` stays on the hint objects for
 * on-demand expansion). Returns '' when there are no hints, so the caller's
 * prompt is byte-unchanged when no signals exist.
 */
export function formatExperienceHintsSection(hints: ExperienceHints): string {
  if (!hasExperienceHints(hints)) return '';
  const lines: string[] = [
    '\n---\nProject experience hints (advisory only):',
    'Derived from past findings. These are nudges, not gates — they never block this review.',
  ];
  if (hints.recurring.length > 0) {
    lines.push('Recurring issues to watch for:');
    for (const hint of hints.recurring) {
      lines.push(`  - [${hint.localSignature}] ${hint.summary}`);
    }
  }
  if (hints.falsePositives.length > 0) {
    lines.push('Commonly false positives (sanity-check before raising):');
    for (const hint of hints.falsePositives) {
      lines.push(`  - [${hint.localSignature}] ${hint.summary}`);
    }
  }
  return lines.join('\n');
}
