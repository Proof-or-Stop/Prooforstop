import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LATTICE_DIR } from './lattice-paths.js';

export const AUTOPILOT_POLICY_SCHEMA_VERSION = 'lattice.autopilot_policy.v1' as const;
export const AUTOPILOT_POLICY_CHECK_SCHEMA_VERSION = 'lattice.autopilot_policy_check.v1' as const;

export type AutopilotMode = 'conservative' | 'authority-verified' | 'full-autopilot'; // legacy retired non-conservative modes are refused.
export type AutopilotPolicyStatus = 'authorized' | 'supervised' | 'refused';

export const AUTOPILOT_MODES: readonly AutopilotMode[] = [
  'conservative',
  'authority-verified', // legacy retired mode; refused by applyModeConstraints.
  'full-autopilot', // legacy retired mode; refused by applyModeConstraints.
] as const;

export interface AutopilotPolicyPermissions {
  allowAutoDispatch: boolean;
  allowAutoValidate: boolean;
  allowAutoFix: boolean;
  allowStoryIntegration: boolean;
  allowDoneAdvance: boolean;
  allowMainMerge: boolean;
}

export interface AutopilotPolicyBounds {
  maxIterations: number;
  maxRuntimeMinutes?: number;
  maxBudgetUSD?: number;
  stopOnConflict: boolean;
  stopOnScopeViolation: boolean;
}

export interface AutopilotModePermissionMatrixEntry {
  defaultPermissions: AutopilotPolicyPermissions;
  requireLocalAssurance: boolean;
  defaultBounds: AutopilotPolicyBounds;
  requiresFullBounds: boolean;
  receiptGatedPrivileges: readonly (keyof Pick<
    AutopilotPolicyPermissions,
    'allowStoryIntegration' | 'allowDoneAdvance' | 'allowMainMerge'
  >)[];
}

export const CONSERVATIVE_AUTOPILOT_DEFAULTS: AutopilotPolicyPermissions & AutopilotPolicyBounds & {
  requireLocalAssurance: false;
} = {
  allowAutoDispatch: true,
  allowAutoValidate: true,
  allowAutoFix: false,
  allowStoryIntegration: false,
  allowDoneAdvance: false,
  allowMainMerge: false,
  requireLocalAssurance: false,
  maxIterations: 1,
  stopOnConflict: true,
  stopOnScopeViolation: true,
};

export const AUTOPILOT_MODE_PERMISSION_MATRIX = {
  conservative: {
    defaultPermissions: {
      allowAutoDispatch: CONSERVATIVE_AUTOPILOT_DEFAULTS.allowAutoDispatch,
      allowAutoValidate: CONSERVATIVE_AUTOPILOT_DEFAULTS.allowAutoValidate,
      allowAutoFix: CONSERVATIVE_AUTOPILOT_DEFAULTS.allowAutoFix,
      allowStoryIntegration: CONSERVATIVE_AUTOPILOT_DEFAULTS.allowStoryIntegration,
      allowDoneAdvance: CONSERVATIVE_AUTOPILOT_DEFAULTS.allowDoneAdvance,
      allowMainMerge: CONSERVATIVE_AUTOPILOT_DEFAULTS.allowMainMerge,
    },
    requireLocalAssurance: CONSERVATIVE_AUTOPILOT_DEFAULTS.requireLocalAssurance,
    defaultBounds: {
      maxIterations: CONSERVATIVE_AUTOPILOT_DEFAULTS.maxIterations,
      stopOnConflict: CONSERVATIVE_AUTOPILOT_DEFAULTS.stopOnConflict,
      stopOnScopeViolation: CONSERVATIVE_AUTOPILOT_DEFAULTS.stopOnScopeViolation,
    },
    requiresFullBounds: false,
    receiptGatedPrivileges: [],
  },
  'authority-verified': { // legacy retired mode; local autopilot refuses it.
    defaultPermissions: {
      allowAutoDispatch: true,
      allowAutoValidate: true,
      allowAutoFix: true,
      allowStoryIntegration: false,
      allowDoneAdvance: false,
      allowMainMerge: false,
    },
    requireLocalAssurance: false,
    defaultBounds: {
      maxIterations: 1,
      stopOnConflict: true,
      stopOnScopeViolation: true,
    },
    requiresFullBounds: false,
    receiptGatedPrivileges: ['allowStoryIntegration', 'allowDoneAdvance', 'allowMainMerge'],
  },
  'full-autopilot': {
    defaultPermissions: {
      allowAutoDispatch: true,
      allowAutoValidate: true,
      allowAutoFix: true,
      allowStoryIntegration: false,
      allowDoneAdvance: false,
      allowMainMerge: false,
    },
    requireLocalAssurance: false,
    defaultBounds: {
      maxIterations: 0,
      stopOnConflict: true,
      stopOnScopeViolation: true,
    },
    requiresFullBounds: true,
    receiptGatedPrivileges: ['allowStoryIntegration', 'allowDoneAdvance', 'allowMainMerge'],
  },
} as const satisfies Record<AutopilotMode, AutopilotModePermissionMatrixEntry>;

