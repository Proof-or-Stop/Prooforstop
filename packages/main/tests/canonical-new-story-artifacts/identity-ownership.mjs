import { SCANNER_SOURCE_PATHS } from '../../../../scripts/identity-cutover/scanner-contexts.mjs';



import assert from 'node:assert/strict';


import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { dirname, join, relative, resolve } from 'node:path';



import ts from 'typescript';



import { IDENTITY_CUTOVER_REQUIRED_PATHS, OWNED_IMPORTED_IDENTITY_ORIGINS, repoRoot, OWNED_IMPORT_USE_CONTEXTS, ACTIVE_IDENTITY_OPERATION_BOUNDARIES, OWNED_NON_PROTOCOL_IDENTITY_CONTEXTS, PROJECT_CONFIG_IDENTITY_CASES, OWNED_IDENTITY_SITE_CONTEXTS } from "./data.mjs";

export function deriveOwnedIdentityLiterals(sourceMap, { emitted = false } = {}) {
  const result = [];
  const exactIdentity = /^proof-or-stop[.\-][a-zA-Z0-9._-]+(?:\0)?$/u;
  for (const path of IDENTITY_CUTOVER_REQUIRED_PATHS) {
    assert.ok(sourceMap.has(path), `owned identity source missing: ${path}`);
    let source = sourceMap.get(path);
    const occurrences = [];
    const add = (value, context) => {
      if (typeof value === 'string' && exactIdentity.test(value)) occurrences.push({ canonical: value.replace(/\0$/u, ''), context });
    };
    if (/\.(?:ts|mjs)$/u.test(path)) {
      if (path.endsWith('.ts') && !emitted) source = ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, removeComments: true },
      }).outputText;
      const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const unknown = Symbol('unresolved-constant');
      const declarations = new Map();
      const collect = node => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
          && (node.parent.flags & ts.NodeFlags.Const)) {
          const named = declarations.get(node.name.text) ?? [];
          named.push(node); declarations.set(node.name.text, named);
        }
        ts.forEachChild(node, collect);
      };
      collect(ast);
      const importedValues = new Map();
      for (const [consumerPath, originPath, exportName] of OWNED_IMPORTED_IDENTITY_ORIGINS.filter(row => row[0] === path)) {
        const origin = ts.createSourceFile(originPath, sourceMap.get(originPath) ?? readFileSync(join(repoRoot, originPath), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        const declarations = origin.statements.flatMap(node => ts.isVariableStatement(node) && node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ? [...node.declarationList.declarations] : [])
          .filter(node => ts.isIdentifier(node.name) && node.name.text === exportName);
        assert.equal(declarations.length, 1, `imported identity origin missing/duplicate: ${originPath}#${exportName}`);
        let initializer = declarations[0].initializer;
        while (initializer && (ts.isAsExpression(initializer) || ts.isParenthesizedExpression(initializer))) initializer = initializer.expression;
        assert.ok(initializer && ts.isStringLiteralLike(initializer) && exactIdentity.test(initializer.text), `imported identity origin is not an exact canonical literal: ${originPath}#${exportName}`);
        const imports = ast.statements.filter(ts.isImportDeclaration).flatMap(node => {
          const bindings = node.importClause?.namedBindings;
          if (!bindings || !ts.isNamedImports(bindings) || !ts.isStringLiteralLike(node.moduleSpecifier)) return [];
          const resolved = relative(repoRoot, resolve(repoRoot, dirname(consumerPath), node.moduleSpecifier.text)).replace(/\.js$/u, '.ts');
          return resolved === originPath ? bindings.elements.filter(binding => (binding.propertyName ?? binding.name).text === exportName) : [];
        });
        assert.equal(imports.length, 1, `imported identity binding missing/duplicate: ${consumerPath}#${exportName}`);
        importedValues.set(imports[0].name.text, initializer.text);
      }
      const resolving = new Set();
      const evaluate = node => {
        if (!node || resolving.has(node)) return unknown;
        resolving.add(node);
        let value = unknown;
        if (ts.isStringLiteralLike(node)) value = node.text;
        else if (ts.isNumericLiteral(node)) value = Number(node.text);
        else if (ts.isParenthesizedExpression(node)) value = evaluate(node.expression);
        else if (ts.isIdentifier(node)) {
          if (importedValues.has(node.text)) value = importedValues.get(node.text);
          const named = declarations.get(node.text) ?? [];
          // Resolve only the nearest lexically enclosing const declaration.
          // Calls, mutation and arbitrary TS execution are never evaluated.
          for (let owner = node.parent; owner && value === unknown; owner = owner.parent) {
            const candidates = named.filter(declaration => declaration.parent.parent.parent === owner);
            if (candidates.length === 1) value = evaluate(candidates[0].initializer);
            else if (candidates.length > 1) break;
          }
        } else if (ts.isArrayLiteralExpression(node)) {
          const values = node.elements.map(evaluate);
          if (!values.includes(unknown)) value = values;
        } else if (ts.isObjectLiteralExpression(node)) {
          const result = Object.create(null);
          let complete = true;
          for (const property of node.properties) {
            if (!ts.isPropertyAssignment(property) || !property.name || ts.isComputedPropertyName(property.name)) { complete = false; break; }
            result[property.name.text] = evaluate(property.initializer);
          }
          if (complete) value = result;
        } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
          const left = evaluate(node.left), right = evaluate(node.right);
          if (['string', 'number'].includes(typeof left) && ['string', 'number'].includes(typeof right)) value = left + right;
        } else if (ts.isTemplateExpression(node)) {
          let result = node.head.text;
          for (const span of node.templateSpans) {
            const part = evaluate(span.expression);
            if (!['string', 'number'].includes(typeof part)) { result = unknown; break; }
            result += String(part) + span.literal.text;
          }
          value = result;
        } else if (ts.isPropertyAccessExpression(node)) {
          const receiver = evaluate(node.expression);
          if (receiver && typeof receiver === 'object' && Object.hasOwn(receiver, node.name.text)) value = receiver[node.name.text];
        } else if (ts.isElementAccessExpression(node)) {
          const receiver = evaluate(node.expression), key = evaluate(node.argumentExpression);
          if (receiver && typeof receiver === 'object' && ['string', 'number'].includes(typeof key) && Object.hasOwn(receiver, key)) value = receiver[key];
        } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          if (node.expression.getText(ast) === 'Object.freeze' && node.arguments.length === 1) value = evaluate(node.arguments[0]);
          else if (node.expression.name.text === 'join' && node.arguments.length <= 1) {
            const receiver = evaluate(node.expression.expression), separator = node.arguments.length ? evaluate(node.arguments[0]) : ',';
            if (Array.isArray(receiver) && receiver.every(part => ['string', 'number'].includes(typeof part)) && typeof separator === 'string') value = receiver.join(separator);
          }
        }
        resolving.delete(node);
        return value;
      };
      const walk = node => {
        if (ts.isStringLiteralLike(node)) add(node.text, node.parent.getText(ast));
        else if (ts.isBinaryExpression(node) || ts.isTemplateExpression(node) || ts.isCallExpression(node)
          || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)
          || (ts.isIdentifier(node) && (node.parent.name !== node || ts.isShorthandPropertyAssignment(node.parent)))) {
          const value = evaluate(node);
          if (typeof value === 'string') add(value, node.parent.getText(ast));
        }
        ts.forEachChild(node, walk);
      };
      walk(ast);
    } else if (path.endsWith('.json')) {
      const walk = (value, location) => {
        add(value, location);
        if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
          add(key, `${location}.${key}:key`);
          walk(child, `${location}.${key}`);
        }
      };
      walk(JSON.parse(source), '$');
    } else if (path.endsWith('.md')) {
      const name = source.match(/^name:\s*(proof-or-stop[.\-][a-zA-Z0-9._-]+)\s*$/mu);
      if (name) add(name[1], name[0]);
    }
    for (const canonical of [...new Set(occurrences.map(row => row.canonical))].sort()) {
      const contexts = occurrences.filter(row => row.canonical === canonical).map(row => row.context);
      result.push({ sourcePath: path, canonical, occurrences: contexts.length,
        contextSha256: createHash('sha256').update(contexts.join('\n')).digest('hex') });
    }
  }
  return result;
}

