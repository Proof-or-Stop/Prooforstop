/** Tool-owned scope decisions. Interactive intent is not biometric human identity. */
import type { StoryStore } from './store.js';
import { isInteractiveAckAllowed } from './convergence-breaker.js';
import { signValidationArtifact, verifyValidationArtifact } from './validation-artifact-signing.js';
import { withReviewInventoryMutationLock } from './review-inventory-epoch.js';
import { canonicalDigest } from './authority-signing.js';
import { createAcceptanceAmendmentController } from './acceptance-amendment-journal.js';
import { deriveAcceptanceAmendment } from './acceptance-amendment.js';
import { readStoryScopeBudget, type StoryScopeBudgetReport } from './story-scope-budget.js';
import { SCOPE_BUDGET_DECISION_RUNTIME_POLICY } from './runtime-fact-registry.js';

export interface ScopeBudgetApproval {
  schemaVersion: 'story-scope-budget-approval.v1';
  kind: 'human-large-story';
  storyId: string;
  bindingDigest: string;
  resultingScopeDigest: string;
  reason: string;
  issuedAt: string;
  expiresAt: string;
  channel: 'interactive-operator';
  signature: string;
}
export interface ScopeBudgetDecisionJournal {
  schemaVersion: 'story-scope-budget-decisions.v1';
  storyId: string;
  decisions: ScopeBudgetApproval[];
  signature: string;
}
function journalFor(store: StoryStore, root: string, storyId: string): ScopeBudgetDecisionJournal | null {
  const journal = store.readScopeBudgetDecisions(storyId);
  if (!journal) return null;
  const { signature, ...claims } = journal;
  if (journal.schemaVersion !== 'story-scope-budget-decisions.v1' || journal.storyId !== storyId
    || !Array.isArray(journal.decisions) || !verifyValidationArtifact(claims, signature, root)) throw new Error('Scope budget decision journal signature or identity invalid');
  for (const decision of journal.decisions) {
    const { signature: entrySignature, ...entryClaims } = decision;
    const issued = Date.parse(decision.issuedAt), expires = Date.parse(decision.expiresAt);
    if (decision.schemaVersion !== 'story-scope-budget-approval.v1' || decision.storyId !== storyId
      || decision.kind !== 'human-large-story' || decision.channel !== 'interactive-operator'
      || typeof decision.reason !== 'string' || decision.reason.trim().length < 20
      || !decision.bindingDigest || !decision.resultingScopeDigest || !Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued
      || expires - issued > SCOPE_BUDGET_DECISION_RUNTIME_POLICY.approvalLifetimeMs
      || !verifyValidationArtifact(entryClaims, entrySignature, root)) throw new Error('Scope budget approval signature or claims invalid');
  }
  return journal;
}
export function currentScopeBudgetApproval(store: StoryStore, root: string, storyId: string, bindingDigest: string): ScopeBudgetApproval | null {
  const journal = journalFor(store, root, storyId);
  return journal?.decisions.slice().reverse().find(decision => (decision.bindingDigest === bindingDigest || decision.resultingScopeDigest === bindingDigest)
    && Date.parse(decision.issuedAt) <= Date.now() && Date.parse(decision.expiresAt) > Date.now()) ?? null;
}

/** Read-only original authority; compatibility consumers cannot mint or extend it. */
export function unexpiredScopeBudgetApprovals(store: StoryStore, root: string, storyId: string): ScopeBudgetApproval[] {
  const now = Date.now();
  return journalFor(store, root, storyId)?.decisions.filter(decision =>
    Date.parse(decision.issuedAt) <= now && Date.parse(decision.expiresAt) > now) ?? [];
}

export function scopeBudgetDecisionReport(store: StoryStore, root: string, storyId: string, amendmentId?: string): StoryScopeBudgetReport {
  if (!amendmentId) return readStoryScopeBudget(store, root, storyId);
  if (store.readStory(storyId).phase !== 'DEV') throw new Error('An amendment budget decision requires DEV');
  const entry = createAcceptanceAmendmentController(store, root).show(storyId).entries.find(entry => entry.amendmentId === amendmentId);
  if (!entry || !['PROPOSED', 'REVIEWING', 'APPLYING'].includes(entry.state)) throw new Error('Scope budget requires a current pending signed amendment');
  const next = deriveAcceptanceAmendment(entry.base, entry.delta);
  if (canonicalDigest(entry.base) !== entry.baseDigest || canonicalDigest(next) !== entry.nextDigest) throw new Error('Scope budget amendment derivation binding invalid');
  const current = { storyId, checklist: store.readChecklist(storyId), scope: store.readScopeContract(storyId), proofStory: store.readProofStoryContract(storyId) };
  if (entry.state !== 'APPLYING') {
    if (canonicalDigest(current) !== entry.baseDigest) throw new Error('Scope budget amendment base drift; cancel and propose against current acceptance');
  } else {
    for (const key of ['checklist', 'scope', 'proofStory'] as const) {
      const digest = canonicalDigest(current[key]);
      if (digest !== canonicalDigest(entry.base[key]) && digest !== canonicalDigest(next[key])) throw new Error('Scope budget interrupted amendment drift');
    }
  }
  return readStoryScopeBudget(store, root, storyId, next, entry.base);
}

