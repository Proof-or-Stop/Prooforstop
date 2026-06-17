/**
 * B-000c CHK-002: Experience Layer Phase 1a — finding-signals derivation.
 *
 * Two halves with a strict import boundary:
 *
 *  - `deriveFindingSignals` is PURE: it imports ONLY the leaf
 *    `./experience-layer-types.js` and node builtins (none needed). It accepts a
 *    list of `SignalSourceFinding` projections and a pinned `now` timestamp, and
 *    returns a `FindingSignalsCache`. It NEVER calls `Date.now()`/`new Date()`,
 *    NEVER touches the filesystem, and NEVER produces `NaN` (zero-sample => 0).
 *
 *  - `deriveFindingSignalsFromStore` is the ADAPTER: its ONLY non-sibling
 *    dependency is the read-only store port `./store.js`. It enumerates story ids
 *    and reads findings via `store.readFindings(id)` (NEVER `JSON.parse` of
 *    findings.json), maps them to `SignalSourceFinding`, derives, and persists via
 *    the learning-store. This is the only module in the set allowed to import the
 *    store port; everything else stays import-free (the isolation bar). No module
 *    in the set may import `../` (out of core/) or `../../` anywhere.
 *
 * Scoring (conservative positive-fraction):
 *   positive  = #resolutionType==='fixed' + 0.5 * #resolutionType==='partially_mitigated'
 *   negative  = #dismissReasonType==='false_positive'
 *   signalScore = positive / (positive + negative + 1)   (so single fixed => 0.5)
 *   support     = positive + negative
 * The Phase-1b enum fields are absent on real findings today, so positive/negative
 * stay 0 and signalScore is the conservative 0 — exactly the intended default.
 */

import type {
  FindingSignal,
  FindingSignalCounts,
  FindingSignalsCache,
  SignalSourceFinding,
} from './experience-layer-types.js';

import { StoryStore } from './store.js';

import { writeFindingSignals } from './learning-store.js';

/** Current cache schema version. */
export const FINDING_SIGNALS_SCHEMA_VERSION = 1;

/** Cap on example ids retained per signal (keeps the cache bounded). */
const MAX_EXAMPLES = 5;

export interface DeriveOptions {
  /** Pinned ISO timestamp for `updatedAt` (deterministic; required for hermetic tests). */
  now?: string;
}

/** Internal mutable accumulator before we finalize a `FindingSignal`. */
interface SignalAccumulator {
  localSignature: string;
  category: string;
  signatureTag?: string;
  fileKinds: Set<string>;
  counts: FindingSignalCounts;
  positive: number;
  negative: number;
  lastSeen?: string;
  exampleStoryIds: Set<string>;
  exampleFindingIds: Set<string>;
}

function emptyCounts(): FindingSignalCounts {
  return {
    resolved: 0,
    dismissed: 0,
    falsePositive: 0,
    acceptedRisk: 0,
    unclear: 0,
    partiallyMitigated: 0,
  };
}

/**
 * Derive a coarse file-kind bucket from the first file path: prefer the
 * extension (without the dot); fall back to the first path segment (directory);
 * else `'unknown'`. Tolerates missing/empty `files`.
 */
