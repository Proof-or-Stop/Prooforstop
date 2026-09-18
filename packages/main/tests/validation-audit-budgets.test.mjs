// Structural deadline proof. Full command results are recorded separately.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
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
const delegation = facts.VALIDATION_RESERVATION_DELEGATION_RUNTIME_POLICY;
const lifecycleMarginMs = 2 * delegation.workerRegistrationMs + 2 * delegation.cleanupMs
  + 2 * delegation.observationRetries * (delegation.kernelObservationMs + delegation.observationBackoffMs);
assert.ok(parentMs >= workerMs + lifecycleMarginMs,
  `DFEC_PARENT_DEADLINE_PREEMPTS_WORKER_CLEANUP: parent=${parentMs}, worker=${workerMs}, required lifecycle margin=${lifecycleMarginMs}`);

const config = JSON.parse(readFileSync(resolve(root, 'proof-or-stop.config.json'), 'utf8'));
const members = [
  'test:dynamic-finding-evidence-closure', 'scripts/verify-process-fact-contract.mjs',
  'packages/main/dist/tasks/red-evidence-target-binding-smoke.js',
  'packages/main/dist/tasks/red-evidence-envelope-smoke.js',
];
// Audit acceptance: complete assertions, serial invocation, 900 s total per member.
// This is a configuration contract, not an assertion of a speed improvement.
for (const member of members) {
  const rows = config.validate.commands.filter(row => row.args?.includes(member));
  assert.equal(rows.length, 1, `one canonical registration required: ${member}`);
  assert.equal(rows[0].timeoutMs, 900000, `VALIDATION_COMPOSITE_BUDGET_MISMATCH: ${member}`);
}
console.log('VALIDATION_AUDIT_BUDGET_CONTRACT_GREEN: structural deadline and configuration checks only; full suites required separately');
