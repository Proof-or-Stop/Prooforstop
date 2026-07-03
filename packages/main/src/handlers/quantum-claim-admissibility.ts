import { readFileSync } from 'node:fs';
import type { HandlerContext } from './context.js';
import {
  QUANTUM_CLAIM_CHECK_CASES,
  buildQuantumClaimCheckCase,
  evaluateQuantumClaimGatePolicy,
  renderQuantumClaimGatePolicyText,
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
  evidenceJson?: string;
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
  productionDone?: never;
  authorityDone?: never;
  fullAuthorityDone?: never;
}

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
  'productionDone',
  'authorityDone',
  'fullAuthorityDone',
] as const;

function wantsJson(args: FormatArgs = {}): boolean {
  return args.json === true || args.format === 'json';
}

function assertReadOnlyBoundary(command: string, args: Record<string, unknown>): void {
  const rejected = UNSUPPORTED_FLAGS.filter((flag) => Object.prototype.hasOwnProperty.call(args, flag));
  if (rejected.length === 0) return;
  throw new Error(`${command} refuses unsupported side effects or overclaims: ${rejected.join(', ')}.`);
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function isQuantumClaimCheckCase(value: string): value is QuantumClaimCheckCase {
  return (QUANTUM_CLAIM_CHECK_CASES as readonly string[]).includes(value);
}

function evidenceFromArgs(args: QuantumClaimCheckArgs): QuantumClaimCheckInput {
  if (args.evidenceJson) return parseJsonObject(args.evidenceJson, 'evidenceJson') as unknown as QuantumClaimCheckInput;
  if (args.evidencePath) return parseJsonObject(readFileSync(args.evidencePath, 'utf-8'), 'evidencePath') as unknown as QuantumClaimCheckInput;
  const caseName = args.case ?? 'complete';
  if (!isQuantumClaimCheckCase(caseName)) {
    throw new Error(`Unknown quantum claim check case: ${caseName}`);
  }
  return buildQuantumClaimCheckCase(caseName, args.claimId ?? 'Q5');
}

export function createQuantumClaimAdmissibilityHandlers(_ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  return {
    quantum_claim_check(args: QuantumClaimCheckArgs = {}) {
      assertReadOnlyBoundary('quantum_claim_check', args as Record<string, unknown>);
      const input = evidenceFromArgs(args);
      if (args.requestedStrength) {
        input.requestedStrength = args.requestedStrength;
      }
      const result = evaluateQuantumClaimGatePolicy(input);
      return wantsJson(args) ? result : renderQuantumClaimGatePolicyText(result);
    },
  };
}
