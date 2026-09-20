

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { tmpdir } from 'node:os';
import { buildPromptPolicyManifestAudit, canonicalizeRoleManifestEntries, canonicalPromptRoleId, canonicalizePromptPolicyAudit, runAgentPrompt, toRepoPath, buildFindingKey, legacyVocabularyPolicyErrors, classifyLegacyRoleStatus, scanLegacyVocabulary, isExplicitlyGrandfatheredDirectStoryWrite, classifyStoryFinding, scanStoryFileReferences, sha256 } from './scanners.mjs';
import { requireEqual, mapBy, requireSameContent, collectPromptStateFromSource, normalizeContent, renderMatrixMarkdown, buildLegacyVocabularyPolicyAudit, buildDirectStoryPolicyAudit } from './collection.mjs';
import { EXPECTED_ROLE_COUNT, PROMPT_POLICY_PRIMARY_BOUNDARY, APPROVED_PROMPT_POLICY_MANIFEST, PROMPT_REGISTRY_SCHEMA_ALIASES, ROOT, ROLE_MATRIX_FIELDS, MATRIX_PATH, ROLE_MATRIX_MACHINE_CHECKS, REVIEWER_AUDITED_ROLE_MATRIX_FIELDS, ROLE_MATRIX_SEMANTIC_BOUNDARY, ROLE_MATRIX_COMMANDS_CONTRACT, ROLE_MATRIX_SOURCE_ANCHOR_PURPOSE, DIRECT_STORY_REFERENCE_ALLOWLIST, LEGACY_VOCABULARY_POLICY_PROBES, LEGACY_VOCABULARY_ALLOWED_PROBES, DIRECT_STORY_WRITE_ALLOWLIST, DIRECT_STORY_CLASSIFIER_PROBES, DIRECT_STORY_SCANNER_PROBES } from './policy-data.mjs';

export function verifyPromptPolicyManifestAuditSnapshot(audit, label, failures) {
  const expected = buildPromptPolicyManifestAudit();
  if (!audit || typeof audit !== 'object' || Array.isArray(audit)) {
    failures.push(`${label}: missing or not an object`);
    return;
  }
  requireEqual(audit.model, expected.model, `${label}.model`, failures);
  requireEqual(audit.algorithm, expected.algorithm, `${label}.algorithm`, failures);
  requireEqual(audit.roleCount, EXPECTED_ROLE_COUNT, `${label}.roleCount`, failures);
  requireEqual(
    audit.primaryBoundary,
    PROMPT_POLICY_PRIMARY_BOUNDARY,
    `${label}.primaryBoundary`,
    failures,
  );
  const actualRoles = mapBy(
    canonicalizeRoleManifestEntries(Array.isArray(audit.roles) ? audit.roles : []),
    entry => canonicalPromptRoleId(entry.role),
    `${label} role`,
    failures,
  );
  const expectedRoles = new Map(
    APPROVED_PROMPT_POLICY_MANIFEST.map(entry => [entry.role, entry]),
  );
  requireEqual(actualRoles.size, EXPECTED_ROLE_COUNT, `${label} role count`, failures);
  for (const [role, approved] of expectedRoles) {
    const actual = actualRoles.get(role);
    if (!actual) {
      failures.push(`${label}: missing approved role ${role}`);
      continue;
    }
    requireEqual(
      actual.templateHash,
      approved.templateHash,
      `${label} ${role}.templateHash`,
      failures,
    );
  }
  for (const role of actualRoles.keys()) {
    if (!expectedRoles.has(role)) failures.push(`${label}: unapproved role ${role}`);
  }
  requireSameContent(
    JSON.stringify(canonicalizeRoleManifestEntries(audit.roleBodyRollout) ?? null, null, 2),
    JSON.stringify(expected.roleBodyRollout, null, 2),
    `${label}.roleBodyRollout`,
    failures,
  );
}

export function verifyPromptPolicyManifestAudit(current, baseline, failures) {
  verifyPromptPolicyManifestAuditSnapshot(
    current.promptPolicyApproval,
    'current promptPolicyApproval',
    failures,
  );
  verifyPromptPolicyManifestAuditSnapshot(
    baseline.promptPolicyApproval,
    'baseline promptPolicyApproval',
    failures,
  );
  requireSameContent(
    JSON.stringify(canonicalizePromptPolicyAudit(current.promptPolicyApproval) ?? null, null, 2),
    JSON.stringify(canonicalizePromptPolicyAudit(baseline.promptPolicyApproval) ?? null, null, 2),
    'promptPolicyApproval snapshot',
    failures,
  );
}

