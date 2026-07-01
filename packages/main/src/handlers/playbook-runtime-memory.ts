import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { loadConfig } from '../core/config.js';
import {
  generatePlaybookRuntimeBaseline,
  verifyPlaybookRuntimeBaseline,
  type PlaybookRuntimeBaselineProfile,
} from '../core/playbook-runtime-baseline.js';
import {
  buildMemoryFreshnessPack,
  evaluateRuntimeMemoryConsumerPolicy,
  renderMemoryFreshnessPackSummary,
} from '../core/playbook-runtime-memory.js';
import { isCanonicalStoryId } from '../core/lifecycle-registry.js';
import type { HandlerContext } from './context.js';

type FormatArgs = { format?: 'text' | 'json'; json?: boolean };
type FinishDecision = 'captured' | 'no-reusable-lesson' | 'defer-with-reason';

function wantsJson(args?: FormatArgs): boolean {
  return args?.json === true || args?.format === 'json';
}

function asProfile(value: unknown): PlaybookRuntimeBaselineProfile {
  return value === 'full' ? 'full' : 'small';
}

function renderBaselineGenerate(result: ReturnType<typeof generatePlaybookRuntimeBaseline>): string {
  return [
    'Memory/playbook baseline generated',
    `profile: ${result.manifest.profile}`,
    `recordCount: ${result.manifest.recordCount}`,
    `fullProfileExactMillion: ${result.manifest.fullProfileExactMillion}`,
    `manifestDigest: ${result.manifest.manifestDigest}`,
    `outputDir: ${result.outputDir}`,
    `authority: ${result.manifest.authority}`,
    `gateEvidence: ${result.manifest.gateEvidence}`,
  ].join('\n');
}

function renderBaselineVerify(result: ReturnType<typeof verifyPlaybookRuntimeBaseline>): string {
  return [
    'Memory/playbook baseline verifier',
    `status: ${result.status}`,
    `profile: ${result.profile}`,
    `recordCount: ${result.recordCount}`,
    `fullProfileExactMillion: ${result.fullProfileExactMillion}`,
    `recordsDigestStable: ${result.recordsDigestStable}`,
    `goldDigestStable: ${result.goldDigestStable}`,
    `manifestDigestStable: ${result.manifestDigestStable}`,
    `staleDetected: ${result.staleDetected}`,
    `expectedIdsFoundRate: ${result.correctness.expectedIdsFoundRate}`,
    `currentOverSupersededPreferenceRate: ${result.correctness.currentOverSupersededPreferenceRate}`,
    `candidateFalseSurfaceRate: ${result.correctness.candidateFalseSurfaceRate}`,
    `supersededFalseSurfaceRate: ${result.correctness.supersededFalseSurfaceRate}`,
    `deprecatedFalseSurfaceRate: ${result.correctness.deprecatedFalseSurfaceRate}`,
    `malformedRowsSkipped: ${result.correctness.malformedRowsSkipped}`,
    `elapsedMs: ${result.performance.elapsedMs}`,
    `peakRssBytes: ${result.performance.peakRssBytes}`,
    `peakHeapUsedBytes: ${result.performance.peakHeapUsedBytes}`,
    `authority: ${result.authority}`,
    `gateEvidence: ${result.gateEvidence}`,
  ].join('\n');
}

