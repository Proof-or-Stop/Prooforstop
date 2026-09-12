import { maintenanceCommandWrites } from '../core/maintenance-command-mode.js';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { HandlerContext } from './context.js';
import {
  captureLifecycleMetadataTransaction,
  commitLifecycleMetadataTransaction,
  readLifecycleMetadataOutputHashes,
} from '../core/auto-commit-metadata.js';
import { REQUIRED_HOST_VERDICT_BINDING_FIELDS } from '../core/host-independence.js';
import { PROOF_OR_STOP_DIR, normalizeRelPath } from '../core/proof-or-stop-paths.js';
import { isCanonicalStoryId } from '../core/lifecycle-registry.js';
import { withMkdirLock } from '../core/mkdir-lock.js';

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
//
// B-3144 F-024 (recovery must never change a verdict): a recovery tool that can delete ANY
// duplicate-identity row can also delete a FAILING one. core/host-independence.ts treats a
// current-material non-PASS row as an invalidating fact for its round, so removing a FAIL that
// precedes a PASS with the same identities would silently turn an INVALID round into a valid one
// — laundering a failed review through a recovery command. Pruning is therefore restricted to the
// canonical B-bf52 collision shape: every member of a prunable group must carry decision=pass and
// the COMPLETE host_verdict binding field set (the very fields the consumer requires). A group
// with any non-PASS or malformed member is REFUSED, named in the report, and left byte-for-byte
// intact; the refusal is per group, so a genuine collision elsewhere in the same log is still
// recoverable in the same call.
//
// B-3144 F-025 (verdict-cache deletion is path-contained): the losing rows' verdictIds come from a
// committed log that this command must treat as untrusted input. A crafted id could otherwise
// traverse out of `.proof-or-stop/autopilot-verdicts/<storyId>/` and delete an arbitrary repository file
// while the command reported success. Deletion therefore requires BOTH the canonical generated id
// shape (core/verdicts.ts mints `verdict-<16 lowercase hex>`) AND a resolved path whose parent is
// exactly the story verdict directory; anything failing either test is skipped and reported.
//
// B-3144 F-026/F-027 (the rewrite is serialized and interruption-safe): the whole apply phase —
// reading the source bytes, validating them, backing them up, rewriting, and committing — runs
// while HOLDING the shared process-events append lock (core/process-events.ts's
// `.proof-or-stop/locks/process-events/<story>-process-events-append.lock`), so no ordinary appender can
// interleave a row that the rewrite would silently overwrite or that a rollback would delete, and
// the rewritten bytes are bound to the content read under that same lock. The rewrite itself is a
// durable same-directory temp file plus an atomic rename, so an interruption mid-write leaves
// either the old file or the new one, never a truncated canonical log.

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

/**
 * A duplicate-identity group that is OUTSIDE the recoverable B-bf52 collision shape (F-024): at
 * least one member is not a complete decision=pass host_verdict. Nothing in such a group is ever
 * removed — it is reported so the operator can see exactly what was left alone and why.
 */
interface RefusedDuplicateGroup {
  runId: string;
  hostId: string;
  sessionId: string;
  keyId: string;
  memberCount: number;
  verdictIds: string[];
  reasons: string[];
}

/** A losing verdictId whose gitignored cache file was NOT deleted, and the reason (F-025). */
interface SkippedVerdictFile {
  verdictId: string;
  reason: string;
}

export interface QuorumPruneResult {
  schemaVersion: 'proof-or-stop.quorum_prune.v1';
  storyId: string;
  keep: KeepSelector;
  dryRun: boolean;
  applied: boolean;
  runIdsFilter: string[] | null;
  duplicateGroups: DuplicateGroup[];
  refusedGroups: RefusedDuplicateGroup[];
  removedVerdictCount: number;
  removedVerdictIds: string[];
  backupPath: string | null;
  metadataCommitSha: string | null;
  removedVerdictFiles: string[];
  skippedVerdictFiles: SkippedVerdictFile[];
}

