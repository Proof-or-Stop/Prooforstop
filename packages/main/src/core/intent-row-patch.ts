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
 */
import type { ChecklistItem, VerificationIntent } from './types.js';
import { VERIFICATION_LANES } from './verification.js';
import { shellQuote } from './shell-quote.js';

export const INTENT_ROWS_INVALID = 'intent_rows_invalid';

export interface IntentRowPatch { ref: string; [field: string]: unknown }

const LANE_REF = /^(CHK-\d+):([a-z]+):(\d+)$/;

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
  withWholeIntent: boolean; withProposalApproval: boolean }): { verificationIntent: VerificationIntent; refs: string[] } {
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
  if (!item.verificationIntent || refs.length === 0) {
    refuse(`${item.id} has no verificationIntent rows to patch`,
      command({ storyId, itemId: item.id, verificationIntent: '<the complete verificationIntent JSON>' }));
  }
  if (!Array.isArray(args.patches) || args.patches.length === 0) {
    refuse('intentRows must list at least one {ref, <field>: <value>} row patch', command({ storyId, itemId: item.id, intentRows: [example] }));
  }
  const intent = structuredClone(item.verificationIntent) as VerificationIntent;
  const seen = new Set<string>();
  const patched: string[] = [];
  for (const raw of args.patches as unknown[]) {
    const patch = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    const ref = typeof patch?.ref === 'string' ? patch.ref.trim() : '';
    let lane: (typeof VERIFICATION_LANES)[number] | undefined;
    let index = -1;
    const byRef = ref.match(LANE_REF);
    if (byRef && byRef[1] === item.id && (VERIFICATION_LANES as readonly string[]).includes(byRef[2]!)) {
      lane = byRef[2] as (typeof VERIFICATION_LANES)[number];
      index = Number(byRef[3]);
      if (!intent[lane]?.[index]) lane = undefined;
    } else if (ref) {
      for (const candidate of VERIFICATION_LANES) {
        const at = (intent[candidate] ?? []).findIndex(row => row.id === ref);
        if (at >= 0) { lane = candidate; index = at; break; }
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
  }
  return { verificationIntent: intent, refs: patched };
}
