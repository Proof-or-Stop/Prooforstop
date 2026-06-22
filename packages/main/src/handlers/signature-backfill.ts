/**
 * B-17a9 CHK-002 (Experience Layer): `signature_backfill` — a WRITING command
 * that retroactively fills empty finding `signatureTag`s from a committed
 * signature map, recording provenance `'backfill'`.
 *
 * Two non-negotiable invariants:
 *   (1) HASH INVARIANCE — `signatureTag`/`signatureTagSource` are AUDIT-ONLY and
 *       are NOT part of the finding `_hash`. finding.ts attaches them AFTER
 *       `_hash: signFinding(...)`; here we mutate those audit fields on the
 *       already-hashed stored object WITHOUT recomputing `_hash`. This handler
 *       therefore never imports or calls `signFinding` and never touches
 *       `finding-verify.ts`.
 *   (2) DRY-RUN DEFAULT — writing requires an explicit `--apply`. Without it the
 *       handler reports what WOULD change and writes NOTHING.
 *
 * The decision per finding is the pure `decideBackfill` leaf. The map is a
 * committed JSON file ({ findingId -> "area|failureMode" }); the handler reads +
 * parses it offline (no LLM / network at runtime). Like the rest of the
 * Experience Layer it never files a finding and no gate reads any of it.
 */

import { readFileSync } from 'fs';

import type { HandlerContext } from './context.js';
import { decideBackfill, type BackfillAction } from '../core/signature-backfill.js';

interface SignatureBackfillArgs {
  /** Path to the committed signature map JSON ({ findingId -> "area|failureMode" }). Required. */
  map?: string;
  /** When true, persist the fills via store.writeFindings. Default false (dry-run). */
  apply?: boolean;
  /** When true, also replace existing `'auto'`-sourced tags. Default false. */
  overwriteAuto?: boolean;
  /** Emit the structured tally as JSON instead of the human report. */
  json?: boolean;
}

/** Every action the per-finding decision can take — used to zero-init the tally. */
const ACTIONS: BackfillAction[] = [
  'fill',
  'skip-no-mapping',
  'skip-empty-sig',
  'skip-confirmed',
  'skip-has-auto',
  'skip-nonempty',
];

/** The signature-source buckets reported in the by-source breakdown. */
type SourceBucket = 'empty' | 'auto' | 'confirmed' | 'backfill' | 'other';

interface BackfillTally {
  scanned: number;
  filled: number;
  storiesWritten: number;
  actions: Record<BackfillAction, number>;
  bySource: Record<SourceBucket, number>;
}

function emptyTally(): BackfillTally {
  const actions = Object.fromEntries(ACTIONS.map((a) => [a, 0])) as Record<BackfillAction, number>;
  return {
    scanned: 0,
    filled: 0,
    storiesWritten: 0,
    actions,
    bySource: { empty: 0, auto: 0, confirmed: 0, backfill: 0, other: 0 },
  };
}

/** Classify a finding's CURRENT signature source into a reporting bucket. */
function sourceBucket(f: { signatureTag?: string; signatureTagSource?: string }): SourceBucket {
  const tag = typeof f.signatureTag === 'string' ? f.signatureTag : '';
  if (tag.length === 0) return 'empty';
  switch (f.signatureTagSource) {
    case 'auto': return 'auto';
    case 'confirmed': return 'confirmed';
    case 'backfill': return 'backfill';
    default: return 'other';
  }
}

/** Read + JSON.parse the committed signature map; clear errors on missing/malformed file. */
function loadMap(mapPath: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(mapPath, 'utf-8');
  } catch (e) {
    throw new Error(`signature_backfill: cannot read map file "${mapPath}": ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`signature_backfill: map file "${mapPath}" is not valid JSON: ${(e as Error).message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`signature_backfill: map file "${mapPath}" must be a JSON object { findingId -> signature }`);
  }
  return parsed as Record<string, string>;
}

function renderReport(tally: BackfillTally, mapPath: string, mapEntries: number, apply: boolean, overwriteAuto: boolean): string {
  const lines: string[] = [];
  if (!apply) {
    lines.push('=== DRY-RUN (no --apply): nothing written ===');
  }
  lines.push(`signature_backfill: map=${mapPath} (${mapEntries} entr${mapEntries === 1 ? 'y' : 'ies'})${overwriteAuto ? ' [overwriteAuto]' : ''}`);
  lines.push(`scanned ${tally.scanned} finding(s); ${apply ? 'filled' : 'would-fill'} ${tally.filled}; stories ${apply ? 'written' : 'to-write'} ${tally.storiesWritten}`);
  lines.push('actions:');
  for (const a of ACTIONS) lines.push(`  ${a}: ${tally.actions[a]}`);
  lines.push('by current source:');
  for (const b of ['empty', 'auto', 'confirmed', 'backfill', 'other'] as SourceBucket[]) {
    lines.push(`  ${b}: ${tally.bySource[b]}`);
  }
  return lines.join('\n');
}

export function createSignatureBackfillHandlers(ctx: HandlerContext) {
  return {
    /**
     * Backfill empty finding `signatureTag`s from a committed map. Dry-run by
     * default; `--apply` persists. Never recomputes any finding `_hash`.
     */
    signature_backfill(args: SignatureBackfillArgs = {}): string {
      const mapPath = typeof args.map === 'string' ? args.map.trim() : '';
      if (!mapPath) {
        throw new Error('signature_backfill: --map <file> is required (path to a JSON { findingId -> signature } map); no implicit default.');
      }
      const apply = args.apply === true;
      const overwriteAuto = args.overwriteAuto === true;
      const map = loadMap(mapPath);
      const mapEntries = Object.keys(map).length;

      const tally = emptyTally();

      for (const storyId of ctx.store.listStoryIds()) {
        const data = ctx.store.readFindings(storyId);
        let changed = false;
        for (const f of data.findings) {
          tally.scanned += 1;
          tally.bySource[sourceBucket(f)] += 1;
          const d = decideBackfill(f, map[f.id], { overwriteAuto });
          tally.actions[d.action] += 1;
          if (d.action === 'fill') {
            tally.filled += 1;
            if (apply) {
              // Mutate ONLY the audit-only fields on the already-hashed, already-stored
              // finding object. These fields are NOT part of _hash (finding.ts attaches
              // them AFTER signFinding); we never recompute _hash and never call signFinding.
              f.signatureTag = d.signatureTag;
              f.signatureTagSource = d.signatureTagSource;
              changed = true;
            }
          }
        }
        if (apply && changed) {
          ctx.store.writeFindings(storyId, data);
          tally.storiesWritten += 1;
        }
      }

      if (args.json) {
        return JSON.stringify({
          dryRun: !apply,
          apply,
          overwriteAuto,
          map: mapPath,
          mapEntries,
          ...tally,
        }, null, 2);
      }
      return renderReport(tally, mapPath, mapEntries, apply, overwriteAuto);
    },
  };
}
