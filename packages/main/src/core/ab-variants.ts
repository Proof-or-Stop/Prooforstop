/**
 * Detection A/B variant switches.
 *
 * With no key in proof-or-stop.config.json every switch resolves to the
 * production value (the first value listed in AB_VARIANT_FLAGS). Experimental
 * switches default OFF, so no code path changes. Three switches were adopted
 * (remediation.thread since old-PoS run 25, see below); the first two:
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
 *   remediation.thread         'fresh' (default, adopted) | 'resume' (rollback)  finding-repair runs start a new Codex
 *                              thread with the framework repair pack (old-PoS run 25: fresh repair 0.86M input vs
 *                              resumed 2.8-3.9M); `resume` restores the resumed Story code-writer thread for repairs
 *   implementation.grouping    'per-item' (default) | 'files'
 *   implementation.thread      'resume' (default) | 'fresh'  (core/implementer-item-pack.ts)
 *   review.lanePack            'off' (default) | 'shared'  one framework-built lane pack per review round in every
 *                              code-review lane and inventory critic prompt (core/review-lane-pack.ts; v41 plan A3)
 *   review.roundDelta          'off' (default) | 'pack'    from round 2 on the pack also carries the delta since the
 *                              previous round's candidate; lanes start there but review the whole Story (v41 plan A4)
 *
 * Old-PoS run 33 (bench-staging/oldpos/run33-analysis.md §4): the "catch defects
 * earlier" line (runs 30-33) cost about 38 min / 31M tokens per run with no
 * demonstrated detection benefit, so its mechanisms are switched OFF by default
 * and kept reachable for the A/B (arms A2-A4 of the analysis):
 *   plan.coverageMatrix        'off' (default) | 'on'       PLAN coverage-matrix rows (core/plan-coverage-matrix.ts):
 *                              off keeps only the exact-text rows (request-quoted strings that must match
 *                              exactly) and the story_create request-literal pre-check; on = every rule
 *                              (missing_coverage_row blockers, plan_authoring placeholders, scope-plan rule)
 *   plan.scopeDeferral         'off' (default) | 'on'       N8 (core/scope-plan-deferral.ts): off = PLAN→DEV waits
 *                              for the scope-plan verdict; on = DEV starts beside the live reviewer run
 *   plan.pinAuditEnforcement   'off' (default) | 'on'       on = a saved scope-plan verdict's open gaps block DEV
 *                              entry and REVIEW entry whenever the verdict was saved (analysis §3.4, arm A1)
 *   dev.probeEnforcement       'advisory' (default) | 'enforce'  framework probes (core/request-probes.ts, project
 *                              probeRunner): advisory = run at done, table shown to the implementer and to the
 *                              REVIEW lanes as evidence, never refuse / reopen / escalate; enforce = run 31-33 gate
 *   implementation.probeMatrix 'off' (default) | 'on'       implementer probe-matrix prompt block, `[probes]` /
 *                              `[probe-row]` report contract and its reopen (probe_tests_missing); off keeps one
 *                              generic line (no crash on any valid input form; an explicit null operand is not an omitted one)
 *
 * A malformed value fails closed where it is consumed (never silently treated
 * as an experimental arm; review.lanePack / review.roundDelta then keep production: no pack). See docs/CLI.md "Detection A/B variant switches".
 */

export const AB_VARIANT_EVIDENCE_SCHEMA = 'proof-or-stop.ab-variants.v1' as const;

export const AB_VARIANT_FLAGS = {
  'review.criticOnCleanRound': ['run', 'skip'],
  'review.round2Scope': ['full', 'repaired-files'],
  'review.round2Lanes': ['fresh', 'resume'],
  'remediation.grouping': ['single', 'per-finding'],
  'remediation.thread': ['fresh', 'resume'],
  'implementation.grouping': ['per-item', 'files'],
  'implementation.thread': ['resume', 'fresh'],
  'review.lanePack': ['off', 'shared'],
  'review.roundDelta': ['off', 'pack'],
  'plan.coverageMatrix': ['off', 'on'],
  'plan.scopeDeferral': ['off', 'on'],
  'plan.pinAuditEnforcement': ['off', 'on'],
  'dev.probeEnforcement': ['advisory', 'enforce'],
  'implementation.probeMatrix': ['off', 'on'],
} as const;

export type AbVariantFlag = keyof typeof AB_VARIANT_FLAGS;
export type AbVariantValue<F extends AbVariantFlag> = (typeof AB_VARIANT_FLAGS)[F][number];

export interface AbVariantConfigSlice {
  review?: { criticOnCleanRound?: string; round2Scope?: string; round2Lanes?: string; lanePack?: string; roundDelta?: string };
  remediation?: { grouping?: string; thread?: string };
  implementation?: { grouping?: string; thread?: string; probeMatrix?: string };
  plan?: { coverageMatrix?: string; scopeDeferral?: string; pinAuditEnforcement?: string };
  dev?: { probeEnforcement?: string };
}

