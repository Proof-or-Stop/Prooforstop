import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
export const moduleRoot = resolve(import.meta.dirname, 'canonical-new-story-artifacts');
export function parse(file, text = readFileSync(file, 'utf8')) {
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  assert.equal(ast.parseDiagnostics.length, 0, file);
  return {file, text, ast};
}
export function registrations(input) {
  const result = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(input.ast) === 'check') {
      const [groups, name, callback] = node.arguments;
      if (ts.isStringLiteral(name)) result.push({...input, name:name.text, groups:vm.runInNewContext(groups.getText(input.ast)), callback});
    }
    ts.forEachChild(node, visit);
  }
  visit(input.ast);
  return result;
}
export function modularRegistrations() {
  const driver = parse(resolve(moduleRoot, 'driver.mjs'));
  const imports = new Map();
  for (const node of driver.ast.statements) if (ts.isImportDeclaration(node)) {
    const bindings = node.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) {
      if (item.propertyName?.text === 'runCases') imports.set(item.name.text, resolve(dirname(driver.file), node.moduleSpecifier.text));
    }
  }
  const entry = driver.ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'runCanonical');
  assert.ok(entry?.body, 'actual modular driver must be present');
  const scheduled = [];
  for (const statement of entry.body.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isAwaitExpression(statement.expression)) continue;
    const call = statement.expression.expression;
    if (ts.isCallExpression(call) && ts.isIdentifier(call.expression) && imports.has(call.expression.text)) scheduled.push(imports.get(call.expression.text));
  }
  assert.equal(new Set(scheduled).size, imports.size, 'every imported case module must be scheduled');
  return scheduled.flatMap(file => registrations(parse(file)));
}
export function dispatcherSource() {
  const {ast} = parse(resolve(moduleRoot, 'runner.mjs'));
  const nodes = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'check');
  assert.equal(nodes.length, 1, 'actual check dispatcher must be found');
  return nodes[0].getText(ast).replace(/^export\s+/, '');
}
export function dispatcher(selectedGroup, overrides = {}, source = dispatcherSource()) {
  const context = vm.createContext({selectedGroup, selectedGroups:selectedGroup === null ? null : [selectedGroup], failures:[], process:{pid:process.pid, hrtime:process.hrtime, stdout:{write(){}}, stderr:{write(){}}}, ...overrides});
  vm.runInContext(source, context);
  return context;
}
