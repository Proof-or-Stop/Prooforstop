import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { HandlerContext } from './context.js';
import {
  captureLifecycleMetadataTransaction,
  commitLifecycleMetadataTransaction,
  readLifecycleMetadataOutputHashes,
} from '../core/auto-commit-metadata.js';
import { LATTICE_DIR, normalizeRelPath } from '../core/lattice-paths.js';
import { isCanonicalStoryId } from '../core/lifecycle-registry.js';

// quorum_prune formalizes the manual B-bf52 recovery (commit 255eefd289): a poisoned quorum,
// created when a redundant re-submit landed duplicate host_verdict events on the same runId +
// host/session/key identity, must be recovered by removing the losing verdict set from the
// committed process-events.jsonl. Producer poisoning is now refused by the quorum_submit
// drift-accept guard (CHK-002); this command is the OFFICIAL recovery for already-poisoned
// stories, replacing hand-editing the append-only log.
//
// Containment (decision.json preMortems): dry-run is the DEFAULT — omitting both flags never
// mutates. Execution requires an explicit instruction: apply:true, or the equivalent dryRun:false
// (a real declared schema flag, so `--dryRun` is honored rather than silently swallowed and
// `--dryRun=false` is not a silent no-op). Either explicitly contradictory pair, apply:true with
// dryRun:true or apply:false with dryRun:false, is REFUSED rather than silently resolved. A
// timestamped byte-identical backup is written before any rewrite —
// named `process-events.jsonl.<stamp>.bak` so it matches the repository's existing `*.bak`
// ignore pattern and leaves no untracked dirt behind — and the rewrite is committed through the
// SAME lifecycle-metadata transaction machinery quorum_submit uses so the pre-dirty refusal,
// exact-content verification, and rollback all hold. Because that transaction is exact and
// immutable, cli-engine's generic codex_cli process-event append excludes quorum_prune exactly
// as it excludes quorum_submit. It never touches floor/escalation acceptance semantics —
// removing events cannot re-stale passes because story metadata is excluded from storyFilesHash.

type KeepSelector = 'newest-material' | 'oldest-material';

export interface QuorumPruneFormatArgs {
  json?: boolean;
  format?: 'text' | 'json';
}

export type QuorumPruneArgs = {
  storyId: string;
  runIds?: string[] | string;
  /**
   * Explicit projection-only request. Omitted or true = project the duplicate groups without
   * touching anything; it is the default, so it exists both so `--dryRun` is a REAL declared
   * schema field (not a silently-swallowed unknown key, and help-renderer derives the true
   * "default-on via --dryRun" contract instead of falling through to "always-on") and so an
   * explicit dryRun:false is a real executor rather than a silent no-op. Contradictory pairs are
   * refused rather than silently resolved: dryRun:true with apply:true, and dryRun:false with
   * apply:false.
   */
  dryRun?: boolean;
  /**
   * Explicit execute request; equivalent to dryRun:false. Omitted defaults to the projection.
   * Contradictory pairs are refused: apply:true with dryRun:true, and apply:false with
   * dryRun:false.
   */
  apply?: boolean;
  keep?: KeepSelector;
} & QuorumPruneFormatArgs;

interface DuplicateGroupMember {
  verdictId: string;
  runId: string;
  hostId: string;
  materialDigest: string;
  timestamp: string;
  disposition: 'KEEP' | 'REMOVE';
}

interface DuplicateGroup {
  runId: string;
  hostId: string;
  sessionId: string;
  keyId: string;
  keptVerdictId: string;
  members: DuplicateGroupMember[];
}

export interface QuorumPruneResult {
  schemaVersion: 'lattice.quorum_prune.v1';
  storyId: string;
  keep: KeepSelector;
  dryRun: boolean;
  applied: boolean;
  runIdsFilter: string[] | null;
  duplicateGroups: DuplicateGroup[];
  removedVerdictCount: number;
  removedVerdictIds: string[];
  backupPath: string | null;
  metadataCommitSha: string | null;
  removedVerdictFiles: string[];
}

