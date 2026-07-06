import type { HandlerContext } from './context.js';
import {
  type ProductCapabilityReleaseRecord,
  readCapabilityReleaseLedger,
  resolveCapabilityReleaseLedgerRoot,
} from '../core/capability-release.js';

interface CapabilityReleaseListArgs {
  format?: 'text' | 'json';
  limit?: number;
}

interface CapabilityReleaseStatusArgs {
  storyId: string;
  format?: 'text' | 'json';
}

function normalizeFormat(format?: string): 'text' | 'json' {
  return format === 'json' ? 'json' : 'text';
}

function normalizeLimit(limit: unknown): number {
  const n = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : 20;
  return Math.max(1, Math.min(200, n));
}

function latestRecords(
  records: ProductCapabilityReleaseRecord[],
  limit: number,
): ProductCapabilityReleaseRecord[] {
  return records.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

function renderRecordLine(record: ProductCapabilityReleaseRecord): string {
  return [
    record.storyId,
    record.capabilityId,
    record.capabilityVersion,
    record.capabilityKind,
    `paths=${record.changedPaths.length}`,
    `runtimeSemverChanged=${record.runtimeSemverChanged}`,
  ].join(' ');
}

function assertStoryId(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('capability_release_status: storyId must be a string');
  const storyId = raw.trim();
  if (!storyId) throw new Error('capability_release_status: storyId is required');
  return storyId;
}

export function createCapabilityReleaseHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  const ledgerRoot = resolveCapabilityReleaseLedgerRoot(ctx.root);

  return {
    capability_release_list(args: CapabilityReleaseListArgs = {}) {
      const records = latestRecords(readCapabilityReleaseLedger(ledgerRoot), normalizeLimit(args.limit));
      if (normalizeFormat(args.format) === 'json') return records;
      if (records.length === 0) return 'No product capability release records found';
      return records.map(renderRecordLine).join('\n');
    },

    capability_release_status(args: CapabilityReleaseStatusArgs) {
      const storyId = assertStoryId(args?.storyId);
      const records = readCapabilityReleaseLedger(ledgerRoot).filter(record => record.storyId === storyId);
      const latest = latestRecords(records, 1)[0] ?? null;
      if (normalizeFormat(args?.format) === 'json') {
        return { storyId, count: records.length, latest, records };
      }
      if (records.length === 0) return `No product capability release records found for ${storyId}`;
      return [
        `Product capability release records for ${storyId}: ${records.length}`,
        ...latestRecords(records, 20).map(renderRecordLine),
      ].join('\n');
    },
  };
}
