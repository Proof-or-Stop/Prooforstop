import type { StoryStore } from './store.js';
import { resolveReviewRoundCount } from './advisory.js';
import { loadConfig } from './config.js';
import { resolveWorkflowPolicy } from './workflow-policy.js';
import { readDynamicFindingDecision, resolveDynamicFindingRollout } from './finding-applicability-projection.js';
import { applicabilityDigest } from './finding-applicability.js';

export interface FindingValidationConstraints {
  schemaVersion: 'finding-validation-v1'; storyId: string; digest: string;
  requiredCommands: string[]; affectedPaths: string[]; reassessFindingIds: string[];
  scopeExpansionAuthorized: false;
  authority?: 'enforced' | 'disabled' | 'shadow_only';
}
export function assertFindingValidationConstraintsCurrent(store: StoryStore, projectRoot: string, expected?: FindingValidationConstraints): void {
  if (!expected) return;
  const current = readFindingValidationConstraints(store, projectRoot, expected.storyId);
  if (current.digest !== expected.digest) throw new Error('dynamic validation: Finding constraints changed; re-plan before executing or admitting evidence');
}
/** Additive constraints only. Finding routing cannot remove an acceptance test,
 * waive a protected surface, or authorize scope expansion. */
export function readFindingValidationConstraints(store: StoryStore, projectRoot: string, storyId: string): FindingValidationConstraints {
  return projectConstraints(store, projectRoot, storyId, false);
}
/** Diagnostic comparison only; validation executors must refuse this authority. */
export function readFindingValidationPreview(store: StoryStore, projectRoot: string, storyId: string): FindingValidationConstraints {
  return projectConstraints(store, projectRoot, storyId, true);
}
function projectConstraints(store: StoryStore, projectRoot: string, storyId: string, diagnostic: boolean): FindingValidationConstraints {
  const rollout = resolveDynamicFindingRollout(projectRoot);
  if (rollout.killSwitch || (!diagnostic && rollout.mode !== 'enforce')) {
    return { schemaVersion: 'finding-validation-v1', storyId, digest: applicabilityDigest({ storyId, enabled: false }),
      requiredCommands: [], affectedPaths: [], reassessFindingIds: [], scopeExpansionAuthorized: false, authority: 'disabled' };
  }
  const story = store.readStory(storyId); const findings = store.readFindings(storyId).findings;
  const severities = resolveWorkflowPolicy(loadConfig(projectRoot), story).review.blockingSeverities;
  const round = resolveReviewRoundCount(store, storyId);
  const rows = findings.map(finding => ({ findingId: finding.id, decision: readDynamicFindingDecision({ store, projectRoot, storyId,
    finding, effectiveBlockingSeverities: severities, round, diagnostic: true }) }));
  const commands = new Set<string>(); const paths = new Set<string>(); const reassessFindingIds: string[] = [];
  for (const row of rows) if ('validation' in row.decision) {
    for (const command of row.decision.validation.requiredCommands) commands.add(command);
    for (const path of row.decision.validation.affectedPaths) paths.add(path);
    if (row.decision.validation.needsReassessment) reassessFindingIds.push(row.findingId);
  }
  return { schemaVersion: 'finding-validation-v1', storyId, digest: applicabilityDigest(rows), requiredCommands: [...commands].sort(),
    affectedPaths: [...paths].sort(), reassessFindingIds: reassessFindingIds.sort(), scopeExpansionAuthorized: false,
    authority: diagnostic ? 'shadow_only' : 'enforced' };
}
