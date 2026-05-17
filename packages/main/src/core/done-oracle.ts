/**
 * B-37e9 DONE Oracle Extraction: buildDoneChecklist + DONE row assembly.
 *
 * This module is the single source of truth for the DONE gate checklist.
 * Both the DONE gate (handlers/phase-gates.ts, reached via
 * handlers/transition-orchestrator.ts) and the session_brief DONE pre-check
 * (handlers/session.ts) consume buildDoneChecklist from here — a same-source
 * contract test (tasks/flow-stability-smoke.ts) proves they render
 * byte-identical rows for the same story state.
 *
 * The function bodies were mechanically relocated from story-advance.ts with
 * zero semantic change — row order, status, blocking, and label logic are
 * byte-identical. This module must NOT import from handlers/story-advance.js
 * (no circular import — preMortem #2).
 */

import { execFileSync, execSync } from 'child_process';
import type { ChecklistData } from './types.js';
import type { StoryStore } from './store.js';
import { loadConfig } from './config.js';
import { resolveWorkflowPolicy } from './workflow-policy.js';
import { evaluateDeclaredArtifactReferences } from './declared-artifact-gate.js';
import {
  evaluateDeclaredArtifactCommitState,
  gitDeclaredArtifactPathState,
  describeDeclaredArtifactCommitStatus,
} from './declared-artifact-commit-check.js';
import type { OracleRow } from './oracle-row.js';
import {
  classifyGitStatusRows,
  dirtyWorktreeClassifierOptionsForStory,
  dirtyWorktreeClassifierOptionsFromConfig,
  renderDirtyWorktreeGroups,
} from './dirty-worktree.js';
import { defaultAuditWriter, evaluateDirtyGate, type DirtyGateName, type EvaluateDirtyGateResult } from './dirty-gate-policy.js';
import { checkEvidenceFreshnessForGit } from './evidence-freshness.js';
import { recomputeDeliveryCheckHash } from './delivery-check-hash.js';
import {
  summarizeCodexEvidence,
  storyRequiresCodexEvidence,
} from './codex-adapter-checks.js';

// B-c622 CHK-004: DONE 阶段自动同步 main —— detect divergence + auto merge main

/** Check how many commits main has that the current branch doesn't. */
export function checkMainDivergence(projectRoot: string): { behind: number; needsSync: boolean } {
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

// Task B-6326: DONE gate dirty output uses the shared ownership classifier.
// Task B-cf60: when a storyId/store is available, mix in declaredArtifactPaths from the
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

// Task B-4b22: dirty git-working-tree row uses the shared dirty-gate-policy
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
    // Task B-4b22: evaluate via shared policy; status follows allPass.
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

  // 6c. declared-artifacts committed (B-8db9 CHK-003): declared_artifact_changes
  //     is blocking:false in dirty-gate-policy so an uncommitted declared
  //     artifact passes the DONE dirty gate — but `git merge` does not carry
  //     uncommitted files into main, so the declared deliverable vanishes
  //     silently. This DONE-only row requires every declared path to be
  //     committed-and-clean or absent. It does NOT touch dirty-gate-policy —
  //     REVIEW/TEST keep treating declared_artifact_changes as non-blocking.
  {
    const declaredForCommit = store.readDeclaredArtifacts(storyId);
    const declaredPaths = declaredForCommit.entries
      .map((e) => (typeof e?.path === 'string' ? e.path.trim() : ''))
      .filter((p) => p.length > 0);
    if (declaredPaths.length === 0) {
      rows.push(doneCheckRow({
        id: 'declared-artifacts-committed',
        status: 'pass',
        label: 'declared artifacts committed',
        detail: '0/0 (no declarations)',
        source: 'declared-artifacts.json',
        blocking: false,
      }));
    } else {
      const commitResult = evaluateDeclaredArtifactCommitState(
        declaredPaths,
        (path) => gitDeclaredArtifactPathState(root, path),
      );
      if (commitResult.blockers.length > 0) {
        const uncommitted = commitResult.blockers
          .filter((b) => b.status !== 'git-ignored')
          .map((b) => b.path);
        const ignored = commitResult.blockers
          .filter((b) => b.status === 'git-ignored')
          .map((b) => b.path);
        const hintLines: string[] = [];
        if (uncommitted.length > 0) {
          hintLines.push(
            `[uncommitted_declared_artifact] 下列 declared artifact 未提交，git merge 不会带进 main：`,
            ...uncommitted.map((p) => `  ${p}`),
            '→ 如果它是交付物，请 commit；如果它是临时产出，请删除并移除该声明（artifact_declare 只声明真正要交付的生成物）。',
          );
        }
        if (ignored.length > 0) {
          hintLines.push(
            `[gitignored_declared_artifact] 下列 declared artifact 被 .gitignore 忽略，永远无法提交：`,
            ...ignored.map((p) => `  ${p}`),
            '→ git-ignored 路径不能声明为交付物（git-ignored paths must not be declared as deliverable artifacts）；请改声明一个可提交的路径，或移除该声明。',
          );
        }
        const detailParts = commitResult.blockers
          .map((b) => `${b.path} [${describeDeclaredArtifactCommitStatus(b.status)}]`);
        rows.push(doneCheckRow({
          id: 'declared-artifacts-committed',
          status: 'fail',
          label: 'declared artifacts committed',
          detail: `${commitResult.ok}/${commitResult.total} (uncommitted: ${detailParts.join(', ')})`,
          hint: hintLines.join('\n'),
          source: 'declared-artifacts.json',
        }));
      } else {
        rows.push(doneCheckRow({
          id: 'declared-artifacts-committed',
          status: 'pass',
          label: 'declared artifacts committed',
          detail: `${commitResult.ok}/${commitResult.total}`,
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

export function renderDoneChecklist(storyId: string, rows: DoneCheckRow[]): string {
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