export interface ScopeBudgetApprovalArgs {
  storyId: string;
  amendmentId?: string;
  bindingDigest: string;
  ack: boolean;
  confirmationToken: string;
  reason: string;
}
function assertOperator(args: ScopeBudgetApprovalArgs): void {
  if (!isInteractiveAckAllowed(process.env, process.stdin.isTTY) || process.stdout.isTTY !== true) {
    throw new Error('Scope budget approval requires an interactive operator at a terminal');
  }
  if (SCOPE_BUDGET_DECISION_RUNTIME_POLICY.agentEnvironmentMarkers.some(key => Boolean(process.env[key]?.trim()))) {
    throw new Error('Scope budget approval is refused in an agent session; an operator must acknowledge the exact scope');
  }
  if (args.ack !== true) throw new Error('Scope budget approval requires explicit ack');
  if (args.confirmationToken !== `APPROVE LARGE STORY ${args.storyId} ${args.bindingDigest}`) throw new Error('Scope budget confirmation token does not match the exact Story and binding');
  if (typeof args.reason !== 'string' || args.reason.trim().length < 20) throw new Error('Scope budget approval requires a substantive operator reason of at least 20 characters');
}
export function approveStoryScopeBudget(store: StoryStore, root: string, args: ScopeBudgetApprovalArgs): ScopeBudgetApproval {
  assertOperator(args);
  return withReviewInventoryMutationLock(store, args.storyId, () => {
    if (!['INIT_CHECK', 'PLAN', 'DEV', 'REVIEW', 'TEST'].includes(store.readStory(args.storyId).phase)) throw new Error('Scope budget approval is available only before or during implementation and verification');
    const report = scopeBudgetDecisionReport(store, root, args.storyId, args.amendmentId);
    if (!report.bindingDigest || report.bindingDigest !== args.bindingDigest) throw new Error('Scope budget approval binding is stale; inspect the current scope again');
    if (report.diagnostics.length || !report.exceeded.length || !['decision_required', 'approved_large_story'].includes(report.status)) {
      throw new Error('Only known over-budget scope may receive a large-Story approval; unknown scope requires repair');
    }
    const journal = journalFor(store, root, args.storyId);
    const current = currentScopeBudgetApproval(store, root, args.storyId, args.bindingDigest);
    if (current?.reason === args.reason.trim()) return current;
    // The acknowledgement covers both the exact growth from its base and the
    // resulting scope, so successful application does not erase its permission.
    let resultingScopeDigest = report.bindingDigest;
    if (args.amendmentId) {
      const entry = createAcceptanceAmendmentController(store, root).show(args.storyId).entries.find(entry => entry.amendmentId === args.amendmentId);
      if (!entry) throw new Error('Scope budget amendment disappeared');
      resultingScopeDigest = readStoryScopeBudget(store, root, args.storyId, deriveAcceptanceAmendment(entry.base, entry.delta)).bindingDigest;
    }
    const issued = Date.now();
    const claims = { schemaVersion: 'story-scope-budget-approval.v1' as const, kind: 'human-large-story' as const,
      storyId: args.storyId, bindingDigest: args.bindingDigest, resultingScopeDigest, reason: args.reason.trim(),
      issuedAt: new Date(issued).toISOString(), expiresAt: new Date(issued + SCOPE_BUDGET_DECISION_RUNTIME_POLICY.approvalLifetimeMs).toISOString(),
      channel: 'interactive-operator' as const };
    const decision = { ...claims, signature: signValidationArtifact(claims, root) };
    const next = { schemaVersion: 'story-scope-budget-decisions.v1' as const, storyId: args.storyId, decisions: [...(journal?.decisions ?? []), decision] };
    store.writeScopeBudgetDecisions(args.storyId, { ...next, signature: signValidationArtifact(next, root) });
    return decision;
  });
}
