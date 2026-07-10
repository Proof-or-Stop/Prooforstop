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
const SCHEMA_VERSION = 'proof-or-stop.prompt-baseline.v2';
const PLAN_PATH = 'docs/requirements/decisions/proof-or-stop-agent-prompt-consolidation-execution-plan.md';
const WRITE_MODE = process.argv.includes('--write');
const PROBE_DIRECT_STORY_CLASSIFIER = process.argv.includes('--probe-direct-story-classifier');
const PROBE_ROLE_MATRIX_EVIDENCE = process.argv.includes('--probe-role-matrix-evidence');
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
const SOURCE_BACKED_ROLE_MATRIX_FIELDS = ['commands', 'directFileAccess', 'outputs'];

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
    commands: 'checklist_get; review_run_start; finding_add; review_pass_set.',
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
    commands: 'delivery_check_set.',
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

// This is a grounded claim ledger, not an independent role-ownership table.
// Every claim must exactly cover text in ROLE_MATRIX_DEFAULTS and every support
// snippet must exist verbatim in that role's canonical prompt body.
const ROLE_MATRIX_SOURCE_EVIDENCE = {
  'implementation-reviewer': {
    commands: [
      {
        claim: 'none',
        snippets: ['- Not modifying code, not modifying tests, not advancing the phase'],
      },
    ],
    directFileAccess: [
      {
        claim: 'Reads diff and implementation context; no direct story writes.',
        snippets: [
          '- The current checklist / target behavior',
          '- Relevant implementation files',
          '- Not modifying code, not modifying tests, not advancing the phase',
        ],
      },
    ],
    outputs: [
      {
        claim: 'Text review notes.',
        snippets: ['Return concisely:', 'Conclusion: pass / fail'],
      },
    ],
  },
  'lattice-evaluator-cli': {
    commands: [
      {
        claim: 'bridge state/reset/events/event/replay API via curl',
        snippets: [
          'curl {serveUrl}/bridge/state',
          'curl {serveUrl}/bridge/events',
          'curl -X POST {serveUrl}/bridge/event',
          'curl -X POST {serveUrl}/bridge/replay',
          'curl -X POST {serveUrl}/bridge/reset',
          'Use the Bash tool with curl to call these APIs.',
        ],
      },
      {
        claim: 'optional CLI shell spawn.',
        snippets: ['If the project has a CLI shell, also test it by spawning the process:'],
      },
    ],
    directFileAccess: [
      {
        claim: 'Uses CLI shell/bridge output; no direct story writes.',
        snippets: [
          'tools: Read, Bash',
          'Your job is NOT to read code — it is to **use the application** like a user would, through the bridge API and optionally through the CLI shell.',
        ],
      },
    ],
    outputs: [
      {
        claim: 'Evaluator JSON transcript.',
        snippets: ['You MUST output the following JSON (wrapped in ```json):'],
      },
    ],
  },
  'lattice-evaluator': {
    commands: [
      {
        claim: 'browser status/eval/click/type/console/refresh API via curl.',
        snippets: [
          'GET `{serveUrl}/browser/status`',
          'POST `{serveUrl}/browser/eval`',
          'POST `{serveUrl}/browser/click`',
          'POST `{serveUrl}/browser/type`',
          'GET `{serveUrl}/browser/console`',
          'curl -X POST {serveUrl}/browser/refresh',
          "Use the Bash tool's curl to call these APIs.",
        ],
      },
    ],
    directFileAccess: [
      {
        claim: 'Evaluates through browser API only; does not read source code or write story metadata.',
        snippets: [
          'Your job is not to look at code, but to use the application like a user.',
          "Use the Bash tool's curl to call these APIs.",
          '- Story operations must use Lattice CLI commands. Do not directly read or write',
          '  story metadata under `docs/story/`, and do not write fixtures directly under',
        ],
      },
    ],
    outputs: [
      {
        claim: 'Evaluator JSON scores, itemResults, pass flag, and findings text.',
        snippets: [
          'You must output the following JSON (wrapped in ```json):',
          '"scores": { "functionality": 4, "usability": 4 }',
          '"pass": true',
          '"itemResults": [',
          '"findings": [',
        ],
      },
    ],
  },
  'lattice-implementer': {
    commands: [
      {
        claim: 'checklist_update',
        snippets: ['`lattice checklist_update` (can only modify status / startTime / endTime)'],
      },
      {
        claim: 'validate',
        snippets: ['`lattice validate` (local validation)'],
      },
      {
        claim: 'status',
        snippets: ['`lattice status` / `lattice checklist_get` / `lattice story_get` (read-only queries)'],
      },
      {
        claim: 'checklist_get',
        snippets: ['`lattice status` / `lattice checklist_get` / `lattice story_get` (read-only queries)'],
      },
      {
        claim: 'story_get',
        snippets: ['`lattice status` / `lattice checklist_get` / `lattice story_get` (read-only queries)'],
      },
      {
        claim: 'aux_doc_list',
        snippets: ['`lattice aux_doc_list` / `lattice aux_scan` / `lattice aux_detail` (read-only queries)'],
      },
      {
        claim: 'aux_scan',
        snippets: ['`lattice aux_doc_list` / `lattice aux_scan` / `lattice aux_detail` (read-only queries)'],
      },
      {
        claim: 'aux_detail.',
        snippets: ['`lattice aux_doc_list` / `lattice aux_scan` / `lattice aux_detail` (read-only queries)'],
      },
    ],
    directFileAccess: [
      {
        claim: 'Reads and edits source/docs in workspace; story metadata through Lattice CLI only.',
        snippets: [
          '- Write code / modify fixtures / run necessary local checks (lint, build, unit tests)',
          '- ❌ Directly Read/Edit JSON files under `docs/story/`: all story changes go through the Lattice CLI',
        ],
      },
    ],
    outputs: [
      {
        claim: 'Code changes, commits, checklist status updates, and brief return summary.',
        snippets: [
          '- Write code / modify fixtures / run necessary local checks (lint, build, unit tests)',
          '- After completion, call `lattice checklist_update',
          '- Once all pending items are processed, return a brief summary and **stop**',
          '- **commit as soon as you finish writing**:',
        ],
      },
    ],
  },
  'lattice-review-behavior': {
    commands: [
      {
        claim: 'checklist_get',
        snippets: ['`lattice checklist_get \'{"storyId":"B-xxx"}\'` to retrieve all items'],
      },
      {
        claim: 'review_run_start',
        snippets: ['first call `lattice review_run_start {"storyId":"B-xxx","agent":"<reviewer-name>"}`'],
      },
      {
        claim: 'finding_add',
        snippets: ['**Every finding must be registered via `lattice finding_add`'],
      },
      {
        claim: 'review_pass_set.',
        snippets: ['you must call `lattice review_pass_set` to record the scope this reviewer has checked'],
      },
    ],
    directFileAccess: [
      {
        claim: 'Reads git diff, checklist userSees, source files, candidate docs, and scope-plan artifacts; no direct story writes.',
        snippets: [
          'Find the corresponding code change in `git diff main...HEAD`',
          'Read the userSees field (what the user should see)',
          'Default inputs: the `lattice scope_check_save` result recorded by lattice-review-scope-plan',
          '**candidateSpecSet docs under `<requirementsDir>/decisions/`**',
          '- Only raise findings; do not modify code',
          '- Story operations must use Lattice CLI commands. Do not directly read or write',
        ],
      },
    ],
    outputs: [
      {
        claim: 'Reviewer findings or pass.',
        snippets: [
          '**Every finding must be registered via `lattice finding_add`',
          'When there are no findings, it is forbidden to use `finding_add` to fake a pass; you must call `lattice review_pass_set`',
        ],
      },
    ],
  },
  'lattice-review-channel': {
    commands: [
      {
        claim: 'checklist_get',
        snippets: ['lattice checklist_get \'{"storyId":"B-xxx"}\''],
      },
      {
        claim: 'story_get',
        snippets: ['lattice story_get \'{"storyId":"B-xxx"}\''],
      },
      {
        claim: 'grep process-events',
        snippets: ['grep \'"type":"dispatch"\' docs/story/actives/B-xxx/process-events.jsonl'],
      },
      {
        claim: 'review_run_start',
        snippets: ['`lattice review_run_start {"storyId":"B-xxx","agent":"<reviewer-name>"}`'],
      },
      {
        claim: 'finding_add',
        snippets: ['lattice finding_add \'{"storyId":"B-xxx","reviewRunId":"<reviewRunId from review_run_start>"'],
      },
      {
        claim: 'review_pass_set.',
        snippets: ['lattice review_pass_set \'{"storyId":"B-xxx","reviewRunId":"<reviewRunId from review_run_start>"'],
      },
    ],
    directFileAccess: [
      {
        claim: 'Legacy direct read of docs/story process-events evidence.',
        snippets: [
          'The truly reliable evidence source is the `dispatch` / `subagent_result` events in **`docs/story/actives/<storyId>/process-events.jsonl`**',
          'grep \'"type":"dispatch"\' docs/story/actives/B-xxx/process-events.jsonl',
          'The full text of `docs/story/actives/<storyId>/process-events.jsonl` (dispatch evidence source)',
        ],
      },
    ],
    outputs: [
      {
        claim: 'Reviewer findings or pass.',
        snippets: [
          '# Normal channel + all CHKs have dispatch evidence',
          '# Normal channel + some CHKs missing dispatch',
          'lattice review_pass_set \'{"storyId":"B-xxx"',
          'lattice finding_add \'{"storyId":"B-xxx"',
        ],
      },
    ],
  },
  'lattice-review-concept': {
    commands: [
      {
        claim: 'git diff',
        snippets: ['`git diff main...HEAD --stat` to see which files changed'],
      },
      {
        claim: 'grep',
        snippets: ['For each identified concept word, grep the entire repository'],
      },
      {
        claim: 'review_run_start',
        snippets: ['first call `lattice review_run_start {"storyId":"B-xxx","agent":"<reviewer-name>"}`'],
      },
      {
        claim: 'finding_add',
        snippets: ['lattice finding_add \'{"storyId":"B-xxx","reviewRunId":"<reviewRunId from review_run_start>"'],
      },
      {
        claim: 'review_pass_set.',
        snippets: ['call `lattice review_pass_set \'{"storyId":"B-xxx"'],
      },
    ],
    directFileAccess: [
      {
        claim: 'Reads diff/source/docs references; reviewer evidence through Lattice CLI.',
        snippets: [
          '`git diff main...HEAD` to see specific changes',
          'grep the entire repository (excluding node_modules / dist / .git)',
          '- Only grep, do not modify code',
          'Every finding must be registered via `lattice finding_add`',
        ],
      },
    ],
    outputs: [
      {
        claim: 'Reviewer findings or pass.',
        snippets: [
          'grep result > 0 → file a finding:',
          'No concept deletion/replacement → forbidden to use `finding_add` to record pass-only; call `lattice review_pass_set',
        ],
      },
    ],
  },
  'lattice-review-delivery': {
    commands: [
      {
        claim: 'delivery_check_set.',
        snippets: ['lattice delivery_check_set \'{"storyId":"B-xxx"'],
      },
    ],
    directFileAccess: [
      {
        claim: 'Reads git diff and repository files; explicitly avoids process-events, reviewer outputs, and test-evidence contents.',
        snippets: [
          '`git diff main...HEAD` output (you run this yourself)',
          'Files in the repository reachable via Read/Grep/Glob',
          '`story.events` / `process-events.jsonl`',
          'Other reviewer findings or results',
          '`test-evidence.json` contents',
        ],
      },
    ],
    outputs: [
      {
        claim: 'Signed delivery-check.json via delivery_check_set, or refusal text.',
        snippets: [
          'Your output is a structured `delivery_check_set` call that writes a signed `delivery-check.json`.',
          'Refusing to call delivery_check_set: <reason>. Main agent must fix delivery gaps and re-spawn this reviewer.',
        ],
      },
    ],
  },
  'lattice-review-docs': {
    commands: [
      {
        claim: 'git diff',
        snippets: ['git diff main...HEAD \\'],
      },
      {
        claim: 'grep',
        snippets: ['grep -rn --include=\'README*.md\' --include=\'CLAUDE.md\' --include=\'docs/**/*.md\''],
      },
      {
        claim: 'review_run_start',
        snippets: ['`lattice review_run_start {"storyId":"B-xxx","agent":"<reviewer-name>"}`'],
      },
      {
        claim: 'finding_add',
        snippets: ['register a finding with `lattice finding_add`'],
      },
      {
        claim: 'review_pass_set.',
        snippets: ['you must call `lattice review_pass_set'],
      },
    ],
    directFileAccess: [
      {
        claim: 'Reads changed docs/source; reviewer evidence through Lattice CLI.',
        snippets: [
          'check whether the docs (README*.md / CLAUDE.md / docs/\\*\\*/\\*.md) and the code (exported symbols changed in git diff main...HEAD) are consistent.',
          'Read the paragraphs collected in Step 2 + the new definitions of the corresponding symbols in the diff',
          '- Only read files for comparison; do not modify any files',
          'Every finding must be registered with `lattice finding_add`',
          'you must call `lattice review_pass_set',
        ],
      },
    ],
    outputs: [
      {
        claim: 'Reviewer findings or pass.',
        snippets: [
          'After the review ends, if inconsistencies are found, confirm that all issues have been registered via `lattice finding_add`',
          'When there are no inconsistencies, it is forbidden to use the finding command to record pass-only',
        ],
      },
    ],
  },
  'lattice-review-quality': {
    commands: [
      {
        claim: 'git diff',
        snippets: ['`git diff main...HEAD --name-only` to get the list of changed files'],
      },
      {
        claim: 'review_run_start',
        snippets: ['first call `lattice review_run_start {"storyId":"B-xxx","agent":"<reviewer-name>"}`'],
      },
      {
        claim: 'finding_add',
        snippets: ['lattice finding_add \'{"storyId":"B-xxx","reviewRunId":"<reviewRunId from review_run_start>"'],
      },
      {
        claim: 'review_pass_set.',
        snippets: ['you must call `lattice review_pass_set` to record the scope this reviewer has checked'],
      },
    ],
    directFileAccess: [
      {
        claim: 'Reads source/tests/proof metadata; reviewer evidence through Lattice CLI.',
        snippets: [
          'Only review changed files (don\'t review unchanged ones)',
          '### 4. Proof Metadata Review Coverage (narrow correctness rule)',
          'Every finding must be registered via `lattice finding_add`',
          'you must call `lattice review_pass_set`',
        ],
      },
    ],
    outputs: [
      {
        claim: 'Reviewer findings or pass.',
        snippets: [
          'After the review ends, confirm that all discovered issues have been registered via `lattice finding_add`',
          'When there are no findings, do not use `finding_add` to fake a pass; you must call `lattice review_pass_set`',
        ],
      },
    ],
  },
  'lattice-review-scope-plan': {
    commands: [
      {
        claim: 'config',
        snippets: ['lattice config 2>/dev/null'],
      },
      {
        claim: 'dev_memory_preflight',
        snippets: ['`lattice dev_memory_preflight`'],
      },
      {
        claim: 'dev_memory_search',
        snippets: ['`lattice dev_memory_search --query="<story keywords>"`'],
      },
      {
        claim: 'aux_doc_list',
        snippets: ['`lattice aux_doc_list` output'],
      },
      {
        claim: 'story_get',
        snippets: ['lattice story_get \'{"storyId":"B-xxx"}\''],
      },
      {
        claim: 'checklist_get',
        snippets: ['lattice checklist_get \'{"storyId":"B-xxx"}\''],
      },
      {
        claim: 'scope_check_save.',
        snippets: ['lattice scope_check_save \'{"storyId":"B-xxx"'],
      },
    ],
    directFileAccess: [
      {
        claim: 'Reads candidate docs and CLI-provided story/checklist context; scope evidence through Lattice CLI.',
        snippets: [
          '**Build the candidateSpecSet** from ALL of these sources:',
          'lattice story_get \'{"storyId":"B-xxx"}\'',
          'lattice checklist_get \'{"storyId":"B-xxx"}\'',
          'lattice scope_check_save \'{"storyId":"B-xxx"',
        ],
      },
    ],
    outputs: [
      {
        claim: 'scope_check_save artifact.',
        snippets: ['You must call `lattice scope_check_save` to persist the result'],
      },
    ],
  },
  'lattice-review-story-init': {
    commands: [
      {
        claim: 'init_check_set.',
        snippets: ['lattice init_check_set \'{"storyId":"B-xxx"'],
      },
    ],
    directFileAccess: [
      {
        claim: 'Grandfathered direct docs/story reads and init-self-check file write wording.',
        snippets: [
          '`docs/story/actives/<storyId>/background.md` (full text)',
          '`docs/story/actives/<storyId>/index.json` — read only',
          '`docs/story/actives/<storyId>/checklist.json` — read only',
          'echo \'{"question":"Did you read CLAUDE.md?',
          'Then use the Edit tool to fill in the `answer` field completely',
        ],
      },
    ],
    outputs: [
      {
        claim: 'init_check_set issues/pass plus init-self-check audit file wording.',
        snippets: [
          'The output must call `lattice init_check_set`; text-only output without the save call is incomplete',
          'echo \'{"question":"Did you read CLAUDE.md?',
          'Then use the Edit tool to fill in the `answer` field completely',
        ],
      },
    ],
  },
  'lattice-review-test-coverage': {
    commands: [
      {
        claim: 'story_get',
        snippets: ['lattice story_get \'{"storyId":"<ID>","detail":true}\''],
      },
      {
        claim: 'checklist_get',
        snippets: ['lattice checklist_get \'{"storyId":"<ID>"}\''],
      },
      {
        claim: 'validate',
        snippets: ['lattice validate \'{"story":"<ID>","json":true}\''],
      },
      {
        claim: 'review_run_start',
        snippets: ['`lattice review_run_start {"storyId":"B-xxx","agent":"<reviewer-name>"}`'],
      },
      {
        claim: 'finding_add',
        snippets: ['write a finding with `lattice finding_add`'],
      },
      {
        claim: 'review_pass_set.',
        snippets: ['you must call `lattice review_pass_set'],
      },
    ],
    directFileAccess: [
      {
        claim: 'Reads checklist/evidence through Lattice CLI; reviewer evidence through Lattice CLI.',
        snippets: [
          'lattice story_get \'{"storyId":"<ID>","detail":true}\'',
          'lattice checklist_get \'{"storyId":"<ID>"}\'',
          'lattice validate \'{"story":"<ID>","json":true}\'',
          'write a finding with `lattice finding_add`',
          'you must call `lattice review_pass_set',
        ],
      },
    ],
    outputs: [
      {
        claim: 'Reviewer findings or pass.',
        snippets: [
          'List of finding ids that were written.',
          'If there are no findings, you must call `lattice review_pass_set',
        ],
      },
    ],
  },
  'product-reviewer': {
    commands: [
      {
        claim: 'init_check_set when asked to perform INIT compatibility review',
        snippets: [
          'If the main agent asks you to take on INIT review or to judge whether INIT can advance',
          'lattice init_check_set \'{"storyId":"<STORY_ID>","issues":[...],"agentId":"product-reviewer"}\'',
        ],
      },
      {
        claim: 'otherwise none.',
        snippets: [
          'If the main agent asks you to take on INIT review or to judge whether INIT can advance',
          'Return concisely:',
        ],
      },
    ],
    directFileAccess: [
      {
        claim: 'Reads transcript/product context and optional transcript diff; no code, test, or story metadata writes.',
        snippets: [
          '- `understanding.outcome`',
          '- `summary` / output from the `story_advance DONE` phase',
          '- If available, `docs/story/actives/<storyId>/evidence/transcript-diff.md`',
          '- Not modifying code, tests, or testIntent',
        ],
      },
    ],
    outputs: [
      {
        claim: 'Text product review or product-reviewer init_check_set record.',
        snippets: [
          'lattice init_check_set \'{"storyId":"<STORY_ID>","issues":[...],"agentId":"product-reviewer"}\'',
          'Conclusion: pass / fail',
        ],
      },
    ],
  },
  'test-case-reviewer': {
    commands: [
      {
        claim: 'checklist_get',
        snippets: ['lattice checklist_get \'{"storyId":"<STORY_ID>"}\''],
      },
      {
        claim: 'testintent_check',
        snippets: ['lattice testintent_check \'{"storyId":"<STORY_ID>"}\''],
      },
      {
        claim: 'testintent_record.',
        snippets: ['lattice testintent_record \'{"storyId":"<STORY_ID>"'],
      },
    ],
    directFileAccess: [
      {
        claim: 'Legacy direct fixture JSON reads; writes only through testintent_record.',
        snippets: [
          '**read fixture JSON files directly**',
          'For each testIntent, call the CLI to record the review result:',
          '- **Do not directly edit** JSON files; you must go through the Lattice CLI',
        ],
      },
    ],
    outputs: [
      {
        claim: 'testintent_record results and testintent_check status.',
        snippets: [
          'For each testIntent, call the CLI to record the review result:',
          'Final step: call testintent_check to get the status and guidance',
          'Review summary: X passed / Y failed / Z total',
        ],
      },
    ],
  },
  'test-intent': {
    commands: [
      {
        claim: 'story_get',
        snippets: ['lattice story_get \'{"storyId":"<ID>"}\''],
      },
      {
        claim: 'checklist_update.',
        snippets: ['lattice checklist_update \'{"storyId":"<ID>","itemId":"<ITEM_ID>","testIntent":null,"agent":"test-intent"}\''],
      },
    ],
    directFileAccess: [
      {
        claim: 'Reads story/checklist through Lattice CLI; writes legacy checklist updates through Lattice CLI.',
        snippets: [
          'Read the story description (`lattice story_get',
          'checklist contents (each item\'s `id`, `title`, `context`)',
          'lattice checklist_update \'{"storyId":"<ID>"',
          '- **Do not directly edit** JSON files — must go through the Lattice CLI',
        ],
      },
    ],
    outputs: [
      {
        claim: 'Legacy testIntent or null intent updates.',
        snippets: [
          'mark `testIntent: null` with a reason',
          'For testable items, write a three-column testIntent:',
          'how many testIntent entries you wrote for each item',
        ],
      },
    ],
  },
};

