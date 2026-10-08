/**
 * The verbatim request outranks owner-authored intents (old-PoS run 23).
 *
 * Run 23 shipped a wrong behavior because the owner pinned a wrong expected
 * value in a verification intent at INIT ("a[::-1]=[9..4] -> [9..4]" while the
 * request says "Use the same index-selection semantics as read slicing"). The
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

/** F3: base-behavior check of the finding's input variants (run 24 explicit-null regression). */
export const REPAIR_INPUT_VARIANT_RULE = '- Input variants (keep base behavior): when the fix changes how an input is handled (null, 0, negative, empty, omitted vs explicit, default), list the finding\'s input and its literal variants (for example explicit `null` vs an omitted operand, 0, a negative value, empty). Run each variant on the Story base and on your fix, keep the base behavior for every variant the request did not change, and add a test for each kept variant. Test what the source wrote (the syntax node), not only the evaluated value: an explicit `null` and an omitted operand can evaluate alike. A reviewer\'s "Fix:" text is a non-binding suggestion; follow it only when it passes this check.';

/**
 * D2: the verbatim request (already bounded to 16 KB by story_create /
 * story_request_set) plus the rubric, for a REVIEW lane or the inventory critic
 * dispatch prompt. A Story without request.md adds no prompt bytes.
 */
export function renderReviewRequestAuthority(store: StoryStore, storyId: string, opts: { critic?: boolean } = {}): string[] {
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
