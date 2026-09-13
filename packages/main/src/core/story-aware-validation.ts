/**
 * Story-aware dynamic validation.
 *
 * This module keeps dynamic planning separate from the existing complete-plan
 * executor.  The complete plan remains the oracle in observe and shadow mode.
 * Every signed artifact uses a repository-local Ed25519 signer whose private
 * key lives outside writable runtime artifacts. Digest helpers remain for
 * identity and cache keys; they are not provenance signatures.
 */
import { execFileSync } from 'node:child_process';
import { authorityRevisionClosure, validationAuthoritySources } from './validation-authority-graph.js';
import { readStoryGitBytes } from './story-git-bytes.js';
import { effectiveValidationCommandEnvironment } from './validation-command-environment.js';
import { VALIDATION_SOURCE_PROVENANCE_SCHEMA } from './runtime-fact-registry.js';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { PROOF_OR_STOP_CONFIG_FILENAME } from './brand-paths.js';
import { pickProjectConfigPath } from './config.js';
import type { ResourceClaim } from './keyed-scheduler.js';
import { validateResourceClaims } from './keyed-scheduler.js';
import { CAPABILITY_CATEGORIES } from './capabilities.js';
import { PROCESS_FACT_REGISTRY } from './process-fact-registry.js';
import { isMaterialExcludedPath } from './material-path-policy.js';
import { signValidationArtifact, verifyValidationArtifact } from './validation-artifact-signing.js';
import { resolveRepositoryBaseline } from './git-baseline.js';
import { digestCanonicalJson } from './digest.js';
import {
  narrowPortableValidationCommandTuple,
  provisionalValidationCommandId,
} from './validation-command-portable-id.js';
import type {
  AutomaticValidationTierSelectionBinding,
  ValidationTier,
} from './validation-tier-planner.js';

export const STORY_CHANGE_MANIFEST_SCHEMA = 'proof-or-stop.story-change-manifest.v1' as const;
export const VALIDATION_CATALOG_SCHEMA = 'proof-or-stop.validation-catalog.v1' as const;
export const VALIDATION_RECEIPT_SCHEMA = 'proof-or-stop.validation-command-receipt.v2' as const;
export const VALIDATION_SHARD_RECEIPT_SCHEMA = 'proof-or-stop.validation-shard-receipt.v1' as const;
export const VALIDATION_SELECTION_SCHEMA = 'proof-or-stop.validation-selection.v1' as const;
export const VALIDATION_CLOSURE_SCHEMA = 'proof-or-stop.validation-closure-certificate.v1' as const;
export const DYNAMIC_MODES = ['off', 'observe', 'shadow', 'enforce-low-risk'] as const;
export type DynamicValidationMode = typeof DYNAMIC_MODES[number];
export type Assurance = 'always' | 'story-selectable' | 'full-only';
export type ClosurePolicy = 'static-and-traced' | 'whole-repository' | 'never-reuse';
export type RiskTier = 'local' | 'shared' | 'gate' | 'validation-infra';
export type FullBaselineReusePolicy = 'not-applicable' | 'exact-current-epoch-only' | 'forbidden';
export type DynamicDisposition = 'execute' | 'reuse' | 'excluded' | 'unverified';
const MAX_RECEIPT_AGE_MS = 24 * 60 * 60 * 1000;
const HEX64 = /^[0-9a-f]{64}$/i;

export interface ScopeContractData {
  allowedPaths?: string[];
  plannedFiles?: string[];
  protectedFiles?: string[];
  explicitExcludes?: string[];
  digest?: string;
}
export interface VerificationIntent {
  id?: string;
  commandId?: string;
  validationCommand?: string;
  validationCommands?: string[];
  pinnedValidationCommands?: string[];
}
export interface StoryChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  oldPath?: string;
  blobId?: string;
}
export interface StoryChangeResolverInput {
  storyId: string;
  gitCwd: string;
  baseHead: string;
  head: string;
  scopeContract?: ScopeContractData;
  verificationIntents?: VerificationIntent[];
  changedFiles?: StoryChangedFile[];
  affectedProcessFacts?: string[];
  affectedCapabilities?: string[];
}
export interface StoryChangeManifest {
  schema: typeof STORY_CHANGE_MANIFEST_SCHEMA;
  storyId: string;
  baseHead: string;
  head: string;
  changedFiles: StoryChangedFile[];
  plannedFiles: string[];
  pinnedValidationCommands: string[];
  affectedPackages: string[];
  affectedProcessFacts: string[];
  affectedCapabilities: string[];
  scopeViolations: Array<{ path: string; kind: 'outside-allowed-scope' | 'protected-file' | 'explicit-exclusion' }>;
  changeDigest: string;
  signature: string;
}