export interface AutopilotPolicy {
  schemaVersion: typeof AUTOPILOT_POLICY_SCHEMA_VERSION;
  policy: string;
  dispatchPolicy: string;
  mode: AutopilotMode;
  allowAutoDispatch: boolean;
  allowAutoValidate: boolean;
  allowAutoFix: boolean;
  allowStoryIntegration: boolean;
  allowDoneAdvance: boolean;
  allowMainMerge: boolean;
  requireLocalAssurance: boolean;
  maxIterations: number;
  maxRuntimeMinutes?: number;
  maxBudgetUSD?: number;
  stopOnConflict: boolean;
  stopOnScopeViolation: boolean;
  createdAt: string;
}

export interface AutopilotLocalAssuranceContext {
  authority: 'local';
  verified: true;
  receiptRef: string;
  verifiedBy?: string;
  verifiedAt?: string;
}

export interface AutopilotPolicyCheckOptions {
  localAssuranceEvidence?: AutopilotLocalAssuranceContext;
}

export interface CreateAutopilotPolicyArgs {
  policy: string;
  mode?: AutopilotMode | string;
  dispatchPolicy?: string;
  allowAutoDispatch?: boolean;
  allowAutoValidate?: boolean;
  allowAutoFix?: boolean;
  allowStoryIntegration?: boolean;
  allowDoneAdvance?: boolean;
  allowMainMerge?: boolean;
  requireLocalAssurance?: boolean;
  maxIterations?: number;
  maxRuntimeMinutes?: number;
  maxBudgetUSD?: number;
  stopOnConflict?: boolean;
  stopOnScopeViolation?: boolean;
}

export interface AutopilotPolicyAuthorityGate {
  localAssuranceRequired: boolean;
  localAssuranceContextPresent: boolean;
  localAssuranceAcceptedForPolicy: boolean;
  localAssuranceRef?: string;
  note: string;
}

export interface AutopilotPolicyAuthorityBoundary {
  authorityChanged: false;
  receiptVerified: false;
  productionDone: false;
  mainMergeAuthority: false;
  note: string;
}

export interface AutopilotPolicyCheckResult {
  schemaVersion: typeof AUTOPILOT_POLICY_CHECK_SCHEMA_VERSION;
  policy: string;
  mode: AutopilotMode;
  authorized: boolean;
  status: AutopilotPolicyStatus;
  reasons: string[];
  degradations: string[];
  normalizedPolicy: AutopilotPolicy;
  requestedPermissions: AutopilotPolicyPermissions;
  authorityGate: AutopilotPolicyAuthorityGate;
  authorityBoundary: AutopilotPolicyAuthorityBoundary;
  nextAction: string;
  authorityChanged: false;
  receiptVerified: false;
  productionDone: false;
}

