import { withGitTreeObservation } from '../core/git-tree-observation.js';
import { withValidationSigningRoot } from '../core/validation-signing-context.js';
import { runScopeGateAndDiffPack } from './scope-contract.js';
import { checklistHasFileDeclarations } from './phase-gates.js';
import { assertCurrentValidationPublicationOwner } from '../core/validation-execution-lock.js';
import { rethrowIntentAmendmentIntegrityError } from '../core/verification-intent-amendment.js';
/**
 * @task B-9cec
 * @checklist CHK-001
 * @title validation no-entry warn/skip policy
 * @type bugfix
 * @priority high
 * @description
 *   Back-link docs/requirements/decisions/testing-infra.md:38 to the verifier
 *   implementation: when no validate.ts/js/mts exists, no configured
 *   validate.command(s) exist, and no fallback command can be discovered, Proof-or-Stop
 *   returns warn/skip instead of failure. Projects needing strong validation
 *   gates must configure validate.command(s).
 * @changes
 *   - [CHK-001] Bind no-validator warn/skip requirement to verifier implementation
 *   - [CHK-002] Cover no-entry warn/skip and configured-command hard-fail behavior
 *
 * Verifier handlers — proof-or-stop validate / status / serve
 *
 * These commands prefer the project's validate.ts file when present (D/M/F verifier
 * pattern), then fall back to configured or auto-discovered language test commands.
 *
 * proof-or-stop validate   → validate.ts/js/mts or configured/discovered project tests
 * proof-or-stop status     → spawn `npx tsx validate.ts --status` in project root
 * proof-or-stop serve      → spawn `npx tsx serve.ts` or start falcon serve in project root
 */

import { execFileSync, execSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HandlerContext } from './context.js';
import { assertCwdInWorktree } from './context.js';
import { commitValidationReuseMetadataTransaction, rollbackValidationPublication } from '../core/auto-commit-metadata.js';
import { loadConfig } from '../core/config.js';
import { CONFIG_FILENAMES } from '../core/brand-paths.js';
import type { ValidationCommand, ValidationProgressReporter } from '../core/validation-types.js';
import { validateResourceClaims, type ResourceClaim } from '../core/keyed-scheduler.js';
import type { RoutineValidationIdentity, RoutineValidationSourceKind, ValidationCommandResult } from '../core/validation-types.js';
import {
  VALIDATION_EVIDENCE_BOUND_BYTES,
  boundPersistedValidationEvidence,
  executeValidationPlan,
  formatValidationEvidenceAdvisory,
  formatValidationProgressEvent,
  formatWorktreePollutionDetails,
  DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS,
  runValidationCommand,
  stripAnsi,
} from '../core/validation-executor.js';
import { declaredValidationCapacity, withOfficialValidationExecution } from '../core/validation-execution-lock.js';
import {
  isOfficialHeavyValidateInvocation,
  refuseHeavyCertificationUnlessAdmitted,
} from '../core/certification-window.js';
import { currentCertificationIdentity } from './certification-window.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { runChannelGateCli } from './validate-channel.js';
import { runConceptGateCli } from './validate-concept.js';
import { runLintGateCli, resolveChangedFiles } from './validate-lint.js';
import { buildVerificationCoverage, renderVerificationCoverage, detectLegacyEvidenceWithoutIntent, VERIFICATION_INTENT_REPAIR_COMMAND } from '../core/verification.js';
import { createVerificationEvidenceGateEvaluator } from '../core/proof-admissibility.js';
import { isCanonicalGitHeadHash, captureEvidenceHashSnapshot, checkEvidenceFreshnessForGit, checkEvidenceHashSnapshotReuse, currentMaterialHash, currentStoryFilesHash, isMaterialExcludedPath } from '../core/evidence-freshness.js';
import { syncClusterResolves } from '../core/cluster-sync.js';
import { createAuthoritativeFindingMutation } from './finding-ledger.js';
import { resolveGitCwd, resolveProjectGitRoot, evaluateStoryDirConfigInsideGitRoot } from '../core/story-signed-workspace-resolution.js';
import { resolveVerificationIntentPolicy, resolveWorkflowPolicy } from '../core/workflow-policy.js';
import type { ChecklistData, ChecklistItem, ScopeContractData, StoryInfo, TestEvidenceData, VerificationEvidence, VerificationIntentItem } from '../core/types.js';
import {
  buildRoutineValidationIdentity,
  evaluateRoutineValidationReuse,
  isCompleteRoutineValidationIdentity,
  summarizeRoutineCommandExecution,
  type RoutineValidationReuseEvaluation,
} from '../core/validation-evidence-reuse.js';
import {
  captureDonePrepareGeneratedMetadataTransaction,
} from '../core/done-prepare-generated-metadata.js';
import {
  VALIDATION_COMMAND_SHELL_META_RE,
  assertDeclaredValidationCommandId,
  parseLegacyValidationCommandString,
} from '../core/validation-command-identity.js';
import { normalizeRelPath } from '../core/proof-or-stop-paths.js';
import { readBrandEnv } from '../core/brand-env.js';
import { getSessionId } from '../core/owner-session.js';
import { acquireOrRefreshOwnerLease, isLeaseStale, readOwnerLease } from '../core/story-owner-lease.js';
import {
  CAUSAL_MAX_OUTPUT_CHARS,
  CAUSAL_RECEIPT_DIRECTORY,
  DEFAULT_CAUSAL_SELECTOR_POLICY,
  causalCanonical,
  effectiveCausalEnvironment,
  preflightCausalEvidence,
  resolveCausalToolVersion,
  verifyCausalPreflight,
  type CausalPreflightFacts,
} from '../core/causal-evidence.js';
import { appendReceiptRevocation, createValidationClosureCertificate, resolveDynamicMode, runObserveOracle, stableDigest, verifyValidationClosureCertificate, type DynamicValidationMode, type ValidationSelectionManifest, type ValidationCatalogEntry } from '../core/story-aware-validation.js';
import { persistCanonicalFullBaseline, persistStoryAwareValidationArtifacts, prepareStoryAwareValidation, readStoryAwareValidationArtifacts, readRoutineReuseRevocationBasis, runStoryAwareDynamicValidation, runtimeTraceForResult } from './story-aware-validation.js';

const STATUS_FALLBACK_TIMEOUT_MS = 10_000;
// B-a745 CHK-002: the shell-metacharacter rule and the word splitter now live in
// core/validation-command-identity.ts so the legacy pin resolver compares evidence
// strings under EXACTLY this parse. Extraction only - the behaviour below is
// unchanged, including the non-shell branch omitting `shell` entirely.
const SHELL_META_RE = VALIDATION_COMMAND_SHELL_META_RE;

export interface ValidationSetupScan {
  validateFiles: Array<{ name: string; present: boolean }>;
  validateFile: string | null;
  configuredCommands: ValidationCommand[];
  fallbackCommands: ValidationCommand[];
  discoveredFallbackLabels: string[];
  noValidatorWarning: boolean;
  configuredShellStyleCommands: Array<{
    label: string;
    command: string;
    shell: boolean;
    intentionalShellReceipt: boolean;
    source: 'string' | 'object';
  }>;
  configuredShellReceiptsIntentional: boolean;
  warnings: string[];
}

export function findValidateFile(projectRoot: string): string | null {
  const candidates = ['validate.ts', 'validate.js', 'validate.mts'];
  for (const f of candidates) {
    if (existsSync(join(projectRoot, f))) return f;
  }
  return null;
}

/** Read-only projection of the existing transition scope policy, never PASS evidence. */
export function validationScopePrerequisite(ctx: HandlerContext, storyId: string, gitCwd: string): string | undefined {
  if (!['REVIEW', 'TEST', 'DONE'].includes(ctx.store.readStory(storyId).phase)) return undefined;
  let gate: ReturnType<typeof runScopeGateAndDiffPack>;
  try { gate = runScopeGateAndDiffPack(storyId, ctx.store, ctx.root, gitCwd); }
  catch (error) { return `[scope_contract_unreadable] ${String(error)}`; }
  if (!gate.result) {
    let checklist: ChecklistData | null = null;
    try { checklist = ctx.store.readChecklist(storyId); }
    catch (error) { rethrowIntentAmendmentIntegrityError(error); /* Match legacy transition behavior. */ }
    return checklistHasFileDeclarations(checklist)
      ? '[missing_scope_contract] Prepare the declared scope contract before routine validation'
      : undefined;
  }
  return gate.result.status === 'fail' ? `[scope_contract_failed] ${gate.result.summary}` : undefined;
}

/** Resolve Story-owned selection inputs instead of allowing an empty authority context. */
function storyDynamicInputs(ctx: HandlerContext, storyId: string): {
  scopeContract?: { allowedPaths?: string[]; plannedFiles?: string[]; protectedFiles?: string[]; explicitExcludes?: string[]; digest?: string };
  verificationIntents?: Array<{ id: string; validationCommand?: string }>;
  affectedProcessFacts?: string[];
  affectedCapabilities?: string[];
} {
  const story: StoryInfo = ctx.store.readStory(storyId);
  const checklist = ctx.store.readChecklist(storyId);
  const scope: ScopeContractData | null = ctx.store.readScopeContract(storyId);
  const lanes = ['happy', 'edge', 'adversarial'] as const;
  const plannedFiles = checklist.items.flatMap((item) => [
    ...(item.files?.modify || []),
    ...(item.files?.create || []),
    ...(item.files?.test || []),
  ]);
  const verificationIntents: Array<{ id: string; validationCommand?: string }> = checklist.items.flatMap((item: ChecklistItem): Array<{ id: string; validationCommand?: string }> => {
    const intent = item.verificationIntent;
    if (!intent) return [];
    return lanes.flatMap((lane): Array<{ id: string; validationCommand?: string }> => (intent[lane] || [])
      .flatMap((entry: VerificationIntentItem, index: number) => entry.verification?.command
        ? [{ id: `${item.id}:${lane}:${index}`, validationCommand: entry.verification.command }]
        : []));
  });
  const affectedProcessFacts: string[] = checklist.items.flatMap((item: ChecklistItem): string[] => {
    const intent = item.verificationIntent;
    if (!intent) return [];
    return lanes.flatMap((lane): string[] => (intent[lane] || []).flatMap((entry: VerificationIntentItem): string[] =>
      (entry.plannedPathDeclarations || []).flatMap((declaration) => [declaration.producer, ...declaration.consumers]
        .filter((endpoint) => endpoint.expectedArtifactKind === 'process_fact')
        .map((endpoint) => endpoint.expectedSymbolOrFact)
        .filter((fact): fact is string => typeof fact === 'string' && fact.length > 0))));
  });
  const affectedCapabilities: string[] = (story.affectedCapabilities || []).filter((value): value is string => typeof value === 'string' && value.length > 0);
  return {
    scopeContract: scope ? {
      allowedPaths: [...(scope.allowedModify || []), ...(scope.allowedCreate || []), ...(scope.allowedTest || [])],
      plannedFiles,
      protectedFiles: scope.protectedFiles || [],
      explicitExcludes: scope.explicitExcludes || [],
      digest: stableDigest(scope),
    } : (plannedFiles.length > 0 ? { plannedFiles } : undefined),
    verificationIntents,
    affectedProcessFacts: [...new Set(affectedProcessFacts)],
    affectedCapabilities: [...new Set(affectedCapabilities)],
  };
}

function hasAny(projectRoot: string, paths: string[]): boolean {
  return paths.some(p => existsSync(join(projectRoot, p)));
}

function hasDirectoryEntry(projectRoot: string, dir: string, suffixes: string[]): boolean {
  const abs = join(projectRoot, dir);
  if (!existsSync(abs)) return false;
  try {
    return readdirSync(abs).some(entry => suffixes.some(s => entry.endsWith(s)));
  } catch {
    return false;
  }
}

function commandFromString(label: string, value: string): ValidationCommand | null {
  const parsed = parseLegacyValidationCommandString(value);
  if (!parsed) return null;
  return parsed.shell
    ? { label, command: parsed.command, args: [], shell: true }
    : { label, command: parsed.command, args: parsed.args };
}

/**
 * Parse `validate.commands[].resources` from config into resource claims.
 *
 * Malformed or unrecognised claims THROW here, at declaration time, so a typo'd
 * class fails the whole validate run loudly instead of being dropped and
 * quietly turning into a command with no declared claim. (The fail-closed
 * default in resolveValidationCommandResources would still schedule such a
 * command alone, but a silently ignored declaration is a lie the operator
 * cannot see.)
 */
