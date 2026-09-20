

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { BUILT_PROMPT_MEASUREMENT_PATH, PROMPT_MEASUREMENT_BASELINE_PATH, EXPECTED_ROLE_COUNT, APPROVED_ROLE_BODY_ROLLOUT_MANIFEST, ROOT, STORY_INIT_PROMPT_SURFACES, STORY_INIT_REQUIRED_CLI_COMMANDS, STORY_INIT_METADATA_DETAIL_QUERY, STORY_INIT_METADATA_DETAIL_FIELDS, STORY_INIT_FORBIDDEN_ACTIVE_FRAGMENTS, roleMatrixDefaultsFor, SCHEMA_VERSION, PLAN_PATH, BUILT_REGISTRY_PATH, LEGACY_PATTERNS, LEGACY_VOCABULARY_KNOWN_STATUSES, LEGACY_VOCABULARY_EXEMPT_STATUSES, LEGACY_VOCABULARY_ENFORCED_STATUSES, LEGACY_VOCABULARY_CONTEXT_ALLOWLIST, LEGACY_VOCABULARY_POLICY_RULE, STORY_INSTRUCTION_CONTEXT_RADIUS, DIRECT_STORY_REFERENCE_ALLOWLIST, DIRECT_STORY_WRITE_ALLOWLIST, DIRECT_STORY_POLICY_RULE, ROLE_MATRIX_MACHINE_CHECKS, REVIEWER_AUDITED_ROLE_MATRIX_FIELDS, ROLE_MATRIX_SEMANTIC_BOUNDARY, ROLE_MATRIX_COMMANDS_CONTRACT, ROLE_MATRIX_SOURCE_ANCHOR_PURPOSE, BASELINE_PATH } from './policy-data.mjs';
import { loadBuiltRegistry, loadBuiltRoleContractRegistry, assertApprovedCanonicalRollout, runAgentPrompt, normalizeCliPrint, sha256, countLines, assertApprovedPromptPolicyManifest, collectDirectStoryFindings, collectLegacyVocabularyFindings, buildPromptPolicyManifestAudit, toRepoPath } from './scanners.mjs';

