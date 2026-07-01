/**
 * @task B-3b99
 * @checklist CHK-002
 * @title Project host capability authority impact as local assurance only
 * @type refactor
 * @priority high
 * @description
 *   Host status/list/probe output consumes the current AuthorityImpact
 *   degradation vocabulary as local assurance. It may show none,
 *   evidence-local-only, verification-evidence-limited, or
 *   local-assurance-required, but it cannot manufacture release readiness or
 *   verified receipt status from a host handoff. This maps legacy local-only
 *   and receipt-required language to local CLI assurance only.
 * @changes
 *   - [CHK-002] Desktop-app demotions expose local assurance limits without remote authority-service behavior.
 *   - [CHK-002] Host projections keep release readiness and receipt status as local diagnostic outputs.
 */
import {
  buildCapabilityList,
  buildCapabilityProbe,
  renderCapabilityListText,
  renderCapabilityProbeText,
  type AuthorityImpact,
  type CapabilityCategory,
  type CapabilityList,
  type CapabilityStatus,
  type DegradationSeverity,
  type CapabilityProbe,
  type HostProfile,
} from './capabilities.js';
import { LATTICE_CLI_VERSION, LATTICE_PRODUCT_NAME } from './lattice-brand.js';

export type LatticeFormat = 'text' | 'json';

export interface LatticeHostList {
  schemaVersion: 'lattice.host_list.v1';
  product: { name: typeof LATTICE_PRODUCT_NAME; version: typeof LATTICE_CLI_VERSION };
  migration: {
    cliFirst: true;
    macAppRequired: false;
    macAppRole: 'optional-dashboard-archive';
  };
  authority: CapabilityList['authorityRules'] & {
    productionDone: false;
    receiptVerified: false;
  };
  hosts: HostProfile[];
}

export interface LatticeHostProbe {
  schemaVersion: 'lattice.host_probe.v1';
  product: { name: typeof LATTICE_PRODUCT_NAME; version: typeof LATTICE_CLI_VERSION };
  productionDone: false;
  receiptVerified: false;
  probe: CapabilityProbe;
}

export interface LatticeHostStatus {
  schemaVersion: 'lattice.host_status.v1';
  product: { name: typeof LATTICE_PRODUCT_NAME; version: typeof LATTICE_CLI_VERSION };
  host: string;
  requestedHost: string;
  matchedFallback: boolean;
  status: 'ready' | 'degraded' | 'unavailable';
  overflowReady: boolean;
  nextAction: string;
  productionDone: false;
  receiptVerified: false;
  readiness: {
    edit: CapabilityStatus;
    shell: CapabilityStatus;
    test: CapabilityStatus;
    worktree: CapabilityStatus;
    review: CapabilityStatus;
    receipt: 'local-only' | 'receipt-bundle-capable';
  };
  limits: string[];
  warnings: string[];
  probe: CapabilityProbe;
}

export interface LatticeHostInstallGuidance {
  schemaVersion: 'lattice.host_install.v1';
  product: { name: typeof LATTICE_PRODUCT_NAME; version: typeof LATTICE_CLI_VERSION };
  host: string;
  dryRun: true;
  executed: false;
  thirdPartyInstallsExecuted: false;
  productionDone: false;
  receiptVerified: false;
  summary: string;
  suggestedSteps: string[];
  suggestedLocalCommands: string[];
  warnings: string[];
}

const PRODUCT = { name: LATTICE_PRODUCT_NAME, version: LATTICE_CLI_VERSION } as const;

const LATTICE_DESKTOP_APP_SUMMARY =
  'Optional dashboard/archive surface for displaying artifacts, collecting visible approval, and browsing historical handoff context; Proofbound CLI commands remain the editing, test, local-assurance, and receipt-bundle surfaces.';

type LatticeDesktopCapabilityDemotion = {
  status: Exclude<CapabilityStatus, 'available'>;
  note: string;
  authorityImpact: AuthorityImpact;
  reason: string;
  fallback: string;
  recovery?: string;
};

