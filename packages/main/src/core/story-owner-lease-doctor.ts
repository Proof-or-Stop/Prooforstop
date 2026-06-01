/**
 * B-c55d CHK-005: doctor stale story-owner-lease check.
 *
 * `koala doctor` scans every active story's `owner-lease.json`
 * (`.koala/story/actives/<storyId>/owner-lease.json`) and reports whether any
 * of them is STALE — i.e. its `heartbeatAt` has not advanced for at least
 * `STALE_LEASE_THRESHOLD_MS` (30 minutes), the exact same threshold the gate /
 * `--takeover` path uses (`isLeaseStale`).
 *
 * This is the story-owner-lease analogue of `main-write-lock-doctor.ts`'s
 * stuck-lock check: an ACTIVE lease (heartbeat within the 30-minute window) is
 * reported as healthy and never misflagged; only a STALE lease — exactly what a
 * `--takeover` would be allowed to seize — is surfaced to the operator with the
 * owning sessionId and the heartbeat age.
 *
 * The scan is read-only: it never transfers, releases, or rewrites a lease. It
 * only reads `owner-lease.json` via `readOwnerLease` and classifies it.
 */

import {
  formatLeaseAge,
  isLeaseStale,
  ownerLeasePath,
  readOwnerLease,
} from './story-owner-lease.js';
import { TERMINAL_PHASES } from './phase-flow.js';
import type { StoryStore } from './store.js';

/** Classification of one story's owner-lease state. */
export type OwnerLeaseState = 'absent' | 'active' | 'stale';

/** One scanned story's owner-lease verdict. */
export interface StoryOwnerLeaseScanItem {
  /** The story id whose `owner-lease.json` was scanned. */
  storyId: string;
  /** Absolute path of the `owner-lease.json` that was scanned. */
  leasePath: string;
  /** `absent` = no lease file; `active` = heartbeat within 30min; `stale` = past it. */
  state: OwnerLeaseState;
  /** Current story phase when readable; null when the story record could not be read. */
  phase: string | null;
  /** Terminal stories keep lease history, but their stale leases are not takeover actions. */
  terminal: boolean;
  /** Owning session id (`null` when there is no readable lease). */
  ownerSessionId: string | null;
  /** Owning session's cwd (`null` when there is no readable lease). */
  ownerCwd: string | null;
  /** Age of the last heartbeat in ms (0 when absent / unparseable). */
  heartbeatAgeMs: number;
  /** Human-readable heartbeat age (`8m` / `2h`); empty when absent. */
  heartbeatAgeLabel: string;
}

/** Aggregate result of scanning all active stories' owner leases. */
export interface StoryOwnerLeaseScan {
  /** Every story that has a lease file on disk (absent-lease stories are skipped). */
  leases: StoryOwnerLeaseScanItem[];
  /** Stale leases on non-terminal stories — the ones the operator must act on. */
  stale: StoryOwnerLeaseScanItem[];
  /** Stale leases on DONE/DISCARDED stories, summarized as lifecycle history. */
  terminalStale: StoryOwnerLeaseScanItem[];
}

/**
 * Scan every active story's `owner-lease.json` and classify each as
 * `absent` / `active` / `stale`.
 *
 * `now` is injectable for deterministic tests; production callers omit it and
 * get `Date.now()` so the stale verdict lines up exactly with the gate's
 * `isLeaseStale`. A story whose `index.json` cannot be read, or whose lease is
 * corrupt / absent, contributes nothing to `leases` — only stories with a
 * readable lease are reported, so an absent lease is never misflagged as a
 * problem.
 */
