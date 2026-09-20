/** Durable call reservations for an explicitly named host-run budget. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { withMkdirLock } from './mkdir-lock.js';
import { HOST_RUN_BUDGET_ARTIFACT, resolveCanonicalRuntimeProjectRoot } from './runtime-artifact-registry.js';
import { HOST_RUN_BUDGET_RUNTIME_POLICY } from './runtime-fact-registry.js';
import { PROOF_OR_STOP_DIR } from './proof-or-stop-paths.js';

type Policy = { maxCalls: number; maxRepairCalls: number | null; maxPromptBytes: number | null };
type Row = { id: string; category: 'product' | 'repair'; state: 'reserved' | 'completed' | 'unknown'; input: number | null; cacheRead: number | null; output: number | null };
type State = { schema: 1; policy: Policy; rows: Row[] };
export type HostRunBudgetReservation = { file: string; id: string; policy: Policy };
const prefix = 'PROOF_OR_STOP_RUN_BUDGET_';
const accountingCount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
function refused(reason: string): never { throw new Error(`host_run_budget_refused: ${reason}`); }
function integer(raw: string | undefined, field: string, required = false): number | null {
  if (raw === undefined && !required) return null;
  const n = Number(raw);
  if (!raw || !/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n <= 0) refused(`invalid ${field}`);
  return n;
}
function readState(file: string, policy: Policy, allowNew: boolean): State {
  let text: string;
  try { text = readFileSync(file, 'utf8'); }
  catch (error) { if (allowNew && (error as NodeJS.ErrnoException).code === 'ENOENT') return { schema: 1, policy, rows: [] }; throw error; }
  if (Buffer.byteLength(text) > HOST_RUN_BUDGET_RUNTIME_POLICY.maxStateBytes) refused('state exceeds size limit');
  const state = JSON.parse(text) as State;
  if (state?.schema !== 1 || JSON.stringify(state.policy) !== JSON.stringify(policy) || !Array.isArray(state.rows)) refused('policy changed or state invalid; existing budget cannot be reset implicitly');
  const ids = new Set<string>();
  for (const row of state.rows) {
    if (!row || typeof row.id !== 'string' || ids.has(row.id) || !['product','repair'].includes(row.category)
      || !['reserved','completed','unknown'].includes(row.state)) refused('invalid reservation record');
    // Counters are descriptive provider data, never authority to release a call.
    // Recover malformed old accounting without discarding the charged reservation.
    row.input = accountingCount(row.input);
    row.cacheRead = accountingCount(row.cacheRead);
    row.output = accountingCount(row.output);
    ids.add(row.id);
  }
  return state;
}
function writeState(file: string, state: State): void {
  const text = JSON.stringify(state);
  if (Buffer.byteLength(text) > HOST_RUN_BUDGET_RUNTIME_POLICY.maxStateBytes) refused('state exceeds size limit');
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, text, { mode: 0o600, flag: 'wx' });
  renameSync(temp, file);
}
function locked<T>(file: string, body: () => T): T {
  return withMkdirLock(file + '.lock', body, { deadlineMs: HOST_RUN_BUDGET_RUNTIME_POLICY.lockTimeoutMs,
    staleMs: 60_000, pollMs: 10, requireHolderToken: true, label: 'host-run-budget' });
}
export function reserveHostRunBudget(root: string, env: NodeJS.ProcessEnv, prompt: string): HostRunBudgetReservation | null {
  const id = env[prefix+'ID'];
  if (id === undefined && !Object.keys(env).some(k => k.startsWith(prefix))) return null;
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) refused('invalid or missing ID');
  const policy: Policy = {
    maxCalls: integer(env[prefix+'MAX_CALLS'], 'MAX_CALLS', true)!,
    maxRepairCalls: integer(env[prefix+'MAX_REPAIR_CALLS'], 'MAX_REPAIR_CALLS'),
    maxPromptBytes: integer(env[prefix+'MAX_PROMPT_BYTES'], 'MAX_PROMPT_BYTES'),
  };
  const category = env[prefix+'CATEGORY'] ?? (policy.maxRepairCalls === null ? 'product' : undefined);
  if (category !== 'product' && category !== 'repair') refused('CATEGORY must explicitly be product or repair');
  if (typeof prompt !== 'string') refused('invalid prompt');
  if (policy.maxPromptBytes !== null && Buffer.byteLength(prompt, 'utf8') > policy.maxPromptBytes) refused('prompt byte ceiling exceeded; no truncation or dispatch');
  const dir = join(resolveCanonicalRuntimeProjectRoot(root), PROOF_OR_STOP_DIR, 'runtime', HOST_RUN_BUDGET_ARTIFACT.directoryName);
  mkdirSync(dir, {recursive:true});
  const file = join(dir, createHash('sha256').update(id).digest('hex')+'.json');
  return locked(file, () => {
    const state = readState(file, policy, true);
    if (state.rows.length >= policy.maxCalls) refused('total call reservations exhausted');
    if (category === 'repair' && policy.maxRepairCalls !== null && state.rows.filter(r=>r.category==='repair').length >= policy.maxRepairCalls) refused('repair call reservations exhausted');
    const reservation = {file, id:randomUUID(), policy};
    state.rows.push({id:reservation.id, category, state:'reserved', input:null, cacheRead:null, output:null});
    writeState(file,state);
    return reservation;
  });
}
export function settleHostRunBudget(reservation: HostRunBudgetReservation | null, outcome: {
  spawned: boolean; recorded: string; input: number | null; cacheRead: number | null; output: number | null;
} | null): void {
  if (!reservation) return;
  locked(reservation.file, () => {
    const state = readState(reservation.file,reservation.policy,false);
    const row = state.rows.find(r=>r.id===reservation.id);
    if (!row || row.state !== 'reserved') refused('reservation missing or already settled');
    if (outcome?.spawned === false) state.rows = state.rows.filter(r=>r.id!==reservation.id);
    else {
      row.state = outcome ? 'completed' : 'unknown';
      if (outcome?.recorded === 'provider-reported') {
        row.input=accountingCount(outcome.input); row.cacheRead=accountingCount(outcome.cacheRead); row.output=accountingCount(outcome.output);
      }
    }
    writeState(reservation.file,state);
  });
}