export async function verifyPromptMeasurementSidecar(failures) {
  if (!existsSync(BUILT_PROMPT_MEASUREMENT_PATH)) {
    failures.push('built prompt measurement module is missing; run packages/main build');
    return;
  }
  if (!existsSync(PROMPT_MEASUREMENT_BASELINE_PATH)) {
    failures.push('role-prompt measurement sidecar is missing');
    return;
  }
  const measurementModule = await import(
    `${pathToFileURL(BUILT_PROMPT_MEASUREMENT_PATH).href}?v=${Date.now()}`
  );
  const current = measurementModule.generatePromptMeasurementReport();
  const canonicalCurrent = measurementModule.canonicalPromptMeasurementReportJson(current);
  const checkedIn = readFileSync(PROMPT_MEASUREMENT_BASELINE_PATH, 'utf8');
  if (checkedIn !== canonicalCurrent) {
    failures.push('role-prompt measurement sidecar differs from the deterministic current report');
  }
  try {
    measurementModule.verifyPromptMeasurementReport(JSON.parse(checkedIn));
  } catch (error) {
    failures.push(`role-prompt measurement sidecar validation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (current.records?.length !== EXPECTED_ROLE_COUNT) {
    failures.push(`role-prompt measurement sidecar expected ${EXPECTED_ROLE_COUNT} records, got ${current.records?.length ?? 'missing'}`);
  }
  if (
    current.aggregate?.activeRoleCount !== 14 ||
    current.aggregate?.compatibilityRoleCount !== 3 ||
    current.aggregate?.retiredRoleCount !== 1
  ) {
    failures.push('role-prompt measurement sidecar lifecycle partition must remain 14 active / 3 compatibility / 1 retired');
  }
  for (const [index, record] of (current.records ?? []).entries()) {
    if (record.schemaVersion !== 'proof-or-stop.prompt-measurement.v1') {
      failures.push(`role-prompt measurement record ${index} has unsupported schema`);
    }
    if (record.knownDispatchInputTokens?.availability !== 'unavailable') {
      failures.push(`role-prompt measurement record ${record.roleId ?? index} must keep no-Story known-dispatch input unavailable`);
    }
    if (record.providerProcessedInputTokens?.availability !== 'unavailable') {
      failures.push(`role-prompt measurement record ${record.roleId ?? index} must keep no-provider processed input unavailable`);
    }
  }
  if (/prompt-envelope|envelopeId|reviewRunId/i.test(checkedIn)) {
    failures.push('role-prompt measurement sidecar must not instantiate PromptEnvelope or ReviewRun authority');
  }
}

export async function collectPromptStateFromSource({
  templateDir,
  promptOutputCollector,
  canonicalizeTemplateRelPath = false,
} = {}) {
  const { readPromptRegistry, renderPromptEntryForHost } = await loadBuiltRegistry();
  const {
    PROMPT_ENVELOPE_ROLLOUT_VERSION,
    PROMPT_ROLE_CONTRACTS,
    resolvePromptRoleBody,
    reviewerHostRenderIdentity,
  } = await loadBuiltRoleContractRegistry();
  const snapshot = readPromptRegistry(templateDir);
  const rolloutConfig = {
    version: PROMPT_ENVELOPE_ROLLOUT_VERSION,
    roles: Object.fromEntries(APPROVED_ROLE_BODY_ROLLOUT_MANIFEST.map(entry => [entry.role, 'full-envelope'])),
  };
  const roleEntries = [];
  const agentPromptOutputs = [];
  const actualRollout = [];

  // Independent pins must be compared with actual current resolver outputs,
  // not merely copied into a generated approval audit.
  for (const approved of APPROVED_ROLE_BODY_ROLLOUT_MANIFEST) {
    const selected = resolvePromptRoleBody(approved.role, rolloutConfig, snapshot);
    const contract = PROMPT_ROLE_CONTRACTS.find(entry => entry.roleId === approved.role);
    const actual = {
      role: approved.role,
      modularBodySha256: selected.bodyDigest,
      roleSemanticDigest: contract?.semanticDigest,
      roleRenderDigest: contract?.renderDigest,
      modularClaudeRenderDigest: reviewerHostRenderIdentity(ROOT, approved.role, 'claude', 'full-envelope').identityDigest,
      modularCodexRenderDigest: reviewerHostRenderIdentity(ROOT, approved.role, 'codex', 'full-envelope').identityDigest,
    };
    actualRollout.push(actual);
  }
  assertApprovedCanonicalRollout(actualRollout);

  for (const entry of snapshot.agents) {
    const selected = resolvePromptRoleBody(entry.agentId, rolloutConfig, snapshot);
    const content = selected.body;
    const expectedAgentPrompt = renderPromptEntryForHost(entry, 'claude', selected.mode);
    const stdout = promptOutputCollector
      ? promptOutputCollector(entry, expectedAgentPrompt)
      : runAgentPrompt(entry.agentId);
    const stdoutText = stdout.toString('utf8');
    const normalized = normalizeCliPrint(stdoutText);
    if (normalized !== expectedAgentPrompt) {
      throw new Error(`agent_prompt output does not match the actual registry host render for ${entry.agentId}`);
    }
    roleEntries.push({
      role: entry.agentId,
      file: entry.file,
      relPath: canonicalizeTemplateRelPath
        ? `templates/agents/${entry.file}`
        : entry.relPath,
      templateHash: sha256(content),
      bytes: Buffer.byteLength(content),
      lines: countLines(content),
      content,
    });
    agentPromptOutputs.push({
      role: entry.agentId,
      sha256: sha256(stdout),
      bytes: stdout.length,
      lines: countLines(stdoutText),
    });
  }

  return { snapshot, roleEntries, agentPromptOutputs, actualRollout };
}

export async function collectCurrentPromptState() {
  return collectPromptStateFromSource();
}

export function assertStoryInitCliOnlyPromptSurfaces(roleEntries) {
  const assembled = roleEntries.find(entry => entry.role === 'proof-or-stop-review-story-init');
  if (!assembled) throw new Error('missing assembled proof-or-stop-review-story-init prompt');
  const surfaces = [
    ...STORY_INIT_PROMPT_SURFACES.map(path => ({ path, content: readFileSync(join(ROOT, path), 'utf8') })),
    { path: 'assembled:proof-or-stop-review-story-init', content: assembled.content },
  ];
  const errors = [];
  for (const surface of surfaces) {
    for (const command of STORY_INIT_REQUIRED_CLI_COMMANDS) {
      if (!surface.content.includes(command)) errors.push(`${surface.path}: missing ${command}`);
    }
    if (!surface.content.includes(STORY_INIT_METADATA_DETAIL_QUERY)) {
      errors.push(`${surface.path}: missing exact Story metadata detail query ${STORY_INIT_METADATA_DETAIL_QUERY}`);
    }
    if (!surface.content.includes(STORY_INIT_METADATA_DETAIL_FIELDS)) {
      errors.push(`${surface.path}: missing result.index Story metadata field contract`);
    }
    for (const fragment of STORY_INIT_FORBIDDEN_ACTIVE_FRAGMENTS) {
      if (surface.content.includes(fragment)) errors.push(`${surface.path}: forbidden active fragment ${fragment}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`story-init CLI-only prompt policy failed:\n- ${errors.join('\n- ')}`);
  }
}