function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item))
    .join(',') + '}';
}
export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
export function stableDigest(value: unknown): string {
  return sha256(canonical(value));
}
function withoutSignature<T extends object>(value: T): Omit<T, 'signature'> {
  const copy = { ...value } as T & { signature?: unknown };
  delete copy.signature;
  return copy as Omit<T, 'signature'>;
}
export function signPayload(value: unknown): string {
  return signValidationArtifact(value);
}
export function verifyPayload(value: unknown, signature: unknown): boolean {
  return verifyValidationArtifact(value, signature);
}
function normalPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '');
}
function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].map(normalPath).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^$()|[\]\\{}]/g, '\\$&')
    .replace(/\*\*/g, '§§').replace(/\*/g, '[^/]*').replace(/§§/g, '.*').replace(/\?/g, '[^/]');
  return new RegExp('^' + escaped + '$');
}
function matchesPath(path: string, patterns: string[]): boolean {
  const normalized = normalPath(path);
  return patterns.some(pattern => {
    const p = normalPath(pattern);
    return p === normalized || normalized.startsWith(p + '/') || (p.endsWith('/') && normalized.startsWith(p)) || globToRegExp(p).test(normalized);
  });
}
function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).toString();
}
function objectIdsFromTree(raw: string, ref: string): Map<string, string> {
  const result = new Map<string, string>();
  try {
    for (const row of raw.split('\0')) {
      if (!row) continue;
      const tab = row.indexOf('\t');
      if (tab < 0) continue;
      const parts = row.slice(0, tab).trim().split(/\s+/);
      const path = row.slice(tab + 1);
      if (parts[2] && path) result.set(path, parts[2]);
    }
  } catch (error) {
    throw new Error(`story change manifest could not read tree ${ref}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return result;
}
export function resolveStoryMergeBase(gitCwd: string, head: string): string | undefined {
  return resolveRepositoryBaseline(gitCwd, head)?.mergeBase;
}

/** Shared changed-file resolver. Rename rows retain both old and new paths. */
export function resolveStoryChangedFiles(
  gitCwd: string,
  ref = 'HEAD',
  metadataRoot = gitCwd,
  explicitBaseHead?: string,
): StoryChangedFile[] {
  const base = explicitBaseHead?.trim() || resolveStoryMergeBase(gitCwd, ref);
  if (!base) {
    throw new Error(`story change manifest could not resolve a merge base for ${ref}`);
  }
  const raw = readStoryGitBytes(gitCwd, base, ref);
  const ids = objectIdsFromTree(raw.tree, ref);
  const out: StoryChangedFile[] = [];
  try {
    // NUL framing preserves Git path names, including Unicode, tabs and newlines.
    const fields = raw.diff.split('\0');
    if (fields.at(-1) === '') fields.pop();
    let cursor = 0;
    const nextPath = (): string => {
      const value = fields[cursor++];
      if (!value) throw new Error('missing path in NUL-delimited Git diff');
      return value;
    };
    const blobAt = (path: string): string => {
      const blob = ids.get(path);
      if (!blob) throw new Error(`missing target object for ${JSON.stringify(path)}`);
      return blob;
    };
    while (cursor < fields.length) {
      const code = fields[cursor++];
      if (!code || !/^(?:[ADMTUXB]|[RC][0-9]+)$/.test(code)) throw new Error('invalid Git diff status');
      const firstPath = nextPath();
      if (code.startsWith('R') || code.startsWith('C')) {
        const oldPath = firstPath;
        const path = nextPath();
        if (code.startsWith('R') && !isMaterialExcludedPath(oldPath, metadataRoot)) out.push({ path: oldPath, oldPath, status: 'renamed', blobId: '<deleted>' });
        if (!isMaterialExcludedPath(path, metadataRoot)) out.push({ path, oldPath, status: code.startsWith('R') ? 'renamed' : 'added', blobId: blobAt(path) });
      } else {
        const path = firstPath;
        if (isMaterialExcludedPath(path, metadataRoot)) continue;
        const status: StoryChangedFile['status'] = code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified';
        out.push({ path, status, blobId: status === 'deleted' ? '<deleted>' : blobAt(path) });
      }
    }
  } catch (error) {
    throw new Error(`story change manifest diff failed for ${base}..${ref}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return out.sort((a, b) => a.path.localeCompare(b.path) || (a.oldPath || '').localeCompare(b.oldPath || ''));
}
function pinnedCommands(intents: VerificationIntent[] = []): string[] {
  const out: string[] = [];
  for (const intent of intents) {
    if (intent.commandId) out.push(intent.commandId);
    if (intent.validationCommand) out.push(intent.validationCommand);
    out.push(...(intent.validationCommands || []), ...(intent.pinnedValidationCommands || []));
  }
  return uniqueSorted(out);
}
function changedPackage(path: string): string | undefined {
  const parts = normalPath(path).split('/');
  return parts[0] === 'packages' && parts[1] ? 'packages/' + parts[1] : undefined;
}
export function buildStoryChangeManifest(input: StoryChangeResolverInput): StoryChangeManifest {
  const changes = input.changedFiles || resolveStoryChangedFiles(input.gitCwd, input.head, input.gitCwd, input.baseHead);
  const scope = input.scopeContract || {};
  const plannedFiles = uniqueSorted([...(scope.plannedFiles || []), ...(scope.allowedPaths || [])]);
  const pins = pinnedCommands(input.verificationIntents);
  const scopeViolations: StoryChangeManifest['scopeViolations'] = [];
  for (const row of changes) {
    for (const path of [row.path, ...(row.oldPath ? [row.oldPath] : [])]) {
      if (scope.protectedFiles && matchesPath(path, scope.protectedFiles)) scopeViolations.push({ path, kind: 'protected-file' });
      if (scope.explicitExcludes && matchesPath(path, scope.explicitExcludes)) scopeViolations.push({ path, kind: 'explicit-exclusion' });
      if (scope.allowedPaths && scope.allowedPaths.length > 0 && !matchesPath(path, scope.allowedPaths)) scopeViolations.push({ path, kind: 'outside-allowed-scope' });
    }
  }
  const body = {
    schema: STORY_CHANGE_MANIFEST_SCHEMA,
    storyId: input.storyId, baseHead: input.baseHead, head: input.head,
    changedFiles: changes, plannedFiles, pinnedValidationCommands: pins,
    affectedPackages: uniqueSorted(changes.map(row => changedPackage(row.path)).filter((v): v is string => Boolean(v))),
    affectedProcessFacts: uniqueSorted(input.affectedProcessFacts || []),
    affectedCapabilities: uniqueSorted(input.affectedCapabilities || []),
    scopeViolations: scopeViolations.sort((a, b) => (a.path + a.kind).localeCompare(b.path + b.kind)),
  };
  const changeDigest = stableDigest({ ...body, scopeDigest: scope.digest || stableDigest(scope) });
  const manifest = { ...body, changeDigest, signature: '' } as StoryChangeManifest;
  manifest.signature = signPayload(withoutSignature(manifest));
  return manifest;
}
export function verifyStoryChangeManifest(manifest: StoryChangeManifest): boolean {
  return manifest.schema === STORY_CHANGE_MANIFEST_SCHEMA
    && Boolean(manifest.storyId) && HEX64.test(manifest.changeDigest)
    && Array.isArray(manifest.changedFiles)
    && verifyPayload(withoutSignature(manifest), manifest.signature)
    && manifest.changedFiles.every(row => row.path === normalPath(row.path) && (row.status !== 'deleted' || row.blobId === '<deleted>'));
}
export const resolveStoryChangeManifest = buildStoryChangeManifest;

export interface ValidationInventoryCommand {
  id: string; label: string; command: string; args: string[]; shell?: boolean; cwd?: string;
  env?: Record<string, string>; timeoutMs?: number; focus?: string[]; resources?: ResourceClaim[]; caseRegistryPath?: string; runnerSourcePath?: string; runnerSourceDigest?: string; declaredEnvironmentKeys?: string[]; inputRoots?: string[]; inputsComplete?: boolean;
  assurance?: Assurance; riskTier?: RiskTier; closurePolicy?: ClosurePolicy; fullBaselineReusePolicy?: FullBaselineReusePolicy; cpuWeight?: number; expectedP50Ms?: number; originalIndex: number;
}
export interface ValidationCatalogEntry {
  schema?: typeof VALIDATION_CATALOG_SCHEMA;
  id: string; label: string; command: string; args: string[]; shell?: boolean; cwd?: string;
  env?: Record<string, string>; timeoutMs?: number; focus?: string[]; resources: ResourceClaim[]; caseRegistryPath?: string; runnerSourcePath?: string; runnerSourceDigest?: string; declaredEnvironmentKeys?: string[];
  policySource: 'explicit' | 'default';
  originalIndex: number;
  triggerExtensions: { files?: string[]; symbols?: string[]; processFacts?: string[]; capabilities?: string[]; packages?: string[] };
  inputRoots: string[]; closurePolicy: ClosurePolicy; assurance: Assurance; riskTier: RiskTier;
  /** Selector-only roots and proof grade. Runtime closure keeps using inputRoots. */
  selectionInputRoots: string[];
  selectionInputCoverage: 'complete' | 'partial';
  selectionInputCoverageSource: 'declared' | 'dual-revision-graph' | 'heuristic';
  fullBaselineReusePolicy: FullBaselineReusePolicy; cpuWeight: number; expectedP50Ms?: number;
}
export interface ValidationInventory {
  schema: 'proof-or-stop.validation-inventory.v1';
  commands: ValidationInventoryCommand[]; digest: string; source: 'proof-or-stop.config.json' | 'injected';
}
function commandId(row: { command: string; args: string[]; label?: string; cwd?: string; shell?: boolean }, _index: number): string {
  // One portable command identity is shared by validation_plan and the runtime
  // executor. Labels and array positions are presentation/provenance only.
  return provisionalValidationCommandId(narrowPortableValidationCommandTuple({
    command: { label: row.label ?? row.command, command: row.command, args: row.args, cwd: row.cwd, shell: row.shell },
  }));
}
export function discoverValidationInventory(projectRoot: string, injected?: ValidationInventoryCommand[]): ValidationInventory {
  let commands: ValidationInventoryCommand[] = injected ? injected.map((row, index) => ({ ...row, originalIndex: row.originalIndex ?? index })) : [];
  // B-45a0 F-443: resolve ONCE and reuse for both the read and the reported
  // `source`. Calling pickProjectConfigPath twice duplicated an existsSync +
  // readFileSync pair and opened a narrow TOCTOU window where `source` could
  // name a different file than `raw` was actually read from.
  const picked = injected ? null : pickProjectConfigPath(projectRoot);
  if (!injected) {
    // Reuse the canonical resolver instead of duplicating its lookup here.
    const raw = picked ? JSON.parse(readFileSync(picked.path, 'utf8')) as Record<string, unknown> : {};
    const validation = ((raw.validate || raw.validation) as Record<string, unknown> | undefined) || {};
    const dynamic = validation.dynamic && typeof validation.dynamic === 'object' ? validation.dynamic as Record<string, unknown> : {};
    const policyDefaults = dynamic.policyDefaults && typeof dynamic.policyDefaults === 'object'
      ? dynamic.policyDefaults as Record<string, unknown>
      : {};
    const rows: unknown[] = Array.isArray(validation.commands) ? validation.commands : typeof validation.command === 'string' ? [validation.command] : [];
    commands = rows.flatMap((rawRow: unknown, index: number): ValidationInventoryCommand[] => {
      if (typeof rawRow === 'string') {
        const parts = rawRow.trim().split(/\s+/);
        return parts[0] ? [{
          id: commandId({ command: parts[0], args: parts.slice(1), label: parts[0] }, index),
          label: parts[0], command: parts[0], args: parts.slice(1),
          ...(typeof policyDefaults.assurance === 'string' ? { assurance: policyDefaults.assurance as Assurance } : {}),
          ...(typeof policyDefaults.riskTier === 'string' ? { riskTier: policyDefaults.riskTier as RiskTier } : {}),
          ...(typeof policyDefaults.closurePolicy === 'string' ? { closurePolicy: policyDefaults.closurePolicy as ClosurePolicy } : {}),
          ...(typeof policyDefaults.fullBaselineReusePolicy === 'string' ? { fullBaselineReusePolicy: policyDefaults.fullBaselineReusePolicy as FullBaselineReusePolicy } : {}),
          ...(typeof policyDefaults.cpuWeight === 'number' ? { cpuWeight: policyDefaults.cpuWeight } : {}),
          originalIndex: index,
        }] : [];
      }
      if (!rawRow || typeof rawRow !== 'object') return [];
      const value = rawRow as Record<string, unknown>;
      if (typeof value.command !== 'string') return [];
      const args = Array.isArray(value.args) ? value.args.filter((v): v is string => typeof v === 'string') : [];
      const label = typeof value.label === 'string' ? value.label : value.command + '-' + (index + 1);
      const resources = Array.isArray(value.resources) ? value.resources as ResourceClaim[] : [];
      const env = value.env && typeof value.env === 'object' && !Array.isArray(value.env)
        ? Object.fromEntries(Object.entries(value.env as Record<string, unknown>).filter(([, item]) => typeof item === 'string')) as Record<string, string>
        : undefined;
      const declaredEnvironmentKeys = Array.isArray(value.declaredEnvironmentKeys)
        ? value.declaredEnvironmentKeys.filter((item): item is string => typeof item === 'string')
        : undefined;
      const inputRoots = Array.isArray(value.inputRoots)
        ? value.inputRoots.filter((item): item is string => typeof item === 'string')
        : undefined;
      const shell = typeof value.shell === 'boolean' ? value.shell : undefined;
      const cwd = typeof value.cwd === 'string' ? value.cwd : undefined;
      return [{ id: typeof value.id === 'string' ? value.id : commandId({ command: value.command, args, label, cwd, shell }, index), label, command: value.command, args, ...(shell !== undefined ? { shell } : {}), ...(cwd !== undefined ? { cwd } : {}), ...(env ? { env } : {}), ...(typeof value.timeoutMs === 'number' ? { timeoutMs: value.timeoutMs } : {}), ...(typeof value.caseRegistryPath === 'string' ? { caseRegistryPath: value.caseRegistryPath } : {}), ...(typeof value.runnerSourcePath === 'string' ? { runnerSourcePath: value.runnerSourcePath } : {}), ...(declaredEnvironmentKeys ? { declaredEnvironmentKeys } : {}), ...(inputRoots ? { inputRoots } : {}), ...(typeof value.inputsComplete === 'boolean' ? { inputsComplete: value.inputsComplete } : {}), ...(typeof value.assurance === 'string' ? { assurance: value.assurance as Assurance } : typeof policyDefaults.assurance === 'string' ? { assurance: policyDefaults.assurance as Assurance } : {}), ...(typeof value.riskTier === 'string' ? { riskTier: value.riskTier as RiskTier } : typeof policyDefaults.riskTier === 'string' ? { riskTier: policyDefaults.riskTier as RiskTier } : {}), ...(typeof value.closurePolicy === 'string' ? { closurePolicy: value.closurePolicy as ClosurePolicy } : typeof policyDefaults.closurePolicy === 'string' ? { closurePolicy: policyDefaults.closurePolicy as ClosurePolicy } : {}), ...(typeof value.fullBaselineReusePolicy === 'string' ? { fullBaselineReusePolicy: value.fullBaselineReusePolicy as FullBaselineReusePolicy } : typeof policyDefaults.fullBaselineReusePolicy === 'string' ? { fullBaselineReusePolicy: policyDefaults.fullBaselineReusePolicy as FullBaselineReusePolicy } : {}), ...(typeof value.cpuWeight === 'number' ? { cpuWeight: value.cpuWeight } : typeof policyDefaults.cpuWeight === 'number' ? { cpuWeight: policyDefaults.cpuWeight } : {}), ...(typeof value.expectedP50Ms === 'number' ? { expectedP50Ms: value.expectedP50Ms } : typeof policyDefaults.expectedP50Ms === 'number' ? { expectedP50Ms: policyDefaults.expectedP50Ms } : {}), resources, originalIndex: index }];
    });
  }
  const normalized = commands.map((row, index) => ({
    ...row,
    ...(row.runnerSourcePath && existsSync(resolve(projectRoot, row.runnerSourcePath))
      ? { runnerSourceDigest: sha256(readFileSync(resolve(projectRoot, row.runnerSourcePath))) }
      : {}),
    id: row.id || commandId(row, index),
    originalIndex: row.originalIndex ?? index,
  }));
  // The source reports the canonical filename without repeating the filesystem
  // probe; injected inventories remain explicitly identified.
  const source = injected
    ? 'injected' as const
    : PROOF_OR_STOP_CONFIG_FILENAME;
  return { schema: 'proof-or-stop.validation-inventory.v1', commands: normalized, digest: stableDigest(normalized), source };
}
function validRelativePath(path: string): boolean {
  const value = normalPath(path);
  return Boolean(value) && !value.startsWith('/') && value !== '..' && !value.startsWith('../') && !value.includes('\0');
}
export interface CatalogValidationResult { ok: boolean; errors: string[]; warnings: string[]; }
function claimValid(claim: ResourceClaim): boolean {
  return Boolean(claim && typeof claim === 'object' && typeof claim.class === 'string' && typeof claim.key === 'string' && claim.key.length > 0 && (claim.access === 'shared' || claim.access === 'exclusive'));
}
export function validateValidationCatalog(inventory: ValidationInventory | ValidationInventoryCommand[], catalog: ValidationCatalogEntry[], knownProcessFacts: Iterable<string> = [], knownCapabilities: Iterable<string> = []): CatalogValidationResult {
  const rows = Array.isArray(inventory) ? inventory : inventory.commands;
  const errors: string[] = []; const warnings: string[] = [];
  const inventoryIds = rows.map(row => row.id); const catalogIds = catalog.map(row => row.id);
  for (const id of new Set(inventoryIds.filter((id, i) => inventoryIds.indexOf(id) !== i))) errors.push('duplicate inventory ID: ' + id);
  for (const id of new Set(catalogIds.filter((id, i) => catalogIds.indexOf(id) !== i))) errors.push('duplicate catalog ID: ' + id);
  for (const id of inventoryIds) if (!catalogIds.includes(id)) errors.push('inventory command absent from catalog: ' + id);
  for (const id of catalogIds) if (!inventoryIds.includes(id)) errors.push('catalog command absent from inventory: ' + id);
  const facts = new Set([...knownProcessFacts]);
  if (facts.size === 0) for (const entry of PROCESS_FACT_REGISTRY) facts.add(entry.name);
  const capabilities = new Set([...knownCapabilities]);
  if (capabilities.size === 0) for (const capability of CAPABILITY_CATEGORIES) capabilities.add(capability);
  for (const entry of catalog) {
    if (entry.schema !== VALIDATION_CATALOG_SCHEMA) errors.push('catalog schema mismatch: ' + (entry.id || '<missing>'));
    if (!entry.id || !entry.command || !Array.isArray(entry.args)) errors.push('malformed catalog entry: ' + (entry.id || '<missing>'));
    const trigger = entry.triggerExtensions;
    if (!trigger || typeof trigger !== 'object' || Object.values(trigger).some(value => value !== undefined && !Array.isArray(value))) errors.push('malformed trigger extensions: ' + entry.id);
    const roots = Array.isArray(entry.inputRoots) ? entry.inputRoots : [];
    const triggerFiles = Array.isArray(trigger?.files) ? trigger.files : [];
    if (roots.length === 0 || roots.some(path => !validRelativePath(path) || path.startsWith('packages/main/dist/') || path.startsWith('dist/')))
      errors.push('invalid or dist-only inputRoots: ' + entry.id);
    if (entry.runnerSourcePath && (!validRelativePath(entry.runnerSourcePath) || !entry.runnerSourceDigest))
      errors.push('runner source digest missing or path invalid: ' + entry.id);
    if (triggerFiles.some(path => !validRelativePath(path) || path.startsWith('packages/main/dist/') || path.startsWith('dist/')))
      errors.push('invalid or dist-only trigger files: ' + entry.id);
    if (!['static-and-traced', 'whole-repository', 'never-reuse'].includes(entry.closurePolicy)) errors.push('invalid closurePolicy: ' + entry.id);
    if (!['always', 'story-selectable', 'full-only'].includes(entry.assurance)) errors.push('invalid assurance: ' + entry.id);
    if ((entry.assurance === 'always' || entry.assurance === 'story-selectable') && entry.fullBaselineReusePolicy !== 'not-applicable') errors.push('non-full command has baseline reuse policy: ' + entry.id);
    if (entry.assurance === 'full-only' && !['exact-current-epoch-only', 'forbidden'].includes(entry.fullBaselineReusePolicy)) errors.push('full-only policy invalid: ' + entry.id);
    if (!Number.isFinite(entry.cpuWeight) || entry.cpuWeight < 1 || entry.cpuWeight > 1024) errors.push('invalid cpuWeight: ' + entry.id);
    if (entry.expectedP50Ms !== undefined && (!Number.isFinite(entry.expectedP50Ms) || entry.expectedP50Ms < 1 || entry.expectedP50Ms > 86_400_000)) errors.push('invalid expectedP50Ms: ' + entry.id);
    if (!Array.isArray(entry.resources) || entry.resources.some(claim => !claimValid(claim))) errors.push('malformed resources: ' + entry.id);
    else {
      try { validateResourceClaims(entry.resources, entry.id); } catch (error) { errors.push(error instanceof Error ? error.message : 'invalid resources: ' + entry.id); }
    }
    for (const fact of trigger?.processFacts || []) if (facts.size > 0 && !facts.has(fact)) errors.push('unknown process fact ' + fact + ': ' + entry.id);
    for (const capability of trigger?.capabilities || []) if (capabilities.size > 0 && !capabilities.has(capability)) errors.push('unknown capability ' + capability + ': ' + entry.id);
    if (entry.closurePolicy !== 'never-reuse' && roots.length === 0 && !triggerFiles.length) warnings.push('no source closure roots: ' + entry.id);
  }
  return { ok: errors.length === 0, errors, warnings };
}
export function assertValidValidationCatalog(inventory: ValidationInventory | ValidationInventoryCommand[], catalog: ValidationCatalogEntry[], knownProcessFacts: Iterable<string> = [], knownCapabilities: Iterable<string> = []): void {
  const result = validateValidationCatalog(inventory, catalog, knownProcessFacts, knownCapabilities);
  if (!result.ok) throw new Error('validation catalog rejected: ' + result.errors.join('; '));
}
export const validateCatalog = validateValidationCatalog;
export function compileValidationCatalog(inventory: ValidationInventory, options: Partial<Pick<ValidationCatalogEntry, 'assurance' | 'riskTier' | 'closurePolicy' | 'fullBaselineReusePolicy' | 'cpuWeight' | 'expectedP50Ms'>> & { inputRoots?: string[] } = {}): ValidationCatalogEntry[] {
  return inventory.commands.map(row => {
    const heuristicRoots = [sourceRootForCommand(row), ...(row.caseRegistryPath ? [row.caseRegistryPath] : []), ...(row.runnerSourcePath ? [row.runnerSourcePath] : [])];
    const declaredRoots = row.inputRoots ?? options.inputRoots;
    const inputRoots = declaredRoots ?? heuristicRoots;
    // A caller-wide root override is useful for runtime closure fixtures, but
    // it is not per-command ownership proof. Only the command's own explicit
    // inputsComplete + inputRoots declaration may authorize selector omission.
    const declaredComplete = row.inputsComplete === true && row.inputRoots !== undefined;
    return ({
    ...row, schema: VALIDATION_CATALOG_SCHEMA,
    inputRoots,
    selectionInputRoots: inputRoots,
    selectionInputCoverage: declaredComplete ? 'complete' : 'partial',
    selectionInputCoverageSource: declaredComplete ? 'declared' : 'heuristic',
    triggerExtensions: { files: inputRoots },
    closurePolicy: options.closurePolicy || row.closurePolicy || 'static-and-traced', assurance: options.assurance || row.assurance || 'story-selectable',
    riskTier: options.riskTier || row.riskTier || 'local', fullBaselineReusePolicy: options.fullBaselineReusePolicy || row.fullBaselineReusePolicy || 'not-applicable',
    policySource: options.assurance || options.riskTier || options.closurePolicy || options.fullBaselineReusePolicy || row.assurance || row.riskTier || row.closurePolicy || row.fullBaselineReusePolicy ? 'explicit' : 'default',
    resources: Array.isArray(row.resources) ? row.resources : [], cpuWeight: options.cpuWeight || row.cpuWeight || 1,
    ...(options.expectedP50Ms === undefined ? {} : { expectedP50Ms: options.expectedP50Ms }),
  }); }) as ValidationCatalogEntry[];
}

function sourceRootForCommand(row: ValidationInventoryCommand): string {
  const target = row.args.find(arg => /\.(?:m?js|ts|mts|json)$/.test(arg));
  if (!target) return 'packages/main/src';
  const normalized = normalPath(target);
  if (normalized.startsWith('packages/main/dist/')) {
    const source = normalized.replace(/^packages\/main\/dist\//, 'packages/main/src/');
    return source.replace(/\.(?:m?js|mts)$/, '.ts');
  }
  if (normalized.startsWith('dist/')) return normalized.replace(/^dist\//, 'packages/main/src/').replace(/\.(?:m?js|mts)$/, '.ts');
  return normalized;
}

export interface ValidationRuntimeTrace {
  readPaths?: string[]; loadedPaths?: string[]; spawnedPaths?: string[]; registryKeys?: string[]; environmentKeys?: string[];
  command?: string; argv?: string[]; cwd?: string; startedAt?: string; endedAt?: string; exitCode?: number; events?: string[];
  unknownRuntimeInputs?: string[];
}
export interface ValidationClosureCertificate {
  schema: typeof VALIDATION_CLOSURE_SCHEMA; commandId: string; baseHead: string; inventoryDigest: string; catalogDigest: string;
  staticClosureDigest: string; runtimeTraceDigest: string; processFactBindingDigest: string; capabilityBindingDigest: string;
  certifiedPathsDigest: string; undeclaredObservedPaths: string[]; environmentAccessDigest: string;
  undeclaredObservedEnvironmentKeys: string[]; producedBy: 'canonical-full-baseline-compiler' | 'story-closure-preview';
  status: 'complete' | 'unverified'; certifiedPaths: string[]; signature: string;
}
export function createValidationClosureCertificate(args: {
  commandId: string; baseHead: string; inventoryDigest: string; catalogDigest: string; staticPaths: string[];
  runtimeTrace?: ValidationRuntimeTrace; processFacts?: string[]; capabilities?: string[]; declaredEnvironmentKeys?: string[];
  producedBy?: ValidationClosureCertificate['producedBy']; explicitBindings?: string[];
}): ValidationClosureCertificate {
  const trace = args.runtimeTrace || {};
  const paths = uniqueSorted([...(args.staticPaths || []), ...(args.explicitBindings || [])]);
  const observed = uniqueSorted([...(trace.readPaths || []), ...(trace.loadedPaths || []), ...(trace.spawnedPaths || [])]);
  const undeclaredObservedPaths = observed.filter(path => !paths.includes(path));
  const env = uniqueSorted(trace.environmentKeys || []); const declared = new Set(uniqueSorted(args.declaredEnvironmentKeys || []));
  const undeclaredObservedEnvironmentKeys = env.filter(key => !declared.has(key));
  const status: ValidationClosureCertificate['status'] = undeclaredObservedPaths.length
    || undeclaredObservedEnvironmentKeys.length
    || (trace.unknownRuntimeInputs || []).length > 0
    ? 'unverified' : 'complete';
  const body = {
    schema: VALIDATION_CLOSURE_SCHEMA, commandId: args.commandId, baseHead: args.baseHead,
    inventoryDigest: args.inventoryDigest, catalogDigest: args.catalogDigest,
    staticClosureDigest: stableDigest(uniqueSorted(args.staticPaths || [])), runtimeTraceDigest: stableDigest(trace),
    processFactBindingDigest: stableDigest(uniqueSorted(args.processFacts || [])), capabilityBindingDigest: stableDigest(uniqueSorted(args.capabilities || [])),
    certifiedPathsDigest: stableDigest(paths), undeclaredObservedPaths, environmentAccessDigest: stableDigest(env),
    undeclaredObservedEnvironmentKeys, producedBy: args.producedBy || 'story-closure-preview', status, certifiedPaths: paths,
  };
  return { ...body, signature: signPayload(body) };
}
export function verifyValidationClosureCertificate(cert: ValidationClosureCertificate): boolean {
  return cert.schema === VALIDATION_CLOSURE_SCHEMA && cert.status === 'complete'
    && cert.undeclaredObservedPaths.length === 0 && cert.undeclaredObservedEnvironmentKeys.length === 0
    && cert.certifiedPathsDigest === stableDigest(cert.certifiedPaths)
    && verifyPayload(withoutSignature(cert), cert.signature);
}
export const createClosureCertificate = createValidationClosureCertificate;
export const verifyClosureCertificate = verifyValidationClosureCertificate;

/** Canonical full-plan evidence which supplies runtime closure traces for reuse. */
export const VALIDATION_BASELINE_SCHEMA = 'proof-or-stop.validation-canonical-full-baseline.v1' as const;
export interface CanonicalFullBaseline {
  schema: typeof VALIDATION_BASELINE_SCHEMA;
  epochId: string;
  sourceHead: string;
  inventoryDigest: string;
  catalogDigest: string;
  toolchainDigest: string;
  runnerDigest: string;
  buildProofDigest: string;
  allPass: true;
  createdAt: string;
  expiresAt: string;
  traces: Record<string, ValidationRuntimeTrace>;
  closureCertificates: Record<string, ValidationClosureCertificate>;
  signature: string;
}
export function createCanonicalFullBaseline(args: Omit<CanonicalFullBaseline, 'schema' | 'signature' | 'expiresAt'> & { expiresAt?: string }): CanonicalFullBaseline {
  const createdAt = args.createdAt || new Date().toISOString();
  const requestedExpiry = args.expiresAt ? Date.parse(args.expiresAt) : Date.parse(createdAt) + MAX_RECEIPT_AGE_MS;
  const expiresAt = new Date(Math.min(requestedExpiry, Date.parse(createdAt) + MAX_RECEIPT_AGE_MS)).toISOString();
  const body = { ...args, schema: VALIDATION_BASELINE_SCHEMA, createdAt, expiresAt };
  return { ...body, signature: signPayload(body) } as CanonicalFullBaseline;
}
export function verifyCanonicalFullBaseline(baseline: CanonicalFullBaseline, now = Date.now()): boolean {
  const created = Date.parse(baseline.createdAt); const expires = Date.parse(baseline.expiresAt);
  return baseline.schema === VALIDATION_BASELINE_SCHEMA
    && baseline.allPass === true
    && Number.isFinite(created) && Number.isFinite(expires) && expires > created && now < expires
    && baseline.inventoryDigest.length > 0 && baseline.catalogDigest.length > 0
    && Object.values(baseline.closureCertificates).every(verifyValidationClosureCertificate)
    && verifyPayload(withoutSignature(baseline), baseline.signature);
}

interface GraphData {
  paths: Set<string>;
  imports: Map<string, Set<string>>;
  authority: ReturnType<typeof authorityRevisionClosure>;
  resolutionFailures: string[];
}
const graphTreeCache = new Map<string, Map<string, string>>();
function parseImports(source: string): string[] {
  const output: string[] = [];
  const patterns = [
    /(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) if (match[1]) output.push(match[1]);
  return output;
}
function buildGraphAtRef(gitCwd: string, ref: string): GraphData {
  const paths = new Set<string>(); const imports = new Map<string, Set<string>>();
  const resolutionFailures: string[] = [];
  let authority = authorityRevisionClosure(undefined);
  try {
    const cacheKey = `${gitCwd}\0${ref}`;
    let tree = graphTreeCache.get(cacheKey);
    if (!tree) {
      const listing = execFileSync('git', ['ls-tree', '-r', '-z', '--format=%(objectname) %(path)', ref], { cwd: gitCwd, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
      const rows = listing.split('\0').filter(Boolean).map(row => {
        const separator = row.indexOf(' ');
        return separator > 0 ? { oid: row.slice(0, separator), path: normalPath(row.slice(separator + 1)) } : undefined;
      }).filter((row): row is { oid: string; path: string } => Boolean(row))
        .filter(row => /\.(?:c?js|mjs|tsx?|jsx?|json)$/.test(row.path));
      tree = new Map<string, string>();
      if (rows.length) {
        const batchInput = Buffer.from(rows.map(row => `${row.oid}\n`).join(''));
        // A repository-wide dual graph can legitimately exceed the default
        // child-process buffer (the current tree is ~348 MiB of source blobs).
        // Keep the batch read bounded but above the documented production
        // corpus; truncation must never silently become an empty graph.
        const batchOutput = execFileSync('git', ['cat-file', '--batch'], { cwd: gitCwd, input: batchInput, maxBuffer: 1024 * 1024 * 1024 });
        let offset = 0;
        for (const row of rows) {
          const headerEnd = batchOutput.indexOf(0x0a, offset);
          if (headerEnd < 0) throw new Error('incomplete graph batch header');
          const header = batchOutput.subarray(offset, headerEnd).toString('utf8').split(' ');
          const size = Number(header[2]);
          const bodyStart = headerEnd + 1;
          if (header[1] === 'blob' && Number.isFinite(size) && size >= 0 && bodyStart + size <= batchOutput.length) tree.set(row.path, batchOutput.subarray(bodyStart, bodyStart + size).toString('utf8'));
          if (!tree.has(row.path)) throw new Error('incomplete graph blob');
          offset = bodyStart + Math.max(0, size) + 1;
        }
      }
      graphTreeCache.set(cacheKey, tree);
    }
    authority = authorityRevisionClosure(tree);
    const allPaths = [...tree.keys()];
    for (const path of allPaths) paths.add(path);
    for (const path of allPaths) {
      const deps = new Set<string>();
      for (const specifier of parseImports(tree.get(path) || '')) {
        if (specifier.startsWith('.')) {
          const base = normalPath(posix.normalize(posix.join(posix.dirname(path), specifier)));
          // TypeScript/ESM source commonly imports the emitted `.js` name
          // while the revision graph is built from `.ts` source. Resolve both
          // the literal specifier and its extension-stripped source forms so
          // reverse dependencies are not silently lost across transpilation.
          const sourceBase = base.replace(/\.(?:c|m)?js$/, '');
          const candidates = [
            base, base + '.ts', base + '.tsx', base + '.js', base + '.mjs', base + '/index.ts', base + '/index.js',
            sourceBase, sourceBase + '.ts', sourceBase + '.tsx', sourceBase + '.js', sourceBase + '.mjs', sourceBase + '/index.ts', sourceBase + '/index.js',
          ];
          const resolved = candidates.find(candidate => paths.has(candidate));
          if (resolved) deps.add(resolved);
          else resolutionFailures.push(`unresolved-relative-import:${path}:${specifier}`);
        } else if (specifier.startsWith('packages/')) {
          const normalized = normalPath(specifier);
          if (paths.has(normalized)) deps.add(normalized);
          else resolutionFailures.push(`unresolved-package-import:${path}:${specifier}`);
        }
      }
      imports.set(path, deps);
    }
  } catch (error) {
    resolutionFailures.push(`graph-build-failed:${error instanceof Error ? error.message : String(error)}`);
  }
  return { paths, imports, authority, resolutionFailures: uniqueSorted(resolutionFailures) };
}
export interface DualRevisionImpactGraph {
  baseHead: string;
  head: string;
  baseGraphDigest: string;
  headGraphDigest: string;
  commandsAffectedBy(change: StoryChangedFile): string[];
  graphUnknown: boolean;
  resolutionFailures?: string[];
  authorityReasons(change: StoryChangedFile): string[];
}
export function buildDualRevisionImpactGraph(args: { gitCwd: string; baseHead: string; head: string; catalog?: ValidationCatalogEntry[] }): DualRevisionImpactGraph {
  const base = buildGraphAtRef(args.gitCwd, args.baseHead); const head = buildGraphAtRef(args.gitCwd, args.head);
  const digest = (graph: GraphData) => stableDigest({ authorityPolicy: 'registered-authority-closure.v1', authorityRoots: validationAuthoritySources(), authorityMembers: uniqueSorted(graph.authority.members), authorityUnknown: graph.authority.unknown, resolutionFailures: graph.resolutionFailures, paths: uniqueSorted(graph.paths), imports: [...graph.imports.entries()].map(row => [row[0], uniqueSorted(row[1])]) });
  const roots = new Map((args.catalog || []).map(entry => [entry.id, uniqueSorted([...(entry.inputRoots || []), ...(entry.triggerExtensions.files || [])])]));
  const affected = (graph: GraphData, change: StoryChangedFile): string[] => {
    const targets = new Set([normalPath(change.path), ...(change.oldPath ? [normalPath(change.oldPath)] : [])]);
    const reverse = new Map<string, Set<string>>();
    for (const [from, deps] of graph.imports) for (const dep of deps) {
      const set = reverse.get(dep) || new Set<string>(); set.add(from); reverse.set(dep, set);
    }
    const impacted = new Set(targets); const queue = [...targets];
    while (queue.length) {
      const current = queue.shift()!;
      for (const dependent of reverse.get(current) || []) if (!impacted.has(dependent)) { impacted.add(dependent); queue.push(dependent); }
    }
    return [...roots.entries()].filter(([, values]) => values.some(root => impacted.has(root) || [...impacted].some(path => path.startsWith(root + '/')))).map(row => row[0]);
  };
  return {
    baseHead: args.baseHead, head: args.head, baseGraphDigest: digest(base), headGraphDigest: digest(head),
    graphUnknown: base.paths.size === 0 || head.paths.size === 0
      || base.resolutionFailures.length > 0 || head.resolutionFailures.length > 0,
    resolutionFailures: uniqueSorted([...base.resolutionFailures, ...head.resolutionFailures]),
    authorityReasons: change => uniqueSorted([...base.authority.unknown, ...head.authority.unknown,
      ...[change.path, change.oldPath].filter((path): path is string => Boolean(path))
        .filter(path => base.authority.members.has(normalPath(path)) || head.authority.members.has(normalPath(path)))
        .map(path => 'authority-source-changed:' + path)]),
    commandsAffectedBy: change => uniqueSorted([...affected(base, change), ...affected(head, change)]),
  };
}

/** Add graph-proven Story paths that can reach each command to its selector inputs. */
export function augmentValidationCatalogWithGraphInputs(args: {
  catalog: ValidationCatalogEntry[];
  graph?: DualRevisionImpactGraph;
  changedFiles: StoryChangedFile[];
}): ValidationCatalogEntry[] {
  if (!args.graph || args.graph.graphUnknown) return args.catalog;
  return args.catalog.map((entry) => {
    const graphInputs = args.changedFiles.flatMap((change) => args.graph!.commandsAffectedBy(change).includes(entry.id)
        ? [change.path, ...(change.oldPath ? [change.oldPath] : [])]
        : []);
    const priorInputs = entry.selectionInputRoots || [];
    return {
      ...entry,
      selectionInputRoots: uniqueSorted([...priorInputs, ...graphInputs]),
      // A regex/static reverse graph can prove a positive affected edge, but
      // it cannot prove that subprocess, generated, fixture, or non-code
      // inputs do not exist. Never upgrade a partial row to complete here.
      selectionInputCoverage: entry.selectionInputCoverage,
      selectionInputCoverageSource: entry.selectionInputCoverageSource === 'declared'
        ? 'declared'
        : graphInputs.length > 0 ? 'dual-revision-graph' : entry.selectionInputCoverageSource,
    };
  });
}

export interface ValidationCommandReceipt {
  schema: typeof VALIDATION_RECEIPT_SCHEMA; id: string; commandId: string;
  commandIdentityDigest: string; inputDigest: string; closureCertificateDigest: string; catalogDigest: string;
  inventoryDigest: string; runnerDigest: string; toolchainDigest: string; buildProofDigest: string;
  sourceHead: string; sourceBaseHead: string; canonicalBaselineEpochId: string;
  producedBy: 'canonical-full-baseline' | 'story-execution'; cleanTreeDigest: string;
  executionEnvironmentDigest: string; result: 'PASS' | 'FAIL' | 'TIMEOUT'; exitCode: number;
  outputDigest: string; durationMs: number; createdAt: string; expiresAt: string;
  revocationLedgerDigest: string; signature: string;
}
export interface ReceiptRevocationLedger {
  schema: 'proof-or-stop.validation-revocation-ledger.v1';
  revokedReceiptIds: string[]; revokedEpochs?: string[]; digest: string; signature: string;
}
export function createValidationCommandReceipt(args: Omit<ValidationCommandReceipt, 'schema' | 'signature' | 'expiresAt'> & { expiresAt?: string; now?: string }): ValidationCommandReceipt {
  const createdAt = args.createdAt || args.now || new Date().toISOString();
  const createdMs = Date.parse(createdAt);
  const requested = args.expiresAt ? Date.parse(args.expiresAt) : createdMs + MAX_RECEIPT_AGE_MS;
  const expiresAt = new Date(Math.min(requested, createdMs + MAX_RECEIPT_AGE_MS)).toISOString();
  const body = { ...args, createdAt, expiresAt, schema: VALIDATION_RECEIPT_SCHEMA };
  return { ...body, signature: signPayload(body) } as ValidationCommandReceipt;
}
export function verifyValidationCommandReceipt(receipt: ValidationCommandReceipt, now = Date.now()): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (receipt.schema !== VALIDATION_RECEIPT_SCHEMA) reasons.push('schema-mismatch');
  if (receipt.result !== 'PASS' || receipt.exitCode !== 0) reasons.push('result-not-pass');
  if (!verifyPayload(withoutSignature(receipt), receipt.signature)) reasons.push('signature-invalid');
  const created = Date.parse(receipt.createdAt); const expiry = Date.parse(receipt.expiresAt);
  if (!Number.isFinite(created) || !Number.isFinite(expiry) || expiry <= created || expiry - created > MAX_RECEIPT_AGE_MS) reasons.push('expiry-policy-invalid');
  if (!Number.isFinite(expiry) || now >= expiry) reasons.push('expired');
  if (!receipt.inputDigest || !receipt.buildProofDigest || !receipt.cleanTreeDigest) reasons.push('missing-source-first-proof');
  return { ok: reasons.length === 0, reasons };
}
export const verifyReceipt = verifyValidationCommandReceipt;
export const createReceipt = createValidationCommandReceipt;
export function buildRevocationLedger(revokedReceiptIds: string[], revokedEpochs: string[] = []): ReceiptRevocationLedger {
  const body = { schema: 'proof-or-stop.validation-revocation-ledger.v1' as const, revokedReceiptIds: uniqueSorted(revokedReceiptIds), revokedEpochs: uniqueSorted(revokedEpochs) };
  const digest = stableDigest(body);
  return { ...body, digest, signature: signPayload({ ...body, digest }) };
}
export function verifyRevocationLedger(ledger: ReceiptRevocationLedger): boolean {
  const body = { schema: ledger.schema, revokedReceiptIds: uniqueSorted(ledger.revokedReceiptIds), revokedEpochs: uniqueSorted(ledger.revokedEpochs || []) };
  return ledger.schema === 'proof-or-stop.validation-revocation-ledger.v1'
    && ledger.digest === stableDigest(body)
    && verifyPayload({ ...body, digest: ledger.digest }, ledger.signature);
}
export function appendReceiptRevocation(ledger: ReceiptRevocationLedger, receiptIds: string[], epochs: string[] = []): ReceiptRevocationLedger {
  if (!verifyRevocationLedger(ledger)) throw new Error('cannot append to invalid revocation ledger');
  return buildRevocationLedger([...ledger.revokedReceiptIds, ...receiptIds], [...(ledger.revokedEpochs || []), ...epochs]);
}
export function isReceiptRevoked(receipt: ValidationCommandReceipt, ledger?: ReceiptRevocationLedger): boolean {
  return Boolean(ledger && (ledger.revokedReceiptIds.includes(receipt.id) || (ledger.revokedEpochs || []).includes(receipt.canonicalBaselineEpochId)));
}
export function computeValidationInputDigest(args: {
  command: ValidationInventoryCommand | ValidationCatalogEntry;
  certifiedPaths: Array<{ path: string; blobId?: string }>;
  commandIdentityDigest?: string; environmentDigest?: string; runnerDigest?: string; catalogDigest?: string;
  graphDigest?: string; closureCertificateDigest?: string; baselineEpoch?: string; toolchainDigest?: string; buildProofDigest?: string;
}): string {
  const paths = args.certifiedPaths.map(row => normalPath(row.path) + '\0' + (row.blobId || '<deleted>')).sort();
  return stableDigest({
    paths, command: args.command, commandIdentityDigest: args.commandIdentityDigest || stableDigest(args.command),
    environmentDigest: args.environmentDigest || '', runnerDigest: args.runnerDigest || '', catalogDigest: args.catalogDigest || '',
    graphDigest: args.graphDigest || '', closureCertificateDigest: args.closureCertificateDigest || '',
    baselineEpoch: args.baselineEpoch || '', toolchainDigest: args.toolchainDigest || '', buildProofDigest: args.buildProofDigest || '',
  });
}
export function loadBestMatchingAdmissiblePassReceipt(args: { commandId: string; inputDigest: string; baselineEpochId: string; receipts: ValidationCommandReceipt[]; now?: number }): ValidationCommandReceipt | undefined {
  return args.receipts.filter(receipt => receipt.commandId === args.commandId && receipt.inputDigest === args.inputDigest && receipt.canonicalBaselineEpochId === args.baselineEpochId)
    .filter(receipt => verifyValidationCommandReceipt(receipt, args.now || Date.now()).ok)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id))[0];
}

export interface SelectionRow { commandId: string; disposition: DynamicDisposition; reasons: string[]; inputDigest: string; receiptId?: string; closureCertificateDigest?: string; }
export interface ValidationSingletonContribution {
  /** The independently computed singleton input that contributed commands. */
  source: string;
  /** Command IDs selected by this one input, in canonical order. */
  commandIds: string[];
}
export interface ValidationSelectionManifest {
  findingConstraintDigest?: string;
  selectorDecisionDigest?: string;
  requestedTier?: ValidationTier;
  effectiveTier?: ValidationTier;
  tierSelections?: Record<ValidationTier, string[]>;
  schema: typeof VALIDATION_SELECTION_SCHEMA; storyId: string; baseHead: string; head: string; changeDigest: string;
  scopeContractDigest: string; catalogDigest: string; inventoryDigest: string; dependencyGraphDigest: string;
  closureCertificateSetDigest: string; toolchainDigest: string; buildProofDigest: string; canonicalBaselineEpochId: string;
  receiptRevocationLedgerDigest: string; changedFiles: StoryChangedFile[]; rows: SelectionRow[];
  singletonContributions: ValidationSingletonContribution[];
  totals: { inventory: number; executed: number; reused: number; excluded: number; unverified: number; uncovered: number; unmappedChanges: number };
  escalationReasons: string[]; fullEscalated: boolean; mode: DynamicValidationMode; signature: string;
}
export interface DynamicValidationContext {
  findingConstraints?: import('./finding-validation.js').FindingValidationConstraints;
  storyId: string; baseHead: string; head: string; inventory: ValidationInventory | ValidationInventoryCommand[];
  projectRoot?: string;
  catalog: ValidationCatalogEntry[]; changes: StoryChangeManifest;
  closures?: Map<string, ValidationClosureCertificate> | Record<string, ValidationClosureCertificate>;
  receipts?: ValidationCommandReceipt[]; baselineEpochId?: string; revocationLedger?: ReceiptRevocationLedger;
  buildProofDigest?: string; toolchainDigest?: string; runnerDigest?: string; mode?: DynamicValidationMode;
  graph?: DualRevisionImpactGraph; scopeContract?: ScopeContractData; gitCwd?: string; now?: number;
  /** Stable build/Wave-0 command that must execute on every dynamic run. */
  buildCommandId?: string;
  /** Canonical Story-relevance decision generated from the same Story snapshot as validation_plan. */
  tierSelection?: AutomaticValidationTierSelectionBinding;
}
function closureMap(value: DynamicValidationContext['closures']): Map<string, ValidationClosureCertificate> {
  return value instanceof Map ? value : new Map(Object.entries(value || {}));
}
function currentInventoryDigest(inventory: ValidationInventory | ValidationInventoryCommand[]): string {
  return Array.isArray(inventory) ? stableDigest(inventory) : inventory.digest;
}
function normalizeSingletonContributions(contributions: ValidationSingletonContribution[]): ValidationSingletonContribution[] {
  return contributions
    .map(row => ({ source: row.source, commandIds: uniqueSorted(row.commandIds) }))
    .filter(row => row.source.length > 0 && row.commandIds.length > 0)
    .sort((a, b) => a.source.localeCompare(b.source));
}
function singletonUnion(contributions: ValidationSingletonContribution[]): Set<string> {
  return new Set(contributions.flatMap(row => row.commandIds));
}
function isTrustedAncestor(sourceHead: string, currentHead: string, gitCwd = process.cwd()): boolean {
  if (!sourceHead) return false;
  if (sourceHead === currentHead) return true;
  try { execFileSync('git', ['merge-base', '--is-ancestor', sourceHead, currentHead], { cwd: gitCwd, stdio: 'ignore' }); return true; } catch { return false; }
}
/** Bind declared values to the same ambient/overlay normalization as execution. */
function declaredEnvironmentDigest(entry: ValidationCatalogEntry, ctx: DynamicValidationContext): string {
  const projectRoot = ctx.projectRoot || ctx.gitCwd || process.cwd();
  const cwd = resolve(projectRoot, entry.cwd || '.');
  const effective = effectiveValidationCommandEnvironment(process.env, entry.env, cwd);
  const keys = [...new Set((entry.declaredEnvironmentKeys || Object.keys(entry.env || {})).map(key => process.platform === 'win32' ? key.toUpperCase() : key))].sort();
  return stableDigest(keys.map(key => Object.prototype.hasOwnProperty.call(effective, key)
    ? [key, 'present', effective[key]] : [key, 'absent']));
}

/** A receipt-relative proof independent of the cumulative Story/base diff. */
function certifiedTreesEqual(gitCwd: string, source: string, current: string, entry: ValidationCatalogEntry, closure: ValidationClosureCertificate): boolean {
  if (closure.certifiedPaths.length === 0) return false;
  const projection = (head: string): string[] => {
    const raw = execFileSync('git', ['ls-tree', '-r', '-z', '--full-tree', head], {
      cwd: gitCwd, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result: string[] = [];
    for (const row of raw.split('\0')) {
      if (!row) continue;
      const tab = row.indexOf('\t');
      if (tab < 0 || !/^[0-7]{6} (?:blob|commit) [0-9a-f]+$/.test(row.slice(0, tab)) || !row.slice(tab + 1)) throw new Error('malformed committed tree row');
      const path = row.slice(tab + 1);
      if (entry.closurePolicy === 'whole-repository' || matchesPath(path, closure.certifiedPaths)) result.push(row);
    }
    return result.sort();
  };
  try {
    const before = projection(source), after = projection(current);
    return before.length === after.length && before.every((row, index) => row === after[index]);
  } catch { return false; }
}

function receiptAdmissible(receipt: ValidationCommandReceipt | undefined, entry: ValidationCatalogEntry, closure: ValidationClosureCertificate, ctx: DynamicValidationContext, inputDigest: string): boolean {
  if (!receipt || receipt.commandId !== entry.id || receipt.inputDigest !== inputDigest) return false;
  if (!verifyValidationCommandReceipt(receipt, ctx.now || Date.now()).ok || isReceiptRevoked(receipt, ctx.revocationLedger)) return false;
  const currentLedgerDigest = ctx.revocationLedger?.digest || stableDigest({});
  if (receipt.revocationLedgerDigest !== currentLedgerDigest) return false;
  if (!verifyValidationClosureCertificate(closure) || receipt.closureCertificateDigest !== closure.signature) return false;
  if (receipt.catalogDigest !== stableDigest(ctx.catalog) || receipt.inventoryDigest !== currentInventoryDigest(ctx.inventory)) return false;
  if (ctx.runnerDigest && receipt.runnerDigest !== ctx.runnerDigest) return false;
  if (ctx.buildProofDigest && receipt.buildProofDigest !== ctx.buildProofDigest) return false;
  if (receipt.sourceBaseHead !== ctx.baseHead || receipt.canonicalBaselineEpochId !== (ctx.baselineEpochId || '')) return false;
  if (ctx.gitCwd) {
    const executionEnvironmentDigest = stableDigest({ node: process.version, platform: process.platform, arch: process.arch });
    if (receipt.executionEnvironmentDigest !== executionEnvironmentDigest) return false;
  }
  if (ctx.gitCwd) {
    try {
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(receipt.sourceHead || '')) return false;
      // Replacement refs can reinterpret an old signed SHA without changing it.
      // A custom namespace is unknown authority; force real execution instead.
      if (Object.prototype.hasOwnProperty.call(process.env, 'GIT_REPLACE_REF_BASE')) return false;
      if (execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/replace/'], { cwd: ctx.gitCwd, encoding: 'utf8' }).trim()) return false;
      const actualHead = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: ctx.gitCwd, encoding: 'utf8' }).trim();
      if (actualHead !== ctx.head) return false;
      const sourceHead = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${receipt.sourceHead}^{commit}`], { cwd: ctx.gitCwd, encoding: 'utf8' }).trim();
      if (sourceHead !== receipt.sourceHead || !isTrustedAncestor(sourceHead, actualHead, ctx.gitCwd)) return false;
      const status = execFileSync('git', ['status', '--porcelain'], { cwd: ctx.gitCwd, encoding: 'utf8' }).trim();
      const cleanTreeDigest = stableDigest({ head: receipt.sourceHead, storyId: ctx.storyId, status: 'clean-at-command-start-and-end', provenanceSchema: VALIDATION_SOURCE_PROVENANCE_SCHEMA });
      if (status || receipt.cleanTreeDigest !== cleanTreeDigest) return false;
      if (!certifiedTreesEqual(ctx.gitCwd, sourceHead, actualHead, entry, closure)) return false;
    } catch {
      return false;
    }
  }
  if (entry.assurance === 'full-only' && receipt.producedBy !== 'canonical-full-baseline') return false;
  return isTrustedAncestor(receipt.sourceHead, ctx.head, ctx.gitCwd);
}

const FULL_ESCALATION_TOKENS = ['validation', 'scheduler', 'executor', 'catalog', 'selection', 'receipt', 'graph', 'package.json', 'package-lock', 'proof-or-stop.config', 'lattice.config', 'process-fact', 'runtime-fact', 'lifecycle', 'command-policy', 'build', 'lockfile'];
export function classifyFullValidationReasons(changes: StoryChangeManifest, catalog: ValidationCatalogEntry[] = []): string[] {
  const reasons = changes.scopeViolations.map(row => 'scope-violation:' + row.kind + ':' + row.path);
  const authorityRoots = new Set(validationAuthoritySources());
  for (const change of changes.changedFiles) for (const path of [change.path, change.oldPath]) {
    if (path && authorityRoots.has(normalPath(path))) reasons.push('authority-source-changed:' + path);
  }
  for (const row of changes.changedFiles) {
    if (FULL_ESCALATION_TOKENS.some(token => row.path.toLowerCase().includes(token))) reasons.push('validation-runtime-changed:' + row.path);
    if (row.path.startsWith('dist/') || row.path.startsWith('packages/main/dist/')) reasons.push('generated-output-changed:' + row.path);
  }
  return uniqueSorted(reasons);
}
function buildDynamicValidationPlanInternal(ctx: DynamicValidationContext): ValidationSelectionManifest {
  const inventory = Array.isArray(ctx.inventory) ? ctx.inventory : ctx.inventory.commands;
  const catalogById = new Map(ctx.catalog.map(entry => [entry.id, entry]));
  const closures = closureMap(ctx.closures); const selected = new Map<string, string[]>(); const unmapped: string[] = [];
  const contributionSets = new Map<string, Set<string>>();
  const contribute = (source: string, ids: Iterable<string>) => {
    const commandIds = contributionSets.get(source) || new Set<string>();
    for (const id of ids) {
      if (!catalogById.has(id)) throw new Error('singleton contribution references unmapped command: ' + id);
      commandIds.add(id);
    }
    if (commandIds.size > 0) contributionSets.set(source, commandIds);
  };
  const select = (id: string, reason: string, source = reason) => {
    if (!catalogById.has(id)) throw new Error('selection references unmapped command: ' + id);
    const reasons = selected.get(id) || []; if (!reasons.includes(reason)) reasons.push(reason); selected.set(id, reasons);
    contribute(source, [id]);
  };
  let canonicalTierDecision: AutomaticValidationTierSelectionBinding['decision'] | undefined;
  const compatibilityWideningReasons: string[] = [];
  if (ctx.tierSelection) {
    if (digestCanonicalJson({ input: ctx.tierSelection.input, decision: ctx.tierSelection.decision }) !== ctx.tierSelection.bindingDigest) {
      throw new Error('selector decision digest mismatch before validation execution');
    }
    const boundDecision = ctx.tierSelection.decision;
    const inventoryIds = inventory.map((row) => row.id);
    if (stableDigest(boundDecision.tierSelections['repository-full']) !== stableDigest(inventoryIds)) {
      throw new Error('selector repository-full membership does not match executor inventory');
    }
    const fast = new Set(boundDecision.tierSelections['story-fast']);
    const intermediate = new Set(boundDecision.tierSelections['story-intermediate']);
    const full = new Set(boundDecision.tierSelections['repository-full']);
    if ([...fast].some((id) => !intermediate.has(id)) || [...intermediate].some((id) => !full.has(id))) {
      throw new Error('selector tier subset invariant mismatch before validation execution');
    }
    canonicalTierDecision = boundDecision;
  }
  for (const entry of ctx.catalog) if (entry.assurance === 'always') select(entry.id, 'always', 'always');
  if (ctx.buildCommandId) select(ctx.buildCommandId, 'wave-0-build', 'wave-0-build');
  for (const pin of ctx.changes.pinnedValidationCommands) {
    const row = inventory.find(command => command.id === pin || command.label === pin || command.command === pin);
    if (!row && /^validation-[0-9a-f]{16}$/i.test(pin)) {
      for (const candidate of inventory) select(candidate.id, 'legacy-validation-pin-full-compatibility', `legacy-pin:${pin}`);
      compatibilityWideningReasons.push(`legacy-validation-pin-unresolved:${pin}`);
      continue;
    }
    if (!row) throw new Error('pinned command absent: ' + pin);
    select(row.id, 'verification-intent-pin', 'pin:' + pin);
  }
  if (ctx.findingConstraints) {
    if (ctx.findingConstraints.authority === 'shadow_only') throw new Error('dynamic finding: shadow comparison cannot authorize validation selection');
    if (ctx.findingConstraints.storyId !== ctx.storyId || ctx.findingConstraints.scopeExpansionAuthorized !== false
      || !ctx.findingConstraints.digest) throw new Error('dynamic finding constraints have invalid scope/identity');
    for (const command of ctx.findingConstraints.requiredCommands) {
      const row = inventory.find(row => row.id === command || row.command === command);
      if (!row) throw new Error('finding-required command absent from reviewed inventory: ' + command);
      select(row.id, 'dynamic-finding-required', 'finding:' + ctx.findingConstraints.digest);
    }
    for (const path of ctx.findingConstraints.affectedPaths) {
      const affected = ctx.catalog.filter(entry => [...(entry.inputRoots || []), ...(entry.triggerExtensions.files || [])]
        .some(pattern => matchesPath(path, [pattern])));
      if (!affected.length) unmapped.push(path);
      for (const entry of affected) select(entry.id, 'dynamic-finding-impact:' + path, 'finding-path:' + path);
    }
  }
  for (const change of ctx.changes.changedFiles) {
    const direct = ctx.catalog.filter(entry => [...(entry.inputRoots || []), ...(entry.triggerExtensions.files || [])].some(path => matchesPath(change.path, [path]))).map(entry => entry.id);
    const graph = ctx.graph ? ctx.graph.commandsAffectedBy(change) : [];
    const affected = uniqueSorted([...direct, ...graph]);
    if (!affected.length) unmapped.push(change.path);
    for (const id of direct) select(id, 'file-trigger:' + change.path, 'file-direct:' + change.path);
    for (const id of graph) select(id, 'reverse-dependency:' + change.path, 'file-graph:' + change.path);
  }
  for (const fact of ctx.changes.affectedProcessFacts) for (const entry of ctx.catalog.filter(row => (row.triggerExtensions.processFacts || []).includes(fact))) select(entry.id, 'process-fact:' + fact, 'process-fact:' + fact);
  for (const capability of ctx.changes.affectedCapabilities) for (const entry of ctx.catalog.filter(row => (row.triggerExtensions.capabilities || []).includes(capability))) select(entry.id, 'capability:' + capability, 'capability:' + capability);
  for (const entry of ctx.catalog) {
    if (entry.closurePolicy === 'never-reuse') select(entry.id, 'never-reuse-policy', 'never-reuse-policy');
  }
  const escalationReasons = uniqueSorted([
    ...compatibilityWideningReasons,
    ...classifyFullValidationReasons(ctx.changes, ctx.catalog),
    ...ctx.changes.changedFiles.flatMap(change => ctx.graph ? ctx.graph.authorityReasons(change) : ['authority-graph-unavailable']),
    ...unmapped.map(path => 'unmapped-change:' + path),
  ]);
  escalationReasons.push(...(ctx.findingConstraints?.reassessFindingIds ?? []).map(id => 'finding-reassessment-required:' + id));
  // Normative full-only semantics: an impacted full-only command escalates the
  // complete plan. An unimpacted command may avoid that escalation only when
  // its policy permits an exact canonical baseline receipt in this epoch.
  // `forbidden` therefore always escalates; `exact-current-epoch-only` must
  // prove a signed canonical receipt before the plan can remain dynamic.
  for (const entry of ctx.catalog) {
    const entryClosure = closures.get(entry.id);
    if (!entryClosure || !verifyValidationClosureCertificate(entryClosure)) {
      escalationReasons.push('closure-certificate-unavailable-or-incomplete:' + entry.id);
      continue;
    }
    const expectedStaticClosureDigest = stableDigest(uniqueSorted(entry.inputRoots || []));
    const expectedProcessFactBindingDigest = stableDigest(uniqueSorted(entry.triggerExtensions.processFacts || []));
    const expectedCapabilityBindingDigest = stableDigest(uniqueSorted(entry.triggerExtensions.capabilities || []));
    if (entryClosure.staticClosureDigest !== expectedStaticClosureDigest || entryClosure.processFactBindingDigest !== expectedProcessFactBindingDigest || entryClosure.capabilityBindingDigest !== expectedCapabilityBindingDigest) {
      escalationReasons.push('closure-binding-mismatch:' + entry.id);
      continue;
    }
    if (entry.assurance !== 'full-only') continue;
    if (selected.has(entry.id)) {
      escalationReasons.push('impacted-full-only-command:' + entry.id);
      continue;
    }
    const closure = closures.get(entry.id);
    const paths = closure ? closure.certifiedPaths : entry.inputRoots;
    const inputDigest = computeValidationInputDigest({
      command: entry, certifiedPaths: paths.map(path => ({ path })),
      environmentDigest: declaredEnvironmentDigest(entry, ctx),
      catalogDigest: stableDigest(ctx.catalog),
      graphDigest: ctx.graph ? stableDigest({ base: ctx.graph.baseGraphDigest, head: ctx.graph.headGraphDigest }) : '',
      closureCertificateDigest: closure ? closure.signature : '', baselineEpoch: ctx.baselineEpochId,
      toolchainDigest: ctx.toolchainDigest, buildProofDigest: ctx.buildProofDigest, runnerDigest: ctx.runnerDigest,
    });
    const hasExactBaselineReceipt = entry.fullBaselineReusePolicy === 'exact-current-epoch-only'
      && Boolean(closure)
      && (ctx.receipts || []).some(receipt => receipt.producedBy === 'canonical-full-baseline'
        && receipt.canonicalBaselineEpochId === (ctx.baselineEpochId || '')
        && receiptAdmissible(receipt, entry, closure!, ctx, inputDigest));
    if (!hasExactBaselineReceipt) escalationReasons.push('full-only-baseline-unavailable:' + entry.id);
  }
  if (ctx.graph && ctx.graph.graphUnknown) escalationReasons.push('dependency-graph-unavailable');
  const fullEscalated = escalationReasons.length > 0;
  // A full escalation widens the eligible universe, but it does not invalidate
  // an otherwise admissible current receipt. Rows without reusable proof still
  // execute below. This avoids making a conservative widening slower than the
  // canonical receipt-aware full path.
  const rows: SelectionRow[] = inventory.map(row => {
    const entry = catalogById.get(row.id); if (!entry) throw new Error('inventory command absent from catalog: ' + row.id);
    const closure = closures.get(row.id);
    const paths = closure ? closure.certifiedPaths : entry.inputRoots;
    const inputDigest = computeValidationInputDigest({
      command: entry, certifiedPaths: paths.map(path => ({ path })),
      environmentDigest: declaredEnvironmentDigest(entry, ctx),
      catalogDigest: stableDigest(ctx.catalog),
      graphDigest: ctx.graph ? stableDigest({ base: ctx.graph.baseGraphDigest, head: ctx.graph.headGraphDigest }) : '',
      closureCertificateDigest: closure ? closure.signature : '', baselineEpoch: ctx.baselineEpochId,
      toolchainDigest: ctx.toolchainDigest, buildProofDigest: ctx.buildProofDigest, runnerDigest: ctx.runnerDigest,
    });
    const tierSelected = !canonicalTierDecision || canonicalTierDecision.selectedUnitIds.includes(row.id);
    const mustParticipate = fullEscalated || tierSelected || selected.has(row.id)
      || entry.assurance === 'always' || entry.closurePolicy === 'never-reuse';
    if (selected.has(row.id) || entry.assurance === 'always' || entry.closurePolicy === 'never-reuse') {
      return { commandId: row.id, disposition: 'execute', reasons: selected.get(row.id) || [entry.closurePolicy === 'never-reuse' ? 'never-reuse-policy' : 'always'], inputDigest, ...(closure ? { closureCertificateDigest: closure.signature } : {}) };
    }
    if (!mustParticipate) {
      const proof = canonicalTierDecision?.exclusionProofs.find((candidate) => candidate.commandId === row.id);
      if (!proof) return { commandId: row.id, disposition: 'unverified', reasons: ['selector-exclusion-proof-missing'], inputDigest, ...(closure ? { closureCertificateDigest: closure.signature } : {}) };
      return {
        commandId: row.id,
        disposition: 'excluded',
        reasons: [`canonical-tier-exclusion:${proof.reason}`, `effective-tier:${canonicalTierDecision!.effectiveTier}`],
        inputDigest,
        ...(closure ? { closureCertificateDigest: closure.signature } : {}),
      };
    }
    // `forbidden` is stronger than receipt provenance: these full-only
    // commands must execute on every dynamic run and can never reuse.
    if (entry.assurance === 'full-only' && entry.fullBaselineReusePolicy === 'forbidden') {
      return { commandId: row.id, disposition: 'execute', reasons: ['full-only-reuse-forbidden'], inputDigest, ...(closure ? { closureCertificateDigest: closure.signature } : {}) };
    }
    if (!closure || !verifyValidationClosureCertificate(closure)) return { commandId: row.id, disposition: 'execute', reasons: ['closure-certificate-unavailable-or-incomplete'], inputDigest };
    const receipt = (ctx.receipts || []).filter(candidate => candidate.commandId === row.id)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id))
      .find(candidate => receiptAdmissible(candidate, entry, closure, ctx, inputDigest));
    if (receipt) return { commandId: row.id, disposition: 'reuse', reasons: ['certified-input-closure-unchanged'], inputDigest, receiptId: receipt.id, closureCertificateDigest: closure.signature };
    return { commandId: row.id, disposition: 'execute', reasons: ['no-admissible-reusable-receipt'], inputDigest, closureCertificateDigest: closure.signature };
  });
  const coveredByIndependentInputs = singletonUnion([...contributionSets.entries()].map(([source, ids]) => ({ source, commandIds: [...ids] })));
  for (const row of rows) {
    if (coveredByIndependentInputs.has(row.commandId)) continue;
    // A command with no triggering singleton still belongs to the complete
    // logical ledger: either an admissible receipt reused it or the absence of
    // one forces execution. Record that terminal decision explicitly so the
    // signed union cannot silently omit a command.
    contribute(row.disposition === 'reuse'
      ? 'admissible-receipt-reuse'
      : row.disposition === 'excluded' ? 'canonical-tier-exclusion' : 'default-execution', [row.commandId]);
  }
  const singletonContributions = normalizeSingletonContributions([...contributionSets.entries()].map(([source, ids]) => ({ source, commandIds: [...ids] })));
  const totals = {
    inventory: rows.length, executed: rows.filter(row => row.disposition === 'execute').length,
    reused: rows.filter(row => row.disposition === 'reuse').length,
    excluded: rows.filter(row => row.disposition === 'excluded').length,
    unverified: rows.filter(row => row.disposition === 'unverified').length,
    // An unmapped change is a trigger for the complete-plan escalation, not a
    // final inventory gap: once every command is selected, the oracle covers
    // that change and the signed manifest remains gap-free.
    uncovered: fullEscalated ? 0 : unmapped.length, unmappedChanges: fullEscalated ? 0 : unmapped.length,
  };
  if (totals.unverified || totals.uncovered) throw new Error('dynamic selection failed closed: unresolved inventory coverage');
  const body = {
    schema: VALIDATION_SELECTION_SCHEMA, storyId: ctx.storyId, baseHead: ctx.baseHead, head: ctx.head, changeDigest: ctx.changes.changeDigest,
    scopeContractDigest: ctx.scopeContract && ctx.scopeContract.digest || stableDigest(ctx.scopeContract || {}),
    catalogDigest: stableDigest(ctx.catalog), inventoryDigest: currentInventoryDigest(ctx.inventory),
    dependencyGraphDigest: ctx.graph ? stableDigest({ base: ctx.graph.baseGraphDigest, head: ctx.graph.headGraphDigest }) : '',
    closureCertificateSetDigest: stableDigest([...closures.entries()]), toolchainDigest: ctx.toolchainDigest || '',
    buildProofDigest: ctx.buildProofDigest || '', canonicalBaselineEpochId: ctx.baselineEpochId || '',
    receiptRevocationLedgerDigest: ctx.revocationLedger ? ctx.revocationLedger.digest : stableDigest({}),
    changedFiles: ctx.changes.changedFiles, rows, singletonContributions, totals, escalationReasons: uniqueSorted(escalationReasons),
    fullEscalated, mode: ctx.mode || 'observe',
    ...(canonicalTierDecision ? {
      selectorDecisionDigest: canonicalTierDecision.selectionDigest,
      requestedTier: canonicalTierDecision.requestedTier,
      effectiveTier: canonicalTierDecision.effectiveTier,
      tierSelections: canonicalTierDecision.tierSelections,
    } : {}),
    ...(ctx.findingConstraints ? { findingConstraintDigest: ctx.findingConstraints.digest } : {}),
  };
  return { ...body, signature: signPayload(body) };
}
export function buildDynamicValidationPlan(ctx: DynamicValidationContext): ValidationSelectionManifest {
  const manifest = buildDynamicValidationPlanInternal(ctx);
  assertSelectionIsSingletonUnionMonotonic(ctx, manifest);
  return manifest;
}
export function verifyValidationSelectionManifest(manifest: ValidationSelectionManifest, current?: Partial<Pick<ValidationSelectionManifest, 'storyId' | 'head' | 'baseHead'>>): boolean {
  if (manifest.schema !== VALIDATION_SELECTION_SCHEMA || !verifyPayload(withoutSignature(manifest), manifest.signature)) return false;
  if (current && ((current.storyId !== undefined && current.storyId !== manifest.storyId) || (current.head !== undefined && current.head !== manifest.head) || (current.baseHead !== undefined && current.baseHead !== manifest.baseHead))) return false;
  if (!Array.isArray(manifest.singletonContributions)) return false;
  const normalizedContributions = normalizeSingletonContributions(manifest.singletonContributions);
  if (normalizedContributions.length !== manifest.singletonContributions.length
    || stableDigest(normalizedContributions) !== stableDigest(manifest.singletonContributions)) return false;
  const contributionSources = new Set<string>();
  if (normalizedContributions.some(row => contributionSources.has(row.source) || row.commandIds.length === 0)) return false;
  for (const row of normalizedContributions) contributionSources.add(row.source);
  const commandIds = manifest.rows.map(row => row.commandId);
  const executed = manifest.rows.filter(row => row.disposition === 'execute').length;
  const reused = manifest.rows.filter(row => row.disposition === 'reuse').length;
  const excluded = manifest.rows.filter(row => row.disposition === 'excluded').length;
  const unverified = manifest.rows.filter(row => row.disposition === 'unverified').length;
  const accountedIds = new Set(manifest.rows.map(row => row.commandId));
  const contributedIds = singletonUnion(normalizedContributions);
  const tierBindingValid = manifest.selectorDecisionDigest === undefined
    ? manifest.requestedTier === undefined && manifest.effectiveTier === undefined && manifest.tierSelections === undefined
    : Boolean(manifest.requestedTier && manifest.effectiveTier && manifest.tierSelections
      && manifest.selectorDecisionDigest.length > 0
      && manifest.tierSelections['repository-full']
      && stableDigest(manifest.tierSelections['repository-full']) === stableDigest(commandIds));
  if (manifest.tierSelections) {
    const fast = new Set(manifest.tierSelections['story-fast']);
    const intermediate = new Set(manifest.tierSelections['story-intermediate']);
    const full = new Set(manifest.tierSelections['repository-full']);
    if ([...fast].some((id) => !intermediate.has(id)) || [...intermediate].some((id) => !full.has(id))) return false;
    const effective = new Set(manifest.tierSelections[manifest.effectiveTier!]);
    if (manifest.rows.some((row) => row.disposition === 'excluded'
      ? manifest.fullEscalated || effective.has(row.commandId)
      : !manifest.fullEscalated && !effective.has(row.commandId))) return false;
  }
  return manifest.totals.unverified === unverified
    && manifest.totals.executed === executed
    && manifest.totals.reused === reused
    && manifest.totals.excluded === excluded
    && manifest.totals.inventory === manifest.rows.length
    && new Set(commandIds).size === commandIds.length
    && executed + reused + excluded + unverified === manifest.rows.length
    && manifest.totals.unverified === 0
    && manifest.totals.uncovered === 0
    && manifest.totals.unmappedChanges === 0
    && contributedIds.size === accountedIds.size
    && [...contributedIds].every(id => accountedIds.has(id))
    && tierBindingValid
    && manifest.rows.every(row => row.disposition !== 'unverified');
}
export const buildSelectionManifest = buildDynamicValidationPlan;
export const verifySelectionManifest = verifyValidationSelectionManifest;
export function assertCompleteInventoryCoverage(inventory: ValidationInventory | ValidationInventoryCommand[], rows: SelectionRow[]): void {
  const commands = Array.isArray(inventory) ? inventory : inventory.commands; const ids = new Set(commands.map(row => row.id));
  if (rows.length !== ids.size || rows.some(row => !ids.has(row.commandId)) || rows.some(row => row.disposition === 'unverified')) throw new Error('selection inventory coverage is incomplete');
}
export function assertSelectionIsSingletonUnionMonotonic(context: DynamicValidationContext, manifest: ValidationSelectionManifest): void {
  if (manifest.totals.executed + manifest.totals.reused + manifest.totals.excluded + manifest.totals.unverified !== manifest.totals.inventory) throw new Error('selection ledger does not partition inventory');
  if (manifest.totals.unverified !== 0 || manifest.totals.uncovered !== 0) throw new Error('selection monotonicity cannot be certified with gaps');
  if (!verifyValidationSelectionManifest(manifest, { storyId: context.storyId, head: context.head, baseHead: context.baseHead })) throw new Error('selection monotonicity manifest is invalid');
  const expected = buildDynamicValidationPlanInternal(context);
  if (manifest.findingConstraintDigest !== expected.findingConstraintDigest) throw new Error('selection Finding evidence binding changed');
  const expectedRows = expected.rows.map(row => ({ commandId: row.commandId, disposition: row.disposition, reasons: row.reasons, inputDigest: row.inputDigest, receiptId: row.receiptId, closureCertificateDigest: row.closureCertificateDigest }));
  const actualRows = manifest.rows.map(row => ({ commandId: row.commandId, disposition: row.disposition, reasons: row.reasons, inputDigest: row.inputDigest, receiptId: row.receiptId, closureCertificateDigest: row.closureCertificateDigest }));
  if (stableDigest(actualRows) !== stableDigest(expectedRows)) throw new Error('selection monotonicity manifest does not match authoritative recomputation');
  if (stableDigest(manifest.singletonContributions) !== stableDigest(expected.singletonContributions)) throw new Error('selection singleton contributions do not match authoritative recomputation');
  const expectedSelected = singletonUnion(expected.singletonContributions);
  const actualSelected = singletonUnion(manifest.singletonContributions);
  if (expectedSelected.size !== actualSelected.size || [...expectedSelected].some(id => !actualSelected.has(id))) throw new Error('selection singleton union is not authoritative');
}
/**
 * Compare two authoritative plans where the second context contains an
 * expanded change set. The final selected command set is monotone: adding a
 * changed file/fact/capability may add commands, but can never remove one.
 * The per-manifest singleton-union check above separately proves complete
 * execute/reuse accounting.
 */
export function assertSelectionMonotonicity(baseContext: DynamicValidationContext, expandedContext: DynamicValidationContext): { base: ValidationSelectionManifest; expanded: ValidationSelectionManifest } {
  const base = buildDynamicValidationPlan(baseContext);
  const expanded = buildDynamicValidationPlan(expandedContext);
  const baseSelected = new Set(base.rows.filter(row => row.disposition === 'execute' || row.disposition === 'reuse').map(row => row.commandId));
  const expandedSelected = new Set(expanded.rows.filter(row => row.disposition === 'execute' || row.disposition === 'reuse').map(row => row.commandId));
  if ([...baseSelected].some(commandId => !expandedSelected.has(commandId))) throw new Error('selection monotonicity violated: expanded change set removed a selected command');
  return { base, expanded };
}

export interface DynamicEnforcementPrerequisites {
  baselineCurrent: boolean; expiryPolicyActive: boolean; environmentPolicyComplete: boolean;
  wholeRepoScannersClassified: boolean; processFactBindingsComplete: boolean; changedTestPropagationVerified: boolean;
  sourceFirstBuildProofActive: boolean; buildAlwaysExecuted: boolean; storyRiskEligible: boolean;
  periodicFullPolicyActive: boolean; revocationLedgerCurrent: boolean; catalogOwnershipGatePassed: boolean;
}
export interface DynamicAuthorityDecision {
  accepted: boolean; authoritative: boolean; fallbackToFull: boolean; reasons: string[];
  enforcementPrerequisites: Array<{ name: keyof DynamicEnforcementPrerequisites; pass: boolean; blocking: true }>;
}
export function evaluateDynamicAuthority(args: {
  mode: DynamicValidationMode; riskTier: RiskTier; manifest: ValidationSelectionManifest;
  prerequisites: Partial<DynamicEnforcementPrerequisites>; pinnedCommandsExecuted?: boolean; focused?: boolean;
}): DynamicAuthorityDecision {
  const names: Array<keyof DynamicEnforcementPrerequisites> = [
    'baselineCurrent', 'expiryPolicyActive', 'environmentPolicyComplete', 'wholeRepoScannersClassified',
    'processFactBindingsComplete', 'changedTestPropagationVerified', 'sourceFirstBuildProofActive',
    'buildAlwaysExecuted', 'storyRiskEligible', 'periodicFullPolicyActive', 'revocationLedgerCurrent', 'catalogOwnershipGatePassed',
  ];
  const enforcementPrerequisites = names.map(name => ({ name, pass: args.prerequisites[name] === true, blocking: true as const }));
  const reasons = enforcementPrerequisites.filter(row => !row.pass).map(row => 'prerequisite-failed:' + row.name);
  if (args.mode === 'off') reasons.push('dynamic-mode-off');
  if (args.focused) reasons.push('focused-validation-is-not-authoritative');
  if (args.riskTier !== 'local') reasons.push('risk-tier-not-dynamic-authority');
  if (!verifyValidationSelectionManifest(args.manifest)) reasons.push('selection-manifest-invalid');
  if (args.manifest.fullEscalated) reasons.push('full-escalation-required');
  if (args.pinnedCommandsExecuted === false) reasons.push('verification-intent-pin-not-executed');
  const allPrerequisites = enforcementPrerequisites.every(row => row.pass);
  const authoritative = args.mode === 'enforce-low-risk' && allPrerequisites && reasons.length === 0;
  return { accepted: args.mode === 'observe' || args.mode === 'shadow' || authoritative, authoritative, fallbackToFull: !authoritative, reasons, enforcementPrerequisites };
}
export function resolveDynamicMode(value: unknown): DynamicValidationMode {
  return typeof value === 'string' && (DYNAMIC_MODES as readonly string[]).includes(value) ? value as DynamicValidationMode : 'off';
}
export function formatDynamicValidationReport(args: { manifest: ValidationSelectionManifest; authority?: DynamicAuthorityDecision; durationMs?: number; fullOracle?: { allPass: boolean; failures?: string[] } }): string {
  const m = args.manifest;
  const lines = [
    'Dynamic validation plan', '  inventory: ' + m.totals.inventory, '  changed files: ' + m.changedFiles.length,
    '  pinned commands: ' + m.rows.filter((row) => row.reasons.includes('verification-intent-pin')).length, '  executed: ' + m.totals.executed, '  reused: ' + m.totals.reused, '  excluded: ' + m.totals.excluded,
    '  unverified: ' + m.totals.unverified, '  uncovered: ' + m.totals.uncovered, '  unmapped changes: ' + m.totals.unmappedChanges,
    '  escalation: ' + (m.fullEscalated ? 'yes' : 'no'), '  selection digest: ' + stableDigest(m),
  ];
  if (args.authority) lines.push('  authority: ' + (args.authority.authoritative ? 'accepted' : 'full-fallback') + ' (' + m.mode + ')');
  if (args.durationMs !== undefined) lines.push('  duration: ' + args.durationMs + 'ms');
  if (args.fullOracle) lines.push('  full-plan oracle: ' + (args.fullOracle.allPass ? 'PASS' : 'FAIL'));
  if (m.fullEscalated) lines.push('Dynamic validation escalated to full');
  else if (m.mode === 'observe') lines.push('Dynamic validation observe-only; complete full-plan oracle remains authoritative');
  else if (m.mode === 'shadow') lines.push('Dynamic validation shadow; complete full-plan oracle remains authoritative');
  else lines.push('Dynamic validation PASS');
  return lines.join('\n');
}

export interface ScheduledValidationEntry {
  commandId: string; originalIndex: number; cpuWeight: number; expectedP50Ms: number;
  resources: ResourceClaim[]; wave?: number;
}
export interface ValidationScheduleRow extends ScheduledValidationEntry {
  wave: number; startOffsetMs: number; endOffsetMs: number;
}
function resourcesConflict(left: ResourceClaim[], right: ResourceClaim[]): boolean {
  for (const a of left) for (const b of right) if (a.class === b.class && a.key === b.key && (a.access === 'exclusive' || b.access === 'exclusive')) return true;
  return false;
}
export function buildValidationSchedule(entries: ScheduledValidationEntry[], options: { workerCapacity?: number; cpuCapacity?: number } = {}): ValidationScheduleRow[] {
  const workers = Math.max(1, Math.floor(options.workerCapacity || 4)); const cpuCapacity = Math.max(1, options.cpuCapacity || workers);
  const waves: ValidationScheduleRow[][] = [];
  const sorted = [...entries].sort((a, b) => (a.wave || 0) - (b.wave || 0) || b.expectedP50Ms - a.expectedP50Ms || a.originalIndex - b.originalIndex);
  for (const entry of sorted) {
    if (!Number.isFinite(entry.cpuWeight) || entry.cpuWeight < 1 || entry.cpuWeight > cpuCapacity) {
      throw new Error(`validation command ${entry.commandId} cpuWeight=${entry.cpuWeight} exceeds scheduler capacity=${cpuCapacity}`);
    }
    let waveIndex = entry.wave || 0;
    while (true) {
      const wave = waves[waveIndex] || []; const cpu = wave.reduce((sum, row) => sum + row.cpuWeight, 0);
      if (wave.length < workers && cpu + entry.cpuWeight <= cpuCapacity && !wave.some(row => resourcesConflict(row.resources, entry.resources))) break;
      waveIndex += 1;
    }
    const wave = waves[waveIndex] || (waves[waveIndex] = []);
    const previousWaveEnd = waves.slice(0, waveIndex).flat().reduce((max, row) => Math.max(max, row.endOffsetMs), 0);
    const startOffsetMs = previousWaveEnd + wave.reduce((max, row) => Math.max(max, row.endOffsetMs - previousWaveEnd), 0);
    wave.push({ ...entry, wave: waveIndex, startOffsetMs, endOffsetMs: startOffsetMs + Math.max(1, entry.expectedP50Ms) });
  }
  return waves.flat().sort((a, b) => a.wave - b.wave || b.expectedP50Ms - a.expectedP50Ms || a.originalIndex - b.originalIndex);
}
export const buildLptSchedule = buildValidationSchedule;
export function verifyValidationSchedule(
  schedule: ValidationScheduleRow[],
  entries: ScheduledValidationEntry[],
  options: { workerCapacity?: number; cpuCapacity?: number } = {},
): { ok: boolean; errors: string[] } {
  const errors: string[] = []; const expected = new Set(entries.map(row => row.commandId)); const actual = schedule.map(row => row.commandId);
  const workerCapacity = Math.max(1, Math.floor(options.workerCapacity || 4));
  const cpuCapacity = Math.max(1, options.cpuCapacity || workerCapacity);
  if (actual.length !== expected.size || new Set(actual).size !== actual.length || actual.some(id => !expected.has(id))) errors.push('schedule missing or duplicate command');
  const waveEnds = new Map<number, number>();
  for (const row of schedule) {
    if (!Number.isFinite(row.startOffsetMs) || !Number.isFinite(row.endOffsetMs) || row.endOffsetMs <= row.startOffsetMs) errors.push('invalid timeline:' + row.commandId);
    const priorEnd = [...waveEnds.entries()].filter(([wave]) => wave < row.wave).reduce((max, [, end]) => Math.max(max, end), 0);
    if (row.startOffsetMs < priorEnd) errors.push('wave starts before prior wave drains:' + row.commandId);
    waveEnds.set(row.wave, Math.max(waveEnds.get(row.wave) || 0, row.endOffsetMs));
  }
  const rowsByWave = new Map<number, ValidationScheduleRow[]>();
  for (const row of schedule) {
    const rows = rowsByWave.get(row.wave) || [];
    rows.push(row);
    rowsByWave.set(row.wave, rows);
  }
  for (const [wave, rows] of rowsByWave) {
    if (rows.length > workerCapacity) errors.push(`worker capacity exceeded:wave-${wave}`);
    const cpu = rows.reduce((sum, row) => sum + row.cpuWeight, 0);
    if (!Number.isFinite(cpu) || cpu > cpuCapacity) errors.push(`cpu capacity exceeded:wave-${wave}`);
    for (const row of rows) if (!Number.isFinite(row.cpuWeight) || row.cpuWeight < 1 || row.cpuWeight > cpuCapacity) {
      errors.push(`invalid cpu weight:${row.commandId}`);
    }
  }
  for (const left of schedule) for (const right of schedule) {
    if (left.commandId >= right.commandId) continue;
    if (left.wave === right.wave && resourcesConflict(left.resources, right.resources)) errors.push('resource overlap:' + left.commandId + ':' + right.commandId);
  }
  return { ok: errors.length === 0, errors };
}

export interface ValidationCase {
  caseId: string; domain: 'quorum' | 'review-pass' | string; sentinel?: boolean; payload?: unknown;
  /** The real case body executed by the registered adapter. */
  runner?: { command: string; args?: string[]; cwd?: string; env?: Record<string, string>; successMarker?: string };
}
export interface ValidationShard {
  shardId: string; domain: string; caseIds: string[]; sentinelCaseId: string; staticPass?: boolean;
}
export interface ValidationShardResult {
  shardId: string; domain: string; caseIds: string[]; verdict: 'PASS' | 'FAIL';
  residue?: string[]; executed?: boolean; staticPass?: boolean; sentinelObserved?: boolean; receiptId?: string;
}
export interface ValidationShardReceipt {
  schema: typeof VALIDATION_SHARD_RECEIPT_SCHEMA; id: string; shardId: string; domain: string;
  commandId: string; caseIds: string[]; sentinelCaseId: string; sentinelObserved: boolean;
  caseRegistryDigest: string; adapterDigest: string; registryObserved: boolean;
  sourceHead: string; result: 'PASS' | 'FAIL'; exitCode: number; outputDigest: string;
  executed: boolean; staticPass: boolean; residue: string[]; cleanupDigest: string; createdAt: string; signature: string;
}
export function createValidationShardReceipt(args: Omit<ValidationShardReceipt, 'schema' | 'signature'>): ValidationShardReceipt {
  const body = { ...args, schema: VALIDATION_SHARD_RECEIPT_SCHEMA };
  return { ...body, signature: signPayload(body) };
}
export function verifyValidationShardReceipt(receipt: ValidationShardReceipt): boolean {
  return receipt.schema === VALIDATION_SHARD_RECEIPT_SCHEMA
    && receipt.executed === true && receipt.staticPass === false
    && receipt.caseIds.includes(receipt.sentinelCaseId)
    && receipt.sentinelObserved === true
    && receipt.registryObserved === true
    && HEX64.test(receipt.caseRegistryDigest)
    && HEX64.test(receipt.adapterDigest)
    && receipt.residue.length === 0
    && verifyPayload(withoutSignature(receipt), receipt.signature);
}
export function buildValidationShards(cases: ValidationCase[], options: { domain?: string; shardCount?: number } = {}): ValidationShard[] {
  const domain = options.domain || cases[0]?.domain || 'quorum';
  const filtered = cases.filter(row => row.domain === domain).sort((a, b) => a.caseId.localeCompare(b.caseId));
  const minimum = domain === 'review-pass' ? 3 : 3; const maximum = domain === 'review-pass' ? 3 : 4;
  const count = Math.max(minimum, Math.min(maximum, Math.floor(options.shardCount || maximum)));
  const groups: ValidationCase[][] = Array.from({ length: count }, () => []);
  filtered.forEach((row, index) => groups[index % count]!.push(row));
  return groups.map((group, index) => {
    const sentinel = group.find(row => row.sentinel) || group[0];
    if (!sentinel) throw new Error('cannot create empty ' + domain + ' shard ' + index);
    return { shardId: domain + '-shard-' + (index + 1), domain, caseIds: group.map(row => row.caseId), sentinelCaseId: sentinel.caseId };
  });
}
export function aggregateValidationShards(args: { cases: ValidationCase[]; shards: ValidationShard[]; results: ValidationShardResult[]; domain?: string }): { ok: boolean; verdict: 'PASS' | 'FAIL'; errors: string[]; coveredCaseIds: string[] } {
  const domain = args.domain || args.cases[0]?.domain || 'quorum'; const cases = args.cases.filter(row => row.domain === domain);
  const expected = new Set(cases.map(row => row.caseId)); const errors: string[] = [];
  const shards = args.shards.filter(shard => shard.domain === domain); const shardIds = new Set(shards.map(shard => shard.shardId));
  const results = args.results.filter(result => result.domain === domain);
  if (results.length !== shardIds.size || new Set(results.map(result => result.shardId)).size !== results.length) errors.push('missing or duplicate shard result');
  const covered = results.flatMap(result => result.caseIds);
  if (new Set(covered).size !== covered.length) errors.push('duplicate case coverage');
  if (covered.some(id => !expected.has(id)) || covered.length !== expected.size || [...expected].some(id => !covered.includes(id))) errors.push('case omission or wrong routing');
  for (const result of results) {
    const shard = shards.find(row => row.shardId === result.shardId);
    if (!shard || shard.caseIds.slice().sort().join('\0') !== result.caseIds.slice().sort().join('\0')) errors.push('routing mismatch:' + result.shardId);
    if (result.staticPass || result.executed !== true) errors.push('non-executed static PASS:' + result.shardId);
    if (result.residue && result.residue.length) errors.push('residue:' + result.shardId);
    if (result.sentinelObserved !== true) errors.push('sentinel not observed:' + result.shardId);
    if (shard && !result.caseIds.includes(shard.sentinelCaseId)) errors.push('sentinel omitted:' + result.shardId);
  }
  const verdict = errors.length || results.some(result => result.verdict === 'FAIL') ? 'FAIL' : 'PASS';
  return { ok: errors.length === 0 && verdict === 'PASS', verdict, errors, coveredCaseIds: uniqueSorted(covered) };
}
export const aggregateShards = aggregateValidationShards;

export function runObserveOracle(args: {
  manifest: ValidationSelectionManifest; fullOracle: { allPass: boolean; failedCommandIds?: string[] };
  instrumentedOrder: string[]; authoritativeOrder: string[];
}): { mode: 'observe'; authoritative: false; equivalent: boolean; falseNegativeCommandIds: string[]; reason: string } {
  const selected = new Set(args.manifest.rows.filter(row => row.disposition === 'execute').map(row => row.commandId));
  const failures = args.fullOracle.failedCommandIds || [];
  const falseNegativeCommandIds = failures.filter(id => !selected.has(id));
  const authoritativeSelectedOrder = args.authoritativeOrder.filter(id => selected.has(id));
  const equivalent = falseNegativeCommandIds.length === 0 && args.instrumentedOrder.join('\0') === authoritativeSelectedOrder.join('\0');
  return { mode: 'observe', authoritative: false, equivalent, falseNegativeCommandIds, reason: equivalent ? 'observe-only selection agrees with full-plan oracle' : 'observe-only oracle mismatch; retain full authority' };
}
