// Preserve original declarations and default invocation order, including negative controls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
const base = 'scripts/lab/verification-modularization/';
const sha = value => createHash('sha256').update(value).digest('hex');
const parse = (text, file = 'source.ts') => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
const historical = (ref, file) => parse(execFileSync('git', ['show', `${ref}:${file}`], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }), file);
function declarations(ast, file) {
  return ast.statements.flatMap(node => ts.isVariableStatement(node)
    ? node.declarationList.declarations.map(d => ({ name: d.name.getText(ast), kind: node.declarationList.flags & ts.NodeFlags.Const ? 'const' : 'let', text: d.getText(ast), initializer: d.initializer?.getText(ast), node: d, file }))
    : ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)
      ? [{ name: node.name.text, kind: ts.isInterfaceDeclaration(node) ? 'interface' : 'type', text: node.getText(ast).replace(/^export /, ''), node, file }] : []);
}
function modules(dir) {
  return fs.readdirSync(dir).filter(name => /\.(?:ts|mjs)$/.test(name)).map(name => {
    const file = `${dir}/${name}`; return { file, ast: parse(fs.readFileSync(file, 'utf8'), file) };
  });
}
function requireDeclarations(expected, actual, label) {
  for (const row of expected) {
    const found = actual.filter(candidate => candidate.name === row.name);
    assert.equal(found.length, 1, `${label}: declaration missing or duplicated: ${row.name}`);
    assert.equal(found[0].kind, row.kind, `${label}: declaration kind changed: ${row.name}`);
    assert.equal(found[0].text, row.text, `${label}: declaration value changed: ${row.name}`);
  }
}
function declarationControls(expected, actual, label) {
  assert(expected.length > 0);
  requireDeclarations(expected, actual, label);
  const target = expected[0].name;
  assert.throws(() => requireDeclarations(expected, actual.filter(row => row.name !== target), label), /declaration missing/);
  assert.throws(() => requireDeclarations(expected, actual.map(row => row.name === target ? { ...row, text: `${row.name} = 'MUTATED_EXPECTATION'` } : row), label), /declaration value changed/);
}
const calls = statements => statements.flatMap(node => {
  if (!ts.isExpressionStatement(node)) return [];
  let expression = node.expression, awaited = false;
  if (ts.isAwaitExpression(expression)) { awaited = true; expression = expression.expression; }
  if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression)) return [];
  return [{ name: expression.expression.text, args: expression.arguments.map(arg => arg.getText() === 'repositoryRoot' ? 'root' : arg.getText()), awaited }];
});
const property = (node, name) => node.properties.find(p => p.name?.getText().replaceAll("'", '').replaceAll('"', '') === name)?.initializer;
function arrayDeclaration(ast, name) {
  const row = declarations(ast).find(row => row.name === name); assert(row, name);
  assert(ts.isArrayLiteralExpression(row.node.initializer), name + ' must remain a literal ordered table'); return row.node.initializer.elements;
}
function orderControls(expected, actual, label) {
  assert.deepEqual(actual, expected, label);
  assert.throws(() => assert.deepEqual(actual.slice(1), expected), /./);
  const swapped = [...actual]; [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
  assert.throws(() => assert.deepEqual(swapped, expected), /./);
}
export function verifyTopLevelPreservation(family) {
  if (family === 'flow') {
    const entry = 'packages/main/src/tasks/flow-stability-smoke.ts', dir = 'packages/main/src/tasks/flow-stability';
    const original = historical('cf1552808f', entry), merged = historical('742155e320', entry), current = modules(dir);
    const expected = declarations(original), actual = current.flatMap(row => declarations(row.ast, row.file));
    declarationControls(expected, actual, 'FLOW');
    const cli = current.find(row => row.file.endsWith('/cli.ts')).ast;
    const table = arrayDeclaration(cli, 'FLOW_CASES');
    const actualIds = table.map(row => { const id = property(row, 'id'), run = property(row, 'run'); assert(ts.isStringLiteral(id) && ts.isIdentifier(run)); assert.equal(run.text, id.text, 'flow ID must invoke that exact check'); return id.text; });
    const baseline = calls(original.statements).map(row => row.name);
    const mergedCalls = calls(merged.statements).map(row => row.name);
    const added = ['assertImplementationWorkerAuthorityUsesFrozenMasterIntegrationTarget', 'assertImplementationWorkerAuthorityReportsUnresolvedIntegrationTarget'];
    assert.deepEqual(mergedCalls.filter(name => !added.includes(name)), baseline, 'main additions retain the original call sequence');
    const liveness = merged.statements.find(node => ts.isIfStatement(node) && node.expression.getText(merged) === "!process.argv.includes('--canonical-core')"); assert(liveness);
    assert.equal(calls([liveness.thenStatement])[0]?.name, 'runAgentLivenessSuiteForPinnedEvidence');
    const block = merged.statements.find(node => ts.isBlock(node)); assert(block);
    const historicalBody = cli.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'assertHistoricalCommitSubjects'); assert(historicalBody);
    assert.equal(historicalBody.body.getText(cli), block.getText(merged), 'read-both assertions remain intact');
    orderControls([...mergedCalls, 'runAgentLivenessSuiteForPinnedEvidence', 'assertHistoricalCommitSubjects'], actualIds, 'FLOW_DEFAULT_CALL_ORDER_CHANGED');
    const source = fs.readFileSync(`${dir}/cli.ts`, 'utf8');
    assert(source.includes('for (const row of FLOW_CASES) if (selected.includes(row.capability)) await row.run();'));
    assert.equal(property(table.find(row => property(row, 'id').text === 'runAgentLivenessSuiteForPinnedEvidence'), 'capability').text, 'liveness');
    console.log('FLOW_TOP_LEVEL_PRESERVED ' + JSON.stringify({ declarations: expected.length, calls: actualIds.length, mutationControls: 4 }));
  } else if (family === 'planner') {
    const entry = 'packages/main/src/tasks/validation-tier-planner-smoke.ts';
    const original = historical('9c8e8b848b', entry), expected = declarations(original);
    const actual = modules('packages/main/src/tasks/validation-tier-planner').flatMap(row => declarations(row.ast, row.file));
    declarationControls(expected, actual, 'PLANNER');
    const pin = JSON.parse(fs.readFileSync(base + 'planner-inventory-pin-repair.json', 'utf8'));
    const relevant = original.statements.filter(node => !ts.isImportDeclaration(node) && !ts.isFunctionDeclaration(node) && !ts.isVariableStatement(node) && !ts.isInterfaceDeclaration(node) && !ts.isTypeAliasDeclaration(node));
    assert.equal(relevant.reduce((count, node) => count + node.getText(original).split(pin.before).length - 1, 0), 1, 'planner pin repair must have exactly one original match');
    console.log('PLANNER_TOP_LEVEL_PRESERVED ' + JSON.stringify({ declarations: expected.length, pinRepairMatches: 1, mutationControls: 2 }));
  } else if (family === 'ledger') {
    const entry = 'packages/main/src/tasks/finding-ledger-runtime-smoke.ts';
    const original = historical('8938f4fdc8', entry);
    let full = original.statements.find(n => ts.isIfStatement(n) && n.getText(original).startsWith('if (process.argv[2]'));
    while (ts.isIfStatement(full)) full = full.elseStatement;
    const statements = [...full.statements.find(ts.isTryStatement).tryBlock.statements];
    const start = statements.findIndex(n => n.getText(original).startsWith('const concurrentFile'));
    const end = statements.findIndex(n => n.getText(original).startsWith('const repositoryRoot')); assert(start >= 0 && end > start);
    const expected = [...calls(statements.slice(0, start)), { name: 'runLedgerTransactions', args: ['scratch'], awaited: true }, ...calls(statements.slice(end))];
    const cli = parse(fs.readFileSync('packages/main/src/tasks/finding-ledger-runtime/cli.ts', 'utf8'));
    const rows = arrayDeclaration(cli, 'CAPABILITIES'); const actual = []; let prerequisites = 0;
    for (const row of rows) {
      const id = property(row, 'id').text, run = property(row, 'run'); assert(ts.isArrowFunction(run) && ts.isBlock(run.body));
      for (const call of calls(run.body.statements)) {
        if (call.name === 'ensureDistributionProjectionWitness') { assert.equal(id, 'build-distribution'); assert.deepEqual(call.args, []); prerequisites++; }
        else actual.push(call);
      }
    }
    assert.equal(prerequisites, 1, 'the standalone distribution prerequisite is explicit and unique');
    const transaction = parse(fs.readFileSync('packages/main/src/tasks/finding-ledger-runtime/transactions.ts', 'utf8'));
    const extracted = transaction.statements.find(ts.isFunctionDeclaration).body.statements;
    assert.deepEqual(extracted.map(n => n.getText(transaction)), statements.slice(start, end).map(n => n.getText(original)), 'transaction slice remains exact');
    orderControls(expected, actual, 'LEDGER_DEFAULT_CALL_ORDER_OR_ARGUMENTS_CHANGED');
    const wrongArgs = actual.map((row, index) => index ? row : { ...row, args: ['wrongRoot'] }); assert.throws(() => assert.deepEqual(wrongArgs, expected));
    assert(fs.readFileSync('packages/main/src/tasks/finding-ledger-runtime/cli.ts', 'utf8').includes('for (const row of CAPABILITIES) if(selected.includes(row.id)) await row.run(root,scratch);'));
    console.log('LEDGER_TOP_LEVEL_PRESERVED ' + JSON.stringify({ calls: actual.length, transactionStatements: extracted.length, standalonePrerequisites: prerequisites, mutationControls: 3 }));
  } else if (family === 'canonical') {
    const entry = 'packages/main/tests/canonical-new-story-artifacts.test.mjs', dir = 'packages/main/tests/canonical-new-story-artifacts';
    const original = historical('e07c723f5f', entry), expected = declarations(original), current = modules(dir), actual = current.flatMap(row => declarations(row.ast, row.file));
    const approved = JSON.parse(fs.readFileSync(base + 'canonical-declaration-relocations.json', 'utf8'));
    const shared = ['freshFixture', 'runtimeTopologyFixture', 'publicIdentityOperationFixture', 'runtimeFixture', 'identityCutoverFixture', 'identityVerifierResult'];
    const state = actual.find(row => row.name === 'state'); assert(state && ts.isObjectLiteralExpression(state.node.initializer));
    const compared = [];
    for (const row of expected) {
      if (shared.includes(row.name)) {
        const initializer = property(state.node.initializer, row.name); assert(initializer, 'shared state slot missing: ' + row.name);
        assert.equal(initializer.getText(), row.initializer ?? 'undefined', 'shared state initial value changed: ' + row.name); continue;
      }
      if (row.name === 'groupArgs') { assert.equal(row.text, 'groupArgs = process.argv.slice(2)'); assert(fs.readFileSync(entry, 'utf8').includes('process.argv.slice(2)')); continue; }
      const found = actual.filter(candidate => candidate.name === row.name); assert.equal(found.length, 1, 'canonical declaration missing or duplicated: ' + row.name);
      let text = row.text;
      if (row.name === 'here') text = "here = resolve(dirname(fileURLToPath(import.meta.url)), '..')";
      if (row.name === '{ base: journalFixtureBase, delta: journalFixtureDelta }') text = text.replace("'../../../scripts/verify-acceptance-amendment-delta.mjs'", '"../../../../scripts/verify-acceptance-amendment-delta.mjs"');
      if (row.name === 'selectedGroup') { text = 'selectedGroup = null'; assert(fs.readFileSync(`${dir}/data.mjs`, 'utf8').includes("selectedGroup = groups === null ? null : groups.join(',');")); }
      const repair = approved.find(r => r.name === row.name);
      if (repair) {
        assert.equal(sha(row.text), repair.beforeSha256, 'canonical original declaration binding changed');
        assert.equal(sha(found[0].text), repair.afterSha256, 'canonical reviewed declaration changed: ' + row.name);
        assert.notEqual(sha(found[0].text + ' changed'), repair.afterSha256); continue;
      }
      compared.push({ ...row, kind: row.name === 'selectedGroup' ? 'let' : row.kind, text });
    }
    assert.equal(approved.length, 5); assert.equal(new Set(approved.map(row => row.name)).size, 5);
    declarationControls(compared, actual, 'CANONICAL');
    console.log('CANONICAL_TOP_LEVEL_PRESERVED ' + JSON.stringify({ originalDeclarations: expected.length, exactOrRelocatedDeclarations: compared.length, reviewedInventoryDeclarations: approved.length, sharedSlots: shared.length, legacyArgumentBinding: 1, mutationControls: 7 }));
  } else if (['prompt', 'retired', 'process', 'quorum'].includes(family)) {
    const specs = {
      prompt: ['856e011213', 'scripts/verify-proof-or-stop-prompt-baseline.mjs', 'scripts/prompt-baseline'],
      retired: ['4a6d510ac0', 'packages/main/src/tasks/retired-authority-vocabulary-guard-smoke.ts', 'packages/main/src/tasks/retired-authority'],
      process: ['17ace95ded', 'scripts/verify-process-fact-contract.mjs', 'scripts/process-fact-contract'],
      quorum: ['57205854d1', 'packages/main/tests/red/red-B-e40f-quorum-submit-harness.mjs', 'packages/main/tests/red/quorum-submit-harness'],
    };
    const [ref, entry, dir] = specs[family], original = historical(ref, entry), current = modules(dir);
    let expected = declarations(original), actual = current.flatMap(row => declarations(row.ast, row.file));
    const driverName = { retired: 'runRetiredComplete', quorum: 'runSelectedHarness' }[family];
    if (driverName) {
      const owner = current.find(row => row.ast.statements.some(n => ts.isFunctionDeclaration(n) && n.name?.text === driverName));
      const driver = owner.ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === driverName);
      // Moving an original top-level declaration into the complete driver preserves its exact initializer.
      const bodyAst = parse(driver.body.statements.map(n => n.getText(owner.ast)).join('\n'));
      actual.push(...declarations(bodyAst, owner.file));
    }
    if (family === 'process') expected = expected.filter(row => original.getLineAndCharacterOfPosition(row.node.getStart(original)).line + 1 < 10496);
    if (family === 'prompt') {
      const legacy = [
        ['WRITE_MODE', '--write', 'writeBaselineFiles'],
        ['PROBE_DIRECT_STORY_CLASSIFIER', '--probe-direct-story-classifier', 'runDirectStoryClassifierProbeCommand'],
        ['PROBE_LEGACY_VOCABULARY_POLICY', '--probe-legacy-vocabulary-policy', 'runLegacyVocabularyPolicyProbeCommand'],
        ['PROBE_PROMPT_POLICY_MANIFEST', '--probe-prompt-policy-manifest', 'runPromptPolicyManifestProbeCommand'],
        ['PROBE_BASELINE_DRIFT', '--probe-baseline-drift', 'runBaselineDriftProbeCommand'],
        ['PROBE_ROLE_MATRIX_SNAPSHOT_DRIFT', '--probe-role-matrix-snapshot-drift', 'runRoleMatrixSnapshotDriftProbeCommand'],
      ];
      const cliText = fs.readFileSync(dir + '/cli.mjs', 'utf8');
      for (const [name, flag, handler] of legacy) {
        assert.equal(expected.find(row => row.name === name)?.text, `${name} = process.argv.includes('${flag}')`);
        assert(cliText.includes(`['${flag}', ${handler}]`), 'legacy flag binding changed: ' + flag);
      }
      assert(cliText.includes('if (args.length === 1 && legacy.has(args[0])) { await legacy.get(args[0])(); return; }'));
      expected = expected.filter(row => !legacy.some(([name]) => name === row.name));
      const merged = declarations(historical('0836d73b7c', entry)).find(row => row.name === 'APPROVED_PROMPT_POLICY_MANIFEST');
      assert(merged, 'main policy lineage unavailable');
      expected = expected.map(row => row.name === merged.name ? { ...row, text: merged.text } : row);
    }
    expected = expected.map(row => {
      let text = row.text;
      if (family === 'prompt' && row.name === 'ROOT') text = text.replace("'..'", "'../..'");
      if (family === 'retired' && row.name === 'here') text = "here = join(dirname(fileURLToPath(import.meta.url)), '..')";
      if (family === 'process' && row.name === 'quotaFactSource') text = text.replace("'../packages/", "'../../packages/");
      if (family === 'quorum' && row.name === 'here') text = 'here = resolve(dirname(fileURLToPath(import.meta.url)), "..")';
      if (family === 'quorum' && row.name === 'harnessRelativePath') text = 'harnessRelativePath = relative(repoRoot, join(here, "red-B-e40f-quorum-submit-harness.mjs")).split(sep).join("/")';
      if (family === 'quorum' && row.name === 'selected') text = text.replace('parseHarnessCase(process.argv.slice(2))', 'parseHarnessCase(args)');
      if (family === 'retired' && row.name === 'legacyQuarantineFiles') {
        const found = actual.filter(item => item.name === row.name); assert.equal(found.length, 1);
        const values = node => node.initializer.arguments[0].elements.map(n => n.getText());
        const relocated = ['compatibility-controls', 'file-scan', 'positive-controls', 'public-contract', 'rule-data'].map(name => "'packages/main/src/tasks/retired-authority/" + name + ".ts'");
        assert.deepEqual(values(found[0].node).sort(), [...values(row.node).filter(value => value !== "'packages/main/src/tasks/retired-authority-vocabulary-guard-smoke.ts'"), ...relocated].sort());
        assert.equal(found[0].node.initializer.expression.getText(), 'Set');
        text = found[0].text;
      }
      return { ...row, text };
    });
    declarationControls(expected, actual, family.toUpperCase());
    console.log(family.toUpperCase() + '_TOP_LEVEL_PRESERVED ' + JSON.stringify({ declarations: expected.length, mutationControls: 2 }));
  } else throw new Error('Unknown preservation family: ' + family);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  for (const family of ['flow', 'planner', 'ledger', 'canonical', 'prompt', 'retired', 'process', 'quorum']) verifyTopLevelPreservation(family);
  console.log('MODULAR_TOP_LEVEL_PRESERVATION_GREEN');
}
