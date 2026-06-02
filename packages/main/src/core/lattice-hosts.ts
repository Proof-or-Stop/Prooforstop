import {
  buildCapabilityList,
  buildCapabilityProbe,
  renderCapabilityListText,
  renderCapabilityProbeText,
  type CapabilityList,
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

export function buildLatticeHostList(): LatticeHostList {
  const list = buildCapabilityList();
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
    probe: buildCapabilityProbe(host),
  };
}

function installStepsForHost(host: string): { summary: string; steps: string[]; commands: string[]; warnings: string[] } {
  const normalized = host.trim().toLowerCase();
  const commonWarnings = [
    'This command is dry-run guidance only; it does not run installers or modify third-party software.',
    'Production completion still requires a verified authority receipt; this guidance never verifies one.',
  ];
  if (normalized === 'codex') {
    return {
      summary: 'Codex is an editing host. Use the Lattice CLI inside the existing Codex workspace session.',
      steps: [
        'Build the repo-local Lattice CLI before using worktree-local status or gate commands.',
        'Use lattice host probe --host=codex to inspect optional browser, evidence-submit, and receipt-verify degradations.',
        'Keep authority evidence local unless an explicit authority URL and receipt verifier are configured.',
      ],
      commands: ['npm --prefix packages/main run build', 'node bin/lattice.js host_probe --host=codex --format=json'],
      warnings: commonWarnings,
    };
  }
  if (normalized === 'claude-code') {
    return {
      summary: 'Claude Code is an editing host. Install and authenticate it through its own vendor flow, then use Lattice handoff surfaces.',
      steps: [
        'Confirm Claude Code is available in the user environment through its vendor documentation.',
        'Use lattice host probe --host=claude-code to inspect visible capability degradations.',
        'Use handoff_create / handoff_accept / handoff_resume for cross-host recovery without changing authority.',
      ],
      commands: ['node bin/lattice.js host_probe --host=claude-code --format=json'],
      warnings: commonWarnings,
    };
  }
  if (normalized === 'local-runner') {
    return {
      summary: 'Local runner executes deterministic commands and tests, but does not author edits or receipts.',
      steps: [
        'Ensure Node.js and project-native test dependencies are installed by the operator.',
        'Run project build and smoke commands from the local runner when the editing host delegates verification.',
        'Submit or verify authority receipts only through an explicitly configured authority-capable path.',
      ],
      commands: ['npm --prefix packages/main run build', 'npm --prefix packages/main run test:lattice-cli-migration-smoke'],
      warnings: commonWarnings,
    };
  }
  if (normalized === 'browser') {
    return {
      summary: 'Browser is a visual verification host, not a repository editor or receipt verifier.',
      steps: [
        'Use a browser-capable connector or host to inspect pages and capture visual evidence.',
        'Pair browser evidence with an editing or runner host for shell/test execution.',
        'Keep screenshots as evidence refs until an authority-capable client submits and verifies receipts.',
      ],
      commands: ['node bin/lattice.js host_probe --host=browser --format=json'],
      warnings: commonWarnings,
    };
  }
  if (normalized === 'server') {
    return {
      summary: 'Server is the authority/orchestration profile. It is not a workspace editing host.',
      steps: [
        'Configure the external authority server outside this CLI migration.',
        'Use lattice authority status to confirm the CLI sees local authority settings.',
        'Do not treat server reachability or transport acceptance as receipt verification.',
      ],
      commands: ['node bin/lattice.js authority_status --format=json'],
      warnings: commonWarnings,
    };
  }
  if (normalized === 'desktop-app') {
    return {
      summary: 'The Mac App is optional dashboard/archive surface only for this migration.',
      steps: [
        'Use Lattice CLI commands for host/config/authority/conduit diagnostics.',
        'Keep any Mac App usage as an optional dashboard or archived surface.',
        'Do not route production authority claims through the Mac App unless a future receipt-backed runner path is implemented.',
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
      'Delegate edits, tests, and receipts to known capable hosts.',
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
    `authority: productionDone=${list.authority.productionDone}; receiptVerified=${list.authority.receiptVerified}; productionDoneRequiresReceipt=${list.authority.productionDoneRequiresReceipt}`,
    '',
    renderCapabilityListText({ ...buildCapabilityList(), hosts: list.hosts }),
  ].join('\n');
}

export function renderLatticeHostProbeText(probe: LatticeHostProbe): string {
  return [
    `${LATTICE_PRODUCT_NAME} ${LATTICE_CLI_VERSION} host probe (${probe.schemaVersion})`,
    `productionDone=${probe.productionDone}; receiptVerified=${probe.receiptVerified}`,
    '',
    renderCapabilityProbeText(probe.probe),
  ].join('\n');
}

export function renderLatticeHostInstallText(guidance: LatticeHostInstallGuidance): string {
  const lines = [
    `${LATTICE_PRODUCT_NAME} ${LATTICE_CLI_VERSION} host install guidance (${guidance.schemaVersion})`,
    `host: ${guidance.host}`,
    `dryRun: ${guidance.dryRun}`,
    `executed: ${guidance.executed}`,
    `thirdPartyInstallsExecuted: ${guidance.thirdPartyInstallsExecuted}`,
    `productionDone: ${guidance.productionDone}`,
    `receiptVerified: ${guidance.receiptVerified}`,
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

