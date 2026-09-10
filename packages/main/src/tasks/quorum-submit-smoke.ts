#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertQuorumSmokeTraceSinksExternal,
  createQuorumSmokeRegistry,
  resolveQuorumSmokeSelection,
  type QuorumSmokeCaseRegistration,
} from './quorum-submit-smoke-case-catalog.js';
import { QUORUM_SMOKE_CASES as PURE_QUORUM_SMOKE_CASES } from './quorum-submit-smoke-pure-cases.js';
import {
  QUORUM_SMOKE_CASES as INTEGRATION_QUORUM_SMOKE_CASES,
  runQuorumSmokeDynCase,
} from './quorum-submit-smoke-integration-cases.js';
import { QUORUM_SMOKE_CASES as PRUNE_QUORUM_SMOKE_CASES } from './quorum-submit-smoke-prune-cases.js';
import { runQuorumSmokeCoordinator } from './quorum-submit-smoke-worker.js';

interface QuorumSmokeMainOptions {
  argv: readonly string[];
  registrations: readonly QuorumSmokeCaseRegistration[];
  coordinator: (options: {
    registrations: readonly QuorumSmokeCaseRegistration[];
    jobs: number;
    timeoutMs: number;
    context?: Record<string, any>;
  }) => Promise<Record<string, any>>;
  reportSink: (report: unknown) => void;
  context: Record<string, any>;
}

// qsm-022 deliberately re-evaluates every REVIEW/quorum consumer after each
// signed-envelope mutation.  On the same host it has been observed at
// 93-125 seconds, so the old 90-second default could time out a passing case.
// Keep the watchdog bounded while leaving headroom for this real integration
// workload and concurrent shard execution.
export const DEFAULT_QUORUM_SMOKE_CASE_TIMEOUT_MS = 180_000;

function numericArgument(argv: readonly string[], prefix: string, fallback: number): number {
  const raw = argv.find((argument) => argument.startsWith(prefix));
  if (!raw) return fallback;
  const value = Number(raw.slice(prefix.length));
  if (!Number.isInteger(value) || value <= 0) throw new Error(`ERROR: invalid ${prefix}${value}; zero cases executed`);
  return value;
}

function listCases(registrations: readonly QuorumSmokeCaseRegistration[]): void {
  const rows = registrations.map((row) => ({
    id: row.id,
    title: row.title,
    domain: row.domain,
    shard: row.shard,
    callbackBound: row.callbackBound === true,
    registrationSource: row.registrationSource,
    capabilities: row.capabilities ?? [],
    resources: row.resources ?? [],
  }));
  console.log(`QUORUM_SMOKE_CASES_JSON ${JSON.stringify(rows)}`);
}

function reportJson(report: unknown): string {
  return JSON.stringify(report, (_key, value) => value instanceof Error
    ? { name: value.name, message: value.message }
    : value);
}

export async function runQuorumSmokeMain({
  argv,
  registrations,
  coordinator,
  reportSink,
  context,
}: QuorumSmokeMainOptions): Promise<unknown> {
  assertQuorumSmokeTraceSinksExternal([
    { path: process.env.PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_FILE, label: 'quorum smoke callback trace' },
    { path: process.env.PROOF_OR_STOP_QUORUM_SMOKE_FIXTURE_TRACE_FILE, label: 'quorum smoke fixture trace' },
    { path: process.env.PROOF_OR_STOP_QUORUM_SMOKE_RESOURCE_TRACE_FILE, label: 'quorum smoke resource trace' },
  ]);
  const dynCase = process.env.PROOF_OR_STOP_DYN5_CASE;
  let selection;
  if (dynCase) {
    const registration: QuorumSmokeCaseRegistration = Object.freeze({
      id: dynCase,
      title: `DYN-5 ${dynCase}`,
      domain: 'integration',
      shard: 'integration-a',
      resources: [],
      callbackBound: true,
      registrationSource: 'packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts',
      run: async () => runQuorumSmokeDynCase(dynCase),
    });
    selection = {
      selectedCases: [registration],
      selectedCaseIds: [dynCase],
      mode: argv.some(argument => argument.startsWith('--worker-')) ? 'worker' as const : 'aggregate' as const,
      listOnly: false,
    };
  } else {
    try {
      selection = resolveQuorumSmokeSelection({ argv, cases: registrations });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
  if (selection.listOnly && argv.includes('--list-cases=json')) {
    listCases(registrations);
    return undefined;
  }
  if (selection.deprecatedGrepCaseId) {
    console.error(`DEPRECATED: --grep; use --case=${selection.deprecatedGrepCaseId}`);
  }
  const jobs = dynCase ? 1 : numericArgument(argv, '--jobs=', 1);
  const timeoutMs = numericArgument(
    argv,
    '--case-timeout-ms=',
    dynCase ? 120_000 : DEFAULT_QUORUM_SMOKE_CASE_TIMEOUT_MS,
  );
  const runId = process.env.PROOF_OR_STOP_QUORUM_SMOKE_RUN_ID;
  const callbackFile = process.env.PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_FILE;
  const callbackNonce = process.env.PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_NONCE;
  const inheritedFaultKind = process.env.PROOF_OR_STOP_QUORUM_SMOKE_FAULT_KIND;
  const inheritedFaultCaseId = process.env.PROOF_OR_STOP_QUORUM_SMOKE_FAULT_CASE_ID;
  const fault = selection.fault ?? (inheritedFaultKind && inheritedFaultCaseId
    ? { kind: inheritedFaultKind, caseId: inheritedFaultCaseId }
    : undefined);
  const result = await coordinator({
    registrations: selection.selectedCases,
    jobs,
    timeoutMs,
    context: {
      ...context,
      mode: selection.mode,
      ...(selection.shardId ? { shardId: selection.shardId } : {}),
      ...(fault ? { fault } : {}),
      ...(runId ? { runId } : {}),
      ...(callbackFile && callbackNonce ? { callbackTrace: { file: callbackFile, nonce: callbackNonce } } : {}),
      ...(context.cli ? { execution: 'cli' } : {}),
    },
  });
  reportSink(result);
  if (context.cli && !(result as Record<string, unknown>).ok && !process.exitCode) process.exitCode = 1;
  if (context.cli && (result as Record<string, unknown>).ok
    && !argv.some((argument) => /^--(?:case|grep|shard|worker-case|worker-shard|coordinator-fault)=/.test(argument))) {
    console.log(`\n✓ quorum_submit smoke passed (${selection.selectedCases.length} checks)`);
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runQuorumSmokeMain({
    argv: process.argv.slice(2),
    registrations: createQuorumSmokeRegistry(PURE_QUORUM_SMOKE_CASES, INTEGRATION_QUORUM_SMOKE_CASES, PRUNE_QUORUM_SMOKE_CASES),
    coordinator: runQuorumSmokeCoordinator,
    reportSink: (report) => console.log(`QUORUM_SMOKE_RUN_JSON ${reportJson(report)}`),
    context: { cli: true },
  });
}
