/**
 * B-f675 CHK-001: read-only incremental review context.
 *
 * Gives a reviewer role its most recent prior verdict (review-pass or finding)
 * for the current story, the headHash that verdict was bound to, and the set of
 * MATERIAL files that changed since that headHash. When the reviewer has never
 * passed on this story it reports isFirstPass=true and the full frozen Story
 * integration-base...HEAD material diff.
 *
 * The legacy per-reviewer context below remains STRICTLY READ-ONLY. The same
 * module also owns the separately signed post-remediation selection consumed by
 * the REVIEW gate: it narrows only from a proven current dependency closure and
 * otherwise requires the full active set. Round number is never lane evidence.
 *
 * Diff source: changedFilesBetweenRenameAware (`git diff --name-status -M`) so a
 * file rename since the reviewer's last pass still surfaces as a changed path
 * (rather than being hidden by a name-only collapse). Results are filtered to
 * material files via isMaterialExcludedPath so story-metadata-only churn does
 * not falsely flag scopeChanged.
 */

import { metadataCorrectionCheckpoints, routingUserSees } from './metadata-correction.js';
import { execFileSync } from 'node:child_process';
import { isBuiltin } from 'node:module';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import ts from 'typescript';
import { observedGit } from './git-tree-observation.js';
import { REVIEW_DEPENDENCY_CLOSURE_LIMITS, REVIEW_MAINTENANCE_GIT_MAX_BUFFER_BYTES } from './runtime-fact-registry.js';
import type { StoryStore } from './store.js';
import type { Finding, ReviewPass, ReviewRun } from './types.js';
import {
  changedFilesBetweenRenameAware,
  changedFileStatusesBetweenRenameAware,
  checkEvidenceFreshnessForGit,
  classifyEvidenceFreshness,
  currentGitHead,
  gitCommitAtRef,
  currentMaterialHash,
  currentStoryFilesHash,
  isMaterialExcludedPath,
  type EvidenceFreshnessClassification,
} from './evidence-freshness.js';
import { verifyReviewPass } from './finding-verify.js';
import { verifyReviewRun } from './review-run.js';
import { agentRoleIdsEqual, canonicalAgentRoleId } from './agent-role-identity.js';
import { readGitBlobAt, type GitBlobReadResult } from './git-blob-reader.js';
import {
  classifyImpact,
  IMPACT_CLASSIFICATION_POLICY_VERSION,
  type ImpactClassification,
} from './impact-classification-policy.js';
import {
  CURRENT_PROMPT_IDENTITIES,
  FULL_TASK_CONTEXT_LIMITS,
  domainSeparatedDigest,
  validateIncrementalReviewBasis,
  validateFullStoryBaseHead,
  type IncrementalReviewBasis,
  type PromptEnvelope,
  type PromptFindingProjection,
} from './prompt-contracts.js';
import {
  PROMPT_DISPATCH_PROTOCOL_VERSION,
  PROMPT_ENVELOPE_ASSEMBLER_VERSION,
  buildFullTaskContext,
  captureKnownExecutionEnvironment,
  fullTaskSemanticDigest,
  verifyPromptEnvelopeIntegrity,
} from './prompt-envelope.js';
import { BASELINE_RUNTIME_CONTRACT } from './prompt-measurement.js';
import { promptRoleContract, promptRoleContractForSemanticDigest } from './prompt-role-contract-registry.js';
import { digestScopeContract } from './guard-session.js';
import {
  currentOpenReviewInventory,
  reviewInventoryDigest,
  reviewInventoryAcceptanceSubjectDigestForStore,
  verifyReviewInventoryEpoch,
  verifyReviewInventoryReceipt,
} from './review-inventory-epoch.js';
import { resolveGitCwd } from './story-signed-workspace-resolution.js';
import { resolveStoryIntegrationTarget } from './story-integration-target.js';

export const POST_REMEDIATION_REVIEW_POLICY_VERSION = 'proof-or-stop.post-remediation-review-selection.v2' as const;

export type PostRemediationSelectionReason =
  | 'PROVEN_CANONICAL_DEPENDENCY_CLOSURE'
  | 'NO_CONSUMED_INVENTORY_RECEIPT'
  | 'RECEIPT_OR_EPOCH_INVALID'
  | 'CURRENT_REVIEW_ROUND_MISSING_OR_UNCHANGED'
  | 'CURRENT_LINEAGE_UNAVAILABLE'
  | 'SOURCE_CUTOFF_NOT_ANCESTOR'
  | 'SCOPE_OR_POLICY_CHANGED'
  | 'NO_MATERIAL_REMEDIATION'
  | 'DIRTY_MATERIAL'
  | 'DIRTY_STATE_UNREADABLE'
  | 'UNTRACKED_OR_IGNORED_MATERIAL'
  | 'CHANGED_FILE_OUTSIDE_FROZEN_SCOPE'
  | 'UNSUPPORTED_RENAME_OR_DELETE'
  | 'POLICY_IMPACT_REQUIRES_FULL_SET'
  | 'DEPENDENCY_CLOSURE_INCOMPLETE'
  | 'EMPTY_IMPACT_SELECTION'
  | 'OPEN_FINDINGS_REQUIRE_FULL_SET'
  | 'SOURCE_ROSTER_INCOMPLETE';

export interface PostRemediationReviewSelection {
  schemaVersion: typeof POST_REMEDIATION_REVIEW_POLICY_VERSION;
  storyId: string;
  reviewRound: string;
  headHash: string;
  materialHash: string;
  storyFilesHash: string;
  sourceReceiptId: string | null;
  sourceReviewRound: string | null;
  sourceHeadHash: string | null;
  activeLanes: string[];
  selectedLanes: string[];
  selection: 'dependency-closure' | 'full-set';
  reason: PostRemediationSelectionReason;
  reasonDetail: string;
  changedFiles: string[];
  closureFiles: string[];
  scopeDigest: string;
  openFindingDigest: string;
  requiredHostAssurance: 'unchanged';
  policyVersion: typeof POST_REMEDIATION_REVIEW_POLICY_VERSION;
  _hash: string;
}

export interface CanonicalDependencyClosure {
  complete: boolean;
  files: string[];
  reason?: string;
}

function canonicalRepoPath(projectRoot: string, path: string): string | null {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '').trim();
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) return null;
  const absolute = resolve(projectRoot, normalized);
  const rel = relative(projectRoot, absolute).replace(/\\/g, '/');
  return rel === normalized ? normalized : null;
}

function trackedFiles(gitCwd: string): { files: string[]; reason?: string } {
  try {
    const files = execFileSync('git', ['ls-files', '-z'], {
      cwd: gitCwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: REVIEW_MAINTENANCE_GIT_MAX_BUFFER_BYTES,
    }).split('\0').filter(Boolean).sort();
    return { files };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'GIT_READ_FAILED';
    return { files: [], reason: `tracked source inventory unavailable: ${code}` };
  }
}

function hasOpaqueDynamicLoad(source: ts.SourceFile): boolean {
  let opaque = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const commonJsRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if ((dynamicImport || commonJsRequire)
        && (node.arguments.length !== 1 || !ts.isStringLiteralLike(node.arguments[0]))) opaque = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return opaque;
}

/**
 * Build a deterministic, bidirectional source dependency component from the
 * tracked TypeScript/JavaScript inventory. Walking both directions covers
 * transitive dependencies and all dependants that share a changed module.
 * Any unresolved non-builtin import, opaque dynamic load, symlink, alias escape,
 * or missing changed source makes the proof incomplete rather than narrow.
 */
