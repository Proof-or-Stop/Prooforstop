/**
 * @task B-ef9c
 * @checklist CHK-001
 * @title story review enforces multi layer requirement completeness
 * @type feature
 * @priority high
 * @description
 *   Requirement completeness has no silver bullet; Proofbound lowers omission risk
 *   through multiple defenses: understanding, decision, scope check, related
 *   docs, checklist quality, verificationIntent lanes, and reviewer prompts.
 *   Agent A is responsible for decomposing requirements and implementing code,
 *   while review checks whether the plan has enough structure before DEV.
 * @changes
 *   - [CHK-001] Review checklist item quality and reject weak or empty items
 *   - [CHK-001] Require qualified items to carry observable userSees plus happy/edge/adversarial verification intent in strict paths
 */

import type { HandlerContext } from './context.js';
import type { StoryInfo, ScopeContractData } from '../core/types.js';
import type { ParallelGateConfig } from '../core/parallel-decomposition.js';
import { assertCwdInWorktree } from './context.js';
import { loadConfig } from '../core/config.js';
import { computeChannel, resolveWorkflowPolicy } from '../core/workflow-policy.js';
import { evaluateDecompositionGate } from '../core/parallel-decomposition-gate.js';
import { resolveAuditConfig } from '../core/audit-config.js';
import { safeReadScopeContract } from '../core/lattice-parallel-wave.js';
import { computeProcessMetrics } from '../core/process-metrics.js';
import { SCOPE_CHECK_SALT, signScopeCheck } from './scope-check.js';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { VERIFICATION_LANES, collectVerificationIntents, detectLegacyEvidenceWithoutIntent, VERIFICATION_INTENT_REPAIR_COMMAND } from '../core/verification.js';
import { surfaceExperienceHints } from '../core/experience-hint-surface.js';
import { evaluateProofStoryDiagnostics, renderProofStoryDiagnosticReport } from '../core/proofstory.js';

function normalizeTouchpointPath(value: string): string {
  const trimmed = value
    .trim()
    .replace(/^[-*]\s+/, '')
    .replace(/^`|`$/g, '')
    .trim();
  const firstSegment = trimmed.split(/\s+\(/)[0].split(/\s+-\s+/)[0].trim();
  const token = firstSegment.split(/\s+/)[0] || firstSegment;
  return token.replace(/[),:;]+$/g, '').replace(/^`|`$/g, '').trim();
}

/**
 * Story 4 (B-fa7c): surface evaluateDecompositionGate()'s ADVISORIES at REVIEW as
 * advisory-severity issues. The gate's `block` field is INTENTIONALLY ignored here —
 * REVIEW is advisory-only; enforcement (turning a block into a blocker) is Story 5.
 * Pure: no I/O. blockerCount filters severity==='blocker', so these never block REVIEW.
 *
 * mode='off' is the reversible escape hatch (spec §4.7): it disables BOTH gate behaviors,
 * so it short-circuits to [] BEFORE calling the (deliberately mode-agnostic, §4.4) gate.
 * The mode policy lives in this caller layer, not in evaluateDecompositionGate.
 */
export function decompositionAdvisoryIssues(
  story: StoryInfo,
  peers: StoryInfo[],
  contracts: Map<string, ScopeContractData>,
  cfg: ParallelGateConfig,
): Array<{ type: 'decomposition_advisory'; severity: 'advisory'; message: string }> {
  if (cfg.mode === 'off') return [];
  const { advisories } = evaluateDecompositionGate(story, peers, contracts, cfg);
  return advisories.map((message) => ({ type: 'decomposition_advisory' as const, severity: 'advisory' as const, message }));
}

