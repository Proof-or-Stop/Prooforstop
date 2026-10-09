/**
 * Evidence-chain reviewer items are framework actions, not review findings.
 *
 * A review finding must be a real product defect: a behavior with no test at
 * all, an assertion that does not check the behavior, a missing edge case.
 * Problems in the evidence chain (a stale receipt, an intent with no pinned
 * command or no receipt, an existing test that no intent's pinned command
 * selects) are owned by the framework: the pre-REVIEW evidence-chain check
 * (core/evidence-chain-check.ts) detects them mechanically and names one next
 * action. A reviewer that still reports one tags it with
 * category="evidence_chain"; the importer then reclassifies it as a framework
 * action (logged, never a blocking finding) instead of dropping it.
 *
 * Leaf module (its only import is the leaf metadata-finding-class), so the
 * proposal validator (host-run), the managed evidence verifier and the importer
 * can share it without new cycles.
 *
 * Old-PoS run 31: Story-metadata findings (core/metadata-finding-class.ts) are
 * reclassified the same way: never stored as Findings, logged as
 * review_metadata_finding_reclassified, and routed by next to ONE owner
 * checklist_update (core/metadata-correction.ts). Inventory-critic proposals
 * keep them (their dispositions index the proposal findings); a stored
 * metadata finding is routed the same way and never repaired.
 */
import { isStoryMetadataFinding } from './metadata-finding-class.js';

export const EVIDENCE_CHAIN_FINDING_CATEGORY = 'evidence_chain' as const;

/** Categories a reviewer may author. `evidence_chain` never becomes a stored Finding. */
export const REVIEWER_AUTHORED_FINDING_CATEGORIES = ['happy', 'edge', 'adversarial', 'missing', EVIDENCE_CHAIN_FINDING_CATEGORY] as const;
export type ReviewerAuthoredFindingCategory = typeof REVIEWER_AUTHORED_FINDING_CATEGORIES[number];

export function isEvidenceChainFindingCategory(category: unknown): boolean {
  return category === EVIDENCE_CHAIN_FINDING_CATEGORY;
}

export interface IndexedProposalFinding<T> { finding: T; index: number }

/** Split a proposal's findings into product findings and evidence-chain items, keeping proposal indexes. */
export function splitEvidenceChainFindings<T extends { category?: unknown }>(findings: readonly T[] | undefined): {
  product: IndexedProposalFinding<T>[];
  evidenceChain: IndexedProposalFinding<T>[];
} {
  const product: IndexedProposalFinding<T>[] = [];
  const evidenceChain: IndexedProposalFinding<T>[] = [];
  (findings ?? []).forEach((finding, index) => {
    (isEvidenceChainFindingCategory(finding.category) ? evidenceChain : product).push({ finding, index });
  });
  return { product, evidenceChain };
}

type ProposalFinding = { category?: unknown; files?: readonly string[] | null; desc?: string | null };

/**
 * Split a lane proposal's findings into product findings, evidence-chain items
 * and Story-metadata findings (old-PoS run 31), keeping proposal indexes.
 * `divertMetadata` is false for an inventory-critic proposal.
 */
export function splitReviewProposalFindings<T extends ProposalFinding>(findings: readonly T[] | undefined, divertMetadata: boolean): {
  product: IndexedProposalFinding<T>[];
  evidenceChain: IndexedProposalFinding<T>[];
  metadata: IndexedProposalFinding<T>[];
} {
  const split = splitEvidenceChainFindings(findings);
  if (!divertMetadata) return { ...split, metadata: [] };
  return { product: split.product.filter(row => !isStoryMetadataFinding(row.finding)),
    evidenceChain: split.evidenceChain,
    metadata: split.product.filter(row => isStoryMetadataFinding(row.finding)) };
}

/** Whether a sealed proposal is an inventory-critic proposal (it keeps metadata findings). */
export function isCriticProposal(proposal: { inventoryCritic?: unknown }): boolean {
  return proposal.inventoryCritic !== undefined && proposal.inventoryCritic !== null;
}

/**
 * The import conclusion of a sealed proposal. A "findings" proposal whose every
 * finding is an evidence-chain item or (lane proposals) a Story-metadata
 * finding carries no product finding, so it is imported as a pass with a
 * deterministic note (below); the sealed proposal stays the audit record of
 * what the reviewer wrote.
 */
export function effectiveManagedReviewConclusion(proposal: { conclusion: 'pass' | 'findings'; findings?: ReadonlyArray<ProposalFinding>; inventoryCritic?: unknown }): 'pass' | 'findings' {
  if (proposal.conclusion !== 'findings') return proposal.conclusion;
  const split = splitReviewProposalFindings(proposal.findings, !isCriticProposal(proposal));
  return split.product.length === 0 && split.evidenceChain.length + split.metadata.length > 0 ? 'pass' : 'findings';
}

/** Whether a sealed proposal finding is admissible as a stored Finding (not an evidence-chain item, not a lane metadata finding). */
export function isAdmissibleProposalFinding(proposal: { inventoryCritic?: unknown }, candidate: ProposalFinding): boolean {
  if (isEvidenceChainFindingCategory(candidate.category)) return false;
  return isCriticProposal(proposal) || !isStoryMetadataFinding(candidate);
}

const NOTE_ITEM_MAX_CHARS = 240;

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > NOTE_ITEM_MAX_CHARS ? `${flat.slice(0, NOTE_ITEM_MAX_CHARS)}...` : flat;
}

/**
 * Deterministic note of a pass imported from an evidence-chain-only proposal.
 * The verifier recomputes it from the sealed proposal, so it binds exactly.
 */
export function evidenceChainReclassifiedPassNote(items: ReadonlyArray<{ desc: string; files?: readonly string[] }>): string {
  return [
    `No product finding: the reviewer reported only ${items.length} evidence-chain item(s), reclassified as framework actions (not findings):`,
    ...items.map((item, position) => `${position + 1}. ${oneLine(item.desc)}${item.files?.length ? ` [${item.files.join(', ')}]` : ''}`),
    'The pre-REVIEW evidence-chain check (pre_review_check_read) owns these; it names the one next action.',
  ].join('\n');
}

/**
 * Deterministic note of a pass imported from a proposal whose findings are all
 * evidence-chain items and/or Story-metadata findings. Evidence-chain-only
 * proposals keep the exact evidenceChainReclassifiedPassNote.
 */
export function reclassifiedPassNote(findings: ReadonlyArray<ProposalFinding & { desc: string }>, critic = false): string {
  const evidenceChain = findings.filter(row => isEvidenceChainFindingCategory(row.category));
  const metadata = critic ? [] : findings.filter(row => !isEvidenceChainFindingCategory(row.category) && isStoryMetadataFinding(row));
  if (metadata.length === 0) return evidenceChainReclassifiedPassNote(evidenceChain as ReadonlyArray<{ desc: string; files?: readonly string[] }>);
  return [
    `No product finding: the reviewer reported ${evidenceChain.length} evidence-chain item(s) and ${metadata.length} Story-metadata finding(s), reclassified as framework actions (not findings):`,
    ...[...evidenceChain, ...metadata].map((item, position) => `${position + 1}. ${oneLine(item.desc)}${item.files?.length ? ` [${item.files.join(', ')}]` : ''}`),
    'Metadata findings are owner checklist corrections (next names one checklist_update); evidence-chain items belong to the pre-REVIEW evidence-chain check.',
  ].join('\n');
}
