

import { requirePromptPolicyRejection, promptEntriesWithAddition, verifyPromptPolicyManifestAuditSnapshot, verifyMatrix } from './verification.mjs';
import { assertApprovedCanonicalRollout, approvedPromptPolicyManifestErrors, sha256, assertApprovedPromptPolicyManifest, collectDirectStoryFindings, collectLegacyVocabularyFindings, buildPromptPolicyManifestAudit } from './scanners.mjs';
import { PROMPT_POLICY_DIRECT_COLLECTION_PROBES, PROMPT_POLICY_LEGACY_COLLECTION_PROBES, APPROVED_PROMPT_POLICY_MANIFEST } from './policy-data.mjs';
import { buildCurrentBaseline } from './collection.mjs';

export async function verifyPromptPolicyManifestProbes(promptState, failures) {
  for (let index = 0; index < promptState.actualRollout.length; index += 1) {
    for (const field of Object.keys(promptState.actualRollout[index]).filter(key => key !== 'role')) {
      const mutated = structuredClone(promptState.actualRollout);
      mutated[index][field] = '0'.repeat(64);
      requirePromptPolicyRejection(`actual canonical rollout ${index}.${field}`,
        () => assertApprovedCanonicalRollout(mutated), 'approved canonical rollout mismatch', failures);
    }
  }
  for (const mutate of [rows => rows.pop(), rows => { rows[0].retiredModeDigest = '0'.repeat(64); },
    rows => { rows[0].role = rows[1].role; }]) {
    const mutated = structuredClone(promptState.actualRollout);
    mutate(mutated);
    requirePromptPolicyRejection('actual canonical rollout structure',
      () => assertApprovedCanonicalRollout(mutated), 'approved canonical rollout', failures);
  }
  const roleEntries = promptState.roleEntries;
  const approvedErrors = approvedPromptPolicyManifestErrors(roleEntries);
  if (approvedErrors.length > 0) {
    failures.push(
      `prompt policy manifest approved control failed: ${JSON.stringify(approvedErrors)}`,
    );
    return;
  }

  const firstRole = roleEntries[0]?.role;
  if (!firstRole) {
    failures.push('prompt policy manifest probes require at least one approved role');
    return;
  }
  const structuralCases = [
    {
      name: 'missing entry hash',
      expected: `missing prompt policy collector templateHash for ${firstRole}`,
      mutate(entries) {
        delete entries[0].templateHash;
      },
    },
    {
      name: 'altered content with stale entry hash',
      expected: `prompt policy collector content hash mismatch for ${firstRole}`,
      mutate(entries) {
        entries[0].content += '\nprompt-policy-content-drift';
      },
    },
    {
      name: 'altered entry hash',
      expected: `prompt policy collector content hash mismatch for ${firstRole}`,
      mutate(entries) {
        entries[0].templateHash = '0'.repeat(64);
      },
    },
    {
      name: 'changed body with internally matching hash',
      expected: `approved prompt policy manifest hash mismatch for ${firstRole}`,
      mutate(entries) {
        entries[0].content += '\nprompt-policy-self-authorize-attempt';
        entries[0].templateHash = sha256(entries[0].content);
      },
    },
    {
      name: 'added role',
      expected: 'unapproved prompt policy collector role probe-added-role',
      mutate(entries) {
        entries.push({ ...entries[0], role: 'probe-added-role' });
      },
    },
    {
      name: 'removed role',
      expected: `approved prompt policy manifest role missing from collector ${firstRole}`,
      mutate(entries) {
        entries.shift();
      },
    },
    {
      name: 'renamed role',
      expected: 'unapproved prompt policy collector role probe-renamed-role',
      mutate(entries) {
        entries[0].role = 'probe-renamed-role';
      },
    },
    {
      name: 'duplicate role ownership',
      expected: `duplicate prompt policy collector role ${firstRole}`,
      mutate(entries) {
        entries.push({ ...entries[0] });
      },
    },
  ];

  for (const probe of structuralCases) {
    const mutated = structuredClone(roleEntries);
    probe.mutate(mutated);
    requirePromptPolicyRejection(
      probe.name,
      () => assertApprovedPromptPolicyManifest(mutated),
      probe.expected,
      failures,
    );
  }

  requirePromptPolicyRejection(
    'synthetic direct collector lacks approved role and hash',
    () => collectDirectStoryFindings([
      { role: 'probe-synthetic-direct', content: 'Write docs/story/probe.json.' },
    ]),
    'prompt policy collector role count',
    failures,
  );
  requirePromptPolicyRejection(
    'synthetic legacy collector lacks approved role and hash',
    () => collectLegacyVocabularyFindings([
      { role: 'probe-synthetic-legacy', status: 'active', content: 'Set testIntent.' },
    ]),
    'prompt policy collector role count',
    failures,
  );

  for (const probe of PROMPT_POLICY_DIRECT_COLLECTION_PROBES) {
    const mutated = promptEntriesWithAddition(roleEntries, probe);
    requirePromptPolicyRejection(
      `direct collection ${probe.name}`,
      () => collectDirectStoryFindings(mutated),
      `approved prompt policy manifest hash mismatch for ${probe.role}`,
      failures,
    );
  }
  for (const probe of PROMPT_POLICY_LEGACY_COLLECTION_PROBES) {
    const mutated = promptEntriesWithAddition(roleEntries, probe);
    requirePromptPolicyRejection(
      `legacy collection ${probe.name}`,
      () => collectLegacyVocabularyFindings(mutated),
      `approved prompt policy manifest hash mismatch for ${probe.role}`,
      failures,
    );
  }

  const refreshMutation = promptEntriesWithAddition(
    roleEntries,
    PROMPT_POLICY_DIRECT_COLLECTION_PROBES[0],
  );
  let refreshRejection = '';
  try {
    buildCurrentBaseline({ ...promptState, roleEntries: refreshMutation });
  } catch (error) {
    refreshRejection = String(error instanceof Error ? error.message : error);
  }
  if (!refreshRejection.includes('approved prompt policy manifest hash mismatch')) {
    failures.push(
      `prompt policy manifest probe baseline refresh self-authorization: expected manifest rejection, got ${JSON.stringify(refreshRejection)}`,
    );
  }

  const auditCases = [
    {
      name: 'audit role hash mutation',
      expected: `${APPROVED_PROMPT_POLICY_MANIFEST[0].role}.templateHash`,
      mutate(audit) {
        audit.roles[0].templateHash = '0'.repeat(64);
      },
    },
    {
      name: 'audit role rename',
      expected: 'unapproved role probe-renamed-role',
      mutate(audit) {
        audit.roles[0].role = 'probe-renamed-role';
      },
    },
    {
      name: 'audit role addition',
      expected: 'unapproved role probe-added-role',
      mutate(audit) {
        audit.roles.push({ ...audit.roles[0], role: 'probe-added-role' });
      },
    },
    {
      name: 'audit role removal',
      expected: `missing approved role ${APPROVED_PROMPT_POLICY_MANIFEST[0].role}`,
      mutate(audit) {
        audit.roles.shift();
      },
    },
    {
      name: 'rollout modular body hash mutation',
      expected: 'roleBodyRollout',
      mutate(audit) {
        audit.roleBodyRollout[0].modularBodySha256 = '0'.repeat(64);
      },
    },
    {
      name: 'rollout host identity removal',
      expected: 'roleBodyRollout',
      mutate(audit) {
        delete audit.roleBodyRollout[0].modularCodexRenderDigest;
      },
    },
  ];
  for (const probe of auditCases) {
    const mutatedAudit = buildPromptPolicyManifestAudit();
    probe.mutate(mutatedAudit);
    const auditFailures = [];
    verifyPromptPolicyManifestAuditSnapshot(
      mutatedAudit,
      `prompt policy manifest probe ${probe.name}`,
      auditFailures,
    );
    if (!auditFailures.some(failure => failure.includes(probe.expected))) {
      failures.push(
        `prompt policy manifest probe ${probe.name}: expected audit rejection containing ${JSON.stringify(probe.expected)}, got ${JSON.stringify(auditFailures)}`,
      );
    }
  }
}

