/**
 * koala audit — 框架自省 audit（B-9bd9 CHK-001，MVP）
 *
 * 机械扫 CLAUDE.md / packages/koala/CLAUDE.md 承诺 vs 实际 CLI 行为 drift。
 *
 * 当前只支持 `--framework` 一档（未来可加 `--code` / `--schema` 等）。
 *
 * 流程：
 *   1. mode=off → print + 退出
 *   2. 读两份 CLAUDE.md
 *   3. ensureMetaStory（幂等）+ beginRound（下一轮）
 *   4. 跑 scanner → upsertDrift（new / still-drifting）
 *   5. autoResolveMissing（本轮未见 → resolved-by-nature）
 *   6. 生成 report.md 到 docs/koala/framework-audit/YYYY-MM-DD/report.md
 *   7. touchAuditState：只更新 state.json 的 lastAuditAt（其他字段 CHK-003 管）
 *   8. 打印 summary 行
 *
 * 全流程 advisory：不调 finding_add 到活动 story；不抛错；不卡 gate。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { HandlerContext } from './context.js';
import { resolveAuditConfig, type AuditConfig, type AuditMode } from '../core/audit-config.js';
import { loadConfig } from '../core/config.js';
import type { WorkflowProfile } from '../core/types.js';
import {
  ensureMetaStory,
  beginRound,
  recordRound,
  upsertDrift,
  autoResolveMissing,
  driftHash,
  META_STORY_ID,
} from '../core/audit-meta-store.js';
import { runMechanicalAudit, type DriftCandidate, type SkippedEntry } from '../core/audit-scan.js';
import { stateFilePath } from '../core/audit-trigger.js';

export interface AuditArgs {
  framework?: boolean;
  mode?: AuditMode; // CLI 可覆盖配置默认
}

export interface AuditResult {
  status: 'disabled' | 'completed';
  mode?: AuditMode;
  round?: number;
  newCount?: number;
  stillDriftingCount?: number;
  resolvedCount?: number;
  skippedCount?: number;
  reportPath?: string;
}

/**
 * audit handler 的具名返回类型。用交集类型结合具名字段 + registerBatch 要求的
 * index signature：具名字段 `audit` 保留参数/返回值类型约束（F-002），索引
 * 签名让 createAuditHandlers 的返回能喂给 registerBatch(map: Record<string, HandlerFn>)。
 */
export type AuditHandlers = {
  audit(args?: AuditArgs): string | AuditResult;
} & Record<string, (...args: any[]) => any>;

/**
 * 一条 audit drift 行（rowsNew / rowsStill / ReportInputs 共用）：
 * 原始 DriftCandidate 扩展上「本轮状态 + upsert 返回的 finding 元数据」。
 */
interface AuditRowEntry extends DriftCandidate {
  status: string;
  firstSeenRound: number;
  lastSeenAt: string;
  findingId: string;
}

export function createAuditHandlers(ctx: HandlerContext): AuditHandlers {
  const { store, root } = ctx;
  return {
    audit(args: AuditArgs = {}): string | AuditResult {
      // B-a2c4: fail-fast 如果 ctx.root 不是 repo 根，否则 audit 会把 report 静默写到
      // 子目录 (如 packages/koala/docs/...) 而非仓根 docs/...。标志物: .git 存在
      // (worktree 下 .git 是文件，主仓下是目录，existsSync 对两者都返回 true)。
      if (!existsSync(join(root, '.git'))) {
        throw new Error(
          `audit must run from repo root (got: ${root}). ` +
          `Set KOALA_PROJECT_ROOT or cd to the directory containing .git.`
        );
      }

      const cfg = loadConfig(root);
      const profile: WorkflowProfile = cfg.workflow?.profile ?? 'balanced';
      const auditCfg: AuditConfig = resolveAuditConfig(profile, root);
      const effectiveMode: AuditMode = args.mode ?? auditCfg.mode;

      // MVP 只实现 --framework；args.framework 缺省也按 framework 跑（只此一档）
      if (effectiveMode === 'off') {
        return 'audit disabled (mode=off)';
      }

      // 1. 定位两份 CLAUDE.md 入口（硬编码，不扩展）
      const mdEntries = [
        join(root, 'CLAUDE.md'),
        join(root, 'packages', 'koala', 'CLAUDE.md'),
      ].filter(p => existsSync(p));

      if (mdEntries.length === 0) {
        return 'audit: no CLAUDE.md entries found, nothing to audit';
      }

      // 2. meta-story + round
      ensureMetaStory(store);
      const round = beginRound(store);

      // 3. scanner (B-805f CHK-003: pass registryNames for docs-drift advisory scan)
      const report = runMechanicalAudit(mdEntries, root, {
        registryNames: ctx.getAllToolNames?.(),
      });

      // 4. upsertDrift
      const seenHashes = new Set<string>();
      let newCount = 0;
      let stillDriftingCount = 0;
      const rowsNew: AuditRowEntry[] = [];
      const rowsStill: AuditRowEntry[] = [];

      for (const d of report.drifts) {
        const h = driftHash(d.sectionPath, d.symbol, d.driftType);
        seenHashes.add(h);
        const r = upsertDrift(store, round, {
          sectionPath: d.sectionPath,
          symbol: d.symbol,
          driftType: d.driftType,
          desc: d.desc,
          severity: d.severity,
        });
        // 读回 finding 拿 firstSeenRound / lastSeenAt（audit-meta-store 已写入）
        const data = store.readFindings(META_STORY_ID);
        const f = data.findings.find(x => x.id === r.findingId);
        const row = {
          ...d,
          status: r.state,
          firstSeenRound: f?.firstSeenRound ?? round,
          lastSeenAt: f?.lastSeenAt ?? new Date().toISOString(),
          findingId: r.findingId,
        };
        if (r.state === 'new') { newCount++; rowsNew.push(row); }
        else { stillDriftingCount++; rowsStill.push(row); }
      }

      // 5. autoResolveMissing
      const resolvedIds = autoResolveMissing(store, round, seenHashes);
      const resolvedCount = resolvedIds.length;

      // 记录本轮 round 到 meta-story.events（便于 beginRound 下次递增）
      try { recordRound(store, round); } catch {/* advisory */}

      // 6. report.md
      const reportPath = writeReport({
        root,
        round,
        rowsNew,
        rowsStill,
        resolvedIds,
        skipped: report.skipped,
      });

      // 7. state.json lastAuditAt
      try {
        touchAuditState(root, { lastAuditAt: new Date().toISOString() });
      } catch { /* advisory */ }

      // 8. summary line
      const line = `✓ Framework audit round ${round} complete: ${newCount} new drift / ${stillDriftingCount} still-drifting / ${resolvedCount} resolved-by-nature`;
      console.log(line);
      if (report.skipped.length > 0) {
        console.log(`  (skipped ${report.skipped.length} — see report)`);
      }
      console.log(`  report: ${reportPath}`);

      return {
        status: 'completed',
        mode: effectiveMode,
        round,
        newCount,
        stillDriftingCount,
        resolvedCount,
        skippedCount: report.skipped.length,
        reportPath,
      };
    },
  };
}

