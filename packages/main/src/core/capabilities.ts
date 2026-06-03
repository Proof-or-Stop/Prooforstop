export const CAPABILITY_SCHEMA_VERSION = 'koala.capability_list.v1' as const;

export const CAPABILITY_CATEGORIES = [
  'file-edit',
  'patch-apply',
  'shell/pty',
  'test-execution',
  'browser-automation',
  'approval',
  'artifact-display',
  'evidence-submit',
  'receipt-verify',
  'multimodal-research',
] as const;

export type CapabilityCategory = typeof CAPABILITY_CATEGORIES[number];
export type CapabilityStatus = 'available' | 'conditional' | 'unavailable';
export type AuthorityImpact =
  | 'none'
  | 'evidence-local-only'
  | 'verification-evidence-limited'
  | 'blocks-production-done';
export type DegradationSeverity = 'info' | 'warn' | 'block';

export interface CapabilityDescription {
  id: CapabilityCategory;
  label: string;
  optional: boolean;
  description: string;
}

export interface HostCapability {
  category: CapabilityCategory;
  status: CapabilityStatus;
  optional: boolean;
  note: string;
}

export interface CapabilityDegradation {
  id: string;
  host: string;
  capability: CapabilityCategory;
  severity: DegradationSeverity;
  visible: true;
  reason: string;
  fallback: string;
  authorityImpact: AuthorityImpact;
  recovery?: string;
}

export interface HostProfile {
  id: string;
  label: string;
  summary: string;
  capabilities: HostCapability[];
  degradations: CapabilityDegradation[];
}

export interface CapabilityList {
  schemaVersion: typeof CAPABILITY_SCHEMA_VERSION;
  categories: CapabilityDescription[];
  authorityRules: {
    productionDoneRequiresReceipt: true;
    receiptCapability: 'receipt-verify';
    handoffCanManufactureProductionDone: false;
  };
  hosts: HostProfile[];
}

export interface CapabilityProbe {
  schemaVersion: 'koala.capability_probe.v1';
  host: string;
  requestedHost: string;
  matchedFallback: boolean;
  diagnosticOnly: true;
  authorityRules: CapabilityList['authorityRules'];
  profile: HostProfile;
  degradations: CapabilityDegradation[];
}

const CATEGORY_DESCRIPTIONS: Record<CapabilityCategory, CapabilityDescription> = {
  'file-edit': {
    id: 'file-edit',
    label: 'File edit',
    optional: false,
    description: 'Modify project files through the host runtime.',
  },
  'patch-apply': {
    id: 'patch-apply',
    label: 'Patch apply',
    optional: true,
    description: 'Apply explicit unified patches or equivalent targeted edits.',
  },
  'shell/pty': {
    id: 'shell/pty',
    label: 'Shell / PTY',
    optional: true,
    description: 'Run shell commands, including interactive PTY-backed commands.',
  },
  'test-execution': {
    id: 'test-execution',
    label: 'Test execution',
    optional: true,
    description: 'Run project-native tests or validation commands.',
  },
  'browser-automation': {
    id: 'browser-automation',
    label: 'Browser automation',
    optional: true,
    description: 'Drive a browser, inspect pages, click, type, and capture screenshots.',
  },
  approval: {
    id: 'approval',
    label: 'Approval',
    optional: true,
    description: 'Request and honor human approval for gated or risky actions.',
  },
  'artifact-display': {
    id: 'artifact-display',
    label: 'Artifact display',
    optional: true,
    description: 'Show generated artifacts such as images, screenshots, documents, or links.',
  },
  'evidence-submit': {
    id: 'evidence-submit',
    label: 'Evidence submit',
    optional: true,
    description: 'Submit signed evidence to an external authority service.',
  },
  'receipt-verify': {
    id: 'receipt-verify',
    label: 'Receipt verify',
    optional: true,
    description: 'Verify an authority receipt before promoting production completion.',
  },
  'multimodal-research': {
    id: 'multimodal-research',
    label: 'Multimodal research',
    optional: true,
    description: 'Use web, image, document, or other multimodal research inputs.',
  },
};