export function scanStoryOwnerLeases(
  store: StoryStore,
  now: number = Date.now(),
): StoryOwnerLeaseScan {
  // Runtime re-validation: a non-finite clock would make every age NaN and
  // could classify a fresh lease as stale. Fall back to the real clock.
  const reference = Number.isFinite(now) ? now : Date.now();

  const leases: StoryOwnerLeaseScanItem[] = [];
  let storyIds: string[] = [];
  try {
    storyIds = store.listStoryIds();
  } catch {
    // PROBE: an unreadable actives directory yields no leases (not a crash).
    return { leases: [], stale: [], terminalStale: [] };
  }

  for (const storyId of storyIds) {
    let storyDir: string;
    try {
      storyDir = store.storyDirPath(storyId);
    } catch {
      continue;
    }
    let phase: string | null = null;
    let terminal = false;
    try {
      const story = store.readStory(storyId);
      phase = typeof story.phase === 'string' ? story.phase : null;
      terminal = phase !== null && (TERMINAL_PHASES as readonly string[]).includes(phase);
    } catch {
      // PROBE: an unreadable story should not hide an actionable stale lease.
      phase = null;
      terminal = false;
    }

    // `readOwnerLease` returns null for an absent OR corrupt lease — both mean
    // "no trustworthy ownership record", so neither is reported as stale.
    const lease = readOwnerLease(storyDir);
    if (lease === null) continue;

    const heartbeatMs = Date.parse(lease.heartbeatAt);
    // An unparseable heartbeat is conservatively stale (same as `isLeaseStale`);
    // its age has no meaningful value, so it renders as 0.
    const heartbeatAgeMs = Number.isFinite(heartbeatMs)
      ? Math.max(0, reference - heartbeatMs)
      : 0;
    const stale = isLeaseStale(lease, reference);
    leases.push({
      storyId,
      leasePath: ownerLeasePath(storyDir),
      state: stale ? 'stale' : 'active',
      phase,
      terminal,
      ownerSessionId: lease.sessionId,
      ownerCwd: lease.cwd,
      heartbeatAgeMs,
      heartbeatAgeLabel: Number.isFinite(heartbeatMs) ? formatLeaseAge(heartbeatAgeMs) : 'unknown',
    });
  }

  leases.sort((a, b) => a.storyId.localeCompare(b.storyId));
  return {
    leases,
    stale: leases.filter((l) => l.state === 'stale' && !l.terminal),
    terminalStale: leases.filter((l) => l.state === 'stale' && l.terminal),
  };
}

/**
 * Render the owner-lease scan as `koala doctor` text-report lines.
 *
 * Returns the lines for the "Story owner leases:" section body. The style
 * mirrors `renderMainWriteLockScan`: a `✓` healthy line when there is nothing
 * stale, and a `⚠` block per stale lease naming the story / owner sessionId /
 * heartbeat age plus the `--takeover` recovery hint.
 */
export function renderStoryOwnerLeaseScan(scan: StoryOwnerLeaseScan): string[] {
  const lines: string[] = [];
  lines.push('Story owner leases:');
  lines.push(`  lease files  : ${scan.leases.length}`);
  lines.push(`  stale leases : ${scan.stale.length}`);
  if (scan.terminalStale.length > 0) {
    lines.push(`  terminal stale leases: ${scan.terminalStale.length} (summarized; not actionable)`);
  }

  if (scan.stale.length === 0) {
    lines.push('  ✓ No actionable stale story owner leases — active owner leases have a fresh heartbeat.');
    if (scan.terminalStale.length > 0) {
      const preview = scan.terminalStale.slice(0, 5).map((item) => `${item.storyId}${item.phase ? `:${item.phase}` : ''}`);
      const suffix = scan.terminalStale.length > preview.length ? `, +${scan.terminalStale.length - preview.length} more` : '';
      lines.push(
        `  ↳ ${scan.terminalStale.length} terminal stale lease(s) kept as lifecycle history, not takeover actions: ` +
        `${preview.join(', ')}${suffix}`,
      );
    }
    return lines;
  }

  for (const item of scan.stale) {
    lines.push(
      `  ⚠ STALE owner lease for ${item.storyId}: owned by session ${item.ownerSessionId ?? 'unknown'}, ` +
      `heartbeat ${item.heartbeatAgeLabel} ago (owner cwd: ${item.ownerCwd ?? 'unknown'}).`,
    );
    lines.push(`  → path: ${item.leasePath}`);
  }
  lines.push(
    '  → A stale lease (no heartbeat for 30+ minutes) likely belongs to a dead session. ' +
    'Rerun the owner-gated command with --takeover to transfer it.',
  );
  if (scan.terminalStale.length > 0) {
    lines.push(
      `  ↳ ${scan.terminalStale.length} terminal stale lease(s) summarized as lifecycle history; ` +
      'DONE/DISCARDED stories do not need --takeover.',
    );
  }
  return lines;
}
