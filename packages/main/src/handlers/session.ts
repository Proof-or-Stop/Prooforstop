/**
 * lattice session_brief — cross-session opening brief
 *
 * Design purpose:
 *   When a new Claude session starts, it doesn't know "where we left off last time, what happened recently".
 *   Previously you had to run lattice story_list / story_get / checklist_get in sequence to piece it together.
 *   session_brief is a single-shot command: run it once to get the full context + what should be done.
 *
 *   CLAUDE.md requires running this command as the first thing in every new session.
 *
 * Output includes:
 *   - active story summary (id/phase/title)
 *   - checklist status (N done / M in_progress / K pending, list in_progress)
 *   - last test result (from test-evidence.json)
 *   - bug status (open/fixed counts)
 *   - recent N activity entries (from activity.jsonl)
 *   - git status summary
 *   - "what should be done now" inferred by computeNextStep
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, realpathSync } from 'fs';
import { isAbsolute, join, relative } from 'path';
import type { HandlerContext } from './context.js';
import { formatStoryOutcomeKind, normalizeStoryOutcomeKind, type StoryInfo, type ChecklistData, type BugData, type StoryOutcomeKind } from '../core/types.js';
import { detectZombieStories } from './story-query.js';
import { StoryStore } from '../core/store.js';
import { formatProcessMetricsSummary } from '../core/process-metrics.js';
import { readActivityLogTail } from '../core/activity-log.js';
import { summarizeReviewerStatus, type ReviewerStatusSummary } from '../core/reviewer-status.js';
import { renderAntiStall, reviewAntiStall, testAntiStall } from '../core/anti-stall.js';
import { gitProbe, isGitRepository } from '../core/git-probe.js';
import { loadConfig } from '../core/config.js';
import { buildDoneChecklist, type DoneCheckRow } from '../core/done-oracle.js';
import { isBlockingOracleRow } from '../core/oracle-row.js';
import { buildMainSyncReadiness, renderMainSyncReadinessAdvisory } from '../core/lifecycle-readiness.js';
import { findStaleEvidence, renderEvidenceStaleHint } from '../core/evidence-stale-hint.js';
import { currentGitHead, tryCaptureEvidenceHashSnapshot } from '../core/evidence-freshness.js';
import { getSessionId, summarizeOwnerLease, type OwnerLeaseView } from '../core/story-owner-lease.js';
import { renderCapsuleBrief, validateCapsuleRefs } from '../core/story-capsule.js';
import { buildScopeProtectionSummary, renderScopeProtectionSummary } from '../core/review-scope-binding.js';
import { buildScopeDiffPack } from '../core/scope-diff-pack.js';
import type { ScopeContractData, GuardSessionData, ScopeDiffPack, ReviewRun } from '../core/types.js';
import { initCheckAttestationMode } from '../core/init-check-gate.js';
import { listActiveLoops, deriveLatestLoopRecord } from '../core/review-loop.js';
import type { ReviewLoopIteration } from '../core/types.js';
import { renderScopeAntiExpansionSummary } from '../core/machine.js';
import { evaluateStoryDirConfigInsideGitRoot } from '../core/story-signed-workspace-resolution.js';
import { evaluateStoryEvidenceBindingGate } from '../core/repro-evidence-binding-gate.js';

interface ActiveStoryDetected {
  storyId: string;
  story: StoryInfo;
}

function emptyDoneOutcomes(): Record<StoryOutcomeKind, number> {
  return { success: 0, blocked: 0, audit_only: 0 };
}

function renderDoneOutcomes(outcomes: Record<StoryOutcomeKind, number>): string {
  return [
    `DONE-${formatStoryOutcomeKind('success')}/default=${outcomes.success}`,
    `DONE-${formatStoryOutcomeKind('blocked')}=${outcomes.blocked}`,
    `DONE-${formatStoryOutcomeKind('audit_only')}=${outcomes.audit_only}`,
  ].join(' ');
}

function renderReproFirstIntakeLine(projectRoot: string, store: StoryStore, storyId: string): string | null {
  try {
    const result = evaluateStoryEvidenceBindingGate(projectRoot, store, storyId);
    let status: string;
    if (result.reasonCode === 'repro_first_preflight_engine_error') {
      status = 'engine-error';
    } else if (!result.required) {
      status = result.mode === 'off' ? 'off' : 'bypass-eligible';
    } else if (result.bindingArtifactId) {
      status = `bound-accepted(${result.bindingArtifactId})`;
    } else if (result.reasonCode === 'missing_story_evidence_binding') {
      status = result.blocking ? 'missing(blocking)' : 'missing(warn)';
    } else if (result.reasonCode === 'stale_story_evidence_binding') {
      status = result.blocking ? 'stale(blocking)' : 'stale(warn)';
    } else {
      status = result.ok ? 'bound-accepted' : 'missing';
    }
    const detail = result.details[0] ? ` — ${result.details[0]}` : '';
    return `  reproFirst: ${status}; mode=${result.mode}${detail}`;
  } catch {
    return null;
  }
}

function detectActiveStoryFromGit(ctx: HandlerContext): ActiveStoryDetected | null {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: ctx.root,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!branch.startsWith('story/')) return null;
    const storyId = branch.slice('story/'.length);
    if (!storyId) return null;
    try {
      const story = ctx.store.readStory(storyId);
      return { storyId, story };
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

function readActivityTail(root: string, lines: number): Array<{
  timestamp: string;
  tool: string;
  status: string;
  source: string;
  role: string;
  storyId: string | null;
}> {
  try {
    // readActivityLogTail returns newest-first; reverse to match old
    // chronological order expected by callers that .reverse() for display.
    const entries = readActivityLogTail(root, lines).reverse();
    return entries.map(r => ({
      timestamp: String(r.startTime || r.endTime || ''),
      tool: String(r.tool || r.detail || '?'),
      status: String(r.status || '?'),
      source: String(r.source || 'unknown'),
      role: String(r.role || 'unknown'),
      storyId: (r.storyId as string) || null,
    }));
  } catch {
    return [];
  }
}

function renderActivityLine(a: { timestamp: string; tool: string; status: string; source: string; role: string; storyId: string | null }): string {
  const story = a.storyId ? ` (${a.storyId})` : '';
  return `${a.timestamp} ${a.tool} [${a.source}/${a.role}/${a.status}]${story}`;
}

function readGitStatus(root: string): { porcelain: string[]; recentLog: string[] } {
  const porcelain: string[] = [];
  const recentLog: string[] = [];
  const gitCwd = root;
  try {
    const status = execSync('git status --porcelain', { cwd: gitCwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (status) porcelain.push(...status.split('\n').slice(0, 20));
  } catch { /* not a git repo */ }
  try {
    const log = execSync('git log -3 --oneline', { cwd: gitCwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (log) recentLog.push(...log.split('\n'));
  } catch { /* no commits */ }
  return { porcelain, recentLog };
}

interface ConfiguredGitRootSessionStatus {
  configuredGitRoot: string;
  signedWorkspaceRoot: string | null;
  resolutionSource: 'configured-git-root' | 'unresolved';
  unresolvedReason: string | null;
}

function readConfiguredGitRootSessionStatus(root: string, metadataRootGitBacked: boolean): ConfiguredGitRootSessionStatus | null {
  if (metadataRootGitBacked) return null;
  let configuredGitRoot: string | undefined;
  try {
    configuredGitRoot = loadConfig(root).gitRoot;
  } catch {
    return null;
  }
  const raw = configuredGitRoot?.trim();
  if (!raw) return null;

  const metadataRoot = canonicalPath(root);
  const candidate = canonicalPath(isAbsolute(raw) ? raw : join(metadataRoot, raw));
  if (!isPathInside(metadataRoot, candidate)) {
    return unresolvedConfiguredGitRoot(raw, 'configured_gitRoot_outside_metadata_root');
  }
  if (!existsSync(candidate)) {
    return unresolvedConfiguredGitRoot(raw, 'configured_gitRoot_missing');
  }
  const probe = gitProbe('git rev-parse --show-toplevel', { cwd: candidate });
  if (!probe.ok) {
    return unresolvedConfiguredGitRoot(raw, 'configured_gitRoot_is_not_git_repository');
  }
  const topLevel = canonicalPath(probe.output);
  if (topLevel !== candidate) {
    return unresolvedConfiguredGitRoot(raw, 'configured_gitRoot_is_not_git_root');
  }
  return {
    configuredGitRoot: raw,
    signedWorkspaceRoot: topLevel,
    resolutionSource: 'configured-git-root',
    unresolvedReason: null,
  };
}

function unresolvedConfiguredGitRoot(configuredGitRoot: string, unresolvedReason: string): ConfiguredGitRootSessionStatus {
  return {
    configuredGitRoot,
    signedWorkspaceRoot: null,
    resolutionSource: 'unresolved',
    unresolvedReason,
  };
}

function renderConfiguredGitRootSessionStatus(status: ConfiguredGitRootSessionStatus | null): string[] {
  if (!status) return [];
  const lines: string[] = [];
  lines.push('');
  lines.push('## Signed workspace');
  if (status.signedWorkspaceRoot && status.resolutionSource === 'configured-git-root') {
    lines.push('  Signed workspace: OK');
    lines.push(`  configured gitRoot: ${status.configuredGitRoot}`);
    lines.push(`  resolutionSource: ${status.resolutionSource}`);
    lines.push(`  signedWorkspaceRoot: ${status.signedWorkspaceRoot}`);
  } else {
    lines.push('  Signed workspace: unresolved');
    lines.push(`  configured gitRoot: ${status.configuredGitRoot}`);
    lines.push('  resolutionSource: unresolved');
    lines.push(`  Reason: ${status.unresolvedReason || 'configured_gitRoot_unresolved'}`);
  }
  return lines;
}

function renderNonGitProjectNotice(status: ConfiguredGitRootSessionStatus | null, initCheckText: string): string {
  if (status?.signedWorkspaceRoot && status.resolutionSource === 'configured-git-root') {
    return 'Note: Metadata root is not a git repo; configured gitRoot supplies the signed workspace for git-backed operations.';
  }
  return initCheckText;
}

/**
 * B-198c CHK-003: render the one-line "storyDir resolves outside the resolved
 * gitRoot" advisory for session_brief, or [] when there is nothing to surface.
 *
 * Reuses the id-independent CHK-002 helper {@link evaluateStoryDirConfigInsideGitRoot}
 * (DO NOT re-derive the check). Surfaces the same dead-end early-warning that
 * story_create emits to stderr, here in the brief so users see it at session
 * start — the git-backed worktree/DONE lifecycle hard-fails at INIT_CHECK when
 * story metadata cannot be committed inside the gitRoot.
 *
 * Only the `outside-gitroot` violation produces a line. `ok=true` (inside) and
 * `reason='gitroot-unresolved'` (no/invalid gitRoot — the normal non-git
 * metadata-root case already shown by the Signed-workspace section) both stay
 * silent so the brief never nags healthy or not-yet-git-backed setups. Never
 * throws — the underlying helper is pure and total.
 */
function renderStoryDirOutsideGitRootAdvisory(metadataRoot: string): string[] {
  try {
    const result = evaluateStoryDirConfigInsideGitRoot({ metadataRoot });
    if (result.ok || result.reason !== 'outside-gitroot') return [];
    return [
      '',
      `⚠ storyDir resolves outside the resolved gitRoot ` +
        `(${result.storyDirAbs} not inside ${result.gitRootAbs}); ` +
        `the worktree/DONE git lifecycle will fail at INIT_CHECK. ` +
        `→ configure storyDir so story metadata lives inside the gitRoot.`,
    ];
  } catch {
    // Defensive: never block session_brief on advisory-render failure.
    return [];
  }
}

function canonicalPath(path: string): string {
  try {
    return existsSync(path) ? realpathSync(path) : path;
  } catch {
    return path;
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(canonicalPath(root), canonicalPath(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * B-89c7 CHK-016: map of storyId → worktree path, derived from
 * `git worktree list --porcelain`. Used by main-branch brief to show
 * which in-flight stories already have a worktree (so agents can cd
 * directly into them instead of story_advance-ing blindly).
 */
function listActiveWorktrees(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const raw = execSync('git worktree list --porcelain', {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let currentPath = '';
    for (const line of raw.split('\n')) {
      if (line.startsWith('worktree ')) {
        currentPath = line.slice('worktree '.length).trim();
      } else if (line.startsWith('branch ')) {
        const branch = line.slice('branch '.length).trim();
        // refs/heads/story/B-xxx → B-xxx
        const m = branch.match(/refs\/heads\/story\/(.+)$/);
        if (m && currentPath) {
          out[m[1]] = currentPath;
        }
      }
    }
  } catch { /* not a git repo or git worktree unsupported — PROBE, return empty */ }
  return out;
}

function readStoryFromLinkedWorktree(storyId: string, worktreePath: string): { story: StoryInfo; store: StoryStore } | null {
  try {
    const store = new StoryStore(worktreePath);
    return { story: store.readStory(storyId), store };
  } catch {
    return null;
  }
}

/**
 * B-89c7 CHK-013 / CHK-016: tail of tmp/router-log.jsonl as a short
 * Recent-chats summary. Parses the last N entries and extracts
 * model / timing / cache hit rate / tool names. Never throws — if the
 * file doesn't exist yet, or any line fails to parse, the offending
 * record is skipped.
 *
 * cached=0 on a supported provider triggers a ⚠ marker so agents see
 * the B-73e2 CHK-004 byte-stable prompt cache regression signal the
 * next time they open a session.
 */
interface RouterLogSummary {
  model: string;
  totalMs: number;
  beforeMs?: number;
  streamMs?: number;
  afterMs?: number;
  cachedInputTokens?: number;
  promptTokens?: number;
  toolNames: string[];
  cacheWarning: boolean; // true iff cached==0 && provider supports cache
}
function readRouterLogTail(root: string, n: number): RouterLogSummary[] {
  const logPath = join(root, 'tmp', 'router-log.jsonl');
  if (!existsSync(logPath)) return [];
  let raw: string;
  try {
    raw = readFileSync(logPath, 'utf-8');
  } catch { return []; }
  const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const tail = lines.slice(-n);
  const out: RouterLogSummary[] = [];
  for (const line of tail) {
    try {
      const entry = JSON.parse(line);
      const run = entry.actualRun;
      if (!run || typeof run !== 'object' || run === 'abandoned') continue;
      const cached = typeof run.cachedInputTokensTotal === 'number' ? run.cachedInputTokensTotal : undefined;
      const prompt = typeof run.promptTokens === 'number' ? run.promptTokens : undefined;
      out.push({
        model: (run.steps?.[0]?.model as string) || entry.routeDecision?.model || 'unknown',
        totalMs: typeof run.chatMs === 'number' ? run.chatMs : 0,
        beforeMs: typeof run.beforeMs === 'number' ? run.beforeMs : undefined,
        streamMs: typeof run.streamMs === 'number' ? run.streamMs : undefined,
        afterMs: typeof run.afterMs === 'number' ? run.afterMs : undefined,
        cachedInputTokens: cached,
        promptTokens: prompt,
        toolNames: Array.isArray(run.steps)
          ? Array.from(new Set(
              (run.steps as Array<{ toolNames?: string[] }>)
                .flatMap(s => Array.isArray(s.toolNames) ? s.toolNames : []),
            ))
          : [],
        // cached=0 is the red-line signal; cached=undefined means the
        // provider doesn't report cache at all (no warning).
        cacheWarning: cached === 0 && (prompt ?? 0) > 0,
      });
    } catch { /* skip malformed */ }
  }
  return out;
}

/** Render router-log tail as a brief Recent-chats section. Returns lines
 *  array (empty if tail is empty). Used by both active and no-active
 *  branches of session_brief. */
function renderRouterLogTail(tail: RouterLogSummary[]): string[] {
  if (tail.length === 0) return [];
  const lines: string[] = [];
  lines.push('');
  lines.push(`## Recent chats (last ${tail.length})`);
  for (const r of tail) {
    const totalStr = r.totalMs >= 1000 ? `${(r.totalMs / 1000).toFixed(1)}s` : `${r.totalMs}ms`;
    const timingParts: string[] = [];
    if (r.beforeMs !== undefined) timingParts.push(`before ${r.beforeMs}ms`);
    if (r.streamMs !== undefined) timingParts.push(`stream ${r.streamMs >= 1000 ? (r.streamMs / 1000).toFixed(1) + 's' : r.streamMs + 'ms'}`);
    if (r.afterMs !== undefined) timingParts.push(`after ${r.afterMs}ms`);
    const timingStr = timingParts.length > 0 ? ` (${timingParts.join('/')})` : '';
    let cacheStr = '';
    if (r.cachedInputTokens === undefined) {
      cacheStr = ' cached:n/a';
    } else if (r.promptTokens && r.promptTokens > 0) {
      const pct = Math.round((r.cachedInputTokens / r.promptTokens) * 100);
      cacheStr = ` cached:${pct}%${r.cacheWarning ? ' \u26A0' : ''}`;
    }
    const toolsStr = r.toolNames.length > 0
      ? ` tools:[${r.toolNames.slice(0, 3).join(',')}${r.toolNames.length > 3 ? '+' + (r.toolNames.length - 3) : ''}]`
      : ' tools:notool';
    lines.push(`  ${r.model} ${totalStr}${timingStr}${cacheStr}${toolsStr}`);
  }
  return lines;
}

interface ChecklistSummary {
  total: number;
  done: number;
  inProgress: Array<{ id: string; title: string }>;
  pending: Array<{ id: string; title: string }>;
}

function summarizeChecklist(cl: ChecklistData | null): ChecklistSummary | null {
  if (!cl || !Array.isArray(cl.items)) return null;
  const summary: ChecklistSummary = { total: cl.items.length, done: 0, inProgress: [], pending: [] };
  for (const it of cl.items) {
    if (it.status === 'done') summary.done++;
    else if (it.status === 'in_progress') summary.inProgress.push({ id: it.id, title: it.title });
    else summary.pending.push({ id: it.id, title: it.title });
  }
  return summary;
}

export interface NextStepCtx {
  storyId: string;
  phase: string;
  checklist: ChecklistSummary | null;
  hasUnderstanding: boolean;
  hasDecision: boolean;
  bugs: BugData | null;
  hasTestEvidence: boolean;
  hasPassingTestEvidence: boolean;
  testPassedAt: string | null;
  gitReady: boolean;
  /**
   * B-e791 CHK-001: true when the metadata root is not itself a git repo BUT a
   * configured gitRoot resolves to a signed workspace (mirrors the
   * `!gitReady && configuredGitRootStatus?.signedWorkspaceRoot` pattern used in
   * the main-branch next-step render ~918). When set, INIT/INIT_CHECK guidance
   * must NOT tell the user to git init the metadata root — the workspace is
   * already git-backed via the configured gitRoot, so the story is ready to
   * proceed. Plain non-git projects with no configured gitRoot leave this false
   * and keep the existing git-init message byte-identical.
   */
  configuredGitRootResolved: boolean;
  donePrecheck: DonePrecheckSummary | null;
  reviewerStatus: ReviewerStatusSummary | null;
  /**
   * B-b9d0 CHK-004: scope gate blocking signal. When the scope gate fails
   * (path/semantic enforce-fail or guard violations), TEST-phase next-step
   * must NOT recommend DONE before the blocker is resolved.
   */
  scopeBlocking?: { reason: string } | null;
}

interface DonePrecheckSummary {
  rows: DoneCheckRow[];
  blocking: DoneCheckRow[];
  failed: DoneCheckRow[];
  warnings: DoneCheckRow[];
}

function summarizeDonePrecheck(rows: DoneCheckRow[]): DonePrecheckSummary {
  return {
    rows,
    blocking: rows.filter(isBlockingOracleRow),
    failed: rows.filter(r => r.status === 'fail'),
    warnings: rows.filter(r => r.status === 'warn'),
  };
}

function summarizeDonePrecheckActions(rows: DoneCheckRow[]): string {
  const actions = rows.map(row => row.hint || `complete ${row.id}`);
  const unique = [...new Set(actions)];
  return `${unique.join('; ')}; After all pass, run lattice story_advance --phase=DONE`;
}

/** B-a370: META container detection. Audit meta-stories (B-META-* / phase=META)
 *  are permanent audit/finding containers — they never run the normal story
 *  lifecycle, so next/session_brief must not hand them lattice story_advance / worktree
 *  hints. Both criteria are independently sufficient: phase=META is the canonical
 *  marker, the B-META- id prefix is the structural guarantee from audit-meta-store. */
function isMetaContainer(storyId: string, phase: string): boolean {
  return phase === 'META' || storyId.startsWith('B-META-');
}

function metaContainerNextStep(storyId: string): string {
  return `${storyId} is a META container (a long-lived container for audit/finding flow), it does not follow the normal story lifecycle and does not need a worktree. Use \`lattice audit\` to view framework introspection results and \`lattice finding_list\` to handle its findings; do not run lattice story_advance on it or create a worktree.`;
}

/**
 * B-c55d CHK-004: render the `session_brief` story-owner-lease ownership block.
 *
 * Surfaces exactly the `session-ownership-and-write-leases.md` § session_brief
 * Requirements fields: owner session (+ how it was identified), owner cwd,
 * last-heartbeat age, stale/active status, whether the current session is the
 * owner, and the recommended next action (proceed / read-only only / takeover
 * available). The view itself is computed by the pure `summarizeOwnerLease`
 * core so this function is a thin formatter.
 *
 * Returns an empty array when there is no lease on disk (no owner yet) — a
 * story nobody has mutated needs no ownership block; the next mutating command
 * will acquire the lease.
 *
 * Exported so the B-c55d smoke can assert the rendered field set directly as a
 * pure function (the view carries `currentSessionId`, so no process state is
 * read here).
 */
export function renderOwnershipBlock(view: OwnerLeaseView): string[] {
  if (!view.hasLease) return [];
  const lines: string[] = [];
  const statusStr = view.stale ? 'STALE' : 'active';
  lines.push('');
  lines.push(`## Story ownership (${statusStr})`);
  const sourceStr = view.ownerSessionSource ? ` [${view.ownerSessionSource}]` : '';
  lines.push(`  owner session: ${view.ownerSessionId}${sourceStr}`);
  lines.push(`  owner cwd: ${view.ownerCwd}`);
  lines.push(`  last heartbeat: ${view.heartbeatAge}`);
  if (view.isCurrentSessionOwner) {
    lines.push(`  this session: OWNER — you may run story-scoped mutating commands.`);
  } else {
    lines.push(`  this session: NOT owner (${view.currentSessionId}).`);
    if (view.ownerCwdMatchesCurrent) {
      const cwd = view.currentCwd ? ` (${view.currentCwd})` : '';
      lines.push(`  same worktree: owner cwd matches current cwd${cwd}. Treat this as a context switch: run lattice session_brief, confirm no live conflicting session, and use an explicit takeover flag if you intend to transfer the lease.`);
      lines.push(`  same worktree: no lease transfer happens automatically.`);
    }
  }
  // Recommended next action — proceed / read-only / takeover available.
  let rec: string;
  if (view.recommendation === 'proceed') {
    rec = view.isCurrentSessionOwner
      ? 'proceed — you own this story.'
      : 'proceed — no foreign owner.';
  } else if (view.recommendation === 'takeover-available') {
    rec = 'takeover available — the owner lease is stale; rerun a mutating command with --takeover to transfer it, or stay read-only / wait.';
  } else {
    rec = 'read-only only — the owner lease is active; run read-only commands or wait for the owner (rerun with --forceTakeover only as a deliberate human override).';
  }
  lines.push(`  recommended: ${rec}`);
  return lines;
}

/**
 * B-c55d CHK-004: render the B-META shared-audit-state block.
 *
 * B-META containers are NOT normal story-owner-lease subjects — they are the
 * permanent audit/finding container shared across sessions. `session_brief`
 * must show them as shared audit state and must NOT suggest `lattice story_advance`
 * (per § session_brief Requirements). The B-f60c main write lock — not the
 * per-story owner lease — serializes concurrent writes to B-META.
 *
 * Exported so the B-c55d smoke can assert the B-META special-casing directly.
 */
export function renderMetaAuditBlock(storyId: string): string[] {
  return [
    '',
    '## Shared audit state (B-META)',
    `  ${storyId} is the shared framework-audit / finding container, not a normal story.`,
    `  It carries NO per-story owner lease; concurrent writes are serialized by the main write lock.`,
    `  Do not run \`lattice story_advance\` for it — use \`lattice audit\` / \`lattice finding_list\` instead.`,
  ];
}

function normalizeSessionCommandHints(text: string): string {
  return text
    .replace(/(\]\s+)(finding_list|reviewer_list|review_run_start|review_pass_set|story_advance|checklist_get)\b/g, '$1lattice $2');
}

export function computeNextStep(c: NextStepCtx): string {
  const sid = c.storyId;
  if (isMetaContainer(sid, c.phase)) return metaContainerNextStep(sid);
  const openBugs = c.bugs?.bugs.filter(b => b.status === 'open') ?? [];

  switch (c.phase) {
    case 'IDEA':
      return `Story is in IDEA phase with no checklist. After discussing the checklist with the user, append it via lattice checklist_add, or re-run lattice story_create with the checklist field`;
    case 'INIT':
      if (!c.gitReady && !c.configuredGitRootResolved) {
        return `Story is in INIT phase, but the current project is not a git repository. You can continue recording metadata; to enter the INIT_CHECK/worktree flow, first run git init && git add . && git commit -m "init"`;
      }
      return `Story is in INIT phase. Next step: lattice story_advance --storyId=${sid} --phase=INIT_CHECK to create the worktree, then cd into it`;
    case 'INIT_CHECK':
      if (!c.gitReady && !c.configuredGitRootResolved) {
        return `Story is in the pre-INIT_CHECK phase, but the current project is not a git repository. Run git init + initial commit first, then continue with worktree / PLAN flow`;
      }
      return `Story is at INIT_CHECK, worktree created. Next: cd into .worktrees/${sid}/ then lattice story_advance --phase=PLAN`;
    case 'PLAN': {
      if (!c.hasUnderstanding) {
        return `PLAN phase missing understanding. Next: lattice understanding_set to record task/outcome/facts/constraints/unknowns/touchpoints snapshot`;
      }
      if (!c.hasDecision) {
        return `PLAN phase has understanding but missing decision. Next: lattice decision_set to record RALPLAN-DR decision (principles/drivers/options/chosen/rationale/preMortem)`;
      }
      return `PLAN phase. Next: lattice story_review --storyId=${sid} to run adversarial review; once issueCount=0, run lattice story_advance --phase=DEV`;
    }
    case 'DEV': {
      if (!c.checklist) return `DEV phase. First run lattice checklist_get --storyId=${sid} to see pending items`;
      if (c.checklist.inProgress.length > 0) {
        const ip = c.checklist.inProgress[0];
        return `DEV phase. Continue the in_progress item: ${ip.id} ${ip.title} (after completing, run lattice checklist_update --status=done)`;
      }
      if (c.checklist.pending.length > 0) {
        const next = c.checklist.pending[0];
        return `DEV phase. Next item: lattice checklist_update --storyId=${sid} --itemId=${next.id} --status=in_progress (${next.title})`;
      }
      return `DEV phase, all checklist items done. Next: git commit + lattice story_advance --storyId=${sid} --phase=REVIEW to enter code review`;
    }
    case 'REVIEW':
      if (c.reviewerStatus) {
        if (c.reviewerStatus.totalBlockers > 0) {
          const blocked = c.reviewerStatus.entries
            .filter(e => e.blockerCount > 0)
            .map(e => `${e.name}(${e.blockerCount})`)
            .join(', ');
          return `REVIEW phase, ${c.reviewerStatus.totalBlockers} blocking finding(s): ${blocked}. Next: lattice finding_list --storyId=${sid} to view and fix, run lattice story_advance --storyId=${sid} --phase=DEV if needed`;
        }
        if (!c.reviewerStatus.allPassed) {
          const pending = c.reviewerStatus.entries
            .filter(e => e.verdict === 'pending')
            .map(e => e.name)
            .join(', ') || 'reviewer evidence';
          return `REVIEW phase, Waiting for reviewer evidence: ${pending}. Next: lattice reviewer_list --storyId=${sid} to see which lattice-review-* reviewers should run; once all pass, run lattice story_advance --storyId=${sid} --phase=TEST`;
        }
        return `REVIEW phase, All reviewer gates passed. Next: lattice story_advance --storyId=${sid} --phase=TEST to enter formal verification`;
      }
      return `REVIEW phase. Proofbound reviewers review code and file findings. After all critical/high findings are resolved, run lattice story_advance --storyId=${sid} --phase=TEST`;
    case 'TEST_CASE':
      return `TEST_CASE phase (legacy). Recommend lattice story_advance --phase=TEST to enter verification directly`;
    case 'TEST_CASE_REVIEW':
      return `TEST_CASE_REVIEW phase (legacy). Recommend lattice story_advance --phase=TEST to enter verification directly`;
    case 'TEST':
      // B-b9d0 CHK-004: scope-gate blocking takes priority over the DONE
      // hint — DONE is not recommended while scope is blocking. Out-of-scope
      // diffs must be fixed or scope_contract_acknowledge'd in DEV/REVIEW
      // (TEST acknowledgement is intentionally forbidden) before advancing.
      if (c.scopeBlocking) {
        return `TEST phase. Scope gate: blocking — ${c.scopeBlocking.reason}. DONE is not recommended while scope is blocking. Next: return to DEV/REVIEW to fix out-of-scope diff or run lattice scope_contract_acknowledge then lattice story_advance --phase=TEST`;
      }
      if (openBugs.length > 0) {
        return `TEST phase, ${openBugs.length} open bug(s): ${openBugs.slice(0, 3).map(b => b.id).join(', ')}. After fixing, run lattice validate to verify`;
      }
      if (!c.hasTestEvidence) {
        return `TEST phase. Next: lattice validate to run verification, record bug/evidence`;
      }
      if (!c.hasPassingTestEvidence) {
        return `TEST phase, last verification failed. Next: fix failing items then rerun lattice validate`;
      }
      if (c.donePrecheck && c.donePrecheck.blocking.length > 0) {
        const ids = c.donePrecheck.blocking.slice(0, 4).map(r => r.id).join(', ');
        const more = c.donePrecheck.blocking.length > 4 ? ` (+${c.donePrecheck.blocking.length - 4} more)` : '';
        return `TEST phase, DONE pre-check still has ${c.donePrecheck.blocking.length} item(s) not passing: ${ids}${more}. Next: ${summarizeDonePrecheckActions(c.donePrecheck.blocking)}`;
      }
      return `TEST phase, all bugs are fixed. Next step: lattice story_advance --storyId=${sid} --phase=DONE to complete the story (will automatically merge back to main)`;
    case 'DONE':
      return `Story is DONE. You can start the next story`;
    default:
      return `Unknown phase: ${c.phase}`;
  }
}

function formatTimeAgo(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const ms = Date.now() - t;
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

/** B-89c7 CHK-008: session_brief input schema.
 *  concise=true → output < ~4KB, only critical fields. Used by the
 *  Claude Code SessionStart hook where head-of-context pollution must
 *  be minimized. Full mode (default) keeps everything that helps
 *  operators when they run the command manually. */
interface SessionBriefArgs {
  concise?: boolean;
}

function extractNextStep(brief: string): string {
  const marker = '## → Next step';
  const idx = brief.indexOf(marker);
  if (idx < 0) return brief.trim();
  const body = brief.slice(idx + marker.length).trim();
  if (!body) return 'No next step available.';
  const nextSection = body.split(/\n## /)[0] || body;
  return nextSection
    .split('\n')
    .map(line => line.replace(/^ {2}/, ''))
    .join('\n')
    .trim();
}

export function createSessionHandlers(ctx: HandlerContext) {
  const handlers = {
    session_brief(args: SessionBriefArgs = {}): string {
      const concise = args.concise === true;
      const lines: string[] = [];
      const gitReady = isGitRepository(ctx.root);
      const configuredGitRootStatus = readConfiguredGitRootSessionStatus(ctx.root, gitReady);
      lines.push('# lattice session brief');
      lines.push('');

      const detected = detectActiveStoryFromGit(ctx);

      if (!detected) {
        // ── No active story branch (B-89c7 CHK-016 main-branch enrichment) ──
        // Pull dashboard + active stories + cross-story open bugs + recent
        // router-log so agents landing in main still get real situational
        // awareness, not just "N stories total".
        const allStoryIds = (() => {
          try { return ctx.store.listStoryIds(); } catch { return []; }
        })();

        if (allStoryIds.length === 0) {
          lines.push('**No active story** — no stories yet.');
          lines.push('');
          lines.push('Start with `lattice story_create` to create your first story.');
          for (const l of renderConfiguredGitRootSessionStatus(configuredGitRootStatus)) lines.push(l);
          for (const l of renderStoryDirOutsideGitRootAdvisory(ctx.root)) lines.push(l);
          if (!gitReady) {
            lines.push('');
            lines.push(renderNonGitProjectNotice(
              configuredGitRootStatus,
              '⚠ Non-git project: Proofbound can still record story/test metadata here, but INIT_CHECK/worktree phases need `git init` + an initial commit first.',
            ));
          }
          const gitNew = readGitStatus(ctx.root);
          if (gitNew.recentLog.length > 0) {
            lines.push('');
            lines.push('Recent commits:');
            for (const l of gitNew.recentLog) lines.push(`  ${l}`);
          }
          return lines.join('\n');
        }

        // Dashboard: reuse story_list handler output's _dashboard field.
        // We call the same handler via ctx-level helpers so the exact
        // same numbers show up in brief and in `lattice story_list`.
        let dashboardText: string | null = null;
        const worktrees = listActiveWorktrees(ctx.root);
        const zombiesForBrief = detectZombieStories(ctx.store, ctx.root);
        const zombieIds = new Set(zombiesForBrief.map(z => z.storyId));
        let activeStories: Array<{
          storyId: string;
          phase: string;
          mainPhase: string | null;
          phaseAuthority: 'main' | 'worktree';
          title: string;
          bugsOpen: number;
          hasBg: boolean;
        }> = [];
        const metaContainerIds: string[] = [];
        let totalBugsOpen = 0;
        let totalStories = allStoryIds.length;
        let doneStories = 0;
        const doneOutcomes = emptyDoneOutcomes();
        try {
          const phases: Record<string, number> = {};
          for (const id of allStoryIds) {
            try {
              const mainStory = ctx.store.readStory(id);
              const linked = worktrees[id] && mainStory.phase !== 'DONE' && mainStory.phase !== 'DISCARDED'
                ? readStoryFromLinkedWorktree(id, worktrees[id])
                : null;
              const sourceStore = linked?.store || ctx.store;
              const s = linked?.story || mainStory;
              phases[s.phase] = (phases[s.phase] || 0) + 1;
              if (s.phase === 'DONE') {
                doneStories++;
                const summary = sourceStore.readSummary(id);
                doneOutcomes[normalizeStoryOutcomeKind(summary?.outcomeKind)]++;
              }
              // Non-terminal = active
              if (
                s.phase !== 'DONE' &&
                s.phase !== 'DISCARDED' &&
                s.phase !== 'IDEA' &&
                !isMetaContainer(id, s.phase) &&
                !zombieIds.has(id)
              ) {
                let bugsOpen = 0;
                try {
                  const bd = sourceStore.readBugs(id);
                  bugsOpen = bd.bugs.filter(b => b.status === 'open').length;
                } catch { /* no bugs file */ }
                // B-45ed CHK-008: detect background.md existence for each active story → bg:✓ marker
                const hasBg = existsSync(sourceStore.storyFilePath(id, 'background.md'));
                activeStories.push({
                  storyId: id,
                  phase: s.phase,
                  mainPhase: linked?.story && linked.story.phase !== mainStory.phase ? mainStory.phase : null,
                  phaseAuthority: linked?.story ? 'worktree' : 'main',
                  title: s.title || '',
                  bugsOpen,
                  hasBg,
                });
              }
              if (isMetaContainer(id, s.phase) && s.phase !== 'DONE' && s.phase !== 'DISCARDED') {
                metaContainerIds.push(id);
              }
            } catch { /* skip unreadable */ }
          }
          // Cross-story open bug tally across ALL stories, not just active.
          for (const id of allStoryIds) {
            try {
              const bd = ctx.store.readBugs(id);
              totalBugsOpen += bd.bugs.filter(b => b.status === 'open').length;
            } catch { /* probe */ }
          }
          const donePct = totalStories > 0 ? Math.round((doneStories / totalStories) * 100) : 0;
          dashboardText = `Lifecycle DONE: ${doneStories}/${totalStories} (${donePct}%) · outcomes: ${renderDoneOutcomes(doneOutcomes)} · ${totalBugsOpen} open bugs across all stories`;
        } catch { /* defensive: leave dashboardText null */ }

        if (dashboardText) {
          lines.push(`**Dashboard**: ${dashboardText}`);
        } else {
          lines.push(`**${totalStories} stories total**`);
        }

        // Active stories + worktree paths.
        if (activeStories.length > 0) {
          lines.push('');
          lines.push(`## Active stories (${activeStories.length})`);
          const limit = concise ? 3 : activeStories.length;
          for (const s of activeStories.slice(0, limit)) {
            const wt = worktrees[s.storyId];
            const bugStr = s.bugsOpen > 0 ? ` [${s.bugsOpen} bugs]` : '';
            // B-45ed CHK-008: bg:✓ trailing marker; not displayed when background.md does not exist
            const bgStr = s.hasBg ? ' bg:✓' : '';
            const phaseStr = s.mainPhase
              ? `${s.phase} (authority:worktree, mirror:${s.mainPhase})`
              : `${s.phase} (authority:${s.phaseAuthority})`;
            if (wt) {
              lines.push(`  ${s.storyId} ${phaseStr.padEnd(36)} ${s.title}${bugStr}${bgStr}`);
              lines.push(`    → cd ${wt}`);
            } else {
              lines.push(`  ${s.storyId} ${phaseStr.padEnd(36)} ${s.title}${bugStr}${bgStr}`);
            }
          }
          if (activeStories.length > limit) {
            lines.push(`  ... ${activeStories.length - limit} more`);
          }
        }

        // B-6894: INIT fallback warning — surface any active stories that used the
        // manual init_check_repair fallback so operators see the authorization boundary.
        const fallbackActiveStoryIds: string[] = [];
        for (const s of activeStories) {
          try {
            const wt = worktrees[s.storyId];
            const sourceStore = wt ? new StoryStore(wt) : ctx.store;
            const initCheck = sourceStore.readInitCheck(s.storyId);
            if (initCheck && initCheckAttestationMode(initCheck) === 'fallback') {
              fallbackActiveStoryIds.push(s.storyId);
            }
          } catch { /* probe — skip unreadable */ }
        }
        if (fallbackActiveStoryIds.length > 0) {
          lines.push('');
          lines.push(`## ⚠ INIT fallback warning (${fallbackActiveStoryIds.length} story)`);
          for (const id of fallbackActiveStoryIds) {
            lines.push(`  ${id}: INIT_CHECK was approved via manual fallback attestation, not independent reviewer approval.`);
          }
          lines.push('  Later PLAN/DEV/REVIEW/TEST gates remain required.');
          lines.push('  Implementation and continuation require explicit user/project authorization if this is not the requested project.');
        }

        // B-a370: META containers (audit/finding flow) — listed separately,
        // never folded into the lifecycle/worktree suggestion ordering.
        if (metaContainerIds.length > 0) {
          lines.push('');
          lines.push(`## META containers (${metaContainerIds.length})`);
          for (const id of metaContainerIds) {
            lines.push(`  ${id} — audit/finding flow container, does not go through story lifecycle`);
          }
          lines.push('  → Use `lattice audit` / `lattice finding_list` to handle, do not run `lattice story_advance` or create worktree');
        }

        // Cross-story open bugs sample (concise mode skips this).
        if (!concise && totalBugsOpen > 0) {
          const bugSample: Array<{ storyId: string; id: string; title: string }> = [];
          for (const id of allStoryIds) {
            if (bugSample.length >= 5) break;
            try {
              const bd = ctx.store.readBugs(id);
              for (const b of bd.bugs) {
                if (b.status === 'open' && bugSample.length < 5) {
                  bugSample.push({ storyId: id, id: b.id, title: b.title });
                }
              }
            } catch { /* probe */ }
          }
          if (bugSample.length > 0) {
            lines.push('');
            lines.push(`## Open bugs (${bugSample.length} of ${totalBugsOpen})`);
            for (const b of bugSample) {
              lines.push(`  - ${b.storyId} ${b.id} ${b.title}`);
            }
          }
        }

        // Git recent commits + porcelain (brief).
        const gitMain = readGitStatus(ctx.root);
        if (!concise && gitMain.recentLog.length > 0) {
          lines.push('');
          lines.push('## Recent commits');
          for (const l of gitMain.recentLog) lines.push(`  ${l}`);
        }
        if (gitMain.porcelain.length > 0) {
          lines.push('');
          lines.push(`Working tree dirty (${gitMain.porcelain.length} files).`);
        }
        for (const l of renderConfiguredGitRootSessionStatus(configuredGitRootStatus)) lines.push(l);
        for (const l of renderStoryDirOutsideGitRootAdvisory(ctx.root)) lines.push(l);
        if (!gitReady) {
          lines.push('');
          lines.push(renderNonGitProjectNotice(
            configuredGitRootStatus,
            '⚠ Non-git project: story metadata can be recorded here, but branch/worktree phases need `git init` + an initial commit first.',
          ));
        }

        if (!concise) {
          const activity = readActivityTail(ctx.root, 3);
          if (activity.length > 0) {
            lines.push('');
            lines.push(`## Recent activity (last ${activity.length})`);
            for (const a of activity.slice().reverse()) {
              lines.push(`  ${renderActivityLine(a)}`);
            }
          }
        }

        // B-89c7 CHK-013: Recent router-log tail with cache warning.
        const routerTail = readRouterLogTail(ctx.root, 3);
        for (const l of renderRouterLogTail(routerTail)) lines.push(l);

        // Next step suggestion for main branch.
        lines.push('');
        lines.push('## → Next step');
        if (activeStories.length > 0) {
          const top = activeStories[0];
          const wt = worktrees[top.storyId];
          if (!gitReady && configuredGitRootStatus?.signedWorkspaceRoot) {
            lines.push(`  Metadata root is not a git repo, but configured gitRoot resolves the signed workspace: ${configuredGitRootStatus.signedWorkspaceRoot}`);
          } else if (!gitReady) {
            lines.push(`  Project is not a git repo. You can keep recording story/test metadata, but before INIT_CHECK/worktree flow run: \`git init && git add . && git commit -m "init"\``);
          } else if (wt) {
            const authority = top.mainPhase
              ? `worktree phase ${top.phase} is authoritative; main metadata mirror is lagging at ${top.mainPhase}`
              : `${top.phase} from ${top.phaseAuthority} metadata`;
            lines.push(`  Resume: cd ${wt} (story ${top.storyId}; authority: ${authority})`);
          } else {
            lines.push(`  Story ${top.storyId} is in ${top.phase} but has no worktree. Try \`lattice story_advance --storyId=${top.storyId} --phase=INIT_CHECK\` to create one.`);
          }
        } else if (doneStories === totalStories) {
          lines.push('  All stories DONE. Archive old stories or `lattice story_create` for new work.');
        } else if (zombiesForBrief.length > 0) {
          lines.push(`  No healthy active story. First run lattice story_reconcile '{"dryRun":true}' to view ${zombiesForBrief.length} zombie stories, then confirm whether to run lattice story_reconcile '{"dryRun":false}' to fix.`);
        } else if (metaContainerIds.length > 0) {
          lines.push(`  ${metaContainerNextStep(metaContainerIds[0])}`);
        } else {
          lines.push('  No active story. `lattice story_create` to start one, or `lattice story_list` to see all.');
        }

        return lines.join('\n');
      }

      // ── Active story branch ────────────────────────────────────────
      // B-89c7 CHK-017: pruned of decorative fields (Type/Priority/Started,
      // full pending list, JSON.stringify summary, long activity tail).
      // Reads only answer "what's happening now + what should I do next".
      const { storyId, story } = detected;
      lines.push(`**Story**: ${storyId} — ${story.title}`);
      lines.push(`**Phase**: ${story.phase}`);

      // B-198c CHK-003: early storyDir-outside-gitRoot advisory — surface in the
      // active-story brief too so the dead end is visible at session start.
      for (const l of renderStoryDirOutsideGitRootAdvisory(ctx.root)) lines.push(l);

      // B-6894: INIT fallback warning — surface when this story passed INIT_CHECK
      // via manual fallback attestation rather than an independent reviewer.
      try {
        const initCheck = ctx.store.readInitCheck(storyId);
        if (initCheck && initCheckAttestationMode(initCheck) === 'fallback') {
          lines.push('');
          lines.push('## ⚠ INIT fallback warning');
          lines.push('  This story passed INIT_CHECK via manual fallback attestation, not independent reviewer approval.');
          lines.push('  Later PLAN/DEV/REVIEW/TEST gates remain required.');
          lines.push('  Implementation and continuation require explicit user/project authorization if this is not the requested project.');
        }
      } catch { /* probe — never block session_brief on init-check read failure */ }

      // Checklist (kept: done/total + in_progress list).
      let checklistSummary: ChecklistSummary | null = null;
      try {
        const cl = ctx.store.readChecklist(storyId);
        checklistSummary = summarizeChecklist(cl);
      } catch { /* no checklist */ }

      if (checklistSummary) {
        lines.push('');
        lines.push(`## Checklist (${checklistSummary.done}/${checklistSummary.total} done)`);
        if (checklistSummary.inProgress.length > 0) {
          lines.push(`  in_progress (${checklistSummary.inProgress.length}):`);
          for (const it of checklistSummary.inProgress.slice(0, 5)) {
            lines.push(`    - ${it.id} ${it.title}`);
          }
        }
        // B-89c7 CHK-017: show ONLY the first pending item as "next up"
        // hint, not the full list — next step suggestion already names it.
        if (checklistSummary.pending.length > 0 && !concise) {
          const next = checklistSummary.pending[0];
          lines.push(`  next pending: ${next.id} ${next.title} (+${checklistSummary.pending.length - 1} more)`);
        }
      }

      // B-42c0: compact Story Capsule projection. This is intentionally
      // display-only; gates continue to consume evidence/process-events.
      try {
        const capsule = ctx.store.readStoryCapsule(storyId);
        if (capsule) {
          const issues = validateCapsuleRefs({
            capsule,
            checklist: ctx.store.readChecklist(storyId),
            processEvents: ctx.store.readProcessEvents(storyId),
            projectRoot: ctx.root,
            storyDir: ctx.store.storyDirPath(storyId),
          });
          lines.push('');
          for (const l of renderCapsuleBrief(capsule, issues)) lines.push(l);
        }
      } catch { /* probe — capsule must never block session_brief */ }

      // B-c55d CHK-004: story owner lease ownership block. B-META containers
      // are shown as shared audit state (no per-story lease, no story_advance);
      // every other active story shows owner session / cwd / heartbeat age /
      // stale|active / whether this session is owner / recommended action.
      if (isMetaContainer(storyId, story.phase)) {
        for (const l of renderMetaAuditBlock(storyId)) lines.push(l);
      } else {
        try {
          const view = summarizeOwnerLease(
            ctx.store.storyDirPath(storyId),
            getSessionId(),
            Date.now(),
            process.cwd(),
          );
          for (const l of renderOwnershipBlock(view)) lines.push(l);
        } catch { /* probe — never block session_brief on ownership-render failure */ }
      }

      {
        const reproLine = renderReproFirstIntakeLine(ctx.root, ctx.store, storyId);
        if (reproLine) {
          lines.push('');
          lines.push('## Repro-first intake');
          lines.push(reproLine);
        }
      }

      if (story.phase === 'INIT' || story.phase === 'INIT_CHECK') {
        try {
          lines.push('');
          for (const l of renderScopeAntiExpansionSummary(storyId, ctx.store, ctx.root)) lines.push(l);
        } catch { /* probe — anti-expansion summary must never block session_brief */ }
      }

      try {
        const advisory = renderMainSyncReadinessAdvisory(
          buildMainSyncReadiness({ storyId, gitCwd: ctx.root }),
        );
        if (advisory) {
          lines.push('');
          lines.push('## Main-sync readiness');
          lines.push(`  ${advisory}`);
        }
      } catch { /* probe — main-sync readiness is advisory only */ }

      // B-6bfd CHK-006: aggregate "Scope protection summary" — path gate,
      // semantic gate, guard mode, review hash freshness, and a derived next
      // action in one block. Rendered when the story is scope-protected (has a
      // contract) OR a guard session was started; fully legacy stories (neither)
      // stay quiet so the summary never pretends protection that does not exist.
      // A corrupt scope-contract.json surfaces a fail-closed warning rather than
      // a silent downgrade (readScopeContract now throws on corrupt; see CHK-006).
      //
      // B-b9d0 CHK-004: also extract a blocking signal for computeNextStep so
      // session_brief never recommends DONE while scope is blocking.
      let scopeBlocking: { reason: string } | null = null;
      try {
        let contract: ScopeContractData | null = null;
        let contractCorrupt = false;
        try {
          contract = ctx.store.readScopeContract(storyId);
        } catch {
          contractCorrupt = true; // existing-but-unreadable contract → fail-closed signal
        }
        let guardSession: GuardSessionData | null = null;
        try {
          guardSession = ctx.store.readGuardSession(storyId);
        } catch { /* probe — corrupt guard projection must not break session_brief */ }

        if (contractCorrupt) {
          scopeBlocking = { reason: 'scope-contract.json corrupt/unreadable — lifecycle gates fail closed until scope_contract_set / scope_contract_init_from_plan' };
          lines.push('');
          lines.push('## Scope protection summary');
          lines.push('  ERROR: scope-contract.json is unreadable/corrupt — lifecycle gates fail closed until it is fixed (scope_contract_set / scope_contract_init_from_plan).');
        } else if (contract || guardSession) {
          const diffPack: ScopeDiffPack = contract
            ? buildScopeDiffPack(ctx.root)
            : { diffPackHash: '', changedFiles: [], hunks: [], generatedAt: '' };
          let reviewRuns: ReviewRun[] = [];
          try {
            reviewRuns = ctx.store.readReviewRuns(storyId).runs;
          } catch { /* probe — review runs optional */ }
          const summary = buildScopeProtectionSummary({
            contract,
            diffPack,
            guardSession,
            reviewRuns,
            currentReviewRound: story.currentReviewRound,
            phase: story.phase,
            projectRoot: ctx.root,
          });
          // B-b9d0 CHK-004: derive next-step blocking signal from the same
          // ScopeProtectionSummary the brief renders, so the "DONE recommended"
          // hint in TEST never disagrees with the scope row shown above.
          if (summary.pathGate === 'fail') {
            scopeBlocking = { reason: 'path gate fail (out-of-scope diff)' };
          } else if (summary.semanticGate === 'fail') {
            scopeBlocking = { reason: 'semantic gate fail' };
          } else if (summary.guardMode === 'violations detected') {
            scopeBlocking = { reason: 'guard session recorded forbidden write(s)' };
          }
          lines.push('');
          for (const l of renderScopeProtectionSummary(summary)) lines.push(l);
          // Guard state is already shown as the "guard mode" row inside
          // renderScopeProtectionSummary (both derive from guardSessionStateLabel),
          // so we do NOT re-render a redundant "guard session" line here. Only the
          // actionable violation detail below adds new information.
          if (guardSession && guardSession.status === 'violations_detected' && guardSession.violations.length > 0) {
            lines.push(`  ${guardSession.violations.length} forbidden write(s) under story scope protection — run lattice guard_session_check for detail.`);
          }
        }
      } catch { /* probe — never block session_brief on scope-summary render failure */ }

      // B-5fa4 CHK-001: reviewer-status integration for REVIEW phase
      let reviewerStatus: ReviewerStatusSummary | null = null;
      if (story.phase === 'REVIEW') {
        try {
          const rs = summarizeReviewerStatus(ctx.store, storyId, ctx.root);
          reviewerStatus = rs;
          lines.push('');
          lines.push(`## Reviewer status (${rs.allPassed ? 'all passed' : `${rs.totalBlockers} blockers`})`);
          for (const entry of rs.entries) {
            const marker = entry.verdict === 'pass' ? 'PASS' : (entry.verdict === 'fail' ? 'FAIL' : 'pending');
            lines.push(`  [${marker}] ${entry.name}${entry.blockerCount > 0 ? ` (${entry.blockerCount} blockers)` : ''}${entry.detail ? ` — ${entry.detail}` : ''}`);
          }
        } catch { /* probe: reviewer status unavailable */ }
      }

      // B-7a34 CHK-003: active review loop summary for REVIEW phase.
      // Surfaces loopId, decision, and nextAction so the agent immediately
      // knows an open loop is blocking REVIEW→TEST before trying to advance.
      if (story.phase === 'REVIEW') {
        try {
          const loopRecords = ctx.store.readReviewLoopRecords(storyId);
          const activeLoopIds = listActiveLoops(loopRecords);
          if (activeLoopIds.length > 0) {
            lines.push('');
            lines.push(`## Active review loops (${activeLoopIds.length}) — blocking REVIEW→TEST`);
            for (const loopId of activeLoopIds) {
              const latest = deriveLatestLoopRecord(loopRecords, loopId);
              lines.push(`  loopId: ${loopId}`);
              if (latest && latest.event === 'iteration') {
                const iter = latest as ReviewLoopIteration;
                lines.push(`  decision: ${iter.decision}`);
                lines.push(`  decisionReason: ${iter.decisionReason}`);
                if (iter.nextAction) {
                  const na = iter.nextAction;
                  if (na.nextPrompt) lines.push(`  nextAction.nextPrompt: ${na.nextPrompt.slice(0, 120)}`);
                  if (na.humanQuestion) lines.push(`  nextAction.humanQuestion: ${na.humanQuestion}`);
                  if (na.handoffHostId) lines.push(`  nextAction.handoffHostId: ${na.handoffHostId}`);
                  if (na.rollbackCommandHint) lines.push(`  nextAction.rollbackCommandHint: ${na.rollbackCommandHint}`);
                }
              } else if (latest && latest.event === 'start') {
                lines.push(`  status: open (no iterations yet)`);
              }
              lines.push(`  → review_loop_close to resolve; resolve trigger refs before advancing to TEST`);
            }
          }
        } catch { /* probe — never block session_brief on loop read failure */ }
      }

      // Understanding / Decision — probe only in PLAN phase (B-89c7 CHK-017
      // lazy I/O). Elsewhere these fields are never rendered so the file
      // read is wasted.
      let hasUnderstanding = false;
      let hasDecision = false;
      if (story.phase === 'PLAN') {
        try {
          const u = (ctx.store as { readUnderstanding?: (id: string) => { task?: string } }).readUnderstanding?.(storyId);
          hasUnderstanding = !!u && !!u.task;
        } catch { /* probe */ }
        try {
          const d = (ctx.store as { readDecision?: (id: string) => { options?: unknown[] } }).readDecision?.(storyId);
          hasDecision = !!d && Array.isArray(d.options) && d.options.length > 0;
        } catch { /* probe */ }
      }

      // Bugs (kept: open count + first 5 open).
      let bugs: BugData | null = null;
      try {
        bugs = ctx.store.readBugs(storyId);
        if (bugs && bugs.bugs.length > 0) {
          const open = bugs.bugs.filter(b => b.status === 'open');
          const fixed = bugs.bugs.filter(b => b.status === 'fixed');
          if (open.length > 0 || fixed.length > 0) {
            lines.push('');
            lines.push(`## Bugs: ${open.length} open, ${fixed.length} fixed`);
            for (const b of open.slice(0, 5)) {
              lines.push(`  - [open] ${b.id} ${b.title}${b.fixtureId ? ` (fixtureId=${b.fixtureId})` : ''}`);
            }
          }
        }
      } catch { /* none */ }

      // Anti-stall hints for REVIEW/TEST (helps weaker agents like Codex)
      if (story.phase === 'REVIEW' || story.phase === 'TEST') {
        const openBugIds = bugs?.bugs.filter(b => b.status === 'open').map(b => b.id) ?? [];
        let stall: string | null = null;
        if (story.phase === 'REVIEW') {
          if (reviewerStatus && reviewerStatus.totalBlockers > 0) {
            stall = reviewAntiStall(storyId);
          } else if (reviewerStatus && !reviewerStatus.allPassed) {
            const pending = reviewerStatus.entries
              .filter(e => e.verdict === 'pending')
              .map(e => e.name)
              .join(', ') || 'reviewer evidence';
            stall = renderAntiStall({
              storyId,
              title: `REVIEW waiting for ${pending}`,
              retry: `lattice reviewer_list '{"storyId":"${storyId}"}' then run the pending lattice-review-* reviewers`,
              fix: `lattice review_run_start '{"storyId":"${storyId}","agent":"lattice-review-<name>"}' first, then use the returned reviewRunId in lattice review_pass_set '{"storyId":"${storyId}","reviewRunId":"<reviewRunId from lattice review_run_start>","agent":"lattice-review-<name>","note":"..."}' when a reviewer found no blocker`,
            });
          }
        } else {
          stall = testAntiStall(storyId, openBugIds.length > 0 ? openBugIds : undefined);
        }
        if (stall) {
          lines.push('');
          lines.push(`## Anti-stall (${story.phase})`);
          for (const line of normalizeSessionCommandHints(stall).split('\n')) {
            lines.push(`  ${line}`);
          }
        }
      }

      // Test evidence (kept: timestamp + structured summary, not JSON dump).
      let hasTestEvidence = false;
      let hasPassingTestEvidence = false;
      let testPassedAt: string | null = null;
      try {
        const ev = ctx.store.readTestEvidence(storyId);
        if (ev) {
          hasTestEvidence = true;
          hasPassingTestEvidence = ev.result === 'PASS';
          const evAny = ev as { timestamp?: string; runAt?: string; summary?: { passed?: number; failed?: number; skipped?: number; total?: number } };
          testPassedAt = evAny.timestamp || evAny.runAt || null;
          lines.push('');
          lines.push(`## Last test run`);
          if (testPassedAt) lines.push(`  at: ${testPassedAt} (${formatTimeAgo(testPassedAt)})`);
          if (ev.result) lines.push(`  result: ${ev.result}`);
          if (evAny.summary && typeof evAny.summary === 'object') {
            const s = evAny.summary;
            const parts: string[] = [];
            if (typeof s.passed === 'number') parts.push(`passed: ${s.passed}`);
            if (typeof s.failed === 'number') parts.push(`failed: ${s.failed}`);
            if (typeof s.skipped === 'number') parts.push(`skipped: ${s.skipped}`);
            if (parts.length > 0) lines.push(`  ${parts.join(', ')}`);
          }
        }
      } catch { /* none */ }

      // DONE pre-check list for TEST phase stories
      let donePrecheck: DonePrecheckSummary | null = null;
      if (story.phase === 'TEST') {
        try {
          const evidenceHashSnapshot = tryCaptureEvidenceHashSnapshot({ gitCwd: ctx.root, metadataRoot: ctx.root, ref: 'HEAD' });
          const rows = buildDoneChecklist(storyId, ctx.store, ctx.root, {
            gitCwd: ctx.root,
            evidenceHashSnapshot,
          });
          donePrecheck = summarizeDonePrecheck(rows);
          lines.push('');
          lines.push('## DONE pre-check');
          for (const row of rows) {
            const marker = row.status === 'pass' ? 'PASS' : (row.status === 'fail' ? 'FAIL' : 'warn');
            lines.push(`  [${marker}] ${row.label}${row.detail ? `: ${row.detail}` : ''}`);
          }
        } catch { /* probe: DONE pre-check unavailable */ }
      }

      // B-abd8: process metrics in session brief
      const pm = ctx.store.readProcessMetrics(storyId);
      if (pm) {
        lines.push('');
        lines.push(`## Process metrics`);
        lines.push(`  ${formatProcessMetricsSummary(pm, 'compact')}`);
        if (pm.overallGaps.length > 0) {
          lines.push(`  gaps: ${pm.overallGaps.slice(0, 3).join('; ')}${pm.overallGaps.length > 3 ? ` (+${pm.overallGaps.length - 3} more)` : ''}`);
        }
      }

      // Activity tail — CHK-017 shrunk from 8 to 3 in full mode; skipped
      // entirely in concise mode (git log covers most of what it shows).
      if (!concise) {
        const activity = readActivityTail(ctx.root, 3);
        if (activity.length > 0) {
          lines.push('');
          lines.push(`## Recent activity (last ${activity.length})`);
          for (const a of activity.slice().reverse()) {
            lines.push(`  ${renderActivityLine(a)}`);
          }
        }
      }

      // Git status (kept full — compact and high signal).
      const git = readGitStatus(ctx.root);
      if (!concise && (git.porcelain.length > 0 || git.recentLog.length > 0)) {
        lines.push('');
        lines.push('## Git');
        if (git.recentLog.length > 0) {
          lines.push('  recent commits:');
          for (const l of git.recentLog) lines.push(`    ${l}`);
        }
        if (git.porcelain.length > 0) {
          lines.push(`  uncommitted (${git.porcelain.length}):`);
          for (const f of git.porcelain.slice(0, 8)) lines.push(`    ${f}`);
        }
      } else if (concise && git.porcelain.length > 0) {
        // Concise: just the dirty flag, not the file list.
        lines.push('');
        lines.push(`Working tree dirty (${git.porcelain.length} files).`);
      }

      // B-89c7 CHK-013: Recent router-log tail for active story too — most
      // relevant when the agent wants to know "did the last chat hit
      // cache" or "was the last turn slow".
      const routerTail = readRouterLogTail(ctx.root, concise ? 2 : 3);
      for (const l of renderRouterLogTail(routerTail)) lines.push(l);

      // Next step (kept — most important field).
      const nextStep = computeNextStep({
        storyId,
        phase: story.phase,
        checklist: checklistSummary,
        hasUnderstanding,
        hasDecision,
        bugs,
        hasTestEvidence,
        hasPassingTestEvidence,
        testPassedAt,
        gitReady,
        configuredGitRootResolved: !gitReady && !!configuredGitRootStatus?.signedWorkspaceRoot,
        donePrecheck,
        reviewerStatus,
        scopeBlocking,
      });

      lines.push('');
      lines.push('## → Next step');
      lines.push(`  ${nextStep}`);

      // B-a2f1 CHK-001/002: surface stale verificationEvidence at session_brief
      // so users discovering "where am I?" immediately see the recovery path.
      try {
        const stale = findStaleEvidence(ctx.root, storyId);
        const hint = renderEvidenceStaleHint(storyId, stale, { currentHead: currentGitHead(ctx.root) });
        if (hint) {
          lines.push('');
          lines.push(hint);
        }
      } catch { /* probe — never block session_brief on stale-hint failure */ }

      return lines.join('\n');
    },

    next(args: SessionBriefArgs = {}): string {
      const brief = handlers.session_brief({ concise: args.concise ?? true });
      return extractNextStep(brief);
    },
  };
  return handlers;
}
