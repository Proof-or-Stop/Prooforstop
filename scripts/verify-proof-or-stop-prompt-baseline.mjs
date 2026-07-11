#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILT_REGISTRY_PATH = join(ROOT, 'packages/main/dist/core/prompt-registry.js');
const CLI_PATH = join(ROOT, 'packages/main/dist/cli.js');
const BASELINE_PATH = join(
  ROOT,
  'docs/requirements/baselines/proof-or-stop-prompt-baseline.json',
);
const MATRIX_PATH = join(
  ROOT,
  'docs/requirements/baselines/proof-or-stop-prompt-overlap-matrix.md',
);
const EXPECTED_ROLE_COUNT = 16;
const SCHEMA_VERSION = 'proof-or-stop.prompt-baseline.v3';
const PLAN_PATH = 'docs/requirements/decisions/proof-or-stop-agent-prompt-consolidation-execution-plan.md';
const WRITE_MODE = process.argv.includes('--write');
const PROBE_DIRECT_STORY_CLASSIFIER = process.argv.includes('--probe-direct-story-classifier');
const PROBE_ROLE_MATRIX_SNAPSHOT_DRIFT = process.argv.includes('--probe-role-matrix-snapshot-drift');
const ROLE_MATRIX_FIELDS = [
  'status',
  'phase',
  'purpose',
  'commands',
  'directFileAccess',
  'inputs',
  'outputs',
  'capabilities',
  'overlapCategory',
  'notes',
];
const REVIEWER_AUDITED_ROLE_MATRIX_FIELDS = ['commands', 'directFileAccess', 'outputs'];
const ROLE_MATRIX_MACHINE_CHECKS = [
  'Lock the exact 16 role snapshots and role IDs.',
  'Lock registry template hashes and agent_prompt output hashes.',
  'Require every role-matrix field to be a non-empty string.',
  'Require JSON/Markdown parity and reject snapshot drift.',
];
const ROLE_MATRIX_SEMANTIC_BOUNDARY =
  'Commands, outputs, and direct-file-access semantics are reviewer-audited snapshots. The verifier does not infer or prove command ownership or behavioral semantics from prompt prose.';
const ROLE_MATRIX_SOURCE_ANCHOR_PURPOSE =
  'Navigation and drift anchors for manual review only; relPath and templateHash do not prove role semantics.';
const STORY_INIT_SELF_CHECK_WRITE = `echo '{"question":"Did you read CLAUDE.md? If not, explain the reason in detail in the answer field. If yes, also state that you read it in the answer field.","answer":""}' > docs/story/actives/<storyId>/init-self-check.json`;
const DIRECT_STORY_WRITE_ALLOWLIST = [
  {
    role: 'lattice-review-story-init',
    excerpt: STORY_INIT_SELF_CHECK_WRITE,
    reason: 'Current INIT anti-self-exemption sidecar pending CLI migration.',
  },
];

const LEGACY_PATTERNS = [
  {
    term: 'TEST_CASE_REVIEW',
    regex: /\b(?:TEST[\s_-]*CASE[\s_-]*REVIEW|test[\s_-]*case[\s_-]*review(?:er)?)\b/i,
  },
  {
    term: 'TEST_CASE',
    regex: /\bTEST[\s_-]*CASE\b/i,
  },
  {
    term: 'testIntent',
    regex: /\btest[\s_-]*intent\b|\btestIntent\b/i,
  },
];