export function deriveOwnedImportUseContexts(sourceMap) {
  const rows = [];
  for (const path of IDENTITY_CUTOVER_REQUIRED_PATHS.filter(path => /\.(?:ts|mjs)$/u.test(path))) {
    assert.ok(sourceMap.has(path), `owned import source missing: ${path}`);
    const source = path.endsWith('.ts') ? ts.transpileModule(sourceMap.get(path), {
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, removeComments: true },
    }).outputText : sourceMap.get(path);
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const contexts = [];
    const declarations = new Map();
    const imported = new Set();
    const scopeOf = node => {
      for (let scope = node.parent; scope; scope = scope.parent) {
        if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isFunctionLike(scope)) return scope;
      }
      return ast;
    };
    const register = (node, scope = scopeOf(node)) => {
      if (!ts.isIdentifier(node.name)) return;
      const names = declarations.get(scope) ?? new Map();
      const values = names.get(node.name.text) ?? [];
      values.push(node); names.set(node.name.text, values); declarations.set(scope, names);
    };
    const collect = node => {
      if (ts.isVariableDeclaration(node) || ts.isParameter(node) || (ts.isFunctionDeclaration(node) && node.name)) register(node);
      ts.forEachChild(node, collect);
    };
    collect(ast);
    for (const node of ast.statements.filter(ts.isImportDeclaration)) {
      contexts.push(node.getText(ast));
      if (node.importClause?.name) { register(node.importClause, ast); imported.add(node.importClause); }
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) { register(bindings, ast); imported.add(bindings); }
      else if (bindings) for (const binding of bindings.elements) { register(binding, ast); imported.add(binding); }
    }
    const bindingOf = node => {
      if (!ts.isIdentifier(node) || (node.parent.name === node && !ts.isShorthandPropertyAssignment(node.parent))) return null;
      for (let scope = node.parent; scope; scope = scope.parent) {
        const found = declarations.get(scope)?.get(node.text);
        if (found) return found.length === 1 ? found[0] : null;
      }
      return null;
    };
    // Propagate actual lexical bindings, never global name matches. A same-name
    // local parameter cannot taint unrelated data/hash declarations elsewhere.
    let grew = true;
    while (grew) {
      grew = false;
      for (const names of declarations.values()) for (const entries of names.values()) for (const declaration of entries) {
        if (!ts.isVariableDeclaration(declaration) || !declaration.initializer || imported.has(declaration)) continue;
        let usesImport = false;
        const inspect = node => { if (imported.has(bindingOf(node))) usesImport = true; ts.forEachChild(node, inspect); };
        inspect(declaration.initializer);
        if (usesImport) { imported.add(declaration); grew = true; }
      }
    }
    const walk = node => {
      if (imported.has(bindingOf(node))) {
        let use = node.parent;
        while (use.parent && (ts.isPropertyAccessExpression(use) || ts.isElementAccessExpression(use))) use = use.parent;
        contexts.push(use.getText(ast));
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) contexts.push(node.getText(ast));
      ts.forEachChild(node, walk);
    };
    walk(ast);
    rows.push({ sourcePath: path, occurrences: contexts.length, contextSha256: createHash('sha256').update(contexts.join('\n')).digest('hex') });
  }
  return rows;
}

