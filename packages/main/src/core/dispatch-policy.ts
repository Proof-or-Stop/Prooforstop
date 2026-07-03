import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { LATTICE_DIR } from './lattice-paths.js';

export type DispatchPolicyStatus = 'authorized' | 'supervised' | 'refused';
export type DispatchNetworkPolicy = 'none' | 'local' | 'restricted';

export interface DispatchPolicy {
  schemaVersion: 'lattice.dispatch_policy.v1';
  policy: string;
  allowedHosts: string[];
  allowedPaths: string[];
  deniedPaths: string[];
  maxParallel: number;
  maxRuntimeMinutes: number;
  maxBudgetUSD?: number;
  network?: DispatchNetworkPolicy;
  envAllowlist: string[];
  envDenylist: string[];
  commandAllowlist: string[];
  retryLimit: number;
  requireReceipt: boolean;
  requireReview: boolean;
  allowRealHostSubprocess?: boolean;
  /**
   * B-f57a: permit ONLY a read-only Codex review subprocess (the cross_host_review
   * leaf) — a materially narrower grant than allowRealHostSubprocess (which is the
   * IMPLEMENTATION real-host path and stays refused for codex). This flag permits
   * `codex` as an independent read-only REVIEWER; gemini/antigravity remain refused,
   * and the general allowRealHostSubprocess implementation path for codex remains
   * refused. Absent/false ⇒ unchanged behavior.
   */
  allowReviewOnlyRealHostSubprocess?: boolean;
  allowAutoMerge: boolean;
  allowProductionDone: boolean;
  createdAt: string;
}

export interface DispatchPolicyCheckResult {
  schemaVersion: 'lattice.dispatch_policy_check.v1';
  policy: string;
  authorized: boolean;
  status: DispatchPolicyStatus;
  reasons: string[];
  degradations: string[];
  normalizedPolicy: DispatchPolicy;
  nextAction: string;
  authorityChanged: false;
  receiptVerified: false;
  productionDone: false;
}

const CURRENT_KNOWN_HOSTS = ['fake', 'codex', 'claude-code', 'antigravity'] as const;
const LEGACY_KNOWN_HOSTS = ['gemini'] as const;
const KNOWN_HOSTS: ReadonlySet<string> = new Set([...CURRENT_KNOWN_HOSTS, ...LEGACY_KNOWN_HOSTS]);
const MAX_PARALLEL = 10;
const MAX_RUNTIME_MINUTES = 1440;
const UNSAFE_ENV_PATTERN = /TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL/i;

export function isValidPolicyName(name: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(name);
}

function hasTraversal(p: string): boolean {
  const normalized = normalize(p);
  return isAbsolute(normalized) || normalized.split(sep).includes('..') || p.includes('..');
}

function validatePath(p: string, field: string, index: number): string | null {
  if (!p || !p.trim()) return `${field}[${index}] must not be empty`;
  const trimmed = p.trim();
  if (isAbsolute(trimmed)) return `${field}[${index}] must be a relative path: ${trimmed}`;
  if (hasTraversal(trimmed)) return `${field}[${index}] escapes the isolated worktree via path traversal: ${trimmed}`;
  return null;
}

export interface CreateDispatchPolicyArgs {
  policy: string;
  allowedHosts?: string | string[];
  allowedPaths?: string | string[];
  deniedPaths?: string | string[];
  maxParallel?: number;
  maxRuntimeMinutes?: number;
  maxBudgetUSD?: number;
  network?: string;
  envAllowlist?: string | string[];
  envDenylist?: string | string[];
  commandAllowlist?: string | string[];
  retryLimit?: number;
  requireReceipt?: boolean;
  requireReview?: boolean;
  allowRealHostSubprocess?: boolean;
  allowReviewOnlyRealHostSubprocess?: boolean;
  allowAutoMerge?: boolean;
  allowProductionDone?: boolean;
}

function normalizeStringList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map(v => v.trim());
  if (typeof value === 'string' && value.trim().length > 0) return [value.trim()];
  return [];
}

function normalizeDispatchHostId(host: string): string | null {
  const value = host.trim().toLowerCase();
  if (value === 'claude' || value === 'claude-code') return 'claude-code';
  if (value === 'antigravity' || value === 'agy') return 'antigravity';
  if (value === 'codex' || value === 'fake' || value === 'gemini') return value;
  return null;
}