function parseConfiguredResourceClaims(value: unknown, owner: string): ResourceClaim[] {
  if (!Array.isArray(value)) {
    throw new Error(`${owner}: resources must be an array of resource claims`);
  }
  const claims = value.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${owner}: every resource claim must be an object with class, key and access`);
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry.class !== 'string' || typeof entry.key !== 'string' || typeof entry.access !== 'string') {
      throw new Error(`${owner}: every resource claim must be an object with class, key and access`);
    }
    return {
      class: entry.class as ResourceClaim['class'],
      key: entry.key,
      access: entry.access as ResourceClaim['access'],
      ...(entry.ownership !== undefined ? { ownership: entry.ownership as ResourceClaim['ownership'] } : {}),
    };
  });
  validateResourceClaims(claims, owner);
  return claims;
}

function normalizeValidateFocus(value: unknown): string[] | undefined {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const focus = [...new Set(raw.map((v) => String(v).trim()).filter(Boolean))];
  return focus.length > 0 ? focus : undefined;
}

function normalizeFocusArg(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const focus = String(value).trim();
  if (!focus) {
    throw new Error('validate --focus requires a non-empty focus name');
  }
  if (!/^[A-Za-z0-9._-]+$/.test(focus)) {
    throw new Error('validate --focus accepts only letters, numbers, dot, underscore, or hyphen');
  }
  return focus;
}

function focusedModeNotice(focus: string): string {
  return `FOCUSED VALIDATE MODE focus=${focus}: not final full validation and not DONE-required proof.`;
}

function filterFocusedConfiguredCommands(commands: ValidationCommand[], focus: string): ValidationCommand[] {
  const selected = commands.filter((cmd) => cmd.focus?.includes(focus));
  if (selected.length === 0) {
    throw new Error(
      `validate --focus=${focus}: no configured validate.commands are tagged with focus "${focus}"; ` +
      `tag one or more commands with focus: ["${focus}"] or run proof-or-stop validate --json for full validation.`,
    );
  }
  return selected;
}

function markFocusedResult(result: any, focus: string): any {
  if (!focus) return result;
  const provider = String(result.provider ?? 'proof-or-stop-verifier');
  const focusedProvider = provider.endsWith('-focused') ? provider : `${provider}-focused`;
  const summary = String(result.summary ?? 'Validation completed');
  const details = Array.isArray(result.details) ? result.details : [];
  return {
    ...result,
    provider: focusedProvider,
    summary: summary.startsWith(`Focused validation (${focus}):`)
      ? summary
      : `Focused validation (${focus}): ${summary}; not final full validation or DONE-required proof`,
    details: details[0] === focusedModeNotice(focus)
      ? details
      : [focusedModeNotice(focus), ...details],
    focus: {
      name: focus,
      mode: 'focused',
      finalFullValidation: false,
      doneRequiredProof: false,
    },
  };
}

function maybePrefixFocusedText(output: string, focus: string | undefined): string {
  if (!focus) return output;
  return `${focusedModeNotice(focus)}\n${output}`;
}

export function configuredValidationCommands(projectRoot: string): ValidationCommand[] {
  const cfg = loadConfig(projectRoot) as any;
  const validate = cfg.validate || cfg.validation;
  const commands: ValidationCommand[] = [];
  if (!validate || typeof validate !== 'object') return commands;
  const dynamicDefaults = validate.dynamic?.policyDefaults && typeof validate.dynamic.policyDefaults === 'object'
    ? validate.dynamic.policyDefaults : {};
  const applyDynamicDefaults = (command: ValidationCommand): ValidationCommand => ({
    ...command,
    ...(command.assurance !== undefined ? {} : typeof dynamicDefaults.assurance === 'string' ? { assurance: dynamicDefaults.assurance } : {}),
    ...(command.riskTier !== undefined ? {} : typeof dynamicDefaults.riskTier === 'string' ? { riskTier: dynamicDefaults.riskTier } : {}),
    ...(command.closurePolicy !== undefined ? {} : typeof dynamicDefaults.closurePolicy === 'string' ? { closurePolicy: dynamicDefaults.closurePolicy } : {}),
    ...(command.fullBaselineReusePolicy !== undefined ? {} : typeof dynamicDefaults.fullBaselineReusePolicy === 'string' ? { fullBaselineReusePolicy: dynamicDefaults.fullBaselineReusePolicy } : {}),
    ...(command.cpuWeight !== undefined ? {} : typeof dynamicDefaults.cpuWeight === 'number' ? { cpuWeight: dynamicDefaults.cpuWeight } : {}),
    ...(command.expectedP50Ms !== undefined ? {} : typeof dynamicDefaults.expectedP50Ms === 'number' ? { expectedP50Ms: dynamicDefaults.expectedP50Ms } : {}),
  });

  if (typeof validate.command === 'string') {
    const cmd = commandFromString('configured validate.command', validate.command);
    if (cmd) commands.push(applyDynamicDefaults(cmd));
  }
  if (Array.isArray(validate.commands)) {
    for (let i = 0; i < validate.commands.length; i++) {
      const entry = validate.commands[i];
      if (typeof entry === 'string') {
        const cmd = commandFromString(`configured validate.commands[${i}]`, entry);
        if (cmd) commands.push(applyDynamicDefaults(cmd));
      } else if (entry && typeof entry === 'object' && typeof entry.command === 'string') {
        const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
        const focus = normalizeValidateFocus(entry.focus);
        commands.push({
          label: typeof entry.label === 'string' ? entry.label : `configured validate.commands[${i}]`,
          command: entry.command,
          args,
          ...(entry.shell === true ? { shell: true } : {}),
          ...(entry.executionReuse === 'exact-inputs' ? {executionReuse:'exact-inputs' as const} : {}),
          ...(Array.isArray(entry.executionInputs) ? {executionInputs:entry.executionInputs} : {}),
          ...(typeof entry.cwd === 'string' ? { cwd: entry.cwd } : {}),
          ...(entry.env && typeof entry.env === 'object' ? { env: Object.fromEntries(Object.entries(entry.env).map(([k, v]) => [k, String(v)])) } : {}),
          ...(Array.isArray(entry.declaredEnvironmentKeys) ? { declaredEnvironmentKeys: entry.declaredEnvironmentKeys.filter((item: unknown): item is string => typeof item === 'string') } : {}),
          ...(typeof entry.caseRegistryPath === 'string' ? { caseRegistryPath: entry.caseRegistryPath } : {}),
          ...(typeof entry.runnerSourcePath === 'string' ? { runnerSourcePath: entry.runnerSourcePath } : {}),
          ...(typeof entry.assurance === 'string' ? { assurance: entry.assurance } : typeof dynamicDefaults.assurance === 'string' ? { assurance: dynamicDefaults.assurance } : {}),
          ...(typeof entry.riskTier === 'string' ? { riskTier: entry.riskTier } : typeof dynamicDefaults.riskTier === 'string' ? { riskTier: dynamicDefaults.riskTier } : {}),
          ...(typeof entry.closurePolicy === 'string' ? { closurePolicy: entry.closurePolicy } : typeof dynamicDefaults.closurePolicy === 'string' ? { closurePolicy: dynamicDefaults.closurePolicy } : {}),
          ...(typeof entry.fullBaselineReusePolicy === 'string' ? { fullBaselineReusePolicy: entry.fullBaselineReusePolicy } : typeof dynamicDefaults.fullBaselineReusePolicy === 'string' ? { fullBaselineReusePolicy: dynamicDefaults.fullBaselineReusePolicy } : {}),
          ...(typeof entry.cpuWeight === 'number' ? { cpuWeight: entry.cpuWeight } : typeof dynamicDefaults.cpuWeight === 'number' ? { cpuWeight: dynamicDefaults.cpuWeight } : {}),
          ...(typeof entry.expectedP50Ms === 'number' ? { expectedP50Ms: entry.expectedP50Ms } : typeof dynamicDefaults.expectedP50Ms === 'number' ? { expectedP50Ms: dynamicDefaults.expectedP50Ms } : {}),
          ...(typeof entry.timeoutMs === 'number' ? { timeoutMs: entry.timeoutMs } : {}),
          ...(typeof entry.optional === 'boolean' ? { optional: entry.optional } : {}),
          ...(focus ? { focus } : {}),
          ...(entry.resources !== undefined
            ? { resources: parseConfiguredResourceClaims(entry.resources, `configured validate.commands[${i}]`) }
            : {}),
          // B-a745 CHK-001: an optional declared planner id. Malformed or
          // reserved-namespace values THROW here, at declaration time, for the
          // same reason parseConfiguredResourceClaims does: a silently dropped
          // declaration is a lie the operator cannot see, and a forged `prov-`
          // id would also corrupt the provisional-migration count.
          ...(entry.id !== undefined
            ? { id: assertDeclaredValidationCommandId(entry.id, `configured validate.commands[${i}]`) }
            : {}),
        });
      }
    }
  }
  return commands;
}

function configuredShellStyleEntries(projectRoot: string): ValidationSetupScan['configuredShellStyleCommands'] {
  const cfg = loadConfig(projectRoot) as any;
  const validate = cfg.validate || cfg.validation;
  const out: ValidationSetupScan['configuredShellStyleCommands'] = [];
  if (!validate || typeof validate !== 'object') return out;

  if (typeof validate.command === 'string' && SHELL_META_RE.test(validate.command.trim())) {
    const cmd = commandFromString('configured validate.command', validate.command);
    out.push({
      label: 'configured validate.command',
      command: validate.command.trim(),
      shell: cmd?.shell === true,
      intentionalShellReceipt: cmd?.shell === true,
      source: 'string',
    });
  }

  if (Array.isArray(validate.commands)) {
    for (let i = 0; i < validate.commands.length; i++) {
      const entry = validate.commands[i];
      if (typeof entry === 'string') {
        if (!SHELL_META_RE.test(entry.trim())) continue;
        const cmd = commandFromString(`configured validate.commands[${i}]`, entry);
        out.push({
          label: `configured validate.commands[${i}]`,
          command: entry.trim(),
          shell: cmd?.shell === true,
          intentionalShellReceipt: cmd?.shell === true,
          source: 'string',
        });
      } else if (entry && typeof entry === 'object' && typeof entry.command === 'string' && SHELL_META_RE.test(entry.command.trim())) {
        const shell = entry.shell === true;
        out.push({
          label: typeof entry.label === 'string' ? entry.label : `configured validate.commands[${i}]`,
          command: entry.command.trim(),
          shell,
          intentionalShellReceipt: shell,
          source: 'object',
        });
      }
    }
  }

  return out;
}

function packageJsonTestCommand(projectRoot: string): ValidationCommand | null {
  const packageJson = join(projectRoot, 'package.json');
  if (!existsSync(packageJson)) return null;
  try {
    const pkg = JSON.parse(readFileSync(packageJson, 'utf-8'));
    const testScript = pkg?.scripts?.test;
    if (typeof testScript === 'string' && testScript.trim() && !/no test specified/i.test(testScript)) {
      return { label: 'package.json test script', command: 'npm', args: ['test'] };
    }
  } catch {
    return null;
  }
  return null;
}

export function discoverFallbackValidationCommands(projectRoot: string): ValidationCommand[] {
  const discovered: ValidationCommand[] = [];
  const npmTest = packageJsonTestCommand(projectRoot);
  if (npmTest) discovered.push(npmTest);

  if (existsSync(join(projectRoot, 'go.mod'))) {
    discovered.push({ label: 'go test', command: 'go', args: ['test', './...'] });
  }
  if (existsSync(join(projectRoot, 'Cargo.toml'))) {
    discovered.push({ label: 'cargo test', command: 'cargo', args: ['test'] });
  }
  // Swift / Package.swift is intentionally NOT included in automatic fallback
  // discovery. The Mac Native App / Swift product runtime has been demoted
  // (see docs/requirements/decisions/testing-infra.md). Projects that still
  // want to run `swift test` must opt in explicitly via validate.command(s).
  if (existsSync(join(projectRoot, 'pom.xml'))) {
    discovered.push({ label: 'maven test', command: 'mvn', args: ['test'] });
  }
  if (hasAny(projectRoot, ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'])) {
    const gradle = existsSync(join(projectRoot, 'gradlew')) ? './gradlew' : 'gradle';
    discovered.push({ label: 'gradle test', command: gradle, args: ['test'] });
  }
  if (
    hasAny(projectRoot, ['pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini']) ||
    hasDirectoryEntry(projectRoot, 'tests', ['.py'])
  ) {
    discovered.push({ label: 'pytest', command: 'python', args: ['-m', 'pytest'] });
  }

  return discovered;
}

export function scanValidationSetup(projectRoot: string): ValidationSetupScan {
  const validateFiles = ['validate.ts', 'validate.js', 'validate.mts'].map((name) => ({
    name,
    present: existsSync(join(projectRoot, name)),
  }));
  const validateFile = validateFiles.find((f) => f.present)?.name ?? null;
  const configuredCommands = configuredValidationCommands(projectRoot);
  const fallbackCommands = discoverFallbackValidationCommands(projectRoot);
  const configuredShellStyleCommands = configuredShellStyleEntries(projectRoot);
  const configuredShellReceiptsIntentional = configuredShellStyleCommands.every((cmd) => cmd.intentionalShellReceipt);
  const noValidatorWarning = !validateFile && configuredCommands.length === 0 && fallbackCommands.length === 0;
  const warnings: string[] = [];

  if (!validateFile && configuredCommands.length === 0 && fallbackCommands.length > 0) {
    warnings.push('validate.ts/js/mts not found; validation will use advisory fallback command discovery');
  }
  if (noValidatorWarning) {
    warnings.push('No validate.ts/js/mts, configured validate.command(s), or fallback validation commands found');
  }
  for (const entry of configuredShellStyleCommands) {
    if (!entry.intentionalShellReceipt) {
      warnings.push(`${entry.label} looks shell-style but is not configured with shell=true`);
    }
  }

  return {
    validateFiles,
    validateFile,
    configuredCommands,
    fallbackCommands,
    discoveredFallbackLabels: fallbackCommands.map((cmd) => cmd.label),
    noValidatorWarning,
    configuredShellStyleCommands,
    configuredShellReceiptsIntentional,
    warnings,
  };
}

/** Run a command and capture stdout+stderr, returning { code, output } */
export async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs?: number,
): Promise<{ code: number; output: string; durationMs: number; timedOut?: boolean }> {
  const result = await runValidationCommand({ label: command, command, args, ...(timeoutMs ? { timeoutMs } : {}) }, cwd);
  return {
    code: result.code,
    output: result.output,
    durationMs: result.durationMs,
    ...(result.timedOut ? { timedOut: true } : {}),
  };
}

// B-75f0 CHK-002: `gitCwd` is the resolved git working dir (resolveGitCwd at the
// caller, which has store+storyId in scope). On a wrapper-root layout it is the
// real gitRoot subdir; on a plain repo it is the projectRoot verbatim. The
// `undefined` fallback on any git failure is preserved (graceful degradation:
// callers treat a missing head as "no head hash", never crash).
function currentHead(gitCwd: string): string | undefined {
  try {
    return execSync('git rev-parse HEAD', { cwd: gitCwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return undefined;
  }
}

function canonicalVerifierProbePath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function probeVerifierWorktree(cwd: string): string | null {
  try {
    const topLevel = execSync('git rev-parse --show-toplevel', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return topLevel ? canonicalVerifierProbePath(topLevel) : null;
  } catch {
    return null;
  }
}

function probeVerifierIndex(cwd: string): { readable: boolean; path?: string; contentDigest?: string; reason?: string } {
  try {
    const rawPath = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'index'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const indexPath = canonicalVerifierProbePath(isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath));
    if (!indexPath) return { readable: false, reason: 'git_index_path_unavailable' };
    if (!statSync(indexPath).isFile()) return { readable: false, path: indexPath, reason: 'git_index_not_a_file' };
    accessSync(indexPath, constants.R_OK);
    const contentDigest = `sha256:${createHash('sha256').update(readFileSync(indexPath)).digest('hex')}`;
    return { readable: true, path: indexPath, contentDigest };
  } catch {
    return { readable: false, reason: 'git_index_unavailable' };
  }
}

function probeVerifierTarget(path: string): { writable: boolean; probe: string; reason?: string } {
  const stableProbe = `access_w:${path}`;
  let probePath = path;
  while (!existsSync(probePath)) {
    const parent = dirname(probePath);
    if (parent === probePath) return { writable: false, probe: stableProbe, reason: 'evidence_target_parent_unavailable' };
    probePath = parent;
  }
  try {
    if (!statSync(probePath).isDirectory()) return { writable: false, probe: stableProbe, reason: 'evidence_target_parent_not_directory' };
    accessSync(probePath, constants.W_OK);
    return { writable: true, probe: stableProbe };
  } catch {
    return { writable: false, probe: stableProbe, reason: 'evidence_target_access_denied' };
  }
}

function probeVerifierCli(): { available: boolean; path?: string; reason?: string } {
  const invoked = process.argv[1];
  if (!invoked) return { available: false, reason: 'cli_invocation_unavailable' };
  const candidate = isAbsolute(invoked) ? invoked : resolve(process.cwd(), invoked);
  const cliPath = canonicalVerifierProbePath(candidate);
  if (!cliPath) return { available: false, reason: `cli_path_unavailable ${candidate}` };
  try {
    if (!statSync(cliPath).isFile()) return { available: false, reason: `cli_not_a_file ${cliPath}` };
    accessSync(cliPath, constants.R_OK);
    return { available: true, path: cliPath };
  } catch {
    return { available: false, reason: `cli_not_readable ${cliPath}` };
  }
}

function probeVerifierLease(storyDir: string, expectedCwd: string): { available: boolean; valid: boolean; reason?: string } {
  const lease = readOwnerLease(storyDir);
  if (!lease) return { available: false, valid: false, reason: 'lease_missing_or_invalid' };
  if (lease.sessionId !== getSessionId()) return { available: true, valid: false, reason: `lease_foreign_session expected=${getSessionId()} actual=${lease.sessionId}` };
  if (isLeaseStale(lease)) return { available: true, valid: false, reason: 'lease_stale' };
  const leaseCwd = canonicalVerifierProbePath(lease.cwd);
  const actualCwd = canonicalVerifierProbePath(expectedCwd);
  if (!leaseCwd || !actualCwd || leaseCwd !== actualCwd) {
    return { available: true, valid: false, reason: `lease_cwd_mismatch expected=${actualCwd ?? expectedCwd} actual=${leaseCwd ?? lease.cwd}` };
  }
  return { available: true, valid: true };
}

export function probeValidationCausalPreflightFacts(
  ctx: HandlerContext,
  storyId: string,
  input: { command: string; cwd: string; timeoutMs?: number },
): CausalPreflightFacts {
  if (ctx.causalPreflightFacts) return ctx.causalPreflightFacts(input);
  const cli = probeVerifierCli();
  const expectedWorktree = canonicalVerifierProbePath(input.cwd) ?? input.cwd;
  const actualWorktree = probeVerifierWorktree(input.cwd);
  const headHash = currentHead(input.cwd);
  const { materialHash, storyFilesHash } = withGitTreeObservation(() => {
    const ref = isCanonicalGitHeadHash(headHash) ? headHash as string : 'HEAD';
    return {
      materialHash: currentMaterialHash(input.cwd, ref, ctx.root),
      storyFilesHash: currentStoryFilesHash(input.cwd, ref, ctx.root),
    };
  });
  const gitMaterialAvailable = Boolean(headHash && materialHash && storyFilesHash);
  const gitIndex = probeVerifierIndex(input.cwd);
  const storyDir = ctx.store.storyDirPath(storyId);
  const targetPath = join(storyDir, CAUSAL_RECEIPT_DIRECTORY);
  const target = probeVerifierTarget(targetPath);
  const timeoutMs = input.timeoutMs ?? DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS;
  const timeoutAvailable = Number.isFinite(timeoutMs) && timeoutMs > 0;
  return {
    cli,
    worktree: actualWorktree
      ? { expected: expectedWorktree, actual: actualWorktree }
      : { expected: expectedWorktree, actual: '', reason: 'worktree_unavailable' },
    gitIndex,
    gitMaterial: {
      available: gitMaterialAvailable,
      ...(headHash ? { headHash } : {}),
      ...(materialHash ? { materialHash } : {}),
      ...(storyFilesHash ? { storyFilesHash } : {}),
      ...(gitMaterialAvailable ? {} : { reason: 'git_material_or_story_files_hash_unavailable' }),
    },
    writerLease: probeVerifierLease(storyDir, input.cwd),
    providerCapability: {
      required: ['validation-plan', 'bounded-output'],
      available: ['validation-plan', ...(CAUSAL_MAX_OUTPUT_CHARS > 0 ? ['bounded-output'] : [])],
    },
    resources: {
      required: { timeoutMs },
      available: { timeoutMs: timeoutAvailable ? timeoutMs : 0 },
      ...(timeoutAvailable ? {} : { reason: 'timeout_resource_unavailable' }),
    },
    evidenceTarget: {
      writable: target.writable,
      path: targetPath,
      probe: target.probe,
      ...(target.reason ? { reason: target.reason } : {}),
    },
    sideChannel: { available: CAUSAL_MAX_OUTPUT_CHARS > 0, maxOutputChars: CAUSAL_MAX_OUTPUT_CHARS, maxProgressEvents: 1 },
  };
}

export function createValidationCausalPreflightGate(
  ctx: HandlerContext,
  storyId: string,
  commands: ValidationCommand[],
  cwd: string,
): { beforeLaunch: () => void } {
  const validationPlan = commands.map(entry => ({
    label: entry.label,
    executable: entry.command,
    args: [...entry.args],
    shell: entry.shell === true,
    cwd: entry.cwd ?? cwd,
    env: { ...(entry.env ?? {}) },
    timeoutMs: entry.timeoutMs ?? DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS,
    optional: entry.optional === true,
    focus: [...(entry.focus ?? [])],
    resources: [...(entry.resources ?? [])],
  }));
  // Keep the preflight probe's legacy string field, but make it a canonical
  // serialization of the complete validation plan. Concatenating args loses
  // boundaries and execution semantics (cwd/env/shell/resources/timeouts).
  const command = causalCanonical(validationPlan);
  const timeoutMs = Math.max(
    DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS,
    ...commands.map(entry => entry.timeoutMs ?? DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS),
  );
  const input = { command, cwd, timeoutMs };
  const initialFacts = probeValidationCausalPreflightFacts(ctx, storyId, input);
  let latestFacts = initialFacts;
  const factsUnchanged = () => {
    latestFacts = probeValidationCausalPreflightFacts(ctx, storyId, input);
    return causalCanonical(latestFacts) === causalCanonical(initialFacts);
  };
  const changedFactFields = (before: unknown, after: unknown, path = ''): string[] => {
    if (causalCanonical(before) === causalCanonical(after)) return [];
    if (before && after && typeof before === 'object' && typeof after === 'object'
      && !Array.isArray(before) && !Array.isArray(after)) {
      const left = before as Record<string, unknown>;
      const right = after as Record<string, unknown>;
      return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort().flatMap(key => {
        const field = path ? `${path}.${key}` : key;
        return Object.prototype.hasOwnProperty.call(left, key) !== Object.prototype.hasOwnProperty.call(right, key)
          ? [field] : changedFactFields(left[key], right[key], field);
      });
    }
    return [path || 'snapshot'];
  };
  const storyDir = ctx.store.storyDirPath(storyId);
  let leaseFailureReason = 'lease_refresh_not_refreshed';
  const refreshSameOwnerLease = () => {
    const lease = readOwnerLease(storyDir);
    if (!lease) { leaseFailureReason = 'lease_missing_or_invalid'; return false; }
    if (lease.sessionId !== getSessionId()) { leaseFailureReason = 'lease_foreign_session'; return false; }
    leaseFailureReason = 'lease_refresh_not_refreshed';
    return acquireOrRefreshOwnerLease(storyDir, { command: 'validate', cwd }).action === 'refreshed';
  };
  const identity = {
    storyId,
    cwd,
    command,
    bootstrap: { executable: 'proof-or-stop', args: ['validate'] },
    inputs: {
      storyId,
      materialHash: initialFacts.gitMaterial?.materialHash ?? null,
      timeoutMs,
      validationPlan,
      preflightFacts: initialFacts,
    },
    storyFilesHash: initialFacts.gitMaterial?.storyFilesHash,
    effectiveEnvironment: effectiveCausalEnvironment(undefined, cwd),
    runtimeVersion: process.version,
    toolVersion: resolveCausalToolVersion(ctx.root),
    selectorPolicy: DEFAULT_CAUSAL_SELECTOR_POLICY,
  };
  const report = preflightCausalEvidence(initialFacts, factsUnchanged, identity);
  if (!report.ready || !verifyCausalPreflight(report, identity)) {
    throw new Error(`validate preflight REFUSED: ${report.failedChecks.join(', ') || 'invalid_preflight'} commandExecutions=0 evidenceWrites=0 [causal_preflight_refused]`);
  }
  return {
    beforeLaunch: () => {
      // Validation can spend many minutes between the CLI owner gate and a
      // later scheduler launch. Keep this session's lease alive at each child
      // boundary, while refusing missing/foreign leases rather than acquiring
      // ownership as a side effect of causal preflight.
      const refuse = (reason: string): never => {
        throw new Error(`validate preflight refused: state_changed_before_launch reason=${reason} commandExecutions=0 evidenceWrites=0 [causal_preflight_refused]`);
      };
      if (!refreshSameOwnerLease()) refuse(leaseFailureReason);
      if (!verifyCausalPreflight(report, identity)) refuse('preflight_verification_failed');
      if (!factsUnchanged()) {
        // Diagnose the exact already-compared snapshots, without another probe
        // or values that could disclose a key, environment, path, or identity.
        const fields = changedFactFields(JSON.parse(causalCanonical(initialFacts)), JSON.parse(causalCanonical(latestFacts)));
        refuse(`facts_changed changedFields=${fields.join(',')}`);
      }
    },
  };
}

function evidenceFreshness(gitCwd: string, metadataRoot: string, headHash: string, evidence?: VerificationEvidence) {
  return checkEvidenceFreshnessForGit(gitCwd, headHash, evidence?.materialHash, metadataRoot, evidence?.storyFilesHash);
}

function collectStoryFilesHashAdvisories(cl: ChecklistData, gitCwd: string, metadataRoot: string): string[] {
  const advisories: string[] = [];
  for (const item of cl.items) {
    for (const evidence of item.verificationEvidence || []) {
      if (!evidence.headHash) continue;
      const freshness = evidenceFreshness(gitCwd, metadataRoot, evidence.headHash, evidence);
      if (!freshness.fresh || !freshness.warnings?.length) continue;
      for (const warning of freshness.warnings) {
        advisories.push(`Re-attestation advisory: ${item.id} ${evidence.intentRef}: ${warning}`);
      }
    }
  }
  return [...new Set(advisories)];
}

function decorateStoryVerification(ctx: HandlerContext, storyId: string, result: any): any {
  let coverage;
  let verificationPolicy;
  let legacyHints: Array<{ itemId: string; lane: string; intentRef: string }> = [];
  try {
    const story = ctx.store.readStory(storyId);
    const cl = ctx.store.readChecklist(storyId);
    legacyHints = cl.items.flatMap(detectLegacyEvidenceWithoutIntent);
    let decision = null;
    try { decision = ctx.store.readDecision(storyId); } catch { /* no decision for express/fast stories */ }
    verificationPolicy = resolveVerificationIntentPolicy(story, cl, decision);
    const effectivePolicy = resolveWorkflowPolicy(loadConfig(ctx.root), story);
    const gitCwd = resolveGitCwd({ store: ctx.store, storyId, metadataRoot: ctx.root, projectRoot: ctx.root });
    const head = currentHead(gitCwd);
    coverage = buildVerificationCoverage(
      cl,
      head,
      (headHash, evidence) => evidenceFreshness(gitCwd, ctx.root, headHash, evidence).fresh,
      {
        deferredGateEvidence: 'missing',
        evidenceQualityProfile: effectivePolicy.profile,
        receiptAdmissibility: createVerificationEvidenceGateEvaluator(ctx.root, storyId),
      },
    );
  } catch (intentIntegrityError) { rethrowIntentAmendmentIntegrityError(intentIntegrityError);
    return result;
  }
  const rendered = renderVerificationCoverage(coverage, verificationPolicy);
  const details = Array.isArray(result.details) ? [...result.details] : [];
  details.push(...rendered.split('\n'));
  details.push(...collectStoryFilesHashAdvisories(ctx.store.readChecklist(storyId), resolveGitCwd({ store: ctx.store, storyId, metadataRoot: ctx.root, projectRoot: ctx.root }), ctx.root));
  // B-4e06 CHK-002: surface legacy evidence-without-intent as an informational
  // hint naming the repair command. Additive only — never alters coverage math
  // or allPass, so the hint can never become a pass condition.
  for (const h of legacyHints) {
    details.push(`Legacy evidence without intent: ${h.itemId} ${h.lane} has verificationEvidence (${h.intentRef}) but no verificationIntent.${h.lane} — run \`proof-or-stop ${VERIFICATION_INTENT_REPAIR_COMMAND}\` to backfill the intent (this is a schema repair, NOT a coverage pass).`);
  }
  const allPass = Boolean(result.allPass) && coverage.missingRequired === 0;
  return {
    ...result,
    status: allPass ? (result.status === 'warn' ? 'warn' : 'pass') : 'fail',
    allPass,
    summary: coverage.missingRequired > 0
      ? `${result.summary || 'Validation'}; verification coverage missing ${coverage.missingRequired} required intent(s)`
      : result.summary,
    details,
    verificationPolicy,
    verificationCoverage: coverage,
    ...(legacyHints.length > 0 ? { legacyEvidenceWithoutIntent: legacyHints } : {}),
  };
}