const LATTICE_DESKTOP_APP_DEMOTIONS: Partial<Record<CapabilityCategory, LatticeDesktopCapabilityDemotion>> = {
  'file-edit': {
    status: 'unavailable',
    note: 'Unavailable in Proofbound CLI 0.3.8; the desktop app is optional dashboard/archive only.',
    authorityImpact: 'none',
    reason: 'Proofbound CLI 0.3.8 does not treat the desktop app as a repository editing host.',
    fallback: 'Delegate file edits to Codex, Claude Code, Antigravity, or another explicit editing host.',
  },
  'patch-apply': {
    status: 'unavailable',
    note: 'Unavailable in Proofbound CLI 0.3.8; patches must be applied by a CLI/editor host.',
    authorityImpact: 'none',
    reason: 'The desktop app projection is dashboard/archive only and cannot apply patches.',
    fallback: 'Use a patch-capable CLI/editor host.',
  },
  'shell/pty': {
    status: 'unavailable',
    note: 'Unavailable in Proofbound CLI 0.3.8; shell access stays with CLI/editor/runner hosts.',
    authorityImpact: 'verification-evidence-limited',
    reason: 'The desktop app projection is not a local command or PTY surface.',
    fallback: 'Run commands through Codex, Claude Code, Antigravity, or local-runner.',
  },
  'test-execution': {
    status: 'unavailable',
    note: 'Unavailable in Proofbound CLI 0.3.8; tests must run through CLI/editor/runner hosts.',
    authorityImpact: 'verification-evidence-limited',
    reason: 'The desktop app projection is not a test execution surface.',
    fallback: 'Delegate build and test commands to local-runner or an editing host with shell access.',
  },
  'browser-automation': {
    status: 'unavailable',
    note: 'Unavailable in Proofbound CLI 0.3.8; browser checks require a browser-capable host.',
    authorityImpact: 'verification-evidence-limited',
    reason: 'The desktop app projection does not expose browser automation as a Proofbound host capability.',
    fallback: 'Use a browser host or record that browser automation is unavailable.',
  },
  'evidence-submit': {
    status: 'unavailable',
    note: 'Unavailable in Proofbound CLI 0.3.8; the desktop app is not a lifecycle evidence recording surface.',
    authorityImpact: 'evidence-local-only',
    reason: 'The desktop app projection cannot record local lifecycle evidence.',
    fallback: 'Keep evidence local until a Proofbound lifecycle command records it.',
  },
  'receipt-verify': {
    status: 'unavailable',
    note: 'Unavailable in Proofbound CLI 0.3.8; the desktop app cannot verify local receipt bundles.',
    authorityImpact: 'local-assurance-required',
    reason: 'The desktop app projection cannot verify signed/offline receipt bundles.',
    fallback: 'Use local verifier tooling plus review quorum before integration.',
  },
  'multimodal-research': {
    status: 'unavailable',
    note: 'Unavailable in Proofbound CLI 0.3.8; research and verification are delegated to explicit capable hosts.',
    authorityImpact: 'none',
    reason: 'The desktop app projection is limited to dashboard/archive display rather than research execution.',
    fallback: 'Delegate research to a multimodal-capable host.',
  },
};

function severityForAuthorityImpact(authorityImpact: AuthorityImpact): DegradationSeverity {
  if (authorityImpact === 'blocks-production-done' || authorityImpact === 'local-assurance-required') return 'block';
  if (authorityImpact === 'none') return 'info';
  return 'warn';
}

function buildLatticeDesktopDegradation(category: CapabilityCategory, demotion: LatticeDesktopCapabilityDemotion) {
  return {
    id: `desktop-app-${category}`
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase(),
    host: 'desktop-app',
    capability: category,
    severity: severityForAuthorityImpact(demotion.authorityImpact),
    visible: true as const,
    reason: demotion.reason,
    fallback: demotion.fallback,
    authorityImpact: demotion.authorityImpact,
    ...(demotion.recovery ? { recovery: demotion.recovery } : {}),
  };
}