export function verifyRegistry(current, baseline, failures) {
  requireEqual(current.schemaVersion, baseline.schemaVersion, 'baseline schemaVersion', failures);
  requireEqual(current.expectedRoleCount, EXPECTED_ROLE_COUNT, 'expectedRoleCount', failures);
  requireEqual(current.registry.agentCount, EXPECTED_ROLE_COUNT, 'current registry role count', failures);
  requireEqual(baseline.registry.agentCount, EXPECTED_ROLE_COUNT, 'baseline registry role count', failures);
  const registrySchemaMigration = current.registry.schemaVersion !== baseline.registry.schemaVersion
    && PROMPT_REGISTRY_SCHEMA_ALIASES.has(current.registry.schemaVersion)
    && PROMPT_REGISTRY_SCHEMA_ALIASES.has(baseline.registry.schemaVersion);
  if (!registrySchemaMigration) {
    requireEqual(current.registry.schemaVersion, baseline.registry.schemaVersion, 'registry schemaVersion', failures);
  }
  requireEqual(current.registry.source, baseline.registry.source, 'registry source', failures);
  if (!registrySchemaMigration) {
    requireEqual(current.registry.materialHash, baseline.registry.materialHash, 'registry materialHash', failures);
  }

  const currentRoles = mapBy(current.registry.roles, role => role.role, 'current role', failures);
  const baselineRoles = mapBy(baseline.registry.roles, role => role.role, 'baseline role', failures);
  for (const role of baselineRoles.keys()) {
    const actual = currentRoles.get(role);
    const expected = baselineRoles.get(role);
    if (!actual) {
      failures.push(`missing current role ${role}`);
      continue;
    }
    for (const field of ['file', 'relPath', 'templateHash', 'bytes', 'lines']) {
      requireEqual(actual[field], expected[field], `registry ${role}.${field}`, failures);
    }
  }
  for (const role of currentRoles.keys()) {
    if (!baselineRoles.has(role)) failures.push(`unregistered current role ${role}`);
  }
}

export function verifyAgentPromptOutputs(current, baseline, failures) {
  const currentOutputs = mapBy(current.agentPrompt.outputs, output => output.role, 'current agent_prompt output', failures);
  const baselineOutputs = mapBy(baseline.agentPrompt.outputs, output => output.role, 'baseline agent_prompt output', failures);
  requireEqual(currentOutputs.size, EXPECTED_ROLE_COUNT, 'current agent_prompt role count', failures);
  requireEqual(baselineOutputs.size, EXPECTED_ROLE_COUNT, 'baseline agent_prompt role count', failures);
  for (const role of baselineOutputs.keys()) {
    const actual = currentOutputs.get(role);
    const expected = baselineOutputs.get(role);
    if (!actual) {
      failures.push(`missing agent_prompt output for ${role}`);
      continue;
    }
    for (const field of ['sha256', 'bytes', 'lines']) {
      requireEqual(actual[field], expected[field], `agent_prompt ${role}.${field}`, failures);
    }
  }
  for (const role of currentOutputs.keys()) {
    if (!baselineOutputs.has(role)) failures.push(`unregistered current agent_prompt output ${role}`);
  }
}

