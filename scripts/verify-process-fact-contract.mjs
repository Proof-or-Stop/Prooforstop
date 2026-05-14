#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const failures = [];
const warnings = [];
const hanCharacterPattern = /[\u3400-\u9fff]/;
const codeLikeCommandNamePattern = /^[a-z][a-z0-9_.-]*(?::[a-z][a-z0-9_.-]*)*$/;

const promptDirs = [
  'packages/main/templates/agents',
  '.claude/agents',
  '.Codex/agents',
];

const currentCategories = new Set(['happy', 'edge', 'adversarial', 'missing']);
const legacyCategories = new Set(['cleanup', 'doc-promise-undelivered', 'doc-code-drift', 'spec-boundary']);
const reviewPassReviewerPrompts = new Set([
  'koala-evaluator.md',
  'koala-review-behavior.md',
  'koala-review-channel.md',
  'koala-review-concept.md',
  'koala-review-delivery.md',
  'koala-review-docs.md',
  'koala-review-quality.md',
  'koala-review-scope-plan.md',
  'koala-review-story-init.md',
  'koala-review-test-coverage.md',
]);
const requiredReviewerRunIdPromptFiles = new Set([
  'koala-evaluator.md',
  'koala-review-delivery.md',
  'koala-review-scope-plan.md',
  'koala-review-story-init.md',
]);
const processFactLevelRegistryPath = 'packages/main/src/core/process-fact-levels.ts';
const commandPolicyPath = 'packages/main/src/core/command-policy.ts';
const flowFactPolicyPath = 'packages/main/src/core/flow-fact-policy.ts';
const legacyTestFixtureCommands = [
  'test_auto',
  'test_story',
  'test_fixture',
  'fixture_batch_add',
  'fixture_update',
  'test_add',
  'task_coverage',
];
const activeLifecycleDocPaths = [
  'AGENTS.md',
  'docs/requirements/decisions/story-lifecycle.md',
  'docs/requirements/decisions/testing-infra.md',
];
const activeLifecycleDocCurrentTerms = [
  'verificationIntent',
  'verificationEvidence',
  'koala validate',
  'checklist_update',
];
const legacyCommandDocContextPattern = /\blegacy\b|\bcompat\b|\bmaintenance\b|兼容|维护|旧|迁移|背景|destructive/i;
const coverageReviewerLaneName = 'koala-review-test-coverage';
const coverageReviewerLaneContextPattern = /reviewer|agent|lane|review\s+lane|coverage\s+reviewer|审查员|审查\s*lane|审查\s*通道|覆盖审查/i;
const coverageReviewerCliCommandPatterns = [
  { label: 'CLI invocation', pattern: /\bkoala\s+koala-review-test-coverage\b/i },
  { label: 'tool table row', pattern: /^\s*\|\s*`?koala-review-test-coverage`?\s*\|/ },
  { label: 'tool bullet', pattern: /^\s*[-*]\s*`?koala-review-test-coverage`?\s*(?:[:：-]|$)/ },
];
const legacyTestAutoProcessFactClaimPatterns = [
  {
    label: 'auto bug management',
    pattern: /自动\s*bug\s*管理|fail\s*(?:创建|create[s]?)\s+bug|pass\s*(?:自动\s*)?(?:fix|fixed|修复|标记?|mark[s]?).{0,20}bug/i,
  },
  {
    label: 'test-evidence writes',
    pattern: /\btest_auto\b[^。.\n;；]{0,80}(?:写|write[s]?|record[s]?|生成|产出)[^。.\n;；]{0,40}(?:test-?evidence|test evidence|verificationEvidence|测试证据)|(?:test-?evidence|test evidence|verificationEvidence|测试证据)[^。.\n;；]{0,40}(?:由|by)\s*`?test_auto`?|^(?:\d+\.|-)\s*(?:写|write[s]?|record[s]?|生成|产出)[^。.\n;；]{0,40}(?:test-?evidence|test evidence|verificationEvidence|测试证据)/i,
  },
];
const legacyTestAutoNegatedProcessFactPattern = /(?:不会|不写|不再|不能|并不|does\s+not|doesn't|do\s+not|not|never|without|no\s+longer).{0,90}(?:bug|test-?evidence|test evidence|verificationEvidence|测试证据)/i;
const commandPolicyStatuses = new Set(['supported', 'rootOnly', 'legacy', 'retired', 'maintenance', 'gateEvidence']);
const processFactRegistryPath = 'packages/main/src/core/process-fact-registry.ts';
const processFactRegistryKinds = new Set([
  'command',
  'runtime-behavior',
  'gate-evidence',
  'execution-status',
  'validation-status',
  'review-run',
  'review-pass',
  'finding',
  'flow-policy',
  'reviewer-lane',
  'signed-artifact',
  'artifact',
]);
const requiredProcessFactSemantics = {
  validate: ['validation-status', 'validation-result', 'gate-evidence'],
  test_add: ['test-evidence', 'validation-result'],
  test_story: ['test-evidence', 'validation-result'],
  verification_evidence_add: ['execution-evidence', 'verification-evidence', 'gate-evidence'],
  verification_evidence_batch_add: ['execution-evidence', 'verification-evidence', 'gate-evidence'],
  verification_evidence_refresh_stale: ['execution-evidence', 'verification-evidence', 'gate-evidence'],
  review_run_start: ['review-run', 'schema-contract', 'gate-evidence'],
  review_pass_set: ['review-pass', 'no-blocker-evidence', 'gate-evidence'],
  finding_add: ['finding-state', 'blocker-state', 'gate-evidence'],
  finding_resolve: ['finding-state', 'blocker-state', 'gate-evidence'],
  finding_dismiss: ['finding-state', 'blocker-state', 'gate-evidence'],
};
const requiredReviewerLanes = [
  'koala-review-story-init',
  'product-reviewer',
  'koala-review-scope-plan',
  'koala-review-concept',
  'koala-review-quality',
  'koala-review-test-coverage',
  'koala-review-behavior',
  'koala-review-docs',
  'koala-review-channel',
  'koala-review-delivery',
];
const requiredArtifactFacts = [
  { name: 'artifact:index.json', path: 'index.json', signed: false },
  { name: 'artifact:review.json', path: 'review.json', signed: true, signaturePattern: /sha256\(storyId:timestamp:issueCount:blockerCount/ },
  { name: 'artifact:checklist.json', path: 'checklist.json', signed: false },
  { name: 'artifact:init-check.json', path: 'init-check.json', signed: true, signaturePattern: /signInitCheck\/recomputeInitCheckHash/ },
  { name: 'artifact:scope-check.json', path: 'scope-check.json', signed: true, signaturePattern: /signScopeCheck/ },
  { name: 'artifact:delivery-check.json', path: 'delivery-check.json', signed: true, signaturePattern: /signDeliveryCheck\/recomputeDeliveryCheckHash/ },
  { name: 'artifact:review-runs.json', path: 'review-runs.json', signed: true, signaturePattern: /signReviewRun\/verifyReviewRun/ },
  { name: 'artifact:findings.json', path: 'findings.json', signed: true, signaturePattern: /signFinding\/verifyFinding; reviewRunId-inclusive records do not fall back to legacy signatures/ },
  { name: 'artifact:review-passes.json', path: 'review-passes.json', signed: true, signaturePattern: /signReviewPass\/verifyReviewPass; reviewRunId-inclusive records do not fall back to legacy signatures/ },
  { name: 'artifact:draft-check.json', path: 'draft-check.json', signed: true, signaturePattern: /computeDraftCheckHash/ },
  { name: 'artifact:summary.json', path: 'summary.json', signed: false },
  { name: 'artifact:test-evidence.json', path: 'test-evidence.json', signed: false },
  { name: 'artifact:eval-evidence.json', path: 'eval-evidence.json', signed: false },
  { name: 'artifact:process-events.jsonl', path: 'process-events.jsonl', signed: false },
];
const legacyCommandPolicyGuidance = {
  test_auto: {
    destructiveRisk: 'workspace-destructive',
    patterns: [/koala validate --story=<storyId>/, /verificationEvidence/, /dryRun/, /confirm/, /git restore\/git clean/],
  },
  test_story: {
    destructiveRisk: 'fixture-write',
    patterns: [/koala validate --story=<storyId>/, /verification_evidence_add|verificationEvidence/],
  },
  test_fixture: {
    destructiveRisk: 'fixture-write',
    patterns: [/project-native command|koala validate --story=<storyId>/, /verification_evidence_add|verificationEvidence/],
  },
  fixture_batch_add: {
    destructiveRisk: 'fixture-write',
    patterns: [/dryRun/, /validateExecute|verification_evidence_add|verificationEvidence/],
  },
  fixture_update: {
    destructiveRisk: 'fixture-write',
    patterns: [/fixture_batch_add/, /dryRun/, /project-native tests|verification_evidence_add|verificationEvidence/],
  },
  test_add: {
    destructiveRisk: 'metadata-write',
    patterns: [/verification_evidence_add|verificationEvidence/, /checklist_update/],
  },
  task_coverage: {
    destructiveRisk: 'none',
    patterns: [/validate|process-fact/, /verificationEvidence/],
  },
};
const requiredRuntimeEntries = [
  {
    name: 'runtime:phase_tools_malformed_policy_ceiling',
    level: 'L1',
    owner: 'core/config',
    line: '- runtime:phase_tools_malformed_policy_ceiling [L1] owner=core/config',
  },
  {
    name: 'runtime:test_auto_recursive_skip',
    level: 'L2',
    owner: 'handlers/test-auto',
    line: '- runtime:test_auto_recursive_skip [L2] owner=handlers/test-auto',
  },
  {
    name: 'runtime:validate_fallback_discovery',
    level: 'L1',
    owner: 'handlers/verifier',
    line: '- runtime:validate_fallback_discovery [L1] owner=handlers/verifier',
  },
  {
    name: 'runtime:validate_side_effect_guard',
    level: 'L2',
    owner: 'core/validation-executor',
    line: '- runtime:validate_side_effect_guard [L2] owner=core/validation-executor',
  },
];
const requiredFlowFactPolicies = [
  {
    name: 'flow-policy:review-run-boundary',
    policyId: 'review-run-boundary',
    artifactPath: 'review-runs.json',
    consumerGatePattern: /storyMachine\.canPassReview/,
    semantics: ['flow-policy', 'review-run', 'schema-contract', 'gate-evidence'],
    disposition: '',
  },
  {
    name: 'flow-policy:review-pass',
    policyId: 'review-pass',
    artifactPath: 'review-passes.json',
    consumerGatePattern: /storyMachine\.canPassReview/,
    semantics: ['flow-policy', 'review-pass', 'no-blocker-evidence', 'gate-evidence'],
    disposition: '',
  },
  {
    name: 'flow-policy:finding',
    policyId: 'finding',
    artifactPath: 'findings.json',
    consumerGatePattern: /storyMachine\.canPassReview/,
    semantics: ['flow-policy', 'finding-state', 'blocker-state', 'gate-evidence'],
    disposition: '',
  },
  {
    name: 'flow-policy:pass-only-normalization',
    policyId: 'pass-only-normalization',
    artifactPath: 'review-passes.json',
    consumerGatePattern: /storyMachine\.canPassReview/,
    semantics: ['flow-policy', 'normalization-policy', 'review-pass', 'gate-evidence'],
    disposition: 'finding_add:pass-only->review_pass_set',
  },
  {
    name: 'flow-policy:review-round-iso-string',
    policyId: 'review-round-iso-string',
    artifactPath: 'findings.json',
    consumerGatePattern: /review signatures.*storyMachine\.canPassReview/,
    semantics: ['flow-policy', 'schema-contract', 'finding-state', 'review-pass', 'gate-evidence'],
    disposition: '',
  },
  {
    name: 'flow-policy:express-verification-policy',
    policyId: 'express-verification-policy',
    artifactPath: '',
    consumerGatePattern: /validate verification coverage.*story_review/,
    semantics: ['flow-policy', 'verification-policy', 'gate-evidence'],
    disposition: 'express-exempt',
  },
];
const reviewRoundIsoDocPaths = [
  'CLAUDE.md',
  'docs/requirements/decisions/story-lifecycle.md',
  'docs/requirements/decisions/testing-infra.md',
];
const evidenceBoundaryDocPaths = [
  'CLAUDE.md',
  'docs/requirements/decisions/testing-infra.md',
];
const requiredEvidenceBoundaryPhrases = [
  'prompt-only worker claims are not mechanical evidence',
  'dispatch/process-event/commit evidence',
  'Koala cannot mechanically prove true subagent context isolation',
  'transcript/delivery evidence is required; prompt-only user-value claims are not enough',
  'non-mechanical user approval',
];
const requiredControlledMutationEntries = [
  {
    name: 'truth_nav',
    level: 'L2',
    owner: 'handlers/truth',
    rationalePattern: /NAV\.md|documentation mutation/i,
  },
  {
    name: 'truth_extract',
    level: 'L2',
    owner: 'handlers/truth',
    rationalePattern: /writes generated requirements files|controlled mutation/i,
  },
  {
    name: 'doctor',
    level: 'L2',
    owner: 'handlers/doctor',
    rationalePattern: /repair|removes terminal worktree residue/i,
  },
];
const processFactCommandNamePatterns = [
  /^story_advance$/,
  /^story_review$/,
  /^review_run_start$/,
  /^review_pass_set$/,
  /^finding_(add|resolve|dismiss|cluster)$/,
  /^verification_evidence_/,
  /_check_set$/,
  /^init_check_set$/,
  /^scope_(check_save|question_resolve)$/,
  /^delivery_(check_set|waiver_add)$/,
  /^draft_(check_set|issue_resolve)$/,
  /^summary_set$/,
  /^evaluate_save$/,
  /^test_add$/,
  /^test_story$/,
  /^validate$/,
  /^checklist_update$/,
];

const ALL_PHASES = ['INIT', 'INIT_CHECK', 'PLAN', 'DEV', 'REVIEW', 'TEST', 'DONE'];

async function importBuiltModule(relPath) {
  const absPath = join(root, relPath);
  if (!existsSync(absPath)) return null;
  try {
    return await import(pathToFileURL(absPath).href);
  } catch (error) {
    warnings.push(`${relPath} could not be imported; falling back to source parsing (${error.message})`);
    return null;
  }
}

// Contract verification is source-first by design. Stale dist output must not be
// allowed to hide current source drift, so the verifier parses src files even
// when compiled modules exist.
const builtCommandPolicyModule = null;
const builtConfigModule = null;
const builtProcessFactRegistryModule = null;

const passOnlyFindingAddPatterns = [
  /文档一致性检查通过/,
  /consistency check\s+PASSED/,
  /检查通过/,
  /\bno\s+findings?\b/i,
  /\bPASS(?:ED)?\b/,
];

function fail(message) {
  failures.push(message);
}

function warn(message) {
  warnings.push(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function read(relPath) {
  const absPath = join(root, relPath);
  assert(existsSync(absPath), `${relPath} should exist`);
  if (!existsSync(absPath)) return '';
  return readFileSync(absPath, 'utf8');
}

function listMarkdown(dir) {
  const absDir = join(root, dir);
  assert(existsSync(absDir), `${dir} should exist`);
  if (!existsSync(absDir)) return [];
  return readdirSync(absDir)
    .filter(name => name.endsWith('.md'))
    .sort()
    .map(name => `${dir}/${name}`);
}

function isReviewerPrompt(relPath, text) {
  const name = basename(relPath);
  return name.startsWith('koala-review-') || requiredReviewerRunIdPromptFiles.has(name) || text.includes('review_pass_set');
}

function scanBraceState(line, state) {
  for (const char of line) {
    if (state.escaped) {
      state.escaped = false;
      continue;
    }
    if (state.inString) {
      if (char === '\\') state.escaped = true;
      else if (char === '"') state.inString = false;
      continue;
    }
    if (char === '"') {
      state.inString = true;
      continue;
    }
    if (char === '{') {
      state.seenJson = true;
      state.depth += 1;
      continue;
    }
    if (char === '}') {
      state.depth -= 1;
    }
  }
  return state;
}

function commandBlocks(text, command) {
  const commandPattern = new RegExp(`\\bkoala\\s+${command}\\b`);
  const anyKoalaCommandPattern = /\bkoala\s+[a-z_][a-z0-9_]*\b/;
  const lines = text.split(/\r?\n/);
  const blocks = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(commandPattern);
    if (!match) continue;

    const state = scanBraceState(line.slice(match.index), {
      depth: 0,
      escaped: false,
      inString: false,
      seenJson: false,
    });
    const blockLines = [line];

    for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
      if (state.seenJson && state.depth <= 0) break;

      const nextLine = lines[nextIndex];
      const trimmed = nextLine.trim();
      if (!state.seenJson && (!trimmed || trimmed.startsWith('```') || anyKoalaCommandPattern.test(nextLine))) break;

      blockLines.push(nextLine);
      scanBraceState(nextLine, state);
    }

    blocks.push({ block: blockLines.join('\n'), lineNo: index + 1 });
  }

  return blocks;
}

function requiresReviewPassProtocol(label) {
  return reviewPassReviewerPrompts.has(basename(label)) || label.startsWith('synthetic-');
}

function requiresNoFindingReviewPassProtocol(label) {
  return basename(label) !== 'koala-evaluator.md' && requiresReviewPassProtocol(label);
}

function hasHardCodedReviewRunIdExample(block) {
  return /\breviewRunId\b[\s\S]{0,160}\b(?:B-[A-Za-z0-9_-]+|<ID>|\$\{[^}]+\}):RR-001\b/.test(block);
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function scanAgentMachineValues(block, label, lineNo) {
  const issues = [];
  for (const match of block.matchAll(/["']?agent["']?\s*:\s*["']([^"']+)["']/g)) {
    const value = match[1];
    if (hanCharacterPattern.test(value)) {
      issues.push(`${label}:${lineNo} machine field "agent" uses non-code value "${value}"; use an English/code-like reviewer id or placeholder`);
    }
  }
  return issues;
}

function scanPromptText(text, label) {
  const issues = [];
  const reviewRunBlocks = commandBlocks(text, 'review_run_start');
  for (const { block, lineNo } of reviewRunBlocks) {
    issues.push(...scanAgentMachineValues(block, label, lineNo));
  }

  const findingBlocks = commandBlocks(text, 'finding_add');
  for (const { block, lineNo } of findingBlocks) {
    issues.push(...scanAgentMachineValues(block, label, lineNo));
    if (requiresReviewPassProtocol(label) && hasHardCodedReviewRunIdExample(block)) {
      issues.push(`${label}:${lineNo} active reviewer command example must use the reviewRunId returned by review_run_start, not a hard-coded RR-001`);
    }
    if (passOnlyFindingAddPatterns.some(pattern => pattern.test(block))) {
      issues.push(`${label}:${lineNo} pass-only finding_add must use review_pass_set`);
    }
    if (requiresReviewPassProtocol(label) && block.includes('{') && !/\breviewRunId\b/.test(block)) {
      issues.push(`${label}:${lineNo} reviewer finding_add example must include reviewRunId from review_run_start`);
    }
    for (const match of block.matchAll(/["']?category["']?\s*:\s*["']([^"']+)["']/g)) {
      const category = match[1];
      if (currentCategories.has(category)) continue;
      if (legacyCategories.has(category)) {
        issues.push(`${label}:${lineNo} active finding_add example uses legacy category "${category}"; use "missing" and keep legacy names only in compatibility text`);
      } else {
        issues.push(`${label}:${lineNo} active finding_add example uses unknown category "${category}"`);
      }
    }
  }

  const reviewPassBlocks = commandBlocks(text, 'review_pass_set');
  for (const { block, lineNo } of reviewPassBlocks) {
    issues.push(...scanAgentMachineValues(block, label, lineNo));
    if (requiresReviewPassProtocol(label) && hasHardCodedReviewRunIdExample(block)) {
      issues.push(`${label}:${lineNo} active reviewer command example must use the reviewRunId returned by review_run_start, not a hard-coded RR-001`);
    }
    if (requiresReviewPassProtocol(label) && block.includes('{') && !/\breviewRunId\b/.test(block)) {
      issues.push(`${label}:${lineNo} reviewer review_pass_set example must include reviewRunId from review_run_start`);
    }
  }

  const hasFindingProtocol = text.includes('finding_add');
  const hasReviewPassProtocol = text.includes('review_pass_set');
  const claimsNoFindings = /\bno\s+(?:blocking\s+)?findings?\b|\bno\s+blockers?\b|没有\s*findings?|没有\s*finding|无\s*blocker|无\s+blocking|无\s+finding|审查通过|review\s+passed/i.test(text);
  if (requiresNoFindingReviewPassProtocol(label) && hasFindingProtocol && claimsNoFindings && !text.includes('review_pass_set')) {
    issues.push(`${label}: reviewer prompt claims no findings or completion but never uses review_pass_set`);
  }
  if (requiresReviewPassProtocol(label) && (hasFindingProtocol || hasReviewPassProtocol)) {
    if (!text.includes('review_run_start')) {
      issues.push(`${label}: reviewer prompt emits REVIEW evidence but never starts review_run_start`);
    }
    if (!text.includes('reviewRunId')) {
      issues.push(`${label}: reviewer prompt emits REVIEW evidence but never mentions reviewRunId`);
    }
  }
  return issues;
}

function scanCliMachineFactNames(text, label) {
  const issues = [];
  for (const match of text.matchAll(/\bname\s*:\s*['"]([^'"]+)['"]/g)) {
    const name = match[1];
    if (hanCharacterPattern.test(name) || !codeLikeCommandNamePattern.test(name)) {
      issues.push(`${label}:${lineNumberAt(text, match.index)} CLI command/fact name "${name}" must stay English/code-like`);
    }
  }

  for (const match of text.matchAll(/\b(status|level|category|kind|destructiveRisk|allowedPhases|disposition)\s*:\s*['"]([^'"]+)['"]/g)) {
    const property = match[1];
    const value = match[2];
    if (hanCharacterPattern.test(value)) {
      issues.push(`${label}:${lineNumberAt(text, match.index)} machine fact ${property} value "${value}" must stay English/code-like`);
    }
  }

  for (const match of text.matchAll(/z\.enum\(\s*\[([\s\S]*?)\]\s*\)/g)) {
    const enumBody = match[1];
    const enumLine = lineNumberAt(text, match.index);
    for (const valueMatch of enumBody.matchAll(/['"]([^'"]+)['"]/g)) {
      const value = valueMatch[1];
      if (hanCharacterPattern.test(value)) {
        issues.push(`${label}:${enumLine} CLI schema enum value "${value}" must stay English/code-like`);
      }
    }
  }

  return issues;
}

function scanCodeLikeStringArrayConst(text, label, constName) {
  const issues = [];
  const pattern = new RegExp(`(?:export\\s+)?const\\s+${constName}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as\\s+const`);
  const match = text.match(pattern);
  if (!match) {
    issues.push(`${label}: missing code-like string array const ${constName}`);
    return issues;
  }

  const body = match[1];
  for (const valueMatch of body.matchAll(/['"]([^'"]+)['"]/g)) {
    const value = valueMatch[1];
    if (hanCharacterPattern.test(value) || !/^[a-z][a-z0-9_]*$/.test(value)) {
      issues.push(`${label}: ${constName} value "${value}" must stay English/code-like`);
    }
  }
  return issues;
}

function scanReviewRoundPromptSchema(text, label) {
  const issues = [];
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const context = lines.slice(Math.max(0, index - 2), Math.min(lines.length, index + 3)).join('\n');
    if (context.includes('story_review.planReviewRound')) continue;

    if (/\breviewRound\s*:\s*number\b/.test(line)) {
      issues.push(`${label}:${index + 1} bare reviewRound:number drift; signed reviewRound must be ISO string`);
    }
    if (/["']reviewRound["']\s*:\s*\d+\b/.test(line)) {
      issues.push(`${label}:${index + 1} numeric reviewRound example drift; signed reviewRound must be ISO string`);
    }
    if (/F-035\b/.test(line) && /reviewRound/.test(line) && /\bnumber\b/.test(line)) {
      issues.push(`${label}:${index + 1} F-035 numeric reviewRound drift; use ISO string signed reviewRound wording`);
    }
  }
  return issues;
}

function promptSemanticTokens(text) {
  const tokens = new Set();
  for (const match of text.matchAll(/\bkoala\s+([a-z_][a-z0-9_]*)\b/g)) {
    tokens.add(`cmd:${match[1]}`);
  }
  for (const match of text.matchAll(/(?:^|[\s`"'(])((?:\.koala|\.Codex|\.claude|docs|packages|bin)\/[A-Za-z0-9._/@:-]+(?:\/[A-Za-z0-9._/@:-]+)*)/g)) {
    tokens.add(`path:${match[1].replace(/[),.;:]+$/, '')}`);
  }
  for (const name of ['review_run_start', 'finding_add', 'review_pass_set', 'init_check_set', 'scope_check_save', 'delivery_check_set', 'verification_evidence_add', 'verification_evidence_batch_add']) {
    if (text.includes(name)) tokens.add(`cmd:${name}`);
  }
  return [...tokens].sort();
}

function comparePromptSemantics(promptMap) {
  const templateDir = 'packages/main/templates/agents';
  const mirrorDirs = ['.claude/agents', '.Codex/agents'];
  const templateFiles = [...promptMap.keys()]
    .filter(relPath => relPath.startsWith(`${templateDir}/`))
    .sort();

  for (const templateRel of templateFiles) {
    const name = basename(templateRel);
    const templateTokens = promptSemanticTokens(promptMap.get(templateRel));
    for (const mirrorDir of mirrorDirs) {
      const mirrorRel = `${mirrorDir}/${name}`;
      if (!promptMap.has(mirrorRel)) {
        warn(`${mirrorRel} missing; no semantic drift comparison available`);
        continue;
      }
      const mirrorTokens = promptSemanticTokens(promptMap.get(mirrorRel));
      const missing = templateTokens.filter(token => !mirrorTokens.includes(token));
      const extra = mirrorTokens.filter(token => !templateTokens.includes(token));
      if (missing.length || extra.length) {
        const changed = [...missing, ...extra];
        const commandOrPathDrift = changed.some(token => token.startsWith('cmd:') || token.startsWith('path:'));
        const message = `${mirrorRel} command/path semantics drifted from template ${templateRel}; missing=[${missing.join(', ')}] extra=[${extra.join(', ')}]`;
        if (commandOrPathDrift) fail(message);
        else warn(message);
      }
    }
  }
}

function paragraphBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let current = [];
  let startLine = 1;

  function flush() {
    if (!current.length) return;
    blocks.push({ block: current.join('\n'), lineNo: startLine });
    current = [];
  }

  for (const [index, line] of lines.entries()) {
    if (/^\s*$/.test(line)) {
      flush();
      continue;
    }
    if (!current.length) startLine = index + 1;
    current.push(line);
  }
  flush();

  return blocks;
}

function scanActiveLifecycleDocText(text, label) {
  const issues = [];
  const lines = text.split(/\r?\n/);

  for (const { block, lineNo } of paragraphBlocks(text)) {
    if (!/\btest_auto\b/.test(block)) continue;

    const blockLines = block.split(/\r?\n/);
    for (const [offset, rawLine] of blockLines.entries()) {
      const line = rawLine.replace(/\s+/g, ' ').trim();
      if (!line || legacyTestAutoNegatedProcessFactPattern.test(line)) continue;
      const namesOtherLegacyCommand = legacyTestFixtureCommands
        .filter(commandName => commandName !== 'test_auto')
        .some(commandName => new RegExp(`\\b${commandName}\\b`).test(line));
      if (namesOtherLegacyCommand && !/\btest_auto\b/.test(line)) continue;

      for (const { label: claimLabel, pattern } of legacyTestAutoProcessFactClaimPatterns) {
        if (pattern.test(line)) {
          issues.push(`${label}:${lineNo + offset} active lifecycle doc must not claim legacy test_auto ${claimLabel}`);
        }
      }
    }
  }

  for (const [index, line] of lines.entries()) {
    if (!line.includes(coverageReviewerLaneName)) continue;

    const lineNo = index + 1;
    for (const { label: claimLabel, pattern } of coverageReviewerCliCommandPatterns) {
      if (pattern.test(line)) {
        issues.push(`${label}:${lineNo} ${coverageReviewerLaneName} must not be documented as a CLI/tool command (${claimLabel})`);
      }
    }

    const context = lines
      .slice(Math.max(0, index - 1), Math.min(lines.length, index + 2))
      .join('\n');
    if (!coverageReviewerLaneContextPattern.test(context)) {
      issues.push(`${label}:${lineNo} ${coverageReviewerLaneName} must be described as a reviewer agent/lane`);
    }
  }

  return issues;
}

function assertSyntheticAdversarialChecks() {
  const badPassOnlyLines = [
    'koala finding_add \'{"storyId":"B-x","desc":"文档一致性检查通过","severity":"low","category":"happy","agent":"koala-review-docs"}\'',
    'koala finding_add \'{"storyId":"B-x","desc":"consistency check PASSED","severity":"low","category":"happy","agent":"koala-review-docs"}\'',
    'koala finding_add \'{"storyId":"B-x","desc":"no findings","severity":"low","category":"happy","agent":"koala-review-quality"}\'',
    'koala finding_add \'{"storyId":"B-x","desc":"PASS","severity":"low","category":"happy","agent":"koala-review-quality"}\'',
  ];
  for (const [index, line] of badPassOnlyLines.entries()) {
    assert(
      scanPromptText(line, `synthetic-pass-only-${index}`).some(issue => issue.includes('pass-only finding_add')),
      `synthetic pass-only finding_add prompt ${index + 1} should fail`,
    );
  }
  const multilinePassOnly = [
    "koala finding_add '{",
    '  storyId:"B-x",',
    '  desc:"PASS",',
    '  severity:"low",',
    '  category:"happy",',
    '  agent:"koala-review-quality"',
    "}'",
  ].join('\n');
  assert(
    scanPromptText(multilinePassOnly, 'synthetic-multiline-pass-only').some(issue => issue.includes('pass-only finding_add')),
    'synthetic multiline pass-only finding_add prompt should fail',
  );

  const noReviewPass = [
    'Use koala finding_add for every problem.',
    'No findings. Review passed.',
  ].join('\n');
  assert(
    scanPromptText(noReviewPass, 'synthetic-no-review-pass').some(issue => issue.includes('review_pass_set')),
    'synthetic no-finding prompt without review_pass_set should fail',
  );

  const activeLegacy = 'koala finding_add \'{"storyId":"B-x","desc":"cleanup","severity":"medium","category":"cleanup","agent":"koala-review-quality"}\'';
  assert(
    scanPromptText(activeLegacy, 'synthetic-active-legacy').some(issue => issue.includes('legacy category')),
    'synthetic active legacy category should fail',
  );
  const multilineLegacy = [
    "koala finding_add '{",
    '  storyId:"B-x",',
    '  desc:"real issue",',
    '  severity:"medium",',
    '  category:"cleanup",',
    '  agent:"koala-review-quality"',
    "}'",
  ].join('\n');
  assert(
    scanPromptText(multilineLegacy, 'synthetic-multiline-legacy').some(issue => issue.includes('legacy category')),
    'synthetic multiline legacy category should fail',
  );

  const unknownCategory = 'koala finding_add \'{"storyId":"B-x","desc":"docs","severity":"medium","category":"docs","agent":"koala-review-quality"}\'';
  assert(
    scanPromptText(unknownCategory, 'synthetic-unknown-category').some(issue => issue.includes('unknown category')),
    'synthetic unknown category should fail',
  );
  const literalReviewRunId = 'koala finding_add \'{"storyId":"B-x","reviewRunId":"B-x:RR-001","desc":"real issue","severity":"medium","category":"missing","agent":"koala-review-quality"}\'';
  assert(
    scanPromptText(literalReviewRunId, 'synthetic-literal-review-run-id').some(issue => issue.includes('hard-coded RR-001')),
    'synthetic literal RR-001 reviewer command should fail',
  );
  const missingFindingReviewRunId = 'koala finding_add \'{"storyId":"B-x","desc":"real issue","severity":"medium","category":"missing","agent":"koala-review-quality"}\'';
  assert(
    scanPromptText(missingFindingReviewRunId, 'packages/main/templates/agents/koala-review-story-init.md')
      .some(issue => issue.includes('finding_add example must include reviewRunId')),
    'synthetic reviewer finding_add JSON example without reviewRunId should fail',
  );
  const missingPassReviewRunId = 'koala review_pass_set \'{"storyId":"B-x","agent":"koala-review-quality","note":"quality review passed: checked changed files and found no blocker."}\'';
  assert(
    scanPromptText(missingPassReviewRunId, 'packages/main/templates/agents/koala-evaluator.md')
      .some(issue => issue.includes('review_pass_set example must include reviewRunId')),
    'synthetic reviewer review_pass_set JSON example without reviewRunId should fail',
  );
  assert(
    scanReviewRoundPromptSchema('reviewRound: number, // 当前 REVIEW 轮次（1 / 2 / 3+）', 'synthetic-review-round-number')
      .some(issue => issue.includes('bare reviewRound:number drift')),
    'synthetic bare reviewRound:number prompt schema should fail',
  );
  assert(
    scanReviewRoundPromptSchema('reviewRound: number, // F-035: 顶层 reviewRound', 'synthetic-review-round-f035')
      .some(issue => issue.includes('bare reviewRound:number drift')),
    'synthetic F-035 numeric reviewRound prompt schema should fail',
  );
  assert(
    scanReviewRoundPromptSchema('"reviewRound": 1,', 'synthetic-review-round-json-number')
      .some(issue => issue.includes('numeric reviewRound example drift')),
    'synthetic numeric reviewRound JSON example should fail',
  );
  assert(
    scanReviewRoundPromptSchema('story_review.planReviewRound: number (PLAN review round count)', 'synthetic-plan-review-round').length === 0,
    'synthetic story_review.planReviewRound numeric docs should pass',
  );
  const multilineUnknown = [
    "koala finding_add '{",
    '  storyId:"B-x",',
    '  desc:"real issue",',
    '  severity:"medium",',
    '  category:"docs",',
    '  agent:"koala-review-quality"',
    "}'",
  ].join('\n');
  assert(
    scanPromptText(multilineUnknown, 'synthetic-multiline-unknown').some(issue => issue.includes('unknown category')),
    'synthetic multiline unknown category should fail',
  );

  const goodPrompt = [
    'koala review_run_start \'{"storyId":"B-x","agent":"koala-review-quality"}\'',
    'koala finding_add \'{"storyId":"B-x","reviewRunId":"<reviewRunId from review_run_start>","desc":"real issue","severity":"medium","category":"missing","agent":"koala-review-quality"}\'',
    'koala review_pass_set \'{"storyId":"B-x","agent":"koala-review-quality","reviewRunId":"<reviewRunId from review_run_start>","note":"quality review passed: checked changed files and found no blocker."}\'',
  ].join('\n');
  assert(scanPromptText(goodPrompt, 'synthetic-good').length === 0, 'synthetic good prompt should pass');

  const localizedAgentPlaceholder = 'koala review_run_start \'{"storyId":"B-x","agent":"<本 reviewer 名>"}\'';
  assert(
    scanPromptText(localizedAgentPlaceholder, 'synthetic-localized-agent-placeholder')
      .some(issue => issue.includes('machine field "agent" uses non-code value')),
    'synthetic localized agent placeholder should fail',
  );

  const localizedCliEnum = "  section: z.enum(['触发事件', '关键洞察']).describe('target'),";
  assert(
    scanCliMachineFactNames(localizedCliEnum, 'synthetic-localized-cli-enum')
      .some(issue => issue.includes('CLI schema enum value')),
    'synthetic localized CLI enum should fail',
  );

  const localizedCliName = "  { name: '状态_检查', description: 'bad', schema: {} },";
  assert(
    scanCliMachineFactNames(localizedCliName, 'synthetic-localized-cli-name')
      .some(issue => issue.includes('CLI command/fact name')),
    'synthetic localized CLI command name should fail',
  );

  const localizedConstArray = "export const BACKGROUND_SECTION_IDS = ['trigger_event', '触发事件'] as const;";
  assert(
    scanCodeLikeStringArrayConst(localizedConstArray, 'synthetic-localized-section-ids', 'BACKGROUND_SECTION_IDS')
      .some(issue => issue.includes('BACKGROUND_SECTION_IDS value')),
    'synthetic localized background section id const should fail',
  );

  const syntheticCli = "  { name: 'surprise_check_set', description: '保存新的流程确认', schema: {} },";
  assert(
    findUninventoriedProcessFactCommands(syntheticCli).includes('surprise_check_set'),
    'synthetic new process fact handler should fail until inventoried',
  );

  const syntheticTypedPolicy = [
    'export const COMMAND_POLICIES: Record<string, CommandPolicy> = {',
    '  tricky_command: {',
    '    status: "supported",',
    '    allowedPhases: ["PLAN", "REVIEW"],',
    '    destructiveRisk: "none",',
    '    reason: "Reviewer\\\'s plan artifact with \\"quotes\\" stays parseable.",',
    '    replacement: `Use koala validate --story=<storyId> and record verificationEvidence`,',
    '  },',
    '} as const satisfies Record<string, CommandPolicy>;',
  ].join('\n');
  const syntheticBody = extractExportedObjectBody(syntheticTypedPolicy, 'COMMAND_POLICIES', 'synthetic-command-policy.ts');
  const syntheticOpen = syntheticBody.indexOf('{');
  const syntheticBlock = extractBalancedBlock(syntheticBody, syntheticOpen, '{', '}', 'synthetic-command-policy.ts tricky_command');
  assert(
    readStringProperty(syntheticBlock, 'reason').includes('Reviewer\'s plan artifact') &&
      readStringProperty(syntheticBlock, 'replacement').includes('verificationEvidence') &&
      parseStringArrayProperty(syntheticBlock, 'allowedPhases').includes('REVIEW'),
    'synthetic command policy parser should tolerate typed exports, apostrophes, escaped quotes, and template strings',
  );

  const syntheticPhaseTools = [
    'const unrelated = "DEV: [\'comment_only_command\']";',
    '// DEV: [\'line_comment_command\']',
    'export const DEFAULT_PHASE_TOOLS: Record<string, string[]> = {',
    "  // '*': ['commented_global_tool']",
    "  '*': [",
    "    'session_brief',",
    "    'aux_*', // 'comment_only_command' must not be parsed",
    "    'quoted # value',",
    '  ],',
    '  DEV: [',
    "    'checklist_update',",
    '    /*',
    "      '*': ['commented_star_command']",
    "      'commented_dev_command'",
    '    */',
    "    'finding_add',",
    '  ],',
    '  REVIEW: [',
    "    'review_pass_set',",
    '  ],',
    '} as const;',
  ].join('\n');
  const syntheticGlobalTools = extractPhaseToolEntries(syntheticPhaseTools, '*');
  assert(
    syntheticGlobalTools.has('session_brief') &&
      syntheticGlobalTools.has('aux_*') &&
      syntheticGlobalTools.has('quoted # value') &&
      !syntheticGlobalTools.has('comment_only_command') &&
      !syntheticGlobalTools.has('commented_global_tool') &&
      !syntheticGlobalTools.has('commented_star_command'),
    'synthetic DEFAULT_PHASE_TOOLS parser should handle quoted "*" key, strings, and comments',
  );
  const syntheticDevTools = extractPhaseToolEntries(syntheticPhaseTools, 'DEV');
  assert(
    syntheticDevTools.has('checklist_update') &&
      syntheticDevTools.has('finding_add') &&
      !syntheticDevTools.has('commented_dev_command') &&
      !syntheticDevTools.has('line_comment_command'),
    'synthetic DEFAULT_PHASE_TOOLS parser should handle ordinary phase keys without reading comments',
  );

  const widenedPhaseTools = {
    DEV: ['test_auto', 'test_add', 'review_pass_set', 'validate'],
  };
  assert(
    !commandAllowedByConfiguredPhaseTools('test_auto', 'DEV', widenedPhaseTools) &&
      !commandAllowedByConfiguredPhaseTools('test_add', 'DEV', widenedPhaseTools) &&
      !commandAllowedByConfiguredPhaseTools('review_pass_set', 'DEV', widenedPhaseTools) &&
      commandAllowedByConfiguredPhaseTools('validate', 'DEV', widenedPhaseTools),
    'runtime phaseTools config must narrow only: it cannot widen rootOnly/legacy commands or REVIEW-only gate evidence',
  );

  const badTestAutoBugDoc = [
    'Legacy `test_auto` 是兼容 runner。',
    '6. 自动 bug 管理：fail 创建 bug，pass 自动 fix bug',
  ].join('\n');
  assert(
    scanActiveLifecycleDocText(badTestAutoBugDoc, 'synthetic-test-auto-bug-doc').some(issue => issue.includes('auto bug management')),
    'synthetic active lifecycle doc that gives test_auto automatic bug management should fail',
  );

  const badTestAutoEvidenceDoc = [
    'Legacy `test_auto` 是兼容 runner。',
    '6. writes test-evidence.json and records verificationEvidence',
  ].join('\n');
  assert(
    scanActiveLifecycleDocText(badTestAutoEvidenceDoc, 'synthetic-test-auto-evidence-doc').some(issue => issue.includes('test-evidence writes')),
    'synthetic active lifecycle doc that gives test_auto test-evidence writes should fail',
  );

  const goodTestAutoDoc = [
    'Legacy `test_auto` 是兼容 runner。',
    '它不会写 `bug.json`，也不会写 `test-evidence.json`。',
  ].join('\n');
  assert(
    scanActiveLifecycleDocText(goodTestAutoDoc, 'synthetic-test-auto-good-doc').length === 0,
    'synthetic active lifecycle doc may explicitly say test_auto does not write bug/test evidence',
  );

  const badCoverageToolDoc = '| `koala-review-test-coverage` | 检查 verificationIntent 覆盖 |';
  assert(
    scanActiveLifecycleDocText(badCoverageToolDoc, 'synthetic-coverage-tool-doc').some(issue => issue.includes('CLI/tool command')),
    'synthetic coverage reviewer documented as a tool table row should fail',
  );

  const badCoverageBareDoc = '`koala-review-test-coverage` checks coverage.';
  assert(
    scanActiveLifecycleDocText(badCoverageBareDoc, 'synthetic-coverage-bare-doc').some(issue => issue.includes('reviewer agent/lane')),
    'synthetic bare coverage reviewer name without reviewer/lane context should fail',
  );

  const goodCoverageLaneDoc = 'reviewer lane `koala-review-test-coverage` checks verificationIntent coverage and uses review_pass_set when no blocker exists.';
  assert(
    scanActiveLifecycleDocText(goodCoverageLaneDoc, 'synthetic-coverage-good-doc').length === 0,
    'synthetic coverage reviewer lane wording should pass',
  );
}

function extractExportedArrayBody(text, exportName) {
  const match = new RegExp(`\\bexport\\s+const\\s+${exportName}\\b(?:\\s*:\\s*[^=]+)?\\s*=\\s*\\[`).exec(text);
  assert(Boolean(match), `source should export ${exportName}`);
  if (!match) return '';

  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;
  const arrayStart = match.index + match[0].lastIndexOf('[');

  for (let index = arrayStart; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (char === '\\') escaped = true;
      else if (char === quote) inString = false;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      inString = true;
      quote = char;
      continue;
    }
    if (char === '[') {
      depth += 1;
      continue;
    }
    if (char === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(arrayStart + 1, index);
    }
  }

  fail(`${processFactLevelRegistryPath} ${exportName} array should close`);
  return '';
}

function extractBalancedBlock(text, openIndex, openChar, closeChar, label) {
  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;

  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (char === '\\') escaped = true;
      else if (char === quote) inString = false;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      inString = true;
      quote = char;
      continue;
    }
    if (char === openChar) {
      depth += 1;
      continue;
    }
    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex + 1, index);
    }
  }

  fail(`${label} block should close`);
  return '';
}

function extractExportedObjectBody(text, exportName, relPath) {
  const match = new RegExp(`\\bexport\\s+const\\s+${exportName}\\b(?:\\s*:\\s*[^=]+)?\\s*=\\s*\\{`).exec(text);
  assert(Boolean(match), `${relPath} should export ${exportName}`);
  if (!match) return '';
  const objectStart = match.index + match[0].lastIndexOf('{');
  return extractBalancedBlock(text, objectStart, '{', '}', `${relPath} ${exportName}`);
}

function extractConstInitializer(text, constName, relPath) {
  const match = new RegExp(`\\b(?:export\\s+)?const\\s+${constName}\\b(?:\\s*:\\s*[^=]+)?\\s*=\\s*`).exec(text);
  assert(Boolean(match), `${relPath} should declare ${constName}`);
  if (!match) return '';

  const startIndex = match.index + match[0].length;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (char === '\\') escaped = true;
      else if (char === quote) inString = false;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      inString = true;
      quote = char;
      continue;
    }
    if (char === '(') {
      parenDepth += 1;
      continue;
    }
    if (char === ')') {
      parenDepth -= 1;
      continue;
    }
    if (char === '[') {
      bracketDepth += 1;
      continue;
    }
    if (char === ']') {
      bracketDepth -= 1;
      continue;
    }
    if (char === '{') {
      braceDepth += 1;
      continue;
    }
    if (char === '}') {
      braceDepth -= 1;
      continue;
    }
    if (char === ';' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      return text.slice(startIndex, index).trim();
    }
  }

  fail(`${relPath} ${constName} initializer should terminate with a semicolon`);
  return '';
}

function assertInitializerPattern(initializer, label, pattern, message) {
  assert(pattern.test(initializer), `${processFactRegistryPath}: ${label} ${message}`);
}

function assertProcessFactMappedSourceContracts(sourceText) {
  const commandFactsInitializer = extractConstInitializer(sourceText, 'COMMAND_PROCESS_FACTS', processFactRegistryPath);
  assertInitializerPattern(
    commandFactsInitializer,
    'COMMAND_PROCESS_FACTS',
    /\bPROCESS_FACT_LEVELS\s*[\s\S]*\.filter\s*\(\s*\(entry:\s*ProcessFactLevelEntry\)\s*=>\s*!entry\.name\.startsWith\('flow-policy:'\)\s*\)\s*[\s\S]*\.map\s*\(/,
    'must map PROCESS_FACT_LEVELS directly while excluding flow-policy facts from command facts',
  );
  assertInitializerPattern(
    commandFactsInitializer,
    'COMMAND_PROCESS_FACTS',
    /\bconst\s+policy\s*=\s*commandPolicy\(entry\.name\)\s*;/,
    'must derive lifecycle policy from commandPolicy(entry.name)',
  );
  assertInitializerPattern(
    commandFactsInitializer,
    'COMMAND_PROCESS_FACTS',
    /\bconst\s+rootOnly\s*=\s*policy\s*\?\s*policy\.rootOnly\s*===\s*true\s*\|\|\s*policy\.status\s*===\s*'rootOnly'\s*:\s*undefined\s*;/,
    'must wire rootOnly from policy.rootOnly/status',
  );
  assertInitializerPattern(
    commandFactsInitializer,
    'COMMAND_PROCESS_FACTS',
    /\bconst\s+gateEvidence\s*=\s*policy\s*\?\s*policy\.gateEvidence\s*===\s*true\s*\|\|\s*policy\.status\s*===\s*'gateEvidence'\s*:\s*undefined\s*;/,
    'must wire gateEvidence from policy.gateEvidence/status',
  );
  for (const [fieldLabel, pattern] of [
    ['name', /\bname:\s*entry\.name\b/],
    ['kind', /\bkind:\s*commandFactKind\(entry\.name,\s*entry\.level\)/],
    ['semantics', /\bsemantics:\s*commandFactSemantics\(entry\.name,\s*entry\.level\)/],
    ['level', /\blevel:\s*entry\.level\b/],
    ['lifecycle', /\blifecycle:\s*policy\?\.status\b/],
    ['allowedPhases', /\ballowedPhases:\s*policy\?\.allowedPhases\b/],
    ['rootOnly', /\brootOnly\s*,/],
    ['legacy', /\blegacy:\s*policy\s*\?\s*policy\.status\s*===\s*'legacy'\s*:\s*undefined\b/],
    ['gateEvidence', /\bgateEvidence\s*,/],
    ['destructiveRisk', /\bdestructiveRisk:\s*policy\?\.destructiveRisk\b/],
    ['producer', /\bproducer:\s*entry\.owner\b/],
    ['consumerGate', /\bconsumerGate:\s*entry\.gateConsumer\b/],
    ['artifact', /\bartifact:\s*PROCESS_FACT_ARTIFACT_BY_COMMAND\[entry\.name\]/],
    ['reviewerLane', /\breviewerLane:\s*PROCESS_FACT_ARTIFACT_BY_COMMAND\[entry\.name\]\?\.reviewerLane\b/],
    ['rationale', /\brationale:\s*entry\.rationale\b/],
  ]) {
    assertInitializerPattern(
      commandFactsInitializer,
      'COMMAND_PROCESS_FACTS',
      pattern,
      `must wire ${fieldLabel} from level/policy/artifact sources`,
    );
  }

  const reviewerLanesInitializer = extractConstInitializer(sourceText, 'PROCESS_FACT_REVIEWER_LANES', processFactRegistryPath);
  assertInitializerPattern(
    reviewerLanesInitializer,
    'PROCESS_FACT_REVIEWER_LANES',
    /\bPROCESS_FACT_REVIEWER_LANE_DEFINITIONS\.map\s*\(/,
    'must map PROCESS_FACT_REVIEWER_LANE_DEFINITIONS directly',
  );
  assertInitializerPattern(
    reviewerLanesInitializer,
    'PROCESS_FACT_REVIEWER_LANES',
    /\.\.\.entry\b/,
    'must preserve name/producer/consumerGate/reviewerLane/artifact/rationale via ...entry',
  );
  assertInitializerPattern(
    reviewerLanesInitializer,
    'PROCESS_FACT_REVIEWER_LANES',
    /\bkind:\s*'reviewer-lane'\s+as\s+const\b/,
    'must hard-code reviewer-lane kind',
  );
  assertInitializerPattern(
    reviewerLanesInitializer,
    'PROCESS_FACT_REVIEWER_LANES',
    /\bsemantics:\s*\[\s*'reviewer-lane'\s*,\s*'gate-evidence'\s*\]\s+as\s+const\b/,
    'must hard-code reviewer-lane gate-evidence semantics',
  );
  assertInitializerPattern(
    reviewerLanesInitializer,
    'PROCESS_FACT_REVIEWER_LANES',
    /\blevel:\s*'L4'\s+as\s+const\b/,
    'must hard-code L4 reviewer-lane level',
  );

  const flowPoliciesInitializer = extractConstInitializer(sourceText, 'PROCESS_FACT_FLOW_POLICIES', processFactRegistryPath);
  assertInitializerPattern(
    flowPoliciesInitializer,
    'PROCESS_FACT_FLOW_POLICIES',
    /\bFLOW_FACT_POLICIES\.map\s*\(/,
    'must map FLOW_FACT_POLICIES directly',
  );
  assertInitializerPattern(
    flowPoliciesInitializer,
    'PROCESS_FACT_FLOW_POLICIES',
    /\bkind:\s*'flow-policy'\s+as\s+const\b/,
    'must hard-code flow-policy kind',
  );
  assertInitializerPattern(
    flowPoliciesInitializer,
    'PROCESS_FACT_FLOW_POLICIES',
    /\bsemantics:\s*policy\.semantics\s+as\s+readonly\s+ProcessFactSemantic\[\]/,
    'must wire semantics from centralized policy',
  );
  assertInitializerPattern(
    flowPoliciesInitializer,
    'PROCESS_FACT_FLOW_POLICIES',
    /\bartifact:\s*'artifactCommand'\s+in\s+policy\s*&&\s*policy\.artifactCommand\s*\?\s*PROCESS_FACT_ARTIFACT_BY_COMMAND\[policy\.artifactCommand\]/,
    'must resolve artifact metadata from policy artifactCommand',
  );
}

let cachedProcessFactLevelEntries = null;

function parseProcessFactLevelRegistry() {
  if (cachedProcessFactLevelEntries) return cachedProcessFactLevelEntries;

  const text = read(processFactLevelRegistryPath);
  const body = extractExportedArrayBody(text, 'PROCESS_FACT_LEVELS');
  const entryPattern = /\{\s*name:\s*'([^']+)'\s*,\s*level:\s*'(L[0-4])'\s*,\s*category:\s*'([^']+)'\s*,\s*owner:\s*'([^']+)'\s*,\s*rationale:\s*'([^']+)'(?:\s*,\s*gateConsumer:\s*'([^']+)')?\s*,?\s*\}/g;
  const entries = [...body.matchAll(entryPattern)].map(match => ({
    name: match[1],
    level: match[2],
    category: match[3],
    owner: match[4],
    rationale: match[5],
    gateConsumer: match[6],
  }));
  const declaredObjectCount = [...body.matchAll(/\{\s*name:\s*'/g)].length;
  assert(entries.length === declaredObjectCount, `${processFactLevelRegistryPath}: every registry entry must declare name/level/category/owner/rationale in parseable order`);
  assert(entries.length > 0, `${processFactLevelRegistryPath}: registry should not be empty`);

  cachedProcessFactLevelEntries = entries;
  return entries;
}

function parseProcessFactLevelDefinitions() {
  const text = read(processFactLevelRegistryPath);
  const body = extractExportedArrayBody(text, 'PROCESS_FACT_LEVEL_DEFINITIONS');
  return [...body.matchAll(/level:\s*'(L[0-4])'/g)].map(match => match[1]);
}

let cachedCommandPolicyEntries = null;

function readStringProperty(block, propertyName) {
  const match = new RegExp(`\\b${propertyName}\\s*:\\s*(['"\`])`).exec(block);
  if (!match) return '';

  const quote = match[1];
  let escaped = false;
  let value = '';
  for (let index = match.index + match[0].length; index < block.length; index += 1) {
    const char = block[index];
    if (escaped) {
      value += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === quote) return value;
    value += char;
  }
  return '';
}

function parseStringArrayProperty(block, propertyName) {
  const match = new RegExp(`\\b${propertyName}\\s*:\\s*\\[`).exec(block);
  if (!match) return null;
  const openIndex = match.index + match[0].lastIndexOf('[');
  const body = extractBalancedBlock(block, openIndex, '[', ']', `${propertyName} array`);
  const values = [];
  let index = 0;
  while (index < body.length) {
    const quoteIndex = body.slice(index).search(/['"`]/);
    if (quoteIndex === -1) break;
    const absoluteQuoteIndex = index + quoteIndex;
    const quote = body[absoluteQuoteIndex];
    let escaped = false;
    let value = '';
    for (let cursor = absoluteQuoteIndex + 1; cursor < body.length; cursor += 1) {
      const char = body[cursor];
      if (escaped) {
        value += char;
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) {
        values.push(value);
        index = cursor + 1;
        break;
      }
      value += char;
    }
    if (index <= absoluteQuoteIndex) break;
  }
  return values;
}

function allowedPhasesFromPolicy(policy) {
  if (policy.allowedPhases === 'all') return [...ALL_PHASES];
  if (Array.isArray(policy.allowedPhases)) return [...policy.allowedPhases];
  return [];
}

function parseCommandPolicyEntries() {
  if (cachedCommandPolicyEntries) return cachedCommandPolicyEntries;

  if (builtCommandPolicyModule?.COMMAND_POLICIES) {
    const policies = builtCommandPolicyModule.COMMAND_POLICIES;
    const entries = Object.entries(policies).map(([name, policy]) => ({
      name,
      block: JSON.stringify(policy),
      status: policy.status || '',
      reason: policy.reason || '',
      replacement: policy.replacement || '',
      destructiveRisk: policy.destructiveRisk || '',
      hasAllowedPhases: policy.allowedPhases === 'all' || Array.isArray(policy.allowedPhases),
      allowedPhases: allowedPhasesFromPolicy(policy),
      rootOnly: policy.rootOnly === true || policy.status === 'rootOnly',
      gateEvidence: policy.gateEvidence === true || policy.status === 'gateEvidence',
    }));
    assert(entries.length > 0, `${commandPolicyPath}: compiled command policy should not be empty`);
    cachedCommandPolicyEntries = entries;
    return entries;
  }

  const text = read(commandPolicyPath);
  const body = extractExportedObjectBody(text, 'COMMAND_POLICIES', commandPolicyPath);
  const entries = [];
  const keyPattern = /^\s*([a-z_][a-z0-9_]*):\s*\{/gm;
  for (const match of body.matchAll(keyPattern)) {
    const name = match[1];
    const openIndex = match.index + match[0].lastIndexOf('{');
    const block = extractBalancedBlock(body, openIndex, '{', '}', `${commandPolicyPath} ${name}`);
    const status = readStringProperty(block, 'status');
    const reason = readStringProperty(block, 'reason');
    const replacement = readStringProperty(block, 'replacement');
    const destructiveRisk = readStringProperty(block, 'destructiveRisk');
    const allowedPhases = /\ballowedPhases\s*:\s*(['"`])all\1/.test(block)
      ? [...ALL_PHASES]
      : (parseStringArrayProperty(block, 'allowedPhases') || []);
    entries.push({
      name,
      block,
      status,
      reason,
      replacement,
      destructiveRisk,
      hasAllowedPhases: /\ballowedPhases\s*:/.test(block),
      allowedPhases,
      rootOnly: /\brootOnly:\s*true\b/.test(block) || status === 'rootOnly',
      gateEvidence: /\bgateEvidence:\s*true\b/.test(block) || status === 'gateEvidence',
    });
  }

  const declaredObjectCount = [...body.matchAll(/^\s*[a-z_][a-z0-9_]*:\s*\{/gm)].length;
  assert(entries.length === declaredObjectCount, `${commandPolicyPath}: every policy entry must be parseable as commandName: { ... }`);
  assert(entries.length > 0, `${commandPolicyPath}: command policy should not be empty`);

  cachedCommandPolicyEntries = entries;
  return entries;
}

function duplicateNames(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

let cachedProcessFactRegistryEntries = null;

function parseTopLevelObjectBlocks(arrayBody, label) {
  const blocks = [];
  for (let index = 0; index < arrayBody.length; index += 1) {
    const char = arrayBody[index];
    if (char === '\'' || char === '"' || char === '`') {
      const literal = readQuotedLiteralAt(arrayBody, index);
      index = literal ? literal.endIndex - 1 : index;
      continue;
    }
    if (char !== '{') continue;
    const block = extractBalancedBlock(arrayBody, index, '{', '}', `${label} entry`);
    blocks.push(block);
    index += block.length + 1;
  }
  return blocks;
}

function parseRegistryArrayEntriesFromSource(text, exportName) {
  const body = extractExportedArrayBody(text, exportName);
  return parseTopLevelObjectBlocks(body, `${processFactRegistryPath} ${exportName}`)
    .map(block => ({
      name: readStringProperty(block, 'name'),
      kind: readStringProperty(block, 'kind'),
      semantics: parseStringArrayProperty(block, 'semantics') || [],
      level: readStringProperty(block, 'level'),
      producer: readStringProperty(block, 'producer'),
      consumerGate: readStringProperty(block, 'consumerGate') || undefined,
      reviewerLane: readStringProperty(block, 'reviewerLane') || undefined,
      rationale: readStringProperty(block, 'rationale'),
      block,
    }))
    .filter(entry => entry.name);
}

function parseProcessFactKindByCommandFromSource(text) {
  const body = extractExportedObjectBody(text, 'PROCESS_FACT_KIND_BY_COMMAND', processFactRegistryPath);
  return new Map([...body.matchAll(/^\s*([a-z_][a-z0-9_]*):\s*'([^']+)'/gm)].map(match => [match[1], match[2]]));
}

function parseProcessFactArtifactByCommandFromSource(text) {
  const body = extractExportedObjectBody(text, 'PROCESS_FACT_ARTIFACT_BY_COMMAND', processFactRegistryPath);
  const artifacts = new Map();
  const keyPattern = /^\s*([a-z_][a-z0-9_]*):\s*\{/gm;
  for (const match of body.matchAll(keyPattern)) {
    const commandName = match[1];
    const openIndex = match.index + match[0].lastIndexOf('{');
    const block = extractBalancedBlock(body, openIndex, '{', '}', `${processFactRegistryPath} artifact ${commandName}`);
    artifacts.set(commandName, {
      path: readStringProperty(block, 'path'),
      signed: /\bsigned:\s*true\b/.test(block),
      signature: readStringProperty(block, 'signature'),
      producerCommand: readStringProperty(block, 'producerCommand'),
      consumerGate: readStringProperty(block, 'consumerGate'),
      reviewerLane: readStringProperty(block, 'reviewerLane'),
      block,
    });
  }
  return artifacts;
}

function parseProcessFactRequiredSemanticsFromSource(text) {
  const body = extractExportedObjectBody(text, 'PROCESS_FACT_REQUIRED_SEMANTICS', processFactRegistryPath);
  const semantics = new Map();
  const keyPattern = /^\s*([a-z_][a-z0-9_]*):\s*\[/gm;
  for (const match of body.matchAll(keyPattern)) {
    const name = match[1];
    const openIndex = match.index + match[0].lastIndexOf('[');
    const block = extractBalancedBlock(body, openIndex, '[', ']', `${processFactRegistryPath} semantics ${name}`);
    semantics.set(name, [...block.matchAll(/['"`]([^'"`]+)['"`]/g)].map(([, value]) => value));
  }
  return semantics;
}

let cachedFlowFactPolicyEntries = null;

function parseFlowFactPolicies() {
  if (cachedFlowFactPolicyEntries) return cachedFlowFactPolicyEntries;

  const text = read(flowFactPolicyPath);
  for (const token of [
    'FLOW_FACT_POLICIES',
    'PASS_ONLY_REVIEW_FINDING_POLICY',
    'EXPRESS_VERIFICATION_EXEMPTION_MESSAGE',
    'isPassOnlyReviewFindingRecord',
    'express-exempt',
    'review-round-iso-string',
  ]) {
    assert(text.includes(token), `${flowFactPolicyPath}: centralized flow fact policy must expose ${token}`);
  }

  const body = extractExportedArrayBody(text, 'FLOW_FACT_POLICIES');
  const entries = parseTopLevelObjectBlocks(body, `${flowFactPolicyPath} FLOW_FACT_POLICIES`)
    .map(block => ({
      name: readStringProperty(block, 'name'),
      policyId: readStringProperty(block, 'policyId'),
      disposition: readStringProperty(block, 'disposition'),
      level: readStringProperty(block, 'level'),
      category: readStringProperty(block, 'category'),
      owner: readStringProperty(block, 'owner'),
      consumerGate: readStringProperty(block, 'consumerGate'),
      artifactCommand: readStringProperty(block, 'artifactCommand'),
      semantics: parseStringArrayProperty(block, 'semantics') || [],
      rationale: readStringProperty(block, 'rationale'),
      block,
    }))
    .filter(entry => entry.name);

  const declaredObjectCount = [...body.matchAll(/\{\s*name:\s*'/g)].length;
  assert(entries.length === declaredObjectCount, `${flowFactPolicyPath}: every flow policy must be parseable`);
  cachedFlowFactPolicyEntries = entries;
  return entries;
}

function processFactKindForCommand(name, level, kindByCommand) {
  if (kindByCommand.has(name)) return kindByCommand.get(name);
  if (name.startsWith('runtime:')) return 'runtime-behavior';
  return level === 'L4' ? 'gate-evidence' : 'command';
}

function processFactSemanticsForCommand(name, level, semanticsByCommand) {
  const semantics = new Set(semanticsByCommand.get(name) || []);
  if (name.startsWith('runtime:')) semantics.add('runtime-behavior');
  if (level === 'L4') semantics.add('gate-evidence');
  if (semantics.size === 0) semantics.add('command');
  return [...semantics].sort();
}

function parseProcessFactRegistry() {
  if (cachedProcessFactRegistryEntries) return cachedProcessFactRegistryEntries;

  const sourceText = read(processFactRegistryPath);
  for (const token of [
    'PROCESS_FACT_REGISTRY',
    'PROCESS_FACT_REQUIRED_SEMANTICS',
    'PROCESS_FACT_FLOW_POLICIES',
    'PROCESS_FACT_SIGNED_ARTIFACTS',
    'PROCESS_FACT_REQUIRED_ARTIFACTS',
    'semantics',
    'kind',
    'lifecycle',
    'allowedPhases',
    'rootOnly',
    'destructiveRisk',
    'producer',
    'consumerGate',
    'artifact',
    'signature',
    'reviewerLane',
  ]) {
    assert(sourceText.includes(token), `${processFactRegistryPath}: typed registry must expose ${token}`);
  }

  const finalRegistryBody = extractExportedArrayBody(sourceText, 'PROCESS_FACT_REGISTRY');
  for (const requiredSpread of ['COMMAND_PROCESS_FACTS', 'PROCESS_FACT_REVIEWER_LANES', 'PROCESS_FACT_ARTIFACTS', 'PROCESS_FACT_FLOW_POLICIES']) {
    assert(
      finalRegistryBody.includes(`...${requiredSpread}`),
      `${processFactRegistryPath}: final PROCESS_FACT_REGISTRY export missing ...${requiredSpread}`,
    );
  }

  assertProcessFactMappedSourceContracts(sourceText);

  if (builtProcessFactRegistryModule?.PROCESS_FACT_REGISTRY) {
    const entries = builtProcessFactRegistryModule.PROCESS_FACT_REGISTRY.map(entry => ({
      name: entry.name,
      kind: entry.kind,
      semantics: Array.isArray(entry.semantics) ? [...entry.semantics] : [],
      level: entry.level,
      lifecycle: entry.lifecycle,
      allowedPhases: entry.allowedPhases === 'all'
        ? [...ALL_PHASES]
        : (Array.isArray(entry.allowedPhases) ? [...entry.allowedPhases] : []),
      rootOnly: entry.rootOnly === true,
      legacy: entry.legacy === true,
      gateEvidence: entry.gateEvidence === true,
      destructiveRisk: entry.destructiveRisk || '',
      producer: entry.producer || '',
      consumerGate: entry.consumerGate || '',
      artifact: entry.artifact || null,
      reviewerLane: entry.reviewerLane || '',
      rationale: entry.rationale || '',
    }));
    assert(entries.length > 0, `${processFactRegistryPath}: compiled PROCESS_FACT_REGISTRY should not be empty`);
    cachedProcessFactRegistryEntries = entries;
    return entries;
  }

  const policyByName = new Map(parseCommandPolicyEntries().map(entry => [entry.name, entry]));
  const kindByCommand = parseProcessFactKindByCommandFromSource(sourceText);
  const semanticsByCommand = parseProcessFactRequiredSemanticsFromSource(sourceText);
  const artifactByCommand = parseProcessFactArtifactByCommandFromSource(sourceText);
  const commandEntries = parseProcessFactLevelRegistry().filter(entry => !entry.name.startsWith('flow-policy:')).map(entry => {
    const policy = policyByName.get(entry.name);
    const semantics = processFactSemanticsForCommand(entry.name, entry.level, semanticsByCommand);
    const inferredRootOnly = Boolean(policy) && (policy.rootOnly || policy.status === 'rootOnly');
    const inferredGateEvidence = Boolean(policy?.gateEvidence) || policy?.status === 'gateEvidence';
    return {
      name: entry.name,
      kind: processFactKindForCommand(entry.name, entry.level, kindByCommand),
      semantics,
      level: entry.level,
      lifecycle: policy?.status || '',
      allowedPhases: policy?.allowedPhases || [],
      rootOnly: inferredRootOnly,
      legacy: policy?.status === 'legacy',
      gateEvidence: inferredGateEvidence,
      destructiveRisk: policy?.destructiveRisk || '',
      producer: entry.owner,
      consumerGate: entry.gateConsumer || '',
      artifact: artifactByCommand.get(entry.name) || null,
      reviewerLane: artifactByCommand.get(entry.name)?.reviewerLane || '',
      rationale: entry.rationale,
    };
  });

  const laneEntries = parseRegistryArrayEntriesFromSource(sourceText, 'PROCESS_FACT_REVIEWER_LANE_DEFINITIONS').map(entry => {
    const artifactRefMatch = /artifact:\s*PROCESS_FACT_ARTIFACT_BY_COMMAND\.([a-z_][a-z0-9_]*)/.exec(entry.block);
    const artifact = artifactRefMatch ? artifactByCommand.get(artifactRefMatch[1]) : null;
    return {
      ...entry,
      kind: 'reviewer-lane',
      semantics: ['gate-evidence', 'reviewer-lane'],
      level: 'L4',
      artifact: artifact || null,
    };
  });
  const artifactEntries = parseRegistryArrayEntriesFromSource(sourceText, 'PROCESS_FACT_ARTIFACTS').map(entry => {
    const artifactRefMatch = /artifact:\s*PROCESS_FACT_ARTIFACT_BY_COMMAND\.([a-z_][a-z0-9_]*)/.exec(entry.block);
    const artifact = artifactRefMatch ? artifactByCommand.get(artifactRefMatch[1]) : null;
    return { ...entry, artifact: artifact || null };
  });
  const flowPolicyEntries = parseFlowFactPolicies().map(entry => ({
    name: entry.name,
    kind: 'flow-policy',
    semantics: [...entry.semantics],
    level: entry.level,
    producer: entry.owner,
    consumerGate: entry.consumerGate,
    artifact: entry.artifactCommand ? artifactByCommand.get(entry.artifactCommand) || null : null,
    reviewerLane: '',
    rationale: entry.rationale,
  }));

  cachedProcessFactRegistryEntries = [...commandEntries, ...laneEntries, ...artifactEntries, ...flowPolicyEntries];
  return cachedProcessFactRegistryEntries;
}

function processFactRegistryMap() {
  return new Map(parseProcessFactRegistry().map(entry => [entry.name, entry]));
}

function extractCliToolNames(cliText) {
  return [...cliText.matchAll(/name:\s*['"]([a-z_][a-z0-9_]*)['"]/g)]
    .map(match => match[1])
    .sort();
}

function isProcessFactCommandName(commandName) {
  if (commandName.endsWith('_dispatch')) return false;
  return processFactCommandNamePatterns.some(pattern => pattern.test(commandName));
}

function findUninventoriedProcessFactCommands(cliText, inventory = processFactRegistryMap()) {
  return extractCliToolNames(cliText)
    .filter(isProcessFactCommandName)
    .filter(commandName => !inventory.has(commandName));
}

function assertCommandPolicyInventory(cliToolNames) {
  const text = read(commandPolicyPath);
  for (const helperName of ['getCommandLifecyclePolicy', 'formatCommandLifecycleHint', 'getCommandPolicyEntries']) {
    assert(text.includes(helperName), `${commandPolicyPath}: missing helper ${helperName}`);
  }

  const policyEntries = parseCommandPolicyEntries();
  const policyNames = policyEntries.map(entry => entry.name);
  const policyByName = new Map(policyEntries.map(entry => [entry.name, entry]));
  const cliToolNameSet = new Set(cliToolNames);

  const duplicatePolicyNames = duplicateNames(policyNames);
  assert(
    duplicatePolicyNames.length === 0,
    `${commandPolicyPath}: duplicate policy entries: ${duplicatePolicyNames.join(', ')}`,
  );

  const missingPolicyEntries = cliToolNames.filter(commandName => !policyByName.has(commandName));
  assert(
    missingPolicyEntries.length === 0,
    `${commandPolicyPath}: MAIN_TOOLS command(s) missing lifecycle policy: ${missingPolicyEntries.join(', ')}`,
  );

  const unknownPolicyEntries = policyNames.filter(name => !cliToolNameSet.has(name));
  assert(
    unknownPolicyEntries.length === 0,
    `${commandPolicyPath}: lifecycle policy entry not present in MAIN_TOOLS: ${unknownPolicyEntries.join(', ')}`,
  );

  for (const entry of policyEntries) {
    assert(commandPolicyStatuses.has(entry.status), `${commandPolicyPath}: ${entry.name} has unknown status "${entry.status}"`);
    assert(entry.reason.trim().length > 0, `${commandPolicyPath}: ${entry.name} must explain lifecycle reason`);
    assert(entry.hasAllowedPhases || entry.rootOnly, `${commandPolicyPath}: ${entry.name} must declare allowedPhases or rootOnly`);
    assert(entry.destructiveRisk !== '', `${commandPolicyPath}: ${entry.name} must declare destructiveRisk, even when none`);
  }

  for (const commandName of legacyTestFixtureCommands) {
    const entry = policyByName.get(commandName);
    assert(entry, `${commandPolicyPath}: legacy test/fixture command missing policy: ${commandName}`);
    if (!entry) continue;

    const guidance = legacyCommandPolicyGuidance[commandName];
    assert(entry.status === 'legacy', `${commandPolicyPath}: ${commandName} must be classified as legacy`);
    assert(entry.rootOnly, `${commandPolicyPath}: ${commandName} must stay rootOnly/phase-gated`);
    assert(entry.replacement.trim().length > 0, `${commandPolicyPath}: ${commandName} must include replacement guidance`);
    assert(
      entry.destructiveRisk === guidance.destructiveRisk,
      `${commandPolicyPath}: ${commandName} destructiveRisk drifted: expected ${guidance.destructiveRisk}, got ${entry.destructiveRisk || '<missing>'}`,
    );
    for (const pattern of guidance.patterns) {
      assert(
        pattern.test(entry.block),
        `${commandPolicyPath}: ${commandName} replacement/destructive guidance missing ${pattern}`,
      );
    }
  }
}

function assertActiveLifecycleDocGuidance() {
  for (const relPath of activeLifecycleDocPaths) {
    const text = read(relPath);
    for (const term of activeLifecycleDocCurrentTerms) {
      assert(text.includes(term), `${relPath}: active lifecycle docs must mention current flow term "${term}"`);
    }
    for (const issue of scanActiveLifecycleDocText(text, relPath)) fail(issue);

    const lines = text.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const commandName = legacyTestFixtureCommands.find(command => new RegExp(`\\b${command}\\b`).test(line));
      if (!commandName) continue;

      const contextStart = Math.max(0, index - 2);
      const contextEnd = Math.min(lines.length, index + 3);
      const context = lines.slice(contextStart, contextEnd).join('\n');
      assert(
        legacyCommandDocContextPattern.test(context),
        `${relPath}:${index + 1} ${commandName} mention must be labelled legacy/compat/maintenance or be in historical context`,
      );
    }
  }
}

function assertReviewRoundIsoDocs() {
  for (const relPath of reviewRoundIsoDocPaths) {
    const text = read(relPath);
    assert(
      text.includes('reviewRound: string (ISO 8601 review round id)'),
      `${relPath}: reviewRound must be documented as string (ISO 8601 review round id)`,
    );
    assert(
      text.includes('story_review.planReviewRound: number (PLAN review round count)'),
      `${relPath}: story_review PLAN round must be documented as planReviewRound number`,
    );
    assert(
      text.includes('legacy numeric PLAN review alias'),
      `${relPath}: legacy story_review.reviewRound alias must be distinguished from signed reviewRound`,
    );
    assert(
      text.includes('express-exempt'),
      `${relPath}: express verification exemption must be documented as express-exempt`,
    );
    assert(
      text.includes('pass-only finding_add'),
      `${relPath}: pass-only finding_add normalization must be documented`,
    );
  }
}

function assertEvidenceBoundaryDocs() {
  for (const relPath of evidenceBoundaryDocPaths) {
    const text = read(relPath);
    for (const phrase of requiredEvidenceBoundaryPhrases) {
      assert(text.includes(phrase), `${relPath}: missing process evidence boundary phrase "${phrase}"`);
    }
  }
}

function assertPromptEvidenceBoundaries(promptMap) {
  for (const [relPath, text] of promptMap.entries()) {
    const name = basename(relPath);
    if (text.includes('fresh worker per item')) {
      assert(
        text.includes('prompt-only worker claims are not mechanical evidence'),
        `${relPath}: fresh-worker guidance must state prompt-only worker claims are not mechanical evidence`,
      );
      assert(
        text.includes('dispatch/process-event/commit evidence'),
        `${relPath}: fresh-worker guidance must name dispatch/process-event/commit evidence as the observable boundary`,
      );
    }
    if (text.includes('delivery-check.json') || name === 'product-reviewer.md') {
      assert(
        text.includes('transcript/delivery evidence is required; prompt-only user-value claims are not enough'),
        `${relPath}: delivery/product guidance must reject prompt-only user-value claims`,
      );
      assert(
        text.includes('non-mechanical user approval'),
        `${relPath}: delivery/product guidance must distinguish subjective approval from mechanical evidence`,
      );
    }
  }
}

function stripTsComments(text) {
  let out = '';
  let quote = null;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (quote) {
      out += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      out += char;
      continue;
    }

    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      out += '\n';
      continue;
    }

    if (char === '/' && next === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index += 1;
      out += ' ';
      continue;
    }

    out += char;
  }
  return out;
}

function readQuotedLiteralAt(text, openIndex) {
  const quote = text[openIndex];
  let escaped = false;
  let value = '';
  for (let index = openIndex + 1; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      value += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === quote) return { value, endIndex: index + 1 };
    value += char;
  }
  return null;
}

function skipWhitespace(text, index) {
  let cursor = index;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
  return cursor;
}

function findObjectArrayPropertyOpen(body, propertyName) {
  let index = 0;
  while (index < body.length) {
    index = skipWhitespace(body, index);
    if (body[index] === ',') {
      index += 1;
      continue;
    }

    let key = '';
    if (body[index] === '\'' || body[index] === '"' || body[index] === '`') {
      const literal = readQuotedLiteralAt(body, index);
      if (!literal) return -1;
      key = literal.value;
      index = literal.endIndex;
    } else {
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(body.slice(index));
      if (!match) {
        index += 1;
        continue;
      }
      key = match[0];
      index += match[0].length;
    }

    index = skipWhitespace(body, index);
    if (body[index] !== ':') continue;
    index = skipWhitespace(body, index + 1);
    if (key === propertyName && body[index] === '[') return index;

    if (body[index] === '{') {
      const block = extractBalancedBlock(body, index, '{', '}', `DEFAULT_PHASE_TOOLS ${key}`);
      index += block.length + 2;
    } else if (body[index] === '[') {
      const block = extractBalancedBlock(body, index, '[', ']', `DEFAULT_PHASE_TOOLS ${key}`);
      index += block.length + 2;
    } else if (body[index] === '\'' || body[index] === '"' || body[index] === '`') {
      const literal = readQuotedLiteralAt(body, index);
      index = literal ? literal.endIndex : index + 1;
    } else {
      while (index < body.length && body[index] !== ',') index += 1;
    }
  }
  return -1;
}

function extractPhaseToolEntries(configText, phaseName) {
  const text = stripTsComments(configText);
  const body = extractExportedObjectBody(text, 'DEFAULT_PHASE_TOOLS', 'packages/main/src/core/config.ts');
  const openIndex = findObjectArrayPropertyOpen(body, phaseName);
  if (openIndex === -1) return new Set();

  let depth = 1;
  let quote = null;
  let escaped = false;
  let block = '';
  for (let index = openIndex + 1; index < body.length; index += 1) {
    const char = body[index];

    if (quote) {
      block += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      block += char;
      continue;
    }

    if (char === '[') depth += 1;
    if (char === ']') {
      depth -= 1;
      if (depth === 0) break;
    }
    block += char;
  }

  const entries = new Set();
  for (const literal of block.matchAll(/['"]((?:\\.|[^'"\\])*)['"]/g)) {
    entries.add(literal[1].replace(/\\(['"\\])/g, '$1'));
  }
  return entries;
}

function patternMatchesCommand(pattern, commandName) {
  if (pattern.endsWith('*')) return commandName.startsWith(pattern.slice(0, -1));
  return pattern === commandName;
}

function isPhaseToolsRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function commandAllowedByLifecyclePolicySource(commandName, phaseName) {
  if (commandName === 'session_brief' || commandName === 'next') return true;
  const policy = parseCommandPolicyEntries().find(entry => entry.name === commandName);
  if (!policy) return true;
  return policy.allowedPhases.includes(phaseName);
}

function commandAllowedByConfiguredPhaseTools(commandName, phaseName, phaseTools) {
  if (commandName === 'session_brief' || commandName === 'next') return true;
  if (!commandAllowedByLifecyclePolicySource(commandName, phaseName)) return false;
  if (phaseTools !== undefined && !isPhaseToolsRecord(phaseTools)) return true;
  const pt = phaseTools || {};
  const patterns = [...(pt['*'] || []), ...(pt[phaseName] || [])].filter(value => typeof value === 'string');
  return patterns.some(pattern => patternMatchesCommand(pattern, commandName));
}

function getDefaultPhaseToolEntries(configText, phaseName) {
  if (builtConfigModule?.DEFAULT_PHASE_TOOLS) {
    return new Set([
      ...(builtConfigModule.DEFAULT_PHASE_TOOLS['*'] || []),
      ...(builtConfigModule.DEFAULT_PHASE_TOOLS[phaseName] || []),
    ]);
  }
  return new Set([
    ...extractPhaseToolEntries(configText, '*'),
    ...extractPhaseToolEntries(configText, phaseName),
  ]);
}

function commandAllowedByDefaultConfig(commandName, phaseName, configText) {
  if (builtConfigModule?.isCommandAllowed) {
    return builtConfigModule.isCommandAllowed(commandName, phaseName);
  }
  const patterns = getDefaultPhaseToolEntries(configText, phaseName);
  if (!commandAllowedByLifecyclePolicySource(commandName, phaseName)) return false;
  return [...patterns].some(pattern => patternMatchesCommand(pattern, commandName));
}

function patternHasPolicyApprovedCommand(pattern, phaseName, policyEntries) {
  return policyEntries.some(entry => (
    patternMatchesCommand(pattern, entry.name) && entry.allowedPhases.includes(phaseName)
  ));
}

function patternHasRegistryApprovedCommand(pattern, phaseName, registryCommandEntries) {
  return registryCommandEntries.some(entry => (
    patternMatchesCommand(pattern, entry.name) && entry.allowedPhases.includes(phaseName)
  ));
}

function assertCommandPolicyPhaseAlignment(policyEntries, configText) {
  for (const entry of policyEntries) {
    for (const phaseName of ALL_PHASES) {
      const policyAllows = entry.allowedPhases.includes(phaseName);
      const defaultAllows = commandAllowedByDefaultConfig(entry.name, phaseName, configText);
      assert(
        defaultAllows === policyAllows,
        `${commandPolicyPath} + packages/main/src/core/config.ts: ${entry.name} ${phaseName} policy/default phase drift (policy=${policyAllows}, isCommandAllowed=${defaultAllows})`,
      );
    }
  }

  for (const phaseName of ALL_PHASES) {
    for (const pattern of getDefaultPhaseToolEntries(configText, phaseName)) {
      assert(
        patternHasPolicyApprovedCommand(pattern, phaseName, policyEntries),
        `packages/main/src/core/config.ts: DEFAULT_PHASE_TOOLS ${phaseName} pattern "${pattern}" has no command allowed by COMMAND_POLICIES`,
      );
    }
  }

  assert(
    commandAllowedByDefaultConfig('understanding_get', 'REVIEW', configText) &&
      commandAllowedByDefaultConfig('decision_get', 'REVIEW', configText),
    'packages/main/src/core/config.ts: REVIEW must allow understanding_get and decision_get for reviewer access to planning artifacts',
  );
}

function assertL4ProducerOrReplacement(registryEntries, policyByName, configText) {
  for (const entry of registryEntries.filter(item => item.level === 'L4')) {
    if (entry.name.includes(':')) continue;
    const policy = policyByName.get(entry.name);
    assert(policy, `${commandPolicyPath}: L4 command ${entry.name} must have lifecycle policy`);
    if (!policy) continue;
    const producerPhases = ALL_PHASES.filter(phaseName => commandAllowedByDefaultConfig(entry.name, phaseName, configText));
    assert(
      producerPhases.length > 0 || policy.replacement.trim().length > 0,
      `${commandPolicyPath}: L4 command ${entry.name} must have a DEFAULT_PHASE_TOOLS producer phase or replacement guidance`,
    );
  }
}

function sameStringArray(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function isCommandRegistryEntry(entry) {
  return !entry.name.includes(':');
}

function assertProcessFactRegistryContract(cliToolNames, policyEntries, configText) {
  const registryEntries = parseProcessFactRegistry();
  const registry = new Map(registryEntries.map(entry => [entry.name, entry]));
  const registryCommandEntries = registryEntries.filter(isCommandRegistryEntry);
  const registryCommandByName = new Map(registryCommandEntries.map(entry => [entry.name, entry]));
  const policyByName = new Map(policyEntries.map(entry => [entry.name, entry]));
  const levelRegistry = new Map(parseProcessFactLevelRegistry().map(entry => [entry.name, entry]));

  const duplicateRegistryNames = duplicateNames(registryEntries.map(entry => entry.name));
  assert(
    duplicateRegistryNames.length === 0,
    `${processFactRegistryPath}: duplicate PROCESS_FACT_REGISTRY entries: ${duplicateRegistryNames.join(', ')}`,
  );

  for (const entry of registryEntries) {
    assert(processFactRegistryKinds.has(entry.kind), `${processFactRegistryPath}: ${entry.name} has unknown kind "${entry.kind}"`);
    assert(Array.isArray(entry.semantics), `${processFactRegistryPath}: ${entry.name} must declare semantics[]`);
    assert(entry.producer && entry.producer.trim().length > 0, `${processFactRegistryPath}: ${entry.name} must declare producer`);
    assert(entry.rationale && entry.rationale.trim().length > 0, `${processFactRegistryPath}: ${entry.name} must declare rationale`);
    if (entry.level === 'L4') {
      assert(
        entry.consumerGate && entry.consumerGate.trim().length > 0,
        `${processFactRegistryPath}: L4 gate evidence ${entry.name} must name consumer gate`,
      );
    }
  }

  for (const commandName of cliToolNames) {
    assert(
      registryCommandByName.has(commandName),
      `${processFactRegistryPath}: MAIN_TOOLS command missing from PROCESS_FACT_REGISTRY: command=${commandName}`,
    );
  }

  for (const entry of registryCommandEntries) {
    if (entry.name.startsWith('runtime:')) continue;
    assert(
      cliToolNames.includes(entry.name),
      `${processFactRegistryPath}: command registry entry not present in MAIN_TOOLS: command=${entry.name}`,
    );
  }

  for (const levelEntry of parseProcessFactLevelRegistry()) {
    const registryEntry = registry.get(levelEntry.name);
    assert(
      registryEntry,
      `${processFactRegistryPath}: required process fact missing from PROCESS_FACT_REGISTRY: ${levelEntry.name}`,
    );
    if (!registryEntry) continue;
    assert(
      registryEntry.level === levelEntry.level,
      `${processFactRegistryPath}: level drift for command=${levelEntry.name} (registry=${registryEntry.level}, PROCESS_FACT_LEVELS=${levelEntry.level})`,
    );
    if (levelEntry.gateConsumer) {
      assert(
        registryEntry.consumerGate === levelEntry.gateConsumer,
        `${processFactRegistryPath}: gate drift for command=${levelEntry.name} (registry=${registryEntry.consumerGate || '<missing>'}, PROCESS_FACT_LEVELS=${levelEntry.gateConsumer})`,
      );
    }
  }

  for (const policy of policyEntries) {
    const registryEntry = registryCommandByName.get(policy.name);
    if (!registryEntry) continue;
    assert(
      registryEntry.lifecycle === policy.status,
      `${processFactRegistryPath}: policy drift for command=${policy.name} lifecycle registry=${registryEntry.lifecycle || '<missing>'} policy=${policy.status}`,
    );
    assert(
      registryEntry.destructiveRisk === policy.destructiveRisk,
      `${processFactRegistryPath}: policy drift for command=${policy.name} destructiveRisk registry=${registryEntry.destructiveRisk || '<missing>'} policy=${policy.destructiveRisk || '<missing>'}`,
    );
    assert(
      registryEntry.rootOnly === policy.rootOnly,
      `${processFactRegistryPath}: policy drift for command=${policy.name} rootOnly registry=${registryEntry.rootOnly} policy=${policy.rootOnly}`,
    );
    assert(
      registryEntry.gateEvidence === policy.gateEvidence,
      `${processFactRegistryPath}: policy drift for command=${policy.name} gateEvidence registry=${registryEntry.gateEvidence} policy=${policy.gateEvidence}`,
    );
    assert(
      sameStringArray(registryEntry.allowedPhases, policy.allowedPhases),
      `${processFactRegistryPath}: policy drift for command=${policy.name} allowedPhases registry=[${registryEntry.allowedPhases.join(',')}] policy=[${policy.allowedPhases.join(',')}]`,
    );
  }

  for (const [commandName, expectedSemantics] of Object.entries(requiredProcessFactSemantics)) {
    const entry = registryCommandByName.get(commandName);
    assert(entry, `${processFactRegistryPath}: required process fact missing from PROCESS_FACT_REGISTRY: ${commandName}`);
    if (!entry) continue;
    assert(
      expectedSemantics.every((semantic) => entry.semantics.includes(semantic)),
      `${processFactRegistryPath}: required semantic fact missing for command=${commandName} expected=[${expectedSemantics.join(', ')}] got=[${entry.semantics.join(', ')}]`,
    );
  }

  const l4CommandEntries = registryCommandEntries.filter(entry => entry.level === 'L4');
  for (const entry of l4CommandEntries) {
    const policy = policyByName.get(entry.name);
    assert(policy, `${processFactRegistryPath}: L4 command ${entry.name} must have COMMAND_POLICIES entry`);
    if (!policy) continue;
    assert(
      policy.gateEvidence,
      `${processFactRegistryPath}: L4 gate evidence command=${entry.name} must be gateEvidence in COMMAND_POLICIES`,
    );
    assert(
      entry.semantics.includes('gate-evidence'),
      `${processFactRegistryPath}: L4 gate evidence command=${entry.name} missing gate-evidence semantic`,
    );
  }

  for (const phaseName of ALL_PHASES) {
    for (const pattern of getDefaultPhaseToolEntries(configText, phaseName)) {
      assert(
        patternHasRegistryApprovedCommand(pattern, phaseName, registryCommandEntries),
        `${processFactRegistryPath}: DEFAULT_PHASE_TOOLS phase allowlist drift phase=${phaseName} pattern=${pattern}`,
      );
    }
  }

  for (const lane of requiredReviewerLanes) {
    const entry = registry.get(`reviewer-lane:${lane}`);
    assert(entry, `${processFactRegistryPath}: reviewer lane missing from PROCESS_FACT_REGISTRY: lane=${lane}`);
    if (!entry) continue;
    assert(entry.kind === 'reviewer-lane', `${processFactRegistryPath}: reviewer lane ${lane} must have kind reviewer-lane`);
    assert(entry.reviewerLane === lane, `${processFactRegistryPath}: reviewer lane drift for lane=${lane}`);
    assert(entry.consumerGate, `${processFactRegistryPath}: reviewer lane ${lane} must name consumer gate`);
    assert(entry.artifact, `${processFactRegistryPath}: reviewer lane ${lane} must name produced/consumed artifact`);
  }

  const promptReviewerLanes = listMarkdown('packages/main/templates/agents')
    .map(relPath => basename(relPath, '.md'))
    .filter(name => name.startsWith('koala-review-') || name === 'product-reviewer');
  for (const lane of promptReviewerLanes) {
    assert(
      registry.has(`reviewer-lane:${lane}`),
      `${processFactRegistryPath}: reviewer lane prompt missing registry fact: lane=${lane}`,
    );
  }

  const artifactEntries = registryEntries.filter(entry => entry.name.startsWith('artifact:'));
  for (const entry of registryEntries.filter(item => item.artifact)) {
    const artifactName = `artifact:${entry.artifact.path}`;
    const artifactEntry = registry.get(artifactName);
    assert(
      artifactEntry,
      `${processFactRegistryPath}: command/reviewer artifact ref missing registry artifact: fact=${entry.name} artifact=${artifactName}`,
    );
    if (!artifactEntry?.artifact) continue;
    assert(
      artifactEntry.artifact.path === entry.artifact.path,
      `${processFactRegistryPath}: artifact ref path drift fact=${entry.name} artifact=${artifactName}`,
    );
    assert(
      artifactEntry.artifact.signed === entry.artifact.signed,
      `${processFactRegistryPath}: artifact ref signed drift fact=${entry.name} artifact=${artifactName}`,
    );
  }

  for (const entry of artifactEntries) {
    assert(entry.artifact, `${processFactRegistryPath}: artifact registry entry ${entry.name} must include artifact metadata`);
    if (!entry.artifact) continue;
    assert(entry.semantics.includes('artifact'), `${processFactRegistryPath}: artifact=${entry.name} missing artifact semantic`);
    assert(
      entry.kind === (entry.artifact.signed ? 'signed-artifact' : 'artifact'),
      `${processFactRegistryPath}: artifact kind drift for artifact=${entry.name}`,
    );
    if (entry.artifact.signed) {
      assert(entry.semantics.includes('signed-artifact'), `${processFactRegistryPath}: artifact=${entry.name} missing signed-artifact semantic`);
      assert(
        (entry.artifact.signature || '').trim().length > 0,
        `${processFactRegistryPath}: signed artifact=${entry.name} must declare signature`,
      );
    }
    if (entry.level === 'L4') {
      assert(entry.consumerGate, `${processFactRegistryPath}: artifact=${entry.name} must name consumer gate`);
      assert(entry.semantics.includes('gate-evidence'), `${processFactRegistryPath}: L4 artifact=${entry.name} missing gate-evidence semantic`);
    }
  }

  for (const expected of requiredArtifactFacts) {
    const entry = registry.get(expected.name);
    assert(entry, `${processFactRegistryPath}: artifact missing from PROCESS_FACT_REGISTRY: artifact=${expected.name}`);
    if (!entry) continue;
    assert(
      entry.kind === (expected.signed ? 'signed-artifact' : 'artifact'),
      `${processFactRegistryPath}: artifact kind drift for artifact=${expected.name} expected=${expected.signed ? 'signed-artifact' : 'artifact'} got=${entry.kind}`,
    );
    assert(entry.artifact, `${processFactRegistryPath}: artifact=${expected.name} must include artifact metadata`);
    if (!entry.artifact) continue;
    assert(entry.artifact.path === expected.path, `${processFactRegistryPath}: artifact path drift for artifact=${expected.name} path=${entry.artifact.path}`);
    assert(entry.artifact.signed === expected.signed, `${processFactRegistryPath}: artifact signed drift for artifact=${expected.name}`);
    if (expected.signed) {
      assert(
        expected.signaturePattern.test(entry.artifact.signature || ''),
        `${processFactRegistryPath}: artifact=${expected.name} signature drift (${entry.artifact.signature || '<missing>'})`,
      );
      assert(entry.semantics.includes('signed-artifact'), `${processFactRegistryPath}: artifact=${expected.name} missing signed-artifact semantic`);
    }
    assert(entry.semantics.includes('artifact'), `${processFactRegistryPath}: artifact=${expected.name} missing artifact semantic`);
    assert(entry.consumerGate, `${processFactRegistryPath}: artifact=${expected.name} must name consumer gate`);
  }

  const flowPolicies = parseFlowFactPolicies();
  const flowPolicyNames = flowPolicies.map(entry => entry.name);
  for (const expected of requiredFlowFactPolicies) {
    const sourcePolicy = flowPolicies.find(entry => entry.name === expected.name);
    assert(sourcePolicy, `${flowFactPolicyPath}: required flow fact policy missing: ${expected.name}`);
    if (sourcePolicy) {
      assert(sourcePolicy.policyId === expected.policyId, `${flowFactPolicyPath}: ${expected.name} policyId drifted`);
      assert(sourcePolicy.level === 'L4', `${flowFactPolicyPath}: ${expected.name} must stay L4`);
      assert(sourcePolicy.category === 'flow-policy', `${flowFactPolicyPath}: ${expected.name} must stay category flow-policy`);
      assert(sourcePolicy.owner === 'core/flow-fact-policy', `${flowFactPolicyPath}: ${expected.name} owner drifted`);
      assert(expected.consumerGatePattern.test(sourcePolicy.consumerGate), `${flowFactPolicyPath}: ${expected.name} consumerGate drifted (${sourcePolicy.consumerGate})`);
      assert(sourcePolicy.disposition === expected.disposition, `${flowFactPolicyPath}: ${expected.name} disposition drifted`);
      assert(
        expected.semantics.every(semantic => sourcePolicy.semantics.includes(semantic)),
        `${flowFactPolicyPath}: ${expected.name} missing semantics [${expected.semantics.join(', ')}]`,
      );
    }

    const levelEntry = levelRegistry.get(expected.name);
    assert(levelEntry, `${processFactLevelRegistryPath}: required flow fact policy missing from level registry: ${expected.name}`);
    if (levelEntry) {
      assert(levelEntry.level === 'L4', `${processFactLevelRegistryPath}: ${expected.name} must stay L4`);
      assert(levelEntry.category === 'flow-policy', `${processFactLevelRegistryPath}: ${expected.name} category drifted`);
      assert(levelEntry.owner === 'core/flow-fact-policy', `${processFactLevelRegistryPath}: ${expected.name} owner drifted`);
      assert(expected.consumerGatePattern.test(levelEntry.gateConsumer || ''), `${processFactLevelRegistryPath}: ${expected.name} gateConsumer drifted`);
    }

    const registryEntry = registry.get(expected.name);
    assert(registryEntry, `${processFactRegistryPath}: required flow fact policy missing from PROCESS_FACT_REGISTRY: ${expected.name}`);
    if (!registryEntry) continue;
    assert(registryEntry.kind === 'flow-policy', `${processFactRegistryPath}: ${expected.name} must have kind flow-policy`);
    assert(registryEntry.level === 'L4', `${processFactRegistryPath}: ${expected.name} must stay L4`);
    assert(expected.consumerGatePattern.test(registryEntry.consumerGate || ''), `${processFactRegistryPath}: ${expected.name} consumerGate drifted`);
    assert(
      expected.semantics.every(semantic => registryEntry.semantics.includes(semantic)),
      `${processFactRegistryPath}: ${expected.name} missing required semantics [${expected.semantics.join(', ')}]`,
    );
    if (expected.artifactPath) {
      assert(registryEntry.artifact?.path === expected.artifactPath, `${processFactRegistryPath}: ${expected.name} artifact path drifted`);
    } else {
      assert(!registryEntry.artifact, `${processFactRegistryPath}: ${expected.name} should not claim an artifact`);
    }
  }
  assert(
    duplicateNames(flowPolicyNames).length === 0,
    `${flowFactPolicyPath}: duplicate flow fact policy names`,
  );
}

function assertProcessFactCommandInventory() {
  const cliText = read('packages/main/src/cli-engine.ts');
  const configText = read('packages/main/src/core/config.ts');
  const cliToolNames = extractCliToolNames(cliText);
  const cliToolNameSet = new Set(cliToolNames);
  const levelRegistryEntries = parseProcessFactLevelRegistry();
  const registryEntries = parseProcessFactRegistry();
  const registry = new Map(registryEntries.map(entry => [entry.name, entry]));
  const levelRegistry = new Map(levelRegistryEntries.map(entry => [entry.name, entry]));
  const policyEntries = parseCommandPolicyEntries();
  const policyByName = new Map(policyEntries.map(entry => [entry.name, entry]));
  assertCommandPolicyInventory(cliToolNames);
  assertCommandPolicyPhaseAlignment(policyEntries, configText);
  assertProcessFactRegistryContract(cliToolNames, policyEntries, configText);

  const definitionLevels = new Set(parseProcessFactLevelDefinitions());
  for (const level of ['L0', 'L1', 'L2', 'L3', 'L4']) {
    assert(definitionLevels.has(level), `${processFactLevelRegistryPath}: missing ${level} definition`);
  }

  const duplicateCliNames = duplicateNames(cliToolNames);
  assert(
    duplicateCliNames.length === 0,
    `CLI schema: duplicate MAIN_TOOLS command(s): ${duplicateCliNames.join(', ')}`,
  );

  const duplicateRegistryNames = duplicateNames(levelRegistryEntries.map(entry => entry.name));
  assert(
    duplicateRegistryNames.length === 0,
    `${processFactLevelRegistryPath}: duplicate registry entries: ${duplicateRegistryNames.join(', ')}`,
  );

  const missingCliEntries = cliToolNames.filter(commandName => !registry.has(commandName));
  assert(
    missingCliEntries.length === 0,
    `${processFactLevelRegistryPath}: MAIN_TOOLS command(s) missing from registry: ${missingCliEntries.join(', ')}`,
  );

  const unknownCliEntries = registryEntries
    .filter(entry => !entry.name.startsWith('runtime:'))
    .map(entry => entry.name)
    .filter(name => !name.includes(':'))
    .filter(name => !cliToolNameSet.has(name));
  assert(
    unknownCliEntries.length === 0,
    `${processFactLevelRegistryPath}: CLI registry entry not present in MAIN_TOOLS: ${unknownCliEntries.join(', ')}`,
  );

  const missing = findUninventoriedProcessFactCommands(cliText);
  assert(
    missing.length === 0,
    `CLI schema: process fact command(s) missing from registry: ${missing.join(', ')}`,
  );

  const l0ProcessFactCandidates = cliToolNames
    .filter(isProcessFactCommandName)
    .filter(commandName => registry.get(commandName)?.level === 'L0');
  assert(
    l0ProcessFactCandidates.length === 0,
    `${processFactLevelRegistryPath}: process-fact candidate command(s) cannot be L0: ${l0ProcessFactCandidates.join(', ')}`,
  );

  const l4WithoutGate = levelRegistryEntries
    .filter(entry => entry.level === 'L4')
    .filter(entry => !entry.gateConsumer || entry.gateConsumer.trim().length === 0)
    .map(entry => entry.name);
  assert(
    l4WithoutGate.length === 0,
    `${processFactLevelRegistryPath}: L4 entry must declare gateConsumer: ${l4WithoutGate.join(', ')}`,
  );
  assertL4ProducerOrReplacement(levelRegistryEntries, policyByName, configText);

  const missingRuntimeEntries = requiredRuntimeEntries
    .map(entry => entry.name)
    .filter(name => !registry.has(name));
  assert(
    missingRuntimeEntries.length === 0,
    `${processFactLevelRegistryPath}: runtime behavior entry missing: ${missingRuntimeEntries.join(', ')}`,
  );
  for (const expected of requiredRuntimeEntries) {
    const actual = levelRegistry.get(expected.name);
    if (!actual) continue;
    assert(
      actual.level === expected.level,
      `${processFactLevelRegistryPath}: ${expected.name} level drifted: expected ${expected.level}, got ${actual.level}`,
    );
    assert(
      actual.owner === expected.owner,
      `${processFactLevelRegistryPath}: ${expected.name} owner drifted: expected ${expected.owner}, got ${actual.owner}`,
    );
    assert(
      formatProcessFactLevelRegistryEntry(actual) === expected.line,
      `${processFactLevelRegistryPath}: ${expected.name} summary line drifted`,
    );
  }

  for (const expected of requiredControlledMutationEntries) {
    const actual = levelRegistry.get(expected.name);
    assert(actual, `${processFactLevelRegistryPath}: controlled mutation entry missing: ${expected.name}`);
    if (!actual) continue;
    assert(
      actual.level === expected.level,
      `${processFactLevelRegistryPath}: ${expected.name} must stay ${expected.level}; got ${actual.level}`,
    );
    assert(
      actual.level !== 'L0',
      `${processFactLevelRegistryPath}: ${expected.name} writes or repairs state and must not be L0`,
    );
    assert(
      actual.owner === expected.owner,
      `${processFactLevelRegistryPath}: ${expected.name} owner drifted: expected ${expected.owner}, got ${actual.owner}`,
    );
    assert(
      expected.rationalePattern.test(actual.rationale),
      `${processFactLevelRegistryPath}: ${expected.name} rationale must mention the mutation/repair condition`,
    );
  }

  const findingClusterEntry = levelRegistry.get('finding_cluster');
  const devPhaseToolEntries = extractPhaseToolEntries(configText, 'DEV');
  assert(
    findingClusterEntry?.level === 'L2',
    `${processFactLevelRegistryPath}: finding_cluster must stay L2 metadata maintenance, not gate evidence`,
  );
  assert(
    devPhaseToolEntries.has('finding_add') &&
      devPhaseToolEntries.has('finding_dispatch') &&
      devPhaseToolEntries.has('finding_cluster'),
    'packages/main/src/core/config.ts: DEV phaseTools must keep finding_add/finding_dispatch/finding_cluster available together',
  );
  assert(
    devPhaseToolEntries.size > 0 && !devPhaseToolEntries.has('bug_report'),
    'packages/main/src/core/config.ts: DEV finding_cluster fix must not allow unrelated bug_report',
  );
}

function formatProcessFactLevelRegistryEntry(entry) {
  const gateSuffix = entry.level === 'L4' && entry.gateConsumer ? ` gate=${entry.gateConsumer}` : '';
  return `- ${entry.name} [${entry.level}] owner=${entry.owner}${gateSuffix}`;
}

function formatProcessFactRegistryEntry(entry) {
  const gateSuffix = entry.consumerGate ? ` gate=${entry.consumerGate}` : '';
  const producerSuffix = entry.producer ? ` producer=${entry.producer}` : '';
  const artifactSuffix = entry.artifact?.path ? ` artifact=${entry.artifact.path}${entry.artifact.signed ? ':signed' : ''}` : '';
  return `- ${entry.name} [${entry.level}/${entry.kind}]${producerSuffix}${gateSuffix}${artifactSuffix}`;
}

function printProcessFactLevelRegistrySummary() {
  const entries = parseProcessFactRegistry();
  const cliCount = entries.filter(entry => !entry.name.startsWith('runtime:') && !entry.name.includes(':')).length;
  const runtimeCount = entries.filter(entry => entry.name.startsWith('runtime:')).length;
  const laneCount = entries.filter(entry => entry.kind === 'reviewer-lane').length;
  const artifactCount = entries.filter(entry => entry.kind === 'artifact' || entry.kind === 'signed-artifact').length;
  const levelCounts = new Map();
  for (const level of ['L0', 'L1', 'L2', 'L3', 'L4']) levelCounts.set(level, 0);
  for (const entry of entries) levelCounts.set(entry.level, (levelCounts.get(entry.level) || 0) + 1);
  const kindCounts = new Map();
  for (const entry of entries) kindCounts.set(entry.kind, (kindCounts.get(entry.kind) || 0) + 1);

  console.log('');
  console.log('Process Fact Registry');
  console.log(`- entries: ${entries.length} (${cliCount} CLI, ${runtimeCount} runtime, ${laneCount} reviewer lanes, ${artifactCount} artifacts)`);
  console.log(`- levels: ${[...levelCounts.entries()].map(([level, count]) => `${level}=${count}`).join(', ')}`);
  console.log(`- kinds: ${[...kindCounts.entries()].sort().map(([kind, count]) => `${kind}=${count}`).join(', ')}`);
  const flowPolicyMeta = new Map(parseFlowFactPolicies().map(policy => [policy.name, policy]));
  const flowPolicyEntries = entries.filter(entry => entry.kind === 'flow-policy').sort((a, b) => a.name.localeCompare(b.name));
  if (flowPolicyEntries.length > 0) {
    console.log('- flow fact policies:');
    for (const entry of flowPolicyEntries) {
      const policyId = entry.name.replace(/^flow-policy:/, '');
      const disposition = flowPolicyMeta.get(entry.name)?.disposition;
      const dispositionSuffix = disposition ? ` -> ${disposition}` : '';
      const artifactSuffix = entry.artifact?.path ? ` -> artifact ${entry.artifact.path}` : '';
      const gateSuffix = entry.consumerGate ? ` -> gate ${entry.consumerGate}` : '';
      console.log(`flow fact policy: ${policyId}${dispositionSuffix}${artifactSuffix}${gateSuffix}`);
    }
  }
  console.log('- registry entries:');
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(formatProcessFactRegistryEntry(entry));
  }
}

function assertFilePatterns(entryName, relPath, patterns) {
  const text = read(relPath);
  for (const pattern of patterns) {
    if (typeof pattern === 'string') {
      assert(text.includes(pattern), `${entryName}: ${relPath} missing "${pattern}"`);
      continue;
    }
    if (pattern.any) {
      assert(
        pattern.any.some(needle => text.includes(needle)),
        `${entryName}: ${relPath} missing ${pattern.label || pattern.any.join(' or ')}`,
      );
      continue;
    }
    if (pattern.regex) {
      assert(pattern.regex.test(text), `${entryName}: ${relPath} missing ${pattern.label || pattern.regex}`);
    }
  }
}

const inventory = [
  {
    name: 'phase advance',
    files: [
      {
        relPath: 'packages/main/src/handlers/story-advance.ts',
        patterns: [
          { label: 'storyAdvanceHandler/current createStoryAdvanceHandlers', any: ['storyAdvanceHandler', 'createStoryAdvanceHandlers'] },
          'assertCwdInWorktree',
          'actor.can()',
          'getGuardFailureReason',
          'runReviewCliGates',
          'koala validate --json',
          'writeTestEvidence',
        ],
      },
      {
        relPath: 'packages/main/src/core/machine.ts',
        patterns: ['canStartDev', 'canFinish', 'canEnterInitCheck', 'canPassReview'],
      },
    ],
  },
  {
    name: 'review_run_start',
    files: [
      {
        relPath: 'packages/main/src/handlers/review-run.ts',
        patterns: ['review_run_start', 'resolveReviewRunLane', 'captureReviewRunSnapshot', 'signReviewRun', 'writeReviewRuns', 'Review run'],
      },
      {
        relPath: 'packages/main/src/cli-engine.ts',
        patterns: ['review_run_start', 'promptHash: z.string()', 'lane: z.enum'],
      },
    ],
  },
  {
    name: 'finding_add',
    files: [
      {
        relPath: 'packages/main/src/handlers/finding.ts',
        patterns: [
          'finding_add',
          'reviewRunId',
          'assertCurrentReviewRunForEvidence',
          'isPassOnlyReviewFindingRecord',
          { label: 'recordFinding/current findings persistence', any: ['recordFinding', 'data.findings.push'] },
          'normalizeFindingCategory',
          'signFinding',
          'category must be one of',
        ],
      },
      {
        relPath: 'packages/main/src/cli-engine.ts',
        patterns: ['finding_add', 'category: z.enum', "'cleanup'", "'doc-promise-undelivered'", "'doc-code-drift'", "'spec-boundary'"],
      },
    ],
  },
  {
    name: 'flow fact policy',
    files: [
      {
        relPath: 'packages/main/src/core/flow-fact-policy.ts',
        patterns: [
          'FLOW_FACT_POLICIES',
          'PASS_ONLY_REVIEW_FINDING_POLICY',
          'EXPRESS_VERIFICATION_EXEMPTION_MESSAGE',
          'isPassOnlyReviewFindingRecord',
          'express-exempt',
          'review-round-iso-string',
        ],
      },
      {
        relPath: 'packages/main/src/core/process-fact-registry.ts',
        patterns: ['PROCESS_FACT_FLOW_POLICIES', 'FLOW_FACT_POLICIES', 'flow-policy'],
      },
    ],
  },
  {
    name: 'review_pass_set',
    files: [
      {
        relPath: 'packages/main/src/handlers/finding.ts',
        patterns: ['review_pass_set', 'reviewRunId', 'assertCurrentReviewRunForEvidence', 'signReviewPass', { label: 'persistReviewPass/current durable write-read', any: ['persistReviewPass', 'writeReviewPasses'] }, 'withReviewPassLock', 'Review pass'],
      },
      {
        relPath: 'packages/main/src/cli-engine.ts',
        patterns: ['review_pass_set', 'reviewRunId: z.string()', 'note: z.string()'],
      },
    ],
  },
  {
    name: 'verification evidence',
    files: [
      {
        relPath: 'packages/main/src/handlers/checklist.ts',
        patterns: ['verification_evidence_add', 'verification_evidence_batch_add', 'normalizeEvidence', 'makeEvidence', 'evidenceHashes'],
      },
      {
        relPath: 'packages/main/src/core/verification.ts',
        patterns: ['getBlockingVerificationEvidenceIssues', 'makeEvidence'],
      },
      {
        relPath: 'packages/main/src/core/machine.ts',
        patterns: ['getBlockingVerificationEvidenceIssues', 'checklistAllDone'],
      },
    ],
  },
  {
    name: 'init check',
    files: [
      {
        relPath: 'packages/main/src/handlers/init-check.ts',
        patterns: ['init_check_set', 'signInitCheck', { label: 'validateInitCheck/current recompute gate helpers', any: ['validateInitCheck', 'recomputeInitCheckHash'] }],
      },
      {
        relPath: 'packages/main/src/core/machine.ts',
        patterns: ['canEnterInitCheck', 'missingRequiredInitCheckAgents', 'blockingInitCheckIssues'],
      },
    ],
  },
  {
    name: 'scope check',
    files: [
      {
        relPath: 'packages/main/src/handlers/scope-check.ts',
        patterns: ['scope_check_save', 'signScopeCheck'],
      },
      {
        relPath: 'packages/main/src/handlers/story-review.ts',
        patterns: ['signScopeCheck', 'scope-check.json', 'scope_check_save'],
      },
    ],
  },
  {
    name: 'delivery check',
    files: [
      {
        relPath: 'packages/main/src/handlers/delivery-check.ts',
        patterns: ['delivery_check_set', 'signDeliveryCheck', 'delivery_waiver_add'],
      },
      {
        relPath: 'packages/main/src/core/machine.ts',
        patterns: ['canFinish', 'delivery_waiver_add', 'delivery-check.json'],
      },
    ],
  },
  {
    name: 'REVIEW/TEST/DONE gates',
    files: [
      {
        relPath: 'packages/main/src/handlers/story-advance.ts',
        patterns: ['runReviewCliGates', 'koala validate --json', 'buildDoneChecklist', 'writeTestEvidence'],
      },
      {
        relPath: 'packages/main/src/handlers/review-preflight.ts',
        patterns: ['runReviewCliGates', 'checkCommitAuthor', 'checkConcept', 'checkLint'],
      },
      {
        relPath: 'packages/main/src/core/machine.ts',
        patterns: ['canPassReview', 'canFinish', 'getGuardFailureReason'],
      },
    ],
  },
  {
    name: 'CLI schema',
    files: [
      {
        relPath: 'packages/main/src/cli-engine.ts',
        patterns: ['MAIN_TOOLS', 'review_run_start', 'finding_add', 'review_pass_set', 'verification_evidence_add', 'init_check_set', 'scope_check_save', 'delivery_check_set'],
      },
      {
        relPath: 'packages/main/src/core/config.ts',
        patterns: ['DEFAULT_PHASE_TOOLS', 'isCommandAllowed', 'review_run_start', 'finding_add', 'review_pass_set', 'delivery_check_set'],
      },
    ],
  },
];

console.log('Process Fact Contract');
console.log('Prompt guides; CLI/handler/gate decides');
console.log('');
console.log('Scope: process facts only — phase/state transitions, pass/no-issue confirmations, findings/categories/roles, and evidence/check artifacts.');
console.log('Out of scope: ordinary explanatory prose, narrative rationale, and benign Claude/Codex wording differences that do not alter commands or artifact paths.');
console.log('');

const promptMap = new Map();
let reviewerPromptCount = 0;
for (const dir of promptDirs) {
  for (const relPath of listMarkdown(dir)) {
    const text = read(relPath);
    promptMap.set(relPath, text);
    for (const issue of scanReviewRoundPromptSchema(text, relPath)) fail(issue);
    if (!isReviewerPrompt(relPath, text)) continue;
    reviewerPromptCount += 1;
    for (const issue of scanPromptText(text, relPath)) fail(issue);
  }
}
for (const dir of promptDirs) {
  for (const fileName of requiredReviewerRunIdPromptFiles) {
    assert(
      promptMap.has(`${dir}/${fileName}`),
      `${dir}/${fileName}: reviewer-facing prompt must be included in prompt drift scan`,
    );
  }
}
comparePromptSemantics(promptMap);
assertSyntheticAdversarialChecks();
for (const relPath of [
  'packages/main/src/cli-engine.ts',
  commandPolicyPath,
  processFactLevelRegistryPath,
  processFactRegistryPath,
  flowFactPolicyPath,
]) {
  for (const issue of scanCliMachineFactNames(read(relPath), relPath)) fail(issue);
}
for (const issue of scanCodeLikeStringArrayConst(
  read('packages/main/src/core/background-validator.ts'),
  'packages/main/src/core/background-validator.ts',
  'BACKGROUND_SECTION_IDS',
)) fail(issue);
assertActiveLifecycleDocGuidance();
assertReviewRoundIsoDocs();
assertEvidenceBoundaryDocs();
assertPromptEvidenceBoundaries(promptMap);
assertProcessFactCommandInventory();
printProcessFactLevelRegistrySummary();

console.log(`Prompt drift scan: ${reviewerPromptCount} reviewer prompt files checked`);
if (warnings.length) {
  console.log('Warnings:');
  for (const message of warnings.sort()) console.log(`- ${message}`);
}
console.log('');
console.log('Process Fact Inventory');
for (const entry of inventory) {
  console.log(`- ${entry.name}`);
  for (const file of entry.files) {
    assertFilePatterns(entry.name, file.relPath, file.patterns);
    console.log(`  ${file.relPath}`);
  }
}

if (failures.length) {
  console.error('');
  console.error('Process fact contract failed:');
  for (const message of failures.sort()) console.error(`- ${message}`);
  process.exit(1);
}

console.log('');
console.log('Process fact contract verified');
