/**
 * Lab run132 (bench-staging/oldpos/run134-analysis.md items 1 and 2; switch `plan.baseEvidence`, default on, `off` =
 * rollback). Old-PoS run 134 (control): the scope-plan reviewer's pin audit asked for `[0,1,2,3][1:2] -> [2]` while the
 * Story base, whose two-part range the request keeps unchanged, gives `[1]`; `next` handed the owner "Apply the value the
 * verdict requests" and the wrong value reached DEV (an intent-conflict detour). Later the plan_pin_dispute and
 * pin-reversal remedies excluded existing-behaviour cases because "neither the request nor the counterpart states its
 * value" although the base implements them.
 *
 * Base evidence of ONE checklist row's case, in this order (the first that decides wins):
 *   request_literal  the request states the case literally (`<input> -> <output>` in one backtick span, or two spans
 *                    joined by an arrow / a prose connector: core/request-literal-examples.ts): it outranks the base;
 *   evaluator        the project's declared evaluator (`probeRunner`, else `pinOracle`, read from the Story base commit:
 *                    core/plan-pin-probe.ts baseEvaluator) runs the row's case (its statements and subject,
 *                    core/request-probes.ts itemProbeCases) on a `git archive` of the Story base. A value or an error
 *                    is evidence; a case the base cannot run (new syntax, unbound name, timeout) is none;
 *   base_test        a base test source states the case as a string literal followed, on the same line, by one value
 *                    literal (a quoted string, a bracket group, a number, a Go composite `[]T{...}`), and every such line
 *                    states the same value (table tests: `{"<case>", <value>}`). Read cases only (no statements).
 * Nothing else is evidence: the framework never derives a value by hand, and no evidence means no decision.
 *
 * Pin audit (`pinAuditBaseDecisions`): for each pin-audit gap of the current scope-plan verdict:
 *   keep     the request states the case with the requested value, or no evidence, or the evidence gives the requested
 *            value: the reviewer's correction is offered as before;
 *   settle   the evidence gives the PINNED value: the reviewer is refuted, the gap closes with the row unchanged
 *            (openScopeGaps baseValues), story_review lists it as advisory [scope_gap_base_settled];
 *   correct  the evidence gives a third value: the correction step re-pins the row to the base value (not the
 *            reviewer's), and a row stating it closes the gap.
 * An error evidence decides only `settle` (its text contains the pinned text) and otherwise keeps the correction.
 * The decisions are journaled (write-only) under `.proof-or-stop/runtime/pin-audit-base/<storyId>.json` with an inputs
 * digest (base, request, verdict, cited rows); every reader recomputes them in its own process (in-process memo only)
 * and never reads that file back: the owner can write it.
 *
 * Remedies (`storyBaseEvidenceLookup`, injected into core/pin-dispute.ts pinDisputeRemedy and core/pin-amendment.ts
 * pinReversalRemedy): an "exclude" of a value row whose case has base evidence becomes a ready re-pin to the base value
 * (`kind: 'base'`); exclusion stays only where no evidence exists.
 *
 * Detection-neutral by construction: a correction is dropped only when base evidence positively contradicts it, and a
 * request sentence stating the reviewer's value always wins. Limits: without a declared evaluator only request literals
 * and base tests that state the exact case decide (run 134's control arm declared none, and no base test states
 * `[0,1,2,3][1:2]`); an error text is compared by containment only.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChecklistItem, ScopeCheckData } from './types.js';
import type { StoryStore } from './store.js';
import { PROOF_OR_STOP_DIR } from './proof-or-stop-paths.js';
import { resolveCanonicalRuntimeProjectRoot } from './runtime-artifact-registry.js';
import { loadConfig } from './config.js';
import { baseEvidenceOn } from './ab-variants.js';
import { readStoryRequest } from './story-request.js';
import { pinOracleStoryBase } from './pin-oracle.js';
import { baseEvaluator } from './plan-pin-probe.js';
import { evaluateInTree, itemProbeCases, probeProgram, type ProbeCase } from './request-probes.js';
import { requestLiteralExamples } from './request-literal-examples.js';
import { isTestSource, readBaseSources } from './counterpart-coverage.js';
import { leadingLiteral, parsePinAuditGap, sameValue, type PinAuditGap } from './pin-audit-correction.js';
import { PIN_AUDIT_GAP_PREFIX } from './intent-derivation.js';
import { resolveGitCwd } from './story-signed-workspace-resolution.js';

export const PIN_AUDIT_BASE_SCHEMA = 'proof-or-stop.pin-audit-base.v1' as const;
export const SCOPE_GAP_BASE_SETTLED = 'scope_gap_base_settled';

export interface BaseEvidence { value: string; status: 'value' | 'error'; source: 'request_literal' | 'evaluator' | 'base_test'; detail: string }

const LANES = ['happy', 'edge', 'adversarial'] as const;
const squash = (text: string): string => text.replace(/\s+/g, '');
const ROW_REF = /^(CHK-\d+):(happy|edge|adversarial):(\d+)$/;

type Evaluator = NonNullable<ReturnType<typeof baseEvaluator>>;
interface SourceText { path: string; text: string }

/** What base evidence is read from, prepared lazily (no git, no evaluator setup until a case needs it). */
export interface BaseEvidenceContext {
  requestText: string | null;
  evaluator: () => Evaluator | null;
  baseTests: () => readonly SourceText[];
}

