
import type { HandlerContext } from './context.js';
import { collectContext, PHASE_TO_EVENT, assertCwdInWorktree, getCurrentSessionId, getStorySessionOwner } from './context.js';
import { createStoryActor, getStateName, getGuardFailureReason, getPhaseInvariantStatus } from '../core/machine.js';
import type { PhaseInvariantIssue, StoryInfo, StoryPhase } from '../core/types.js';
import type { StoryStore } from '../core/store.js';
import { loadConfig } from '../core/config.js';
import { runHooks, buildHookEnv } from '../core/hooks.js';
import { renderSummaryForHint } from './summary.js';
import { createStoryQueryHandlers } from './story-query.js';
import { reviewAntiStall, testAntiStall } from '../core/anti-stall.js';
import { buildRollbackDecision, formatPhaseGateDecision } from '../core/phase-protocol.js';
import { getArtifactContractStatus } from '../core/artifact-contract.js';
import { getReviewerStatus } from '../core/reviewer-status.js';
import { getLegacyActivityLogPath, getRuntimeActivityLogPath } from '../core/activity-log.js';
import { execSync } from 'child_process';
import { dirname, join, relative } from 'path';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'fs';

const SESSION_OWNERSHIP_GATED_PHASES = new Set<StoryPhase>(['TEST', 'DONE']);

function formatSessionOwnerNotice(storyId: string, owner: { sessionId?: string; user?: string; agent?: string; timestamp: string }, currentSession?: string): string {
  const who = owner.user || owner.agent || 'unknown';
  const ownerSession = owner.sessionId || 'unknown';
  const current = currentSession || 'unknown';
  return `Story ${storyId} 当前由 ${who} 于 ${owner.timestamp} 持有（session: ${ownerSession}）。当前 session: ${current}`;
}

/**
 * DONE Final Checklist：把 DONE 阶段所有验证项收成一份显式清单。
 * 无论 advance 成功失败都打印，强制主 agent 读一遍多层验证状态。
 * 对应 OMX ralph 的 <Final_Checklist>。
 */
type DoneCheckRow = {
  status: 'pass' | 'fail' | 'warn';
  label: string;
  detail?: string;
  hint?: string;       // fail 时的修复建议；warn 时作为多行明细
};

type DoneAutoGitPlan = {
  branch: string;
  storyId: string;
  storyDirRel: string;
  storyRootRel: string;
  mainRepoRoot: string;
  wtPathAbs: string;
  commitMessage: string;
  mergeMessage: string;
};

type DoneDirtyEntry = {
  code: string;
  path: string;
};

type DoneMainMergePreflight = {
  dirtyEntries: DoneDirtyEntry[];
  dirtyPaths: string[];
  branchPaths: string[];
  blockingPaths: string[];
  autoBackupPaths: string[];
  autoBackupDir: string | null;
};

type DoneAutoGitLock = {
  path: string;
  release: () => void;
};

function detectDoneAutoGitPlan(storyId: string, storyTitle: string): DoneAutoGitPlan | null {
  const cwdInWorktree = process.cwd();
  let detectedBranch = '';
  let mainRepoRoot = '';
  let wtPathAbs = '';
  try {
    detectedBranch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: cwdInWorktree,
      encoding: 'utf-8',
    }).trim();
    const commonDirRaw = execSync('git rev-parse --path-format=absolute --git-common-dir', {
      cwd: cwdInWorktree,
      encoding: 'utf-8',
    }).trim();
    mainRepoRoot = dirname(commonDirRaw);
    if (cwdInWorktree !== mainRepoRoot && detectedBranch.startsWith('story/')) {
      wtPathAbs = cwdInWorktree;
    }
  } catch { /* PROBE: refs may be absent in synthetic git repos */
    return null;
  }

  if (!detectedBranch || !mainRepoRoot || !wtPathAbs || !detectedBranch.startsWith('story/')) {
    return null;
  }

  return {
    branch: detectedBranch,
    storyId,
    storyDirRel: loadConfig(cwdInWorktree).storyDir.replace(/\\/g, '/'),
    storyRootRel: loadConfig(cwdInWorktree).storyDir.replace(/\\/g, '/').replace(/\/actives\/?$/, ''),
    mainRepoRoot,
    wtPathAbs,
    commitMessage: `koala: mark ${storyId} DONE + clear worktree`,
    mergeMessage: `merge: ${storyId} ${storyTitle}`,
  };
}

function renderDoneAutoGitPlan(plan: DoneAutoGitPlan, dryRun = false): string {
  const prefix = dryRun ? '[DRY-RUN] ' : '';
  return [
    `${prefix}DONE auto-git plan:`,
    `  - repo: ${plan.mainRepoRoot}`,
    `  - worktree: ${plan.wtPathAbs}`,
    `  - branch: ${plan.branch}`,
    '  - acquire DONE auto-git lock (serializes main/index/worktree cleanup)',
    `  - git add ${plan.storyRootRel}`,
    `  - git commit -m "${plan.commitMessage}"`,
    `  - git merge ${plan.branch} --no-ff -m "${plan.mergeMessage}"`,
    `  - git worktree remove "${plan.wtPathAbs}" (dirty 时会 fallback --force)`,
    `  - git branch -d ${plan.branch}`,
  ].join('\n');
}

function shouldAutoSyncMainForDone(rows: DoneCheckRow[], rendered: string): boolean {
  if (!rendered.includes('[✗] Branch synced with main')) return false;
  const otherHardFailures = [
    '[✗] Test evidence',
    '[✗] Bugs fixed',
    '[✗] git working tree',
    '[✗] Story summary',
    '[✗] Reviewer contract',
    '[✗] Artifact contract',
  ];
  return !otherHardFailures.some(marker => rendered.includes(marker));
}

function hasRawConfirmIntent(): boolean {
  return process.argv.slice(2).some(arg => arg.includes('"confirm":true') || arg.includes('"confirm": true') || arg === '--confirm');
}

function acquireDoneAutoGitLock(plan: DoneAutoGitPlan, storyId: string): DoneAutoGitLock {
  const lockDir = join(plan.mainRepoRoot, '.git', 'koala');
  const lockPath = join(lockDir, 'done-auto-git.lock');
  mkdirSync(lockDir, { recursive: true });
  try {
    const fd = openSync(lockPath, 'wx');
    try {
      writeFileSync(fd, JSON.stringify({
        storyId,
        branch: plan.branch,
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      }) + '\n', 'utf-8');
    } finally {
      closeSync(fd);
    }
    return {
      path: lockPath,
      release: () => {
        try {
          unlinkSync(lockPath);
        } catch (e: any) {
          if (e?.code !== 'ENOENT') throw e;
        }
      },
    };
  } catch (e: any) {
    if (e?.code !== 'EEXIST') {
      throw new Error(`Cannot enter DONE: 无法获取 DONE auto-git 锁 ${lockPath}: ${e.message || String(e)}`);
    }
    let holder = 'unknown';
    try {
      holder = readFileSync(lockPath, 'utf-8').trim() || 'unknown';
    } catch { /* PROBE: lock holder unreadable */ }
    let age = 'unknown';
    try {
      age = `${Math.round((Date.now() - statSync(lockPath).mtimeMs) / 1000)}s`;
    } catch { /* PROBE: lock stat unavailable */ }
    throw new Error(
      `Cannot enter DONE: another DONE auto-git operation is already running.\n` +
      `lock: ${lockPath}\n` +
      `age: ${age}\n` +
      `holder: ${holder}\n\n` +
      `不要并行执行多个 DONE confirm。请等当前 merge/worktree cleanup 完成后，再重新运行本 story 的 DONE dry-run/confirm。`
    );
  }
}

function parseGitPorcelainEntries(raw: string): DoneDirtyEntry[] {
  return raw.split('\n')
    .map(line => line.trimEnd())
    .filter(Boolean)
    .map(line => {
      const rawPath = line.slice(3).trim();
      const renameMarker = ' -> ';
      const path = rawPath.includes(renameMarker)
        ? rawPath.slice(rawPath.indexOf(renameMarker) + renameMarker.length)
        : rawPath;
      return {
        code: line.slice(0, 2),
        path: path.replace(/^"|"$/g, '').replace(/\\/g, '/'),
      };
    })
    .filter(entry => Boolean(entry.path));
}

