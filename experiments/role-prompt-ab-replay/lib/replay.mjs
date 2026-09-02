import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const SUPPORTED_PROTOCOL = 'proofbound.role-prompt-ab.protocol.v1';
export const SUPPORTED_CORPUS = 'proofbound.role-prompt-ab.corpus.v1';
export const STORY5_ROLE_CAMPAIGN_SCHEMA = 'proofbound.role-prompt-ab.role-campaign.v1';
export const EXPERIMENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function unavailableProviderDimensions(provider) {
  const reason = `No content-addressed ${provider} provider receipt is bound to the frozen B-235e campaign.`;
  return {
    inputTokens: { availability: 'unavailable', reason },
    outputTokens: { availability: 'unavailable', reason },
    cacheReadInputTokens: { availability: 'unavailable', reason },
    cacheCreationInputTokens: { availability: 'unavailable', reason },
    uncachedInputTokens: { availability: 'unavailable', reason },
    latencyMs: { availability: 'unavailable', reason },
    providerProcessedInputTokens: { availability: 'unavailable', reason },
  };
}

export const STORY5_ROLE_CAMPAIGN = Object.freeze({
  schemaVersion: STORY5_ROLE_CAMPAIGN_SCHEMA,
  campaignId: 'B-235e-active-reviewers-v1',
  status: 'frozen',
  namespace: 'experiment-only',
  gateEvidence: false,
  sourceExperiment: {
    protocolDigest: '2e0abcbd2b8e5b7ce3cd0d314b02c7f3c4af9bab874d2c3aa9ff5ae0ce960756',
    corpusDigest: 'ff401b19d1fba4238da6c48b82cab486981b496ca0139a70ed142bfbd2053e45',
    sampleIds: [
      'clean-pass-01',
      'clean-pass-02',
      'critical-01',
      'critical-02',
      'closeout-01',
      'closeout-02',
    ],
  },
  roles: [
    {
      roleId: 'proof-or-stop-review-behavior',
      artifactPath: 'packages/main/templates/agents/proof-or-stop-review-behavior.md',
      legacy: { bytes: 14505, sha256: 'bbb6815ba8131f9fa7b25fd2fa82a9d91890dc56f1c5e43b814cba8b55e4e582' },
      modular: { bytes: 9434, sha256: '36a32b748fa951a7dff68136d5ee5cca2cf33ae5c0d607f1881ad49a527bc294' },
    },
    {
      roleId: 'proof-or-stop-review-concept',
      artifactPath: 'packages/main/templates/agents/proof-or-stop-review-concept.md',
      legacy: { bytes: 10279, sha256: '960bf0df46737570bbf55ebaefa3776272fe25b302f76bbde5c57e289a5db70c' },
      modular: { bytes: 5208, sha256: 'cd849d08a65c9fcd3fa1317f46e4b03b9bad67fd3fed33df33d6a8195122953f' },
    },
    {
      roleId: 'proof-or-stop-review-docs',
      artifactPath: 'packages/main/templates/agents/proof-or-stop-review-docs.md',
      legacy: { bytes: 12749, sha256: 'e26caaf232929404a9ddd6e772e743ef87d5d67fdaedcde75123e6ed58f027c5' },
      modular: { bytes: 7678, sha256: 'e4d2d75c54925ca398c8a9278e2ebe21298f623b8111a53abc3767ef9c7f7f8c' },
    },
    {
      roleId: 'proof-or-stop-review-quality',
      artifactPath: 'packages/main/templates/agents/proof-or-stop-review-quality.md',
      legacy: { bytes: 10730, sha256: 'f8122f08bef477636732a450148dd567bf835c22636c842881a9162d1265b031' },
      modular: { bytes: 5659, sha256: '5ceef86e65ecbf577a2f1f647654d480644b091f7b470023980d4588726f89d3' },
    },
    {
      roleId: 'proof-or-stop-review-test-coverage',
      artifactPath: 'packages/main/templates/agents/proof-or-stop-review-test-coverage.md',
      legacy: { bytes: 4937, sha256: '1d3e1705db33a4c801cc516f242bca3b2665dd94d8157801beaa2e07b208310a' },
      modular: { bytes: 2914, sha256: 'bc152cd5c25683a804c87ef167e97287ebe990ec01c00d5915e9f8e525868a1b' },
    },
  ],
  arms: [
    { id: 'legacy-full', roleBody: 'legacy', contextMode: 'full', contractVersion: 'legacy-full-context.v1' },
    { id: 'modular-full', roleBody: 'modular', contextMode: 'full', contractVersion: 'proofbound.prompt-envelope.v1' },
    { id: 'modular-incremental', roleBody: 'modular', contextMode: 'incremental', contractVersion: 'proofbound.prompt-envelope.v1' },
  ],
  executionEnvelope: {
    model: 'historical-observation-only.v1',
    tools: ['Read', 'Glob', 'Grep', 'Bash'],
    repetitions: 3,
    orderByRepetition: [
      ['legacy-full', 'modular-full', 'modular-incremental'],
      ['modular-incremental', 'legacy-full', 'modular-full'],
      ['modular-full', 'modular-incremental', 'legacy-full'],
    ],
    providerSeed: {
      availability: 'unavailable',
      reason: 'The frozen historical observation does not expose a provider seed.',
    },
  },
  thresholds: {
    criticalSeededDetection: 1,
    systematicHighMissesAllowed: 0,
    minimumIncrementalContextReduction: 0.5,
    targetAssembledPromptReduction: 0.4,
  },
  adjudication: {
    status: 'unavailable',
    reasonCode: 'ADJUDICATION_EVIDENCE_UNVERIFIED',
    planDigest: 'e0e6f7d901984da7241b3ee570539941c714ada0a92f3f61cb74c32cafddea77',
  },
  assembledPromptEvidence: {
    availability: 'unavailable',
    reason: 'The frozen Story 3 corpus has no exact per-role full/incremental Prompt Envelope bytes or reviewer outputs.',
  },
  providerUsage: {
    claude: unavailableProviderDimensions('claude'),
    codex: unavailableProviderDimensions('codex'),
  },
});
export const STORY5_ROLE_CAMPAIGN_DIGEST = '499e002a73d242449244a687acfc40954649057e64882abfde15f566bf86150e';

