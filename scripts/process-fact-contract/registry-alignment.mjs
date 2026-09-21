




import { basename } from 'node:path';

import ts from 'typescript';
import nodeAssert from 'node:assert/strict';

import { extractBalancedBlock, extractExportedObjectBody } from './review-inventory.mjs';
import { parseCommandPolicyEntries, parseProcessFactRegistry, parseProcessFactLevelRegistry, duplicateNames, parseControllerProjectionDescriptorProcessFacts, parseFlowFactPolicies } from './registry-parser.mjs';
import { builtConfigModule, ALL_PHASES, assert, commandPolicyPath, processFactLevelRegistryPath, read, processFactRegistryPath, processFactRegistryKinds, requiredProcessFactSemantics, requiredRuntimeFactSemantics, requiredReviewerLanes, reviewerLaneEntry, canonicalRoleId, requiredArtifactFacts, requiredFlowFactPolicies, flowFactPolicyPath } from './support.mjs';
import { listMarkdown } from './source-analysis.mjs';

export function stripTsComments(text) {
  let out = '';
  let quote = null;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (quote) {
      out += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      out += char;
      continue;
    }

    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      out += '\n';
      continue;
    }

    if (char === '/' && next === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index += 1;
      out += ' ';
      continue;
    }

    out += char;
  }
  return out;
}

export function readQuotedLiteralAt(text, openIndex) {
  const quote = text[openIndex];
  let escaped = false;
  let value = '';
  for (let index = openIndex + 1; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      value += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === quote) return { value, endIndex: index + 1 };
    value += char;
  }
  return null;
}

export function skipWhitespace(text, index) {
  let cursor = index;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
  return cursor;
}

export function findObjectArrayPropertyOpen(body, propertyName) {
  let index = 0;
  while (index < body.length) {
    index = skipWhitespace(body, index);
    if (body[index] === ',') {
      index += 1;
      continue;
    }

    let key = '';
    if (body[index] === '\'' || body[index] === '"' || body[index] === '`') {
      const literal = readQuotedLiteralAt(body, index);
      if (!literal) return -1;
      key = literal.value;
      index = literal.endIndex;
    } else {
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(body.slice(index));
      if (!match) {
        index += 1;
        continue;
      }
      key = match[0];
      index += match[0].length;
    }

    index = skipWhitespace(body, index);
    if (body[index] !== ':') continue;
    index = skipWhitespace(body, index + 1);
    if (key === propertyName && body[index] === '[') return index;

    if (body[index] === '{') {
      const block = extractBalancedBlock(body, index, '{', '}', `DEFAULT_PHASE_TOOLS ${key}`);
      index += block.length + 2;
    } else if (body[index] === '[') {
      const block = extractBalancedBlock(body, index, '[', ']', `DEFAULT_PHASE_TOOLS ${key}`);
      index += block.length + 2;
    } else if (body[index] === '\'' || body[index] === '"' || body[index] === '`') {
      const literal = readQuotedLiteralAt(body, index);
      index = literal ? literal.endIndex : index + 1;
    } else {
      while (index < body.length && body[index] !== ',') index += 1;
    }
  }
  return -1;
}

