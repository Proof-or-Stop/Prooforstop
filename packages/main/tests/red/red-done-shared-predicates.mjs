#!/usr/bin/env node
// B-212f: source-executed unit proof. The unchanged filesystem parity RED is
// the integration witness; this test isolates propagation and adapter wiring.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const machinePath = 'packages/main/src/core/machine.ts';
const oraclePath = 'packages/main/src/core/done-oracle.ts';
const verifierPath = 'scripts/verify-process-fact-contract.mjs';
const parse = text => ts.createSourceFile('proof.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const functionNode = (text, name) => parse(text).statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
const functionText = (text, name) => {
  const node = functionNode(text, name);
  assert.ok(node?.body, `missing production function ${name}`);
  return node.getText();
};

// F027: execute the real serializer, envelope integrity, signatures and prior
// selector, without importing a potentially stale dist build. Keep these pure
// modules in the same realm: canonical JSON deliberately rejects foreign object
// prototypes. No review eligibility, integrity, or signature result is mocked.
export function runPromptEnvelopeSnapshotProof(reviewSource = readFileSync('packages/main/src/core/review-run.ts', 'utf8')) {
  const nativeRequire = createRequire(import.meta.url);
  const modules = new Map();
  const load = path => {
    path = resolve(path);
    if (modules.has(path)) return modules.get(path);
    const exports = {};
    modules.set(path, exports);
    const source = ts.transpileModule(readFileSync(path, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const require = specifier => specifier.startsWith('.')
      ? load(resolve(dirname(path), specifier.replace(/\.js$/, '.ts')))
      : nativeRequire(specifier);
    new Function('exports', 'require', source)(exports, require);
    return exports;
  };
  const contracts = load('packages/main/src/core/prompt-contracts.ts');
  const bindings = {
    ...contracts,
    ...load('packages/main/src/core/digest.ts'),
    ...load('packages/main/src/core/agent-role-identity.ts'),
    createHash: nativeRequire('node:crypto').createHash,
  };
  const envelopeSource = readFileSync('packages/main/src/core/prompt-envelope.ts', 'utf8');
  const passSource = readFileSync('packages/main/src/core/finding-verify.ts', 'utf8');
  const incrementalSource = readFileSync('packages/main/src/core/review-incremental-context.ts', 'utf8');
  const constantText = (source, name) => parse(source).statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(declaration => declaration.name.getText() === name)).getText();
  const parts = [constantText(reviewSource, 'REVIEW_RUN_SALT'), constantText(passSource, 'REVIEW_PASS_SALT')];
  for (const [source, names] of [
    [reviewSource, ['snapshotPromptEnvelopes', 'signReviewRun', 'verifyReviewRun']],
    [envelopeSource, ['promptEnvelopeSemanticValue', 'computePromptEnvelopeId', 'verifyPromptEnvelopeIntegrity']],
    [passSource, ['signReviewPass', 'verifyReviewPass']],
    [incrementalSource, ['verdictTime', 'latestTrustedPriorPass']],
  ]) for (const name of names) parts.push(functionText(source, name));
  parts.push('export { latestTrustedPriorPass };');
  const compiled = ts.transpileModule(parts.join('\n'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const api = {};
  new Function(...Object.keys(bindings), 'exports', compiled)(...Object.values(bindings), api);
  const digest = 'a'.repeat(64);
  const assembledPrompt = 'F027 signed prior reviewer prompt';
  const role = 'proof-or-stop-review-test-coverage';
  const envelope = {
    schemaVersion: 'proof-or-stop.prompt-envelope.v1', envelopeId: digest,
    roleId: role, lane: role, storyId: 'B-probe', dispatchKind: 'review-run',
    reviewRunId: 'B-probe:RR-001', reviewRound: 'round-1', createdAt: '2026-09-05T00:00:00.000Z',
    headHash: 'b'.repeat(40), materialHash: digest, storyFilesHash: digest,
    runtimeContractVersion: '1', roleContractVersion: '1', contextMode: 'full', eligibilityDecision: 'full',
    assemblerVersion: '1', dispatchProtocolVersion: '1', tokenEstimatorVersion: '1', bytes: 10, lines: 1, estimatedTokens: 3,
    ...Object.fromEntries(['runtimeSemanticDigest', 'runtimeRenderDigest', 'roleSemanticDigest', 'roleRenderDigest',
      'contextDigest', 'eligibilityDigest', 'knownExecutionEnvironmentDigest', 'launcherSpecDigest', 'commandPolicyDigest',
      'dispatchPromptDigest', 'hostRenderIdentityDigest'].map(key => [key, digest])),
    assembledPromptDigest: contracts.domainSeparatedDigest('assembled-prompt.raw-utf8.v1', assembledPrompt),
  };
  const seal = value => ({ ...value, envelopeId: api.computePromptEnvelopeId(value) });
  const prior = value => {
    const run = {
      storyId: value.storyId, reviewRunId: value.reviewRunId, agent: role, lane: role, reviewRound: value.reviewRound,
      startedAt: value.createdAt, headHash: value.headHash, materialHash: value.materialHash,
      storyFilesHash: value.storyFilesHash, promptHash: value.assembledPromptDigest, envelopeId: value.envelopeId, assembledPrompt,
    };
    run._hash = api.signReviewRun(run.storyId, run.reviewRunId, run.agent, run.lane, run.reviewRound,
      run.startedAt, run.headHash, run.materialHash, run.promptHash, undefined, undefined, run.storyFilesHash, run.envelopeId);
    const pass = {
      id: 'RP-001', agent: role, note: 'signed prior pass', createdAt: '2026-09-05T00:01:00.000Z',
      reviewRound: run.reviewRound, reviewRunId: run.reviewRunId, envelopeId: run.envelopeId, writerSessionId: 'fixture-reviewer',
    };
    pass._hash = api.signReviewPass(value.storyId, pass.id, role, pass.note, pass.createdAt, pass.reviewRound,
      pass.reviewRunId, undefined, undefined, undefined, { writerSessionId: pass.writerSessionId }, pass.envelopeId);
    assert.equal(api.verifyReviewRun(run), true, 'fixture has a real valid run signature');
    assert.equal(api.verifyReviewPass(value.storyId, pass), true, 'fixture has a real envelope-bound pass signature');
    return envelopes => api.latestTrustedPriorPass({}, value.storyId, role, [pass], [run], undefined, undefined, envelopes)?.pass.id ?? null;
  };
  const projection = [{ id: 'F-001', createdAt: envelope.createdAt, status: 'resolved', severity: 'low', category: 'missing', desc: 'fixture' }];
  const withProjection = rows => ({ findingProjection: rows,
    findingProjectionDigest: contracts.domainSeparatedDigest('prompt-finding-projection.v1', rows) });
  for (const [name, optional] of [
    ['legacy absent fields', { schemaVersion: 'proofbound.prompt-envelope.v1' }],
    ['current absent fields', {}], ['absent projection', { eligibilityReasonCodes: [] }],
    ['absent reasons', withProjection([])],
    ['empty arrays', { eligibilityReasonCodes: [], ...withProjection([]) }],
    ['populated arrays', { eligibilityReasonCodes: ['SAFETY_REQUIRES_FULL'], ...withProjection(projection) }],
  ]) {
    const raw = seal({ ...envelope, ...optional });
    const select = prior(raw);
    assert.equal(api.verifyPromptEnvelopeIntegrity(raw), true, `${name}: raw integrity control`);
    assert.equal(select([raw]), 'RP-001', `${name}: raw trusted-prior control`);
    const snapshot = api.snapshotPromptEnvelopes([raw]);
    const observed = { rawIntegrity: true, rawPrior: 'RP-001', snapshotIntegrity: api.verifyPromptEnvelopeIntegrity(snapshot[0]), snapshotPrior: select(snapshot) };
    console.log(`F027 ${name}: ${JSON.stringify(observed)}`);
    assert.equal(observed.snapshotIntegrity, true, `${name}: snapshot must preserve canonical envelope integrity`);
    assert.equal(observed.snapshotPrior, 'RP-001', `${name}: snapshot must preserve trusted prior selection`);
    assert.equal(api.computePromptEnvelopeId(snapshot[0]), raw.envelopeId, `${name}: semantic digest unchanged`);
    assert.deepEqual(Reflect.ownKeys(snapshot[0]), Reflect.ownKeys(raw), `${name}: absence is not own undefined`);
    assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot[0]));
    assert.notEqual(snapshot[0], raw);
    for (const key of ['eligibilityReasonCodes', 'findingProjection']) if (Array.isArray(raw[key])) {
      assert.notEqual(snapshot[0][key], raw[key]);
      assert.ok(Object.isFrozen(snapshot[0][key]));
      assert.throws(() => snapshot[0][key].push('mutation'), TypeError);
      if (key === 'findingProjection' && raw[key].length) {
        assert.notEqual(snapshot[0][key][0], raw[key][0]);
        assert.ok(Object.isFrozen(snapshot[0][key][0]));
        raw[key][0].desc = 'store changed after snapshot';
        assert.equal(snapshot[0][key][0].desc, 'fixture');
      }
      raw[key].push('store changed after snapshot');
      assert.equal(api.verifyPromptEnvelopeIntegrity(snapshot[0]), true, `${name}: store mutation cannot alter snapshot`);
    }
  }
  for (const key of ['eligibilityReasonCodes', 'findingProjection']) for (const bad of [undefined, null, 'invalid', 42, [null], [undefined], [42]]) {
    const raw = { ...seal(envelope), [key]: bad };
    const snapshot = api.snapshotPromptEnvelopes([raw]);
    assert.ok(Object.hasOwn(snapshot[0], key), `${key}: explicit malformed property must not disappear`);
    assert.deepEqual(snapshot[0][key], bad, `${key}: malformed value must not be sanitized`);
    assert.equal(api.verifyPromptEnvelopeIntegrity(raw), false);
    assert.equal(api.verifyPromptEnvelopeIntegrity(snapshot[0]), false, `${key}: malformed snapshot fails closed`);
    assert.equal(prior(raw)(snapshot), null, `${key}: malformed envelope cannot become a trusted prior`);
  }
  const tampered = { ...seal(envelope), contextDigest: 'c'.repeat(64) };
  assert.equal(api.verifyPromptEnvelopeIntegrity(api.snapshotPromptEnvelopes([tampered])[0]), false, 'snapshot cannot re-sign tampered evidence');
  console.log('F027 prompt-envelope snapshot preserves absent fields, signatures, trusted prior and mutation isolation');
}
const tokens = text => {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const result = [];
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) result.push(scanner.getTokenText());
  return result.join(' ');
};

// Deliberately finite adapter syntax, not an assertion of arbitrary TypeScript
// semantic equivalence. Changing this boundary requires an explicit contract edit.
export function checkSharedDoneAdapterSources(machineSource, oracleSource) {
  const errors = [];
  const same = (actual, expected, label) => {
    if (!actual || tokens(actual) !== tokens(expected)) errors.push(`${label}: shared DONE adapter shape changed`);
  };
  same(functionNode(machineSource, 'canFinishGuard')?.body?.getText(),
    '{ return firstDonePredicateFailure(context) === null; }', 'canFinishGuard');
  same(functionNode(machineSource, 'firstDonePredicateFailure')?.body?.getText(),
    '{ for (const result of evaluateDonePredicates(context)) { if (!result.ok) return result; } return null; }', 'firstDonePredicateFailure');
  same(functionNode(machineSource, 'donePredicate')?.body?.getText(),
    '{ return { id, oracleRowId, value, ok: failureReason === null, failureReason }; }', 'donePredicate');
  const reason = functionNode(machineSource, 'getGuardFailureReason');
  const phaseDispatch = reason?.body?.statements.map(node => ts.isIfStatement(node)
    ? tokens(node.expression.getText()) : tokens(node.getText()));
  const expectedDispatch = ['INIT_CHECK', 'PLAN', 'DEV', 'REVIEW', 'TEST', 'DONE'].map(phase => tokens(`targetPhase === '${phase}'`));
  expectedDispatch.push(tokens('return null;'));
  if (JSON.stringify(phaseDispatch) !== JSON.stringify(expectedDispatch)) errors.push('DONE diagnostic: phase dispatch skeleton changed');
  const done = reason?.body?.statements.filter(node => ts.isIfStatement(node)
    && tokens(node.expression.getText()) === tokens("targetPhase === 'DONE'")) ?? [];
  if (done.length !== 1) errors.push('DONE diagnostic: expected one direct DONE branch');
  else same(done[0].thenStatement.getText(),
    '{ return firstDonePredicateFailure({ storyId, store, projectRoot: projectRoot ?? process.cwd(), ...(gitCwd ? { gitCwd } : {}) })?.failureReason ?? null; }',
    'DONE diagnostic');
  const build = functionNode(oracleSource, 'buildDoneChecklist');
  const declaration = build?.body?.statements.filter(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(entry => entry.name.getText() === 'donePredicates')) ?? [];
  if (declaration.length !== 1) errors.push('oracle inputs: expected one direct shared evaluation');
  else {
    const supported = [
      'const donePredicates = [...evaluateDonePredicates({ storyId, store, projectRoot: root, gitCwd })];',
      'const donePredicates = completedSnapshot ? null : [...evaluateDonePredicates({ storyId, store, projectRoot: root, gitCwd })];',
    ];
    if (!supported.some(source => tokens(source) === tokens(declaration[0].getText()))) errors.push('oracle inputs: shared DONE adapter shape changed');
  }
  const historical = build?.body?.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(entry => entry.name.getText() === 'completedSnapshot'));
  if (historical) same(historical.getText(),
    "const completedSnapshot = store.readStory(storyId).phase === 'DONE' ? options.completedSnapshot : undefined;", 'historical boundary');
  const returns = [];
  const visit = node => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) returns.push(node);
    ts.forEachChild(node, visit);
  };
  if (build?.body) ts.forEachChild(build.body, visit);
  if (returns.length !== 1 || returns[0] !== build?.body?.statements.at(-1)) errors.push('oracle return: expected exactly one final return');
  else same(returns[0].getText(), historical
    ? 'return completedSnapshot ? rows : projectDonePredicateRows(rows, donePredicates!);'
    : 'return projectDonePredicateRows(rows, donePredicates);', 'oracle return');
  const checkReferences = node => {
    if (ts.isIdentifier(node) && node.text === 'donePredicates') {
      const parent = node.parent;
      const declarationName = ts.isVariableDeclaration(parent) && parent.name === node;
      const call = ts.isNonNullExpression(parent) ? parent.parent : parent;
      const consumed = ts.isCallExpression(call)
        && ['donePredicateValue', 'projectDonePredicateRows'].includes(call.expression.getText())
        || ts.isConditionalExpression(parent) && parent.condition === node
        || ts.isIfStatement(parent) && parent.expression === node;
      if (!declarationName && !consumed) errors.push('oracle outcomes: shared results may only be read by the value accessor or final projector');
    }
    ts.forEachChild(node, checkReferences);
  };
  if (build?.body) checkReferences(build.body);
  const imports = parse(oracleSource).statements.filter(ts.isImportDeclaration);
  if (!imports.some(node => node.moduleSpecifier.text === './machine.js'
    && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
    && node.importClause.namedBindings.elements.some(entry => entry.name.text === 'evaluateDonePredicates' && !entry.propertyName))) {
    errors.push('oracle import: shared evaluator must come directly from machine.js');
  }
  return errors;
}