export function computeCanonicalDependencyClosure(
  gitCwd: string,
  changedFilesInput: readonly string[],
): CanonicalDependencyClosure {
  const startedAt = performance.now();
  const limits = REVIEW_DEPENDENCY_CLOSURE_LIMITS;
  const changedFiles = [...new Set(changedFilesInput)].sort();
  const exceeded = (bound: string): CanonicalDependencyClosure => ({ complete: false, files: changedFiles, reason: `dependency closure exceeded ${bound} bound` });
  const deadlineExceeded = () => performance.now() - startedAt > limits.maxElapsedMs;
  const inventory = trackedFiles(gitCwd);
  if (inventory.reason) return { complete: false, files: changedFiles, reason: inventory.reason };
  const tracked = inventory.files;
  if (tracked.length === 0) return { complete: false, files: changedFiles, reason: 'tracked source inventory is empty' };
  const trackedSet = new Set(tracked);
  const sourceExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
  const sourceFiles = tracked.filter(path => sourceExtensions.has(extname(path)) && !isMaterialExcludedPath(path, gitCwd));
  if (sourceFiles.length > limits.maxSourceFiles) return exceeded('source-file');
  if (deadlineExceeded()) return exceeded('elapsed-time');
  let totalSourceBytes = 0;
  for (const path of sourceFiles) {
    try {
      const size = lstatSync(resolve(gitCwd, path)).size;
      if (size > limits.maxSourceFileBytes) return exceeded('per-file byte');
      totalSourceBytes += size;
      if (totalSourceBytes > limits.maxTotalSourceBytes) return exceeded('total-source byte');
    } catch { return { complete: false, files: changedFiles, reason: `source inventory unreadable: ${path}` }; }
    if (deadlineExceeded()) return exceeded('elapsed-time');
  }
  const sourceSet = new Set(sourceFiles);
  const graph = new Map<string, Set<string>>(sourceFiles.map(path => [path, new Set<string>()]));
  const realProjectRoot = realpathSync(gitCwd);
  const configPath = ts.findConfigFile(gitCwd, ts.sys.fileExists);
  let compilerOptions: ts.CompilerOptions = { moduleResolution: ts.ModuleResolutionKind.Node16 };
  if (configPath) {
    if (lstatSync(configPath).size > limits.maxSourceFileBytes) return exceeded('config byte');
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) return { complete: false, files: changedFiles, reason: 'TypeScript config is unreadable' };
    compilerOptions = ts.parseJsonConfigFileContent(config.config, { ...ts.sys, readDirectory: () => [] }, dirname(configPath)).options;
  }
  const moduleCache = ts.createModuleResolutionCache(gitCwd, path => ts.sys.useCaseSensitiveFileNames ? path : path.toLowerCase(), compilerOptions);
  let parsedBytes = 0;
  for (const path of sourceFiles) {
    if (deadlineExceeded()) return exceeded('elapsed-time');
    const absolute = resolve(gitCwd, path);
    try {
      if (lstatSync(absolute).isSymbolicLink() || relative(realProjectRoot, realpathSync(absolute)).startsWith('..')) {
        return { complete: false, files: changedFiles, reason: `source inventory contains symlink escape: ${path}` };
      }
      const text = readFileSync(absolute, 'utf8');
      const bytes = Buffer.byteLength(text);
      parsedBytes += bytes;
      if (bytes > limits.maxSourceFileBytes) return exceeded('per-file byte');
      if (parsedBytes > limits.maxTotalSourceBytes) return exceeded('total-source byte');
      if (deadlineExceeded()) return exceeded('elapsed-time');
      const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
      if (hasOpaqueDynamicLoad(source)) {
        return { complete: false, files: changedFiles, reason: `opaque dynamic dependency: ${path}` };
      }
      const imports = ts.preProcessFile(text, true, true).importedFiles.map(entry => entry.fileName);
      for (const specifier of imports) {
        if (deadlineExceeded()) return exceeded('elapsed-time');
        const resolved = ts.resolveModuleName(specifier, absolute, compilerOptions, ts.sys, moduleCache).resolvedModule;
        if (!resolved) {
          // A bare specifier may be a runtime/bundler alias into this repo.
          // Only a proven builtin can be ignored without a resolved target.
          if (isBuiltin(specifier)) continue;
          return { complete: false, files: changedFiles, reason: `unresolved ${specifier.startsWith('.') ? 'relative' : 'bare'} dependency: ${path} -> ${specifier}` };
        }
        const target = canonicalRepoPath(gitCwd, relative(gitCwd, resolved.resolvedFileName));
        if (!target || !sourceSet.has(target)) {
          if (!resolved.isExternalLibraryImport && !resolved.resolvedFileName.includes('/node_modules/')) {
            return { complete: false, files: changedFiles, reason: `dependency escapes tracked source inventory: ${path} -> ${specifier}` };
          }
          continue;
        }
        graph.get(path)!.add(target);
        graph.get(target)!.add(path);
      }
    } catch {
      return { complete: false, files: changedFiles, reason: `source inventory unreadable: ${path}` };
    }
  }
  if (deadlineExceeded()) return exceeded('elapsed-time');
  const sourceChanged = changedFiles.filter(path => sourceExtensions.has(extname(path)));
  if (sourceChanged.some(path => !trackedSet.has(path) || !sourceSet.has(path))) {
    return { complete: false, files: changedFiles, reason: 'changed source is not a canonical tracked inventory member' };
  }
  const closure = new Set(changedFiles);
  const queue = [...sourceChanged];
  while (queue.length > 0) {
    if (deadlineExceeded()) return exceeded('elapsed-time');
    const path = queue.shift()!;
    for (const adjacent of graph.get(path) ?? []) {
      if (closure.has(adjacent)) continue;
      closure.add(adjacent);
      queue.push(adjacent);
    }
  }
  return { complete: true, files: [...closure].sort() };
}

function signPostRemediationSelection(
  selection: Omit<PostRemediationReviewSelection, '_hash'>,
): PostRemediationReviewSelection {
  return {
    ...selection,
    _hash: domainSeparatedDigest(POST_REMEDIATION_REVIEW_POLICY_VERSION, selection),
  };
}

export function verifyPostRemediationReviewSelection(selection: PostRemediationReviewSelection): boolean {
  const { _hash, ...unsigned } = selection;
  const uniqueActive = [...new Set(selection.activeLanes)];
  const uniqueSelected = [...new Set(selection.selectedLanes)];
  return selection.schemaVersion === POST_REMEDIATION_REVIEW_POLICY_VERSION
    && selection.policyVersion === POST_REMEDIATION_REVIEW_POLICY_VERSION
    && selection.requiredHostAssurance === 'unchanged'
    && _hash === domainSeparatedDigest(POST_REMEDIATION_REVIEW_POLICY_VERSION, unsigned)
    && selection.activeLanes.length === uniqueActive.length
    && selection.selectedLanes.length === uniqueSelected.length
    && selection.selectedLanes.length > 0
    && selection.selectedLanes.every(lane => selection.activeLanes.includes(lane))
    && selection.selectedLanes.every((lane, index) => lane === selection.activeLanes.filter(active => uniqueSelected.includes(active))[index]);
}

export function verifyCurrentPostRemediationReviewSelection(
  store: StoryStore,
  projectRoot: string,
  storyId: string,
  selection: PostRemediationReviewSelection,
  active?: readonly { name: string; reason: string; forced?: boolean }[],
): boolean {
  if (!verifyPostRemediationReviewSelection(selection) || selection.storyId !== storyId) return false;
  const gitCwd = resolveGitCwd({ store, storyId, metadataRoot: projectRoot, projectRoot });
  const story = store.readStory(storyId);
  const scopeDigest = reviewInventoryAcceptanceSubjectDigestForStore(store, storyId);
  const bindingMatches = story.currentReviewRound === selection.reviewRound
    && currentGitHead(gitCwd) === selection.headHash
    && currentMaterialHash(gitCwd, 'HEAD', projectRoot) === selection.materialHash
    && currentStoryFilesHash(gitCwd, 'HEAD', projectRoot) === selection.storyFilesHash
    && scopeDigest === selection.scopeDigest
    && openReviewFindingDigest(store, storyId) === selection.openFindingDigest;
  if (!bindingMatches) return false;
  return !active || postRemediationReviewSelection(store, projectRoot, storyId, active)._hash === selection._hash;
}