function projectLatticeHostProfile(profile: HostProfile): HostProfile {
  if (profile.id !== 'desktop-app') return profile;

  return {
    ...profile,
    label: 'Desktop app (dashboard/archive)',
    summary: LATTICE_DESKTOP_APP_SUMMARY,
    capabilities: profile.capabilities.map(capability => {
      const demotion = LATTICE_DESKTOP_APP_DEMOTIONS[capability.category];
      if (!demotion) return capability;
      return {
        ...capability,
        status: demotion.status,
        note: demotion.note,
      };
    }),
    degradations: Object.entries(LATTICE_DESKTOP_APP_DEMOTIONS).map(([category, demotion]) =>
      buildLatticeDesktopDegradation(category as CapabilityCategory, demotion),
    ),
  };
}

function buildLatticeCapabilityList(): CapabilityList {
  const list = buildCapabilityList();
  return {
    ...list,
    hosts: list.hosts.map(projectLatticeHostProfile),
  };
}

function buildLatticeCapabilityProbe(host: string): CapabilityProbe {
  const probe = buildCapabilityProbe(host);
  const profile = projectLatticeHostProfile(probe.profile);
  return {
    ...probe,
    profile,
    degradations: profile.degradations,
  };
}

export function buildLatticeHostList(): LatticeHostList {
  const list = buildLatticeCapabilityList();
  return {
    schemaVersion: 'lattice.host_list.v1',
    product: PRODUCT,
    migration: {
      cliFirst: true,
      macAppRequired: false,
      macAppRole: 'optional-dashboard-archive',
    },
    authority: {
      ...list.authorityRules,
      productionDone: false,
      receiptVerified: false,
    },
    hosts: list.hosts,
  };
}

export function buildLatticeHostProbe(host: string): LatticeHostProbe {
  return {
    schemaVersion: 'lattice.host_probe.v1',
    product: PRODUCT,
    productionDone: false,
    receiptVerified: false,
    probe: buildLatticeCapabilityProbe(host),
  };
}

function capabilityStatus(profile: HostProfile, category: CapabilityCategory): CapabilityStatus {
  return profile.capabilities.find(capability => capability.category === category)?.status ?? 'unavailable';
}

function readinessWarningsForProbe(probe: CapabilityProbe): string[] {
  return probe.degradations.map((degradation) => {
    const recovery = degradation.recovery ? ` Recovery: ${degradation.recovery}` : '';
    return `${degradation.capability}: ${degradation.reason} Fallback: ${degradation.fallback}.${recovery}`.trim();
  });
}

function readinessLimitsForProbe(probe: CapabilityProbe): string[] {
  const limits = probe.degradations
    .filter((degradation) => degradation.authorityImpact !== 'none')
    .map((degradation) => `${degradation.capability}=${degradation.authorityImpact}`);
  return limits.length > 0
    ? limits
    : ['overflow execution remains local-only until proof admissibility, receipt-bundle verification, and review quorum are recorded'];
}

function nextActionForStatus(
  probe: CapabilityProbe,
  overflowReady: boolean,
  status: LatticeHostStatus['status'],
): string {
  if (!overflowReady) {
    if (probe.host === 'local-runner') {
      return 'Use local-runner only for delegated verification commands; choose an editing host with file-edit, shell/pty, test-execution, and approval support for overflow work.';
    }
    if (probe.host === 'browser') {
      return 'Use browser as a verification companion only; choose an editing host with file-edit, shell/pty, test-execution, and approval support for overflow work.';
    }
    if (probe.host === 'desktop-app') {
      return 'Keep the desktop app as an optional dashboard/archive surface; choose an editing host with file-edit, shell/pty, test-execution, and approval support for overflow execution.';
    }
    if (probe.host === 'server') {
      return 'Server Authority is retired/out-of-core for the active CLI; choose a local editing host for overflow execution.';
    }
    return 'Run lattice host list --format=json, then choose a host whose profile exposes file-edit, shell/pty, test-execution, and approval support.';
  }
  if (status === 'degraded') {
    return 'Manual-first overflow is possible, but inspect the visible limits before dispatching work and keep review/merge authority in Proofbound.';
  }
  return 'Manual-first overflow is ready: create a handoff pack, project an isolated overflow worktree, then review any receipt locally before merging.';
}

