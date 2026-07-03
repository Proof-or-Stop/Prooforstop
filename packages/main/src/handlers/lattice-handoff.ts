import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import {
  buildHandoffAcceptProjection,
  buildHandoffResumeProjection,
  buildHandoffWorktreeProjection,
  buildHostDispatchProjection,
  type HostDispatchPrefetch,
  type HostDispatchPrefetchManifest,
  type HostDispatchPrefetchSnapshot,
  type HostDispatchSupersessionReport,
  createHandoffPack,
  inspectHandoffPack,
  readHandoffAcceptProjection,
  readHandoffPack,
  readHandoffReceipt,
  renderHandoffAdmissibilityLines,
  renderHandoffAcceptText,
  renderHandoffInspectionText,
  renderHandoffReceiptSubmissionText,
  renderHandoffResumeText,
  renderHandoffWorktreeProjectionText,
  renderHostDispatchProjectionText,
  submitHandoffReceipt,
  type HandoffAdmissibilityOptions,
  type HandoffAcceptProjection,
  type HandoffPack,
} from '../core/lattice-handoff.js';
import { resolveProofAdmissibilityPolicy, type ProofAdmissibilityPolicy } from '../core/proof-admissibility-gates.js';
import { createDevMemoryHandlers } from './dev-memory.js';
import { createGapHandlers } from './gap.js';
import { createLearningValidateHandlers } from './learning-validate.js';
import { createSessionHandlers } from './session.js';
import { createStoryQueryHandlers } from './story-query.js';
import { createSummaryHandlers } from './summary.js';
import {
  assertRuntimeHostPolicyAllowed,
  buildMemoryFreshnessPack,
  evaluateRuntimeHostPolicy,
  normalizeRuntimeHostAliasForCapabilityRegistry,
  renderMemoryFreshnessPack,
  renderMemoryFreshnessPackSummary,
  runtimeMemoryTopHits,
  type RuntimeHostPolicyDecision,
} from '../core/playbook-runtime-memory.js';
import { shouldRenderRuntimeMemoryPack, surfaceRuntimeMemoryPack } from '../core/experience-pack-surface.js';
import { redactMemoryPackForControlArm } from '../core/runtime-memory-arm-gate.js';
import type { HandlerContext } from './context.js';

type FormatArgs = { format?: 'text' | 'json'; json?: boolean };

