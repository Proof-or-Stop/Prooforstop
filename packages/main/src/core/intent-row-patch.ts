/**
 * Old-PoS run 37 (bench-staging/oldpos/run37-a2-analysis.md §3 item 3):
 * `checklist_update` took only the whole verificationIntent, so every one-row
 * fix was a hand-built `checklist_get | jq '.edge[3].desc = ...' |
 * checklist_update` pipeline (26 jq invocations in run 37's owner transcript)
 * that re-sent the complete intent.
 *
 * `intentRows: [{ ref, ...fields }]` patches single rows of the item's current
 * verificationIntent. `ref` is the row ref (`CHK-002:edge:3`) or the row's own
 * `id`; every other key replaces that field of the row (`null` removes an
 * optional field). The handler expands the patch into the complete intent and
 * then runs every check a whole-intent write runs (phase freeze, derivation,
 * classification, pin allowlist, pin oracle, planned-path declarations, the
 * identity / integrity of the stored checklist): a row patch is never a
 * weaker write. Refusals name ONE next action.
 *
 * Lab initplan (initplan-breakdown.md rank 6, run 80: 28 owner requests with
 * mktemp / jq / apply_patch to add covering rows): `ref: "<CHK>:<lane>:+"`
 * APPENDS a new row to that lane (its other keys are the row; `desc` is
 * required). Appended rows get the next indexes in patch order, so the refs of
 * existing rows never shift. An item without rows takes appends only.
 *
 * Lab run95 (bench-staging/oldpos/run93-96-analysis.md §5.2, fix 1b): `{"ref":"<row>","drop":true}`
 * was accepted and printed "verificationIntent updated" while the row only gained a `drop` field (run 95:
 * 4.4 min until the owner noticed, inside a seven-round scope-plan dispute). Now:
 *   - `{ref, remove: true}` REMOVES the row (`drop: true` is the same op); nothing else may ride on it. The
 *     later rows of that lane move up one index (the result names each move); a removal whose shift would
 *     re-point recorded verification evidence is refused (a whole-intent write re-binds it).
 *   - a field that is not a verificationIntent row field (cli/command-schemas.ts verificationIntentItemSchema)
 *     is refused, never written: the refusal names the allowed fields and ONE corrected command.
 */
import type { ChecklistItem, VerificationIntent } from './types.js';
import { VERIFICATION_LANES } from './verification.js';
import { shellQuote } from './shell-quote.js';

export const INTENT_ROWS_INVALID = 'intent_rows_invalid';

/**
 * The fields a row patch may set (the verificationIntent row schema, cli/command-schemas.ts
 * verificationIntentItemSchema, without `id`: rows are re-identified only by a whole-intent write).
 * run95-fixes-smoke R2 keeps this list equal to the schema's keys.
 */
export const INTENT_ROW_FIELDS = ['desc', 'type', 'requiredIn', 'priority', 'scope', 'expectation', 'requirementSource', 'baselineRef', 'requirementRef',
  'derivation', 'baseValue', 'plannedPathDeclarations', 'verification'] as const;
/** Lab run95: the row-remove op (`drop` is the word run 95's owner reached for first; both mean remove). */
export const INTENT_ROW_REMOVE_KEYS = ['remove', 'drop'] as const;

export interface IntentRowPatch { ref: string; [field: string]: unknown }

const LANE_REF = /^(CHK-\d+):([a-z]+):(\d+)$/;
/** Lab initplan: `CHK-NNN:<lane>:+` appends a row to that lane. */
const APPEND_REF = /^(CHK-\d+):([a-z]+):\+$/;

/** The ref that appends a row to an item's lane (`CHK-002:edge:+`). */
export function appendRowRef(itemId: string, lane: string): string {
  return `${itemId}:${lane}:+`;
}

/** Every row ref of an item, in lane order (`CHK-001:happy:0`, ...). */
export function intentRowRefs(item: Pick<ChecklistItem, 'id' | 'verificationIntent'>): string[] {
  return VERIFICATION_LANES.flatMap(lane => (item.verificationIntent?.[lane] ?? []).map((_row, index) => `${item.id}:${lane}:${index}`));
}