function requiredVerificationIntentDefinitions(checklist: ChecklistData): unknown {
  return checklist.items.map((item) => ({
    itemId: item.id,
    verificationIntent: Object.fromEntries(
      Object.entries(item.verificationIntent ?? {}).map(([lane, intents]) => [
        lane,
        (intents ?? []).filter((intent) => (intent.priority ?? 'must') === 'must').map((intent) => ({
          desc: intent.desc,
          type: intent.type,
          requiredIn: intent.requiredIn,
          priority: intent.priority ?? 'must',
        })),
      ]),
    ),
  }));
}

function routineVerificationSnapshot(ctx: HandlerContext, storyId: string) {
  const story = ctx.store.readStory(storyId);
  const checklist = ctx.store.readChecklist(storyId);
  let decision = null;
  try { decision = ctx.store.readDecision(storyId); } catch { /* optional */ }
  const verificationPolicy = resolveVerificationIntentPolicy(story, checklist, decision);
  const workflowPolicy = resolveWorkflowPolicy(loadConfig(ctx.root), story);
  const gitCwd = resolveGitCwd({ store: ctx.store, storyId, metadataRoot: ctx.root, projectRoot: ctx.root });
  const head = currentHead(gitCwd);
  const coverage = buildVerificationCoverage(
    checklist,
    head,
    (headHash, evidence) => evidenceFreshness(gitCwd, ctx.root, headHash, evidence).fresh,
    {
      deferredGateEvidence: 'missing',
      evidenceQualityProfile: workflowPolicy.profile,
      receiptAdmissibility: createVerificationEvidenceGateEvaluator(ctx.root, storyId),
    },
  );
  return {
    checklist,
    verificationPolicy,
    workflowPolicy,
    coverage,
    identityPolicyInputs: {
      requiredVerificationIntentDefinitions: requiredVerificationIntentDefinitions(checklist),
      verificationPolicy,
      workflowPolicy,
    },
  };
}

/**
 * Raw contents of the config files that define the routine validation source.
 *
 * B-a745 CHK-001 exported it so the identity fixture can prove the second half of
 * the regression guard: declaring a command `id` in project config DOES change
 * `source.inputDigest`, because this snapshot binds the raw file contents.
 */
