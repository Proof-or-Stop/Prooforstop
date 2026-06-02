import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { HandlerContext } from './context.js';
import { loadAuthoritySettings } from '../core/authority-mode.js';
import {
  LATTICE_CLI_VERSION,
  LATTICE_PRODUCT_NAME,
  formatLatticeProductLine,
} from '../core/lattice-brand.js';
import {
  buildLatticeHostInstallGuidance,
  buildLatticeHostList,
  buildLatticeHostProbe,
  renderLatticeHostInstallText,
  renderLatticeHostListText,
  renderLatticeHostProbeText,
  type LatticeFormat,
} from '../core/lattice-hosts.js';

type FormatArgs = { format?: LatticeFormat };

const AUTHORITY_DISCLAIMER =
  'Receipt-aware status only: no receipt is verified, no evidence is submitted, and productionDone remains false.';

function wantsJson(args: FormatArgs | undefined): boolean {
  return args?.format === 'json';
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

function buildAuthorityStatus(args: { authorityMode?: string; authorityURL?: string; authorityTimeoutMS?: number } = {}) {
  const settings = loadAuthoritySettings(process.env, args);
  const baseURLConfigured = typeof settings.baseURL === 'string' && settings.baseURL.length > 0;
  return {
    schemaVersion: 'lattice.authority_status.v1' as const,
    product: { name: LATTICE_PRODUCT_NAME, version: LATTICE_CLI_VERSION },
    authorityMode: settings.mode,
    baseURLConfigured,
    baseURL: settings.baseURL ?? null,
    timeoutMS: settings.timeoutMS,
    serverReachability: 'not-probed' as const,
    receiptVerified: false as const,
    productionDone: false as const,
    canClaimProductionDone: false as const,
    status: baseURLConfigured ? 'configured-no-verified-receipt' as const : 'not-configured' as const,
    note: AUTHORITY_DISCLAIMER,
  };
}

function renderAuthorityStatusText(result: ReturnType<typeof buildAuthorityStatus>): string {
  return [
    `${formatLatticeProductLine()} authority status (${result.schemaVersion})`,
    `status: ${result.status}`,
    `authorityMode: ${result.authorityMode}`,
    `baseURLConfigured: ${result.baseURLConfigured}`,
    `serverReachability: ${result.serverReachability}`,
    `receiptVerified: ${result.receiptVerified}`,
    `productionDone: ${result.productionDone}`,
    `canClaimProductionDone: ${result.canClaimProductionDone}`,
    '',
    result.note,
  ].join('\n');
}

function buildConduitStatus() {
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
    supportedSurfaces: [
      'host_list',
      'host_probe',
      'host_install',
      'lattice_config_doctor',
      'authority_status',
      'handoff_create',
      'handoff_accept',
      'handoff_resume',
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
  return [
    `${formatLatticeProductLine()} conduit status (${result.schemaVersion})`,
    `conduitAvailable: ${result.conduitAvailable}`,
    `conduitRole: ${result.conduitRole}`,
    `runnerProvisioned: ${result.runnerProvisioned}`,
    `modelRunnerCreated: ${result.modelRunnerCreated}`,
    `productionDone: ${result.productionDone}`,
    `receiptVerified: ${result.receiptVerified}`,
    `authorityChanged: ${result.authorityChanged}`,
    '',
    'supportedSurfaces:',
    ...result.supportedSurfaces.map(surface => `  - ${surface}`),
    '',
    'warnings:',
    ...result.warnings.map(warning => `  - ${warning}`),
  ].join('\n');
}

function buildConduitExplain() {
  return {
    ...buildConduitStatus(),
    schemaVersion: 'lattice.conduit_explain.v1' as const,
    explanation: [
      'Lattice CLI 0.3.5 replaces Mac App provider/config dashboard dependencies with CLI-first diagnostics.',
      'The conduit is a coordination surface for host capability reports, config migration checks, handoff packs, evidence freshness manifests, and parallel wave plans.',
      'It is intentionally not a model runner or receipt authority. Production completion remains false until an explicit receipt-backed authority path verifies a signed receipt.',
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
    host_install(args: { host: string; format?: LatticeFormat }) {
      const result = buildLatticeHostInstallGuidance(args.host);
      return wantsJson(args) ? result : renderLatticeHostInstallText(result);
    },
    lattice_config_doctor(args: FormatArgs = {}) {
      const result = buildConfigDoctor(ctx);
      return wantsJson(args) ? result : renderConfigDoctorText(result);
    },
    authority_status(args: { format?: LatticeFormat; authorityMode?: string; authorityURL?: string; authorityTimeoutMS?: number } = {}) {
      const result = buildAuthorityStatus(args);
      return wantsJson(args) ? result : renderAuthorityStatusText(result);
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

