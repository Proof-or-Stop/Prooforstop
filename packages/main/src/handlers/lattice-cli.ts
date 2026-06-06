import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { HandlerContext } from './context.js';
import { loadAuthoritySettings, type AuthoritySettings } from '../core/authority-mode.js';
import {
  AUTHORITY_RUNNER_PLANNED_STEPS,
  readActorPrivateKeyFromPath,
  runLatticeAuthorityControlPlaneOnce,
  type AuthorityRunnerPlan,
} from '../core/authority-runner.js';
import type { LatticeAuthorityKeyEncoding } from '../core/lattice-authority-native.js';
import { verifyLatticeAuthorityReceipt } from '../core/lattice-authority-native.js';
import {
  LATTICE_CLI_VERSION,
  LATTICE_PRODUCT_NAME,
  formatLatticeProductLine,
} from '../core/lattice-brand.js';
import {
  buildLatticeHostInstallGuidance,
  buildLatticeHostList,
  buildLatticeHostProbe,
  buildLatticeHostStatus,
  renderLatticeHostInstallText,
  renderLatticeHostListText,
  renderLatticeHostProbeText,
  renderLatticeHostStatusText,
  type LatticeFormat,
} from '../core/lattice-hosts.js';

type FormatArgs = { format?: LatticeFormat; json?: boolean };

const AUTHORITY_DISCLAIMER =
  'Receipt-aware status only: no receipt is verified, no evidence is submitted, and productionDone remains false.';

const LOCAL_WORKFLOW_NOTE =
  'Local workflow (story_advance / verification_evidence_add / DONE gate) does not depend on remote authority; missing enforce prerequisites are readiness warnings, not global blockers.';

function wantsJson(args: FormatArgs | undefined): boolean {
  return args?.format === 'json' || args?.json === true;
}

/**
 * Read presence-only env var indicators for enforce-runner prerequisites.
 *
 * These are pure diagnostics: the CLI never claims, generates, signs, or
 * verifies anything based on these env vars under PD-1 / PD-2. Their presence
 * just lets users sanity-check their env wiring; their absence becomes a
 * readiness warning when authority mode is shadow / enforce.
 *
 * No new behavior is gated on these env vars and they do NOT promote
 * productionDone / receiptVerified / canClaimProductionDone away from `false`.
 */
function readEnforceEnv(env: Record<string, string | undefined>): {
  actorKeyConfigured: boolean;
  runnerConfigured: boolean;
  sessionConfigured: boolean;
} {
  const present = (key: string): boolean => typeof envValue(env, key) === 'string';
  return {
    actorKeyConfigured:
      present('ACTOR_KEY') || present('ACTOR_KEY_PATH'),
    runnerConfigured: present('RUNNER_ID'),
    sessionConfigured: present('SESSION_ID'),
  };
}

function envValue(env: Record<string, string | undefined>, suffix: string): string | undefined {
  const canonical = env[`LATTICE_AUTHORITY_${suffix}`];
  if (typeof canonical === 'string' && canonical.trim().length > 0) return canonical.trim();
  const legacy = env[`KOALA_AUTHORITY_${suffix}`];
  if (typeof legacy === 'string' && legacy.trim().length > 0) return legacy.trim();
  return undefined;
}

interface AuthorityReadiness {
  /** Always true: local story / phase / DONE gates do not consume server receipts. */
  localWorkflowUsable: true;
  /** Top-level mode alias, matching `authorityMode`. */
  mode: AuthoritySettings['mode'];
  authorityUrlConfigured: boolean;
  actorKeyConfigured: boolean;
  runnerConfigured: boolean;
  sessionConfigured: boolean;
  /**
   * Actionable warnings when shadow / enforce is configured but prerequisites
   * are missing. Empty in `off` mode (user opted out of authority altogether).
   */
  readinessWarnings: string[];
  /** Suggested commands / env to address each readiness warning. */
  nextActions: string[];
}