export interface AbVariants {
  criticOnCleanRound: AbVariantValue<'review.criticOnCleanRound'>;
  round2Scope: AbVariantValue<'review.round2Scope'>;
  round2Lanes: AbVariantValue<'review.round2Lanes'>;
  remediationGrouping: AbVariantValue<'remediation.grouping'>;
  remediationThread: AbVariantValue<'remediation.thread'>;
  implementationGrouping: AbVariantValue<'implementation.grouping'>;
  implementationThread: AbVariantValue<'implementation.thread'>;
  lanePack: AbVariantValue<'review.lanePack'>;
  roundDelta: AbVariantValue<'review.roundDelta'>;
  coverageMatrix: AbVariantValue<'plan.coverageMatrix'>;
  scopeDeferral: AbVariantValue<'plan.scopeDeferral'>;
  pinAuditEnforcement: AbVariantValue<'plan.pinAuditEnforcement'>;
  probeEnforcement: AbVariantValue<'dev.probeEnforcement'>;
  probeMatrix: AbVariantValue<'implementation.probeMatrix'>;
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
    remediationThread: pick('remediation.thread', section(config, 'remediation').thread),
    implementationGrouping: pick('implementation.grouping', section(config, 'implementation').grouping),
    implementationThread: pick('implementation.thread', section(config, 'implementation').thread),
    lanePack: pick('review.lanePack', review.lanePack),
    roundDelta: pick('review.roundDelta', review.roundDelta),
    coverageMatrix: pick('plan.coverageMatrix', section(config, 'plan').coverageMatrix),
    scopeDeferral: pick('plan.scopeDeferral', section(config, 'plan').scopeDeferral),
    pinAuditEnforcement: pick('plan.pinAuditEnforcement', section(config, 'plan').pinAuditEnforcement),
    probeEnforcement: pick('dev.probeEnforcement', section(config, 'dev').probeEnforcement),
    probeMatrix: pick('implementation.probeMatrix', section(config, 'implementation').probeMatrix),
  };
}

/** Evidence record of the non-default switches, or undefined when every switch has its production value. */
export function abVariantEvidence(variants: AbVariants): AbVariantEvidence | undefined {
  const flags: Partial<Record<AbVariantFlag, string>> = {};
  if (variants.criticOnCleanRound !== 'run') flags['review.criticOnCleanRound'] = variants.criticOnCleanRound;
  if (variants.round2Scope !== 'full') flags['review.round2Scope'] = variants.round2Scope;
  if (variants.round2Lanes !== 'fresh') flags['review.round2Lanes'] = variants.round2Lanes;
  if (variants.remediationGrouping !== 'single') flags['remediation.grouping'] = variants.remediationGrouping;
  if (variants.remediationThread !== 'fresh') flags['remediation.thread'] = variants.remediationThread;
  if (variants.implementationGrouping !== 'per-item') flags['implementation.grouping'] = variants.implementationGrouping;
  if (variants.implementationThread !== 'resume') flags['implementation.thread'] = variants.implementationThread;
  if (variants.lanePack !== 'off') flags['review.lanePack'] = variants.lanePack;
  if (variants.roundDelta !== 'off') flags['review.roundDelta'] = variants.roundDelta;
  if (variants.coverageMatrix !== 'off') flags['plan.coverageMatrix'] = variants.coverageMatrix;
  if (variants.scopeDeferral !== 'off') flags['plan.scopeDeferral'] = variants.scopeDeferral;
  if (variants.pinAuditEnforcement !== 'off') flags['plan.pinAuditEnforcement'] = variants.pinAuditEnforcement;
  if (variants.probeEnforcement !== 'advisory') flags['dev.probeEnforcement'] = variants.probeEnforcement;
  if (variants.probeMatrix !== 'off') flags['implementation.probeMatrix'] = variants.probeMatrix;
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

/** The single-switch reader of one catch-earlier switch: a malformed value (or an unreadable config) keeps production. */
function catchEarlierPick<F extends 'plan.coverageMatrix' | 'plan.scopeDeferral' | 'plan.pinAuditEnforcement' | 'dev.probeEnforcement' | 'implementation.probeMatrix'>(config: unknown, flag: F): AbVariantValue<F> {
  const [group, key] = flag.split('.') as [string, string];
  try { return pick(flag, section(config, group)[key]); } catch { return AB_VARIANT_FLAGS[flag][0] as AbVariantValue<F>; }
}

/** Old-PoS run 33: plan.coverageMatrix=on restores every PLAN coverage-matrix rule (default off: exact-text rows only). */
export const coverageMatrixOn = (config: unknown): boolean => catchEarlierPick(config, 'plan.coverageMatrix') === 'on';
/** Old-PoS run 33: plan.scopeDeferral=on restores N8 (default off: PLAN→DEV waits for the scope-plan verdict). */
export const scopeDeferralOn = (config: unknown): boolean => catchEarlierPick(config, 'plan.scopeDeferral') === 'on';
/** Old-PoS run 33 arm A1: plan.pinAuditEnforcement=on makes a saved verdict's open gaps block DEV and REVIEW entry. */
export const pinAuditEnforcementOn = (config: unknown): boolean => catchEarlierPick(config, 'plan.pinAuditEnforcement') === 'on';
/** Old-PoS run 33: dev.probeEnforcement=enforce restores the probe gate (default advisory: tables only). */
export const probeEnforcementOn = (config: unknown): boolean => catchEarlierPick(config, 'dev.probeEnforcement') === 'enforce';
/** Old-PoS run 33: implementation.probeMatrix=on restores the implementer probe-matrix block and its report contract. */
export const probeMatrixOn = (config: unknown): boolean => catchEarlierPick(config, 'implementation.probeMatrix') === 'on';