export function buildCurrentBaseline({ snapshot, roleEntries, agentPromptOutputs }) {
  assertStoryInitCliOnlyPromptSurfaces(roleEntries);
  assertApprovedPromptPolicyManifest(roleEntries);

  const roleMatrix = roleEntries.map(entry => {
    const matrix = roleMatrixDefaultsFor(entry.role);
    if (!matrix) throw new Error(`missing matrix defaults for role ${entry.role}`);
    return { role: entry.role, ...matrix };
  });
  const directStoryFindings = collectDirectStoryFindings(roleEntries);
  const legacyVocabularyFindings = collectLegacyVocabularyFindings(roleEntries);

  return {
    schemaVersion: SCHEMA_VERSION,
    storyId: 'B-3928',
    sourcePlan: PLAN_PATH,
    expectedRoleCount: EXPECTED_ROLE_COUNT,
    promptPolicyApproval: buildPromptPolicyManifestAudit(),
    registry: {
      module: toRepoPath(BUILT_REGISTRY_PATH),
      schemaVersion: snapshot.schemaVersion,
      source: snapshot.source,
      agentCount: snapshot.agentCount,
      materialHash: snapshot.materialHash,
      roles: roleEntries.map(({ content: _content, ...entry }) => entry),
    },
    agentPrompt: {
      command: 'node bin/proof-or-stop.js agent_prompt --role=<role>',
      metadata: 'sha256, bytes, and lines are computed from raw stdout; registry parity strips the CLI print newline only.',
      outputs: agentPromptOutputs,
    },
    roleMatrix,
    roleMatrixAudit: buildRoleMatrixAudit(roleEntries),
    legacyVocabulary: {
      policy: buildLegacyVocabularyPolicyAudit(),
      patterns: LEGACY_PATTERNS.map(pattern => pattern.term),
      findings: legacyVocabularyFindings,
    },
    directStoryFileReferences: {
      policy: buildDirectStoryPolicyAudit(),
      classifications: [
        'policy-reminder',
        'read-only-reference',
        'process-event-evidence-reference',
        'direct-read',
        'direct-write',
        'unclassified-actionable',
        'other',
      ],
      findings: directStoryFindings,
    },
  };
}

export async function collectCurrentBaseline() {
  return buildCurrentBaseline(await collectCurrentPromptState());
}

export function buildLegacyVocabularyPolicyAudit() {
  return {
    primaryBoundary: 'promptPolicyApproval',
    scannerAuthority: 'diagnostic-only',
    knownStatuses: [...LEGACY_VOCABULARY_KNOWN_STATUSES],
    exemptStatuses: [...LEGACY_VOCABULARY_EXEMPT_STATUSES],
    enforcedStatuses: [...LEGACY_VOCABULARY_ENFORCED_STATUSES],
    registeredContexts: LEGACY_VOCABULARY_CONTEXT_ALLOWLIST.map(entry => ({
      role: entry.role,
      term: entry.term,
      excerpt: entry.excerpt,
      reason: entry.reason,
    })),
    rule: LEGACY_VOCABULARY_POLICY_RULE,
  };
}