function writeJsonNoOverwrite(file: string, value: unknown): void {
  if (existsSync(file)) throw new Error(`refusing to overwrite existing file: ${file}`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function normalizeList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  if (typeof value === 'string' && value.trim().length > 0) return [value.trim()];
  return undefined;
}

function normalizeListOrEmpty(value: unknown): string[] {
  return normalizeList(value) ?? [];
}

function handoffAdmissibilityOptions(policy: ProofAdmissibilityPolicy, admissibleProofRefs?: string[]): HandoffAdmissibilityOptions {
  return admissibleProofRefs && admissibleProofRefs.length > 0
    ? { policy, admissibleProofRefs }
    : { policy };
}

function safeJsonParse(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function shortErr(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runSnapshot<T>(
  label: string,
  fn: () => T,
): HostDispatchPrefetchSnapshot {
  try {
    const raw = fn();
    const rendered = typeof raw === 'string'
      ? raw
      : JSON.stringify(raw, null, 2);
    return {
      status: 'ok',
      raw: rendered,
      parsed: typeof raw === 'string' ? safeJsonParse(raw) : raw,
    };
  } catch (error) {
    return {
      status: 'error',
      raw: `failed to collect ${label}: ${shortErr(error)}`,
      reason: shortErr(error),
    };
  }
}

function stripAnchor(raw: string): string {
  const noHash = raw.split('#')[0];
  return noHash.trim();
}

function splitPathToCheck(root: string, rawPath: string): string | undefined {
  const noAnchor = stripAnchor(rawPath).trim();
  if (!noAnchor) return undefined;
  if (noAnchor.startsWith('http://') || noAnchor.startsWith('https://')) {
    return undefined;
  }
  return isAbsolute(noAnchor) ? noAnchor : resolve(root, noAnchor);
}

function normalizeStoryPath(rawPath: string): string {
  return rawPath.replace(/\\+/g, '/');
}

function parseYamlLikeFrontmatter(raw: string): Record<string, unknown> | null {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') return null;
  const endDelimiterIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (endDelimiterIndex <= 0) return null;
  const sectionLines = lines.slice(1, endDelimiterIndex);

  const frontmatter: Record<string, unknown> = {};
  let currentSection: string | null = null;

  const parseScalar = (value: string): unknown => {
    const normalized = value.trim();
    if (!normalized) return '';
    if (normalized === 'null') return null;
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    if (
      (normalized.startsWith('"') && normalized.endsWith('"'))
      || (normalized.startsWith("'") && normalized.endsWith("'"))
    ) {
      return normalized.slice(1, -1);
    }
    return normalized;
  };

  for (const rawLine of sectionLines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    if (line.trim().startsWith('#')) continue;

    const isNested = /^\s/.test(line);
    const target = isNested
      ? (typeof currentSection === 'string' ? (frontmatter[currentSection] as Record<string, unknown>) : undefined)
      : null;

    const matcher = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!matcher) continue;
    const [, key, rawValue] = matcher;
    const value = rawValue.trim();

    if (isNested) {
      if (!target) continue;
      target[key] = parseScalar(value);
      continue;
    }

    if (value === '') {
      frontmatter[key] = {};
      currentSection = key;
    } else {
      frontmatter[key] = parseScalar(value);
      currentSection = null;
    }
  }

  return frontmatter;
}

function pickSupersession(raw: Record<string, unknown>): {
  status?: string;
  completedByStory?: string;
  completionCommit?: string;
  supersededBy?: string | null;
  completionNote?: string;
  sourceStoryId?: string;
  updatedAt?: string;
} {
  const block = raw.supersession;
  if (typeof block !== 'object' || block === null || Array.isArray(block)) {
    return {};
  }
  const value = block as Record<string, unknown>;
  return {
    status: typeof value.status === 'string' ? value.status : undefined,
    completedByStory: typeof value.completedByStory === 'string' ? value.completedByStory : undefined,
    completionCommit: typeof value.completionCommit === 'string' ? value.completionCommit : undefined,
    supersededBy: typeof value.supersededBy === 'string'
      ? value.supersededBy
      : value.supersededBy === null
        ? null
        : undefined,
    completionNote: typeof value.completionNote === 'string' ? value.completionNote : undefined,
    sourceStoryId: typeof value.sourceStoryId === 'string' ? value.sourceStoryId : undefined,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : undefined,
  };
}

function resolveCommitIfExists(gitCwd: string, ref: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
      cwd: gitCwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

function collectRelatedDocs(storyGet: Record<string, unknown>): string[] {
  const checklist = storyGet.checklist as { items?: Array<{ relatedDocs?: unknown }> } | undefined;
  if (!checklist?.items) return [];
  const docs = new Set<string>();
  for (const item of checklist.items) {
    if (!item || !Array.isArray(item.relatedDocs)) continue;
    for (const doc of item.relatedDocs) {
      if (typeof doc !== 'string') continue;
      const normalized = stripAnchor(doc).trim();
      if (!normalized) continue;
      docs.add(normalizedPath(normalized));
    }
  }
  return [...docs];
}

function normalizedPath(value: string): string {
  return normalizeStoryPath(value.replace(/^\.\//, ''));
}

function buildSupersessionReport(
  root: string,
  gitCwd: string,
  storyId: string,
  relatedDocs: string[],
): HostDispatchSupersessionReport {
  const checked = new Set<string>();
  const staleSignals: string[] = [];
  const staleDocs: string[] = [];
  const completionSignals: string[] = [];
  let winner: string | undefined;
  let anySignal = false;

  const statusByDoc: Array<'invalid' | 'stale' | 'present'> = [];

  for (const docRef of relatedDocs) {
    checked.add(docRef);
    const checkedPath = splitPathToCheck(root, docRef);
    if (!checkedPath) {
      anySignal = true;
      statusByDoc.push('stale');
      staleDocs.push(docRef);
      staleSignals.push(`Related doc ${docRef} uses non-local or unsupported path format.`);
      continue;
    }

    let text: string;
    try {
      text = readFileSync(checkedPath, 'utf8');
    } catch (error) {
      anySignal = true;
      statusByDoc.push('stale');
      staleDocs.push(docRef);
      staleSignals.push(`Related doc missing: ${docRef} (${shortErr(error)}).`);
      continue;
    }

    const rawFrontmatter = parseYamlLikeFrontmatter(text);
    if (!rawFrontmatter) {
      anySignal = true;
      statusByDoc.push('invalid');
      staleDocs.push(docRef);
      staleSignals.push(`Related doc ${docRef} missing machine-readable frontmatter.`);
      continue;
    }

    const metadata = pickSupersession(rawFrontmatter);
    const completedByStory = metadata.completedByStory || metadata.sourceStoryId;
    const commit = metadata.completionCommit;
    const status = typeof metadata.status === 'string' ? metadata.status : '';

    if (!status) {
      anySignal = true;
      statusByDoc.push('invalid');
      staleDocs.push(docRef);
      staleSignals.push(`Related doc ${docRef} has no supersession.status.`);
      continue;
    }

    if (metadata.status === 'completed') {
      if (!completedByStory || !commit) {
        anySignal = true;
        statusByDoc.push('invalid');
        staleDocs.push(docRef);
        staleSignals.push(`Related doc ${docRef} completed status lacks completedByStory/completionCommit.`);
        continue;
      }
      if (!/^[0-9a-fA-F]{40}$/.test(commit)) {
        anySignal = true;
        statusByDoc.push('invalid');
        staleDocs.push(docRef);
        staleSignals.push(`Related doc ${docRef} completionCommit is invalid: ${commit}.`);
        continue;
      }
      if (!resolveCommitIfExists(gitCwd, commit)) {
        anySignal = true;
        statusByDoc.push('invalid');
        staleDocs.push(docRef);
        staleSignals.push(`Related doc ${docRef} completionCommit not found in current repo: ${commit}.`);
        continue;
      }
      completionSignals.push(`${docRef}:completed-by-${completedByStory}`);
      if (completedByStory === storyId) {
        winner = storyId;
        statusByDoc.push('present');
      } else {
        statusByDoc.push('stale');
        staleDocs.push(docRef);
        staleSignals.push(
          `Related doc ${docRef} is marked completed by ${completedByStory}, but target is ${storyId}; treat as historical.`,
        );
      }
      continue;
    }

    if (metadata.status === 'historical' || metadata.status === 'draft') {
      anySignal = true;
      statusByDoc.push('stale');
      staleDocs.push(docRef);
      staleSignals.push(`Related doc ${docRef} is marked ${metadata.status}; reference-only for current active facts.`);
      continue;
    }

    if (metadata.status === 'superseded') {
      anySignal = true;
      statusByDoc.push('stale');
      staleDocs.push(docRef);
      staleSignals.push(
        `Related doc ${docRef} is marked superseded${metadata.supersededBy ? ` by ${metadata.supersededBy}` : ''}; prefer current target facts.`,
      );
      continue;
    }

    anySignal = true;
    statusByDoc.push('invalid');
    staleDocs.push(docRef);
    staleSignals.push(`Related doc ${docRef} has unsupported supersession.status=${metadata.status}.`);
  }

  if (completionSignals.length > 0) {
    anySignal = true;
  }

  let reportStatus: HostDispatchSupersessionReport['status'] = 'none';
  if (relatedDocs.length > 0) {
    reportStatus = statusByDoc.some(s => s === 'invalid') ? 'invalid'
      : statusByDoc.every(s => s === 'present') ? 'present'
      : statusByDoc.some(s => s === 'stale') ? 'stale'
      : 'none';
  }

  const summary = reportStatus === 'none'
    ? 'No related docs with machine-readable supersession found.'
    : reportStatus === 'present'
      ? completionSignals.length > 0
        ? `Found authoritative completion signal(s): ${completionSignals.join('; ')}`
        : 'Related docs are present with valid supersession metadata.'
      : `Related docs checked but require live fact revalidation: ${staleSignals.length} item(s).`;

  return {
    status: reportStatus,
    docsChecked: [...checked],
    staleDocs: [...new Set(staleDocs)],
    ...(winner ? { winner } : {}),
    ...(anySignal ? { signal: staleSignals[0] } : {}),
    summary: summary + (anySignal ? ` [rawSignals=${staleSignals.length}]` : ''),
  };
}

function buildHostDispatchPrefetchManifest(
  packStoryId: string,
  host: string,
  preflight: HostDispatchPrefetch,
  supersession: HostDispatchSupersessionReport,
  storyIsDone: boolean,
  hostPolicy?: RuntimeHostPolicyDecision,
): HostDispatchPrefetchManifest {
  // Control-arm isolation: the manifest's memoryPackDigest/memoryTopHitIds are
  // serialized to host_dispatch --format=json and the --output file, so redact
  // the pack by the current arm here (control -> empty ids + empty-set digest).
  const safePack = preflight.memoryFreshnessPack
    ? redactMemoryPackForControlArm(preflight.memoryFreshnessPack)
    : undefined;
  const staleSignals: string[] = [];
  const allUnavailable = [
    preflight.sessionBrief.status,
    preflight.devMemoryPreflight.status,
    preflight.activeStorySummary.status,
    preflight.doneStorySummary.status,
    preflight.gapAnalyzeSummary.status,
    preflight.learningSignalSummary.status,
  ];

  if (allUnavailable.includes('error')) {
    staleSignals.push('Host preflight failed for one or more mandatory signals.');
  }
  if (supersession.staleDocs.length > 0) {
    staleSignals.push(...supersession.staleDocs.map(doc => `supersession stale: ${doc}`));
  }
  if (supersession.status === 'invalid') {
    staleSignals.push('supersession metadata has validation errors.');
  }

  const doneSummary = preflight.doneStorySummary.parsed as Record<string, unknown> | undefined;
  const hasDoneStorySummary = typeof doneSummary === 'object'
    && doneSummary !== null
    && doneSummary._empty !== true;
  const doneSignals = storyIsDone || hasDoneStorySummary;

  if (doneSignals) {
    return {
      host,
      targetStoryId: packStoryId,
      bundleFiles: [],
      verdict: 'blocked',
      winSignal: storyIsDone
        ? 'activeStorySummary.phase=DONE'
        : hasDoneStorySummary
          ? 'doneStorySummary.available'
          : 'ready-for-open-work',
      staleSignals,
      ...(safePack ? {
        memoryPackDigest: safePack.packDigest,
        memoryTopHitIds: runtimeMemoryTopHits(safePack).ids,
      } : {}),
      ...(hostPolicy ? { runtimeHostPolicy: hostPolicy } : {}),
    };
  }

  if (supersession.status === 'present' && supersession.winner === packStoryId) {
    return {
      host,
      targetStoryId: packStoryId,
      bundleFiles: [],
      verdict: 'uncertain',
      winSignal: `supersession(${supersession.winner})`,
        staleSignals,
      ...(safePack ? {
        memoryPackDigest: safePack.packDigest,
        memoryTopHitIds: runtimeMemoryTopHits(safePack).ids,
      } : {}),
      ...(hostPolicy ? { runtimeHostPolicy: hostPolicy } : {}),
    };
  }

  const hasLiveSignals = preflight.sessionBrief.status === 'ok'
    && preflight.devMemoryPreflight.status === 'ok'
    && preflight.activeStorySummary.status === 'ok'
    && preflight.gapAnalyzeSummary.status === 'ok'
    && preflight.learningSignalSummary.status === 'ok';
  if (!hasLiveSignals || allUnavailable.includes('error') || supersession.status === 'invalid' || supersession.status === 'stale') {
    return {
      host,
      targetStoryId: packStoryId,
      bundleFiles: [],
      verdict: 'uncertain',
      winSignal: 'requires_revalidation',
      staleSignals,
      ...(safePack ? {
        memoryPackDigest: safePack.packDigest,
        memoryTopHitIds: runtimeMemoryTopHits(safePack).ids,
      } : {}),
      ...(hostPolicy ? { runtimeHostPolicy: hostPolicy } : {}),
    };
  }

  return {
    host,
    targetStoryId: packStoryId,
    bundleFiles: [],
    verdict: 'no-block',
    winSignal: 'activeStorySummary/gapAnalyze/learningValidate',
    staleSignals,
    ...(safePack ? {
      memoryPackDigest: safePack.packDigest,
      memoryTopHitIds: runtimeMemoryTopHits(safePack).ids,
    } : {}),
    ...(hostPolicy ? { runtimeHostPolicy: hostPolicy } : {}),
  };
}

function buildHandoffRuntimeMemoryPack(ctx: HandlerContext, args: {
  storyId: string;
  host?: string;
  phase?: string;
  objective?: string;
  consumer?: 'host_handoff';
}) {
  // B-ab8d CHK-002: experiment-arm surfacing — pack always computed (JSON
  // embedding is NOT arm-gated), event fires on both arms; the text render
  // sites gate visibility via shouldRenderRuntimeMemoryPack().
  const surfaced = surfaceRuntimeMemoryPack(ctx.root, {
    consumer: args.consumer ?? 'host_handoff',
    storyId: args.storyId,
    roundKey: args.phase,
    buildPack: () => buildMemoryFreshnessPack({
      projectRoot: ctx.root,
      consumer: args.consumer ?? 'host_handoff',
      storyPhase: args.phase,
      host: args.host,
      query: [
        `story:${args.storyId}`,
        args.host ?? '',
        args.objective ?? '',
        'handoff host-policy codex-cli claude-cli agy fallback unavailable quota timed-out',
        'stale-doc truth-first repro-first intent-totality delivery',
      ].filter(Boolean).join(' '),
      maxEntries: 5,
      maxPlaybooks: 5,
      maxLines: 60,
    }),
  });
  return surfaced.pack;
}

function buildPrefetchBundle(ctx: HandlerContext, pack: HandoffPack, requestedHost: string, hostPolicy?: RuntimeHostPolicyDecision): {
  preflight: HostDispatchPrefetch;
  prefetchManifest: HostDispatchPrefetchManifest;
} {
  const sessionHandlers = createSessionHandlers(ctx);
  const devMemoryHandlers = createDevMemoryHandlers(ctx);
  const storyHandlers = createStoryQueryHandlers(ctx);
  const summaryHandlers = createSummaryHandlers(ctx);
  const gapHandlers = createGapHandlers(ctx);
  const learningHandlers = createLearningValidateHandlers(ctx);

  const sessionBrief = runSnapshot('session_brief', () => sessionHandlers.session_brief({ concise: false }));
  const activeStorySummary = runSnapshot('story_get', () =>
    storyHandlers.story_get({ storyId: pack.storyId, detail: true }));
  const doneStorySummary = runSnapshot('summary_get', () => summaryHandlers.summary_get({ storyId: pack.storyId }));
  const devMemoryPreflight = runSnapshot('dev_memory_preflight', () =>
    devMemoryHandlers.dev_memory_preflight({ json: true, query: `story:${pack.storyId}`, maxEntries: 5, maxLines: 40 }));
  const gapAnalyzeSummary = runSnapshot('gap_analyze', () => gapHandlers.gap_analyze());
  const learningSignalSummary = runSnapshot('learning_validate', () =>
    learningHandlers.learning_validate({ story: pack.storyId, json: true }));
  const memoryFreshnessPack = buildHandoffRuntimeMemoryPack(ctx, {
    storyId: pack.storyId,
    phase: pack.recoveryPoint.phase,
    host: requestedHost || pack.toHost,
    objective: pack.objective,
  });

  const activeStory = (activeStorySummary.parsed && typeof activeStorySummary.parsed === 'object')
    ? (activeStorySummary.parsed as Record<string, unknown>)
    : {};
  const storyIndex = activeStory.index as { phase?: string } | undefined;
  const storyIsDone = storyIndex?.phase === 'DONE';

  const docs = Array.from(new Set(collectRelatedDocs(activeStory)));

  const packGitCwd = resolveGitCwd({
    store: ctx.store,
    storyId: pack.storyId,
    metadataRoot: ctx.root,
    projectRoot: ctx.root,
  });
  const supersession = buildSupersessionReport(ctx.root, packGitCwd, pack.storyId, docs);

  const preflight: HostDispatchPrefetch = {
    computedAt: new Date().toISOString(),
    sessionBrief,
    devMemoryPreflight,
    memoryFreshnessPack,
    activeStorySummary,
    doneStorySummary,
    gapAnalyzeSummary,
    learningSignalSummary,
    supersession,
  };

  const preflightHost = requestedHost.trim().length > 0 ? requestedHost : pack.toHost;
  const prefetchManifest = buildHostDispatchPrefetchManifest(pack.storyId, preflightHost, preflight, supersession, storyIsDone, hostPolicy);
  return { preflight, prefetchManifest };
}

function readResumeSource(file: string, options: HandoffAdmissibilityOptions): HandoffPack | HandoffAcceptProjection {
  const schemaVersion = (JSON.parse(readFileSync(file, 'utf8')) as { schemaVersion?: unknown }).schemaVersion;
  if (schemaVersion === 'handoff-pack-v0') return readHandoffPack(file, options);
  if (schemaVersion === 'lattice.handoff_accept.v1') return readHandoffAcceptProjection(file, options);
  throw new Error(`handoff_resume expected handoff-pack-v0 or lattice.handoff_accept.v1, got ${String(schemaVersion)}`);
}

function wantsJson(args: FormatArgs | undefined): boolean {
  return args?.format === 'json' || args?.json === true;
}

function renderHandoffMemoryText(pack: ReturnType<typeof buildHandoffRuntimeMemoryPack>): string {
  return `\n\n${renderMemoryFreshnessPack(pack)}`;
}

export function createLatticeHandoffHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  return {
    handoff_create(args: {
      storyId: string;
      fromHost: string;
      toHost: string;
      role?: string;
      objective?: string;
      allowedPaths?: string[] | string;
      deniedPaths?: string[] | string;
      requiredCommands?: string[] | string;
      successCriteria?: string[] | string;
      baseSha?: string;
      packId?: string;
      authorityBoundary?: string;
      executionInstructions?: string[] | string;
      admissibleProofRefs?: string[] | string;
      primaryHostFailure?: string;
      format?: 'text' | 'json';
      json?: boolean;
      output?: string;
    }) {
      const hostPolicy = evaluateRuntimeHostPolicy({
        requestedHost: args.toHost,
        primaryHostFailure: args.primaryHostFailure,
      });
      assertRuntimeHostPolicyAllowed(hostPolicy, 'handoff_create');
      const fromCapabilityHost = normalizeRuntimeHostAliasForCapabilityRegistry(args.fromHost);
      const policy = resolveProofAdmissibilityPolicy(ctx.root);
      const admissibleProofRefs = normalizeListOrEmpty(args.admissibleProofRefs);
      const pack = createHandoffPack(ctx.store, ctx.root, {
        storyId: args.storyId,
        fromHost: fromCapabilityHost,
        toHost: hostPolicy.capabilityHostId,
        role: args.role,
        objective: args.objective,
        allowedPaths: normalizeList(args.allowedPaths),
        deniedPaths: normalizeList(args.deniedPaths),
        requiredCommands: normalizeList(args.requiredCommands),
        successCriteria: normalizeList(args.successCriteria),
        baseSha: args.baseSha,
        packId: args.packId,
        authorityBoundary: args.authorityBoundary,
        executionInstructions: normalizeList(args.executionInstructions),
        admissibleProofRefs,
        policy,
      });
      // Control-arm isolation: a control-arm host must not EMIT memory into the
      // handoff pack it serializes (--json) or writes (--output); redact at attach.
      pack.memoryFreshnessPack = redactMemoryPackForControlArm(buildHandoffRuntimeMemoryPack(ctx, {
        storyId: pack.storyId,
        phase: pack.recoveryPoint.phase,
        host: pack.toHost,
        objective: pack.objective,
      }));
      pack.runtimeHostPolicy = hostPolicy;
      if (args.output) {
        const outputPath = resolve(process.cwd(), args.output);
        writeJsonNoOverwrite(outputPath, pack);
      }
      if (wantsJson(args)) return pack;
      const outputNote = args.output ? `\noutput: ${args.output}` : '';
      return [
        `Handoff pack (${pack.schemaVersion})`,
        `storyId: ${pack.storyId}`,
        `packId: ${pack.packId}`,
        `packHash: ${pack.packHash}`,
        `baseSha: ${pack.baseSha ?? 'missing'}`,
        `fromHost: ${pack.fromHost}`,
        `toHost: ${pack.toHost}`,
        `allowedPaths: ${pack.allowedPaths.length}`,
        `deniedPaths: ${pack.deniedPaths.length}`,
        `requiredCommands: ${pack.requiredCommands.length}`,
        `successCriteria: ${pack.successCriteria.length}`,
        ...renderHandoffAdmissibilityLines(pack.admissibilitySummary),
        'admissibilityStatus: handoff-pack',
        'assuranceLevel: local',
        'evidenceScope: handoff-context',
        `receiptRefs: ${pack.receiptRefs.length}`,
        `recoveryPoint: ${pack.recoveryPoint.id}`,
        ...(pack.phaseAuthorityWarning
          ? [`⚠ phaseAuthority (${pack.phaseAuthorityWarning.relation}): ${pack.phaseAuthorityWarning.message}`]
          : []),
        `runtimeHostPolicy: ${hostPolicy.canonicalHost} role=${hostPolicy.role} allowed=${hostPolicy.allowed}`,
        `runtimeHostPolicyCapabilityHost: ${hostPolicy.capabilityHostId}`,
        `runtimeHostPolicyReason: ${hostPolicy.reason}`,
        // B-ab8d CHK-002: control arm hides the rendered memory section only.
        shouldRenderRuntimeMemoryPack() ? renderHandoffMemoryText(pack.memoryFreshnessPack) : '',
        outputNote.trimEnd(),
      ].filter(Boolean).join('\n');
    },
    handoff_inspect(args: { file: string; admissibleProofRefs?: string[] | string } & FormatArgs) {
      const policy = resolveProofAdmissibilityPolicy(ctx.root);
      const pack = readHandoffPack(resolve(process.cwd(), args.file), handoffAdmissibilityOptions(policy, normalizeList(args.admissibleProofRefs)));
      const inspection = inspectHandoffPack(pack);
      if (wantsJson(args)) return inspection;
      return renderHandoffInspectionText(inspection);
    },
    handoff_accept(args: {
      file: string;
      acceptedByHost?: string;
      admissibleProofRefs?: string[] | string;
      format?: 'text' | 'json';
      json?: boolean;
      output?: string;
    }) {
      const policy = resolveProofAdmissibilityPolicy(ctx.root);
      const admissibleProofRefs = normalizeList(args.admissibleProofRefs);
      const options = handoffAdmissibilityOptions(policy, admissibleProofRefs);
      const pack = readHandoffPack(resolve(process.cwd(), args.file), options);
      const projection = buildHandoffAcceptProjection(pack, { acceptedByHost: args.acceptedByHost, ...options });
      if (args.output) {
        const outputPath = resolve(process.cwd(), args.output);
        writeJsonNoOverwrite(outputPath, projection);
      }
      if (wantsJson(args)) return projection;
      const outputNote = args.output ? `\noutput: ${args.output}` : '';
      return [renderHandoffAcceptText(projection), outputNote.trimEnd()].filter(Boolean).join('\n');
    },
    handoff_resume(args: {
      file: string;
      resumeHost?: string;
      admissibleProofRefs?: string[] | string;
      primaryHostFailure?: string;
      format?: 'text' | 'json';
      json?: boolean;
      output?: string;
    }) {
      const policy = resolveProofAdmissibilityPolicy(ctx.root);
      const admissibleProofRefs = normalizeList(args.admissibleProofRefs);
      const options = handoffAdmissibilityOptions(policy, admissibleProofRefs);
      const source = readResumeSource(resolve(process.cwd(), args.file), options);
      const targetHost = args.resumeHost ?? (source.schemaVersion === 'lattice.handoff_accept.v1' ? source.acceptedByHost : source.toHost);
      const hostPolicy = evaluateRuntimeHostPolicy({
        requestedHost: targetHost,
        primaryHostFailure: args.primaryHostFailure,
      });
      assertRuntimeHostPolicyAllowed(hostPolicy, 'handoff_resume');
      const projection = buildHandoffResumeProjection(source, { resumeHost: hostPolicy.capabilityHostId, ...options });
      // Control-arm isolation: the resume pack comes either from the source file
      // or (when absent, e.g. an accept.json) is REBUILT live — redact whichever
      // by the arm so the control JSON/--output surface carries no memory.
      const memoryFreshnessPack = redactMemoryPackForControlArm(projection.memoryFreshnessPack ?? buildHandoffRuntimeMemoryPack(ctx, {
        storyId: projection.storyId,
        phase: projection.recoveryPoint.phase,
        host: projection.resumeHost,
      }));
      const enriched = { ...projection, memoryFreshnessPack, runtimeHostPolicy: hostPolicy };
      if (args.output) {
        const outputPath = resolve(process.cwd(), args.output);
        writeJsonNoOverwrite(outputPath, enriched);
      }
      if (wantsJson(args)) return enriched;
      const outputNote = args.output ? `\noutput: ${args.output}` : '';
      // B-ab8d CHK-002 + F-001: control arm suppresses the whole rendered
      // "Runtime memory advisory:" section. The pack lines AND the hostPolicy
      // lines share that single section header (renderOptionalMemoryLines
      // fires when EITHER arg is present), so runtimeHostPolicy must be
      // stripped from the render projection too — otherwise the header +
      // hostPolicy lines would still render on control. Render-only gating:
      // the JSON projection above keeps pack + hostPolicy for lossless
      // measurement, and the host policy itself was already enforced by
      // assertRuntimeHostPolicyAllowed regardless of arm.
      const {
        memoryFreshnessPack: _hiddenOnControl,
        runtimeHostPolicy: _hostPolicyHiddenOnControl,
        ...enrichedWithoutAdvisory
      } = enriched;
      const renderProjection = shouldRenderRuntimeMemoryPack() ? enriched : enrichedWithoutAdvisory;
      return [renderHandoffResumeText(renderProjection), outputNote.trimEnd()].filter(Boolean).join('\n');
    },
    handoff_receipt_submit(args: {
      file: string;
      admissibleProofRefs?: string[] | string;
      format?: 'text' | 'json';
      json?: boolean;
      output?: string;
    }) {
      const policy = resolveProofAdmissibilityPolicy(ctx.root);
      const admissibleProofRefs = normalizeList(args.admissibleProofRefs);
      const options = handoffAdmissibilityOptions(policy, admissibleProofRefs);
      const receipt = readHandoffReceipt(resolve(process.cwd(), args.file), options);
      const result = submitHandoffReceipt(ctx.root, receipt, options);
      if (args.output) {
        const outputPath = resolve(process.cwd(), args.output);
        writeJsonNoOverwrite(outputPath, result);
      }
      if (wantsJson(args)) return result;
      const outputNote = args.output ? `\noutput: ${args.output}` : '';
      return [renderHandoffReceiptSubmissionText(result), outputNote.trimEnd()].filter(Boolean).join('\n');
    },
    handoff_worktree_create(args: {
      file: string;
      format?: 'text' | 'json';
      json?: boolean;
      output?: string;
    }) {
      const pack = readHandoffPack(resolve(process.cwd(), args.file), handoffAdmissibilityOptions(resolveProofAdmissibilityPolicy(ctx.root)));
      const result = buildHandoffWorktreeProjection(pack);
      if (args.output) {
        const outputPath = resolve(process.cwd(), args.output);
        writeJsonNoOverwrite(outputPath, result);
      }
      if (wantsJson(args)) return result;
      const outputNote = args.output ? `\noutput: ${args.output}` : '';
      return [renderHandoffWorktreeProjectionText(result), outputNote.trimEnd()].filter(Boolean).join('\n');
    },
    host_dispatch(args: {
      host: string;
      file: string;
      mode?: 'supervised';
      admissibleProofRefs?: string[] | string;
      primaryHostFailure?: string;
      format?: 'text' | 'json';
      json?: boolean;
      output?: string;
    }) {
      const policy = resolveProofAdmissibilityPolicy(ctx.root);
      const pack = readHandoffPack(resolve(process.cwd(), args.file), handoffAdmissibilityOptions(policy, normalizeList(args.admissibleProofRefs)));
      const hostPolicy = evaluateRuntimeHostPolicy({
        requestedHost: args.host,
        primaryHostFailure: args.primaryHostFailure,
      });
      assertRuntimeHostPolicyAllowed(hostPolicy, 'host_dispatch');
      const { preflight, prefetchManifest } = buildPrefetchBundle(ctx, pack, hostPolicy.capabilityHostId, hostPolicy);
      // Control-arm isolation: the projection is serialized to --json / --output,
      // both embedding preflight.memoryFreshnessPack; redact it by the arm (the
      // manifest is redacted inside buildHostDispatchPrefetchManifest; the text
      // render omits via shouldRenderRuntimeMemoryPack).
      const safePreflight = preflight.memoryFreshnessPack
        ? { ...preflight, memoryFreshnessPack: redactMemoryPackForControlArm(preflight.memoryFreshnessPack) }
        : preflight;
      const result = buildHostDispatchProjection(pack, {
        host: hostPolicy.capabilityHostId,
        mode: args.mode,
        preflight: safePreflight,
        prefetchManifest,
      });
      if (args.output) {
        const outputPath = resolve(process.cwd(), args.output);
        writeJsonNoOverwrite(outputPath, result);
      }
      if (wantsJson(args)) return result;
      const outputNote = args.output ? `\noutput: ${args.output}` : '';
      return [renderHostDispatchProjectionText(result), outputNote.trimEnd()].filter(Boolean).join('\n');
    },
  };
}
