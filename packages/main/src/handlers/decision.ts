/**
 * Decision (RALPLAN-DR structured decision, OMX ralplan style).
 *
 * The PLAN phase produces a decision.json for each non-trivial story:
 *   - principles (3-5 items)
 *   - drivers (top 3 key constraints)
 *   - options (≥ 2 alternatives + pros/cons; allows an options=[] "single-solution" exit,
 *             but requires rationale ≥ 50 chars and an exclusion rationale explaining why alternatives are not enumerated)
 *   - chosen + rationale
 *   - preMortem (mandatory ≥ 3 for high-risk stories)
 *
 * First-version soft introduction: required by story_review when priority=high or riskSignals is non-empty.
 */

import type { HandlerContext } from './context.js';
import type { DecisionData, DecisionOption, PreMortemScenario } from '../core/types.js';

const EXCLUSION_RATIONALE_RE =
  /\b(excluded?|exclusion|ruled\s+out|not\s+enumerated|not\s+listing|not\s+listed|alternatives?\s+omitted|single[-\s]?solution)\b/i;

const LOCALIZED_EXCLUSION_RATIONALE_RE =
  /(?:\u6392\u9664|\u4e0d\u679a\u4e3e|\u4e0d\u5217\u51fa|\u4e0d\u8003\u8651|\u4e0d\u9700\u8981\u5907\u9009|\u5355\u4e00\u65b9\u6848|\u5176\u4ed6\u5907\u9009|\u66ff\u4ee3\u65b9\u6848)/u;

function hasExclusionRationale(rationale: string): boolean {
  return EXCLUSION_RATIONALE_RE.test(rationale) || LOCALIZED_EXCLUSION_RATIONALE_RE.test(rationale);
}

export function createDecisionHandlers(ctx: HandlerContext) {
  const { store } = ctx;

  return {
    decision_set(args: {
      storyId: string;
      principles: string[];
      drivers: string[];
      options: DecisionOption[];
      chosen: string;
      rationale: string;
      preMortem?: PreMortemScenario[];
    }): string {
      store.readStory(args.storyId); // verify existence

      // field validation
      if (!Array.isArray(args.principles) || args.principles.length < 3 || args.principles.length > 5) {
        throw new Error('decision.principles must be 3-5 items');
      }
      if (!Array.isArray(args.drivers) || args.drivers.length < 1 || args.drivers.length > 5) {
        throw new Error('decision.drivers must be 1-5 items (top 3 recommended)');
      }
      if (!Array.isArray(args.options)) {
        throw new Error('decision.options must be an array');
      }
      if (args.options.length === 0) {
        // Empty-array exit: requires rationale >= 50 chars and an exclusion
        // rationale. Accept common localized phrasing via escaped Unicode so
        // non-English planning text is not rejected by an English keyword check.
        const rationale = args.rationale || '';
        if (rationale.trim().length < 50 || !hasExclusionRationale(rationale)) {
          throw new Error(
            'when options=[], rationale must be >=50 chars and include an exclusion rationale explaining why alternatives were not enumerated; or please provide >= 2 options'
          );
        }
      } else if (args.options.length < 2) {
        // a single option must explain why
        const opt = args.options[0];
        if (!opt.cons || opt.cons.length === 0) {
          throw new Error(
            'when decision.options has only 1 entry, the cons must state the invalidation rationale of "why other alternatives are excluded".' +
            'Otherwise review treats it as "missing fair alternatives" (same requirement as OMX Critic).'
          );
        }
      }
      for (const opt of args.options) {
        if (!opt.name || opt.name.trim().length < 3) {
          throw new Error(`option.name must be ≥ 3 chars: ${JSON.stringify(opt)}`);
        }
        if (!Array.isArray(opt.pros) || opt.pros.length === 0) {
          throw new Error(`option "${opt.name}" is missing pros`);
        }
        if (!Array.isArray(opt.cons) || opt.cons.length === 0) {
          throw new Error(`option "${opt.name}" is missing cons (cannot list only benefits)`);
        }
      }
      if (args.options.length > 0) {
        if (!args.chosen || args.chosen.trim().length < 3) {
        throw new Error('decision.chosen must point to one of the option.name values');
        }
        const chosenExists = args.options.some(o => o.name === args.chosen);
        if (!chosenExists) {
          throw new Error(
            `decision.chosen "${args.chosen}" is not in the options list. Available: ${args.options.map(o => o.name).join(', ')}`
          );
        }
      } else {
        // options=[] exit: chosen field semantics are weakened (no option to point to); allow any non-empty string as the single-solution identifier
        if (!args.chosen || args.chosen.trim().length === 0) {
          throw new Error('decision.chosen cannot be empty (even when options=[], the single solution still needs an identifier)');
        }
      }
      if (!args.rationale || args.rationale.trim().length < 10) {
        throw new Error('decision.rationale must be ≥ 10 characters (explain why this was chosen)');
      }

      // High-risk stories require ≥ 3 preMortem entries
      // B-5010 CHK-004: dismissed riskSignals are not counted toward the high-risk determination
      const story = store.readStory(args.storyId);
      const dismissedCats = new Set((story.riskSignalsDismissed || []).map(d => d.category));
      const activeRiskSignals = (story.riskSignals || []).filter(r => !dismissedCats.has(r.category));
      const isHighRisk = story.priority === 'high' || story.priority === 'critical'
        || activeRiskSignals.length > 0;
      if (isHighRisk) {
        if (!args.preMortem || args.preMortem.length < 3) {
          throw new Error(
            `High-risk story (priority=${story.priority}${story.riskSignals ? ', riskSignals non-empty' : ''}) ` +
            `must provide ≥ 3 preMortem scenarios (current: ${args.preMortem?.length ?? 0}). ` +
            `Each scenario must include the 4 fields scenario/trigger/consequence/mitigation.`
          );
        }
        for (const pm of args.preMortem) {
          if (!pm.scenario || !pm.trigger || !pm.consequence || !pm.mitigation) {
            throw new Error(
              `preMortem entry must contain all 4 non-empty fields scenario/trigger/consequence/mitigation: ${JSON.stringify(pm)}`
            );
          }
        }
      }

      const data: DecisionData = {
        principles: args.principles,
        drivers: args.drivers,
        options: args.options,
        chosen: args.chosen,
        rationale: args.rationale,
        ...(args.preMortem ? { preMortem: args.preMortem } : {}),
        timestamp: new Date().toISOString(),
      };

      store.writeDecision(args.storyId, data);

      const lines = [
        `Decision saved for ${args.storyId}`,
        `  principles:  ${args.principles.length}`,
        `  drivers:     ${args.drivers.length}`,
        `  options:     ${args.options.length} (chosen: ${args.chosen})`,
        `  preMortem:   ${args.preMortem?.length ?? 0}${isHighRisk ? ' (high-risk requires ≥ 3)' : ''}`,
      ];
      return lines.join('\n');
    },

    decision_get(args: { storyId: string }): DecisionData | { _empty: true } {
      const data = store.readDecision(args.storyId);
      if (!data) return { _empty: true };
      return data;
    },
  };
}
