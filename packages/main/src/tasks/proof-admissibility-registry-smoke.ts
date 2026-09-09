#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getProofSurfaceDefinition,
  PROOF_SURFACE_REGISTRY,
} from '../core/proof-admissibility.js';
import * as compatibilityEntry from '../core/evidence/admissibility/index.js';
import { PROOF_OR_STOP_DIR } from '../core/proof-or-stop-paths.js';
import { PROCESS_FACT_REGISTRY } from '../core/process-fact-registry.js';
import { renderManagedHostRunDoctorSection } from '../handlers/doctor.js';
import {
  boundedCrossHostReviewTimeoutMinutes,
  CROSS_HOST_REVIEW_DEFAULT_TIMEOUT_MINUTES,
} from '../handlers/cross-host-review.js';
import { CLAUDE_CLI_DEFAULT_TIMEOUT_MS } from '../providers/claude-cli.js';
import { assertProviderExecutionInventoryContract } from './provider-execution-inventory-contract.js';

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const repoRoot = join(srcRoot, '..', '..', '..');
const distRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = (relative: string): string => readFileSync(join(srcRoot, relative), 'utf8');
const document = (relative: string): string => readFileSync(join(repoRoot, relative), 'utf8');

function main(): void {
  const importerAdmissionMutantOnly = process.argv[2] === '--importer-admission-mutant';
  const definition = getProofSurfaceDefinition('managed-review-evidence');
  assert.ok(definition, 'managed review evidence must be registered in shared Proof Admissibility');
  assert.deepEqual(definition.allowedConsumers, ['REVIEW']);
  assert.equal(definition.signatureOrReceiptBindingRequired, true);
  assert.equal(definition.temporalAndMaterialBindingRequired, true);
  assert.equal(
    PROOF_SURFACE_REGISTRY.filter(row => row.artifactKind === 'managed-review-evidence').length,
    1,
    'there must be one shared artifact definition, not a parallel managed-review registry',
  );
  assert.equal(
    compatibilityEntry.getProofSurfaceDefinition('managed-review-evidence')?.artifactKind,
    definition.artifactKind,
    'compatibility entrypoint must re-export the same registry instance',
  );
  assert.strictEqual(
    compatibilityEntry.PROOF_SURFACE_REGISTRY,
    PROOF_SURFACE_REGISTRY,
    'compatibility entrypoint must expose the canonical registry object, never a parallel copy',
  );

  const importer = source('handlers/managed-review-evidence.ts');
  const gate = source('core/review-run.ts');
  const verifier = source('core/managed-review-evidence.ts');
  assert.match(importer, /createManagedReviewEvidenceBinding\(/, 'import boundary must use the shared managed evidence verifier');
  assert.match(gate, /verifyManagedReviewEvidence\(/, 'REVIEW boundary must re-run the same verifier');
  assert.match(verifier, /buildProofAdmissibilityDiagnostic\(/, 'the verifier must resolve the canonical shared Proof Admissibility evaluator');
  assert.doesNotMatch(verifier, /PROOF_SURFACE_REGISTRY\s*=/, 'managed verifier must not define a parallel artifact registry');
  assert.doesNotMatch(importer, /diagnostic\.allowed\s*=|allowed:\s*true/, 'importer must not hard-code an admissible result');

  if (process.env.LATTICE_PROOF_MUTANT_CHILD !== '1') {
  const mutationParent = join(repoRoot, PROOF_OR_STOP_DIR, 'runtime');
  mkdirSync(mutationParent, { recursive: true });
  if (!importerAdmissionMutantOnly) {
  const mutationRoot = mkdtempSync(join(mutationParent, 'managed-evaluator-valid-true-'));
  try {
    const isolatedDist = join(mutationRoot, 'dist');
    cpSync(distRoot, isolatedDist, { recursive: true });
    cpSync(join(distRoot, '..', 'templates'), join(mutationRoot, 'templates'), { recursive: true });
    const verifierPath = join(isolatedDist, 'core', 'managed-review-evidence.js');
    const originalVerifier = readFileSync(verifierPath, 'utf8');
    const mutatedVerifier = originalVerifier.replace(
      'const valid = diagnostic.allowed && !diagnostic.blocking;',
      'const valid = true;',
    );
    assert.notEqual(mutatedVerifier, originalVerifier, 'valid=true executable mutant must alter the compiled shared evaluator');
    writeFileSync(verifierPath, mutatedVerifier);
    for (const boundary of ['intake', 'gate'] as const) {
      const result = spawnSync(process.execPath, [join(isolatedDist, 'tasks', 'managed-review-evidence-smoke.js')], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, LATTICE_VALID_TRUE_MUTATION_BOUNDARY: boundary },
      });
      assert.equal(result.signal, null,
        `hard-coded valid=true ${boundary} mutant must complete within the bounded child ceiling, not be accepted after timeout`);
      assert.notEqual(result.status, null,
        `hard-coded valid=true ${boundary} mutant must return an executable failure status, not a timeout sentinel`);
      assert.notEqual(result.status, 0, `hard-coded valid=true must be killed at the ${boundary} boundary`);
      assert.match(
        `${result.stdout}${result.stderr}`,
        boundary === 'intake' ? /fresh intake rejects agent mutation/ : /REVIEW gate rejects persisted agent mutation/,
        `the ${boundary} executable boundary, not a source regex, must bite the valid=true mutant`,
      );
    }
  } finally {
    rmSync(mutationRoot, { recursive: true, force: true });
  }
  }

  const sourceMutationRoot = mkdtempSync(join(mutationParent, 'managed-source-mutation-bites-'));
  try {
    const isolatedDist = join(sourceMutationRoot, 'dist');
    cpSync(distRoot, isolatedDist, { recursive: true });
    cpSync(join(distRoot, '..', 'templates'), join(sourceMutationRoot, 'templates'), { recursive: true });
    const executeMutation = (args: {
      name: string;
      relativePath: string;
      replacements: Array<[string, string]>;
      boundary: 'intake' | 'gate' | 'canonical';
      target?: string;
      expected: RegExp;
    }): void => {
      const targetPath = join(isolatedDist, args.relativePath);
      const original = readFileSync(targetPath, 'utf8');
      let mutated = original;
      for (const [from, to] of args.replacements) {
        const next = mutated.replace(from, to);
        assert.notEqual(next, mutated, `${args.name} mutant anchor must exist: ${from}`);
        mutated = next;
      }
      writeFileSync(targetPath, mutated);
      const result = spawnSync(process.execPath, [join(isolatedDist, 'tasks', 'managed-review-evidence-smoke.js')], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          ...process.env,
          LATTICE_VALID_TRUE_MUTATION_BOUNDARY: args.boundary,
          ...(args.target ? { LATTICE_BINDING_MUTATION_NAME: args.target } : {}),
        },
      });
      writeFileSync(targetPath, original);
      assert.equal(result.signal, null,
        `${args.name} source mutant must complete within the former 60-second child ceiling, not be accepted after timeout`);
      assert.notEqual(result.status, null,
        `${args.name} source mutant must return an executable failure status, not a timeout sentinel`);
      assert.notEqual(result.status, 0, `${args.name} production-source mutant must be killed`);
      assert.match(`${result.stdout}${result.stderr}`, args.expected,
        `${args.name} must bite at its executable boundary instead of a source regex`);
    };

    if (importerAdmissionMutantOnly) {
      const descriptorTransport = spawnSync(process.execPath, [
        join(isolatedDist, 'tasks', 'managed-review-evidence-smoke.js'),
        '--descriptor-proposal-transport',
      ], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 60_000,
        env: process.env,
      });
      assert.equal(descriptorTransport.status, 0,
        `copied-dist descriptor transport must preserve the fake Codex shell exec identity: ${descriptorTransport.stderr}${descriptorTransport.stdout}`);
      executeMutation({
        name: 'importer admission bypass',
        relativePath: join('core', 'managed-review-evidence.js'),
        replacements: [['if (!verification.valid) {', 'if (false) {']],
        boundary: 'intake',
        target: 'agent',
        expected: /fresh intake rejects agent mutation/,
      });
      console.log('proof-admissibility-registry-smoke importer-admission-mutant PASS');
      return;
    }

    executeMutation({
      name: 'importer admission bypass',
      relativePath: join('core', 'managed-review-evidence.js'),
      replacements: [['if (!verification.valid) {', 'if (false) {']],
      boundary: 'intake',
      target: 'agent',
      expected: /fresh intake rejects agent mutation/,
    });
    executeMutation({
      name: 'REVIEW consumer admission bypass',
      relativePath: join('core', 'review-run.js'),
      replacements: [[
        "if (authority.reviewGatePath === 'managed-receipt' && managedBinding) {",
        "if (false && authority.reviewGatePath === 'managed-receipt' && managedBinding) {",
      ]],
      boundary: 'gate',
      target: 'agent',
      expected: /REVIEW gate rejects persisted agent mutation/,
    });
    executeMutation({
      name: 'canonical reason divergence',
      relativePath: join('core', 'review-run.js'),
      replacements: [['${managed.reason}', 'canonical_reason_diverged']],
      boundary: 'canonical',
      target: 'agent',
      expected: /one canonical reason for agent mutation/,
    });

    const bindingMutants: Array<{
      name: string;
      replacements: Array<[string, string]>;
    }> = [
      { name: 'story', replacements: [['proposal?.storyId === args.storyId', 'true'], ['runBinding.storyId === args.storyId', 'true']] },
      { name: 'agent', replacements: [['proposal.providerAgent === args.binding.providerAgent', 'true'], ['args.agent === args.lane', 'true'], ['runBinding.agentType === args.agent', 'true']] },
      { name: 'lane', replacements: [['proposal.lane === args.lane', 'true'], ['args.agent === args.lane', 'true'], ['runBinding.lane === args.lane', 'true']] },
      { name: 'reviewRun', replacements: [['proposal.reviewRunId === args.reviewRunId', 'true'], ['runBinding.reviewRunId === args.reviewRunId', 'true']] },
      { name: 'provider', replacements: [['runBinding.host === args.binding.providerHost', 'true']] },
      { name: 'head', replacements: [['runBinding.reviewBinding.headHash === args.expected.headHash', 'true']] },
      { name: 'material', replacements: [['runBinding.reviewBinding.materialHash === args.expected.materialHash', 'true']] },
      { name: 'storyFiles', replacements: [['runBinding.reviewBinding.storyFilesHash === args.expected.storyFilesHash', 'true']] },
      { name: 'prompt', replacements: [['runBinding.reviewBinding.promptHash === args.expected.promptHash', 'true']] },
      { name: 'envelope', replacements: [['runBinding.reviewBinding.envelopeId === args.expected.envelopeId', 'true']] },
      { name: 'managedPrompt', replacements: [['args.binding.managedPromptDigest === expectedManagedPromptDigest', 'true']] },
    ];
    for (const mutant of bindingMutants) {
      executeMutation({
        name: `${mutant.name} binding bypass`,
        relativePath: join('core', 'managed-review-evidence.js'),
        replacements: mutant.replacements,
        boundary: 'intake',
        target: mutant.name,
        expected: new RegExp(`fresh intake rejects ${mutant.name} mutation`),
      });
    }

    const parallelRoot = join(sourceMutationRoot, 'parallel-registry');
    const parallelDist = join(parallelRoot, 'dist');
    cpSync(distRoot, parallelDist, { recursive: true });
    cpSync(join(distRoot, '..', 'templates'), join(parallelRoot, 'templates'), { recursive: true });
    const compatibilityPath = join(parallelDist, 'core', 'evidence', 'admissibility', 'index.js');
    const compatibilitySource = readFileSync(compatibilityPath, 'utf8');
    writeFileSync(compatibilityPath, [
      "import { PROOF_SURFACE_REGISTRY as CANONICAL_PROOF_SURFACE_REGISTRY } from '../../proof-admissibility.js';",
      'export const PROOF_SURFACE_REGISTRY = [...CANONICAL_PROOF_SURFACE_REGISTRY];',
      compatibilitySource,
    ].join('\n'));
    const parallel = spawnSync(process.execPath, [join(parallelDist, 'tasks', 'proof-admissibility-registry-smoke.js')], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, LATTICE_PROOF_MUTANT_CHILD: '1' },
    });
    assert.notEqual(parallel.status, 0, 'parallel proof registry executable mutant must be killed');
    assert.match(`${parallel.stdout}${parallel.stderr}`, /canonical registry object, never a parallel copy/);
  } finally {
    rmSync(sourceMutationRoot, { recursive: true, force: true });
  }

  const dispatchMutationRoot = mkdtempSync(join(mutationParent, 'lattice-dispatch-admission-bypass-'));
  try {
    const isolatedDist = join(dispatchMutationRoot, 'dist');
    cpSync(distRoot, isolatedDist, { recursive: true });
    cpSync(join(distRoot, '..', 'templates'), join(dispatchMutationRoot, 'templates'), { recursive: true });
    // B-137a: the brand rename moved core/lattice-dispatch.ts to
    // core/proof-or-stop-dispatch.ts, but this mutation target kept the retired
    // basename, so the suite died with ENOENT before it could assert anything.
    // A mutation test that cannot open its target proves nothing while still
    // reporting a hard failure -- and it took down
    // managed-cross-provider-suite-smoke too, which runs this as a child.
    const dispatchPath = join(isolatedDist, 'core', 'proof-or-stop-dispatch.js');
    const originalDispatch = readFileSync(dispatchPath, 'utf8');
    const mutatedDispatch = originalDispatch.replace('if (!admission.admitted) {', 'if (false) {');
    assert.notEqual(mutatedDispatch, originalDispatch, 'reviewer lattice-dispatch admission-bypass mutant must alter the compiled launch owner');
    writeFileSync(dispatchPath, mutatedDispatch);
    const result = spawnSync(process.execPath, [join(isolatedDist, 'tasks', 'dispatch-run-smoke.js')], {
      cwd: repoRoot,
      encoding: 'utf8',
      // dispatch-run-smoke is itself a broad executable contract (currently
      // about 105s on the host). Give the mutation child enough time to reach
      // the saturated reviewer boundary; a 60s ceiling killed it before the
      // admission assertion and produced an empty signal-only diagnostic.
      timeout: 180_000,
      env: process.env,
    });
    assert.notEqual(result.status, 0, 'the real reviewer lattice-dispatch boundary must kill an admission-bypass mutant');
    assert.match(
      `${result.stdout}${result.stderr}`,
      /saturated reviewer dispatch must fail closed|lattice-dispatch admission must run before the injected reviewer provider runner/,
      `the executable reviewer launch boundary, not a source regex, must bite the admission-bypass mutant (status=${String(result.status)}, signal=${String(result.signal)}, error=${String(result.error?.message ?? '')})`,
    );
  } finally {
    rmSync(dispatchMutationRoot, { recursive: true, force: true });
  }

  const platformMutationRoot = mkdtempSync(join(mutationParent, 'managed-submit-win32-bypass-'));
  try {
    const isolatedDist = join(platformMutationRoot, 'dist');
    cpSync(distRoot, isolatedDist, { recursive: true });
    cpSync(join(distRoot, '..', 'templates'), join(platformMutationRoot, 'templates'), { recursive: true });
    const managedPath = join(isolatedDist, 'core', 'managed-host-run.js');
    const originalManaged = readFileSync(managedPath, 'utf8');
    const mutatedManaged = originalManaged.replace(
      'assertManagedHostRunPlatformSupported(platform);',
      '/* submit platform admission bypassed */',
    );
    assert.notEqual(mutatedManaged, originalManaged, 'submit win32 wiring mutant must remove the production pre-spawn platform assertion');
    writeFileSync(managedPath, mutatedManaged);
    const result = spawnSync(process.execPath, [join(isolatedDist, 'tasks', 'managed-host-run-smoke.js')], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 60_000,
      env: process.env,
    });
    assert.notEqual(result.status, 0, 'a real submitManagedHostRun win32 admission bypass must be killed');
    assert.match(
      `${result.stdout}${result.stderr}`,
      /Missing expected rejection|unsupported platforms must fail before worker\/provider spawn/,
      'the executable submit boundary, not the pure platform helper alone, must bite the win32 bypass mutant',
    );
  } finally {
    rmSync(platformMutationRoot, { recursive: true, force: true });
  }
  }

  const proposalFact = PROCESS_FACT_REGISTRY.find(row => row.name === 'managed_review_proposal_set');
  const importFact = PROCESS_FACT_REGISTRY.find(row => row.name === 'managed_review_evidence_import');
  assert.equal(proposalFact?.level, 'L3');
  assert.equal(importFact?.level, 'L4');
  assert.equal(importFact?.gateEvidence, true);
  assert.ok(importFact?.semantics.includes('freshness-policy'));

  const dispatch = source('handlers/story-dispatch.ts');
  assert.match(dispatch, /do not launch raw `bash \+ codex\/claude\/agy`/);
  assert.match(dispatch, /"managedReview":true/);
  assert.match(dispatch, /"waitMs":30000/);
  assert.match(dispatch, /managed_review_evidence_import/);
  assert.ok(dispatch.includes("host_run_status \\'{"), 'status JSON example must be shell-single-quoted in emitted dispatch guidance');
  assert.ok(dispatch.includes("managed_review_evidence_import \\'{"), 'import JSON example must be shell-single-quoted in emitted dispatch guidance');

  const usageDoc = document('docs/host-run-usage.md');
  const decisionDoc = document('docs/requirements/decisions/managed-cross-provider-cli-execution.md');
  const ownershipDoc = document('docs/requirements/decisions/session-ownership-and-write-leases.md');
  for (const text of [usageDoc, decisionDoc]) {
    assert.match(text, /silence/i);
    assert.match(text, /30 seconds|30-second|30000/);
    assert.match(text, /native.*subagent/i);
    assert.match(text, /managed_review_evidence_import/);
    assert.match(text, /same-UID/i);
  }
  // B-137a: assert the path the runtime actually writes. This pinned
  // `.lattice/runtime/provider-process-slots/`, but provider-process-registry.ts
  // joins PROOF_OR_STOP_DIR, so the assertion required the usage doc to keep
  // sending operators to a directory nothing creates -- it would have failed
  // the F-260 doc-drift repair rather than catching a regression.
  assert.match(usageDoc, /\.proof-or-stop\/runtime\/provider-process-slots\//);
  assert.doesNotMatch(usageDoc, /\.lattice\/usage\/host-run-slots\//);
  for (const text of [usageDoc, decisionDoc, ownershipDoc]) {
    assert.match(text, /replacementSafe=true/);
    assert.match(text, /processCleanup\.reaped=true/);
    assert.match(text, /processCleanup\.residualProcessGroup=false/);
  }
  assert.match(usageDoc, /bounded host transcript \(at most 8 MiB per managed run\)/);
  assert.match(usageDoc, /projection is explicitly[\s\S]*truncated/);
  assert.doesNotMatch(usageDoc, /the full host transcript is delivered live/);
  assert.match(
    decisionDoc,
    /formal\s+`managed_reviewer`[\s\S]*creates no durable `input\.cap` private-key[\s\S]*inherited descriptor\s+FD/i,
    'the managed-reviewer proposal key must remain descriptor-only, not be documented as a one-shot capability file',
  );
  assert.doesNotMatch(decisionDoc, /input\.capability/,
    'the durable capability artifact is input.cap, never input.capability');
  assert.match(usageDoc, /canonical \*\*primary\s+worktree\*\*[\s\S]*durable runtime\/audit root/i,
    'managed-review runtime artifacts must remain under the registry-resolved primary worktree after a Story worktree is removed');
  assert.doesNotMatch(usageDoc, /canonical Story worktree remains the durable audit root/i);
  for (const text of [usageDoc, decisionDoc]) {
    assert.match(text, /`adapter_only`[\s\S]*caller owns admission/i);
    assert.match(text, /`readiness_probe`[\s\S]*(?:inspection|verification)[\s\S]*(?:Git\/process|provenance|evidence|lint)/i,
      'readiness_probe documentation must cover the verified non-provider inspection inventory');
  }
  assert.match(
    decisionDoc,
    // B-137a: same canonical-path correction as the slots assertion above --
    // host-run.ts joins PROOF_OR_STOP_DIR for the prompt directory.
    /Only Claude launches with[\s\S]*`launchProfile=managed_reviewer`[\s\S]*`\.proof-or-stop\/runtime\/host-run-prompts\//,
    'the cwd-local Claude prompt transport must be scoped to managed reviewers',
  );
  assert.match(
    decisionDoc,
    /Ordinary Claude `host_run` launches retain their OS-temporary prompt[\s\S]*`tmpdir\(\)`/,
    'ordinary Claude host runs must retain their OS-temporary prompt transport',
  );

  const doctorRepairHint = renderManagedHostRunDoctorSection({
    root: repoRoot,
    retentionMs: 86_400_000,
    active: 0,
    terminal: 1,
    corrupt: 0,
    eligibleForGc: 1,
    runs: [],
  }).join('\n');
  assert.match(doctorRepairHint, /proof-or-stop doctor --repair/,
    'managed-run GC recovery must name the shipped proof-or-stop executable');
  assert.doesNotMatch(doctorRepairHint, /\blattice doctor --repair\b/,
    'managed-run GC recovery must not name the retired lattice executable');

  const doctorSection = renderManagedHostRunDoctorSection({
    root: repoRoot,
    retentionMs: 86_400_000,
    active: 1,
    terminal: 0,
    corrupt: 0,
    eligibleForGc: 0,
    runs: [{
      runId: 'B-proof-doctor-run',
      state: 'running',
      workerLiveness: 'alive',
      workerHeartbeatAt: '2026-08-14T00:00:00.000Z',
      workerHeartbeatAgeMs: 1_000,
      providerProgressMode: 'unobservable',
      lastProviderProgressAt: null,
      providerProgressAgeMs: null,
      deadlineAt: '2026-08-14T00:12:00.000Z',
      deadlineExpired: false,
      cancelRequestedAt: null,
      replacementSafe: false,
      residualProcessGroup: true,
      terminalAt: null,
      terminalReason: null,
      retentionEligibleAt: null,
      retentionExpired: false,
      hasUnconsumedOneShotInputs: false,
      managedReviewScratchCleanupDiagnostic: null,
      error: null,
    }],
  }).join('\n');
  assert.match(doctorSection, /Managed host runs:/);
  assert.match(doctorSection, /worker=alive/);
  assert.match(doctorSection, /providerProgress=unobservable:none/);
  assert.match(doctorSection, /deadlineAt=2026-08-14T00:12:00\.000Z/);
  assert.match(doctorSection, /residual=true replacementSafe=false/);
  console.log('✓ CHK-007:happy:1 pinned proof command executes the actual managed-run doctor renderer');

  assertProviderExecutionInventoryContract(srcRoot);
  assert.equal(CLAUDE_CLI_DEFAULT_TIMEOUT_MS, 600_000, 'the existing bounded Claude provider timeout remains protected');
  assert.equal(CROSS_HOST_REVIEW_DEFAULT_TIMEOUT_MINUTES, 12, 'the existing cross-host default remains protected');
  assert.equal(boundedCrossHostReviewTimeoutMinutes(undefined, 60), 12);
  assert.equal(boundedCrossHostReviewTimeoutMinutes(20, 3), 3, 'policy can tighten but never widen cross-host runtime');
  assert.throws(() => boundedCrossHostReviewTimeoutMinutes(12, Number.NaN), /valid maxRuntimeMinutes ceiling/);
  console.log('✓ CHK-007:edge:2 pinned proof command scans the complete provider inventory and protected timeout ceilings');

  console.log('proof-admissibility-registry-smoke PASS');
}

main();