export class ReplayContractError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'ReplayContractError';
    this.code = code;
  }
}

function compareCodePoints(left, right) {
  const a = Array.from(left, char => char.codePointAt(0));
  const b = Array.from(right, char => char.codePointAt(0));
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

export function canonicalJson(value) {
  const ancestors = new Set();
  const encode = (candidate, at = '$') => {
    if (candidate === null) return 'null';
    if (typeof candidate === 'string' || typeof candidate === 'boolean') return JSON.stringify(candidate);
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new ReplayContractError('NON_CANONICAL_VALUE', `${at} must be finite`);
      return Object.is(candidate, -0) ? '0' : JSON.stringify(candidate);
    }
    if (typeof candidate !== 'object') throw new ReplayContractError('NON_CANONICAL_VALUE', `${at} contains ${typeof candidate}`);
    if (ancestors.has(candidate)) throw new ReplayContractError('NON_CANONICAL_VALUE', `${at} is cyclic`);
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        for (let index = 0; index < candidate.length; index += 1) {
          if (!Object.hasOwn(candidate, index)) throw new ReplayContractError('NON_CANONICAL_VALUE', `${at} is sparse`);
        }
        return `[${candidate.map((child, index) => encode(child, `${at}[${index}]`)).join(',')}]`;
      }
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new ReplayContractError('NON_CANONICAL_VALUE', `${at} must be a plain object`);
      }
      const keys = Object.keys(candidate).sort(compareCodePoints);
      return `{${keys.map(key => `${JSON.stringify(key)}:${encode(candidate[key], `${at}.${key}`)}`).join(',')}}`;
    } finally {
      ancestors.delete(candidate);
    }
  };
  return encode(value);
}

export function digest(domain, value) {
  return createHash('sha256')
    .update(`proofbound.digest.v1\0${domain}\0`, 'utf8')
    .update(typeof value === 'string' ? value : canonicalJson(value), 'utf8')
    .digest('hex');
}