export function assertOwnedImportUseIntegrity(sourceMap, pins = OWNED_IMPORT_USE_CONTEXTS) {
  assert.deepEqual(deriveOwnedImportUseContexts(sourceMap), pins, 'owned import use changed or unresolved imported identity use was added');
}

export function assertOwnedIdentitySiteTotality(sourceMap, boundaries = ACTIVE_IDENTITY_OPERATION_BOUNDARIES, classifications = OWNED_NON_PROTOCOL_IDENTITY_CONTEXTS, options = {}) {
  const derived = deriveOwnedIdentityLiterals(sourceMap, options);
  assertDerivedIdentitySiteTotality(derived, boundaries, classifications, options);
  return derived;
}

export function assertDerivedIdentitySiteTotality(derived, boundaries, classifications, options = {}) {
  const configCases = options.projectConfigCases ?? PROJECT_CONFIG_IDENTITY_CASES;
  const sites = [...boundaries.flatMap(boundary => boundary.identitySites), ...configCases];
  const cases = [...boundaries.flatMap(boundary => boundary.retiredIdentityCases), ...configCases];
  const missing = [];
  for (const row of derived) {
    const owners = sites.filter(site => site.sourcePath === row.sourcePath && site.canonical === row.canonical);
    const classes = classifications.filter(entry => entry.sourcePath === row.sourcePath && entry.canonical === row.canonical);
    if (owners.length === 0 && classes.length === 0) { missing.push(`${row.sourcePath}#${row.canonical}`); continue; }
    assert.equal(owners.length + classes.length, 1, `owned identity has duplicate/competing classification: ${row.sourcePath}#${row.canonical}`);
    if (owners.length) {
      assert.equal(cases.filter(entry => entry.siteId === owners[0].siteId).length, 1, `owned identity case missing/duplicate: ${owners[0].siteId}`);
      const pins = (options.contextPins ?? OWNED_IDENTITY_SITE_CONTEXTS).filter(pin => pin.sourcePath === row.sourcePath && pin.canonical === row.canonical);
      assert.equal(pins.length, 1, `owned identity occurrence context missing/duplicate: ${owners[0].siteId}`);
      assert.equal(row.occurrences, pins[0].occurrences, `owned identity use count changed: ${owners[0].siteId}`);
      if (!options.emitted) assert.equal(row.contextSha256, pins[0].contextSha256, `owned identity use context changed: ${owners[0].siteId}`);
    } else {
      const classification = classes[0];
      assert.equal(row.occurrences, classification.occurrences, `owned identity classification count drift: ${row.sourcePath}#${row.canonical}`);
      if (!options.emitted) assert.equal(row.contextSha256, classification.contextSha256, `owned identity classification context drift: ${row.sourcePath}#${row.canonical}`);
      assert.ok(classification.kind && classification.reason && classification.proof, `owned identity classification has no bounded proof: ${row.canonical}`);
    }
  }
  for (const classification of classifications) assert.ok(derived.some(row => row.sourcePath === classification.sourcePath && row.canonical === classification.canonical), `stale owned identity classification: ${classification.sourcePath}#${classification.canonical}`);
  assert.deepEqual(missing, [], 'unclassified owned executable identity sites');
}

