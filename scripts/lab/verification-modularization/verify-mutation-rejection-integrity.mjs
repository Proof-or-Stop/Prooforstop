import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { runStory3Mutation, assertStory3VerifierPositiveControl } from '../../../packages/main/dist/tasks/finding-ledger-runtime/process-mutation-proof.js';
const root = fs.mkdtempSync(join(tmpdir(), 'process-mutation-evidence-control-'));
try {
  fs.mkdirSync(join(root, 'scripts'));
  const entry = join(root, 'scripts/verify-process-fact-contract.mjs');
  const baselinePath = 'packages/main/src/tasks/finding-ledger-runtime-smoke.ts';
  const original = ts.createSourceFile(baselinePath, execFileSync('git', ['show', '8938f4fdc8:' + baselinePath], { encoding: 'utf8' }), ts.ScriptTarget.Latest, true);
  const legacyFunction = original.statements.find(n => ts.isFunctionDeclaration(n) && n.name.text === 'story3VerifierMutationAccepted');
  assert.ok(legacyFunction, 'baseline must contain the original mutation-verdict helper');
  const oldSource = "import { spawnSync } from 'node:child_process';\nimport { join } from 'node:path';\nexport " + legacyFunction.getText(original);
  const oldPath = join(root, 'original-verdict.mjs');
  fs.writeFileSync(oldPath, ts.transpileModule(oldSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
  const { story3VerifierMutationAccepted: originalVerdict } = await import(pathToFileURL(oldPath).href);
  fs.writeFileSync(entry, "console.error('unrelated fixture startup failure'); process.exit(1);\n");
  assert.equal(originalVerdict(root, 'story3-query-path-leak'), false, 'original helper must reproduce accepting unrelated failure as rejection');
  console.log('MUTATION_EVIDENCE_RED: original helper misclassifies unrelated exit 1 as detected mutation');
  assert.throws(() => runStory3Mutation(root, 'story3-query-path-leak'), /unrelated verifier failure is not mutation rejection evidence/);
  fs.writeFileSync(entry, "console.error('PROCESS_CAPABILITY_FAIL '+JSON.stringify({capability:'story3',failures:['unrelated contract']}));process.exit(1);\n");
  assert.throws(() => runStory3Mutation(root, 'story3-query-path-leak'), /exact rejection reason/);
  fs.writeFileSync(entry, "process.kill(process.pid,'SIGTERM');\n");
  assert.throws(() => runStory3Mutation(root, 'story3-query-path-leak'), /signaled verifier/);
  fs.writeFileSync(entry, 'process.exit(0);\n');
  assert.throws(() => assertStory3VerifierPositiveControl(root), /PROCESS_PARTIAL_PASS/);
  console.log('MUTATION_EVIDENCE_GREEN: unrelated failure, wrong reason, signal and markerless success refused');
  // Acceptance controls: genuine evidence must still be accepted, so a helper that
  // throws on every input cannot pass this integrity test.
  fs.writeFileSync(entry, "console.error('PROCESS_CAPABILITY_FAIL '+JSON.stringify({capability:'story3',failures:['Story 3: protected query surface contains a path-bearing field']}));process.exit(1);\n");
  assert.equal(runStory3Mutation(root, 'story3-query-path-leak'), false, 'exact registered rejection must count as detected mutation');
  fs.writeFileSync(entry, "console.log('PROCESS_PARTIAL_PASS '+JSON.stringify({capabilities:['story3']}));process.exit(0);\n");
  assert.equal(runStory3Mutation(root, 'story3-query-path-leak'), true, 'passing partial run must report the mutation as accepted');
  assert.doesNotThrow(() => assertStory3VerifierPositiveControl(root));
  console.log('MUTATION_EVIDENCE_ACCEPTANCE_GREEN: exact rejection and passing partial run are accepted');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
