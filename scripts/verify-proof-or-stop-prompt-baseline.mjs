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
const SCHEMA_VERSION = 'proof-or-stop.prompt-baseline.v5';
const PLAN_PATH = 'docs/requirements/decisions/proof-or-stop-agent-prompt-consolidation-execution-plan.md';
const WRITE_MODE = process.argv.includes('--write');
const PROBE_DIRECT_STORY_CLASSIFIER = process.argv.includes('--probe-direct-story-classifier');
const PROBE_LEGACY_VOCABULARY_POLICY = process.argv.includes('--probe-legacy-vocabulary-policy');
const PROBE_BASELINE_DRIFT = process.argv.includes('--probe-baseline-drift');
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
const REVIEWER_AUDITED_ROLE_MATRIX_FIELDS = [...ROLE_MATRIX_FIELDS];
const ROLE_MATRIX_MACHINE_CHECKS = [
  'Lock the exact 16 role snapshots and role IDs.',
  'Lock registry template hashes and agent_prompt output hashes.',
  'Require every role-matrix field to be a non-empty string.',
  'Require JSON/Markdown parity and reject snapshot drift.',
];
const ROLE_MATRIX_SEMANTIC_BOUNDARY =
  'Every human-authored role-matrix field is a reviewer-audited semantic snapshot. The verifier proves required fields, exact snapshots and hashes, JSON/Markdown parity, and drift rejection; it does not infer or prove role semantics from prompt prose.';
