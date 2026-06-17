/**
 * B-8387 (Experience Layer Phase 2): staged Process Playbook lifecycle.
 *
 * Four commands distil a resolved finding into a human-approved candidate
 * playbook:
 *   playbook_propose --finding <id>            -> proposals/<id>.json (proposed)
 *   playbook_diff <proposalId>                 -> read-only render (no mutation)
 *   playbook_approve <proposalId> --expected…  -> playbooks.json candidate
 *   playbook_reject <proposalId>               -> discard the proposal
 *
 * HARD GUARDRAILS (load-bearing — enforced by smoke + static grep):
 *   • This handler NEVER files a finding. It imports no finding-writing handler,
 *     no review gate, and no blocking-decision surface. It only READS findings
 *     through the store read port (`ctx.store.readFindings`).
 *   • `playbook_approve` fails CLOSED on a stale/missing `--expectedProposalDigest`
 *     (cloning the decision_doc_save pattern), and writes the candidate at
 *     status `candidate` — NEVER `active`. Promotion to active is an explicit
 *     out-of-scope human step.
 *
 * Imports stay minimal: `node:` builtins are not needed; the only outward imports
 * are the leaf types, the learning-store (which itself only touches
 * `.lattice/learning/` and `./digest.js`), and the HandlerContext for the store
 * read port.
 */

import type {
  Playbook,
  PlaybookLineage,
  PlaybookProposal,
  PlaybookTrigger,
} from '../core/experience-layer-types.js';
import {
  appendPlaybook,
  computePlaybookProposalDigest,
  deleteProposal,
  listProposals,
  readProposal,
  writeProposal,
} from '../core/learning-store.js';
import type { Finding } from '../core/types.js';
import type { HandlerContext } from './context.js';

const PROPOSAL_ID_RE = /^PBP-(\d{3})$/;

