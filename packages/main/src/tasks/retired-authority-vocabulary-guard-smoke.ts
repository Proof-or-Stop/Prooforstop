#!/usr/bin/env node
/**
 * Retired authority vocabulary guard.
 *
 * This is the active vocabulary gate for
 * docs/requirements/decisions/authority-server-vocabulary-retirement.md.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
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
  'packages/main/src',
  'packages/main/templates/agents',
] as const;

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
const approvedLegacyDeliveryCompatUsages = new Map<string, {
  symbols: readonly string[];
  calls: Readonly<Record<string, number>>;
  occurrences: Readonly<Record<string, number>>;
  directUsePattern: RegExp;
  directUseCount: number;
}>([
  ['packages/main/src/core/closeout-trust.ts', {
    symbols: ['isExactLegacyLocalOnlyDeliveryClaims', 'LegacyLocalOnlyDeliveryClaims'],
    calls: { isExactLegacyLocalOnlyDeliveryClaims: 1 },
    occurrences: { isExactLegacyLocalOnlyDeliveryClaims: 2, LegacyLocalOnlyDeliveryClaims: 2 },
    directUsePattern: /if \(!isExactLegacyLocalOnlyDeliveryClaims\(claims\)\)/g,
    directUseCount: 1,
  }],
  ['packages/main/src/handlers/delivery-context-pack.ts', {
    symbols: ['createLegacyLocalOnlyDeliveryClaims', 'LegacyLocalOnlyDeliveryClaims'],
    calls: { createLegacyLocalOnlyDeliveryClaims: 2 },
    occurrences: { createLegacyLocalOnlyDeliveryClaims: 3, LegacyLocalOnlyDeliveryClaims: 3 },
    directUsePattern: /claims:\s*createLegacyLocalOnlyDeliveryClaims\(\)/g,
    directUseCount: 2,
  }],
  ['packages/main/src/tasks/closeout-trust-smoke.ts', {
    symbols: ['createLegacyLocalOnlyDeliveryClaims'],
    calls: { createLegacyLocalOnlyDeliveryClaims: 1 },
    occurrences: { createLegacyLocalOnlyDeliveryClaims: 2 },
    directUsePattern: /claims:\s*createLegacyLocalOnlyDeliveryClaims\(\)/g,
    directUseCount: 1,
  }],
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

function listFiles(dir: string, extensions: readonly string[]): string[] {
  const abs = join(repoRoot, dir);
  if (!existsSync(abs)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(abs)) {
    const full = join(abs, entry);
    const rel = relative(repoRoot, full);
    if (rel.split('/').includes('.omx')) continue;
    const stat = statSync(full);
    if (stat.isDirectory()) {
      found.push(...listFiles(rel, extensions));
    } else if (extensions.some(ext => entry.endsWith(ext))) {
      found.push(rel);
    }
  }
  return found;
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

function parseSource(file: string, text: string): ts.SourceFile {
  const cached = parsedSourceCache.get(file);
  if (cached?.text === text) return cached.source;
  const scriptKind = /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind);
  parsedSourceCache.set(file, { text, source });
  return source;
}

function staticModuleText(node: ts.Expression): string | undefined {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
}

function extractImportSpecifiers(text: string, file = '<module-scan>.ts'): ModuleReference[] {
  const source = parseSource(file, text);
  const specifiers: ModuleReference[] = [];
  const add = (node: ts.Expression, kind: ModuleReferenceKind): void => {
    const specifier = staticModuleText(node);
    if (specifier !== undefined) specifiers.push({ specifier, index: node.getStart(source), kind });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) add(node.moduleSpecifier, 'import');
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier) add(node.moduleSpecifier, 'export');
    else if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression) add(node.moduleReference.expression, 'require');
    else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0], 'dynamic-import');
      else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') add(node.arguments[0], 'require');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

function normalizeModulePath(path: string): string {
  return path.replace(/\.(?:cjs|mjs|js|ts)$/, '');
}

function retiredModuleMatch(file: string, specifier: string): string | undefined {
  if (/\bstory-authority-resolv(?:e|er)\b/.test(specifier)) return 'retired story resolver module';
  if (!specifier.startsWith('.')) return undefined;
  const target = normalizeModulePath(join(dirname(file), specifier).replace(/\\/g, '/'));
  for (const retiredFile of retiredServerBackedModuleFiles) {
    if (target === normalizeModulePath(retiredFile)) return 'retired quarantined module specifier';
  }
  return undefined;
}

function moduleSpecifierResolvesTo(file: string, specifier: string, targetFile: string): boolean {
  if (!specifier.startsWith('.')) return false;
  const target = normalizeModulePath(join(dirname(file), specifier).replace(/\\/g, '/'));
  return target === normalizeModulePath(targetFile);
}

function identifierCount(source: ts.SourceFile, symbol: string): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === symbol) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
}

function directIdentifierCallCount(source: ts.SourceFile, symbol: string): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === symbol) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
}

function importedCompatSymbols(file: string, source: ts.SourceFile): string[] {
  const symbols: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || !moduleSpecifierResolvesTo(file, statement.moduleSpecifier.text, LEGACY_DELIVERY_COMPAT_MODULE)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      symbols.push(element.name.text === imported ? imported : `${imported} as ${element.name.text}`);
    }
  }
  return symbols;
}

function scanLegacyDeliveryCompatibilityUsage(file: string, text: string): Violation[] {
  if (file === LEGACY_DELIVERY_COMPAT_MODULE) return [];
  const source = parseSource(file, text);
  const compatImports = extractImportSpecifiers(text, file)
    .filter(({ specifier }) => moduleSpecifierResolvesTo(file, specifier, LEGACY_DELIVERY_COMPAT_MODULE));
  if (compatImports.length === 0) return [];
  const approved = approvedLegacyDeliveryCompatUsages.get(file);
  if (!approved) {
    return compatImports.map(({ specifier, index }) => ({
      file,
      line: lineNumberAt(text, index),
      label: 'unapproved legacy delivery compatibility import',
      text: specifier,
    }));
  }

  const violations: Violation[] = [];
  const actualSymbols = [...new Set(importedCompatSymbols(file, source))].sort();
  const expectedSymbols = [...approved.symbols].sort();
  if (compatImports.length !== 1 || JSON.stringify(actualSymbols) !== JSON.stringify(expectedSymbols)) {
    violations.push({
      file,
      line: lineNumberAt(text, compatImports[0].index),
      label: 'legacy delivery compatibility import surface drift',
      text: `expected ${expectedSymbols.join(',')} got ${actualSymbols.join(',') || 'none'}`,
    });
  }
  for (const [symbol, expectedCount] of Object.entries(approved.calls)) {
    const actualCount = directIdentifierCallCount(source, symbol);
    if (actualCount !== expectedCount) {
      violations.push({ file, line: 1, label: 'legacy delivery compatibility call-count drift', text: `${symbol}: expected ${expectedCount}, got ${actualCount}` });
    }
  }
  for (const [symbol, expectedCount] of Object.entries(approved.occurrences)) {
    const actualCount = identifierCount(source, symbol);
    if (actualCount !== expectedCount) {
      violations.push({ file, line: 1, label: 'legacy delivery compatibility symbol escape', text: `${symbol}: expected ${expectedCount} local occurrence(s), got ${actualCount}` });
    }
  }
  const directUseCount = (text.match(approved.directUsePattern) ?? []).length;
  if (directUseCount !== approved.directUseCount) {
    violations.push({ file, line: 1, label: 'legacy delivery compatibility usage drift', text: `expected ${approved.directUseCount} direct use(s), got ${directUseCount}` });
  }
  if (/\.\.\.\s*createLegacyLocalOnlyDeliveryClaims\s*\(/.test(text)) {
    violations.push({ file, line: 1, label: 'legacy delivery compatibility spread forbidden', text: 'constructor result may not be spread' });
  }
  const valueSymbols = Object.keys(approved.calls).join('|');
  const escapePatterns = [
    new RegExp(`\\bexport\\s+default\\s+(?:${valueSymbols})\\b`),
    new RegExp(`\\bexport\\s*\\{[^}]*\\b(?:${valueSymbols})\\b[^}]*\\}`),
    new RegExp(`\\bexport\\s+(?:const|let|var)\\s+\\w+\\s*=\\s*(?:${valueSymbols})\\b`),
    new RegExp(`\\b(?:const|let|var)\\s+\\w+\\s*=\\s*(?:${valueSymbols})\\s*;`),
    new RegExp(`\\b(?:module\\.exports|exports\\.\\w+|\\w+\\.\\w+)\\s*=\\s*(?:${valueSymbols})\\b`),
    new RegExp(`\\{[^}]*\\b\\w+\\s*:\\s*(?:${valueSymbols})\\b[^}]*\\}`),
  ];
  if (escapePatterns.some(pattern => pattern.test(text))) {
    violations.push({ file, line: 1, label: 'legacy delivery compatibility alias/export escape', text: 'compatibility value may only appear in its approved direct call site' });
  }
  return violations;
}

function directlyExportsCompatibilityBinding(file: string, text: string): boolean {
  const approved = approvedLegacyDeliveryCompatUsages.get(file);
  if (!approved) return false;
  const source = parseSource(file, text);
  const valueBindings = new Set(Object.keys(approved.calls));
  const containsValueBinding = (root: ts.Node): boolean => {
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (ts.isIdentifier(node) && valueBindings.has(node.text)) {
        found = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(root);
    return found;
  };
  const hasExportModifier = (node: ts.Node): boolean => (
    ts.canHaveModifiers(node)
    && (ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false)
  );

  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      if (statement.exportClause.elements.some(element => valueBindings.has((element.propertyName ?? element.name).text))) return true;
    }
    if (ts.isExportAssignment(statement) && containsValueBinding(statement.expression)) return true;
  }

  const usageDrift = Object.entries(approved.calls)
    .some(([symbol, expected]) => directIdentifierCallCount(source, symbol) !== expected)
    || Object.entries(approved.occurrences)
      .some(([symbol, expected]) => identifierCount(source, symbol) !== expected)
    || (text.match(approved.directUsePattern) ?? []).length !== approved.directUseCount;
  if (!usageDrift) return false;
  return source.statements.some(statement => hasExportModifier(statement) && containsValueBinding(statement));
}

function scanLegacyDeliveryCompatibilityGraph(fileTexts: ReadonlyMap<string, string>): Violation[] {
  const violations: Violation[] = [];
  const exporters = new Set<string>([normalizeModulePath(LEGACY_DELIVERY_COMPAT_MODULE)]);

  for (const [file, text] of fileTexts) {
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
      const normalizedFile = normalizeModulePath(file);
      for (const { specifier, index, kind } of extractImportSpecifiers(text, file)) {
        if (!specifier.startsWith('.')) continue;
        const target = normalizeModulePath(join(dirname(file), specifier).replace(/\\/g, '/'));
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
  return violations;
}

function shouldScanImports(file: string): boolean {
  return /^packages\/main\/src\/.*\.(?:cjs|js|ts)$/.test(file)
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

  const approvedProducer = 'packages/main/src/handlers/delivery-context-pack.ts';
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

  const matrix: Array<[string, string]> = [
    ['namespace import', "import * as compat from './legacy-delivery-claims-compat.js';\ncompat.createLegacyLocalOnlyDeliveryClaims();"],
    ['aliased named import', "import { createLegacyLocalOnlyDeliveryClaims as indirect } from './legacy-delivery-claims-compat.js';\nindirect();"],
    ['dynamic import', "const compat = await import('./legacy-delivery-claims-compat.js');\ncompat.createLegacyLocalOnlyDeliveryClaims();"],
    ['template-literal dynamic import', "const compat = await import(`./legacy-delivery-claims-compat.js`);\ncompat.createLegacyLocalOnlyDeliveryClaims();"],
    ['require import', "const compat = require('./legacy-delivery-claims-compat.js');\ncompat.createLegacyLocalOnlyDeliveryClaims();"],
    ['direct re-export', "export { createLegacyLocalOnlyDeliveryClaims } from './legacy-delivery-claims-compat.js';"],
  ];
  for (const [label, source] of matrix) {
    const matrixViolations = [
      ...scanLegacyDeliveryCompatibilityUsage(controlFile, source),
      ...scanLegacyDeliveryCompatibilityGraph(new Map([[controlFile, source]])),
    ];
    assert.ok(matrixViolations.length > 0, `${label} compatibility escape must be caught`);
  }

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
assertLegacyDeliveryCompatibilityPositiveControls();
assertContract();
violations.push(...assertCommandCatalog());

const activeFiles = [
  ...activeTextFiles,
  ...activeTextDirs.flatMap(dir => listFiles(dir, ['.md', '.json', '.cjs', '.js', '.ts'])),
].filter((file, index, all) => all.indexOf(file) === index);
const activeFileTexts = new Map<string, string>();

for (const file of activeFiles) {
  if (!existsSync(join(repoRoot, file))) continue;
  const text = readRel(file);
  activeFileTexts.set(file, text);
  violations.push(...scanText(file, text));
  violations.push(...scanImportSpecifiers(file, text));
  violations.push(...scanLegacyDeliveryCompatibilityUsage(file, text));
}
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
