import { readFileSync } from 'node:fs';
import type { HandlerContext } from './context.js';
import { resolveStoryCommandWorkspace } from './context.js';
import { submitLocalVerdict, type FormatArgs } from './verdict.js';
import { canonicalDigest } from '../core/authority-signing.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { isCanonicalStoryId } from '../core/lifecycle-registry.js';
import type { Finding } from '../core/adversarial-review.js';
import { FINDING_SEVERITIES } from '../core/adversarial-review.js';
import {
  runCodexReviewLeaf,
  type CodexReviewRunner,
  type CodexReviewVerdict,
} from '../core/codex-review-leaf.js';
import {
  diffFindings,
  jointDecision,
  type DisagreementReport,
  type JointDecisionResult,
} from '../core/cross-host-review.js';

const DEFAULT_TIMEOUT_MINUTES = 12;

export type CrossHostReviewArgs = {
  storyId: string;
  policy?: string;
  hostAFindingsFile?: string;
  hostA?: string;
  hostB?: string;
  runId?: string;
  timeoutMinutes?: number;
} & FormatArgs;

export interface CrossHostReviewResult {
  schemaVersion: 'lattice.cross_host_review.v1';
  storyId: string;
  runId: string;
  materialDigest: string;
  storyFilesHash: string;
  hostA: {
    hostId: string;
    provider: string;
    decision: 'pass' | 'fail' | 'blocked';
    verdictId: string;
    findingCount: number;
  };
  hostB: {
    hostId: string;
    provider: string;
    decision: 'pass' | 'fail' | 'blocked';
    verdictId: string;
    findingCount: number;
    /** Present on a fail-closed synthesized verdict (no parseable / material mismatch). */
    reason?: string;
  };
  disagreement: DisagreementReport;
  jointDecision: JointDecisionResult;
  /** sha256 of the raw Codex stdout — provenance only; raw stdout is NEVER surfaced. */
  stdoutDigest: string;
  codexExitCode: number | null;
  codexTimedOut: boolean;
}

function wantsJson(args: FormatArgs | undefined): boolean {
  return args?.json === true || args?.format === 'json';
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function derivedSession(storyId: string, hostId: string): string {
  return `xhr:${storyId}:${hostId}:session`;
}

function derivedKey(storyId: string, hostId: string): string {
  return `xhr:${storyId}:${hostId}:key`;
}

function isFindingSeverity(value: unknown): value is Finding['severity'] {
  return typeof value === 'string' && (FINDING_SEVERITIES as readonly string[]).includes(value);
}

/**
 * Parse + validate the host-A (Claude) findings from a JSON file. Must be a JSON
 * array of `Finding`. Any malformed entry fails closed with a descriptive error
 * (host A is the caller-authored input; we do not silently drop its findings).
 */
function loadHostAFindings(path: string): Finding[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`cross_host_review: cannot read hostAFindingsFile "${path}": ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`cross_host_review: hostAFindingsFile "${path}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`cross_host_review: hostAFindingsFile "${path}" must contain a JSON array of Finding objects`);
  }
  return parsed.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`cross_host_review: hostAFindingsFile "${path}" entry ${index} is not an object`);
    }
    const f = entry as Record<string, unknown>;
    if (!isFindingSeverity(f.severity)) {
      throw new Error(`cross_host_review: hostAFindingsFile "${path}" entry ${index} has invalid severity (expected ${FINDING_SEVERITIES.join('|')})`);
    }
    if (typeof f.title !== 'string' || typeof f.file !== 'string' || typeof f.line !== 'number'
      || typeof f.issue !== 'string' || typeof f.fix !== 'string') {
      throw new Error(`cross_host_review: hostAFindingsFile "${path}" entry ${index} is missing required Finding fields (title/file/line/issue/fix)`);
    }
    return {
      severity: f.severity,
      title: f.title,
      file: f.file,
      line: f.line,
      issue: f.issue,
      fix: f.fix,
    };
  });
}

function deriveValidationDigest(storyId: string, materialDigest: string, storyFilesHash: string, headHash?: string): string {
  return canonicalDigest({
    schemaVersion: 'lattice.cross_host_review.validation_digest.v1',
    storyId,
    headHash,
    materialDigest,
    storyFilesHash,
  });
}

