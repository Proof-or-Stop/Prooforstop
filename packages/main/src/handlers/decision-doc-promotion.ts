import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { digestCanonicalJson, digestText } from '../core/digest.js';
// Backward-compat re-exports (B-2ccc CHK-002:edge:0): downstream consumers that
// imported these from this module before the extraction keep working.
export { canonicalJson, digestCanonicalJson, digestText } from '../core/digest.js';
export type { Digestable } from '../core/digest.js';
import { currentGitHead, currentMaterialHash } from '../core/evidence-freshness.js';
import { digestScopeExtensionDecision, digestScopeExtensionProposal } from '../core/scope-anti-expansion.js';
import type {
  DecisionData,
  DecisionDocProposal,
  DecisionDocProposalAlternative,
  DecisionDocProposalFile,
  DecisionDocProposalSourceDecision,
  ScopeContractData,
  ScopeExtensionProposal,
  ScopeExtensionProposalData,
} from '../core/types.js';
import type { HandlerContext } from './context.js';

const PROPOSAL_SCHEMA_VERSION = 'lattice.decision_doc_proposals.v1' as const;
const DECISION_DOC_DIR = 'docs/requirements/decisions';
const PROPOSAL_ID_RE = /^DDP-(\d{3})$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type DecisionDocProposalArgs = {
  storyId: string;
  proposalId?: string;
  slug: string;
  targetPath?: string;
  title: string;
  sourceDecision?: DecisionDocProposalSourceDecision;
  decision: string;
  context: string;
  scope: string;
  nonGoals: string[];
  chosenApproach: string;
  alternatives: DecisionDocProposalAlternative[];
  operationalRules: string[];
  verificationRequirements: string[];
  risks: string[];
};

type DecisionDocSaveArgs = {
  storyId: string;
  proposalId: string;
  mode: 'create' | 'update';
  confirm?: boolean;
  targetPath?: string;
  expectedProposalDigest: string;
  expectedSourceDecisionDigest?: string;
};

type DecisionDocPreviewArgs = {
  storyId: string;
  proposalId: string;
};

function canonicalTargetPath(slug: string): string {
  return `${DECISION_DOC_DIR}/${slug}.md`;
}

function normalizeRelPath(path: string, label: string): string {
  const trimmed = path.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!trimmed) throw new Error(`${label} is required`);
  if (trimmed.startsWith('/') || trimmed.includes('\0')) {
    throw new Error(`${label} must be a safe relative path`);
  }
  const parts = trimmed.split('/');
  if (parts.some((part) => part === '..' || part === '.')) {
    throw new Error(`${label} must not contain traversal segments`);
  }
  return trimmed;
}

function validateSlug(value: unknown): string {
  if (typeof value !== 'string') throw new Error('slug is required');
  const slug = value.trim();
  if (!SLUG_RE.test(slug)) {
    throw new Error('slug must be lowercase kebab-case without dots, slashes, or traversal');
  }
  return slug;
}

function assertCanonicalTargetPath(slug: string, targetPath: string): void {
  const canonical = canonicalTargetPath(slug);
  const normalized = normalizeRelPath(targetPath, 'targetPath');
  if (normalized !== canonical) {
    throw new Error(`custom target paths are not supported; expected ${canonical}`);
  }
  const suffix = normalized.slice(`${DECISION_DOC_DIR}/`.length);
  if (!normalized.startsWith(`${DECISION_DOC_DIR}/`) || suffix.includes('/') || !suffix.endsWith('.md')) {
    throw new Error(`targetPath must be a direct Markdown file under ${DECISION_DOC_DIR}`);
  }
}

function requireText(value: unknown, field: string, minLength: number): string {
  if (typeof value !== 'string') throw new Error(`${field} is required`);
  const trimmed = value.trim();
  if (trimmed.length < minLength) throw new Error(`${field} must be at least ${minLength} characters`);
  return trimmed;
}

