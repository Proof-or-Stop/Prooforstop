/**
 * EXPERIMENTAL A/B switch `plan.pinProbe` (default off; lab plan-light,
 * structural-cost-analysis.md §7 item 4; new PoS ADR-105 "plan commands are
 * probed on the base before review").
 *
 * Old-PoS runs 31-33 lost 15-35 min each to DEV<->PLAN trips caused by pins
 * the owner computed by hand: a value the project itself computes at the
 * Story base was pinned wrong, the implementer wrote a test for it, and the
 * conflict surfaced only in DEV or REVIEW. With the switch on, the framework,
 * not the owner's arithmetic, is the source of truth for every pinned value
 * of UNCHANGED behaviour:
 *
 *   1. Base probe. Every extractable example row (core/request-probes.ts
 *      itemProbeCases: arrows, the prose connectors, statements and writes,
 *      several cases per row, isolated and cumulative runs) runs on a
 *      `git archive` of the Story base with the project's own declared
 *      evaluator (`probeRunner`, else `pinOracle`, read from the base
 *      commit's proof-or-stop.config.json). A case the base evaluates to a
 *      value is unchanged behaviour unless the row records that base value in
 *      `baseValue` (the Story deliberately changes it); a pin that disagrees
 *      is refused. An error pin is judged against a base error of the same
 *      message family (a shared leading text): an existing error format pinned
 *      wrong is refused, a different error is new behaviour. A case the base
 *      cannot evaluate (another error, new syntax, an unbound name, a timeout)
 *      is new behaviour and is skipped: the base is
 *      no oracle for what it cannot run, and a miss only skips the early
 *      warning (REVIEW still judges the code against the request).
 *   2. Request-literal examples. An example the request states literally
 *      (`<input> -> <output>` inside one backtick span, or two backtick spans
 *      joined by an arrow or a prose connector) is authoritative: a row whose
 *      case is that exact input must pin that output. Static, no evaluator.
 *
 * Refusal: the PLAN→DEV gate (canStartDevGuard / getGuardFailureReason DEV)
 * returns `[pin_probe_mismatch]` with the row, its input, the pinned and the
 * observed value, and ONE Next (a checklist_update row patch of the first
 * row). `next` names the same step before the scope-plan reviewer is launched,
 * so the plan review judges pins the base already confirmed. The framework
 * never rewrites a pin. Each evaluation is recorded under
 * `.proof-or-stop/runtime/plan-pin-probe/<storyId>.json` with the A/B evidence.
 *
 * Generic: no task values; the project declares its evaluator. Without a
 * declared evaluator only the request-literal check runs.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChecklistItem, VerificationIntent } from './types.js';
import { VERIFICATION_LANES } from './verification.js';
import { PROOF_OR_STOP_DIR } from './proof-or-stop-paths.js';
import { resolveCanonicalRuntimeProjectRoot } from './runtime-artifact-registry.js';
import { pinOracleStoryBase, prepareArchivedTree, validRunnerConfig } from './pin-oracle.js';
import { evaluateInTree, itemProbeCases, matchesPin, normalizeProbeValue, probeProgram, storyProbeRunner,
  type ProbeCase, type ProbeObservation, type ProbeRunnerConfig } from './request-probes.js';
import { abVariantEvidenceOf, pinProbeOn, type AbVariantEvidence } from './ab-variants.js';
import { loadConfig } from './config.js';
import { readStoryRequest } from './story-request.js';
import { shellQuote } from './shell-quote.js';
import type { StoryStore } from './store.js';
import { errorDecoration } from './exact-error-pin-lint.js';
import { requestLiteralExamples } from './request-literal-examples.js';
export { requestLiteralExamples };

export const PIN_PROBE_MISMATCH = 'pin_probe_mismatch';
export const PIN_PROBE_SCHEMA = 'proof-or-stop.plan-pin-probe.v1' as const;
/** Mismatches listed in one refusal / step (the rest are counted). */
const MAX_LISTED = 8;

export interface PinProbeMismatch {
  itemId: string;
  /** Intent row ref, e.g. CHK-002:edge:1. */
  ref: string;
  /** The case as code (statements and the compared expression). */
  code: string;
  pinned: string;
  observed: string;
  /** base: the Story base computed `observed`; request: the request states `observed` for this exact input. */
  source: 'base' | 'request';
}

