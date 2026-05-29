/**
 * dev-memory handlers — thin CLI wrappers around core/dev-memory.ts
 *
 * B-ad2c: lightweight experience capture outside Koala story gates.
 * All commands are non-authoritative and do NOT satisfy Koala gate evidence.
 */

import type { HandlerContext } from './context.js';
import {
  createEntry,
  appendEntry,
  readEntries,
  searchEntries,
  buildPreflightPack,
  formatEntryShort,
  formatPreflightPack,
  resolveProjectMemoryPath,
  resolveGlobalMemoryPath,
  resolveStoryCandidatePath,
  writeEntries,
  type CaptureInput,
  type ExperienceCategory,
  type ExperienceScope,
  type SearchOptions,
} from '../core/dev-memory.js';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';

// ---------------------------------------------------------------------------
// dev_memory_capture
// ---------------------------------------------------------------------------

export interface DevMemoryCaptureArgs {
  category: ExperienceCategory;
  scope?: ExperienceScope;
  summary: string;
  trigger: string;
  lesson: string;
  reusePrompt: string;
  tags?: string[] | string;
  sourceAgent?: string;
  sourceStoryId?: string;
  evidenceRefs?: string[];
}

function parseTagsArg(tags: string[] | string | undefined): string[] | undefined {
  if (!tags) return undefined;
  if (Array.isArray(tags)) return tags;
  // Comma-separated string from CLI flag
  return tags.split(',').map(t => t.trim()).filter(t => t.length > 0);
}

