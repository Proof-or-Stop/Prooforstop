/**
 * validate-channel — CLI gate: structured normal-channel evidence check
 *
 * 校验正常通道是否有结构化执行证据：
 * - 快速通道（checklist ≤ 2 且 riskSignals 空）：跳过，返回 skipped
 * - 正常通道：优先要求每个非 main-agent Owner 的 checklist item 有 dispatch 或
 *   subagent_result process-event 证据。commit author 只作为 legacy fallback：
 *   当缺少 process-event 且全部实现 commit 均为 author == "koala-implementer"
 *   或 metadata-only koala commit 时才可通过。
 *
 * 输出结构：
 *   {
 *     provider: "koala-channel",
 *     status: "pass" | "fail" | "skipped",
 *     summary: string,
 *     details: string[],
 *     offenders?: Array<{ sha, author, subject }>,
 *   }
 *
 * 参考 docs/koala/reviewer-redesign.md §三 S1 第 1 条。
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StoryStore } from '../core/store.js';
import { DEFAULT_BASE } from './validate-shared.js';
import { computeChannel } from '../core/workflow-policy.js';
import { loadConfig } from '../core/config.js';
import { isStoryMetadataPath as isSharedStoryMetadataPath } from '../core/evidence-freshness.js';
import type { StoryInfo, ChecklistData, DecisionData, ProcessEvent } from '../core/types.js';

export interface ChannelOffender {
  sha: string;
  author: string;
  subject: string;
  files?: string[];
}

export interface ChannelCheckResult {
  provider: 'koala-channel';
  status: 'pass' | 'fail' | 'skipped';
  summary: string;
  details: string[];
  offenders?: ChannelOffender[];
  /**
   * F-003 (B-fdcf Round 1): 证据来源标签，供 renderChannelResult 输出
   * userSees 承诺的 `all CHK covered (via <source>)` 短语。
   * - 'subagent_result' — 全部通过 Agent() 直派路径（subagent_result 事件）
   * - 'dispatch'        — 全部通过 koala dispatch（dispatch 事件）
   * - 'dispatch + subagent_result' — 混合
   * - 'commit_author' — commit author=koala-implementer 作为直派 Agent 执行信号
   * 仅在 status=pass 且存在 evidencedItems 时设置；纯豁免 / 无 commit 等场景 undefined。
   */
  evidenceSource?: 'subagent_result' | 'dispatch' | 'dispatch + subagent_result' | 'commit_author';
}

/**
 * 读 git log 原始输出的回调，便于测试注入。
 * 默认实现 = execSync `git log <base>..<branch> --format=%H|%an|%s`。
 */
export type GitLogReader = (args: {
  base: string;
  branch: string;
  projectRoot: string;
}) => string;

export type GitChangedFilesReader = (args: {
  sha: string;
  projectRoot: string;
}) => string[];

const defaultGitLogReader: GitLogReader = ({ base, branch, projectRoot }) => {
  try {
    execSync(`git rev-parse --verify --quiet ${branch}`, { cwd: projectRoot, stdio: ['ignore', 'ignore', 'ignore'] });
  } catch {
    try {
      const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: projectRoot,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      execSync(`git merge-base --is-ancestor HEAD ${base}`, { cwd: projectRoot, stdio: ['ignore', 'ignore', 'ignore'] });
      if (currentBranch === base) return '';
    } catch {
      // Keep the original git log failure for non-main branches with a missing story ref.
    }
  }
  return execSync(
    `git log ${base}..${branch} "--format=%H|%an|%s"`,
    { cwd: projectRoot, encoding: 'utf-8' },
  );
};