export function verifyBaselineDriftProbes(current, failures) {
  const registryRole = current.registry.roles[0];
  const outputRole = current.agentPrompt.outputs[0];
  if (!registryRole || !outputRole) {
    failures.push('baseline drift probes require at least one registry role and agent_prompt output');
    return;
  }

  const cases = [
    {
      name: 'registry material hash drift',
      verifier: verifyRegistry,
      mutate(baseline) {
        baseline.registry.materialHash = 'sha256:baseline-drift-probe';
      },
      expected: ['registry materialHash'],
    },
    {
      name: 'template hash drift',
      verifier: verifyRegistry,
      mutate(baseline) {
        baseline.registry.roles[0].templateHash = 'sha256:template-drift-probe';
      },
      expected: [`registry ${registryRole.role}.templateHash`],
    },
    {
      name: 'missing registry role and count mismatch',
      verifier: verifyRegistry,
      mutate(baseline) {
        baseline.registry.roles = baseline.registry.roles.slice(1);
        baseline.registry.agentCount -= 1;
      },
      expected: ['baseline registry role count', `unregistered current role ${registryRole.role}`],
    },
    {
      name: 'extra registry role and count mismatch',
      verifier: verifyRegistry,
      mutate(baseline) {
        baseline.registry.roles.push({ ...baseline.registry.roles[0], role: 'probe-extra-role' });
        baseline.registry.agentCount += 1;
      },
      expected: ['baseline registry role count', 'missing current role probe-extra-role'],
    },
    {
      name: 'renamed registry role',
      verifier: verifyRegistry,
      mutate(baseline) {
        baseline.registry.roles[0].role = 'probe-renamed-role';
      },
      expected: [
        'missing current role probe-renamed-role',
        `unregistered current role ${registryRole.role}`,
      ],
    },
    {
      name: 'registry declared role-count mismatch',
      verifier: verifyRegistry,
      mutate(baseline) {
        baseline.registry.agentCount -= 1;
      },
      expected: ['baseline registry role count'],
    },
    {
      name: 'agent_prompt stdout hash drift',
      verifier: verifyAgentPromptOutputs,
      mutate(baseline) {
        baseline.agentPrompt.outputs[0].sha256 = 'sha256:stdout-drift-probe';
      },
      expected: [`agent_prompt ${outputRole.role}.sha256`],
    },
    {
      name: 'agent_prompt stdout byte drift',
      verifier: verifyAgentPromptOutputs,
      mutate(baseline) {
        baseline.agentPrompt.outputs[0].bytes += 1;
      },
      expected: [`agent_prompt ${outputRole.role}.bytes`],
    },
    {
      name: 'agent_prompt role-output drift',
      verifier: verifyAgentPromptOutputs,
      mutate(baseline) {
        baseline.agentPrompt.outputs[0].role = 'probe-renamed-output-role';
      },
      expected: [
        'missing agent_prompt output for probe-renamed-output-role',
        `unregistered current agent_prompt output ${outputRole.role}`,
      ],
    },
    {
      name: 'duplicate agent_prompt output ownership',
      verifier: verifyAgentPromptOutputs,
      mutate(baseline) {
        baseline.agentPrompt.outputs[1].role = baseline.agentPrompt.outputs[0].role;
      },
      expected: [
        `duplicate baseline agent_prompt output: ${outputRole.role}`,
        'baseline agent_prompt role count',
      ],
    },
  ];

  for (const probe of cases) {
    const mutatedBaseline = structuredClone(current);
    probe.mutate(mutatedBaseline);
    const mutationFailures = [];
    probe.verifier(current, mutatedBaseline, mutationFailures);
    if (mutationFailures.length === 0) {
      failures.push(`baseline drift probe ${probe.name}: mutation was accepted`);
      continue;
    }
    for (const fragment of probe.expected) {
      if (!mutationFailures.some(failure => failure.includes(fragment))) {
        failures.push(
          `baseline drift probe ${probe.name}: expected rejection containing ${JSON.stringify(fragment)}, got ${JSON.stringify(mutationFailures)}`,
        );
      }
    }
  }
}

export function buildMechanicalSnapshotFromCollected(reference, promptState) {
  return {
    ...structuredClone(reference),
    registry: {
      ...structuredClone(reference.registry),
      schemaVersion: promptState.snapshot.schemaVersion,
      source: promptState.snapshot.source,
      agentCount: promptState.snapshot.agentCount,
      materialHash: promptState.snapshot.materialHash,
      roles: promptState.roleEntries.map(({ content: _content, ...entry }) => entry),
    },
    agentPrompt: {
      ...structuredClone(reference.agentPrompt),
      outputs: promptState.agentPromptOutputs,
    },
  };
}

