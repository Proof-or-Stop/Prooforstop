/**
 * Proof-or-Stop dashboard — real-time story progress board
 *
 * Refreshes every N seconds, supports switching between multiple project directories.
 * Press a number key to switch projects, press q to quit.
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, resolve, basename } from 'path';
import { StoryStore } from './core/store.js';
import { loadConfig, hasProjectConfigFile, PROOF_OR_STOP_CONFIG_FILENAME } from './core/config.js';
import { resolveProjectGitCwd } from './core/story-signed-workspace-resolution.js';
import { formatStoryOutcomeKind, normalizeStoryOutcomeKind, type StoryOutcomeKind, type StoryInfo, type ChecklistData } from './core/types.js';
import { isDeliveredChecklistStatus, isWithdrawnChecklistStatus } from './core/checklist-status.js';

// ── Types ──

export interface ProjectSnapshot {
  root: string;
  label: string;
  stories: StorySnapshot[];
  totalStories: number;
  doneStories: number;
  doneOutcomes: Record<StoryOutcomeKind, number>;
  totalBugsOpen: number;
  gitDirty: number;
  error?: string;
}

interface StorySnapshot {
  id: string;
  phase: string;
  title: string;
  checklistDone: number;
  checklistTotal: number;
  /** B-1909 F-005: withdrawn items are terminal-but-not-delivered (own bucket). */
  checklistWithdrawn: number;
  bugsOpen: number;
  worktreePath?: string;
}

// ── Data collection ──

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