function rawSha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function evaluateStory5RoleCampaign(campaign, protocol, corpus, roleBodies) {
  assertObject(campaign, 'ROLE_CAMPAIGN_INVALID', 'role campaign must be an object');
  if (campaign.schemaVersion !== STORY5_ROLE_CAMPAIGN_SCHEMA
      || campaign.status !== 'frozen'
      || campaign.namespace !== 'experiment-only'
      || campaign.gateEvidence !== false) {
    throw new ReplayContractError('ROLE_CAMPAIGN_INVALID', 'campaign version/status/evidence boundary is invalid');
  }
  if (digest('role-prompt-ab.role-campaign.v1', campaign) !== STORY5_ROLE_CAMPAIGN_DIGEST) {
    throw new ReplayContractError('ROLE_CAMPAIGN_DIGEST_MISMATCH', 'frozen campaign manifest was changed');
  }
  const sourceIdentity = validateExperiment(protocol, corpus);
  if (campaign.sourceExperiment.protocolDigest !== sourceIdentity.protocolDigest
      || campaign.sourceExperiment.corpusDigest !== sourceIdentity.corpusDigest
      || canonicalJson(campaign.sourceExperiment.sampleIds) !== canonicalJson(corpus.samples.map(sample => sample.id))) {
    throw new ReplayContractError('STORY3_CORPUS_DRIFT', 'B-235e must reuse the exact frozen Story 3 protocol/corpus');
  }
  const expectedRoles = [
    'proof-or-stop-review-behavior',
    'proof-or-stop-review-concept',
    'proof-or-stop-review-docs',
    'proof-or-stop-review-quality',
    'proof-or-stop-review-test-coverage',
  ];
  if (!Array.isArray(campaign.roles)
      || canonicalJson(campaign.roles.map(role => role.roleId)) !== canonicalJson(expectedRoles)
      || new Set(campaign.roles.map(role => role.roleId)).size !== expectedRoles.length) {
    throw new ReplayContractError('ROLE_CAMPAIGN_ROLE_SET_INVALID', 'campaign must contain each active reviewer role exactly once');
  }
  const expectedArms = ['legacy-full', 'modular-full', 'modular-incremental'];
  if (!Array.isArray(campaign.arms)
      || canonicalJson(campaign.arms.map(arm => arm.id)) !== canonicalJson(expectedArms)) {
    throw new ReplayContractError('ROLE_CAMPAIGN_ARM_SET_INVALID', 'campaign arms must be frozen and symmetric');
  }
  if (campaign.executionEnvelope?.repetitions < 3
      || campaign.executionEnvelope.orderByRepetition?.length !== campaign.executionEnvelope.repetitions) {
    throw new ReplayContractError('REPEAT_FLOOR_INCOMPLETE', 'role campaign requires at least three complete repetitions');
  }
  for (const order of campaign.executionEnvelope.orderByRepetition) {
    if (canonicalJson([...order].sort(compareCodePoints)) !== canonicalJson([...expectedArms].sort(compareCodePoints))) {
      throw new ReplayContractError('INVALID_RUN_ORDER', 'every role campaign repetition must include all arms once');
    }
  }
  const adjudicationPlan = {
    matcher: 'semantic-category-source-claim.v1',
    independentRequired: true,
    falsePositiveReview: true,
    commandMisuseReview: true,
  };
  if (campaign.adjudication?.planDigest
      !== digest('role-prompt-ab.role-campaign-adjudication-plan.v1', adjudicationPlan)) {
    throw new ReplayContractError('ADJUDICATION_EVIDENCE_UNVERIFIED', 'independent adjudication plan digest is invalid');
  }
  if (campaign.adjudication.status !== 'unavailable'
      || campaign.adjudication.reasonCode !== 'ADJUDICATION_EVIDENCE_UNVERIFIED') {
    throw new ReplayContractError('ADJUDICATION_EVIDENCE_UNVERIFIED', 'unverified historical quality cannot be promoted');
  }
  for (const [provider, dimensions] of Object.entries(campaign.providerUsage ?? {})) {
    for (const dimension of [
      'inputTokens',
      'outputTokens',
      'cacheReadInputTokens',
      'cacheCreationInputTokens',
      'uncachedInputTokens',
      'latencyMs',
      'providerProcessedInputTokens',
    ]) {
      const observation = dimensions?.[dimension];
      if (observation?.availability !== 'unavailable'
          || typeof observation.reason !== 'string'
          || !observation.reason.trim()
          || Object.hasOwn(observation, 'tokens')
          || Object.hasOwn(observation, 'value')) {
        throw new ReplayContractError(
          'PROVIDER_USAGE_EVIDENCE_UNAVAILABLE',
          `${provider}.${dimension} must remain unavailable with a stable reason`,
        );
      }
    }
  }
  assertObject(roleBodies, 'PROMPT_SNAPSHOT_UNAVAILABLE', 'exact role body snapshots are required');
  const results = campaign.roles.map(role => {
    const bodies = roleBodies[role.roleId];
    if (!bodies || typeof bodies.legacy !== 'string' || typeof bodies.modular !== 'string') {
      throw new ReplayContractError('PROMPT_SNAPSHOT_UNAVAILABLE', `${role.roleId} exact role bodies are unavailable`);
    }
    for (const mode of ['legacy', 'modular']) {
      if (Buffer.byteLength(bodies[mode], 'utf8') !== role[mode].bytes
          || rawSha256(bodies[mode]) !== role[mode].sha256) {
        throw new ReplayContractError('PROMPT_SNAPSHOT_DIGEST_MISMATCH', `${role.roleId}/${mode} snapshot drift`);
      }
    }
    const roleBodyReduction = 1 - (role.modular.bytes / role.legacy.bytes);
    return {
      roleId: role.roleId,
      verdict: 'INCONCLUSIVE',
      reasonCode: campaign.adjudication.reasonCode,
      seededCriticalDetection: null,
      systematicHighMisses: null,
      falsePositiveCount: null,
      commandMisuseCount: null,
      legacyRoleBodyTokens: Math.ceil(role.legacy.bytes / 4),
      modularRoleBodyTokens: Math.ceil(role.modular.bytes / 4),
      roleBodyReduction,
      incrementalContextReduction: null,
      assembledPromptReduction: null,
      assembledTargetMet: null,
      providerUsage: campaign.providerUsage,
      gateEvidence: false,
    };
  });
  return {
    schemaVersion: 'proofbound.role-prompt-ab.role-campaign-result.v1',
    campaignId: campaign.campaignId,
    campaignDigest: STORY5_ROLE_CAMPAIGN_DIGEST,
    status: 'INCONCLUSIVE',
    reasonCode: 'ADJUDICATION_EVIDENCE_UNVERIFIED',
    eligibleIncrementalDenominator: 0,
    savingsClaim: null,
    recallClaim: null,
    gateEvidence: false,
    results,
    resultDigest: digest('role-prompt-ab.role-campaign-result.v1', results),
  };
}

function assertObject(value, code, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ReplayContractError(code, message);
}

function assertExactKeys(value, keys, at) {
  assertObject(value, 'INVALID_SHAPE', `${at} must be an object`);
  const actual = Object.keys(value).sort(compareCodePoints);
  const expected = [...keys].sort(compareCodePoints);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new ReplayContractError('INVALID_SHAPE', `${at} keys must be exactly ${expected.join(',')}`);
  }
}