interface ReportInputs {
  root: string;
  round: number;
  rowsNew: AuditRowEntry[];
  rowsStill: AuditRowEntry[];
  resolvedIds: string[];
  skipped: SkippedEntry[];
}

function writeReport(inp: ReportInputs): string {
  const dateStr = localDateIsoDay();
  const dir = join(inp.root, 'docs', 'koala', 'framework-audit', dateStr);
  mkdirSync(dir, { recursive: true });
  const out = join(dir, 'report.md');

  const lines: string[] = [];
  lines.push(`# Framework Audit Report — round ${inp.round} (${dateStr})`);
  lines.push('');
  lines.push(`- new drift: ${inp.rowsNew.length}`);
  lines.push(`- still-drifting: ${inp.rowsStill.length}`);
  lines.push(`- resolved-by-nature: ${inp.resolvedIds.length}`);
  lines.push(`- skipped: ${inp.skipped.length}`);
  lines.push('');

  const rows = [...inp.rowsNew, ...inp.rowsStill];
  lines.push('## Drifts');
  lines.push('');
  if (rows.length === 0) {
    lines.push('_no drift_');
  } else {
    lines.push('| drift-type | section-path | symbol | severity | status | firstSeenRound | lastSeenAt |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const r of rows) {
      lines.push(`| ${r.driftType} | ${esc(r.sectionPath)} | ${esc(r.symbol)} | ${r.severity} | ${r.status} | ${r.firstSeenRound} | ${r.lastSeenAt} |`);
    }
  }
  lines.push('');

  lines.push('## Resolved this round (drift cleared)');
  lines.push('');
  if (inp.resolvedIds.length === 0) lines.push('_none_');
  else for (const id of inp.resolvedIds) lines.push(`- ${id}`);
  lines.push('');

  lines.push('## Skipped');
  lines.push('');
  if (inp.skipped.length === 0) lines.push('_none_');
  else {
    lines.push('| drift-type | section-path | symbol | reason |');
    lines.push('|---|---|---|---|');
    for (const s of inp.skipped) {
      lines.push(`| ${s.driftType} | ${esc(s.sectionPath)} | ${esc(s.symbol)} | ${s.reason} |`);
    }
  }
  lines.push('');

  writeFileSync(out, lines.join('\n'), 'utf-8');
  return out;
}

function esc(s: string): string {
  return s.replace(/\|/g, '\\|');
}

function localDateIsoDay(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * touchAuditState: 只更新 state.json 的 lastAuditAt 字段。
 *
 * 这里刻意做得窄：CHK-003 会扩展 {lastAuditCommit, doneSinceLastAudit, lastAuditStoryId}
 * 等字段——CHK-001 先写好 "读 + 部分字段 patch + 写" 的骨架，CHK-003 接手后只要扩 patch
 * 类型即可，不必重写文件 I/O。
 *
 * 读写失败都不抛（advisory）；JSON 解析失败 → 按空对象 fallback 重写。
 *
 * 模块内部使用（非 export）——state.json 路径的真相源统一在 audit-trigger.stateFilePath。
 */
function touchAuditState(repoRoot: string, patch: Record<string, unknown>): string {
  const path = stateFilePath(repoRoot);
  let current: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      current = JSON.parse(readFileSync(path, 'utf-8')) || {};
      if (typeof current !== 'object' || Array.isArray(current)) current = {};
    } catch { current = {}; }
  }
  const next = { ...current, ...patch };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n', 'utf-8');
  return path;
}
