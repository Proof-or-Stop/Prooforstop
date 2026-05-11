#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

const root = process.cwd();
const failures = [];
const warnings = [];

const promptDirs = [
  'packages/main/templates/agents',
  '.claude/agents',
  '.Codex/agents',
];

const currentCategories = new Set(['happy', 'edge', 'adversarial', 'missing']);
const legacyCategories = new Set(['cleanup', 'doc-promise-undelivered', 'doc-code-drift', 'spec-boundary']);
const reviewPassReviewerPrompts = new Set([
  'koala-review-behavior.md',
  'koala-review-channel.md',
  'koala-review-concept.md',
  'koala-review-docs.md',
  'koala-review-quality.md',
  'koala-review-test-coverage.md',
]);
const processFactCliInventory = new Set([
  'story_advance',
  'review_pass_set',
  'finding_add',
  'finding_list',
  'finding_resolve',
  'finding_dismiss',
  'finding_cluster',
  'verification_evidence_add',
  'verification_evidence_batch_add',
  'verification_evidence_refresh_stale',
  'init_check_set',
  'scope_check_save',
  'scope_question_resolve',
  'delivery_check_set',
  'delivery_waiver_add',
  'draft_check_set',
]);
const processFactCommandNamePatterns = [
  /^story_advance$/,
  /^review_pass_set$/,
  /^finding_/,
  /^verification_evidence_/,
  /_check_set$/,
  /^init_check_set$/,
  /^scope_/,
  /^delivery_/,
  /^draft_check_set$/,
];

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
  return name.startsWith('koala-review-') || text.includes('review_pass_set');
}

function commandLines(text, command) {
  return text
    .split(/\r?\n/)
    .map((line, index) => ({ line, lineNo: index + 1 }))
    .filter(({ line }) => new RegExp(`\\bkoala\\s+${command}\\b`).test(line));
}

function requiresReviewPassProtocol(label) {
  return reviewPassReviewerPrompts.has(basename(label)) || label.startsWith('synthetic-');
}

function scanPromptText(text, label) {
  const issues = [];
  const findingLines = commandLines(text, 'finding_add');
  for (const { line, lineNo } of findingLines) {
    if (passOnlyFindingAddPatterns.some(pattern => pattern.test(line))) {
      issues.push(`${label}:${lineNo} pass-only finding_add must use review_pass_set`);
    }
    for (const match of line.matchAll(/"category"\s*:\s*"([^"]+)"/g)) {
      const category = match[1];
      if (currentCategories.has(category)) continue;
      if (legacyCategories.has(category)) {
        issues.push(`${label}:${lineNo} active finding_add example uses legacy category "${category}"; use "missing" and keep legacy names only in compatibility text`);
      } else {
        issues.push(`${label}:${lineNo} active finding_add example uses unknown category "${category}"`);
      }
    }
  }

  const hasFindingProtocol = text.includes('finding_add');
  const claimsNoFindings = /\bno\s+(?:blocking\s+)?findings?\b|\bno\s+blockers?\b|没有\s*findings?|没有\s*finding|无\s*blocker|无\s+blocking|无\s+finding|审查通过|review\s+passed/i.test(text);
  if (requiresReviewPassProtocol(label) && hasFindingProtocol && claimsNoFindings && !text.includes('review_pass_set')) {
    issues.push(`${label}: reviewer prompt claims no findings or completion but never uses review_pass_set`);
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
  for (const name of ['finding_add', 'review_pass_set', 'init_check_set', 'scope_check_save', 'delivery_check_set', 'verification_evidence_add', 'verification_evidence_batch_add']) {
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
        const commandDrift = changed.some(token => token.startsWith('cmd:'));
        const message = `${mirrorRel} command/path semantics drifted from template ${templateRel}; missing=[${missing.join(', ')}] extra=[${extra.join(', ')}]`;
        if (commandDrift) fail(message);
        else warn(message);
      }
    }
  }
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

  const unknownCategory = 'koala finding_add \'{"storyId":"B-x","desc":"docs","severity":"medium","category":"docs","agent":"koala-review-quality"}\'';
  assert(
    scanPromptText(unknownCategory, 'synthetic-unknown-category').some(issue => issue.includes('unknown category')),
    'synthetic unknown category should fail',
  );

  const goodPrompt = [
    'koala finding_add \'{"storyId":"B-x","desc":"real issue","severity":"medium","category":"missing","agent":"koala-review-quality"}\'',
    'koala review_pass_set \'{"storyId":"B-x","agent":"koala-review-quality","note":"quality review passed: checked changed files and found no blocker."}\'',
  ].join('\n');
  assert(scanPromptText(goodPrompt, 'synthetic-good').length === 0, 'synthetic good prompt should pass');

  const syntheticCli = "  { name: 'surprise_check_set', description: '保存新的流程确认', schema: {} },";
  assert(
    findUninventoriedProcessFactCommands(syntheticCli, new Set()).includes('surprise_check_set'),
    'synthetic new process fact handler should fail until inventoried',
  );
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

function findUninventoriedProcessFactCommands(cliText, inventory = processFactCliInventory) {
  return extractCliToolNames(cliText)
    .filter(isProcessFactCommandName)
    .filter(commandName => !inventory.has(commandName));
}

function assertProcessFactCommandInventory() {
  const cliText = read('packages/main/src/cli-engine.ts');
  const missing = findUninventoriedProcessFactCommands(cliText);
  assert(
    missing.length === 0,
    `CLI schema: process fact command(s) missing from inventory: ${missing.join(', ')}`,
  );
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
    name: 'finding_add',
    files: [
      {
        relPath: 'packages/main/src/handlers/finding.ts',
        patterns: [
          'finding_add',
          'isPassOnlyReviewRecord',
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
    name: 'review_pass_set',
    files: [
      {
        relPath: 'packages/main/src/handlers/finding.ts',
        patterns: ['review_pass_set', 'signReviewPass', { label: 'persistReviewPass/current durable write-read', any: ['persistReviewPass', 'writeReviewPasses'] }, 'withReviewPassLock', 'Review pass'],
      },
      {
        relPath: 'packages/main/src/cli-engine.ts',
        patterns: ['review_pass_set', 'note: z.string()'],
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
        patterns: ['MAIN_TOOLS', 'finding_add', 'review_pass_set', 'verification_evidence_add', 'init_check_set', 'scope_check_save', 'delivery_check_set'],
      },
      {
        relPath: 'packages/main/src/core/config.ts',
        patterns: ['DEFAULT_PHASE_TOOLS', 'isCommandAllowed', 'finding_add', 'review_pass_set', 'delivery_check_set'],
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
    if (!isReviewerPrompt(relPath, text)) continue;
    reviewerPromptCount += 1;
    for (const issue of scanPromptText(text, relPath)) fail(issue);
  }
}
comparePromptSemantics(promptMap);
assertSyntheticAdversarialChecks();
assertProcessFactCommandInventory();

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
