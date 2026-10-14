/**
 * Lab initplan (bench-staging/oldpos/initplan-breakdown.md §5 rank 4): in runs 72 / 77 / 80 the owner met the
 * deterministic PLAN lints one at a time after INIT (`plan_authoring`, `counterpart_coverage_missing`,
 * `exact_error_pin_check`, each a `next` round trip of 25-60 s; 88 / 118 / 73 s before the first scope-plan
 * run), although each one only reads the checklist and the request the owner had written at story_create.
 *
 * This module holds the row patches those lints hand out (one `checklist_update` per item with `intentRows`:
 * only the listed rows patched, new rows appended with `<item>:<lane>:+`) and `planLintPreview`, which runs the
 * same lints right after story_create (and after a checklist_update in INIT / PLAN) and prints every due problem
 * at once, with the merged commands. The lints themselves are unchanged and PLAN still asks for whatever is
 * still due; the preview only lets one authoring pass fix them before the INIT reviewers judge the Story.
 * Nothing here writes, records an offer or blocks.
 */
import type { ChecklistItem } from './types.js';
import type { StoryStore } from './store.js';
import { appendRowRef } from './intent-row-patch.js';
import { derivationPlaceholder } from './intent-derivation.js';
import { intentBasisDigest } from './intent-basis.js';
import { coveragePlaceholders, type CoverageGap } from './plan-coverage-matrix.js';
import { planPreScopeBlockers, type PreScopeItemBlockers } from './plan-pre-scope-blockers.js';
import { STORY_FOCUSED_CLASSIFICATION } from './verification-intent-classification.js';
import { exactWholeErrorPins } from './exact-error-pin-lint.js';
import { requestPinFindings } from './request-pin-audit.js';
import { counterpartNextPayload, planCounterpartCoverage } from './counterpart-coverage.js';
import { readStoryRequest } from './story-request.js';
import { loadConfig } from './config.js';
import { resolveWorkflowPolicy } from './workflow-policy.js';
import { shellQuote } from './shell-quote.js';

type Call = { command: string; payload: Record<string, unknown> };

/** The classified, pinned placeholder row a pre-scope checklist_update adds. */
export function placeholderIntentRow(desc: string): Record<string, unknown> {
  return { desc, type: 'logic', priority: 'must', ...STORY_FOCUSED_CLASSIFICATION,
    verification: { command: '<pinned test command, e.g. go test -v ./pkg -run ^TestName$>', selector: '<line its passing run prints, e.g. --- PASS: TestName>' } };
}

/** Coverage-matrix placeholder rows for one item (core/plan-coverage-matrix.ts), pinned like any authored row. */
export function coverageIntentRows(gaps: readonly CoverageGap[], itemId: string): Array<Record<string, unknown>> {
  return coveragePlaceholders(gaps, itemId).map(row => ({ ...placeholderIntentRow(row.desc), derivation: row.derivation }));
}

/**
 * The pre-scope authoring payload of one item: ONE row patch. A listed row gets only its missing pin /
 * derivation; a missing lane, a coverage row and the request-literal row are appended (`<item>:<lane>:+`); the
 * other rows are untouched (initplan-breakdown.md rank 6, run 80: 28 owner requests re-sending whole intents).
 */
