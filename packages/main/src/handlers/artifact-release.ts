import type { HandlerContext } from './context.js';
import {
  type ArtifactReleaseRecordV1,
  readArtifactReleaseLedger,
  resolveArtifactReleaseLedgerRoot,
} from '../core/artifact-release.js';

interface ArtifactReleaseListArgs {
  format?: 'text' | 'json';
  limit?: number;
}

interface ArtifactReleaseStatusArgs {
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

function latestRecords(records: ArtifactReleaseRecordV1[], limit: number): ArtifactReleaseRecordV1[] {
  return records.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

function renderRecordLine(record: ArtifactReleaseRecordV1): string {
  return [
    record.storyId,
    record.mainCommit.slice(0, 12),
    record.artifactSetDigest,
    `paths=${record.paths.length}`,
    `runtimeSemverChanged=${record.runtimeSemverChanged}`,
  ].join(' ');
}

function assertStoryId(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('artifact_release_status: storyId must be a string');
  const storyId = raw.trim();
  if (!storyId) throw new Error('artifact_release_status: storyId is required');
  return storyId;
}

export function createArtifactReleaseHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  const ledgerRoot = resolveArtifactReleaseLedgerRoot(ctx.root);

  return {
    artifact_release_list(args: ArtifactReleaseListArgs = {}) {
      const records = latestRecords(readArtifactReleaseLedger(ledgerRoot), normalizeLimit(args.limit));
      if (normalizeFormat(args.format) === 'json') return records;
      if (records.length === 0) return 'No artifact release records found';
      return records.map(renderRecordLine).join('\n');
    },

    artifact_release_status(args: ArtifactReleaseStatusArgs) {
      const storyId = assertStoryId(args?.storyId);
      const records = readArtifactReleaseLedger(ledgerRoot).filter(record => record.storyId === storyId);
      const latest = latestRecords(records, 1)[0] ?? null;
      if (normalizeFormat(args?.format) === 'json') {
        return { storyId, count: records.length, latest, records };
      }
      if (records.length === 0) return `No artifact release records found for ${storyId}`;
      return [
        `Artifact release records for ${storyId}: ${records.length}`,
        ...latestRecords(records, 20).map(renderRecordLine),
      ].join('\n');
    },
  };
}