function parseGitPorcelainPaths(raw: string): string[] {
  return parseGitPorcelainEntries(raw).map(entry => entry.path);
}

function pathOverlaps(a: string, b: string): boolean {
  const left = a.replace(/\/+$/, '');
  const right = b.replace(/\/+$/, '');
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/**
 * @task B-ae82
 * @checklist CHK-003
 * @title ignore activity log in DONE cleanliness checks
 * @type bugfix
 * @priority high
 * @description
 *   DONE dry-run/confirm may run near CLI activity logging. The activity log
 *   is Koala-generated runtime state and must not make DONE block itself, but
 *   real story/code changes still need to fail the gate.
 * @changes
 *   - [CHK-003] Exclude docs/story/activity.jsonl from DONE worktree cleanliness checks
 *   - [CHK-003] Exclude the same path from main merge preflight overlap checks
 *   - [B-b611/CHK-002] Treat .koala/activity.jsonl the same as the legacy activity log
 */
export const DONE_RUNTIME_ACTIVITY_PATHS = ['.koala/activity.jsonl', 'docs/story/activity.jsonl'] as const;

export function isDoneVolatilePath(path: string): boolean {
  const rel = normalizeRel(path);
  return DONE_RUNTIME_ACTIVITY_PATHS.some(activityPath => rel === activityPath);
}

/**
 * @task B-b611
 * @checklist CHK-001
 * @title remove runtime activity from DONE semantic merge payload
 * @type bugfix
 * @priority high
 * @description
 *   Activity logs are append-only runtime telemetry. If both main and a story
 *   branch append .koala/activity.jsonl, a normal DONE merge can conflict even
 *   though no user-facing story artifact disagrees. Before committing the
 *   final story metadata, align tracked activity logs to main or remove them
 *   from the story index so the later merge only carries semantic payload.
 * @changes
 *   - [CHK-001] Reset runtime and legacy activity logs to main before DONE merge
 *   - [CHK-001] Remove story-only tracked activity logs from the index
 */
export function prepareDoneRuntimeActivityForMerge(cwd: string, mainRef = 'main'): string[] {
  const prepared: string[] = [];
  const git = (cmd: string): string =>
    execSync(`git ${cmd}`, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();

  for (const activityPath of DONE_RUNTIME_ACTIVITY_PATHS) {
    const quotedPath = JSON.stringify(activityPath);
    try {
      git(`cat-file -e ${JSON.stringify(`${mainRef}:${activityPath}`)}`);
      git(`checkout ${JSON.stringify(mainRef)} -- ${quotedPath}`);
      prepared.push(activityPath);
      continue;
    } catch { /* PROBE: main may not track this runtime log */ }

    try {
      const tracked = git(`ls-files -- ${quotedPath}`);
      if (!tracked) continue;
      git(`rm --cached --ignore-unmatch ${quotedPath}`);
      prepared.push(activityPath);
    } catch { /* PROBE: missing/untracked activity logs require no cleanup */ }
  }

  return prepared;
}

export function inspectDoneMainMergePreflight(plan: DoneAutoGitPlan): DoneMainMergePreflight {
  const runGit = (cmd: string): string =>
    execSync(`git ${cmd}`, { cwd: plan.mainRepoRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
  let dirtyEntries: DoneDirtyEntry[] = [];
  let branchPaths: string[] = [];
  try {
    dirtyEntries = parseGitPorcelainEntries(runGit('status --porcelain -uall'))
      .filter(entry => !isDoneVolatilePath(entry.path));
  } catch { /* PROBE: if status cannot be read, leave empty and let merge surface the real error */ }
  try {
    branchPaths = runGit(`diff --name-only HEAD...${plan.branch}`)
      .split('\n')
      .map(line => line.trim().replace(/\\/g, '/'))
      .filter(Boolean);
  } catch { /* PROBE: branch diff unavailable, merge will surface the real error */ }
  const dirtyPaths = dirtyEntries.map(entry => entry.path);
  const overlapEntries = dirtyEntries.filter(dirty => branchPaths.some(changed => pathOverlaps(dirty.path, changed)));
  const storyDir = `${plan.storyDirRel}/${plan.storyId}`;
  const storyPrefix = `${storyDir}/`;
  const storyResidueEntries = overlapEntries.filter(entry => entry.path === storyDir || entry.path.startsWith(storyPrefix));
  const canAutoBackupResidue = storyResidueEntries.length > 0
    && storyResidueEntries.length === overlapEntries.length
    && storyResidueEntries.every(entry => entry.code === '??');
  const autoBackupPaths = canAutoBackupResidue ? storyResidueEntries.map(entry => entry.path) : [];
  const blockingPaths = overlapEntries
    .filter(entry => !autoBackupPaths.includes(entry.path))
    .map(entry => entry.path);
  return {
    dirtyEntries,
    dirtyPaths,
    branchPaths,
    blockingPaths,
    autoBackupPaths,
    autoBackupDir: autoBackupPaths.length > 0 ? storyDir : null,
  };
}

function renderDoneMainMergePreflight(preflight: DoneMainMergePreflight): string {
  if (preflight.blockingPaths.length === 0) {
    if (preflight.dirtyPaths.length === 0 && preflight.autoBackupPaths.length === 0) {
      return '  - main working tree: clean';
    }
    const lines = [`  - main working tree: ${preflight.dirtyPaths.length} dirty/untracked path(s), none block this story branch`];
    if (preflight.autoBackupDir) {
      lines.push(`  - auto-backup same-story residue: ${preflight.autoBackupDir}`);
    }
    return lines.join('\n');
  }
  const lines = [
    `  - main working tree merge risk: ${preflight.blockingPaths.length} dirty/untracked path(s) overlap this story branch`,
    ...preflight.blockingPaths.slice(0, 12).map(path => `    • ${path}`),
  ];
  if (preflight.blockingPaths.length > 12) {
    lines.push(`    • ... ${preflight.blockingPaths.length - 12} more`);
  }
  lines.push('  → 请先让用户确认这些 main 工作区文件要 commit / stash / 移走，再重新执行 DONE confirm');
  return lines.join('\n');
}

export function backupDoneMainResidue(plan: DoneAutoGitPlan, preflight: DoneMainMergePreflight): string | null {
  if (!preflight.autoBackupDir) return null;
  const source = join(plan.mainRepoRoot, preflight.autoBackupDir);
  if (!existsSync(source)) return null;
  const backupBase = '/tmp/koala-main-residue-backup';
  mkdirSync(backupBase, { recursive: true });
  const target = join(backupBase, `${plan.storyId}-main-${Date.now()}`);
  renameSync(source, target);
  return target;
}

function readGitHead(cwd: string, ref = 'HEAD'): string | null {
  try {
    const value = execSync(`git rev-parse ${JSON.stringify(ref)}`, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return value || null;
  } catch {
    return null;
  }
}

function shortCommit(value: string | null | undefined): string {
  return value ? value.slice(0, 12) : 'unknown';
}

function normalizeRel(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '');
}

/**
 * @task B-7a33
 * @checklist CHK-001, CHK-002, CHK-003
 * @title classify evidence freshness metadata-only paths
 * @type bugfix
 * @priority high
 * @description
 *   Test evidence freshness should fail only when code/business inputs change
 *   after evidence was captured. Runtime activity telemetry and current-story
 *   metadata commits are non-code changes and should not force an infinite
 *   test_story/commit/DONE loop.
 * @changes
 *   - [CHK-001] Treat .koala/activity.jsonl and legacy docs/story/activity.jsonl as runtime-only
 *   - [CHK-002] Keep current story metadata as metadata-only
 *   - [CHK-003] Preserve stale behavior for real source/business file changes
 */
export function isEvidenceMetadataOnlyPath(root: string, storyId: string, path: string): boolean {
  const rel = normalizeRel(path);
  const configuredStoryDir = normalizeRel(loadConfig(root).storyDir);
  const storyMetaPrefixes = Array.from(new Set([
    `${configuredStoryDir}/${storyId}/`,
    `.koala/story/actives/${storyId}/`,
    `docs/story/actives/${storyId}/`,
  ]));
  const runtimeActivity = normalizeRel(relative(root, getRuntimeActivityLogPath(root)));
  const legacyActivity = normalizeRel(relative(root, getLegacyActivityLogPath(root)));
  return storyMetaPrefixes.some(prefix => rel === prefix.slice(0, -1) || rel.startsWith(prefix))
    || rel === runtimeActivity
    || rel === legacyActivity;
}

export function getEvidenceFreshness(root: string, storyId: string, evidenceHead: string, currentHead: string): { fresh: boolean; metadataOnly: boolean; changedPaths: string[] } {
  if (evidenceHead === currentHead) {
    return { fresh: true, metadataOnly: false, changedPaths: [] };
  }
  try {
    const raw = execSync(`git diff --name-only ${JSON.stringify(evidenceHead)}..${JSON.stringify(currentHead)}`, {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const changedPaths = raw.split('\n').map(line => line.trim()).filter(Boolean);
    if (changedPaths.length === 0) {
      return { fresh: true, metadataOnly: true, changedPaths };
    }
    const metadataOnly = changedPaths.length > 0 && changedPaths.every(path => isEvidenceMetadataOnlyPath(root, storyId, path));
    return { fresh: metadataOnly, metadataOnly, changedPaths };
  } catch { /* PROBE: diff can fail if evidence commit is unavailable */
    return { fresh: false, metadataOnly: false, changedPaths: [] };
  }
}

function assertDoneMainMergeSafe(plan: DoneAutoGitPlan, preflight: DoneMainMergePreflight): void {
  if (preflight.blockingPaths.length === 0) return;
  throw new Error(
    `Cannot enter DONE: main 工作区有会被 story merge 覆盖的 dirty/untracked 文件。\n` +
    `${renderDoneMainMergePreflight(preflight)}\n\n` +
    `Koala 没有自动 stash/修改这些文件，因为它们属于主目录用户改动。\n` +
    `处理后重试: koala story_advance '{"storyId":"${plan.branch.slice('story/'.length)}","phase":"DONE","confirm":true}'`
  );
}

function buildDoneChecklist(storyId: string, store: StoryStore, root: string): DoneCheckRow[] {
  const rows: DoneCheckRow[] = [];

  // 1. test evidence
  const evidence = store.readTestEvidence(storyId);
  if (!evidence) {
    rows.push({
      status: 'fail',
      label: 'Test evidence',
      detail: '没有测试证据',
      hint: `koala test_story '{"storyId":"${storyId}"}'`,
    });
  } else if (evidence.result !== 'PASS') {
    rows.push({
      status: 'fail',
      label: 'Test evidence',
      detail: `${evidence.result}: ${evidence.output.slice(0, 120)}`,
      hint: '修复失败的 case 后重跑 test_story',
    });
  } else {
    let allPassedOk = true;
    try {
      const parsed = JSON.parse(evidence.output);
      if (parsed.allPassed !== true) {
        allPassedOk = false;
        rows.push({
          status: 'fail',
          label: 'Test evidence',
          detail: `allPassed=${parsed.allPassed}`,
          hint: '修复失败的 case 后重跑 test_story',
        });
      }
    } catch { /* output 不是 JSON 也算 PASS（兼容旧格式）*/ }
    if (allPassedOk) {
      const evidenceHead = evidence.git?.head || null;
      let currentHead = readGitHead(root);
      let currentRef = 'HEAD';
      try {
        const story = store.readStory(storyId);
        if (story.worktree?.branch) {
          currentRef = story.worktree.branch;
          currentHead = readGitHead(root, story.worktree.branch);
        }
      } catch { /* PROBE: story metadata may already have been checked by phase guard */ }

      if (!evidenceHead) {
        rows.push({
          status: 'fail',
          label: 'Test evidence',
          detail: 'PASS evidence 缺少 git HEAD，无法证明覆盖当前代码',
          hint: `重跑 koala test_story '{"storyId":"${storyId}"}' 刷新 evidence 后再推进 DONE`,
        });
      } else if (!currentHead) {
        rows.push({
          status: 'fail',
          label: 'Test evidence',
          detail: `无法读取当前 ${currentRef} 的 git HEAD`,
          hint: '确认当前目录是 story worktree 且 git 状态正常，然后重跑 test_story',
        });
      } else {
        const freshness = getEvidenceFreshness(root, storyId, evidenceHead, currentHead);
        if (!freshness.fresh) {
          rows.push({
            status: 'fail',
            label: 'Test evidence',
            detail: `stale: evidence=${shortCommit(evidenceHead)} current=${shortCommit(currentHead)}`,
            hint: `当前代码已变化（例如 merge main 或新 commit）。请先重跑 koala test_story '{"storyId":"${storyId}"}'，再执行 DONE dry-run/confirm`,
          });
        } else {
          rows.push({
            status: 'pass',
            label: 'Test evidence',
            detail: freshness.metadataOnly
              ? `PASS @ ${evidence.timestamp} (${shortCommit(evidenceHead)}; current ${shortCommit(currentHead)} metadata-only)`
              : `PASS @ ${evidence.timestamp} (${shortCommit(evidenceHead)})`,
          });
        }
      }
    }
  }

  // 2. all bugs fixed
  const bugData = store.readBugs(storyId);
  const total = bugData.bugs.length;
  const openBugs = bugData.bugs.filter(b => b.status === 'open');
  if (openBugs.length > 0) {
    rows.push({
      status: 'fail',
      label: 'Bugs fixed',
      detail: `${openBugs.length} open / ${total} total: ${openBugs.map(b => b.id).join(', ')}`,
      hint: '修复所有 open bug 后重跑 test_auto，case pass 会自动标 fixed',
    });
  } else {
    rows.push({
      status: 'pass',
      label: 'Bugs fixed',
      detail: total > 0 ? `${total}/${total}` : 'no bugs',
    });
  }

  // 3. git working tree clean
  try {
    const dirty = execSync('git status --porcelain -uall', { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
      .split('\n')
      .map(line => line.trimEnd())
      .filter(Boolean)
      .map(line => line.slice(3).trim().replace(/^"|"$/g, '').replace(/\\/g, '/'))
      .filter(path => !isDoneVolatilePath(path));
    if (dirty.length > 0) throw new Error(dirty.join('\n'));
    rows.push({ status: 'pass', label: 'git working tree', detail: 'clean' });
  } catch (e: any) {
    rows.push({
      status: 'fail',
      label: 'git working tree',
      detail: e?.message ? `有未提交的改动: ${e.message.split('\n').slice(0, 3).join(', ')}` : '有未提交的改动',
      hint: '如需本地 git add + git commit，未经用户 confirm 不允许；确认后先提交所有改动，再 advance DONE',
    });
  }

  // 4. branch synced with main
  try {
    const story = store.readStory(storyId);
    if (story.worktree?.branch) {
      const branch = story.worktree.branch;
      try {
        execSync(`git merge-base --is-ancestor main ${branch}`, { cwd: root, stdio: 'pipe' });
        rows.push({ status: 'pass', label: 'Branch synced with main', detail: branch });
      } catch {
        if (hasRawConfirmIntent()) {
          const storyDirRel = loadConfig(root).storyDir.replace(/\\/g, '/');
          const storyMetaPrefix = `${storyDirRel}/${storyId}/`;
          try {
            execSync(`git -c commit.gpgsign=false merge main --no-ff -m ${JSON.stringify(`sync main into ${storyId}`)}`, {
              cwd: root,
              encoding: 'utf-8',
              stdio: ['pipe', 'pipe', 'pipe'],
            });
            rows.push({ status: 'pass', label: 'Branch synced with main', detail: `${branch} (auto-synced)` });
            return rows;
          } catch {
            const raw = execSync('git diff --name-only --diff-filter=U', { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
            const unmerged = raw.split('\n').map(line => line.trim().replace(/\\/g, '/')).filter(Boolean);
            const protectedConflicts = unmerged.filter(path => path.startsWith(storyMetaPrefix));
            const unresolved = unmerged.filter(path => !path.startsWith(storyMetaPrefix));
            for (const path of protectedConflicts) {
              execSync(`git checkout --ours -- ${JSON.stringify(path)}`, { cwd: root, stdio: 'pipe' });
              execSync(`git add -- ${JSON.stringify(path)}`, { cwd: root, stdio: 'pipe' });
            }
            if (unresolved.length === 0 && protectedConflicts.length > 0) {
              execSync(`git -c commit.gpgsign=false commit -m ${JSON.stringify(`sync main into ${storyId} (story metadata ours)`)}`, {
                cwd: root,
                stdio: ['pipe', 'pipe', 'pipe'],
              });
              rows.push({ status: 'pass', label: 'Branch synced with main', detail: `${branch} (story metadata auto-resolved with --ours)` });
              return rows;
            }
            rows.push({
              status: 'fail',
              label: 'Branch synced with main',
              detail: `auto-sync main stopped: unresolved conflicts: ${unresolved.join(', ') || '(unknown)'}`,
              hint: `请手动解决真实冲突后 git add + git commit，再重跑 koala test_story '{"storyId":"${storyId}"}'`,
            });
            return rows;
          }
        }
        rows.push({
          status: 'fail',
          label: 'Branch synced with main',
          detail: `${branch} 未合并 main 的最新提交`,
          hint: `DONE confirm 会在这是唯一硬失败时自动执行安全 sync main；如需单独处理，先运行 koala story_sync_main '{"storyId":"${storyId}","dryRun":true}'，确认后运行 koala story_sync_main '{"storyId":"${storyId}","confirm":true}'，再重跑 koala test_story '{"storyId":"${storyId}"}'`,
        });
      }
    }
  } catch { /* 读 story 失败不阻塞，guard 已经报过错 */ }

  // 5. relatedDocs (advisory，warn 不影响判定)
  try {
    const cl = store.readChecklist(storyId);
    const allDocs = new Map<string, string[]>();
    for (const it of cl.items) {
      const docs = (it as any).relatedDocs as string[] | undefined;
      if (Array.isArray(docs)) {
        for (const d of docs) {
          if (!allDocs.has(d)) allDocs.set(d, []);
          allDocs.get(d)!.push(it.id);
        }
      }
    }
    if (allDocs.size > 0) {
      let changedFiles = new Set<string>();
      try {
        const out = execSync('git diff main...HEAD --name-only', { cwd: root, encoding: 'utf8', timeout: 5000 }).trim();
        if (out) changedFiles = new Set(out.split('\n'));
      } catch { /* ignore */ }
      const unchanged: Array<[string, string[]]> = [];
      for (const [doc, items] of allDocs.entries()) {
        if (!changedFiles.has(doc.split('#')[0])) unchanged.push([doc, items]);
      }
      if (unchanged.length > 0) {
        rows.push({
          status: 'warn',
          label: 'relatedDocs',
          detail: `${unchanged.length}/${allDocs.size} untouched (advisory)`,
          hint: unchanged.map(([d, items]) => `${d}  (${items.join(', ')})`).join('\n'),
        });
      } else {
        rows.push({
          status: 'pass',
          label: 'relatedDocs',
          detail: `${allDocs.size}/${allDocs.size} touched`,
        });
      }
    }
  } catch { /* ignore */ }

  // 6. summary.json (hard gate — 强制 story 完成总结，防止 LLM 声称"都测过了"不留凭证)
  const summary = store.readSummary(storyId);
  if (!summary) {
    rows.push({
      status: 'fail',
      label: 'Story summary',
      detail: '没有 summary.json',
      hint: `koala summary_set '{"storyId":"${storyId}","changes":"改了什么（≥10 字符）","usage":"怎么用（≥10 字符）","limitations":"已知限制或 \\"none — fully covered\\"","pitfalls":"踩坑记录（≥10 字符，强制段）"}'`,
    });
  } else {
    const missing: string[] = [];
    if (!summary.changes || summary.changes.trim().length < 10) missing.push('changes');
    if (!summary.usage || summary.usage.trim().length < 10) missing.push('usage');
    if (typeof summary.limitations !== 'string' || summary.limitations.trim().length < 2) missing.push('limitations');
    if (!summary.pitfalls || summary.pitfalls.trim().length < 10) missing.push('pitfalls');
    if (missing.length > 0) {
      rows.push({
        status: 'fail',
        label: 'Story summary',
        detail: `字段缺失/过短: ${missing.join(', ')}`,
        hint: `重新调 koala summary_set 补齐 ${missing.join(', ')}`,
      });
    } else {
      const cov = summary.realMachineCoverage &&
        Array.isArray(summary.realMachineCoverage.ran) &&
        Array.isArray(summary.realMachineCoverage.skipped)
        ? summary.realMachineCoverage
        : { ran: [], skipped: [] };
      const covNote = summary.realMachineCoverage
        ? `${cov.ran.length} ran / ${cov.skipped.length} skipped`
        : 'legacy summary / no realMachineCoverage';
      rows.push({
        status: 'pass',
        label: 'Story summary',
        detail: `complete (${covNote})`,
      });
    }
  }

  const reviewerStatus = getReviewerStatus(storyId, store, 'DONE', root);
  const reviewerBlockers = reviewerStatus.entries.filter((entry) => entry.blocking && entry.verdict !== 'pass');
  if (reviewerBlockers.length > 0) {
    rows.push({
      status: 'fail',
      label: 'Reviewer contract',
      detail: `${reviewerBlockers.length} blocking reviewer artifact(s) not ready`,
      hint: reviewerBlockers.map((entry) => `${entry.label}: ${entry.summary}`).join('\n'),
    });
  } else {
    rows.push({
      status: 'pass',
      label: 'Reviewer contract',
      detail: 'all blocking reviewer artifacts are ready',
    });
  }

  // 7. artifact contract (B-8162: surface required vs advisory evidence)
  const artifactContract = getArtifactContractStatus(storyId, store, 'DONE');
  const missingRequired = artifactContract.entries.filter((entry) => entry.required && !entry.present);
  const missingAdvisory = artifactContract.entries.filter((entry) => !entry.required && !entry.present);
  if (missingRequired.length > 0) {
    rows.push({
      status: 'fail',
      label: 'Artifact contract',
      detail: `${missingRequired.length} required artifact(s) missing`,
      hint: missingRequired.map((entry) => `${entry.label}: ${entry.detail}`).join('\n'),
    });
  } else if (missingAdvisory.length > 0) {
    rows.push({
      status: 'warn',
      label: 'Artifact contract',
      detail: `${missingAdvisory.length} advisory artifact(s) missing`,
      hint: missingAdvisory.map((entry) => `${entry.label}: ${entry.detail}`).join('\n'),
    });
  } else {
    rows.push({
      status: 'pass',
      label: 'Artifact contract',
      detail: 'all required artifacts present',
    });
  }

  return rows;
}

function renderDoneChecklist(storyId: string, rows: DoneCheckRow[]): string {
  const ICONS: Record<DoneCheckRow['status'], string> = { pass: '✓', fail: '✗', warn: '!' };
  const lines = [`DONE Gate Checklist (${storyId}):`];
  for (const row of rows) {
    let line = `  [${ICONS[row.status]}] ${row.label}`;
    if (row.detail) line += `: ${row.detail}`;
    lines.push(line);
    // warn 行的多行明细缩进展示
    if (row.status === 'warn' && row.hint) {
      for (const h of row.hint.split('\n')) {
        lines.push(`        - ${h}`);
      }
    }
  }
  return lines.join('\n');
}

export function createStoryAdvanceHandlers(ctx: HandlerContext) {
  const { store } = ctx;

  return {
    /**
     * @task B-1dc6
     * @checklist CHK-001
     * @title story_advance owns gate final decisions and phase transitions
     * @type feature
     * @priority high
     * @description
     *   stack-layering 指出的 gate 最终判定记录就在这里落地：story_advance 统一读取
     *   phase gate、reviewer contract、test evidence、bug 状态和 worktree/runtime，
     *   决定一个 story 是否允许继续推进到下一个 phase。
     * @changes
     *   - [CHK-001] 把 gate 最终判定记录回链到 story_advance
     *   - [CHK-001] 让长期 project state 的推进入口可被 gap coverage 正确识别
     * @test high-gap-annotation-backfill
     */
    async story_advance(args: {
      storyId: string;
      phase: StoryPhase;
      checklist?: Array<{ id: string; title: string }>;
      dryRun?: boolean;
      confirm?: boolean;
    }): Promise<string> {
      let story = store.readStory(args.storyId);
      const oldPhase: string = story.phase as string;

      // CWD 门禁：PLAN/DEV/TEST_* 阶段必须在 worktree 里执行
      // 注意：在 advance 前检查目标 phase 是否需要 worktree
      const CWD_GATED: StoryPhase[] = ['PLAN', 'DEV', 'TEST_CASE', 'TEST_CASE_REVIEW', 'TEST'];
      if (CWD_GATED.includes(args.phase) && story.worktree) {
        assertCwdInWorktree(store, args.storyId);
        story = store.readStory(args.storyId);
      }

      // 依赖完成度检查（soft warning，不阻塞）
      let depsWarning = '';
      if (story.depends && story.depends.length > 0) {
        const unfinished: string[] = [];
        for (const depId of story.depends) {
          try {
            const dep = store.readStory(depId);
            if (dep.phase !== 'DONE') {
              unfinished.push(`${depId}(${dep.phase})`);
            }
          } catch {
            unfinished.push(`${depId}(not found)`);
          }
        }
        if (unfinished.length > 0) {
          depsWarning = `\n⚠ 依赖未完成: ${unfinished.join(', ')}`;
        }
      }

      // Session 占用检查
      let sessionWarning = '';
      const currentSession = getCurrentSessionId();
      const ownerSession = getStorySessionOwner(story.events);
      const takeoverAllowed = process.env.KOALA_ALLOW_SESSION_TAKEOVER === '1';
      if (ownerSession && ownerSession.sessionId && currentSession && ownerSession.sessionId !== currentSession) {
        const ownerNotice = formatSessionOwnerNotice(args.storyId, ownerSession, currentSession);
        if (SESSION_OWNERSHIP_GATED_PHASES.has(args.phase) && !takeoverAllowed) {
          throw new Error(
            `${ownerNotice}\n` +
            `→ 当前不允许跨 session 直接推进到 ${args.phase}，请先在拥有该 story 的 session 中继续，或显式接管后重试\n` +
            `→ 接管命令: KOALA_ALLOW_SESSION_TAKEOVER=1 koala story_advance '{"storyId":"${args.storyId}","phase":"${args.phase}"}'`
          );
        }
        sessionWarning = `\n⚠ Warning: ${ownerNotice}`;
        console.error(sessionWarning.trim());
      } else if (ownerSession && ownerSession.sessionId && !currentSession && SESSION_OWNERSHIP_GATED_PHASES.has(args.phase)) {
        sessionWarning = `\n⚠ Warning: ${formatSessionOwnerNotice(args.storyId, ownerSession)}；当前进程没有可识别 sessionId，因此仅提示、不阻塞`;
        console.error(sessionWarning.trim());
      }

      // Git clean 门禁（窄化版）：进入 TEST_CASE / TEST_CASE_REVIEW / TEST 前
      // 只要求 fixturesDir 干净，因为 test runner 的 cleanupFixtureDir 只会
      // git restore + git clean 这一个目录。代码目录的未 commit 改动不会丢，
      // 不再阻塞，让 DEV 阶段可以连续改代码 + 跑测试不被强制 commit 打断。
      const GIT_CLEAN_PHASES: StoryPhase[] = ['TEST_CASE', 'TEST_CASE_REVIEW', 'TEST'];
      if (GIT_CLEAN_PHASES.includes(args.phase) && !(globalThis as any).__koalaTestAutoRunning) {
        try {
          const cfg = loadConfig(ctx.root);
          const fixturesRel = cfg.fixturesDir;
          const gitStatus = execSync(
            `git status --porcelain -- "${fixturesRel}"`,
            { cwd: ctx.root, encoding: 'utf8', timeout: 5000 }
          ).trim();
          if (gitStatus) {
            const fileCount = gitStatus.split('\n').length;
            throw new Error(
              `Cannot enter ${args.phase}: ${fixturesRel} 有未提交的改动（${fileCount} 个文件）。` +
              `test runner 跑完会 git restore + git clean 这个目录，未 commit 的 fixture 改动会丢失。\n` +
              `→ 如需本地 git add ${fixturesRel} + git commit，未经用户 confirm 不允许；确认后再推进阶段\n\n` +
              `git status:\n${gitStatus.split('\n').slice(0, 10).join('\n')}${fileCount > 10 ? '\n...' : ''}`
            );
          }
        } catch (e: any) {
          // git status 本身报错（如不是 git 仓库）不阻塞
          if (e.message?.includes('Cannot enter')) throw e;
        }
      }

      // IDEA→PLAN 需要 checklist
      if (args.phase === 'PLAN' && story.phase === 'IDEA') {
        if (!args.checklist || args.checklist.length === 0) {
          throw new Error('Cannot advance to PLAN: checklist is required');
        }
      }

      const actor = createStoryActor(args.storyId, store, story.phase);
      actor.start();
      let doneAutoGitPlan: DoneAutoGitPlan | null = null;
      let doneAutoGitLock: DoneAutoGitLock | null = null;
      let doneRollbackStory: StoryInfo | null = null;
      let doneAutoSyncReport = '';

      let eventType = PHASE_TO_EVENT[args.phase];
      if (!eventType) {
        throw new Error(`Invalid target phase: ${args.phase}`);
      }
      // 回退映射：目标阶段比当前阶段早时，选择对应的回退事件
      if (args.phase === 'PLAN' && story.phase === 'DEV') {
        eventType = 'REPLAN';
      } else if (args.phase === 'DEV' && story.phase === 'TEST_CASE_REVIEW') {
        eventType = 'ROLLBACK_DEV';
      } else if (args.phase === 'TEST_CASE' && (story.phase === 'TEST_CASE_REVIEW' || story.phase === 'TEST')) {
        eventType = 'ROLLBACK_TEST_CASE';
      }
      // TEST_CASE/TEST 已有 START→DEV 转换，PHASE_TO_EVENT['DEV']='START' 自动命中

      // TEST_CASE_REVIEW→TEST 门禁：检查 testIntent results（兜底，防止手动跳过 reviewer）
      if (args.phase === 'TEST' && story.phase === 'TEST_CASE_REVIEW') {
        const reviewerStatus = getReviewerStatus(args.storyId, store, 'TEST', ctx.root);
        const blockers = reviewerStatus.entries.filter((entry) => entry.blocking && entry.verdict !== 'pass');

        if (blockers.length > 0) {
          // 统一回退 DEV
          actor.send({ type: 'ROLLBACK_DEV' } as any);
          actor.stop();
          story.phase = 'DEV' as any;
          const rollbackCtxEvent = collectContext('DEV' as any, 'advance');
          rollbackCtxEvent.agent = 'gate-rollback';
          rollbackCtxEvent.reason = 'review_failed';
          if (!story.events) story.events = [];
          story.events.push(rollbackCtxEvent);
          store.writeStory(args.storyId, story);
          const issues: PhaseInvariantIssue[] = blockers.map((entry) => ({
            code: entry.key,
            detail: `${entry.label}: ${entry.detail}`,
          }));
          const decision = buildRollbackDecision({
            storyId: args.storyId,
            targetPhase: 'TEST',
            rollbackPhase: 'DEV',
            reasonCode: 'review_failed',
            issues,
          });
          return formatPhaseGateDecision(decision) + `\n\n→ Story ${args.storyId} rolled back to DEV`;
        }
      }

      const canSend = actor.getSnapshot().can({ type: eventType } as any);
      if (!canSend) {
        const decision = getPhaseInvariantStatus(args.storyId, store, args.phase);
        const currentState = getStateName(actor);
        actor.stop();
        throw new Error(
          formatPhaseGateDecision(decision) || getGuardFailureReason(args.storyId, store, args.phase) || `Cannot transition from ${currentState} to ${args.phase}`
        );
      }

      // DEV→TEST_CASE 门禁：checklist 全部 done + fixture fn 合法性检查
      if (args.phase === 'TEST_CASE') {
        const errors: string[] = [];
        const hints: string[] = [];
        const root = ctx.root;
        const config = loadConfig(root);


        if (errors.length > 0) {
          actor.stop();
          throw new Error(
            `Cannot enter TEST_CASE: ${errors.length} 项检查未通过:\n\n` +
            errors.map((e, i) => `[${i + 1}] ${e}`).join('\n\n') +
            '\n\n修复建议:\n' + hints.map(h => `→ ${h}`).join('\n')
          );
        }
      }

      // TEST→DONE 严格门禁：构建并渲染 DONE Final Checklist。
      // 无论 advance 成功失败都会输出这份 checklist，强制主 agent 读一遍多层验证状态。
      // 对应 OMX ralph 的 <Final_Checklist>。
      if (args.phase === 'DONE') {
        doneRollbackStory = JSON.parse(JSON.stringify(story)) as StoryInfo;
        const doneSyncStory = store.readStory(args.storyId);
        const doneSyncBranch = doneSyncStory.worktree?.branch || `story/${args.storyId}`;
        if (!args.dryRun && (args.confirm || hasRawConfirmIntent())) {
          try {
            execSync(`git merge-base --is-ancestor main ${JSON.stringify(doneSyncBranch)}`, { cwd: ctx.root, stdio: 'pipe' });
          } catch {
            try {
              doneAutoSyncReport = createStoryQueryHandlers(ctx).story_sync_main({ storyId: args.storyId, confirm: true });
            } catch (e: any) {
              actor.stop();
              throw new Error(`DONE auto-sync main failed:\n${e?.message || String(e)}`);
            }
          }
        }
        let checkRows = buildDoneChecklist(args.storyId, store, ctx.root);
        let rendered = renderDoneChecklist(args.storyId, checkRows);
        let failed = checkRows.filter(r => r.status === 'fail');
        const canAutoSyncMain = shouldAutoSyncMainForDone(checkRows, rendered);

        if (failed.length > 0) {
          if (canAutoSyncMain && args.dryRun) {
            actor.stop();
            let syncPreview = '';
            try {
              syncPreview = createStoryQueryHandlers(ctx).story_sync_main({ storyId: args.storyId, dryRun: true });
            } catch (e: any) {
              syncPreview = `story_sync_main dry-run unavailable: ${e?.message || String(e)}`;
            }
            const donePlan = detectDoneAutoGitPlan(args.storyId, story.title);
            const doneMainPreflight = donePlan ? inspectDoneMainMergePreflight(donePlan) : null;
            return (
              rendered + '\n\n' +
              '[DRY-RUN] DONE confirm will auto-sync main first:\n' +
              syncPreview + '\n\n' +
              (donePlan
                ? renderDoneAutoGitPlan(donePlan, true) + '\n' +
                  (doneMainPreflight ? renderDoneMainMergePreflight(doneMainPreflight) + '\n' : '')
                : '[DRY-RUN] 当前 DONE 路径不会自动执行 git commit/merge。\n') +
              `→ 这是 dry-run 预览。确认无误后，执行: koala story_advance '{"storyId":"${args.storyId}","phase":"DONE","confirm":true}'`
            );
          }

          if (canAutoSyncMain && !args.dryRun) {
            try {
              doneAutoSyncReport = createStoryQueryHandlers(ctx).story_sync_main({ storyId: args.storyId, confirm: true });
              checkRows = buildDoneChecklist(args.storyId, store, ctx.root);
              rendered = renderDoneChecklist(args.storyId, checkRows);
              failed = checkRows.filter(r => r.status === 'fail');
            } catch (e: any) {
              actor.stop();
              throw new Error(
                rendered + '\n\n' +
                `DONE auto-sync main failed:\n${e?.message || String(e)}`
              );
            }
          }
        }

        if (failed.length > 0) {
          actor.stop();
          const hints = failed.flatMap(r => r.hint ? [r.hint] : []);
          throw new Error(
            rendered + '\n\n' +
            `Cannot enter DONE: ${failed.length} 项检查未通过` +
            (hints.length > 0 ? '\n\n修复建议:\n' + hints.map(h => `→ ${h}`).join('\n') : '')
          );
        }

        doneAutoGitPlan = detectDoneAutoGitPlan(args.storyId, story.title);
        let doneMainPreflight = doneAutoGitPlan ? inspectDoneMainMergePreflight(doneAutoGitPlan) : null;
        if (args.dryRun) {
          actor.stop();
          if (doneAutoGitPlan) {
            return (
              rendered + '\n\n' +
              renderDoneAutoGitPlan(doneAutoGitPlan, true) + '\n' +
              (doneMainPreflight ? renderDoneMainMergePreflight(doneMainPreflight) + '\n' : '') +
              `→ 这是 dry-run 预览。确认无误后，执行: koala story_advance '{"storyId":"${args.storyId}","phase":"DONE","confirm":true}'`
            );
          }
          return (
            rendered + '\n\n' +
            '[DRY-RUN] 当前 DONE 路径不会自动执行 git commit/merge。\n' +
            '→ 门禁已通过；若确认要真实推进 DONE，去掉 --dryRun 后重新执行'
          );
        }
        if (doneAutoGitPlan && !args.confirm) {
          actor.stop();
          throw new Error(
            rendered + '\n\n' +
            '该 DONE 路径会自动执行 git commit/merge，默认已阻止。\n' +
            renderDoneAutoGitPlan(doneAutoGitPlan) + '\n' +
            (doneMainPreflight ? renderDoneMainMergePreflight(doneMainPreflight) + '\n' : '') +
            `→ 先执行: koala story_advance '{"storyId":"${args.storyId}","phase":"DONE","dryRun":true}'\n` +
            `→ 确认后执行: koala story_advance '{"storyId":"${args.storyId}","phase":"DONE","confirm":true}'`
          );
        }
        if (doneAutoGitPlan) {
          try {
            doneAutoGitLock = acquireDoneAutoGitLock(doneAutoGitPlan, args.storyId);
            doneMainPreflight = inspectDoneMainMergePreflight(doneAutoGitPlan);
          } catch (e) {
            actor.stop();
            throw e;
          }
        }
        if (doneAutoGitPlan && doneMainPreflight && doneMainPreflight.blockingPaths.length > 0) {
          if (doneAutoGitLock) {
            doneAutoGitLock.release();
            doneAutoGitLock = null;
          }
          actor.stop();
          assertDoneMainMergeSafe(doneAutoGitPlan, doneMainPreflight);
        }
        if (doneAutoGitPlan && doneMainPreflight && doneMainPreflight.autoBackupPaths.length > 0) {
          try {
            const backupPath = backupDoneMainResidue(doneAutoGitPlan, doneMainPreflight);
            if (backupPath) {
              (globalThis as any).__koalaDoneMainResidueBackup = backupPath;
            }
            doneMainPreflight = inspectDoneMainMergePreflight(doneAutoGitPlan);
            if (doneMainPreflight.blockingPaths.length > 0) {
              throw new Error(renderDoneMainMergePreflight(doneMainPreflight));
            }
          } catch (e) {
            if (doneAutoGitLock) {
              doneAutoGitLock.release();
              doneAutoGitLock = null;
            }
            actor.stop();
            throw e;
          }
        }

        // 全部硬检查通过，把渲染好的 checklist 暂存，最终拼到 advance 成功消息里
        (globalThis as any).__koalaDoneChecklistRendered = rendered;
      }

      try {
        actor.send({ type: eventType } as any);
      } catch (e) {
        if (doneAutoGitLock) {
          doneAutoGitLock.release();
          doneAutoGitLock = null;
        }
        throw e;
      }
      const newState = getStateName(actor);
      actor.stop();

      // IDEA→PLAN：写入 checklist
      if (args.phase === 'PLAN' && args.checklist && args.checklist.length > 0) {
        const checklist = {
          items: args.checklist.map(c => ({
            id: c.id,
            title: c.title,
            status: 'pending' as const,
            startTime: null,
            endTime: null,
          })),
        };
        store.writeChecklist(args.storyId, checklist);
      }

      // 持久化状态
      const now = new Date().toISOString();
      if (args.phase === 'PLAN' && !story.startedAt) {
        story.startedAt = now;
      }
      if (args.phase === 'DONE') {
        story.endedAt = now;
      }
      story.phase = newState as StoryPhase;
      if (!story.events) story.events = [];
      story.events.push(collectContext(args.phase, 'advance'));
      store.writeStory(args.storyId, story);

      // onPhaseChange hook — fires after the new phase is persisted, so the
      // hook can read the up-to-date story state. Failures are non-blocking.
      // Uses the shared buildHookEnv helper so KOALA_ARGS_JSON / KOALA_STORY_ID
      // / KOALA_PHASE stay consistent with the cli-engine code path.
      try {
        const cfg = loadConfig(ctx.root);
        const env = buildHookEnv({
          stage: 'onPhaseChange',
          command: 'story_advance',
          cwd: process.cwd(),
          root: ctx.root,
          argsJson: JSON.stringify(args),
          storyId: args.storyId,
          phase: newState,
          extra: {
            KOALA_OLD_PHASE: oldPhase,
            KOALA_NEW_PHASE: newState,
          },
        });
        await runHooks('onPhaseChange', `${oldPhase}->${newState}`, env, cfg, ctx.root);
      } catch { /* runHooks itself never throws, but defensive */ }

      // CHK-002: PLAN→DEV 时收集所有 relatedDocs 列出来作为开工提醒
      let docsHint = '';
      if (args.phase === 'DEV') {
        try {
          const cl = store.readChecklist(args.storyId);
          const docMap = new Map<string, string[]>(); // doc → [itemId]
          for (const it of cl.items) {
            const docs = (it as any).relatedDocs as string[] | undefined;
            if (Array.isArray(docs)) {
              for (const d of docs) {
                if (!docMap.has(d)) docMap.set(d, []);
                docMap.get(d)!.push(it.id);
              }
            }
          }
          if (docMap.size > 0) {
            const lines: string[] = [];
            for (const [d, items] of docMap.entries()) {
              lines.push(`  - ${d}  (${items.join(', ')})`);
            }
            docsHint = `\n\n📄 本 story 关联文档（改代码时注意同步）:\n${lines.join('\n')}`;
          }
        } catch { /* ignore */ }
      }

      const nextSteps: Record<string, string> = {
        PLAN: `→ 建议立即切到 Claude Code plan 模式（shift-tab 两次到 plan mode）——PLAN 阶段只拆 checklist / 写 understanding_set / decision_set，不应改代码。Edit/Write 被 plan mode 禁掉能防误触。
→ 下一步: checklist_get(${args.storyId}) 查看待开发项，然后 story_advance(${args.storyId}, DEV) 开始开发
⚠ 用户价值验收（强制）: understanding_set 的 outcome 字段必须写成一段具体的 user-facing transcript ——用户跑完这个 story 后会在终端/UI 看到的精确文字，不是 "事件 X 通了" 这种抽象描述。判定方法: outcome 读起来必须能让人想象出"用户什么时候说'好了搞定'"的那一刻。详见 CLAUDE.md「用户价值验收」段。`,
        DEV: `→ 如果之前在 plan 模式，现在 shift-tab 退出 plan 模式（DEV 需要 Edit/Write 权限）。
→ 下一步: 写代码实现（此阶段可改代码，不写测试）。完成后 story_advance(${args.storyId}, TEST_CASE)
⚠ 真机测试时（不管在 DEV 还是 TEST 阶段）切换视角: 不要只盯事件日志和 [✓ exit=0]——那是工程师视角。用 PLAN 阶段写的 outcome transcript 当 expected，把实际终端输出当 actual，**对着 diff**。最后一行让用户说"完成"还是"然后呢"决定 story 是否真的做完。`,
        TEST_CASE: `→ 下一步: 根据 testIntent 编写 fixture case（只改 fixture，不改代码）。完成后 story_advance(${args.storyId}, TEST_CASE_REVIEW)。如需改代码请先 story_advance(${args.storyId}, DEV) 回退`,
        TEST_CASE_REVIEW: `→ 下一步: 启动 test-case-reviewer agent 审核（不改代码也不改 case）。未通过时主 agent 调 story_advance(${args.storyId}, DEV) 回退改代码，或 story_advance(${args.storyId}, TEST_CASE) 回退改 case
⚠ implementation-reviewer（phase-aware，第一版 advisory）: 在进入 TEST 前，至少做一次实现层自检：实现代码是否存在明显回归、边界条件遗漏、错误处理缺口或维护性风险。如有需要，调用 implementation-reviewer agent 做独立复核；若已经有 implementation review 结果，以统一 reviewer status / artifact contract 为准决定是否仍有阻塞。
${reviewAntiStall(args.storyId)}`,
        TEST: `→ 必须立即执行: test_story('${args.storyId}') 跑当前 story 关联 case，写 bug/evidence。fail 自动 aux_diagnose + bug_report，pass 自动标 bug fixed。需要刷新架构 trace 时再 test_auto({trace:true})
→ 如果准备推进 DONE，先执行 story_advance('${args.storyId}', 'DONE', dryRun=true) 预览；确认后再带 confirm=true 真实执行
${testAntiStall(args.storyId)}
⚠ 工程验证 ≠ 用户验收: 即使 test_story 全 pass，也必须用用户视角真机跑一次（节奏: 把 PLAN outcome 当 expected → 跑 → 把实际输出当 actual → diff）。验证完把 actual transcript + 差异说明放到 ${loadConfig(ctx.root).storyDir}/${args.storyId}/evidence/transcript-diff.md。CLAUDE.md「用户价值验收」段有完整 5 题自检清单。`,
        DONE: `→ 必须立即执行: 把下面的 Story 总结段落用你自己的话告诉用户（改了什么/怎么用/真机覆盖/限制/踩坑），然后 convergence_check 检查项目收敛状态
⚠ product-reviewer（第一版 advisory）: 在宣布“真的完成”前，至少做一次用户价值视角自检：outcome transcript 是否具体、最终输出最后一行会不会让用户想问“然后呢？”。如有需要，调用 product-reviewer agent 做独立复核。
⚠ DONE 自检 5 题（CLAUDE.md「用户价值验收」段）: (1) PLAN outcome 是具体 transcript 还是抽象? (2) 真机测试时读了用户视角输出还是只看事件日志? (3) 用户看到 actual transcript 最后一行会说"完成"还是"然后呢"? (4) 有没有工程 log 在用户眼里是噪音/重复? (5) 有没有一句人话总结任务结果? 任何一题答"没做到"就回 DEV，不要硬推 DONE。`,
      };
      let doneChecklistPrefix = '';
      let doneSummarySuffix = '';
      let doneMergeReport = '';
      if (args.phase === 'DONE') {
        const rendered = (globalThis as any).__koalaDoneChecklistRendered;
        if (rendered) {
          doneChecklistPrefix = `${rendered}\n\n`;
          delete (globalThis as any).__koalaDoneChecklistRendered;
        }
        // DONE 成功后把 summary 内容拼到返回里，agent 看到后转述给用户
        try {
          const summary = store.readSummary(args.storyId);
          if (summary) {
            doneSummarySuffix = `\n\n${renderSummaryForHint(summary)}`;
          }
        } catch { /* ignore */ }

        // B-7eed: DONE 成功后自动 git merge 回 main + 清 worktree + 删 branch。
        // CLAUDE.md 承诺"内部自动合并"但旧代码没实现，每次 DONE 都要手动 cleanup。
        // 复用 dev_merge 的逻辑（worktree.ts:208）但从 story-advance 触发。
        //
        // 关键的执行顺序（不能乱）：
        //   1. 清 story.worktree 字段 + writeStory（在 worktree fs 内）
        //   2. git add + git commit 把这一步以及之前的 phase=DONE 改动都落到 story 分支
        //   3. cd 到主仓库根目录，git merge story 分支（worktree 内不能 merge 自己）
        //   4. worktree remove
        //   5. branch -d
        // 注意：不能依赖 story.worktree 字段——INIT_CHECK 把这个字段写到了 main
        // 仓库的 index.json，但 worktree 内 checkout 的版本是 INIT_CHECK 之前的，
        // 没有这个字段。所以 readStory(from worktree) 永远拿到 worktree=undefined。
        // 改为从 git 实际状态推断：cwd（worktree 路径）+ 当前分支 + git common dir。
        if (doneAutoGitPlan) {
          const mergeLines: string[] = [];
          const { branch, mainRepoRoot, wtPathAbs } = doneAutoGitPlan;
          {
            const runGit = (cmd: string, cwd: string): string =>
              execSync(`git ${cmd}`, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();

            // Step 1: 清 story.worktree 字段 + endedAt + writeStory，让 metadata 落盘
            story.worktree = undefined;
            story.endedAt = story.endedAt || new Date().toISOString();
            store.writeStory(args.storyId, story);
            const mainBranch = runGit('rev-parse --abbrev-ref HEAD', mainRepoRoot);

            // Step 2: commit 所有 story metadata（phase=DONE + worktree=undefined +
            // endedAt + reviewer/test 产物）。dev_merge:228 用的是同一招。
            try {
              // Keep activity.jsonl out of story branch semantic merges. It is
              // append-only runtime telemetry and frequently conflicts with
              // main, while story metadata is the canonical payload here.
              prepareDoneRuntimeActivityForMerge(wtPathAbs, mainBranch);
              runGit(`add ${doneAutoGitPlan.storyRootRel}`, wtPathAbs);
              const staged = runGit('diff --cached --name-only', wtPathAbs);
              if (staged) {
                runGit(
                  `-c commit.gpgsign=false commit -m ${JSON.stringify(doneAutoGitPlan.commitMessage)}`,
                  wtPathAbs,
                );
              }
            } catch { /* PROBE: 没东西 commit 也无所谓 */ }

            // Step 3: 从主仓库根目录 merge story 分支。merge 冲突直接 throw 给上层
            // 让 agent 看到详细的手动 cleanup 步骤——phase 已经是 DONE，不回滚，但
            // 必须让 user 知道还有手动收尾要做。
            try {
              runGit(
                `-c commit.gpgsign=false merge ${branch} --no-ff -m ${JSON.stringify(doneAutoGitPlan.mergeMessage)}`,
                mainRepoRoot,
              );
              mergeLines.push(`✓ 分支 ${branch} 已合并到 ${mainBranch}`);
              const backupPath = (globalThis as any).__koalaDoneMainResidueBackup;
              if (backupPath) {
                mergeLines.push(`✓ main 同 story residue 已备份: ${backupPath}`);
                delete (globalThis as any).__koalaDoneMainResidueBackup;
              }
            } catch (e: any) {
              let rollbackNote = '';
              if (doneRollbackStory) {
                try {
                  store.writeStory(args.storyId, doneRollbackStory);
                  runGit(`add ${doneAutoGitPlan.storyDirRel}/${args.storyId}/index.json`, wtPathAbs);
                  const stagedRollback = runGit('diff --cached --name-only', wtPathAbs);
                  if (stagedRollback) {
                    runGit(
                      `-c commit.gpgsign=false commit -m ${JSON.stringify(`koala: rollback ${args.storyId} DONE after failed merge`)}`,
                      wtPathAbs,
                    );
                  }
                  rollbackNote = `\nRollback: story 分支已恢复到 ${doneRollbackStory.phase}，可在修复 main 冲突后重新 DONE confirm。`;
                } catch (rollbackError: any) {
                  rollbackNote = `\nRollback failed: ${rollbackError?.message || String(rollbackError)}\n请手动检查 story 分支 ${branch} 的 ${doneAutoGitPlan.storyDirRel}/${args.storyId}/index.json。`;
                }
              }
              if (doneAutoGitLock) {
                doneAutoGitLock.release();
                doneAutoGitLock = null;
              }
              throw new Error(
                `Story ${args.storyId} 自动合并失败:\n` +
                `${e.stderr?.toString() || e.message}\n\n` +
                `状态说明: main 尚未同步 story 分支 ${branch}。\n` +
                `不要并行执行其它 DONE confirm；先处理 main 工作区 dirty/untracked 或 merge 冲突后再继续。\n\n` +
                `当前 story metadata 的 canonical 版本在 story 分支。若冲突涉及当前 story metadata，请在 main 仓库中执行:\n` +
                `  git checkout ${branch} -- ${doneAutoGitPlan.storyDirRel}/${args.storyId}/\n\n` +
                `请手动完成:\n` +
                `  cd "${mainRepoRoot}"\n` +
                `  git status --short\n` +
                `  git merge ${branch}\n` +
                `  git checkout ${branch} -- ${doneAutoGitPlan.storyDirRel}/${args.storyId}/   # 如当前 story metadata 冲突\n` +
                `  git add ${doneAutoGitPlan.storyDirRel}/${args.storyId}/\n` +
                `  git commit\n` +
                `  git worktree remove --force "${wtPathAbs}"\n` +
                `  git branch -d ${branch}` +
                rollbackNote,
              );
            }

            // Step 4: 清理 worktree
            //
            // Two-step cleanup: `git worktree remove` deregisters the worktree
            // from git's internal list (so `git worktree list` no longer shows
            // it), then we `rm -rf` the directory to catch leftover files
            // that git didn't clean. Why the second step is needed:
            //
            // - activity.jsonl (Claude Code hook), tmp/llmlog.json and other
            //   gitignored runtime files are invisible to `git status` so git
            //   considers the worktree "dirty but all gitignored"
            // - with --force, git removes the worktree entry but leaves the
            //   directory (Windows + hook holding a file handle) or empty
            //   skeleton dirs behind
            // - result: `git worktree list` is clean but `.worktrees/B-xxx/`
            //   still exists with stray files
            //
            // The rm -rf is safe here because DONE gate already checked that
            // the working tree is clean AND the branch is merged into main —
            // anything left in the worktree is either gitignored runtime
            // state or genuine leakage we want to erase.
            if (existsSync(wtPathAbs)) {
              try {
                runGit(`worktree remove "${wtPathAbs}"`, mainRepoRoot);
                mergeLines.push(`✓ Worktree ${wtPathAbs} 已清理`);
              } catch {
                // worktree 内有 tmp/ llmlog 等运行时产物时 remove 会拒绝，用 --force
                try {
                  runGit(`worktree remove --force "${wtPathAbs}"`, mainRepoRoot);
                  mergeLines.push(`✓ Worktree ${wtPathAbs} 已强制清理`);
                } catch (e: any) {
                  mergeLines.push(`⚠ Worktree 未清理: ${e.message}`);
                }
              }
              // Second step: rm -rf the directory if git left it behind.
              // This is the fix for "worktree folder still exists after
              // DONE merge" caused by activity.jsonl-style gitignored
              // leftovers from Claude Code hooks.
              if (existsSync(wtPathAbs)) {
                try {
                  rmSync(wtPathAbs, { recursive: true, force: true });
                  mergeLines.push(`✓ Worktree 目录残留已清空`);
                } catch (e: any) {
                  mergeLines.push(`⚠ Worktree 目录残留清理失败: ${e.message}`);
                }
              }
            }

            // Step 5: 删除分支
            try {
              runGit(`branch -d ${branch}`, mainRepoRoot);
              mergeLines.push(`✓ 分支 ${branch} 已删除`);
            } catch {
              mergeLines.push(`⚠ 分支 ${branch} 未删除（可能有未合并的提交）`);
            }
          }

          if (mergeLines.length > 0) {
            doneMergeReport = `\n\n${[doneAutoSyncReport, ...mergeLines].filter(Boolean).join('\n\n')}`;
          }
          if (doneAutoGitLock) {
            doneAutoGitLock.release();
            doneAutoGitLock = null;
          }
        }
      }

      const humanHint = nextSteps[newState] || '';
      const humanHintBlock = humanHint ? `\nHuman hint:\n${humanHint}` : '';
      return `${doneChecklistPrefix}Story ${args.storyId} advanced to ${newState}${doneMergeReport}${humanHintBlock}${docsHint}${depsWarning}${sessionWarning}${doneSummarySuffix}`;
    },
  };
}
