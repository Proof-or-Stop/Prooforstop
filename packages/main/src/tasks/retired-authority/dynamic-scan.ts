import assert from 'node:assert/strict';







import ts from 'typescript';


import { DynamicExecutionBindings, dynamicReferenceKind, DYNAMIC_VM_EXECUTION_MEMBERS, exactSafeMutableWriteCache, emptyDynamicExecutionBindings } from "./binding-classification.js";
import { staticModuleText, collectConstStringValues, moduleSpecifierResolvesTo, scanConcealedCompatibilityLoads, extractImportSpecifiers, compatibilityImportBindings, bindingReferences, approvedCompatibilityCallShape, disallowedCompatibilityValueReferences, normalizeModulePath, resolvedStaticModulePaths, retiredModuleMatch } from "./module-loaders.js";
import { Violation, DYNAMIC_CODE_GENERATION_FINGERPRINT_EXEMPTIONS, DYNAMIC_CODE_ANALYSIS_PREFILTER, PackageAliasEdge, PACKAGE_ALIAS_EDGE_INVENTORY, LEGACY_DELIVERY_COMPAT_MODULE, isExecutableSourceFile, approvedLegacyDeliveryCompatUsages, PINNED_EXECUTABLE_SOURCE_FINGERPRINTS, SHIPPED_EXECUTABLE_SOURCE_DIRS, bannedActiveRules } from "./rule-data.js";
import { canonicalAstFingerprint, parseSource, typeProgramInstrumentation, typeAnalysisFor, typeAnalysisViolations, validatePinnedExecutableSourceFingerprint } from "./type-analysis.js";
import { collectDynamicExecutionBindings } from "./dynamic-bindings.js";
import { lineNumberAt, fileIsExplicitLegacyQuarantine, lineIsQuarantined } from "./file-scan.js";

export function unwrapExecutionExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)) current = current.expression;
  return current;
}

export function dynamicExecutionKind(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  bindings: DynamicExecutionBindings,
): string | undefined {
  return dynamicReferenceKind(expression, checker, bindings) ?? bindings.expressionKind?.(expression);
}

export function staticDynamicExecutionPayloads(
  args: readonly ts.Expression[],
  checker: ts.TypeChecker,
  constStrings: ReadonlyMap<ts.Symbol, string>,
): string[] {
  return args.flatMap(argument => {
    const payload = staticModuleText(argument, checker, constStrings);
    return payload === undefined ? [] : [payload];
  });
}

export function payloadReferencesLegacyCompatibility(payload: string): boolean {
  try {
    return decodeURIComponent(payload).includes('legacy-delivery-claims-compat');
  } catch {
    return payload.includes('legacy-delivery-claims-compat');
  }
}

export function hasDynamicExecutionAstCandidate(source: ts.SourceFile): boolean {
  const constInitializers = new Map<string, ts.Expression>();
  const stableFunctions = new Set<string>();
  const reassigned = new Set<string>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const) !== 0) {
      constInitializers.set(node.name.text, node.initializer);
    }
    if (ts.isFunctionDeclaration(node) && node.name) stableFunctions.add(node.name.text);
    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      && ts.isIdentifier(node.left)) reassigned.add(node.left.text);
    ts.forEachChild(node, collect);
  };
  collect(source);
  const foldStrings = (expression: ts.Expression, seen = new Set<string>(), depth = 0): readonly string[] | undefined => {
    if (depth > 16) return undefined;
    const current = unwrapExecutionExpression(expression);
    if (ts.isStringLiteralLike(current) || ts.isNoSubstitutionTemplateLiteral(current)) return [current.text];
    if (ts.isIdentifier(current)) {
      if (seen.has(current.text)) return undefined;
      const initializer = constInitializers.get(current.text);
      return initializer ? foldStrings(initializer, new Set(seen).add(current.text), depth + 1) : undefined;
    }
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = foldStrings(current.left, seen, depth + 1);
      const right = foldStrings(current.right, seen, depth + 1);
      if (!left || !right || left.length * right.length > 16) return undefined;
      return [...new Set(left.flatMap(a => right.map(b => a + b)))];
    }
    if (ts.isTemplateExpression(current)) {
      let values = [current.head.text];
      for (const span of current.templateSpans) {
        const parts = foldStrings(span.expression, seen, depth + 1);
        if (!parts || values.length * parts.length > 16) return undefined;
        values = values.flatMap(prefix => parts.map(part => prefix + part + span.literal.text));
      }
      return [...new Set(values)];
    }
    if (ts.isConditionalExpression(current)) {
      const left = foldStrings(current.whenTrue, seen, depth + 1);
      const right = foldStrings(current.whenFalse, seen, depth + 1);
      if (!left || !right || left.length + right.length > 16) return undefined;
      return [...new Set([...left, ...right])];
    }
    return undefined;
  };
  const exactlyLocalCallable = (expression: ts.Expression): boolean => {
    const current = unwrapExecutionExpression(expression);
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) return true;
    if (!ts.isIdentifier(current) || reassigned.has(current.text)) return false;
    if (stableFunctions.has(current.text)) return true;
    const initializer = constInitializers.get(current.text);
    return Boolean(initializer && (ts.isArrowFunction(unwrapExecutionExpression(initializer))
      || ts.isFunctionExpression(unwrapExecutionExpression(initializer))));
  };
  let candidate = false;
  const visit = (node: ts.Node): void => {
    if (candidate) return;
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const target = unwrapExecutionExpression(node.expression);
      if (exactlyLocalCallable(target)) {
        ts.forEachChild(node, visit);
        return;
      }
      if (ts.isElementAccessExpression(target) && target.argumentExpression) foldStrings(target.argumentExpression);
      for (const argument of node.arguments ?? []) foldStrings(argument);
      candidate = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return candidate;
}

