

import { existsSync, readdirSync } from 'node:fs';


import { join } from 'node:path';

import ts from 'typescript';
import nodeAssert from 'node:assert/strict';

import { read, root, assert } from './support.mjs';

export const _sourceFileCache = new Map();

export function parseSourceFile(relPath) {
  if (_sourceFileCache.has(relPath)) return _sourceFileCache.get(relPath);
  const sf = ts.createSourceFile(relPath, read(relPath), ts.ScriptTarget.Latest, /* setParentNodes */ true, ts.ScriptKind.TS);
  _sourceFileCache.set(relPath, sf);
  return sf;
}

export function findFunctionDeclaration(sf, name) {
  let found;
  const visit = (node) => {
    if (found) return;
    if (ts.isFunctionDeclaration(node) && node.name && node.name.text === name) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return found;
}

export function collectCalledNames(node) {
  const names = new Set();
  const walk = (n) => {
    if (ts.isCallExpression(n)) {
      const e = n.expression;
      if (ts.isIdentifier(e)) names.add(e.text);
      else if (ts.isPropertyAccessExpression(e)) names.add(e.name.text);
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return names;
}

export function subtreeReferencesProperty(node, propName) {
  let found = false;
  const walk = (n) => {
    if (found) return;
    if (ts.isPropertyAccessExpression(n) && n.name.text === propName) { found = true; return; }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

export function subtreeReturnsFalseOk(node) {
  let found = false;
  const walk = (n) => {
    if (found) return;
    if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === 'ok'
        && n.initializer.kind === ts.SyntaxKind.FalseKeyword) { found = true; return; }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

export function hasDiffEnumerationBlockingBranch(body) {
  let ok = false;
  const walk = (n) => {
    if (ok) return;
    if (ts.isIfStatement(n)
        && subtreeReferencesProperty(n.expression, 'diffEnumerationError')
        && subtreeReturnsFalseOk(n.thenStatement)) {
      ok = true;
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(body);
  return ok;
}

export function hasTestEntryAnchoredComparison(body) {
  let ok = false;
  const walk = (n) => {
    if (ok) return;
    if (ts.isBinaryExpression(n)
        && n.operatorToken.kind === ts.SyntaxKind.GreaterThanEqualsToken
        && ts.isPropertyAccessExpression(n.left) && n.left.name.text === 'timestamp'
        && ts.isPropertyAccessExpression(n.right) && n.right.name.text === 'testEntryAt'
        && ts.isIdentifier(n.right.expression) && n.right.expression.text === 'facts') {
      ok = true;
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(body);
  return ok;
}

export function subtreeThrows(node) {
  let found = false;
  const walk = (n) => {
    if (found) return;
    if (ts.isThrowStatement(n)) { found = true; return; }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

export function hasPropertyGuardedThrowingBranch(body, propName) {
  let ok = false;
  const walk = (n) => {
    if (ok) return;
    if (ts.isIfStatement(n)
        && subtreeReferencesProperty(n.expression, propName)
        && subtreeThrows(n.thenStatement)) {
      ok = true;
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(body);
  return ok;
}

export function bodyHasObjectPropertyNamed(body, propName) {
  let found = false;
  const walk = (n) => {
    if (found) return;
    const isNamed = (name) => (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === propName;
    if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && isNamed(n.name)) { found = true; return; }
    ts.forEachChild(n, walk);
  };
  walk(body);
  return found;
}

export function subtreeReadsMember(node, objName, propName) {
  let found = false;
  const walk = (n) => {
    if (found) return;
    if (ts.isPropertyAccessExpression(n) && n.name.text === propName
        && ts.isIdentifier(n.expression) && n.expression.text === objName) { found = true; return; }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

export function subtreeReferencesIdentifier(node, name) {
  let found = false;
  const walk = (n) => {
    if (found) return;
    if (ts.isIdentifier(n) && n.text === name) { found = true; return; }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

export function hasIdentifierGuardedThrowingBranch(node, identifierName) {
  let ok = false;
  const walk = (n) => {
    if (ok) return;
    if (ts.isIfStatement(n)
        && subtreeReferencesIdentifier(n.expression, identifierName)
        && subtreeThrows(n.thenStatement)) {
      ok = true;
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return ok;
}

export function subtreeHasMemberEqualsString(node, propName, value) {
  let found = false;
  const walk = (n) => {
    if (found) return;
    if (ts.isBinaryExpression(n)
        && n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
        && ts.isPropertyAccessExpression(n.left) && n.left.name.text === propName
        && ts.isStringLiteralLike(n.right) && n.right.text === value) { found = true; return; }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

export function subtreeAssignsIdentifierString(node, name, value) {
  let found = false;
  const walk = (n) => {
    if (found) return;
    if (ts.isBinaryExpression(n)
        && n.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isIdentifier(n.left) && n.left.text === name
        && ts.isStringLiteralLike(n.right) && n.right.text === value) { found = true; return; }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

export function findCallExpressionByName(node, calleeName) {
  let found;
  const walk = (n) => {
    if (found) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === calleeName) { found = n; return; }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

export function collectConditionalObjectSpreads(node) {
  const spreads = [];
  const walk = (n) => {
    if (ts.isSpreadAssignment(n)) {
      let expr = n.expression;
      while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
      if (ts.isConditionalExpression(expr)) {
        spreads.push({ condition: expr.condition, whenTrue: expr.whenTrue, whenFalse: expr.whenFalse });
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return spreads;
}

export function isDefinedCheckOnMember(expr, objName, propName) {
  return Boolean(expr)
    && ts.isBinaryExpression(expr)
    && expr.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
    && ts.isPropertyAccessExpression(expr.left)
    && expr.left.name.text === propName
    && ts.isIdentifier(expr.left.expression) && expr.left.expression.text === objName
    && ts.isIdentifier(expr.right) && expr.right.text === 'undefined';
}

export function isIdentifierEqualsStringLiteral(expr, identifierName, value) {
  return Boolean(expr)
    && ts.isBinaryExpression(expr)
    && expr.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
    && ts.isIdentifier(expr.left) && expr.left.text === identifierName
    && ts.isStringLiteralLike(expr.right) && expr.right.text === value;
}

export function objectLiteralPropertyInitializer(node, propName) {
  if (!node || !ts.isObjectLiteralExpression(node)) return undefined;
  for (const prop of node.properties) {
    if (ts.isPropertyAssignment(prop)
        && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
        && prop.name.text === propName) return prop.initializer;
  }
  return undefined;
}

export function isEmptyObjectLiteral(node) {
  return Boolean(node) && ts.isObjectLiteralExpression(node) && node.properties.length === 0;
}

export function findMemberAssignment(node, objName, propName) {
  let found;
  const walk = (n) => {
    if (found) return;
    if (ts.isBinaryExpression(n)
        && n.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isPropertyAccessExpression(n.left)
        && n.left.name.text === propName
        && ts.isIdentifier(n.left.expression) && n.left.expression.text === objName) { found = n; return; }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

export function collectMemberCalls(node, objName, methodName) {
  const calls = [];
  const walk = (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
        && n.expression.name.text === methodName
        && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === objName) calls.push(n);
    ts.forEachChild(n, walk);
  };
  walk(node);
  return calls.sort((a, b) => a.pos - b.pos);
}

export function collectCallExpressionsByName(node, calleeName) {
  const calls = [];
  const walk = (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === calleeName) calls.push(n);
    ts.forEachChild(n, walk);
  };
  walk(node);
  return calls.sort((a, b) => a.pos - b.pos);
}

export function findIfStatement(node, predicate) {
  let found;
  const walk = (n) => {
    if (found) return;
    if (ts.isIfStatement(n) && predicate(n)) { found = n; return; }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

export function subtreeDeletesMember(node, propName) {
  let found = false;
  const walk = (n) => {
    if (found) return;
    if (ts.isDeleteExpression(n)
        && ts.isPropertyAccessExpression(n.expression)
        && n.expression.name.text === propName) { found = true; return; }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

export function findFunctionLike(sf, name) {
  let found;
  const named = (node) => {
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) return node.name && ts.isIdentifier(node.name) && node.name.text === name;
    if (ts.isPropertyAssignment(node)) {
      return (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === name
        && (ts.isFunctionExpression(node.initializer) || ts.isArrowFunction(node.initializer));
    }
    if (ts.isVariableDeclaration(node)) {
      return ts.isIdentifier(node.name) && node.name.text === name && node.initializer
        && (ts.isFunctionExpression(node.initializer) || ts.isArrowFunction(node.initializer));
    }
    return false;
  };
  const visit = (node) => {
    if (found) return;
    if (named(node)) {
      found = ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) ? node : node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return found;
}

export function objectLiteralHasProperty(node, propName) {
  if (!node || !ts.isObjectLiteralExpression(node)) return false;
  return node.properties.some(prop =>
    (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop))
    && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
    && prop.name.text === propName);
}

export function findNewExpressionByName(node, ctorName) {
  let found;
  const walk = (n) => {
    if (found) return;
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === ctorName) { found = n; return; }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

export function subtreeComparesMembers(node, leftProp, rightObj, rightProp) {
  let found = false;
  const walk = (n) => {
    if (found) return;
    if (ts.isBinaryExpression(n)
        && n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
        && ts.isPropertyAccessExpression(n.left) && n.left.name.text === leftProp
        && ts.isPropertyAccessExpression(n.right) && n.right.name.text === rightProp
        && ts.isIdentifier(n.right.expression) && n.right.expression.text === rightObj) { found = true; return; }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

export let _materialProgram;

export let _materialChecker;

export function getMaterialProgram() {
  if (_materialProgram) return _materialProgram;
  const configPath = join(root, 'packages/main/tsconfig.json');
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, join(root, 'packages/main'));
  const rootFiles = [
    'packages/main/src/core/review-assurance-floor.ts',
    'packages/main/src/core/repro-evidence-binding-gate.ts',
    'packages/main/src/handlers/phase-gates.ts',
    'packages/main/src/handlers/proofstory.ts',
    'packages/main/src/core/material-code-policy.ts',
  ].map((p) => join(root, p));
  _materialProgram = ts.createProgram(rootFiles, { ...parsed.options, noEmit: true, skipLibCheck: true });
  _materialChecker = _materialProgram.getTypeChecker();
  return _materialProgram;
}

export function materialProgramSourceFile(relPath) {
  const sf = getMaterialProgram().getSourceFile(join(root, relPath));
  assert(sf, `${relPath}: source file must be present in the material-code type program`);
  return sf;
}

export const FUNCTION_LIKE_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
]);

export function isFunctionLike(node) {
  return FUNCTION_LIKE_KINDS.has(node.kind);
}

export function resolveCalleeSymbol(callExpr) {
  getMaterialProgram();
  let sym = _materialChecker.getSymbolAtLocation(callExpr.expression);
  if (!sym) return undefined;
  if (sym.flags & ts.SymbolFlags.Alias) {
    try { sym = _materialChecker.getAliasedSymbol(sym); } catch { /* keep original */ }
  }
  return sym;
}

export function calleeSymbolMatches(callExpr, name, moduleSubstr) {
  const sym = resolveCalleeSymbol(callExpr);
  if (!sym) return false;
  // Post-alias getName() is the ORIGINAL exported symbol name, not the local alias.
  if (typeof sym.getName === 'function' ? sym.getName() !== name : sym.name !== name) return false;
  const decls = sym.getDeclarations?.() ?? [];
  return decls.some((d) => d.getSourceFile().fileName.includes(moduleSubstr));
}

export function resolveCalleeFunctionDeclaration(callExpr) {
  const sym = resolveCalleeSymbol(callExpr);
  const decls = sym?.getDeclarations?.() ?? [];
  return decls.find((d) => isFunctionLike(d));
}

export function inProvablyDeadBranch(node) {
  let cur = node;
  while (cur.parent) {
    const parent = cur.parent;
    if (ts.isIfStatement(parent)) {
      const cond = parent.expression;
      const isFalse = cond.kind === ts.SyntaxKind.FalseKeyword || (ts.isNumericLiteral(cond) && Number(cond.text) === 0);
      const isTrue = cond.kind === ts.SyntaxKind.TrueKeyword || (ts.isNumericLiteral(cond) && Number(cond.text) !== 0 && !Number.isNaN(Number(cond.text)));
      if (isFalse && cur === parent.thenStatement) return true;
      if (isTrue && parent.elseStatement && cur === parent.elseStatement) return true;
    } else if (ts.isConditionalExpression(parent)) {
      const cond = parent.condition;
      const isFalse = cond.kind === ts.SyntaxKind.FalseKeyword || (ts.isNumericLiteral(cond) && Number(cond.text) === 0);
      const isTrue = cond.kind === ts.SyntaxKind.TrueKeyword || (ts.isNumericLiteral(cond) && Number(cond.text) !== 0 && !Number.isNaN(Number(cond.text)));
      if (isFalse && cur === parent.whenTrue) return true;
      if (isTrue && cur === parent.whenFalse) return true;
    }
    cur = parent;
  }
  return false;
}

export function callResultConsumed(callExpr) {
  const p = callExpr.parent;
  if (ts.isExpressionStatement(p)) return false;
  if (ts.isVoidExpression(p) && p.parent && ts.isExpressionStatement(p.parent)) return false;
  if (ts.isVariableDeclaration(p) && p.initializer === callExpr && ts.isIdentifier(p.name)) {
    return declaredSymbolReferencedBeyondDeclaration(p.name);
  }
  return true;
}

export function declaredSymbolReferencedBeyondDeclaration(nameIdent) {
  getMaterialProgram();
  const declSym = _materialChecker.getSymbolAtLocation(nameIdent);
  if (!declSym) return false;
  let fn = nameIdent.parent;
  while (fn && !isFunctionLike(fn)) fn = fn.parent;
  const scope = fn && fn.body ? fn.body : nameIdent.getSourceFile();
  let refs = 0;
  const walk = (n) => {
    if (n !== nameIdent && ts.isIdentifier(n) && n.text === nameIdent.text) {
      if (_materialChecker.getSymbolAtLocation(n) === declSym) refs++;
    }
    ts.forEachChild(n, walk);
  };
  walk(scope);
  return refs >= 1;
}

export function functionBodyHasResolvedCall(fnNode, name, moduleSubstr, { requireConsumed = false } = {}) {
  const body = fnNode && fnNode.body;
  if (!body) return false;
  let found = false;
  const walk = (n) => {
    if (found) return;
    if (isFunctionLike(n)) return; // skip nested function bodies
    if (ts.isCallExpression(n)
        && !inProvablyDeadBranch(n)
        && calleeSymbolMatches(n, name, moduleSubstr)
        && (!requireConsumed || callResultConsumed(n))) {
      found = true;
      return;
    }
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(body, walk);
  return found;
}

export function builderReturnObjectLiterals(fnNode) {
  const body = fnNode && fnNode.body;
  if (!body) return [];
  const out = [];
  const walk = (n) => {
    if (n !== body && isFunctionLike(n)) return; // stay in this builder body
    if (ts.isReturnStatement(n) && n.expression && ts.isObjectLiteralExpression(n.expression)
        && !inProvablyDeadBranch(n)) {
      out.push(n.expression);
    }
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(body, walk);
  return out;
}

export function objectLiteralMaterialClassificationInit(objLit) {
  for (const prop of objLit.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === 'materialClassification') {
      return prop.initializer;
    }
    // shorthand `{ materialClassification }` — an Identifier value, never a delegating
    // call, so surface it (fails the call check below rather than being treated as absent).
    if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === 'materialClassification') {
      return prop.name;
    }
  }
  return undefined;
}

export function initializerDelegatesToTry(init) {
  const TRY = 'tryBuildMaterialClassificationSnapshotForDiagnostics';
  const MCP = 'material-code-policy';
  if (calleeSymbolMatches(init, TRY, MCP)) return true;
  const helperDecl = resolveCalleeFunctionDeclaration(init);
  return !!helperDecl && functionBodyHasResolvedCall(helperDecl, TRY, MCP, { requireConsumed: true });
}

export function listMarkdown(dir) {
  const absDir = join(root, dir);
  assert(existsSync(absDir), `${dir} should exist`);
  if (!existsSync(absDir)) return [];
  return readdirSync(absDir)
    .filter(name => name.endsWith('.md'))
    .sort()
    .map(name => `${dir}/${name}`);
}
