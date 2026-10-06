/**
 * Detection A/B variant switches (EXPERIMENTAL, A/B measurement only).
 *
 * Every switch defaults OFF: with no key in proof-or-stop.config.json the
 * resolved value is the production value and no code path changes. A switch
 * that changes what a gate accepts must (a) be honoured only while the switch
 * is set in the config the gate reads, and (b) record `abVariantEvidence()` in
 * the evidence it writes, so a run's arm is auditable after the fact.
 *
 *   review.criticOnCleanRound  'run' (default) | 'skip'
 *   review.round2Scope         'full' (default) | 'repaired-files'
 *   review.round2Lanes         'resume' (default) | 'fresh'
 *   remediation.grouping       'per-finding' (default) | 'single'
 *   implementation.grouping    'per-item' (default) | 'files'
 *
 * A malformed value fails closed where it is consumed (never silently treated
 * as either arm). See docs/CLI.md "Experimental A/B variant switches".
 */

export const AB_VARIANT_EVIDENCE_SCHEMA = 'proof-or-stop.ab-variants.v1' as const;

export const AB_VARIANT_FLAGS = {
  'review.criticOnCleanRound': ['run', 'skip'],
  'review.round2Scope': ['full', 'repaired-files'],
  'review.round2Lanes': ['resume', 'fresh'],
  'remediation.grouping': ['per-finding', 'single'],
  'implementation.grouping': ['per-item', 'files'],
} as const;

export type AbVariantFlag = keyof typeof AB_VARIANT_FLAGS;
export type AbVariantValue<F extends AbVariantFlag> = (typeof AB_VARIANT_FLAGS)[F][number];

export interface AbVariantConfigSlice {
  review?: { criticOnCleanRound?: string; round2Scope?: string; round2Lanes?: string };
  remediation?: { grouping?: string };
  implementation?: { grouping?: string };
}

export interface AbVariants {
  criticOnCleanRound: AbVariantValue<'review.criticOnCleanRound'>;
  round2Scope: AbVariantValue<'review.round2Scope'>;
  round2Lanes: AbVariantValue<'review.round2Lanes'>;
  remediationGrouping: AbVariantValue<'remediation.grouping'>;
  implementationGrouping: AbVariantValue<'implementation.grouping'>;
}

export interface AbVariantEvidence {
  schema: typeof AB_VARIANT_EVIDENCE_SCHEMA;
  /** Only the switches that are ON (non-default), dotted name -> value. */
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
  };
}

/** Evidence record of the ON switches, or undefined when every switch is off. */
export function abVariantEvidence(variants: AbVariants): AbVariantEvidence | undefined {
  const flags: Partial<Record<AbVariantFlag, string>> = {};
  if (variants.criticOnCleanRound !== 'run') flags['review.criticOnCleanRound'] = variants.criticOnCleanRound;
  if (variants.round2Scope !== 'full') flags['review.round2Scope'] = variants.round2Scope;
  if (variants.round2Lanes !== 'resume') flags['review.round2Lanes'] = variants.round2Lanes;
  if (variants.remediationGrouping !== 'per-finding') flags['remediation.grouping'] = variants.remediationGrouping;
  if (variants.implementationGrouping !== 'per-item') flags['implementation.grouping'] = variants.implementationGrouping;
  return Object.keys(flags).length ? { schema: AB_VARIANT_EVIDENCE_SCHEMA, flags } : undefined;
}