export function isExactLocalSafeExecutionTarget(expression: ts.Expression, checker: ts.TypeChecker): boolean {
  const current = unwrapExecutionExpression(expression);
  if (ts.isArrowFunction(current) || ts.isFunctionExpression(current) || ts.isClassExpression(current)) return true;
  const memberTarget = ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current);
  const memberName = ts.isPropertyAccessExpression(current)
    ? current.name.text
    : ts.isElementAccessExpression(current) && current.argumentExpression && ts.isStringLiteralLike(current.argumentExpression)
      ? current.argumentExpression.text
      : undefined;
  if (memberName && (memberName === 'eval' || memberName === 'Function' || memberName === 'constructor'
    || DYNAMIC_VM_EXECUTION_MEMBERS.has(memberName))) return false;
  let symbol = ts.isPropertyAccessExpression(current)
    ? checker.getSymbolAtLocation(current.name)
    : ts.isElementAccessExpression(current) && current.argumentExpression
      ? checker.getSymbolAtLocation(current.argumentExpression)
      : checker.getSymbolAtLocation(current);
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
  if (symbol && (symbol.getName() === 'eval' || symbol.getName() === 'Function'
    || symbol.getName() === 'constructor' || DYNAMIC_VM_EXECUTION_MEMBERS.has(symbol.getName()))) return false;
  const declarations = symbol?.getDeclarations() ?? [];
  if (declarations.length === 0) return false;
  const symbolHasMutableWrites = (target: ts.Symbol): boolean => {
    const cached = exactSafeMutableWriteCache.get(target);
    if (cached !== undefined) return cached;
    const writesTarget = (node: ts.Node): boolean => {
      if (ts.isBinaryExpression(node)
        && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        const left = unwrapExecutionExpression(node.left as ts.Expression);
        const assigned = ts.isPropertyAccessExpression(left)
          ? checker.getSymbolAtLocation(left.name)
          : ts.isElementAccessExpression(left) && left.argumentExpression
            ? checker.getSymbolAtLocation(left.argumentExpression)
            : checker.getSymbolAtLocation(left);
        if (assigned === target) return true;
        if ((ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left))
          && assigned?.getName() === target.getName()) return true;
      }
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
        && checker.getSymbolAtLocation(node.operand) === target) return true;
      return ts.forEachChild(node, writesTarget) ?? false;
    };
    const result = [...new Set(declarations.map(declaration => declaration.getSourceFile()))]
      .some(declarationSource => writesTarget(declarationSource));
    exactSafeMutableWriteCache.set(target, result);
    return result;
  };
  if (symbol && symbolHasMutableWrites(symbol)) return false;
  const trustedRuntimeDeclaration = (declaration: ts.Declaration): boolean => {
    const declarationFile = declaration.getSourceFile();
    return declarationFile.isDeclarationFile
      && (declarationFile.hasNoDefaultLib
        || declarationFile.fileName.includes('/node_modules/typescript/lib/lib.')
        || declarationFile.fileName.includes('/node_modules/@types/node/'));
  };
  return declarations.every(declaration => {
    if (ts.isParameter(declaration) || ts.isCallSignatureDeclaration(declaration)) return false;
    if (ts.isMethodSignature(declaration) || ts.isPropertySignature(declaration)) {
      if (!trustedRuntimeDeclaration(declaration)) return false;
      if (memberTarget) {
        const receiver = ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)
          ? checker.getTypeAtLocation(current.expression)
          : undefined;
        if (!receiver || (receiver.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0) return false;
      }
      if (ts.isPropertySignature(declaration)) {
        const propertyType = checker.getTypeOfSymbolAtLocation(symbol!, declaration);
        return (propertyType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) === 0
          && (checker.getSignaturesOfType(propertyType, ts.SignatureKind.Call).length > 0
            || checker.getSignaturesOfType(propertyType, ts.SignatureKind.Construct).length > 0);
      }
      return true;
    }
    if ((ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) && declaration.body) return true;
    if (ts.isClassDeclaration(declaration)) return true;
    if ((ts.isVariableDeclaration(declaration) || ts.isPropertyDeclaration(declaration) || ts.isPropertyAssignment(declaration))
      && declaration.initializer) {
      const initializer = unwrapExecutionExpression(declaration.initializer);
      return ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer) || ts.isClassExpression(initializer);
    }
    return trustedRuntimeDeclaration(declaration);
  });
}