function buildAuthorityReadiness(
  settings: AuthoritySettings,
  env: Record<string, string | undefined>,
): AuthorityReadiness {
  const enforce = readEnforceEnv(env);
  const authorityUrlConfigured =
    typeof settings.baseURL === 'string' && settings.baseURL.length > 0;
  const warnings: string[] = [];
  const actions: string[] = [];

  if (settings.mode === 'shadow') {
    if (!authorityUrlConfigured) {
      warnings.push(
        'shadow mode set but LATTICE_AUTHORITY_URL is empty; observational POSTs will be skipped',
      );
      actions.push('export LATTICE_AUTHORITY_URL=https://<authority-host>');
    }
  } else if (settings.mode === 'enforce') {
    if (!authorityUrlConfigured) {
      warnings.push(
        'enforce mode set but LATTICE_AUTHORITY_URL is empty; runner / policy discovery cannot reach the Lattice Authority server',
      );
      actions.push('export LATTICE_AUTHORITY_URL=https://<authority-host>');
    }
    if (!enforce.actorKeyConfigured) {
      warnings.push(
        'enforce mode set but no LATTICE_AUTHORITY_ACTOR_KEY / LATTICE_AUTHORITY_ACTOR_KEY_PATH detected; live runner submissions would be unsigned and rejected',
      );
      actions.push(
        'configure an actor private key via LATTICE_AUTHORITY_ACTOR_KEY_PATH=<path>',
      );
    }
    if (!enforce.runnerConfigured) {
      warnings.push(
        'enforce mode set but LATTICE_AUTHORITY_RUNNER_ID is empty; runner identity binding would be missing',
      );
      actions.push('export LATTICE_AUTHORITY_RUNNER_ID=<runner-id>');
    }
  }

  return {
    localWorkflowUsable: true,
    mode: settings.mode,
    authorityUrlConfigured,
    actorKeyConfigured: enforce.actorKeyConfigured,
    runnerConfigured: enforce.runnerConfigured,
    sessionConfigured: enforce.sessionConfigured,
    readinessWarnings: warnings,
    nextActions: actions,
  };
}

function readPackageVersion(path: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

function packageBinHasLattice(path: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { bin?: Record<string, unknown> };
    return parsed.bin?.lattice === 'dist/cli.js' && parsed.bin?.koala === 'dist/cli.js';
  } catch {
    return false;
  }
}

function buildConfigDoctor(ctx: HandlerContext) {
  const rootPackagePath = join(ctx.root, 'package.json');
  const mainPackagePath = join(ctx.root, 'packages', 'main', 'package.json');
  const versions = {
    root: readPackageVersion(rootPackagePath),
    main: readPackageVersion(mainPackagePath),
    expected: LATTICE_CLI_VERSION,
  };
  const checks = [
    {
      id: 'root-package-version',
      ok: versions.root === LATTICE_CLI_VERSION,
      detail: `root package version=${versions.root ?? 'unreadable'}`,
    },
    {
      id: 'main-package-version',
      ok: versions.main === LATTICE_CLI_VERSION,
      detail: `packages/main version=${versions.main ?? 'unreadable'}`,
    },
    {
      id: 'lattice-local-wrapper',
      ok: existsSync(join(ctx.root, 'bin', 'lattice.js')),
      detail: 'bin/lattice.js exists as the primary local bootstrap wrapper',
    },
    {
      id: 'legacy-koala-wrapper',
      ok: existsSync(join(ctx.root, 'bin', 'koala.js')),
      detail: 'bin/koala.js remains available as the legacy alias',
    },
    {
      id: 'package-bin-aliases',
      ok: packageBinHasLattice(mainPackagePath),
      detail: 'packages/main package.json exposes both lattice and koala bins',
    },
  ];
  const ok = checks.every(check => check.ok);
  return {
    schemaVersion: 'lattice.config_doctor.v1' as const,
    product: { name: LATTICE_PRODUCT_NAME, version: LATTICE_CLI_VERSION },
    ok,
    status: ok ? 'pass' as const : 'warn' as const,
    migration: {
      cliFirst: true as const,
      macAppRequired: false as const,
      macAppRole: 'optional-dashboard-archive' as const,
      legacyKoalaAliasPreserved: true as const,
    },
    versions,
    checks,
    authority: {
      productionDone: false as const,
      receiptVerified: false as const,
      note: AUTHORITY_DISCLAIMER,
    },
  };
}

