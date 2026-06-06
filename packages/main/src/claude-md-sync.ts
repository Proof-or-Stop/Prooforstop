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
    lines.push(`**Express channel**: when checklist ≤ ${policy.quickPath.maxChecklistItems} items and no riskSignals, PLAN can be skipped.`);
  } else {
    lines.push('**Express channel**: disabled; all stories must go through full PLAN.');
  }
  lines.push('');

  // PLAN requirements (list all sub-fields)
  const planParts: string[] = [];
  if (policy.plan.requireUnderstanding !== 'never') planParts.push(`understanding=${policy.plan.requireUnderstanding}`);
  if (policy.plan.requireDecision !== 'never') planParts.push(`decision=${policy.plan.requireDecision}`);
  if (policy.plan.requirePlanMd !== 'never') planParts.push(`plan.md=${policy.plan.requirePlanMd}`);
  if (policy.plan.requireStoryReview) planParts.push('story_review=required');
  if (planParts.length > 0) {
    lines.push(`**PLAN phase**: ${planParts.join(', ')}.`);
  } else {
    lines.push('**PLAN phase**: low-risk stories may omit understanding / decision / plan.md / story_review.');
  }

  // Subagent requirements
  if (policy.subagents.requireWorkerInNormalChannel) {
    lines.push('**Normal channel**: must use the koala-implementer subagent to write code; the main agent does not write business code.');
  } else {
    lines.push('**Normal channel**: subagent is recommended but not required; the main agent may write code itself.');
  }

  // Review requirements
  if (policy.review.requireReviewer) {
    lines.push(`**REVIEW**: reviewer findings required; blocking severities: [${policy.review.blockingSeverities.join(', ')}].`);
  } else {
    lines.push('**REVIEW**: reviewer optional; the main agent may self-review.');
  }

  // Test requirements (evaluator)
  if (policy.test.requireEvaluatorForBrowser) {
    lines.push('**TEST**: browser projects must have evaluator scoring (hard gate).');
  } else {
    lines.push('**TEST**: evaluator is advisory (does not block progression).');
  }

  // Summary requirements
  lines.push(`**DONE**: summary requirement = ${policy.done.requireSummary}.`);

  lines.push('');
  lines.push('> High-risk stories (riskSignals hit) are automatically escalated to strict, regardless of the project default profile.');
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
