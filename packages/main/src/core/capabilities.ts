export const CAPABILITY_SCHEMA_VERSION = 'lattice.capability_list.v1' as const;

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
  'prewrite-guard',
] as const;

export type CapabilityCategory = typeof CAPABILITY_CATEGORIES[number];
export type CapabilityStatus = 'available' | 'conditional' | 'unavailable';
export type AuthorityImpact =
  | 'none'
  | 'evidence-local-only'
  | 'verification-evidence-limited'
  | 'local-assurance-required'
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
    productionDoneRequiresReceipt: false;
    receiptCapability: 'receipt-verify';
    handoffCanManufactureProductionDone: false;
    proofAdmissibility: 'local-only';
    receiptBundleVerification: 'signed-offline-local';
    reviewQuorum: 'local';
  };
  hosts: HostProfile[];
}

export interface CapabilityProbe {
  schemaVersion: 'lattice.capability_probe.v1';
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
    description: 'Record or package local evidence for Proofbound lifecycle review; no external authority service is implied.',
  },
  'receipt-verify': {
    id: 'receipt-verify',
    label: 'Receipt bundle verify',
    optional: true,
    description: 'Verify signed/offline receipt bundles as local proof-admissibility input; never promotes production completion.',
  },
  'multimodal-research': {
    id: 'multimodal-research',
    label: 'Multimodal research',
    optional: true,
    description: 'Use web, image, document, or other multimodal research inputs.',
  },
  'prewrite-guard': {
    id: 'prewrite-guard',
    label: 'Pre-write guard',
    optional: true,
    description: 'Intercept or gate file writes before they land (native-pretool, wrapped-preapply, or watcher-fallback).',
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
  if (authorityImpact === 'blocks-production-done' || authorityImpact === 'local-assurance-required') return 'block';
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
      capability('evidence-submit', 'conditional', 'Requires story-scoped Proofbound evidence write access.'),
      capability('receipt-verify', 'conditional', 'Requires local signed/offline receipt-bundle inputs and verifier tooling.'),
      capability('multimodal-research', 'available', 'Can combine local files, web research, and visual inputs when tools are present.'),
      capability('prewrite-guard', 'conditional', 'native-pretool mode when a verified Codex PreToolUse hook is installed; wrapped-preapply when invoked via Proofbound dispatch/pre-apply flow; otherwise watcher-fallback.'),
    ],
    degradations: [
      degradation('browser-automation', 'conditional', 'verification-evidence-limited', 'Browser automation may be absent from a Codex session.', 'Mark browser verification unavailable or delegate to a browser-capable host.'),
      degradation('evidence-submit', 'conditional', 'evidence-local-only', 'Evidence remains local until a Proofbound lifecycle command records it.', 'Keep evidence local and do not claim release readiness.'),
      degradation('receipt-verify', 'conditional', 'local-assurance-required', 'Local receipt-bundle verification depends on signed/offline bundle inputs.', 'Record local proof-admissibility, receipt-bundle verification, and review quorum evidence before integration.'),
      degradation('prewrite-guard', 'conditional', 'none', 'Codex native-pretool guard requires a verified .codex/hooks.json PreToolUse hook; without it, direct Codex sessions fall back unless routed through Proofbound dispatch wrapped-preapply.', 'Install the .codex/hooks.json lattice-scope-pretool hook or route through Proofbound dispatch to enable a pre-write guard mode.'),
    ],
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    summary: 'Agentic coding host with shell-oriented project work and optional browser or local-assurance integrations.',
    capabilities: [
      capability('file-edit', 'available', 'Can edit files in the shared workspace.'),
      capability('patch-apply', 'conditional', 'May apply patches through host editing tools or shell commands.'),
      capability('shell/pty', 'available', 'Can run shell commands in project context.'),
      capability('test-execution', 'available', 'Can run project-native test commands.'),
      capability('browser-automation', 'conditional', 'Requires browser tooling configured for the host.'),
      capability('approval', 'available', 'Can operate under explicit approval policy.'),
      capability('artifact-display', 'conditional', 'Artifact display depends on the surrounding UI.'),
      capability('evidence-submit', 'conditional', 'Requires story-scoped Proofbound evidence write access.'),
      capability('receipt-verify', 'conditional', 'Requires local signed/offline receipt-bundle verifier support.'),
      capability('multimodal-research', 'conditional', 'Depends on enabled tools and model inputs.'),
      capability('prewrite-guard', 'conditional', 'native-pretool mode when a verified PreToolUse hook is installed; otherwise watcher-fallback.'),
    ],
    degradations: [
      degradation('patch-apply', 'conditional', 'none', 'Patch-specific tooling may not be exposed directly.', 'Use normal file-edit operations with clear diffs.'),
      degradation('browser-automation', 'conditional', 'verification-evidence-limited', 'Browser tooling may be absent.', 'Delegate browser checks or record a visible browser-test limitation.'),
      degradation('artifact-display', 'conditional', 'none', 'Artifact display depends on the client surface.', 'Return artifact paths or URLs.'),
      degradation('evidence-submit', 'conditional', 'evidence-local-only', 'Lifecycle evidence recording is not intrinsic to the host.', 'Keep local evidence until a Proofbound lifecycle command records it.'),
      degradation('receipt-verify', 'conditional', 'local-assurance-required', 'Local receipt-bundle verification is not intrinsic to the host.', 'Use Proofbound local verifier tooling and review quorum before integration.'),
      degradation('multimodal-research', 'conditional', 'none', 'Multimodal research depends on enabled tools.', 'Use text-only research or delegate to a multimodal host.'),
      degradation('prewrite-guard', 'conditional', 'none', 'native-pretool guard requires a verified PreToolUse hook installed in .claude/settings.json; without it the session falls back to watcher-fallback.', 'Install the prewrite_guard_check hook via guard_session_start or verify hook presence before claiming active guard mode.'),
    ],
  },
  {
    id: 'antigravity',
    label: 'Antigravity',
    summary: 'Agentic coding host exposed through the agy CLI, with CLI-driven project work and optional browser or local-assurance integrations.',
    capabilities: [
      capability('file-edit', 'available', 'Can edit files in the shared workspace.'),
      capability('patch-apply', 'conditional', 'May apply patches through host editing tools or shell commands.'),
      capability('shell/pty', 'available', 'Can run shell commands in project context.'),
      capability('test-execution', 'available', 'Can run project-native test commands.'),
      capability('browser-automation', 'conditional', 'Requires browser tooling configured for the host.'),
      capability('approval', 'available', 'Can operate under explicit approval policy.'),
      capability('artifact-display', 'conditional', 'Artifact display depends on the surrounding UI.'),
      capability('evidence-submit', 'conditional', 'Requires story-scoped Proofbound evidence write access.'),
      capability('receipt-verify', 'conditional', 'Requires local signed/offline receipt-bundle verifier support.'),
      capability('multimodal-research', 'conditional', 'Depends on enabled tools and model inputs.'),
      capability('prewrite-guard', 'conditional', 'wrapped-preapply mode when invoked via Proofbound dispatch/pre-apply flow; otherwise watcher-fallback.'),
    ],
    degradations: [
      degradation('patch-apply', 'conditional', 'none', 'Patch-specific tooling may not be exposed directly.', 'Use normal file-edit operations with clear diffs.'),
      degradation('browser-automation', 'conditional', 'verification-evidence-limited', 'Browser tooling may be absent.', 'Delegate browser checks or record a visible browser-test limitation.'),
      degradation('artifact-display', 'conditional', 'none', 'Artifact display depends on the client surface.', 'Return artifact paths or URLs.'),
      degradation('evidence-submit', 'conditional', 'evidence-local-only', 'Lifecycle evidence recording is not intrinsic to the host.', 'Keep local evidence until a Proofbound lifecycle command records it.'),
      degradation('receipt-verify', 'conditional', 'local-assurance-required', 'Local receipt-bundle verification is not intrinsic to the host.', 'Use Proofbound local verifier tooling and review quorum before integration.'),
      degradation('multimodal-research', 'conditional', 'none', 'Multimodal research depends on enabled tools.', 'Use text-only research or delegate to a multimodal host.'),
      degradation('prewrite-guard', 'conditional', 'none', 'Antigravity has no registered native PreToolUse hook; prewrite guard is wrapped-preapply when via Proofbound dispatch, watcher-fallback otherwise.', 'Route through Proofbound dispatch to enable wrapped-preapply guard mode.'),
    ],
  },
  {
    id: 'local-runner',
    label: 'Local runner',
    summary: 'Non-agent execution host for deterministic commands and tests; it can produce local evidence but not invent edits or completion receipts.',
    capabilities: [
      capability('file-edit', 'unavailable', 'Runner executes commands; it does not author file edits.'),
      capability('patch-apply', 'unavailable', 'Patch application must be performed by an editing host.'),
      capability('shell/pty', 'available', 'Can execute local commands.'),
      capability('test-execution', 'available', 'Primary role is running tests and validation commands.'),
      capability('browser-automation', 'conditional', 'Available only when browser executor dependencies are configured.'),
      capability('approval', 'unavailable', 'Runner cannot ask for human approval by itself.'),
      capability('artifact-display', 'unavailable', 'Runner can write artifacts but cannot display them.'),
      capability('evidence-submit', 'conditional', 'Can record evidence only through configured Proofbound lifecycle commands.'),
      capability('receipt-verify', 'conditional', 'Can verify only when configured with local signed/offline receipt-bundle support.'),
      capability('multimodal-research', 'unavailable', 'Runner has no research model or browsing intelligence.'),
      capability('prewrite-guard', 'unavailable', 'Local runner is execution-only; it has no agent write interception.'),
    ],
    degradations: [
      degradation('file-edit', 'unavailable', 'none', 'A local runner is execution-only.', 'Delegate edits to a file-edit capable host.'),
      degradation('patch-apply', 'unavailable', 'none', 'A local runner is execution-only.', 'Delegate patch application to an editing host.'),
      degradation('browser-automation', 'conditional', 'verification-evidence-limited', 'Browser dependencies may be missing.', 'Run non-browser tests or delegate browser checks.'),
      degradation('approval', 'unavailable', 'none', 'A local runner cannot prompt humans.', 'Have the orchestrating host collect approval before invoking it.'),
      degradation('artifact-display', 'unavailable', 'none', 'A local runner has no display surface.', 'Persist artifact paths for a display-capable host.'),
      degradation('evidence-submit', 'conditional', 'evidence-local-only', 'Evidence recording requires Proofbound lifecycle command access.', 'Record local evidence through the story lifecycle.'),
      degradation('receipt-verify', 'conditional', 'local-assurance-required', 'Local receipt-bundle verification requires verifier configuration.', 'Run local receipt-bundle verification and record review quorum evidence before integration.'),
      degradation('multimodal-research', 'unavailable', 'none', 'A local runner cannot conduct multimodal research.', 'Delegate research to a host with browser or multimodal inputs.'),
      degradation('prewrite-guard', 'unavailable', 'none', 'Local runner has no agent-level write interception.', 'Use an editing host with native-pretool or wrapped-preapply guard support.'),
    ],
  },
  {
    id: 'browser',
    label: 'Browser',
    summary: 'Browser automation surface for web inspection and screenshots; it is not a repository editing or local-assurance host.',
    capabilities: [
      capability('file-edit', 'unavailable', 'Browser cannot edit repository files.'),
      capability('patch-apply', 'unavailable', 'Browser cannot apply code patches.'),
      capability('shell/pty', 'unavailable', 'Browser cannot run local shell commands.'),
      capability('test-execution', 'conditional', 'Can exercise browser flows but cannot run arbitrary project tests.'),
      capability('browser-automation', 'available', 'Primary role is page automation and screenshots.'),
      capability('approval', 'unavailable', 'Browser cannot independently collect approval.'),
      capability('artifact-display', 'available', 'Can render pages and visual artifacts.'),
      capability('evidence-submit', 'unavailable', 'Browser does not record lifecycle evidence by itself.'),
      capability('receipt-verify', 'unavailable', 'Browser does not verify local receipt bundles.'),
      capability('multimodal-research', 'available', 'Can inspect visual web state.'),
      capability('prewrite-guard', 'unavailable', 'Browser is not a repository editing host; pre-write guard does not apply.'),
    ],
    degradations: [
      degradation('file-edit', 'unavailable', 'none', 'Browser is not a file-editing host.', 'Return findings to an editing host.'),
      degradation('patch-apply', 'unavailable', 'none', 'Browser is not a patch host.', 'Return findings to a patch-capable host.'),
      degradation('shell/pty', 'unavailable', 'verification-evidence-limited', 'Browser cannot run local commands.', 'Pair with a shell-capable host for tests.'),
      degradation('test-execution', 'conditional', 'verification-evidence-limited', 'Browser checks are not full project test execution.', 'Record browser evidence and run project tests elsewhere.'),
      degradation('approval', 'unavailable', 'none', 'Browser cannot collect orchestration approval.', 'Collect approval in the orchestrating host.'),
      degradation('evidence-submit', 'unavailable', 'evidence-local-only', 'Browser evidence is local until recorded by a Proofbound lifecycle command.', 'Export screenshot or trace evidence for local review.'),
      degradation('receipt-verify', 'unavailable', 'local-assurance-required', 'Browser cannot verify signed/offline receipt bundles.', 'Pair browser evidence with local receipt-bundle verification and review quorum evidence.'),
      degradation('prewrite-guard', 'unavailable', 'none', 'Browser is not a repository editing host.', 'Use an editing host with prewrite-guard support.'),
    ],
  },
  {
    id: 'server',
    label: 'Server (retired/out-of-core)',
    summary: 'Retired compatibility profile for historical server/orchestration materials; it is not an active Proofbound CLI completion host.',
    capabilities: [
      capability('file-edit', 'unavailable', 'Server should not directly edit client workspaces.'),
      capability('patch-apply', 'unavailable', 'Server should not apply workspace patches.'),
      capability('shell/pty', 'unavailable', 'Server profile does not expose project shell access.'),
      capability('test-execution', 'conditional', 'May schedule runner jobs but does not execute arbitrary local tests by itself.'),
      capability('browser-automation', 'unavailable', 'Server does not drive browsers directly.'),
      capability('approval', 'conditional', 'May enforce approval records but not collect interactive approval by itself.'),
      capability('artifact-display', 'conditional', 'May expose artifact URLs or metadata.'),
      capability('evidence-submit', 'unavailable', 'Server-backed evidence submission is retired/out-of-core for the active CLI.'),
      capability('receipt-verify', 'unavailable', 'Server receipt verification is retired/out-of-core; active verification is local receipt-bundle checking.'),
      capability('multimodal-research', 'unavailable', 'Server is not a research host.'),
      capability('prewrite-guard', 'unavailable', 'Server does not author workspace writes; pre-write guard does not apply.'),
    ],
    degradations: [
      degradation('file-edit', 'unavailable', 'none', 'Server is not a workspace authoring host.', 'Delegate edits to an editing host.'),
      degradation('patch-apply', 'unavailable', 'none', 'Server is not a patch host.', 'Delegate patch application.'),
      degradation('shell/pty', 'unavailable', 'verification-evidence-limited', 'Server does not run local project shells.', 'Use registered runners for commands.'),
      degradation('test-execution', 'conditional', 'verification-evidence-limited', 'Server may coordinate tests but not execute all local tests.', 'Delegate execution to local-runner.'),
      degradation('browser-automation', 'unavailable', 'verification-evidence-limited', 'Server does not drive browsers directly.', 'Delegate browser checks.'),
      degradation('approval', 'conditional', 'none', 'Approval enforcement may depend on external policy data.', 'Require recorded approval from an approval-capable host.'),
      degradation('artifact-display', 'conditional', 'none', 'Server may only expose artifact references.', 'Open artifacts in a display-capable host.'),
      degradation('evidence-submit', 'unavailable', 'evidence-local-only', 'Server-backed evidence submission is not an active CLI runtime path.', 'Use local proof-admissibility evidence and local lifecycle commands.'),
      degradation('receipt-verify', 'unavailable', 'local-assurance-required', 'Server receipt verification is retired from active CLI assurance.', 'Use signed/offline receipt bundles and local review quorum.'),
      degradation('multimodal-research', 'unavailable', 'none', 'Server does not conduct research.', 'Delegate research.'),
      degradation('prewrite-guard', 'unavailable', 'none', 'Server does not author workspace writes.', 'Pre-write guard is only applicable to editing hosts.'),
    ],
  },
  {
    id: 'desktop-app',
    label: 'Desktop app',
    summary: 'User-facing host surface for display, approval, and handoff; direct coding, tests, and local-assurance operations depend on connected engines.',
    capabilities: [
      capability('file-edit', 'conditional', 'Requires a connected coding engine.'),
      capability('patch-apply', 'conditional', 'Requires a connected patch/edit engine.'),
      capability('shell/pty', 'conditional', 'Requires a connected local command engine.'),
      capability('test-execution', 'conditional', 'Requires a connected runner or terminal engine.'),
      capability('browser-automation', 'conditional', 'Requires an embedded or connected browser automation engine.'),
      capability('approval', 'available', 'Can collect visible user approval.'),
      capability('artifact-display', 'available', 'Primary surface for displaying generated artifacts.'),
      capability('evidence-submit', 'conditional', 'Requires a connected Proofbound lifecycle command engine.'),
      capability('receipt-verify', 'conditional', 'Requires connected local receipt-bundle verifier integration.'),
      capability('multimodal-research', 'available', 'Can coordinate visual and document-oriented user workflows.'),
      capability('prewrite-guard', 'unavailable', 'Desktop app is a display/approval surface; pre-write guard is handled by the connected coding engine.'),
    ],
    degradations: [
      degradation('file-edit', 'conditional', 'none', 'Desktop surface needs a connected coding engine for edits.', 'Delegate edits to Codex, Claude Code, or another editor host.'),
      degradation('patch-apply', 'conditional', 'none', 'Desktop surface needs a connected patch engine.', 'Delegate patches to a patch-capable host.'),
      degradation('shell/pty', 'conditional', 'verification-evidence-limited', 'Desktop shell support depends on connected engines.', 'Use a local runner or terminal host.'),
      degradation('test-execution', 'conditional', 'verification-evidence-limited', 'Desktop test execution depends on connected engines.', 'Delegate tests to local-runner.'),
      degradation('browser-automation', 'conditional', 'verification-evidence-limited', 'Browser automation depends on connected browser support.', 'Use a browser host or mark browser verification unavailable.'),
      degradation('evidence-submit', 'conditional', 'evidence-local-only', 'Lifecycle evidence recording depends on configured integration.', 'Keep local evidence until a Proofbound lifecycle command records it.'),
      degradation('receipt-verify', 'conditional', 'local-assurance-required', 'Local receipt-bundle verification depends on configured integration.', 'Use local verifier tooling and review quorum before integration.'),
      degradation('prewrite-guard', 'unavailable', 'none', 'Desktop app does not author writes directly; pre-write guard applies to the connected coding engine.', 'Enable prewrite guard in the connected coding host.'),
    ],
  },
  {
    id: 'unknown/fallback',
    label: 'Unknown / fallback',
    summary: 'Conservative profile for unrecognized hosts. It exposes no optional capability as available and never grants completion authority.',
    capabilities: [
      capability('file-edit', 'unavailable', 'Unknown host cannot be trusted for edits.'),
      capability('patch-apply', 'unavailable', 'Unknown host cannot be trusted for patches.'),
      capability('shell/pty', 'unavailable', 'Unknown host has no declared shell support.'),
      capability('test-execution', 'unavailable', 'Unknown host has no declared test support.'),
      capability('browser-automation', 'unavailable', 'Unknown host has no declared browser support.'),
      capability('approval', 'unavailable', 'Unknown host has no declared approval support.'),
      capability('artifact-display', 'unavailable', 'Unknown host has no declared artifact display support.'),
      capability('evidence-submit', 'unavailable', 'Unknown host has no declared lifecycle evidence support.'),
      capability('receipt-verify', 'unavailable', 'Unknown host has no declared local receipt-bundle verification support.'),
      capability('multimodal-research', 'unavailable', 'Unknown host has no declared multimodal research support.'),
      capability('prewrite-guard', 'unavailable', 'Unknown host defaults to watcher-fallback; no prewrite interception is claimed.'),
    ],
    degradations: [
      degradation('file-edit', 'unavailable', 'none', 'Host is unknown.', 'Require an explicit host profile before editing.'),
      degradation('patch-apply', 'unavailable', 'none', 'Host is unknown.', 'Require an explicit patch-capable host.'),
      degradation('shell/pty', 'unavailable', 'verification-evidence-limited', 'Host is unknown.', 'Require an explicit shell-capable host for commands.'),
      degradation('test-execution', 'unavailable', 'verification-evidence-limited', 'Host is unknown.', 'Require an explicit test-capable host.'),
      degradation('browser-automation', 'unavailable', 'verification-evidence-limited', 'Host is unknown.', 'Require an explicit browser-capable host.'),
      degradation('approval', 'unavailable', 'none', 'Host is unknown.', 'Collect approval through a known approval-capable host.'),
      degradation('artifact-display', 'unavailable', 'none', 'Host is unknown.', 'Use a known display-capable host for artifacts.'),
      degradation('evidence-submit', 'unavailable', 'evidence-local-only', 'Host is unknown.', 'Use a known Proofbound host to record local evidence.'),
      degradation('receipt-verify', 'unavailable', 'local-assurance-required', 'Host is unknown.', 'Use a known local verifier for signed/offline receipt bundles and local review quorum.'),
      degradation('multimodal-research', 'unavailable', 'none', 'Host is unknown.', 'Delegate research to a known multimodal host.'),
      degradation('prewrite-guard', 'unavailable', 'none', 'Host is unknown; defaults to watcher-fallback guard mode.', 'Identify the host and use a known guard-capable profile.'),
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

function buildLegacyGeminiProfile(): HostProfile {
  const antigravity = HOST_PROFILE_INPUTS.find(input => input.id === 'antigravity');
  if (!antigravity) {
    throw new Error('antigravity host profile is missing from capability registry');
  }
  return materializeProfile({
    ...antigravity,
    id: 'gemini',
    label: 'Gemini (deprecated legacy)',
    summary: 'Deprecated legacy compatibility profile. Current third-host diagnostics use antigravity through the agy CLI.',
    capabilities: antigravity.capabilities.map(capability => ({
      ...capability,
      note: `Legacy Gemini compatibility only. ${capability.note}`,
    })),
    degradations: antigravity.degradations.map(degradation => ({
      ...degradation,
      reason: `Legacy Gemini compatibility only. ${degradation.reason}`,
      fallback: `Use antigravity/agy for current third-host flows. ${degradation.fallback}`,
    })),
  });
}

export function buildCapabilityList(): CapabilityList {
  return {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    categories: CAPABILITY_CATEGORIES.map(category => CATEGORY_DESCRIPTIONS[category]),
    authorityRules: {
      productionDoneRequiresReceipt: false,
      receiptCapability: 'receipt-verify',
      handoffCanManufactureProductionDone: false,
      proofAdmissibility: 'local-only',
      receiptBundleVerification: 'signed-offline-local',
      reviewQuorum: 'local',
    },
    hosts: HOST_PROFILE_INPUTS.map(materializeProfile),
  };
}

function normalizeHostId(host: string): string {
  const value = host.trim().toLowerCase();
  if (value === 'agy') return 'antigravity';
  return value;
}

export function buildCapabilityProbe(host: string): CapabilityProbe {
  const requestedHost = host.trim();
  if (!requestedHost) {
    throw new Error('capability_probe requires --host');
  }
  const list = buildCapabilityList();
  const normalized = normalizeHostId(requestedHost);
  const profile = list.hosts.find(candidate => normalizeHostId(candidate.id) === normalized)
    ?? (normalized === 'gemini' ? buildLegacyGeminiProfile() : undefined)
    ?? list.hosts.find(candidate => candidate.id === 'unknown/fallback');
  if (!profile) {
    throw new Error('unknown/fallback host profile is missing from capability registry');
  }

  return {
    schemaVersion: 'lattice.capability_probe.v1',
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
    `Proofbound capability profiles (${list.schemaVersion})`,
    '',
    `Local assurance: proofAdmissibility=${list.authorityRules.proofAdmissibility}; receiptBundleVerification=${list.authorityRules.receiptBundleVerification}; reviewQuorum=${list.authorityRules.reviewQuorum}; handoffCanManufactureProductionDone=${list.authorityRules.handoffCanManufactureProductionDone}`,
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
    `Proofbound capability probe (${probe.schemaVersion})`,
    `host: ${probe.host}`,
    `requestedHost: ${probe.requestedHost}`,
    `matchedFallback: ${probe.matchedFallback}`,
    `diagnosticOnly: ${probe.diagnosticOnly}`,
    `authorityImpact: diagnostic-only`,
    `localAssurance: proofAdmissibility=${probe.authorityRules.proofAdmissibility}; receiptBundleVerification=${probe.authorityRules.receiptBundleVerification}; reviewQuorum=${probe.authorityRules.reviewQuorum}`,
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