export async function verifyRealPromptCollectionBoundaryProbe(current, failures) {
  const sourceTemplateDir = join(ROOT, 'packages/main/templates/agents');
  const probeRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-prompt-baseline-probe-'));
  const probeTemplateDir = join(probeRoot, 'agents');
  const collectProbeState = () => collectPromptStateFromSource({
    templateDir: probeTemplateDir,
    canonicalizeTemplateRelPath: true,
    promptOutputCollector: (_entry, content) => Buffer.from(`${content}\n`, 'utf8'),
  });

  try {
    cpSync(sourceTemplateDir, probeTemplateDir, { recursive: true });
    const pristineState = await collectProbeState();
    const pristine = buildMechanicalSnapshotFromCollected(current, pristineState);
    const pristineFailures = [];
    verifyRegistry(pristine, current, pristineFailures);
    verifyAgentPromptOutputs(pristine, current, pristineFailures);
    if (pristineFailures.length > 0) {
      failures.push(`real collection boundary probe: pristine isolated copy did not pass: ${JSON.stringify(pristineFailures)}`);
      return;
    }

    const target = join(probeTemplateDir, pristineState.snapshot.agents[0].file);
    const original = readFileSync(target, 'utf8');
    try {
      writeFileSync(target, `${original}\n<!-- isolated assembled prompt drift probe -->`, 'utf8');
      const mutatedState = await collectProbeState();
      const mutated = buildMechanicalSnapshotFromCollected(current, mutatedState);
      const mutationFailures = [];
      verifyRegistry(mutated, current, mutationFailures);
      verifyAgentPromptOutputs(mutated, current, mutationFailures);
      const expectedFragments = [
        'registry materialHash',
        `registry ${pristineState.snapshot.agents[0].agentId}.templateHash`,
        `agent_prompt ${pristineState.snapshot.agents[0].agentId}.sha256`,
        `agent_prompt ${pristineState.snapshot.agents[0].agentId}.bytes`,
      ];
      for (const fragment of expectedFragments) {
        if (!mutationFailures.some(failure => failure.includes(fragment))) {
          failures.push(
            `real collection boundary probe: isolated source/output mutation was not rejected for ${fragment}; got ${JSON.stringify(mutationFailures)}`,
          );
        }
      }
    } finally {
      writeFileSync(target, original, 'utf8');
    }

    const restoredState = await collectProbeState();
    const restored = buildMechanicalSnapshotFromCollected(current, restoredState);
    const restoredFailures = [];
    verifyRegistry(restored, current, restoredFailures);
    verifyAgentPromptOutputs(restored, current, restoredFailures);
    if (restoredFailures.length > 0) {
      failures.push(`real collection boundary probe: restored isolated copy did not pass: ${JSON.stringify(restoredFailures)}`);
    }
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
}

export function verifyAgentPromptCommandProbes(failures) {
  const unknownRole = 'probe-unknown-role';
  try {
    runAgentPrompt(unknownRole);
    failures.push('agent_prompt unknown-role command probe: command unexpectedly succeeded');
  } catch (error) {
    const output = [
      error instanceof Error ? error.message : String(error),
      error && typeof error === 'object' && 'stdout' in error
        ? Buffer.from(error.stdout ?? '').toString('utf8')
        : '',
      error && typeof error === 'object' && 'stderr' in error
        ? Buffer.from(error.stderr ?? '').toString('utf8')
        : '',
    ].join('\n');
    if (!output.includes(`agent_prompt: unknown role "${unknownRole}"`)) {
      failures.push(
        `agent_prompt unknown-role command probe: expected explicit unknown-role rejection, got ${JSON.stringify(output)}`,
      );
    }
  }
}

export function verifyRoleMatrixFields(rows, label, failures) {
  for (const [role, row] of rows) {
    if (typeof row.role !== 'string' || row.role.length === 0) {
      failures.push(`${label} ${role}.role: missing or empty role`);
    }
    for (const field of ROLE_MATRIX_FIELDS) {
      if (typeof row[field] !== 'string' || row[field].length === 0) {
        failures.push(`${label} ${role}.${field}: missing or empty string`);
      }
    }
    for (const field of Object.keys(row)) {
      if (field !== 'role' && !ROLE_MATRIX_FIELDS.includes(field)) {
        failures.push(`${label} ${role}.${field}: unknown roleMatrix field`);
      }
    }
  }
}

export function verifyMatrix(current, baseline, failures) {
  const currentRoleMatrix = Array.isArray(current.roleMatrix) ? current.roleMatrix : [];
  const baselineRoleMatrix = Array.isArray(baseline.roleMatrix) ? baseline.roleMatrix : [];
  if (!Array.isArray(current.roleMatrix)) failures.push('current roleMatrix: missing or not an array');
  if (!Array.isArray(baseline.roleMatrix)) failures.push('baseline roleMatrix: missing or not an array');

  const currentRows = mapBy(currentRoleMatrix, row => row.role, 'current matrix role', failures);
  const baselineRows = mapBy(baselineRoleMatrix, row => row.role, 'baseline matrix role', failures);
  requireEqual(currentRows.size, EXPECTED_ROLE_COUNT, 'current matrix role count', failures);
  requireEqual(baselineRows.size, EXPECTED_ROLE_COUNT, 'baseline matrix role count', failures);
  verifyRoleMatrixFields(currentRows, 'current roleMatrix', failures);
  verifyRoleMatrixFields(baselineRows, 'baseline roleMatrix', failures);
  for (const role of baselineRows.keys()) {
    const actual = currentRows.get(role);
    const expected = baselineRows.get(role);
    if (!actual) {
      failures.push(`current matrix missing role ${role}`);
      continue;
    }
    for (const field of ROLE_MATRIX_FIELDS) {
      requireEqual(actual[field], expected[field], `roleMatrix ${role}.${field}`, failures);
    }
  }
  for (const role of currentRows.keys()) {
    if (!baselineRows.has(role)) failures.push(`baseline matrix missing role ${role}`);
  }

  if (!existsSync(MATRIX_PATH)) {
    failures.push(`missing overlap matrix: ${toRepoPath(MATRIX_PATH)}`);
    return;
  }
  const actualMarkdown = normalizeContent(readFileSync(MATRIX_PATH, 'utf8'));
  const expectedMarkdown = normalizeContent(renderMatrixMarkdown(baseline));
  requireSameContent(actualMarkdown, expectedMarkdown, `overlap matrix markdown ${toRepoPath(MATRIX_PATH)}`, failures);
}

export function verifyRoleMatrixAudit(current, baseline, failures) {
  verifyRoleMatrixAuditSnapshot(current.roleMatrixAudit, current.registry.roles, 'current roleMatrixAudit', failures);
  verifyRoleMatrixAuditSnapshot(baseline.roleMatrixAudit, baseline.registry.roles, 'baseline roleMatrixAudit', failures);
  requireSameContent(
    JSON.stringify(current.roleMatrixAudit, null, 2),
    JSON.stringify(baseline.roleMatrixAudit, null, 2),
    'roleMatrixAudit snapshot',
    failures,
  );
}

export function verifyRoleMatrixAuditSnapshot(audit, registryRoles, label, failures) {
  if (!audit || typeof audit !== 'object' || Array.isArray(audit)) {
    failures.push(`${label}: missing or not an object`);
    return;
  }
  requireSameContent(
    JSON.stringify(audit.machineChecks),
    JSON.stringify(ROLE_MATRIX_MACHINE_CHECKS),
    `${label}.machineChecks`,
    failures,
  );
  requireSameContent(
    JSON.stringify(audit.reviewerAuditedFields),
    JSON.stringify(REVIEWER_AUDITED_ROLE_MATRIX_FIELDS),
    `${label}.reviewerAuditedFields`,
    failures,
  );
  requireEqual(audit.semanticBoundary, ROLE_MATRIX_SEMANTIC_BOUNDARY, `${label}.semanticBoundary`, failures);
  requireEqual(
    audit.commandsContract?.includes,
    ROLE_MATRIX_COMMANDS_CONTRACT.includes,
    `${label}.commandsContract.includes`,
    failures,
  );
  requireEqual(
    audit.commandsContract?.excludes,
    ROLE_MATRIX_COMMANDS_CONTRACT.excludes,
    `${label}.commandsContract.excludes`,
    failures,
  );
  requireEqual(
    audit.sourceAuditAnchors?.purpose,
    ROLE_MATRIX_SOURCE_ANCHOR_PURPOSE,
    `${label}.sourceAuditAnchors.purpose`,
    failures,
  );

  const anchors = mapBy(
    Array.isArray(audit.sourceAuditAnchors?.roles) ? audit.sourceAuditAnchors.roles : [],
    anchor => anchor.role,
    `${label} source audit anchor`,
    failures,
  );
  const roles = mapBy(registryRoles ?? [], role => role.role, `${label} registry role`, failures);
  requireEqual(anchors.size, EXPECTED_ROLE_COUNT, `${label} source audit anchor count`, failures);
  for (const [role, registryRole] of roles) {
    const anchor = anchors.get(role);
    if (!anchor) {
      failures.push(`${label}: missing source audit anchor for ${role}`);
      continue;
    }
    requireEqual(anchor.relPath, registryRole.relPath, `${label} ${role}.relPath`, failures);
    requireEqual(anchor.templateHash, registryRole.templateHash, `${label} ${role}.templateHash`, failures);
    for (const field of Object.keys(anchor)) {
      if (!['role', 'relPath', 'templateHash'].includes(field)) {
        failures.push(`${label} ${role}.${field}: unknown source audit anchor field`);
      }
    }
  }
  for (const role of anchors.keys()) {
    if (!roles.has(role)) failures.push(`${label}: source audit anchor has unknown role ${role}`);
  }
}

export function verifyFindings(currentFindings, baselineFindings, label, failures) {
  const currentMap = mapBy(currentFindings, buildFindingKey, `current ${label}`, failures);
  const baselineMap = mapBy(baselineFindings, buildFindingKey, `baseline ${label}`, failures);

  for (const [key, actual] of currentMap) {
    const expected = baselineMap.get(key);
    if (!expected) {
      failures.push(`unclassified ${label}: ${actual.role}:${actual.line} ${actual.excerpt}`);
      continue;
    }
    requireEqual(actual.classification, expected.classification, `${label} ${key}.classification`, failures);
    if ('grandfathered' in expected) {
      requireEqual(actual.grandfathered, expected.grandfathered, `${label} ${key}.grandfathered`, failures);
    }
    for (const field of [
      'clauseIndex',
      'occurrence',
      'matchedText',
      'clause',
      'roleStatus',
      'statusClassification',
      'policyStatus',
      'policyReason',
    ]) {
      if (field in actual || field in expected) {
        requireEqual(actual[field], expected[field], `${label} ${key}.${field}`, failures);
      }
    }
  }

  for (const [key, expected] of baselineMap) {
    if (!currentMap.has(key)) {
      failures.push(`baseline ${label} no longer present: ${expected.role}:${expected.line} ${expected.excerpt}`);
    }
  }
}

export function verifyLegacyVocabularyPolicy(current, baseline, failures) {
  const expectedPolicy = buildLegacyVocabularyPolicyAudit();
  requireSameContent(
    JSON.stringify(current.legacyVocabulary.policy, null, 2),
    JSON.stringify(expectedPolicy, null, 2),
    'current legacyVocabulary.policy',
    failures,
  );
  requireSameContent(
    JSON.stringify(baseline.legacyVocabulary.policy, null, 2),
    JSON.stringify(expectedPolicy, null, 2),
    'baseline legacyVocabulary.policy',
    failures,
  );
  for (const error of legacyVocabularyPolicyErrors(current.legacyVocabulary.findings)) {
    failures.push(`current legacy-vocabulary policy: ${error}`);
  }
  for (const error of legacyVocabularyPolicyErrors(baseline.legacyVocabulary.findings)) {
    failures.push(`baseline legacy-vocabulary policy: ${error}`);
  }
}

export function verifyDirectStoryReferencePolicy(current, baseline, failures) {
  const expectedPolicy = buildDirectStoryPolicyAudit();
  requireSameContent(
    JSON.stringify(current.directStoryFileReferences.policy, null, 2),
    JSON.stringify(expectedPolicy, null, 2),
    'current directStoryFileReferences.policy',
    failures,
  );
  requireSameContent(
    JSON.stringify(baseline.directStoryFileReferences.policy, null, 2),
    JSON.stringify(expectedPolicy, null, 2),
    'baseline directStoryFileReferences.policy',
    failures,
  );
  for (const [label, value] of [['current', current], ['baseline', baseline]]) {
    for (const error of directStoryReferenceExerciseErrors(value.directStoryFileReferences.findings)) {
      failures.push(`${label} exact story-reference exercise: ${error}`);
    }
  }
  const findings = current.directStoryFileReferences.findings;
  for (const allow of DIRECT_STORY_REFERENCE_ALLOWLIST) {
    const matches = finding => canonicalPromptRoleId(finding.role) === canonicalPromptRoleId(allow.role)
      && finding.excerpt === allow.excerpt;
    const finding = findings.find(matches);
    for (const [label, changed] of [
      ['missing', findings.filter(row => !matches(row))],
      ['duplicate', [...findings, finding]],
      ['classification', findings.map(row => matches(row) ? { ...row, classification: 'unclassified-actionable' } : row)],
      ['authority', findings.map(row => matches(row) ? { ...row, grandfathered: false } : row)],
    ]) {
      requireEqual(directStoryReferenceExerciseErrors(changed).length > 0, true,
        `exact story-reference ${label} refusal for ${allow.role}`, failures);
    }
  }
  requireEqual(directStoryReferenceExerciseErrors(findings, [...DIRECT_STORY_REFERENCE_ALLOWLIST,
    { role: 'proof-or-stop-product-reviewer', classification: 'read-only-reference',
      excerpt: '- If available, `docs/story/actives/<storyId>/evidence/live-smoke-transcript.json`' }]).length > 0,
    true, 'stale story-reference allow entry refused', failures);
  requireEqual(directStoryReferenceExerciseErrors(findings,
    [...DIRECT_STORY_REFERENCE_ALLOWLIST, DIRECT_STORY_REFERENCE_ALLOWLIST[0]]).length > 0,
    true, 'duplicate story-reference allow entry refused', failures);
}

export function directStoryReferenceExerciseErrors(findings, allowlist = DIRECT_STORY_REFERENCE_ALLOWLIST) {
  const errors = [], seen = new Set();
  for (const allow of allowlist) {
    const role = canonicalPromptRoleId(allow.role), key = JSON.stringify([role, allow.excerpt]);
    if (seen.has(key)) errors.push(`duplicate exact story-reference allow entry for ${allow.role}`);
    seen.add(key);
    const matches = findings.filter(finding => finding
      && canonicalPromptRoleId(finding.role) === role && finding.excerpt === allow.excerpt
      && finding.classification === allow.classification && finding.grandfathered === true);
    if (matches.length !== 1) {
      errors.push(`exact story-reference allow entry must match exactly once for ${allow.role}: matched ${matches.length}`);
    }
  }
  return errors;
}

export function verifyLegacyVocabularyPolicyProbes(failures) {
  for (const probe of LEGACY_VOCABULARY_POLICY_PROBES) {
    const expectedStatusClassification = probe.statusClassification ?? 'enforced';
    requireEqual(
      classifyLegacyRoleStatus(probe.status),
      expectedStatusClassification,
      `legacy vocabulary policy probe ${probe.name}.statusClassification`,
      failures,
    );
    let findings = [];
    let rejection = '';
    try {
      findings = scanLegacyVocabulary([
        { role: probe.role, status: probe.status, content: probe.content },
      ]);
    } catch (error) {
      rejection = String(error instanceof Error ? error.message : error);
    }
    if (expectedStatusClassification === 'unknown-status') {
      if (!rejection.includes(probe.expectedRejection)) {
        failures.push(
          `legacy vocabulary policy probe ${probe.name}: expected scanner rejection containing ${JSON.stringify(probe.expectedRejection)}, got ${JSON.stringify(rejection)}`,
        );
      }
      continue;
    }
    if (rejection) {
      failures.push(
        `legacy vocabulary policy probe ${probe.name}: unexpected scanner rejection ${JSON.stringify(rejection)}`,
      );
      continue;
    }
    if (findings.length === 0) {
      failures.push(`legacy vocabulary policy probe ${probe.name}: no occurrence classified`);
    }
    if (!findings.some(finding => finding.policyStatus === 'blocked-active-use')) {
      failures.push(
        `legacy vocabulary policy probe ${probe.name}: no occurrence classified as blocked-active-use`,
      );
    }
  }

  for (const probe of LEGACY_VOCABULARY_ALLOWED_PROBES) {
    requireEqual(
      classifyLegacyRoleStatus(probe.status),
      'enforced',
      `legacy vocabulary allowed probe ${probe.name}.statusClassification`,
      failures,
    );
    const findings = scanLegacyVocabulary([
      { role: probe.role, status: probe.status, content: probe.content },
    ]);
    if (findings.length === 0) {
      failures.push(`legacy vocabulary allowed probe ${probe.name}: no occurrence classified`);
      continue;
    }
    for (const finding of findings) {
      requireEqual(
        finding.policyStatus,
        probe.policyStatus,
        `legacy vocabulary allowed probe ${probe.name}.policyStatus`,
        failures,
      );
    }
  }
}

export function verifyNoUnregisteredDirectStoryWrite(current, baseline, failures) {
  const baselineMap = mapBy(
    baseline.directStoryFileReferences.findings,
    buildFindingKey,
    'baseline direct story-file finding',
    failures,
  );
  for (const finding of current.directStoryFileReferences.findings) {
    if (finding.classification !== 'direct-write') continue;
    const registered = baselineMap.get(buildFindingKey(finding));
    if (!registered || registered.classification !== 'direct-write') {
      failures.push(`new unregistered direct docs/story write instruction: ${finding.role}:${finding.line} ${finding.excerpt}`);
      continue;
    }
    if (!registered.grandfathered) {
      failures.push(`direct docs/story write is not explicitly grandfathered: ${finding.role}:${finding.line}`);
    }
  }
}

export function directStoryWritePolicyErrors(findings) {
  const errors = [];
  for (const finding of findings) {
    const location = `${finding.role}:${finding.line ?? 'probe'}`;
    if (finding.classification === 'unclassified-actionable') {
      errors.push(`unclassified actionable reference at ${location}: ${finding.excerpt}`);
      continue;
    }
    if (finding.classification !== 'direct-write') continue;
    const explicitlyGrandfathered = isExplicitlyGrandfatheredDirectStoryWrite(
      finding.role,
      finding.excerpt,
    );
    if (finding.grandfathered !== explicitlyGrandfathered) {
      errors.push(`direct write grandfathering mismatch at ${location}: ${finding.excerpt}`);
    }
    if (!explicitlyGrandfathered) {
      errors.push(`direct write is not explicitly grandfathered at ${location}: ${finding.excerpt}`);
    }
  }

  for (const allow of DIRECT_STORY_WRITE_ALLOWLIST) {
    const canonicalAllowRole = canonicalPromptRoleId(allow.role);
    const matches = findings.filter(
      finding =>
        finding.classification === 'direct-write' &&
        canonicalPromptRoleId(finding.role) === canonicalAllowRole &&
        finding.excerpt === allow.excerpt &&
        finding.grandfathered === true,
    );
    if (matches.length !== 1) {
      errors.push(
        `explicit direct-write allow entry must match exactly once for ${allow.role}: matched ${matches.length}`,
      );
    }
  }
  return errors;
}

export function assertDirectStoryWritePolicy(findings) {
  const errors = directStoryWritePolicyErrors(findings);
  if (errors.length === 0) return;
  throw new Error(
    `Refusing to collect or refresh the baseline because direct story-write policy failed:\n- ${errors.join('\n- ')}`,
  );
}

export function verifyDirectStoryWritePolicy(findings, label, failures) {
  for (const error of directStoryWritePolicyErrors(findings)) {
    failures.push(`${label} direct story-write policy: ${error}`);
  }
}

export function verifyDirectStoryClassifierProbes(failures) {
  requireEqual(
    DIRECT_STORY_WRITE_ALLOWLIST.length,
    0,
    'direct story-write explicit allow entry count',
    failures,
  );
  for (const probe of DIRECT_STORY_CLASSIFIER_PROBES) {
    const actual = classifyStoryFinding(probe.role, probe.excerpt);
    requireEqual(actual.classification, probe.classification, `direct story classifier probe ${probe.name}.classification`, failures);
    requireEqual(actual.grandfathered, probe.grandfathered, `direct story classifier probe ${probe.name}.grandfathered`, failures);
  }

  for (const probe of DIRECT_STORY_SCANNER_PROBES) {
    const findings = scanStoryFileReferences([{ role: probe.role, content: probe.content }]);
    requireEqual(findings.length, 1, `direct story scanner probe ${probe.name}.finding count`, failures);
    const actual = findings[0];
    if (!actual) continue;
    requireEqual(actual.line, probe.line, `direct story scanner probe ${probe.name}.line`, failures);
    if (probe.excerpt) {
      requireEqual(actual.excerpt, probe.excerpt, `direct story scanner probe ${probe.name}.excerpt`, failures);
    }
    if (probe.references) {
      requireSameContent(
        JSON.stringify(actual.references),
        JSON.stringify(probe.references),
        `direct story scanner probe ${probe.name}.references`,
        failures,
      );
    }
    requireEqual(actual.classification, probe.classification, `direct story scanner probe ${probe.name}.classification`, failures);
    requireEqual(actual.grandfathered, probe.grandfathered, `direct story scanner probe ${probe.name}.grandfathered`, failures);
  }
}

export function promptEntriesWithAddition(roleEntries, probe) {
  const mutated = structuredClone(roleEntries);
  const entry = mutated.find(candidate => candidate.role === probe.role);
  if (!entry) throw new Error(`prompt policy probe role not found: ${probe.role}`);
  entry.content = `${entry.content}\n${probe.addition}`;
  entry.templateHash = sha256(entry.content);
  return mutated;
}

export function capturePromptPolicyRejection(callback) {
  try {
    callback();
    return '';
  } catch (error) {
    return String(error instanceof Error ? error.message : error);
  }
}

export function requirePromptPolicyRejection(name, callback, expected, failures) {
  const rejection = capturePromptPolicyRejection(callback);
  if (!rejection.includes(expected)) {
    failures.push(
      `prompt policy manifest probe ${name}: expected rejection containing ${JSON.stringify(expected)}, got ${JSON.stringify(rejection)}`,
    );
  }
}