export function scanDynamicCodeGeneration(
  file: string,
  text: string,
  program?: ts.Program,
): Violation[] {
  const exemptFingerprint = DYNAMIC_CODE_GENERATION_FINGERPRINT_EXEMPTIONS.get(file);
  if (exemptFingerprint && canonicalAstFingerprint(file, text) === exemptFingerprint) return [];
  const parsed = parseSource(file, text);
  const parseClean = ((parsed as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length ?? 0) === 0;
  const astCandidate = parseClean && hasDynamicExecutionAstCandidate(parsed);
  if (parseClean && !astCandidate) {
    typeProgramInstrumentation.dynamicPrefilterSkips += 1;
    return [];
  }
  if (astCandidate && !DYNAMIC_CODE_ANALYSIS_PREFILTER.test(text)) typeProgramInstrumentation.dynamicAstCandidateScans += 1;
  typeProgramInstrumentation.dynamicFullAnalysisScans += 1;
  typeProgramInstrumentation.dynamicFullAnalysisByFile.set(
    file,
    (typeProgramInstrumentation.dynamicFullAnalysisByFile.get(file) ?? 0) + 1,
  );
  const analysis = typeAnalysisFor(file, text, program);
  const { source, checker } = analysis;
  const constStrings = collectConstStringValues(source, checker);
  const directBindings = emptyDynamicExecutionBindings();
  let bindings: DynamicExecutionBindings | undefined;
  const executionBindings = (): DynamicExecutionBindings => {
    bindings ??= collectDynamicExecutionBindings(source, checker, analysis.program);
    return bindings;
  };
  const violations: Violation[] = typeAnalysisViolations(file, analysis);
  const inspect = (node: ts.CallExpression | ts.NewExpression): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) return;
    const directKind = dynamicReferenceKind(node.expression, checker, directBindings);
    const exactSafe = isExactLocalSafeExecutionTarget(node.expression, checker);
    const kind = directKind ?? (exactSafe ? undefined : dynamicExecutionKind(node.expression, checker, executionBindings()));
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

export function importedCompatSymbols(
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

export function scanLegacyDeliveryCompatibilityUsage(
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

export function directlyExportsCompatibilityBinding(file: string, text: string): boolean {
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

export function scanLegacyDeliveryCompatibilityGraph(fileTexts: ReadonlyMap<string, string>): Violation[] {
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

export function shouldScanImports(file: string): boolean {
  return SHIPPED_EXECUTABLE_SOURCE_DIRS.some(dir => file.startsWith(`${dir}/`))
    && isExecutableSourceFile(file)
    && !file.includes('/dist/')
    && !fileIsExplicitLegacyQuarantine(file);
}

export function scanImportSpecifiers(file: string, text: string): Violation[] {
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

export function scanText(file: string, text: string, rules = bannedActiveRules): Violation[] {
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
