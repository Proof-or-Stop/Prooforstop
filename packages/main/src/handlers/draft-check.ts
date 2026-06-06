/**
 * Draft Check handler — koala draft_check_set / draft_issue_resolve
 *
 * Parallel to init-check but for drafts. Allows a reviewer to sign off on
 * a draft's background + checklist before it becomes a formal story.
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { HandlerContext } from './context.js';
import type { DraftCheckData, InitCheckIssue } from '../core/types.js';
import { computeChecklistHash } from './init-check.js';
import { computeDraftCheckHash } from '../core/draft-check-hash.js';

function getDraftsDir(ctx: HandlerContext): string {
  return join(ctx.root, 'docs', 'story', 'drafts');
}

export function createDraftCheckHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  return {
    draft_check_set(args: {
      draftName: string;
      issues: Array<{ id?: string; severity: 'critical' | 'high' | 'medium' | 'low'; desc: string }>;
      agentId?: string;
    }): string {
      const draftsDir = getDraftsDir(ctx);
      const draftDir = join(draftsDir, args.draftName);

      // 1) Draft existence check
      if (!existsSync(draftDir)) {
        throw new Error(`Draft '${args.draftName}' not found`);
      }

      // 2) Read index.json for title/description
      const indexPath = join(draftDir, 'index.json');
      if (!existsSync(indexPath)) {
        throw new Error(`Draft '${args.draftName}' missing index.json`);
      }
      const index = JSON.parse(readFileSync(indexPath, 'utf-8'));
      const title: string = index.title || '';
      const description: string = index.description || '';

      // 3) Read background.md → sha256 hash
      const bgPath = join(draftDir, 'background.md');
      let backgroundHash: string;
      if (!existsSync(bgPath)) {
        backgroundHash = 'missing';
      } else {
        const bgContent = readFileSync(bgPath, 'utf-8');
        backgroundHash = createHash('sha256').update(bgContent).digest('hex');
      }

      // 4) Read checklist.json → normalize → sha256 hash
      const clPath = join(draftDir, 'checklist.json');
      let items: Array<{ title: string; context?: string }> = [];
      if (existsSync(clPath)) {
        try {
          const cl = JSON.parse(readFileSync(clPath, 'utf-8'));
          if (Array.isArray(cl.items)) {
            items = cl.items.map((i: any) => ({ title: i.title, context: i.context }));
          }
        } catch {
          // checklist unreadable → empty
        }
      }
      const checklistHash = computeChecklistHash(items);

      // 5) reviewRound = '' for drafts
      const reviewRound = '';

      // 6) Compute _hash
      const _hash = computeDraftCheckHash(args.draftName, backgroundHash, title, description, checklistHash, reviewRound);

      // 7) Auto-assign issue ids if missing
      const issues: InitCheckIssue[] = (Array.isArray(args.issues) ? args.issues : []).map((issue, i) => {
        if (!issue || typeof issue.desc !== 'string' || issue.desc.trim().length < 1) {
          throw new Error('draft_check_set: each issue.desc must be ≥ 1 character after trim');
        }
        return {
          id: issue.id || `INIT-${String(i + 1).padStart(3, '0')}`,
          severity: issue.severity,
          desc: issue.desc,
        };
      });

      // 8) Write draft-check.json
      const data: DraftCheckData = {
        draftName: args.draftName,
        checkedAt: new Date().toISOString(),
        reviewRound,
        agentId: args.agentId ?? '',
        issues,
        _hash,
      };
      writeFileSync(join(draftDir, 'draft-check.json'), JSON.stringify(data, null, 2) + '\n', 'utf-8');

      // 9) Return summary
      let critical = 0, high = 0, medium = 0, low = 0;
      for (const issue of issues) {
        switch (issue.severity) {
          case 'critical': critical++; break;
          case 'high': high++; break;
          case 'medium': medium++; break;
          case 'low': low++; break;
        }
      }
      return `Draft check saved for ${args.draftName}: ${issues.length} issues (${critical}/${high}/${medium}/${low})`;
    },

    draft_issue_resolve(args: {
      draftName: string;
      issueId: string;
      resolution: string;
    }): string {
      // Validate resolution length
      if (!args.resolution || args.resolution.trim().length < 20) {
        throw new Error('resolution must be ≥ 20 characters after trim');
      }

      const draftsDir = getDraftsDir(ctx);
      const draftDir = join(draftsDir, args.draftName);
      const checkPath = join(draftDir, 'draft-check.json');

      if (!existsSync(checkPath)) {
        throw new Error(`Draft check not found for '${args.draftName}'. Run draft_check_set first.`);
      }

      const data: DraftCheckData = JSON.parse(readFileSync(checkPath, 'utf-8'));

      // Validate issueId exists
      const issueExists = data.issues.some(i => i.id === args.issueId);
      if (!issueExists) {
        throw new Error(`Issue '${args.issueId}' not found in draft-check.json for '${args.draftName}'`);
      }

      // Add/update resolution (resolutions not in _hash)
      if (!data.resolutions) {
        data.resolutions = {};
      }
      data.resolutions[args.issueId] = args.resolution.trim();

      writeFileSync(checkPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');

      return `Resolution saved for ${args.issueId} in draft '${args.draftName}'`;
    },
  };
}