export function buildDirectStoryPolicyAudit() {
  return {
    model: 'registered-diagnostics-inside-manifest-approved-prompts',
    primaryBoundary: 'promptPolicyApproval',
    scannerAuthority: 'diagnostic-only',
    contextRadius: STORY_INSTRUCTION_CONTEXT_RADIUS,
    exactReferences: DIRECT_STORY_REFERENCE_ALLOWLIST.map(entry => ({ ...entry })),
    exactWrites: DIRECT_STORY_WRITE_ALLOWLIST.map(entry => ({ ...entry })),
    rule: DIRECT_STORY_POLICY_RULE,
  };
}

export function buildRoleMatrixAudit(roleEntries) {
  return {
    machineChecks: [...ROLE_MATRIX_MACHINE_CHECKS],
    reviewerAuditedFields: [...REVIEWER_AUDITED_ROLE_MATRIX_FIELDS],
    semanticBoundary: ROLE_MATRIX_SEMANTIC_BOUNDARY,
    commandsContract: { ...ROLE_MATRIX_COMMANDS_CONTRACT },
    sourceAuditAnchors: {
      purpose: ROLE_MATRIX_SOURCE_ANCHOR_PURPOSE,
      roles: roleEntries.map(entry => ({
        role: entry.role,
        relPath: entry.relPath,
        templateHash: entry.templateHash,
      })),
    },
  };
}

export function renderMatrixMarkdown(baseline) {
  const audit = baseline.roleMatrixAudit;
  const rows = baseline.roleMatrix.map(row => [
    row.role,
    row.status,
    row.phase,
    row.purpose,
    row.commands,
    row.directFileAccess,
    row.inputs,
    row.outputs,
    row.capabilities,
    row.overlapCategory,
    row.notes,
  ]);

  return [
    '# Proof-or-Stop Prompt Overlap Matrix',
    '',
    `Source plan: \`${baseline.sourcePlan}\``,
    `Registry material hash: \`${baseline.registry.materialHash}\``,
    `Role count: ${baseline.registry.agentCount}`,
    '',
    '## Audit Boundary',
    '',
    `- Prompt policy boundary: ${baseline.promptPolicyApproval.primaryBoundary}`,
    `- Machine-checked: ${audit.machineChecks.join(' ')}`,
    `- Reviewer-audited fields: ${audit.reviewerAuditedFields.map(field => `\`${field}\``).join(', ')}.`,
    `- Semantic limit: ${audit.semanticBoundary}`,
    `- Commands includes: ${audit.commandsContract.includes}`,
    `- Commands excludes: ${audit.commandsContract.excludes}`,
    `- Source audit anchors: ${audit.sourceAuditAnchors.purpose}`,
    '',
    '| Role | Status | Phase | Purpose | Commands | Direct file access | Inputs | Outputs | Capabilities | Overlap category | Notes |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map(row => `| ${row.map(escapeMarkdownCell).join(' | ')} |`),
    '',
  ].join('\n');
}

export function escapeMarkdownCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

export function readBaseline() {
  if (!existsSync(BASELINE_PATH)) {
    throw new Error(`Missing baseline lockfile: ${toRepoPath(BASELINE_PATH)}`);
  }
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
}

export function requireEqual(actual, expected, label, failures) {
  if (actual !== expected) {
    failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function normalizeContent(text) {
  return text.replace(/\r\n/g, '\n');
}

export function requireSameContent(actual, expected, label, failures) {
  if (actual === expected) return;

  const actualLines = actual.split('\n');
  const expectedLines = expected.split('\n');
  const maxLines = Math.max(actualLines.length, expectedLines.length);
  let mismatchLine = 1;
  for (let index = 0; index < maxLines; index += 1) {
    if (actualLines[index] !== expectedLines[index]) {
      mismatchLine = index + 1;
      break;
    }
  }

  failures.push(
    `${label}: content mismatch at line ${mismatchLine}; expected ${JSON.stringify(expectedLines[mismatchLine - 1] ?? '<EOF>')}, got ${JSON.stringify(actualLines[mismatchLine - 1] ?? '<EOF>')}`,
  );
  failures.push(
    `${label}: expected sha256 ${sha256(expected)}, got ${sha256(actual)}`,
  );
}

export function mapBy(items, keyFn, label, failures) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (map.has(key)) failures.push(`duplicate ${label}: ${key}`);
    map.set(key, item);
  }
  return map;
}