export function registeredIdentityOperationSourcePaths(boundaries, source = readFileSync(join(repoRoot, 'packages/main/src/core/runtime-environment-checks.ts'), 'utf8')) {
  const release = boundaries.find(boundary => boundary.id === 'release-ledgers');
  assert.ok(release && ['artifact_release_list', 'capability_release_list'].every(command => release.commands.includes(command)), 'scanner source closure requires its real public-operation owner');
  const ast = ts.createSourceFile('runtime-environment-checks.ts', source, ts.ScriptTarget.Latest, true);
  const declarations = ast.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations])
    .filter(node => node.name.getText(ast) === 'IDENTITY_VERIFIER_PROJECT_SOURCE_PATHS');
  assert.equal(declarations.length, 1, 'unique runtime scanner source closure');
  const initializer = declarations[0].initializer;
  assert.ok(ts.isCallExpression(initializer) && initializer.expression.getText(ast) === 'Object.freeze' && initializer.arguments.length === 1 && ts.isArrayLiteralExpression(initializer.arguments[0]), 'runtime scanner closure must remain literal and frozen');
  const paths = initializer.arguments[0].elements.map(node => { assert.ok(ts.isStringLiteral(node)); return node.text; });
  assert.deepEqual(paths, SCANNER_SOURCE_PATHS, 'runtime public-operation scanner closure must equal the independently reviewed module inventory');
  return [...new Set([...boundaries.flatMap(boundary => boundary.paths.map(path => path.sourcePath)), ...paths])];
}