function legacyBypassWitness(verifierSource) {
  const begin = verifierSource.indexOf('function collectLiteralDoneBlockerCodes(');
  const end = verifierSource.indexOf('function assertDonePreflightPredicateInventoryParity(');
  assert.ok(begin >= 0 && end > begin, 'legacy production checker extraction unavailable');
  const sandbox = { ts, machinePath, doneOraclePath: oraclePath, processFactRegistryPath: 'registry.ts' };
  vm.runInNewContext(verifierSource.slice(begin, end), sandbox);
  const mapping = { blockerCode: 'future_done_predicate', processFactName: 'probe', oracleRowId: 'test-evidence' };
  const registry = new Map([['probe', { level: 'L4', semantics: ['gate-evidence'] }]]);
  const row = "doneBlockerRow('future_done_predicate','test-evidence',{id:'test-evidence',status:'fail'})";
  const probes = [
    ['F-005/F-006 same reader, different root/story arguments',
      "const f=readDevMemoryFinishDecision(rootA,storyId);if(!f)return '[future_done_predicate]';",
      `const f=readDevMemoryFinishDecision(rootB,'B-wrong');if(!f)rows.push(${row});`],
    ['F-007 opposite outer paths',
      "if(storyId.length>0){if(Boolean(storyId))return '[future_done_predicate]';}",
      `if(storyId.length===0){if(Boolean(storyId))rows.push(${row});}`],
    ['F-007 discarded blocker result',
      "if(Boolean(storyId))return '[future_done_predicate]';",
      `if(Boolean(storyId))rows.push((${row},doneCheckRow({id:'test-evidence',status:'pass'})));`],
  ];
  for (const [name, machineBody, oracleBody] of probes) {
    const errors = sandbox.checkDonePreflightPredicateInventory({
      machineSource: `function getGuardFailureReason(targetPhase,storyId){if(targetPhase==='DONE'){${machineBody}}}`,
      doneOracleSource: `function buildDoneChecklist(storyId){const rows=[];${oracleBody}return rows;}`,
      mappings: [mapping], registry,
    });
    assert.equal(errors.length, 0, `${name}: historical bypass no longer matches its witness: ${JSON.stringify(errors)}`);
    console.error(`RED reproduced ${name}: production checker incorrectly returned errors: []`);
  }
}

