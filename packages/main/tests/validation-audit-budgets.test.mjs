// Structural deadline proof. Full command results are recorded separately.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { runInNewContext } from 'node:vm';
import * as facts from '../dist/core/runtime-fact-registry.js';

const root = resolve(import.meta.dirname, '../../..');
const source = path => {
  const text = readFileSync(resolve(root, path), 'utf8');
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
};
const find = (ast, predicate) => {
  const rows = [];
  const walk = node => { if (predicate(node)) rows.push(node); ts.forEachChild(node, walk); };
  walk(ast);
  assert.equal(rows.length, 1, 'deadline witness must resolve one actual call site');
  return rows[0];
};
const coordinationChild = source('packages/main/tests/validation-coordination-guard.test.mjs');
const coordinationOptions = find(coordinationChild, node => ts.isVariableDeclaration(node) && node.name.getText(coordinationChild) === 'options');
const deadlineFactories = coordinationChild.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'withDeadline');
assert.ok(deadlineFactories.length <= 1);
let fixtureNow = 1000;
const deadlineContext = { root: 'fixture', Date: { now: () => fixtureNow } };
runInNewContext('const options = ' + coordinationOptions.initializer.getText(coordinationChild) + ';\n'
  + (deadlineFactories[0]?.getText(coordinationChild) ?? '')
  + '\nglobalThis.acquireOptions = () => ' + (deadlineFactories.length ? 'withDeadline()' : 'options') + ';', deadlineContext);
const firstDeadline = deadlineContext.acquireOptions().deadlineAt;
fixtureNow += 21000;
assert.ok(deadlineContext.acquireOptions().deadlineAt > fixtureNow,
  'COORDINATION_REUSED_ABSOLUTE_DEADLINE: a later acquisition inherits an expired setup deadline');
assert.equal(firstDeadline, 21000);
assert.equal(deadlineContext.acquireOptions().deadlineAt - fixtureNow, 20000);
const coordinationAcquisitions = [];
const visitCoordination = node => {
  if (ts.isCallExpression(node) && node.expression.getText(coordinationChild) === 'withWorkspaceValidationCapacity') coordinationAcquisitions.push(node);
  ts.forEachChild(node, visitCoordination);
};
visitCoordination(coordinationChild);
assert.equal(coordinationAcquisitions.length, 8);
for (const call of coordinationAcquisitions) assert.ok(ts.isCallExpression(call.arguments[0])
  && call.arguments[0].expression.getText(coordinationChild) === 'withDeadline', 'every actual acquisition must obtain a fresh deadline');
assert.equal(runInNewContext('withDeadline({ deadlineAt: Date.now() + 1000 }).deadlineAt', deadlineContext), fixtureNow + 1000,
  'the deliberate live-holder timeout remains independently short');
const coordinationParent = source('scripts/verify-runtime-fact-contract.mjs');
const coordinationChildCall = find(coordinationChild, node => ts.isCallExpression(node) && node.expression.getText(coordinationChild) === 'spawnSync');
const coordinationParentCall = find(coordinationParent, node => ts.isCallExpression(node)
  && node.expression.getText(coordinationParent) === 'execFileSync'
  && node.arguments[1]?.getText(coordinationParent).includes("'packages/main/tests/validation-coordination-guard.test.mjs'"));
const coordinationTimeout = (call, ast) => Function('coordinationFixtureBudget', 'return ('
  + call.arguments[2].properties.find(node => node.name?.getText(ast) === 'timeout').initializer.getText(ast) + ');')(facts.WORKSPACE_VALIDATION_COORDINATION_FIXTURE_RUNTIME_POLICY);
const coordinationChildMs = coordinationTimeout(coordinationChildCall, coordinationChild);
const coordinationParentMs = coordinationTimeout(coordinationParentCall, coordinationParent);
const coordinationPolicy = facts.WORKSPACE_VALIDATION_COORDINATION_FIXTURE_RUNTIME_POLICY;
assert.equal(coordinationPolicy.childMs, 30000);
assert.equal(coordinationPolicy.lifecycleMarginMs, 15000);
assert.equal(coordinationChildMs, coordinationPolicy.childMs);
assert.equal(coordinationParentMs, coordinationPolicy.controllerMs);
assert.ok(coordinationParentMs >= coordinationChildMs + coordinationPolicy.lifecycleMarginMs,
  `COORDINATION_PARENT_DEADLINE_PREEMPTS_CHILD: parent=${coordinationParentMs}, child=${coordinationChildMs}, required margin=15000`);