function safeRepoPath(value, at) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || path.posix.isAbsolute(value)) {
    throw new ReplayContractError('PATH_ESCAPE', `${at} must be a non-empty repository-relative POSIX path`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new ReplayContractError('PATH_ESCAPE', `${at} escapes or is not canonical`);
  }
  return normalized;
}

function validateAvailability(value, at) {
  assertObject(value, 'INVALID_AVAILABILITY', `${at} must be an object`);
  if (value.availability === 'available') {
    assertExactKeys(value, ['availability', 'tokens', 'source'], at);
    if (!Number.isSafeInteger(value.tokens) || value.tokens < 0 || typeof value.source !== 'string' || !value.source.trim()) {
      throw new ReplayContractError('INVALID_AVAILABILITY', `${at} available tokens/source are invalid`);
    }
    return;
  }
  if (value.availability === 'unavailable') {
    assertExactKeys(value, ['availability', 'reason'], at);
    if (typeof value.reason !== 'string' || !value.reason.trim()) {
      throw new ReplayContractError('INVALID_AVAILABILITY', `${at} requires a stable reason`);
    }
    return;
  }
  throw new ReplayContractError('INVALID_AVAILABILITY', `${at} availability must be available or unavailable`);
}

function validateHistoricalObservation(value, at) {
  validateAvailability(value, at);
  if (value.availability === 'available') {
    throw new ReplayContractError(
      'UNBOUND_HISTORICAL_METRIC',
      `${at} is numeric but this corpus schema has no mechanically verified evidenceRef/evidenceDigest binding`,
    );
  }
}

export function materialDigest(sample) {
  return digest('role-prompt-ab.material.v1', {
    task: sample.task,
    material: sample.material,
    tools: sample.tools,
  });
}

export function findingSetDigest(sample) {
  return digest('role-prompt-ab.finding-set.v1', {
    oracles: sample.oracles,
  });
}

export function historicalFindingSnapshotDigest(findings) {
  return digest('role-prompt-ab.historical-finding-snapshot.v1', findings);
}

function findingSignature(finding) {
  return createHash('sha256')
    .update([
      finding.storyId,
      finding.findingId,
      finding.desc,
      finding.severity,
      finding.createdAt,
      finding.reviewRound,
      finding.reviewRunId,
      finding.signatureVersion,
    ].join(':'), 'utf8')
    .digest('hex');
}

function validateSourceRef(sourceRef, findingId) {
  if (typeof sourceRef !== 'string' || !sourceRef.trim()) {
    throw new ReplayContractError('HISTORICAL_FINDING_REFERENCE_INVALID', `${findingId} source reference must be nonblank`);
  }
  const pathPart = sourceRef.replace(/:[0-9][0-9,-]*$/, '');
  safeRepoPath(pathPart, `${findingId}.sourceRefs`);
}

function validateHistoricalFinding(finding, findingIds) {
  assertExactKeys(
    finding,
    [
      'storyId',
      'findingId',
      'reviewRunId',
      'severity',
      'category',
      'evidenceState',
      'createdAt',
      'reviewRound',
      '_hash',
      'desc',
      'sourceRefs',
      'signatureVersion',
    ],
    'historical finding',
  );
  if (!/^B-[a-z0-9]+$/.test(finding.storyId)
      || !finding.findingId.startsWith(`${finding.storyId}:F-`)
      || !finding.reviewRunId.startsWith(`${finding.storyId}:RR-`)) {
    throw new ReplayContractError(
      'HISTORICAL_FINDING_REFERENCE_INVALID',
      `${finding.findingId} story/finding/review-run references are incoherent`,
    );
  }
  if (findingIds.has(finding.findingId)) {
    throw new ReplayContractError('DUPLICATE_HISTORICAL_FINDING', `duplicate ${finding.findingId}`);
  }
  findingIds.add(finding.findingId);
  if (!['critical', 'high'].includes(finding.severity)
      || !['happy', 'edge', 'adversarial', 'missing'].includes(finding.category)
      || finding.evidenceState !== 'verified'
      || typeof finding.desc !== 'string'
      || !finding.desc.trim()
      || !Array.isArray(finding.sourceRefs)
      || finding.sourceRefs.length === 0
      || finding.signatureVersion !== 'lattice-finding-integrity-v1') {
    throw new ReplayContractError('HISTORICAL_FINDING_INVALID', `${finding.findingId} signed snapshot fields are invalid`);
  }
  for (const sourceRef of finding.sourceRefs) validateSourceRef(sourceRef, finding.findingId);
  if (!/^[a-f0-9]{64}$/.test(finding._hash) || finding._hash !== findingSignature(finding)) {
    throw new ReplayContractError(
      'HISTORICAL_FINDING_SIGNATURE_INVALID',
      `${finding.findingId} does not match its lattice-finding-integrity-v1 signature`,
    );
  }
}