function worktreeStatusForHost(profile: HostProfile): CapabilityStatus {
  const shell = capabilityStatus(profile, 'shell/pty');
  return shell === 'available' ? 'available' : shell === 'conditional' ? 'conditional' : 'unavailable';
}

export function buildLatticeHostStatusFromProbe(probe: CapabilityProbe): LatticeHostStatus {
  const edit = capabilityStatus(probe.profile, 'file-edit');
  const shell = capabilityStatus(probe.profile, 'shell/pty');
  const test = capabilityStatus(probe.profile, 'test-execution');
  const worktree = worktreeStatusForHost(probe.profile);
  const review = capabilityStatus(probe.profile, 'approval');
  const receiptCapability = capabilityStatus(probe.profile, 'receipt-verify');
  const overflowReady =
    edit !== 'unavailable' &&
    shell !== 'unavailable' &&
    test !== 'unavailable' &&
    worktree !== 'unavailable' &&
    review !== 'unavailable' &&
    !probe.matchedFallback;
  let status: LatticeHostStatus['status'] = overflowReady ? 'ready' : 'unavailable';
  if (
    overflowReady &&
    (
      edit === 'conditional' ||
      shell === 'conditional' ||
      test === 'conditional' ||
      worktree === 'conditional' ||
      review === 'conditional'
    )
  ) {
    status = 'degraded';
  }
  return {
    schemaVersion: 'lattice.host_status.v1',
    product: PRODUCT,
    host: probe.host,
    requestedHost: probe.requestedHost,
    matchedFallback: probe.matchedFallback,
    status,
    overflowReady,
    nextAction: nextActionForStatus(probe, overflowReady, status),
    readiness: {
      edit,
      shell,
      test,
      worktree,
      review,
      receipt: receiptCapability === 'available' ? 'receipt-bundle-capable' : 'local-only',
    },
    limits: readinessLimitsForProbe(probe),
    warnings: readinessWarningsForProbe(probe),
    productionDone: false,
    receiptVerified: false,
    probe,
  };
}

export function buildLatticeHostStatus(host: string): LatticeHostStatus {
  return buildLatticeHostStatusFromProbe(buildLatticeCapabilityProbe(host));
}

