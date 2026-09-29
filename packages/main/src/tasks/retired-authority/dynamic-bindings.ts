import assert from 'node:assert/strict';





import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';


import { DynamicExecutionBindings, dynamicBindingsCache, dynamicBindingBuildInputs, emptyDynamicExecutionBindings, DynamicAliasRecord, expressionSymbol, DynamicProvenance, typeRequiresFailClosedCallableClassification, hasExactLocalNonCallableEvidence, javascriptPropertyKey, staticPropertyKeyExpression, ModuleLoadSource, EXACT_SAFE_NODE_REQUIRE_SPECIFIERS, DynamicIndexDomain, DYNAMIC_VM_EXECUTION_MEMBERS, dynamicReferenceKind, isGlobalObjectIdentifier, isGlobalRequireCall, vmNamespaceReference, staticallyCallableKind, identifierSymbol, functionDeclarationConstructorKind, functionCallableReference } from "./binding-classification.js";
import { typeProgramInstrumentation } from "./type-analysis.js";
import { collectLoaderBindings, isCollectedLoaderExpression, containingImportDeclaration, isGlobalIdentifier } from "./module-loaders.js";
import { repoRoot } from "./rule-data.js";
import { unwrapExecutionExpression } from "./dynamic-scan.js";

export function collectDynamicExecutionBindings(source: ts.SourceFile, checker: ts.TypeChecker, program?: ts.Program): DynamicExecutionBindings {
  const programCache = program ? dynamicBindingsCache.get(program) : undefined;
  const cached = programCache?.get(source);
  if (cached) {
    typeProgramInstrumentation.dynamicBindingCacheHits += 1;
    return cached;
  }
  assert.ok(program, 'dynamic binding cache must have a Program identity');
  let builtInputs = dynamicBindingBuildInputs.get(program);
  if (!builtInputs) { builtInputs = new WeakSet(); dynamicBindingBuildInputs.set(program, builtInputs); }
  assert.ok(!builtInputs.has(source), 'DYNAMIC_BINDING_REBUILT_SAME_INPUT: a Program/SourceFile pair must build once');
  builtInputs.add(source);
  typeProgramInstrumentation.dynamicBindingBuilds += 1;
  typeProgramInstrumentation.dynamicBindingBuildFiles.set(
    source.fileName,
    (typeProgramInstrumentation.dynamicBindingBuildFiles.get(source.fileName) ?? 0) + 1,
  );
  const bindings = emptyDynamicExecutionBindings();
  const loaderBindings = collectLoaderBindings(source, checker);
  const aliases: DynamicAliasRecord[] = [];
  const localInitializer = (expression: ts.Expression): ts.Expression | undefined => {
    const symbol = expressionSymbol(expression, checker);
    for (const declaration of symbol?.getDeclarations() ?? []) {
      if ((ts.isVariableDeclaration(declaration) || ts.isPropertyDeclaration(declaration) || ts.isPropertyAssignment(declaration))
        && declaration.initializer) return declaration.initializer;
    }
    return undefined;
  };
  const constructorTypeKind = (receiver: DynamicProvenance | undefined): string | undefined => {
    if (!receiver) return 'unresolved-or-ambient';
    if (!receiver.type) return 'unresolved-or-ambient';
    if (typeRequiresFailClosedCallableClassification(receiver.type, checker)) return 'unresolved-or-callable';
    if (receiver.expression && hasExactLocalNonCallableEvidence(receiver.expression, checker)) return undefined;
    const declarations = receiver.symbol?.getDeclarations() ?? [];
    const exactLocal = declarations.length > 0 && declarations.every(declaration => (
      !declaration.getSourceFile().isDeclarationFile
      && resolve(declaration.getSourceFile().fileName).startsWith(`${resolve(repoRoot)}/`)
    ));
    return exactLocal ? undefined : 'unresolved-or-ambient';
  };
  const constantPropertyKey = (name: ts.PropertyName | undefined): string | undefined => {
    if (!name) return undefined;
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
    if (ts.isNumericLiteral(name)) return javascriptPropertyKey(Number(name.text));
    if (!ts.isComputedPropertyName(name)) return undefined;
    return staticPropertyKeyExpression(name.expression, checker);
  };
  const classifyModuleLoad = (expression: ts.Expression): ModuleLoadSource | undefined => {
    const current = unwrapExecutionExpression(expression);
    if (!ts.isCallExpression(current) || !isCollectedLoaderExpression(current.expression, checker, loaderBindings)) return undefined;
    const specifier = current.arguments[0]
      ? staticPropertyKeyExpression(current.arguments[0], checker)
      : undefined;
    if (specifier === 'vm' || specifier === 'node:vm') return { kind: 'vm', specifier };
    if (specifier && EXACT_SAFE_NODE_REQUIRE_SPECIFIERS.has(specifier)) return { kind: 'trusted-builtin', specifier };
    return { kind: 'local-or-unknown', specifier };
  };
  const conservativeIndexProvenance = (provenance: DynamicProvenance): DynamicProvenance | undefined => {
    if (provenance.index) return provenance.index;
    if (provenance.element) return { ...provenance.element, indexDomain: provenance.element.indexDomain ?? 'number' };
    if (!provenance.type) return provenance.unknown || provenance.unknownMemberAccess
      ? { kind: 'unresolved-spread-source', indexDomain: 'both' }
      : undefined;
    const stringIndex = checker.getIndexTypeOfType(provenance.type, ts.IndexKind.String);
    const numberIndex = checker.getIndexTypeOfType(provenance.type, ts.IndexKind.Number);
    const type = stringIndex ?? numberIndex;
    if (type) return {
      type,
      kind: typeRequiresFailClosedCallableClassification(type, checker) ? 'unresolved-spread-index' : undefined,
      indexDomain: stringIndex && numberIndex ? 'both' : stringIndex ? 'string' : 'number',
    };
    if ((provenance.type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0) {
      return { type: provenance.type, kind: 'unresolved-spread-source', indexDomain: 'both' };
    }
    return undefined;
  };
  const mergeConservativeIndex = (
    current: DynamicProvenance | undefined,
    candidate: DynamicProvenance | undefined,
  ): DynamicProvenance | undefined => {
    if (!current) return candidate;
    if (!candidate) return current;
    const currentDangerous = Boolean(current.kind || current.unknown || current.unknownMemberAccess);
    const candidateDangerous = Boolean(candidate.kind || candidate.unknown || candidate.unknownMemberAccess);
    const selected = currentDangerous ? current : candidateDangerous ? candidate : current;
    const indexDomain = mergeIndexDomains(current.indexDomain, candidate.indexDomain);
    return { ...selected, indexDomain };
  };
  const mergeIndexDomains = (
    left: DynamicIndexDomain | undefined,
    right: DynamicIndexDomain | undefined,
  ): DynamicIndexDomain | undefined => {
    if (!left || !right || left === right) return left ?? right;
    if (left === 'all' || right === 'all') return 'all';
    if ((left === 'string' && right === 'number') || (left === 'number' && right === 'string')) return 'both';
    if (left === 'both' && (right === 'string' || right === 'number')) return 'both';
    if (right === 'both' && (left === 'string' || left === 'number')) return 'both';
    return 'all';
  };
  const dangerousCallableTypeKind = (type: ts.Type): string | undefined => {
    const names = new Set<string>();
    const typeSymbol = type.getSymbol();
    if (typeSymbol) names.add(typeSymbol.getName());
    for (const signature of [
      ...checker.getSignaturesOfType(type, ts.SignatureKind.Call),
      ...checker.getSignaturesOfType(type, ts.SignatureKind.Construct),
    ]) {
      const declaration = signature.getDeclaration();
      if (declaration && 'name' in declaration && declaration.name && ts.isIdentifier(declaration.name)) {
        names.add(declaration.name.text);
      }
    }
    if (names.has('eval')) return 'eval';
    if (names.has('Function')) return 'Function';
    const vmMember = [...names].find(name => DYNAMIC_VM_EXECUTION_MEMBERS.has(name));
    return vmMember ? `node:vm.${vmMember}` : undefined;
  };
  const typedOwnEnumerableMembers = (provenance: DynamicProvenance): {
    members: Map<string, DynamicProvenance>;
    symbolIndex?: DynamicProvenance;
    complete: boolean;
  } => {
    const members = new Map<string, DynamicProvenance>();
    let symbolIndex: DynamicProvenance | undefined;
    const type = provenance.type;
    if (!type) return { members, complete: false };
    let complete = true;
    for (const property of checker.getPropertiesOfType(type)) {
      const declarations = property.getDeclarations() ?? [];
      const isDeclaredOwnProperty = declarations.some(declaration => (
        ts.isPropertySignature(declaration)
        || ts.isPropertyDeclaration(declaration)
      ));
      const propertyType = checker.getTypeOfSymbolAtLocation(property, provenance.expression ?? source);
      const dangerousKind = dangerousCallableTypeKind(propertyType);
      if (!isDeclaredOwnProperty) complete = false;
      if (!isDeclaredOwnProperty && !dangerousKind) continue;
      const member: DynamicProvenance = {
        type: propertyType,
        symbol: property,
        kind: dangerousKind,
      };
      if (property.name.startsWith('__@')) {
        symbolIndex = mergeConservativeIndex(symbolIndex, { ...member, indexDomain: 'symbol' });
      } else {
        members.set(property.name, member);
      }
    }
    const hasIndex = Boolean(
      checker.getIndexTypeOfType(type, ts.IndexKind.String)
      || checker.getIndexTypeOfType(type, ts.IndexKind.Number)
    );
    const openType = (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0;
    return { members, symbolIndex, complete: complete && !hasIndex && !openType };
  };
  const isExactLocalSafeValue = (provenance: DynamicProvenance): boolean => {
    if (provenance.kind || provenance.unknown || provenance.unknownMemberAccess) return false;
    if (provenance.expression && dynamicReferenceKind(provenance.expression, checker, bindings)) return false;
    const current = provenance.expression ? unwrapExecutionExpression(provenance.expression) : undefined;
    if (current && (ts.isArrowFunction(current)
      || ts.isFunctionExpression(current)
      || ts.isObjectLiteralExpression(current)
      || ts.isArrayLiteralExpression(current)
      || ts.isStringLiteralLike(current)
      || ts.isNumericLiteral(current))) return true;
    return Boolean(provenance.expression && hasExactLocalNonCallableEvidence(provenance.expression, checker));
  };
  const alternativeCarriesDynamicIdentity = (provenance: DynamicProvenance, seen = new Set<DynamicProvenance>()): boolean => {
    if (seen.has(provenance)) return false;
    seen.add(provenance);
    if ((provenance.kind && !provenance.kind.startsWith('unresolved-')) || provenance.unknown || provenance.unknownMemberAccess) return true;
    return [...(provenance.members?.values() ?? [])].some(value => alternativeCarriesDynamicIdentity(value, seen))
      || Boolean(provenance.element && alternativeCarriesDynamicIdentity(provenance.element, seen))
      || Boolean(provenance.index && alternativeCarriesDynamicIdentity(provenance.index, seen));
  };
  const mergeAlternativeProvenance = (left: DynamicProvenance, right: DynamicProvenance): DynamicProvenance => {
    const leftCarriesIdentity = alternativeCarriesDynamicIdentity(left);
    const rightCarriesIdentity = alternativeCarriesDynamicIdentity(right);
    if (!leftCarriesIdentity && !rightCarriesIdentity) return { completeMembers: false };
    if (leftCarriesIdentity && !rightCarriesIdentity) return left;
    if (rightCarriesIdentity && !leftCarriesIdentity) return right;
    const leftKind = left.kind ?? (left.expression ? dynamicReferenceKind(left.expression, checker, bindings) : undefined);
    const rightKind = right.kind ?? (right.expression ? dynamicReferenceKind(right.expression, checker, bindings) : undefined);
    const members = new Map(left.members ?? []);
    for (const [key, value] of right.members ?? []) {
      const prior = members.get(key);
      members.set(key, prior ? mergeAlternativeProvenance(prior, value) : value);
    }
    return {
      expression: leftKind ? left.expression : rightKind ? right.expression : left.expression ?? right.expression,
      kind: leftKind ?? rightKind,
      members: members.size > 0 ? members : undefined,
      element: left.element && right.element
        ? mergeAlternativeProvenance(left.element, right.element)
        : left.element ?? right.element,
      index: left.index && right.index
        ? mergeAlternativeProvenance(left.index, right.index)
        : left.index ?? right.index,
      indexDomain: mergeIndexDomains(left.indexDomain, right.indexDomain),
      ownEnumerableMembers: left.ownEnumerableMembers && right.ownEnumerableMembers
        ? new Set([...left.ownEnumerableMembers, ...right.ownEnumerableMembers])
        : left.ownEnumerableMembers ?? right.ownEnumerableMembers,
      unknown: left.unknown || right.unknown,
      unknownMemberAccess: left.unknownMemberAccess || right.unknownMemberAccess,
      completeMembers: left.completeMembers === true && right.completeMembers === true,
    };
  };
  let provenanceForExportSymbol: (input: ts.Symbol, seen?: Set<ts.Symbol>) => DynamicProvenance;
  let namespaceForModuleSymbol: (moduleSymbol: ts.Symbol, seen?: Set<ts.Symbol>) => DynamicProvenance;
  const callbackParameterProvenance = new Map<ts.Symbol, DynamicProvenance>();
  const importedNodeHelper = (identifier: ts.Identifier, helper: string, modules: ReadonlySet<string>): boolean => {
    const symbol = checker.getSymbolAtLocation(identifier);
    for (const declaration of symbol?.getDeclarations() ?? []) {
      if (!ts.isImportSpecifier(declaration)) continue;
      const imported = (declaration.propertyName ?? declaration.name).text;
      const importDeclaration = containingImportDeclaration(declaration);
      if (imported === helper
        && importDeclaration && ts.isStringLiteral(importDeclaration.moduleSpecifier)
        && modules.has(importDeclaration.moduleSpecifier.text)) return true;
    }
    return false;
  };
  const importedNodeHelperExpression = (expression: ts.Expression, helper: string, modules: ReadonlySet<string>): boolean => {
    const current = unwrapExecutionExpression(expression);
    if (ts.isIdentifier(current)) return importedNodeHelper(current, helper, modules);
    if (!ts.isPropertyAccessExpression(current) || current.name.text !== helper || !ts.isIdentifier(current.expression)) return false;
    const symbol = checker.getSymbolAtLocation(current.expression);
    return (symbol?.getDeclarations() ?? []).some(declaration => ts.isNamespaceImport(declaration)
      && ts.isImportClause(declaration.parent)
      && ts.isImportDeclaration(declaration.parent.parent)
      && ts.isStringLiteral(declaration.parent.parent.moduleSpecifier)
      && modules.has(declaration.parent.parent.moduleSpecifier.text));
  };
  const staticRuntimeModulePath = (expression: ts.Expression, seen = new Set<ts.Symbol>()): string | undefined => {
    const current = unwrapExecutionExpression(expression);
    const literal = staticPropertyKeyExpression(current, checker);
    if (literal !== undefined) return literal;
    if (ts.isMetaProperty(current)
      && current.keywordToken === ts.SyntaxKind.ImportKeyword
      && current.name.text === 'meta') return undefined;
    if (ts.isPropertyAccessExpression(current) && current.name.text === 'url'
      && ts.isMetaProperty(current.expression)) return source.fileName;
    if (ts.isPropertyAccessExpression(current) && current.name.text === 'href'
      && !ts.isCallExpression(current.expression)) {
      const value = staticRuntimeModulePath(current.expression, seen);
      if (value !== undefined && value.startsWith('file:')) return value;
    }
    if (ts.isPropertyAccessExpression(current) && current.name.text === 'href'
      && ts.isCallExpression(current.expression)
      && importedNodeHelperExpression(current.expression.expression, 'pathToFileURL', new Set(['url', 'node:url']))) {
      const value = current.expression.arguments[0] ? staticRuntimeModulePath(current.expression.arguments[0], seen) : undefined;
      return value === undefined ? undefined : pathToFileURL(value).href;
    }
    if (ts.isIdentifier(current)) {
      const symbol = checker.getSymbolAtLocation(current);
      if (!symbol || seen.has(symbol)) return undefined;
      const nextSeen = new Set(seen).add(symbol);
      for (const declaration of symbol.getDeclarations() ?? []) {
        if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
          const value = staticRuntimeModulePath(declaration.initializer, nextSeen);
          if (value !== undefined) return value;
        }
      }
      return undefined;
    }
    if (ts.isNewExpression(current)
      && ts.isIdentifier(current.expression)
      && isGlobalIdentifier(current.expression, checker, 'URL')
      && current.arguments?.[0]) {
      const relativeValue = staticRuntimeModulePath(current.arguments[0], seen);
      const baseValue = current.arguments[1] ? staticRuntimeModulePath(current.arguments[1], seen) : undefined;
      if (relativeValue === undefined || baseValue === undefined) return undefined;
      try {
        const baseUrl = baseValue.startsWith('file:') ? baseValue : pathToFileURL(baseValue).href;
        return new URL(relativeValue, baseUrl).href;
      } catch {
        return undefined;
      }
    }
    if (!ts.isCallExpression(current)) return undefined;
    if (importedNodeHelperExpression(current.expression, 'pathToFileURL', new Set(['url', 'node:url']))
      && current.arguments[0]) {
      const value = staticRuntimeModulePath(current.arguments[0], seen);
      return value === undefined ? undefined : pathToFileURL(value).href;
    }
    if (importedNodeHelperExpression(current.expression, 'fileURLToPath', new Set(['url', 'node:url']))
      && current.arguments[0]) {
      const value = staticRuntimeModulePath(current.arguments[0], seen);
      if (value === undefined) return undefined;
      try {
        return value.startsWith('file:') ? fileURLToPath(value) : value;
      } catch {
        return undefined;
      }
    }
    if (importedNodeHelperExpression(current.expression, 'dirname', new Set(['path', 'node:path']))
      && current.arguments[0]) {
      const value = staticRuntimeModulePath(current.arguments[0], seen);
      if (value !== undefined) return dirname(value);
      if (current.arguments[0].getText(source).includes('process.argv[1]')) return dirname(source.fileName);
      return undefined;
    }
    if (importedNodeHelperExpression(current.expression, 'join', new Set(['path', 'node:path']))) {
      const parts = current.arguments.map(argument => staticRuntimeModulePath(argument, seen));
      return parts.some(part => part === undefined) ? undefined : join(...parts as string[]);
    }
    return undefined;
  };
  const sourceFileForRuntimeModulePath = (runtimePath: string): ts.SourceFile | undefined => {
    if (!program) return undefined;
    let localPath = runtimePath;
    try {
      if (localPath.startsWith('file:')) localPath = fileURLToPath(localPath);
    } catch {
      return undefined;
    }
    localPath = localPath.replace(/[?#].*$/, '');
    if (!localPath.startsWith('/')) return undefined;
    const candidates = new Set([localPath]);
    if (localPath.includes('/dist/')) {
      const sourcePath = localPath.replace('/dist/', '/src/').replace(/\.js$/, '.ts');
      candidates.add(sourcePath);
      if (sourcePath.endsWith('/src/index.ts')) candidates.add(sourcePath);
    }
    if (localPath.endsWith('.js')) candidates.add(localPath.replace(/\.js$/, '.ts'));
    for (const candidate of candidates) {
      const found = program.getSourceFile(candidate);
      if (found) return found;
    }
    return undefined;
  };
  const provenanceForExpression = (expression: ts.Expression, seen = new Set<ts.Node>()): DynamicProvenance => {
    const current = unwrapExecutionExpression(expression);
    const base: DynamicProvenance = {
      expression: current,
      type: checker.getTypeAtLocation(expression),
      symbol: expressionSymbol(current, checker),
    };
    if (seen.has(current)) return base;
    seen.add(current);
    const directReferenceKind = dynamicReferenceKind(current, checker, bindings);
    if (directReferenceKind) return { ...base, kind: directReferenceKind };
    if (ts.isIdentifier(current)) {
      const callbackInput = checker.getSymbolAtLocation(current);
      if (callbackInput && callbackParameterProvenance.has(callbackInput)) return callbackParameterProvenance.get(callbackInput)!;
    }
    if (ts.isConditionalExpression(current)) {
      return mergeAlternativeProvenance(
        provenanceForExpression(current.whenTrue, new Set(seen)),
        provenanceForExpression(current.whenFalse, new Set(seen)),
      );
    }
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      return provenanceForExpression(current.right, new Set(seen));
    }
    if (ts.isBinaryExpression(current)
      && (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
        || current.operatorToken.kind === ts.SyntaxKind.BarBarToken
        || current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
      return mergeAlternativeProvenance(
        provenanceForExpression(current.left, new Set(seen)),
        provenanceForExpression(current.right, new Set(seen)),
      );
    }
    if (ts.isAwaitExpression(current)
      && ts.isCallExpression(current.expression)
      && ts.isPropertyAccessExpression(current.expression.expression)
      && (current.expression.expression.name.text === 'all'
        || current.expression.expression.name.text === 'race'
        || current.expression.expression.name.text === 'any'
        || current.expression.expression.name.text === 'allSettled')
      && ts.isIdentifier(current.expression.expression.expression)
      && isGlobalIdentifier(current.expression.expression.expression, checker, 'Promise')
      && current.expression.arguments.length === 1
      ) {
      const collection = provenanceForExpression(current.expression.arguments[0], new Set(seen));
      const awaitedSlot = (candidate: DynamicProvenance): DynamicProvenance => {
        const awaitedType = candidate.type ? checker.getAwaitedType(candidate.type) : undefined;
        const unresolved = Boolean(awaitedType
          && (awaitedType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0);
        return { ...candidate, type: awaitedType ?? candidate.type, unknown: candidate.unknown || unresolved };
      };
      const awaitedCollection: DynamicProvenance = {
        ...collection,
        members: collection.members
          ? new Map([...collection.members].map(([key, value]) => [key, awaitedSlot(value)]))
          : undefined,
        element: collection.element ? awaitedSlot(collection.element) : undefined,
        index: collection.index ? awaitedSlot(collection.index) : undefined,
      };
      const promiseMethod = current.expression.expression.name.text;
      if (promiseMethod === 'all') return { ...awaitedCollection, expression: current };
      if (promiseMethod === 'allSettled') {
        const settledSlot = (value: DynamicProvenance): DynamicProvenance => ({
          members: new Map([
            ['status', { completeMembers: true }],
            ['value', value],
            ['reason', { unknown: true, unknownMemberAccess: true }],
          ]),
          ownEnumerableMembers: new Set(['status', 'value', 'reason']),
          completeMembers: true,
        });
        return {
          ...awaitedCollection,
          expression: current,
          members: awaitedCollection.members
            ? new Map([...awaitedCollection.members].map(([key, value]) => [key, settledSlot(value)]))
            : undefined,
          element: awaitedCollection.element ? settledSlot(awaitedCollection.element) : undefined,
          index: awaitedCollection.index ? settledSlot(awaitedCollection.index) : undefined,
        };
      }
      const candidates = [...(awaitedCollection.members?.values() ?? [])];
      const raced = candidates.reduce<DynamicProvenance | undefined>(
        (merged, candidate) => merged ? mergeAlternativeProvenance(merged, candidate) : candidate,
        awaitedCollection.element ?? awaitedCollection.index,
      );
      return raced ?? { expression: current, unknown: true, unknownMemberAccess: true };
    }
    if (ts.isAwaitExpression(current)) {
      const awaited = unwrapExecutionExpression(current.expression);
      const awaitedInitializer = localInitializer(awaited);
      if ((ts.isCallExpression(awaited) && awaited.expression.kind === ts.SyntaxKind.ImportKeyword)
        || (awaitedInitializer && ts.isCallExpression(unwrapExecutionExpression(awaitedInitializer))
          && (unwrapExecutionExpression(awaitedInitializer) as ts.CallExpression).expression.kind === ts.SyntaxKind.ImportKeyword)) {
        return provenanceForExpression(awaitedInitializer ?? awaited, new Set(seen));
      }
      if (ts.isCallExpression(awaited)
        && ts.isPropertyAccessExpression(awaited.expression)
        && (awaited.expression.name.text === 'then'
          || awaited.expression.name.text === 'catch'
          || awaited.expression.name.text === 'finally')) {
        return provenanceForExpression(awaited, new Set(seen));
      }
      const awaitedSymbol = expressionSymbol(awaited, checker);
      if (awaitedSymbol && (awaitedSymbol.getDeclarations() ?? []).some(declaration => !declaration.getSourceFile().isDeclarationFile)) {
        return { expression: awaited, symbol: awaitedSymbol, type: checker.getTypeAtLocation(current) };
      }
    }
    if (ts.isCallExpression(current)
      && ts.isPropertyAccessExpression(current.expression)
      && (current.expression.name.text === 'then'
        || current.expression.name.text === 'catch'
        || current.expression.name.text === 'finally')) {
      const promised = provenanceForExpression(current.expression.expression, new Set(seen));
      const promiseMethod = current.expression.name.text;
      const callback = current.arguments[0];
      if (promiseMethod === 'finally' || !callback) return promised;
      if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) {
        return promiseMethod === 'catch'
          ? mergeAlternativeProvenance(promised, { expression: callback, unknown: true, unknownMemberAccess: true })
          : { expression: callback, unknown: true, unknownMemberAccess: true };
      }
      const priorParameters: Array<{ symbol: ts.Symbol; prior?: DynamicProvenance }> = [];
      const bindCallbackPattern = (pattern: ts.BindingName, input: DynamicProvenance): void => {
        if (ts.isIdentifier(pattern)) {
          const symbol = checker.getSymbolAtLocation(pattern);
          if (symbol) {
            priorParameters.push({ symbol, prior: callbackParameterProvenance.get(symbol) });
            callbackParameterProvenance.set(symbol, input);
          }
          return;
        }
        pattern.elements.forEach((element, index) => {
          if (ts.isOmittedExpression(element)) return;
          const key = ts.isObjectBindingPattern(pattern)
            ? constantPropertyKey(element.propertyName ?? element.name as ts.PropertyName)
            : String(index);
          let selected = element.dotDotDotToken
            ? { unknown: true, unknownMemberAccess: true }
            : selectMember(input, key);
          if (element.initializer) selected = mergeAlternativeProvenance(
            selected,
            provenanceForExpression(element.initializer, new Set(seen)),
          );
          bindCallbackPattern(element.name, selected);
        });
      };
      const parameterInput = promiseMethod === 'catch'
        ? { unknown: true, unknownMemberAccess: true }
        : promised;
      const parameter = callback.parameters[0]?.name;
      if (parameter) bindCallbackPattern(parameter, parameterInput);
      const returnedExpressions: ts.Expression[] = [];
      if (ts.isBlock(callback.body)) {
        const collectReturns = (node: ts.Node): void => {
          if (node !== callback.body && ts.isFunctionLike(node)) return;
          if (ts.isReturnStatement(node) && node.expression) returnedExpressions.push(node.expression);
          ts.forEachChild(node, collectReturns);
        };
        collectReturns(callback.body);
      } else returnedExpressions.push(callback.body);
      const callbackResult = returnedExpressions.reduce<DynamicProvenance | undefined>((merged, returned) => {
        const returnedValue = unwrapExecutionExpression(returned);
        const thenableResults: ts.Expression[] = [];
        if (ts.isObjectLiteralExpression(returnedValue)) {
          for (const property of returnedValue.properties) {
            if (!ts.isMethodDeclaration(property) || constantPropertyKey(property.name) !== 'then'
              || !property.body || !property.parameters[0] || !ts.isIdentifier(property.parameters[0].name)) continue;
            const resolveName = property.parameters[0].name.text;
            const collectResolutions = (node: ts.Node): void => {
              if (node !== property.body && ts.isFunctionLike(node)) return;
              if (ts.isCallExpression(node) && ts.isIdentifier(unwrapExecutionExpression(node.expression))
                && (unwrapExecutionExpression(node.expression) as ts.Identifier).text === resolveName
                && node.arguments[0]) thenableResults.push(node.arguments[0]);
              ts.forEachChild(node, collectResolutions);
            };
            collectResolutions(property.body);
          }
        }
        const promiseResolve = ts.isCallExpression(returnedValue)
          && ts.isPropertyAccessExpression(returnedValue.expression)
          && returnedValue.expression.name.text === 'resolve'
          && ts.isIdentifier(returnedValue.expression.expression)
          && isGlobalIdentifier(returnedValue.expression.expression, checker, 'Promise')
          && returnedValue.arguments[0];
        let candidate = thenableResults.reduce<DynamicProvenance | undefined>((result, value) => {
          const resolution = provenanceForExpression(value, new Set(seen));
          return result ? mergeAlternativeProvenance(result, resolution) : resolution;
        }, undefined) ?? (promiseResolve
          ? provenanceForExpression(promiseResolve, new Set(seen))
          : provenanceForExpression(returned, new Set(seen)));
        const returnedType = checker.getTypeAtLocation(returned);
        const knownPromiseProducer = Boolean(thenableResults.length > 0 || promiseResolve
          || (ts.isCallExpression(returnedValue) && returnedValue.expression.kind === ts.SyntaxKind.ImportKeyword)
          || (ts.isCallExpression(returnedValue) && ts.isPropertyAccessExpression(returnedValue.expression)
            && (returnedValue.expression.name.text === 'then'
              || returnedValue.expression.name.text === 'catch'
              || returnedValue.expression.name.text === 'finally')));
        if (!knownPromiseProducer && checker.getPropertyOfType(returnedType, 'then')
          && !alternativeCarriesDynamicIdentity(candidate)) {
          candidate = { ...candidate, unknown: true, unknownMemberAccess: true };
        }
        return merged ? mergeAlternativeProvenance(merged, candidate) : candidate;
      }, undefined) ?? { unknown: true, unknownMemberAccess: true };
      for (const { symbol, prior } of priorParameters.reverse()) {
        if (prior) callbackParameterProvenance.set(symbol, prior);
        else callbackParameterProvenance.delete(symbol);
      }
      return promiseMethod === 'catch' ? mergeAlternativeProvenance(promised, callbackResult) : callbackResult;
    }
    if (ts.isCallExpression(current) && current.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = current.arguments[0] ? staticRuntimeModulePath(current.arguments[0]) : undefined;
      if (specifier === 'vm' || specifier === 'node:vm') {
        return {
          ...base,
          members: new Map([...DYNAMIC_VM_EXECUTION_MEMBERS].map(member => [member, { kind: `node:vm.${member}` }])),
          ownEnumerableMembers: new Set(DYNAMIC_VM_EXECUTION_MEMBERS),
        };
      }
      if (specifier && EXACT_SAFE_NODE_REQUIRE_SPECIFIERS.has(specifier)) return { expression: current, completeMembers: false };
      const runtimeSource = specifier ? sourceFileForRuntimeModulePath(specifier) : undefined;
      const runtimeModuleSymbol = runtimeSource ? checker.getSymbolAtLocation(runtimeSource) : undefined;
      if (runtimeModuleSymbol) return namespaceForModuleSymbol(runtimeModuleSymbol);
      const awaitedType = checker.getAwaitedType(checker.getTypeAtLocation(current));
      const moduleSymbol = awaitedType?.aliasSymbol ?? awaitedType?.getSymbol();
      if (moduleSymbol && (moduleSymbol.flags & (ts.SymbolFlags.Module | ts.SymbolFlags.ValueModule)) !== 0) {
        return namespaceForModuleSymbol(moduleSymbol);
      }
      return { ...base, unknown: true, unknownMemberAccess: true, completeMembers: false };
    }
    const moduleLoad = classifyModuleLoad(current);
    if (moduleLoad?.kind === 'trusted-builtin') {
      return { expression: current, completeMembers: false };
    }
    if (moduleLoad?.kind === 'vm') {
      return {
        ...base,
        members: new Map([...DYNAMIC_VM_EXECUTION_MEMBERS].map(member => [member, { kind: `node:vm.${member}` }])),
        ownEnumerableMembers: new Set(DYNAMIC_VM_EXECUTION_MEMBERS),
      };
    }
    if (moduleLoad?.kind === 'local-or-unknown') {
      const openType = ((base.type?.flags ?? 0) & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0;
      return openType ? { ...base, unknown: true, unknownMemberAccess: true } : base;
    }
    const initializer = localInitializer(current);
    if (initializer && initializer !== current) {
      const initialized = provenanceForExpression(initializer, seen);
      return { ...initialized, expression: initialized.expression ?? current, type: initialized.type ?? base.type, symbol: base.symbol ?? initialized.symbol };
    }
    if (ts.isIdentifier(current)) {
      const localSymbol = checker.getSymbolAtLocation(current);
      if (localSymbol && (localSymbol.flags & ts.SymbolFlags.Alias) !== 0) {
        return provenanceForExportSymbol(localSymbol);
      }
    }
    if (ts.isArrayLiteralExpression(current)) {
      const members = new Map<string, DynamicProvenance>();
      let outputIndex = 0;
      let completeMembers = true;
      let elementProvenance: DynamicProvenance | undefined;
      let indexProvenanceValue: DynamicProvenance | undefined;
      for (const element of current.elements) {
        if (ts.isOmittedExpression(element)) {
          outputIndex += 1;
          continue;
        }
        if (!ts.isSpreadElement(element)) {
          const value = provenanceForExpression(element, new Set(seen));
          const unresolvedElement = Boolean(value.type
            && (value.type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0);
          members.set(String(outputIndex), unresolvedElement ? { ...value, unknown: true } : value);
          outputIndex += 1;
          continue;
        }
        const spread = provenanceForExpression(element.expression, new Set(seen));
        if (spread.completeMembers === true && spread.arrayLength !== undefined) {
          for (let index = 0; index < spread.arrayLength; index += 1) {
            const value = spread.members?.get(String(index));
            if (value) members.set(String(outputIndex), value);
            outputIndex += 1;
          }
        } else {
          completeMembers = false;
          const spreadIndex = conservativeIndexProvenance(spread);
          elementProvenance = mergeConservativeIndex(elementProvenance, spreadIndex);
          indexProvenanceValue = mergeConservativeIndex(indexProvenanceValue, spreadIndex);
        }
      }
      return {
        ...base,
        members,
        ownEnumerableMembers: new Set(members.keys()),
        element: elementProvenance,
        index: indexProvenanceValue,
        unknown: false,
        unknownMemberAccess: false,
        completeMembers,
        arrayLength: completeMembers ? outputIndex : undefined,
      };
    }
    if (ts.isObjectLiteralExpression(current)) {
      const members = new Map<string, DynamicProvenance>();
      const ownEnumerableMembers = new Set<string>();
      const safeMemberOverrides = new Set<string>();
      let unknown = false;
      let completeMembers = true;
      let indexProvenanceValue: DynamicProvenance | undefined;
      for (const property of current.properties) {
        if (ts.isPropertyAssignment(property)) {
          const key = constantPropertyKey(property.name);
          if (key === undefined) {
            unknown = true;
            safeMemberOverrides.clear();
          } else {
            const value = provenanceForExpression(property.initializer, new Set(seen));
            members.set(key, value);
            ownEnumerableMembers.add(key);
            safeMemberOverrides.delete(key);
            if (isExactLocalSafeValue(value)) safeMemberOverrides.add(key);
          }
        } else if (ts.isShorthandPropertyAssignment(property)) {
          const valueSymbol = checker.getShorthandAssignmentValueSymbol(property);
          const value = valueSymbol && (valueSymbol.flags & ts.SymbolFlags.Alias) !== 0
            ? provenanceForExportSymbol(valueSymbol)
            : provenanceForExpression(property.name, new Set(seen));
          const declarations = valueSymbol?.getDeclarations() ?? [];
          const globalValue = declarations.length > 0 && declarations.every(declaration => declaration.getSourceFile().isDeclarationFile);
          members.set(property.name.text, {
            ...value,
            symbol: valueSymbol ?? value.symbol,
            kind: (valueSymbol ? bindings.dangerousSymbols.get(valueSymbol) : undefined)
              ?? (globalValue && (property.name.text === 'eval' || property.name.text === 'Function') ? property.name.text : value.kind),
          });
          ownEnumerableMembers.add(property.name.text);
          safeMemberOverrides.delete(property.name.text);
        } else if (ts.isMethodDeclaration(property)) {
          const key = constantPropertyKey(property.name);
          if (key === undefined) {
            unknown = true;
            safeMemberOverrides.clear();
          } else {
            members.set(key, { type: checker.getTypeAtLocation(property), symbol: checker.getSymbolAtLocation(property.name) });
            ownEnumerableMembers.add(key);
            safeMemberOverrides.add(key);
          }
        } else if (ts.isSpreadAssignment(property)) {
          const spread = provenanceForExpression(property.expression, new Set(seen));
          const projected = spread.ownEnumerableMembers === undefined
            ? typedOwnEnumerableMembers(spread)
            : { members: spread.members ?? new Map<string, DynamicProvenance>(), complete: spread.completeMembers === true };
          const enumerableKeys = spread.ownEnumerableMembers ?? new Set(projected.members.keys());
          for (const key of enumerableKeys) {
            const value = projected.members.get(key) ?? spread.members?.get(key);
            if (!value) continue;
            members.set(key, value);
            ownEnumerableMembers.add(key);
            safeMemberOverrides.delete(key);
            if (spread.safeMemberOverrides?.has(key) || isExactLocalSafeValue(value)) safeMemberOverrides.add(key);
          }
          indexProvenanceValue = mergeConservativeIndex(
            indexProvenanceValue,
            mergeConservativeIndex(projected.symbolIndex, conservativeIndexProvenance(spread)),
          );
          if (!projected.complete || conservativeIndexProvenance(spread)) {
            completeMembers = false;
            safeMemberOverrides.clear();
          }
        } else {
          unknown = true;
          completeMembers = false;
          safeMemberOverrides.clear();
        }
      }
      return {
        ...base,
        members,
        ownEnumerableMembers,
        safeMemberOverrides,
        index: indexProvenanceValue,
        unknown,
        unknownMemberAccess: unknown,
        completeMembers: completeMembers && !unknown,
      };
    }
    if (isGlobalObjectIdentifier(current, checker)) {
      return { ...base, members: new Map([
        ['eval', { kind: 'eval' }],
        ['Function', { kind: 'Function' }],
      ]), ownEnumerableMembers: new Set() };
    }
    if (isGlobalRequireCall(current, checker) || vmNamespaceReference(current, checker, bindings)) {
      return {
        ...base,
        members: new Map([...DYNAMIC_VM_EXECUTION_MEMBERS].map(member => [member, { kind: `node:vm.${member}` }])),
        ownEnumerableMembers: new Set(DYNAMIC_VM_EXECUTION_MEMBERS),
      };
    }
    const callableKind = staticallyCallableKind(current, checker, bindings);
    if (callableKind) return {
      ...base,
      members: new Map([['constructor', { kind: `${callableKind}.constructor` }]]),
      ownEnumerableMembers: new Set(),
      completeMembers: true,
    };
    return base;
  };
  const exportMemo = new Map<ts.Symbol, DynamicProvenance>();
  const namespaceMemo = new Map<ts.Symbol, DynamicProvenance>();
  namespaceForModuleSymbol = (
    input: ts.Symbol,
    seen = new Set<ts.Symbol>(),
  ): DynamicProvenance => {
    const moduleSymbol = (input.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(input) : input;
    const cached = namespaceMemo.get(moduleSymbol);
    if (cached) return cached;
    if (seen.has(moduleSymbol)) return { symbol: moduleSymbol, completeMembers: false };
    const nextSeen = new Set(seen).add(moduleSymbol);
    const members = new Map<string, DynamicProvenance>();
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      members.set(exported.getName(), provenanceForExportSymbol(exported, nextSeen));
    }
    const result: DynamicProvenance = {
      symbol: moduleSymbol,
      members,
      ownEnumerableMembers: new Set(members.keys()),
      completeMembers: true,
    };
    namespaceMemo.set(moduleSymbol, result);
    return result;
  };
  provenanceForExportSymbol = (
    input: ts.Symbol,
    seen = new Set<ts.Symbol>(),
  ): DynamicProvenance => {
    const symbol = (input.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(input) : input;
    const cached = exportMemo.get(symbol);
    if (cached) return cached;
    if (seen.has(symbol)) return { symbol, completeMembers: false };
    const nextSeen = new Set(seen).add(symbol);
    if ((symbol.flags & (ts.SymbolFlags.Module | ts.SymbolFlags.ValueModule)) !== 0) {
      return namespaceForModuleSymbol(symbol, seen);
    }
    for (const declaration of symbol.getDeclarations() ?? []) {
      if ((ts.isVariableDeclaration(declaration)
        || ts.isPropertyDeclaration(declaration)
        || ts.isPropertyAssignment(declaration)) && declaration.initializer) {
        const initializerSymbol = expressionSymbol(declaration.initializer, checker);
        const result = initializerSymbol && (initializerSymbol.flags & ts.SymbolFlags.Alias) !== 0
          ? provenanceForExportSymbol(initializerSymbol, nextSeen)
          : provenanceForExpression(declaration.initializer);
        exportMemo.set(symbol, result);
        return result;
      }
      if (ts.isExportAssignment(declaration)) {
        const expressionSymbolValue = expressionSymbol(declaration.expression, checker);
        const result = expressionSymbolValue && expressionSymbolValue !== symbol
          ? provenanceForExportSymbol(expressionSymbolValue, nextSeen)
          : provenanceForExpression(declaration.expression);
        exportMemo.set(symbol, result);
        return result;
      }
      if (ts.isImportSpecifier(declaration) || ts.isImportClause(declaration)) {
        const local = ts.isImportSpecifier(declaration) ? declaration.name : declaration.name;
        if (local) {
          const alias = checker.getSymbolAtLocation(local);
          if (alias) return provenanceForExportSymbol(alias, nextSeen);
        }
      }
      if (ts.isFunctionDeclaration(declaration)
        || ts.isClassDeclaration(declaration)
        || ts.isMethodDeclaration(declaration)) {
        if (!declaration.getSourceFile().isDeclarationFile) {
          const result = { type: checker.getTypeOfSymbolAtLocation(symbol, declaration), symbol };
          exportMemo.set(symbol, result);
          return result;
        }
      }
    }
    const declarations = symbol.getDeclarations() ?? [];
    if (declarations.length > 0 && declarations.every(declaration => declaration.getSourceFile().isDeclarationFile)) {
      if (symbol.getName() === 'eval' || symbol.getName() === 'Function') return { symbol, kind: symbol.getName() };
      if (DYNAMIC_VM_EXECUTION_MEMBERS.has(symbol.getName())) return { symbol, kind: `node:vm.${symbol.getName()}` };
    }
    const declaration = symbol.valueDeclaration ?? symbol.getDeclarations()?.[0];
    const type = declaration ? checker.getTypeOfSymbolAtLocation(symbol, declaration) : undefined;
    const result = { type, symbol, kind: type ? dangerousCallableTypeKind(type) : undefined };
    exportMemo.set(symbol, result);
    return result;
  };
  const importBindingProvenance = (identifier: ts.Identifier): DynamicProvenance | undefined => {
    const local = checker.getSymbolAtLocation(identifier);
    if (!local || (local.flags & ts.SymbolFlags.Alias) === 0) return undefined;
    return provenanceForExportSymbol(checker.getAliasedSymbol(local));
  };
  const namespaceImportProvenance = (identifier: ts.Identifier): DynamicProvenance | undefined => {
    const local = checker.getSymbolAtLocation(identifier);
    if (!local || (local.flags & ts.SymbolFlags.Alias) === 0) return undefined;
    return namespaceForModuleSymbol(checker.getAliasedSymbol(local));
  };
  const provenancePotentiallyDangerous = (provenance: DynamicProvenance, seen = new Set<DynamicProvenance>()): boolean => {
    if (seen.has(provenance)) return false;
    seen.add(provenance);
    if (provenance.kind || provenance.unknown) return true;
    if (provenance.expression && dynamicReferenceKind(provenance.expression, checker, bindings)) return true;
    if (provenance.type && (provenance.type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0) return true;
    return [...(provenance.members?.values() ?? [])].some(member => provenancePotentiallyDangerous(member, seen))
      || Boolean(provenance.element && provenancePotentiallyDangerous(provenance.element, seen))
      || Boolean(provenance.index && provenancePotentiallyDangerous(provenance.index, seen));
  };
  const indexProvenance = (base: DynamicProvenance): DynamicProvenance | undefined => {
    if (!base.type) return undefined;
    const stringIndex = checker.getIndexTypeOfType(base.type, ts.IndexKind.String);
    const numberIndex = checker.getIndexTypeOfType(base.type, ts.IndexKind.Number);
    const candidates = [stringIndex, numberIndex].filter((type): type is ts.Type => Boolean(type));
    const indexDomain = stringIndex && numberIndex ? 'both' : stringIndex ? 'string' : numberIndex ? 'number' : undefined;
    const dangerous = candidates.find(type => typeRequiresFailClosedCallableClassification(type, checker));
    if (dangerous) return { type: dangerous, kind: 'unresolved-index-result', indexDomain };
    if (candidates[0]) return { type: candidates[0], indexDomain };
    const dangerousProperty = checker.getPropertiesOfType(base.type).find(property => {
      const type = checker.getTypeOfSymbolAtLocation(property, base.expression ?? source);
      return typeRequiresFailClosedCallableClassification(type, checker);
    });
    if (dangerousProperty) return {
      type: checker.getTypeOfSymbolAtLocation(dangerousProperty, base.expression ?? source),
      symbol: dangerousProperty,
      kind: 'unresolved-known-property',
      indexDomain: 'string',
    };
    if ((base.type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0) {
      return { type: base.type, kind: 'unresolved-index-source', indexDomain: 'both' };
    }
    return undefined;
  };
  const selectMember = (base: DynamicProvenance, key: string | undefined): DynamicProvenance => {
    if (key === undefined) {
      if (provenancePotentiallyDangerous(base)) return { kind: 'unresolved-computed-key', unknown: true };
      return base.index ?? indexProvenance(base) ?? {};
    }
    const exact = base.members?.get(key);
    if (exact) return exact;
    if ((key === 'eval' || key === 'Function') && base.expression && isGlobalObjectIdentifier(base.expression, checker)) return { kind: key };
    if (DYNAMIC_VM_EXECUTION_MEMBERS.has(key) && base.expression && vmNamespaceReference(base.expression, checker, bindings)) return { kind: `node:vm.${key}` };
    if (key === 'constructor') {
      const kind = constructorTypeKind(base);
      if (kind) return { kind: `${kind}.constructor` };
    }
    const property = base.type ? checker.getPropertyOfType(base.type, key) : undefined;
    if (property) return {
      type: checker.getTypeOfSymbolAtLocation(property, base.expression ?? source),
      symbol: property,
    };
    if (/^\d+$/.test(key) && base.element) return base.element;
    if (base.index) return base.index;
    if (base.type) {
      const numeric = /^\d+$/.test(key);
      const type = (numeric ? checker.getIndexTypeOfType(base.type, ts.IndexKind.Number) : undefined)
        ?? checker.getIndexTypeOfType(base.type, ts.IndexKind.String);
      if (type) return { type, kind: typeRequiresFailClosedCallableClassification(type, checker) ? 'unresolved-array-element' : undefined };
    }
    return base.index ?? indexProvenance(base) ?? {};
  };
  const arrayRest = (base: DynamicProvenance, start: number): DynamicProvenance => {
    const members = new Map<string, DynamicProvenance>();
    for (const [key, value] of base.members ?? []) {
      const index = Number(key);
      if (Number.isInteger(index) && index >= start) members.set(String(index - start), value);
    }
    let element = base.element;
    if (!element && base.type) {
      const elementType = checker.getIndexTypeOfType(base.type, ts.IndexKind.Number);
      if (elementType) element = {
        type: elementType,
        kind: typeRequiresFailClosedCallableClassification(elementType, checker) ? 'unresolved-array-rest-element' : undefined,
        indexDomain: 'number',
      };
    }
    const index = element ?? base.index ?? indexProvenance(base) ?? { kind: 'unresolved-non-indexable-rest' };
    const nonIndexable = index.kind === 'unresolved-non-indexable-rest';
    return {
      expression: base.expression,
      type: base.type,
      symbol: base.symbol,
      members,
      element,
      index,
      unknown: base.unknown,
      unknownMemberAccess: base.unknownMemberAccess || nonIndexable,
      completeMembers: base.completeMembers === true && !nonIndexable,
      arrayLength: base.arrayLength === undefined ? undefined : Math.max(0, base.arrayLength - start),
    };
  };
  const objectRest = (base: DynamicProvenance, excluded: ReadonlySet<string>): DynamicProvenance => {
    const members = new Map<string, DynamicProvenance>();
    for (const [key, value] of base.members ?? []) if (!excluded.has(key)) members.set(key, value);
    if (base.type) {
      for (const property of checker.getPropertiesOfType(base.type)) {
        if (!excluded.has(property.name) && !members.has(property.name)) members.set(property.name, selectMember(base, property.name));
      }
    }
    const index = base.index ?? indexProvenance(base) ?? { kind: 'unresolved-non-indexable-rest' };
    const unknownMemberAccess = base.unknownMemberAccess || base.unknown
      || ((base.type?.flags ?? 0) & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0;
    return {
      expression: base.expression,
      type: base.type,
      symbol: base.symbol,
      members,
      index,
      unknown: base.unknown,
      unknownMemberAccess: unknownMemberAccess || index.kind === 'unresolved-non-indexable-rest',
      completeMembers: base.completeMembers === true
        && !unknownMemberAccess,
    };
  };
  const addRecord = (name: ts.Node, provenance: DynamicProvenance | undefined, conditional = false): void => {
    if (!provenance || !ts.isIdentifier(name)) return;
    const symbol = identifierSymbol(name, checker);
    if (symbol) aliases.push({ target: symbol, provenance, conditional });
  };
  const walkPattern = (pattern: ts.Node, provenance: DynamicProvenance | undefined, conditional = false): void => {
    if (ts.isIdentifier(pattern)) {
      addRecord(pattern, provenance, conditional);
      return;
    }
    if (ts.isPropertyAccessExpression(pattern) || ts.isElementAccessExpression(pattern)) {
      if (!provenance) return;
      const directTarget = ts.isPropertyAccessExpression(pattern)
        ? checker.getSymbolAtLocation(pattern.name)
        : pattern.argumentExpression ? checker.getSymbolAtLocation(pattern.argumentExpression) : undefined;
      const key = ts.isPropertyAccessExpression(pattern)
        ? pattern.name.text
        : pattern.argumentExpression ? staticPropertyKeyExpression(pattern.argumentExpression, checker) : undefined;
      const target = key === undefined
        ? directTarget
        : checker.getPropertyOfType(checker.getTypeAtLocation(pattern.expression), key) ?? directTarget;
      if (target) aliases.push({ target, provenance, conditional });
      return;
    }
    if (ts.isBinaryExpression(pattern) && pattern.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      walkPattern(pattern.left, provenance, conditional);
      walkPattern(pattern.left, provenanceForExpression(pattern.right), conditional);
      return;
    }
    if (ts.isObjectBindingPattern(pattern)) {
      const excluded = new Set<string>();
      for (const element of pattern.elements) {
        if (element.dotDotDotToken) {
          walkPattern(element.name, provenance ? objectRest(provenance, excluded) : undefined, conditional);
          continue;
        }
        const key = element.propertyName
          ? constantPropertyKey(element.propertyName)
          : ts.isIdentifier(element.name) ? element.name.text : undefined;
        if (key !== undefined) excluded.add(key);
        walkPattern(element.name, provenance ? selectMember(provenance, key) : undefined, conditional);
        if (element.initializer) walkPattern(element.name, provenanceForExpression(element.initializer), conditional);
      }
      return;
    }
    if (ts.isArrayBindingPattern(pattern)) {
      pattern.elements.forEach((element, index) => {
        if (!ts.isBindingElement(element)) return;
        walkPattern(element.name, provenance ? (element.dotDotDotToken ? arrayRest(provenance, index) : selectMember(provenance, String(index))) : undefined, conditional);
        if (element.initializer) walkPattern(element.name, provenanceForExpression(element.initializer), conditional);
      });
      return;
    }
    if (ts.isObjectLiteralExpression(pattern)) {
      const excluded = new Set<string>();
      for (const property of pattern.properties) {
        if (ts.isPropertyAssignment(property)) {
          const key = constantPropertyKey(property.name);
          if (key !== undefined) excluded.add(key);
          walkPattern(property.initializer, provenance ? selectMember(provenance, key) : undefined, conditional);
        } else if (ts.isShorthandPropertyAssignment(property)) {
          excluded.add(property.name.text);
          const selected = provenance ? selectMember(provenance, property.name.text) : undefined;
          const assignmentSymbol = checker.getShorthandAssignmentValueSymbol(property);
          if (selected && assignmentSymbol) aliases.push({ target: assignmentSymbol, provenance: selected });
          else walkPattern(property.name, selected, conditional);
          if (property.objectAssignmentInitializer) walkPattern(property.name, provenanceForExpression(property.objectAssignmentInitializer), conditional);
        } else if (ts.isSpreadAssignment(property)) {
          walkPattern(property.expression, provenance ? objectRest(provenance, excluded) : undefined, conditional);
        }
      }
      return;
    }
    if (ts.isArrayLiteralExpression(pattern)) {
      pattern.elements.forEach((element, index) => {
        if (ts.isOmittedExpression(element)) return;
        walkPattern(ts.isSpreadElement(element) ? element.expression : element, provenance ? (ts.isSpreadElement(element) ? arrayRest(provenance, index) : selectMember(provenance, String(index))) : undefined, conditional);
      });
    }
  };
  type LocalCallableDeclaration = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;
  type InvocationMember = 'call' | 'apply' | 'bind';
  interface NormalizedInvocation {
    target: ts.Expression;
    member?: InvocationMember;
    unknownComputed: boolean;
  }
  const normalizedInvocationCallee = (expression: ts.Expression): NormalizedInvocation => {
    const current = unwrapExecutionExpression(expression);
    if (!ts.isPropertyAccessExpression(current) && !ts.isElementAccessExpression(current)) {
      return { target: expression, unknownComputed: false };
    }
    const key = ts.isPropertyAccessExpression(current)
      ? current.name.text
      : current.argumentExpression ? staticPropertyKeyExpression(current.argumentExpression, checker) : undefined;
    if (key === 'call' || key === 'apply' || key === 'bind') {
      return { target: current.expression, member: key, unknownComputed: false };
    }
    if (ts.isElementAccessExpression(current) && key === undefined) {
      return { target: current.expression, unknownComputed: true };
    }
    return { target: expression, unknownComputed: false };
  };
  const localCallableDeclarations = (
    expression: ts.Expression,
    seen = new Set<ts.Symbol>(),
  ): LocalCallableDeclaration[] => {
    const current = unwrapExecutionExpression(expression);
    if (ts.isFunctionExpression(current) || ts.isArrowFunction(current)) return [current];
    let symbol = expressionSymbol(current, checker);
    if (!symbol) return [];
    if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
    if (seen.has(symbol)) return [];
    const nextSeen = new Set(seen).add(symbol);
    const declarations: LocalCallableDeclaration[] = [];
    for (const declaration of symbol.getDeclarations() ?? []) {
      if (ts.isFunctionDeclaration(declaration) && declaration.body) declarations.push(declaration);
      else if (ts.isMethodDeclaration(declaration) && declaration.body) declarations.push(declaration);
      else if ((ts.isVariableDeclaration(declaration)
        || ts.isPropertyDeclaration(declaration)
        || ts.isPropertyAssignment(declaration)) && declaration.initializer) {
        const initializer = unwrapExecutionExpression(declaration.initializer);
        const normalized = ts.isCallExpression(initializer)
          ? normalizedInvocationCallee(initializer.expression)
          : undefined;
        if (normalized?.member === 'bind') {
          declarations.push(...localCallableDeclarations(normalized.target, nextSeen));
        } else declarations.push(...localCallableDeclarations(initializer, nextSeen));
      }
    }
    return [...new Set(declarations)];
  };
  interface ArgumentVector {
    prefix: DynamicProvenance[];
    unknownTail?: DynamicProvenance;
  }
  const mergeArgumentValue = (
    left: DynamicProvenance | undefined,
    right: DynamicProvenance | undefined,
  ): DynamicProvenance | undefined => left && right ? mergeAlternativeProvenance(left, right) : left ?? right;
  const exactSpreadValues = (provenance: DynamicProvenance): DynamicProvenance[] | undefined => {
    if (provenance.completeMembers === true && provenance.arrayLength !== undefined) {
      return Array.from({ length: provenance.arrayLength }, (_, index) => selectMember(provenance, String(index)));
    }
    if (!provenance.type || !checker.isTupleType(provenance.type)) return undefined;
    return checker.getTypeArguments(provenance.type as ts.TypeReference).map(type => ({
      type,
      kind: dangerousCallableTypeKind(type),
    }));
  };
  const spreadTailValue = (provenance: DynamicProvenance): DynamicProvenance => {
    const rest = arrayRest(provenance, 0);
    return rest.index ?? rest.element ?? rest;
  };
  const flattenCallArguments = (args: readonly ts.Expression[]): ArgumentVector => {
    const vector: ArgumentVector = { prefix: [] };
    for (const argument of args) {
      if (!ts.isSpreadElement(argument)) {
        const value = provenanceForExpression(argument);
        if (vector.unknownTail) vector.unknownTail = mergeArgumentValue(vector.unknownTail, value);
        else vector.prefix.push(value);
        continue;
      }
      const spread = provenanceForExpression(argument.expression);
      const exact = exactSpreadValues(spread);
      if (exact && !vector.unknownTail) vector.prefix.push(...exact);
      else {
        const tail = exact
          ? packedArgumentProvenance(exact)
          : spreadTailValue(spread);
        vector.unknownTail = mergeArgumentValue(vector.unknownTail, tail);
      }
    }
    return vector;
  };
  const vectorFromApplied = (provenance: DynamicProvenance | undefined): ArgumentVector => {
    if (!provenance) return { prefix: [] };
    const exact = exactSpreadValues(provenance);
    return exact ? { prefix: exact } : { prefix: [], unknownTail: spreadTailValue(provenance) };
  };
  const argumentVectorValueAt = (vector: ArgumentVector, index: number): DynamicProvenance | undefined => (
    mergeArgumentValue(vector.prefix[index], vector.unknownTail)
  );
  const dropArgumentVectorPrefix = (vector: ArgumentVector, count: number): ArgumentVector => ({
    prefix: vector.prefix.slice(count),
    unknownTail: vector.unknownTail,
  });
  const projectInvocationArguments = (
    full: ArgumentVector,
    normalized: NormalizedInvocation,
  ): { direct: ArgumentVector; applied: ArgumentVector } => {
    if (normalized.member === 'apply') {
      return {
        direct: { prefix: [] },
        applied: vectorFromApplied(argumentVectorValueAt(full, 1)),
      };
    }
    if (normalized.member === 'call' || normalized.member === 'bind') {
      return { direct: dropArgumentVectorPrefix(full, 1), applied: { prefix: [] } };
    }
    if (normalized.unknownComputed) {
      return {
        direct: dropArgumentVectorPrefix(full, 1),
        applied: vectorFromApplied(argumentVectorValueAt(full, 1)),
      };
    }
    return { direct: full, applied: { prefix: [] } };
  };
  const concatenateArgumentVectors = (prior: ArgumentVector, added: ArgumentVector): ArgumentVector => {
    if (!prior.unknownTail) {
      return {
        prefix: [...prior.prefix, ...added.prefix],
        unknownTail: added.unknownTail,
      };
    }
    const uncertainValues = [prior.unknownTail, ...added.prefix, added.unknownTail]
      .filter((value): value is DynamicProvenance => Boolean(value));
    return {
      prefix: prior.prefix,
      unknownTail: uncertainValues.reduce<DynamicProvenance | undefined>(
        (merged, value) => mergeArgumentValue(merged, value),
        undefined,
      ),
    };
  };
  const boundArgumentProvenance = (expression: ts.Expression, seen = new Set<ts.Symbol>()): ArgumentVector => {
    const current = unwrapExecutionExpression(expression);
    const symbol = expressionSymbol(current, checker);
    if (!symbol || seen.has(symbol)) return { prefix: [] };
    const nextSeen = new Set(seen).add(symbol);
    for (const declaration of symbol.getDeclarations() ?? []) {
      if (!(ts.isVariableDeclaration(declaration)
        || ts.isPropertyDeclaration(declaration)
        || ts.isPropertyAssignment(declaration)) || !declaration.initializer) continue;
      const initializer = unwrapExecutionExpression(declaration.initializer);
      if (ts.isCallExpression(initializer)) {
        const normalized = normalizedInvocationCallee(initializer.expression);
        if (normalized.member === 'bind') {
          const prior = boundArgumentProvenance(normalized.target, nextSeen);
          const full = flattenCallArguments(initializer.arguments);
          const added = projectInvocationArguments(full, normalized).direct;
          return concatenateArgumentVectors(prior, added);
        }
      }
    }
    return { prefix: [] };
  };
  const packedArgumentProvenance = (values: readonly DynamicProvenance[]): DynamicProvenance => {
    const members = new Map(values.map((value, index) => [String(index), value]));
    const element = values.reduce<DynamicProvenance | undefined>(
      (merged, value) => merged ? mergeAlternativeProvenance(merged, value) : value,
      undefined,
    );
    return {
      members,
      ownEnumerableMembers: new Set(members.keys()),
      element,
      index: element ? { ...element, indexDomain: 'number' } : undefined,
      completeMembers: true,
      arrayLength: values.length,
    };
  };
  const bindLocalCallArguments = (call: ts.CallExpression | ts.NewExpression): void => {
    const args = call.arguments ?? [];
    const normalized = normalizedInvocationCallee(call.expression);
    const { target } = normalized;
    const bound = boundArgumentProvenance(target);
    const full = flattenCallArguments(args);
    const { direct, applied } = projectInvocationArguments(full, normalized);
    const suppliedAt = (index: number): DynamicProvenance | undefined => {
      if (index < bound.prefix.length) return bound.prefix[index];
      const remaining = index - bound.prefix.length;
      const supplied = mergeArgumentValue(
        argumentVectorValueAt(direct, remaining),
        argumentVectorValueAt(applied, remaining),
      );
      return mergeArgumentValue(bound.unknownTail, supplied);
    };
    const vectorRestAt = (vector: ArgumentVector, index: number): DynamicProvenance => {
      const packed = packedArgumentProvenance(vector.prefix.slice(index));
      return vector.unknownTail ? mergeAlternativeProvenance(packed, vector.unknownTail) : packed;
    };
    const restAt = (index: number): DynamicProvenance => {
      const boundRest = vectorRestAt(bound, index);
      const remaining = Math.max(0, index - bound.prefix.length);
      return mergeAlternativeProvenance(
        boundRest,
        mergeAlternativeProvenance(vectorRestAt(direct, remaining), vectorRestAt(applied, remaining)),
      );
    };
    for (const callable of localCallableDeclarations(target)) {
      callable.parameters.forEach((parameter, index) => {
        const argument = parameter.dotDotDotToken ? restAt(index) : suppliedAt(index);
        if (!argument) return;
        // Every local call site is an alternative input. Conditional merging is
        // deliberate: one dangerous argument must dominate any safe calls.
        walkPattern(parameter.name, argument, true);
      });
    }
  };
  const conditionallyExecuted = (node: ts.Node): boolean => {
    if (ts.isBinaryExpression(node)
      && (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken
        || node.operatorToken.kind === ts.SyntaxKind.BarBarEqualsToken
        || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken)) return true;
    let child: ts.Node = node;
    let current: ts.Node | undefined = node.parent;
    while (current && current !== source && !ts.isFunctionLike(current)) {
      if (ts.isIfStatement(current) || ts.isConditionalExpression(current)
        || ts.isForStatement(current) || ts.isForInStatement(current) || ts.isForOfStatement(current)
        || ts.isWhileStatement(current) || ts.isDoStatement(current) || ts.isSwitchStatement(current)
        || ts.isTryStatement(current)) return true;
      if (ts.isBinaryExpression(current)
        && current.right === child
        && (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
          || current.operatorToken.kind === ts.SyntaxKind.BarBarToken
          || current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) return true;
      child = current;
      current = current.parent;
    }
    return false;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)
      && ts.isStringLiteral(node.moduleSpecifier)
      && node.moduleSpecifier.text !== 'node:vm'
      && node.moduleSpecifier.text !== 'vm') {
      if (node.importClause?.name) {
        const provenance = importBindingProvenance(node.importClause.name);
        const target = identifierSymbol(node.importClause.name, checker);
        if (provenance && target) aliases.push({ target, provenance });
      }
      const imported = node.importClause?.namedBindings;
      if (imported && ts.isNamedImports(imported)) {
        for (const element of imported.elements) {
          const provenance = importBindingProvenance(element.name);
          const target = identifierSymbol(element.name, checker);
          if (provenance && target) aliases.push({ target, provenance });
        }
      } else if (imported && ts.isNamespaceImport(imported)) {
        const provenance = namespaceImportProvenance(imported.name);
        const target = identifierSymbol(imported.name, checker);
        if (provenance && target) aliases.push({ target, provenance });
      }
    }
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
      walkPattern(node.name, node.initializer ? provenanceForExpression(node.initializer) : undefined);
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) bindLocalCallArguments(node);
    if (ts.isVariableDeclaration(node) && node.initializer) {
      walkPattern(node.name, provenanceForExpression(node.initializer));
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      walkPattern(node.left, provenanceForExpression(node.right), conditionallyExecuted(node));
    }
    if (ts.isBinaryExpression(node)
      && (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken
        || node.operatorToken.kind === ts.SyntaxKind.BarBarEqualsToken
        || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken)) {
      walkPattern(node.left, provenanceForExpression(node.right), true);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const symbolProvenance = new Map<ts.Symbol, DynamicProvenance>();
  const resolveProvenance = (provenance: DynamicProvenance): DynamicProvenance => {
    const inherited = provenance.symbol ? symbolProvenance.get(provenance.symbol) : undefined;
    if (!inherited) return provenance;
    return {
      ...inherited,
      ...provenance,
      kind: provenance.kind ?? inherited.kind,
      members: provenance.members?.size ? provenance.members : inherited.members,
      ownEnumerableMembers: provenance.ownEnumerableMembers ?? inherited.ownEnumerableMembers,
      safeMemberOverrides: provenance.safeMemberOverrides ?? inherited.safeMemberOverrides,
      element: provenance.element ?? inherited.element,
      index: provenance.index ?? inherited.index,
      indexDomain: provenance.indexDomain ?? inherited.indexDomain,
      unknown: provenance.unknown || inherited.unknown,
      unknownMemberAccess: provenance.unknownMemberAccess || inherited.unknownMemberAccess,
      completeMembers: provenance.completeMembers ?? inherited.completeMembers,
      arrayLength: provenance.arrayLength ?? inherited.arrayLength,
    };
  };
  const provenanceKind = (provenance: DynamicProvenance): string | undefined => {
    const primitiveMask = ts.TypeFlags.StringLike
      | ts.TypeFlags.NumberLike
      | ts.TypeFlags.BooleanLike
      | ts.TypeFlags.BigIntLike
      | ts.TypeFlags.ESSymbolLike
      | ts.TypeFlags.Null
      | ts.TypeFlags.Undefined;
    const exactSafePrimitive = Boolean(provenance.type
      && (provenance.type.flags & primitiveMask) !== 0
      && !typeRequiresFailClosedCallableClassification(provenance.type, checker));
    return provenance.kind
      ?? (!exactSafePrimitive && provenance.expression ? dynamicReferenceKind(provenance.expression, checker, bindings) : undefined)
      ?? (provenance.unknown ? 'unresolved-value-provenance' : undefined)
      ?? (provenance.unknownMemberAccess ? 'unresolved-rest-provenance' : undefined);
  };
  const mergeProvenanceAlternatives = (
    current: DynamicProvenance | undefined,
    alternative: DynamicProvenance,
  ): DynamicProvenance => {
    if (!current) return alternative;
    const members = new Map(current.members ?? []);
    for (const [member, candidate] of alternative.members ?? []) {
      const existing = members.get(member);
      if (!existing) members.set(member, candidate);
      else {
        const dangerous = provenanceKind(existing) ? existing : provenanceKind(candidate) ? candidate : undefined;
        members.set(member, dangerous ?? mergeProvenanceAlternatives(existing, candidate));
      }
    }
    const indexed = current.index ?? current.element;
    const alternativeIndexed = alternative.index ?? alternative.element;
    const index = provenanceKind(indexed ?? {}) ? indexed
      : provenanceKind(alternativeIndexed ?? {}) ? alternativeIndexed
        : indexed ?? alternativeIndexed;
    return {
      expression: alternative.expression ?? current.expression,
      type: alternative.type ?? current.type,
      symbol: alternative.symbol ?? current.symbol,
      kind: provenanceKind(current) ?? provenanceKind(alternative),
      members,
      element: alternative.element ?? current.element,
      index,
      indexDomain: index?.indexDomain,
      ownEnumerableMembers: undefined,
      safeMemberOverrides: undefined,
      unknown: current.unknown || alternative.unknown,
      unknownMemberAccess: current.unknownMemberAccess || alternative.unknownMemberAccess,
      completeMembers: false,
      arrayLength: current.arrayLength === alternative.arrayLength ? current.arrayLength : undefined,
    };
  };
  const memberProvenanceKind = (member: string, provenance: DynamicProvenance): string | undefined => {
    const direct = provenanceKind(provenance);
    if (direct) return direct;
    if (provenance.expression && hasExactLocalNonCallableEvidence(provenance.expression, checker)) return undefined;
    const declarations = provenance.symbol?.getDeclarations() ?? [];
    if (declarations.length > 0 && declarations.every(declaration => (
      !declaration.getSourceFile().isDeclarationFile
      && resolve(declaration.getSourceFile().fileName).startsWith(`${resolve(repoRoot)}/`)
      && !ts.isPropertySignature(declaration)
    ))) return undefined;
    const potentiallyCallable = Boolean(provenance.type && typeRequiresFailClosedCallableClassification(provenance.type, checker));
    if (!potentiallyCallable) return undefined;
    if (member === 'eval' || member === 'Function') return member;
    if (DYNAMIC_VM_EXECUTION_MEMBERS.has(member)) return `node:vm.${member}`;
    if (member === 'constructor') return 'unresolved-or-callable.constructor';
    return undefined;
  };
  const isExplicitCompleteLocalSafeMember = (provenance: DynamicProvenance): boolean => {
    if (provenance.kind || provenance.unknown || provenance.unknownMemberAccess) return false;
    if (provenance.expression && dynamicReferenceKind(provenance.expression, checker, bindings)) return false;
    const current = provenance.expression ? unwrapExecutionExpression(provenance.expression) : undefined;
    if (current && (ts.isArrowFunction(current)
      || ts.isFunctionExpression(current)
      || ts.isObjectLiteralExpression(current)
      || ts.isArrayLiteralExpression(current)
      || ts.isStringLiteralLike(current)
      || ts.isNumericLiteral(current))) return true;
    const declarations = provenance.symbol?.getDeclarations() ?? [];
    return declarations.length > 0 && declarations.every(declaration => (
      !declaration.getSourceFile().isDeclarationFile
      && resolve(declaration.getSourceFile().fileName).startsWith(`${resolve(repoRoot)}/`)
      && !ts.isPropertySignature(declaration)
      && !ts.isMethodSignature(declaration)
    ));
  };
  const aliasSourceCounts = new Map<ts.Symbol, number>();
  for (const alias of aliases) aliasSourceCounts.set(alias.target, (aliasSourceCounts.get(alias.target) ?? 0) + 1);
  let changed = true;
  while (changed) {
    changed = false;
    for (const alias of aliases) {
      const provenance = resolveProvenance(alias.provenance);
      const expression = provenance.expression;
      symbolProvenance.set(alias.target, aliasSourceCounts.get(alias.target) === 1 || !alias.conditional
        ? provenance
        : mergeProvenanceAlternatives(symbolProvenance.get(alias.target), provenance));
      bindings.provenanceBySymbol.set(
        alias.target,
        alias.conditional
          ? mergeAlternativeProvenance(bindings.provenanceBySymbol.get(alias.target) ?? provenance, provenance)
          : provenance,
      );
      if (expression && !bindings.vmNamespaceSymbols.has(alias.target) && vmNamespaceReference(expression, checker, bindings)) {
        bindings.vmNamespaceSymbols.add(alias.target);
        changed = true;
      }
      if (expression && !bindings.functionCallableSymbols.has(alias.target)) {
        const callableKind = functionCallableReference(expression, checker, bindings);
        if (callableKind) bindings.functionCallableSymbols.set(alias.target, callableKind);
        if (callableKind) changed = true;
      }
      if (provenance.members) {
        const knownMembers = bindings.knownMembers.get(alias.target) ?? new Set<string>();
        for (const member of provenance.members.keys()) knownMembers.add(member);
        bindings.knownMembers.set(alias.target, knownMembers);
        if (aliasSourceCounts.get(alias.target) === 1
          && provenance.completeMembers === true
          && !provenance.unknown) bindings.knownMembersComplete.add(alias.target);
        else bindings.knownMembersComplete.delete(alias.target);
        const memberKinds = bindings.memberKinds.get(alias.target) ?? new Map<string, string>();
        for (const [member, memberProvenance] of provenance.members) {
          const resolvedMember = resolveProvenance(memberProvenance);
          const kind = provenance.completeMembers === true && isExplicitCompleteLocalSafeMember(resolvedMember)
            ? undefined
            : memberProvenanceKind(member, resolvedMember);
          if (kind && !memberKinds.has(member)) {
            memberKinds.set(member, kind);
            changed = true;
          }
        }
        if (memberKinds.size > 0) bindings.memberKinds.set(alias.target, memberKinds);
      }
      if (aliasSourceCounts.get(alias.target) === 1 && provenance.safeMemberOverrides?.size) {
        bindings.safeMemberOverrides.set(alias.target, new Set(provenance.safeMemberOverrides));
      } else {
        bindings.safeMemberOverrides.delete(alias.target);
      }
      const indexed = provenance.index ?? provenance.element;
      if (indexed && !bindings.indexKinds.has(alias.target)) {
        const kind = provenanceKind(resolveProvenance(indexed));
        if (kind) {
          bindings.indexKinds.set(alias.target, kind);
          bindings.indexDomains.set(alias.target, indexed.indexDomain ?? provenance.indexDomain ?? 'both');
          changed = true;
        }
      }
      if (loaderBindings.createRequireSymbols.has(alias.target) || loaderBindings.loaderSymbols.has(alias.target)) {
        bindings.dangerousSymbols.delete(alias.target);
        continue;
      }
      if (!bindings.dangerousSymbols.has(alias.target)) {
        const kind = provenanceKind(provenance);
        if (kind) {
          bindings.dangerousSymbols.set(alias.target, kind);
          changed = true;
        }
      }
    }
  }
  // Reconcile mutable targets from their complete, source-ordered alternative
  // set. Unconditional final writes replace earlier values; conditional writes
  // remain merged by symbolProvenance and therefore preserve danger-wins.
  const orderedFinalProvenance = new Map<ts.Symbol, DynamicProvenance>();
  for (const alias of aliases) {
    const provenance = resolveProvenance(alias.provenance);
    const current = orderedFinalProvenance.get(alias.target);
    orderedFinalProvenance.set(alias.target, alias.conditional && current
      ? mergeProvenanceAlternatives(current, provenance)
      : provenance);
  }
  for (const [target, provenance] of orderedFinalProvenance) {
    if (loaderBindings.createRequireSymbols.has(target) || loaderBindings.loaderSymbols.has(target)) continue;
    const kind = provenanceKind(resolveProvenance(provenance));
    if (kind) {
      bindings.dangerousSymbols.set(target, kind);
      bindings.exactSafeSymbols.delete(target);
    } else {
      bindings.dangerousSymbols.delete(target);
      bindings.exactSafeSymbols.add(target);
    }
  }
  bindings.expressionKind = expression => {
    const current = unwrapExecutionExpression(expression);
    const memberKey = ts.isPropertyAccessExpression(current)
      ? current.name.text
      : ts.isElementAccessExpression(current) && current.argumentExpression
        ? staticPropertyKeyExpression(current.argumentExpression, checker)
        : undefined;
    const symbol = ts.isIdentifier(current)
      ? identifierSymbol(current, checker)
      : (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) && memberKey !== undefined
        ? checker.getPropertyOfType(checker.getTypeAtLocation(current.expression), memberKey)
        : undefined;
    if (symbol && (loaderBindings.createRequireSymbols.has(symbol) || loaderBindings.loaderSymbols.has(symbol))) return undefined;
    const ordered = symbol ? orderedFinalProvenance.get(symbol) : undefined;
    return provenanceKind(ordered ? resolveProvenance(ordered) : provenanceForExpression(expression));
  };
  if (program) {
    const targetCache = programCache ?? new WeakMap<ts.SourceFile, DynamicExecutionBindings>();
    targetCache.set(source, bindings);
    if (!programCache) dynamicBindingsCache.set(program, targetCache);
  }
  return bindings;
}