const defaultGitChangedFilesReader: GitChangedFilesReader = ({ sha, projectRoot }) => {
  const raw = execSync(
    `git show --name-only --format= --no-renames ${sha}`,
    { cwd: projectRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
  return raw.split('\n').map(line => line.trim()).filter(Boolean);
};

/** 解析 `%H|%an|%s` 行，容忍 subject 中含 `|` */
export function parseGitLogLine(line: string): ChannelOffender | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const firstPipe = trimmed.indexOf('|');
  if (firstPipe < 0) return null;
  const sha = trimmed.slice(0, firstPipe);
  const rest = trimmed.slice(firstPipe + 1);
  const secondPipe = rest.indexOf('|');
  if (secondPipe < 0) return null;
  const author = rest.slice(0, secondPipe);
  const subject = rest.slice(secondPipe + 1);
  return { sha, author, subject };
}

/**
 * 正常通道判定。F-015 (B-9d95 Round 1 review): 改为与 workflow-policy.ts 的
 * computeChannel 口径一致，避免 3-5 item 无 riskSignals story 被误判 normal。
 *
 * computeChannel:
 *   express: items ≤ 2 且无 risk
 *   fast:    items ≤ 5 且无 risk 且单一解（decision.options ≤ 1 或无 decision）
 *   normal:  其他
 *
 * channel gate 只在 normal 通道启用。
 *
 * 保留旧的 2-arg 签名（itemCount + riskSignalCount）做 back-compat，行为
 * 调整为"无 decision 视作单一解 → ≤ 5 items 且无 risk → fast（非 normal）"，
 * 与 computeChannel(story, checklist, undefined) 结果一致。
 *
 * 新增 isNormalChannelWithStory(story, checklist, decision?) 做完整判定，
 * 让 checkCommitAuthor 传 decision 时 decision.options.length > 1 仍按 normal 判。
 */
export function isNormalChannel(opts: {
  itemCount: number;
  riskSignalCount: number;
}): boolean {
  // 构造最小的 computeChannel 输入。无 decision → computeChannel 视为单一解，
  // items ≤ 5 且无 risk → fast；> 5 或有 risk → normal。
  const stubStory = { riskSignals: Array.from({ length: opts.riskSignalCount }, () => ({ category: 'stub', matched: 'stub' })) };
  const stubChecklist = { items: Array.from({ length: opts.itemCount }, () => ({})) };
  return computeChannel(stubStory as unknown as StoryInfo, stubChecklist as unknown as ChecklistData, undefined) === 'normal';
}

/**
 * F-015: 带完整上下文的 normal 判定。检查点：
 *   - decision.options.length > 1 → 多解 → normal
 *   - 上面任一 normal 条件触发 → true
 * 若 decision 为 null/undefined，等价 isNormalChannel（单一解路径）。
 */
export function isNormalChannelWithStory(
  story: Pick<StoryInfo, 'riskSignals'> & Partial<Pick<StoryInfo, 'riskSignalsDismissed'>>,
  checklist: Pick<ChecklistData, 'items'>,
  decision?: Pick<DecisionData, 'options' | 'chosen'> | null,
): boolean {
  return computeChannel(story as StoryInfo, checklist as ChecklistData, decision) === 'normal';
}

/**
 * 判定单个 commit 是否可作为 legacy fallback。
 * - author == "koala-implementer" 通过
 * - subject 以 "koala:" 前缀且只触及 story metadata 时通过
 * - 否则不能作为 fallback；但若 dispatch/subagent_result 结构化证据完整，author 不再硬阻塞
 */
export function isStoryMetadataPath(file: string): boolean {
  return isSharedStoryMetadataPath(file);
}

export function isMetadataOnlyKoalaCommit(c: Pick<ChannelOffender, 'subject' | 'files'>): boolean {
  return /^\s*koala:/.test(c.subject)
    && Array.isArray(c.files)
    && c.files.length > 0
    && c.files.every(isStoryMetadataPath);
}

export function isAcceptableCommit(c: ChannelOffender): boolean {
  if (c.author === 'koala-implementer') return true;
  if (isMetadataOnlyKoalaCommit(c)) return true;
  return false;
}

/**
 * F-021 (B-fdcf CHK-003): 读 plan.md 抽出声明 `**Owner**: main-agent` 的 CHK-id 集合。
 * 解析规则：按 `^## (CHK-\d+)` 段落拆分，在每段内找第一行 `**Owner**: main-agent`
 * （宽松空白）。plan.md 不存在或解析失败 → 返回空集（fail-open，继续要求事件证据）。
 */
export type PlanReader = (storyId: string, projectRoot: string) => string | null;

const defaultPlanReader: PlanReader = (storyId, projectRoot) => {
  const config = loadConfig(projectRoot);
  const planPath = join(projectRoot, config.storyDir, storyId, 'plan.md');
  if (!existsSync(planPath)) return null;
  try {
    return readFileSync(planPath, 'utf-8');
  } catch {
    return null;
  }
};

export function parseMainAgentOwnedItems(planContent: string | null): Set<string> {
  const owned = new Set<string>();
  if (!planContent) return owned;
  const lines = planContent.split('\n');
  let currentChk: string | null = null;
  const headerRe = /^##\s+(CHK-\d+)\b/;
  const ownerRe = /^\s*\*\*Owner\*\*\s*:\s*(\S[^\n]*)/i;
  for (const line of lines) {
    const hm = headerRe.exec(line);
    if (hm) {
      currentChk = hm[1];
      continue;
    }
    if (!currentChk) continue;
    const om = ownerRe.exec(line);
    if (om) {
      // Owner 行匹配 main-agent（允许 "main-agent" / "main-agent | ..." 首位）
      const ownerValue = om[1].trim();
      // 取第一个 token（可能含 "|" 分隔替代项，main-agent 必须作为首选）
      const firstToken = ownerValue.split(/[\s|]+/)[0];
      if (firstToken === 'main-agent') {
        owned.add(currentChk);
      }
    }
  }
  return owned;
}

/**
 * F-021 (B-fdcf CHK-003): dispatch 证据判定。
 *
 * 每个 CHK-xxx 必须有证据：`dispatch` 事件 OR `subagent_result` 事件，按 checklistId / itemId 去重。
 * 若只有 subagent_result 且 success=false → 报 `dispatch 存在但 subagent 失败`。
 * plan.md 声明 `**Owner**: main-agent` 的 CHK 豁免。
 */
export interface DispatchEvidenceIssue {
  itemId: string;
  reason: 'missing_evidence' | 'subagent_failed';
  message: string;
}

export interface DispatchEvidenceResult {
  ok: boolean;
  issues: DispatchEvidenceIssue[];
  /** plan.md 豁免的 item id */
  exemptedItems: string[];
  /** 已找到证据的 item id（dispatch 或 success=true 的 subagent_result） */
  evidencedItems: string[];
  details: string[];
}

export function checkDispatchEvidence(opts: {
  checklist: Pick<ChecklistData, 'items'>;
  events: ProcessEvent[];
  mainAgentOwnedItems: Set<string>;
}): DispatchEvidenceResult {
  const { checklist, events, mainAgentOwnedItems } = opts;
  const items = checklist?.items ?? [];

  // 去重收集：每个 itemId 的证据集合
  type Evidence = { hasDispatch: boolean; successResult: boolean; failureResult: boolean };
  const byItem = new Map<string, Evidence>();
  const getOrInit = (id: string): Evidence => {
    let e = byItem.get(id);
    if (!e) {
      e = { hasDispatch: false, successResult: false, failureResult: false };
      byItem.set(id, e);
    }
    return e;
  };

  for (const ev of events) {
    if (ev.type === 'dispatch') {
      const id = (ev as any).checklistId ?? (ev as any).itemId;
      if (typeof id === 'string' && /^CHK-\d+$/.test(id)) {
        getOrInit(id).hasDispatch = true;
      }
    } else if (ev.type === 'subagent_result') {
      const id = (ev as any).checklistId ?? (ev as any).itemId;
      if (typeof id === 'string' && /^CHK-\d+$/.test(id)) {
        // F-013 (B-fdcf Round 1): ProcessEvent 是 index-signature 类型（[key]:unknown），
        // 消费 success 字段时窄化到 boolean | undefined，避免 as any 丢类型。
        const success = ev.success as boolean | undefined;
        if (success === false) getOrInit(id).failureResult = true;
        else getOrInit(id).successResult = true;
      }
    }
  }

  const issues: DispatchEvidenceIssue[] = [];
  const exemptedItems: string[] = [];
  const evidencedItems: string[] = [];

  for (const item of items) {
    // F-012 (B-fdcf Round 1): ChecklistItem.id 已是 string，无需 as any 强转
    const id = item.id;
    if (!id) continue;
    if (mainAgentOwnedItems.has(id)) {
      exemptedItems.push(id);
      continue;
    }
    const ev = byItem.get(id);
    const hasAnyEvidence = !!ev && (ev.hasDispatch || ev.successResult || ev.failureResult);
    if (!hasAnyEvidence) {
      issues.push({
        itemId: id,
        reason: 'missing_evidence',
        message: `channel gate fail: ${id} 无 dispatch/subagent_result 证据`,
      });
      continue;
    }
    // F-006 (B-fdcf Round 1): 根据 dispatch 是否存在分别报不同文案
    //   !hasDispatch && failureResult && !successResult → subagent 失败且无 dispatch 证据
    //    hasDispatch && failureResult && !successResult → dispatch 存在但 subagent 失败
    if (ev && ev.failureResult && !ev.successResult) {
      const message = ev.hasDispatch
        ? `channel gate fail: ${id} dispatch 存在但 subagent 失败`
        : `channel gate fail: ${id} subagent 失败且无 dispatch 证据`;
      issues.push({
        itemId: id,
        reason: 'subagent_failed',
        message,
      });
      continue;
    }
    // 两者都有 / 只有 dispatch / 只有成功 result → 通过（即便 failureResult=true 但有成功记录，视为重试成功）
    evidencedItems.push(id);
  }

  const details: string[] = [];
  if (exemptedItems.length > 0) {
    details.push(`plan.md Owner=main-agent 豁免: ${exemptedItems.join(', ')}`);
  }
  if (evidencedItems.length > 0) {
    details.push(`已覆盖: ${evidencedItems.join(', ')}`);
  }
  for (const iss of issues) {
    details.push(iss.message);
  }

  return {
    ok: issues.length === 0,
    issues,
    exemptedItems,
    evidencedItems,
    details,
  };
}

export interface CheckCommitAuthorDeps {
  store: StoryStore;
  projectRoot: string;
  gitLogReader?: GitLogReader;
  gitChangedFilesReader?: GitChangedFilesReader;
  base?: string;
  /** F-021: test injection for reading plan.md */
  planReader?: PlanReader;
}

/**
 * 核心入口：读 story → 判定通道 → 跑 git log → 输出结构化结果。
 * story 不存在 → 结构化 fail。
 */
export function checkCommitAuthor(
  storyId: string,
  deps: CheckCommitAuthorDeps,
): ChannelCheckResult {
  const {
    store,
    projectRoot,
    gitLogReader = defaultGitLogReader,
    gitChangedFilesReader = defaultGitChangedFilesReader,
    base = DEFAULT_BASE,
    planReader = defaultPlanReader,
  } = deps;

  // story 存在性校验
  if (!store.storyExists(storyId)) {
    return {
      provider: 'koala-channel',
      status: 'fail',
      summary: `story not found: ${storyId}`,
      details: [`${store.storyDirRel()}/${storyId}/index.json does not exist`],
    };
  }

  let story;
  try {
    story = store.readStory(storyId);
  } catch (e: any) {
    return {
      provider: 'koala-channel',
      status: 'fail',
      summary: `failed to read story: ${storyId}`,
      details: [String(e?.message ?? e)],
    };
  }

  let checklist;
  try {
    checklist = store.readChecklist(storyId);
  } catch (e: any) {
    return {
      provider: 'koala-channel',
      status: 'fail',
      summary: `failed to read checklist: ${storyId}`,
      details: [String(e?.message ?? e)],
    };
  }

  const itemCount = checklist?.items?.length ?? 0;
  const riskSignalCount = story.riskSignals?.length ?? 0;
  // F-015: 若存在 decision.json，其 options.length > 1 也会让 computeChannel 判 normal
  let decision: Pick<DecisionData, 'options' | 'chosen'> | null = null;
  try {
    decision = store.readDecision(storyId);
  } catch { decision = null; }
  const normal = isNormalChannelWithStory(story, checklist, decision);

  if (!normal) {
    return {
      provider: 'koala-channel',
      status: 'skipped',
      summary: '非正常通道不检查 normal-channel dispatch/subagent evidence',
      details: [
        `story=${storyId}`,
        `checklist items=${itemCount} & riskSignals=${riskSignalCount} → channel=express/fast`,
      ],
    };
  }

  // 跑 git log
  const branch = `story/${storyId}`;
  let raw: string;
  try {
    raw = gitLogReader({ base, branch, projectRoot });
  } catch (e: any) {
    return {
      provider: 'koala-channel',
      status: 'fail',
      summary: `git log failed for ${base}..${branch}`,
      details: [String(e?.message ?? e)],
    };
  }

  const commits = raw
    .split('\n')
    .map(parseGitLogLine)
    .filter((c): c is ChannelOffender => c !== null)
    .map((c) => {
      try {
        return { ...c, files: gitChangedFilesReader({ sha: c.sha, projectRoot }) };
      } catch {
        return c;
      }
    });

  const offenders = commits.filter((c) => !isAcceptableCommit(c));

  // F-021 (B-fdcf CHK-003): dispatch 证据检查。事件源 = dispatch ∪ subagent_result，
  // plan.md 声明 `**Owner**: main-agent` 的 CHK 豁免。解析失败 fail-open 继续要求事件。
  let events: ProcessEvent[] = [];
  try {
    events = store.readProcessEvents(storyId);
  } catch { events = []; }
  const planContent = planReader(storyId, projectRoot);
  const ownedByMain = parseMainAgentOwnedItems(planContent);
  const evidence = checkDispatchEvidence({
    checklist,
    events,
    mainAgentOwnedItems: ownedByMain,
  });

  // 无 commit 的边界：author 检查通过。证据检查仍然要跑——normal channel 无 commit 也应有 dispatch/subagent_result 记录
  // 但为保持 back-compat（历史测试 "no commits → pass"），当 commits 为 0 时也跳过证据检查。
  if (commits.length === 0) {
    return {
      provider: 'koala-channel',
      status: 'pass',
      summary: `no commits between ${base} and ${branch}`,
      details: [`正常通道 story=${storyId}，但 ${base}..${branch} 无新增 commit`],
    };
  }

  const itemIds = (checklist?.items ?? []).map(item => item.id).filter(Boolean);
  const allItemsOwnedByMain = itemIds.length > 0 && itemIds.every(id => ownedByMain.has(id));
  const authorFallbackOk = offenders.length === 0 || allItemsOwnedByMain;
  const hasImplementerCommit = commits.some(c => c.author === 'koala-implementer');
  const structuredEvidenceOk = evidence.ok;
  const authorEvidenceCoversMissing = authorFallbackOk
    && !evidence.ok
    && hasImplementerCommit
    && evidence.issues.length > 0
    && evidence.issues.every(issue => issue.reason === 'missing_evidence');

  if (structuredEvidenceOk || authorEvidenceCoversMissing) {
    // F-003 (B-fdcf Round 1): 判定 evidenceSource 标签，供 renderChannelResult 嵌入
    // userSees 承诺的 "all CHK covered (via <source>)" 短语。扫 events 判断每个
    // evidencedItems 的证据来源：只看 dispatch → dispatch；只看 subagent_result → subagent_result；
    // 同时看到 → dispatch + subagent_result。纯豁免（evidencedItems 空）时不设。
    let evidenceSource: ChannelCheckResult['evidenceSource'] | undefined;
    if (authorEvidenceCoversMissing) {
      evidenceSource = 'commit_author';
    } else if (evidence.evidencedItems.length > 0) {
      let anyDispatch = false;
      let anySubagent = false;
      const evidencedSet = new Set(evidence.evidencedItems);
      for (const ev of events) {
        const id = (ev as any).checklistId ?? (ev as any).itemId;
        if (typeof id !== 'string' || !evidencedSet.has(id)) continue;
        if (ev.type === 'dispatch') anyDispatch = true;
        else if (ev.type === 'subagent_result') anySubagent = true;
      }
      if (anyDispatch && anySubagent) evidenceSource = 'dispatch + subagent_result';
      else if (anyDispatch) evidenceSource = 'dispatch';
      else if (anySubagent) evidenceSource = 'subagent_result';
    }
    const summary = allItemsOwnedByMain && offenders.length > 0
      ? `正常通道：${commits.length} 条 commit 由 plan.md Owner=main-agent 明确豁免；dispatch/subagent_result 证据覆盖完整`
      : authorEvidenceCoversMissing
        ? `正常通道：${commits.length} 条 commit 全部由 koala-implementer 或 metadata-only koala CLI 产出；commit author 作为直派执行证据`
        : offenders.length > 0
          ? `正常通道：dispatch/subagent_result 结构化证据覆盖完整；commit author 仅作辅助信号`
          : `正常通道：${commits.length} 条 commit 全部由 koala-implementer 或 metadata-only koala CLI 产出；dispatch/subagent_result 证据覆盖完整`;
    return {
      provider: 'koala-channel',
      status: 'pass',
      summary,
      details: [
        ...commits.map((c) => `${c.sha.slice(0, 7)} ${c.author} — ${c.subject}`),
        ...(structuredEvidenceOk && offenders.length > 0
          ? [
              `commit author advisory: ${offenders.length} 条非 koala-implementer commit 已由结构化 dispatch/subagent_result 证据覆盖`,
              ...offenders.map((c) => `  advisory ${c.sha.slice(0, 7)} ${c.author} — ${c.subject}`),
            ]
          : []),
        ...(allItemsOwnedByMain && offenders.length > 0
          ? ['plan.md Owner=main-agent author 豁免: all checklist items']
          : []),
        ...(authorEvidenceCoversMissing
          ? ['commit author=koala-implementer fallback: no dispatch/subagent_result process event required for direct Agent execution']
          : []),
        ...evidence.details,
      ],
      evidenceSource,
    };
  }

  // 聚合失败信息
  const failDetails: string[] = [];
  const summaryParts: string[] = [];
  if (!evidence.ok) {
    summaryParts.push(`${evidence.issues.length} 个 CHK 缺 dispatch/subagent_result 证据`);
    for (const d of evidence.details) failDetails.push(d);
  }
  if (!authorFallbackOk) {
    summaryParts.push(`${offenders.length}/${commits.length} 条 commit 不能作为 author fallback`);
    failDetails.push('commit author 只作为 legacy fallback；正常通道主证据必须是 dispatch/subagent_result process-event');
    failDetails.push('author fallback 仅接受 author="koala-implementer" 或 metadata-only subject="koala:*" commit');
    failDetails.push('offenders:');
    for (const c of offenders) {
      failDetails.push(`  ${c.sha.slice(0, 7)} ${c.author} — ${c.subject}`);
    }
  }

  return {
    provider: 'koala-channel',
    status: 'fail',
    summary: `正常通道 gate 失败：${summaryParts.join('；')}`,
    details: failDetails,
    offenders: authorFallbackOk ? undefined : offenders,
  };
}

/**
 * B-9d95 CHK-006: CLI entry for `koala validate --channel`.
 *
 * 不 spawn pytest / 不跑全量 validate.ts——直接调 checkCommitAuthor，输出
 * 结构化结果 + 人类可读渲染。用于 REVIEW→TEST preflight 独立分流。
 *
 * 返回:
 *   - ok: true 当 status ∈ {pass, skipped}
 *   - result: ChannelCheckResult（完整结构）
 *   - rendered: 人类可读多行字符串（供 stdout 直接打印）
 */
export interface ChannelCliResult {
  ok: boolean;
  result: ChannelCheckResult;
  rendered: string;
}

export function runChannelGateCli(
  storyId: string | undefined,
  deps: CheckCommitAuthorDeps,
): ChannelCliResult {
  if (!storyId || storyId.trim().length === 0) {
    const fail: ChannelCheckResult = {
      provider: 'koala-channel',
      status: 'fail',
      summary: 'validate --channel 需要 --story=B-xxx 参数',
      details: ['缺少 storyId：请使用 --story=<id> 或 --channel=<id>'],
    };
    return {
      ok: false,
      result: fail,
      rendered: renderChannelResult(fail),
    };
  }
  const result = checkCommitAuthor(storyId, deps);
  const ok = result.status === 'pass' || result.status === 'skipped';
  return { ok, result, rendered: renderChannelResult(result) };
}

/** 渲染 ChannelCheckResult 为人类可读文本 */
export function renderChannelResult(r: ChannelCheckResult): string {
  const lines: string[] = [];
  const icon = r.status === 'pass' ? '✓' : r.status === 'skipped' ? '·' : '✗';
  // F-003 (B-fdcf Round 1): pass 分支追加 userSees 承诺的
  // `all CHK covered (via <evidenceSource>)` 短语。evidenceSource 未设（例如
  // 纯豁免 / 无 commit 边界）时省略，保留原前缀。
  let summary = r.summary;
  if (r.status === 'pass' && r.evidenceSource) {
    summary = `${summary} — all CHK covered (via ${r.evidenceSource})`;
  }
  lines.push(`[channel] ${icon} ${r.status}: ${summary}`);
  for (const d of r.details) lines.push(`  ${d}`);
  return lines.join('\n');
}
