#!/usr/bin/env node
/**
 * B-03b7 CHK-001. Explicit --baseline executes existing shipped primitives.
 * Default execution is GREEN and refuses missing production/setup as BROKEN.
 * Only adapter wiring may change after preregistration; case IDs, corpus,
 * acceptance assertions and operation-counting rules remain unchanged.
 * This read-only replay neither mutates historical Findings nor certifies the
 * current detector, signed CLI integration, full lifecycle or Story 1 batching.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const self = fileURLToPath(import.meta.url);
const argv = process.argv.slice(2);
const baseline = argv.includes('--baseline');
const inject = argv.find(arg => arg.startsWith('--inject='))?.split('=')[1];
const rows = [];
let quiet = false;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const byteDigest = value => createHash('sha256').update(value).digest('hex');
function broken(message) { const error = new Error(message); error.name = 'HarnessBroken'; throw error; }
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 12 * 1024 * 1024, timeout: 30000 });
  if (result.error || result.status !== 0) broken(`${command} ${args.join(' ')}: ${result.error?.message ?? result.stderr ?? result.stdout}`);
  return result.stdout;
}
function load(module) { return import(pathToFileURL(resolve(root, module)).href); }
function check(id, expected, observed, predicate) {
  const pass = predicate(); // exceptions are setup/harness BROKEN, never product FAIL
  if (typeof pass !== 'boolean') broken(`${id}: predicate did not return a boolean`);
  rows.push({ id, status: pass ? 'PASS' : 'FAIL', expected, observed });
  if (!quiet) console.log(`${id} ${pass ? 'PASS' : 'FAIL'} ${JSON.stringify({ expected, observed })}`);
}
function same(a, b) { return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort()); }

async function immutableBaselineModules(data) {
  const { default: ts } = await import('typescript');
  if (ts.version !== data.baselineRuntime.compilerVersion) broken(`baseline compiler version changed: ${ts.version}`);
  const modules = [];
  for (const pin of data.baselineRuntime.modules) {
    const source = run('git', ['show', `${data.registration.baselineRevision}:${pin.path}`]);
    if (byteDigest(source) !== pin.sourceHash) broken(`immutable baseline source mismatch: ${pin.path}`);
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }, fileName: pin.path, reportDiagnostics: true });
    if (compiled.diagnostics?.some(row => row.category === ts.DiagnosticCategory.Error)) broken(`baseline compilation failed: ${pin.path}`);
    if (byteDigest(compiled.outputText) !== pin.runtimeHash) broken(`immutable baseline runtime mismatch: ${pin.path}`);
    // All imports in these exact pinned modules are type-only. The immutable
    // emitted JS is self-contained, with no mutable dist or filesystem module
    // resolution; both source and executable bytes are independently pinned.
    modules.push(await import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`));
  }
  console.log(`RUNTIME_WITNESS ${JSON.stringify({ authority: 'reexecuted_pinned_baseline_not_signed_runtime_receipt', baselineRevision: data.registration.baselineRevision, ...data.baselineRuntime })}`);
  return modules;
}

function compatibilityCurrent(sources, ids) {
  const successor = new Map();
  const idOf = value => typeof value === 'string' ? value : value?.id;
  const link = (before, after) => {
    if (!sources.has(before) || !sources.has(after)) broken('compatibility lineage references missing row');
    if (successor.has(before) && successor.get(before) !== after) broken('compatibility lineage has contradictory successors');
    successor.set(before, after);
  };
  for (const id of ids) {
    const row = sources.get(id);
    if (!row) broken(`compatibility row missing: ${id}`);
    const after = idOf(row.supersededByFindingId ?? row.successor);
    if (after) link(id, after);
    const before = idOf(row.supersedesFindingId);
    if (before) link(before, id);
    for (const predecessor of row.predecessors ?? []) link(idOf(predecessor), id);
  }
  const chains = new Map();
  for (const id of ids) {
    const visited = new Set(); let current = id;
    while (successor.has(current)) {
      if (visited.has(current)) broken('compatibility lineage cycle');
      visited.add(current); current = successor.get(current);
    }
    chains.set(current, [...new Set([...(chains.get(current) ?? []), ...visited])]);
  }
  // No structured links means both actual compatibility rows remain visible.
  // Prose saying SUPERSEDES is deliberately not invented structured authority.
  return [...chains].map(([id, predecessors]) => ({ id, predecessors, ...(sources.get(id).superseded ? { superseded: true } : {}) }));
}

async function baselineAdapter(data, sources) {
  const [advisory, cluster, recall] = await immutableBaselineModules(data);
  for (const [name, fn] of Object.entries({ isFindingBlocking: advisory.isFindingBlocking, clusterFindings: cluster.clusterFindings,
    buildStoryProfile: recall.buildStoryProfile, buildQueryProfile: recall.buildQueryProfile, recallSimilarStories: recall.recallSimilarStories })) {
    if (typeof fn !== 'function') broken(`baseline dependency has no ${name}`);
  }
  const storyFindings = new Map();
  for (const row of data.observations.filter(row => row.origin === 'historical_shape')) {
    const storyId = row.id.split(':')[0];
    storyFindings.set(storyId, [...(storyFindings.get(storyId) ?? []), sources.get(row.id)]);
  }
  // Preserve the real API's one-profile-per-Story input cardinality. It returns
  // Story profiles, never exact Finding results; do not fabricate duplicate
  // Story profiles to make recall look worse.
  const profiles = [...storyFindings].map(([storyId, findings]) => recall.buildStoryProfile({ storyId, findings }));
  const grouping = cluster.clusterFindings(data.observations.map(row => ({ ...sources.get(row.sourceReference), id: row.id, files: [row.path] })), '2000-01-01T00:00:00.000Z');
  return {
    rawSignalFindings: data.noise.filter(row => advisory.isFindingBlocking(row, ['high', 'critical'], 1)).map(row => row.id),
    // A deliberately out-of-contract cross-type mutation at the existing typed
    // Finding predicate. This does NOT prove normal detector ingestion reaches
    // a lifecycle gate. GREEN must exercise the new strict collector boundary,
    // not change this compatibility predicate to accept arbitrary object types.
    substitutedBlockers: data.noise.filter(row => advisory.isFindingBlocking({ ...row, status: 'open', severity: 'high', evidenceState: 'verified' }, ['high', 'critical'], 1)).map(row => row.id),
    groups: grouping.map(group => ({ id: group.clusterId, sourceIds: group.findingIds, authority: 'coarse_suggestion' })),
    current: compatibilityCurrent(sources, data.corrections.flatMap(link => [link.predecessor, link.successor])),
    hits: data.queries.map(query => ({ queryId: query.id, rows: recall.recallSimilarStories(recall.buildQueryProfile(query.value), profiles, 100)
      .map(hit => ({ id: hit.storyId, sourceIds: [], gateEvidence: false })) })),
  };
}

async function greenAdapter(data, sources) {
  const identity = await load('packages/main/dist/core/finding-identity.js');
  const history = await load('packages/main/dist/core/finding-history.js');
  const headHash = run('git', ['rev-parse', 'HEAD']).trim();
  const stamp = '2000-01-01T00:00:00.000Z';
  const signals = data.noise.map(row => {
    const base = { schemaVersion: 1, authority: 'non_authoritative', gateEvidence: false,
      signalId: row.id, detectorId: row.detector, detectorVersion: 'frozen-replay-v1', observedAt: stamp, targetStoryId: 'B-REPLAY',
      headHash, materialHash: identity.identityHash({ corpusDigest: data.corpusDigest }), sourceIds: [row.sourceId],
      outputDigest: identity.identityHash({ text: row.text }), matchCount: 1,
      anchors: [{ path: 'replay-noise', contentDigest: identity.identityHash({ text: row.text }) }], rawCategory: 'synthetic_noise_shape' };
    const signal = { ...base, sourceLineageKeys: identity.sourceLineageKeys(base) }; identity.validateSignal(signal); return signal;
  });
  const rawSignalFindings = signals.filter(signal => signal.gateEvidence === true).map(signal => signal.signalId);
  const substitutedBlockers = signals.filter(signal => {
    try { identity.parseIdentityInput(identity.detectorSignalSchema, { ...signal, status: 'open', severity: 'high', evidenceState: 'verified' }); return true; }
    catch (error) {
      if (error?.name !== 'ZodError' || !Array.isArray(error.issues) || error.issues.length !== 1
        || error.issues[0].code !== 'unrecognized_keys' || error.issues[0].path.length !== 0
        || !same(error.issues[0].keys, ['status', 'severity', 'evidenceState'])) throw error;
      return false;
    }
  }).map(signal => signal.signalId);
  // Replay-only construction over the immutable source observations. Matching
  // requires ALL four evidence dimensions, never a gold label, shared source,
  // file alone, category or severity. The actual handler uses this same pure
  // confirmation reducer AFTER its signed reviewer/source checks; the separate
  // CLI campaign proves those IO authorities. These are not current signed
  // confirmations of the historical repository Findings.
  const findingRefs = new Map(data.observations.map(row => [row.id, { storyId: row.id.split(':')[0], findingId: row.id,
    recordId: `replay:${identity.identityHash({ id: row.id, source: row.sourceReference, hash: sources.get(row.sourceReference)._hash })}`,
    recordHash: identity.identityHash({ row, sourceHash: sources.get(row.sourceReference)._hash }) }]));
  const confirmations = new Map();
  for (const row of data.observations) {
    const key = identity.identityHash({ path: row.path, symbol: row.symbol, trigger: row.trigger, affectedContract: row.affectedContract });
    confirmations.set(key, [...(confirmations.get(key) ?? []), row]);
  }
  const defects = [...confirmations].map(([key, members]) => identity.buildConfirmedCanonicalDefect({
    storyId: 'B-REPLAY', idempotencyKey: key, title: `Evidence-bound replay identity ${key}`, triggerCondition: members[0].trigger,
    reproduction: [...new Set(members.map(row => row.reproduction))].sort().join('; '), rootCauseState: 'unknown',
    identityEvidenceRefs: members.map(row => `${row.sourceReference}:${sources.get(row.sourceReference)._hash}`),
    evidenceAnchors: members.map(row => ({ path: row.path, symbol: row.symbol, contentDigest: identity.identityHash({ sourceHash: sources.get(row.sourceReference)._hash }) })),
    affectedSymbols: [members[0].symbol], affectedContracts: [members[0].affectedContract], memberFindingRefs: members.map(row => findingRefs.get(row.id)),
    canonicalFindingRef: findingRefs.get(members[0].id), reviewRunId: 'replay-evidence-review-not-a-current-review-run',
  }, { canonicalDefectId: `replay-defect:${key}`, confirmedBy: 'replay-evidence-review', confirmedAt: stamp, sourceLineageKeys: members.map(row => row.sourceId) }));
  const idsByRecord = new Map([...findingRefs].map(([id, ref]) => [ref.recordId, id]));
  const groups = identity.projectConfirmedIdentityGroups(defects).map(group => ({ id: group.canonicalDefectId,
    sourceIds: group.memberFindingRefs.map(ref => idsByRecord.get(ref.recordId)), authority: 'confirmed_replay_fixture_not_current_ledger_authority' }));
  const node = (id, ref, fields = {}) => ({ observationKey: `replay:${id}`, kind: 'finding', storyId: ref.storyId, entityId: id,
    ref: { storyId: ref.storyId, recordId: ref.recordId, recordHash: ref.recordHash }, findingRef: ref,
    paths: [], packages: [], symbols: [], contracts: [], canonicalIds: [], sourceLineageKeys: [id], outcome: 'historical_replay', payload: { id }, evidenceAnchors: [], ...fields });
  const correctionNodes = data.corrections.flatMap(link => [link.predecessor, link.successor]).map(id => node(id, {
    storyId: id.split(':')[0], findingId: id, recordId: `replay:${id}`, recordHash: identity.identityHash({ id, sourceHash: sources.get(id)._hash }),
  }));
  const correctionLinks = data.corrections.map(link => {
    const before = correctionNodes.find(row => row.entityId === link.predecessor); const after = correctionNodes.find(row => row.entityId === link.successor);
    const base = { schemaVersion: 1, authority: 'non_authoritative', gateEvidence: false, kind: 'finding_supersession', supersessionId: link.id,
      predecessor: before.ref, successor: after.ref, predecessorEntityId: before.entityId, successorEntityId: after.entityId,
      reason: 'incorrect_statement', evidenceRefs: [link.evidenceReference], evidenceAnchors: [{ path: link.evidenceReference, contentDigest: after.ref.recordHash }],
      createdBy: 'replay-evidence-review', reviewRunId: 'replay-correction-not-a-current-review-run', effectiveAt: stamp };
    return { ...base, recordHash: identity.identityHash(base) };
  });
  const correctionInput = { nodes: correctionNodes, links: correctionLinks, sourceBindings: [{ storyId: 'B-REPLAY', digest: data.corpusDigest }] };
  const currentById = new Map(correctionNodes.map(row => {
    const resolved = history.canonicalCurrent(correctionInput, row.ref.recordId);
    return [resolved.current.entityId, { id: resolved.current.entityId, predecessors: resolved.predecessors.map(before => before.entityId) }];
  }));
  const index = history.buildHistoryIndex({ nodes: data.observations.filter(row => row.origin === 'historical_shape').map(row => node(row.id, findingRefs.get(row.id), {
    paths: [row.path], packages: [row.package], symbols: [row.symbol], contracts: [row.affectedContract], sourceLineageKeys: [row.sourceId],
  })), links: [], sourceBindings: [{ storyId: 'B-REPLAY', digest: data.corpusDigest }] });
  const hits = data.queries.map(query => ({ queryId: query.id, rows: history.queryHistoryIndex(index, { storyId: 'B-REPLAY',
    [query.field === 'affectedContract' ? 'contract' : query.field]: query.value }).map(row => ({ id: row.entityId, sourceIds: row.sourceLineageKeys, gateEvidence: false })) }));
  const result = { rawSignalFindings, substitutedBlockers, groups, current: [...currentById.values()], hits };
  // Evaluation ONLY: labels/expected hits are read after production results are
  // fixed. They cannot feed grouping, confirmation, indexing or retrieval.
  const baselineResult = await baselineAdapter(data, sources);
  const metric = (numerator, denominator) => ({ numerator, denominator, observed: denominator ? numerator / denominator : null,
    status: denominator ? 'observed_sample_only' : 'insufficient_evidence' });
  const retrieval = measured => {
    let truePositives = 0; let predicted = 0; let relevant = 0;
    for (const query of data.queries) { const ids = measured.hits.find(row => row.queryId === query.id).rows.map(row => row.id);
      truePositives += ids.filter(id => query.expected.includes(id)).length; predicted += ids.length; relevant += query.expected.length; }
    return { precision: metric(truePositives, predicted), recall: metric(truePositives, relevant) };
  };
  const pairs = measured => new Set(measured.groups.flatMap(group => [...group.sourceIds].sort().flatMap((id, index, all) => all.slice(index + 1).map(other => `${id}|${other}`))));
  const expectedPairs = new Set(data.observations.flatMap((row, index, all) => all.slice(index + 1).filter(other => data.labels[row.id].semanticDefect === data.labels[other.id].semanticDefect).map(other => [row.id, other.id].sort().join('|'))));
  const observedPairs = pairs(result); const correctPairs = [...observedPairs].filter(pair => expectedPairs.has(pair)).length;
  console.log(`BENCHMARK ${JSON.stringify({ schemaVersion: 1, corpusDigest: data.corpusDigest, measurement: 'preregistered synthetic/historical-shape replay, not current detector or workload accuracy',
    perDetectorFamily: [{ detector: 'reviewer-source-reproduction', version: 'frozen-replay-v1', family: 'literal-comparison-parser',
      identityPrecision: metric(correctPairs, observedPairs.size), identityRecall: metric(correctPairs, expectedPairs.size), retrieval: retrieval(result) },
      { detector: 'concept-symbol-residue', version: 'frozen-replay-v1', family: 'synthetic_noise_shape', precision: metric(0, 0), recall: metric(0, 0), noiseAuthorityRejections: metric(data.noise.length - substitutedBlockers.length, data.noise.length) }],
    metricTarget: 'exact Finding-ID retrieval, not generic Story-recall accuracy',
    coarseBaseline: { resultGranularity: 'Story IDs', ...retrieval(baselineResult) }, exactIndex: { resultGranularity: 'Finding IDs', ...retrieval(result) }, manualOperations: operationTrace(data.observations, groups, data.registration.countingRule),
    qualification: { enforceEligible: false, qualifyingWindow: null, latencyMeasured: false, historicalElapsedTimeSavings: null, jointOwner: 'B-e6d9' } })}`);
  return result;
}

function operationTrace(observations, groups, rule) {
  const event = (kind, subject) => ({ id: `${kind}:${subject}`, kind, subject });
  const baselineEvents = observations.flatMap(row => rule.baselinePerSource.map(kind => event(kind, row.id)));
  const groupedEvents = observations.flatMap(row => rule.groupedPerSource.map(kind => event(kind, row.id)));
  for (const group of groups) {
    const members = [...group.sourceIds].sort();
    const subject = members.join('+');
    groupedEvents.push(...rule.groupedPerDefect.map(kind => event(kind, subject)));
    for (const source of members.slice(1)) groupedEvents.push(...rule.groupedPerAdditionalSource.map(kind => event(kind, source)));
  }
  for (const events of [baselineEvents, groupedEvents]) {
    if (new Set(events.map(item => item.id)).size !== events.length) broken('duplicate manual-operation event ID');
  }
  return { baselineEvents, groupedEvents, baselineOperations: baselineEvents.length, groupedOperations: groupedEvents.length,
    groupingReduction: (baselineEvents.length - groupedEvents.length) / baselineEvents.length,
    jointBatchCriterion: rule.jointBatchCriterion, jointBatchOperations: null, jointThresholdFulfilled: false,
    jointSafetyCertification: 'pending_story_1', measurement: 'fixed replay unit operations; no elapsed-time or historical workload claim' };
}

function acceptance(data, result, trace) {
  const groupsOf = id => result.groups.filter(group => group.sourceIds.includes(id));
  const together = (a, b) => groupsOf(a).some(group => group.sourceIds.includes(b));
  check('P3_RAW_SIGNAL_CONTROL', [], result.rawSignalFindings, () => result.rawSignalFindings.length === 0);
  check('P3_AUTHORITY_SUBSTITUTION', [], { blockers: result.substitutedBlockers, origin: 'synthetic_cross_type_mutation_not_normal_ingestion' }, () => result.substitutedBlockers.length === 0);
  check('P3_EXPLICIT_DUPLICATE', 'F-060/F-062 same group with every independent source retained', result.groups, () => together('B-cdf6:F-060', 'B-cdf6:F-062'));
  check('P3_DISTINCT_SIBLINGS', 'F-061/F-065 remain separate', result.groups, () => !together('B-cdf6:F-061', 'B-cdf6:F-065'));
  const correction = data.corrections[0];
  check('P5_CANONICAL_CORRECTION', { current: correction.successor, predecessor: correction.predecessor }, result.current,
    () => result.current.length === 1 && result.current[0].id === correction.successor && result.current[0].predecessors.includes(correction.predecessor));
  for (const query of data.queries) {
    const hit = result.hits.find(item => item.queryId === query.id);
    if (!hit || !Array.isArray(hit.rows)) broken(`missing query result ${query.id}`);
    check(query.id, { ids: query.expected, lineage: true, gateEvidence: false }, hit.rows,
      () => same(hit.rows.map(row => row.id), query.expected) && hit.rows.every(row => row.sourceIds.length > 0 && row.gateEvidence === false));
  }
  check('P7_CURRENT_ONLY', 'predecessor not returned as current without warning', result.current,
    () => !result.current.some(row => row.id === correction.predecessor && !row.superseded));
  const expectedIds = data.observations.map(row => row.id);
  const actualIds = result.groups.flatMap(group => group.sourceIds);
  check('P1_SOURCE_COVERAGE', expectedIds, actualIds, () => same(expectedIds, actualIds) && new Set(actualIds).size === actualIds.length);
  const safety = result.groups.map(group => ({ id: group.id, defects: [...new Set(group.sourceIds.map(id => data.labels[id]?.semanticDefect))] }));
  check('P1_DISTINCT_DEFECT_SAFETY', 'exactly one semantic defect per group; all applicable high/critical replay sources retained', safety,
    () => safety.every(group => group.defects.length === 1 && group.defects[0] !== undefined) && expectedIds.filter(id => data.labels[id].applicableHighCritical).every(id => actualIds.includes(id)));
  check('P1_GROUPING_SAVINGS', 'positive grouping-only savings including every source check and confirmation', trace,
    () => trace.baselineOperations > 0 && trace.groupedOperations > 0 && trace.groupingReduction > 0);
  check('P1_JOINT_PENDING', 'joint >=50% grouping+batch criterion remains pending B-e6d9', { jointBatchCriterion: trace.jointBatchCriterion, jointBatchOperations: trace.jointBatchOperations, jointThresholdFulfilled: trace.jointThresholdFulfilled },
    () => trace.jointBatchCriterion === 'pending_story_1' && trace.jointBatchOperations === null && trace.jointThresholdFulfilled === false);
}

async function main() {
  if (argv.includes('--verify-baseline-contract')) {
    const result = spawnSync(process.execPath, [self, '--baseline'], { cwd: root, encoding: 'utf8', maxBuffer: 12 * 1024 * 1024, timeout: 30000 });
    const summaries = result.stdout?.split('\n').filter(line => line.startsWith('SUMMARY ')) ?? [];
    if (result.status !== 1 || summaries.length !== 1) broken(`expected raw RED exit 1 and exactly one summary: ${result.stderr} ${result.stdout}`);
    const summary = JSON.parse(summaries[0].slice(8));
    const failures = result.stdout.split('\n').filter(line => /^P[1357]_\S+ FAIL /.test(line)).map(line => line.split(' ')[0]);
    const expectedFailures = ['P3_AUTHORITY_SUBSTITUTION', 'P3_DISTINCT_SIBLINGS', 'P5_CANONICAL_CORRECTION', 'P7_EXACT_PATH', 'P7_EXACT_SYMBOL', 'P7_EXACT_PACKAGE', 'P7_EXACT_CONTRACT', 'P7_CURRENT_ONLY', 'P1_DISTINCT_DEFECT_SAFETY'];
    if (!same(failures, expectedFailures) || summary.FAILED !== expectedFailures.length || summary.BROKEN !== 0 || summary.PASS !== 6 || summary.redEstablished !== true) broken(`baseline contract drift: ${JSON.stringify({ failures, summary })}`);
    console.log(result.stdout.trim());
    console.log('BASELINE_CONTRACT PASS expected product failures observed; this is RED capture, not product GREEN');
    return;
  }
  if (argv.includes('--self-test')) {
    for (const fault of ['missing-dependency', 'failed-import', 'setup-failure', 'harness-exception']) {
      const result = spawnSync(process.execPath, [self, '--baseline', `--inject=${fault}`], { cwd: root, encoding: 'utf8', timeout: 30000 });
      const summary = result.stdout?.split('\n').filter(line => line.startsWith('SUMMARY ')).at(-1);
      if (result.status !== 2 || !summary) broken(`fault injection ${fault} was not BROKEN: ${result.stderr} ${result.stdout}`);
      const parsed = JSON.parse(summary.slice(8));
      if (parsed.FAILED !== 0 || parsed.BROKEN !== 1 || parsed.redEstablished !== false) broken(`fault injection ${fault} contaminated RED`);
      console.log(`HARNESS_CONTROL ${fault} PASS`);
    }
    const data = await load('packages/main/tests/data/finding-identity-gold-set.mjs');
    assert.deepEqual(compatibilityCurrent(new Map([
      ['before', { id: 'before', supersededByFindingId: 'after' }],
      ['after', { id: 'after', supersedesFindingId: 'before', predecessors: ['before'] }],
    ]), ['before', 'after']), [{ id: 'after', predecessors: ['before'] }], 'compatibility adapter must retain a real structured successor');
    console.log('HARNESS_ADAPTER_CONTROL structured successor preserved PASS');
    // Synthetic oracle is ONLY a self-test of the assertions. It is never used
    // by either runtime adapter and cannot produce product GREEN evidence.
    const oracle = { rawSignalFindings: [], substitutedBlockers: [],
      groups: [...new Set(Object.values(data.labels).map(label => label.semanticDefect))].map(id => ({ id, sourceIds: data.observations.filter(row => data.labels[row.id].semanticDefect === id).map(row => row.id) })),
      current: [{ id: data.corrections[0].successor, predecessors: [data.corrections[0].predecessor] }],
      hits: data.queries.map(query => ({ queryId: query.id, rows: query.expected.map(id => ({ id, sourceIds: [id], gateEvidence: false })) })),
    };
    quiet = true;
    const exercise = (value) => { rows.length = 0; acceptance(data, value, operationTrace(data.observations, value.groups, data.registration.countingRule)); return rows.filter(row => row.status === 'FAIL').map(row => row.id); };
    assert.deepEqual(exercise(oracle), [], 'assertion self-test positive control');
    const mutations = [
      ['raw signal text', value => value.rawSignalFindings.push('SYN:noise-1'), 'P3_RAW_SIGNAL_CONTROL'],
      ['authority substitution', value => value.substitutedBlockers.push('SYN:noise-1'), 'P3_AUTHORITY_SUBSTITUTION'],
      ['independent defect merge', value => { value.groups[1].sourceIds.push(...value.groups[2].sourceIds); value.groups.splice(2, 1); }, 'P1_DISTINCT_DEFECT_SAFETY'],
      ['missing predecessor', value => { value.current[0].predecessors = []; }, 'P5_CANONICAL_CORRECTION'],
      ['missed high source', value => { value.groups[0].sourceIds.shift(); }, 'P1_SOURCE_COVERAGE'],
      ['lineage-free hit', value => { value.hits[0].rows[0].sourceIds = []; }, 'P7_EXACT_PATH'],
    ];
    for (const [name, mutate, expected] of mutations) {
      const value = structuredClone(oracle); mutate(value);
      assert.ok(exercise(value).includes(expected), `assertions accepted ${name}`);
      console.log(`HARNESS_ASSERTION_CONTROL ${name} PASS`);
    }
    rows.length = 0;
    quiet = false;
    console.log('HARNESS_SELF_TEST PASS 4 setup faults classified BROKEN; 6 assertion mutations rejected; synthetic controls are not product GREEN');
    return;
  }
  if (inject === 'missing-dependency') run('b03b7-intentionally-missing-executable', []);
  if (inject === 'failed-import') await load('packages/main/dist/core/b03b7-intentionally-missing.js');
  if (inject === 'setup-failure') broken('injected setup failure');
  if (inject === 'harness-exception') throw new TypeError('injected harness exception');
  if (inject) broken(`unknown injection ${inject}`);
  const data = await load('packages/main/tests/data/finding-identity-gold-set.mjs');
  if (digest(data.corpus) !== data.corpusDigest) broken('preregistered corpus digest mismatch');
  const head = run('git', ['rev-parse', 'HEAD']).trim();
  const baselineExists = run('git', ['rev-parse', `${data.registration.baselineRevision}^{commit}`]).trim();
  const config = JSON.parse(readFileSync(resolve(root, 'proof-or-stop.config.json'), 'utf8'));
  if (!config.validate.commands.some(command => command.command === 'node' && command.args?.includes('packages/main/tests/red/red-b03b7-identity-lineage.mjs'))) broken('harness missing standing validation registration');
  const sources = new Map();
  for (const storyId of ['B-cdf6', 'B-META-framework-audit']) {
    const result = JSON.parse(run(process.execPath, ['bin/proof-or-stop.js', 'finding_list', `--storyId=${storyId}`, '--json']));
    if (!Array.isArray(result.findings)) broken(`invalid finding_list shape: ${storyId}`);
    for (const row of result.findings) sources.set(row.id, row);
  }
  for (const source of data.historicalSources) {
    if (sources.get(source.id)?._hash !== source.hash) broken(`historical source missing or changed: ${source.id}`);
    const row = sources.get(source.id);
    const projection = Object.fromEntries(data.historicalProjectionKeys.filter(key => row[key] !== undefined).map(key => [key, row[key]]));
    if (digest(projection) !== data.historicalProjectionHashes[source.id]) broken(`historical CLI projection changed: ${source.id}`);
  }
  // Successful real CLI source reads and existing runtime imports are setup
  // controls. They are not inferred from module existence alone.
  console.log(`REGISTRATION ${JSON.stringify({ corpusDigest: data.corpusDigest, baselineRevision: baselineExists, executedHead: head, mode: baseline ? 'baseline' : 'green', rows: data.observations.map(row => ({ id: row.id, sourceId: row.sourceId, origin: row.origin })), caseIds: data.caseIds })}`);
  const result = baseline ? await baselineAdapter(data, sources) : await greenAdapter(data, sources);
  if (!result || !['rawSignalFindings', 'substitutedBlockers', 'groups', 'current', 'hits'].every(key => Array.isArray(result[key]))) broken('malformed replay adapter output');
  const trace = operationTrace(data.observations, result.groups, data.registration.countingRule);
  acceptance(data, result, trace);
  if (!same(rows.map(row => row.id), data.caseIds)) broken('preregistered assertion inventory changed');
  const FAILED = rows.filter(row => row.status === 'FAIL').length;
  const PASS = rows.filter(row => row.status === 'PASS').length;
  console.log(`SUMMARY ${JSON.stringify({ FAILED, BROKEN: 0, PASS, redEstablished: baseline && FAILED > 0 && PASS > 0, corpusDigest: data.corpusDigest })}`);
  process.exitCode = FAILED ? 1 : 0;
}

try { await main(); }
catch (error) {
  console.error(`BROKEN ${error.name}: ${error.message}`);
  console.log(`SUMMARY ${JSON.stringify({ FAILED: 0, BROKEN: 1, PASS: rows.filter(row => row.status === 'PASS').length, redEstablished: false })}`);
  process.exitCode = 2;
}