function wantsJson(args: QuorumPruneFormatArgs | undefined): boolean {
  return args?.json === true || args?.format === 'json';
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeRunIdFilter(value: unknown): Set<string> | null {
  if (value === undefined || value === null) return null;
  const list = Array.isArray(value) ? value : [value];
  const runIds = list.map(entry => (typeof entry === 'string' ? entry.trim() : '')).filter(Boolean);
  return runIds.length > 0 ? new Set(runIds) : null;
}

function quorumPruneStoryRel(gitCwd: string, storyDir: string, storyId: string): string {
  const rel = normalizeRelPath(relative(gitCwd, storyDir));
  if (!rel || rel === '.' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    throw new Error(`quorum_prune: canonical story metadata path is outside the signed workspace (${rel || '<empty>'})`);
  }
  return rel;
}

function assertProcessEventsCommitted(gitCwd: string, processEventsRel: string): void {
  const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all', '--', processEventsRel], {
    cwd: gitCwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  if (status) {
    throw new Error(
      `quorum_prune refuses: the events file ${processEventsRel} has uncommitted changes (untracked, staged, or `
      + `modified) — prune only operates on the committed process-events state to avoid rewriting in-flight data. `
      + `Commit or discard it first: ${status}`,
    );
  }
}

function assertCleanPruneBaseline(gitCwd: string): void {
  // Reuse quorum_submit's clean-baseline discipline: the whole worktree/index must be clean
  // before the atomic rewrite so prune never interleaves with uncommitted work.
  const dirty = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: gitCwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  if (dirty) {
    throw new Error(`quorum_prune refuses: worktree/index must be clean before pruning the committed verdict log; pre-existing bytes were left untouched: ${dirty}`);
  }
}

// The backup lands in the GIT-TRACKED story dir, so its name must genuinely match the
// repository's existing `*.bak` ignore pattern (.gitignore) — the extension has to be the LAST
// segment. A `.bak-<stamp>` suffix does not match `*.bak`, and because the prune transaction
// stages only process-events.jsonl the backup would then survive as untracked dirt; both
// assertCleanPruneBaseline here and quorum_submit's assertCleanQuorumBaseline run an unscoped
// `git status --porcelain=v1 --untracked-files=all`, so the very next legitimate recovery call
// would refuse on this tool's own artifact. Uniqueness therefore appends the collision counter
// BEFORE the extension so every candidate keeps the ignored `.bak` ending.
function writeUniqueBackup(storyDir: string, rawBytes: Buffer): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let candidate = join(storyDir, `process-events.jsonl.${stamp}.bak`);
  let counter = 1;
  while (existsSync(candidate)) {
    candidate = join(storyDir, `process-events.jsonl.${stamp}-${counter}.bak`);
    counter += 1;
  }
  writeFileSync(candidate, rawBytes);
  return candidate;
}

function removeVerdictFiles(root: string, storyId: string, verdictIds: readonly string[]): string[] {
  const dir = join(root, LATTICE_DIR, 'autopilot-verdicts', storyId);
  const removed: string[] = [];
  for (const verdictId of new Set(verdictIds)) {
    if (!verdictId) continue;
    const path = join(dir, `${verdictId}.json`);
    try {
      if (existsSync(path)) {
        rmSync(path, { force: true });
        removed.push(path);
      }
    } catch {
      // Best-effort: verdict files are gitignored recovery cache, not committed evidence.
    }
  }
  return removed;
}

function formatPruneResult(result: QuorumPruneResult): string {
  const lines = [
    `quorum_prune (${result.schemaVersion})`,
    `storyId: ${result.storyId}`,
    `mode: ${result.dryRun ? 'dry-run (no mutation)' : 'apply'}`,
    `keep: ${result.keep}`,
    `runIdsFilter: ${result.runIdsFilter ? result.runIdsFilter.join(', ') : '(all runIds)'}`,
    `duplicateGroups: ${result.duplicateGroups.length}`,
    `wouldRemove/removed verdict events: ${result.removedVerdictCount}`,
  ];
  for (const group of result.duplicateGroups) {
    lines.push(`  runId=${group.runId} host=${group.hostId} session=${group.sessionId} key=${group.keyId}`);
    for (const member of group.members) {
      lines.push(
        `    [${member.disposition}] verdictId=${member.verdictId || '<none>'} material=${member.materialDigest || '<none>'} ts=${member.timestamp || '<none>'}`,
      );
    }
  }
  if (result.applied) {
    lines.push(`backup: ${result.backupPath}`);
    lines.push(`metadataCommitSha: ${result.metadataCommitSha}`);
    lines.push(`removedVerdictFiles: ${result.removedVerdictFiles.length}`);
  } else {
    lines.push('note: dry-run only — re-run with apply:true (or dryRun:false) to back up, prune, and commit.');
  }
  return lines.join('\n');
}

