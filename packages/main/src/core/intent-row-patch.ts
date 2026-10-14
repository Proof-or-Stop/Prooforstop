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
 */
import type { ChecklistItem, VerificationIntent } from './types.js';
import { VERIFICATION_LANES } from './verification.js';
import { shellQuote } from './shell-quote.js';

export const INTENT_ROWS_INVALID = 'intent_rows_invalid';

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
export function applyIntentRowPatches(args: { storyId: string; item: Pick<ChecklistItem, 'id' | 'verificationIntent'>; patches: unknown;
  withWholeIntent: boolean; withProposalApproval: boolean }): { verificationIntent: VerificationIntent; refs: string[]; patchRefs: string[] } {
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
    if (fields.length === 0) refuse(`the patch of ${ref} changes no field`, command({ storyId, itemId: item.id, intentRows: [{ ref, desc: '<new desc>' }] }));
    if (fields.includes('id')) refuse(`the patch of ${ref} changes the row id (rows are re-identified only by a whole-intent write)`, command({ storyId, itemId: item.id, intentRows: [{ ...patch, id: undefined }] }));
    const row = { ...(intent[lane][index] as unknown as Record<string, unknown>) };
    for (const field of fields) {
      if (patch[field] === null) delete row[field];
      else row[field] = patch[field];
    }
    (intent[lane] as unknown as Array<Record<string, unknown>>)[index] = row;
    patched.push(`${item.id}:${lane}:${index}`);
    patchRefs[at] = `${item.id}:${lane}:${index}`;
  }
  // Appends after every in-place patch, in patch order: existing refs keep their indexes.
  for (const { lane, row, at } of appended) {
    (intent[lane] as unknown as Array<Record<string, unknown>>).push(row);
    patched.push(`${item.id}:${lane}:${intent[lane].length - 1}`);
    patchRefs[at] = `${item.id}:${lane}:${intent[lane].length - 1}`;
  }
  return { verificationIntent: intent, refs: patched, patchRefs };
}
