/**
 * Guard session doctor scan — read-only diagnostic for `lattice doctor`.
 *
 * Reports:
 *   (1) Whether a Claude Code PreToolUse hook is installed in
 *       `.claude/settings.json` at the project root.
 *   (2) For every story that has a non-stopped guard session: provider,
 *       guardMode, status, violation count.
 *
 * "Never overclaim active" rule: when guardMode is recorded as 'active'
 * (provider = claude / claude-code / …) but no PreToolUse hook is found in
 * `.claude/settings.json`, the render emits a ⚠ warning explaining that the
 * guard session cannot intercept writes before they happen.
 *
 * The scan is read-only — it never modifies a guard session file.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GuardSessionData } from './types.js';
import type { StoryStore } from './store.js';

/** Outcome of checking the `.claude/settings.json` PreToolUse hook. */
export interface PreToolUseHookStatus {
  /** Absolute path to `.claude/settings.json` that was checked. */
  settingsPath: string;
  /** True when the file exists and has at least one `PreToolUse` hook entry. */
  installed: boolean;
  /** Number of PreToolUse hook entries registered. */
  hookCount: number;
}

/** One story's guard session state as reported by doctor. */
export interface GuardSessionDoctorItem {
  storyId: string;
  provider: string;
  guardMode: GuardSessionData['guardMode'];
  sessionStatus: GuardSessionData['status'];
  violationCount: number;
  startedAt: string;
  updatedAt: string;
}

/** Aggregate result of scanning guard sessions across all active stories. */
export interface GuardSessionDoctorScan {
  /** PreToolUse hook installation state. */
  preToolUseHook: PreToolUseHookStatus;
  /** All guard sessions found (excludes stories with no guard-session.json). */
  sessions: GuardSessionDoctorItem[];
  /** Sessions that are not 'stopped'. */
  active: GuardSessionDoctorItem[];
  /** Sessions that have at least one recorded violation. */
  withViolations: GuardSessionDoctorItem[];
  /**
   * Sessions where guardMode='active' but PreToolUse hook is not installed.
   * These are potentially misconfigured — the session will behave like
   * watcher-fallback in practice even though guardMode says 'active'.
   */
  activeMissingHook: GuardSessionDoctorItem[];
}

/**
 * Check whether a Claude Code `PreToolUse` hook is registered in
 * `<projectRoot>/.claude/settings.json`.
 *
 * Returns `installed: false` when the file is absent, unreadable, or has no
 * `hooks.PreToolUse` entries.
 */
export function scanPreToolUseHook(projectRoot: string): PreToolUseHookStatus {
  const settingsPath = join(projectRoot, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) {
    return { settingsPath, installed: false, hookCount: 0 };
  }
  let raw: string;
  try {
    raw = readFileSync(settingsPath, 'utf-8');
  } catch {
    // PROBE: unreadable settings.json — report as not-installed, not a crash.
    return { settingsPath, installed: false, hookCount: 0 };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // PROBE: malformed JSON — report as not-installed.
    return { settingsPath, installed: false, hookCount: 0 };
  }
  const hooks = (parsed as Record<string, unknown>)?.hooks;
  if (!hooks || typeof hooks !== 'object') {
    return { settingsPath, installed: false, hookCount: 0 };
  }
  const preToolUse = (hooks as Record<string, unknown>)?.PreToolUse;
  if (!Array.isArray(preToolUse) || preToolUse.length === 0) {
    return { settingsPath, installed: false, hookCount: 0 };
  }
  // Count inner hook entries (each outer entry may have its own `hooks` array).
  let hookCount = 0;
  for (const entry of preToolUse) {
    const inner = (entry as Record<string, unknown>)?.hooks;
    if (Array.isArray(inner)) {
      hookCount += inner.length;
    } else {
      // Treat flat entries as a single hook.
      hookCount += 1;
    }
  }
  return { settingsPath, installed: hookCount > 0, hookCount };
}

/**
 * Scan all active stories for guard sessions and aggregate the results.
 *
 * Stories with no `guard-session.json` are silently skipped. Corrupt or
 * unreadable sessions are also skipped — a missing session is never flagged
 * as a problem.
 */
