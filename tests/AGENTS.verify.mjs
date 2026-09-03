#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { MAIN_TOOLS } from '../packages/main/dist/cli/command-catalog.js';
import { AGENTS_MD_GLOBAL_THIN_TEMPLATE } from '../packages/main/dist/init-assets.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const agentsPath = resolve(root, 'AGENTS.md');
const auditPath = resolve(root, 'docs/audits/AGENTS-current-version-audit.md');
const localCli = resolve(root, 'bin/proof-or-stop.js');
const globalCli = '/opt/homebrew/bin/proof-or-stop';
const claudeTranscript = '/Users/jek/.claude/projects/-Users-jek-Documents-GitHub-Prooforstop--worktrees-B-d854/3a540dc1-9ecd-45af-bafb-78845401177b.jsonl';
const agyTranscript = '/Users/jek/.codex/sessions/2026/09/01/rollout-2026-09-01T23-50-54-01a05f2b-162b-7c42-b1c4-9ca08a0d6957.jsonl';
const AGY_PROVENANCE = Object.freeze({
  ordinal: 953,
  threadId: '01a05f2b-162b-7c42-b1c4-9ca08a0d6957',
  turnId: '01a05f3f-49d0-7e31-bec4-a408543fa386',
  itemId: 'exec-d0c3cff6-f5aa-4d73-ac90-c481f633af1f',
  command: Object.freeze([
    '/bin/zsh',
    '-lc',
    'agy --print "$(cat /tmp/B-d854-agy-agents-audit-prompt.txt)" --mode plan --sandbox --dangerously-skip-permissions --output-format json --print-timeout 10m',
  ]),
  cwd: 'file:///Users/jek/Documents/GitHub/Prooforstop/.worktrees/B-d854',
  promptPath: '/tmp/B-d854-agy-agents-audit-prompt.txt',
  promptBytes: 2566,
  promptSha256: '6e022d8eebd7235a521f3a764e13ccf107ad8bdd889f0dfac5177624e35c121a',
  stdoutBytes: 38164,
  stdoutSha256: 'b4e930f908b5723acdfc7c24538c5081baeaf05fc50aac03a986f1018cd7f7ed',
  conversationId: 'f48bd033-f9a7-4198-8ad2-638be9d122ff',
  status: 'SUCCESS',
  durationSeconds: 465.638154,
});
const baselineRef = '219a567^:AGENTS.md';
const HISTORICAL_RUNTIME_RECEIPT = Object.freeze({
  commit: '48d08c69e90dd9d90c7b783a112e54aa955d6241',
  path: '.proof-or-stop/story/actives/B-d854/checklist.json',
  blob: '94a3682f2349e0fb42cbfb4ddea784c04a715201',
  itemId: 'CHK-003',
  intentRef: 'CHK-003:edge:1',
  selector: 'RUNTIME classification=VERSION_AND_REALPATH_DRIFT',
  command: 'node tests/AGENTS.verify.mjs --final',
  outputDigest: '8d66e8eae81c7be7326397a8c80b60a123bf1fabf1abfedb75d3cac2a5927748',
  outputTailBytes: 4000,
});
const mode = process.argv.includes('--baseline') ? 'baseline' : 'final';
const rowArg = process.argv.find((arg) => arg.startsWith('--row='));
const selectedRow = rowArg?.slice('--row='.length) ?? null;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const gitBlobOid = (value) => {
  const bytes = Buffer.from(value);
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
};
const read = (path) => readFileSync(path, 'utf8');
const currentText = read(agentsPath);
const auditText = existsSync(auditPath) ? read(auditPath) : '';
const baselineText = execFileSync('git', ['show', baselineRef], { cwd: root, encoding: 'utf8' });

const present = (label, pattern) => ({ label, test: (text) => pattern.test(text) });
const absent = (label, pattern) => ({ label, test: (text) => !pattern.test(text) });

