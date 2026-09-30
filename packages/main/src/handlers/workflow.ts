import { rethrowIntentAmendmentIntegrityError } from '../core/verification-intent-amendment.js';
/**
 * Workflow profile commands: set / show / explain.
 */

import { closureBlockingSeverities } from '../core/finding-closure-severities.js';
import type { HandlerContext } from './context.js';
import { loadConfig, pickProjectConfigPath, PROOF_OR_STOP_CONFIG_FILENAME } from '../core/config.js';
import { resolveWorkflowPolicy, explainProfile, computeChannel, CHANNEL_LABELS } from '../core/workflow-policy.js';
import type { WorkflowProfile, WorkflowPolicy } from '../core/types.js';
import { WORKFLOW_PRESETS } from '../core/types.js';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { syncProfileSection } from '../claude-md-sync.js';

export function createWorkflowHandlers(ctx: HandlerContext) {
  const { store, root } = ctx;

  return {
    workflow_set(args: { profile: string }): string {
      const validProfiles: WorkflowProfile[] = ['light', 'balanced', 'strict'];
      if (!validProfiles.includes(args.profile as WorkflowProfile)) {
        return `Invalid profile: "${args.profile}". Supported: light / balanced / strict`;
      }
      const newProfile = args.profile as WorkflowProfile;

      // Prefer an existing proof-or-stop.config.json. If none exists, create it.
      const picked = pickProjectConfigPath(root);
      const configPath = picked?.path ?? join(root, PROOF_OR_STOP_CONFIG_FILENAME);
      const configFilename = picked?.filename ?? PROOF_OR_STOP_CONFIG_FILENAME;
      const config = loadConfig(root);
      const oldProfile: WorkflowProfile = config.workflow?.profile ?? 'balanced';

      if (oldProfile === newProfile) {
        return `Workflow profile is already ${newProfile}, no change needed`;
      }

      // Compute diff before writing
      const oldPolicy = WORKFLOW_PRESETS[oldProfile];
      const newPolicy = WORKFLOW_PRESETS[newProfile];

      // Atomic write: read raw config (or start from empty when creating
      // proof-or-stop.config.json fresh), patch, write back.
      const rawConfig = existsSync(configPath)
        ? JSON.parse(readFileSync(configPath, 'utf-8'))
        : {};
      if (!rawConfig.workflow) rawConfig.workflow = {};
      rawConfig.workflow.profile = newProfile;
      writeFileSync(configPath, JSON.stringify(rawConfig, null, 2) + '\n', 'utf-8');

      // Sync CLAUDE.md profile section (rollback config on failure)
      const claudeMdPath = join(root, 'CLAUDE.md');
      try {
        syncProfileSection(claudeMdPath, newProfile);
      } catch (err) {
        rawConfig.workflow.profile = oldProfile;
        writeFileSync(configPath, JSON.stringify(rawConfig, null, 2) + '\n', 'utf-8');
        const configLabel = `${configFilename} (canonical)`;
        return `CLAUDE.md sync failed, rolled back ${configLabel}: ${err}`;
      }

      const lines: string[] = [];
      lines.push(`Workflow profile: ${oldProfile} -> ${newProfile}\n`);
      lines.push('Changed:');
      const changes = diffPolicy(oldPolicy, newPolicy);
      for (const c of changes) {
        lines.push(`  ${c}`);
      }
      lines.push('\nSafety floors unchanged:');
      lines.push('  validate PASS required');
      lines.push('  all bugs must be fixed');
      lines.push('  high-risk stories still auto-escalate to strict');

      return lines.join('\n');
    },

    workflow_show(): string {
      const config = loadConfig(root);
      const profile: WorkflowProfile = config.workflow?.profile ?? 'balanced';
      const policy = WORKFLOW_PRESETS[profile];

      const lines: string[] = [];
      lines.push(`Current workflow profile: ${profile}\n`);
      lines.push('Policy:');
      lines.push(`  quickPath: enabled=${policy.quickPath.enabled}, maxChecklistItems=${policy.quickPath.maxChecklistItems}`);
      lines.push(`  plan: understanding=${policy.plan.requireUnderstanding}, decision=${policy.plan.requireDecision}, planMd=${policy.plan.requirePlanMd}, storyReview=${policy.plan.requireStoryReview}`);
      lines.push(`  subagents: requireWorker=${policy.subagents.requireWorkerInNormalChannel}, allowMainCoding=${policy.subagents.allowMainAgentCoding}`);
      lines.push(`  review: requireReviewer=${policy.review.requireReviewer}, blockingSeverities=[${policy.review.blockingSeverities.join(',')}], closureSeverities=[${closureBlockingSeverities(policy).join(',')}] (verified findings of these severities must be closed before TEST/DONE in every profile)`);
      lines.push(`  test: validatePass=${policy.test.requireValidatePass}, allBugsFixed=${policy.test.requireAllBugsFixed}, evaluator=${policy.test.requireEvaluatorForBrowser}`);
      lines.push(`  done: summary=${policy.done.requireSummary}, branchSynced=${policy.done.requireBranchSynced}, cleanGit=${policy.done.requireCleanGit}`);

      return lines.join('\n');
    },

    workflow_explain(args: { storyId: string }): string {
      const config = loadConfig(root);
      const story = store.readStory(args.storyId);
      const explanation = explainProfile(config, story);

      // B-45ed CHK-004: Real-time channel calculation (three tiers)
      let channel: 'express' | 'fast' | 'normal' = 'normal';
      let itemsCount = 0;
      let hasDecision = false;
      let optionCount = 0;
      try {
        const cl = store.readChecklist(args.storyId);
        itemsCount = Array.isArray(cl.items) ? cl.items.length : 0;
        let decision = null;
        try { decision = store.readDecision(args.storyId); } catch {}
        hasDecision = !!decision;
        optionCount = decision && Array.isArray(decision.options) ? decision.options.length : 0;
        channel = computeChannel(story, cl, decision);
      } catch (intentIntegrityError) { rethrowIntentAmendmentIntegrityError(intentIntegrityError);}

      const lines: string[] = [];
      lines.push(`Story ${args.storyId} workflow profile:\n`);
      lines.push(`  Project profile:  ${explanation.projectProfile}`);
      lines.push(`  Story required:   ${explanation.requiredProfile}`);
      lines.push(`  Effective:        ${explanation.effectiveProfile}`);
      lines.push(`  Channel:          ${channel} (${CHANNEL_LABELS[channel]})`);
      lines.push(`\nReasons:`);
      for (const r of explanation.reasons) {
        lines.push(`  - ${r}`);
      }
      // Channel determination basis
      const activeRisk = (story.riskSignals || []).filter(
        (r: any) => !(story.riskSignalsDismissed || []).some((d: any) => d.category === r.category)
      );
      const channelReason = (() => {
        if (activeRisk.length > 0) return `riskSignals non-empty (${activeRisk.map((r: any) => r.category).join(', ')}) → forced normal`;
        if (itemsCount <= 2) return `items=${itemsCount} ≤ 2 and no riskSignals → express`;
        if (itemsCount <= 5) {
          const singleSolution = !hasDecision || optionCount <= 1;
          if (singleSolution) {
            return `items=${itemsCount} ≤ 5 and single option (${hasDecision ? `options=${optionCount}` : 'no decision'}) → fast`;
          }
          return `items=${itemsCount} ≤ 5 but multiple options (options=${optionCount}) → normal`;
        }
        return `items=${itemsCount} > 5 → normal`;
      })();
      lines.push(`  - channel: ${channelReason}`);

      return lines.join('\n');
    },
  };
}

/** Compare two policy objects and return human-readable diff lines */
function diffPolicy(oldP: WorkflowPolicy, newP: WorkflowPolicy): string[] {
  const diffs: string[] = [];
  for (const key of Object.keys(oldP) as (keyof WorkflowPolicy)[]) {
    if (key === 'profile') continue;
    const oldVal = oldP[key];
    const newVal = newP[key];
    if (typeof oldVal === 'object' && oldVal !== null && !Array.isArray(oldVal)) {
      for (const subKey of Object.keys(oldVal)) {
        const oV = (oldVal as any)[subKey];
        const nV = (newVal as any)[subKey];
        if (JSON.stringify(oV) !== JSON.stringify(nV)) {
          diffs.push(`${key}.${subKey}: ${JSON.stringify(oV)} -> ${JSON.stringify(nV)}`);
        }
      }
    }
  }
  return diffs;
}
