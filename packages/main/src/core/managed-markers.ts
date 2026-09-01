/**
 * Managed Markdown block markers.
 *
 * New writes use the Proof-or-Stop spelling. Existing Lattice blocks remain
 * readable so init/check can migrate them in place. Parsing is deliberately
 * structural instead of a non-greedy regexp: an unmatched, mixed, nested, or
 * repeated block is ambiguous and must never be overwritten automatically.
 */

export const PROOF_OR_STOP_MANAGED_START = '<!-- proof-or-stop:start -->';
export const PROOF_OR_STOP_MANAGED_END = '<!-- proof-or-stop:end -->';
export const LEGACY_LATTICE_MANAGED_START = '<!-- lattice:start -->';
export const LEGACY_LATTICE_MANAGED_END = '<!-- lattice:end -->';

export const PROOF_OR_STOP_PROFILE_START = '<!-- proof-or-stop-profile:start -->';
export const PROOF_OR_STOP_PROFILE_END = '<!-- proof-or-stop-profile:end -->';
export const LEGACY_LATTICE_PROFILE_START = '<!-- lattice-profile:start -->';
export const LEGACY_LATTICE_PROFILE_END = '<!-- lattice-profile:end -->';

export type ManagedBlockKind = 'document' | 'profile';
export type ManagedMarkerFamily = 'canonical' | 'legacy';

export interface ManagedBlockMatch {
  startIndex: number;
  endIndex: number;
  text: string;
  family: ManagedMarkerFamily;
}

export type ManagedBlockInspection =
  | { status: 'missing' }
  | { status: 'valid'; block: ManagedBlockMatch }
  | { status: 'malformed'; reason: string };

interface MarkerToken {
  family: ManagedMarkerFamily;
  phase: 'start' | 'end';
  index: number;
  endIndex: number;
}

function markerPattern(kind: ManagedBlockKind): RegExp {
  const suffix = kind === 'profile' ? '-profile' : '';
  return new RegExp(`<!--\\s*(proof-or-stop|lattice)${suffix}:\\s*(start|end)\\s*-->`, 'g');
}

function markerTokens(content: string, kind: ManagedBlockKind): MarkerToken[] {
  const tokens: MarkerToken[] = [];
  const pattern = markerPattern(kind);
  for (const match of content.matchAll(pattern)) {
    const family = match[1] === 'proof-or-stop' ? 'canonical' : 'legacy';
    const phase = match[2] as 'start' | 'end';
    const index = match.index ?? -1;
    if (index < 0) continue;
    tokens.push({ family, phase, index, endIndex: index + match[0].length });
  }
  return tokens;
}

/** Inspect one managed block without treating an ambiguous block as safe. */
export function inspectManagedBlock(content: string, kind: ManagedBlockKind = 'document'): ManagedBlockInspection {
  const tokens = markerTokens(content, kind);
  if (tokens.length === 0) return { status: 'missing' };

  let opening: MarkerToken | null = null;
  let completed: ManagedBlockMatch | null = null;
  for (const token of tokens) {
    if (completed) {
      return { status: 'malformed', reason: 'multiple managed blocks or trailing marker' };
    }
    if (token.phase === 'start') {
      if (opening) return { status: 'malformed', reason: 'nested managed block start' };
      opening = token;
      continue;
    }
    if (!opening) return { status: 'malformed', reason: 'managed block end has no matching start' };
    if (opening.family !== token.family) {
      return { status: 'malformed', reason: 'managed block start/end use different marker families' };
    }
    completed = {
      startIndex: opening.index,
      endIndex: token.endIndex,
      text: content.slice(opening.index, token.endIndex),
      family: opening.family,
    };
    opening = null;
  }

  if (opening) return { status: 'malformed', reason: 'managed block start has no matching end' };
  if (!completed) return { status: 'malformed', reason: 'managed block markers are incomplete' };
  return { status: 'valid', block: completed };
}

/** Return a normalized managed section, preserving the full marker block. */
export function extractManagedBlock(content: string, kind: ManagedBlockKind = 'document'): string {
  const inspection = inspectManagedBlock(content, kind);
  if (inspection.status === 'valid') return inspection.block.text;
  return content.endsWith('\n') ? content : `${content}\n`;
}

/**
 * Replace a valid canonical or legacy block. `null` means no replacement is
 * safe; callers should preserve the file and ask for manual repair.
 */
export function replaceManagedBlock(
  content: string,
  replacement: string,
  kind: ManagedBlockKind = 'document',
): string | null {
  const inspection = inspectManagedBlock(content, kind);
  if (inspection.status !== 'valid') return null;
  const normalizedReplacement = replacement.endsWith('\n') ? replacement : `${replacement}\n`;
  return content.slice(0, inspection.block.startIndex)
    + normalizedReplacement
    + content.slice(inspection.block.endIndex);
}

export function hasManagedBlock(content: string, kind: ManagedBlockKind = 'document'): boolean {
  return inspectManagedBlock(content, kind).status === 'valid';
}

/** True for incomplete/nested blocks too; useful for an INCOMPATIBLE result. */
export function containsManagedMarker(content: string, kind: ManagedBlockKind = 'document'): boolean {
  return markerTokens(content, kind).length > 0;
}