function impactedLanes(
  closureFiles: readonly string[],
  active: readonly { name: string; reason: string; forced?: boolean }[],
): string[] {
  const hasDocs = closureFiles.some(path => /(^|\/)(docs?|requirements)(\/|$)|\.(md|mdx|rst|adoc)$/i.test(path));
  const hasSource = closureFiles.some(path => /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i.test(path) && !/(^|\/)(tests?|__tests__)(\/|$)|\.(test|spec)\./i.test(path));
  const hasTests = closureFiles.some(path => /(^|\/)(tests?|__tests__)(\/|$)|\.(test|spec)\./i.test(path));
  return active.filter(reviewer => {
    if (reviewer.forced) return true;
    // A production-source repair can alter any active review concern. Without
    // a canonical docs/behavior dependency edge, excluding those lanes would
    // be a guess rather than a proven closure.
    if (hasSource) return true;
    if (reviewer.name === 'docs') return hasDocs;
    if (reviewer.name === 'concept') return false;
    if (reviewer.name === 'quality') return hasTests;
    if (reviewer.name === 'test-coverage') return hasTests;
    if (reviewer.name === 'behavior') return false;
    return true;
  }).map(reviewer => canonicalAgentRoleId(`proof-or-stop-review-${reviewer.name}`));
}

export function openReviewFindingDigest(store: StoryStore, storyId: string): string {
  return reviewInventoryDigest(store.readFindings(storyId).findings
    .filter(row => row.status === 'open').map(row => ({ ...row })).sort((a, b) => a.id.localeCompare(b.id)));
}

export function postRemediationReviewSelection(
  store: StoryStore,
  projectRoot: string,
  storyId: string,
  active: readonly { name: string; reason: string; forced?: boolean }[],
): PostRemediationReviewSelection {
  const gitCwd = resolveGitCwd({ store, storyId, metadataRoot: projectRoot, projectRoot });
  const story = store.readStory(storyId);
  const headHash = currentGitHead(gitCwd) ?? '<unavailable>';
  const materialHash = currentMaterialHash(gitCwd, 'HEAD', projectRoot) ?? '<unavailable>';
  const storyFilesHash = currentStoryFilesHash(gitCwd, 'HEAD', projectRoot) ?? '<unavailable>';
  const reviewRound = story.currentReviewRound ?? '<unavailable>';
  const activeLanes = active.map(row => canonicalAgentRoleId(`proof-or-stop-review-${row.name}`));
  const checklist = store.readChecklist(storyId);
  const scopeDigest = reviewInventoryAcceptanceSubjectDigestForStore(store, storyId);
  const openFindingDigest = openReviewFindingDigest(store, storyId);
  const data = store.readReviewInventoryEpochs(storyId);
  const receipt = [...data.receipts].reverse().find(row => Boolean(row.consumedAt));
  const fallback = (
    reason: PostRemediationSelectionReason,
    changedFiles: string[] = [],
    closureFiles: string[] = [],
    reasonDetail: string = reason,
  ) =>
    signPostRemediationSelection({
      schemaVersion: POST_REMEDIATION_REVIEW_POLICY_VERSION,
      storyId,
      reviewRound,
      headHash,
      materialHash,
      storyFilesHash,
      sourceReceiptId: receipt?.receiptId ?? null,
      sourceReviewRound: receipt?.reviewRound ?? null,
      sourceHeadHash: receipt?.cutoff.headHash ?? null,
      activeLanes,
      selectedLanes: activeLanes,
      selection: 'full-set',
      reason,
      reasonDetail,
      changedFiles: [...new Set(changedFiles)].sort(),
      closureFiles: [...new Set(closureFiles)].sort(),
      scopeDigest,
      openFindingDigest,
      requiredHostAssurance: 'unchanged',
      policyVersion: POST_REMEDIATION_REVIEW_POLICY_VERSION,
    });
  if (store.readFindings(storyId).findings.some(row => row.status === 'open')) return fallback('OPEN_FINDINGS_REQUIRE_FULL_SET');
  if (!receipt) return fallback('NO_CONSUMED_INVENTORY_RECEIPT');
  const epoch = data.epochs.find(row => row.epochId === receipt.epochId);
  if (!verifyReviewInventoryReceipt(receipt) || !epoch || !verifyReviewInventoryEpoch(epoch)
    || epoch.receiptId !== receipt.receiptId || !epoch.consumedAt) return fallback('RECEIPT_OR_EPOCH_INVALID');
  if (activeLanes.some(lane => !receipt.requiredLanes.includes(lane) || !epoch.requiredLanes.includes(lane))
    || receipt.rosterBasis || epoch.rosterBasis) return fallback('SOURCE_ROSTER_INCOMPLETE');
  if (!story.currentReviewRound || story.currentReviewRound === receipt.reviewRound) {
    return fallback('CURRENT_REVIEW_ROUND_MISSING_OR_UNCHANGED');
  }
  if ([headHash, materialHash, storyFilesHash].some(value => value === '<unavailable>')) {
    return fallback('CURRENT_LINEAGE_UNAVAILABLE');
  }
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', receipt.cutoff.headHash, 'HEAD'], {
      cwd: gitCwd,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch {
    return fallback('SOURCE_CUTOFF_NOT_ANCESTOR');
  }
  if (receipt.scopeDigest !== scopeDigest) return fallback('SCOPE_OR_POLICY_CHANGED');
  const changedFiles = materialOnly(changedFilesBetweenRenameAware(gitCwd, receipt.cutoff.headHash, 'HEAD'), projectRoot);
  if (changedFiles.length === 0) return fallback('NO_MATERIAL_REMEDIATION');
  const statuses = changedFileStatusesBetweenRenameAware(gitCwd, receipt.cutoff.headHash, 'HEAD');
  if (Object.values(statuses).some(status => status.startsWith('R') || status.startsWith('C') || status === 'D')) {
    return fallback('UNSUPPORTED_RENAME_OR_DELETE', changedFiles);
  }
  const declaredFiles = new Set(checklist.items.flatMap(row => {
    if (Array.isArray(row.files)) return row.files;
    if (!row.files || typeof row.files !== 'object') return [];
    return [...(row.files.modify ?? []), ...(row.files.create ?? []), ...(row.files.test ?? [])];
  }).map(path => canonicalRepoPath(projectRoot, path)).filter((path): path is string => Boolean(path)));
  if (changedFiles.some(path => !declaredFiles.has(path))) {
    return fallback('CHANGED_FILE_OUTSIDE_FROZEN_SCOPE', changedFiles);
  }
  try {
    const rawDirty = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'], {
      maxBuffer: REVIEW_MAINTENANCE_GIT_MAX_BUFFER_BYTES,
      cwd: gitCwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const records = rawDirty.split('\0').filter(Boolean);
    const materialDirty: Array<{ status: string; path: string }> = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (record.length < 3 || record[2] !== ' ') {
        materialDirty.push({ status: '??', path: record });
        continue;
      }
      const status = record.slice(0, 2);
      const paths = [record.slice(3)];
      if ((status.includes('R') || status.includes('C')) && records[index + 1]) paths.push(records[++index]);
      for (const path of paths) {
        if (!isMaterialExcludedPath(path, projectRoot)) materialDirty.push({ status, path });
      }
    }
    if (materialDirty.some(row => row.status === '??' || row.status === '!!')) {
      return fallback('UNTRACKED_OR_IGNORED_MATERIAL', changedFiles);
    }
    if (materialDirty.length > 0) return fallback('DIRTY_MATERIAL', changedFiles);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'GIT_READ_FAILED';
    return fallback('DIRTY_STATE_UNREADABLE', changedFiles, [], `Git dirty-state probe failed: ${code}`);
  }
  const policy = classifyImpact({ changedFiles, declaredTestFiles: [], testIntentRefsByFile: {}, changedFileStatus: statuses });
  if (policy.impacts.some(impact => ['public-contract', 'authority-or-permission', 'command-or-gate-policy', 'dependency-or-build', 'unsupported-rename', 'unknown'].includes(impact.category))) {
    return fallback(
      'POLICY_IMPACT_REQUIRES_FULL_SET',
      changedFiles,
      [],
      policy.impacts.map(impact => `${impact.path}:${impact.reasonCode}`).sort().join(', '),
    );
  }
  const closure = computeCanonicalDependencyClosure(gitCwd, changedFiles);
  if (!closure.complete) return fallback('DEPENDENCY_CLOSURE_INCOMPLETE', changedFiles, closure.files, closure.reason);
  const selectedLanes = impactedLanes(closure.files, active);
  if (selectedLanes.length === 0) return fallback('EMPTY_IMPACT_SELECTION', changedFiles, closure.files);
  return signPostRemediationSelection({
    schemaVersion: POST_REMEDIATION_REVIEW_POLICY_VERSION,
    storyId,
    reviewRound,
    headHash,
    materialHash,
    storyFilesHash,
    sourceReceiptId: receipt.receiptId,
    sourceReviewRound: receipt.reviewRound,
    sourceHeadHash: receipt.cutoff.headHash,
    activeLanes,
    selectedLanes,
    selection: 'dependency-closure',
    reason: 'PROVEN_CANONICAL_DEPENDENCY_CLOSURE',
    reasonDetail: `${changedFiles.length} changed file(s) close over ${closure.files.length} tracked dependency file(s)`,
    changedFiles: [...changedFiles].sort(),
    closureFiles: closure.files,
    scopeDigest,
    openFindingDigest,
    requiredHostAssurance: 'unchanged',
    policyVersion: POST_REMEDIATION_REVIEW_POLICY_VERSION,
  });
}

