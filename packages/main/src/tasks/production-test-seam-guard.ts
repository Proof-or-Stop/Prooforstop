#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { CONFIG_FILENAMES } from '../core/brand-paths.js';

export const PRODUCTION_TEST_SEAM_REASON = 'production_test_seam_side_effect_flow' as const;

export interface ProductionTestSeamIssue {
  reason: typeof PRODUCTION_TEST_SEAM_REASON;
  file: string;
  line: number;
  column: number;
  envKeys: string[];
  sink: string;
}

type Sources = Set<string>;

const FS_SINK_ARGUMENTS: Readonly<Record<string, readonly number[]>> = {
  mkdir: [0],
  mkdirSync: [0],
  write: [0],
  writeFile: [0],
  writeFileSync: [0],
  rm: [0],
  rmSync: [0],
  rename: [0, 1],
  renameSync: [0, 1],
};

const PROCESS_SINK_ARGUMENTS: Readonly<Record<string, readonly number[]>> = {
  exec: [0, 1],
  execSync: [0, 1],
  execFile: [0, 1, 2],
  execFileSync: [0, 1, 2],
  spawn: [0, 1, 2],
  spawnSync: [0, 1, 2],
};

function union(...sets: Sources[]): Sources {
  return new Set(sets.flatMap(set => [...set]));
}

function isTestControlKey(key: string): boolean {
  return /(?:^|_)(?:SMOKE|TEST)(?:_|$)/i.test(key) || /(?:SMOKE|TEST)/i.test(key);
}

function propertyName(expression: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression
    && (ts.isStringLiteralLike(expression.argumentExpression) || ts.isNumericLiteral(expression.argumentExpression))) {
    return expression.argumentExpression.text;
  }
  return undefined;
}

function staticPropertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) return name.expression.text;
  return undefined;
}

function isProcessEnv(expression: ts.Expression, processObjects: ReadonlySet<string>): boolean {
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) return false;
  const base = expression.expression;
  return ts.isIdentifier(base) && processObjects.has(base.text) && propertyName(expression) === 'env';
}

function collectSanitizerFunctions(sourceFile: ts.SourceFile): Map<string, readonly number[]> {
  // Value = parameter indexes whose values may survive sanitization (for the
  // positive-integer fallback branch). Enum sanitizers expose no input value.
  const sanitizers = new Map<string, readonly number[]>();
  const unwrap = (expression: ts.Expression): ts.Expression => {
    let current = expression;
    while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)
      || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current)) current = current.expression;
    return current;
  };
  const isLiteral = (expression: ts.Expression): boolean => {
    const value = unwrap(expression);
    return ts.isStringLiteralLike(value) || ts.isNumericLiteral(value)
      || value.kind === ts.SyntaxKind.FalseKeyword || value.kind === ts.SyntaxKind.TrueKeyword;
  };
  const inspect = (name: string | undefined, parameters: ts.NodeArray<ts.ParameterDeclaration>, body: ts.ConciseBody | undefined): void => {
    if (!name || !body) return;
    const returns: ts.Expression[] = [];
    const visitReturn = (node: ts.Node): void => {
      if (ts.isReturnStatement(node) && node.expression) returns.push(node.expression);
      ts.forEachChild(node, visitReturn);
    };
    if (ts.isBlock(body)) visitReturn(body);
    else returns.push(body);

    const parameterNames = new Set(parameters.flatMap(parameter => ts.isIdentifier(parameter.name) ? [parameter.name.text] : []));
    const parsedNames = new Set<string>();
    const collectParsed = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
        && ts.isCallExpression(node.initializer) && propertyName(node.initializer.expression) === undefined
        && ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === 'Number'
        && node.initializer.arguments[0] && ts.isIdentifier(node.initializer.arguments[0])
        && parameterNames.has(node.initializer.arguments[0].text)) parsedNames.add(node.name.text);
      ts.forEachChild(node, collectParsed);
    };
    collectParsed(body);
    const conjunctionTerms = (expression: ts.Expression): ts.Expression[] => {
      const value = unwrap(expression);
      if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        return [...conjunctionTerms(value.left), ...conjunctionTerms(value.right)];
      }
      return [value];
    };
    const fallbackIndexes = new Set<number>();
    const positiveInt = returns.length > 0 && parsedNames.size > 0 && returns.every(expression => {
      const value = unwrap(expression);
      if (!ts.isConditionalExpression(value)) return false;
      const trueValue = unwrap(value.whenTrue);
      const falseValue = unwrap(value.whenFalse);
      const terms = conjunctionTerms(value.condition);
      const parsed = [...parsedNames].find(candidate => {
        const finiteRequired = terms.some(term => ts.isCallExpression(term)
          && propertyName(term.expression) === 'isFinite'
          && ts.isPropertyAccessExpression(term.expression)
          && ts.isIdentifier(term.expression.expression) && term.expression.expression.text === 'Number'
          && term.arguments.length === 1
          && ts.isIdentifier(term.arguments[0]) && term.arguments[0].text === candidate);
        const positiveRequired = terms.some(term => ts.isBinaryExpression(term)
          && ((term.operatorToken.kind === ts.SyntaxKind.GreaterThanToken
            && ts.isIdentifier(term.left) && term.left.text === candidate
            && ts.isNumericLiteral(term.right) && Number(term.right.text) === 0)
          || (term.operatorToken.kind === ts.SyntaxKind.LessThanToken
            && ts.isNumericLiteral(term.left) && Number(term.left.text) === 0
            && ts.isIdentifier(term.right) && term.right.text === candidate)));
        return finiteRequired && positiveRequired;
      });
      const fallbackIndex = ts.isIdentifier(falseValue)
        ? parameters.findIndex(parameter => ts.isIdentifier(parameter.name) && parameter.name.text === falseValue.text)
        : -1;
      if (fallbackIndex >= 0) fallbackIndexes.add(fallbackIndex);
      return Boolean(parsed)
        && ts.isCallExpression(trueValue)
        && propertyName(trueValue.expression) === 'floor'
        && trueValue.expression.getText(sourceFile).startsWith('Math.')
        && ts.isIdentifier(trueValue.arguments[0]) && trueValue.arguments[0].text === parsed
        && (isLiteral(falseValue) || fallbackIndex > 0);
    });
    const finiteEnum = returns.length >= 2 && returns.every(isLiteral);
    if (positiveInt) sanitizers.set(name, [...fallbackIndexes]);
    else if (finiteEnum) sanitizers.set(name, []);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node)) inspect(node.name?.text, node.parameters, node.body);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      inspect(node.name.text, node.initializer.parameters, node.initializer.body);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sanitizers;
}

interface CallableCandidate {
  node: ts.FunctionLikeDeclaration;
  parameters: readonly ts.ParameterDeclaration[];
  returns: readonly ts.Expression[];
}

interface CallableIndex {
  byName: Map<string, CallableCandidate[]>;
  byQualifiedName: Map<string, CallableCandidate[]>;
  constructors: Map<string, CallableCandidate[]>;
  aliases: Map<string, { initializer: ts.Expression; immutable: boolean }>;
  mutatedBases: Set<string>;
  mutatedQualifiedNames: Set<string>;
  dynamicMutationBases: Set<string>;
  mutatedMethodNames: Set<string>;
  allMethodNamesMutated: boolean;
}

function callableReturns(body: ts.ConciseBody | undefined): ts.Expression[] {
  if (!body) return [];
  if (!ts.isBlock(body)) return [body];
  const values: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) values.push(node.expression);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return values;
}

function callableCandidate(node: ts.FunctionLikeDeclaration): CallableCandidate {
  const body = 'body' in node ? node.body as ts.ConciseBody | undefined : undefined;
  return { node, parameters: [...node.parameters], returns: callableReturns(body) };
}