function validateOracle(oracle, sampleId, oracleIds) {
  assertExactKeys(
    oracle,
    ['id', 'category', 'severity', 'trigger', 'sourceBinding', 'claimBinding', 'adjudication'],
    `sample ${sampleId} oracle`,
  );
  if (oracleIds.has(oracle.id)) throw new ReplayContractError('DUPLICATE_ORACLE', `duplicate oracle ${oracle.id}`);
  oracleIds.add(oracle.id);
  if (!['critical', 'high'].includes(oracle.severity)) {
    throw new ReplayContractError('INVALID_ADJUDICATION', `${oracle.id} severity must be critical or high`);
  }
  for (const key of ['id', 'category', 'trigger', 'sourceBinding', 'claimBinding']) {
    if (typeof oracle[key] !== 'string' || !oracle[key].trim()) {
      throw new ReplayContractError('INVALID_ADJUDICATION', `${oracle.id}.${key} must be nonblank`);
    }
  }
  assertExactKeys(oracle.adjudication, ['status', 'reason'], `${oracle.id}.adjudication`);
  if (oracle.adjudication.status !== 'oracle-only-unverified'
      || typeof oracle.adjudication.reason !== 'string' || !oracle.adjudication.reason.trim()) {
    throw new ReplayContractError(
      'ADJUDICATION_EVIDENCE_UNVERIFIED',
      `${oracle.id} may only seed future truth until independently adjudicated evidence bytes and digest are pinned`,
    );
  }
}