const ROLE_MATRIX_DEFAULTS = {
  'implementation-reviewer': {
    status: 'fold-candidate',
    phase: 'REVIEW advisory',
    purpose: 'Legacy implementation risk reviewer for code risks and maintainability.',
    commands: 'none',
    directFileAccess: 'Reads diff and implementation context; no direct story writes.',
    inputs: 'Diff and implementation context.',
    outputs: 'Text review notes.',
    capabilities: 'Code risk review; edge condition review; maintainability review.',
    overlapCategory: 'duplicates behavior and quality',
    notes: 'Not in current review-run lanes; planned to fold into behavior and quality.',
  },
  'lattice-evaluator-cli': {
    status: 'optional',
    phase: 'TEST optional',
    purpose: 'CLI/core evaluator for user-facing command behavior.',
    commands: 'bridge state/reset/events/event/replay API via curl; optional CLI shell spawn.',
    directFileAccess: 'Uses CLI shell/bridge output; no direct story writes.',
    inputs: 'Task, expected CLI behavior, command output.',
    outputs: 'Evaluator JSON transcript.',
    capabilities: 'CLI exercise; usability scoring; observed-output assessment.',
    overlapCategory: 'overlaps behavior and delivery',
    notes: 'Advisory unless persisted through a structured evaluator evidence path.',
  },
  'lattice-evaluator': {
    status: 'optional',
    phase: 'TEST optional',
    purpose: 'Browser/product evaluator for UI-facing behavior.',
    commands: 'browser status/eval/click/type/console/refresh API via curl.',
    directFileAccess: 'Evaluates through browser API only; does not read source code or write story metadata.',
    inputs: 'Task, expected user flow, browser state.',
    outputs: 'Evaluator JSON scores, itemResults, pass flag, and findings text.',
    capabilities: 'User-flow exercise; UI behavior scoring; usability notes.',
    overlapCategory: 'overlaps behavior and product',
    notes: 'Advisory unless a policy consumes saved evaluator evidence.',
  },
  'lattice-implementer': {
    status: 'active',
    phase: 'DEV',
    purpose: 'Implementation worker that edits code, verifies locally, and updates checklist evidence.',
    commands: 'checklist_update; validate; status; checklist_get; story_get; aux_doc_list; aux_scan; aux_detail.',
    directFileAccess: 'Reads and edits source/docs in workspace; story metadata through Lattice CLI only.',
    inputs: 'Story, checklist, source files, focused docs.',
    outputs: 'Code changes, commits, checklist status updates, and brief return summary.',
    capabilities: 'Code editing; focused tests; checklist status recording; commit preparation.',
    overlapCategory: 'DEV owner',
    notes: 'Does not own review, test phase advancement, or DONE closure.',
  },
  'lattice-review-behavior': {
    status: 'active',
    phase: 'REVIEW',
    purpose: 'Reviews promised user-visible behavior, edge cases, and userSees mismatch.',
    commands: 'git diff; checklist_get; review_run_start; finding_add; review_pass_set.',
    directFileAccess: 'Reads git diff, checklist userSees, source files, candidate docs, and scope-plan artifacts; no direct story writes.',
    inputs: 'Diff, story scope, user-visible behavior, verification evidence.',
    outputs: 'Reviewer findings or pass.',
    capabilities: 'Behavior correctness; edge-case review; user-visible mismatch detection.',
    overlapCategory: 'shares spec checks with scope and docs',
    notes: 'Should consume scope artifacts instead of repeating broad PLAN scans.',
  },
  'lattice-review-channel': {
    status: 'retired-cli-only',
    phase: 'REVIEW legacy',
    purpose: 'Legacy reviewer for normal-channel dispatch evidence.',
    commands: 'checklist_get; story_get; grep process-events; review_run_start; finding_add; review_pass_set.',
    directFileAccess: 'Legacy direct read of docs/story process-events evidence.',
    inputs: 'process-events dispatch and subagent_result evidence.',
    outputs: 'Reviewer findings or pass.',
    capabilities: 'Dispatch evidence inspection.',
    overlapCategory: 'duplicates channel CLI gate',
    notes: 'Plan marks this as retired in favor of validate channel checks.',
  },
  'lattice-review-concept': {
    status: 'conditional',
    phase: 'REVIEW',
    purpose: 'Reviews concept deletion, rename, and terminology residue.',
    commands: 'git diff; grep; review_run_start; finding_add; review_pass_set.',
    directFileAccess: 'Reads diff/source/docs references; reviewer evidence through Lattice CLI.',
    inputs: 'Diff, renamed terms, deleted concepts, docs/code references.',
    outputs: 'Reviewer findings or pass.',
    capabilities: 'Residue scan; concept consistency; rename completeness.',
    overlapCategory: 'overlaps docs and quality cleanup',
    notes: 'Route only when rename, removal, or concept-retirement triggers exist.',
  },
  'lattice-review-delivery': {
    status: 'active',
    phase: 'TEST/DONE',
    purpose: 'Reviews final delivery claims, docs promises, real machine tests, and closeout.',
    commands: 'git diff; delivery_check_set.',
    directFileAccess: 'Reads git diff and repository files; explicitly avoids process-events, reviewer outputs, and test-evidence contents.',
    inputs: 'Diff, validation evidence, docs promises, user-facing closeout claims.',
    outputs: 'Signed delivery-check.json via delivery_check_set, or refusal text.',
    capabilities: 'Delivery completeness; closeout self-check; final docs-promise fallback.',
    overlapCategory: 'overlaps docs and product',
    notes: 'Consumes docs review when available instead of redoing all doc-code drift review.',
  },
  'lattice-review-docs': {
    status: 'active',
    phase: 'REVIEW',
    purpose: 'Reviews code/documentation drift around changed public behavior.',
    commands: 'git diff; grep; review_run_start; finding_add; review_pass_set.',
    directFileAccess: 'Reads changed docs/source; reviewer evidence through Lattice CLI.',
    inputs: 'Diff, docs, command examples, config/schema changes.',
    outputs: 'Reviewer findings or pass.',
    capabilities: 'Doc-code drift review; command example review; schema documentation review.',
    overlapCategory: 'single REVIEW docs owner',
    notes: 'Owns REVIEW doc drift and docs-promised-code-missing checks.',
  },
  'lattice-review-quality': {
    status: 'active',
    phase: 'REVIEW',
    purpose: 'Reviews maintainability, type safety, I/O shell isolation, and proof metadata consistency.',
    commands: 'git diff; review_run_start; finding_add; review_pass_set.',
    directFileAccess: 'Reads source/tests/proof metadata; reviewer evidence through Lattice CLI.',
    inputs: 'Diff, source code, tests, proof metadata.',
    outputs: 'Reviewer findings or pass.',
    capabilities: 'Code quality; dead-code scan; type-safety review; maintainability review.',
    overlapCategory: 'overlaps implementation-reviewer',
    notes: 'Target owner for implementation-reviewer maintainability checks.',
  },
  'lattice-review-scope-plan': {
    status: 'active',
    phase: 'PLAN',
    purpose: 'Reviews story/checklist scope against source-of-truth requirements.',
    commands: 'config; dev_memory_preflight; dev_memory_search; aux_doc_list; story_get; checklist_get; scope_check_save.',
    directFileAccess: 'Reads candidate docs and CLI-provided story/checklist context; scope evidence through Lattice CLI.',
    inputs: 'Story, checklist, candidate requirement docs, risk signals.',
    outputs: 'scope_check_save artifact.',
    capabilities: 'Scope coverage; orphan requirement detection; candidate spec review.',
    overlapCategory: 'PLAN scope owner',
    notes: 'Should avoid default full decisions-directory scans without escalation.',
  },
  'lattice-review-story-init': {
    status: 'active',
    phase: 'INIT',
    purpose: 'Reviews new story readability, facts, risk wording, and initial checklist sanity.',
    commands: 'init_check_set.',
    directFileAccess: 'Grandfathered direct docs/story reads and init-self-check file write wording.',
    inputs: 'Story background, index fields, checklist title/context.',
    outputs: 'init_check_set issues/pass plus init-self-check audit file wording.',
    capabilities: 'Fresh-context intake review; story clarity; risk sanity check.',
    overlapCategory: 'overlaps scope-plan on checklist sanity',
    notes: 'Baseline includes grandfathered direct story-file reads and init-self-check write wording.',
  },
  'lattice-review-test-coverage': {
    status: 'active',
    phase: 'REVIEW',
    purpose: 'Reviews verificationIntent to verificationEvidence coverage.',
    commands: 'story_get; checklist_get; validate; review_run_start; finding_add; review_pass_set.',
    directFileAccess: 'Reads checklist/evidence through Lattice CLI; reviewer evidence through Lattice CLI.',
    inputs: 'Checklist verificationIntent and verificationEvidence.',
    outputs: 'Reviewer findings or pass.',
    capabilities: 'Coverage completeness; missing/stale evidence detection.',
    overlapCategory: 'verification coverage owner',
    notes: 'Current replacement for the value of legacy TEST_CASE_REVIEW.',
  },
  'product-reviewer': {
    status: 'compatibility',
    phase: 'INIT/DONE advisory',
    purpose: 'Reviews user-facing transcript and product closure.',
    commands: 'init_check_set when asked to perform INIT compatibility review; otherwise none.',
    directFileAccess: 'Reads transcript/product context and optional transcript diff; no code, test, or story metadata writes.',
    inputs: 'Final transcript, product outcome, optional transcript diff.',
    outputs: 'Text product review or product-reviewer init_check_set record.',
    capabilities: 'User-value closure; product wording review.',
    overlapCategory: 'overlaps delivery and evaluator',
    notes: 'INIT compatibility remains until product reviewer routing is migrated.',
  },
  'test-case-reviewer': {
    status: 'legacy',
    phase: 'TEST_CASE_REVIEW legacy',
    purpose: 'Legacy reviewer for fixture coverage of testIntent.',
    commands: 'checklist_get; testintent_check; testintent_record.',
    directFileAccess: 'Legacy direct fixture JSON reads; writes only through testintent_record.',
    inputs: 'Legacy testIntent and fixture JSON.',
    outputs: 'testintent_record results and testintent_check status.',
    capabilities: 'Legacy fixture coverage review.',
    overlapCategory: 'replaced by review-test-coverage',
    notes: 'Legacy-only prompt tied to old TEST_CASE_REVIEW phase.',
  },
  'test-intent': {
    status: 'legacy',
    phase: 'PLAN legacy',
    purpose: 'Legacy checklist split reviewer and testIntent writer.',
    commands: 'story_get; checklist_update.',
    directFileAccess: 'Reads story/checklist through Lattice CLI; writes legacy checklist updates through Lattice CLI.',
    inputs: 'Story and checklist.',
    outputs: 'Legacy testIntent or null intent updates.',
    capabilities: 'Checklist split review; legacy acceptance-intent writing.',
    overlapCategory: 'replaced by verificationIntent flow',
    notes: 'Conflicts with the current verificationIntent model for new stories.',
  },
};

