import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { readFileSync, realpathSync } from 'node:fs';
import {
  CAUSAL_MAX_OUTPUT_CHARS, DEFAULT_CAUSAL_SELECTOR_POLICY, causalCanonical,
  effectiveCausalEnvironment, executeCausalEvidence, preflightCausalEvidence,
  resolveCausalToolVersion, type CausalEvidenceReceiptStore, type CausalPreflightFacts,
} from './causal-evidence.js';
import { normalizeRoutineValidationCommand } from './validation-evidence-reuse.js';
import type { ValidationCommand, ValidationCommandResult } from './validation-types.js';

export interface SharedValidationExecutionContext {
  storyId: string;
  receiptStore: CausalEvidenceReceiptStore;
  probe: (input: { command: string; cwd: string; timeoutMs: number }) => CausalPreflightFacts;
}
const contexts = new AsyncLocalStorage<SharedValidationExecutionContext>();
export function withSharedValidationExecutions<T>(context: SharedValidationExecutionContext | undefined, fn: () => T): T {
  return context ? contexts.run(context, fn) : fn();
}

/** Diagnostic only: reasons never grant authority or weaken existing policy. */
export function sharedValidationReusePolicy(command: ValidationCommand): {eligible:boolean;reason:string} {
  const proof = command as ValidationCommand & { requiresBuildProof?: unknown; providesBuildProof?: unknown; proof?: unknown };
  if (proof.requiresBuildProof || proof.providesBuildProof || proof.proof) return {eligible:false,reason:'build_proof_required'};
  if (command.fullBaselineReusePolicy === 'forbidden') return {eligible:false,reason:'policy_forbidden'};
  if (command.closurePolicy === 'never-reuse') return {eligible:false,reason:'policy_never_reuse'};
  if (command.riskTier === 'gate' || command.riskTier === 'validation-infra') return {eligible:false,reason:'policy_risk_tier'};
  if (command.executionReuse !== 'exact-inputs') return {eligible:false,reason:'not_opted_in'};
  if (!Array.isArray(command.executionInputs) || !command.executionInputs.every(path => typeof path === 'string' && path.trim().length > 0)) return {eligible:false,reason:'inputs_undeclared'};
  return {eligible:true,reason:'eligible'};
}
export function sharedValidationReuseAllowed(command: ValidationCommand): boolean {
  return sharedValidationReusePolicy(command).eligible;
}

export async function executeSharedValidationCommand(
  command: ValidationCommand, projectRoot: string, timeoutMs: number,
  run: () => Promise<ValidationCommandResult>, explicitContext?: SharedValidationExecutionContext, assertActive: () => void = () => {},
): Promise<ValidationCommandResult> {
  const context = explicitContext ?? contexts.getStore();
  const executeWithoutReuse = async (reason: string): Promise<ValidationCommandResult> => ({
    ...await run(), executionDecision: {disposition:'executed',reason},
  });
  const policy = sharedValidationReusePolicy(command);
  if (!policy.eligible) return executeWithoutReuse(policy.reason);
  if (!context) return executeWithoutReuse('shared_context_unavailable');
  assertActive();
  const normalized = normalizeRoutineValidationCommand({projectRoot,command:{...command,timeoutMs}});
  if (!normalized.executableDigest || (normalized.shell && !normalized.shellExecutableDigest)) return executeWithoutReuse('executable_identity_unavailable');
  const input = { command: causalCanonical({command:command.command,args:command.args,shell:normalized.shell}), cwd:normalized.cwd, timeoutMs };
  const probe = () => context.probe(input);
  const initial = probe();
  const additionalInputs = () => command.executionInputs!.map(path => {
    const actual = realpathSync(resolve(normalized.cwd,path));
    return {path:actual,digest:createHash('sha256').update(readFileSync(actual)).digest('hex')};
  });
  let inputFiles: ReturnType<typeof additionalInputs>;
  try { inputFiles=additionalInputs(); } catch { return executeWithoutReuse('input_unreadable'); }
  // Bind uncommitted source/index changes as well as committed material. Unknown
  // Git state refuses reuse; it does not manufacture a complete identity.
  const workspaceState = () => {
    const status = execFileSync('git',['status','--porcelain=v1','--untracked-files=all'],{cwd:normalized.cwd,encoding:'utf8'});
    const diff = execFileSync('git',['diff','--binary','HEAD'],{cwd:normalized.cwd,encoding:'utf8',maxBuffer:16*1024*1024});
    return createHash('sha256').update(status).update('\0').update(diff).digest('hex');
  };
  let workspace: string;
  try { workspace=workspaceState(); } catch { return executeWithoutReuse('workspace_identity_unavailable'); }
  // Untracked file bytes are not covered by git diff. A dirty workspace cannot
  // publish or consume shared results, even if an ordinary execution is allowed.
  if (execFileSync('git',['status','--porcelain=v1','--untracked-files=all'],{cwd:normalized.cwd,encoding:'utf8'}).trim()) return executeWithoutReuse('workspace_dirty');
  const unchanged = () => causalCanonical(probe()) === causalCanonical(initial) && workspaceState() === workspace && causalCanonical(additionalInputs()) === causalCanonical(inputFiles);
  const {label: _label, optional: _optional, focus: _focus, ...execution} = normalized;
  const identity = {
    storyId:context.storyId, cwd:normalized.cwd,
    command:{executable:command.command,args:command.args,shell:normalized.shell,env:command.env},
    bootstrap:{executable:'proof-or-stop',args:['shared-validation-execution-v1']},
    inputs:{execution,workspace,inputFiles,materialHash:initial.gitMaterial?.materialHash,
      policy:{executionReuse:command.executionReuse,closurePolicy:command.closurePolicy ?? null,
        fullBaselineReusePolicy:command.fullBaselineReusePolicy ?? null,riskTier:command.riskTier ?? null,
        resources:command.resources ?? null}},
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
      fresh=await run();
      return {code:fresh.code,output:fresh.output,timedOut:fresh.timedOut,durationMs:fresh.durationMs,timeoutMs:fresh.timeoutMs,
        partial:Boolean(fresh.worktreePollution?.paths.length) || fresh.output.length > CAUSAL_MAX_OUTPUT_CHARS || !unchanged()};
    },
  });
  assertActive();
  if (!unchanged()) throw new Error('shared validation inputs changed before publication');
  const executionReceipt={executionKey:causal.key.key,receiptHash:causal.receipt.receiptHash,
    disposition:causal.disposition,executedAt:causal.receipt.executedAt};
  if (fresh) return {...fresh,executionReceipt,executionDecision:{disposition:'executed',
    reason:!causal.key.reusable ? 'identity_incomplete' : causal.receipt.reusable ? 'no_matching_receipt' : fresh.code !== 0 ? 'execution_failed' : 'result_not_reusable', details:causal.key.incompleteReasons}};
  if (causal.receipt.status !== 'pass' || !causal.receipt.reusable) throw new Error('shared validation refused non-PASS receipt');
  return {label:command.label,command:command.command,args:[...command.args],shell:normalized.shell,
    cwd:resolve(normalized.cwd),code:causal.receipt.exitCode,output:causal.receipt.outputProbe,
    optional:command.optional,durationMs:causal.receipt.durationMs ?? 0,timeoutMs:causal.receipt.timeoutMs,executionReceipt,executionDecision:{disposition:'reused',reason:'matching_signed_pass'}};
}
