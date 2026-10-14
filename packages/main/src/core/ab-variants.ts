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
 *   review.deltaRounds         'off' (default) | 'on'      a REVIEW round N>=2 after a remediation re-reviews only the
 *                              repair: the lanes that raised findings re-review in full, every other lane is replaced
 *                              by ONE confirmation lane over the repair scope, resolved findings are re-run, the critic
 *                              runs only when the round reports a finding, a large repair falls back to a full round
 *                              (core/review-delta-round.ts; structural-cost-analysis.md §7 item 2)
 *   review.laneMerge           'off' (default) | 'on' | 'split'  'on': every REVIEW round runs ONE managed review session
 *                              for the dimensions of every active lane (the first dimension's lane carries it; one explicit
 *                              section, checkpoints and role prompt per dimension; per-checkpoint coverage lines with
 *                              specific evidence and a per-dimension list of fully read files, an uncovered dimension is
 *                              relaunched as its own lane, never passed; findings keep a `[dimension:<name>]` tag).
 *                              'split' (lab lane-split, old-PoS run 64): TWO such sessions per round, launched in
 *                              parallel like lanes: concept + quality and test-coverage + docs (+ behavior), same
 *                              contract per session. review.deltaRounds is not applied while either is set
 *                              (core/review-lane-merge.ts; new PoS ADR-064; structural-cost-analysis.md §7 item 3)
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
 * Old-PoS run 43 (bench-staging/oldpos/run43-analysis.md §5.2 fixes 1-2): two
 * detection switches that default ON (the first value is production); `off`
 * is the rollback and is recorded like every other non-default value:
 *   review.siblingParity       'off' (default since old-PoS run 58) | 'on'  the test-coverage and quality lane
 *                              dispatch prompts carry the sibling-parity check (core/sibling-parity.ts): every new or
 *                              changed entry point is compared with its sibling paths on the operand cases the sibling
 *                              special-cases. Run 58 (run58-analysis.md §7): with it on, runs 46/47/58 took 131 min /
 *                              timeout / timeout; plan.baseDisagreement alone closed the single-index miss it was
 *                              added for, so the default is off and `on` is the recorded A/B arm
 *   plan.exclusionRationaleCheck 'on' (default) | 'off'  an excludes entry may not close a scope-plan row whose named
 *                              behaviour another checklist item adds or changes (core/scope-exclusion-rationale.ts):
 *                              scope_check_save refuses such an `excluded` row, story_review rejects it in an
 *                              older verdict, and the gap remedy names the covering item instead of an excludes entry
 *
 * Old-PoS run 46 (bench-staging/oldpos/run46-analysis.md §2.3 item 1): one more
 * default-ON detection switch (`off` = rollback, recorded):
 *   plan.baseDisagreement      'on' (default) | 'off'  the scope-plan reviewer dispatch carries the base-disagreement
 *                              check (core/base-disagreement.ts): for each new operation an item adds, the base's own
 *                              precedents (the same receiver's counterpart, the same operation on other receivers)
 *                              are probed per operand case; a disagreement the request and checklist leave open is a
 *                              gap whose remedy is a covering row pinning which precedent applies
 *
 * Lab plan-light (structural-cost-analysis.md §7 item 4; new PoS ADR-105 / ADR-081 / ADR-043 / ADR-040):
 * three EXPERIMENTAL switches that make INIT+PLAN lighter, default OFF:
 *   plan.pinProbe              'off' (default) | 'on'  before PLAN→DEV the framework runs every extractable example
 *                              row on the Story BASE with the project's declared evaluator (probeRunner, else pinOracle)
 *                              and checks pins against request-literal examples; a pin the base (unchanged behaviour,
 *                              no `baseValue`) or the request contradicts refuses DEV entry with ONE Next naming the
 *                              row and the observed value (core/plan-pin-probe.ts)
 *   plan.reviewMerge           'off' (default) | 'on'  the two INIT reviewers are not launched; INIT_CHECK admits the Story
 *                              when the PLAN scope-plan verdict is required, and that ONE session also answers the INIT
 *                              questions; a rerun is a confirmation re-review of the changed rows (core/plan-review-merge.ts)
 *   plan.rowBudget             'off' (default) | 'on'  authoring guidance + a soft (never blocking) check: one intent row
 *                              per distinct behaviour (operand class), not many literal examples of one class; request
 *                              literals and exact-text rows are never counted as extra (core/plan-row-budget.ts)
 *
 * Lab sibling-gate (old-PoS runs 43/46/55/57/71, bench-staging/oldpos/run69-72-analysis.md §1): one EXPERIMENTAL
 * detection switch, default OFF:
 *   plan.counterpartCoverage   'off' (default) | 'on'  before PLAN→DEV the framework finds, for each operation an item
 *                              ADDS on a receiver type, the same receiver's counterpart in the Story base (its read for a
 *                              new write, its write for a new read) and the operand classes it special-cases (negative,
 *                              out of range, empty, null / omitted, type); a class with clear evidence and no row on the
 *                              new operation refuses DEV entry with ONE Next, weak evidence is an advisory note; the
 *                              implementer prompt asks for `[counterpart]` base probes (core/counterpart-coverage.ts)
 *
 * Lab round-cut (old-PoS runs 65/71/73/74/75, bench-staging/oldpos/run74-75-analysis.md §7 N1): one detection switch
 * whose production value is the middle arm:
 *   dev.removedGuardScan       'advisory' (default) | 'off' | 'on'  at DEV exit the framework diffs the Story base against
 *                              HEAD for operand guards (null / omitted, negative, out of range, empty) a changed function
 *                              lost, unjustified by a checklist row or the request (core/removed-guard-scan.ts).
 *                              advisory: every review lane prompt names them; on: a clear one reopens the item that
 *                              declares the file before REVIEW (the implementer relaunch carries it, once per guard set),
 *                              a weak one stays advisory; off: no scan
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
  'review.deltaRounds': ['off', 'on'],
  'review.laneMerge': ['off', 'on', 'split'],
  'plan.coverageMatrix': ['off', 'on'],
  'plan.scopeDeferral': ['off', 'on'],
  'plan.pinAuditEnforcement': ['off', 'on'],
  'dev.probeEnforcement': ['advisory', 'enforce'],
  'implementation.probeMatrix': ['off', 'on'],
  'review.siblingParity': ['off', 'on'],
  'plan.exclusionRationaleCheck': ['on', 'off'],
  'plan.baseDisagreement': ['on', 'off'],
  'plan.pinProbe': ['off', 'on'],
  'plan.reviewMerge': ['off', 'on'],
  'plan.rowBudget': ['off', 'on'],
  'plan.counterpartCoverage': ['off', 'on'],
  'dev.removedGuardScan': ['advisory', 'off', 'on'],
} as const;