function installStepsForHost(host: string): { summary: string; steps: string[]; commands: string[]; warnings: string[] } {
  const normalized = host.trim().toLowerCase();
  const commonWarnings = [
    'This command is dry-run guidance only; it does not run installers or modify third-party software.',
    'This guidance does not establish proof admissibility, receipt-bundle verification, review quorum, release readiness.',
  ];
  if (normalized === 'codex') {
    return {
      summary: 'Codex is an editing host. Use the Proofbound CLI inside the existing Codex workspace session.',
      steps: [
        'Build the repo-local Proofbound CLI before using worktree-local status or gate commands.',
        'Use lattice host probe --host=codex to inspect optional browser, evidence-submit, and receipt-bundle degradations.',
        'Keep assurance local: use proof admissibility, signed/offline receipt bundles, and local review quorum before integration.',
      ],
      commands: ['npm --prefix packages/main run build', 'node bin/lattice.js host_probe --host=codex --format=json'],
      warnings: commonWarnings,
    };
  }
  if (normalized === 'claude-code') {
    return {
      summary: 'Claude Code is an editing host. Install and authenticate it through its own vendor flow, then use Proofbound handoff surfaces.',
      steps: [
        'Confirm Claude Code is available in the user environment through its vendor documentation.',
        'Use lattice host probe --host=claude-code to inspect visible capability degradations.',
        'Use handoff_create / handoff_accept / handoff_resume for cross-host recovery without changing authority.',
      ],
      commands: ['node bin/lattice.js host_probe --host=claude-code --format=json'],
      warnings: commonWarnings,
    };
  }
  if (normalized === 'antigravity' || normalized === 'agy') {
    return {
      summary: 'Antigravity is an editing host exposed through the agy CLI. Install and authenticate it through its own vendor flow, then use Proofbound handoff/runtime surfaces.',
      steps: [
        'Confirm agy is available in the user environment through its vendor documentation.',
        'Use lattice host probe --host=antigravity to inspect visible capability degradations.',
        'Use lattice host_runtime_probe --host=antigravity --json to inspect the local agy runtime without starting the host.',
      ],
      commands: [
        'node bin/lattice.js host_probe --host=antigravity --format=json',
        'node bin/lattice.js host_runtime_probe --host=antigravity --json',
      ],
      warnings: commonWarnings,
    };
  }
  if (normalized === 'local-runner') {
    return {
      summary: 'Local runner executes deterministic commands and tests, but does not author edits or receipts.',
      steps: [
        'Ensure Node.js and project-native test dependencies are installed by the operator.',
        'Run project build and smoke commands from the local runner when the editing host delegates verification.',
        'Run local receipt-bundle verification only through Proofbound local verifier tooling; do not submit Authority receipts.',
      ],
      commands: ['npm --prefix packages/main run build', 'npm run test:legacy -- lattice-cli-migration'],
      warnings: commonWarnings,
    };
  }
  if (normalized === 'browser') {
    return {
      summary: 'Browser is a visual verification host, not a repository editor or receipt verifier.',
      steps: [
        'Use a browser-capable connector or host to inspect pages and capture visual evidence.',
        'Pair browser evidence with an editing or runner host for shell/test execution.',
        'Keep screenshots as local evidence refs for manual review and lifecycle evidence recording.',
      ],
      commands: ['node bin/lattice.js host_probe --host=browser --format=json'],
      warnings: commonWarnings,
    };
  }
  if (normalized === 'server') {
    return {
      summary: 'Server Authority is retired/out-of-core for the active Proofbound CLI. It is not a workspace editing host.',
      steps: [
        'Use local proof admissibility, signed/offline receipt bundles, and local review quorum for active CLI assurance.',
        'Treat old server-backed authority materials as legacy reference only.',
        'Do not treat server reachability or transport acceptance as local proof admissibility.',
      ],
      commands: ['node bin/lattice.js conduit_status --format=json'],
      warnings: commonWarnings,
    };
  }
  if (normalized === 'desktop-app') {
    return {
      summary: 'The Mac App is optional dashboard/archive surface only for this migration.',
      steps: [
        'Use Proofbound CLI commands for host/config/local-assurance/conduit diagnostics.',
        'Keep any Mac App usage as an optional dashboard or archived surface.',
        'Do not route release readiness claims through the Mac App.',
      ],
      commands: ['node bin/lattice.js lattice_config_doctor --format=json'],
      warnings: commonWarnings,
    };
  }
  return {
    summary: 'Unknown host. Use conservative fallback guidance and require an explicit host profile before relying on capabilities.',
    steps: [
      'Run host_list to see supported profiles.',
      'Run host_probe with the requested host to inspect fallback degradations.',
      'Delegate edits, tests, local evidence recording, and receipt-bundle checks to known capable hosts.',
    ],
    commands: ['node bin/lattice.js host_list --format=json'],
    warnings: commonWarnings,
  };
}

export function buildLatticeHostInstallGuidance(host: string): LatticeHostInstallGuidance {
  const guidance = installStepsForHost(host);
  return {
    schemaVersion: 'lattice.host_install.v1',
    product: PRODUCT,
    host,
    dryRun: true,
    executed: false,
    thirdPartyInstallsExecuted: false,
    productionDone: false,
    receiptVerified: false,
    summary: guidance.summary,
    suggestedSteps: guidance.steps,
    suggestedLocalCommands: guidance.commands,
    warnings: guidance.warnings,
  };
}

