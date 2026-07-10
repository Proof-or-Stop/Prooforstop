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
const SCHEMA_VERSION = 'proof-or-stop.prompt-baseline.v1';
const PLAN_PATH = 'docs/requirements/decisions/proof-or-stop-agent-prompt-consolidation-execution-plan.md';
const WRITE_MODE = process.argv.includes('--write');
const PROBE_DIRECT_STORY_CLASSIFIER = process.argv.includes('--probe-direct-story-classifier');
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

// This is source evidence, not a second semantic truth table: every snippet
// must exist verbatim in the canonical prompt body for the role and backs the
// corresponding matrix field above.
const ROLE_MATRIX_SOURCE_EVIDENCE = {
  'implementation-reviewer': {
    commands: ['- Not modifying code, not modifying tests, not advancing the phase'],
    directFileAccess: ['- Relevant implementation files'],
    outputs: ['Conclusion: pass / fail'],
  },
  'lattice-evaluator-cli': {
    commands: [
      'Use the Bash tool with curl to call these APIs.',
      'If the project has a CLI shell, also test it by spawning the process:',
    ],
    directFileAccess: ['Your job is NOT to read code'],
    outputs: ['You MUST output the following JSON (wrapped in ```json):'],
  },
  'lattice-evaluator': {
    commands: ["Use the Bash tool's curl to call these APIs."],
    directFileAccess: ['- You only evaluate user experience, not code'],
    outputs: ['You must output the following JSON (wrapped in ```json):'],
  },
  'lattice-implementer': {
    commands: [
      'Whitelist of allowed Lattice commands:',
      '`lattice checklist_update` (can only modify status / startTime / endTime)',
    ],
    directFileAccess: ['all story changes go through the Lattice CLI'],
    outputs: ['Once all pending items are processed, return a brief summary and **stop**'],
  },
  'lattice-review-behavior': {
    commands: [
      'lattice checklist_get \'{"storyId":"B-xxx"}\'',
      'lattice finding_add \'{"storyId":"B-xxx","reviewRunId":"<reviewRunId from review_run_start>"',
    ],
    directFileAccess: [
      'Find the corresponding code change in `git diff main...HEAD`',
      'Default inputs: the `lattice scope_check_save` result recorded by lattice-review-scope-plan',
    ],
    outputs: ['Every finding must be registered via `lattice finding_add`'],
  },
  'lattice-review-channel': {
    commands: [
      'lattice checklist_get \'{"storyId":"B-xxx"}\'',
      'lattice story_get \'{"storyId":"B-xxx"}\'',
      'lattice review_pass_set \'{"storyId":"B-xxx","reviewRunId":"<reviewRunId from review_run_start>"',
    ],
    directFileAccess: ['grep \'"type":"dispatch"\' docs/story/actives/B-xxx/process-events.jsonl'],
    outputs: ['Normal channel + all CHKs have dispatch evidence'],
  },
  'lattice-review-concept': {
    commands: [
      '`git diff main...HEAD --stat`',
      'lattice finding_add \'{"storyId":"B-xxx","reviewRunId":"<reviewRunId from review_run_start>"',
    ],
    directFileAccess: ['grep the entire repository'],
    outputs: ['concept-cleanup: concept X deletion incomplete'],
  },
  'lattice-review-delivery': {
    commands: ['lattice delivery_check_set \'{"storyId":"B-xxx"'],
    directFileAccess: [
      '`git diff main...HEAD` output (you run this yourself)',
      'Files in the repository reachable via Read/Grep/Glob',
    ],
    outputs: ['Your output is a structured `delivery_check_set` call that writes a signed `delivery-check.json`.'],
  },
  'lattice-review-docs': {
    commands: [
      'register a finding with `lattice finding_add`',
      'you must call `lattice review_pass_set',
    ],
    directFileAccess: ['`git diff main...HEAD`'],
    outputs: ['After the review ends, if inconsistencies are found, confirm that all issues have been registered via `lattice finding_add`'],
  },
  'lattice-review-quality': {
    commands: [
      '`review_pass_set`. Pass-only `finding_add` is a misuse.',
      'lattice finding_add \'{"storyId":"B-xxx","reviewRunId":"<reviewRunId from review_run_start>"',
    ],
    directFileAccess: ['`git diff main...HEAD --name-only`'],
    outputs: ['After the review ends, confirm that all discovered issues have been registered via `lattice finding_add`'],
  },
  'lattice-review-scope-plan': {
    commands: [
      'lattice config',
      'lattice scope_check_save',
    ],
    directFileAccess: ['Glob pattern: docs/requirements/decisions/*.md'],
    outputs: ['You must call `lattice scope_check_save` to persist the result'],
  },
  'lattice-review-story-init': {
    commands: ['lattice init_check_set'],
    directFileAccess: [
      '`docs/story/actives/<storyId>/background.md` (full text)',
      'echo \'{"question":"Did you read CLAUDE.md?',
    ],
    outputs: ['The output must call `lattice init_check_set`; text-only output without the save call is incomplete'],
  },
  'lattice-review-test-coverage': {
    commands: [
      'lattice story_get \'{"storyId":"<ID>","detail":true}\'',
      'lattice validate \'{"story":"<ID>","json":true}\'',
      'lattice finding_add \'{"storyId":"<ID>","reviewRunId":"<reviewRunId from review_run_start>"',
    ],
    directFileAccess: ['lattice checklist_get \'{"storyId":"<ID>"}\''],
    outputs: ['Coverage summary: total intent count, must-gap count, waiver count.'],
  },
  'product-reviewer': {
    commands: ['lattice init_check_set \'{"storyId":"<STORY_ID>","issues":[...],"agentId":"product-reviewer"}\''],
    directFileAccess: ['If available, `docs/story/actives/<storyId>/evidence/transcript-diff.md`'],
    outputs: ['Conclusion: pass / fail'],
  },
  'test-case-reviewer': {
    commands: [
      'lattice testintent_check \'{"storyId":"<STORY_ID>"}\'',
      'lattice testintent_record \'{"storyId":"<STORY_ID>"',
    ],
    directFileAccess: ['read fixture JSON files directly'],
    outputs: ['Review summary: X passed / Y failed / Z total'],
  },
  'test-intent': {
    commands: [
      'lattice story_get \'{"storyId":"<ID>"}\'',
      'lattice checklist_update \'{"storyId":"<ID>","itemId":"<ITEM_ID>","testIntent":null,"agent":"test-intent"}\'',
    ],
    directFileAccess: ['- **Do not directly edit** JSON files'],
    outputs: ['how many testIntent entries you wrote for each item'],
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
    const snippets = evidence[field];
    if (!Array.isArray(snippets) || snippets.length === 0) {
      throw new Error(`missing source evidence for ${entry.role}.${field}`);
    }
    return {
      field,
      value: row[field],
      snippets: snippets.map(snippet => locatePromptSnippet(entry, field, snippet)),
    };
  });

  return {
    role: entry.role,
    relPath: entry.relPath,
    fields,
  };
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
  const currentRows = mapBy(current.roleMatrix, row => row.role, 'current matrix role for source evidence', failures);
  const baselineRows = mapBy(baseline.roleMatrix, row => row.role, 'baseline matrix role for source evidence', failures);
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
      compareEvidenceSnippets(actual.snippets ?? [], expected.snippets ?? [], `roleMatrixEvidence ${role}.${field}`, failures);
    }
  }

  for (const role of baselineEvidence.keys()) {
    if (!currentEvidence.has(role)) failures.push(`current matrix source evidence missing role ${role}`);
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
  console.log('PASS proof-or-stop prompt baseline: role matrix source evidence verified for 16 roles');
  console.log('PASS proof-or-stop prompt baseline: legacy vocabulary findings classified');
  console.log('PASS proof-or-stop prompt baseline: direct story-file findings classified');
}

if (PROBE_DIRECT_STORY_CLASSIFIER) {
  runDirectStoryClassifierProbeCommand();
} else if (WRITE_MODE) {
  await writeBaselineFiles();
} else {
  await verifyBaseline();
}
