/**
 * The verbatim request outranks owner-authored intents (old-PoS run 23).
 *
 * Run 23 shipped a wrong behavior because the owner pinned a wrong expected
 * value in a verification intent at INIT (a value the request's own stated
 * rule contradicts: the request said the new operation follows an existing
 * one's semantics, the pin did not). The
 * implementer, two REVIEW lanes and the inventory critic each computed the
 * contradiction and deferred to the intent ("the checklist is the requirement
 * source"; the critic filed it as a "limitation (not a finding)").
 *
 * This module holds the shared texts and parsers of the fix:
 *   D1 implementer / finding-repair return contract: a mandatory
 *      `[intent-conflict]` section, parsed from the managed run's final result
 *      (parseIntentConflicts); `next` turns a non-empty one into a blocking
 *      owner step (handlers/next-driver.ts, intentConflictStep).
 *   D2 every REVIEW lane and the inventory critic get the verbatim request
 *      inline plus REQUEST_OUTRANKS_INTENT_RUBRIC (renderReviewRequestAuthority).
 *   D3 the critic may not demote a request contradiction to a note
 *      (CRITIC_REQUEST_CONTRADICTION_RULE).
 *   F3 a repair that changes how an input is handled keeps base behavior for
 *      the input variants the request did not change (REPAIR_INPUT_VARIANT_RULE).
 */
import { readStoryRequest } from './story-request.js';
import type { StoryStore } from './store.js';
import { requestExactStrings } from './plan-coverage-matrix.js';

const TEST_COVERAGE_LANE = 'proof-or-stop-review-test-coverage';

export const INTENT_CONFLICT_TAG = '[intent-conflict]';

/** D2 rubric, shared by every REVIEW lane and the inventory critic (like REVIEW_SEVERITY_RUBRIC). */
export const REQUEST_OUTRANKS_INTENT_RUBRIC = 'Request authority rubric: the verbatim request above outranks the checklist. Intents, userSees, context and pinned tests are owner-authored and can be wrong. For every behavior the request specifies, re-derive the expected value from the request text yourself (compute it; do not copy it from an intent or test). A pinned intent, userSees or test assertion that contradicts the request is a finding of at least medium severity against that intent and test, even when the test passes. "The checklist is the requirement source" or "the intent pins it" never resolves a contradiction with the request. Follow the intent only where the request is silent.';

/** D3: the inventory critic's escape hatch for request contradictions is closed. */
export const CRITIC_REQUEST_CONTRADICTION_RULE = 'Critic request rule: a divergence between the implementation, a pinned intent or a test and a request sentence is a finding (at least medium), never a note, a "limitation" or "not a finding". When you claim two readings of the request agree on a pinned case, show both computed outputs side by side; if they differ, report it as a finding.';

/** D1: the mandatory return section of the implementer and the finding-repair worker. */
export const INTENT_CONFLICT_RETURN_CONTRACT = [
  'Intent-conflict section (mandatory, the framework parses it from your final result):',
  `- End your final result with \`${INTENT_CONFLICT_TAG} none\` when no pinned expectation (verificationIntent, userSees, context or an existing test) contradicts the request.`,
  `- Otherwise write one line per conflict: \`${INTENT_CONFLICT_TAG} <intentRef, e.g. CHK-004:happy:3> | request: "<the request sentence you rely on>" | request implies: <value the request gives> | intent pins: <value the intent pins>\`.`,
  '- The request outranks the intent. Never resolve a conflict silently: a "deliberate choice" that follows an intent over the request, or that deviates from the request in any other way, must be listed here; prose notes are not read. The Story owner amends the intent before the item counts done.',
].join('\n');

/**
 * Old-PoS run 31 (REM2): a repair worker shipped a Go test that parsed the
 * Story's checklist.json. Product code and tests never touch PoS metadata; the
 * scope gate refuses it [scope_story_metadata_reference].
 */
export const PRODUCT_CODE_NO_POS_METADATA_RULE = '- PoS metadata is not product input: never read or reference `.proof-or-stop/` (checklist.json, findings, request.md) from product code or tests, and never commit a test that checks checklist text. A wrong userSees/intent text is the Story owner\'s checklist correction: report it (an `[intent-conflict]` line) instead of testing it; REVIEW entry refuses a product change that references this Story\'s metadata.';

