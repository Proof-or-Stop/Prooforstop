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
const processFactLevelRegistryPath = 'packages/main/src/core/process-fact-levels.ts';
const commandPolicyPath = 'packages/main/src/core/command-policy.ts';
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
const commandPolicyStatuses = new Set(['supported', 'rootOnly', 'legacy', 'retired', 'maintenance', 'gateEvidence']);
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
    name: 'runtime:phase_tools_malformed_allow_all',
    level: 'L1',
    owner: 'core/config',
    line: '- runtime:phase_tools_malformed_allow_all [L1] owner=core/config',
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

function scanPromptText(text, label) {
  const issues = [];
  const findingBlocks = commandBlocks(text, 'finding_add');
  for (const { block, lineNo } of findingBlocks) {
    if (passOnlyFindingAddPatterns.some(pattern => pattern.test(block))) {
      issues.push(`${label}:${lineNo} pass-only finding_add must use review_pass_set`);
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
        const commandOrPathDrift = changed.some(token => token.startsWith('cmd:') || token.startsWith('path:'));
        const message = `${mirrorRel} command/path semantics drifted from template ${templateRel}; missing=[${missing.join(', ')}] extra=[${extra.join(', ')}]`;
        if (commandOrPathDrift) fail(message);
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
    'koala finding_add \'{"storyId":"B-x","desc":"real issue","severity":"medium","category":"missing","agent":"koala-review-quality"}\'',
    'koala review_pass_set \'{"storyId":"B-x","agent":"koala-review-quality","note":"quality review passed: checked changed files and found no blocker."}\'',
  ].join('\n');
  assert(scanPromptText(goodPrompt, 'synthetic-good').length === 0, 'synthetic good prompt should pass');

  const syntheticCli = "  { name: 'surprise_check_set', description: '保存新的流程确认', schema: {} },";
  assert(
    findUninventoriedProcessFactCommands(syntheticCli).includes('surprise_check_set'),
    'synthetic new process fact handler should fail until inventoried',
  );
}

function extractExportedArrayBody(text, exportName) {
  const marker = `export const ${exportName} = [`;
  const start = text.indexOf(marker);
  assert(start !== -1, `${processFactLevelRegistryPath} should export ${exportName}`);
  if (start === -1) return '';

  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;
  const arrayStart = start + marker.length - 1;

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
  const marker = `export const ${exportName} = {`;
  const start = text.indexOf(marker);
  assert(start !== -1, `${relPath} should export ${exportName}`);
  if (start === -1) return '';
  const objectStart = start + marker.length - 1;
  return extractBalancedBlock(text, objectStart, '{', '}', `${relPath} ${exportName}`);
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

function parseCommandPolicyEntries() {
  if (cachedCommandPolicyEntries) return cachedCommandPolicyEntries;

  const text = read(commandPolicyPath);
  const body = extractExportedObjectBody(text, 'COMMAND_POLICIES', commandPolicyPath);
  const entries = [];
  const keyPattern = /^\s*([a-z_][a-z0-9_]*):\s*\{/gm;
  for (const match of body.matchAll(keyPattern)) {
    const name = match[1];
    const openIndex = match.index + match[0].lastIndexOf('{');
    const block = extractBalancedBlock(body, openIndex, '{', '}', `${commandPolicyPath} ${name}`);
    const status = block.match(/\bstatus:\s*'([^']+)'/)?.[1] || '';
    const reason = block.match(/\breason:\s*'([^']*)'/)?.[1] || '';
    const replacement = block.match(/\breplacement:\s*'([^']*)'/)?.[1] || '';
    const destructiveRisk = block.match(/\bdestructiveRisk:\s*'([^']+)'/)?.[1] || '';
    entries.push({
      name,
      block,
      status,
      reason,
      replacement,
      destructiveRisk,
      hasAllowedPhases: /\ballowedPhases:\s*(?:'all'|\[)/.test(block),
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

function processFactRegistryMap() {
  return new Map(parseProcessFactLevelRegistry().map(entry => [entry.name, entry]));
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

function extractPhaseToolEntries(configText, phaseName) {
  const text = stripTsComments(configText);
  const match = new RegExp(`\\b${phaseName}:\\s*\\[`).exec(text);
  if (!match) return new Set();

  let depth = 1;
  let quote = null;
  let escaped = false;
  let block = '';
  for (let index = match.index + match[0].length; index < text.length; index += 1) {
    const char = text[index];

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

function assertProcessFactCommandInventory() {
  const cliText = read('packages/main/src/cli-engine.ts');
  const configText = read('packages/main/src/core/config.ts');
  const cliToolNames = extractCliToolNames(cliText);
  const cliToolNameSet = new Set(cliToolNames);
  const registryEntries = parseProcessFactLevelRegistry();
  const registry = new Map(registryEntries.map(entry => [entry.name, entry]));
  assertCommandPolicyInventory(cliToolNames);

  const definitionLevels = new Set(parseProcessFactLevelDefinitions());
  for (const level of ['L0', 'L1', 'L2', 'L3', 'L4']) {
    assert(definitionLevels.has(level), `${processFactLevelRegistryPath}: missing ${level} definition`);
  }

  const duplicateCliNames = duplicateNames(cliToolNames);
  assert(
    duplicateCliNames.length === 0,
    `CLI schema: duplicate MAIN_TOOLS command(s): ${duplicateCliNames.join(', ')}`,
  );

  const duplicateRegistryNames = duplicateNames(registryEntries.map(entry => entry.name));
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

  const l4WithoutGate = registryEntries
    .filter(entry => entry.level === 'L4')
    .filter(entry => !entry.gateConsumer || entry.gateConsumer.trim().length === 0)
    .map(entry => entry.name);
  assert(
    l4WithoutGate.length === 0,
    `${processFactLevelRegistryPath}: L4 entry must declare gateConsumer: ${l4WithoutGate.join(', ')}`,
  );

  const missingRuntimeEntries = requiredRuntimeEntries
    .map(entry => entry.name)
    .filter(name => !registry.has(name));
  assert(
    missingRuntimeEntries.length === 0,
    `${processFactLevelRegistryPath}: runtime behavior entry missing: ${missingRuntimeEntries.join(', ')}`,
  );
  for (const expected of requiredRuntimeEntries) {
    const actual = registry.get(expected.name);
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
    const actual = registry.get(expected.name);
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

  const findingClusterEntry = registry.get('finding_cluster');
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

function printProcessFactLevelRegistrySummary() {
  const entries = parseProcessFactLevelRegistry();
  const cliCount = entries.filter(entry => !entry.name.startsWith('runtime:')).length;
  const runtimeCount = entries.length - cliCount;
  const levelCounts = new Map();
  for (const level of ['L0', 'L1', 'L2', 'L3', 'L4']) levelCounts.set(level, 0);
  for (const entry of entries) levelCounts.set(entry.level, (levelCounts.get(entry.level) || 0) + 1);

  console.log('');
  console.log('Process Fact Level Registry');
  console.log(`- entries: ${entries.length} (${cliCount} CLI, ${runtimeCount} runtime)`);
  console.log(`- levels: ${[...levelCounts.entries()].map(([level, count]) => `${level}=${count}`).join(', ')}`);
  console.log('- registry entries:');
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(formatProcessFactLevelRegistryEntry(entry));
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
assertActiveLifecycleDocGuidance();
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