function refuse(detail: string, next: string): never {
  throw new Error(`checklist_update REFUSED, nothing was written: ${detail} [${INTENT_ROWS_INVALID}]\nNext: ${next}`);
}

/**
 * The item's complete verificationIntent with `patches` applied (pure). The
 * caller passes it on as `verificationIntent`, so every intent check runs.
 */
export function applyIntentRowPatches(args: { storyId: string; item: Pick<ChecklistItem, 'id' | 'verificationIntent'> & Partial<Pick<ChecklistItem, 'verificationEvidence'>>; patches: unknown;
  withWholeIntent: boolean; withProposalApproval: boolean }): { verificationIntent: VerificationIntent; refs: string[]; patchRefs: string[]; removed: string[]; moved: Array<{ from: string; to: string }> } {
  const { storyId, item } = args;
  const command = (payload: Record<string, unknown>) => `proof-or-stop checklist_update ${shellQuote(JSON.stringify(payload))}`;
  const refs = intentRowRefs(item);
  const example = { ref: refs[0] ?? `${item.id}:happy:0`, desc: '<input> -> <expected>' };
  if (args.withWholeIntent) {
    refuse('pass either verificationIntent (the whole intent) or intentRows (a row patch), not both',
      command({ storyId, itemId: item.id, intentRows: Array.isArray(args.patches) ? args.patches : [example] }));
  }
  if (args.withProposalApproval) {
    refuse('an intentProposalApproval binds the exact bytes of a whole verificationIntent; a row patch cannot carry it',
      `proof-or-stop checklist_get '${JSON.stringify({ storyId, itemId: item.id })}' and approve the complete proposed verificationIntent`);
  }
  const appendsOnly = Array.isArray(args.patches) && args.patches.length > 0
    && (args.patches as unknown[]).every(raw => raw && typeof raw === 'object' && typeof (raw as Record<string, unknown>).ref === 'string' && APPEND_REF.test(String((raw as Record<string, unknown>).ref).trim()));
  if ((!item.verificationIntent || refs.length === 0) && !appendsOnly) {
    refuse(`${item.id} has no verificationIntent rows to patch (append one with ${item.id}:<lane>:+)`,
      command({ storyId, itemId: item.id, intentRows: [{ ref: appendRowRef(item.id, 'happy'), desc: '<input> -> <expected>' }] }));
  }
  if (!Array.isArray(args.patches) || args.patches.length === 0) {
    refuse('intentRows must list at least one {ref, <field>: <value>} row patch', command({ storyId, itemId: item.id, intentRows: [example] }));
  }
  const intent = structuredClone(item.verificationIntent ?? { happy: [], edge: [], adversarial: [] }) as VerificationIntent;
  for (const lane of VERIFICATION_LANES) if (!Array.isArray(intent[lane])) (intent as unknown as Record<string, unknown[]>)[lane] = [];
  const seen = new Set<string>();
  /** Lab run95: unknown row fields are refused (run 95's `drop` field was written and the row stayed). */
  const refuseUnknownFields = (ref: string, patch: Record<string, unknown>, fields: readonly string[]): void => {
    const unknown = fields.filter(field => !(INTENT_ROW_FIELDS as readonly string[]).includes(field));
    if (!unknown.length) return;
    const kept = Object.fromEntries(Object.entries(patch).filter(([field]) => !unknown.includes(field)));
    refuse(`the patch of ${ref} sets ${unknown.map(field => `"${field}"`).join(', ')}, which ${unknown.length > 1 ? 'are not row fields' : 'is not a row field'} (a row has: ${INTENT_ROW_FIELDS.join(', ')}; {"ref":"<row>","remove":true} removes a row)`,
      command({ storyId, itemId: item.id, intentRows: [Object.keys(kept).length > 1 ? kept : { ref, desc: '<new desc>' }] }));
  };
  const removals: Array<{ lane: (typeof VERIFICATION_LANES)[number]; index: number; ref: string; at: number }> = [];
  const patched: string[] = [];
  const appended: Array<{ lane: (typeof VERIFICATION_LANES)[number]; row: Record<string, unknown>; at: number }> = [];
  /** The resulting row ref of each patch, in patch order (an append gets its new index). */
  const patchRefs: string[] = [];
  for (const [at, raw] of (args.patches as unknown[]).entries()) {
    const patch = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    const ref = typeof patch?.ref === 'string' ? patch.ref.trim() : '';
    const append = ref.match(APPEND_REF);
    if (patch && append) {
      if (append[1] !== item.id || !(VERIFICATION_LANES as readonly string[]).includes(append[2]!)) {
        refuse(`${ref} does not append to a lane of ${item.id} (lanes: ${VERIFICATION_LANES.join(', ')})`,
          command({ storyId, itemId: item.id, intentRows: [{ ...patch, ref: appendRowRef(item.id, 'edge') }] }));
      }
      const { ref: _ref, ...row } = patch;
      if (Object.keys(row).some(key => (INTENT_ROW_REMOVE_KEYS as readonly string[]).includes(key))) {
        refuse(`${ref} appends a row; there is no stored row to remove (leave the append out of the patch)`, command({ storyId, itemId: item.id, intentRows: [{ ref: refs[0] ?? `${item.id}:edge:0`, remove: true }] }));
      }
      refuseUnknownFields(ref, patch, Object.keys(row).filter(key => key !== 'id'));
      for (const key of Object.keys(row)) if (row[key] === null) delete row[key];
      if (typeof row.desc !== 'string' || !row.desc.trim()) {
        refuse(`the new row ${ref} has no desc`, command({ storyId, itemId: item.id, intentRows: [{ ...patch, desc: '<input> -> <expected>' }] }));
      }
      appended.push({ lane: append[2] as (typeof VERIFICATION_LANES)[number], row, at });
      continue;
    }
    let lane: (typeof VERIFICATION_LANES)[number] | undefined;
    let index = -1;
    const byRef = ref.match(LANE_REF);
    if (byRef && byRef[1] === item.id && (VERIFICATION_LANES as readonly string[]).includes(byRef[2]!)) {
      lane = byRef[2] as (typeof VERIFICATION_LANES)[number];
      index = Number(byRef[3]);
      if (!intent[lane]?.[index]) lane = undefined;
    } else if (ref) {
      for (const candidate of VERIFICATION_LANES) {
        const found = (intent[candidate] ?? []).findIndex(row => row.id === ref);
        if (found >= 0) { lane = candidate; index = found; break; }
      }
    }
    if (!patch || !lane) {
      refuse(`${ref ? `${ref} is not a row of ${item.id}` : 'a row patch has no ref'} (rows: ${refs.join(', ')})`,
        command({ storyId, itemId: item.id, intentRows: [{ ...(patch ?? {}), ref: `<one of ${refs.join(' | ')}>` }] }));
    }
    const key = `${lane}:${index}`;
    if (seen.has(key)) refuse(`${ref} is patched twice in one call`, command({ storyId, itemId: item.id, intentRows: [{ ...patch, ref }] }));
    seen.add(key);
    const fields = Object.keys(patch).filter(field => field !== 'ref');
    // Lab run95: the row-remove op. Only `ref` and the op itself; the row goes, later rows of the lane move up.
    const removeKeys = fields.filter(field => (INTENT_ROW_REMOVE_KEYS as readonly string[]).includes(field));
    if (removeKeys.length) {
      if (removeKeys.some(field => patch[field] !== true) || fields.length !== removeKeys.length) {
        refuse(`the remove op of ${ref} takes only {"ref","remove":true} (a row is either removed or patched, not both)`, command({ storyId, itemId: item.id, intentRows: [{ ref, remove: true }] }));
      }
      removals.push({ lane, index, ref: `${item.id}:${lane}:${index}`, at });
      patchRefs[at] = `${item.id}:${lane}:${index}`;
      continue;
    }
    if (fields.length === 0) refuse(`the patch of ${ref} changes no field`, command({ storyId, itemId: item.id, intentRows: [{ ref, desc: '<new desc>' }] }));
    if (fields.includes('id')) refuse(`the patch of ${ref} changes the row id (rows are re-identified only by a whole-intent write)`, command({ storyId, itemId: item.id, intentRows: [{ ...patch, id: undefined }] }));
    refuseUnknownFields(ref, patch, fields);
    const row = { ...(intent[lane][index] as unknown as Record<string, unknown>) };
    for (const field of fields) {
      if (patch[field] === null) delete row[field];
      else row[field] = patch[field];
    }
    (intent[lane] as unknown as Array<Record<string, unknown>>)[index] = row;
    patched.push(`${item.id}:${lane}:${index}`);
    patchRefs[at] = `${item.id}:${lane}:${index}`;
  }
  // Lab run95: removals after the in-place patches (those were addressed by the stored indexes), before the appends.
  const removed: string[] = [];
  const moved: Array<{ from: string; to: string }> = [];
  if (removals.length) {
    const evidenceRefs = new Set((args.item.verificationEvidence ?? []).map(row => String(row.intentRef ?? '')));
    for (const lane of VERIFICATION_LANES) {
      const gone = new Set(removals.filter(row => row.lane === lane).map(row => row.index));
      if (!gone.size) continue;
      const rows = intent[lane] as unknown as Array<Record<string, unknown>>;
      const first = Math.min(...gone);
      const shifted = rows.map((_row, index) => `${item.id}:${lane}:${index}`).filter((ref, index) => index >= first && evidenceRefs.has(ref));
      if (shifted.length) {
        refuse(`removing ${[...gone].map(index => `${item.id}:${lane}:${index}`).join(', ')} would re-point the recorded verification evidence of ${shifted.join(', ')} (its row index moves); `
          + 'send the complete verificationIntent and re-bind that evidence instead', `proof-or-stop checklist_get '${JSON.stringify({ storyId, itemId: item.id })}'`);
      }
      let to = 0;
      const kept: Array<Record<string, unknown>> = [];
      rows.forEach((row, index) => {
        if (gone.has(index)) { removed.push(`${item.id}:${lane}:${index}`); return; }
        if (to !== index) moved.push({ from: `${item.id}:${lane}:${index}`, to: `${item.id}:${lane}:${to}` });
        kept.push(row);
        to += 1;
      });
      (intent as unknown as Record<string, unknown[]>)[lane] = kept;
      for (const [position, ref] of patched.entries()) {
        const shift = moved.find(row => row.from === ref);
        if (shift) patched[position] = shift.to;
      }
      for (const [position, ref] of patchRefs.entries()) {
        const shift = ref ? moved.find(row => row.from === ref) : undefined;
        if (shift) patchRefs[position] = shift.to;
      }
    }
  }
  // Appends after every in-place patch, in patch order: existing refs keep their indexes.
  for (const { lane, row, at } of appended) {
    (intent[lane] as unknown as Array<Record<string, unknown>>).push(row);
    patched.push(`${item.id}:${lane}:${intent[lane].length - 1}`);
    patchRefs[at] = `${item.id}:${lane}:${intent[lane].length - 1}`;
  }
  return { verificationIntent: intent, refs: patched, patchRefs, removed, moved };
}

/** Lab run95: the result line of a row patch (patched / appended rows, removed rows, the index moves a removal made). */
export function intentRowPatchNote(result: { refs: readonly string[]; removed?: readonly string[]; moved?: ReadonlyArray<{ from: string; to: string }> }): string {
  const parts = [
    result.refs.length ? `rows ${result.refs.join(', ')}` : '',
    result.removed?.length ? `removed ${result.removed.join(', ')}` : '',
    result.moved?.length ? `renumbered ${result.moved.map(row => `${row.from} -> ${row.to}`).join(', ')}` : '',
  ].filter(Boolean);
  return parts.length ? ` (${parts.join('; ')})` : '';
}
