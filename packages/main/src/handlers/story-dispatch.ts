/**
 * story_dispatch — B-45ed CHK-005
 *
 * Generate the standard lattice-implementer prompt string (the main agent copy-pastes it into Agent({subagent_type, prompt})).
 *
 * Core goals:
 *   - Unify the prompt structure the main agent uses to dispatch implementers, avoiding paraphrased pastes of plan.md by the main agent
 *   - The prompt forces references to background.md + plan.md#CHK-xxx paths, making the implementer read them directly
 *   - Does not spawn the subagent; only outputs the string, preserving the main agent's dispatch decision authority
 *
 * agent-type tiered injection (full matrix see CLAUDE.md "background.md tiered injection"):
 *   - required: lattice-implementer / lattice-review-scope-plan / lattice-review-behavior / lattice-review-concept
 *     → first line of prompt labeled "must read", forcing the subagent to read background to understand intent
 *   - advisory: lattice-review-quality / lattice-review-docs
 *     → prompt labeled "optional reference", does not disrupt mechanical check logic
 *   - none: lattice-review-channel
 *     → not injected at all, to avoid mechanical commit author checks being polluted by background noise
 *   - unknown agentType → downgraded to required (safest; better to over-read than miss reading)
 *   - agentType not passed → defaults to lattice-implementer semantics (required)
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { HandlerContext } from './context.js';
import { createClusterHandlers } from './cluster.js';
import type { StoryStore } from '../core/store.js';
import { reportHealthIssue } from '../core/health.js';

// B-45ed CHK-008: agent-type → background injection strategy mapping table
// Source: CLAUDE.md "background.md tiered injection (subagent)" subsection
type BackgroundPolicy = 'required' | 'advisory' | 'none';
const AGENT_BG_POLICY: Record<string, BackgroundPolicy> = {
  'lattice-implementer': 'required',
  'lattice-review-scope-plan': 'required',
  'lattice-review-behavior': 'required',
  'lattice-review-concept': 'required',
  'lattice-review-quality': 'advisory',
  'lattice-review-docs': 'advisory',
  'lattice-review-channel': 'none',
};

const IMPLEMENTER_COMMIT_AUTHOR = 'lattice-implementer <lattice-implementer@noreply.local>';

/** Resolve agentType → injection strategy; unknown agentType downgrades to required (safest). */
function resolveBackgroundPolicy(agentType: string | undefined): BackgroundPolicy {
  if (!agentType) return 'required'; // default lattice-implementer behavior
  return AGENT_BG_POLICY[agentType] ?? 'required';
}

function isReviewAgent(agentType: string | undefined): boolean {
  return !!agentType && agentType.startsWith('lattice-review-');
}

function appendImplementerCommitSteps(lines: string[], message: string): void {
  lines.push(`- git commit --author="${IMPLEMENTER_COMMIT_AUTHOR}" -m "${message.replace(/"/g, "'")}"`);
  lines.push('- Do not omit `--author`; normal-channel author fallback only accepts author=lattice-implementer.');
}

/**
 * B-9d95 CHK-004: Unified dispatch entry.
 *
 * story_dispatch / finding_dispatch / dispatch — these three entries share the same prompt assembly logic, avoiding
 * duplicate implementation. `dispatch` dispatches by itemId / findingId / clusterId; the old entries are kept as aliases,
 * with the first line of stdout printing a deprecation warning while return values remain byte-identical.
 */