const POLICY_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const CREATE_AUTOPILOT_POLICY_KEYS = new Set([
  'policy',
  'mode',
  'dispatchPolicy',
  'allowAutoDispatch',
  'allowAutoValidate',
  'allowAutoFix',
  'allowStoryIntegration',
  'allowDoneAdvance',
  'allowMainMerge',
  'requireLocalAssurance',
  'maxIterations',
  'maxRuntimeMinutes',
  'maxBudgetUSD',
  'stopOnConflict',
  'stopOnScopeViolation',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isAutopilotMode(value: unknown): value is AutopilotMode {
  return typeof value === 'string' && (AUTOPILOT_MODES as readonly string[]).includes(value);
}

export function isValidAutopilotPolicyName(name: string): boolean {
  return POLICY_NAME_PATTERN.test(name);
}

function autopilotPoliciesDir(root: string): string {
  return join(root, LATTICE_DIR, 'autopilot-policies');
}

export function autopilotPolicyPath(root: string, policy: string): string {
  return join(autopilotPoliciesDir(root), `${policy}.json`);
}

function normalizeBoolean(
  value: unknown,
  defaultValue: boolean,
  field: string,
  errors: string[],
): boolean {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'boolean') {
    errors.push(`${field} must be a boolean; got ${String(value)}`);
    return defaultValue;
  }
  return value;
}

function validatePositiveInteger(value: unknown, field: string, required: boolean, errors: string[]): number | undefined {
  if (value === undefined || value === null) {
    if (required) errors.push(`${field} is required and must be a positive integer`);
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    errors.push(`${field} must be a positive integer; got ${String(value)}`);
    return undefined;
  }
  return value;
}

function validatePositiveNumber(value: unknown, field: string, required: boolean, errors: string[]): number | undefined {
  if (value === undefined || value === null) {
    if (required) errors.push(`${field} is required and must be a positive number`);
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    errors.push(`${field} must be a positive number; got ${String(value)}`);
    return undefined;
  }
  return value;
}

function requestedPermissions(policy: AutopilotPolicy): AutopilotPolicyPermissions {
  return {
    allowAutoDispatch: policy.allowAutoDispatch,
    allowAutoValidate: policy.allowAutoValidate,
    allowAutoFix: policy.allowAutoFix,
    allowStoryIntegration: policy.allowStoryIntegration,
    allowDoneAdvance: policy.allowDoneAdvance,
    allowMainMerge: policy.allowMainMerge,
  };
}

function normalizeAutopilotPolicyRecord(raw: unknown): AutopilotPolicy {
  const record = isRecord(raw) ? raw : {};
  const mode = isAutopilotMode(record.mode) ? record.mode : 'conservative';
  const matrix: AutopilotModePermissionMatrixEntry = AUTOPILOT_MODE_PERMISSION_MATRIX[mode];
  const permissions = matrix.defaultPermissions;
  const bounds = matrix.defaultBounds;

  const maybeString = (value: unknown, fallback: string): string => (
    typeof value === 'string' ? value : fallback
  );
  const maybeBoolean = (value: unknown, fallback: boolean): boolean => (
    typeof value === 'boolean' ? value : fallback
  );
  const maybeNumber = (value: unknown, fallback: number | undefined): number | undefined => (
    typeof value === 'number' && Number.isFinite(value) ? value : fallback
  );

  return {
    schemaVersion: AUTOPILOT_POLICY_SCHEMA_VERSION,
    policy: maybeString(record.policy, ''),
    dispatchPolicy: maybeString(record.dispatchPolicy, maybeString(record.policy, '')),
    mode,
    allowAutoDispatch: maybeBoolean(record.allowAutoDispatch, permissions.allowAutoDispatch),
    allowAutoValidate: maybeBoolean(record.allowAutoValidate, permissions.allowAutoValidate),
    allowAutoFix: maybeBoolean(record.allowAutoFix, permissions.allowAutoFix),
    allowStoryIntegration: maybeBoolean(record.allowStoryIntegration, permissions.allowStoryIntegration),
    allowDoneAdvance: maybeBoolean(record.allowDoneAdvance, permissions.allowDoneAdvance),
    allowMainMerge: maybeBoolean(record.allowMainMerge, permissions.allowMainMerge),
    requireLocalAssurance: false,
    maxIterations: maybeNumber(record.maxIterations, bounds.maxIterations) ?? 0,
    ...(maybeNumber(record.maxRuntimeMinutes, bounds.maxRuntimeMinutes) !== undefined
      ? { maxRuntimeMinutes: maybeNumber(record.maxRuntimeMinutes, bounds.maxRuntimeMinutes) }
      : {}),
    ...(maybeNumber(record.maxBudgetUSD, bounds.maxBudgetUSD) !== undefined
      ? { maxBudgetUSD: maybeNumber(record.maxBudgetUSD, bounds.maxBudgetUSD) }
      : {}),
    stopOnConflict: maybeBoolean(record.stopOnConflict, bounds.stopOnConflict),
    stopOnScopeViolation: maybeBoolean(record.stopOnScopeViolation, bounds.stopOnScopeViolation),
    createdAt: maybeString(record.createdAt, ''),
  };
}

function validateCreateArgs(
  args: CreateAutopilotPolicyArgs,
  options?: AutopilotPolicyCheckOptions,
): { errors: string[]; normalized: Partial<AutopilotPolicy> } {
  const errors: string[] = [];
  const normalized: Partial<AutopilotPolicy> = {};
  const rawArgs = args as unknown as Record<string, unknown>;

  for (const key of Object.keys(rawArgs)) {
    if (!CREATE_AUTOPILOT_POLICY_KEYS.has(key)) {
      errors.push(`unsupported autopilot policy field "${key}"; put host/path/command restrictions in dispatch_policy_create and link it via dispatchPolicy`);
    }
  }

  const policyName = (args.policy ?? '').trim();
  if (!policyName) {
    errors.push('policy name is required');
  } else if (!isValidAutopilotPolicyName(policyName)) {
    errors.push(`invalid policy name "${policyName}": must be 1-64 alphanumeric, hyphen, or underscore characters`);
  } else {
    normalized.policy = policyName;
  }

  const rawDispatchPolicy = rawArgs.dispatchPolicy;
  let dispatchPolicyName = policyName;
  if (rawDispatchPolicy !== undefined) {
    if (typeof rawDispatchPolicy === 'string') {
      dispatchPolicyName = rawDispatchPolicy.trim();
    } else {
      dispatchPolicyName = '';
      errors.push(`dispatchPolicy must be a string; got ${String(rawDispatchPolicy)}`);
    }
  }
  if (!dispatchPolicyName) {
    errors.push('dispatchPolicy is required when policy name is empty');
  } else if (!isValidAutopilotPolicyName(dispatchPolicyName)) {
    errors.push(`invalid dispatchPolicy "${dispatchPolicyName}": must be 1-64 alphanumeric, hyphen, or underscore characters`);
  } else {
    normalized.dispatchPolicy = dispatchPolicyName;
  }

  const mode = args.mode ?? 'conservative';
  if (!isAutopilotMode(mode)) {
    errors.push(`mode must be one of: ${AUTOPILOT_MODES.join(', ')}; got ${String(mode)}`);
    normalized.mode = 'conservative';
  } else {
    normalized.mode = mode;
  }

  const matrix: AutopilotModePermissionMatrixEntry = AUTOPILOT_MODE_PERMISSION_MATRIX[normalized.mode ?? 'conservative'];
  const defaults = matrix.defaultPermissions;
  normalized.allowAutoDispatch = normalizeBoolean(args.allowAutoDispatch, defaults.allowAutoDispatch, 'allowAutoDispatch', errors);
  normalized.allowAutoValidate = normalizeBoolean(args.allowAutoValidate, defaults.allowAutoValidate, 'allowAutoValidate', errors);
  normalized.allowAutoFix = normalizeBoolean(args.allowAutoFix, defaults.allowAutoFix, 'allowAutoFix', errors);
  normalized.allowStoryIntegration = normalizeBoolean(args.allowStoryIntegration, defaults.allowStoryIntegration, 'allowStoryIntegration', errors);
  normalized.allowDoneAdvance = normalizeBoolean(args.allowDoneAdvance, defaults.allowDoneAdvance, 'allowDoneAdvance', errors);
  normalized.allowMainMerge = normalizeBoolean(args.allowMainMerge, defaults.allowMainMerge, 'allowMainMerge', errors);
  normalized.requireLocalAssurance = false;
  normalized.stopOnConflict = normalizeBoolean(args.stopOnConflict, matrix.defaultBounds.stopOnConflict, 'stopOnConflict', errors);
  normalized.stopOnScopeViolation = normalizeBoolean(args.stopOnScopeViolation, matrix.defaultBounds.stopOnScopeViolation, 'stopOnScopeViolation', errors);

  const maxIterations = validatePositiveInteger(
    args.maxIterations,
    'maxIterations',
    matrix.requiresFullBounds,
    errors,
  );
  normalized.maxIterations = maxIterations ?? matrix.defaultBounds.maxIterations;

  const maxRuntimeMinutes = validatePositiveInteger(
    args.maxRuntimeMinutes,
    'maxRuntimeMinutes',
    matrix.requiresFullBounds,
    errors,
  );
  if (maxRuntimeMinutes !== undefined) normalized.maxRuntimeMinutes = maxRuntimeMinutes;

  const maxBudgetUSD = validatePositiveNumber(
    args.maxBudgetUSD,
    'maxBudgetUSD',
    matrix.requiresFullBounds,
    errors,
  );
  if (maxBudgetUSD !== undefined) normalized.maxBudgetUSD = maxBudgetUSD;

  applyModeConstraints(normalized as AutopilotPolicy, errors, options);

  return { errors, normalized };
}

function applyModeConstraints(
  policy: AutopilotPolicy,
  errors: string[],
  options?: AutopilotPolicyCheckOptions,
): void {
  if (policy.mode === 'conservative') {
    if (policy.allowAutoFix) errors.push('conservative mode cannot allow auto-fix');
    if (policy.allowStoryIntegration) errors.push('conservative mode cannot allow story integration');
    if (policy.allowDoneAdvance) errors.push('conservative mode cannot allow DONE advance');
    if (policy.allowMainMerge) errors.push('conservative mode cannot allow main merge');
  }

  if (policy.mode === 'authority-verified' || policy.mode === 'full-autopilot') { // legacy retired modes.
    errors.push(`${policy.mode} mode is retired; use conservative local autopilot`);
  }

  if (policy.mode === 'full-autopilot') {
    if (!Number.isInteger(policy.maxIterations) || policy.maxIterations <= 0) {
      errors.push(`full-autopilot requires bounded maxIterations; got ${String(policy.maxIterations)}`);
    }
    if (!Number.isInteger(policy.maxRuntimeMinutes) || (policy.maxRuntimeMinutes ?? 0) <= 0) {
      errors.push(`full-autopilot requires bounded maxRuntimeMinutes; got ${String(policy.maxRuntimeMinutes)}`);
    }
    if (typeof policy.maxBudgetUSD !== 'number' || !Number.isFinite(policy.maxBudgetUSD) || policy.maxBudgetUSD <= 0) {
      errors.push(`full-autopilot requires bounded maxBudgetUSD; got ${String(policy.maxBudgetUSD)}`);
    }
    if (policy.stopOnConflict !== true) {
      errors.push('full-autopilot requires stopOnConflict=true');
    }
    if (policy.stopOnScopeViolation !== true) {
      errors.push('full-autopilot requires stopOnScopeViolation=true');
    }
  }

  const gatedPrivileges = AUTOPILOT_MODE_PERMISSION_MATRIX[policy.mode].receiptGatedPrivileges
    .filter(privilege => policy[privilege] === true);
  if (gatedPrivileges.length > 0) {
    errors.push(
      `${policy.mode} requests privileges that local autopilot cannot authorize: ${gatedPrivileges.join(', ')}`,
    );
  }
}

function collectPolicyShapeReasons(raw: unknown, normalized: AutopilotPolicy): string[] {
  const reasons: string[] = [];
  if (!isRecord(raw)) {
    return ['policy record must be a JSON object'];
  }

  if (raw.schemaVersion !== AUTOPILOT_POLICY_SCHEMA_VERSION) {
    reasons.push(`schemaVersion must be ${AUTOPILOT_POLICY_SCHEMA_VERSION}; got ${String(raw.schemaVersion)}`);
  }
  if (!isValidAutopilotPolicyName(normalized.policy)) {
    reasons.push(`invalid policy name: ${normalized.policy || '(empty)'}`);
  }
  if (!isValidAutopilotPolicyName(normalized.dispatchPolicy)) {
    reasons.push(`invalid dispatchPolicy: ${normalized.dispatchPolicy || '(empty)'}`);
  }
  if (raw.dispatchPolicy !== undefined && typeof raw.dispatchPolicy !== 'string') {
    reasons.push(`dispatchPolicy must be a string; got ${String(raw.dispatchPolicy)}`);
  }
  if (!isAutopilotMode(raw.mode)) {
    reasons.push(`mode must be one of: ${AUTOPILOT_MODES.join(', ')}; got ${String(raw.mode)}`);
  }

  for (const field of [
    'allowAutoDispatch',
    'allowAutoValidate',
    'allowAutoFix',
    'allowStoryIntegration',
    'allowDoneAdvance',
    'allowMainMerge',
    'requireLocalAssurance',
    'stopOnConflict',
    'stopOnScopeViolation',
  ]) {
    if (raw[field] !== undefined && typeof raw[field] !== 'boolean') {
      reasons.push(`${field} must be a boolean; got ${String(raw[field])}`);
    }
  }

  if (raw.maxIterations !== undefined) {
    validatePositiveInteger(raw.maxIterations, 'maxIterations', false, reasons);
  }
  if (raw.maxRuntimeMinutes !== undefined) {
    validatePositiveInteger(raw.maxRuntimeMinutes, 'maxRuntimeMinutes', false, reasons);
  }
  if (raw.maxBudgetUSD !== undefined) {
    validatePositiveNumber(raw.maxBudgetUSD, 'maxBudgetUSD', false, reasons);
  }
  if (raw.createdAt !== undefined && typeof raw.createdAt !== 'string') {
    reasons.push(`createdAt must be a string; got ${String(raw.createdAt)}`);
  }

  return reasons;
}

export function createAutopilotPolicy(
  root: string,
  args: CreateAutopilotPolicyArgs,
  options?: AutopilotPolicyCheckOptions,
): AutopilotPolicy {
  const { errors, normalized } = validateCreateArgs(args, options);
  if (errors.length > 0) {
    throw new Error(`autopilot_policy_create failed:\n${errors.map(e => `  - ${e}`).join('\n')}`);
  }

  const policy: AutopilotPolicy = {
    schemaVersion: AUTOPILOT_POLICY_SCHEMA_VERSION,
    policy: normalized.policy!,
    dispatchPolicy: normalized.dispatchPolicy!,
    mode: normalized.mode!,
    allowAutoDispatch: normalized.allowAutoDispatch!,
    allowAutoValidate: normalized.allowAutoValidate!,
    allowAutoFix: normalized.allowAutoFix!,
    allowStoryIntegration: normalized.allowStoryIntegration!,
    allowDoneAdvance: normalized.allowDoneAdvance!,
    allowMainMerge: normalized.allowMainMerge!,
    requireLocalAssurance: normalized.requireLocalAssurance!,
    maxIterations: normalized.maxIterations!,
    ...(normalized.maxRuntimeMinutes !== undefined ? { maxRuntimeMinutes: normalized.maxRuntimeMinutes } : {}),
    ...(normalized.maxBudgetUSD !== undefined ? { maxBudgetUSD: normalized.maxBudgetUSD } : {}),
    stopOnConflict: normalized.stopOnConflict!,
    stopOnScopeViolation: normalized.stopOnScopeViolation!,
    createdAt: new Date().toISOString(),
  };

  const dir = autopilotPoliciesDir(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(autopilotPolicyPath(root, policy.policy), JSON.stringify(policy, null, 2) + '\n', 'utf8');

  return policy;
}

export function getAutopilotPolicy(root: string, policy: string): AutopilotPolicy {
  const name = (policy ?? '').trim();
  if (!name) throw new Error('autopilot_policy_get requires policy name');
  if (!isValidAutopilotPolicyName(name)) throw new Error(`invalid policy name: ${name}`);

  const filePath = autopilotPolicyPath(root, name);
  if (!existsSync(filePath)) {
    throw new Error(`autopilot policy not found: ${name} (expected at .lattice/autopilot-policies/${name}.json)`);
  }
  return normalizeAutopilotPolicyRecord(JSON.parse(readFileSync(filePath, 'utf8')));
}

export function checkAutopilotPolicy(
  root: string,
  policy: string | AutopilotPolicy,
  options?: AutopilotPolicyCheckOptions,
): AutopilotPolicyCheckResult {
  let rawPolicy: unknown;
  let normalizedPolicy: AutopilotPolicy;
  let policyName: string;

  if (typeof policy === 'string') {
    policyName = (policy ?? '').trim();
    if (!policyName) {
      return refusedResult('(empty)', ['policy name is required'], 'Provide a valid policy name to autopilot_policy_check.');
    }
    if (!isValidAutopilotPolicyName(policyName)) {
      return refusedResult(policyName, [`invalid policy name: ${policyName}`], 'Use alphanumeric, hyphen, or underscore characters (1-64 chars).');
    }
    const filePath = autopilotPolicyPath(root, policyName);
    if (!existsSync(filePath)) {
      return refusedResult(
        policyName,
        [`policy not found: ${policyName} (no file at .lattice/autopilot-policies/${policyName}.json)`],
        `Create the policy first with autopilot_policy_create --policy=${policyName}`,
      );
    }
    try {
      rawPolicy = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (err) {
      return refusedResult(policyName, [`failed to parse policy JSON: ${(err as Error).message}`], 'Repair or recreate the policy file.');
    }
    normalizedPolicy = normalizeAutopilotPolicyRecord(rawPolicy);
  } else {
    rawPolicy = policy;
    normalizedPolicy = normalizeAutopilotPolicyRecord(policy);
    policyName = normalizedPolicy.policy;
  }

  const reasons = collectPolicyShapeReasons(rawPolicy, normalizedPolicy);
  applyModeConstraints(normalizedPolicy, reasons, options);

  const degradations: string[] = [];

  if (reasons.length > 0) {
    return refusedResult(policyName, reasons, 'Fix the policy violations above and re-check.', normalizedPolicy, options);
  }

  const status: AutopilotPolicyStatus = degradations.length > 0 ? 'supervised' : 'authorized';
  const authorized = status === 'authorized';
  const nextAction = authorized
    ? `Policy "${policyName}" is authorized for bounded ${normalizedPolicy.mode} autopilot execution. Handlers must still keep release authority with local lifecycle gates and enforce merge/DONE gates separately.`
    : `Policy "${policyName}" is supervised-only. Choose a conservative local mode before unattended autopilot execution.`;

  return {
    schemaVersion: AUTOPILOT_POLICY_CHECK_SCHEMA_VERSION,
    policy: policyName,
    mode: normalizedPolicy.mode,
    authorized,
    status,
    reasons: [],
    degradations,
    normalizedPolicy,
    requestedPermissions: requestedPermissions(normalizedPolicy),
    authorityGate: authorityGate(normalizedPolicy, options),
    authorityBoundary: authorityBoundary(),
    nextAction,
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
  };
}

function authorityGate(
  policy: AutopilotPolicy,
  options?: AutopilotPolicyCheckOptions,
): AutopilotPolicyAuthorityGate {
  void policy;
  void options;
  return {
    localAssuranceRequired: false,
    localAssuranceContextPresent: false,
    localAssuranceAcceptedForPolicy: false,
    note: 'Autopilot policy checks authorize bounded local behavior only; local proof admissibility and review quorum remain separate lifecycle evidence.',
  };
}

function authorityBoundary(): AutopilotPolicyAuthorityBoundary {
  return {
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
    mainMergeAuthority: false,
    note: 'Autopilot policy checks authorize bounded local behavior only; they do not establish receipt-bundle admissibility, perform main merges, advance DONE, or certify release readiness.',
  };
}

function placeholderPolicy(policy: string): AutopilotPolicy {
  return {
    schemaVersion: AUTOPILOT_POLICY_SCHEMA_VERSION,
    policy,
    dispatchPolicy: policy,
    mode: 'conservative',
    allowAutoDispatch: CONSERVATIVE_AUTOPILOT_DEFAULTS.allowAutoDispatch,
    allowAutoValidate: CONSERVATIVE_AUTOPILOT_DEFAULTS.allowAutoValidate,
    allowAutoFix: CONSERVATIVE_AUTOPILOT_DEFAULTS.allowAutoFix,
    allowStoryIntegration: CONSERVATIVE_AUTOPILOT_DEFAULTS.allowStoryIntegration,
    allowDoneAdvance: CONSERVATIVE_AUTOPILOT_DEFAULTS.allowDoneAdvance,
    allowMainMerge: CONSERVATIVE_AUTOPILOT_DEFAULTS.allowMainMerge,
    requireLocalAssurance: CONSERVATIVE_AUTOPILOT_DEFAULTS.requireLocalAssurance,
    maxIterations: CONSERVATIVE_AUTOPILOT_DEFAULTS.maxIterations,
    stopOnConflict: CONSERVATIVE_AUTOPILOT_DEFAULTS.stopOnConflict,
    stopOnScopeViolation: CONSERVATIVE_AUTOPILOT_DEFAULTS.stopOnScopeViolation,
    createdAt: '',
  };
}

function refusedResult(
  policy: string,
  reasons: string[],
  nextAction: string,
  normalizedPolicy?: AutopilotPolicy,
  options?: AutopilotPolicyCheckOptions,
): AutopilotPolicyCheckResult {
  const resultPolicy = normalizedPolicy ?? placeholderPolicy(policy);
  return {
    schemaVersion: AUTOPILOT_POLICY_CHECK_SCHEMA_VERSION,
    policy,
    mode: resultPolicy.mode,
    authorized: false,
    status: 'refused',
    reasons,
    degradations: [],
    normalizedPolicy: resultPolicy,
    requestedPermissions: requestedPermissions(resultPolicy),
    authorityGate: authorityGate(resultPolicy, options),
    authorityBoundary: authorityBoundary(),
    nextAction,
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
  };
}

export function renderAutopilotPolicyText(policy: AutopilotPolicy): string {
  const lines = [
    `Autopilot policy (${policy.schemaVersion})`,
    `policy: ${policy.policy}`,
    `dispatchPolicy: ${policy.dispatchPolicy}`,
    `mode: ${policy.mode}`,
    `allowAutoDispatch: ${policy.allowAutoDispatch}`,
    `allowAutoValidate: ${policy.allowAutoValidate}`,
    `allowAutoFix: ${policy.allowAutoFix}`,
    `allowStoryIntegration: ${policy.allowStoryIntegration}`,
    `allowDoneAdvance: ${policy.allowDoneAdvance}`,
    `allowMainMerge: ${policy.allowMainMerge}`,
    `requireLocalAssurance: ${policy.requireLocalAssurance}`,
    `maxIterations: ${policy.maxIterations}`,
    ...(policy.maxRuntimeMinutes !== undefined ? [`maxRuntimeMinutes: ${policy.maxRuntimeMinutes}`] : []),
    ...(policy.maxBudgetUSD !== undefined ? [`maxBudgetUSD: ${policy.maxBudgetUSD}`] : []),
    `stopOnConflict: ${policy.stopOnConflict}`,
    `stopOnScopeViolation: ${policy.stopOnScopeViolation}`,
    `createdAt: ${policy.createdAt}`,
  ];
  return lines.join('\n');
}

export function renderAutopilotPolicyCheckText(result: AutopilotPolicyCheckResult): string {
  const lines = [
    `Autopilot policy check (${result.schemaVersion})`,
    `policy: ${result.policy}`,
    `mode: ${result.mode}`,
    `authorized: ${result.authorized}`,
    `status: ${result.status}`,
    'admissibilityStatus: local-autopilot-policy-check',
    'assuranceLevel: local',
    'evidenceScope: autopilot-policy',
    `localAssuranceRequired: ${result.authorityGate.localAssuranceRequired}`,
    `localAssuranceAcceptedForPolicy: ${result.authorityGate.localAssuranceAcceptedForPolicy}`,
    `mainMergeAuthority: ${result.authorityBoundary.mainMergeAuthority}`,
    `nextAction: ${result.nextAction}`,
  ];
  if (result.reasons.length > 0) {
    lines.push('', 'reasons:');
    lines.push(...result.reasons.map(reason => `  - ${reason}`));
  }
  if (result.degradations.length > 0) {
    lines.push('', 'degradations:');
    lines.push(...result.degradations.map(degradation => `  - ${degradation}`));
  }
  return lines.join('\n');
}