function fixture() {
  return {
    phase: 'TEST',
    evidence: { result: 'PASS', output: 'legacy passing evidence', timestamp: 'fixture' },
    bugs: { bugs: [] }, finish: { decision: 'no-reusable-lesson' },
    delivery: { ok: true, code: 'ok', reason: 'valid delivery', deliveryCheck: { docsPromises: [] } },
    live: { ok: true, status: 'absent', reason: 'absent' }, review: { ok: true },
    escalation: { ok: true, required: false, assuranceLevel: 'local', trigger: { countableProblems: [], requiredProblemCount: 2 } },
    floor: { ok: true, required: false, assuranceLevel: 'local', materialCodePaths: [], localRounds: { validRounds: [], requiredRounds: 0 } },
  };
}

function productionConsumers(machineSource, oracleSource, state) {
  const calls = [];
  const store = {
    readTestEvidence: id => { calls.push(['test', id]); return state.evidence; },
    readBugs: id => { calls.push(['bugs', id]); return state.bugs; },
    readStory: () => ({ phase: state.phase }), readChecklist: () => ({ items: [] }),
    readDeclaredArtifacts: () => ({ entries: [] }),
  };
  const exported = {};
  const sandbox = {
    exports: exported, process: { cwd: () => 'ROOT' },
    acceptanceCompletionBlocker: (inputStore, id, root) => { assert.equal(inputStore, store); assert.equal(id, 'B-probe'); assert.equal(root, 'GIT'); return state.amendment ?? null; },
    readDevMemoryFinishDecision: (root, id) => { calls.push(['finish', root, id]); return root === 'ROOT' && id === 'B-probe' ? state.finish : null; },
    evaluateDeliveryCheckFreshness: (id, inputStore, gitCwd, root) => { calls.push(['delivery', id, gitCwd, root]); return state.delivery; },
    evaluateOptionalLiveSmokeTranscript: () => state.live,
    deliveryPromiseBlocksDone: promise => promise.status === 'unverified',
    evaluateReviewVerdict: (context, options) => { calls.push(['review', context.projectRoot, context.storyId, context.gitCwd]); return options?.completedSnapshot ? state.historicalReview ?? state.review : state.review; },
    evaluateReviewEscalation: context => { calls.push(['escalation', context.projectRoot, context.storyId, context.gitCwd]); return context.materialHash === 'historical-material' ? state.historicalEscalation ?? state.escalation : state.escalation; },
    evaluateReviewAssuranceFloor: context => { calls.push(['floor', context.projectRoot, context.storyId, context.gitCwd]); return context.materialHash === 'historical-material' ? state.historicalFloor ?? state.floor : state.floor; },
    formatReviewEscalationFailure: value => `Cannot enter DONE: ${value.reason ?? 'escalation'} [review_escalation]`,
    formatReviewAssuranceFloorFailure: value => `Cannot enter DONE: ${value.reason ?? 'floor'} [review_assurance_floor]`,
    resolveGitCwd: () => 'GIT',
    checkEvidenceHashSnapshotReuse: () => ({ reusable: false }),
    captureEvidenceHashSnapshot: () => ({ materialHash: 'material', storyFilesHash: 'story-files' }),
    loadConfig: () => ({}), resolveWorkflowPolicy: () => ({ done: { requireSummary: 'none' }, test: {} }),
    checkEvidenceFreshness: () => ({ fresh: true, message: 'fresh' }),
    evaluateDoneRequiredEvidence: () => ({ status: 'pass', required: false, blocking: false, detail: 'not required' }),
    readGitStatusLines: () => ({ ok: true, lines: [] }), checkMainDivergence: () => ({ needsSync: false }),
    renderReviewAssuranceGuidanceSummary: () => '', buildReviewEscalationGuidance: () => ({}), buildReviewAssuranceFloorGuidance: () => ({}),
    storyRequiresCodexEvidence: () => false,
  };
  const machineFunctions = ['donePredicate', 'evaluateDonePredicates', 'firstDonePredicateFailure', 'donePredicateValue', 'canFinishGuard', 'getGuardFailureReason'];
  const oracleFunctions = ['doneCheckRow', 'projectDonePredicateRows', 'buildDoneChecklist'];
  // Existing presentation helper is optional after the architecture replacement.
  if (functionNode(oracleSource, 'doneBlockerRow')) oracleFunctions.push('doneBlockerRow');
  const source = machineFunctions.map(name => functionText(machineSource, name)).join('\n')
    + '\n' + oracleFunctions.map(name => functionText(oracleSource, name)).join('\n');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(compiled, sandbox);
  return { api: exported, store, calls, context: { storyId: 'B-probe', store, projectRoot: 'ROOT', gitCwd: 'GIT' } };
}

