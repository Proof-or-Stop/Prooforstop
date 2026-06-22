/**
 * @task B-832d
 * @checklist CHK-001
 * @title test-intent-quality-v1 quantifies testIntent structure and fixture mappability
 * @type feature
 * @priority high
 * @description
 *   testIntent 质量直接影响 fixture 可写性和 reviewer 轮次。这个 profile 用
 *   deterministic rubric 检查 happy/edge/adversarial 完整度、type 标注、
 *   操作→预期结构、fixture 映射性、对抗强度和重复噪音。
 * @changes
 *   - [CHK-001] 新增 test-intent-quality-v1 profile
 */
import type { LabProfileContext, LabRunMetrics } from '../types.js';

type Lane = 'happy' | 'edge' | 'adversarial';

interface IntentEntry {
  desc?: string;
  type?: string;
  input?: unknown;
  expect?: unknown;
  trigger?: string;
  condition?: string;
  result?: string;
}

interface IntentData {
  happy?: Array<string | IntentEntry>;
  edge?: Array<string | IntentEntry>;
  adversarial?: Array<string | IntentEntry>;
}

const LANES: Lane[] = ['happy', 'edge', 'adversarial'];

function ratio(condition: boolean): number {
  return condition ? 1 : 0;
}

function normalizeEntry(entry: string | IntentEntry): IntentEntry {
  return typeof entry === 'string' ? { desc: entry } : entry;
}

function parseIntent(content: string): IntentData {
  const trimmed = content.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed) as IntentData;
  } catch {
    const data: IntentData = {};
    let current: Lane | null = null;
    for (const line of trimmed.split('\n')) {
      const lane = line.trim().match(/^(happy|edge|adversarial)\s*:/i)?.[1]?.toLowerCase() as Lane | undefined;
      if (lane && LANES.includes(lane)) {
        current = lane;
        data[current] = data[current] || [];
        const rest = line.slice(line.indexOf(':') + 1).trim();
        if (rest) data[current]!.push(rest);
        continue;
      }
      if (current && line.trim().startsWith('-')) {
        data[current]!.push(line.trim().replace(/^-\s*/, ''));
      }
    }
    return data;
  }
}

function entries(data: IntentData): IntentEntry[] {
  return LANES.flatMap((lane) => (data[lane] || []).map(normalizeEntry));
}

function laneComplete(data: IntentData): number {
  return LANES.filter((lane) => (data[lane] || []).length > 0).length / LANES.length;
}

function typeCoverage(items: IntentEntry[]): number {
  if (items.length === 0) return 0;
  return items.filter((item) => item.type === 'cli_blackbox' || item.type === 'browser_blackbox').length / items.length;
}

function operationResultCoverage(items: IntentEntry[]): number {
  if (items.length === 0) return 0;
  return items.filter((item) => {
    const desc = item.desc || '';
    return desc.includes('→') || (Boolean(item.trigger || item.condition) && Boolean(item.result));
  }).length / items.length;
}

function fixtureMappingCoverage(items: IntentEntry[]): number {
  if (items.length === 0) return 0;
  return items.filter((item) => {
    const desc = item.desc || '';
    return item.input !== undefined || item.expect !== undefined || /input|expect|fixture|intentRef|返回|抛出|输出/.test(desc);
  }).length / items.length;
}

function adversarialStrength(data: IntentData): number {
  const adversarial = (data.adversarial || []).map(normalizeEntry);
  if (adversarial.length === 0) return 0;
  const pattern = /恶意|并发|重复|异常|越权|脏|dirty|冲突|失败|超时|非法|空|缺失|边界|race|crash|rollback/i;
  return adversarial.filter((item) => pattern.test(item.desc || '')).length / adversarial.length;
}

function duplicatePenalty(items: IntentEntry[]): number {
  if (items.length <= 1) return 0;
  const descs = items.map((item) => (item.desc || '').trim()).filter(Boolean);
  const unique = new Set(descs);
  return 1 - unique.size / Math.max(descs.length, 1);
}

export function evaluateTestIntentQualityProfile(ctx: LabProfileContext): LabRunMetrics {
  const data = parseIntent(ctx.content);
  const all = entries(data);
  const submetrics = {
    laneCompleteness: Number(laneComplete(data).toFixed(4)),
    typeCoverage: Number(typeCoverage(all).toFixed(4)),
    operationResultCoverage: Number(operationResultCoverage(all).toFixed(4)),
    fixtureMappingCoverage: Number(fixtureMappingCoverage(all).toFixed(4)),
    adversarialStrength: Number(adversarialStrength(data).toFixed(4)),
    antiDuplicate: Number((1 - duplicatePenalty(all)).toFixed(4)),
  };
  const quality = Object.values(submetrics).reduce((sum, value) => sum + value, 0) / Object.values(submetrics).length;
  const lineCount = ctx.content.split('\n').length;
  const latencyPenalty = lineCount <= 80 ? 0 : Math.min(1, (lineCount - 80) / 160);
  const complexityPenalty = Math.min(1, ctx.changedFiles * 0.04 + ctx.changedLines / 500);
  const contentSummary = [
    `${submetrics.laneCompleteness === 1 ? 'has' : 'missing'} threeLanes`,
    `${submetrics.typeCoverage === 1 ? 'has' : 'missing'} typeCoverage`,
    `${submetrics.operationResultCoverage >= 0.8 ? 'has' : 'missing'} operationResult`,
    `${submetrics.fixtureMappingCoverage >= 0.8 ? 'has' : 'missing'} fixtureMapping`,
    `${submetrics.adversarialStrength >= 0.8 ? 'has' : 'weak'} adversarialStrength`,
    `${submetrics.antiDuplicate === 1 ? 'has' : 'has duplicate'} antiDuplicate`,
  ];

  return {
    profile: 'test-intent-quality-v1',
    quality: Number(quality.toFixed(4)),
    latencyPenalty: Number(latencyPenalty.toFixed(4)),
    complexityPenalty: Number(complexityPenalty.toFixed(4)),
    stabilityPenalty: 0,
    submetrics,
    contentSummary,
    notes: [`entryCount=${all.length}`, `lineCount=${lineCount}`],
  };
}