function derivePromptDigest(
  storyId: string,
  host: { hostId: string; provider: string; sessionId: string; keyId: string },
  materialDigest: string,
  storyFilesHash: string,
): string {
  return canonicalDigest({
    schemaVersion: 'lattice.cross_host_review.prompt_digest.v1',
    purpose: 'local crypto-deferred automatic cross-host adversarial review',
    storyId,
    hostId: host.hostId,
    provider: host.provider,
    sessionId: host.sessionId,
    keyId: host.keyId,
    materialDigest,
    storyFilesHash,
  });
}

function formatResult(result: CrossHostReviewResult): string {
  return [
    `Cross-host review (${result.schemaVersion})`,
    `storyId: ${result.storyId}`,
    `runId: ${result.runId}`,
    `materialDigest: ${result.materialDigest}`,
    `storyFilesHash: ${result.storyFilesHash}`,
    `hostA: ${result.hostA.provider}/${result.hostA.hostId} decision=${result.hostA.decision} findings=${result.hostA.findingCount}`,
    `hostB: ${result.hostB.provider}/${result.hostB.hostId} decision=${result.hostB.decision} findings=${result.hostB.findingCount}${result.hostB.reason ? ` reason=${result.hostB.reason}` : ''}`,
    `disagreement: ${result.disagreement.hasDisagreement} (onlyHostA=${result.disagreement.onlyHostA.length}, onlyHostB=${result.disagreement.onlyHostB.length}, agreed=${result.disagreement.agreed.length})`,
    `jointDecision: ${result.jointDecision.jointDecision}${result.jointDecision.blockedReason ? ` — ${result.jointDecision.blockedReason}` : ''}`,
    `stdoutDigest: ${result.stdoutDigest}`,
    `codexExitCode: ${result.codexExitCode}`,
    `codexTimedOut: ${result.codexTimedOut}`,
    'admissibilityStatus: local-cross-host-review-recorded',
    'evidenceScope: local-cross-host-review',
  ].join('\n');
}

export interface CreateCrossHostReviewHandlersOptions {
  /** Injectable Codex process seam so the smoke can pass a fake (no real CLI). */
  codexRunner?: CodexReviewRunner;
}

