#!/usr/bin/env node
/**
 * Retired authority vocabulary guard.
 *
 * This is the active vocabulary gate for
 * docs/requirements/decisions/authority-server-vocabulary-retirement.md.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { MAIN_TOOLS } from '../cli-engine.js';
import { NESTED_SPACE_ALIASES } from '../cli/alias-normalizer.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..', '..');
const repoRoot = join(pkgRoot, '..', '..');
const CONTRACT_PATH = 'docs/requirements/decisions/authority-server-vocabulary-retirement.md';

interface PatternRule {
  label: string;
  pattern: RegExp;
}

interface Violation {
  file: string;
  line: number;
  label: string;
  text: string;
}

const bannedActiveRules: PatternRule[] = [
  { label: 'Authority Server', pattern: /\bAuthority Server\b/ },
  { label: 'authorityDone', pattern: /\bauthorityDone\b/ },
  { label: 'fullAuthorityDone', pattern: /\bfullAuthorityDone\b/ },
  { label: 'productionDone', pattern: /\bproductionDone\b/ },
  { label: 'production authority', pattern: /\bproduction\s+authority\b/i },
  { label: 'Authority completion', pattern: /\bAuthority\s+completion\b/i },
  { label: 'production completion', pattern: /\bproduction\s+completion\b/i },
  { label: 'production DONE', pattern: /\bproduction\s+DONE\b/i },
  { label: 'LATTICE_AUTHORITY_*', pattern: /\bLATTICE_AUTHORITY_[A-Z0-9_]*\b/ },
  { label: 'active authority_* command', pattern: /\bauthority_[a-z][a-z0-9_]*\b/ },
  { label: 'retired story resolver command', pattern: /\bstory_authority_resolve\b/ },
];

const activeTextFiles = [
  'README.md',
  'docs/guide.md',
  'lattice.config.json',
  'packages/main/package.json',
  'packages/main/src/registry.ts',
  'packages/main/src/core/config.ts',
  'packages/main/src/cli/alias-normalizer.ts',
  'packages/main/src/cli/activity-policy.ts',
  'packages/main/src/cli/command-catalog.ts',
  'packages/main/src/cli/help-renderer.ts',
] as const;

const activeTextDirs = [
  '.lattice-codex',
  '.claude/agents',
  'packages/main/templates/agents',
] as const;

const EXECUTABLE_SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const;
const ACTIVE_SCAN_EXTENSIONS = ['.md', '.json', ...EXECUTABLE_SOURCE_EXTENSIONS] as const;
const SHIPPED_EXECUTABLE_SOURCE_DIRS = [
  'bin',
  'packages/main/src',
  'packages/lab/src',
  'packages/utils/src',
] as const;
const SHIPPED_EXECUTABLE_ENTRYPOINTS = [
  'bin/lattice.js',
  'bin/bootstrap-runner.js',
  'packages/main/src/cli.ts',
  'packages/main/src/index.ts',
  'packages/main/src/tasks/test-flow-e2e.ts',
  'packages/lab/src/index.ts',
  'packages/lab/src/register.ts',
  'packages/utils/src/index.ts',
  'packages/utils/src/register.ts',
] as const;
const SHIPPED_PACKAGE_MANIFESTS = [
  'packages/main/package.json',
  'packages/lab/package.json',
  'packages/utils/package.json',
] as const;

function isExecutableSourceFile(file: string): boolean {
  return EXECUTABLE_SOURCE_EXTENSIONS.some(extension => file.endsWith(extension));
}

function collectPublishedTargets(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(collectPublishedTargets);
}

function deriveSourceEntrypoint(manifestPath: string, publishedTarget: string): string | undefined {
  const normalized = publishedTarget.replace(/^\.\//, '');
  if (!normalized.startsWith('dist/') || !/\.js$/.test(normalized)) return undefined;
  return join(dirname(manifestPath), normalized.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts')).replace(/\\/g, '/');
}

function deriveShippedPackageEntrypoints(): string[] {
  return SHIPPED_PACKAGE_MANIFESTS.flatMap(manifestPath => {
    const manifest = JSON.parse(readRel(manifestPath)) as { bin?: unknown; exports?: unknown };
    return [...collectPublishedTargets(manifest.bin), ...collectPublishedTargets(manifest.exports)]
      .flatMap(target => deriveSourceEntrypoint(manifestPath, target) ?? []);
  }).filter((entrypoint, index, all) => all.indexOf(entrypoint) === index).sort();
}

type PackageAliasKind = 'imports' | 'self-export';

interface PackageAliasEdge {
  manifestPath: string;
  packageDir: string;
  packageName: string;
  kind: PackageAliasKind;
  specifierPattern: string;
  targetPattern: string;
  conditionPath: string;
}

interface PackageAliasManifestRecord {
  path: string;
  manifest: { name?: unknown; imports?: unknown; exports?: unknown };
}

function collectConditionalTargets(value: unknown, conditionPath = 'default'): Array<{ target: string; conditionPath: string }> {
  if (typeof value === 'string') return [{ target: value, conditionPath }];
  if (Array.isArray(value)) return value.flatMap((entry, index) => collectConditionalTargets(entry, `${conditionPath}[${index}]`));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([condition, target]) => collectConditionalTargets(target, `${conditionPath}.${condition}`));
}

function buildPackageAliasEdgeInventory(records: readonly PackageAliasManifestRecord[]): PackageAliasEdge[] {
  const edges: PackageAliasEdge[] = [];
  for (const record of records) {
    if (typeof record.manifest.name !== 'string' || record.manifest.name.length === 0) continue;
    const packageName = record.manifest.name;
    const packageDir = dirname(record.path).replace(/\\/g, '/');
    if (record.manifest.imports && typeof record.manifest.imports === 'object' && !Array.isArray(record.manifest.imports)) {
      for (const [specifierPattern, targetValue] of Object.entries(record.manifest.imports)) {
        for (const target of collectConditionalTargets(targetValue)) {
          edges.push({ manifestPath: record.path, packageDir, packageName, kind: 'imports', specifierPattern, targetPattern: target.target, conditionPath: target.conditionPath });
        }
      }
    }
    const exportEntries = record.manifest.exports && typeof record.manifest.exports === 'object' && !Array.isArray(record.manifest.exports)
      && Object.keys(record.manifest.exports).some(key => key === '.' || key.startsWith('./'))
      ? Object.entries(record.manifest.exports)
      : [['.', record.manifest.exports] as [string, unknown]];
    for (const [exportKey, targetValue] of exportEntries) {
      const specifierPattern = exportKey === '.' ? packageName : `${packageName}${exportKey.slice(1)}`;
      for (const target of collectConditionalTargets(targetValue)) {
        edges.push({ manifestPath: record.path, packageDir, packageName, kind: 'self-export', specifierPattern, targetPattern: target.target, conditionPath: target.conditionPath });
      }
    }
  }
  return edges.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

const PACKAGE_ALIAS_MANIFEST_RECORDS: PackageAliasManifestRecord[] = SHIPPED_PACKAGE_MANIFESTS.map(path => ({
  path,
  manifest: JSON.parse(readRel(path)) as PackageAliasManifestRecord['manifest'],
}));
const PACKAGE_ALIAS_EDGE_INVENTORY = buildPackageAliasEdgeInventory(PACKAGE_ALIAS_MANIFEST_RECORDS);
const PACKAGE_ALIAS_EDGE_INVENTORY_ALGORITHM = 'package-imports-self-exports-edge-inventory-sha256-v1';
const PINNED_PACKAGE_ALIAS_EDGE_INVENTORY_HASH = 'b188998274384ced74b3854db09d331d6040ee8cc2c7897d0f966860f7a3eae4';

function packageAliasEdgeInventoryHash(records: readonly PackageAliasManifestRecord[], edges: readonly PackageAliasEdge[]): string {
  const manifestSurfaces = records.map(record => ({
    path: record.path,
    name: record.manifest.name ?? null,
    imports: record.manifest.imports ?? null,
    exports: record.manifest.exports ?? null,
  }));
  return createHash('sha256').update(JSON.stringify({ manifestSurfaces, edges })).digest('hex');
}

function aliasPatternCapture(pattern: string, specifier: string): string | undefined {
  const star = pattern.indexOf('*');
  if (star === -1) return pattern === specifier ? '' : undefined;
  if (pattern.indexOf('*', star + 1) !== -1) return undefined;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  return specifier.startsWith(prefix) && specifier.endsWith(suffix)
    ? specifier.slice(prefix.length, specifier.length - suffix.length)
    : undefined;
}

function packageSourceTarget(edge: PackageAliasEdge, capture: string): string | undefined {
  if (!edge.targetPattern.startsWith('./')) return undefined;
  const substituted = edge.targetPattern.replace('*', capture).replace(/^\.\//, '');
  const sourceRelative = substituted.startsWith('dist/')
    ? substituted.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts')
    : substituted;
  return normalizeModulePath(join(edge.packageDir, sourceRelative).replace(/\\/g, '/'));
}

interface StaticModuleResolution {
  targets: string[];
  error?: string;
}

function resolvePackageAlias(
  file: string,
  specifier: string,
  edges: readonly PackageAliasEdge[] = PACKAGE_ALIAS_EDGE_INVENTORY,
): StaticModuleResolution {
  const owners = [...new Map(edges.map(edge => [edge.manifestPath, edge])).values()]
    .filter(edge => file.startsWith(`${edge.packageDir}/`))
    .sort((left, right) => right.packageDir.length - left.packageDir.length);
  const owner = owners[0];
  const kind: PackageAliasKind | undefined = specifier.startsWith('#')
    ? 'imports'
    : owner && (specifier === owner.packageName || specifier.startsWith(`${owner.packageName}/`)) ? 'self-export' : undefined;
  if (!kind) return { targets: [] };
  if (!owner) return { targets: [], error: `package alias ${specifier} has no owning package manifest` };
  const candidates = edges.filter(edge => edge.manifestPath === owner.manifestPath && edge.kind === kind)
    .flatMap(edge => {
      const capture = aliasPatternCapture(edge.specifierPattern, specifier);
      if (capture === undefined) return [];
      const target = packageSourceTarget(edge, capture);
      return target ? [target] : [];
    });
  if (candidates.length === 0) return { targets: [], error: `package alias ${specifier} has no supported source target` };
  return { targets: [...new Set(candidates)].sort() };
}

const retiredFutureBacklogPlanFiles = [
  'docs/requirements/decisions/global-lifecycle-control-plane-execution-plan.md',
  'docs/requirements/decisions/proof-admissibility-hardening-execution-plan.md',
] as const;

const retiredFutureBacklogRules: PatternRule[] = [
  { label: 'active Authority Server future backlog', pattern: /\bAuthority Server\b/ },
  { label: 'active Authority production future backlog', pattern: /\bAuthority production\b/ },
  { label: 'active server-backed receipt parity backlog', pattern: /\bserver-backed production receipt parity\b/ },
  { label: 'active Authority conformance backlog', pattern: /\bAuthority Server conformance\b/ },
];

const explicitLegacyTaskQuarantineFiles = new Set([
  'packages/main/src/tasks/baseline-contracts-smoke.ts',
  'packages/main/src/tasks/baseline-local-certification-smoke.ts',
  'packages/main/src/tasks/baseline-suite-report-smoke.ts',
  'packages/main/src/tasks/baseline-suite-smoke.ts',
  'packages/main/src/tasks/budget-meter-smoke.ts',
  'packages/main/src/tasks/canonical-story-export-smoke.ts',
  'packages/main/src/tasks/capability-list-smoke.ts',
  'packages/main/src/tasks/cli-json-stdout-contract-smoke.ts',
  'packages/main/src/tasks/command-catalog-smoke.ts',
  'packages/main/src/tasks/delivery-context-pack-smoke.ts',
  'packages/main/src/tasks/dispatch-run-smoke.ts',
  'packages/main/src/tasks/evidence-plan-smoke.ts',
  'packages/main/src/tasks/evidence-refresh-smoke.ts',
  'packages/main/src/tasks/field-regression-cli-smoke.ts',
  'packages/main/src/tasks/flow-stability-smoke.ts',
  'packages/main/src/tasks/host-overflow-smoke.ts',
  'packages/main/src/tasks/init-preflight-smoke.ts',
  'packages/main/src/tasks/lattice-baseline-smoke.ts',
  'packages/main/src/tasks/lattice-cli-migration-smoke.ts',
  'packages/main/src/tasks/lattice-evidence-smoke.ts',
  'packages/main/src/tasks/lattice-handoff-smoke.ts',
  'packages/main/src/tasks/lattice-parallel-wave-smoke.ts',
  'packages/main/src/tasks/lifecycle-check-smoke.ts',
  'packages/main/src/tasks/lifecycle-orchestrate-smoke.ts',
  'packages/main/src/tasks/live-smoke-transcript-smoke.ts',
  'packages/main/src/tasks/plan-skeleton-smoke.ts',
  'packages/main/src/tasks/prompt-registry-smoke.ts',
  'packages/main/src/tasks/prompt-token-cost-smoke.ts',
  'packages/main/src/tasks/proof-admissibility-smoke.ts',
  'packages/main/src/tasks/provider-claude-smoke.ts',
  'packages/main/src/tasks/provider-codex-smoke.ts',
  'packages/main/src/tasks/quorum-submit-smoke.ts',
  'packages/main/src/tasks/repair-retry-integration-smoke.ts',
  'packages/main/src/tasks/repair-retry-loop-smoke.ts',
  'packages/main/src/tasks/review-assurance-floor-smoke.ts',
  'packages/main/src/tasks/review-escalation-freshness-root-smoke.ts',
  'packages/main/src/tasks/review-escalation-smoke.ts',
  'packages/main/src/tasks/review-loop-smoke.ts',
  'packages/main/src/tasks/reviewer-batch-smoke.ts',
  'packages/main/src/tasks/runtime-owned-agent-assets-smoke.ts',
  'packages/main/src/tasks/story-review-ergonomics-smoke.ts',
  'packages/main/src/tasks/review-assurance-floor-storyfileshash-smoke.ts',
  'packages/main/src/tasks/unattended-dispatch-smoke.ts',
  'packages/main/src/tasks/worktree-policy-smoke.ts',
]);

const legacyQuarantineFiles = new Set([
  CONTRACT_PATH,
  'packages/main/src/core/authority-contracts.ts',
  'packages/main/src/core/baseline.ts',
  'packages/main/src/core/baseline-contracts.ts',
  'packages/main/src/core/legacy-delivery-claims-compat.ts',
  'packages/main/src/core/baseline-suite-report.ts',
  'packages/main/src/core/lattice-baseline.ts',
  'packages/main/src/core/verdicts.ts',
  'packages/main/src/tasks/retired-authority-vocabulary-guard-smoke.ts',
  'packages/main/src/tasks/retired-authority-server-semantics-smoke.ts',
  'packages/main/src/handlers/story-authority-resolve.ts',
  'packages/main/src/core/story-authority-resolver.ts',
  'packages/main/src/tasks/story-authority-resolve-smoke.ts',
  'packages/main/src/tasks/observability-contract-smoke.ts',
  'packages/main/src/tasks/observability-snapshot-smoke.ts',
  'packages/main/src/core/observability-snapshot.ts',
  'packages/main/src/handlers/observability-snapshot.ts',
]);

const retiredServerBackedModuleFiles = new Set([
  'packages/main/src/handlers/story-authority-resolve.ts',
  'packages/main/src/core/story-authority-resolver.ts',
]);

const LEGACY_DELIVERY_COMPAT_MODULE = 'packages/main/src/core/legacy-delivery-claims-compat.ts';
const CANONICAL_AST_FINGERPRINT_ALGORITHM = 'typescript-printer-remove-comments-sha256-v1';
type ApprovedCompatibilityCallShape =
  | 'persisted-delivery-validator'
  | 'persistable-delivery-claims'
  | 'delivery-context-report-claims'
  | 'closeout-smoke-delivery-claims';
const approvedLegacyDeliveryCompatUsages = new Map<string, {
  symbols: readonly string[];
  calls: Readonly<Record<string, readonly ApprovedCompatibilityCallShape[]>>;
  occurrences: Readonly<Record<string, number>>;
}>([
  ['packages/main/src/core/closeout-trust.ts', {
    symbols: ['isExactLegacyLocalOnlyDeliveryClaims', 'LegacyLocalOnlyDeliveryClaims'],
    calls: { isExactLegacyLocalOnlyDeliveryClaims: ['persisted-delivery-validator'] },
    occurrences: { isExactLegacyLocalOnlyDeliveryClaims: 2, LegacyLocalOnlyDeliveryClaims: 2 },
  }],
  ['packages/main/src/handlers/delivery-context-pack.ts', {
    symbols: ['createLegacyLocalOnlyDeliveryClaims', 'LegacyLocalOnlyDeliveryClaims'],
    calls: { createLegacyLocalOnlyDeliveryClaims: ['persistable-delivery-claims', 'delivery-context-report-claims'] },
    occurrences: { createLegacyLocalOnlyDeliveryClaims: 3, LegacyLocalOnlyDeliveryClaims: 3 },
  }],
  ['packages/main/src/tasks/closeout-trust-smoke.ts', {
    symbols: ['createLegacyLocalOnlyDeliveryClaims'],
    calls: { createLegacyLocalOnlyDeliveryClaims: ['closeout-smoke-delivery-claims'] },
    occurrences: { createLegacyLocalOnlyDeliveryClaims: 2 },
  }],
]);

const PINNED_EXECUTABLE_SOURCE_FINGERPRINTS = new Map<string, string>([
  [LEGACY_DELIVERY_COMPAT_MODULE, 'b2c006a5becbd456a5728bb7615cf999cb514137383bc935b128073240899d98'],
  ['packages/main/src/core/closeout-trust.ts', 'ccd079414da1e7aabbbc9afcd96a25ef37ae72d50d6817c340b37f152f711b06'],
  ['packages/main/src/handlers/delivery-context-pack.ts', '2b3dfbe3073c3a8e2fa7e1c8bf93c84ec34ad63b56ed8cb59edce1aa563719d3'],
  ['packages/main/src/tasks/closeout-trust-smoke.ts', 'd252c161562e00797371438a52f16c889e10a0551673e24b62162978b7447c3e'],
  ['packages/main/src/cli-engine.ts', '878828adf7881dc809bfca0e6e4daa506053fb6565aa1ec69c99626fef64f16a'],
  ['packages/main/src/verifier/serve.ts', '20149fa438b1ec78fc9c9713eb3cc4a890bc58a1d82e7a5fa0d588e9c4e7ee91'],
  ['packages/main/src/tasks/parent-roadmap-totality-smoke.ts', '518890b58fd8e369488721d66d954f9589a049a42066635f42c057227788ae45'],
  ['packages/main/src/tasks/experience-layer-digest-extract-smoke.ts', 'f215f9c4e894a84ba7e2e844324902fcd2dec1e208e4259d64e2c447f1c85a83'],
]);

const DYNAMIC_CODE_GENERATION_FINGERPRINT_EXEMPTIONS = new Map<string, string>([
  ['packages/main/src/verifier/browser-client.ts', '48f529b542edbb79c796a5ef6ab51dad8e5e13cc2e3416e76f6bae74104d5527'],
  ['packages/main/src/handlers/decision-doc-quorum.ts', '6025f602afdc354a31333b61b516cb29aa1b59387806d69e6981d5a9ed3969b7'],
  ['packages/main/src/tasks/browser-client.ts', '4b92b436fb13a06cf2dfd2079c6b0dec787ef8807cd54f8b6db24c1002a0e61a'],
  ['packages/main/src/handlers/fixture-executors.ts', 'acaa12e34e6e9b3304d176b9cbb65d9edfcdfa3ec9fc7db57a14d83411f026c7'],
]);

const structuralLegacyFieldQuarantineFiles = new Set([
  'packages/main/src/cli/command-catalog.ts',
  'packages/main/src/core/autopilot.ts',
  'packages/main/src/core/autopilot-executor.ts',
  'packages/main/src/core/autopilot-policy.ts',
  'packages/main/src/core/canonical-story.ts',
  'packages/main/src/core/capabilities.ts',
  'packages/main/src/core/command-policy.ts',
  'packages/main/src/core/dispatch-policy.ts',
  'packages/main/src/core/dispatch-runner.ts',
  'packages/main/src/core/lattice-autopilot.ts',
  'packages/main/src/core/lattice-dispatch.ts',
  'packages/main/src/core/lattice-evidence.ts',
  'packages/main/src/core/lattice-handoff.ts',
  'packages/main/src/core/lattice-hosts.ts',
  'packages/main/src/core/lattice-parallel-wave.ts',
  'packages/main/src/core/lifecycle-readiness.ts',
  'packages/main/src/core/planned-steps-executor.ts',
  'packages/main/src/core/proof-admissibility.ts',
  'packages/main/src/core/proof-admissibility-handoff.ts',
  'packages/main/src/core/proof-admissibility-legacy.ts',
  'packages/main/src/core/proof-admissibility-metadata.ts',
  'packages/main/src/core/repair-retry-loop.ts',
  'packages/main/src/core/review-assurance-floor.ts',
  'packages/main/src/core/review-escalation.ts',
  'packages/main/src/core/usage-ledger/assemble.ts',
  'packages/main/src/core/usage-ledger/authority-evidence.ts',
  'packages/main/src/core/usage-ledger/dispatch-usage.ts',
  'packages/main/src/core/usage-ledger/estimate.ts',
  'packages/main/src/core/usage-ledger/record.ts',
  'packages/main/src/handlers/autopilot.ts',
  'packages/main/src/handlers/baseline.ts',
  'packages/main/src/handlers/delivery-context-pack.ts',
  'packages/main/src/handlers/evidence-plan.ts',
  'packages/main/src/handlers/evidence-refresh.ts',
  'packages/main/src/handlers/init-preflight.ts',
  'packages/main/src/handlers/lattice-autopilot.ts',
  'packages/main/src/handlers/lattice-cli.ts',
  'packages/main/src/handlers/lifecycle-control.ts',
  'packages/main/src/handlers/lifecycle-orchestrate.ts',
  'packages/main/src/handlers/live-smoke-transcript.ts',
  'packages/main/src/handlers/plan-skeleton.ts',
  'packages/main/src/handlers/planner.ts',
  'packages/main/src/handlers/quorum-submit.ts',
  'packages/main/src/handlers/review-escalation.ts',
  'packages/main/src/handlers/reviewer-batch.ts',
  'packages/main/src/tasks/proof-admissibility-hardening-smoke.ts',
]);

const legacyFieldNames = [
  'authorityDone',
  'fullAuthorityDone',
  'productionDone',
  'receiptVerified',
  'authorityChanged',
  'productionDoneEligible',
  'productionDoneProviders',
] as const;

const legacyFieldAlternation = legacyFieldNames.join('|');
const renderedLegacyFieldPattern = new RegExp(String.raw`['"\`][^'"\`]*\b(?:${legacyFieldAlternation})\s*:`);
const quotedLegacyFieldLinePattern = new RegExp(String.raw`^\s*['"\`](?:${legacyFieldAlternation})['"\`],?\s*$`);
const bareLegacyFieldLinePattern = new RegExp(String.raw`^\s*(?:${legacyFieldAlternation}),?\s*$`);
const fieldShapePattern = new RegExp(String.raw`\b(?:${legacyFieldAlternation})\??\s*:`);
const propertyDeclarationPattern = new RegExp(String.raw`^\s*(?:readonly\s+)?(?:${legacyFieldAlternation})\??\s*:`);
const propertyAssignmentPattern = new RegExp(String.raw`^\s*(?:const|let|var)?\s*(?:${legacyFieldAlternation})\b\s*=`);
const objectMemberPattern = new RegExp(String.raw`\b(?:args|result|record|report|summary|authority|input|policy|policyRecord|value)\.(?:${legacyFieldAlternation})\b`);
const bracketMemberPattern = new RegExp(String.raw`\[['"\`](?:${legacyFieldAlternation})['"\`]\]`);
const callArgumentPattern = new RegExp(String.raw`\b(?:productionDone|authorityDone|fullAuthorityDone)\b[),]`);

function fileIsExplicitLegacyQuarantine(file: string): boolean {
  return legacyQuarantineFiles.has(file) || explicitLegacyTaskQuarantineFiles.has(file);
}

function lineIsStructuralLegacyFieldQuarantine(file: string, line: string): boolean {
  if (!structuralLegacyFieldQuarantineFiles.has(file)) return false;
  if (renderedLegacyFieldPattern.test(line)) return false;
  return quotedLegacyFieldLinePattern.test(line)
    || bareLegacyFieldLinePattern.test(line)
    || fieldShapePattern.test(line)
    || propertyDeclarationPattern.test(line)
    || propertyAssignmentPattern.test(line)
    || objectMemberPattern.test(line)
    || bracketMemberPattern.test(line)
    || callArgumentPattern.test(line);
}

function readRel(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

function listFilesFromRoot(
  scanRoot: string,
  dir: string,
  extensions: readonly string[],
  visitedDirectories = new Set<string>(),
): string[] {
  const abs = resolve(scanRoot, dir);
  const relDir = relative(scanRoot, abs).replace(/\\/g, '/');
  if (relDir === '..' || relDir.startsWith('../') || !existsSync(abs)) return [];
  const rootStat = lstatSync(abs);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return [];
  const directoryKey = relDir || '.';
  if (visitedDirectories.has(directoryKey)) return [];
  visitedDirectories.add(directoryKey);
  const found: string[] = [];
  for (const entry of readdirSync(abs).sort()) {
    const full = join(abs, entry);
    const rel = relative(scanRoot, full).replace(/\\/g, '/');
    if (rel.split('/').includes('.omx')) continue;
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      found.push(...listFilesFromRoot(scanRoot, rel, extensions, visitedDirectories));
    } else if (extensions.some(ext => entry.endsWith(ext))) {
      found.push(rel);
    }
  }
  return found;
}

function listFiles(dir: string, extensions: readonly string[]): string[] {
  return listFilesFromRoot(repoRoot, dir, extensions);
}

function lineIsQuarantined(file: string, line: string): boolean {
  if (file === '<positive-control>') return false;
  if (fileIsExplicitLegacyQuarantine(file)) return true;
  if (line.includes('@help-hidden')) return true;
  if (line.includes('HIDDEN_LOCAL_ASSURANCE_REFUSAL')) return true;
  if (/legacy .*compatibility|retired compatibility|legacy quarantine|legacy retired|retired .*alias/i.test(line)) return true;
  if (file.includes('/dist/')) return true;
  if (/^\s*\*.*(?:legacy|retired|compatibility|quarantine)/i.test(line)) return true;
  if (/\brejected\.push\(['"`](authorityDone|fullAuthorityDone|productionDone)=true['"`]\)/.test(line)) return true;
  if (lineIsStructuralLegacyFieldQuarantine(file, line)) return true;
  return false;
}

function lineNumberAt(text: string, index: number): number {
  return text.slice(0, index).split(/\r?\n/).length;
}

type ModuleReferenceKind = 'import' | 'export' | 'dynamic-import' | 'require';

interface ModuleReference {
  specifier: string;
  index: number;
  kind: ModuleReferenceKind;
}

const parsedSourceCache = new Map<string, { text: string; source: ts.SourceFile }>();

interface SourceTypeAnalysis {
  program: ts.Program;
  source: ts.SourceFile;
  checker: ts.TypeChecker;
}

const TYPE_RESOLUTION_DIAGNOSTIC_CODES = new Set([2307, 2688, 2792, 7016]);
let sharedProjectTypeAnalysis: { program: ts.Program; roots: readonly string[] } | undefined;
const syntheticTypeFiles = new Map<string, { text: string; version: number }>();
let syntheticTypeLanguageService: ts.LanguageService | undefined;

function parseSource(file: string, text: string): ts.SourceFile {
  const cached = parsedSourceCache.get(file);
  if (cached?.text === text) return cached.source;
  const scriptKind = file.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : file.endsWith('.jsx')
      ? ts.ScriptKind.JSX
      : /\.(?:js|mjs|cjs)$/.test(file)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind);
  parsedSourceCache.set(file, { text, source });
  return source;
}

function canonicalAstFingerprint(file: string, text: string): string {
  const canonical = ts.createPrinter({
    removeComments: true,
    newLine: ts.NewLineKind.LineFeed,
  }).printFile(parseSource(file, text));
  return createHash('sha256').update(canonical).digest('hex');
}

function validatePinnedExecutableSourceFingerprint(
  file: string,
  text: string,
  checkedPinnedPaths?: Map<string, number>,
): Violation[] {
  const expected = PINNED_EXECUTABLE_SOURCE_FINGERPRINTS.get(file);
  if (!expected) return [];
  if (checkedPinnedPaths) checkedPinnedPaths.set(file, (checkedPinnedPaths.get(file) ?? 0) + 1);
  const actual = canonicalAstFingerprint(file, text);
  return actual === expected ? [] : [{
    file,
    line: 1,
    label: 'pinned executable source structural fingerprint drift',
    text: `${CANONICAL_AST_FINGERPRINT_ALGORITHM}: expected ${expected}, got ${actual}; review executable structure before updating the pinned fingerprint`,
  }];
}

function projectTypeProgramRoots(): string[] {
  const configPath = join(repoRoot, 'packages/main/tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error, undefined, `project type program must parse ${configPath}`);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath), undefined, configPath);
  assert.equal(parsed.errors.length, 0, `project type program config diagnostics: ${parsed.errors.map(error => error.code).join(',')}`);
  return [...new Set([
    ...parsed.fileNames,
    ...SHIPPED_EXECUTABLE_SOURCE_DIRS.flatMap(dir => listFiles(dir, EXECUTABLE_SOURCE_EXTENSIONS).map(file => join(repoRoot, file))),
    ...SHIPPED_EXECUTABLE_ENTRYPOINTS.map(file => join(repoRoot, file)),
  ].map(file => resolve(file)).filter(existsSync))].sort();
}

function projectTypeProgramOptions(): ts.CompilerOptions {
  const configPath = join(repoRoot, 'packages/main/tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath), undefined, configPath);
  const options: ts.CompilerOptions = {
    ...parsed.options,
    allowJs: true,
    checkJs: true,
    noEmit: true,
  };
  delete options.rootDir;
  delete options.outDir;
  return options;
}

function createProjectTypeProgram(
  overlays: ReadonlyMap<string, string> = new Map(),
  includeProjectRoots = true,
  oldProgram?: ts.Program,
): ts.Program {
  const normalizedOverlays = new Map(
    [...overlays].map(([file, text]) => [resolve(repoRoot, file), text] as const),
  );
  const options = projectTypeProgramOptions();
  const host = ts.createCompilerHost(options, true);
  const defaultGetSourceFile = host.getSourceFile.bind(host);
  const defaultFileExists = host.fileExists.bind(host);
  const defaultReadFile = host.readFile.bind(host);
  host.getCurrentDirectory = () => repoRoot;
  host.fileExists = file => normalizedOverlays.has(resolve(file)) || defaultFileExists(file);
  host.readFile = file => normalizedOverlays.get(resolve(file)) ?? defaultReadFile(file);
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => {
    const overlay = normalizedOverlays.get(resolve(file));
    if (overlay === undefined) return defaultGetSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile);
    const scriptKind = file.endsWith('.tsx')
      ? ts.ScriptKind.TSX
      : file.endsWith('.jsx')
        ? ts.ScriptKind.JSX
        : /\.(?:js|mjs|cjs)$/.test(file)
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS;
    return ts.createSourceFile(file, overlay, languageVersion, true, scriptKind);
  };
  return ts.createProgram({
    rootNames: [...new Set([...(includeProjectRoots ? projectTypeProgramRoots() : []), ...normalizedOverlays.keys()])],
    options,
    host,
    oldProgram,
  });
}

function sharedProjectProgram(): ts.Program {
  if (!sharedProjectTypeAnalysis) {
    const roots = projectTypeProgramRoots();
    sharedProjectTypeAnalysis = { program: createProjectTypeProgram(), roots };
  }
  return sharedProjectTypeAnalysis.program;
}

function syntheticTypeService(): ts.LanguageService {
  if (syntheticTypeLanguageService) return syntheticTypeLanguageService;
  const options = projectTypeProgramOptions();
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => [...syntheticTypeFiles.keys()],
    getScriptVersion: file => String(syntheticTypeFiles.get(resolve(file))?.version ?? 0),
    getScriptSnapshot: file => {
      const overlay = syntheticTypeFiles.get(resolve(file));
      if (overlay) return ts.ScriptSnapshot.fromString(overlay.text);
      const text = ts.sys.readFile(file);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => repoRoot,
    getDefaultLibFileName: compilerOptions => ts.getDefaultLibFilePath(compilerOptions),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getNewLine: () => ts.sys.newLine,
  };
  syntheticTypeLanguageService = ts.createLanguageService(host, ts.createDocumentRegistry());
  return syntheticTypeLanguageService;
}

function syntheticTypeAnalysisFor(file: string, text: string): SourceTypeAnalysis {
  const absoluteFile = resolve(repoRoot, file);
  const current = syntheticTypeFiles.get(absoluteFile);
  if (!current || current.text !== text) {
    syntheticTypeFiles.set(absoluteFile, { text, version: (current?.version ?? 0) + 1 });
  }
  const program = syntheticTypeService().getProgram();
  const source = program?.getSourceFile(absoluteFile);
  assert(program && source, `synthetic type program root missing: ${file}`);
  return { program, source, checker: program.getTypeChecker() };
}

function typeAnalysisFor(file: string, text: string, program?: ts.Program): SourceTypeAnalysis {
  const absoluteFile = resolve(repoRoot, file);
  const shared = program ?? sharedProjectProgram();
  let source = shared.getSourceFile(absoluteFile);
  let selectedProgram = shared;
  if (!source || source.text !== text) {
    if (!program) return syntheticTypeAnalysisFor(file, text);
    selectedProgram = createProjectTypeProgram(new Map([[file, text]]), false, shared);
    source = selectedProgram.getSourceFile(absoluteFile);
  }
  assert(source, `project type program root missing: ${file}`);
  return { program: selectedProgram, source, checker: selectedProgram.getTypeChecker() };
}

function typeAnalysisViolations(file: string, analysis: SourceTypeAnalysis): Violation[] {
  const diagnostics = [
    ...analysis.program.getSyntacticDiagnostics(analysis.source),
    ...analysis.program.getSemanticDiagnostics(analysis.source)
      .filter(diagnostic => TYPE_RESOLUTION_DIAGNOSTIC_CODES.has(diagnostic.code)),
  ];
  return diagnostics.map(diagnostic => ({
    file,
    line: diagnostic.start === undefined ? 1 : analysis.source.getLineAndCharacterOfPosition(diagnostic.start).line + 1,
    label: 'malformed or unresolved executable type analysis',
    text: `TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`,
  }));
}

function assertProjectTypeProgramContract(executableFiles: readonly string[]): void {
  const program = sharedProjectProgram();
  const roots = new Set(program.getRootFileNames().map(file => resolve(file)));
  for (const file of executableFiles.filter(isExecutableSourceFile)) {
    const absolute = resolve(repoRoot, file);
    assert.ok(roots.has(absolute), `project type program root inventory must include ${file}`);
    assert.ok(program.getSourceFile(absolute), `project type program must resolve source ${file}`);
  }
  assert.ok(
    program.getSourceFiles().some(source => source.isDeclarationFile && /lib\.(?:es|d)/.test(source.fileName)),
    'project type program must load TypeScript default libraries',
  );
  assert.notEqual(program.getCompilerOptions().noResolve, true, 'project type program must enable module resolution');
  assert.equal(program.getCompilerOptions().moduleResolution, ts.ModuleResolutionKind.Node16, 'project type program must preserve packages/main Node16 module resolution');
}

function staticModuleText(
  node: ts.Expression,
  checker?: ts.TypeChecker,
  constStrings?: ReadonlyMap<ts.Symbol, string>,
): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node) && checker && constStrings) {
    const symbol = checker.getSymbolAtLocation(node);
    return symbol ? constStrings.get(symbol) : undefined;
  }
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) {
    return staticModuleText(node.expression, checker, constStrings);
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticModuleText(node.left, checker, constStrings);
    const right = staticModuleText(node.right, checker, constStrings);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (ts.isTemplateExpression(node)) {
    let result = node.head.text;
    for (const span of node.templateSpans) {
      const value = staticModuleText(span.expression, checker, constStrings);
      if (value === undefined) return undefined;
      result += value + span.literal.text;
    }
    return result;
  }
  return undefined;
}

function collectConstStringValues(source: ts.SourceFile, checker: ts.TypeChecker): Map<ts.Symbol, string> {
  const declarations: Array<{ symbol: ts.Symbol; initializer: ts.Expression }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && ts.isVariableDeclarationList(node.parent)
      && (node.parent.flags & ts.NodeFlags.Const) !== 0) {
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol) declarations.push({ symbol, initializer: node.initializer });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const values = new Map<ts.Symbol, string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (values.has(declaration.symbol)) continue;
      const value = staticModuleText(declaration.initializer, checker, values);
      if (value !== undefined) {
        values.set(declaration.symbol, value);
        changed = true;
      }
    }
  }
  return values;
}

function containingImportDeclaration(specifier: ts.ImportSpecifier): ts.ImportDeclaration | undefined {
  const namedImports = specifier.parent;
  const importClause = namedImports.parent;
  return ts.isImportClause(importClause) && ts.isImportDeclaration(importClause.parent)
    ? importClause.parent
    : undefined;
}

function bindingNameContains(name: ts.BindingName, expected: string): boolean {
  if (ts.isIdentifier(name)) return name.text === expected;
  return name.elements.some(element => ts.isBindingElement(element) && bindingNameContains(element.name, expected));
}

function lexicalScopeDeclaresName(scope: ts.Node, expected: string): boolean {
  if (ts.isFunctionLike(scope)) {
    if (scope.parameters.some(parameter => bindingNameContains(parameter.name, expected))) return true;
    if ('name' in scope && scope.name && ts.isIdentifier(scope.name) && scope.name.text === expected) return true;
  }
  if (ts.isCatchClause(scope) && scope.variableDeclaration && bindingNameContains(scope.variableDeclaration.name, expected)) return true;
  const statements = ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope) ? scope.statements : undefined;
  if (!statements) return false;
  return statements.some(statement => {
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.some(declaration => bindingNameContains(declaration.name, expected));
    }
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === expected) return true;
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.name?.text === expected) return true;
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) return bindings.name.text === expected;
      if (bindings && ts.isNamedImports(bindings)) return bindings.elements.some(element => element.name.text === expected);
    }
    return false;
  });
}

function hasLexicalShadow(node: ts.Identifier, expected: string): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (lexicalScopeDeclaresName(current, expected)) return true;
    current = current.parent;
  }
  return false;
}

function isGlobalIdentifier(node: ts.Identifier, checker: ts.TypeChecker, name: string): boolean {
  if (node.text !== name) return false;
  void checker;
  return !hasLexicalShadow(node, name);
}

function isModuleRequireExpression(node: ts.Expression, checker: ts.TypeChecker): boolean {
  return ts.isPropertyAccessExpression(node)
    && node.name.text === 'require'
    && ts.isIdentifier(node.expression)
    && isGlobalIdentifier(node.expression, checker, 'module');
}

function collectLoaderBindings(source: ts.SourceFile, checker: ts.TypeChecker): {
  loaderSymbols: Set<ts.Symbol>;
  createRequireSymbols: Set<ts.Symbol>;
  moduleNamespaceSymbols: Set<ts.Symbol>;
} {
  const loaderSymbols = new Set<ts.Symbol>();
  const createRequireSymbols = new Set<ts.Symbol>();
  const moduleNamespaceSymbols = new Set<ts.Symbol>();
  const variableDeclarations: Array<{ symbol: ts.Symbol; initializer: ts.Expression }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node)) {
      const imported = (node.propertyName ?? node.name).text;
      const declaration = containingImportDeclaration(node);
      const moduleName = declaration && ts.isStringLiteral(declaration.moduleSpecifier)
        ? declaration.moduleSpecifier.text
        : undefined;
      if (imported === 'createRequire' && (moduleName === 'node:module' || moduleName === 'module')) {
        const symbol = checker.getSymbolAtLocation(node.name);
        if (symbol) createRequireSymbols.add(symbol);
      }
    }
    if (ts.isNamespaceImport(node)
      && ts.isImportClause(node.parent)
      && ts.isImportDeclaration(node.parent.parent)
      && ts.isStringLiteral(node.parent.parent.moduleSpecifier)
      && (node.parent.parent.moduleSpecifier.text === 'node:module' || node.parent.parent.moduleSpecifier.text === 'module')) {
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol) moduleNamespaceSymbols.add(symbol);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol) variableDeclarations.push({ symbol, initializer: node.initializer });
    }
    if (ts.isVariableDeclaration(node)
      && ts.isObjectBindingPattern(node.name)
      && node.initializer
      && ts.isCallExpression(node.initializer)
      && ts.isIdentifier(node.initializer.expression)
      && isGlobalIdentifier(node.initializer.expression, checker, 'require')
      && node.initializer.arguments.length === 1
      && ts.isStringLiteral(node.initializer.arguments[0])
      && (node.initializer.arguments[0].text === 'node:module' || node.initializer.arguments[0].text === 'module')) {
      for (const element of node.name.elements) {
        const imported = element.propertyName && ts.isIdentifier(element.propertyName)
          ? element.propertyName.text
          : ts.isIdentifier(element.name) ? element.name.text : undefined;
        if (imported !== 'createRequire' || !ts.isIdentifier(element.name)) continue;
        const symbol = checker.getSymbolAtLocation(element.name);
        if (symbol) createRequireSymbols.add(symbol);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const resolvesTo = (node: ts.Identifier, symbols: ReadonlySet<ts.Symbol>): boolean => {
    const symbol = checker.getSymbolAtLocation(node);
    return Boolean(symbol && symbols.has(symbol));
  };
  const isCreateRequireFactory = (node: ts.Expression): boolean => {
    if (ts.isIdentifier(node)) return resolvesTo(node, createRequireSymbols);
    if (!ts.isPropertyAccessExpression(node) || node.name.text !== 'createRequire' || !ts.isIdentifier(node.expression)) return false;
    const namespace = checker.getSymbolAtLocation(node.expression);
    return Boolean(namespace && moduleNamespaceSymbols.has(namespace));
  };
  const isRequireCallable = (node: ts.Expression): boolean => {
    if (ts.isIdentifier(node)) {
      return isGlobalIdentifier(node, checker, 'require') || resolvesTo(node, loaderSymbols);
    }
    return isModuleRequireExpression(node, checker);
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of variableDeclarations) {
      const initializer = declaration.initializer;
      if (!createRequireSymbols.has(declaration.symbol)
        && ts.isIdentifier(initializer)
        && resolvesTo(initializer, createRequireSymbols)) {
        createRequireSymbols.add(declaration.symbol);
        changed = true;
      }
      const isBoundRequire = ts.isCallExpression(initializer)
        && ts.isPropertyAccessExpression(initializer.expression)
        && initializer.expression.name.text === 'bind'
        && isRequireCallable(initializer.expression.expression);
      const isRequireValue = isRequireCallable(initializer)
        || isBoundRequire
        || (ts.isCallExpression(initializer)
          && isCreateRequireFactory(initializer.expression));
      if (isRequireValue && !loaderSymbols.has(declaration.symbol)) {
        loaderSymbols.add(declaration.symbol);
        changed = true;
      }
    }
  }
  return { loaderSymbols, createRequireSymbols, moduleNamespaceSymbols };
}

function loaderCallKind(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
  bindings: ReturnType<typeof collectLoaderBindings>,
): ModuleReferenceKind | undefined {
  if (call.expression.kind === ts.SyntaxKind.ImportKeyword) return 'dynamic-import';
  if (ts.isIdentifier(call.expression)) {
    if (isGlobalIdentifier(call.expression, checker, 'require')) return 'require';
    const symbol = checker.getSymbolAtLocation(call.expression);
    if (symbol && bindings.loaderSymbols.has(symbol)) return 'require';
  }
  if (isModuleRequireExpression(call.expression, checker)) return 'require';
  if (ts.isCallExpression(call.expression)
    && (ts.isIdentifier(call.expression.expression) || ts.isPropertyAccessExpression(call.expression.expression))) {
    const factoryExpression = call.expression.expression;
    if (ts.isIdentifier(factoryExpression)) {
      const factory = checker.getSymbolAtLocation(factoryExpression);
      if (factory && bindings.createRequireSymbols.has(factory)) return 'require';
    } else if (factoryExpression.name.text === 'createRequire' && ts.isIdentifier(factoryExpression.expression)) {
      const namespace = checker.getSymbolAtLocation(factoryExpression.expression);
      if (namespace && bindings.moduleNamespaceSymbols.has(namespace)) return 'require';
    }
  }
  return undefined;
}

function extractImportSpecifiers(text: string, file = '<module-scan>.ts'): ModuleReference[] {
  const { source, checker } = typeAnalysisFor(file, text);
  const constStrings = collectConstStringValues(source, checker);
  const loaderBindings = collectLoaderBindings(source, checker);
  const specifiers: ModuleReference[] = [];
  const add = (node: ts.Expression, kind: ModuleReferenceKind): void => {
    const specifier = staticModuleText(node, checker, constStrings);
    if (specifier !== undefined) specifiers.push({ specifier, index: node.getStart(source), kind });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) add(node.moduleSpecifier, 'import');
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier) add(node.moduleSpecifier, 'export');
    else if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression) add(node.moduleReference.expression, 'require');
    else if (ts.isCallExpression(node) && node.arguments.length >= 1) {
      const kind = loaderCallKind(node, checker, loaderBindings);
      if (kind) add(node.arguments[0], kind);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

function normalizeModulePath(path: string): string {
  for (const extension of EXECUTABLE_SOURCE_EXTENSIONS) {
    if (path.endsWith(extension)) return path.slice(0, -extension.length);
  }
  return path;
}

function normalizeStaticModuleSpecifier(specifier: string): string | undefined {
  const queryIndex = specifier.indexOf('?');
  const fragmentIndex = specifier.indexOf('#', specifier.startsWith('#') ? 1 : 0);
  const suffixIndexes = [queryIndex, fragmentIndex].filter(index => index >= 0);
  const suffixIndex = suffixIndexes.length > 0 ? Math.min(...suffixIndexes) : -1;
  const withoutSuffix = suffixIndex === -1 ? specifier : specifier.slice(0, suffixIndex);
  try {
    const decoded = decodeURIComponent(withoutSuffix);
    return decoded.includes('\0') ? undefined : decoded;
  } catch {
    return undefined;
  }
}

function resolvedStaticModulePaths(
  file: string,
  specifier: string,
  aliasEdges: readonly PackageAliasEdge[] = PACKAGE_ALIAS_EDGE_INVENTORY,
): StaticModuleResolution {
  const normalizedSpecifier = normalizeStaticModuleSpecifier(specifier);
  if (normalizedSpecifier === undefined) return { targets: [], error: `malformed encoded static module specifier: ${specifier}` };
  if (normalizedSpecifier.startsWith('.')) {
    return { targets: [normalizeModulePath(join(dirname(file), normalizedSpecifier).replace(/\\/g, '/'))] };
  }
  return resolvePackageAlias(file, normalizedSpecifier, aliasEdges);
}

function retiredModuleMatch(file: string, specifier: string): string | undefined {
  const normalizedSpecifier = normalizeStaticModuleSpecifier(specifier);
  if (normalizedSpecifier === undefined) return 'malformed encoded static module specifier';
  if (/\bstory-authority-resolv(?:e|er)\b/.test(normalizedSpecifier)) return 'retired story resolver module';
  const resolution = resolvedStaticModulePaths(file, normalizedSpecifier);
  if (resolution.error) return 'unresolved package import/self-reference alias';
  for (const retiredFile of retiredServerBackedModuleFiles) {
    if (resolution.targets.includes(normalizeModulePath(retiredFile))) return 'retired quarantined module specifier';
  }
  return undefined;
}

function moduleSpecifierResolvesTo(
  file: string,
  specifier: string,
  targetFile: string,
  aliasEdges: readonly PackageAliasEdge[] = PACKAGE_ALIAS_EDGE_INVENTORY,
): boolean {
  const resolution = resolvedStaticModulePaths(file, specifier, aliasEdges);
  return resolution.targets.includes(normalizeModulePath(targetFile));
}

interface CompatibilityImportBinding {
  importedName: string;
  localName: string;
  declaration: ts.ImportSpecifier;
}

function compatibilityImportBindings(
  file: string,
  source: ts.SourceFile,
  aliasEdges: readonly PackageAliasEdge[] = PACKAGE_ALIAS_EDGE_INVENTORY,
): Map<string, CompatibilityImportBinding> {
  const bindings = new Map<string, CompatibilityImportBinding>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || !moduleSpecifierResolvesTo(file, statement.moduleSpecifier.text, LEGACY_DELIVERY_COMPAT_MODULE, aliasEdges)) continue;
    const namedBindings = statement.importClause?.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) continue;
    for (const element of namedBindings.elements) {
      const importedName = (element.propertyName ?? element.name).text;
      bindings.set(importedName, { importedName, localName: element.name.text, declaration: element });
    }
  }
  return bindings;
}

function identifierResolvesToBinding(
  node: ts.Identifier,
  binding: CompatibilityImportBinding,
  checker: ts.TypeChecker,
): boolean {
  if (ts.isExportSpecifier(node.parent)) {
    const localTarget = checker.getExportSpecifierLocalTargetSymbol(node.parent);
    if (localTarget?.declarations?.includes(binding.declaration)) return true;
  }
  const symbol = checker.getSymbolAtLocation(node);
  return Boolean(symbol?.declarations?.includes(binding.declaration));
}

function bindingReferences(source: ts.SourceFile, binding: CompatibilityImportBinding, checker: ts.TypeChecker): ts.Identifier[] {
  const references: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && identifierResolvesToBinding(node, binding, checker)) references.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return references;
}

function identifierName(node: ts.BindingName | ts.DeclarationName | undefined, expected: string): boolean {
  return Boolean(node && ts.isIdentifier(node) && node.text === expected);
}

function claimsPropertyForCall(call: ts.CallExpression): ts.PropertyAssignment | undefined {
  const property = call.parent;
  return ts.isPropertyAssignment(property)
    && property.initializer === call
    && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    && property.name.text === 'claims'
    ? property
    : undefined;
}

function approvedCompatibilityCallShape(call: ts.CallExpression): ApprovedCompatibilityCallShape | undefined {
  if (call.arguments.length === 1
    && ts.isIdentifier(call.arguments[0])
    && call.arguments[0].text === 'claims'
    && ts.isPrefixUnaryExpression(call.parent)
    && call.parent.operator === ts.SyntaxKind.ExclamationToken
    && ts.isIfStatement(call.parent.parent)
    && call.parent.parent.expression === call.parent
    && ts.isBlock(call.parent.parent.parent)
    && ts.isFunctionDeclaration(call.parent.parent.parent.parent)
    && identifierName(call.parent.parent.parent.parent.name, 'validatePersistedDeliveryContextPack')
    && ts.isSourceFile(call.parent.parent.parent.parent.parent)) {
    return 'persisted-delivery-validator';
  }

  if (call.arguments.length !== 0) return undefined;
  const property = claimsPropertyForCall(call);
  if (!property || !ts.isObjectLiteralExpression(property.parent)) return undefined;
  const object = property.parent;

  if (ts.isReturnStatement(object.parent)
    && object.parent.expression === object
    && ts.isBlock(object.parent.parent)
    && ts.isFunctionDeclaration(object.parent.parent.parent)
    && identifierName(object.parent.parent.parent.name, 'toPersistable')
    && ts.isSourceFile(object.parent.parent.parent.parent)) {
    return 'persistable-delivery-claims';
  }

  if (ts.isVariableDeclaration(object.parent)
    && object.parent.initializer === object
    && identifierName(object.parent.name, 'report')
    && ts.isVariableDeclarationList(object.parent.parent)
    && (object.parent.parent.flags & ts.NodeFlags.Const) !== 0
    && ts.isVariableStatement(object.parent.parent.parent)
    && ts.isBlock(object.parent.parent.parent.parent)
    && ts.isFunctionDeclaration(object.parent.parent.parent.parent.parent)
    && identifierName(object.parent.parent.parent.parent.parent.name, 'deliveryContextPack')
    && ts.isBlock(object.parent.parent.parent.parent.parent.parent)
    && ts.isFunctionDeclaration(object.parent.parent.parent.parent.parent.parent.parent)
    && identifierName(object.parent.parent.parent.parent.parent.parent.parent.name, 'createDeliveryContextPackHandlers')
    && ts.isSourceFile(object.parent.parent.parent.parent.parent.parent.parent.parent)) {
    return 'delivery-context-report-claims';
  }

  if (ts.isAsExpression(object.parent)
    && object.parent.expression === object
    && ts.isVariableDeclaration(object.parent.parent)
    && object.parent.parent.initializer === object.parent
    && identifierName(object.parent.parent.name, 'deliveryPack')
    && ts.isVariableDeclarationList(object.parent.parent.parent)
    && (object.parent.parent.parent.flags & ts.NodeFlags.Const) !== 0
    && ts.isVariableStatement(object.parent.parent.parent.parent)
    && ts.isSourceFile(object.parent.parent.parent.parent.parent)) {
    return 'closeout-smoke-delivery-claims';
  }
  return undefined;
}

function matchesApprovedCallSite(
  call: ts.CallExpression,
  approvedShapes: readonly ApprovedCompatibilityCallShape[],
): boolean {
  const shape = approvedCompatibilityCallShape(call);
  return Boolean(shape && approvedShapes.includes(shape));
}

function isApprovedValueUse(
  node: ts.Identifier,
  approved: NonNullable<ReturnType<typeof approvedLegacyDeliveryCompatUsages.get>>,
  binding: CompatibilityImportBinding,
  checker: ts.TypeChecker,
): boolean {
  if (!identifierResolvesToBinding(node, binding, checker)) return false;
  if (node.parent === binding.declaration) return true;
  const approvedShapes = approved.calls[binding.importedName];
  return Boolean(approvedShapes
    && ts.isCallExpression(node.parent)
    && node.parent.expression === node
    && matchesApprovedCallSite(node.parent, approvedShapes));
}

function disallowedCompatibilityValueReferences(
  source: ts.SourceFile,
  approved: NonNullable<ReturnType<typeof approvedLegacyDeliveryCompatUsages.get>>,
  file: string,
  checker: ts.TypeChecker,
  aliasEdges: readonly PackageAliasEdge[] = PACKAGE_ALIAS_EDGE_INVENTORY,
): ts.Identifier[] {
  const bindings = compatibilityImportBindings(file, source, aliasEdges);
  const disallowed: ts.Identifier[] = [];
  for (const symbol of Object.keys(approved.calls)) {
    const binding = bindings.get(symbol);
    if (!binding) continue;
    for (const reference of bindingReferences(source, binding, checker)) {
      if (!isApprovedValueUse(reference, approved, binding, checker)) disallowed.push(reference);
    }
  }
  return disallowed;
}

const knownBenignNonLiteralLoaderCalls = new Map<string, {
  calls: readonly { anchor: string; argument: string }[];
}>([
  ['packages/main/src/cli-engine.ts', {
    calls: [{ anchor: 'runCli', argument: '`file://${initPath}`' }],
  }],
  ['packages/main/src/verifier/serve.ts', {
    calls: [{ anchor: 'startCircuitServe', argument: '`file://${filePath}`' }],
  }],
  ['packages/main/src/tasks/parent-roadmap-totality-smoke.ts', {
    calls: [{ anchor: 'loadRuntime', argument: 'modulePath' }],
  }],
  ['packages/main/src/tasks/experience-layer-digest-extract-smoke.ts', {
    calls: [{ anchor: 'run', argument: "join(MAIN_DIR, 'dist', 'handlers', 'decision-doc-promotion.js')" }],
  }],
  ['bin/bootstrap-runner.js', {
    calls: [
      { anchor: 'runLocalBootstrap', argument: 'pathToFileURL(MAIN_DIST).href' },
      { anchor: 'runLocalBootstrap', argument: 'pathToFileURL(UTILS_DIST).href' },
      { anchor: 'runLocalBootstrap', argument: 'pathToFileURL(LAB_DIST).href' },
      { anchor: 'runLocalBootstrap', argument: "pathToFileURL(join(repoRoot, 'packages', 'main', 'dist', 'core', 'zod.js')).href" },
    ],
  }],
  ['bin/lattice-codex.js', {
    calls: [{ anchor: 'main', argument: 'pathToFileURL(localLattice).href' }],
  }],
]);

const BENIGN_NON_LITERAL_LOADER_SOURCE_FINGERPRINTS = new Map<string, string>([
  ['bin/bootstrap-runner.js', '63b01812c1d328eac4a470c6c92f7b140fde24e19c225252cc33917eb0ae87ca'],
  ['bin/lattice-codex.js', '9ad446b5d41be3ee62a7bde640289f55c4d1c5663a42b003f4abbd3a2ffaea57'],
]);

function enclosingFunctionName(node: ts.Node): string | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    current = current.parent;
  }
  return undefined;
}

function isKnownBenignNonLiteralLoaderCall(file: string, call: ts.CallExpression, source: ts.SourceFile): boolean {
  const approved = knownBenignNonLiteralLoaderCalls.get(file);
  const expectedFingerprint = PINNED_EXECUTABLE_SOURCE_FINGERPRINTS.get(file)
    ?? BENIGN_NON_LITERAL_LOADER_SOURCE_FINGERPRINTS.get(file);
  if (!approved || !expectedFingerprint || canonicalAstFingerprint(file, source.text) !== expectedFingerprint) return false;
  const anchor = enclosingFunctionName(call);
  const argument = call.arguments[0]?.getText(source);
  return Boolean(anchor && argument && approved.calls.some(entry => (
    entry.anchor === anchor && entry.argument === argument
  )));
}

function scanConcealedCompatibilityLoads(file: string, text: string): Violation[] {
  const { source, checker } = typeAnalysisFor(file, text);
  const constStrings = collectConstStringValues(source, checker);
  const loaderBindings = collectLoaderBindings(source, checker);
  const violations: Violation[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments.length >= 1) {
      const loaderKind = loaderCallKind(node, checker, loaderBindings);
      const kind = loaderKind === 'dynamic-import' ? 'import()' : loaderKind === 'require' ? 'require()' : undefined;
      if (kind
        && staticModuleText(node.arguments[0], checker, constStrings) === undefined
        && !isKnownBenignNonLiteralLoaderCall(file, node, source)) {
        violations.push({
          file,
          line: lineNumberAt(text, node.arguments[0].getStart(source)),
          label: 'unapproved non-literal dynamic module load',
          text: `${kind} ${node.arguments[0].getText(source)}; ${CANONICAL_AST_FINGERPRINT_ALGORITHM}=${canonicalAstFingerprint(file, text)}`,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

const DYNAMIC_VM_EXECUTION_MEMBERS = new Set([
  'runInThisContext',
  'runInNewContext',
  'runInContext',
  'compileFunction',
  'Script',
  'SourceTextModule',
  'SyntheticModule',
]);

interface DynamicExecutionBindings {
  dangerousSymbols: Map<ts.Symbol, string>;
  vmNamespaceSymbols: Set<ts.Symbol>;
  functionCallableSymbols: Map<ts.Symbol, string>;
}

interface DynamicAliasRecord {
  target: ts.Symbol;
  expression: ts.Expression;
}

interface DynamicDestructureRecord {
  target: ts.Symbol;
  property: string;
  source: ts.Expression;
}

function identifierSymbol(identifier: ts.Identifier, checker: ts.TypeChecker): ts.Symbol | undefined {
  return checker.getSymbolAtLocation(identifier);
}

function isGlobalObjectIdentifier(node: ts.Expression, checker: ts.TypeChecker): boolean {
  const current = unwrapExecutionExpression(node);
  return ts.isIdentifier(current)
    && (current.text === 'globalThis' || current.text === 'window')
    && isGlobalIdentifier(current, checker, current.text);
}

function isGlobalRequireCall(node: ts.Expression, checker: ts.TypeChecker): node is ts.CallExpression {
  const current = unwrapExecutionExpression(node);
  return ts.isCallExpression(current)
    && ts.isIdentifier(current.expression)
    && isGlobalIdentifier(current.expression, checker, 'require')
    && current.arguments.length === 1
    && ts.isStringLiteral(current.arguments[0])
    && (current.arguments[0].text === 'node:vm' || current.arguments[0].text === 'vm');
}

function functionExpressionConstructorKind(node: ts.Expression): string | undefined {
  const current = unwrapExecutionExpression(node);
  if (ts.isClassExpression(current)) return 'Function';
  if (!ts.isArrowFunction(current) && !ts.isFunctionExpression(current)) return undefined;
  const isAsync = current.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true;
  const isGenerator = ts.isFunctionExpression(current) && Boolean(current.asteriskToken);
  if (isAsync && isGenerator) return 'AsyncGeneratorFunction';
  if (isGenerator) return 'GeneratorFunction';
  if (isAsync) return 'AsyncFunction';
  return 'Function';
}

function functionDeclarationConstructorKind(node: ts.FunctionDeclaration | ts.ClassDeclaration): string {
  if (ts.isClassDeclaration(node)) return 'Function';
  const isAsync = node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true;
  const isGenerator = Boolean(node.asteriskToken);
  if (isAsync && isGenerator) return 'AsyncGeneratorFunction';
  if (isGenerator) return 'GeneratorFunction';
  if (isAsync) return 'AsyncFunction';
  return 'Function';
}

function functionPrototypeLookupKind(node: ts.Expression, checker: ts.TypeChecker): string | undefined {
  const current = unwrapExecutionExpression(node);
  if (!ts.isCallExpression(current)
    || current.arguments.length !== 1
    || !ts.isPropertyAccessExpression(current.expression)
    || current.expression.name.text !== 'getPrototypeOf') return undefined;
  const objectExpression = unwrapExecutionExpression(current.expression.expression);
  if (!ts.isIdentifier(objectExpression) || !isGlobalIdentifier(objectExpression, checker, 'Object')) return undefined;
  return functionExpressionConstructorKind(current.arguments[0]);
}

function typeHasCallableSignature(expression: ts.Expression, checker: ts.TypeChecker): boolean {
  const type = checker.getTypeAtLocation(unwrapExecutionExpression(expression));
  return checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0
    || checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length > 0;
}

function typeRequiresFailClosedCallableClassification(type: ts.Type, checker: ts.TypeChecker): boolean {
  if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0) return true;
  if (checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0
    || checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length > 0) return true;
  if (type.isUnionOrIntersection()) {
    return type.types.some(member => typeRequiresFailClosedCallableClassification(member, checker));
  }
  return false;
}

function expressionSymbol(expression: ts.Expression, checker: ts.TypeChecker): ts.Symbol | undefined {
  const current = unwrapExecutionExpression(expression);
  const symbol = ts.isPropertyAccessExpression(current)
    ? checker.getSymbolAtLocation(current.name)
    : ts.isElementAccessExpression(current) && current.argumentExpression
      ? checker.getSymbolAtLocation(current.argumentExpression)
      : checker.getSymbolAtLocation(current);
  if (!symbol || (symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
  return checker.getAliasedSymbol(symbol);
}

function hasExactLocalNonCallableEvidence(expression: ts.Expression, checker: ts.TypeChecker): boolean {
  const current = unwrapExecutionExpression(expression);
  if (ts.isObjectLiteralExpression(current)
    || ts.isArrayLiteralExpression(current)
    || ts.isStringLiteralLike(current)
    || ts.isNumericLiteral(current)
    || current.kind === ts.SyntaxKind.TrueKeyword
    || current.kind === ts.SyntaxKind.FalseKeyword) return true;
  const symbol = expressionSymbol(current, checker);
  if (!symbol) return false;
  const declarations = symbol.getDeclarations() ?? [];
  return declarations.length > 0 && declarations.every(declaration => {
    const source = declaration.getSourceFile();
    return !source.isDeclarationFile && resolve(source.fileName).startsWith(`${resolve(repoRoot)}/`);
  });
}

function constructorReceiverKind(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  bindings: DynamicExecutionBindings,
): string | undefined {
  const knownKind = staticallyCallableKind(expression, checker, bindings);
  if (knownKind) return knownKind;
  const type = checker.getTypeAtLocation(unwrapExecutionExpression(expression));
  if (typeRequiresFailClosedCallableClassification(type, checker)) return 'unresolved-or-callable';
  return hasExactLocalNonCallableEvidence(expression, checker) ? undefined : 'unresolved-or-ambient';
}

function staticallyCallableKind(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  bindings: DynamicExecutionBindings,
): string | undefined {
  const current = unwrapExecutionExpression(expression);
  const directKind = functionExpressionConstructorKind(current);
  if (directKind) return directKind;
  if (ts.isCallExpression(current)
    && ts.isPropertyAccessExpression(current.expression)
    && current.expression.name.text === 'bind') {
    return staticallyCallableKind(current.expression.expression, checker, bindings);
  }
  if (ts.isIdentifier(current)) {
    const symbol = identifierSymbol(current, checker);
    const knownKind = symbol ? bindings.functionCallableSymbols.get(symbol) : undefined;
    if (knownKind) return knownKind;
  }
  return typeHasCallableSignature(current, checker) ? 'Function' : undefined;
}

function dynamicReferenceKind(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  bindings: DynamicExecutionBindings,
): string | undefined {
  const current = unwrapExecutionExpression(expression);
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    return dynamicReferenceKind(current.right, checker, bindings);
  }
  if (ts.isCallExpression(current)
    && ts.isPropertyAccessExpression(current.expression)
    && current.expression.name.text === 'bind') {
    return dynamicReferenceKind(current.expression.expression, checker, bindings);
  }
  if (ts.isIdentifier(current)) {
    const symbol = identifierSymbol(current, checker);
    const boundKind = symbol ? bindings.dangerousSymbols.get(symbol) : undefined;
    if (boundKind) return boundKind;
    if ((current.text === 'eval' || current.text === 'Function') && isGlobalIdentifier(current, checker, current.text)) return current.text;
    return undefined;
  }
  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    const target = unwrapExecutionExpression(current.expression);
    const member = ts.isPropertyAccessExpression(current)
      ? current.name.text
      : current.argumentExpression ? staticModuleText(current.argumentExpression) : undefined;
    if (!member) return undefined;
    if (['call', 'apply', 'bind'].includes(member)) return dynamicReferenceKind(target, checker, bindings);
    if ((member === 'eval' || member === 'Function') && isGlobalObjectIdentifier(target, checker)) return member;
    if (member === 'constructor') {
      const directKind = functionPrototypeLookupKind(target, checker)
        ?? constructorReceiverKind(target, checker, bindings);
      if (directKind) return `${directKind}.constructor`;
      const inherited = dynamicReferenceKind(target, checker, bindings);
      if (inherited) return `${inherited}.constructor`;
      return undefined;
    }
    if (DYNAMIC_VM_EXECUTION_MEMBERS.has(member)) {
      if (isGlobalRequireCall(target, checker)) return `node:vm.${member}`;
      if (ts.isIdentifier(target)) {
        const targetSymbol = identifierSymbol(target, checker);
        if (targetSymbol && bindings.vmNamespaceSymbols.has(targetSymbol)) return `node:vm.${member}`;
      }
    }
  }
  return undefined;
}

function vmNamespaceReference(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  bindings: DynamicExecutionBindings,
): boolean {
  const current = unwrapExecutionExpression(expression);
  if (isGlobalRequireCall(current, checker)) return true;
  if (!ts.isIdentifier(current)) return false;
  const symbol = identifierSymbol(current, checker);
  return Boolean(symbol && bindings.vmNamespaceSymbols.has(symbol));
}

function functionCallableReference(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  bindings: DynamicExecutionBindings,
): string | undefined {
  return staticallyCallableKind(expression, checker, bindings);
}

function collectDynamicExecutionBindings(source: ts.SourceFile, checker: ts.TypeChecker): DynamicExecutionBindings {
  const bindings: DynamicExecutionBindings = {
    dangerousSymbols: new Map(),
    vmNamespaceSymbols: new Set(),
    functionCallableSymbols: new Map(),
  };
  const aliases: DynamicAliasRecord[] = [];
  const destructures: DynamicDestructureRecord[] = [];
  const addAlias = (name: ts.BindingName | ts.Expression, expression: ts.Expression): void => {
    if (!ts.isIdentifier(name)) return;
    const symbol = identifierSymbol(name, checker);
    if (symbol) aliases.push({ target: symbol, expression });
  };
  const addDestructure = (name: ts.BindingName | ts.Expression, property: string, sourceExpression: ts.Expression): void => {
    if (!ts.isIdentifier(name)) return;
    const symbol = identifierSymbol(name, checker);
    if (symbol) destructures.push({ target: symbol, property, source: sourceExpression });
  };
  const collectBindingPattern = (pattern: ts.ObjectBindingPattern, sourceExpression: ts.Expression): void => {
    for (const element of pattern.elements) {
      const property = element.propertyName && (ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName))
        ? element.propertyName.text
        : ts.isIdentifier(element.name) ? element.name.text : undefined;
      if (property) addDestructure(element.name, property, sourceExpression);
    }
  };
  const collectBindingDefaults = (pattern: ts.BindingName): void => {
    if (ts.isIdentifier(pattern)) return;
    for (const element of pattern.elements) {
      if (!ts.isBindingElement(element)) continue;
      if (element.initializer) addAlias(element.name, element.initializer);
      collectBindingDefaults(element.name);
    }
  };
  const collectAssignmentPattern = (pattern: ts.ObjectLiteralExpression, sourceExpression: ts.Expression): void => {
    for (const property of pattern.properties) {
      if (ts.isPropertyAssignment(property)) {
        const name = (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : undefined;
        if (name) addDestructure(property.initializer, name, sourceExpression);
      } else if (ts.isShorthandPropertyAssignment(property)) {
        addDestructure(property.name, property.name.text, sourceExpression);
      }
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)
      && ts.isStringLiteral(node.moduleSpecifier)
      && (node.moduleSpecifier.text === 'node:vm' || node.moduleSpecifier.text === 'vm')) {
      const imported = node.importClause?.namedBindings;
      if (node.importClause?.name) {
        const symbol = identifierSymbol(node.importClause.name, checker);
        if (symbol) bindings.vmNamespaceSymbols.add(symbol);
      }
      if (imported && ts.isNamespaceImport(imported)) {
        const symbol = identifierSymbol(imported.name, checker);
        if (symbol) bindings.vmNamespaceSymbols.add(symbol);
      }
      if (imported && ts.isNamedImports(imported)) {
        for (const element of imported.elements) {
          const importedName = (element.propertyName ?? element.name).text;
          const symbol = identifierSymbol(element.name, checker);
          if (symbol && DYNAMIC_VM_EXECUTION_MEMBERS.has(importedName)) bindings.dangerousSymbols.set(symbol, `node:vm.${importedName}`);
        }
      }
    }
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      const symbol = identifierSymbol(node.name, checker);
      if (symbol) bindings.functionCallableSymbols.set(symbol, functionDeclarationConstructorKind(node));
    }
    if (ts.isParameter(node)) {
      if (node.initializer && ts.isIdentifier(node.name)) addAlias(node.name, node.initializer);
      if (node.initializer && ts.isObjectBindingPattern(node.name)) collectBindingPattern(node.name, node.initializer);
      collectBindingDefaults(node.name);
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) {
        const symbol = identifierSymbol(node.name, checker);
        if (symbol) {
          aliases.push({ target: symbol, expression: node.initializer });
          if (isGlobalRequireCall(node.initializer, checker)) bindings.vmNamespaceSymbols.add(symbol);
          const callableKind = staticallyCallableKind(node.initializer, checker, bindings);
          if (callableKind) bindings.functionCallableSymbols.set(symbol, callableKind);
        }
      } else if (ts.isObjectBindingPattern(node.name)) {
        collectBindingPattern(node.name, node.initializer);
      }
      collectBindingDefaults(node.name);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (ts.isIdentifier(node.left)) {
        const symbol = identifierSymbol(node.left, checker);
        if (symbol) aliases.push({ target: symbol, expression: node.right });
      } else if (ts.isObjectLiteralExpression(node.left)) {
        collectAssignmentPattern(node.left, node.right);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  let changed = true;
  while (changed) {
    changed = false;
    for (const alias of aliases) {
      if (!bindings.vmNamespaceSymbols.has(alias.target) && vmNamespaceReference(alias.expression, checker, bindings)) {
        bindings.vmNamespaceSymbols.add(alias.target);
        changed = true;
      }
      if (!bindings.functionCallableSymbols.has(alias.target)) {
        const callableKind = functionCallableReference(alias.expression, checker, bindings);
        if (callableKind) bindings.functionCallableSymbols.set(alias.target, callableKind);
        if (callableKind) changed = true;
      }
      if (!bindings.dangerousSymbols.has(alias.target)) {
        const kind = dynamicReferenceKind(alias.expression, checker, bindings);
        if (kind) {
          bindings.dangerousSymbols.set(alias.target, kind);
          changed = true;
        }
      }
    }
    for (const destructure of destructures) {
      if (bindings.dangerousSymbols.has(destructure.target)) continue;
      const fromGlobal = isGlobalObjectIdentifier(destructure.source, checker)
        && (destructure.property === 'eval' || destructure.property === 'Function');
      const fromVm = vmNamespaceReference(destructure.source, checker, bindings)
        && DYNAMIC_VM_EXECUTION_MEMBERS.has(destructure.property);
      if (fromGlobal || fromVm) {
        bindings.dangerousSymbols.set(
          destructure.target,
          fromVm ? `node:vm.${destructure.property}` : destructure.property,
        );
        changed = true;
      }
    }
  }
  return bindings;
}

function unwrapExecutionExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)) current = current.expression;
  return current;
}

function dynamicExecutionKind(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  bindings: DynamicExecutionBindings,
): string | undefined {
  return dynamicReferenceKind(expression, checker, bindings);
}

function staticDynamicExecutionPayloads(
  args: readonly ts.Expression[],
  checker: ts.TypeChecker,
  constStrings: ReadonlyMap<ts.Symbol, string>,
): string[] {
  return args.flatMap(argument => {
    const payload = staticModuleText(argument, checker, constStrings);
    return payload === undefined ? [] : [payload];
  });
}

function payloadReferencesLegacyCompatibility(payload: string): boolean {
  try {
    return decodeURIComponent(payload).includes('legacy-delivery-claims-compat');
  } catch {
    return payload.includes('legacy-delivery-claims-compat');
  }
}

function scanDynamicCodeGeneration(file: string, text: string, program?: ts.Program): Violation[] {
  const exemptFingerprint = DYNAMIC_CODE_GENERATION_FINGERPRINT_EXEMPTIONS.get(file);
  if (exemptFingerprint && canonicalAstFingerprint(file, text) === exemptFingerprint) return [];
  const analysis = typeAnalysisFor(file, text, program);
  const { source, checker } = analysis;
  const constStrings = collectConstStringValues(source, checker);
  const bindings = collectDynamicExecutionBindings(source, checker);
  const violations: Violation[] = typeAnalysisViolations(file, analysis);
  const inspect = (node: ts.CallExpression | ts.NewExpression): void => {
    const kind = dynamicExecutionKind(node.expression, checker, bindings);
    if (!kind) return;
    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'bind') return;
    const args = node.arguments ?? [];
    const payloads = staticDynamicExecutionPayloads(args, checker, constStrings);
    violations.push({
      file,
      line: lineNumberAt(text, node.getStart(source)),
      label: 'unapproved dynamic code generation',
      text: `${kind}${payloads.length > 0 ? ` static-payload=${JSON.stringify(payloads)}` : ''}`,
    });
    for (const payload of payloads.filter(payloadReferencesLegacyCompatibility)) {
      violations.push({
        file,
        line: lineNumberAt(text, node.getStart(source)),
        label: 'dynamic code generation compatibility payload',
        text: payload,
      });
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) inspect(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

function importedCompatSymbols(
  file: string,
  source: ts.SourceFile,
  aliasEdges: readonly PackageAliasEdge[] = PACKAGE_ALIAS_EDGE_INVENTORY,
): string[] {
  const symbols: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || !moduleSpecifierResolvesTo(file, statement.moduleSpecifier.text, LEGACY_DELIVERY_COMPAT_MODULE, aliasEdges)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      symbols.push(element.name.text === imported ? imported : `${imported} as ${element.name.text}`);
    }
  }
  return symbols;
}

function scanLegacyDeliveryCompatibilityUsage(
  file: string,
  text: string,
  checkedPinnedPaths?: Map<string, number>,
  aliasEdges: readonly PackageAliasEdge[] = PACKAGE_ALIAS_EDGE_INVENTORY,
): Violation[] {
  const fingerprintViolations = validatePinnedExecutableSourceFingerprint(file, text, checkedPinnedPaths);
  if (!isExecutableSourceFile(file)) return fingerprintViolations;
  if (file === LEGACY_DELIVERY_COMPAT_MODULE) return fingerprintViolations;
  const { source, checker } = typeAnalysisFor(file, text);
  const concealedLoadViolations = scanConcealedCompatibilityLoads(file, text);
  const compatImports = extractImportSpecifiers(text, file)
    .filter(({ specifier }) => moduleSpecifierResolvesTo(file, specifier, LEGACY_DELIVERY_COMPAT_MODULE, aliasEdges));
  const approved = approvedLegacyDeliveryCompatUsages.get(file);
  const violations: Violation[] = [...fingerprintViolations, ...concealedLoadViolations];
  if (compatImports.length === 0) return violations;
  if (!approved) {
    return [...violations, ...compatImports.map(({ specifier, index }) => ({
      file,
      line: lineNumberAt(text, index),
      label: 'unapproved legacy delivery compatibility import',
      text: specifier,
    }))];
  }

  const compatBindings = compatibilityImportBindings(file, source, aliasEdges);
  const actualSymbols = [...new Set(importedCompatSymbols(file, source, aliasEdges))].sort();
  const expectedSymbols = [...approved.symbols].sort();
  if (compatImports.length !== 1 || JSON.stringify(actualSymbols) !== JSON.stringify(expectedSymbols)) {
    violations.push({
      file,
      line: lineNumberAt(text, compatImports[0].index),
      label: 'legacy delivery compatibility import surface drift',
      text: `expected ${expectedSymbols.join(',')} got ${actualSymbols.join(',') || 'none'}`,
    });
  }
  for (const [symbol, expectedShapes] of Object.entries(approved.calls)) {
    const binding = compatBindings.get(symbol);
    const actualShapes = binding
      ? bindingReferences(source, binding, checker)
        .filter(reference => ts.isCallExpression(reference.parent) && reference.parent.expression === reference)
        .map(reference => approvedCompatibilityCallShape(reference.parent as ts.CallExpression) ?? '<noncanonical>')
        .sort()
      : [];
    const sortedExpectedShapes = [...expectedShapes].sort();
    if (JSON.stringify(actualShapes) !== JSON.stringify(sortedExpectedShapes)) {
      violations.push({ file, line: 1, label: 'legacy delivery compatibility call-site drift', text: `${symbol}: expected ${sortedExpectedShapes.join(',')}, got ${actualShapes.join(',') || 'none'}` });
    }
  }
  for (const [symbol, expectedCount] of Object.entries(approved.occurrences)) {
    const binding = compatBindings.get(symbol);
    const actualCount = binding ? bindingReferences(source, binding, checker).length : 0;
    if (actualCount !== expectedCount) {
      violations.push({ file, line: 1, label: 'legacy delivery compatibility symbol escape', text: `${symbol}: expected ${expectedCount} local occurrence(s), got ${actualCount}` });
    }
  }
  for (const reference of disallowedCompatibilityValueReferences(source, approved, file, checker, aliasEdges)) {
    violations.push({
      file,
      line: lineNumberAt(text, reference.getStart(source)),
      label: 'legacy delivery compatibility alias/export escape',
      text: 'compatibility value may only appear in its approved AST call site',
    });
  }
  return violations;
}

function directlyExportsCompatibilityBinding(file: string, text: string): boolean {
  const approved = approvedLegacyDeliveryCompatUsages.get(file);
  if (!approved) return false;
  const { source, checker } = typeAnalysisFor(file, text);
  // Approved importers are a closed structural whitelist. Any real value-binding
  // reference outside the exact canonical parent chains makes the module a
  // potential exporter; graph scanning then rejects every downstream import.
  // This intentionally avoids pretending to solve arbitrary JavaScript taint.
  return canonicalAstFingerprint(file, text) !== PINNED_EXECUTABLE_SOURCE_FINGERPRINTS.get(file)
    || disallowedCompatibilityValueReferences(source, approved, file, checker).length > 0;
}

function scanLegacyDeliveryCompatibilityGraph(fileTexts: ReadonlyMap<string, string>): Violation[] {
  const violations: Violation[] = [];
  const exporters = new Set<string>([normalizeModulePath(LEGACY_DELIVERY_COMPAT_MODULE)]);

  for (const [file, text] of fileTexts) {
    if (!isExecutableSourceFile(file)) continue;
    if (directlyExportsCompatibilityBinding(file, text)) exporters.add(normalizeModulePath(file));
    for (const { specifier, index, kind } of extractImportSpecifiers(text, file)) {
      if (!moduleSpecifierResolvesTo(file, specifier, LEGACY_DELIVERY_COMPAT_MODULE)) continue;
      if (kind === 'export') {
        violations.push({ file, line: lineNumberAt(text, index), label: 'direct legacy delivery compatibility re-export', text: specifier });
        exporters.add(normalizeModulePath(file));
      }
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const [file, text] of fileTexts) {
      if (!isExecutableSourceFile(file)) continue;
      const normalizedFile = normalizeModulePath(file);
      for (const { specifier, index, kind } of extractImportSpecifiers(text, file)) {
        for (const target of resolvedStaticModulePaths(file, specifier).targets) {
          if (!exporters.has(target) || target === normalizeModulePath(LEGACY_DELIVERY_COMPAT_MODULE)) continue;
          violations.push({
            file,
            line: lineNumberAt(text, index),
            label: 'transitive legacy delivery compatibility import',
            text: `${specifier} via ${target}`,
          });
          if (kind === 'export' && !exporters.has(normalizedFile)) {
            exporters.add(normalizedFile);
            changed = true;
          }
        }
      }
    }
  }
  return violations;
}

function shouldScanImports(file: string): boolean {
  return SHIPPED_EXECUTABLE_SOURCE_DIRS.some(dir => file.startsWith(`${dir}/`))
    && isExecutableSourceFile(file)
    && !file.includes('/dist/')
    && !fileIsExplicitLegacyQuarantine(file);
}

function scanImportSpecifiers(file: string, text: string): Violation[] {
  if (!shouldScanImports(file)) return [];
  const violations: Violation[] = [];
  for (const { specifier, index } of extractImportSpecifiers(text, file)) {
    const label = retiredModuleMatch(file, specifier);
    if (label) {
      violations.push({
        file,
        line: lineNumberAt(text, index),
        label,
        text: specifier,
      });
    }
  }
  return violations;
}

function scanText(file: string, text: string, rules = bannedActiveRules): Violation[] {
  const violations: Violation[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (lineIsQuarantined(file, line)) return;
    for (const rule of rules) {
      if (rule.pattern.test(line)) {
        violations.push({ file, line: index + 1, label: rule.label, text: line.trim() });
      }
    }
  });
  return violations;
}

function assertPositiveControls(): void {
  const controls = [
    'Authority Server',
    'authorityDone',
    'fullAuthorityDone',
    'productionDone',
    'production authority',
    'Authority completion',
    'production completion',
    'production DONE',
    'LATTICE_AUTHORITY_URL',
    'authority_status',
  ];
  const violations = scanText('<positive-control>', controls.join('\n'));
  for (const control of controls) {
    assert.ok(
      violations.some(v => v.text.includes(control) || (control === 'LATTICE_AUTHORITY_URL' && v.label === 'LATTICE_AUTHORITY_*')),
      `positive control must catch ${control}`,
    );
  }

  const activeRendererControls = [
    'lines.push(`productionDone: ${result.productionDone}`);',
    "lines.push('authorityDone: false');",
    "lines.push('fullAuthorityDone: false');",
  ];
  const rendererViolations = scanText('packages/main/src/core/active-renderer.ts', activeRendererControls.join('\n'));
  for (const control of ['productionDone:', 'authorityDone:', 'fullAuthorityDone:']) {
    assert.ok(
      rendererViolations.some(v => v.text.includes(control)),
      `active renderer positive control must catch ${control}`,
    );
  }
}

function assertImportSpecifierPositiveControls(): void {
  const controlFile = 'packages/main/src/core/active-runtime.ts';
  const violations = scanImportSpecifiers(controlFile, [
    "import { run } from '../handlers/story-authority-resolve.js';",
    "await import('./story-authority-resolver.js');",
  ].join('\n'));
  assert.ok(
    violations.some(v => v.text === '../handlers/story-authority-resolve.js'),
    'import guard must catch the retired story-authority-resolve handler',
  );
  assert.ok(
    violations.some(v => v.text === './story-authority-resolver.js'),
    'import guard must catch the retired story-authority-resolver core module',
  );
}

function assertHermeticTraversalPositiveControls(): void {
  const root = mkdtempSync(join(tmpdir(), 'retired-authority-traversal-'));
  try {
    const target = join(root, 'z-target');
    mkdirSync(target);
    writeFileSync(join(target, 'protected.ts'), 'export const protectedValue = true;\n');
    symlinkSync('z-target', join(root, 'a-alias'));
    symlinkSync('.', join(target, 'self-cycle'));
    symlinkSync('..', join(target, 'back-edge'));
    assert.deepEqual(
      listFilesFromRoot(root, '.', EXECUTABLE_SOURCE_EXTENSIONS),
      ['z-target/protected.ts'],
      'alias-before-target and self/back-edge symlinks must be skipped while the canonical target is traversed exactly once',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertShippedExecutableRootPositiveControls(): void {
  const actualAliasInventoryHash = packageAliasEdgeInventoryHash(PACKAGE_ALIAS_MANIFEST_RECORDS, PACKAGE_ALIAS_EDGE_INVENTORY);
  assert.equal(
    actualAliasInventoryHash,
    PINNED_PACKAGE_ALIAS_EDGE_INVENTORY_HASH,
    `${PACKAGE_ALIAS_EDGE_INVENTORY_ALGORITHM}: package imports/self-exports edge inventory drift requires explicit review`,
  );
  for (const edge of PACKAGE_ALIAS_EDGE_INVENTORY.filter(edge => !edge.targetPattern.includes('*'))) {
    const target = packageSourceTarget(edge, '');
    assert.ok(target && EXECUTABLE_SOURCE_EXTENSIONS.some(extension => existsSync(join(repoRoot, `${target}${extension}`))), `package alias edge must resolve to a source target: ${edge.specifierPattern}`);
  }
  const hermeticRecords: PackageAliasManifestRecord[] = [{
    path: 'packages/main/package.json',
    manifest: {
      name: '@lattice/core',
      imports: {
        '#compat': { node: './src/core/legacy-delivery-claims-compat.ts', default: './src/core/legacy-delivery-claims-compat.ts' },
        '#compat/*': './src/core/*.ts',
      },
      exports: { './compat': './src/core/legacy-delivery-claims-compat.ts' },
    },
  }];
  const hermeticEdges = buildPackageAliasEdgeInventory(hermeticRecords);
  const aliasControlFile = 'packages/main/src/package-alias-control.ts';
  for (const [label, specifier] of [
    ['package imports alias', '#compat'],
    ['conditional wildcard package imports alias', '#compat/legacy-delivery-claims-compat'],
    ['package self-reference alias', '@lattice/core/compat'],
  ] as const) {
    assert.ok(
      resolvePackageAlias(aliasControlFile, specifier, hermeticEdges).targets.includes(normalizeModulePath(LEGACY_DELIVERY_COMPAT_MODULE)),
      `${label} must resolve through the manifest edge inventory`,
    );
    const source = `import { createLegacyLocalOnlyDeliveryClaims } from '${specifier}';\ncreateLegacyLocalOnlyDeliveryClaims();\n`;
    assert.ok(
      scanLegacyDeliveryCompatibilityUsage(aliasControlFile, source, undefined, hermeticEdges)
        .some(violation => violation.label === 'unapproved legacy delivery compatibility import'),
      `${label} must resolve end-to-end to the protected source target`,
    );
  }
  const mutatedRecords = structuredClone(hermeticRecords);
  (mutatedRecords[0].manifest.imports as Record<string, unknown>)['#new-bypass'] = './src/core/legacy-delivery-claims-compat.ts';
  assert.notEqual(
    packageAliasEdgeInventoryHash(hermeticRecords, hermeticEdges),
    packageAliasEdgeInventoryHash(mutatedRecords, buildPackageAliasEdgeInventory(mutatedRecords)),
    'changing package imports must change the pinned manifest-derived edge inventory fingerprint',
  );
  assert.ok(
    scanImportSpecifiers(aliasControlFile, "import '#unregistered-bypass';")
      .some(violation => violation.label === 'unresolved package import/self-reference alias'),
    'unknown package imports alias must fail closed',
  );
  assert.deepEqual(
    deriveShippedPackageEntrypoints(),
    SHIPPED_EXECUTABLE_ENTRYPOINTS.filter(entrypoint => entrypoint.startsWith('packages/')).sort(),
    'every package bin/exports target must derive to an explicitly pinned scanned source entrypoint',
  );
  for (const entrypoint of SHIPPED_EXECUTABLE_ENTRYPOINTS) {
    assert.equal(existsSync(join(repoRoot, entrypoint)), true, `pinned shipped executable entrypoint must exist: ${entrypoint}`);
    assert.equal(isExecutableSourceFile(entrypoint), true, `pinned shipped executable entrypoint must use a scanned extension: ${entrypoint}`);
  }
  for (const binEntrypoint of ['bin/lattice.js', 'bin/bootstrap-runner.js']) {
    const directBypass = "import { createLegacyLocalOnlyDeliveryClaims } from '../packages/main/src/core/legacy-delivery-claims-compat.js';\ncreateLegacyLocalOnlyDeliveryClaims();\n";
    assert.ok(
      scanLegacyDeliveryCompatibilityUsage(binEntrypoint, directBypass)
        .some(violation => violation.label === 'unapproved legacy delivery compatibility import'),
      `direct bin entrypoint compatibility import must be caught: ${binEntrypoint}`,
    );
  }
  for (const newFile of ['bin/new-cli-entrypoint.js', 'packages/lab/src/new-export.mts', 'packages/utils/src/new-register.cts']) {
    assert.equal(shouldScanImports(newFile), true, `new shipped executable file must enter import scanning: ${newFile}`);
    const dynamicViolations = scanDynamicCodeGeneration(newFile, "eval(\"import('./legacy-delivery-claims-compat.js')\")");
    assert.ok(
      dynamicViolations.some(violation => violation.label === 'dynamic code generation compatibility payload'),
      `new shipped executable file must enter dynamic-code scanning: ${newFile}; got ${JSON.stringify(dynamicViolations)}`,
    );
  }
}

function assertNormalizedSpecifierPositiveControls(): void {
  const controlFile = 'packages/main/src/core/specifier-normalization-control.ts';
  for (const [label, source] of [
    ['query suffix', "import { createLegacyLocalOnlyDeliveryClaims } from './legacy-delivery-claims-compat.js?cache=1';"],
    ['fragment suffix', "import { createLegacyLocalOnlyDeliveryClaims } from './legacy-delivery-claims-compat.js#runtime';"],
    ['percent encoding', "import { createLegacyLocalOnlyDeliveryClaims } from './legacy%2Ddelivery%2Dclaims%2Dcompat.js';"],
    ['CJS query and fragment', "require('./legacy-delivery-claims-compat.js?cache=1#runtime');"],
  ] as const) {
    assert.ok(
      scanLegacyDeliveryCompatibilityUsage(controlFile, source)
        .some(violation => violation.label === 'unapproved legacy delivery compatibility import'),
      `${label} runtime-equivalent compatibility specifier must be caught`,
    );
  }
  assert.ok(
    scanImportSpecifiers(controlFile, "import './story%2Dauthority%2Dresolver.js?cache=1#runtime';")
      .some(violation => violation.label === 'retired story resolver module'),
    'percent-encoded query/fragment retired module specifier must be caught',
  );
  assert.ok(
    scanImportSpecifiers(controlFile, "import './legacy%ZZdelivery.js';")
      .some(violation => violation.label === 'malformed encoded static module specifier'),
    'malformed percent-encoded static module specifier must fail closed',
  );
}

function assertDynamicCodeGenerationPositiveControls(): void {
  assert.equal(
    DYNAMIC_CODE_GENERATION_FINGERPRINT_EXEMPTIONS.size + BENIGN_NON_LITERAL_LOADER_SOURCE_FINGERPRINTS.size,
    6,
    'the fixture executor is the sixth exact whole-source executable exemption; no broad pattern exemptions are allowed',
  );
  const cases = [
    ['direct eval', "eval(\"import('../packages/main/src/core/legacy-delivery-claims-compat.js')\")"],
    ['indirect eval', "(0, eval)(`require('../packages/main/src/core/legacy-delivery-claims-compat.js')`)"],
    ['aliased eval', "const indirect = eval; indirect(\"import('../packages/main/src/core/legacy-delivery-claims-compat.js')\")"],
    ['Function call', "Function(\"return import('../packages/main/src/core/legacy-delivery-claims-compat.js')\")()"],
    ['new Function', "new Function(\"return require('../packages/main/src/core/legacy-delivery-claims-compat.js')\")"],
    ['async constructor', "const AsyncFunction = (async () => {}).constructor; new AsyncFunction(\"return import('../packages/main/src/core/legacy-delivery-claims-compat.js')\")"],
    ['vm namespace', "import * as vm from 'node:vm'; vm.runInNewContext(\"require('../packages/main/src/core/legacy-delivery-claims-compat.js')\")"],
    ['vm named alias', "import { compileFunction as compile } from 'node:vm'; compile(\"return import('../packages/main/src/core/legacy-delivery-claims-compat.js')\")"],
    ['global property eval', "globalThis['eval'](\"import('../packages/main/src/core/legacy-delivery-claims-compat.js')\")"],
    ['window eval property', "window.eval(\"import('../packages/main/src/core/legacy-delivery-claims-compat.js')\")"],
    ['nested local eval alias', "function execute() { const indirect = eval; indirect(\"import('../packages/main/src/core/legacy-delivery-claims-compat.js')\"); }"],
    ['nested local vm require alias', "function execute() { const vm = require('node:vm'); vm.runInNewContext(\"require('../packages/main/src/core/legacy-delivery-claims-compat.js')\"); }"],
    ['nested local AsyncFunction derived constructor', "function execute() { const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor; new AsyncFunction(\"return import('../packages/main/src/core/legacy-delivery-claims-compat.js')\"); }"],
    ['nested bind alias chain', "function execute() { const first = eval; const second = first.bind(globalThis); second(\"import('../packages/main/src/core/legacy-delivery-claims-compat.js')\"); }"],
    ['nested global destructure alias', "function execute() { const { eval: indirect } = globalThis; indirect(\"import('../packages/main/src/core/legacy-delivery-claims-compat.js')\"); }"],
    ['nested vm destructure alias', "function execute() { const { runInContext: run } = require('node:vm'); run(\"require('../packages/main/src/core/legacy-delivery-claims-compat.js')\"); }"],
    ['nested reassignment alias', "function execute() { let indirect; indirect = eval; indirect(\"import('../packages/main/src/core/legacy-delivery-claims-compat.js')\"); }"],
    ['eval parameter default', "function execute(indirect = eval) { indirect(\"import('../packages/main/src/core/legacy-delivery-claims-compat.js')\"); }"],
    ['vm parameter default', "function execute(vm = require('node:vm')) { vm.runInContext(\"require('../packages/main/src/core/legacy-delivery-claims-compat.js')\"); }"],
    ['AsyncFunction parameter default', "function execute(Build = Object.getPrototypeOf(async function() {}).constructor) { new Build(\"return import('../packages/main/src/core/legacy-delivery-claims-compat.js')\"); }"],
    ['object destructure parameter default', "function execute({ eval: indirect } = globalThis) { indirect(\"import('../packages/main/src/core/legacy-delivery-claims-compat.js')\"); }"],
    ['array destructure parameter default', "function execute([indirect = eval] = []) { indirect(\"import('../packages/main/src/core/legacy-delivery-claims-compat.js')\"); }"],
    ['rest-fed array destructure default', "function execute(...args) { const [indirect = eval] = args; indirect(\"import('../packages/main/src/core/legacy-delivery-claims-compat.js')\"); }"],
    ['object element parameter default without outer default', "function execute({ indirect = eval }) { indirect(\"import('../packages/main/src/core/legacy-delivery-claims-compat.js')\"); }"],
    ['array element parameter default without outer default', "function execute([indirect = eval]) { indirect(\"import('../packages/main/src/core/legacy-delivery-claims-compat.js')\"); }"],
    ['nested object array parameter default', "function execute({ nested: [{ indirect = eval }] }) { indirect(\"import('../packages/main/src/core/legacy-delivery-claims-compat.js')\"); }"],
    ['nested rest parameter binding default', "function execute([head, ...[indirect = eval]]) { indirect(\"import('../packages/main/src/core/legacy-delivery-claims-compat.js')\"); }"],
    ['ordinary function expression constructor', "const Build = (function() {}).constructor; new Build(\"return import('../packages/main/src/core/legacy-delivery-claims-compat.js')\");"],
    ['ordinary function declaration constructor alias', "function factory() {} const alias = factory; const Build = alias.constructor; new Build(\"return import('../packages/main/src/core/legacy-delivery-claims-compat.js')\");"],
    ['generator function constructor', "const Build = (function*() {}).constructor; new Build(\"return import('../packages/main/src/core/legacy-delivery-claims-compat.js')\");"],
    ['async generator function constructor', "const Build = (async function*() {}).constructor; new Build(\"return import('../packages/main/src/core/legacy-delivery-claims-compat.js')\");"],
    ['class expression constructor', "const Build = (class Local {}).constructor; new Build(\"return import('../packages/main/src/core/legacy-delivery-claims-compat.js')\");"],
    ['class declaration constructor', "class Local {} Local.constructor(\"return import('../packages/main/src/core/legacy-delivery-claims-compat.js')\")();"],
    ['class declaration constructor alias', "class Local {} const Alias = Local; const Build = Alias.constructor; new Build(\"return import('../packages/main/src/core/legacy-delivery-claims-compat.js')\");"],
    ['object method constructor', "const holder = { method() {} }; holder.method.constructor(\"return import('../packages/main/src/core/legacy-delivery-claims-compat.js')\")();"],
    ['bound arrow constructor', "const Build = (() => {}).bind(null).constructor; new Build(\"return import('../packages/main/src/core/legacy-delivery-claims-compat.js')\");"],
    ['bound function constructor alias', "function source() {} const bound = source.bind(null); const Build = bound.constructor; new Build(\"return import('../packages/main/src/core/legacy-delivery-claims-compat.js')\");"],
    ['imported node fs callable constructor', "import { readFile } from 'node:fs'; readFile.constructor(\"return import('../packages/main/src/core/legacy-delivery-claims-compat.js')\")();"],
    ['imported callable alias constructor', "import { readFile as importedCallable } from 'node:fs'; const Build = importedCallable.constructor; new Build(\"return import('../packages/main/src/core/legacy-delivery-claims-compat.js')\");"],
    ['standard Array map constructor', "[1].map.constructor(\"return import('../packages/main/src/core/legacy-delivery-claims-compat.js')\")();"],
    ['ambient global callable constructor', "setTimeout.constructor(\"return import('../packages/main/src/core/legacy-delivery-claims-compat.js')\")();"],
    ['node vm default import', "import vm from 'node:vm'; vm.runInNewContext(\"require('../packages/main/src/core/legacy-delivery-claims-compat.js')\");"],
  ] as const;
  const negativeCases = [
    ['shadowed local eval', "function eval(value) { return value; } eval(\"import('../packages/main/src/core/legacy-delivery-claims-compat.js')\");"],
    ['shadowed local Function', "function Function(value) { return value; } new Function(\"return import('../packages/main/src/core/legacy-delivery-claims-compat.js')\");"],
    ['shadowed globalThis property', "const globalThis = { eval(value) { return value; } }; globalThis.eval(\"import('../packages/main/src/core/legacy-delivery-claims-compat.js')\");"],
    ['shadowed window property', "const window = { eval(value) { return value; } }; window.eval(\"import('../packages/main/src/core/legacy-delivery-claims-compat.js')\");"],
    ['shadowed vm namespace', "const vm = { runInNewContext(value) { return value; } }; vm.runInNewContext(\"require('../packages/main/src/core/legacy-delivery-claims-compat.js')\");"],
    ['shadowed local require', "function execute(require) { const vm = require('node:vm'); vm.runInNewContext(\"require('../packages/main/src/core/legacy-delivery-claims-compat.js')\"); }"],
    ['shadowed eval parameter default', "function execute(eval = value => value) { eval(\"import('../packages/main/src/core/legacy-delivery-claims-compat.js')\"); }"],
    ['shadowed vm parameter default', "function execute(vm = { runInContext(value) { return value; } }) { vm.runInContext(\"require('../packages/main/src/core/legacy-delivery-claims-compat.js')\"); }"],
    ['shadowed Function parameter default', "function execute(Function = class LocalBuilder {}) { new Function(\"return import('../packages/main/src/core/legacy-delivery-claims-compat.js')\"); }"],
    ['shadowed nested object parameter default', "function execute({ nested: { indirect = value => value } }) { indirect(\"import('../packages/main/src/core/legacy-delivery-claims-compat.js')\"); }"],
    ['shadowed nested rest parameter default', "function execute([head, ...[indirect = value => value]]) { indirect(\"import('../packages/main/src/core/legacy-delivery-claims-compat.js')\"); }"],
    ['ordinary object constructor', "const object = { constructor(value) { return value; } }; object.constructor(\"return import('../packages/main/src/core/legacy-delivery-claims-compat.js')\");"],
    ['resolvable imported local noncallable value', "import { LEGACY_LIFECYCLE_PHASE_ALIASES } from '../packages/main/src/core/lifecycle-registry.js'; LEGACY_LIFECYCLE_PHASE_ALIASES.constructor(\"return import('../packages/main/src/core/legacy-delivery-claims-compat.js')\");"],
  ] as const;
  const controlSources = [...cases, ...negativeCases].map(([label, source], index) => ({
    label,
    source,
    file: `bin/dynamic-code-control-${index}.ts`,
  }));
  const unresolvedControl = { file: 'bin/dynamic-code-control-unresolved.ts', source: "import missing from './missing-dynamic-control.js'; missing.constructor('return 1')();" };
  const malformedControl = { file: 'bin/dynamic-code-control-malformed.ts', source: 'function malformed( {' };
  const controlProgram = createProjectTypeProgram(new Map([
    ...controlSources.map(control => [control.file, control.source] as const),
    [unresolvedControl.file, unresolvedControl.source],
    [malformedControl.file, malformedControl.source],
  ]), false);
  for (const control of controlSources.slice(0, cases.length)) {
    const violations = scanDynamicCodeGeneration(control.file, control.source, controlProgram);
    const { label } = control;
    assert.ok(violations.some(violation => violation.label === 'unapproved dynamic code generation'), `${label} must be banned`);
    assert.ok(violations.some(violation => violation.label === 'dynamic code generation compatibility payload'), `${label} static payload must be inspected`);
  }
  for (const control of controlSources.slice(cases.length)) {
    assert.deepEqual(scanDynamicCodeGeneration(control.file, control.source, controlProgram), [], `${control.label} must remain a declaration-identity negative control`);
  }
  assert.ok(
    scanDynamicCodeGeneration(unresolvedControl.file, unresolvedControl.source, controlProgram)
      .some(violation => violation.label === 'malformed or unresolved executable type analysis'),
    'unresolved relevant module source must fail closed',
  );
  assert.ok(
    scanDynamicCodeGeneration(malformedControl.file, malformedControl.source, controlProgram)
      .some(violation => violation.label === 'malformed or unresolved executable type analysis'),
    'malformed relevant executable source must fail closed',
  );
  for (const [file, fingerprint] of DYNAMIC_CODE_GENERATION_FINGERPRINT_EXEMPTIONS) {
    assert.equal(canonicalAstFingerprint(file, readRel(file)), fingerprint, `dynamic-code exemption fingerprint must be exact: ${file}`);
    assert.deepEqual(scanDynamicCodeGeneration(file, readRel(file)), [], `exact dynamic-code exemption must remain accepted: ${file}`);
    assert.ok(
      scanDynamicCodeGeneration(file, `${readRel(file)}\nvoid 0;\n`)
        .some(violation => violation.label === 'unapproved dynamic code generation'),
      `any executable drift must invalidate the dynamic-code exemption: ${file}`,
    );
  }
}

function assertLegacyDeliveryCompatibilityPositiveControls(): void {
  const controlFile = 'packages/main/src/core/unapproved-delivery-emitter.ts';
  const control = [
    "import { createLegacyLocalOnlyDeliveryClaims } from './legacy-delivery-claims-compat.js';",
    'export const leaked = { ...createLegacyLocalOnlyDeliveryClaims() };',
  ].join('\n');
  const violations = scanLegacyDeliveryCompatibilityUsage(controlFile, control);
  assert.ok(
    violations.some(violation => violation.label === 'unapproved legacy delivery compatibility import'),
    'compatibility usage guard must catch an unapproved importer that spreads/calls the constructor',
  );
  const directTokenViolations = scanText('<positive-control>', 'const leaked = { authorityDone: false };');
  assert.ok(directTokenViolations.some(violation => violation.label === 'authorityDone'), 'direct retired-field positive control must remain caught');

  const compatibilitySource = readRel(LEGACY_DELIVERY_COMPAT_MODULE);
  assert.deepEqual(
    scanLegacyDeliveryCompatibilityUsage(LEGACY_DELIVERY_COMPAT_MODULE, compatibilitySource),
    [],
    'the exact compatibility module must retain its pinned executable fingerprint',
  );
  for (const [mutatedSource, assertionMessage] of [
    [compatibilitySource.replace('    authorityDone: false,', '    authorityDone: false,\n    ...{},'), 'compatibility constructor body mutation must invalidate its pinned executable fingerprint'],
    [compatibilitySource.replace("  if (typeof value !== 'object'", "  if (false && typeof value !== 'object'"), 'compatibility validator body mutation must invalidate its pinned executable fingerprint'],
    [`${compatibilitySource}\nexport const compatibilityEscape = true;\n`, 'compatibility export surface mutation must invalidate its pinned executable fingerprint'],
    [compatibilitySource.replace('  authorityDone: false;', '  authorityDone: boolean;'), 'compatibility type surface mutation must invalidate its pinned executable fingerprint'],
  ] as const) {
    assert.ok(
      scanLegacyDeliveryCompatibilityUsage(LEGACY_DELIVERY_COMPAT_MODULE, mutatedSource)
        .some(violation => violation.label === 'pinned executable source structural fingerprint drift'),
      assertionMessage,
    );
  }

  assert.deepEqual(
    EXECUTABLE_SOURCE_EXTENSIONS,
    ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
    'executable source discovery must stay aligned with the supported compiler extensions',
  );
  for (const extension of EXECUTABLE_SOURCE_EXTENSIONS) {
    const extensionControlFile = `packages/main/src/core/compatibility-bypass${extension}`;
    const extensionControlSource = "import { createLegacyLocalOnlyDeliveryClaims } from './legacy-delivery-claims-compat.js';\nexport const leaked = createLegacyLocalOnlyDeliveryClaims();\n";
    assert.equal(shouldScanImports(extensionControlFile), true, `${extension} executable sources must be import-scanned`);
    assert.ok(
      scanLegacyDeliveryCompatibilityUsage(extensionControlFile, extensionControlSource)
        .some(violation => violation.label === 'unapproved legacy delivery compatibility import'),
      `direct compatibility bypass in ${extension} must be caught`,
    );
    assert.ok(
      scanImportSpecifiers(extensionControlFile, "import '../handlers/story-authority-resolve.js';")
        .some(violation => violation.label === 'retired story resolver module'),
      `retired import in ${extension} must be caught`,
    );
    const extensionReExportSource = "export { createLegacyLocalOnlyDeliveryClaims } from './legacy-delivery-claims-compat.js';\n";
    assert.ok(
      scanLegacyDeliveryCompatibilityGraph(new Map([[extensionControlFile, extensionReExportSource]]))
        .some(violation => violation.label === 'direct legacy delivery compatibility re-export'),
      `compatibility graph escape in ${extension} must be caught`,
    );
  }

  const approvedProducer = 'packages/main/src/handlers/delivery-context-pack.ts';
  assert.equal(
    canonicalAstFingerprint(approvedProducer, readRel(approvedProducer)),
    canonicalAstFingerprint(approvedProducer, `// irrelevant fingerprint trivia\n${readRel(approvedProducer)}`),
    'canonical AST fingerprints must ignore comments and formatting trivia',
  );
  const patchedProducer = `${readRel(approvedProducer)}\nexport { createLegacyLocalOnlyDeliveryClaims };\n`;
  const twoHopConsumer = 'packages/main/src/core/two-hop-consumer.ts';
  const twoHopTexts = new Map<string, string>([
    [approvedProducer, patchedProducer],
    [twoHopConsumer, "import { createLegacyLocalOnlyDeliveryClaims } from '../handlers/delivery-context-pack.js';\nexport const leaked = createLegacyLocalOnlyDeliveryClaims();\n"],
  ]);
  const twoHopViolations = [
    ...scanLegacyDeliveryCompatibilityUsage(approvedProducer, patchedProducer),
    ...scanLegacyDeliveryCompatibilityGraph(twoHopTexts),
  ];
  assert.ok(twoHopViolations.some(violation => violation.label === 'legacy delivery compatibility alias/export escape'), 'patched approved importer export-list escape must be caught');
  assert.ok(twoHopViolations.some(violation => violation.label === 'transitive legacy delivery compatibility import' && violation.file === twoHopConsumer), 'true two-hop consumer import through a patched approved exporter must be caught');

  const escapedWrapperProducer = `${readRel(approvedProducer)}\nexport function emitLegacyClaims() { return createLegacyLocalOnlyDeliveryClaim\\u0073(); }\n`;
  const escapedWrapperConsumer = 'packages/main/src/core/escaped-wrapper-consumer.ts';
  const escapedWrapperTexts = new Map<string, string>([
    [approvedProducer, escapedWrapperProducer],
    [escapedWrapperConsumer, "import { emitLegacyClaims } from '../handlers/delivery-context-pack.js';\nexport const leaked = { ...emitLegacyClaims() };\n"],
  ]);
  const escapedWrapperViolations = [
    ...scanLegacyDeliveryCompatibilityUsage(approvedProducer, escapedWrapperProducer),
    ...scanLegacyDeliveryCompatibilityGraph(escapedWrapperTexts),
  ];
  assert.ok(escapedWrapperViolations.some(violation => violation.label === 'legacy delivery compatibility symbol escape'), 'Unicode-escaped compatibility identifier in an exported wrapper must be decoded and caught');
  assert.ok(escapedWrapperViolations.some(violation => violation.label === 'transitive legacy delivery compatibility import' && violation.file === escapedWrapperConsumer), 'downstream consumer of Unicode-escaped compatibility wrapper must be caught');

  for (const [paddingLabel, padding] of [
    ['comment padding', '// claims: createLegacyLocalOnlyDeliveryClaims()'],
    ['string padding', "const inertCompatibilityText = 'claims: createLegacyLocalOnlyDeliveryClaims()';"],
  ] as const) {
    const metricPreservingProducer = `${readRel(approvedProducer).replace(
      'claims: createLegacyLocalOnlyDeliveryClaims()',
      'claims: emitLegacyClaims()',
    )}\nexport function emitLegacyClaims() { return createLegacyLocalOnlyDeliveryClaims(); }\n${padding}\n`;
    const metricConsumer = `packages/main/src/core/metric-wrapper-${paddingLabel.replace(' ', '-')}-consumer.ts`;
    const metricTexts = new Map<string, string>([
      [approvedProducer, metricPreservingProducer],
      [metricConsumer, "import { emitLegacyClaims } from '../handlers/delivery-context-pack.js';\nexport const leaked = emitLegacyClaims();\n"],
    ]);
    const metricViolations = [
      ...scanLegacyDeliveryCompatibilityUsage(approvedProducer, metricPreservingProducer),
      ...scanLegacyDeliveryCompatibilityGraph(metricTexts),
    ];
    assert.ok(!metricViolations.some(violation => violation.label === 'legacy delivery compatibility symbol escape'), `${paddingLabel} fixture must preserve AST constructor binding occurrences`);
    assert.ok(metricViolations.some(violation => violation.label === 'legacy delivery compatibility alias/export escape'), `metric-preserving exported wrapper with ${paddingLabel} must be caught by AST call-site validation`);
    assert.ok(metricViolations.some(violation => violation.label === 'transitive legacy delivery compatibility import' && violation.file === metricConsumer), `metric-preserving exported wrapper with ${paddingLabel} must taint its downstream consumer`);
  }

  const matrix: Array<[string, string]> = [
    ['namespace import', "import * as compat from './legacy-delivery-claims-compat.js';\ncompat.createLegacyLocalOnlyDeliveryClaims();"],
    ['aliased named import', "import { createLegacyLocalOnlyDeliveryClaims as indirect } from './legacy-delivery-claims-compat.js';\nindirect();"],
    ['dynamic import', "const compat = await import('./legacy-delivery-claims-compat.js');\ncompat.createLegacyLocalOnlyDeliveryClaims();"],
    ['template-literal dynamic import', "const compat = await import(`./legacy-delivery-claims-compat.js`);\ncompat.createLegacyLocalOnlyDeliveryClaims();"],
    ['concatenated dynamic import', "const compat = await import('./legacy-delivery-' + 'claims-compat.js');\ncompat.createLegacyLocalOnlyDeliveryClaims();"],
    ['interpolated dynamic import', "const compat = await import(`./legacy-delivery-${'claims-compat'}.js`);\ncompat.createLegacyLocalOnlyDeliveryClaims();"],
    ['unresolved interpolated dynamic import', "const variant = 'compat';\nconst compat = await import(`./legacy-delivery-claims-${variant}.js`);\ncompat.createLegacyLocalOnlyDeliveryClaims();"],
    ['two-argument dynamic import', "const compat = await import('./legacy-delivery-claims-compat.js', { with: { type: 'json' } });\ncompat.createLegacyLocalOnlyDeliveryClaims();"],
    ['const variable dynamic import', "const compatPath = './legacy-delivery-claims-compat.js';\nconst compat = await import(compatPath, {});\ncompat.createLegacyLocalOnlyDeliveryClaims();"],
    ['const chain dynamic import', "const base = './legacy-delivery-';\nconst compatPath = base + 'claims-compat.js';\nconst compat = await import(compatPath);\ncompat.createLegacyLocalOnlyDeliveryClaims();"],
    ['require import', "const compat = require('./legacy-delivery-claims-compat.js');\ncompat.createLegacyLocalOnlyDeliveryClaims();"],
    ['concatenated require import', "const compat = require('./legacy-delivery-' + 'claims-compat.js');\ncompat.createLegacyLocalOnlyDeliveryClaims();"],
    ['require alias import', "const rq = require;\nconst compatPath = './legacy-delivery-claims-compat.js';\nconst compat = rq(compatPath);\ncompat.createLegacyLocalOnlyDeliveryClaims();"],
    ['module require import', "const compat = module.require('./legacy-delivery-claims-compat.js');\ncompat.createLegacyLocalOnlyDeliveryClaims();"],
    ['createRequire alias import', "import { createRequire as makeRequire } from 'node:module';\nconst rq = makeRequire(import.meta.url);\nconst compat = rq('./legacy-delivery-claims-compat.js');\ncompat.createLegacyLocalOnlyDeliveryClaims();"],
    ['namespace createRequire import', "import * as mod from 'node:module';\nconst rq = mod.createRequire(import.meta.url);\nconst exactPath = './legacy-delivery-claims-compat.js';\nconst compat = rq(exactPath);\ncompat.createLegacyLocalOnlyDeliveryClaims();"],
    ['createRequire direct import', "import { createRequire } from 'node:module';\nconst compat = createRequire(import.meta.url)('./legacy-delivery-claims-compat.js');\ncompat.createLegacyLocalOnlyDeliveryClaims();"],
    ['destructured createRequire import', "const { createRequire } = require('node:module');\nconst rq = createRequire(__filename);\nconst exactCompatPath = './legacy-delivery-claims-compat.js';\nconst compat = rq(exactCompatPath);\ncompat.createLegacyLocalOnlyDeliveryClaims();"],
    ['bound require import', "const rq = require.bind(null);\nconst exactCompatPath = './legacy-delivery-claims-compat.js';\nconst compat = rq(exactCompatPath);\ncompat.createLegacyLocalOnlyDeliveryClaims();"],
    ['wrapper parameter dynamic import', "const paths = { retired: './legacy-delivery-claims-compat.js' };\nconst load = (p: string) => import(p);\nload(paths.retired);"],
    ['object property dynamic import', "const paths = { retired: './legacy-delivery-claims-compat.js' };\nvoid import(paths.retired);"],
    ['destructured path dynamic import', "const paths = { retired: './legacy-delivery-claims-compat.js' };\nconst { retired } = paths;\nvoid import(retired);"],
    ['direct re-export', "export { createLegacyLocalOnlyDeliveryClaims } from './legacy-delivery-claims-compat.js';"],
  ];
  for (const [label, source] of matrix) {
    const matrixViolations = [
      ...scanLegacyDeliveryCompatibilityUsage(controlFile, source),
      ...scanLegacyDeliveryCompatibilityGraph(new Map([[controlFile, source]])),
    ];
    assert.ok(matrixViolations.length > 0, `${label} compatibility escape must be caught`);
  }
  const unrelatedDynamicLoad = "const plugin = await import(pluginPath);\nplugin.activate();";
  assert.ok(
    scanLegacyDeliveryCompatibilityUsage(controlFile, unrelatedDynamicLoad)
      .some(violation => violation.label === 'unapproved non-literal dynamic module load'),
    'non-literal dynamic imports outside the finite benign call-site allowlist must fail closed',
  );
  const unrelatedCompatNamedLoad = "const plugin = await import(compatPluginPath);\nplugin.activate();";
  assert.ok(
    scanLegacyDeliveryCompatibilityUsage(controlFile, unrelatedCompatNamedLoad)
      .some(violation => violation.label === 'unapproved non-literal dynamic module load'),
    'non-literal loader rejection must be structural and independent of compat-looking identifier spelling',
  );

  const knownBenignLoader = readRel('packages/main/src/cli-engine.ts');
  assert.deepEqual(
    scanConcealedCompatibilityLoads('packages/main/src/cli-engine.ts', knownBenignLoader),
    [],
    'the exact registered cli-engine non-literal loader call site must remain allowed',
  );
  assert.ok(
    scanConcealedCompatibilityLoads('packages/main/src/cli-engine.ts', knownBenignLoader.replace('export async function runCli', 'export async function otherLoader'))
      .some(violation => violation.label === 'unapproved non-literal dynamic module load'),
    'a known benign loader expression relocated to another function must fail closed',
  );
  assert.ok(
    scanConcealedCompatibilityLoads('packages/main/src/cli-engine.ts', knownBenignLoader.replace("new URL('./cli-init.js'", "new URL('./legacy-delivery-claims-compat.js'"))
      .some(violation => violation.label === 'unapproved non-literal dynamic module load'),
    'changing the path producer behind an otherwise identical benign loader call must invalidate its source fingerprint',
  );
  assert.ok(
    scanConcealedCompatibilityLoads('packages/main/src/cli-engine.ts', `${knownBenignLoader}\nasync function wrapper() { async function runCli() { const initPath = './legacy-delivery-claims-compat.js'; await import(\`file://\${initPath}\`); } }\n`)
      .some(violation => violation.label === 'unapproved non-literal dynamic module load'),
    'a nested same-name loader anchor cannot inherit the whole-source fingerprint exemption',
  );
  const unrecognizedLoaderReplacement = knownBenignLoader.replace(
    'await import(`file://${initPath}`);',
    "await (0, eval)('import(\"./legacy-delivery-claims-compat.js\")');",
  );
  assert.notEqual(unrecognizedLoaderReplacement, knownBenignLoader, 'loader-removal control must replace the registered benign loader call');
  assert.ok(
    scanLegacyDeliveryCompatibilityUsage('packages/main/src/cli-engine.ts', unrecognizedLoaderReplacement)
      .some(violation => violation.label === 'pinned executable source structural fingerprint drift'),
    'replacing a benign loader call with unrecognized executable text must still fail the unconditional fingerprint check',
  );

  const relocatedProducer = `${readRel(approvedProducer).replace(
    'claims: createLegacyLocalOnlyDeliveryClaims()',
    'claims: leaked.claims',
  )}\nexport const leaked = { claims: createLegacyLocalOnlyDeliveryClaims() };\n`;
  const destructuringConsumer = 'packages/main/src/core/relocated-claims-destructure.ts';
  const propertyConsumer = 'packages/main/src/core/relocated-claims-property.ts';
  const relocatedTexts = new Map<string, string>([
    [approvedProducer, relocatedProducer],
    [destructuringConsumer, "import { leaked } from '../handlers/delivery-context-pack.js';\nconst { claims } = leaked;\nexport { claims };\n"],
    [propertyConsumer, "import { leaked } from '../handlers/delivery-context-pack.js';\nexport const claims = leaked.claims;\n"],
  ]);
  const relocatedViolations = [
    ...scanLegacyDeliveryCompatibilityUsage(approvedProducer, relocatedProducer),
    ...scanLegacyDeliveryCompatibilityGraph(relocatedTexts),
  ];
  assert.ok(relocatedViolations.some(violation => violation.label === 'legacy delivery compatibility call-site drift'), 'relocated approved-shaped claims call must fail its canonical declaration anchor');
  assert.ok(relocatedViolations.some(violation => violation.label === 'legacy delivery compatibility alias/export escape'), 'relocated approved-shaped claims call inside an exported object must be a binding escape');
  assert.ok(relocatedViolations.some(violation => violation.label === 'transitive legacy delivery compatibility import' && violation.file === destructuringConsumer), 'downstream destructuring of relocated claims object must be caught');
  assert.ok(relocatedViolations.some(violation => violation.label === 'transitive legacy delivery compatibility import' && violation.file === propertyConsumer), 'downstream property access of relocated claims object must be caught');

  const exportedContainerMutation = `export const leakBox: any = {};\n${readRel(approvedProducer).replace(
    'claims: createLegacyLocalOnlyDeliveryClaims()',
    'claims: (leakBox.payload = { claims: createLegacyLocalOnlyDeliveryClaims() }, leakBox.payload.claims)',
  )}`;
  const containerViolations = scanLegacyDeliveryCompatibilityUsage(approvedProducer, exportedContainerMutation);
  assert.ok(containerViolations.some(violation => violation.label === 'legacy delivery compatibility call-site drift'), 'assignment to an exported container inside an approved claims property must break the exact canonical parent chain');
  assert.ok(containerViolations.some(violation => violation.label === 'legacy delivery compatibility alias/export escape'), 'assignment/comma wrappers around the compatibility constructor must be rejected as noncanonical binding use');
  assert.equal(directlyExportsCompatibilityBinding(approvedProducer, exportedContainerMutation), true, 'an approved importer with any noncanonical compatibility binding reference must taint its downstream module edge');

  const postConstructionContainerMutation = `export const leakBox: any = {};\n${readRel(approvedProducer).replace(
    '    // --write: persist the SAME structured pack',
    '    leakBox.payload = report.claims;\n\n    // --write: persist the SAME structured pack',
  )}`;
  const postConstructionViolations = scanLegacyDeliveryCompatibilityUsage(approvedProducer, postConstructionContainerMutation);
  assert.ok(postConstructionViolations.some(violation => violation.label === 'pinned executable source structural fingerprint drift'), 'post-call assignment of canonical report.claims into an exported container must invalidate the complete importer fingerprint');
  assert.equal(directlyExportsCompatibilityBinding(approvedProducer, postConstructionContainerMutation), true, 'post-call exported-container mutation must taint downstream module edges even when compatibility binding references remain canonical');

  const shadowedProducer = `${readRel(approvedProducer)}\nexport function harmlessShadow(createLegacyLocalOnlyDeliveryClaims: () => string) { return createLegacyLocalOnlyDeliveryClaims(); }\n`;
  const shadowedViolations = scanLegacyDeliveryCompatibilityUsage(approvedProducer, shadowedProducer);
  assert.ok(shadowedViolations.some(violation => violation.label === 'pinned executable source structural fingerprint drift'), 'even a shadowed same-name executable addition requires intentional importer fingerprint review');
  assert.ok(!shadowedViolations.some(violation => violation.label === 'legacy delivery compatibility alias/export escape'), 'shadowed same-name identifiers still must not count as references to the compatibility import binding');
  assert.equal(
    directlyExportsCompatibilityBinding(approvedProducer, shadowedProducer),
    true,
    'any executable structural addition to an approved importer must taint the module until its fingerprint is intentionally updated',
  );

  for (const escape of [
    'const indirect = createLegacyLocalOnlyDeliveryClaims; indirect();',
    'exports.compat = createLegacyLocalOnlyDeliveryClaims;',
    'export default createLegacyLocalOnlyDeliveryClaims;',
    'const box = { emit: createLegacyLocalOnlyDeliveryClaims }; box.emit();',
  ]) {
    const patched = `${readRel(approvedProducer)}\n${escape}\n`;
    const escapeViolations = scanLegacyDeliveryCompatibilityUsage(approvedProducer, patched);
    assert.ok(escapeViolations.some(violation => violation.label.includes('escape')), `approved importer alias/property/default escape must be caught: ${escape}`);
  }
}

function assertContract(): void {
  const contract = readRel(CONTRACT_PATH);
  for (const required of [
    'Authority Server',
    'authorityDone',
    'fullAuthorityDone',
    'productionDone',
    'LATTICE_AUTHORITY_*',
    'active `authority_*` command surfaces',
    'local assurance',
    'admissibilityStatus',
    'assuranceLevel',
    'evidenceScope',
    'local review quorum',
    'signed/offline receipt bundle',
    'Active-Surface Scan Scope',
    'Legacy Whitelist And Quarantine Rules',
  ]) {
    assert.ok(contract.includes(required), `${CONTRACT_PATH} must define ${required}`);
  }
  const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  assert.ok(self.includes(CONTRACT_PATH), 'guard must reference the migration contract path');
}

function schemaDescription(schemaEntry: unknown): string {
  const desc = (schemaEntry as { description?: unknown } | undefined)?.description;
  return typeof desc === 'string' ? desc : '';
}

function schemaIsHidden(schemaEntry: unknown): boolean {
  return schemaDescription(schemaEntry).includes('@help-hidden');
}

function assertCommandCatalog(): Violation[] {
  const violations: Violation[] = [];
  const retiredCommands = [
    'story_authority_resolve',
    'authority_status',
    'authority_enforce_policy',
    'authority_receipt_verify',
    'authority_enforce_runner',
    'authority_receipt_fetch',
    'authority_verdict_submit',
    'authority_job_create',
    'authority_verdict_list',
    'authority_job_status',
  ];
  const toolNames = new Set(MAIN_TOOLS.map(tool => tool.name));
  for (const command of retiredCommands) {
    assert.equal(toolNames.has(command), false, `${command} must not be in MAIN_TOOLS`);
  }

  for (const [alias, command] of Object.entries(NESTED_SPACE_ALIASES)) {
    if (retiredCommands.includes(command) || /\bauthority\b/i.test(alias)) {
      violations.push({ file: 'NESTED_SPACE_ALIASES', line: 1, label: 'active alias', text: `${alias} -> ${command}` });
    }
  }

  for (const tool of MAIN_TOOLS) {
    violations.push(...scanText(`MAIN_TOOLS.${tool.name}.name`, tool.name));
    violations.push(...scanText(`MAIN_TOOLS.${tool.name}.description`, tool.description));
    for (const [key, schemaEntry] of Object.entries(tool.schema)) {
      if (schemaIsHidden(schemaEntry)) continue;
      violations.push(...scanText(`MAIN_TOOLS.${tool.name}.${key}.key`, key));
      violations.push(...scanText(`MAIN_TOOLS.${tool.name}.${key}.description`, schemaDescription(schemaEntry)));
    }
  }
  return violations;
}

function runCli(args: string[]): string {
  const cliPath = join(pkgRoot, 'dist', 'cli.js');
  return execFileSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      LATTICE_NO_HOOKS: '1',
    },
  });
}

function assertGeneratedHelp(): Violation[] {
  const outputs = [
    ['help'],
    ['done_closure', '--help'],
    ['dispatch_policy_create', '--help'],
    ['observability_snapshot', '--help'],
    ['evidence_plan', '--help'],
    ['lifecycle_orchestrate', '--help'],
    ['live_smoke_transcript', '--help'],
    ['delivery_context_pack', '--help'],
    ['reviewer_batch', '--help'],
    ['init_preflight', '--help'],
    ['host_probe', '--help'],
    ['conduit_status', '--help'],
    ['story_export', '--help'],
  ];
  return outputs.flatMap(args => scanText(`lattice ${args.join(' ')}`, runCli(args)));
}

const violations: Violation[] = [];
assertPositiveControls();
assertImportSpecifierPositiveControls();
assertHermeticTraversalPositiveControls();
assertShippedExecutableRootPositiveControls();
assertNormalizedSpecifierPositiveControls();
assertDynamicCodeGenerationPositiveControls();
assertLegacyDeliveryCompatibilityPositiveControls();
assertContract();
violations.push(...assertCommandCatalog());

const activeFiles = [
  ...activeTextFiles,
  ...activeTextDirs.flatMap(dir => listFiles(dir, ACTIVE_SCAN_EXTENSIONS)),
  ...SHIPPED_EXECUTABLE_SOURCE_DIRS.flatMap(dir => listFiles(dir, EXECUTABLE_SOURCE_EXTENSIONS)),
  ...SHIPPED_EXECUTABLE_ENTRYPOINTS,
].filter((file, index, all) => all.indexOf(file) === index);
assertProjectTypeProgramContract(activeFiles.filter(file => existsSync(join(repoRoot, file))));
const activeFileTexts = new Map<string, string>();
const checkedPinnedPaths = new Map<string, number>();

for (const file of activeFiles) {
  if (!existsSync(join(repoRoot, file))) continue;
  const text = readRel(file);
  activeFileTexts.set(file, text);
  // Pinned fingerprints are validated before compatibility-module early return
  // and before loader, vocabulary, import, or quarantine-specific scanning.
  violations.push(...scanLegacyDeliveryCompatibilityUsage(file, text, checkedPinnedPaths));
  if (isExecutableSourceFile(file)) violations.push(...scanDynamicCodeGeneration(file, text));
  violations.push(...scanText(file, text));
  violations.push(...scanImportSpecifiers(file, text));
}
assert.deepEqual(
  [...checkedPinnedPaths.entries()].sort(([left], [right]) => left.localeCompare(right)),
  [...PINNED_EXECUTABLE_SOURCE_FINGERPRINTS.keys()].sort().map(file => [file, 1]),
  'all eight pinned canonical executable paths must be checked exactly once by the canonical scan',
);
violations.push(...scanLegacyDeliveryCompatibilityGraph(activeFileTexts));

for (const file of retiredFutureBacklogPlanFiles) {
  if (!existsSync(join(repoRoot, file))) continue;
  violations.push(...scanText(file, readRel(file), retiredFutureBacklogRules));
}

violations.push(...assertGeneratedHelp());

if (violations.length > 0) {
  const rendered = violations
    .slice(0, 100)
    .map(v => `${v.file}:${v.line}: ${v.label}: ${v.text}`)
    .join('\n');
  throw new Error(`retired authority vocabulary guard found ${violations.length} violation(s):\n${rendered}`);
}

process.stdout.write('retired authority vocabulary guard PASS\n');