function configuredRequiredClasses(ctx: HandlerContext): string[] {
  const config = loadConfig(ctx.root) as ReturnType<typeof loadConfig> & {
    runtimeMemory?: { requiredClasses?: string[] };
    requiredRuntimeMemoryClasses?: string[];
  };
  const values = config.runtimeMemory?.requiredClasses ?? config.requiredRuntimeMemoryClasses ?? [];
  return values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function fileContains(root: string, rel: string, pattern: RegExp): boolean {
  try {
    return pattern.test(readFileSync(join(root, rel), 'utf8'));
  } catch {
    return false;
  }
}

function buildRuntimeHealth(ctx: HandlerContext) {
  const requiredClasses = configuredRequiredClasses(ctx);
  const requiredChecks = requiredClasses.map((requiredClass) => {
    const pack = buildMemoryFreshnessPack({
      projectRoot: ctx.root,
      consumer: 'session_brief',
      query: requiredClass,
      maxEntries: 3,
      maxPlaybooks: 3,
      maxLines: 60,
    });
    return {
      id: `required-class:${requiredClass}`,
      status: pack.results.devMemoryEntryIds.length + pack.results.playbookIds.length > 0 ? 'pass' as const : 'fail' as const,
      packDigest: pack.packDigest,
      topHitIds: [...pack.results.playbookIds, ...pack.results.devMemoryEntryIds],
      authority: pack.authority,
      gateEvidence: pack.gateEvidence,
    };
  });
  const wiringChecks = ([
    ['src/handlers/session.ts', /buildMemoryFreshnessPack[\s\S]*renderMemoryFreshnessPack/],
    ['src/handlers/lattice-handoff.ts', /buildMemoryFreshnessPack[\s\S]*renderMemoryFreshnessPack/],
    ['src/handlers/story-create.ts', /Runtime memory STORY_INTAKE advisory only[\s\S]*renderMemoryFreshnessPack/],
    ['src/handlers/transition-orchestrator.ts', /buildMemoryFreshnessPack[\s\S]*Runtime memory advisory \(not gate evidence\)/],
    ['src/handlers/done-closure.ts', /buildMemoryFreshnessPack[\s\S]*Advisory memory considered/],
    ['src/handlers/done-prepare.ts', /renderMemoryFreshnessPackSummary[\s\S]*Advisory memory considered/],
    ['src/handlers/playbook-runtime-memory.ts', /final_response_check[\s\S]*completionClaimSource[\s\S]*ParentRollupResult\/current-structured-facts/],
  ] as Array<[string, RegExp]>).map(([rel, pattern]) => ({
    id: `consumer-wiring:${rel}`,
    status: fileContains(ctx.scanRoot, rel, pattern) ? 'pass' as const : 'fail' as const,
  }));
  const smallBaseline = verifyPlaybookRuntimeBaseline({ profile: 'small' });
  const checks = [
    ...requiredChecks,
    ...wiringChecks,
    {
      id: 'baseline-small',
      status: smallBaseline.status,
      recordCount: smallBaseline.recordCount,
      authority: smallBaseline.authority,
      gateEvidence: smallBaseline.gateEvidence,
    },
  ];
  return {
    schemaVersion: 'proofbound.playbook-runtime-health.v1',
    status: checks.every((check) => check.status === 'pass') ? 'pass' as const : 'fail' as const,
    requiredClasses,
    checks,
    authority: 'non_authoritative' as const,
    gateEvidence: false as const,
  };
}

function renderHealth(report: ReturnType<typeof buildRuntimeHealth>): string {
  const lines = [
    'Playbook runtime health',
    `status: ${report.status}`,
    `requiredClasses: ${report.requiredClasses.join(', ') || 'none'}`,
    `authority: ${report.authority}`,
    `gateEvidence: ${report.gateEvidence}`,
    'checks:',
  ];
  for (const check of report.checks) {
    lines.push(`  - ${check.id}: ${check.status}`);
  }
  return lines.join('\n');
}

function finishDecisionStoryId(storyId?: string): { recordStoryId?: string; pathSegment: string } {
  const trimmed = storyId?.trim();
  if (!trimmed) return { pathSegment: 'no-story' };
  if (!isCanonicalStoryId(trimmed)) {
    throw new Error(
      `dev_memory_finish_decision: invalid storyId ${JSON.stringify(storyId)}; ` +
      'must be a canonical, path-safe Proofbound story id',
    );
  }
  return { recordStoryId: trimmed, pathSegment: trimmed };
}

function finishDecisionPath(root: string, pathSegment: string): string {
  return join(root, '.lattice', 'dev-memory', 'finish-decisions', `${pathSegment}.json`);
}

function normalizeDecision(value: unknown): FinishDecision {
  if (value === 'captured' || value === 'no-reusable-lesson' || value === 'defer-with-reason') return value;
  throw new Error('dev_memory_finish_decision requires decision=captured|no-reusable-lesson|defer-with-reason');
}

export function createPlaybookRuntimeMemoryHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  return {
    memory_playbook_baseline_generate(args: {
      profile?: PlaybookRuntimeBaselineProfile;
      outputDir?: string;
      seed?: number;
      force?: boolean;
    } & FormatArgs = {}) {
      const result = generatePlaybookRuntimeBaseline({
        profile: asProfile(args.profile),
        outputDir: args.outputDir,
        seed: args.seed,
        force: args.force,
      });
      return wantsJson(args) ? result : renderBaselineGenerate(result);
    },

    memory_playbook_baseline_verify(args: {
      profile?: PlaybookRuntimeBaselineProfile;
      inputDir?: string;
      seed?: number;
    } & FormatArgs = {}) {
      const result = verifyPlaybookRuntimeBaseline({
        profile: asProfile(args.profile),
        inputDir: args.inputDir,
        seed: args.seed,
      });
      return wantsJson(args) ? result : renderBaselineVerify(result);
    },

    playbook_runtime_health(args: FormatArgs = {}) {
      const report = buildRuntimeHealth(ctx);
      return wantsJson(args) ? report : renderHealth(report);
    },

    dev_memory_finish_decision(args: {
      storyId?: string;
      decision: FinishDecision;
      reason?: string;
      capturedEntryIds?: string[] | string;
    } & FormatArgs) {
      const decision = normalizeDecision(args.decision);
      const reason = args.reason?.trim() ?? '';
      if ((decision === 'no-reusable-lesson' || decision === 'defer-with-reason') && reason.length < 5) {
        throw new Error(`${decision} requires a concrete reason`);
      }
      const safeStory = finishDecisionStoryId(args.storyId);
      const capturedEntryIds = Array.isArray(args.capturedEntryIds)
        ? args.capturedEntryIds
        : typeof args.capturedEntryIds === 'string' && args.capturedEntryIds.trim().length > 0
          ? args.capturedEntryIds.split(',').map((value) => value.trim()).filter(Boolean)
          : [];
      const record = {
        schemaVersion: 'proofbound.dev-memory-finish-decision.v1',
        storyId: safeStory.recordStoryId,
        decision,
        reason,
        capturedEntryIds,
        automaticPromotion: false,
        authority: 'non_authoritative' as const,
        gateEvidence: false as const,
        recordedAt: new Date().toISOString(),
      };
      const path = finishDecisionPath(ctx.root, safeStory.pathSegment);
      if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      if (wantsJson(args)) return { path, record };
      return [
        'Dev-memory finish decision recorded',
        `path: ${path}`,
        `decision: ${decision}`,
        `automaticPromotion: ${record.automaticPromotion}`,
        `authority: ${record.authority}`,
        `gateEvidence: ${record.gateEvidence}`,
      ].join('\n');
    },

    final_response_check(args: { storyId?: string; claim?: string } & FormatArgs = {}) {
      const story = args.storyId ? ctx.store.readStory(args.storyId) : undefined;
      const pack = buildMemoryFreshnessPack({
        projectRoot: ctx.root,
        consumer: 'final_response_check',
        storyPhase: story?.phase,
        query: [
          args.claim ?? '',
          story?.title ?? '',
          story?.description ?? '',
          'final response intent-totality delivery ParentRollupResult current structured facts memory non-authoritative',
        ].join('\n'),
        maxEntries: 5,
        maxPlaybooks: 5,
        maxLines: 60,
      });
      const result = {
        schemaVersion: 'proofbound.final-response-check.v1',
        storyId: args.storyId,
        completionClaimSource: 'ParentRollupResult/current-structured-facts' as const,
        memoryFreshnessPack: pack,
        memoryCompletionProof: false as const,
        policy: evaluateRuntimeMemoryConsumerPolicy({ consumer: 'final_response_check' }),
        authority: 'non_authoritative' as const,
        gateEvidence: false as const,
      };
      if (wantsJson(args)) return result;
      return [
        'Final response advisory check',
        `completionClaimSource: ${result.completionClaimSource}`,
        'memoryCompletionProof: false',
        ...renderMemoryFreshnessPackSummary(pack).split('\n'),
        `authority: ${result.authority}`,
        `gateEvidence: ${result.gateEvidence}`,
      ].join('\n');
    },
  };
}