function requireReviewedDigest(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} is required`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} is required`);
  return trimmed;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${field} must be a non-empty array`);
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new Error(`${field}[${index}] must be a non-empty string`);
    }
    return item.trim();
  });
}

function validateAlternatives(value: unknown): DecisionDocProposalAlternative[] {
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error('alternatives must contain at least two entries');
  }
  return value.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`alternatives[${index}] must be an object`);
    const record = item as Record<string, unknown>;
    return {
      name: requireText(record.name, `alternatives[${index}].name`, 3),
      pros: requireStringArray(record.pros, `alternatives[${index}].pros`),
      cons: requireStringArray(record.cons, `alternatives[${index}].cons`),
    };
  });
}

function validateSourceDecision(value: unknown): DecisionDocProposalSourceDecision {
  if (value === undefined) return 'decision.json';
  if (value === 'decision.json' || value === 'manual') return value;
  throw new Error('sourceDecision must be "decision.json" or "manual"');
}

function digestDecision(decision: DecisionData | null, storyId: string): string {
  if (!decision) throw new Error(`Story ${storyId} has no decision.json; use sourceDecision:"manual" only for manual proposals`);
  return digestCanonicalJson(decision);
}

function proposalDigestDomain(proposal: DecisionDocProposal): Omit<DecisionDocProposal, 'proposalDigest' | 'saves' | 'savedAt' | 'savedCommit'> {
  const { proposalDigest: _proposalDigest, saves: _saves, savedAt: _savedAt, savedCommit: _savedCommit, ...domain } = proposal;
  return domain;
}

export function computeDecisionDocProposalDigest(proposal: DecisionDocProposal): string {
  return digestCanonicalJson(proposalDigestDomain(proposal));
}

function nextProposalId(file: DecisionDocProposalFile): string {
  let max = 0;
  for (const proposal of file.proposals) {
    const match = proposal.id.match(PROPOSAL_ID_RE);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `DDP-${String(max + 1).padStart(3, '0')}`;
}

function loadProposal(file: DecisionDocProposalFile, proposalId: string): DecisionDocProposal {
  const proposal = file.proposals.find((item) => item.id === proposalId);
  if (!proposal) throw new Error(`Decision doc proposal not found: ${proposalId}`);
  return proposal;
}

function assertProposalIntegrity(proposal: DecisionDocProposal): string {
  const computed = computeDecisionDocProposalDigest(proposal);
  if (proposal.proposalDigest !== computed) {
    throw new Error(`proposal digest mismatch for ${proposal.id}; refresh the proposal before saving`);
  }
  return computed;
}

function bullet(value: string): string {
  return `- ${value.replace(/\s+/g, ' ').trim()}`;
}

export function renderDecisionDocMarkdown(storyId: string, proposal: DecisionDocProposal): string {
  const created = (proposal.createdAt || new Date().toISOString()).slice(0, 10);
  const lines: string[] = [
    `# ${proposal.title}`,
    '',
    'Status: accepted',
    `Source story: ${storyId}`,
    `Source proposal: ${proposal.id}`,
    `Created: ${created}`,
    '',
    '## Decision',
    '',
    proposal.decision,
    '',
    '## Context',
    '',
    proposal.context,
    '',
    '## Scope',
    '',
    proposal.scope,
    '',
    '## Non-Goals',
    '',
    ...proposal.nonGoals.map(bullet),
    '',
    '## Options Considered',
    '',
  ];
  for (const alternative of proposal.alternatives) {
    lines.push(
      `### ${alternative.name}`,
      '',
      'Pros:',
      ...alternative.pros.map(bullet),
      '',
      'Cons:',
      ...alternative.cons.map(bullet),
      '',
    );
  }
  lines.push(
    '## Chosen Approach',
    '',
    proposal.chosenApproach,
    '',
    '## Operational Rules',
    '',
    ...proposal.operationalRules.map(bullet),
    '',
    '## Verification Requirements',
    '',
    ...proposal.verificationRequirements.map(bullet),
    '',
    '## Risks',
    '',
    ...proposal.risks.map(bullet),
    '',
    '## Supersession',
    '',
    'If this decision changes, update this file through a Proofbound story. Because',
    'this file is under `docs/requirements/decisions/*.md`, DONE requires the local',
    'decision-doc 3x2 host verdict quorum.',
    '',
  );
  return lines.join('\n');
}