export type AbVariantFlag = keyof typeof AB_VARIANT_FLAGS;
export type AbVariantValue<F extends AbVariantFlag> = (typeof AB_VARIANT_FLAGS)[F][number];

export interface AbVariantConfigSlice {
  review?: { criticOnCleanRound?: string; round2Scope?: string; round2Lanes?: string; lanePack?: string; roundDelta?: string; siblingParity?: string; deltaRounds?: string; laneMerge?: string };
  remediation?: { grouping?: string; thread?: string };
  implementation?: { grouping?: string; thread?: string; probeMatrix?: string };
  plan?: { coverageMatrix?: string; scopeDeferral?: string; pinAuditEnforcement?: string; exclusionRationaleCheck?: string; baseDisagreement?: string; pinProbe?: string; reviewMerge?: string; rowBudget?: string; counterpartCoverage?: string };
  dev?: { probeEnforcement?: string; removedGuardScan?: string };
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
  siblingParity: AbVariantValue<'review.siblingParity'>;
  exclusionRationaleCheck: AbVariantValue<'plan.exclusionRationaleCheck'>;
  baseDisagreement: AbVariantValue<'plan.baseDisagreement'>;
  deltaRounds: AbVariantValue<'review.deltaRounds'>;
  laneMerge: AbVariantValue<'review.laneMerge'>;
  pinProbe: AbVariantValue<'plan.pinProbe'>;
  reviewMerge: AbVariantValue<'plan.reviewMerge'>;
  rowBudget: AbVariantValue<'plan.rowBudget'>;
  counterpartCoverage: AbVariantValue<'plan.counterpartCoverage'>;
  removedGuardScan: AbVariantValue<'dev.removedGuardScan'>;
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
    siblingParity: pick('review.siblingParity', review.siblingParity),
    exclusionRationaleCheck: pick('plan.exclusionRationaleCheck', section(config, 'plan').exclusionRationaleCheck),
    baseDisagreement: pick('plan.baseDisagreement', section(config, 'plan').baseDisagreement),
    deltaRounds: pick('review.deltaRounds', review.deltaRounds),
    laneMerge: pick('review.laneMerge', review.laneMerge),
    pinProbe: pick('plan.pinProbe', section(config, 'plan').pinProbe),
    reviewMerge: pick('plan.reviewMerge', section(config, 'plan').reviewMerge),
    rowBudget: pick('plan.rowBudget', section(config, 'plan').rowBudget),
    counterpartCoverage: pick('plan.counterpartCoverage', section(config, 'plan').counterpartCoverage),
    removedGuardScan: pick('dev.removedGuardScan', section(config, 'dev').removedGuardScan),
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
  if (variants.siblingParity !== 'off') flags['review.siblingParity'] = variants.siblingParity;
  if (variants.exclusionRationaleCheck !== 'on') flags['plan.exclusionRationaleCheck'] = variants.exclusionRationaleCheck;
  if (variants.baseDisagreement !== 'on') flags['plan.baseDisagreement'] = variants.baseDisagreement;
  if (variants.deltaRounds !== 'off') flags['review.deltaRounds'] = variants.deltaRounds;
  if (variants.laneMerge !== 'off') flags['review.laneMerge'] = variants.laneMerge;
  if (variants.pinProbe !== 'off') flags['plan.pinProbe'] = variants.pinProbe;
  if (variants.reviewMerge !== 'off') flags['plan.reviewMerge'] = variants.reviewMerge;
  if (variants.rowBudget !== 'off') flags['plan.rowBudget'] = variants.rowBudget;
  if (variants.counterpartCoverage !== 'off') flags['plan.counterpartCoverage'] = variants.counterpartCoverage;
  if (variants.removedGuardScan !== 'advisory') flags['dev.removedGuardScan'] = variants.removedGuardScan;
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
function catchEarlierPick<F extends 'plan.coverageMatrix' | 'plan.scopeDeferral' | 'plan.pinAuditEnforcement' | 'dev.probeEnforcement' | 'implementation.probeMatrix' | 'review.siblingParity' | 'plan.exclusionRationaleCheck' | 'plan.baseDisagreement' | 'review.deltaRounds' | 'review.laneMerge' | 'plan.pinProbe' | 'plan.reviewMerge' | 'plan.rowBudget' | 'plan.counterpartCoverage' | 'dev.removedGuardScan'>(config: unknown, flag: F): AbVariantValue<F> {
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
/** Old-PoS run 43: review.siblingParity adds the sibling-parity check to the test-coverage and quality lanes (default off since old-PoS run 58). */
export const siblingParityOn = (config: unknown): boolean => catchEarlierPick(config, 'review.siblingParity') === 'on';
/** Old-PoS run 43: plan.exclusionRationaleCheck (default on) checks an excludes rationale against the Story's own items. */
export const exclusionRationaleCheckOn = (config: unknown): boolean => catchEarlierPick(config, 'plan.exclusionRationaleCheck') === 'on';
/** Old-PoS run 46: plan.baseDisagreement (default on) adds the base-disagreement check to the scope-plan reviewer dispatch. */
export const baseDisagreementOn = (config: unknown): boolean => catchEarlierPick(config, 'plan.baseDisagreement') === 'on';
/** EXPERIMENTAL review.deltaRounds=on: delta review rounds (core/review-delta-round.ts); malformed = off. */
export const deltaRoundsOn = (config: unknown): boolean => catchEarlierPick(config, 'review.deltaRounds') === 'on';
/** EXPERIMENTAL review.laneMerge: 'on' = ONE merged review session per REVIEW round, 'split' = TWO in parallel (core/review-lane-merge.ts); malformed = off. */
export const laneMergeMode = (config: unknown): AbVariantValue<'review.laneMerge'> => catchEarlierPick(config, 'review.laneMerge');
/** EXPERIMENTAL review.laneMerge is 'on' or 'split' (merged review sessions); malformed = off. */
export const laneMergeOn = (config: unknown): boolean => laneMergeMode(config) !== 'off';
/** EXPERIMENTAL plan.pinProbe=on: example pins probed on the Story base before PLAN→DEV (core/plan-pin-probe.ts); malformed = off. */
export const pinProbeOn = (config: unknown): boolean => catchEarlierPick(config, 'plan.pinProbe') === 'on';
/** EXPERIMENTAL plan.reviewMerge=on: one merged plan review in PLAN instead of the INIT reviewers + scope-plan runs (core/plan-review-merge.ts); malformed = off. */
export const reviewMergeOn = (config: unknown): boolean => catchEarlierPick(config, 'plan.reviewMerge') === 'on';
/** EXPERIMENTAL plan.rowBudget=on: one intent row per operand class, guidance + soft check (core/plan-row-budget.ts); malformed = off. */
export const rowBudgetOn = (config: unknown): boolean => catchEarlierPick(config, 'plan.rowBudget') === 'on';
/** EXPERIMENTAL plan.counterpartCoverage=on: an added operation's same-receiver counterpart cases must have rows before DEV (core/counterpart-coverage.ts); malformed = off. */
export const counterpartCoverageOn = (config: unknown): boolean => catchEarlierPick(config, 'plan.counterpartCoverage') === 'on';
/** Lab round-cut dev.removedGuardScan: 'advisory' (default) | 'off' | 'on' (core/removed-guard-scan.ts); malformed = advisory. */
export const removedGuardScanMode = (config: unknown): AbVariantValue<'dev.removedGuardScan'> => catchEarlierPick(config, 'dev.removedGuardScan');
/** The A/B evidence of a config (non-default switches only), or undefined when every switch has its production value or the config is malformed. */
export function abVariantEvidenceOf(config: unknown): AbVariantEvidence | undefined {
  try { return abVariantEvidence(resolveAbVariants(config)); } catch { return undefined; }
}

/**
 * owner.driver (old-PoS owner-driver lab; not a detection switch, recorded in
 * no evidence): who drives the lifecycle between the owner's judgment steps.
 *   'llm' (default)  the owner model runs `next --storyId=<id> --run`, its waits and reruns (unchanged)
 *   'framework'      a framework driver (the bench adapter) runs `next --storyId=<id> --untilAgent`
 *                    and resumes the owner only with the one agent action it returns; story_create
 *                    and `next --untilAgent` then tell the owner to end its turn instead of running `next --run`
 * A malformed value keeps 'llm'.
 */
export const OWNER_DRIVER_VALUES = ['llm', 'framework'] as const;
export type OwnerDriver = (typeof OWNER_DRIVER_VALUES)[number];
export function ownerDriver(config: unknown): OwnerDriver {
  const value = section(config, 'owner').driver;
  return value === 'framework' ? 'framework' : 'llm';
}