export function collectProject(root: string): ProjectSnapshot {
  const label = basename(resolve(root));
  try {
    const store = new StoryStore(root);
    const ids = store.listStoryIds();

    // B-75f0 CHK-003: survey the REAL gitRoot on wrapper-root layouts (story
    // metadata root != git root); falls back to root verbatim on plain repos /
    // when no gitRoot resolves (byte-identical). Project-level: one gitRoot for
    // the whole snapshot, used by both the worktree-list and dirty-status scans.
    const gitCwd = resolveProjectGitCwd(root, root, loadConfig(root));

    let doneStories = 0;
    const doneOutcomes = emptyDoneOutcomes();
    let totalBugsOpen = 0;
    const stories: StorySnapshot[] = [];

    // Worktree map
    const worktrees: Record<string, string> = {};
    try {
      const raw = execSync('git worktree list --porcelain', {
        cwd: gitCwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      });
      let currentPath = '';
      for (const line of raw.split('\n')) {
        if (line.startsWith('worktree ')) currentPath = line.slice(9).trim();
        else if (line.startsWith('branch ')) {
          const m = line.slice(7).trim().match(/refs\/heads\/story\/(.+)$/);
          if (m && currentPath) worktrees[m[1]] = currentPath;
        }
      }
    } catch { /* not git */ }

    for (const id of ids) {
      try {
        const story = store.readStory(id);
        if (story.phase === 'DONE') {
          doneStories++;
          const summary = store.readSummary(id);
          doneOutcomes[normalizeStoryOutcomeKind(summary?.outcomeKind)]++;
        }

        let bugsOpen = 0;
        try {
          const bd = store.readBugs(id);
          bugsOpen = bd.bugs.filter(b => b.status === 'open').length;
        } catch { /* no bugs */ }
        totalBugsOpen += bugsOpen;

        // Skip terminal states for active list
        if (story.phase === 'DONE' || story.phase === 'DISCARDED') continue;

        let checklistDone = 0, checklistTotal = 0, checklistWithdrawn = 0;
        try {
          const cl = store.readChecklist(id);
          if (cl && Array.isArray(cl.items)) {
            checklistTotal = cl.items.length;
            // B-1909 F-005: delivered/done count is DELIVERED-only (never counts
            // withdrawn); a withdrawn item is terminal-but-not-delivered and gets
            // its own bucket, matching handlers/checklist.ts summarizeChecklist.
            checklistDone = cl.items.filter(i => isDeliveredChecklistStatus(i.status)).length;
            checklistWithdrawn = cl.items.filter(i => isWithdrawnChecklistStatus(i.status)).length;
          }
        } catch { /* no checklist */ }

        stories.push({
          id,
          phase: story.phase,
          title: story.title || '',
          checklistDone,
          checklistTotal,
          checklistWithdrawn,
          bugsOpen,
          worktreePath: worktrees[id],
        });
      } catch { /* skip unreadable */ }
    }

    // Git dirty count
    let gitDirty = 0;
    try {
      const status = execSync('git status --porcelain', {
        cwd: gitCwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      if (status) gitDirty = status.split('\n').length;
    } catch { /* not git */ }

    return {
      root, label, stories,
      totalStories: ids.length, doneStories, doneOutcomes, totalBugsOpen, gitDirty,
    };
  } catch (e) {
    return {
      root, label, stories: [],
      totalStories: 0, doneStories: 0, doneOutcomes: emptyDoneOutcomes(), totalBugsOpen: 0, gitDirty: 0,
      error: (e as Error).message,
    };
  }
}

// ── Rendering ──

function progressBar(done: number, total: number, width: number): string {
  if (total === 0) return '░'.repeat(width);
  const filled = Math.round((done / total) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function phaseColor(phase: string): string {
  // ANSI colors
  const colors: Record<string, string> = {
    IDEA: '\x1b[90m',      // gray
    INIT: '\x1b[37m',      // white
    INIT_CHECK: '\x1b[37m',
    PLAN: '\x1b[36m',      // cyan
    DEV: '\x1b[33m',       // yellow
    TEST_CASE: '\x1b[35m', // magenta
    TEST_CASE_REVIEW: '\x1b[35m',
    TEST: '\x1b[34m',      // blue
    DONE: '\x1b[32m',      // green
    DISCARDED: '\x1b[90m', // gray
  };
  return colors[phase] || '\x1b[0m';
}

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

export function renderProject(proj: ProjectSnapshot, index: number, selected: boolean): string[] {
  const lines: string[] = [];
  const marker = selected ? '▶' : ' ';
  const highlight = selected ? BOLD : '';

  if (proj.error) {
    lines.push(`${marker} ${highlight}[${index + 1}] ${proj.label}${RESET}  ${DIM}${proj.root}${RESET}`);
    lines.push(`     \x1b[31m✗ ${proj.error}${RESET}`);
    return lines;
  }

  const donePct = proj.totalStories > 0
    ? Math.round((proj.doneStories / proj.totalStories) * 100)
    : 0;
  const dashLine = `Lifecycle DONE: ${proj.doneStories}/${proj.totalStories} (${donePct}%) · outcomes: ${renderDoneOutcomes(proj.doneOutcomes)}`;
  const bugStr = proj.totalBugsOpen > 0 ? ` · \x1b[31m${proj.totalBugsOpen} bugs\x1b[0m` : '';
  const dirtyStr = proj.gitDirty > 0 ? ` · ${DIM}${proj.gitDirty} dirty${RESET}` : '';

  lines.push(`${marker} ${highlight}[${index + 1}] ${proj.label}${RESET}  ${DIM}${proj.root}${RESET}`);
  lines.push(`     ${dashLine}${bugStr}${dirtyStr}`);

  if (proj.stories.length === 0 && proj.totalStories > 0) {
    lines.push(`     ${DIM}(all stories in terminal state)${RESET}`);
    return lines;
  }

  // Sort: DEV/TEST first, then by phase
  const phaseOrder: Record<string, number> = {
    DEV: 0, TEST: 1, TEST_CASE: 2, TEST_CASE_REVIEW: 3,
    PLAN: 4, INIT_CHECK: 5, INIT: 6, IDEA: 7,
  };
  const sorted = [...proj.stories].sort((a, b) =>
    (phaseOrder[a.phase] ?? 99) - (phaseOrder[b.phase] ?? 99),
  );

  const maxShow = selected ? 50 : 5;
  for (const s of sorted.slice(0, maxShow)) {
    const phasePad = s.phase.padEnd(17);
    const titleTrunc = s.title.length > 40 ? s.title.slice(0, 39) + '…' : s.title;
    // B-1909 F-005: the bar fills on TERMINAL progress (done + withdrawn) so a
    // story with a legitimately withdrawn item can reach 100% instead of parking
    // the withdrawn item in the outstanding remainder forever. The numeric label
    // keeps done DELIVERED-only and annotates withdrawn separately so the two are
    // never conflated.
    const checklistTerminal = s.checklistDone + s.checklistWithdrawn;
    const withdrawnMark = s.checklistWithdrawn > 0 ? ` ${DIM}(+${s.checklistWithdrawn} withdrawn)${RESET}` : '';
    const bar = s.checklistTotal > 0
      ? ` ${progressBar(checklistTerminal, s.checklistTotal, 8)} ${s.checklistDone}/${s.checklistTotal}${withdrawnMark}`
      : '';
    const bugMark = s.bugsOpen > 0 ? ` \x1b[31m[${s.bugsOpen}bug]${RESET}` : '';
    lines.push(`     ${phaseColor(s.phase)}${s.id} ${phasePad}${RESET} ${titleTrunc}${bar}${bugMark}`);
  }

  if (sorted.length > maxShow) {
    lines.push(`     ${DIM}... ${sorted.length - maxShow} more${RESET}`);
  }

  return lines;
}

function render(projects: ProjectSnapshot[], selectedIdx: number, intervalSec: number): string {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-GB', { hour12: false });
  const dateStr = now.toISOString().slice(0, 10);

  const lines: string[] = [];
  lines.push('');
  lines.push(`${BOLD}  Proof-or-Stop dashboard${RESET}  ${DIM}⟳ ${intervalSec}s   ${dateStr} ${timeStr}${RESET}`);
  lines.push(`  ${'─'.repeat(60)}`);

  for (let i = 0; i < projects.length; i++) {
    if (i > 0) lines.push('');
    lines.push(...renderProject(projects[i], i, i === selectedIdx));
  }

  lines.push('');
  lines.push(`  ${DIM}[1-${projects.length}] switch project  [q] quit  [r] refresh${RESET}`);
  lines.push('');

  return lines.join('\n');
}

// ── Main loop ──

export interface DashboardArgs {
  roots?: string;
  interval?: number;
}

export async function runDashboard(args: DashboardArgs): Promise<void> {
  // Parse roots — comma-separated or single
  const rootsRaw = args.roots || process.cwd();
  const roots = rootsRaw.split(',').map(r => r.trim()).filter(Boolean).map(r => resolve(r));

  // Validate roots — accept proof-or-stop.config.json (canonical) or
  // proof-or-stop.config.json.
  for (const r of roots) {
    if (!hasProjectConfigFile(r)) {
      console.error(`✗ No ${PROOF_OR_STOP_CONFIG_FILENAME} found in: ${r}`);
      process.exit(1);
    }
  }

  const intervalSec = args.interval || 5;
  let selectedIdx = 0;
  let running = true;

  // Setup raw mode for keypress
  const stdin = process.stdin;
  if (stdin.isTTY) {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf-8');
  }

  stdin.on('data', (key: string) => {
    if (key === 'q' || key === '\x03') { // q or Ctrl+C
      running = false;
      cleanup();
      process.exit(0);
    }
    if (key === 'r') {
      // Force refresh
      refresh();
    }
    // Number keys 1-9
    const num = parseInt(key, 10);
    if (num >= 1 && num <= roots.length) {
      selectedIdx = num - 1;
      refresh();
    }
  });

  function cleanup() {
    if (stdin.isTTY) {
      stdin.setRawMode(false);
    }
    // Show cursor
    process.stdout.write('\x1b[?25h');
  }

  function refresh() {
    const projects = roots.map(r => collectProject(r));
    // Clear screen + move cursor to top
    process.stdout.write('\x1b[2J\x1b[H');
    // Hide cursor for clean display
    process.stdout.write('\x1b[?25l');
    process.stdout.write(render(projects, selectedIdx, intervalSec));
  }

  // Handle exit gracefully
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });

  // Initial render
  refresh();

  // Refresh loop
  while (running) {
    await new Promise(r => setTimeout(r, intervalSec * 1000));
    if (running) refresh();
  }

  cleanup();
}