function renderConfigDoctorText(result: ReturnType<typeof buildConfigDoctor>): string {
  return [
    `${formatLatticeProductLine()} config doctor (${result.schemaVersion})`,
    `status: ${result.status}`,
    `migration: cliFirst=${result.migration.cliFirst}; macAppRequired=${result.migration.macAppRequired}; macAppRole=${result.migration.macAppRole}; legacyKoalaAliasPreserved=${result.migration.legacyKoalaAliasPreserved}`,
    `versions: root=${result.versions.root ?? 'unreadable'}; main=${result.versions.main ?? 'unreadable'}; expected=${result.versions.expected}`,
    `authority: productionDone=${result.authority.productionDone}; receiptVerified=${result.authority.receiptVerified}`,
    '',
    'checks:',
    ...result.checks.map(check => `  - ${check.id}: ${check.ok ? 'pass' : 'warn'} — ${check.detail}`),
    '',
    result.authority.note,
  ].join('\n');
}

export function buildAuthorityStatus(
  args: { authorityMode?: string; authorityURL?: string; authorityTimeoutMS?: number } = {},
  env: Record<string, string | undefined> = process.env,
) {
  const settings = loadAuthoritySettings(env, args);
  const readiness = buildAuthorityReadiness(settings, env);
  const baseURLConfigured = readiness.authorityUrlConfigured;
  return {
    schemaVersion: 'lattice.authority_status.v1' as const,
    product: { name: LATTICE_PRODUCT_NAME, version: LATTICE_CLI_VERSION },
    authorityMode: settings.mode,
    /** Alias of `authorityMode`; convenience for `mode:"off"` JSON consumers. */
    mode: readiness.mode,
    baseURLConfigured,
    baseURL: settings.baseURL ?? null,
    timeoutMS: settings.timeoutMS,
    serverReachability: 'not-probed' as const,
    receiptVerified: false as const,
    productionDone: false as const,
    canClaimProductionDone: false as const,
    status: baseURLConfigured ? 'configured-no-verified-receipt' as const : 'not-configured' as const,
    // Readiness diagnostics (B-b710 / Milestones 3-4):
    //   - localWorkflowUsable is always true; local lifecycle gates do not consume
    //     server receipts (PD-1 / PD-2 thin-client client role).
    //   - readinessWarnings / nextActions are surfaced when shadow / enforce is
    //     configured but prerequisites are missing — they are NOT global blockers
    //     and the local CLI workflow keeps working.
    localWorkflowUsable: readiness.localWorkflowUsable,
    authorityUrlConfigured: readiness.authorityUrlConfigured,
    actorKeyConfigured: readiness.actorKeyConfigured,
    runnerConfigured: readiness.runnerConfigured,
    sessionConfigured: readiness.sessionConfigured,
    readinessWarnings: readiness.readinessWarnings,
    nextActions: readiness.nextActions,
    localWorkflowNote: LOCAL_WORKFLOW_NOTE,
    note: AUTHORITY_DISCLAIMER,
  };
}

function renderAuthorityStatusText(result: ReturnType<typeof buildAuthorityStatus>): string {
  const lines = [
    `${formatLatticeProductLine()} authority status (${result.schemaVersion})`,
    `status: ${result.status}`,
    `mode: ${result.mode}`,
    `authorityMode: ${result.authorityMode}`,
    `localWorkflowUsable: ${result.localWorkflowUsable}`,
    `authorityUrlConfigured: ${result.authorityUrlConfigured}`,
    `actorKeyConfigured: ${result.actorKeyConfigured}`,
    `runnerConfigured: ${result.runnerConfigured}`,
    `serverReachability: ${result.serverReachability}`,
    `receiptVerified: ${result.receiptVerified}`,
    `productionDone: ${result.productionDone}`,
    `canClaimProductionDone: ${result.canClaimProductionDone}`,
  ];
  if (result.readinessWarnings.length > 0) {
    lines.push('', 'readinessWarnings:');
    for (const w of result.readinessWarnings) lines.push(`  - ${w}`);
  }
  if (result.nextActions.length > 0) {
    lines.push('', 'nextActions:');
    for (const a of result.nextActions) lines.push(`  - ${a}`);
  }
  lines.push('', result.localWorkflowNote);
  lines.push('', result.note);
  return lines.join('\n');
}