/** F3: base-behavior check of the finding's input variants (run 24 explicit-null regression). */
export const REPAIR_INPUT_VARIANT_RULE = '- Input variants (keep base behavior): when the fix changes how an input is handled (null, 0, negative, empty, omitted vs explicit, default), list the finding\'s input and its literal variants (for example explicit `null` vs an omitted operand, 0, a negative value, empty). Run each variant on the Story base and on your fix, keep the base behavior for every variant the request did not change, and add a test for each kept variant. Test what the source wrote (the syntax node), not only the evaluated value: an explicit `null` and an omitted operand can evaluate alike. A reviewer\'s "Fix:" text is a non-binding suggestion; follow it only when it passes this check.';

/**
 * Old-PoS runs 24-29 (run28-29-analysis.md §5.1 A): the implementer self-check.
 * Three of four distinct code defects of runs 28/29 were a value class at a new
 * operand position crashing or confused on one operation (explicit null vs
 * omitted, an all-omitted form, a read-side error panicking on a write), and 29/F-004 an
 * aliased right-hand side; only the finding-repair prompt carried the variant
 * rule, so each surfaced in REVIEW and cost a finding round.
 * Run 30: an explicit operand equal to its default took another form's path
 * (F-004: no "explicit value equal to the default" class), and a probed row was
 * tested on one syntax form only (F-002): decided rows need a test, and the `[probes]`
 * line separates tested from probed-only rows (probeTestGaps).
 * Run 31: a write reached only a bare identifier target (F-003: member and
 * nested targets were no-ops) and one write form took an explicit null as
 * omitted after another form was fixed (F-008): the Writes line names both.
 * With a project probeRunner the
 * framework runs the item's rows instead (core/request-probes.ts) and this
 * matrix text is not sent.
 */
export const PROBE_REPORT_TAG = '[probes]';
/**
 * Old-PoS run 33 (run33-analysis.md §2.3): the one line kept from the
 * implementer probe matrix when implementation.probeMatrix is off (default).
 * The matrix block cost run 31 56 of 171 implementer turns and found no defect;
 * these two classes (panic on a valid form, explicit null read as omitted) were
 * the ones review found in runs 24-31.
 */
export const IMPLEMENTER_PROBE_LINE = '- No valid input form may crash or panic, and an explicit null/nil operand is a different input from an omitted one (branch on the source syntax, not the evaluated value).';

export const IMPLEMENTER_PROBE_MATRIX = [
  'Probe matrix before handoff (operand position x value class x operation):',
  '- Positions: each operand or parameter the item reads or adds. Classes: omitted, explicit null, explicit value equal to the default (it keeps its own form\'s semantics, not another form\'s path), 0, negative, out of range, non-numeric/wrong type, empty input, non-ASCII text, a target aliased by the value. Operations: read, write/assign, print/stringify, error path, neighbouring input types.',
  '- Writes: the written target as a bare identifier, a member/property, a nested element and a call result; and every syntax form the item adds, each with explicit null operands (each form has its own path).',
  '- Keep the rows that apply to this item. Run each as a probe (one-line program or test) on the Story base and on your change. Keep the base result where the request did not change it; no row may crash, panic or reach an unchecked type assertion. Omitted and explicit null are different rows: branch on the source syntax, not the evaluated value. Each row your change decides (new result, or one the request states) needs a test, not only a probe; an untested decided row reopens the item before REVIEW.',
  `- Report in your final result: \`${PROBE_REPORT_TAG} <n> rows run on base and change; changed: <row: base -> new> | none; tested: <decided rows with a test> | none; probed-only: <decided rows without a test> | none; crashes: none\`.`,
].join('\n');

/** The `probed-only:` rows of a `[probes]` line (null when none or absent). */
export function parseProbeReport(text: string | null | undefined): { present: boolean; probedOnly: string | null } {
  const line = (text ?? '').split(/\r?\n/).filter(row => row.includes(PROBE_REPORT_TAG)).at(-1);
  if (!line) return { present: false, probedOnly: null };
  const match = line.match(/\bprobed-only:\s*(.*?)\s*(?:;\s*crashes:|$)/i);
  const rows = match?.[1]?.trim().replace(/[;.]\s*$/, '') ?? '';
  return { present: true, probedOnly: rows && !/^(?:none|<[^>]*>)$/i.test(rows) ? rows : null };
}

export interface ProbeReportRun { runId: string; itemId: string; createdAt: string; text: string | null }
export interface ProbeTestGap { itemId: string; runId: string; probedOnly: string }

/**
 * Old-PoS run 30 (F-002 / F-004): decided rows the implementer probed but did
 * not test. Per done item, its latest implementer run's `probed-only` rows;
 * none when an earlier run of the item reported the same rows (the relaunch
 * made no progress: REVIEW judges them, the framework does not loop).
 */
