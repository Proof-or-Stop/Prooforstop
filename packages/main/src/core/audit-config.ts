/**
 * audit-config — 解析 framework audit 的运行配置（B-9bd9 CHK-004）。
 *
 * 纯函数模块：`resolveAuditConfig(profile, projectRoot)`.
 *
 * 优先级（高 → 低）：
 *   1. `<projectRoot>/.koala/audit-config.json` 中的字段（逐字段覆盖）
 *   2. profile 默认：auditTriggerWindow 维度按 light=10 / balanced=5 / strict=3 分档
 *      （requireClaudeMdDiff 和 mode 无 profile 差别，用硬编码默认）
 *   3. 硬编码兜底：auditTriggerWindow=5, requireClaudeMdDiff=true, mode="semi-auto"
 *
 * 失败策略：
 *   - 配置文件不存在 → 静默使用 profile 默认
 *   - JSON 解析失败 → 一次性 console.warn + fallback 到 profile 默认
 *   - mode 字段非法值 → console.warn + fallback "semi-auto"
 *
 * 该模块**不**注册专用 CLI 命令（YAGNI，手改 JSON 足够）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowProfile } from './types.js';

export type AuditMode = 'semi-auto' | 'full-auto' | 'off';

export interface AuditConfig {
  auditTriggerWindow: number;
  requireClaudeMdDiff: boolean;
  mode: AuditMode;
}

/** 硬编码兜底（所有字段都缺时的最后一道防线）。 */
const HARD_DEFAULTS: AuditConfig = {
  auditTriggerWindow: 5,
  requireClaudeMdDiff: true,
  mode: 'semi-auto',
};

/** profile → auditTriggerWindow 默认映射。其他字段所有 profile 共用硬编码兜底。 */
const PROFILE_TRIGGER_WINDOW: Record<WorkflowProfile, number> = {
  light: 10,
  balanced: 5,
  strict: 3,
};

const VALID_MODES: ReadonlySet<AuditMode> = new Set<AuditMode>(['semi-auto', 'full-auto', 'off']);

/**
 * 计算 audit 配置。
 *
 * @param profile      当前 workflow profile（已由上层 resolveProfile 解析完毕）
 * @param projectRoot  项目根路径（.koala/audit-config.json 读取基准）
 */
export function resolveAuditConfig(profile: WorkflowProfile, projectRoot: string): AuditConfig {
  // 1. 先算 profile 默认（只在 triggerWindow 维度分档）
  const profileDefaults: AuditConfig = {
    auditTriggerWindow: PROFILE_TRIGGER_WINDOW[profile] ?? HARD_DEFAULTS.auditTriggerWindow,
    requireClaudeMdDiff: HARD_DEFAULTS.requireClaudeMdDiff,
    mode: HARD_DEFAULTS.mode,
  };

  // 2. 尝试读项目级配置（逐字段覆盖）
  const userOverrides = readUserConfig(projectRoot);
  if (!userOverrides) return profileDefaults;

  const merged: AuditConfig = { ...profileDefaults };

  if (typeof userOverrides.auditTriggerWindow === 'number' && Number.isFinite(userOverrides.auditTriggerWindow)) {
    const w = userOverrides.auditTriggerWindow;
    // 非整数 / <= 0 都非法（0 会让 bumped.doneSinceLastAudit < 0 永远 false，窗口形同虚设）
    if (!Number.isInteger(w) || w <= 0) {
      console.warn(
        `[audit-config] auditTriggerWindow must be a positive integer (>=1), got ${w}, falling back to profile default (${profileDefaults.auditTriggerWindow}).`,
      );
      // 保持 profileDefaults.auditTriggerWindow
    } else {
      merged.auditTriggerWindow = w;
    }
  }
  if (typeof userOverrides.requireClaudeMdDiff === 'boolean') {
    merged.requireClaudeMdDiff = userOverrides.requireClaudeMdDiff;
  }
  if (typeof userOverrides.mode === 'string') {
    if (VALID_MODES.has(userOverrides.mode as AuditMode)) {
      merged.mode = userOverrides.mode as AuditMode;
    } else {
      console.warn(
        `[audit-config] invalid mode "${userOverrides.mode}" in .koala/audit-config.json, falling back to "semi-auto".`,
      );
      merged.mode = 'semi-auto';
    }
  }

  return merged;
}

/**
 * 读取 `.koala/audit-config.json`。
 *   - 文件不存在 → 返回 null（静默）
 *   - JSON 解析失败 → warn 一次 + 返回 null
 */
function readUserConfig(projectRoot: string): Partial<AuditConfig> | null {
  const path = join(projectRoot, '.koala', 'audit-config.json');
  if (!existsSync(path)) return null;

  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn(`[audit-config] ${path} is not a JSON object, using profile defaults.`);
      return null;
    }
    return parsed as Partial<AuditConfig>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[audit-config] failed to parse ${path}: ${msg}. Falling back to profile defaults.`);
    return null;
  }
}