export function buildAuthorityEnforceRunnerPlan(
  args: { once?: boolean; dryRun?: boolean; live?: boolean; authorityMode?: string; authorityURL?: string; authorityTimeoutMS?: number } = {},
  env: Record<string, string | undefined> = process.env,
): AuthorityRunnerPlan {
  const settings = loadAuthoritySettings(env, { ...args, authorityMode: args.authorityMode ?? 'enforce' });
  const readiness = buildAuthorityReadiness({ ...settings, mode: 'enforce' }, env);
  const missing = [...readiness.readinessWarnings];
  const actions = [...readiness.nextActions];
  if (args.live === true && !envValue(env, 'PROJECT_ID')) {
    missing.push(
      'live enforce runner requires LATTICE_AUTHORITY_PROJECT_ID so runner registration is bound to a project',
    );
    actions.push('export LATTICE_AUTHORITY_PROJECT_ID=<project-id>');
  }
  return {
    schemaVersion: 'lattice.authority_enforce_runner.v1',
    mode: 'enforce',
    once: args.once !== false,
    dryRun: args.dryRun === true,
    live: args.live === true,
    plannedSteps: [...AUTHORITY_RUNNER_PLANNED_STEPS],
    spawned: false,
    providerEvents: [],
    localWorkflowUsable: true,
    status: missing.length === 0 ? 'pass' : 'fail',
    readinessWarnings: missing,
    nextActions: actions,
    note: args.dryRun === true
      ? 'Dry-run only: planned runner register/heartbeat/claim steps; no network mutation and no provider execution.'
      : args.live === true
        ? 'Live control-plane smoke: register runner, heartbeat, claim at most one job, and release it without provider execution.'
        : 'Runner execution stays local unless --live is provided; no provider execution occurs in this command.',
  };
}

function readLiveRunnerOptions(
  settings: AuthoritySettings,
  args: { once?: boolean },
  env: Record<string, string | undefined>,
) {
  const actorKeyPath = envValue(env, 'ACTOR_KEY_PATH');
  const actorPrivateKey = envValue(env, 'ACTOR_KEY') ??
    (actorKeyPath ? readActorPrivateKeyFromPath(actorKeyPath) : undefined);
  if (!settings.baseURL) throw new Error('LATTICE_AUTHORITY_URL is required for live runner mode');
  if (!actorPrivateKey) throw new Error('LATTICE_AUTHORITY_ACTOR_KEY or LATTICE_AUTHORITY_ACTOR_KEY_PATH is required for live runner mode');
  const runnerId = envValue(env, 'RUNNER_ID');
  if (!runnerId) throw new Error('LATTICE_AUTHORITY_RUNNER_ID is required for live runner mode');
  const sessionId = envValue(env, 'SESSION_ID') ?? `${runnerId}:session`;
  const projectId = envValue(env, 'PROJECT_ID');
  if (!projectId) throw new Error('LATTICE_AUTHORITY_PROJECT_ID is required for live runner mode');
  const keyEncoding = (envValue(env, 'ACTOR_KEY_ENCODING') ?? 'auto') as LatticeAuthorityKeyEncoding;
  return {
    baseURL: settings.baseURL,
    timeoutMS: settings.timeoutMS,
    actorId: envValue(env, 'ACTOR_ID') ?? runnerId,
    role: envValue(env, 'ACTOR_ROLE') ?? 'runner',
    actorKeyId: envValue(env, 'ACTOR_KEY_ID') ?? 'default',
    actorPrivateKey,
    actorPrivateKeyEncoding: keyEncoding,
    runnerId,
    sessionId,
    projectId,
    bootstrapToken: envValue(env, 'BOOTSTRAP_TOKEN'),
    once: args.once !== false,
  };
}

