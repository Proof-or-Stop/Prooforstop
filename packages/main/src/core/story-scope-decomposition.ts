/** Live planning coverage over existing ProofStory artifacts; never delivery evidence. */
import { buildAcceptanceMatrixReport } from './acceptance-topology.js';
import { canonicalDigest } from './authority-signing.js';
import { readTrustedProofStoryScopeArtifacts } from './closeout-trust.js';
import { collectVerificationIntents } from './verification.js';
import type { StoryStore } from './store.js';
import type { ScopeBudgetSubject, StoryScopeBudgetReport } from './story-scope-budget.js';

export interface ScopeDecompositionReport {
  status: 'ready' | 'incomplete';
  authority: 'planning_only';
  bindingDigest: string;
  children: string[];
  claimedPaths: Array<{ path: string; storyId: string }>;
  diagnostics: string[];
}

export function readScopeDecomposition(
  store: StoryStore, parent: ScopeBudgetSubject, parentPaths: string[],
  inspectChild: (storyId: string) => StoryScopeBudgetReport,
): ScopeDecompositionReport | undefined {
  if (!store.readProofStorySlicePlan(parent.storyId) && !store.readProofStoryParentLedgerRollup(parent.storyId)) return undefined;
  const diagnostics: string[] = [], children: string[] = [], bindings: unknown[] = [];
  const report: ScopeDecompositionReport = { status: 'incomplete', authority: 'planning_only', bindingDigest: '', children, claimedPaths: parentPaths.map(path => ({ path, storyId: parent.storyId })), diagnostics };
  try {
    const { ledger, slicePlan, parentRollup } = readTrustedProofStoryScopeArtifacts(store, parent.storyId);
    if (!ledger || !slicePlan || !parentRollup) throw new Error('decomposition requires milestone ledger, slice plan and parent rollup');
    if (!ledger.milestones.length || parentRollup.children.length < 2) throw new Error('decomposition requires milestones and at least two distinct children');
    bindings.push(parent, ledger, slicePlan, parentRollup);
    const ownerByMilestone = new Map<string, string>();
    for (const slice of slicePlan.slices) {
      if (!slice.assignedStory) throw new Error(`slice ${slice.id} has no assigned child`);
      for (const id of slice.milestoneIds) ownerByMilestone.set(id, slice.assignedStory);
    }
    const covered = new Set<string>();
    const pathOwners = new Map(parentPaths.map(path => [path, parent.storyId]));
    for (const child of parentRollup.children) {
      const id = child.storyId;
      if (id === parent.storyId || !store.storyExists(id)) throw new Error(`invalid or nonexistent child Story: ${id}`);
      if (store.readStory(id).phase === 'DISCARDED') throw new Error(`discarded child Story: ${id}`);
      children.push(id);
      if (!child.milestoneIds.length) throw new Error(`child ${id} has no assigned milestones`);
      const childBudget = inspectChild(id);
      if (childBudget.status !== 'within_budget' || childBudget.blocking) throw new Error(`child ${id} is not independently within budget: ${childBudget.status}`);
      if (!childBudget.paths.length) throw new Error(`child ${id} has no declared scope`);
      for (const claim of childBudget.decomposition?.claimedPaths ?? childBudget.paths.map(path => ({ path, storyId: id }))) {
        if (pathOwners.has(claim.path)) throw new Error(`decomposition scope overlaps ${pathOwners.get(claim.path)} and ${claim.storyId}: ${claim.path}`);
        pathOwners.set(claim.path, claim.storyId);
        report.claimedPaths.push(claim);
      }
      const childArtifacts = readTrustedProofStoryScopeArtifacts(store, id);
      if (!childArtifacts.ledger) throw new Error(`child ${id} has no milestone ledger`);
      const checklist = store.readChecklist(id), proof = store.readProofStoryContract(id);
      if (!proof || proof.diagnosticOnly) throw new Error(`child ${id} has no enforceable acceptance mapping`);
      const matrix = buildAcceptanceMatrixReport({ storyId: id, checklist, contract: proof, ledger: childArtifacts.ledger });
      if (matrix.diagnostics.length) throw new Error(`child ${id} acceptance topology is incomplete: ${matrix.diagnostics.map(d => d.code).join(', ')}`);
      const items = checklist.items.filter(item => item.status !== 'withdrawn');
      const itemIds = new Set(items.map(item => item.id));
      const intents = new Map(items.flatMap(item => collectVerificationIntents(item).map(intent => [intent.ref, item.id] as const)));
      for (const parentId of child.milestoneIds) {
        const milestone = ledger.milestones.find(row => row.id === parentId);
        if (!milestone || covered.has(parentId)) throw new Error(`unknown or duplicate parent milestone: ${parentId}`);
        covered.add(parentId);
        if (ownerByMilestone.get(parentId) !== id || milestone.assignedStory !== id) throw new Error(`assignment mismatch for ${parentId}`);
        const rows = childArtifacts.ledger.milestones.filter(row => row.parentLedgerId === parentId);
        if (rows.length !== 1) throw new Error(`child ${id} must map ${parentId} exactly once`);
        const row = rows[0]!;
        if (row.status === 'not_applicable' || row.sourceRequirementId !== milestone.sourceRequirementId || row.claim !== milestone.claim
          || row.doneMeans !== milestone.doneMeans || milestone.requiredEvidence.some(evidence => !row.requiredEvidence.includes(evidence))) {
          throw new Error(`child ${id} weakens parent milestone ${parentId}`);
        }
        if (!row.checklistRefs.length || row.checklistRefs.some(ref => !itemIds.has(ref)) || !row.verificationIntentRefs.length
          || row.verificationIntentRefs.some(ref => !intents.has(ref) || !row.checklistRefs.includes(intents.get(ref)!))) {
          throw new Error(`child ${id} lacks current checklist/intent coverage for ${parentId}`);
        }
        const binding = proof.acceptanceBindings.find(binding => binding.milestoneIds.includes(row.id)
          && row.checklistRefs.every(ref => binding.checklistRefs.includes(ref))
          && row.verificationIntentRefs.every(ref => binding.verificationIntentRefs.includes(ref)));
        if (!binding?.verificationTopology) throw new Error(`child ${id} lacks acceptance binding for ${parentId}`);
      }
      bindings.push({ id, budget: childBudget.bindingDigest, ledger: childArtifacts.ledger, checklist, proof });
    }
    if (covered.size !== ledger.milestones.length) throw new Error('decomposition must cover every parent milestone');
    report.status = 'ready';
  } catch (error) { diagnostics.push(error instanceof Error ? error.message : String(error)); }
  report.bindingDigest = canonicalDigest({ status: report.status, bindings, children, claimedPaths: report.claimedPaths, diagnostics });
  return report;
}