export interface QuorumPruneTestHooks {
  /**
   * Invoked ONCE inside the acquired process-events append lock, before the source bytes are
   * read. Exists so a test can prove the lock is genuinely held at that moment and that a row
   * committed by a competing writer just before the lock was taken still survives the rewrite.
   */
  insideAppendLock?: (args: { lockDir: string }) => void;
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

// F-025: the ONLY id shape core/verdicts.ts (and cross-host-review.ts) ever mints —
// `verdict-` + the first 16 lowercase hex characters of the canonical sha256 digest. A committed
// log is untrusted input for this command, so anything that is not exactly this shape is not a
// verdict file this tool may delete.
const CANONICAL_VERDICT_ID = /^verdict-[0-9a-f]{16}$/;

function removeVerdictFiles(
  root: string,
  storyId: string,
  verdictIds: readonly string[],
): { removed: string[]; skipped: SkippedVerdictFile[] } {
  const dir = resolve(join(root, PROOF_OR_STOP_DIR, 'autopilot-verdicts', storyId));
  const removed: string[] = [];
  const skipped: SkippedVerdictFile[] = [];
  for (const verdictId of new Set(verdictIds)) {
    if (!verdictId) continue;
    // Two independent tests, both required (F-025). The shape test states what a real generated
    // id is; the containment test states where a deletion may land even if the shape test is
    // ever loosened. Either one failing skips the deletion and is reported.
    if (!CANONICAL_VERDICT_ID.test(verdictId)) {
      skipped.push({
        verdictId,
        reason: 'verdictId is not the canonical generated shape verdict-<16 lowercase hex>; no file was deleted',
      });
      continue;
    }
    const path = resolve(join(dir, `${verdictId}.json`));
    if (dirname(path) !== dir) {
      skipped.push({
        verdictId,
        reason: `resolved verdict cache path escapes ${dir}; no file was deleted`,
      });
      continue;
    }
    try {
      if (existsSync(path)) {
        rmSync(path, { force: true });
        removed.push(path);
      }
    } catch {
      // Best-effort: verdict files are gitignored recovery cache, not committed evidence.
    }
  }
  return { removed, skipped };
}

/**
 * F-027: write `bytes` to `path` and flush them to stable storage before returning, so the
 * subsequent rename installs a COMPLETE file rather than whatever the page cache happened to
 * hold.
 */
function writeFileDurably(path: string, bytes: Buffer): void {
  // 'wx' — a temp path is single-use; refusing to reuse an existing one means a stray leftover
  // can never be silently adopted as this rewrite's content.
  const fd = openSync(path, 'wx');
  try {
    let offset = 0;
    while (offset < bytes.length) {
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectory(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    /* PROBE: directory fsync is not available on every platform (notably Windows). The rename is
       still atomic there; only the durability of the DIRECTORY entry is weaker, which cannot
       produce a truncated file. */
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* PROBE: descriptor already closed by the failing fsync path. */
      }
    }
  }
}

/**
 * F-027: replace the canonical JSONL through a same-directory temp file plus an atomic rename.
 * An in-place overwrite truncates first, so an interruption (SIGKILL, power loss) between the
 * truncate and the last write leaves a PARTIAL canonical log and the handler's catch/rollback
 * never runs. With rename, an interrupted run leaves either the untouched original or the fully
 * written replacement.
 *
 * The temp name keeps `.bak` as its LAST extension for the same reason the backup does: the story
 * dir is git-tracked and both clean-baseline checks run an unscoped
 * `git status --untracked-files=all`, so a leftover from a killed process must land on the
 * repository's existing `*.bak` ignore rule instead of blocking the next legitimate recovery.
 */
function atomicRewriteProcessEvents(storyDir: string, processEventsPath: string, bytes: Buffer): void {
  const tempPath = join(storyDir, `process-events.jsonl.rewrite-${process.pid}-${randomUUID()}.tmp.bak`);
  try {
    writeFileDurably(tempPath, bytes);
    renameSync(tempPath, processEventsPath);
  } catch (error) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      /* PROBE: best-effort temp cleanup; the name is unique so a leftover cannot be adopted. */
    }
    throw error;
  }
  fsyncDirectory(storyDir);
}