const ROLE_MATRIX_EVIDENCE_MUTATION_PROBES = [
  {
    name: 'refreshed baseline rejects unsupported behavior command',
    role: 'lattice-review-behavior',
    field: 'commands',
    injectedClaim: 'scope_check_save',
  },
];

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
    name: 'read-only story reference',
    role: 'lattice-review-story-init',
    excerpt: '`docs/story/actives/<storyId>/index.json` — read only the `title` field.',
    classification: 'read-only-reference',
    grandfathered: true,
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

function lineNumberAt(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
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

function classifyStoryFinding(role, excerpt) {
  const lower = excerpt.toLowerCase();
  if (isNegativeStoryPolicyReminder(lower)) {
    return {
      classification: 'policy-reminder',
      grandfathered: false,
      note: 'Prompt reminds agents not to bypass CLI-mediated story operations.',
    };
  }
  if (isDirectStoryWriteInstruction(excerpt)) {
    return {
      classification: 'direct-write',
      grandfathered: role === 'lattice-review-story-init',
      note: 'Registered direct story-file write instruction to replace with CLI-mediated writes in later milestones.',
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

function isNegativeStoryPolicyReminder(lower) {
  return (
    lower.includes('do not directly read or write') ||
    lower.includes('do not directly read/edit') ||
    lower.includes('must not directly read or write') ||
    lower.includes('must not directly read/edit') ||
    lower.includes('all story changes go through') ||
    (lower.includes('story metadata under') && lower.includes('do not write fixtures'))
  );
}

function isDirectStoryWriteInstruction(excerpt) {
  if (!/docs\/story/i.test(excerpt)) return false;
  return (
    /\bdirectly\s+read\/edit\b[\s\S]*docs\/story/i.test(excerpt) ||
    /\b(?:edit|write)\b[\s\S]*docs\/story/i.test(excerpt) ||
    /docs\/story[\s\S]*\b(?:edit|write)\b/i.test(excerpt) ||
    /\b(?:tee|sed\s+-i|perl\s+-i)\b[\s\S]*docs\/story/i.test(excerpt) ||
    /\b(?:echo|printf|cat)\b[\s\S]*(?:>|>>)\s*docs\/story/i.test(excerpt) ||
    /\b(?:echo|printf)\b[\s\S]*\|\s*tee\b[\s\S]*docs\/story/i.test(excerpt) ||
    /(?:^|\s)(?:>|>>)\s*docs\/story/i.test(excerpt)
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

function scanStoryFileReferences(roleEntries) {
  const findings = [];
  const storyPattern = /docs\/story(?:\/[^\s`'"<>)\]}]*)?/g;
  for (const entry of roleEntries) {
    const lines = entry.content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const excerpt = lines[index].trim();
      if (!excerpt) continue;
      const references = [...excerpt.matchAll(storyPattern)].map(match => match[0]);
      if (references.length === 0) continue;
      const classification = classifyStoryFinding(entry.role, excerpt);
      findings.push({
        id: sha256(`${entry.role}\0${index + 1}\0${references.join(',')}\0${excerpt}`).slice(0, 16),
        role: entry.role,
        line: index + 1,
        references: [...new Set(references)].sort(),
        excerpt,
        ...classification,
      });
    }
  }
  return findings.sort(compareFinding);
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
  const roleMatrixEvidence = roleEntries.map(entry => buildRoleMatrixEvidence(entry, roleMatrix));

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
    roleMatrixEvidence,
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
        'other',
      ],
      findings: scanStoryFileReferences(roleEntries),
    },
  };
}

function buildRoleMatrixEvidence(entry, roleMatrix) {
  const evidence = ROLE_MATRIX_SOURCE_EVIDENCE[entry.role];
  if (!evidence) throw new Error(`missing role matrix source evidence for role ${entry.role}`);
  const row = roleMatrix.find(candidate => candidate.role === entry.role);
  if (!row) throw new Error(`missing role matrix row for source evidence ${entry.role}`);

  const fields = SOURCE_BACKED_ROLE_MATRIX_FIELDS.map(field => {
    const sourceClaims = evidence[field];
    const claimFailures = [];
    verifyRoleMatrixClaimCoverage(
      entry.role,
      field,
      row[field],
      sourceClaims,
      `source claim ledger ${entry.role}.${field}`,
      claimFailures,
    );
    if (claimFailures.length > 0) {
      throw new Error(`invalid role matrix source evidence:\n- ${claimFailures.join('\n- ')}`);
    }

    const sourceClaimsByNormalized = new Map(
      sourceClaims.map(sourceClaim => [normalizeRoleMatrixClaim(sourceClaim.claim), sourceClaim]),
    );
    const orderedClaims = extractRoleMatrixClaimTexts(field, row[field]).map(rowClaim => {
      const sourceClaim = sourceClaimsByNormalized.get(normalizeRoleMatrixClaim(rowClaim));
      return {
        claim: sourceClaim.claim,
        normalizedClaim: normalizeRoleMatrixClaim(sourceClaim.claim),
        snippets: sourceClaim.snippets.map(snippet => locatePromptSnippet(entry, field, snippet)),
      };
    });

    return {
      field,
      value: row[field],
      claimMode: field === 'commands' ? 'semicolon-delimited' : 'whole-field',
      claims: orderedClaims,
    };
  });

  return {
    role: entry.role,
    relPath: entry.relPath,
    fields,
  };
}

function extractRoleMatrixClaimTexts(field, value) {
  if (typeof value !== 'string') return [];
  return (field === 'commands' ? value.split(';') : [value]).map(claim => claim.trim());
}

function normalizeRoleMatrixClaim(claim) {
  return String(claim)
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/, '')
    .toLowerCase();
}

function verifyRoleMatrixClaimCoverage(role, field, value, claimRecords, label, failures) {
  const rowClaims = extractRoleMatrixClaimTexts(field, value);
  if (rowClaims.length === 0 || rowClaims.some(claim => claim.length === 0)) {
    failures.push(`${label}: matrix field has an empty claim`);
    return;
  }
  if (!Array.isArray(claimRecords)) {
    failures.push(`${label}: claims must be an array`);
    return;
  }

  const rowClaimsByNormalized = new Map();
  for (const claim of rowClaims) {
    const normalized = normalizeRoleMatrixClaim(claim);
    if (!normalized) {
      failures.push(`${label}: matrix field has an empty normalized claim`);
      continue;
    }
    if (rowClaimsByNormalized.has(normalized)) {
      failures.push(`${label}: duplicate matrix claim ${JSON.stringify(normalized)}`);
      continue;
    }
    rowClaimsByNormalized.set(normalized, claim);
  }

  const evidenceClaimsByNormalized = new Map();
  for (let index = 0; index < claimRecords.length; index += 1) {
    const record = claimRecords[index];
    if (!record || typeof record.claim !== 'string' || record.claim.trim().length === 0) {
      failures.push(`${label}.claims[${index}]: missing or empty claim`);
      continue;
    }
    const normalized = normalizeRoleMatrixClaim(record.claim);
    if (evidenceClaimsByNormalized.has(normalized)) {
      failures.push(`${label}: duplicate evidence claim ${JSON.stringify(normalized)}`);
      continue;
    }
    evidenceClaimsByNormalized.set(normalized, record);

    if (!Array.isArray(record.snippets) || record.snippets.length === 0) {
      failures.push(`${label} claim ${JSON.stringify(record.claim)}: missing supporting snippets`);
      continue;
    }
    for (let snippetIndex = 0; snippetIndex < record.snippets.length; snippetIndex += 1) {
      const snippet = record.snippets[snippetIndex];
      const snippetText = typeof snippet === 'string' ? snippet : snippet?.text;
      if (typeof snippetText !== 'string' || snippetText.length === 0) {
        failures.push(
          `${label} claim ${JSON.stringify(record.claim)}.snippets[${snippetIndex}]: missing text`,
        );
      }
    }
  }

  for (const [normalized, claim] of rowClaimsByNormalized) {
    if (!evidenceClaimsByNormalized.has(normalized)) {
      failures.push(`${label}: missing source evidence mapping for claim ${JSON.stringify(claim)}`);
    }
  }
  for (const [normalized, record] of evidenceClaimsByNormalized) {
    if (!rowClaimsByNormalized.has(normalized)) {
      failures.push(`${label}: extra source evidence mapping for claim ${JSON.stringify(record.claim)}`);
    }
  }

  if (field !== 'commands') {
    requireEqual(claimRecords.length, 1, `${label}.whole-field claim count`, failures);
    if (claimRecords.length === 1) {
      requireEqual(claimRecords[0].claim, value, `${label}.whole-field exact claim`, failures);
    }
  }
}

function locatePromptSnippet(entry, field, snippet) {
  const index = entry.content.indexOf(snippet);
  if (index === -1) {
    throw new Error(`source evidence snippet not found for ${entry.role}.${field}: ${JSON.stringify(snippet)}`);
  }
  return {
    line: lineNumberAt(entry.content, index),
    sha256: sha256(snippet),
    text: snippet,
  };
}

function renderMatrixMarkdown(baseline) {
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

function verifyRoleMatrixSourceEvidence(current, baseline, failures) {
  const currentRows = mapBy(
    Array.isArray(current.roleMatrix) ? current.roleMatrix : [],
    row => row.role,
    'current matrix role for source evidence',
    failures,
  );
  const baselineRows = mapBy(
    Array.isArray(baseline.roleMatrix) ? baseline.roleMatrix : [],
    row => row.role,
    'baseline matrix role for source evidence',
    failures,
  );
  const currentEvidence = mapBy(
    Array.isArray(current.roleMatrixEvidence) ? current.roleMatrixEvidence : [],
    entry => entry.role,
    'current matrix source evidence',
    failures,
  );
  const baselineEvidence = mapBy(
    Array.isArray(baseline.roleMatrixEvidence) ? baseline.roleMatrixEvidence : [],
    entry => entry.role,
    'baseline matrix source evidence',
    failures,
  );

  requireEqual(currentEvidence.size, EXPECTED_ROLE_COUNT, 'current matrix source evidence role count', failures);
  requireEqual(baselineEvidence.size, EXPECTED_ROLE_COUNT, 'baseline matrix source evidence role count', failures);

  for (const [role, currentEntry] of currentEvidence) {
    const baselineEntry = baselineEvidence.get(role);
    const currentRow = currentRows.get(role);
    const baselineRow = baselineRows.get(role);
    if (!baselineEntry) {
      failures.push(`baseline matrix source evidence missing role ${role}`);
      continue;
    }
    if (!currentRow || !baselineRow) continue;
    requireEqual(currentEntry.relPath, baselineEntry.relPath, `roleMatrixEvidence ${role}.relPath`, failures);

    const currentFields = mapBy(currentEntry.fields ?? [], field => field.field, `current matrix source evidence field ${role}`, failures);
    const baselineFields = mapBy(baselineEntry.fields ?? [], field => field.field, `baseline matrix source evidence field ${role}`, failures);
    requireEqual(
      currentFields.size,
      SOURCE_BACKED_ROLE_MATRIX_FIELDS.length,
      `current roleMatrixEvidence ${role}.field count`,
      failures,
    );
    requireEqual(
      baselineFields.size,
      SOURCE_BACKED_ROLE_MATRIX_FIELDS.length,
      `baseline roleMatrixEvidence ${role}.field count`,
      failures,
    );
    for (const field of currentFields.keys()) {
      if (!SOURCE_BACKED_ROLE_MATRIX_FIELDS.includes(field)) {
        failures.push(`current roleMatrixEvidence ${role}: unknown field ${field}`);
      }
    }
    for (const field of baselineFields.keys()) {
      if (!SOURCE_BACKED_ROLE_MATRIX_FIELDS.includes(field)) {
        failures.push(`baseline roleMatrixEvidence ${role}: unknown field ${field}`);
      }
    }

    for (const field of SOURCE_BACKED_ROLE_MATRIX_FIELDS) {
      const actual = currentFields.get(field);
      const expected = baselineFields.get(field);
      if (!actual) {
        failures.push(`current matrix source evidence missing ${role}.${field}`);
        continue;
      }
      if (!expected) {
        failures.push(`baseline matrix source evidence missing ${role}.${field}`);
        continue;
      }
      requireEqual(actual.value, currentRow[field], `current roleMatrixEvidence ${role}.${field}.value`, failures);
      requireEqual(expected.value, baselineRow[field], `baseline roleMatrixEvidence ${role}.${field}.value`, failures);
      requireEqual(actual.value, expected.value, `roleMatrixEvidence ${role}.${field}.value`, failures);
      verifyPersistedRoleMatrixEvidenceField(
        role,
        field,
        currentRow[field],
        actual,
        `current roleMatrixEvidence ${role}.${field}`,
        failures,
      );
      verifyPersistedRoleMatrixEvidenceField(
        role,
        field,
        baselineRow[field],
        expected,
        `baseline roleMatrixEvidence ${role}.${field}`,
        failures,
      );
      compareEvidenceClaims(
        actual.claims ?? [],
        expected.claims ?? [],
        `roleMatrixEvidence ${role}.${field}`,
        failures,
      );
    }
  }

  for (const role of baselineEvidence.keys()) {
    if (!currentEvidence.has(role)) failures.push(`current matrix source evidence missing role ${role}`);
  }
}

function verifyPersistedRoleMatrixEvidenceField(role, field, value, evidenceField, label, failures) {
  const expectedClaimMode = field === 'commands' ? 'semicolon-delimited' : 'whole-field';
  requireEqual(evidenceField.claimMode, expectedClaimMode, `${label}.claimMode`, failures);
  verifyRoleMatrixClaimCoverage(
    role,
    field,
    value,
    evidenceField.claims,
    label,
    failures,
  );

  for (let index = 0; index < (evidenceField.claims ?? []).length; index += 1) {
    const claim = evidenceField.claims[index];
    if (!claim || typeof claim.claim !== 'string') continue;
    requireEqual(
      claim.normalizedClaim,
      normalizeRoleMatrixClaim(claim.claim),
      `${label}.claims[${index}].normalizedClaim`,
      failures,
    );
  }
}

function compareEvidenceClaims(actualClaims, expectedClaims, label, failures) {
  requireEqual(actualClaims.length, expectedClaims.length, `${label}.claim count`, failures);
  const max = Math.max(actualClaims.length, expectedClaims.length);
  for (let index = 0; index < max; index += 1) {
    const actual = actualClaims[index];
    const expected = expectedClaims[index];
    if (!actual || !expected) continue;
    requireEqual(actual.claim, expected.claim, `${label}.claims[${index}].claim`, failures);
    requireEqual(
      actual.normalizedClaim,
      expected.normalizedClaim,
      `${label}.claims[${index}].normalizedClaim`,
      failures,
    );
    compareEvidenceSnippets(
      actual.snippets ?? [],
      expected.snippets ?? [],
      `${label}.claims[${index}]`,
      failures,
    );
  }
}

function compareEvidenceSnippets(actualSnippets, expectedSnippets, label, failures) {
  requireEqual(actualSnippets.length, expectedSnippets.length, `${label}.snippet count`, failures);
  const max = Math.max(actualSnippets.length, expectedSnippets.length);
  for (let index = 0; index < max; index += 1) {
    const actual = actualSnippets[index];
    const expected = expectedSnippets[index];
    if (!actual || !expected) continue;
    requireEqual(actual.text, expected.text, `${label}.snippets[${index}].text`, failures);
    requireEqual(actual.sha256, expected.sha256, `${label}.snippets[${index}].sha256`, failures);
    requireEqual(actual.line, expected.line, `${label}.snippets[${index}].line`, failures);
    requireEqual(actual.sha256, sha256(actual.text), `${label}.snippets[${index}].computedSha256`, failures);
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

function verifyDirectStoryClassifierProbes(failures) {
  for (const probe of DIRECT_STORY_CLASSIFIER_PROBES) {
    const actual = classifyStoryFinding(probe.role, probe.excerpt);
    requireEqual(actual.classification, probe.classification, `direct story classifier probe ${probe.name}.classification`, failures);
    requireEqual(actual.grandfathered, probe.grandfathered, `direct story classifier probe ${probe.name}.grandfathered`, failures);
  }
}

function injectRoleMatrixCommandClaim(value, injectedClaim) {
  return `${value.replace(/[.!?]+$/, '')}; ${injectedClaim}.`;
}

function buildRefreshedRoleMatrixMutation(snapshot, probe) {
  const mutated = structuredClone(snapshot);
  const row = mutated.roleMatrix.find(candidate => candidate.role === probe.role);
  const evidenceEntry = mutated.roleMatrixEvidence.find(candidate => candidate.role === probe.role);
  const evidenceField = evidenceEntry?.fields?.find(candidate => candidate.field === probe.field);
  if (!row || !evidenceField) {
    throw new Error(`mutation probe ${probe.name}: missing ${probe.role}.${probe.field}`);
  }
  if (probe.field !== 'commands') {
    throw new Error(`mutation probe ${probe.name}: only command injection is supported`);
  }

  const mutatedValue = injectRoleMatrixCommandClaim(row[probe.field], probe.injectedClaim);
  row[probe.field] = mutatedValue;
  // Model a baseline refresh that updates generated value fields while leaving
  // the independently authored claim-to-snippet ledger unchanged.
  evidenceField.value = mutatedValue;
  return mutated;
}

function verifyRoleMatrixEvidenceMutationProbes(current, failures) {
  for (const probe of ROLE_MATRIX_EVIDENCE_MUTATION_PROBES) {
    let refreshed;
    try {
      refreshed = buildRefreshedRoleMatrixMutation(current, probe);
    } catch (error) {
      failures.push(String(error instanceof Error ? error.message : error));
      continue;
    }

    const mutationFailures = [];
    verifyRoleMatrixSourceEvidence(refreshed, structuredClone(refreshed), mutationFailures);
    const expectedFragment = `missing source evidence mapping for claim ${JSON.stringify(`${probe.injectedClaim}.`)}`;
    if (
      mutationFailures.length !== 2 ||
      mutationFailures.some(failure => !failure.includes(expectedFragment))
    ) {
      failures.push(
        `role matrix evidence mutation probe ${probe.name}: expected current/baseline claim-coverage rejection containing ${JSON.stringify(expectedFragment)}, got ${JSON.stringify(mutationFailures)}`,
      );
    }
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
  console.log(`PASS direct story-file classifier adversarial probes: ${DIRECT_STORY_CLASSIFIER_PROBES.length} cases`);
}

async function runRoleMatrixEvidenceMutationProbeCommand() {
  const current = await collectCurrentBaseline();
  const failures = [];
  verifyRoleMatrixEvidenceMutationProbes(current, failures);

  const { readPromptRegistry, readPromptTemplate } = await loadBuiltRegistry();
  const snapshot = readPromptRegistry();
  for (const probe of ROLE_MATRIX_EVIDENCE_MUTATION_PROBES) {
    const registryEntry = snapshot.agents.find(entry => entry.agentId === probe.role);
    if (!registryEntry) {
      failures.push(`role matrix evidence mutation probe ${probe.name}: registry role missing`);
      continue;
    }
    const mutatedMatrix = structuredClone(current.roleMatrix);
    const row = mutatedMatrix.find(candidate => candidate.role === probe.role);
    row[probe.field] = injectRoleMatrixCommandClaim(row[probe.field], probe.injectedClaim);

    let collectionFailure = '';
    try {
      buildRoleMatrixEvidence(
        {
          role: registryEntry.agentId,
          relPath: registryEntry.relPath,
          content: readPromptTemplate(registryEntry),
        },
        mutatedMatrix,
      );
    } catch (error) {
      collectionFailure = String(error instanceof Error ? error.message : error);
    }
    const expectedFragment = `missing source evidence mapping for claim ${JSON.stringify(`${probe.injectedClaim}.`)}`;
    if (!collectionFailure.includes(expectedFragment)) {
      failures.push(
        `role matrix evidence mutation probe ${probe.name}: --write collection did not reject unsupported claim with ${JSON.stringify(expectedFragment)}; got ${JSON.stringify(collectionFailure)}`,
      );
    }
  }

  if (failures.length > 0) {
    console.error('FAIL role matrix source-evidence mutation probes');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log(
    `PASS role matrix source-evidence mutation probes: ${ROLE_MATRIX_EVIDENCE_MUTATION_PROBES.length} refreshed-baseline injection rejected during collection and verification`,
  );
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
  verifyRoleMatrixSourceEvidence(current, baseline, failures);
  verifyRoleMatrixEvidenceMutationProbes(current, failures);
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
  verifyNoUnregisteredDirectStoryWrite(current, baseline, failures);
  verifyDirectStoryClassifierProbes(failures);

  if (failures.length > 0) {
    console.error('FAIL proof-or-stop prompt baseline');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log('PASS proof-or-stop prompt baseline: roleCount=16 registry hashes verified');
  console.log('PASS proof-or-stop prompt baseline: agent_prompt output hashes verified for 16 roles');
  console.log('PASS proof-or-stop prompt baseline: overlap matrix verified for 16 roles');
  console.log('PASS proof-or-stop prompt baseline: exhaustive role matrix source claims verified for 16 roles');
  console.log('PASS proof-or-stop prompt baseline: role matrix unsupported-claim mutation probe rejected');
  console.log('PASS proof-or-stop prompt baseline: legacy vocabulary findings classified');
  console.log('PASS proof-or-stop prompt baseline: direct story-file findings classified');
}

if (PROBE_DIRECT_STORY_CLASSIFIER) {
  runDirectStoryClassifierProbeCommand();
} else if (PROBE_ROLE_MATRIX_EVIDENCE) {
  await runRoleMatrixEvidenceMutationProbeCommand();
} else if (WRITE_MODE) {
  await writeBaselineFiles();
} else {
  await verifyBaseline();
}
