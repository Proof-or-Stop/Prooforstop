/**
 * dev-memory handlers — thin CLI wrappers around core/dev-memory.ts
 *
 * B-ad2c: lightweight experience capture outside Proofbound story gates.
 * All commands are non-authoritative and do NOT satisfy Proofbound gate evidence.
 */

import type { HandlerContext } from './context.js';
import {
  createEntry,
  appendEntry,
  readEntries,
  readGlobalMemoryEntries,
  readProjectMemoryEntries,
  searchEntries,
  findSimilar,
  buildPreflightPack,
  buildSupersessionProjection,
  attachSupersessionStatus,
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
import { loadConfig } from '../core/config.js';
import { buildMemoryFreshnessPack, renderMemoryFreshnessPack } from '../core/playbook-runtime-memory.js';

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
      sourceAgent: args.sourceAgent || 'lattice-implementer',
      sourceStoryId: args.sourceStoryId,
      evidenceRefs: args.evidenceRefs,
    };
    const entry = createEntry(input);
    const filePath = scope === 'global'
      ? resolveGlobalMemoryPath()
      : resolveProjectMemoryPath(root);
    // Duplicate detection: check existing entries before appending
    const existingEntries = scope === 'global'
      ? readGlobalMemoryEntries()
      : readProjectMemoryEntries(root);
    const similar = findSimilar(existingEntries, input);
    appendEntry(filePath, entry);
    const tagsStr = entry.tags && entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : '';
    const lines = [`Captured dev-memory experience: ${entry.id} (${entry.category}${tagsStr})\n  Summary: ${entry.summary}`];
    for (const dup of similar) {
      lines.push(`  Possible duplicate: ${dup.id} (${dup.category}) — ${dup.summary}`);
    }
    return lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // dev_memory_list
  // -------------------------------------------------------------------------
  function dev_memory_list(args: { scope?: ExperienceScope; limit?: number; json?: boolean }): string {
    const scope = args.scope || 'project';
    const allEntries = (() => {
      if (scope === 'global') {
        return readGlobalMemoryEntries();
      }
      if (scope === 'project') {
        return readProjectMemoryEntries(root);
      }
      // 'story-candidate' — list all known story candidate files
      // For simplicity, read from project memory
      return readProjectMemoryEntries(root);
    })();
    const projection = buildSupersessionProjection(allEntries);
    const limit = args.limit ?? 50;
    // Newest-first: reverse the full array, then take the first `limit` items
    const entries = allEntries.slice().reverse().slice(0, limit);

    if (args.json) {
      return JSON.stringify(entries.map(e => attachSupersessionStatus(e, projection)), null, 2);
    }
    if (entries.length === 0) {
      return `No dev-memory experience entries yet (scope: ${scope})`;
    }
    const lines = [`Dev-memory entries (scope: ${scope}, ${entries.length} total):`];
    for (const e of entries) {
      lines.push('');
      lines.push(formatEntryShort(e, projection));
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
    const projectEntries = readProjectMemoryEntries(root);
    const globalEntries = args.global ? readGlobalMemoryEntries() : [];
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
    const projection = buildSupersessionProjection(allEntries);
    if (args.json) return JSON.stringify(results.map(e => attachSupersessionStatus(e, projection)), null, 2);
    if (results.length === 0) {
      return `No dev-memory experience entries found for query: ${JSON.stringify(args.query ?? '')}`;
    }
    const lines = [`Dev-memory search results (${results.length} entries):`];
    for (const e of results) {
      lines.push('');
      lines.push(formatEntryShort(e, projection));
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
      return JSON.stringify({
        entries: result.entries.map(e => attachSupersessionStatus(e, result.supersessionProjection)),
        lineCount: result.lineCount,
        truncated: result.truncated,
      }, null, 2);
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
    scope?: string;
  }): string {
    const projectPath = resolveProjectMemoryPath(root);
    const allEntries = readProjectMemoryEntries(root);
    const relevant = args.query
      ? searchEntries(allEntries, { query: args.query, limit: 20 })
      : allEntries.slice(-20);

    // Without storyId: project-mode — no story directories required.
    if (!args.storyId) {
      if (relevant.length === 0) {
        return [
          `dev_memory_finish: no experience entries found in project memory (${projectPath}).`,
          `  No story directory required for outside-Proofbound sessions.`,
        ].join('\n');
      }

      if (args.scope === 'global') {
        // Promote relevant project entries to global dev-memory, de-duped by id.
        const globalPath = resolveGlobalMemoryPath();
        const existingGlobalIds = new Set(readGlobalMemoryEntries().map(e => e.id));
        const newEntries = relevant.filter(e => !existingGlobalIds.has(e.id));
        for (const e of newEntries) {
          const globalCopy = {
            ...e,
            scope: 'global' as const,
            gateEvidence: false as const,
            authority: 'non_authoritative' as const,
          };
          appendEntry(globalPath, globalCopy);
        }
        const skipped = relevant.length - newEntries.length;
        const lines = [
          `Promoted ${newEntries.length} entr${newEntries.length === 1 ? 'y' : 'ies'} to global dev-memory: ${globalPath}`,
          `  (scope: global, non-authoritative, de-duped by id)`,
        ];
        if (skipped > 0) {
          lines.push(`  ${skipped} already present in global memory (skipped)`);
        }
        return lines.join('\n');
      }

      // Default: report that entries are retained in project memory.
      return [
        `Project dev-memory: ${relevant.length} relevant entr${relevant.length === 1 ? 'y' : 'ies'} retained in ${projectPath}`,
        `  Entries are already in project dev-memory. No story directory required.`,
        `  (Use --scope=global to promote to global dev-memory, or --storyId=<id> to write story candidates.)`,
      ].join('\n');
    }

    // With storyId: write story candidate copies under the configured storyDir.
    const storyDir = args.storyDir
      ? args.storyDir
      : join(root, loadConfig(root).storyDir);
    const candidatePath = resolveStoryCandidatePath(storyDir, args.storyId);

    if (relevant.length === 0) {
      return `dev_memory_finish: no experience entries found in project memory (${projectPath}). Nothing written.`;
    }

    // Ensure story subdir exists
    const storySubDir = join(storyDir, args.storyId);
    if (!existsSync(storySubDir)) {
      mkdirSync(storySubDir, { recursive: true });
    }

    // Append candidates to story file (idempotent — de-duped by id).
    const existingIds = new Set(readEntries(candidatePath).map(e => e.id));
    const newCandidates = relevant.filter(e => !existingIds.has(e.id));
    for (const e of newCandidates) {
      const candidateCopy = {
        ...e,
        scope: 'story-candidate' as const,
        sourceStoryId: args.storyId,
        gateEvidence: false as const,
        authority: 'non_authoritative' as const,
      };
      appendEntry(candidatePath, candidateCopy);
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
    const preflight = buildMemoryFreshnessPack({
      query: args.query,
      projectRoot: root,
      consumer: 'dev_memory_start',
      host: agentName,
      maxEntries: args.maxEntries ?? 5,
      maxLines: 60,
    });
    const preflightText = renderMemoryFreshnessPack(preflight);
    const reminder = [
      ``,
      `Dev session starting (agent: ${agentName})`,
      ``,
      `When the session ends, run one of:`,
      `  lattice dev_memory_finish                    # report project entries (no story required)`,
      `  lattice dev_memory_finish --scope=global     # promote to global dev-memory`,
      `  lattice dev_memory_finish --storyId=<id>     # write story-scoped candidates`,
      ``,
      `Project entries are retained automatically. --storyId is optional.`,
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
