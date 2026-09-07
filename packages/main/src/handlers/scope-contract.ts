import { projectScopeInventory } from '../core/scope-inventory-budget.js';
import { validateFullTaskScopeContext } from '../core/prompt-contracts.js';
/**
 * Scope Contract handlers — proof-or-stop scope_contract_set / show / check / acknowledge
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
  readRetiredRepoRootDiffPaths,
} from '../core/scope-contract.js';
import {
  canonicalizeScopePath,
  SCOPE_PATH_CANONICALIZER_VERSION,
} from '../core/scope-path-classifier.js';
import { buildScopeDiffPack, buildSemanticDegradationEvent } from '../core/scope-diff-pack.js';
import {
  SCOPE_ANCHOR_ARTIFACT_VERSION,
  SCOPE_ANCHOR_PARSER_VERSION,
} from '../core/scope-diff-pack.js';
import type { ScopeDiffPack } from '../core/types.js';
import { checkSemanticScope, mergeSemanticScopeResult } from '../core/semantic-scope-gate.js';
import { currentGitHead, currentMaterialHash } from '../core/evidence-freshness.js';
import { resolveStorySignedWorkspace } from '../core/story-signed-workspace-resolution.js';
import { withReviewInventoryMutationLock } from '../core/review-inventory-epoch.js';
import { loadConfig } from '../core/config.js';

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
  const config = loadConfig(root);
  const resolveScopeGitCwd = (storyId: string): string => {
    if (!store.storyExists(storyId)) throw new Error(`Story ${storyId} does not exist`);
    const resolution = resolveStorySignedWorkspace({
      store,
      storyId,
      metadataRoot: root,
      cwd: root,
      config,
    });
    if (!resolution.resolved || !resolution.authoritativeCwd) {
      throw new Error(
        `Story ${storyId} signed workspace is unresolved: ${resolution.unresolvedReason ?? 'no authoritative Git cwd'}`,
      );
    }
    return resolution.authoritativeCwd;
  };
  const pathMode = config.scopeProtection?.pathCanonicalization ?? 'enforce';

  function canonicalPaths(paths: unknown, fieldName: string, exactRepoRootPaths?: readonly string[]): {
    values: string[] | undefined;
    originals: Record<string, string>;
    diagnostics: string[];
  } {
    const validated = paths === undefined ? undefined : validatePaths(paths, fieldName);
    if (validated === undefined || pathMode === 'off') return { values: validated, originals: {}, diagnostics: [] };
    const originals: Record<string, string> = {};
    const diagnostics: string[] = [];
    const values = validated.map((input) => {
      const result = canonicalizeScopePath({
        projectRoot: root,
        scanRoot: config.scanRoot,
        sourceRoot: config.rootDir ?? config.scanRoot,
        input,
        exactRepoRootPaths,
      });
      originals[result.canonicalPath] = result.originalInput;
      diagnostics.push(
        `input: ${result.originalInput} | canonical: ${result.canonicalPath} | base: ${result.base} `
        + `| version: ${result.version} | rule: ${fieldName} | status: PASS`,
      );
      return result.canonicalPath;
    });
    return { values: uniquePaths(values), originals, diagnostics };
  }

  function optionalPaths(paths: unknown, fieldName: string): string[] | undefined {
    return canonicalPaths(paths, fieldName).values;
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
      const pathFields = [
        canonicalPaths(args.allowedModify, 'allowedModify'),
        canonicalPaths(args.allowedCreate, 'allowedCreate'),
        canonicalPaths(args.allowedTest, 'allowedTest'),
        canonicalPaths(args.protectedFiles, 'protectedFiles'),
        canonicalPaths(args.explicitExcludes, 'explicitExcludes'),
      ];
      const [allowedModify, allowedCreate, allowedTest, protectedFiles, explicitExcludes] = pathFields.map((entry) => entry.values);
      const rawFileRules = args.fileRules === undefined ? undefined : validateFileRules(args.fileRules);
      const fileRulePaths = rawFileRules?.map((rule, index) => {
        const canonical = canonicalPaths([rule.path], `fileRules[${index}].path`);
        return { ...rule, path: canonical.values![0], __canonical: canonical };
      });
      const fileRules = fileRulePaths?.map(({ __canonical: _diagnostic, ...rule }) => rule);
      const protectedAnchors = args.protectedAnchors === undefined ? undefined : validateAnchors(args.protectedAnchors, 'protectedAnchors');
      const originals = Object.assign(
        {},
        ...pathFields.map((entry) => entry.originals),
        ...(fileRulePaths ?? []).map((entry) => entry.__canonical.originals),
      );
      const diagnostics = [
        ...pathFields.flatMap((entry) => entry.diagnostics),
        ...(fileRulePaths ?? []).flatMap((entry) => entry.__canonical.diagnostics),
      ];

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
      if (pathMode !== 'off') {
        contract.pathCanonicalizerVersion = SCOPE_PATH_CANONICALIZER_VERSION;
        contract.pathCanonicalizationMode = pathMode;
        contract.originalPathInputs = {
          ...(existing?.originalPathInputs ?? {}),
          ...originals,
        };
      }
      const astMode = config.scopeProtection?.astAnchors ?? 'enforce';
      if (astMode !== 'off' && ((fileRules?.length ?? 0) > 0 || (protectedAnchors?.length ?? 0) > 0)) {
        contract.anchorParserVersion = SCOPE_ANCHOR_PARSER_VERSION;
        contract.anchorArtifactVersion = SCOPE_ANCHOR_ARTIFACT_VERSION;
        contract.astAnchorMode = astMode;
      }
      validateFullTaskScopeContext(projectScopeInventory(contract));
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
        `pathCanonicalizerVersion: ${contract.pathCanonicalizerVersion ?? 'legacy'}`,
        ...diagnostics,
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
        `pathCanonicalizerVersion: ${contract.pathCanonicalizerVersion ?? 'legacy'}`,
        `pathCanonicalizationMode: ${contract.pathCanonicalizationMode ?? 'legacy'}`,
        `originalPathInputs: ${JSON.stringify(contract.originalPathInputs ?? {})}`,
        `anchorParserVersion: ${contract.anchorParserVersion ?? 'legacy'}`,
        `anchorArtifactVersion: ${contract.anchorArtifactVersion ?? 'legacy'}`,
        `astAnchorMode: ${contract.astAnchorMode ?? 'legacy'}`,
        `scopeChangeReason: ${contract.scopeChangeReason ?? '(none)'}`,
        ...ackRows,
        `createdAt: ${contract.createdAt}`,
        `updatedAt: ${contract.updatedAt}`,
      ].join('\n');
    },

    scope_contract_check(args: { storyId: string; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const gitCwd = resolveScopeGitCwd(args.storyId);
      const contract = store.readScopeContract(args.storyId);
      if (!contract) {
        const result = { status: 'skip', summary: 'Scope gate: skip (no contract configured)', mode: null, changedFiles: [], violations: [], warnings: [], acknowledgedPaths: [] };
        if (args.json) return JSON.stringify(result, null, 2);
        return result.summary;
      }
      const diffPack = buildScopeDiffPack(root, undefined, gitCwd);
      const result = mergeSemanticScopeResult(
        checkScopeContract(contract, diffPack.changedFiles, { projectRoot: root, gitCwd }),
        checkSemanticScope(contract, diffPack),
      );
      if (args.json) return JSON.stringify(result, null, 2);
      return renderScopeCheckResult(result);
    },

    scope_diff_pack(args: { storyId: string; json?: boolean }): string {
      if (!args.storyId) throw new Error('storyId is required');
      const gitCwd = resolveScopeGitCwd(args.storyId);
      const pack = buildScopeDiffPack(root, undefined, gitCwd);
      if (args.json) return JSON.stringify(pack, null, 2);
      return [
        `Scope diff pack: ${pack.diffPackHash}`,
        `Changed files (${pack.changedFiles.length}):`,
        ...pack.changedFiles.map((file) => `  ${file}`),
        `Hunks (${pack.hunks.length}):`,
        ...pack.hunks.map((hunk) => {
          const anchor = hunk.anchor ? ` anchor=${hunk.anchor}` : '';
          const previousAnchor = hunk.previousAnchor ? ` previousAnchor=${hunk.previousAnchor}` : '';
          const anchorKind = hunk.anchorKind ? ` anchorKind=${hunk.anchorKind}` : '';
          const anchorRange = hunk.anchorRange ? ` anchorRange=${hunk.anchorRange.start}-${hunk.anchorRange.end}` : '';
          const versions = hunk.anchorParserVersion
            ? ` anchorParserVersion=${hunk.anchorParserVersion} anchorArtifactVersion=${hunk.anchorArtifactVersion}`
            : '';
          const keyPath = hunk.keyPath ? ` keyPath=${hunk.keyPath}` : '';
          const fallback = hunk.parseFallback ? ` fallback=${hunk.parseFallback}` : '';
          return `  ${hunk.path}:${hunk.newStart} ${hunk.changeKind ?? 'modify'} ${hunk.hunkDigest}`
            + `${anchor}${previousAnchor}${anchorKind}${anchorRange}${versions}${keyPath}${fallback}`;
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
      const canonicalModify = canonicalPaths([...allowedModify], 'allowedModify');
      const canonicalCreate = canonicalPaths([...allowedCreate], 'allowedCreate');
      const canonicalTest = canonicalPaths([...allowedTest], 'allowedTest');
      const canonicalProtected = canonicalPaths(args.protectedFiles, 'protectedFiles');
      const canonicalExcludes = canonicalPaths(args.explicitExcludes, 'explicitExcludes');
      const protectedFiles = canonicalProtected.values;
      const explicitExcludes = canonicalExcludes.values;
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
          allowedModify: canonicalModify.values,
          allowedCreate: canonicalCreate.values,
          allowedTest: canonicalTest.values,
          protectedFiles,
          explicitExcludes,
          scopeChangeReason: args.scopeChangeReason ?? 'Initialized from checklist files declared during PLAN.',
        },
        existing,
      );
      if (pathMode !== 'off') {
        contract.pathCanonicalizerVersion = SCOPE_PATH_CANONICALIZER_VERSION;
        contract.pathCanonicalizationMode = pathMode;
        contract.originalPathInputs = Object.assign(
          {},
          ...[canonicalModify, canonicalCreate, canonicalTest, canonicalProtected, canonicalExcludes]
            .map((entry) => entry.originals),
        );
      }
      validateFullTaskScopeContext(projectScopeInventory(contract));
      store.writeScopeContract(args.storyId, contract);
      return [
        'Scope contract initialized from PLAN files',
        `Story: ${args.storyId}`,
        `Mode: ${contract.mode}`,
        `allowedModify: [${contract.allowedModify.join(', ')}]`,
        `allowedCreate: [${contract.allowedCreate.join(', ')}]`,
        `allowedTest: [${contract.allowedTest.join(', ')}]`,
        `pathCanonicalizerVersion: ${contract.pathCanonicalizerVersion ?? 'legacy'}`,
        ...[canonicalModify, canonicalCreate, canonicalTest, canonicalProtected, canonicalExcludes]
          .flatMap((entry) => entry.diagnostics),
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
      return withReviewInventoryMutationLock(store, args.storyId, () => {
      if (!args.storyId) throw new Error('storyId is required');
      const gitCwd = resolveScopeGitCwd(args.storyId);
      const canonicalAckPaths = canonicalPaths(
        args.paths,
        'paths',
        readRetiredRepoRootDiffPaths(gitCwd),
      );
      const paths = canonicalAckPaths.values ?? [];
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
        originalPathInputs: {
          ...(contract.originalPathInputs ?? {}),
          ...canonicalAckPaths.originals,
        },
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
      });
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
  metadataRoot: string,
  gitReader?: (root: string) => string[],
  gitCwd?: string,
): import('../core/types.js').ScopeCheckResult | null {
  const contract = store.readScopeContract(storyId);
  if (!contract) return null;
  const resolvedGitCwd = gitCwd ?? metadataRoot;
  if (gitReader) {
    return checkScopeContract(
      contract,
      gitReader(resolvedGitCwd),
      { projectRoot: metadataRoot, gitCwd: resolvedGitCwd },
    );
  }
  return runScopeGateAndDiffPack(storyId, store, metadataRoot, gitCwd).result;
}

/**
 * B-956f FIX 6: run the scope gate AND return the diff pack it built so the
 * caller can reuse it for the semantic-degradation event, instead of computing
 * the full diff pack (git diff + TS AST parsing) twice per transition. Returns
 * `{ result: null }` (no pack) when no contract is configured — the no-contract
 * path builds its own pack for degradation diagnostics. The gitReader override
 * is intentionally NOT supported here (it has no diff pack).
 */
