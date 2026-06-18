/**
 * B-c06a CHK-001 (Experience Layer ③.4): learning_effectiveness pure leaf.
 *
 * Two deterministic readouts over an already temporal-ascending list of stories:
 *
 *   1. FAST predictive value (`computePredictiveValue`) — a RETRODICTIVE pass that
 *      asks: of the findings raised in each story, how many carried a signatureTag
 *      that was ALREADY known from an EARLIER story (i.e. could the experience hint
 *      have pre-warned us)? This is the per-story hint predictive value, aggregated
 *      overall plus a windowed trend with a coarse slope sign.
 *
 *   2. LONG-GAME ON/OFF arm comparison (`computeArmComparison`) — groups the same
 *      stories by their recorded hintMode ('on'/'off') and compares the mean
 *      "uncaught recurrence rate" per arm. The significance flag is a CONSERVATIVE
 *      gate on sample size ONLY (>= MIN_ARM_N per arm); we deliberately do NOT
 *      compute a p-value, and the note always states the delta is observational.
 *
 * This module is a LEAF: it imports ONLY node builtins (none are needed) and
 * type-only symbols. It does NO filesystem / git / child_process / network I/O,
 * uses no wall-clock, no random source, and no environment lookups, and never
 * produces NaN (every denominator is guarded to yield 0). The handler injects the
 * fully-built, ordered `EffStory[]`, so the leaf stays trivially testable.
 */

/** Provenance of a finding's signatureTag (mirrors core/experience-layer-types). */
export type EffSignatureTagSource = 'auto' | 'confirmed';

/** One finding projection the effectiveness pass reads. */
export interface EffFinding {
  /** The recurrence key; empty/undefined => the finding carries no signature. */
  signatureTag?: string;
  /** Provenance; only 'confirmed' counts when opts.confirmedOnly is set. */
  signatureTagSource?: string;
}

/**
 * One story projection, ALREADY temporal-ascending (earliest first). The handler
 * sorts by createdAt before calling the leaf.
 */
export interface EffStory {
  storyId: string;
  createdAt: string;
  /** The recorded A/B arm; stories with no recorded arm are skipped in the comparison. */
  hintMode?: 'on' | 'off';
  findings: EffFinding[];
}

/** Options threaded from the CLI flags. */
export interface PredictiveValueOptions {
  /** Count only findings whose signatureTagSource === 'confirmed'. */
  confirmedOnly?: boolean;
  /** Stories per windowed-trend bucket (default 25). */
  window?: number;
}

/** One windowed-trend bucket: the story cutoff index and that bucket's hit-rate. */
export interface PredictiveValueWindow {
  /** 1-based story index at the END of this window (the cutoff). */
  cutoff: number;
  /** preWarnable / findingsWithSig within this window's stories (0 when empty). */
  hitRate: number;
}

export interface PredictiveValueReport {
  /** Number of stories processed. */
  stories: number;
  /** Total findings that carried a qualifying (non-empty) signatureTag. */
  findingsWithSig: number;
  /** Findings whose signatureTag was ALREADY known from an earlier story. */
  preWarnable: number;
  /**
   * recall = preWarnable / findingsWithSig. Of every finding that carried a
   * signature, the fraction whose signature an experience hint could have
   * surfaced ahead of time (because it appeared in an earlier story).
   */
  recall: number;
  /** Per-window hit-rate trend (windows of opts.window stories). */
  windows: PredictiveValueWindow[];
  /** Coarse trend direction from first vs last window hit-rate: '+', '-', or '0'. */
  slopeSign: '+' | '-' | '0';
}

export interface ArmComparison {
  /** Story count in the ON arm. */
  nOn: number;
  /** Story count in the OFF arm. */
  nOff: number;
  /** Mean uncaught-recurrence-rate over ON-arm stories (0 when nOn === 0). */
  outcomeOn: number;
  /** Mean uncaught-recurrence-rate over OFF-arm stories (0 when nOff === 0). */
  outcomeOff: number;
  /** outcomeOff - outcomeOn (a positive delta = ON arm recurs less). */
  delta: number;
  /** CONSERVATIVE flag: true ONLY when both arms meet MIN_ARM_N (no p-value). */
  significant: boolean;
  /** Human note: insufficient-N reason, or that the delta is observational. */
  note: string;
}

/** Minimum stories per arm before the ON/OFF readout is even allowed to be flagged. */
export const MIN_ARM_N = 20;

/** Default stories per windowed-trend bucket. */
const DEFAULT_WINDOW = 25;

/** True only for a non-empty string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * The qualifying signatureTag of a finding, or undefined when it has none (or,
 * under confirmedOnly, when its provenance is not 'confirmed'). Empty-string and
 * non-string tags are treated as "no signature".
 */
function qualifyingTag(finding: EffFinding, confirmedOnly: boolean): string | undefined {
  if (!finding || typeof finding !== 'object') return undefined;
  if (!isNonEmptyString(finding.signatureTag)) return undefined;
  if (confirmedOnly && finding.signatureTagSource !== 'confirmed') return undefined;
  return finding.signatureTag;
}

/** Safe ratio: 0 when the denominator is 0 (never NaN). */
function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

/** Per-story retrodictive counts produced by a single prior-signatures pass. */
interface StoryRetrodiction {
  findingsWithSig: number;
  preWarnable: number;
}