const ROLE_MATRIX_COMMANDS_CONTRACT = {
  includes:
    'Role-owned writes plus role-defining inspection or execution calls named in the role-specific procedure.',
  excludes:
    'Universal Runtime Guide preflight/navigation reads (session_brief, aux_doc_list, and generic story_get/checklist_get) plus commands mentioned only as prohibited or as another role\'s produced artifact or input.',
};
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
const LEGACY_VOCABULARY_ENFORCED_STATUSES = ['active', 'conditional', 'optional', 'compatibility'];
const LEGACY_VOCABULARY_CONTEXT_MARKERS = [
  'old',
  'legacy',
  'deprecated',
  'retired',
  'removed',
  'deleted',
  'replaced',
  'compatibility',
];
const LEGACY_VOCABULARY_POLICY_RULE =
  'Each testIntent, TEST_CASE, or TEST_CASE_REVIEW occurrence in an active, conditional, optional, or compatibility role must be a true negative reference or carry explicit local old/legacy/deprecated/retired/removed/deleted/replaced/compatibility context. Positive instructions always fail, and context in another clause or negated context such as "not legacy" never blesses them. Legacy, retired, and fold-candidate roles remain readable.';

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
    commands: 'bridge state/reset/events/event/replay API via curl; cat .lattice-serve.json; optional CLI shell spawn.',
    directFileAccess: 'Reads .lattice-serve.json for CLI shell connection info; otherwise uses CLI shell/bridge output and performs no direct story writes.',
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
    commands: 'checklist_update; validate; optional serve; aux_scan; aux_detail; local lint/build/unit tests; git add; git commit.',
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
    commands: 'git diff; dev_memory_preflight; dev_memory_search; Glob/rg candidate search; review_run_start; finding_add; review_pass_set.',
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
    commands: 'grep process-events; review_run_start; finding_add; review_pass_set.',
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
    commands: 'git diff; source grep; delivery_check_set.',
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
    commands: 'config; dev_memory_preflight; dev_memory_search; Glob/rg candidate search; scope_check_save.',
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
    commands: 'Read/Grep story inputs; init_check_set; cat/echo/Edit init-self-check.json.',
    directFileAccess: 'Grandfathered direct docs/story reads plus init-self-check cat/echo/Edit write wording.',
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
    commands: 'validate; review_run_start; finding_add; review_pass_set.',
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
    commands: 'Read fixture JSON; testintent_check; testintent_record.',
    directFileAccess: 'Legacy direct fixture JSON reads; writes only through testintent_record.',
    inputs: 'Legacy testIntent and fixture JSON.',
    outputs: 'testintent_record results and testintent_check status.',
    capabilities: 'Legacy fixture coverage review.',
    overlapCategory: 'replaced by current lattice-review-test-coverage; target proof-or-stop-review-test-coverage',
    notes: 'Legacy-only prompt tied to old TEST_CASE_REVIEW phase.',
  },
  'test-intent': {
    status: 'legacy',
    phase: 'PLAN legacy',
    purpose: 'Legacy checklist split reviewer and testIntent writer.',
    commands: 'checklist_update.',
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
    name: 'same-clause prohibition followed by apply_patch instruction',
    role: 'lattice-review-docs',
    excerpt: 'Do not edit docs/story/actives/B-1234/index.json and then use apply_patch to update docs/story/actives/B-1234/index.json.',
    classification: 'direct-write',
    grandfathered: false,
    baselineRefresh: 'reject',
    expectedRejection: 'direct write is not explicitly grandfathered',
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
    name: 'unknown directive-shaped metadata tool fails closed',
    role: 'lattice-review-docs',
    excerpt: 'Use the project-specific metadata transformer on docs/story/actives/B-1234/index.json.',
    classification: 'unclassified-actionable',
    grandfathered: false,
    baselineRefresh: 'reject',
    expectedRejection: 'unclassified actionable reference',
  },
  {
    name: 'generic output flag targeting story metadata is a direct write',
    role: 'lattice-review-docs',
    excerpt: 'Run metadata-transformer --output docs/story/actives/B-1234/index.json',
    classification: 'direct-write',
    grandfathered: false,
    baselineRefresh: 'reject',
    expectedRejection: 'direct write is not explicitly grandfathered',
  },
  {
    name: 'avoid clause cannot bless apply_patch after and instead',
    role: 'lattice-review-docs',
    excerpt: 'Avoid editing docs/story/actives/B-1234/index.json and instead use apply_patch to update docs/story/actives/B-1234/index.json.',
    classification: 'direct-write',
    grandfathered: false,
    baselineRefresh: 'reject',
    expectedRejection: 'direct write is not explicitly grandfathered',
  },
  {
    name: 'prohibition cannot bless apply_patch after then',
    role: 'lattice-review-docs',
    excerpt: 'Do not edit docs/story/actives/B-1234/index.json then use apply_patch to update docs/story/actives/B-1234/index.json.',
    classification: 'direct-write',
    grandfathered: false,
    baselineRefresh: 'reject',
    expectedRejection: 'direct write is not explicitly grandfathered',
  },
  {
    name: 'negative reminder cannot bless apply_patch exception after story target',
    role: 'lattice-review-docs',
    excerpt: 'Do not edit docs/story/actives/B-1234/index.json unless use apply_patch to update docs/story/actives/B-1234/index.json.',
    classification: 'direct-write',
    grandfathered: false,
    baselineRefresh: 'reject',
    expectedRejection: 'direct write is not explicitly grandfathered',
  },
  {
    name: 'negative reminder cannot bless apply_patch exception before story target',
    role: 'lattice-review-docs',
    excerpt: 'Do not edit files unless use apply_patch on docs/story/actives/B-1234/index.json.',
    classification: 'direct-write',
    grandfathered: false,
    baselineRefresh: 'reject',
    expectedRejection: 'direct write is not explicitly grandfathered',
  },
  {
    name: 'unknown negative action cannot bless unknown second action',
    role: 'lattice-review-docs',
    excerpt: 'Do not touch docs/story/actives/B-1234/index.json unless frobnicate docs/story/actives/B-1234/index.json.',
    classification: 'unclassified-actionable',
    grandfathered: false,
    baselineRefresh: 'reject',
    expectedRejection: 'unclassified actionable reference',
  },
  {
    name: 'process directive with unknown transformer fails closed',
    role: 'lattice-review-docs',
    excerpt: 'Process docs/story/actives/B-1234/index.json with the metadata transformer.',
    classification: 'unclassified-actionable',
    grandfathered: false,
    baselineRefresh: 'reject',
    expectedRejection: 'unclassified actionable reference',
  },
  {
    name: 'unknown metadata tool using for target fails closed',
    role: 'lattice-review-docs',
    excerpt: 'Use the metadata transformer for docs/story/actives/B-1234/index.json.',
    classification: 'unclassified-actionable',
    grandfathered: false,
    baselineRefresh: 'reject',
    expectedRejection: 'unclassified actionable reference',
  },
  {
    name: 'conditional unknown metadata tool fails closed',
    role: 'lattice-review-docs',
    excerpt: 'If needed, use the metadata transformer on docs/story/actives/B-1234/index.json.',
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
  {
    name: 'natural copy destination continuation is scanned as one instruction',
    role: 'lattice-review-docs',
    content: 'Copy source.json to\ndocs/story/actives/B-1234/index.json',
    line: 1,
    classification: 'direct-write',
    grandfathered: false,
    baselineRefresh: 'reject',
    expectedRejection: 'direct write is not explicitly grandfathered',
  },
  {
    name: 'copy into destination continuation is scanned as one instruction',
    role: 'lattice-review-docs',
    content: 'Copy source.json\ninto docs/story/actives/B-1234/index.json',
    line: 1,
    classification: 'direct-write',
    grandfathered: false,
    baselineRefresh: 'reject',
    expectedRejection: 'direct write is not explicitly grandfathered',
  },
  {
    name: 'unknown metadata tool target continuation fails closed',
    role: 'lattice-review-docs',
    content: 'Use the metadata transformer on\ndocs/story/actives/B-1234/index.json',
    line: 1,
    classification: 'unclassified-actionable',
    grandfathered: false,
    baselineRefresh: 'reject',
    expectedRejection: 'unclassified actionable reference',
  },
  {
    name: 'against target continuation fails closed without connector allowlist',
    role: 'lattice-review-docs',
    content: 'Use the metadata transformer\nagainst docs/story/actives/B-1234/index.json',
    line: 1,
    classification: 'unclassified-actionable',
    grandfathered: false,
    baselineRefresh: 'reject',
    expectedRejection: 'unclassified actionable reference',
  },
  {
    name: 'across target continuation fails closed without connector allowlist',
    role: 'lattice-review-docs',
    content: 'Run the metadata transformer\nacross docs/story/actives/B-1234/index.json',
    line: 1,
    classification: 'unclassified-actionable',
    grandfathered: false,
    baselineRefresh: 'reject',
    expectedRejection: 'unclassified actionable reference',
  },
];

