import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute } from 'node:path';
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

/** Explicit reuse is subordinate to existing never-reuse and build policies. */
export function sharedValidationReuseAllowed(command: ValidationCommand): boolean {
  const proof = command as ValidationCommand & { requiresBuildProof?: unknown; providesBuildProof?: unknown; proof?: unknown };
  return command.executionReuse === 'exact-inputs'
    && Array.isArray(command.executionInputs) && command.executionInputs.every(path => typeof path === 'string' && path.trim().length > 0)
    && command.fullBaselineReusePolicy !== 'forbidden'
    && command.closurePolicy !== 'never-reuse'
    && command.riskTier !== 'gate' && command.riskTier !== 'validation-infra'
    && !proof.requiresBuildProof && !proof.providesBuildProof && !proof.proof;
}

export async function executeSharedValidationCommand(
  command: ValidationCommand, projectRoot: string, timeoutMs: number,
  run: () => Promise<ValidationCommandResult>, explicitContext?: SharedValidationExecutionContext, assertActive: () => void = () => {},
): Promise<ValidationCommandResult> {
  const context = explicitContext ?? contexts.getStore();
  if (!context || !sharedValidationReuseAllowed(command)) return run();
  assertActive();
  const normalized = normalizeRoutineValidationCommand({projectRoot,command:{...command,timeoutMs}});
  if (!normalized.executableDigest || (normalized.shell && !normalized.shellExecutableDigest)) return run();
  const input = { command: causalCanonical({command:command.command,args:command.args,shell:normalized.shell}), cwd:normalized.cwd, timeoutMs };
  const probe = () => context.probe(input);
  const initial = probe();
  const additionalInputs = () => command.executionInputs!.map(path => {
    const actual = realpathSync(resolve(normalized.cwd,path));
    return {path:actual,digest:createHash('sha256').update(readFileSync(actual)).digest('hex')};
  });
  let inputFiles: ReturnType<typeof additionalInputs>;
  try { inputFiles=additionalInputs(); } catch { return run(); }
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
  try { workspace=workspaceState(); } catch { return run(); }
  // Untracked file bytes are not covered by git diff. A dirty workspace cannot
  // publish or consume shared results, even if an ordinary execution is allowed.
  if (workspaceStatus()) return run();
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
  if (fresh) return {...fresh,executionReceipt};
  if (causal.receipt.status !== 'pass' || !causal.receipt.reusable) throw new Error('shared validation refused non-PASS receipt');
  return {label:command.label,command:command.command,args:[...command.args],shell:normalized.shell,
    cwd:resolve(normalized.cwd),code:causal.receipt.exitCode,output:causal.receipt.outputProbe,
    optional:command.optional,durationMs:causal.receipt.durationMs ?? 0,timeoutMs:causal.receipt.timeoutMs,executionReceipt};
}
