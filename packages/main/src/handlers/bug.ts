
import type { HandlerContext } from './context.js';
import type { BugRecord, BugEvidence } from '../core/types.js';
import { extractBugs } from '../tasks/bug-report.js';
import { computeProcessMetrics } from '../core/process-metrics.js';
import { wantsFullOutput, truncateOneLine } from '../cli/output-verbosity.js';

// B-7c05 CHK-004: brief bug one-liner. Keeps the decision fields (storyId, id,
// status) + a truncated title; drops timestamps/evidence.
function toBriefBug(bug: BugRecord & { storyId?: string }): Record<string, unknown> {
  return {
    ...(bug.storyId ? { storyId: bug.storyId } : {}),
    id: bug.id,
    status: bug.status,
    title: truncateOneLine(bug.title, 80),
  };
}

export function createBugHandlers(ctx: HandlerContext) {
  const { store } = ctx;
  return {
    bug_report(args: {
      storyId: string;
      id: string;
      title: string;
      checklistId?: string;
      fixtureId?: string;
    }): string {
      const data = store.readBugs(args.storyId);
      if (data.bugs.find(b => b.id === args.id)) {
        throw new Error(`Bug ${args.id} already exists`);
      }
      const bug: BugRecord = {
        id: args.id,
        title: args.title,
        status: 'open',
        foundAt: new Date().toISOString(),
        fixedAt: null,
        ...(args.checklistId ? { checklistId: args.checklistId } : {}),
        ...(args.fixtureId ? { fixtureId: args.fixtureId } : {}),
      };
      data.bugs.push(bug);
      store.writeBugs(args.storyId, data);
      return `Bug ${args.id} reported` + (args.fixtureId ? ` (fixtureId: ${args.fixtureId})` : '');
    },

    async bug_update(args: {
      storyId: string;
      id: string;
      status: 'open' | 'fixed';
      evidence?: BugEvidence;
    }): Promise<string> {
      const data = store.readBugs(args.storyId);
      const bug = data.bugs.find(b => b.id === args.id);
      if (!bug) throw new Error(`Bug ${args.id} not found`);

      // Mark fixed (verification runs through lattice validate, not auto-triggered inside bug_update)
      let resultMsg: string;
      if (args.status === 'fixed') {
        if (!args.evidence) {
          return `⚠ Bug ${args.id}: providing evidence (symptom / rootCause / fixEvidence) is recommended when marking fixed.` +
            ` Usage: lattice bug_update '{"storyId":"...","id":"...","status":"fixed","evidence":{"symptom":"...","reproSteps":["..."],"rootCause":"...","fixEvidence":"..."}}'`;
        }
        bug.status = 'fixed';
        bug.fixedAt = new Date().toISOString();
        bug.evidence = args.evidence;
        store.writeBugs(args.storyId, data);
        resultMsg = `Bug ${args.id} updated to fixed (✓ evidence recorded: rootCause="${args.evidence.rootCause}")`;
      } else {
        // B-aa48 CHK-002: detect reopen (was fixed, now open)
        const wasFixed = bug.status === 'fixed';
        bug.status = args.status;
        store.writeBugs(args.storyId, data);

        if (wasFixed && args.status === 'open') {
          try {
            store.appendProcessEvent(args.storyId, {
              type: 'bug_reopened',
              bugId: args.id,
            });
          } catch (e) {
            console.warn(`[process-events] append failed for ${args.storyId}:`, (e as Error).message);
          }
        }

        resultMsg = `Bug ${args.id} updated to ${args.status}`;
      }

      // B-abd8: auto-recompute process metrics (once, after either branch)
      try {
        const pm = computeProcessMetrics(args.storyId, store, ctx.root);
        store.writeProcessMetrics(args.storyId, pm);
      } catch (e) {
        console.warn(`[process-metrics] recompute failed for ${args.storyId}:`, (e as Error).message);
      }

      return resultMsg;
    },

    bug_list(args: { storyId?: string; full?: boolean; brief?: boolean; json?: boolean; format?: 'text' | 'json' } = {}) {
      // Per-story bug list is already scoped/small; only the global cross-story
      // dump (the 263KB whale) gets the brief default.
      if (args.storyId) return store.readBugs(args.storyId);

      const stories = store.listStoryIds();
      const bugs = stories.flatMap(storyId =>
        store.readBugs(storyId).bugs.map(bug => ({ storyId, ...bug })),
      );
      const summary = {
        stories: stories.length,
        total: bugs.length,
        open: bugs.filter(b => b.status === 'open').length,
        fixed: bugs.filter(b => b.status === 'fixed').length,
      };
      // B-7c05 CHK-004: brief by default. `summary` covers ALL bugs by status
      // (non-silent), the list is trimmed to actionable OPEN bugs, and --full /
      // --json / LATTICE_BRIEF_OUTPUT=0 restore every bug.
      if (wantsFullOutput(args)) return { bugs, summary };
      const openBugs = bugs.filter(b => b.status === 'open');
      return {
        _brief: true,
        _hint: `Brief view: ${openBugs.length} open bug(s) listed; ${bugs.length - openBugs.length} non-open omitted (see summary for full status counts). Use --full (or LATTICE_BRIEF_OUTPUT=0) for every bug.`,
        summary,
        bugs: openBugs.map(toBriefBug),
      };
    },

    bug_analyze(args?: { format?: 'json' | 'markdown' }) {
      const report = extractBugs(ctx.root);
      if (args?.format === 'markdown') {
        return { _dashboard: report.markdown, _hint: 'Please display the full Markdown report' };
      }
      return {
        _dashboard: report.markdown,
        _hint: 'Please display the quality report at the top, in Markdown format',
        summary: report.summary,
        bugs: report.bugs,
        storyMetrics: report.storyMetrics,
      };
    },
  };
}