export function scanGuardSessions(
  store: StoryStore,
  projectRoot: string,
): GuardSessionDoctorScan {
  const preToolUseHook = scanPreToolUseHook(projectRoot);

  let storyIds: string[] = [];
  try {
    storyIds = store.listStoryIds();
  } catch {
    // PROBE: unreadable actives directory yields an empty scan.
    return {
      preToolUseHook,
      sessions: [],
      active: [],
      withViolations: [],
      activeMissingHook: [],
    };
  }

  const sessions: GuardSessionDoctorItem[] = [];
  for (const storyId of storyIds) {
    let session: GuardSessionData | null = null;
    try {
      session = store.readGuardSession(storyId);
    } catch {
      // PROBE: corrupt guard-session.json — skip silently.
      continue;
    }
    if (!session) continue;
    sessions.push({
      storyId,
      provider: session.provider,
      guardMode: session.guardMode,
      sessionStatus: session.status,
      violationCount: session.violations.length,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
    });
  }

  sessions.sort((a, b) => a.storyId.localeCompare(b.storyId));

  const active = sessions.filter((s) => s.sessionStatus !== 'stopped');
  const withViolations = sessions.filter((s) => s.violationCount > 0);
  const activeMissingHook = active.filter(
    (s) => s.guardMode === 'active' && !preToolUseHook.installed,
  );

  return { preToolUseHook, sessions, active, withViolations, activeMissingHook };
}

/**
 * Render the guard session scan as `lattice doctor` text-report lines.
 *
 * Style mirrors `renderStoryOwnerLeaseScan`: ✓ when healthy, ⚠ per problem.
 */
export function renderGuardSessionDoctorSection(scan: GuardSessionDoctorScan): string[] {
  const lines: string[] = [];
  lines.push('Guard session scan:');

  const hookLabel = scan.preToolUseHook.installed
    ? `installed (${scan.preToolUseHook.hookCount} hook${scan.preToolUseHook.hookCount !== 1 ? 's' : ''})`
    : 'not installed';
  lines.push(`  PreToolUse hook (Claude Code): ${hookLabel}`);
  lines.push(`  sessions found : ${scan.sessions.length} (${scan.active.length} active, ${scan.withViolations.length} with violations)`);

  if (scan.active.length === 0 && scan.withViolations.length === 0) {
    lines.push('  ✓ No active guard sessions.');
    if (!scan.preToolUseHook.installed) {
      lines.push(
        '  ℹ PreToolUse hook is not installed. Future guard sessions started with',
        '    provider=claude-code will operate in watcher-fallback mode in practice.',
        '    See docs/guide-scope-guard.md for installation instructions.',
      );
    }
    return lines;
  }

  for (const item of scan.active) {
    const modeLabel = item.guardMode === 'active' ? 'active (pre-tool blocking)' : item.guardMode;
    const violLabel = item.violationCount > 0 ? `, ⚠ ${item.violationCount} violation(s)` : '';
    if (item.guardMode === 'active' && !scan.preToolUseHook.installed) {
      lines.push(
        `  ⚠ ${item.storyId}: guardMode=${item.guardMode} (${item.provider}) but PreToolUse hook is not installed`,
      );
      lines.push(
        `    status=${item.sessionStatus}${violLabel}`,
        `    → Without the PreToolUse hook, forbidden writes cannot be intercepted before they land.`,
        `    → The guard session will detect violations after the fact (watcher-fallback in practice).`,
        `    → See docs/guide-scope-guard.md to install the hook and enable true pre-tool blocking.`,
      );
    } else {
      const statusIcon = item.violationCount > 0 ? '⚠' : '✓';
      lines.push(
        `  ${statusIcon} ${item.storyId}: ${modeLabel}, provider=${item.provider}, status=${item.sessionStatus}${violLabel}`,
      );
    }
  }

  if (scan.withViolations.length > 0) {
    lines.push(
      '',
      `  → Run: lattice guard_session_check '{"storyId":"<id>"}' to see violation details.`,
      `  → Resolve by removing out-of-scope changes or running scope_contract_acknowledge.`,
    );
  }

  return lines;
}
