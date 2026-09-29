






import ts from 'typescript';
import nodeAssert from 'node:assert/strict';

import { assert, fail, processFactLevelRegistryPath, read, processFactRegistryPath } from './support.mjs';
import { processFactRegistryMap, parseProcessFactArtifactByCommandFromSource } from './registry-parser.mjs';
import { findFunctionDeclaration } from './source-analysis.mjs';

export function extractExportedArrayBody(text, exportName) {
  const match = new RegExp(`\\bexport\\s+const\\s+${exportName}\\b(?:\\s*:\\s*[^=]+)?\\s*=\\s*(?:\\(\\s*)?\\[`).exec(text);
  assert(Boolean(match), `source should export ${exportName}`);
  if (!match) return '';

  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;
  const arrayStart = match.index + match[0].lastIndexOf('[');

  for (let index = arrayStart; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (char === '\\') escaped = true;
      else if (char === quote) inString = false;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      inString = true;
      quote = char;
      continue;
    }
    if (char === '[') {
      depth += 1;
      continue;
    }
    if (char === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(arrayStart + 1, index);
    }
  }

  fail(`${processFactLevelRegistryPath} ${exportName} array should close`);
  return '';
}

export function extractBalancedBlock(text, openIndex, openChar, closeChar, label) {
  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;

  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (char === '\\') escaped = true;
      else if (char === quote) inString = false;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      inString = true;
      quote = char;
      continue;
    }
    if (char === openChar) {
      depth += 1;
      continue;
    }
    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex + 1, index);
    }
  }

  fail(`${label} block should close`);
  return '';
}

export function findBalancedCloseIndex(text, openIndex, openChar, closeChar) {
  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;

  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (char === '\\') escaped = true;
      else if (char === quote) inString = false;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      inString = true;
      quote = char;
      continue;
    }
    if (char === openChar) depth += 1;
    else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

export function extractNamedFunctionBody(text, functionName) {
  const declaration = new RegExp(`\\bfunction\\s+${functionName}\\s*\\(`).exec(text);
  if (!declaration) return null;
  const paramsStart = text.indexOf('(', declaration.index);
  const paramsEnd = findBalancedCloseIndex(text, paramsStart, '(', ')');
  if (paramsEnd < 0) return null;
  const bodyStart = text.indexOf('{', paramsEnd);
  if (bodyStart < 0) return null;
  const bodyEnd = findBalancedCloseIndex(text, bodyStart, '{', '}');
  if (bodyEnd < 0) return null;
  return text.slice(bodyStart + 1, bodyEnd);
}

