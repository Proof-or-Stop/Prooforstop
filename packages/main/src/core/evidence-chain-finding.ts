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
 * Leaf module: no imports, so the proposal validator (host-run), the managed
 * evidence verifier and the importer can share it without new cycles.
 */

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

/**
 * The import conclusion of a sealed proposal. A "findings" proposal whose every
 * finding is an evidence-chain item carries no product finding, so it is
 * imported as a pass with a deterministic note (below); the sealed proposal
 * stays the audit record of what the reviewer wrote.
 */
export function effectiveManagedReviewConclusion(proposal: { conclusion: 'pass' | 'findings'; findings?: ReadonlyArray<{ category?: unknown }> }): 'pass' | 'findings' {
  if (proposal.conclusion !== 'findings') return proposal.conclusion;
  const split = splitEvidenceChainFindings(proposal.findings);
  return split.product.length === 0 && split.evidenceChain.length > 0 ? 'pass' : 'findings';
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