export function renderLatticeHostListText(list: LatticeHostList): string {
  return [
    `${LATTICE_PRODUCT_NAME} ${LATTICE_CLI_VERSION} host list (${list.schemaVersion})`,
    `migration: cliFirst=${list.migration.cliFirst}; macAppRequired=${list.migration.macAppRequired}; macAppRole=${list.migration.macAppRole}`,
    `localAssurance: admissibilityStatus=local-only; receiptBundleVerified=${list.authority.receiptVerified}; proofAdmissibility=${list.authority.proofAdmissibility}; receiptBundleVerification=${list.authority.receiptBundleVerification}; reviewQuorum=${list.authority.reviewQuorum}`,
    '',
    renderCapabilityListText({ ...buildLatticeCapabilityList(), hosts: list.hosts }),
  ].join('\n');
}

export function renderLatticeHostProbeText(probe: LatticeHostProbe): string {
  return [
    `${LATTICE_PRODUCT_NAME} ${LATTICE_CLI_VERSION} host probe (${probe.schemaVersion})`,
    `admissibilityStatus=local-only; receiptBundleVerified=${probe.receiptVerified}`,
    '',
    renderCapabilityProbeText(probe.probe),
  ].join('\n');
}

export function renderLatticeHostStatusText(status: LatticeHostStatus): string {
  const lines = [
    `${LATTICE_PRODUCT_NAME} ${LATTICE_CLI_VERSION} host status (${status.schemaVersion})`,
    `host: ${status.host}`,
    `requestedHost: ${status.requestedHost}`,
    `status: ${status.status}`,
    `overflowReady: ${status.overflowReady}`,
    `matchedFallback: ${status.matchedFallback}`,
    `admissibilityStatus: local-host-status`,
    `receiptBundleVerified: ${status.receiptVerified}`,
    `nextAction: ${status.nextAction}`,
    '',
    'readiness:',
    `  edit: ${status.readiness.edit}`,
    `  shell: ${status.readiness.shell}`,
    `  test: ${status.readiness.test}`,
    `  worktree: ${status.readiness.worktree}`,
    `  review: ${status.readiness.review}`,
    `  receipt: ${status.readiness.receipt}`,
  ];
  if (status.limits.length > 0) {
    lines.push('', 'limits:');
    lines.push(...status.limits.map((limit) => `  - ${limit}`));
  }
  if (status.warnings.length > 0) {
    lines.push('', 'warnings:');
    lines.push(...status.warnings.map((warning) => `  - ${warning}`));
  }
  return lines.join('\n');
}

export function renderLatticeHostInstallText(guidance: LatticeHostInstallGuidance): string {
  const lines = [
    `${LATTICE_PRODUCT_NAME} ${LATTICE_CLI_VERSION} host install guidance (${guidance.schemaVersion})`,
    `host: ${guidance.host}`,
    `dryRun: ${guidance.dryRun}`,
    `executed: ${guidance.executed}`,
    `thirdPartyInstallsExecuted: ${guidance.thirdPartyInstallsExecuted}`,
    `admissibilityStatus: host-install-guidance`,
    `receiptBundleVerified: ${guidance.receiptVerified}`,
    '',
    guidance.summary,
    '',
    'Suggested steps:',
    ...guidance.suggestedSteps.map(step => `  - ${step}`),
  ];
  if (guidance.suggestedLocalCommands.length > 0) {
    lines.push('', 'Suggested local commands (not executed):');
    lines.push(...guidance.suggestedLocalCommands.map(command => `  - ${command}`));
  }
  if (guidance.warnings.length > 0) {
    lines.push('', 'Warnings:');
    lines.push(...guidance.warnings.map(warning => `  - ${warning}`));
  }
  return lines.join('\n');
}