export interface PinProbeResult {
  runner: 'probeRunner' | 'pinOracle' | null;
  base: string | null;
  /** Cases the base evaluated to a value (judged as unchanged behaviour). */
  judged: number;
  /** Cases the base could not evaluate (new behaviour / new syntax): skipped. */
  skipped: number;
  mismatches: PinProbeMismatch[];
  /**
   * Lab round-cut N4b: base disagreements on a write whose target form a request example defines
   * (new behaviour the Story adds on a statement the base also parses): advisory, never refused.
   */
  newBehaviour?: PinProbeMismatch[];
}

// ---------------------------------------------------------------------------
// Request-literal examples (pure)

const squash = (text: string): string => text.replace(/\s+/g, '');


/** The case's code as comparable strings (statements then the expression; a write also without its echoed receiver; whitespace-free). */
const caseKeys = (probe: Pick<ProbeCase, 'statements' | 'expr' | 'write'>): string[] => [squash([...probe.statements, probe.expr].join(';')),
  ...(probe.write ? [squash(probe.statements.join(';'))] : []), ...(probe.statements.length === 0 ? [squash(probe.expr)] : [])];

/** Request-literal contradictions of the cases (static). */
export function requestLiteralMismatches(cases: readonly ProbeCase[], requestText: string | null): PinProbeMismatch[] {
  if (!requestText) return [];
  const examples = requestLiteralExamples(requestText);
  if (!examples.length) return [];
  const byInput = new Map<string, string>();
  for (const example of examples) if (!byInput.has(squash(example.input))) byInput.set(squash(example.input), example.output);
  const out: PinProbeMismatch[] = [];
  for (const probe of cases) {
    if (probe.unbound || probe.dropped.length) continue;
    const stated = caseKeys(probe).map(key => byInput.get(key)).find(value => value !== undefined);
    if (stated === undefined) continue;
    if (normalizeProbeValue(stated) === normalizeProbeValue(probe.pinnedText)) continue;
    out.push({ itemId: probe.itemId, ref: probe.ref, code: probe.code, pinned: probe.pinnedText, observed: stated, source: 'request' });
  }
  return out;
}

/**
 * The base judgement of one case: null when the case agrees with the base, is
 * acknowledged by `baseValue`, or the base cannot evaluate it (new behaviour);
 * else the observed base value.
 */
export function baseDisagreement(probe: Pick<ProbeCase, 'pinned'>, observations: ReadonlyArray<ProbeObservation | undefined>, baseValue?: string): string | null {
  const values = observations.filter((row): row is ProbeObservation => Boolean(row) && row!.status === 'value');
  if (!values.length) return baseErrorDisagreement(probe, observations, baseValue);
  if (values.some(row => matchesPin(row, probe.pinned) === true)) return null;
  if (baseValue !== undefined && values.some(row => normalizeProbeValue(row.text) === normalizeProbeValue(baseValue))) return null;
  return values[0]!.text;
}

/** Shared leading text (whitespace collapsed) that makes two error messages one message family. */
const MIN_ERROR_FAMILY = 12;
const spaced = (text: string): string => text.replace(/\s+/g, ' ').trim();
/** The message without a runner's leading decoration (e.g. `&{`, `: `), for the family comparison. */
const messageOf = (text: string): string => spaced(text).replace(/^[^\p{L}\p{N}]+/u, '');
const firstLine = (text: string): string => (text.split('\n').find(line => line.trim()) ?? '').trim();

/**
 * An error pin against a base that answers with an error: unchanged behaviour
 * only when the base error belongs to the same message family (a leading text
 * of at least MIN_ERROR_FAMILY characters in common) and still differs from the
 * pin, e.g. an existing error format pinned with the operand quoted. A
 * different error (the base lacks the function, cannot parse the syntax) is new
 * behaviour and is skipped; a value pin on a base error is new behaviour too.
 */
function baseErrorDisagreement(probe: Pick<ProbeCase, 'pinned'>, observations: ReadonlyArray<ProbeObservation | undefined>, baseValue?: string): string | null {
  if (probe.pinned.kind === 'value') return null;
  const errors = observations.filter((row): row is ProbeObservation => Boolean(row) && row!.status === 'error');
  if (!errors.length || errors.some(row => matchesPin(row, probe.pinned) === true)) return null;
  const pin = messageOf(probe.pinned.text);
  const family = errors.map(row => firstLine(row.text)).find(line => {
    const text = messageOf(line);
    let shared = 0;
    while (shared < text.length && shared < pin.length && text[shared] === pin[shared]) shared += 1;
    return shared >= MIN_ERROR_FAMILY;
  });
  if (!family) return null;
  if (baseValue !== undefined && spaced(family).includes(spaced(baseValue))) return null;
  return family;
}

// ---------------------------------------------------------------------------
// New behaviour the request defines (lab round-cut N4b)