export function runSharedDonePredicateProof(machineSource = readFileSync(machinePath, 'utf8'), oracleSource = readFileSync(oraclePath, 'utf8'), verifierSource = readFileSync(verifierPath, 'utf8')) {
  if (!functionNode(machineSource, 'evaluateDonePredicates')) {
    legacyBypassWitness(verifierSource);
    throw new Error('shared evaluator absent; historical bypass witnesses above prove the remaining defect');
  }
  assert.deepEqual(checkSharedDoneAdapterSources(machineSource, oracleSource), []);
  const cases = [
    ['all-pass', () => {}, null, null],
    ['amendment pending', f => { f.amendment = 'Acceptance amendment pending: AM-1 APPLYING'; }, 'acceptance-amendment', 'acceptance_amendment_blocked'],
    ['amendment invalid', f => { f.amendment = 'Acceptance amendment signature invalid'; }, 'acceptance-amendment', 'acceptance_amendment_blocked'],
    ['test missing', f => { f.evidence = null; }, 'test-evidence', 'no test evidence'],
    ['test failed', f => { f.evidence.result = 'FAIL'; }, 'test-evidence', 'test FAIL'],
    ['bug open', f => { f.bugs.bugs = [{ id: 'BUG-1', status: 'open' }]; }, 'bugs-fixed', 'unfixed bug'],
    ['legacy bug status', f => { f.bugs.bugs = [{ id: 'BUG-1', status: 'unknown' }]; }, 'bugs-fixed', 'unfixed bug'],
    ['finish missing or malformed', f => { f.finish = null; }, 'dev-memory-finish-decision', 'missing_dev_memory_finish_decision'],
    ['delivery missing', f => { f.delivery = { ok: false, code: 'missing_delivery_check', reason: 'missing', deliveryCheck: null }; }, 'delivery-check', 'missing_delivery_check'],
    ['delivery tampered', f => { Object.assign(f.delivery, { ok: false, code: 'delivery_check_tampered', reason: 'tampered' }); }, 'delivery-check', 'delivery_check_tampered'],
    ...[undefined, null, {}, [null], [3]].map(value => [`rejected malformed delivery ${JSON.stringify(value)}`, f => {
      Object.assign(f.delivery, { ok: false, code: 'delivery_check_tampered', reason: 'tampered', deliveryCheck: { docsPromises: value } });
    }, 'delivery-check', 'delivery_check_tampered']),
    ['delivery stale', f => { Object.assign(f.delivery, { ok: false, code: 'stale_delivery_check', reason: 'stale' }); }, 'delivery-check', 'stale_delivery_check'],
    ['live smoke failed', f => { f.live = { ok: false, status: 'failed', reason: 'failed smoke' }; }, 'live-smoke-transcript', 'live_smoke_transcript_failed'],
    ['promise unresolved', f => { f.delivery.deliveryCheck.docsPromises = [{ docPath: 'promise.md', status: 'unverified' }]; }, 'delivery-check', 'unverified_promise'],
    ['review stale', f => { f.review = { ok: false, code: 'review_evidence_invalid', message: 'diff_pack_changed' }; }, 'review-verdict', 'stale_closeout_review'],
    ['review dynamic', f => { f.review = { ok: false, code: 'review_lane_missing', message: 'missing lane' }; }, 'review-verdict', 'review_lane_missing'],
    ['escalation rejected', f => { Object.assign(f.escalation, { ok: false, required: true, reason: 'missing host' }); }, 'review-escalation', 'review_escalation'],
    ['assurance rejected', f => { Object.assign(f.floor, { ok: false, required: true, reason: 'missing round' }); }, 'review-assurance-floor', 'review_assurance_floor'],
  ];
  for (const [name, change, rowId, diagnostic] of cases) {
    const state = fixture(); change(state);
    const { api, context, store, calls } = productionConsumers(machineSource, oracleSource, state);
    const before = JSON.stringify(state);
    assert.equal(api.canFinishGuard(context), rowId === null, `${name}: boolean gate`);
    const reason = api.getGuardFailureReason('B-probe', store, 'DONE', 'ROOT', 'GIT');
    if (diagnostic) assert.ok(reason?.includes(diagnostic), `${name}: diagnostic ${reason}`);
    else assert.equal(reason, null);
    const rows = api.buildDoneChecklist('B-probe', store, 'ROOT', { gitCwd: 'GIT' });
    if (rowId) assert.ok(rows.some(row => row.id === rowId && row.status === 'fail' && row.blocking), `${name}: emitted oracle rows ${JSON.stringify(rows)}`);
    else assert.ok(rows.every(row => !row.blocking), 'all-pass: oracle control');
    assert.equal(JSON.stringify(state), before, `${name}: readers must not mutate evidence`);
    for (const call of calls.filter(call => ['finish', 'review', 'escalation', 'floor'].includes(call[0]))) {
      assert.equal(call[1], 'ROOT', `${name}: correct metadata root`);
      assert.equal(call[2], 'B-probe', `${name}: correct story`);
    }
  }
  console.log(`GREEN shared DONE predicates: ${cases.length} production-consumer fixture cases`);

  const early = fixture(); early.evidence = null;
  const first = productionConsumers(machineSource, oracleSource, early);
  assert.equal(first.api.canFinishGuard(first.context), false);
  assert.equal(first.calls.length, 1, 'failed first predicate must not read downstream artifacts');
  const precedence = fixture();
  precedence.live = { ok: false, status: 'failed', reason: 'failed smoke' };
  Object.assign(precedence.delivery, { ok: false, code: 'delivery_check_tampered' });
  let witness = productionConsumers(machineSource, oracleSource, precedence);
  assert.match(witness.api.getGuardFailureReason('B-probe', witness.store, 'DONE', 'ROOT', 'GIT'), /live_smoke_transcript_failed/);
  precedence.delivery.deliveryCheck = null;
  witness = productionConsumers(machineSource, oracleSource, precedence);
  assert.match(witness.api.getGuardFailureReason('B-probe', witness.store, 'DONE', 'ROOT', 'GIT'), /missing_delivery_check/);
  console.log('GREEN shared DONE predicates: lazy first failure and legacy diagnostic precedence');

  const generator = functionNode(machineSource, 'evaluateDonePredicates');
  const offset = generator.body.getStart() + 1;
  const future = machineSource.slice(0, offset)
    + "\n yield donePredicate('future-done-predicate', 'future-done-predicate', null, 'Cannot enter DONE: future predicate rejected. [future_done_predicate]');\n"
    + machineSource.slice(offset);
  const futureWitness = productionConsumers(future, oracleSource, fixture());
  assert.equal(futureWitness.api.canFinishGuard(futureWitness.context), false);
  assert.match(futureWitness.api.getGuardFailureReason('B-probe', futureWitness.store, 'DONE', 'ROOT', 'GIT'), /future_done_predicate/);
  const futureRows = futureWitness.api.buildDoneChecklist('B-probe', futureWitness.store, 'ROOT', { gitCwd: 'GIT' });
  assert.ok(futureRows.some(row => row.id === 'future-done-predicate' && row.blocking && row.status === 'fail' && row.detail.includes('future_done_predicate')));
  console.log('GREEN shared DONE predicates: new predicate automatically reaches boolean, diagnostic, and emitted oracle row');

  const projectionCall = `projectDonePredicateRows(rows, donePredicates${oracleSource.includes('donePredicates!') ? '!' : ''})`;
  const discardedOracle = oracleSource.replace(projectionCall, `(${projectionCall}, rows)`);
  const skippedOracle = oracleSource.replace('const donePredicates = ', 'const donePredicates = storyId.length === 0 ? ')
    .replace(' })];', ' })] : [];');
  const adapterMutants = [
    ['wrong root', oracleSource.replace('projectRoot: root, gitCwd', "projectRoot: 'WRONG', gitCwd")],
    ['wrong story', oracleSource.replace('evaluateDonePredicates({ storyId, store', "evaluateDonePredicates({ storyId: 'B-wrong', store")],
    ['opposite outer path', skippedOracle],
    ['discarded projection result', discardedOracle],
    ['early return before projection', oracleSource.replace('const rows: DoneCheckRow[] = [];', 'const rows: DoneCheckRow[] = []; if (storyId) return rows;')],
    ['cleared shared outcomes', oracleSource.replace(projectionCall, `(donePredicates!.length = 0, ${projectionCall})`)],
    ...(oracleSource.includes('const completedSnapshot =') ? [
      ['historical exemption escaped into TEST', oracleSource.replace("phase === 'DONE' ? options.completedSnapshot", "phase === 'TEST' ? options.completedSnapshot")],
    ] : []),
  ];
  for (const [name, mutant] of adapterMutants) {
    assert.notEqual(mutant, oracleSource, `${name}: live mutation point`);
    assert.ok(checkSharedDoneAdapterSources(machineSource, mutant).length > 0, `${name}: adapter mutation must be rejected`);
  }
  // A projection implementation that discards a failure must also fail at runtime,
  // independently of adapter syntax checking.
  const goodRows = [{ id: 'future-done-predicate', status: 'pass', blocking: false, detail: 'old presentation', label: 'future', source: 'fixture' }];
  const failures = [...futureWitness.api.evaluateDonePredicates(futureWitness.context)].filter(row => !row.ok);
  const projected = futureWitness.api.projectDonePredicateRows(goodRows, failures);
  assert.ok(projected[0].blocking && projected[0].status === 'fail');
  assert.equal(goodRows[0].status, 'pass', 'projection leaves caller presentation untouched');
  console.log('GREEN shared DONE predicates: root/story/outer-path/discarded-result adapter mutations rejected');

  const snapshotState = fixture(); snapshotState.finish = null;
  const snapshotWitness = productionConsumers(machineSource, oracleSource, snapshotState);
  const snapshotRows = snapshotWitness.api.buildDoneChecklist('B-probe', snapshotWitness.store, 'ROOT', {
    gitCwd: 'GIT', completedSnapshot: { materialHash: 'historical-material', storyFilesHash: 'historical-story' },
  });
  assert.ok(snapshotRows.some(row => row.id === 'dev-memory-finish-decision' && row.blocking && row.status === 'fail'),
    'completedSnapshot must not downgrade a live shared failure');
  for (const phase of ['TEST', 'DONE']) {
    const historical = fixture(); historical.phase = phase;
    historical.bugs.bugs = [{ id: 'legacy-status', status: 'unknown' }];
    historical.historicalEscalation = historical.escalation;
    historical.historicalFloor = historical.floor;
    historical.review = { ok: false, code: 'review_evidence_invalid', message: 'diff_pack_changed' };
    historical.escalation = { ...historical.escalation, ok: false, required: true, reason: 'current material drift' };
    historical.floor = { ...historical.floor, ok: false, required: true, reason: 'current material drift' };
    const h = productionConsumers(machineSource, oracleSource, historical);
    const options = { gitCwd: 'GIT', completedSnapshot: { materialHash: 'historical-material', storyFilesHash: 'historical-story' } };
    const rows = h.api.buildDoneChecklist('B-probe', h.store, 'ROOT', options);
    const oracleReviewCalls = h.calls.filter(call => call[0] === 'review').length;
    assert.equal(rows.find(row => row.id === 'bugs-fixed')?.blocking, phase === 'TEST',
      `${phase}: legacy bug statuses retain historical presentation while active admission requires fixed`);
    for (const id of ['review-verdict', 'review-escalation', 'review-assurance-floor']) {
      const row = rows.find(row => row.id === id);
      assert.equal(row?.blocking, phase === 'TEST', `${phase}: ${id} uses the correct material domain`);
    }
    assert.equal(h.api.canFinishGuard(h.context), false, `${phase}: default guard remains live-strict`);
    const injected = productionConsumers(future, oracleSource, historical);
    assert.equal(injected.api.buildDoneChecklist('B-probe', injected.store, 'ROOT', options)
      .some(row => row.id === 'future-done-predicate' && row.blocking), phase === 'TEST', `${phase}: future admission predicates are generic, historical presentation is not admission`);
    if (phase === 'DONE') {
      assert.equal(oracleReviewCalls, 0, 'historical query must not silently rerun live reviewer eligibility');
      const info = rows.find(row => row.id === 'review-verdict');
      assert.equal(info.status, 'warn');
      assert.match(info.detail, /not a fresh reviewer PASS/);
    }
    historical.review = { ok: false, code: 'review_evidence_invalid', message: 'invalid signature after material drift' };
    const invalid = productionConsumers(machineSource, oracleSource, historical);
    assert.equal(invalid.api.buildDoneChecklist('B-probe', invalid.store, 'ROOT', options)
      .some(row => row.id === 'review-verdict' && row.blocking), phase === 'TEST', `${phase}: historical row is not a newly asserted reviewer audit`);
    historical.historicalEscalation = { ...historical.historicalEscalation, ok: false, required: true, reason: 'missing historical host evidence' };
    const missing = productionConsumers(machineSource, oracleSource, historical);
    assert.ok(missing.api.buildDoneChecklist('B-probe', missing.store, 'ROOT', options)
      .some(row => row.id === 'review-escalation' && row.blocking), `${phase}: existing assurance integrity remains blocking`);
  }
  console.log('GREEN historical DONE presentation: original assurance preserved; no new reviewer PASS/audit; TEST future predicates remain strict');
  if (oracleSource.includes('const completedSnapshot =')) {
    const escaped = productionConsumers(future, oracleSource.replace("phase === 'DONE' ? options.completedSnapshot", "phase === 'TEST' ? options.completedSnapshot"), fixture());
    assert.throws(() => {
      const rows = escaped.api.buildDoneChecklist('B-probe', escaped.store, 'ROOT', {
        gitCwd: 'GIT', completedSnapshot: { materialHash: 'historical-material' },
      });
      assert.ok(rows.some(row => row.id === 'future-done-predicate' && row.blocking), 'TEST must consume every future admission predicate');
    }, { name: 'AssertionError' }, 'executable historical-phase escape mutation is killed');
  }
  const stricter = [{ id: 'test-evidence', status: 'fail', blocking: true, detail: 'stricter preflight', source: 'fixture', label: 'test' }];
  const strictWitness = productionConsumers(machineSource, oracleSource, fixture());
  const strictProjection = strictWitness.api.projectDonePredicateRows(stricter, [...strictWitness.api.evaluateDonePredicates(strictWitness.context)]);
  assert.equal(strictProjection[0].blocking, true, 'shared pass must preserve stricter preflight failure');
  const multiple = strictWitness.api.projectDonePredicateRows(stricter, [
    { id: 'first', oracleRowId: 'test-evidence', ok: false, failureReason: '[future_first_blocker]' },
    { id: 'second', oracleRowId: 'test-evidence', ok: false, failureReason: '[future_second_blocker]' },
  ]);
  assert.ok(multiple[0].detail.includes('stricter preflight') && multiple[0].detail.includes('future_first_blocker') && multiple[0].detail.includes('future_second_blocker'),
    'all shared blocker codes remain observable when predicates reuse an already failing row');

  // Execute actual corrupted consumer functions and confirm the behavioral
  // assertion rejects their false pass. Shape checking alone is insufficient.
  const runtimeMutants = [
    ['inverted boolean outcome', future.replace('return firstDonePredicateFailure(context) === null;', 'return firstDonePredicateFailure(context) !== null;'), oracleSource],
    ['discarded oracle projection', future, discardedOracle],
    ['inverted projector failure branch', future, oracleSource.replace('if (result.ok) continue;', 'if (!result.ok) continue;')],
  ];
  for (const [name, mutantMachine, mutantOracle] of runtimeMutants) {
    assert.ok(mutantMachine !== future || mutantOracle !== oracleSource, `${name}: live mutation point`);
    const mutant = productionConsumers(mutantMachine, mutantOracle, fixture());
    assert.throws(() => {
      assert.equal(mutant.api.canFinishGuard(mutant.context), false, `${name}: boolean must fail`);
      const emitted = mutant.api.buildDoneChecklist('B-probe', mutant.store, 'ROOT', { gitCwd: 'GIT' });
      assert.ok(emitted.some(row => row.id === 'future-done-predicate' && row.blocking && row.status === 'fail'), `${name}: oracle must fail`);
    }, { name: 'AssertionError' }, `${name}: executable mutation must be killed`);
  }
  assert.notEqual(skippedOracle, oracleSource);
  const skipped = productionConsumers(future, skippedOracle, fixture());
  assert.throws(() => skipped.api.buildDoneChecklist('B-probe', skipped.store, 'ROOT', { gitCwd: 'GIT' }),
    /Missing shared DONE predicate result: test-evidence/, 'skipped outcomes must explicitly fail closed before rendering');
  console.log('GREEN shared DONE predicates: runtime inverse/skipped/discarded mutations killed; completedSnapshot cannot downgrade live failure');
  assert.doesNotMatch(readFileSync('docs/requirements/decisions/done-prepare-automation-execution-plan.md', 'utf8'),
    /`done_prepare` and `done_closure` are read-only projections/,
    'documentation must not claim the mutating done_prepare command is read-only');
  runPromptEnvelopeSnapshotProof();
  console.log('Shared DONE predicate parity passed');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runSharedDonePredicateProof(); }
  catch (error) { console.error(`RED shared DONE predicates: ${error.stack ?? error}`); process.exitCode = 1; }
}
