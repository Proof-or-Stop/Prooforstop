
import { execFileSync, execSync } from 'child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { HandlerContext } from './context.js';
import type { StoryPhase, StoryInfo } from '../core/types.js';
import { StoryStore } from '../core/store.js';
import { assertCwdInWorktree, collectContext } from './context.js';
import { loadConfig } from '../core/config.js';
import { resolveProjectGitCwd } from '../core/story-signed-workspace-resolution.js';
import { resolveStoryWorkspace } from '../core/story-workspace.js';
import { formatProcessMetricsSummary } from '../core/process-metrics.js';
import { isVolatileRuntimeArtifactPath } from '../core/runtime-artifact-registry.js';
import {
  getRepoRoot,
  getStoryWorktreeRuntime,
  isForeignAbsolutePath,
  listGitWorktrees,
  resolveWorktreePath,
} from '../core/worktree-runtime.js';
import { getLegacyActivityLogPath, getRuntimeActivityLogPath } from '../core/activity-log.js';
import { PROOF_OR_STOP_DIR, PROOF_OR_STOP_ACTIVITY_LOG, PROOF_OR_STOP_REPAIR_IGNORE } from '../core/proof-or-stop-paths.js';
import { initCheckAttestationMode } from '../core/init-check-gate.js';
import { withMainWriteLock } from '../core/main-write-lock.js';
import {
  cleanupAuxiliaryWorktreeResidues,
  renderAuxiliaryClassification,
  scanAuxiliaryWorktreeResidues,
} from '../core/auxiliary-worktree-cleanup.js';
// B-70a6 F-005: the zombie repair below writes a TERMINAL phase out of band, so it
// must rescue any pending reopen audit first. handlers/transition-orchestrator.ts
// does not import this module, so the dependency stays one-directional.
import {
  reconcileReopenAuditBeforeOutOfBandPhaseChange,
  renderOutOfBandReopenAuditNotice,
} from './transition-orchestrator.js';
import { summarizeChecklist } from './checklist.js';
import { isDeliveredChecklistStatus, isWithdrawnChecklistStatus } from '../core/checklist-status.js';
import { wantsFullOutput, truncateOneLine } from '../cli/output-verbosity.js';
import { readBrandEnv } from '../core/brand-env.js';
import { agentRoleIdsEqual } from '../core/agent-role-identity.js';

// B-7c05 CHK-004: phases treated as terminal for the brief story_list default.
// Brief lists only NON-terminal (actionable) stories one-line each; the omitted
// terminal stories are still fully accounted for by the per-phase `_phases`
// counts + an explicit omitted count (non-silent filtering).
const STORY_LIST_TERMINAL_PHASES = new Set<string>(['DONE', 'DISCARDED', 'IDEA']);

type StoryListRow = {
  storyId: string;
  phase: string;
  priority?: string;
  type?: string;
  title?: string;
  checklist?: string;
  bugs?: string;
  tests?: string;
  mainPhase?: string;
  labels?: string;
  bg?: string;
  [key: string]: unknown;
};

/** One-line-per-story brief projection: drops the verbose `metrics`/`name` and truncates the title. */
function toBriefStoryRow(row: StoryListRow): Record<string, unknown> {
  return {
    storyId: row.storyId,
    phase: row.phase,
    ...(row.mainPhase ? { mainPhase: row.mainPhase } : {}),
    ...(row.priority ? { priority: row.priority } : {}),
    ...(row.type ? { type: row.type } : {}),
    title: truncateOneLine(row.title, 80),
    ...(row.checklist ? { checklist: row.checklist } : {}),
    ...(row.bugs ? { bugs: row.bugs } : {}),
    ...(row.tests ? { tests: row.tests } : {}),
    ...(row.labels ? { labels: row.labels } : {}),
    ...(row.bg ? { bg: row.bg } : {}),
  };
}

/** B-45ed CHK-008: Returns true if the story's background.md file exists. */
function hasBackground(store: StoryStore, storyId: string): boolean {
  return existsSync(store.storyFilePath(storyId, 'background.md'));
}

// ─── Non-terminal phases for zombie detection ──────────────────────────────

const NON_TERMINAL_PHASES = new Set<string>([
  'INIT', 'INIT_CHECK', 'PLAN', 'DEV', 'REVIEW',
  'TEST_CASE', 'TEST_CASE_REVIEW', 'TEST',
]);

interface ZombieInfo {
  storyId: string;
  phase: string;
  branch: string;
  branchExists: boolean;
  branchMerged: boolean;
  worktreeExists: boolean;
  worktreePath?: string;
  worktreeForeignPath?: boolean;
}

interface StoryResidueInfo {
  storyId: string;
  phase: string;
  path: string;
  safe: boolean;
  status: string;
}

interface IntentFixtureLocation {
  file: string;
  line: number;
  name: string;
}

const INIT_REVIEWER_STORY_SCOPE_MUTATION_BLOCKED_AGENTS = new Set([
  'proof-or-stop-review-story-init',
  'proof-or-stop-product-reviewer',
]);

const STORY_LEVEL_SCOPE_FIELDS = ['title', 'description', 'source', 'depends'] as const;
type StoryLevelScopeField = typeof STORY_LEVEL_SCOPE_FIELDS[number];
type StoryGetArgs = { storyId: string; detail?: boolean; slim?: boolean; fields?: string[] };

function pickTopLevelFields<T extends Record<string, unknown>>(value: T, fields?: string[]): Partial<T> {
  const requested = (fields || []).map(field => field.trim()).filter(Boolean);
  if (requested.length === 0) return value;
  const selected: Partial<T> = {};
  for (const field of requested) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      selected[field as keyof T] = value[field as keyof T];
    }
  }
  return selected;
}

function isLegacyIntentRef(ref: string): boolean {
  return /^CHK-\d+:(happy|edge|adversarial):\d+$/.test(ref);
}

function lineOfCaseName(raw: string, caseName: unknown): number {
  if (typeof caseName !== 'string') return 0;
  const compactIdx = raw.indexOf(`"name":"${caseName}"`);
  const prettyIdx = raw.indexOf(`"name": "${caseName}"`);
  const idx = compactIdx >= 0 ? compactIdx : prettyIdx;
  return idx >= 0 ? raw.substring(0, idx).split('\n').length : 0;
}