function pathMatchesPattern(filePath: string, pattern: string): boolean {
  if (filePath === pattern) return true;
  if (filePath.startsWith(pattern.endsWith('/') ? pattern : `${pattern}/`)) return true;
  const globless = pattern.replace(/\/\*\*?$/, '').replace(/\*$/, '');
  if (globless !== pattern && filePath.startsWith(globless)) return true;
  if (pattern.startsWith('*.') && filePath.endsWith(pattern.slice(1))) return true;
  return false;
}

function listMatches(filePath: string, patterns: readonly string[] | undefined): boolean {
  return (patterns ?? []).some((pattern) => pathMatchesPattern(filePath, pattern));
}

function contractCoversTarget(contract: ScopeContractData | null, targetPath: string, mode: 'create' | 'update'): boolean {
  if (!contract) return false;
  return mode === 'create'
    ? listMatches(targetPath, contract.allowedCreate)
    : listMatches(targetPath, contract.allowedModify);
}

function isAcceptedScopeExtensionDecision(value: unknown): boolean {
  return value === 'accepted' || value === 'approved';
}

function hasFreshAcceptedScopeExtensionSignature(proposal: ScopeExtensionProposal, storyId: string): boolean {
  try {
    if (proposal.storyId !== storyId) return false;
    if (!isAcceptedScopeExtensionDecision(proposal.status)) return false;
    if (!proposal.decision || !isAcceptedScopeExtensionDecision(proposal.decision.decision)) return false;
    if (proposal.decision._hash !== digestScopeExtensionDecision(proposal.proposalId, proposal.decision)) return false;
    return proposal._hash === digestScopeExtensionProposal(proposal);
  } catch {
    return false;
  }
}

function acceptedExtensionCoversTarget(data: ScopeExtensionProposalData, storyId: string, targetPath: string): boolean {
  if (data.storyId !== storyId) return false;
  return data.proposals.some((proposal) => {
    if (!hasFreshAcceptedScopeExtensionSignature(proposal, storyId)) return false;
    return listMatches(targetPath, proposal.patch.allowed ?? []);
  });
}

function assertTargetInScope(ctx: HandlerContext, storyId: string, targetPath: string, mode: 'create' | 'update'): void {
  const contract = ctx.store.readScopeContract(storyId);
  if (contractCoversTarget(contract, targetPath, mode)) return;
  const extensions = ctx.store.readScopeExtensionProposals(storyId);
  if (acceptedExtensionCoversTarget(extensions, storyId, targetPath)) return;
  const expectedField = mode === 'create' ? 'scope contract allowedCreate' : 'scope contract allowedModify';
  throw new Error(
    `decision_doc_save target ${targetPath} is outside story scope; declare it in ${expectedField} or a mechanically valid accepted/approved scope extension before saving`,
  );
}

function validatedProposalInput(args: DecisionDocProposalArgs, sourceDecisionDigest?: string): Omit<DecisionDocProposal, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'proposalDigest'> {
  const slug = validateSlug(args.slug);
  const targetPath = canonicalTargetPath(slug);
  if (args.targetPath !== undefined) assertCanonicalTargetPath(slug, args.targetPath);
  return {
    slug,
    targetPath,
    title: requireText(args.title, 'title', 5),
    sourceDecision: validateSourceDecision(args.sourceDecision),
    ...(sourceDecisionDigest ? { sourceDecisionDigest } : {}),
    decision: requireText(args.decision, 'decision', 10),
    context: requireText(args.context, 'context', 10),
    scope: requireText(args.scope, 'scope', 10),
    nonGoals: requireStringArray(args.nonGoals, 'nonGoals'),
    chosenApproach: requireText(args.chosenApproach, 'chosenApproach', 10),
    alternatives: validateAlternatives(args.alternatives),
    operationalRules: requireStringArray(args.operationalRules, 'operationalRules'),
    verificationRequirements: requireStringArray(args.verificationRequirements, 'verificationRequirements'),
    risks: requireStringArray(args.risks, 'risks'),
  };
}

function updateProposalFile(file: DecisionDocProposalFile, proposal: DecisionDocProposal): DecisionDocProposalFile {
  const existingIndex = file.proposals.findIndex((item) => item.id === proposal.id);
  const proposals = existingIndex >= 0
    ? file.proposals.map((item) => item.id === proposal.id ? proposal : item)
    : [...file.proposals, proposal];
  return {
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    storyId: file.storyId,
    updatedAt: proposal.updatedAt,
    proposals,
  };
}