function collectCallableIndex(sourceFile: ts.SourceFile): CallableIndex {
  const byName = new Map<string, CallableCandidate[]>();
  const byQualifiedName = new Map<string, CallableCandidate[]>();
  const constructors = new Map<string, CallableCandidate[]>();
  const aliases = new Map<string, { initializer: ts.Expression; immutable: boolean }>();
  const mutatedBases = new Set<string>();
  const mutatedQualifiedNames = new Set<string>();
  const dynamicMutationBases = new Set<string>();
  const mutatedMethodNames = new Set<string>();
  let allMethodNamesMutated = false;
  const aliasEdges = new Map<string, Set<string>>();
  const rawPropertyMutations: Array<{ base: string; property?: string; invalidatesMethods: boolean }> = [];
  const arrayMutators = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'copyWithin', 'fill']);
  const constObjectInitializers = new Map<string, ts.Expression>();
  const collectConstObjects = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && ts.isVariableDeclarationList(node.parent)
      && (node.parent.flags & ts.NodeFlags.Const) !== 0) {
      constObjectInitializers.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collectConstObjects);
  };
  collectConstObjects(sourceFile);
  const staticEnumerableKeys = (expression: ts.Expression, seen = new Set<string>()): { keys: Set<string>; unknown: boolean } => {
    let value = expression;
    while (ts.isParenthesizedExpression(value) || ts.isAsExpression(value)
      || ts.isTypeAssertionExpression(value) || ts.isNonNullExpression(value)) value = value.expression;
    if (ts.isIdentifier(value)) {
      if (seen.has(value.text)) return { keys: new Set(), unknown: true };
      const initializer = constObjectInitializers.get(value.text);
      if (!initializer) return { keys: new Set(), unknown: true };
      const nextSeen = new Set(seen);
      nextSeen.add(value.text);
      return staticEnumerableKeys(initializer, nextSeen);
    }
    if (!ts.isObjectLiteralExpression(value)) return { keys: new Set(), unknown: true };
    const keys = new Set<string>();
    let unknown = false;
    for (const property of value.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spread = staticEnumerableKeys(property.expression, seen);
        for (const key of spread.keys) keys.add(key);
        unknown ||= spread.unknown;
        continue;
      }
      const key = 'name' in property && property.name ? staticPropertyName(property.name) : undefined;
      if (key) keys.add(key);
      else unknown = true;
    }
    return { keys, unknown };
  };
  const rootIdentifier = (expression: ts.Expression): string | undefined => {
    let value = expression;
    while (ts.isParenthesizedExpression(value) || ts.isAsExpression(value)
      || ts.isTypeAssertionExpression(value) || ts.isNonNullExpression(value)) value = value.expression;
    while (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) value = value.expression;
    return ts.isIdentifier(value) ? value.text : undefined;
  };
  const assignedIdentifier = (expression: ts.Expression): string | undefined => {
    let value = expression;
    while (ts.isParenthesizedExpression(value) || ts.isAsExpression(value)
      || ts.isTypeAssertionExpression(value) || ts.isNonNullExpression(value)) value = value.expression;
    if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return assignedIdentifier(value.right);
    }
    return ts.isIdentifier(value) ? value.text : undefined;
  };
  const connectAliases = (leftName: string, rightName: string): void => {
    const left = aliasEdges.get(leftName) ?? new Set<string>();
    const right = aliasEdges.get(rightName) ?? new Set<string>();
    left.add(rightName);
    right.add(leftName);
    aliasEdges.set(leftName, left);
    aliasEdges.set(rightName, right);
  };
  const recordPropertyMutation = (expression: ts.Expression): void => {
    if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) return;
    const base = rootIdentifier(expression);
    if (!base) return;
    const property = propertyName(expression);
    rawPropertyMutations.push({ base, ...(property ? { property } : {}), invalidatesMethods: true });
  };
  const collectMutations = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isIdentifier(node.initializer)) {
      connectAliases(node.name.text, node.initializer.text);
    }
    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      if (ts.isIdentifier(node.left)) {
        const alias = node.operatorToken.kind === ts.SyntaxKind.EqualsToken ? assignedIdentifier(node.right) : undefined;
        if (alias) connectAliases(node.left.text, alias);
        mutatedBases.add(node.left.text);
      }
      else recordPropertyMutation(node.left);
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
      if (ts.isIdentifier(node.operand)) mutatedBases.add(node.operand.text);
      else recordPropertyMutation(node.operand);
    }
    if (ts.isDeleteExpression(node)) recordPropertyMutation(node.expression);
    if (ts.isCallExpression(node) && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))) {
      const method = propertyName(node.expression);
      const receiver = node.expression.expression;
      if (ts.isIdentifier(receiver) && receiver.text === 'Object'
        && (method === 'assign' || method === 'defineProperty' || method === 'defineProperties')) {
        const target = node.arguments[0];
        const base = target ? rootIdentifier(target) : undefined;
        if (base) {
          if (method === 'defineProperty') {
            const key = node.arguments[1] && ts.isStringLiteralLike(node.arguments[1]) ? node.arguments[1].text : undefined;
            rawPropertyMutations.push({ base, ...(key ? { property: key } : {}), invalidatesMethods: true });
          } else if (method === 'assign') {
            let unknown = false;
            const names = new Set<string>();
            for (const source of node.arguments.slice(1)) {
              if (ts.isSpreadElement(source)) {
                unknown = true;
                continue;
              }
              const collected = staticEnumerableKeys(source);
              for (const name of collected.keys) names.add(name);
              unknown ||= collected.unknown;
            }
            for (const property of names) rawPropertyMutations.push({ base, property, invalidatesMethods: true });
            if (unknown) rawPropertyMutations.push({ base, invalidatesMethods: true });
          } else {
            const descriptor = node.arguments[1];
            const names = descriptor && ts.isObjectLiteralExpression(descriptor)
              ? descriptor.properties
                .map(property => 'name' in property && property.name ? staticPropertyName(property.name) : undefined)
                .filter((name): name is string => Boolean(name))
              : [];
            if (names.length > 0) {
              for (const property of names) rawPropertyMutations.push({ base, property, invalidatesMethods: true });
            } else rawPropertyMutations.push({ base, invalidatesMethods: true });
          }
        }
      } else if (method && arrayMutators.has(method)) {
        const base = rootIdentifier(receiver);
        if (base) rawPropertyMutations.push({ base, invalidatesMethods: false });
      }
    }
    ts.forEachChild(node, collectMutations);
  };
  collectMutations(sourceFile);
  const aliasesOf = (name: string): Set<string> => {
    const found = new Set<string>([name]);
    const queue = [name];
    while (queue.length > 0) {
      for (const alias of aliasEdges.get(queue.shift()!) ?? []) {
        if (!found.has(alias)) { found.add(alias); queue.push(alias); }
      }
    }
    return found;
  };
  for (const mutation of rawPropertyMutations) {
    if (mutation.invalidatesMethods) {
      if (mutation.property) mutatedMethodNames.add(mutation.property);
      else allMethodNamesMutated = true;
    }
    for (const alias of aliasesOf(mutation.base)) {
      mutatedBases.add(alias);
      if (mutation.property) mutatedQualifiedNames.add(`${alias}.${mutation.property}`);
      else dynamicMutationBases.add(alias);
    }
  }
  const seen = new Set<ts.Node>();
  const append = (map: Map<string, CallableCandidate[]>, key: string | undefined, candidate: CallableCandidate): void => {
    if (!key) return;
    const values = map.get(key) ?? [];
    if (!values.some(value => value.node === candidate.node)) values.push(candidate);
    map.set(key, values);
  };
  const objectReceiver = (node: ts.Node): string | undefined => {
    const object = ts.isMethodDeclaration(node)
      ? node.parent
      : ts.isPropertyAssignment(node) ? node.parent : undefined;
    if (!object || !ts.isObjectLiteralExpression(object)) return undefined;
    const declaration = object.parent;
    return ts.isVariableDeclaration(declaration) && declaration.initializer === object && ts.isIdentifier(declaration.name)
      ? declaration.name.text
      : undefined;
  };
  const className = (node: ts.Node): string | undefined => {
    const parent = node.parent;
    if (!ts.isClassDeclaration(parent) && !ts.isClassExpression(parent)) return undefined;
    const declaration = parent.parent;
    if (ts.isVariableDeclaration(declaration) && declaration.initializer === parent && ts.isIdentifier(declaration.name)) {
      return declaration.name.text;
    }
    return parent.name?.text;
  };
  const recordCallable = (node: ts.FunctionLikeDeclaration, name?: string, receiver?: string): CallableCandidate => {
    const candidate = callableCandidate(node);
    if (!seen.has(node)) seen.add(node);
    append(byName, name, candidate);
    append(byQualifiedName, receiver && name ? `${receiver}.${name}` : undefined, candidate);
    return candidate;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node)) recordCallable(node, node.name?.text);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
        recordCallable(node.initializer, node.name.text);
      } else if (!ts.isClassExpression(node.initializer)) {
        const declarationList = node.parent;
        const isConst = ts.isVariableDeclarationList(declarationList)
          && (declarationList.flags & ts.NodeFlags.Const) !== 0;
        aliases.set(node.name.text, {
          initializer: node.initializer,
          immutable: isConst && !mutatedBases.has(node.name.text),
        });
      }
    }
    if (ts.isMethodDeclaration(node)) {
      const name = staticPropertyName(node.name);
      recordCallable(node, name, objectReceiver(node) ?? className(node));
    }
    if (ts.isPropertyAssignment(node) && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      const name = staticPropertyName(node.name);
      recordCallable(node.initializer, name, objectReceiver(node));
    }
    if (ts.isConstructorDeclaration(node)) {
      append(constructors, className(node), callableCandidate(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return {
    byName,
    byQualifiedName,
    constructors,
    aliases,
    mutatedBases,
    mutatedQualifiedNames,
    dynamicMutationBases,
    mutatedMethodNames,
    allMethodNamesMutated,
  };
}

function collectSinkAliases(sourceFile: ts.SourceFile): Map<string, string> {
  const aliases = new Map<string, string>();
  const isSink = (name: string): boolean => Object.hasOwn(FS_SINK_ARGUMENTS, name) || Object.hasOwn(PROCESS_SINK_ARGUMENTS, name);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      for (const element of node.importClause.namedBindings.elements) {
        const canonical = element.propertyName?.text ?? element.name.text;
        if (isSink(canonical)) aliases.set(element.name.text, canonical);
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const canonical = propertyName(node.initializer) ?? (ts.isIdentifier(node.initializer) ? node.initializer.text : undefined);
      if (canonical && isSink(canonical)) aliases.set(node.name.text, canonical);
      else if (canonical && aliases.has(canonical)) aliases.set(node.name.text, aliases.get(canonical)!);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return aliases;
}

export function analyzeProductionTestSeams(sourceText: string, file = 'inline.ts'): ProductionTestSeamIssue[] {
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const taint = new Map<string, Sources>();
  const envObjects = new Set<string>();
  const processObjects = new Set<string>(['process']);
  const activeReturnCandidates = new Set<ts.Node>();
  const sanitizers = collectSanitizerFunctions(sourceFile);
  const callables = collectCallableIndex(sourceFile);
  const inlineCandidates = new WeakMap<ts.FunctionLikeDeclaration, CallableCandidate>();
  const sinkAliases = collectSinkAliases(sourceFile);

  const candidateFor = (node: ts.FunctionLikeDeclaration): CallableCandidate => {
    const existing = inlineCandidates.get(node);
    if (existing) return existing;
    const candidate = callableCandidate(node);
    inlineCandidates.set(node, candidate);
    return candidate;
  };
  const unwrapCallable = (expression: ts.Expression): ts.Expression => {
    let current = expression;
    while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)
      || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current)) current = current.expression;
    return current;
  };
  const unionCandidates = (...groups: readonly CallableCandidate[][]): CallableCandidate[] => {
    const seen = new Set<ts.Node>();
    return groups.flat().filter(candidate => {
      if (seen.has(candidate.node)) return false;
      seen.add(candidate.node);
      return true;
    });
  };
  const receiverName = (expression: ts.Expression, seen = new Set<string>()): string | undefined => {
    const value = unwrapCallable(expression);
    if (!ts.isIdentifier(value)) return undefined;
    if (callables.mutatedBases.has(value.text)) return undefined;
    if (seen.has(value.text)) return value.text;
    seen.add(value.text);
    const alias = callables.aliases.get(value.text);
    if (alias && !alias.immutable) return undefined;
    return alias && ts.isIdentifier(unwrapCallable(alias.initializer))
      ? receiverName(alias.initializer, seen) ?? value.text
      : value.text;
  };
  const allCallableCandidates = (): CallableCandidate[] => unionCandidates(...[...callables.byName.values()]);
  const allConstructorCandidates = (): CallableCandidate[] => unionCandidates(...[...callables.constructors.values()]);
  const resolveCallableCandidates = (expression: ts.Expression, seen = new Set<string>()): CallableCandidate[] => {
    const value = unwrapCallable(expression);
    if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return [candidateFor(value)];
    if (ts.isIdentifier(value)) {
      if (callables.mutatedBases.has(value.text)) return allCallableCandidates();
      if (seen.has(value.text)) return callables.byName.get(value.text) ?? [];
      seen.add(value.text);
      const alias = callables.aliases.get(value.text);
      if (alias && !alias.immutable) return unionCandidates(callables.byName.get(value.text) ?? [], allCallableCandidates());
      return unionCandidates(
        callables.byName.get(value.text) ?? [],
        alias ? resolveCallableCandidates(alias.initializer, seen) : [],
      );
    }
    if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
      const name = propertyName(value);
      if (!name) return [];
      const receiver = receiverName(value.expression);
      const qualified = receiver ? `${receiver}.${name}` : undefined;
      const exact = qualified && !callables.mutatedQualifiedNames.has(qualified)
        && !callables.dynamicMutationBases.has(receiver!)
        && !callables.mutatedMethodNames.has(name)
        && !callables.allMethodNamesMutated
        ? callables.byQualifiedName.get(qualified) ?? []
        : [];
      return exact.length > 0 ? exact : callables.byName.get(name) ?? [];
    }
    return [];
  };
  const resolveConstructorCandidates = (expression: ts.Expression, seen = new Set<string>()): CallableCandidate[] => {
    const value = unwrapCallable(expression);
    if (ts.isIdentifier(value)) {
      if (callables.mutatedBases.has(value.text)) return allConstructorCandidates();
      if (seen.has(value.text)) return callables.constructors.get(value.text) ?? [];
      seen.add(value.text);
      const direct = callables.constructors.get(value.text) ?? [];
      const alias = callables.aliases.get(value.text);
      if (alias && !alias.immutable) return unionCandidates(direct, allConstructorCandidates());
      return unionCandidates(direct, alias ? resolveConstructorCandidates(alias.initializer, seen) : []);
    }
    if (ts.isClassExpression(value)) {
      return value.members.filter(ts.isConstructorDeclaration).map(candidateFor);
    }
    return [];
  };
  type ArgumentExpansion = { args: Array<ts.Expression | undefined>; unknownOperands: ts.Expression[] };
  const resolveArrayElements = (expression: ts.Expression, seen = new Set<string>()): Array<ts.Expression | undefined> | null => {
    const value = unwrapCallable(expression);
    if (ts.isArrayLiteralExpression(value)) {
      const values: Array<ts.Expression | undefined> = [];
      for (const element of value.elements) {
        if (ts.isOmittedExpression(element)) values.push(undefined);
        else if (ts.isSpreadElement(element)) {
          const nested = resolveArrayElements(element.expression, seen);
          if (!nested) return null;
          values.push(...nested);
        } else values.push(element);
      }
      return values;
    }
    if (ts.isIdentifier(value)) {
      if (seen.has(value.text)) return null;
      seen.add(value.text);
      const alias = callables.aliases.get(value.text);
      return alias?.immutable ? resolveArrayElements(alias.initializer, seen) : null;
    }
    return null;
  };
  const expandArguments = (values: readonly ts.Expression[]): ArgumentExpansion => {
    const args: Array<ts.Expression | undefined> = [];
    const unknownOperands: ts.Expression[] = [];
    for (const value of values) {
      if (!ts.isSpreadElement(value)) args.push(value);
      else {
        const expanded = resolveArrayElements(value.expression);
        if (expanded) args.push(...expanded);
        else unknownOperands.push(value.expression);
      }
    }
    return { args, unknownOperands };
  };
  const invocation = (node: ts.CallExpression): { candidates: CallableCandidate[] } & ArgumentExpansion => {
    const expression = unwrapCallable(node.expression);
    if ((ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) && propertyName(expression) === 'call') {
      return { candidates: resolveCallableCandidates(expression.expression), ...expandArguments(node.arguments.slice(1)) };
    }
    if ((ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) && propertyName(expression) === 'apply') {
      const applied = node.arguments[1];
      const expanded = applied ? resolveArrayElements(applied) : [];
      return {
        candidates: resolveCallableCandidates(expression.expression),
        args: expanded ?? [],
        unknownOperands: applied && !expanded ? [applied] : [],
      };
    }
    return { candidates: resolveCallableCandidates(expression), ...expandArguments(node.arguments) };
  };

  const add = (name: string, sources: Sources): boolean => {
    if (sources.size === 0) return false;
    const existing = taint.get(name) ?? new Set<string>();
    const before = existing.size;
    for (const source of sources) existing.add(source);
    taint.set(name, existing);
    return existing.size !== before;
  };

  const expressionKey = (expression: ts.Expression): string | undefined => {
    if (ts.isIdentifier(expression)) return expression.text;
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const base = expressionKey(expression.expression);
      const property = propertyName(expression);
      return base && property ? `${base}.${property}` : undefined;
    }
    return undefined;
  };

  const sourceFromEnvironment = (expression: ts.Expression): Sources => {
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const key = propertyName(expression);
      const base = expression.expression;
      const envBase = isProcessEnv(base, processObjects) || (ts.isIdentifier(base) && envObjects.has(base.text));
      if (envBase && key && isTestControlKey(key)) return new Set([key]);
    }
    return new Set();
  };

  const sourcePayload = (expression: ts.Expression): ts.Expression => {
    let value = expression;
    while (ts.isSpreadElement(value) || ts.isParenthesizedExpression(value) || ts.isAsExpression(value)
      || ts.isTypeAssertionExpression(value) || ts.isNonNullExpression(value) || ts.isAwaitExpression(value)) {
      value = value.expression;
    }
    return value;
  };

  const expressionSources = (expression: ts.Expression | undefined): Sources => {
    if (!expression) return new Set();
    const payload = sourcePayload(expression);
    if (payload !== expression) return expressionSources(payload);
    const direct = sourceFromEnvironment(expression);
    if (direct.size > 0) return direct;
    if (ts.isIdentifier(expression)) {
      const prefix = `${expression.text}.`;
      return union(
        new Set(taint.get(expression.text) ?? []),
        ...[...taint.entries()].filter(([key]) => key.startsWith(prefix)).map(([, sources]) => sources),
      );
    }
    if (ts.isConditionalExpression(expression)) {
      // Tainted control choosing only fixed, untainted constants is a finite
      // enum selection; the condition itself does not become a sink target.
      return union(expressionSources(expression.whenTrue), expressionSources(expression.whenFalse));
    }
    if (ts.isCallExpression(expression)) {
      const callee = ts.isIdentifier(expression.expression) ? expression.expression.text : undefined;
      if (callee && sanitizers.has(callee)) {
        return union(...(sanitizers.get(callee) ?? []).map(index => expressionSources(expression.arguments[index])));
      }
      const resolved = invocation(expression);
      const returnSources: Sources[] = [];
      for (const candidate of resolved.candidates) {
        if (activeReturnCandidates.has(candidate.node)) continue;
        activeReturnCandidates.add(candidate.node);
        try {
          returnSources.push(...candidate.returns.map(value => expressionSources(value)));
        } finally {
          activeReturnCandidates.delete(candidate.node);
        }
      }
      return union(
        ...resolved.args.map(argument => expressionSources(argument)),
        ...resolved.unknownOperands.map(argument => expressionSources(argument)),
        ...returnSources,
      );
    }
    if (ts.isNewExpression(expression)) {
      const candidates = resolveConstructorCandidates(expression.expression);
      const expanded = expandArguments(expression.arguments ?? []);
      return union(
        ...expanded.args.map(argument => expressionSources(argument)),
        ...expanded.unknownOperands.map(argument => expressionSources(argument)),
        ...candidates.flatMap(candidate => candidate.returns.map(value => expressionSources(value))),
      );
    }
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      return union(
        new Set(taint.get(expressionKey(expression) ?? '') ?? []),
        expressionSources(expression.expression),
        ts.isElementAccessExpression(expression) ? expressionSources(expression.argumentExpression) : new Set(),
      );
    }
    if (ts.isBinaryExpression(expression)) return union(expressionSources(expression.left), expressionSources(expression.right));
    if (ts.isTemplateExpression(expression)) return union(...expression.templateSpans.map(span => expressionSources(span.expression)));
    if (ts.isArrayLiteralExpression(expression)) return union(...expression.elements.map(element => expressionSources(element as ts.Expression)));
    if (ts.isObjectLiteralExpression(expression)) {
      return union(...expression.properties.map(property => {
        if (ts.isPropertyAssignment(property)) return expressionSources(property.initializer);
        if (ts.isShorthandPropertyAssignment(property)) return expressionSources(property.name);
        if (ts.isSpreadAssignment(property)) return expressionSources(property.expression);
        return new Set<string>();
      }));
    }
    return new Set();
  };

  type BindingSource = { kind: 'process' | 'env' | 'value'; sources: Sources };
  const valueSource = (sources: Sources = new Set()): BindingSource => ({ kind: 'value', sources });
  const classifyBindingSource = (expression: ts.Expression | undefined): BindingSource => {
    if (!expression) return valueSource();
    let value = expression;
    while (ts.isParenthesizedExpression(value) || ts.isAsExpression(value)
      || ts.isTypeAssertionExpression(value) || ts.isNonNullExpression(value)) value = value.expression;
    if (ts.isIdentifier(value) && processObjects.has(value.text)) return { kind: 'process', sources: new Set() };
    if (isProcessEnv(value, processObjects) || (ts.isIdentifier(value) && envObjects.has(value.text))) {
      return { kind: 'env', sources: new Set() };
    }
    return valueSource(expressionSources(value));
  };
  const mergeBindingSources = (left: BindingSource, right: BindingSource): BindingSource => {
    if (left.kind === 'process' || right.kind === 'process') return { kind: 'process', sources: union(left.sources, right.sources) };
    if (left.kind === 'env' || right.kind === 'env') return { kind: 'env', sources: union(left.sources, right.sources) };
    return valueSource(union(left.sources, right.sources));
  };
  const propertyBindingSource = (source: BindingSource, key: string | undefined): BindingSource => {
    if (!key) return source; // Dynamic/rest patterns conservatively retain the whole source.
    if (source.kind === 'process') return key === 'env' ? { kind: 'env', sources: new Set() } : valueSource();
    if (source.kind === 'env') return isTestControlKey(key) ? valueSource(new Set([key])) : valueSource();
    return source;
  };

  const bindTarget = (target: ts.BindingName | ts.Expression, source: BindingSource): boolean => {
    if (ts.isIdentifier(target)) {
      let changed = false;
      if (source.kind === 'process') {
        const before = processObjects.size;
        processObjects.add(target.text);
        changed ||= processObjects.size !== before;
      } else if (source.kind === 'env') {
        const before = envObjects.size;
        envObjects.add(target.text);
        changed ||= envObjects.size !== before;
      }
      changed ||= add(target.text, source.sources);
      return changed;
    }
    if (ts.isObjectBindingPattern(target)) {
      let changed = false;
      for (const element of target.elements) {
        const key = element.dotDotDotToken ? undefined : element.propertyName ? staticPropertyName(element.propertyName) : ts.isIdentifier(element.name) ? element.name.text : undefined;
        let child = propertyBindingSource(source, key);
        if (element.initializer) child = mergeBindingSources(child, classifyBindingSource(element.initializer));
        changed ||= bindTarget(element.name, child);
      }
      return changed;
    }
    if (ts.isArrayBindingPattern(target)) {
      let changed = false;
      for (const element of target.elements) {
        if (ts.isOmittedExpression(element)) continue;
        let child = source;
        if (element.initializer) child = mergeBindingSources(child, classifyBindingSource(element.initializer));
        changed ||= bindTarget(element.name, child);
      }
      return changed;
    }
    if (ts.isParenthesizedExpression(target)) return bindTarget(target.expression, source);
    if (ts.isObjectLiteralExpression(target)) {
      let changed = false;
      for (const property of target.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          let child = propertyBindingSource(source, staticPropertyName(property.name));
          if (property.objectAssignmentInitializer) child = mergeBindingSources(child, classifyBindingSource(property.objectAssignmentInitializer));
          changed ||= bindTarget(property.name, child);
        } else if (ts.isPropertyAssignment(property)) {
          changed ||= bindTarget(property.initializer, propertyBindingSource(source, staticPropertyName(property.name)));
        } else if (ts.isSpreadAssignment(property)) {
          changed ||= bindTarget(property.expression, source);
        }
      }
      return changed;
    }
    if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return bindTarget(target.left, mergeBindingSources(source, classifyBindingSource(target.right)));
    }
    if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
      const key = expressionKey(target);
      return key ? add(key, source.sources) : false;
    }
    return false;
  };

  // Bounded fixed point: simple aliases plus local argument forwarding.
  for (let pass = 0; pass < 8; pass += 1) {
    let changed = false;
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        changed ||= bindTarget(node.name, classifyBindingSource(node.initializer));
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        changed ||= bindTarget(node.left, classifyBindingSource(node.right));
      }
      if (ts.isCallExpression(node)) {
        const resolved = invocation(node);
        for (const candidate of resolved.candidates) {
          candidate.parameters.forEach((parameter, index) => {
            let source = classifyBindingSource(resolved.args[index]);
            for (const operand of resolved.unknownOperands) {
              source = mergeBindingSources(source, classifyBindingSource(operand));
            }
            if (parameter.initializer) source = mergeBindingSources(source, classifyBindingSource(parameter.initializer));
            changed ||= bindTarget(parameter.name, source);
          });
        }
        const expression = unwrapCallable(node.expression);
        if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
          const method = propertyName(expression);
          const receiverKey = expressionKey(expression.expression)?.split('.')[0];
          if (receiverKey && method && ['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'copyWithin', 'fill'].includes(method)) {
            changed ||= add(receiverKey, union(...node.arguments.map(argument => expressionSources(argument))));
          }
          if (ts.isIdentifier(expression.expression) && expression.expression.text === 'Object'
            && (method === 'assign' || method === 'defineProperty' || method === 'defineProperties')) {
            const targetKey = node.arguments[0] ? expressionKey(node.arguments[0])?.split('.')[0] : undefined;
            if (targetKey) changed ||= add(targetKey, union(...node.arguments.slice(1).map(argument => expressionSources(argument))));
          }
        }
      }
      if (ts.isNewExpression(node)) {
        const expanded = expandArguments(node.arguments ?? []);
        for (const candidate of resolveConstructorCandidates(node.expression)) {
          candidate.parameters.forEach((parameter, index) => {
            let source = classifyBindingSource(expanded.args[index]);
            for (const operand of expanded.unknownOperands) {
              source = mergeBindingSources(source, classifyBindingSource(operand));
            }
            if (parameter.initializer) source = mergeBindingSources(source, classifyBindingSource(parameter.initializer));
            changed ||= bindTarget(parameter.name, source);
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (!changed) break;
  }

  const issues: ProductionTestSeamIssue[] = [];
  const seen = new Set<string>();
  const visitSink = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const rawSink = propertyName(node.expression) ?? (ts.isIdentifier(node.expression) ? node.expression.text : undefined);
      const sink = rawSink ? (sinkAliases.get(rawSink) ?? rawSink) : undefined;
      const indexes = sink && Object.hasOwn(FS_SINK_ARGUMENTS, sink)
        ? FS_SINK_ARGUMENTS[sink]
        : sink && Object.hasOwn(PROCESS_SINK_ARGUMENTS, sink)
          ? PROCESS_SINK_ARGUMENTS[sink]
          : undefined;
      if (sink && indexes) {
        for (const index of indexes) {
          const argument = node.arguments[index];
          if (!argument) continue;
          const sources = expressionSources(argument);
          if (sources.size === 0) continue;
          const position = sourceFile.getLineAndCharacterOfPosition(argument.getStart(sourceFile));
          const key = `${file}:${position.line}:${position.character}:${sink}:${[...sources].sort().join(',')}`;
          if (seen.has(key)) continue;
          seen.add(key);
          issues.push({
            reason: PRODUCTION_TEST_SEAM_REASON,
            file,
            line: position.line + 1,
            column: position.character + 1,
            envKeys: [...sources].sort(),
            sink,
          });
        }
      }
    }
    ts.forEachChild(node, visitSink);
  };
  visitSink(sourceFile);
  return issues;
}

function listTypeScriptFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(path);
    }
  };
  walk(root);
  return files.sort();
}

function selfTest(): void {
  const filesystemCases: Array<[string, string]> = [
    ['mkdirSync', `mkdirSync(process.env.TEST_TARGET)`],
    ['writeFileSync', `const readyFile = process.env.PROOF_OR_STOP_SMOKE_READY; const alias = readyFile; writeFileSync(alias, 'x')`],
    ['rmSync', `const { TEST_REMOVE: target } = process.env; rmSync(target)`],
    ['renameSync', `const from = process.env.SMOKE_FROM; const to = process.env.SMOKE_TO; renameSync(from, to)`],
    ['writeFile forwarded', `function persist(target: string) { writeFile(target, 'x', () => {}) } const selected = process.env.TEST_FILE; persist(selected)`],
    ['aliased write sink', `import { writeFileSync as persist } from 'node:fs'; const selected = process.env.TEST_FILE; persist(selected, 'x')`],
    ['destructured process env', `const { env } = process; const selected = env.TEST_FILE; writeFileSync(selected, 'x')`],
    ['nested destructured process env', `const { env: { TEST_FILE: selected } } = process; writeFileSync(selected, 'x')`],
  ];
  const processCases: Array<[string, string]> = [
    ['exec command', `exec(process.env.TEST_COMMAND)`],
    ['execFile argv', `const argv = [process.env.SMOKE_ARG]; execFile('/fixed/bin', argv)`],
    ['spawn executable', `const selected = process.env.TEST_EXECUTABLE; spawn(selected, [])`],
    ['spawn cwd', `const cwd = process.env.SMOKE_CWD; spawn('/fixed/bin', [], { cwd })`],
    ['spawn shell', `const shell = process.env.TEST_SHELL; spawn('/fixed/bin', [], { shell })`],
    ['helper-return source', `function selected() { return process.env.TEST_COMMAND } exec(selected())`],
    ['object property assignment', `const options = {}; options.cwd = process.env.SMOKE_CWD; spawn('/fixed/bin', [], options)`],
    ['element process env', `const selected = process['env']['TEST_EXECUTABLE']; spawn(selected, [])`],
    ['aliased process env', `const proc = process; const selected = proc.env.SMOKE_EXECUTABLE; spawn(selected, [])`],
    ['aliased destructured process env', `const proc = process; const { env: runtimeEnv } = proc; exec(runtimeEnv.SMOKE_COMMAND)`],
  ];
  for (const [name, source] of [...filesystemCases, ...processCases]) {
    const issues = analyzeProductionTestSeams(source, `${name}.ts`);
    assert.ok(issues.length > 0, `${name} must reach a modeled sink`);
    assert.equal(issues[0]?.reason, PRODUCTION_TEST_SEAM_REASON);
  }

  const bindingContextCases: Array<[string, string]> = [
    ['declaration computed alias to filesystem', `const proc = process; const { ['env']: runtimeEnv } = proc; writeFileSync(runtimeEnv.TEST_FILE, 'x')`],
    ['assignment destructure to filesystem', `let env; ({ env } = process); writeFileSync(env.TEST_FILE, 'x')`],
    ['assignment computed default to process', `let runtimeEnv; ({ ['env']: runtimeEnv = process.env } = process); exec(runtimeEnv.TEST_COMMAND)`],
    ['function parameter to process', `function run({ env }: typeof process) { exec(env.TEST_COMMAND) } run(process)`],
    ['process alias through forwarding helper', `function run({ env }: typeof process) { exec(env.TEST_COMMAND) } function forward(input: typeof process) { run(input) } const proc = process; forward(proc)`],
    ['arrow nested parameter to filesystem', `const run = ({ env: { TEST_FILE: target } }: typeof process) => writeFileSync(target, 'x'); run(process)`],
    ['method computed parameter to process', `const runner = { run({ ['env']: runtimeEnv }: typeof process) { spawn(runtimeEnv.SMOKE_EXECUTABLE, []) } }; runner.run(process)`],
    ['parameter and binding defaults to filesystem', `function run({ env = process.env } = process) { writeFileSync(env.TEST_FILE, 'x') } run()`],
    ['process rest retains env for process sink', `function run({ ...copy }: typeof process) { exec(copy.env.TEST_COMMAND) } run(process)`],
    ['env rest retains TEST keys for filesystem sink', `const { env } = process; const { ...copy } = env; writeFileSync(copy.TEST_FILE, 'x')`],
  ];
  for (const [name, source] of bindingContextCases) {
    const issues = analyzeProductionTestSeams(source, `${name}.ts`);
    assert.ok(issues.length > 0, `${name} must preserve TEST/SMOKE source through its binding context`);
    assert.equal(issues[0]?.reason, PRODUCTION_TEST_SEAM_REASON);
  }

  const callableContextCases: Array<[string, string]> = [
    ['same-name receiver keeps unsafe candidate', `const unsafe = { run(target: string) { writeFileSync(target, 'x') } }; const safe = { run({ env }: typeof process) { return env.PATH } }; unsafe.run(process.env.TEST_FILE)`],
    ['unknown receiver unions same-name candidates', `const unsafe = { run(target: string) { exec(target) } }; const safe = { run() { return '/fixed' } }; const receiver = Math.random() ? unsafe : safe; receiver.run(process.env.TEST_COMMAND)`],
    ['arrow IIFE parameter', `(({ env }: typeof process) => exec(env.TEST_COMMAND))(process)`],
    ['function IIFE parameter', `(function({ env }: typeof process) { writeFileSync(env.TEST_FILE, 'x') })(process)`],
    ['named class constructor', `class Runner { constructor({ env }: typeof process) { exec(env.TEST_COMMAND) } } new Runner(process)`],
    ['anonymous class constructor', `new (class { constructor({ env }: typeof process) { writeFileSync(env.TEST_FILE, 'x') } })(process)`],
    ['named class expression constructor alias', `const Runner = class InternalRunner { constructor({ env }: typeof process) { exec(env.TEST_COMMAND) } }; new Runner(process)`],
    ['method alias invocation', `const unsafe = { run(target: string) { exec(target) } }; const execute = unsafe.run; execute(process.env.TEST_COMMAND)`],
    ['method Function.call invocation', `const unsafe = { run(target: string) { writeFileSync(target, 'x') } }; unsafe.run.call(null, process.env.TEST_FILE)`],
    ['method Function.apply invocation', `const unsafe = { run(target: string) { exec(target) } }; unsafe.run.apply(null, [process.env.TEST_COMMAND])`],
    ['receiver-qualified return taint', `const unsafe = { pick(value: string) { return value } }; const safe = { pick() { return '/fixed' } }; writeFileSync(unsafe.pick(process.env.TEST_FILE), 'x')`],
    ['mutable receiver reassignment unions candidates', `const unsafe = { run(path: string) { writeFileSync(path, 'x') } }; const safe = { run(payload: string) { return payload } }; let receiver = safe; receiver = unsafe; receiver.run(process.env.TEST_FILE)`],
    ['mutable receiver process sink distinct shape', `const unsafe = { run(command: string) { exec(command) } }; const safe = { run({ env }: typeof process) { return env.PATH } }; let receiver = safe; receiver = unsafe; receiver.run(process.env.TEST_COMMAND)`],
    ['const constructor alias', `class Runner { constructor({ env }: typeof process) { exec(env.TEST_COMMAND) } } const Alias = Runner; new Alias(process)`],
    ['mutable constructor alias reassignment', `class Safe { constructor(payload: unknown) {} } class Unsafe { constructor({ env }: typeof process) { writeFileSync(env.TEST_FILE, 'x') } } let Alias = Safe; Alias = Unsafe; new Alias(process)`],
    ['apply local array', `const unsafe = { run(command: string) { exec(command) } }; const args = [process.env.TEST_COMMAND]; unsafe.run.apply(null, args)`],
    ['apply local array alias', `const unsafe = { run(path: string) { writeFileSync(path, 'x') } }; const args = [process.env.TEST_FILE]; const alias = args; unsafe.run.apply(null, alias)`],
    ['apply readonly tuple alias', `const unsafe = { run(command: string) { exec(command) } }; const tuple = [process.env.TEST_COMMAND] as const; const alias = tuple; unsafe.run.apply(null, alias)`],
    ['apply array spread alias', `const unsafe = { run(command: string) { exec(command) } }; const args = [process.env.TEST_COMMAND]; unsafe.run.apply(null, [...args])`],
    ['call spread alias', `const unsafe = { run(path: string) { writeFileSync(path, 'x') } }; const args = [process.env.TEST_FILE]; unsafe.run.call(null, ...args)`],
    ['direct call spread alias', `const unsafe = { run(command: string) { exec(command) } }; const args = [process.env.TEST_COMMAND]; unsafe.run(...args)`],
    ['unknown apply operand taints every parameter', `const unsafe = { run(_fixed: string, command: string) { exec(command) } }; function invoke(args: string[]) { unsafe.run.apply(null, args) } invoke(['/fixed', process.env.TEST_COMMAND])`],
    ['direct method replacement invalidates exact receiver', `const unsafe = { run(path: string) { writeFileSync(path, 'x') } }; const safe = { run(payload: string) { return payload } }; safe.run = unsafe.run; safe.run(process.env.TEST_FILE)`],
    ['computed method replacement invalidates exact receiver', `const unsafe = { run(command: string) { exec(command) } }; const safe = { run(payload: string) { return payload } }; safe['run'] = unsafe.run; safe.run(process.env.TEST_COMMAND)`],
    ['dynamic method replacement invalidates receiver', `const unsafe = { run(path: string) { writeFileSync(path, 'x') } }; const safe = { run(payload: string) { return payload } }; const key = 'run'; safe[key] = unsafe.run; safe.run(process.env.TEST_FILE)`],
    ['Object.assign replacement invalidates receiver', `const unsafe = { run(command: string) { exec(command) } }; const safe = { run(payload: string) { return payload } }; Object.assign(safe, { run: unsafe.run }); safe.run(process.env.TEST_COMMAND)`],
    ['Object.defineProperty replacement invalidates receiver', `const unsafe = { run(path: string) { writeFileSync(path, 'x') } }; const safe = { run(payload: string) { return payload } }; Object.defineProperty(safe, 'run', { value: unsafe.run }); safe.run(process.env.TEST_FILE)`],
    ['Object.defineProperties replacement invalidates receiver', `const unsafe = { run(command: string) { exec(command) } }; const safe = { run(payload: string) { return payload } }; Object.defineProperties(safe, { run: { value: unsafe.run } }); safe.run(process.env.TEST_COMMAND)`],
    ['assignment-created alias mutation', `const unsafe = { run(path: string) { writeFileSync(path, 'x') } }; const safe = { run(payload: string) { return payload } }; let alias; alias = safe; alias.run = unsafe.run; safe.run(process.env.TEST_FILE)`],
    ['parenthesized assignment alias mutation', `const unsafe = { run(command: string) { exec(command) } }; const safe = { run(payload: string) { return payload } }; let alias; alias = (safe); alias['run'] = unsafe.run; safe.run(process.env.TEST_COMMAND)`],
    ['chained assignment alias mutation', `const unsafe = { run(path: string) { writeFileSync(path, 'x') } }; const safe = { run(payload: string) { return payload } }; let first, second; first = (second = safe); second.run = unsafe.run; safe.run(process.env.TEST_FILE)`],
    ['nested holder method replacement', `const unsafe = { run(path: string) { writeFileSync(path, 'x') } }; const safe = { run(payload: string) { return payload } }; const holder = { ref: safe }; holder.ref.run = unsafe.run; safe.run(process.env.TEST_FILE)`],
    ['deeper holder method replacement', `const unsafe = { run(command: string) { exec(command) } }; const safe = { run(payload: string) { return payload } }; const holder = { layer: { ref: safe } }; holder.layer.ref.run = unsafe.run; safe.run(process.env.TEST_COMMAND)`],
    ['nested computed static method replacement', `const unsafe = { run(path: string) { writeFileSync(path, 'x') } }; const safe = { run(payload: string) { return payload } }; const holder = { ref: safe }; holder.ref['run'] = unsafe.run; safe.run(process.env.TEST_FILE)`],
    ['nested dynamic method replacement disables all exact names', `const unsafe = { run(command: string) { exec(command) } }; const safe = { run(payload: string) { return payload } }; const holder = { ref: safe }; const key = 'run'; holder.ref[key] = unsafe.run; safe.run(process.env.TEST_COMMAND)`],
    ['nested Object.assign method replacement', `const unsafe = { run(path: string) { writeFileSync(path, 'x') } }; const safe = { run(payload: string) { return payload } }; const holder = { ref: safe }; Object.assign(holder.ref, { run: unsafe.run }); safe.run(process.env.TEST_FILE)`],
    ['Object.assign later source mutates method', `const unsafe = { run({ env }: typeof process) { exec(env.TEST_COMMAND) } }; const safe = { run(payload: unknown) { return payload } }; Object.assign(safe, { label: 'safe' }, { run: unsafe.run }); safe.run(process)`],
    ['Object.assign multiple static keys union', `const unsafe = { execute({ env }: typeof process) { writeFileSync(env.TEST_FILE, 'x') } }; const safe = { execute(payload: unknown) { return payload } }; Object.assign(safe, { label: 'safe', count: 1 }, { execute: unsafe.execute, enabled: true }); safe.execute(process)`],
    ['Object.assign unknown source before static source', `const unsafe = { run(command: string) { exec(command) } }; const safe = { run(payload: string) { return payload } }; declare const unknown: object; Object.assign(safe, unknown, { run: unsafe.run }); safe.run(process.env.TEST_COMMAND)`],
    ['Object.assign unknown source after static source', `const unsafe = { run(path: string) { writeFileSync(path, 'x') } }; const safe = { run(payload: string) { return payload } }; declare const unknown: object; Object.assign(safe, { run: unsafe.run }, unknown); safe.run(process.env.TEST_FILE)`],
    ['Object.assign known const spread source', `const unsafe = { run({ env }: typeof process) { exec(env.TEST_COMMAND) } }; const safe = { run(payload: unknown) { return payload } }; const replacement = { run: unsafe.run }; Object.assign(safe, { label: 'safe', ...replacement }); safe.run(process)`],
    ['Object.assign dynamic computed source invalidates all', `const unsafe = { run(path: string) { writeFileSync(path, 'x') } }; const safe = { run(payload: string) { return payload } }; declare const key: string; Object.assign(safe, { [key]: unsafe.run }); safe.run(process.env.TEST_FILE)`],
    ['nested Object.assign later source mutates method', `const unsafe = { run({ env }: typeof process) { exec(env.TEST_COMMAND) } }; const safe = { run(payload: unknown) { return payload } }; const holder = { ref: safe }; Object.assign(holder.ref, { label: 'safe' }, { ['run']: unsafe.run }); safe.run(process)`],
    ['nested Object.defineProperty method replacement', `const unsafe = { run(command: string) { exec(command) } }; const safe = { run(payload: string) { return payload } }; const holder = { ref: safe }; Object.defineProperty(holder.ref, 'run', { value: unsafe.run }); safe.run(process.env.TEST_COMMAND)`],
    ['nested Object.defineProperties method replacement', `const unsafe = { run(path: string) { writeFileSync(path, 'x') } }; const safe = { run(payload: string) { return payload } }; const holder = { ref: safe }; Object.defineProperties(holder.ref, { run: { value: unsafe.run } }); safe.run(process.env.TEST_FILE)`],
  ];
  for (const [name, source] of callableContextCases) {
    const issues = analyzeProductionTestSeams(source, `${name}.ts`);
    assert.ok(issues.length > 0, `${name} must preserve TEST/SMOKE source through all callable candidates`);
    assert.equal(issues[0]?.reason, PRODUCTION_TEST_SEAM_REASON);
  }

  const arrayMutationCases: Array<[string, string]> = [
    ['static index assignment', `const args = ['/fixed']; args[0] = process.env.TEST_COMMAND; unsafe.run.apply(null, args)`],
    ['alias to mutated base', `const args = ['/fixed']; const alias = args; args[0] = process.env.TEST_COMMAND; unsafe.run.apply(null, alias)`],
    ['delete element barrier', `const args = [process.env.TEST_COMMAND]; delete args[0]; unsafe.run.apply(null, args)`],
    ['element update barrier', `const args = [process.env.TEST_COMMAND as any]; args[0]++; unsafe.run.apply(null, args)`],
    ['push mutator', `const args = ['/fixed']; args.push(process.env.TEST_COMMAND); unsafe.run.apply(null, args)`],
    ['pop mutator', `const args = [process.env.TEST_COMMAND]; args.pop(); unsafe.run.apply(null, args)`],
    ['shift mutator', `const args = [process.env.TEST_COMMAND]; args.shift(); unsafe.run.apply(null, args)`],
    ['unshift mutator', `const args = ['/fixed']; args.unshift(process.env.TEST_COMMAND); unsafe.run.apply(null, args)`],
    ['splice mutator', `const args = ['/fixed']; args.splice(0, 1, process.env.TEST_COMMAND); unsafe.run.apply(null, args)`],
    ['sort mutator', `const args = [process.env.TEST_COMMAND, '/fixed']; args.sort(); unsafe.run.apply(null, args)`],
    ['reverse mutator', `const args = ['/fixed', process.env.TEST_COMMAND]; args.reverse(); unsafe.run.apply(null, args)`],
    ['copyWithin mutator', `const args = ['/fixed', process.env.TEST_COMMAND]; args.copyWithin(0, 1); unsafe.run.apply(null, args)`],
    ['fill mutator', `const args = ['/fixed']; args.fill(process.env.TEST_COMMAND); unsafe.run.apply(null, args)`],
    ['push inline spread', `const args = ['/fixed']; args.push(...[process.env.TEST_COMMAND]); unsafe.run.apply(null, args)`],
    ['push local alias spread', `const args = ['/fixed']; const extra = [process.env.TEST_COMMAND]; args.push(...extra); unsafe.run.apply(null, args)`],
    ['unshift inline spread', `const args = ['/fixed']; args.unshift(...[process.env.TEST_COMMAND]); unsafe.run.apply(null, args)`],
    ['unshift local alias spread', `const args = ['/fixed']; const extra = [process.env.TEST_COMMAND]; args.unshift(...extra); unsafe.run.apply(null, args)`],
    ['splice inline spread', `const args = ['/fixed']; args.splice(0, 1, ...[process.env.TEST_COMMAND]); unsafe.run.apply(null, args)`],
    ['splice local alias spread', `const args = ['/fixed']; const extra = [process.env.TEST_COMMAND]; args.splice(0, 1, ...extra); unsafe.run.apply(null, args)`],
  ];
  for (const [name, body] of arrayMutationCases) {
    const sink = name.length % 2 === 0
      ? `const unsafe = { run(command: string) { exec(command) } }; ${body}`
      : `const unsafe = { run(path: string) { writeFileSync(path, 'x') } }; ${body.replaceAll('TEST_COMMAND', 'TEST_FILE')}`;
    const issues = analyzeProductionTestSeams(sink, `${name}.ts`);
    assert.ok(issues.length > 0, `${name} must invalidate stale array replay and preserve mutation taint`);
  }

  const safeBindingControls: Array<[string, string]> = [
    ['non-process declaration source', `const input = { env: { TEST_FILE: '/fixed' } }; const { env } = input; writeFileSync(env.TEST_FILE, 'x')`],
    ['non-process function argument', `function run({ env }: { env: { TEST_COMMAND: string } }) { exec(env.TEST_COMMAND) } run({ env: { TEST_COMMAND: '/fixed' } })`],
    ['non-test process property', `const { argv: values } = process; writeFileSync('/fixed', String(values.length))`],
    ['same-name known safe receiver', `const unsafe = { run(target: string) { writeFileSync(target, 'x') } }; const safe = { run(target: string) { writeFileSync('/fixed', target) } }; safe.run('fixed payload')`],
    ['safe arrow IIFE input', `((target: string) => writeFileSync('/fixed', target))('fixed payload')`],
    ['safe constructor input', `class Runner { constructor(target: string) { writeFileSync('/fixed', target) } } new Runner('fixed payload')`],
    ['safe mutable receiver fixed input', `const unsafe = { run(path: string) { writeFileSync(path, 'x') } }; const safe = { run(payload: string) { return payload } }; let receiver = safe; receiver = unsafe; receiver.run('/fixed')`],
    ['safe const constructor alias input', `class Runner { constructor(payload: string) { writeFileSync('/fixed', payload) } } const Alias = Runner; new Alias('fixed payload')`],
    ['safe apply local array input', `const safe = { run(payload: string) { writeFileSync('/fixed', payload) } }; const args = ['fixed payload']; safe.run.apply(null, args)`],
    ['safe call spread input', `const safe = { run(payload: string) { writeFileSync('/fixed', payload) } }; const args = ['fixed payload']; safe.run.call(null, ...args)`],
    ['safe immutable method receiver', `const safe = { run(payload: string) { writeFileSync('/fixed', payload) } }; safe.run('fixed payload')`],
    ['safe immutable apply array', `const safe = { run(payload: string) { writeFileSync('/fixed', payload) } }; const args = ['fixed payload'] as const; safe.run.apply(null, args)`],
    ['safe assignment alias without object mutation', `const unsafe = { run(path: string) { writeFileSync(path, 'x') } }; const safe = { run(payload: string) { writeFileSync('/fixed', payload) } }; let alias; alias = safe; safe.run(process.env.TEST_FILE)`],
    ['safe mutator fixed spread', `const safe = { run(payload: string) { writeFileSync('/fixed', payload) } }; const args = ['fixed']; const extra = ['payload']; args.push(...extra); safe.run.apply(null, args)`],
    ['safe nested immutable holder', `const unsafe = { run(path: string) { writeFileSync(path, 'x') } }; const safe = { run(payload: string) { writeFileSync('/fixed', payload) } }; const holder = { ref: safe }; safe.run(process.env.TEST_FILE); void holder.ref`],
    ['safe unrelated static method mutation', `const unsafe = { run(path: string) { writeFileSync(path, 'x') } }; const safe = { run(payload: string) { writeFileSync('/fixed', payload) } }; const holder = { other() {} }; holder.other = () => {}; safe.run(process.env.TEST_FILE)`],
    ['safe array mutation does not disable method exactness', `const unsafe = { run(path: string) { writeFileSync(path, 'x') } }; const safe = { run(payload: string) { writeFileSync('/fixed', payload) } }; const args = ['/fixed']; args.push('payload'); safe.run(process.env.TEST_FILE)`],
    ['safe Object.assign static non-method sources', `const unsafe = { run(path: string) { writeFileSync(path, 'x') } }; const safe = { run(payload: string) { writeFileSync('/fixed', payload) } }; const holder = {}; Object.assign(holder, { label: 'safe' }, { count: 1, ['enabled']: true }); safe.run(process.env.TEST_FILE)`],
    ['safe Object.assign known const non-method spread', `const unsafe = { run(command: string) { exec(command) } }; const safe = { run(payload: string) { exec('/fixed') } }; const metadata = { label: 'safe' }; const holder = {}; Object.assign(holder, { ...metadata }, { count: 1 }); safe.run(process.env.TEST_COMMAND)`],
  ];
  for (const [name, source] of safeBindingControls) {
    assert.deepEqual(analyzeProductionTestSeams(source, `${name}.ts`), [], `${name} must remain outside TEST/SMOKE taint`);
  }

  const positive = `
    const pathValue = process.env.PATH;
    const rawLimit = process.env.TEST_LIMIT;
    function envPositiveInt(raw: unknown, fallback: number): number {
      const parsed = Number(raw);
      return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
    }
    function fixedMode(raw: unknown): string {
      switch (raw) {
        case 'a': return '/fixed/a';
        case 'b': return '/fixed/b';
        default: return '/fixed/default';
      }
    }
    const limit = envPositiveInt(rawLimit, 2);
    const fixedTarget = fixedMode(process.env.SMOKE_MODE);
    writeFileSync(fixedTarget, String(limit));
    spawn('/fixed/bin', ['--limit', String(limit)], { cwd: '/fixed', env: { PATH: pathValue } });
  `;
  assert.deepEqual(analyzeProductionTestSeams(positive, 'positive.ts'), [], 'bounded numeric/enum sanitizers and PATH reads stay allowed');

  const sanitizerDecoys: Array<[string, string]> = [
    ['numeric tokens plus raw return', `function fake(raw: unknown) { Number(raw); Number.isFinite(Number(raw)); Math.floor(Number(raw)); if (Number(raw) > 0) return raw; return raw; } writeFileSync(fake(process.env.TEST_FILE), 'x')`],
    ['enum literals plus raw return', `function fake(raw: unknown) { if (raw === 'a') return '/fixed/a'; if (raw === 'b') return '/fixed/b'; return raw; } writeFileSync(fake(process.env.SMOKE_FILE), 'x')`],
    ['OR permits Infinity and raw sink value', `function fake(raw: unknown, fallback: string) { const parsed = Number(raw); return Number.isFinite(parsed) || parsed > 0 ? Math.floor(parsed) : fallback; } writeFileSync(String(fake(process.env.TEST_FILE, '/fixed')), 'x')`],
    ['negated finite check is not a safe bound', `function fake(raw: unknown, fallback: string) { const parsed = Number(raw); return !Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback; } exec(String(fake(process.env.TEST_COMMAND, '/fixed')))`],
    ['positive check hidden under alternate OR', `function fake(raw: unknown, fallback: string) { const parsed = Number(raw); return Number.isFinite(parsed) && (parsed > 0 || raw === 'force') ? Math.floor(parsed) : fallback; } spawn(String(fake(process.env.SMOKE_EXECUTABLE, '/fixed')), [])`],
  ];
  for (const [name, source] of sanitizerDecoys) {
    assert.ok(analyzeProductionTestSeams(source, `${name}.ts`).length > 0, `${name} must not be trusted as a sanitizer`);
  }
}

