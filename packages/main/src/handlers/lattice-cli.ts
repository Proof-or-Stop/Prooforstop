import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { HandlerContext } from './context.js';
import { loadAuthoritySettings, type AuthoritySettings } from '../core/authority-mode.js';
import {
  AUTHORITY_RUNNER_PLANNED_STEPS,
  type AuthorityRunnerPlan,
} from '../core/authority-runner.js';
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
  const present = (key: string): boolean => {
    const raw = env[key];
    return typeof raw === 'string' && raw.trim().length > 0;
  };
  return {
    actorKeyConfigured:
      present('KOALA_AUTHORITY_ACTOR_KEY') || present('KOALA_AUTHORITY_ACTOR_KEY_PATH'),
    runnerConfigured: present('KOALA_AUTHORITY_RUNNER_ID'),
    sessionConfigured: present('KOALA_AUTHORITY_SESSION_ID'),
  };
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
        'shadow mode set but KOALA_AUTHORITY_URL is empty; observational POSTs will be skipped',
      );
      actions.push('export KOALA_AUTHORITY_URL=https://<authority-host>');
    }
  } else if (settings.mode === 'enforce') {
    if (!authorityUrlConfigured) {
      warnings.push(
        'enforce mode set but KOALA_AUTHORITY_URL is empty; runner / policy discovery cannot reach the Python authority',
      );
      actions.push('export KOALA_AUTHORITY_URL=https://<authority-host>');
    }
    if (!enforce.actorKeyConfigured) {
      warnings.push(
        'enforce mode set but no KOALA_AUTHORITY_ACTOR_KEY / KOALA_AUTHORITY_ACTOR_KEY_PATH detected; future runner submissions would be unsigned and rejected',
      );
      actions.push(
        'configure an actor key via KOALA_AUTHORITY_ACTOR_KEY_PATH=<path> (CLI does not sign or submit envelopes yet)',
      );
    }
    if (!enforce.runnerConfigured) {
      warnings.push(
        'enforce mode set but KOALA_AUTHORITY_RUNNER_ID is empty; runner identity binding would be missing',
      );
      actions.push('export KOALA_AUTHORITY_RUNNER_ID=<runner-id>');
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
  args: { once?: boolean; dryRun?: boolean; authorityMode?: string; authorityURL?: string; authorityTimeoutMS?: number } = {},
  env: Record<string, string | undefined> = process.env,
): AuthorityRunnerPlan {
  const settings = loadAuthoritySettings(env, { ...args, authorityMode: args.authorityMode ?? 'enforce' });
  const readiness = buildAuthorityReadiness({ ...settings, mode: 'enforce' }, env);
  const missing = readiness.readinessWarnings;
  return {
    schemaVersion: 'lattice.authority_enforce_runner.v1',
    mode: 'enforce',
    once: args.once !== false,
    dryRun: args.dryRun === true,
    plannedSteps: [...AUTHORITY_RUNNER_PLANNED_STEPS],
    spawned: false,
    providerEvents: [],
    localWorkflowUsable: true,
    status: missing.length === 0 ? 'pass' : 'fail',
    readinessWarnings: missing,
    nextActions: readiness.nextActions,
    note: args.dryRun === true
      ? 'Dry-run only: planned runner register/heartbeat/claim steps; no network mutation and no provider execution.'
      : 'Runner execution is limited to controlled fake-provider smoke helpers in this milestone.',
  };
}

function renderAuthorityEnforceRunnerText(result: AuthorityRunnerPlan): string {
  const lines = [
    `${formatLatticeProductLine()} authority enforce runner (${result.schemaVersion})`,
    `status: ${result.status}`,
    `mode: ${result.mode}`,
    `once: ${result.once}`,
    `dryRun: ${result.dryRun}`,
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
  lines.push('', result.note);
  return lines.join('\n');
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
      'Authority modes: off = default local-only workflow (no network); shadow = observational POST when KOALA_AUTHORITY_URL is reachable; enforce = future isolated headless runner path (requires Python authority server + actor key + runner identity; not implemented).',
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
    authority_enforce_runner(args: { format?: LatticeFormat; json?: boolean; once?: boolean; dryRun?: boolean; authorityMode?: string; authorityURL?: string; authorityTimeoutMS?: number } = {}) {
      const result = buildAuthorityEnforceRunnerPlan(args);
      return wantsJson(args) ? result : renderAuthorityEnforceRunnerText(result);
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
