/**
 * evidence-stale-hint — single source of truth for stale verificationEvidence UX.
 *
 * 设计：
 *   - 任何 user-visible surface（session_brief / story_advance pre-check / koala validate
 *     文本输出 / hints.ts 装饰器）发现 verification evidence stale 时，必须调用本模块
 *     的 renderEvidenceStaleHint，不允许在 surface 内再造 marker 字符串或 recovery 命令。
 *   - 三个 surface 输出 byte-identical（B-a2f1 decision.json preMortem #2）。
 *   - storyId 必传，没有 storyId 整段返回 ''；严禁向用户输出 `<storyId>` / `<B-xxx>` 这类
 *     字面占位符（B-a2f1 decision.json preMortem #3）。
 *
 * 复用：checkEvidenceFreshnessForGit + Story checklist 的 verificationEvidence。
 * 不引入新依赖；只用现有 core / store。
 */

import { checkEvidenceFreshnessForGit } from './evidence-freshness.js';
import { StoryStore } from './store.js';

/**
 * 跨 surface 唯一 marker。三个 surface 的字符串都从这里 import，
 * 不允许在 surface 内重写常量。
 */
export const EVIDENCE_STALE_MARKER = '⚠ EVIDENCE STALE';

export interface StaleEvidenceEntry {
  /** intent reference，如 "CHK-001:happy:0" */
  intentRef: string;
  /** 所属 checklist item，如 "CHK-001" */
  itemId: string;
  /** stale 原因（来自 checkEvidenceFreshnessForGit 的 reason，方便调试，但不进入 marker 输出） */
  reason: string;
}

/**
 * 扫 story 的 checklist.verificationEvidence，返回所有 stale entry。
 *
 * 复用 checkEvidenceFreshnessForGit：headHash + materialHash 都喂进去，
 * fresh=false → 视为 stale。读不到 story / checklist 一律返回 []（probe 容错）。
 */
export function findStaleEvidence(projectRoot: string, storyId: string): StaleEvidenceEntry[] {
  if (!storyId) return [];
  let store: StoryStore;
  try {
    store = new StoryStore(projectRoot);
  } catch {
    return [];
  }
  let checklist: { items?: Array<{ id: string; verificationEvidence?: Array<{ intentRef: string; headHash?: string; materialHash?: string }> }> } | null = null;
  try {
    checklist = store.readChecklist(storyId);
  } catch {
    return [];
  }
  if (!checklist || !Array.isArray(checklist.items)) return [];

  const out: StaleEvidenceEntry[] = [];
  for (const item of checklist.items) {
    const evidences = Array.isArray(item.verificationEvidence) ? item.verificationEvidence : [];
    for (const ev of evidences) {
      if (!ev || typeof ev.intentRef !== 'string') continue;
      const freshness = checkEvidenceFreshnessForGit(projectRoot, ev.headHash, ev.materialHash);
      if (!freshness.fresh) {
        out.push({
          intentRef: ev.intentRef,
          itemId: item.id,
          reason: freshness.reason,
        });
      }
    }
  }
  return out;
}

/**
 * 渲染跨 surface byte-identical 的 EVIDENCE STALE 区块。
 *
 * 输入：
 *   storyId   - 实际 story id（如 "B-a2f1"）；undefined / 空串时返回 ''
 *   stale     - 已经算出的 stale 列表（≥1 才输出，0 时返回 ''）
 *   opts      - 可选；currentHead 取前 7 位填入「materialHash drift after <sha>」
 *
 * 输出格式（必须保持稳定 — 三个 surface 都按 byte-equality 断言此格式）：
 *
 *   ⚠ EVIDENCE STALE (materialHash drift after abc1234): 2 verification intent(s) stale for B-xxxx
 *     Run to recover:
 *       koala verification_evidence_refresh_stale --storyId=B-xxxx
 *       koala validate --story=B-xxxx --json
 *
 * 不输出 `<storyId>` / `<B-xxx>` 之类的字面占位符（preMortem #3）。
 */
export function renderEvidenceStaleHint(
  storyId: string | undefined,
  stale: ReadonlyArray<StaleEvidenceEntry>,
  opts?: { currentHead?: string },
): string {
  if (!storyId || stale.length === 0) return '';
  const headSuffix = opts?.currentHead ? ` (materialHash drift after ${opts.currentHead.slice(0, 7)})` : '';
  const count = stale.length;
  const lines = [
    `${EVIDENCE_STALE_MARKER}${headSuffix}: ${count} verification intent(s) stale for ${storyId}`,
    `  Run to recover:`,
    `    koala verification_evidence_refresh_stale --storyId=${storyId}`,
    `    koala validate --story=${storyId} --json`,
  ];
  return lines.join('\n');
}
