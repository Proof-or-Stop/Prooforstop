/**
 * audit-trigger — DONE 推进后的「每 N 个 story + CLAUDE.md 有 diff」双条件
 * 触发逻辑（B-9bd9 CHK-003）。
 *
 * 职责：
 *   - 读写 `<projectRoot>/.koala/runtime/framework-audit/state.json`（字段见 AuditState）
 *   - 递增 doneSinceLastAudit 计数
 *   - 按 config（CHK-004 的 resolveAuditConfig）判定是否触发 audit
 *   - semi-auto → 只返回提示文本（不 spawn agent）；full-auto → 同进程直接跑 audit handler
 *
 * **meta-story 免触发**：storyId.startsWith('B-META-') → 直接返回 triggered=false，
 * 既不递增计数也不跑 audit（避免 audit-meta-story 自己 DONE 时嵌套）。
 *
 * **字段所有权分工**（与 audit.ts 的 touchAuditState 协作）：
 *   - audit-trigger 只管 `doneSinceLastAudit` 计数
 *   - audit handler（audit.ts）跑完后刷 `lastAuditAt` 等其他字段
 *   - full-auto 下，audit handler 会在同进程里把计数重置（通过它自己的 touchAuditState）
 *
 * 设计硬规则：整个函数外层包 try/catch，任何异常 → console.warn + 返回
 * {triggered:false, reason:"error:..."}，**绝不抛出**。DONE hook 永远不受 audit 触发影响。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { resolveAuditConfig, type AuditMode } from './audit-config.js';
import { loadConfig } from './config.js';
import type { WorkflowProfile } from './types.js';

/**
 * state.json schema.
 *
 * - `lastAuditAt`: 上次 audit 跑完的 ISO 时间（由 audit handler 刷）
 * - `lastAuditCommit`: 上次 audit 对应的 commit SHA（git log --since 的基准；暂由 audit handler 管理）
 * - `doneSinceLastAudit`: 上次 audit 后 DONE 过多少 story（本模块维护）
 * - `lastAuditStoryId`: 上次触发 audit 的 story id（由 audit handler 刷）
 */
export interface AuditState {
  lastAuditAt: string | null;
  lastAuditCommit: string | null;
  doneSinceLastAudit: number;
  lastAuditStoryId: string | null;
}

export interface AuditTriggerResult {
  triggered: boolean;
  /** 人类可读的触发/未触发原因（主要给调用方 console.log / stderr 输出用） */
  reason: string;
  /** 提示文本（semi-auto 才有；semi-auto 下调用方应 console.log 显示它） */
  hint?: string;
  /** 写回后的 state（调试/测试用）；error 分支可能是初始值 */
  stateAfter: AuditState;
}

const INITIAL_STATE: AuditState = {
  lastAuditAt: null,
  lastAuditCommit: null,
  doneSinceLastAudit: 0,
  lastAuditStoryId: null,
};

/**
 * state.json 相对 projectRoot 的位置。
 * Mutable trigger state lives under ignored `.koala/runtime/`, deliberately
 * not the legacy `.koala/framework-audit/state.json` path. Some repos tracked
 * that old path before `.koala/` became runtime-only, so writing there made
 * read/status verification appear dirty.
 * 单一真相源：audit.ts 的 touchAuditState 也 import 此函数，避免路径双重硬编码。
 */
export function stateFilePath(projectRoot: string): string {
  return join(projectRoot, '.koala', 'runtime', 'framework-audit', 'state.json');
}

/**
 * 读 state.json。
 *   - 文件不存在 → INITIAL_STATE（不写盘）
 *   - JSON.parse 失败 / 不是对象 → warn + 重写 INITIAL_STATE + 返回
 *   - 字段缺失 → 用 INITIAL_STATE 的字段兜底
 */