/**
 * Single shared pass: iterate stories in order, maintaining the set of
 * signatureTags seen in STRICTLY EARLIER stories, and record per-story
 * findingsWithSig / preWarnable. AFTER a story is scored, its own qualifying
 * signatures are folded into the prior set (so a finding never pre-warns itself
 * within the same story). Both `computePredictiveValue` and `computeArmComparison`
 * consume this so the two readouts share one definition of "already known".
 */
function retrodict(stories: EffStory[], confirmedOnly: boolean): StoryRetrodiction[] {
  const priorSignatures = new Set<string>();
  const out: StoryRetrodiction[] = [];
  const list = Array.isArray(stories) ? stories : [];
  for (const story of list) {
    const findings = Array.isArray(story?.findings) ? story.findings : [];
    let findingsWithSig = 0;
    let preWarnable = 0;
    // Tags this story contributes to the prior set AFTER scoring (deferred so a
    // tag introduced earlier in the same story cannot pre-warn a later finding
    // of the same story).
    const introduced: string[] = [];
    for (const finding of findings) {
      const tag = qualifyingTag(finding, confirmedOnly);
      if (tag === undefined) continue;
      findingsWithSig += 1;
      if (priorSignatures.has(tag)) preWarnable += 1;
      introduced.push(tag);
    }
    out.push({ findingsWithSig, preWarnable });
    for (const tag of introduced) priorSignatures.add(tag);
  }
  return out;
}

/**
 * FAST per-story hint predictive value. Deterministic; never NaN. See the
 * PredictiveValueReport docs for the recall definition.
 */
export function computePredictiveValue(
  stories: EffStory[],
  opts: PredictiveValueOptions = {},
): PredictiveValueReport {
  const confirmedOnly = opts.confirmedOnly === true;
  const window = Number.isInteger(opts.window) && (opts.window as number) > 0
    ? (opts.window as number)
    : DEFAULT_WINDOW;

  const list = Array.isArray(stories) ? stories : [];
  const per = retrodict(list, confirmedOnly);

  let findingsWithSig = 0;
  let preWarnable = 0;
  for (const s of per) {
    findingsWithSig += s.findingsWithSig;
    preWarnable += s.preWarnable;
  }

  // Windowed trend: bucket the per-story counts into consecutive windows of
  // `window` stories; each window's hit-rate is its preWarnable / findingsWithSig.
  const windows: PredictiveValueWindow[] = [];
  for (let start = 0; start < per.length; start += window) {
    const end = Math.min(start + window, per.length);
    let wFindings = 0;
    let wPre = 0;
    for (let i = start; i < end; i += 1) {
      wFindings += per[i].findingsWithSig;
      wPre += per[i].preWarnable;
    }
    windows.push({ cutoff: end, hitRate: ratio(wPre, wFindings) });
  }

  // Coarse slope from first vs last window hit-rate (0 when <2 windows).
  let slopeSign: '+' | '-' | '0' = '0';
  if (windows.length >= 2) {
    const first = windows[0].hitRate;
    const last = windows[windows.length - 1].hitRate;
    if (last > first) slopeSign = '+';
    else if (last < first) slopeSign = '-';
  }

  return {
    stories: list.length,
    findingsWithSig,
    preWarnable,
    // recall = preWarnable / findingsWithSig (guarded).
    recall: ratio(preWarnable, findingsWithSig),
    windows,
    slopeSign,
  };
}

/**
 * LONG-GAME ON/OFF arm comparison. The per-story outcome is the uncaught
 * recurrence rate = (findings whose signature was already known at that story) /
 * (findings with a signature). Each arm's outcome is the MEAN over its stories.
 * `significant` is a conservative N gate ONLY (no p-value); the note records the
 * insufficient-N reason or that the delta is observational. Deterministic; never NaN.
 */
export function computeArmComparison(
  stories: EffStory[],
  opts: PredictiveValueOptions = {},
): ArmComparison {
  const confirmedOnly = opts.confirmedOnly === true;
  const list = Array.isArray(stories) ? stories : [];
  const per = retrodict(list, confirmedOnly);

  const onRates: number[] = [];
  const offRates: number[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const mode = list[i]?.hintMode;
    if (mode !== 'on' && mode !== 'off') continue; // skip unassigned arms
    const rate = ratio(per[i].preWarnable, per[i].findingsWithSig);
    if (mode === 'on') onRates.push(rate);
    else offRates.push(rate);
  }

  const nOn = onRates.length;
  const nOff = offRates.length;
  const mean = (xs: number[]): number =>
    xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  const outcomeOn = mean(onRates);
  const outcomeOff = mean(offRates);
  const delta = outcomeOff - outcomeOn;

  const enoughN = nOn >= MIN_ARM_N && nOff >= MIN_ARM_N;
  // CONSERVATIVE gate: never claim significance on small N, never compute a
  // p-value. `significant` is true only when both arms meet MIN_ARM_N, and even
  // then the note states the delta is observational, not inferential.
  const significant = enoughN;
  const note = enoughN
    ? `observational delta only (no p-value computed); nOn=${nOn} nOff=${nOff} each >= ${MIN_ARM_N}`
    : `insufficient N (need >= ${MIN_ARM_N} per arm); nOn=${nOn} nOff=${nOff}`;

  return { nOn, nOff, outcomeOn, outcomeOff, delta, significant, note };
}