/** The code with literals and names abstracted (`a[1:3]` -> `v[9:9]`), whitespace-free; a signed number is a number. */
const shapeOf = (code: string): string => code.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '"').replace(/[A-Za-z_$][\w$]*/g, 'v')
  .replace(/\d+(?:\.\d+)?/g, '9').replace(/\s+/g, '').replace(/-9/g, '9');
/** The left-hand side of a top-level single `=` (not `==`, `=>`, `<=`, `>=`, `!=`), or null. */
function assignmentTarget(code: string): string | null {
  let depth = 0;
  for (let index = 0; index < code.length; index += 1) {
    const char = code[index]!;
    if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) depth = Math.max(0, depth - 1);
    else if (char === '=' && depth === 0 && !'=!<>'.includes(code[index - 1] ?? '') && !'=>'.includes(code[index + 1] ?? '')) return code.slice(0, index).trim() || null;
  }
  return null;
}

/**
 * Run 75: `a[1:3]=[20,30]` was refused because the base (which has no range assignment) computes
 * something else for it; the Story defines that statement. A case whose in-place write (an index or
 * member target; the shape of its left-hand side, e.g. `v[9:9]`) appears as an assignment target in a
 * request example is new behaviour: its base disagreement is advisory. Reads, plain name bindings and
 * write forms the request does not show stay judged on the base.
 */