function relativeFixtureFile(fixturesDir: string, filePath: string): string {
  return filePath
    .replace(fixturesDir + '/', '')
    .replace(fixturesDir + '\\', '');
}

function collectStoryIntentFixtures(
  fixturesDir: string,
  storyId: string,
): Map<string, IntentFixtureLocation> {
  const refs = new Map<string, IntentFixtureLocation>();
  if (!existsSync(fixturesDir)) return refs;

  const scopedPrefix = `${storyId}:`;
  const scanDir = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const filePath = join(dir, entry.name);
      if (entry.isDirectory()) { scanDir(filePath); continue; }
      if (!entry.name.endsWith('.json')) continue;
      try {
        const raw = readFileSync(filePath, 'utf-8');
        const content = JSON.parse(raw);
        for (const c of content.cases || []) {
          if (!c.intentRef || typeof c.intentRef !== 'string') continue;
          const ref = c.intentRef as string;
          const location = {
            file: relativeFixtureFile(fixturesDir, filePath),
            line: lineOfCaseName(raw, c.name),
            name: c.name,
          };

          if (ref.startsWith(scopedPrefix)) {
            refs.set(ref.slice(scopedPrefix.length), location);
          } else if (c.storyId === storyId && isLegacyIntentRef(ref)) {
            refs.set(ref, location);
          }
        }
      } catch { /* ignore corrupt fixture files while rendering story detail */ }
    }
  };
  scanDir(fixturesDir);
  return refs;
}

function appendJsonlContent(existing: string, incoming: string): string {
  if (!existing) return incoming;
  if (!incoming) return existing;
  return `${existing}${existing.endsWith('\n') ? '' : '\n'}${incoming}`;
}

function removeEmptyDir(path: string): boolean {
  if (!existsSync(path)) return false;
  if (readdirSync(path).length > 0) return false;
  rmdirSync(path);
  return true;
}

function storyUpdateActorFrom(args: { agent?: string; actor?: string }): string {
  const explicit = args.agent?.trim() || args.actor?.trim();
  if (explicit) return explicit;
  return readBrandEnv('AGENT')?.trim() || process.env.USER?.trim() || 'main-agent';
}

function isInitReviewerStoryUpdateActor(actor: string): boolean {
  return Array.from(INIT_REVIEWER_STORY_SCOPE_MUTATION_BLOCKED_AGENTS)
    .some(blockedAgent => agentRoleIdsEqual(actor, blockedAgent));
}

function storyLevelScopeMutations(args: {
  title?: string;
  description?: string;
  source?: string;
  depends?: string[];
}): StoryLevelScopeField[] {
  return STORY_LEVEL_SCOPE_FIELDS.filter(field => args[field] !== undefined);
}

function assertInitReviewerStoryScopeMutationAllowed(args: {
  story: StoryInfo;
  command: 'story_update';
  actor: string;
  scopeFields: StoryLevelScopeField[];
}): void {
  if (args.story.phase !== 'INIT') return;
  if (args.scopeFields.length === 0) return;
  if (!isInitReviewerStoryUpdateActor(args.actor)) return;
  throw new Error(
    `${args.command} refused: INIT reviewer lane "${args.actor}" cannot directly modify story-level scope field(s) ${args.scopeFields.join(', ')} in INIT. [init_reviewer_story_scope_mutation_blocked]\n` +
    `→ Record requested expansion with scope_extension_proposal; the main/owner agent may then accept/reject via scope_extension_decide and rerun scope_freeze_check.`,
  );
}

function shellQuote(value: string): string {
  return JSON.stringify(value);
}

