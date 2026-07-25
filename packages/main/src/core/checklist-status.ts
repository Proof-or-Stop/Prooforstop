import type { ChecklistStatus } from './types.js';

/**
 * B-1909 CHK-002: shared checklist-status predicates so every `status === 'done'`
 * consumer classifies the new terminal `'withdrawn'` disposition consistently
 * instead of scattering `=== 'done' || === 'withdrawn'` comparisons.
 *
 * Two orthogonal meanings a call site can want:
 *  - DELIVERED  — the item was actually completed successfully (`done` only).
 *                 Use for done/delivered/completed-success tallies. Withdrawn is
 *                 NEVER delivered.
 *  - TERMINAL   — the item will never move again and no longer blocks phase
 *                 advancement (`done` OR `withdrawn`). Use for
 *                 all-items-accounted-for / advancement / "still outstanding?"
 *                 checks.
 *
 * The param is typed loosely so loosely-typed call sites (session/hints summaries
 * carry `{ status: string }`) and optional-chained lookups (`map.get(id)?.status`,
 * which may be `undefined`) can call these directly. `ChecklistStatus` is the
 * canonical closed union; the loose signature accepts it and legacy/undefined.
 */
export type ChecklistStatusLike = ChecklistStatus | string | undefined | null;

/** True only for `'done'` — an item actually delivered / completed-success. */
export function isDeliveredChecklistStatus(status: ChecklistStatusLike): boolean {
  return status === 'done';
}

/** True for `'withdrawn'` — recorded undeliverable, terminal but NOT delivered. */
export function isWithdrawnChecklistStatus(status: ChecklistStatusLike): boolean {
  return status === 'withdrawn';
}

/**
 * True for any terminal disposition (`'done'` or `'withdrawn'`): the item is no
 * longer outstanding and does not block phase advancement. NOT a delivered/done
 * signal — a withdrawn item is terminal without being delivered.
 */
export function isTerminalChecklistStatus(status: ChecklistStatusLike): boolean {
  return status === 'done' || status === 'withdrawn';
}
