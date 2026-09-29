


import { createHash } from 'node:crypto';



import ts from 'typescript';
import nodeAssert from 'node:assert/strict';

import { processFactCommandNamePatterns, read, commandPolicyPath, assert, commandPolicyStatuses, legacyTestFixtureCommands, legacyCommandPolicyGuidance, processFactLevelRegistryPath, processFactRegistryPath, requiredReviewLoopL4Commands, requiredReviewLoopReadOnlyCommands, ALL_PHASES, requiredDoneClosureReadOnlyCommands, assertLocalAssuranceNoReleaseBoundary, assertEvidenceFactoryWiring, lifecycleRegistryPath, requiredDecisionDocQuorumReadOnlyCommands } from './support.mjs';
import { processFactRegistryMap, extractCliToolNames, parseCommandPolicyEntries, duplicateNames, readStringProperty } from './registry-parser.mjs';
import { extractConstInitializer, extractObjectPropertyBlock, assertArrayPropertyIncludesValue } from './review-inventory.mjs';
import { materialProgramSourceFile, findFunctionDeclaration, functionBodyHasResolvedCall, hasDiffEnumerationBlockingBranch, builderReturnObjectLiterals, objectLiteralMaterialClassificationInit, initializerDelegatesToTry } from './source-analysis.mjs';

export function isProcessFactCommandName(commandName) {
  if (commandName.endsWith('_dispatch')) return false;
  return processFactCommandNamePatterns.some(pattern => pattern.test(commandName));
}

export function findUninventoriedProcessFactCommands(cliText, inventory = processFactRegistryMap()) {
  return extractCliToolNames(cliText)
    .filter(isProcessFactCommandName)
    .filter(commandName => !inventory.has(commandName));
}

export function assertCommandPolicyInventory(cliToolNames) {
  const text = read(commandPolicyPath);
  for (const helperName of ['getCommandLifecyclePolicy', 'formatCommandLifecycleHint', 'getCommandPolicyEntries']) {
    assert(text.includes(helperName), `${commandPolicyPath}: missing helper ${helperName}`);
  }

  const policyEntries = parseCommandPolicyEntries();
  const policyNames = policyEntries.map(entry => entry.name);
  const policyByName = new Map(policyEntries.map(entry => [entry.name, entry]));
  const cliToolNameSet = new Set(cliToolNames);

  const duplicatePolicyNames = duplicateNames(policyNames);
  assert(
    duplicatePolicyNames.length === 0,
    `${commandPolicyPath}: duplicate policy entries: ${duplicatePolicyNames.join(', ')}`,
  );

  const missingPolicyEntries = cliToolNames.filter(commandName => !policyByName.has(commandName));
  assert(
    missingPolicyEntries.length === 0,
    `${commandPolicyPath}: MAIN_TOOLS command(s) missing lifecycle policy: ${missingPolicyEntries.join(', ')}`,
  );

  const unknownPolicyEntries = policyNames.filter(name => !cliToolNameSet.has(name));
  assert(
    unknownPolicyEntries.length === 0,
    `${commandPolicyPath}: lifecycle policy entry not present in MAIN_TOOLS: ${unknownPolicyEntries.join(', ')}`,
  );

  for (const entry of policyEntries) {
    assert(commandPolicyStatuses.has(entry.status), `${commandPolicyPath}: ${entry.name} has unknown status "${entry.status}"`);
    assert(entry.reason.trim().length > 0, `${commandPolicyPath}: ${entry.name} must explain lifecycle reason`);
    assert(entry.hasAllowedPhases || entry.rootOnly, `${commandPolicyPath}: ${entry.name} must declare allowedPhases or rootOnly`);
    assert(entry.destructiveRisk !== '', `${commandPolicyPath}: ${entry.name} must declare destructiveRisk, even when none`);
  }

  for (const commandName of legacyTestFixtureCommands) {
    const entry = policyByName.get(commandName);
    assert(entry, `${commandPolicyPath}: legacy test/fixture command missing policy: ${commandName}`);
    if (!entry) continue;

    const guidance = legacyCommandPolicyGuidance[commandName];
    assert(entry.status === 'legacy', `${commandPolicyPath}: ${commandName} must be classified as legacy`);
    assert(entry.rootOnly, `${commandPolicyPath}: ${commandName} must stay rootOnly/phase-gated`);
    assert(entry.replacement.trim().length > 0, `${commandPolicyPath}: ${commandName} must include replacement guidance`);
    assert(
      entry.destructiveRisk === guidance.destructiveRisk,
      `${commandPolicyPath}: ${commandName} destructiveRisk drifted: expected ${guidance.destructiveRisk}, got ${entry.destructiveRisk || '<missing>'}`,
    );
    for (const pattern of guidance.patterns) {
      assert(
        pattern.test(entry.block),
        `${commandPolicyPath}: ${commandName} replacement/destructive guidance missing ${pattern}`,
      );
    }
  }
}

export function policyBlockHasOwnershipClass(policy, ownershipClass) {
  return new RegExp(`ownershipClass\\s*:\\s*(['"\`])${ownershipClass}\\1`).test(policy.block)
    || policy.block.includes(`"ownershipClass":"${ownershipClass}"`);
}

