/**
 * B-17a9 CHK-001 (Experience Layer): pure backfill-decision leaf for
 * `signature_backfill`.
 *
 * `decideBackfill` answers, for a SINGLE finding, whether a committed signature
 * map entry should retroactively fill the finding's `signatureTag`. It is the
 * pure, deterministic core of the writing `signature_backfill` handler:
 *
 *   - It fills ONLY when the finding currently has no `signatureTag` (the empty /
 *     absent case) — or, with `opts.overwriteAuto`, when the existing tag is a
 *     low-quality `'auto'` fallback.
 *   - It NEVER overwrites a `'confirmed'` tag (a reviewer/LLM-supplied tag is
 *     real quality and sacrosanct), and never overwrites a non-empty tag of
 *     unknown provenance.
 *   - When it fills, the provenance is always `'backfill'` — never `'auto'` or
 *     `'confirmed'`.
 *
 * PURE: imports only types, performs no I/O, never mutates its inputs, and is
 * deterministic (identical inputs -> identical outputs). Architecturally this is
 * a leaf — keeping it free of fs/store/network is enforced by the verifier.
 */

import type { SignatureTagSource } from './experience-layer-types.js';

/** The decision actions `decideBackfill` can return. */
export type BackfillAction =
  | 'fill'
  | 'skip-no-mapping'
  | 'skip-empty-sig'
  | 'skip-confirmed'
  | 'skip-has-auto'
  | 'skip-nonempty';

/** Structured decision for a single finding. `signatureTag`/`signatureTagSource` are present only when `action==='fill'`. */
export interface BackfillDecision {
  action: BackfillAction;
  signatureTag?: string;
  signatureTagSource?: Extract<SignatureTagSource, 'backfill'>;
}

/** Tunables for the decision. `overwriteAuto` lets a backfill replace a low-quality `'auto'` tag. */
export interface BackfillOptions {
  /** When true, an existing `'auto'`-sourced tag is replaced by the mapped signature. Default false. */
  overwriteAuto?: boolean;
}

/**
 * Decide whether the mapped signature should backfill this finding's `signatureTag`.
 *
 * Order of precedence (the `'confirmed'` guard is the strongest invariant — it
 * holds even when `overwriteAuto` is on):
 *   1. no/empty mapped signature        => skip-no-mapping / skip-empty-sig
 *   2. current source === 'confirmed'   => skip-confirmed (never overwrite confirmed)
 *   3. current signatureTag is empty    => fill (source='backfill')
 *   4. current source === 'auto'        => overwriteAuto ? fill : skip-has-auto
 *   5. non-empty tag, other/legacy src  => skip-nonempty
 *
 * Pure & deterministic; never mutates `current` or `opts`.
 */
export function decideBackfill(
  current: { signatureTag?: string; signatureTagSource?: string },
  mappedSig: string | undefined,
  opts: BackfillOptions = {},
): BackfillDecision {
  // 1. No usable mapping for this finding — leave it untouched.
  const mapped = typeof mappedSig === 'string' ? mappedSig : undefined;
  if (mapped === undefined) return { action: 'skip-no-mapping' };
  if (mapped.length === 0) return { action: 'skip-empty-sig' };

  // 2. A confirmed tag is sacrosanct — never overwrite, even with overwriteAuto.
  if (current.signatureTagSource === 'confirmed') return { action: 'skip-confirmed' };

  // 3. Empty/absent current tag is the primary fill path.
  const currentTag = typeof current.signatureTag === 'string' ? current.signatureTag : '';
  if (currentTag.length === 0) {
    return { action: 'fill', signatureTag: mapped, signatureTagSource: 'backfill' };
  }

  // 4. A low-quality auto fallback is replaced only when explicitly opted in.
  if (current.signatureTagSource === 'auto') {
    return opts.overwriteAuto
      ? { action: 'fill', signatureTag: mapped, signatureTagSource: 'backfill' }
      : { action: 'skip-has-auto' };
  }

  // 5. Non-empty tag of unknown/legacy provenance — do not overwrite.
  return { action: 'skip-nonempty' };
}
