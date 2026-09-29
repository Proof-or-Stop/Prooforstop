import assert from 'node:assert/strict';

import { createHash } from 'node:crypto';



import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';


import { readRel } from "./file-scan.js";
import { normalizeModulePath } from "./module-loaders.js";

export const RETIRED_PACKAGE_SCOPE = ['@lat', 'tice/'].join('');

export const here = join(dirname(fileURLToPath(import.meta.url)), '..');

export const pkgRoot = join(here, '..', '..');

export const repoRoot = join(pkgRoot, '..', '..');

export const CONTRACT_PATH = 'docs/requirements/decisions/authority-server-vocabulary-retirement.md';

export interface PatternRule {
  label: string;
  pattern: RegExp;
}

export interface Violation {
  file: string;
  line: number;
  label: string;
  text: string;
}

export const bannedActiveRules: PatternRule[] = [
  { label: 'Authority Server', pattern: /\bAuthority Server\b/ },
  { label: 'authorityDone', pattern: /\bauthorityDone\b/ },
  { label: 'fullAuthorityDone', pattern: /\bfullAuthorityDone\b/ },
  { label: 'productionDone', pattern: /\bproductionDone\b/ },
  { label: 'production authority', pattern: /\bproduction\s+authority\b/i },
  { label: 'Authority completion', pattern: /\bAuthority\s+completion\b/i },
  { label: 'production completion', pattern: /\bproduction\s+completion\b/i },
  { label: 'production DONE', pattern: /\bproduction\s+DONE\b/i },
  { label: 'PROOF_OR_STOP_AUTHORITY_*', pattern: /\bPROOF_OR_STOP_AUTHORITY_[A-Z0-9_]*\b/ },
  { label: 'active authority_* command', pattern: /\bauthority_[a-z][a-z0-9_]*\b/ },
  { label: 'retired story resolver command', pattern: /\bstory_authority_resolve\b/ },
];

export const activeTextFiles = [
  'README.md',
  'docs/guide.md',
  'proof-or-stop.config.json',
  'packages/main/package.json',
  'packages/main/src/registry.ts',
  'packages/main/src/core/config.ts',
  'packages/main/src/cli/alias-normalizer.ts',
  'packages/main/src/cli/activity-policy.ts',
  'packages/main/src/cli/command-catalog.ts',
  'packages/main/src/cli/help-renderer.ts',
] as const;

export const activeTextDirs = [
  // B-cc10 F-055: canonical first. listFilesFromRoot returns [] for a nonexistent root,
  // so listing only the renamed dir contributed ZERO files and the guard passed on nothing.
  '.proof-or-stop-codex',
  '.proof-or-stop-codex',
  '.claude/agents',
  'packages/main/templates/agents',
] as const;

export const EXECUTABLE_SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const;

export const ACTIVE_SCAN_EXTENSIONS = ['.md', '.json', ...EXECUTABLE_SOURCE_EXTENSIONS] as const;

export const SHIPPED_EXECUTABLE_SOURCE_DIRS = [
  'bin',
  'packages/main/src',
  'packages/lab/src',
  'packages/utils/src',
] as const;

export const SHIPPED_EXECUTABLE_ENTRYPOINTS = [
  // B-cc10 CHK-007: `bin/proofOrStop.js` was REMOVED by CHK-006 (deprecated bin alias
  // deletion), but this pin still required it to exist, so the guard failed closed on
  // its own repo. Replaced with the canonical wrapper that actually ships.
  'bin/proof-or-stop.js',
  'bin/bootstrap-runner.js',
  'packages/main/src/cli.ts',
  'packages/main/src/extension-api.ts',
  'packages/main/src/index.ts',
  'packages/main/src/tasks/test-flow-e2e.ts',
  'packages/lab/src/index.ts',
  'packages/lab/src/register.ts',
  'packages/utils/src/index.ts',
  'packages/utils/src/register.ts',
] as const;

export const SHIPPED_PACKAGE_MANIFESTS = [
  'packages/main/package.json',
  'packages/lab/package.json',
  'packages/utils/package.json',
] as const;

export function isExecutableSourceFile(file: string): boolean {
  return EXECUTABLE_SOURCE_EXTENSIONS.some(extension => file.endsWith(extension));
}

export function collectPublishedTargets(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(collectPublishedTargets);
}