export function assertCertificationWindowCommandContract(cliToolNameSet, registry, levelRegistry, policyByName) {
  const commands = ['certification_window_begin', 'certification_window_status', 'certification_window_cancel'];
  for (const commandName of commands) {
    assert(cliToolNameSet.has(commandName), `MAIN_TOOLS missing ${commandName}`);
    const levelEntry = levelRegistry.get(commandName);
    assert(levelEntry, `${processFactLevelRegistryPath}: ${commandName} missing from PROCESS_FACT_LEVELS`);
    assert(levelEntry.level === 'L4', `${processFactLevelRegistryPath}: ${commandName} must stay L4`);
    assert(levelEntry.category === 'certification-window', `${processFactLevelRegistryPath}: ${commandName} category must stay certification-window`);
    assert(levelEntry.owner === 'handlers/certification-window', `${processFactLevelRegistryPath}: ${commandName} owner drifted`);
    assert(
      /done_required_validate \/ validate --full PRE_CERT certification-window gate/.test(levelEntry.gateConsumer || ''),
      `${processFactLevelRegistryPath}: ${commandName} must name the PRE_CERT certification-window gateConsumer`,
    );
    const registryEntry = registry.get(commandName);
    assert(registryEntry, `${processFactRegistryPath}: ${commandName} missing from PROCESS_FACT_REGISTRY`);
    assert(registryEntry.level === 'L4', `${processFactRegistryPath}: ${commandName} registry level must stay L4`);
    assert(registryEntry.artifact?.path === 'certification-window.json', `${processFactRegistryPath}: ${commandName} must write certification-window.json`);
    assert(registryEntry.artifact?.signed === true, `${processFactRegistryPath}: ${commandName} artifact must stay signed`);
    assert(
      registryEntry.semantics.includes('signed-artifact') && registryEntry.semantics.includes('gate-evidence'),
      `${processFactRegistryPath}: ${commandName} must carry signed-artifact + gate-evidence`,
    );
    const policy = policyByName.get(commandName);
    assert(policy, `${commandPolicyPath}: ${commandName} missing COMMAND_POLICIES entry`);
    assert(policy.gateEvidence, `${commandPolicyPath}: ${commandName} must stay gateEvidence`);
    assert(policy.destructiveRisk === 'metadata-write', `${commandPolicyPath}: ${commandName} destructiveRisk must stay metadata-write`);
    if (commandName === 'certification_window_status') {
      assert(policyBlockHasOwnershipClass(policy, 'readOnly'), `${commandPolicyPath}: ${commandName} default must stay readOnly`);
      assert(readStringProperty(policy.block, 'storyWriteEffect') === 'whenRefresh', `${commandPolicyPath}: ${commandName} explicit refresh must stay a declared Story write`);
    } else {
      assert(
        policyBlockHasOwnershipClass(policy, 'storyScopedMutating'),
        `${commandPolicyPath}: ${commandName} must stay storyScopedMutating`,
      );
    }
  }
  const certificationArtifact = registry.get('artifact:certification-window.json');
  for (const term of ['artifact-releases.jsonl', 'capability-releases.jsonl', 'review-subject',
    'Git blobs/tombstones', 'integration/test', 'never gate evidence',
    'Unknown self-host paths', 'reserved control paths', 'ambiguous classifications fail closed',
    'Unclassified external consumer material binds every certification domain']) {
    assert(certificationArtifact?.rationale.includes(term),
      `${processFactRegistryPath}: certification release provenance contract missing ${term}`);
  }
  const domainReader = read('packages/main/src/handlers/certification-window.ts');
  for (const token of ['isProofOrStopSourceRepository(gitCwd, ref)', 'isExternalUnclassifiedMaterialPath(entry.path)',
    'for (const causalDomain of CAUSAL_DEPENDENCY_DOMAINS) byDomain.get(causalDomain)!.push(identity)']) {
    assert(domainReader.includes(token), `external consumer causal domain boundary missing ${token}`);
  }
  assert(read('scripts/verify-review-epoch-certification-continuity.mjs').includes('external-certification-domain.test.mjs'),
    'external consumer certification regression must run in serial certification suite');
  const statusSource = read('packages/main/src/core/certification-window.ts');
  const verifier = read('packages/main/src/handlers/verifier.ts');
  const phaseGate = read('packages/main/src/handlers/phase-gates.ts');
  const doneRequired = read('packages/main/src/handlers/done-required-validation.ts');
  for (const consumer of ['packages/main/src/handlers/phase-gates.ts', 'packages/main/src/handlers/certification-window.ts']) {
    assert(read(consumer).includes("from './validation-pass-admissibility.js'"), `${consumer}: status and TEST must share routine PASS admissibility`);
  }
  assert(registry.get('runtime:precert_routine_single_execution')?.level === 'L4', 'PRE_CERT single execution must be a real registered L4 fact');
  assert(/claimTestAdmissibleRoutineValidationWindow/.test(verifier), 'routine validation requires an execution claim');
  assert(/persistPrecertCheapCheckIfQualified/.test(verifier), 'fast validation must publish its own bound receipt');
  assert(/currentIdentity: currentPrecertFastIdentity\(ctx, storyId\)/.test(read('packages/main/src/handlers/certification-window.ts')), 'PRE_CERT must reconstruct current fast identity before consuming a receipt');
  assert(/requireCurrentHeavyCertificationWindow/.test(doneRequired), 'DONE-required must retain PRE_CERT admission');
  assert(!/refuseHeavyCertificationUnlessAdmitted/.test(doneRequired), 'DONE-required must not consume routine execution allocation');
  assert(!/captureLifecycleMetadataTransaction|commitLifecycleMetadataTransaction|persistRunningCertificationWindow|claimTestAdmissibleRoutineValidationWindow/.test(doneRequired), 'DONE-required must not claim or commit the routine certification allocation');
  const doneCloseouts = [...doneRequired.matchAll(/closeoutArtifactPaths\s*:\s*\[([^\]]*)\]/g)];
  assert(doneCloseouts.length === 1 && /^\s*['"]done-required-evidence\.json['"]\s*$/.test(doneCloseouts[0][1]), 'DONE-required must commit only its own evidence artifact');
  const testGate = phaseGate.slice(phaseGate.indexOf('export async function runValidateGate('), phaseGate.indexOf('export function runDoneOracleGate('));
  assert(/PRE_CERT_ROUTINE_PASS_REQUIRED/.test(testGate) && !/createVerifierHandlers|await.*\.validate\(/.test(testGate), 'TEST must consume signed routine PASS without executing a second suite');
  assert(
    /status must never claim inventory completeness is certification/.test(statusSource),
    'packages/main/src/core/certification-window.ts must refuse status prose that treats inventory completeness as certification',
  );
  assert(
    /inventoryReceiptAuthorizesPrecert/.test(statusSource),
    'packages/main/src/core/certification-window.ts must keep inventoryReceiptAuthorizesPrecert as the inventory-not-PRE_CERT fence',
  );
}

export function assertReviewLoopCommandContract(cliToolNameSet, registry, levelRegistry, policyByName) {
  const artifact = registry.get('artifact:review-loops.jsonl');
  assert(artifact, `${processFactRegistryPath}: review-loop artifact missing: artifact:review-loops.jsonl`);
  if (artifact) {
    assert(artifact.artifact?.path === 'review-loops.jsonl', `${processFactRegistryPath}: review-loop artifact path drift`);
    assert(artifact.level === 'L4', `${processFactRegistryPath}: review-loop artifact must stay L4`);
    assert(artifact.semantics.includes('blocker-state'), `${processFactRegistryPath}: review-loop artifact missing blocker-state semantic`);
    assert(artifact.semantics.includes('gate-evidence'), `${processFactRegistryPath}: review-loop artifact missing gate-evidence semantic`);
    assert(/storyMachine\.canPassReview/.test(artifact.consumerGate), `${processFactRegistryPath}: review-loop artifact consumerGate drifted (${artifact.consumerGate})`);
  }

  for (const commandName of requiredReviewLoopL4Commands) {
    assert(cliToolNameSet.has(commandName), `CLI schema: required review-loop command missing from MAIN_TOOLS: ${commandName}`);

    const policy = policyByName.get(commandName);
    assert(policy, `${commandPolicyPath}: required review-loop command missing lifecycle policy: ${commandName}`);
    if (policy) {
      assert(policy.gateEvidence, `${commandPolicyPath}: ${commandName} must stay gateEvidence`);
      assert(
        policy.allowedPhases.length === 1 && policy.allowedPhases[0] === 'REVIEW',
        `${commandPolicyPath}: ${commandName} must be REVIEW-only`,
      );
      assert(policy.destructiveRisk === 'metadata-write', `${commandPolicyPath}: ${commandName} destructiveRisk must stay metadata-write`);
      assert(
        policyBlockHasOwnershipClass(policy, 'storyScopedMutating'),
        `${commandPolicyPath}: ${commandName} must stay storyScopedMutating`,
      );
    }

    const levelEntry = levelRegistry.get(commandName);
    assert(levelEntry, `${processFactLevelRegistryPath}: required review-loop command missing level entry: ${commandName}`);
    if (levelEntry) {
      assert(levelEntry.level === 'L4', `${processFactLevelRegistryPath}: ${commandName} must stay L4`);
      assert(levelEntry.category === 'review-loop', `${processFactLevelRegistryPath}: ${commandName} category must stay review-loop`);
      assert(levelEntry.owner === 'handlers/review-loop', `${processFactLevelRegistryPath}: ${commandName} owner drifted`);
      assert(/storyMachine\.canPassReview/.test(levelEntry.gateConsumer || ''), `${processFactLevelRegistryPath}: ${commandName} gateConsumer drifted`);
    }

    const registryEntry = registry.get(commandName);
    assert(registryEntry, `${processFactRegistryPath}: required review-loop command missing registry entry: ${commandName}`);
    if (registryEntry) {
      assert(registryEntry.level === 'L4', `${processFactRegistryPath}: ${commandName} registry level must stay L4`);
      assert(registryEntry.gateEvidence === true, `${processFactRegistryPath}: ${commandName} registry gateEvidence must stay true`);
      assert(registryEntry.artifact?.path === 'review-loops.jsonl', `${processFactRegistryPath}: ${commandName} must write review-loops.jsonl`);
      for (const semantic of ['blocker-state', 'schema-contract', 'gate-evidence']) {
        assert(registryEntry.semantics.includes(semantic), `${processFactRegistryPath}: ${commandName} missing ${semantic} semantic`);
      }
      assert(/storyMachine\.canPassReview/.test(registryEntry.consumerGate), `${processFactRegistryPath}: ${commandName} consumerGate drifted (${registryEntry.consumerGate})`);
    }
  }

  for (const commandName of requiredReviewLoopReadOnlyCommands) {
    assert(cliToolNameSet.has(commandName), `CLI schema: required review-loop read command missing from MAIN_TOOLS: ${commandName}`);
    const policy = policyByName.get(commandName);
    assert(policy, `${commandPolicyPath}: required review-loop read command missing lifecycle policy: ${commandName}`);
    if (policy) {
      assert(!policy.gateEvidence, `${commandPolicyPath}: ${commandName} must not be gateEvidence`);
      assert(policy.allowedPhases.length === ALL_PHASES.length, `${commandPolicyPath}: ${commandName} must be allowed in all phases`);
      assert(policy.destructiveRisk === 'none', `${commandPolicyPath}: ${commandName} destructiveRisk must stay none`);
      assert(policyBlockHasOwnershipClass(policy, 'readOnly'), `${commandPolicyPath}: ${commandName} must stay readOnly`);
    }
    const levelEntry = levelRegistry.get(commandName);
    assert(levelEntry, `${processFactLevelRegistryPath}: required review-loop read command missing level entry: ${commandName}`);
    if (levelEntry) {
      assert(levelEntry.level === 'L0', `${processFactLevelRegistryPath}: ${commandName} must stay L0`);
      assert(levelEntry.category === 'review-loop-read', `${processFactLevelRegistryPath}: ${commandName} category must stay review-loop-read`);
    }
  }
}

export function assertDoneClosureCommandContract(cliToolNameSet, registry, levelRegistry, policyByName) {
  for (const commandName of requiredDoneClosureReadOnlyCommands) {
    assert(cliToolNameSet.has(commandName), `CLI schema: required DONE closure read command missing from MAIN_TOOLS: ${commandName}`);
    const policy = policyByName.get(commandName);
    assert(policy, `${commandPolicyPath}: required DONE closure command missing lifecycle policy: ${commandName}`);
    if (policy) {
      assert(!policy.gateEvidence, `${commandPolicyPath}: ${commandName} must not be gateEvidence`);
      assert(policy.allowedPhases.length === ALL_PHASES.length, `${commandPolicyPath}: ${commandName} must be allowed in all phases`);
      assert(policy.destructiveRisk === 'none', `${commandPolicyPath}: ${commandName} destructiveRisk must stay none`);
      assert(policyBlockHasOwnershipClass(policy, 'readOnly'), `${commandPolicyPath}: ${commandName} must stay readOnly`);
      assert(
        /without writing lifecycle artifacts|without mutating/i.test(policy.reason),
        `${commandPolicyPath}: ${commandName} policy must state the read-only/no lifecycle mutation boundary`,
      );
      assertLocalAssuranceNoReleaseBoundary(policy.reason, `${commandPolicyPath}: ${commandName} policy`);
    }

    const levelEntry = levelRegistry.get(commandName);
    assert(levelEntry, `${processFactLevelRegistryPath}: required DONE closure command missing level entry: ${commandName}`);
    if (levelEntry) {
      assert(levelEntry.level === 'L0', `${processFactLevelRegistryPath}: ${commandName} must stay L0`);
      assert(levelEntry.category === 'done-closure-read', `${processFactLevelRegistryPath}: ${commandName} category must stay done-closure-read`);
      assert(levelEntry.owner === 'handlers/done-closure', `${processFactLevelRegistryPath}: ${commandName} owner drifted`);
      assert(!levelEntry.gateConsumer, `${processFactLevelRegistryPath}: ${commandName} must not declare a gateConsumer`);
    }

    const registryEntry = registry.get(commandName);
    assert(registryEntry, `${processFactRegistryPath}: required DONE closure command missing registry entry: ${commandName}`);
    if (registryEntry) {
      assert(registryEntry.level === 'L0', `${processFactRegistryPath}: ${commandName} registry level must stay L0`);
      assert(registryEntry.kind === 'command', `${processFactRegistryPath}: ${commandName} registry kind must stay command`);
      assert(registryEntry.gateEvidence === false, `${processFactRegistryPath}: ${commandName} registry gateEvidence must stay false`);
      assert(!registryEntry.artifact, `${processFactRegistryPath}: ${commandName} must not produce a process artifact`);
      assert(!registryEntry.consumerGate, `${processFactRegistryPath}: ${commandName} must not be consumed by a lifecycle gate`);
      assert(registryEntry.semantics.includes('command'), `${processFactRegistryPath}: ${commandName} must remain a command projection semantic`);
      assert(!registryEntry.semantics.includes('gate-evidence'), `${processFactRegistryPath}: ${commandName} must not gain gate-evidence semantic`);
    }
  }
}

export function assertDoneRequiredValidationCommandContract(cliToolNameSet, registry, levelRegistry, policyByName) {
  const commandName = 'done_required_validate';
  const reuseText = read('packages/main/src/core/done-prepare-validation-reuse.ts');
  for (const token of ['evaluateDoneRequiredEvidence', 'classifyTrustedValidationLineage', 'head-changed-during-reuse-evaluation', 'evidence-malformed-or-unreadable']) {
    assert(reuseText.includes(token), `DONE-required pre-run reuse must preserve canonical/shared-lineage check: ${token}`);
  }
  const routineReuseText = read('packages/main/src/core/validation-evidence-reuse.ts');
  for (const token of ['untrusted-lineage-path', 'effectiveEnvironmentDigest', 'buildValidationExecutableLookup', "env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD'", "command.includes('\\\\')", 'platformPath.isAbsolute(command)', 'identity-missing-malformed-or-legacy', 'current-verification-coverage-incomplete', 'head-changed-during-reuse-evaluation']) {
    assert(routineReuseText.includes(token), `shared routine validation reuse contract missing ${token}`);
  }
  // B-f00c: the merge-lineage git-command logic was extracted into the shared
  // validation-lineage.ts classifier (used by both the reuse and admissibility copies).
  // The net-endpoint diff replaces the per-commit union, so rev-list is no longer used.
  const lineageText = read('packages/main/src/core/validation-lineage.ts');
  // Lab reuse-lineage-material-policy: lineage trust uses the same path policy as
  // materialHash, so a material-excluded commit cannot force identical re-execution.
  assert(!lineageText.includes('isStoryMetadataPath'),
    'shared merge-lineage classifier must not narrow trust back to story metadata only (materialHash ignores more paths)');
  for (const token of ['merge-base', '--is-ancestor', 'diff-tree', 'isMaterialExcludedPath']) {
    assert(lineageText.includes(token), `shared merge-lineage classifier contract missing ${token}`);
  }
  const validationEnvironmentText = read('packages/main/src/core/validation-command-environment.ts');
  const expectedValidationTransportKeys = [
    'AGY_SESSION_ID',
    'ANTIGRAVITY_SESSION_ID',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_SESSION_ID',
    'CODEX_SESSION_ID',
    'CODEX_THREAD_ID',
    'GEMINI_SESSION_ID',
    'LATTICE_ACTIVITY_RECORD_READONLY',
    'LATTICE_ACTIVITY_ROLE',
    'LATTICE_ACTIVITY_SESSION',
    'LATTICE_ACTIVITY_SOURCE',
    'LATTICE_AGENT',
    'LATTICE_CODEX_ENTRYPOINT',
    'LATTICE_OWNER_SESSION_ADAPTER_AGENT',
    'LATTICE_OWNER_SESSION_ADAPTER_BOUNDARY',
    'LATTICE_OWNER_SESSION_ADAPTER_GENERATED',
    'LATTICE_OWNER_SESSION_ADAPTER_PROVIDER',
    'LATTICE_OWNER_SESSION_ADAPTER_ROLE',
    'LATTICE_OWNER_SESSION_ADAPTER_SESSION',
    'LATTICE_OWNER_SESSION_ADAPTER_TASK',
    'LATTICE_SESSION_ID',
    'OLDPWD',
    'OPENAI_SESSION_ID',
    'SHLVL',
    'TERM_SESSION_ID',
    '_',
  ];
  const transportListMatch = validationEnvironmentText.match(
    /export const VALIDATION_TRANSPORT_ENV_KEY_LIST = \[([\s\S]*?)\] as const;/,
  );
  assert(transportListMatch, 'shared validation command environment must export the canonical transport key list');
  const actualValidationTransportKeys = transportListMatch
    ? [...transportListMatch[1].matchAll(/'([A-Z0-9_]+)'/g)].map((match) => match[1])
    : [];
  assert(
    JSON.stringify(actualValidationTransportKeys) === JSON.stringify(expectedValidationTransportKeys),
    `shared validation command environment canonical transport set mismatch: expected ${JSON.stringify(expectedValidationTransportKeys)}, got ${JSON.stringify(actualValidationTransportKeys)}`,
  );
  const expectedTransportDigest = `sha256:${createHash('sha256')
    .update(JSON.stringify(expectedValidationTransportKeys))
    .digest('hex')}`;
  assert(
    validationEnvironmentText.includes(`'${expectedTransportDigest}'`),
    `shared validation command environment transport digest mismatch: ${expectedTransportDigest}`,
  );
  for (const token of [
    // B-cdf6 CHK-006 Pass B: the pinned list stays byte-frozen (its digest is
    // compared against already-persisted receipts), and the new brand spellings
    // are derived only at the active FILTER boundary; retired keys are not read.
    "const FROZEN_RETIRED_ENV_PREFIX = ['LAT', 'TICE_'].join('')",
    '.filter((key) => !key.startsWith(FROZEN_RETIRED_ENV_PREFIX))',
    ".map((key) => `PROOF_OR_STOP_${key.slice(FROZEN_RETIRED_ENV_PREFIX.length)}`)",
    "platform === 'win32'",
    "effective[canonicalKey('PWD')] = cwd",
    'effective[canonicalKey(key)] = value',
  ]) {
    assert(validationEnvironmentText.includes(token), `shared validation command environment contract missing ${token}`);
  }
  const doneRequiredSmokeText = read('packages/main/src/tasks/done-required-validation-smoke.ts');
  for (const token of [
    'const behaviorEnvironmentMutations = [',
    "{ name: 'LANG', environment: { ...deliveryEnvironment, LANG: 'en_GB.UTF-8' } }",
    "{ name: 'LC_ALL', environment: { ...deliveryEnvironment, LC_ALL: 'en_GB.UTF-8' } }",
    "/effective-environment-digest-mismatch\\[0\\]/",
    "/effective-environment-digest-mismatch\\[1\\]/",
    'for (const mutation of behaviorEnvironmentMutations)',
  ]) {
    assert(doneRequiredSmokeText.includes(token), `DONE-required environment mutation contract missing ${token}`);
  }
  const validationExecutorEnvironmentText = read('packages/main/src/core/validation-executor.ts');
  assert(
    routineReuseText.includes('effectiveValidationCommandEnvironment(processEnvironment, command.env, cwd, platform)')
      // The spawn builds the child environment from the PINNED canonical launch
      // directory (the same directory the routine identity normalises against
      // when the caller pins one), through the same normaliser.
      && validationExecutorEnvironmentText.includes('effectiveValidationCommandEnvironment(process.env, command.env, options.launchCwd ?? cwd)'),
    'routine identity and validation command spawn must consume the same effective environment normalizer',
  );
  const budgetText = read('packages/main/src/core/done-required-timeout-budget.ts');
  // B-cdf6 CHK-006 Pass B: the phase-timeout override is now read through the
  // read-both brand resolver, so the pinned token is the resolver call (which
  // accepts BOTH `PROOF_OR_STOP_DONE_PREPARE_PHASE_TIMEOUT_MS` and the legacy
  // `PROOF_OR_STOP_` spelling) rather than one hardcoded variable name.
  for (const token of ['NODE_TIMER_MAX_MS', 'resolveCommandTimeoutMs', 'derived-command-budget', "readBrandEnv('DONE_PREPARE_PHASE_TIMEOUT_MS')"]) {
    assert(budgetText.includes(token), `DONE-required timeout budget contract missing ${token}`);
  }
  const validationExecutorText = read('packages/main/src/core/validation-executor.ts');
  for (const token of ['MAX_NODE_TIMER_DELAY_MS', 'Math.min(MAX_NODE_TIMER_DELAY_MS', 'resolveCommandTimeoutMs', 'deadlineError']) {
    assert(validationExecutorText.includes(token), `validation timer overflow contract missing ${token}`);
  }
  const verifierText = read('packages/main/src/handlers/verifier.ts');
  assert(verifierText.includes('const respond = (result: any)') && verifierText.includes('onValidationOutcome') && verifierText.includes('reportOutcome(code === 0 && coverage.missingRequired === 0)'), 'validation must report typed outcomes before rendering, including coverage-only failure');
  assert(verifierText.includes('deadlineError: args.deadlineError'), 'routine verifier must preserve the named CLI deadline source');
  const cliEngineText = read('packages/main/src/cli-engine.ts');
  for (const token of ['structuredWatchdog', 'watchdogAbort.abort', 'CliWatchdogTimeoutError', 'isStructuredDoneFailure', 'topLevelValidationFailed', 'onValidationOutcome', "process.exitCode = commandSucceeded ? 0 : 1"]) {
    assert(cliEngineText.includes(token), `DONE-required structured CLI watchdog contract missing ${token}`);
  }
  const refreshHandlerWatchdogText = read('packages/main/src/handlers/checklist.ts');
  for (const token of [
    'abortSignal?: AbortSignal',
    "assertVerificationEvidenceWriteActive('verification_evidence_refresh_stale', args)",
    'return writeStaleRefresh',
    'totalCommands: commandOrdinals.size',
    'progress: event => ctx.log?.(formatValidationProgressEvent(event))',
    'abortSignal: controls.abortSignal',
    'deadlineAt: controls.deadlineAt',
    'deadlineError: controls.deadlineError',
  ]) {
    assert(refreshHandlerWatchdogText.includes(token), `stale refresh progress/abort-atomic contract missing ${token}`);
  }
  for (const token of [
    "|| cmd === 'verification_evidence_add'",
    "|| cmd === 'verification_evidence_refresh_stale'",
    "|| cmd === 'verification_evidence_batch_add'",
    "|| cmd === 'verification_run'",
    "(cmd === 'verification_evidence_add'",
    'Object.assign(v.data as Record<string, unknown>, watchdogControl)',
  ]) {
    assert(cliEngineText.includes(token), `evidence writer structured CLI watchdog contract missing ${token}`);
  }
  for (const token of [
    'async verification_evidence_add(args:',
    'async verification_run(args:',
    'abortSignal?: AbortSignal',
    'deadlineAt?: number',
    'assertVerificationEvidenceWriteActive',
    "assertVerificationEvidenceWriteActive('verification_evidence_add', args)",
    "assertVerificationEvidenceWriteActive('verification_run', args)",
  ]) {
    assert(refreshHandlerWatchdogText.includes(token), `single verification evidence progress/abort contract missing ${token}`);
  }
  for (const token of [
    'async verification_evidence_batch_add(args:',
    "assertVerificationEvidenceWriteActive('verification_evidence_batch_add', args)",
    'assertVerificationFreshnessUnchanged(launchFreshness, captureVerificationFreshness(deps.cwd, deps.metadataRoot))',
    'abortSignal?: AbortSignal',
    'deadlineAt?: number',
  ]) {
    assert(refreshHandlerWatchdogText.includes(token), `verification evidence batch progress/abort-atomic contract missing ${token}`);
  }
  assertEvidenceFactoryWiring(refreshHandlerWatchdogText);
  const stampStart = refreshHandlerWatchdogText.indexOf('async function enforceAndStampEvidence(');
  const stampEnd = refreshHandlerWatchdogText.indexOf('function applyVerificationPin', stampStart);
  const stampSource = refreshHandlerWatchdogText.slice(stampStart, stampEnd);
  const postflight = stampSource.indexOf('assertVerificationFreshnessUnchanged(launchFreshness, captureVerificationFreshness(deps.cwd, deps.metadataRoot))');
  const publishExecution = stampSource.indexOf('createVerificationExecutionReceipt({');
  assert(stampStart >= 0 && postflight >= 0 && publishExecution > postflight
    && stampSource.includes('assertVerificationInputUnchanged(beforeIdentity, afterIdentity)'),
    'V5 execution receipt must be signed only after command input and current material postflight checks');
  assert(read('packages/main/src/tasks/validate-progress-heartbeat-smoke.ts').includes('failed batch must not publish reusable new-material CAS from old raw output'),
    'V5 snapshot protection requires the real failed-batch follow-up execution regression');

  const refreshValidationExecutorText = read('packages/main/src/core/validation-executor.ts');
  for (const token of [
    'SingleCommandExecutionOptions extends RunValidationCommandOptions',
    'options.abortSignal?.aborted',
    'options.deadlineAt',
    'resolveEvidenceCommandTimeoutMs',
    'loadConfig(projectRoot).validate?.evidenceCommandTimeoutOverrides',
    'Number.isSafeInteger(row.timeoutMs)',
    'identities.has(key)',
    'row.args.every((arg, index) => arg === identity.args[index])',
  ]) {
    assert(refreshValidationExecutorText.includes(token), `single pinned verifier abort/progress contract missing ${token}`);
  }
  const configTypeText = read('packages/main/src/core/config.ts');
  assert(configTypeText.includes('evidenceCommandTimeoutOverrides?: EvidenceCommandTimeoutOverrideConfig[]'),
    'config contract must expose the evidence-only exact-command timeout override surface');
  const repoLatticeConfig = JSON.parse(read('proof-or-stop.config.json'));
  const aggregateIdentity = ['packages/main/dist/tasks/managed-cross-provider-suite-smoke.js'];
  const routineAggregate = (repoLatticeConfig.validate?.commands ?? []).some((entry) => (
    typeof entry === 'object'
    && entry !== null
    && entry.command === 'node'
    && JSON.stringify(entry.args ?? []) === JSON.stringify(aggregateIdentity)
  ));
  assert(!routineAggregate, 'managed cross-provider aggregate must not be added to routine validate.commands');
  const evidenceAggregateOverrides = (repoLatticeConfig.validate?.evidenceCommandTimeoutOverrides ?? []).filter((entry) => (
    entry?.command === 'node'
    && JSON.stringify(entry.args ?? []) === JSON.stringify(aggregateIdentity)
    && entry.timeoutMs === 900_000
  ));
  assert(evidenceAggregateOverrides.length === 1,
    'managed cross-provider aggregate must have one exact evidence-only 900000ms timeout override');
  const reviewPassDiscardIdentity = ['packages/main/dist/tasks/review-pass-discard-smoke.js'];
  const routineReviewPassDiscard = (repoLatticeConfig.validate?.commands ?? []).filter((entry) => (
    typeof entry === 'object'
    && entry !== null
    && entry.command === 'node'
    && JSON.stringify(entry.args ?? []) === JSON.stringify(reviewPassDiscardIdentity)
    && entry.timeoutMs === 1_200_000
  ));
  assert(routineReviewPassDiscard.length === 1,
    'review-pass-discard nested cross-host aggregate must retain one exact routine 1200000ms timeout');
  const proofAdmissibilityIdentity = ['packages/main/dist/tasks/proof-admissibility-registry-smoke.js'];
  const routineProofAdmissibility = (repoLatticeConfig.validate?.commands ?? []).filter((entry) => (
    typeof entry === 'object'
    && entry !== null
    && entry.command === 'node'
    && JSON.stringify(entry.args ?? []) === JSON.stringify(proofAdmissibilityIdentity)
    && entry.timeoutMs === 600_000
  ));
  assert(routineProofAdmissibility.length === 1,
    'proof-admissibility registry smoke must retain one exact routine 600000ms timeout');
  const evidenceProofAdmissibilityOverrides = (repoLatticeConfig.validate?.evidenceCommandTimeoutOverrides ?? []).filter((entry) => (
    entry?.command === 'node'
    && JSON.stringify(entry.args ?? []) === JSON.stringify(proofAdmissibilityIdentity)
  ));
  assert(evidenceProofAdmissibilityOverrides.length === 0,
    'proof-admissibility registry smoke remains a routine validate command, not an evidence-only timeout override');
  const commandPolicyText = read('packages/main/src/core/command-policy.ts');
  assert(
    !/verification_evidence_refresh_stale:\s*\{[^}]*runtimeContinuation\s*:\s*true/s.test(commandPolicyText),
    'verification_evidence_refresh_stale must use cooperative progress/abort and must never become runtimeContinuation',
  );
  assert(
    !/verification_evidence_batch_add:\s*\{[^}]*runtimeContinuation\s*:\s*true/s.test(commandPolicyText),
    'verification_evidence_batch_add must use cooperative progress/abort and must never become runtimeContinuation',
  );
  const refreshWatchdogSmokeText = read('packages/main/src/tasks/validate-progress-heartbeat-smoke.ts');
  for (const token of [
    'REFRESH_STALE_WATCHDOG_ONLY',
    'assertRefreshHeartbeatAndDedupe',
    'assertRefreshWatchdogReapsWithoutPartialWrites',
    'assertBatchHeartbeatAndExactCommandDedupe',
    'assertBatchSharedExecutionStillFailsAtomicOnSelector',
    'assertBatchWatchdogReapsWithoutPartialWrites',
  ]) {
    assert(refreshWatchdogSmokeText.includes(token), `evidence writer watchdog/orphan smoke contract missing ${token}`);
  }
  const donePrepareText = read('packages/main/src/handlers/done-prepare.ts');
  for (const token of ['cliWatchdogTimeoutBlock', 'throwIfParentTimedOut', 'deadlineAt', 'Await the cooperative task after aborting it']) {
    assert(donePrepareText.includes(token), `done_prepare cooperative watchdog/cleanup contract missing ${token}`);
  }
  assert(cliToolNameSet.has(commandName), `CLI schema: required DONE-required validation command missing from MAIN_TOOLS: ${commandName}`);

  const policy = policyByName.get(commandName);
  assert(policy, `${commandPolicyPath}: required DONE-required validation command missing lifecycle policy`);
  if (policy) {
    assert(policy.gateEvidence, `${commandPolicyPath}: ${commandName} must remain gateEvidence`);
    assert(policy.allowedPhases.length === ALL_PHASES.length, `${commandPolicyPath}: ${commandName} must be allowed in all phases`);
    assert(policy.destructiveRisk === 'metadata-write', `${commandPolicyPath}: ${commandName} destructiveRisk must stay metadata-write`);
    assert(policyBlockHasOwnershipClass(policy, 'storyScopedMutating'), `${commandPolicyPath}: ${commandName} must stay storyScopedMutating`);
    assert(/done-required-evidence\.json/.test(policy.reason), `${commandPolicyPath}: ${commandName} policy must name done-required-evidence.json`);
    assert(/Missing policy is advisory\/non-blocking|advisory\/non-blocking/i.test(policy.reason), `${commandPolicyPath}: ${commandName} policy must keep missing config advisory/non-blocking`);
    assert(/malformed opted-in policy.*fail/i.test(policy.reason), `${commandPolicyPath}: ${commandName} policy must keep malformed opted-in config fail-closed`);
    assertLocalAssuranceNoReleaseBoundary(policy.reason, `${commandPolicyPath}: ${commandName} policy`);
  }

  const levelEntry = levelRegistry.get(commandName);
  assert(levelEntry, `${processFactLevelRegistryPath}: required DONE-required validation command missing level entry`);
  if (levelEntry) {
    assert(levelEntry.level === 'L4', `${processFactLevelRegistryPath}: ${commandName} must stay L4`);
    assert(levelEntry.category === 'validation', `${processFactLevelRegistryPath}: ${commandName} category must stay validation`);
    assert(levelEntry.owner === 'handlers/done-required-validation', `${processFactLevelRegistryPath}: ${commandName} owner drifted`);
    assert(/DONE.*done-required-validation/.test(levelEntry.gateConsumer || ''), `${processFactLevelRegistryPath}: ${commandName} gate consumer must name DONE done-required-validation`);
  }

  const registryEntry = registry.get(commandName);
  assert(registryEntry, `${processFactRegistryPath}: required DONE-required validation command missing registry entry`);
  if (registryEntry) {
    for (const semantic of ['schema-contract', 'execution-evidence', 'validation-result', 'gate-evidence']) {
      assert(registryEntry.semantics.includes(semantic), `${processFactRegistryPath}: ${commandName} missing semantic ${semantic}`);
    }
    assert(registryEntry.artifact?.path === 'done-required-evidence.json', `${processFactRegistryPath}: ${commandName} must produce done-required-evidence.json`);
    assert(registryEntry.artifact?.signed === false, `${processFactRegistryPath}: ${commandName} artifact must remain unsigned local evidence`);
  }

  const artifactEntry = registry.get('artifact:done-required-evidence.json');
  assert(artifactEntry, `${processFactRegistryPath}: artifact:done-required-evidence.json registry entry missing`);
  if (artifactEntry) {
    assert(artifactEntry.level === 'L4', `${processFactRegistryPath}: done-required artifact must stay L4`);
    for (const semantic of ['artifact', 'validation-result', 'execution-evidence', 'schema-contract', 'gate-evidence']) {
      assert(artifactEntry.semantics.includes(semantic), `${processFactRegistryPath}: done-required artifact missing semantic ${semantic}`);
    }
  }

  const doneRequiredArtifact = 'done-required-evidence.json';
  const lifecycleRegistryText = read(lifecycleRegistryPath);
  const lifecycleArtifactsInitializer = extractConstInitializer(lifecycleRegistryText, 'LIFECYCLE_ARTIFACTS', lifecycleRegistryPath);
  assert(
    new RegExp(`['"]${doneRequiredArtifact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`).test(lifecycleArtifactsInitializer),
    `${lifecycleRegistryPath}: LIFECYCLE_ARTIFACTS must include '${doneRequiredArtifact}'`,
  );
  const generatedMetadataText = read('packages/main/src/core/done-prepare-generated-metadata.ts');
  for (const token of ['commitImmutableMetadataTree', "'commit-tree'", "'update-ref'", 'beforeCasUpdate', "'post-commit'"]) {
    assert(generatedMetadataText.includes(token), `shared immutable metadata commit contract missing ${token}`);
  }
  const autoCommitText = read('packages/main/src/core/auto-commit-metadata.ts');
  assert(
    autoCommitText.includes('commitValidationReuseMetadataTransaction')
      && autoCommitText.includes('commitImmutableMetadataTree'),
    'canonical validation reuse must consume the shared immutable metadata commit primitive',
  );

  const phaseArtifactsInitializer = extractConstInitializer(lifecycleRegistryText, 'LIFECYCLE_PHASE_ARTIFACTS', lifecycleRegistryPath);
  const testPhaseArtifacts = extractObjectPropertyBlock(phaseArtifactsInitializer, 'TEST', `${lifecycleRegistryPath} LIFECYCLE_PHASE_ARTIFACTS`);
  assertArrayPropertyIncludesValue(testPhaseArtifacts, 'produces', doneRequiredArtifact, `${lifecycleRegistryPath}: TEST phase`);
  const donePhaseArtifacts = extractObjectPropertyBlock(phaseArtifactsInitializer, 'DONE', `${lifecycleRegistryPath} LIFECYCLE_PHASE_ARTIFACTS`);
  assertArrayPropertyIncludesValue(donePhaseArtifacts, 'consumes', doneRequiredArtifact, `${lifecycleRegistryPath}: DONE phase`);

  const oracleArtifactRefsInitializer = extractConstInitializer(lifecycleRegistryText, 'LIFECYCLE_ORACLE_ARTIFACT_REFS', lifecycleRegistryPath);
  assert(
    /['"]done-required-validation['"]\s*:\s*['"]done-required-evidence\.json['"]/.test(oracleArtifactRefsInitializer),
    `${lifecycleRegistryPath}: LIFECYCLE_ORACLE_ARTIFACT_REFS must map 'done-required-validation' to '${doneRequiredArtifact}'`,
  );

  const coreText = read('packages/main/src/core/done-required-validation.ts');
  for (const token of ['doneRequiredCommands', 'validationProfiles', 'policyHash', 'commandSetHash', 'missing-build-proof', 'requiresBuildProof', 'providesBuildProof', 'materialHash', 'storyFilesHash', 'validateRequiredReceiptCoverage', 'receipt-count-mismatch', 'receipt-command-mismatch', 'receipt-status-fail']) {
    assert(coreText.includes(token), `packages/main/src/core/done-required-validation.ts: required token missing: ${token}`);
  }
  const oracleText = read('packages/main/src/core/done-oracle.ts');
  assert(oracleText.includes("id: 'done-required-validation'"), 'packages/main/src/core/done-oracle.ts: DONE checklist must contain separate done-required-validation row');
  assert(oracleText.includes('evaluateDoneRequiredEvidence'), 'packages/main/src/core/done-oracle.ts: DONE checklist must consume done-required evaluator');
}

export function assertAcceptanceTopologyLifecycleFilenameContract() {
  // B-5e4a CHK-002: the four acceptance-topology StoryStore artifact filenames
  // must stay registered in the classifier's closed set. Runtime classification
  // + the StoryStore write-set coverage invariant live in
  // packages/main/src/tasks/lifecycle-registry-contract.ts; this is the
  // doc-canonical source-level projection of the same fact.
  const lifecycleRegistryText = read(lifecycleRegistryPath);
  const artifactFilenamesInitializer = extractConstInitializer(
    lifecycleRegistryText,
    'PROOF_OR_STOP_LIFECYCLE_ARTIFACT_FILENAMES',
    lifecycleRegistryPath,
  );
  for (const fileName of [
    'acceptance-basis.json',
    'pre-review-check.json',
    'topology-critic-receipt.json',
    'topology-exclusion-approvals.json',
  ]) {
    assert(
      new RegExp(`['"]${fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`).test(artifactFilenamesInitializer),
      `${lifecycleRegistryPath}: PROOF_OR_STOP_LIFECYCLE_ARTIFACT_FILENAMES must include '${fileName}' (acceptance-topology StoryStore artifact; B-5e4a)`,
    );
  }
}

export function assertDecisionDocQuorumCommandContract(cliToolNameSet, registry, levelRegistry, policyByName) {
  for (const commandName of requiredDecisionDocQuorumReadOnlyCommands) {
    assert(cliToolNameSet.has(commandName), `CLI schema: required decision-doc quorum read command missing from MAIN_TOOLS: ${commandName}`);
    const policy = policyByName.get(commandName);
    assert(policy, `${commandPolicyPath}: required decision-doc quorum command missing lifecycle policy: ${commandName}`);
    if (policy) {
      assert(!policy.gateEvidence, `${commandPolicyPath}: ${commandName} must not be gateEvidence`);
      assert(policy.allowedPhases.length === ALL_PHASES.length, `${commandPolicyPath}: ${commandName} must be allowed in all phases`);
      assert(policy.destructiveRisk === 'none', `${commandPolicyPath}: ${commandName} destructiveRisk must stay none`);
      assert(policyBlockHasOwnershipClass(policy, 'readOnly'), `${commandPolicyPath}: ${commandName} must stay readOnly`);
      assert(/without mutating|read-only/i.test(policy.reason), `${commandPolicyPath}: ${commandName} policy must state the read-only boundary`);
      assert(/classification-only|do not by themselves require DONE quorum|review_escalation_status/i.test(policy.reason), `${commandPolicyPath}: ${commandName} policy must state decision-doc edits are diagnostic/classification only`);
      assertLocalAssuranceNoReleaseBoundary(policy.reason, `${commandPolicyPath}: ${commandName} policy`);
    }

    const levelEntry = levelRegistry.get(commandName);
    assert(levelEntry, `${processFactLevelRegistryPath}: required decision-doc quorum command missing level entry: ${commandName}`);
    if (levelEntry) {
      assert(levelEntry.level === 'L0', `${processFactLevelRegistryPath}: ${commandName} must stay L0`);
      assert(levelEntry.category === 'decision-doc-quorum-read', `${processFactLevelRegistryPath}: ${commandName} category must stay decision-doc-quorum-read`);
      assert(levelEntry.owner === 'handlers/decision-doc-quorum', `${processFactLevelRegistryPath}: ${commandName} owner drifted`);
      assert(!levelEntry.gateConsumer, `${processFactLevelRegistryPath}: ${commandName} must not declare a gateConsumer`);
    }

    const registryEntry = registry.get(commandName);
    assert(registryEntry, `${processFactRegistryPath}: required decision-doc quorum command missing registry entry: ${commandName}`);
    if (registryEntry) {
      assert(registryEntry.level === 'L0', `${processFactRegistryPath}: ${commandName} registry level must stay L0`);
      assert(registryEntry.kind === 'command', `${processFactRegistryPath}: ${commandName} registry kind must stay command`);
      assert(registryEntry.gateEvidence === false, `${processFactRegistryPath}: ${commandName} registry gateEvidence must stay false`);
      assert(!registryEntry.artifact, `${processFactRegistryPath}: ${commandName} must not produce a process artifact`);
      assert(!registryEntry.consumerGate, `${processFactRegistryPath}: ${commandName} must not be consumed by a lifecycle gate`);
      assert(registryEntry.semantics.includes('command'), `${processFactRegistryPath}: ${commandName} must remain a command projection semantic`);
      assert(!registryEntry.semantics.includes('gate-evidence'), `${processFactRegistryPath}: ${commandName} must not gain gate-evidence semantic`);
    }
  }

  const statusCommand = 'review_escalation_status';
  assert(cliToolNameSet.has(statusCommand), `CLI schema: required review escalation read command missing from MAIN_TOOLS: ${statusCommand}`);
  const statusPolicy = policyByName.get(statusCommand);
  assert(statusPolicy, `${commandPolicyPath}: required review escalation status command missing lifecycle policy`);
  if (statusPolicy) {
    assert(!statusPolicy.gateEvidence, `${commandPolicyPath}: ${statusCommand} must not be gateEvidence`);
    assert(statusPolicy.allowedPhases.length === ALL_PHASES.length, `${commandPolicyPath}: ${statusCommand} must be allowed in all phases`);
    assert(statusPolicy.destructiveRisk === 'none', `${commandPolicyPath}: ${statusCommand} destructiveRisk must stay none`);
    assert(policyBlockHasOwnershipClass(statusPolicy, 'readOnly'), `${commandPolicyPath}: ${statusCommand} must stay readOnly`);
    assert(/first-round verified reviewer findings|explicitlyConfiguredHighRiskPolicyRequires3x2|3x2|degraded 3x1/i.test(statusPolicy.reason), `${commandPolicyPath}: ${statusCommand} must describe the trigger/quorum policy`);
    assertLocalAssuranceNoReleaseBoundary(statusPolicy.reason, `${commandPolicyPath}: ${statusCommand} policy`);
  }
  const statusLevel = levelRegistry.get(statusCommand);
  assert(statusLevel, `${processFactLevelRegistryPath}: ${statusCommand} missing level entry`);
  if (statusLevel) {
    assert(statusLevel.level === 'L0', `${processFactLevelRegistryPath}: ${statusCommand} must stay L0`);
    assert(statusLevel.category === 'review-escalation-read', `${processFactLevelRegistryPath}: ${statusCommand} category drifted`);
    assert(statusLevel.owner === 'handlers/review-escalation', `${processFactLevelRegistryPath}: ${statusCommand} owner drifted`);
    assert(!statusLevel.gateConsumer, `${processFactLevelRegistryPath}: ${statusCommand} must not declare a gateConsumer`);
  }
  const statusRegistry = registry.get(statusCommand);
  assert(statusRegistry, `${processFactRegistryPath}: ${statusCommand} missing registry entry`);
  if (statusRegistry) {
    assert(statusRegistry.level === 'L0', `${processFactRegistryPath}: ${statusCommand} registry level must stay L0`);
    assert(statusRegistry.kind === 'command', `${processFactRegistryPath}: ${statusCommand} registry kind must stay command`);
    assert(statusRegistry.gateEvidence === false, `${processFactRegistryPath}: ${statusCommand} registry gateEvidence must stay false`);
    assert(!statusRegistry.artifact, `${processFactRegistryPath}: ${statusCommand} must not produce a process artifact`);
  }

  const policyCommand = 'review_escalation_policy_set';
  assert(cliToolNameSet.has(policyCommand), `CLI schema: required review escalation policy command missing from MAIN_TOOLS: ${policyCommand}`);
  const policyCommandPolicy = policyByName.get(policyCommand);
  assert(policyCommandPolicy, `${commandPolicyPath}: required review escalation policy command missing lifecycle policy`);
  if (policyCommandPolicy) {
    assert(policyCommandPolicy.gateEvidence, `${commandPolicyPath}: ${policyCommand} must be gateEvidence`);
    assert(policyCommandPolicy.destructiveRisk === 'metadata-write', `${commandPolicyPath}: ${policyCommand} destructiveRisk must stay metadata-write`);
    assert(policyBlockHasOwnershipClass(policyCommandPolicy, 'storyScopedMutating'), `${commandPolicyPath}: ${policyCommand} must stay storyScopedMutating`);
    for (const token of ['explicitlyConfiguredHighRiskPolicyRequires3x2', 'policyVersion', 'sourcePolicyRef', 'rolloutStage', 'head/material', 'degraded fallback']) {
      assert(new RegExp(token, 'i').test(policyCommandPolicy.reason), `${commandPolicyPath}: ${policyCommand} policy must name ${token}`);
    }
    assertLocalAssuranceNoReleaseBoundary(policyCommandPolicy.reason, `${commandPolicyPath}: ${policyCommand} policy`);
  }
  const policyLevel = levelRegistry.get(policyCommand);
  assert(policyLevel, `${processFactLevelRegistryPath}: ${policyCommand} missing level entry`);
  if (policyLevel) {
    assert(policyLevel.level === 'L4', `${processFactLevelRegistryPath}: ${policyCommand} must stay L4`);
    assert(policyLevel.category === 'review-escalation-policy', `${processFactLevelRegistryPath}: ${policyCommand} category drifted`);
    assert(policyLevel.owner === 'handlers/review-escalation', `${processFactLevelRegistryPath}: ${policyCommand} owner drifted`);
    assert(/review escalation/i.test(policyLevel.gateConsumer || ''), `${processFactLevelRegistryPath}: ${policyCommand} gateConsumer drifted`);
    assert(/explicitlyConfiguredHighRiskPolicyRequires3x2/i.test(policyLevel.rationale), `${processFactLevelRegistryPath}: ${policyCommand} rationale must bind explicitlyConfiguredHighRiskPolicyRequires3x2`);
  }
  const policyRegistry = registry.get(policyCommand);
  assert(policyRegistry, `${processFactRegistryPath}: ${policyCommand} missing registry entry`);
  if (policyRegistry) {
    assert(policyRegistry.level === 'L4', `${processFactRegistryPath}: ${policyCommand} registry level must stay L4`);
    assert(policyRegistry.gateEvidence === true, `${processFactRegistryPath}: ${policyCommand} registry gateEvidence must stay true`);
    assert(policyRegistry.artifact?.path === 'process-events.jsonl', `${processFactRegistryPath}: ${policyCommand} must record process-events.jsonl evidence`);
    assert(/review escalation/i.test(policyRegistry.consumerGate), `${processFactRegistryPath}: ${policyCommand} consumerGate drifted`);
  }

  const probeCommand = 'review_host_availability_probe';
  assert(cliToolNameSet.has(probeCommand), `CLI schema: required review host availability probe command missing from MAIN_TOOLS: ${probeCommand}`);
  const probePolicy = policyByName.get(probeCommand);
  assert(probePolicy, `${commandPolicyPath}: required review host availability probe command missing lifecycle policy`);
  if (probePolicy) {
    assert(probePolicy.gateEvidence, `${commandPolicyPath}: ${probeCommand} must be gateEvidence`);
    assert(probePolicy.destructiveRisk === 'metadata-write', `${commandPolicyPath}: ${probeCommand} destructiveRisk must stay metadata-write`);
    assert(policyBlockHasOwnershipClass(probePolicy, 'storyScopedMutating'), `${commandPolicyPath}: ${probeCommand} must stay storyScopedMutating`);
    for (const token of ['codex', 'claude', 'agy', '--version', 'executionReady', 'reviewReady', 'progressMode', 'failureKind', 'reviewReadyHostCount', 'material hash', 'storyFilesHash', 'review escalation DONE gate', 'review assurance floor DONE gate']) {
      assert(new RegExp(token, 'i').test(probePolicy.reason), `${commandPolicyPath}: ${probeCommand} policy must name ${token}`);
    }
    assertLocalAssuranceNoReleaseBoundary(probePolicy.reason, `${commandPolicyPath}: ${probeCommand} policy`);
  }
  const probeLevel = levelRegistry.get(probeCommand);
  assert(probeLevel, `${processFactLevelRegistryPath}: ${probeCommand} missing level entry`);
  if (probeLevel) {
    assert(probeLevel.level === 'L4', `${processFactLevelRegistryPath}: ${probeCommand} must stay L4`);
    assert(probeLevel.category === 'review-host-availability-probe', `${processFactLevelRegistryPath}: ${probeCommand} category drifted`);
    assert(probeLevel.owner === 'handlers/review-escalation', `${processFactLevelRegistryPath}: ${probeCommand} owner drifted`);
    assert(/review_host_availability_probe/i.test(probeLevel.rationale), `${processFactLevelRegistryPath}: ${probeCommand} rationale must name review_host_availability_probe`);
    assert(/reviewReadyHostCount below 2 canonical hosts/i.test(probeLevel.rationale), `${processFactLevelRegistryPath}: ${probeCommand} rationale must name the degraded fallback review-readiness threshold`);
    assert(/review escalation/i.test(probeLevel.gateConsumer || ''), `${processFactLevelRegistryPath}: ${probeCommand} gateConsumer must name review escalation`);
    assert(/review assurance floor/i.test(probeLevel.gateConsumer || ''), `${processFactLevelRegistryPath}: ${probeCommand} gateConsumer must name review assurance floor`);
  }
  const probeRegistry = registry.get(probeCommand);
  assert(probeRegistry, `${processFactRegistryPath}: ${probeCommand} missing registry entry`);
  if (probeRegistry) {
    assert(probeRegistry.level === 'L4', `${processFactRegistryPath}: ${probeCommand} registry level must stay L4`);
    assert(probeRegistry.kind === 'host-availability-probe', `${processFactRegistryPath}: ${probeCommand} registry kind must stay host-availability-probe`);
    assert(probeRegistry.gateEvidence === true, `${processFactRegistryPath}: ${probeCommand} registry gateEvidence must stay true`);
    assert(probeRegistry.semantics.includes('host-availability'), `${processFactRegistryPath}: ${probeCommand} registry missing host-availability semantic`);
    assert(probeRegistry.semantics.includes('host-readiness'), `${processFactRegistryPath}: ${probeCommand} registry missing host-readiness semantic`);
    assert(probeRegistry.artifact?.path === 'process-events.jsonl', `${processFactRegistryPath}: ${probeCommand} must record process-events.jsonl evidence`);
    assert(/review escalation/i.test(probeRegistry.consumerGate), `${processFactRegistryPath}: ${probeCommand} consumerGate must name review escalation`);
    assert(/review assurance floor/i.test(probeRegistry.consumerGate), `${processFactRegistryPath}: ${probeCommand} consumerGate must name review assurance floor`);
  }

  const fallbackCommand = 'review_escalation_fallback_set';
  assert(cliToolNameSet.has(fallbackCommand), `CLI schema: required review escalation fallback command missing from MAIN_TOOLS: ${fallbackCommand}`);
  const fallbackPolicy = policyByName.get(fallbackCommand);
  assert(fallbackPolicy, `${commandPolicyPath}: required review escalation fallback command missing lifecycle policy`);
  if (fallbackPolicy) {
    assert(fallbackPolicy.gateEvidence, `${commandPolicyPath}: ${fallbackCommand} must be gateEvidence`);
    assert(fallbackPolicy.destructiveRisk === 'metadata-write', `${commandPolicyPath}: ${fallbackCommand} destructiveRisk must stay metadata-write`);
    assert(policyBlockHasOwnershipClass(fallbackPolicy, 'storyScopedMutating'), `${commandPolicyPath}: ${fallbackCommand} must stay storyScopedMutating`);
    assert(/degraded 3x1|degraded-single-host|current material hash/i.test(fallbackPolicy.reason), `${commandPolicyPath}: ${fallbackCommand} must describe degraded-single-host material binding`);
    assert(/storyFilesHash/i.test(fallbackPolicy.reason), `${commandPolicyPath}: ${fallbackCommand} must describe storyFilesHash binding`);
    assert(/review_host_availability_probe|reviewReadyHostCount below 2 canonical hosts/i.test(fallbackPolicy.reason), `${commandPolicyPath}: ${fallbackCommand} policy must describe fresh host readiness probe binding for non-human fallback`);
    assert(/review escalation DONE gate/i.test(fallbackPolicy.reason), `${commandPolicyPath}: ${fallbackCommand} policy must name the local review escalation DONE gate`);
    assert(/review assurance floor DONE gate/i.test(fallbackPolicy.reason), `${commandPolicyPath}: ${fallbackCommand} policy must name the review assurance floor DONE gate`);
    assertLocalAssuranceNoReleaseBoundary(fallbackPolicy.reason, `${commandPolicyPath}: ${fallbackCommand} policy`);
  }
  const fallbackLevel = levelRegistry.get(fallbackCommand);
  assert(fallbackLevel, `${processFactLevelRegistryPath}: ${fallbackCommand} missing level entry`);
  if (fallbackLevel) {
    assert(fallbackLevel.level === 'L4', `${processFactLevelRegistryPath}: ${fallbackCommand} must stay L4`);
    assert(fallbackLevel.category === 'review-escalation-fallback', `${processFactLevelRegistryPath}: ${fallbackCommand} category drifted`);
    assert(fallbackLevel.owner === 'handlers/review-escalation', `${processFactLevelRegistryPath}: ${fallbackCommand} owner drifted`);
    assert(/storyFilesHash/i.test(fallbackLevel.rationale), `${processFactLevelRegistryPath}: ${fallbackCommand} rationale must name storyFilesHash`);
    assert(/review_host_availability_probe/i.test(fallbackLevel.rationale), `${processFactLevelRegistryPath}: ${fallbackCommand} rationale must name review_host_availability_probe`);
    assert(/review escalation/i.test(fallbackLevel.gateConsumer || ''), `${processFactLevelRegistryPath}: ${fallbackCommand} gateConsumer drifted`);
    assert(/review assurance floor/i.test(fallbackLevel.gateConsumer || ''), `${processFactLevelRegistryPath}: ${fallbackCommand} gateConsumer must name review assurance floor`);
  }
  const fallbackRegistry = registry.get(fallbackCommand);
  assert(fallbackRegistry, `${processFactRegistryPath}: ${fallbackCommand} missing registry entry`);
  if (fallbackRegistry) {
    assert(fallbackRegistry.level === 'L4', `${processFactRegistryPath}: ${fallbackCommand} registry level must stay L4`);
    assert(fallbackRegistry.gateEvidence === true, `${processFactRegistryPath}: ${fallbackCommand} registry gateEvidence must stay true`);
    assert(fallbackRegistry.semantics.includes('host-availability'), `${processFactRegistryPath}: ${fallbackCommand} registry missing host-availability semantic`);
    assert(fallbackRegistry.semantics.includes('host-readiness'), `${processFactRegistryPath}: ${fallbackCommand} registry missing host-readiness semantic`);
    assert(fallbackRegistry.artifact?.path === 'process-events.jsonl', `${processFactRegistryPath}: ${fallbackCommand} must record process-events.jsonl evidence`);
    assert(/review escalation/i.test(fallbackRegistry.consumerGate), `${processFactRegistryPath}: ${fallbackCommand} consumerGate drifted`);
    assert(/review assurance floor/i.test(fallbackRegistry.consumerGate), `${processFactRegistryPath}: ${fallbackCommand} consumerGate must name review assurance floor`);
  }

  const commandName = 'autopilot_review_submit';
  const policy = policyByName.get(commandName);
  assert(policy, `${commandPolicyPath}: required local host verdict command missing lifecycle policy: ${commandName}`);
  if (policy) {
    assert(policy.gateEvidence, `${commandPolicyPath}: ${commandName} must stay gateEvidence for local review escalation and review assurance floor`);
    assert(policy.allowedPhases.length === ALL_PHASES.length, `${commandPolicyPath}: ${commandName} must be allowed in all phases`);
    assert(policy.destructiveRisk === 'metadata-write', `${commandPolicyPath}: ${commandName} destructiveRisk must stay metadata-write`);
    assert(policyBlockHasOwnershipClass(policy, 'reviewerWrite'), `${commandPolicyPath}: ${commandName} must stay reviewerWrite so independent hosts can submit verdicts without story owner lease`);
    assert(/storyFilesHash/i.test(policy.reason), `${commandPolicyPath}: ${commandName} policy must name storyFilesHash binding`);
    assert(/review escalation DONE gate/i.test(policy.reason), `${commandPolicyPath}: ${commandName} policy must name the local review escalation DONE gate`);
    assert(/review assurance floor DONE gate/i.test(policy.reason), `${commandPolicyPath}: ${commandName} policy must name the review assurance floor DONE gate`);
    assertLocalAssuranceNoReleaseBoundary(policy.reason, `${commandPolicyPath}: ${commandName} policy`);
  }

  const levelEntry = levelRegistry.get(commandName);
  assert(levelEntry, `${processFactLevelRegistryPath}: required local host verdict command missing level entry: ${commandName}`);
  if (levelEntry) {
    assert(levelEntry.level === 'L4', `${processFactLevelRegistryPath}: ${commandName} must stay L4`);
    assert(levelEntry.category === 'proof-or-stop-local-host-verdict', `${processFactLevelRegistryPath}: ${commandName} category must stay proof-or-stop-local-host-verdict`);
    assert(levelEntry.owner === 'handlers/verdict', `${processFactLevelRegistryPath}: ${commandName} owner drifted`);
    assert(/storyFilesHash/i.test(levelEntry.rationale), `${processFactLevelRegistryPath}: ${commandName} rationale must name storyFilesHash`);
    for (const token of ['deriveBindings', 'validation execution lock', 'canonical PASS-admissibility', 'trusted story-metadata-descendant', 'keyId', 'validationDigest', 'promptDigest', 'fails closed', 'exactly one', 'legacy']) {
      assert(new RegExp(token, 'i').test(levelEntry.rationale), `${processFactLevelRegistryPath}: ${commandName} rationale must name ${token}`);
    }
    assert(/review escalation/i.test(levelEntry.gateConsumer || ''), `${processFactLevelRegistryPath}: ${commandName} gateConsumer drifted`);
    assert(/review assurance floor/i.test(levelEntry.gateConsumer || ''), `${processFactLevelRegistryPath}: ${commandName} gateConsumer must name review assurance floor`);
  }

  const registryEntry = registry.get(commandName);
  assert(registryEntry, `${processFactRegistryPath}: required local host verdict command missing registry entry: ${commandName}`);
  if (registryEntry) {
    assert(registryEntry.level === 'L4', `${processFactRegistryPath}: ${commandName} registry level must stay L4`);
    assert(registryEntry.kind === 'host-verdict', `${processFactRegistryPath}: ${commandName} registry kind must stay host-verdict`);
    assert(registryEntry.gateEvidence === true, `${processFactRegistryPath}: ${commandName} registry gateEvidence must stay true`);
    assert(registryEntry.artifact?.path === 'process-events.jsonl', `${processFactRegistryPath}: ${commandName} must record process-events.jsonl evidence`);
    for (const semantic of ['host-verdict', 'execution-evidence', 'freshness-policy', 'schema-contract', 'gate-evidence']) {
      assert(registryEntry.semantics.includes(semantic), `${processFactRegistryPath}: ${commandName} missing ${semantic} semantic`);
    }
    assert(/review escalation/i.test(registryEntry.consumerGate), `${processFactRegistryPath}: ${commandName} consumerGate drifted (${registryEntry.consumerGate})`);
    assert(/review assurance floor/i.test(registryEntry.consumerGate), `${processFactRegistryPath}: ${commandName} consumerGate must name review assurance floor (${registryEntry.consumerGate})`);
  }

  const quorumCommand = 'quorum_submit';
  const quorumPolicy = policyByName.get(quorumCommand);
  assert(quorumPolicy, `${commandPolicyPath}: required local quorum command missing lifecycle policy: ${quorumCommand}`);
  if (quorumPolicy) {
    assert(quorumPolicy.gateEvidence, `${commandPolicyPath}: ${quorumCommand} must stay gateEvidence for local review escalation and review assurance floor`);
    assert(quorumPolicy.allowedPhases.length === ALL_PHASES.length, `${commandPolicyPath}: ${quorumCommand} must be allowed in all phases`);
    assert(quorumPolicy.destructiveRisk === 'metadata-write', `${commandPolicyPath}: ${quorumCommand} destructiveRisk must stay metadata-write`);
    assert(policyBlockHasOwnershipClass(quorumPolicy, 'reviewerWrite'), `${commandPolicyPath}: ${quorumCommand} must stay reviewerWrite so independent hosts can submit verdicts without story owner lease`);
    assert(/storyFilesHash/i.test(quorumPolicy.reason), `${commandPolicyPath}: ${quorumCommand} policy must name storyFilesHash binding`);
    assert(/review_pass_set|reviewer pass/i.test(quorumPolicy.reason), `${commandPolicyPath}: ${quorumCommand} policy must name the reviewer-pass precondition`);
    assert(/autopilot_review_submit/i.test(quorumPolicy.reason), `${commandPolicyPath}: ${quorumCommand} policy must state it reuses the autopilot_review_submit local path`);
    assert(/review escalation DONE gate/i.test(quorumPolicy.reason), `${commandPolicyPath}: ${quorumCommand} policy must name the local review escalation DONE gate`);
    assert(/review assurance floor DONE gate/i.test(quorumPolicy.reason), `${commandPolicyPath}: ${quorumCommand} policy must name the review assurance floor DONE gate`);
    assertLocalAssuranceNoReleaseBoundary(quorumPolicy.reason, `${commandPolicyPath}: ${quorumCommand} policy`);
  }

  const quorumLevelEntry = levelRegistry.get(quorumCommand);
  assert(quorumLevelEntry, `${processFactLevelRegistryPath}: required local quorum command missing level entry: ${quorumCommand}`);
  if (quorumLevelEntry) {
    assert(quorumLevelEntry.level === 'L4', `${processFactLevelRegistryPath}: ${quorumCommand} must stay L4`);
    assert(quorumLevelEntry.category === 'proof-or-stop-local-host-verdict', `${processFactLevelRegistryPath}: ${quorumCommand} category must stay proof-or-stop-local-host-verdict`);
    assert(quorumLevelEntry.owner === 'handlers/quorum-submit', `${processFactLevelRegistryPath}: ${quorumCommand} owner drifted`);
    assert(/storyFilesHash/i.test(quorumLevelEntry.rationale), `${processFactLevelRegistryPath}: ${quorumCommand} rationale must name storyFilesHash`);
    assert(/review_pass_set|reviewer pass/i.test(quorumLevelEntry.rationale), `${processFactLevelRegistryPath}: ${quorumCommand} rationale must name the reviewer-pass precondition`);
    assert(/review escalation/i.test(quorumLevelEntry.gateConsumer || ''), `${processFactLevelRegistryPath}: ${quorumCommand} gateConsumer drifted`);
    assert(/review assurance floor/i.test(quorumLevelEntry.gateConsumer || ''), `${processFactLevelRegistryPath}: ${quorumCommand} gateConsumer must name review assurance floor`);
  }

  const quorumRegistryEntry = registry.get(quorumCommand);
  assert(quorumRegistryEntry, `${processFactRegistryPath}: required local quorum command missing registry entry: ${quorumCommand}`);
  if (quorumRegistryEntry) {
    assert(quorumRegistryEntry.level === 'L4', `${processFactRegistryPath}: ${quorumCommand} registry level must stay L4`);
    assert(quorumRegistryEntry.kind === 'host-verdict', `${processFactRegistryPath}: ${quorumCommand} registry kind must stay host-verdict`);
    assert(quorumRegistryEntry.gateEvidence === true, `${processFactRegistryPath}: ${quorumCommand} registry gateEvidence must stay true`);
    assert(quorumRegistryEntry.artifact?.path === 'process-events.jsonl', `${processFactRegistryPath}: ${quorumCommand} must record process-events.jsonl evidence`);
    for (const semantic of ['host-verdict', 'execution-evidence', 'atomic-persistence', 'gate-evidence']) {
      assert(quorumRegistryEntry.semantics.includes(semantic), `${processFactRegistryPath}: ${quorumCommand} missing ${semantic} semantic`);
    }
    for (const token of ['one immutable metadata commit', 'pre-dirty refusal', 'HEAD CAS', 'all-row rollback']) {
      assert(new RegExp(token, 'i').test(quorumLevelEntry?.rationale || ''), `${processFactLevelRegistryPath}: ${quorumCommand} rationale must name ${token}`);
    }
    assert(/review escalation/i.test(quorumRegistryEntry.consumerGate), `${processFactRegistryPath}: ${quorumCommand} consumerGate drifted (${quorumRegistryEntry.consumerGate})`);
    assert(/review assurance floor/i.test(quorumRegistryEntry.consumerGate), `${processFactRegistryPath}: ${quorumCommand} consumerGate must name review assurance floor (${quorumRegistryEntry.consumerGate})`);
  }
  const cliEngineText = read('packages/main/src/cli-engine.ts');
  assert(
    cliEngineText.includes("if (entry.command === 'quorum_submit') return;"),
    'packages/main/src/cli-engine.ts: quorum_submit must retain sole ownership of its atomic process-events terminal instead of receiving a generic post-handler codex_cli append',
  );

  const runtimeName = 'runtime:review_escalation_done_gate';
  const runtimeLevel = levelRegistry.get(runtimeName);
  assert(runtimeLevel, `${processFactLevelRegistryPath}: required review escalation runtime fact missing`);
  if (runtimeLevel) {
    assert(runtimeLevel.level === 'L4', `${processFactLevelRegistryPath}: ${runtimeName} must stay L4`);
    assert(runtimeLevel.owner === 'core/review-escalation', `${processFactLevelRegistryPath}: ${runtimeName} owner drifted`);
    assert(runtimeLevel.gateConsumer === 'storyMachine.canFinish DONE review escalation gate', `${processFactLevelRegistryPath}: ${runtimeName} gateConsumer drifted`);
    for (const token of ['first REVIEW round', 'explicitlyConfiguredHighRiskPolicyRequires3x2', '3x2', 'degraded 3x1', 'current material hash']) {
      assert(new RegExp(token, 'i').test(runtimeLevel.rationale), `${processFactLevelRegistryPath}: ${runtimeName} rationale must name ${token}`);
    }
  }
  const runtimeRegistry = registry.get(runtimeName);
  assert(runtimeRegistry, `${processFactRegistryPath}: required process fact missing from PROCESS_FACT_REGISTRY: ${runtimeName}`);
  if (runtimeRegistry) {
    assert(runtimeRegistry.kind === 'runtime-behavior', `${processFactRegistryPath}: ${runtimeName} kind must stay runtime-behavior`);
    assert(runtimeRegistry.level === 'L4', `${processFactRegistryPath}: ${runtimeName} must stay L4`);
    assert(runtimeRegistry.semantics.includes('runtime-behavior'), `${processFactRegistryPath}: ${runtimeName} missing runtime-behavior semantic`);
    assert(runtimeRegistry.semantics.includes('host-verdict'), `${processFactRegistryPath}: ${runtimeName} missing host-verdict semantic`);
    assert(runtimeRegistry.semantics.includes('host-availability'), `${processFactRegistryPath}: ${runtimeName} missing host-availability semantic`);
    assert(runtimeRegistry.semantics.includes('gate-evidence'), `${processFactRegistryPath}: ${runtimeName} missing gate-evidence semantic`);
    assert(runtimeRegistry.consumerGate === 'storyMachine.canFinish DONE review escalation gate', `${processFactRegistryPath}: ${runtimeName} consumerGate drifted`);
  }
  const evaluatorText = read('packages/main/src/core/review-escalation.ts');
  for (const token of [
    'REVIEW_ESCALATION_EXPLICIT_HIGH_RISK_POLICY_PREDICATE',
    'explicitlyConfiguredHighRiskPolicyRequires3x2',
    'review_escalation_policy',
    'degradedFallbackAllowed',
    'review_host_availability_probe',
    'hostAvailabilityProbeId',
    'assuranceLevel',
    'admissibilityStatus',
    'evidenceScope: local-review-escalation',
  ]) {
    assert(evaluatorText.includes(token), `packages/main/src/core/review-escalation.ts: required explicit high-risk policy token missing: ${token}`);
  }
  const smokeText = read('packages/main/src/tasks/review-escalation-smoke.ts');
  for (const token of [
    'valid explicit high-risk policy fact requires 3x2 without first-round problems',
    'high-risk prose or paths do not trigger without explicit policy fact',
    'explicit high-risk policy can disallow degraded single-host fallback',
    'missing host readiness probe blocks non-human degraded fallback',
    'probe with reviewReadyHostCount below two permits degraded 3x1',
    'probe with two executable canonical hosts blocks single-host fallback',
    'explicit-human-approval remains lower assurance degraded fallback',
  ]) {
    assert(smokeText.includes(token), `packages/main/src/tasks/review-escalation-smoke.ts: required explicit high-risk policy smoke missing: ${token}`);
  }
}

export function assertReviewAssuranceFloorContract(registry, levelRegistry) {
  const runtimeName = 'runtime:review_assurance_floor_done_gate';
  const levelEntry = levelRegistry.get(runtimeName);
  assert(levelEntry, `${processFactLevelRegistryPath}: required review assurance floor runtime fact missing`);
  if (levelEntry) {
    assert(levelEntry.level === 'L4', `${processFactLevelRegistryPath}: ${runtimeName} must stay L4`);
    assert(levelEntry.owner === 'core/review-assurance-floor', `${processFactLevelRegistryPath}: ${runtimeName} owner drifted`);
    assert(levelEntry.gateConsumer === 'storyMachine.canFinish DONE review assurance floor gate', `${processFactLevelRegistryPath}: ${runtimeName} gateConsumer drifted`);
    // B-956f FIX 2: the L4 rationale must ALSO name the language-neutral
    // material-code policy semantics the floor now delegates to — policy
    // resolution, hash-bound snapshot freshness, the diff-enumeration hard-block,
    // and the shared repro/ProofStory consumers.
    for (const token of [
      'material code diffs', '3x1', '3x2', 'high-risk', 'local evidence', 'release readiness',
      'language-neutral', 'material-code policy', 'snapshot freshness', 'diff enumeration', 'repro-evidence-binding',
    ]) {
      assert(new RegExp(token, 'i').test(levelEntry.rationale), `${processFactLevelRegistryPath}: ${runtimeName} rationale must name ${token}`);
    }
  }

  const registryEntry = registry.get(runtimeName);
  assert(registryEntry, `${processFactRegistryPath}: required process fact missing from PROCESS_FACT_REGISTRY: ${runtimeName}`);
  if (registryEntry) {
    assert(registryEntry.kind === 'runtime-behavior', `${processFactRegistryPath}: ${runtimeName} kind must stay runtime-behavior`);
    assert(registryEntry.level === 'L4', `${processFactRegistryPath}: ${runtimeName} must stay L4`);
    assert(registryEntry.semantics.includes('runtime-behavior'), `${processFactRegistryPath}: ${runtimeName} missing runtime-behavior semantic`);
    assert(registryEntry.semantics.includes('host-verdict'), `${processFactRegistryPath}: ${runtimeName} missing host-verdict semantic`);
    assert(registryEntry.semantics.includes('host-availability'), `${processFactRegistryPath}: ${runtimeName} missing host-availability semantic`);
    assert(registryEntry.semantics.includes('gate-evidence'), `${processFactRegistryPath}: ${runtimeName} missing gate-evidence semantic`);
    assert(registryEntry.consumerGate === 'storyMachine.canFinish DONE review assurance floor gate', `${processFactRegistryPath}: ${runtimeName} consumerGate drifted`);
  }

  const evaluatorText = read('packages/main/src/core/review-assurance-floor.ts');
  for (const token of [
    'evaluateReviewAssuranceFloor',
    'formatReviewAssuranceFloorFailure',
    'REVIEW_ASSURANCE_FLOOR_FAILURE_REQUIRED_ROUNDS = 3',
    'REVIEW_ASSURANCE_FLOOR_HIGH_RISK_HOSTS_PER_ROUND = 2',
    'three-round-two-hosts-or-degraded-single-host',
    'assuranceLevel',
    'evaluateHostVerdictRounds',
    'review_escalation_fallback',
    'reviewEscalationFallbackRecordFromEvent',
  ]) {
    assert(evaluatorText.includes(token), `packages/main/src/core/review-assurance-floor.ts: required review assurance floor token missing: ${token}`);
  }

  // B-956f FIX 2 (R5 — codex defeated the includes()/name-match AST assertions with
  // dead-branch calls, same-named LOCAL shadows, and whole-file ProofStory scans):
  // assert via a real ts.Program + TypeChecker that each delegation is a LIVE,
  // non-nested call whose callee SYMBOL resolves to material-code-policy (not a name
  // match), with the snapshot builds also DATA-FLOW-checked (result consumed). The
  // ProofStory assertions are scoped to the builder FUNCTION BODY (not the file) and
  // follow one hop through the local helper the property delegates to.
  const MCP = 'material-code-policy';
  const floorSf = materialProgramSourceFile('packages/main/src/core/review-assurance-floor.ts');
  const floorFn = findFunctionDeclaration(floorSf, 'evaluateReviewAssuranceFloor');
  assert(floorFn && floorFn.body, 'packages/main/src/core/review-assurance-floor.ts: evaluateReviewAssuranceFloor function declaration must exist');
  assert(
    functionBodyHasResolvedCall(floorFn, 'buildMaterialClassificationSnapshot', MCP, { requireConsumed: true }),
    'packages/main/src/core/review-assurance-floor.ts: evaluateReviewAssuranceFloor MUST make a LIVE call to buildMaterialClassificationSnapshot resolving to material-code-policy whose result is consumed (not a dead-branch / discarded / same-named-local call)',
  );
  assert(
    functionBodyHasResolvedCall(floorFn, 'ensureFreshMaterialClassificationSnapshot', MCP),
    'packages/main/src/core/review-assurance-floor.ts: evaluateReviewAssuranceFloor MUST call ensureFreshMaterialClassificationSnapshot from material-code-policy (hash-bound snapshot freshness validation of a supplied classification)',
  );
  assert(
    hasDiffEnumerationBlockingBranch(floorFn.body),
    'packages/main/src/core/review-assurance-floor.ts: evaluateReviewAssuranceFloor MUST have a diffEnumerationError blocking branch that returns an ok:false outcome (an unenumerable diff hard-blocks, never a silent empty change set)',
  );
  // The exported per-path classifier itself must delegate to the pure 8-step chain.
  const classifyFn = findFunctionDeclaration(floorSf, 'classifyReviewAssuranceFloorPath');
  assert(classifyFn && classifyFn.body, 'packages/main/src/core/review-assurance-floor.ts: classifyReviewAssuranceFloorPath function declaration must exist');
  assert(
    functionBodyHasResolvedCall(classifyFn, 'classifyMaterialCodePath', MCP, { requireConsumed: true }),
    'packages/main/src/core/review-assurance-floor.ts: classifyReviewAssuranceFloorPath MUST make a LIVE call to classifyMaterialCodePath from material-code-policy whose result is consumed (delegate to the config-resolved policy, no TS-only whitelist)',
  );

  // The repro-evidence-binding gate consumer: evaluateStoryEvidenceBindingGate must
  // build the snapshot and feed it into the snapshot-required repro classify.
  const reproSf = materialProgramSourceFile('packages/main/src/core/repro-evidence-binding-gate.ts');
  const reproFn = findFunctionDeclaration(reproSf, 'evaluateStoryEvidenceBindingGate');
  assert(reproFn && reproFn.body, 'packages/main/src/core/repro-evidence-binding-gate.ts: evaluateStoryEvidenceBindingGate function declaration must exist');
  assert(
    functionBodyHasResolvedCall(reproFn, 'buildMaterialClassificationSnapshot', MCP, { requireConsumed: true }),
    'packages/main/src/core/repro-evidence-binding-gate.ts: evaluateStoryEvidenceBindingGate MUST make a LIVE call to buildMaterialClassificationSnapshot resolving to material-code-policy whose result is consumed (shared classifier delegation, not a dead-branch / same-named-local call)',
  );
  assert(
    functionBodyHasResolvedCall(reproFn, 'classifyReproFirstRequirement', 'repro-evidence-binding-gate', { requireConsumed: true }),
    'packages/main/src/core/repro-evidence-binding-gate.ts: evaluateStoryEvidenceBindingGate MUST feed the snapshot into a LIVE classifyReproFirstRequirement call (snapshot-required repro classification)',
  );

  // The ProofStory diagnostic-input builders must POPULATE materialClassification in
  // the builder BODY with a real delegation to tryBuildMaterialClassificationSnapshotForDiagnostics
  // (resolved to material-code-policy) — either directly or via one local helper. A
  // `materialClassification: null` in the builder while the token lingers elsewhere
  // in the file (codex defeat c) now exits 1.
  for (const [relPath, builderFn] of [
    ['packages/main/src/handlers/phase-gates.ts', 'proofStoryDiagnosticInput'],
    ['packages/main/src/handlers/proofstory.ts', 'diagnosticInput'],
  ]) {
    const sf = materialProgramSourceFile(relPath);
    const fn = findFunctionDeclaration(sf, builderFn);
    assert(fn && fn.body, `${relPath}: ${builderFn} function declaration must exist`);
    const TRY = 'tryBuildMaterialClassificationSnapshotForDiagnostics';
    // B-956f FIX 3 (defeat b): EVERY reachable return object — not just the first
    // materialClassification occurrence anywhere in the body — must carry the property
    // bound to the try-build delegation. A live return with `materialClassification:
    // null`/undefined now exits 1 even when a decoy delegation sits in a runtime-dead
    // (non-literal) branch.
    const returnObjects = builderReturnObjectLiterals(fn);
    assert(
      returnObjects.length > 0,
      `${relPath}: ${builderFn} MUST return a diagnostic-input object literal`,
    );
    for (const objLit of returnObjects) {
      const init = objectLiteralMaterialClassificationInit(objLit);
      const initIsCall = !!init && ts.isCallExpression(init);
      assert(
        initIsCall,
        `${relPath}: ${builderFn} MUST populate the materialClassification property in EVERY reachable return with a function call (a real delegation, not a null/constant/omitted field)`,
      );
      // Only resolve the delegation when the initializer is actually a call — the
      // verifier's assert() records failures and CONTINUES, so guard against running
      // callee resolution on a null/constant initializer (defeat b/c: `: null`).
      if (initIsCall) {
        assert(
          initializerDelegatesToTry(init),
          `${relPath}: ${builderFn} materialClassification MUST delegate (directly or via one local helper) to ${TRY} from material-code-policy in EVERY reachable return (real production population, not a whole-file token)`,
        );
      }
    }
  }

  const doneOracleText = read('packages/main/src/core/done-oracle.ts');
  assert(doneOracleText.includes("id: 'review-assurance-floor'"), 'packages/main/src/core/done-oracle.ts: DONE checklist must contain separate review-assurance-floor row');
  assert(doneOracleText.includes('evaluateReviewAssuranceFloor'), 'packages/main/src/core/done-oracle.ts: DONE checklist must consume review assurance floor evaluator');

  const machineText = read('packages/main/src/core/machine.ts');
  assert(machineText.includes('evaluateReviewAssuranceFloor'), 'packages/main/src/core/machine.ts: canFinish guard must consume review assurance floor evaluator');
  assert(machineText.includes('formatReviewAssuranceFloorFailure'), 'packages/main/src/core/machine.ts: DONE guard failure reason must render review assurance floor diagnostics');

  const smokeText = read('packages/main/src/tasks/review-assurance-floor-smoke.ts');
  for (const token of [
    'zero-review material code is blocked',
    'one fresh local review round passes clean material code',
    'docs-only markdown is not overblocked',
    'failure signals require sticky 3x1 local rounds',
    'high-risk lifecycle gate work requires 3x2 or explicit degraded fallback',
    'missing host readiness probe blocks non-human high-risk degraded fallback',
    'probe with reviewReadyHostCount below two permits high-risk degraded 3x1',
    'probe with two executable canonical hosts blocks high-risk single-host fallback',
    'explicit-human-approval remains lower assurance without host probe',
    'wrapper-root machine DONE guard uses resolved gitCwd',
    'assuranceLevel',
  ]) {
    assert(smokeText.includes(token), `packages/main/src/tasks/review-assurance-floor-smoke.ts: required smoke assertion text missing: ${token}`);
  }
}