export function createStoryReviewHandlers(ctx: HandlerContext) {
  const { store } = ctx;

  return {
    story_review(args: { storyId: string }): object {
      const story = store.readStory(args.storyId);
      assertCwdInWorktree(store, args.storyId);
      const cl = store.readChecklist(args.storyId);

      // Read truth source
      const config = loadConfig(ctx.root);
      const reqDir = join(ctx.root, config.requirementsDir);
      const truthDocs: string[] = [];
      if (existsSync(reqDir)) {
        const scanDir = (dir: string) => {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) { scanDir(join(dir, entry.name)); continue; }
            if (entry.name.endsWith('.md')) {
              truthDocs.push(readFileSync(join(dir, entry.name), 'utf-8'));
            }
          }
        };
        scanDir(reqDir);
      }

      const issues: Array<{ type: string; severity: 'blocker' | 'advisory'; itemId?: string; message: string; legacyEvidenceWithoutIntent?: boolean; repairCommand?: string }> = [];
      const info: Array<{ type: string; message: string }> = [];

      // 0. checklist split quality static check
      // 0.1 Abnormal count
      if (cl.items.length === 0) {
        issues.push({ type: 'split_quality', severity: 'blocker', message: 'checklist is empty' });
      } else if (cl.items.length > 15) {
        issues.push({ type: 'split_quality', severity: 'advisory', message: `Too many checklist items (${cl.items.length}); may be over-fragmented, consider merging related items` });
      }
      // 0.2 title/context quality
      for (const item of cl.items) {
        if (!item.title || item.title.trim().length < 4) {
          issues.push({ type: 'split_quality', severity: 'blocker', itemId: item.id, message: `${item.id} title is too short or missing` });
        }
        if (!item.context || item.context.trim().length < 8) {
          issues.push({ type: 'split_quality', severity: 'advisory', itemId: item.id, message: `${item.id} is missing context (root cause/reference approach)` });
        }
        // userSees check: user-visible output description
        const userSees = item.userSees;
        if (!userSees || userSees.trim().length < 10) {
          issues.push({ type: 'missing_user_sees', severity: 'advisory', itemId: item.id, message: `${item.id} is missing userSees (the specific text the user sees in the terminal/UI after completing this item). Example: 'User sees "✓ File created: hello.txt" then returns to the prompt'` });
        } else {
          // Detect abstract descriptions: if userSees contains no specific text in quotes, it may be too abstract
          const hasConcreteText = /["'「」`]/.test(userSees) || /[✓✗→>$#]/.test(userSees);
          if (!hasConcreteText) {
            issues.push({ type: 'abstract_user_sees', severity: 'advisory', itemId: item.id, message: `${item.id} userSees may be too abstract (does not contain specific output text in quotes). Should describe the exact text the user sees, not descriptions like "feature works correctly"` });
          }
        }
      }
      // 0.3 Granularity consistency: large title length variance may indicate inconsistent granularity
      if (cl.items.length >= 3) {
        const titleLens = cl.items.map(i => (i.title || '').length);
        const avg = titleLens.reduce((a, b) => a + b, 0) / titleLens.length;
        const maxDiff = Math.max(...titleLens) - Math.min(...titleLens);
        if (avg > 0 && maxDiff > avg * 2) {
          issues.push({
            type: 'split_quality',
            severity: 'advisory',
            message: `checklist item granularity may be inconsistent (large title length variance: ${Math.min(...titleLens)}~${Math.max(...titleLens)}), please check whether to split/merge`,
          });
        }
      }

      // 0.4 Audit log: show all removed items (disposition is enforced at checklist_remove time)
      const auditLog = cl.auditLog;
      if (auditLog && auditLog.length > 0) {
        const deletions = auditLog.filter(e => e.action === 'delete');
        const additions = auditLog.filter(e => e.action === 'add');
        for (const add of additions) {
          issues.push({
            type: 'scope_change',
            severity: 'advisory',
            itemId: add.itemId,
            message: `${add.itemId} ("${add.addedTitle || '?'}") was added in ${add.phase || 'unknown'} phase: ${add.reason || ''}`,
          });
        }
        for (const del of deletions) {
          issues.push({
            type: 'scope_change',
            severity: 'advisory',
            itemId: del.itemId,
            message: `${del.itemId} ("${del.removedTitle || '?'}") was removed in ${del.phase || 'unknown'} phase [${del.disposition}]: ${del.justification || ''}`,
          });
        }
      }

      // 1. Check checklist item integrity (title/context non-empty)
      for (const item of cl.items) {
        if (!item.title || item.title.trim().length < 3) {
          issues.push({ type: 'weak_item', severity: 'blocker', itemId: item.id, message: `${item.id} title is too short or empty` });
        }
      }

      // 2. Check whether cross-scenarios may be missing between items
      if (cl.items.length >= 2) {
        issues.push({
          type: 'cross_scenario',
          severity: 'advisory',
          message: `${cl.items.length} checklist items; please check for missing combined scenarios (e.g., what happens when ${cl.items[0].title} + ${cl.items[1].title} are performed simultaneously?)`,
        });
      }

      // 2.4. High-risk signal hint (story_create auto-tags)
      // B-5010 CHK-004: filter out signals explicitly dismissed by main agent (false-positive whitelist)
      const dismissedCats = new Set((story.riskSignalsDismissed || []).map((d: any) => d.category));
      const activeRiskSignals = (story.riskSignals || []).filter((r: any) => !dismissedCats.has(r.category));
      const isHighRisk = story.priority === 'high' || story.priority === 'critical'
        || activeRiskSignals.length > 0;
      if (activeRiskSignals.length > 0) {
        // B-30b2 CHK-002: keyword detection cannot distinguish "mentions a risky
        // domain" from "modifies it". When the story merely mentions the domain,
        // this advisory is a false positive — surface the CHK-001 dismiss path so
        // the auto-elevation can be fully rolled back. Only promise CHK-001
        // behavior: dismissing all auto-elevated categories rolls priority back.
        issues.push({
          type: 'risk_signals',
          severity: 'advisory',
          message: `story hit ${activeRiskSignals.length} high-risk signal(s): ${activeRiskSignals.map((r: any) => r.category).join(', ')}. Recommend stricter review standards (>= 3 preMortem scenarios, explicit rollback path).`
            + ` If this story only mentions rather than modifies that area (false positive), run lattice story_review_dismiss '{"storyId":"${args.storyId}","category":"<category>","reason":"..."}' to fully roll back the auto-elevation (after all auto-elevated riskSignals are dismissed, priority auto-reverts and high-risk gates are lifted).`,
        });
      }
      if (dismissedCats.size > 0) {
        issues.push({
          type: 'risk_signals_dismissed',
          severity: 'advisory',
          message: `${dismissedCats.size} risk signal(s) have been dismissed by main agent (reasons in story.riskSignalsDismissed): ${Array.from(dismissedCats).join(', ')}`,
        });
      }

      try {
        const proofStoryReport = evaluateProofStoryDiagnostics({
          story,
          checklist: cl,
          originalIntentSnapshot: store.readOriginalIntentSnapshot(args.storyId),
          milestoneLedger: store.readMilestoneLedger(args.storyId),
          slicePlan: store.readProofStorySlicePlan(args.storyId),
          parentLedgerRollup: store.readProofStoryParentLedgerRollup(args.storyId),
          proofStoryContract: store.readProofStoryContract(args.storyId),
          intentCollision: store.readIntentCollision(args.storyId),
          scopeContract: store.readScopeContract(args.storyId),
          scopeShrinkageDecision: store.readScopeShrinkageDecision(args.storyId),
          redEvidence: store.readRedEvidence(args.storyId),
          spikeEvidence: store.readProofStorySpikes(args.storyId),
          summary: store.readSummary(args.storyId),
        }, 'observe');
        for (const proofGap of proofStoryReport.gaps) {
          issues.push({
            type: 'proofstory_advisory',
            severity: 'advisory',
            message: `${proofGap.code}: ${proofGap.message} This story_review row is advisory only; ProofStory gates consume CLI-written artifacts, not prompt text.`,
          });
        }
        for (const proofGap of proofStoryReport.missingParentRollup) {
          issues.push({
            type: 'proofstory_advisory',
            severity: 'advisory',
            message: `${proofGap.code}: ${proofGap.message} Parent roll-up is checked by DONE equivalence when slice plans exist.`,
          });
        }
        if (proofStoryReport.gaps.length === 0 && proofStoryReport.missingParentRollup.length === 0) {
          info.push({
            type: 'proofstory_diagnostics_info',
            message: `ProofStory diagnostics pass in observe mode (${proofStoryReport.hardeningLevel}).`,
          });
        }
      } catch (e) {
        issues.push({
          type: 'proofstory_advisory',
          severity: 'advisory',
          message: `ProofStory advisory diagnostics could not be evaluated: ${(e as Error).message}`,
        });
      }

      // 2.45. RALPLAN-DR decision.json check
      // Respect workflow policy: skip check when policy says 'never', only check high_risk stories when 'high_risk'
      const policy = resolveWorkflowPolicy(config, story);

      // B-aa48 CHK-005: check if checklist references design documents
      const allRelatedDocs = cl.items.flatMap(item => item.relatedDocs || []);
      const hasDesignDocs = allRelatedDocs.some((doc: string) =>
        doc.startsWith('decisions/') || doc.startsWith('requirements/') ||
        doc.includes('/decisions/') || doc.includes('/requirements/')
      );

      // B-aa48 CHK-005: balanced profile + design docs referenced -> skip for non-high-risk
      // (symmetric with shouldCheckUnderstanding; currently redundant under balanced's
      // requireDecision='high_risk', but keeps intent explicit if config changes)
      const shouldCheckDecision = (() => {
        if (policy.plan.requireDecision === 'never') return false;
        if (policy.plan.requireDecision === 'high_risk' && !isHighRisk) return false;
        if (policy.profile === 'balanced' && hasDesignDocs && !isHighRisk) return false;
        return true;
      })();
      const decision = store.readDecision(args.storyId);
      const channel = computeChannel(story, cl, decision);
      if (shouldCheckDecision) {
        if (!decision) {
          issues.push({
            type: 'missing_decision',
            severity: isHighRisk ? 'blocker' : 'advisory',
            message: isHighRisk
              ? `High-risk story must fill decision.json (principles/drivers/options/chosen/>= 3 preMortem). Call: lattice decision_set '{...}'`
              : 'decision.json not filled. Optional for non-high-risk stories, but recommended so reviewers can audit the design rationale.',
          });
        } else {
          // decision already exists, check quality
          if (decision.options.length < 2) {
            // Single option must have invalidation rationale in cons (validated when decision_set writes, this is a fallback)
            const single = decision.options[0];
            if (!single.cons || single.cons.length === 0) {
              issues.push({
                type: 'missing_alternatives',
                severity: 'blocker',
                message: 'decision.options has only 1 entry with empty cons. RALPLAN reviewer requirement: must have fair alternatives or explicit invalidation rationale',
              });
            }
          }
          if (isHighRisk && (!decision.preMortem || decision.preMortem.length < 3)) {
            issues.push({
              type: 'insufficient_premortem',
              severity: 'blocker',
              message: `High-risk story must have ≥ 3 preMortem scenarios (current: ${decision.preMortem?.length ?? 0})`,
            });
          }
        }
      }

      // 2.47. Verification intent discipline: fold old testIntent rigor into PLAN without reviving TEST_CASE phases.
      // Normal/high-risk stories must define happy/edge/adversarial intent per checklist item.
      // Express/fast paths can skip explicit PLAN intent; their validation remains evidence/finding based.
      const requireFullVerificationIntent = isHighRisk || channel === 'normal' || policy.profile === 'strict';
      if (requireFullVerificationIntent) {
        for (const item of cl.items) {
          const intents = item.verificationIntent;
          const legacyHits = detectLegacyEvidenceWithoutIntent(item);
          for (const lane of VERIFICATION_LANES) {
            const entries = intents?.[lane] || [];
            if (entries.length === 0) {
              // The gate stays HARD: a missing-intent lane is always a blocker. When
              // passing-style evidence already exists for this lane, name the audited
              // repair path instead of forcing a hand-edit — but never downgrade severity.
              const laneHit = legacyHits.find(h => h.lane === lane);
              const baseMessage = `${item.id} missing verificationIntent.${lane}. The second-generation flow preserves happy/edge/adversarial test discipline: write intent in PLAN, cover via verification_evidence_add or validate in DEV/TEST.`;
              if (laneHit) {
                issues.push({
                  type: 'missing_verification_intent',
                  severity: 'blocker',
                  itemId: item.id,
                  message: `${baseMessage} Legacy state: verificationEvidence (${laneHit.intentRef}) exists but the intent was never authored — run \`lattice ${VERIFICATION_INTENT_REPAIR_COMMAND}\` to backfill the intent from that evidence (this is a schema repair, not a gate pass).`,
                  legacyEvidenceWithoutIntent: true,
                  repairCommand: VERIFICATION_INTENT_REPAIR_COMMAND,
                });
              } else {
                issues.push({
                  type: 'missing_verification_intent',
                  severity: 'blocker',
                  itemId: item.id,
                  message: baseMessage,
                });
              }
            }
          }
        }
      } else {
        const missingHappy = cl.items.filter(item => (item.verificationIntent?.happy || []).length === 0);
        if (missingHappy.length > 0) {
          issues.push({
            type: 'verification_intent_advisory',
            severity: 'advisory',
            message: `${channel} channel allows fast path, but recommend adding at least one verificationIntent.happy for ${missingHappy.map(i => i.id).join(', ')} to help REVIEW/test-coverage reviewer align.`,
          });
        }
      }

      // 2.5. Pre-context Intake snapshot check (soft introduction)
      // Respect workflow policy: skip check when policy says 'never', only check high_risk stories when 'high_risk'
      const shouldCheckUnderstanding = (() => {
        if (policy.plan.requireUnderstanding === 'never') return false;
        if (policy.plan.requireUnderstanding === 'high_risk' && !isHighRisk) return false;
        // B-aa48 CHK-005: balanced profile + design docs referenced -> skip for non-high-risk
        if (policy.profile === 'balanced' && hasDesignDocs && !isHighRisk) return false;
        return true;
      })();
      const understanding = store.readUnderstanding(args.storyId);
      const grill = store.readGrill(args.storyId);
      if (grill) {
        const openSessions = grill.sessions.filter(session => session.status === 'open');
        for (const session of openSessions) {
          issues.push({
            type: 'grill_session_open',
            severity: 'advisory',
            message: `grill session ${session.sessionId} still open${session.topic ? ` (${session.topic})` : ''}. Grill clarifies intent; evidence proves behavior.`,
          });
        }
        for (const session of grill.sessions) {
          const unresolved = session.questions.filter(question => question.status === 'unresolved');
          if (unresolved.length > 0) {
            issues.push({
              type: 'grill_question_unresolved',
              severity: 'advisory',
              message: `grill session ${session.sessionId} still has ${unresolved.length} unresolved questions: ${unresolved.slice(0, 3).map(q => q.question).join('; ')}${unresolved.length > 3 ? '…' : ''}`,
            });
          }
        }
      }
      if (shouldCheckUnderstanding) {
        if (!understanding) {
          issues.push({
            type: 'missing_understanding',
            severity: 'advisory',
            message: 'understanding snapshot not filled. Recommend calling understanding_set before breaking down checklist to record the 6 fields task/outcome/facts/constraints/unknowns/touchpoints, avoiding expensive late fixes for misunderstandings',
          });
        } else {
          if (understanding.unknowns.length > 0) {
            issues.push({
              type: 'unresolved_unknowns',
              severity: 'advisory',
              message: `understanding still has ${understanding.unknowns.length} undigested unknowns: ${understanding.unknowns.slice(0, 3).join('; ')}${understanding.unknowns.length > 3 ? '…' : ''}`,
            });
          }
          if (understanding.touchpoints.length === 0) {
            issues.push({
              type: 'empty_touchpoints',
              severity: 'advisory',
              message: 'understanding.touchpoints is empty. Filling it in helps reviewers understand the scope of impact',
            });
          }
        }
      }

      // 2.52. B-45ed CHK-002: touchpoints → checklist.files coverage check
      // If understanding.touchpoints is non-empty:
      //   - If at least one checklist item has files field filled → hard validation mode, each uncovered touchpoint counts as one blocker
      //   - If all items lack files field (legacy story) → fallback advisory `touchpoint_mapping_missing`
      // Coverage check: extract path prefix then compare, allowing human annotations like "src/foo.ts (reason)".
      if (understanding && understanding.touchpoints && understanding.touchpoints.length > 0) {
        const itemsWithFiles = cl.items.filter(i => !!i.files);
        if (itemsWithFiles.length === 0) {
          issues.push({
            type: 'touchpoint_mapping_missing',
            severity: 'advisory',
            message: 'None of the checklist items have the files field filled in (legacy story compatibility mode); cannot perform coverage validation on understanding.touchpoints. Please list the changed files in files.modify/create/test for at least one item to enable strict touchpoint-to-files validation',
          });
        } else {
          // Strict validation mode: collect all file paths declared by items
          const covered = new Set<string>();
          for (const item of itemsWithFiles) {
            const f = item.files!;
            for (const p of f.modify || []) covered.add(normalizeTouchpointPath(p));
            for (const p of f.create || []) covered.add(normalizeTouchpointPath(p));
            for (const p of f.test || []) covered.add(normalizeTouchpointPath(p));
          }
          for (const tp of understanding.touchpoints) {
            const normalizedTp = normalizeTouchpointPath(tp);
            if (!covered.has(normalizedTp)) {
              issues.push({
                type: 'touchpoint_uncovered',
                severity: 'blocker',
                message: `touchpoint_uncovered: ${tp} is not covered by the files field of any checklist item (please add this path to the corresponding item's files.modify/create/test or explicitly exclude it via excludes)`,
              });
            }
          }
        }
      }

      // 2.55. plan.md check (respect policy.plan.requirePlanMd)
      const shouldCheckPlanMd = (() => {
        if (policy.plan.requirePlanMd === 'never') return false;
        if (policy.plan.requirePlanMd === 'normal') return cl.items.length > 2 || isHighRisk;
        return true; // 'always'
      })();
      if (shouldCheckPlanMd) {
        const planPath = join(ctx.root, config.storyDir, args.storyId, 'plan.md');
        if (!existsSync(planPath)) {
          issues.push({
            type: 'missing_plan_md',
            severity: isHighRisk ? 'blocker' : 'advisory',
            message: isHighRisk
              ? 'High-risk stories must have plan.md (execution plan). Write it following the plan.md template in CLAUDE.md, one section per CHK-xxx'
              : 'plan.md not found. Normal channel recommends writing plan.md to clarify execution order and dependencies',
          });
        }
      }

      // 2.6. Scope check: read scope-check.json (written by lattice-review-scope-plan agent)
      // Only check scope when understanding exists and checklist has items
      // (without these, scope check is meaningless and would block trivial stories)
      const scopeData = store.readScopeCheck(args.storyId);
      if (!scopeData && understanding && cl.items.length > 0) {
        issues.push({
          type: 'missing_scope_check',
          severity: 'blocker',
          message: 'missing_scope_check: scope-check.json is missing PLAN gate evidence. `scope_check_save` already exists; a lattice-review-scope-plan / scope-plan reviewer must persist the result through `scope_check_save`. The implementation/main agent must not self-sign this evidence or manually edit story metadata. Local CLI guidance is not remote completion and must not be presented as receipt verification or production/full completion.',
        });
      } else if (scopeData) {
        // Verify signature using shared signScopeCheck function
        const expectedHash = signScopeCheck(args.storyId, scopeData.checkedAt, scopeData.summary.gaps, scopeData.summary.covered, scopeData.reviewRound || '');
        if (!scopeData._hash || scopeData._hash !== expectedHash) {
          issues.push({
            type: 'scope_check_tampered',
            severity: 'blocker',
            message: 'scope-check.json signature verification failed; must be written by the scope agent via scope_check_save',
          });
        } else {
          // Verify review round matches current round
          if (story.currentReviewRound && scopeData.reviewRound !== story.currentReviewRound) {
            issues.push({
              type: 'scope_check_stale',
              severity: 'blocker',
              message: `scope-check.json reviewRound (${scopeData.reviewRound || 'none'}) does not match the current review round (${story.currentReviewRound}); please rerun the scope agent`,
            });
          }
          // Report gaps as blocker
          const gaps = (scopeData.features || []).filter(f => f.status === 'gap');
          for (const gap of gaps) {
            issues.push({
              type: 'scope_gap',
              severity: 'blocker',
              message: `scope gap: description mentions "${gap.feature}" but there is no corresponding checklist item and it is not excluded`,
            });
          }
          // Report excluded as info (not counted as issue)
          const excluded = (scopeData.features || []).filter(f => f.status === 'excluded');
          if (excluded.length > 0) {
            info.push({
              type: 'scope_excluded_info',
              message: `${excluded.length} feature points explicitly excluded: ${excluded.map(e => e.feature).join(', ')}`,
            });
          }
          // F-018/F-021: orphan-suspect emitted as advisory (does not block, but makes it visible to the main agent)
          // drift is always an empty set in the PLAN phase, planned for S3, not emitted here.
          const orphanSuspect = (scopeData.features || []).filter(f => f.status === 'orphan-suspect');
          for (const feat of orphanSuspect) {
            const src = feat.source ? ` see ${feat.source}` : '';
            issues.push({
              type: 'scope_orphan_suspect',
              severity: 'advisory',
              message: `scope feature ${feat.feature} orphan-suspect:${src} is not covered by any CHK but is not explicitly excluded, please confirm`,
            });
          }
        }
      }

      // 2.6b. Story 4 (B-fa7c): parallel-decomposition ADVISORIES surfaced at REVIEW.
      // Advisory-only — the gate's `block` field is intentionally ignored here (enforcement
      // is Story 5; mode='off' is short-circuited inside decompositionAdvisoryIssues). Each
      // advisory becomes an {severity:'advisory'} issue, so blockerCount (computed below as
      // issues.filter(i=>i.severity==='blocker').length) is unaffected.
      // resolveAuditConfig ALWAYS populates parallelGate, so the `if (parallelGateCfg)` guard is
      // purely defensive. The whole block is also wrapped in try/catch and reads each contract via
      // safeReadScopeContract (corrupt contract == absent) so an advisory can never crash REVIEW.
      try {
        const parallelGateCfg = resolveAuditConfig(policy.profile, ctx.root).parallelGate;
        if (parallelGateCfg) {
          const peers = store.listStoryIds()
            .filter(id => id !== args.storyId)
            .map(id => store.readStory(id));
          const contracts = new Map<string, ScopeContractData>();
          for (const peer of peers) {
            const peerContract = safeReadScopeContract(store, peer.storyId);
            if (peerContract) contracts.set(peer.storyId, peerContract);
          }
          const selfContract = safeReadScopeContract(store, args.storyId);
          if (selfContract) contracts.set(args.storyId, selfContract);
          issues.push(...decompositionAdvisoryIssues(story, peers, contracts, parallelGateCfg));
        }
      } catch (e) {
        console.warn(`[decomposition-advisory] surface failed for ${args.storyId}:`, (e as Error).message);
      }

      // 2.65. B-ed3e CHK-004: Open Questions gate — any unresolved OQ blocks PLAN→DEV.
      // Prevents the main agent from ignoring the scope-plan reviewer's questions (self-absolution). Backward compatibility:
      // Old scope-check.json without the openQuestions field (undefined) or with an empty array does not trigger.
      if (scopeData && scopeData.openQuestions && scopeData.openQuestions.length > 0) {
        // F-019: Aligned with cli-engine.ts Zod schema (resolution.min(20));
        // A resolution of 1-19 characters is treated as unresolved to prevent bypass.
        const unresolved = scopeData.openQuestions.filter(
          oq => !oq.resolution || oq.resolution.trim().length < 20,
        );
        for (const oq of unresolved) {
          // F-017: When oq.q is empty, fall back to '(no question text)' to prevent output like "... unresolved — """
          const rawQ = oq.q ?? '';
          const qText = rawQ.length > 80
            ? `${rawQ.slice(0, 77)}...`
            : (rawQ.length > 0 ? rawQ : '(no question text)');
          // F-019: Resolutions that are written but < 20 characters are annotated in the message
          const trimmedLen = (oq.resolution ?? '').trim().length;
          const shortTag = (trimmedLen > 0 && trimmedLen < 20)
            ? '(< 20 characters, treated as unresolved)'
            : '';
          issues.push({
            type: 'scope_open_question_unresolved',
            severity: 'blocker',
            message: `scope_open_question_unresolved: ${oq.id} unresolved — "${qText}"${shortTag}. Please run \`lattice scope_question_resolve --storyId=${args.storyId} --oqId=${oq.id} --resolution=...\` to provide a written resolution (the main agent is responsible for the conclusion)`,
          });
        }
      }

      // 3. Ensure issueCount > 0 (the review must produce at least one advisory)
      if (issues.length === 0) {
        issues.push({
          type: 'review_advisory',
          severity: 'advisory',
          message: 'The review found no blockers, but it is recommended to manually verify checklist completeness against the source-of-truth documents in _reviewPrompt',
        });
      }

      // 4. Statistics
      const totalItems = cl.items.length;
      const blockerCount = issues.filter(i => i.severity === 'blocker').length;

      // 5. Write to review.json (signed to prevent the main agent from forging it)
      const reviewData = store.readReview(args.storyId);
      const timestamp = new Date().toISOString();
      const reviewEntry = {
        timestamp,
        issueCount: issues.length,
        blockerCount,
        issues,
        _hash: '',
      };
      // Signature = sha256(storyId + timestamp + issueCount + blockerCount + fixed salt)
      const REVIEW_SALT = 'lattice-review-integrity-v1';
      const hashInput = `${args.storyId}:${timestamp}:${issues.length}:${blockerCount}:${REVIEW_SALT}`;
      reviewEntry._hash = createHash('sha256').update(hashInput).digest('hex');
      reviewData.reviews.push(reviewEntry);
      store.writeReview(args.storyId, reviewData);

      // B-aa48 CHK-002: write plan_reviewed process event
      try {
        store.appendProcessEvent(args.storyId, {
          type: 'plan_reviewed',
          round: reviewData.reviews.length,
          blockerCount,
          issueCount: issues.length,
        });
      } catch (e) {
        console.warn(`[process-events] append failed for ${args.storyId}:`, (e as Error).message);
      }

      // B-abd8: auto-recompute process metrics
      try {
        const pm = computeProcessMetrics(args.storyId, store, ctx.root);
        store.writeProcessMetrics(args.storyId, pm);
      } catch (e) {
        console.warn(`[process-metrics] recompute failed for ${args.storyId}:`, (e as Error).message);
      }

      const planReviewRound = reviewData.reviews.length;

      // B-1dc9 CHK-002/CHK-003: ADVISORY-ONLY experience hints.
      //
      // Derived from past finding-signals; surfaced as a clearly-labelled advisory
      // section in the `_reviewPrompt` output (mirrors grillSection). These hints
      // are nudges, never gates: nothing in the issues/blocker computation reads
      // them, and — CRITICAL GUARDRAIL — they live ONLY in this story-review
      // advisory `_reviewPrompt` channel, which is SEPARATE from the REVIEW-phase
      // reviewer prompt that feeds resolveReviewPromptHash (core/review-run.ts).
      // Hint content must NEVER enter any reviewRunId/promptHash computation.
      //
      // Compute once here so the usage-tracking event fires (at most) once per
      // story_review call that surfaces hints (the `_reviewPrompt` getter below is
      // an IIFE; building the section out here keeps surfacing single-shot).
      //
      // B-1dc9 CHK-003:edge:0 — DEDUP: usage tracking is exactly-once-PER-REVIEW-ROUND,
      // not per-call. The stable round key is `story.currentReviewRound` (an ISO
      // stamp set when a REVIEW round opens and unchanged across repeated calls in
      // that round). PLAN-phase stories have no currentReviewRound, so we fall back
      // to the stable `plan:<phase>` key (stable across repeated calls; note
      // `planReviewRound` increments every call and is deliberately NOT used here).
      // The `_reviewPrompt` section still renders on every call — only the EVENT is
      // deduped — so a NEW round (or a different story) yields a new event.
      const hintRoundKey = story.currentReviewRound || `plan:${story.phase}`;
      // B-5a48 CHK-001: the firing + per-round dedup + A/B arm + render-gate logic
      // moved VERBATIM into the shared core leaf surfaceExperienceHints so the PLAN
      // site (here) and the REVIEW site (transition-effects.ts buildNextSteps)
      // share ONE implementation with no drift. The CALLER supplies hintRoundKey
      // (computed just above); the leaf never computes the
      // `currentReviewRound || plan:<phase>` formula. The leaf fires the
      // experience_hint_surfaced event on BOTH arms (lossless measurement) and
      // returns the render-gated section — ON arm renders the computed section,
      // OFF arm returns '' so the OFF-arm `_reviewPrompt` is byte-identical to the
      // no-hints case. ADVISORY-ONLY: renderedHintsSection is NEVER fed to
      // resolveReviewPromptHash (see the `_reviewPrompt` assembly below).
      const { renderedSection: renderedHintsSection } = surfaceExperienceHints(ctx.root, {
        storyId: args.storyId,
        hintRoundKey,
      });

      return {
        storyId: args.storyId,
        title: story.title,
        planReviewRound,
        // Legacy compatibility alias for story_review callers. This is the
        // numeric PLAN review count, not the signed artifact ISO reviewRound.
        reviewRound: planReviewRound,
        summary: {
          totalItems,
          issueCount: issues.length,
          blockerCount,
        },
        issues,
        ...(info.length > 0 ? { info } : {}),
        truthDocsCount: truthDocs.length,
        _hint: blockerCount > 0
          ? `Round ${reviewData.reviews.length} review found ${blockerCount} blockers, please fix and run story_review again`
          : `✅ Round ${reviewData.reviews.length} review passed (${blockerCount} blocker, ${issues.length} advisory), can proceed to development`,
        _reviewPrompt: (() => {
          // Assemble the full review prompt: truth docs + checklist/intent + understanding + decision
          // So the reviewer can not only review requirement coverage, but also review "whether the main agent truly understands the task" and "why this design was chosen"
          const understandingSection = understanding
            ? `\n---\nUnderstanding Snapshot:\n` +
              `task: ${understanding.task}\n` +
              `outcome: ${understanding.outcome}\n` +
              `facts:\n${understanding.facts.map((f: string) => `  - ${f}`).join('\n') || '  (none)'}\n` +
              `constraints:\n${understanding.constraints.map((c: string) => `  - ${c}`).join('\n') || '  (none)'}\n` +
              `unknowns:\n${understanding.unknowns.map((u: string) => `  - ${u}`).join('\n') || '  (none)'}\n` +
              `touchpoints:\n${understanding.touchpoints.map((t: string) => `  - ${t}`).join('\n') || '  (none)'}`
            : '\n---\nUnderstanding Snapshot: (not provided)';
          const decisionSection = decision
            ? `\n---\nDecision (RALPLAN-DR):\n` +
              `principles:\n${decision.principles.map((p: string) => `  - ${p}`).join('\n')}\n` +
              `drivers:\n${decision.drivers.map((d: string) => `  - ${d}`).join('\n')}\n` +
              `options:\n${decision.options.map((o: any) => `  - ${o.name}\n    pros: ${o.pros.join('; ')}\n    cons: ${o.cons.join('; ')}`).join('\n')}\n` +
              `chosen: ${decision.chosen}\n` +
              `rationale: ${decision.rationale}` +
              (decision.preMortem && decision.preMortem.length > 0
                ? `\npreMortem:\n${decision.preMortem.map((pm: any) => `  - ${pm.scenario} (trigger: ${pm.trigger}; consequence: ${pm.consequence}; mitigation: ${pm.mitigation})`).join('\n')}`
                : '')
            : '\n---\nDecision: (not provided)';
          const grillSection = grill
            ? `\n---\nGrill Planning Context (advisory only):\n` +
              `Grill clarifies intent; evidence proves behavior.\n` +
              grill.sessions.map(session => {
                const questionLines = session.questions.length > 0
                  ? session.questions.map(q => `    - ${q.id} [${q.status}] ${q.question}${q.answer ? ` -> ${q.answer}` : ''}`).join('\n')
                  : '    (no questions recorded)';
                return `  - ${session.sessionId} [${session.status}]${session.topic ? ` ${session.topic}` : ''}\n${questionLines}`;
              }).join('\n')
            : '';
          const checklistSection = `\n---\nChecklist:\n${cl.items.map(i => {
            const vi = collectVerificationIntents(i);
            const intentLines = vi.length > 0
              ? `\n  verificationIntent:\n${vi.map(v => `    - ${v.ref} [${v.lane}/${v.intent.priority || 'must'}/${v.intent.type}] ${v.intent.desc}`).join('\n')}`
              : '';
            return `- ${i.id}: ${i.title}${i.context ? ` (${i.context})` : ''}${intentLines}`;
          }).join('\n')}`;
          const truthSection = truthDocs.length > 0
            ? `\n---\nTruth Source (${truthDocs.length} docs):\n${truthDocs.join('\n---\n')}`
            : '';
          const proofStorySection = (() => {
            try {
              const report = evaluateProofStoryDiagnostics({
                story,
                checklist: cl,
                originalIntentSnapshot: store.readOriginalIntentSnapshot(args.storyId),
                milestoneLedger: store.readMilestoneLedger(args.storyId),
                slicePlan: store.readProofStorySlicePlan(args.storyId),
                parentLedgerRollup: store.readProofStoryParentLedgerRollup(args.storyId),
                proofStoryContract: store.readProofStoryContract(args.storyId),
                intentCollision: store.readIntentCollision(args.storyId),
                scopeContract: store.readScopeContract(args.storyId),
                scopeShrinkageDecision: store.readScopeShrinkageDecision(args.storyId),
                redEvidence: store.readRedEvidence(args.storyId),
                spikeEvidence: store.readProofStorySpikes(args.storyId),
                summary: store.readSummary(args.storyId),
              }, 'observe');
              return `\n---\nProofStory Diagnostics (advisory only):\n${renderProofStoryDiagnosticReport(report)}\nReviewer note: prompt text and this advisory section do not satisfy gates; only CLI-written artifacts and signed review evidence do.`;
            } catch (e) {
              return `\n---\nProofStory Diagnostics (advisory only): unavailable (${(e as Error).message})`;
            }
          })();
          // When there are no truth docs + no understanding + no decision + no
          // grill + no rendered experience hints, ProofStory diagnostics still keep
          // the advisory prompt present because they are part of PLAN review.
          // renderedHintsSection alone keeps the advisory prompt present so the
          // hints are surfaced even in a bare PLAN. It is '' when no hints exist OR
          // when the A/B arm is OFF (B-06b3), so in both of those cases the prompt is
          // byte-unchanged from the prior no-hints behavior.
          if (truthDocs.length === 0 && !understanding && !decision && !grill && renderedHintsSection === '' && proofStorySection === '') return undefined;
          return `Please review the PLAN-phase artifacts of the following story. Focus on:\n` +
            `  1. Whether understanding is genuine (whether unknowns contradict facts, whether touchpoints are real)\n` +
            `  2. Whether the decision choice is reasonable (why other options were not chosen, whether rationale echoes drivers)\n` +
            `  3. Whether the checklist covers all scenarios in description + truth docs\n` +
            `  4. Whether preMortem lists real failure modes (not filler)\n` +
            `  5. Whether ProofStory diagnostics identify missing machine artifacts; do not treat prompt-only statements as gate evidence\n\n` +
            `---\nStory: ${story.title}\nDescription: ${story.description}\nPriority: ${story.priority}` +
            (story.riskSignals && story.riskSignals.length > 0
              ? ` (riskSignals: ${story.riskSignals.map((r: any) => r.category).join(', ')})`
              : '') +
            // renderedHintsSection mirrors grillSection (advisory channel),
            // placed right after it. It is the A/B render-gated value (B-06b3): the
            // full section on the ON arm, '' on the OFF arm. ADVISORY-ONLY: never fed
            // to resolveReviewPromptHash.
            understandingSection + decisionSection + grillSection + renderedHintsSection + proofStorySection + checklistSection + truthSection;
        })(),
      };
    },

    /**
     * B-5010 CHK-004: Dismiss a falsely-reported riskSignal category.
     * Appends {category, reason, at} to story.riskSignalsDismissed; subsequent story_review
     * and decision_set high-risk determinations will skip dismissed categories. Undo is not supported.
     */
    story_review_dismiss(args: { storyId: string; category: string; reason: string }): object {
      if (!args.reason || args.reason.trim().length < 5) {
        throw new Error('story_review_dismiss: reason must be ≥ 5 characters, explaining why this signal is a false positive for this story');
      }
      const story = store.readStory(args.storyId);
      const knownCategories = new Set((story.riskSignals || []).map(r => r.category));
      if (!knownCategories.has(args.category)) {
        throw new Error(
          `story_review_dismiss: category "${args.category}" is not in the current story.riskSignals. ` +
          `Existing: [${Array.from(knownCategories).join(', ') || 'none'}]`
        );
      }
      const existing = story.riskSignalsDismissed || [];
      if (existing.some(d => d.category === args.category)) {
        return {
          ok: true,
          alreadyDismissed: true,
          message: `category "${args.category}" has already been dismissed, no need to repeat the operation`,
        };
      }
      const updated: StoryInfo = {
        ...story,
        riskSignalsDismissed: [
          ...existing,
          { category: args.category, reason: args.reason.trim(), at: new Date().toISOString() },
        ],
      };

      // B-30b2 CHK-001: if this dismissal clears the LAST active riskSignal AND the story's
      // priority was auto-elevated by story_create (priorityElevatedFrom marker present), roll
      // priority back to the pre-elevation value so the auto-elevation no longer keeps
      // isHighRisk=true. Runtime-validate the marker (Handler coding convention): only roll back to a
      // valid priority strictly below 'high'. This guarantees:
      //   - user explicit high/critical (no marker) is never downgraded;
      //   - a missing / tampered / non-priority / >= high marker never triggers a downgrade.
      const dismissedAfter = new Set(updated.riskSignalsDismissed!.map(d => d.category));
      const remainingActive = (story.riskSignals || []).filter(r => !dismissedAfter.has(r.category));
      const order = ['low', 'medium', 'high', 'critical'];
      const elevatedFrom = typeof story.priorityElevatedFrom === 'string'
        ? story.priorityElevatedFrom.trim()
        : '';
      const elevatedFromIdx = order.indexOf(elevatedFrom);
      let rolledBackTo: string | undefined;
      if (
        remainingActive.length === 0 &&
        elevatedFromIdx !== -1 &&
        elevatedFromIdx < order.indexOf('high')
      ) {
        updated.priority = elevatedFrom;
        delete updated.priorityElevatedFrom;
        rolledBackTo = elevatedFrom;
      }

      store.writeStory(args.storyId, updated);
      return {
        ok: true,
        dismissed: args.category,
        reason: args.reason.trim(),
        ...(rolledBackTo !== undefined ? { priorityRolledBackTo: rolledBackTo } : {}),
        message: rolledBackTo !== undefined
          ? `Dismissed riskSignal "${args.category}". No active riskSignal remaining, priority has been rolled back from auto-elevated to "${rolledBackTo}", high-risk gates (missing_decision / ≥3 preMortem) are no longer enforced.`
          : `Dismissed riskSignal "${args.category}", story_review will no longer advisory-prompt this category`,
      };
    },
  };
}
