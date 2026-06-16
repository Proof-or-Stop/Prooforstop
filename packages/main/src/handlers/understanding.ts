/**
 * Understanding (Pre-context Intake snapshot).
 *
 * The main agent structures and records the understanding of the task before breaking down the checklist in the PLAN phase.
 * Embodies the "no snapshot, no starting work" discipline.
 *
 * First version soft introduction: only hint reminder when not filled, does not block advancement. Decide whether to harden the gate once enough data is collected.
 */

import type { HandlerContext } from './context.js';
import type { UnderstandingData } from '../core/types.js';
export function createUnderstandingHandlers(ctx: HandlerContext) {
  const { store } = ctx;

  return {
    understanding_set(args: {
      storyId: string;
      task: string;
      outcome: string;
      facts: string[];
      constraints: string[];
      unknowns: string[];
      touchpoints: string[];
    }): string {
      // Verify the story exists
      store.readStory(args.storyId);

      // Basic field validation: task / outcome at least 5 characters
      if (!args.task || args.task.trim().length < 5) {
        throw new Error('understanding.task must be ≥ 5 characters (one-sentence description of the problem to solve)');
      }
      if (!args.outcome || args.outcome.trim().length < 5) {
        throw new Error('understanding.outcome must be ≥ 5 characters (what change can be observed after completion)');
      }
      if (!Array.isArray(args.facts)) throw new Error('facts must be an array');
      if (!Array.isArray(args.constraints)) throw new Error('constraints must be an array');
      if (!Array.isArray(args.unknowns)) throw new Error('unknowns must be an array');
      if (!Array.isArray(args.touchpoints)) throw new Error('touchpoints must be an array');

      const data: UnderstandingData = {
        task: args.task,
        outcome: args.outcome,
        facts: args.facts,
        constraints: args.constraints,
        unknowns: args.unknowns,
        touchpoints: args.touchpoints,
        timestamp: new Date().toISOString(),
      };

      store.writeUnderstanding(args.storyId, data);

      const summary = [
        `Understanding saved for ${args.storyId}`,
        `  task:        ${args.task.slice(0, 60)}${args.task.length > 60 ? '…' : ''}`,
        `  outcome:     ${args.outcome.slice(0, 60)}${args.outcome.length > 60 ? '…' : ''}`,
        `  facts:       ${args.facts.length}`,
        `  constraints: ${args.constraints.length}`,
        `  unknowns:    ${args.unknowns.length}`,
        `  touchpoints: ${args.touchpoints.length}`,
      ];

      // Soft reminder: when unknowns > 0, suggest digesting them before breaking down the checklist
      if (args.unknowns.length > 0) {
        summary.push('');
        summary.push(`⚠ There are still ${args.unknowns.length} unknowns. Suggest investigating before breaking down the checklist:`);
        for (const u of args.unknowns.slice(0, 5)) {
          summary.push(`  - ${u}`);
        }
      }

      // Soft reminder: prompt to add touchpoints when empty
      if (args.touchpoints.length === 0) {
        summary.push('');
        summary.push('⚠ touchpoints is empty. You may not have figured out which files this change will affect yet — filling it in helps the reviewer review better.');
      }

      return summary.join('\n');
    },

    understanding_get(args: { storyId: string }): UnderstandingData | { _empty: true } {
      const data = store.readUnderstanding(args.storyId);
      if (!data) return { _empty: true };
      return data;
    },
  };
}