export function verifyRoleMatrixSnapshotDriftProbe(current, failures) {
  const mutatedBaseline = structuredClone(current);
  const row = mutatedBaseline.roleMatrix.find(candidate => candidate.role === 'proof-or-stop-review-behavior');
  if (!row) {
    failures.push('role matrix snapshot drift probe: proof-or-stop-review-behavior row missing');
    return;
  }
  row.commands = `${row.commands} snapshot-drift-sentinel`;

  const driftFailures = [];
  verifyMatrix(current, mutatedBaseline, driftFailures);
  if (!driftFailures.some(failure => failure.includes('roleMatrix proof-or-stop-review-behavior.commands'))) {
    failures.push(
      `role matrix snapshot drift probe: JSON field drift was not rejected; got ${JSON.stringify(driftFailures)}`,
    );
  }
  if (!driftFailures.some(failure => failure.includes('overlap matrix markdown'))) {
    failures.push(
      `role matrix snapshot drift probe: Markdown parity drift was not rejected; got ${JSON.stringify(driftFailures)}`,
    );
  }

  const missingRoleBaseline = structuredClone(current);
  const removedRole = missingRoleBaseline.roleMatrix.shift()?.role;
  if (!removedRole) {
    failures.push('role matrix snapshot drift probe: no role available for removal');
    return;
  }
  const missingRoleFailures = [];
  verifyMatrix(current, missingRoleBaseline, missingRoleFailures);
  if (!missingRoleFailures.some(failure => failure.includes('baseline matrix role count'))) {
    failures.push(
      `role matrix snapshot drift probe: role-count drift was not rejected; got ${JSON.stringify(missingRoleFailures)}`,
    );
  }
  if (!missingRoleFailures.some(failure => failure.includes(`baseline matrix missing role ${removedRole}`))) {
    failures.push(
      `role matrix snapshot drift probe: missing-row drift was not rejected; got ${JSON.stringify(missingRoleFailures)}`,
    );
  }
}
