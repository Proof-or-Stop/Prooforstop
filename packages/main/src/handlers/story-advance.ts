
import type { HandlerContext } from './context.js';
import { collectContext, PHASE_TO_EVENT, assertCwdInWorktree } from './context.js';
import { createStoryActor, getStateName, getGuardFailureReason } from '../core/machine.js';
import type { ChecklistData, StoryPhase } from '../core/types.js';
import { evaluateDeclaredArtifactReferences } from '../core/declared-artifact-gate.js';
import type { StoryStore } from '../core/store.js';
import { loadConfig } from '../core/config.js';
import { resolveWorkflowPolicy, computeChannel, CHANNEL_LABELS } from '../core/workflow-policy.js';
import { computeProcessMetrics } from '../core/process-metrics.js';
import { runHooks, buildHookEnv } from '../core/hooks.js';
import { checkMetaStoryAdvanceGuard } from '../core/audit-meta-store.js';
import { maybeTriggerAudit } from '../core/audit-trigger.js';
import { renderSummaryForHint } from './summary.js';
import { execFileSync, execSync } from 'child_process';
import { dirname, join, resolve } from 'path';
import { existsSync, rmSync } from 'fs';
import { cleanStrayWorktreeFiles } from './stray-file-cleanup.js';
import { computeActiveReviewers, renderActiveReviewersText } from './reviewer-list.js';
import { repairGlobalKoalaLinkBeforeWorktreeDelete } from './worktree.js';
import { recomputeDeliveryCheckHash } from './delivery-check.js';
import { detectMdTouchpointsFromGit } from '../core/touchpoints-fallback.js';
import { collectBaselineRisk, renderBaselineRiskLines } from '../core/baseline-risk.js';
import { checkEvidenceFreshnessForGit, currentMaterialHash, currentGitHead } from '../core/evidence-freshness.js';
import { findStaleEvidence, renderEvidenceStaleHint } from '../core/evidence-stale-hint.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';
import { reportHealthIssue } from '../core/health.js';
import type { OracleRow } from '../core/oracle-row.js';
import {
  classifyGitStatusRows,
  dirtyWorktreeClassifierOptionsForStory,
  dirtyWorktreeClassifierOptionsFromConfig,
  renderDirtyWorktreeGroups,
} from '../core/dirty-worktree.js';
import { defaultAuditWriter, evaluateDirtyGate, type DirtyGateName, type EvaluateDirtyGateResult } from '../core/dirty-gate-policy.js';
import {
  LOCAL_CODEX_VERIFY_COMMAND,
  summarizeCodexEvidence,
  storyRequiresCodexEvidence,
} from '../core/codex-adapter-checks.js';

// B-c622 CHK-004: DONE 阶段自动同步 main —— detect divergence + auto merge main