export interface ReviewIncrementalContext {
  /** The reviewer role this context was computed for (echoed back). */
  role: string;
  /**
   * Authoritative "no usable incremental baseline" signal. `isFirstPass=true`
   * means there is NO resolvable prior-pass headHash to diff against, which
   * covers BOTH sub-cases:
   *   (a) the reviewer has never passed/finding-ed on this story, AND
   *   (b) a prior verdict EXISTS but the run it was bound to has a missing /
   *       unresolvable headHash (so we cannot compute an incremental base).
   * In both sub-cases `priorHeadHash` is null and `changedFiles` is the full
   * `main...HEAD` material diff. Consumers MUST treat `isFirstPass` — NOT
   * `priorVerdict` — as the authoritative "no incremental baseline" flag.
   */
  isFirstPass: boolean;
  /**
   * The headHash the prior verdict was bound to, when resolvable. Always null
   * whenever `isFirstPass=true` (including sub-case (b) above). Non-null only
   * when `isFirstPass=false`, in which case it is the base of the incremental
   * `changedFiles` diff.
   */
  priorHeadHash: string | null;
  /**
   * Human summary of the most recent prior verdict (e.g. "PASS (RP-001)" or
   * "finding F-002: high"), or null when the reviewer has no prior verdict.
   * INFORMATIONAL ONLY. It MAY be non-null even when `isFirstPass=true`: in
   * sub-case (b) a prior verdict exists but its bound headHash is unresolvable,
   * so `priorVerdict` is non-null yet `priorHeadHash` is null and the full diff
   * is returned. Never infer "has incremental baseline" from `priorVerdict`;
   * use `isFirstPass` for that.
   */
  priorVerdict: string | null;
  /**
   * Whether any MATERIAL file changed relative to the baseline. When
   * `isFirstPass=false` this equals `changedFiles.length > 0`. When
   * `isFirstPass=true` it is forced to true (a first pass conservatively
   * "shows everything"), so it MAY be true even if `changedFiles` is empty —
   * do not assume `scopeChanged === (changedFiles.length > 0)` in that branch.
   */
  scopeChanged: boolean;
  /**
   * Material files changed since the baseline. When `isFirstPass=true` this is
   * the full `main...HEAD` material diff; otherwise the diff from
   * `priorHeadHash` to HEAD (rename-aware, material-filtered).
   */
  changedFiles: string[];
  contextMode: 'full' | 'incremental';
  impactPolicyVersion: typeof IMPACT_CLASSIFICATION_POLICY_VERSION;
  freshnessClassification: EvidenceFreshnessClassification | 'NOT_EVALUATED';
  eligibilityReasonCodes: string[];
  eligibilityDigest: string;
  impact: ImpactClassification;
  priorPassRef: string | null;
  priorReviewRunId: string | null;
  currentHeadHash: string | null;
  currentMaterialHash: string | null;
  currentStoryFilesHash: string | null;
  changedFilesDigest: string;
  impactedFiles: string[];
  impactedFilesDigest: string;
  reviewBasis: IncrementalReviewBasis | null;
  reviewBasisDigest: string | null;
  taskSemanticDigest: string | null;
  /**
   * Old-PoS run 31: the task digests with verified Story-metadata corrections
   * reverted (userSees text the reviewers themselves asked to correct). A pass
   * judged before such a correction stays current (no lane rerun); absent when no
   * correction applies. Old-PoS run 44: one digest per journaled applied userSees
   * correction (metadataCorrectionCheckpoints, newest reverted first, no corrected
   * value needed), plus the run-31 corrected-value revert; an intent-row
   * correction is never reverted.
   */
  taskSemanticDigestsBeforeMetadataCorrection?: string[];
}

interface TrustedPriorPass {
  pass: ReviewPass;
  run: ReviewRun;
}

export interface IncrementalBindingAssessment {
  priorEnvelopePresent: boolean;
  runtimeContractMatches: boolean;
  roleContractMatches: boolean;
  executionEnvironmentMatches: boolean;
  assemblerMatches: boolean;
  dispatchProtocolMatches: boolean;
  scopePolicyMatches: boolean;
  taskSemanticDigestMatches: boolean;
  freshnessClassification: EvidenceFreshnessClassification;
  pureFixtureDrift: boolean;
}

export const FULL_INCREMENTAL_BASIS_EXCEEDS_BOUNDED_PATHS =
  'FULL_INCREMENTAL_BASIS_EXCEEDS_BOUNDED_PATHS' as const;
export const FULL_INCREMENTAL_BASIS_EXCEEDS_BOUNDED_FINDINGS =
  'FULL_INCREMENTAL_BASIS_EXCEEDS_BOUNDED_FINDINGS' as const;

/** Return stable full-context reasons before an invalid bounded basis is built. */
export function incrementalReviewBasisOverflowReasonCodes(input: {
  changedFiles: readonly unknown[];
  impactedFiles: readonly unknown[];
  authoritativeReferences: readonly unknown[];
  findingDeltas: readonly unknown[];
  unresolvedFindings: readonly unknown[];
  findingDescriptionExceedsTextLimit?: boolean;
}): string[] {
  const reasons: string[] = [];
  if ([input.changedFiles, input.impactedFiles, input.authoritativeReferences]
    .some(values => values.length > FULL_TASK_CONTEXT_LIMITS.pathsPerList)) {
    reasons.push(FULL_INCREMENTAL_BASIS_EXCEEDS_BOUNDED_PATHS);
  }
  if ([input.findingDeltas, input.unresolvedFindings]
    .some(values => values.length > FULL_TASK_CONTEXT_LIMITS.verificationIntentsPerLane)) {
    reasons.push(FULL_INCREMENTAL_BASIS_EXCEEDS_BOUNDED_FINDINGS);
  }
  if (input.findingDescriptionExceedsTextLimit) reasons.push('FULL_REVIEW_BASIS_TEXT_LIMIT');
  return reasons;
}