const DIRECT_STORY_CLASSIFIER_PROBES = [
  {
    name: 'negative direct read/write policy reminder',
    role: 'lattice-review-quality',
    excerpt: '- Story operations must use Lattice CLI commands. Do not directly read or write story metadata under `docs/story/`.',
    classification: 'policy-reminder',
    grandfathered: false,
  },
  {
    name: 'negative direct read/edit prohibited reminder',
    role: 'lattice-implementer',
    excerpt: '- Directly Read/Edit JSON files under `docs/story/`: all story changes go through the Lattice CLI',
    classification: 'policy-reminder',
    grandfathered: false,
  },
  {
    name: 'negative copy policy reminder',
    role: 'lattice-review-quality',
    excerpt: 'Do not copy or move files into docs/story; use Lattice CLI commands instead.',
    classification: 'policy-reminder',
    grandfathered: false,
  },
  {
    name: 'mixed negative reminder and positive write instruction',
    role: 'lattice-review-docs',
    excerpt: 'Do not directly edit docs/story metadata; however, use Edit to update docs/story/actives/B-1234/index.json.',
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'apply_patch command targeting story metadata',
    role: 'lattice-review-docs',
    excerpt: "apply_patch <<'PATCH' # target docs/story/actives/B-1234/index.json",
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'apply_patch add file header',
    role: 'lattice-review-docs',
    excerpt: '*** Add File: docs/story/actives/B-1234/new.json',
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'apply_patch update file header',
    role: 'lattice-review-docs',
    excerpt: '*** Update File: docs/story/actives/B-1234/index.json',
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'apply_patch delete file header',
    role: 'lattice-review-docs',
    excerpt: '*** Delete File: docs/story/actives/B-1234/obsolete.json',
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'actionable directly read/edit instruction',
    role: 'lattice-review-docs',
    excerpt: 'Directly Read/Edit docs/story/actives/B-1234/index.json to update the answer field.',
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'edit tool instruction',
    role: 'lattice-review-docs',
    excerpt: 'Use the Edit tool to update docs/story/actives/B-1234/index.json.',
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'write tool instruction',
    role: 'lattice-review-docs',
    excerpt: 'Use Write to create docs/story/actives/B-1234/init-self-check.json.',
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'tee write instruction',
    role: 'lattice-review-docs',
    excerpt: 'printf "{}" | tee docs/story/actives/B-1234/index.json',
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'sed in-place write instruction',
    role: 'lattice-review-docs',
    excerpt: "sed -i '' 's/a/b/' docs/story/actives/B-1234/index.json",
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'conditional echo redirection write',
    role: 'lattice-review-docs',
    excerpt: 'If available, echo "{}" > docs/story/actives/B-1234/index.json',
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'cp command targeting story metadata',
    role: 'lattice-review-docs',
    excerpt: 'cp source.json docs/story/actives/B-1234/index.json',
    classification: 'direct-write',
    grandfathered: false,
    baselineRefresh: 'reject',
    expectedRejection: 'direct write is not explicitly grandfathered',
  },
  {
    name: 'copy instruction targeting story metadata',
    role: 'lattice-review-docs',
    excerpt: 'Copy source.json to docs/story/actives/B-1234/index.json.',
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'mv command targeting story metadata',
    role: 'lattice-review-docs',
    excerpt: 'mv source.json docs/story/actives/B-1234/index.json',
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'move instruction targeting story metadata',
    role: 'lattice-review-docs',
    excerpt: 'Move source.json to docs/story/actives/B-1234/index.json.',
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'install command targeting story metadata',
    role: 'lattice-review-docs',
    excerpt: 'install -m 0644 source.json docs/story/actives/B-1234/index.json',
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'rsync command targeting story metadata',
    role: 'lattice-review-docs',
    excerpt: 'rsync -a source.json docs/story/actives/B-1234/index.json',
    classification: 'direct-write',
    grandfathered: false,
  },
  {
    name: 'unknown mutation mechanism fails closed',
    role: 'lattice-review-docs',
    excerpt: 'Mutate docs/story/actives/B-1234/index.json with the project-specific metadata transformer.',
    classification: 'unclassified-actionable',
    grandfathered: false,
    baselineRefresh: 'reject',
    expectedRejection: 'unclassified actionable reference',
  },
  {
    name: 'exact current story-init write is grandfathered',
    role: 'lattice-review-story-init',
    excerpt: STORY_INIT_SELF_CHECK_WRITE,
    classification: 'direct-write',
    grandfathered: true,
    baselineRefresh: 'allow',
  },
  {
    name: 'read-only story reference',
    role: 'lattice-review-story-init',
    excerpt: '`docs/story/actives/<storyId>/index.json` — read only the `title` field.',
    classification: 'read-only-reference',
    grandfathered: true,
  },
];

