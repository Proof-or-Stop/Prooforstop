/**
 * B-7561 (Experience Layer Phase 3, FINAL slice): Story Recall handler.
 *
 * `recall` ranks stories by structured-field similarity over the EXISTING
 * `story_list` scan (StoryStore enumeration). It is strictly READ-ONLY:
 *   • It NEVER writes a file, never creates a derived index / cache, and never
 *     touches a gate. Its only store access is the read ports
 *     (`listStoryIds`, `readStory`, `readUnderstanding`, `readDecision`,
 *     `readFindings`) — the same surface `story_list` already walks.
 *   • The actual scoring/ranking lives in the pure `core/story-recall.ts` leaf
 *     (zero outward imports); this handler only adapts the store to that leaf
 *     and renders the result.
 *
 * Two modes:
 *   recall --story <id> [--top N]   rank the stories most similar to <id>.
 *   recall --query "<text>" [--top N]   rank stories matching an ad-hoc query.
 *
 * There is NO FTS, NO BM25, NO embedding, and NO new persisted index — recall is
 * a scan-only projection over the live story set.
 */

import {
  buildQueryProfile,
  buildStoryProfile,
  recallSimilarStories,
  type StoryProfileInput,
} from '../core/story-recall.js';
import type { RecallMatch, StoryProfile } from '../core/experience-layer-types.js';
import type { HandlerContext } from './context.js';

const DEFAULT_TOP = 5;

interface RecallArgs {
  storyId?: string;
  story?: string;
  query?: string;
  top?: number | string;
}

/** Parse a positive integer top-N, defaulting to 5; negatives clamp to 0. */
function resolveTop(raw: number | string | undefined): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_TOP;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_TOP;
  const floored = Math.floor(n);
  return floored < 0 ? 0 : floored;
}

/**
 * Read one story's metadata through the store READ ports and shape it into the
 * loose `StoryProfileInput` the pure profile builder consumes. Defensive: any
 * missing artifact degrades to absent (the builder tolerates it).
 */
function readProfileInput(ctx: HandlerContext, storyId: string): StoryProfileInput | null {
  let story;
  try {
    story = ctx.store.readStory(storyId);
  } catch {
    return null; // story has no index.json (or is unreadable) — skip it
  }
  const understanding = ctx.store.readUnderstanding(storyId);
  const decision = ctx.store.readDecision(storyId);
  const findings = ctx.store.readFindings(storyId).findings;

  return {
    storyId: story.storyId,
    title: story.title,
    name: story.name,
    type: story.type,
    phase: story.phase,
    priority: story.priority,
    keywords: story.keywords,
    riskSignals: story.riskSignals,
    understanding: understanding
      ? { task: understanding.task, outcome: understanding.outcome, touchpoints: understanding.touchpoints }
      : null,
    decision: decision
      ? { chosen: decision.chosen, rationale: decision.rationale, principles: decision.principles }
      : null,
    findings: findings.map((f) => ({
      desc: f.desc,
      signatureTag: f.signatureTag,
      files: f.files,
      category: f.category,
    })),
  };
}

/** Build profiles for every story in the project (the `story_list` scan). */
function buildAllProfiles(ctx: HandlerContext): StoryProfile[] {
  const profiles: StoryProfile[] = [];
  for (const id of ctx.store.listStoryIds()) {
    const input = readProfileInput(ctx, id);
    if (input) profiles.push(buildStoryProfile(input));
  }
  return profiles;
}

/** Render one ranked match: score, reasons, and notable findings/decisions/outcome. */
function renderMatch(match: RecallMatch, rank: number): string {
  const lines: string[] = [];
  lines.push(`${rank}. ${match.storyId}  (score ${match.score.toFixed(3)})  ${match.title}`);
  if (match.reasons.length > 0) {
    for (const r of match.reasons) lines.push(`     • ${r}`);
  } else {
    lines.push('     • (no overlapping dimension)');
  }
  const p = match.profile;
  if (p.notableFindings.length > 0) {
    lines.push(`     findings: ${p.notableFindings.slice(0, 3).join(' | ')}`);
  }
  if (p.notableDecisions.length > 0) {
    lines.push(`     decisions: ${p.notableDecisions.slice(0, 2).join(' | ')}`);
  }
  if (p.outcome) {
    lines.push(`     outcome: ${p.outcome}`);
  }
  return lines.join('\n');
}

function renderResults(header: string, matches: RecallMatch[], top: number): string {
  if (top <= 0) return `${header}\n(top ${top} requested — no results)`;
  if (matches.length === 0) return `${header}\nNo similar stories found.`;
  const body = matches.map((m, i) => renderMatch(m, i + 1)).join('\n');
  return `${header}\n${body}`;
}

export function createRecallHandlers(ctx: HandlerContext) {
  return {
    /**
     * Rank stories by structured-field similarity. READ-ONLY: builds profiles
     * from the store enumeration, ranks via the pure leaf, and renders. Writes
     * nothing.
     */
    recall(args: RecallArgs = {}): string {
      const storyId = (args.storyId ?? args.story ?? '').trim();
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      const top = resolveTop(args.top);

      if (!storyId && !query) {
        return [
          'recall: rank stories by structured-field similarity (read-only; no FTS/index).',
          'Usage:',
          '  recall --story <id> [--top N]      similar stories to <id>',
          '  recall --query "<text>" [--top N]  stories matching a query',
          `Default top = ${DEFAULT_TOP}.`,
        ].join('\n');
      }

      if (storyId && query) {
        throw new Error('recall: pass either --story <id> OR --query "<text>", not both.');
      }

      const candidates = buildAllProfiles(ctx);

      // ── --story mode ──
      if (storyId) {
        const target = candidates.find((p) => p.storyId === storyId);
        if (!target) {
          return `recall: story not found: ${storyId} (no index.json in the story scan).`;
        }
        const matches = recallSimilarStories(target, candidates, top);
        const header = `recall --story ${storyId} (top ${top}) — "${target.title}"`;
        return renderResults(header, matches, top);
      }

      // ── --query mode ──
      if (!query) {
        return 'recall: --query must be a non-empty string.';
      }
      const target = buildQueryProfile(query);
      if (target.keywords.length === 0) {
        return `recall --query "${query}" — no usable keywords in the query; no results.`;
      }
      const matches = recallSimilarStories(target, candidates, top);
      const header = `recall --query "${query}" (top ${top})`;
      return renderResults(header, matches, top);
    },
  };
}