/** Stable forced-full campaign surface consumed by the production assembler. */
export function classifyIncrementalBindingReasons(input: IncrementalBindingAssessment): string[] {
  const reasons: string[] = [];
  if (!input.priorEnvelopePresent) reasons.push('FULL_MISSING_PRIOR_ENVELOPE');
  if (!input.runtimeContractMatches) reasons.push('FULL_RUNTIME_CONTRACT_CHANGED');
  if (!input.roleContractMatches) reasons.push('FULL_ROLE_CONTRACT_CHANGED');
  if (!input.executionEnvironmentMatches) reasons.push('FULL_EXECUTION_ENVIRONMENT_CHANGED');
  if (!input.assemblerMatches) reasons.push('FULL_ASSEMBLER_CHANGED');
  if (!input.dispatchProtocolMatches) reasons.push('FULL_DISPATCH_PROTOCOL_CHANGED');
  if (!input.scopePolicyMatches) reasons.push('FULL_SCOPE_OR_POLICY_CHANGED');
  if (!input.taskSemanticDigestMatches) reasons.push('FULL_MODEL_RELEVANT_TASK_CONTEXT_CHANGED');
  if (['CURRENT_MATERIAL', 'KNOWN_METADATA_ONLY_HEAD_DRIFT'].includes(input.freshnessClassification)) {
    reasons.push('ELIGIBLE_TRUSTED_PRIOR_BINDINGS');
  } else if (input.pureFixtureDrift) {
    reasons.push('ELIGIBLE_RELATED_PURE_STORY_FIXTURE_DRIFT');
  } else {
    reasons.push(`FULL_FRESHNESS_${input.freshnessClassification}`);
  }
  return reasons;
}

function verdictTime(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function latestTrustedPriorPass(
  store: StoryStore,
  storyId: string,
  role: string,
  passes: ReviewPass[],
  runs: ReviewRun[],
  excludedReviewRunId?: string,
  passesCutoffAt?: string,
  promptEnvelopes?: readonly PromptEnvelope[],
): TrustedPriorPass | null {
  const candidates: TrustedPriorPass[] = [];
  const cutoff = passesCutoffAt ? verdictTime(passesCutoffAt) : Number.POSITIVE_INFINITY;
  for (const pass of passes) {
    const passTime = verdictTime(pass.createdAt);
    // Equal timestamps are conservatively treated as post-cutoff. A reviewer
    // pass created in the same millisecond as run.startedAt could otherwise be
    // observed by assembly and rejected by verifier, creating an ABA race.
    if (Number.isFinite(cutoff) && passTime >= cutoff) continue;
    if (!agentRoleIdsEqual(pass.agent, role) || !verifyReviewPass(storyId, pass) || !pass.reviewRunId) continue;
    if (pass.reviewRunId === excludedReviewRunId) continue;
    const run = runs.find(candidate => candidate.reviewRunId === pass.reviewRunId);
    if (!run || !agentRoleIdsEqual(run.lane, role) || !verifyReviewRun(run, store)) continue;
    if (!run.envelopeId || pass.envelopeId !== run.envelopeId) continue;
    try { if (!store.readReviewPrompt(run)) continue; } catch { continue; }
    const envelopes = (promptEnvelopes ?? store.readPromptEnvelopes(storyId).envelopes).filter(
      envelope => envelope.envelopeId === run.envelopeId,
    );
    if (envelopes.length !== 1) continue;
    const envelope = envelopes[0];
    if (!verifyPromptEnvelopeIntegrity(envelope)) continue;
    if (
      envelope.storyId !== storyId
      || !agentRoleIdsEqual(envelope.roleId, role)
      || !agentRoleIdsEqual(envelope.lane, role)
      || envelope.reviewRunId !== run.reviewRunId
      || envelope.reviewRound !== run.reviewRound
      || envelope.headHash !== run.headHash
      || envelope.materialHash !== run.materialHash
      || envelope.storyFilesHash !== run.storyFilesHash
      || envelope.assembledPromptDigest !== run.promptHash
    ) continue;
    candidates.push({ pass, run });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => verdictTime(a.pass.createdAt) - verdictTime(b.pass.createdAt));
  return candidates[candidates.length - 1];
}

function materialOnly(files: string[], projectRoot: string): string[] {
  return files.filter((file) => !isMaterialExcludedPath(file, projectRoot));
}

function gitFileAt(gitCwd: string, ref: string, path: string): GitBlobReadResult {
  return readGitBlobAt(gitCwd, ref, path);
}

function fixtureCases(raw: GitBlobReadResult): Array<Record<string, unknown>> | null {
  if (raw.status === 'missing') return [];
  if (raw.status === 'error') return null;
  try {
    const parsed = JSON.parse(raw.content.toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { cases?: unknown }).cases)) return null;
    const cases = (parsed as { cases: unknown[] }).cases;
    if (!cases.every(value => value && typeof value === 'object' && !Array.isArray(value))) return null;
    return cases as Array<Record<string, unknown>>;
  } catch {
    return null;
  }
}

function fixtureCaseKey(value: Record<string, unknown>, index: number): string {
  for (const field of ['_id', 'id', 'name']) {
    const candidate = value[field];
    if (typeof candidate === 'string' && candidate.trim()) return `${field}:${candidate.trim()}`;
  }
  return `index:${index}`;
}

function canonicalFixtureCaseSet(
  cases: Array<Record<string, unknown>>,
): Map<string, Record<string, unknown>> | null {
  const result = new Map<string, Record<string, unknown>>();
  const identityOwners = new Map<string, number>();
  for (const [index, value] of cases.entries()) {
    // All supported identity aliases participate in uniqueness, not only the
    // highest-priority field selected by fixtureCaseKey. Otherwise an `_id:x`
    // case and a later `id:x`/`name:x` case can ambiguously identify the same
    // logical case while occupying different Map keys.
    for (const field of ['_id', 'id', 'name']) {
      const candidate = value[field];
      if (typeof candidate !== 'string' || !candidate.trim()) continue;
      const alias = candidate.trim();
      const owner = identityOwners.get(alias);
      if (owner !== undefined && owner !== index) return null;
      identityOwners.set(alias, index);
    }
    const key = fixtureCaseKey(value, index);
    if (result.has(key)) return null;
    result.set(key, value);
  }
  return result;
}

/**
 * Proves case-level closure from trusted git objects. File-level declarations
 * are insufficient: every new/changed case must carry a current Story-scoped
 * positional intentRef and removed cases fail closed.
 */
export function fixtureCaseClosure(
  gitCwd: string,
  baseRef: string,
  storyId: string,
  path: string,
  currentStoryIntentRefs: ReadonlySet<string>,
  /**
   * B-137a: ref treated as "current". Defaults to HEAD so read-only callers are
   * byte-identical; the REVIEW-evidence verifier passes the signed
   * ReviewRun.headHash so a later metadata-only commit cannot rewrite a
   * receipt-bound envelope's eligibility digest.
   */
  asOfRef: string = 'HEAD',
): boolean {
  const before = fixtureCases(gitFileAt(gitCwd, baseRef, path));
  const after = fixtureCases(gitFileAt(gitCwd, asOfRef, path));
  if (!before || !after) return false;
  // Reject duplicate/ambiguous identities in both snapshots before any Map or
  // digest comparison. This makes overwrite order irrelevant and prevents an
  // unbound duplicate from hiding behind an unchanged later occurrence.
  const prior = canonicalFixtureCaseSet(before);
  const current = canonicalFixtureCaseSet(after);
  if (!prior || !current) return false;
  if ([...prior.keys()].some(key => !current.has(key))) return false;
  const storyPrefix = `${storyId}:`;
  for (const [key, value] of current) {
    const previous = prior.get(key);
    if (previous && domainSeparatedDigest('fixture-case.v1', previous) === domainSeparatedDigest('fixture-case.v1', value)) {
      continue;
    }
    const intentRef = typeof value.intentRef === 'string' ? value.intentRef.trim() : '';
    if (!intentRef.startsWith(storyPrefix) || !currentStoryIntentRefs.has(intentRef)) return false;
  }
  return true;
}

/**
 * Read-only incremental review context for a reviewer `role` on `storyId`.
 *
 * - A trusted prior pass with a bound, resolvable headHash whose diff fits the
 *   bounded review-basis path lists → diff that headHash against HEAD
 *   (rename-aware, material-filtered); scopeChanged = changed > 0;
 *   isFirstPass = false; a review basis is emitted.
 * - No prior verdict (or prior verdict has no resolvable bound headHash) →
 *   isFirstPass = true, priorHeadHash = null, scopeChanged = true, and
 *   changedFiles = the full frozen Story-base...HEAD material diff.
 * - A trusted prior whose diff exceeds the bounded path lists → the full
 *   story diff against the frozen integration base, with the trusted prior retained for audit only,
 *   no review basis, and the explicit FULL_INCREMENTAL_BASIS_EXCEEDS_BOUNDED_PATHS
 *   reason code.
 */