export function sourceInputSnapshot(projectRoot: string, sourceKind: RoutineValidationSourceKind): unknown {
  const names = sourceKind === 'configured'
    // B-cc10 CHK-004: snapshot BOTH config spellings. The absent one records a
    // `null` entry, which is exactly the signal this identity snapshot wants —
    // pinning the deprecated literal alone would make the identity blind to the
    // canonical file's contents, so editing the canonical config would not
    // invalidate the routine-validation identity it is supposed to bind.
    ? [...CONFIG_FILENAMES]
    : sourceKind === 'fallback'
      ? ['package.json', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini']
      : [];
  return Object.fromEntries(names.map((name) => {
    const path = join(projectRoot, name);
    try { return [name, existsSync(path) ? readFileSync(path, 'utf8') : null]; }
    catch { return [name, 'unreadable']; }
  }));
}

function buildStoryRoutineIdentity(args: {
  ctx: HandlerContext;
  storyId: string;
  sourceKind: RoutineValidationSourceKind;
  commands: ValidationCommand[];
  full?: boolean | string;
  focus?: string;
  entrypointPath?: string;
}) {
  try {
    const snapshot = routineVerificationSnapshot(args.ctx, args.storyId);
    return {
      snapshot,
      identity: buildRoutineValidationIdentity({
        projectRoot: args.ctx.root,
        sourceKind: args.sourceKind,
        sourceInputs: sourceInputSnapshot(args.ctx.root, args.sourceKind),
        ...(args.entrypointPath ? { entrypointPath: args.entrypointPath } : {}),
        commands: args.commands,
        ...(args.full !== undefined ? { full: args.full } : {}),
        ...(args.focus ? { focus: args.focus } : {}),
        profile: snapshot.workflowPolicy.profile,
        verificationPolicyInputs: snapshot.identityPolicyInputs,
      }),
    };
  } catch (error) {
    args.ctx.log?.(`routine validation reuse identity unavailable; executing: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function evaluateStoryRoutineReuse(args: {
  ctx: HandlerContext;
  storyId: string;
  gitCwd: string;
  identity: RoutineValidationIdentity;
  coverage: ReturnType<typeof routineVerificationSnapshot>['coverage'];
}): RoutineValidationReuseEvaluation {
  let evidence = null;
  try { evidence = args.ctx.store.readTestEvidence(args.storyId); } catch { /* refusal below */ }
  let headBefore: string | undefined;
  let headAfter: string | undefined;
  let materialHash: string | undefined;
  let storyFilesHash: string | undefined;
  let clean = false;
  try {
    const snapshot = captureEvidenceHashSnapshot({ gitCwd: args.gitCwd, metadataRoot: args.ctx.root });
    headBefore = snapshot.headHash;
    materialHash = snapshot.materialHash;
    storyFilesHash = snapshot.storyFilesHash;
    const reuseCheck = checkEvidenceHashSnapshotReuse(snapshot, {
      gitCwd: args.gitCwd,
      metadataRoot: args.ctx.root,
      ref: 'HEAD',
    });
    headAfter = reuseCheck.currentHead;
    clean = reuseCheck.reusable;
    if (reuseCheck.materialDirty) {
      args.ctx.log?.(`routine validation reuse refused by dirty worktree: ${reuseCheck.materialDirtyFiles.join(' | ')}`);
    }
  } catch { /* refusal below */ }
  const evaluation = evaluateRoutineValidationReuse({
    root: args.ctx.root,
    gitCwd: args.gitCwd,
    evidence,
    currentIdentity: args.identity,
    currentCoverage: args.coverage,
    currentMaterialHash: materialHash,
    currentStoryFilesHash: storyFilesHash,
    clean,
    headBefore,
    headAfter,
  });
  if (!evaluation.reusable) {
    const priorIdentityDigest = isCompleteRoutineValidationIdentity(evidence?.routineValidationIdentity)
      ? evidence.routineValidationIdentity.digest
      : 'missing-or-malformed';
    const refusalReasons = [...new Set(evaluation.refusalReasons)].sort();
    args.ctx.log?.(
      `routine validation reuse refused: refusalReasons=${refusalReasons.join(',') || 'unknown'} `
      + `priorIdentityDigest=${priorIdentityDigest} currentIdentityDigest=${args.identity.digest}`,
    );
  }
  return evaluation;
}

function reusedStoryValidationResult(args: {
  ctx: HandlerContext;
  storyId: string;
  gitCwd: string;
  snapshot: ReturnType<typeof routineVerificationSnapshot>;
  identity: RoutineValidationIdentity;
  reuse: RoutineValidationReuseEvaluation;
  focus?: string;
  warn?: boolean;
  resolvedDynamicMode?: DynamicValidationMode;
  dynamicValidation?: Record<string, unknown>;
}): any {
  const result = externalResult({
    provider: 'proof-or-stop-verifier-reused',
    status: args.warn ? 'warn' : 'pass',
    summary: `Validation PASS reused (${args.reuse.lineage}); commandExecutions=0`,
    details: [
      `disposition=reused existingEvidenceBasis=fresh lineage=${args.reuse.lineage}`,
      `identityDigest=${args.identity.digest}`,
      'commandExecutions=0',
      ...renderVerificationCoverage(args.snapshot.coverage, args.snapshot.verificationPolicy).split('\n'),
    ],
    warnings: [],
    commands: [],
    ...(args.focus ? { focus: { name: args.focus, mode: 'focused', finalFullValidation: false, doneRequiredProof: false } } : {}),
  });
  const reused = {
    ...result,
    disposition: 'reused',
    commandExecutions: 0,
    verificationPolicy: args.snapshot.verificationPolicy,
    verificationCoverage: args.snapshot.coverage,
    ...(args.dynamicValidation ? { dynamicValidation: args.dynamicValidation } : {}),
    reuse: {
      lineage: args.reuse.lineage,
      existingEvidenceBasis: args.reuse.existingEvidenceBasis,
      refusalReasons: [],
      identityDigest: args.identity.digest,
    },
  };
  const priorEvidence = args.ctx.store.readTestEvidence(args.storyId);
  const priorCommandExecution = priorEvidence?.commandExecution;
  if (!priorCommandExecution) {
    return externalResult({
      provider: 'proof-or-stop-verifier-reuse-persistence',
      status: 'fail',
      failureKind: 'infra_failure',
      summary: 'Validation reuse refused because canonical command evidence disappeared before persistence',
      details: ['canonical-pass-persistence-failed: prior commandExecution is missing'],
      warnings: [],
      commands: [],
    });
  }
  const headHash = currentHead(args.gitCwd);
  const materialHash = currentMaterialHash(args.gitCwd, 'HEAD', args.ctx.root);
  const storyFilesHash = currentStoryFilesHash(args.gitCwd, 'HEAD', args.ctx.root);
  const storyRel = normalizeRelPath(relative(
    realpathSync(args.gitCwd),
    realpathSync(args.ctx.store.storyDirPath(args.storyId)),
  ));
  const managedPaths = [
    'test-evidence.json',
    'process-events.jsonl',
    'closeout-write-receipts.jsonl',
  ].map((name) => `${storyRel}/${name}`);
  const preexistingManagedDirty = execFileSync('git', ['status', '--porcelain', '--', ...managedPaths], {
    cwd: args.gitCwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  if (preexistingManagedDirty) {
    return externalResult({
      provider: 'proof-or-stop-verifier-reuse-persistence',
      status: 'fail',
      failureKind: 'infra_failure',
      summary: 'Validation reuse refused because canonical metadata was already dirty',
      details: ['canonical-pass-persistence-failed', preexistingManagedDirty],
      warnings: [],
      commands: [],
    });
  }
  const transaction = captureDonePrepareGeneratedMetadataTransaction({
    root: args.gitCwd,
    gitCwd: args.gitCwd,
    paths: managedPaths,
  });
  // B-3434 F-014: the reuse path wrote JSON.stringify(reused) with no bound at all, so a reused
  // result from a large command set produced the same oversized file the executed path was fixed
  // for. Same boundary, same enforcement: bound the serialised record, not the inner string.
  //
  // The command string is NOT cosmetic: assessStoredValidationPassAdmissibility compares this exact
  // field against `proof-or-stop validate --story=<id> --json` (phase-gates.ts) and any other value
  // is rejected with `command_mismatch`, which would silently disable reuse entirely.
  const reusedBound = boundPersistedValidationEvidence({
    result: reused,
    buildRecord: (output): TestEvidenceData => ({
      command: `proof-or-stop validate --story=${args.storyId} --json`,
      output,
      result: 'PASS',
      timestamp: new Date().toISOString(),
      ...(headHash ? { headHash } : {}),
      ...(materialHash ? { materialHash } : {}),
      ...(storyFilesHash ? { storyFilesHash } : {}),
      verificationCoverage: args.snapshot.coverage,
      commandExecution: priorCommandExecution,
      disposition: 'reused',
      routineValidationIdentity: args.identity,
      resolvedDynamicMode: args.resolvedDynamicMode ?? 'off',
      reuseAdmission: args.resolvedDynamicMode === 'observe' ? 'observe-opt-in' : 'mode-off',
      ...(priorEvidence.dynamicRevocationLedgerDigest ? { dynamicRevocationLedgerDigest: priorEvidence.dynamicRevocationLedgerDigest } : {}),
    }),
  });
  const reusedAdvisory = formatValidationEvidenceAdvisory(reusedBound);
  if (reusedAdvisory) args.ctx.log?.(reusedAdvisory);
  // The null test is not belt-and-braces: `record` is `T | null` precisely so that the write below
  // is unreachable without one. A null record is always reported as refused, so this condition is
  // the same condition twice - stated in the form the compiler can carry to the write.
  if (!reusedBound.withinBound || reusedBound.record === null) {
    // Structured refusal, matching every sibling failure in this function. A raw throw here made
    // one condition surface differently from the identical condition in
    // persistStoryValidationEvidence, which returns a result the caller can render and classify.
    return externalResult({
      provider: 'proof-or-stop-verifier-reuse-persistence',
      status: 'fail',
      failureKind: 'infra_failure',
      summary: 'Validation reuse refused because its evidence file exceeds the persisted size bound',
      details: [
        'canonical-pass-persistence-failed: reused evidence file could not be reduced under the bound',
        `boundBytes=${VALIDATION_EVIDENCE_BOUND_BYTES} fileBytes=${reusedBound.fileBytes} disposition=${reusedBound.disposition}`,
      ],
      warnings: [],
      commands: [],
    });
  }
  const expectedHashes = publicationOutputHashes(transaction, storyRel, reusedBound.record);
  try {
    assertCurrentValidationPublicationOwner(args.ctx.root, args.storyId);
    args.ctx.store.writeTestEvidence(args.storyId, reusedBound.record);
    const terminal = recordValidationTerminal(args.ctx, args.storyId, args.gitCwd, reused, args.identity);
    if (!terminal) throw new Error('VALIDATION_TERMINAL_RECEIPT_MISSING: canonical publication requires a terminal append receipt');
    const terminalHashes = publicationOutputHashes(transaction, storyRel, reusedBound.record, terminal);
    expectedHashes.set(`${storyRel}/process-events.jsonl`, terminalHashes.get(`${storyRel}/process-events.jsonl`)!);
  } catch (error) {
    const rolledBack = rollbackValidationPublication({ gitCwd: args.gitCwd, transaction, expectedHashes }, String(error));
    return externalResult({ provider: 'proof-or-stop-verifier-reuse-persistence', status: 'fail',
      failureKind: 'infra_failure', summary: 'Validation reuse publication refused',
      details: ['canonical-pass-persistence-failed', rolledBack.reason ?? String(error)], commands: [] });
  }
  const commitResult = commitValidationReuseMetadataTransaction({
    projectRoot: args.ctx.root,
    gitCwd: args.gitCwd,
    storyId: args.storyId,
    storyRel,
    reason: 'validate',
    transaction,
    closeoutArtifactPaths: ['test-evidence.json'],
    expectedHashes,
  });
  if (!commitResult.ok) {
    return externalResult({
      provider: 'proof-or-stop-verifier-reuse-persistence',
      status: 'fail',
      failureKind: 'infra_failure',
      summary: 'Validation reuse could not persist its canonical PASS receipt',
      details: [
        'canonical-pass-persistence-failed',
        commitResult.reason || 'metadata writer did not create a commit',
      ],
      warnings: [],
      commands: [],
    });
  }
  return reused;
}

/** Selection remains advisory. A reused complete PASS is never a fresh observe oracle. */
function tryReuseRoutinePass(args: {
  ctx: HandlerContext;
  storyId: string;
  gitCwd: string;
  commands: ValidationCommand[];
  dynamicMode: DynamicValidationMode;
  observeOptIn: boolean;
  focus?: string;
  built: NonNullable<ReturnType<typeof buildStoryRoutineIdentity>>;
  reuse: RoutineValidationReuseEvaluation;
  rebuild: () => ReturnType<typeof buildStoryRoutineIdentity>;
}): any | null {
  if (!args.reuse.reusable || args.focus) return null;
  if (args.dynamicMode === 'off') {
    args.ctx.log?.('routine validation reused; commandExecutions=0');
    return reusedStoryValidationResult({
      ...args, snapshot: args.built.snapshot, identity: args.built.identity, resolvedDynamicMode: 'off',
    });
  }
  if (args.dynamicMode !== 'observe' || !args.observeOptIn) return null;
  try {
    const priorEvidence = args.ctx.store.readTestEvidence(args.storyId);
    const priorBasis = readRoutineReuseRevocationBasis(args.ctx.root, args.storyId);
    // The ledger has no timestamp. Bind its signed content digest instead of
    // inventing temporal ordering or trusting a missing/corrupt cache as empty.
    if (!priorBasis || priorEvidence?.dynamicRevocationLedgerDigest !== priorBasis) return null;
    const preparationHead = currentHead(args.gitCwd);
    if (!preparationHead) return null;
    const baseHead = execFileSync('git', ['merge-base', 'main', 'HEAD'], { cwd: args.gitCwd, encoding: 'utf8' }).trim();
    const priorArtifacts = readStoryAwareValidationArtifacts(args.ctx.root, args.storyId);
    const dynamic = prepareStoryAwareValidation({
      projectRoot: args.ctx.root, storyId: args.storyId, gitCwd: args.gitCwd,
      baseHead, head: preparationHead, mode: 'observe', commands: args.commands,
      ...storyDynamicInputs(args.ctx, args.storyId),
      receipts: priorArtifacts.receipts, revocationLedger: priorArtifacts.revocationLedger,
    });
    persistStoryAwareValidationArtifacts({
      projectRoot: args.ctx.root, storyId: args.storyId, manifest: dynamic.manifest,
      report: `${dynamic.report}\nAdvisory selection prepared; complete PASS reuse still requires a fresh check. No fresh observe oracle is claimed by this report.`,
      receipts: priorArtifacts.receipts, revocationLedger: dynamic.revocationLedger,
      preserveExistingReceipts: true,
    });
    args.ctx.log?.('observe selection persisted; checking complete PASS freshness again');
    // Selection persistence is an intervening operation. Rebuild the full
    // identity/coverage and double-read current Git inputs before consumption.
    if (currentHead(args.gitCwd) !== preparationHead
      || readRoutineReuseRevocationBasis(args.ctx.root, args.storyId) !== priorBasis) return null;
    const current = args.rebuild();
    if (!current || current.identity.digest !== args.built.identity.digest) return null;
    const reuse = evaluateStoryRoutineReuse({
      ctx: args.ctx, storyId: args.storyId, gitCwd: args.gitCwd,
      identity: current.identity, coverage: current.snapshot.coverage,
    });
    if (!reuse.reusable) return null;
    args.ctx.log?.('routine validation reused; commandExecutions=0');
    return reusedStoryValidationResult({
      ctx: args.ctx, storyId: args.storyId, gitCwd: args.gitCwd,
      snapshot: current.snapshot, identity: current.identity, reuse, resolvedDynamicMode: 'observe',
      dynamicValidation: {
        mode: 'observe', manifest: dynamic.manifest, report: dynamic.report,
        authority: 'observe-only', oracleStatus: 'not-run', receipts: 0,
        reusedFromIdentityDigest: current.identity.digest,
      },
    });
  } catch (error) {
    args.ctx.log?.(`observe complete PASS reuse refused; executing: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function publicationOutputHashes(
  transaction: ReturnType<typeof captureDonePrepareGeneratedMetadataTransaction>,
  storyRel: string,
  record: TestEvidenceData,
  terminal?: ReturnType<HandlerContext['store']['appendProcessEvent']>,
): Map<string, string> {
  const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
  const baseline = new Map(transaction.states.map(state => [state.path, state.worktreeContent ?? Buffer.alloc(0)]));
  const eventsPath = `${storyRel}/process-events.jsonl`;
  const before = baseline.get(eventsPath) ?? Buffer.alloc(0);
  if (terminal && terminal.start !== before.length) throw new Error('canonical terminal append did not match captured baseline');
  return new Map([
    [`${storyRel}/test-evidence.json`, hash(JSON.stringify(record, null, 2) + '\n')],
    [eventsPath, hash(terminal ? Buffer.concat([before, terminal.eventBytes]) : before)],
    [`${storyRel}/closeout-write-receipts.jsonl`, hash(baseline.get(`${storyRel}/closeout-write-receipts.jsonl`) ?? Buffer.alloc(0))],
  ]);
}

function recordValidationTerminal(
  ctx: HandlerContext,
  storyId: string,
  gitCwd: string,
  result: any,
  identity?: RoutineValidationIdentity,
) {
  let story;
  try { story = ctx.store.readStory(storyId); } catch { return; }
  return ctx.store.appendProcessEvent(storyId, {
    type: 'validation_terminal',
    storyId,
    attemptId: story.currentReviewRound ?? '',
    phase: story.phase,
    reviewRound: story.currentReviewRound ?? '',
    commandSetHash: identity?.digest ?? createHash('sha256').update(JSON.stringify(
      Array.isArray(result.commands)
        ? result.commands.map((command: any) => ({
          label: command?.label ?? '',
          command: command?.command ?? '',
          args: Array.isArray(command?.args) ? command.args : [],
          shell: command?.shell === true,
          cwd: command?.cwd ?? '',
        }))
        : [],
    )).digest('hex'),
    disposition: result.disposition === 'reused' ? 'reused' : 'executed',
    commandExecutions: Number(result.commandExecutions ?? result.commands?.length ?? 0),
    result: result.allPass === false || result.status === 'fail' ? 'fail' : 'pass',
    materialHash: currentMaterialHash(gitCwd, 'HEAD', ctx.root) ?? '',
    storyFilesHash: currentStoryFilesHash(gitCwd, 'HEAD', ctx.root) ?? '',
  });
}

function resolveStoryVerificationPolicy(ctx: HandlerContext, storyId: string) {
  const story = ctx.store.readStory(storyId);
  const cl = ctx.store.readChecklist(storyId);
  let decision = null;
  try { decision = ctx.store.readDecision(storyId); } catch { /* no decision for express/fast stories */ }
  return resolveVerificationIntentPolicy(story, cl, decision);
}

type ValidationEvidenceFailureKind = 'validation_failure' | 'infra_failure';

function validationFailureKindFromResult(result: any, allPass: boolean): ValidationEvidenceFailureKind | undefined {
  if (allPass) return undefined;
  if (result?.failureKind === 'infra_failure') return 'infra_failure';
  if (result?.failureKind === 'validation_failure') return 'validation_failure';
  const commands = Array.isArray(result?.commands) ? result.commands : [];
  if (commands.some((cmd: any) => cmd?.failureKind === 'infra_failure' || cmd?.timedOut === true)) {
    return 'infra_failure';
  }
  return 'validation_failure';
}

function persistStoryValidationEvidence(
  ctx: HandlerContext,
  storyId: string,
  result: any,
  command: string,
  identity: RoutineValidationIdentity | undefined,
  commandResults: ValidationCommandResult[],
  expectedCommandCount: number,
  semanticCommandPass?: boolean,
): any | null {
  const statusPass = result.status === 'pass';
  const allPass = Boolean(result.allPass ?? result.allPassed ?? statusPass);
  const failureKind = validationFailureKindFromResult(result, allPass);
  const persistenceFailure = (reason: string) => ({
    ...externalResult({
      provider: 'proof-or-stop-verifier-executed-persistence',
      status: 'fail',
      failureKind: 'infra_failure',
      summary: 'Validation result could not persist its canonical evidence transaction',
      details: ['canonical-validation-persistence-failed', reason],
      warnings: [],
      commands: commandResults,
    }),
    disposition: 'executed',
    commandExecutions: commandResults.filter(row => row.executionReceipt?.disposition !== 'reused').length,
  });
  // B-3434: the artifact grows with the NUMBER of configured validate commands (per-command output
  // is already capped upstream by trimOutput), and once it passed the metadata read ceiling nothing
  // could commit test-evidence.json at all.
  //
  // The size decision is made over the RECORD as it would serialise into the file, not over the
  // inner output string: StoryStore stringifies this record a second time, escaping the output
  // string again, which roughly doubles quote-heavy content on the way to disk. Bounding the inner
  // string alone left a reachable wedge where an in-bound string produced an out-of-bound file, the
  // metadata commit hit the blob ceiling, and no story could persist evidence. What that measurement
  // does and does not settle is described on boundPersistedValidationEvidence.
  const dynamicRevocationBasis = result.dynamicValidation?.mode
    ? readRoutineReuseRevocationBasis(ctx.root, storyId) : null;
  const evidenceRecord = (output: string, hashes: {
    headHash?: string;
    materialHash?: string;
    storyFilesHash?: string;
  } = {}): TestEvidenceData => ({
    command,
    output,
    result: allPass ? 'PASS' : 'FAIL',
    ...(failureKind ? { failureKind } : {}),
    timestamp: new Date().toISOString(),
    ...(hashes.headHash ? { headHash: hashes.headHash } : {}),
    ...(hashes.materialHash ? { materialHash: hashes.materialHash } : {}),
    ...(hashes.storyFilesHash ? { storyFilesHash: hashes.storyFilesHash } : {}),
    ...(result.verificationCoverage ? { verificationCoverage: result.verificationCoverage } : {}),
    commandExecution: summarizeRoutineCommandExecution(commandResults, expectedCommandCount, {
      ...(semanticCommandPass !== undefined ? { semanticPass: semanticCommandPass } : {}),
      // B-7dff F-003: a dirty tree no single command can be blamed for is still
      // a required failure here, or this receipt would read PASS on a run the
      // executor already failed.
      ...(result?.concurrentWorktreePollution && result.concurrentWorktreePollution.blocking !== false
        ? { concurrentPollutionBlocking: true }
        : {}),
    }),
    disposition: 'executed',
    ...(identity ? { routineValidationIdentity: identity } : {}),
    ...(result.dynamicValidation?.mode ? {
      resolvedDynamicMode: result.dynamicValidation.mode,
      ...(dynamicRevocationBasis ? { dynamicRevocationLedgerDigest: dynamicRevocationBasis } : {}),
    } : {}),
  });
  // ONE computation gates and writes. The gate used to run without the hashes and the write with
  // them, discarding the second measurement - two artifacts, one measured, the other stored. The
  // hash fields add a measurable ~232 bytes, so a record sitting in that window passed a gate it
  // would have failed. That is the F-014 shape again at a smaller scale, and the repair is the same
  // one: measure the artifact you are about to write, not a near relative of it.
  const boundEvidence = (hashes: {
    headHash?: string;
    materialHash?: string;
    storyFilesHash?: string;
  } = {}) => boundPersistedValidationEvidence({
    result,
    buildRecord: (output) => evidenceRecord(output, hashes),
  });

  let gitCwd: string;
  let storyRel: string;
  let transaction: ReturnType<typeof captureDonePrepareGeneratedMetadataTransaction>;
  let hashes: { headHash?: string; materialHash?: string; storyFilesHash?: string };
  try {
    gitCwd = resolveGitCwd({ store: ctx.store, storyId, metadataRoot: ctx.root, projectRoot: ctx.root });
    hashes = {
      headHash: currentHead(gitCwd) ?? result.headSha ?? result.headHash,
      materialHash: currentMaterialHash(gitCwd, 'HEAD', ctx.root),
      storyFilesHash: currentStoryFilesHash(gitCwd, 'HEAD', ctx.root),
    };
    storyRel = normalizeRelPath(relative(
      realpathSync(gitCwd),
      realpathSync(ctx.store.storyDirPath(storyId)),
    ));
    const managedPaths = [
      'test-evidence.json',
      'process-events.jsonl',
      'closeout-write-receipts.jsonl',
    ].map((name) => `${storyRel}/${name}`);
    const preexistingManagedDirty = execFileSync('git', ['status', '--porcelain', '--', ...managedPaths], {
      cwd: gitCwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (preexistingManagedDirty) {
      return persistenceFailure(`canonical metadata was already dirty: ${preexistingManagedDirty}`);
    }
    transaction = captureDonePrepareGeneratedMetadataTransaction({
      root: gitCwd,
      gitCwd,
      paths: managedPaths,
    });
  } catch (error: any) {
    const reason = String(error?.stderr || error?.stdout || error?.message || error).trim();
    // Non-git fake/in-memory stores cannot provide the exact transaction, but
    // legacy validation-failure consumers still require the underlying FAIL
    // evidence. Persist only that failure artifact; never use this fallback for
    // PASS and never append a terminal/receipt without a git-backed boundary.
    if (!allPass && /not a git repository/i.test(reason)) {
      try {
        // Same rule on the degraded path: gate and write the SAME computation.
        const fallbackBound = boundEvidence();
        if (!fallbackBound.withinBound || fallbackBound.record === null) {
          return persistenceFailure(
            `${reason}; non-git FAIL evidence exceeds the ${VALIDATION_EVIDENCE_BOUND_BYTES}-byte bound `
            + `(file measures ${fallbackBound.fileBytes} bytes; disposition=${fallbackBound.disposition})`,
          );
        }
        ctx.store.writeTestEvidence(storyId, fallbackBound.record);
      } catch (fallbackError: any) {
        return persistenceFailure(`${reason}; non-git FAIL evidence fallback failed: ${String(fallbackError?.message || fallbackError)}`);
      }
    }
    return persistenceFailure(reason);
  }

  // Computed once, with the hashes, AFTER they are known: this exact record is measured, gated and
  // written, and nothing on this path computes it a second time. That is a statement about the count
  // and not about what reaches the writer: the gate below and the write that follows read the same
  // mutable record, so a line inserted between them that mutates it in place diverges the written
  // bytes from the measured ones without adding a second computation (B-3434:F-037).
  const persistedBound = boundEvidence(hashes);
  const sizingAdvisory = formatValidationEvidenceAdvisory(persistedBound);
  if (sizingAdvisory) ctx.log?.(sizingAdvisory);
  if (!persistedBound.withinBound || persistedBound.record === null) {
    return persistenceFailure(
      `serialised validation evidence file could not be reduced under the `
      + `${VALIDATION_EVIDENCE_BOUND_BYTES}-byte bound (file measures ${persistedBound.fileBytes} bytes; `
      + `disposition=${persistedBound.disposition})`,
    );
  }

  const expectedHashes = publicationOutputHashes(transaction, storyRel, persistedBound.record);
  try {
    assertCurrentValidationPublicationOwner(ctx.root, storyId);
    ctx.store.writeTestEvidence(storyId, persistedBound.record);
    const terminal = recordValidationTerminal(ctx, storyId, gitCwd, result, identity);
    if (!terminal) throw new Error('VALIDATION_TERMINAL_RECEIPT_MISSING: canonical publication requires a terminal append receipt');
    const terminalHashes = publicationOutputHashes(transaction, storyRel, persistedBound.record, terminal);
    expectedHashes.set(`${storyRel}/process-events.jsonl`, terminalHashes.get(`${storyRel}/process-events.jsonl`)!);
  } catch (error: any) {
    const reason = String(error?.stderr || error?.stdout || error?.message || error).trim();
    const rollback = rollbackValidationPublication({ gitCwd, transaction, expectedHashes }, reason);
    return persistenceFailure(rollback.reason || reason);
  }
  const commitResult = commitValidationReuseMetadataTransaction({
    projectRoot: ctx.root,
    gitCwd,
    storyId,
    storyRel,
    reason: 'validate',
    transaction,
    closeoutArtifactPaths: ['test-evidence.json'],
    expectedHashes,
  });
  if (!commitResult.ok) {
    return persistenceFailure(commitResult.reason || 'metadata writer did not create a commit');
  }
  return null;
}

/**
 * Mint a verifier result from scratch.
 *
 * B-7dff F-006: this is an ENUMERATING whitelist — it returns exactly the keys
 * listed below and nothing else. Callers that build a result from loose parts
 * (no validator configured, persistence failure, reuse refusal) lose nothing.
 * A caller holding an existing ValidationResult must NOT hand it to this
 * function alone: everything it does not enumerate (today
 * `concurrentWorktreePollution`; tomorrow whatever ValidationResult grows next)
 * is dropped silently, and downstream gates read those fields. Spread the source
 * result first — `{ ...base, ...externalResult({ ... }) }` — so the wrap is
 * additive.
 */
function externalResult(args: {
  provider?: string;
  status: 'pass' | 'fail' | 'warn';
  summary: string;
  details: string[];
  warnings?: string[];
  headSha?: string;
  commands?: any[];
  focus?: any;
  failureKind?: ValidationEvidenceFailureKind;
}) {
  const allPass = args.status !== 'fail';
  const failureKind = validationFailureKindFromResult({
    failureKind: args.failureKind,
    commands: args.commands ?? [],
  }, allPass);
  return {
    provider: args.provider ?? 'proof-or-stop-verifier',
    status: args.status,
    allPass,
    ...(failureKind ? { failureKind } : {}),
    summary: args.summary,
    details: args.details,
    warnings: args.warnings ?? [],
    timestamp: new Date().toISOString(),
    ...(args.headSha ? { headSha: args.headSha } : {}),
    commands: args.commands ?? [],
    ...(args.focus ? { focus: args.focus } : {}),
  };
}

function renderExternalResult(result: any): string {
  const mark = result.status === 'fail' ? '✗' : result.status === 'warn' ? '⚠' : '✓';
  const lines = [`${mark} ${result.summary}`];
  for (const detail of result.details || []) lines.push(`  ${detail}`);
  for (const warning of result.warnings || []) lines.push(`  warning: ${warning}`);
  if (result.disposition) lines.push(`  disposition=${result.disposition} commandExecutions=${result.commandExecutions ?? result.commands?.length ?? 0}`);
  if (result.reuse) {
    lines.push(`  existingEvidenceBasis=${result.reuse.existingEvidenceBasis} lineage=${result.reuse.lineage} refusalReasons=${result.reuse.refusalReasons?.join(',') || 'none'}`);
  }
  return lines.join('\n');
}

function validationProgressReporter(ctx: HandlerContext): ValidationProgressReporter {
  return (event) => {
    ctx.log?.(formatValidationProgressEvent(event));
  };
}

function validateFileDefaultTimeoutMs(): number | undefined {
  const raw = Number(readBrandEnv('VALIDATE_FILE_TIMEOUT_MS'));
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
}

function decorateAndMaybePersistStoryValidation(
  ctx: HandlerContext,
  storyId: string | undefined,
  focus: string | undefined,
  result: any,
  identity?: RoutineValidationIdentity,
  commandResults?: ValidationCommandResult[],
  expectedCommandCount?: number,
  semanticCommandPass?: boolean,
): any {
  if (!storyId) return result;
  const decorated = decorateStoryVerification(ctx, storyId, result);
  const executed = {
    ...decorated,
    disposition: 'executed',
    commandExecutions: commandResults?.filter(row => row.executionReceipt?.disposition !== 'reused').length ?? 0,
  };
  if (!focus) {
    if (!commandResults || expectedCommandCount === undefined) {
      throw new Error('routine validation command execution is required before evidence persistence');
    }
    const persistenceFailure = persistStoryValidationEvidence(
      ctx,
      storyId,
      executed,
      `proof-or-stop validate --story=${storyId} --json`,
      identity,
      commandResults,
      expectedCommandCount,
      semanticCommandPass,
    );
    if (persistenceFailure) return persistenceFailure;
  }
  return executed;
}

export function createVerifierHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  const authoritativeMutation = createAuthoritativeFindingMutation(ctx);
  return {
    /**
     * proof-or-stop validate [--full[=filter]] [--story=B-xxx] [--json]
     *
     * Runs the project's validate.ts with appropriate flags.
     * Returns human-readable output by default, or ExternalVerifierResult with --json.
     */
    async validate(args: {
      full?: string | boolean;
      focus?: string;
      dynamicMode?: DynamicValidationMode;
      reuseFreshRoutinePass?: boolean;
      story?: string;
      storyId?: string;
      json?: boolean;
      // B-9d95 CHK-006: REVIEW→TEST preflight CLI gate 独立分流
      channel?: boolean;
      concept?: boolean;
      lint?: boolean;
      noSync?: boolean;
      abortSignal?: AbortSignal;
      deadlineAt?: number;
      deadlineError?: () => Error;
      /** Internal top-level CLI outcome sink; never part of the public schema. */
      onValidationOutcome?: (passed: boolean) => void;
    }) {
      const reportOutcome = (passed: boolean): void => {
        if (typeof args.onValidationOutcome === 'function') args.onValidationOutcome(passed);
      };
      // Preserve the public representation; communicate the verdict before it
      // is rendered away. Nested handler calls do not receive this CLI sink.
      const respond = (result: any): string => {
        reportOutcome(result?.allPass !== false && result?.allPassed !== false
          && result?.status !== 'fail' && result?.status !== 'blocked'
          && !['failed', 'timed_out', 'blocked'].includes(result?.result));
        return args.json ? JSON.stringify(result) : renderExternalResult(result);
      };
      // B-a30e: normalize storyId alias — must happen before any story usage
      if (args.storyId !== undefined) {
        const sid = args.storyId.trim();
        if (args.story !== undefined && args.story.trim() !== sid) {
          throw new Error(
            `validate: conflicting story identifiers: --story="${args.story}" and storyId="${args.storyId}" differ; supply only one`,
          );
        }
        args.story = sid;
      }
      const focus = normalizeFocusArg(args.focus);
      const projectRoot = ctx.root;
      // B-75f0 CHK-002: resolve the git working dir once at handler entry so every
      // headSha read below (currentHead / `git rev-parse --short HEAD`) runs from
      // the REAL gitRoot on a wrapper-root layout. With a real --story use the
      // id-keyed resolveGitCwd; otherwise the id-independent project-level resolver.
      // Genuine non-Git projects still use projectRoot verbatim. An explicit
      // configured gitRoot is authoritative, however: if it cannot resolve,
      // stop before capacity acquisition rather than mint a wrapper-local lock.
      const projectConfig = loadConfig(projectRoot);
      const dynamicMode = resolveDynamicMode(
        args.dynamicMode
        || process.env.PROOF_OR_STOP_DYNAMIC_VALIDATION_MODE
            || projectConfig.validation?.dynamic?.mode
            || projectConfig.validate?.dynamic?.mode,
      );
      const configuredGitRootExpected = Boolean(projectConfig.gitRoot?.trim());
      const resolvedProjectGitRoot = args.story
        ? null
        : resolveProjectGitRoot(projectRoot, projectConfig.gitRoot);
      if (!args.story && configuredGitRootExpected && !resolvedProjectGitRoot) {
        throw new Error(
          `validate: configured gitRoot could not be resolved for workspace validation capacity under ${projectRoot}`,
        );
      }
      const handlerGitCwd = args.story
        ? resolveGitCwd({ store: ctx.store, storyId: args.story, metadataRoot: projectRoot, projectRoot, config: projectConfig })
        : (resolvedProjectGitRoot ?? projectRoot);
      return await withValidationSigningRoot(handlerGitCwd, () => withOfficialValidationExecution({
        commandStages: !args.channel && !args.concept && !args.lint && !findValidateFile(projectRoot),
        root: projectRoot,
        storyId: args.story,
        workspaceRoot: handlerGitCwd,
        requireGitIdentity: Boolean(args.story) || configuredGitRootExpected || existsSync(join(handlerGitCwd, '.git')),
        command: 'validate',
        ...(!args.channel && !args.concept && !args.lint && !findValidateFile(projectRoot)
          ? declaredValidationCapacity(configuredValidationCommands(projectRoot), handlerGitCwd) : {}),
        sharedExecution: args.story && (dynamicMode === 'off' || projectConfig?.validate?.sharedExecution === true) ? {
          storyId: args.story, receiptStore: ctx.store, reuseEconomics: 'measured',
          probe: input => probeValidationCausalPreflightFacts(ctx, args.story!, input),
        } : undefined,
        ownerLeaseDir: args.story ? ctx.store.storyDirPath(args.story) : undefined,
        abortSignal: args.abortSignal,
        deadlineAt: args.deadlineAt,
        deadlineError: args.deadlineError,
        onWaitProgress: (message) => ctx.log?.(message),
      }, async () => {
      if (args.story) {
        assertCwdInWorktree(ctx.store, args.story);
        // Read-only scope refusal precedes dirty publication and cluster sync.
        // When both fail, report the upstream scope requirement first.
        if (!focus && !args.channel && !args.concept && !args.lint) {
          const prerequisite = validationScopePrerequisite(ctx, args.story, handlerGitCwd);
          if (prerequisite) {
            const result = { ...externalResult({
              provider: 'proof-or-stop-verifier-scope-preflight', status: 'fail',
              failureKind: 'infra_failure', summary: 'Validation scope prerequisites are not ready',
              details: ['VALIDATION_SCOPE_NOT_READY', prerequisite, 'commandExecutions=0',
                `Next: proof-or-stop scope_contract_init_from_plan --storyId=${args.story}; inspect scope_contract_check or use scope_contract_set to repair the contract`],
            }), commandExecutions: 0 };
            return respond(result);
          }
        }
        // Refuse pre-existing publication conflicts before this invocation mutates
        // metadata or spends a command. Final publication checks remain required.
        if (!focus && !args.channel && !args.concept && !args.lint) {
          try {
            const storyRel = normalizeRelPath(relative(
              realpathSync(handlerGitCwd), realpathSync(ctx.store.storyDirPath(args.story)),
            ));
            const paths = ['test-evidence.json', 'process-events.jsonl', 'closeout-write-receipts.jsonl']
              .map(name => `${storyRel}/${name}`);
            const dirty = execFileSync('git', ['--no-optional-locks', 'status', '--porcelain', '--', ...paths], {
              cwd: handlerGitCwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();
            if (dirty) throw new Error(`canonical metadata was already dirty: ${dirty}`);
          } catch (error: any) {
            const reason = String(error?.stderr || error?.stdout || error?.message || error).trim();
            // Preserve the existing non-git FAIL-evidence fallback downstream.
            if (!/not a git repository/i.test(reason)) {
              const result = { ...externalResult({
                provider: 'proof-or-stop-verifier-publication-preflight', status: 'fail',
                failureKind: 'infra_failure', summary: 'Validation publication is not ready',
                details: ['VALIDATION_PUBLICATION_NOT_READY', reason,
                  'Resolve pending test-evidence.json, process-events.jsonl or closeout-write-receipts.jsonl changes before retrying validate'],
              }), commandExecutions: 0 };
              return respond(result);
            }
          }
        }
        if (!args.noSync) {
          const synced = syncClusterResolves(args.story, ctx.store, projectRoot, ctx.log, authoritativeMutation);
          if (synced.resolved > 0) {
            ctx.log?.(`cluster-sync: auto-resolved ${synced.resolved} finding(s) from commit message Resolves tags`);
          }
        }
      }

      // B-9d95 CHK-006: CLI gate flag 分流——任一命中即只跑对应 gate，
      // 不 spawn pytest 的全量 validate.ts。多个 flag 同时传 → Promise.all 并行。
      if (args.channel || args.concept || args.lint) {
        // B-2856: resolve the story's gitRoot once at handler entry (story context
        // is available here) so the channel/concept git readers run from the real
        // repo in wrapper-root layouts. Null/unresolved → projectRoot fallback.
        const gitCwd = args.story
          ? resolveGitCwd({ store: ctx.store, storyId: args.story, metadataRoot: projectRoot, projectRoot })
          : (evaluateStoryDirConfigInsideGitRoot({ metadataRoot: projectRoot }).gitRootAbs ?? projectRoot);
        type GateTask = () => Promise<{ name: string; ok: boolean; rendered: string; result: unknown }>;
        const tasks: GateTask[] = [];
        if (args.channel) {
          tasks.push(async () => {
            const r = runChannelGateCli(args.story, { store: ctx.store, projectRoot, gitCwd });
            return { name: 'channel', ok: r.ok, rendered: r.rendered, result: r.result };
          });
        }
        if (args.concept) {
          tasks.push(async () => {
            const r = runConceptGateCli({ projectRoot, gitCwd });
            return { name: 'concept', ok: r.ok, rendered: r.rendered, result: r.result };
          });
        }
        if (args.lint) {
          tasks.push(async () => {
            // B-a749: when run as a story-scoped gate (--lint --story=B-xxx),
            // resolve the change-scope (changed files vs main) so out-of-scope
            // packages whose deps are absent are skipped-with-warning instead of
            // hard-failing on missing deps. Plain `--lint` (no story) passes no
            // scope → full recursive tsc (unchanged). On resolution failure the
            // resolver returns undefined → full recursive tsc (never skip-all).
            const changedFiles = args.story
              ? resolveChangedFiles({ projectRoot, gitCwd })
              : undefined;
            const r = runLintGateCli({ projectRoot, changedFiles });
            return { name: 'lint', ok: r.ok, rendered: r.rendered, result: r.result };
          });
        }
        ctx.log?.(`running ${tasks.length} CLI gate(s) in parallel (channel=${!!args.channel} concept=${!!args.concept} lint=${!!args.lint})`);
        const results = await Promise.all(tasks.map((t) => t()));
        const allOk = results.every((r) => r.ok);
        if (args.json) {
          return respond({
            provider: 'proof-or-stop-verifier-gates',
            status: allOk ? 'pass' : 'fail',
            allPass: allOk,
            gates: results.map((r) => ({ name: r.name, ok: r.ok, result: r.result })),
            timestamp: new Date().toISOString(),
          });
        }
        const sections = results.map((r) => r.rendered).join('\n\n');
        if (!allOk) {
          // Print gate output on stdout first so users see which gate(s) failed,
          // then throw a short error so runCli's catch branch exits 1 without
          // double-printing the rendered sections.
          console.log(sections);
          const failedNames = results.filter((r) => !r.ok).map((r) => r.name).join(', ');
          throw new Error(`CLI gate(s) failed: ${failedNames}`);
        }
        reportOutcome(allOk);
        return sections;
      }

      if (args.story && isOfficialHeavyValidateInvocation(args)) {
        refuseHeavyCertificationUnlessAdmitted({
          store: ctx.store,
          storyId: args.story,
          current: currentCertificationIdentity(ctx, args.story),
        });
      }

      const validateFile = findValidateFile(projectRoot);
      if (!validateFile) {
        const configuredCommands = configuredValidationCommands(projectRoot);
        const fallbackCommands = configuredCommands.length === 0
          ? discoverFallbackValidationCommands(projectRoot)
          : [];

        if (focus && configuredCommands.length === 0) {
          throw new Error(
            `validate --focus=${focus}: no validate.ts/js/mts file or configured validate.commands were found; ` +
            'fallback validation discovery is full-only and cannot satisfy a focused validate profile.',
          );
        }
        if (configuredCommands.length === 0 && fallbackCommands.length === 0) {
          const buildNoValidatorResult = () => {
            if (!args.story) {
              return externalResult({
                provider: 'proof-or-stop-verifier-no-validation-entry',
                status: 'warn',
                summary: 'No project validator configured; skipped project-specific validation',
                details: [
                  `当前目录: ${projectRoot}`,
                  '未找到 validate.ts/js/mts，也未在 proof-or-stop.config.json 配置 validate.command(s)',
                  '未自动发现 npm test / pytest / go test / cargo test / mvn test / gradle test 等 fallback 标准入口',
                  'Swift / Package.swift 不在自动 fallback 列表（Mac Native App 已退役）；如需运行 swift test，请显式配置 validate.commands。',
                ],
                warnings: ['这是 skip/warn，不是代码失败。需要强门禁时请在 proof-or-stop.config.json 配置 validate.command 或 validate.commands。'],
                headSha: currentHead(handlerGitCwd),
              });
            }
            const built = buildStoryRoutineIdentity({
              ctx,
              storyId: args.story,
              sourceKind: 'no-validator',
              commands: [],
              full: args.full,
            });
            const reuse = built
              ? evaluateStoryRoutineReuse({ ctx, storyId: args.story, gitCwd: handlerGitCwd, identity: built.identity, coverage: built.snapshot.coverage })
              : null;
            if (reuse?.reusable && built) return reusedStoryValidationResult({
              ctx, storyId: args.story!, gitCwd: handlerGitCwd,
              snapshot: built.snapshot, identity: built.identity, reuse, warn: true,
            });
            const base = externalResult({
              provider: 'proof-or-stop-verifier-no-validation-entry',
              status: 'warn',
              summary: 'No project validator configured; skipped project-specific validation',
              details: [
                `当前目录: ${projectRoot}`,
                '未找到 validate.ts/js/mts，也未在 proof-or-stop.config.json 配置 validate.command(s)',
                '未自动发现 npm test / pytest / go test / cargo test / mvn test / gradle test 等 fallback 标准入口',
                'Swift / Package.swift 不在自动 fallback 列表（Mac Native App 已退役）；如需运行 swift test，请显式配置 validate.commands。',
              ],
              warnings: [
                '这是 skip/warn，不是代码失败。需要强门禁时请在 proof-or-stop.config.json 配置 validate.command 或 validate.commands。',
              ],
              headSha: currentHead(handlerGitCwd),
            });
            return {
              ...decorateAndMaybePersistStoryValidation(ctx, args.story, focus, base, built?.identity, [], 0),
              ...(reuse && built ? { reuse: { ...reuse, identityDigest: built.identity.digest } } : {}),
            };
          };
          const decorated = buildNoValidatorResult();
          return respond(decorated);
        }

        const commands = configuredCommands.length > 0
          ? (focus ? filterFocusedConfiguredCommands(configuredCommands, focus) : configuredCommands)
          : fallbackCommands;
        const usingConfigured = configuredCommands.length > 0;
        const fallbackDiscoveryDetail = 'validate.ts/js/mts not found and no configured validate.command(s); used advisory fallback command discovery';
        const runPlanAndPersist = async () => {
          const built = args.story ? buildStoryRoutineIdentity({
            ctx,
            storyId: args.story,
            sourceKind: usingConfigured ? 'configured' : 'fallback',
            commands,
            full: args.full,
            focus,
          }) : null;
          const reuse = built && args.story
            ? evaluateStoryRoutineReuse({ ctx, storyId: args.story, gitCwd: handlerGitCwd, identity: built.identity, coverage: built.snapshot.coverage })
            : null;
          const dynamicInputs = args.story ? storyDynamicInputs(ctx, args.story) : {};
          if (reuse?.reusable && built) {
            const reused = tryReuseRoutinePass({
              ctx, storyId: args.story!, gitCwd: handlerGitCwd, commands, dynamicMode, focus,
              observeOptIn: args.reuseFreshRoutinePass ?? projectConfig.validate?.reuseFreshRoutinePass ?? false,
              built, reuse, rebuild: () => buildStoryRoutineIdentity({
                ctx, storyId: args.story!, sourceKind: usingConfigured ? 'configured' : 'fallback',
                commands, full: args.full, focus,
              }),
            });
            if (reused) return reused;
          }
          let dynamicPreview: {
            mode: string;
            manifest?: unknown;
            report?: string;
            authority: 'observe-only' | 'full-plan-oracle' | 'enforce-authority' | 'full-fallback';
            selectedCommands?: number;
            reusedCommands?: number;
            receipts?: number;
            selectedAllPass?: boolean;
            authoritativeResult?: {
              provider: string;
              status: 'pass' | 'fail';
              allPass: boolean;
              summary: string;
              details: string[];
              warnings: string[];
              timestamp: string;
              headSha: string;
              commands: ValidationCommandResult[];
              commandExecutions: number;
              disposition: 'executed';
            };
            oracleStatus?: 'not-run' | 'executed';
            selectionManifestAccounting?: {
              selector: string;
              inventory: number;
              executed: number;
              reused: number;
              unverified: number;
              uncovered: number;
              unmappedChanges: number;
            };
            observeOracle?: ReturnType<typeof runObserveOracle>;
            catalog?: ValidationCatalogEntry[];
          } | undefined;
          // Focused validation is explicitly non-authoritative and may pass a
          // filtered command list; keep dynamic inventory/execution aligned
          // with the complete configured plan only.
          if (dynamicMode !== 'off' && !focus) {
            try {
              const baseHead = execFileSync('git', ['merge-base', 'main', 'HEAD'], {
                cwd: handlerGitCwd,
                encoding: 'utf8',
              }).trim();
              if (args.story) {
                if (dynamicMode === 'observe') {
                  // DYN-1 observe is selection-only. The ordinary complete
                  // plan below is the one authoritative execution; launching
                  // a selected plan here would duplicate commands and violate
                  // observe's resource/order equivalence contract.
                  const dynamic = prepareStoryAwareValidation({
                    projectRoot,
                    storyId: args.story,
                    baseHead,
                    head: currentHead(handlerGitCwd),
                    mode: dynamicMode,
                    commands,
                    gitCwd: handlerGitCwd,
                    ...dynamicInputs,
                  });
                  dynamicPreview = {
                    mode: dynamicMode,
                    manifest: dynamic.manifest,
                    report: dynamic.report,
                    authority: 'full-plan-oracle',
                    selectedCommands: dynamic.manifest.totals.executed,
                    reusedCommands: dynamic.manifest.totals.reused,
                    receipts: 0,
                    catalog: dynamic.catalog,
                  };
                  ctx.log?.(dynamic.report);
                } else {
                  const dynamic = await runStoryAwareDynamicValidation({
                    projectRoot,
                    storyId: args.story,
                    baseHead,
                    head: currentHead(handlerGitCwd),
                    mode: dynamicMode,
                    commands,
                    abortSignal: args.abortSignal,
                    deadlineAt: args.deadlineAt,
                    deadlineError: args.deadlineError,
                    progress: validationProgressReporter(ctx),
                    ...dynamicInputs,
                  });
                  dynamicPreview = {
                    mode: dynamicMode,
                    manifest: dynamic.manifest,
                    report: dynamic.runtimeReport,
                    authority: dynamic.authority.authoritative ? 'enforce-authority' : dynamicMode === 'enforce-low-risk' ? 'full-fallback' : 'full-plan-oracle',
                    selectedCommands: dynamic.selectedResult.commands.length + dynamic.buildResult.commands.length,
                    reusedCommands: dynamic.manifest.totals.reused,
                    receipts: dynamic.receipts.length,
                    selectedAllPass: dynamic.dynamicAllPass,
                    authoritativeResult: {
                      provider: 'proof-or-stop-verifier-dynamic-authoritative',
                      status: dynamic.dynamicAllPass ? 'pass' : 'fail',
                      allPass: dynamic.dynamicAllPass,
                      summary: dynamic.dynamicAllPass ? 'Dynamic validation passed' : 'Dynamic validation failed',
                      details: [dynamic.runtimeReport],
                      warnings: dynamic.authority.authoritative ? [] : ['Dynamic authority was not accepted; complete-plan fallback is required.'],
                      timestamp: new Date().toISOString(),
                      headSha: currentHead(handlerGitCwd) || '',
                      commands: [...dynamic.buildResult.commands, ...dynamic.selectedResult.commands],
                      commandExecutions: dynamic.buildResult.commands.length + dynamic.selectedResult.commands.length,
                      disposition: 'executed',
                    },
                    catalog: dynamic.catalog,
                  };
                  ctx.log?.(dynamic.runtimeReport);
                }
              } else {
                // The explicit mode CLI is also useful as a project-level
                // diagnostic. Without a story there is no story evidence or
                // receipt cache to mutate, so emit a signed preview and keep
                // the complete configured plan authoritative.
                const dynamic = prepareStoryAwareValidation({
                  projectRoot,
                  storyId: 'B-dynamic-validation-adhoc',
                  baseHead,
                  head: currentHead(handlerGitCwd),
                  mode: dynamicMode,
                  commands,
                  gitCwd: handlerGitCwd,
                  // A project-level observe/shadow report has no story scope
                  // from which to resolve a dual revision graph. Treat it as
                  // an empty change manifest: the complete configured plan
                  // remains the only authority, while the signed inventory /
                  // selection accounting is still emitted. This also keeps
                  // the diagnostic command bounded on large repositories.
                  changedFiles: [],
                });
                const selectionManifestAccounting = dynamic.manifest.totals;
                const selectionReport = `${dynamic.report}\n  selection manifest accounting fields: ${JSON.stringify(selectionManifestAccounting)}`;
                dynamicPreview = {
                  mode: dynamicMode,
                  manifest: dynamic.manifest,
                  report: selectionReport,
                  authority: 'full-plan-oracle',
                  selectedCommands: dynamic.manifest.totals.executed,
                  reusedCommands: dynamic.manifest.totals.reused,
                  receipts: 0,
                  selectionManifestAccounting: {
                    selector: 'selection manifest accounting fields',
                    ...selectionManifestAccounting,
                  },
                };
                ctx.log?.(selectionReport);
              }
            } catch (error) {
              ctx.log?.('dynamic validation execution unavailable; retaining complete-plan oracle: ' + (error instanceof Error ? error.message : String(error)));
              dynamicPreview = { mode: dynamicMode, authority: 'full-plan-oracle' };
            }
          }
          // A project-level dynamic invocation is intentionally a bounded
          // diagnostic preview. It has no story scope or receipt authority,
          // so running the complete configured plan here would make the
          // documented `--dynamic-mode=observe --json` probe unexpectedly
          // consume the full validation budget. Story-scoped validation below
          // remains the only path that executes and compares the full oracle.
          if (!args.story && dynamicMode !== 'off' && dynamicPreview) {
            const previewDetails = [
              ...(dynamicPreview.report ? [dynamicPreview.report] : []),
              'full-plan oracle not run; supply --story',
            ];
            const preview = externalResult({
              provider: 'proof-or-stop-verifier-dynamic-preview',
              status: 'warn',
              summary: 'Dynamic validation bounded preview; full-plan oracle not run; supply --story',
              details: previewDetails,
              warnings: ['Project-level dynamic preview is diagnostic only; no validation commands executed and no authority granted.'],
              headSha: currentHead(handlerGitCwd),
              commands: [],
            });
            return {
              ...preview,
              disposition: 'preview',
              commandExecutions: 0,
              dynamicValidation: {
                ...dynamicPreview,
                oracleStatus: 'not-run',
                fullPlanAllPass: undefined,
                verdictEquivalent: undefined,
              },
            };
          }
          if (args.story && dynamicMode === 'enforce-low-risk' && dynamicPreview?.authority === 'enforce-authority' && dynamicPreview.authoritativeResult) {
            // DYN-3 authority is a real result boundary: once every blocking
            // prerequisite passes, do not pay for a second complete-plan run.
            // The dynamic executor already selected the complete inventory on
            // any escalation, and its result carries the signed manifest and
            // receipt evidence used by TEST/DONE.
            const authoritative = {
              ...dynamicPreview.authoritativeResult,
              dynamicValidation: {
                ...dynamicPreview,
                fullPlanAllPass: dynamicPreview.authoritativeResult.allPass,
                oracleStatus: 'not-run' as const,
                verdictEquivalent: undefined,
              },
            };
            const decorated = decorateAndMaybePersistStoryValidation(
              ctx,
              args.story,
              focus,
              authoritative,
              built?.identity,
              authoritative.commands,
              authoritative.commandExecutions,
              authoritative.allPass,
            );
            return respond(decorated);
          }
          ctx.log?.(usingConfigured
            ? `running ${commands.length} configured validate.command(s)${focus ? ` for focus=${focus}` : ''}`
            : `validate.ts/js/mts not found and no configured validate.command(s); running ${commands.length} advisory fallback validation command(s)`);
          // Keep the real verifier path behind the same fail-closed readiness
          // contract as pinned verification evidence. The executor rechecks the
          // snapshot at each scheduler worker's child-launch boundary.
          const causalPreflightGate = args.story
            ? createValidationCausalPreflightGate(ctx, args.story, commands, projectRoot)
            : undefined;
          const base = await executeValidationPlan({
            provider: usingConfigured ? 'proof-or-stop-verifier-configured-commands' : 'proof-or-stop-verifier-fallback-commands',
            commands,
            warnings: [],
            ...(focus ? { focus } : {}),
          }, projectRoot, currentHead(handlerGitCwd), args.story, {
            progress: validationProgressReporter(ctx),
            abortSignal: args.abortSignal,
            deadlineAt: args.deadlineAt,
            deadlineError: args.deadlineError,
            beforeLaunch: causalPreflightGate?.beforeLaunch,
          });
          const baselineHead = currentHead(handlerGitCwd) || '';
          if (!args.story && base.allPass && !baselineHead.trim()) ctx.log?.('canonical full baseline not produced: no resolvable HEAD');
          const canonicalBaseline = args.story
            ? undefined
            : persistCanonicalFullBaseline({
              projectRoot,
              sourceHead: baselineHead,
              result: base,
              commands,
            });
          let dynamicValidation: any = dynamicPreview
            ? {
              ...dynamicPreview,
              fullPlanAllPass: base.allPass,
              oracleStatus: 'executed' as const,
              ...(canonicalBaseline ? {
                canonicalBaseline: {
                  epochId: canonicalBaseline.epochId,
                  sourceHead: canonicalBaseline.sourceHead,
                  digest: stableDigest(canonicalBaseline),
                  produced: true,
                },
              } : {}),
              // Observe/shadow remain oracle-authoritative, but record the
              // verdict comparison so a selection mismatch is visible rather
              // than silently looking like a successful optimization.
              verdictEquivalent: dynamicPreview.selectedAllPass === undefined
                ? undefined
                : dynamicPreview.selectedAllPass === base.allPass,
            }
            : undefined;
          if (dynamicValidation?.mode === 'observe' && dynamicValidation.manifest) {
            const manifest = dynamicValidation.manifest as ValidationSelectionManifest;
            const selected = new Set(manifest.rows.filter(row => row.disposition === 'execute').map(row => row.commandId));
            const commandIds = manifest.rows.map(row => row.commandId);
            const instrumentedOrder = base.commands.flatMap((row, index) => {
              const commandId = manifest.rows[index]?.commandId;
              // The authoritative executor result order is the observation;
              // do not derive it from the predicted manifest or a fragile
              // tracer event spelling.
              return commandId && selected.has(commandId) ? [commandId] : [];
            });
            const observeOracle = runObserveOracle({
              manifest,
              fullOracle: {
                allPass: base.allPass,
                failedCommandIds: base.commands.flatMap((row, index) =>
                  (row.code !== 0 || row.timedOut) && manifest.rows[index] ? [manifest.rows[index]!.commandId] : []),
              },
              instrumentedOrder,
              authoritativeOrder: commandIds,
            });
            dynamicValidation = {
              ...dynamicValidation,
              selectedAllPass: base.allPass,
              observeOracle,
              report: `${dynamicValidation.report || ''}\nobserve runtime traces: ${JSON.stringify(base.commands.map((row, index) => ({
                commandId: manifest.rows[index]?.commandId,
                events: row.runtimeTrace?.events || [],
                readPaths: row.runtimeTrace?.readPaths || [],
                loadedPaths: row.runtimeTrace?.loadedPaths || [],
                spawnedPaths: row.runtimeTrace?.spawnedPaths || [],
                registryKeys: row.runtimeTrace?.registryKeys || [],
                environmentKeys: row.runtimeTrace?.environmentKeys || [],
                unknownRuntimeInputs: row.runtimeTrace?.unknownRuntimeInputs || [],
              })))}`,
              verdictEquivalent: observeOracle.equivalent,
            };
            const runtimeClosureInvalidCommandIds = base.commands.flatMap((row, index) => {
              const manifestRow = manifest.rows[index];
              const entry = (dynamicValidation.catalog as ValidationCatalogEntry[] | undefined)?.find((candidate: ValidationCatalogEntry) => candidate.id === manifestRow?.commandId);
              if (!manifestRow || !entry) return [];
              const certificate = createValidationClosureCertificate({
                commandId: entry.id,
                baseHead: manifest.baseHead,
                inventoryDigest: manifest.inventoryDigest,
                catalogDigest: manifest.catalogDigest,
                staticPaths: entry.inputRoots,
                runtimeTrace: runtimeTraceForResult(row, projectRoot),
                declaredEnvironmentKeys: entry.declaredEnvironmentKeys || Object.keys(entry.env || {}),
                processFacts: entry.triggerExtensions.processFacts,
                capabilities: entry.triggerExtensions.capabilities,
                producedBy: 'story-closure-preview',
              });
              return verifyValidationClosureCertificate(certificate) ? [] : [entry.id];
            });
            dynamicValidation = { ...dynamicValidation, runtimeClosureInvalidCommandIds };
            const priorArtifacts = readStoryAwareValidationArtifacts(projectRoot, args.story!);
            const revokedReceiptIds = priorArtifacts.receipts
              .filter((receipt) => runtimeClosureInvalidCommandIds.includes(receipt.commandId))
              .map((receipt) => receipt.id);
            const observeLedger = revokedReceiptIds.length > 0
              ? appendReceiptRevocation(priorArtifacts.revocationLedger, revokedReceiptIds)
              : priorArtifacts.revocationLedger;
            persistStoryAwareValidationArtifacts({
              projectRoot,
              storyId: args.story!,
              manifest,
              report: `${dynamicValidation.report || ''}\nobserve oracle: ${JSON.stringify(observeOracle)}\nruntime closure invalid command IDs: ${JSON.stringify(runtimeClosureInvalidCommandIds)}`,
              receipts: priorArtifacts.receipts,
              revocationLedger: observeLedger,
              // Observe is audit-only: selection.json/report.txt and the
              // append-only revocation ledger may change, but prior receipts
              // are never replaced by an empty observe result.
              preserveExistingReceipts: true,
            });
          }
          const summary = usingConfigured
            ? base.summary
            : `${base.summary}; ${fallbackDiscoveryDetail}`;
          const details = usingConfigured
            ? base.details
            : [fallbackDiscoveryDetail, ...base.details];
          // B-7dff F-006: `externalResult` is an ENUMERATING whitelist. That is
          // right for the call sites that mint a result from nothing, and wrong
          // here, where `base` is a complete ValidationResult: every field the
          // wrapper does not list is silently dropped. It dropped F-003's
          // plan-level `concurrentWorktreePollution`, so the evidence writer at
          // persistStoryValidationEvidence never saw it and stamped
          // commandExecution=PASS onto a run the executor had already failed.
          // Spreading `base` FIRST inverts the default: the wrap is additive, so
          // a field of ValidationResult survives unless the wrapper explicitly
          // overrides it, and a future plan-level field cannot be lost by
          // forgetting to add it to the list below. Every whitelisted key is
          // still computed exactly as before — the whitelist output wins.
          const result = { ...base, ...(dynamicValidation ? { dynamicValidation } : {}), ...externalResult({
            provider: base.provider,
            status: base.status,
            summary,
            details,
            warnings: base.warnings,
            headSha: base.headSha,
            commands: base.commands,
            failureKind: base.failureKind,
            ...(base.focus ? { focus: base.focus } : {}),
          }) };
          const decorated = decorateAndMaybePersistStoryValidation(
            ctx,
            args.story,
            focus,
            result,
            built?.identity,
            base.commands,
            commands.length,
          );
          return reuse && built ? { ...decorated, reuse: { ...reuse, identityDigest: built.identity.digest } } : decorated;
        };
        const decorated = await runPlanAndPersist();
        for (const cmd of decorated.commands ?? []) {
          ctx.log?.(`ran: ${cmd.command} ${cmd.args.join(' ')}`);
        }
        return respond(decorated);
      }

      // Build args for validate.ts
      const tsArgs: string[] = [validateFile];
      if (args.full !== undefined) {
        if (typeof args.full === 'string' && args.full.length > 0) {
          tsArgs.push(`--full=${args.full}`);
        } else {
          tsArgs.push('--full');
        }
      }
      if (focus) {
        tsArgs.push(`--focus=${focus}`);
      }
      if (args.story) {
        tsArgs.push(`--story=${args.story}`);
        // Git diff 推断：把全部改动文件传给 validate.ts，让项目自己决定跑哪���测试
        // B-db56: resolve gitCwd via resolveGitCwd so wrapper-root layouts
        // (metadataRoot ≠ gitRoot) run git diff in the real repo subdir.
        const gitCwd = resolveGitCwd({ store: ctx.store, storyId: args.story, metadataRoot: projectRoot, projectRoot });
        try {
          const diff = execSync('git diff main...HEAD --name-only', {
            cwd: gitCwd,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          }).trim();
          if (diff) {
            const changedFiles = diff.split('\n')
              .filter(Boolean)
              .filter((path) => !isMaterialExcludedPath(path, projectRoot));
            // validate.ts only consumes material changes. Story metadata and
            // registered runtime artifacts must not perturb command identity.
            if (changedFiles.length > 0) tsArgs.push(`--changed-files=${changedFiles.join(',')}`);
            ctx.log?.(`story ${args.story}: git diff 发现 ${changedFiles.length} 个 material 改动文件`);
          }
        } catch { /* git diff 失败不阻塞 */ }
      }
      if (args.json) {
        tsArgs.push('--json');
      }

      const identityCommand: ValidationCommand = {
        label: validateFile,
        command: 'npx',
        args: ['tsx', ...tsArgs],
        ...(validateFileDefaultTimeoutMs() ? { timeoutMs: validateFileDefaultTimeoutMs() } : {}),
      };
      const runValidateFile = (beforeLaunch?: () => void) => {
        ctx.log?.(`running: npx tsx ${tsArgs.join(' ')}`);
        return executeValidationPlan({
          provider: 'proof-or-stop-verifier-validate-file',
          commands: [identityCommand],
          warnings: [],
          ...(focus ? { focus } : {}),
        }, projectRoot, currentHead(handlerGitCwd), args.story, {
          progress: validationProgressReporter(ctx),
          abortSignal: args.abortSignal,
          deadlineAt: args.deadlineAt,
          deadlineError: args.deadlineError,
          beforeLaunch,
        });
      };
      const runValidateFileAndRender = async () => {
        if (!args.story && dynamicMode !== 'off' && !focus) {
          try {
            const baseHead = execFileSync('git', ['merge-base', 'main', 'HEAD'], {
              cwd: handlerGitCwd,
              encoding: 'utf8',
            }).trim();
            const dynamic = prepareStoryAwareValidation({
              projectRoot,
              storyId: 'B-dynamic-validation-adhoc',
              baseHead,
              head: currentHead(handlerGitCwd) || baseHead,
              mode: dynamicMode,
              commands: [identityCommand],
              gitCwd: handlerGitCwd,
              changedFiles: [],
            });
            const preview = externalResult({
              provider: 'proof-or-stop-verifier-dynamic-preview',
              status: 'warn',
              summary: 'Dynamic validation bounded preview; full-plan oracle not run; supply --story',
              details: [dynamic.report, 'full-plan oracle not run; supply --story'],
              warnings: ['Project-level dynamic preview is diagnostic only; no validation commands executed and no authority granted.'],
              headSha: currentHead(handlerGitCwd),
              commands: [],
            });
            const result = {
              ...preview,
              disposition: 'preview' as const,
              commandExecutions: 0,
              dynamicValidation: {
                mode: dynamicMode,
                manifest: dynamic.manifest,
                report: dynamic.report,
                authority: 'full-plan-oracle' as const,
                oracleStatus: 'not-run' as const,
                fullPlanAllPass: undefined,
                verdictEquivalent: undefined,
              },
            };
            return respond(result);
          } catch (error) {
            ctx.log?.('dynamic validation preview unavailable; retaining validate-file oracle: ' + (error instanceof Error ? error.message : String(error)));
          }
        }
        const built = args.story ? buildStoryRoutineIdentity({
          ctx,
          storyId: args.story,
          sourceKind: 'validate-file',
          commands: [identityCommand],
          full: args.full,
          focus,
          entrypointPath: join(projectRoot, validateFile),
        }) : null;
        const reuse = built && args.story
          ? evaluateStoryRoutineReuse({ ctx, storyId: args.story, gitCwd: handlerGitCwd, identity: built.identity, coverage: built.snapshot.coverage })
          : null;
        const dynamicInputs = args.story ? storyDynamicInputs(ctx, args.story) : {};
        if (reuse?.reusable && built) {
          const reused = tryReuseRoutinePass({
            ctx, storyId: args.story!, gitCwd: handlerGitCwd, commands: [identityCommand], dynamicMode, focus,
            observeOptIn: args.reuseFreshRoutinePass ?? projectConfig.validate?.reuseFreshRoutinePass ?? false,
            built, reuse, rebuild: () => buildStoryRoutineIdentity({
              ctx, storyId: args.story!, sourceKind: 'validate-file', commands: [identityCommand],
              full: args.full, focus, entrypointPath: join(projectRoot, validateFile),
            }),
          });
          if (reused) return respond(reused);
        }
        let dynamicValidation: any;
        if (args.story && dynamicMode !== 'off' && !focus) {
          try {
            const baseHead = execFileSync('git', ['merge-base', 'main', 'HEAD'], {
              cwd: handlerGitCwd,
              encoding: 'utf8',
            }).trim();
            if (dynamicMode === 'observe') {
              // Observe computes and persists the selection but the
              // validate-file command below remains the sole oracle run.
              const dynamic = prepareStoryAwareValidation({
                projectRoot,
                storyId: args.story,
                baseHead,
                head: currentHead(handlerGitCwd),
                mode: dynamicMode,
                commands: [identityCommand],
                gitCwd: handlerGitCwd,
                ...dynamicInputs,
              });
              dynamicValidation = {
                mode: dynamicMode,
                manifest: dynamic.manifest,
                report: dynamic.report,
                authority: 'full-plan-oracle',
                selectedCommands: dynamic.manifest.totals.executed,
                reusedCommands: dynamic.manifest.totals.reused,
                receipts: 0,
                catalog: dynamic.catalog,
              };
            } else {
              const dynamic = await runStoryAwareDynamicValidation({
                projectRoot,
                storyId: args.story,
                baseHead,
                head: currentHead(handlerGitCwd),
                mode: dynamicMode,
                commands: [identityCommand],
                abortSignal: args.abortSignal,
                deadlineAt: args.deadlineAt,
                deadlineError: args.deadlineError,
                progress: validationProgressReporter(ctx),
                ...dynamicInputs,
              });
              dynamicValidation = {
                mode: dynamicMode,
                manifest: dynamic.manifest,
                report: dynamic.runtimeReport,
                authority: dynamic.authority.authoritative ? 'enforce-authority' : dynamicMode === 'enforce-low-risk' ? 'full-fallback' : 'full-plan-oracle',
                selectedCommands: dynamic.selectedResult.commands.length + dynamic.buildResult.commands.length,
                reusedCommands: dynamic.manifest.totals.reused,
                receipts: dynamic.receipts.length,
                selectedAllPass: dynamic.dynamicAllPass,
                authoritativeResult: dynamic.authority.authoritative ? {
                  provider: 'proof-or-stop-verifier-dynamic-authoritative',
                  status: dynamic.dynamicAllPass ? 'pass' : 'fail',
                  allPass: dynamic.dynamicAllPass,
                  summary: dynamic.dynamicAllPass ? 'Dynamic validation passed' : 'Dynamic validation failed',
                  details: [dynamic.runtimeReport],
                  warnings: [],
                  timestamp: new Date().toISOString(),
                  headSha: currentHead(handlerGitCwd) || '',
                  commands: [...dynamic.buildResult.commands, ...dynamic.selectedResult.commands],
                  commandExecutions: dynamic.buildResult.commands.length + dynamic.selectedResult.commands.length,
                  disposition: 'executed' as const,
                } : undefined,
                catalog: dynamic.catalog,
              };
            }
            ctx.log?.(dynamicValidation.report || 'dynamic validation prepared for validate-file entrypoint');
          } catch (error) {
            ctx.log?.('dynamic validation execution unavailable; retaining validate-file oracle: ' + (error instanceof Error ? error.message : String(error)));
            dynamicValidation = { mode: dynamicMode, authority: 'full-plan-oracle', report: 'dynamic validation unavailable; validate-file oracle retained' };
          }
        }
        if (args.story && dynamicMode === 'enforce-low-risk' && dynamicValidation?.authority === 'enforce-authority' && dynamicValidation.authoritativeResult) {
          const authoritative = {
            ...dynamicValidation.authoritativeResult,
            dynamicValidation: {
              ...dynamicValidation,
              fullPlanAllPass: dynamicValidation.authoritativeResult.allPass,
              oracleStatus: 'not-run' as const,
              verdictEquivalent: undefined,
            },
          };
          const decorated = decorateAndMaybePersistStoryValidation(
            ctx,
            args.story,
            focus,
            authoritative,
            built?.identity,
            authoritative.commands,
            authoritative.commandExecutions,
            authoritative.allPass,
          );
          return respond(decorated);
        }
        const causalPreflightGate = args.story
          ? createValidationCausalPreflightGate(ctx, args.story, [identityCommand], projectRoot)
          : undefined;
        const validation = await runValidateFile(causalPreflightGate?.beforeLaunch);
        const commandResult = validation.commands[0];
        const { code, output } = commandResult;
        if (dynamicValidation?.manifest) {
          const manifest = dynamicValidation.manifest as ValidationSelectionManifest;
          const commandId = manifest.rows[0]?.commandId;
          const instrumentedOrder = commandId ? [commandId] : [];
          const commandIds = manifest.rows.map((row) => row.commandId);
          const observeOracle = dynamicMode === 'observe' ? runObserveOracle({
            manifest,
            fullOracle: { allPass: code === 0, failedCommandIds: code === 0 || !commandId ? [] : [commandId] },
            instrumentedOrder,
            authoritativeOrder: commandIds,
          }) : undefined;
          dynamicValidation = {
            ...dynamicValidation,
            fullPlanAllPass: code === 0,
            oracleStatus: 'executed',
            report: `${dynamicValidation.report || ''}\nvalidate-file runtime trace: ${JSON.stringify({
              events: commandResult.runtimeTrace?.events || [],
              readPaths: commandResult.runtimeTrace?.readPaths || [],
              loadedPaths: commandResult.runtimeTrace?.loadedPaths || [],
              spawnedPaths: commandResult.runtimeTrace?.spawnedPaths || [],
              registryKeys: commandResult.runtimeTrace?.registryKeys || [],
              environmentKeys: commandResult.runtimeTrace?.environmentKeys || [],
              unknownRuntimeInputs: commandResult.runtimeTrace?.unknownRuntimeInputs || [],
            })}`,
            ...(observeOracle ? { observeOracle, verdictEquivalent: observeOracle.equivalent } : {
              verdictEquivalent: dynamicValidation.selectedAllPass === undefined ? undefined : dynamicValidation.selectedAllPass === (code === 0),
            }),
          };
          if (args.story && dynamicMode === 'observe') {
            const entry = (dynamicValidation.catalog as ValidationCatalogEntry[] | undefined)?.find(candidate => candidate.id === commandId);
            const closure = entry ? createValidationClosureCertificate({
              commandId: entry.id,
              baseHead: manifest.baseHead,
              inventoryDigest: manifest.inventoryDigest,
              catalogDigest: manifest.catalogDigest,
              staticPaths: entry.inputRoots,
              runtimeTrace: runtimeTraceForResult(commandResult, projectRoot),
              declaredEnvironmentKeys: entry.declaredEnvironmentKeys || Object.keys(entry.env || {}),
              processFacts: entry.triggerExtensions.processFacts,
              capabilities: entry.triggerExtensions.capabilities,
              producedBy: 'story-closure-preview',
            }) : undefined;
            const runtimeClosureInvalidCommandIds = commandId && (!closure || !verifyValidationClosureCertificate(closure)) ? [commandId] : [];
            dynamicValidation = { ...dynamicValidation, runtimeClosureInvalidCommandIds };
            const priorArtifacts = readStoryAwareValidationArtifacts(projectRoot, args.story);
            const revokedReceiptIds = priorArtifacts.receipts
              .filter((receipt) => runtimeClosureInvalidCommandIds.includes(receipt.commandId))
              .map((receipt) => receipt.id);
            const observeLedger = revokedReceiptIds.length > 0
              ? appendReceiptRevocation(priorArtifacts.revocationLedger, revokedReceiptIds)
              : priorArtifacts.revocationLedger;
            persistStoryAwareValidationArtifacts({
              projectRoot,
              storyId: args.story,
              manifest,
              report: `${dynamicValidation.report || ''}\nvalidate-file observe oracle: ${JSON.stringify(observeOracle)}\nruntime closure invalid command IDs: ${JSON.stringify(runtimeClosureInvalidCommandIds)}`,
              receipts: priorArtifacts.receipts,
              revocationLedger: observeLedger,
              preserveExistingReceipts: true,
            });
          }
        }
        const attachDynamic = <T extends Record<string, unknown>>(value: T): T => dynamicValidation ? { ...value, dynamicValidation } : value;
        // Task B-6326 + B-4b22: verifier surfaces categorized dirty ownership
        // details AND respects dirty-gate-policy. When every polluted path
        // classifies as a passing category the pollution.blocking flag is
        // flipped false and we keep status=pass.
        const pollutionDetails = formatWorktreePollutionDetails(commandResult, projectRoot, args.story);
        if (pollutionDetails.length > 0) {
          const isBlocking = commandResult.worktreePollution?.blocking !== false;
          const polluted = attachDynamic(externalResult({
            status: isBlocking ? 'fail' : 'pass',
            summary: isBlocking
              ? 'Validation command dirtied the worktree'
              : 'Validation command produced policy-allowed dirty paths (audited)',
            details: [
              ...pollutionDetails,
              ...(output.trim() ? output.trim().split('\n').filter(Boolean).map(line => `  output: ${line}`) : []),
            ],
            warnings: isBlocking ? [
              'Validation side effects are not auto-restored because tracked snapshots/docs may be legitimate review artifacts.',
            ] : [],
            headSha: currentHead(handlerGitCwd),
            commands: [commandResult],
          }));
          const focusedPolluted = focus ? markFocusedResult(polluted, focus) : polluted;
          const decorated = decorateAndMaybePersistStoryValidation(ctx, args.story, focus, focusedPolluted, built?.identity, [commandResult], 1);
          const surfaced = reuse && built ? { ...decorated, reuse: { ...reuse, identityDigest: built.identity.digest } } : decorated;
          return respond(surfaced);
        }

        if (args.json) {
          // Try to extract JSON from output (validate.ts should print JSON when --json is passed)
          const stripped = stripAnsi(output);
          // Look for JSON object in output
          const jsonMatch = stripped.match(/\{[\s\S]*"provider"\s*:\s*"[^"]+"[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            const semanticCommandPass = String(parsed?.status ?? '').trim().toLowerCase() === 'pass'
              && parsed?.allPass !== false
              && parsed?.allPassed !== false;
            const focusedParsed = focus ? markFocusedResult(parsed, focus) : parsed;
            const decorated = decorateAndMaybePersistStoryValidation(
              ctx,
              args.story,
              focus,
              attachDynamic(focusedParsed),
              built?.identity,
              [commandResult],
              1,
              semanticCommandPass,
            );
            return respond(reuse && built ? { ...decorated, reuse: { ...reuse, identityDigest: built.identity.digest } } : decorated);
          }
          // If validate.ts doesn't support --json yet, wrap the output
          let headSha: string | undefined;
          try {
            headSha = execSync('git rev-parse --short HEAD', { cwd: handlerGitCwd, encoding: 'utf-8' }).trim();
          } catch { /* not git — graceful: headSha stays undefined */ }

          const wrapped = markFocusedResult(attachDynamic({
            provider: 'proof-or-stop-verifier',
            status: code === 0 ? 'pass' : 'fail',
            allPass: code === 0,
            summary: code === 0 ? 'All checks passed' : 'Validation failed',
            details: stripped.split('\n').filter(l => l.trim()),
            warnings: [],
            timestamp: new Date().toISOString(),
            headSha,
            commands: [commandResult],
            ...(code === 0 ? {} : { failureKind: commandResult.failureKind ?? 'validation_failure' }),
          }), focus ?? '');
          const decorated = decorateAndMaybePersistStoryValidation(ctx, args.story, focus, wrapped, built?.identity, [commandResult], 1);
          return respond(reuse && built ? { ...decorated, reuse: { ...reuse, identityDigest: built.identity.digest } } : decorated);
        }

        if (args.story) {
          try {
            const cl = ctx.store.readChecklist(args.story);
            const head = currentHead(handlerGitCwd);
            const story = ctx.store.readStory(args.story);
            const effectivePolicy = resolveWorkflowPolicy(loadConfig(ctx.root), story);
            const coverage = buildVerificationCoverage(
              cl,
              head,
              (headHash, evidence) => evidenceFreshness(handlerGitCwd, projectRoot, headHash, evidence).fresh,
              {
                deferredGateEvidence: 'missing',
                evidenceQualityProfile: effectivePolicy.profile,
                receiptAdmissibility: createVerificationEvidenceGateEvaluator(projectRoot, args.story),
              },
            );
            const verificationPolicy = resolveStoryVerificationPolicy(ctx, args.story);
            const advisories = collectStoryFilesHashAdvisories(cl, handlerGitCwd, projectRoot);
            reportOutcome(code === 0 && coverage.missingRequired === 0);
            return maybePrefixFocusedText((dynamicValidation?.report ? `${dynamicValidation.report}\n` : '') + output + '\n' + renderVerificationCoverage(coverage, verificationPolicy) + (advisories.length > 0 ? `\n${advisories.join('\n')}` : '') + (code !== 0 || coverage.missingRequired > 0 ? `\n(exit code: ${code || 1})` : ''), focus);
          } catch (intentIntegrityError) { rethrowIntentAmendmentIntegrityError(intentIntegrityError);
            // If story metadata cannot be read, fall back to raw verifier output.
          }
        }
        reportOutcome(code === 0);
        return maybePrefixFocusedText((dynamicValidation?.report ? `${dynamicValidation.report}\n` : '') + output + (code !== 0 ? `\n(exit code: ${code})` : ''), focus);
      };
      return await runValidateFileAndRender();
      }));
    },

    /**
     * proof-or-stop status [--concise]
     *
     * Unified project status: story progress + Machine code status.
     * Two sections run in parallel (Promise.all).
     * --concise: skip code verification (for hook injection).
     */
    async status(args: { concise?: boolean } = {}) {
      const projectRoot = ctx.root;

      // Two tasks in parallel
      const briefTask = (async (): Promise<string> => {
        try {
          const { createSessionHandlers } = await import('./session.js');
          const sessionHandlers = createSessionHandlers(ctx);
          const brief = sessionHandlers.session_brief({ concise: true });
          return typeof brief === 'string' ? brief.trim() : '';
        } catch { return ''; }
      })();

      const verifierTask = (async (): Promise<string> => {
        if (args.concise) return '';
        const validateFile = findValidateFile(projectRoot);
        if (!validateFile) return '';

        // Try serve cache first (if proof-or-stop serve is running, result is instant)
        try {
          const { stablePort } = await import('../verifier/browser-executor.js');
          const httpPort = stablePort(projectRoot, 1);
          const res = await fetch(`http://localhost:${httpPort}/status`, { signal: AbortSignal.timeout(500) });
          if (res.ok) {
            const data = await res.json();
            if (data.validate) return '\n── Code Verification (cached) ──\n' + String(data.validate).trim();
          }
        } catch { /* serve not running, fall through */ }

        // Fallback: spawn tsx
        ctx.log?.('running: npx tsx ' + validateFile + ' --status');
        const { output, timedOut } = await runCommand('npx', ['tsx', validateFile, '--status'], projectRoot, STATUS_FALLBACK_TIMEOUT_MS);
        if (timedOut) {
          const cmd = `npx tsx ${validateFile} --status`;
          const body = [
            `✗ ${cmd} timed out after ${Math.round(STATUS_FALLBACK_TIMEOUT_MS / 1000)}s.`,
            '  Run `proof-or-stop validate` for full diagnostics, or start `proof-or-stop serve` to use cached status.',
          ];
          if (output.trim()) body.push(...output.trim().split('\n').map(line => `  ${line}`));
          return '\n── Code Verification ──\n' + body.join('\n');
        }
        return output.trim() ? '\n── Code Verification ──\n' + output.trim() : '';
      })();

      const [brief, verifier] = await Promise.all([briefTask, verifierTask]);
      const sections = [brief, verifier].filter(s => s.length > 0);

      if (sections.length === 0) {
        return `✗ 无项目状态可显示\n  当前目录: ${projectRoot}`;
      }
      return sections.join('\n');
    },

    /**
     * proof-or-stop serve [--dev="..."] [--port=N]
     *
     * Start HTTP API server for real-time debugging.
     * This is a long-running process, so we spawn it and return the startup info.
     */
    async serve(args: {
      dev?: string;
      port?: number;
      circuit?: boolean;
    }) {
      const projectRoot = ctx.root;

      // Look for serve.ts in project root first, then use verifier's built-in serve
      const serveFiles = ['serve.ts', 'serve.js'];
      let serveFile: string | null = null;
      for (const f of serveFiles) {
        if (existsSync(join(projectRoot, f))) {
          serveFile = f;
          break;
        }
      }

      const tsArgs: string[] = [];
      if (serveFile) {
        tsArgs.push(serveFile);
      } else {
        // Use the verifier's built-in serve module
        // Find it relative to the core package
        const verifierServe = join(__dirname, '..', 'verifier', 'serve.js');
        if (!existsSync(verifierServe)) {
          return `✗ 找不到 serve.ts（项目根目录）或内建 verifier serve 模块\n  当前目录: ${projectRoot}`;
        }
        tsArgs.push(verifierServe);
      }

      if (args.dev) tsArgs.push(`--dev=${args.dev}`);
      if (args.port) tsArgs.push(`--port=${args.port}`);
      if (args.circuit) tsArgs.push('--circuit');

      // Spawn as detached process
      const child = spawn('npx', ['tsx', ...tsArgs], {
        cwd: projectRoot,
        shell: true,
        stdio: 'inherit',
        detached: false,
      });

      // Keep the process running (this handler won't return until killed)
      return new Promise<string>((resolveP) => {
        child.on('close', (code: number | null) => {
          resolveP(`serve exited with code ${code}`);
        });
        child.on('error', (e: Error) => {
          resolveP(`serve failed: ${e.message}`);
        });
      });
    },
  };
}
