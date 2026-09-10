/** B-03b7 preregistration. Labels are an oracle, NEVER runtime grouping input.
 * Historical references describe old observations, not present defect status.
 * Synthetic repeats model independent observations; they are not historical rows.
 * No historical hit-count or current detector-accuracy claim is made here.
 */
export const registration = {
  version: 'finding-identity-gold-set.v1',
  baselineRevision: '55de65f94bc4c916caf06f65ad6351ce9974122d',
  inclusion: 'The eight named historical records below, plus exactly three separately identified synthetic observations of each of the four P1 records.',
  exclusion: 'All other historical Findings; historical detector hit counts; elapsed-time claims; Story 1 batch/disposition operations.',
  countingRule: {
    unit: 'One completed manual review or decision, with a unique event ID. No timing weights.',
    baselinePerSource: ['source_evidence_review', 'trigger_contract_review', 'triage_decision', 'repair_plan'],
    groupedPerSource: ['source_evidence_review', 'trigger_contract_review'],
    groupedPerDefect: ['triage_decision', 'repair_plan'],
    groupedPerAdditionalSource: ['identity_confirmation'],
    jointBatchCriterion: 'pending_story_1',
    jointOwner: 'B-e6d9',
    jointRequiredReduction: 0.5,
    jointSafety: ['zero_missed_applicable_high_critical', 'zero_false_deferrals', 'normal_stall_adjudication'],
  },
};

export const historicalSources = [
  { id: 'B-cdf6:F-060', hash: 'bcc37fe8fd7239072f8ce54134551071198976807abd04604de70329be9d537c' },
  { id: 'B-cdf6:F-062', hash: '9d07992c8c419a2932553eb33ad91770d4ad44c11c1549d34aadd6e8c63c7882' },
  { id: 'B-cdf6:F-061', hash: '0bfd6393912b260ffc30dfa75f41e427c270d3f4d97545cc6b7c22067e989418' },
  { id: 'B-cdf6:F-065', hash: '3aa464961a1d5b3d991c677ef8ab1ace04fd473a7a1f2571ef2ff910aafdac3d' },
  { id: 'B-cdf6:F-070', hash: '8b969748e2fbf2953cf9b2f2f84d779f47de6e11b66e36178003f530bd64e208' },
  { id: 'B-META-framework-audit:F-035', hash: '0909836e7105d94bc51abc25007dd68f492ead0a2d6ac92697a42e1eace00156' },
  { id: 'B-META-framework-audit:F-030', hash: '85b3d88ebda6be08bd1363a87890c931c829e1f3a12363f7ddff69a0a9799a66' },
  { id: 'B-META-framework-audit:F-031', hash: 'a9bbac4c6498d39c0fb3b8f940b9dea5ae56f88984258f0f6d750f2cef8a0453' },
];

export const historicalProjectionKeys = ['id', 'desc', 'files', 'severity', 'status', 'evidenceState', 'resolutionType', 'resolvedReason', 'supersedesFindingId', 'supersededByFindingId', 'successor', 'predecessors'];
export const historicalProjectionHashes = {
  'B-cdf6:F-060': '1f77ceb6f802ea6569ff6252ae043e0fdeb2241c3287b7c3fd10dd3f5b4f10b3',
  'B-cdf6:F-061': 'c657484064ff799bc509cd09d7e07be7eda77fbcfefeb3131834c6ae078f7d82',
  'B-cdf6:F-062': '2c671dba0e5091c20f58d30104e924512223387a4ff20bf6f754594cd66e353c',
  'B-cdf6:F-065': 'b6a78a3165de35966d9125ee9e89963f1d29afa92da900e194bfc3786a28b7eb',
  'B-cdf6:F-070': 'be74ff1f447766b46a67f425886ef848ea1b7c927dcece4c8eb47cc0cd343165',
  'B-META-framework-audit:F-030': 'a030b210f42e9228d1ecc484491b6966d20428e706a22358b0668ff50eeaf2c7',
  'B-META-framework-audit:F-031': 'c0a61f12dadcb96281e5a3d5bce188472a82718c20de5270ea8b46aacb0d3f29',
  'B-META-framework-audit:F-035': 'f9ea3c1ea844a6958b6c003dc3d45afcab966f8de0498fbf2a633c97a79a8c70',
};
export const baselineRuntime = {
  compiler: 'typescript', compilerVersion: '5.9.3', target: 'ES2022', module: 'ES2022',
  modules: [
    { name: 'advisory', path: 'packages/main/src/core/advisory.ts', sourceHash: 'e1c34391d7fb902304e6409924e537f709e06c707d9a472fab2ec7452d8ba081', runtimeHash: '8df81d1969cbf1e94f8e6a313c8310fb8c3ce60f65c215fa7eb5f691ac4a84e6' },
    { name: 'cluster-compute', path: 'packages/main/src/core/cluster-compute.ts', sourceHash: '09b9aa233b6c27e2b24d8eebe6091f55c51aefaa59bb55fb2941e4f61a759d9b', runtimeHash: 'ca4f24aa1ad615c3fc35e3db723b70caa1b0349f73985ee0e2ff620bf6e52f9f' },
    { name: 'story-recall', path: 'packages/main/src/core/story-recall.ts', sourceHash: '6a0a7123e33f84e6fb52543c4ab855e5b3702612436e8247953c392fb0ed085c', runtimeHash: '5ff36ce915e0eb0acd09f03ed08c0e2389c5ab395a59dbe4d6479d91586a3c45' },
  ],
};