export function createDevMemoryHandlers(ctx: HandlerContext) {
  const { root } = ctx;

  // -------------------------------------------------------------------------
  // dev_memory_capture
  // -------------------------------------------------------------------------
  function dev_memory_capture(args: DevMemoryCaptureArgs): string {
    const scope: ExperienceScope = args.scope || 'project';
    const input: CaptureInput = {
      category: args.category,
      scope,
      summary: args.summary,
      trigger: args.trigger,
      lesson: args.lesson,
      reusePrompt: args.reusePrompt,
      tags: parseTagsArg(args.tags),
      sourceAgent: args.sourceAgent || 'koala-implementer',
      sourceStoryId: args.sourceStoryId,
      evidenceRefs: args.evidenceRefs,
    };
    const entry = createEntry(input);
    const filePath = scope === 'global'
      ? resolveGlobalMemoryPath()
      : resolveProjectMemoryPath(root);
    appendEntry(filePath, entry);
    const tagsStr = entry.tags && entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : '';
    return `Captured dev-memory experience: ${entry.id} (${entry.category}${tagsStr})\n  Summary: ${entry.summary}`;
  }

  // -------------------------------------------------------------------------
  // dev_memory_list
  // -------------------------------------------------------------------------
  function dev_memory_list(args: { scope?: ExperienceScope; limit?: number; json?: boolean }): string {
    const scope = args.scope || 'project';
    let entries = (() => {
      if (scope === 'global') {
        return readEntries(resolveGlobalMemoryPath());
      }
      if (scope === 'project') {
        return readEntries(resolveProjectMemoryPath(root));
      }
      // 'story-candidate' — list all known story candidate files
      // For simplicity, read from project memory
      return readEntries(resolveProjectMemoryPath(root));
    })();
    const limit = args.limit ?? 50;
    entries = entries.slice(-limit);

    if (args.json) {
      return JSON.stringify(entries, null, 2);
    }
    if (entries.length === 0) {
      return `No dev-memory experience entries yet (scope: ${scope})`;
    }
    const lines = [`Dev-memory entries (scope: ${scope}, ${entries.length} total):`];
    for (const e of entries) {
      lines.push('');
      lines.push(formatEntryShort(e));
    }
    return lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // dev_memory_search
  // -------------------------------------------------------------------------
  function dev_memory_search(args: {
    query?: string;
    category?: string;
    agent?: string;
    tags?: string[] | string;
    limit?: number;
    global?: boolean;
    json?: boolean;
  }): string {
    const projectEntries = readEntries(resolveProjectMemoryPath(root));
    const globalEntries = args.global ? readEntries(resolveGlobalMemoryPath()) : [];
    const seen = new Set<string>();
    const allEntries = [];
    for (const e of [...projectEntries, ...globalEntries]) {
      if (!seen.has(e.id)) { seen.add(e.id); allEntries.push(e); }
    }
    const opts: SearchOptions = {
      query: args.query,
      category: args.category,
      agent: args.agent,
      tags: parseTagsArg(args.tags),
      limit: args.limit ?? 20,
    };
    const results = searchEntries(allEntries, opts);
    if (args.json) return JSON.stringify(results, null, 2);
    if (results.length === 0) {
      return `No dev-memory experience entries found for query: ${JSON.stringify(args.query ?? '')}`;
    }
    const lines = [`Dev-memory search results (${results.length} entries):`];
    for (const e of results) {
      lines.push('');
      lines.push(formatEntryShort(e));
    }
    return lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // dev_memory_preflight
  // -------------------------------------------------------------------------
  function dev_memory_preflight(args: {
    query?: string;
    maxEntries?: number;
    maxLines?: number;
    json?: boolean;
  }): string {
    const result = buildPreflightPack({
      query: args.query,
      projectRoot: root,
      maxEntries: args.maxEntries,
      maxLines: args.maxLines,
    });
    if (args.json) {
      return JSON.stringify({ entries: result.entries, lineCount: result.lineCount, truncated: result.truncated }, null, 2);
    }
    return formatPreflightPack(result, args.query);
  }

  // -------------------------------------------------------------------------
  // dev_memory_finish
  // -------------------------------------------------------------------------
  function dev_memory_finish(args: {
    storyId?: string;
    storyDir?: string;
    query?: string;
  }): string {
    if (!args.storyId) {
      return 'dev_memory_finish: --storyId is required. Pass the active story ID (e.g. --storyId=B-xxx).';
    }
    // Resolve story dir: either explicit or under <root>/docs/story/actives/
    const storyDir = args.storyDir
      ? args.storyDir
      : join(root, 'docs', 'story', 'actives');
    const candidatePath = resolveStoryCandidatePath(storyDir, args.storyId);

    // Read recent project-scoped entries (candidates for this session)
    const projectPath = resolveProjectMemoryPath(root);
    const allEntries = readEntries(projectPath);
    const candidates = allEntries.slice(-20); // last 20 entries = session candidates

    if (candidates.length === 0) {
      return `dev_memory_finish: no experience entries found in project memory (${projectPath}). Nothing written.`;
    }

    // Ensure story dir exists
    const storySubDir = join(storyDir, args.storyId);
    if (!existsSync(storySubDir)) {
      mkdirSync(storySubDir, { recursive: true });
    }

    // Append candidates to story file (don't overwrite; idempotent)
    const existingIds = new Set(readEntries(candidatePath).map(e => e.id));
    const newCandidates = candidates.filter(e => !existingIds.has(e.id));
    for (const e of newCandidates) {
      appendEntry(candidatePath, e);
    }

    const lines = [
      `Experience candidates written to: ${candidatePath}`,
      `  Total: ${newCandidates.length} new entr${newCandidates.length === 1 ? 'y' : 'ies'} appended`,
    ];
    if (newCandidates.length > 0) {
      lines.push(`  → Review and promote to docs/requirements/decisions/ if relevant`);
    }
    return lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // dev_memory_start — preflight wrapper for starting a dev session
  // Does NOT spawn external agent binaries. Always outputs preflight context
  // and a reminder to call dev_memory_finish when the session ends.
  // -------------------------------------------------------------------------
  function dev_memory_start(args: {
    agent?: string;
    query?: string;
    maxEntries?: number;
    dryRun?: boolean;
  }): string {
    const agentName = args.agent || 'agent';
    const preflight = buildPreflightPack({
      query: args.query,
      projectRoot: root,
      maxEntries: args.maxEntries ?? 5,
    });
    const preflightText = formatPreflightPack(preflight, args.query);
    const reminder = [
      ``,
      `Dev session starting (agent: ${agentName})`,
      ``,
      `When the session ends, run:`,
      `  koala dev_memory_finish --storyId=<your-story-id>`,
      ``,
      `This will write session experience candidates to the story dir for review.`,
    ].join('\n');
    return preflightText + reminder;
  }

  return {
    dev_memory_capture,
    dev_memory_list,
    dev_memory_search,
    dev_memory_preflight,
    dev_memory_finish,
    dev_memory_start,
  };
}