export function requestDefinesWrite(probe: Pick<ProbeCase, 'write' | 'statements'>, requestText: string | null): boolean {
  if (!requestText) return false;
  // The case's in-place writes (an index / member target, never a plain name binding), the probed write included.
  const shapes = new Set(probe.statements.map(assignmentTarget).filter((target): target is string => Boolean(target && /[[.]/.test(target))).map(shapeOf));
  if (!shapes.size) return false;
  for (const match of requestText.matchAll(/`([^`\n]+)`/g)) {
    const defined = assignmentTarget(match[1]!);
    if (defined && /[[.]/.test(defined) && shapes.has(shapeOf(defined))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Evaluation

function rowBaseValues(items: readonly Pick<ChecklistItem, 'id' | 'verificationIntent'>[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const item of items) {
    const intent: VerificationIntent | undefined = item.verificationIntent;
    for (const lane of VERIFICATION_LANES) {
      for (const [index, row] of (intent?.[lane] ?? []).entries()) {
        if (typeof row.baseValue === 'string') out.set(row.id ?? `${item.id}:${lane}:${index}`, row.baseValue);
      }
    }
  }
  return out;
}

function git(cwd: string, args: string[]): string | null {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 }).trim(); } catch { return null; }
}

/** The evaluator for the Story base: the declared probeRunner (shared tree), else the declared pinOracle. */
export function baseEvaluator(store: Pick<StoryStore, 'readStory'>, root: string, storyId: string, gitCwd: string):
  { kind: 'probeRunner' | 'pinOracle'; base: string; tree: string; config: ProbeRunnerConfig; env: Record<string, string> } | null {
  const runner = storyProbeRunner(store, root, storyId, gitCwd);
  if (runner) return { kind: 'probeRunner', base: runner.base, tree: runner.baseTree, config: runner.config, env: runner.env };
  try {
    if (!existsSync(join(gitCwd, 'proof-or-stop.config.json')) || !readFileSync(join(gitCwd, 'proof-or-stop.config.json'), 'utf8').includes('"pinOracle"')) return null;
    const story = store.readStory(storyId) as { integrationTarget?: { parentCommitAtCreation?: string } };
    const base = pinOracleStoryBase(gitCwd, story.integrationTarget?.parentCommitAtCreation);
    if (!base) return null;
    const text = git(gitCwd, ['show', `${base}:proof-or-stop.config.json`]);
    if (!text) return null;
    const parsed = JSON.parse(text) as { pinOracle?: unknown; validate?: { env?: Record<string, string> } };
    const config = validRunnerConfig(parsed.pinOracle) as ProbeRunnerConfig | null;
    if (!config) return null;
    const env = { ...(parsed.validate?.env ?? {}), ...(config.env ?? {}) };
    const key = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 8);
    const tree = prepareArchivedTree(join(resolveCanonicalRuntimeProjectRoot(root), PROOF_OR_STOP_DIR, 'runtime', 'plan-pin-probe', `base-${base.slice(0, 12)}-${key}`),
      gitCwd, base, config.setup, config.timeoutMs, env);
    return tree ? { kind: 'pinOracle', base, tree, config, env } : null;
  } catch {
    return null;
  }
}

/** Probe every open item's example rows: request-literal contradictions, then base disagreements. */
export function pinProbeMismatches(args: { store: Pick<StoryStore, 'readStory' | 'readChecklist' | 'storyFilePath'>; root: string; storyId: string; gitCwd: string }): PinProbeResult {
  const items = args.store.readChecklist(args.storyId).items.filter(item => item.status !== 'withdrawn');
  const cases = items.flatMap(item => itemProbeCases(item, { prose: true }));
  const request = readStoryRequest(args.store, args.storyId);
  const requestText = request.status === 'ok' ? request.text : null;
  const mismatches = requestLiteralMismatches(cases, requestText);
  const flaggedKeys = new Set(mismatches.map(row => `${row.ref}|${row.code}`));
  const runnable = cases.filter(probe => !probe.unbound && probe.dropped.length === 0);
  if (!runnable.length) return { runner: null, base: null, judged: 0, skipped: 0, mismatches };
  const evaluator = baseEvaluator(args.store, args.root, args.storyId, args.gitCwd);
  if (!evaluator) return { runner: null, base: null, judged: 0, skipped: runnable.length, mismatches };
  const programsOf = (probe: ProbeCase): string[] => [probeProgram(evaluator.config, probe.isolatedStatements ?? probe.statements, probe.expr),
    ...(probe.isolatedStatements ? [probeProgram(evaluator.config, probe.statements, probe.expr)] : [])];
  // A pinOracle's skipPattern marks every error as "cannot run" (its oracle compares values only);
  // the probe keeps errors as errors (their own tree and cache) and applies it to exit-0 output only.
  const skip = evaluator.kind === 'pinOracle' && evaluator.config.skipPattern ? (() => { try { return new RegExp(evaluator.config.skipPattern!, 'm'); } catch { return null; } })() : null;
  const raw = evaluateInTree({ config: evaluator.kind === 'pinOracle' ? { ...evaluator.config, skipPattern: undefined } : evaluator.config, env: evaluator.env },
    evaluator.tree, runnable.flatMap(programsOf));
  const observed = new Map([...raw].map(([program, row]) => [program, skip && row.status === 'value' && skip.test(row.text) ? { status: 'unrunnable' as const, text: row.text } : row]));
  const baseValues = rowBaseValues(items);
  let judged = 0;
  let skipped = 0;
  const newBehaviour: PinProbeMismatch[] = [];
  for (const probe of runnable) {
    const observations = programsOf(probe).map(program => observed.get(program));
    const value = baseDisagreement(probe, observations, baseValues.get(probe.ref));
    // Judged: the base answered with a value, or with an error the pin states or contradicts within its message family.
    const answered = value !== null || observations.some(row => row?.status === 'value' || (row?.status === 'error' && matchesPin(row, probe.pinned) === true));
    if (!answered) { skipped += 1; continue; }
    judged += 1;
    if (value === null || flaggedKeys.has(`${probe.ref}|${probe.code}`)) continue;
    const row: PinProbeMismatch = { itemId: probe.itemId, ref: probe.ref, code: probe.code, pinned: probe.pinnedText, observed: value, source: 'base' };
    if (requestDefinesWrite(probe, requestText)) newBehaviour.push(row);
    else mismatches.push(row);
  }
  return { runner: evaluator.kind, base: evaluator.base, judged, skipped, mismatches, ...(newBehaviour.length ? { newBehaviour } : {}) };
}

/**
 * Old-PoS run 68 (fix 4, core/exact-error-pin-lint.ts): the first listed exact-error case the
 * Story base renders as an error with a trailing decoration after its first line (the engine's
 * own error format), or null (no declared evaluator, no runnable case, no decorated error).
 */
export function baseErrorDecorationOf(args: { store: Pick<StoryStore, 'readStory' | 'readChecklist'>; root: string; storyId: string; gitCwd: string; refs: ReadonlySet<string> }):
  { ref: string; firstLine: string; decoration: string } | null {
  try {
    const items = args.store.readChecklist(args.storyId).items.filter(item => item.status !== 'withdrawn');
    const cases = items.flatMap(item => itemProbeCases(item, { prose: true })).filter(probe => args.refs.has(probe.ref) && !probe.unbound && probe.dropped.length === 0);
    if (!cases.length) return null;
    const evaluator = baseEvaluator(args.store, args.root, args.storyId, args.gitCwd);
    if (!evaluator) return null;
    const programOf = (probe: ProbeCase): string => probeProgram(evaluator.config, probe.isolatedStatements ?? probe.statements, probe.expr);
    const observed = evaluateInTree({ config: { ...evaluator.config, skipPattern: undefined }, env: evaluator.env }, evaluator.tree, cases.map(programOf));
    for (const probe of cases) {
      const row = observed.get(programOf(probe));
      const decoration = row?.status === 'error' ? errorDecoration(row.text) : null;
      if (decoration) return { ref: probe.ref, firstLine: row!.text.split('\n')[0]!.trim(), decoration };
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rendering, evidence, gate

const clip = (text: string, max = 160): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function describePinProbeMismatch(row: PinProbeMismatch): string {
  return row.source === 'request'
    ? `${row.ref}: \`${clip(row.code)}\` -> the request states ${clip(row.observed)}, the row pins ${clip(row.pinned)}`
    : `${row.ref}: \`${clip(row.code)}\` -> the Story base computes ${clip(row.observed)}, the row pins ${clip(row.pinned)}`;
}

/** The ONE next action for the first mismatch: a row patch (checklist_update intentRows). */
export function pinProbeNextPayload(storyId: string, row: PinProbeMismatch): Record<string, unknown> {
  return { storyId, itemId: row.itemId, intentRows: [{ ref: row.ref,
    desc: `<${row.ref} rewritten with the expected value ${clip(row.observed, 80)}${row.source === 'base' ? ', or keep it and add "baseValue" if the Story deliberately changes this base behaviour' : ''}>` }] };
}

export function pinProbeRule(result: Pick<PinProbeResult, 'runner' | 'base'>): string {
  const base = result.runner && result.base ? `The project's ${result.runner} ran each row on the Story base ${result.base.slice(0, 12)}; ` : '';
  return `${base}a row of unchanged behaviour must pin what the base computes, and a row whose input the request states literally must pin the request's output. `
    + 'Correct the row\'s expected value (and its derivation). If the Story deliberately changes a base behaviour the row pins, keep the pin and record the base value on the row as "baseValue" (the plan review audits it against the request). The framework never rewrites a pin.';
}

function evidencePath(root: string, storyId: string): string {
  return join(resolveCanonicalRuntimeProjectRoot(root), PROOF_OR_STOP_DIR, 'runtime', 'plan-pin-probe', `${storyId}.json`);
}

function recordEvidence(root: string, storyId: string, result: PinProbeResult, abVariant: AbVariantEvidence | undefined): void {
  try {
    const path = evidencePath(root, storyId);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ schema: PIN_PROBE_SCHEMA, storyId, checkedAt: new Date().toISOString(), ...(abVariant ? { abVariant } : {}), ...result }, null, 2)}\n`);
  } catch { /* evidence of a refusal the gate repeats on every call; never fails the gate */ }
}

/** The switch's result for a Story, or null when plan.pinProbe is off (or the config is unreadable). */
export function planPinProbe(store: Pick<StoryStore, 'readStory' | 'readChecklist' | 'storyFilePath'>, root: string, storyId: string, gitCwd: string | (() => string)): PinProbeResult | null {
  let config: unknown;
  try { config = loadConfig(root); } catch { return null; }
  if (!pinProbeOn(config)) return null;
  const result = pinProbeMismatches({ store, root, storyId, gitCwd: typeof gitCwd === 'function' ? gitCwd() : gitCwd });
  recordEvidence(root, storyId, result, abVariantEvidenceOf(config));
  return result;
}

/** The PLAN→DEV refusal (`[pin_probe_mismatch]` + one Next), or null. */
export function pinProbeDevEntryFailure(store: Pick<StoryStore, 'readStory' | 'readChecklist' | 'storyFilePath'>, root: string, storyId: string, gitCwd: string | (() => string)): string | null {
  const result = planPinProbe(store, root, storyId, gitCwd);
  if (!result || !result.mismatches.length) return null;
  const listed = result.mismatches.slice(0, MAX_LISTED).map(describePinProbeMismatch);
  const more = result.mismatches.length > MAX_LISTED ? ` +${result.mismatches.length - MAX_LISTED} more` : '';
  const advisory = result.newBehaviour?.length
    ? ` Not refused (a write form the request defines, new behaviour): ${result.newBehaviour.slice(0, 4).map(describePinProbeMismatch).join('; ')}; record "baseValue" on such a row if the Story deliberately changes what the base computes.`
    : '';
  return `Cannot enter DEV: ${result.mismatches.length} pinned value(s) disagree with the Story base or the request [${PIN_PROBE_MISMATCH}] (A/B switch plan.pinProbe=on): `
    + `${listed.join('; ')}${more}. ${pinProbeRule(result)}${advisory}\n`
    + `Next: proof-or-stop checklist_update ${shellQuote(JSON.stringify(pinProbeNextPayload(storyId, result.mismatches[0]!)))}`;
}
