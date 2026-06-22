/**
 * Scope Contract handlers — lattice scope_contract_set / show / check / acknowledge
 *
 * scope_contract_set       — create or update the contract for a story
 * scope_contract_show      — display the current contract
 * scope_contract_check     — run the post-diff scope gate and return status
 * scope_contract_acknowledge — record an explicit out-of-scope change with reason
 */

import type { HandlerContext } from './context.js';
import type { ScopeContractData, ScopeContractAcknowledgement, StoryPhase } from '../core/types.js';
import {
  validateMode,
  validatePaths,
  validateAnchors,
  validateFileRules,
  validateHunkDigest,
  buildScopeContract,
  checkScopeContract,
  renderScopeCheckResult,
  readChangedFiles,
} from '../core/scope-contract.js';
import { buildScopeDiffPack } from '../core/scope-diff-pack.js';
import { checkSemanticScope, mergeSemanticScopeResult } from '../core/semantic-scope-gate.js';
import { currentGitHead, currentMaterialHash } from '../core/evidence-freshness.js';

type StructuredScopeAcknowledgement = ScopeContractAcknowledgement & {
  assuranceLabel?: 'acknowledged-expansion';
  phase?: StoryPhase;
  headHash?: string;
  materialHash?: string;
  affectedPaths?: string[];
  affectedPathCount?: number;
};

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

function shortHash(hash: string | undefined): string {
  return hash ? hash.slice(0, 12) : '(unavailable)';
}

function renderAcknowledgementRow(ack: ScopeContractAcknowledgement, index: number): string {
  const structured = ack as StructuredScopeAcknowledgement;
  const assurance = structured.assuranceLabel ?? 'legacy-acknowledgement';
  const affectedPaths = structured.affectedPaths ?? ack.paths;
  const phase = structured.phase ?? '(unknown)';
  const anchors = ack.anchors && ack.anchors.length > 0 ? ` anchors=[${ack.anchors.join(', ')}]` : '';
  const digests = [
    ...(ack.hunkDigest ? [ack.hunkDigest] : []),
    ...(ack.hunkDigests ?? []),
  ];
  const digestPart = digests.length > 0 ? ` hunkDigests=[${digests.join(', ')}]` : '';
  return `  [scope-ack:${index + 1}] status=warn blocking=false assurance=${assurance} phase=${phase} paths=[${affectedPaths.join(', ')}] actor=${ack.actor} timestamp=${ack.timestamp} headHash=${shortHash(structured.headHash)} materialHash=${shortHash(structured.materialHash)}${anchors}${digestPart} reason=${ack.reason}`;
}

