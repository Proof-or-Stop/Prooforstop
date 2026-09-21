import assert from 'node:assert/strict';



import { builtinModules } from 'node:module';

import { resolve } from 'node:path';

import ts from 'typescript';


import { unwrapExecutionExpression } from "./dynamic-scan.js";
import { isGlobalIdentifier } from "./module-loaders.js";
import { repoRoot } from "./rule-data.js";

export const DYNAMIC_VM_EXECUTION_MEMBERS = new Set([
  'runInThisContext',
  'runInNewContext',
  'runInContext',
  'compileFunction',
  'Script',
  'SourceTextModule',
  'SyntheticModule',
]);

export interface DynamicExecutionBindings {
  dangerousSymbols: Map<ts.Symbol, string>;
  exactSafeSymbols: Set<ts.Symbol>;
  vmNamespaceSymbols: Set<ts.Symbol>;
  functionCallableSymbols: Map<ts.Symbol, string>;
  memberKinds: Map<ts.Symbol, Map<string, string>>;
  knownMembers: Map<ts.Symbol, Set<string>>;
  knownMembersComplete: Set<ts.Symbol>;
  safeMemberOverrides: Map<ts.Symbol, Set<string>>;
  indexKinds: Map<ts.Symbol, string>;
  indexDomains: Map<ts.Symbol, DynamicIndexDomain>;
  provenanceBySymbol: Map<ts.Symbol, DynamicProvenance>;
  expressionKind?: (expression: ts.Expression) => string | undefined;
}

export type DynamicIndexDomain = 'string' | 'number' | 'both' | 'symbol' | 'all';

export interface DynamicProvenance {
  expression?: ts.Expression;
  type?: ts.Type;
  symbol?: ts.Symbol;
  kind?: string;
  members?: Map<string, DynamicProvenance>;
  element?: DynamicProvenance;
  index?: DynamicProvenance;
  indexDomain?: DynamicIndexDomain;
  ownEnumerableMembers?: Set<string>;
  safeMemberOverrides?: Set<string>;
  unknown?: boolean;
  unknownMemberAccess?: boolean;
  completeMembers?: boolean;
  arrayLength?: number;
}

export interface DynamicAliasRecord {
  target: ts.Symbol;
  provenance: DynamicProvenance;
  conditional?: boolean;
}

export interface ModuleLoadSource {
  kind: 'trusted-builtin' | 'vm' | 'local-or-unknown';
  specifier?: string;
}

export function identifierSymbol(identifier: ts.Identifier, checker: ts.TypeChecker): ts.Symbol | undefined {
  return checker.getSymbolAtLocation(identifier);
}

export function isGlobalObjectIdentifier(node: ts.Expression, checker: ts.TypeChecker): boolean {
  const current = unwrapExecutionExpression(node);
  return ts.isIdentifier(current)
    && (current.text === 'globalThis' || current.text === 'window')
    && isGlobalIdentifier(current, checker, current.text);
}

export function isGlobalRequireCall(node: ts.Expression, checker: ts.TypeChecker): node is ts.CallExpression {
  const current = unwrapExecutionExpression(node);
  return ts.isCallExpression(current)
    && ts.isIdentifier(current.expression)
    && isGlobalIdentifier(current.expression, checker, 'require')
    && current.arguments.length === 1
    && ts.isStringLiteral(current.arguments[0])
    && (current.arguments[0].text === 'node:vm' || current.arguments[0].text === 'vm');
}

export const EXACT_SAFE_NODE_REQUIRE_SPECIFIERS = new Set(
  builtinModules
    .flatMap(specifier => [specifier, specifier.startsWith('node:') ? specifier : `node:${specifier}`])
    .filter(specifier => specifier !== 'vm' && specifier !== 'node:vm'),
);

export function functionExpressionConstructorKind(node: ts.Expression): string | undefined {
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

export function functionDeclarationConstructorKind(node: ts.FunctionDeclaration | ts.ClassDeclaration): string {
  if (ts.isClassDeclaration(node)) return 'Function';
  const isAsync = node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true;
  const isGenerator = Boolean(node.asteriskToken);
  if (isAsync && isGenerator) return 'AsyncGeneratorFunction';
  if (isGenerator) return 'GeneratorFunction';
  if (isAsync) return 'AsyncFunction';
  return 'Function';
}

export function functionPrototypeLookupKind(node: ts.Expression, checker: ts.TypeChecker): string | undefined {
  const current = unwrapExecutionExpression(node);
  if (!ts.isCallExpression(current)
    || current.arguments.length !== 1
    || !ts.isPropertyAccessExpression(current.expression)
    || current.expression.name.text !== 'getPrototypeOf') return undefined;
  const objectExpression = unwrapExecutionExpression(current.expression.expression);
  if (!ts.isIdentifier(objectExpression) || !isGlobalIdentifier(objectExpression, checker, 'Object')) return undefined;
  return functionExpressionConstructorKind(current.arguments[0]);
}

export function typeHasCallableSignature(expression: ts.Expression, checker: ts.TypeChecker): boolean {
  const type = checker.getTypeAtLocation(unwrapExecutionExpression(expression));
  return checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0
    || checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length > 0;
}

export function typeRequiresFailClosedCallableClassification(type: ts.Type, checker: ts.TypeChecker): boolean {
  if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0) return true;
  if (checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0
    || checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length > 0) return true;
  if (type.isUnionOrIntersection()) {
    return type.types.some(member => typeRequiresFailClosedCallableClassification(member, checker));
  }
  return false;
}