export async function runAuthorityEnforceRunner(
  args: { once?: boolean; dryRun?: boolean; live?: boolean; authorityMode?: string; authorityURL?: string; authorityTimeoutMS?: number } = {},
  env: Record<string, string | undefined> = process.env,
): Promise<AuthorityRunnerPlan> {
  const plan = buildAuthorityEnforceRunnerPlan(args, env);
  if (args.live !== true || args.dryRun === true) return plan;
  if (plan.status === 'fail') {
    return {
      ...plan,
      dryRun: false,
      live: true,
      note: 'Live runner was not started because required Lattice Authority configuration is missing.',
    };
  }
  const settings = loadAuthoritySettings(env, { ...args, authorityMode: args.authorityMode ?? 'enforce' });
  try {
    const live = await runLatticeAuthorityControlPlaneOnce(readLiveRunnerOptions(settings, args, env));
    return {
      ...plan,
      dryRun: false,
      live: true,
      status: live.status,
      networkEvents: live.networkEvents,
      claimedJobId: live.claimedJobId,
      releasedJobId: live.releasedJobId,
      releaseReason: live.releaseReason,
      note: live.note,
    };
  } catch (error: any) {
    return {
      ...plan,
      dryRun: false,
      live: true,
      status: 'fail',
      networkEvents: [],
      claimedJobId: null,
      releasedJobId: null,
      readinessWarnings: [...plan.readinessWarnings, error?.message || String(error)],
      note: 'Live runner failed before the first authority request.',
    };
  }
}

function renderAuthorityEnforceRunnerText(result: AuthorityRunnerPlan): string {
  const lines = [
    `${formatLatticeProductLine()} authority enforce runner (${result.schemaVersion})`,
    `status: ${result.status}`,
    `mode: ${result.mode}`,
    `once: ${result.once}`,
    `dryRun: ${result.dryRun}`,
    `live: ${result.live === true}`,
    `spawned: ${result.spawned}`,
    `providerEvents: ${result.providerEvents.length}`,
    'plannedSteps:',
    ...result.plannedSteps.map(step => `  - ${step}`),
  ];
  if (result.readinessWarnings.length > 0) {
    lines.push('', 'readinessWarnings:', ...result.readinessWarnings.map(w => `  - ${w}`));
  }
  if (result.nextActions.length > 0) {
    lines.push('', 'nextActions:', ...result.nextActions.map(a => `  - ${a}`));
  }
  if (result.networkEvents && result.networkEvents.length > 0) {
    lines.push('', 'networkEvents:', ...result.networkEvents.map(event => `  - ${event.step}: ${event.ok ? 'pass' : 'fail'}${event.status ? ` status=${event.status}` : ''}${event.message ? ` ${event.message}` : ''}`));
  }
  lines.push('', result.note);
  return lines.join('\n');
}

export function buildAuthorityReceiptVerify(
  args: {
    receiptFile?: string;
    serverPublicKey?: string;
    serverPublicKeyEncoding?: LatticeAuthorityKeyEncoding;
    receiptKind?: string;
    receiptProjectId?: string;
    receiptStoryId?: string;
    serverKeyId?: string;
    expectedDecisionDigest?: string;
    receiptMaxAgeMs?: number;
    receiptClockSkewMs?: number;
  },
) {
  if (!args.receiptFile || !args.serverPublicKey) {
    return {
      schemaVersion: 'lattice.authority_receipt_verify.v1' as const,
      ok: false,
      status: 'fail' as const,
      verified: false,
      reason: 'receiptFile and serverPublicKey are required',
    };
  }
  try {
    const receipt = JSON.parse(readFileSync(args.receiptFile, 'utf8')) as unknown;
    const result = verifyLatticeAuthorityReceipt(receipt, {
      serverPublicKey: args.serverPublicKey,
      serverPublicKeyEncoding: args.serverPublicKeyEncoding ?? 'auto',
      expectedKind: args.receiptKind,
      expectedProjectId: args.receiptProjectId,
      expectedStoryId: args.receiptStoryId,
      expectedServerKeyId: args.serverKeyId,
      expectedDecisionDigest: args.expectedDecisionDigest,
      maxAgeMs: args.receiptMaxAgeMs ?? numericEnv(process.env.LATTICE_AUTHORITY_RECEIPT_MAX_AGE_MS, 600_000),
      clockSkewMs: args.receiptClockSkewMs ?? numericEnv(process.env.LATTICE_AUTHORITY_RECEIPT_CLOCK_SKEW_MS, 300_000),
    });
    return {
      schemaVersion: 'lattice.authority_receipt_verify.v1' as const,
      ok: result.verified,
      status: result.verified ? 'pass' as const : 'fail' as const,
      verified: result.verified,
      receiptId: result.receipt.receiptId,
      kind: result.receipt.kind,
      projectId: result.receipt.projectId,
      storyId: result.receipt.storyId ?? null,
      serverKeyId: result.receipt.serverKeyId,
      decisionDigest: result.receipt.decisionDigest ?? null,
      reason: result.reason,
    };
  } catch (error: any) {
    return {
      schemaVersion: 'lattice.authority_receipt_verify.v1' as const,
      ok: false,
      status: 'fail' as const,
      verified: false,
      reason: error?.message || String(error),
    };
  }
}

