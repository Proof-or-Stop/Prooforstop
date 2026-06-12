import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import type { HandlerContext } from './context.js';

type JsonObject = Record<string, unknown>;

type ScopeBoundarySetArgs = {
  storyId: string;
  allowedScope: string[];
  excludedScope?: string[];
  userConfirmed?: boolean;
  confirmation?: string;
  actor?: string;
};

type ExecutionBoundarySetArgs = {
  storyId: string;
  allowedCommands?: string[];
  blockedCommands?: string[];
  allowedPaths?: string[];
  blockedPaths?: string[];
  notes?: string;
  actor?: string;
};

type ScopeFreezeCheckArgs = {
  storyId: string;
  status?: 'PASS' | 'FAIL' | 'pass' | 'fail';
  checks?: Array<{ id: string; status: 'PASS' | 'FAIL' | 'pass' | 'fail'; note?: string }>;
  note?: string;
  actor?: string;
};

type ScopeExtensionProposalArgs = {
  storyId: string;
  proposal: string;
  reason?: string;
  reviewer?: string;
  findingId?: string;
  evidenceRefs?: string[];
};

type ScopeExtensionDecideArgs = {
  storyId: string;
  proposalId: string;
  decision: 'accepted' | 'rejected';
  reason: string;
  decider?: string;
};

type ScopeAntiExpansionCore = {
  SCOPE_BOUNDARY_FILE?: string;
  EXECUTION_BOUNDARY_FILE?: string;
  SCOPE_FREEZE_CHECK_FILE?: string;
  SCOPE_EXTENSION_PROPOSALS_FILE?: string;
  SCOPE_EXTENSION_DECISIONS_FILE?: string;
  hashScopeAntiExpansionArtifact?: (value: unknown) => string;
  buildScopeBoundaryArtifact?: (input: {
    args: ScopeBoundarySetArgs;
    previous: JsonObject | null;
    now: string;
    actor: string;
  }) => JsonObject;
  buildExecutionBoundaryArtifact?: (input: {
    args: ExecutionBoundarySetArgs;
    previous: JsonObject | null;
    now: string;
    actor: string;
  }) => JsonObject;
  buildScopeFreezeCheckArtifact?: (input: {
    args: ScopeFreezeCheckArgs;
    scopeBoundary: JsonObject | null;
    executionBoundary: JsonObject | null;
    extensionDecisions: JsonObject | null;
    now: string;
    actor: string;
  }) => JsonObject;
  buildScopeExtensionProposalArtifact?: (input: {
    args: ScopeExtensionProposalArgs;
    proposalId: string;
    previous: JsonObject | null;
    now: string;
    actor: string;
    rejectedDirectionCount: number;
  }) => JsonObject;
  buildScopeExtensionDecisionArtifact?: (input: {
    args: ScopeExtensionDecideArgs;
    proposal: JsonObject;
    previous: JsonObject | null;
    freezeCheck: JsonObject | null;
    now: string;
    actor: string;
  }) => JsonObject;
};

const CORE_SPECIFIER = '../core/scope-anti-expansion.js';

const DEFAULT_SCOPE_BOUNDARY_FILE = 'scope-boundary.json';
const DEFAULT_EXECUTION_BOUNDARY_FILE = 'execution-boundary.json';
const DEFAULT_SCOPE_FREEZE_CHECK_FILE = 'scope-freeze-check.json';
const DEFAULT_SCOPE_EXTENSION_PROPOSALS_FILE = 'scope-extension-proposals.json';
const DEFAULT_SCOPE_EXTENSION_DECISIONS_FILE = 'scope-extension-decisions.json';

let coreCache: Promise<ScopeAntiExpansionCore> | null = null;

function loadCore(): Promise<ScopeAntiExpansionCore> {
  if (!coreCache) {
    // Worker A owns the pure core module. Keep this dynamic so this CLI slice can
    // build before that parallel file lands, while still naming the exact exports
    // expected by the integration contract above.
    coreCache = import(CORE_SPECIFIER)
      .then((mod) => mod as ScopeAntiExpansionCore)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code?: unknown }).code) : '';
        if (code === 'ERR_MODULE_NOT_FOUND' && message.includes('scope-anti-expansion')) return {};
        throw err;
      });
  }
  return coreCache;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  const obj = value as JsonObject;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableJson(obj[key])}`).join(',')}}`;
}

function withoutHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutHash);
  if (value === null || typeof value !== 'object') return value;
  const out: JsonObject = {};
  for (const [key, val] of Object.entries(value as JsonObject)) {
    if (key === 'hash') continue;
    out[key] = withoutHash(val);
  }
  return out;
}

function localHash(value: unknown): string {
  return createHash('sha256').update(stableJson(withoutHash(value))).digest('hex');
}

function withHash(core: ScopeAntiExpansionCore, artifact: JsonObject): JsonObject {
  const hash = core.hashScopeAntiExpansionArtifact
    ? core.hashScopeAntiExpansionArtifact(artifact)
    : localHash(artifact);
  return { ...artifact, hash };
}

function normalizedList(value: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value ?? []) {
    const trimmed = String(raw).trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function requireNonEmptyList(values: string[], fieldName: string): void {
  if (values.length === 0) throw new Error(`${fieldName} must include at least one non-empty entry`);
}

function actorFrom(value: string | undefined): string {
  const explicit = value?.trim();
  if (explicit) return explicit;
  return process.env.KOALA_AGENT || process.env.USER || 'main-agent';
}

function readJsonFile(filePath: string): JsonObject | null {
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, 'utf-8')) as JsonObject;
}

function writeJsonFile(filePath: string, data: JsonObject): void {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
    JSON.parse(readFileSync(tmpPath, 'utf-8'));
    renameSync(tmpPath, filePath);
  } catch (err) {
    try { rmSync(tmpPath, { force: true }); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

function artifactPath(ctx: HandlerContext, storyId: string, fileName: string): string {
  return ctx.store.storyFilePath(storyId, fileName);
}

function ensureInitStory(ctx: HandlerContext, storyId: string, command: string): void {
  if (!storyId) throw new Error('storyId is required');
  const story = ctx.store.readStory(storyId);
  if (story.phase !== 'INIT') {
    throw new Error(`${command} is INIT-only; story ${storyId} is currently ${story.phase}`);
  }
}

function statusUpper(status: 'PASS' | 'FAIL' | 'pass' | 'fail' | undefined): 'PASS' | 'FAIL' {
  return status && status.toUpperCase() === 'FAIL' ? 'FAIL' : 'PASS';
}

function proposalEntries(document: JsonObject | null): JsonObject[] {
  const proposals = document?.proposals;
  return Array.isArray(proposals) ? proposals.filter((entry): entry is JsonObject => (
    entry !== null && typeof entry === 'object' && !Array.isArray(entry)
  )) : [];
}

function decisionEntries(document: JsonObject | null): JsonObject[] {
  const decisions = document?.decisions;
  return Array.isArray(decisions) ? decisions.filter((entry): entry is JsonObject => (
    entry !== null && typeof entry === 'object' && !Array.isArray(entry)
  )) : [];
}

function proposalTextHash(text: string): string {
  return createHash('sha256').update(text.trim().toLowerCase()).digest('hex');
}

function makeId(prefix: string, storyId: string, seed: unknown): string {
  const digest = createHash('sha256').update(`${storyId}:${stableJson(seed)}`).digest('hex').slice(0, 10);
  return `${prefix}-${digest}`;
}

function localScopeBoundaryArtifact(input: {
  args: ScopeBoundarySetArgs;
  previous: JsonObject | null;
  now: string;
  actor: string;
}): JsonObject {
  const allowedScope = normalizedList(input.args.allowedScope);
  const excludedScope = normalizedList(input.args.excludedScope);
  requireNonEmptyList(allowedScope, 'allowedScope');
  if (input.args.userConfirmed !== true) {
    throw new Error('userConfirmed must be true before the INIT scope boundary can be saved');
  }
  return {
    schemaVersion: 'lattice.scope_boundary.v1',
    storyId: input.args.storyId,
    allowedScope,
    excludedScope,
    userConfirmed: true,
    confirmation: input.args.confirmation?.trim() || 'User confirmed allowed/excluded scope before INIT_CHECK.',
    createdAt: typeof input.previous?.createdAt === 'string' ? input.previous.createdAt : input.now,
    updatedAt: input.now,
    actor: input.actor,
  };
}

function localExecutionBoundaryArtifact(input: {
  args: ExecutionBoundarySetArgs;
  previous: JsonObject | null;
  now: string;
  actor: string;
}): JsonObject {
  return {
    schemaVersion: 'lattice.execution_boundary.v1',
    storyId: input.args.storyId,
    allowedCommands: normalizedList(input.args.allowedCommands),
    blockedCommands: normalizedList(input.args.blockedCommands),
    allowedPaths: normalizedList(input.args.allowedPaths),
    blockedPaths: normalizedList(input.args.blockedPaths),
    notes: input.args.notes?.trim() || '',
    createdAt: typeof input.previous?.createdAt === 'string' ? input.previous.createdAt : input.now,
    updatedAt: input.now,
    actor: input.actor,
  };
}

function localFreezeCheckArtifact(input: {
  args: ScopeFreezeCheckArgs;
  scopeBoundary: JsonObject | null;
  executionBoundary: JsonObject | null;
  extensionDecisions: JsonObject | null;
  now: string;
  actor: string;
}): JsonObject {
  const missing = [
    input.scopeBoundary ? '' : DEFAULT_SCOPE_BOUNDARY_FILE,
    input.executionBoundary ? '' : DEFAULT_EXECUTION_BOUNDARY_FILE,
  ].filter(Boolean);
  const status = statusUpper(input.args.status ?? (missing.length > 0 ? 'FAIL' : 'PASS'));
  if (status === 'PASS' && missing.length > 0) {
    throw new Error(`scope_freeze_check cannot save PASS while missing ${missing.join(', ')}`);
  }
  const decisionsHash = localHash(input.extensionDecisions ?? { decisions: [] });
  return {
    schemaVersion: 'lattice.scope_freeze_check.v1',
    storyId: input.args.storyId,
    status,
    checks: (input.args.checks ?? []).map((check) => ({
      id: check.id,
      status: statusUpper(check.status),
      ...(check.note ? { note: check.note } : {}),
    })),
    note: input.args.note?.trim() || '',
    scopeBoundaryHash: typeof input.scopeBoundary?.hash === 'string' ? input.scopeBoundary.hash : null,
    executionBoundaryHash: typeof input.executionBoundary?.hash === 'string' ? input.executionBoundary.hash : null,
    extensionDecisionsHash: decisionsHash,
    createdAt: input.now,
    actor: input.actor,
  };
}

function localProposalArtifact(input: {
  args: ScopeExtensionProposalArgs;
  proposalId: string;
  previous: JsonObject | null;
  now: string;
  actor: string;
  rejectedDirectionCount: number;
}): JsonObject {
  const proposal = input.args.proposal.trim();
  if (proposal.length < 10) throw new Error('proposal must be at least 10 characters');
  return {
    id: input.proposalId,
    status: 'pending',
    storyId: input.args.storyId,
    proposal,
    proposalTextHash: proposalTextHash(proposal),
    reason: input.args.reason?.trim() || '',
    reviewer: input.args.reviewer?.trim() || input.actor,
    findingId: input.args.findingId?.trim() || '',
    evidenceRefs: normalizedList(input.args.evidenceRefs),
    rejectedDirectionCount: input.rejectedDirectionCount,
    createdAt: input.now,
    actor: input.actor,
  };
}

function localDecisionArtifact(input: {
  args: ScopeExtensionDecideArgs;
  proposal: JsonObject;
  previous: JsonObject | null;
  freezeCheck: JsonObject | null;
  now: string;
  actor: string;
}): JsonObject {
  return {
    id: makeId('SED', input.args.storyId, { proposalId: input.args.proposalId, decision: input.args.decision, at: input.now }),
    storyId: input.args.storyId,
    proposalId: input.args.proposalId,
    proposalTextHash: typeof input.proposal.proposalTextHash === 'string' ? input.proposal.proposalTextHash : null,
    decision: input.args.decision,
    reason: input.args.reason.trim(),
    decider: input.args.decider?.trim() || input.actor,
    invalidatesFreezeCheckHash: input.args.decision === 'accepted' && typeof input.freezeCheck?.hash === 'string'
      ? input.freezeCheck.hash
      : null,
    priorFreezeCheckStatus: typeof input.freezeCheck?.status === 'string' ? input.freezeCheck.status : null,
    createdAt: input.now,
    actor: input.actor,
  };
}

function appendDocument(base: JsonObject | null, key: 'proposals' | 'decisions', entry: JsonObject): JsonObject {
  const entries = key === 'proposals' ? proposalEntries(base) : decisionEntries(base);
  return {
    schemaVersion: key === 'proposals'
      ? 'lattice.scope_extension_proposals.v1'
      : 'lattice.scope_extension_decisions.v1',
    [key]: [...entries, entry],
    updatedAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date().toISOString(),
  };
}

function markProposalDecided(document: JsonObject, proposalId: string, decision: 'accepted' | 'rejected', now: string): JsonObject {
  return {
    ...document,
    proposals: proposalEntries(document).map((proposal) => (
      proposal.id === proposalId
        ? { ...proposal, status: decision, decidedAt: now }
        : proposal
    )),
    updatedAt: now,
  };
}

function rejectedDirectionCount(proposalText: string, proposalsDoc: JsonObject | null, decisionsDoc: JsonObject | null): number {
  const hash = proposalTextHash(proposalText);
  const proposalsById = new Map(proposalEntries(proposalsDoc).map((proposal) => [String(proposal.id), proposal]));
  return decisionEntries(decisionsDoc).filter((decision) => {
    if (decision.decision !== 'rejected') return false;
    const proposal = proposalsById.get(String(decision.proposalId));
    return proposal?.proposalTextHash === hash;
  }).length;
}

export function createScopeAntiExpansionHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  return {
    async scope_boundary_set(args: ScopeBoundarySetArgs): Promise<string> {
      ensureInitStory(ctx, args.storyId, 'scope_boundary_set');
      const core = await loadCore();
      const file = core.SCOPE_BOUNDARY_FILE ?? DEFAULT_SCOPE_BOUNDARY_FILE;
      const previous = readJsonFile(artifactPath(ctx, args.storyId, file));
      const now = new Date().toISOString();
      const actor = actorFrom(args.actor);
      const artifact = withHash(core, core.buildScopeBoundaryArtifact
        ? core.buildScopeBoundaryArtifact({ args, previous, now, actor })
        : localScopeBoundaryArtifact({ args, previous, now, actor }));
      writeJsonFile(artifactPath(ctx, args.storyId, file), artifact);
      const allowedCount = Array.isArray(artifact.allowedScope) ? artifact.allowedScope.length : normalizedList(args.allowedScope).length;
      const excludedCount = Array.isArray(artifact.excludedScope) ? artifact.excludedScope.length : normalizedList(args.excludedScope).length;
      return `Scope boundary saved for ${args.storyId}: ${allowedCount} allowed, ${excludedCount} excluded (hash ${artifact.hash})`;
    },

    async execution_boundary_set(args: ExecutionBoundarySetArgs): Promise<string> {
      ensureInitStory(ctx, args.storyId, 'execution_boundary_set');
      const core = await loadCore();
      const file = core.EXECUTION_BOUNDARY_FILE ?? DEFAULT_EXECUTION_BOUNDARY_FILE;
      const previous = readJsonFile(artifactPath(ctx, args.storyId, file));
      const now = new Date().toISOString();
      const actor = actorFrom(args.actor);
      const artifact = withHash(core, core.buildExecutionBoundaryArtifact
        ? core.buildExecutionBoundaryArtifact({ args, previous, now, actor })
        : localExecutionBoundaryArtifact({ args, previous, now, actor }));
      writeJsonFile(artifactPath(ctx, args.storyId, file), artifact);
      return `Execution boundary saved for ${args.storyId}: hash ${artifact.hash}`;
    },

    async scope_freeze_check(args: ScopeFreezeCheckArgs): Promise<string> {
      ensureInitStory(ctx, args.storyId, 'scope_freeze_check');
      const core = await loadCore();
      const boundaryFile = core.SCOPE_BOUNDARY_FILE ?? DEFAULT_SCOPE_BOUNDARY_FILE;
      const executionFile = core.EXECUTION_BOUNDARY_FILE ?? DEFAULT_EXECUTION_BOUNDARY_FILE;
      const freezeFile = core.SCOPE_FREEZE_CHECK_FILE ?? DEFAULT_SCOPE_FREEZE_CHECK_FILE;
      const decisionsFile = core.SCOPE_EXTENSION_DECISIONS_FILE ?? DEFAULT_SCOPE_EXTENSION_DECISIONS_FILE;
      const now = new Date().toISOString();
      const actor = actorFrom(args.actor);
      const scopeBoundary = readJsonFile(artifactPath(ctx, args.storyId, boundaryFile));
      const executionBoundary = readJsonFile(artifactPath(ctx, args.storyId, executionFile));
      const extensionDecisions = readJsonFile(artifactPath(ctx, args.storyId, decisionsFile));
      const artifact = withHash(core, core.buildScopeFreezeCheckArtifact
        ? core.buildScopeFreezeCheckArtifact({ args, scopeBoundary, executionBoundary, extensionDecisions, now, actor })
        : localFreezeCheckArtifact({ args, scopeBoundary, executionBoundary, extensionDecisions, now, actor }));
      writeJsonFile(artifactPath(ctx, args.storyId, freezeFile), artifact);
      return `Scope freeze check saved for ${args.storyId}: ${String(artifact.status ?? statusUpper(args.status))}`;
    },

    async scope_extension_proposal(args: ScopeExtensionProposalArgs): Promise<string> {
      ensureInitStory(ctx, args.storyId, 'scope_extension_proposal');
      const core = await loadCore();
      const proposalsFile = core.SCOPE_EXTENSION_PROPOSALS_FILE ?? DEFAULT_SCOPE_EXTENSION_PROPOSALS_FILE;
      const decisionsFile = core.SCOPE_EXTENSION_DECISIONS_FILE ?? DEFAULT_SCOPE_EXTENSION_DECISIONS_FILE;
      const previous = readJsonFile(artifactPath(ctx, args.storyId, proposalsFile));
      const decisions = readJsonFile(artifactPath(ctx, args.storyId, decisionsFile));
      const now = new Date().toISOString();
      const actor = actorFrom(args.reviewer);
      const count = rejectedDirectionCount(args.proposal, previous, decisions);
      const proposalId = makeId('SEP', args.storyId, { proposal: args.proposal, at: now, count: proposalEntries(previous).length });
      const proposal = withHash(core, core.buildScopeExtensionProposalArtifact
        ? core.buildScopeExtensionProposalArtifact({ args, proposalId, previous, now, actor, rejectedDirectionCount: count })
        : localProposalArtifact({ args, proposalId, previous, now, actor, rejectedDirectionCount: count }));
      const document = withHash(core, appendDocument(previous, 'proposals', proposal));
      writeJsonFile(artifactPath(ctx, args.storyId, proposalsFile), document);
      return `Scope extension proposal saved for ${args.storyId}: pending (${proposal.id})`;
    },

    async scope_extension_decide(args: ScopeExtensionDecideArgs): Promise<string> {
      ensureInitStory(ctx, args.storyId, 'scope_extension_decide');
      if (args.reason.trim().length < 10) throw new Error('reason must be at least 10 characters');
      const core = await loadCore();
      const proposalsFile = core.SCOPE_EXTENSION_PROPOSALS_FILE ?? DEFAULT_SCOPE_EXTENSION_PROPOSALS_FILE;
      const decisionsFile = core.SCOPE_EXTENSION_DECISIONS_FILE ?? DEFAULT_SCOPE_EXTENSION_DECISIONS_FILE;
      const freezeFile = core.SCOPE_FREEZE_CHECK_FILE ?? DEFAULT_SCOPE_FREEZE_CHECK_FILE;
      const proposals = readJsonFile(artifactPath(ctx, args.storyId, proposalsFile));
      const proposal = proposalEntries(proposals).find((entry) => entry.id === args.proposalId);
      if (!proposal) throw new Error(`scope extension proposal not found: ${args.proposalId}`);
      if (proposal.status !== 'pending') throw new Error(`scope extension proposal ${args.proposalId} is already ${String(proposal.status)}`);
      const previous = readJsonFile(artifactPath(ctx, args.storyId, decisionsFile));
      const freezeCheck = readJsonFile(artifactPath(ctx, args.storyId, freezeFile));
      const now = new Date().toISOString();
      const actor = actorFrom(args.decider);
      const decision = withHash(core, core.buildScopeExtensionDecisionArtifact
        ? core.buildScopeExtensionDecisionArtifact({ args, proposal, previous, freezeCheck, now, actor })
        : localDecisionArtifact({ args, proposal, previous, freezeCheck, now, actor }));
      const decisionDocument = withHash(core, appendDocument(previous, 'decisions', decision));
      writeJsonFile(artifactPath(ctx, args.storyId, decisionsFile), decisionDocument);
      writeJsonFile(artifactPath(ctx, args.storyId, proposalsFile), withHash(core, markProposalDecided(proposals ?? {}, args.proposalId, args.decision, now)));
      return `Scope extension decision saved for ${args.storyId}: ${args.decision} (${decision.id})`;
    },
  };
}
