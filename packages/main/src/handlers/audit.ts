/**
 * koala audit — framework self-introspection audit (B-9bd9 CHK-001, MVP)
 *
 * Mechanically scans CLAUDE.md / packages/koala/CLAUDE.md promises vs actual CLI behavior drift.
 *
 * Currently only supports `--framework` mode (future may add `--code` / `--schema` etc.).
 *
 * Flow:
 *   1. mode=off → print + exit
 *   2. Read both CLAUDE.md files
 *   3. ensureMetaStory (idempotent) + beginRound (next round)
 *   4. Run scanner → upsertDrift (new / still-drifting)
 *   5. autoResolveMissing (not seen this round → resolved-by-nature)
 *   6. Generate report.md to docs/koala/framework-audit/YYYY-MM-DD/report.md
 *   7. touchAuditState: only update state.json's lastAuditAt (other fields managed by CHK-003)
 *   8. Print summary line
 *
 * Entire flow is advisory: does not call finding_add against active stories; does not throw; does not block gates.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { HandlerContext } from './context.js';
import { resolveAuditConfig, type AuditConfig, type AuditMode } from '../core/audit-config.js';
import { loadConfig } from '../core/config.js';
import type { WorkflowProfile } from '../core/types.js';
import {
  ensureMetaStory,
  beginRound,
  recordRound,
  upsertDrift,
  autoResolveMissing,
  driftHash,
  META_STORY_ID,
} from '../core/audit-meta-store.js';
import { runMechanicalAudit, type DriftCandidate, type SkippedEntry } from '../core/audit-scan.js';
import { stateFilePath } from '../core/audit-trigger.js';
import { withReentrantMainWriteLock } from '../core/main-write-lock.js';
import { resolveMainRepoRoot } from '../core/partial-done-recovery.js';

export interface AuditArgs {
  framework?: boolean;
  mode?: AuditMode; // CLI can override config default
}

export interface AuditResult {
  status: 'disabled' | 'completed';
  mode?: AuditMode;
  round?: number;
  newCount?: number;
  stillDriftingCount?: number;
  resolvedCount?: number;
  skippedCount?: number;
  reportPath?: string;
}

/**
 * Named return type for the audit handler. Uses an intersection type to combine named fields +
 * the index signature required by registerBatch: named field `audit` preserves parameter/return type constraints (F-002), while the index
 * signature lets createAuditHandlers's return be fed to registerBatch(map: Record<string, HandlerFn>).
 */
export type AuditHandlers = {
  audit(args?: AuditArgs): string | AuditResult;
} & Record<string, (...args: any[]) => any>;

/**
 * A single audit drift row (shared by rowsNew / rowsStill / ReportInputs):
 * Extends the raw DriftCandidate with "this round's status + finding metadata returned by upsert".
 */
interface AuditRowEntry extends DriftCandidate {
  status: string;
  firstSeenRound: number;
  lastSeenAt: string;
  findingId: string;
}