export function createStoryDispatchHandlers(ctx: HandlerContext) {
  const { store, root } = ctx;

  function appendDispatchEvent(args: {
    storyId: string;
    agentType?: string;
    targetKind: 'init-review' | 'scope-plan-review' | 'checklist' | 'finding' | 'cluster';
    itemId?: string;
    findingId?: string;
    clusterId?: string;
  }): void {
    try {
      const story = store.readStory(args.storyId);
      const agentType = args.agentType || 'lattice-implementer';
      store.appendProcessEvent(args.storyId, {
        type: 'dispatch',
        storyId: args.storyId,
        phase: story.phase,
        source: 'lattice dispatch',
        targetKind: args.targetKind,
        agentType,
        ...(args.itemId ? { itemId: args.itemId, checklistId: args.itemId } : {}),
        ...(args.findingId ? { findingId: args.findingId } : {}),
        ...(args.clusterId ? { clusterId: args.clusterId } : {}),
      });
    } catch (e: any) {
      reportHealthIssue('persist:dispatchProcessEvent', e as Error, {
        storyId: args.storyId,
        agentType: args.agentType,
        targetKind: args.targetKind,
        itemId: args.itemId,
        findingId: args.findingId,
        clusterId: args.clusterId,
      });
      ctx.log?.(`[process-events] dispatch append failed for ${args.storyId}: ${e?.message || e}`);
    }
  }

  function appendDispatchLivenessGuidance(lines: string[], label: string): void {
    lines.push('Execution rhythm / liveness:');
    lines.push(`- After starting, first output \`DISPATCH_START:${label}\` so the main agent knows the process has started.`);
    lines.push('- If there is no output for 4 minutes, the main agent should ask about status once; if there is still no result after 10 minutes/600s, consider it stalled and feel free to restart this reviewer/worker.');
    lines.push('- If this is a retry, please explain the previous stalled state in the final reply, to avoid mistaking network/startup failures for review conclusions.');
    lines.push('');
  }

  function buildInitReviewPrompt(args: {
    storyId: string;
    agentType?: string;
  }): { prompt: string } {
    if (!args.storyId) throw new Error('storyId is required');
    try {
      store.readStory(args.storyId);
    } catch {
      throw new Error(`story ${args.storyId} not found`);
    }
    const bgPath = `${store.storyDirRel()}/${args.storyId}/background.md`;
    const checklistPath = `${store.storyDirRel()}/${args.storyId}/checklist.json`;
    return {
      prompt: [
        `Review the initial background + checklist for story ${args.storyId}.`,
        '',
        'You are the lattice-review-story-init reviewer; please review in a fresh context, do not carry over the main agent\'s conclusions.',
        `Must read: ${bgPath}`,
        `Must read: ${checklistPath}`,
        '',
        'Review focus:',
        '- Whether the background sufficiently explains the triggering event, key insights, trade-offs in the approach, and conversational texture',
        '- Whether the checklist is broken down into items that are user-observable, verifiable, and non-overlapping',
        '- Whether there are high-risk signals but insufficient PLAN/decision/verification preparation',
        '',
        'Execution rhythm / timeout:',
        '- After starting, first output `INIT_REVIEW_START`; after finishing reading background/checklist, output `INIT_REVIEW_READ_DONE`.',
        '- Within 5 minutes at the latest, you must choose one of two: call init_check_set, or output an explicit blocker + current blocking point.',
        '- If there is no output for 4 minutes, the main agent should treat the reviewer as stuck and may rerun this dispatch to restart the reviewer.',
        '',
        'Hard requirements:',
        `- Regardless of whether the conclusion is pass or fail, you must call init_check_set once to record the result; merely outputting a textual conclusion does not count as complete.`,
        `- When issues are found, also call: lattice init_check_set '{"storyId":"${args.storyId}","issues":[{"severity":"low","desc":"..."}],"agentId":"lattice-review-story-init"}'`,
        `- If there are no issues, pass an empty array for issues: lattice init_check_set '{"storyId":"${args.storyId}","issues":[],"agentId":"lattice-review-story-init"}'`,
        '- The INIT_CHECK gate also requires product-reviewer to call init_check_set; you are only responsible for the lattice-review-story-init record.',
        '- Do not directly edit story files.',
      ].join('\n'),
    };
  }

  function buildProductInitReviewPrompt(args: {
    storyId: string;
    agentType?: string;
  }): { prompt: string } {
    if (!args.storyId) throw new Error('storyId is required');
    try {
      store.readStory(args.storyId);
    } catch {
      throw new Error(`story ${args.storyId} not found`);
    }
    const bgPath = `${store.storyDirRel()}/${args.storyId}/background.md`;
    const checklistPath = `${store.storyDirRel()}/${args.storyId}/checklist.json`;
    return {
      prompt: [
        `Review whether the INIT of story ${args.storyId} is ready to advance, from a user value perspective.`,
        '',
        'You are product-reviewer, not lattice-review-story-init. Please review in a fresh context, do not carry over the main agent\'s conclusions.',
        `Must read: ${bgPath}`,
        `Required reading: ${checklistPath}`,
        '',
        'Review focus:',
        '- Whether the background clearly explains why the user needs this, not just the engineering mechanics',
        '- Whether each checklist item has a user-observable outcome',
        '- Whether the post-completion outcome lets the user recognize the work as complete, rather than still wondering what comes next',
        '',
        'Hard requirements:',
        '- Whether the conclusion is pass or fail, you must call init_check_set once to record the result; outputting only a text conclusion does not count as complete.',
        `- agentId must be passed exactly as "product-reviewer". Do not pass "lattice-review-story-init"; that is a different reviewer and will cause the INIT_CHECK gate to keep reporting a missing product-reviewer.`,
        `- When issues are found, also call: lattice init_check_set '{"storyId":"${args.storyId}","issues":[{"severity":"medium","desc":"..."}],"agentId":"product-reviewer"}'`,
        `- If there are no issues, pass an empty array for issues: lattice init_check_set '{"storyId":"${args.storyId}","issues":[],"agentId":"product-reviewer"}'`,
        '- critical/high issues will hard-block INIT_CHECK; medium/low will be recorded as advisory.',
        '- Do not edit story files directly.',
      ].join('\n'),
    };
  }

  function buildScopePlanReviewPrompt(args: {
    storyId: string;
    agentType?: string;
  }): { prompt: string } {
    if (!args.storyId) throw new Error('storyId is required');
    const story = (() => {
      try {
        return store.readStory(args.storyId);
      } catch {
        throw new Error(`story ${args.storyId} not found`);
      }
    })();
    if (story.phase !== 'PLAN') {
      throw new Error(
        `scope_check_save is PLAN-only; current phase ${story.phase} is unsupported for ` +
        `story-level lattice-review-scope-plan dispatch on ${args.storyId}. ` +
        'Run this dispatch only while the story is in PLAN, or use lattice session_brief / lattice next for current-phase guidance.',
      );
    }

    const storyDir = `${store.storyDirRel()}/${args.storyId}`;
    const bgPath = `${storyDir}/background.md`;
    const understandingPath = `${storyDir}/understanding.json`;
    const checklistPath = `${storyDir}/checklist.json`;
    const planPath = `${storyDir}/plan.md`;
    const decisionPath = `${storyDir}/decision.json`;
    const routed = store.readCandidateSpecSet(args.storyId);

    const lines: string[] = [];
    lines.push(`Review PLAN scope coverage for story ${args.storyId}.`);
    lines.push('');
    lines.push('You are the lattice-review-scope-plan reviewer; review in a fresh context and do not carry over the main agent\'s conclusions.');
    lines.push(`Working directory (subagent must cd here): ${root}`);
    lines.push('');
    appendDispatchLivenessGuidance(lines, 'lattice-review-scope-plan/story-scope');
    lines.push('Role boundary:');
    lines.push('- Review only; do not change code, tests, checklist items, plan text, or story metadata.');
    lines.push('- Dispatch output is not gate evidence; only scope_check_save writes the PLAN scope evidence consumed by story_review.');
    lines.push('');
    lines.push('Must read story artifacts:');
    lines.push(`1. ${bgPath}`);
    lines.push(`2. ${understandingPath}`);
    lines.push(`3. ${checklistPath}`);
    lines.push(`4. ${planPath}`);
    lines.push(`5. ${decisionPath} (if present)`);
    lines.push('- Also read relatedDocs referenced by checklist items and any decisions/docs cited by the story artifacts.');
    if (routed) {
      lines.push(`- Current bounded candidate artifact: digest=${routed.artifactDigest} corpusDigest=${routed.corpusDigest}`);
      lines.push(`- Fully inspect routed candidates as relevant: ${routed.candidateSpecSet.join(', ') || '(none)'}`);
      lines.push(`- Ambiguity signals: ${routed.ambiguitySignals.join(', ') || 'none'}; scanEscalationReason=${routed.scanEscalationReason ?? 'null'}`);
    } else {
      lines.push('- No candidate-spec-set artifact is present. In enforce mode stop and ask the Story owner to run candidate_spec_route; reviewer lanes must not seize owner authority.');
    }
    lines.push('');
    lines.push('Review focus:');
    lines.push('- Identify every user-visible promise, scope constraint, exclusion, and acceptance expectation in the story artifacts.');
    lines.push('- Classify each feature as covered, excluded, gap, orphan-suspect, or drift using the scope_check_save schema.');
    lines.push('- Record open questions when the artifacts conflict or a promise is visible but cannot be safely classified.');
    lines.push('- Track readManifest with filesReadFully, filesTriagedByName, scanEscalationReason, candidateSpecSetDigest, and corpusDigest. Put full-read files in filesReadFully, filename/title-only triage in filesTriagedByName, and use scanEscalationReason only for a justified tool-driven full decisions-directory scan.');
    lines.push('');
    lines.push('Finish by calling scope_check_save:');
    lines.push(`- lattice scope_check_save '{"storyId":"${args.storyId}","features":[{"feature":"<promise or constraint>","covered_by":"<CHK-xxx or null>","status":"covered|excluded|gap|orphan-suspect|drift","excluded_by":"<reason or null>","source":"<artifact path>"}],"summary":{"total":1,"covered":0,"excluded":0,"gaps":1},"readManifest":{"filesReadFully":["docs/requirements/decisions/<candidate>.md"],"filesTriagedByName":["docs/requirements/decisions/<triaged>.md"],"scanEscalationReason":null,"candidateSpecSetDigest":"${routed?.artifactDigest ?? '<current candidate artifact digest>'}","corpusDigest":"${routed?.corpusDigest ?? '<current corpus digest>'}"},"openQuestions":[]}'`);
    lines.push('- If there are no gaps, still call scope_check_save with the complete feature list and accurate summary counts.');

    return { prompt: lines.join('\n') };
  }

  function buildFindingPrompt(args: {
    storyId: string;
    findingId: string;
    agentType?: string;
  }): { prompt: string } {
      if (!args.storyId) throw new Error('storyId is required');
      if (!args.findingId) throw new Error('findingId is required');

      const agentType = args.agentType;

      // 1. story existence check (message is clearer than readStory's native error)
      try {
        store.readStory(args.storyId);
      } catch {
        throw new Error(`story ${args.storyId} not found`);
      }

      // 2. finding lookup (id in findings.json is in "B-xxx:F-NNN" format; allow caller to pass short form "F-NNN" or long form)
      const data = store.readFindings(args.storyId);
      const wantShort = args.findingId.startsWith(`${args.storyId}:`)
        ? args.findingId.slice(args.storyId.length + 1)
        : args.findingId;
      const finding = data.findings.find(
        f => f.id === args.findingId || f.id === `${args.storyId}:${wantShort}`,
      );
      if (!finding) {
        throw new Error(`${args.findingId} not found in story ${args.storyId}`);
      }

      // 3. background.md existence
      const bgPath = `${store.storyDirRel()}/${args.storyId}/background.md`;
      const bgAbs = join(root, bgPath);
      const bgExists = existsSync(bgAbs);

      // 4. agent-type tiered injection decision (fully reuses story_dispatch's AGENT_BG_POLICY)
      const bgPolicy = resolveBackgroundPolicy(agentType);
      const displayAgent = agentType || 'lattice-implementer';

      // 5. finding field fallback. Note: Finding schema has no separate location/suggestion fields—
      //    reviewer writes file:line and fix suggestions directly in the desc body (by convention), so they are no longer rendered separately here.
      const fDesc = finding.desc || '(not provided)';
      const fSeverity = finding.severity || '(not provided)';
      const fCategory = finding.category || '(not provided)';
      const fReviewer = finding.agent || '(not provided)';

      // 6. assemble prompt
      const lines: string[] = [];
      // First line: use desc as short title (Finding schema has no separate title field), truncated to 80 characters
      const shortTitle = fDesc.length > 80 ? fDesc.slice(0, 80) + '…' : fDesc;
      // finding.id is already in "B-45ed:F-001" form; strip the storyId prefix when displaying to avoid duplicate "B-45ed B-45ed:F-001"
      const shortFid = finding.id.startsWith(`${args.storyId}:`)
        ? finding.id.slice(args.storyId.length + 1)
        : finding.id;
      lines.push(`As ${displayAgent}, fix ${args.storyId} ${shortFid}: ${shortTitle}`);
      lines.push('');

      // B-9d95 CHK-001: inject worktree absolute path. Root cause review (B-ed3e F-001): subagent inherits parent process cwd
      // which does not necessarily fall in the worktree (especially cross-repo scenarios), causing reviewer/handler to read docs/story/... at the main repo cwd
      // and miss the worktree copy, leading to false reports. ctx.root was bound to the worktree root at MCP handler init,
      // making it the most reliable absolute path source currently (better than process.cwd()—which depends on the caller shell's current directory).
      lines.push(`Working directory (subagent must cd here): ${root}`);
      lines.push('');
      appendDispatchLivenessGuidance(lines, `${displayAgent}/${shortFid}`);

      if (bgPolicy === 'required') {
        const prefix = bgExists ? '' : '⚠ missing, strongly recommend running `lattice background_set` first — ';
        lines.push(`Required reading: ${prefix}${bgPath}`);
        lines.push('');
      } else if (bgPolicy === 'advisory') {
        const prefix = bgExists ? '' : '⚠ missing — ';
        lines.push(`Optional reference: ${prefix}${bgPath}`);
        lines.push('');
      }
      // bgPolicy === 'none' → do not inject the background line at all

      lines.push(`Severity: ${fSeverity}  Category: ${fCategory}  Reviewer: ${fReviewer}`);
      lines.push(`Description: ${fDesc}`);
      lines.push('');
      lines.push('After completion:');
      appendImplementerCommitSteps(lines, `${args.storyId} ${shortFid}: resolve finding`);
      lines.push(`- lattice finding_resolve '{"storyId":"${args.storyId}","findingId":"${finding.id}","resolution":"<your fix description>"}'`);

      return { prompt: lines.join('\n') };
  }

  function buildItemPrompt(args: {
    storyId: string;
    itemId: string;
    agentType?: string;
  }): { prompt: string } {
      if (!args.storyId) throw new Error('storyId is required');
      if (!args.itemId) throw new Error('itemId is required');

      const agentType = args.agentType;

      // 1. story existence check (readStory's error message is not clear enough; wrap a layer)
      let story;
      try {
        story = store.readStory(args.storyId);
      } catch {
        throw new Error(`story ${args.storyId} not found`);
      }

      // 2. checklist item lookup
      const cl = store.readChecklist(args.storyId);
      const item = cl.items.find(i => i.id === args.itemId);
      if (!item) {
        throw new Error(`${args.itemId} not found in story ${args.storyId}`);
      }

      // 3. extract the corresponding CHK section from plan.md (optional—plan.md may not exist; fall back)
      const planSection = extractPlanSection(store, args.storyId, args.itemId);

      // 4. background.md existence detection (if missing → warning prefix, no crash)
      const bgPath = `${store.storyDirRel()}/${args.storyId}/background.md`;
      const bgAbs = join(root, bgPath);
      const bgExists = existsSync(bgAbs);

      // 5. extract Verify section from the plan.md section (fall back if not found)
      const verifyText = extractVerifyFromSection(planSection) || 'lattice validate all green';

      // 6. Files section rendering (if item.files is missing, display "(not declared)")
      const filesBlock = renderFilesBlock(item.files);

      // 7. background injection decision (B-45ed CHK-008 full tiered matrix)
      //    policy comes from AGENT_BG_POLICY (CLAUDE.md tiered matrix):
      //    - required → written into the first line of the "Required reading" section
      //    - advisory → write into the "optional reference" section
      //    - none     → do not inject at all
      const bgPolicy = resolveBackgroundPolicy(agentType);

      if (isReviewAgent(agentType)) {
        const displayAgent = agentType!;
        const lines: string[] = [];
        lines.push(`As ${displayAgent} reviewing ${args.storyId} ${args.itemId}: ${item.title}`);
        lines.push('');
        lines.push(`Working directory (subagent must cd here): ${root}`);
        lines.push('');
        appendDispatchLivenessGuidance(lines, `${displayAgent}/${args.itemId}`);
        lines.push('Role boundary:');
        lines.push('- Review only; do not change code, write tests, or update the checklist.');
        lines.push('- fresh-context reading materials; independently judge whether there is a blocker or an issue that requires rework.');
        lines.push('');
        lines.push('Review materials:');
        let idx = 1;
        if (bgPolicy === 'required') {
          const prefix = bgExists ? '' : '⚠ missing, strongly recommend writing `lattice background_set` first — ';
          lines.push(`${idx}. Required reading background.md to understand intent — ${prefix}${bgPath}`);
          idx++;
        }
        const planRef = `${store.storyDirRel()}/${args.storyId}/plan.md#${args.itemId}`;
        lines.push(`${idx}. ${planRef}`);
        idx++;
        const seen = new Set<string>([bgPath, planRef]);
        if (Array.isArray(item.relatedDocs) && item.relatedDocs.length > 0) {
          for (const doc of item.relatedDocs) {
            if (seen.has(doc)) continue;
            seen.add(doc);
            lines.push(`${idx}. ${doc}`);
            idx++;
          }
        }
        if (bgPolicy === 'advisory') {
          const prefix = bgExists ? '' : '⚠ missing — ';
          lines.push('');
          lines.push(`Optional reference background.md (understand intent, but this agent focuses on review duties): ${prefix}${bgPath}`);
        }
        lines.push('');
        lines.push(`Context: ${item.context || '(not declared)'}`);
        lines.push('');
        lines.push('Files:');
        lines.push(`- Modify: ${filesBlock.modify}`);
        lines.push(`- Create: ${filesBlock.create}`);
        lines.push(`- Test:   ${filesBlock.test}`);
        lines.push('');
        lines.push(`Verify expectation: ${verifyText}`);
        const routed = store.readCandidateSpecSet(args.storyId);
        if (routed) {
          lines.push(`Candidate routing: digest=${routed.artifactDigest} corpusDigest=${routed.corpusDigest} candidates=${routed.candidateSpecSet.join(', ') || '(none)'}`);
        }
        lines.push('');
        lines.push('Conclusion record (must choose one of two):');
        lines.push(`- First start this round's reviewer run: lattice review_run_start '{"storyId":"${args.storyId}","agent":"${displayAgent}"}', copy the reviewRunId from the output`);
        lines.push(`- Has issues: lattice finding_add '{"storyId":"${args.storyId}","reviewRunId":"<reviewRunId from review_run_start>","desc":"<file:line WHY + severity>","severity":"high|medium|low","category":"missing|edge|adversarial|happy","agent":"${displayAgent}"}'`);
        lines.push('- Track readManifest with filesReadFully, filesTriagedByName, scanEscalationReason, candidateSpecSetDigest, and corpusDigest; include it on no-blocker review_pass_set. Non-decision entries remain signed manifest evidence; mechanical decisions-doc read mismatch fails closed.');
        lines.push(`- No blocker: lattice review_pass_set '{"storyId":"${args.storyId}","agent":"${displayAgent}","reviewRunId":"<reviewRunId from review_run_start>","note":"reviewed ${args.itemId}: checked implementation against the item context and found no blocker.","readManifest":{"filesReadFully":["<file reviewed in full>"],"filesTriagedByName":["<file triaged by name>"],"scanEscalationReason":null,"candidateSpecSetDigest":"${routed?.artifactDigest ?? '<current candidate artifact digest>'}","corpusDigest":"${routed?.corpusDigest ?? '<current corpus digest>'}"}}'`);

        void story;

        return { prompt: lines.join('\n') };
      }

      // 8. Assemble implementer prompt
      const lines: string[] = [];
      lines.push(`As lattice-implementer implementing ${args.storyId} ${args.itemId}: ${item.title}`);
      lines.push('');
      // B-9d95 CHK-001: inject worktree absolute path. Root cause retrospective (B-ed3e F-001): subagent inherits parent process cwd
      // which does not necessarily land in the worktree (especially cross-repo scenarios), causing reviewer/handler to read docs/story/... in the main repo cwd
      // failing to see the worktree copy and producing false reports. ctx.root is already bound to the worktree root at MCP handler initialization,
      // and is currently the most reliable absolute path source (better than process.cwd()—the latter depends on the caller's shell current directory).
      lines.push(`Working directory (subagent must cd here): ${root}`);
      lines.push('');
      appendDispatchLivenessGuidance(lines, `${agentType || 'lattice-implementer'}/${args.itemId}`);
      lines.push('Required reading (in order):');
      let idx = 1;
      if (bgPolicy === 'required') {
        const prefix = bgExists ? '' : '⚠ missing, strongly recommend writing `lattice background_set` first — ';
        lines.push(`${idx}. Required reading background.md to understand intent — ${prefix}${bgPath}`);
        idx++;
      }
      const planRef = `${store.storyDirRel()}/${args.storyId}/plan.md#${args.itemId}`;
      lines.push(`${idx}. ${planRef}`);
      idx++;
      // relatedDocs append (dedupe: skip background.md / plan.md that already appeared earlier)
      const seen = new Set<string>([bgPath, planRef]);
      if (Array.isArray(item.relatedDocs) && item.relatedDocs.length > 0) {
        for (const doc of item.relatedDocs) {
          if (seen.has(doc)) continue;
          seen.add(doc);
          lines.push(`${idx}. ${doc}`);
          idx++;
        }
      }
      // B-45ed CHK-008: advisory agent appends an "optional reference" line after the required reading section; none agent does not output the background line at all
      if (bgPolicy === 'advisory') {
        const prefix = bgExists ? '' : '⚠ missing — ';
        lines.push('');
        lines.push(`Optional reference background.md (understand intent, but this agent focuses on mechanical checks): ${prefix}${bgPath}`);
      }
      lines.push('');
      lines.push(`Context: ${item.context || '(not declared)'}`);
      lines.push('');
      lines.push('Files:');
      lines.push(`- Modify: ${filesBlock.modify}`);
      lines.push(`- Create: ${filesBlock.create}`);
      lines.push(`- Test:   ${filesBlock.test}`);
      lines.push('');
      lines.push(`Verify: ${verifyText}`);
      lines.push('');
      lines.push('After completion:');
      appendImplementerCommitSteps(lines, `${args.storyId} ${args.itemId}: ${item.title}`);
      lines.push(`- lattice checklist_update '{"storyId":"${args.storyId}","itemId":"${args.itemId}","status":"done"}'`);

      // Use story.phase to eliminate unused variable warning (also convenient for reading context when extending CHK-008)
      void story;

      return { prompt: lines.join('\n') };
  }

  return {
    /**
     * dispatch — B-9d95 CHK-004 unified entry
     * (B-a4e3 CHK-005: the deprecated finding_dispatch / story_dispatch alias methods were removed;
     * dispatch is now the only entry. buildItemPrompt / buildFindingPrompt remain — they are used here.)
     *
     * Dispatch by exactly one of itemId / findingId / clusterId; if only
     * agentType=lattice-review-story-init/product-reviewer/lattice-review-scope-plan is passed,
     * generate the corresponding story-level reviewer prompt.
     *
     * Mutual exclusion validation: exactly one of the three must be provided; more / fewer both throw Error.
     * Returns: { prompt: string } — byte-identical to the old entry (clusterId branch reuses cluster.ts text).
     */
    dispatch(args: {
      storyId: string;
      itemId?: string;
      findingId?: string;
      clusterId?: string;
      agentType?: string;
    }): { prompt: string } {
      if (!args.storyId) throw new Error('storyId is required');

      const provided = [
        args.itemId ? 'itemId' : null,
        args.findingId ? 'findingId' : null,
        args.clusterId ? 'clusterId' : null,
      ].filter(Boolean);
      const normalizedAgentType = args.agentType;
      if (provided.length === 0 && normalizedAgentType === 'lattice-review-story-init') {
        const result = buildInitReviewPrompt({
          storyId: args.storyId,
          agentType: args.agentType,
        });
        appendDispatchEvent({
          storyId: args.storyId,
          agentType: args.agentType,
          targetKind: 'init-review',
        });
        return result;
      }
      if (provided.length === 0 && normalizedAgentType === 'product-reviewer') {
        const result = buildProductInitReviewPrompt({
          storyId: args.storyId,
          agentType: args.agentType,
        });
        appendDispatchEvent({
          storyId: args.storyId,
          agentType: args.agentType,
          targetKind: 'init-review',
        });
        return result;
      }
      if (provided.length === 0 && normalizedAgentType === 'lattice-review-scope-plan') {
        const result = buildScopePlanReviewPrompt({
          storyId: args.storyId,
          agentType: args.agentType,
        });
        appendDispatchEvent({
          storyId: args.storyId,
          agentType: args.agentType,
          targetKind: 'scope-plan-review',
        });
        return result;
      }
      if (provided.length !== 1) {
        throw new Error('dispatch requires exactly one of itemId / findingId / clusterId; story-level reviewers may pass only agentType=lattice-review-story-init, product-reviewer, or lattice-review-scope-plan');
      }

      if (args.itemId) {
        const result = buildItemPrompt({
          storyId: args.storyId,
          itemId: args.itemId,
          agentType: args.agentType,
        });
        appendDispatchEvent({
          storyId: args.storyId,
          agentType: args.agentType,
          targetKind: 'checklist',
          itemId: args.itemId,
        });
        return result;
      }
      if (args.findingId) {
        const result = buildFindingPrompt({
          storyId: args.storyId,
          findingId: args.findingId,
          agentType: args.agentType,
        });
        appendDispatchEvent({
          storyId: args.storyId,
          agentType: args.agentType,
          targetKind: 'finding',
          findingId: args.findingId,
        });
        return result;
      }
      // clusterId branch — reuse cluster.ts's finding_dispatch (outputs string).
      // Wrap as { prompt } to keep the interface consistent.
      const clusterHandlers = createClusterHandlers(ctx);
      const prompt = clusterHandlers.finding_dispatch({
        storyId: args.storyId,
        clusterId: args.clusterId!,
      });
      appendDispatchEvent({
        storyId: args.storyId,
        agentType: args.agentType,
        targetKind: 'cluster',
        clusterId: args.clusterId!,
      });
      return { prompt };
    },
  };
}

