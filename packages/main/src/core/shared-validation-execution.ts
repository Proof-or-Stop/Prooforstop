import {readValidationReuseCost,saveValidationReuseCost} from './validation-reuse-costs.js';
import { currentBuildArtifactsHash, isRegisteredPackagesMainBuildCommand, launchDirectoryDrift, type LaunchDirectoryIdentity } from './build-artifacts-identity.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { executionImplementationIdentity } from './execution-implementation.js';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute } from 'node:path';
import { readFileSync, realpathSync } from 'node:fs';
import { snapshotValidationExecutionInputs } from './validation-execution-inputs.js';
import {
  assertCausalExecutionAdmission, CAUSAL_MAX_OUTPUT_CHARS, DEFAULT_CAUSAL_SELECTOR_POLICY, causalCanonical,
  effectiveCausalEnvironment, executeCausalEvidence, preflightCausalEvidence,
  resolveCausalToolVersion, type CausalEvidenceReceiptStore, type CausalPreflightFacts,
} from './causal-evidence.js';
import { normalizeRoutineValidationCommand } from './validation-evidence-reuse.js';
import type { ValidationCommand, ValidationCommandResult } from './validation-types.js';

export interface SharedValidationExecutionContext {
  /** An execution-only hint: never authorizes receipt reuse or suppresses a gate. */
  reuseEconomics?: 'measured';
  storyId: string;
  receiptStore: CausalEvidenceReceiptStore;
  probe: (input: { command: string; cwd: string; timeoutMs: number }) => CausalPreflightFacts;
}
const uneconomicCommands = new WeakMap<SharedValidationExecutionContext, Map<string, number>>();
const contexts = new AsyncLocalStorage<SharedValidationExecutionContext>();
export function withSharedValidationExecutions<T>(context: SharedValidationExecutionContext | undefined, fn: () => T): T {
  return context ? contexts.run(context, fn) : fn();
}

/** Diagnostic reasons never expand the existing reuse permission predicate. */
export function sharedValidationReusePolicy(command: ValidationCommand, roots?: { projectRoot?: string; artifactsRoot?: string; launchCwd?: string }): { eligible: boolean; reason: string } {
  const proof = command as ValidationCommand & { requiresBuildProof?: unknown; providesBuildProof?: unknown; proof?: unknown };
  if (proof.requiresBuildProof || proof.providesBuildProof || proof.proof) return { eligible: false, reason: 'build_proof_required' };
  // A build recognised by its shape is a registered build too: its execution
  // is the proof, so it is never served from the cache. Judged with the same
  // roots and pinned directory the executor classifies with, so an absolute,
  // aliased or wrapper-root cwd form is recognised exactly as at launch.
  if (isRegisteredPackagesMainBuildCommand(command, roots?.projectRoot, roots?.artifactsRoot ?? roots?.projectRoot, roots?.launchCwd)) return { eligible: false, reason: 'registered_build' };
  if (command.fullBaselineReusePolicy === 'forbidden') return { eligible: false, reason: 'policy_forbidden' };
  if (command.closurePolicy === 'never-reuse') return { eligible: false, reason: 'policy_never_reuse' };
  if (command.riskTier === 'gate' || command.riskTier === 'validation-infra') return { eligible: false, reason: 'policy_risk_tier' };
  if (command.executionReuse !== 'exact-inputs') return { eligible: false, reason: 'not_opted_in' };
  if (!Array.isArray(command.executionInputs) || !command.executionInputs.every(path => typeof path === 'string' && path.trim().length > 0)) return { eligible: false, reason: 'inputs_undeclared' };
  return { eligible: true, reason: 'eligible' };
}
export function sharedValidationReuseAllowed(command: ValidationCommand): boolean {
  return sharedValidationReusePolicy(command).eligible;
}