/** The one case of a row (its statements and subject), or null (no arrow, several cases, unbound, unextractable). */
export function rowCase(item: Pick<ChecklistItem, 'id' | 'verificationIntent'>, lane: string, index: number): ProbeCase | null {
  const row = (item.verificationIntent as Record<string, unknown[] | undefined> | undefined)?.[lane]?.[index];
  if (!row) return null;
  const cases = itemProbeCases({ id: item.id, verificationIntent: { [lane]: [row] } as ChecklistItem['verificationIntent'] });
  if (cases.length !== 1) return null;
  const only = cases[0]!;
  return only.unbound || only.dropped.length ? null : only;
}

/** A Go composite `[]T{a, b}` as a group `[a, b]`; any other literal unchanged. */
function asGroup(literal: string): string {
  return /^\{/.test(literal) ? `[${literal.slice(1, -1)}]` : literal;
}

/** The one value literal a base test line states right after the case literal at `after`, or null. */
function valueAfter(line: string, after: number): string | null {
  const rest = line.slice(after).replace(/^\s*(?:,|:|=>|->|==)?\s*/, '');
  const composite = rest.match(/^\[\](?:[\w.*]+)\s*(?=\{)/);
  if (composite) {
    const group = leadingLiteral(rest.slice(composite[0].length));
    return group ? asGroup(group) : null;
  }
  return leadingLiteral(rest);
}

/** Base tests stating `expr` as a string literal with one value after it; null when none or when they disagree. */
function baseTestValue(files: readonly SourceText[], expr: string): BaseEvidence | null {
  const want = squash(expr);
  if (want.length < 3) return null;
  const found: Array<{ value: string; at: string }> = [];
  for (const file of files) {
    if (!isTestSource(file.path)) continue;
    const lines = file.text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!line.includes(expr.trim()[0] ?? '')) continue;
      for (const match of line.matchAll(/"((?:[^"\\\n]|\\.)*)"|`([^`\n]*)`/g)) {
        const text = (match[1] ?? match[2] ?? '').replace(/\\(["\\])/g, '$1');
        if (squash(text) !== want) continue;
        const value = valueAfter(line, match.index! + match[0].length);
        if (value) found.push({ value, at: `${file.path}:${index + 1}` });
      }
    }
  }
  if (!found.length || found.some(row => !sameValue(row.value, found[0]!.value))) return null;
  return { value: found[0]!.value, status: 'value', source: 'base_test', detail: `the Story base test ${found[0]!.at} states \`${expr.trim()}\` with ${found[0]!.value}${found.length > 1 ? ` (${found.length} lines agree)` : ''}` };
}

/** Base evidence of one row's case (see the module header), or null. */
export function rowBaseEvidence(ctx: BaseEvidenceContext, item: Pick<ChecklistItem, 'id' | 'verificationIntent'>, lane: string, index: number): BaseEvidence | null {
  const probe = rowCase(item, lane, index);
  if (!probe) return null;
  const code = squash(probe.code);
  const expr = squash(probe.expr);
  if (ctx.requestText) {
    const stated = requestLiteralExamples(ctx.requestText).find(example => squash(example.input) === code || (!probe.statements.length && squash(example.input) === expr));
    if (stated) return { value: stated.output, status: 'value', source: 'request_literal', detail: `the request states \`${stated.input} -> ${stated.output}\`` };
  }
  const evaluator = ctx.evaluator();
  if (evaluator) {
    try {
      const program = probeProgram(evaluator.config, probe.statements, probe.expr);
      const observed = evaluateInTree({ config: evaluator.config, env: evaluator.env }, evaluator.tree, [program]).get(program);
      if (observed && observed.status !== 'unrunnable' && observed.text.trim()) {
        return { value: observed.text.trim(), status: observed.status, source: 'evaluator',
          detail: `the project's ${evaluator.kind} on the Story base ${evaluator.base.slice(0, 12)} ${observed.status === 'error' ? 'raises' : 'prints'} \`${observed.text.trim().slice(0, 160)}\` for \`${probe.code.slice(0, 160)}\`` };
      }
    } catch { /* no evidence */ }
  }
  if (!probe.statements.length) return baseTestValue(ctx.baseTests(), probe.expr);
  return null;
}

/** `value` written the way `pinned` is (a quoted pin keeps quotes; an unquoted group pin takes a quoted group unquoted). */
export function inPinnedForm(value: string, pinned: string): string {
  const text = value.trim();
  const quoted = text.length >= 2 && /^["'`]/.test(text) && text.at(-1) === text[0];
  if (quoted && !/^["'`]/.test(pinned.trim()) && /^[[{(]/.test(text.slice(1, -1).trim())) return text.slice(1, -1);
  return text;
}

/** The request states the case together with `value` (either side whitespace-insensitive). */
function requestStates(requestText: string | null, caseText: string, value: string): boolean {
  if (!requestText) return false;
  const text = squash(requestText);
  return text.includes(squash(caseText)) && text.includes(squash(value));
}

export interface PinAuditBaseDecision { feature: string; ref: string; decision: 'keep' | 'settle' | 'correct'; value: string | null; evidence: BaseEvidence | null; why: string }

/** The base decision of each pin-audit gap of a verdict (see the module header). */
export function pinAuditBaseDecisions(ctx: BaseEvidenceContext, items: readonly ChecklistItem[], features: ReadonlyArray<{ feature: string; status: string }>): PinAuditBaseDecision[] {
  const out: PinAuditBaseDecision[] = [];
  for (const feature of features) {
    if (feature.status !== 'gap' || !feature.feature.startsWith(PIN_AUDIT_GAP_PREFIX)) continue;
    const gap = parsePinAuditGap(feature.feature);
    if (!gap) continue;
    const item = items.find(row => row.id === gap.itemId);
    const probe = item ? rowCase(item, gap.lane, gap.index) : null;
    const keep = (why: string, evidence: BaseEvidence | null = null): PinAuditBaseDecision => ({ feature: gap.feature, ref: gap.ref, decision: 'keep', value: null, evidence, why });
    if (!item || !probe) { out.push(keep('no single case the base can be asked about')); continue; }
    if (requestStates(ctx.requestText, probe.code, gap.requestValue)) { out.push(keep('the request states the case with the requested value')); continue; }
    const evidence = rowBaseEvidence(ctx, item, gap.lane, gap.index);
    if (!evidence) { out.push(keep('no base evidence for the case')); continue; }
    out.push(decide(gap, evidence, keep));
  }
  return out;
}

function decide(gap: PinAuditGap, evidence: BaseEvidence, keep: (why: string, evidence?: BaseEvidence | null) => PinAuditBaseDecision): PinAuditBaseDecision {
  if (evidence.status === 'error') {
    const text = squash(evidence.value);
    if (text.includes(squash(gap.pinned)) && !text.includes(squash(gap.requestValue))) {
      return { feature: gap.feature, ref: gap.ref, decision: 'settle', value: gap.pinned, evidence, why: `${evidence.detail}: the pinned error stands, the reviewer's ${gap.requestValue} is refuted` };
    }
    return keep('an error the base raises decides only the pinned text', evidence);
  }
  if (sameValue(evidence.value, gap.requestValue) || sameValue(inPinnedForm(evidence.value, gap.pinned), gap.requestValue)) return keep(`${evidence.detail}: the base agrees with the reviewer`, evidence);
  if (sameValue(evidence.value, gap.pinned) || sameValue(inPinnedForm(evidence.value, gap.pinned), gap.pinned)) {
    return { feature: gap.feature, ref: gap.ref, decision: 'settle', value: gap.pinned, evidence, why: `${evidence.detail}: the pinned ${gap.pinned} stands, the reviewer's ${gap.requestValue} is refuted` };
  }
  const value = inPinnedForm(evidence.value, gap.pinned);
  return { feature: gap.feature, ref: gap.ref, decision: 'correct', value, evidence, why: `${evidence.detail}: neither the pinned ${gap.pinned} nor the reviewer's ${gap.requestValue}; the row states the base value ${value}` };
}

// ---------------------------------------------------------------------------
// Story wiring (cached evidence, the switch)

export interface PinAuditBaseEvidence { schema: typeof PIN_AUDIT_BASE_SCHEMA; storyId: string; checkedAt: string; verdictAt: string | null; base: string | null; inputsDigest: string; decisions: PinAuditBaseDecision[] }

const evidencePath = (root: string, storyId: string): string => join(resolveCanonicalRuntimeProjectRoot(root), PROOF_OR_STOP_DIR, 'runtime', 'pin-audit-base', `${storyId}.json`);
const memo = new Map<string, PinAuditBaseEvidence>();

function switchOn(root: string): boolean {
  try { return baseEvidenceOn(loadConfig(root)); } catch { return true; }
}

/** The lazily prepared evidence sources of a Story (request text, the declared evaluator, the base test sources). */
export function storyBaseEvidenceContext(store: Pick<StoryStore, 'readStory'>, root: string, storyId: string, gitCwd: string, requestText: string | null): BaseEvidenceContext {
  let evaluator: Evaluator | null | undefined;
  let tests: readonly SourceText[] | undefined;
  return {
    requestText,
    evaluator: () => {
      if (evaluator === undefined) { try { evaluator = baseEvaluator(store, root, storyId, gitCwd); } catch { evaluator = null; } }
      return evaluator;
    },
    baseTests: () => {
      if (tests === undefined) {
        try {
          const story = store.readStory(storyId) as { integrationTarget?: { parentCommitAtCreation?: string } };
          const base = pinOracleStoryBase(gitCwd, story.integrationTarget?.parentCommitAtCreation);
          tests = base ? (readBaseSources(gitCwd, base) ?? []).filter(file => isTestSource(file.path)) : [];
        } catch { tests = []; }
      }
      return tests;
    },
  };
}

function requestTextOf(store: Pick<StoryStore, 'readStory'>, storyId: string): string | null {
  try {
    const request = readStoryRequest(store as never, storyId);
    return request.status === 'ok' ? request.text : null;
  } catch { return null; }
}

/** The pin-audit base decisions of the Story's current scope-plan verdict (cached by inputs digest), or null (switch off, no gap). */
export function planPinAuditBase(store: Pick<StoryStore, 'readStory' | 'readChecklist' | 'readScopeCheck'>, root: string, storyId: string, gitCwd: string | (() => string)): PinAuditBaseEvidence | null {
  if (!switchOn(root)) return null;
  try {
    const scope = store.readScopeCheck(storyId) as Pick<ScopeCheckData, 'features' | 'checkedAt'> | null;
    const gaps = (scope?.features ?? []).filter(feature => feature.status === 'gap' && feature.feature.startsWith(PIN_AUDIT_GAP_PREFIX));
    if (!scope || !gaps.length) return null;
    const cwd = typeof gitCwd === 'function' ? gitCwd() : gitCwd;
    const items = store.readChecklist(storyId).items;
    const requestText = requestTextOf(store, storyId);
    const story = store.readStory(storyId) as { integrationTarget?: { parentCommitAtCreation?: string } };
    const base = pinOracleStoryBase(cwd, story.integrationTarget?.parentCommitAtCreation);
    const cited = gaps.map(feature => parsePinAuditGap(feature.feature)).filter((gap): gap is PinAuditGap => Boolean(gap))
      .map(gap => ({ ref: gap.ref, row: (items.find(item => item.id === gap.itemId)?.verificationIntent as Record<string, unknown[] | undefined> | undefined)?.[gap.lane]?.[gap.index] ?? null }));
    const inputsDigest = createHash('sha256').update(JSON.stringify({ v: 1, base, requestText, verdictAt: scope.checkedAt ?? null, gaps: gaps.map(gap => gap.feature), cited })).digest('hex');
    const path = evidencePath(root, storyId);
    // Security (lab run132 review): the decisions drop pin-audit gaps and change remedies, so they are recomputed in this
    // process from the inputs every time (in-process memo only). The runtime file is a write-only journal: an owner can
    // write it (its inputsDigest is computable from public inputs), so it is never read back.
    const cached = memo.get(path);
    if (cached?.inputsDigest === inputsDigest) return cached;
    const decisions = pinAuditBaseDecisions(storyBaseEvidenceContext(store, root, storyId, cwd, requestText), items, gaps);
    const evidence: PinAuditBaseEvidence = { schema: PIN_AUDIT_BASE_SCHEMA, storyId, checkedAt: new Date().toISOString(), verdictAt: scope.checkedAt ?? null, base, inputsDigest, decisions };
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
    } catch { /* evidence of a check every reader repeats */ }
    memo.set(path, evidence);
    return evidence;
  } catch {
    return null;
  }
}

/** feature -> base value of the settle / correct decisions (openScopeGaps baseValues); empty when off or undecided. */
export function pinAuditBaseValues(store: Pick<StoryStore, 'readStory' | 'readChecklist' | 'readScopeCheck'> & Partial<Pick<StoryStore, 'projectRoot'>>, root: string, storyId: string,
  gitCwd?: string | (() => string)): Map<string, string> {
  const evidence = planPinAuditBase(store, root, storyId, gitCwd ?? (() => resolveGitCwd({ store: store as never, storyId, metadataRoot: root, projectRoot: root })));
  return new Map((evidence?.decisions ?? []).filter(row => row.decision !== 'keep' && row.value !== null).map(row => [row.feature, row.value!]));
}

/** A lookup of a row's base evidence for the remedies (null when off). */
export function storyBaseEvidenceLookup(store: Pick<StoryStore, 'readStory'>, root: string, storyId: string, gitCwd: string):
  ((item: Pick<ChecklistItem, 'id' | 'verificationIntent'>, ref: string) => BaseEvidence | null) | null {
  if (!switchOn(root)) return null;
  const ctx = storyBaseEvidenceContext(store, root, storyId, gitCwd, requestTextOf(store, storyId));
  return (item, ref) => {
    const match = ref.match(ROW_REF);
    return match && LANES.includes(match[2] as typeof LANES[number]) ? rowBaseEvidence(ctx, item, match[2]!, Number(match[3])) : null;
  };
}

/** The scope-plan prompt block naming the rows the base decided (empty when none). */
export function renderPinAuditBaseRows(evidence: Pick<PinAuditBaseEvidence, 'decisions'> | null): string[] {
  const decided = (evidence?.decisions ?? []).filter(row => row.decision !== 'keep');
  if (!decided.length) return [];
  return ['Base-decided rows (framework, plan.baseEvidence): an earlier pin-audit value for these rows was checked against the Story base. Do not raise a pin-audit gap that asks for another value of the same case unless a request sentence states it (quote it); existing behaviour the request keeps is decided by the base, not recomputed by hand.',
    ...decided.slice(0, 12).map(row => `- ${row.ref}: ${row.decision === 'settle' ? `the pin stands (${row.value})` : `re-pinned to the base value ${row.value}`}; ${row.evidence?.detail ?? row.why}`)];
}