/** Extract the paragraph between `## {itemId}:` and the next `^## ` from plan.md */
function extractPlanSection(store: StoryStore, storyId: string, itemId: string): string | null {
  const planPath = store.storyFilePath(storyId, 'plan.md');
  if (!existsSync(planPath)) return null;
  const content = readFileSync(planPath, 'utf-8');
  const lines = content.split('\n');
  const startRe = new RegExp(`^## ${itemId}:`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (startRe.test(lines[i])) { start = i; break; }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

/**
 * Extract the content after **Verify**: from the CHK-xxx section of plan.md, until encountering the next **xxx**: bold field or section end.
 * Preserve bullet form; join multiple lines with "; " for single-line display.
 */
function extractVerifyFromSection(section: string | null): string | null {
  if (!section) return null;
  const lines = section.split('\n');
  let verifyStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\*\*Verify\*\*\s*:/.test(lines[i])) { verifyStart = i; break; }
  }
  if (verifyStart === -1) return null;
  // Collect verify blocks
  const out: string[] = [];
  const firstLine = lines[verifyStart].replace(/^\*\*Verify\*\*\s*:\s*/, '').trim();
  if (firstLine) out.push(firstLine);
  for (let i = verifyStart + 1; i < lines.length; i++) {
    const ln = lines[i];
    // Stop at the next bold field (**Xxx**:) or at the end of the next blank line
    if (/^\*\*\w+\*\*\s*:/.test(ln)) break;
    if (ln.trim() === '' && out.length > 0) {
      // Allow intermediate blank lines, but stop on bold after consecutive blank lines
      continue;
    }
    const bullet = ln.trim().replace(/^-\s*/, '');
    if (bullet) out.push(bullet);
  }
  return out.length > 0 ? out.join('; ') : null;
}

function renderFilesBlock(
  files:
    | {
        readonly modify: readonly string[];
        readonly create: readonly string[];
        readonly test: readonly string[];
      }
    | undefined,
): { modify: string; create: string; test: string } {
  const fmt = (arr: readonly string[] | undefined) =>
    arr && arr.length > 0 ? arr.join(', ') : '(not declared)';
  return {
    modify: fmt(files?.modify),
    create: fmt(files?.create),
    test: fmt(files?.test),
  };
}
