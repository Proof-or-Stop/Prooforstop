
import type { HandlerContext } from './context.js';
import { collectContext, nextStoryId } from './context.js';
import type { ChecklistData, ScopeBoundaryMode, StoryInfo, StoryPhase, StoryType, VerificationIntent } from '../core/types.js';
import { validateBackground } from '../core/background-validator.js';
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, realpathSync } from 'fs';
import { join, relative, isAbsolute } from 'path';
import { createHash } from 'crypto';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import { createSafeInitCommitOnHead } from '../core/safe-init-commit.js';
import { computeDraftCheckHash } from '../core/draft-check-hash.js';
import { computeChecklistHash } from './init-check.js';
import { isGitRepository } from '../core/git-probe.js';
import { withReentrantMainWriteLock } from '../core/main-write-lock.js';
import { resolveMainRepoRoot } from '../core/partial-done-recovery.js';
import { normalizeName, keywordOverlap } from '../core/story-dedup.js';
import { buildExecutionBoundary, buildScopeBoundary, normalizeBoundaryArray, scanExcludedKeywordHits } from '../core/scope-anti-expansion.js';
import type { ScopeFreezeTextSource } from '../core/types.js';
import { evaluateStoryDirConfigInsideGitRoot } from '../core/story-signed-workspace-resolution.js';
import {
  assertEnglishAuthoringText,
  type EnglishAuthoringTextSource,
} from './english-artifact-gate.js';
import {
  classifyReproFirstRequirement,
  resolveReproFirstPreflightMode,
} from '../core/repro-evidence-binding-gate.js';
import { buildMemoryFreshnessPack, renderMemoryFreshnessPack } from '../core/playbook-runtime-memory.js';
import { surfaceRuntimeMemoryPack } from '../core/experience-pack-surface.js';

type StoryCreateScopeBoundaryInput = {
  mode?: ScopeBoundaryMode;
  allowed?: string[];
  allowedScope?: string[];
  excluded?: string[];
  excludedScope?: string[];
  userConfirmed?: boolean;
  confirmation?: string;
  actor?: string;
};

type StoryCreateExecutionBoundaryInput = {
  allowedCommands?: string[];
  allowedTools?: string[];
  allowedPaths?: string[];
  excludedCommands?: string[];
  excludedTools?: string[];
  excludedPaths?: string[];
  blockedPaths?: string[];
  confirmation?: string;
  actor?: string;
};

type StoryCreateChecklistInput = {
  title: string;
  context?: string;
  relatedDocs?: string[];
  userSees?: string;
  excludes?: string[];
  files?: { modify?: string[]; create?: string[]; test?: string[] };
  verificationIntent?: VerificationIntent;
  phase?: 'DEV' | 'TEST_CASE';
};

type NormalizedStoryCreateFiles = { modify: string[]; create: string[]; test: string[] };

function normalizeStoryCreateFiles(files?: StoryCreateChecklistInput['files']): NormalizedStoryCreateFiles | undefined {
  if (!files) return undefined;
  const normalized = {
    modify: Array.isArray(files.modify) ? files.modify : [],
    create: Array.isArray(files.create) ? files.create : [],
    test: Array.isArray(files.test) ? files.test : [],
  };
  return normalized.modify.length > 0 || normalized.create.length > 0 || normalized.test.length > 0
    ? normalized
    : undefined;
}

function isPreLifecycleStoryCreatePhase(phase: StoryPhase): boolean {
  return phase === 'IDEA' || phase === 'INIT';
}

function renderReproFirstStoryCreatePreflight(args: {
  projectRoot: string;
  storyId: string;
  name: string;
  title: string;
  description: string;
  type: StoryType;
  phase: StoryPhase;
  priority: string;
  riskSignals?: StoryInfo['riskSignals'];
  checklist: ChecklistData;
  bypassReason?: string;
}): string {
  const mode = resolveReproFirstPreflightMode(args.projectRoot);
  if (mode === 'off') return '';
  const candidateStory = {
    storyId: args.storyId,
    name: args.name,
    title: args.title,
    description: args.description,
    type: args.type,
    phase: args.phase,
    priority: args.priority,
    ...(args.riskSignals && args.riskSignals.length > 0 ? { riskSignals: args.riskSignals } : {}),
    createdAt: new Date().toISOString(),
    startedAt: args.phase === 'IDEA' ? null : new Date().toISOString(),
    endedAt: null,
    events: [],
  } as StoryInfo;
  const classification = classifyReproFirstRequirement(candidateStory, args.checklist);
  if (!classification.required) return '';
  const bypassReason = args.bypassReason?.trim();
  if (bypassReason) {
    if (!isPreLifecycleStoryCreatePhase(args.phase)) {
      throw new Error(
        `reproFirstBypassReason cannot create repro-first-required story ${args.storyId} directly in phase ${args.phase}. ` +
        `Create it in IDEA/INIT, then satisfy the normal lifecycle gates with a valid story-evidence-binding. ` +
        `[repro_first_bypass_direct_phase_forbidden]\n` +
        `  classifier: ${classification.reason}; ${classification.details.join('; ')}`,
      );
    }
    return [
      '⚠ Repro-first STORY_INTAKE preflight bypassed with explicit reason. [repro_first_bypassed]',
      `  reason: ${bypassReason}`,
      `  classifier: ${classification.reason}; ${classification.details.join('; ')}`,
      '  Note: this only permits story creation; PLAN/DEV gates still require a valid story-evidence-binding when the story declares code files.',
    ].join('\n');
  }
  const message = [
    `Repro-first STORY_INTAKE preflight requires accepted repro evidence before creating code-verifiable story ${args.storyId}. [missing_story_evidence_binding]`,
    `  mode: ${mode}`,
    `  classifier: ${classification.reason}; ${classification.details.join('; ')}`,
    '  Use story_create_from_repro after repro_probe + repro_review_set(red-reviewed,target-bug), or pass reproFirstBypassReason for a documented emergency/non-reproducible IDEA/INIT intake exception.',
  ].join('\n');
  if (mode === 'enforce') throw new Error(message);
  return `⚠ ${message}`;
}

function renderStoryCreateMemoryRuntimeAdvisory(args: {
  projectRoot: string;
  storyId: string;
  title: string;
  description: string;
  phase: StoryPhase;
  checklist: ChecklistData;
}): string {
  try {
    const checklistText = args.checklist.items.map((item) => `${item.id} ${item.title} ${item.context ?? ''}`).join('\n');
    // B-ab8d CHK-002: experiment-arm render gate. The pack is ALWAYS computed
    // and the experience_pack_surfaced event fires on both arms; only the
    // rendered section is hidden on control (no experiment = pass-through).
    const surfaced = surfaceRuntimeMemoryPack(args.projectRoot, {
      consumer: 'story_create',
      storyId: args.storyId,
      roundKey: args.phase,
      buildPack: () => buildMemoryFreshnessPack({
        projectRoot: args.projectRoot,
        consumer: 'story_create',
        storyPhase: args.phase,
        query: [
          `story:${args.storyId}`,
          args.title,
          args.description,
          checklistText,
          'story intake repro-first stale-doc truth-first playbook runtime memory non-authoritative',
        ].filter(Boolean).join('\n'),
        maxEntries: 5,
        maxPlaybooks: 5,
        maxLines: 60,
      }),
    });
    if (!surfaced.shouldRender) return '';
    return [
      '⚠ Runtime memory STORY_INTAKE advisory only; it is not gate evidence and cannot satisfy DONE.',
      renderMemoryFreshnessPack(surfaced.pack),
    ].join('\n');
  } catch {
    return '';
  }
}