export function createCrossHostReviewHandlers(
  ctx: HandlerContext,
  options: CreateCrossHostReviewHandlersOptions = {},
) {
  return {
    async cross_host_review(args: CrossHostReviewArgs): Promise<CrossHostReviewResult | string> {
      const storyId = normalizeString(args.storyId);
      if (!storyId) throw new Error('cross_host_review: storyId is required');
      if (!isCanonicalStoryId(storyId)) {
        throw new Error(`cross_host_review: storyId "${storyId}" is not a canonical, path-safe Proofbound story id`);
      }

      const workspace = resolveStoryCommandWorkspace(ctx.store, storyId, ctx.root);
      const projectRoot = workspace.signedWorkspaceRoot;
      const metadataRoot = workspace.metadataRoot || ctx.root;

      const materialDigest = currentMaterialHash(projectRoot, 'HEAD', metadataRoot);
      if (!materialDigest) {
        throw new Error('cross_host_review: cannot compute current materialHash; refusing to record verdicts with an empty materialDigest');
      }
      const storyFilesHash = currentStoryFilesHash(projectRoot, 'HEAD', metadataRoot);
      if (!storyFilesHash) {
        throw new Error('cross_host_review: cannot compute current storyFilesHash; refusing to record verdicts without the story-owned file hash');
      }
      const headHash = currentGitHead(projectRoot);

      const hostAFindings: Finding[] = args.hostAFindingsFile
        ? loadHostAFindings(normalizeString(args.hostAFindingsFile))
        : [];

      const timeoutMinutes = typeof args.timeoutMinutes === 'number' && args.timeoutMinutes > 0
        ? args.timeoutMinutes
        : DEFAULT_TIMEOUT_MINUTES;

      // Host B (Codex): auto-run the read-only review leaf against the SAME
      // worktree so its embedded materialHash matches the computed digest.
      const leaf = await runCodexReviewLeaf(
        {
          storyId,
          storyWorktree: projectRoot,
          materialHash: materialDigest,
          hostAFindings,
          timeoutMs: timeoutMinutes * 60 * 1000,
        },
        options.codexRunner,
      );
      const hostBVerdict: CodexReviewVerdict = leaf.hostBVerdict;

      const runId = normalizeString(args.runId) || `${storyId}-xhr-r1`;
      const validationDigest = deriveValidationDigest(storyId, materialDigest, storyFilesHash, headHash);

      // Independent host identities (distinct hostId/sessionId/keyId) so the two
      // verdicts never collapse in groupByIndependentHost (verdicts.ts).
      const hostAId = normalizeString(args.hostA) || 'claude-host-a';
      const hostBId = normalizeString(args.hostB) || 'codex-host-b';
      const hostAIdentity = {
        hostId: hostAId,
        provider: 'claude',
        sessionId: derivedSession(storyId, hostAId),
        keyId: derivedKey(storyId, hostAId),
      };
      const hostBIdentity = {
        hostId: hostBId,
        provider: 'codex',
        sessionId: derivedSession(storyId, hostBId),
        keyId: derivedKey(storyId, hostBId),
      };

      // Host A decision: derived from the caller-authored findings. Any
      // BLOCKER/MAJOR finding is a fail; otherwise pass. Host A is a review
      // conclusion the caller already reached, not a spawned second agent.
      const hostADecision: 'pass' | 'fail' = hostAFindings.some(
        f => f.severity === 'BLOCKER' || f.severity === 'MAJOR',
      ) ? 'fail' : 'pass';

      const hostAVerdictRecord = submitLocalVerdict(ctx, 'local', {
        storyId,
        runId,
        hostId: hostAIdentity.hostId,
        provider: hostAIdentity.provider,
        sessionId: hostAIdentity.sessionId,
        keyId: hostAIdentity.keyId,
        decision: hostADecision,
        materialDigest,
        storyFilesHash,
        validationDigest,
        promptDigest: derivePromptDigest(storyId, hostAIdentity, materialDigest, storyFilesHash),
        note: 'cross_host_review host A (Claude) verdict from caller-authored findings',
      });

      const hostBVerdictRecord = submitLocalVerdict(ctx, 'local', {
        storyId,
        runId,
        hostId: hostBIdentity.hostId,
        provider: hostBIdentity.provider,
        sessionId: hostBIdentity.sessionId,
        keyId: hostBIdentity.keyId,
        decision: hostBVerdict.decision,
        materialDigest,
        storyFilesHash,
        validationDigest,
        promptDigest: derivePromptDigest(storyId, hostBIdentity, materialDigest, storyFilesHash),
        note: `cross_host_review host B (Codex) verdict, stdoutDigest=${leaf.stdoutDigest}`,
      });

      const disagreement = diffFindings(hostAFindings, hostBVerdict.findings);
      const joint = jointDecision(hostADecision, hostBVerdict.decision, disagreement);

      const result: CrossHostReviewResult = {
        schemaVersion: 'lattice.cross_host_review.v1',
        storyId,
        runId,
        materialDigest,
        storyFilesHash,
        hostA: {
          hostId: hostAIdentity.hostId,
          provider: hostAIdentity.provider,
          decision: hostADecision,
          verdictId: hostAVerdictRecord.verdictId,
          findingCount: hostAFindings.length,
        },
        hostB: {
          hostId: hostBIdentity.hostId,
          provider: hostBIdentity.provider,
          decision: hostBVerdict.decision,
          verdictId: hostBVerdictRecord.verdictId,
          findingCount: hostBVerdict.findings.length,
          ...(hostBVerdict.reason ? { reason: hostBVerdict.reason } : {}),
        },
        disagreement,
        jointDecision: joint,
        stdoutDigest: leaf.stdoutDigest,
        codexExitCode: leaf.exitCode,
        codexTimedOut: leaf.timedOut,
      };
      return wantsJson(args) ? result : formatResult(result);
    },
  };
}