export function validationPersistenceTransactionIssues(verifierText) {
  const issues = [];
  const writerCallCount = [...verifierText.matchAll(/\bcommitValidationReuseMetadataTransaction\s*\(/g)].length;
  if (writerCallCount !== 2) {
    issues.push(`verifier must contain exactly two canonical validation transaction writer calls; found ${writerCallCount}`);
  }

  const localContracts = [
    {
      functionName: 'reusedStoryValidationResult',
      evidenceWriter: 'args.ctx.store.writePreparedTestEvidence',
    },
    {
      functionName: 'persistStoryValidationEvidence',
      evidenceWriter: 'ctx.store.writePreparedTestEvidence',
    },
  ];
  for (const contract of localContracts) {
    const body = extractNamedFunctionBody(verifierText, contract.functionName);
    if (!body) {
      issues.push(`verifier must declare ${contract.functionName}`);
      continue;
    }
    for (const token of [
      contract.evidenceWriter,
      'recordValidationTerminal',
      'commitValidationReuseMetadataTransaction',
      "reason: 'validate'",
      'transaction',
      "closeoutArtifactPaths: ['test-evidence.json']",
    ]) {
      if (!body.includes(token)) {
        issues.push(`${contract.functionName} must locally bind canonical validation persistence token "${token}"`);
      }
    }
  }
  return issues;
}

export function assertValidationPersistenceTransactionContract() {
  const verifierPath = 'packages/main/src/handlers/verifier.ts';
  const verifierText = read(verifierPath);
  for (const issue of validationPersistenceTransactionIssues(verifierText)) {
    fail(`${verifierPath}: ${issue}`);
  }

  const executedBody = extractNamedFunctionBody(verifierText, 'persistStoryValidationEvidence');
  assert(Boolean(executedBody), 'validation persistence contract self-test requires the executed-validation function');
  if (!executedBody) return;
  const mutatedExecutedBody = executedBody.replace(
    'commitValidationReuseMetadataTransaction',
    'removedValidationTransactionWriter',
  );
  assert(
    mutatedExecutedBody !== executedBody,
    'validation persistence contract self-test must remove the executed-validation writer',
  );
  const mutatedVerifier = verifierText.replace(executedBody, mutatedExecutedBody);
  const mutationIssues = validationPersistenceTransactionIssues(mutatedVerifier);
  assert(
    mutationIssues.some(issue => issue.includes('persistStoryValidationEvidence'))
      && mutationIssues.some(issue => issue.includes('exactly two')),
    'validation persistence contract bite must fail when executed persistence is deleted while reuse persistence remains',
  );
}

export function assertReviewInventoryRemediationContract() {
  const transitionPath = 'packages/main/src/handlers/transition-orchestrator.ts';
  const transitionText = read(transitionPath);
  assert(
    /captureEvidenceHashSnapshot[\s\S]*materialDirtyFiles\.length\s*>\s*0[\s\S]*REVIEW_INVENTORY_REMEDIATION_BLOCKED/.test(transitionText),
    `${transitionPath}: REVIEW to DEV must reject dirty story material before consuming the finalized inventory receipt`,
  );
  assert(
    /captureEvidenceHashSnapshot\(\{[\s\S]*?trustedControllerProjectionStoryId:\s*args\.storyId[\s\S]*?\}\);[\s\S]*?REVIEW_INVENTORY_REMEDIATION_BLOCKED/.test(transitionText),
    `${transitionPath}: REVIEW remediation snapshot must admit only byte-identical signed controller projections for the current Story`,
  );

  const criticHandlerPath = 'packages/main/src/handlers/review-inventory.ts';
  const criticHandlerText = read(criticHandlerPath);
  assert(
    /export function readManagedInventoryCriticMaterialDirtyFiles\([\s\S]*?readMaterialDirtyFiles\(gitCwd, metadataRoot, \{[\s\S]*?trustedControllerProjectionStoryId:\s*storyId[\s\S]*?\}\)/.test(criticHandlerText)
      && /const dirty = readManagedInventoryCriticMaterialDirtyFiles\([\s\S]*?run\.workspaceBinding\?\.signedWorkspaceRoot \?\? ctx\.root[\s\S]*?ctx\.root[\s\S]*?storyId[\s\S]*?\);/.test(criticHandlerText),
    `${criticHandlerPath}: managed inventory critic material admission must use the current Story's signed byte-identical controller projections`,
  );

  const epochPath = 'packages/main/src/core/review-inventory-epoch.ts';
  const epochText = read(epochPath);
  assert(
    /const runPasses = passes\.filter\([\s\S]*?verifyReviewPass\(run\.storyId, pass\)[\s\S]*?Boolean\(pass\.readManifest\)[\s\S]*?Boolean\(pass\.readLog\)/.test(epochText),
    `${epochPath}: inventory PASS coverage requires both signed read fields`,
  );
  assert(
    /const inventoryCriticRuns = candidates\.filter\([\s\S]*?canonicalAgentRoleId\(run\.lane\)[\s\S]*?run\.reviewPurpose === 'inventory-completeness'[\s\S]*?inventoryPurposeMatchesEpoch\(run\.inventoryBinding, args\.epoch\)[\s\S]*?for \(const run of inventoryCriticRuns\)[\s\S]*?evidenceForRun\(run, args\.passes, args\.findings, args\.promptStore\)\.findings[\s\S]*?rawFindings\.set\(finding\.id, finding\)/.test(epochText),
    `${epochPath}: exact inventory aggregate must include signed current purpose-bound critic discoveries without lane promotion`,
  );
  assert(
    /\['verified_family',\s*'duplicate',\s*'not_verified'\]\.includes\(row\.disposition\)/.test(epochText),
    `${epochPath}: critic finding dispositions must be runtime-enumerated and reject unknown values`,
  );

  const dispatchPath = 'packages/main/src/handlers/story-dispatch.ts';
  const dispatchText = read(dispatchPath);
  assert(
    /promptBuilder\s*===\s*'topology-critic-review'[\s\S]*targetKind:\s*'topology-critic-review'[\s\S]*reviewRound/.test(dispatchText),
    `${dispatchPath}: topology critic dispatch must persist its dedicated target kind and current review-round binding`,
  );

  assert(
    dispatchText.includes("args.reviewPurpose === 'inventory-completeness'")
      && dispatchText.includes('requireInventoryCriticSubjectLocked(ctx, args.storyId, args.inventoryEpochId!)')
      && dispatchText.includes('withReviewInventoryMutationLock(store, args.storyId')
      && dispatchText.includes('const authorityBinding = topologyAuthorityDispatchBinding(story, true)')
      && dispatchText.includes("reviewPurpose: 'inventory-completeness', inventoryBinding, reviewerResponsibility"),
    `${dispatchPath}: inventory-only critic dispatch requires signed current OPEN context and leaves topology provenance strict`,
  );
  assert(
    read('packages/main/src/core/process-fact-registry.ts').includes('inventory receipts never substitute for topology proof'),
    'process-fact registry must distinguish inventory completeness and topology proof authority',
  );
  for (const rolePath of [
    'packages/main/templates/agents/proof-or-stop-review-topology-critic.md',
    '.proof-or-stop-codex/agents/proof-or-stop-review-topology-critic.md',
    '.claude/agents/proof-or-stop-review-topology-critic.md',
  ]) {
    const role = read(rolePath);
    assert(role.includes('Inventory completeness only') && role.includes('review_inventory_critic_set')
      && role.includes('Return after completing the inventory responsibility.')
      && role.includes('topology_critic_receipt_set'),
    `${rolePath}: critic instructions must follow the dispatched responsibility and preserve topology rules`);
  }

  const reviewRunPath = 'packages/main/src/core/review-run.ts';
  const reviewRunText = read(reviewRunPath);
  assert(
    /canonicalLane\s*===\s*'proof-or-stop-review-topology-critic'\s*\?\s*'topology-critic-review'\s*:\s*'story-review'/.test(reviewRunText),
    `${reviewRunPath}: ReviewRun verification must consume the topology critic dispatch target kind`,
  );

  const roleContracts = read('packages/main/src/core/prompt-role-contract-registry.ts');
  const reviewRunHandler = read('packages/main/src/handlers/review-run.ts');
  assert(
    roleContracts.includes('const INVENTORY_CRITIC_CONTRACT')
      && roleContracts.includes('return deepFreezeRoleContract(contract)')
      && roleContracts.includes("requiredOutputIds: ['review-finding-or-pass', 'review-inventory-critic-receipt']")
      && roleContracts.includes('promptRoleContractForSemanticDigest')
      && roleContracts.includes('unregistered Role Contract semantics')
      && dispatchText.includes("assembleComplexStoryDispatch(currentStory, canonicalType, dispatchPrompt, 'inventory-completeness')")
      && dispatchText.includes('promptRoleContract(agentType, responsibility)')
      && reviewRunHandler.includes('currentOpenReviewInventory(store, args.storyId)')
      && reviewRunHandler.includes('inventory.reviewRound !== story.currentReviewRound')
      && reviewRunHandler.includes("promptRoleContract(lane, inventoryResponsibility ? 'inventory-completeness' : undefined)")
      && reviewRunText.includes('promptRoleContractForSemanticDigest(canonicalLane, envelope.roleSemanticDigest)'),
    'full-envelope inventory semantics must be registered, selected by both signed OPEN producers, and reconstructed by authenticated digest after finalization',
  );

  const contractsText = read('packages/main/src/core/prompt-contracts.ts');
  assert(contractsText.includes('reviewerResponsibility?: ReviewerDispatchResponsibility')
    && contractsText.includes('parseReviewerDispatchResponsibility')
    && reviewRunText.includes('parseReviewerDispatchResponsibility(event.reviewerResponsibility)')
    && reviewRunText.includes('...(reviewerResponsibility ? { reviewerResponsibility } : {})')
    && reviewRunHandler.includes('responsibility.epochId !== inventory.epochId')
    && reviewRunHandler.includes('responsibility.wave !== inventory.waves.length + 1')
    && reviewRunHandler.includes('responsibility.materialHash !== inventory.cutoff.materialHash')
    && reviewRunHandler.includes("responsibility.storyFilesHash !== (inventory.cutoff.storyFilesHash ?? '')")
    && reviewRunHandler.indexOf('critic dispatch lacks bound responsibility') < reviewRunHandler.indexOf('const reviewRunId ='),
    'critic new-run responsibility must be digest-bound and compared before run/envelope publication');
  const envelopeText = read('packages/main/src/core/prompt-envelope.ts');
  assert(contractsText.includes('reviewerDispatchBindingDigest?: string')
    && envelopeText.includes('reviewerDispatchBindingDigest: input.reviewerDispatchBindingDigest')
    && envelopeText.includes('envelope.reviewerDispatchBindingDigest === input.reviewerDispatchBindingDigest')
    && reviewRunHandler.includes('reviewerDispatchBindingDigest: dispatchBinding.binding.dispatchBindingDigest')
    && reviewRunText.includes('verifyHistoricalReviewerDispatchBinding')
    && reviewRunText.includes('expectedDispatchBindingDigest: expected')
    && reviewRunText.includes("domainSeparatedDigest('prompt-launcher-spec.v1'")
    && reviewRunText.includes('identities.length !== 1'),
    'historical envelopes must authenticate and select the original dispatch; legacy fallback requires exact launcher reconstruction');
  const incrementalText = read('packages/main/src/core/review-incremental-context.ts');
  assert(contractsText.includes('eligibilityRoleSemanticDigest?: string')
    && envelopeText.includes('envelope.eligibilityRoleSemanticDigest === input.eligibilityRoleSemanticDigest')
    && envelopeText.includes('envelope.eligibilityRoleSemanticDigest === input.roleContract.semanticDigest')
    && reviewRunHandler.includes('roleSemanticDigest: selectedRoleContract.semanticDigest')
    && reviewRunHandler.includes('eligibilityRoleSemanticDigest: selectedRoleContract.semanticDigest')
    && incrementalText.includes('promptRoleContractForSemanticDigest(role, options.roleSemanticDigest)')
    && reviewRunText.includes('envelope.eligibilityRoleSemanticDigest ?? promptRoleContract(run.lane).semanticDigest'),
    'incremental eligibility must consume authenticated registered responsibility semantics while preserving pre-marker history');
  const certificationText = read('packages/main/src/handlers/certification-window.ts');
  assert(certificationText.includes('templates\\/agents\\/[^/]+\\.md$')
    && certificationText.includes("matches.length === 1")
    && /if \(domain\)[\s\S]*else if \(externalConsumer && isExternalUnclassifiedMaterialPath\(entry\.path\)\)[\s\S]*else \{\s*return undefined;/.test(certificationText),
    'certification must classify the narrow canonical agent family while unknown or ambiguous paths refuse');

  const inventoryHandlerPath = 'packages/main/src/handlers/review-inventory.ts';
  const inventoryHandlerText = read(inventoryHandlerPath);
  assert(
    /review_inventory_critic_set[\s\S]*findingDispositions:\s*conservativeDispositions/.test(inventoryHandlerText),
    `${inventoryHandlerPath}: the unique critic Next command must include executable findingDispositions`,
  );
  assert(
    /REVIEW_INVENTORY_NEW_FINDINGS_REQUIRE_NEXT_WAVE[\s\S]*review_inventory_wave_advance/.test(inventoryHandlerText),
    `${inventoryHandlerPath}: explicit saturation finalization must preserve the wave-advance blocker and command`,
  );
  assert(
    /review_inventory_finalize:[\s\S]*REVIEW_INVENTORY_NEW_FINDINGS_REQUIRE_NEXT_WAVE[\s\S]*review_inventory_wave_advance/.test(inventoryHandlerText),
    `${inventoryHandlerPath}: finalize must fail closed on new finding families instead of checkpointing implicitly`,
  );
  assert(
    /withReviewInventoryMutationLock/.test(inventoryHandlerText),
    `${inventoryHandlerPath}: finalize and wave persistence must use the shared reviewer-evidence lock`,
  );

  const findingHandlerPath = 'packages/main/src/handlers/finding.ts';
  const findingHandlerText = read(findingHandlerPath);
  const passProducer = extractNamedFunctionBody(findingHandlerText, 'recordReviewPass') ?? '';
  assert(
    /currentOpenReviewInventory\(ctx\.store, storyId\)[\s\S]*?!readEvidence\.readManifest \|\| !readEvidence\.readLog[\s\S]*?OPEN review inventory requires signed readManifest plus mechanical readEvents\/readLog/.test(passProducer),
    `${findingHandlerPath}: the shared pass producer must reject incomplete OPEN-inventory read evidence before publication`,
  );
  assert(
    /withReviewInventoryMutationLock[\s\S]*assertReviewInventoryEvidenceWritable/.test(findingHandlerText),
    `${findingHandlerPath}: reviewer finding/pass writes must share the inventory lock and enforce temporal evidence admission`,
  );
  assert(
    /latest\.state === 'FINALIZED'[\s\S]*reviewer evidence for that round remains sealed after receipt consumption[\s\S]*REVIEW_INVENTORY_WAVE_EVIDENCE_SEALED/.test(epochText),
    `${epochPath}: finalized review rounds and old-wave ReviewRuns must remain sealed`,
  );
  assert(
    /captureReviewInventoryBaselineFindingIds[\s\S]*baselineFindingIds[\s\S]*REVIEW_INVENTORY_BASELINE_FINDINGS_CHANGED/.test(inventoryHandlerText),
    `${inventoryHandlerPath}: begin must sign and consumers must fail-close the carried-forward verified finding baseline`,
  );
  assert(
    /epoch\.state === 'FINALIZED'[\s\S]*invalidatedAt:[\s\S]*invalidationReason:[\s\S]*signReviewInventoryReceipt/.test(inventoryHandlerText),
    `${inventoryHandlerPath}: an unconsumed FINALIZED receipt needs a signed late-evidence invalidation path`,
  );
  assert(
    /initialRunSequenceBoundary[\s\S]*nextRunSequenceBoundary[\s\S]*reviewRunSequence\(run\)[\s\S]*sequence <= sequenceBoundary/.test(epochText),
    `${epochPath}: inventory waves must use signed monotonic ReviewRun boundaries instead of millisecond ordering`,
  );
  assert(
    /runEvidence\.forEach[\s\S]*row\.findings\.forEach/.test(epochText),
    `${epochPath}: every eligible same-lane ReviewRun must contribute verified findings even when one newer terminal is selected`,
  );
  const scopeContractHandlerText = read('packages/main/src/handlers/scope-contract.ts');
  // B-adc3: a saved scope must fit the same bounded authority shape reviewers consume.
  assert(scopeContractHandlerText.includes('validateFullTaskScopeContext(projectScopeInventory(contract))'),
    'scope writers must validate the final projected scope before persistence');
  for (const command of ['scope_contract_set', 'scope_contract_init_from_plan']) {
    const fact = processFactRegistryMap().get(command);
    assert(fact?.semantics.includes('schema-contract') && fact?.semantics.includes('atomic-persistence'),
      `${command} must register bounded scope schema and fail-before-write semantics`);
  }
  assert(
    /scope_contract_acknowledge[\s\S]*withReviewInventoryMutationLock/.test(scopeContractHandlerText)
      || /withReviewInventoryMutationLock[\s\S]*scope_contract_acknowledge/.test(scopeContractHandlerText),
    'packages/main/src/handlers/scope-contract.ts: scope acknowledgement must share the inventory mutation lock',
  );
  assert(
    /captureReviewInventoryScope[\s\S]*scopeDigest[\s\S]*requiredLanes[\s\S]*OPEN_REVIEW_INVENTORY_SCOPE_MUTATION/.test(inventoryHandlerText),
    `${inventoryHandlerPath}: inventory consumers must recompute frozen scope and active lanes`,
  );
  const checklistHandlerText = read('packages/main/src/handlers/checklist.ts');
  assert(
    /withChecklistLock[\s\S]*withReviewInventoryMutationLock[\s\S]*withMkdirLock/.test(checklistHandlerText),
    'packages/main/src/handlers/checklist.ts: every checklist acceptance writer must use inventory -> checklist lock order',
  );
  const refreshSource = ts.createSourceFile('checklist.ts', checklistHandlerText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const refreshCandidate = findFunctionDeclaration(refreshSource, 'staleReexecCandidate')?.body?.getText(refreshSource) ?? '';
  // Finite admission-shape check complements the real handler smoke; it is not
  // a claim of arbitrary semantic equivalence from source tokens.
  assert(refreshCandidate.includes('if (!resolved || !pin) return undefined;')
    && !refreshCandidate.includes('isExecutableIntentType')
    && refreshCandidate.includes('resolveEvidenceCommandTimeout'),
    'stale refresh candidate must admit every immutable pin, including docs/manual, without bypassing timeout enforcement');
  assert(read(processFactRegistryPath).includes('every immutable pinned intent, including docs/manual'),
    'stale pinned docs/manual recovery must remain registered as mechanical gate evidence');
  const causalVersionSource = ts.createSourceFile('causal-evidence.ts', read('packages/main/src/core/causal-evidence.ts'), ts.ScriptTarget.Latest, true);
  const causalVersionBody = findFunctionDeclaration(causalVersionSource, 'resolveCausalToolVersion')?.body?.getText(causalVersionSource) ?? '';
  assert(/return PROOF_OR_STOP_CLI_VERSION;/.test(causalVersionBody)
    && !/readFileSync|process\.cwd|package\.json/.test(causalVersionBody),
    'causal tool version must use the executing CLI constant, never target or cwd manifests');
  const causalVersionSemantics = 'causal toolVersion binds the executing CLI build independently of target-project and cwd manifests';
  const causalVersionArtifacts = parseProcessFactArtifactByCommandFromSource(read(processFactRegistryPath));
  for (const producerCommand of [
    'verification_evidence_add',
    'verification_evidence_batch_add',
    'verification_evidence_refresh_stale',
    'verification_run',
    'validate',
  ]) {
    assert(causalVersionArtifacts.get(producerCommand)?.consumerGate?.includes(causalVersionSemantics),
      `executing CLI tool version must remain registered for causal-version producer ${producerCommand}`);
  }
  const stampBody = findFunctionDeclaration(refreshSource, 'enforceAndStampEvidence')?.body?.getText(refreshSource) ?? '';
  const actualLaunches = [];
  const inspectLaunch = (node) => {
    if (ts.isCallExpression(node)
      && ['deps.runCommand', 'executePinnedCommand'].includes(node.expression.getText(refreshSource))) {
      actualLaunches.push(node);
      let owner = node.parent;
      while (owner && !ts.isPropertyAssignment(owner)) owner = owner.parent;
      assert(owner?.name?.getText(refreshSource) === 'run'
        && ts.isCallExpression(owner.parent.parent)
        && owner.parent.parent.expression.getText(refreshSource) === 'executeCausalEvidence',
      'actual verification launch must occur inside the causal run callback, after its last-moment preflight');
    }
    ts.forEachChild(node, inspectLaunch);
  };
  inspectLaunch(refreshSource);
  assert(actualLaunches.length === 2, 'both existing verification launch paths retain causal launch ownership');
  assert(read(processFactRegistryPath).includes('actual child launch occurs inside the causal runner'),
    'causal last-moment preflight launch ownership remains a registered process fact');
  assert(stampBody.includes('sharedExecution?.executedAt ?? causal?.receipt.executedAt')
    && stampBody.includes('executedAt: sourceExecutedAt')
    && checklistHandlerText.includes('executedAt: causal.receipt.executedAt')
    && !stampBody.includes('executedAt: new Date()'),
    'V3 execution time must project the actual signed causal source and V5 fan-out must preserve it, never per-intent restamping time');
  for (const binding of [
    'verificationExecutionKey: createVerificationExecutionKey({',
    'verificationExecutionKey: executionKey',
    'verificationObservationId: randomUUID()',
    'inputs: sharedCausalReceipt?.identity.inputs ?? {',
    'const causal = !sharedExecution || sharedCausalReceipt',
    'causalReceipt: stamp.causalReceipt',
    'groups.get(candidate.executionKey)',
    'currentExecutionKey === reexec.executionKey',
    'currentCandidate.assertionKey === executionOutcome.assertionKey',
    'preflightInputKey(input, sourceReceipt.executionKey)',
    'preflightInputKey(input, receipt.executionKey)',
    'preflightInputKey(causalPreflight.input, receipt.executionKey)',
    'preflightInputKey(firstPreflight.input, firstReceipt.executionKey)',
  ]) assert(checklistHandlerText.includes(binding), `strict refresh identity binding missing: ${binding}`);
  assert(!refreshCandidate.includes('verificationObservationId')
    && !refreshCandidate.includes('randomUUID'),
    'observation addressing must never split physical execution grouping');
  assert(read(processFactRegistryPath).includes('selector-free physical execution keys bind signed causal identity')
    && read(processFactRegistryPath).includes('observation-only identifier'),
    'physical/CAS/import identity, independent assertions and actual signed execution time must remain registered');
  const refreshSmoke = ['foundation', 'refresh', 'integrity', 'causal', 'publication', 'cli'].map(name => read(`packages/main/src/tasks/verification-run-and-guard/${name}.ts`)).join('\n');
  for (const marker of ['pinned manual verifier re-earns mechanical authority', 'pinned docs verifier re-earns mechanical authority',
    'a failing re-run leaves the row demoted', 'pin-less demotion strips the receipt',
    'shared rows bind the same selector-free execution receipt', 'only different effective timeout values split execution',
    'selector-specific evidence identities remain distinct over one raw run',
    'independent selector assertions preserve the same signed source execution',
    'nonmatching selector receives no mechanical receipt',
    'raw verifier refreshed git index without cross-receipt identity mismatch',
    'cross-identity cached preflight is refused before execution', 'actual production import refuses substituted signed CAS receipt',
    'cross-identity refusal leaves prior receipts and pins unchanged', 'fan-out retains source signed execution time, never publication time',
    'new ordinary executions borrowed an older same-key CAS observation', 'B-aa5f CHK008 causal-import-integration PASS',
    'causal ledger counts every independently evaluated intent, including shared-execution followers',
    'bounded diagnostic probe still omits the middle-of-large-output selector',
    'causal replay binds durable complete selector output',
    'complete-output replay does not launch another execution',
    'authenticated complete causal output finds the middle-of-large-output selector',
    'authenticated complete-output V5 assertion agrees with causal replay']) {
    assert(refreshSmoke.includes(marker), `stale refresh executable control missing: ${marker}`);
  }
  assert(
    /reviewInventoryAcceptanceSubjectDigest[\s\S]*verificationIntent[\s\S]*verificationEvidence[\s\S]*userSeesSnapshot/.test(epochText),
    `${epochPath}: the frozen acceptance subject must include complete checklist review semantics`,
  );
  assert(
    /proofStoryContract[\s\S]*scopeShrinkageDecision[\s\S]*reviewInventoryAcceptanceSubjectDigestForStore/.test(epochText)
      && /currentAcceptanceSubjectDigest[\s\S]*effective ProofStory\/checklist acceptance subject changed/.test(epochText),
    `${epochPath}: OPEN and FINALIZED consumers must bind and recompute the effective ProofStory acceptance subject`,
  );
  const proofStoryHandlerText = read('packages/main/src/handlers/proofstory.ts');
  assert(
    /scope_shrinkage_decision_set[\s\S]*withReviewInventoryMutationLock[\s\S]*withMkdirLock/.test(proofStoryHandlerText),
    'packages/main/src/handlers/proofstory.ts: scope shrinkage must use inventory -> checklist lock order',
  );
  const idempotentFindingHandlerText = read('packages/main/src/handlers/finding.ts');
  assert(
    /sameTerminal[\s\S]*verifyReviewPass[\s\S]*idempotent retry[\s\S]*conflicting terminal pass/.test(idempotentFindingHandlerText),
    'packages/main/src/handlers/finding.ts: review-pass terminal writes must be strongly idempotent and reject semantic conflicts',
  );
  const passAst = ts.createSourceFile('finding.ts', idempotentFindingHandlerText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const passFunction = passAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'recordReviewPass');
  let authenticatedRetryBlock = false;
  const visitPassBlock = node => {
    if (ts.isBlock(node)) {
      const declarations = node.statements.flatMap((statement, index) => ts.isVariableStatement(statement)
        ? statement.declarationList.declarations.map(declaration => ({ declaration, index })) : []);
      const auth = declarations.find(({ declaration }) => ts.isIdentifier(declaration.name) && declaration.name.text === 'nativeEvidenceBinding'
        && declaration.initializer && ts.isCallExpression(declaration.initializer)
        && ts.isIdentifier(declaration.initializer.expression) && declaration.initializer.expression.text === 'issueDirectReviewAuthority');
      const terminal = declarations.find(({ declaration }) => ts.isIdentifier(declaration.name) && declaration.name.text === 'sameTerminal');
      if (auth && terminal && auth.index < terminal.index) authenticatedRetryBlock = true;
    }
    ts.forEachChild(node, visitPassBlock);
  };
  if (passFunction) visitPassBlock(passFunction);
  assert(authenticatedRetryBlock, 'review_pass_set must authenticate direct authority in the same execution block before terminal retry selection');
  const agentsDocText = read('AGENTS.md');
  const storyLifecycleText = read('docs/requirements/decisions/story-lifecycle.md');
  const testingInfraText = read('docs/requirements/decisions/testing-infra.md');
  for (const [label, text] of [['AGENTS.md', agentsDocText], ['story-lifecycle.md', storyLifecycleText], ['testing-infra.md', testingInfraText]]) {
    assert(/fresh (?:non-latest )?PASS|fresh PASS/.test(text) && /open FINDING/.test(text), `${label}: latest-run guidance must preserve the kind-aware PASS/FINDING distinction`);
  }
  const latestRunHintBody = reviewRunText.match(/function latestRunHint\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(
    /resubmit finding_add/.test(latestRunHintBody) && !/review_pass_set/.test(latestRunHintBody),
    'packages/main/src/core/review-run.ts: FINDING-only non-latest-run recovery hint must never tell a valid PASS to resubmit review_pass_set',
  );
  const candidateHandlerText = read('packages/main/src/handlers/candidate-spec-routing.ts');
  assert(
    /withReviewInventoryMutationLock[\s\S]*writeCandidateSpecSet[\s\S]*refreshReviewInventoryContextLocked/.test(candidateHandlerText),
    'packages/main/src/handlers/candidate-spec-routing.ts: candidate reroute must atomically invalidate an OPEN epoch',
  );
  assert(
    /candidateSpecSetDigest[\s\S]*corpusDigest[\s\S]*OPEN_REVIEW_INVENTORY_CANDIDATE_ROUTING_MUTATION/.test(inventoryHandlerText),
    `${inventoryHandlerPath}: epoch consumers must recompute the signed candidate universe`,
  );
  const reviewRunHandlerText = read('packages/main/src/handlers/review-run.ts');
  assert(
    /withReviewInventoryMutationLock[\s\S]*assertReviewInventoryContextFreshLocked[\s\S]*withReviewMetadataTransactionLock[\s\S]*writeReviewRuns/.test(reviewRunHandlerText),
    'packages/main/src/handlers/review-run.ts: inventory precheck and durable RR publication must be one outer critical section',
  );
  const promptContractsText = read('packages/main/src/core/prompt-contracts.ts');
  const promptEnvelopeText = read('packages/main/src/core/prompt-envelope.ts');
  assert(
    /findingProjection[\s\S]*findingProjectionDigest/.test(promptContractsText)
      && /prompt-finding-projection\.v1/.test(promptEnvelopeText)
      && /findingProjection:\s*envelope\.findingProjection/.test(reviewRunText),
    'Prompt Envelope: historical eligibility must consume an envelope-signed run-start finding projection',
  );
  const mkdirLockText = read('packages/main/src/core/mkdir-lock.ts');
  assert(
    /classifyDefaultHolder[\s\S]*process\.kill\(holder\.pid, 0\)[\s\S]*observedProcessStartTimeMs[\s\S]*return 'active'/.test(mkdirLockText),
    'packages/main/src/core/mkdir-lock.ts: stale reclaim must preserve a live same-host process incarnation beyond mtime expiry',
  );
  assert(
    /REVIEW_INVENTORY_LIVE_AGGREGATE_CHANGED[\s\S]*begin a fresh inventory epoch/.test(epochText),
    `${epochPath}: remediation consumption must fail closed after replaying a changed live terminal/finding aggregate`,
  );

  const projectConfig = read('proof-or-stop.config.json');
  assert(
    /"acceptanceRolloutGateMode"\s*:\s*"enforce"/.test(projectConfig),
    'proof-or-stop.config.json: mandatory Wave 4 acceptance authority must be mechanically enforced for this repository',
  );
}

export function extractExportedObjectBody(text, exportName, relPath) {
  const match = new RegExp(`\\bexport\\s+const\\s+${exportName}\\b(?:\\s*:\\s*[^=]+)?\\s*=\\s*\\{`).exec(text);
  assert(Boolean(match), `${relPath} should export ${exportName}`);
  if (!match) return '';
  const objectStart = match.index + match[0].lastIndexOf('{');
  return extractBalancedBlock(text, objectStart, '{', '}', `${relPath} ${exportName}`);
}

export function extractConstInitializer(text, constName, relPath) {
  const match = new RegExp(`\\b(?:export\\s+)?const\\s+${constName}\\b(?:\\s*:\\s*[^=]+)?\\s*=\\s*`).exec(text);
  assert(Boolean(match), `${relPath} should declare ${constName}`);
  if (!match) return '';

  const startIndex = match.index + match[0].length;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (char === '\\') escaped = true;
      else if (char === quote) inString = false;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      inString = true;
      quote = char;
      continue;
    }
    if (char === '(') {
      parenDepth += 1;
      continue;
    }
    if (char === ')') {
      parenDepth -= 1;
      continue;
    }
    if (char === '[') {
      bracketDepth += 1;
      continue;
    }
    if (char === ']') {
      bracketDepth -= 1;
      continue;
    }
    if (char === '{') {
      braceDepth += 1;
      continue;
    }
    if (char === '}') {
      braceDepth -= 1;
      continue;
    }
    if (char === ';' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      return text.slice(startIndex, index).trim();
    }
  }

  fail(`${relPath} ${constName} initializer should terminate with a semicolon`);
  return '';
}

export function assertInitializerPattern(initializer, label, pattern, message) {
  assert(pattern.test(initializer), `${processFactRegistryPath}: ${label} ${message}`);
}

export function extractObjectPropertyBlock(objectText, propertyName, label) {
  const match = new RegExp(`\\b${propertyName}\\s*:\\s*\\{`).exec(objectText);
  assert(Boolean(match), `${label} should declare ${propertyName}`);
  if (!match) return '';

  const openIndex = match.index + match[0].lastIndexOf('{');
  return extractBalancedBlock(objectText, openIndex, '{', '}', `${label} ${propertyName}`);
}

export function assertArrayPropertyIncludesValue(block, propertyName, value, label) {
  const match = new RegExp(`\\b${propertyName}\\s*:\\s*\\[`).exec(block);
  assert(Boolean(match), `${label} should declare ${propertyName}`);
  if (!match) return;

  const openIndex = match.index + match[0].lastIndexOf('[');
  const arrayBody = extractBalancedBlock(block, openIndex, '[', ']', `${label} ${propertyName}`);
  assert(
    new RegExp(`['"]${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`).test(arrayBody),
    `${label} ${propertyName} must include '${value}'`,
  );
}

export function assertProcessFactMappedSourceContracts(sourceText) {
  const runtimeSourceRefsInitializer = extractConstInitializer(sourceText, 'RUNTIME_PROCESS_FACT_SOURCE_REFS', processFactRegistryPath);
  const sourceContracts = [
    {
      name: 'verification_pin_narrow',
      producerSourceRefs: [
        'packages/main/src/core/verification-execution-evidence.ts',
        'packages/main/src/handlers/checklist.ts',
      ],
      consumerSourceRefs: [
        'packages/main/src/core/verification.ts',
        'packages/main/src/handlers/checklist.ts',
      ],
    },
    {
      name: 'runtime:verification_execution_assertion_reuse_gate',
      producerSourceRefs: [
        'packages/main/src/core/verification-execution-evidence.ts',
        'packages/main/src/core/evidence-freshness.ts',
        'packages/main/src/core/proof-admissibility.ts',
        'packages/main/src/core/verification.ts',
      ],
      consumerSourceRefs: [
        'packages/main/src/core/machine.ts',
        'packages/main/src/core/lifecycle-readiness.ts',
        'packages/main/src/handlers/phase-gates.ts',
        'packages/main/src/handlers/verifier.ts',
        'packages/main/src/handlers/done-prepare.ts',
        'packages/main/src/handlers/certification-window.ts',
        'packages/main/src/handlers/checklist.ts',
      ],
    },
    {
      name: 'runtime:verification_execution_key_producer_lock',
      producerSourceRefs: [
        'packages/main/src/core/verification-execution-evidence.ts',
        'packages/main/src/handlers/checklist.ts',
      ],
      consumerSourceRefs: [
        'packages/main/src/handlers/checklist.ts',
        'packages/main/src/core/proof-admissibility.ts',
        'packages/main/src/core/verification.ts',
      ],
    },
  ];
  for (const contract of sourceContracts) {
    const match = new RegExp(`['"]${contract.name}['"]\\s*:\\s*\\{`).exec(runtimeSourceRefsInitializer);
    assert(Boolean(match), `${processFactRegistryPath}: ${contract.name} must declare explicit source refs`);
    if (!match) continue;
    const openIndex = match.index + match[0].lastIndexOf('{');
    const block = extractBalancedBlock(runtimeSourceRefsInitializer, openIndex, '{', '}', `${processFactRegistryPath} ${contract.name}`);
    for (const ref of contract.producerSourceRefs) assertArrayPropertyIncludesValue(block, 'producerSourceRefs', ref, contract.name);
    for (const ref of contract.consumerSourceRefs) assertArrayPropertyIncludesValue(block, 'consumerSourceRefs', ref, contract.name);
  }

  const commandFactsInitializer = extractConstInitializer(sourceText, 'COMMAND_PROCESS_FACTS', processFactRegistryPath);
  assertInitializerPattern(
    commandFactsInitializer,
    'COMMAND_PROCESS_FACTS',
    /\bPROCESS_FACT_LEVELS\s*[\s\S]*\.filter\s*\(\s*\(entry:\s*ProcessFactLevelEntry\)\s*=>\s*!entry\.name\.startsWith\('flow-policy:'\)\s*&&\s*entry\.name\s*!==\s*'runtime:story_scope_budget'\s*\)\s*[\s\S]*\.map\s*\(/,
    'must map PROCESS_FACT_LEVELS directly while excluding flow-policy facts and the explicitly authored story-scope-budget fact',
  );
  assertInitializerPattern(
    commandFactsInitializer,
    'COMMAND_PROCESS_FACTS',
    /\bconst\s+policy\s*=\s*commandPolicy\(entry\.name\)\s*;/,
    'must derive lifecycle policy from commandPolicy(entry.name)',
  );
  assertInitializerPattern(
    commandFactsInitializer,
    'COMMAND_PROCESS_FACTS',
    /\bconst\s+sourceRefs\s*=\s*RUNTIME_PROCESS_FACT_SOURCE_REFS\[entry\.name\]\s*;/,
    'must derive explicit runtime producer/consumer sources from RUNTIME_PROCESS_FACT_SOURCE_REFS',
  );
  assertInitializerPattern(
    commandFactsInitializer,
    'COMMAND_PROCESS_FACTS',
    /\bconst\s+rootOnly\s*=\s*policy\s*\?\s*policy\.rootOnly\s*===\s*true\s*\|\|\s*policy\.status\s*===\s*'rootOnly'\s*:\s*undefined\s*;/,
    'must wire rootOnly from policy.rootOnly/status',
  );
  assertInitializerPattern(
    commandFactsInitializer,
    'COMMAND_PROCESS_FACTS',
    /\bconst\s+gateEvidence\s*=\s*policy\s*\?\s*policy\.gateEvidence\s*===\s*true\s*\|\|\s*policy\.status\s*===\s*'gateEvidence'\s*:\s*undefined\s*;/,
    'must wire gateEvidence from policy.gateEvidence/status',
  );
  for (const [fieldLabel, pattern] of [
    ['name', /\bname:\s*entry\.name\b/],
    ['kind', /\bkind:\s*commandFactKind\(entry\.name,\s*entry\.level\)/],
    ['semantics', /\bsemantics:\s*commandFactSemantics\(entry\.name,\s*entry\.level\)/],
    ['level', /\blevel:\s*entry\.level\b/],
    ['lifecycle', /\blifecycle:\s*policy\?\.status\b/],
    ['allowedPhases', /\ballowedPhases:\s*policy\?\.allowedPhases\b/],
    ['rootOnly', /\brootOnly\s*,/],
    ['legacy', /\blegacy:\s*policy\s*\?\s*policy\.status\s*===\s*'legacy'\s*:\s*undefined\b/],
    ['gateEvidence', /\bgateEvidence\s*,/],
    ['destructiveRisk', /\bdestructiveRisk:\s*policy\?\.destructiveRisk\b/],
    ['producer', /\bproducer:\s*entry\.owner\b/],
    ['producerSourceRefs', /\bproducerSourceRefs:\s*sourceRefs\?\.producerSourceRefs\s*\?\?/],
    ['consumerGate', /\bconsumerGate:\s*entry\.gateConsumer\b/],
    ['consumerSourceRefs', /\bconsumerSourceRefs:\s*sourceRefs\?\.consumerSourceRefs\s*\?\?/],
    ['artifact', /\bartifact:\s*PROCESS_FACT_ARTIFACT_BY_COMMAND\[entry\.name\]/],
    ['reviewerLane', /\breviewerLane:\s*PROCESS_FACT_ARTIFACT_BY_COMMAND\[entry\.name\]\?\.reviewerLane\b/],
    ['rationale', /\brationale:\s*entry\.rationale\b/],
  ]) {
    assertInitializerPattern(
      commandFactsInitializer,
      'COMMAND_PROCESS_FACTS',
      pattern,
      `must wire ${fieldLabel} from level/policy/artifact sources`,
    );
  }

  const reviewerLanesInitializer = extractConstInitializer(sourceText, 'PROCESS_FACT_REVIEWER_LANES', processFactRegistryPath);
  assertInitializerPattern(
    reviewerLanesInitializer,
    'PROCESS_FACT_REVIEWER_LANES',
    /\bPROCESS_FACT_REVIEWER_LANE_DEFINITIONS\.map\s*\(/,
    'must map PROCESS_FACT_REVIEWER_LANE_DEFINITIONS directly',
  );
  assertInitializerPattern(
    reviewerLanesInitializer,
    'PROCESS_FACT_REVIEWER_LANES',
    /\.\.\.entry\b/,
    'must preserve name/producer/consumerGate/reviewerLane/artifact/rationale via ...entry',
  );
  assertInitializerPattern(
    reviewerLanesInitializer,
    'PROCESS_FACT_REVIEWER_LANES',
    /\bkind:\s*'reviewer-lane'\s+as\s+const\b/,
    'must hard-code reviewer-lane kind',
  );
  assertInitializerPattern(
    reviewerLanesInitializer,
    'PROCESS_FACT_REVIEWER_LANES',
    /\bsemantics:\s*\[\s*'reviewer-lane'\s*,\s*'gate-evidence'\s*\]\s+as\s+const\b/,
    'must hard-code reviewer-lane gate-evidence semantics',
  );
  assertInitializerPattern(
    reviewerLanesInitializer,
    'PROCESS_FACT_REVIEWER_LANES',
    /\blevel:\s*'L4'\s+as\s+const\b/,
    'must hard-code L4 reviewer-lane level',
  );

  const flowPoliciesInitializer = extractConstInitializer(sourceText, 'PROCESS_FACT_FLOW_POLICIES', processFactRegistryPath);
  assertInitializerPattern(
    flowPoliciesInitializer,
    'PROCESS_FACT_FLOW_POLICIES',
    /\bFLOW_FACT_POLICIES\.map\s*\(/,
    'must map FLOW_FACT_POLICIES directly',
  );
  assertInitializerPattern(
    flowPoliciesInitializer,
    'PROCESS_FACT_FLOW_POLICIES',
    /\bkind:\s*'flow-policy'\s+as\s+const\b/,
    'must hard-code flow-policy kind',
  );
  assertInitializerPattern(
    flowPoliciesInitializer,
    'PROCESS_FACT_FLOW_POLICIES',
    /\bsemantics:\s*policy\.semantics\s+as\s+readonly\s+ProcessFactSemantic\[\]/,
    'must wire semantics from centralized policy',
  );
  assertInitializerPattern(
    flowPoliciesInitializer,
    'PROCESS_FACT_FLOW_POLICIES',
    /\bartifact:\s*'artifactCommand'\s+in\s+policy\s*&&\s*policy\.artifactCommand\s*\?\s*PROCESS_FACT_ARTIFACT_BY_COMMAND\[policy\.artifactCommand\]/,
    'must resolve artifact metadata from policy artifactCommand',
  );
}
