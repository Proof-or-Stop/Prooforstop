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
  sourceFingerprint: string;
}>([
  ['packages/main/src/core/closeout-trust.ts', {
    symbols: ['isExactLegacyLocalOnlyDeliveryClaims', 'LegacyLocalOnlyDeliveryClaims'],
    calls: { isExactLegacyLocalOnlyDeliveryClaims: ['persisted-delivery-validator'] },
    occurrences: { isExactLegacyLocalOnlyDeliveryClaims: 2, LegacyLocalOnlyDeliveryClaims: 2 },
    sourceFingerprint: 'ccd079414da1e7aabbbc9afcd96a25ef37ae72d50d6817c340b37f152f711b06',
  }],
  ['packages/main/src/handlers/delivery-context-pack.ts', {
    symbols: ['createLegacyLocalOnlyDeliveryClaims', 'LegacyLocalOnlyDeliveryClaims'],
    calls: { createLegacyLocalOnlyDeliveryClaims: ['persistable-delivery-claims', 'delivery-context-report-claims'] },
    occurrences: { createLegacyLocalOnlyDeliveryClaims: 3, LegacyLocalOnlyDeliveryClaims: 3 },
    sourceFingerprint: '2b3dfbe3073c3a8e2fa7e1c8bf93c84ec34ad63b56ed8cb59edce1aa563719d3',
  }],
  ['packages/main/src/tasks/closeout-trust-smoke.ts', {
    symbols: ['createLegacyLocalOnlyDeliveryClaims'],
    calls: { createLegacyLocalOnlyDeliveryClaims: ['closeout-smoke-delivery-claims'] },
    occurrences: { createLegacyLocalOnlyDeliveryClaims: 2 },
    sourceFingerprint: 'd252c161562e00797371438a52f16c889e10a0551673e24b62162978b7447c3e',
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
const typeCheckerCache = new Map<string, { text: string; checker: ts.TypeChecker }>();

function parseSource(file: string, text: string): ts.SourceFile {
  const cached = parsedSourceCache.get(file);
  if (cached?.text === text) return cached.source;
  const scriptKind = /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
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

function typeCheckerFor(file: string, text: string): ts.TypeChecker {
  const cached = typeCheckerCache.get(file);
  if (cached?.text === text) return cached.checker;
  const source = parseSource(file, text);
  const options: ts.CompilerOptions = { noResolve: true, target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext };
  const host: ts.CompilerHost = {
    getSourceFile: candidate => candidate === file ? source : undefined,
    getDefaultLibFileName: () => '',
    writeFile: () => undefined,
    getCurrentDirectory: () => '',
    getDirectories: () => [],
    fileExists: candidate => candidate === file,
    readFile: candidate => candidate === file ? text : undefined,
    useCaseSensitiveFileNames: () => true,
    getCanonicalFileName: candidate => candidate,
    getNewLine: () => '\n',
  };
  const checker = ts.createProgram([file], options, host).getTypeChecker();
  typeCheckerCache.set(file, { text, checker });
  return checker;
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

function isGlobalIdentifier(node: ts.Identifier, checker: ts.TypeChecker, name: string): boolean {
  return node.text === name && checker.getSymbolAtLocation(node) === undefined;
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
  const source = parseSource(file, text);
  const checker = typeCheckerFor(file, text);
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

interface CompatibilityImportBinding {
  importedName: string;
  localName: string;
  declaration: ts.ImportSpecifier;
}

function compatibilityImportBindings(file: string, source: ts.SourceFile): Map<string, CompatibilityImportBinding> {
  const bindings = new Map<string, CompatibilityImportBinding>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || !moduleSpecifierResolvesTo(file, statement.moduleSpecifier.text, LEGACY_DELIVERY_COMPAT_MODULE)) continue;
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
): ts.Identifier[] {
  const bindings = compatibilityImportBindings(file, source);
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
  sourceFingerprint: string;
  calls: readonly { anchor: string; argument: string }[];
}>([
  ['packages/main/src/cli-engine.ts', {
    sourceFingerprint: '878828adf7881dc809bfca0e6e4daa506053fb6565aa1ec69c99626fef64f16a',
    calls: [{ anchor: 'runCli', argument: '`file://${initPath}`' }],
  }],
  ['packages/main/src/verifier/serve.ts', {
    sourceFingerprint: '20149fa438b1ec78fc9c9713eb3cc4a890bc58a1d82e7a5fa0d588e9c4e7ee91',
    calls: [{ anchor: 'startCircuitServe', argument: '`file://${filePath}`' }],
  }],
  ['packages/main/src/tasks/parent-roadmap-totality-smoke.ts', {
    sourceFingerprint: '518890b58fd8e369488721d66d954f9589a049a42066635f42c057227788ae45',
    calls: [{ anchor: 'loadRuntime', argument: 'modulePath' }],
  }],
  ['packages/main/src/tasks/experience-layer-digest-extract-smoke.ts', {
    sourceFingerprint: 'f215f9c4e894a84ba7e2e844324902fcd2dec1e208e4259d64e2c447f1c85a83',
    calls: [{ anchor: 'run', argument: "join(MAIN_DIR, 'dist', 'handlers', 'decision-doc-promotion.js')" }],
  }],
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
  if (!approved || canonicalAstFingerprint(file, source.text) !== approved.sourceFingerprint) return false;
  const anchor = enclosingFunctionName(call);
  const argument = call.arguments[0]?.getText(source);
  return Boolean(anchor && argument && approved.calls.some(entry => (
    entry.anchor === anchor && entry.argument === argument
  )));
}

function scanConcealedCompatibilityLoads(file: string, text: string): Violation[] {
  const source = parseSource(file, text);
  const checker = typeCheckerFor(file, text);
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
  const checker = typeCheckerFor(file, text);
  const concealedLoadViolations = scanConcealedCompatibilityLoads(file, text);
  const compatImports = extractImportSpecifiers(text, file)
    .filter(({ specifier }) => moduleSpecifierResolvesTo(file, specifier, LEGACY_DELIVERY_COMPAT_MODULE));
  const approved = approvedLegacyDeliveryCompatUsages.get(file);
  const violations: Violation[] = [...concealedLoadViolations];
  if (approved) {
    const actualSourceFingerprint = canonicalAstFingerprint(file, text);
    if (actualSourceFingerprint !== approved.sourceFingerprint) {
      violations.push({
        file,
        line: 1,
        label: 'legacy delivery compatibility structural fingerprint drift',
        text: `${CANONICAL_AST_FINGERPRINT_ALGORITHM}: expected ${approved.sourceFingerprint}, got ${actualSourceFingerprint}; review executable structure before updating the pinned fingerprint`,
      });
    }
  }
  if (compatImports.length === 0) return violations;
  if (!approved) {
    return [...concealedLoadViolations, ...compatImports.map(({ specifier, index }) => ({
      file,
      line: lineNumberAt(text, index),
      label: 'unapproved legacy delivery compatibility import',
      text: specifier,
    }))];
  }

  const compatBindings = compatibilityImportBindings(file, source);
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
  for (const reference of disallowedCompatibilityValueReferences(source, approved, file, checker)) {
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
  const source = parseSource(file, text);
  const checker = typeCheckerFor(file, text);
  // Approved importers are a closed structural whitelist. Any real value-binding
  // reference outside the exact canonical parent chains makes the module a
  // potential exporter; graph scanning then rejects every downstream import.
  // This intentionally avoids pretending to solve arbitrary JavaScript taint.
  return canonicalAstFingerprint(file, text) !== approved.sourceFingerprint
    || disallowedCompatibilityValueReferences(source, approved, file, checker).length > 0;
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
  assert.ok(postConstructionViolations.some(violation => violation.label === 'legacy delivery compatibility structural fingerprint drift'), 'post-call assignment of canonical report.claims into an exported container must invalidate the complete importer fingerprint');
  assert.equal(directlyExportsCompatibilityBinding(approvedProducer, postConstructionContainerMutation), true, 'post-call exported-container mutation must taint downstream module edges even when compatibility binding references remain canonical');

  const shadowedProducer = `${readRel(approvedProducer)}\nexport function harmlessShadow(createLegacyLocalOnlyDeliveryClaims: () => string) { return createLegacyLocalOnlyDeliveryClaims(); }\n`;
  const shadowedViolations = scanLegacyDeliveryCompatibilityUsage(approvedProducer, shadowedProducer);
  assert.ok(shadowedViolations.some(violation => violation.label === 'legacy delivery compatibility structural fingerprint drift'), 'even a shadowed same-name executable addition requires intentional importer fingerprint review');
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
