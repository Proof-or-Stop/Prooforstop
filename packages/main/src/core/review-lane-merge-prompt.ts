/**
 * EXPERIMENTAL A/B review.laneMerge=on (core/review-lane-merge.ts): the prompt
 * material each merged dimension brings into the carrier's ONE session beyond
 * the carrier's own assembled prompt (which already holds the shared Story
 * context, the verbatim request, the probe evidence and the carrier lane's role
 * prompt): the dimension lane's full role prompt (the same body review_run_start
 * would assemble for it) and the lane-specific dispatch rules that only that
 * lane's dispatch prompt carries (handlers/story-dispatch.ts buildStoryReviewPrompt):
 * the exact-text rubric of the test-coverage lane and the sibling-parity check
 * (review.siblingParity) of the test-coverage and quality lanes.
 *
 * Kept apart from core/review-lane-merge.ts so the roster chokepoint
 * (handlers/reviewer-list.ts) does not import the prompt registry; it takes the
 * request text from its caller so it adds no store edge to the import graph.
 */
import { canonicalAgentRoleId } from './agent-role-identity.js';
import { loadConfig } from './config.js';
import { resolvePromptRoleBody } from './prompt-role-contract-registry.js';
import { renderExactTextRubric } from './request-authority.js';
import type { LaneMergeDimensionSection, LaneMergePlan } from './review-lane-merge.js';
import { renderSiblingParity } from './sibling-parity.js';

const TEST_COVERAGE_LANE = 'proof-or-stop-review-test-coverage';

/** `requestText`: the Story's verbatim request.md text ('' when absent or tampered), read by the caller. */
export function laneMergeDimensionSections(root: string, requestText: string, plan: LaneMergePlan): LaneMergeDimensionSection[] {
  let promptEnvelope: unknown;
  try { promptEnvelope = loadConfig(root).promptEnvelope; } catch { promptEnvelope = undefined; }
  // The role bodies end in the same framework rules (about 16.7 KB); the carrier's own role prompt above
  // already carries them, so each other dimension contributes only its own part (and no frontmatter).
  let carrierBody = '';
  try { carrierBody = plan.carrier ? resolvePromptRoleBody(plan.carrier, promptEnvelope).body : ''; } catch { carrierBody = ''; }
  return plan.mergedLanes.map(raw => {
    const lane = canonicalAgentRoleId(raw);
    if (lane === plan.carrier) return { lane, roleBody: null, extras: [] };
    let roleBody: string | null = null;
    const extras: string[] = [];
    try {
      roleBody = ownRolePart(resolvePromptRoleBody(lane, promptEnvelope).body, carrierBody);
    } catch (error) {
      // Never silently drop a dimension: its checkpoints stay in the block and the note must still cover them.
      extras.push(`(The ${lane} role prompt could not be loaded: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}. Apply the concern and every checkpoint above in full.)`);
    }
    if (lane === TEST_COVERAGE_LANE && requestText) extras.push(...renderExactTextRubric(requestText));
    extras.push(...renderSiblingParity(root, lane));
    return { lane, roleBody, extras };
  });
}

/** Shared tails shorter than this are kept (they are not the framework's shared rules). */
const SHARED_TAIL_MIN_CHARS = 1024;

/**
 * A dimension's own role text: the role body without its frontmatter and
 * without the tail it shares with the carrier's role body (replaced by one line
 * pointing at the carrier's copy). Exported for the unit smoke.
 */
export function ownRolePart(body: string, carrierBody: string): string {
  const strip = (text: string) => text.replace(/^---\n[\s\S]*?\n---\n/, '');
  const own = strip(body);
  const other = strip(carrierBody);
  let shared = 0;
  while (shared < own.length && shared < other.length && own[own.length - 1 - shared] === other[other.length - 1 - shared]) shared += 1;
  // Cut at a line start so no rule is split.
  const cut = own.indexOf('\n', own.length - shared);
  if (shared < SHARED_TAIL_MIN_CHARS || cut < 0) return own.trim();
  return `${own.slice(0, cut).trim()}\n(The shared framework rules that end this role prompt are identical to the end of your own role prompt above and apply here too; they are not repeated.)`;
}