function resolveFullStoryCommitObject(gitCwd: string, ref: string): string | undefined {
  try {
    const args = ['rev-parse', '--verify', `${ref}^{commit}`];
    return observedGit(gitCwd, args, () => execFileSync('git', args, {
      cwd: gitCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    })).trim();
  } catch {
    return undefined;
  }
}

export function resolveFullStoryBaseHead(store: StoryStore, projectRoot: string, storyId: string): string | undefined {
  const gitCwd = resolveGitCwd({ store, storyId, metadataRoot: projectRoot, projectRoot });
  const story = store.readStory(storyId);
  if (story.integrationTarget !== undefined) {
    const storedTarget = story.integrationTarget as unknown;
    if (!storedTarget || typeof storedTarget !== 'object' || Array.isArray(storedTarget)) {
      throw new Error('FULL_STORY_BASE_INVALID: Story integration target is malformed');
    }
    const target = storedTarget as Record<string, unknown>;
    const branch = target.parentBranch;
    const frozenBase = target.parentCommitAtCreation;
    if (typeof branch !== 'string' || !branch.trim() || branch !== branch.trim()
      || branch === 'HEAD' || /^(?:story|codex|lab)\//.test(branch)
      || (target.source !== 'creation_branch' && target.source !== 'repository_baseline')
      || target.deliveryMode !== 'merge_to_parent'
      || typeof frozenBase !== 'string') {
      throw new Error('FULL_STORY_BASE_INVALID: Story integration target is malformed');
    }
    try {
      validateFullStoryBaseHead(frozenBase);
    } catch {
      throw new Error('FULL_STORY_BASE_INVALID: Story integration target commit is malformed');
    }
    if (resolveFullStoryCommitObject(gitCwd, frozenBase) !== frozenBase) {
      throw new Error(`FULL_STORY_BASE_UNAVAILABLE: Story integration base ${frozenBase} does not resolve to a commit`);
    }
    return frozenBase;
  }
  // Historical Stories may predate integrationTarget. Preserve their exact
  // optional-field behavior when repository policy cannot identify a base.
  const legacyTarget = resolveStoryIntegrationTarget(gitCwd, story);
  const legacyBase = legacyTarget?.parentCommitAtCreation;
  return legacyBase && resolveFullStoryCommitObject(gitCwd, legacyBase) === legacyBase
    ? legacyBase
    : resolveFullStoryCommitObject(gitCwd, 'main');
}