function formatPruneResult(result: QuorumPruneResult): string {
  const lines = [
    `quorum_prune (${result.schemaVersion})`,
    `storyId: ${result.storyId}`,
    `mode: ${result.dryRun ? 'dry-run (no mutation)' : 'apply'}`,
    `keep: ${result.keep}`,
    `runIdsFilter: ${result.runIdsFilter ? result.runIdsFilter.join(', ') : '(all runIds)'}`,
    `duplicateGroups: ${result.duplicateGroups.length}`,
    `refusedGroups: ${result.refusedGroups.length}`,
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
  for (const group of result.refusedGroups) {
    lines.push(
      `  [REFUSED] runId=${group.runId} host=${group.hostId} session=${group.sessionId} key=${group.keyId} `
      + `members=${group.memberCount} — left intact, nothing removed`,
    );
    for (const reason of group.reasons) lines.push(`    reason: ${reason}`);
  }
  if (result.applied) {
    lines.push(`backup: ${result.backupPath}`);
    lines.push(`metadataCommitSha: ${result.metadataCommitSha}`);
    lines.push(`removedVerdictFiles: ${result.removedVerdictFiles.length}`);
    for (const skipped of result.skippedVerdictFiles) {
      lines.push(`    [SKIPPED FILE] verdictId=${skipped.verdictId}: ${skipped.reason}`);
    }
  } else {
    lines.push('note: dry-run only — re-run with apply:true (or dryRun:false) to back up, prune, and commit.');
  }
  return lines.join('\n');
}

export function createQuorumPruneHandlers(ctx: HandlerContext, testHooks: QuorumPruneTestHooks = {}) {
  return {
    quorum_prune(args: QuorumPruneArgs): QuorumPruneResult | string {
      const storyId = normalizeString(args.storyId);
      if (!storyId) throw new Error('quorum_prune: storyId is required');
      if (!isCanonicalStoryId(storyId)) {
        throw new Error(`quorum_prune: storyId "${storyId}" is not a canonical, path-safe Proof-or-Stop story id`);
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
          + 'rewrites, and commits. To actually recover, pass apply:true with dryRun omitted, or '
          + 'dryRun:false on its own — the two are equivalent executors.',
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
      const apply = maintenanceCommandWrites('quorum_prune', args);
      const keep: KeepSelector = args.keep === 'oldest-material' ? 'oldest-material' : 'newest-material';
      const runIdFilter = normalizeRunIdFilter(args.runIds);

      const gitCwd = ctx.root;
      const storyDir = ctx.store.storyDirPath(storyId);
      const storyRel = quorumPruneStoryRel(gitCwd, storyDir, storyId);
      const processEventsPath = join(storyDir, 'process-events.jsonl');
      const processEventsRel = `${storyRel}/process-events.jsonl`;

      interface Row {
        lineIndex: number;
        verdictId: string;
        runId: string;
        hostId: string;
        sessionId: string;
        keyId: string;
        decision: string;
        materialDigest: string;
        timestamp: string;
        event: Record<string, unknown>;
      }

      interface PruneProjection {
        lines: string[];
        duplicateGroups: DuplicateGroup[];
        refusedGroups: RefusedDuplicateGroup[];
        losingLineIndices: Set<number>;
        losingVerdictIds: string[];
      }

      // F-024: the ONLY shape this recovery may act on. A prunable group is a set of rows that the
      // consumer would each COUNT as a passing verdict but that collide on one identity — the
      // B-bf52 shape, where removing the losing rows restores the recorded quorum and cannot
      // change any round's verdict. Any other shape (a non-PASS row, or a row missing a binding
      // field the consumer requires) carries information the consumer USES, so deleting it could
      // change the outcome; such a group is refused whole.
      const unrecoverableGroupReasons = (ordered: Row[]): string[] => {
        const reasons: string[] = [];
        for (const row of ordered) {
          const where = `line ${row.lineIndex + 1} (verdictId=${row.verdictId || '<none>'})`;
          const missing = REQUIRED_HOST_VERDICT_BINDING_FIELDS
            .filter(field => !normalizeString(row.event[field]));
          if (missing.length > 0) {
            reasons.push(`${where}: missing required host_verdict binding field(s) ${missing.join(', ')}`);
          }
          if (row.decision !== 'pass') {
            reasons.push(
              `${where}: decision=${row.decision || '<none>'} is not pass — removing it could change this `
              + 'round\'s verdict, which recovery must never do',
            );
          }
        }
        return reasons;
      };

      const projectionOf = (rawBytes: Buffer): PruneProjection => {
        const rawContent = rawBytes.toString('utf8');
        // JSONL rows never embed a newline (each event is a single compact JSON line), so a plain
        // split preserves every non-host_verdict line and the exact original order. A trailing
        // newline yields a final empty element that is retained on rejoin to stay byte-identical.
        const lines = rawContent.length > 0 ? rawContent.split('\n') : [];

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
            // Same normalization the consumer applies (core/host-independence.ts), so this guard
            // classifies a decision exactly as the evaluator would.
            decision: normalizeString(event.decision).toLowerCase(),
            materialDigest: normalizeString(event.materialDigest),
            timestamp: normalizeString(event.timestamp),
            event,
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
        const refusedGroups: RefusedDuplicateGroup[] = [];
        const losingLineIndices = new Set<number>();
        const losingVerdictIds: string[] = [];
        for (const bucket of groups.values()) {
          if (bucket.length <= 1) continue;
          // File order is committed order; newest-material keeps the later event (the newer
          // material after a merge-main drift, matching the B-bf52 recovery keep=newest-material),
          // oldest-material keeps the earlier event.
          const ordered = [...bucket].sort((left, right) => left.lineIndex - right.lineIndex);
          const refusalReasons = unrecoverableGroupReasons(ordered);
          if (refusalReasons.length > 0) {
            // FAIL CLOSED: name the group, remove nothing from it, and keep going so a genuine
            // collision on another identity is still recoverable in this same call.
            refusedGroups.push({
              runId: ordered[0].runId,
              hostId: ordered[0].hostId,
              sessionId: ordered[0].sessionId,
              keyId: ordered[0].keyId,
              memberCount: ordered.length,
              verdictIds: ordered.map(row => row.verdictId || '<none>'),
              reasons: refusalReasons,
            });
            continue;
          }
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
        refusedGroups.sort((left, right) =>
          left.runId.localeCompare(right.runId) || left.hostId.localeCompare(right.hostId));

        return { lines, duplicateGroups, refusedGroups, losingLineIndices, losingVerdictIds };
      };

      const runIdsFilter = runIdFilter ? [...runIdFilter].sort() : null;
      const baseResultOf = (projection: PruneProjection) => ({
        schemaVersion: 'proof-or-stop.quorum_prune.v1' as const,
        storyId,
        keep,
        runIdsFilter,
        duplicateGroups: projection.duplicateGroups,
        refusedGroups: projection.refusedGroups,
        removedVerdictCount: projection.losingLineIndices.size,
        removedVerdictIds: [...new Set(projection.losingVerdictIds)].sort(),
      });
      const refusedGroupSummary = (projection: PruneProjection): string => (
        projection.refusedGroups.length === 0
          ? ''
          : ` ${projection.refusedGroups.length} duplicate group(s) were REFUSED as outside the recoverable `
            + 'B-bf52 collision shape and left intact: '
            + projection.refusedGroups
              .map(group => `runId=${group.runId} host=${group.hostId} (${group.reasons.join('; ')})`)
              .join(' | ')
      );

      const readEventBytes = (): Buffer => (
        existsSync(processEventsPath) ? readFileSync(processEventsPath) : Buffer.alloc(0)
      );

      if (!apply) {
        const projection = projectionOf(readEventBytes());
        const result: QuorumPruneResult = {
          ...baseResultOf(projection),
          dryRun: true,
          applied: false,
          backupPath: null,
          metadataCommitSha: null,
          removedVerdictFiles: [],
          skippedVerdictFiles: [],
        };
        return wantsJson(args) ? result : formatPruneResult(result);
      }

      // F-026: EVERYTHING that reads, validates, backs up, rewrites, or commits the canonical log
      // runs under the SAME advisory lock ordinary appenders take (core/process-events.ts), and the
      // source bytes are read INSIDE it. Reading before the lock is what made the rewrite lossy: a
      // row appended after that read was overwritten by the rewrite, and a rollback to the earlier
      // snapshot deleted it outright.
      const appendLockDir = ctx.store.runtimeLockDirPath(storyId, 'process-events', 'process-events-append');
      return withMkdirLock(appendLockDir, (): QuorumPruneResult | string => {
        testHooks.insideAppendLock?.({ lockDir: appendLockDir });
        const rawBytes = readEventBytes();
        const projection = projectionOf(rawBytes);
        const baseResult = baseResultOf(projection);

        if (projection.duplicateGroups.length === 0) {
          throw new Error(
            'quorum_prune refuses: nothing to prune — no duplicate host_verdict events '
            + `${runIdFilter ? `(for runId filter ${[...runIdFilter].sort().join(', ')}) ` : ''}`
            + 'were found in the committed process-events.jsonl. No backup, mutation, or commit performed.'
            + refusedGroupSummary(projection),
          );
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
          // Bound to the bytes read under this lock: `projection.lines` came from `rawBytes`, so
          // the rewrite can only ever be "those exact bytes minus the losing rows".
          const keptLines = projection.lines.filter((_, index) => !projection.losingLineIndices.has(index));
          atomicRewriteProcessEvents(storyDir, processEventsPath, Buffer.from(keptLines.join('\n'), 'utf8'));

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

          const verdictFiles = removeVerdictFiles(gitCwd, storyId, projection.losingVerdictIds);
          const result: QuorumPruneResult = {
            ...baseResult,
            dryRun: false,
            applied: true,
            backupPath,
            metadataCommitSha: committed.commitSha,
            removedVerdictFiles: verdictFiles.removed,
            skippedVerdictFiles: verdictFiles.skipped,
          };
          return wantsJson(args) ? result : formatPruneResult(result);
        } catch (error) {
          if (!committedOk) {
            // Restore the exact pre-prune bytes (the transaction machinery already rolls back on
            // commit failure; this also covers a pre-commit failure after the rewrite) and remove
            // the backup so a failed prune leaves the tree exactly as it was found. Safe under the
            // lock: no appender can have added a row since `rawBytes` was read, so restoring them
            // cannot delete a concurrent event.
            try {
              if (!readFileSync(processEventsPath).equals(rawBytes)) {
                atomicRewriteProcessEvents(storyDir, processEventsPath, rawBytes);
              }
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
      }, {
        label: 'process-events append (quorum_prune rewrite)',
      });
    },
  };
}
