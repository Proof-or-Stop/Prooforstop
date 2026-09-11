#!/usr/bin/env node
// Recover two bounded regressions from preserved Labs against current source.
import './lab-source-loader.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
// Resolve the TypeScript closure only after the source loader has registered.
const {
  RUNTIME_ARTIFACT_REGISTRY: registry,
  findRuntimeArtifactEntry: find,
  normalizeRuntimeArtifactPath: normalize,
} = await import('../packages/main/src/core/runtime-artifact-registry.ts');

const groups = [];
function group(name, run) {
  try { groups.push({ name, pass: true, ...run() }); }
  catch (error) { groups.push({ name, pass: false, error: error.message }); }
}

// Independently freeze the former path semantics, including TWO non-idempotent
// normalization passes. Matcher order, registry mutation and regex state stay live.
const oldNormalize = path => path.replace(/\\/g, '/').replace(/^\.\//, '')
  .replace(/^\/+/, '').replace(/\/+$/, '');
function reference(path) {
  const first = oldNormalize(path);
  return registry.find(entry => entry.matchers.length > 0 && entry.matchers.some(matcher => {
    const value = oldNormalize(first);
    if (matcher.kind === 'exact') return value === oldNormalize(matcher.value);
    if (matcher.kind === 'prefix') {
      const base = oldNormalize(matcher.value);
      return value === base || value.startsWith(base + '/');
    }
    return matcher.value.test(value);
  }));
}

group('runtime-path-semantics', () => {
  const cases = ['', '././a', '///a///', 'a\\b', './././.proof-or-stop/runtime/a',
    'packages/main/src/actual.ts', '.proof-or-stop/story/actives/B-x/test-evidence.json'];
  for (const entry of registry) for (const matcher of entry.matchers) {
    if (typeof matcher.value !== 'string') continue;
    for (const value of [matcher.value, matcher.value + '/child', matcher.value + '-outside']) {
      for (const prefix of ['', './', '././', './././', '/', '\\']) cases.push(prefix + value);
    }
  }
  for (const path of cases) {
    assert.equal(normalize(path), oldNormalize(path), path);
    assert.equal(find(path)?.id, reference(path)?.id, path);
  }
  assert.equal(find('packages/main/src/actual.ts'), undefined);
  assert.equal(find('.proof-or-stop/story/actives/B-x/test-evidence.json'), undefined);
  const entry = { ...registry[0], id: 'reconcile-exact', matchers: [{ kind: 'exact', value: '././X' }] };
  const second = { ...entry, id: 'reconcile-second', matchers: [{ kind: 'exact', value: '././X' }] };
  registry.unshift(entry, second);
  try {
    assert.equal(find('./././X')?.id, entry.id);
    assert.equal(find('././././X'), undefined);
    registry.splice(0, 2, second, entry);
    assert.equal(find('./././X')?.id, second.id);
    entry.matchers[0].value = '__reconcile_changed__';
    assert.equal(find('__reconcile_changed__')?.id, entry.id);
    entry.matchers[0] = { kind: 'prefix', value: '__reconcile_prefix__' };
    assert.equal(find('__reconcile_prefix__/child')?.id, entry.id);
    entry.matchers[0].value = '__reconcile_new_prefix__';
    assert.equal(find('__reconcile_prefix__/child'), undefined);
    assert.equal(find('__reconcile_new_prefix__/child')?.id, entry.id);
    entry.matchers.push({ kind: 'exact', value: '__reconcile_pushed__' });
    assert.equal(find('__reconcile_pushed__')?.id, entry.id);
    entry.matchers.pop();
    assert.equal(find('__reconcile_pushed__'), undefined);
    entry.matchers = [];
    assert.equal(find('__reconcile_new_prefix__/child'), undefined);
  } finally { registry.splice(0, 2); }
  const regex = { ...registry[0], id: 'reconcile-regex', matchers: [{ kind: 'regexp', value: /^__reconcile_regex__$/g }] };
  registry.unshift(regex);
  try {
    assert.equal(find('__reconcile_regex__')?.id, regex.id);
    assert.equal(find('__reconcile_regex__'), undefined);
    assert.equal(find('__reconcile_regex__')?.id, regex.id);
  } finally { registry.shift(); }
  return { parityCases: cases.length, liveMutationAndRegexControls: true };
});

group('runtime-path-operation-budget', () => {
  find('packages/main/src/reconciliation-warm.ts');
  function count(path) {
    let calls = 0;
    const original = String.prototype.replace;
    try {
      String.prototype.replace = function (...args) { calls++; return Reflect.apply(original, this, args); };
      find(path);
    } finally { String.prototype.replace = original; }
    return calls;
  }
  const warm = count('packages/main/src/reconciliation-warm.ts');
  const cold = count('packages/main/src/reconciliation-unseen.ts');
  console.log('PATH_OPERATION_COUNTS ' + JSON.stringify({ warm, cold }));
  assert.ok(warm <= 8 && cold <= 8,
    `RUNTIME_PATH_NORMALIZATION_REPEATED_PER_MATCHER: warm=${warm}, cold=${cold}, bound=8`);
  return { warmReplaceCalls: warm, coldReplaceCalls: cold };
});

group('quorum-refusal-diagnostic-integrity', () => {
  // Execute the actual source helper with controlled collaborators. This is a
  // helper contract test, not a substitute for the real quorum integration case.
  const path = new URL('../packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts', import.meta.url);
  const parsed = ts.createSourceFile(String(path), readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const helper = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'assertQuorumRefuses');
  const laneStatement = parsed.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(declaration => declaration.name.getText(parsed) === 'REVIEW_LANES'));
  assert.ok(helper && laneStatement, 'current implementation helper and lane source exist');
  let events = 0, files = 0;
  const context = vm.createContext({ assert, STORY_ID: 'B-diagnostic-probe',
    hostVerdictEventCount: () => events, verdictFileCount: () => files });
  const executable = ts.transpileModule(laneStatement.getText(parsed) + '\n' + helper.getText(parsed), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText.replace(/^export /gm, '');
  vm.runInContext(executable + '\nglobalThis.testHelper = assertQuorumRefuses; globalThis.testLanes = REVIEW_LANES;', context);
  const lanes = Array.from(context.testLanes);
  const prefix = 'quorum_submit refuses: no current reviewer pass evidence for the required lanes';
  const execute = fn => context.testHelper({ get: () => fn }, {}, '/unused', 'diagnostic probe');
  const refusal = detail => () => { throw new Error(prefix + '\nDetails: ' + detail); };
  let controls = 0;
  const check = fn => { fn(); controls++; };
  check(() => assert.doesNotThrow(() => execute(refusal('missing current pass lane(s): ' + lanes.join(', ')))));
  check(() => assert.doesNotThrow(() => execute(refusal('missing current pass lane(s): ' + lanes[1]))));
  check(() => assert.throws(() => execute(() => {}), /Missing expected exception/));
  check(() => assert.throws(() => execute(() => { throw new Error('unrelated fault'); }),
    error => error.code === 'ERR_ASSERTION' && error.actual?.message === 'unrelated fault'));
  check(() => assert.throws(() => execute(() => { events++; throw new Error(prefix); }), /no host_verdict/));
  events = 0;
  check(() => assert.throws(() => execute(() => { files++; throw new Error(prefix); }), /no verdict files/));
  files = 0;
  check(() => assert.throws(() => execute(refusal('missing current pass lane(s): fabricated-reviewer')),
    /canonical reviewer lane/, 'Q022_DIAGNOSTIC_FALSE_GREEN: fabricated missing lane must be rejected'));
  check(() => assert.throws(() => execute(refusal('missing current pass lane(s): ' + [lanes[1], lanes[0]].join(', '))), /canonical order/));
  check(() => assert.throws(() => execute(refusal('missing current pass lane(s): ' + [lanes[1], lanes[1]].join(', '))), /duplicate-free/));
  check(() => assert.throws(() => execute(refusal('missing current pass lane(s): ')), /canonical reviewer lane/));
  check(() => assert.match(execute(refusal('missing current pass lane(s): ' + lanes[1])), /quorum_submit refuses/));
  return { controls };
});

console.log(JSON.stringify({ groups, boundary: 'Source-level helper and runtime path checks; not Story completion or elapsed Story performance.' }, null, 2));
const failed = groups.filter(row => !row.pass);
console.log(failed.length ? 'PENDING_RECONCILIATION_RED' : 'PENDING_RECONCILIATION_GREEN');
if (failed.length) process.exitCode = 1;