export function probeTestGaps(runs: readonly ProbeReportRun[], doneItemIds: ReadonlySet<string>): ProbeTestGap[] {
  const gaps: ProbeTestGap[] = [];
  for (const itemId of new Set(runs.map(run => run.itemId))) {
    if (!doneItemIds.has(itemId)) continue;
    const mine = runs.filter(run => run.itemId === itemId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const latest = parseProbeReport(mine.at(-1)!.text).probedOnly;
    if (!latest) continue;
    if (mine.slice(0, -1).some(run => parseProbeReport(run.text).probedOnly === latest)) continue;
    gaps.push({ itemId, runId: mine.at(-1)!.runId, probedOnly: latest });
  }
  return gaps;
}

/** The relaunch prompt line for an item reopened by a probe-test gap. */
export function renderProbeTestGapLine(gap: Pick<ProbeTestGap, 'runId' | 'probedOnly'>): string {
  return `- Earlier implementer run ${gap.runId} of this item decided rows it did not test (probed-only: ${gap.probedOnly}). Add a test for each (change the code only where a test fails) and list them under tested.`;
}

/**
 * D2: the verbatim request (already bounded to 16 KB by story_create /
 * story_request_set) plus the rubric, for a REVIEW lane or the inventory critic
 * dispatch prompt. A Story without request.md adds no prompt bytes.
 */
/**
 * Old-PoS run 30 (F-001): the test-coverage lane's rule for strings the request
 * says must match exactly (only when the request quotes such strings).
 */
export function renderExactTextRubric(requestText: string): string[] {
  const strings = [...new Set(requestExactStrings(requestText).map(row => row.literal))];
  if (!strings.length) return [];
  return [`Exact-text rubric: the request says these strings must match exactly: ${strings.slice(0, 8).map(text => `\`${text}\``).join(', ')}${strings.length > 8 ? ` +${strings.length - 8} more` : ''}. A test that asserts one by prefix / contains / regex (e.g. a shared helper using strings.HasPrefix) is a finding: it still passes with text appended.`];
}

export function renderReviewRequestAuthority(store: StoryStore, storyId: string, opts: { critic?: boolean; lane?: string } = {}): string[] {
  const request = readStoryRequest(store, storyId);
  if (request.status === 'absent') return [];
  const rel = `${store.storyDirRel()}/${storyId}/request.md`;
  if (request.status === 'tampered') {
    return [`Verbatim request: ${rel} — ${request.reason}. Do not treat it as authoritative; report it to the Story owner in your note.`];
  }
  return [
    `Verbatim user request (${rel}, sha256=${request.meta.sha256.slice(0, 12)}${request.meta.truncated ? ', truncated at 16 KB' : ''}):`,
    '<<<REQUEST',
    request.text.replace(/\n$/, ''),
    'REQUEST>>>',
    REQUEST_OUTRANKS_INTENT_RUBRIC,
    ...(opts.critic ? [CRITIC_REQUEST_CONTRADICTION_RULE] : []),
    ...(opts.lane === TEST_COVERAGE_LANE ? renderExactTextRubric(request.text) : []),
  ];
}

export interface IntentConflict {
  /** As written, e.g. CHK-004:happy:3, or the bound item for an undeclared deviation. */
  intentRef: string;
  /** Checklist item the conflict targets (CHK-NNN), or null when none could be named. */
  itemId: string | null;
  requestSentence: string | null;
  requestImplies: string | null;
  intentPins: string | null;
  /** The raw line (or the deviation sentence for an undeclared deviation). */
  raw: string;
  /** True when the result declared no conflict but its prose states a deliberate deviation. */
  undeclared: boolean;
}

/**
 * Old-PoS run 37 (run37-a2-analysis.md §3 item 2): the pinned fragment an
 * `[intent-conflict]` names when its `intent pins` field is not a code literal
 * (e.g. an error message that quotes a value the request leaves unquoted): the
 * part of `intent pins` that differs from `request implies`, with the common
 * leading context (at most 60 characters, cut at a word boundary), so sibling
 * rows of other items that carry the same wrong pin can be found. Null when
 * either field is missing, the pin adds nothing to what the request implies,
 * or the fragment is shorter than 6 characters.
 */
export function conflictPinnedFragment(conflict: Pick<IntentConflict, 'intentPins' | 'requestImplies'>): string | null {
  const pins = conflict.intentPins?.trim();
  const implies = conflict.requestImplies?.trim();
  if (!pins || !implies || pins === implies) return null;
  let prefix = 0;
  while (prefix < pins.length && prefix < implies.length && pins[prefix] === implies[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < pins.length - prefix && suffix < implies.length - prefix && pins[pins.length - 1 - suffix] === implies[implies.length - 1 - suffix]) suffix += 1;
  const differing = pins.slice(prefix, pins.length - suffix);
  if (!differing.trim()) return null;
  let start = Math.max(0, prefix - 60);
  if (start > 0) { const space = pins.indexOf(' ', start); start = space >= 0 && space < prefix ? space + 1 : prefix; }
  const fragment = pins.slice(start, pins.length - suffix).trim();
  return fragment.length >= 6 ? fragment : null;
}

export interface IntentConflictReport {
  /** none: the section says none; declared: one or more conflicts; absent: no section. */
  section: 'none' | 'declared' | 'absent';
  conflicts: IntentConflict[];
}

const ITEM_REF = /\b(CHK-\d+)(?::[A-Za-z]+:\d+)?/;
/**
 * Prose that states a deliberate deviation from the request or a choice made
 * for a pinned intent (run 23: "Note on a deliberate choice: per the checklist
 * intent ..."). A "deliberate choice" sentence counts only when it also names
 * the intent, checklist, pin or request, so an ordinary design remark does not
 * send the Story back to PLAN.
 */
const DEVIATION_PROSE = /\bdeviat\w*\s+from\s+the\s+request\b|\bcontradict\w*\s+the\s+request\b|\bover\s+the\s+request\b/i;
const DELIBERATE_PROSE = /\bdeliberate(?:ly)?\s+(?:choice|deviation|decision)\b/i;
const AUTHORITY_WORD = /\b(?:intent|checklist|pinned|pins?|request|userSees|expected value)\b/i;
const isDeviationSentence = (sentence: string): boolean =>
  DEVIATION_PROSE.test(sentence) || (DELIBERATE_PROSE.test(sentence) && AUTHORITY_WORD.test(sentence));

function field(parts: string[], ...keys: string[]): string | null {
  for (const part of parts) {
    const match = part.match(/^\s*([a-z ]+?)\s*:\s*(.*)$/i);
    if (match && keys.includes(match[1]!.toLowerCase())) return match[2]!.trim().replace(/^"(.*)"$/, '$1') || null;
  }
  return null;
}

/**
 * Parse the `[intent-conflict]` section of an implementer / finding-repair final
 * result. `boundItemId` names the run's bound checklist item: an undeclared
 * deliberate deviation (prose only, section none or absent) is attributed to it.
 */
export function parseIntentConflicts(text: string | null | undefined, boundItemId: string | null = null): IntentConflictReport {
  const lines = (text ?? '').split(/\r?\n/);
  const conflicts: IntentConflict[] = [];
  let sawNone = false;
  for (const line of lines) {
    const at = line.indexOf(INTENT_CONFLICT_TAG);
    if (at < 0) continue;
    const body = line.slice(at + INTENT_CONFLICT_TAG.length).trim().replace(/^[:\-–—]\s*/, '');
    if (/^none\b/i.test(body) || body.length === 0) { sawNone = true; continue; }
    // A line that only restates the format (e.g. "<intentRef, ...>") is not a conflict.
    if (/^<intentRef/i.test(body)) continue;
    const parts = body.split(/\s+\|\s+/);
    const ref = parts[0]!.trim();
    const itemMatch = body.match(ITEM_REF);
    conflicts.push({
      intentRef: ref,
      itemId: itemMatch ? itemMatch[1]! : boundItemId,
      requestSentence: field(parts, 'request'),
      requestImplies: field(parts, 'request implies', 'implies'),
      intentPins: field(parts, 'intent pins', 'pins'),
      raw: line.trim(),
      undeclared: false,
    });
  }
  if (conflicts.length > 0) return { section: 'declared', conflicts };
  const deviation = boundItemId ? (text ?? '').split(/(?<=[.!?])\s+|\r?\n/).find(isDeviationSentence) : undefined;
  if (deviation) {
    return {
      section: sawNone ? 'none' : 'absent',
      conflicts: [{ intentRef: boundItemId!, itemId: boundItemId, requestSentence: null, requestImplies: null, intentPins: null,
        raw: deviation.trim().slice(0, 400), undeclared: true }],
    };
  }
  return { section: sawNone ? 'none' : 'absent', conflicts: [] };
}