const LEGACY_VOCABULARY_POLICY_PROBES = [
  {
    name: 'active role cannot instruct new testIntent use',
    role: 'probe-active-role',
    status: 'active',
    content: 'Set testIntent on every checklist item.',
    expectedRejection: 'active legacy-vocabulary use is not explicitly contextualized',
  },
  {
    name: 'spaced test intent variant is enforced',
    role: 'probe-active-role',
    status: 'active',
    content: 'Set test intent on every checklist item.',
    expectedRejection: 'active legacy-vocabulary use is not explicitly contextualized',
  },
  {
    name: 'hyphenated test case review variant is enforced',
    role: 'probe-active-role',
    status: 'active',
    content: 'Enter TEST-CASE-REVIEW for every new story.',
    expectedRejection: 'active legacy-vocabulary use is not explicitly contextualized',
  },
  {
    name: 'underscored test intent variant is enforced',
    role: 'probe-active-role',
    status: 'active',
    content: 'Set test_intent on every checklist item.',
    expectedRejection: 'active legacy-vocabulary use is not explicitly contextualized',
  },
  {
    name: 'mixed-case testIntent variant is enforced for compatibility roles',
    role: 'probe-compatibility-role',
    status: 'compatibility',
    content: 'Set TeStInTeNt on every checklist item.',
    expectedRejection: 'active legacy-vocabulary use is not explicitly contextualized',
  },
  {
    name: 'context in an earlier clause cannot bless positive instruction',
    role: 'probe-active-role',
    status: 'active',
    content: 'Old behavior is removed; for new stories, set testIntent on every checklist item.',
    expectedRejection: 'active legacy-vocabulary use is not explicitly contextualized',
  },
  {
    name: 'negative legacy clause cannot bless later positive instruction',
    role: 'probe-active-role',
    status: 'active',
    content: 'Do not use legacy testIntent; set testIntent on every checklist item.',
    expectedRejection: 'active legacy-vocabulary use is not explicitly contextualized',
  },
  {
    name: 'negated context after positive instruction cannot bless it',
    role: 'probe-active-role',
    status: 'active',
    content: 'Set testIntent on every checklist item; this behavior is not legacy.',
    expectedRejection: 'active legacy-vocabulary use is not explicitly contextualized',
  },
  {
    name: 'positive inflection is rejected despite local compatibility marker',
    role: 'probe-active-role',
    status: 'active',
    content: 'For legacy compatibility, writing testIntent for new stories is required.',
    expectedRejection: 'active legacy-vocabulary use is not explicitly contextualized',
  },
  {
    name: 'unknown attach instruction is rejected despite compatibility context',
    role: 'probe-active-role',
    status: 'active',
    content: 'For legacy compatibility, attach testIntent to each new story.',
    expectedRejection: 'active legacy-vocabulary use is not explicitly contextualized',
  },
  {
    name: 'unknown persist instruction is rejected despite legacy context',
    role: 'probe-active-role',
    status: 'active',
    content: 'Legacy mode: persist testIntent for new stories.',
    expectedRejection: 'active legacy-vocabulary use is not explicitly contextualized',
  },
  {
    name: 'unknown instruction after contextualized occurrence is rejected',
    role: 'probe-active-role',
    status: 'active',
    content: 'Legacy testIntent: attach it to each new story.',
    expectedRejection: 'active legacy-vocabulary use is not explicitly contextualized',
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

function classifyLegacyVocabularyPolicy(roleStatus, clause, occurrence) {
  if (!LEGACY_VOCABULARY_ENFORCED_STATUSES.includes(roleStatus)) {
    return {
      roleStatus,
      policyStatus: 'allowed-role-status',
      policyReason: `Role status ${roleStatus} is outside active/conditional/optional/compatibility enforcement.`,
    };
  }
  if (isNegativeLegacyOccurrence(clause, occurrence)) {
    return {
      roleStatus,
      policyStatus: 'allowed-negative-reference',
      policyReason: 'Occurrence is scoped by a true negative instruction or exclusion.',
    };
  }
  if (isDemonstrablyContextualLegacyOccurrence(clause, occurrence)) {
    return {
      roleStatus,
      policyStatus: 'allowed-explicit-local-context',
      policyReason: 'The occurrence clause explicitly marks non-negated old/legacy/deprecated/retired/removed/deleted/replaced/compatibility context.',
    };
  }
  return {
    roleStatus,
    policyStatus: 'blocked-active-use',
    policyReason: 'Active legacy-vocabulary use is not explicitly contextualized.',
  };
}

function isNegativeLegacyOccurrence(clause, occurrence) {
  const beforeOccurrence = stripDirectiveFormatting(clause.slice(0, occurrence.index));
  if (LEGACY_PATTERNS.some(pattern => pattern.regex.test(beforeOccurrence))) return false;
  const match = beforeOccurrence.match(
    /^(?:do\s+not|don't|must\s+not|should\s+not|never|avoid|without|not)\s+(?:directly\s+)?([A-Za-z][\w-]*)\b/i,
  );
  if (!match) return false;
  return !LEGACY_VOCABULARY_CONTEXT_MARKERS.includes(match[1].toLowerCase());
}

function isDemonstrablyContextualLegacyOccurrence(clause, occurrence) {
  const beforeOccurrence = clause
    .slice(0, occurrence.index)
    .replace(/[*_`]+/g, '')
    .trimEnd();
  const afterOccurrence = clause
    .slice(occurrence.index + occurrence.text.length)
    .replace(/[*_`]+/g, '')
    .trimStart();
  const markerSource = LEGACY_VOCABULARY_CONTEXT_MARKERS.join('|');
  const precedingMarker = beforeOccurrence.match(
    new RegExp(`\\b(${markerSource})\\s*$`, 'i'),
  );
  if (precedingMarker) {
    const markerPrefix = beforeOccurrence.slice(0, precedingMarker.index).trimEnd();
    if (
      !/\b(?:not|never|no\s+longer)(?:\s+(?:a|an))?\s*$/i.test(markerPrefix) &&
      /^[\s,.;:()/-]*$/.test(afterOccurrence)
    ) {
      return true;
    }
  }
  const copulaSource = String.raw`(?:was|is|has\s+been|had\s+been)`;
  const passiveStateSource = String.raw`${copulaSource}\s+(?:explicitly\s+)?(?:${markerSource})\b(?:\s+with\s+[A-Za-z][\w-]*)?`;
  return new RegExp(
    `^${passiveStateSource}(?:,\\s+[A-Za-z][\\w-]*\\s+${passiveStateSource})*[\\s).]*$`,
    'i',
  ).test(afterOccurrence);
}

function classifyLegacyFinding(role, term, excerpt, roleStatus, clause, occurrence) {
  const policy = classifyLegacyVocabularyPolicy(roleStatus, clause, occurrence);
  if (role === 'test-intent' || role === 'test-case-reviewer') {
    return {
      classification: 'legacy-prompt-body',
      note: 'Legacy compatibility prompt; visible until migration or retirement.',
      ...policy,
    };
  }
  if (role === 'lattice-review-test-coverage') {
    return {
      classification: 'legacy-value-reference',
      note: 'Current reviewer explicitly references the old TEST_CASE_REVIEW value without reviving the phase.',
      ...policy,
    };
  }
  if (role === 'lattice-review-concept') {
    return {
      classification: 'legacy-example',
      note: 'Example of concept deletion terminology, not an active testIntent instruction.',
      ...policy,
    };
  }
  if (role === 'implementation-reviewer' || role === 'product-reviewer') {
    return {
      classification: 'legacy-overlap-wording',
      note: 'Legacy wording called out for later prompt consolidation.',
      ...policy,
    };
  }
  return {
    classification: term === 'testIntent' ? 'legacy-vocabulary-reference' : 'legacy-phase-reference',
    note: 'Registered legacy vocabulary occurrence.',
    ...policy,
  };
}

function isExplicitlyGrandfatheredDirectStoryWrite(role, excerpt) {
  return DIRECT_STORY_WRITE_ALLOWLIST.some(
    entry => entry.role === role && entry.excerpt === excerpt,
  );
}

function classifyStoryFinding(role, excerpt) {
  const lower = excerpt.toLowerCase();
  if (isNegativeStoryPolicyReminder(excerpt)) {
    return {
      classification: 'policy-reminder',
      grandfathered: false,
      note: 'Prompt reminds agents not to bypass CLI-mediated story operations.',
    };
  }
  if (isDirectStoryWriteInstruction(excerpt)) {
    return {
      classification: 'direct-write',
      grandfathered: isExplicitlyGrandfatheredDirectStoryWrite(role, excerpt),
      note: 'Registered direct story-file write instruction to replace with CLI-mediated writes in later milestones.',
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

function splitLegacyVocabularyClauses(excerpt) {
  return excerpt
    .replace(/\\\s*\r?\n\s*/g, ' ')
    .split(/\r?\n|;|(?<=[.!?])\s+|,\s*(?:but|however|then|instead)\s+|\s+(?:and\s+(?:then|instead)|but|however|then|instead)\s+/i)
    .map(clause => clause.trim())
    .filter(Boolean);
}

function splitInstructionSegments(excerpt) {
  return excerpt
    .replace(/\\\s*\r?\n\s*/g, ' ')
    .split(/\r?\n|;|(?<=[.!?])\s+/)
    .map(segment => segment.trim())
    .filter(Boolean);
}

function stripDirectiveFormatting(clause) {
  return clause
    .trim()
    .replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/^[^A-Za-z0-9`'"]+\s*/, '')
    .replace(/^(?:[#>`]+\s*)+/, '')
    .replace(/^[*_`]+/, '')
    .trim();
}

function isNegativeStoryPolicyReminder(excerpt) {
  if (!/docs\/story/i.test(excerpt)) return false;
  let hasStoryPolicy = false;
  for (const segment of splitInstructionSegments(excerpt)) {
    if (
      isStrictNegativeStorySegment(segment) ||
      isStrictDirectEditCliReminder(segment) ||
      isKnownWrappedStoryPolicyFragment(segment)
    ) {
      hasStoryPolicy = true;
      continue;
    }
    if (isStrictCliMediatedStorySegment(segment)) continue;
    return false;
  }
  return hasStoryPolicy;
}

function normalizeStoryPolicySegment(segment) {
  return stripDirectiveFormatting(segment)
    .replace(/[*_`'"“”]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/, '')
    .trim();
}

function isStrictNegativeStorySegment(segment) {
  const directive = normalizeStoryPolicySegment(segment);
  const action = String.raw`[A-Za-z][\w-]*(?:\s+apply_patch)?`;
  const match = directive.match(
    new RegExp(
      String.raw`^(?:do\s+not|don't|must\s+not|never|avoid)\s+(?:directly\s+)?${action}(?:(?:\s*\/\s*|\s+(?:or|and)\s+)${action})*\s+([\s\S]+)$`,
      'i',
    ),
  );
  if (!match) return false;

  const target = match[1];
  const storyPath = target.match(/docs\/story(?:\/[^\s`'")\]},;!?]*)?/i);
  if (!storyPath || storyPath.index === undefined) return false;
  const beforePath = target.slice(0, storyPath.index);
  const afterPath = target.slice(storyPath.index + storyPath[0].length);
  const safeTargetWords = new Set([
    'the',
    'story',
    'metadata',
    'json',
    'file',
    'files',
    'artifact',
    'artifacts',
    'directory',
    'directories',
    'content',
    'anything',
    'directly',
    'under',
    'in',
    'into',
    'inside',
    'within',
    'at',
    'from',
    'to',
    'on',
    'onto',
    'beneath',
  ]);
  const beforeWords = beforePath.match(/[A-Za-z]+/g) ?? [];
  if (beforeWords.some(word => !safeTargetWords.has(word.toLowerCase()))) return false;
  if (afterPath.replace(/[\s`'"*_,.:;!?()[\]{}<>/\\-]+/g, '') === '') return true;
  return /^\s*,?\s+and\s+do\s+not\s+write\s+fixtures\s+directly\s+under\s*$/i.test(
    afterPath,
  );
}

function isStrictCliMediatedStorySegment(segment) {
  const directive = normalizeStoryPolicySegment(segment);
  return (
    /^(?:story\s+operations\s+must\s+use|use)\s+(?:the\s+)?lattice\s+cli(?:\s+commands?)?(?:\s+instead)?$/i.test(
      directive,
    ) ||
    /^all\s+story\s+changes\s+go\s+through\s+(?:the\s+)?lattice\s+cli$/i.test(
      directive,
    )
  );
}

function isStrictDirectEditCliReminder(segment) {
  const directive = normalizeStoryPolicySegment(segment);
  return /^directly\s+read\s*\/\s*edit\s+json\s+files?\s+under\s+docs\/story\/?\s*:\s*all\s+story\s+changes\s+go\s+through\s+(?:the\s+)?lattice\s+cli$/i.test(
    directive,
  );
}

function isKnownWrappedStoryPolicyFragment(segment) {
  const directive = normalizeStoryPolicySegment(segment);
  return /^story\s+metadata\s+under\s+docs\/story\/?\s*,?\s+and\s+do\s+not\s+write\s+fixtures\s+directly\s+under$/i.test(
    directive,
  );
}

function hasNegativeStoryPolicyLead(excerpt) {
  return splitInstructionSegments(excerpt).some(segment =>
    /^(?:do\s+not|don't|must\s+not|never|avoid)\b/i.test(
      stripDirectiveFormatting(segment),
    ),
  );
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
    /(?:^|\s)(?:--output(?:=|\s+)|-o\s+)["'`]?docs\/story/i.test(clause) ||
    /\b(?:echo|printf|cat)\b[\s\S]*(?:>|>>)\s*docs\/story/i.test(clause) ||
    /\b(?:echo|printf)\b[\s\S]*\|\s*tee\b[\s\S]*docs\/story/i.test(clause) ||
    /(?:^|\s)(?:>|>>)\s*docs\/story/i.test(clause)
  );
}

function isDirectStoryWriteInstruction(excerpt) {
  if (!/docs\/story/i.test(excerpt)) return false;
  if (isNegativeStoryPolicyReminder(excerpt)) return false;
  if (isStrictProcessEventEvidenceReference(excerpt)) return false;
  return hasRecognizedStoryWriteAction(excerpt);
}

function hasActionableStoryMutationSignal(excerpt) {
  if (!/docs\/story/i.test(excerpt)) return false;
  if (isNegativeStoryPolicyReminder(excerpt)) return false;
  if (isStrictProcessEventEvidenceReference(excerpt)) return false;
  if (hasRecognizedStoryWriteAction(excerpt)) return true;
  if (hasNegativeStoryPolicyLead(excerpt)) return true;
  if (isReadOnlyStoryClause(excerpt) || isCliMediatedStoryRedirect(excerpt)) return false;
  return hasUnknownStoryMutationDirective(excerpt) || looksLikeImperativeDirective(excerpt);
}

function isStrictProcessEventEvidenceReference(excerpt) {
  const lower = excerpt.toLowerCase();
  if (!lower.includes('process-events.jsonl')) return false;
  return (
    lower.startsWith('the truly reliable evidence source is') ||
    lower.includes('dispatch evidence source') ||
    lower.includes('full text') ||
    isReadOnlyStoryClause(excerpt)
  );
}

function hasUnknownStoryMutationDirective(clause) {
  if (!/docs\/story/i.test(clause)) return false;
  return looksLikeImperativeDirective(clause);
}

function isReadOnlyStoryClause(clause) {
  const directive = stripDirectiveFormatting(clause);
  return (
    /\bread\s+only\b|\bfull\s+text\b/i.test(directive) ||
    /^(?:read|cat|grep|find|list|inspect|view|show|print|search|scan)\b/i.test(directive) ||
    /^(?:use|run|invoke)\s+(?:the\s+)?(?:read|cat|grep|find|list|inspect|view|show|print|search|scan)\b/i.test(directive) ||
    /^(?:use|run|invoke)\b[\s\S]*\b(?:to\s+)?(?:read|inspect|view|show|list|search|scan)\b[\s\S]*docs\/story/i.test(directive)
  );
}

function isCliMediatedStoryRedirect(clause) {
  const directive = stripDirectiveFormatting(clause);
  return /^(?:use\s+(?:the\s+)?lattice\s+cli|route\b[\s\S]*\b(?:through|via)\s+(?:the\s+)?lattice\s+cli)\b/i.test(
    directive,
  );
}

function looksLikeImperativeDirective(clause) {
  const directive = stripDirectiveFormatting(clause);
  if (!directive) return false;
  if (isReadOnlyStoryClause(directive) || isCliMediatedStoryRedirect(directive)) return false;
  if (/^["'`*]*docs\/story\b/i.test(directive)) return false;

  const withoutCondition = directive.replace(
    /^(?:if|when)\b[^,:\n]*(?:,|:)\s*/i,
    '',
  );
  const withoutLead = withoutCondition.replace(
    /^(?:(?:please|then|instead)\s+|for\s+new\s+stories\s*,\s*|you\s+(?:must|should|can|may)\s+|(?:must|should)\s+)/i,
    '',
  );
  if (/^["'`*]*docs\/story\b/i.test(withoutLead)) return false;
  if (/^(?:the|a|an|all|this|that|these|those|other|story|current|legacy|source|input|output|full|expected|registered|role|prompt|evidence|example|note|notes|if|when|where|while|because|whether|which|who|why|how)\b/i.test(withoutLead)) {
    return false;
  }
  return /^[A-Za-z][A-Za-z0-9_.:/-]*(?:\s|$)/.test(withoutLead);
}

function scanLegacyVocabulary(roleEntries) {
  const findings = [];
  for (const entry of roleEntries) {
    const roleStatus = entry.status ?? ROLE_MATRIX_DEFAULTS[entry.role]?.status ?? 'unknown';
    const lines = entry.content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const excerpt = lines[index].trim();
      if (!excerpt) continue;
      const clauses = splitLegacyVocabularyClauses(excerpt);
      let occurrence = 0;
      for (let clauseIndex = 0; clauseIndex < clauses.length; clauseIndex += 1) {
        const clause = clauses[clauseIndex];
        const clauseOccurrences = [];
        for (const pattern of LEGACY_PATTERNS) {
          const flags = pattern.regex.flags.includes('g')
            ? pattern.regex.flags
            : `${pattern.regex.flags}g`;
          for (const match of clause.matchAll(new RegExp(pattern.regex.source, flags))) {
            clauseOccurrences.push({
              term: pattern.term,
              index: match.index,
              text: match[0],
            });
          }
        }
        clauseOccurrences.sort(
          (a, b) => a.index - b.index || a.term.localeCompare(b.term),
        );
        for (const matched of clauseOccurrences) {
          occurrence += 1;
          const classification = classifyLegacyFinding(
            entry.role,
            matched.term,
            excerpt,
            roleStatus,
            clause,
            matched,
          );
          findings.push({
            id: sha256(`${entry.role}\0${index + 1}\0${occurrence}\0${matched.term}\0${excerpt}`).slice(0, 16),
            role: entry.role,
            line: index + 1,
            clauseIndex: clauseIndex + 1,
            occurrence,
            term: matched.term,
            matchedText: matched.text,
            clause,
            excerpt,
            ...classification,
          });
        }
      }
    }
  }
  return findings.sort(compareFinding);
}

function legacyVocabularyPolicyErrors(findings) {
  return findings
    .filter(finding => finding.policyStatus === 'blocked-active-use')
    .map(
      finding =>
        `active legacy-vocabulary use is not explicitly contextualized at ${finding.role}:${finding.line ?? 'probe'} (${finding.term}): ${finding.excerpt}`,
    );
}

function assertLegacyVocabularyPolicy(findings) {
  const errors = legacyVocabularyPolicyErrors(findings);
  if (errors.length === 0) return;
  throw new Error(
    `Refusing to collect or refresh the baseline because legacy-vocabulary policy failed:\n- ${errors.join('\n- ')}`,
  );
}

function collectLegacyVocabularyFindings(roleEntries) {
  const findings = scanLegacyVocabulary(roleEntries);
  assertLegacyVocabularyPolicy(findings);
  return findings;
}

function buildStoryScanExcerpts(content) {
  const lines = content.split(/\r?\n/);
  const excerpts = [];
  for (let index = 0; index < lines.length; index += 1) {
    const start = index;
    const parts = [lines[index].trim()];
    while (
      index + 1 < lines.length &&
      shouldJoinMutationContinuation(lines[index], lines[index + 1])
    ) {
      index += 1;
      parts.push(lines[index].trim());
    }
    excerpts.push({ line: start + 1, excerpt: parts.join(' ').trim() });
  }
  return excerpts;
}

function shouldJoinMutationContinuation(line, nextLine) {
  if (!/docs\/story/i.test(nextLine)) return false;
  if (/^\s*```/.test(line)) return false;
  if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(nextLine)) return false;
  if (!/\\\s*$/.test(line) && /[.!?;:]\s*$/.test(line.trim())) return false;
  return looksLikeImperativeDirective(line);
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
    (a.occurrence ?? 0) - (b.occurrence ?? 0) ||
    String(a.term ?? a.references?.[0] ?? '').localeCompare(String(b.term ?? b.references?.[0] ?? '')) ||
    a.excerpt.localeCompare(b.excerpt)
  );
}

function buildFindingKey(finding) {
  const discriminator = finding.term ?? (finding.references ?? []).join(',');
  return `${finding.role}:${finding.line}:${finding.clauseIndex ?? 0}:${finding.occurrence ?? 0}:${discriminator}:${sha256(finding.excerpt).slice(0, 16)}`;
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
  const legacyVocabularyFindings = collectLegacyVocabularyFindings(roleEntries);

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
      policy: buildLegacyVocabularyPolicyAudit(),
      patterns: LEGACY_PATTERNS.map(pattern => pattern.term),
      findings: legacyVocabularyFindings,
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

function buildLegacyVocabularyPolicyAudit() {
  return {
    enforcedStatuses: [...LEGACY_VOCABULARY_ENFORCED_STATUSES],
    explicitContextMarkers: [...LEGACY_VOCABULARY_CONTEXT_MARKERS],
    rule: LEGACY_VOCABULARY_POLICY_RULE,
  };
}

function buildRoleMatrixAudit(roleEntries) {
  return {
    machineChecks: [...ROLE_MATRIX_MACHINE_CHECKS],
    reviewerAuditedFields: [...REVIEWER_AUDITED_ROLE_MATRIX_FIELDS],
    semanticBoundary: ROLE_MATRIX_SEMANTIC_BOUNDARY,
    commandsContract: { ...ROLE_MATRIX_COMMANDS_CONTRACT },
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
    `- Commands includes: ${audit.commandsContract.includes}`,
    `- Commands excludes: ${audit.commandsContract.excludes}`,
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
  for (const role of currentOutputs.keys()) {
    if (!baselineOutputs.has(role)) failures.push(`unregistered current agent_prompt output ${role}`);
  }
}

function verifyBaselineDriftProbes(current, failures) {
  const registryRole = current.registry.roles[0];
  const outputRole = current.agentPrompt.outputs[0];
  if (!registryRole || !outputRole) {
    failures.push('baseline drift probes require at least one registry role and agent_prompt output');
    return;
  }

  const cases = [
    {
      name: 'registry material hash drift',
      verifier: verifyRegistry,
      mutate(baseline) {
        baseline.registry.materialHash = 'sha256:baseline-drift-probe';
      },
      expected: ['registry materialHash'],
    },
    {
      name: 'template hash drift',
      verifier: verifyRegistry,
      mutate(baseline) {
        baseline.registry.roles[0].templateHash = 'sha256:template-drift-probe';
      },
      expected: [`registry ${registryRole.role}.templateHash`],
    },
    {
      name: 'missing registry role and count mismatch',
      verifier: verifyRegistry,
      mutate(baseline) {
        baseline.registry.roles = baseline.registry.roles.slice(1);
        baseline.registry.agentCount -= 1;
      },
      expected: ['baseline registry role count', `unregistered current role ${registryRole.role}`],
    },
    {
      name: 'extra registry role and count mismatch',
      verifier: verifyRegistry,
      mutate(baseline) {
        baseline.registry.roles.push({ ...baseline.registry.roles[0], role: 'probe-extra-role' });
        baseline.registry.agentCount += 1;
      },
      expected: ['baseline registry role count', 'missing current role probe-extra-role'],
    },
    {
      name: 'renamed registry role',
      verifier: verifyRegistry,
      mutate(baseline) {
        baseline.registry.roles[0].role = 'probe-renamed-role';
      },
      expected: [
        'missing current role probe-renamed-role',
        `unregistered current role ${registryRole.role}`,
      ],
    },
    {
      name: 'registry declared role-count mismatch',
      verifier: verifyRegistry,
      mutate(baseline) {
        baseline.registry.agentCount -= 1;
      },
      expected: ['baseline registry role count'],
    },
    {
      name: 'agent_prompt stdout hash drift',
      verifier: verifyAgentPromptOutputs,
      mutate(baseline) {
        baseline.agentPrompt.outputs[0].sha256 = 'sha256:stdout-drift-probe';
      },
      expected: [`agent_prompt ${outputRole.role}.sha256`],
    },
    {
      name: 'agent_prompt stdout byte drift',
      verifier: verifyAgentPromptOutputs,
      mutate(baseline) {
        baseline.agentPrompt.outputs[0].bytes += 1;
      },
      expected: [`agent_prompt ${outputRole.role}.bytes`],
    },
    {
      name: 'agent_prompt role-output drift',
      verifier: verifyAgentPromptOutputs,
      mutate(baseline) {
        baseline.agentPrompt.outputs[0].role = 'probe-renamed-output-role';
      },
      expected: [
        'missing agent_prompt output for probe-renamed-output-role',
        `unregistered current agent_prompt output ${outputRole.role}`,
      ],
    },
    {
      name: 'duplicate agent_prompt output ownership',
      verifier: verifyAgentPromptOutputs,
      mutate(baseline) {
        baseline.agentPrompt.outputs[1].role = baseline.agentPrompt.outputs[0].role;
      },
      expected: [
        `duplicate baseline agent_prompt output: ${outputRole.role}`,
        'baseline agent_prompt role count',
      ],
    },
  ];

  for (const probe of cases) {
    const mutatedBaseline = structuredClone(current);
    probe.mutate(mutatedBaseline);
    const mutationFailures = [];
    probe.verifier(current, mutatedBaseline, mutationFailures);
    if (mutationFailures.length === 0) {
      failures.push(`baseline drift probe ${probe.name}: mutation was accepted`);
      continue;
    }
    for (const fragment of probe.expected) {
      if (!mutationFailures.some(failure => failure.includes(fragment))) {
        failures.push(
          `baseline drift probe ${probe.name}: expected rejection containing ${JSON.stringify(fragment)}, got ${JSON.stringify(mutationFailures)}`,
        );
      }
    }
  }
}

function verifyAgentPromptCommandProbes(failures) {
  const unknownRole = 'probe-unknown-role';
  try {
    runAgentPrompt(unknownRole);
    failures.push('agent_prompt unknown-role command probe: command unexpectedly succeeded');
  } catch (error) {
    const output = [
      error instanceof Error ? error.message : String(error),
      error && typeof error === 'object' && 'stdout' in error
        ? Buffer.from(error.stdout ?? '').toString('utf8')
        : '',
      error && typeof error === 'object' && 'stderr' in error
        ? Buffer.from(error.stderr ?? '').toString('utf8')
        : '',
    ].join('\n');
    if (!output.includes(`agent_prompt: unknown role "${unknownRole}"`)) {
      failures.push(
        `agent_prompt unknown-role command probe: expected explicit unknown-role rejection, got ${JSON.stringify(output)}`,
      );
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
    audit.commandsContract?.includes,
    ROLE_MATRIX_COMMANDS_CONTRACT.includes,
    `${label}.commandsContract.includes`,
    failures,
  );
  requireEqual(
    audit.commandsContract?.excludes,
    ROLE_MATRIX_COMMANDS_CONTRACT.excludes,
    `${label}.commandsContract.excludes`,
    failures,
  );
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
    for (const field of [
      'clauseIndex',
      'occurrence',
      'matchedText',
      'clause',
      'roleStatus',
      'policyStatus',
      'policyReason',
    ]) {
      if (field in actual || field in expected) {
        requireEqual(actual[field], expected[field], `${label} ${key}.${field}`, failures);
      }
    }
  }

  for (const [key, expected] of baselineMap) {
    if (!currentMap.has(key)) {
      failures.push(`baseline ${label} no longer present: ${expected.role}:${expected.line} ${expected.excerpt}`);
    }
  }
}

function verifyLegacyVocabularyPolicy(current, baseline, failures) {
  const expectedPolicy = buildLegacyVocabularyPolicyAudit();
  requireSameContent(
    JSON.stringify(current.legacyVocabulary.policy, null, 2),
    JSON.stringify(expectedPolicy, null, 2),
    'current legacyVocabulary.policy',
    failures,
  );
  requireSameContent(
    JSON.stringify(baseline.legacyVocabulary.policy, null, 2),
    JSON.stringify(expectedPolicy, null, 2),
    'baseline legacyVocabulary.policy',
    failures,
  );
  for (const error of legacyVocabularyPolicyErrors(current.legacyVocabulary.findings)) {
    failures.push(`current legacy-vocabulary policy: ${error}`);
  }
  for (const error of legacyVocabularyPolicyErrors(baseline.legacyVocabulary.findings)) {
    failures.push(`baseline legacy-vocabulary policy: ${error}`);
  }
}

function verifyLegacyVocabularyPolicyProbes(failures) {
  for (const probe of LEGACY_VOCABULARY_POLICY_PROBES) {
    let rejection = '';
    try {
      collectLegacyVocabularyFindings([
        { role: probe.role, status: probe.status, content: probe.content },
      ]);
    } catch (error) {
      rejection = String(error instanceof Error ? error.message : error);
    }
    if (!rejection.includes(probe.expectedRejection)) {
      failures.push(
        `legacy vocabulary policy probe ${probe.name}: expected rejection containing ${JSON.stringify(probe.expectedRejection)}, got ${JSON.stringify(rejection)}`,
      );
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

  const missingRoleBaseline = structuredClone(current);
  const removedRole = missingRoleBaseline.roleMatrix.shift()?.role;
  if (!removedRole) {
    failures.push('role matrix snapshot drift probe: no role available for removal');
    return;
  }
  const missingRoleFailures = [];
  verifyMatrix(current, missingRoleBaseline, missingRoleFailures);
  if (!missingRoleFailures.some(failure => failure.includes('baseline matrix role count'))) {
    failures.push(
      `role matrix snapshot drift probe: role-count drift was not rejected; got ${JSON.stringify(missingRoleFailures)}`,
    );
  }
  if (!missingRoleFailures.some(failure => failure.includes(`baseline matrix missing role ${removedRole}`))) {
    failures.push(
      `role matrix snapshot drift probe: missing-row drift was not rejected; got ${JSON.stringify(missingRoleFailures)}`,
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
    `PASS direct story-file classifier adversarial probes: ${DIRECT_STORY_CLASSIFIER_PROBES.length} classifier cases, ${DIRECT_STORY_SCANNER_PROBES.length} scanner cases`,
  );
}

function runLegacyVocabularyPolicyProbeCommand() {
  const failures = [];
  verifyLegacyVocabularyPolicyProbes(failures);
  if (failures.length > 0) {
    console.error('FAIL active-role legacy-vocabulary policy probes');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log(
    `PASS active-role legacy-vocabulary policy probes: ${LEGACY_VOCABULARY_POLICY_PROBES.length} uncontextualized instruction rejected`,
  );
}

async function runBaselineDriftProbeCommand() {
  const current = await collectCurrentBaseline();
  const failures = [];
  verifyBaselineDriftProbes(current, failures);
  verifyAgentPromptCommandProbes(failures);
  if (failures.length > 0) {
    console.error('FAIL baseline mechanical drift probes');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log(
    'PASS baseline mechanical drift probes: 10 registry/template/role-count/role-identity/agent_prompt snapshot mutations plus unknown-role command rejected',
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
  console.log('PASS role matrix mechanical snapshot-drift probe: field, Markdown parity, role-count, and missing-row drift rejected');
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
  verifyBaselineDriftProbes(current, failures);
  verifyAgentPromptCommandProbes(failures);
  verifyMatrix(current, baseline, failures);
  verifyRoleMatrixAudit(current, baseline, failures);
  verifyRoleMatrixSnapshotDriftProbe(current, failures);
  verifyFindings(
    current.legacyVocabulary.findings,
    baseline.legacyVocabulary.findings,
    'legacy vocabulary finding',
    failures,
  );
  verifyLegacyVocabularyPolicy(current, baseline, failures);
  verifyLegacyVocabularyPolicyProbes(failures);
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
  console.log('PASS proof-or-stop prompt baseline: 10 baseline mechanical drift mutations and unknown-role agent_prompt command rejected');
  console.log('PASS proof-or-stop prompt baseline: role matrix snapshot integrity verified for 16 roles');
  console.log('PASS proof-or-stop prompt baseline: role matrix field/Markdown/role-count/missing-row drift rejected');
  console.log('INFO proof-or-stop prompt baseline: all human-authored role-matrix semantics remain reviewer-audited');
  console.log('PASS proof-or-stop prompt baseline: legacy vocabulary findings classified and active-role policy enforced');
  console.log('PASS proof-or-stop prompt baseline: direct story-file findings classified');
  console.log('PASS proof-or-stop prompt baseline: direct story-write policy has 1 exact grandfathered write');
}

if (PROBE_DIRECT_STORY_CLASSIFIER) {
  runDirectStoryClassifierProbeCommand();
} else if (PROBE_LEGACY_VOCABULARY_POLICY) {
  runLegacyVocabularyPolicyProbeCommand();
} else if (PROBE_BASELINE_DRIFT) {
  await runBaselineDriftProbeCommand();
} else if (PROBE_ROLE_MATRIX_SNAPSHOT_DRIFT) {
  await runRoleMatrixSnapshotDriftProbeCommand();
} else if (WRITE_MODE) {
  await writeBaselineFiles();
} else {
  await verifyBaseline();
}