/** Check how many commits main has that the current branch doesn't. */
function checkMainDivergence(projectRoot: string): { behind: number; needsSync: boolean } {
  try {
    const result = execSync('git rev-list --count HEAD..main', {
      cwd: projectRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const behind = parseInt(result, 10) || 0;
    return { behind, needsSync: behind > 0 };
  } catch {
    return { behind: 0, needsSync: false };
  }
}

/** Auto-sync main into the current branch. Returns success/failure + message. */
function autoSyncMain(projectRoot: string): { ok: boolean; message: string } {
  // Try to fetch origin main first (fails silently for local-only repos)
  try {
    execSync('git fetch origin main:main', {
      cwd: projectRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch { /* local-only repo or no remote — skip fetch */ }
  try {
    execSync('git merge main --no-edit', {
      cwd: projectRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true, message: 'main 已自动同步到当前分支' };
  } catch {
    // conflict — abort merge to keep branch clean
    try {
      execSync('git merge --abort', {
        cwd: projectRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch { /* abort failed — already clean */ }
    return { ok: false, message: 'merge main 有冲突（已 abort 保持分支干净）。\n→ 执�� git merge main，解决冲突后 git add + git commit，然后重跑 story_advance DONE' };
  }
}

function readGitStatusLines(projectRoot: string): { ok: true; lines: string[] } | { ok: false; error: string } {
  try {
    const raw = execSync('git status --porcelain=v1 --untracked-files=all', {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true, lines: raw.split('\n').map(line => line.trimEnd()).filter(Boolean) };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// @task B-6326: DONE gate dirty output uses the shared ownership classifier.
// @task B-cf60: when a storyId/store is available, mix in declaredArtifactPaths from the
// per-story declared-artifacts.json so declared paths flip from unexpected → declared.
function classifierOptionsForCheck(
  config: ReturnType<typeof loadConfig>,
  storyId: string | undefined,
  store: StoryStore | undefined,
) {
  if (storyId && store) {
    return dirtyWorktreeClassifierOptionsForStory(config, storyId, store);
  }
  return dirtyWorktreeClassifierOptionsFromConfig(config);
}

// @task B-4b22: dirty git-working-tree row uses the shared dirty-gate-policy
// evaluator (single source of truth). Both summary (row.detail) and hint
// (row.hint) derive from the same EvaluateDirtyGateResult so divergent wording
// is impossible by construction (preMortem #3 anchor).
function evaluateDirtyGitStatus(
  lines: string[],
  config: ReturnType<typeof loadConfig>,
  storyId: string | undefined,
  store: StoryStore | undefined,
  gate: DirtyGateName,
  root: string,
): { classification: ReturnType<typeof classifyGitStatusRows>; result: EvaluateDirtyGateResult } {
  const classification = classifyGitStatusRows(lines, classifierOptionsForCheck(config, storyId, store));
  // Writer is wired only when storyId+store are available (so we know where to
  // append). storyId-less paths (e.g. anonymous status snapshots) skip audit
  // intentionally and pass null writer to the evaluator.
  const writer = storyId
    ? defaultAuditWriter(root, store ? store.storyDirRel() : config.storyDir, storyId)
    : null;
  const result = evaluateDirtyGate(classification, {
    storyId: storyId ?? 'anonymous',
    gate,
    writer,
  });
  return { classification, result };
}

// Legacy summarizeGitStatusLines / gitStatusDirtyHint helpers retired in
// B-4b22 — the only call site is now inlined inside the git-working-tree row
// (around buildDoneChecklist) and routes through evaluateDirtyGitStatus.

function isRegisteredWorktree(repoRoot: string, worktreePath: string): boolean {
  try {
    const raw = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const target = worktreePath.replace(/\\/g, '/');
    return raw
      .split(/\r?\n/)
      .filter(line => line.startsWith('worktree '))
      .map(line => line.slice('worktree '.length).trim().replace(/\\/g, '/'))
      .includes(target);
  } catch {
    return false;
  }
}

function pruneWorktreeRegistry(repoRoot: string): void {
  execFileSync('git', ['worktree', 'prune', '--expire', 'now'], {
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

type DoneWorktreeContext = {
  invocationCwd: string;
  worktreeRoot: string;
  mainRepoRoot: string;
  branch: string;
};

function samePath(a: string, b: string): boolean {
  return resolve(a).replace(/\\/g, '/') === resolve(b).replace(/\\/g, '/');
}

function detectDoneStoryWorktreeContext(invocationCwd = process.cwd()): DoneWorktreeContext | null {
  try {
    const resolvedInvocationCwd = resolve(invocationCwd);
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: resolvedInvocationCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const worktreeRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: resolvedInvocationCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const commonDirRaw = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: resolvedInvocationCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const mainRepoRoot = dirname(commonDirRaw);
    if (samePath(worktreeRoot, mainRepoRoot)) return null;

    return {
      invocationCwd: resolvedInvocationCwd,
      worktreeRoot: resolve(worktreeRoot),
      mainRepoRoot: resolve(mainRepoRoot),
      branch,
    };
  } catch {
    // PROBE: not in a git worktree or git metadata is unavailable.
    return null;
  }
}

function assertDoneStoryBranchMatches(storyId: string, branch: string): void {
  const expectedBranch = `story/${storyId}`;
  if (branch !== expectedBranch) {
    throw new Error(
      `refusing DONE cleanup: detected branch ${branch} but expected ${expectedBranch}; ` +
      `merge/delete aborted before mutating story state.`,
    );
  }
}

function assertSafeResidualWorktreeRm(ctx: DoneWorktreeContext, target: string, wasRegisteredWorktree: boolean): void {
  if (!samePath(target, ctx.worktreeRoot)) {
    throw new Error(`refusing residual cleanup outside canonical worktree root: ${target}`);
  }
  if (!wasRegisteredWorktree) {
    throw new Error(`refusing residual cleanup for unregistered worktree path: ${target}`);
  }
  if (!samePath(ctx.invocationCwd, ctx.worktreeRoot) && samePath(target, ctx.invocationCwd)) {
    throw new Error(`refusing residual cleanup of nested invocation cwd: ${target}`);
  }
}

function assertDoneMergeCanApplyBeforeStateMutation(storyId: string, worktreePath: string, mainRepoRoot: string): void {
  try {
    execFileSync('git', ['merge-tree', '--write-tree', 'main', 'HEAD'], {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e: any) {
    const detail = e?.stderr?.toString?.() || e?.stdout?.toString?.() || e?.message || String(e);
    throw new Error(
      `Cannot enter DONE: story/${storyId} 尚不能干净合并到 main；未修改 story phase。\n` +
      `${detail}\n\n` +
      `→ 在 worktree 内先解决与 main 的合并冲突，再重跑 story_advance --phase=DONE。\n` +
      `→ 可执行: cd "${worktreePath}" && git merge main\n` +
      `→ 主仓库: ${mainRepoRoot}`,
    );
  }
}

function gitRefExists(projectRoot: string, ref: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

function gitRefContainsMain(projectRoot: string, ref: string): boolean {
  execFileSync('git', ['merge-base', '--is-ancestor', 'main', ref], {
    cwd: projectRoot,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return true;
}

// B-9d95 CHK-003: re-export 供 DONE merge 前 stray 文件清理。主实现在独立
// 文件（stray-file-cleanup.ts），logicTest 直接 import，避免把 xstate/machine
// 等重依赖拖进测试进程。
export { cleanStrayWorktreeFiles, STRAY_FILE_WHITELIST } from './stray-file-cleanup.js';


// B-c622 CHK-009: evidence freshness 检查 — DONE gate 验证 test-evidence 是否对应当前 HEAD
function checkEvidenceFreshness(store: StoryStore, storyId: string, projectRoot: string): { fresh: boolean; message: string } {
  const evidence = store.readTestEvidence(storyId);
  if (!evidence) return { fresh: false, message: 'test-evidence.json 不存在' };
  const freshness = checkEvidenceFreshnessForGit(projectRoot, evidence.headHash, evidence.materialHash);
  return { fresh: freshness.fresh, message: freshness.reason };
}

/**
 * DONE Final Checklist：把 DONE 阶段所有验证项收成一份显式清单。
 * 无论 advance 成功失败都打印，强制主 agent 读一遍多层验证状态。
 * 对应 OMX ralph 的 <Final_Checklist>。
 */
export type DoneCheckRow = OracleRow;

function doneCheckRow(row: Omit<DoneCheckRow, 'blocking'> & { blocking?: boolean }): DoneCheckRow {
  return {
    blocking: row.blocking ?? row.status === 'fail',
    ...row,
  };
}

export function buildDoneChecklist(storyId: string, store: StoryStore, root: string): DoneCheckRow[] {
  const rows: DoneCheckRow[] = [];

  // Resolve workflow policy for policy-aware gates
  const config = loadConfig(root);
  const storyForPolicy = store.readStory(storyId);
  const policy = resolveWorkflowPolicy(config, storyForPolicy);

  // 1. test evidence
  const evidence = store.readTestEvidence(storyId);
  if (!evidence) {
    rows.push(doneCheckRow({
      id: 'test-evidence',
      status: 'fail',
      label: 'Test evidence',
      detail: '没有测试证据',
      hint: `koala validate --json`,
      source: 'test-evidence.json',
    }));
  } else if (evidence.result !== 'PASS') {
    rows.push(doneCheckRow({
      id: 'test-evidence',
      status: 'fail',
      label: 'Test evidence',
      detail: `${evidence.result}: ${evidence.output.slice(0, 120)}`,
      hint: '修复失败后重跑 koala validate',
      source: 'test-evidence.json',
    }));
  } else {
    let allPassedOk = true;
    try {
      const parsed = JSON.parse(evidence.output);
      if (parsed.allPass !== true && parsed.allPassed !== true) {
        allPassedOk = false;
        rows.push(doneCheckRow({
          id: 'test-evidence',
          status: 'fail',
          label: 'Test evidence',
          detail: `allPassed=${parsed.allPass ?? parsed.allPassed}`,
          hint: '修复失败后重跑 koala validate',
          source: 'test-evidence.json',
        }));
      }
    } catch { /* output 不是 JSON 也算 PASS（兼容旧格式）*/ }
    if (allPassedOk) {
      rows.push(doneCheckRow({
        id: 'test-evidence',
        status: 'pass',
        label: 'Test evidence',
        detail: `PASS @ ${evidence.timestamp}`,
        source: 'test-evidence.json',
      }));
    }
    if (evidence.verificationCoverage) {
      const vc = evidence.verificationCoverage;
      rows.push(doneCheckRow({
        id: 'verification-intent-coverage',
        status: vc.missingRequired > 0 ? 'fail' : 'pass',
        label: 'Verification intent coverage',
        detail: `${vc.covered}/${vc.total} covered, ${vc.missingRequired} required missing`,
        hint: vc.entries
          .filter(e => e.priority === 'must' && !['covered', 'waived'].includes(e.status))
          .map(e => `${e.intentRef} [${e.status}] ${e.desc}`)
          .join('\n'),
        source: 'test-evidence.json.verificationCoverage',
      }));
    }
  }

  // 1b. evidence freshness (B-c622 CHK-009)
  const freshness = checkEvidenceFreshness(store, storyId, root);
  if (!freshness.fresh) {
    rows.push(doneCheckRow({
      id: 'evidence-freshness',
      status: 'fail',
      label: 'Evidence freshness',
      detail: freshness.message,
      hint: 'koala validate --json',
      source: 'test-evidence.json',
    }));
  } else {
    rows.push(doneCheckRow({
      id: 'evidence-freshness',
      status: 'pass',
      label: 'Evidence freshness',
      detail: freshness.message,
      source: 'test-evidence.json',
    }));
  }

  // 2. all bugs fixed
  const bugData = store.readBugs(storyId);
  const total = bugData.bugs.length;
  const openBugs = bugData.bugs.filter(b => b.status === 'open');
  if (openBugs.length > 0) {
    rows.push(doneCheckRow({
      id: 'bugs-fixed',
      status: 'fail',
      label: 'Bugs fixed',
      detail: `${openBugs.length} open / ${total} total: ${openBugs.map(b => b.id).join(', ')}`,
      hint: '修复所有 open bug 后重跑 koala validate',
      source: 'bugs.json',
    }));
  } else {
    rows.push(doneCheckRow({
      id: 'bugs-fixed',
      status: 'pass',
      label: 'Bugs fixed',
      detail: total > 0 ? `${total}/${total}` : 'no bugs',
      source: 'bugs.json',
    }));
  }

  // 3. git working tree clean (B-4b22: category-aware via dirty-gate-policy)
  const gitStatus = readGitStatusLines(root);
  if (gitStatus.ok && gitStatus.lines.length === 0) {
    rows.push(doneCheckRow({
      id: 'git-working-tree',
      status: 'pass',
      label: 'git working tree',
      detail: 'clean',
      source: 'git status --porcelain',
    }));
  } else if (gitStatus.ok) {
    // @task B-4b22: evaluate via shared policy; status follows allPass.
    // Both detail and hint derive from the same EvaluateDirtyGateResult so
    // wording stays consistent (preMortem #3 anchor — no inline category
    // check; consumer-side divergence is structurally impossible).
    const { classification, result } = evaluateDirtyGitStatus(
      gitStatus.lines,
      config,
      storyId,
      store,
      'done-gate',
      root,
    );
    const detail = result.allPass ? `pass: ${result.summary}` : `fail: ${result.summary}`;
    const hintHeader = result.auditFailure
      ? result.auditFailure
      : (result.allPass
        ? 'all dirty paths matched passing categories; audit lines appended to process-events.jsonl'
        : '先处理这些 dirty path（按 ownership 分类；dirty 仍会阻塞 DONE）:');
    const hintLines = [
      hintHeader,
      `  ${result.summary}`,
      ...renderDirtyWorktreeGroups(classification, { sampleLimit: 6, indent: '  ' }),
    ];
    if (!result.allPass) {
      hintLines.push('如果这些文件来自 koala validate / npm test 的报告或 snapshot 副作用，请把项目验证改成默认无副作用，或用 env gate（例如 KOALA_WRITE_*_REPORT=1）显式开启写报告。');
    }
    const hint = hintLines.join('\n');
    rows.push(doneCheckRow({
      id: 'git-working-tree',
      status: result.allPass ? 'pass' : 'fail',
      label: 'git working tree',
      detail,
      hint,
      source: 'git status --porcelain',
    }));
  } else {
    rows.push(doneCheckRow({
      id: 'git-working-tree',
      status: 'fail',
      label: 'git working tree',
      detail: `无法读取 git status: ${gitStatus.error}`,
      hint: '确认当前目录是 git worktree，并修复 git status 后重跑 DONE gate',
      source: 'git status --porcelain',
    }));
  }

  // 4. branch synced with main (B-c622 CHK-004: 加入 divergence 检测提示)
  try {
    const story = store.readStory(storyId);
    if (story.worktree?.branch) {
      const branch = story.worktree.branch;
      if (!gitRefExists(root, branch)) {
        rows.push({
          id: 'branch-synced-main',
          status: 'warn',
          label: 'Branch synced with main',
          detail: `${branch} 不存在（可能已手动合并并清理）`,
          hint: `若 story 仍停在 TEST/DONE 边界，用 koala story_reconcile '{"dryRun":false}' 修复 phase/worktree metadata`,
          source: 'git worktree metadata',
          blocking: false,
        });
      } else {
        try {
          gitRefContainsMain(root, branch);
          rows.push(doneCheckRow({
            id: 'branch-synced-main',
            status: 'pass',
            label: 'Branch synced with main',
            detail: branch,
            source: 'git merge-base --is-ancestor main',
          }));
        } catch {
          const divergence = checkMainDivergence(root);
          rows.push(doneCheckRow({
            id: 'branch-synced-main',
            status: 'fail',
            label: 'Branch synced with main',
            detail: divergence.needsSync
              ? `${branch} 落后 main ${divergence.behind} 个提交`
              : `${branch} 未合并 main 的最新提交`,
            hint: 'DONE 推进时将自动尝试 git merge main；若有冲突请手动解决',
            source: 'git merge-base --is-ancestor main',
          }));
        }
      }
    } else {
      // No worktree branch recorded — detect from git directly
      const divergence = checkMainDivergence(root);
      if (divergence.needsSync) {
        rows.push(doneCheckRow({
          id: 'branch-synced-main',
          status: 'fail',
          label: 'Branch synced with main',
          detail: `当前分支落后 main ${divergence.behind} 个提交`,
          hint: 'DONE 推进时将自动尝试 git merge main；若有冲突请手动解决',
          source: 'git rev-list HEAD..main',
        }));
      } else {
        rows.push(doneCheckRow({
          id: 'branch-synced-main',
          status: 'pass',
          label: 'Branch synced with main',
          detail: 'up to date',
          source: 'git rev-list HEAD..main',
        }));
      }
    }
  } catch { /* 读 story 失败不阻塞，guard 已经报过错 */ }

  // 5. relatedDocs (advisory，warn 不影响判定)
  try {
    const cl = store.readChecklist(storyId);
    const allDocs = new Map<string, string[]>();
    for (const it of cl.items) {
      const docs = it.relatedDocs;
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
        const out = execSync('git diff main...HEAD --name-only', {
          cwd: root,
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        if (out) changedFiles = new Set(out.split('\n'));
      } catch { /* ignore */ }
      const unchanged: Array<[string, string[]]> = [];
      for (const [doc, items] of allDocs.entries()) {
        if (!changedFiles.has(doc.split('#')[0])) unchanged.push([doc, items]);
      }
      if (unchanged.length > 0) {
        rows.push(doneCheckRow({
          id: 'related-docs',
          status: 'warn',
          label: 'relatedDocs',
          detail: `${unchanged.length}/${allDocs.size} untouched (advisory)`,
          hint: unchanged.map(([d, items]) => `${d}  (${items.join(', ')})`).join('\n'),
          source: 'checklist.relatedDocs',
          blocking: false,
        }));
      } else {
        rows.push(doneCheckRow({
          id: 'related-docs',
          status: 'pass',
          label: 'relatedDocs',
          detail: `${allDocs.size}/${allDocs.size} touched`,
          source: 'checklist.relatedDocs',
          blocking: false,
        }));
      }
    }
  } catch { /* ignore */ }

  // 6. delivery-check.json (hard gate, mirrors machine.canFinish / getGuardFailureReason)
  const deliveryCheck = store.readDeliveryCheck(storyId);
  if (!deliveryCheck) {
    rows.push(doneCheckRow({
      id: 'delivery-check',
      status: 'fail',
      label: 'delivery-check',
      detail: '缺 delivery-check.json（需 koala-review-delivery reviewer 签名）',
      hint: '运行 koala-review-delivery reviewer，并用 delivery_check_set 写入签名产物',
      source: 'delivery-check.json',
    }));
  } else {
    const expectedHash = recomputeDeliveryCheckHash(storyId, store);
    if (expectedHash === null || deliveryCheck._hash !== expectedHash) {
      rows.push(doneCheckRow({
        id: 'delivery-check',
        status: 'fail',
        label: 'delivery-check',
        detail: 'delivery-check.json _hash 失配',
        hint: '重跑 koala-review-delivery reviewer 生成新的 delivery-check.json',
        source: 'delivery-check.json._hash',
      }));
    } else {
      const unverified = deliveryCheck.docsPromises.filter(
        p => !p.verifiedBy && !p.waiverReason && !['met', 'verified', 'waived'].includes(p.status || ''),
      );
      if (unverified.length > 0) {
        rows.push(doneCheckRow({
          id: 'delivery-check',
          status: 'fail',
          label: 'delivery-check',
          detail: `${unverified.length} 条 docsPromise 未验证且无豁免`,
          hint: '用 delivery_waiver_add 写豁免，或重跑 koala-review-delivery reviewer 补验证证据',
          source: 'delivery-check.json.docsPromises',
        }));
      } else {
        rows.push(doneCheckRow({
          id: 'delivery-check',
          status: 'pass',
          label: 'delivery-check',
          detail: `${deliveryCheck.docsPromises.length} docsPromises checked`,
          source: 'delivery-check.json.docsPromises',
        }));
      }
    }
  }

  // 6b. declared-artifacts referenced (B-cf60 CHK-003): every entry's
  //     relatedIntent must resolve to a real verificationIntent slot or
  //     delivery-check docsPromise. Bogus intentRefs (e.g. X-001:happy:0)
  //     fail here — preMortem #2 anchor.
  {
    const declared = store.readDeclaredArtifacts(storyId);
    if (declared.entries.length === 0) {
      rows.push(doneCheckRow({
        id: 'declared-artifacts-referenced',
        status: 'pass',
        label: 'declared artifacts referenced',
        detail: '0/0 (no declarations)',
        source: 'declared-artifacts.json',
        blocking: false,
      }));
    } else {
      let checklistData: ChecklistData | null = null;
      try { checklistData = store.readChecklist(storyId); } catch { /* no checklist */ }
      const refResult = evaluateDeclaredArtifactReferences(declared, checklistData, deliveryCheck);
      const referenced = refResult.total - refResult.unreferenced.length;
      if (refResult.unreferenced.length > 0) {
        const unrefDetails = refResult.unreferenced
          .map(u => `${u.path} (relatedIntent=${u.relatedIntent || '<empty>'})`)
          .join('\n');
        rows.push(doneCheckRow({
          id: 'declared-artifacts-referenced',
          status: 'fail',
          label: 'declared artifacts referenced',
          detail: `${referenced}/${refResult.total} (unreferenced: ${refResult.unreferenced.length})`,
          hint:
            '[unreferenced_declared_artifact] 下列 declared artifact 的 relatedIntent 不指向任何 verificationIntent 或 delivery-check docsPromise；' +
            '请用 verification_evidence_add 补 evidence、把 relatedIntent 改成存在的 intentRef，或用 delivery_check_set / delivery_waiver_add 加 docsPromise：\n' +
            unrefDetails,
          source: 'declared-artifacts.json',
        }));
      } else {
        rows.push(doneCheckRow({
          id: 'declared-artifacts-referenced',
          status: 'pass',
          label: 'declared artifacts referenced',
          detail: `${refResult.total}/${refResult.total}`,
          source: 'declared-artifacts.json',
          blocking: false,
        }));
      }
    }
  }

  // 7. evaluator evidence (policy-aware: hard gate or advisory depending on profile)
  if (config.browser?.devCommand) {
    const requireEval = policy.test.requireEvaluatorForBrowser;
    const evalEvidence = store.readEvalEvidence(storyId);
    if (!evalEvidence) {
      rows.push(doneCheckRow({
        id: 'eval-evidence',
        status: requireEval ? 'fail' : 'warn',
        label: 'Evaluator',
        detail: requireEval
          ? '没有 evaluator 打分（browser 项目必须跑 evaluator）'
          : '没有 evaluator 打分（advisory — profile 未要求）',
        hint: `koala evaluate '{"storyId":"${storyId}"}'`,
        source: 'eval-evidence.json',
        blocking: requireEval,
      }));
    } else if (!evalEvidence.pass) {
      rows.push(doneCheckRow({
        id: 'eval-evidence',
        status: requireEval ? 'fail' : 'warn',
        label: 'Evaluator',
        detail: `未通过: functionality=${evalEvidence.scores.functionality} usability=${evalEvidence.scores.usability} total=${evalEvidence.total}`,
        hint: '修复 evaluator 发现的问题后重跑 koala evaluate',
        source: 'eval-evidence.json',
        blocking: requireEval,
      }));
    } else {
      rows.push(doneCheckRow({
        id: 'eval-evidence',
        status: 'pass',
        label: 'Evaluator',
        detail: `functionality=${evalEvidence.scores.functionality} usability=${evalEvidence.scores.usability} total=${evalEvidence.total} @ ${evalEvidence.timestamp}`,
        source: 'eval-evidence.json',
        blocking: false,
      }));
    }
  }

  // 8. summary.json (policy-aware: 'full' = hard gate, 'minimal' = warn, 'none' = skip)
  const summaryReq = policy.done.requireSummary;
  if (summaryReq !== 'none') {
    const summary = store.readSummary(storyId);
    if (!summary) {
      rows.push(doneCheckRow({
        id: 'story-summary',
        status: summaryReq === 'full' ? 'fail' : 'warn',
        label: 'Story summary',
        detail: summaryReq === 'full'
          ? '没有 summary.json'
          : '没有 summary.json（advisory — profile 要求 minimal）',
        hint: `koala summary_set '{"storyId":"${storyId}","changes":"改了什么（≥10 字符）","usage":"怎么用（≥10 字符）","expectedOutcome":"用户预期看到什么","actualTranscript":"真实运行看到什么","outcomeDiff":"expected vs actual 差异","acceptanceVerdict":"accepted","limitations":"已知限制或 \\"none — fully covered\\"","pitfalls":"踩坑记录（≥10 字符，强制段）"}'`,
        source: 'summary.json',
        blocking: summaryReq === 'full',
      }));
    } else {
      const missing: string[] = [];
      if (!summary.changes || summary.changes.trim().length < 10) missing.push('changes');
      if (!summary.usage || summary.usage.trim().length < 10) missing.push('usage');
      if (!summary.expectedOutcome || summary.expectedOutcome.trim().length < 10) missing.push('expectedOutcome');
      if (!summary.actualTranscript || summary.actualTranscript.trim().length < 10) missing.push('actualTranscript');
      if (!summary.outcomeDiff || summary.outcomeDiff.trim().length < 5) missing.push('outcomeDiff');
      if (!summary.acceptanceVerdict) missing.push('acceptanceVerdict');
      if (typeof summary.limitations !== 'string' || summary.limitations.trim().length < 2) missing.push('limitations');
      if (!summary.pitfalls || summary.pitfalls.trim().length < 10) missing.push('pitfalls');
      if (missing.length > 0) {
        rows.push(doneCheckRow({
          id: 'story-summary',
          status: summaryReq === 'full' ? 'fail' : 'warn',
          label: 'Story summary',
          detail: `字段缺失/过短: ${missing.join(', ')}`,
          hint: `重新调 koala summary_set 补齐 ${missing.join(', ')}`,
          source: 'summary.json',
          blocking: summaryReq === 'full',
        }));
      } else {
        const cov = summary.realMachineCoverage;
        const covNote = `${cov.ran.length} ran / ${cov.skipped.length} skipped`;
        const expectedOutcome = summary.expectedOutcome || '';
        rows.push(doneCheckRow({
          id: 'story-summary',
          status: 'pass',
          label: 'Story summary',
          detail: `complete (${covNote})`,
          source: 'summary.json',
          blocking: false,
        }));
        rows.push(doneCheckRow({
          id: 'user-value-summary',
          status: 'pass',
          label: 'User value summary',
          detail: `${summary.acceptanceVerdict}: ${expectedOutcome.slice(0, 80)}${expectedOutcome.length > 80 ? '...' : ''}`,
          hint: [
            `usage: ${summary.usage}`,
            `actual: ${summary.actualTranscript}`,
            `diff: ${summary.outcomeDiff}`,
            `limitations: ${summary.limitations}`,
          ].join('\n'),
          source: 'summary.json',
          blocking: false,
        }));
      }
    }
  }

  // 8. Codex adapter hard evidence for Codex-touching stories.
  if (storyRequiresCodexEvidence(store, storyId)) {
    const codex = summarizeCodexEvidence(store, storyId, root);
    rows.push(doneCheckRow({
      id: 'codex-adapter-evidence',
      status: codex.status === 'passing' ? 'pass' : 'fail',
      label: 'Codex adapter evidence',
      detail: `${codex.status}: ${codex.detail}`,
      hint: codex.command,
      source: 'process-events:codex_adapter_verification',
    }));
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
    // warn 行和用户价值摘要都展开多行明细，方便 DONE 前复述给用户。
    if ((row.status === 'warn' || row.id === 'user-value-summary') && row.hint) {
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
    async story_advance(args: {
      storyId: string;
      phase: StoryPhase;
      checklist?: Array<{ id: string; title: string }>;
    }): Promise<string> {
      // B-9bd9 CHK-002: meta-story 永不进 DONE（跨 story 长存容器，只挂 finding）
      const metaGuardErr = checkMetaStoryAdvanceGuard(args.storyId, args.phase);
      if (metaGuardErr) {
        throw new Error(metaGuardErr);
      }

      const story = store.readStory(args.storyId);
      const oldPhase: string = story.phase as string;

      // CWD 门禁：PLAN/DEV/TEST 阶段必须在 worktree 里执行
      const CWD_GATED: StoryPhase[] = ['PLAN', 'DEV', 'REVIEW', 'TEST'];
      if (CWD_GATED.includes(args.phase) && story.worktree) {
        assertCwdInWorktree(store, args.storyId);
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
      if (args.phase === 'DEV' && story.events) {
        const devEvents = story.events.filter(e => e.phase === 'DEV' && e.action === 'advance');
        if (devEvents.length > 0) {
          const lastDev = devEvents[devEvents.length - 1];
          const currentSession = process.env.KOALA_SESSION_ID || process.env.CLAUDE_SESSION_ID || '';
          if (lastDev.sessionId && lastDev.sessionId !== currentSession) {
            const who = lastDev.user || lastDev.agent || 'unknown';
            const when = lastDev.timestamp;
            sessionWarning = `\n⚠ Warning: Story ${args.storyId} 已被 ${who} 于 ${when} 领取开发（session: ${lastDev.sessionId}）`;
            console.error(sessionWarning.trim());
          }
        }
      }

      // IDEA→PLAN 需要 checklist
      if (args.phase === 'PLAN' && story.phase === 'IDEA') {
        if (!args.checklist || args.checklist.length === 0) {
          throw new Error('Cannot advance to PLAN: checklist is required');
        }
      }

      // B-c622 CL-006: auto-sync main BEFORE actor.can() to avoid TOCTOU —
      // guard evaluates post-merge state, not pre-merge state.
      if (args.phase === 'DONE') {
        const doneWorktree = detectDoneStoryWorktreeContext();
        if (doneWorktree) {
          assertDoneStoryBranchMatches(args.storyId, doneWorktree.branch);
        }
        const divergence = checkMainDivergence(ctx.root);
        if (divergence.needsSync) {
          ctx.log?.(`DONE pre-check: 当前分支落后 main ${divergence.behind} 个提交，自动同步...`);
          const syncResult = autoSyncMain(ctx.root);
          if (syncResult.ok) {
            ctx.log?.(`✓ ${syncResult.message}`);
          } else {
            ctx.log?.(`⚠ ${syncResult.message}`);
          }
        }
      }

      const actor = createStoryActor(args.storyId, store, story.phase, ctx.root);
      actor.start();

      let eventType = PHASE_TO_EVENT[args.phase];
      if (!eventType) {
        throw new Error(`Invalid target phase: ${args.phase}`);
      }
      // 回退映射：目标阶段比当前阶段早时，选择对应的回退事件
      if (args.phase === 'PLAN' && story.phase === 'DEV') {
        eventType = 'REPLAN';
      }
      // TEST→DEV 回退：PHASE_TO_EVENT['DEV']='START' 自动命中

      const canSend = actor.getSnapshot().can({ type: eventType } as any);
      if (!canSend) {
        const reason = getGuardFailureReason(args.storyId, store, args.phase, ctx.root);
        const currentState = getStateName(actor);
        actor.stop();
        throw new Error(
          reason || `Cannot transition from ${currentState} to ${args.phase}`
        );
      }

      // F-019 (B-9d95 Round 1 review): REVIEW→TEST preflight 跑 CLI gates。
      // runReviewCliGates 聚合 checkCommitAuthor / checkConcept / checkLint /
      // docs-drift，并在 Codex adapter 触点存在时追加 codex-adapter gate。
      // 任一 fail 即 block；快速通道走 runReviewCliGates 内部的 fastChannel
      // 路径（常规 gate 统一 skip），与 F-015 修正后的 computeChannel 口径一致。
      if (args.phase === 'TEST' && story.phase === 'REVIEW') {
        ctx.log?.('REVIEW→TEST preflight: running CLI gates (channel/concept/lint/docs-drift plus conditional codex-adapter)...');
        try {
          const { runReviewCliGates, renderPreflight } = await import('./review-preflight.js');
          const preflight = runReviewCliGates(args.storyId, {
            store,
            projectRoot: ctx.root,
            registryNames: ctx.getAllToolNames?.(),
          });
          if (!preflight.ok) {
            actor.stop();
            const rendered = renderPreflight(preflight);
            const failedGates = preflight.gates.filter(g => !g.ok).map(g => g.name).join(', ');
            throw new Error(
              `Cannot enter TEST: CLI gate preflight 失败 (${failedGates})\n\n` +
              rendered +
              `\n\n→ 修复上述 gate 后重跑 koala story_advance --phase=TEST\n` +
              `→ 单独复跑: koala validate --channel --story=${args.storyId} / --concept / --lint；docs-drift 随 preflight 执行；Codex adapter 用 ${LOCAL_CODEX_VERIFY_COMMAND}`,
            );
          }
          ctx.log?.('CLI gate preflight: all pass');
        } catch (e: any) {
          if (e?.message?.startsWith('Cannot enter TEST')) throw e;
          // 预检查本身失败（review-preflight.ts import 失败等）→ fail-closed
          actor.stop();
          const message = e instanceof Error ? e.message : String(e);
          throw new Error(
            `Cannot enter TEST: CLI gate preflight 执行异常\n` +
            `${message}\n\n` +
            `→ 修复 review-preflight gate 后重跑 koala story_advance --phase=TEST\n` +
            `→ 单独复跑: koala validate --channel --story=${args.storyId} / --concept / --lint；docs-drift 随 preflight 执行；Codex adapter 用 ${LOCAL_CODEX_VERIFY_COMMAND}`,
          );
        }
      }

      // DEV→TEST 门禁：自动调 koala validate，写 test-evidence.json
      if (args.phase === 'TEST') {
        ctx.log?.('DEV→TEST gate: running koala validate --json...');
        try {
          const { createVerifierHandlers } = await import('./verifier.js');
          const verifierHandlers = createVerifierHandlers(ctx);
          const jsonResult = await verifierHandlers.validate({ json: true, story: args.storyId });
          const parsed = JSON.parse(String(jsonResult));

          // 写入 test-evidence.json（DONE gate 消费）
          // B-c622 CHK-009: 记录 headHash 供 DONE gate evidence freshness 检查
          let evidenceHeadHash = '';
          try {
            evidenceHeadHash = execSync('git rev-parse HEAD', { cwd: ctx.root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
          } catch { /* 无法获取 HEAD，跳过 */ }
          const evidenceMaterialHash = currentMaterialHash(ctx.root);
          store.writeTestEvidence(args.storyId, {
            command: `koala validate --story=${args.storyId} --json`,
            output: String(jsonResult),
            result: parsed.allPass ? 'PASS' : 'FAIL',
            timestamp: new Date().toISOString(),
            ...(evidenceHeadHash ? { headHash: evidenceHeadHash } : {}),
            ...(evidenceMaterialHash ? { materialHash: evidenceMaterialHash } : {}),
            ...(parsed.verificationCoverage ? { verificationCoverage: parsed.verificationCoverage } : {}),
          });

          if (!parsed.allPass) {
            actor.stop();
            const failedDetails = (parsed.details || []).filter((d: string) => d.startsWith('✗'));
            const coverage = parsed.verificationCoverage;
            const missingCoverage = coverage?.missingRequired ?? 0;
            const coverageLines = Array.isArray(coverage?.entries)
              ? coverage.entries
                .filter((e: any) => e.priority === 'must' && !['covered', 'waived'].includes(e.status))
                .map((e: any) => `  - ${e.intentRef} [${e.status}] ${e.desc}`)
              : [];
            const sections = [
              failedDetails.length > 0 ? failedDetails.join('\n') : '',
              missingCoverage > 0
                ? `Verification coverage 不足: ${coverage.covered}/${coverage.total} covered, ${missingCoverage} required missing\n${coverageLines.join('\n')}`
                : '',
              parsed.summary ? `Summary: ${parsed.summary}` : '',
            ].filter(Boolean);
            throw new Error(
              `Cannot enter TEST: koala validate 未通过` +
              (failedDetails.length > 0 ? `（${failedDetails.length} 项命令失败）` : '') +
              (missingCoverage > 0 ? `（verification coverage 缺 ${missingCoverage} 项）` : '') +
              '\n' +
              sections.join('\n') +
              '\n\n→ 修复后重跑 koala validate，再 story_advance --phase=TEST'
            );
          }
          ctx.log?.('validate PASS, writing test-evidence.json');
        } catch (e: any) {
          if (e.message?.includes('Cannot enter TEST')) throw e;
          actor.stop();
          const message = e instanceof Error ? e.message : String(e);
          try {
            store.writeTestEvidence(args.storyId, {
              command: `koala validate --story=${args.storyId} --json`,
              output: `validate execution error: ${message}`,
              result: 'FAIL',
              timestamp: new Date().toISOString(),
            });
          } catch (persistError) {
            reportHealthIssue('persist:testEvidence', persistError as Error, {
              storyId: args.storyId,
              phase: 'TEST',
              gate: 'validate-execution-error',
            });
          }
          throw new Error(
            `Cannot enter TEST: koala validate 执行异常\n` +
            `${message}\n\n` +
            `→ 修复 validate runner 后重跑 koala validate --story=${args.storyId} --json\n` +
            `→ 然后重跑 koala story_advance --phase=TEST`,
          );
        }
      }

      // TEST→DONE 严格门禁：构建并渲染 DONE Final Checklist。
      // 无论 advance 成功失败都会输出这份 checklist，强制主 agent 读一遍多层验证状态。
      // 对应 OMX ralph 的 <Final_Checklist>。
      if (args.phase === 'DONE') {
        // B-c622 CL-006: autoSyncMain moved before actor.can() to fix TOCTOU.

        const checkRows = buildDoneChecklist(args.storyId, store, ctx.root);
        const rendered = renderDoneChecklist(args.storyId, checkRows);
        const failed = checkRows.filter(r => r.status === 'fail');

        if (failed.length > 0) {
          actor.stop();
          const hints = failed.flatMap(r => r.hint ? [r.hint] : []);
          throw new Error(
            rendered + '\n\n' +
            `Cannot enter DONE: ${failed.length} 项检查未通过` +
            (hints.length > 0 ? '\n\n修复建议:\n' + hints.map(h => `→ ${h}`).join('\n') : '')
          );
        }

        // 全部硬检查通过，把渲染好的 checklist 暂存，最终拼到 advance 成功消息里
        (globalThis as any).__koalaDoneChecklistRendered = rendered;

        // F-020 (B-9d95 Round 1 review): stray-file 检测提前到 phase=DONE 落盘
        // 之前。原实现（Step 2.5，line 632 附近）在 story.phase=DONE +
        // story.worktree=undefined 已 writeStory 之后才跑，若 throw（非白名单
        // 未追踪文件）story 会卡 DONE（merge 未发生、worktree 还活着、没有
        // koala 自愈路径）。这里预检查：dry-run detection，发现 offender 立刻
        // throw，保留 phase=TEST 状态让 main agent 按错误提示修复后重跑。
        //
        // whitelist 文件在此**不删除**——只负责早期拦截。真正的 rm 延后到
        // Step 2.5 (actor.send 之后的 merge 流程) 做，因为此时才知道合并一定
        // 会发生。预检查只看"有没有 offender"：
        //   - 有 offender → throw（保留文件，不落盘 DONE）
        //   - 无 offender → 继续走完整流程，whitelist rm 在 Step 2.5 执行
        try {
          const doneWorktree = detectDoneStoryWorktreeContext();
          if (doneWorktree) {
            assertDoneStoryBranchMatches(args.storyId, doneWorktree.branch);
            // 仅 dry-run：用 git ls-files 读出未追踪文件，按白名单分类。
            // 发现 offender → throw（此时 story.phase 仍为 TEST）。无 offender
            // → 返回，不做任何删除，后续 Step 2.5 才会真的 rm whitelist 文件。
            const { mainRepoRoot, worktreeRoot } = doneWorktree;
            const storyDir = `${store.storyDirRel()}/${args.storyId}/`;
            if (existsSync(join(mainRepoRoot, storyDir))) {
              let raw = '';
              try {
                raw = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', storyDir], {
                  cwd: mainRepoRoot,
                  encoding: 'utf-8',
                  stdio: ['pipe', 'pipe', 'pipe'],
                }).toString();
              } catch { /* PROBE: 忽略，让 Step 2.5 兜底 */ }
              const relPaths = raw.split('\n').map(l => l.trim()).filter(Boolean);
              const { STRAY_FILE_WHITELIST: WL } = await import('./stray-file-cleanup.js');
              const offenders = relPaths.filter(rel => !WL.includes(rel.split('/').pop() || rel));
              if (offenders.length > 0) {
                // 复用 cleanStrayWorktreeFiles 的 throw 消息（单一真相源），
                // 传入 worktreePath 让消息含 git worktree remove / branch -d 指引。
                actor.stop();
                cleanStrayWorktreeFiles(mainRepoRoot, args.storyId, worktreeRoot);
                // cleanStrayWorktreeFiles 在有 offender 时必然 throw；能到这行
                // 说明逻辑偏离，fallback：主动抛错避免 phase 默认落盘。
                throw new Error(
                  `Story ${args.storyId} DONE pre-merge stray 检测：检测到非白名单未追踪文件但 cleanStrayWorktreeFiles 未抛错（内部状态偏离），阻止推进。`,
                );
              }
            }
            assertDoneMergeCanApplyBeforeStateMutation(args.storyId, worktreeRoot, mainRepoRoot);
          }
        } catch (e: any) {
          // throw 的错误信息（含 stash / worktree remove 指引）直接冒给 caller，
          // 不吞。只有 git 探测本身的非 throw 失败被上面的 catch 吃掉。
          if (
            e?.message?.startsWith(`Story ${args.storyId} DONE `)
            || e?.message?.startsWith('Cannot enter DONE:')
            || e?.message?.startsWith('refusing DONE cleanup:')
          ) {
            throw e;
          }
          // 其他意外（如 import 失败 / unknown）转成可见错误
          throw new Error(`DONE pre-merge 预检查失败: ${e?.message ?? e}`);
        }
      }

      actor.send({ type: eventType } as any);
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
      // 推进到 REVIEW 时，生成新的 review round ID
      if (args.phase === 'REVIEW') {
        story.currentReviewRound = now;
      }
      store.writeStory(args.storyId, story);

      // B-abd8: auto-recompute process metrics on DEV/TEST/DONE transitions
      // DEV included so fast-channel stories get initial metrics
      if (args.phase === 'DEV' || args.phase === 'TEST' || args.phase === 'DONE') {
        try {
          const pm = computeProcessMetrics(args.storyId, store, ctx.root);
          store.writeProcessMetrics(args.storyId, pm);
        } catch (e) {
          console.warn(`[process-metrics] recompute failed for ${args.storyId}:`, (e as Error).message);
        }
      }

      // onPhaseChange hook — fires after the new phase is persisted, so the
      // hook can read the up-to-date story state. Failures are non-blocking.
      // Uses the shared buildHookEnv helper so KOALA_ARGS_JSON / KOALA_STORY_ID
      // / KOALA_PHASE stay consistent with the cli-engine code path.
      try {
        const cfg = loadConfig(ctx.root);
        const env = buildHookEnv({
          stage: 'onPhaseChange',
          command: 'story_advance',
          // B-9d95 CHK-001 whitelist: hook 执行上下文——hook 子进程需继承调用方真实 cwd（用户 shell 的当前目录）
          // 而非 ctx.root，否则 hook 脚本看不到调用方的 worktree。这是 hook 协议约定（详见 buildHookEnv docs）。
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

      let metadataCommitReport = '';
      if (args.phase === 'REVIEW') {
        metadataCommitReport = autoCommitStoryMetadata(ctx.root, args.storyId, args.phase);
      }

      // CHK-002: PLAN→DEV 时收集所有 relatedDocs 列出来作为开工提醒
      // B-45ed CHK-008: PLAN→DEV 和 DONE 的 docsHint 统一含 background.md
      let docsHint = '';
      if (args.phase === 'DEV' || args.phase === 'DONE') {
        try {
          const cl = store.readChecklist(args.storyId);
          const docMap = new Map<string, string[]>(); // doc → [itemId]
          for (const it of cl.items) {
            const docs = it.relatedDocs;
            if (Array.isArray(docs)) {
              for (const d of docs) {
                if (!docMap.has(d)) docMap.set(d, []);
                docMap.get(d)!.push(it.id);
              }
            }
          }
          // B-45ed CHK-008: background.md 若存在且未出现 → 追加到 docMap（用 special 标签标记来源）
          const bgRel = `${store.storyDirRel()}/${args.storyId}/background.md`;
          const bgAbs = join(ctx.root, bgRel);
          if (existsSync(bgAbs) && !docMap.has(bgRel)) {
            docMap.set(bgRel, ['(story background)']);
          }
          if (docMap.size > 0) {
            const lines: string[] = [];
            for (const [d, items] of docMap.entries()) {
              lines.push(`  - ${d}  (${items.join(', ')})`);
            }
            const header = args.phase === 'DEV'
              ? '📄 本 story 关联文档（改代码时注意同步）:'
              : '📄 本 story 关联文档（DONE 收尾前核对是否已同步）:';
            docsHint = `\n\n${header}\n${lines.join('\n')}`;
          }
        } catch { /* ignore */ }
      }

      const nextSteps: Record<string, string> = {
        PLAN: `→ 建议立即切到 Claude Code plan 模式（shift-tab 两次到 plan mode）——PLAN 阶段只拆 checklist / 写 understanding_set / decision_set，不应改代码。Edit/Write 被 plan mode 禁掉能防误触。
→ 下一步: checklist_get(${args.storyId}) 查看待开发项，然后 story_advance(${args.storyId}, DEV) 开始开发
⚠ 用户价值验收（强制）: understanding_set 的 outcome 字段必须写成一段具体的 user-facing transcript ——用户跑完这个 story 后会在终端/UI 看到的精确文字，不是 "事件 X 通了" 这种抽象描述。判定方法: outcome 读起来必须能让人想象出"用户什么时候说'好了搞定'"的那一刻。详见 CLAUDE.md「用户价值验收」段。`,
        DEV: (() => {
          // B-45ed CHK-004: 实时算三档通道（express/fast/normal）
          let channel: 'express' | 'fast' | 'normal' = 'normal';
          try {
            const s = store.readStory(args.storyId);
            const cl = store.readChecklist(args.storyId);
            let decision = null;
            try { decision = store.readDecision(args.storyId); } catch {}
            channel = computeChannel(s, cl, decision);
          } catch {}
          if (channel === 'express') {
            return `→ 极速通道（${CHANNEL_LABELS.express}，≤2 项，无 riskSignals）：主 agent 自己写代码 + 写测试，只需 checklist。
→ 完成后 story_advance(${args.storyId}, REVIEW) 进入代码审查`;
          }
          if (channel === 'fast') {
            return `→ 快速通道（${CHANNEL_LABELS.fast}，≤5 项，单一解，无 riskSignals）：主 agent 可自己写代码，省 decision + plan.md，保留 understanding。
→ 完成后 story_advance(${args.storyId}, REVIEW) 进入代码审查`;
          }
          return `→ 正常通道（${CHANNEL_LABELS.normal}）：必须启动 koala-implementer subagent 写代码，主 agent 不要自己改业务代码。
→ 用 Agent({ subagent_type: "koala-implementer", prompt: "..." }) 分配任务
→ subagent 写完提交后，主 agent 验收合并，然后 story_advance(${args.storyId}, REVIEW)
→ sub agent 不要使用 isolation:"worktree"，直接在主 agent 的 worktree 中跑
⚠ REVIEW 阶段 koala-reviewer 会检查 commit author——正常通道如果全是主 agent 自己写的代码会被提 critical finding`;
        })(),
        REVIEW: (() => {
          // B-fdcf CHK-002: 按 opt-in 名单动态 echo（channel LLM reviewer 退役后不再固定 5 个）。
          let activeLine = 'Active reviewers: concept, quality (fallback: 无法解析 opt-in 名单，按 baseline)';
          let agentLines = '';
          try {
            const story = store.readStory(args.storyId);
            let checklistForReview: { items: unknown[] } = { items: [] };
            try { checklistForReview = store.readChecklist(args.storyId); } catch { /* none */ }
            let decisionForReview = null;
            try { decisionForReview = store.readDecision(args.storyId); } catch { /* none */ }
            const understandingForReview = store.readUnderstanding(args.storyId);
            const touchpointsForReview = understandingForReview?.touchpoints
              ?? detectMdTouchpointsFromGit(ctx.root);
            const active = computeActiveReviewers(
              story,
              checklistForReview,
              decisionForReview,
              touchpointsForReview,
            );
            activeLine = renderActiveReviewersText(active);
            agentLines = active.map(r =>
              `  Agent({ subagent_type: "koala-review-${r.name}", prompt: "审查 story ${args.storyId} (${r.reason})" })`,
            ).join('\n');
          } catch {
            agentLines = `  Agent({ subagent_type: "koala-review-concept", prompt: "审查 story ${args.storyId}" })
  Agent({ subagent_type: "koala-review-quality", prompt: "审查 story ${args.storyId}" })`;
          }
          return `→ ${activeLine}
→ 并行启动上述 reviewer 审查代码（在同一条消息里发出所有 Agent 调用）：
${agentLines}
→ reviewer liveness：每个 reviewer 启动后应先输出 REVIEW_START:<reviewer>；4 分钟无输出先问状态，10 分钟/600s 无结果视为 stalled，重启该 reviewer 并在 retry prompt 中注明前一次 stalled
→ 全部回来后 koala finding_list 汇总
→ critical/high 全 resolved 后：story_advance(${args.storyId}, TEST)
→ 需要改代码：story_advance(${args.storyId}, DEV) 回 DEV
⚠ reviewer 调 finding_add 时必须传 agent 参数（如 "agent":"koala-review-behavior"），否则 finding 会被标记为 main agent，TEST gate 会拒绝推进`;
        })(),
        TEST_CASE: `→ Legacy phase. 建议直接 story_advance(${args.storyId}, TEST) 进入验证`,
        TEST_CASE_REVIEW: `→ Legacy phase. 建议直接 story_advance(${args.storyId}, TEST) 进入验证`,
        TEST: `→ 必须立即执行: koala validate 跑验证，写 bug/evidence。fail 自动 aux_diagnose + bug_report，pass 自动标 bug fixed。
⚠ 工程验证 ≠ 用户验收: 即使 validate 全 pass，也必须用用户视角真机跑一次（节奏: 把 PLAN outcome 当 expected → 跑 → 把实际输出当 actual → diff）。验证完把 actual transcript + 差异说明放到 ${store.storyDirRel()}/${args.storyId}/evidence/transcript-diff.md。CLAUDE.md「用户价值验收」段有完整 5 题自检清单。
⚠ delivery-check 硬门槛: DONE 前必须 spawn koala-review-delivery reviewer 写 delivery-check.json 签名。reviewer 逆向扫 git diff 验证文档承诺落地 + 真机测试覆盖。未签名 → story_advance DONE 会卡 [missing_delivery_check]。`,
        DONE: `→ 必须立即执行: 把下面的 Story 总结段落用你自己的话告诉用户（改了什么/怎么用/真机覆盖/限制/踩坑），然后 convergence_check 检查项目收敛状态
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
        // 改为从 git 实际状态推断：调用 cwd、git 顶层 worktree、当前分支、git common dir。
        // DONE 可从 worktree 子目录触发，所以 cleanup 目标必须是 git top-level，
        // 不能把 process.cwd() 当作可删除路径。
        const doneWorktree = detectDoneStoryWorktreeContext();

        if (doneWorktree) {
          const mergeLines: string[] = [];
          const { branch, mainRepoRoot, worktreeRoot: wtPathAbs } = doneWorktree;
          assertDoneStoryBranchMatches(args.storyId, branch);
          {
            const runGitArgs = (args: string[], cwd: string): string =>
              execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();

            // Step 1: 清 story.worktree 字段 + endedAt + writeStory，让 metadata 落盘
            story.worktree = undefined;
            story.endedAt = story.endedAt || new Date().toISOString();
            store.writeStory(args.storyId, story);

            // Step 2: commit 所有 story metadata（phase=DONE + worktree=undefined +
            // endedAt + reviewer/test 产物）。dev_merge:228 用的是同一招。
            try {
              runGitArgs(['add', store.storyDirRel()], wtPathAbs);
              const staged = runGitArgs(['diff', '--cached', '--name-only'], wtPathAbs);
              if (staged) {
                runGitArgs(
                  ['-c', 'commit.gpgsign=false', 'commit', '-m', `koala: mark ${args.storyId} DONE + clear worktree`],
                  wtPathAbs,
                );
              }
            } catch { /* PROBE: 没东西 commit 也无所谓 */ }

            // Step 2.5 (B-9d95 CHK-003): merge 前清 stray whitelist 文件。
            // F-020: 非白名单 offender 检测已提前到 DONE gate（phase 落盘前），
            // 这里只负责 whitelist 自动 rm；理论上 offender 不可能到这行（上面
            // 已 throw），但保留 throw 路径作为 defense-in-depth。第三参数
            // wtPathAbs 用于 error message 的 worktree 清理指引（F-014）。
            const strayReport = cleanStrayWorktreeFiles(mainRepoRoot, args.storyId, wtPathAbs);
            for (const line of strayReport) mergeLines.push(line);

            // Step 3: 从主仓库根目录 merge story 分支。merge 冲突直接 throw 给上层
            // 让 agent 看到详细的手动 cleanup 步骤——phase 已经是 DONE，不回滚，但
            // 必须让 user 知道还有手动收尾要做。
            const mainBranch = runGitArgs(['rev-parse', '--abbrev-ref', 'HEAD'], mainRepoRoot);
            try {
              runGitArgs(
                ['-c', 'commit.gpgsign=false', 'merge', branch, '--no-ff', '-m', `merge: ${args.storyId} ${story.title}`],
                mainRepoRoot,
              );
              mergeLines.push(`✓ 分支 ${branch} 已合并到 ${mainBranch}`);
            } catch (e: any) {
              throw new Error(
                `Story ${args.storyId} 已标记为 DONE 但自动合并失败:\n` +
                `${e.stderr?.toString() || e.message}\n\n` +
                `请手动完成:\n` +
                `  cd "${mainRepoRoot}"\n` +
                `  git merge ${branch}\n` +
                `  git worktree remove --force "${wtPathAbs}"\n` +
                `  git branch -d ${branch}`,
              );
            }

            // Step 4: 清理 worktree
            let cleanupFailure: string | null = null;
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
            if (existsSync(wtPathAbs) || isRegisteredWorktree(mainRepoRoot, wtPathAbs)) {
              const wasRegisteredWorktree = isRegisteredWorktree(mainRepoRoot, wtPathAbs);
              const repair = repairGlobalKoalaLinkBeforeWorktreeDelete(wtPathAbs, mainRepoRoot);
              if (repair.action === 'relinked') mergeLines.push(repair.message);
              let removeFailure: string | null = null;
              try {
                runGitArgs(['worktree', 'remove', wtPathAbs], mainRepoRoot);
                mergeLines.push(`✓ Worktree ${wtPathAbs} 已清理`);
              } catch {
                // worktree 内有 tmp/ llmlog 等运行时产物时 remove 会拒绝，用 --force
                try {
                  runGitArgs(['worktree', 'remove', '--force', wtPathAbs], mainRepoRoot);
                  mergeLines.push(`✓ Worktree ${wtPathAbs} 已强制清理`);
                } catch (e: any) {
                  removeFailure = `git worktree remove failed: ${e.message}`;
                  mergeLines.push(`⚠ Worktree 未清理: ${e.message}`);
                }
              }
              // Second step: rm -rf the directory if git left it behind.
              // This is the fix for "worktree folder still exists after
              // DONE merge" caused by activity.jsonl-style gitignored
              // leftovers from Claude Code hooks.
              if (existsSync(wtPathAbs)) {
                try {
                  assertSafeResidualWorktreeRm(doneWorktree, wtPathAbs, wasRegisteredWorktree);
                  rmSync(wtPathAbs, { recursive: true, force: true });
                  mergeLines.push(`✓ Worktree 目录残留已清空`);
                } catch (e: any) {
                  cleanupFailure = `worktree directory cleanup failed: ${e.message}`;
                  mergeLines.push(`⚠ Worktree 目录残留清理失败: ${e.message}`);
                }
              }
              try {
                pruneWorktreeRegistry(mainRepoRoot);
                if (removeFailure && !existsSync(wtPathAbs) && !isRegisteredWorktree(mainRepoRoot, wtPathAbs)) {
                  mergeLines.push(`✓ stale worktree registry 已 prune`);
                }
              } catch (e: any) {
                mergeLines.push(`⚠ git worktree prune 失败: ${e.message}`);
              }
              if (existsSync(wtPathAbs) && !cleanupFailure) {
                cleanupFailure = `worktree path still exists after cleanup: ${wtPathAbs}`;
              }
              if (isRegisteredWorktree(mainRepoRoot, wtPathAbs) && !cleanupFailure) {
                cleanupFailure = removeFailure || `worktree is still registered after cleanup: ${wtPathAbs}`;
                mergeLines.push(`⚠ Worktree 仍在 git registry 中: ${wtPathAbs}`);
              }
            }

            // Step 5: 删除分支
            try {
              runGitArgs(['branch', '-d', branch], mainRepoRoot);
              mergeLines.push(`✓ 分支 ${branch} 已删除`);
            } catch {
              mergeLines.push(`⚠ 分支 ${branch} 未删除（可能有未合并的提交）`);
            }

            if (cleanupFailure) {
              const err = new Error(cleanupFailure);
              reportHealthIssue('mutation:worktreeCleanup', err, {
                storyId: args.storyId,
                branch,
                worktreePath: wtPathAbs,
                mainRepoRoot,
              });
              throw new Error(
                `Story ${args.storyId} 已合并，但 worktree 清理未完成: ${cleanupFailure}\n` +
                `→ 请运行 koala doctor 查看，或执行 koala doctor --repair 清理终态 worktree 残留。`,
              );
            }
          }

          if (mergeLines.length > 0) {
            doneMergeReport = `\n\n${mergeLines.join('\n')}`;
          }

          // B-9bd9 CHK-003: DONE 合并成功后，尝试触发 framework audit。
          // maybeTriggerAudit 内部已 try/catch + meta-story guard + mode=off 兜底；
          // 此处再包一层防御，确保任何 audit-trigger 路径异常都不影响 DONE 成功消息。
          // projectRoot 用 mainRepoRoot（main 仓的根，不是已被清掉的 worktree）。
          try {
            const auditResult = await maybeTriggerAudit(args.storyId, mainRepoRoot);
            if (auditResult.hint) {
              // semi-auto 提示行：前后各空一行单独成段，avoid 和 mergeLines/docsHint 挤在一起
              doneMergeReport += `\n${auditResult.hint}`;
            }
          } catch (e: any) {
            console.warn(`[audit-trigger] DONE hook failed: ${e?.message || e}`);
          }
        }
      }

      // Baseline risk warning: show dirty/untracked files before worktree creation
      let baselineRiskWarning = '';
      if (args.phase === 'INIT_CHECK' && oldPhase === 'INIT') {
        try {
          const risk = collectBaselineRisk(ctx.root);
          if (risk.materialTotal > 0) {
            const lines = renderBaselineRiskLines(risk);
            baselineRiskWarning = `\n\n⚠ 基线风险（${risk.materialTotal} 个未提交文件可能污染 worktree）:\n${lines.map(l => '  ' + l).join('\n')}\n→ 建议先 git stash 或 git commit 后再创建 worktree`;
          }
        } catch { /* ignore */ }
      }

      // INIT→INIT_CHECK 成功后 echo non-blocking init reviewer issues。
      // critical/high 已在 gate 中阻塞；这里仅提示 medium/low。
      // 与 init_check_set 同标准 trim().length >= 1 校验 issue.desc，过滤空白串。
      let initCheckAdvisory = '';
      if (args.phase === 'INIT_CHECK' && oldPhase === 'INIT') {
        try {
          const initCheck = store.readInitCheck(args.storyId);
          if (initCheck) {
            const allIssues = Array.isArray(initCheck.agentResults) && initCheck.agentResults.length > 0
              ? initCheck.agentResults.flatMap(result => result.issues || [])
              : initCheck.issues || [];
            const advisoryCount = allIssues.filter(
              i => i && typeof i.desc === 'string' && i.desc.trim().length >= 1 && (i.severity === 'medium' || i.severity === 'low'),
            ).length;
            if (advisoryCount > 0) {
              initCheckAdvisory = `\n\n⚠ init reviewer 记录 ${advisoryCount} 个 medium/low advisory，建议在 PLAN 前消化`;
            }
          }
        } catch { /* ignore */ }
      }

      // B-a2f1 CHK-001/002: surface stale verificationEvidence in REVIEW/TEST/DONE
      // pre-check output so a main-merge that drifted materialHash does not
      // produce an opaque pass without naming the recovery commands.
      let staleEvidenceHint = '';
      if (newState === 'REVIEW' || newState === 'TEST' || newState === 'DONE') {
        try {
          const stale = findStaleEvidence(ctx.root, args.storyId);
          const hint = renderEvidenceStaleHint(args.storyId, stale, { currentHead: currentGitHead(ctx.root) });
          if (hint) staleEvidenceHint = `\n\n${hint}`;
        } catch { /* probe — never block phase advance on stale-hint failure */ }
      }

      return `${doneChecklistPrefix}Story ${args.storyId} advanced to ${newState}${metadataCommitReport}${doneMergeReport}\n${nextSteps[newState] || ''}${docsHint}${depsWarning}${sessionWarning}${doneSummarySuffix}${initCheckAdvisory}${baselineRiskWarning}${staleEvidenceHint}`;
    },
  };
}