export function createScopeContractHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  const { store, root } = ctx;

  function optionalPaths(paths: unknown, fieldName: string): string[] | undefined {
    return paths === undefined ? undefined : validatePaths(paths, fieldName);
  }

  return {
    scope_contract_set(args: {
      storyId: string;
      mode: string;
      allowedModify?: string[];
      allowedCreate?: string[];
      allowedTest?: string[];
      protectedFiles?: string[];
      explicitExcludes?: string[];
      scopeChangeReason?: string;
      fileRules?: unknown[];
      protectedAnchors?: string[];
    }): string {
      if (!args.storyId) throw new Error('storyId is required');
      // ensure story exists
      store.readStory(args.storyId);

      const mode = validateMode(args.mode);
      const allowedModify = optionalPaths(args.allowedModify, 'allowedModify');
      const allowedCreate = optionalPaths(args.allowedCreate, 'allowedCreate');
      const allowedTest = optionalPaths(args.allowedTest, 'allowedTest');
      const protectedFiles = optionalPaths(args.protectedFiles, 'protectedFiles');
      const explicitExcludes = optionalPaths(args.explicitExcludes, 'explicitExcludes');
      const fileRules = args.fileRules === undefined ? undefined : validateFileRules(args.fileRules);
      const protectedAnchors = args.protectedAnchors === undefined ? undefined : validateAnchors(args.protectedAnchors, 'protectedAnchors');

      // B-6bfd CHK-006: readScopeContract now fails closed (throws) on a corrupt
      // existing contract. scope_contract_set is a RECOVERY path — a corrupt
      // existing file must not lock the user out of overwriting it — so tolerate
      // the throw and treat it as "no existing contract" (fresh overwrite).
      let existing: ScopeContractData | undefined;
      try {
        existing = store.readScopeContract(args.storyId) ?? undefined;
      } catch {
        existing = undefined; // corrupt existing contract: allow overwrite to recover
      }
      const contract = buildScopeContract(
        args.storyId,
        { mode, allowedModify, allowedCreate, allowedTest, protectedFiles, explicitExcludes, scopeChangeReason: args.scopeChangeReason, fileRules, protectedAnchors },
        existing,
      );
      store.writeScopeContract(args.storyId, contract);
      return [
        `Scope contract: configured`,
        `Story: ${args.storyId}`,
        `Mode: ${mode}`,
        `allowedModify: [${contract.allowedModify.join(', ')}]`,
        `allowedCreate: [${contract.allowedCreate.join(', ')}]`,
        `allowedTest: [${contract.allowedTest.join(', ')}]`,
        `protectedFiles: [${contract.protectedFiles.join(', ')}]`,
        `explicitExcludes: [${contract.explicitExcludes.join(', ')}]`,
        `fileRules: ${JSON.stringify(contract.fileRules ?? [])}`,
        `protectedAnchors: [${(contract.protectedAnchors ?? []).join(', ')}]`,
      ].join('\n');
    },

    scope_contract_show(args: { storyId: string }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const contract = store.readScopeContract(args.storyId);
      if (!contract) {
        return `Scope contract: not configured\nStory ${args.storyId} has no scope contract. Use scope_contract_set to create one.`;
      }
      const acks = contract.acknowledgements;
      const ackRows = acks.length === 0
        ? ['acknowledgements: none']
        : [
          `acknowledgements (${acks.length}):`,
          ...acks.map((ack, index) => renderAcknowledgementRow(ack, index)),
        ];
      return [
        `Scope contract: configured`,
        `Story: ${contract.storyId}`,
        `Mode: ${contract.mode}`,
        `allowedModify: [${contract.allowedModify.join(', ')}]`,
        `allowedCreate: [${contract.allowedCreate.join(', ')}]`,
        `allowedTest: [${contract.allowedTest.join(', ')}]`,
        `protectedFiles: [${contract.protectedFiles.join(', ')}]`,
        `explicitExcludes: [${contract.explicitExcludes.join(', ')}]`,
        `fileRules: ${JSON.stringify(contract.fileRules ?? [])}`,
        `protectedAnchors: [${(contract.protectedAnchors ?? []).join(', ')}]`,
        `scopeChangeReason: ${contract.scopeChangeReason ?? '(none)'}`,
        ...ackRows,
        `createdAt: ${contract.createdAt}`,
        `updatedAt: ${contract.updatedAt}`,
      ].join('\n');
    },

    scope_contract_check(args: { storyId: string; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const contract = store.readScopeContract(args.storyId);
      if (!contract) {
        const result = { status: 'skip', summary: 'Scope gate: skip (no contract configured)', mode: null, changedFiles: [], violations: [], warnings: [], acknowledgedPaths: [] };
        if (args.json) return JSON.stringify(result, null, 2);
        return result.summary;
      }
      const diffPack = buildScopeDiffPack(root);
      const result = mergeSemanticScopeResult(
        checkScopeContract(contract, diffPack.changedFiles),
        checkSemanticScope(contract, diffPack),
      );
      if (args.json) return JSON.stringify(result, null, 2);
      return renderScopeCheckResult(result);
    },

    scope_diff_pack(args: { json?: boolean }): string {
      const pack = buildScopeDiffPack(root);
      if (args.json) return JSON.stringify(pack, null, 2);
      return [
        `Scope diff pack: ${pack.diffPackHash}`,
        `Changed files (${pack.changedFiles.length}):`,
        ...pack.changedFiles.map((file) => `  ${file}`),
        `Hunks (${pack.hunks.length}):`,
        ...pack.hunks.map((hunk) => {
          const anchor = hunk.anchor ? ` anchor=${hunk.anchor}` : '';
          const keyPath = hunk.keyPath ? ` keyPath=${hunk.keyPath}` : '';
          const fallback = hunk.parseFallback ? ` fallback=${hunk.parseFallback}` : '';
          return `  ${hunk.path}:${hunk.newStart} ${hunk.changeKind ?? 'modify'} ${hunk.hunkDigest}${anchor}${keyPath}${fallback}`;
        }),
      ].join('\n');
    },

    scope_contract_init_from_plan(args: {
      storyId: string;
      mode?: string;
      protectedFiles?: string[];
      explicitExcludes?: string[];
      scopeChangeReason?: string;
    }): string {
      if (!args.storyId) throw new Error('storyId is required');
      store.readStory(args.storyId);
      const checklist = store.readChecklist(args.storyId);
      const mode = validateMode(args.mode ?? 'enforce');
      const allowedModify = new Set<string>();
      const allowedCreate = new Set<string>();
      const allowedTest = new Set<string>();
      for (const item of checklist.items) {
        for (const file of item.files?.modify ?? []) allowedModify.add(file);
        for (const file of item.files?.create ?? []) allowedCreate.add(file);
        for (const file of item.files?.test ?? []) allowedTest.add(file);
      }
      const protectedFiles = optionalPaths(args.protectedFiles, 'protectedFiles');
      const explicitExcludes = optionalPaths(args.explicitExcludes, 'explicitExcludes');
      // B-6bfd CHK-006: tolerate a corrupt existing contract here too — init from
      // PLAN is a (re)initialization path and must be able to recover by writing a
      // fresh contract over an unreadable one (readScopeContract now throws on
      // corrupt; see store.ts / CHK-006 fail-closed note).
      let existing: ScopeContractData | undefined;
      try {
        existing = store.readScopeContract(args.storyId) ?? undefined;
      } catch {
        existing = undefined; // corrupt existing contract: allow re-init overwrite
      }
      const contract = buildScopeContract(
        args.storyId,
        {
          mode,
          allowedModify: validatePaths([...allowedModify], 'allowedModify'),
          allowedCreate: validatePaths([...allowedCreate], 'allowedCreate'),
          allowedTest: validatePaths([...allowedTest], 'allowedTest'),
          protectedFiles,
          explicitExcludes,
          scopeChangeReason: args.scopeChangeReason ?? 'Initialized from checklist files declared during PLAN.',
        },
        existing,
      );
      store.writeScopeContract(args.storyId, contract);
      return [
        'Scope contract initialized from PLAN files',
        `Story: ${args.storyId}`,
        `Mode: ${contract.mode}`,
        `allowedModify: [${contract.allowedModify.join(', ')}]`,
        `allowedCreate: [${contract.allowedCreate.join(', ')}]`,
        `allowedTest: [${contract.allowedTest.join(', ')}]`,
      ].join('\n');
    },

    scope_contract_acknowledge(args: {
      storyId: string;
      paths: string[];
      reason: string;
      actor?: string;
      anchors?: string[];
      hunkDigest?: string;
      hunkDigests?: string[];
    }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const paths = validatePaths(args.paths, 'paths');
      if (paths.length === 0) throw new Error('paths must be a non-empty array');
      const reason = (args.reason ?? '').trim();
      if (reason.length < 20) {
        throw new Error(`reason must be at least 20 characters (got ${reason.length})`);
      }
      const actor = (args.actor ?? 'main-agent').trim();
      const anchors = args.anchors === undefined ? undefined : validateAnchors(args.anchors, 'anchors');
      const hunkDigests = [
        ...(args.hunkDigest ? [validateHunkDigest(args.hunkDigest, 'hunkDigest')] : []),
        ...((args.hunkDigests ?? []).map((digest, idx) => validateHunkDigest(digest, `hunkDigests[${idx}]`))),
      ];

      const contract = store.readScopeContract(args.storyId);
      if (!contract) {
        throw new Error(`Story ${args.storyId} has no scope contract. Run scope_contract_set first.`);
      }

      let phase: StoryPhase | undefined;
      try {
        phase = store.readStory(args.storyId).phase;
      } catch {
        phase = undefined;
      }
      const headHash = currentGitHead(root);
      const materialHash = currentMaterialHash(root, 'HEAD', root);
      const affectedPaths = uniquePaths(paths);

      // Structural extension until ScopeContractAcknowledgement grows these
      // first-class fields: assuranceLabel, phase, headHash, materialHash,
      // affectedPaths, and affectedPathCount.
      const ack: StructuredScopeAcknowledgement = {
        actor,
        reason,
        timestamp: new Date().toISOString(),
        paths,
        assuranceLabel: 'acknowledged-expansion',
        affectedPaths,
        affectedPathCount: affectedPaths.length,
        ...(phase ? { phase } : {}),
        ...(headHash ? { headHash } : {}),
        ...(materialHash ? { materialHash } : {}),
        ...(anchors && anchors.length > 0 ? { anchors } : {}),
        // B-6bfd F-003: persist singular vs plural unambiguously. Exactly one
        // digest stores only `hunkDigest`; multiple digests store only
        // `hunkDigests`. The two branches are mutually exclusive so a
        // single-digest acknowledgement never redundantly carries both fields.
        ...(hunkDigests.length === 1 ? { hunkDigest: hunkDigests[0] } : {}),
        ...(hunkDigests.length > 1 ? { hunkDigests } : {}),
      };

      const updated: ScopeContractData = {
        ...contract,
        acknowledgements: [...contract.acknowledgements, ack],
        updatedAt: new Date().toISOString(),
      };
      store.writeScopeContract(args.storyId, updated);

      return [
        `Scope change acknowledged`,
        `Story: ${args.storyId}`,
        `assurance: acknowledged-expansion (lower assurance; reviewer-visible scope expansion)`,
        `phase: ${phase ?? '(unknown)'}`,
        `actor: ${actor}`,
        `reason: ${reason}`,
        `affectedPaths: [${affectedPaths.join(', ')}]`,
        `addedPaths: [${paths.join(', ')}]`,
        `headHash: ${headHash ?? '(unavailable)'}`,
        `materialHash: ${materialHash ?? '(unavailable)'}`,
        ...(anchors && anchors.length > 0 ? [`anchors: [${anchors.join(', ')}]`] : []),
        ...(hunkDigests.length > 0 ? [`hunkDigests: [${hunkDigests.join(', ')}]`] : []),
        `timestamp: ${ack.timestamp}`,
        renderAcknowledgementRow(ack, updated.acknowledgements.length - 1),
        `Total acknowledgements: ${updated.acknowledgements.length}`,
      ].join('\n');
    },
  };
}

/**
 * Run the scope gate for a story and return the check result.
 * Returns null (skip) when no contract is configured — backward compatible.
 */
export function runScopeGate(
  storyId: string,
  store: import('../core/store.js').StoryStore,
  projectRoot: string,
  gitReader?: (root: string) => string[],
): import('../core/types.js').ScopeCheckResult | null {
  const contract = store.readScopeContract(storyId);
  if (!contract) return null;
  if (gitReader) return checkScopeContract(contract, gitReader(projectRoot));
  const diffPack = buildScopeDiffPack(projectRoot);
  return mergeSemanticScopeResult(
    checkScopeContract(contract, diffPack.changedFiles),
    checkSemanticScope(contract, diffPack),
  );
}

/**
 * Format scope gate result for lifecycle output.
 * Returns null if no contract (skip = backward-compatible).
 */
export function formatScopeGateForLifecycle(
  result: import('../core/types.js').ScopeCheckResult | null,
): string | null {
  if (!result) return null;
  return result.summary;
}