function readState(projectRoot: string): AuditState {
  const path = stateFilePath(projectRoot);
  if (!existsSync(path)) return { ...INITIAL_STATE };

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    console.warn(`[audit-trigger] failed to read ${path}: ${(err as Error).message}. Resetting state.`);
    writeStateSafe(projectRoot, INITIAL_STATE);
    return { ...INITIAL_STATE };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[audit-trigger] corrupt state.json (${(err as Error).message}). Resetting to initial state.`);
    writeStateSafe(projectRoot, INITIAL_STATE);
    return { ...INITIAL_STATE };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn(`[audit-trigger] state.json not an object. Resetting to initial state.`);
    writeStateSafe(projectRoot, INITIAL_STATE);
    return { ...INITIAL_STATE };
  }

  const obj = parsed as Record<string, unknown>;
  return {
    lastAuditAt: typeof obj.lastAuditAt === 'string' ? obj.lastAuditAt : null,
    lastAuditCommit: typeof obj.lastAuditCommit === 'string' ? obj.lastAuditCommit : null,
    doneSinceLastAudit: typeof obj.doneSinceLastAudit === 'number' && Number.isFinite(obj.doneSinceLastAudit)
      ? obj.doneSinceLastAudit
      : 0,
    lastAuditStoryId: typeof obj.lastAuditStoryId === 'string' ? obj.lastAuditStoryId : null,
  };
}

function writeStateSafe(projectRoot: string, state: AuditState): void {
  const path = stateFilePath(projectRoot);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  } catch (err) {
    console.warn(`[audit-trigger] failed to write ${path}: ${(err as Error).message}`);
  }
}

/**
 * `git log --since=<from> -- CLAUDE.md 'packages/**\/CLAUDE.md'` 有输出？
 *
 * - `lastAuditCommit` 存在 → `--since=<ISO timestamp of that commit's author date>`，
 *   简化起见当前实现按「state.lastAuditAt ?? 30 天前」做时间窗口
 *   （commit SHA 作为时间锚点待 audit handler 写入后才好用；当前 semi-auto 下 commit 锚点可能为 null）
 * - 任何 git 调用失败 → 视为"无 diff"（保守：不触发提示比误触发更克制）
 *
 * MVP 接受 limitation：semi-auto 模式下若用户持续忽略 audit 提示，state.lastAuditAt
 * 永远是 null，兜底 30 天窗口可能漏检距上次 audit 紧邻（>30 天前）发生的 CLAUDE.md
 * 改动。后续可用 state.lastAuditCommit（commit SHA）替换时间窗口，彻底消除该 limitation。
 */
function claudeMdChangedSince(projectRoot: string, sinceIso: string | null): boolean {
  const since = sinceIso ?? thirtyDaysAgoIso();
  try {
    const out = execSync(
      `git log --since="${since}" --pretty=format:"%H" -- CLAUDE.md 'packages/**/CLAUDE.md'`,
      { cwd: projectRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 },
    ).trim();
    return out.length > 0;
  } catch {
    // git 不可用 / 非 git 仓库 → 保守返回 false
    return false;
  }
}

function thirtyDaysAgoIso(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString();
}

/** 提示文本统一生成（前后各空一行单独成段）。 */
function buildSemiAutoHint(window: number): string {
  return `\n⚠ ${window} story 窗口 + CLAUDE.md 已改动，建议跑: koala audit --framework\n`;
}

/**
 * maybeTriggerAudit — DONE 推进成功后调用。
 *
 * 正常流程：
 *   1. meta-story → no-op
 *   2. 读 state（损坏自动重建）
 *   3. 读 config（audit mode / window / requireClaudeMdDiff）
 *   4. doneSinceLastAudit++ 写回（注意：mode=off 也刷，以便将来 off→on 切换时计数连续）
 *   5. mode=off → 返回 triggered=false
 *   6. 未达窗口 → 返回 triggered=false
 *   7. requireClaudeMdDiff + 无 CLAUDE.md diff → 返回 triggered=false
 *   8. 触发：
 *      - semi-auto：返回带 hint 的 triggered=true（**不**清计数——用户忽略提示下次还会继续提示）
 *      - full-auto：同进程调 audit handler，返回 triggered=true（audit handler 负责刷 state 其他字段）
 *
 * 任何异常都被外层 try/catch 吞掉，返回 triggered=false + reason。
 */
export async function maybeTriggerAudit(storyId: string, projectRoot: string): Promise<AuditTriggerResult> {
  try {
    // 1. meta-story 免触发（含计数——避免嵌套）
    //    直接返回 INITIAL_STATE 拷贝，不读磁盘——避免 readState 内部异常（如磁盘损坏）
    //    逃出外层 catch 影响 DONE 流程。meta-story 路径不关心 state 真实内容。
    if (storyId.startsWith('B-META-')) {
      return {
        triggered: false,
        reason: 'meta-story advancement ignored',
        stateAfter: { ...INITIAL_STATE },
      };
    }

    // 2. 读 state（损坏会自愈 + 返回初始值）
    const prev = readState(projectRoot);

    // 3. 读 config
    const cfg = loadConfig(projectRoot);
    const profile: WorkflowProfile = cfg.workflow?.profile ?? 'balanced';
    const auditCfg = resolveAuditConfig(profile, projectRoot);

    // 4. 递增 doneSinceLastAudit 并持久化
    const bumped: AuditState = {
      ...prev,
      doneSinceLastAudit: prev.doneSinceLastAudit + 1,
    };
    writeStateSafe(projectRoot, bumped);

    const mode: AuditMode = auditCfg.mode;

    // 5. mode=off → 只刷计数不触发
    if (mode === 'off') {
      return { triggered: false, reason: 'mode=off', stateAfter: bumped };
    }

    // 6. 未达窗口
    if (bumped.doneSinceLastAudit < auditCfg.auditTriggerWindow) {
      return {
        triggered: false,
        reason: `window-not-met (${bumped.doneSinceLastAudit}/${auditCfg.auditTriggerWindow})`,
        stateAfter: bumped,
      };
    }

    // 7. requireClaudeMdDiff：git log 检测
    if (auditCfg.requireClaudeMdDiff) {
      const changed = claudeMdChangedSince(projectRoot, prev.lastAuditAt);
      if (!changed) {
        return {
          triggered: false,
          reason: 'no CLAUDE.md diff',
          stateAfter: bumped,
        };
      }
    }

    // 8. 触发
    if (mode === 'semi-auto') {
      // 只提示，不 spawn；保持计数不清，下次还会继续提示直到用户真跑 audit
      const hint = buildSemiAutoHint(bumped.doneSinceLastAudit);
      return {
        triggered: true,
        reason: 'semi-auto hint printed',
        hint,
        stateAfter: bumped,
      };
    }

    if (mode === 'full-auto') {
      return await runAuditInProcess(storyId, projectRoot, bumped);
    }

    // 理论上 resolveAuditConfig 已把非法 mode 规整，这里兜底
    return { triggered: false, reason: `unknown mode: ${mode}`, stateAfter: bumped };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[audit-trigger] error in maybeTriggerAudit: ${msg}`);
    return {
      triggered: false,
      reason: `error: ${msg}`,
      stateAfter: { ...INITIAL_STATE },
    };
  }
}

/**
 * full-auto 分支：同进程调 audit handler（CHK-001 交付）。
 *
 * audit handler 自己会 touchAuditState 刷 lastAuditAt；此处不重复刷。
 * 任何异常都吞掉（audit handler 内部已是 advisory）。
 *
 * 实现说明：用 ESM 顶层 `await import(...)` 做运行时动态 load。
 *   - 不用 `require('node:module')` + createRequire：ESM 模块里没有全局 require，
 *     在 strict ESM 环境下会抛 ReferenceError（F-001/F-014 根因）。
 *   - 取舍：CLAUDE.md「core/ 不做 I/O」约束在纯代码静态依赖层面；动态 import 仍会走
 *     handlers 层，但发生在 runtime 边界，静态 import graph 依然是 core→core。我们接受
 *     这个取舍——full-auto 是显式选择的「DONE 同进程跑 audit」模式，必须触达 handlers。
 */
async function runAuditInProcess(_storyId: string, projectRoot: string, state: AuditState): Promise<AuditTriggerResult> {
  try {
    const { createAuditHandlers } = await import('../handlers/audit.js');
    const { StoryStore } = await import('./store.js');

    const store = new StoryStore(projectRoot);
    const handlers = createAuditHandlers({
      store,
      root: projectRoot,
      scanRoot: projectRoot,
    });
    handlers.audit({ framework: true });

    return {
      triggered: true,
      reason: 'full-auto executed',
      stateAfter: state,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[audit-trigger] full-auto audit failed: ${msg}`);
    return {
      triggered: false,
      reason: `error: full-auto ${msg}`,
      stateAfter: state,
    };
  }
}

/**
 * 测试友好：导出内部纯函数别名，方便单测直接验证状态读写。
 * （只用于 test，不期望业务代码调。）
 */
export const _internal = {
  readState,
  writeStateSafe,
  stateFilePath,
  claudeMdChangedSince,
  INITIAL_STATE,
};
