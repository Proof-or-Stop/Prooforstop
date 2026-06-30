import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { loadConfig, type LatticeConfig } from './config.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from './evidence-freshness.js';
import type { StoryStore } from './store.js';
import { formatValidationCommand, runValidationCommand } from './validation-executor.js';
import type {
  DoneRequiredCommandReceipt,
  DoneRequiredEvidenceData,
  DoneRequiredEvidenceStatus,
  ValidationCommand,
} from './validation-types.js';
import {
  buildProofAdmissibilityDiagnostic,
  proofAdmissibilityBlockingReason,
  resolveProofAdmissibilityPolicy,
  type ProofAdmissibilityDiagnostic,
} from './proof-admissibility-gates.js';

export const DONE_REQUIRED_EVIDENCE_FILE = 'done-required-evidence.json';
export const DONE_REQUIRED_EVIDENCE_SCHEMA = 'lattice.done-required-evidence' as const;
export const DONE_REQUIRED_EVIDENCE_VERSION = 1 as const;

const SHELL_META_RE = /[;&|<>$()`]/;
const OUTPUT_TAIL_CHARS = 4000;
const PACKAGES_MAIN_BUILD_PROOF = 'packages-main-build' as const;

export interface DoneRequiredCommand extends ValidationCommand {
  /**
   * Command-local opt-in for the Orchestrate self-host policy. External
   * projects can require root npm test without inheriting this build proof.
   */
  requiresBuildProof?: typeof PACKAGES_MAIN_BUILD_PROOF;
  /** Explicit marker for a command that produces the packages/main build proof. */
  providesBuildProof?: typeof PACKAGES_MAIN_BUILD_PROOF;
  /** Legacy/provider alias retained for existing evidence policy compatibility. */
  proof?: typeof PACKAGES_MAIN_BUILD_PROOF;
}

export interface DoneRequiredPolicy {
  required: boolean;
  commands: DoneRequiredCommand[];
  configErrors: string[];
  warnings: string[];
  policyHash: string;
  commandSetHash: string;
  source: 'doneRequiredCommands' | 'validationProfiles.done' | 'none';
}

export interface DoneRequiredGateEvaluation {
  required: boolean;
  ok: boolean;
  status: 'pass' | 'fail' | 'warn';
  blocking: boolean;
  detail: string;
  hint: string;
  reasons: string[];
  policy: DoneRequiredPolicy;
  evidence: DoneRequiredEvidenceData | null;
  proofAdmissibility: ProofAdmissibilityDiagnostic;
}

function splitShellWords(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const ch of command) {
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function commandFromString(label: string, value: string): DoneRequiredCommand | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (SHELL_META_RE.test(trimmed)) {
    return { label, command: trimmed, args: [], shell: true };
  }
  const parts = splitShellWords(trimmed);
  if (parts.length === 0) return null;
  return { label, command: parts[0], args: parts.slice(1) };
}

function normalizePackagesMainBuildProof(
  field: string,
  value: unknown,
  errors: string[],
): typeof PACKAGES_MAIN_BUILD_PROOF | undefined {
  if (value === undefined) return undefined;
  if (value === PACKAGES_MAIN_BUILD_PROOF) return PACKAGES_MAIN_BUILD_PROOF;
  errors.push(`${field} must be "${PACKAGES_MAIN_BUILD_PROOF}" when present`);
  return undefined;
}

function normalizeCommandEntry(entry: unknown, index: number, errors: string[]): DoneRequiredCommand | null {
  if (typeof entry === 'string') {
    const command = commandFromString(`doneRequiredCommands[${index}]`, entry);
    if (!command) errors.push(`doneRequiredCommands[${index}] must not be empty`);
    return command;
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    errors.push(`doneRequiredCommands[${index}] must be a string or command object`);
    return null;
  }
  const raw = entry as Record<string, unknown>;
  if (typeof raw.command !== 'string' || raw.command.trim().length === 0) {
    errors.push(`doneRequiredCommands[${index}].command must be a non-empty string`);
    return null;
  }
  const args = raw.args === undefined
    ? []
    : Array.isArray(raw.args)
      ? raw.args.map(String)
      : null;
  if (!args) {
    errors.push(`doneRequiredCommands[${index}].args must be an array when present`);
    return null;
  }
  if (raw.timeoutMs !== undefined && (typeof raw.timeoutMs !== 'number' || !Number.isFinite(raw.timeoutMs) || raw.timeoutMs <= 0)) {
    errors.push(`doneRequiredCommands[${index}].timeoutMs must be a positive number when present`);
  }
  if (raw.optional === true) {
    errors.push(`doneRequiredCommands[${index}].optional is not supported; DONE-required commands are mandatory`);
  }
  const env = raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)
    ? Object.fromEntries(Object.entries(raw.env).map(([k, v]) => [k, String(v)]))
    : undefined;
  if (raw.env !== undefined && !env) {
    errors.push(`doneRequiredCommands[${index}].env must be an object when present`);
  }
  const requiresBuildProof = normalizePackagesMainBuildProof(
    `doneRequiredCommands[${index}].requiresBuildProof`,
    raw.requiresBuildProof,
    errors,
  );
  const providesBuildProof = normalizePackagesMainBuildProof(
    `doneRequiredCommands[${index}].providesBuildProof`,
    raw.providesBuildProof,
    errors,
  );
  const proof = normalizePackagesMainBuildProof(
    `doneRequiredCommands[${index}].proof`,
    raw.proof,
    errors,
  );
  return {
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : `doneRequiredCommands[${index}]`,
    command: raw.command.trim(),
    args,
    ...(raw.shell === true ? { shell: true } : {}),
    ...(typeof raw.cwd === 'string' && raw.cwd.trim() ? { cwd: raw.cwd.trim() } : {}),
    ...(env ? { env } : {}),
    ...(typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0 ? { timeoutMs: raw.timeoutMs } : {}),
    ...(requiresBuildProof ? { requiresBuildProof } : {}),
    ...(providesBuildProof ? { providesBuildProof } : {}),
    ...(proof ? { proof } : {}),
  };
}

function rawDonePolicy(config: LatticeConfig): { source: DoneRequiredPolicy['source']; value: unknown } {
  const cfg = config as LatticeConfig & Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(cfg, 'doneRequiredCommands')) {
    return { source: 'doneRequiredCommands', value: cfg.doneRequiredCommands };
  }
  const profiles = cfg.validationProfiles;
  if (profiles && typeof profiles === 'object' && Object.prototype.hasOwnProperty.call(profiles, 'done')) {
    const done = (profiles as { done?: unknown }).done;
    if (Array.isArray(done)) return { source: 'validationProfiles.done', value: done };
    if (done && typeof done === 'object' && Object.prototype.hasOwnProperty.call(done, 'commands')) {
      return { source: 'validationProfiles.done', value: (done as { commands?: unknown }).commands };
    }
    return { source: 'validationProfiles.done', value: done };
  }
  return { source: 'none', value: undefined };
}

export function resolveDoneRequiredPolicy(projectRoot: string): DoneRequiredPolicy {
  const config = loadConfig(projectRoot);
  const raw = rawDonePolicy(config);
  if (raw.source === 'none') {
    const emptyHash = sha256(stableStringify({ source: 'none', commands: [] }));
    return {
      required: false,
      commands: [],
      configErrors: [],
      warnings: ['No doneRequiredCommands policy configured; DONE-required full-suite proof is advisory only.'],
      policyHash: emptyHash,
      commandSetHash: sha256('[]'),
      source: 'none',
    };
  }

  const errors: string[] = [];
  const commands: DoneRequiredCommand[] = [];
  if (!Array.isArray(raw.value)) {
    errors.push(`${raw.source} must be an array of command entries`);
  } else if (raw.value.length === 0) {
    errors.push(`${raw.source} must include at least one required command`);
  } else {
    for (let i = 0; i < raw.value.length; i++) {
      const command = normalizeCommandEntry(raw.value[i], i, errors);
      if (command) commands.push(command);
    }
  }

  const normalized = commands.map((cmd) => ({
    label: cmd.label,
    command: cmd.command,
    args: cmd.args,
    shell: cmd.shell === true,
    cwd: cmd.cwd ?? '',
    env: cmd.env ?? {},
    timeoutMs: cmd.timeoutMs ?? null,
    requiresBuildProof: cmd.requiresBuildProof ?? '',
    providesBuildProof: cmd.providesBuildProof ?? '',
    proof: cmd.proof ?? '',
  }));
  return {
    required: true,
    commands,
    configErrors: errors,
    warnings: [],
    policyHash: sha256(stableStringify({ source: raw.source, raw: raw.value, normalized })),
    commandSetHash: sha256(stableStringify(normalized)),
    source: raw.source,
  };
}

function commandCwd(projectRoot: string, cwd?: string): string {
  if (!cwd) return projectRoot;
  return isAbsolute(cwd) ? cwd : resolve(projectRoot, cwd);
}

function normalizedCommandCwd(projectRoot: string, cwd?: string): string {
  return commandCwd(projectRoot, cwd).replace(/\\/g, '/');
}

function outputTail(output: string): string {
  return output.length <= OUTPUT_TAIL_CHARS ? output : output.slice(output.length - OUTPUT_TAIL_CHARS);
}

function commandStatus(code: number, timedOut?: boolean): DoneRequiredEvidenceStatus {
  return code === 0 && !timedOut ? 'PASS' : 'FAIL';
}

function receiptLine(receipt: DoneRequiredCommandReceipt): string {
  const args = Array.isArray(receipt.args) ? receipt.args : [];
  return `${receipt.status} ${receipt.label}: ${receipt.command} ${args.join(' ')}`.trim();
}

function isPackagesMainBuild(receipt: DoneRequiredCommandReceipt, projectRoot: string, command?: DoneRequiredCommand): boolean {
  if (receipt.status !== 'PASS') return false;
  if (command?.providesBuildProof === PACKAGES_MAIN_BUILD_PROOF || command?.proof === PACKAGES_MAIN_BUILD_PROOF) return true;
  const cwd = normalizedCommandCwd(projectRoot, receipt.cwd);
  const rootCwd = normalizedCommandCwd(projectRoot);
  const packagesMain = normalizedCommandCwd(projectRoot, 'packages/main');
  const args = Array.isArray(receipt.args) ? receipt.args : [];
  if (receipt.command === 'npm' && cwd === rootCwd) {
    const prefixIndex = args.indexOf('--prefix');
    if (prefixIndex >= 0 && args[prefixIndex + 1] === 'packages/main') {
      return args[prefixIndex + 2] === 'run' && args[prefixIndex + 3] === 'build';
    }
  }
  if (receipt.command === 'npm' && cwd === packagesMain) {
    return args[0] === 'run' && args[1] === 'build';
  }
  if ((receipt.command === 'tsc' || receipt.command.endsWith('/tsc')) && cwd === packagesMain) {
    return true;
  }
  return false;
}

function requiresPackagesMainBuildProof(command?: DoneRequiredCommand): boolean {
  return command?.requiresBuildProof === PACKAGES_MAIN_BUILD_PROOF;
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function validateRequiredReceiptCoverage(
  evidence: Pick<DoneRequiredEvidenceData, 'receipts'>,
  projectRoot: string,
  commands: DoneRequiredCommand[],
): string[] {
  const reasons: string[] = [];
  const receipts = Array.isArray(evidence.receipts) ? evidence.receipts : [];
  if (!Array.isArray(evidence.receipts)) {
    reasons.push('receipt-shape-mismatch: receipts must be an array');
  }
  if (receipts.length !== commands.length) {
    reasons.push(`receipt-count-mismatch: expected ${commands.length}, got ${receipts.length}`);
  }

  for (let i = 0; i < commands.length; i++) {
    const command = commands[i];
    const receipt = receipts[i];
    if (!receipt) {
      reasons.push(`missing-receipt[${i}]: ${formatDoneRequiredCommand(command)}`);
      continue;
    }

    if (receipt.command !== command.command) {
      reasons.push(`receipt-command-mismatch[${i}]: expected ${command.command}, got ${receipt.command}`);
    }
    if (!Array.isArray(receipt.args) || !sameStringArray(receipt.args, command.args)) {
      const actualArgs = Array.isArray(receipt.args) ? receipt.args : [];
      reasons.push(`receipt-args-mismatch[${i}]: expected ${JSON.stringify(command.args)}, got ${JSON.stringify(actualArgs)}`);
    }

    const expectedCwd = normalizedCommandCwd(projectRoot, command.cwd);
    const actualCwd = typeof receipt.cwd === 'string'
      ? normalizedCommandCwd(projectRoot, receipt.cwd)
      : '';
    if (actualCwd !== expectedCwd) {
      reasons.push(`receipt-cwd-mismatch[${i}]: expected ${expectedCwd}, got ${actualCwd || '<missing>'}`);
    }

    const expectedShell = command.shell === true;
    const actualShell = receipt.shell === true;
    if (actualShell !== expectedShell) {
      reasons.push(`receipt-shell-mismatch[${i}]: expected ${expectedShell}, got ${actualShell}`);
    }

    if (receipt.status !== 'PASS' || receipt.exitCode !== 0 || receipt.timedOut === true) {
      reasons.push(`receipt-status-fail[${i}]: status=${receipt.status} exitCode=${receipt.exitCode} timedOut=${receipt.timedOut === true}`);
    }
  }

  return reasons;
}

export function validateSelfHostBuildProof(
  evidence: Pick<DoneRequiredEvidenceData, 'receipts'>,
  projectRoot: string,
  commands: DoneRequiredCommand[] = [],
): string[] {
  const reasons: string[] = [];
  const receipts = Array.isArray(evidence.receipts) ? evidence.receipts : [];
  for (let i = 0; i < receipts.length; i++) {
    const receipt = receipts[i];
    const command = commands[i];
    if (!requiresPackagesMainBuildProof(command)) continue;
    const build = receipts.slice(0, i).find((candidate, candidateIndex) => (
      isPackagesMainBuild(candidate, projectRoot, commands[candidateIndex]) &&
      candidate.materialHash &&
      receipt.materialHash &&
      candidate.materialHash === receipt.materialHash
    ));
    if (!build) {
      reasons.push(`missing-build-proof: ${receipt.label} requires a preceding PASS receipt for npm --prefix packages/main run build, or equivalent packages/main build proof, with the same materialHash`);
    }
  }
  return reasons;
}

export async function runDoneRequiredValidation(args: {
  projectRoot: string;
  storyId: string;
  store: StoryStore;
  gitCwd: string;
}): Promise<DoneRequiredEvidenceData> {
  const policy = resolveDoneRequiredPolicy(args.projectRoot);
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const receipts: DoneRequiredCommandReceipt[] = [];
  const reasons: string[] = [];

  if (!policy.required) {
    reasons.push('no doneRequiredCommands policy configured');
  }
  if (policy.configErrors.length > 0) {
    reasons.push(...policy.configErrors.map((error) => `config-error: ${error}`));
  }

  if (policy.required && policy.configErrors.length === 0) {
    for (const command of policy.commands) {
      const receiptStartedMs = Date.now();
      const receiptStartedAt = new Date(receiptStartedMs).toISOString();
      const result = await runValidationCommand(command, args.projectRoot);
      const receiptEndedAt = new Date().toISOString();
      const headHash = currentGitHead(args.gitCwd);
      const materialHash = currentMaterialHash(args.gitCwd, 'HEAD', args.projectRoot);
      const storyFilesHash = currentStoryFilesHash(args.gitCwd, 'HEAD', args.projectRoot);
      const status = commandStatus(result.code, result.timedOut);
      const receipt: DoneRequiredCommandReceipt = {
        label: result.label,
        command: result.command,
        args: result.args,
        ...(result.shell ? { shell: true } : {}),
        cwd: result.cwd ?? commandCwd(args.projectRoot, command.cwd),
        status,
        exitCode: result.code,
        durationMs: result.durationMs,
        outputDigest: sha256(result.output),
        outputTail: outputTail(result.output),
        startedAt: receiptStartedAt,
        endedAt: receiptEndedAt,
        ...(result.timedOut ? { timedOut: true } : {}),
        ...(headHash ? { headHash } : {}),
        ...(materialHash ? { materialHash } : {}),
        ...(storyFilesHash ? { storyFilesHash } : {}),
      };
      receipts.push(receipt);
      if (status === 'FAIL') {
        reasons.push(`command-failed: ${receiptLine(receipt)} exitCode=${receipt.exitCode}`);
      }
    }
  }

  reasons.push(...validateSelfHostBuildProof({ receipts }, args.projectRoot, policy.commands));

  const endedMs = Date.now();
  const finalHeadHash = currentGitHead(args.gitCwd);
  const finalMaterialHash = currentMaterialHash(args.gitCwd, 'HEAD', args.projectRoot);
  const finalStoryFilesHash = currentStoryFilesHash(args.gitCwd, 'HEAD', args.projectRoot);
  const status: DoneRequiredEvidenceStatus = policy.required && reasons.length === 0 ? 'PASS' : 'FAIL';
  const evidence: DoneRequiredEvidenceData = {
    schema: DONE_REQUIRED_EVIDENCE_SCHEMA,
    version: DONE_REQUIRED_EVIDENCE_VERSION,
    storyId: args.storyId,
    status,
    startedAt,
    endedAt: new Date(endedMs).toISOString(),
    durationMs: endedMs - startedMs,
    ...(finalHeadHash ? { headHash: finalHeadHash } : {}),
    ...(finalMaterialHash ? { materialHash: finalMaterialHash } : {}),
    ...(finalStoryFilesHash ? { storyFilesHash: finalStoryFilesHash } : {}),
    policyHash: policy.policyHash,
    commandSetHash: policy.commandSetHash,
    receipts,
    reasons,
    ...(policy.configErrors.length > 0 ? { configErrors: policy.configErrors } : {}),
  };
  args.store.writeDoneRequiredEvidence(args.storyId, evidence);
  return evidence;
}

export function evaluateDoneRequiredEvidence(args: {
  projectRoot: string;
  storyId: string;
  store: StoryStore;
  gitCwd: string;
}): DoneRequiredGateEvaluation {
  const policy = resolveDoneRequiredPolicy(args.projectRoot);
  const proofPolicy = resolveProofAdmissibilityPolicy(args.projectRoot);
  const doneRequiredDiagnostic = (evidence: DoneRequiredEvidenceData | null, ok: boolean): ProofAdmissibilityDiagnostic => buildProofAdmissibilityDiagnostic({
    artifactKind: 'done-required-evidence',
    artifactId: DONE_REQUIRED_EVIDENCE_FILE,
    consumer: 'DONE_REQUIRED',
    claim: 'done-readiness',
    policy: proofPolicy,
    checks: {
      schemaVersion: evidence?.schema === DONE_REQUIRED_EVIDENCE_SCHEMA && evidence?.version === DONE_REQUIRED_EVIDENCE_VERSION
        ? 'lattice.done_required_evidence.v1'
        : undefined,
      strictShapeValid: Boolean(evidence),
      semanticDigestValid: ok,
      temporalAndMaterialBindingValid: ok,
      subjectMatches: evidence ? evidence.storyId === args.storyId : false,
      producerBoundaryTrusted: Boolean(evidence),
    },
  });
  const withProofBlock = (
    result: Omit<DoneRequiredGateEvaluation, 'blocking' | 'ok' | 'status'> & Pick<DoneRequiredGateEvaluation, 'ok' | 'status'>,
  ): DoneRequiredGateEvaluation => {
    const reason = proofAdmissibilityBlockingReason(result.proofAdmissibility);
    if (!reason) {
      return { ...result, blocking: !result.ok && result.status === 'fail' };
    }
    return {
      ...result,
      ok: false,
      status: 'fail',
      blocking: true,
      detail: result.ok ? reason : result.detail,
      hint: result.hint ? `${result.hint}\n${reason}` : reason,
      reasons: [...new Set([...result.reasons, reason])],
    };
  };
  if (!policy.required) {
    return {
      required: false,
      ok: true,
      status: 'warn',
      blocking: false,
      detail: 'no doneRequiredCommands policy configured; no full-suite DONE claim',
      hint: 'External projects are advisory by default. Configure doneRequiredCommands to make DONE-required validation blocking.',
      reasons: policy.warnings,
      policy,
      evidence: null,
      proofAdmissibility: doneRequiredDiagnostic(null, false),
    };
  }
  if (policy.configErrors.length > 0) {
    return withProofBlock({
      required: true,
      ok: false,
      status: 'fail',
      detail: `malformed DONE-required policy: ${policy.configErrors[0]}`,
      hint: policy.configErrors.join('\n'),
      reasons: policy.configErrors,
      policy,
      evidence: null,
      proofAdmissibility: doneRequiredDiagnostic(null, false),
    });
  }

  const evidence = args.store.readDoneRequiredEvidence(args.storyId);
  if (!evidence) {
    return withProofBlock({
      required: true,
      ok: false,
      status: 'fail',
      detail: 'missing done-required-evidence.json',
      hint: `lattice done_required_validate --storyId=${args.storyId}`,
      reasons: ['missing-artifact'],
      policy,
      evidence: null,
      proofAdmissibility: doneRequiredDiagnostic(null, false),
    });
  }

  const reasons: string[] = [];
  if (evidence.schema !== DONE_REQUIRED_EVIDENCE_SCHEMA || evidence.version !== DONE_REQUIRED_EVIDENCE_VERSION) {
    reasons.push('schema-version-mismatch');
  }
  if (evidence.storyId !== args.storyId) reasons.push(`storyId-mismatch: ${evidence.storyId}`);
  if (evidence.status !== 'PASS') reasons.push(...(evidence.reasons.length > 0 ? evidence.reasons : ['status-fail']));
  if (evidence.policyHash !== policy.policyHash) reasons.push('policy-drift');
  if (evidence.commandSetHash !== policy.commandSetHash) reasons.push('command-set-drift');
  reasons.push(...validateRequiredReceiptCoverage(evidence, args.projectRoot, policy.commands));

  const currentMaterial = currentMaterialHash(args.gitCwd, 'HEAD', args.projectRoot);
  const currentStoryFiles = currentStoryFilesHash(args.gitCwd, 'HEAD', args.projectRoot);
  // headHash remains an audit stamp only. Committing done-required-evidence.json
  // bumps HEAD with story metadata, while materialHash excludes story metadata
  // and still changes for real code/config drift. Blocking on headHash deadlocked
  // DONE: writing the evidence moved HEAD past the recorded headHash, re-staling
  // freshly-validated evidence. materialHash + storyFilesHash are the authoritative
  // freshness gate; both still re-stale on genuine code/config/story drift.
  if (!evidence.materialHash || !currentMaterial) reasons.push('missing-materialHash');
  else if (evidence.materialHash !== currentMaterial) reasons.push('stale-material');
  if (!evidence.storyFilesHash || !currentStoryFiles) reasons.push('missing-storyFilesHash');
  else if (evidence.storyFilesHash !== currentStoryFiles) reasons.push('stale-storyFilesHash');
  reasons.push(...validateSelfHostBuildProof(evidence, args.projectRoot, policy.commands));

  const uniqueReasons = [...new Set(reasons)];
  if (uniqueReasons.length > 0) {
    return withProofBlock({
      required: true,
      ok: false,
      status: 'fail',
      detail: uniqueReasons.slice(0, 3).join(', '),
      hint: [
        ...uniqueReasons,
        `rerun: lattice done_required_validate --storyId=${args.storyId}`,
      ].join('\n'),
      reasons: uniqueReasons,
      policy,
      evidence,
      proofAdmissibility: doneRequiredDiagnostic(evidence, false),
    });
  }

  return withProofBlock({
    required: true,
    ok: true,
    status: 'pass',
    detail: `PASS @ ${evidence.endedAt}; ${evidence.receipts.length} required command(s)`,
    hint: evidence.receipts.map(receiptLine).join('\n'),
    reasons: [],
    policy,
    evidence,
    proofAdmissibility: doneRequiredDiagnostic(evidence, true),
  });
}

export function renderDoneRequiredEvidence(evidence: DoneRequiredEvidenceData): string {
  const lines = [
    `DONE-required validation: ${evidence.status}`,
    `storyId: ${evidence.storyId}`,
    `durationMs: ${evidence.durationMs}`,
    `policyHash: ${evidence.policyHash}`,
    `commandSetHash: ${evidence.commandSetHash}`,
  ];
  for (const receipt of evidence.receipts) {
    lines.push(`- ${receiptLine(receipt)} exitCode=${receipt.exitCode} durationMs=${receipt.durationMs}`);
  }
  for (const reason of evidence.reasons) lines.push(`reason: ${reason}`);
  return lines.join('\n');
}

export function formatDoneRequiredCommand(command: DoneRequiredCommand): string {
  return formatValidationCommand(command);
}