const parent = source('packages/main/tests/red/red-dynamic-finding-evidence-closure.mjs');
const call = find(parent, node => ts.isCallExpression(node) && node.expression.getText(parent) === 'spawnSync');
const timeout = call.arguments[2].properties.find(node => node.name?.getText(parent) === 'timeout').initializer;
const worker = source('packages/main/src/tasks/isolated-finding-fixture.ts');
let defaultBudget = find(worker, node => ts.isVariableDeclaration(node) && node.name.getText(worker) === 'budgetMs').initializer;
while (ts.isConditionalExpression(defaultBudget)) defaultBudget = defaultBudget.whenFalse;
const evaluate = (node, ast) => Function('findingFixtureBudget', `return (${node.getText(ast)});`)(facts.FINDING_EVIDENCE_FIXTURE_RUNTIME_POLICY);
const workerMs = evaluate(defaultBudget, worker);
const parentMs = evaluate(timeout, parent);
assert.equal(workerMs, 120000, 'the repair must preserve the original worker execution allowance');
assert.ok(parentMs >= workerMs + facts.FINDING_EVIDENCE_FIXTURE_RUNTIME_POLICY.lifecycleMarginMs,
  'DFEC_PARENT_DEADLINE_MUST_INCLUDE_REGISTERED_LIFECYCLE_MARGIN');
const delegation = facts.VALIDATION_RESERVATION_DELEGATION_RUNTIME_POLICY;
const lifecycleMarginMs = 2 * delegation.workerRegistrationMs + 2 * delegation.cleanupMs
  + 2 * delegation.observationRetries * (delegation.kernelObservationMs + delegation.observationBackoffMs);
assert.ok(parentMs >= workerMs + lifecycleMarginMs,
  `DFEC_PARENT_DEADLINE_PREEMPTS_WORKER_CLEANUP: parent=${parentMs}, worker=${workerMs}, required lifecycle margin=${lifecycleMarginMs}`);

const config = JSON.parse(readFileSync(resolve(root, 'proof-or-stop.config.json'), 'utf8'));
const members = [
  ['test:dynamic-finding-evidence-closure', 900000],
  ['packages/main/tests/red/red-w2b-wiring-contract.mjs', 900000],
  ['packages/main/tests/red/red-dynamic-finding-collection-readiness.mjs', 600000],
  ['packages/main/tests/red/red-dynamic-finding-head-continuity.mjs', 600000],
  ['packages/main/tests/red/red-empty-checklist-lifecycle.mjs', 600000],
  ['packages/main/tests/red/red-lab-nested-fixture-machine-isolation.mjs', 600000],

  ['scripts/verify-process-fact-contract.mjs', 260000],
  ['packages/main/dist/tasks/red-evidence-target-binding-smoke.js', 260000],
  ['packages/main/dist/tasks/red-evidence-envelope-smoke.js', 260000],
];
// The complete process-fact consumers use the user-authorized 260 s budget.
// Composite finding closure and wiring retain their reviewed 900 s allowances.
// This checks the configuration; full timed executions are separate evidence.
for (const [member, budgetMs] of members) {
  const rows = config.validate.commands.filter(row => row.args?.includes(member));
  assert.equal(rows.length, 1, `one canonical registration required: ${member}`);
  assert.equal(rows[0].timeoutMs, budgetMs, `VALIDATION_COMPOSITE_BUDGET_MISMATCH: ${member}`);
}