export function reviewIncrementalContext(
  store: StoryStore,
  projectRoot: string,
  storyId: string,
  role: string,
  options: {
    /** Registered current contract; historical callers always provide their authenticated selection. */
    roleSemanticDigest?: string;
    excludedReviewRunId?: string;
    findingsCutoffAt?: string;
    passesCutoffAt?: string;
    /** Immutable prompt-envelope snapshot shared by one evidence collection. */
    promptEnvelopes?: readonly PromptEnvelope[];
    /** Signed run-start projection; prevents later finding disposition rewrites. */
    findingProjection?: PromptFindingProjection[];
    /**
     * B-137a: git ref treated as "current" for eligibility, freshness and diffs.
     * Defaults to HEAD so the read-only `review_incremental_context` command stays
     * byte-identical. The REVIEW-evidence verifier passes the signed
     * ReviewRun.headHash so later metadata-only commits cannot rewrite a
     * receipt-bound envelope's eligibilityDigest / reviewBasisDigest.
     */
    asOfRef?: string;
    /**
     * Explicit run-start base. When the property is absent, resolve the Story's
     * frozen integration base. Historical verifiers may pass the property with
     * an explicit `undefined` value to replay the pre-field digest exactly.
     */
    fullStoryBaseHead?: string;
    /**
     * Old-PoS run 44: the REVIEW-evidence verifier replays an envelope minted
     * before an applied Story-metadata correction: when this digest is one of
     * the correction checkpoints' digests, it is the task digest every
     * eligibility field is recomputed from (exactly the state the envelope
     * judged). Any other value is ignored.
     */
    acceptedTaskSemanticDigest?: string;
  } = {},
): ReviewIncrementalContext {
  const gitCwd = resolveGitCwd({ store, storyId, metadataRoot: projectRoot, projectRoot });
  const asOfRef = options.asOfRef?.trim() || 'HEAD';
  const hasExplicitFullStoryBaseHead = Object.prototype.hasOwnProperty.call(options, 'fullStoryBaseHead');
  const fullStoryBaseHead = hasExplicitFullStoryBaseHead
    ? options.fullStoryBaseHead
    : resolveFullStoryBaseHead(store, projectRoot, storyId);
  if (!hasExplicitFullStoryBaseHead && fullStoryBaseHead === undefined) {
    throw new Error(`FULL_STORY_BASE_UNAVAILABLE: repository integration baseline could not be resolved for Story ${storyId}`);
  }
  if (fullStoryBaseHead !== undefined) {
    validateFullStoryBaseHead(fullStoryBaseHead);
    if (resolveFullStoryCommitObject(gitCwd, fullStoryBaseHead) !== fullStoryBaseHead) {
      throw new Error(`FULL_STORY_BASE_UNAVAILABLE: signed comparison base ${fullStoryBaseHead} does not resolve to a commit`);
    }
  }
  const fullStoryBaseRef = fullStoryBaseHead ?? 'main';
  const passes = store.readReviewPasses(storyId).passes || [];
  const runs = store.readReviewRuns(storyId).runs || [];
  const findings = store.readFindings(storyId).findings || [];
  const prior = latestTrustedPriorPass(
    store,
    storyId,
    role,
    passes,
    runs,
    options.excludedReviewRunId,
    options.passesCutoffAt,
    options.promptEnvelopes,
  );
  const currentHead = (asOfRef === 'HEAD' ? currentGitHead(gitCwd) : gitCommitAtRef(gitCwd, asOfRef)) ?? null;
  const currentMaterial = currentMaterialHash(gitCwd, asOfRef, projectRoot) ?? null;
  const currentStoryFiles = currentStoryFilesHash(gitCwd, asOfRef, projectRoot) ?? null;
  const checklist = store.readChecklist(storyId);
  const scopeContract = store.readScopeContract(storyId);
  const story = store.readStory(storyId);
  let currentTaskSemanticDigest: string | null = null;
  const beforeMetadataCorrectionDigests: string[] = [];
  if (currentHead) {
    try {
      const contextOf = (items: typeof checklist.items) => fullTaskSemanticDigest(buildFullTaskContext({
        story,
        checklist: { ...checklist, items },
        headHash: currentHead,
        materialHash: currentMaterial ?? undefined,
        storyFilesHash: currentStoryFiles ?? undefined,
        scopeContract,
      }));
      currentTaskSemanticDigest = contextOf(checklist.items);
      let events: Array<Record<string, unknown>> = [];
      try { events = store.readProcessEvents(storyId) as unknown as Array<Record<string, unknown>>; } catch { events = []; }
      for (const items of metadataCorrectionCheckpoints(events, checklist.items)) beforeMetadataCorrectionDigests.push(contextOf(items as typeof checklist.items));
      const reverted = checklist.items.map(item => ({ ...item, userSees: routingUserSees(store as never, storyId, item.userSees) }));
      if (reverted.some((item, index) => item.userSees !== checklist.items[index]!.userSees)) beforeMetadataCorrectionDigests.push(contextOf(reverted as typeof checklist.items));
      if (options.acceptedTaskSemanticDigest && beforeMetadataCorrectionDigests.includes(options.acceptedTaskSemanticDigest)) {
        currentTaskSemanticDigest = options.acceptedTaskSemanticDigest;
      }
    } catch {
      // Legacy/malformed task context is not eligible; the stable FULL reason is
      // added below instead of letting this advisory read throw.
    }
  }
  const declaredTestFiles = checklist.items.flatMap(item => item.files?.test ?? []);
  const testIntentRefsByFile = Object.fromEntries(declaredTestFiles.map(path => {
    const refs = checklist.items
      .filter(item => item.files?.test?.includes(path))
      .flatMap(item => (['happy', 'edge', 'adversarial'] as const)
        .flatMap(lane => (item.verificationIntent?.[lane] ?? [])
          .map((intent, index) => intent.id?.trim() || `${item.id}:${lane}:${index}`)));
    return [path, [...new Set(refs)].sort()];
  }));
  const currentStoryIntentRefs = new Set(checklist.items.flatMap(item =>
    (['happy', 'edge', 'adversarial'] as const).flatMap(lane =>
      (item.verificationIntent?.[lane] ?? []).map((_intent, index) =>
        `${storyId}:${item.id}:${lane}:${index}`))));

  let fullStoryDiffContext!: (
    reasonCodes: string[],
    resolvedPriorForAudit?: TrustedPriorPass | null,
  ) => ReviewIncrementalContext;

  const finalize = (args: {
    prior: TrustedPriorPass | null;
    /** The trusted prior resolved but the served diff is the full story diff. */
    priorNotDiffed?: boolean;
    changedFiles: string[];
    freshnessClassification: EvidenceFreshnessClassification | 'NOT_EVALUATED';
    reasonCodes: string[];
    impact: ImpactClassification;
  }): ReviewIncrementalContext => {
    const eligibilityReasonCodes = [...new Set([...args.reasonCodes, ...args.impact.reasonCodes])].sort();
    const changedFilesDigest = domainSeparatedDigest('incremental.changed-files.v1', args.changedFiles);
    const impactedFilesDigest = domainSeparatedDigest('incremental.impacted-files.v1', args.impact.impactedFiles);
    const affectedPaths = new Set([...args.changedFiles, ...args.impact.impactedFiles]);
    const affectedItems = checklist.items.filter(item => [
      ...(item.files?.modify ?? []),
      ...(item.files?.create ?? []),
      ...(item.files?.test ?? []),
    ].some(path => affectedPaths.has(path)));
    const impactedIntentRefs = affectedItems.flatMap(item =>
      (['happy', 'edge', 'adversarial'] as const).flatMap(lane =>
        (item.verificationIntent?.[lane] ?? []).map((intent, index) =>
          intent.id?.trim() || `${item.id}:${lane}:${index}`)));
    let reviewBasis: IncrementalReviewBasis | null = null;
    if (args.prior && !args.priorNotDiffed) {
      const priorTime = Date.parse(args.prior.pass.createdAt);
      const cutoff = options.findingsCutoffAt ? Date.parse(options.findingsCutoffAt) : Number.POSITIVE_INFINITY;
      const findingSource = options.findingProjection ?? findings;
      const basisFindings = findingSource.filter(finding => {
        const created = Date.parse(finding.createdAt ?? '');
        return !Number.isFinite(cutoff) || (Number.isFinite(created) && created <= cutoff);
      });
      const findingDeltas = basisFindings
        .filter(finding => !Number.isFinite(priorTime) || Date.parse(finding.createdAt ?? '') >= priorTime)
        .map(finding => ({
          id: finding.id,
          state: finding.status,
          severity: finding.severity,
          category: finding.category,
        }))
        .sort((left, right) => left.id.localeCompare(right.id));
      const unresolvedFindings = basisFindings
        .filter(finding => finding.status === 'open')
        .map(finding => ({
          id: finding.id,
          severity: finding.severity,
          category: finding.category,
          desc: finding.desc,
        }))
        .sort((left, right) => left.id.localeCompare(right.id));
      const findingDescriptionExceedsBasisLimit = unresolvedFindings.some(
        finding => Buffer.byteLength(finding.desc, 'utf8') > FULL_TASK_CONTEXT_LIMITS.textBytes,
      );
      const authoritativeReferences = [...new Set([
        ...affectedItems.flatMap(item => item.relatedDocs ?? []),
        ...args.changedFiles,
        ...args.impact.impactedFiles,
      ])].sort();
      // B-45a0 (6f0250c985) additionally escalates when the affected items carry
      // more verificationIntent entries than the bounded basis can represent.
      // main's shared helper does not cover that input, so it is folded in here
      // rather than dropped by taking main's structure wholesale.
      const affectedIntentCount = affectedItems
        .flatMap(item => (['happy', 'edge', 'adversarial'] as const)
          .flatMap(lane => item.verificationIntent?.[lane] ?? []))
        .length;
      const overflowReasons = [
        ...incrementalReviewBasisOverflowReasonCodes({
          changedFiles: args.changedFiles,
          impactedFiles: args.impact.impactedFiles,
          authoritativeReferences,
          findingDeltas,
          unresolvedFindings,
          findingDescriptionExceedsTextLimit: findingDescriptionExceedsBasisLimit,
        }),
        ...(affectedIntentCount > FULL_TASK_CONTEXT_LIMITS.verificationIntentsPerLane
          ? ['FULL_BOUNDED_REVIEW_BASIS_EXCEEDED']
          : []),
      ];
      if (overflowReasons.length > 0) {
        // Recompute the authoritative main...HEAD context while retaining the
        // trusted prior in audit-only fields. Never construct an invalid basis
        // merely to discover that its bounded contract has been exceeded.
        return fullStoryDiffContext(overflowReasons, args.prior);
      }
      reviewBasis = {
        schemaVersion: CURRENT_PROMPT_IDENTITIES.incrementalReviewBasis,
        storyId,
        lane: role,
        priorPassRef: args.prior.pass.id,
        priorReviewRunId: args.prior.run.reviewRunId,
        priorEnvelopeId: args.prior.run.envelopeId!,
        reReviewReasonCodes: eligibilityReasonCodes,
        changedFiles: [...args.changedFiles].sort(),
        impactedFiles: [...args.impact.impactedFiles].sort(),
        impactedIntentRefs: [...new Set(impactedIntentRefs)].sort(),
        currentClaims: affectedItems
          .flatMap(item => (['happy', 'edge', 'adversarial'] as const)
            .flatMap(lane => (item.verificationIntent?.[lane] ?? []).map((intent, index) => ({
              intentRef: intent.id?.trim() || `${item.id}:${lane}:${index}`,
              claim: intent.desc,
              state: item.status,
            }))))
          .sort((left, right) => left.intentRef.localeCompare(right.intentRef)),
        invariants: [
          'Reviewer evidence remains bound to the exact current Story, lane, round, ReviewRun, Prompt Envelope, and hashes.',
          'Missing or unclosed affected context escalates to full review.',
          'Authoritative repository-relative references remain readable on demand.',
        ],
        findingDeltas,
        unresolvedFindings,
        affectedContracts: args.impact.impacts
          .filter(impact => !['no-material-change', 'pure-story-fixture'].includes(impact.category))
          .map(impact => `${impact.category}:${impact.path}`)
          .sort(),
        authoritativeReferences,
        ...(scopeContract ? { scopeAcknowledgementDigest: digestScopeContract(scopeContract) } : {}),
      };
      validateIncrementalReviewBasis(reviewBasis);
    }
    const contextMode = eligibilityReasonCodes.every(code => code.startsWith('ELIGIBLE_'))
      ? 'incremental' as const
      : 'full' as const;
    const reviewBasisDigest = reviewBasis
      ? domainSeparatedDigest('incremental-review-basis.v1', reviewBasis)
      : null;
    const semantic = {
      ...(fullStoryBaseHead !== undefined ? { fullStoryBaseHead } : {}),
      impactPolicyVersion: IMPACT_CLASSIFICATION_POLICY_VERSION,
      role,
      contextMode,
      priorPassRef: args.prior?.pass.id ?? null,
      priorReviewRunId: args.prior?.run.reviewRunId ?? null,
      priorEnvelopeId: args.prior?.run.envelopeId ?? null,
      priorHeadHash: args.prior?.run.headHash ?? null,
      freshnessClassification: args.freshnessClassification,
      eligibilityReasonCodes: eligibilityReasonCodes,
      changedFilesDigest,
      impactedFilesDigest,
      impactDigest: args.impact.digest,
      reviewBasisDigest,
    };
    return {
      role,
      isFirstPass: !args.prior,
      priorHeadHash: args.prior?.run.headHash ?? null,
      priorVerdict: args.prior ? `PASS (${args.prior.pass.id})` : null,
      scopeChanged: !args.prior || args.priorNotDiffed === true || args.changedFiles.length > 0,
      changedFiles: args.changedFiles,
      contextMode,
      impactPolicyVersion: IMPACT_CLASSIFICATION_POLICY_VERSION,
      freshnessClassification: args.freshnessClassification,
      eligibilityReasonCodes: eligibilityReasonCodes,
      eligibilityDigest: domainSeparatedDigest('incremental-eligibility.v1', semantic),
      impact: args.impact,
      priorPassRef: args.prior?.pass.id ?? null,
      priorReviewRunId: args.prior?.run.reviewRunId ?? null,
      currentHeadHash: currentHead,
      currentMaterialHash: currentMaterial,
      currentStoryFilesHash: currentStoryFiles,
      changedFilesDigest,
      impactedFiles: args.impact.impactedFiles,
      impactedFilesDigest,
      reviewBasis,
      reviewBasisDigest,
      taskSemanticDigest: currentTaskSemanticDigest,
      ...(beforeMetadataCorrectionDigests.length ? { taskSemanticDigestsBeforeMetadataCorrection: [...new Set(beforeMetadataCorrectionDigests)] } : {}),
    };
  };

  // Full story diff fallback is shared by first-timer and bounded-paths cases.
  // The latter retains the trusted prior for audit, but never emits a basis
  // computed from a diff that exceeded the bounded contract.
  fullStoryDiffContext = (
    reasonCodes: string[],
    resolvedPriorForAudit: TrustedPriorPass | null = null,
  ): ReviewIncrementalContext => {
    const fullDiff = materialOnly(changedFilesBetweenRenameAware(gitCwd, fullStoryBaseRef, asOfRef), projectRoot);
    const impact = classifyImpact({
      changedFiles: fullDiff,
      declaredTestFiles,
      testIntentRefsByFile,
      fixtureCaseClosureByFile: Object.fromEntries(fullDiff.map(path => [
        path,
        declaredTestFiles.includes(path)
          && fixtureCaseClosure(gitCwd, fullStoryBaseRef, storyId, path, currentStoryIntentRefs, asOfRef),
      ])),
      changedFileStatus: changedFileStatusesBetweenRenameAware(gitCwd, fullStoryBaseRef, asOfRef),
    });
    return finalize({
      prior: resolvedPriorForAudit,
      priorNotDiffed: resolvedPriorForAudit !== null,
      changedFiles: fullDiff,
      freshnessClassification: 'NOT_EVALUATED',
      reasonCodes,
      impact,
    });
  };

  // First-timer (or a prior verdict whose bound headHash cannot be resolved):
  // fall back to the full story diff against main. We treat a missing bound
  // headHash as a first pass so we never compute an incremental diff from an
  // unknown base — the conservative direction is "show everything".
  if (!prior || !prior.run.headHash) {
    return fullStoryDiffContext(['FULL_MISSING_TRUSTED_PRIOR_PASS']);
  }

  const changedFiles = materialOnly(
    changedFilesBetweenRenameAware(gitCwd, prior.run.headHash, asOfRef),
    projectRoot,
  );
  if (changedFiles.length > FULL_TASK_CONTEXT_LIMITS.pathsPerList) {
    return fullStoryDiffContext([FULL_INCREMENTAL_BASIS_EXCEEDS_BOUNDED_PATHS], prior);
  }
  const statuses = changedFileStatusesBetweenRenameAware(gitCwd, prior.run.headHash, asOfRef);
  const freshness = checkEvidenceFreshnessForGit(
    gitCwd,
    prior.run.headHash,
    prior.run.materialHash,
    projectRoot,
    prior.run.storyFilesHash,
    asOfRef,
  );
  const freshnessClassification = classifyEvidenceFreshness(freshness, prior.run.headHash);
  const storyForRole = store.readStory(storyId);
  const inventoryForRole = options.roleSemanticDigest === undefined
    && canonicalAgentRoleId(role) === 'proof-or-stop-review-topology-critic'
    && storyForRole.phase === 'REVIEW' ? currentOpenReviewInventory(store, storyId) : null;
  const currentRole = options.roleSemanticDigest !== undefined
    ? promptRoleContractForSemanticDigest(role, options.roleSemanticDigest)
    : promptRoleContract(role, inventoryForRole?.reviewRound === storyForRole.currentReviewRound
      && inventoryForRole?.storyId === storyId ? 'inventory-completeness' : undefined);
  const environmentDigest = domainSeparatedDigest('known-execution-environment.v1', captureKnownExecutionEnvironment());
  const promptEnvelopes = options.promptEnvelopes ?? store.readPromptEnvelopes(storyId).envelopes;
  const priorEnvelope = promptEnvelopes.find(
    envelope => envelope.envelopeId === prior.run.envelopeId,
  );
  const currentPolicyHash = scopeContract ? digestScopeContract(scopeContract) : undefined;
  const runtimeContractMatches = Boolean(priorEnvelope) && !(
    priorEnvelope?.runtimeContractVersion !== BASELINE_RUNTIME_CONTRACT.schemaVersion
    || priorEnvelope?.runtimeSemanticDigest !== BASELINE_RUNTIME_CONTRACT.semanticDigest
    || priorEnvelope?.runtimeRenderDigest !== BASELINE_RUNTIME_CONTRACT.renderDigest
  );
  const roleContractMatches = Boolean(priorEnvelope) && !(
    priorEnvelope?.roleContractVersion !== currentRole.schemaVersion
    || priorEnvelope?.roleSemanticDigest !== currentRole.semanticDigest
    || priorEnvelope?.roleRenderDigest !== currentRole.renderDigest
  );
  const impact = classifyImpact({
    changedFiles,
    declaredTestFiles,
    testIntentRefsByFile,
    fixtureCaseClosureByFile: Object.fromEntries(changedFiles.map(path => [
      path,
      declaredTestFiles.includes(path)
        && fixtureCaseClosure(gitCwd, prior.run.headHash, storyId, path, currentStoryIntentRefs, asOfRef),
    ])),
    changedFileStatus: statuses,
  });
  const pureFixtureDrift = freshnessClassification === 'RELATED_STORY_MATERIAL_DRIFT'
    && impact.eligible
    && impact.impacts.every(item => item.reasonCode === 'ELIGIBLE_PURE_STORY_FIXTURE')
    && Boolean(prior.run.storyFilesHash);
  const bindingReasons = classifyIncrementalBindingReasons({
    priorEnvelopePresent: Boolean(priorEnvelope),
    runtimeContractMatches,
    roleContractMatches,
    executionEnvironmentMatches: priorEnvelope?.knownExecutionEnvironmentDigest === environmentDigest,
    assemblerMatches: priorEnvelope?.assemblerVersion === PROMPT_ENVELOPE_ASSEMBLER_VERSION,
    dispatchProtocolMatches: priorEnvelope?.dispatchProtocolVersion === PROMPT_DISPATCH_PROTOCOL_VERSION,
    scopePolicyMatches: priorEnvelope?.policyHash === currentPolicyHash,
    taskSemanticDigestMatches: Boolean(priorEnvelope?.taskSemanticDigest)
      && priorEnvelope?.taskSemanticDigest === currentTaskSemanticDigest,
    freshnessClassification,
    pureFixtureDrift,
  });
  return finalize({
    prior,
    changedFiles,
    freshnessClassification,
    reasonCodes: bindingReasons,
    impact,
  });
}
