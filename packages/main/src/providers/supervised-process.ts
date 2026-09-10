import { SUPERVISED_PROVIDER_RUNTIME_POLICY } from '../core/runtime-fact-registry.js';
/** Synchronous API over a process-group owner with an independent control pipe. */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { acquireProviderProcessAdmission, releaseProviderProcessAdmission, type ProviderProcessAdmission } from '../core/provider-process-admission.js';

export interface SupervisedProcessOptions {
  cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; stdin?: string;
  admission?: ProviderProcessAdmission;
}
export interface SupervisedProcessOutcome {
  status: number | null; stdout: string; stderr: string; signal?: NodeJS.Signals | null;
  error?: NodeJS.ErrnoException; replacementSafe?: boolean; timedOut?: boolean;
}

export function runSupervisedProviderProcess(binary: string, argv: string[], options: SupervisedProcessOptions): SupervisedProcessOutcome {
  const admission = options.admission ?? acquireProviderProcessAdmission({ root: options.cwd, env: options.env,
    host: binary, storyId: null, agentType: 'bounded-provider' });
  if (!admission.admitted) return { status: null, stdout: '', stderr: '', error: Object.assign(new Error('provider concurrency cap exceeded'), { code: 'EBUSY' }), replacementSafe: true };
  if (admission.supervisedLifecycle?.replacementSafe === false) return { status: null, stdout: '', stderr: '',
    error: Object.assign(new Error('previous provider group cleanup unproven'), { code: 'ECLEANUP' }), replacementSafe: false, timedOut: false };
  admission.supervisedLifecycle = { replacementSafe: false };
  const nonce = randomUUID();
  try {
    const bridge = spawnSync(process.execPath, [fileURLToPath(new URL('./supervised-process-worker.js', import.meta.url))], {
      cwd: options.cwd, ...{ detached: true }, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      // Provider environment and credentials travel on stdin, never argv or a file.
      input: JSON.stringify({ nonce, binary, argv, options, admission }),
      timeout: Math.max(1, options.timeoutMs) + SUPERVISED_PROVIDER_RUNTIME_POLICY.parentGraceMs, killSignal: 'SIGKILL', maxBuffer: SUPERVISED_PROVIDER_RUNTIME_POLICY.maxOutputBytes * 3,
    });
    let record: { nonce: string; pid: number; outcome: SupervisedProcessOutcome } | undefined;
    try { record = JSON.parse(String(bridge.output[3] ?? '')); } catch { /* No control proof means retain capacity. */ }
    const groupGone = (pid: number): boolean => {
      if (!Number.isSafeInteger(pid) || pid <= 1 || process.platform === 'win32') return false;
      try { process.kill(-pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    };
    if (record?.nonce === nonce && record.pid === bridge.pid && record.outcome && bridge.status === 0) {
      const safe = record.outcome.replacementSafe === true && groupGone(bridge.pid);
      admission.supervisedLifecycle.replacementSafe = safe;
      const error = record.outcome.error;
      return { ...record.outcome, replacementSafe: safe,
        ...(!safe ? { status: null, error: Object.assign(new Error('provider process group cleanup unproven'), { code: 'ECLEANUP' }) } : {}),
        ...(error ? { error: Object.assign(new Error(error.message), { code: error.code }) } : {}) };
    }
    // Even a bridge killed by timeout cannot authorize a retry over its old group.
    return { status: null, stdout: '', stderr: '', signal: bridge.signal,
      timedOut: (bridge.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT',
      error: Object.assign(new Error('provider supervisor did not return a valid control result'), { code: (bridge.error as NodeJS.ErrnoException | undefined)?.code ?? 'ESUPERVISOR' }), replacementSafe: false };
  } finally {
    if (!options.admission) releaseProviderProcessAdmission(admission);
  }
}