// One row per source issue from the original user-visible list: 24 major issues
// followed by the two explicitly identified low-priority issues. A RED row must
// satisfy every row-specific stale predicate; absence of final GREEN wording is
// never accepted as a substitute for detecting the original defect.
const AUDIT_ROWS = [
  ['A01', 'M01', [present('managed block starts with obsolete full-guide heading', /<!-- proof-or-stop:start -->\n# AGENTS\.md/)], /managed global-thin block above/, 'packages/main/src/init-assets.ts', /AGENTS_MD_GLOBAL_THIN_TEMPLATE/],
  ['A02', 'M02', [present('obsolete Story path is the prohibited target', /\u7981\u6b62\u76f4\u63a5\u8bfb\u5199 `docs\/story\//u)], /`\.proof-or-stop\/story\/actives`/, 'proof-or-stop.config.json', /"storyDir": "\.proof-or-stop\/story\/actives"/],
  ['A03', 'M03', [present('dangling user-value acceptance section reference', /\u7528\u6237\u4ef7\u503c\u9a8c\u6536/u)], /Engineering completion is not product completion/, 'packages/main/src/cli/command-catalog.ts', /userSees: z\.string/],
  ['A04', 'M04', [present('global CLI described as core-only', /\u53ea\u6709\u6838\u5fc3\u547d\u4ee4/u)], /other registered\n   `aux_\*` commands are available/, 'packages/main/src/cli/command-catalog.ts', /name: 'aux_doc_list'/],
  ['A05', 'M05', [present('incomplete story_create example exists', /proof-or-stop story_create '\{"name":"xxx"/), absent('that example has no background field', /proof-or-stop story_create '\{"name":"xxx"[^\n]*"background"/)], /four Markdown sections named `Trigger Event`/, 'packages/main/src/handlers/story-create.ts', /const bgResult = validateBackground/],
  ['A06', 'M06', [present('story_create payload contains CJK checklist authoring', /"title":"\u505a\u4ec0\u4e48","context":"\u6839\u56e0\/\u53c2\u8003\u65b9\u6848"/u)], /Write these sections in\nEnglish in this repository/, 'packages/main/src/handlers/story-create.ts', /assertEnglishAuthoringText\('story_create'/],
  ['A07', 'M07', [present('checklist creation is said to stop in PLAN', /\u6709 checklist \u65f6\u505c\u5728 PLAN/u)], /Creation conservatively stops in INIT/, 'packages/main/src/handlers/story-create.ts', /const phase: StoryPhase = hasChecklist \? 'INIT' : 'IDEA'/],
  ['A08', 'M08', [present('PLAN-to-DEV is said to create worktree', /PLAN\u2192DEV \u65f6\u81ea\u52a8\u521b\u5efa/u)], /INIT to INIT_CHECK creates the Story branch and worktree/, 'packages/main/src/core/lifecycle-registry.ts', /effects: \['story-worktree-create'\]/],
  ['A09', 'M09', [present('INIT_CHECK is described as CLI automatic work', /\| \*\*INIT_CHECK\*\* \| CLI \u81ea\u52a8/u)], /`proof-or-stop-review-story-init` and `product-reviewer`/, 'packages/main/src/core/init-check-gate.ts', /REQUIRED_INIT_CHECK_AGENTS/],
  ['A10', 'M10', [present('owner lease stack is called unimplemented', /owner lease[^\n]*\u5c1a\u672a\u5b9e\u73b0/u)], /Story owner leases, takeover UX, and `session_brief` owner rendering are\nimplemented/, 'packages/main/src/core/story-owner-lease.ts', /export function acquireOrRefreshOwnerLease/],
  ['A11', 'M11', [present('retired test-intent mutation command appears', /(testintent_record|testintent_resume)/)], /retired conversational test-intent mutation commands are unavailable/, 'packages/main/src/cli/command-catalog.ts', /name: 'testintent_handoff'/],
  ['A12', 'M12', [present('story_review acceptance uses issueCount zero', /issueCount=0/)], /`blockerCount` is zero/, 'packages/main/src/handlers/story-review.ts', /const blockerCount = issues\.filter/],
  ['A13', 'M13', [present('story_review is unconditionally mandatory', /checklist \u5199\u5b8c\u540e\u5fc5\u987b\u8dd1 `story_review`/u)], /quick-channel Story may\nmake adversarial review optional only/, 'packages/main/src/core/machine.ts', /quickPath\.enabled/],
  ['A14', 'M14', [present('old PLAN review checklist is the stated gate', /story_review \u68c0\u67e5\uff1a\u7f3a\u5931\/\u5f31 `verificationIntent`/u), absent('scope-check gate artifact is omitted', /scope-check\.json/)], /signed `scope-check\.json` evidence/, 'packages/main/src/handlers/scope-check.ts', /const _hash = signScopeCheck/, [
    present('unresolved scope questions must be resolved', /Every `openQuestions` entry[\s\S]*must have a substantive\nwritten resolution before `story_review` can pass/),
    present('registered scope question resolution path is named', /registered `scope_question_resolve` command/),
    present('scope contract initialization path is named', /scope_contract_init_from_plan/),
    present('scope contract check path is named', /scope_contract_check/),
    present('PLAN-to-DEV missing contract is accurately advisory', /missing contract is an advisory, not a blocker, on the\nPLAN-to-DEV transition/),
    present('new-scope REVIEW missing contract is accurately blocking', /hard missing-scope-contract blocker when that new-scope Story enters REVIEW/),
  ]],
  ['A15', 'M15', [present('main agent fields are limited to title context relatedDocs', /\u4e3b agent \u53ea\u5199 title \+ context \+ relatedDocs/u)], /Current fields include `title`, `context`, `relatedDocs`, `userSees`, `excludes`/, 'packages/main/src/cli/command-catalog.ts', /userSees: z\.string/],
  ['A16', 'M16', [present('scope expansion forbids saying out of scope', /\u4e0d\u8981\u8bf4"\u4e0d\u5728 scope \u5185"/u), present('infrastructure defects are ordered into current Story', /\u8fd9\u4e9b\u90fd\u5e94\u8be5\u4e00\u8d77\u4fee/u)], /Defect triage and bounded scope/, 'AGENTS.md', /Defect triage and bounded scope/],
  ['A17', 'M17', [present('PASS binding is required to use latest lane run', /reviewRunId[^\n]*\u5f53\u524d lane \u6700\u65b0/u)], /PASS from the current review round may remain valid/, 'packages/main/src/core/review-run.ts', /if \(currentRun && currentRun\.reviewRunId !== run\.reviewRunId && evidence\.kind !== 'pass'\)/],
  ['A18', 'M18', [present('caller-authored verificationEvidence uses checklist_update', /checklist_update[^\n]*verificationEvidence/)], /issues a tool-owned receipt/, 'packages/main/src/handlers/checklist.ts', /const run = await deps\.runCommand/],
  ['A19', 'M19', [present('legacy subagent Bash model is stated', /subagent \u53ef\u8c03\u7528 Proof-or-Stop CLI \u547d\u4ee4\uff08\u901a\u8fc7 Bash tool\uff09/u), absent('dispatch entrypoint is omitted', /`dispatch`/), absent('agent_prompt entrypoint is omitted', /`agent_prompt`/), absent('reviewer_batch entrypoint is omitted', /`reviewer_batch`/), absent('quorum_submit entrypoint is omitted', /`quorum_submit`/)], /`dispatch` validates a registered role/, 'packages/main/src/core/agent-dispatch-registry.ts', /canonicalName/, [
    present('canonical prompt path is named', /`agent_prompt`\nprints the canonical package-registry prompt/),
    present('opt-in roster command is named', /`reviewer_list --json` reports the current Story's opt-in roster/),
    present('roster is policy computed', /computed in real time from shared workflow policy plus Story risk signals/),
    present('read-only batch uses same roster', /uses the same policy-computed opt-in path as `reviewer_list`/),
    present('signed run start is required', /calls `review_run_start`/),
    present('pass command is required', /through `review_pass_set`/),
    present('finding command is required', /through `finding_add`/),
    present('quorum submission prerequisite is named', /`quorum_submit` only after every required current reviewer pass exists/),
  ]],
  ['A20', 'M20', [present('old lifecycle table claims routine validate as TEST account', /\| \*\*TEST\*\* \| CLI \/ \u4e3b agent \| \u8dd1 routine `proof-or-stop validate`/u), absent('acceptance topology command is omitted', /acceptance_topology_check/), absent('delivery check command is omitted', /delivery_check_set/)], /all required verification intent, bugs, review evidence, ProofStory\nartifacts, acceptance topology, delivery\/summary checks, and freshness gates/, 'packages/main/src/core/machine.ts', /const missingEvidence = getBlockingVerificationEvidenceIssues/],
  ['A21', 'M21', [present('porcelain output is treated as one blocking class', /\u6709\u672a commit \u7684\u6539\u52a8\u65f6\u5148\u63d0\u4ea4\u518d\u63a8\u8fdb/u), present('the same guide defers metadata-only handling to a future placeholder', /metadata-only dirty handling[^\n]*B-9dfb once merged/i)], /Git cleanliness and drift classification/, 'packages/main/src/handlers/done-prepare.ts', /return classifyGitStatusRows/],
  ['A22', 'M22', [present('manual CLI patch bump is required after merge', /\u5fc5\u987b\u628a CLI patch \u7248\u672c\u9012\u589e 1/u)], /DONE effect automatically\npatch-bumps/, 'packages/main/src/handlers/done-effects.ts', /mergeLines\.push\(bumpVersionOnDoneMerge/],
  ['A23', 'M23', [present('future B-9dfb placeholder remains', /B-9dfb once merged/)], /Do not manually bypass `cleanTree`/, 'packages/main/src/handlers/done-prepare.ts', /runCloseoutPhase\(ctx, CLOSEOUT_PHASES\.cleanTree/],
  ['A24', 'M24', [present('decision options rule only allows two or one', /`options`: \u2265 2 \u4e2a\uff1b\u53ea\u6709 1 \u4e2a\u65f6/u), absent('empty-options exit is omitted', /options: \[\]/)], /`options: \[\]` single-solution exit/, 'packages/main/src/handlers/decision.ts', /args\.options\.length === 0/],
  ['A25', 'L01', [present('bare destructive test_auto example is runnable', /^proof-or-stop test_auto\s+# legacy/m), absent('bare test_auto has no confirm', /^proof-or-stop test_auto --confirm/m)], /every real run requires explicit `--confirm`/, 'packages/main/src/handlers/test-auto.ts', /if \(args\.confirm !== true\)/],
  ['A26', 'L02', [present('legacy materialized prompt directory is primary', /\.proof-or-stop-codex\/agents\//), present('legacy reviewer role appears in prompt example', /name: test-case-reviewer/), present('legacy prompt model field appears', /model: sonnet/)], /`agent_prompt`\nprints the canonical package-registry prompt/, 'packages/main/src/handlers/agent-prompt.ts', /renderPromptEntryForHost\(entry, 'claude'\)/],
].map(([id, sourceIssue, redChecks, greenPattern, sourcePath, sourcePattern, greenChecks = []]) => ({ id, sourceIssue, redChecks, greenPattern, sourcePath, sourcePattern, greenChecks }));

const authority = (kind, label, path, pattern, role = 'support') => ({ kind, label, path, pattern, role });

// Complete authority contract for every durable row. Each entry owns one
// material subclaim and resolves to the exact current line where its pattern
// starts. The audit cell must equal this set: no missing, vague, stale, or
// unreviewed extra citations are accepted.
const AUTHORITY_BY_ROW = new Map([
  ['A01', [authority('template', 'managed-global-thin-template', 'packages/main/src/init-assets.ts', /AGENTS_MD_GLOBAL_THIN_TEMPLATE/)]],
  ['A02', [authority('config', 'canonical-story-directory', 'proof-or-stop.config.json', /"storyDir": "\.proof-or-stop\/story\/actives"/)]],
  ['A03', [authority('interface', 'checklist-user-visible-result-field', 'packages/main/src/cli/command-catalog.ts', /userSees: z\.string/)]],
  ['A04', [
    authority('interface', 'core-aux-doc-list-registration', 'packages/main/src/cli/command-catalog.ts', /name: 'aux_doc_list'/),
    authority('interface', 'utils-aux-diagnose-registration', 'packages/utils/src/tool-defs.ts', /name: 'aux_diagnose'/),
    authority('interface', 'utils-aux-trace-registration', 'packages/utils/src/tool-defs.ts', /name: 'aux_trace'/),
    authority('interface', 'utils-aux-scan-registration', 'packages/utils/src/tool-defs.ts', /name: 'aux_scan'/),
    authority('interface', 'utils-aux-detail-registration', 'packages/utils/src/tool-defs.ts', /name: 'aux_detail'/),
    authority('interface', 'utils-aux-sync-registration', 'packages/utils/src/tool-defs.ts', /name: 'aux_sync'/),
    authority('interface', 'utils-aux-coverage-registration', 'packages/utils/src/tool-defs.ts', /name: 'aux_coverage'/),
    authority('interface', 'utils-aux-locate-registration', 'packages/utils/src/tool-defs.ts', /name: 'aux_locate'/),
  ]],
  ['A05', [
    authority('runtime', 'story-create-background-required-guard', 'packages/main/src/handlers/story-create.ts', /if \(typeof args\.background !== 'string' \|\| args\.background\.length === 0\)/, 'guard'),
    authority('runtime', 'story-create-background-validator-call', 'packages/main/src/handlers/story-create.ts', /const bgResult = validateBackground\(args\.background\)/, 'consumer'),
    authority('policy', 'background-canonical-section-set', 'packages/main/src/core/background-validator.ts', /export const REQUIRED_SECTIONS = \[/, 'definition'),
    authority('runtime', 'background-total-length-guard', 'packages/main/src/core/background-validator.ts', /if \(totalLen < 300\)/, 'guard'),
    authority('runtime', 'background-section-length-guard', 'packages/main/src/core/background-validator.ts', /if \(trimmed\.length < 50\)/, 'guard'),
    authority('runtime', 'background-trigger-identifier-guard', 'packages/main/src/core/background-validator.ts', /const matched = TRIGGER_ID_PATTERNS\.some/, 'producer'),
    authority('runtime', 'background-trigger-identifier-reject-branch', 'packages/main/src/core/background-validator.ts', /if \(!matched\) \{/, 'branch'),
  ]],
  ['A06', [
    authority('runtime', 'story-create-draft-english-authoring-guard', 'packages/main/src/handlers/story-create.ts', /assertEnglishAuthoringText\('story_create', storyCreateAuthoringFields\(\{/),
    authority('runtime', 'story-create-normal-english-authoring-guard', 'packages/main/src/handlers/story-create.ts', /assertEnglishAuthoringText\('story_create', storyCreateAuthoringFields\(args\)\)/),
  ]],
  ['A07', [authority('runtime', 'story-create-normal-initial-phase', 'packages/main/src/handlers/story-create.ts', /const phase: StoryPhase = hasChecklist \? 'INIT' : 'IDEA'/)]],
  ['A08', [
    authority('policy', 'init-check-worktree-create-effect', 'packages/main/src/core/lifecycle-registry.ts', /effects: \['story-worktree-create'\]/),
    authority('policy', 'plan-entry-cwd-worktree-gate', 'packages/main/src/core/lifecycle-registry.ts', /gates: \['cwd-worktree'\]/),
  ]],
  ['A09', [
    authority('policy', 'init-check-required-reviewer-pair', 'packages/main/src/core/init-check-gate.ts', /export const REQUIRED_INIT_CHECK_AGENTS/, 'definition'),
    authority('policy', 'init-check-six-transition-gates', 'packages/main/src/core/lifecycle-registry.ts', /gates: \['init-check', 'scope-boundary', 'execution-boundary', 'scope-freeze-check', 'scope-extension-proposals', 'scope-discard-digest'\]/, 'definition'),
    authority('interface', 'init-preflight-command-registration', 'packages/main/src/cli/command-catalog.ts', /name: 'init_preflight'/, 'definition'),
    authority('runtime', 'init-preflight-read-only-boundary-call', 'packages/main/src/handlers/init-preflight.ts', /assertBoundary\(args\)/, 'consumer'),
    authority('runtime', 'init-repair-explicit-acknowledgement-guard', 'packages/main/src/handlers/init-check.ts', /if \(args\.acknowledge !== true\)/, 'guard'),
    authority('runtime', 'init-repair-substantive-reason-guard', 'packages/main/src/handlers/init-check.ts', /if \(reason\.length < INIT_CHECK_FALLBACK_REASON_MIN\)/, 'guard'),
  ]],
  ['A10', [
    authority('runtime', 'owner-lease-cli-enforcement-choke-point', 'packages/main/src/cli-engine.ts', /enforceStoryOwnerLeaseGate\(cmd, parsed/, 'consumer'),
    authority('runtime', 'owner-lease-acquire-or-refresh-flow', 'packages/main/src/core/story-owner-lease.ts', /export function acquireOrRefreshOwnerLease/, 'definition'),
    authority('runtime', 'active-lease-force-takeover-guard', 'packages/main/src/core/story-owner-lease.ts', /if \(options\.kind === 'takeover' && !wasStale\)/, 'guard'),
    authority('runtime', 'takeover-owner-lease-write', 'packages/main/src/core/story-owner-lease.ts', /writeLease\(storyDir, transferred\)/, 'producer'),
    authority('runtime', 'session-brief-ownership-renderer', 'packages/main/src/handlers/session.ts', /export function renderOwnershipBlock/, 'definition'),
    authority('runtime', 'session-brief-ownership-render-consumer', 'packages/main/src/handlers/session.ts', /for \(const l of renderOwnershipBlock\(view\)\) lines\.push\(l\)/, 'consumer'),
  ]],
  ['A11', [authority('interface', 'current-intent-handoff-registration', 'packages/main/src/cli/command-catalog.ts', /name: 'testintent_handoff'/)]],
  ['A12', [
    authority('runtime', 'plan-review-blocker-count', 'packages/main/src/handlers/story-review.ts', /const blockerCount = issues\.filter/, 'producer'),
    authority('runtime', 'plan-review-zero-blocker-gate', 'packages/main/src/core/machine.ts', /else if \(\(lastRound\.blockerCount \?\? lastRound\.issueCount\) !== 0\)/, 'guard'),
  ]],
  ['A13', [
    authority('runtime', 'quick-path-eligibility-guard', 'packages/main/src/core/machine.ts', /if \(!policy\.quickPath\.enabled\) return false/, 'guard'),
    authority('runtime', 'quick-path-story-review-skip-branch', 'packages/main/src/core/machine.ts', /if \(!tookExpressChannel && !isRollbackDoor\) try \{/, 'branch'),
  ]],
  ['A14', [
    authority('runtime', 'scope-check-signature-mint', 'packages/main/src/handlers/scope-check.ts', /const _hash = signScopeCheck/, 'producer'),
    authority('runtime', 'scope-check-persistence', 'packages/main/src/handlers/scope-check.ts', /store\.writeScopeCheck/, 'producer'),
    authority('interface', 'scope-question-resolution-registration', 'packages/main/src/cli/command-catalog.ts', /name: 'scope_question_resolve'/, 'definition'),
    authority('runtime', 'scope-open-questions-present-guard', 'packages/main/src/handlers/story-review.ts', /if \(scopeData && scopeData\.openQuestions && scopeData\.openQuestions\.length > 0\)/, 'guard'),
    authority('runtime', 'scope-open-question-resolution-producer', 'packages/main/src/handlers/story-review.ts', /const unresolved = scopeData\.openQuestions\.filter/, 'producer'),
    authority('runtime', 'plan-to-dev-scope-contract-advisory', 'packages/main/src/handlers/phase-gates.ts', /export function runPlanToDevScopeAdvice/, 'definition'),
    authority('runtime', 'review-scope-contract-missing-block', 'packages/main/src/handlers/phase-gates.ts', /throw new Error\(\n\s+`Cannot enter \$\{phase\}: scope-contract\.json missing/, 'guard'),
    authority('runtime', 'plan-to-dev-scope-advice-transition-consumer', 'packages/main/src/handlers/transition-orchestrator.ts', /scopeGateReport \+= runPlanToDevScopeAdvice\(ctx, args\.storyId\)/, 'consumer'),
  ]],
  ['A15', [
    authority('interface', 'checklist-title-context-related-docs-fields', 'packages/main/src/cli/command-catalog.ts', /checklist: z\.array\(z\.object\(\{\n\s+title:[\s\S]*?relatedDocs:/),
    authority('interface', 'checklist-user-sees-field', 'packages/main/src/cli/command-catalog.ts', /userSees: z\.string/),
    authority('interface', 'checklist-excludes-field', 'packages/main/src/cli/command-catalog.ts', /excludes: z\.array\(z\.string\(\)\)/),
    authority('interface', 'checklist-affected-files-field', 'packages/main/src/cli/command-catalog.ts', /files: z\.object\(\{/),
    authority('interface', 'checklist-verification-intent-field', 'packages/main/src/cli/command-catalog.ts', /verificationIntent: verificationIntentSchema/),
  ]],
  ['A16', [authority('policy', 'bounded-defect-triage-policy', 'AGENTS.md', /Defect triage and bounded scope/)]],
  ['A17', [authority('runtime', 'nonlatest-pass-latest-finding-branch', 'packages/main/src/core/review-run.ts', /if \(currentRun && currentRun\.reviewRunId !== run\.reviewRunId && evidence\.kind !== 'pass'\)/)]],
  ['A18', [
    authority('runtime', 'pinned-verification-command-execution', 'packages/main/src/handlers/checklist.ts', /const run = await deps\.runCommand/, 'consumer'),
    authority('runtime', 'tool-owned-verification-receipt-mint', 'packages/main/src/handlers/checklist.ts', /const receipt: VerificationExecutionReceipt =/, 'producer'),
  ]],
  ['A19', [
    authority('policy', 'dispatch-implementer-role-registry', 'packages/main/src/core/agent-dispatch-registry.ts', /canonicalName: 'proof-or-stop-implementer'/, 'definition'),
    authority('policy', 'dispatch-implementer-target-cardinality', 'packages/main/src/core/agent-dispatch-registry.ts', /targetCardinality: 'exactly-one'/, 'definition'),
    authority('interface', 'dispatch-command-registration', 'packages/main/src/cli/command-catalog.ts', /name: 'dispatch'/, 'definition'),
    authority('runtime', 'dispatch-registry-request-validation', 'packages/main/src/handlers/story-dispatch.ts', /const resolved = validateAgentDispatchRequest/, 'consumer'),
    authority('runtime', 'canonical-agent-prompt-render', 'packages/main/src/handlers/agent-prompt.ts', /renderPromptEntryForHost\(entry, 'claude'\)/, 'consumer'),
    authority('runtime', 'reviewer-list-policy-roster-computation', 'packages/main/src/handlers/reviewer-list.ts', /const reviewers = computeActiveReviewers/, 'producer'),
    authority('runtime', 'reviewer-batch-shared-roster-computation', 'packages/main/src/handlers/reviewer-batch.ts', /const activeReviewers = computeActiveReviewers/, 'producer'),
    authority('runtime', 'reviewer-batch-side-effect-boundary-definition', 'packages/main/src/handlers/reviewer-batch.ts', /function assertBoundary\(args: ReviewerBatchArgs\)/, 'definition'),
    authority('runtime', 'reviewer-batch-all-side-effect-rejection-guards', 'packages/main/src/handlers/reviewer-batch.ts', /if \(args\.runCommands === true\)[\s\S]*?if \(args\.run === true\) rejected\.push\('run=true'\)/, 'guard'),
    authority('runtime', 'reviewer-batch-boundary-invocation', 'packages/main/src/handlers/reviewer-batch.ts', /assertBoundary\(args\)/, 'consumer'),
    authority('runtime', 'reviewer-batch-host-instruction-builder', 'packages/main/src/handlers/reviewer-batch.ts', /function laneLaunchInstruction/, 'definition'),
    authority('runtime', 'reviewer-batch-host-instruction-use', 'packages/main/src/handlers/reviewer-batch.ts', /launchInstruction: needsRun\s+\? laneLaunchInstruction\(/, 'consumer'),
    authority('interface', 'review-run-start-registration', 'packages/main/src/cli/command-catalog.ts', /name: 'review_run_start'/, 'definition'),
    authority('interface', 'review-pass-registration', 'packages/main/src/cli/command-catalog.ts', /name: 'review_pass_set'/, 'definition'),
    authority('interface', 'review-pass-run-id-schema', 'packages/main/src/cli/command-catalog.ts', /reviewRunId: z\.string\(\)\.describe\('Current reviewer run ID/, 'definition'),
    authority('runtime', 'review-pass-current-run-enforcement', 'packages/main/src/handlers/finding.ts', /const reviewRun = assertCurrentReviewRunForEvidence/, 'consumer'),
    authority('interface', 'reviewer-finding-registration', 'packages/main/src/cli/command-catalog.ts', /name: 'finding_add'/, 'definition'),
    authority('interface', 'reviewer-finding-run-id-schema', 'packages/main/src/cli/command-catalog.ts', /reviewRunId: z\.string\(\)\.optional\(\)\.describe\('Current proof-or-stop-review/, 'definition'),
    authority('runtime', 'reviewer-finding-lane-detection', 'packages/main/src/handlers/finding.ts', /const isReviewerAgent = isRegisteredReviewAgent/, 'producer'),
    authority('runtime', 'reviewer-finding-current-run-branch', 'packages/main/src/handlers/finding.ts', /if \(reviewerLane\) \{/, 'branch'),
    authority('runtime', 'reviewer-finding-current-run-enforcement', 'packages/main/src/handlers/finding.ts', /assertCurrentReviewRunForEvidence\(store, story, ctx\.root, reviewerLane, args\.reviewRunId\)/, 'consumer'),
    authority('interface', 'quorum-submit-registration', 'packages/main/src/cli/command-catalog.ts', /name: 'quorum_submit'/, 'definition'),
    authority('runtime', 'quorum-required-reviewer-pass-validation', 'packages/main/src/handlers/quorum-submit.ts', /function assertCurrentReviewerPasses/, 'definition'),
    authority('runtime', 'quorum-missing-or-invalid-pass-guard', 'packages/main/src/handlers/quorum-submit.ts', /if \(missing\.length > 0 \|\| state\.invalid\.length > 0\)/, 'guard'),
    authority('runtime', 'quorum-reviewer-pass-validation-call', 'packages/main/src/handlers/quorum-submit.ts', /const reviewerPasses = assertCurrentReviewerPasses/, 'consumer'),
  ]],
  ['A20', [
    authority('runtime', 'review-entry-verification-evidence-producer', 'packages/main/src/core/machine.ts', /const missingEvidence = getBlockingVerificationEvidenceIssues/, 'producer'),
    authority('runtime', 'review-entry-verification-evidence-guard', 'packages/main/src/core/machine.ts', /if \(missingEvidence\.length > 0\)/, 'guard'),
    authority('runtime', 'done-open-bug-producer', 'packages/main/src/core/machine.ts', /const openBugs = bugs\.bugs\.filter/, 'producer'),
    authority('runtime', 'done-open-bug-guard', 'packages/main/src/core/machine.ts', /if \(openBugs\.length > 0\)/, 'guard'),
    authority('runtime', 'test-entry-review-verdict-producer', 'packages/main/src/core/machine.ts', /const verdict = evaluateReviewVerdict/, 'producer'),
    authority('runtime', 'test-entry-review-verdict-guard', 'packages/main/src/core/machine.ts', /if \(!verdict\.ok\) return `Cannot enter TEST:/, 'guard'),
    authority('runtime', 'proofstory-review-completeness-producer', 'packages/main/src/handlers/phase-gates.ts', /const proofStoryReport = evaluateReviewCompleteness/, 'producer'),
    authority('runtime', 'proofstory-review-completeness-guard', 'packages/main/src/handlers/phase-gates.ts', /if \(proofStoryReport\.blocking\)/, 'guard'),
    authority('runtime', 'plan-acceptance-topology-producer', 'packages/main/src/handlers/transition-orchestrator.ts', /const topology = evaluateAcceptanceTopologyForContext/, 'producer'),
    authority('runtime', 'plan-acceptance-topology-guard', 'packages/main/src/handlers/transition-orchestrator.ts', /if \(topology\.blocking\)/, 'guard'),
    authority('runtime', 'done-delivery-freshness-producer', 'packages/main/src/core/machine.ts', /const deliveryCheckFreshness = evaluateDeliveryCheckFreshness\(\n\s+context\.storyId/, 'producer'),
    authority('runtime', 'done-delivery-freshness-guard', 'packages/main/src/core/machine.ts', /if \(!deliveryCheckFreshness\.ok\) return false/, 'guard'),
    authority('runtime', 'done-policy-summary-producer', 'packages/main/src/core/done-oracle.ts', /const summaryReq = policy\.done\.requireSummary/, 'producer'),
    authority('runtime', 'done-policy-summary-branch', 'packages/main/src/core/done-oracle.ts', /if \(summaryReq !== 'none'\)/, 'branch'),
  ]],
  ['A21', [
    authority('runtime', 'dirty-row-canonical-classification-call', 'packages/main/src/handlers/done-prepare.ts', /return classifyGitStatusRows/, 'consumer'),
    authority('runtime', 'done-prepare-dirty-classification-producer', 'packages/main/src/handlers/done-prepare.ts', /const initialDirtyClassification = classifyDirtyRows/, 'producer'),
    authority('runtime', 'done-prepare-blocking-entry-producer', 'packages/main/src/handlers/done-prepare.ts', /const initialBlockingEntries = initialDonePrepareBlockingEntries/, 'producer'),
    authority('runtime', 'done-prepare-blocking-entry-guard', 'packages/main/src/handlers/done-prepare.ts', /if \(initialBlockingEntries\.length > 0\)/, 'guard'),
  ]],
  ['A22', [
    authority('runtime', 'done-watched-input-change-decision', 'packages/main/src/handlers/done-effects.ts', /const runtimeSemverChanged = shouldBuildDoneMainPackageForChangedPaths/, 'producer'),
    authority('runtime', 'done-version-bump-effect-call', 'packages/main/src/handlers/done-effects.ts', /mergeLines\.push\(bumpVersionOnDoneMerge/, 'consumer'),
    authority('runtime', 'version-bump-no-watched-input-skip', 'packages/main/src/core/version-bump.ts', /if \(!opts\.shouldBump\) return VERSION_BUMP_SKIPPED_LINE/, 'guard'),
    authority('runtime', 'version-bump-apply-call', 'packages/main/src/core/version-bump.ts', /bump = applyPatchBump\(opts\.mainMergeRoot\)/, 'consumer'),
    authority('runtime', 'version-bump-git-commit', 'packages/main/src/core/version-bump.ts', /opts\.runGit\(\n\s+\['-c', 'commit\.gpgsign=false'/, 'consumer'),
  ]],
  ['A23', [authority('runtime', 'done-clean-tree-closeout-call', 'packages/main/src/handlers/done-prepare.ts', /runCloseoutPhase\(ctx, CLOSEOUT_PHASES\.cleanTree/)]],
  ['A24', [
    authority('runtime', 'decision-empty-options-branch', 'packages/main/src/handlers/decision.ts', /if \(args\.options\.length === 0\)/, 'branch'),
    authority('runtime', 'decision-empty-options-rationale-guard', 'packages/main/src/handlers/decision.ts', /if \(rationale\.trim\(\)\.length < 50 \|\| !hasExclusionRationale/, 'guard'),
    authority('runtime', 'decision-single-option-branch', 'packages/main/src/handlers/decision.ts', /else if \(args\.options\.length < 2\)/, 'branch'),
    authority('runtime', 'decision-single-option-cons-guard', 'packages/main/src/handlers/decision.ts', /if \(!opt\.cons \|\| opt\.cons\.length === 0\)/, 'guard'),
  ]],
  ['A25', [
    authority('runtime', 'test-auto-dry-run-preview-branch', 'packages/main/src/handlers/test-auto.ts', /if \(args\.dryRun\)/, 'branch'),
    authority('runtime', 'test-auto-confirmation-guard', 'packages/main/src/handlers/test-auto.ts', /if \(args\.confirm !== true\)/, 'guard'),
  ]],
  ['A26', [
    authority('runtime', 'modern-agent-prompt-host-render', 'packages/main/src/handlers/agent-prompt.ts', /renderPromptEntryForHost\(entry, 'claude'\)/, 'consumer'),
    authority('template', 'thin-adapter-package-prompt-registry', 'packages/main/src/init-assets.ts', /Thin asset mode uses the package prompt registry/, 'definition'),
    authority('runtime', 'modern-host-launch-instruction-builder', 'packages/main/src/handlers/reviewer-batch.ts', /function laneLaunchInstruction/, 'definition'),
    authority('runtime', 'modern-host-launch-instruction-use', 'packages/main/src/handlers/reviewer-batch.ts', /launchInstruction: needsRun\s+\? laneLaunchInstruction\(/, 'consumer'),
    authority('policy', 'legacy-verification-role-alias-map', 'packages/main/src/core/agent-dispatch-registry.ts', /aliases: \['test-intent', 'test-case-reviewer'\]/, 'definition'),
  ]],
]);

const FINAL_FORBIDDEN = new Map([
  ['A02', /docs\/story\//],
  ['A11', /(testintent_record|testintent_resume)/],
  ['A12', /issueCount=0/],
  ['A16', /fix every nearby bug|fix all infrastructure issues/i],
  ['A17', /PASS.*must.*latest run/i],
  ['A23', /B-9dfb once merged/],
]);

function lineOf(text, pattern) {
  const match = text.match(pattern);
  if (!match || match.index === undefined) return 0;
  return text.slice(0, match.index).split('\n').length;
}

const AUTHORITY_KINDS = new Set(['config', 'interface', 'policy', 'runtime', 'template']);
const AUTHORITY_ROLES = new Set(['support', 'definition', 'producer', 'guard', 'consumer', 'branch']);
const chain = (name, ...endpoints) => ({ name, endpoints: endpoints.map(([label, role]) => ({ label, role })) });
const REQUIRED_AUTHORITY_CHAINS = new Map([
  ['A05', [
    chain('background-entry', ['story-create-background-required-guard', 'guard'], ['story-create-background-validator-call', 'consumer']),
    chain('background-shape', ['background-canonical-section-set', 'definition'], ['background-total-length-guard', 'guard'], ['background-section-length-guard', 'guard']),
    chain('background-trigger-id', ['background-trigger-identifier-guard', 'producer'], ['background-trigger-identifier-reject-branch', 'branch']),
  ]],
  ['A09', [
    chain('init-transition-policy', ['init-check-required-reviewer-pair', 'definition'], ['init-check-six-transition-gates', 'definition']),
    chain('init-preflight-boundary', ['init-preflight-command-registration', 'definition'], ['init-preflight-read-only-boundary-call', 'consumer']),
    chain('init-repair-guards', ['init-repair-explicit-acknowledgement-guard', 'guard'], ['init-repair-substantive-reason-guard', 'guard']),
  ]],
  ['A10', [
    chain('owner-lease-enforcement', ['owner-lease-cli-enforcement-choke-point', 'consumer'], ['owner-lease-acquire-or-refresh-flow', 'definition']),
    chain('takeover', ['active-lease-force-takeover-guard', 'guard'], ['takeover-owner-lease-write', 'producer']),
    chain('session-render', ['session-brief-ownership-renderer', 'definition'], ['session-brief-ownership-render-consumer', 'consumer']),
  ]],
  ['A12', [chain('review-blocker-gate', ['plan-review-blocker-count', 'producer'], ['plan-review-zero-blocker-gate', 'guard'])]],
  ['A13', [chain('quick-review-skip', ['quick-path-eligibility-guard', 'guard'], ['quick-path-story-review-skip-branch', 'branch'])]],
  ['A14', [
    chain('scope-check', ['scope-check-signature-mint', 'producer'], ['scope-check-persistence', 'producer']),
    chain('scope-questions', ['scope-question-resolution-registration', 'definition'], ['scope-open-questions-present-guard', 'guard'], ['scope-open-question-resolution-producer', 'producer']),
    chain('plan-scope-advice', ['plan-to-dev-scope-contract-advisory', 'definition'], ['plan-to-dev-scope-advice-transition-consumer', 'consumer']),
    chain('review-scope-block', ['review-scope-contract-missing-block', 'guard']),
  ]],
  ['A18', [chain('tool-owned-receipt', ['pinned-verification-command-execution', 'consumer'], ['tool-owned-verification-receipt-mint', 'producer'])]],
  ['A19', [
    chain('dispatch', ['dispatch-implementer-role-registry', 'definition'], ['dispatch-implementer-target-cardinality', 'definition'], ['dispatch-command-registration', 'definition'], ['dispatch-registry-request-validation', 'consumer']),
    chain('prompt-render', ['canonical-agent-prompt-render', 'consumer']),
    chain('reviewer-list-roster', ['reviewer-list-policy-roster-computation', 'producer']),
    chain('reviewer-batch-roster', ['reviewer-batch-shared-roster-computation', 'producer']),
    chain('reviewer-batch-boundary', ['reviewer-batch-side-effect-boundary-definition', 'definition'], ['reviewer-batch-all-side-effect-rejection-guards', 'guard'], ['reviewer-batch-boundary-invocation', 'consumer']),
    chain('host-instruction', ['reviewer-batch-host-instruction-builder', 'definition'], ['reviewer-batch-host-instruction-use', 'consumer']),
    chain('review-run-start-interface', ['review-run-start-registration', 'definition']),
    chain('review-pass', ['review-pass-registration', 'definition'], ['review-pass-run-id-schema', 'definition'], ['review-pass-current-run-enforcement', 'consumer']),
    chain('reviewer-finding', ['reviewer-finding-registration', 'definition'], ['reviewer-finding-run-id-schema', 'definition'], ['reviewer-finding-lane-detection', 'producer'], ['reviewer-finding-current-run-branch', 'branch'], ['reviewer-finding-current-run-enforcement', 'consumer']),
    chain('quorum-pass-prerequisite', ['quorum-submit-registration', 'definition'], ['quorum-required-reviewer-pass-validation', 'definition'], ['quorum-missing-or-invalid-pass-guard', 'guard'], ['quorum-reviewer-pass-validation-call', 'consumer']),
  ]],
  ['A20', [
    chain('review-evidence-gate', ['review-entry-verification-evidence-producer', 'producer'], ['review-entry-verification-evidence-guard', 'guard']),
    chain('done-bug-gate', ['done-open-bug-producer', 'producer'], ['done-open-bug-guard', 'guard']),
    chain('test-review-verdict', ['test-entry-review-verdict-producer', 'producer'], ['test-entry-review-verdict-guard', 'guard']),
    chain('proofstory-review-gate', ['proofstory-review-completeness-producer', 'producer'], ['proofstory-review-completeness-guard', 'guard']),
    chain('acceptance-topology-gate', ['plan-acceptance-topology-producer', 'producer'], ['plan-acceptance-topology-guard', 'guard']),
    chain('delivery-freshness-gate', ['done-delivery-freshness-producer', 'producer'], ['done-delivery-freshness-guard', 'guard']),
    chain('summary-policy-gate', ['done-policy-summary-producer', 'producer'], ['done-policy-summary-branch', 'branch']),
  ]],
  ['A21', [chain('dirty-classification-block', ['dirty-row-canonical-classification-call', 'consumer'], ['done-prepare-dirty-classification-producer', 'producer'], ['done-prepare-blocking-entry-producer', 'producer'], ['done-prepare-blocking-entry-guard', 'guard'])]],
  ['A22', [chain('done-version-bump', ['done-watched-input-change-decision', 'producer'], ['done-version-bump-effect-call', 'consumer'], ['version-bump-no-watched-input-skip', 'guard'], ['version-bump-apply-call', 'consumer'], ['version-bump-git-commit', 'consumer'])]],
  ['A24', [
    chain('empty-options', ['decision-empty-options-branch', 'branch'], ['decision-empty-options-rationale-guard', 'guard']),
    chain('single-option', ['decision-single-option-branch', 'branch'], ['decision-single-option-cons-guard', 'guard']),
  ]],
  ['A25', [
    chain('test-auto-preview', ['test-auto-dry-run-preview-branch', 'branch']),
    chain('test-auto-confirm', ['test-auto-confirmation-guard', 'guard']),
  ]],
  ['A26', [
    chain('modern-prompt-render', ['modern-agent-prompt-host-render', 'consumer']),
    chain('thin-registry', ['thin-adapter-package-prompt-registry', 'definition']),
    chain('host-launch-instruction', ['modern-host-launch-instruction-builder', 'definition'], ['modern-host-launch-instruction-use', 'consumer']),
    chain('legacy-alias', ['legacy-verification-role-alias-map', 'definition']),
  ]],
]);

const SEMANTIC_CHAIN_BLOCK_START = '<!-- semantic-authority-chains:start -->';
const SEMANTIC_CHAIN_BLOCK_END = '<!-- semantic-authority-chains:end -->';

function renderSemanticChainRow(rowId, chains) {
  const claims = chains.map((semanticChain) => {
    const endpoints = semanticChain.endpoints.map((endpoint) => `${endpoint.label}@${endpoint.role}`).join(', ');
    return `\`${semanticChain.name}\` -> ${endpoints}`;
  }).join('; ');
  return `- **${rowId}**: ${claims}`;
}

function renderSemanticChainBlock(chainContract = REQUIRED_AUTHORITY_CHAINS) {
  return [...chainContract].map(([rowId, chains]) => renderSemanticChainRow(rowId, chains)).join('\n');
}

function auditSemanticChainPolicy(text, chainContract = REQUIRED_AUTHORITY_CHAINS) {
  const start = text.indexOf(SEMANTIC_CHAIN_BLOCK_START);
  const end = text.indexOf(SEMANTIC_CHAIN_BLOCK_END);
  if (start < 0 || end <= start) return false;
  const actual = text.slice(start + SEMANTIC_CHAIN_BLOCK_START.length, end).trim();
  return actual === renderSemanticChainBlock(chainContract);
}

function cloneAuthorityChains(chainContract = REQUIRED_AUTHORITY_CHAINS) {
  return new Map([...chainContract].map(([rowId, chains]) => [
    rowId,
    chains.map((semanticChain) => ({
      name: semanticChain.name,
      endpoints: semanticChain.endpoints.map((endpoint) => ({ ...endpoint })),
    })),
  ]));
}

function semanticChainSwapMutationChecks() {
  assert.ok(auditSemanticChainPolicy(auditText), 'audit must independently bind every named semantic chain endpoint and role');
  let swapCount = 0;
  let a20GuardSwapCount = 0;
  for (const [rowId, chains] of REQUIRED_AUTHORITY_CHAINS) {
    const candidates = chains.flatMap((semanticChain, chainIndex) => semanticChain.endpoints.map((endpoint, endpointIndex) => ({ ...endpoint, chainIndex, endpointIndex })));
    for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
        const left = candidates[leftIndex];
        const right = candidates[rightIndex];
        if (left.role !== right.role || left.chainIndex === right.chainIndex) continue;
        const mutated = cloneAuthorityChains();
        const mutatedChains = mutated.get(rowId);
        const leftEndpoint = mutatedChains[left.chainIndex].endpoints[left.endpointIndex];
        const rightEndpoint = mutatedChains[right.chainIndex].endpoints[right.endpointIndex];
        [leftEndpoint.label, rightEndpoint.label] = [rightEndpoint.label, leftEndpoint.label];
        assert.ok(!auditSemanticChainPolicy(auditText, mutated), `${rowId} same-role cross-chain endpoint swap must fail: ${left.label}<->${right.label}`);
        swapCount += 1;
        if (rowId === 'A20' && left.role === 'guard') a20GuardSwapCount += 1;
      }
    }
  }
  assert.ok(a20GuardSwapCount > 0, 'A20 must exercise same-role guard swaps across independent gate chains');
  const marker = `SEMANTIC_CHAIN_SWAP_MUTATION rows=${REQUIRED_AUTHORITY_CHAINS.size} swaps=${swapCount} a20GuardSwaps=${a20GuardSwapCount} PASS`;
  console.log(marker);
  return { marker, swapCount, a20GuardSwapCount };
}

function validateAuthorityRoleCompleteness(authorityMap = AUTHORITY_BY_ROW) {
  for (const [rowId, chains] of REQUIRED_AUTHORITY_CHAINS) {
    const entries = authorityMap.get(rowId);
    assert.ok(entries, `${rowId} semantic authority contract is missing`);
    const entryByLabel = new Map(entries.map((entry) => [entry.label, entry]));
    const modeledLabels = [];
    for (const semanticChain of chains) {
      const chainRoles = new Set();
      for (const endpoint of semanticChain.endpoints) {
        const entry = entryByLabel.get(endpoint.label);
        assert.ok(entry, `${rowId}/${semanticChain.name} semantic endpoint missing: ${endpoint.label}`);
        assert.equal(entry.role, endpoint.role, `${rowId}/${semanticChain.name} semantic endpoint role drifted: ${endpoint.label}`);
        modeledLabels.push(endpoint.label);
        chainRoles.add(endpoint.role);
      }
      const hasRuntimeEndpoint = semanticChain.endpoints.some((endpoint) => entryByLabel.get(endpoint.label)?.kind === 'runtime');
      if (hasRuntimeEndpoint) assert.ok([...chainRoles].some((role) => role !== 'definition' && role !== 'support'), `${rowId}/${semanticChain.name} runtime chain cannot be definition-only`);
    }
    assert.equal(new Set(modeledLabels).size, modeledLabels.length, `${rowId} semantic endpoints must belong to exactly one independent chain`);
    assert.deepEqual(new Set(modeledLabels), new Set(entries.map((entry) => entry.label)), `${rowId} every authority entry must belong to an explicit semantic chain`);
    for (const entry of entries.filter((candidate) => candidate.kind === 'runtime')) assert.notEqual(entry.role, 'support', `${rowId} runtime authority cannot silently default to support: ${entry.label}`);
  }
}

function resolvedAuthority(entry, sourceOverrides = new Map()) {
  assert.ok(AUTHORITY_KINDS.has(entry.kind), `unknown authority kind ${entry.kind} for ${entry.label}`);
  assert.ok(AUTHORITY_ROLES.has(entry.role), `unknown authority role ${entry.role} for ${entry.label}`);
  assert.match(entry.label, /^[a-z0-9]+(?:-[a-z0-9]+)+$/, `authority label must be descriptive kebab-case: ${entry.label}`);
  const absolute = resolve(root, entry.path);
  assert.ok(existsSync(absolute), `authority source path missing: ${entry.path}`);
  const source = sourceOverrides.get(entry.path) ?? read(absolute);
  const sourceMatch = source.match(entry.pattern);
  const line = lineOf(source, entry.pattern);
  assert.ok(line > 0 && line <= source.split('\n').length, `authority source pattern missing: ${entry.label}`);
  const matchedLine = source.split('\n')[line - 1].trim();
  const matchedText = sourceMatch?.[0] ?? '';
  if (entry.kind === 'runtime') {
    assert.ok(!/^(?:\/\/|\/\*|\*|\*\/|<!--|#)/.test(matchedLine), `runtime authority is comment-only: ${entry.label} at ${entry.path}:${line}`);
  }
  if (entry.role === 'producer') assert.match(matchedLine, /(?:\bconst\b.*=|\bwrite[A-Z]\w*\(|\bstore\.write\w*\(|\breturn\b)/, `producer role must bind an executable production/write line: ${entry.label}`);
  if (entry.role === 'guard') assert.match(matchedLine, /(?:\bif\s*\(|\belse if\s*\(|\bthrow\b)/, `guard role must bind an executable predicate/rejection line: ${entry.label}`);
  if (entry.role === 'consumer') {
    assert.match(`${matchedLine}\n${matchedText}`, /\w+\s*\(/, `consumer role must bind an executable call site: ${entry.label}`);
    assert.ok(!/^(?:export\s+)?(?:async\s+)?function\b/.test(matchedLine), `consumer role cannot bind only a function definition: ${entry.label}`);
  }
  if (entry.role === 'branch') assert.match(matchedLine, /(?:^|\}\s*)(?:else\s+)?if\s*\(/, `branch role must bind an executable branch: ${entry.label}`);
  return { kind: entry.kind, label: entry.label, path: entry.path, line, role: entry.role };
}

function resolvedAuthorityInventory(authorityMap = AUTHORITY_BY_ROW, sourceOverrides = new Map()) {
  validateAuthorityRoleCompleteness(authorityMap);
  const labels = [];
  const inventory = new Map();
  for (const row of AUDIT_ROWS) {
    const expected = authorityMap.get(row.id);
    assert.ok(expected && expected.length > 0, `${row.id} authority contract is missing`);
    const resolved = expected.map((entry) => resolvedAuthority(entry, sourceOverrides));
    inventory.set(row.id, resolved);
    labels.push(...resolved.map((entry) => entry.label));
  }
  assert.equal(new Set(labels).size, labels.length, 'authority subclaim labels must be globally unique');
  return inventory;
}

function renderAuthorityCell(entries) {
  return entries.map((entry) => `\`${entry.kind}:${entry.label}\` -> \`${entry.path}:${entry.line}\``).join('; ');
}

const SOURCE_AUTHORITY_INVERSION_OVERRIDES = new Map([
  ['background-trigger-identifier-reject-branch', 'if (matched) {'],
  ['session-brief-ownership-render-consumer', 'for (const l of []) lines.push(l);'],
  ['plan-review-zero-blocker-gate', 'else if ((lastRound.blockerCount ?? lastRound.issueCount) === 0)'],
  ['quick-path-story-review-skip-branch', 'if (tookExpressChannel || isRollbackDoor) try {'],
  ['plan-to-dev-scope-advice-transition-consumer', "scopeGateReport += '';"],
  ['done-prepare-blocking-entry-guard', 'if (initialBlockingEntries.length === 0)'],
]);

function sourceAuthorityMutationChecks() {
  const chainCount = [...REQUIRED_AUTHORITY_CHAINS.values()].reduce((sum, chains) => sum + chains.length, 0);
  let endpointCount = 0;
  for (const [rowId, chains] of REQUIRED_AUTHORITY_CHAINS) {
    const entries = AUTHORITY_BY_ROW.get(rowId);
    assert.ok(entries, `${rowId} source mutation authority inventory missing`);
    const executableEndpoints = chains
      .flatMap((semanticChain) => semanticChain.endpoints)
      .filter((endpoint) => endpoint.role !== 'definition' && endpoint.role !== 'support');
    let rowEndpointCount = 0;
    for (const endpoint of executableEndpoints) {
      const entry = entries.find((candidate) => candidate.label === endpoint.label);
      assert.ok(entry, `${rowId} source mutation authority missing: ${endpoint.label}`);
      const originalSource = read(resolve(root, entry.path));
      const replacement = SOURCE_AUTHORITY_INVERSION_OVERRIDES.get(entry.label) ?? `/* removed semantic endpoint ${entry.label} */`;
      const mutatedSource = originalSource.replace(entry.pattern, replacement);
      assert.notEqual(mutatedSource, originalSource, `${rowId} source mutation must alter the executable site: ${entry.label}`);
      assert.throws(
        () => resolvedAuthorityInventory(AUTHORITY_BY_ROW, new Map([[entry.path, mutatedSource]])),
        /authority source pattern missing:/,
        `${rowId} inverted/deleted executable authority must be rejected: ${entry.label}`,
      );
      rowEndpointCount += 1;
    }
    assert.equal(rowEndpointCount, executableEndpoints.length, `${rowId} source mutation count must cover every executable chain endpoint`);
    endpointCount += rowEndpointCount;
  }

  const definitionOnly = new Map(
    [...AUTHORITY_BY_ROW].map(([rowId, entries]) => [
      rowId,
      rowId === 'A05' ? entries.map((entry) => ({ ...entry, role: 'definition' })) : entries,
    ]),
  );
  assert.throws(
    () => validateAuthorityRoleCompleteness(definitionOnly),
    /A05\/background-entry semantic endpoint role drifted:/,
    'a composite runtime claim must not pass with definition-only authorities',
  );
  const aggregateMarker = `SOURCE_AUTHORITY_MUTATION rows=${REQUIRED_AUTHORITY_CHAINS.size} chains=${chainCount} executableEndpoints=${endpointCount} removalOrInversion=${endpointCount} PASS`;
  const roleMarker = 'SOURCE_AUTHORITY_ROLE_MUTATION A05/background-entry definition-only REJECTED';
  console.log(aggregateMarker);
  console.log(roleMarker);
  return { rows: REQUIRED_AUTHORITY_CHAINS.size, chainCount, endpointCount, roleMutationCount: 1, aggregateMarker, roleMarker };
}

function runAuditRows() {
  assert.equal(AUDIT_ROWS.length, 26, 'the durable audit must contain exactly 26 rows');
  assert.deepEqual(
    [...AUTHORITY_BY_ROW.keys()],
    AUDIT_ROWS.map((row) => row.id),
    'every durable row must have exactly one complete authority-contract entry in row order',
  );
  assert.deepEqual(
    AUDIT_ROWS.map((row) => row.sourceIssue),
    [...Array.from({ length: 24 }, (_, index) => `M${String(index + 1).padStart(2, '0')}`), 'L01', 'L02'],
    'audit rows must map one-to-one and in order to the original 24 major plus 2 low source issues',
  );
  const rows = selectedRow ? AUDIT_ROWS.filter((row) => row.id === selectedRow) : AUDIT_ROWS;
  assert.ok(rows.length > 0, `unknown audit row ${selectedRow}`);
  let failures = 0;
  for (const row of rows) {
    if (mode === 'baseline') {
      const results = row.redChecks.map((check) => ({ label: check.label, pass: check.test(baselineText) }));
      const red = results.every((result) => result.pass);
      console.log(`ROW ${row.id} ${red ? 'RED' : 'UNEXPECTED_GREEN'} sourceIssue=${row.sourceIssue} baseline=${baselineRef} predicates=${JSON.stringify(results)}`);
      if (red) failures += 1;
    } else {
      const source = row.sourcePath === 'AGENTS.md' ? currentText : read(resolve(root, row.sourcePath));
      const forbidden = FINAL_FORBIDDEN.get(row.id);
      const distinctGreen = row.greenChecks.map((check) => ({ label: check.label, pass: check.test(currentText) }));
      const green = row.greenPattern.test(currentText)
        && row.sourcePattern.test(source)
        && distinctGreen.every((result) => result.pass)
        && !(forbidden?.test(currentText) ?? false);
      console.log(`ROW ${row.id} ${green ? 'GREEN' : 'FAIL'} sourceIssue=${row.sourceIssue} finalLine=${lineOf(currentText, row.greenPattern)} source=${row.sourcePath}:${lineOf(source, row.sourcePattern)}`);
      if (!green && distinctGreen.some((result) => !result.pass)) console.log(`ROW_GREEN_CHECKS ${row.id} ${JSON.stringify(distinctGreen)}`);
      if (!green) failures += 1;
    }
  }
  if (mode === 'baseline') {
    console.log(`AUDIT baseline RED rows=${failures}/${rows.length} exit=1`);
    return 1;
  }
  console.log(`AUDIT final GREEN rows=${rows.length - failures}/${rows.length} exit=${failures ? 1 : 0}`);
  return failures ? 1 : 0;
}

function extractInvocations(text) {
  const values = new Set();
  for (const match of text.matchAll(/```bash\n([\s\S]*?)```/g)) {
    for (const line of match[1].split('\n')) {
      if (/^proof-or-stop\s/.test(line)) values.add(line.trim());
    }
  }
  for (const match of text.matchAll(/`(proof-or-stop\s+[^`\n]+)`/g)) values.add(match[1]);
  return [...values];
}

function shellTokens(value) {
  return value.match(/'(?:[^']*)'|"(?:\\.|[^"])*"|\S+/g)?.map((token) => {
    if ((token.startsWith("'") && token.endsWith("'")) || (token.startsWith('"') && token.endsWith('"'))) return token.slice(1, -1);
    return token;
  }) ?? [];
}

function parseScalar(value) {
  const replaced = value.replaceAll('B-xxxx', 'B-d854').replaceAll('/path/to/project', root);
  if (replaced === 'true') return true;
  if (replaced === 'false') return false;
  if (/^-?\d+$/.test(replaced)) return Number(replaced);
  if (replaced.startsWith('{') || replaced.startsWith('[')) return JSON.parse(replaced);
  return replaced;
}

function replaceStory(value) {
  if (typeof value === 'string') return value.replaceAll('B-xxxx', 'B-d854');
  if (Array.isArray(value)) return value.map(replaceStory);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceStory(item)]));
  return value;
}

function parseInvocation(text) {
  const rest = text.slice('proof-or-stop '.length);
  const tokens = shellTokens(rest);
  if (tokens[0] === '<command>' || tokens[0] === '--root') return { command: 'conceptual', payload: {}, args: tokens };
  if (tokens[0] === '--version' || tokens[0] === 'help') return { command: tokens[0], payload: {}, args: tokens };
  let command = tokens.shift();
  if (command === 'codex') command = tokens.shift() === 'verify' ? 'verify_codex' : 'codex_doctor';
  if (tokens.length === 1 && tokens[0].startsWith('{')) return { command, payload: replaceStory(JSON.parse(tokens[0])), args: [] };
  const payload = {};
  for (const token of tokens) {
    if (token === '--help') return { command, payload, args: ['--help'], help: true };
    assert.ok(token.startsWith('--'), `unsupported displayed token in ${text}: ${token}`);
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq === -1) payload[body] = true;
    else payload[body.slice(0, eq)] = parseScalar(body.slice(eq + 1));
  }
  return { command, payload: replaceStory(payload), args: [] };
}

const MUTATING = new Set([
  'story_advance', 'checklist_update', 'done_prepare', 'story_review',
  'verification_evidence_add', 'validate', 'done_required_validate',
  'understanding_set', 'decision_set', 'story_create', 'gap_log',
  'scope_question_resolve', 'scope_contract_init_from_plan',
  'fixture_batch_add', 'test_story', 'test_fixture', 'release_approve_push',
  'verify_codex', 'check_apply',
]);
const PHASE_BOUND_READS = new Set(['decision_get', 'understanding_get']);
const CONCEPTUAL = new Set(['aux_diagnose', 'test_fixture']);
const commandHelpCache = new Set();

function validateSchema(command, payload) {
  const tool = MAIN_TOOLS.find((candidate) => candidate.name === command);
  assert.ok(tool, `no MAIN_TOOLS schema for ${command}`);
  const result = z.object(tool.schema).strict().safeParse(payload);
  assert.ok(result.success, `${command} payload rejected: ${JSON.stringify(result.error?.issues)}`);
}

function argsFromPayload(command, payload) {
  if (command === 'verify_codex') return ['codex', 'verify'];
  if (command === 'codex_doctor') return ['codex', 'doctor'];
  const args = [command];
  for (const [key, value] of Object.entries(payload)) {
    if (value === true) args.push(`--${key}`);
    else args.push(`--${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`);
  }
  return args;
}

function executeLocal(args, label) {
  const result = spawnSync(process.execPath, [localCli, ...args], { cwd: root, encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, `${label} failed: ${(result.stderr || result.stdout).slice(0, 800)}`);
  return { stdoutBytes: result.stdout.length, stderrBytes: result.stderr.length };
}

function helpArgsFor(command) {
  if (command === 'verify_codex') return ['codex', 'verify', '--help'];
  if (command === 'codex_doctor') return ['codex', 'doctor', '--help'];
  return [command, '--help'];
}

function assertCommandAvailable(command, injectedRunner = null) {
  if (commandHelpCache.has(command) && injectedRunner === null) return;
  const runner = injectedRunner ?? ((args) => spawnSync(process.execPath, [localCli, ...args], { cwd: root, encoding: 'utf8', timeout: 120000 }));
  const result = runner(helpArgsFor(command), command);
  assert.equal(result.status, 0, `${command} --help must resolve: ${(result.stderr || result.stdout || '').slice(0, 800)}`);
  const displayName = command === 'verify_codex' ? 'codex verify' : command === 'codex_doctor' ? 'codex doctor' : command;
  assert.ok(`${result.stdout}\n${result.stderr}`.toLowerCase().includes(`proof-or-stop ${displayName}`.toLowerCase()), `${command} --help must identify the requested command`);
  if (injectedRunner === null) commandHelpCache.add(command);
}

function runCommandLedger({ verbose = true } = {}) {
  const invocations = extractInvocations(currentText);
  assert.equal(invocations.length, 46, `expected exactly 46 reviewed active invocations, got ${invocations.length}`);
  const ledger = [];
  for (const text of invocations) {
    const parsed = parseInvocation(text);
    let kind;
    let result = {};
    if (parsed.command === 'conceptual') {
      kind = 'global-syntax-template';
      result = executeLocal(['help'], text);
    } else if (CONCEPTUAL.has(parsed.command)) {
      kind = 'conceptual-template';
      assertCommandAvailable(parsed.command);
      if (MAIN_TOOLS.some((tool) => tool.name === parsed.command)) validateSchema(parsed.command, parsed.payload);
    } else if (parsed.command === '--version') {
      kind = 'read-only-exec';
      const run = spawnSync(process.execPath, [localCli, '--version'], { cwd: root, encoding: 'utf8' });
      assert.equal(run.status, 0);
      result = { version: run.stdout.trim() };
    } else if (parsed.command === 'help') {
      kind = 'read-only-exec';
      result = executeLocal(['help'], text);
    } else if (parsed.help) {
      kind = 'read-only-help-exec';
      result = executeLocal([parsed.command, '--help'], text);
    } else if (MUTATING.has(parsed.command) || PHASE_BOUND_READS.has(parsed.command) || (parsed.command === 'check' && parsed.payload.apply)) {
      assertCommandAvailable(parsed.command);
      kind = PHASE_BOUND_READS.has(parsed.command) ? 'phase-bound-read-schema' : 'mutating-schema';
      validateSchema(parsed.command, parsed.payload);
    } else if (parsed.command === 'check') {
      assertCommandAvailable(parsed.command);
      kind = 'read-only-diagnostic-exec';
      validateSchema(parsed.command, parsed.payload);
      const run = spawnSync(process.execPath, [localCli, 'check'], { cwd: root, encoding: 'utf8', timeout: 120000 });
      assert.ok(run.status === 0 || run.status === 1, `check returned unexpected exit ${run.status}`);
      assert.ok(`${run.stdout}\n${run.stderr}`.includes('Proof-or-Stop managed asset check'), 'check must return its diagnostic report');
      result = { diagnosticExit: run.status };
    } else if (MAIN_TOOLS.some((tool) => tool.name === parsed.command)) {
      assertCommandAvailable(parsed.command);
      kind = 'read-only-exec';
      validateSchema(parsed.command, parsed.payload);
      result = executeLocal(argsFromPayload(parsed.command, parsed.payload), text);
    } else if (parsed.command.startsWith('aux_')) {
      assertCommandAvailable(parsed.command);
      kind = 'read-only-extension-exec';
      result = executeLocal(argsFromPayload(parsed.command, parsed.payload), text);
    } else {
      throw new Error(`unclassified active invocation: ${text}`);
    }
    ledger.push({ text, fullArgv: text, command: parsed.command, payload: parsed.payload, kind, result });
    if (verbose) console.log(`CASE ${String(ledger.length).padStart(2, '0')} PASS kind=${kind} argv=${JSON.stringify(text)}`);
  }
  assert.equal(ledger.length, invocations.length, 'every exact invocation must have one ledger case');
  assert.equal(ledger[41]?.text, invocations[41], 'CASE 42 must be backed by the forty-second validated invocation');
  const case42Selector = 'CASE 42 PASS';

  const unknown = spawnSync(process.execPath, [localCli, '__agents_unknown_command__', '--help'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(unknown.status, 0, 'unknown-command sentinel must be rejected');
  if (verbose) console.log(`MUTATION unknown-command REJECTED exit=${unknown.status}`);
  const malformed = spawnSync(process.execPath, [localCli, 'story_get', '--storyId'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(malformed.status, 0, 'malformed story_get --storyId must be rejected');
  const malformedSelector = 'MUTATION malformed-argument REJECTED';
  if (verbose) console.log(`${malformedSelector} exit=${malformed.status}`);
  for (const command of ['aux_diagnose', 'test_fixture']) {
    assert.throws(
      () => assertCommandAvailable(command, () => ({ status: 1, stdout: '', stderr: `Unknown command: ${command}` })),
      /must resolve/,
      `${command} unavailability mutation must make command validation fail`,
    );
    if (verbose) console.log(`COMMAND_AVAILABILITY_MUTATION ${command} REJECTED`);
  }
  const aggregateSelector = `COMMAND_LEDGER cases=${ledger.length}/${invocations.length} PASS`;
  if (verbose) console.log(aggregateSelector);
  return { ledger, case42Selector, malformedSelector, aggregateSelector };
}

function tally(values) {
  return Object.fromEntries([...values.reduce((map, value) => map.set(value, (map.get(value) ?? 0) + 1), new Map())].sort());
}

function inventory(text) {
  const headings = [...text.matchAll(/^(#{1,6})\s+(.+)$/gm)].map((match) => `${match[1].length}:${match[2]}`);
  const listNesting = [...text.matchAll(/^(\s*)([-*+] |\d+\. )/gm)].map((match) => `${match[1].length}:${match[2].trim()}`);
  const tableRows = text.split('\n').filter((line) => /^\|.*\|$/.test(line));
  const blockquotes = text.split('\n').filter((line) => /^>/.test(line));
  const fenceLanguages = [...text.matchAll(/^```([^\n]*)$/gm)].map((match) => match[1] || 'plain');
  const htmlMarkers = [...text.matchAll(/<!--[^>]+-->/g)].map((match) => match[0]);
  const links = [...text.matchAll(/\[[^\]]+\]\([^\)]+\)/g)].map((match) => match[0]);
  const paths = [...new Set([...text.matchAll(/(?<![A-Za-z0-9_-])(?:\.?[A-Za-z0-9_.~-]+\/)+[A-Za-z0-9_.~*-]+/g)].map((match) => match[0]))].sort();
  const commandIds = [...new Set([...text.matchAll(/proof-or-stop\s+([a-z][a-z0-9_-]*(?:\s+[a-z][a-z0-9_-]*)?)/g)].map((match) => match[1]))].sort();
  const roles = [...new Set([...text.matchAll(/\b(?:proof-or-stop-review-[a-z-]+|product-reviewer|verification-intent|test-intent|test-case-reviewer)\b/g)].map((match) => match[0]))].sort();
  const jsonKeys = [...new Set([...text.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"\s*:/g)].map((match) => match[1]))].sort();
  const phases = [...new Set([...text.matchAll(/\b(?:IDEA|INIT_CHECK|INIT|PLAN|DEV|REVIEW|TEST_CASE_REVIEW|TEST_CASE|TEST|DONE|DISCARDED)\b/g)].map((match) => match[0]))].sort();
  const storyTokens = [...new Set([...text.matchAll(/\b(?:B-[A-Za-z0-9._-]+|CHK-[A-Za-z0-9._-]+|F-[A-Za-z0-9._-]+)\b/g)].map((match) => match[0]))].sort();
  return { headings, listNesting, tableRows, blockquotes, fenceLanguages: tally(fenceLanguages), htmlMarkers, links, paths, commandIds, roles, jsonKeys, phases, storyTokens };
}

const EXPECTED_BASELINE_INVENTORY_DIGEST = 'be1e674381b72472da79db4e2d7038e26ad140083cce32b9ff606f9ff6b61f6d';
const EXPECTED_FINAL_INVENTORY_DIGEST = '3cf17b530a1bbef51b0cee59dd3607425f689abc26a0f55504e7309bd489e908';
const EXPECTED_PROSE_DIGEST = '636f02ccb9eea88f5d6ef456e7679001d204a2ef83629aaf9b28eccd0209ab68';
const EXPECTED_AGENTS_SHA = 'e9f71ee10ad83e2a25a2519c17104c5740f07dbcdaea6b906ad724102a1aec26';

function inventoryDigest(text) {
  return sha256(JSON.stringify(inventory(text)));
}

function structuralChecks() {
  const baselineDigest = inventoryDigest(baselineText);
  const finalDigest = inventoryDigest(currentText);
  assert.equal(baselineDigest, EXPECTED_BASELINE_INVENTORY_DIGEST, 'baseline Markdown/token inventory drifted');
  assert.equal(finalDigest, EXPECTED_FINAL_INVENTORY_DIGEST, 'final Markdown/token inventory drifted');
  const required = [
    'scripts/verify-process-fact-contract.mjs', 'scripts/verify-runtime-fact-contract.mjs',
    'packages/main/src/core/process-fact-registry.ts', 'packages/main/src/core/runtime-fact-registry.ts',
    'aux_detail', 'aux_diagnose', 'aux_scan', 'aux_sync', 'aux_trace',
    'decision_get', 'decision_set', 'fixture_batch_add', 'gap_log', 'story_create',
    'test_fixture', 'test_story', 'understanding_get', 'understanding_set',
    'proof-or-stop-review-story-init', 'product-reviewer', 'proof-or-stop-review-test-coverage',
    'verificationIntent', 'verificationEvidence', 'reviewRunId', 'userSees',
    'INIT_CHECK', 'PLAN', 'DEV', 'REVIEW', 'TEST', 'DONE',
    '<!-- proof-or-stop:start -->', '<!-- proof-or-stop:end -->',
  ];
  for (const token of required) assert.ok(currentText.includes(token), `required structural/technical token missing: ${token}`);
  const wrong = currentText.replace('scripts/verify-process-fact-contract.mjs', 'scripts/WRONG.mjs');
  assert.notEqual(inventoryDigest(wrong), EXPECTED_FINAL_INVENTORY_DIGEST, 'WRONG path mutation must alter inventory');
  assert.ok(!wrong.includes('scripts/verify-process-fact-contract.mjs'), 'WRONG path mutation must remove canonical token');
  const marker = `STRUCTURE baselineDigest=${baselineDigest} finalDigest=${finalDigest} mutation=REJECTED`;
  const categoryMarkers = [];
  for (const [name, value] of Object.entries(inventory(currentText))) {
    const count = Array.isArray(value) ? value.length : Object.values(value).reduce((sum, item) => sum + item, 0);
    categoryMarkers.push(`STRUCTURE_CATEGORY ${name} count=${count} digest=${sha256(JSON.stringify(value))}`);
  }
  assert.ok(auditText.includes(baselineDigest) && auditText.includes(finalDigest), 'audit must bind both structural inventory digests');
  console.log(marker);
  return { marker, categoryMarkers };
}

function proseUnits(text) {
  const prose = text.replace(/```[\s\S]*?```/g, ' ').replace(/<!--[^>]+-->/g, ' ');
  return prose
    .split('\n')
    .map((line) => line.replace(/^\s*(?:#{1,6}|[-*+]|\d+\.)\s*/, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function semanticDigest(text) {
  return sha256(JSON.stringify(proseUnits(text)));
}

function semanticPolicy(text) {
  return text.includes('Story branches are\nlocal implementation details and must not be pushed.')
    && text.includes('Advisory issues are intentionally possible')
    && text.includes('`TEST_CASE` and `TEST_CASE_REVIEW` are compatibility-only phases for old data.')
    && text.includes('Code or document implementation changes are allowed only here.')
    && text.includes('The CLI does not automatically invent\nmissing reviewer evidence.');
}

function semanticChecks() {
  const digest = semanticDigest(currentText);
  assert.equal(digest, EXPECTED_PROSE_DIGEST, 'complete prose inventory drifted');
  assert.ok(semanticPolicy(currentText), 'canonical semantic invariants must pass');
  const mutations = [
    ['remote-push-polarity', currentText.replace('must not be pushed', 'must be pushed')],
    ['advisory-to-mandatory', currentText.replace('Advisory issues are intentionally possible', 'Advisory issues are mandatory blockers')],
    ['current-legacy-erasure', currentText.replace('compatibility-only phases for old data', 'current phases for all new data')],
    ['dev-only-to-every-phase', currentText.replace('allowed only here', 'allowed in every phase')],
    ['review-evidence-auto-invention', currentText.replace('does not automatically invent', 'automatically invents')],
  ];
  const mutationMarkers = [];
  for (const [name, mutated] of mutations) {
    assert.ok(!semanticPolicy(mutated) || semanticDigest(mutated) !== EXPECTED_PROSE_DIGEST, `${name} mutation must be rejected`);
    const marker = `SEMANTIC_MUTATION ${name} REJECTED`;
    mutationMarkers.push(marker);
    console.log(marker);
  }
  console.log(`SEMANTIC proseUnits=${proseUnits(currentText).length} digest=${digest}`);
  assert.ok(auditText.includes(digest), 'audit must bind normative sentence digest');
  return mutationMarkers;
}

function completenessPolicy(text) {
  return sha256(text) === EXPECTED_AGENTS_SHA
    && text.includes('Keep data, logic, and rendering separated:')
    && text.includes('Classify a new function before placing it.')
    && !text.includes('Mantenga los datos, la logica y la representacion separados');
}

function completenessChecks() {
  assert.ok(completenessPolicy(currentText), 'complete English AGENTS content must match the reviewed immutable digest');
  const mutations = [
    ['ascii-spanish-substitution', currentText.replace('Keep data, logic, and rendering separated:', 'Mantenga los datos, la logica y la representacion separados:')],
    ['ordinary-prose-deletion', currentText.replace('Classify a new function before placing it.', '')],
  ];
  for (const [name, mutated] of mutations) {
    const simulatedRefreshedAudit = auditText.replace(sha256(currentText), sha256(mutated));
    assert.ok(simulatedRefreshedAudit.includes(sha256(mutated)), `${name} mutation setup must simulate a refreshed audit SHA`);
    assert.ok(!completenessPolicy(mutated), `${name} mutation must be rejected even after the audit SHA is refreshed`);
    console.log(`COMPLETENESS_MUTATION ${name} REJECTED auditShaRefreshed=1`);
  }
  console.log(`COMPLETENESS agentsSha=${EXPECTED_AGENTS_SHA} english=PASS ordinaryProse=PASS`);
}

function unicodeChecks() {
  const markers = [];
  for (const path of [agentsPath, auditPath, fileURLToPath(import.meta.url)]) {
    const text = read(path);
    const nonAscii = [...text].filter((char) => char.codePointAt(0) > 127);
    assert.equal(/\p{Script=Han}/u.test(text), false, `${path} contains Han script`);
    assert.equal(text.includes('\ufffd'), false, `${path} contains U+FFFD`);
    assert.equal(nonAscii.length, 0, `${path} contains non-ASCII code points`);
    const marker = `UNICODE path=${path.slice(root.length + 1)} han=0 ufffd=0 nonAscii=0`;
    markers.push(marker);
    console.log(marker);
  }
  return markers;
}

function managedBlockChecks() {
  const expected = AGENTS_MD_GLOBAL_THIN_TEMPLATE.slice(0, AGENTS_MD_GLOBAL_THIN_TEMPLATE.indexOf('<!-- proof-or-stop:end -->') + '<!-- proof-or-stop:end -->'.length);
  const actual = currentText.slice(0, currentText.indexOf('<!-- proof-or-stop:end -->') + '<!-- proof-or-stop:end -->'.length);
  assert.equal(actual, expected, 'AGENTS managed block must exactly match current global-thin template');
  const check = spawnSync(process.execPath, [localCli, 'check', '--json'], { cwd: root, encoding: 'utf8', timeout: 120000 });
  assert.ok(check.status === 0 || check.status === 1, `managed check command returned unexpected exit ${check.status}: ${check.stderr}`);
  const parsed = JSON.parse(check.stdout);
  const item = parsed.items.find((entry) => entry.id === 'doc:AGENTS.md');
  assert.equal(item?.status, 'OK', 'managed check must report doc:AGENTS.md OK');
  console.log(`MANAGED id=doc:AGENTS.md status=${item.status}`);
}

function directOutcome(run) {
  if (run.error?.code) return run.error.code;
  return run.status === null ? 'STATUS_NULL' : `EXIT_${run.status}`;
}

function executableMode(mode) {
  return (mode & 0o111) !== 0;
}

function runtimeDrift(evidence) {
  const components = [];
  if (evidence.local.version !== evidence.global.version) components.push('VERSION');
  if (evidence.local.realpath !== evidence.global.realpath) components.push('REALPATH');
  if (!evidence.global.executable || evidence.global.directStatus !== 0) components.push('EXECUTABILITY');
  return {
    components,
    classification: components.length === 0 ? 'ALIGNED' : `${components.join('_AND_')}_DRIFT`,
  };
}

function inspectRuntimeEnvironment() {
  const localRealpath = realpathSync(localCli);
  const localNodeRun = spawnSync(process.execPath, [localRealpath, '--version'], { cwd: root, encoding: 'utf8', timeout: 10000 });
  assert.equal(localNodeRun.status, 0, `repository-local authority is unavailable through Node: ${localNodeRun.stderr || localNodeRun.error?.message || 'unknown failure'}`);
  const localVersion = localNodeRun.stdout.trim();
  assert.ok(localVersion.length > 0, 'repository-local authority returned an empty version');

  const globalRealpath = realpathSync(globalCli);
  const globalMode = statSync(globalRealpath).mode & 0o777;
  const globalDirectRun = spawnSync(globalCli, ['--version'], { cwd: root, encoding: 'utf8', timeout: 10000 });
  const globalDirectOutcome = directOutcome(globalDirectRun);
  let globalVersion;
  let directVersion = null;
  let versionSource;
  let fallbackStatus = null;
  let fallbackOutcome = 'NOT_USED';
  let fallbackVersion = null;
  if (globalDirectRun.status === 0) {
    directVersion = globalDirectRun.stdout.trim();
    globalVersion = directVersion;
    versionSource = 'DIRECT';
  } else {
    const fallbackRun = spawnSync(process.execPath, [globalRealpath, '--version'], { cwd: root, encoding: 'utf8', timeout: 10000 });
    fallbackStatus = fallbackRun.status;
    fallbackOutcome = directOutcome(fallbackRun);
    assert.equal(fallbackRun.status, 0, `Node fallback cannot inspect resolved global CLI artifact: ${fallbackRun.stderr || fallbackRun.error?.message || 'unknown failure'}`);
    fallbackVersion = fallbackRun.stdout.trim();
    globalVersion = fallbackVersion;
    versionSource = 'NODE_FALLBACK';
  }
  assert.ok(globalVersion.length > 0, 'global CLI artifact inspection returned an empty version');

  const evidence = {
    local: {
      authority: 'REPOSITORY_LOCAL',
      invoked: localCli,
      realpath: localRealpath,
      execution: 'NODE',
      nodeStatus: localNodeRun.status,
      version: localVersion,
    },
    global: {
      invoked: globalCli,
      realpath: globalRealpath,
      mode: globalMode,
      executable: executableMode(globalMode),
      directStatus: globalDirectRun.status,
      directErrorCode: globalDirectRun.error?.code ?? null,
      directOutcome: globalDirectOutcome,
      directVersion,
      versionSource,
      fallbackStatus,
      fallbackOutcome,
      fallbackVersion,
      version: globalVersion,
    },
  };
  evidence.classification = runtimeDrift(evidence).classification;
  return evidence;
}

function validateRuntimeEvidence(evidence, { bindObservedPaths = true } = {}) {
  assert.equal(evidence.local.authority, 'REPOSITORY_LOCAL', 'global CLI must not be substituted as the behavior authority');
  assert.equal(evidence.local.invoked, localCli, 'repository-local behavior authority path drifted');
  assert.equal(evidence.local.execution, 'NODE', 'repository-local authority must use its bounded Node entrypoint');
  assert.equal(evidence.local.nodeStatus, 0, 'repository-local behavior authority is unavailable');
  assert.ok(evidence.local.version.length > 0, 'repository-local authority version is missing');
  assert.equal(evidence.global.invoked, globalCli, 'global invoked path drifted');
  assert.equal(evidence.global.executable, executableMode(evidence.global.mode), 'global executable claim contradicts resolved artifact mode');
  const expectedDirectOutcome = evidence.global.directErrorCode ?? (evidence.global.directStatus === null ? 'STATUS_NULL' : `EXIT_${evidence.global.directStatus}`);
  assert.equal(evidence.global.directOutcome, expectedDirectOutcome, 'global direct outcome conceals the observed failure/status');
  if (evidence.global.directStatus === 0) {
    assert.equal(evidence.global.directOutcome, 'EXIT_0', 'successful global direct execution must report EXIT_0');
    assert.equal(evidence.global.directErrorCode, null, 'successful global direct execution cannot also report an error');
    assert.equal(evidence.global.versionSource, 'DIRECT', 'successful global direct execution must own its version result');
    assert.ok(evidence.global.directVersion?.length > 0, 'successful global direct execution must retain its version result');
    assert.equal(evidence.global.version, evidence.global.directVersion, 'selected global version must be the direct result');
    assert.equal(evidence.global.fallbackStatus, null, 'successful global direct execution must not also run the Node fallback');
    assert.equal(evidence.global.fallbackOutcome, 'NOT_USED', 'successful global direct execution must report fallback NOT_USED');
    assert.equal(evidence.global.fallbackVersion, null, 'successful global direct execution must not retain a fallback version');
  } else {
    assert.equal(evidence.global.directVersion, null, 'unavailable global direct execution must not retain a direct version');
    assert.equal(evidence.global.versionSource, 'NODE_FALLBACK', 'unavailable global direct execution must use bounded Node fallback');
    assert.equal(evidence.global.fallbackStatus, 0, 'global resolved-artifact Node fallback is unavailable');
    assert.equal(evidence.global.fallbackOutcome, 'EXIT_0', 'successful global Node fallback must report EXIT_0');
    assert.ok(evidence.global.fallbackVersion?.length > 0, 'successful global Node fallback must retain its version result');
    assert.equal(evidence.global.version, evidence.global.fallbackVersion, 'selected global version must be the sole fallback result');
  }
  if (bindObservedPaths) {
    assert.equal(evidence.local.realpath, realpathSync(localCli), 'local authority realpath reporting drifted');
    assert.equal(evidence.global.realpath, realpathSync(globalCli), 'global realpath reporting drifted');
  }
  assert.equal(evidence.classification, runtimeDrift(evidence).classification, 'reported runtime classification suppresses observed drift');
}

function renderRuntimeEvidence(evidence) {
  const mode = evidence.global.mode.toString(8).padStart(4, '0');
  const drift = runtimeDrift(evidence);
  return {
    localMarker: `RUNTIME_LOCAL authority=${evidence.local.authority} invoked=${evidence.local.invoked} realpath=${evidence.local.realpath} execution=${evidence.local.execution} nodeOutcome=EXIT_${evidence.local.nodeStatus} version=${evidence.local.version}`,
    globalMarker: `RUNTIME_GLOBAL invoked=${evidence.global.invoked} realpath=${evidence.global.realpath} mode=${mode} executable=${evidence.global.executable} directOutcome=${evidence.global.directOutcome} directVersionPresent=${evidence.global.directVersion !== null} versionSource=${evidence.global.versionSource} fallbackOutcome=${evidence.global.fallbackOutcome} fallbackVersionPresent=${evidence.global.fallbackVersion !== null} version=${evidence.global.version}`,
    currentMarker: `RUNTIME_CURRENT classification=${evidence.classification} runScoped=true driftVersion=${drift.components.includes('VERSION')} driftRealpath=${drift.components.includes('REALPATH')} driftExecutability=${drift.components.includes('EXECUTABILITY')}`,
  };
}

function runtimeReportPolicy(evidence, markers) {
  const expected = renderRuntimeEvidence(evidence);
  return expected.localMarker === markers.localMarker
    && expected.globalMarker === markers.globalMarker
    && expected.currentMarker === markers.currentMarker;
}

function runtimeEvidenceMutationChecks(evidence, markers) {
  const pretendingExecutable = { ...markers, globalMarker: markers.globalMarker.replace(`executable=${evidence.global.executable}`, `executable=${!evidence.global.executable}`) };
  assert.ok(!runtimeReportPolicy(evidence, pretendingExecutable), 'pretending the global artifact is executable must fail');
  const hidingDirectOutcome = { ...markers, globalMarker: markers.globalMarker.replace(`directOutcome=${evidence.global.directOutcome}`, 'directOutcome=HIDDEN') };
  assert.ok(!runtimeReportPolicy(evidence, hidingDirectOutcome), 'hiding the global direct EACCES/status outcome must fail');
  const substitutingAuthority = { ...markers, localMarker: markers.localMarker.replace('authority=REPOSITORY_LOCAL', 'authority=GLOBAL') };
  assert.ok(!runtimeReportPolicy(evidence, substitutingAuthority), 'substituting global CLI as local behavior authority must fail');
  const suppressingDrift = { ...markers, currentMarker: 'RUNTIME_CURRENT classification=ALIGNED runScoped=true driftVersion=false driftRealpath=false driftExecutability=false' };
  assert.ok(!runtimeReportPolicy(evidence, suppressingDrift), 'suppressing version/path/executability drift must fail');

  const validDirect = structuredClone(evidence);
  validDirect.global.mode = 0o755;
  validDirect.global.executable = true;
  validDirect.global.directStatus = 0;
  validDirect.global.directErrorCode = null;
  validDirect.global.directOutcome = 'EXIT_0';
  validDirect.global.directVersion = validDirect.local.version;
  validDirect.global.versionSource = 'DIRECT';
  validDirect.global.fallbackStatus = null;
  validDirect.global.fallbackOutcome = 'NOT_USED';
  validDirect.global.fallbackVersion = null;
  validDirect.global.version = validDirect.global.directVersion;
  validDirect.classification = runtimeDrift(validDirect).classification;
  validateRuntimeEvidence(validDirect, { bindObservedPaths: false });
  const doubleSuccess = structuredClone(validDirect);
  doubleSuccess.global.fallbackStatus = 0;
  doubleSuccess.global.fallbackOutcome = 'EXIT_0';
  doubleSuccess.global.fallbackVersion = doubleSuccess.global.version;
  assert.throws(
    () => validateRuntimeEvidence(doubleSuccess, { bindObservedPaths: false }),
    /must not also run the Node fallback|fallback NOT_USED|must not retain a fallback version/,
    'direct and fallback double-success must be rejected',
  );

  const validFallback = structuredClone(evidence);
  validFallback.global.directStatus = null;
  validFallback.global.directErrorCode = 'EACCES';
  validFallback.global.directOutcome = 'EACCES';
  validFallback.global.directVersion = null;
  validFallback.global.versionSource = 'NODE_FALLBACK';
  validFallback.global.fallbackStatus = 0;
  validFallback.global.fallbackOutcome = 'EXIT_0';
  validFallback.global.fallbackVersion = validFallback.global.version;
  validFallback.classification = runtimeDrift(validFallback).classification;
  validateRuntimeEvidence(validFallback, { bindObservedPaths: false });
  const invalidFallback = structuredClone(validFallback);
  invalidFallback.global.fallbackOutcome = 'NOT_USED';
  assert.throws(
    () => validateRuntimeEvidence(invalidFallback, { bindObservedPaths: false }),
    /successful global Node fallback must report EXIT_0/,
    'inconsistent fallback success state must be rejected',
  );

  const marker = 'RUNTIME_ENV_MUTATION pretendingExecutable=REJECTED hiddenDirectOutcome=REJECTED globalAsAuthority=REJECTED suppressedDrift=REJECTED directAndFallbackDoubleSuccess=REJECTED invalidFallbackState=REJECTED';
  console.log(marker);
  return marker;
}

function executableAlignedRuntimeSimulation(evidence) {
  const simulated = structuredClone(evidence);
  simulated.global.realpath = simulated.local.realpath;
  simulated.global.mode = 0o755;
  simulated.global.executable = true;
  simulated.global.directStatus = 0;
  simulated.global.directErrorCode = null;
  simulated.global.directOutcome = 'EXIT_0';
  simulated.global.directVersion = simulated.local.version;
  simulated.global.versionSource = 'DIRECT';
  simulated.global.fallbackStatus = null;
  simulated.global.fallbackOutcome = 'NOT_USED';
  simulated.global.fallbackVersion = null;
  simulated.global.version = simulated.local.version;
  simulated.classification = 'ALIGNED';
  validateRuntimeEvidence(simulated, { bindObservedPaths: false });
  assert.ok(runtimeReportPolicy(simulated, renderRuntimeEvidence(simulated)), 'executable same-version aligned simulation must report faithfully');
  const marker = 'RUNTIME_SIMULATION executable=true sameVersion=true sameRealpath=true classification=ALIGNED PASS';
  console.log(marker);
  return marker;
}

function executableSameVersionRuntimeSimulation(evidence) {
  const simulated = structuredClone(evidence);
  simulated.global.mode = 0o755;
  simulated.global.executable = true;
  simulated.global.directStatus = 0;
  simulated.global.directErrorCode = null;
  simulated.global.directOutcome = 'EXIT_0';
  simulated.global.directVersion = simulated.local.version;
  simulated.global.versionSource = 'DIRECT';
  simulated.global.fallbackStatus = null;
  simulated.global.fallbackOutcome = 'NOT_USED';
  simulated.global.fallbackVersion = null;
  simulated.global.version = simulated.local.version;
  simulated.classification = runtimeDrift(simulated).classification;
  validateRuntimeEvidence(simulated, { bindObservedPaths: false });
  assert.ok(!runtimeDrift(simulated).components.includes('VERSION'), 'same-version simulation must remove version drift');
  assert.ok(!runtimeDrift(simulated).components.includes('EXECUTABILITY'), 'executable simulation must remove executability drift');
  const marker = `RUNTIME_SIMULATION executable=true sameVersion=true retainedRealpathRelation=${simulated.global.realpath === simulated.local.realpath ? 'SAME' : 'DIFFERENT'} classification=${simulated.classification} PASS`;
  console.log(marker);
  return marker;
}

function historicalRuntimeMarkerPolicy(historicalMarker, currentMarker, currentClassification) {
  return historicalMarker.startsWith(`${HISTORICAL_RUNTIME_RECEIPT.selector} context=initial-audit `)
    && historicalMarker.includes(`receiptCommit=${HISTORICAL_RUNTIME_RECEIPT.commit}`)
    && historicalMarker.includes(`receiptBlob=${HISTORICAL_RUNTIME_RECEIPT.blob}`)
    && historicalMarker.includes(`intentRef=${HISTORICAL_RUNTIME_RECEIPT.intentRef}`)
    && historicalMarker.includes(`outputDigest=${HISTORICAL_RUNTIME_RECEIPT.outputDigest}`)
    && historicalMarker.endsWith(`currentClassification=${currentClassification}`)
    && currentMarker.startsWith(`RUNTIME_CURRENT classification=${currentClassification} runScoped=true `);
}

function historicalRuntimeReceiptChecks(currentMarker, currentClassification) {
  const commitSpec = `${HISTORICAL_RUNTIME_RECEIPT.commit}^{commit}`;
  const resolvedCommit = execFileSync('git', ['rev-parse', commitSpec], { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(resolvedCommit, HISTORICAL_RUNTIME_RECEIPT.commit, 'historical runtime receipt commit identity drifted');
  const objectSpec = `${HISTORICAL_RUNTIME_RECEIPT.commit}:${HISTORICAL_RUNTIME_RECEIPT.path}`;
  const resolvedBlob = execFileSync('git', ['rev-parse', objectSpec], { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(resolvedBlob, HISTORICAL_RUNTIME_RECEIPT.blob, 'historical runtime receipt blob identity drifted');
  const immutableChecklist = execFileSync('git', ['show', objectSpec], { cwd: root, encoding: 'utf8' });
  assert.equal(gitBlobOid(immutableChecklist), HISTORICAL_RUNTIME_RECEIPT.blob, 'historical runtime receipt content must hash to the bound blob');
  const parsed = JSON.parse(immutableChecklist);
  const item = parsed.items?.find((candidate) => candidate.id === HISTORICAL_RUNTIME_RECEIPT.itemId);
  assert.ok(item, 'historical runtime receipt checklist item is missing');
  const intent = item.verificationIntent?.edge?.[1];
  assert.equal(intent?.verification?.command, HISTORICAL_RUNTIME_RECEIPT.command, 'historical runtime intent command drifted');
  assert.equal(intent?.verification?.selector, HISTORICAL_RUNTIME_RECEIPT.selector, 'historical runtime intent selector drifted');
  const matchingEvidence = item.verificationEvidence?.filter((entry) => entry.intentRef === HISTORICAL_RUNTIME_RECEIPT.intentRef) ?? [];
  assert.equal(matchingEvidence.length, 1, 'historical runtime receipt must bind exactly one correct intent evidence record');
  const evidence = matchingEvidence[0];
  assert.equal(evidence.command, HISTORICAL_RUNTIME_RECEIPT.command, 'historical runtime evidence command drifted');
  assert.equal(evidence.result, 'pass', 'historical runtime evidence result must be pass');
  assert.equal(evidence.receipt?.exitCode, 0, 'historical runtime receipt exit must be zero');
  assert.equal(evidence.receipt?.outputDigest, HISTORICAL_RUNTIME_RECEIPT.outputDigest, 'historical runtime receipt output digest drifted');
  assert.equal(evidence.receipt?.selectorMatched, true, 'historical runtime receipt must record selectorMatched=true');
  assert.equal(Buffer.byteLength(evidence.receipt?.outputTail ?? ''), HISTORICAL_RUNTIME_RECEIPT.outputTailBytes, 'historical runtime receipt tail byte length drifted');
  assert.equal((evidence.receipt.outputTail.match(new RegExp(HISTORICAL_RUNTIME_RECEIPT.selector, 'g')) ?? []).length, 1, 'historical runtime receipt tail must preserve exactly one classification selector');
  for (const token of [
    HISTORICAL_RUNTIME_RECEIPT.commit,
    HISTORICAL_RUNTIME_RECEIPT.path,
    HISTORICAL_RUNTIME_RECEIPT.blob,
    HISTORICAL_RUNTIME_RECEIPT.intentRef,
    HISTORICAL_RUNTIME_RECEIPT.selector,
    HISTORICAL_RUNTIME_RECEIPT.outputDigest,
    `${HISTORICAL_RUNTIME_RECEIPT.outputTailBytes} bytes`,
  ]) assert.ok(auditText.includes(token), `audit must bind immutable historical runtime receipt token: ${token}`);

  const historicalMarker = [
    HISTORICAL_RUNTIME_RECEIPT.selector,
    'context=initial-audit',
    `receiptCommit=${HISTORICAL_RUNTIME_RECEIPT.commit}`,
    `receiptBlob=${HISTORICAL_RUNTIME_RECEIPT.blob}`,
    `intentRef=${HISTORICAL_RUNTIME_RECEIPT.intentRef}`,
    `outputDigest=${HISTORICAL_RUNTIME_RECEIPT.outputDigest}`,
    `currentClassification=${currentClassification}`,
  ].join(' ');
  assert.ok(historicalRuntimeMarkerPolicy(historicalMarker, currentMarker, currentClassification), 'historical receipt and current runtime contexts must remain distinct');
  console.log(historicalMarker);
  console.log(`RUNTIME_HISTORICAL_RECEIPT commit=${resolvedCommit} blob=${resolvedBlob} intent=${HISTORICAL_RUNTIME_RECEIPT.intentRef} tailBytes=${HISTORICAL_RUNTIME_RECEIPT.outputTailBytes} selectorCount=1 VERIFIED`);

  const missingContext = historicalMarker.replace(' context=initial-audit', '');
  assert.ok(!historicalRuntimeMarkerPolicy(missingContext, currentMarker, currentClassification), 'removing initial-audit context must invalidate historical runtime evidence');
  const conflatedWithCurrent = historicalMarker.replace(' context=initial-audit', ' context=current-live');
  assert.ok(!historicalRuntimeMarkerPolicy(conflatedWithCurrent, currentMarker, currentClassification), 'presenting historical runtime evidence as current must fail');
  console.log('RUNTIME_CONTEXT_MUTATION missing-initial-context REJECTED');
  console.log('RUNTIME_CONTEXT_MUTATION historical-as-current REJECTED');
  return historicalMarker;
}

function runtimeChecks() {
  const evidence = inspectRuntimeEnvironment();
  validateRuntimeEvidence(evidence);
  const markers = renderRuntimeEvidence(evidence);
  assert.ok(runtimeReportPolicy(evidence, markers), 'runtime report must disclose every observed authority/path/version/executability fact');
  console.log(markers.localMarker);
  console.log(markers.globalMarker);
  console.log(markers.currentMarker);
  const historicalMarker = historicalRuntimeReceiptChecks(markers.currentMarker, evidence.classification);
  const mutationMarker = runtimeEvidenceMutationChecks(evidence, markers);
  const sameVersionSimulationMarker = executableSameVersionRuntimeSimulation(evidence);
  const simulationMarker = executableAlignedRuntimeSimulation(evidence);
  return { evidence, ...markers, historicalMarker, mutationMarker, sameVersionSimulationMarker, simulationMarker };
}

function auditRowCells(text, id) {
  const line = text.split('\n').find((candidate) => candidate.startsWith(`| ${id} |`));
  return line ? line.split('|').slice(1, -1).map((cell) => cell.trim()) : null;
}

function auditCitationPolicy(text, authorityInventory = resolvedAuthorityInventory()) {
  if (!auditSemanticChainPolicy(text)) {
    if (text === auditText) console.error('AUDIT_CITATION_POLICY semantic-chain-contract-mismatch');
    return false;
  }
  for (const row of AUDIT_ROWS) {
    const reject = (reason) => {
      if (text === auditText) console.error(`AUDIT_CITATION_POLICY ${row.id} ${reason}`);
      return false;
    };
    const cells = auditRowCells(text, row.id);
    if (!cells || cells.length !== 7 || cells[1] !== row.sourceIssue) return reject('row-shape-or-source-issue');
    const authorityCell = cells[4];
    const tuples = [...authorityCell.matchAll(/`([a-z]+):([a-z0-9-]+)` -> `([^`]+):(\d+)`/g)]
      .map((match) => ({ kind: match[1], label: match[2], path: match[3], line: Number(match[4]) }));
    const expectedRefs = authorityInventory.get(row.id);
    if (!expectedRefs || expectedRefs.length === 0) return reject('authority-contract-missing');
    // Preserve the original row's primary source binding as a cross-check on
    // the complete subclaim model rather than silently replacing it.
    const primarySource = row.sourcePath === 'AGENTS.md' ? currentText : read(resolve(root, row.sourcePath));
    const primaryLine = lineOf(primarySource, row.sourcePattern);
    if (!expectedRefs.some((ref) => ref.path === row.sourcePath && ref.line === primaryLine)) {
      return reject(`primary=${row.sourcePath}:${primaryLine}-not-modeled`);
    }
    // Validate every parsed reference independently before set comparison.
    for (const ref of tuples) {
      if (ref.path.startsWith('/') || ref.path.split('/').includes('..')) return reject(`unsafe-path=${ref.path}`);
      const absolute = resolve(root, ref.path);
      if (!existsSync(absolute)) return reject(`actual-path-missing=${ref.path}`);
      const lineCount = read(absolute).split('\n').length;
      if (!Number.isInteger(ref.line) || ref.line < 1 || ref.line > lineCount) return reject(`actual-line-out-of-range=${ref.path}:${ref.line}`);
    }
    const keys = tuples.map((ref) => `${ref.kind}:${ref.label}->${ref.path}:${ref.line}`);
    const expectedKeys = expectedRefs.map((ref) => `${ref.kind}:${ref.label}->${ref.path}:${ref.line}`);
    if (new Set(keys).size !== keys.length) return reject('duplicate-authority-tuple');
    if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
      return reject(`actual=${JSON.stringify(keys)} expected=${JSON.stringify(expectedKeys)}`);
    }
    const residue = authorityCell
      .replace(/`[a-z]+:[a-z0-9-]+` -> `[^`]+:\d+`/g, '')
      .replace(/[\s;]+/g, '');
    if (residue.length > 0) return reject(`vague-residue=${JSON.stringify(residue)}`);
  }
  return true;
}

function refreshDocumentHashes(text) {
  return text
    .replace(/(Baseline SHA-256: `)[a-f0-9]{64}(`)/, `$1${sha256(baselineText)}$2`)
    .replace(/(Final SHA-256: `)[a-f0-9]{64}(`)/, `$1${sha256(currentText)}$2`)
    .replace(/(Final complete-prose digest: `)[a-f0-9]{64}(`)/, `$1${semanticDigest(currentText)}$2`);
}

function replaceRowAuthorityTuple(text, rowId, targetTuple, replacement) {
  const rowLine = text.split('\n').find((line) => line.startsWith(`| ${rowId} |`));
  assert.ok(rowLine, `${rowId} audit row must exist for citation mutation`);
  const cells = auditRowCells(text, rowId);
  assert.ok(cells, `${rowId} audit cells must parse for citation mutation`);
  assert.ok(cells[4].includes(targetTuple), `${rowId} authority cell must contain mutation target ${targetTuple}`);
  const mutatedCells = [...cells];
  mutatedCells[4] = mutatedCells[4].replace(targetTuple, replacement);
  return text.replace(rowLine, `| ${mutatedCells.join(' | ')} |`);
}

function auditCitationMutationChecks() {
  const authorityInventory = resolvedAuthorityInventory();
  assert.ok(auditCitationPolicy(auditText, authorityInventory), 'every audit row must equal its complete exact authoritative path:line set and bind every material subclaim pattern');
  assert.equal(authorityInventory.size, AUDIT_ROWS.length, 'every durable audit row must have an authority inventory');

  let entryCount = 0;
  let removalCount = 0;
  let replacementCount = 0;
  for (const row of AUDIT_ROWS) {
    const targets = authorityInventory.get(row.id);
    const expectedTargets = AUTHORITY_BY_ROW.get(row.id);
    assert.ok(targets && expectedTargets, `${row.id} must have resolved and declared authority entries`);
    assert.equal(targets.length, expectedTargets.length, `${row.id} mutation targets must equal its declared authority entry count`);
    let rowTargetCount = 0;
    for (const target of targets) {
      const targetTuple = `\`${target.kind}:${target.label}\` -> \`${target.path}:${target.line}\``;
      const removed = refreshDocumentHashes(replaceRowAuthorityTuple(auditText, row.id, targetTuple, ''));
      assert.ok(!auditCitationPolicy(removed, authorityInventory), `${row.id} ${target.label} removal must fail after refreshed document hashes`);
      removalCount += 1;

      const irrelevantTuple = `\`${target.kind}:${target.label}\` -> \`package.json:1\``;
      const replaced = refreshDocumentHashes(replaceRowAuthorityTuple(auditText, row.id, targetTuple, irrelevantTuple));
      assert.ok(!auditCitationPolicy(replaced, authorityInventory), `${row.id} ${target.label} irrelevant replacement must fail after refreshed document hashes`);
      replacementCount += 1;
      rowTargetCount += 1;
    }
    assert.equal(rowTargetCount, expectedTargets.length, `${row.id} exhaustive mutation count must equal expected authority entries`);
    entryCount += rowTargetCount;
  }
  assert.equal(entryCount, [...AUTHORITY_BY_ROW.values()].reduce((sum, entries) => sum + entries.length, 0), 'global mutation target count must equal the complete authority inventory');
  assert.equal(removalCount, entryCount, 'every authority entry must have one removal mutation');
  assert.equal(replacementCount, entryCount, 'every authority entry must have one irrelevant replacement mutation');
  assert.equal(removalCount + replacementCount, entryCount * 2, 'authority mutation total must be exactly two per entry');
  const aggregateMarker = `AUDIT_CITATION_EXHAUSTIVE rows=${authorityInventory.size} entries=${entryCount} removal=${removalCount} replacement=${replacementCount} total=${removalCount + replacementCount} PASS documentHashesRefreshed=1`;
  console.log(aggregateMarker);

  const labelTarget = authorityInventory.get('A19')?.find((entry) => entry.label === 'dispatch-registry-request-validation');
  assert.ok(labelTarget, 'independent label mutation sentinel must exist');
  const labelTuple = `\`${labelTarget.kind}:${labelTarget.label}\` -> \`${labelTarget.path}:${labelTarget.line}\``;
  const changedLabelTuple = `\`${labelTarget.kind}:mutated-authority-label\` -> \`${labelTarget.path}:${labelTarget.line}\``;
  const changedLabel = refreshDocumentHashes(replaceRowAuthorityTuple(auditText, 'A19', labelTuple, changedLabelTuple));
  assert.ok(!auditCitationPolicy(changedLabel, authorityInventory), 'changing an authority label while preserving its kind and ref must fail after refreshed document hashes');
  console.log('AUDIT_CITATION_LABEL_MUTATION A19 changed-label REJECTED refPreserved=1 documentHashesRefreshed=1');

  const a20Cells = auditRowCells(auditText, 'A20');
  assert.ok(a20Cells, 'A20 audit row must exist');
  const vagueLine = `| ${a20Cells.join(' | ')} |`.replace(a20Cells[4], '`machine.ts` transition consumers');
  const vague = refreshDocumentHashes(auditText.replace(auditText.split('\n').find((line) => line.startsWith('| A20 |')), vagueLine));
  assert.ok(!auditCitationPolicy(vague, authorityInventory), 'vague row authority must fail even after document hashes are refreshed');
  console.log('AUDIT_CITATION_MUTATION vague REJECTED documentHashesRefreshed=1');
  return { aggregateMarker, entryCount, removalCount, replacementCount };
}

function auditDocumentChecks() {
  const rows = [...auditText.matchAll(/^\| A\d{2} \|/gm)];
  assert.equal(rows.length, 26, 'audit document must contain exactly 26 claim rows');
  for (const row of AUDIT_ROWS) {
    assert.match(auditText, new RegExp(`^\\| ${row.id} \\| ${row.sourceIssue} \\|`, 'm'), `${row.id} must map to ${row.sourceIssue} in the durable audit`);
  }
  assert.ok(auditText.includes(baselineRef), 'audit must bind the exact baseline ref');
  assert.ok(auditText.includes(sha256(baselineText)), 'audit must bind baseline content SHA-256');
  assert.ok(auditText.includes(sha256(currentText)), 'audit must bind final AGENTS content SHA-256');
  const baselineHeadings = inventory(baselineText).headings.length;
  const finalHeadings = inventory(currentText).headings.length;
  assert.ok(auditText.includes(`baseline headings: ${baselineHeadings}`));
  assert.ok(auditText.includes(`final headings: ${finalHeadings}`));
  const baselineFences = Object.values(inventory(baselineText).fenceLanguages).reduce((sum, value) => sum + value, 0);
  const finalFences = Object.values(inventory(currentText).fenceLanguages).reduce((sum, value) => sum + value, 0);
  assert.ok(auditText.includes(`baseline fence markers: ${baselineFences}`));
  assert.ok(auditText.includes(`final fence markers: ${finalFences}`));
  const provenance = [
    'Claude Code 2.1.258', 'claude-opus-5', '3a540dc1-9ecd-45af-bafb-78845401177b',
    '1cd25e48b697df884252a65b08c9eda602e4ce5bd4f6b3ec537899588030b0f7',
    '34/34 sections', '262 material claims', '33 raw FAIL findings', '26 supportable',
    'Agy CLI 1.1.23', 'f48bd033-f9a7-4198-8ad2-638be9d122ff',
    '01a05f2b-162b-7c42-b1c4-9ca08a0d6957', '01a05f3f-49d0-7e31-bec4-a408543fa386',
    'exec-d0c3cff6-f5aa-4d73-ac90-c481f633af1f', 'payload.item.command', AGY_PROVENANCE.cwd,
    AGY_PROVENANCE.command[2], '2,566 bytes', AGY_PROVENANCE.promptSha256,
    'b4e930f908b5723acdfc7c24538c5081baeaf05fc50aac03a986f1018cd7f7ed',
    'ordinal 953', '38,164 bytes', '13 raw findings', '11 supportable',
    'repository-local implementation remains the behavior authority',
  ];
  for (const token of provenance) assert.ok(auditText.includes(token), `external-review provenance token missing: ${token}`);
  assert.ok(auditSemanticChainPolicy(auditText), 'audit document semantic-chain block must exactly bind every chain endpoint and role');
  const provenanceMarker = 'EXTERNAL_REVIEW_PROVENANCE claude=BOUND agy=BOUND authority=LOCAL_IMPLEMENTATION';
  const documentMarker = `AUDIT_DOCUMENT rows=26 baselineSha=${sha256(baselineText)} finalSha=${sha256(currentText)}`;
  console.log(provenanceMarker);
  console.log(documentMarker);
  return { provenanceMarker, documentMarker };
}

function rowSemanticMutationChecks() {
  const mutations = [
    ['M14', 'scope-question-omission', currentText.replace('registered `scope_question_resolve` command', 'a resolution command')],
    ['M14', 'scope-contract-advisory-inversion', currentText.replace('missing contract is an advisory, not a blocker, on the', 'missing contract is a blocker, not an advisory, on the')],
    ['M19', 'reviewer-list-omission', currentText.replace('`reviewer_list --json` reports', '`reviewer_roster --json` reports')],
    ['M19', 'policy-roster-omission', currentText.replace('computed in real time from shared workflow policy plus Story risk signals', 'read from a fixed hard-coded list')],
    ['M19', 'quorum-prerequisite-omission', currentText.replace('`quorum_submit` only after every required current reviewer pass exists', '`quorum_submit` whenever desired')],
  ];
  for (const [sourceIssue, name, mutated] of mutations) {
    const row = AUDIT_ROWS.find((candidate) => candidate.sourceIssue === sourceIssue);
    assert.ok(row, `${sourceIssue} row must exist`);
    assert.ok(row.greenChecks.some((check) => !check.test(mutated)), `${sourceIssue} ${name} mutation must fail an independent GREEN predicate`);
    console.log(`ROW_SEMANTIC_MUTATION ${sourceIssue} ${name} REJECTED`);
  }
}

function extractAgyPromptPath(invocation) {
  const invocationMatch = invocation.match(/^agy --print "\$\(cat ([^)]+)\)" --mode plan --sandbox --dangerously-skip-permissions --output-format json --print-timeout 10m$/);
  assert.ok(invocationMatch, 'Agy prompt invocation must remain the exact bounded cat substitution');
  return invocationMatch[1];
}

function validateAgyProvenanceRecord(record, promptText) {
  assert.equal(record?.ordinal, AGY_PROVENANCE.ordinal, 'Agy selected ordinal drifted');
  assert.equal(record?.type, 'event_msg', 'Agy selected record type drifted');
  const payload = record?.payload;
  const item = payload?.item;
  assert.equal(payload?.thread_id, AGY_PROVENANCE.threadId, 'Agy Codex thread identity drifted');
  assert.equal(payload?.turn_id, AGY_PROVENANCE.turnId, 'Agy Codex turn identity drifted');
  assert.equal(item?.id, AGY_PROVENANCE.itemId, 'Agy command item identity drifted');
  assert.equal(item?.type, 'CommandExecution', 'Agy selected item type drifted');
  assert.equal(item?.status, 'completed', 'Agy command item must be completed');
  assert.equal(item?.exit_code, 0, 'Agy command item exit code drifted');
  assert.equal(item?.stderr, '', 'Agy command item stderr must be empty');
  assert.deepEqual(item?.command, AGY_PROVENANCE.command, 'Agy payload.item.command drifted');
  assert.equal(item?.cwd, AGY_PROVENANCE.cwd, 'Agy command cwd drifted');

  const invocation = item.command[2];
  assert.equal(extractAgyPromptPath(invocation), AGY_PROVENANCE.promptPath, 'Agy invocation prompt path drifted');
  assert.equal(Buffer.byteLength(promptText), AGY_PROVENANCE.promptBytes, 'Agy prompt byte length drifted');
  assert.equal(sha256(promptText), AGY_PROVENANCE.promptSha256, 'Agy prompt hash drifted');
  for (const promptToken of [
    'independent Antigravity Agy CLI auditor',
    'Work read-only in the current repository worktree',
    'Audit the root AGENTS.md exhaustively, claim by claim',
    'repository-local Proof-or-Stop 0.3.270 implementation',
  ]) assert.ok(promptText.includes(promptToken), `Agy prompt scope token missing: ${promptToken}`);

  const stdout = item.stdout;
  assert.equal(typeof stdout, 'string', 'Agy ordinal 953 must contain captured stdout');
  assert.equal(Buffer.byteLength(stdout), AGY_PROVENANCE.stdoutBytes, 'Agy captured stdout byte length drifted');
  assert.equal(sha256(stdout), AGY_PROVENANCE.stdoutSha256, 'Agy captured stdout hash drifted');
  const result = JSON.parse(stdout);
  assert.equal(result.conversation_id, AGY_PROVENANCE.conversationId, 'Agy response conversation identity drifted');
  assert.equal(result.status, AGY_PROVENANCE.status, 'Agy response status drifted');
  assert.equal(result.duration_seconds, AGY_PROVENANCE.durationSeconds, 'Agy response duration drifted');
  assert.ok(result.response.includes('/Users/jek/.local/bin/agy') && result.response.includes('1.1.23'), 'Agy response must retain the observed executable path and version');
  const rawFindingIds = new Set([...result.response.matchAll(/AUD-(\d{3})/g)].map((match) => match[1]));
  assert.deepEqual([...rawFindingIds].sort(), Array.from({ length: 13 }, (_, index) => String(index + 1).padStart(3, '0')), 'Agy response must retain exactly the 13 reported raw finding IDs');
  return { item, result };
}

function agyProvenanceMutationChecks(record, promptText) {
  const mutatedCommand = structuredClone(record);
  mutatedCommand.payload.item.command[0] = '/bin/bash';
  assert.throws(() => validateAgyProvenanceRecord(mutatedCommand, promptText), /payload\.item\.command drifted/, 'invented Agy command must be rejected');

  const mutatedCwd = structuredClone(record);
  mutatedCwd.payload.item.cwd = 'file:///tmp/invented-worktree';
  assert.throws(() => validateAgyProvenanceRecord(mutatedCwd, promptText), /command cwd drifted/, 'invented Agy cwd must be rejected');

  const mutatedInvocation = record.payload.item.command[2].replace('$(cat ', '$(sed -n 1,999p ');
  assert.throws(() => extractAgyPromptPath(mutatedInvocation), /exact bounded cat substitution/, 'invented Agy prompt invocation must be rejected');

  const mutatedPrompt = promptText.replace('independent', 'IndependenT');
  assert.equal(Buffer.byteLength(mutatedPrompt), Buffer.byteLength(promptText), 'Agy prompt-hash mutation must preserve bytes');
  assert.throws(() => validateAgyProvenanceRecord(record, mutatedPrompt), /prompt hash drifted/, 'invented Agy prompt hash must be rejected');
  const marker = 'AGY_PROVENANCE_MUTATION command=REJECTED cwd=REJECTED invocation=REJECTED promptHash=REJECTED';
  console.log(marker);
  return marker;
}

function externalReviewArtifactChecks() {
  const markers = [];
  if (existsSync(claudeTranscript)) {
    const transcript = read(claudeTranscript);
    assert.equal(sha256(transcript), '1cd25e48b697df884252a65b08c9eda602e4ce5bd4f6b3ec537899588030b0f7', 'Claude transcript hash drifted');
    assert.ok(transcript.includes('3a540dc1-9ecd-45af-bafb-78845401177b') && transcript.includes('"version":"2.1.258"') && transcript.includes('"model":"claude-opus-5"'), 'Claude transcript identity must match the durable provenance');
    markers.push('EXTERNAL_ARTIFACT claude availability=LOCAL hash=VERIFIED session=VERIFIED');
  } else {
    markers.push('EXTERNAL_ARTIFACT claude availability=MACHINE_LOCAL_UNAVAILABLE durableHash=RECORDED');
  }
  console.log(markers.at(-1));
  if (existsSync(agyTranscript)) {
    const records = read(agyTranscript).split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.ordinal === AGY_PROVENANCE.ordinal);
    assert.equal(records.length, 1, 'Agy transcript must contain exactly one selected ordinal 953 record');
    assert.ok(existsSync(AGY_PROVENANCE.promptPath), 'Agy selected invocation prompt file is unavailable on its provenance host');
    const promptText = read(AGY_PROVENANCE.promptPath);
    validateAgyProvenanceRecord(records[0], promptText);
    markers.push(agyProvenanceMutationChecks(records[0], promptText));
    markers.push(`EXTERNAL_ARTIFACT agy availability=LOCAL ordinal=${AGY_PROVENANCE.ordinal} bytes=${AGY_PROVENANCE.stdoutBytes} hash=VERIFIED command=VERIFIED cwd=VERIFIED prompt=VERIFIED session=VERIFIED`);
  } else {
    markers.push('EXTERNAL_ARTIFACT agy availability=MACHINE_LOCAL_UNAVAILABLE durableHash=RECORDED');
  }
  console.log(markers.at(-1));
  return markers;
}

const RECEIPT_WINDOW_STATIC_SELECTORS = Object.freeze([
  'COMMAND_LEDGER cases=46/46 PASS',
  'CASE 42 PASS',
  'MUTATION malformed-argument REJECTED',
  'UNICODE path=AGENTS.md han=0 ufffd=0 nonAscii=0',
  'STRUCTURE baselineDigest=',
  'SEMANTIC_MUTATION dev-only-to-every-phase REJECTED',
  'RUNTIME classification=VERSION_AND_REALPATH_DRIFT',
  'RUNTIME_ENV_MUTATION pretendingExecutable=REJECTED hiddenDirectOutcome=REJECTED globalAsAuthority=REJECTED suppressedDrift=REJECTED directAndFallbackDoubleSuccess=REJECTED invalidFallbackState=REJECTED',
  'EXTERNAL_REVIEW_PROVENANCE claude=BOUND agy=BOUND authority=LOCAL_IMPLEMENTATION',
  'AUDIT_CITATION_EXHAUSTIVE rows=26 entries=117 removal=117 replacement=117 total=234 PASS',
  'SOURCE_AUTHORITY_MUTATION rows=14 chains=43 executableEndpoints=69 removalOrInversion=69 PASS',
  'SEMANTIC_CHAIN_SWAP_MUTATION rows=14 swaps=',
  'EXTERNAL_ARTIFACT claude availability=',
  'AGY_PROVENANCE_MUTATION command=REJECTED cwd=REJECTED invocation=REJECTED promptHash=REJECTED',
  'EXTERNAL_ARTIFACT agy availability=',
]);

function receiptWindowSelectors() {
  const liveRuntime = inspectRuntimeEnvironment();
  validateRuntimeEvidence(liveRuntime);
  const liveMarkers = renderRuntimeEvidence(liveRuntime);
  return [
    ...RECEIPT_WINDOW_STATIC_SELECTORS,
    liveMarkers.globalMarker,
    `directOutcome=${liveRuntime.global.directOutcome}`,
    liveMarkers.currentMarker,
  ];
}

function receiptWindowPolicyChecks() {
  const verifierPath = fileURLToPath(import.meta.url);
  const run = spawnSync(process.execPath, [verifierPath, '--final'], { cwd: root, encoding: null, timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(run.status, 0, `receipt-window final verifier failed: ${Buffer.concat([run.stdout ?? Buffer.alloc(0), run.stderr ?? Buffer.alloc(0)]).subarray(-2000).toString('utf8')}`);
  const raw = run.stdout ?? Buffer.alloc(0);
  const captured = raw.subarray(0, Math.min(raw.length, 12000));
  const receiptTail = captured.subarray(Math.max(0, captured.length - 4000));
  const selectors = receiptWindowSelectors();
  const offsets = [];
  for (const selector of selectors) {
    const offset = receiptTail.indexOf(Buffer.from(selector));
    assert.ok(offset >= 0, `validation receipt tail is missing acceptance-critical selector: ${selector}`);
    offsets.push(`${selector.split(' ')[0]}@${offset}`);
  }
  const marker = `RECEIPT_WINDOW raw=${raw.length} captured=${captured.length} tail=${receiptTail.length} selectors=${selectors.length}/${selectors.length} offsets=${offsets.join(',')} PASS`;
  console.log(marker);
  return { marker, rawBytes: raw.length, capturedBytes: captured.length, tailBytes: receiptTail.length, offsets };
}

if (process.argv.includes('--external-review-policy')) {
  externalReviewArtifactChecks();
  console.log('EXTERNAL_REVIEW_POLICY PASS');
  process.exit(0);
}

if (process.argv.includes('--receipt-window-policy')) {
  receiptWindowPolicyChecks();
  process.exit(0);
}

if (process.argv.includes('--semantic-chain-inventory')) {
  console.log(SEMANTIC_CHAIN_BLOCK_START);
  console.log(renderSemanticChainBlock());
  console.log(SEMANTIC_CHAIN_BLOCK_END);
  process.exit(0);
}

if (process.argv.includes('--semantic-chain-policy')) {
  const mutationSummary = semanticChainSwapMutationChecks();
  const chainCount = [...REQUIRED_AUTHORITY_CHAINS.values()].reduce((sum, chains) => sum + chains.length, 0);
  console.log(`SEMANTIC_CHAIN_POLICY PASS rows=${REQUIRED_AUTHORITY_CHAINS.size} chains=${chainCount} swaps=${mutationSummary.swapCount}`);
  process.exit(0);
}

if (process.argv.includes('--authority-inventory')) {
  const inventory = resolvedAuthorityInventory();
  let total = 0;
  let runtime = 0;
  for (const row of AUDIT_ROWS) {
    const entries = inventory.get(row.id);
    total += entries.length;
    runtime += entries.filter((entry) => entry.kind === 'runtime').length;
    console.log(`AUTHORITY ${row.id} ${renderAuthorityCell(entries)}`);
  }
  console.log(`AUTHORITY_INVENTORY rows=${inventory.size} entries=${total} runtime=${runtime}`);
  process.exit(0);
}

if (process.argv.includes('--authority-policy')) {
  assert.ok(auditCitationPolicy(auditText), 'audit authority cells must match the complete ordered claim partition');
  const inventory = resolvedAuthorityInventory();
  const total = [...inventory.values()].reduce((sum, entries) => sum + entries.length, 0);
  const runtime = [...inventory.values()].flat().filter((entry) => entry.kind === 'runtime').length;
  console.log(`AUTHORITY_POLICY PASS rows=${inventory.size} entries=${total} runtime=${runtime}`);
  process.exit(0);
}

if (process.argv.includes('--source-authority-policy')) {
  const inventory = resolvedAuthorityInventory();
  const mutationSummary = sourceAuthorityMutationChecks();
  const roleCount = [...inventory.values()].flat().filter((entry) => entry.role !== 'support').length;
  console.log(`SOURCE_AUTHORITY_POLICY PASS rows=${inventory.size} semanticChainRows=${mutationSummary.rows} chains=${mutationSummary.chainCount} semanticRoleEntries=${roleCount} sourceMutations=${mutationSummary.endpointCount} roleMutations=${mutationSummary.roleMutationCount}`);
  process.exit(0);
}

if (process.argv.includes('--runtime-policy')) {
  const runtime = runtimeChecks();
  assert.ok(runtime.historicalMarker.includes('context=initial-audit'), 'historical runtime marker must retain its immutable receipt context');
  console.log(`RUNTIME_POLICY PASS live=COMPUTED classification=${runtime.evidence.classification} globalDirect=${runtime.evidence.global.directOutcome} versionSource=${runtime.evidence.global.versionSource} historicalReceipt=GIT_OBJECT_VERIFIED`);
  process.exit(0);
}

let exitCode = runAuditRows();
if (mode === 'final' && !selectedRow && exitCode === 0) {
  // Every replayed proof line below is returned by a completed check. The
  // command ledger remains fully executable but is quiet here so the complete
  // post-check replay fits the validation executor's bounded receipt window.
  const runtime = runtimeChecks();
  const unicodeMarkers = unicodeChecks();
  const semanticMarkers = semanticChecks();
  const commandMarkers = runCommandLedger({ verbose: false });
  const structure = structuralChecks();
  for (const marker of structure.categoryMarkers) console.log(marker);
  const auditDocument = auditDocumentChecks();
  const citationSummary = auditCitationMutationChecks();
  const sourceSummary = sourceAuthorityMutationChecks();
  const chainSummary = semanticChainSwapMutationChecks();
  const externalMarkers = externalReviewArtifactChecks();
  rowSemanticMutationChecks();
  completenessChecks();
  managedBlockChecks();

  // The validation executor keeps stdout bytes 0..12000 and receipts keep the
  // last 4000 bytes of that prefix. Compactly replay only earned return values
  // after every substantive check has completed.
  const unicodeReplay = unicodeMarkers.find((marker) => marker.startsWith('UNICODE path=AGENTS.md '));
  const semanticReplay = semanticMarkers.find((marker) => marker === 'SEMANTIC_MUTATION dev-only-to-every-phase REJECTED');
  assert.ok(unicodeReplay, 'validated AGENTS Unicode marker must be available for receipt replay');
  assert.ok(semanticReplay, 'validated semantic mutation marker must be available for receipt replay');
  for (const marker of [
    commandMarkers.aggregateSelector,
    commandMarkers.case42Selector,
    commandMarkers.malformedSelector,
    unicodeReplay,
    structure.marker,
    semanticReplay,
    runtime.historicalMarker,
    runtime.globalMarker,
    runtime.currentMarker,
    runtime.mutationMarker,
    auditDocument.provenanceMarker,
    citationSummary.aggregateMarker,
    sourceSummary.aggregateMarker,
    chainSummary.marker,
    ...externalMarkers,
  ]) console.log(marker);
  console.log('AGENTS_VERIFY FINAL GREEN');
}
process.exit(exitCode);