export function createQuorumPruneHandlers(ctx: HandlerContext) {
  return {
    quorum_prune(args: QuorumPruneArgs): QuorumPruneResult | string {
      const storyId = normalizeString(args.storyId);
      if (!storyId) throw new Error('quorum_prune: storyId is required');
      if (!isCanonicalStoryId(storyId)) {
        throw new Error(`quorum_prune: storyId "${storyId}" is not a canonical, path-safe Proofbound story id`);
      }
      // dryRun/apply resolution. Like the repo convention (capability_release_backfill), the
      // DEFAULT is projection-only and an explicitly conflicting combination is REFUSED rather
      // than silently resolved. B-3144 F-010 adds one thing that convention leaves out: an
      // explicit dryRun:false must not be a silent no-op. Saying "do not dry-run" is a request
      // to execute, and CHK-003's userSees promises exactly that ("without --dryRun it backs up,
      // removes them, commits"). So dryRun:false executes, while OMITTING dryRun still defaults
      // to the safe projection — the safety default lives in the default, not in ignoring the
      // operator's explicit instruction.
      if (args.apply === true && args.dryRun === true) {
        throw new Error(
          'quorum_prune refuses: pass either apply:true or dryRun:true, not both. dryRun:true only '
          + 'projects the duplicate groups (no backup, rewrite, or commit); apply:true backs up, '
          + 'rewrites, and commits. Omit dryRun (the default) and pass apply:true to actually recover.',
        );
      }
      // The symmetric conflict must refuse too, and for the same reason: apply:false says "do not
      // execute" while dryRun:false says "do not project". Resolving it silently would pick the
      // MORE dangerous side (a real backup + rewrite + commit) against an explicit apply:false.
      if (args.apply === false && args.dryRun === false) {
        throw new Error(
          'quorum_prune refuses: apply:false and dryRun:false contradict each other — apply:false '
          + 'says do not execute, dryRun:false says do not project. Pass apply:true (or dryRun:false '
          + 'alone) to recover, or omit both for the default projection.',
        );
      }
      const apply = args.apply === true || args.dryRun === false;
      const keep: KeepSelector = args.keep === 'oldest-material' ? 'oldest-material' : 'newest-material';
      const runIdFilter = normalizeRunIdFilter(args.runIds);

      const gitCwd = ctx.root;
      const storyDir = ctx.store.storyDirPath(storyId);
      const storyRel = quorumPruneStoryRel(gitCwd, storyDir, storyId);
      const processEventsPath = join(storyDir, 'process-events.jsonl');
      const processEventsRel = `${storyRel}/process-events.jsonl`;

      const rawBytes = existsSync(processEventsPath) ? readFileSync(processEventsPath) : Buffer.alloc(0);
      const rawContent = rawBytes.toString('utf8');
      // JSONL rows never embed a newline (each event is a single compact JSON line), so a plain
      // split preserves every non-host_verdict line and the exact original order. A trailing
      // newline yields a final empty element that is retained on rejoin to stay byte-identical.
      const lines = rawContent.length > 0 ? rawContent.split('\n') : [];

      interface Row {
        lineIndex: number;
        verdictId: string;
        runId: string;
        hostId: string;
        sessionId: string;
        keyId: string;
        materialDigest: string;
        timestamp: string;
      }
      const rows: Row[] = [];
      lines.forEach((line, lineIndex) => {
        if (!line) return;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        if (event.type !== 'host_verdict') return;
        rows.push({
          lineIndex,
          verdictId: normalizeString(event.verdictId),
          runId: normalizeString(event.runId),
          hostId: normalizeString(event.hostId),
          sessionId: normalizeString(event.sessionId),
          keyId: normalizeString(event.keyId),
          materialDigest: normalizeString(event.materialDigest),
          timestamp: normalizeString(event.timestamp),
        });
      });

      // Group by (runId, hostId, sessionId, keyId). A group with more than one member is a
      // duplicate set: exactly one member is kept, the rest are the losing set.
      const groups = new Map<string, Row[]>();
      for (const row of rows) {
        if (runIdFilter && !runIdFilter.has(row.runId)) continue;
        const key = JSON.stringify([
          row.runId,
          row.hostId.toLowerCase(),
          row.sessionId.toLowerCase(),
          row.keyId.toLowerCase(),
        ]);
        const bucket = groups.get(key);
        if (bucket) bucket.push(row);
        else groups.set(key, [row]);
      }

      const duplicateGroups: DuplicateGroup[] = [];
      const losingLineIndices = new Set<number>();
      const losingVerdictIds: string[] = [];
      for (const bucket of groups.values()) {
        if (bucket.length <= 1) continue;
        // File order is committed order; newest-material keeps the later event (the newer
        // material after a merge-main drift, matching the B-bf52 recovery keep=newest-material),
        // oldest-material keeps the earlier event.
        const ordered = [...bucket].sort((left, right) => left.lineIndex - right.lineIndex);
        const kept = keep === 'newest-material' ? ordered[ordered.length - 1] : ordered[0];
        const members: DuplicateGroupMember[] = ordered.map(row => ({
          verdictId: row.verdictId,
          runId: row.runId,
          hostId: row.hostId,
          materialDigest: row.materialDigest,
          timestamp: row.timestamp,
          disposition: row.lineIndex === kept.lineIndex ? 'KEEP' : 'REMOVE',
        }));
        for (const row of ordered) {
          if (row.lineIndex === kept.lineIndex) continue;
          losingLineIndices.add(row.lineIndex);
          if (row.verdictId) losingVerdictIds.push(row.verdictId);
        }
        duplicateGroups.push({
          runId: kept.runId,
          hostId: kept.hostId,
          sessionId: kept.sessionId,
          keyId: kept.keyId,
          keptVerdictId: kept.verdictId,
          members,
        });
      }
      duplicateGroups.sort((left, right) =>
        left.runId.localeCompare(right.runId) || left.hostId.localeCompare(right.hostId));

      const runIdsFilter = runIdFilter ? [...runIdFilter].sort() : null;
      const baseResult = {
        schemaVersion: 'lattice.quorum_prune.v1' as const,
        storyId,
        keep,
        runIdsFilter,
        duplicateGroups,
        removedVerdictCount: losingLineIndices.size,
        removedVerdictIds: [...new Set(losingVerdictIds)].sort(),
      };

      if (duplicateGroups.length === 0) {
        if (apply) {
          throw new Error(
            'quorum_prune refuses: nothing to prune — no duplicate host_verdict events '
            + `${runIdFilter ? `(for runId filter ${[...runIdFilter].sort().join(', ')}) ` : ''}`
            + 'were found in the committed process-events.jsonl. No backup, mutation, or commit performed.',
          );
        }
        const result: QuorumPruneResult = {
          ...baseResult,
          dryRun: true,
          applied: false,
          backupPath: null,
          metadataCommitSha: null,
          removedVerdictFiles: [],
        };
        return wantsJson(args) ? result : formatPruneResult(result);
      }

      if (!apply) {
        const result: QuorumPruneResult = {
          ...baseResult,
          dryRun: true,
          applied: false,
          backupPath: null,
          metadataCommitSha: null,
          removedVerdictFiles: [],
        };
        return wantsJson(args) ? result : formatPruneResult(result);
      }

      // apply path: refuse on uncommitted events file first (specific message), then any other
      // worktree dirt, then rewrite through the lifecycle-metadata transaction.
      assertProcessEventsCommitted(gitCwd, processEventsRel);
      assertCleanPruneBaseline(gitCwd);

      const transaction = captureLifecycleMetadataTransaction({
        root: gitCwd,
        gitCwd,
        storyId,
        storyRel,
        // Reuse the process-events-only transaction shape; prune touches exactly the same one
        // canonical file as quorum_submit and inherits its pre-dirty refusal + rollback.
        kind: 'quorum-submit',
      });

      let backupPath = '';
      let committedOk = false;
      try {
        backupPath = writeUniqueBackup(storyDir, rawBytes);
        const keptLines = lines.filter((_, index) => !losingLineIndices.has(index));
        writeFileSync(processEventsPath, Buffer.from(keptLines.join('\n'), 'utf8'));

        const hashes = readLifecycleMetadataOutputHashes({ root: gitCwd, capture: transaction });
        if (!hashes.ok) throw new Error(hashes.reason);
        const committed = commitLifecycleMetadataTransaction({
          root: gitCwd,
          gitCwd,
          storyId,
          capture: transaction,
          verifiedHashes: hashes.hashes,
        });
        if (!committed.ok) throw new Error(committed.reason || 'quorum_prune immutable metadata commit failed');
        if (!committed.commitSha) throw new Error('quorum_prune immutable metadata commit produced no commit SHA');
        committedOk = true;

        const removedVerdictFiles = removeVerdictFiles(gitCwd, storyId, losingVerdictIds);
        const result: QuorumPruneResult = {
          ...baseResult,
          dryRun: false,
          applied: true,
          backupPath,
          metadataCommitSha: committed.commitSha,
          removedVerdictFiles,
        };
        return wantsJson(args) ? result : formatPruneResult(result);
      } catch (error) {
        if (!committedOk) {
          // Restore the exact pre-prune bytes (the transaction machinery already rolls back on
          // commit failure; this also covers a pre-commit failure after the rewrite) and remove
          // the backup so a failed prune leaves the tree exactly as it was found.
          try {
            if (!readFileSync(processEventsPath).equals(rawBytes)) writeFileSync(processEventsPath, rawBytes);
          } catch {
            // leave as-is if the file cannot be read back
          }
          try {
            if (backupPath && existsSync(backupPath)) rmSync(backupPath, { force: true });
          } catch {
            // best-effort cleanup
          }
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`quorum_prune atomic prune failed: ${message}`);
      }
    },
  };
}