export function expressionSymbol(expression: ts.Expression, checker: ts.TypeChecker): ts.Symbol | undefined {
  const current = unwrapExecutionExpression(expression);
  const symbol = ts.isPropertyAccessExpression(current)
    ? checker.getSymbolAtLocation(current.name)
    : ts.isElementAccessExpression(current) && current.argumentExpression
      ? checker.getSymbolAtLocation(current.argumentExpression)
      : checker.getSymbolAtLocation(current);
  if (!symbol || (symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
  return checker.getAliasedSymbol(symbol);
}

export function javascriptPropertyKey(value: string | number): string {
  if (typeof value === 'number') return Object.is(value, -0) ? '0' : String(value);
  return value;
}

export function staticPropertyKeyExpression(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): string | undefined {
  const current = unwrapExecutionExpression(expression);
  if (ts.isStringLiteralLike(current) || ts.isNoSubstitutionTemplateLiteral(current)) return current.text;
  if (ts.isNumericLiteral(current)) return javascriptPropertyKey(Number(current.text));
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticPropertyKeyExpression(current.left, checker, new Set(seen));
    const right = staticPropertyKeyExpression(current.right, checker, new Set(seen));
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (ts.isTemplateExpression(current)) {
    let value = current.head.text;
    for (const span of current.templateSpans) {
      const part = staticPropertyKeyExpression(span.expression, checker, new Set(seen));
      if (part === undefined) return undefined;
      value += part + span.literal.text;
    }
    return value;
  }
  if (ts.isConditionalExpression(current)) {
    const whenTrue = staticPropertyKeyExpression(current.whenTrue, checker, new Set(seen));
    const whenFalse = staticPropertyKeyExpression(current.whenFalse, checker, new Set(seen));
    return whenTrue !== undefined && whenTrue === whenFalse ? whenTrue : undefined;
  }
  if (ts.isPrefixUnaryExpression(current)
    && (current.operator === ts.SyntaxKind.PlusToken || current.operator === ts.SyntaxKind.MinusToken)) {
    const operand = staticPropertyKeyExpression(current.operand, checker, seen);
    if (operand !== undefined) {
      const value = Number(operand) * (current.operator === ts.SyntaxKind.MinusToken ? -1 : 1);
      return javascriptPropertyKey(value);
    }
  }
  if (ts.isIdentifier(current)) {
    if (current.text === 'NaN' && isGlobalIdentifier(current, checker, 'NaN')) return 'NaN';
    if (current.text === 'Infinity' && isGlobalIdentifier(current, checker, 'Infinity')) return 'Infinity';
  }
  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    const constant = checker.getConstantValue(current);
    if (constant !== undefined) return javascriptPropertyKey(constant);
  }
  const symbol = expressionSymbol(current, checker);
  if (!symbol || seen.has(symbol)) return undefined;
  seen.add(symbol);
  for (const declaration of symbol.getDeclarations() ?? []) {
    if (ts.isVariableDeclaration(declaration) && declaration.initializer
      && ts.isVariableDeclarationList(declaration.parent)
      && (declaration.parent.flags & ts.NodeFlags.Const) !== 0) {
      return staticPropertyKeyExpression(declaration.initializer, checker, seen);
    }
    if (ts.isEnumMember(declaration) && declaration.initializer) {
      return staticPropertyKeyExpression(declaration.initializer, checker, seen);
    }
  }
  return undefined;
}

export function hasExactLocalNonCallableEvidence(expression: ts.Expression, checker: ts.TypeChecker): boolean {
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

export function constructorReceiverKind(
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

export function staticallyCallableKind(
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

export function boundExpressionProvenance(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  bindings: DynamicExecutionBindings,
  seen = new Set<ts.Node>(),
): DynamicProvenance | undefined {
  const current = unwrapExecutionExpression(expression);
  if (seen.has(current)) return undefined;
  seen.add(current);
  if (ts.isIdentifier(current)) {
    const symbol = identifierSymbol(current, checker);
    return symbol ? bindings.provenanceBySymbol.get(symbol) : undefined;
  }
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    return boundExpressionProvenance(current.right, checker, bindings, seen);
  }
  if (!ts.isPropertyAccessExpression(current) && !ts.isElementAccessExpression(current)) return undefined;
  const base = boundExpressionProvenance(current.expression, checker, bindings, seen);
  if (!base) return undefined;
  const key = ts.isPropertyAccessExpression(current)
    ? current.name.text
    : current.argumentExpression ? staticPropertyKeyExpression(current.argumentExpression, checker) : undefined;
  if (key === undefined) return base.index ?? (base.unknownMemberAccess ? { kind: 'unresolved-nested-member', unknown: true } : undefined);
  return base.members?.get(key)
    ?? base.index
    ?? (base.unknownMemberAccess ? { kind: `unresolved-nested-member.${key}`, unknown: true } : undefined);
}

export function dynamicReferenceKind(
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
      : current.argumentExpression ? staticPropertyKeyExpression(current.argumentExpression, checker) : undefined;
    if (member === undefined) {
      if (ts.isIdentifier(target)) {
        const targetSymbol = identifierSymbol(target, checker);
        const indexKind = targetSymbol ? bindings.indexKinds.get(targetSymbol) : undefined;
        if (indexKind) return indexKind;
        const targetKind = targetSymbol ? bindings.dangerousSymbols.get(targetSymbol) : undefined;
        if (targetKind?.startsWith('unresolved-')) return `${targetKind}.computed`;
      }
      return undefined;
    }
    const currentMemberSymbol = checker.getPropertyOfType(checker.getTypeAtLocation(target), member);
    if (currentMemberSymbol && bindings.exactSafeSymbols.has(currentMemberSymbol)) return undefined;
    const projected = boundExpressionProvenance(current, checker, bindings);
    if (projected) {
      if (projected.symbol && bindings.exactSafeSymbols.has(projected.symbol)) return undefined;
      const projectedKind = projected.kind
        ?? (projected.symbol ? bindings.dangerousSymbols.get(projected.symbol) : undefined)
        ?? (projected.expression && projected.expression !== current
          ? dynamicReferenceKind(projected.expression, checker, bindings)
          : undefined);
      if (projectedKind) return projectedKind;
      if (projected.unknown || projected.unknownMemberAccess) return `unresolved-nested-member.${member}`;
    }
    if (['call', 'apply', 'bind'].includes(member)) return dynamicReferenceKind(target, checker, bindings);
    if (ts.isIdentifier(target)) {
      const targetSymbol = identifierSymbol(target, checker);
      if (targetSymbol && bindings.safeMemberOverrides.get(targetSymbol)?.has(member)) return undefined;
      const memberKind = targetSymbol ? bindings.memberKinds.get(targetSymbol)?.get(member) : undefined;
      if (memberKind) return memberKind;
      if (targetSymbol
        && bindings.knownMembersComplete.has(targetSymbol)
        && bindings.knownMembers.get(targetSymbol)?.has(member)) return undefined;
      const indexKind = targetSymbol ? bindings.indexKinds.get(targetSymbol) : undefined;
      const indexDomain = targetSymbol ? bindings.indexDomains.get(targetSymbol) : undefined;
      if (indexKind && (indexDomain === 'string'
        || indexDomain === 'both'
        || indexDomain === 'all'
        || (indexDomain === 'number' && /^\d+$/.test(member)))) return `${indexKind}.${member}`;
      const targetKind = targetSymbol ? bindings.dangerousSymbols.get(targetSymbol) : undefined;
      if (targetKind?.startsWith('unresolved-')) return `${targetKind}.${member}`;
    }
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

export function vmNamespaceReference(
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

export function functionCallableReference(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  bindings: DynamicExecutionBindings,
): string | undefined {
  return staticallyCallableKind(expression, checker, bindings);
}

export const dynamicBindingBuildInputs = new WeakMap<ts.Program, WeakSet<ts.SourceFile>>();

export const dynamicBindingsCache = new WeakMap<ts.Program, WeakMap<ts.SourceFile, DynamicExecutionBindings>>();

export const exactSafeMutableWriteCache = new WeakMap<ts.Symbol, boolean>();

export function emptyDynamicExecutionBindings(): DynamicExecutionBindings {
  return {
    dangerousSymbols: new Map(),
    exactSafeSymbols: new Set(),
    vmNamespaceSymbols: new Set(),
    functionCallableSymbols: new Map(),
    memberKinds: new Map(),
    knownMembers: new Map(),
    knownMembersComplete: new Set(),
    safeMemberOverrides: new Map(),
    indexKinds: new Map(),
    indexDomains: new Map(),
    provenanceBySymbol: new Map(),
  };
}