export function runScopeGateAndDiffPack(
  storyId: string,
  store: import('../core/store.js').StoryStore,
  metadataRoot: string,
  gitCwd?: string,
): { result: import('../core/types.js').ScopeCheckResult | null; diffPack?: ScopeDiffPack } {
  const contract = store.readScopeContract(storyId);
  if (!contract) return { result: null };
  const resolvedGitCwd = gitCwd ?? metadataRoot;
  const diffPack = buildScopeDiffPack(metadataRoot, undefined, resolvedGitCwd);
  const result = mergeSemanticScopeResult(
    checkScopeContract(contract, diffPack.changedFiles, { projectRoot: metadataRoot, gitCwd: resolvedGitCwd }),
    checkSemanticScope(contract, diffPack),
  );
  return { result, diffPack };
}

/**
 * B-956f: emit the deduped, union-typed semantic_analysis_unavailable process
 * event for a diff pack. This is the ONLY place the event is written — a
 * MUTATING validation caller. The pure builder only returns diagnostics and
 * read-only gate checks never call this, so repeated read-only checks cannot
 * spam or suppress degradation events. Returns the emitted extensions (or null
 * when there is nothing material/unsupported to report).
 */
export function emitSemanticDegradationEvent(
  store: import('../core/store.js').StoryStore,
  storyId: string,
  pack: Pick<ScopeDiffPack, 'semanticAnalysisUnavailable'>,
): string[] | null {
  const event = buildSemanticDegradationEvent(pack);
  if (!event) return null;
  store.appendProcessEvent(storyId, {
    type: 'semantic_analysis_unavailable',
    storyId,
    extensions: event.extensions,
    detail: `semantic analysis unavailable for material-code language(s): ${event.extensions.join(', ')} (semantic anchors are TS/JS-only)`,
  });
  return event.extensions;
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