export function preScopeItemPayload(storyId: string, item: Pick<ChecklistItem, 'id' | 'verificationIntent'>, need: PreScopeItemBlockers | undefined,
  coverage: ReadonlyArray<Record<string, unknown>>, literals: readonly string[]): Record<string, unknown> {
  const payload: Record<string, unknown> = { storyId, itemId: item.id };
  if (need?.missingUserSees) payload.userSees = `<exact text the user sees once ${item.id} is done (quote outputs exactly)>`;
  const touchesIntent = Boolean(need?.missingLanes.length || need?.unpinned.length || need?.missingDerivations.length || literals.length || coverage.length);
  if (!touchesIntent) return payload;
  const patches = new Map<string, Record<string, unknown>>();
  const patchOf = (lane: string, index: number): Record<string, unknown> => {
    const ref = `${item.id}:${lane}:${index}`;
    if (!patches.has(ref)) patches.set(ref, { ref });
    return patches.get(ref)!;
  };
  for (const entry of need?.unpinned ?? []) {
    patchOf(entry.lane, entry.index).verification = { command: `<pinned test command for ${item.id}:${entry.lane}:${entry.index}, e.g. go test -v ./pkg -run ^TestName$>`,
      selector: '<line its passing run prints, e.g. --- PASS: TestName>' };
  }
  for (const entry of need?.missingDerivations ?? []) patchOf(entry.lane, entry.index).derivation = derivationPlaceholder(entry);
  const appended: Array<Record<string, unknown>> = [];
  for (const lane of need?.missingLanes ?? []) appended.push({ ref: appendRowRef(item.id, lane), ...placeholderIntentRow(`<${item.id} ${lane}: action or condition -> exact expected result>`) });
  for (const row of coverage) appended.push({ ref: appendRowRef(item.id, 'edge'), ...row });
  if (literals.length) {
    appended.push({ ref: appendRowRef(item.id, 'edge'), ...placeholderIntentRow(`<input -> exact output naming each unstated request literal ${item.id} delivers, quoted exactly; drop this row if ${item.id} delivers none>`) });
  }
  payload.intentRows = [...patches.values(), ...appended];
  // Lab round-cut N4c: built from the current rows; refused if they change before it is applied.
  payload.intentBasis = intentBasisDigest(item.verificationIntent);
  return payload;
}

/**
 * Checklist_update calls of several PLAN lints on the same item as ONE call: their intentRows concatenated (two
 * patches of one row merged into one patch; appends kept in order), the other fields kept (the first intentBasis /
 * userSees wins; two placeholder reasons are joined). A whole-intent call is never merged. Other commands keep
 * their order after the merged calls.
 */
export function mergeChecklistUpdateCalls(calls: ReadonlyArray<Call>): Call[] {
  const merged = new Map<string, Call>();
  const rest: Call[] = [];
  const placeholder = (value: unknown): value is string => typeof value === 'string' && /^<[\s\S]*>$/.test(value.trim());
  for (const call of calls) {
    const rows = call.payload.intentRows;
    if (call.command !== 'checklist_update' || !Array.isArray(rows) || call.payload.verificationIntent !== undefined) { rest.push(call); continue; }
    const key = String(call.payload.itemId);
    const into = merged.get(key);
    if (!into) { merged.set(key, { command: call.command, payload: { ...call.payload, intentRows: (rows as Array<Record<string, unknown>>).map(row => ({ ...row })) } }); continue; }
    const target = into.payload.intentRows as Array<Record<string, unknown>>;
    for (const row of rows as Array<Record<string, unknown>>) {
      const same = typeof row.ref === 'string' && !row.ref.endsWith(':+') ? target.find(entry => entry.ref === row.ref) : undefined;
      if (same) Object.assign(same, row); else target.push({ ...row });
    }
    if (placeholder(into.payload.reason) && placeholder(call.payload.reason) && into.payload.reason !== call.payload.reason) {
      into.payload.reason = `<${into.payload.reason.trim().slice(1, -1)}; ${call.payload.reason.trim().slice(1, -1)}>`;
    }
    for (const [field, value] of Object.entries(call.payload)) if (field !== 'intentRows' && into.payload[field] === undefined) into.payload[field] = value;
  }
  return [...merged.values(), ...rest];
}

/**
 * The PLAN lints due on the Story's checklist now, at once, for the owner while it still authors INIT (story_create)
 * or PLAN (checklist_update): the pre-scope authoring blockers (missing lanes, unpinned rows, missing userSees,
 * missing derivations, unstated request literals, coverage rows), exact whole-error pins, rows contradicting a
 * request example and, with plan.counterpartCoverage=on, uncovered counterpart cases. One text block, its ONE
 * Next the merged row patches (one checklist_update per item); null when nothing is due.
 */
