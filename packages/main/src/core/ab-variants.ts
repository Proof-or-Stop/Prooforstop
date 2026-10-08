/**
 * Detection A/B variant switches.
 *
 * With no key in proof-or-stop.config.json every switch resolves to the
 * production value (the first value listed in AB_VARIANT_FLAGS). Experimental
 * switches default OFF, so no code path changes. Two switches were adopted:
 * review.round2Lanes defaults to 'fresh' since the detection A/B V3 arm
 * (bench-staging/oldpos/ab/results-r2.md: post-repair seeds 4/4 vs 3/4 for
 * resumed lanes, R2 lane input tokens -56%); remediation.grouping defaults to
 * 'single' since the V4 arm (same file: remediation wall -48%, tokens -70%,
 * every finding fixed on the final tree with its own commit and resolve,
 * round-2 detection 3/4 vs 3/4). 'resume' / 'per-finding' are kept as the
 * rollbacks to the earlier behavior and are recorded as non-default switches. A switch
 * that changes what a gate accepts must (a) be honoured only while the switch
 * is set in the config the gate reads, and (b) record `abVariantEvidence()` in
 * the evidence it writes, so a run's arm is auditable after the fact.
 *
 *   review.criticOnCleanRound  'run' (default) | 'skip'
 *   review.round2Scope         'full' (default) | 'repaired-files'
 *   review.round2Lanes         'fresh' (default, adopted) | 'resume' (rollback)
 *   remediation.grouping       'single' (default, adopted) | 'per-finding' (rollback)
 *   implementation.grouping    'per-item' (default) | 'files'
 *   implementation.thread      'resume' (default) | 'fresh'  (core/implementer-item-pack.ts)
 *
 * A malformed value fails closed where it is consumed (never silently treated
 * as either arm). See docs/CLI.md "Detection A/B variant switches".
 */

export const AB_VARIANT_EVIDENCE_SCHEMA = 'proof-or-stop.ab-variants.v1' as const;

export const AB_VARIANT_FLAGS = {
  'review.criticOnCleanRound': ['run', 'skip'],
  'review.round2Scope': ['full', 'repaired-files'],
  'review.round2Lanes': ['fresh', 'resume'],
  'remediation.grouping': ['single', 'per-finding'],
  'implementation.grouping': ['per-item', 'files'],
  'implementation.thread': ['resume', 'fresh'],
} as const;

export type AbVariantFlag = keyof typeof AB_VARIANT_FLAGS;
export type AbVariantValue<F extends AbVariantFlag> = (typeof AB_VARIANT_FLAGS)[F][number];

export interface AbVariantConfigSlice {
  review?: { criticOnCleanRound?: string; round2Scope?: string; round2Lanes?: string };
  remediation?: { grouping?: string };
  implementation?: { grouping?: string; thread?: string };
}

export interface AbVariants {
  criticOnCleanRound: AbVariantValue<'review.criticOnCleanRound'>;
  round2Scope: AbVariantValue<'review.round2Scope'>;
  round2Lanes: AbVariantValue<'review.round2Lanes'>;
  remediationGrouping: AbVariantValue<'remediation.grouping'>;
  implementationGrouping: AbVariantValue<'implementation.grouping'>;
  implementationThread: AbVariantValue<'implementation.thread'>;
}

export interface AbVariantEvidence {
  schema: typeof AB_VARIANT_EVIDENCE_SCHEMA;
  /** Only the switches that are not at their production value, dotted name -> value. */
  flags: Partial<Record<AbVariantFlag, string>>;
}

function pick<F extends AbVariantFlag>(flag: F, raw: unknown): AbVariantValue<F> {
  const allowed = AB_VARIANT_FLAGS[flag] as readonly string[];
  if (raw === undefined || raw === null) return allowed[0] as AbVariantValue<F>;
  if (typeof raw !== 'string' || !allowed.includes(raw)) {
    throw new Error(`invalid_ab_variant_config: ${flag} must be one of ${allowed.join('|')} (got ${JSON.stringify(raw)}); remove the key for production behavior`);
  }
  return raw as AbVariantValue<F>;
}

function section(config: unknown, key: string): Record<string, unknown> {
  const value = config && typeof config === 'object' ? (config as Record<string, unknown>)[key] : undefined;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Resolve all switches; throws `invalid_ab_variant_config` on a malformed value. */
export function resolveAbVariants(config: unknown): AbVariants {
  const review = section(config, 'review');
  return {
    criticOnCleanRound: pick('review.criticOnCleanRound', review.criticOnCleanRound),
    round2Scope: pick('review.round2Scope', review.round2Scope),
    round2Lanes: pick('review.round2Lanes', review.round2Lanes),
    remediationGrouping: pick('remediation.grouping', section(config, 'remediation').grouping),
    implementationGrouping: pick('implementation.grouping', section(config, 'implementation').grouping),
    implementationThread: pick('implementation.thread', section(config, 'implementation').thread),
  };
}

/** Evidence record of the non-default switches, or undefined when every switch has its production value. */
export function abVariantEvidence(variants: AbVariants): AbVariantEvidence | undefined {
  const flags: Partial<Record<AbVariantFlag, string>> = {};
  if (variants.criticOnCleanRound !== 'run') flags['review.criticOnCleanRound'] = variants.criticOnCleanRound;
  if (variants.round2Scope !== 'full') flags['review.round2Scope'] = variants.round2Scope;
  if (variants.round2Lanes !== 'fresh') flags['review.round2Lanes'] = variants.round2Lanes;
  if (variants.remediationGrouping !== 'single') flags['remediation.grouping'] = variants.remediationGrouping;
  if (variants.implementationGrouping !== 'per-item') flags['implementation.grouping'] = variants.implementationGrouping;
  if (variants.implementationThread !== 'resume') flags['implementation.thread'] = variants.implementationThread;
  return Object.keys(flags).length ? { schema: AB_VARIANT_EVIDENCE_SCHEMA, flags } : undefined;
}

/**
 * Sealed arm of a managed code-writer run (EXPERIMENTAL implementation.thread):
 * the A/B evidence on its managed dispatch target records `fresh`, so the
 * worker starts a new Codex thread (core/implementer-item-pack.ts).
 */
export function dispatchTargetThreadFresh(target: { abVariant?: AbVariantEvidence } | null | undefined): boolean {
  return target?.abVariant?.flags?.['implementation.thread'] === 'fresh';
}