function main(): void {
  selfTest();
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
  assert.equal(
    packageJson.scripts?.['test:production-test-seam-guard'],
    'node packages/main/dist/tasks/production-test-seam-guard.js',
    'root package must expose the focused production test seam guard script',
  );
  assert.equal(packageJson.scripts?.test, 'node packages/main/dist/tasks/full-suite-runner.js', 'root npm test must delegate to the canonical full-suite runner');
  const canonicalRoutineIncludes = (scripts: Record<string, string> | undefined, name: string): boolean => [scripts?.['test:serial-reference-prefix'], scripts?.['test:serial-reference']]
    .filter(Boolean).join(' && ').split(/\s*&&\s*/).includes(`npm run ${name}`);
  assert.equal(canonicalRoutineIncludes(packageJson.scripts, 'test:production-test-seam-guard'), true, 'canonical serial membership authority must include the production seam guard');
  assert.equal(canonicalRoutineIncludes({ ...packageJson.scripts, 'test:serial-reference': packageJson.scripts?.['test:serial-reference']?.replace('npm run test:production-test-seam-guard', '') ?? '' }, 'test:production-test-seam-guard'), false, 'removing the seam guard from main serial-reference fails membership');
  assert.equal(canonicalRoutineIncludes({ ...packageJson.scripts, 'test:serial-reference-prefix': '' }, 'test:full-suite-runner-smoke'), false, 'removing prefix serial-reference fails canonical smoke membership');
  // B-cc10: read whichever config filename exists. This hardcoded the deprecated name
  // and threw ENOENT after the rename, failing the whole guard on a migrated repo.
  const configRel = CONFIG_FILENAMES.find((name) => existsSync(join(repoRoot, name))) ?? CONFIG_FILENAMES[0];
  const proofOrStopConfig = readFileSync(join(repoRoot, configRel), 'utf8');
  assert.match(proofOrStopConfig, /packages\/main\/dist\/tasks\/production-test-seam-guard\.js/, 'routine validate must run the production seam guard');
  const scanRoots = [join(repoRoot, 'packages/main/src/core'), join(repoRoot, 'packages/main/src/handlers')];
  const files = scanRoots.flatMap(listTypeScriptFiles);
  assert.ok(files.length > 0, 'production seam guard must scan core and handlers');
  assert.ok(files.every(file => !file.includes(`${join('src', 'tasks')}`)), 'task-only sources must remain outside production scan');
  const issues = files.flatMap(file => analyzeProductionTestSeams(readFileSync(file, 'utf8'), relative(repoRoot, file)));
  if (issues.length > 0) {
    for (const issue of issues) {
      console.error(`Blocked [${issue.reason}] ${issue.file}:${issue.line}:${issue.column} env=${issue.envKeys.join(',')} -> ${issue.sink}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log('Production test seam guard: PASS — no unsafe SMOKE/TEST control reaches a filesystem or process sink.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