export function createAuditHandlers(ctx: HandlerContext): AuditHandlers {
  const { store, root } = ctx;
  return {
    audit(args: AuditArgs = {}): string | AuditResult {
      // B-a2c4: fail-fast if ctx.root is not the repo root, otherwise audit will silently write report to
      // subdirectory (e.g. packages/koala/docs/...) rather than the repo root docs/.... Marker: .git exists
      // (under a worktree .git is a file, under the main repo it is a directory; existsSync returns true for both).
      if (!existsSync(join(root, '.git'))) {
        throw new Error(
          `audit must run from repo root (got: ${root}). ` +
          `Set KOALA_PROJECT_ROOT or cd to the directory containing .git.`
        );
      }

      const cfg = loadConfig(root);
      const profile: WorkflowProfile = cfg.workflow?.profile ?? 'balanced';
      const auditCfg: AuditConfig = resolveAuditConfig(profile, root);
      const effectiveMode: AuditMode = args.mode ?? auditCfg.mode;

      // MVP only implements --framework; if args.framework is absent it also runs as framework (the only mode)
      if (effectiveMode === 'off') {
        return 'audit disabled (mode=off)';
      }

      // 1. Locate the two CLAUDE.md entries (hardcoded, not extensible)
      const mdEntries = [
        join(root, 'CLAUDE.md'),
        join(root, 'packages', 'koala', 'CLAUDE.md'),
      ].filter(p => existsSync(p));

      if (mdEntries.length === 0) {
        return 'audit: no CLAUDE.md entries found, nothing to audit';
      }

      // 3. scanner (B-805f CHK-003: pass registryNames for docs-drift advisory scan)
      //    Read-only mechanical scan — kept OUTSIDE the main write lock so the
      //    lock only spans the actual B-META / state mutations below.
      const report = runMechanicalAudit(mdEntries, root, {
        registryNames: ctx.getAllToolNames?.(),
      });

      // B-f60c CHK-003: every B-META mutation below (ensureMetaStory, beginRound
      // round bookkeeping, upsertDrift, autoResolveMissing, recordRound) plus
      // the report.md / state.json writes mutate shared main / B-META state, so
      // they must be serialized under the main write lock
      // (session-ownership-and-write-leases.md Rule 5).
      //
      // The lock MUST be reentrant: `audit` runs in-process inside the DONE
      // critical section (applyDoneMergeEffects → maybeTriggerAudit →
      // full-auto runAuditInProcess → this handler), and the DONE flow already
      // holds the lock. A non-reentrant acquire would self-deadlock / fail-fast
      // there. `withReentrantMainWriteLock` makes the nested call a pass-through.
      const mainRepoRoot = resolveMainRepoRoot(root);
      const auditOutcome = withReentrantMainWriteLock(mainRepoRoot, () => {
        // 2. meta-story + round
        ensureMetaStory(store);
        const round = beginRound(store);

        // 4. upsertDrift
        const seenHashes = new Set<string>();
        let newCount = 0;
        let stillDriftingCount = 0;
        const rowsNew: AuditRowEntry[] = [];
        const rowsStill: AuditRowEntry[] = [];

        for (const d of report.drifts) {
          const h = driftHash(d.sectionPath, d.symbol, d.driftType);
          seenHashes.add(h);
          const r = upsertDrift(store, round, {
            sectionPath: d.sectionPath,
            symbol: d.symbol,
            driftType: d.driftType,
            desc: d.desc,
            severity: d.severity,
          });
          // Read back the finding to get firstSeenRound / lastSeenAt (audit-meta-store already wrote them)
          const data = store.readFindings(META_STORY_ID);
          const f = data.findings.find(x => x.id === r.findingId);
          const row = {
            ...d,
            status: r.state,
            firstSeenRound: f?.firstSeenRound ?? round,
            lastSeenAt: f?.lastSeenAt ?? new Date().toISOString(),
            findingId: r.findingId,
          };
          if (r.state === 'new') { newCount++; rowsNew.push(row); }
          else { stillDriftingCount++; rowsStill.push(row); }
        }

        // 5. autoResolveMissing
        const resolvedIds = autoResolveMissing(store, round, seenHashes);
        const resolvedCount = resolvedIds.length;

        // Record this round to meta-story.events (so beginRound can increment next time)
        try { recordRound(store, round); } catch {/* advisory */}

        // 6. report.md
        const reportPath = writeReport({
          root,
          round,
          rowsNew,
          rowsStill,
          resolvedIds,
          skipped: report.skipped,
        });

        // 7. state.json lastAuditAt
        try {
          touchAuditState(root, { lastAuditAt: new Date().toISOString() });
        } catch { /* advisory */ }

        return { round, newCount, stillDriftingCount, resolvedCount, reportPath };
      }, { label: 'audit --framework' });

      const { round, newCount, stillDriftingCount, resolvedCount, reportPath } = auditOutcome;

      // 8. summary line
      const line = `✓ Framework audit round ${round} complete: ${newCount} new drift / ${stillDriftingCount} still-drifting / ${resolvedCount} resolved-by-nature`;
      console.log(line);
      if (report.skipped.length > 0) {
        console.log(`  (skipped ${report.skipped.length} — see report)`);
      }
      console.log(`  report: ${reportPath}`);

      return {
        status: 'completed',
        mode: effectiveMode,
        round,
        newCount,
        stillDriftingCount,
        resolvedCount,
        skippedCount: report.skipped.length,
        reportPath,
      };
    },
  };
}