export function validateExperiment(protocol, corpus) {
  assertObject(protocol, 'UNSUPPORTED_PROTOCOL_VERSION', 'protocol must be an object');
  if (protocol.schemaVersion !== SUPPORTED_PROTOCOL) {
    throw new ReplayContractError('UNSUPPORTED_PROTOCOL_VERSION', String(protocol.schemaVersion));
  }
  if (protocol.status !== 'frozen') throw new ReplayContractError('PROTOCOL_NOT_FROZEN', 'protocol status must be frozen');
  if (!Array.isArray(protocol.arms) || protocol.arms.length !== 2 || new Set(protocol.arms.map(arm => arm.id)).size !== 2) {
    throw new ReplayContractError('INVALID_ARMS', 'exactly two unique arms are required');
  }
  const armIds = protocol.arms.map(arm => arm.id);
  for (const arm of protocol.arms) {
    if (typeof arm.promptContract !== 'string' || !arm.promptContract.trim()) {
      throw new ReplayContractError('INVALID_ARMS', `${arm.id} promptContract must be nonblank`);
    }
    validateAvailability(arm.promptSnapshot, `protocol.arms.${arm.id}.promptSnapshot`);
    if (arm.promptSnapshot.availability !== 'unavailable') {
      throw new ReplayContractError(
        'UNBOUND_PROMPT_SNAPSHOT',
        `${arm.id} prompt bytes require content-addressed snapshot content and digest`,
      );
    }
  }
  if (protocol.sameInputRule?.onlyPermittedDifference !== 'promptContract') {
    throw new ReplayContractError('ARM_INPUT_DRIFT', 'only promptContract may differ between arms');
  }
  const requiredInputLayers = {
    assembledPrompt: 'unavailable-without-content-addressed-prompt-snapshot',
    knownDispatchInput: 'unavailable-without-verified-evidence-binding',
    providerProcessedInput: 'unavailable-without-verified-evidence-binding',
    cacheCreation: 'unavailable-without-verified-evidence-binding',
    cacheRead: 'unavailable-without-verified-evidence-binding',
  };
  if (canonicalJson(protocol.inputLayers) !== canonicalJson(requiredInputLayers)) {
    throw new ReplayContractError(
      'INVALID_INPUT_LAYER_SEMANTICS',
      'protocol inputLayers must match the canonical availability-aware unavailable snapshot boundary',
    );
  }
  const repeats = protocol.sampling?.repeats;
  if (!Number.isSafeInteger(repeats) || repeats < 3 || repeats < protocol.requiredCorpus?.minimumRepeats) {
    throw new ReplayContractError('REPEAT_FLOOR_INCOMPLETE', 'at least three repeats are required');
  }
  if (!Array.isArray(protocol.sampling.armOrderByRepeat) || protocol.sampling.armOrderByRepeat.length !== repeats) {
    throw new ReplayContractError('REPEAT_FLOOR_INCOMPLETE', 'one arm order is required per repeat');
  }
  for (const order of protocol.sampling.armOrderByRepeat) {
    if (canonicalJson([...order].sort()) !== canonicalJson([...armIds].sort())) {
      throw new ReplayContractError('INVALID_RUN_ORDER', 'each repeat must contain each arm exactly once');
    }
  }
  for (const key of ['temperature', 'providerSeed', 'toolChoice']) {
    validateAvailability(protocol.sampling[key], `protocol.sampling.${key}`);
  }

  assertObject(corpus, 'UNSUPPORTED_CORPUS_VERSION', 'corpus must be an object');
  if (corpus.schemaVersion !== SUPPORTED_CORPUS) {
    throw new ReplayContractError('UNSUPPORTED_CORPUS_VERSION', String(corpus.schemaVersion));
  }
  if (corpus.status !== 'frozen' || !Array.isArray(corpus.samples)) {
    throw new ReplayContractError('CORPUS_NOT_FROZEN', 'corpus must be frozen and contain samples');
  }
  if (!Array.isArray(corpus.historicalFindingSnapshot) || corpus.historicalFindingSnapshot.length === 0) {
    throw new ReplayContractError('HISTORICAL_FINDING_MISSING', 'signed historical finding snapshot is required');
  }
  const historicalFindingIds = new Set();
  for (const finding of corpus.historicalFindingSnapshot) {
    validateHistoricalFinding(finding, historicalFindingIds);
  }
  if (corpus.historicalFindingSnapshotDigest
      !== historicalFindingSnapshotDigest(corpus.historicalFindingSnapshot)) {
    throw new ReplayContractError(
      'HISTORICAL_FINDING_SNAPSHOT_DIGEST_MISMATCH',
      'historical finding snapshot digest mismatch',
    );
  }
  const requiredClasses = protocol.requiredCorpus.classes;
  const minimum = protocol.requiredCorpus.minimumSamplesPerClass;
  const counts = new Map(requiredClasses.map(name => [name, 0]));
  const sampleIds = new Set();
  for (const sample of corpus.samples) {
    assertObject(sample, 'INVALID_SAMPLE', 'sample must be an object');
    if (sampleIds.has(sample.id)) throw new ReplayContractError('DUPLICATE_SAMPLE', `duplicate sample ${sample.id}`);
    sampleIds.add(sample.id);
    if (!counts.has(sample.class)) throw new ReplayContractError('UNKNOWN_SAMPLE_CLASS', `${sample.id}: ${sample.class}`);
    counts.set(sample.class, counts.get(sample.class) + 1);
    if (typeof sample.task !== 'string' || !sample.task.trim() || !Array.isArray(sample.tools)) {
      throw new ReplayContractError('INVALID_SAMPLE', `${sample.id} task/tools invalid`);
    }
    assertObject(sample.material, 'MATERIAL_MISSING', `${sample.id} material missing`);
    if (sample.material.sourceKind !== 'inline-corpus-snapshot'
        || sample.material.snapshotAuthority !== 'corpus-json-content-addressed.v1') {
      throw new ReplayContractError(
        'MUTABLE_MATERIAL',
        `${sample.id} material must use content-addressed inline corpus authority`,
      );
    }
    safeRepoPath(sample.material.sourceHintPath, `${sample.id}.sourceHintPath`);
    if (sample.material.snapshotId !== sample.id) {
      throw new ReplayContractError('MATERIAL_MISSING', `${sample.id} snapshotId must equal sample id`);
    }
    assertObject(sample.material.content, 'MATERIAL_MISSING', `${sample.id} pinned snapshot content missing`);
    if (typeof sample.materialDigest !== 'string' || sample.materialDigest !== materialDigest(sample)) {
      throw new ReplayContractError('MATERIAL_DIGEST_MISMATCH', `${sample.id} material digest mismatch`);
    }
    if (!Array.isArray(sample.oracles)) throw new ReplayContractError('ADJUDICATION_MISSING', `${sample.id} oracles missing`);
    const oracleIds = new Set();
    for (const oracle of sample.oracles) validateOracle(oracle, sample.id, oracleIds);
    if (typeof sample.findingSetDigest !== 'string' || sample.findingSetDigest !== findingSetDigest(sample)) {
      throw new ReplayContractError('FINDING_DIGEST_MISMATCH', `${sample.id} finding-set digest mismatch`);
    }
    assertObject(sample.providerObservation, 'INVALID_AVAILABILITY', `${sample.id} provider observation missing`);
    const observationKeys = [
      'knownDispatchInputTokens',
      'providerProcessedInputTokens',
      'uncachedInputTokens',
      'cacheCreationInputTokens',
      'cacheReadInputTokens',
      'outputTokens',
    ].sort(compareCodePoints);
    if (canonicalJson(Object.keys(sample.providerObservation).sort(compareCodePoints)) !== canonicalJson(observationKeys)) {
      throw new ReplayContractError(
        'INVALID_AVAILABILITY',
        `${sample.id} provider observation must carry every availability-aware dimension`,
      );
    }
    for (const [key, observation] of Object.entries(sample.providerObservation)) {
      validateHistoricalObservation(observation, `${sample.id}.${key}`);
    }
  }
  for (const [className, count] of counts) {
    if (count < minimum) throw new ReplayContractError('SAMPLE_FLOOR_INCOMPLETE', `${className} has ${count}, requires ${minimum}`);
  }
  const seededOracleCount = corpus.samples.flatMap(sample => sample.oracles).length;
  return {
    experimentId: digest('role-prompt-ab.experiment.v1', { protocol, corpus }),
    protocolDigest: digest('role-prompt-ab.protocol.v1', protocol),
    corpusDigest: digest('role-prompt-ab.corpus.v1', corpus),
    classes: counts.size,
    samples: corpus.samples.length,
    repeats,
    seededOracleCount,
    signedHistoricalFindings: corpus.historicalFindingSnapshot.length,
    adjudicatedFindings: 0,
    recallStatus: 'INCONCLUSIVE',
    recallReasonCode: 'ADJUDICATION_EVIDENCE_UNVERIFIED',
  };
}