export async function executeSharedValidationCommand(
  command: ValidationCommand, projectRoot: string, timeoutMs: number,
  capture: () => Promise<{ result: ValidationCommandResult; completeOutput: string }>, explicitContext?: SharedValidationExecutionContext, assertActive: () => void = () => {},
  artifactBinding?: { root: string; configRoot?: string; protection: string },
  /**
   * The CANONICAL directory the command executes in, pinned by the caller
   * before its plan's first launch. Every identity this function derives —
   * executable and environment, input snapshots, git probes, the cache key —
   * is taken in that directory, never through the declared cwd, so a receipt
   * can never describe inputs from one directory for an execution in another.
   */
  launchCwd?: string,
  /** The caller's own classification of this command as a registered build: enforced BEFORE any context, explicit or ambient, is consulted. */
  registeredBuild?: boolean,
  /** The filesystem identity bound to launchCwd when it was pinned: re-verified inside every reuse-key check and again after the awaited lookup, so a directory replaced at the same path during the lookup is never served a cached PASS. */
  launchIdentity?: LaunchDirectoryIdentity,
): Promise<ValidationCommandResult> {
  const run = async () => (await capture()).result;
  const launchDrift = (): string | undefined => (launchCwd ? launchDirectoryDrift(launchCwd, launchIdentity) : undefined);
  const refusedForDrift = (drift: string): ValidationCommandResult => ({
    label: command.label, command: command.command, args: [...command.args], ...(command.shell ? { shell: true } : {}), ...(command.cwd ? { cwd: command.cwd } : {}),
    code: 1, output: `[launch_directory_drift] ${command.label} was not served from the shared cache: ${drift}`, launchOutcome: 'not-launched',
    ...(command.optional ? { optional: true } : {}), timeoutMs, effectiveTimeoutMs: 0, failureKind: 'infra_failure', durationMs: 0,
    executionDecision: { disposition: 'executed', reason: 'launch_directory_drift' },
  });
  const executeWithoutReuse = async (reason: string): Promise<ValidationCommandResult> => ({
    ...await run(), executionDecision: { disposition: 'executed', reason },
  });
  // A registered build's execution is its proof: it never enters the cache,
  // whatever context (explicit or ambient) would otherwise serve it.
  if (registeredBuild) return executeWithoutReuse('registered_build');
  const policy = sharedValidationReusePolicy(command, { projectRoot, artifactsRoot: artifactBinding?.root, launchCwd });
  if (!policy.eligible) return executeWithoutReuse(policy.reason);
  const context = explicitContext ?? contexts.getStore();
  if (!context) return executeWithoutReuse('shared_context_unavailable');
  // The compiled artifacts the command executes and the protection it runs
  // under are inputs of the reuse key: a receipt earned against other bytes or
  // without protection is simply not a match, and a cached result inherits
  // exactly the binding it was executed with.
  const artifactBindingHash = artifactBinding ? currentBuildArtifactsHash(artifactBinding.root, artifactBinding.configRoot) : undefined;
  if (artifactBinding && !artifactBindingHash) return executeWithoutReuse('artifact_identity_unavailable');
  assertActive();
  const started = performance.now();
  const economicsKey = context.reuseEconomics === 'measured' ? causalCanonical({
    projectRoot: resolve(projectRoot), command, timeoutMs,
  }) : undefined;
  const normalized = normalizeRoutineValidationCommand({projectRoot,command:{...command,...(launchCwd ? {cwd:launchCwd} : {}),timeoutMs}});
  const observedCost = economicsKey ? (uneconomicCommands.get(context)?.get(economicsKey) ?? readValidationReuseCost(projectRoot,economicsKey)) : undefined;
  if (observedCost !== undefined) {
    // This branch runs the real command. It consumes no cached PASS and grants
    // no authority; ordinary caller gates and execution locks remain in force.
    const admission = () => assertCausalExecutionAdmission(context.probe({
      command: causalCanonical({command:command.command,args:command.args,shell:normalized.shell}), cwd:normalized.cwd, timeoutMs,
    }));
    admission();
    const result = await executeWithoutReuse('reuse_cost_exceeds_execution');
    admission();
    assertActive();
    if (result.code !== 0 || performance.now() - started >= observedCost) {
      uneconomicCommands.get(context)?.delete(economicsKey!);
      saveValidationReuseCost(projectRoot,economicsKey!,undefined);
    }
    return result;
  }
  let executionWallMs = 0;
  // Automatic producer/consumer binding: a caller cannot opt out of the
  // implementation digest while opting into reuse. Version strings alone do
  // not describe the code that actually executes this protocol.
  const implementationDigest = executionImplementationIdentity().digest;

  if (!normalized.executableDigest || (normalized.shell && !normalized.shellExecutableDigest)) return executeWithoutReuse('executable_identity_unavailable');
  const input = { command: causalCanonical({command:command.command,args:command.args,shell:normalized.shell}), cwd:normalized.cwd, timeoutMs };
  const probe = () => context.probe(input);
  const additionalInputs = () => snapshotValidationExecutionInputs(normalized.cwd, command.executionInputs!);
  let inputFiles: ReturnType<typeof additionalInputs>;
  try { inputFiles=additionalInputs(); } catch { return executeWithoutReuse('input_unreadable'); }
  // Bind uncommitted source/index changes as well as committed material. Unknown
  // Git state refuses reuse; it does not manufacture a complete identity.
  const gitRoot = realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: normalized.cwd, encoding: 'utf8' }).trim());
  const workspacePaths = () => [':/', ...(context.receiptStore.causalEvidenceOutputPaths?.(context.storyId) ?? []).flatMap(path => {
    const name = relative(gitRoot, realpathSync(path));
    return !name || name === '..' || name.startsWith('../') || isAbsolute(name) ? [] : [`:(top,exclude,literal)${name}`];
  })];
  const workspaceStatus = () => execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...workspacePaths()], { cwd: normalized.cwd, encoding: 'utf8' });
  const workspaceState = () => {
    const status = workspaceStatus();
    const diff = execFileSync('git',['diff','--binary','HEAD','--',...workspacePaths()],{cwd:normalized.cwd,encoding:'utf8',maxBuffer:16*1024*1024});
    return createHash('sha256').update(status).update('\0').update(diff).digest('hex');
  };
  let workspace: string;
  try { workspace=workspaceState(); } catch { return executeWithoutReuse('workspace_identity_unavailable'); }
  // Untracked file bytes are not covered by git diff. A dirty workspace cannot
  // publish or consume shared results, even if an ordinary execution is allowed.
  if (workspaceStatus()) return executeWithoutReuse('workspace_dirty');
  // git status may refresh index stat caches. Freeze raw index facts only after
  // the clean-workspace probe has completed its own legitimate refresh.
  const initial = probe();
  // Only the already captured baseline is constant during this invocation.
  // Every later observation still rereads live facts and input bytes.
  const initialCanonical = causalCanonical(initial);
  const inputFilesCanonical = causalCanonical(inputFiles);
  const unchanged = () => {
    try {
      // The pinned launch directory is a reuse-key input like any other: a
      // directory replaced at the same path (new inode) is not the directory
      // the receipt was earned in, whatever Git and the input bytes say.
      return launchDrift() === undefined && causalCanonical(probe()) === initialCanonical && workspaceState() === workspace
        && causalCanonical(additionalInputs()) === inputFilesCanonical
        && executionImplementationIdentity().digest === implementationDigest
        // The compiled artifacts are a reuse-key input like any other: a tree
        // that moved since the key was built makes every later step stale.
        && (!artifactBinding || currentBuildArtifactsHash(artifactBinding.root, artifactBinding.configRoot) === artifactBindingHash);
    } catch { return false; }
  };
  const {label: _label, optional: _optional, focus: _focus, ...execution} = normalized;
  const identity = {
    storyId:context.storyId, cwd:normalized.cwd,
    command:{executable:command.command,args:command.args,shell:normalized.shell,env:command.env},
    bootstrap:{executable:'proof-or-stop',args:['shared-validation-execution-v2-complete-capture']},
    inputs:{execution,workspace,inputFiles,implementationDigest,materialHash:initial.gitMaterial?.materialHash,
      policy:{executionReuse:command.executionReuse,closurePolicy:command.closurePolicy ?? null,
        fullBaselineReusePolicy:command.fullBaselineReusePolicy ?? null,riskTier:command.riskTier ?? null,
        resources:command.resources ?? null},
      // Inside `inputs`: the key builder hashes its declared fields only, so
      // a binding placed beside them would be silently ignored (it was, once).
      artifactBinding:artifactBinding ? {hash:artifactBindingHash,protection:artifactBinding.protection} : null},
    storyFilesHash:initial.gitMaterial?.storyFilesHash,
    effectiveEnvironment:effectiveCausalEnvironment(command.env,normalized.cwd),
    runtimeVersion:process.version,toolVersion:resolveCausalToolVersion(projectRoot),selectorPolicy:DEFAULT_CAUSAL_SELECTOR_POLICY,
  };
  const preflight=preflightCausalEvidence(initial,unchanged,identity);
  if (!preflight.ready) throw new Error(`shared validation preflight refused: ${preflight.failedChecks.join(', ')}`);
  // Check before BOTH reuse and execution. executeCausalEvidence also rechecks
  // immediately before a child launch under its cross-request single flight.
  if (!unchanged()) throw new Error('shared validation inputs changed before consumption');
  let fresh: ValidationCommandResult | undefined;
  const causal=await executeCausalEvidence({identity,selector:'',receiptStore:context.receiptStore,preflight,revalidateBeforeRun:unchanged,
    run:async()=>{
      const executionStarted = performance.now();
      const captured = await capture();
      fresh = captured.result;
      executionWallMs = performance.now() - executionStarted;
      // Receipt identity belongs to complete execution bytes, never the bounded display.
      return {code:fresh.code,output:captured.completeOutput,timedOut:fresh.timedOut,durationMs:fresh.durationMs,timeoutMs:fresh.timeoutMs,
        // A run that changed the compiled artifacts is never reusable: a later
        // consumer would inherit a binding its own trees no longer match.
        partial:Boolean(fresh.worktreePollution?.paths.length) || captured.completeOutput.length > CAUSAL_MAX_OUTPUT_CHARS || !unchanged()
          || Boolean(fresh.buildArtifactsBefore && fresh.buildArtifactsAfter && fresh.buildArtifactsBefore !== fresh.buildArtifactsAfter)
          // A receipt is published under the key's artifact identity and
          // protection label, so the executed run must have observed exactly
          // those: both observations present and equal to the key hash, and
          // the label the capture recorded equal to the one the key names.
          || Boolean(artifactBinding && (fresh.buildArtifactsBefore !== artifactBindingHash || fresh.buildArtifactsAfter !== artifactBindingHash || fresh.buildArtifactsProtection !== artifactBinding.protection))};
    },
  });
  assertActive();
  // Immediately after the awaited lookup: a directory replaced while the
  // lookup was pending is refused, bounded, before any cached PASS is served.
  { const drift = launchDrift(); if (drift && !fresh) return refusedForDrift(drift); }
  if (!unchanged()) throw new Error('shared validation inputs changed before publication');
  if (economicsKey && fresh?.code === 0 && causal.receipt.reusable) {
    const overhead = performance.now() - started - executionWallMs;
    if (overhead > executionWallMs * 2) {
      let observations = uneconomicCommands.get(context);
      if (!observations) { observations = new Map(); uneconomicCommands.set(context, observations); }
      if (observations.size >= 128) observations.delete(observations.keys().next().value!);
      observations.set(economicsKey, overhead);
      saveValidationReuseCost(projectRoot,economicsKey,overhead);
    }
  }
  const executionReceipt={executionKey:causal.key.key,receiptHash:causal.receipt.receiptHash,
    disposition:(fresh ? 'executed' : 'reused') as 'executed' | 'reused',executedAt:causal.receipt.executedAt};
  if (fresh) return {...fresh,executionReceipt,executionDecision:{disposition:'executed',reason:causal.receipt.reusable ? 'no_matching_receipt' : fresh.code !== 0 ? 'execution_failed' : 'result_not_reusable'}};
  if (causal.receipt.status !== 'pass' || !causal.receipt.reusable) throw new Error('shared validation refused non-PASS receipt');
  return {label:command.label,command:command.command,args:[...command.args],shell:normalized.shell,
    cwd:resolve(normalized.cwd),launchCwd:normalized.cwd,code:causal.receipt.exitCode,output:causal.receipt.outputProbe,
    optional:command.optional,durationMs:causal.receipt.durationMs ?? 0,timeoutMs:causal.receipt.timeoutMs,executionReceipt,executionDecision:{disposition:'reused',reason:'matching_receipt'},
    // Derived from the reuse key, which the executed run matched exactly: the
    // artifacts it ran against equal the artifacts on disk now, and its
    // protection label is the one the caller demanded.
    ...(artifactBinding ? {buildArtifactsBefore:artifactBindingHash,buildArtifactsAfter:artifactBindingHash,buildArtifactsProtection:artifactBinding.protection} : {})};
}