export function deriveSourceEntrypoint(manifestPath: string, publishedTarget: string): string | undefined {
  const normalized = publishedTarget.replace(/^\.\//, '');
  if (!normalized.startsWith('dist/') || !/\.js$/.test(normalized)) return undefined;
  return join(dirname(manifestPath), normalized.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts')).replace(/\\/g, '/');
}

export function deriveShippedPackageEntrypoints(): string[] {
  return SHIPPED_PACKAGE_MANIFESTS.flatMap(manifestPath => {
    const manifest = JSON.parse(readRel(manifestPath)) as { bin?: unknown; exports?: unknown };
    return [...collectPublishedTargets(manifest.bin), ...collectPublishedTargets(manifest.exports)]
      .flatMap(target => deriveSourceEntrypoint(manifestPath, target) ?? []);
  }).filter((entrypoint, index, all) => all.indexOf(entrypoint) === index).sort();
}

export type PackageAliasKind = 'imports' | 'self-export';

export interface PackageAliasEdge {
  manifestPath: string;
  packageDir: string;
  packageName: string;
  kind: PackageAliasKind;
  specifierPattern: string;
  targetPattern: string;
  conditionPath: string;
}

export interface PackageAliasManifestRecord {
  path: string;
  manifest: { name?: unknown; imports?: unknown; exports?: unknown };
}

export function collectConditionalTargets(value: unknown, conditionPath = 'default'): Array<{ target: string; conditionPath: string }> {
  if (typeof value === 'string') return [{ target: value, conditionPath }];
  if (Array.isArray(value)) return value.flatMap((entry, index) => collectConditionalTargets(entry, `${conditionPath}[${index}]`));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([condition, target]) => collectConditionalTargets(target, `${conditionPath}.${condition}`));
}

export function buildPackageAliasEdgeInventory(records: readonly PackageAliasManifestRecord[]): PackageAliasEdge[] {
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

export const PACKAGE_ALIAS_MANIFEST_RECORDS: PackageAliasManifestRecord[] = SHIPPED_PACKAGE_MANIFESTS.map(path => ({
  path,
  manifest: JSON.parse(readRel(path)) as PackageAliasManifestRecord['manifest'],
}));

export const PACKAGE_ALIAS_EDGE_INVENTORY = buildPackageAliasEdgeInventory(PACKAGE_ALIAS_MANIFEST_RECORDS);

export const PACKAGE_ALIAS_EDGE_INVENTORY_ALGORITHM = 'package-imports-self-exports-edge-inventory-sha256-v1';

export const PINNED_PACKAGE_ALIAS_EDGE_INVENTORY_HASH = '3b484827d8704b3952b2fe20528d24a1e0b569bce8f5a8aaa36f69f321e3f7eb';

export function packageAliasEdgeInventoryHash(records: readonly PackageAliasManifestRecord[], edges: readonly PackageAliasEdge[]): string {
  const manifestSurfaces = records.map(record => ({
    path: record.path,
    name: record.manifest.name ?? null,
    imports: record.manifest.imports ?? null,
    exports: record.manifest.exports ?? null,
  }));
  return createHash('sha256').update(JSON.stringify({ manifestSurfaces, edges })).digest('hex');
}

export function aliasPatternCapture(pattern: string, specifier: string): string | undefined {
  const star = pattern.indexOf('*');
  if (star === -1) return pattern === specifier ? '' : undefined;
  if (pattern.indexOf('*', star + 1) !== -1) return undefined;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  return specifier.startsWith(prefix) && specifier.endsWith(suffix)
    ? specifier.slice(prefix.length, specifier.length - suffix.length)
    : undefined;
}

export function packageSourceTarget(edge: PackageAliasEdge, capture: string): string | undefined {
  if (!edge.targetPattern.startsWith('./')) return undefined;
  const substituted = edge.targetPattern.replace('*', capture).replace(/^\.\//, '');
  const sourceRelative = substituted.startsWith('dist/')
    ? substituted.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts')
    : substituted;
  return normalizeModulePath(join(edge.packageDir, sourceRelative).replace(/\\/g, '/'));
}

export interface StaticModuleResolution {
  targets: string[];
  error?: string;
}

export function resolvePackageAlias(
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

export const retiredFutureBacklogPlanFiles = [
  'docs/requirements/decisions/global-lifecycle-control-plane-execution-plan.md',
  'docs/requirements/decisions/proof-admissibility-hardening-execution-plan.md',
] as const;

export const retiredFutureBacklogRules: PatternRule[] = [
  { label: 'active Authority Server future backlog', pattern: /\bAuthority Server\b/ },
  { label: 'active Authority production future backlog', pattern: /\bAuthority production\b/ },
  { label: 'active server-backed receipt parity backlog', pattern: /\bserver-backed production receipt parity\b/ },
  { label: 'active Authority conformance backlog', pattern: /\bAuthority Server conformance\b/ },
];

export const explicitLegacyTaskQuarantineFiles = new Set([
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
  'packages/main/src/tasks/flow-stability/done-reporting.ts',
  'packages/main/src/tasks/host-overflow-smoke.ts',
  'packages/main/src/tasks/init-preflight-smoke.ts',
  'packages/main/src/tasks/proof-or-stop-baseline-smoke.ts',
  'packages/main/src/tasks/proof-or-stop-cli-migration-smoke.ts',
  'packages/main/src/tasks/proof-or-stop-evidence-smoke.ts',
  'packages/main/src/tasks/proof-or-stop-handoff-smoke.ts',
  'packages/main/src/tasks/proof-or-stop-parallel-wave-smoke.ts',
  'packages/main/src/tasks/lifecycle-check-smoke.ts',
  'packages/main/src/tasks/lifecycle-orchestrate-smoke.ts',
  'packages/main/src/tasks/live-smoke-transcript-smoke.ts',
  'packages/main/src/tasks/plan-skeleton-smoke.ts',
  'packages/main/src/tasks/prompt-registry-smoke.ts',
  'packages/main/src/tasks/prompt-token-cost-smoke.ts',
  'packages/main/src/tasks/proof-admissibility-smoke.ts',
  'packages/main/src/tasks/provider-claude-smoke.ts',
  'packages/main/src/tasks/provider-codex-smoke.ts',
  // B-e40f moved the existing negative compatibility assertions into this module.
  // Transfer the exact structural quarantine; the coordinator wrapper is no longer exempt.
  'packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts',
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

export const legacyQuarantineFiles = new Set([
  CONTRACT_PATH,
  'packages/main/src/core/authority-contracts.ts',
  'packages/main/src/core/baseline.ts',
  'packages/main/src/core/baseline-contracts.ts',
  'packages/main/src/core/legacy-delivery-claims-compat.ts',
  'packages/main/src/core/baseline-suite-report.ts',
  'packages/main/src/core/proof-or-stop-baseline.ts',
  'packages/main/src/core/verdicts.ts',
  'packages/main/src/tasks/retired-authority/compatibility-controls.ts',
  'packages/main/src/tasks/retired-authority/file-scan.ts',
  'packages/main/src/tasks/retired-authority/positive-controls.ts',
  'packages/main/src/tasks/retired-authority/public-contract.ts',
  'packages/main/src/tasks/retired-authority/rule-data.ts',
  'packages/main/src/tasks/retired-authority-server-semantics-smoke.ts',
  'packages/main/src/handlers/story-authority-resolve.ts',
  'packages/main/src/core/story-authority-resolver.ts',
  'packages/main/src/tasks/story-authority-resolve-smoke.ts',
  'packages/main/src/tasks/observability-contract-smoke.ts',
  'packages/main/src/tasks/observability-snapshot-smoke.ts',
  'packages/main/src/core/observability-snapshot.ts',
  'packages/main/src/handlers/observability-snapshot.ts',
]);

export const retiredServerBackedModuleFiles = new Set([
  'packages/main/src/handlers/story-authority-resolve.ts',
  'packages/main/src/core/story-authority-resolver.ts',
]);

export const LEGACY_DELIVERY_COMPAT_MODULE = 'packages/main/src/core/legacy-delivery-claims-compat.ts';

export const CANONICAL_AST_FINGERPRINT_ALGORITHM = 'typescript-printer-remove-comments-sha256-v1';

export type ApprovedCompatibilityCallShape =
  | 'persisted-delivery-validator'
  | 'persistable-delivery-claims'
  | 'delivery-context-report-claims'
  | 'closeout-smoke-delivery-claims';

export const approvedLegacyDeliveryCompatUsages = new Map<string, {
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

export const PINNED_EXECUTABLE_SOURCE_FINGERPRINTS = new Map<string, string>([
  [LEGACY_DELIVERY_COMPAT_MODULE, 'b2c006a5becbd456a5728bb7615cf999cb514137383bc935b128073240899d98'],
  // B-45a0 F-419: repinned after adding a receipt-bound checklist policy for
  // the one canonical stale-evidence refresh writer. Compatibility symbols and
  // their approved call shapes remain independently checked above. Repinned
  // again when main's proof-or-stop rename merged into that same file.
  // 2026-09-19 re-approval: Main review-retention changes through 9b7342fa929f narrow direct-write retention;
  // Legacy symbols, occurrence counts and approved call expressions are unchanged.
  // Canonical digest fb21d100ac76f9211b3311c04c94e7d8856bc974e29292c8b3485cab485263f5
  // -> 68d86faa065e9137986d20775fa8d72ab8e71af6ddf648c9ab94d48be2db7467.
  // Complete prior-pin diffs and machine-compared call inventories:
  // docs/audits/validation-entrypoint-pin-review-20260919.md.
  ['packages/main/src/core/closeout-trust.ts', '68d86faa065e9137986d20775fa8d72ab8e71af6ddf648c9ab94d48be2db7467'],
  // B-f458: repinned after an internal transcript-path constant rename; the
  // legacy compatibility symbols, approved call shapes, and occurrence counts above are unchanged.
  // Claude source audit: only static import and integrity-error rethrow changed; compatibility producers and loader surface unchanged.
  ['packages/main/src/handlers/delivery-context-pack.ts', '7c345270f67ccc96bde83280cc2cf2fee2d7b7652b15cfc3e1e4b5b7f97c6fd9'],
  // B-235e: repinned after closeout fixtures began hashing the frozen legacy
  // role body instead of an empty prompt. Approved compatibility calls and
  // occurrence counts remain mechanically checked by the manifest above.
  // B-a7c5 F-010: repinned again after adding a satisfying dev_memory_finish_decision
  // write to the 'B-receipt' fixture (CHK-003's new DONE-gate check runs before
  // the review_lane_missing diagnostic this file exists to test). No approved
  // call shape or occurrence count changed; the whole-file structural
  // fingerprint just moves with any source edit to this file.
  // B-1e1f: repinned after persistSyntheticAdmittedWindowForTest; approved call shapes/occurrence counts unchanged.
  // B-45a0 F-421: repinned with executable checks that canonical checklist
  // refresh lineage retains review while checklist_update remains rejected.
  // B-5a15 main-merge repin basis (F-361 correction). The prior note credited main's
  // persistSyntheticAdmittedWindowForTest, but that symbol ALREADY EXISTS on main
  // (grep -c = 2), so it is not what moved this branch's pin. The THREE real divergences
  // (F-364 correction: a fourth item was listed that credited an UNCHANGED pre-existing main
  // row -- the same false-attribution class F-361 and F-363 each removed; deleted, not reworded):
  //  1. a NEW canonical writer 'topology_critic_receipt_set' (absent from main, grep -c = 0)
  //     plus its 'topology-critic-receipt.json' closeout-evidence registry row -- and note that
  //     row is the ONLY main...HEAD divergence in core/closeout-trust.ts (1 file, 1 insertion);
  //  2. a deriveCertificationDomainInputHashes fixture with causalInputHashes threading;
  //  3. an acquireOwnerLease seed for the verifier owner lease.
  // Approved compatibility surface is UNCHANGED, stated PER FILE (F-363 correction: the earlier
  // wording mis-scoped one count and credited an unchanged symbol):
  //   core/closeout-trust.ts      -> isExactLegacyLocalOnlyDeliveryClaims 2, LegacyLocalOnlyDeliveryClaims 2
  //   tasks/closeout-trust-smoke.ts -> createLegacyLocalOnlyDeliveryClaims 2 (this file has ZERO
  //   occurrences of isExactLegacyLocalOnlyDeliveryClaims; that count belongs to the row above).
  // NOT a divergence: verification_evidence_refresh_stale is 4 on BOTH branches and does not
  // appear in this file's main...HEAD diff at all, so it did not move the pin.
  // The AST algorithm strips comments, so this note is the ONLY durable record of the
  // human re-approval.
// Merge audit: fixed loader/provenance and compatibility call shapes retained; see merge pin audit.
  // B-137a main-merge repin. AUDITED BEFORE repinning: `git diff main` on this
  // file is ONE line -- createDeliveryCheckHandlers now receives the
  // `{ authorizeNativeInvocation }` seam this story added. Grepping that diff for
  // every dynamic-execution construct this guard tracks reports no match, so the
  // executable dynamic-code structure is unchanged and only the whole-file
  // structural fingerprint moves.
  ['packages/main/src/tasks/closeout-trust-smoke.ts', 'ca1a6aa99b2413a4bdfb31fa59c7f327ad55ec837f8107348de68935ee28e22b'],
  // B-1507 CHK-001: repinned after verification_run was added to
  // MILESTONE_STATUS_APPEND_COMMANDS in cli-engine.ts. The approved non-literal
  // loader call site (runCli → import(`file://${initPath}`)) is unchanged; this
  // whole-file structural fingerprint gates both that call-site approval and the
  // pinned-source drift check, so it moves with any cli-engine.ts edit.
  // B-cdf6 CHK-002: repinned after the user-facing bin rename made the CLI's own
  // hint/error strings derive from the invoked bin token (proof-or-stop, with
  // proof-or-stop kept as a deprecated alias). Only string interpolation and the
  // redundant-bin-token tolerance changed; the approved non-literal loader call
  // site above is untouched, and no new dynamic load was introduced.
  // B-cdf6:F-057 — REPINNED, and the guard was right to fail. This fingerprint covers
  // the WHOLE file by design, so any edit invalidates the approved non-literal loader
  // call site until a human re-approves it. Commit 8f42f1113e (F-047) changed one
  // string in this file (`proofOrStop: from-draft metadata` -> canonical) and the pin was
  // not refreshed, so the smoke went red on this branch while passing on main.
  //
  // Re-approval basis, checked before repinning rather than after: `git diff main...HEAD`
  // on cli-engine.ts touches ZERO import()/require() calls, arguments, or path
  // producers — every change is a brand string, an env read routed through
  // readBrandEnv, or the bin-name check. The approved call site itself
  // (anchor runCli, argument `file://${initPath}`) is byte-identical to main, so the
  // loader behaviour being approved is unchanged.
  // Repinned again by commit 32a083b987 (delivery-review follow-up), which added a
  // BRAND_ENV_PREFIX import and rewrote ONE diagnostic string so the timeout-budget
  // line stops teaching the deprecated env-var name. Re-approval basis, checked
  // before repinning rather than after: `git diff main...HEAD` on cli-engine.ts still
  // touches ZERO import()/require() calls, arguments, or path producers, and the
  // approved call site itself (anchor runCli, `await import(\`file://${initPath}\`)`,
  // with its initPath producer) is byte-identical to main — only its line number moved
  // (807 -> 812). The loader behaviour being approved is therefore unchanged; the digest
  // moved solely because this algorithm fingerprints the whole enclosing file.
  // B-6693 (merged in): repinned again after direct validate joined the structured
  // watchdog while DONE-result classification remained separate. The approved
  // non-literal loader still has the same runCli anchor, cli-init initPath producer,
  // and import(`file://${initPath}`) call site. The relocation, producer mutation,
  // nested-anchor, and loader-replacement controls below still make this pin bite.
  //
  // Repinned once more when main was merged into the B-cdf6 rename branch: the merged
  // file carries both sides, so its digest matched neither parent's pin. Re-approval
  // basis, checked before repinning rather than after: the complete dynamic-load surface
  // is byte-identical across ours, theirs, and the merge — exactly two calls,
  // `await import('./dashboard.js')` and `await import(`file://${initPath}`)`, with the
  // same initPath producer and the same runCli anchor. No import()/require() call,
  // argument, or path producer was added, removed, or rewritten; only the approved call
  // site's line number moved (809/814 -> 814). As always, BOTH coupled copies of this
  // digest (here and in scripts/verify-process-fact-contract.mjs) were updated together.
  // B-5a88: repinned after the retired-bin PARSE-tolerance fix. Re-approval basis,
  // checked before repinning rather than after: `git diff` on cli-engine.ts since the
  // previous pin is exactly TWO lines — one static named import added
  // (STRIPPABLE_BIN_TOKENS from ./cli/alias-normalizer.js) and one identifier swapped
  // inside a boolean test (PROOF_OR_STOP_BIN_NAMES -> STRIPPABLE_BIN_TOKENS on the
  // redundant-bin `version` fast path). ZERO import()/require() calls, arguments, or
  // path producers were added, removed, or rewritten: the dynamic-load surface is still
  // exactly `await import(`file://${initPath}`)` (line 815, same runCli anchor and same
  // cli-init initPath producer) and `await import('./dashboard.js')` (line 827). The
  // digest moved solely because this algorithm fingerprints the whole enclosing file.
  // BOTH coupled copies of this digest (here and in
  // scripts/verify-process-fact-contract.mjs) were updated together.
  // B-5a88 F-502: repinned again after removing the now-dead
  // PROOF_OR_STOP_BIN_NAMES import that the parse-tolerance fix left behind.
  // Re-approval basis, checked before repinning rather than after: the diff is a
  // SINGLE DELETED import specifier line. ZERO import()/require() calls, arguments,
  // or path producers changed; the dynamic-load surface is still exactly
  // `await import(`file://${initPath}`)` (line 814, same runCli anchor and cli-init
  // initPath producer) and `await import('./dashboard.js')` (line 826). Both coupled
  // copies of this digest were updated together.
  // origin/main merge: repinned because the toolchain moved, NOT the code. origin's
  // lockfile brings typescript 5.9.3, and canonicalAstFingerprint prints through
  // ts.createPrinter, so every AST-keyed digest in this file shifts. Re-approval basis
  // checked BEFORE repinning: cli-engine.ts's dynamic-code surface is byte-identical to
  // pre-merge main -- a diff of every import()/require()/eval()/new Function() line
  // reports NO difference, the approved call site is still the same runCli anchor with
  // the same `await import(`file://${initPath}`)` shape at the same line 815, and the
  // initPath producer is unchanged. Loader behaviour being approved is unchanged.
  // v0.3.300 merge audit: the session watchdog/static-import work and the
  // Finding identity command registrations are both retained. The runCli
  // initPath producer and non-literal loader relation remain unchanged.
  //
  // The exact merged AST fingerprint is independently mirrored in the process
  // fact verifier and is replaced only after the merged-source audit runs.
  // Merged-source audit: origin/main d354d2b43d measured b4f27e9a, already
  // stale against the old b9eb52d0 pin. Candidate measures 52a283cf. The new
  // withValidationSigningRoot arrow preserves the runCli function anchor and
  // exact initPath producer/import argument. Both coupled pins move together;
  // this whole-file binding does not assert a separate loader provenance graph.
  // 2026-09-20 merge re-approval: the owner-lease admission change adds no
  // loader call and preserves the exact initPath producer/import argument.
  ['packages/main/src/cli-engine.ts', '631ac1fde46c71126614b7ad293fedc43a79b14c166b10d2f8b7e3cd2b69d408'],
  ['packages/main/src/verifier/serve.ts', 'c13ec647c3fe547c4430390779b28da2620d5db24d8ba8609ec6142968f89739'],
  ['packages/main/src/tasks/parent-roadmap-totality-smoke.ts', '1bf3f1ebd8b63e66965966228a147748c48370bb6bbdf688ff1be149aa4aa82f'],
  ['packages/main/src/tasks/experience-layer-digest-extract-smoke.ts', 'f215f9c4e894a84ba7e2e844324902fcd2dec1e208e4259d64e2c447f1c85a83'],
]);

export const DYNAMIC_CODE_GENERATION_FINGERPRINT_EXEMPTIONS = new Map<string, string>([
  // B-49df: this test executes the fixed repository-local tracer's asserted private
  // kernel, never an environment/CLI/network payload. This is a WHOLE exact test-file
  // exemption via the existing early return, not a call-site-only exemption. The
  // per-entry executable-drift negative below must invalidate this approval.
  ['packages/main/src/tasks/validation-runtime-tracer-transparency-smoke.ts', '887ef97b62f1ed886cfec54a2004ec1f858697fad92c7bd201c1660cf5ffc895'],
  // B-022e re-attestation: only verifier runtime identity tokens changed;
  // the exact-file exemption remains narrow and mutation-sensitive.
  ['packages/main/src/verifier/browser-client.ts', '6db7549862141be655e34094323763762511bd00b05f45af4d77c097c7e0dc4f'],
  ['packages/main/src/handlers/decision-doc-quorum.ts', '6025f602afdc354a31333b61b516cb29aa1b59387806d69e6981d5a9ed3969b7'],
  // Same B-022e identity-only re-attestation for the task-side browser client.
  ['packages/main/src/tasks/browser-client.ts', '9d09bfd90b67cfa559095b82c8a7012871f0b4d0d38f7ec68941c4f5d0b5e772'],
  // B-022e identity-only re-attestation for the Python fixture module label.
  ['packages/main/src/handlers/fixture-executors.ts', 'efac815e5c27ce69c10c038846f53d99631617a75b97e0ee649844202f203822'],
  // B-1734: bin/bootstrap-runner.js gained a build-aware importDistModules() wait loop
  // (F-003/C4). Its runCli(...) and register(...) calls now resolve their callee through
  // `await importDistModules()` (an opaque any-returning local function) instead of the
  // previous inline `await Promise.all([import(),import()])` tuple, so the callee
  // provenance is classified 'unresolved-index-source'. These are the SAME benign
  // dynamically-imported dist entry points bootstrap-runner has always invoked; the
  // refactor added NO eval/Function/new dynamic import(). Whole-source exemption pinned to
  // the exact post-refactor fingerprint — any drift re-triggers the full dynamic-code scan.
  // Repinned when main was merged into the B-cdf6 rename branch: the merged file is that
  // same post-refactor source plus exactly three brand-text lines (two console.error
  // strings and one comment), verified by diffing against the MERGE_HEAD copy. No
  // eval/Function/require/import() was added, so this exemption's basis is unchanged.
  //
  // B-bcae CHK-003 REPIN, and unlike every re-approval above this one DID add a dynamic
  // import, so the basis is restated rather than carried forward. The two-target lock
  // protocol (CL-004/006/007/008) moved this structural digest off main's
  // d1542f5222...b927e26. Basis checked BEFORE repinning, by diffing the dynamic-code
  // surface of `main` against this file: exactly one construct is NEW —
  // `await import(pathToFileURL(join(repoRoot, 'scripts', 'build-lock.mjs')).href)` at the
  // top of importDistModules() — and one is REWRITTEN in place, the LAB_DIST import moving
  // into a returned object literal with the same specifier and the same producer. Nothing
  // else moved, and the file still contains NO eval, no Function/new Function, no vm, no
  // runInNewContext and no require().
  //
  // The new import is in the same benign class as the five already approved here: a
  // first-party repository-local sibling whose specifier is `pathToFileURL(join(...)).href`
  // over `repoRoot` — itself `dirname(dirname(fileURLToPath(import.meta.url)))` — plus two
  // string literals, so no argv, env or user value can reach it. It is dynamic for a stated
  // reason, not for convenience: build-lock.mjs imports proper-lockfile, which is absent in
  // a fresh checkout without node_modules, so a static import would throw
  // ERR_MODULE_NOT_FOUND at module init before the actionable recovery hint can print —
  // which is why its dependency-free half (build-lock-target.mjs) IS statically imported
  // above. The exemption stays exactly as narrow: one file, one exact digest, and any
  // further drift re-triggers the full dynamic-code scan.
  // 2026-09-19 re-approval: Main 677b259fc8d7 and c25111ba48ba preserve actionable mismatch diagnostics;
  // No loader/eval/Function/require/vm call was added or changed.
  // Canonical digest d0fa3e4ebad2c985e96f1faa64cd3ca7eac35492203f0eacc121e260298e715e
  // -> 19b243083de02b86b17a76c104222709b35cc223b3a5e2ad4d40ff86e99ad0ed.
  // Complete prior-pin diffs and machine-compared call inventories:
  // docs/audits/validation-entrypoint-pin-review-20260919.md.
  ['bin/bootstrap-runner.js', '19b243083de02b86b17a76c104222709b35cc223b3a5e2ad4d40ff86e99ad0ed'],
  // B-3e16 CHK-003: the graph handler invokes five members on the module object returned by
  // its approved runtime import — lib.findRoot, lib.createApp (x2), lib.startServer,
  // lib.openBrowser. Because that module object comes from a non-literal import(), the
  // callee provenance classifies as 'unresolved-nested-member', which this scan treats as
  // dynamic code generation. These are ordinary typed calls into a first-party sibling
  // package (typed here by the GraphLibrary interface); the handler adds NO
  // eval/Function/vm/new import().
  //
  // (a) WHY THE LOAD ITSELF CANNOT BE STATIC and why its argument IS `--root`-influenceable
  // are recorded in full on the knownBenignNonLiteralLoaderCalls entry for this file; read
  // that before re-approving here. (b) The same trust model is already accepted in this
  // codebase for verifier/serve.ts startCircuitServe.
  //
  // (c) SCOPE COST, ACCEPTED KNOWINGLY: this map is consumed by a single whole-file early
  // return at the top of scanDynamicCodeGeneration(). Once pinned it suppresses ALL
  // dynamic-code-generation findings in graph.ts, not merely the five named call sites — a
  // future sixth pattern in this file inherits the exemption SILENTLY until some unrelated
  // code edit moves the fingerprint and forces a re-pin. That is the same cost already
  // assertLoaderArgumentProvenance(), not the breadth of this entry.
    // B-9f2c RE-APPROVAL (2nd, after merging main): main commit 3aa57145d8 edited this
  // handler again (on-demand client build, adding spawnSync), revoking the pin a second
  // time. NOTE that commit landed on main WITHOUT re-pinning, so the guard was already
  // failing on main itself before this story merged it. Re-approved after verifying the
  // dynamic-code surface here is byte-identical to main's own reviewed version: a
  // normalized diff of every await import(...) / createRequire(...) / eval( /
  // new Function( / spawnSync( occurrence against main reports NO difference. The
  // original --story flag rationale still applies and is kept below.
  // B-9f2c RE-APPROVAL: the --story flag edited this handler, which revoked the pin
  // by design. Re-approved after verifying the DYNAMIC-CODE SURFACE IS UNCHANGED: the
  // five loader call sites are byte-identical to main (normalized diff of every
  // `await import(...)` / `createRequire(...)` / `eval(` / `new Function(` occurrence
  // reports no difference); the story flag adds only string validation and URL
  // construction, introduces no import()/require()/eval()/Function(), and does not
  // widen the `--root`-influenceable argument path this approval already accepts.
// Merge audit: fixed loader/provenance and compatibility call shapes retained; see merge pin audit.
  // e15e0bbc2f adds only the statically imported readManagedRunDashboard callback
  // to both createApp options. Runtime module resolution/import targets and
  // eval/Function surfaces are unchanged; exact mutation-sensitive pin retained.
  ['packages/main/src/handlers/graph.ts', 'aee0b8f72d15f79121d14a4805891fae125b76bc9de1cbe073a28ffe90a8eddf'],
  // origin/main merge: same two-parent substitution as the benign-loader map -- origin's
  // sixth slot was packages/main/src/cli.ts, ours was handlers/graph.ts, and the merged
  // tree carries both. cli.ts needs this because `lab.createLabToolDefs` / `lab.register`
  // are members of a package this repo does not link (no npm workspaces are configured,
  // so @proof-or-stop/lab is unresolvable) and the checker reports them as
  // unresolved-nested-member. Exact whole-source pin, no pattern; the digest is our
  // computed value for a cli.ts that is byte-identical to pre-merge main.
  ['packages/main/src/cli.ts', 'af73220a107a159f461b41cf6e22e2649c5fc89b75a270d18ffde1354c83605b'],
]);

export const DYNAMIC_CODE_ANALYSIS_PREFILTER = /(?:\beval\w*|\bFunction\b|\bconstructor\b|\brunIn(?:Context|NewContext|ThisContext)\b|\bcompileFunction\b|\bSourceTextModule\b|\bSyntheticModule\b|\brequire\s*(?:\(|\.|\b)|\bimport\s*\()/;

export const DYNAMIC_PROVENANCE_REACHABILITY_LABELS = new Set([
  'inline conditional safe target negative',
  'deterministic final safe namespace reassignment negative',
  'nested default namespace safe negative',
  'cyclic nested namespace safe negative',
  'escaped local property safe negative',
  'logical conditional then final safe namespace negative',
  'then returned local callback safe negative',
  'catch returned local callback safe negative',
  'finally returned eval ignored safe negative',
  'finally no callback safe negative',
  'then destructured safe callback negative',
  'then Promise resolve safe callback negative',
  'then async local callback safe negative',
  'then safe thenable callback negative',
  'promise allSettled value safe negative',
  'local literal safe named member negative',
  'parameter local safe callsite negative',
  'mutable callable deterministic final safe negative',
  'local method deterministic final safe negative',
  'parameter call local safe negative',
  'parameter apply local safe negative',
  'parameter bind local safe negative',
  'rest parameter index local safe negative',
  'rest parameter destructured local safe negative',
  'rest parameter mixed local safe negative',
  'optional parameter local safe negative',
  'computed call local safe negative',
  'computed apply local safe negative',
  'computed bind local safe negative',
  'spread direct local safe negative',
  'spread rest mixed local safe negative',
  'full vector spread call local safe negative',
  'full vector spread apply local safe negative',
  'computed full vector spread bind local safe negative',
]);

export const DYNAMIC_CODE_UNAPPROVED_ONLY_LABELS = new Set([
  'namespace safe named reexport eval benign fail closed',
]);

export const structuralLegacyFieldQuarantineFiles = new Set([
  'packages/main/src/cli/command-catalog.ts',
  'packages/main/src/core/autopilot.ts',
  'packages/main/src/core/autopilot-executor.ts',
  'packages/main/src/core/autopilot-policy.ts',
  'packages/main/src/core/canonical-story.ts',
  'packages/main/src/core/capabilities.ts',
  'packages/main/src/core/command-policy.ts',
  'packages/main/src/core/dispatch-policy.ts',
  'packages/main/src/core/dispatch-runner.ts',
  'packages/main/src/core/proof-or-stop-autopilot.ts',
  'packages/main/src/core/proof-or-stop-dispatch.ts',
  'packages/main/src/core/proof-or-stop-evidence.ts',
  'packages/main/src/core/proof-or-stop-handoff.ts',
  'packages/main/src/core/proof-or-stop-hosts.ts',
  'packages/main/src/core/proof-or-stop-parallel-wave.ts',
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
  'packages/main/src/handlers/proof-or-stop-autopilot.ts',
  'packages/main/src/handlers/proof-or-stop-cli.ts',
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

export const legacyFieldNames = [
  'authorityDone',
  'fullAuthorityDone',
  'productionDone',
  'receiptVerified',
  'authorityChanged',
  'productionDoneEligible',
  'productionDoneProviders',
] as const;

export const legacyFieldAlternation = legacyFieldNames.join('|');

export const renderedLegacyFieldPattern = new RegExp(String.raw`['"\`][^'"\`]*\b(?:${legacyFieldAlternation})\s*:`);

export const quotedLegacyFieldLinePattern = new RegExp(String.raw`^\s*['"\`](?:${legacyFieldAlternation})['"\`],?\s*$`);

export const bareLegacyFieldLinePattern = new RegExp(String.raw`^\s*(?:${legacyFieldAlternation}),?\s*$`);

export const fieldShapePattern = new RegExp(String.raw`\b(?:${legacyFieldAlternation})\??\s*:`);

export const propertyDeclarationPattern = new RegExp(String.raw`^\s*(?:readonly\s+)?(?:${legacyFieldAlternation})\??\s*:`);

export const propertyAssignmentPattern = new RegExp(String.raw`^\s*(?:const|let|var)?\s*(?:${legacyFieldAlternation})\b\s*=`);

export const objectMemberPattern = new RegExp(String.raw`\b(?:args|result|record|report|summary|authority|input|policy|policyRecord|value)\.(?:${legacyFieldAlternation})\b`);

export const bracketMemberPattern = new RegExp(String.raw`\[['"\`](?:${legacyFieldAlternation})['"\`]\]`);

export const callArgumentPattern = new RegExp(String.raw`\b(?:productionDone|authorityDone|fullAuthorityDone)\b[),]`);