function numericEnv(value: string | undefined, fallback: number): number {
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function renderAuthorityReceiptVerifyText(result: ReturnType<typeof buildAuthorityReceiptVerify>): string {
  return [
    `${formatLatticeProductLine()} authority receipt verify (${result.schemaVersion})`,
    `status: ${result.status}`,
    `verified: ${result.verified}`,
    'receiptId' in result ? `receiptId: ${result.receiptId}` : null,
    'kind' in result ? `kind: ${result.kind}` : null,
    'serverKeyId' in result ? `serverKeyId: ${result.serverKeyId}` : null,
    '',
    result.reason,
  ].filter((line): line is string => typeof line === 'string').join('\n');
}

export function buildConduitStatus(env: Record<string, string | undefined> = process.env) {
  const settings = loadAuthoritySettings(env);
  const readiness = buildAuthorityReadiness(settings, env);
  return {
    schemaVersion: 'lattice.conduit_status.v1' as const,
    product: { name: LATTICE_PRODUCT_NAME, version: LATTICE_CLI_VERSION },
    conduitAvailable: true as const,
    conduitRole: 'cli-diagnostics-and-handoff' as const,
    runnerProvisioned: false as const,
    modelRunnerCreated: false as const,
    productionDone: false as const,
    receiptVerified: false as const,
    authorityChanged: false as const,
    // Readiness mirror (B-b710): same diagnostic surface as authority_status so
    // dashboards / agents can read either command and get a consistent picture.
    localWorkflowUsable: readiness.localWorkflowUsable,
    mode: readiness.mode,
    authorityUrlConfigured: readiness.authorityUrlConfigured,
    actorKeyConfigured: readiness.actorKeyConfigured,
    runnerConfigured: readiness.runnerConfigured,
    sessionConfigured: readiness.sessionConfigured,
    readinessWarnings: readiness.readinessWarnings,
    nextActions: readiness.nextActions,
    localWorkflowNote: LOCAL_WORKFLOW_NOTE,
    supportedSurfaces: [
      'host_list',
      'host_probe',
      'host_status',
      'host_install',
      'lattice_config_doctor',
      'authority_status',
      'handoff_create',
      'handoff_accept',
      'handoff_resume',
      'handoff_receipt_submit',
      'handoff_worktree_create',
      'host_dispatch',
      'evidence_manifest',
      'evidence_inspect',
      'parallel_wave_create',
      'parallel_plan',
    ],
    warnings: [
      'The CLI conduit coordinates diagnostics and handoff projections only.',
      'It does not provision a new model runner, sign envelopes, verify receipts, or grant production authority.',
    ],
  };
}

function renderConduitStatusText(result: ReturnType<typeof buildConduitStatus>): string {
  const lines = [
    `${formatLatticeProductLine()} conduit status (${result.schemaVersion})`,
    `conduitAvailable: ${result.conduitAvailable}`,
    `conduitRole: ${result.conduitRole}`,
    `mode: ${result.mode}`,
    `localWorkflowUsable: ${result.localWorkflowUsable}`,
    `authorityUrlConfigured: ${result.authorityUrlConfigured}`,
    `actorKeyConfigured: ${result.actorKeyConfigured}`,
    `runnerConfigured: ${result.runnerConfigured}`,
    `runnerProvisioned: ${result.runnerProvisioned}`,
    `modelRunnerCreated: ${result.modelRunnerCreated}`,
    `productionDone: ${result.productionDone}`,
    `receiptVerified: ${result.receiptVerified}`,
    `authorityChanged: ${result.authorityChanged}`,
  ];
  if (result.readinessWarnings.length > 0) {
    lines.push('', 'readinessWarnings:');
    for (const w of result.readinessWarnings) lines.push(`  - ${w}`);
  }
  if (result.nextActions.length > 0) {
    lines.push('', 'nextActions:');
    for (const a of result.nextActions) lines.push(`  - ${a}`);
  }
  lines.push(
    '',
    'supportedSurfaces:',
    ...result.supportedSurfaces.map(surface => `  - ${surface}`),
    '',
    'warnings:',
    ...result.warnings.map(warning => `  - ${warning}`),
    '',
    result.localWorkflowNote,
  );
  return lines.join('\n');
}

function buildConduitExplain(env: Record<string, string | undefined> = process.env) {
  return {
    ...buildConduitStatus(env),
    schemaVersion: 'lattice.conduit_explain.v1' as const,
    explanation: [
      'Lattice CLI 0.3.5 replaces Mac App provider/config dashboard dependencies with CLI-first diagnostics.',
      'The conduit is a coordination surface for host capability reports, config migration checks, handoff packs, evidence freshness manifests, and parallel wave plans.',
      'It is intentionally not a model runner or receipt authority. Production completion remains false until an explicit receipt-backed authority path verifies a signed receipt.',
      'Authority modes: off = default local-only workflow (no network); shadow = observational POST when LATTICE_AUTHORITY_URL is reachable; enforce = isolated headless runner control plane (requires Lattice Authority server + actor key + runner identity; --live does not execute providers).',
    ],
  };
}

function renderConduitExplainText(result: ReturnType<typeof buildConduitExplain>): string {
  return [
    `${formatLatticeProductLine()} conduit explain (${result.schemaVersion})`,
    ...result.explanation,
    '',
    renderConduitStatusText({ ...result, schemaVersion: 'lattice.conduit_status.v1' }),
  ].join('\n');
}

export function createLatticeCliHandlers(ctx: HandlerContext) {
  return {
    host_list(args: FormatArgs = {}) {
      const result = buildLatticeHostList();
      return wantsJson(args) ? result : renderLatticeHostListText(result);
    },
    host_probe(args: { host: string; format?: LatticeFormat }) {
      const result = buildLatticeHostProbe(args.host);
      return wantsJson(args) ? result : renderLatticeHostProbeText(result);
    },
    host_status(args: { host: string; format?: LatticeFormat }) {
      const result = buildLatticeHostStatus(args.host);
      return wantsJson(args) ? result : renderLatticeHostStatusText(result);
    },
    host_install(args: { host: string; format?: LatticeFormat }) {
      const result = buildLatticeHostInstallGuidance(args.host);
      return wantsJson(args) ? result : renderLatticeHostInstallText(result);
    },
    lattice_config_doctor(args: FormatArgs = {}) {
      const result = buildConfigDoctor(ctx);
      return wantsJson(args) ? result : renderConfigDoctorText(result);
    },
    authority_status(args: { format?: LatticeFormat; json?: boolean; authorityMode?: string; authorityURL?: string; authorityTimeoutMS?: number } = {}) {
      const result = buildAuthorityStatus(args);
      return wantsJson(args) ? result : renderAuthorityStatusText(result);
    },
    async authority_enforce_runner(args: { format?: LatticeFormat; json?: boolean; once?: boolean; dryRun?: boolean; live?: boolean; authorityMode?: string; authorityURL?: string; authorityTimeoutMS?: number } = {}) {
      const result = await runAuthorityEnforceRunner(args);
      return wantsJson(args) ? result : renderAuthorityEnforceRunnerText(result);
    },
    authority_receipt_verify(args: {
      format?: LatticeFormat;
      json?: boolean;
      receiptFile?: string;
      serverPublicKey?: string;
      serverPublicKeyEncoding?: LatticeAuthorityKeyEncoding;
      receiptKind?: string;
      receiptProjectId?: string;
      receiptStoryId?: string;
      serverKeyId?: string;
      expectedDecisionDigest?: string;
      receiptMaxAgeMs?: number;
      receiptClockSkewMs?: number;
    } = {}) {
      const result = buildAuthorityReceiptVerify(args);
      return wantsJson(args) ? result : renderAuthorityReceiptVerifyText(result);
    },
    conduit_status(args: FormatArgs = {}) {
      const result = buildConduitStatus();
      return wantsJson(args) ? result : renderConduitStatusText(result);
    },
    conduit_explain(args: FormatArgs = {}) {
      const result = buildConduitExplain();
      return wantsJson(args) ? result : renderConduitExplainText(result);
    },
  };
}