/**
 * B-6812 F-003: typed error raised when a keyword-full-overlap duplicate of an
 * ACTIVE non-terminal story is detected. The idempotency loop's catch block
 * must distinguish "this is the duplicate-guard rejection, re-throw it" from
 * "reading some unrelated story failed, swallow it" — a brittle
 * `message.startsWith(...)` prefix check silently changes behavior the moment
 * the message wording is edited and would also swallow genuine read failures
 * (OOM / fs permission) that happen to start with the same text. An
 * `instanceof` check on a dedicated class is wording-independent and only ever
 * matches the intentional rejection.
 */
export class DuplicateStoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicateStoryError';
  }
}

/**
 * High-risk keyword detection (deliberate-mode style).
 * Automatically elevate priority + write riskSignals when any pattern matches.
 * When story_review sees riskSignals, it mandates decision.json + ≥3 preMortem (takes effect after decision 3 lands).
 */
const HIGH_RISK_PATTERNS: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /\b(auth|authn|authz|security|password|token|secret|credential)\b|(?:\u5bc6\u7801|\u53e3\u4ee4|\u51ed\u636e|\u79d8\u94a5|\u5bc6\u94a5|\u9274\u6743|\u8ba4\u8bc1|\u6388\u6743|\u6743\u9650|\u5b89\u5168)/iu, category: 'Security/Credentials' },
  { pattern: /\b(migration|schema migration|destructive|drop\s+table|truncate)\b|(?:\u6570\u636e\u8fc1\u79fb|\u6570\u636e\u5e93\u8fc1\u79fb|\u8fc1\u79fb|\u8868\u7ed3\u6784|\u7834\u574f\u6027|\u5220\u5e93|\u5220\u8868|\u6e05\u8868|\u6e05\u7a7a\u6570\u636e|\u6e05\u7a7a\u8868|\u622a\u65ad)/iu, category: 'Data Migration/Destructive' },
  { pattern: /\b(machine\.ts|state machine|phase flow|story_advance|DONE gate|TEST gate|guard logic)\b|(?:\u72b6\u6001\u673a|\u72b6\u6001\u6d41|\u9636\u6bb5\u6d41|\u9636\u6bb5\u6d41\u8f6c|\u5b88\u536b\u903b\u8f91|\u95e8\u7981|\u95e8\u69db|\u95e8\u63a7|\u95f8\u95e8)/iu, category: 'State Machine/Gate' },
  { pattern: /\b(validate\.ts|lattice validate|lattice validate|validation protocol|verifier|fixture runner|test\s*runner|test_auto)\b|(?:\u9a8c\u8bc1\u6846\u67b6|\u6821\u9a8c\u6846\u67b6|\u9a8c\u8bc1\u534f\u8bae|\u9a8c\u8bc1\u95e8\u7981|\u9a8c\u8bc1\u95e8\u69db|\u6d4b\u8bd5\u8fd0\u884c\u5668|fixture\s*\u8fd0\u884c\u5668|\u81ea\u52a8\u6d4b\u8bd5)/iu, category: 'Validation Framework' },
  { pattern: /\b(git\s+(restore|reset|clean|push --force))\b|(?:git\s*(?:\u6062\u590d|\u91cd\u7f6e|\u6e05\u7406|\u5f3a\u63a8)|\u5f3a\u5236\u63a8\u9001|\u7834\u574f\u6027\s*git)/iu, category: 'git Destructive Operation' },
  { pattern: /\b(production|incident|hotfix|p0|p1)\b|(?:\u751f\u4ea7\u73af\u5883|\u751f\u4ea7\u4e8b\u6545|\u751f\u4ea7|\u7ebf\u4e0a|\u4e8b\u6545|\u7d27\u6025|\u7d27\u6025\u4fee\u590d|\u70ed\u4fee|\u70ed\u4fee\u590d)/iu, category: 'Production/Emergency' },
  { pattern: /\b(PII|personally identifiable|GDPR|compliance)\b|(?:\u9690\u79c1|\u5408\u89c4|\u4e2a\u4eba\u4fe1\u606f|\u654f\u611f\u4fe1\u606f|\u7528\u6237\u6570\u636e|\u6570\u636e\u4fdd\u62a4)/iu, category: 'Compliance/Privacy' },
  { pattern: /\b(public api|api break|breaking change)\b|(?:\u516c\u5171\s*api|\u516c\u5f00\s*api|\u516c\u5171\u63a5\u53e3|\u516c\u5f00\u63a5\u53e3|\u63a5\u53e3\u7834\u574f|\u7834\u574f\u6027\u53d8\u66f4|\u4e0d\u517c\u5bb9\u53d8\u66f4|\u517c\u5bb9\u6027\u7834\u574f)/iu, category: 'Breaking API Change' },
];

function detectRiskSignals(text: string): Array<{ category: string; matched: string }> {
  const hits: Array<{ category: string; matched: string }> = [];
  const seen = new Set<string>();
  for (const { pattern, category } of HIGH_RISK_PATTERNS) {
    const m = text.match(pattern);
    if (m && !seen.has(category)) {
      hits.push({ category, matched: m[0] });
      seen.add(category);
    }
  }
  return hits;
}

function assertStoryCreateExplicitExcludes(args: {
  title: string;
  description: string;
  checklist?: Array<{ title: string; context?: string; excludes?: string[] }>;
  scopeBoundary?: StoryCreateScopeBoundaryInput;
}): void {
  const explicitExcludedTerms = normalizeBoundaryArray([
    ...(args.checklist?.flatMap(item => item.excludes ?? []) ?? []),
    ...(args.scopeBoundary?.excluded ?? []),
    ...(args.scopeBoundary?.excludedScope ?? []),
  ]);
  if (explicitExcludedTerms.length === 0) return;

  const sources: ScopeFreezeTextSource[] = [
    { source: 'story.title', text: args.title },
    { source: 'story.description', text: args.description },
  ];
  for (const [index, item] of (args.checklist ?? []).entries()) {
    const itemId = `CHK-${String(index + 1).padStart(3, '0')}`;
    sources.push({ source: 'checklist.title', text: item.title, itemId });
    if (item.context) sources.push({ source: 'checklist.context', text: item.context, itemId });
    for (const excluded of item.excludes ?? []) {
      sources.push({ source: 'checklist.excludes', text: excluded, itemId, excluded: true });
    }
  }

  const hit = scanExcludedKeywordHits(sources, explicitExcludedTerms).find(item => !item.excluded);
  if (!hit) return;
  const itemRef = hit.itemId ? ` (${hit.itemId})` : '';
  throw new Error(
    `story_create text includes explicitly excluded scope keyword "${hit.keyword}" in ${hit.source}${itemRef}. [excluded_keyword_in_story_create]\n` +
    `→ Move excluded directions into checklist.excludes only, or create a scope_extension_proposal after INIT review.`,
  );
}

/**
 * Refine the offending field name for a 1-based line in background content by
 * naming the enclosing "## Section", so the early refusal points at the section
 * the author must fix. Mirrors the background.ts helper.
 */
