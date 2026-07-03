import { readFileSync } from 'node:fs';
import type { HandlerContext } from './context.js';
import {
  QUANTUM_CLAIM_IDS,
  QUANTUM_CLAIM_CHECK_CASES,
  QUANTUM_RETIRED_BOUNDARY_FIELD_NAMES,
  QUANTUM_REQUESTED_STRENGTHS,
  buildQuantumClaimReport,
  buildQuantumClaimCheckCase,
  evaluateQuantumClaimGatePolicy,
  renderQuantumBenchmarkText,
  renderQuantumClaimReportText,
  renderQuantumClaimGatePolicyText,
  runQuantumClaimBenchmark,
  type QuantumClaimCheckCase,
  type QuantumClaimCheckInput,
  type QuantumClaimId,
  type QuantumRequestedStrength,
} from '../core/claim-admissibility/quantum.js';

interface FormatArgs {
  format?: 'text' | 'json';
  json?: boolean;
}

interface QuantumClaimCheckArgs extends FormatArgs {
  claimId?: QuantumClaimId;
  case?: QuantumClaimCheckCase;
  evidenceJson?: string | Record<string, unknown>;
  evidencePath?: string;
  requestedStrength?: QuantumRequestedStrength;
  runCommands?: never;
  writeEvidence?: never;
  advancePhase?: never;
  launchReviewers?: never;
  write?: never;
  apply?: never;
  execute?: never;
  run?: never;
  launch?: never;
  capture?: never;
  refresh?: never;
  quantumTheoryClaim?: never;
  physicalValidationClaim?: never;
  hardwareValidationClaim?: never;
  solverImprovementClaim?: never;
  productionClaim?: never;
  authorityClaim?: never;
  productionReadyClaim?: never;
}

interface QuantumBenchmarkArgs extends FormatArgs {
  runCommands?: never;
  writeEvidence?: never;
  advancePhase?: never;
  launchReviewers?: never;
  write?: never;
  apply?: never;
  execute?: never;
  run?: never;
  launch?: never;
  capture?: never;
  refresh?: never;
  quantumTheoryClaim?: never;
  physicalValidationClaim?: never;
  hardwareValidationClaim?: never;
  solverImprovementClaim?: never;
  productionClaim?: never;
  authorityClaim?: never;
  productionReadyClaim?: never;
}

interface QuantumReportArgs extends QuantumBenchmarkArgs {}

const UNSUPPORTED_FLAGS = [
  'runCommands',
  'writeEvidence',
  'advancePhase',
  'launchReviewers',
  'write',
  'apply',
  'execute',
  'run',
  'launch',
  'capture',
  'refresh',
  'quantumTheoryClaim',
  'physicalValidationClaim',
  'hardwareValidationClaim',
  'solverImprovementClaim',
  'productionClaim',
  'authorityClaim',
  'productionReadyClaim',
  ...QUANTUM_RETIRED_BOUNDARY_FIELD_NAMES,
] as const;

function wantsJson(args: FormatArgs = {}): boolean {
  return args.json === true || args.format === 'json';
}

function assertReadOnlyBoundary(command: string, args: Record<string, unknown>): void {
  const rejected = UNSUPPORTED_FLAGS.filter((flag) => Object.prototype.hasOwnProperty.call(args, flag));
  if (rejected.length === 0) return;
  throw new Error(`${command} refuses unsupported side effects or overclaims: ${rejected.join(', ')}.`);
}

function parseJsonObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value === 'string' && value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty JSON object`);
  }
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function hasArg(args: QuantumClaimCheckArgs, key: keyof QuantumClaimCheckArgs): boolean {
  return Object.prototype.hasOwnProperty.call(args, key);
}

function isQuantumClaimCheckCase(value: string): value is QuantumClaimCheckCase {
  return (QUANTUM_CLAIM_CHECK_CASES as readonly string[]).includes(value);
}

function isQuantumClaimId(value: unknown): value is QuantumClaimId {
  return typeof value === 'string' && (QUANTUM_CLAIM_IDS as readonly string[]).includes(value);
}

function isQuantumRequestedStrength(value: unknown): value is QuantumRequestedStrength {
  return typeof value === 'string' && (QUANTUM_REQUESTED_STRENGTHS as readonly string[]).includes(value);
}

function assertQuantumClaimId(value: unknown): asserts value is QuantumClaimId {
  if (!isQuantumClaimId(value)) {
    throw new Error(`Unknown quantum claimId: ${String(value)}. Expected one of ${QUANTUM_CLAIM_IDS.join(', ')}.`);
  }
}

function assertQuantumRequestedStrength(value: unknown): asserts value is QuantumRequestedStrength {
  if (!isQuantumRequestedStrength(value)) {
    throw new Error(`Unknown quantum requestedStrength: ${String(value)}. Expected one of ${QUANTUM_REQUESTED_STRENGTHS.join(', ')}.`);
  }
}

function evidenceFromArgs(args: QuantumClaimCheckArgs): QuantumClaimCheckInput {
  if (hasArg(args, 'evidenceJson')) return parseJsonObject(args.evidenceJson, 'evidenceJson') as unknown as QuantumClaimCheckInput;
  if (hasArg(args, 'evidencePath')) {
    if (typeof args.evidencePath !== 'string' || args.evidencePath.trim().length === 0) {
      throw new Error('evidencePath must be a non-empty path');
    }
    return parseJsonObject(readFileSync(args.evidencePath, 'utf-8'), 'evidencePath') as unknown as QuantumClaimCheckInput;
  }
  const caseName = args.case ?? 'complete';
  if (!isQuantumClaimCheckCase(caseName)) {
    throw new Error(`Unknown quantum claim check case: ${caseName}`);
  }
  const claimId = args.claimId ?? 'Q5';
  assertQuantumClaimId(claimId);
  return buildQuantumClaimCheckCase(caseName, claimId);
}

export function createQuantumClaimAdmissibilityHandlers(_ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  return {
    quantum_claim_check(args: QuantumClaimCheckArgs = {}) {
      assertReadOnlyBoundary('quantum_claim_check', args as Record<string, unknown>);
      const input = evidenceFromArgs(args);
      if (args.requestedStrength !== undefined) {
        assertQuantumRequestedStrength(args.requestedStrength);
      }
      const effectiveInput = args.requestedStrength !== undefined ? { ...input, requestedStrength: args.requestedStrength } : input;
      const result = evaluateQuantumClaimGatePolicy(effectiveInput);
      return wantsJson(args) ? result : renderQuantumClaimGatePolicyText(result);
    },
    quantum_claim_benchmark(args: QuantumBenchmarkArgs = {}) {
      assertReadOnlyBoundary('quantum_claim_benchmark', args as Record<string, unknown>);
      const result = runQuantumClaimBenchmark();
      return wantsJson(args) ? result : renderQuantumBenchmarkText(result);
    },
    quantum_claim_report(args: QuantumReportArgs = {}) {
      assertReadOnlyBoundary('quantum_claim_report', args as Record<string, unknown>);
      const result = buildQuantumClaimReport();
      return wantsJson(args) ? result : renderQuantumClaimReportText(result);
    },
  };
}