const p1Seeds = [
  { id: 'B-cdf6:F-060', symbol: 'recognizedLiveSmokeCommand', contract: 'canonical inline session prefix selects live-smoke budget', path: 'packages/main/src/core/done-required-timeout-budget.ts' },
  { id: 'B-cdf6:F-062', symbol: 'recognizedLiveSmokeCommand', contract: 'canonical inline session prefix selects live-smoke budget', path: 'packages/main/src/core/done-required-timeout-budget.ts' },
  { id: 'B-cdf6:F-061', symbol: 'buildCanonicalHostRuntimeEnv', contract: 'canonical allowlist preserves explicit session override', path: 'packages/main/src/core/lattice-dispatch.ts' },
  { id: 'B-cdf6:F-065', symbol: 'buildRequiredCommandEnv', contract: 'canonical denylist suppresses required-command session injection', path: 'packages/main/src/core/lattice-dispatch.ts' },
];
export const observations = p1Seeds.flatMap(seed => [0, 1, 2, 3].map(repeat => ({
  id: repeat === 0 ? seed.id : `SYN:repeat-${seed.id.split(':')[1]}-${repeat}`,
  sourceId: repeat === 0 ? seed.id : `synthetic-independent-source:${seed.id}:${repeat}`,
  sourceReference: seed.id,
  origin: repeat === 0 ? 'historical_shape' : 'synthetic_independent_observation',
  detector: 'reviewer-source-reproduction',
  package: 'packages/main',
  path: seed.path,
  symbol: seed.symbol,
  affectedContract: seed.contract,
  trigger: seed.contract,
  reproduction: `source-evidence:${seed.id}`,
  severity: 'high',
})));

// F-060 explicitly records duplicate-of F-062. F-061/F-065 are DISTINCT
// contracts despite sharing a file, severity, family and later shared helper.
export const labels = Object.fromEntries(observations.map(row => [row.id, {
  semanticDefect: ['B-cdf6:F-060', 'B-cdf6:F-062'].includes(row.sourceReference) ? 'inline-prefix' : row.sourceReference.endsWith('F-061') ? 'allowlist-override' : 'denylist-injection',
  family: 'literal-comparison-parser',
  applicableHighCritical: true,
  applicabilityScope: 'synthetic replay obligation only; historical resolved status is unchanged',
}]));

export const corrections = [{
  id: 'P5-correction', predecessor: 'B-META-framework-audit:F-030', successor: 'B-META-framework-audit:F-031',
  scope: 'hit-count statement only; qualitative detector-coverage observation is retained',
  evidenceReference: 'B-META-framework-audit:F-031',
}];

export const noise = ['branch main', 'packages/main/src', 'main in documentation'].map((text, index) => ({
  id: `SYN:noise-${index + 1}`, kind: 'DetectorSignal', sourceId: `synthetic-noise-source:${index + 1}`,
  origin: 'synthetic_noise_shape', detector: 'concept-symbol-residue', text,
  historicalReferences: ['B-cdf6:F-070', 'B-META-framework-audit:F-035'],
  gateEvidence: false,
}));

export const queries = [
  { id: 'P7_EXACT_PATH', field: 'path', value: 'packages/main/src/core/done-required-timeout-budget.ts', expected: ['B-cdf6:F-060', 'B-cdf6:F-062'] },
  { id: 'P7_EXACT_SYMBOL', field: 'symbol', value: 'buildRequiredCommandEnv', expected: ['B-cdf6:F-065'] },
  { id: 'P7_EXACT_PACKAGE', field: 'package', value: 'packages/main', expected: ['B-cdf6:F-060', 'B-cdf6:F-061', 'B-cdf6:F-062', 'B-cdf6:F-065'] },
  { id: 'P7_EXACT_CONTRACT', field: 'affectedContract', value: 'canonical allowlist preserves explicit session override', expected: ['B-cdf6:F-061'] },
  { id: 'P7_NEGATIVE_SYMBOL', field: 'symbol', value: 'thisSymbolDoesNotExist', expected: [] },
];

export const caseIds = [
  'P3_RAW_SIGNAL_CONTROL', 'P3_AUTHORITY_SUBSTITUTION', 'P3_EXPLICIT_DUPLICATE', 'P3_DISTINCT_SIBLINGS',
  'P5_CANONICAL_CORRECTION', ...queries.map(q => q.id), 'P7_CURRENT_ONLY',
  'P1_SOURCE_COVERAGE', 'P1_DISTINCT_DEFECT_SAFETY', 'P1_GROUPING_SAVINGS', 'P1_JOINT_PENDING',
];

export const corpus = { registration, historicalSources, historicalProjectionKeys, historicalProjectionHashes, baselineRuntime, observations, labels, corrections, noise, queries, caseIds };
// SHA-256 of JSON.stringify(corpus), frozen before production implementation.
export const corpusDigest = '9a0f604195d80272811d31e126841426ac0d4f4d59c38265ab6938a044cabb2d';