function backgroundFieldForLine(content: string, line: number): string {
  const lines = content.split(/\r?\n/);
  let section: string | null = null;
  for (let i = 0; i < Math.min(line, lines.length); i++) {
    const match = lines[i].match(/^##\s+(.+?)\s*$/);
    if (match) section = match[1].trim();
  }
  return section ? `background (${section})` : 'background';
}

/**
 * Collect the ordered list of AUTHOR-controlled text fields scanned by the
 * shift-left English-only check: title, description, background, and each
 * checklist item's title / context / userSees. NEVER includes code, scope
 * boundaries, or runtime artifacts — only author prose. Both the normal and
 * the from-draft create paths feed their (differently shaped) inputs through
 * this so the refusal coverage is identical.
 */
function storyCreateAuthoringFields(args: {
  title?: unknown;
  description?: unknown;
  background?: unknown;
  checklist?: unknown;
}): EnglishAuthoringTextSource[] {
  const fields: EnglishAuthoringTextSource[] = [
    { field: 'title', text: args.title },
    { field: 'description', text: args.description },
  ];
  if (typeof args.background === 'string') {
    const background = args.background;
    fields.push({
      field: 'background',
      text: background,
      fieldForLine: (line) => backgroundFieldForLine(background, line),
    });
  }
  if (Array.isArray(args.checklist)) {
    args.checklist.forEach((item: { title?: unknown; context?: unknown; userSees?: unknown }, index: number) => {
      const itemRef = `checklist[${index + 1}]`;
      fields.push({ field: `${itemRef}.title`, text: item?.title });
      fields.push({ field: `${itemRef}.context`, text: item?.context });
      fields.push({ field: `${itemRef}.userSees`, text: item?.userSees });
    });
  }
  return fields;
}

/**
 * B-6812 CHK-003 (G4): how far back the "recently created concurrent story"
 * scan looks. Hardcoded constant on purpose — exposing it as a config option
 * would add a knob nobody tunes (YAGNI). 30 minutes is long enough to surface
 * a parallel agent racing the same backlog, short enough not to spam noise
 * from unrelated earlier work in the same session.
 */
const RECENT_CONCURRENT_WINDOW_MS = 30 * 60 * 1000;

/**
 * B-6812 CHK-003 (G4): after a successful create, scan for OTHER stories
 * created within the last 30 minutes that are still active (phase ∉
 * DONE/DISCARDED). If any exist, the operator likely has a parallel agent
 * working the same backlog — surface the list on stderr so it is visible even
 * under a `lattice story_create | tail` pipe. Returns '' when nothing matches so
 * the caller never emits a false-positive line.
 *
 * `justCreatedId` is excluded so the freshly minted story does not list
 * itself. Unreadable / malformed story index files are skipped silently — one
 * corrupt index must not crash a successful create.
 */
function recentConcurrentStoriesNote(
  store: HandlerContext['store'],
  justCreatedId: string,
  nowMs: number,
): string {
  const recent: Array<{ id: string; phase: string; title: string }> = [];
  for (const sid of store.listStoryIds()) {
    if (sid === justCreatedId) continue;
    try {
      const other = store.readStory(sid);
      if (other.phase === 'DONE' || other.phase === 'DISCARDED') continue;
      const createdMs = Date.parse(other.createdAt);
      if (!Number.isFinite(createdMs)) continue;
      // Strictly within the window: createdMs must be at or after the cutoff
      // and not in the future relative to `nowMs`.
      if (createdMs < nowMs - RECENT_CONCURRENT_WINDOW_MS || createdMs > nowMs) continue;
      recent.push({ id: sid, phase: other.phase, title: other.title });
    } catch {
      /* ignore unreadable story */
    }
  }
  if (recent.length === 0) return '';
  const lines = [`⚠ ${recent.length} other stories were also created within the last 30 minutes:`];
  for (const r of recent) {
    lines.push(`  - ${r.id} [${r.phase}] ${r.title}`);
  }
  return lines.join('\n');
}

/**
 * B-6812 F-004: scan for DONE / DISCARDED (terminal) stories whose keyword set
 * FULLY overlaps the new story's keywords (ratio === 1 && shared >= 2). Active
 * non-terminal full overlap hard-blocks the create; terminal full overlap is
 * non-blocking but still worth surfacing — finishing a same-domain story is a
 * useful FYI ("you may be redoing work that just shipped"). plan.md CHK-002
 * and AGENTS.md both promise this warn, so the code must actually emit it
 * (silently `continue`-ing a terminal story produced zero output → doc drift).
 *
 * Returns '' when nothing matches so the caller never prints a blank line.
 * Unreadable / malformed story index files are skipped silently.
 */
function terminalKeywordOverlapNote(
  store: HandlerContext['store'],
  newKeywords: string[],
): string {
  if (newKeywords.length === 0) return '';
  const hits: Array<{ id: string; phase: string; title: string; shared: string[] }> = [];
  for (const sid of store.listStoryIds()) {
    try {
      const other = store.readStory(sid);
      if (other.phase !== 'DONE' && other.phase !== 'DISCARDED') continue;
      const overlap = keywordOverlap(newKeywords, other.keywords ?? []);
      if (overlap.ratio === 1 && overlap.shared.length >= 2) {
        hits.push({ id: sid, phase: other.phase, title: other.title, shared: overlap.shared });
      }
    } catch {
      /* ignore unreadable story */
    }
  }
  if (hits.length === 0) return '';
  const lines = ['⚠ keyword fully overlaps with completed story (advisory only, does not block creation):'];
  for (const h of hits) {
    lines.push(`  - ${h.id} [${h.phase}] ${h.title} (shared keywords: ${h.shared.join(', ')})`);
  }
  return lines.join('\n');
}

/**
 * B-198c CHK-003: build the one-line "storyDir resolves outside the resolved
 * gitRoot" advisory, or '' when there is nothing to warn about.
 *
 * Reuses the id-independent CHK-002 helper {@link evaluateStoryDirConfigInsideGitRoot}
 * (DO NOT re-derive the check). WARN-ONLY by design (decision Option A): the
 * git-backed worktree/DONE lifecycle would later hard-fail at INIT_CHECK when
 * story metadata cannot be committed inside the gitRoot — surfacing it early
 * saves the user the INIT/PLAN investment, but must NOT block story creation.
 *
 * Only the `outside-gitroot` violation produces text. `ok=true` (inside, the
 * normal case) and `reason='gitroot-unresolved'` (no/invalid gitRoot — e.g. a
 * non-git metadata root with no configured gitRoot) both stay silent so the
 * advisory never nags healthy or not-yet-git-backed setups. Never throws — the
 * underlying helper is total, and a defensive try/catch here matches the
 * session_brief advisory's parity guard so story_create can never fail on
 * advisory-render error.
 */
export function storyDirOutsideGitRootAdvisory(metadataRoot: string): string {
  try {
    const result = evaluateStoryDirConfigInsideGitRoot({ metadataRoot });
    if (result.ok || result.reason !== 'outside-gitroot') return '';
    return (
      `⚠ storyDir resolves outside the resolved gitRoot ` +
      `(${result.storyDirAbs} not inside ${result.gitRootAbs}); ` +
      `the worktree/DONE git lifecycle will fail at INIT_CHECK. ` +
      `→ configure storyDir so story metadata lives inside the gitRoot.`
    );
  } catch {
    // Defensive: never block story_create on advisory-render failure.
    return '';
  }
}

export function createStoryCreateHandlers(ctx: HandlerContext) {
  const { store } = ctx;

  return {
    story_create(args: {
      name: string;
      title: string;
      description: string;
      type: StoryType;
      priority: string;
      source?: string;
      depends?: string[];
      keywords?: string[];
      checklist?: StoryCreateChecklistInput[];
      scopeBoundary?: StoryCreateScopeBoundaryInput;
      executionBoundary?: StoryCreateExecutionBoundaryInput;
      prefix?: string;
      phase?: StoryPhase;
      forceNew?: boolean; // B-0af4 CHK-001: bypass idempotency and force new creation
      background?: string; // B-45ed CHK-006: required four-section background.md content
      fromDraft?: string; // B-9975 CHK-003: from-draft mode
      reproFirstBypassReason?: string; // Allows story_create_from_repro/emergency intake to create the envelope before binding exists.
    }): string {
      // B-6812 CHK-001 / B-f60c CHK-003: serialize the whole story_create body
      // (fromDraft branch + normal branch) so the idempotency scan →
      // nextStoryId → writeStory → writeChecklist sequence is atomic against
      // concurrent story_create invocations (closes the G1 TOCTOU window).
      //
      // B-f60c CHK-003: story_create writes shared main metadata, so per
      // session-ownership-and-write-leases.md it must serialize on the unified
      // MAIN WRITE LOCK (Rule 5) — not the former story-dir-scoped
      // `.create.lock`. The unified lock subsumes the old lock's job: every
      // concurrent story_create still contends on one directory, the dedup
      // scan still runs strictly inside the lock. The lock is reentrant so a
      // future shared-write command that nests story_create cannot self-
      // deadlock. Lock path resolves to the main repo root via
      // resolveMainRepoRoot (a worktree subdir falls back to the main root).
      const createLockMainRepoRoot = resolveMainRepoRoot(ctx.root);
      return withReentrantMainWriteLock(createLockMainRepoRoot, () => {
      // B-02a6 CHK-002: after a story's INIT metadata has been persisted to
      // disk, commit ONLY that story's metadata dir onto the current branch HEAD
      // so the leaf is a tracked (clean-proof) git object from birth. This runs
      // INSIDE the held main-write-lock (we are already inside the lock body), so
      // it serializes against a concurrent DONE merge / story_create. It is a
      // deliberate, scoped main-HEAD commit, NOT a relaxation of
      // auto-commit-metadata.ts's `!branch.startsWith('story/')` early-return.
      // Best-effort: never throws, so a successful create cannot fail on it.
      const commitSafeInitMetadata = (storyId: string): void => {
        try {
          // Resolve the actual git repo root the same way the bootstrap and the
          // metadata auto-commit do (handles wrapper-root layouts; plain repos
          // fall back to ctx.root). The story metadata was just written, so the
          // signed-workspace resolver can read it.
          const repoRoot = resolveGitCwd({
            store,
            storyId,
            metadataRoot: ctx.root,
            projectRoot: ctx.root,
          });
          // storyRel must be relative to the RESOLVED repo root so the scoped
          // `git add` works whether or not the metadata root is the git root.
          // Canonicalize both sides (realpath) so a /var → /private/var symlink
          // does not corrupt the relative path. When repoRoot === ctx.root this
          // equals the legacy storyDir/id.
          const storyAbs = join(ctx.root, store.storyDirRel().replace(/\/$/, ''), storyId);
          const canonicalStoryAbs = existsSync(storyAbs) ? realpathSync(storyAbs) : storyAbs;
          const canonicalRepoRoot = existsSync(repoRoot) ? realpathSync(repoRoot) : repoRoot;
          const storyRel = relative(canonicalRepoRoot, canonicalStoryAbs).replace(/\\/g, '/');
          // Story metadata outside the resolved git root cannot be committed here;
          // the worktree.ts / cli-engine reconcile guards surface that dead end at
          // INIT_CHECK. Skip silently (warn-only is owned by those guards).
          if (!storyRel || isAbsolute(storyRel) || storyRel.split('/').includes('..')) return;
          createSafeInitCommitOnHead({ storyId, storyRel, repoRoot });
        } catch {
          // Defensive: the safe-init commit is best-effort observability of a
          // durable object; a successful story_create must never fail on it.
        }
      };
      let reproFirstHint = '';
      // === B-9975 CHK-003: FROM-DRAFT MODE ===
      // When fromDraft is provided, bypass normal creation path entirely.
      if (args.fromDraft) {
        const draftName = args.fromDraft;
        const draftsDir = join(ctx.root, 'docs', 'story', 'drafts', draftName);

        // 1. Check draft exists
        if (!existsSync(draftsDir)) {
          throw new Error(`Draft '${draftName}' not found at docs/story/drafts/${draftName}/`);
        }

        // 2. Read draft files
        const draftIndex = JSON.parse(readFileSync(join(draftsDir, 'index.json'), 'utf-8'));
        const draftBg = readFileSync(join(draftsDir, 'background.md'), 'utf-8');
        const draftChecklist = JSON.parse(readFileSync(join(draftsDir, 'checklist.json'), 'utf-8'));

        // Shift-left English-only policy: refuse CJK author text from the draft
        // before any artifact is materialized, reusing the same detectCjk
        // predicate as the REVIEW->TEST gate.
        assertEnglishAuthoringText('story_create', storyCreateAuthoringFields({
          title: draftIndex.title,
          description: draftIndex.description,
          background: draftBg,
          checklist: draftChecklist.items,
        }));

        // 3. GATE 1: missing_draft_check
        const draftCheckPath = join(draftsDir, 'draft-check.json');
        if (!existsSync(draftCheckPath)) {
          throw new Error(
            `Cannot create story from draft '${draftName}': draft-check.json not found. ` +
            `Please spawn the lattice-review-story-init reviewer to review the draft and call draft_check_set first. [missing_draft_check]`
          );
        }
        const draftCheck = JSON.parse(readFileSync(draftCheckPath, 'utf-8'));

        // 4. GATE 2: draft_check_tampered
        const bgHash = createHash('sha256').update(draftBg).digest('hex');
        const clItems = draftChecklist.items.map((i: any) => ({ title: i.title, context: i.context ?? '' }));
        const clHash = computeChecklistHash(clItems);
        const expectedHash = computeDraftCheckHash(
          draftName, bgHash, draftIndex.title, draftIndex.description, clHash, draftCheck.reviewRound || ''
        );

        if (draftCheck._hash !== expectedHash) {
          throw new Error(
            `Cannot create story from draft '${draftName}': draft-check.json _hash mismatch ` +
            `(background/title/description/checklist has been modified); please rerun the reviewer. [draft_check_tampered]`
          );
        }

        // 5. GATE 3: draft_check_blocking_issues
        const blockingSeverities = ['critical', 'high'];
        const blockingIssues = (draftCheck.issues || []).filter((issue: any) =>
          blockingSeverities.includes(issue.severity) &&
          !(draftCheck.resolutions && draftCheck.resolutions[issue.id])
        );
        if (blockingIssues.length > 0) {
          const ids = blockingIssues.map((i: any) => i.id || 'unknown').join(', ');
          throw new Error(
            `Cannot create story from draft '${draftName}': ${blockingIssues.length} blocking issue(s) unresolved: ${ids}. ` +
            `Please use draft_issue_resolve to respond to each one and retry. [draft_check_blocking_issues]`
          );
        }

        // 6. All gates passed — materialize!
        const storyId = nextStoryId(store, args.prefix);
        const now = new Date().toISOString();

        // Detect risk signals from description + checklist
        const scanText = [draftIndex.description, ...draftChecklist.items.map((c: any) => c.title + ' ' + (c.context ?? ''))].join('\n');
        const riskSignals = detectRiskSignals(scanText);
        let priority = draftIndex.priority || 'medium';
        const draftOriginalPriority = priority;
        if (riskSignals.length > 0) {
          const order = ['low', 'medium', 'high', 'critical'];
          const curIdx = order.indexOf(priority);
          if (curIdx < order.indexOf('high')) priority = 'high';
        }
        // B-30b2 CHK-001: record auto-elevation source only when elevation actually changed priority.
        const draftPriorityElevatedFrom = riskSignals.length > 0 && priority !== draftOriginalPriority
          ? draftOriginalPriority
          : undefined;
        const draftType = (draftIndex.type || 'feature') as StoryType;
        const draftReproFirstHint = renderReproFirstStoryCreatePreflight({
          projectRoot: ctx.root,
          storyId,
          name: draftIndex.name,
          title: draftIndex.title,
          description: draftIndex.description,
          type: draftType,
          phase: 'INIT',
          priority,
          riskSignals,
          checklist: draftChecklist as ChecklistData,
          bypassReason: args.reproFirstBypassReason,
        });
        const draftMemoryHint = renderStoryCreateMemoryRuntimeAdvisory({
          projectRoot: ctx.root,
          storyId,
          title: draftIndex.title,
          description: draftIndex.description,
          phase: 'INIT',
          checklist: draftChecklist as ChecklistData,
        });

        // Write story to actives
        const story: StoryInfo = {
          storyId,
          name: draftIndex.name,
          title: draftIndex.title,
          description: draftIndex.description,
          type: draftType,
          phase: 'INIT' as StoryPhase,
          priority,
          ...(draftIndex.keywords?.length > 0 ? { keywords: draftIndex.keywords } : {}),
          ...(riskSignals.length > 0 ? { riskSignals } : {}),
          ...(draftPriorityElevatedFrom !== undefined ? { priorityElevatedFrom: draftPriorityElevatedFrom } : {}),
          createdAt: now,
          startedAt: now,
          endedAt: null,
          events: [collectContext('INIT', 'create')],
        };
        store.writeStory(storyId, story);

        // Write background.md
        const storyDir = store.storyDirPath(storyId);
        if (!existsSync(storyDir)) mkdirSync(storyDir, { recursive: true });
        const bgContent = draftBg.endsWith('\n') ? draftBg : draftBg + '\n';
        writeFileSync(join(storyDir, 'background.md'), bgContent, 'utf-8');

        // Write checklist.json (reuse draft's checklist items)
        store.writeChecklist(storyId, draftChecklist);

        // Delete draft directory
        rmSync(draftsDir, { recursive: true, force: true });

        // B-02a6 CHK-002: make the freshly written INIT metadata a tracked
        // clean-proof git object on the current branch HEAD (inside the lock).
        commitSafeInitMetadata(storyId);

        // B-198c CHK-003: early storyDir-outside-gitRoot advisory (warn-only,
        // Option A) — also surface on the from-draft create surface so the
        // dead end is visible regardless of which create path was taken.
        const draftStoryDirNote = storyDirOutsideGitRootAdvisory(ctx.root);
        if (draftReproFirstHint.trim().length > 0) {
          process.stderr.write(draftReproFirstHint.trim() + '\n');
        }
        if (draftMemoryHint.trim().length > 0) {
          process.stderr.write(draftMemoryHint.trim() + '\n');
        }
        if (draftStoryDirNote.length > 0) {
          process.stderr.write(draftStoryDirNote + '\n');
        }

        return `Story ${storyId} created from draft '${draftName}' (INIT)\n→ draft '${draftName}' deleted\n→ run the normal INIT reviewer and scope anti-expansion gates, then story_advance '{"storyId":"${storyId}","phase":"INIT_CHECK"}'`;
      }

      // Shift-left English-only policy: refuse CJK in any author-provided field
      // (title / description / background / checklist text) BEFORE idempotency
      // resolution or any persistence, reusing the same detectCjk predicate as
      // the REVIEW->TEST english-artifact gate. Missing background still follows
      // the existing idempotency behavior below (reuse returns without touching
      // background); this only refuses non-English text that IS supplied.
      assertEnglishAuthoringText('story_create', storyCreateAuthoringFields(args));

      // B-45ed CHK-006: background is required + four-section validation.
      // Only enforce strict validation on the "new story" path; the idempotency-reuse branch does not need background.
      // We check idempotency first (see below); if reusing an existing story, return without touching background.
      // The new-creation branch (after passing idempotency) performs hard validation + persistence on background.
      // B-0af4 CHK-001 / B-6812 CHK-002: Idempotency check — when a semantically duplicate
      // story that is not DONE/DISCARDED exists, return the existing storyId (or hard-block on full keyword overlap),
      // rather than silently creating a duplicate. LLMs running across session rounds / multiple agents running the same backlog concurrently
      // easily create duplicates; this guard prevents duplicate pollution. forceNew=true bypasses the entire check.
      //
      // B-6812 CHK-002 fills the G2 gap (exact-name misses normalization differences + keyword overlap):
      //  - normalized-name match: treat as the same story when normalizeName(name) is equal.
      //    **Only participate in matching when normalizeName(args.name) is non-empty** — legacy data often has name
      //    as empty strings/all special characters, which normalize to ""; never let two empty normalized names
      //    mistakenly be judged as the same story.
      //  - keyword full overlap block: compute keywordOverlap against active non-terminal stories (phase ∉
      //    DONE/DISCARDED); throw an error requiring forceNew:true when ratio === 1 and shared.length >= 2.
      //    Full overlap of DONE/DISCARDED stories only warns (see the
      //    keyword duplicate-check section below, CHK-003 uniformly routes to stderr).
      if (!args.forceNew) {
        const normNewName = normalizeName(args.name);
        const newKeywords = args.keywords ?? [];
        for (const sid of store.listStoryIds()) {
          try {
            const other = store.readStory(sid);
            if (other.phase === 'DONE' || other.phase === 'DISCARDED') continue;

            // 1) normalized-name idempotency. Empty normalized name never
            // participates: an empty new name OR an empty stored name is a
            // fallback, not a match key.
            const normOtherName = normalizeName(other.name);
            if (normNewName.length > 0 && normNewName === normOtherName) {
              // Found a same-name (equal after normalization) unfinished story → return existing
              return [
                `⚠ Story already exists: ${sid} (name="${other.name}", phase=${other.phase})`,
                `Normalized name "${normNewName}" matches an existing story; reusing the existing storyId instead of creating a new one. To force creation, pass forceNew:true.`,
                `Existing story: ${sid} [${other.phase}] ${other.title}`,
                `→ story_get '{"storyId":"${sid}"}' to view details`,
                `→ story_advance '{"storyId":"${sid}","phase":"<next>"}' to continue advancing`,
              ].join('\n');
            }

            // 2) Full keyword overlap → hard-block against active non-terminal stories.
            // ratio === 1 indicates every keyword of the new story is covered by the existing story;
            // shared.length >= 2 avoids false hits from a single-keyword coincidence.
            const overlap = keywordOverlap(newKeywords, other.keywords ?? []);
            if (overlap.ratio === 1 && overlap.shared.length >= 2) {
              throw new DuplicateStoryError(
                `❌ Suspected duplicate of story ${sid} (keyword fully overlaps: ${overlap.shared.join(', ')}); ` +
                `to confirm creating a new one, add forceNew:true`,
              );
            }
          } catch (e: any) {
            // B-6812 F-003: the duplicate-guard rejection must propagate; only
            // genuine read errors on unrelated stories may be swallowed so one
            // corrupt index.json cannot mask the guard. An `instanceof`
            // check on a typed error is wording-independent and never
            // mis-swallows a real failure (OOM / fs permission) that happens
            // to start with the same text.
            if (e instanceof DuplicateStoryError) {
              throw e;
            }
            /* ignore unreadable story */
          }
        }
      }

      // Runtime validation for non-fromDraft path: these fields are required
      const missing = ['name','title','description','type','priority'].filter(k => !(args as any)[k]);
      if (missing.length > 0) {
        throw new Error(`story_create missing required fields in non-fromDraft mode: ${missing.join(', ')}`);
      }

      // B-45ed CHK-006: background required + four-section format validation (hard floor)
      if (typeof args.background !== 'string' || args.background.length === 0) {
        throw new Error(
          'story_create requires background field (four-section format)\n' +
          'Expected 4 sections: "## Trigger Event" / "## Key Insights" / "## Solution Tradeoffs" / "## Conversational Texture"\n' +
          'Hard floor: each section >= 50 chars + total length >= 300 chars + trigger event section contains id regex\n' +
          '(B-[a-z0-9]{4} / F-\\d+ / CHK-\\d+ / commit hash / YYYY-MM-DD)'
        );
      }
      const bgResult = validateBackground(args.background);
      if (!bgResult.ok) {
        throw new Error(
          'background format validation failed:\n' +
          bgResult.errors.map(e => `  - ${e}`).join('\n') + '\n' +
          'Expected 4 sections: "## Trigger Event" / "## Key Insights" / "## Solution Tradeoffs" / "## Conversational Texture"\n' +
          'Each section >= 50 chars, total length >= 300 chars, trigger event section must contain a specific id'
        );
      }

      assertStoryCreateExplicitExcludes({
        title: args.title,
        description: args.description,
        checklist: args.checklist,
        scopeBoundary: args.scopeBoundary,
      });

      const storyId = nextStoryId(store, args.prefix);
      const now = new Date().toISOString();
      const hasChecklist = args.checklist && args.checklist.length > 0;
      const checklistItemFromInput = (
        c: StoryCreateChecklistInput,
        i: number,
        status: 'pending' | 'done',
      ): ChecklistData['items'][number] => {
        const files = normalizeStoryCreateFiles(c.files);
        return {
          id: `CHK-${String(i + 1).padStart(3, '0')}`,
          title: c.title,
          ...(c.context ? { context: c.context } : {}),
          ...(c.relatedDocs !== undefined ? { relatedDocs: c.relatedDocs } : {}),
          ...(c.userSees ? { userSees: c.userSees } : {}),
          ...(c.excludes !== undefined ? { excludes: c.excludes } : {}),
          ...(files ? { files } : {}),
          ...(c.verificationIntent !== undefined ? { verificationIntent: c.verificationIntent } : {}),
          ...(c.phase !== undefined ? { phase: c.phase } : {}),
          status,
          startTime: status === 'done' ? now : null,
          endTime: status === 'done' ? now : null,
        };
      };
      const preflightChecklist: ChecklistData = {
        items: hasChecklist ? args.checklist!.map((c, i) => checklistItemFromInput(c, i, 'pending')) : [],
      };

      // B-45ed CHK-006: persist background.md to docs/story/actives/{storyId}/background.md
      const writeBackground = () => {
        const storyDir = store.storyDirPath(storyId);
        if (!existsSync(storyDir)) mkdirSync(storyDir, { recursive: true });
        const bgPath = join(storyDir, 'background.md');
        // ensure trailing newline, consistent with JSON artifact convention
        const content = args.background!.endsWith('\n') ? args.background! : args.background! + '\n';
        writeFileSync(bgPath, content, 'utf-8');
      };
      const writeInitialScopeArtifacts = () => {
        if (args.scopeBoundary) {
          if (args.scopeBoundary.userConfirmed !== true) {
            throw new Error('story_create scopeBoundary requires userConfirmed:true');
          }
          const allowed = normalizeBoundaryArray(args.scopeBoundary.allowed ?? args.scopeBoundary.allowedScope, 'scopeBoundary.allowed');
          if (allowed.length === 0) {
            throw new Error('story_create scopeBoundary requires at least one allowed scope entry');
          }
          store.writeScopeBoundary(storyId, buildScopeBoundary({
            storyId,
            mode: args.scopeBoundary.mode ?? 'custom',
            allowed,
            excluded: args.scopeBoundary.excluded ?? args.scopeBoundary.excludedScope,
            confirmedBy: args.scopeBoundary.actor ?? 'story_create',
            confirmationNote: args.scopeBoundary.confirmation,
            now,
          }));
        }
        if (args.executionBoundary) {
          store.writeExecutionBoundary(storyId, buildExecutionBoundary({
            storyId,
            allowedCommands: args.executionBoundary.allowedCommands,
            allowedTools: args.executionBoundary.allowedTools,
            allowedPaths: args.executionBoundary.allowedPaths,
            excludedCommands: args.executionBoundary.excludedCommands,
            excludedTools: args.executionBoundary.excludedTools,
            excludedPaths: args.executionBoundary.excludedPaths ?? args.executionBoundary.blockedPaths,
            confirmedBy: args.executionBoundary.actor ?? 'story_create',
            confirmationNote: args.executionBoundary.confirmation,
            now,
          }));
        }
      };

      // B-6812 CHK-003 (G3): advisory text — riskHint, keyword-overlap
      // dupWarning — is collected here but written to STDERR right before the
      // create result is returned, never spliced into the stdout return value.
      // Rationale: `lattice story_create | tail` silently swallows stdout tail
      // lines; the create conclusion (`Story B-xxxx created ...`) must stay on
      // stdout as the command's return value, while duplicate / concurrency
      // warnings must survive pipes by going to stderr (matches the existing
      // normal-channel DEPRECATED warning above).

      // High-risk keyword detection: scan description + checklist titles
      const scanText = [
        args.description,
        ...(args.checklist ?? []).map(c => c.title + ' ' + (c.context ?? '')),
      ].join('\n');
      const riskSignals = detectRiskSignals(scanText);
      let elevatedPriority = args.priority;
      let riskHint = '';
      if (riskSignals.length > 0) {
        // Auto-elevate to high. If the known priority list value is < high, raise to high;
        // not in the list (e.g. non-canonical values like P0/urgent) directly overwrite to high and warn for normalization.
        const order = ['low', 'medium', 'high', 'critical'];
        const curIdx = order.indexOf(args.priority);
        if (curIdx === -1) {
          elevatedPriority = 'high';
        } else if (curIdx < order.indexOf('high')) {
          elevatedPriority = 'high';
        }
        const lines = ['', '⚠ High-risk signals detected:'];
        for (const r of riskSignals) {
          lines.push(`  - ${r.category}: "${r.matched}"`);
        }
        if (elevatedPriority !== args.priority) {
          lines.push(`Auto-elevated priority: ${args.priority} → ${elevatedPriority}`);
        }
        lines.push('Note: after riskSignals hit, handling follows the effective high-risk priority; even if Original priority=low, the high-risk gate is triggered.');
        lines.push('PLAN phase mandatory requirements (high-risk path):');
        lines.push('  - understanding_set records the task understanding snapshot (unknowns/touchpoints required)');
        lines.push('  - decision_set must contain >= 3 preMortem scenarios');
        lines.push('  - story_review passes (missing decision or preMortem < 3 treated as blocker)');
        // B-30b2 CHK-002: mention-vs-modify false-positive escape hatch. The
        // keyword scan cannot tell "merely mentions a risky domain" from
        // "actually modifies it" (by design — no semantic analysis), so surface
        // the CHK-001 rollback path as a discoverable escape. Only promise what
        // CHK-001 implements: dismissing every auto-elevated category rolls the
        // priority back and clears the high-risk gate; partial dismiss does not.
        lines.push('False positive resolution (mention vs modify): keyword detection cannot distinguish "mention" from "modify" of the domain.');
        lines.push('  If false positive (only mentioned, not modified), use lattice story_review_dismiss for full revert:');
        lines.push(`    lattice story_review_dismiss '{"storyId":"${storyId}","category":"<the category hit above>","reason":"explain why this is a false positive"}'`);
        lines.push('  Once all auto-elevated riskSignals are dismissed, priority auto-reverts and high-risk gate is lifted (partial dismiss does not revert).');
        riskHint = lines.join('\n');
      }

      // B-9975 CHK-004: legacy one-step mode deprecation warning for normal-channel stories
      {
        const itemCount = args.checklist?.length ?? 0;
        let channel: 'express' | 'fast' | 'normal';
        if (riskSignals.length > 0) {
          channel = 'normal';
        } else if (itemCount <= 2) {
          channel = 'express';
        } else if (itemCount <= 5) {
          channel = 'fast';
        } else {
          channel = 'normal';
        }
        if (channel === 'normal') {
          process.stderr.write(
            '⚠ [DEPRECATED] normal channel stories should use the story_draft + story_create --from-draft two-stage mode.\n' +
            '  Direct story_create will be hard-blocked on the normal channel in future versions.\n'
          );
        }
      }

      // Keyword dedup check: compare keywords against existing non-DONE/DISCARDED stories
      let dupWarning = '';
      if (args.keywords && args.keywords.length > 0) {
        const overlaps: Array<{ id: string; title: string; phase: string; common: string[] }> = [];
        for (const sid of store.listStoryIds()) {
          try {
            const other = store.readStory(sid);
            if (other.phase === 'DONE' || other.phase === 'DISCARDED') continue;
            if (!other.keywords || other.keywords.length === 0) continue;
            const common = args.keywords.filter(k => other.keywords!.includes(k));
            if (common.length > 0) {
              overlaps.push({ id: sid, title: other.title, phase: other.phase, common });
            }
          } catch { /* ignore */ }
        }
        if (overlaps.length > 0) {
          dupWarning = '⚠ Possibly duplicate story (keyword overlap):\n' +
            overlaps.map(o => `  - ${o.id} [${o.phase}] ${o.title} (common keywords: ${o.common.join(', ')})`).join('\n');
        }
      }
      const storyCreateMemoryHint = renderStoryCreateMemoryRuntimeAdvisory({
        projectRoot: ctx.root,
        storyId,
        title: args.title,
        description: args.description,
        phase: args.phase ?? (hasChecklist ? 'INIT' : 'IDEA'),
        checklist: preflightChecklist,
      });

      /**
       * B-6812 CHK-003 (G3 + G4) + F-004: emit all advisory text to STDERR
       * right before returning the create conclusion. `riskHint` and
       * `dupWarning` (G3) are collected earlier; the recent-concurrent-stories
       * note (G4) and the terminal-keyword-overlap note (F-004) are computed
       * here against the freshly written story so `justCreatedId` is already
       * on disk and excluded from the scans. Each block is trimmed and skipped
       * when empty so we never print blank stderr lines. The create conclusion
       * stays on stdout via the return value.
       */
      const emitAdvisoryToStderr = (): void => {
        const blocks: string[] = [];
        if (riskHint.trim().length > 0) blocks.push(riskHint.trim());
        if (reproFirstHint.trim().length > 0) blocks.push(reproFirstHint.trim());
        if (storyCreateMemoryHint.trim().length > 0) blocks.push(storyCreateMemoryHint.trim());
        if (dupWarning.trim().length > 0) blocks.push(dupWarning.trim());
        const concurrentNote = recentConcurrentStoriesNote(store, storyId, Date.parse(now));
        if (concurrentNote.length > 0) blocks.push(concurrentNote);
        // B-6812 F-004: keyword full overlap with a DONE/DISCARDED story is
        // non-blocking but still surfaced as a same-domain FYI on stderr —
        // plan.md CHK-002 + AGENTS.md promise this warn, so it must be emitted.
        const terminalNote = terminalKeywordOverlapNote(store, args.keywords ?? []);
        if (terminalNote.length > 0) blocks.push(terminalNote);
        // B-198c CHK-003: early storyDir-outside-gitRoot advisory. WARN-ONLY
        // (decision Option A) and routed through the same stderr channel as the
        // other story_create advisories — the create still succeeds. The two
        // late guards (worktree.ts / cli-engine.ts) remain the hard backstop at
        // INIT_CHECK; this only surfaces the dead end sooner.
        const storyDirNote = storyDirOutsideGitRootAdvisory(ctx.root);
        if (storyDirNote.length > 0) blocks.push(storyDirNote);
        if (blocks.length > 0) {
          process.stderr.write(blocks.join('\n') + '\n');
        }
      };

      // Directly specify phase (for onboard use: completed modules marked directly as DONE)
      if (args.phase) {
        if (args.phase === 'INIT_CHECK') {
          throw new Error(
            'story_create cannot directly create INIT_CHECK stories. ' +
            'Create the story in INIT, persist init-check/scope-boundary/execution-boundary/scope-freeze artifacts, then use story_advance phase=INIT_CHECK. [story_create_direct_init_check_forbidden]',
          );
        }
        reproFirstHint = renderReproFirstStoryCreatePreflight({
          projectRoot: ctx.root,
          storyId,
          name: args.name,
          title: args.title,
          description: args.description,
          type: args.type,
          phase: args.phase,
          priority: elevatedPriority,
          riskSignals,
          checklist: preflightChecklist,
          bypassReason: args.reproFirstBypassReason,
        });
        const story: StoryInfo = {
          storyId,
          name: args.name,
          title: args.title,
          description: args.description,
          type: args.type,
          phase: args.phase,
          priority: elevatedPriority,
          ...(args.source ? { source: args.source } : {}),
          ...(args.depends && args.depends.length > 0 ? { depends: args.depends } : {}),
          ...(args.keywords && args.keywords.length > 0 ? { keywords: args.keywords } : {}),
          ...(riskSignals.length > 0 ? { riskSignals } : {}),
          ...(riskSignals.length > 0 && elevatedPriority !== args.priority ? { priorityElevatedFrom: args.priority } : {}),
          createdAt: now,
          startedAt: args.phase !== 'IDEA' ? now : null,
          endedAt: args.phase === 'DONE' ? now : null,
          ...(args.phase === 'REVIEW' ? { currentReviewRound: now } : {}),
          events: [collectContext(args.phase, 'create')],
        };
        store.writeStory(storyId, story);
        writeBackground();
        writeInitialScopeArtifacts();
        // Note: direct phase specification path is for onboard etc. scenarios; normally riskHint is unnecessary, but kept consistent
        if (hasChecklist) {
          const isDone = args.phase === 'DONE';
          const checklist = {
            items: args.checklist!.map((c, i) => checklistItemFromInput(c, i, isDone ? 'done' : 'pending')),
          };
          store.writeChecklist(storyId, checklist);
        }
        const nonGitHint = !isGitRepository(ctx.root)
          ? `\n⚠ Current directory is not a git repo: story is recorded, but branch/worktree phase is not yet available. To continue the normal INIT_CHECK/DEV flow, first git init + initial commit.`
          : '';
        // B-02a6 CHK-002: make the freshly written metadata a tracked clean-proof
        // git object on the current branch HEAD (inside the lock).
        commitSafeInitMetadata(storyId);
        // B-6812 CHK-003 (G3): duplicate / concurrency warnings go to stderr;
        // only the create conclusion + non-advisory guidance stays on stdout.
        emitAdvisoryToStderr();
        return `Story ${storyId} created (${args.phase})${hasChecklist ? ` with ${args.checklist!.length} checklist items` : ''}${nonGitHint}`;
      }

      // Normal mode: with checklist → INIT (subsequent story_advance INIT_CHECK creates worktree → PLAN)
      const phase: StoryPhase = hasChecklist ? 'INIT' : 'IDEA';
      reproFirstHint = renderReproFirstStoryCreatePreflight({
        projectRoot: ctx.root,
        storyId,
        name: args.name,
        title: args.title,
        description: args.description,
        type: args.type,
        phase,
        priority: elevatedPriority,
        riskSignals,
        checklist: preflightChecklist,
        bypassReason: args.reproFirstBypassReason,
      });
      const story: StoryInfo = {
        storyId,
        name: args.name,
        title: args.title,
        description: args.description,
        type: args.type,
        phase,
        priority: elevatedPriority,
        ...(args.source ? { source: args.source } : {}),
        ...(args.depends && args.depends.length > 0 ? { depends: args.depends } : {}),
        ...(args.keywords && args.keywords.length > 0 ? { keywords: args.keywords } : {}),
        ...(riskSignals.length > 0 ? { riskSignals } : {}),
        ...(riskSignals.length > 0 && elevatedPriority !== args.priority ? { priorityElevatedFrom: args.priority } : {}),
        createdAt: now,
        startedAt: hasChecklist ? now : null,
        endedAt: null,
        events: [collectContext(phase, 'create')],
      };
      store.writeStory(storyId, story);
      writeBackground();
      writeInitialScopeArtifacts();

      if (hasChecklist) {
        const checklist = {
          items: args.checklist!.map((c, i) => checklistItemFromInput(c, i, 'pending')),
        };
        store.writeChecklist(storyId, checklist);
        const noContext = args.checklist!.filter((c: any) => !c.context).length;
        const hints: string[] = [];
        if (noContext > 0) hints.push(`${noContext} items missing context (root cause/reference); please supplement`);
        const hint = hints.length > 0 ? '\n⚠ ' + hints.join('\n⚠ ') : '';
        // B-e71f CHK-004: INIT→INIT_CHECK hard gate guidance.
        // INIT phase must have an independent subagent review the initial background + checklist; main agent must not self-invoke
        // init_check_set with a forged signature (anti-self-absolution). Only after review passes can story_advance INIT_CHECK proceed.
        const initReviewHint =
          `\n\n→ Now please spawn two INIT reviewers in parallel:\n` +
          `  · Agent({ subagent_type: "lattice-review-story-init", prompt: \`Review the initial background + checklist of story ${storyId} (run lattice dispatch '{"storyId":"${storyId}","agentType":"lattice-review-story-init"}' to get the standard prompt)\` })\n` +
          `  · Agent({ subagent_type: "product-reviewer", prompt: \`Run lattice dispatch '{"storyId":"${storyId}","agentType":"product-reviewer"}' to get the standard prompt; whether pass/fail, must call init_check_set, agentId must be exactly product-reviewer\` })\n` +
          `  · Do not have the main agent self-invoke lattice init_check_set (the CLI does not mechanically validate agentId, but the reviewer template fresh-context fence + CLAUDE.md behavior rules require invocation by an independent subagent—main agent self-invocation effectively bypasses the reviewer, violating the anti-self-absolution convention)\n` +
          `  · If a reviewer produces no output for 4 minutes, treat as stuck: rerun lattice dispatch to fetch the prompt and restart the reviewer; if the old reviewer returns later, take the latest init_check_set as authoritative\n` +
          `  · INIT_CHECK gate requires both lattice-review-story-init and product-reviewer to have persisted via init_check_set; critical/high issues will block advancement\n` +
          `  · After review passes, call lattice story_advance '{"storyId":"${storyId}","phase":"INIT_CHECK"}' to enter INIT_CHECK`;
        const nonGitHint = !isGitRepository(ctx.root)
          ? `\n⚠ Current directory is not a git repo: story is recorded, but INIT_CHECK/worktree flow still requires git init + initial commit first.`
          : '';
        // B-02a6 CHK-002: make the freshly written INIT metadata a tracked
        // clean-proof git object on the current branch HEAD (inside the lock),
        // closing the INIT-window data-loss window against a concurrent
        // `git clean -fd` / wrong-branch checkout on the shared checkout.
        commitSafeInitMetadata(storyId);
        // B-6812 CHK-003 (G3): duplicate / concurrency warnings go to stderr;
        // the create conclusion + INIT-review guidance stays on stdout.
        emitAdvisoryToStderr();
        return `Story ${storyId} created (INIT) with ${checklist.items.length} checklist items${hint}${initReviewHint}${nonGitHint}`;
      }

      // B-02a6 CHK-002: an IDEA story still persists index.json + background.md on
      // the shared checkout, so it is equally exposed to a concurrent clean -fd —
      // make it tracked too.
      commitSafeInitMetadata(storyId);
      // B-6812 CHK-003 (G3): duplicate / concurrency warnings go to stderr.
      emitAdvisoryToStderr();
      return `Story ${storyId} created (IDEA)`;
      // story_create is a sub-second critical section: concurrent callers must
      // SERIALIZE-AND-WAIT (every invocation completes, the loser then hits the
      // idempotency reuse branch) — never fail-fast. This preserves the
      // pre-B-f60c "winner creates, the rest reuse, all exit 0" contract that
      // story-create-concurrency-smoke asserts.
      }, { label: 'story_create', onContention: 'wait' });
    },
  };
}