export function extractPhaseToolEntries(configText, phaseName) {
  const text = stripTsComments(configText);
  const body = extractExportedObjectBody(text, 'DEFAULT_PHASE_TOOLS', 'packages/main/src/core/config.ts');
  const openIndex = findObjectArrayPropertyOpen(body, phaseName);
  if (openIndex === -1) return new Set();

  let depth = 1;
  let quote = null;
  let escaped = false;
  let block = '';
  for (let index = openIndex + 1; index < body.length; index += 1) {
    const char = body[index];

    if (quote) {
      block += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      block += char;
      continue;
    }

    if (char === '[') depth += 1;
    if (char === ']') {
      depth -= 1;
      if (depth === 0) break;
    }
    block += char;
  }

  const entries = new Set();
  for (const literal of block.matchAll(/['"]((?:\\.|[^'"\\])*)['"]/g)) {
    entries.add(literal[1].replace(/\\(['"\\])/g, '$1'));
  }
  return entries;
}

export function patternMatchesCommand(pattern, commandName) {
  if (pattern.endsWith('*')) return commandName.startsWith(pattern.slice(0, -1));
  return pattern === commandName;
}

export function isPhaseToolsRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function commandAllowedByLifecyclePolicySource(commandName, phaseName) {
  if (commandName === 'session_brief' || commandName === 'next') return true;
  const policy = parseCommandPolicyEntries().find(entry => entry.name === commandName);
  if (!policy) return true;
  return policy.allowedPhases.includes(phaseName);
}

export function commandAllowedByConfiguredPhaseTools(commandName, phaseName, phaseTools) {
  if (commandName === 'session_brief' || commandName === 'next') return true;
  if (!commandAllowedByLifecyclePolicySource(commandName, phaseName)) return false;
  if (phaseTools !== undefined && !isPhaseToolsRecord(phaseTools)) return true;
  const pt = phaseTools || {};
  const patterns = [...(pt['*'] || []), ...(pt[phaseName] || [])].filter(value => typeof value === 'string');
  return patterns.some(pattern => patternMatchesCommand(pattern, commandName));
}

export function getDefaultPhaseToolEntries(configText, phaseName) {
  if (builtConfigModule?.DEFAULT_PHASE_TOOLS) {
    return new Set([
      ...(builtConfigModule.DEFAULT_PHASE_TOOLS['*'] || []),
      ...(builtConfigModule.DEFAULT_PHASE_TOOLS[phaseName] || []),
    ]);
  }
  return new Set([
    ...extractPhaseToolEntries(configText, '*'),
    ...extractPhaseToolEntries(configText, phaseName),
  ]);
}

export function commandAllowedByDefaultConfig(commandName, phaseName, configText) {
  if (builtConfigModule?.isCommandAllowed) {
    return builtConfigModule.isCommandAllowed(commandName, phaseName);
  }
  const patterns = getDefaultPhaseToolEntries(configText, phaseName);
  if (!commandAllowedByLifecyclePolicySource(commandName, phaseName)) return false;
  return [...patterns].some(pattern => patternMatchesCommand(pattern, commandName));
}

export function patternHasPolicyApprovedCommand(pattern, phaseName, policyEntries) {
  return policyEntries.some(entry => (
    patternMatchesCommand(pattern, entry.name) && entry.allowedPhases.includes(phaseName)
  ));
}

export function patternHasRegistryApprovedCommand(pattern, phaseName, registryCommandEntries) {
  return registryCommandEntries.some(entry => (
    patternMatchesCommand(pattern, entry.name) && entry.allowedPhases.includes(phaseName)
  ));
}

export function assertCommandPolicyPhaseAlignment(policyEntries, configText) {
  for (const entry of policyEntries) {
    for (const phaseName of ALL_PHASES) {
      const policyAllows = entry.allowedPhases.includes(phaseName);
      const defaultAllows = commandAllowedByDefaultConfig(entry.name, phaseName, configText);
      assert(
        defaultAllows === policyAllows,
        `${commandPolicyPath} + packages/main/src/core/config.ts: ${entry.name} ${phaseName} policy/default phase drift (policy=${policyAllows}, isCommandAllowed=${defaultAllows})`,
      );
    }
  }

  for (const phaseName of ALL_PHASES) {
    for (const pattern of getDefaultPhaseToolEntries(configText, phaseName)) {
      assert(
        patternHasPolicyApprovedCommand(pattern, phaseName, policyEntries),
        `packages/main/src/core/config.ts: DEFAULT_PHASE_TOOLS ${phaseName} pattern "${pattern}" has no command allowed by COMMAND_POLICIES`,
      );
    }
  }

  assert(
    commandAllowedByDefaultConfig('understanding_get', 'REVIEW', configText) &&
      commandAllowedByDefaultConfig('decision_get', 'REVIEW', configText),
    'packages/main/src/core/config.ts: REVIEW must allow understanding_get and decision_get for reviewer access to planning artifacts',
  );
}

export function assertCrossHostReviewManagedDelegationContract(levelRegistry, policyByName) {
  const commandName = 'cross_host_review';
  const levelEntry = levelRegistry.get(commandName);
  const policy = policyByName.get(commandName);
  assert(levelEntry, `${processFactLevelRegistryPath}: ${commandName} managed-delegation fact missing`);
  assert(policy, `${commandPolicyPath}: ${commandName} managed-delegation policy missing`);
  if (!levelEntry || !policy) return;

  const descriptions = [
    { label: `${processFactLevelRegistryPath}: ${commandName} rationale`, text: levelEntry.rationale },
    { label: `${commandPolicyPath}: ${commandName} reason`, text: policy.reason },
  ];
  for (const description of descriptions) {
    for (const token of ['ManagedHostRun', 'terminal receipt', 'supervision/reaping']) {
      assert(description.text.includes(token), `${description.label} must describe ManagedHostRun terminal-receipt ownership: missing ${token}`);
    }
    assert(
      /fail-closed before ManagedHostRun submission/i.test(description.text),
      `${description.label} must preserve the fail-closed review-policy admission before ManagedHostRun submission`,
    );
    assert(
      !/\bspawns?\s+(?:a\s+)?bounded\s+read-only\s+codex\s+review\s+(?:leaf|subprocess)\b/i.test(description.text),
      `${description.label} must not regress to the retired controller-direct Codex spawn description`,
    );
  }
  assert(
    policy.reason.includes('allowReviewOnlyRealHostSubprocess for a codex host'),
    `${commandPolicyPath}: ${commandName} must retain the real Codex review-only dispatch-policy grant`,
  );

  const handlerText = read('packages/main/src/handlers/cross-host-review.ts');
  for (const token of ['authorizeReviewPolicy', 'allowReviewOnlyRealHostSubprocess === true', "includes('codex')", 'submitManagedHostRun(submitArgs,', 'bindManagedSingletonSubmission(submitArgs,', 'managedHostRunReceipt(']) {
    assert(handlerText.includes(token), `packages/main/src/handlers/cross-host-review.ts: ${commandName} managed delegation contract missing ${token}`);
  }
}

export function assertL4ProducerOrReplacement(registryEntries, policyByName, configText) {
  for (const entry of registryEntries.filter(item => item.level === 'L4')) {
    if (entry.name.includes(':')) continue;
    const policy = policyByName.get(entry.name);
    assert(policy, `${commandPolicyPath}: L4 command ${entry.name} must have lifecycle policy`);
    if (!policy) continue;
    const producerPhases = ALL_PHASES.filter(phaseName => commandAllowedByDefaultConfig(entry.name, phaseName, configText));
    assert(
      producerPhases.length > 0 || policy.replacement.trim().length > 0,
      `${commandPolicyPath}: L4 command ${entry.name} must have a DEFAULT_PHASE_TOOLS producer phase or replacement guidance`,
    );
  }
}

export function sameStringArray(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function isCommandRegistryEntry(entry) {
  return !entry.name.includes(':');
}

export function assertProcessFactRegistryContract(cliToolNames, policyEntries, configText) {
  const registryEntries = parseProcessFactRegistry();
  const registry = new Map(registryEntries.map(entry => [entry.name, entry]));
  const registryCommandEntries = registryEntries.filter(isCommandRegistryEntry);
  const registryCommandByName = new Map(registryCommandEntries.map(entry => [entry.name, entry]));
  const policyByName = new Map(policyEntries.map(entry => [entry.name, entry]));
  const levelRegistry = new Map(parseProcessFactLevelRegistry().map(entry => [entry.name, entry]));

  const duplicateRegistryNames = duplicateNames(registryEntries.map(entry => entry.name));
  assert(
    duplicateRegistryNames.length === 0,
    `${processFactRegistryPath}: duplicate PROCESS_FACT_REGISTRY entries: ${duplicateRegistryNames.join(', ')}`,
  );

  const managedDescriptorText = read('packages/main/src/core/managed-artifact-descriptors.ts');
  const lifecycleRegistryText = read('packages/main/src/core/lifecycle-registry.ts');
  const processRegistrySource = read(processFactRegistryPath);
  const runtimeProjectionText = read('packages/main/src/core/controller-runtime-projection.ts');
  const configProjectionText = read('packages/main/src/core/controller-config-projection.ts');
  const autoCommitMetadataText = read('packages/main/src/core/auto-commit-metadata.ts');
  assert(
    lifecycleRegistryText.includes('...CONTROLLER_PROJECTION_ARTIFACTS.map((artifact) => artifact.path)'),
    'controller projection lifecycle paths must derive from the canonical managed artifact descriptors',
  );
  assert(
    processRegistrySource.includes("import { CONTROLLER_PROJECTION_ARTIFACTS } from './managed-artifact-descriptors.js'")
      && processRegistrySource.includes('...CONTROLLER_PROJECTION_ARTIFACTS,'),
    'process fact artifacts must consume the canonical controller projection descriptors directly',
  );
  assert(
    autoCommitMetadataText.includes("import { CONTROLLER_PROJECTION_ARTIFACTS } from './managed-artifact-descriptors.js'")
      && autoCommitMetadataText.includes("descriptor.trackedPolicy === 'untracked-only'")
      && autoCommitMetadataText.includes('...untrackedOnlyPaths.map(path => `:(exclude)${path}`)'),
    'Story metadata auto-commit must derive untracked-only projection exclusions from the canonical descriptors',
  );
  const controllerDescriptors = parseControllerProjectionDescriptorProcessFacts(managedDescriptorText);
  assert(controllerDescriptors.length === 2, 'exactly two controller projection artifact descriptors must be registered');
  for (const descriptor of controllerDescriptors) {
    const producerText = descriptor.artifact.name === 'controller-config-projection-receipt'
      ? configProjectionText
      : runtimeProjectionText;
    assert(
      producerText.includes('PROJECTION_ARTIFACT.path'),
      `producer must derive ${descriptor.artifact.name} path from the managed artifact descriptor`,
    );
    const processEntry = registry.get(descriptor.name);
    assert(
      processEntry?.artifact?.name === descriptor.artifact.name
        && processEntry.artifact.path === descriptor.artifact.path
        && processEntry.artifact.signature === descriptor.artifact.signature
        && processEntry.producer === descriptor.producer
        && processEntry.consumerGate === descriptor.consumerGate
        && processEntry.rationale === descriptor.rationale,
      `process fact registry must derive the complete ${descriptor.artifact.name} contract from its descriptor`,
    );
  }

  for (const entry of registryEntries) {
    assert(processFactRegistryKinds.has(entry.kind), `${processFactRegistryPath}: ${entry.name} has unknown kind "${entry.kind}"`);
    assert(Array.isArray(entry.semantics), `${processFactRegistryPath}: ${entry.name} must declare semantics[]`);
    assert(entry.producer && entry.producer.trim().length > 0, `${processFactRegistryPath}: ${entry.name} must declare producer`);
    assert(entry.rationale && entry.rationale.trim().length > 0, `${processFactRegistryPath}: ${entry.name} must declare rationale`);
    if (entry.level === 'L4') {
      assert(
        entry.consumerGate && entry.consumerGate.trim().length > 0,
        `${processFactRegistryPath}: L4 gate evidence ${entry.name} must name consumer gate`,
      );
    }
  }

  for (const commandName of cliToolNames) {
    assert(
      registryCommandByName.has(commandName),
      `${processFactRegistryPath}: MAIN_TOOLS command missing from PROCESS_FACT_REGISTRY: command=${commandName}`,
    );
  }

  for (const entry of registryCommandEntries) {
    if (entry.name.startsWith('runtime:')) continue;
    assert(
      cliToolNames.includes(entry.name),
      `${processFactRegistryPath}: command registry entry not present in MAIN_TOOLS: command=${entry.name}`,
    );
  }

  for (const levelEntry of parseProcessFactLevelRegistry()) {
    const registryEntry = registry.get(levelEntry.name);
    assert(
      registryEntry,
      `${processFactRegistryPath}: required process fact missing from PROCESS_FACT_REGISTRY: ${levelEntry.name}`,
    );
    if (!registryEntry) continue;
    assert(
      registryEntry.level === levelEntry.level,
      `${processFactRegistryPath}: level drift for command=${levelEntry.name} (registry=${registryEntry.level}, PROCESS_FACT_LEVELS=${levelEntry.level})`,
    );
    if (levelEntry.gateConsumer) {
      assert(
        registryEntry.consumerGate === levelEntry.gateConsumer,
        `${processFactRegistryPath}: gate drift for command=${levelEntry.name} (registry=${registryEntry.consumerGate || '<missing>'}, PROCESS_FACT_LEVELS=${levelEntry.gateConsumer})`,
      );
    }
  }

  for (const policy of policyEntries) {
    const registryEntry = registryCommandByName.get(policy.name);
    if (!registryEntry) continue;
    assert(
      registryEntry.lifecycle === policy.status,
      `${processFactRegistryPath}: policy drift for command=${policy.name} lifecycle registry=${registryEntry.lifecycle || '<missing>'} policy=${policy.status}`,
    );
    assert(
      registryEntry.destructiveRisk === policy.destructiveRisk,
      `${processFactRegistryPath}: policy drift for command=${policy.name} destructiveRisk registry=${registryEntry.destructiveRisk || '<missing>'} policy=${policy.destructiveRisk || '<missing>'}`,
    );
    assert(
      registryEntry.rootOnly === policy.rootOnly,
      `${processFactRegistryPath}: policy drift for command=${policy.name} rootOnly registry=${registryEntry.rootOnly} policy=${policy.rootOnly}`,
    );
    assert(
      registryEntry.gateEvidence === policy.gateEvidence,
      `${processFactRegistryPath}: policy drift for command=${policy.name} gateEvidence registry=${registryEntry.gateEvidence} policy=${policy.gateEvidence}`,
    );
    assert(
      sameStringArray(registryEntry.allowedPhases, policy.allowedPhases),
      `${processFactRegistryPath}: policy drift for command=${policy.name} allowedPhases registry=[${registryEntry.allowedPhases.join(',')}] policy=[${policy.allowedPhases.join(',')}]`,
    );
  }

  for (const [commandName, expectedSemantics] of Object.entries(requiredProcessFactSemantics)) {
    const entry = registryCommandByName.get(commandName);
    assert(entry, `${processFactRegistryPath}: required process fact missing from PROCESS_FACT_REGISTRY: ${commandName}`);
    if (!entry) continue;
    assert(
      expectedSemantics.every((semantic) => entry.semantics.includes(semantic)),
      `${processFactRegistryPath}: required semantic fact missing for command=${commandName} expected=[${expectedSemantics.join(', ')}] got=[${entry.semantics.join(', ')}]`,
    );
  }

  for (const [factName, expectedSemantics] of Object.entries(requiredRuntimeFactSemantics)) {
    const entry = registry.get(factName);
    assert(entry, `${processFactRegistryPath}: required runtime process fact missing from PROCESS_FACT_REGISTRY: ${factName}`);
    if (!entry) continue;
    assert(
      expectedSemantics.every((semantic) => entry.semantics.includes(semantic)),
      `${processFactRegistryPath}: required runtime semantic fact missing for name=${factName} expected=[${expectedSemantics.join(', ')}] got=[${entry.semantics.join(', ')}]`,
    );
  }

  const l4CommandEntries = registryCommandEntries.filter(entry => entry.level === 'L4');
  for (const entry of l4CommandEntries) {
    const policy = policyByName.get(entry.name);
    assert(policy, `${processFactRegistryPath}: L4 command ${entry.name} must have COMMAND_POLICIES entry`);
    if (!policy) continue;
    assert(
      policy.gateEvidence,
      `${processFactRegistryPath}: L4 gate evidence command=${entry.name} must be gateEvidence in COMMAND_POLICIES`,
    );
    assert(
      entry.semantics.includes('gate-evidence'),
      `${processFactRegistryPath}: L4 gate evidence command=${entry.name} missing gate-evidence semantic`,
    );
  }

  for (const phaseName of ALL_PHASES) {
    for (const pattern of getDefaultPhaseToolEntries(configText, phaseName)) {
      assert(
        patternHasRegistryApprovedCommand(pattern, phaseName, registryCommandEntries),
        `${processFactRegistryPath}: DEFAULT_PHASE_TOOLS phase allowlist drift phase=${phaseName} pattern=${pattern}`,
      );
    }
  }

  for (const lane of requiredReviewerLanes) {
    const entry = reviewerLaneEntry(registry, lane);
    assert(entry, `${processFactRegistryPath}: reviewer lane missing from PROCESS_FACT_REGISTRY: lane=${lane}`);
    if (!entry) continue;
    assert(entry.kind === 'reviewer-lane', `${processFactRegistryPath}: reviewer lane ${lane} must have kind reviewer-lane`);
    assert(canonicalRoleId(entry.reviewerLane) === lane, `${processFactRegistryPath}: reviewer lane drift for lane=${lane}`);
    assert(entry.consumerGate, `${processFactRegistryPath}: reviewer lane ${lane} must name consumer gate`);
    assert(entry.artifact, `${processFactRegistryPath}: reviewer lane ${lane} must name produced/consumed artifact`);
  }

  const promptReviewerLanes = listMarkdown('packages/main/templates/agents')
    .map(relPath => canonicalRoleId(basename(relPath, '.md')))
    .filter((name, index, names) => (name.startsWith('proof-or-stop-review-') || name === 'proof-or-stop-product-reviewer')
      && name !== 'proof-or-stop-review-channel'
      && names.indexOf(name) === index);
  for (const lane of promptReviewerLanes) {
    assert(
      reviewerLaneEntry(registry, lane),
      `${processFactRegistryPath}: reviewer lane prompt missing registry fact: lane=${lane}`,
    );
  }

  const artifactEntries = registryEntries.filter(entry => entry.name.startsWith('artifact:'));
  for (const entry of registryEntries.filter(item => item.artifact)) {
    const artifactName = `artifact:${entry.artifact.path}`;
    const artifactEntry = registry.get(artifactName);
    assert(
      artifactEntry,
      `${processFactRegistryPath}: command/reviewer artifact ref missing registry artifact: fact=${entry.name} artifact=${artifactName}`,
    );
    if (!artifactEntry?.artifact) continue;
    assert(
      artifactEntry.artifact.path === entry.artifact.path,
      `${processFactRegistryPath}: artifact ref path drift fact=${entry.name} artifact=${artifactName}`,
    );
    assert(
      artifactEntry.artifact.signed === entry.artifact.signed,
      `${processFactRegistryPath}: artifact ref signed drift fact=${entry.name} artifact=${artifactName}`,
    );
  }

  for (const entry of artifactEntries) {
    assert(entry.artifact, `${processFactRegistryPath}: artifact registry entry ${entry.name} must include artifact metadata`);
    if (!entry.artifact) continue;
    assert(entry.semantics.includes('artifact'), `${processFactRegistryPath}: artifact=${entry.name} missing artifact semantic`);
    assert(
      entry.kind === (entry.artifact.signed ? 'signed-artifact' : 'artifact'),
      `${processFactRegistryPath}: artifact kind drift for artifact=${entry.name}`,
    );
    if (entry.artifact.signed) {
      assert(entry.semantics.includes('signed-artifact'), `${processFactRegistryPath}: artifact=${entry.name} missing signed-artifact semantic`);
      assert(
        (entry.artifact.signature || '').trim().length > 0,
        `${processFactRegistryPath}: signed artifact=${entry.name} must declare signature`,
      );
    }
    if (entry.level === 'L4') {
      assert(entry.consumerGate, `${processFactRegistryPath}: artifact=${entry.name} must name consumer gate`);
      assert(entry.semantics.includes('gate-evidence'), `${processFactRegistryPath}: L4 artifact=${entry.name} missing gate-evidence semantic`);
    }
  }

  for (const expected of requiredArtifactFacts) {
    const entry = registry.get(expected.name);
    assert(entry, `${processFactRegistryPath}: artifact missing from PROCESS_FACT_REGISTRY: artifact=${expected.name}`);
    if (!entry) continue;
    assert(
      entry.kind === (expected.signed ? 'signed-artifact' : 'artifact'),
      `${processFactRegistryPath}: artifact kind drift for artifact=${expected.name} expected=${expected.signed ? 'signed-artifact' : 'artifact'} got=${entry.kind}`,
    );
    assert(entry.artifact, `${processFactRegistryPath}: artifact=${expected.name} must include artifact metadata`);
    if (!entry.artifact) continue;
    assert(entry.artifact.path === expected.path, `${processFactRegistryPath}: artifact path drift for artifact=${expected.name} path=${entry.artifact.path}`);
    assert(entry.artifact.signed === expected.signed, `${processFactRegistryPath}: artifact signed drift for artifact=${expected.name}`);
    if (expected.signed) {
      assert(
        expected.signaturePattern.test(entry.artifact.signature || ''),
        `${processFactRegistryPath}: artifact=${expected.name} signature drift (${entry.artifact.signature || '<missing>'})`,
      );
      assert(entry.semantics.includes('signed-artifact'), `${processFactRegistryPath}: artifact=${expected.name} missing signed-artifact semantic`);
    }
    assert(entry.semantics.includes('artifact'), `${processFactRegistryPath}: artifact=${expected.name} missing artifact semantic`);
    if (expected.gateRequired !== false) {
      assert(entry.consumerGate, `${processFactRegistryPath}: artifact=${expected.name} must name consumer gate`);
    } else {
      assert(!entry.consumerGate, `${processFactRegistryPath}: audit-only artifact=${expected.name} must not name a consumer gate`);
    }
  }

  const flowPolicies = parseFlowFactPolicies();
  const flowPolicyNames = flowPolicies.map(entry => entry.name);
  for (const expected of requiredFlowFactPolicies) {
    const sourcePolicy = flowPolicies.find(entry => entry.name === expected.name);
    assert(sourcePolicy, `${flowFactPolicyPath}: required flow fact policy missing: ${expected.name}`);
    if (sourcePolicy) {
      assert(sourcePolicy.policyId === expected.policyId, `${flowFactPolicyPath}: ${expected.name} policyId drifted`);
      assert(sourcePolicy.level === 'L4', `${flowFactPolicyPath}: ${expected.name} must stay L4`);
      assert(sourcePolicy.category === 'flow-policy', `${flowFactPolicyPath}: ${expected.name} must stay category flow-policy`);
      assert(sourcePolicy.owner === 'core/flow-fact-policy', `${flowFactPolicyPath}: ${expected.name} owner drifted`);
      assert(expected.consumerGatePattern.test(sourcePolicy.consumerGate), `${flowFactPolicyPath}: ${expected.name} consumerGate drifted (${sourcePolicy.consumerGate})`);
      assert(sourcePolicy.disposition === expected.disposition, `${flowFactPolicyPath}: ${expected.name} disposition drifted`);
      assert(
        expected.semantics.every(semantic => sourcePolicy.semantics.includes(semantic)),
        `${flowFactPolicyPath}: ${expected.name} missing semantics [${expected.semantics.join(', ')}]`,
      );
    }

    const levelEntry = levelRegistry.get(expected.name);
    assert(levelEntry, `${processFactLevelRegistryPath}: required flow fact policy missing from level registry: ${expected.name}`);
    if (levelEntry) {
      assert(levelEntry.level === 'L4', `${processFactLevelRegistryPath}: ${expected.name} must stay L4`);
      assert(levelEntry.category === 'flow-policy', `${processFactLevelRegistryPath}: ${expected.name} category drifted`);
      assert(levelEntry.owner === 'core/flow-fact-policy', `${processFactLevelRegistryPath}: ${expected.name} owner drifted`);
      assert(expected.consumerGatePattern.test(levelEntry.gateConsumer || ''), `${processFactLevelRegistryPath}: ${expected.name} gateConsumer drifted`);
    }

    const registryEntry = registry.get(expected.name);
    assert(registryEntry, `${processFactRegistryPath}: required flow fact policy missing from PROCESS_FACT_REGISTRY: ${expected.name}`);
    if (!registryEntry) continue;
    assert(registryEntry.kind === 'flow-policy', `${processFactRegistryPath}: ${expected.name} must have kind flow-policy`);
    assert(registryEntry.level === 'L4', `${processFactRegistryPath}: ${expected.name} must stay L4`);
    assert(expected.consumerGatePattern.test(registryEntry.consumerGate || ''), `${processFactRegistryPath}: ${expected.name} consumerGate drifted`);
    assert(
      expected.semantics.every(semantic => registryEntry.semantics.includes(semantic)),
      `${processFactRegistryPath}: ${expected.name} missing required semantics [${expected.semantics.join(', ')}]`,
    );
    if (expected.artifactPath) {
      assert(registryEntry.artifact?.path === expected.artifactPath, `${processFactRegistryPath}: ${expected.name} artifact path drifted`);
    } else {
      assert(!registryEntry.artifact, `${processFactRegistryPath}: ${expected.name} should not claim an artifact`);
    }
  }
  assert(
    duplicateNames(flowPolicyNames).length === 0,
    `${flowFactPolicyPath}: duplicate flow fact policy names`,
  );
}