const acceptance=JSON.parse(readFileSync(resolve(root,'docs/lab/validation-audit-acceptance.json'),'utf8'));
const acceptanceTargets = [
  [16, ['scripts/verify-process-fact-contract.mjs', '--quiet']],
  [69, ['packages/main/dist/tasks/red-evidence-target-binding-smoke.js', '--canonical-core']],
  [130, ['packages/main/dist/tasks/red-evidence-envelope-smoke.js', '--canonical-core']],
];
assert.deepEqual(acceptance.targetIndexes, acceptanceTargets.map(([index]) => index), 'LAB_ACCEPTANCE_TARGET_SET_MISMATCH');
const assertAcceptanceTarget = (commands, index, args) => {
  const row = commands[index - 1];
  assert.ok(row, `LAB_ACCEPTANCE_TARGET_MISSING: #${index}`);
  assert.deepEqual([row.command, row.args], ['node', args], `LAB_ACCEPTANCE_TARGET_IDENTITY_MISMATCH: #${index}`);
  assert.ok(acceptance.thresholdMs <= row.timeoutMs, `LAB_ACCEPTANCE_EXCEEDS_PRODUCTION_BUDGET: #${index}`);
};
for (const [index, args] of acceptanceTargets) {
  assertAcceptanceTarget(config.validate.commands, index, args);
  const shifted = [...config.validate.commands];
  shifted.splice(index - 1, 0, {command: 'node', args: ['unrelated-command.mjs'], timeoutMs: 900000});
  assert.throws(() => assertAcceptanceTarget(shifted, index, args), /LAB_ACCEPTANCE_TARGET_IDENTITY_MISMATCH/);
  assert.throws(() => assertAcceptanceTarget([], index, args), /LAB_ACCEPTANCE_TARGET_MISSING/);
}

// This parent runs both real verifiers and the public runtime/package fixtures.
// Its deadline must cover the existing child allowances plus that other work.
const identity = source('scripts/verify-proof-or-stop-identity-cutover.mjs');
const runtimeCall = find(identity, node => ts.isVariableDeclaration(node)
  && node.name.getText(identity) === 'runtimeCheck').initializer;
assert.equal(runtimeCall.expression.getText(identity), 'execFileSync');
const runtimeTimeout = runtimeCall.arguments[2].properties.find(node => node.name?.getText(identity) === 'timeout').initializer;
const runtimeParentMs = Function('identityCertificationBudget', `return (${runtimeTimeout.getText(identity)});`)(facts.IDENTITY_CERTIFICATION_RUNTIME_POLICY);
const childBudget = member => {
  const rows = config.validate.commands.filter(row => row.args?.includes(member));
  assert.equal(rows.length, 1, `one canonical runtime witness required: ${member}`);
  assert.ok(Number.isSafeInteger(rows[0].timeoutMs) && rows[0].timeoutMs > 0);
  return rows[0].timeoutMs;
};
const requiredRuntimeMs = childBudget('scripts/verify-process-fact-contract.mjs')
  + childBudget('scripts/verify-runtime-fact-contract.mjs') + 300000;
assert.ok(runtimeParentMs >= requiredRuntimeMs,
  `IDENTITY_RUNTIME_PARENT_DEADLINE_PREEMPTS_FULL_WORKLOAD: parent=${runtimeParentMs}, required=${requiredRuntimeMs}`);
const identityPolicy = facts.IDENTITY_CERTIFICATION_RUNTIME_POLICY;
assert.equal(identityPolicy.publicRuntimeAndPackageMarginMs, 300000);
assert.equal(runtimeParentMs, requiredRuntimeMs + identityPolicy.conservativeHeadroomMs,
  'identity parent includes only the registered workloads, public fixtures and explicit conservative headroom');
assert.equal(runtimeParentMs, identityPolicy.runtimeGroupMs);
const identityRows = config.validate.commands.filter(row => row.args?.includes('--group=identity-cutover'));
assert.equal(identityRows.length, 1);
assert.ok(identityRows[0].timeoutMs >= runtimeParentMs + identityPolicy.otherIdentityWitnessMs,
  'identity outer command must retain a separate allowance for the other full identity witnesses');
console.log('VALIDATION_AUDIT_BUDGET_CONTRACT_GREEN: structural deadline and configuration checks only; full suites required separately');