function findingComparison(sample, armId) {
  return {
    findingSetDigest: sample.findingSetDigest,
    armId,
    seededOracleCount: sample.oracles.length,
    detectedCount: null,
    criticalAllDetected: null,
    recall: null,
    status: 'INCONCLUSIVE',
    reasonCode: sample.oracles.length === 0
      ? 'FINDING_OUTPUT_UNAVAILABLE'
      : 'ADJUDICATION_EVIDENCE_UNVERIFIED',
  };
}

function measureBoundPrompt(text) {
  if (typeof text !== 'string') throw new ReplayContractError('PROMPT_SNAPSHOT_INVALID', 'prompt snapshot content must be text');
  const bytes = Buffer.byteLength(text, 'utf8');
  return {
    status: 'EVALUABLE',
    reasonCode: null,
    bytes,
    lines: text.length === 0 ? 0 : 1 + (text.match(/\n/g)?.length ?? 0),
    estimatedTokens: bytes === 0 ? 0 : Math.ceil(bytes / 4),
    promptDigest: digest('assembled-prompt.raw-utf8.v1', text),
  };
}

/**
 * Positive evaluator for hermetic selfcheck fixtures only. It proves the
 * measurement/matching machinery when every input is inline and
 * content-addressed. It is not historical or production evidence.
 */
export function evaluateBoundFixture(fixture) {
  assertObject(fixture, 'HERMETIC_FIXTURE_INVALID', 'fixture must be an object');
  if (fixture.schemaVersion !== 'proofbound.role-prompt-ab.hermetic-fixture.v1'
      || !Array.isArray(fixture.arms)
      || !Array.isArray(fixture.reviewerOutputs)) {
    throw new ReplayContractError('HERMETIC_FIXTURE_INVALID', 'fixture shape/version invalid');
  }
  const armIds = fixture.arms.map(arm => arm?.id);
  if (canonicalJson([...new Set(armIds)].sort()) !== canonicalJson(['A', 'B'])
      || armIds.length !== 2) {
    throw new ReplayContractError('HERMETIC_ARM_SET_INVALID', 'fixture arms must be exactly one A and one B');
  }
  const outputArmIds = fixture.reviewerOutputs.map(output => output?.armId);
  if (canonicalJson([...new Set(outputArmIds)].sort()) !== canonicalJson(['A', 'B'])
      || outputArmIds.length !== 2) {
    throw new ReplayContractError(
      'HERMETIC_OUTPUT_SET_INVALID',
      'reviewer outputs must be exactly one output for A and one output for B',
    );
  }
  const oracleSetDigest = digest('role-prompt-ab.hermetic-oracle-set.v1', fixture.oracles);
  if (fixture.oracleSetDigest !== oracleSetDigest) {
    throw new ReplayContractError('FINDING_DIGEST_MISMATCH', 'hermetic oracle set digest mismatch');
  }
  const oracleById = new Map(fixture.oracles.map(oracle => [oracle.id, oracle]));
  const outputByArm = new Map(fixture.reviewerOutputs.map(output => [output.armId, output]));
  const cells = [];
  const derivedMatches = [];
  for (const arm of fixture.arms) {
    assertObject(arm.promptSnapshot, 'PROMPT_SNAPSHOT_INVALID', `${arm.id} promptSnapshot missing`);
    const snapshotDigest = digest('role-prompt-ab.hermetic-prompt-snapshot.v1', arm.promptSnapshot.content);
    if (snapshotDigest !== arm.promptSnapshot.contentDigest) {
      throw new ReplayContractError('PROMPT_SNAPSHOT_DIGEST_MISMATCH', `${arm.id} prompt snapshot digest mismatch`);
    }
    const contractMarker = `PROMPT CONTRACT: ${arm.promptContract}\n`;
    if (!arm.promptSnapshot.content.startsWith(contractMarker)) {
      throw new ReplayContractError(
        'PROMPT_CONTRACT_SNAPSHOT_MISMATCH',
        `${arm.id} prompt bytes do not bind promptContract ${arm.promptContract}`,
      );
    }
    const output = outputByArm.get(arm.id);
    if (!output || digest('role-prompt-ab.hermetic-reviewer-output.v1', output.content) !== output.contentDigest) {
      throw new ReplayContractError('FINDING_OUTPUT_DIGEST_MISMATCH', `${arm.id} output missing or digest-invalid`);
    }
    if (!Array.isArray(output.content.findings)) {
      throw new ReplayContractError('FINDING_OUTPUT_INVALID', `${arm.id} findings must be an array`);
    }
    const detected = new Set();
    for (const finding of output.content.findings) {
      const oracle = oracleById.get(finding.oracleId);
      if (oracle
          && finding.category === oracle.category
          && finding.sourceBinding === oracle.sourceBinding
          && finding.claimBinding === oracle.claimBinding) {
        detected.add(oracle.id);
      }
    }
    const seeded = fixture.oracles.length;
    const match = {
      armId: arm.id,
      seededOracleCount: seeded,
      detectedCount: detected.size,
      criticalAllDetected: fixture.oracles
        .filter(oracle => oracle.severity === 'critical')
        .every(oracle => detected.has(oracle.id)),
      recall: seeded === 0 ? null : detected.size / seeded,
    };
    derivedMatches.push(match);
    cells.push({
      armId: arm.id,
      promptContract: arm.promptContract,
      promptSnapshotDigest: snapshotDigest,
      measurement: measureBoundPrompt(arm.promptSnapshot.content),
      findingComparison: { ...match, status: seeded === 0 ? 'INCONCLUSIVE' : 'EVALUABLE' },
    });
  }
  assertObject(fixture.independentAdjudication, 'ADJUDICATION_MISSING', 'independentAdjudication missing');
  if (digest(
    'role-prompt-ab.hermetic-independent-adjudication.v1',
    fixture.independentAdjudication.content,
  ) !== fixture.independentAdjudication.contentDigest) {
    throw new ReplayContractError('ADJUDICATION_EVIDENCE_UNVERIFIED', 'independent adjudication digest mismatch');
  }
  if (canonicalJson(fixture.independentAdjudication.content.matches) !== canonicalJson(derivedMatches)) {
    throw new ReplayContractError('ADJUDICATION_EVIDENCE_UNVERIFIED', 'independent adjudication does not match derived semantics');
  }
  return {
    status: 'EVALUABLE',
    evidenceScope: 'hermetic-selfcheck-only',
    historicalEvidence: false,
    cells,
    resultDigest: digest('role-prompt-ab.hermetic-result.v1', cells),
  };
}