export function createDecisionDocPromotionHandlers(ctx: HandlerContext) {
  return {
    decision_doc_proposal(args: DecisionDocProposalArgs): string {
      if (!args.storyId) throw new Error('storyId is required');
      ctx.store.readStory(args.storyId);
      const sourceDecision = validateSourceDecision(args.sourceDecision);
      const sourceDecisionDigest = sourceDecision === 'decision.json'
        ? digestDecision(ctx.store.readDecision(args.storyId), args.storyId)
        : undefined;
      const input = validatedProposalInput({ ...args, sourceDecision }, sourceDecisionDigest);

      const existingFile = ctx.store.readDecisionDocProposals(args.storyId);
      if (existingFile.schemaVersion && existingFile.schemaVersion !== PROPOSAL_SCHEMA_VERSION) {
        throw new Error(`Unsupported decision-doc proposal schema: ${existingFile.schemaVersion}`);
      }
      let existing: DecisionDocProposal | undefined;
      if (args.proposalId) {
        existing = loadProposal(existingFile, args.proposalId);
        if (existing.status === 'saved') {
          throw new Error(`saved proposal ${args.proposalId} cannot be updated; create a new proposal`);
        }
        if (existing.status === 'rejected') {
          throw new Error(`rejected proposal ${args.proposalId} cannot be updated; create a new proposal`);
        }
      }

      const now = new Date().toISOString();
      const proposal: DecisionDocProposal = {
        ...input,
        id: existing?.id ?? nextProposalId(existingFile),
        status: 'proposed',
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        proposalDigest: '',
      };
      proposal.proposalDigest = computeDecisionDocProposalDigest(proposal);
      ctx.store.writeDecisionDocProposals(args.storyId, updateProposalFile(existingFile, proposal));
      ctx.store.appendProcessEvent(args.storyId, {
        type: 'decision_doc_proposal',
        storyId: args.storyId,
        command: 'decision_doc_proposal',
        proposalId: proposal.id,
        targetPath: proposal.targetPath,
        sourceDecision: proposal.sourceDecision,
        sourceDecisionDigest: proposal.sourceDecisionDigest,
        proposalDigest: proposal.proposalDigest,
      });
      return [
        `Decision doc proposal ${proposal.id} saved`,
        `targetPath: ${proposal.targetPath}`,
        `proposalDigest: ${proposal.proposalDigest}`,
        ...(proposal.sourceDecisionDigest ? [`sourceDecisionDigest: ${proposal.sourceDecisionDigest}`] : []),
      ].join('\n');
    },

    decision_doc_preview(args: DecisionDocPreviewArgs): string {
      if (!args.storyId) throw new Error('storyId is required');
      ctx.store.readStory(args.storyId);
      const file = ctx.store.readDecisionDocProposals(args.storyId);
      const proposal = loadProposal(file, args.proposalId);
      const markdown = renderDecisionDocMarkdown(args.storyId, proposal);
      const targetAbs = join(ctx.root, proposal.targetPath);
      return [
        `Decision doc preview for ${proposal.id}`,
        `Target: ${proposal.targetPath}`,
        `Target exists: ${existsSync(targetAbs) ? 'yes' : 'no'}`,
        '',
        markdown,
      ].join('\n');
    },

    decision_doc_save(args: DecisionDocSaveArgs): string {
      if (!args.storyId) throw new Error('storyId is required');
      if (args.confirm !== true) throw new Error('decision_doc_save requires confirm:true');
      if (args.mode !== 'create' && args.mode !== 'update') throw new Error('mode must be "create" or "update"');
      ctx.store.readStory(args.storyId);

      const file = ctx.store.readDecisionDocProposals(args.storyId);
      const proposal = loadProposal(file, args.proposalId);
      if (proposal.status === 'rejected' || proposal.status === 'superseded') {
        throw new Error(`decision_doc_save refused ${proposal.status} proposal ${proposal.id}`);
      }
      const proposalDigest = assertProposalIntegrity(proposal);
      const expectedProposalDigest = requireReviewedDigest(args.expectedProposalDigest, 'expectedProposalDigest');
      if (expectedProposalDigest !== proposalDigest) {
        throw new Error(`expectedProposalDigest is stale for ${proposal.id}`);
      }

      const canonical = canonicalTargetPath(proposal.slug);
      assertCanonicalTargetPath(proposal.slug, proposal.targetPath);
      if (args.targetPath !== undefined) assertCanonicalTargetPath(proposal.slug, args.targetPath);
      if (proposal.targetPath !== canonical) {
        throw new Error(`proposal target path is not canonical: expected ${canonical}`);
      }

      let sourceDecisionDigest: string | undefined;
      if (proposal.sourceDecision === 'decision.json') {
        const expectedSourceDecisionDigest = requireReviewedDigest(args.expectedSourceDecisionDigest, 'expectedSourceDecisionDigest');
        sourceDecisionDigest = digestDecision(ctx.store.readDecision(args.storyId), args.storyId);
        if (!proposal.sourceDecisionDigest || proposal.sourceDecisionDigest !== sourceDecisionDigest) {
          throw new Error(`source decision digest is stale for ${proposal.id}; refresh the proposal before saving`);
        }
        if (expectedSourceDecisionDigest !== sourceDecisionDigest) {
          throw new Error(`expectedSourceDecisionDigest is stale for ${proposal.id}`);
        }
      } else if (args.expectedSourceDecisionDigest !== undefined) {
        throw new Error('expectedSourceDecisionDigest is only valid when sourceDecision is "decision.json"');
      }

      const targetAbs = join(ctx.root, proposal.targetPath);
      const targetExists = existsSync(targetAbs);
      if (targetExists && args.mode !== 'update') {
        throw new Error(`target already exists; rerun with mode:"update" to update ${proposal.targetPath}`);
      }
      if (!targetExists && args.mode !== 'create') {
        throw new Error(`target does not exist; rerun with mode:"create" to create ${proposal.targetPath}`);
      }

      assertTargetInScope(ctx, args.storyId, proposal.targetPath, args.mode);

      const headHash = currentGitHead(ctx.root);
      const materialHash = currentMaterialHash(ctx.root);
      if (!headHash || !materialHash) {
        throw new Error('decision_doc_save requires readable git HEAD and material hash');
      }

      const markdown = renderDecisionDocMarkdown(args.storyId, proposal);
      const renderedDocDigest = digestText(markdown);
      mkdirSync(dirname(targetAbs), { recursive: true });
      writeFileSync(targetAbs, markdown, 'utf-8');

      const now = new Date().toISOString();
      const saveRecord = {
        savedAt: now,
        savedCommit: headHash,
        targetPath: proposal.targetPath,
        ...(sourceDecisionDigest ? { sourceDecisionDigest } : {}),
        proposalDigest,
        renderedDocDigest,
        headHash,
        materialHash,
        mode: args.mode,
      };
      const savedProposal: DecisionDocProposal = {
        ...proposal,
        status: 'saved',
        updatedAt: now,
        savedAt: now,
        savedCommit: headHash,
        saves: [...(proposal.saves ?? []), saveRecord],
      };
      savedProposal.proposalDigest = computeDecisionDocProposalDigest(savedProposal);
      ctx.store.writeDecisionDocProposals(args.storyId, updateProposalFile(file, savedProposal));
      ctx.store.appendProcessEvent(args.storyId, {
        type: 'decision_doc_save',
        storyId: args.storyId,
        command: 'decision_doc_save',
        proposalId: proposal.id,
        targetPath: proposal.targetPath,
        sourceDecisionDigest,
        proposalDigest,
        renderedDocDigest,
        headHash,
        materialHash,
        mode: args.mode,
        authorityBoundary: 'local workflow evidence only; not local proof-admissibility, receipt-bundle, quorum, or release readiness',
      });

      return [
        `Decision doc saved to ${proposal.targetPath}`,
        `proposalId: ${proposal.id}`,
        `proposalDigest: ${proposalDigest}`,
        `renderedDocDigest: ${renderedDocDigest}`,
        'authorityBoundary: local workflow evidence only; does not create proof-admissibility, receipt-bundle, quorum, authorityDone, fullAuthorityDone, or productionDone',
      ].join('\n');
    },
  };
}