function gitOutput(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function gitSucceeds(cwd: string, args: string): boolean {
  try {
    execSync(`git ${args}`, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

function gitSafe(gitCwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: gitCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

function gitUnmergedPaths(cwd: string): string[] {
  const raw = gitOutput(cwd, 'diff --name-only --diff-filter=U');
  return raw.split('\n').map(line => line.trim().replace(/\\/g, '/')).filter(Boolean);
}

// Exported for the porcelain first-row regression smoke (B-d6a0); not a CLI command.
export function gitPorcelainPaths(cwd: string): string[] {
  // Not gitOutput(): its full-output trim() strips the first porcelain row's
  // leading status space (" M path" -> "M path"), shifting the fixed-width
  // path offset and corrupting the first reported path (".proof-or-stop/x" -> "proofOrStop/x").
  const raw = execSync('git status --porcelain -uall', { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  return raw.split('\n')
    .map(line => line.trimEnd())
    .filter(Boolean)
    .map(line => {
      const pathText = line.slice(3).trim();
      // Rename rows are "old -> new"; the new path is what now exists.
      const target = pathText.includes(' -> ') ? pathText.split(' -> ').pop()! : pathText;
      return target.trim().replace(/^"|"$/g, '').replace(/\\/g, '/');
    });
}

/**
 * Detects "zombie" stories: phase is not terminal but the branch has been merged to main (or the branch has been deleted).
 * Returns the list of all anomalous stories.
 */
export function detectZombieStories(store: StoryStore, root: string): ZombieInfo[] {
  const zombies: ZombieInfo[] = [];
  const ids = store.listStoryIds();
  const repoRoot = getRepoRoot(root);
  const linkedByBranch = new Map<string, string>();
  for (const entry of listGitWorktrees(repoRoot)) {
    if (entry.branch) linkedByBranch.set(entry.branch, entry.path);
  }
  const branches = new Set(
    gitSafe(repoRoot, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean),
  );
  const mergedBranches = new Set(
    gitSafe(repoRoot, ['for-each-ref', '--format=%(refname:short)', '--merged=main', 'refs/heads'])
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean),
  );

  for (const id of ids) {
    let story: StoryInfo;
    try { story = store.readStory(id); } catch { continue; }
    if (!NON_TERMINAL_PHASES.has(story.phase)) continue;

    const branch = story.worktree?.branch || `story/${id}`;
    const branchExists = branches.has(branch);
    const branchMerged = mergedBranches.has(branch);
    const linkedPath = linkedByBranch.get(branch) || null;
    const recordedPath = story.worktree?.path ?? null;
    const recordedForeignPath = recordedPath ? isForeignAbsolutePath(recordedPath) : false;
    const recordedAbsPath = resolveWorktreePath(repoRoot, recordedPath);
    const recordedExists = Boolean(recordedAbsPath && !recordedForeignPath && existsSync(recordedAbsPath));

    // INIT not yet having a branch is normal; for INIT_CHECK, if there is already a worktree record/historical action
    // but both branch/worktree have disappeared, it's a zombie state after the phase was overwritten.
    if (story.phase === 'INIT') {
      if (!branchExists) continue;
    }
    if (story.phase === 'INIT_CHECK' && !branchExists) {
      const hadRuntime = Boolean(story.worktree || recordedAbsPath || (Array.isArray(story.events) && story.events.length > 1));
      const worktreeGone = !linkedPath && !recordedExists;
      if (!hadRuntime || !worktreeGone) continue;
    }

    if (linkedPath) continue;

    const branchGone = !branchExists && story.phase !== 'INIT';

    if (!branchMerged && !branchGone) continue;

    zombies.push({
      storyId: id,
      phase: story.phase,
      branch,
      branchExists,
      branchMerged,
      worktreeExists: recordedExists,
      worktreePath: recordedAbsPath || undefined,
      worktreeForeignPath: recordedForeignPath,
    });
  }

  return zombies;
}

/**
 * Detect story residue: .worktrees/ directories that belong to stories
 * whose phase is already DONE or DISCARDED. These should have been
 * cleaned up but weren't.
 */
export function detectStoryResidue(
  store: StoryStore,
  projectRoot: string,
): Array<{ storyId: string; reason: string }> {
  try {
    const repoRoot = getRepoRoot(projectRoot);
    const worktreesDir = join(repoRoot, '.worktrees');
    if (!existsSync(worktreesDir)) return [];

    const entries = readdirSync(worktreesDir, { withFileTypes: true });
    const residues: Array<{ storyId: string; reason: string }> = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // worktree dirs are named B-xxxx
      const dirName = entry.name;
      if (!dirName.startsWith('B-')) continue;
      if (
        existsSync(join(worktreesDir, dirName, PROOF_OR_STOP_REPAIR_IGNORE))
      ) continue;

      let story;
      try { story = store.readStory(dirName); } catch { continue; }

      if (story.phase === 'DONE' || story.phase === 'DISCARDED') {
        residues.push({
          storyId: dirName,
          reason: `worktree .worktrees/${dirName} still exists but phase=${story.phase}`,
        });
      }
    }

    return residues;
  } catch {
    return [];
  }
}

export function createStoryQueryHandlers(ctx: HandlerContext) {
  const { store, root } = ctx;

  // B-41c8 CHK-003: workspace resolution is owned by core/story-workspace.ts.
  // story_list keeps the phase-terminal guard it always had: a DONE / DISCARDED
  // story is projected from the invocation root, never from a residual worktree.
  function readStoryProjection(id: string): {
    story: StoryInfo;
    sourceStore: StoryStore;
    mainPhase: StoryPhase | null;
  } {
    const workspace = resolveStoryWorkspace(ctx, id, { terminalPhaseGuard: true });
    return {
      story: workspace.story,
      sourceStore: workspace.store,
      mainPhase:
        workspace.source === 'linked-worktree' && workspace.story.phase !== workspace.rootStory.phase
          ? workspace.rootStory.phase
          : null,
    };
  }

  return {
    story_update(args: {
      storyId: string;
      title?: string;
      description?: string;
      priority?: string;
      source?: string;
      depends?: string[];
      agent?: string;
      actor?: string;
    }): string {
      const story = store.readStory(args.storyId);
      const actor = storyUpdateActorFrom(args);
      assertInitReviewerStoryScopeMutationAllowed({
        story,
        command: 'story_update',
        actor,
        scopeFields: storyLevelScopeMutations(args),
      });
      if (args.title !== undefined) story.title = args.title;
      if (args.description !== undefined) story.description = args.description;
      if (args.priority !== undefined) story.priority = args.priority;
      if (args.source !== undefined) story.source = args.source;
      if (args.depends !== undefined) story.depends = args.depends;
      store.writeStory(args.storyId, story);
      return `Story ${args.storyId} updated`;
    },

    story_get(args: StoryGetArgs): object {
      const cl = (() => {
        try { return store.readChecklist(args.storyId); } catch { return { items: [] }; }
      })();

      const review = (() => {
        try { return store.readReview(args.storyId); } catch { return null; }
      })();

      const story = (() => {
        try { return store.readStory(args.storyId); } catch { return null; }
      })();

      const result: Record<string, unknown> = { checklist: cl, review };

      // B-95d8 CHK-001: surface the INIT_CHECK attestation so callers / dashboard can
      // distinguish an independent reviewer run from a manual fallback/repair.
      const initCheck = store.readInitCheck(args.storyId);
      const initCheckAttestation = initCheck ? initCheckAttestationMode(initCheck) : null;
      if (initCheck) {
        result.initCheck = initCheck;
        const attestation = initCheckAttestation;
        result.initCheckAttestation = attestation;
        if (initCheck.fallback) result.initCheckFallback = initCheck.fallback;
        // B-6894: human-readable warning for fallback stories only; independent
        // reviewer stories must NOT carry this field.
        if (attestation === 'fallback') {
          result.initCheckFallbackWarning =
            'INIT_CHECK was approved via manual fallback attestation, not independent reviewer approval. ' +
            'Later PLAN/DEV/REVIEW/TEST gates remain required. ' +
            'Implementation and continuation require explicit user/project authorization if this is not the requested project.';
        }
      }

      if (args.detail) {
        result.index = story;
      }
      if (!args.slim && !args.fields) return result;

      const slimResult = args.slim ? {
        story: story ? {
          storyId: story.storyId,
          name: story.name,
          title: story.title,
          phase: story.phase,
          priority: story.priority,
          type: story.type,
          currentReviewRound: story.currentReviewRound ?? null,
          riskSignals: story.riskSignals ?? [],
        } : null,
        checklist: summarizeChecklist(cl),
        review: review ? {
          reviewCount: review.reviews.length,
          latest: review.reviews.length > 0
            ? {
              timestamp: review.reviews[review.reviews.length - 1].timestamp,
              issueCount: review.reviews[review.reviews.length - 1].issueCount,
              blockerCount: review.reviews[review.reviews.length - 1].blockerCount,
            }
            : null,
        } : null,
        initCheck: initCheck ? {
          checkedAt: initCheck.checkedAt,
          agentId: initCheck.agentId,
          issueCount: initCheck.issues?.length ?? 0,
          attestation: initCheckAttestation,
          fallback: initCheck.fallback ?? null,
        } : null,
      } : result;

      return pickTopLevelFields(slimResult as Record<string, unknown>, args.fields);
    },

    story_list(args?: { phase?: StoryPhase; active?: boolean; full?: boolean; brief?: boolean; json?: boolean; format?: 'text' | 'json' }) {
      // B-89c7 CHK-016: active=true is a preset for "non-terminal phases"
      // (exclude DONE / DISCARDED / IDEA). Mutually exclusive with phase.
      if (args?.active && args?.phase) {
        throw new Error('story_list: active and phase are mutually exclusive');
      }
      const ACTIVE_PHASES = new Set<StoryPhase>([
        'INIT' as StoryPhase,
        'INIT_CHECK' as StoryPhase,
        'PLAN' as StoryPhase,
        'DEV' as StoryPhase,
        'TEST_CASE' as StoryPhase,
        'TEST_CASE_REVIEW' as StoryPhase,
        'TEST' as StoryPhase,
      ]);
      const ids = store.listStoryIds();

      // B-5fa4 CHK-002: zombie + residue detection
      const zombies = detectZombieStories(store, root);
      const residues = detectStoryResidue(store, root);
      const zombieIds = new Set(zombies.map(z => z.storyId));
      const residueIds = new Set(residues.map(r => r.storyId));

      const results = ids.map(id => {
        const { story, sourceStore, mainPhase } = readStoryProjection(id);
        const cl = (() => {
          try { return sourceStore.readChecklist(id); } catch { return { items: [] }; }
        })();
        const bugs = sourceStore.readBugs(id);
        const evidence = sourceStore.readTestEvidence(id);

        // B-1909 CHK-002: clDone counts DELIVERED (done) items only; withdrawn
        // items are terminal-but-not-delivered and surfaced separately so the row
        // never renders a withdrawn item as done nor looks permanently stuck.
        const clDone = cl.items.filter(i => isDeliveredChecklistStatus(i.status)).length;
        const clWithdrawn = cl.items.filter(i => isWithdrawnChecklistStatus(i.status)).length;
        const clTotal = cl.items.length;
        const bugsOpen = bugs.bugs.filter(b => b.status === 'open').length;
        const bugsFixed = bugs.bugs.filter(b => b.status === 'fixed').length;

        // B-abd8: process metrics summary
        const pm = sourceStore.readProcessMetrics(id);
        const metricsField = pm ? formatProcessMetricsSummary(pm, 'verbose') : null;

        // B-45ed CHK-008: bg:✓ marker (only outputs the field when background.md exists, omits the field without error when absent)
        const bgFlag = hasBackground(sourceStore, id) ? 'bg:✓' : null;

        // B-5fa4 CHK-002: append [zombie] / [terminal-worktree] labels
        const labels: string[] = [];
        if (zombieIds.has(id)) labels.push('[zombie]');
        if (residueIds.has(id)) labels.push('[terminal-worktree]');

        return {
          storyId: id,
          name: story.name || '',
          title: story.title,
          phase: story.phase,
          priority: story.priority,
          type: story.type,
          ...(mainPhase ? { mainPhase } : {}),
          checklist: clTotal > 0 ? `${clDone}/${clTotal}${clWithdrawn > 0 ? ` +${clWithdrawn}w` : ''}` : '-',
          bugs: bugsOpen > 0 ? `${bugsOpen} open, ${bugsFixed} fixed` : (bugsFixed > 0 ? `${bugsFixed} fixed` : 'none'),
          tests: evidence && evidence.result ? evidence.result.toLowerCase() : 'none',
          ...(metricsField ? { metrics: metricsField } : {}),
          ...(bgFlag ? { bg: bgFlag } : {}),
          ...(labels.length > 0 ? { labels: labels.join(' ') } : {}),
        };
      });

      const filtered = args?.phase
        ? results.filter(r => r.phase === args.phase)
        : args?.active
        ? results.filter(r => ACTIVE_PHASES.has(r.phase as StoryPhase))
        : results;

      // Dashboard summary (generated when there is no phase/active filter)
      if (!args?.phase && !args?.active) {
        const total = results.length;
        const done = results.filter(r => r.phase === 'DONE').length;
        const phases: Record<string, number> = {};
        for (const r of results) {
          phases[r.phase] = (phases[r.phase] || 0) + 1;
        }

        // Test statistics
        const withTests = results.filter(r => r.tests !== 'none');
        const withoutTests = results.filter(r => r.tests === 'none');
        const passedTests = results.filter(r => r.tests === 'pass');

        // Bug statistics
        const bugStories = results.filter(r => r.type === 'bug');
        const storiesWithBugs = results.filter(r => r.bugs !== 'none');
        let totalBugsOpen = 0;
        let totalBugsFixed = 0;
        for (const r of results) {
          const bd = store.readBugs(r.storyId);
          totalBugsOpen += bd.bugs.filter(b => b.status === 'open').length;
          totalBugsFixed += bd.bugs.filter(b => b.status === 'fixed').length;
        }
        const totalBugs = totalBugsOpen + totalBugsFixed + bugStories.length;

        const mkBar = (pct: number) => '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));
        const storyPct = total > 0 ? Math.round(done / total * 100) : 0;
        const testPct = total > 0 ? Math.round(withTests.length / total * 100) : 0;
        const passPct = total > 0 ? Math.round(passedTests.length / total * 100) : 0;
        const bugFreePct = total > 0 ? Math.round((total - storiesWithBugs.length - bugStories.length) / total * 100) : 0;

        const dashboard = [
          `Story Completion ${mkBar(storyPct)} ${storyPct}% (${done}/${total} DONE)`,
          `Test Coverage    ${mkBar(testPct)} ${testPct}% (${withTests.length}/${total} with test evidence)`,
          `Test Pass        ${mkBar(passPct)} ${passPct}% (${passedTests.length}/${total} PASS)`,
          `Bug-Free Rate    ${mkBar(bugFreePct)} ${bugFreePct}% (${total - storiesWithBugs.length - bugStories.length}/${total} bug-free)`,
          `Bug Total        ${totalBugs} (open: ${totalBugsOpen}, fixed: ${totalBugsFixed}, bug story: ${bugStories.length})`,
        ].join('\n');

        // Bug suggestions
        const bugSuggestions: string[] = [];
        if (totalBugsOpen > 0) {
          bugSuggestions.push(`⚠ ${totalBugsOpen} open bugs awaiting fix, recommend prioritizing`);
        }
        // B-7c05: a terminal (DONE or DISCARDED) bug story is closed and must not
        // be flagged "not closed" — restores the commit 288d359377 behavior that
        // had regressed before B-7c05 (the filter only excluded DONE, so DISCARDED
        // bug stories were re-listed; verify-story-list-bug-summary.mjs asserts
        // against it). Summary-display only; declared in B-7c05 F-002/summary.
        const openBugStories = bugStories.filter(r => r.phase !== 'DONE' && r.phase !== 'DISCARDED');
        if (openBugStories.length > 0) {
          bugSuggestions.push(`⚠ Bug Story not closed: ${openBugStories.map(r => r.storyId).join(', ')}`);
        }
        if (totalBugs > 0 && total > 0) {
          const bugRate = (totalBugs / total).toFixed(2);
          bugSuggestions.push(`Bug/Story ratio: ${bugRate}, run bug_analyze() to see the detailed report`);
        }

        // B-5fa4 CHK-002: zombie + residue warnings in dashboard
        if (zombies.length > 0) {
          bugSuggestions.push(
            `⚠ Zombie stories (${zombies.length}): ${zombies.map(z => z.storyId).join(', ')} — branch merged/deleted but phase is not terminal`,
          );
        }
        if (residues.length > 0) {
          bugSuggestions.push(
            `⚠ Terminal worktrees (${residues.length}): ${residues.map(r => r.storyId).join(', ')} — phase is terminal but directories still exist under .worktrees/ (may still be registered, or may be orphan)`,
          );
        }

        // B-7c05 CHK-004: story_list default is BRIEF. The full 785-entry story
        // array (365KB on the real repo) is the payload; brief keeps every meta
        // field (_dashboard/_hint/_phases/_bugSummary) and lists only non-terminal
        // stories as one-liners, with per-phase counts covering ALL stories.
        // --full / --json / PROOF_OR_STOP_BRIEF_OUTPUT=0 restore the current full shape.
        const full = wantsFullOutput(args);
        const testMissingFull = withoutTests.length > 0
          ? `Stories missing tests: ${withoutTests.map(r => r.storyId).join(', ')}`
          : 'All Stories have test evidence';
        const bugSummary = bugSuggestions.length > 0 ? bugSuggestions.join('\n') : 'No bug issues';
        if (full) {
          return {
            _dashboard: dashboard,
            _hint: 'Please display the dashboard at the front',
            _phases: phases,
            _bugSummary: bugSummary,
            _testMissing: testMissingFull,
            stories: filtered,
          };
        }
        const nonTerminal = filtered.filter(r => !STORY_LIST_TERMINAL_PHASES.has(r.phase));
        const omittedTerminal = filtered.length - nonTerminal.length;
        return {
          _dashboard: dashboard,
          _brief: true,
          _hint: `Brief view: ${nonTerminal.length} non-terminal stories listed; ${omittedTerminal} terminal (DONE/DISCARDED/IDEA) omitted (see _phases for the full per-phase distribution). Use --full (or PROOF_OR_STOP_BRIEF_OUTPUT=0) for every story with full fields.`,
          _phases: phases,
          _bugSummary: bugSummary,
          _testMissing: withoutTests.length > 0
            ? `${withoutTests.length} stories missing test evidence`
            : 'All Stories have test evidence',
          _omittedTerminal: omittedTerminal,
          stories: nonTerminal.map(r => toBriefStoryRow(r as StoryListRow)),
        };
      }
      return filtered;
    },

    /**
     * story_reconcile — Detect and repair "zombie" stories
     *
     * Scenario: branch has been manually merged back to main or deleted, but the story state file remains in a non-terminal state.
     * dryRun=true (default) only reports without modifying; dryRun=false performs the repair.
     */
    story_reconcile(args?: { dryRun?: boolean }): string {
      const dryRun = args?.dryRun !== false; // Default to dry run

      const render = (repair: boolean): string => {
        const repoRoot = getRepoRoot(ctx.root);
        const zombies = detectZombieStories(store, ctx.root);
        const residues = scanTerminalStoryResidues(store, ctx.root);
        const auxiliary = scanAuxiliaryWorktreeResidues(ctx.root, store);

        if (zombies.length === 0 && residues.length === 0 && auxiliary.length === 0) {
          return 'story_reconcile: No zombie stories or auxiliary worktree residues detected, branch state is normal for all non-terminal stories.';
        }

        const lines: string[] = [];
        lines.push(`Detected ${zombies.length} zombie stories (branch merged/deleted but phase non-terminal), ${residues.length} terminal story residues, ${auxiliary.length} auxiliary story worktree residues:`);
        lines.push('');

        for (const z of zombies) {
          const reason = z.branchMerged
            ? `Branch ${z.branch} has been merged into main`
            : `Branch ${z.branch} no longer exists`;
          lines.push(`  ${z.storyId}  phase=${z.phase}  ${reason}`);

          if (z.worktreeForeignPath && z.worktreePath) {
            lines.push(`    worktree: ${z.worktreePath} (foreign stale path)`);
          } else if (z.worktreeExists) {
            lines.push(`    worktree: ${z.worktreePath} (still exists)`);
          } else if (z.worktreePath) {
            lines.push(`    worktree: ${z.worktreePath} (no longer exists)`);
          }

          if (repair) {
            // B-70a6 F-005: this repair writes the TERMINAL phase DONE directly
            // (see below) — it never routes through runStoryTransitionInner, so
            // the reopen-audit reconciliation that runs there never runs here,
            // and after DONE there is no transition left to heal a crashed
            // reopen. The worktree removal a few lines down can also destroy the
            // copy holding the record. Rescue the audit event FIRST, into the
            // surviving store's log, and only THEN read the story object that the
            // phase write persists (reading it earlier would resurrect a record
            // the rescue just cleared). Never throws: the repair is legitimate.
            //
            // CONCURRENCY RESIDUAL (B-70a6 F-013): a ONE-TIME SCAN, taken WITHOUT
            // the per-story transition lock, so it covers only a record already
            // on disk when the repair starts — never a reopen racing it. The lock
            // is deliberately NOT taken HERE in particular: this whole repair
            // already runs inside withMainWriteLock (see the call at the bottom of
            // story_reconcile), while the established order is transitionLock ->
            // mainWriteLock, so acquiring it here would invert that order and let
            // a repair sit on the main write lock waiting for a transition that is
            // itself fail-fasting on the main write lock. B-70a6 F-014: that
            // lock-order reason is SPECIFIC TO THIS SITE and must not be carried
            // over to story_discard, which takes its main write lock only AFTER
            // its rescue and destruction and so would not invert anything; the
            // reasons that hold there are different ones. Full reasoning + the
            // follow-up scope live on
            // reconcileReopenAuditBeforeOutOfBandPhaseChange.
            const reopenAuditRescue = reconcileReopenAuditBeforeOutOfBandPhaseChange({
              storyId: z.storyId,
              store,
              recordRoots: [z.worktreePath],
            });
            const story = store.readStory(z.storyId);
            const actions: string[] = [];
            for (const notice of renderOutOfBandReopenAuditNotice(z.storyId, reopenAuditRescue)) {
              lines.push(`    ${notice}`);
            }

            // Clean up worktree directory
            if (z.worktreeExists && z.worktreePath) {
              try {
                execFileSync('git', ['worktree', 'remove', '--force', z.worktreePath], {
                  cwd: repoRoot,
                  encoding: 'utf-8',
                  stdio: ['pipe', 'pipe', 'pipe'],
                });
                actions.push('worktree removed');
              } catch {
                // When worktree remove fails, try deleting the directory directly
                try {
                  rmSync(z.worktreePath, { recursive: true, force: true });
                  actions.push('worktree directory force-deleted');
                } catch { actions.push('worktree cleanup failed'); }
              }
            }

            // Delete the merged branch
            if (z.branchExists) {
              try {
                execFileSync('git', ['branch', '-d', z.branch], {
                  cwd: repoRoot,
                  encoding: 'utf-8',
                  stdio: ['pipe', 'pipe', 'pipe'],
                });
                actions.push(`Branch ${z.branch} deleted`);
              } catch {
                actions.push(`Branch ${z.branch} deletion failed (may have unmerged commits)`);
              }
            }

            // Update story status to DONE
            story.phase = 'DONE' as StoryPhase;
            story.endedAt = new Date().toISOString();
            story.worktree = undefined;
            if (!story.events) story.events = [];
            const event = collectContext('DONE' as StoryPhase, 'advance');
            (event as any).reconciled = true;
            (event as any).reason = `story_reconcile: ${z.branchMerged ? 'branch merged into main' : 'branch deleted'}`;
            story.events.push(event);
            store.writeStory(z.storyId, story);
            actions.push('phase → DONE');

            lines.push(`    → Fixed: ${actions.join(', ')}`);
          }
        }

        if (residues.length > 0) {
          lines.push('');
          lines.push('Terminal-state story residue:');
          for (const residue of residues) {
            lines.push(`  ${residue.storyId} phase=${residue.phase} ${residue.safe ? 'safe-untracked' : 'unsafe-tracked/staged'} — ${residue.path}`);
            if (residue.status) {
              for (const line of residue.status.split('\n').slice(0, 4)) lines.push(`    ${line}`);
            }
            if (repair && residue.safe) {
              rmSync(residue.path, { recursive: true, force: true });
              lines.push('    → Residue directory cleaned up');
            }
          }
        }

        if (auxiliary.length > 0) {
          lines.push('');
          lines.push('Auxiliary story worktree residues:');
          for (const classification of auxiliary) {
            lines.push(`  ${renderAuxiliaryClassification(ctx.root, classification)}`);
          }
          if (repair) {
            lines.push('');
            lines.push('Auxiliary cleanup:');
            const results = cleanupAuxiliaryWorktreeResidues(ctx.root, store);
            for (const result of results) {
              const label = renderAuxiliaryClassification(ctx.root, result.before);
              lines.push(`  ${result.cleaned ? '✓ Cleaned' : '⚠ Skipped'} ${label}`);
              for (const action of result.actions) lines.push(`    ${action}`);
            }
          }
        }

        if (!repair) {
          lines.push('');
          lines.push('Above is dry run result, no modifications made.');
          lines.push('Apply fixes: proof-or-stop story_reconcile \'{"dryRun":false}\'');
        }

        return lines.join('\n');
      };

      if (dryRun) return render(false);
      return withMainWriteLock(getRepoRoot(ctx.root), () => render(true), { label: 'story_reconcile repair' });
    },

    /**
     * @task B-e3a4
     * @checklist CHK-002
     * @title migrate story artifacts out of docs directory
     * @type feature
     * @priority high
     * @description
     *   Story artifacts and activity logs are Proof-or-Stop machine state, not human
     *   documentation. This command migrates legacy docs/story/actives data
     *   into the configured storyDir and legacy docs/story/activity.jsonl into
     *   .proof-or-stop/activity.jsonl, backing up removed legacy files under .proof-or-stop.
     * @changes
     *   - [CHK-002] Preview legacy-to-runtime story storage migration
     *   - [CHK-002] Copy legacy story directories to config.storyDir
     *   - [CHK-002] Move legacy docs/story/actives to .proof-or-stop/legacy-backup on confirm
     *   - [B-281f/CHK-001] Merge legacy docs/story/activity.jsonl into .proof-or-stop/activity.jsonl
     *   - [B-281f/CHK-002] Remove docs/story only when it becomes empty after migration
     * @test story-storage-migration
     */
    story_migrate_storage(args?: { dryRun?: boolean; confirm?: boolean }): string {
      const cfg = loadConfig(ctx.root);
      const legacyRel = 'docs/story/actives';
      const targetRel = cfg.storyDir.replace(/\\/g, '/');
      const legacyRoot = join(ctx.root, legacyRel);
      const targetRoot = join(ctx.root, targetRel);
      const legacyActivityRel = 'docs/story/activity.jsonl';
      const targetActivityRel = PROOF_OR_STOP_ACTIVITY_LOG;
      const legacyActivityPath = getLegacyActivityLogPath(ctx.root);
      const targetActivityPath = getRuntimeActivityLogPath(ctx.root);
      const docsStoryRoot = join(ctx.root, 'docs', 'story');
      const lines: string[] = [];
      const legacyIds = listStoryDirs(legacyRoot);
      const targetIds = listStoryDirs(targetRoot);
      const toCopy = legacyIds.filter(id => !targetIds.includes(id));
      const storyDirMigrationEnabled = legacyRel !== targetRel;
      const hasLegacyActives = existsSync(legacyRoot);
      const hasLegacyActivity = existsSync(legacyActivityPath);
      const hasTargetActivity = existsSync(targetActivityPath);

      lines.push(`story_migrate_storage: ${legacyRel} -> ${targetRel}`);
      lines.push(`  legacy stories: ${legacyIds.length}`);
      lines.push(`  target stories : ${targetIds.length}`);
      lines.push(`  to copy        : ${storyDirMigrationEnabled ? toCopy.length : 0}`);
      lines.push(`  legacy activity: ${hasLegacyActivity ? legacyActivityRel : '(none)'}`);
      lines.push(`  target activity: ${hasTargetActivity ? `${targetActivityRel} (append)` : targetActivityRel}`);

      if (!storyDirMigrationEnabled) {
        lines.push('  story dir no-op: configured storyDir is still the legacy path');
      }
      if (!hasLegacyActives) {
        lines.push('  story dir no-op: legacy story directory does not exist');
      }
      if (!hasLegacyActives && !hasLegacyActivity) {
        lines.push('  no-op: no legacy story artifacts or activity log found');
        return lines.join('\n');
      }

      if (args?.dryRun !== false || !args?.confirm) {
        if (storyDirMigrationEnabled && toCopy.length > 0) lines.push(`  will copy: ${toCopy.slice(0, 12).join(', ')}${toCopy.length > 12 ? ` (+${toCopy.length - 12} more)` : ''}`);
        if (storyDirMigrationEnabled && hasLegacyActives) lines.push('  will backup legacy dir to .proof-or-stop/legacy-backup/docs-story-actives-<timestamp>');
        if (hasLegacyActivity) {
          lines.push(`  will migrate activity: ${legacyActivityRel} -> ${targetActivityRel}${hasTargetActivity ? ' (append)' : ''}`);
          lines.push('  will backup legacy activity to .proof-or-stop/legacy-backup/docs-story-activity-<timestamp>.jsonl');
        }
        lines.push('  will remove docs/story only if it is empty after migration');
        lines.push('→ Confirm migration: proof-or-stop story_migrate_storage \'{"dryRun":false,"confirm":true}\'');
        return lines.join('\n');
      }

      const backupRoot = join(ctx.root, PROOF_OR_STOP_DIR, 'legacy-backup');
      mkdirSync(backupRoot, { recursive: true });
      let copied = 0;
      let activesBackup: string | null = null;
      let activityBackup: string | null = null;
      let activityMigrated = false;

      if (storyDirMigrationEnabled && hasLegacyActives) {
        mkdirSync(targetRoot, { recursive: true });
        for (const id of toCopy) {
          cpSync(join(legacyRoot, id), join(targetRoot, id), { recursive: true, force: false });
          copied += 1;
        }
        activesBackup = join(backupRoot, `docs-story-actives-${Date.now()}`);
        renameSync(legacyRoot, activesBackup);
      }

      if (hasLegacyActivity) {
        const legacyActivity = readFileSync(legacyActivityPath, 'utf-8');
        const targetActivity = hasTargetActivity ? readFileSync(targetActivityPath, 'utf-8') : '';
        mkdirSync(join(ctx.root, PROOF_OR_STOP_DIR), { recursive: true });
        writeFileSync(targetActivityPath, appendJsonlContent(targetActivity, legacyActivity));
        activityBackup = join(backupRoot, `docs-story-activity-${Date.now()}.jsonl`);
        renameSync(legacyActivityPath, activityBackup);
        activityMigrated = true;
      }

      const removedDocsStory = removeEmptyDir(docsStoryRoot);

      lines.push(`  copied: ${copied}`);
      if (activesBackup) lines.push(`  backup actives: ${activesBackup}`);
      if (activityMigrated) lines.push(`  activity migrated: ${legacyActivityRel} -> ${targetActivityRel}`);
      if (activityBackup) lines.push(`  backup activity: ${activityBackup}`);
      lines.push(`  docs/story cleanup: ${removedDocsStory ? 'removed empty directory' : 'kept (missing or non-empty)'}`);
      lines.push('✓ story storage migrated');
      return lines.join('\n');
    },

    /**
     * @task B-2b38
     * @checklist CHK-001, CHK-002
     * @title safely sync story branch with main
     * @type feature
     * @priority high
     * @description
     *   Manual `git merge main` inside a story worktree can overwrite the
     *   story phase if users resolve `.proof-or-stop/story/actives/<storyId>/index.json`
     *   with main's version. story_sync_main wraps that operation: current
     *   story metadata conflicts are resolved with `--ours`, while real code
     *   conflicts remain visible and block completion.
     * @changes
     *   - [CHK-001] Add dry-run/confirm guarded story_sync_main command
     *   - [CHK-002] Auto-resolve only current story metadata conflicts with --ours
     *   - [CHK-002] Leave non-story conflicts unresolved with explicit guidance
     * @test story-sync-main
     */
    story_sync_main(args: { storyId: string; dryRun?: boolean; confirm?: boolean }): string {
      const story = ctx.store.readStory(args.storyId);
      if (!story.worktree) {
        throw new Error(`Story ${args.storyId} has no worktree metadata, cannot safely sync main. Please check story status first.`);
      }
      assertCwdInWorktree(ctx.store, args.storyId);

      const cwd = process.cwd();
      const cfg = loadConfig(ctx.root);
      const storyDirRel = cfg.storyDir.replace(/\\/g, '/');
      const storyMetaPrefix = `${storyDirRel}/${args.storyId}/`;
      const expectedBranch = story.worktree.branch || `story/${args.storyId}`;
      const currentBranch = gitOutput(cwd, 'rev-parse --abbrev-ref HEAD');
      const mainRef = 'main';
      const lines: string[] = [];

      if (currentBranch !== expectedBranch) {
        throw new Error(
          `Story ${args.storyId} current branch does not match, refusing to sync main.\n` +
          `Expected: ${expectedBranch}\nCurrent: ${currentBranch}`,
        );
      }

      const currentHead = gitOutput(cwd, 'rev-parse --short HEAD');
      let mainHead = 'unknown';
      try { mainHead = gitOutput(cwd, `rev-parse --short ${mainRef}`); } catch { /* PROBE: main may not exist */ }
      const alreadyContainsMain = gitSucceeds(cwd, `merge-base --is-ancestor ${shellQuote(mainRef)} HEAD`);

      lines.push(`story_sync_main: ${args.storyId}`);
      lines.push(`  cwd: ${cwd}`);
      lines.push(`  branch: ${currentBranch}`);
      lines.push(`  current HEAD: ${currentHead}`);
      lines.push(`  main HEAD   : ${mainHead}`);
      lines.push(`  protect    : ${storyMetaPrefix}*`);

      if (args.dryRun === true || !args.confirm) {
        lines.push(alreadyContainsMain
          ? '  status     : story branch already contains main'
          : '  status     : confirm will run git merge main');
        lines.push('  metadata conflicts under the protected path will be resolved with --ours');
        lines.push('  source/other conflicts will remain unresolved and stop the command');
        lines.push(`→ Confirm sync: proof-or-stop story_sync_main '{"storyId":"${args.storyId}","confirm":true}'`);
        return lines.join('\n');
      }

      const dirty = gitPorcelainPaths(cwd).filter(path => !isVolatileRuntimeArtifactPath(path));
      if (dirty.length > 0) {
        throw new Error(`Cannot sync main: working tree has uncommitted changes:\n${dirty.slice(0, 20).join('\n')}`);
      }

      try {
        const out = gitOutput(cwd, `-c commit.gpgsign=false merge ${shellQuote(mainRef)} --no-ff -m ${shellQuote(`sync main into ${args.storyId}`)}`);
        lines.push(out || '✓ main already merged');
        lines.push(`✓ Story ${args.storyId} is synced with main`);
        lines.push(`→ Please rerun: proof-or-stop test_story '{"storyId":"${args.storyId}"}'`);
        return lines.join('\n');
      } catch {
        const unmerged = gitUnmergedPaths(cwd);
        const protectedConflicts = unmerged.filter(path => path.startsWith(storyMetaPrefix));
        const unresolved = unmerged.filter(path => !path.startsWith(storyMetaPrefix));

        for (const path of protectedConflicts) {
          gitOutput(cwd, `checkout --ours -- ${shellQuote(path)}`);
          gitOutput(cwd, `add -- ${shellQuote(path)}`);
        }

        if (unresolved.length > 0) {
          throw new Error(
            `story_sync_main stopped: unresolved non-story conflicts remain.\n` +
            (protectedConflicts.length > 0
              ? `Story metadata conflicts auto-resolved with --ours:\n${protectedConflicts.map(path => `  - ${path}`).join('\n')}\n`
              : '') +
            `Unresolved conflicts:\n${unresolved.map(path => `  - ${path}`).join('\n')}\n\n` +
            `Please manually resolve the above real conflicts then git add + git commit, then rerun proof-or-stop test_story '{"storyId":"${args.storyId}"}'.`,
          );
        }

        const staged = gitOutput(cwd, 'diff --cached --name-only');
        if (staged) {
          gitOutput(cwd, `-c commit.gpgsign=false commit -m ${shellQuote(`sync main into ${args.storyId} (story metadata ours)`)}`);
        }
        lines.push('Story metadata conflicts auto-resolved with --ours:');
        for (const path of protectedConflicts) lines.push(`  - ${path}`);
        lines.push(`✓ Story ${args.storyId} is synced with main`);
        lines.push(`→ Please rerun: proof-or-stop test_story '{"storyId":"${args.storyId}"}'`);
        return lines.join('\n');
      }
    },
  };
}

function listStoryDirs(base: string): string[] {
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(base, entry.name, 'index.json')))
    .map(entry => entry.name)
    .sort();
}

function scanTerminalStoryResidues(store: StoryStore, root: string): StoryResidueInfo[] {
  const cfg = loadConfig(root);
  const base = join(root, cfg.storyDir);
  // B-75f0 CHK-003: survey the REAL gitRoot on wrapper-root layouts (story
  // metadata root != git root); falls back to root verbatim on plain repos /
  // when no gitRoot resolves (byte-identical). Project-level: the same gitRoot
  // for every story, so resolve once before the loop.
  const gitCwd = resolveProjectGitCwd(root, root, cfg);
  const residues: StoryResidueInfo[] = [];
  let ids: string[] = [];
  try { ids = store.listStoryIds(); } catch { return []; }
  for (const id of ids) {
    let story: StoryInfo;
    try { story = store.readStory(id); } catch { continue; }
    if (story.phase !== 'DONE' && story.phase !== 'DISCARDED') continue;
    const rel = `${cfg.storyDir.replace(/\\/g, '/')}/${id}`;
    let raw = '';
    try {
      // No full-output trim(): it would strip the first porcelain row's leading
      // status space and corrupt the stored/displayed status text.
      raw = execSync(`git status --porcelain -uall -- ${JSON.stringify(rel)}`, {
        cwd: gitCwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch { continue; }
    const lines = raw.split('\n').map(line => line.trimEnd()).filter(Boolean);
    if (lines.length === 0) continue;
    const status = lines.join('\n');
    residues.push({
      storyId: id,
      phase: story.phase,
      path: join(base, id),
      safe: lines.length > 0 && lines.every(line => line.startsWith('?? ')),
      status,
    });
  }
  return residues;
}