export function replayExperiment(options = {}) {
  assertObject(options, 'INVALID_REPLAY_INPUT', 'replay options must be an object');
  const optionKeys = Object.keys(options).sort(compareCodePoints);
  const allowedKeys = ['armOrder', 'corpus', 'protocol'];
  if (optionKeys.some(key => !allowedKeys.includes(key)) || !optionKeys.includes('protocol') || !optionKeys.includes('corpus')) {
    throw new ReplayContractError('CALLER_SUBSTITUTION_REJECTED', 'only protocol, corpus, and optional armOrder are accepted');
  }
  const { protocol, corpus, armOrder } = options;
  if (armOrder !== undefined && !Array.isArray(armOrder)) {
    throw new ReplayContractError('INVALID_RUN_ORDER', 'armOrder must be an array');
  }
  const identity = validateExperiment(protocol, corpus);
  const arms = new Map(protocol.arms.map(arm => [arm.id, arm]));
  const overrideOrder = armOrder ?? null;
  if (overrideOrder && canonicalJson([...overrideOrder].sort()) !== canonicalJson([...arms.keys()].sort())) {
    throw new ReplayContractError('INVALID_RUN_ORDER', 'armOrder must contain each registered arm exactly once');
  }
  const cells = [];
  for (const sample of corpus.samples) {
    const sharedInput = {
      task: sample.task,
      material: sample.material,
      tools: sample.tools,
      model: protocol.model,
      sampling: protocol.sampling,
    };
    const inputDigest = digest('role-prompt-ab.shared-input.v1', sharedInput);
    for (let repeat = 1; repeat <= protocol.sampling.repeats; repeat += 1) {
      const order = overrideOrder ?? protocol.sampling.armOrderByRepeat[repeat - 1];
      for (const armId of order) {
        const arm = arms.get(armId);
        cells.push({
          cellId: `${sample.id}/${armId}/repeat-${repeat}`,
          sampleId: sample.id,
          sampleClass: sample.class,
          armId,
          repeat,
          inputDigest,
          materialDigest: sample.materialDigest,
          promptContract: arm.promptContract,
          promptContractDigest: digest('role-prompt-ab.prompt-contract.v1', arm),
          measurement: {
            status: 'INCONCLUSIVE',
            reasonCode: 'PROMPT_SNAPSHOT_UNAVAILABLE',
            bytes: null,
            lines: null,
            estimatedTokens: null,
            promptDigest: null,
          },
          providerObservation: sample.providerObservation,
          findingComparison: findingComparison(sample, armId),
        });
      }
    }
  }
  const inputPairs = new Map();
  for (const cell of cells) {
    const previous = inputPairs.get(cell.sampleId);
    if (previous && previous !== cell.inputDigest) throw new ReplayContractError('ARM_INPUT_DRIFT', cell.sampleId);
    inputPairs.set(cell.sampleId, cell.inputDigest);
  }
  return {
    schemaVersion: 'proofbound.role-prompt-ab.replay.v1',
    ...identity,
    sameInput: true,
    deterministic: true,
    gateEvidence: false,
    cells: cells.sort((a, b) => a.cellId.localeCompare(b.cellId, 'en')),
    resultDigest: digest('role-prompt-ab.replay-result.v1', cells.sort((a, b) => a.cellId.localeCompare(b.cellId, 'en'))),
  };
}

export async function loadPinnedExperiment() {
  const [protocolText, corpusText] = await Promise.all([
    readFile(path.join(EXPERIMENT_ROOT, 'protocol.json'), 'utf8'),
    readFile(path.join(EXPERIMENT_ROOT, 'corpus.json'), 'utf8'),
  ]);
  return { protocol: JSON.parse(protocolText), corpus: JSON.parse(corpusText) };
}

export function inconclusive(reasonCode, detail) {
  return {
    status: 'INCONCLUSIVE',
    reasonCode,
    detail,
    savingsClaim: null,
    recallClaim: null,
    gateEvidence: false,
  };
}