function deriveFileKind(files: string[] | undefined): string {
  if (!Array.isArray(files) || files.length === 0) return 'unknown';
  const first = typeof files[0] === 'string' ? files[0].trim() : '';
  if (!first) return 'unknown';
  const normalized = first.replace(/\\/g, '/');
  const base = normalized.split('/').pop() ?? normalized;
  const dotIdx = base.lastIndexOf('.');
  if (dotIdx > 0 && dotIdx < base.length - 1) {
    return base.slice(dotIdx + 1).toLowerCase();
  }
  // No usable extension: fall back to the leading directory segment.
  const seg = normalized.split('/').filter(Boolean)[0];
  return seg ? seg.toLowerCase() : 'unknown';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * PURE derivation. Aggregates findings by
 * `localSignature = ${category}|${signatureTag ?? ''}|${fileKind}|${lifecyclePhase ?? 'review'}`.
 * Tolerant of missing fields; never throws on malformed entries; never NaN.
 */
export function deriveFindingSignals(
  findings: SignalSourceFinding[],
  opts: DeriveOptions = {},
): FindingSignalsCache {
  const updatedAt = opts.now ?? '1970-01-01T00:00:00.000Z';
  const acc = new Map<string, SignalAccumulator>();

  const list = Array.isArray(findings) ? findings : [];
  for (const finding of list) {
    if (!finding || typeof finding !== 'object') continue;

    const category = isNonEmptyString(finding.category) ? finding.category : 'unknown';
    const signatureTag = isNonEmptyString(finding.signatureTag) ? finding.signatureTag : undefined;
    const fileKind = deriveFileKind(finding.files);
    const lifecyclePhase = isNonEmptyString(finding.lifecyclePhase) ? finding.lifecyclePhase : 'review';
    const localSignature = `${category}|${signatureTag ?? ''}|${fileKind}|${lifecyclePhase}`;

    let entry = acc.get(localSignature);
    if (!entry) {
      entry = {
        localSignature,
        category,
        signatureTag,
        fileKinds: new Set<string>(),
        counts: emptyCounts(),
        positive: 0,
        negative: 0,
        lastSeen: undefined,
        exampleStoryIds: new Set<string>(),
        exampleFindingIds: new Set<string>(),
      };
      acc.set(localSignature, entry);
    }

    entry.fileKinds.add(fileKind);

    // Status buckets (always available on real findings).
    const status = isNonEmptyString(finding.status) ? finding.status : undefined;
    if (status === 'resolved') entry.counts.resolved += 1;
    else if (status === 'dismissed') entry.counts.dismissed += 1;

    // Outcome enums (Phase 1b forward-compat; absent on real findings today).
    const resolutionType = isNonEmptyString(finding.resolutionType) ? finding.resolutionType : undefined;
    const dismissReasonType = isNonEmptyString(finding.dismissReasonType) ? finding.dismissReasonType : undefined;

    if (resolutionType === 'fixed') {
      entry.positive += 1;
    } else if (resolutionType === 'partially_mitigated') {
      entry.positive += 0.5;
      entry.counts.partiallyMitigated += 1;
    }

    if (dismissReasonType === 'false_positive') {
      entry.negative += 1;
      entry.counts.falsePositive += 1;
    } else if (dismissReasonType === 'accepted_risk') {
      entry.counts.acceptedRisk += 1;
    } else if (dismissReasonType === 'unclear') {
      entry.counts.unclear += 1;
    }
    // out_of_scope / duplicate / already_covered / superseded => ignored (no
    // bucket of their own here, and no positive/negative contribution).

    // lastSeen: max createdAt seen for this signature.
    if (isNonEmptyString(finding.createdAt)) {
      if (!entry.lastSeen || finding.createdAt > entry.lastSeen) entry.lastSeen = finding.createdAt;
    }

    if (isNonEmptyString(finding.storyId) && entry.exampleStoryIds.size < MAX_EXAMPLES) {
      entry.exampleStoryIds.add(finding.storyId);
    }
    if (isNonEmptyString(finding.id) && entry.exampleFindingIds.size < MAX_EXAMPLES) {
      entry.exampleFindingIds.add(finding.id);
    }
  }

  const signals: FindingSignal[] = [...acc.values()]
    .map((entry) => {
      const denom = entry.positive + entry.negative + 1; // always >= 1 => never NaN/div0
      const signalScore = entry.positive / denom;
      const signal: FindingSignal = {
        localSignature: entry.localSignature,
        category: entry.category,
        fileKinds: [...entry.fileKinds].sort(),
        counts: entry.counts,
        signalScore,
        support: entry.positive + entry.negative,
        exampleStoryIds: [...entry.exampleStoryIds].sort(),
        exampleFindingIds: [...entry.exampleFindingIds].sort(),
      };
      if (entry.signatureTag !== undefined) signal.signatureTag = entry.signatureTag;
      if (entry.lastSeen !== undefined) signal.lastSeen = entry.lastSeen;
      return signal;
    })
    .sort((a, b) => (a.localSignature < b.localSignature ? -1 : a.localSignature > b.localSignature ? 1 : 0));

  return {
    schemaVersion: FINDING_SIGNALS_SCHEMA_VERSION,
    updatedAt,
    signals,
  };
}

/** Project a store `Finding` (plus the storyId) onto the derivation input shape. */
function toSourceFinding(storyId: string, finding: unknown): SignalSourceFinding {
  const f = (finding ?? {}) as Record<string, unknown>;
  const src: SignalSourceFinding = { storyId };
  if (typeof f.id === 'string') src.id = f.id;
  if (typeof f.category === 'string') src.category = f.category;
  if (typeof f.status === 'string') src.status = f.status;
  if (Array.isArray(f.files)) src.files = f.files.filter((x): x is string => typeof x === 'string');
  if (typeof f.signatureTag === 'string') src.signatureTag = f.signatureTag;
  if (typeof f.resolutionType === 'string') src.resolutionType = f.resolutionType;
  if (typeof f.dismissReasonType === 'string') src.dismissReasonType = f.dismissReasonType;
  if (typeof f.lifecyclePhase === 'string') src.lifecyclePhase = f.lifecyclePhase;
  if (typeof f.createdAt === 'string') src.createdAt = f.createdAt;
  return src;
}

export interface DeriveFromStoreOptions extends DeriveOptions {
  /** Restrict derivation to these story ids; default = all ids the store enumerates. */
  storyIds?: string[];
  /**
   * Where to persist the cache (`.lattice/learning/` under this root). When
   * omitted the cache is derived but NOT written.
   */
  projectRoot?: string;
}

/**
 * ADAPTER: derive finding-signals by reading findings THROUGH the store port
 * (`store.readFindings`), never by parsing findings.json directly. Persists the
 * cache via the learning-store when `projectRoot` is provided.
 */
export function deriveFindingSignalsFromStore(
  store: StoryStore,
  opts: DeriveFromStoreOptions = {},
): FindingSignalsCache {
  const ids = opts.storyIds ?? store.listStoryIds();
  const sources: SignalSourceFinding[] = [];
  for (const id of ids) {
    const data = store.readFindings(id); // PORT read — never JSON.parse(findings.json)
    const findings = Array.isArray(data?.findings) ? data.findings : [];
    for (const finding of findings) sources.push(toSourceFinding(id, finding));
  }

  const cache = deriveFindingSignals(sources, { now: opts.now });

  if (typeof opts.projectRoot === 'string') {
    writeFindingSignals(opts.projectRoot, cache);
  }
  return cache;
}