const DIRECT_STORY_SCANNER_PROBES = [
  {
    name: 'continued cp destination is scanned as one instruction',
    role: 'lattice-review-docs',
    content: 'cp source.json \\\n  docs/story/actives/B-1234/index.json',
    line: 1,
    classification: 'direct-write',
    grandfathered: false,
    baselineRefresh: 'reject',
    expectedRejection: 'direct write is not explicitly grandfathered',
  },
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function toRepoPath(path) {
  return relative(ROOT, path).split('\\').join('/');
}

function countLines(text) {
  if (text.length === 0) return 0;
  return text.split(/\r?\n/).length;
}

function normalizeCliPrint(stdout) {
  return stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
}

function assertBuiltArtifacts() {
  if (!existsSync(BUILT_REGISTRY_PATH) || !existsSync(CLI_PATH)) {
    throw new Error(
      'Built prompt registry not found. Run `npm --prefix packages/main run build` before this verifier.',
    );
  }
}

function runAgentPrompt(role) {
  return execFileSync(process.execPath, [CLI_PATH, 'agent_prompt', `--role=${role}`], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function classifyLegacyFinding(role, term) {
  if (role === 'test-intent' || role === 'test-case-reviewer') {
    return {
      classification: 'legacy-prompt-body',
      note: 'Legacy compatibility prompt; visible until migration or retirement.',
    };
  }
  if (role === 'lattice-review-test-coverage') {
    return {
      classification: 'legacy-value-reference',
      note: 'Current reviewer explicitly references the old TEST_CASE_REVIEW value without reviving the phase.',
    };
  }
  if (role === 'lattice-review-concept') {
    return {
      classification: 'legacy-example',
      note: 'Example of concept deletion terminology, not an active testIntent instruction.',
    };
  }
  if (role === 'implementation-reviewer' || role === 'product-reviewer') {
    return {
      classification: 'legacy-overlap-wording',
      note: 'Legacy wording called out for later prompt consolidation.',
    };
  }
  return {
    classification: term === 'testIntent' ? 'legacy-vocabulary-reference' : 'legacy-phase-reference',
    note: 'Registered legacy vocabulary occurrence.',
  };
}

function isExplicitlyGrandfatheredDirectStoryWrite(role, excerpt) {
  return DIRECT_STORY_WRITE_ALLOWLIST.some(
    entry => entry.role === role && entry.excerpt === excerpt,
  );
}

function classifyStoryFinding(role, excerpt) {
  const lower = excerpt.toLowerCase();
  if (isDirectStoryWriteInstruction(excerpt)) {
    return {
      classification: 'direct-write',
      grandfathered: isExplicitlyGrandfatheredDirectStoryWrite(role, excerpt),
      note: 'Registered direct story-file write instruction to replace with CLI-mediated writes in later milestones.',
    };
  }
  if (isNegativeStoryPolicyReminder(excerpt)) {
    return {
      classification: 'policy-reminder',
      grandfathered: false,
      note: 'Prompt reminds agents not to bypass CLI-mediated story operations.',
    };
  }
  if (hasActionableStoryMutationSignal(excerpt)) {
    return {
      classification: 'unclassified-actionable',
      grandfathered: false,
      note: 'Actionable story-file mutation was not recognized by the direct-write classifier; baseline refresh must stop.',
    };
  }
  if (lower.includes('process-events.jsonl') || lower.includes('dispatch evidence source')) {
    return {
      classification: 'process-event-evidence-reference',
      grandfathered: true,
      note: 'Legacy channel reviewer references process-event evidence directly.',
    };
  }
  if (lower.includes('if available') || lower.includes('read only') || lower.includes('full text')) {
    return {
      classification: 'read-only-reference',
      grandfathered: true,
      note: 'Registered read-only reference to story artifact content.',
    };
  }
  if (
    /\b(read|cat|grep)\b/i.test(excerpt) &&
    /docs\/story\/actives\/<storyid>/i.test(excerpt)
  ) {
    return {
      classification: 'direct-read',
      grandfathered: role === 'lattice-review-story-init',
      note: 'Registered direct story-file read instruction to replace with CLI reads in later milestones.',
    };
  }
  return {
    classification: 'other',
    grandfathered: true,
    note: 'Registered story path reference without a direct write instruction.',
  };
}

function splitStoryActionClauses(excerpt) {
  return excerpt
    .replace(/\\\s*\r?\n\s*/g, ' ')
    .split(/\r?\n|;|(?<=[.!?])\s+|,\s*(?:but|however|then)\s+|\s+(?:but|however)\s+/i)
    .map(clause => clause.trim())
    .filter(Boolean);
}

function isNegativeStoryPolicyClause(clause) {
  const lower = clause.toLowerCase();
  if (lower.includes('all story changes go through')) return true;
  if (lower.includes('story metadata under') && lower.includes('do not write fixtures')) return true;
  return /\b(?:do not|don't|must not|never|forbidden|prohibited|avoid)\b[\s\S]*\b(?:read|write|edit|modify|mutate|patch|create|update|delete|remove|replace|append|overwrite|copy|move|install|rsync|cp|mv|apply_patch)\b/i.test(clause);
}

function isNegativeStoryPolicyReminder(excerpt) {
  return splitStoryActionClauses(excerpt).some(isNegativeStoryPolicyClause);
}

function hasRecognizedStoryWriteAction(clause) {
  return (
    /^\s*\*{3}\s+(?:add|update|delete)\s+file\s*:/i.test(clause) ||
    /\bapply_patch\b/i.test(clause) ||
    /\bdirectly\s+read\s*\/\s*edit\b/i.test(clause) ||
    /\b(?:use|using|run|invoke|call)\s+(?:the\s+)?(?:edit|write)\b/i.test(clause) ||
    /\b(?:cp|copy|mv|move|install|rsync)\b[\s\S]*docs\/story/i.test(clause) ||
    /\b(?:edit|write|create|update|delete|remove|append|overwrite|replace)\b[\s\S]*docs\/story/i.test(clause) ||
    /docs\/story[\s\S]*\b(?:edit|write|create|update|delete|remove|append|overwrite|replace)\b/i.test(clause) ||
    /\b(?:tee|sed\s+-i|perl\s+-i)\b[\s\S]*docs\/story/i.test(clause) ||
    /\b(?:echo|printf|cat)\b[\s\S]*(?:>|>>)\s*docs\/story/i.test(clause) ||
    /\b(?:echo|printf)\b[\s\S]*\|\s*tee\b[\s\S]*docs\/story/i.test(clause) ||
    /(?:^|\s)(?:>|>>)\s*docs\/story/i.test(clause)
  );
}

function isDirectStoryWriteInstruction(excerpt) {
  if (!/docs\/story/i.test(excerpt)) return false;
  return splitStoryActionClauses(excerpt).some(
    clause => !isNegativeStoryPolicyClause(clause) && hasRecognizedStoryWriteAction(clause),
  );
}

function hasActionableStoryMutationSignal(excerpt) {
  if (!/docs\/story/i.test(excerpt)) return false;
  return splitStoryActionClauses(excerpt).some(
    clause => {
      if (isNegativeStoryPolicyClause(clause)) return false;
      const mutationVerb = /\b(?:add|append|create|delete|edit|modify|mutate|overwrite|patch|remove|replace|save|update|write|copy|move|install|rsync|cp|mv)\b/i;
      const directive = /^\s*(?:[-*]\s*)?(?:(?:please|then)\s+|you\s+(?:must|should|can|may)\s+|(?:must|should)\s+)?(?:add|append|create|delete|edit|modify|mutate|overwrite|patch|remove|replace|save|update|write|copy|move|install|rsync|cp|mv)\b/i;
      return (
        (/docs\/story/i.test(clause) && mutationVerb.test(clause)) ||
        directive.test(clause) ||
        /\b(?:apply_patch|tee|sed\s+-i|perl\s+-i)\b/i.test(clause) ||
        /(?:^|\s)(?:>|>>)(?:\s|$)/.test(clause)
      );
    },
  );
}

function scanLegacyVocabulary(roleEntries) {
  const findings = [];
  for (const entry of roleEntries) {
    const lines = entry.content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const excerpt = lines[index].trim();
      if (!excerpt) continue;
      const terms = [];
      for (const pattern of LEGACY_PATTERNS) {
        if (pattern.regex.test(excerpt)) terms.push(pattern.term);
      }
      for (const term of terms) {
        const classification = classifyLegacyFinding(entry.role, term);
        findings.push({
          id: sha256(`${entry.role}\0${index + 1}\0${term}\0${excerpt}`).slice(0, 16),
          role: entry.role,
          line: index + 1,
          term,
          excerpt,
          ...classification,
        });
      }
    }
  }
  return findings.sort(compareFinding);
}

function buildStoryScanExcerpts(content) {
  const lines = content.split(/\r?\n/);
  const excerpts = [];
  for (let index = 0; index < lines.length; index += 1) {
    const start = index;
    const parts = [lines[index].trim()];
    while (/\\\s*$/.test(lines[index]) && index + 1 < lines.length) {
      index += 1;
      parts.push(lines[index].trim());
    }
    excerpts.push({ line: start + 1, excerpt: parts.join('\n').trim() });
  }
  return excerpts;
}

function scanStoryFileReferences(roleEntries) {
  const findings = [];
  const storyPattern = /docs\/story(?:\/[^\s`'"<>)\]}]*)?/g;
  for (const entry of roleEntries) {
    for (const { line, excerpt } of buildStoryScanExcerpts(entry.content)) {
      if (!excerpt) continue;
      const references = [...excerpt.matchAll(storyPattern)].map(match => match[0]);
      if (references.length === 0) continue;
      const classification = classifyStoryFinding(entry.role, excerpt);
      findings.push({
        id: sha256(`${entry.role}\0${line}\0${references.join(',')}\0${excerpt}`).slice(0, 16),
        role: entry.role,
        line,
        references: [...new Set(references)].sort(),
        excerpt,
        ...classification,
      });
    }
  }
  return findings.sort(compareFinding);
}

function collectDirectStoryFindings(roleEntries) {
  const findings = scanStoryFileReferences(roleEntries);
  assertDirectStoryWritePolicy(findings);
  return findings;
}

function compareFinding(a, b) {
  return (
    a.role.localeCompare(b.role) ||
    a.line - b.line ||
    String(a.term ?? a.references?.[0] ?? '').localeCompare(String(b.term ?? b.references?.[0] ?? '')) ||
    a.excerpt.localeCompare(b.excerpt)
  );
}

function buildFindingKey(finding) {
  const discriminator = finding.term ?? (finding.references ?? []).join(',');
  return `${finding.role}:${finding.line}:${discriminator}:${sha256(finding.excerpt).slice(0, 16)}`;
}

async function loadBuiltRegistry() {
  assertBuiltArtifacts();
  const registryModule = await import(`${pathToFileURL(BUILT_REGISTRY_PATH).href}?v=${Date.now()}`);
  return registryModule;
}

async function collectCurrentBaseline() {
  const { readPromptRegistry, readPromptTemplate } = await loadBuiltRegistry();
  const snapshot = readPromptRegistry();
  const roleEntries = [];
  const agentPromptOutputs = [];

  for (const entry of snapshot.agents) {
    const content = readPromptTemplate(entry);
    const stdout = runAgentPrompt(entry.agentId);
    const stdoutText = stdout.toString('utf8');
    const normalized = normalizeCliPrint(stdoutText);
    if (normalized !== content) {
      throw new Error(`agent_prompt output does not match registry body for ${entry.agentId}`);
    }
    roleEntries.push({
      role: entry.agentId,
      file: entry.file,
      relPath: entry.relPath,
      templateHash: entry.templateHash,
      bytes: entry.bytes,
      lines: countLines(content),
      content,
    });
    agentPromptOutputs.push({
      role: entry.agentId,
      sha256: sha256(stdout),
      bytes: stdout.length,
      lines: countLines(stdoutText),
    });
  }

  const roleMatrix = roleEntries.map(entry => {
    const matrix = ROLE_MATRIX_DEFAULTS[entry.role];
    if (!matrix) throw new Error(`missing matrix defaults for role ${entry.role}`);
    return { role: entry.role, ...matrix };
  });
  const directStoryFindings = collectDirectStoryFindings(roleEntries);

  return {
    schemaVersion: SCHEMA_VERSION,
    storyId: 'B-3928',
    sourcePlan: PLAN_PATH,
    expectedRoleCount: EXPECTED_ROLE_COUNT,
    registry: {
      module: toRepoPath(BUILT_REGISTRY_PATH),
      schemaVersion: snapshot.schemaVersion,
      source: snapshot.source,
      agentCount: snapshot.agentCount,
      materialHash: snapshot.materialHash,
      roles: roleEntries.map(({ content: _content, ...entry }) => entry),
    },
    agentPrompt: {
      command: 'node packages/main/dist/cli.js agent_prompt --role=<role>',
      metadata: 'sha256, bytes, and lines are computed from raw stdout; registry parity strips the CLI print newline only.',
      outputs: agentPromptOutputs,
    },
    roleMatrix,
    roleMatrixAudit: buildRoleMatrixAudit(roleEntries),
    legacyVocabulary: {
      patterns: LEGACY_PATTERNS.map(pattern => pattern.term),
      findings: scanLegacyVocabulary(roleEntries),
    },
    directStoryFileReferences: {
      classifications: [
        'policy-reminder',
        'read-only-reference',
        'process-event-evidence-reference',
        'direct-read',
        'direct-write',
        'unclassified-actionable',
        'other',
      ],
      findings: directStoryFindings,
    },
  };
}

function buildRoleMatrixAudit(roleEntries) {
  return {
    machineChecks: [...ROLE_MATRIX_MACHINE_CHECKS],
    reviewerAuditedFields: [...REVIEWER_AUDITED_ROLE_MATRIX_FIELDS],
    semanticBoundary: ROLE_MATRIX_SEMANTIC_BOUNDARY,
    sourceAuditAnchors: {
      purpose: ROLE_MATRIX_SOURCE_ANCHOR_PURPOSE,
      roles: roleEntries.map(entry => ({
        role: entry.role,
        relPath: entry.relPath,
        templateHash: entry.templateHash,
      })),
    },
  };
}

function renderMatrixMarkdown(baseline) {
  const audit = baseline.roleMatrixAudit;
  const rows = baseline.roleMatrix.map(row => [
    row.role,
    row.status,
    row.phase,
    row.purpose,
    row.commands,
    row.directFileAccess,
    row.inputs,
    row.outputs,
    row.capabilities,
    row.overlapCategory,
    row.notes,
  ]);

  return [
    '# Proof-or-Stop Prompt Overlap Matrix',
    '',
    `Source plan: \`${baseline.sourcePlan}\``,
    `Registry material hash: \`${baseline.registry.materialHash}\``,
    `Role count: ${baseline.registry.agentCount}`,
    '',
    '## Audit Boundary',
    '',
    `- Machine-checked: ${audit.machineChecks.join(' ')}`,
    `- Reviewer-audited fields: ${audit.reviewerAuditedFields.map(field => `\`${field}\``).join(', ')}.`,
    `- Semantic limit: ${audit.semanticBoundary}`,
    `- Source audit anchors: ${audit.sourceAuditAnchors.purpose}`,
    '',
    '| Role | Status | Phase | Purpose | Commands | Direct file access | Inputs | Outputs | Capabilities | Overlap category | Notes |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map(row => `| ${row.map(escapeMarkdownCell).join(' | ')} |`),
    '',
  ].join('\n');
}

function escapeMarkdownCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

function readBaseline() {
  if (!existsSync(BASELINE_PATH)) {
    throw new Error(`Missing baseline lockfile: ${toRepoPath(BASELINE_PATH)}`);
  }
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
}

function requireEqual(actual, expected, label, failures) {
  if (actual !== expected) {
    failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function normalizeContent(text) {
  return text.replace(/\r\n/g, '\n');
}

function requireSameContent(actual, expected, label, failures) {
  if (actual === expected) return;

  const actualLines = actual.split('\n');
  const expectedLines = expected.split('\n');
  const maxLines = Math.max(actualLines.length, expectedLines.length);
  let mismatchLine = 1;
  for (let index = 0; index < maxLines; index += 1) {
    if (actualLines[index] !== expectedLines[index]) {
      mismatchLine = index + 1;
      break;
    }
  }

  failures.push(
    `${label}: content mismatch at line ${mismatchLine}; expected ${JSON.stringify(expectedLines[mismatchLine - 1] ?? '<EOF>')}, got ${JSON.stringify(actualLines[mismatchLine - 1] ?? '<EOF>')}`,
  );
  failures.push(
    `${label}: expected sha256 ${sha256(expected)}, got ${sha256(actual)}`,
  );
}

function mapBy(items, keyFn, label, failures) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (map.has(key)) failures.push(`duplicate ${label}: ${key}`);
    map.set(key, item);
  }
  return map;
}

function verifyRegistry(current, baseline, failures) {
  requireEqual(current.schemaVersion, baseline.schemaVersion, 'baseline schemaVersion', failures);
  requireEqual(current.expectedRoleCount, EXPECTED_ROLE_COUNT, 'expectedRoleCount', failures);
  requireEqual(current.registry.agentCount, EXPECTED_ROLE_COUNT, 'current registry role count', failures);
  requireEqual(baseline.registry.agentCount, EXPECTED_ROLE_COUNT, 'baseline registry role count', failures);
  requireEqual(current.registry.schemaVersion, baseline.registry.schemaVersion, 'registry schemaVersion', failures);
  requireEqual(current.registry.source, baseline.registry.source, 'registry source', failures);
  requireEqual(current.registry.materialHash, baseline.registry.materialHash, 'registry materialHash', failures);

  const currentRoles = mapBy(current.registry.roles, role => role.role, 'current role', failures);
  const baselineRoles = mapBy(baseline.registry.roles, role => role.role, 'baseline role', failures);
  for (const role of baselineRoles.keys()) {
    const actual = currentRoles.get(role);
    const expected = baselineRoles.get(role);
    if (!actual) {
      failures.push(`missing current role ${role}`);
      continue;
    }
    for (const field of ['file', 'relPath', 'templateHash', 'bytes', 'lines']) {
      requireEqual(actual[field], expected[field], `registry ${role}.${field}`, failures);
    }
  }
  for (const role of currentRoles.keys()) {
    if (!baselineRoles.has(role)) failures.push(`unregistered current role ${role}`);
  }
}

function verifyAgentPromptOutputs(current, baseline, failures) {
  const currentOutputs = mapBy(current.agentPrompt.outputs, output => output.role, 'current agent_prompt output', failures);
  const baselineOutputs = mapBy(baseline.agentPrompt.outputs, output => output.role, 'baseline agent_prompt output', failures);
  requireEqual(currentOutputs.size, EXPECTED_ROLE_COUNT, 'current agent_prompt role count', failures);
  requireEqual(baselineOutputs.size, EXPECTED_ROLE_COUNT, 'baseline agent_prompt role count', failures);
  for (const role of baselineOutputs.keys()) {
    const actual = currentOutputs.get(role);
    const expected = baselineOutputs.get(role);
    if (!actual) {
      failures.push(`missing agent_prompt output for ${role}`);
      continue;
    }
    for (const field of ['sha256', 'bytes', 'lines']) {
      requireEqual(actual[field], expected[field], `agent_prompt ${role}.${field}`, failures);
    }
  }
}

function verifyRoleMatrixFields(rows, label, failures) {
  for (const [role, row] of rows) {
    if (typeof row.role !== 'string' || row.role.length === 0) {
      failures.push(`${label} ${role}.role: missing or empty role`);
    }
    for (const field of ROLE_MATRIX_FIELDS) {
      if (typeof row[field] !== 'string' || row[field].length === 0) {
        failures.push(`${label} ${role}.${field}: missing or empty string`);
      }
    }
    for (const field of Object.keys(row)) {
      if (field !== 'role' && !ROLE_MATRIX_FIELDS.includes(field)) {
        failures.push(`${label} ${role}.${field}: unknown roleMatrix field`);
      }
    }
  }
}

function verifyMatrix(current, baseline, failures) {
  const currentRoleMatrix = Array.isArray(current.roleMatrix) ? current.roleMatrix : [];
  const baselineRoleMatrix = Array.isArray(baseline.roleMatrix) ? baseline.roleMatrix : [];
  if (!Array.isArray(current.roleMatrix)) failures.push('current roleMatrix: missing or not an array');
  if (!Array.isArray(baseline.roleMatrix)) failures.push('baseline roleMatrix: missing or not an array');

  const currentRows = mapBy(currentRoleMatrix, row => row.role, 'current matrix role', failures);
  const baselineRows = mapBy(baselineRoleMatrix, row => row.role, 'baseline matrix role', failures);
  requireEqual(currentRows.size, EXPECTED_ROLE_COUNT, 'current matrix role count', failures);
  requireEqual(baselineRows.size, EXPECTED_ROLE_COUNT, 'baseline matrix role count', failures);
  verifyRoleMatrixFields(currentRows, 'current roleMatrix', failures);
  verifyRoleMatrixFields(baselineRows, 'baseline roleMatrix', failures);
  for (const role of baselineRows.keys()) {
    const actual = currentRows.get(role);
    const expected = baselineRows.get(role);
    if (!actual) {
      failures.push(`current matrix missing role ${role}`);
      continue;
    }
    for (const field of ROLE_MATRIX_FIELDS) {
      requireEqual(actual[field], expected[field], `roleMatrix ${role}.${field}`, failures);
    }
  }
  for (const role of currentRows.keys()) {
    if (!baselineRows.has(role)) failures.push(`baseline matrix missing role ${role}`);
  }

  if (!existsSync(MATRIX_PATH)) {
    failures.push(`missing overlap matrix: ${toRepoPath(MATRIX_PATH)}`);
    return;
  }
  const actualMarkdown = normalizeContent(readFileSync(MATRIX_PATH, 'utf8'));
  const expectedMarkdown = normalizeContent(renderMatrixMarkdown(baseline));
  requireSameContent(actualMarkdown, expectedMarkdown, `overlap matrix markdown ${toRepoPath(MATRIX_PATH)}`, failures);
}

function verifyRoleMatrixAudit(current, baseline, failures) {
  verifyRoleMatrixAuditSnapshot(current.roleMatrixAudit, current.registry.roles, 'current roleMatrixAudit', failures);
  verifyRoleMatrixAuditSnapshot(baseline.roleMatrixAudit, baseline.registry.roles, 'baseline roleMatrixAudit', failures);
  requireSameContent(
    JSON.stringify(current.roleMatrixAudit, null, 2),
    JSON.stringify(baseline.roleMatrixAudit, null, 2),
    'roleMatrixAudit snapshot',
    failures,
  );
}

function verifyRoleMatrixAuditSnapshot(audit, registryRoles, label, failures) {
  if (!audit || typeof audit !== 'object' || Array.isArray(audit)) {
    failures.push(`${label}: missing or not an object`);
    return;
  }
  requireSameContent(
    JSON.stringify(audit.machineChecks),
    JSON.stringify(ROLE_MATRIX_MACHINE_CHECKS),
    `${label}.machineChecks`,
    failures,
  );
  requireSameContent(
    JSON.stringify(audit.reviewerAuditedFields),
    JSON.stringify(REVIEWER_AUDITED_ROLE_MATRIX_FIELDS),
    `${label}.reviewerAuditedFields`,
    failures,
  );
  requireEqual(audit.semanticBoundary, ROLE_MATRIX_SEMANTIC_BOUNDARY, `${label}.semanticBoundary`, failures);
  requireEqual(
    audit.sourceAuditAnchors?.purpose,
    ROLE_MATRIX_SOURCE_ANCHOR_PURPOSE,
    `${label}.sourceAuditAnchors.purpose`,
    failures,
  );

  const anchors = mapBy(
    Array.isArray(audit.sourceAuditAnchors?.roles) ? audit.sourceAuditAnchors.roles : [],
    anchor => anchor.role,
    `${label} source audit anchor`,
    failures,
  );
  const roles = mapBy(registryRoles ?? [], role => role.role, `${label} registry role`, failures);
  requireEqual(anchors.size, EXPECTED_ROLE_COUNT, `${label} source audit anchor count`, failures);
  for (const [role, registryRole] of roles) {
    const anchor = anchors.get(role);
    if (!anchor) {
      failures.push(`${label}: missing source audit anchor for ${role}`);
      continue;
    }
    requireEqual(anchor.relPath, registryRole.relPath, `${label} ${role}.relPath`, failures);
    requireEqual(anchor.templateHash, registryRole.templateHash, `${label} ${role}.templateHash`, failures);
    for (const field of Object.keys(anchor)) {
      if (!['role', 'relPath', 'templateHash'].includes(field)) {
        failures.push(`${label} ${role}.${field}: unknown source audit anchor field`);
      }
    }
  }
  for (const role of anchors.keys()) {
    if (!roles.has(role)) failures.push(`${label}: source audit anchor has unknown role ${role}`);
  }
}

function verifyFindings(currentFindings, baselineFindings, label, failures) {
  const currentMap = mapBy(currentFindings, buildFindingKey, `current ${label}`, failures);
  const baselineMap = mapBy(baselineFindings, buildFindingKey, `baseline ${label}`, failures);

  for (const [key, actual] of currentMap) {
    const expected = baselineMap.get(key);
    if (!expected) {
      failures.push(`unclassified ${label}: ${actual.role}:${actual.line} ${actual.excerpt}`);
      continue;
    }
    requireEqual(actual.classification, expected.classification, `${label} ${key}.classification`, failures);
    if ('grandfathered' in expected) {
      requireEqual(actual.grandfathered, expected.grandfathered, `${label} ${key}.grandfathered`, failures);
    }
  }

  for (const [key, expected] of baselineMap) {
    if (!currentMap.has(key)) {
      failures.push(`baseline ${label} no longer present: ${expected.role}:${expected.line} ${expected.excerpt}`);
    }
  }
}

function verifyNoUnregisteredDirectStoryWrite(current, baseline, failures) {
  const baselineMap = mapBy(
    baseline.directStoryFileReferences.findings,
    buildFindingKey,
    'baseline direct story-file finding',
    failures,
  );
  for (const finding of current.directStoryFileReferences.findings) {
    if (finding.classification !== 'direct-write') continue;
    const registered = baselineMap.get(buildFindingKey(finding));
    if (!registered || registered.classification !== 'direct-write') {
      failures.push(`new unregistered direct docs/story write instruction: ${finding.role}:${finding.line} ${finding.excerpt}`);
      continue;
    }
    if (!registered.grandfathered) {
      failures.push(`direct docs/story write is not explicitly grandfathered: ${finding.role}:${finding.line}`);
    }
  }
}

function directStoryWritePolicyErrors(findings) {
  const errors = [];
  for (const finding of findings) {
    const location = `${finding.role}:${finding.line ?? 'probe'}`;
    if (finding.classification === 'unclassified-actionable') {
      errors.push(`unclassified actionable reference at ${location}: ${finding.excerpt}`);
      continue;
    }
    if (finding.classification !== 'direct-write') continue;
    const explicitlyGrandfathered = isExplicitlyGrandfatheredDirectStoryWrite(
      finding.role,
      finding.excerpt,
    );
    if (finding.grandfathered !== explicitlyGrandfathered) {
      errors.push(`direct write grandfathering mismatch at ${location}: ${finding.excerpt}`);
    }
    if (!explicitlyGrandfathered) {
      errors.push(`direct write is not explicitly grandfathered at ${location}: ${finding.excerpt}`);
    }
  }

  for (const allow of DIRECT_STORY_WRITE_ALLOWLIST) {
    const matches = findings.filter(
      finding =>
        finding.classification === 'direct-write' &&
        finding.role === allow.role &&
        finding.excerpt === allow.excerpt &&
        finding.grandfathered === true,
    );
    if (matches.length !== 1) {
      errors.push(
        `explicit direct-write allow entry must match exactly once for ${allow.role}: matched ${matches.length}`,
      );
    }
  }
  return errors;
}

function assertDirectStoryWritePolicy(findings) {
  const errors = directStoryWritePolicyErrors(findings);
  if (errors.length === 0) return;
  throw new Error(
    `Refusing to collect or refresh the baseline because direct story-write policy failed:\n- ${errors.join('\n- ')}`,
  );
}

function verifyDirectStoryWritePolicy(findings, label, failures) {
  for (const error of directStoryWritePolicyErrors(findings)) {
    failures.push(`${label} direct story-write policy: ${error}`);
  }
}

function verifyDirectStoryClassifierProbes(failures) {
  requireEqual(
    DIRECT_STORY_WRITE_ALLOWLIST.length,
    1,
    'direct story-write explicit allow entry count',
    failures,
  );
  for (const probe of DIRECT_STORY_CLASSIFIER_PROBES) {
    const actual = classifyStoryFinding(probe.role, probe.excerpt);
    requireEqual(actual.classification, probe.classification, `direct story classifier probe ${probe.name}.classification`, failures);
    requireEqual(actual.grandfathered, probe.grandfathered, `direct story classifier probe ${probe.name}.grandfathered`, failures);
    verifyBaselineRefreshProbe(
      probe,
      [{ role: probe.role, content: probe.excerpt }],
      failures,
    );
  }

  for (const probe of DIRECT_STORY_SCANNER_PROBES) {
    const findings = scanStoryFileReferences([{ role: probe.role, content: probe.content }]);
    requireEqual(findings.length, 1, `direct story scanner probe ${probe.name}.finding count`, failures);
    const actual = findings[0];
    if (!actual) continue;
    requireEqual(actual.line, probe.line, `direct story scanner probe ${probe.name}.line`, failures);
    requireEqual(actual.classification, probe.classification, `direct story scanner probe ${probe.name}.classification`, failures);
    requireEqual(actual.grandfathered, probe.grandfathered, `direct story scanner probe ${probe.name}.grandfathered`, failures);
    verifyBaselineRefreshProbe(
      probe,
      [{ role: probe.role, content: probe.content }],
      failures,
    );
  }
}

function verifyBaselineRefreshProbe(probe, roleEntries, failures) {
  if (!probe.baselineRefresh) return;
  let rejection = '';
  try {
    collectDirectStoryFindings(roleEntries);
  } catch (error) {
    rejection = String(error instanceof Error ? error.message : error);
  }
  if (probe.baselineRefresh === 'allow') {
    if (rejection) {
      failures.push(
        `direct story probe ${probe.name}: expected baseline refresh to be allowed, got ${JSON.stringify(rejection)}`,
      );
    }
    return;
  }
  if (!rejection.includes(probe.expectedRejection)) {
    failures.push(
      `direct story probe ${probe.name}: expected baseline-refresh rejection containing ${JSON.stringify(probe.expectedRejection)}, got ${JSON.stringify(rejection)}`,
    );
  }
}

function verifyRoleMatrixSnapshotDriftProbe(current, failures) {
  const mutatedBaseline = structuredClone(current);
  const row = mutatedBaseline.roleMatrix.find(candidate => candidate.role === 'lattice-review-behavior');
  if (!row) {
    failures.push('role matrix snapshot drift probe: lattice-review-behavior row missing');
    return;
  }
  row.commands = `${row.commands} snapshot-drift-sentinel`;

  const driftFailures = [];
  verifyMatrix(current, mutatedBaseline, driftFailures);
  if (!driftFailures.some(failure => failure.includes('roleMatrix lattice-review-behavior.commands'))) {
    failures.push(
      `role matrix snapshot drift probe: JSON field drift was not rejected; got ${JSON.stringify(driftFailures)}`,
    );
  }
  if (!driftFailures.some(failure => failure.includes('overlap matrix markdown'))) {
    failures.push(
      `role matrix snapshot drift probe: Markdown parity drift was not rejected; got ${JSON.stringify(driftFailures)}`,
    );
  }
}

function runDirectStoryClassifierProbeCommand() {
  const failures = [];
  verifyDirectStoryClassifierProbes(failures);
  if (failures.length > 0) {
    console.error('FAIL direct story-file classifier adversarial probes');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log(
    `PASS direct story-file classifier adversarial probes: ${DIRECT_STORY_CLASSIFIER_PROBES.length} classifier cases, ${DIRECT_STORY_SCANNER_PROBES.length} scanner case`,
  );
}

async function runRoleMatrixSnapshotDriftProbeCommand() {
  const current = await collectCurrentBaseline();
  const failures = [];
  verifyRoleMatrixSnapshotDriftProbe(current, failures);

  if (failures.length > 0) {
    console.error('FAIL role matrix mechanical snapshot-drift probe');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log('PASS role matrix mechanical snapshot-drift probe: JSON field and Markdown parity drift rejected');
}

async function writeBaselineFiles() {
  const current = await collectCurrentBaseline();
  mkdirSync(dirname(BASELINE_PATH), { recursive: true });
  writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
  writeFileSync(MATRIX_PATH, renderMatrixMarkdown(current));
  console.log(`WROTE ${toRepoPath(BASELINE_PATH)}`);
  console.log(`WROTE ${toRepoPath(MATRIX_PATH)}`);
}

async function verifyBaseline() {
  const baseline = readBaseline();
  const current = await collectCurrentBaseline();
  const failures = [];

  verifyRegistry(current, baseline, failures);
  verifyAgentPromptOutputs(current, baseline, failures);
  verifyMatrix(current, baseline, failures);
  verifyRoleMatrixAudit(current, baseline, failures);
  verifyRoleMatrixSnapshotDriftProbe(current, failures);
  verifyFindings(
    current.legacyVocabulary.findings,
    baseline.legacyVocabulary.findings,
    'legacy vocabulary finding',
    failures,
  );
  verifyFindings(
    current.directStoryFileReferences.findings,
    baseline.directStoryFileReferences.findings,
    'direct story-file finding',
    failures,
  );
  verifyDirectStoryWritePolicy(
    current.directStoryFileReferences.findings,
    'current',
    failures,
  );
  verifyDirectStoryWritePolicy(
    baseline.directStoryFileReferences.findings,
    'baseline',
    failures,
  );
  verifyNoUnregisteredDirectStoryWrite(current, baseline, failures);
  verifyDirectStoryClassifierProbes(failures);

  if (failures.length > 0) {
    console.error('FAIL proof-or-stop prompt baseline');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log('PASS proof-or-stop prompt baseline: roleCount=16 registry hashes verified');
  console.log('PASS proof-or-stop prompt baseline: agent_prompt output hashes verified for 16 roles');
  console.log('PASS proof-or-stop prompt baseline: role matrix snapshot integrity verified for 16 roles');
  console.log('PASS proof-or-stop prompt baseline: role matrix mechanical snapshot-drift probe rejected');
  console.log('INFO proof-or-stop prompt baseline: commands, outputs, and direct-file-access semantics remain reviewer-audited');
  console.log('PASS proof-or-stop prompt baseline: legacy vocabulary findings classified');
  console.log('PASS proof-or-stop prompt baseline: direct story-file findings classified');
  console.log('PASS proof-or-stop prompt baseline: direct story-write policy has 1 exact grandfathered write');
}

if (PROBE_DIRECT_STORY_CLASSIFIER) {
  runDirectStoryClassifierProbeCommand();
} else if (PROBE_ROLE_MATRIX_SNAPSHOT_DRIFT) {
  await runRoleMatrixSnapshotDriftProbeCommand();
} else if (WRITE_MODE) {
  await writeBaselineFiles();
} else {
  await verifyBaseline();
}