function knownHostsDescription(): string {
  return `${CURRENT_KNOWN_HOSTS.join(', ')} (alias: agy=antigravity; legacy: ${LEGACY_KNOWN_HOSTS.join(', ')})`;
}

function normalizeHostList(value: string | string[] | undefined): { hosts: string[]; errors: string[] } {
  const errors: string[] = [];
  const seen = new Set<string>();
  const hosts: string[] = [];
  for (const host of normalizeStringList(value)) {
    const normalized = normalizeDispatchHostId(host);
    if (!normalized || !KNOWN_HOSTS.has(normalized)) {
      errors.push(`allowedHosts contains unknown host: ${host} (known: ${knownHostsDescription()})`);
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    hosts.push(normalized);
  }
  return { hosts, errors };
}

function policiesDir(root: string): string {
  return join(root, LATTICE_DIR, 'dispatch-policies');
}

function policyPath(root: string, policy: string): string {
  return join(policiesDir(root), `${policy}.json`);
}

function validatePolicyArgs(args: CreateDispatchPolicyArgs): { errors: string[]; normalized: Partial<DispatchPolicy> } {
  const errors: string[] = [];
  const normalized: Partial<DispatchPolicy> = {};

  const policyName = (args.policy ?? '').trim();
  if (!policyName) {
    errors.push('policy name is required');
  } else if (!isValidPolicyName(policyName)) {
    errors.push(`invalid policy name "${policyName}": must be 1-64 alphanumeric, hyphen, or underscore characters`);
  } else {
    normalized.policy = policyName;
  }

  const { hosts: allowedHosts, errors: allowedHostErrors } = normalizeHostList(args.allowedHosts);
  errors.push(...allowedHostErrors);
  if (allowedHosts.length === 0) {
    errors.push('allowedHosts is required and must contain at least one host');
  } else {
    normalized.allowedHosts = allowedHosts;
  }

  const allowedPaths = normalizeStringList(args.allowedPaths);
  if (allowedPaths.length === 0) {
    errors.push('allowedPaths is required and must contain at least one path');
  } else {
    for (let i = 0; i < allowedPaths.length; i++) {
      const err = validatePath(allowedPaths[i], 'allowedPaths', i);
      if (err) errors.push(err);
    }
    normalized.allowedPaths = allowedPaths;
  }

  const deniedPaths = normalizeStringList(args.deniedPaths);
  for (let i = 0; i < deniedPaths.length; i++) {
    const err = validatePath(deniedPaths[i], 'deniedPaths', i);
    if (err) errors.push(err);
  }
  if (allowedPaths.length > 0 && deniedPaths.length > 0) {
    const allowedSet = new Set(allowedPaths);
    for (const denied of deniedPaths) {
      if (allowedSet.has(denied)) {
        errors.push(`deniedPaths overlaps with allowedPaths: "${denied}" appears in both`);
      }
    }
  }
  normalized.deniedPaths = deniedPaths;

  const maxParallel = args.maxParallel;
  if (maxParallel === undefined || maxParallel === null) {
    errors.push('maxParallel is required');
  } else if (typeof maxParallel !== 'number' || !Number.isInteger(maxParallel) || maxParallel <= 0) {
    errors.push(`maxParallel must be a positive integer; got ${maxParallel}`);
  } else if (maxParallel > MAX_PARALLEL) {
    errors.push(`maxParallel must be at most ${MAX_PARALLEL} (unbounded parallelism is not safe for unattended use); got ${maxParallel}`);
  } else {
    normalized.maxParallel = maxParallel;
  }

  const maxRuntimeMinutes = args.maxRuntimeMinutes;
  if (maxRuntimeMinutes === undefined || maxRuntimeMinutes === null) {
    errors.push('maxRuntimeMinutes is required');
  } else if (typeof maxRuntimeMinutes !== 'number' || !Number.isInteger(maxRuntimeMinutes) || maxRuntimeMinutes <= 0) {
    errors.push(`maxRuntimeMinutes must be a positive integer; got ${maxRuntimeMinutes}`);
  } else if (maxRuntimeMinutes > MAX_RUNTIME_MINUTES) {
    errors.push(`maxRuntimeMinutes must be at most ${MAX_RUNTIME_MINUTES} (unbounded runtime is not safe for unattended use); got ${maxRuntimeMinutes}`);
  } else {
    normalized.maxRuntimeMinutes = maxRuntimeMinutes;
  }

  if (args.maxBudgetUSD !== undefined) {
    const budget = args.maxBudgetUSD;
    if (typeof budget !== 'number' || budget <= 0) {
      errors.push(`maxBudgetUSD must be a positive number; got ${budget}`);
    } else {
      normalized.maxBudgetUSD = budget;
    }
  }

  if (args.network !== undefined) {
    if (!['none', 'local', 'restricted'].includes(args.network)) {
      errors.push(`network must be one of: none, local, restricted; got ${args.network}`);
    } else {
      normalized.network = args.network as DispatchNetworkPolicy;
    }
  }

  const envAllowlist = normalizeStringList(args.envAllowlist);
  for (const envVar of envAllowlist) {
    if (UNSAFE_ENV_PATTERN.test(envVar)) {
      errors.push(`envAllowlist contains unsafe environment variable name: ${envVar} (TOKEN/SECRET/PASSWORD/KEY/CREDENTIAL names are forbidden)`);
    }
  }
  normalized.envAllowlist = envAllowlist;

  normalized.envDenylist = normalizeStringList(args.envDenylist);

  const commandAllowlist = normalizeStringList(args.commandAllowlist);
  normalized.commandAllowlist = commandAllowlist;

  const retryLimit = args.retryLimit ?? 0;
  if (typeof retryLimit !== 'number' || !Number.isInteger(retryLimit) || retryLimit < 0) {
    errors.push(`retryLimit must be a non-negative integer; got ${retryLimit}`);
  } else {
    normalized.retryLimit = retryLimit;
  }

  const requireReceipt = args.requireReceipt ?? true;
  if (requireReceipt === false) {
    errors.push('requireReceipt must be true; unattended use without a receipt is unsafe');
  } else {
    normalized.requireReceipt = requireReceipt;
  }

  const requireReview = args.requireReview ?? true;
  if (requireReview === false) {
    errors.push('requireReview must be true; unattended use without review is unsafe');
  } else {
    normalized.requireReview = requireReview;
  }

  const allowReviewOnlyRealHostSubprocess = args.allowReviewOnlyRealHostSubprocess ?? false;
  if (typeof allowReviewOnlyRealHostSubprocess !== 'boolean') {
    errors.push(`allowReviewOnlyRealHostSubprocess must be a boolean; got ${String(allowReviewOnlyRealHostSubprocess)}`);
  } else {
    normalized.allowReviewOnlyRealHostSubprocess = allowReviewOnlyRealHostSubprocess;
  }

  const allowRealHostSubprocess = args.allowRealHostSubprocess ?? false;
  if (typeof allowRealHostSubprocess !== 'boolean') {
    errors.push(`allowRealHostSubprocess must be a boolean; got ${String(allowRealHostSubprocess)}`);
  } else {
    // F-003: the IMPLEMENTATION real-host path supports claude-code only. codex may
    // be excluded from this refusal ONLY for a PURE review-only policy — the narrow
    // review-only grant WITHOUT the implementation flag. When allowRealHostSubprocess
    // is true the policy expresses IMPLEMENTATION intent and codex stays refused
    // (codex is the live impl target at lattice-dispatch.ts's runCodexRealLeafDispatch,
    // which fires on selectedHost==='codex' && allowRealHostSubprocess===true), so the
    // two flags are mutually exclusive for codex. gemini/antigravity always remain refused.
    const reviewOnlyCodex = allowReviewOnlyRealHostSubprocess && !allowRealHostSubprocess;
    const unsupportedRealHosts = allowedHosts.filter((host) => {
      if (host === 'antigravity' || host === 'gemini') return true;
      if (host === 'codex') return !reviewOnlyCodex;
      return false;
    });
    if (allowRealHostSubprocess && unsupportedRealHosts.length > 0) {
      errors.push(
        `allowRealHostSubprocess currently supports claude-code only; ${unsupportedRealHosts.join(', ')} remain scaffolded/refused real-host subprocess targets`,
      );
    }
    // Codex host-B lane: the guard above only fires when allowRealHostSubprocess is
    // true, so a PURE review-only policy could still carry allowedHosts=['gemini'|
    // 'antigravity']. The review-only flag sanctions ONLY a read-only codex reviewer —
    // refuse any non-codex real host in that case.
    if (reviewOnlyCodex) {
      const unsupportedReviewHosts = allowedHosts.filter(
        (host) => host === 'antigravity' || host === 'gemini',
      );
      if (unsupportedReviewHosts.length > 0) {
        errors.push(
          `allowReviewOnlyRealHostSubprocess sanctions a read-only codex reviewer only; ${unsupportedReviewHosts.join(', ')} are not permitted review-only real-host targets`,
        );
      }
    }
    normalized.allowRealHostSubprocess = allowRealHostSubprocess;
  }

  const allowAutoMerge = args.allowAutoMerge ?? false;
  if (allowAutoMerge === true) {
    errors.push('allowAutoMerge must be false; auto-merge is never permitted for unattended execution');
  } else {
    normalized.allowAutoMerge = false;
  }

  const allowProductionDone = args.allowProductionDone ?? false;
  if (allowProductionDone === true) {
    errors.push('allowProductionDone must be false; release readiness cannot be claimed by unattended execution');
  } else {
    normalized.allowProductionDone = false;
  }

  return { errors, normalized };
}

export function createDispatchPolicy(root: string, args: CreateDispatchPolicyArgs): DispatchPolicy {
  const { errors, normalized } = validatePolicyArgs(args);
  if (errors.length > 0) {
    throw new Error(`dispatch_policy_create failed:\n${errors.map(e => `  - ${e}`).join('\n')}`);
  }

  const policy: DispatchPolicy = {
    schemaVersion: 'lattice.dispatch_policy.v1',
    policy: normalized.policy!,
    allowedHosts: normalized.allowedHosts!,
    allowedPaths: normalized.allowedPaths!,
    deniedPaths: normalized.deniedPaths ?? [],
    maxParallel: normalized.maxParallel!,
    maxRuntimeMinutes: normalized.maxRuntimeMinutes!,
    ...(normalized.maxBudgetUSD !== undefined ? { maxBudgetUSD: normalized.maxBudgetUSD } : {}),
    ...(normalized.network !== undefined ? { network: normalized.network } : {}),
    envAllowlist: normalized.envAllowlist ?? [],
    envDenylist: normalized.envDenylist ?? [],
    commandAllowlist: normalized.commandAllowlist ?? [],
    retryLimit: normalized.retryLimit ?? 0,
    requireReceipt: normalized.requireReceipt!,
    requireReview: normalized.requireReview!,
    allowRealHostSubprocess: normalized.allowRealHostSubprocess ?? false,
    ...(normalized.allowReviewOnlyRealHostSubprocess ? { allowReviewOnlyRealHostSubprocess: true } : {}),
    allowAutoMerge: false,
    allowProductionDone: false,
    createdAt: new Date().toISOString(),
  };

  if (policy.policy !== 'fake') {
    const dir = policiesDir(root);
    mkdirSync(dir, { recursive: true });
    const filePath = policyPath(root, policy.policy);
    writeFileSync(filePath, JSON.stringify(policy, null, 2) + '\n', 'utf8');
  }

  return policy;
}

export function getDispatchPolicy(root: string, policy: string): DispatchPolicy {
  const name = (policy ?? '').trim();
  if (!name) throw new Error('dispatch_policy_get requires policy name');
  if (!isValidPolicyName(name)) throw new Error(`invalid policy name: ${name}`);

  if (name === 'fake') {
    return fakePolicyRecord();
  }

  const filePath = policyPath(root, name);
  if (!existsSync(filePath)) {
    throw new Error(`dispatch policy not found: ${name} (expected at .lattice/dispatch-policies/${name}.json)`);
  }
  const raw = JSON.parse(readFileSync(filePath, 'utf8')) as DispatchPolicy;
  return normalizeDispatchPolicyRecord(raw);
}

function fakePolicyRecord(): DispatchPolicy {
  return {
    schemaVersion: 'lattice.dispatch_policy.v1',
    policy: 'fake',
    allowedHosts: ['fake'],
    allowedPaths: ['packages/main/src/generated/'],
    deniedPaths: [],
    maxParallel: 2,
    maxRuntimeMinutes: 60,
    maxBudgetUSD: 1.0,
    network: 'none',
    envAllowlist: [],
    envDenylist: [],
    commandAllowlist: ['node -e "process.exit(0)"'],
    retryLimit: 0,
    requireReceipt: true,
    requireReview: true,
    allowRealHostSubprocess: false,
    allowAutoMerge: false,
    allowProductionDone: false,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function normalizeDispatchPolicyRecord(policy: DispatchPolicy): DispatchPolicy {
  const allowedHosts = (policy.allowedHosts ?? [])
    .map(host => normalizeDispatchHostId(host) ?? host)
    .filter((host, index, hosts) => hosts.indexOf(host) === index);
  return {
    ...policy,
    allowedHosts,
    allowRealHostSubprocess: policy.allowRealHostSubprocess === true,
    ...(policy.allowReviewOnlyRealHostSubprocess === true ? { allowReviewOnlyRealHostSubprocess: true } : {}),
  };
}

export function checkDispatchPolicy(root: string, policy: string | DispatchPolicy): DispatchPolicyCheckResult {
  let policyRecord: DispatchPolicy;
  let policyName: string;

  if (typeof policy === 'string') {
    policyName = (policy ?? '').trim();
    if (!policyName) {
      return refusedResult('(empty)', ['policy name is required'], 'Provide a valid policy name to dispatch_policy_check.');
    }
    if (!isValidPolicyName(policyName)) {
      return refusedResult(policyName, [`invalid policy name: ${policyName}`], 'Use alphanumeric, hyphen, or underscore characters (1-64 chars).');
    }
    if (policyName === 'fake') {
      policyRecord = fakePolicyRecord();
    } else {
      const filePath = policyPath(root, policyName);
      if (!existsSync(filePath)) {
        return refusedResult(policyName, [`policy not found: ${policyName} (no file at .lattice/dispatch-policies/${policyName}.json)`], `Create the policy first with dispatch_policy_create --policy=${policyName}`);
      }
      policyRecord = normalizeDispatchPolicyRecord(JSON.parse(readFileSync(filePath, 'utf8')) as DispatchPolicy);
    }
  } else {
    policyRecord = normalizeDispatchPolicyRecord(policy);
    policyName = policyRecord.policy;
  }

  const reasons: string[] = [];
  const degradations: string[] = [];

  if (policyRecord.allowAutoMerge === true) reasons.push('allowAutoMerge must be false; auto-merge is never permitted');
  if (policyRecord.allowProductionDone === true) reasons.push('allowProductionDone must be false; release readiness cannot be claimed by unattended execution');
  if (policyRecord.requireReceipt === false) reasons.push('requireReceipt must be true; unattended use without a receipt is unsafe');
  if (policyRecord.requireReview === false) reasons.push('requireReview must be true; unattended use without review is unsafe');
  if (policyRecord.allowRealHostSubprocess === true) {
    // F-003: codex may be excluded from this IMPLEMENTATION-path refusal ONLY for
    // a PURE review-only policy — i.e. the narrow review-only grant WITHOUT the
    // implementation flag. When allowRealHostSubprocess === true the policy
    // expresses IMPLEMENTATION intent, and codex is the live impl target at
    // lattice-dispatch.ts (runCodexRealLeafDispatch fires whenever
    // selectedHost==='codex' && allowRealHostSubprocess===true). So codex must
    // stay refused here regardless of allowReviewOnlyRealHostSubprocess, making
    // the two flags mutually exclusive for codex: a review-only policy can never
    // also carry the implementation flag, so it can never reach that impl path.
    // gemini/antigravity always remain refused.
    // F-006: this block runs only when allowRealHostSubprocess === true, so codex
    // is ALWAYS refused here (the review-only carve-out lives in the create/validate
    // path, where allowRealHostSubprocess is false). Refusing codex directly avoids
    // a dead `reviewOnlyCodex` variable that is unconditionally false in this block.
    const unsupportedRealHosts = (policyRecord.allowedHosts ?? []).filter(
      (host) => host === 'antigravity' || host === 'gemini' || host === 'codex',
    );
    if (unsupportedRealHosts.length > 0) {
      reasons.push(
        `allowRealHostSubprocess currently supports claude-code only; ${unsupportedRealHosts.join(', ')} remain scaffolded/refused real-host subprocess targets`,
      );
    }
  }

  // Codex host-B lane: the review-only flag sanctions ONLY a read-only codex reviewer.
  // A PURE review-only policy (allowRealHostSubprocess=false) never enters the block
  // above, so without this guard a policy could set allowReviewOnlyRealHostSubprocess
  // + allowedHosts=['gemini'|'antigravity'] and pass — violating the codex-only invariant.
  // Refuse any non-codex real host whenever the review-only flag is set.
  if (policyRecord.allowReviewOnlyRealHostSubprocess === true) {
    const unsupportedReviewHosts = (policyRecord.allowedHosts ?? []).filter(
      (host) => host === 'antigravity' || host === 'gemini',
    );
    if (unsupportedReviewHosts.length > 0) {
      reasons.push(
        `allowReviewOnlyRealHostSubprocess sanctions a read-only codex reviewer only; ${unsupportedReviewHosts.join(', ')} are not permitted review-only real-host targets`,
      );
    }
  }

  if (!policyRecord.allowedHosts || policyRecord.allowedHosts.length === 0) {
    reasons.push('allowedHosts is empty; at least one host must be authorized');
  } else {
    for (const host of policyRecord.allowedHosts) {
      const normalized = normalizeDispatchHostId(host);
      if (!normalized || !KNOWN_HOSTS.has(normalized)) {
        reasons.push(`allowedHosts contains unknown host: ${host}`);
      }
    }
  }

  if (!policyRecord.allowedPaths || policyRecord.allowedPaths.length === 0) {
    reasons.push('allowedPaths is empty; at least one path must be declared');
  } else {
    for (let i = 0; i < policyRecord.allowedPaths.length; i++) {
      const err = validatePath(policyRecord.allowedPaths[i], 'allowedPaths', i);
      if (err) reasons.push(err);
    }
    if (policyRecord.deniedPaths && policyRecord.deniedPaths.length > 0) {
      const allowedSet = new Set(policyRecord.allowedPaths);
      for (const denied of policyRecord.deniedPaths) {
        if (allowedSet.has(denied)) {
          reasons.push(`deniedPaths overlaps with allowedPaths: "${denied}" appears in both`);
        }
        const err = validatePath(denied, 'deniedPaths', policyRecord.deniedPaths.indexOf(denied));
        if (err) reasons.push(err);
      }
    }
  }

  if (!policyRecord.maxParallel || policyRecord.maxParallel <= 0) {
    reasons.push(`maxParallel must be > 0; got ${policyRecord.maxParallel}`);
  } else if (policyRecord.maxParallel > MAX_PARALLEL) {
    reasons.push(`maxParallel ${policyRecord.maxParallel} exceeds maximum ${MAX_PARALLEL}`);
  }

  if (!policyRecord.maxRuntimeMinutes || policyRecord.maxRuntimeMinutes <= 0) {
    reasons.push(`maxRuntimeMinutes must be > 0; got ${policyRecord.maxRuntimeMinutes}`);
  } else if (policyRecord.maxRuntimeMinutes > MAX_RUNTIME_MINUTES) {
    reasons.push(`maxRuntimeMinutes ${policyRecord.maxRuntimeMinutes} exceeds maximum ${MAX_RUNTIME_MINUTES}`);
  }

  for (const envVar of (policyRecord.envAllowlist ?? [])) {
    if (UNSAFE_ENV_PATTERN.test(envVar)) {
      reasons.push(`envAllowlist contains unsafe env var: ${envVar}`);
    }
  }

  if (!policyRecord.commandAllowlist || policyRecord.commandAllowlist.length === 0) {
    reasons.push('commandAllowlist is empty; at least one command must be declared for unattended authorization');
  }

  if (reasons.length > 0) {
    return refusedResult(policyName, reasons, 'Fix the policy violations above and re-check.', policyRecord);
  }

  if (policyRecord.maxBudgetUSD === undefined) {
    degradations.push('maxBudgetUSD is not set; authorization degrades to supervised until a budget is declared');
  }
  if (policyRecord.network === undefined) {
    degradations.push('network policy is not set; authorization degrades to supervised until network constraints are declared');
  }

  const status: DispatchPolicyStatus = degradations.length > 0 ? 'supervised' : 'authorized';
  const authorized = status === 'authorized';

  const nextAction = authorized
    ? `Policy "${policyName}" is authorized for unattended dispatch. Use dispatch_auto (CHK-006) to start workers within these constraints.`
    : `Policy "${policyName}" is supervised-only. Declare the following to enable unattended authorization: ${degradations.map(d => d.split(';')[0]).join('; ')}.`;

  return {
    schemaVersion: 'lattice.dispatch_policy_check.v1',
    policy: policyName,
    authorized,
    status,
    reasons: [],
    degradations,
    normalizedPolicy: policyRecord,
    nextAction,
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
  };
}

function refusedResult(
  policy: string,
  reasons: string[],
  nextAction: string,
  normalizedPolicy?: DispatchPolicy,
): DispatchPolicyCheckResult {
  return {
    schemaVersion: 'lattice.dispatch_policy_check.v1',
    policy,
    authorized: false,
    status: 'refused',
    reasons,
    degradations: [],
    normalizedPolicy: normalizedPolicy ?? ({
      schemaVersion: 'lattice.dispatch_policy.v1',
      policy,
      allowedHosts: [],
      allowedPaths: [],
      deniedPaths: [],
      maxParallel: 0,
      maxRuntimeMinutes: 0,
      envAllowlist: [],
      envDenylist: [],
      commandAllowlist: [],
      retryLimit: 0,
      requireReceipt: true,
      requireReview: true,
      allowRealHostSubprocess: false,
      allowAutoMerge: false,
      allowProductionDone: false,
      createdAt: '',
    }),
    nextAction,
    authorityChanged: false,
    receiptVerified: false,
    productionDone: false,
  };
}

export function renderDispatchPolicyText(result: DispatchPolicy): string {
  return [
    `Dispatch policy (${result.schemaVersion})`,
    `policy: ${result.policy}`,
    `allowedHosts: ${result.allowedHosts.join(', ')}`,
    `allowedPaths: ${result.allowedPaths.join(', ')}`,
    ...(result.deniedPaths.length > 0 ? [`deniedPaths: ${result.deniedPaths.join(', ')}`] : []),
    `maxParallel: ${result.maxParallel}`,
    `maxRuntimeMinutes: ${result.maxRuntimeMinutes}`,
    ...(result.maxBudgetUSD !== undefined ? [`maxBudgetUSD: ${result.maxBudgetUSD}`] : []),
    ...(result.network !== undefined ? [`network: ${result.network}`] : []),
    `requireReceipt: ${result.requireReceipt}`,
    `requireReview: ${result.requireReview}`,
    `allowRealHostSubprocess: ${result.allowRealHostSubprocess === true}`,
    `allowReviewOnlyRealHostSubprocess: ${result.allowReviewOnlyRealHostSubprocess === true}`,
    `allowAutoMerge: ${result.allowAutoMerge}`,
    `allowProductionDone: ${result.allowProductionDone}`,
    `commandAllowlist: ${result.commandAllowlist.join(', ') || '(empty)'}`,
    `createdAt: ${result.createdAt}`,
  ].join('\n');
}

export function renderDispatchPolicyCheckText(result: DispatchPolicyCheckResult): string {
  const lines = [
    `Dispatch policy check (${result.schemaVersion})`,
    `policy: ${result.policy}`,
    `authorized: ${result.authorized}`,
    `status: ${result.status}`,
    'admissibilityStatus: dispatch-policy-check',
    `receiptBundleVerified: ${result.receiptVerified}`,
    'evidenceScope: dispatch-policy',
    `nextAction: ${result.nextAction}`,
  ];
  if (result.reasons.length > 0) {
    lines.push('', 'reasons:');
    lines.push(...result.reasons.map(r => `  - ${r}`));
  }
  if (result.degradations.length > 0) {
    lines.push('', 'degradations:');
    lines.push(...result.degradations.map(d => `  - ${d}`));
  }
  return lines.join('\n');
}
