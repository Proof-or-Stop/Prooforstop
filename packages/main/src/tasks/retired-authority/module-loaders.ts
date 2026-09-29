import assert from 'node:assert/strict';





import { dirname, join } from 'node:path';

import ts from 'typescript';


import { unwrapExecutionExpression } from "./dynamic-scan.js";
import { staticPropertyKeyExpression } from "./binding-classification.js";
import { ModuleReferenceKind, ModuleReference, lineNumberAt } from "./file-scan.js";
import { typeAnalysisFor, canonicalAstFingerprint } from "./type-analysis.js";
import { EXECUTABLE_SOURCE_EXTENSIONS, PackageAliasEdge, PACKAGE_ALIAS_EDGE_INVENTORY, StaticModuleResolution, resolvePackageAlias, retiredServerBackedModuleFiles, LEGACY_DELIVERY_COMPAT_MODULE, ApprovedCompatibilityCallShape, approvedLegacyDeliveryCompatUsages, PINNED_EXECUTABLE_SOURCE_FINGERPRINTS, Violation, CANONICAL_AST_FINGERPRINT_ALGORITHM } from "./rule-data.js";

export function staticModuleText(
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

export function collectConstStringValues(source: ts.SourceFile, checker: ts.TypeChecker): Map<ts.Symbol, string> {
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

export function containingImportDeclaration(specifier: ts.ImportSpecifier): ts.ImportDeclaration | undefined {
  const namedImports = specifier.parent;
  const importClause = namedImports.parent;
  return ts.isImportClause(importClause) && ts.isImportDeclaration(importClause.parent)
    ? importClause.parent
    : undefined;
}

export function isGlobalIdentifier(node: ts.Identifier, checker: ts.TypeChecker, name: string): boolean {
  if (node.text !== name) return false;
  const symbol = checker.getSymbolAtLocation(node);
  const declarations = symbol?.getDeclarations() ?? [];
  if (declarations.length === 0) {
    const type = checker.getTypeAtLocation(node);
    return Boolean(symbol && (symbol.flags & ts.SymbolFlags.Transient) !== 0
      && (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0);
  }
  return declarations.every(declaration => {
    const source = declaration.getSourceFile();
    return source.isDeclarationFile
      && (source.hasNoDefaultLib
        || source.fileName.includes('/node_modules/typescript/lib/lib.')
        || source.fileName.includes('/node_modules/@types/'));
  });
}

export function isModuleRequireExpression(node: ts.Expression, checker: ts.TypeChecker): boolean {
  return ts.isPropertyAccessExpression(node)
    && node.name.text === 'require'
    && ts.isIdentifier(node.expression)
    && isGlobalIdentifier(node.expression, checker, 'module');
}

export function collectLoaderBindings(source: ts.SourceFile, checker: ts.TypeChecker): {
  loaderSymbols: Set<ts.Symbol>;
  createRequireSymbols: Set<ts.Symbol>;
  moduleNamespaceSymbols: Set<ts.Symbol>;
  moduleObjectSymbols: Set<ts.Symbol>;
} {
  const loaderSymbols = new Set<ts.Symbol>();
  const createRequireSymbols = new Set<ts.Symbol>();
  const moduleNamespaceSymbols = new Set<ts.Symbol>();
  const moduleObjectSymbols = new Set<ts.Symbol>();
  const valueDeclarations: Array<{ symbol: ts.Symbol; initializer: ts.Expression }> = [];
  const objectBindings: Array<{ name: ts.ObjectBindingPattern; initializer: ts.Expression }> = [];
  const importCandidates: ts.Symbol[] = [];
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node)) {
      const candidate = checker.getSymbolAtLocation(node.name);
      if (candidate) importCandidates.push(candidate);
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
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name) && node.initializer) {
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol) valueDeclarations.push({ symbol, initializer: node.initializer });
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
      objectBindings.push({ name: node.name, initializer: node.initializer });
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
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  const resolvesTo = (node: ts.Identifier, symbols: ReadonlySet<ts.Symbol>): boolean => {
    const symbol = checker.getSymbolAtLocation(node);
    return Boolean(symbol && symbols.has(symbol));
  };
  const symbolResolvesToCreateRequire = (input: ts.Symbol, seen = new Set<ts.Symbol>()): boolean => {
    if (seen.has(input)) return false;
    seen.add(input);
    if (createRequireSymbols.has(input)) return true;
    if (input.getName() === 'createRequire'
      && (input.getDeclarations() ?? []).some(declaration => declaration.getSourceFile().isDeclarationFile
        && declaration.getSourceFile().fileName.includes('@types/node/module'))) return true;
    if ((input.flags & ts.SymbolFlags.Alias) !== 0) {
      const target = checker.getAliasedSymbol(input);
      if (target !== input && symbolResolvesToCreateRequire(target, seen)) return true;
    }
    return (input.getDeclarations() ?? []).some(declaration => {
      if (!ts.isImportSpecifier(declaration)) return false;
      const imported = (declaration.propertyName ?? declaration.name).text;
      const importDeclaration = containingImportDeclaration(declaration);
      return imported === 'createRequire'
        && Boolean(importDeclaration && ts.isStringLiteral(importDeclaration.moduleSpecifier)
          && (importDeclaration.moduleSpecifier.text === 'node:module' || importDeclaration.moduleSpecifier.text === 'module'));
    });
  };
  for (const candidate of importCandidates) if (symbolResolvesToCreateRequire(candidate)) createRequireSymbols.add(candidate);
  const isNodeModuleObject = (node: ts.Expression): boolean => {
    const current = unwrapExecutionExpression(node);
    if (ts.isIdentifier(current)) {
      const symbol = checker.getSymbolAtLocation(current);
      return Boolean(symbol && moduleObjectSymbols.has(symbol));
    }
    return ts.isCallExpression(current)
      && ts.isIdentifier(current.expression)
      && isGlobalIdentifier(current.expression, checker, 'require')
      && current.arguments.length === 1
      && (staticPropertyKeyExpression(current.arguments[0], checker) === 'node:module'
        || staticPropertyKeyExpression(current.arguments[0], checker) === 'module');
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
    if (isModuleRequireExpression(node, checker)) return true;
    return ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'bind'
      && isRequireCallable(node.expression.expression);
  };
  const functionTargets = (node: ts.Expression, seen = new Set<ts.Symbol>()): ts.FunctionLikeDeclaration[] => {
    const current = unwrapExecutionExpression(node);
    const symbol = ts.isPropertyAccessExpression(current)
      ? checker.getSymbolAtLocation(current.name)
      : checker.getSymbolAtLocation(current);
    if (!symbol || seen.has(symbol)) return [];
    seen.add(symbol);
    const targets: ts.FunctionLikeDeclaration[] = [];
    for (const declaration of symbol.getDeclarations() ?? []) {
      if (ts.isFunctionDeclaration(declaration)
        || ts.isMethodDeclaration(declaration)) targets.push(declaration);
      else if ((ts.isVariableDeclaration(declaration) || ts.isPropertyDeclaration(declaration) || ts.isPropertyAssignment(declaration))
        && declaration.initializer) {
        if (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) targets.push(declaration.initializer);
        else targets.push(...functionTargets(declaration.initializer, new Set(seen)));
      }
    }
    return targets;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of valueDeclarations) {
      const initializer = declaration.initializer;
      if (!moduleObjectSymbols.has(declaration.symbol) && isNodeModuleObject(initializer)) {
        moduleObjectSymbols.add(declaration.symbol);
        changed = true;
      }
      if (!createRequireSymbols.has(declaration.symbol)
        && ((ts.isIdentifier(initializer) && resolvesTo(initializer, createRequireSymbols))
          || (ts.isPropertyAccessExpression(initializer)
            && initializer.name.text === 'createRequire'
            && isNodeModuleObject(initializer.expression)))) {
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
    for (const binding of objectBindings) {
      if (!isNodeModuleObject(binding.initializer)) continue;
      for (const element of binding.name.elements) {
        const imported = element.propertyName && ts.isIdentifier(element.propertyName)
          ? element.propertyName.text
          : ts.isIdentifier(element.name) ? element.name.text : undefined;
        if (imported !== 'createRequire' || !ts.isIdentifier(element.name)) continue;
        const symbol = checker.getSymbolAtLocation(element.name);
        if (symbol && !createRequireSymbols.has(symbol)) {
          createRequireSymbols.add(symbol);
          changed = true;
        }
      }
    }
    for (const call of calls) {
      for (const target of functionTargets(call.expression)) {
        target.parameters.forEach((parameter, index) => {
          if (!ts.isIdentifier(parameter.name) || !call.arguments[index] || !isRequireCallable(call.arguments[index])) return;
          const symbol = checker.getSymbolAtLocation(parameter.name);
          if (symbol && !loaderSymbols.has(symbol)) {
            loaderSymbols.add(symbol);
            changed = true;
          }
        });
      }
    }
  }
  return { loaderSymbols, createRequireSymbols, moduleNamespaceSymbols, moduleObjectSymbols };
}

export function isCollectedLoaderExpression(
  node: ts.Expression,
  checker: ts.TypeChecker,
  bindings: ReturnType<typeof collectLoaderBindings>,
): boolean {
  const current = unwrapExecutionExpression(node);
  if (ts.isIdentifier(current)) {
    if (isGlobalIdentifier(current, checker, 'require')) return true;
    const symbol = checker.getSymbolAtLocation(current);
    return Boolean(symbol && bindings.loaderSymbols.has(symbol));
  }
  if (isModuleRequireExpression(current, checker)) return true;
  if (ts.isCallExpression(current)
    && ts.isPropertyAccessExpression(current.expression)
    && current.expression.name.text === 'bind') {
    return isCollectedLoaderExpression(current.expression.expression, checker, bindings);
  }
  if (!ts.isCallExpression(current)) return false;
  const factory = unwrapExecutionExpression(current.expression);
  if (ts.isIdentifier(factory)) {
    const symbol = checker.getSymbolAtLocation(factory);
    return Boolean(symbol && bindings.createRequireSymbols.has(symbol));
  }
  if (ts.isPropertyAccessExpression(factory) && factory.name.text === 'createRequire' && ts.isIdentifier(factory.expression)) {
    const namespace = checker.getSymbolAtLocation(factory.expression);
    return Boolean(namespace && bindings.moduleNamespaceSymbols.has(namespace));
  }
  return false;
}

export function loaderCallKind(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
  bindings: ReturnType<typeof collectLoaderBindings>,
): ModuleReferenceKind | undefined {
  if (call.expression.kind === ts.SyntaxKind.ImportKeyword) return 'dynamic-import';
  if (isCollectedLoaderExpression(call.expression, checker, bindings)) return 'require';
  return undefined;
}

export function extractImportSpecifiers(text: string, file = '<module-scan>.ts'): ModuleReference[] {
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

export function normalizeModulePath(path: string): string {
  for (const extension of EXECUTABLE_SOURCE_EXTENSIONS) {
    if (path.endsWith(extension)) return path.slice(0, -extension.length);
  }
  return path;
}

export function normalizeStaticModuleSpecifier(specifier: string): string | undefined {
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

export function resolvedStaticModulePaths(
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

export function retiredModuleMatch(file: string, specifier: string): string | undefined {
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

export function moduleSpecifierResolvesTo(
  file: string,
  specifier: string,
  targetFile: string,
  aliasEdges: readonly PackageAliasEdge[] = PACKAGE_ALIAS_EDGE_INVENTORY,
): boolean {
  const resolution = resolvedStaticModulePaths(file, specifier, aliasEdges);
  return resolution.targets.includes(normalizeModulePath(targetFile));
}

export interface CompatibilityImportBinding {
  importedName: string;
  localName: string;
  declaration: ts.ImportSpecifier;
}

export function compatibilityImportBindings(
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

export function identifierResolvesToBinding(
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

export function bindingReferences(source: ts.SourceFile, binding: CompatibilityImportBinding, checker: ts.TypeChecker): ts.Identifier[] {
  const references: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && identifierResolvesToBinding(node, binding, checker)) references.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return references;
}

export function identifierName(node: ts.BindingName | ts.DeclarationName | undefined, expected: string): boolean {
  return Boolean(node && ts.isIdentifier(node) && node.text === expected);
}

export function claimsPropertyForCall(call: ts.CallExpression): ts.PropertyAssignment | undefined {
  const property = call.parent;
  return ts.isPropertyAssignment(property)
    && property.initializer === call
    && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    && property.name.text === 'claims'
    ? property
    : undefined;
}

export function approvedCompatibilityCallShape(call: ts.CallExpression): ApprovedCompatibilityCallShape | undefined {
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

export function matchesApprovedCallSite(
  call: ts.CallExpression,
  approvedShapes: readonly ApprovedCompatibilityCallShape[],
): boolean {
  const shape = approvedCompatibilityCallShape(call);
  return Boolean(shape && approvedShapes.includes(shape));
}

export function isApprovedValueUse(
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

export function disallowedCompatibilityValueReferences(
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

export const knownBenignNonLiteralLoaderCalls = new Map<string, {
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
  // B-8a40: execute the two fixed mutants of the real built envelope module in
  // a fresh test-owned directory. No caller-supplied path or code is admitted.
  // Shape, whole-source fingerprint and producer provenance must all match.
  ['packages/main/src/tasks/prompt-full-context-envelope-smoke.ts', {
    calls: [{ anchor: 'importEnvelopeMutant', argument: 'pathToFileURL(mutantPath).href' }],
  }],
  ['bin/bootstrap-runner.js', {
    calls: [
      // B-1734: the MAIN_DIST/UTILS_DIST dist imports moved out of runLocalBootstrap into the
      // new build-aware importDistModules() wait loop; the argument expressions are unchanged.
      { anchor: 'importDistModules', argument: 'pathToFileURL(MAIN_DIST).href' },
      { anchor: 'importDistModules', argument: 'pathToFileURL(UTILS_DIST).href' },
      // B-bcae F-034: the LAB_DIST and BRAND_ENV_DIST imports moved out of runLocalBootstrap
      // into the new importLabModule() helper so they resolve INSIDE reader admission. Only the
      // enclosing anchor changed — both argument expressions, and both producers (module-scope
      // consts joined from repoRoot), are byte-identical to the approved versions.
      { anchor: 'importLabModule', argument: 'pathToFileURL(LAB_DIST).href' },
      { anchor: 'importLabModule', argument: 'pathToFileURL(BRAND_ENV_DIST).href' },
      { anchor: 'runLocalBootstrap', argument: "pathToFileURL(join(repoRoot, 'packages', 'main', 'dist', 'core', 'zod.js')).href" },
      // B-bcae CHK-003: NEW approved call site, the only one this Story added. build-lock.mjs is
      // a first-party repository-local sibling; the specifier is join(repoRoot, <literal>,
      // <literal>) through pathToFileURL, and repoRoot is dirname(dirname(fileURLToPath(
      // import.meta.url))), so no argv, env or user value reaches it. It must be dynamic:
      // build-lock.mjs imports proper-lockfile, absent in a fresh checkout without node_modules,
      // and a static import would throw ERR_MODULE_NOT_FOUND at module init before the recovery
      // hint can print — which is why its dependency-free half, build-lock-target.mjs, is the one
      // imported statically at the top of the file.
      { anchor: 'importDistModules', argument: "pathToFileURL(join(repoRoot, 'scripts', 'build-lock.mjs')).href" },
    ],
  }],
  ['packages/main/src/cli.ts', {
    calls: [{ anchor: 'runDirectCli', argument: 'workspaceLabSpecifier' }],
  }],
  // B-cdf6: the canonical Codex entrypoint moved to bin/proof-or-stop-codex.js, and it now
  // probes a LIST of sibling bootstrap wrappers (canonical first, deprecated alias as
  // fallback) instead of a single hardcoded one — so the loader argument changed from
  // `localProofOrStop` to the loop variable `candidate`. Same benign class: resolving a sibling
  // dist path at runtime is inherent to a bootstrap wrapper. bin/proof-or-stop-codex.js is now a
  // thin delegating alias with no loader of its own, so only the canonical file is listed.
  ['bin/proof-or-stop-codex.js', {
    calls: [{ anchor: 'main', argument: 'pathToFileURL(candidate).href' }],
  }],
  // B-3e16 CHK-003: the `graph` handler must load packages/graph's dist entry at RUNTIME
  // rather than statically, and the anchor is the handler method itself.
  //
  // WHY THE LOAD CANNOT BE STATIC. packages/graph/src/core/app.ts statically imports
  // ./search/fn.js, which top-level imports node:sqlite. Verified on a real Node
  // v20.19.6: importing packages/graph/dist/core/app.js by itself throws
  // ERR_UNKNOWN_BUILTIN_MODULE. A static import here would therefore hoist node:sqlite
  // into packages/main's always-evaluated module graph and break EVERY proof-or-stop
  // command on Node < 22.5, not just `graph`. The CLI runs on Node 20 today only
  // because this load is deferred. assertGraphRuntimeSupported() runs immediately
  // before the import and converts that runtime floor into a readable error.
  //
  // (a) THIS ARGUMENT IS `--root`-INFLUENCEABLE — approved with eyes open, not assumed
  // inert. cli-engine.ts (~740) strips `--root` into rootOverride; cli/runtime-root.ts
  // resolveRoot(explicit) returns it verbatim with NO sanitization for any command
  // except story_discard; cli-engine.ts (~928) stamps it into ctx.root; the handler
  // passes ctx.root to resolveGraphPackage(), whose sibling-path branch joins
  // <root>/packages/graph/dist/index.js. Live code execution from an unmarked
  // directory containing only packages/graph/dist/index.js was reproduced twice
  // (reviewer + main agent). So the pin below is not "the path is a constant"; it is
  // "this exact producer, unwidened".
  //
  // (b) SAME TRUST MODEL ALREADY ACCEPTED IN THIS MAP. verifier/serve.ts
  // startCircuitServe (entry above) dynamically imports whatever machine.ts it finds
  // under a `--root`-derived path. This entry extends an accepted pattern for a
  // first-party sibling package; it does not introduce a new risk class.
  //
  // Anchor+argument text alone would not keep this narrow, so
  // assertLoaderArgumentProvenance() additionally pins where `location`'s VALUE comes
  // from (a same-scope const initialized by resolveGraphPackage) and that the producer's
  // signature was not widened with an override parameter.
  //
  // ANCHOR NOTE: the load sits inside the object-literal method `async graph(...)`, but
  // enclosingFunctionName() only recognizes FunctionDeclarations, so the computed anchor
  // is the exported factory `createGraphHandlers` that returns the handler map. The
  // anchor is therefore coarser than the call site, which is exactly why the provenance
  // assertion below binds the argument's producer instead of trusting the anchor.
  ['packages/main/src/handlers/graph.ts', {
    calls: [{ anchor: 'createGraphHandlers', argument: 'pathToFileURL(location.entry).href' }],
  }],
]);

export const BENIGN_NON_LITERAL_LOADER_SOURCE_FINGERPRINTS = new Map<string, string>([
  // B-8a40 current-Story admission: this is a single test-only call site, not a
  // general loader exemption. Executable drift revokes it; the provenance
  // controls below also reject rebinding/widening even under a refreshed hash.
  // B-7abb's bounded reference witnesses and B-49df's active-identity mutation
  // controls are both present. The fixed producer, loader relation, anchor,
  // argument and node:url provenance remain protected.
  ['packages/main/src/tasks/prompt-full-context-envelope-smoke.ts', '13c83f0643c29adf147ac3e9d4f2d6366ca1f54939db33209463087f69791910'],
  // B-cdf6: both local bin wrappers must resolve a sibling dist path at runtime, so the
  // import specifier cannot be a literal — that is inherent to a bootstrap wrapper, not a
  // new risk class. Re-pinned this story because bootstrap-runner learned to resolve BOTH
  // bin names (canonical proof-or-stop + the retained proof-or-stop alias), and because the
  // canonical Codex entrypoint moved to bin/proof-or-stop-codex.js. The deprecated
  // bin/proof-or-stop-codex.js delegates to it and holds no loader of its own, so the canonical
  // file is what must be pinned here.
  // B-1734 (merged in): repinned again after the build-aware importDistModules() wait loop
  // was added to bin/bootstrap-runner.js (F-003/C4). The five approved non-literal dist
  // loader call sites are unchanged in shape (MAIN_DIST/UTILS_DIST relocated into
  // importDistModules, LAB_DIST/zod and BRAND_ENV_DIST in runLocalBootstrap); this whole-file structural
  // fingerprint gates that call-site allowlist, so it moves with any edit to this
  // security-sensitive entry.
  //
  // Repinned when main was merged into the B-cdf6 rename branch: the merged file carries
  // BOTH sides (theirs' importDistModules() wait loop + our three brand strings), so its
  // digest matched neither parent's pin. Re-approval basis, checked before repinning:
  // `diff` of the merged file against the MERGE_HEAD copy is exactly three lines, all of
  // them console.error/comment brand text (Lattice -> Proof-or-Stop, `lattice
  // session_brief` -> `proof-or-stop session_brief`). The five approved non-literal dist
  // loader call sites (MAIN_DIST/UTILS_DIST inside importDistModules, LAB_DIST/zod in
  // runLocalBootstrap, plus the BRAND_ENV_DIST fallback) are byte-identical to that copy, including their path producers —
  // no import()/require() call, argument, or producer was added, moved, or rewritten.
  //
  // B-bcae CHK-003 REPIN: the two-target lock protocol moved this digest, and here the
  // approved call-site allowlist this fingerprint gates really did change — a SIXTH
  // non-literal loader call site now exists, `await import(pathToFileURL(join(repoRoot,
  // 'scripts', 'build-lock.mjs')).href)` in importDistModules(), and the LAB_DIST site was
  // rewritten in place (same specifier, same producer, now inside a returned object
  // literal). Both are recorded on the DYNAMIC_CODE_GENERATION_FINGERPRINT_EXEMPTIONS entry
  // for this file, including why the new one must be dynamic and why its argument cannot be
  // influenced by argv, env or user input; read that before re-approving here. The
  // MAIN_DIST/UTILS_DIST, BRAND_ENV_DIST and zod sites are unchanged in shape.
  // 2026-09-19 re-approval: Main 677b259fc8d7 and c25111ba48ba preserve actionable mismatch diagnostics;
  // No loader/eval/Function/require/vm call was added or changed.
  // Canonical digest d0fa3e4ebad2c985e96f1faa64cd3ca7eac35492203f0eacc121e260298e715e
  // -> 19b243083de02b86b17a76c104222709b35cc223b3a5e2ad4d40ff86e99ad0ed.
  // Complete prior-pin diffs and machine-compared call inventories:
  // docs/audits/validation-entrypoint-pin-review-20260919.md.
  ['bin/bootstrap-runner.js', '19b243083de02b86b17a76c104222709b35cc223b3a5e2ad4d40ff86e99ad0ed'],
  // origin/main merge: repinned for the TOOLCHAIN, not the code. origin's lockfile
  // brings typescript 5.9.3 and canonicalAstFingerprint prints via ts.createPrinter,
  // so every AST-keyed digest here shifts. Basis checked BEFORE repinning:
  // bin/proof-or-stop-codex.js is byte-identical to pre-merge main (cmp reports no
  // difference) and a diff of every dynamic-loader line reports none either, so the
  // approved `main` anchor with the `pathToFileURL(candidate).href` argument is
  // unchanged. Only the printer moved.
  ['bin/proof-or-stop-codex.js', '023017290826cb42ede2577f5e43a20b8f13733fc80599056dcd8367a68f8506'],
  // origin/main merge: this map held THREE entries on each side, but the third differed
  // -- origin pinned packages/main/src/cli.ts while our pre-merge main pinned
  // packages/main/src/handlers/graph.ts. The merged tree carries BOTH features, and both
  // files have a call-shape approval in knownBenignNonLiteralLoaderCalls, so both need a
  // fingerprint or their approval can never hold (the scanner requires shape AND
  // fingerprint). This is a union of two reviewed boundaries, not a widening: no new
  // pattern or wildcard is introduced, and each entry still pins one exact whole source.
  // The digest is OUR computed value, not origin's fa0cfda7..., because our cli.ts is
  // byte-identical to pre-merge main (cmp reports no difference) while origin's differs.
  // Approved shape unchanged: anchor runDirectCli, argument workspaceLabSpecifier, whose
  // producer is still the same ['../../lab/dist', 'index.js'].join('/') literal join.
  ['packages/main/src/cli.ts', 'af73220a107a159f461b41cf6e22e2649c5fc89b75a270d18ffde1354c83605b'],
  // B-3e16 CHK-003: gates the graph handler's runtime load of packages/graph's dist entry
  // (see the knownBenignNonLiteralLoaderCalls entry for why it cannot be static, and for
  // the `--root` reachability this approval accepts). Whole-file structural fingerprint, so
  // ANY edit to this handler revokes the approval until a human re-approves it. Note the
  // fingerprint is comment-stripped: prose edits do not move it, code edits do.
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
]);

export function enclosingFunctionName(node: ts.Node): string | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    current = current.parent;
  }
  return undefined;
}

export const APPROVED_LOADER_ARGUMENT_PROVENANCE = new Map<string, {
  readonly anchor: string;
  readonly argument: string;
  readonly rootIdentifier: string;
  readonly producer: string;
  readonly producerParameters: readonly string[];
  /** Parameter TYPES, positionally. Names and arity alone let `string` widen to
      `string | { entry: string }`, which lets a caller name the loaded file outright. */
  readonly producerParameterTypes: readonly string[];
  /** Allowlisted URL helper wrapping the value expression; must be a 'node:url' import. */
  readonly urlHelper?: string;
}>([
  // B-3e16 CHK-003: `location` must be a same-scope const initialized by
  // resolveGraphPackage(ctx.root), and resolveGraphPackage must keep its single
  // projectRoot parameter. Widening it (e.g. an `entryOverride` second parameter) would let
  // a caller choose the imported file directly rather than only influencing the root that
  // the producer's own resolution order consumes — a strictly larger surface than what the
  // allowlist entry approved.
  ['packages/main/src/handlers/graph.ts', {
    anchor: 'createGraphHandlers',
    argument: 'pathToFileURL(location.entry).href',
    rootIdentifier: 'location',
    producer: 'resolveGraphPackage',
    producerParameters: ['projectRoot'],
    producerParameterTypes: ['string'],
    urlHelper: 'pathToFileURL',
  }],
  ['packages/main/src/tasks/prompt-full-context-envelope-smoke.ts', {
    anchor: 'importEnvelopeMutant',
    argument: 'pathToFileURL(mutantPath).href',
    rootIdentifier: 'mutantPath',
    producer: 'writeEnvelopeMutant',
    producerParameters: ['label'],
    producerParameterTypes: ["'no-safe-narrowing' | 'broad-deletion'"],
    urlHelper: 'pathToFileURL',
  }],
]);

export function rootIdentifierOf(node: ts.Node): ts.Identifier | undefined {
  let current: ts.Node = node;
  for (;;) {
    if (ts.isIdentifier(current)) return current;
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current) || ts.isAsExpression(current)) {
      current = current.expression;
      continue;
    }
    return undefined;
  }
}

export function loaderArgumentValueExpression(
  node: ts.Node,
  allowedUrlHelper: string | undefined,
  checker: ts.TypeChecker,
): ts.Expression | undefined {
  if (ts.isTemplateExpression(node)) return node.templateSpans[0]?.expression;
  if (allowedUrlHelper
    && ts.isPropertyAccessExpression(node)
    && node.name.text === 'href'
    && ts.isCallExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === allowedUrlHelper
    && isNodeUrlHelperImport(node.expression.expression, allowedUrlHelper, checker)) {
    const inner = node.expression.arguments[0];
    if (inner) return loaderArgumentValueExpression(inner, allowedUrlHelper, checker) ?? inner;
  }
  return ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) ? node as ts.Expression : undefined;
}

export function isNodeUrlHelperImport(id: ts.Identifier, expected: string, checker: ts.TypeChecker): boolean {
  const declaration = checker.getSymbolAtLocation(id)?.declarations?.[0];
  if (!declaration || !ts.isImportSpecifier(declaration)) return false;
  const specifier = declaration.parent.parent.parent.moduleSpecifier;
  if (!ts.isStringLiteral(specifier) || specifier.text !== 'node:url') return false;
  // `propertyName` is set only for `{ real as local }`; otherwise the local name IS the export.
  const exported = declaration.propertyName?.text ?? declaration.name.text;
  return exported === expected;
}

export function loaderArgumentProvenanceFailure(
  file: string,
  call: ts.CallExpression,
  source: ts.SourceFile,
  checker: ts.TypeChecker,
): string | undefined {
  const pin = APPROVED_LOADER_ARGUMENT_PROVENANCE.get(file);
  if (!pin) return undefined;
  const argumentNode = call.arguments[0];
  if (!argumentNode || argumentNode.getText(source) !== pin.argument) return undefined;

  const interpolated = loaderArgumentValueExpression(argumentNode, pin.urlHelper, checker);
  const root = interpolated && rootIdentifierOf(interpolated);
  if (!root || root.text !== pin.rootIdentifier) {
    return `pinned loader argument root identifier must be ${pin.rootIdentifier}, got ${interpolated?.getText(source) ?? '<none>'}`;
  }

  // Resolve the root identifier to its declaration through the type checker, so an
  // identically-spelled shadow or a re-exported alias cannot pass by name alone.
  const symbol = checker.getSymbolAtLocation(root);
  const declaration = symbol?.declarations?.[0];
  if (!declaration || !ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) {
    return `pinned loader argument ${pin.rootIdentifier} must resolve to a variable declaration`;
  }
  if (!ts.isVariableDeclarationList(declaration.parent) || (declaration.parent.flags & ts.NodeFlags.Const) === 0) {
    return `pinned loader argument ${pin.rootIdentifier} must be a const binding`;
  }
  // Same scope as the load: a binding hoisted to module scope, or lifted into a caller's
  // parameter, is a different (wider) trust story than the approved one.
  if (enclosingFunctionName(declaration) !== pin.anchor) {
    return `pinned loader argument ${pin.rootIdentifier} must be bound inside ${pin.anchor}, got ${enclosingFunctionName(declaration) ?? '<module scope>'}`;
  }

  const initializer = declaration.initializer;
  if (!initializer || !ts.isCallExpression(initializer) || !ts.isIdentifier(initializer.expression)) {
    return `pinned loader argument ${pin.rootIdentifier} must be initialized by a direct call to ${pin.producer}`;
  }
  if (initializer.expression.text !== pin.producer) {
    return `pinned loader argument ${pin.rootIdentifier} must be produced by ${pin.producer}, got ${initializer.expression.text}`;
  }

  // The producer's signature must not have been widened. An extra/override parameter would
  // let a caller name the loaded file directly instead of only influencing the root that
  // the producer's own resolution order consumes.
  const producerSymbol = checker.getSymbolAtLocation(initializer.expression);
  /* EVERY function declaration of the symbol, not just the first. `.find(...)` returned
     the overload SIGNATURE, so an exact-matching overload could hide a widened
     implementation and satisfy the parameter check below — the second bypass codex found
     as an independent review host (B-3e16). Checking all declarations means an overload
     set only passes when no member widens the signature. */
  const producerDeclarations = (producerSymbol?.declarations ?? [])
    .filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node));
  const producerDeclaration = producerDeclarations[0];
  if (!producerDeclaration) {
    return `producer ${pin.producer} must resolve to a function declaration`;
  }
  /* The producer must be the MODULE-LEVEL declaration, not a same-named local.
     Codex (independent review host, B-3e16) found this bypass: a nested function with
     the identical name AND identical parameter list shadows the export and can return
     caller-controlled data, while `const location = resolveGraphPackage(ctx.root)` and
     the pinned import text stay byte-identical. The name check above and the parameter
     check below both pass, so without declaration-identity checking the provenance pin
     is defeated by a re-approver who merely refreshes the fingerprint. Covered by the
     'nested producer shadow' control in assertLoaderArgumentProvenance. */
  for (const candidate of producerDeclarations) {
    if (!ts.isSourceFile(candidate.parent)) {
      return `producer ${pin.producer} must be the module-level declaration, got one nested inside ${enclosingFunctionName(candidate) ?? '<non-module scope>'}`;
    }
    /* Codex round 3: a bodyless `declare function resolveGraphPackage(projectRoot: string)`
       satisfied the module-level and parameter checks, and Node ESM can resolve that free
       identifier from an attacker-installed globalThis property. Require a concrete body,
       reject ambient/declare, and require the declaration to live in the SAME source file
       as the pinned call so a same-named export elsewhere cannot stand in. */
    if (!candidate.body) {
      return `producer ${pin.producer} must have a concrete body; a bodyless or ambient declaration can resolve to an attacker-installed global`;
    }
    if ((ts.getCombinedModifierFlags(candidate) & ts.ModifierFlags.Ambient) !== 0
      || candidate.getSourceFile().isDeclarationFile) {
      return `producer ${pin.producer} must not be an ambient declaration`;
    }
    if (candidate.getSourceFile().fileName !== source.fileName) {
      return `producer ${pin.producer} must be declared in the same source file as the pinned loader call, got ${candidate.getSourceFile().fileName}`;
    }
  }
  for (const candidate of producerDeclarations) {
    const parameters = candidate.parameters.map(parameter => parameter.name.getText(candidate.getSourceFile()));
    if (parameters.length !== pin.producerParameters.length
      || parameters.some((name, index) => name !== pin.producerParameters[index])) {
      return `producer ${pin.producer} signature was widened: expected (${pin.producerParameters.join(', ')}), got (${parameters.join(', ')})`;
    }
    /* Names and arity are not the whole signature. A DEFAULT INITIALIZER smuggles an
       attacker-influenceable value in without changing the name list:
         resolveGraphPackage(projectRoot: string = String(globalThis.__evil))
       Found by claude as an independent review host (B-3e16 round 5) — the same class as
       codex's `entryOverride` and overload findings, whose fixes closed the arity and
       overload paths but not this one. Optional and rest markers are rejected for the same
       reason: both change what a caller can supply while leaving the names identical. */
    /* Types, not just names. claude (independent review host, B-3e16 round 6) escaped the
       pin with `resolveGraphPackage(projectRoot: string | { entry: string })` plus a branch
       returning describeLocation from `projectRoot.entry` — arity 1, name list unchanged, no
       initializer/optional/rest, so every earlier check passed while a caller could name the
       loaded file outright. That is the closest analogue to codex's original entryOverride
       finding. The pin claims the producer's signature must not widen, so it has to compare
       types for that claim to be true.

       This comparison is the SOLE catcher for that mutant: deleting it outright leaves the
       type-widened mutant producing zero violations while all other mutants still produce
       'approved loader argument provenance drift'. Verified by the reviewing host, which
       also caught that an earlier neuter of this check was a PRECEDENCE bug -- prefixing
       `cond &&` into a compound `... || ...` disabled only the first disjunct, leaving the
       positional comparison live, so the check appeared redundant when it was not. When
       probing a compound condition, delete the branch rather than prefixing a guard onto
       it. Type aliases and `import('...').T` forms are compared textually and will trip
       this check: that is deliberate fail-closed behaviour, not a false positive -- a
       reviewer must re-pin deliberately rather than have an equivalent-looking rewrite
       pass silently. */
    const parameterTypes = candidate.parameters.map(parameter => parameter.type?.getText(candidate.getSourceFile()) ?? '<inferred>');
    if (parameterTypes.length !== pin.producerParameterTypes.length
      || parameterTypes.some((text, index) => text !== pin.producerParameterTypes[index])) {
      return `producer ${pin.producer} parameter types were widened: expected (${pin.producerParameterTypes.join(', ')}), got (${parameterTypes.join(', ')})`;
    }
    for (const parameter of candidate.parameters) {
      if (parameter.initializer) {
        return `producer ${pin.producer} parameter ${parameter.name.getText(candidate.getSourceFile())} must not have a default initializer; a default can carry caller- or globally-influenced input while the parameter name list stays identical`;
      }
      if (parameter.questionToken) {
        return `producer ${pin.producer} parameter ${parameter.name.getText(candidate.getSourceFile())} must not be optional`;
      }
      if (parameter.dotDotDotToken) {
        return `producer ${pin.producer} parameter ${parameter.name.getText(candidate.getSourceFile())} must not be a rest parameter`;
      }
    }
  }
  return undefined;
}

export function isKnownBenignNonLiteralLoaderCall(
  file: string,
  call: ts.CallExpression,
  source: ts.SourceFile,
  checker: ts.TypeChecker,
  fingerprintOverride?: string,
): boolean {
  const approved = knownBenignNonLiteralLoaderCalls.get(file);
  const expectedFingerprint = fingerprintOverride
    ?? PINNED_EXECUTABLE_SOURCE_FINGERPRINTS.get(file)
    ?? BENIGN_NON_LITERAL_LOADER_SOURCE_FINGERPRINTS.get(file);
  if (!approved || !expectedFingerprint || canonicalAstFingerprint(file, source.text) !== expectedFingerprint) return false;
  const anchor = enclosingFunctionName(call);
  const argument = call.arguments[0]?.getText(source);
  if (!anchor || !argument) return false;
  if (!approved.calls.some(entry => entry.anchor === anchor && entry.argument === argument)) return false;
  // Anchor + argument text matched. The approval only holds if the argument's VALUE
  // provenance also still matches its pin.
  return loaderArgumentProvenanceFailure(file, call, source, checker) === undefined;
}

export function scanConcealedCompatibilityLoads(
  file: string,
  text: string,
  fingerprintOverride?: string,
): Violation[] {
  const { source, checker } = typeAnalysisFor(file, text);
  const constStrings = collectConstStringValues(source, checker);
  const loaderBindings = collectLoaderBindings(source, checker);
  const violations: Violation[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments.length >= 1) {
      const loaderKind = loaderCallKind(node, checker, loaderBindings);
      const kind = loaderKind === 'dynamic-import' ? 'import()' : loaderKind === 'require' ? 'require()' : undefined;
      if (kind && staticModuleText(node.arguments[0], checker, constStrings) === undefined) {
        // Report a provenance break under its own label so the diagnostic names the
        // mutation class (rebound/widened argument producer) instead of only saying the
        // call is unapproved. Emitted even when the anchor/argument text still match,
        // which is precisely the mutation this pin exists to catch.
        const provenanceFailure = loaderArgumentProvenanceFailure(file, node, source, checker);
        if (provenanceFailure !== undefined) {
          violations.push({
            file,
            line: lineNumberAt(text, node.arguments[0].getStart(source)),
            label: 'approved loader argument provenance drift',
            text: `${provenanceFailure}; ${CANONICAL_AST_FINGERPRINT_ALGORITHM}=${canonicalAstFingerprint(file, text)}`,
          });
        } else if (!isKnownBenignNonLiteralLoaderCall(file, node, source, checker, fingerprintOverride)) {
          violations.push({
            file,
            line: lineNumberAt(text, node.arguments[0].getStart(source)),
            label: 'unapproved non-literal dynamic module load',
            text: `${kind} ${node.arguments[0].getText(source)}; ${CANONICAL_AST_FINGERPRINT_ALGORITHM}=${canonicalAstFingerprint(file, text)}`,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}