export function planLintPreview(args: { store: StoryStore; root: string; storyId: string }): string | null {
  const { store, root, storyId } = args;
  const story = store.readStory(storyId);
  const items = store.readChecklist(storyId).items.filter(item => item.status !== 'withdrawn');
  if (!items.length) return null;
  const request = readStoryRequest(store, storyId);
  const requestText = request.status === 'ok' ? request.text : null;
  const policy = resolveWorkflowPolicy(loadConfig(root), story);
  const blockers = planPreScopeBlockers(store, story, policy);
  const findings: string[] = [];
  const calls: Call[] = [];
  const byId = new Map(blockers.items.map(row => [row.itemId, row]));
  for (const item of items) {
    const need = byId.get(item.id);
    const coverage = coverageIntentRows(blockers.coverageGaps, item.id);
    if (!need && !blockers.unmappedLiterals.length && !coverage.length) continue;
    const payload = preScopeItemPayload(storyId, item, need, coverage, blockers.unmappedLiterals);
    if (Object.keys(payload).length > 2) calls.push({ command: 'checklist_update', payload });
    const parts = [
      need?.missingLanes.length ? `missing ${need.missingLanes.join('/')} intent` : '',
      need?.unpinned.length ? `unpinned ${need.unpinned.map(entry => entry.ref).join(', ')}` : '',
      need?.missingUserSees ? 'missing userSees' : '',
      need?.missingDerivations.length ? `missing derivation ${need.missingDerivations.map(entry => entry.ref).join(', ')}` : '',
      coverage.length ? `${coverage.length} coverage row(s)` : '',
    ].filter(Boolean);
    if (parts.length) findings.push(`${item.id}: ${parts.join('; ')} [plan_authoring]`);
  }
  if (blockers.unmappedLiterals.length) {
    findings.push(`request literals no row or userSees states yet: ${blockers.unmappedLiterals.slice(0, 20).map(literal => `\`${literal}\``).join(', ')}${blockers.unmappedLiterals.length > 20 ? ` (+${blockers.unmappedLiterals.length - 20} more)` : ''} `
      + '(state each in the item that delivers it; drop the appended row of an item that delivers none) [plan_authoring]');
  }
  const exact = exactWholeErrorPins(items, requestText);
  for (const pin of exact) {
    findings.push(`${pin.ref} pins the exact whole error text \`${pin.message.slice(0, 80)}\`; pin what the request states about the error (its message or the prefix it quotes), unless the request demands the whole text [exact_error_pin]`);
    calls.push({ command: 'checklist_update', payload: { storyId, itemId: pin.itemId, intentRows: [{ ref: pin.ref, desc: `<${pin.ref} pinning the error message as the request states it (the message or the prefix the request quotes), not the whole rendered error text>` }],
      reason: '<why: the request sentence on the error format>' } });
  }
  for (const row of requestPinFindings(items, requestText).filter(entry => entry.kind === 'contradiction')) {
    findings.push(`${row.ref} pins \`${row.pinned.slice(0, 60)}\` but the request says: "${row.sentence.slice(0, 200)}" [request_pin]`);
    calls.push({ command: 'checklist_update', payload: { storyId, itemId: row.itemId, intentRows: [{ ref: row.ref, desc: `<${row.ref} pinned as the request sentence decides: "${row.sentence.slice(0, 160)}">`,
      derivation: { requestQuote: '<that request sentence, verbatim>', computation: '<the steps from it to the pinned value>' } }], reason: '<why: the request sentence that decides the case>' } });
  }
  const counterpart = (() => { try { return planCounterpartCoverage(store, root, storyId, root); } catch { return null; } })();
  for (const refusal of counterpart?.refusals ?? []) {
    findings.push(`${refusal.itemId} adds ${refusal.operation}; the same receiver's counterpart ${refusal.counterpart} special-cases cases no row covers [counterpart_coverage_missing]`);
    calls.push({ command: 'checklist_update', payload: counterpartNextPayload(storyId, items.find(item => item.id === refusal.itemId), refusal) });
  }
  if (!findings.length) return null;
  const merged = mergeChecklistUpdateCalls(calls);
  return [
    `PLAN pre-check (the deterministic lints PLAN runs before the scope-plan reviewer; ${findings.length} due now, all at once; fix them now in one pass and PLAN will not stop for them):`,
    ...findings.map(line => `- ${line}`),
    ...merged.map((call, index) => `${index === 0 ? 'Next' : 'And'} (author every <...> field; a skippable lint's row may be dropped): proof-or-stop ${call.command} ${shellQuote(JSON.stringify(call.payload))}`),
  ].join('\n');
}
