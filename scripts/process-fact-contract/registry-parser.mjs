






import ts from 'typescript';
import nodeAssert from 'node:assert/strict';
import { checkSharedDoneAdapterSources, runSharedDonePredicateProof } from "../../packages/main/tests/red/red-done-shared-predicates.mjs";
import { read, processFactLevelRegistryPath, assert, ALL_PHASES, builtCommandPolicyModule, commandPolicyPath, processFactRegistryPath, flowFactPolicyPath, builtProcessFactRegistryModule, machinePath, failures, doneOraclePath, fail } from './support.mjs';
import { extractExportedArrayBody, extractBalancedBlock, extractExportedObjectBody, assertProcessFactMappedSourceContracts } from './review-inventory.mjs';
import { readQuotedLiteralAt } from './registry-alignment.mjs';

export let cachedProcessFactLevelEntries = null;

export function parseProcessFactLevelRegistry() {
  if (cachedProcessFactLevelEntries) return cachedProcessFactLevelEntries;

  const text = read(processFactLevelRegistryPath);
  const body = extractExportedArrayBody(text, 'PROCESS_FACT_LEVELS');
  const entryPattern = /\{\s*name:\s*'([^']+)'\s*,\s*level:\s*'(L[0-4])'\s*,\s*category:\s*'([^']+)'\s*,\s*owner:\s*'([^']+)'\s*,\s*rationale:\s*'([^']+)'(?:\s*,\s*gateConsumer:\s*'([^']+)')?\s*,?\s*\}/g;
  const entries = [...body.matchAll(entryPattern)].map(match => ({
    name: match[1],
    level: match[2],
    category: match[3],
    owner: match[4],
    rationale: match[5],
    gateConsumer: match[6],
  }));
  const declaredObjectCount = [...body.matchAll(/\{\s*name:\s*'/g)].length;
  assert(entries.length === declaredObjectCount, `${processFactLevelRegistryPath}: every registry entry must declare name/level/category/owner/rationale in parseable order`);
  assert(entries.length > 0, `${processFactLevelRegistryPath}: registry should not be empty`);

  cachedProcessFactLevelEntries = entries;
  return entries;
}

export function parseProcessFactLevelDefinitions() {
  const text = read(processFactLevelRegistryPath);
  const body = extractExportedArrayBody(text, 'PROCESS_FACT_LEVEL_DEFINITIONS');
  return [...body.matchAll(/level:\s*'(L[0-4])'/g)].map(match => match[1]);
}

export let cachedCommandPolicyEntries = null;

export let cachedProcessFactRegistryEntries = null;

export let cachedFlowFactPolicyEntries = null;

export function readStringProperty(block, propertyName) {
  const match = new RegExp(`\\b${propertyName}\\s*:\\s*(['"\`])`).exec(block);
  if (!match) return '';

  const quote = match[1];
  let escaped = false;
  let value = '';
  for (let index = match.index + match[0].length; index < block.length; index += 1) {
    const char = block[index];
    if (escaped) {
      value += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === quote) return value;
    value += char;
  }
  return '';
}

export function parseStringArrayProperty(block, propertyName) {
  const match = new RegExp(`\\b${propertyName}\\s*:\\s*\\[`).exec(block);
  if (!match) return null;
  const openIndex = match.index + match[0].lastIndexOf('[');
  const body = extractBalancedBlock(block, openIndex, '[', ']', `${propertyName} array`);
  const values = [];
  let index = 0;
  while (index < body.length) {
    const quoteIndex = body.slice(index).search(/['"`]/);
    if (quoteIndex === -1) break;
    const absoluteQuoteIndex = index + quoteIndex;
    const quote = body[absoluteQuoteIndex];
    let escaped = false;
    let value = '';
    for (let cursor = absoluteQuoteIndex + 1; cursor < body.length; cursor += 1) {
      const char = body[cursor];
      if (escaped) {
        value += char;
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) {
        values.push(value);
        index = cursor + 1;
        break;
      }
      value += char;
    }
    if (index <= absoluteQuoteIndex) break;
  }
  return values;
}

export function allowedPhasesFromPolicy(policy) {
  if (policy.allowedPhases === 'all') return [...ALL_PHASES];
  if (Array.isArray(policy.allowedPhases)) return [...policy.allowedPhases];
  return [];
}

export function parseCommandPolicyEntries() {
  if (cachedCommandPolicyEntries) return cachedCommandPolicyEntries;

  if (builtCommandPolicyModule?.COMMAND_POLICIES) {
    const policies = builtCommandPolicyModule.COMMAND_POLICIES;
    const entries = Object.entries(policies).map(([name, policy]) => ({
      name,
      block: JSON.stringify(policy),
      status: policy.status || '',
      reason: policy.reason || '',
      replacement: policy.replacement || '',
      destructiveRisk: policy.destructiveRisk || '',
      hasAllowedPhases: policy.allowedPhases === 'all' || Array.isArray(policy.allowedPhases),
      allowedPhases: allowedPhasesFromPolicy(policy),
      rootOnly: policy.rootOnly === true || policy.status === 'rootOnly',
      gateEvidence: policy.gateEvidence === true || policy.status === 'gateEvidence',
    }));
    assert(entries.length > 0, `${commandPolicyPath}: compiled command policy should not be empty`);
    cachedCommandPolicyEntries = entries;
    return entries;
  }

  const text = read(commandPolicyPath);
  const body = extractExportedObjectBody(text, 'COMMAND_POLICIES', commandPolicyPath);
  const entries = [];
  const keyPattern = /^\s*([a-z_][a-z0-9_]*):\s*\{/gm;
  for (const match of body.matchAll(keyPattern)) {
    const name = match[1];
    const openIndex = match.index + match[0].lastIndexOf('{');
    const block = extractBalancedBlock(body, openIndex, '{', '}', `${commandPolicyPath} ${name}`);
    const status = readStringProperty(block, 'status');
    const reason = readStringProperty(block, 'reason');
    const replacement = readStringProperty(block, 'replacement');
    const destructiveRisk = readStringProperty(block, 'destructiveRisk');
    const allowedPhases = /\ballowedPhases\s*:\s*(['"`])all\1/.test(block)
      ? [...ALL_PHASES]
      : (parseStringArrayProperty(block, 'allowedPhases') || []);
    entries.push({
      name,
      block,
      status,
      reason,
      replacement,
      destructiveRisk,
      hasAllowedPhases: /\ballowedPhases\s*:/.test(block),
      allowedPhases,
      rootOnly: /\brootOnly:\s*true\b/.test(block) || status === 'rootOnly',
      gateEvidence: /\bgateEvidence:\s*true\b/.test(block) || status === 'gateEvidence',
    });
  }

  const declaredObjectCount = [...body.matchAll(/^\s*[a-z_][a-z0-9_]*:\s*\{/gm)].length;
  assert(entries.length === declaredObjectCount, `${commandPolicyPath}: every policy entry must be parseable as commandName: { ... }`);
  assert(entries.length > 0, `${commandPolicyPath}: command policy should not be empty`);

  cachedCommandPolicyEntries = entries;
  return entries;
}

export function duplicateNames(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

export function parseTopLevelObjectBlocks(arrayBody, label) {
  const blocks = [];
  for (let index = 0; index < arrayBody.length; index += 1) {
    const char = arrayBody[index];
    if (char === '\'' || char === '"' || char === '`') {
      const literal = readQuotedLiteralAt(arrayBody, index);
      index = literal ? literal.endIndex - 1 : index;
      continue;
    }
    if (char !== '{') continue;
    const block = extractBalancedBlock(arrayBody, index, '{', '}', `${label} entry`);
    blocks.push(block);
    index += block.length + 1;
  }
  return blocks;
}

export function parseRegistryArrayEntriesFromSource(text, exportName) {
  const body = extractExportedArrayBody(text, exportName);
  return parseTopLevelObjectBlocks(body, `${processFactRegistryPath} ${exportName}`)
    .map(block => ({
      name: readStringProperty(block, 'name'),
      kind: readStringProperty(block, 'kind'),
      semantics: parseStringArrayProperty(block, 'semantics') || [],
      level: readStringProperty(block, 'level'),
      producer: readStringProperty(block, 'producer'),
      consumerGate: readStringProperty(block, 'consumerGate') || undefined,
      reviewerLane: readStringProperty(block, 'reviewerLane') || undefined,
      rationale: readStringProperty(block, 'rationale'),
      block,
    }))
    .filter(entry => entry.name);
}

export function parseProcessFactKindByCommandFromSource(text) {
  const body = extractExportedObjectBody(text, 'PROCESS_FACT_KIND_BY_COMMAND', processFactRegistryPath);
  return new Map([...body.matchAll(/^\s*([a-z_][a-z0-9_]*):\s*'([^']+)'/gm)].map(match => [match[1], match[2]]));
}

export function parseProcessFactArtifactByCommandFromSource(text) {
  const body = extractExportedObjectBody(text, 'PROCESS_FACT_ARTIFACT_BY_COMMAND', processFactRegistryPath);
  const artifacts = new Map();
  const keyPattern = /^\s*([a-z_][a-z0-9_]*):\s*\{/gm;
  for (const match of body.matchAll(keyPattern)) {
    const commandName = match[1];
    const openIndex = match.index + match[0].lastIndexOf('{');
    const block = extractBalancedBlock(body, openIndex, '{', '}', `${processFactRegistryPath} artifact ${commandName}`);
    artifacts.set(commandName, {
      path: readStringProperty(block, 'path'),
      signed: /\bsigned:\s*true\b/.test(block),
      signature: readStringProperty(block, 'signature'),
      producerCommand: readStringProperty(block, 'producerCommand'),
      consumerGate: readStringProperty(block, 'consumerGate'),
      reviewerLane: readStringProperty(block, 'reviewerLane'),
      block,
    });
  }
  return artifacts;
}

export function parseInlineProcessFactArtifactFromSource(block, label) {
  const artifactMatch = /\bartifact\s*:\s*\{/.exec(block);
  if (!artifactMatch) return null;
  const openIndex = artifactMatch.index + artifactMatch[0].lastIndexOf('{');
  const artifactBlock = extractBalancedBlock(block, openIndex, '{', '}', `${label} inline artifact`);
  return {
    name: readStringProperty(artifactBlock, 'name'),
    path: readStringProperty(artifactBlock, 'path'),
    signed: /\bsigned:\s*true\b/.test(artifactBlock),
    signature: readStringProperty(artifactBlock, 'signature'),
    producerCommand: readStringProperty(artifactBlock, 'producerCommand'),
    consumerGate: readStringProperty(artifactBlock, 'consumerGate'),
    reviewerLane: readStringProperty(artifactBlock, 'reviewerLane'),
    block: artifactBlock,
  };
}

export function parseControllerProjectionDescriptorProcessFacts(
  source = read('packages/main/src/core/managed-artifact-descriptors.ts'),
) {
  const entries = [];
  for (const match of source.matchAll(/defineManagedArtifactDescriptor\(\{/g)) {
    const openIndex = match.index + match[0].lastIndexOf('{');
    const block = extractBalancedBlock(source, openIndex, '{', '}', 'managed controller projection descriptor');
    const id = readStringProperty(block, 'id');
    const path = readStringProperty(block, 'path');
    const producer = readStringProperty(block, 'producer');
    const signature = readStringProperty(block, 'signature');
    const consumerGate = readStringProperty(block, 'consumerGate');
    const rationale = readStringProperty(block, 'rationale');
    assert(id && path && producer && signature && consumerGate && rationale,
      'managed controller projection descriptor must declare every process-fact field');
    entries.push({
      name: `artifact:${path}`,
      kind: 'signed-artifact',
      semantics: ['artifact', 'signed-artifact', 'schema-contract', 'atomic-persistence', 'workspace-binding', 'gate-evidence'],
      level: 'L4',
      producer,
      consumerGate,
      artifact: { name: id, path, signed: true, signature, consumerGate },
      reviewerLane: '',
      rationale,
      block,
    });
  }
  return entries;
}

export function parseProcessFactRequiredSemanticsFromSource(text) {
  const body = extractExportedObjectBody(text, 'PROCESS_FACT_REQUIRED_SEMANTICS', processFactRegistryPath);
  const semantics = new Map();
  const keyPattern = /^\s*([a-z_][a-z0-9_]*):\s*\[/gm;
  for (const match of body.matchAll(keyPattern)) {
    const name = match[1];
    const openIndex = match.index + match[0].lastIndexOf('[');
    const block = extractBalancedBlock(body, openIndex, '[', ']', `${processFactRegistryPath} semantics ${name}`);
    semantics.set(name, [...block.matchAll(/['"`]([^'"`]+)['"`]/g)].map(([, value]) => value));
  }
  return semantics;
}

export function parseProcessFactRuntimeSemanticsFromSource(text) {
  const body = extractExportedObjectBody(text, 'PROCESS_FACT_RUNTIME_SEMANTICS', processFactRegistryPath);
  const semantics = new Map();
  const keyPattern = /^\s*['"`]([^'"`]+)['"`]:\s*\[/gm;
  for (const match of body.matchAll(keyPattern)) {
    const name = match[1];
    const openIndex = match.index + match[0].lastIndexOf('[');
    const block = extractBalancedBlock(body, openIndex, '[', ']', `${processFactRegistryPath} runtime semantics ${name}`);
    semantics.set(name, [...block.matchAll(/['"`]([^'"`]+)['"`]/g)].map(([, value]) => value));
  }
  return semantics;
}

export function parseFlowFactPolicies() {
  if (cachedFlowFactPolicyEntries) return cachedFlowFactPolicyEntries;

  const text = read(flowFactPolicyPath);
  for (const token of [
    'FLOW_FACT_POLICIES',
    'PASS_ONLY_REVIEW_FINDING_POLICY',
    'EXPRESS_VERIFICATION_EXEMPTION_MESSAGE',
    'isPassOnlyReviewFindingRecord',
    'express-exempt',
    'review-round-iso-string',
  ]) {
    assert(text.includes(token), `${flowFactPolicyPath}: centralized flow fact policy must expose ${token}`);
  }

  const body = extractExportedArrayBody(text, 'FLOW_FACT_POLICIES');
  const entries = parseTopLevelObjectBlocks(body, `${flowFactPolicyPath} FLOW_FACT_POLICIES`)
    .map(block => ({
      name: readStringProperty(block, 'name'),
      policyId: readStringProperty(block, 'policyId'),
      disposition: readStringProperty(block, 'disposition'),
      level: readStringProperty(block, 'level'),
      category: readStringProperty(block, 'category'),
      owner: readStringProperty(block, 'owner'),
      consumerGate: readStringProperty(block, 'consumerGate'),
      artifactCommand: readStringProperty(block, 'artifactCommand'),
      semantics: parseStringArrayProperty(block, 'semantics') || [],
      rationale: readStringProperty(block, 'rationale'),
      block,
    }))
    .filter(entry => entry.name);

  const declaredObjectCount = [...body.matchAll(/\{\s*name:\s*'/g)].length;
  assert(entries.length === declaredObjectCount, `${flowFactPolicyPath}: every flow policy must be parseable`);
  cachedFlowFactPolicyEntries = entries;
  return entries;
}

export function processFactKindForCommand(name, level, kindByCommand) {
  if (kindByCommand.has(name)) return kindByCommand.get(name);
  if (name.startsWith('runtime:')) return 'runtime-behavior';
  return level === 'L4' ? 'gate-evidence' : 'command';
}

export function processFactSemanticsForCommand(name, level, semanticsByCommand, runtimeSemanticsByCommand = new Map()) {
  const semantics = new Set(name.startsWith('runtime:')
    ? runtimeSemanticsByCommand.get(name) || []
    : semanticsByCommand.get(name) || []);
  if (name.startsWith('runtime:')) {
    semantics.add('runtime-behavior');
    if (name === 'runtime:review_escalation_done_gate') semantics.add('host-verdict');
    if (name === 'runtime:review_assurance_floor_done_gate') semantics.add('host-verdict');
  }
  if (level === 'L4') semantics.add('gate-evidence');
  if (semantics.size === 0) semantics.add('command');
  return [...semantics].sort();
}

export function parseProcessFactRegistry() {
  if (cachedProcessFactRegistryEntries) return cachedProcessFactRegistryEntries;

  const sourceText = read(processFactRegistryPath);
  for (const token of [
    'PROCESS_FACT_REGISTRY',
    'PROCESS_FACT_REQUIRED_SEMANTICS',
    'PROCESS_FACT_RUNTIME_SEMANTICS',
    'PROCESS_FACT_FLOW_POLICIES',
    'PROCESS_FACT_SIGNED_ARTIFACTS',
    'PROCESS_FACT_REQUIRED_ARTIFACTS',
    'semantics',
    'kind',
    'lifecycle',
    'allowedPhases',
    'rootOnly',
    'destructiveRisk',
    'producer',
    'consumerGate',
    'artifact',
    'signature',
    'reviewerLane',
  ]) {
    assert(sourceText.includes(token), `${processFactRegistryPath}: typed registry must expose ${token}`);
  }

  const finalRegistryBody = extractExportedArrayBody(sourceText, 'PROCESS_FACT_REGISTRY');
  for (const requiredSpread of ['COMMAND_PROCESS_FACTS', 'PROCESS_FACT_REVIEWER_LANES', 'PROCESS_FACT_ARTIFACTS', 'PROCESS_FACT_FLOW_POLICIES', 'PROCESS_FACT_DONE_PREFLIGHT_CONSUMERS']) {
    assert(
      finalRegistryBody.includes(`...${requiredSpread}`),
      `${processFactRegistryPath}: final PROCESS_FACT_REGISTRY export missing ...${requiredSpread}`,
    );
  }

  assertProcessFactMappedSourceContracts(sourceText);

  if (builtProcessFactRegistryModule?.PROCESS_FACT_REGISTRY) {
    let entries = builtProcessFactRegistryModule.PROCESS_FACT_REGISTRY.map(entry => ({
      name: entry.name,
      kind: entry.kind,
      semantics: Array.isArray(entry.semantics) ? [...entry.semantics] : [],
      level: entry.level,
      lifecycle: entry.lifecycle,
      allowedPhases: entry.allowedPhases === 'all'
        ? [...ALL_PHASES]
        : (Array.isArray(entry.allowedPhases) ? [...entry.allowedPhases] : []),
      rootOnly: entry.rootOnly === true,
      legacy: entry.legacy === true,
      gateEvidence: entry.gateEvidence === true,
      destructiveRisk: entry.destructiveRisk || '',
      producer: entry.producer || '',
      consumerGate: entry.consumerGate || '',
      artifact: entry.artifact || null,
      reviewerLane: entry.reviewerLane || '',
      rationale: entry.rationale || '',
    }));
    // Mutation seam used by the focused production-contract smoke: remove one
    // side of registration and require the ordinary cross-registry assertions
    // below to fail. It never changes normal verification behavior.
    if (process.env.PROOF_OR_STOP_PROCESS_FACT_CONTRACT_MUTATION === 'drop-acceptance-basis-registry') {
      entries = entries.filter(entry => entry.name !== 'acceptance_basis_generate');
    }
    assert(entries.length > 0, `${processFactRegistryPath}: compiled PROCESS_FACT_REGISTRY should not be empty`);
    cachedProcessFactRegistryEntries = entries;
    return entries;
  }

  const policyByName = new Map(parseCommandPolicyEntries().map(entry => [entry.name, entry]));
  const kindByCommand = parseProcessFactKindByCommandFromSource(sourceText);
  const semanticsByCommand = parseProcessFactRequiredSemanticsFromSource(sourceText);
  const runtimeSemanticsByCommand = parseProcessFactRuntimeSemanticsFromSource(sourceText);
  const artifactByCommand = parseProcessFactArtifactByCommandFromSource(sourceText);
  const commandEntries = parseProcessFactLevelRegistry().filter(entry => !entry.name.startsWith('flow-policy:')).map(entry => {
    const policy = policyByName.get(entry.name);
    const semantics = processFactSemanticsForCommand(entry.name, entry.level, semanticsByCommand, runtimeSemanticsByCommand);
    const inferredRootOnly = Boolean(policy) && (policy.rootOnly || policy.status === 'rootOnly');
    const inferredGateEvidence = Boolean(policy?.gateEvidence) || policy?.status === 'gateEvidence';
    return {
      name: entry.name,
      kind: processFactKindForCommand(entry.name, entry.level, kindByCommand),
      semantics,
      level: entry.level,
      lifecycle: policy?.status || '',
      allowedPhases: policy?.allowedPhases || [],
      rootOnly: inferredRootOnly,
      legacy: policy?.status === 'legacy',
      gateEvidence: inferredGateEvidence,
      destructiveRisk: policy?.destructiveRisk || '',
      producer: entry.owner,
      consumerGate: entry.gateConsumer || '',
      artifact: artifactByCommand.get(entry.name) || null,
      reviewerLane: artifactByCommand.get(entry.name)?.reviewerLane || '',
      rationale: entry.rationale,
    };
  });

  const laneEntries = parseRegistryArrayEntriesFromSource(sourceText, 'PROCESS_FACT_REVIEWER_LANE_DEFINITIONS').map(entry => {
    const artifactRefMatch = /artifact:\s*PROCESS_FACT_ARTIFACT_BY_COMMAND\.([a-z_][a-z0-9_]*)/.exec(entry.block);
    const artifact = artifactRefMatch ? artifactByCommand.get(artifactRefMatch[1]) : null;
    return {
      ...entry,
      kind: 'reviewer-lane',
      semantics: ['gate-evidence', 'reviewer-lane'],
      level: 'L4',
      artifact: artifact || null,
    };
  });
  const artifactEntries = parseRegistryArrayEntriesFromSource(sourceText, 'PROCESS_FACT_ARTIFACTS').map(entry => {
    const artifactRefMatch = /artifact:\s*PROCESS_FACT_ARTIFACT_BY_COMMAND\.([a-z_][a-z0-9_]*)/.exec(entry.block);
    const artifact = artifactRefMatch
      ? artifactByCommand.get(artifactRefMatch[1])
      : parseInlineProcessFactArtifactFromSource(entry.block, `${processFactRegistryPath} ${entry.name}`);
    return { ...entry, artifact: artifact || null };
  }).concat(parseControllerProjectionDescriptorProcessFacts());
  const flowPolicyEntries = parseFlowFactPolicies().map(entry => ({
    name: entry.name,
    kind: 'flow-policy',
    semantics: [...entry.semantics],
    level: entry.level,
    producer: entry.owner,
    consumerGate: entry.consumerGate,
    artifact: entry.artifactCommand ? artifactByCommand.get(entry.artifactCommand) || null : null,
    reviewerLane: '',
    rationale: entry.rationale,
  }));
  const closeoutTelemetryEntries = parseRegistryArrayEntriesFromSource(sourceText, 'PROCESS_FACT_CLOSEOUT_TELEMETRY');
  const donePreflightConsumerEntries = parseRegistryArrayEntriesFromSource(sourceText, 'PROCESS_FACT_DONE_PREFLIGHT_CONSUMERS');

  cachedProcessFactRegistryEntries = [
    ...commandEntries,
    ...laneEntries,
    ...artifactEntries,
    ...flowPolicyEntries,
    ...donePreflightConsumerEntries,
    ...closeoutTelemetryEntries,
  ];
  if (process.env.PROOF_OR_STOP_PROCESS_FACT_CONTRACT_MUTATION === 'drop-acceptance-basis-registry') {
    cachedProcessFactRegistryEntries = cachedProcessFactRegistryEntries.filter(entry => entry.name !== 'acceptance_basis_generate');
  }
  return cachedProcessFactRegistryEntries;
}

export function processFactRegistryMap() {
  return new Map(parseProcessFactRegistry().map(entry => [entry.name, entry]));
}

export function parseDonePreflightPredicateInventory(sourceText) {
  const body = extractExportedArrayBody(sourceText, 'DONE_PREFLIGHT_PREDICATE_INVENTORY');
  return parseTopLevelObjectBlocks(body, `${processFactRegistryPath} DONE_PREFLIGHT_PREDICATE_INVENTORY`)
    .map(block => ({
      blockerCode: readStringProperty(block, 'blockerCode'),
      processFactName: readStringProperty(block, 'processFactName'),
      oracleRowId: readStringProperty(block, 'oracleRowId'),
    }));
}

export function collectSharedDoneBlockerBindings(machineSource) {
  const sf = ts.createSourceFile(machinePath, machineSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const evaluator = sf.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'evaluateDonePredicates');
  const errors = [];
  const byCode = new Map();
  if (!evaluator?.body || !evaluator.asteriskToken) {
    return { errors: ['shared DONE predicate generator missing'], byCode };
  }
  const visit = node => {
    if (ts.isYieldExpression(node)) {
      const call = node.expression;
      if (node.asteriskToken || !call || !ts.isCallExpression(call) || call.expression.getText(sf) !== 'donePredicate'
        || call.arguments.length !== 4 || !ts.isStringLiteral(call.arguments[0]) || !ts.isStringLiteral(call.arguments[1])) {
        errors.push('shared DONE outcomes must be direct yields of donePredicate with literal predicate/row identities');
        return;
      }
      const rowId = call.arguments[1].text;
      const collect = child => {
        const literal = ts.isStringLiteral(child) || ts.isNoSubstitutionTemplateLiteral(child)
          || ts.isTemplateHead(child) || ts.isTemplateMiddle(child) || ts.isTemplateTail(child);
        if (literal) {
          for (const match of child.text.matchAll(/\[([a-z][a-z0-9_]*)\]/g)) {
            const rows = byCode.get(match[1]) ?? new Set();
            rows.add(rowId);
            byCode.set(match[1], rows);
          }
        }
        ts.forEachChild(child, collect);
      };
      collect(call.arguments[3]);
    }
    ts.forEachChild(node, visit);
  };
  visit(evaluator.body);
  return { errors, byCode };
}

export function checkDonePreflightPredicateInventory({ machineSource, doneOracleSource, mappings, registry }) {
  const extracted = collectSharedDoneBlockerBindings(machineSource);
  const errors = [...extracted.errors, ...checkSharedDoneAdapterSources(machineSource, doneOracleSource)];
  const mapped = new Map();
  for (const entry of mappings) {
    if (!entry.blockerCode || !entry.processFactName || !entry.oracleRowId) {
      errors.push('DONE predicate inventory requires code, process fact and oracle row');
      continue;
    }
    if (mapped.has(entry.blockerCode)) errors.push('duplicate DONE predicate mapping: ' + entry.blockerCode);
    mapped.set(entry.blockerCode, entry);
    const fact = registry.get(entry.processFactName);
    if (fact?.level !== 'L4' || !fact?.semantics.includes('gate-evidence')) {
      errors.push('DONE predicate [' + entry.blockerCode + '] requires an L4 gate-evidence process fact');
    }
    const rows = extracted.byCode.get(entry.blockerCode);
    if (!rows || rows.size !== 1 || !rows.has(entry.oracleRowId)) {
      errors.push('DONE predicate [' + entry.blockerCode + '] must map to its exact shared outcome row ' + entry.oracleRowId);
    }
  }
  for (const code of extracted.byCode.keys()) {
    if (!mapped.has(code)) errors.push('DONE predicate [' + code + '] has no done-preflight mapping');
  }
  return errors;
}

export function assertDonePreflightPredicateInventoryParity() {
  const before = failures.length;
  const machineSource = read(machinePath);
  const doneOracleSource = read(doneOraclePath);
  const registry = processFactRegistryMap();
  const mappings = parseDonePreflightPredicateInventory(read(processFactRegistryPath));
  for (const error of checkDonePreflightPredicateInventory({ machineSource, doneOracleSource, mappings, registry })) fail(error);
  for (const name of ['runtime:done_shared_predicate_projection', 'runtime:done_finish_decision_presence', 'runtime:done_phase_agnostic_reviewer_verdict']) {
    const fact = registry.get(name);
    assert(fact?.level === 'L4' && fact?.consumerGate?.includes('storyMachine.canFinish DONE gate')
      && fact?.consumerGate?.includes('done_closure/done_prepare preflight'), name + ': both DONE consumers must stay registered at L4');
  }
  assert(registry.get('runtime:done_finish_decision_presence')?.rationale.includes('byte-exact proof-or-stop.dev-memory-finish-decision.v1'),
    'finish-decision process fact must require exact canonical schema admission');
  const finishReader = read('packages/main/src/core/playbook-runtime-memory.ts');
  assert(finishReader.includes("if (record.schemaVersion !== 'proof-or-stop.dev-memory-finish-decision.v1') {")
    && finishReader.includes('return { record: null, unsupportedIdentity:')
    && finishReader.includes('return inspectDevMemoryFinishDecision(root, storyId).record;'),
    'finish-decision reader must reject unsupported schema before DONE admission');
  assert(registry.get('runtime:done_finish_decision_presence')?.rationale.includes('unsupported_identity')
    && machineSource.includes('const finishDecisionRead = inspectDevMemoryFinishDecision(projectRoot, storyId);')
    && doneOracleSource.includes("donePredicateValue<ReturnType<typeof inspectDevMemoryFinishDecision>>(donePredicates, 'dev-memory-finish-decision')"),
    'unsupported finish identity must retain its shared diagnostic in DONE and the read-only oracle');
  const sf = ts.createSourceFile(machinePath, machineSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const evaluator = sf.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'evaluateDonePredicates');
  if (evaluator?.body) {
    const offset = evaluator.body.getStart(sf) + 1;
    const future = machineSource.slice(0, offset)
      + "\n yield donePredicate('future', 'future-row', null, '[future_done_predicate]');\n"
      + machineSource.slice(offset);
    const missing = checkDonePreflightPredicateInventory({ machineSource: future, doneOracleSource, mappings, registry });
    assert(missing.some(error => error.includes('[future_done_predicate]') && error.includes('no done-preflight mapping')),
      'future shared DONE literal must fail the inventory until registered');
    const registered = [...mappings, { blockerCode: 'future_done_predicate', oracleRowId: 'future-row', processFactName: 'artifact:delivery-check.json' }];
    assert(checkDonePreflightPredicateInventory({ machineSource: future, doneOracleSource, mappings: registered, registry }).length === 0,
      'new registered shared predicate needs no manual oracle row whitelist');
    const wrong = registered.map(entry => entry.blockerCode === 'future_done_predicate' ? { ...entry, oracleRowId: 'test-evidence' } : entry);
    assert(checkDonePreflightPredicateInventory({ machineSource: future, doneOracleSource, mappings: wrong, registry })
      .some(error => error.includes('[future_done_predicate]') && error.includes('exact shared outcome row')),
    'wrong row mapping must fail against source-owned outcome identity');
  }
  try {
    assert(registry.get('artifact:prompt-envelopes.json')?.rationale?.includes('Verification snapshots preserve optional-property absence'),
      'Prompt Envelope snapshot fidelity must remain registered; isolation must not invalidate signed trusted-prior evidence');
    // Includes source-executed canonical envelope/signature/trusted-prior proof:
    // optional-key absence and malformed values are preserved, not normalized.
    runSharedDonePredicateProof(machineSource, doneOracleSource);
  } catch (error) {
    fail('executable shared DONE predicate proof: ' + (error?.message ?? String(error)));
  }
  if (failures.length === before) console.log('DONE/preflight predicate inventory parity passed');
}

export function extractCliToolNames(cliText) {
  return [...cliText.matchAll(/name:\s*['"]([a-z_][a-z0-9_]*)['"]/g)]
    .map(match => match[1])
    .sort();
}