/** Mint the next `PBP-NNN` id given the proposals already on disk. */
function nextProposalId(existing: PlaybookProposal[]): string {
  let max = 0;
  for (const proposal of existing) {
    const match = proposal.id.match(PROPOSAL_ID_RE);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `PBP-${String(max + 1).padStart(3, '0')}`;
}

/**
 * The storyId is embedded in a finding id (`B-xxx:F-NNN`). Parse the prefix so
 * the source story's findings.json can be read through the store port.
 */
function storyIdFromFindingId(findingId: string): string | null {
  const idx = findingId.indexOf(':');
  if (idx <= 0) return null;
  return findingId.slice(0, idx);
}

/** Lower-cased, deduped, sorted token list (drops blanks). */
function uniqSorted(values: Iterable<string>): string[] {
  const set = new Set<string>();
  for (const v of values) {
    const t = (v ?? '').trim();
    if (t) set.add(t);
  }
  return [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Coarse file-kind bucket: the file extension (without dot), or `noext`. */
function fileKind(path: string): string {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : 'noext';
}

/** Seed up to a few keyword tokens from the finding description (alnum words >=4). */
function seedKeywords(desc: string): string[] {
  const words = (desc.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
  return uniqSorted(words).slice(0, 8);
}

/** Build the surfacing trigger from the source finding. */
function buildTrigger(finding: Finding): PlaybookTrigger {
  const files = finding.files ?? [];
  return {
    keywords: seedKeywords(finding.desc ?? ''),
    fileKinds: uniqSorted(files.map(fileKind)),
    storyPhases: ['REVIEW'],
  };
}

/** Render the candidate Playbook a proposal would become on approve. */
function candidateFromProposal(proposal: PlaybookProposal): Playbook {
  return {
    id: proposal.id,
    title: proposal.title,
    trigger: proposal.trigger,
    check: proposal.check,
    pitfalls: proposal.pitfalls,
    verification: proposal.verification,
    lineage: proposal.lineage,
    status: 'candidate',
    usage: { surfacedCount: 0, resolvedHits: 0, dismissedHits: 0 },
  };
}

function renderTriggerLine(trigger: PlaybookTrigger): string {
  return [
    `keywords=[${trigger.keywords.join(', ')}]`,
    `fileKinds=[${trigger.fileKinds.join(', ')}]`,
    `storyPhases=[${trigger.storyPhases.join(', ')}]`,
  ].join(' ');
}

export function createPlaybookHandlers(ctx: HandlerContext) {
  return {
    /**
     * Distil a resolved finding into a staged proposal. Reads the finding ONLY
     * through the store read port (never files one). The optional `storyId`
     * narrows the search; otherwise the storyId is parsed from the finding id.
     */
    playbook_propose(args: { finding: string; storyId?: string }): string {
      const findingId = typeof args.finding === 'string' ? args.finding.trim() : '';
      if (!findingId) throw new Error('playbook_propose requires --finding <findingId>');

      const storyId = (args.storyId && args.storyId.trim()) || storyIdFromFindingId(findingId);
      if (!storyId) {
        throw new Error(`playbook_propose: cannot determine storyId from finding "${findingId}"; pass --storyId`);
      }

      const finding = ctx.store.readFindings(storyId).findings.find((f) => f.id === findingId);
      if (!finding) {
        throw new Error(`playbook_propose: finding not found: ${findingId} (story ${storyId})`);
      }

      const lineage: PlaybookLineage = {
        sourceStoryId: storyId,
        sourceFindingId: finding.id,
        ...(finding.signatureTag ? { sourceSignature: finding.signatureTag } : {}),
      };

      const desc = (finding.desc ?? '').trim();
      const proposal: PlaybookProposal = {
        id: nextProposalId(listProposals(ctx.root)),
        title: desc ? `Playbook: ${desc.slice(0, 80)}` : `Playbook from ${finding.id}`,
        trigger: buildTrigger(finding),
        check: desc
          ? `Proactively check for: ${desc}`
          : `Proactively check for the pattern behind ${finding.id}`,
        pitfalls: desc ? [desc] : [],
        verification: [`Confirm the condition behind ${finding.id} cannot recur`],
        lineage,
        status: 'proposed',
        proposalDigest: '',
      };
      proposal.proposalDigest = computePlaybookProposalDigest(proposal);

      writeProposal(ctx.root, proposal);
      return [
        `Playbook proposal ${proposal.id} staged`,
        `sourceFinding: ${lineage.sourceFindingId}`,
        `sourceStory: ${lineage.sourceStoryId}`,
        ...(lineage.sourceSignature ? [`sourceSignature: ${lineage.sourceSignature}`] : []),
        `proposalDigest: ${proposal.proposalDigest}`,
      ].join('\n');
    },

    /** Read-only render of the candidate `approve` would write. NO mutation. */
    playbook_diff(args: { proposalId: string }): string {
      const proposalId = typeof args.proposalId === 'string' ? args.proposalId.trim() : '';
      if (!proposalId) throw new Error('playbook_diff requires <proposalId>');
      const proposal = readProposal(ctx.root, proposalId);
      if (!proposal) throw new Error(`playbook_diff: proposal not found: ${proposalId}`);

      const candidate = candidateFromProposal(proposal);
      return [
        `Playbook diff for proposal ${proposal.id} (read-only; approve would write this candidate):`,
        `  id: ${candidate.id}`,
        `  status: ${candidate.status} (active is NEVER auto-set)`,
        `  title: ${candidate.title}`,
        `  trigger: ${renderTriggerLine(candidate.trigger)}`,
        `  check: ${candidate.check}`,
        `  pitfalls: ${candidate.pitfalls.length}`,
        ...candidate.pitfalls.map((p) => `    - ${p}`),
        `  verification: ${candidate.verification.length}`,
        ...candidate.verification.map((v) => `    - ${v}`),
        `  lineage: story=${candidate.lineage.sourceStoryId} finding=${candidate.lineage.sourceFindingId}${candidate.lineage.sourceSignature ? ` signature=${candidate.lineage.sourceSignature}` : ''}`,
        `  proposalDigest: ${proposal.proposalDigest}`,
      ].join('\n');
    },

    /**
     * Approve a staged proposal into a CANDIDATE playbook. Fails CLOSED unless
     * `--expectedProposalDigest` byte-matches the stored digest (clone of
     * decision_doc_save). On match: append the candidate to playbooks.json
     * (status=candidate, lineage carried, usage zeroed) and delete the proposal.
     */
    playbook_approve(args: { proposalId: string; expectedProposalDigest?: string }): string {
      const proposalId = typeof args.proposalId === 'string' ? args.proposalId.trim() : '';
      if (!proposalId) throw new Error('playbook_approve requires <proposalId>');

      const expected = typeof args.expectedProposalDigest === 'string' ? args.expectedProposalDigest.trim() : '';
      if (!expected) {
        throw new Error('playbook_approve requires --expectedProposalDigest; refuse to approve without an explicit digest');
      }

      const proposal = readProposal(ctx.root, proposalId);
      if (!proposal) throw new Error(`playbook_approve: proposal not found: ${proposalId}`);

      // FAIL CLOSED: the stored digest must itself be self-consistent AND match
      // the caller's expected digest. A tampered/stale proposal is rejected.
      const computed = computePlaybookProposalDigest(proposal);
      if (proposal.proposalDigest !== computed) {
        throw new Error(`playbook_approve: proposal ${proposal.id} digest is inconsistent; re-propose before approving`);
      }
      if (expected !== computed) {
        throw new Error(`playbook_approve: expectedProposalDigest is stale for ${proposal.id}; refresh via playbook_diff before approving`);
      }

      const candidate = candidateFromProposal(proposal);
      appendPlaybook(ctx.root, candidate);
      deleteProposal(ctx.root, proposal.id);

      return [
        `Playbook ${candidate.id} approved as candidate`,
        `status: ${candidate.status} (active requires an explicit human promotion; not auto-set)`,
        `lineage: story=${candidate.lineage.sourceStoryId} finding=${candidate.lineage.sourceFindingId}${candidate.lineage.sourceSignature ? ` signature=${candidate.lineage.sourceSignature}` : ''}`,
        `proposal ${proposal.id} cleared`,
      ].join('\n');
    },

    /** Discard a staged proposal. Clear error when the proposal is absent. */
    playbook_reject(args: { proposalId: string }): string {
      const proposalId = typeof args.proposalId === 'string' ? args.proposalId.trim() : '';
      if (!proposalId) throw new Error('playbook_reject requires <proposalId>');
      const removed = deleteProposal(ctx.root, proposalId);
      if (!removed) throw new Error(`playbook_reject: proposal not found: ${proposalId}`);
      return `Playbook proposal ${proposalId} rejected and removed.`;
    },
  };
}