type HostCapabilityInput = Omit<HostCapability, 'optional'>;
type DegradationInput = Omit<CapabilityDegradation, 'id' | 'host' | 'visible'>;

interface HostProfileInput {
  id: string;
  label: string;
  summary: string;
  capabilities: HostCapabilityInput[];
  degradations: DegradationInput[];
}

function capability(
  category: CapabilityCategory,
  status: CapabilityStatus,
  note: string,
): HostCapabilityInput {
  return { category, status, note };
}

function degradation(
  capability: CapabilityCategory,
  _status: Exclude<CapabilityStatus, 'available'>,
  authorityImpact: AuthorityImpact,
  reason: string,
  fallback: string,
  recovery?: string,
): DegradationInput {
  return {
    capability,
    severity: severityForAuthorityImpact(authorityImpact),
    authorityImpact,
    reason,
    fallback,
    ...(recovery ? { recovery } : {}),
  };
}

function severityForAuthorityImpact(authorityImpact: AuthorityImpact): DegradationSeverity {
  if (authorityImpact === 'blocks-production-done') return 'block';
  if (authorityImpact === 'none') return 'info';
  return 'warn';
}

function degradationId(hostId: string, capability: CapabilityCategory): string {
  return `${hostId}-${capability}`
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

const HOST_PROFILE_INPUTS: HostProfileInput[] = [
  {
    id: 'codex',
    label: 'Codex',
    summary: 'Interactive coding host with file edits, patch application, shell tools, and optional browser or multimodal tools depending on installed connectors.',
    capabilities: [
      capability('file-edit', 'available', 'Can edit files in the shared workspace.'),
      capability('patch-apply', 'available', 'Can apply targeted patches.'),
      capability('shell/pty', 'available', 'Can run shell and PTY commands when enabled by the session.'),
      capability('test-execution', 'available', 'Can run project build and test commands.'),
      capability('browser-automation', 'conditional', 'Available when a Browser connector or equivalent automation host is installed.'),
      capability('approval', 'available', 'Can represent approval policy and ask for user input when the host allows it.'),
      capability('artifact-display', 'available', 'Can display links and local visual artifacts in capable desktop contexts.'),
      capability('evidence-submit', 'conditional', 'Requires a configured authority URL and submit-capable client path.'),
      capability('receipt-verify', 'conditional', 'Requires an authority receipt verifier path.'),
      capability('multimodal-research', 'available', 'Can combine local files, web research, and visual inputs when tools are present.'),
    ],
    degradations: [
      degradation('browser-automation', 'conditional', 'verification-evidence-limited', 'Browser automation may be absent from a Codex session.', 'Mark browser verification unavailable or delegate to a browser-capable host.'),
      degradation('evidence-submit', 'conditional', 'evidence-local-only', 'Authority submission depends on external authority configuration.', 'Keep evidence local and do not claim authority-backed completion.'),
      degradation('receipt-verify', 'conditional', 'blocks-production-done', 'Receipt verification depends on an authority verifier.', 'Require a verified receipt before productionDone can be claimed.'),
    ],
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    summary: 'Agentic coding host with shell-oriented project work and optional browser or authority integrations.',
    capabilities: [
      capability('file-edit', 'available', 'Can edit files in the shared workspace.'),
      capability('patch-apply', 'conditional', 'May apply patches through host editing tools or shell commands.'),
      capability('shell/pty', 'available', 'Can run shell commands in project context.'),
      capability('test-execution', 'available', 'Can run project-native test commands.'),
      capability('browser-automation', 'conditional', 'Requires browser tooling configured for the host.'),
      capability('approval', 'available', 'Can operate under explicit approval policy.'),
      capability('artifact-display', 'conditional', 'Artifact display depends on the surrounding UI.'),
      capability('evidence-submit', 'conditional', 'Requires authority client configuration.'),
      capability('receipt-verify', 'conditional', 'Requires authority receipt verifier support.'),
      capability('multimodal-research', 'conditional', 'Depends on enabled tools and model inputs.'),
    ],
    degradations: [
      degradation('patch-apply', 'conditional', 'none', 'Patch-specific tooling may not be exposed directly.', 'Use normal file-edit operations with clear diffs.'),
      degradation('browser-automation', 'conditional', 'verification-evidence-limited', 'Browser tooling may be absent.', 'Delegate browser checks or record a visible browser-test limitation.'),
      degradation('artifact-display', 'conditional', 'none', 'Artifact display depends on the client surface.', 'Return artifact paths or URLs.'),
      degradation('evidence-submit', 'conditional', 'evidence-local-only', 'Authority submission is not intrinsic to the host.', 'Keep local evidence and require a submit-capable authority client.'),
      degradation('receipt-verify', 'conditional', 'blocks-production-done', 'Receipt verification is not intrinsic to the host.', 'Require a verified receipt before productionDone can be claimed.'),
      degradation('multimodal-research', 'conditional', 'none', 'Multimodal research depends on enabled tools.', 'Use text-only research or delegate to a multimodal host.'),
    ],
  },
  {
    id: 'gemini',
    label: 'Gemini',
    summary: 'Agentic coding and research host with CLI-driven project work and optional browser or authority integrations.',
    capabilities: [
      capability('file-edit', 'available', 'Can edit files in the shared workspace.'),
      capability('patch-apply', 'conditional', 'May apply patches through host editing tools or shell commands.'),
      capability('shell/pty', 'available', 'Can run shell commands in project context.'),
      capability('test-execution', 'available', 'Can run project-native test commands.'),
      capability('browser-automation', 'conditional', 'Requires browser tooling configured for the host.'),
      capability('approval', 'available', 'Can operate under explicit approval policy.'),
      capability('artifact-display', 'conditional', 'Artifact display depends on the surrounding UI.'),
      capability('evidence-submit', 'conditional', 'Requires authority client configuration.'),
      capability('receipt-verify', 'conditional', 'Requires authority receipt verifier support.'),
      capability('multimodal-research', 'conditional', 'Depends on enabled tools and model inputs.'),
    ],
    degradations: [
      degradation('patch-apply', 'conditional', 'none', 'Patch-specific tooling may not be exposed directly.', 'Use normal file-edit operations with clear diffs.'),
      degradation('browser-automation', 'conditional', 'verification-evidence-limited', 'Browser tooling may be absent.', 'Delegate browser checks or record a visible browser-test limitation.'),
      degradation('artifact-display', 'conditional', 'none', 'Artifact display depends on the client surface.', 'Return artifact paths or URLs.'),
      degradation('evidence-submit', 'conditional', 'evidence-local-only', 'Authority submission is not intrinsic to the host.', 'Keep local evidence and require a submit-capable authority client.'),
      degradation('receipt-verify', 'conditional', 'blocks-production-done', 'Receipt verification is not intrinsic to the host.', 'Require a verified receipt before productionDone can be claimed.'),
      degradation('multimodal-research', 'conditional', 'none', 'Multimodal research depends on enabled tools.', 'Use text-only research or delegate to a multimodal host.'),
    ],
  },
  {
    id: 'local-runner',
    label: 'Local runner',
    summary: 'Non-agent execution host for deterministic commands and tests; it can produce local evidence but not invent edits or authority receipts.',
    capabilities: [
      capability('file-edit', 'unavailable', 'Runner executes commands; it does not author file edits.'),
      capability('patch-apply', 'unavailable', 'Patch application must be performed by an editing host.'),
      capability('shell/pty', 'available', 'Can execute local commands.'),
      capability('test-execution', 'available', 'Primary role is running tests and validation commands.'),
      capability('browser-automation', 'conditional', 'Available only when browser executor dependencies are configured.'),
      capability('approval', 'unavailable', 'Runner cannot ask for human approval by itself.'),
      capability('artifact-display', 'unavailable', 'Runner can write artifacts but cannot display them.'),
      capability('evidence-submit', 'conditional', 'Can submit only when configured with authority client credentials.'),
      capability('receipt-verify', 'conditional', 'Can verify only when configured with receipt verifier support.'),
      capability('multimodal-research', 'unavailable', 'Runner has no research model or browsing intelligence.'),
    ],
    degradations: [
      degradation('file-edit', 'unavailable', 'none', 'A local runner is execution-only.', 'Delegate edits to a file-edit capable host.'),
      degradation('patch-apply', 'unavailable', 'none', 'A local runner is execution-only.', 'Delegate patch application to an editing host.'),
      degradation('browser-automation', 'conditional', 'verification-evidence-limited', 'Browser dependencies may be missing.', 'Run non-browser tests or delegate browser checks.'),
      degradation('approval', 'unavailable', 'none', 'A local runner cannot prompt humans.', 'Have the orchestrating host collect approval before invoking it.'),
      degradation('artifact-display', 'unavailable', 'none', 'A local runner has no display surface.', 'Persist artifact paths for a display-capable host.'),
      degradation('evidence-submit', 'conditional', 'evidence-local-only', 'Authority submission requires external configuration.', 'Record local evidence and submit through an authority-capable host.'),
      degradation('receipt-verify', 'conditional', 'blocks-production-done', 'Receipt verification requires external configuration.', 'Require receipt verification elsewhere before productionDone.'),
      degradation('multimodal-research', 'unavailable', 'none', 'A local runner cannot conduct multimodal research.', 'Delegate research to a host with browser or multimodal inputs.'),
    ],
  },
  {
    id: 'browser',
    label: 'Browser',
    summary: 'Browser automation surface for web inspection and screenshots; it is not a repository editing or authority host.',
    capabilities: [
      capability('file-edit', 'unavailable', 'Browser cannot edit repository files.'),
      capability('patch-apply', 'unavailable', 'Browser cannot apply code patches.'),
      capability('shell/pty', 'unavailable', 'Browser cannot run local shell commands.'),
      capability('test-execution', 'conditional', 'Can exercise browser flows but cannot run arbitrary project tests.'),
      capability('browser-automation', 'available', 'Primary role is page automation and screenshots.'),
      capability('approval', 'unavailable', 'Browser cannot independently collect approval.'),
      capability('artifact-display', 'available', 'Can render pages and visual artifacts.'),
      capability('evidence-submit', 'unavailable', 'Browser does not submit authority evidence.'),
      capability('receipt-verify', 'unavailable', 'Browser does not verify authority receipts.'),
      capability('multimodal-research', 'available', 'Can inspect visual web state.'),
    ],
    degradations: [
      degradation('file-edit', 'unavailable', 'none', 'Browser is not a file-editing host.', 'Return findings to an editing host.'),
      degradation('patch-apply', 'unavailable', 'none', 'Browser is not a patch host.', 'Return findings to a patch-capable host.'),
      degradation('shell/pty', 'unavailable', 'verification-evidence-limited', 'Browser cannot run local commands.', 'Pair with a shell-capable host for tests.'),
      degradation('test-execution', 'conditional', 'verification-evidence-limited', 'Browser checks are not full project test execution.', 'Record browser evidence and run project tests elsewhere.'),
      degradation('approval', 'unavailable', 'none', 'Browser cannot collect orchestration approval.', 'Collect approval in the orchestrating host.'),
      degradation('evidence-submit', 'unavailable', 'evidence-local-only', 'Browser evidence is local until submitted by another host.', 'Export screenshot or trace evidence for authority submission.'),
      degradation('receipt-verify', 'unavailable', 'blocks-production-done', 'Browser cannot verify receipts.', 'Require receipt verification by an authority-capable host.'),
    ],
  },
  {
    id: 'server',
    label: 'Server',
    summary: 'Authority or orchestration server profile focused on evidence intake and receipt verification, not direct repository manipulation.',
    capabilities: [
      capability('file-edit', 'unavailable', 'Server should not directly edit client workspaces.'),
      capability('patch-apply', 'unavailable', 'Server should not apply workspace patches.'),
      capability('shell/pty', 'unavailable', 'Server profile does not expose project shell access.'),
      capability('test-execution', 'conditional', 'May schedule runner jobs but does not execute arbitrary local tests by itself.'),
      capability('browser-automation', 'unavailable', 'Server does not drive browsers directly.'),
      capability('approval', 'conditional', 'May enforce approval records but not collect interactive approval by itself.'),
      capability('artifact-display', 'conditional', 'May expose artifact URLs or metadata.'),
      capability('evidence-submit', 'available', 'Receives and validates evidence submissions.'),
      capability('receipt-verify', 'available', 'Verifies authority receipts and completion claims.'),
      capability('multimodal-research', 'unavailable', 'Server is not a research host.'),
    ],
    degradations: [
      degradation('file-edit', 'unavailable', 'none', 'Server is not a workspace authoring host.', 'Delegate edits to an editing host.'),
      degradation('patch-apply', 'unavailable', 'none', 'Server is not a patch host.', 'Delegate patch application.'),
      degradation('shell/pty', 'unavailable', 'verification-evidence-limited', 'Server does not run local project shells.', 'Use registered runners for commands.'),
      degradation('test-execution', 'conditional', 'verification-evidence-limited', 'Server may coordinate tests but not execute all local tests.', 'Delegate execution to local-runner.'),
      degradation('browser-automation', 'unavailable', 'verification-evidence-limited', 'Server does not drive browsers directly.', 'Delegate browser checks.'),
      degradation('approval', 'conditional', 'none', 'Approval enforcement may depend on external policy data.', 'Require recorded approval from an approval-capable host.'),
      degradation('artifact-display', 'conditional', 'none', 'Server may only expose artifact references.', 'Open artifacts in a display-capable host.'),
      degradation('multimodal-research', 'unavailable', 'none', 'Server does not conduct research.', 'Delegate research.'),
    ],
  },
  {
    id: 'desktop-app',
    label: 'Desktop app',
    summary: 'User-facing host surface for display, approval, and handoff; direct coding, tests, and authority operations depend on connected engines.',
    capabilities: [
      capability('file-edit', 'conditional', 'Requires a connected coding engine.'),
      capability('patch-apply', 'conditional', 'Requires a connected patch/edit engine.'),
      capability('shell/pty', 'conditional', 'Requires a connected local command engine.'),
      capability('test-execution', 'conditional', 'Requires a connected runner or terminal engine.'),
      capability('browser-automation', 'conditional', 'Requires an embedded or connected browser automation engine.'),
      capability('approval', 'available', 'Can collect visible user approval.'),
      capability('artifact-display', 'available', 'Primary surface for displaying generated artifacts.'),
      capability('evidence-submit', 'conditional', 'Requires configured authority client integration.'),
      capability('receipt-verify', 'conditional', 'Requires configured authority verifier integration.'),
      capability('multimodal-research', 'available', 'Can coordinate visual and document-oriented user workflows.'),
    ],
    degradations: [
      degradation('file-edit', 'conditional', 'none', 'Desktop surface needs a connected coding engine for edits.', 'Delegate edits to Codex, Claude Code, or another editor host.'),
      degradation('patch-apply', 'conditional', 'none', 'Desktop surface needs a connected patch engine.', 'Delegate patches to a patch-capable host.'),
      degradation('shell/pty', 'conditional', 'verification-evidence-limited', 'Desktop shell support depends on connected engines.', 'Use a local runner or terminal host.'),
      degradation('test-execution', 'conditional', 'verification-evidence-limited', 'Desktop test execution depends on connected engines.', 'Delegate tests to local-runner.'),
      degradation('browser-automation', 'conditional', 'verification-evidence-limited', 'Browser automation depends on connected browser support.', 'Use a browser host or mark browser verification unavailable.'),
      degradation('evidence-submit', 'conditional', 'evidence-local-only', 'Authority submission depends on configured integration.', 'Keep local evidence until submitted by an authority-capable client.'),
      degradation('receipt-verify', 'conditional', 'blocks-production-done', 'Receipt verification depends on configured integration.', 'Require verified receipt before productionDone.'),
    ],
  },
  {
    id: 'unknown/fallback',
    label: 'Unknown / fallback',
    summary: 'Conservative profile for unrecognized hosts. It exposes no optional capability as available and never grants authority-backed completion.',
    capabilities: [
      capability('file-edit', 'unavailable', 'Unknown host cannot be trusted for edits.'),
      capability('patch-apply', 'unavailable', 'Unknown host cannot be trusted for patches.'),
      capability('shell/pty', 'unavailable', 'Unknown host has no declared shell support.'),
      capability('test-execution', 'unavailable', 'Unknown host has no declared test support.'),
      capability('browser-automation', 'unavailable', 'Unknown host has no declared browser support.'),
      capability('approval', 'unavailable', 'Unknown host has no declared approval support.'),
      capability('artifact-display', 'unavailable', 'Unknown host has no declared artifact display support.'),
      capability('evidence-submit', 'unavailable', 'Unknown host has no declared authority submission support.'),
      capability('receipt-verify', 'unavailable', 'Unknown host has no declared receipt verification support.'),
      capability('multimodal-research', 'unavailable', 'Unknown host has no declared multimodal research support.'),
    ],
    degradations: [
      degradation('file-edit', 'unavailable', 'none', 'Host is unknown.', 'Require an explicit host profile before editing.'),
      degradation('patch-apply', 'unavailable', 'none', 'Host is unknown.', 'Require an explicit patch-capable host.'),
      degradation('shell/pty', 'unavailable', 'verification-evidence-limited', 'Host is unknown.', 'Require an explicit shell-capable host for commands.'),
      degradation('test-execution', 'unavailable', 'verification-evidence-limited', 'Host is unknown.', 'Require an explicit test-capable host.'),
      degradation('browser-automation', 'unavailable', 'verification-evidence-limited', 'Host is unknown.', 'Require an explicit browser-capable host.'),
      degradation('approval', 'unavailable', 'none', 'Host is unknown.', 'Collect approval through a known approval-capable host.'),
      degradation('artifact-display', 'unavailable', 'none', 'Host is unknown.', 'Use a known display-capable host for artifacts.'),
      degradation('evidence-submit', 'unavailable', 'evidence-local-only', 'Host is unknown.', 'Submit evidence through a known authority-capable host.'),
      degradation('receipt-verify', 'unavailable', 'blocks-production-done', 'Host is unknown.', 'Production completion requires a verified receipt from a known verifier.'),
      degradation('multimodal-research', 'unavailable', 'none', 'Host is unknown.', 'Delegate research to a known multimodal host.'),
    ],
  },
];

function materializeProfile(input: HostProfileInput): HostProfile {
  const seen = new Set(input.capabilities.map(c => c.category));
  const missing = CAPABILITY_CATEGORIES.filter(category => !seen.has(category));
  if (missing.length > 0) {
    throw new Error(`host profile ${input.id} missing capability categories: ${missing.join(', ')}`);
  }

  const capabilities = input.capabilities.map(c => ({
    ...c,
    optional: CATEGORY_DESCRIPTIONS[c.category].optional,
  }));
  const degradations = input.degradations.map(d => ({
    id: degradationId(input.id, d.capability),
    host: input.id,
    ...d,
    visible: true as const,
  }));

  return { ...input, capabilities, degradations };
}

export function buildCapabilityList(): CapabilityList {
  return {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    categories: CAPABILITY_CATEGORIES.map(category => CATEGORY_DESCRIPTIONS[category]),
    authorityRules: {
      productionDoneRequiresReceipt: true,
      receiptCapability: 'receipt-verify',
      handoffCanManufactureProductionDone: false,
    },
    hosts: HOST_PROFILE_INPUTS.map(materializeProfile),
  };
}

function normalizeHostId(host: string): string {
  return host.trim().toLowerCase();
}

export function buildCapabilityProbe(host: string): CapabilityProbe {
  const requestedHost = host.trim();
  if (!requestedHost) {
    throw new Error('capability_probe requires --host');
  }
  const list = buildCapabilityList();
  const normalized = normalizeHostId(requestedHost);
  const profile = list.hosts.find(candidate => normalizeHostId(candidate.id) === normalized)
    ?? list.hosts.find(candidate => candidate.id === 'unknown/fallback');
  if (!profile) {
    throw new Error('unknown/fallback host profile is missing from capability registry');
  }

  return {
    schemaVersion: 'koala.capability_probe.v1',
    host: profile.id,
    requestedHost,
    matchedFallback: profile.id !== normalized,
    diagnosticOnly: true,
    authorityRules: list.authorityRules,
    profile,
    degradations: profile.degradations,
  };
}

export function renderCapabilityListText(list: CapabilityList = buildCapabilityList()): string {
  const lines: string[] = [
    `Koala capability profiles (${list.schemaVersion})`,
    '',
    `Authority: productionDone requires ${list.authorityRules.receiptCapability}; handoffCanManufactureProductionDone=${list.authorityRules.handoffCanManufactureProductionDone}`,
    `Categories: ${list.categories.map(c => c.id).join(', ')}`,
    '',
  ];

  for (const host of list.hosts) {
    const available = host.capabilities
      .filter(c => c.status === 'available')
      .map(c => c.category);
    const limited = host.capabilities
      .filter(c => c.status !== 'available')
      .map(c => `${c.category}=${c.status}`);

    lines.push(`${host.id} — ${host.label}`);
    lines.push(`  ${host.summary}`);
    lines.push(`  available: ${available.length > 0 ? available.join(', ') : '(none)'}`);
    lines.push(`  limited: ${limited.length > 0 ? limited.join(', ') : '(none)'}`);
    if (host.degradations.length > 0) {
      lines.push('  degradations:');
      for (const d of host.degradations) {
        lines.push(`    - ${d.id}; capability=${d.capability}; severity=${d.severity}; visible=${d.visible}; authorityImpact=${d.authorityImpact}; ${d.reason}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

export function renderCapabilityProbeText(probe: CapabilityProbe): string {
  const available = probe.profile.capabilities
    .filter(c => c.status === 'available')
    .map(c => c.category);
  const limited = probe.profile.capabilities
    .filter(c => c.status !== 'available')
    .map(c => `${c.category}=${c.status}`);

  const lines: string[] = [
    `Koala capability probe (${probe.schemaVersion})`,
    `host: ${probe.host}`,
    `requestedHost: ${probe.requestedHost}`,
    `matchedFallback: ${probe.matchedFallback}`,
    `diagnosticOnly: ${probe.diagnosticOnly}`,
    `authorityImpact: diagnostic-only`,
    `productionDoneRequiresReceipt: ${probe.authorityRules.productionDoneRequiresReceipt}`,
    '',
    probe.profile.summary,
    '',
    `available: ${available.length > 0 ? available.join(', ') : '(none)'}`,
    `limited: ${limited.length > 0 ? limited.join(', ') : '(none)'}`,
  ];

  if (probe.degradations.length > 0) {
    lines.push('degradations:');
    for (const d of probe.degradations) {
      lines.push(`  - ${d.id}; capability=${d.capability}; visible=${d.visible}; authorityImpact=${d.authorityImpact}; ${d.reason}`);
    }
  }

  return lines.join('\n').trimEnd();
}
