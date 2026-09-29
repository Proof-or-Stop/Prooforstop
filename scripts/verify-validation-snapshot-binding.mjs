#!/usr/bin/env node
// Canonical runtime checks use the supported TypeScript parser, not Lab-only
// Node module hooks. Dynamic operation counts remain in the managed Lab test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

console.log('SNAPSHOT_BINDING_RUNTIME ' + JSON.stringify({ node: process.version, executable: process.execPath, argv: process.argv.slice(1) }));

const source = readFileSync(new URL('../packages/main/src/core/shared-validation-execution.ts', import.meta.url), 'utf8');
const fail = (ok, detail) => assert(ok, 'VALIDATION_SNAPSHOT_BINDING_INVALID: ' + detail);
function verify(text) {
  const file = ts.createSourceFile('shared-validation-execution.ts', text, ts.ScriptTarget.Latest, true);
  fail(file.parseDiagnostics.length === 0, 'source must parse');
  const owners = file.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'executeSharedValidationCommand');
  fail(owners.length === 1 && owners[0].body, 'exact shared execution owner');
  const body = owners[0].body;
  const local = name => {
    const matches = body.statements.flatMap(statement => ts.isVariableStatement(statement)
      && (statement.declarationList.flags & ts.NodeFlags.Const)
      ? statement.declarationList.declarations.filter(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === name) : []);
    fail(matches.length === 1 && matches[0].initializer, 'one invocation-local const ' + name);
    return matches[0];
  };
  const compact = node => ts.createPrinter({ removeComments: true }).printNode(ts.EmitHint.Unspecified, node, file).replace(/\s+/g, '');
  const initial = local('initial');
  const facts = local('initialCanonical');
  const inputs = local('inputFilesCanonical');
  const unchanged = local('unchanged');
  fail(compact(initial.initializer) === 'probe()', 'initial facts come from a live probe');
  fail(compact(facts.initializer) === 'causalCanonical(initial)', 'canonical initial facts');
  fail(compact(inputs.initializer) === 'causalCanonical(inputFiles)', 'canonical initial input bytes');
  fail(initial.pos < facts.pos && facts.pos < unchanged.pos && inputs.pos < unchanged.pos, 'baseline capture precedes freshness closure');
  const closure = unchanged.initializer;
  fail(ts.isArrowFunction(closure) && ts.isBlock(closure.body), 'freshness closure');
  const attempt = closure.body.statements[0];
  fail(attempt && ts.isTryStatement(attempt), 'freshness comparison retains refusal boundary');
  const result = attempt.tryBlock.statements[0];
  fail(result && ts.isReturnStatement(result) && result.expression, 'freshness return');
  const expected = 'launchDrift()===undefined&&causalCanonical(probe())===initialCanonical&&workspaceState()===workspace'
    + '&&causalCanonical(additionalInputs())===inputFilesCanonical&&executionImplementationIdentity().digest===implementationDigest'
    + '&&(!artifactBinding||currentBuildArtifactsHash(artifactBinding.root,artifactBinding.configRoot)===artifactBindingHash)';
  fail(compact(result.expression) === expected, 'live facts, workspace, input bytes and implementation comparison');
  const counts = { initial: 0, inputFiles: 0 };
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'causalCanonical'
      && node.arguments.length === 1 && ts.isIdentifier(node.arguments[0]) && node.arguments[0].text in counts) {
      counts[node.arguments[0].text]++;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  fail(counts.initial === 1 && counts.inputFiles === 1, 'baseline canonicalization occurs once in the owner');
}
verify(source);
const mutants = [
  ['const initialCanonical = causalCanonical(initial);', ''],
  ['const inputFilesCanonical = causalCanonical(inputFiles);', ''],
  ['causalCanonical(probe()) === initialCanonical', 'initialCanonical === initialCanonical'],
  ['causalCanonical(additionalInputs()) === inputFilesCanonical', 'inputFilesCanonical === inputFilesCanonical'],
  ['causalCanonical(probe()) === initialCanonical', 'causalCanonical(probe()) === causalCanonical(initial)'],
  ['launchDrift() === undefined && ', ''],
  ['&& (!artifactBinding || currentBuildArtifactsHash(artifactBinding.root, artifactBinding.configRoot) === artifactBindingHash)', ''],
];
for (const [from, to] of mutants) {
  assert.equal(source.split(from).length, 2, 'Mutation must bind exactly once');
  const mutant = source.replace(from, to);
  assert.throws(() => verify(mutant), /VALIDATION_SNAPSHOT_BINDING_INVALID/);
}
console.log('VALIDATION_SNAPSHOT_BINDING_GREEN actual-owner seven-mutations-refused no-module-hooks');