interface ReportInputs {
  root: string;
  round: number;
  rowsNew: AuditRowEntry[];
  rowsStill: AuditRowEntry[];
  resolvedIds: string[];
  skipped: SkippedEntry[];
}

function writeReport(inp: ReportInputs): string {
  const dateStr = localDateIsoDay();
  const dir = join(inp.root, 'docs', 'koala', 'framework-audit', dateStr);
  mkdirSync(dir, { recursive: true });
  const out = join(dir, 'report.md');

  const lines: string[] = [];
  lines.push(`# Framework Audit Report — round ${inp.round} (${dateStr})`);
  lines.push('');
  lines.push(`- new drift: ${inp.rowsNew.length}`);
  lines.push(`- still-drifting: ${inp.rowsStill.length}`);
  lines.push(`- resolved-by-nature: ${inp.resolvedIds.length}`);
  lines.push(`- skipped: ${inp.skipped.length}`);
  lines.push('');

  const rows = [...inp.rowsNew, ...inp.rowsStill];
  lines.push('## Drifts');
  lines.push('');
  if (rows.length === 0) {
    lines.push('_no drift_');
  } else {
    lines.push('| drift-type | section-path | symbol | severity | status | firstSeenRound | lastSeenAt |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const r of rows) {
      lines.push(`| ${r.driftType} | ${esc(r.sectionPath)} | ${esc(r.symbol)} | ${r.severity} | ${r.status} | ${r.firstSeenRound} | ${r.lastSeenAt} |`);
    }
  }
  lines.push('');

  lines.push('## Resolved this round (drift cleared)');
  lines.push('');
  if (inp.resolvedIds.length === 0) lines.push('_none_');
  else for (const id of inp.resolvedIds) lines.push(`- ${id}`);
  lines.push('');

  lines.push('## Skipped');
  lines.push('');
  if (inp.skipped.length === 0) lines.push('_none_');
  else {
    lines.push('| drift-type | section-path | symbol | reason |');
    lines.push('|---|---|---|---|');
    for (const s of inp.skipped) {
      lines.push(`| ${s.driftType} | ${esc(s.sectionPath)} | ${esc(s.symbol)} | ${s.reason} |`);
    }
  }
  lines.push('');

  writeFileSync(out, lines.join('\n'), 'utf-8');
  return out;
}

function esc(s: string): string {
  return s.replace(/\|/g, '\\|');
}

function localDateIsoDay(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * touchAuditState: only updates the lastAuditAt field of state.json.
 *
 * Deliberately kept narrow here: CHK-003 will extend with {lastAuditCommit, doneSinceLastAudit, lastAuditStoryId}
 * and similar fields — CHK-001 first writes the "read + partial-field patch + write" skeleton, and CHK-003 only needs to extend the patch
 * type, without having to rewrite the file I/O.
 *
 * Read/write failures do not throw (advisory); JSON parse failure → fall back to empty object and rewrite.
 *
 * Module-internal use (not exported) — the source of truth for the state.json path is unified in audit-trigger.stateFilePath.
 */
function touchAuditState(repoRoot: string, patch: Record<string, unknown>): string {
  const path = stateFilePath(repoRoot);
  let current: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      current = JSON.parse(readFileSync(path, 'utf-8')) || {};
      if (typeof current !== 'object' || Array.isArray(current)) current = {};
    } catch { current = {}; }
  }
  const next = { ...current, ...patch };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n', 'utf-8');
  return path;
}
