/**
 * CLAUDE.md profile section sync utilities.
 *
 * Pure functions + one I/O helper. No top-level side effects.
 * Extracted from cli-init.ts so that workflow.ts can import without
 * triggering the self-executing init script.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import type { WorkflowProfile } from './core/types.js';
import { WORKFLOW_PRESETS } from './core/types.js';

/**
 * Generate CLAUDE.md profile section content for a given profile.
 */
export function generateProfileSection(profile: WorkflowProfile): string {
  const policy = WORKFLOW_PRESETS[profile];
  const lines: string[] = [];
  lines.push('<!-- koala-profile:start -->');
  lines.push(`## Workflow Profile: ${profile}\n`);

  if (policy.quickPath.enabled) {
    lines.push(`**快速通道**：checklist ≤ ${policy.quickPath.maxChecklistItems} 项且无 riskSignals 时可跳过 PLAN。`);
  } else {
    lines.push('**快速通道**：已禁用，所有 story 必须走完整 PLAN。');
  }
  lines.push('');

  // PLAN requirements (list all sub-fields)
  const planParts: string[] = [];
  if (policy.plan.requireUnderstanding !== 'never') planParts.push(`understanding=${policy.plan.requireUnderstanding}`);
  if (policy.plan.requireDecision !== 'never') planParts.push(`decision=${policy.plan.requireDecision}`);
  if (policy.plan.requirePlanMd !== 'never') planParts.push(`plan.md=${policy.plan.requirePlanMd}`);
  if (policy.plan.requireStoryReview) planParts.push('story_review=必须');
  if (planParts.length > 0) {
    lines.push(`**PLAN 阶段**：${planParts.join('，')}。`);
  } else {
    lines.push('**PLAN 阶段**：低风险 story 可省略 understanding / decision / plan.md / story_review。');
  }

  // Subagent requirements
  if (policy.subagents.requireWorkerInNormalChannel) {
    lines.push('**正常通道**：必须使用 koala-implementer subagent 写代码，主 agent 不写业务代码。');
  } else {
    lines.push('**正常通道**：subagent 推荐但不强制，主 agent 可以自己写代码。');
  }

  // Review requirements
  if (policy.review.requireReviewer) {
    lines.push(`**REVIEW**：必须有 reviewer finding，blocking 级别：[${policy.review.blockingSeverities.join(', ')}]。`);
  } else {
    lines.push('**REVIEW**：reviewer 可选，主 agent 可自审。');
  }

  // Test requirements (evaluator)
  if (policy.test.requireEvaluatorForBrowser) {
    lines.push('**TEST**：browser 项目必须有 evaluator 打分（hard gate）。');
  } else {
    lines.push('**TEST**：evaluator 为 advisory（不阻塞推进）。');
  }

  // Summary requirements
  lines.push(`**DONE**：summary 要求 = ${policy.done.requireSummary}。`);

  lines.push('');
  lines.push('> 高风险 story（riskSignals 命中）会自动加严到 strict，不受项目默认 profile 影响。');
  lines.push('<!-- koala-profile:end -->');

  return lines.join('\n');
}

/**
 * Sync the profile section in CLAUDE.md.
 * Replaces existing markers or appends to end of file.
 * Returns true on success.
 */
export function syncProfileSection(claudeMdPath: string, profile: WorkflowProfile): boolean {
  if (!existsSync(claudeMdPath)) return false;

  const content = readFileSync(claudeMdPath, 'utf-8');
  const newSection = generateProfileSection(profile);
  const marker = /<!--\s*koala-profile:start\s*-->[\s\S]*?<!--\s*koala-profile:end\s*-->/;

  let updated: string;
  if (marker.test(content)) {
    updated = content.replace(marker, newSection);
  } else {
    // Append outside koala:start/end markers
    updated = content.trimEnd() + '\n\n' + newSection + '\n';
  }

  if (updated !== content) {
    writeFileSync(claudeMdPath, updated, 'utf-8');
  }
  return true;
}
